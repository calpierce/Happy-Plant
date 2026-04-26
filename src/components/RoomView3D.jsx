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
  DEFAULT_ROOM_W, DEFAULT_ROOM_D, DEFAULT_ROOM_H,
} from '../simulation/constants';
import { intensityToRGB, makeFloorPalette, windowTransmission } from '../simulation/lightSim';
import { getDayTimeSamples, getSunPosition } from '../simulation/solar';

const kindOf = (w) => w.kind || 'wall';
const WALL_OVERLAY_SIZE = 128;

function gridSizeFor(grid) {
  const size = Math.sqrt(grid?.length || 0);
  return Number.isInteger(size) && size > 0 ? size : 1;
}

function makeBrickTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#9c4b34';
  ctx.fillRect(0, 0, size, size);

  const brickH = 32;
  const brickW = 72;
  const mortar = 4;
  for (let y = 0; y < size + brickH; y += brickH) {
    const offset = (Math.floor(y / brickH) % 2) * (brickW / 2);
    for (let x = -brickW; x < size + brickW; x += brickW) {
      const bx = x + offset;
      const shade = 0.85 + (((x + y) % 5) * 0.035);
      ctx.fillStyle = `rgb(${Math.round(156 * shade)}, ${Math.round(75 * shade)}, ${Math.round(52 * shade)})`;
      ctx.fillRect(bx + mortar, y + mortar, brickW - mortar, brickH - mortar);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(bx + mortar, y + mortar, brickW - mortar, 2);
      ctx.fillStyle = 'rgba(0,0,0,0.08)';
      ctx.fillRect(bx + mortar, y + brickH - mortar - 2, brickW - mortar, 2);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1.4, 1.2);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeGrassTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#376b35';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 2200; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const g = 92 + Math.random() * 70;
    ctx.fillStyle = `rgba(${35 + Math.random() * 25}, ${g}, ${34 + Math.random() * 25}, 0.55)`;
    ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 3);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(14, 14);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeWindowTexture(configId = 'clear') {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, 'rgba(220,245,255,0.92)');
  gradient.addColorStop(0.45, 'rgba(130,195,230,0.52)');
  gradient.addColorStop(1, 'rgba(245,255,255,0.72)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  if (configId === 'low-e') {
    ctx.fillStyle = 'rgba(90,150,210,0.42)';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(10, size - 18);
    ctx.lineTo(size - 18, 10);
    ctx.stroke();
  } else if (configId === 'frosted') {
    ctx.fillStyle = 'rgba(235,240,238,0.62)';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 850; i++) {
      const x = (i * 37) % size;
      const y = (i * 61) % size;
      const alpha = 0.08 + ((i % 7) * 0.018);
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.fillRect(x, y, 2 + (i % 3), 2 + (i % 4));
    }
  } else if (configId === 'sheer-blinds') {
    ctx.fillStyle = 'rgba(245,242,224,0.38)';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(235,228,198,0.72)';
    ctx.lineWidth = 3;
    for (let y = 8; y < size; y += 12) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(size, y);
      ctx.stroke();
    }
  } else if (configId === 'closed-blinds') {
    ctx.fillStyle = 'rgba(170,145,105,0.72)';
    ctx.fillRect(0, 0, size, size);
    for (let y = 0; y < size; y += 11) {
      ctx.fillStyle = 'rgba(105,82,55,0.85)';
      ctx.fillRect(0, y, size, 5);
      ctx.fillStyle = 'rgba(230,205,160,0.5)';
      ctx.fillRect(0, y + 5, size, 2);
    }
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, size - 4, size - 4);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeCompassLabelTexture(label, color = '#f5f0d8') {
  const size = 192;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.font = '900 128px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(25,32,20,0.92)';
  ctx.lineWidth = 16;
  ctx.strokeText(label, size / 2, size / 2 + 4);
  ctx.fillStyle = color;
  ctx.fillText(label, size / 2, size / 2 + 4);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

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
function FloorHeatmap({ grid, dims, sunPos }) {
  const { W, D } = dims;
  const gridSize = gridSizeFor(grid);
  // Allocate the texture once; update its pixel data when grid changes.
  const texture = useMemo(() => {
    const data = new Uint8Array(gridSize * gridSize * 4);
    const tex = new THREE.DataTexture(data, gridSize, gridSize, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }, [gridSize]);

  useEffect(() => {
    if (!grid) return;
    const data = texture.image.data;
    // Per-render palette: warm at low sun, cooler near solar noon.
    const palette = makeFloorPalette(sunPos?.altitude);
    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        const val = grid[i * gridSize + j];
        const [r, g, b] = intensityToRGB(val, palette);
        // Flip N-S: sim j=0 (south, Z=0) maps to the LAST texture row
        // because the plane's UV v=0 ends up at world +Z after rotation.
        const row = gridSize - 1 - j;
        // Flip E-W: mirror the east-west axis on the 3D floor heatmap.
        const col = gridSize - 1 - i;
        const idx = (row * gridSize + col) * 4;
        data[idx]     = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 255;
      }
    }
    texture.needsUpdate = true;
  }, [grid, texture, sunPos?.altitude, gridSize]);

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
const CUTAWAY_MIN_WALL_OPACITY = 0.12;

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0 || 1)));
  return t * t * (3 - 2 * t);
}

// Given the camera position, how opaque should each room surface be?  The
// surface fades as the camera moves onto its outside side, avoiding the hard
// pop that a binary hide/show threshold creates.
function wallOpacities(cam, cutaway, dims) {
  if (!cutaway) return { S: 1, N: 1, xMax: 1, xZero: 1, ceiling: 1 };
  const { W, D, H } = dims;
  const fadeDist = Math.max(W, D, H) * 0.65;
  const fade = (outsideDistance) => (
    1 - smoothstep(0, fadeDist, Math.max(0, outsideDistance)) * (1 - CUTAWAY_MIN_WALL_OPACITY)
  );
  return {
    S:       fade(-cam.z),      // south wall at z=0, outside = z<0
    N:       fade(cam.z - D),   // north wall at z=D, outside = z>D
    xMax:    fade(cam.x - W),   // wall at x=W, outside = x>W
    xZero:   fade(-cam.x),      // wall at x=0, outside = x<0
    ceiling: fade(cam.y - H),   // ceiling at y=H, outside = y>H
  };
}

function setObjectOpacity(object, opacity) {
  if (!object) return;
  object.visible = opacity > 0.01;
  object.traverse(child => {
    const materials = child.material
      ? (Array.isArray(child.material) ? child.material : [child.material])
      : [];
    for (const material of materials) {
      if (material.userData.cutawayOriginalDepthWrite === undefined) {
        material.userData.cutawayOriginalDepthWrite = material.depthWrite;
      }
      material.transparent = opacity < 0.999;
      material.opacity = opacity;
      material.depthWrite = opacity >= 0.999
        ? material.userData.cutawayOriginalDepthWrite
        : false;
      material.needsUpdate = true;
    }
  });
}

function WallSurface({ meshRef, geometry, position, rotation, brickTexture, interiorSide, exteriorSide }) {
  return (
    <group ref={meshRef} position={position} rotation={rotation}>
      <mesh geometry={geometry}>
        <meshBasicMaterial
          color="#555867"
          side={interiorSide}
        />
      </mesh>
      <mesh geometry={geometry}>
        <meshStandardMaterial
          color="#ffffff"
          map={brickTexture}
          emissive="#24130d"
          emissiveIntensity={0.16}
          roughness={0.9}
          metalness={0.0}
          side={exteriorSide}
        />
      </mesh>
    </group>
  );
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
  const brickTexture = useMemo(() => makeBrickTexture(), []);

  useFrame(({ camera }) => {
    const opacity = wallOpacities(camera.position, cutaway, dims);
    setObjectOpacity(southRef.current, opacity.S);
    setObjectOpacity(northRef.current, opacity.N);
    setObjectOpacity(xMaxRef.current, opacity.xMax);
    setObjectOpacity(xZeroRef.current, opacity.xZero);
    setObjectOpacity(ceilingRef.current, opacity.ceiling);
  });

  // The 3D room mirrors the east-west axis relative to the editor canvas, so
  // N/S wall openings flip their sim X coordinate into world X.
  const southGeo = useMemo(
    () => buildShapeGeom(W, H,
      wallWindows.filter(w => w.wall === 'S').map(w => ({
        x: W - w.max, y: w.yMin,
        w: w.max - w.min, h: w.yMax - w.yMin,
      }))),
    [wallWindows, W, H]
  );
  const northGeo = useMemo(
    () => buildShapeGeom(W, H,
      wallWindows.filter(w => w.wall === 'N').map(w => ({
        x: W - w.max, y: w.yMin,
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

  const ceilingColor = '#666a79';
  return (
    <group>
      {/* South wall (Z = 0) — shape in XY plane already faces +Z */}
      <WallSurface
        meshRef={southRef}
        geometry={southGeo}
        position={[0, 0, 0]}
        brickTexture={brickTexture}
        interiorSide={THREE.FrontSide}
        exteriorSide={THREE.BackSide}
      />
      {/* North wall (Z = D) */}
      <WallSurface
        meshRef={northRef}
        geometry={northGeo}
        position={[0, 0, D]}
        brickTexture={brickTexture}
        interiorSide={THREE.BackSide}
        exteriorSide={THREE.FrontSide}
      />
      {/* Mesh at X = W (rendered with sim-W wall data) */}
      <WallSurface
        meshRef={xMaxRef}
        geometry={eastGeo}
        rotation={[0, -Math.PI / 2, 0]}
        position={[W, 0, 0]}
        brickTexture={brickTexture}
        interiorSide={THREE.FrontSide}
        exteriorSide={THREE.BackSide}
      />
      {/* Mesh at X = 0 (rendered with sim-E wall data) */}
      <WallSurface
        meshRef={xZeroRef}
        geometry={westGeo}
        rotation={[0, -Math.PI / 2, 0]}
        position={[0, 0, 0]}
        brickTexture={brickTexture}
        interiorSide={THREE.BackSide}
        exteriorSide={THREE.FrontSide}
      />
      {/* Ceiling (Y = H) */}
      <mesh
        ref={ceilingRef}
        geometry={ceilingGeo}
        rotation={[Math.PI / 2, 0, 0]}
        position={[0, H, 0]}
      >
        <meshBasicMaterial
          color={ceilingColor}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

// ─── Translucent glass panes filling each window / skylight hole ─────────────
function WindowPanes({ windows, dims }) {
  const { W, D, H } = dims;
  const windowTextures = useMemo(() => ({
    clear: makeWindowTexture('clear'),
    'low-e': makeWindowTexture('low-e'),
    frosted: makeWindowTexture('frosted'),
    'sheer-blinds': makeWindowTexture('sheer-blinds'),
    'closed-blinds': makeWindowTexture('closed-blinds'),
  }), []);

  const paneMaterial = (w) => {
    const trans = windowTransmission(w);
    const configId = w.config || 'clear';
    return (
      <meshStandardMaterial
        color={trans < 0.3 ? '#d3c7aa' : trans < 0.65 ? '#c8d5dc' : '#a3d8ff'}
        map={windowTextures[configId] || windowTextures.clear}
        transparent
        opacity={configId === 'closed-blinds' ? 0.82 : 0.24 + (1 - trans) * 0.42}
        roughness={trans < 0.65 ? 0.75 : 0.1}
        metalness={0.0}
        emissive="#203048"
        emissiveIntensity={0.18 + trans * 0.14}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    );
  };

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
              {paneMaterial(w)}
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
          position = [W - centerAlong, centerY, 0.005];
          rotation = [0, 0, 0];
        } else if (w.wall === 'N') {
          position = [W - centerAlong, centerY, D - 0.005];
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
            {paneMaterial(w)}
          </mesh>
        );
      })}
    </>
  );
}

// ─── Wall / ceiling light overlays ───────────────────────────────────────────
// Soft translucent overlays that brighten each surface where light lands.
// Zero values add nothing, high values tint the brick/ceiling with warm light.
function intensityToAdditiveRGB(t) {
  const x = Math.pow(Math.max(0, Math.min(1, t)), 0.72);
  return [
    Math.round(255 * x),
    Math.round(232 * x),
    Math.round(165 * x),
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

function isCellInWindow(wallName, iu, iv, windows, dims, gridSize) {
  const { usize, vsize } = wallAxes(dims)[wallName];
  const u = (iu + 0.5) / gridSize * usize;
  const v = (iv + 0.5) / gridSize * vsize;
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

function sampleGridBilinear(grid, u, v) {
  const gridSize = gridSizeFor(grid);
  const x = Math.max(0, Math.min(gridSize - 1, u * (gridSize - 1)));
  const y = Math.max(0, Math.min(gridSize - 1, v * (gridSize - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(gridSize - 1, x0 + 1);
  const y1 = Math.min(gridSize - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const a = grid[x0 * gridSize + y0];
  const b = grid[x1 * gridSize + y0];
  const c = grid[x0 * gridSize + y1];
  const d = grid[x1 * gridSize + y1];
  return (
    a * (1 - tx) * (1 - ty) +
    b * tx * (1 - ty) +
    c * (1 - tx) * ty +
    d * tx * ty
  );
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
    const data = new Uint8Array(WALL_OVERLAY_SIZE * WALL_OVERLAY_SIZE * 4);
    const tex = new THREE.DataTexture(data, WALL_OVERLAY_SIZE, WALL_OVERLAY_SIZE, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }, []);

  useEffect(() => {
    if (!grid) return;
    const gridSize = gridSizeFor(grid);
    const data = texture.image.data;
    for (let px = 0; px < WALL_OVERLAY_SIZE; px++) {
      for (let py = 0; py < WALL_OVERLAY_SIZE; py++) {
        const u = px / (WALL_OVERLAY_SIZE - 1);
        const v = py / (WALL_OVERLAY_SIZE - 1);
        const iu = Math.min(gridSize - 1, Math.floor(u * gridSize));
        const iv = Math.min(gridSize - 1, Math.floor(v * gridSize));
        const masked = isCellInWindow(wallName, iu, iv, windows, dims, gridSize);
        const val = masked ? 0 : sampleGridBilinear(grid, u, v);
        const [r, g, b] = intensityToAdditiveRGB(val);
        const col = flipU ? (WALL_OVERLAY_SIZE - 1 - px) : px;
        const row = py;
        const idx = (row * WALL_OVERLAY_SIZE + col) * 4;
        data[idx]     = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = Math.round(230 * Math.pow(Math.max(0, Math.min(1, val)), 0.68));
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
    const opacity = wallOpacities(camera.position, cutaway, dims);
    setObjectOpacity(sRef.current, opacity.S);
    setObjectOpacity(nRef.current, opacity.N);
    setObjectOpacity(xMaxRef.current, opacity.xMax);
    setObjectOpacity(xZeroRef.current, opacity.xZero);
    setObjectOpacity(cRef.current, opacity.ceiling);
  });

  if (!wallGrids) return null;
  const INSET = 0.004;   // slightly inside the room so we don't z-fight the wall
  return (
    <>
      {/* South wall (z=0) — mirrored to match the wall cut-outs. */}
      <WallOverlay
        wallName="S"
        grid={wallGrids.S}
        windows={windows} dims={dims}
        planeW={W} planeH={H}
        position={[W / 2, H / 2, INSET]}
        rotation={[0, 0, 0]}
        flipU
        meshRef={sRef}
      />
      {/* North wall (z=D) — viewed from the BACK of the plane when the
          camera is inside the room, so we apply flipU to cancel the implicit
          back-side U reversal.  Matches northGeo's mirrored cut-out. */}
      <WallOverlay
        wallName="N"
        grid={wallGrids.N}
        windows={windows} dims={dims}
        planeW={W} planeH={H}
        position={[W / 2, H / 2, D - INSET]}
        rotation={[0, 0, 0]}
        flipU
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
  const lightRef = useRef();
  const targetRef = useRef();
  const { W, D, H } = dims;

  useEffect(() => {
    if (!lightRef.current || !targetRef.current) return;
    lightRef.current.target = targetRef.current;
    lightRef.current.target.updateMatrixWorld();
  });

  if (!sunPos) return null;
  const { isAboveHorizon } = sunPos;
  const { dx, dy, dz } = sunVectorForView(sunPos, bearingDeg);

  // Scale the sun distance with the room size so it stays visually consistent.
  const dist = Math.max(18, Math.max(W, D) * 4);
  const cx = W / 2, cy = 0, cz = D / 2;
  const sx = cx + dx * dist;
  const sy = cy + dy * dist;
  const sz = cz + dz * dist;

  const intensity = isAboveHorizon ? 0.62 : 0.0;
  const shadowSize = Math.max(W, D, H) + 8;

  return (
    <>
      <directionalLight
        ref={lightRef}
        position={[sx, sy, sz]}
        intensity={intensity}
        color="#fff2c8"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-shadowSize}
        shadow-camera-right={shadowSize}
        shadow-camera-top={shadowSize}
        shadow-camera-bottom={-shadowSize}
        shadow-camera-near={0.5}
        shadow-camera-far={dist + shadowSize}
        shadow-bias={-0.00025}
        shadow-normalBias={0.035}
      />
      <object3D ref={targetRef} position={[cx, cy, cz]} />
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

function CompassFloorOverlay({ dims, bearingDeg = 0 }) {
  const { W, D } = dims;
  const center = useMemo(() => new THREE.Vector3(W / 2, 0.018, D / 2), [W, D]);
  const outer = Math.max(W, D) * 0.78 + 1.2;
  const labelDistance = outer + 0.55;
  const bRad = bearingDeg * Math.PI / 180;
  const sinB = Math.sin(bRad);
  const cosB = Math.cos(bRad);

  const markers = useMemo(() => ([
    { label: 'N', dir: new THREE.Vector3(-sinB, 0,  cosB), color: '#f1c94a' },
    { label: 'E', dir: new THREE.Vector3(-cosB, 0, -sinB), color: '#f5f0d8' },
    { label: 'S', dir: new THREE.Vector3( sinB, 0, -cosB), color: '#f5f0d8' },
    { label: 'W', dir: new THREE.Vector3( cosB, 0,  sinB), color: '#f5f0d8' },
  ]), [sinB, cosB]);

  const labelTextures = useMemo(() => ({
    N: makeCompassLabelTexture('N', '#f1c94a'),
    E: makeCompassLabelTexture('E', '#f5f0d8'),
    S: makeCompassLabelTexture('S', '#f5f0d8'),
    W: makeCompassLabelTexture('W', '#f5f0d8'),
  }), []);

  const lines = useMemo(() => markers.map(m => {
    const end = center.clone().add(m.dir.clone().multiplyScalar(outer));
    const geometry = new THREE.BufferGeometry().setFromPoints([center, end]);
    const material = new THREE.LineBasicMaterial({
      color: m.color,
      transparent: true,
      opacity: m.label === 'N' ? 0.9 : 0.58,
      depthWrite: false,
    });
    return { ...m, object: new THREE.Line(geometry, material), geometry, material, end };
  }), [markers, center, outer]);

  useEffect(() => () => {
    for (const line of lines) {
      line.geometry.dispose();
      line.material.dispose();
    }
  }, [lines]);

  useEffect(() => () => {
    Object.values(labelTextures).forEach(tex => tex.dispose());
  }, [labelTextures]);

  return (
    <group>
      {lines.map(line => {
        const labelPos = center.clone().add(line.dir.clone().multiplyScalar(labelDistance));
        const labelRot = line.label === 'E' || line.label === 'W'
          ? Math.PI
          : Math.atan2(-line.dir.x, line.dir.z);
        return (
          <group key={line.label}>
            <primitive object={line.object} />
            <mesh
              position={[labelPos.x, 0.035, labelPos.z]}
              rotation={[-Math.PI / 2, 0, labelRot]}
            >
              <planeGeometry args={[
                Math.max(0.44, Math.min(0.95, Math.max(W, D) * 0.14)),
                Math.max(0.44, Math.min(0.95, Math.max(W, D) * 0.14)),
              ]} />
              <meshBasicMaterial
                map={labelTextures[line.label]}
                transparent
                toneMapped={false}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

function OutdoorObstacles({ obstacles = [], sunPos, bearingDeg = 0, dims = { W: DEFAULT_ROOM_W, D: DEFAULT_ROOM_D, H: DEFAULT_ROOM_H } }) {
  const { W } = dims;
  return (
    <group>
      {obstacles.map(obstacle => {
        const type = obstacle.type || 'tree';
        const radius = obstacle.radius || 0.6;
        const height = obstacle.height || 3;
        // E-W flip to match the 3D view's flipped heatmap texture
        const x = W - obstacle.x;
        const z = obstacle.z;

        return (
          <group key={obstacle.id}>
            {type === 'tree' && (
              <>
                <mesh castShadow receiveShadow position={[x, height * 0.28, z]}>
                  <cylinderGeometry args={[radius * 0.13, radius * 0.18, height * 0.56, 8]} />
                  <meshStandardMaterial color="#6f4f2d" roughness={0.9} />
                </mesh>
                <mesh castShadow receiveShadow position={[x, height * 0.78, z]}>
                  <sphereGeometry args={[radius, 18, 14]} />
                  <meshStandardMaterial color="#3f8f44" roughness={0.95} />
                </mesh>
              </>
            )}
            {type === 'hedge' && (
              <mesh castShadow receiveShadow position={[x, height / 2, z]}>
                <boxGeometry args={[radius * 2.6, height, radius * 1.1]} />
                <meshStandardMaterial color="#4f9140" roughness={1} />
              </mesh>
            )}
            {type === 'fence' && (
              <mesh castShadow receiveShadow position={[x, height / 2, z]}>
                <boxGeometry args={[radius * 3.1, height, 0.08]} />
                <meshStandardMaterial color="#b08a5e" roughness={0.85} />
              </mesh>
            )}
            {type === 'shed' && (
              <mesh castShadow receiveShadow position={[x, height / 2, z]}>
                <boxGeometry args={[radius * 2, height, radius * 1.5]} />
                <meshStandardMaterial color="#7b6a5b" roughness={0.9} />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
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
    const longest = Math.max(W, D, H);
    const baseOffset = new THREE.Vector3(0, longest * 0.95, -longest * 1.8);
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
  grid, wallGrids, windows, obstacles = [], sunPos, cutaway,
  mode, date, timeMinutes, month, year,
  lat, lon, bearingDeg = 0,
  dims = { W: DEFAULT_ROOM_W, D: DEFAULT_ROOM_D, H: DEFAULT_ROOM_H },
}) {
  const { W, D, H } = dims;
  const controlsRef = useRef();
  const grassTexture = useMemo(() => makeGrassTexture(), []);

  // Initial framing (will be refined by CameraFramer on every dims change).
  const cameraPos = [W / 2, H / 2 + Math.max(W, D, H) * 0.95, D / 2 - Math.max(W, D, H) * 1.8];
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
        shadows
        camera={{ position: cameraPos, fov: 42, near: 0.1, far: camFar }}
        dpr={[1, 2]}
        gl={{ antialias: true, preserveDrawingBuffer: false }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 0.9;
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.shadowMap.enabled = true;
          gl.shadowMap.type = THREE.PCFSoftShadowMap;
        }}
      >
        {/* Gradient-ish sky: just a flat colour on the background */}
        <color attach="background" args={[isDay ? '#6d9ac7' : '#101525']} />
        {/* Ground plane outside the room — helps with orientation */}
        <mesh receiveShadow position={[W / 2, -0.01, D / 2]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[Math.max(40, longest * 8), Math.max(40, longest * 8)]} />
          <meshStandardMaterial
            color="#8fcf72"
            map={grassTexture}
            emissive="#143010"
            emissiveIntensity={isDay ? 0.02 : 0.22}
            roughness={1}
          />
        </mesh>

        {/* Ambient fill — enough to read the room without flattening the heatmap. */}
        <ambientLight intensity={isDay ? 0.34 : 0.34} color={isDay ? '#f0f2ff' : '#9aa9d0'} />
        {/* Hemisphere light adds a subtle sky/grass tint */}
        <hemisphereLight
          args={[isDay ? '#cfe2ff' : '#4a5d8a', '#496c35', isDay ? 0.3 : 0.26]}
        />

        <Sun sunPos={sunPos} dims={dims} bearingDeg={bearingDeg} />
        <SunArc arcPoints={arcPoints} />
        <CompassFloorOverlay dims={dims} bearingDeg={bearingDeg} />
        <OutdoorObstacles obstacles={obstacles} dims={dims} />
        <Room windows={windows} cutaway={cutaway} dims={dims} />
        <FloorHeatmap grid={grid} dims={dims} sunPos={sunPos} />
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
