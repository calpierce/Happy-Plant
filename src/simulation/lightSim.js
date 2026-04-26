/**
 * Light simulation engine – hybrid simplified model.
 *
 * Coordinate system (matches constants.js):
 *   X : East  (0–W m)
 *   Y : Up    (0–H m)
 *   Z : North (0 = south wall, D = north wall)
 *
 * Sun direction conventions (SunCalc):
 *   azimuth  : from south, clockwise toward west (radians)
 *   altitude : above horizon (radians)
 *
 * Windows are user-defined at runtime. Each has a `wall` ∈ {N,S,E,W},
 * an along-wall range [min,max] and a height range [yMin,yMax].
 *
 * We back-trace: for each floor cell we fire a ray TOWARD the sun and ask
 * whether it exits through any window opening. Each window can contribute
 * independently if the ray geometry allows.
 *
 * Room dimensions (W, D, H) are passed in as a `dims` argument so the
 * caller (useSimulation) can change them at runtime.
 */

import {
  INSTANT_GRID_SIZE,
  WALL_REFLECTANCE, FLOOR_REFLECTANCE,
  DEFAULT_ROOM_W, DEFAULT_ROOM_D, DEFAULT_ROOM_H,
  MIN_WINDOW_WIDTH, MIN_SKYLIGHT_SIZE,
} from './constants.js';
import { wallSkyExposureFactor } from './solar.js';

const DEFAULT_DIMS = { W: DEFAULT_ROOM_W, D: DEFAULT_ROOM_D, H: DEFAULT_ROOM_H };

// Treat a missing `kind` as a wall window so older/legacy entries keep working.
const kindOf = (w) => w.kind || 'wall';
const WALL_VIEW_FACTOR_DIFFUSE_GAIN = 5.5;
const WALL_VIEW_FACTOR_MAX = 0.45;

export const WINDOW_CONFIGS = [
  {
    id: 'clear',
    label: 'Clear glass',
    description: 'Most direct sun',
    transmission: 1.0,
  },
  {
    id: 'low-e',
    label: 'Low-E glass',
    description: 'Slightly softened',
    transmission: 0.78,
  },
  {
    id: 'frosted',
    label: 'Frosted glass',
    description: 'Diffuse and muted',
    transmission: 0.58,
  },
  {
    id: 'sheer-blinds',
    label: 'Sheer blinds',
    description: 'Filtered daylight',
    transmission: 0.42,
  },
  {
    id: 'closed-blinds',
    label: 'Closed blinds',
    description: 'Mostly shaded',
    transmission: 0.18,
  },
];

function windowConfigFor(win) {
  return WINDOW_CONFIGS.find(c => c.id === win.config) || WINDOW_CONFIGS[0];
}

export function windowTransmission(win) {
  return windowConfigFor(win).transmission;
}

export const OBSTACLE_TYPES = [
  { id: 'tree', label: 'Tree', radius: 0.65, height: 4.0, opacity: 0.72 },
  { id: 'hedge', label: 'Hedge', radius: 0.55, height: 1.6, opacity: 0.52 },
  { id: 'fence', label: 'Fence', radius: 0.35, height: 1.9, opacity: 0.42 },
  { id: 'shed', label: 'Shed', radius: 0.8, height: 2.4, opacity: 0.9 },
];

function obstacleTypeFor(obstacle) {
  return OBSTACLE_TYPES.find(t => t.id === obstacle.type) || OBSTACLE_TYPES[0];
}

const RAY_EPS = 1e-4;

function intervalAfter(tMin, tMax, afterT) {
  const start = Math.max(tMin, afterT + RAY_EPS);
  if (tMax <= start) return null;
  return { t: start, length: tMax - start };
}

function axisSlab(origin, dir, min, max) {
  if (Math.abs(dir) < 1e-8) {
    return origin >= min && origin <= max
      ? { min: -Infinity, max: Infinity }
      : null;
  }
  const a = (min - origin) / dir;
  const b = (max - origin) / dir;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

function rayBoxHit(cx, cy, cz, dx, dy, dz, afterT, box) {
  const sx = axisSlab(cx, dx, box.minX, box.maxX);
  if (!sx) return null;
  const sy = axisSlab(cy, dy, box.minY, box.maxY);
  if (!sy) return null;
  const sz = axisSlab(cz, dz, box.minZ, box.maxZ);
  if (!sz) return null;
  const tMin = Math.max(sx.min, sy.min, sz.min);
  const tMax = Math.min(sx.max, sy.max, sz.max);
  return intervalAfter(tMin, tMax, afterT);
}

function rayVerticalCylinderHit(cx, cy, cz, dx, dy, dz, afterT, cyl) {
  const lx = cx - cyl.x;
  const lz = cz - cyl.z;
  const a = dx * dx + dz * dz;
  let hMin = -Infinity;
  let hMax = Infinity;

  if (a < 1e-8) {
    if (lx * lx + lz * lz > cyl.radius * cyl.radius) return null;
  } else {
    const b = 2 * (lx * dx + lz * dz);
    const c = lx * lx + lz * lz - cyl.radius * cyl.radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const root = Math.sqrt(disc);
    hMin = (-b - root) / (2 * a);
    hMax = (-b + root) / (2 * a);
  }

  const ySlab = axisSlab(cy, dy, cyl.minY, cyl.maxY);
  if (!ySlab) return null;
  const tMin = Math.max(hMin, ySlab.min);
  const tMax = Math.min(hMax, ySlab.max);
  return intervalAfter(tMin, tMax, afterT);
}

function rayEllipsoidHit(cx, cy, cz, dx, dy, dz, afterT, ellipsoid) {
  const lx = (cx - ellipsoid.x) / ellipsoid.rx;
  const ly = (cy - ellipsoid.y) / ellipsoid.ry;
  const lz = (cz - ellipsoid.z) / ellipsoid.rz;
  const vx = dx / ellipsoid.rx;
  const vy = dy / ellipsoid.ry;
  const vz = dz / ellipsoid.rz;
  const a = vx * vx + vy * vy + vz * vz;
  if (a < 1e-8) return null;
  const b = 2 * (lx * vx + ly * vy + lz * vz);
  const c = lx * lx + ly * ly + lz * lz - 1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const tMin = (-b - root) / (2 * a);
  const tMax = (-b + root) / (2 * a);
  return intervalAfter(tMin, tMax, afterT);
}

function combineBlocks(blocks) {
  let transmit = 1;
  for (const block of blocks) {
    transmit *= 1 - Math.max(0, Math.min(0.96, block));
  }
  return 1 - transmit;
}

function obstacleComponentBlock(hit, opacity, softness = 0) {
  if (!hit) return 0;
  const density = softness > 0
    ? 1 - Math.exp(-hit.length / softness)
    : 1;
  return opacity * density;
}

function obstacleBlockForRay(cx, cy, cz, dx, dy, dz, afterT, obstacle, type) {
  const ox = obstacle.x;
  const oz = obstacle.z;
  const radius = obstacle.radius ?? type.radius;
  const height = obstacle.height ?? type.height;
  const opacity = obstacle.opacity ?? type.opacity;
  const kind = obstacle.type || type.id;

  if (kind === 'tree') {
    const trunkRadius = Math.max(0.06, radius * 0.17);
    const trunkHit = rayVerticalCylinderHit(cx, cy, cz, dx, dy, dz, afterT, {
      x: ox,
      z: oz,
      radius: trunkRadius,
      minY: 0,
      maxY: height * 0.58,
    });
    const canopyHit = rayEllipsoidHit(cx, cy, cz, dx, dy, dz, afterT, {
      x: ox,
      y: height * 0.78,
      z: oz,
      rx: radius,
      ry: Math.max(radius * 0.9, height * 0.12),
      rz: radius,
    });
    return combineBlocks([
      obstacleComponentBlock(trunkHit, Math.min(0.95, opacity + 0.18), trunkRadius * 1.5),
      obstacleComponentBlock(canopyHit, opacity, radius * 0.75),
    ]);
  }

  if (kind === 'hedge') {
    const hit = rayBoxHit(cx, cy, cz, dx, dy, dz, afterT, {
      minX: ox - radius * 1.3,
      maxX: ox + radius * 1.3,
      minY: 0,
      maxY: height,
      minZ: oz - radius * 0.55,
      maxZ: oz + radius * 0.55,
    });
    return obstacleComponentBlock(hit, opacity, radius * 0.8);
  }

  if (kind === 'fence') {
    const hit = rayBoxHit(cx, cy, cz, dx, dy, dz, afterT, {
      minX: ox - radius * 1.55,
      maxX: ox + radius * 1.55,
      minY: 0,
      maxY: height,
      minZ: oz - 0.04,
      maxZ: oz + 0.04,
    });
    return obstacleComponentBlock(hit, opacity, 0.08);
  }

  if (kind === 'shed') {
    const hit = rayBoxHit(cx, cy, cz, dx, dy, dz, afterT, {
      minX: ox - radius,
      maxX: ox + radius,
      minY: 0,
      maxY: height,
      minZ: oz - radius * 0.75,
      maxZ: oz + radius * 0.75,
    });
    return obstacleComponentBlock(hit, opacity);
  }

  const hit = rayVerticalCylinderHit(cx, cy, cz, dx, dy, dz, afterT, {
    x: ox,
    z: oz,
    radius,
    minY: 0,
    maxY: height,
  });
  return obstacleComponentBlock(hit, opacity);
}

function obstacleBlocksRay(cx, cy, cz, dx, dy, dz, afterT, obstacles = []) {
  const blocks = [];
  for (const obstacle of obstacles) {
    const type = obstacleTypeFor(obstacle);
    const block = obstacleBlockForRay(cx, cy, cz, dx, dy, dz, afterT, obstacle, type);
    if (block > 0) blocks.push(block);
  }
  return Math.max(0, Math.min(0.96, combineBlocks(blocks)));
}

// ─── Floor colour palettes ────────────────────────────────────────────────────
// Two palettes are defined, both walking from a near-black "deep shadow" to a
// bright "sunlit" stop at the same normalized positions, so they can be
// blended pair-wise at each stop based on the sun's altitude.
//
//   WARM_PALETTE  — low sun (dawn / dusk / winter):  ~2500–3200 K feel.
//                   Reds and oranges dominate the bright end.
//   COOL_PALETTE  — high sun (solar noon / summer):  ~5000–5500 K feel.
//                   Warm yellows shading to a neutral cream/white at the top.
//
// IMPORTANT: these two palettes do NOT use navy/blue anywhere. Previously the
// dark end was navy, which caused dim months to collapse into a "night blue"
// image and mid-dim cells to read as unnaturally cool. The shadow end is now
// a slightly warm near-black that reads as unlit floor, not night.
const WARM_PALETTE = [
  { at: 0.00, r:   6, g:   4, b:   3 },   // near-black, warm
  { at: 0.15, r:  40, g:  22, b:  12 },   // very dark umber
  { at: 0.35, r: 115, g:  55, b:  22 },   // rust / terracotta
  { at: 0.55, r: 210, g: 105, b:  40 },   // deep orange
  { at: 0.78, r: 248, g: 170, b:  85 },   // warm amber
  { at: 0.92, r: 253, g: 220, b: 160 },   // peach
  { at: 1.00, r: 255, g: 238, b: 200 },   // warm cream
];

const COOL_PALETTE = [
  { at: 0.00, r:   8, g:   7, b:   5 },   // near-black, neutral
  { at: 0.15, r:  40, g:  32, b:  20 },   // dark warm neutral
  { at: 0.35, r: 125, g:  95, b:  50 },   // warm umber
  { at: 0.55, r: 210, g: 155, b:  70 },   // muted amber
  { at: 0.78, r: 243, g: 210, b: 125 },   // warm yellow
  { at: 0.92, r: 251, g: 238, b: 198 },   // pale cream
  { at: 1.00, r: 255, g: 253, b: 242 },   // neutral white
];

// Representative mid-blend palette used when no sun altitude is available
// (e.g. the static UI legend). ~40% cool.
const DEFAULT_PALETTE = blendPalettes(WARM_PALETTE, COOL_PALETTE, 0.4);

// Display curve for the heatmap.
// A small floor keeps dim rooms readable, while the shoulder stops direct sun
// and skylights from slamming into pure white too quickly.
const DISPLAY_SHADOW_LIFT = 0.04;
const DISPLAY_HIGHLIGHT_SHOULDER = 0.88;
const DISPLAY_GAMMA = 0.82;

function blendPalettes(a, b, k) {
  const t = Math.max(0, Math.min(1, k));
  const out = [];
  for (let i = 0; i < a.length; i++) {
    out.push({
      at: a[i].at,
      r: Math.round(a[i].r + (b[i].r - a[i].r) * t),
      g: Math.round(a[i].g + (b[i].g - a[i].g) * t),
      b: Math.round(a[i].b + (b[i].b - a[i].b) * t),
    });
  }
  return out;
}

/**
 * Sun-altitude → coolness blend factor (0 = full warm, 1 = full cool).
 * Smooth ramp between 10° (still golden-hour warm) and 55° (effectively
 * solar-noon neutral). Below-horizon or negative altitudes stay fully warm.
 */
function coolnessFromAltitude(altitudeRad) {
  if (!Number.isFinite(altitudeRad)) return 0;
  const deg = (altitudeRad * 180) / Math.PI;
  const t = (deg - 10) / 45;
  return Math.max(0, Math.min(1, t));
}

/**
 * Build a per-render floor palette from the sun's current altitude.
 * Call this ONCE per render pass, then pass the result as the `palette`
 * argument to `intensityToRGB` for each cell.
 *
 * @param {number|null|undefined} sunAltitudeRad
 * @returns {Array<{at:number,r:number,g:number,b:number}>}
 */
export function makeFloorPalette(sunAltitudeRad) {
  if (sunAltitudeRad == null) return DEFAULT_PALETTE;
  const k = coolnessFromAltitude(sunAltitudeRad);
  return blendPalettes(WARM_PALETTE, COOL_PALETTE, k);
}

/**
 * Map a [0,1] intensity to an RGB triplet using a given palette.
 * If `palette` is omitted, the default mid-blend palette is used so legacy
 * callers (e.g. static UI previews) still work.
 */
export function intensityToRGB(t, palette = DEFAULT_PALETTE) {
  const clamp = Math.max(0, Math.min(1, t));
  const lifted = DISPLAY_SHADOW_LIFT + clamp * (DISPLAY_HIGHLIGHT_SHOULDER - DISPLAY_SHADOW_LIFT);
  const adjusted = Math.pow(Math.min(1, lifted), DISPLAY_GAMMA);
  // Find the segment [palette[i0], palette[i0+1]] that contains `adjusted`.
  // Loop bound is length-1 so i0 can reach the final segment (length-2);
  // previously this was length-2, which left the top segment unreachable and
  // caused extrapolation past the final stop (e.g. R > 255 at t=1.0).
  let i0 = 0;
  for (let k = 0; k < palette.length - 1; k++) {
    if (adjusted >= palette[k].at) i0 = k;
  }
  const s0 = palette[i0], s1 = palette[i0 + 1];
  const f = s1.at > s0.at
    ? Math.max(0, Math.min(1, (adjusted - s0.at) / (s1.at - s0.at)))
    : 0;
  return [
    Math.round(s0.r + f * (s1.r - s0.r)),
    Math.round(s0.g + f * (s1.g - s0.g)),
    Math.round(s0.b + f * (s1.b - s0.b)),
  ];
}

// Exposed for the UI legend so it can render a gradient that matches the
// default palette without knowing the internals.
export { WARM_PALETTE, COOL_PALETTE, DEFAULT_PALETTE };

// ─── Core simulation ──────────────────────────────────────────────────────────

/**
 * Compute a grid of light intensities.
 *
 * @param {{ altitude: number, azimuth: number, isAboveHorizon: boolean }} sunPos
 * @param {Array} windows — wall windows and/or skylights
 * @param {{W:number, D:number, H:number}} dims — room dimensions (metres)
 * @returns {Float32Array} indexed as [i * gridSize + j]
 */
export function computeGrid(sunPos, windows = [], dims = DEFAULT_DIMS, options = {}) {
  const { W, D, H } = dims;
  const bearingDeg = options.bearingDeg || 0;
  const obstacles = options.obstacles || [];
  const gridSize = options.gridSize || INSTANT_GRID_SIZE;
  const cellW = W / gridSize;
  const cellD = D / gridSize;
  // Reference "depth scale" for the diffuse-light view-factor heuristic.
  // Using the max of W/D keeps falloff behaviour consistent across aspect ratios.
  const refDepth = Math.max(W, D);

  const grid = new Float32Array(gridSize * gridSize);
  const { altitude, azimuth, isAboveHorizon } = sunPos;

  // Sun direction in world frame (+X east, +Y up, +Z north) FROM floor cell
  // TOWARD sun.
  const sunDxWorld = -Math.sin(azimuth) * Math.cos(altitude);
  const sunDzWorld = -Math.cos(azimuth) * Math.cos(altitude);
  // Rotate into the ROOM's local frame so that the room's "N" wall is always
  // treated as Z = D regardless of which compass direction it's actually
  // pointing.  When bearingDeg = 0 this is a no-op (cos=1, sin=0), so legacy
  // behaviour is preserved.  For β ≠ 0, the direct-light back-trace now
  // correctly identifies which room wall the sun actually enters through.
  const bRad = bearingDeg * Math.PI / 180;
  const cosB = Math.cos(bRad);
  const sinB = Math.sin(bRad);
  const dx =  sunDxWorld * cosB - sunDzWorld * sinB;
  const dz =  sunDxWorld * sinB + sunDzWorld * cosB;
  const dy =  Math.sin(altitude);

  // Pre-compute which walls the ray can exit through, based on the sun's
  // horizontal direction. A ray with dz<0 can exit the south wall; dz>0
  // the north wall; dx>0 the east wall; dx<0 the west wall.
  const canExit = {
    S: isAboveHorizon && dz < -1e-6,
    N: isAboveHorizon && dz >  1e-6,
    E: isAboveHorizon && dx >  1e-6,
    W: isAboveHorizon && dx < -1e-6,
  };

  // angleFactor shared by all direct contributions (flat floor).
  const angleFactor = Math.sin(altitude);

  // Whether there is ANY window at all — affects whether diffuse sky light
  // can reach the room.
  const hasWindows = windows.length > 0;

  for (let i = 0; i < gridSize; i++) {
    for (let j = 0; j < gridSize; j++) {
      const cx = (i + 0.5) * cellW;  // east position
      const cz = (j + 0.5) * cellD;  // north position

      // ── 1. DIRECT LIGHT ──────────────────────────────────────────────────
      let direct = 0;

      if (isAboveHorizon) {
        for (let w = 0; w < windows.length; w++) {
          const win = windows[w];

          // 1a. Skylight: back-trace ray hits ceiling plane (Y = H).
          //     Requires dy > 0 (sun above horizon, already true here).
          //     No horizontal depth falloff — the path length is constant.
          if (kindOf(win) === 'skylight') {
            const trans = windowTransmission(win);
            if (dy < 1e-6) continue;
            const t = H / dy;
            const hitX = cx + t * dx;
            const hitZ = cz + t * dz;
            if (hitX >= win.xMin && hitX <= win.xMax &&
                hitZ >= win.zMin && hitZ <= win.zMax) {
              const block = obstacleBlocksRay(cx, 0, cz, dx, dy, dz, t, obstacles);
              direct += angleFactor * trans * (1 - block);
            }
            continue;
          }

          // 1b. Wall window — existing logic.
          if (!canExit[win.wall]) continue;

          let t, hitAlong, hitY, depth;

          if (win.wall === 'S') {            // Z = 0
            t = -cz / dz;
            hitAlong = cx + t * dx;
            hitY     =      t * dy;
            depth    = cz;
          } else if (win.wall === 'N') {     // Z = D
            t = (D - cz) / dz;
            hitAlong = cx + t * dx;
            hitY     =      t * dy;
            depth    = D - cz;
          } else if (win.wall === 'E') {     // X = W
            t = (W - cx) / dx;
            hitAlong = cz + t * dz;
            hitY     =      t * dy;
            depth    = W - cx;
          } else {                            // 'W', X = 0
            t = -cx / dx;
            hitAlong = cz + t * dz;
            hitY     =      t * dy;
            depth    = cx;
          }

          if (t <= 0) continue;
          const inWindow =
            hitAlong >= win.min  && hitAlong <= win.max &&
            hitY     >= win.yMin && hitY     <= win.yMax;

          if (inWindow) {
            const trans = windowTransmission(win);
            const depthFactor = Math.exp(-depth * 0.35);
            const block = obstacleBlocksRay(cx, 0, cz, dx, dy, dz, t, obstacles);
            direct += angleFactor * depthFactor * trans * (1 - block);
          }
        }
      }

      // ── 2. DIFFUSE / SKY LIGHT ───────────────────────────────────────────
      const sinAlt = isAboveHorizon ? Math.max(0, Math.sin(altitude)) : 0;

      // With dynamic windows, sky illuminance and view-factor depend on how
      // close the cell is to the CLOSEST window on any wall. We take the
      // minimum wall-distance across all active windows (with a small
      // along-wall containment check so a window on the far end of a wall
      // doesn't unduly light cells at the opposite end).
      let diffuseFromOpenings = 0;
      if (hasWindows) {
        for (let w = 0; w < windows.length; w++) {
          const win = windows[w];
          let spreadFactor;
          let orientationFactor = 1;

          if (kindOf(win) === 'skylight') {
            const trans = windowTransmission(win);
            const skyCx = (win.xMin + win.xMax) / 2;
            const skyCz = (win.zMin + win.zMax) / 2;
            const hdx = cx - skyCx;
            const hdz = cz - skyCz;
            const horizDist = Math.sqrt(hdx * hdx + hdz * hdz);
            const depthFrac = Math.min(1, horizDist / refDepth);
            spreadFactor = 0.46 * Math.exp(-depthFrac * 1.1) * trans;
          } else {
            const trans = windowTransmission(win);
            let depth, along, alongMax;
            if (win.wall === 'S')      { depth = cz;       along = cx; alongMax = W; }
            else if (win.wall === 'N') { depth = D - cz;   along = cx; alongMax = W; }
            else if (win.wall === 'E') { depth = W - cx;   along = cz; alongMax = D; }
            else                       { depth = cx;       along = cz; alongMax = D; }
            const alongClamp = Math.max(win.min, Math.min(win.max, along));
            const alongDist = Math.abs(along - alongClamp) / alongMax;
            const depthFrac = Math.min(1, depth / refDepth);
            spreadFactor = 0.30 * Math.exp(-(depthFrac * 2.1 + alongDist * 1.2)) * trans;
            orientationFactor = wallSkyExposureFactor(win.wall, bearingDeg, azimuth, altitude);
          }

          const obstacleShade = obstacles.length ? 0.92 : 1;
          diffuseFromOpenings += spreadFactor * orientationFactor * obstacleShade;
        }
      }

      const skyIllum = hasWindows ? sinAlt * diffuseFromOpenings : 0;
      const skyDome  = hasWindows ? 0.05 + sinAlt * 0.06 : 0;

      const nightFloor = 0.012;
      const diffuse = nightFloor + (isAboveHorizon ? skyIllum + skyDome : 0);

      // ── 3. REFLECTED LIGHT ───────────────────────────────────────────────
      const avgReflectance = (WALL_REFLECTANCE + FLOOR_REFLECTANCE) / 2;
      const reflected = (direct + diffuse) * avgReflectance * 0.35;

      grid[i * gridSize + j] = direct + diffuse + reflected;
    }
  }

  return grid;
}

// ─── Wall + ceiling grids ─────────────────────────────────────────────────────
//
// For each non-floor surface we compute a square illumination
// grid using the same back-trace approach as the floor:
//   • direct — back-trace ray from cell toward sun, check if it exits the
//              room through a window opening before hitting an opaque wall.
//   • diffuse — analytic window/skylight view-factor estimate.
//
// Surface local 2D axes (matches the mesh UV conventions used in RoomView3D):
//   South wall  (Z = 0)       : u = X (east),  v = Y (up)
//   North wall  (Z = D)       : u = X (east),  v = Y (up)
//   East wall   (X = W)       : u = Z (north), v = Y (up)
//   West wall   (X = 0)       : u = Z (north), v = Y (up)
//   Ceiling     (Y = H)       : u = X (east),  v = Z (north)
//
// Each grid is indexed as grid[iu * gridSize + iv].

// Room half-size along each axis, for the exit-point search.
const EPS = 1e-6;

/**
 * Ray-box exit for a ray starting strictly INSIDE the room box.
 * Returns {wall, x, y, z, t} where `wall` is one of
 *   'S' | 'N' | 'E' | 'W' | 'ceiling' | 'floor'
 * and (x, y, z) is the first exit point.  If the ray is pathological
 * (all direction components near zero), returns null.
 */
function rayExit(cx, cy, cz, dx, dy, dz, W, D, H) {
  let tMin = Infinity;
  let wall = null;

  if (dx >  EPS) { const t = (W - cx) / dx; if (t > EPS && t < tMin) { tMin = t; wall = 'E'; } }
  else if (dx < -EPS) { const t = -cx / dx;  if (t > EPS && t < tMin) { tMin = t; wall = 'W'; } }

  if (dy >  EPS) { const t = (H - cy) / dy; if (t > EPS && t < tMin) { tMin = t; wall = 'ceiling'; } }
  else if (dy < -EPS) { const t = -cy / dy;  if (t > EPS && t < tMin) { tMin = t; wall = 'floor'; } }

  if (dz >  EPS) { const t = (D - cz) / dz; if (t > EPS && t < tMin) { tMin = t; wall = 'N'; } }
  else if (dz < -EPS) { const t = -cz / dz;  if (t > EPS && t < tMin) { tMin = t; wall = 'S'; } }

  if (!wall) return null;
  return { wall, x: cx + tMin * dx, y: cy + tMin * dy, z: cz + tMin * dz, t: tMin };
}

function openingTransmission(wall, x, y, z, windows) {
  let best = 0;
  for (let k = 0; k < windows.length; k++) {
    const w = windows[k];
    let inOpening = false;
    if (kindOf(w) === 'skylight') {
      inOpening = wall === 'ceiling' &&
        x >= w.xMin && x <= w.xMax &&
        z >= w.zMin && z <= w.zMax;
    } else if (w.wall === wall) {
      if (wall === 'S' || wall === 'N') {
        inOpening = x >= w.min && x <= w.max && y >= w.yMin && y <= w.yMax;
      } else {
        inOpening = z >= w.min && z <= w.max && y >= w.yMin && y <= w.yMax;
      }
    }
    if (inOpening) best = Math.max(best, windowTransmission(w));
  }
  return best;
}

function openingDescriptor(win, W, D, H) {
  if (kindOf(win) === 'skylight') {
    return {
      cx: (win.xMin + win.xMax) / 2,
      cy: H,
      cz: (win.zMin + win.zMax) / 2,
      nx: 0,
      ny: -1,
      nz: 0,
      area: Math.max(0, win.xMax - win.xMin) * Math.max(0, win.zMax - win.zMin),
      orientation: 1,
    };
  }

  const mid = (win.min + win.max) / 2;
  const y = (win.yMin + win.yMax) / 2;
  const area = Math.max(0, win.max - win.min) * Math.max(0, win.yMax - win.yMin);
  if (win.wall === 'S') return { cx: mid, cy: y, cz: 0, nx: 0, ny: 0, nz: 1, area, orientation: null };
  if (win.wall === 'N') return { cx: mid, cy: y, cz: D, nx: 0, ny: 0, nz: -1, area, orientation: null };
  if (win.wall === 'E') return { cx: W, cy: y, cz: mid, nx: -1, ny: 0, nz: 0, area, orientation: null };
  return { cx: 0, cy: y, cz: mid, nx: 1, ny: 0, nz: 0, area, orientation: null };
}

function openingViewFactor(px, py, pz, surf, win, W, D, H, bearingDeg, azimuth, altitude) {
  const opening = openingDescriptor(win, W, D, H);
  if (opening.area <= 0) return 0;

  const vx = opening.cx - px;
  const vy = opening.cy - py;
  const vz = opening.cz - pz;
  const distSq = Math.max(0.04, vx * vx + vy * vy + vz * vz);
  const invDist = 1 / Math.sqrt(distSq);
  const ux = vx * invDist;
  const uy = vy * invDist;
  const uz = vz * invDist;

  const surfaceCos = Math.max(0, surf.nx * ux + surf.ny * uy + surf.nz * uz);
  if (surfaceCos <= 0) return 0;

  // The opening normal points inward, so the opening receives the point from
  // the opposite direction of the point-to-opening vector.
  const openingCos = Math.max(0, -(opening.nx * ux + opening.ny * uy + opening.nz * uz));
  if (openingCos <= 0) return 0;

  const solidAngle = opening.area * openingCos / distSq;
  const hemisphereFraction = Math.min(1, solidAngle / (2 * Math.PI));
  const trans = windowTransmission(win);
  const orientation = kindOf(win) === 'skylight'
    ? 1
    : wallSkyExposureFactor(win.wall, bearingDeg, azimuth, altitude);

  return hemisphereFraction * surfaceCos * trans * orientation;
}

function sameSurfaceOpeningGlow(surfaceName, px, py, pz, win, W, D, H, bearingDeg, azimuth, altitude) {
  if (surfaceName === 'ceiling') {
    if (kindOf(win) !== 'skylight') return 0;
    const x = Math.max(win.xMin, Math.min(win.xMax, px));
    const z = Math.max(win.zMin, Math.min(win.zMax, pz));
    const dx = px - x;
    const dz = pz - z;
    const width = Math.max(0, win.xMax - win.xMin);
    const depth = Math.max(0, win.zMax - win.zMin);
    const area = width * depth;
    if (area <= 0) return 0;
    const falloff = Math.exp(-(dx * dx + dz * dz) / Math.max(0.12, area * 0.6));
    return 0.035 * Math.sqrt(area) * falloff * windowTransmission(win);
  }

  if (kindOf(win) === 'skylight' || win.wall !== surfaceName) return 0;

  let along;
  if (surfaceName === 'S' || surfaceName === 'N') along = px;
  else along = pz;
  const u = Math.max(win.min, Math.min(win.max, along));
  const y = Math.max(win.yMin, Math.min(win.yMax, py));
  const du = along - u;
  const dyLocal = py - y;
  const area = Math.max(0, win.max - win.min) * Math.max(0, win.yMax - win.yMin);
  if (area <= 0) return 0;

  const falloff = Math.exp(-(du * du + dyLocal * dyLocal) / Math.max(0.12, area * 0.45));
  const orientation = wallSkyExposureFactor(win.wall, bearingDeg, azimuth, altitude);
  return 0.03 * Math.sqrt(area) * falloff * orientation * windowTransmission(win);
}

/**
 * Compute square illumination grids for the 4 walls + ceiling.
 * Returns { S, N, E, W, ceiling } each a Float32Array of length gridSize²,
 * absolute-scaled to [0, 1] using the same reference as the floor.
 */
export function computeWallGrids(sunPos, windows = [], dims = DEFAULT_DIMS, options = {}) {
  const { W, D, H } = dims;
  const bearingDeg = options.bearingDeg || 0;
  const obstacles = options.obstacles || [];
  const gridSize = options.gridSize || INSTANT_GRID_SIZE;
  const { altitude, azimuth, isAboveHorizon } = sunPos;

  // World-frame sun direction, then rotated into the room's local frame.
  // See computeGrid() for the derivation — this is what makes bearingDeg
  // actually change which wall the sun enters through.
  const sunDxWorld = -Math.sin(azimuth) * Math.cos(altitude);
  const sunDzWorld = -Math.cos(azimuth) * Math.cos(altitude);
  const bRad = bearingDeg * Math.PI / 180;
  const cosB = Math.cos(bRad);
  const sinB = Math.sin(bRad);
  const dx =  sunDxWorld * cosB - sunDzWorld * sinB;
  const dz =  sunDxWorld * sinB + sunDzWorld * cosB;
  const dy =  Math.sin(altitude);

  const hasWindows = windows.length > 0;

  // Surface descriptors: normals + local-coord → world-coord mapping.
  //   localToWorld(iu, iv) → [cx, cy, cz] of the cell centre, offset slightly
  //   inside the room so the ray starts strictly inside.
  const INSET = 1e-3;
  const surfaces = {
    S: {
      nx: 0, ny: 0, nz: 1,
      at: (iu, iv) => [ (iu + 0.5) * W / gridSize,
                        (iv + 0.5) * H / gridSize,
                        INSET ],
    },
    N: {
      nx: 0, ny: 0, nz: -1,
      at: (iu, iv) => [ (iu + 0.5) * W / gridSize,
                        (iv + 0.5) * H / gridSize,
                        D - INSET ],
    },
    E: {
      nx: -1, ny: 0, nz: 0,
      at: (iu, iv) => [ W - INSET,
                        (iv + 0.5) * H / gridSize,
                        (iu + 0.5) * D / gridSize ],
    },
    W: {
      nx: 1, ny: 0, nz: 0,
      at: (iu, iv) => [ INSET,
                        (iv + 0.5) * H / gridSize,
                        (iu + 0.5) * D / gridSize ],
    },
    ceiling: {
      nx: 0, ny: -1, nz: 0,
      at: (iu, iv) => [ (iu + 0.5) * W / gridSize,
                        H - INSET,
                        (iv + 0.5) * D / gridSize ],
    },
  };

  const out = {};
  for (const name of Object.keys(surfaces)) {
    const surf = surfaces[name];
    const grid = new Float32Array(gridSize * gridSize);
    // cos(θ) between the surface inward normal and the sun-direction vector.
    // Negative/zero means the sun is behind the surface (can't illuminate it).
    const nDotSun = surf.nx * dx + surf.ny * dy + surf.nz * dz;

    for (let iu = 0; iu < gridSize; iu++) {
      for (let iv = 0; iv < gridSize; iv++) {
        const [cx, cy, cz] = surf.at(iu, iv);

        // ── DIRECT ────────────────────────────────────────────────────────
        let direct = 0;
        if (isAboveHorizon && nDotSun > EPS) {
          const hit = rayExit(cx, cy, cz, dx, dy, dz, W, D, H);
          const trans = hit ? openingTransmission(hit.wall, hit.x, hit.y, hit.z, windows) : 0;
          if (trans > 0) {
            // Cos-weighted angle factor, plus a mild depth falloff based on
            // how far the ray had to travel across the room.
            const depthFactor = Math.exp(-hit.t * 0.18);
            const block = obstacleBlocksRay(cx, cy, cz, dx, dy, dz, hit.t, obstacles);
            direct = nDotSun * depthFactor * trans * (1 - block);
          }
        }

        // ── DIFFUSE ───────────────────────────────────────────────────────
        const sinAlt = isAboveHorizon ? Math.max(0, Math.sin(altitude)) : 0;
        let diffuse = 0.012; // night-floor
        if (hasWindows && isAboveHorizon) {
          let viewFactor = 0;
          for (let w = 0; w < windows.length; w++) {
            viewFactor += openingViewFactor(cx, cy, cz, surf, windows[w], W, D, H, bearingDeg, azimuth, altitude);
            viewFactor += sameSurfaceOpeningGlow(name, cx, cy, cz, windows[w], W, D, H, bearingDeg, azimuth, altitude);
          }
          const obstacleShade = obstacles.length ? 0.92 : 1;
          diffuse += sinAlt * WALL_VIEW_FACTOR_DIFFUSE_GAIN * Math.min(WALL_VIEW_FACTOR_MAX, viewFactor) * obstacleShade;
        }

        grid[iu * gridSize + iv] = Math.min(1, (direct + diffuse) / REFERENCE_INTENSITY_MAX);
      }
    }
    out[name] = grid;
  }

  return out;
}

// ─── Grid utilities ───────────────────────────────────────────────────────────

export function addGrids(a, b) {
  const out = new Float32Array(a.length);
  for (let k = 0; k < out.length; k++) out[k] = a[k] + b[k];
  return out;
}

export function normalizeGrid(grid) {
  let max = 0;
  for (let k = 0; k < grid.length; k++) if (grid[k] > max) max = grid[k];
  const out = new Float32Array(grid.length);
  if (max > 0) for (let k = 0; k < grid.length; k++) out[k] = grid[k] / max;
  return out;
}

export function emptyGrid(gridSize = INSTANT_GRID_SIZE) {
  return new Float32Array(gridSize * gridSize).fill(0.05); // dim base
}

// Peak-instant reference: raw intensity that maps to palette "1.0".
// Kept generous enough to handle skylights (whose direct term has no
// horizontal depth falloff), but low enough that normal wall-window scenes
// use the bright end of the palette rather than staying forever in amber.
export const REFERENCE_INTENSITY_MAX     = 1.7;
// Monthly-average reference: lower than the instant scale because averages
// are always much dimmer than any single moment. Chosen so that dim-month
// (winter, low-latitude-shaded) scenes still land in the visible palette
// range instead of collapsing into near-black, while bright summer months
// still have headroom at the cream-white end.
export const REFERENCE_AVG_INTENSITY_MAX = 0.85;

// ─── Window-to-dimensions clamping ───────────────────────────────────────────
//
// When the user shrinks a room below an existing window's extent, we clamp
// that window's coordinates to still fit inside the new bounds (while
// preserving its minimum size). For wall windows whose wall has vanished
// in one axis, we shrink proportionally rather than delete — the task spec
// asks us to "clip / clamp" rather than remove.
/**
 * Return a new windows array where each window has been clipped to fit
 * inside the given room dimensions. Pure function — does not mutate input.
 */
export function clampWindowsToDims(windows, dims) {
  const { W, D, H } = dims;
  return windows.map(w => clampOne(w, W, D, H)).filter(Boolean);
}

function clampOne(w, W, D, H) {
  if ((w.kind || 'wall') === 'skylight') {
    // Skylight lives in the ceiling plane X∈[0,W], Z∈[0,D].
    let xMin = Math.max(0, Math.min(W, w.xMin));
    let xMax = Math.max(0, Math.min(W, w.xMax));
    let zMin = Math.max(0, Math.min(D, w.zMin));
    let zMax = Math.max(0, Math.min(D, w.zMax));
    // Preserve min extent where possible.
    if (xMax - xMin < MIN_SKYLIGHT_SIZE) {
      if (W < MIN_SKYLIGHT_SIZE) { xMin = 0; xMax = W; }          // unavoidable
      else if (xMax + (MIN_SKYLIGHT_SIZE - (xMax - xMin)) <= W) xMax = xMin + MIN_SKYLIGHT_SIZE;
      else xMin = xMax - MIN_SKYLIGHT_SIZE;
    }
    if (zMax - zMin < MIN_SKYLIGHT_SIZE) {
      if (D < MIN_SKYLIGHT_SIZE) { zMin = 0; zMax = D; }
      else if (zMax + (MIN_SKYLIGHT_SIZE - (zMax - zMin)) <= D) zMax = zMin + MIN_SKYLIGHT_SIZE;
      else zMin = zMax - MIN_SKYLIGHT_SIZE;
    }
    return { ...w, xMin, xMax, zMin, zMax };
  }

  // Wall window: `min`/`max` are along-wall coords in [0, alongMax]
  // where alongMax = W for N/S walls, D for E/W walls.
  const alongMax = (w.wall === 'N' || w.wall === 'S') ? W : D;
  let min = Math.max(0, Math.min(alongMax, w.min));
  let max = Math.max(0, Math.min(alongMax, w.max));
  if (max - min < MIN_WINDOW_WIDTH) {
    if (alongMax < MIN_WINDOW_WIDTH) { min = 0; max = alongMax; }
    else if (max + (MIN_WINDOW_WIDTH - (max - min)) <= alongMax) max = min + MIN_WINDOW_WIDTH;
    else min = max - MIN_WINDOW_WIDTH;
  }

  // Vertical (yMin/yMax) must fit in [0, H] with a reasonable gap.
  let yMin = Math.max(0, Math.min(H, w.yMin));
  let yMax = Math.max(0, Math.min(H, w.yMax));
  const MIN_HEIGHT = 0.1;
  if (yMax - yMin < MIN_HEIGHT) {
    if (H < MIN_HEIGHT) { yMin = 0; yMax = H; }
    else if (yMax + (MIN_HEIGHT - (yMax - yMin)) <= H) yMax = yMin + MIN_HEIGHT;
    else yMin = yMax - MIN_HEIGHT;
  }
  return { ...w, min, max, yMin, yMax };
}
