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
  GRID_SIZE,
  WALL_REFLECTANCE, FLOOR_REFLECTANCE,
  DEFAULT_ROOM_W, DEFAULT_ROOM_D, DEFAULT_ROOM_H,
  MIN_WINDOW_WIDTH, MIN_SKYLIGHT_SIZE,
} from './constants.js';
import { wallSkyExposureFactor } from './solar.js';

const DEFAULT_DIMS = { W: DEFAULT_ROOM_W, D: DEFAULT_ROOM_D, H: DEFAULT_ROOM_H };

// Treat a missing `kind` as a wall window so older/legacy entries keep working.
const kindOf = (w) => w.kind || 'wall';

// ─── Colour palette ───────────────────────────────────────────────────────────
// Warm-light palette: dark shadow → amber interior → bright sunlit → white
const PALETTE = [
  { at: 0.00, r:   5, g:   5, b:  15 },
  { at: 0.12, r:  18, g:  14, b:  45 },
  { at: 0.30, r:  55, g:  35, b:  18 },
  { at: 0.52, r: 170, g: 110, b:  35 },
  { at: 0.72, r: 235, g: 200, b:  90 },
  { at: 0.88, r: 252, g: 240, b: 165 },
  { at: 1.00, r: 255, g: 254, b: 235 },
];

// Perceptual gamma applied before palette lookup.
// Higher (→ 1.0) = more linear, keeps wide tonal range;
// lower (→ 0.5) = lifts dim cells aggressively, which in monthly-average
// mode collapses most cells into the warm-white end of the palette.
// 0.8 keeps shadows visible without washing everything out to cream.
const DISPLAY_GAMMA = 0.8;

export function intensityToRGB(t) {
  const clamp = Math.max(0, Math.min(1, t));
  const adjusted = Math.pow(clamp, DISPLAY_GAMMA);
  let i0 = 0;
  for (let k = 0; k < PALETTE.length - 2; k++) {
    if (adjusted >= PALETTE[k].at) i0 = k;
  }
  const s0 = PALETTE[i0], s1 = PALETTE[i0 + 1];
  const f = s1.at > s0.at ? (adjusted - s0.at) / (s1.at - s0.at) : 0;
  return [
    Math.round(s0.r + f * (s1.r - s0.r)),
    Math.round(s0.g + f * (s1.g - s0.g)),
    Math.round(s0.b + f * (s1.b - s0.b)),
  ];
}

// ─── Core simulation ──────────────────────────────────────────────────────────

/**
 * Compute a 20×20 grid of light intensities.
 *
 * @param {{ altitude: number, azimuth: number, isAboveHorizon: boolean }} sunPos
 * @param {Array} windows — wall windows and/or skylights
 * @param {{W:number, D:number, H:number}} dims — room dimensions (metres)
 * @returns {Float32Array} length 400, indexed as [i * GRID_SIZE + j]
 */
export function computeGrid(sunPos, windows = [], dims = DEFAULT_DIMS, options = {}) {
  const { W, D, H } = dims;
  const bearingDeg = options.bearingDeg || 0;
  const cellW = W / GRID_SIZE;
  const cellD = D / GRID_SIZE;
  // Reference "depth scale" for the diffuse-light view-factor heuristic.
  // Using the max of W/D keeps falloff behaviour consistent across aspect ratios.
  const refDepth = Math.max(W, D);

  const grid = new Float32Array(GRID_SIZE * GRID_SIZE);
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

  for (let i = 0; i < GRID_SIZE; i++) {
    for (let j = 0; j < GRID_SIZE; j++) {
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
            if (dy < 1e-6) continue;
            const t = H / dy;
            const hitX = cx + t * dx;
            const hitZ = cz + t * dz;
            if (hitX >= win.xMin && hitX <= win.xMax &&
                hitZ >= win.zMin && hitZ <= win.zMax) {
              direct += angleFactor;
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
            const depthFactor = Math.exp(-depth * 0.35);
            direct += angleFactor * depthFactor;
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
            const skyCx = (win.xMin + win.xMax) / 2;
            const skyCz = (win.zMin + win.zMax) / 2;
            const hdx = cx - skyCx;
            const hdz = cz - skyCz;
            const horizDist = Math.sqrt(hdx * hdx + hdz * hdz);
            const depthFrac = Math.min(1, horizDist / refDepth);
            spreadFactor = 0.46 * Math.exp(-depthFrac * 1.1);
          } else {
            let depth, along, alongMax;
            if (win.wall === 'S')      { depth = cz;       along = cx; alongMax = W; }
            else if (win.wall === 'N') { depth = D - cz;   along = cx; alongMax = W; }
            else if (win.wall === 'E') { depth = W - cx;   along = cz; alongMax = D; }
            else                       { depth = cx;       along = cz; alongMax = D; }
            const alongClamp = Math.max(win.min, Math.min(win.max, along));
            const alongDist = Math.abs(along - alongClamp) / alongMax;
            const depthFrac = Math.min(1, depth / refDepth);
            spreadFactor = 0.30 * Math.exp(-(depthFrac * 2.1 + alongDist * 1.2));
            orientationFactor = wallSkyExposureFactor(win.wall, bearingDeg, azimuth, altitude);
          }

          diffuseFromOpenings += spreadFactor * orientationFactor;
        }
      }

      const skyIllum = hasWindows ? sinAlt * diffuseFromOpenings : 0;
      const skyDome  = hasWindows ? 0.05 + sinAlt * 0.06 : 0;

      const nightFloor = 0.012;
      const diffuse = nightFloor + (isAboveHorizon ? skyIllum + skyDome : 0);

      // ── 3. REFLECTED LIGHT ───────────────────────────────────────────────
      const avgReflectance = (WALL_REFLECTANCE + FLOOR_REFLECTANCE) / 2;
      const reflected = (direct + diffuse) * avgReflectance * 0.35;

      grid[i * GRID_SIZE + j] = direct + diffuse + reflected;
    }
  }

  return grid;
}

// ─── Wall + ceiling grids ─────────────────────────────────────────────────────
//
// For each non-floor surface we compute a GRID_SIZE × GRID_SIZE illumination
// grid using the same back-trace approach as the floor:
//   • direct — back-trace ray from cell toward sun, check if it exits the
//              room through a window opening before hitting an opaque wall.
//   • diffuse — heuristic proximity to nearest window.
//   • (reflected intentionally omitted, per design choice).
//
// Surface local 2D axes (matches the mesh UV conventions used in RoomView3D):
//   South wall  (Z = 0)       : u = X (east),  v = Y (up)
//   North wall  (Z = D)       : u = X (east),  v = Y (up)
//   East wall   (X = W)       : u = Z (north), v = Y (up)
//   West wall   (X = 0)       : u = Z (north), v = Y (up)
//   Ceiling     (Y = H)       : u = X (east),  v = Z (north)
//
// Each grid is indexed as grid[iu * GRID_SIZE + iv].

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

/**
 * Does the 3D point (x, y, z) lie inside an opening on the given wall?
 */
function pointInOpening(wall, x, y, z, windows) {
  for (let k = 0; k < windows.length; k++) {
    const w = windows[k];
    if (kindOf(w) === 'skylight') {
      if (wall === 'ceiling' &&
          x >= w.xMin && x <= w.xMax &&
          z >= w.zMin && z <= w.zMax) return true;
      continue;
    }
    // wall window
    if (w.wall !== wall) continue;
    if (wall === 'S' || wall === 'N') {
      if (x >= w.min && x <= w.max && y >= w.yMin && y <= w.yMax) return true;
    } else { // E or W
      if (z >= w.min && z <= w.max && y >= w.yMin && y <= w.yMax) return true;
    }
  }
  return false;
}

// Minimum 3D distance from a point to the *nearest* window (for diffuse falloff).
function nearestWindowDist(px, py, pz, windows, W, D, H) {
  let best = Infinity;
  for (let k = 0; k < windows.length; k++) {
    const w = windows[k];
    let wx, wy, wz;
    if (kindOf(w) === 'skylight') {
      wx = (w.xMin + w.xMax) / 2;
      wy = H;
      wz = (w.zMin + w.zMax) / 2;
    } else if (w.wall === 'S') { wx = (w.min + w.max) / 2; wy = (w.yMin + w.yMax) / 2; wz = 0; }
      else if (w.wall === 'N') { wx = (w.min + w.max) / 2; wy = (w.yMin + w.yMax) / 2; wz = D; }
      else if (w.wall === 'E') { wx = W; wy = (w.yMin + w.yMax) / 2; wz = (w.min + w.max) / 2; }
      else                     { wx = 0; wy = (w.yMin + w.yMax) / 2; wz = (w.min + w.max) / 2; }
    const dd = (px - wx) ** 2 + (py - wy) ** 2 + (pz - wz) ** 2;
    if (dd < best) best = dd;
  }
  return Math.sqrt(best);
}

/**
 * Compute GRID_SIZE × GRID_SIZE illumination grids for the 4 walls + ceiling.
 * Returns { S, N, E, W, ceiling } each a Float32Array of length GRID_SIZE²,
 * absolute-scaled to [0, 1] using the same reference as the floor.
 */
export function computeWallGrids(sunPos, windows = [], dims = DEFAULT_DIMS, options = {}) {
  const { W, D, H } = dims;
  const bearingDeg = options.bearingDeg || 0;
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

  const diagonal = Math.sqrt(W * W + H * H + D * D);
  const hasWindows = windows.length > 0;

  // Surface descriptors: normals + local-coord → world-coord mapping.
  //   localToWorld(iu, iv) → [cx, cy, cz] of the cell centre, offset slightly
  //   inside the room so the ray starts strictly inside.
  const INSET = 1e-3;
  const surfaces = {
    S: {
      nx: 0, ny: 0, nz: 1,
      at: (iu, iv) => [ (iu + 0.5) * W / GRID_SIZE,
                        (iv + 0.5) * H / GRID_SIZE,
                        INSET ],
    },
    N: {
      nx: 0, ny: 0, nz: -1,
      at: (iu, iv) => [ (iu + 0.5) * W / GRID_SIZE,
                        (iv + 0.5) * H / GRID_SIZE,
                        D - INSET ],
    },
    E: {
      nx: -1, ny: 0, nz: 0,
      at: (iu, iv) => [ W - INSET,
                        (iv + 0.5) * H / GRID_SIZE,
                        (iu + 0.5) * D / GRID_SIZE ],
    },
    W: {
      nx: 1, ny: 0, nz: 0,
      at: (iu, iv) => [ INSET,
                        (iv + 0.5) * H / GRID_SIZE,
                        (iu + 0.5) * D / GRID_SIZE ],
    },
    ceiling: {
      nx: 0, ny: -1, nz: 0,
      at: (iu, iv) => [ (iu + 0.5) * W / GRID_SIZE,
                        H - INSET,
                        (iv + 0.5) * D / GRID_SIZE ],
    },
  };

  const out = {};
  for (const name of Object.keys(surfaces)) {
    const surf = surfaces[name];
    const grid = new Float32Array(GRID_SIZE * GRID_SIZE);
    // cos(θ) between the surface inward normal and the sun-direction vector.
    // Negative/zero means the sun is behind the surface (can't illuminate it).
    const nDotSun = surf.nx * dx + surf.ny * dy + surf.nz * dz;

    for (let iu = 0; iu < GRID_SIZE; iu++) {
      for (let iv = 0; iv < GRID_SIZE; iv++) {
        const [cx, cy, cz] = surf.at(iu, iv);

        // ── DIRECT ────────────────────────────────────────────────────────
        let direct = 0;
        if (isAboveHorizon && nDotSun > EPS) {
          const hit = rayExit(cx, cy, cz, dx, dy, dz, W, D, H);
          if (hit && pointInOpening(hit.wall, hit.x, hit.y, hit.z, windows)) {
            // Cos-weighted angle factor, plus a mild depth falloff based on
            // how far the ray had to travel across the room.
            const depthFactor = Math.exp(-hit.t * 0.18);
            direct = nDotSun * depthFactor;
          }
        }

        // ── DIFFUSE ───────────────────────────────────────────────────────
        const sinAlt = isAboveHorizon ? Math.max(0, Math.sin(altitude)) : 0;
        let diffuse = 0.012; // night-floor
        if (hasWindows && isAboveHorizon) {
          const dist = nearestWindowDist(cx, cy, cz, windows, W, D, H);
          const frac = Math.min(1, dist / diagonal);
          // Cells very close to a window catch meaningful skylight; falls
          // off sharply with distance.  The surface-normal factor matters
          // less here (diffuse is omnidirectional-ish) but we still mute
          // back-facing surfaces a little.
          const facingBoost = 0.5 + 0.5 * Math.max(0, nDotSun);
          const orientationBoost = name === 'ceiling'
            ? 1
            : wallSkyExposureFactor(name, bearingDeg, azimuth, altitude);
          diffuse += sinAlt * 0.22 * Math.exp(-frac * 3.0) * facingBoost * orientationBoost;
        }

        grid[iu * GRID_SIZE + iv] = Math.min(1, (direct + diffuse) / REFERENCE_INTENSITY_MAX);
      }
    }
    out[name] = grid;
  }

  return out;
}

// ─── Grid utilities ───────────────────────────────────────────────────────────

export function addGrids(a, b) {
  const out = new Float32Array(GRID_SIZE * GRID_SIZE);
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

export function emptyGrid() {
  return new Float32Array(GRID_SIZE * GRID_SIZE).fill(0.05); // dim base
}

// Raised from 1.5 → 2.0 to give headroom for skylights, which have no
// horizontal depth falloff on their direct term and can push cells directly
// below well past the old wall-window peak.
export const REFERENCE_INTENSITY_MAX     = 2.0;
// Single shared scale used for ALL monthly averages (so June ≠ January is
// visible as a real brightness difference). Chosen so peak summer noon-to-noon
// averages at mid-latitudes don't saturate to white, while winter months still
// show meaningful amber-range gradation rather than collapsing to the dark end.
export const REFERENCE_AVG_INTENSITY_MAX = 1.2;

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
