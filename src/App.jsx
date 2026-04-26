import Heatmap2D  from './components/Heatmap2D';
import RoomView3D from './components/RoomView3D';
import Controls   from './components/Controls';
import { useSimulation } from './hooks/useSimulation';
import './app.css';

// ── Section heading ────────────────────────────────────────────────────────────
function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: '#5a5a7a',
      marginBottom: 6,
    }}>
      {children}
    </div>
  );
}

// ── Main app ───────────────────────────────────────────────────────────────────
export default function App() {
  const sim = useSimulation();

  const bg      = '#0c0c18';
  const surface = '#12121f';
  const border  = '#22223a';

  const card = {
    background: surface,
    border:     `1px solid ${border}`,
    borderRadius: 8,
    padding:    14,
  };

  return (
    <div style={{
      minHeight: '100dvh',
      background: bg,
      color:  '#e0e0f0',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      gap: 0,
    }}>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header style={{
        padding: '10px 16px',
        borderBottom: `1px solid ${border}`,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}>
        <span style={{ fontSize: 20 }}>🌤</span>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.02em' }}>
            Indoor Light Simulator
          </div>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <div className="app-body">

        {/* ── 2D heatmap ───────────────────────────────────────────────────── */}
        <div style={card}>
          <SectionLabel>Floor heatmap (top-down)</SectionLabel>
          <Heatmap2D
            grid={sim.grid}
            windows={sim.windows}
            onAddWindow={sim.addWindow}
            onUpdateWindow={sim.updateWindow}
            onRemoveWindow={sim.removeWindow}
            obstacles={sim.obstacles}
            onAddObstacle={sim.addObstacle}
            onUpdateObstacle={sim.updateObstacle}
            onRemoveObstacle={sim.removeObstacle}
            bearingDeg={sim.bearingDeg}
            onBearingChange={sim.setBearingDeg}
            dims={sim.dims}
            onDimsChange={sim.setDims}
            onResetDims={sim.resetDims}
            sunPos={sim.sunPos}
            showGridLines
          />
          <div style={{
            marginTop: 8,
            fontSize: 10,
            color: '#5a5a7a',
            lineHeight: 1.5,
          }}>
            Drag along a wall edge to add a window, or drag inside the room
            to add a skylight. Drag the yellow N compass marker to rotate
            the room. Click a window to select, then drag to move or use
            handles to resize. Delete / Backspace removes.
          </div>
        </div>

        {/* ── 3D room view ─────────────────────────────────────────────────── */}
        <div className="room3d-panel" style={card}>
          <SectionLabel>Room (3D)</SectionLabel>
          <RoomView3D
            grid={sim.grid}
            wallGrids={sim.wallGrids}
            windows={sim.windows}
            obstacles={sim.obstacles}
            sunPos={sim.sunPos}
            cutaway={sim.cutaway}
            mode={sim.mode}
            date={sim.date}
            timeMinutes={sim.timeMinutes}
            month={sim.month}
            year={sim.year}
            lat={sim.site.lat}
            lon={sim.site.lon}
            bearingDeg={sim.bearingDeg}
            dims={sim.dims}
          />
          <div style={{
            marginTop: 8,
            fontSize: 10,
            color: '#5a5a7a',
            lineHeight: 1.5,
          }}>
            Drag to orbit, scroll to zoom. The floor shows the same heatmap
            as the 2D view; the arc traces the sun's path today.
          </div>
        </div>

        {/* ── Controls ─────────────────────────────────────────────────────── */}
        <div className="controls-panel" style={card}>
          <SectionLabel>Controls</SectionLabel>
          <Controls
            mode={sim.mode}           setMode={sim.setMode}
            date={sim.date}           setDate={sim.setDate}
            timeMinutes={sim.timeMinutes} setTimeMinutes={sim.setTimeMinutes}
            month={sim.month}         setMonth={sim.setMonth}
            year={sim.year}           setYear={sim.setYear}
            site={sim.site}           updateSite={sim.updateSite}
            setSitePreset={sim.setSitePreset}
            bearingDeg={sim.bearingDeg} setBearingDeg={sim.setBearingDeg}
            isPlaying={sim.isPlaying} setIsPlaying={sim.setIsPlaying}
            isLoading={sim.isLoading}
            cutaway={sim.cutaway}     setCutaway={sim.setCutaway}
          />
        </div>
      </div>
    </div>
  );
}
