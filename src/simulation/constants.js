// ─── Room geometry (meters) ───────────────────────────────────────────────────
// Coordinate convention (consistent throughout codebase):
//   X : East   (0 = west wall,  W = east wall)
//   Y : Up     (0 = floor,      H = ceiling)
//   Z : North  (0 = south wall, D = north wall)
//
// Wall lengths (W, D) and ceiling height (H) are now user-adjustable at
// runtime — see useSimulation(). The constants below provide the initial
// defaults and the UI slider bounds.

export const DEFAULT_ROOM_W = 4.0;   // East–West
export const DEFAULT_ROOM_D = 4.0;   // South–North
export const DEFAULT_ROOM_H = 2.5;   // Floor–Ceiling

export const MIN_ROOM_W = 1.0;
export const MAX_ROOM_W = 20.0;
export const MIN_ROOM_D = 1.0;
export const MAX_ROOM_D = 20.0;
export const MIN_ROOM_H = 1.5;
export const MAX_ROOM_H = 8.0;

// ─── Window defaults ─────────────────────────────────────────────────────────
// Windows are user-placed at runtime (see useSimulation). Two variants:
//
//   Wall window:
//     {
//       id:   string,
//       kind: 'wall',
//       wall: 'N' | 'S' | 'E' | 'W',
//       min:  number,   // along-wall coord (metres); X for N/S, Z for E/W
//       max:  number,
//       yMin: number,   // bottom above floor (metres)
//       yMax: number,   // top above floor (metres)
//     }
//
//   Skylight (rectangle in the ceiling plane, Y = H):
//     {
//       id:   string,
//       kind: 'skylight',
//       xMin: number,  xMax: number,   // east–west extent (0..W)
//       zMin: number,  zMax: number,   // south–north extent (0..D)
//     }
export const DEFAULT_WIN_Y_MIN = 0.8;
export const DEFAULT_WIN_Y_MAX = 2.0;
export const MIN_WINDOW_WIDTH  = 0.3;   // smallest allowed wall-window along-wall size (m)
export const MIN_SKYLIGHT_SIZE = 0.3;   // smallest allowed skylight side (m)

// ─── Material reflectances ────────────────────────────────────────────────────
export const WALL_REFLECTANCE  = 0.7;
export const FLOOR_REFLECTANCE = 0.5;

// ─── Simulation grid ─────────────────────────────────────────────────────────
export const GRID_SIZE = 20;   // 20 × 20 cells (independent of room size)

// ─── Location ─────────────────────────────────────────────────────────────────
export const DEFAULT_LAT = 51.5074;   // London
export const DEFAULT_LON = -0.1278;
export const DEFAULT_LOCATION_LABEL = 'London';
export const DEFAULT_BEARING_DEG = 0;

export const CITY_PRESETS = [
  { id: 'london', label: 'London', lat: 51.5074, lon: -0.1278 },
  { id: 'new-york', label: 'New York', lat: 40.7128, lon: -74.0060 },
  { id: 'los-angeles', label: 'Los Angeles', lat: 34.0522, lon: -118.2437 },
  { id: 'sydney', label: 'Sydney', lat: -33.8688, lon: 151.2093 },
  { id: 'singapore', label: 'Singapore', lat: 1.3521, lon: 103.8198 },
];
