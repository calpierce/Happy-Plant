/**
 * Time-integration helpers.
 * These aggregate many single-moment computeGrid() calls to produce
 * instant and monthly-average maps.
 *
 * Both public functions accept a `windows` array describing the current
 * user-placed window layout, and a `dims` = {W, D, H} room-dimensions
 * descriptor so the caller can change room size at runtime.
 */

import { getSunPosition, getDayTimeSamples, getMonthDays } from './solar.js';
import {
  computeGrid, addGrids,
  REFERENCE_INTENSITY_MAX, REFERENCE_AVG_INTENSITY_MAX,
} from './lightSim.js';
import {
  INSTANT_GRID_SIZE, MONTHLY_GRID_SIZE,
  DEFAULT_ROOM_W, DEFAULT_ROOM_D, DEFAULT_ROOM_H,
} from './constants.js';

const DEFAULT_DIMS = { W: DEFAULT_ROOM_W, D: DEFAULT_ROOM_D, H: DEFAULT_ROOM_H };

const SAMPLE_INTERVAL_MINUTES = 20;  // ~3 samples/hour

function absoluteScale(grid, ref) {
  const out = new Float32Array(grid.length);
  for (let k = 0; k < grid.length; k++) {
    out[k] = Math.min(1, grid[k] / ref);
  }
  return out;
}

export function computeInstant(date, lat, lon, windows, dims = DEFAULT_DIMS, options = {}) {
  const sunPos = getSunPosition(date, lat, lon);
  const raw    = computeGrid(sunPos, windows, dims, { ...options, gridSize: INSTANT_GRID_SIZE });
  return absoluteScale(raw, REFERENCE_INTENSITY_MAX);
}

export function computeMonthlyGrid(year, month, lat, lon, windows, dims = DEFAULT_DIMS, options = {}) {
  const days = getMonthDays(year, month);
  let accumulated = new Float32Array(MONTHLY_GRID_SIZE * MONTHLY_GRID_SIZE);
  let n = 0;

  for (const day of days) {
    // Sample the full local-solar day at this longitude so every city uses
    // the same "its own midnight-to-midnight" window, independent of the
    // browser's timezone.
    const samples = getDayTimeSamples(day, SAMPLE_INTERVAL_MINUTES, lon);
    for (const t of samples) {
      const sunPos = getSunPosition(t, lat, lon);
      if (sunPos.isAboveHorizon) {
        accumulated = addGrids(accumulated, computeGrid(sunPos, windows, dims, { ...options, gridSize: MONTHLY_GRID_SIZE }));
        n++;
      }
    }
  }

  if (n > 0) for (let k = 0; k < accumulated.length; k++) accumulated[k] /= n;
  return absoluteScale(accumulated, REFERENCE_AVG_INTENSITY_MAX);
}
