/**
 * Controls panel – time slider, date / month picker, mode selector, play button,
 * and 3D-view options.
 * Designed to be compact and work on narrow mobile screens.
 */

import { useState, useRef, useEffect } from 'react';
import { format } from 'date-fns';
import { bearingToCompassLabel } from '../simulation/solar';
import { searchCities } from '../simulation/cities';

const MODE_LABELS = {
  instant: 'Instant',
  monthly: 'Monthly avg',
};

const MONTHS = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

export default function Controls({
  mode, setMode,
  date, setDate,
  timeMinutes, setTimeMinutes,
  month, setMonth,
  year, setYear,
  site, updateSite, setSitePreset, // setSitePreset kept for backwards-compat, not used
  bearingDeg, setBearingDeg,
  isPlaying, setIsPlaying,
  isLoading,
  cutaway, setCutaway,
}) {
  const labelStyle = {
    display: 'block',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: '#9090b8',
    marginBottom: 4,
  };

  const rowStyle = {
    marginBottom: 14,
  };

  const sliderStyle = {
    width: '100%',
    accentColor: '#f0c840',
    cursor: 'pointer',
  };

  const selectStyle = {
    background: '#1a1a2e',
    color: '#e0e0f0',
    border: '1px solid #3a3a5a',
    borderRadius: 5,
    padding: '5px 8px',
    fontSize: 13,
    cursor: 'pointer',
    width: '100%',
  };

  const btnBase = {
    padding: '6px 14px',
    borderRadius: 5,
    border: 'none',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.05em',
    transition: 'background 0.15s',
  };

  // Derived display values
  const displayHours   = Math.floor(timeMinutes / 60);
  const displayMinutes = timeMinutes % 60;
  const timeStr = `${String(displayHours).padStart(2,'0')}:${String(displayMinutes).padStart(2,'0')}`;

  const dateStr = format(date, 'dd MMM yyyy');
  const topWallFacing = bearingToCompassLabel(bearingDeg);
  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: 9 }, (_, i) => currentYear - 2 + i);

  return (
    <div style={{ color: '#e0e0f0', fontFamily: 'system-ui, sans-serif', fontSize: 13 }}>

      {/* ── Mode selector ─────────────────────────────────────────────────── */}
      <div style={rowStyle}>
        <span style={labelStyle}>Mode</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {Object.entries(MODE_LABELS).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              style={{
                ...btnBase,
                flex: 1,
                background: mode === key ? '#3a3a6a' : '#1a1a2e',
                color: mode === key ? '#f0c840' : '#9090b8',
                border: `1px solid ${mode === key ? '#6060a0' : '#3a3a5a'}`,
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Instant mode: date + time ──────────────────────────────────────── */}
      {mode === 'instant' && (
        <>
          <div style={rowStyle}>
            <span style={labelStyle}>Date — {dateStr}</span>
            <input
              type="date"
              value={format(date, 'yyyy-MM-dd')}
              onChange={e => {
                const d = new Date(e.target.value + 'T12:00:00');
                if (!isNaN(d)) setDate(d);
              }}
              style={selectStyle}
            />
          </div>

          <div style={rowStyle}>
            <span style={labelStyle}>Time — {timeStr}</span>
            <input
              type="range"
              min={0}
              max={1439}
              step={15}
              value={timeMinutes}
              onChange={e => setTimeMinutes(Number(e.target.value))}
              style={sliderStyle}
            />
          </div>

          {/* Play button */}
          <div style={{ ...rowStyle, display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={() => setIsPlaying(p => !p)}
              style={{
                ...btnBase,
                background: isPlaying ? '#5a2a2a' : '#2a3a2a',
                color:      isPlaying ? '#ff8080' : '#80e080',
                border:     `1px solid ${isPlaying ? '#8a4040' : '#406040'}`,
                minWidth: 80,
              }}
            >
              {isPlaying ? '⏸ Pause' : '▶ Play'}
            </button>
            <span style={{ color: '#707090', fontSize: 11 }}>
              Animate through the day
            </span>
          </div>
        </>
      )}

      {/* ── Monthly mode: year + month ─────────────────────────────────────── */}
      {mode === 'monthly' && (
        <>
          <div style={rowStyle}>
            <span style={labelStyle}>Month</span>
            <select value={month} onChange={e => setMonth(Number(e.target.value))} style={selectStyle}>
              {MONTHS.map((m, k) => (
                <option key={k} value={k + 1}>{m}</option>
              ))}
            </select>
          </div>
          <div style={rowStyle}>
            <span style={labelStyle}>Year</span>
            <select value={year} onChange={e => setYear(Number(e.target.value))} style={selectStyle}>
              {yearOptions.map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
        </>
      )}

      <div
        style={{
          ...rowStyle,
          padding: '10px 12px',
          background: '#14141f',
          borderRadius: 6,
          border: '1px solid #22223a',
        }}
      >
        <span style={{ ...labelStyle, marginBottom: 8 }}>Location</span>
        <LocationTypeahead site={site} updateSite={updateSite} selectStyle={selectStyle} />
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: '#c0c0e0' }}>
            Advanced lat/lon
          </summary>
          <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
            <label style={{ fontSize: 11, color: '#9090b8' }}>
              Latitude
              <input
                type="number"
                min={-90}
                max={90}
                step={0.1}
                value={site?.lat ?? 0}
                onChange={e => updateSite({
                  presetId: 'custom',
                  label: 'Custom',
                  lat: Number(e.target.value),
                })}
                style={{ ...selectStyle, marginTop: 4 }}
              />
            </label>
            <label style={{ fontSize: 11, color: '#9090b8' }}>
              Longitude
              <input
                type="number"
                min={-180}
                max={180}
                step={0.1}
                value={site?.lon ?? 0}
                onChange={e => updateSite({
                  presetId: 'custom',
                  label: 'Custom',
                  lon: Number(e.target.value),
                })}
                style={{ ...selectStyle, marginTop: 4 }}
              />
            </label>
          </div>
        </details>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>Room bearing</span>
        <div style={{ fontSize: 11, color: '#9090b8' }}>
          {Math.round(bearingDeg)}° · top wall faces {topWallFacing}
        </div>
        <div style={{ fontSize: 10, color: '#707090', marginTop: 4 }}>
          Click the room on the 2D model, then drag its rotation handle.
        </div>
      </div>

      {/* ── 3D view options ────────────────────────────────────────────────── */}
      <div style={rowStyle}>
        <span style={labelStyle}>3D view</span>
        <label style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 12, color: '#c0c0e0', cursor: 'pointer',
          userSelect: 'none',
        }}>
          <input
            type="checkbox"
            checked={!!cutaway}
            onChange={e => setCutaway && setCutaway(e.target.checked)}
            style={{ accentColor: '#f0c840', cursor: 'pointer' }}
          />
          Show room interior (hide walls facing camera)
        </label>
      </div>

      {/* ── Loading indicator ──────────────────────────────────────────────── */}
      {isLoading && (
        <div style={{
          marginTop: 10,
          padding: '6px 10px',
          background: '#1a1820',
          borderRadius: 5,
          border: '1px solid #3a3060',
          fontSize: 11,
          color: '#8070c0',
          textAlign: 'center',
        }}>
          ⟳ Computing…
        </div>
      )}
    </div>
  );
}

// ─── Location typeahead ──────────────────────────────────────────────────────
// A text input that shows filtered city suggestions as the user types.
// - Typing updates a local `query`.  Suggestions are computed via searchCities()
//   from the bundled CITIES list (~300 worldwide).
// - Selecting a suggestion writes { presetId: `city-<name>`, label, lat, lon }
//   back through updateSite — this is what the rest of the app consumes.
// - If the user leaves the input blurred without selecting anything, the query
//   snaps back to site.label so the input always reflects the active site.
function LocationTypeahead({ site, updateSite, selectStyle }) {
  const [query, setQuery] = useState(site?.label ?? '');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  // Keep the input in sync when site changes externally (e.g. advanced lat/lon edit).
  useEffect(() => {
    if (!document.activeElement || !wrapRef.current) {
      setQuery(site?.label ?? '');
      return;
    }
    const focusedInside = wrapRef.current.contains(document.activeElement);
    if (!focusedInside) {
      setQuery(site?.label ?? '');
    }
  }, [site?.label]);

  // Close the suggestion dropdown when the user clicks outside the wrapper.
  useEffect(() => {
    if (!open) return;
    function onDocDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
        setQuery(site?.label ?? '');
      }
    }
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open, site?.label]);

  const suggestions = query.trim() ? searchCities(query, 8) : [];

  function selectCity(c) {
    if (!c) return;
    const label = `${c.name}, ${c.country}`;
    updateSite({
      presetId: `city-${c.name.toLowerCase().replace(/\s+/g, '-')}`,
      label,
      lat: c.lat,
      lon: c.lon,
    });
    setQuery(label);
    setOpen(false);
    inputRef.current?.blur();
  }

  function onKeyDown(e) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true);
      return;
    }
    if (!suggestions.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(h => (h + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(h => (h - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectCity(suggestions[highlight]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery(site?.label ?? '');
      inputRef.current?.blur();
    }
  }

  const itemBase = {
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer',
    color: '#e0e0f0',
    borderBottom: '1px solid #22223a',
    display: 'flex',
    justifyContent: 'space-between',
    gap: 10,
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder="Type a city name…"
        onFocus={e => {
          setOpen(true);
          setHighlight(0);
          // Select-all on focus so typing replaces the current city name.
          e.target.select();
        }}
        onChange={e => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
        style={selectStyle}
        autoComplete="off"
        spellCheck="false"
      />
      {open && suggestions.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            background: '#1a1a2e',
            border: '1px solid #3a3a5a',
            borderRadius: 5,
            maxHeight: 260,
            overflowY: 'auto',
            zIndex: 50,
            boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
          }}
        >
          {suggestions.map((c, i) => (
            <div
              key={`${c.name}-${c.country}`}
              onMouseDown={e => {
                // Use mousedown so we fire before input blur.
                e.preventDefault();
                selectCity(c);
              }}
              onMouseEnter={() => setHighlight(i)}
              style={{
                ...itemBase,
                background: i === highlight ? '#2a2a45' : 'transparent',
                borderBottom: i === suggestions.length - 1
                  ? 'none'
                  : itemBase.borderBottom,
              }}
            >
              <span>{c.name}</span>
              <span style={{ color: '#7a7a9a', fontSize: 11 }}>{c.country}</span>
            </div>
          ))}
        </div>
      )}
      {open && query.trim() && suggestions.length === 0 && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            background: '#1a1a2e',
            border: '1px solid #3a3a5a',
            borderRadius: 5,
            padding: '6px 10px',
            fontSize: 11,
            color: '#7a7a9a',
            zIndex: 50,
          }}
        >
          No matching cities. Use advanced lat/lon below to enter a custom spot.
        </div>
      )}
    </div>
  );
}
