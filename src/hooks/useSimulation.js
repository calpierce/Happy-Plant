/**
 * Central simulation state hook.
 *
 * Responsibilities:
 *  - Holds all user-facing state (mode, date, time, month, year, play, windows, dims)
 *  - Triggers re-computation whenever inputs change
 *  - Manages play-mode interval
 *  - Exposes current grid and derived sun info strings
 *  - Exposes window CRUD helpers for the Heatmap2D component
 *  - Exposes room-dimensions helpers (dims + setDims)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getSunPosition, getSunriseSunset, formatTime,
  clampLatitude, normalizeLongitude, normalizeBearing,
  localTimeAtLonToUTC,
} from '../simulation/solar';
import { computeInstant, computeMonthlyGrid } from '../simulation/timeIntegration';
import { emptyGrid, computeWallGrids, clampWindowsToDims } from '../simulation/lightSim';
import {
  INSTANT_GRID_SIZE, CITY_PRESETS,
  DEFAULT_LAT, DEFAULT_LON,
  DEFAULT_LOCATION_LABEL, DEFAULT_BEARING_DEG,
  DEFAULT_ROOM_W, DEFAULT_ROOM_D, DEFAULT_ROOM_H,
  MIN_ROOM_W, MAX_ROOM_W,
  MIN_ROOM_D, MAX_ROOM_D,
  MIN_ROOM_H, MAX_ROOM_H,
} from '../simulation/constants';

const PLAY_STEP_MINUTES = 15;
const PLAY_INTERVAL_MS  = 80;

function todayNoon() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d;
}

// Build the UTC instant such that local solar time at `lon` reads the
// user-selected calendar day + `totalMinutes` on the time slider.  This keeps
// the simulation consistent regardless of the browser's own timezone.
function buildDateTime(date, totalMinutes, lon) {
  const ms = localTimeAtLonToUTC(
    date.getFullYear(), date.getMonth(), date.getDate(),
    Math.floor(totalMinutes / 60), totalMinutes % 60,
    lon,
  );
  return new Date(ms);
}

function radToDeg(r) { return (r * 180 / Math.PI).toFixed(1); }

function azimuthDescription(az) {
  const deg = ((az * 180 / Math.PI) + 360) % 360;
  const dirs = ['S','SSW','SW','WSW','W','WNW','NW','NNW','N','NNE','NE','ENE','E','ESE','SE','SSE'];
  return dirs[Math.round(deg / 22.5) % 16];
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

let _nextId = 1;
function newId() { return `w${_nextId++}`; }

export function useSimulation() {
  const [mode,        setMode]        = useState('instant');
  const [date,        setDate]        = useState(todayNoon);
  const [timeMinutes, setTimeMinutes] = useState(12 * 60);
  const [month,       setMonth]       = useState(new Date().getMonth() + 1);
  const [year,        setYear]        = useState(new Date().getFullYear());
  const [isPlaying,   setIsPlaying]   = useState(false);
  const [isLoading,   setIsLoading]   = useState(false);
  const [cutaway,     setCutaway]     = useState(true);
  const [site, setSite] = useState({
    presetId: CITY_PRESETS[0].id,
    label: DEFAULT_LOCATION_LABEL,
    lat: DEFAULT_LAT,
    lon: DEFAULT_LON,
  });
  const [bearingDeg, setBearingDegRaw] = useState(DEFAULT_BEARING_DEG);
  const [grid,        setGrid]        = useState(() => emptyGrid());
  const [sunPos,      setSunPos]      = useState(null);
  const [wallGrids,   setWallGrids]   = useState(() => ({
    S: new Float32Array(INSTANT_GRID_SIZE * INSTANT_GRID_SIZE),
    N: new Float32Array(INSTANT_GRID_SIZE * INSTANT_GRID_SIZE),
    E: new Float32Array(INSTANT_GRID_SIZE * INSTANT_GRID_SIZE),
    W: new Float32Array(INSTANT_GRID_SIZE * INSTANT_GRID_SIZE),
    ceiling: new Float32Array(INSTANT_GRID_SIZE * INSTANT_GRID_SIZE),
  }));

  // ── Room dimensions ────────────────────────────────────────────────────────
  // W = east–west width, D = south–north depth, H = floor-to-ceiling height.
  const [dims, setDimsRaw] = useState({
    W: DEFAULT_ROOM_W,
    D: DEFAULT_ROOM_D,
    H: DEFAULT_ROOM_H,
  });

  // Empty room by default — user will click/drag on the heatmap to add windows.
  const [windows, setWindows] = useState([]);
  const [obstacles, setObstacles] = useState([]);

  const playRef = useRef(null);
  const lat = site.lat;
  const lon = site.lon;

  const updateSite = useCallback((patch) => {
    setSite(prev => {
      const next = { ...prev, ...patch };
      if (patch.lat != null && Number.isFinite(patch.lat)) next.lat = clampLatitude(patch.lat);
      if (patch.lon != null && Number.isFinite(patch.lon)) next.lon = normalizeLongitude(patch.lon);
      return next;
    });
  }, []);

  const setSitePreset = useCallback((presetId) => {
    const preset = CITY_PRESETS.find(city => city.id === presetId);
    if (!preset) return;
    setSite({
      presetId: preset.id,
      label: preset.label,
      lat: preset.lat,
      lon: preset.lon,
    });
  }, []);

  const setBearingDeg = useCallback((value) => {
    setBearingDegRaw(normalizeBearing(value));
  }, []);

  // ── Window CRUD ────────────────────────────────────────────────────────────
  const addWindow = useCallback((w) => {
    const id = newId();
    setWindows(ws => [...ws, { id, ...w }]);
    return id;
  }, []);

  const updateWindow = useCallback((id, patch) => {
    setWindows(ws => ws.map(w => w.id === id ? { ...w, ...patch } : w));
  }, []);

  const removeWindow = useCallback((id) => {
    setWindows(ws => ws.filter(w => w.id !== id));
  }, []);

  const clearWindows = useCallback(() => setWindows([]), []);

  const addObstacle = useCallback((obstacle) => {
    const id = newId();
    setObstacles(items => [...items, { id, ...obstacle }]);
    return id;
  }, []);

  const updateObstacle = useCallback((id, patch) => {
    setObstacles(items => items.map(item => item.id === id ? { ...item, ...patch } : item));
  }, []);

  const removeObstacle = useCallback((id) => {
    setObstacles(items => items.filter(item => item.id !== id));
  }, []);

  // ── Dimensions setters ─────────────────────────────────────────────────────
  // Update one axis at a time (common case: slider change) or several at once.
  // Clamps to bounds AND re-clips existing windows so they still fit.
  const setDims = useCallback((patch) => {
    setDimsRaw(prev => {
      const next = {
        W: clamp(patch.W ?? prev.W, MIN_ROOM_W, MAX_ROOM_W),
        D: clamp(patch.D ?? prev.D, MIN_ROOM_D, MAX_ROOM_D),
        H: clamp(patch.H ?? prev.H, MIN_ROOM_H, MAX_ROOM_H),
      };
      // If anything actually changed, re-clamp the current windows.
      if (next.W !== prev.W || next.D !== prev.D || next.H !== prev.H) {
        setWindows(ws => clampWindowsToDims(ws, next));
      }
      return next;
    });
  }, []);

  const resetDims = useCallback(() => {
    setDims({ W: DEFAULT_ROOM_W, D: DEFAULT_ROOM_D, H: DEFAULT_ROOM_H });
  }, [setDims]);

  // ── Play mode ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'instant') {
      setIsPlaying(false);
      return;
    }
    if (isPlaying) {
      playRef.current = setInterval(() => {
        setTimeMinutes(t => (t + PLAY_STEP_MINUTES) % 1440);
      }, PLAY_INTERVAL_MS);
    } else {
      clearInterval(playRef.current);
    }
    return () => clearInterval(playRef.current);
  }, [isPlaying, mode]);

  // ── Sun position ───────────────────────────────────────────────────────────
  // Always compute a representative sun position for the current view — this
  // drives the 3D scene's directional light even in monthly mode.
  useEffect(() => {
    const dt = mode === 'instant'
      ? buildDateTime(date, timeMinutes, lon)
      : new Date(localTimeAtLonToUTC(year, month - 1, 15, 12, 0, lon));  // mid-month, solar noon
    const sp = getSunPosition(dt, lat, lon);
    setSunPos(sp);

    // Wall + ceiling grids always track the current instant sun position —
    // even in monthly mode, the 3D view's directional light is instant.
    setWallGrids(computeWallGrids(sp, windows, dims, { bearingDeg, obstacles }));
  }, [mode, date, timeMinutes, month, year, windows, dims, lat, lon, bearingDeg, obstacles]);

  // ── Recompute grid on state changes ────────────────────────────────────────
  useEffect(() => {
    if (mode === 'instant') {
      const dt = buildDateTime(date, timeMinutes, lon);
      const g  = computeInstant(dt, lat, lon, windows, dims, { bearingDeg, obstacles });
      setGrid(g);

    } else if (mode === 'monthly') {
      setIsLoading(true);
      const ref = setTimeout(() => {
        const g = computeMonthlyGrid(year, month, lat, lon, windows, dims, { bearingDeg, obstacles });
        setGrid(g);
        setIsLoading(false);
      }, 20);
      return () => clearTimeout(ref);
    }
  }, [mode, date, timeMinutes, month, year, windows, dims, lat, lon, bearingDeg, obstacles]);

  // ── Derived sun info for display ───────────────────────────────────────────
  let sunInfo = null;
  if (mode === 'instant' && sunPos) {
    sunInfo = {
      isAboveHorizon: sunPos.isAboveHorizon,
      altitudeDeg:    radToDeg(sunPos.altitude),
      azimuthDesc:    azimuthDescription(sunPos.azimuth),
    };
  } else {
    const refDate = mode === 'monthly'
      ? new Date(localTimeAtLonToUTC(year, month - 1, 15, 12, 0, lon))
      : date;
    const { sunrise, sunset } = getSunriseSunset(refDate, lat, lon);
    sunInfo = {
      sunrise: isNaN(sunrise) ? '—' : formatTime(sunrise, lon),
      sunset:  isNaN(sunset)  ? '—' : formatTime(sunset, lon),
    };
  }

  return {
    mode, setMode,
    date, setDate,
    timeMinutes, setTimeMinutes,
    month, setMonth,
    year,  setYear,
    site,
    updateSite,
    setSitePreset,
    bearingDeg,
    setBearingDeg,
    isPlaying, setIsPlaying,
    isLoading,
    cutaway, setCutaway,
    grid,
    wallGrids,
    sunInfo,
    sunPos,
    // window API
    windows,
    addWindow,
    updateWindow,
    removeWindow,
    clearWindows,
    obstacles,
    addObstacle,
    updateObstacle,
    removeObstacle,
    // room-dimensions API
    dims,
    setDims,
    resetDims,
  };
}
