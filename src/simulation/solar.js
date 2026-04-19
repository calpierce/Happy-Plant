import SunCalc from 'suncalc';

export function clampLatitude(lat) {
  return Math.max(-90, Math.min(90, lat));
}

export function normalizeLongitude(lon) {
  let out = lon;
  while (out > 180) out -= 360;
  while (out < -180) out += 360;
  return out;
}

export function normalizeBearing(bearingDeg) {
  let out = bearingDeg % 360;
  if (out < 0) out += 360;
  return out;
}

export function formatCoordinate(value, positive, negative) {
  return `${Math.abs(value).toFixed(1)}°${value >= 0 ? positive : negative}`;
}

export function formatLatLon(lat, lon) {
  return `${formatCoordinate(lat, 'N', 'S')}, ${formatCoordinate(lon, 'E', 'W')}`;
}

const WALL_BEARINGS = { N: 0, E: 90, S: 180, W: 270 };
const CARDINAL_LABELS = ['North', 'North-East', 'East', 'South-East', 'South', 'South-West', 'West', 'North-West'];

export function getWallWorldAzimuthDeg(wall, bearingDeg = 0) {
  return normalizeBearing((WALL_BEARINGS[wall] ?? 0) + bearingDeg);
}

export function bearingToCompassLabel(bearingDeg = 0) {
  const norm = normalizeBearing(bearingDeg);
  return CARDINAL_LABELS[Math.round(norm / 45) % CARDINAL_LABELS.length];
}

export function solarAzimuthToCompassDeg(azimuthRad) {
  return normalizeBearing(180 + (azimuthRad * 180 / Math.PI));
}

function angularDistanceDeg(a, b) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

export function wallSkyExposureFactor(wall, bearingDeg, sunAzimuthRad, altitudeRad) {
  const facingDeg = getWallWorldAzimuthDeg(wall, bearingDeg);
  const sunDeg = solarAzimuthToCompassDeg(sunAzimuthRad);
  const diffDeg = angularDistanceDeg(facingDeg, sunDeg);
  const facing = Math.max(0, Math.cos((diffDeg * Math.PI) / 180));
  const horizonLift = 0.45 + 0.55 * Math.max(0, Math.sin(Math.max(0, altitudeRad)));
  return 0.35 + facing * 0.65 * horizonLift;
}

/**
 * Get sun position for a given Date and location.
 *
 * SunCalc conventions:
 *   altitude – angle above the horizon in radians (negative when below)
 *   azimuth  – angle from SOUTH, clockwise toward WEST, in radians
 *              (0 = due south, π/2 = due west, −π/2 = due east)
 *
 * We re-export in the same convention.  The light simulation converts to
 * room coordinates internally.
 */
export function getSunPosition(date, lat, lon) {
  const pos = SunCalc.getPosition(date, lat, lon);
  return {
    altitude: pos.altitude,          // radians
    azimuth:  pos.azimuth,           // radians (south=0, west positive)
    isAboveHorizon: pos.altitude > 0.01,  // small epsilon to avoid grazing artifacts
  };
}

/**
 * Return an array of Date objects spanning one calendar day at `intervalMinutes`
 * spacing.
 *
 * If `lon` is provided, the samples span one day of mean solar local time at
 * that longitude — so that "midnight to midnight" on the sun-path arc reflects
 * the chosen location's day, not the browser's timezone. If `lon` is omitted,
 * the samples are in the browser's local time (legacy behaviour).
 */
export function getDayTimeSamples(date, intervalMinutes = 20, lon = null) {
  const samples = [];
  const step  = intervalMinutes * 60 * 1000;
  if (lon == null) {
    // Legacy: browser-local day
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
    const end   = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59);
    for (let t = start.getTime(); t <= end.getTime(); t += step) samples.push(new Date(t));
    return samples;
  }
  // Longitude-based: treat the given date as "the local day at lon".
  const startMs = localTimeAtLonToUTC(date.getFullYear(), date.getMonth(), date.getDate(), 0,  0,  lon);
  const endMs   = localTimeAtLonToUTC(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, lon);
  for (let t = startMs; t <= endMs; t += step) samples.push(new Date(t));
  return samples;
}

/**
 * Convert "local solar time at longitude `lon`" (year/month/day/hour/minute)
 * to a UTC timestamp (ms).  Uses mean solar time: 4 minutes per degree of
 * longitude east of the prime meridian.  month is 0-indexed (JS convention).
 *
 * This gives accurate sun positions relative to the user's slider without
 * needing a full IANA-timezone database.  The error vs. official civil time
 * is whatever the equation of time + DST + civil-timezone-offset adds up to —
 * generally well under 30 minutes for our purposes.
 */
export function localTimeAtLonToUTC(year, month, day, hour, minute, lon) {
  const baseUTC = Date.UTC(year, month, day, hour, minute, 0);
  const tzOffsetMs = (lon / 15) * 3600 * 1000; // hours east of UTC → ms
  return baseUTC - tzOffsetMs;
}

/**
 * Inverse of localTimeAtLonToUTC — given a UTC Date and a longitude, return
 * the corresponding local-solar {hour, minute} at that longitude.
 */
export function utcToLocalTimeAtLon(date, lon) {
  const shifted = new Date(date.getTime() + (lon / 15) * 3600 * 1000);
  return {
    hour:   shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/**
 * Return an array of Date objects (noon local time) for every day in a given
 * year/month combination.  month is 1-indexed.
 */
export function getMonthDays(year, month) {
  const days = [];
  const d = new Date(year, month - 1, 1, 12, 0, 0);
  while (d.getMonth() === month - 1) {
    days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

/**
 * Format a Date to a readable time string (HH:MM).
 *
 * If `lon` is provided, format as mean solar local time at that longitude
 * (keeps sunrise/sunset consistent with the slider for any selected city).
 */
export function formatTime(date, lon = null) {
  if (lon == null) {
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  const { hour, minute } = utcToLocalTimeAtLon(date, lon);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Return sunrise and sunset times for a given date/location (as Date objects),
 * or null if there is no sunrise (polar night / midnight sun).
 */
export function getSunriseSunset(date, lat, lon) {
  const times = SunCalc.getTimes(date, lat, lon);
  return {
    sunrise: times.sunrise,
    sunset:  times.sunset,
  };
}
