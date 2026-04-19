/**
 * 3D room view — a read-only companion to the 2D heatmap.
 *
 * Renders a W × D × H m room with the user-placed windows and skylights
 * cut out of the walls / ceiling, the floor textured with the current
 * simulation grid, and a directional light whose position follows the sun.
 *
 * The simulation is NOT re-run here — this component is a pure view over
 * `grid`, `windows`, `sunPos`, and `dims` from useSimulation.
 *
 * Coordinate system matches the sim:
 *   X: east  (0 .. W)
 *   Y: up    (0 .. H)
 *   Z: north (0 .. D)
 */

import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import {
  GRID_SIZE,
  DEFAULT_ROOM_W, DEFAULT_ROOM_D, DEFAULT_ROOM_H,
} from '../simulation/constants';
import { intensityToRGB } from '../simulation/lightSim';
import { getDayTimeSamples, getSunPosition } from '../simulation/solar';

const kindOf = (w) => w.kind || 'wall';

function sunVectorForView({ altitude, azimuth }, bearingDeg = 0) {
  // World-frame sun direction FROM the ground up TOWARD the sun.
  // The 3D view mirrors the east-west axis so it lines up with the floor
  // texture and wall geometry; north-south is left untouched.
  const wx =  Math.sin(azimuth) * Math.cos(altitude);
  const wz = -Math.cos(azimuth) * Math.cos(altitude);
  const dy =  Math.sin(altitude);
  // Rotate into ROOM-local frame so the visible sun lines up with the
  // simulation's notion of which wall it's shining through.  Inverse sign on
  // the E-W axis means we rotate the mirrored x, then re-mirror on output.
  const bRad = bearingDeg * Math.PI / 180;
  const cosB = Math.cos(bRad);
  const sinB = Math.sin(bRad);
  // Un-mirror x, rotate, re-mirror.
  const dxUnmirrored = -wx;
  const dx = -(dxUnmirrored * cosB - wz * sinB);
  const dz =   dxUnmirrored * sinB + wz * cosB;
  return { dx, dy, dz };
}

// ─── Wall-with-holes geometry ────────────────────────────────────────────────
// width × height rectangle in local 2D, with axis-aligned rectangular holes.
function buildShapeGeom(width, height, holes) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(width, 0);
  shape.lineTo(width, height);
  shape.lineTo(0, height);
  shape.closePath();
  for (const h of holes) {
    if (h.w <= 0 || h.h <= 0) continue;
    const hole = new THREE.Path();
    hole.moveTo(h.x,         h.y);
    hole.lineTo(h.x + h.w,   h.y);
    hole.lineTo(h.x + h.w,   h.y + h.h);
    hole.lineTo(h.x,         h.y + h.h);
    hole.closePath();
    shape.holes.push(hole);
  }
  return new THREE.ShapeGeometry(shape);
}

// ─── Floor heatmap texture ───────────────────────────────────────────────────
function FloorHeatmap({ grid, dims }) {
  const { W, D } = dims;
  // Allocate the texture once; update its pixel data when grid changes.
  const texture = useMemo(() => {
    const data = new Uint8Array(GRID_SIZE * GRID_SIZE * 4);
    const tex = new THREE.DataTexture(data, GRID_SIZE, GRID_SIZE, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }, []);

  useEffect(() => {
    if (!grid) return;
    const data = texture.image.data;
    for (let i = 0; i < GRID_SIZE; i++) {
      for (let j = 0; j < GRID_SIZE; j++) {
        const val = grid[i * GRID_SIZE + j];
        const [r, g, b] = intensityToRGB(val);
        // Flip N-S: sim j=0 (south, Z=0) maps to the LAST texture row
        // because the plane's UV v=0 ends up at world +Z after rotation.
        const row = GRID_SIZE - 1 - j;
        // Flip E-W: mirror the east-west axis on the 3D floor heatmap.
        const col = GRID_SIZE - 1 - i;
        const idx = (row * GRID_SIZE + col) * 4;
        data[idx]     = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }
    texture.needsUpdate = true;
  }, [grid, texture]);

  return (
    <mesh
      position={[W / 2, 0.002, D / 2]}
      rotation={[-Math.PI / 2, 0, 0]}
    >
      <planeGeometry args={[W, D]} />
      {/* meshBasicMaterial + toneMapped=false so the heatmap colours come
          through unchanged, not re-lit by the sun. */}
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}

// ─── Walls & ceiling with holes ──────────────────────────────────────────────
// Given the camera position, which geometric surfaces are between the camera
// and the room interior?  Returns { S, N, xMax, xZero, ceiling } booleans,
// each TRUE if the corresponding wall/ceiling should be HIDDEN (camera is on
// its outside side).  `xMax` is the geometric mesh at X=W and `xZero` is the
// mesh at X=0.
function wallsToHide(cam, cutaway, dims) {
  if (!cutaway) return { S: false, N: false, xMax: false, xZero: false, ceiling: false };
  const { W, D, H } = dims;
  return {
    S:       cam.z < 0,       // south wall at z=0, outside = z<0
    N:       cam.z > D,       // north wall at z=D, outside = z>D
    xMax:    cam.x > W,       // wall at x=W, outside = x>W
    xZero:   cam.x < 0,       // wall at x=0, outside = x<0
    ceiling: cam.y > H,       // ceiling at y=H, outside = y>H
  };
}

function Room({ windows, cutaway, dims }) {
  const { W, D, H } = dims;
  const wallWindows = windows.filter(w => kindOf(w) === 'wall');
  const skylights   = windows.filter(w => kindOf(w) === 'skylight');
  const southRef   = useRef();
  const northRef   = useRef();
  const xMaxRef    = useRef();
  const xZeroRef   = useRef();
  const ceilingRef = useRef();

  useFrame(({ camera }) => {
    const hide = wallsToHide(camera.position, cutaway, dims);
    if (southRef.current)   southRef.current.visible   = !hide.S;
    if (northRef.current)   northRef.current.visible   = !hide.N;
    if (xMaxRef.current)    xMaxRef.current.visible    = !hide.xMax;
    if (xZeroRef.current)   xZeroRef.current.visible   = !hide.xZero;
    if (ceilingRef.current) ceilingRef.current.visible = !hide.ceiling;
  });

  const southGeo = useMemo(
    () => buildShapeGeom(W, H,
      wallWindows.filter(w => w.wall === 'S').map(w => ({
        x: w.min, y: w.yMin,
        w: w.max - w.min, h: w.yMax - w.yMin,
      }))),
    [wallWindows, W, H]
  );
  const northGeo = useMemo(
    () => buildShapeGeom(W, H,
      wallWindows.filter(w => w.wall === 'N').map(w => ({
        x: w.min, y: w.yMin,
        w: w.max - w.min, h: w.yMax - w.yMin,
      }))),
    [wallWindows, W, H]
  );
  // East + West walls: local u = Z, local v = Y.
  // E-W flip: windows tagged 'E' in the sim are rendered on the geometric
  // X=0 wall and 'W' windows on the X=W wall, so they land on the
  // visually-correct side of the mirrored 3D view.
  const eastGeo = useMemo(
    () => buildShapeGeom(D, H,
      wallWindows.filter(w => w.wall === 'W').map(w => ({
        x: w.min, y: w.yMin,
        w: w.max - w.min, h: w.yMax - w.yMin,
      }))),
    [wallWindows, D, H]
  );
  const westGeo = useMemo(
    () => buildShapeGeom(D, H,
      wallWindows.filter(w => w.wall === 'E').map(w => ({
        x: w.min, y: w.yMin,
        w: w.max - w.min, h: w.yMax - w.yMin,
      }))),
    [wallWindows, D, H]
  );
  // Ceiling: local u = X, local v = Z.
  // E-W flip: mirror the skylight's X coordinate so it lines up with the
  // flipped sun and floor heatmap.  N-S (z) is untouched.
  const ceilingGeo = useMemo(
    () => buildShapeGeom(W, D,
      skylights.map(s => ({
        x: W - s.xMax, y: s.zMin,
        w: s.xMax - s.xMin, h: s.zMax - s.zMin,
      }))),
    [skylights, W, D]
  );

  const wallColor    = '#a9aabf';
  const ceilingColor = '#c0c1d8';
  const wallMat = (
    <meshStandardMaterial
      color={wallColor}
      roughness={0.9}
      metalness={0.0}
      side={THREE.DoubleSide}
    />
  );

  return (
    <group>
      {/* South wall (Z = 0) — shape in XY plane already faces +Z */}
      <mesh ref={southRef} geometry={southGeo} position={[0, 0, 0]}>
        {wallMat}
      </mesh>
      {/* North wall (Z = D) */}
      <mesh ref={northRef} geometry={northGeo} position={[0, 0, D]}>
        {wallMat}
      </mesh>
      {/* Mesh at X = W (rendered with sim-W wall data) */}
      <mesh
        ref={xMaxRef}
        geometry={eastGeo}
        rotation={[0, -Math.PI / 2, 0]}
        position={[W, 0, 0]}
      >
        {wallMat}
      </mesh>
      {/* Mesh at X = 0 (rendered with sim-E wall data) */}
      <mesh
        ref={xZeroRef}
        geometry={westGeo}
        rotation={[0, -Math.PI / 2, 0]}
        position={[0, 0, 0]}
      >
        {wallMat}
      </mesh>
      {/* Ceiling (Y = H) */}
      <mesh
        ref={ceilingRef}
        geometry={ceilingGeo}
        rotation={[Math.PI / 2, 0, 0]}
        position={[0, H, 0]}
      >
        <meshStandardMaterial
          color={ceilingColor}
          roughness={0.95}
          metalness={0.0}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

// ─── Translucent glass panes filling each window / skylight hole ─────────────
function WindowPanes({ windows, dims }) {
  const { W, D, H } = dims;
  // Simple translucent tinted glass — no envMap needed, renders consistently.
  const paneMat = (
    <meshStandardMaterial
      color="#a3d8ff"
      transparent
      opacity={0.25}
      roughness={0.1}
      metalness={0.0}
      emissive="#203048"
      emissiveIntensity={0.3}
      side={THREE.DoubleSide}
      depthWrite={false}
    />
  );

  return (
    <>
      {windows.map(w => {
        if (kindOf(w) === 'skylight') {
          // E-W flip: mirror the pane's X around the room's centre.
          const cx = W - (w.xMin + w.xMax) / 2;
          const cz = (w.zMin + w.zMax) / 2;
          const sx = w.xMax - w.xMin;
          const sz = w.zMax - w.zMin;
          return (
            <mesh
              key={w.id}
              position={[cx, H - 0.005, cz]}
              rotation={[-Math.PI / 2, 0, 0]}
            >
              <planeGeometry args={[sx, sz]} />
              {paneMat}
            </mesh>
          );
        }
        // wall window
        const centerAlong = (w.min + w.max) / 2;
        const centerY     = (w.yMin + w.yMax) / 2;
        const widthAlong  = w.max - w.min;
        const heightY     = w.yMax - w.yMin;
        let position, rotation;
        if (w.wall === 'S') {
          position = [centerAlong, centerY, 0.005];
          rotation = [0, 0, 0];
        } else if (w.wall === 'N') {
          position = [centerAlong, centerY, D - 0.005];
          rotation = [0, 0, 0];
        } else if (w.wall === 'E') {
          // E-W flip: render E-wall panes on the X=0 side.
          position = [0.005, centerY, centerAlong];
          rotation = [0, -Math.PI / 2, 0];
        } else {
          // E-W flip: render W-wall panes on the X=W side.
          position = [W - 0.005, centerY, centerAlong];
          rotation = [0, -Math.PI / 2, 0];
        }
        return (
          <mesh key={w.id} position={position} rotation={rotation}>
            <planeGeometry args={[widthAlong, heightY]} />
            {paneMat}
          </mesh>
        );
      })}
    </>
  );
}

// ─── Wall / ceiling light overlays ───────────────────────────────────────────
// Additive-blended emissive overlays that brighten each surface where light
// lands.  Zero values add nothing (keeping the plain wall visible), high values
// glow warm-white.  Window cells are masked to zero so the overlay never glows
// through an opening onto the glass pane or the sky beyond.

// Simple black → warm-white ramp, suited to additive blending.
function intensityToAdditiveRGB(t) {
  const x = Math.pow(Math.max(0, Math.min(1, t)), 0.7);
  return [
    Math.round(255 * x),
    Math.round(230 * x),
    Math.round(160 * x),
  ];
}

// Per-wall mask: is the (iu, iv) grid cell occluded by a window opening?
function wallAxes(dims) {
  return {
    S: { usize: dims.W, vsize: dims.H },
    N: { usize: dims.W, vsize: dims.H },
    E: { usize: dims.D, vsize: dims.H },
    W: { usize: dims.D, vsize: dims.H },
    ceiling: { usize: dims.W, vsize: dims.D },
  };
}

function isCellInWindow(wallName, iu, iv, windows, dims) {
  const { usize, vsize } = wallAxes(dims)[wallName];
  const u = (iu + 0.5) / GRID_SIZE * usize;
  const v = (iv + 0.5) / GRID_SIZE * vsize;
  for (const w of windows) {
    const kind = w.kind || 'wall';
    if (wallName === 'ceiling') {
      if (kind !== 'skylight') continue;
      if (u >= w.xMin && u <= w.xMax && v >= w.zMin && v <= w.zMax) return true;
    } else {
      if (kind === 'skylight') continue;
      if (w.wall !== wallName) continue;
      if (u >= w.min && u <= w.max && v >= w.yMin && v <= w.yMax) return true;
    }
  }
  return false;
}

// Single overlay mesh: a plane sized to the surface, showing its heatmap
// as an additive emissive texture.  `flipU` mirrors the u-axis when the
// surface's 3D geometry is E-W flipped (ceiling, per existing convention).
function WallOverlay({
  wallName, grid, windows, dims,
  planeW, planeH, position, rotation,
  flipU = false, meshRef,
}) {
  const texture = useMemo(() => {
    const data = new Uint8Array(GRID_SIZE * GRID_SIZE * 4);
    const tex = new THREE.DataTexture(data, GRID_SIZE, GRID_SIZE, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }, []);

  useEffect(() => {
    if (!grid) return;
    const data = texture.image.data;
    for (let iu = 0; iu < GRID_SIZE; iu++) {
      for (let iv = 0; iv < GRID_SIZE; iv++) {
        const masked = isCellInWindow(wallName, iu, iv, windows, dims);
        const val = masked ? 0 : grid[iu * GRID_SIZE + iv];
        const [r, g, b] = intensityToAdditiveRGB(val);
        const col = flipU ? (GRID_SIZE - 1 - iu) : iu;
        const row = iv;
        const idx = (row * GRID_SIZE + col) * 4;
        data[idx]     = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }
    texture.needsUpdate = true;
  }, [grid, windows, wallName, flipU, texture, dims]);

  return (
    <mesh ref={meshRef} position={position} rotation={rotation}>
      <planeGeometry args={[planeW, planeH]} />
      <meshBasicMaterial
        map={texture}
        transparent
        blending={THREE.AdditiveBlending}
        depthWrite={false}
        toneMapped={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function WallOverlays({ wallGrids, windows, cutaway, dims }) {
  const { W, D, H } = dims;
  const sRef     = useRef();
  const nRef     = useRef();
  const xMaxRef  = useRef();
  const xZeroRef = useRef();
  const cRef     = useRef();

  useFrame(({ camera }) => {
    const hide = wallsToHide(camera.position, cutaway, dims);
    if (sRef.current)     sRef.current.visible     = !hide.S;
    if (nRef.current)     nRef.current.visible     = !hide.N;
    if (xMaxRef.current)  xMaxRef.current.visible  = !hide.xMax;
    if (xZeroRef.current) xZeroRef.current.visible = !hide.xZero;
    if (cRef.current)     cRef.current.visible     = !hide.ceiling;
  });

  if (!wallGrids) return null;
  const INSET = 0.004;   // slightly inside the room so we don't z-fight the wall
  return (
    <>
      {/* South wall (z=0), normal +Z — no E-W flip (matches wall cutouts) */}
      <WallOverlay
        wallName="S"
        grid={wallGrids.S}
        windows={windows} dims={dims}
        planeW={W} planeH={H}
        position={[W / 2, H / 2, INSET]}
        rotation={[0, 0, 0]}
        meshRef={sRef}
      />
      {/* North wall (z=D) */}
      <WallOverlay
        wallName="N"
        grid={wallGrids.N}
        windows={windows} dims={dims}
        planeW={W} planeH={H}
        position={[W / 2, H / 2, D - INSET]}
        rotation={[0, 0, 0]}
        meshRef={nRef}
      />
      {/* 3D mesh at X=W shows sim-W wall data (per existing E-W swap) */}
      <WallOverlay
        wallName="W"
        grid={wallGrids.W}
        windows={windows} dims={dims}
        planeW={D} planeH={H}
        position={[W - INSET, H / 2, D / 2]}
        rotation={[0, -Math.PI / 2, 0]}
        meshRef={xMaxRef}
      />
      {/* 3D mesh at X=0 shows sim-E wall data */}
      <WallOverlay
        wallName="E"
        grid={wallGrids.E}
        windows={windows} dims={dims}
        planeW={D} planeH={H}
        position={[INSET, H / 2, D / 2]}
        rotation={[0, -Math.PI / 2, 0]}
        meshRef={xZeroRef}
      />
      {/* Ceiling (y=H) — E-W flip to match existing ceiling geometry */}
      <WallOverlay
        wallName="ceiling"
        grid={wallGrids.ceiling}
        windows={windows} dims={dims}
        planeW={W} planeH={D}
        position={[W / 2, H - INSET, D / 2]}
        rotation={[Math.PI / 2, 0, 0]}
        flipU
        meshRef={cRef}
      />
    </>
  );
}

// ─── Sun: directional light + small visible sphere ───────────────────────────
function Sun({ sunPos, dims, bearingDeg = 0 }) {
  if (!sunPos) return null;
  const { W, D } = dims;
  const { isAboveHorizon } = sunPos;
  const { dx, dy, dz } = sunVectorForView(sunPos, bearingDeg);

  // Scale the sun distance with the room size so it stays visually consistent.
  const dist = Math.max(18, Math.max(W, D) * 4);
  const cx = W / 2, cy = 0, cz = D / 2;
  const sx = cx + dx * dist;
  const sy = cy + dy * dist;
  const sz = cz + dz * dist;

  const intensity = isAboveHorizon ? 0.9 : 0.0;

  return (
    <>
      <directionalLight
        position={[sx, sy, sz]}
        intensity={intensity}
        color="#fff2c8"
      />
      {isAboveHorizon && (
        <mesh position={[sx, sy, sz]}>
          <sphereGeometry args={[0.35 * Math.max(1, Math.max(W, D) / 4), 18, 18]} />
          <meshBasicMaterial color="#ffde7a" toneMapped={false} />
        </mesh>
      )}
    </>
  );
}

// ─── Sun-path arc: thin polyline tracing the sun across the whole day ────────
// Purely illustrative; doesn't affect lighting.  Built imperatively as a
// THREE.Line to sidestep r3f's quirky handling of <line> in JSX.
function SunArc({ arcPoints }) {
  const lineObject = useMemo(() => {
    if (!arcPoints || arcPoints.length < 2) return null;
    const g = new THREE.BufferGeometry().setFromPoints(
      arcPoints.map(p => new THREE.Vector3(p[0], p[1], p[2]))
    );
    const m = new THREE.LineBasicMaterial({
      color: '#ffdd99', transparent: true, opacity: 0.35,
    });
    return new THREE.Line(g, m);
  }, [arcPoints]);

  if (!lineObject) return null;
  return <primitive object={lineObject} />;
}

// ─── Camera auto-framing ─────────────────────────────────────────────────────
// Keeps the camera and OrbitControls target aligned with the current room
// centre as the user resizes the room. Without this, resizing can leave the
// camera pointed off into empty space.
function CameraFramer({ dims, controlsRef }) {
  const { camera } = useThree();
  const { W, D, H } = dims;
  useEffect(() => {
    const target = new THREE.Vector3(W / 2, H / 2, D / 2);
    // Keep the camera's relative offset from the target, but scale it so the
    // room still fits nicely on screen as the dimensions change.
    const longest = Math.max(W, D, H);
    const baseOffset = new THREE.Vector3(longest * 1.4, longest * 1.6, -longest * 0.6);
    camera.position.copy(target).add(baseOffset);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    if (controlsRef.current) {
      controlsRef.current.target.copy(target);
      controlsRef.current.update();
    }
  }, [W, D, H, camera, controlsRef]);
  return null;
}

// ─── Top-level ───────────────────────────────────────────────────────────────
export default function RoomView3D({
  grid, wallGrids, windows, sunPos, cutaway,
  mode, date, timeMinutes, month, year,
  lat, lon, bearingDeg = 0,
  dims = { W: DEFAULT_ROOM_W, D: DEFAULT_ROOM_D, H: DEFAULT_ROOM_H },
}) {
  const { W, D, H } = dims;
  const controlsRef = useRef();

  // Initial framing (will be refined by CameraFramer on every dims change).
  const cameraPos = [W * 1.6, H * 2.0, -D * 0.6];
  const target    = [W / 2, H / 2, D / 2];

  // Build the actual sun track for the representative day shown in the
  // current view: the selected day in instant mode, or mid-month in monthly.
  const arcPoints = useMemo(() => {
    if (!sunPos) return null;
    const pts = [];
    const dist = Math.max(18, Math.max(W, D) * 4);
    const cx = W / 2, cz = D / 2;
    const arcDate = mode === 'monthly'
      ? new Date(year, month - 1, 15, 12, 0, 0)
      : new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(timeMinutes / 60), timeMinutes % 60, 0);
    // Use the location's longitude so the sun-arc spans that city's day
    // (e.g., Sydney's midnight-to-midnight, not the browser's).
    const samples = getDayTimeSamples(arcDate, 10, lon);

    for (const sample of samples) {
      const sampleSun = getSunPosition(sample, lat, lon);
      if (!sampleSun.isAboveHorizon) continue;
      const { dx, dy, dz } = sunVectorForView(sampleSun, bearingDeg);
      pts.push([cx + dx * dist, dy * dist, cz + dz * dist]);
    }
    return pts;
  }, [sunPos, mode, date, timeMinutes, month, year, W, D, lat, lon, bearingDeg]);

  const isDay = sunPos?.isAboveHorizon;

  // Orbit-controls distance bounds scale with the room.
  const longest = Math.max(W, D, H);
  const minDistance = Math.max(1.5, longest * 0.4);
  const maxDistance = Math.max(25,  longest * 6);

  // Far-plane must grow with the room so very large rooms don't get culled.
  const camFar = Math.max(200, longest * 20);

  return (
    <div style={{
      width: '100%',
      aspectRatio: '1 / 1',
      borderRadius: 6,
      overflow: 'hidden',
      background: isDay ? '#6d9ac7' : '#101525',
      position: 'relative',
      transition: 'background 0.4s',
    }}>
      <Canvas
        camera={{ position: cameraPos, fov: 42, near: 0.1, far: camFar }}
        dpr={[1, 2]}
        gl={{ antialias: true, preserveDrawingBuffer: false }}
      >
        {/* Gradient-ish sky: just a flat colour on the background */}
        <color attach="background" args={[isDay ? '#6d9ac7' : '#101525']} />
        {/* Ground plane outside the room — helps with orientation */}
        <mesh position={[W / 2, -0.01, D / 2]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[Math.max(40, longest * 8), Math.max(40, longest * 8)]} />
          <meshStandardMaterial color="#3a4257" roughness={1} />
        </mesh>

        {/* Ambient fill — brighter during the day, moonlight blue at night */}
        <ambientLight intensity={isDay ? 0.35 : 0.12} color={isDay ? '#e8eeff' : '#8aa0d0'} />
        {/* Hemisphere light adds a subtle sky/ground tint */}
        <hemisphereLight
          args={[isDay ? '#cfe2ff' : '#2c3a5a', '#3a3f55', isDay ? 0.35 : 0.15]}
        />

        <Sun sunPos={sunPos} dims={dims} bearingDeg={bearingDeg} />
        <SunArc arcPoints={arcPoints} />
        <Room windows={windows} cutaway={cutaway} dims={dims} />
        <FloorHeatmap grid={grid} dims={dims} />
        <WallOverlays wallGrids={wallGrids} windows={windows} cutaway={cutaway} dims={dims} />
        <WindowPanes windows={windows} dims={dims} />

        <OrbitControls
          ref={controlsRef}
          target={target}
          enablePan
          minDistance={minDistance}
          maxDistance={maxDistance}
          maxPolarAngle={Math.PI * 0.49}
        />
        <CameraFramer dims={dims} controlsRef={controlsRef} />
      </Canvas>
    </div>
  );
}
