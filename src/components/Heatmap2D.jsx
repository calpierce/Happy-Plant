import { useEffect, useRef, useState } from 'react';
import { intensityToRGB } from '../simulation/lightSim';
import { normalizeBearing, bearingToCompassLabel } from '../simulation/solar';
import {
  GRID_SIZE,
  DEFAULT_ROOM_W, DEFAULT_ROOM_D, DEFAULT_ROOM_H,
  DEFAULT_WIN_Y_MIN, DEFAULT_WIN_Y_MAX,
  MIN_WINDOW_WIDTH, MIN_SKYLIGHT_SIZE,
} from '../simulation/constants';

/**
 * 2D top-down heatmap + interactive window / skylight editor.
 *
 * Interactions:
 *   - Drag along any wall edge  →  create a wall window
 *   - Drag inside the room      →  create a skylight (rectangle in ceiling)
 *   - Click a window/skylight   →  select it
 *   - Drag middle of a selected item → move
 *   - Drag an end handle (wall) / corner handle (skylight) → resize
 *   - Delete / Backspace        →  remove selected
 *   - Escape                    →  deselect
 *
 * `dims` prop = { W, D, H } — current room dimensions (metres). If not
 * provided, falls back to the module defaults so existing callers keep
 * working.
 */

const CANVAS_PX = 360;
const WALL_HIT_MARGIN = 18;
const HANDLE_SIZE_PX  = 10;
// Padding on each side of the canvas reserved for the rotating compass rose
// (N / S / E / W markers drawn around the room).  The room rect lives inside
// CANVAS_PX - 2*COMPASS_MARGIN.
const COMPASS_MARGIN  = 22;
const COMPASS_HIT_PX  = 16;  // hit radius around the draggable N marker

const kindOf = (w) => w.kind || 'wall';
const isSkylight = (w) => kindOf(w) === 'skylight';
const isHorizontalWall = (wall) => wall === 'N' || wall === 'S';

// ─── Geometry helpers ────────────────────────────────────────────────────────

function wallAt(x, y, W, H) {
  const nearLeft   = x < WALL_HIT_MARGIN;
  const nearRight  = x > W - WALL_HIT_MARGIN;
  const nearTop    = y < WALL_HIT_MARGIN;
  const nearBottom = y > H - WALL_HIT_MARGIN;

  const distances = [];
  if (nearBottom) distances.push(['S', H - y]);
  if (nearTop)    distances.push(['N', y]);
  if (nearLeft)   distances.push(['W', x]);
  if (nearRight)  distances.push(['E', W - x]);
  if (distances.length === 0) return null;
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][0];
}

function canvasToAlong(x, y, wall, W, H, roomW, roomD) {
  if (wall === 'S' || wall === 'N') {
    return Math.max(0, Math.min(roomW, (x / W) * roomW));
  }
  return Math.max(0, Math.min(roomD, ((H - y) / H) * roomD));
}

function canvasToRoomXZ(x, y, W, H, roomW, roomD) {
  return {
    X: Math.max(0, Math.min(roomW, (x / W) * roomW)),
    Z: Math.max(0, Math.min(roomD, ((H - y) / H) * roomD)),
  };
}

function wallWindowRect(win, W, H, roomW, roomD, thickness = 8) {
  if (win.wall === 'S') {
    const x1 = (win.min / roomW) * W;
    const x2 = (win.max / roomW) * W;
    return { x: x1, y: H - thickness, w: x2 - x1, h: thickness };
  }
  if (win.wall === 'N') {
    const x1 = (win.min / roomW) * W;
    const x2 = (win.max / roomW) * W;
    return { x: x1, y: 0, w: x2 - x1, h: thickness };
  }
  if (win.wall === 'E') {
    const y1 = ((roomD - win.max) / roomD) * H;
    const y2 = ((roomD - win.min) / roomD) * H;
    return { x: W - thickness, y: y1, w: thickness, h: y2 - y1 };
  }
  // 'W'
  const y1 = ((roomD - win.max) / roomD) * H;
  const y2 = ((roomD - win.min) / roomD) * H;
  return { x: 0, y: y1, w: thickness, h: y2 - y1 };
}

function skylightRect(win, W, H, roomW, roomD) {
  const x1 = (win.xMin / roomW) * W;
  const x2 = (win.xMax / roomW) * W;
  const y1 = ((roomD - win.zMax) / roomD) * H; // north end  → top
  const y2 = ((roomD - win.zMin) / roomD) * H; // south end  → bottom
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function hitTestWallWindow(win, x, y, W, H, roomW, roomD) {
  const r = wallWindowRect(win, W, H, roomW, roomD, 14); // generous hit zone
  if (x < r.x - 2 || x > r.x + r.w + 2 || y < r.y - 2 || y > r.y + r.h + 2) return null;
  if (isHorizontalWall(win.wall)) {
    if (x - r.x < HANDLE_SIZE_PX)           return 'start';
    if (r.x + r.w - x < HANDLE_SIZE_PX)     return 'end';
  } else {
    if (r.y + r.h - y < HANDLE_SIZE_PX)     return 'start';
    if (y - r.y < HANDLE_SIZE_PX)           return 'end';
  }
  return 'body';
}

// Returns 'body' | 'corner-00' | 'corner-10' | 'corner-01' | 'corner-11' | null
// where the two digits are [xEdge, zEdge] with 0 = min, 1 = max.
function hitTestSkylight(win, x, y, W, H, roomW, roomD) {
  const r = skylightRect(win, W, H, roomW, roomD);
  // Canvas coords of corners:  (Xmin, Zmin)=bottom-left,  (Xmax, Zmax)=top-right.
  const xLeftCanvas   = r.x;
  const xRightCanvas  = r.x + r.w;
  const yTopCanvas    = r.y;              // Zmax side
  const yBottomCanvas = r.y + r.h;        // Zmin side
  const corners = [
    ['corner-00', xLeftCanvas,  yBottomCanvas], // xMin, zMin
    ['corner-10', xRightCanvas, yBottomCanvas], // xMax, zMin
    ['corner-01', xLeftCanvas,  yTopCanvas],    // xMin, zMax
    ['corner-11', xRightCanvas, yTopCanvas],    // xMax, zMax
  ];
  for (const [name, cx, cy] of corners) {
    if (Math.hypot(x - cx, y - cy) <= HANDLE_SIZE_PX) return name;
  }
  if (x >= r.x - 2 && x <= r.x + r.w + 2 &&
      y >= r.y - 2 && y <= r.y + r.h + 2) return 'body';
  return null;
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function Heatmap2D({
  grid,
  windows = [],
  onAddWindow,
  onUpdateWindow,
  onRemoveWindow,
  showGridLines = true,
  bearingDeg = 0,
  onBearingChange,
  dims = { W: DEFAULT_ROOM_W, D: DEFAULT_ROOM_D, H: DEFAULT_ROOM_H },
}) {
  const { W: roomW, D: roomD, H: roomH } = dims;

  const canvasRef  = useRef(null);
  const wrapperRef = useRef(null);
  const [selectedId, setSelectedId] = useState(null);

  const interactionRef = useRef(null);
  const [, setDragTick] = useState(0);
  const bumpRender = () => setDragTick(t => t + 1);

  // The 2D canvas stays square in pixels, but we preserve the room's aspect
  // ratio by letterboxing: the longer dimension fills the drawable area, the
  // shorter dimension uses a fraction. The drawable area is inset by
  // COMPASS_MARGIN on every side to make room for the rotating compass rose.
  const drawableSize = CANVAS_PX - 2 * COMPASS_MARGIN;
  const roomLongest = Math.max(roomW, roomD);
  const pxW = (roomW / roomLongest) * drawableSize;
  const pxH = (roomD / roomLongest) * drawableSize;
  const pxOffsetX = (CANVAS_PX - pxW) / 2;
  const pxOffsetY = (CANVAS_PX - pxH) / 2;

  // Compass rose lives in canvas-absolute coords (not the translated room
  // frame).  It's centred on the canvas and sized so the N/S/E/W markers
  // always sit in the margin area between the room rect and the canvas edge.
  const compassCx = CANVAS_PX / 2;
  const compassCy = CANVAS_PX / 2;
  const compassR  = CANVAS_PX / 2 - 10;

  // Screen directions of the four compass markers given the current bearing.
  // Derivation: the room is always drawn with its N wall at the TOP of the
  // canvas, so screen-"up" corresponds to compass bearing = bearingDeg.
  // Therefore true compass-N is at screen angle -bearingDeg from "up", etc.
  const bRad = (bearingDeg * Math.PI) / 180;
  const sinB = Math.sin(bRad);
  const cosB = Math.cos(bRad);
  const compassMarkers = [
    { label: 'N', x: compassCx - compassR * sinB, y: compassCy - compassR * cosB },
    { label: 'E', x: compassCx + compassR * cosB, y: compassCy - compassR * sinB },
    { label: 'S', x: compassCx + compassR * sinB, y: compassCy + compassR * cosB },
    { label: 'W', x: compassCx - compassR * cosB, y: compassCy + compassR * sinB },
  ];

  // ── Canvas drawing ────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !grid) return;
    const ctx = canvas.getContext('2d');

    // Total canvas pixel box
    const CW = canvas.width;
    const CH = canvas.height;

    // Clear whole canvas
    ctx.clearRect(0, 0, CW, CH);

    // Work in a translated coord system so (0,0) is the room's top-left in canvas.
    ctx.save();
    ctx.translate(pxOffsetX, pxOffsetY);

    const cellW = pxW / GRID_SIZE;
    const cellH = pxH / GRID_SIZE;

    // Heatmap
    for (let i = 0; i < GRID_SIZE; i++) {
      for (let j = 0; j < GRID_SIZE; j++) {
        const val = grid[i * GRID_SIZE + j];
        const [r, g, b] = intensityToRGB(val);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        const screenY = (GRID_SIZE - 1 - j) * cellH;
        ctx.fillRect(i * cellW, screenY, cellW + 0.5, cellH + 0.5);
      }
    }

    // Grid overlay
    if (showGridLines) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth   = 0.5;
      for (let i = 0; i <= GRID_SIZE; i++) {
        ctx.beginPath(); ctx.moveTo(i * cellW, 0); ctx.lineTo(i * cellW, pxH); ctx.stroke();
      }
      for (let j = 0; j <= GRID_SIZE; j++) {
        ctx.beginPath(); ctx.moveTo(0, j * cellH); ctx.lineTo(pxW, j * cellH); ctx.stroke();
      }
    }

    // Wall frame
    ctx.strokeStyle = 'rgba(120,120,160,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, pxW - 1, pxH - 1);

    // ── Skylights first (underneath wall-window bars) ─────────────────────
    for (const win of windows) {
      if (!isSkylight(win)) continue;
      const isSel = win.id === selectedId;
      const r = skylightRect(win, pxW, pxH, roomW, roomD);

      ctx.fillStyle   = isSel ? 'rgba(255,220,120,0.30)' : 'rgba(140,210,255,0.22)';
      ctx.fillRect(r.x, r.y, r.w, r.h);

      // Dashed border to distinguish from heatmap cells
      ctx.save();
      ctx.setLineDash(isSel ? [6, 3] : [3, 3]);
      ctx.strokeStyle = isSel ? 'rgba(255,220,120,0.95)' : 'rgba(160,225,255,0.75)';
      ctx.lineWidth = isSel ? 1.5 : 1;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      ctx.restore();

      if (isSel) {
        // Corner handles
        ctx.fillStyle = '#fffbe8';
        ctx.strokeStyle = '#2a2a45';
        ctx.lineWidth = 1;
        const corners = [
          [r.x, r.y], [r.x + r.w, r.y],
          [r.x, r.y + r.h], [r.x + r.w, r.y + r.h],
        ];
        for (const [cx, cy] of corners) {
          ctx.beginPath();
          ctx.arc(cx, cy, 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    // ── Wall windows on top ───────────────────────────────────────────────
    for (const win of windows) {
      if (isSkylight(win)) continue;
      const isSel = win.id === selectedId;
      const r = wallWindowRect(win, pxW, pxH, roomW, roomD, 7);
      ctx.fillStyle = isSel ? 'rgba(255,220,120,0.95)' : 'rgba(140,210,255,0.85)';
      ctx.fillRect(r.x, r.y, r.w, r.h);

      if (isSel) {
        ctx.fillStyle = '#fffbe8';
        ctx.strokeStyle = '#2a2a45';
        ctx.lineWidth = 1;
        if (isHorizontalWall(win.wall)) {
          [r.x, r.x + r.w].forEach(px => {
            ctx.beginPath();
            ctx.arc(px, r.y + r.h / 2, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          });
        } else {
          [r.y, r.y + r.h].forEach(py => {
            ctx.beginPath();
            ctx.arc(r.x + r.w / 2, py, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          });
        }
      }
    }

    // ── Ghost previews while drawing ──────────────────────────────────────
    const ia = interactionRef.current;
    if (ia && ia.type === 'drawing-wall') {
      const ghost = {
        wall: ia.wall,
        min: Math.min(ia.startM, ia.currentM),
        max: Math.max(ia.startM, ia.currentM),
      };
      const r = wallWindowRect(ghost, pxW, pxH, roomW, roomD, 7);
      ctx.fillStyle = 'rgba(255,220,120,0.6)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    if (ia && ia.type === 'drawing-skylight') {
      const ghost = {
        xMin: Math.min(ia.startX, ia.currentX),
        xMax: Math.max(ia.startX, ia.currentX),
        zMin: Math.min(ia.startZ, ia.currentZ),
        zMax: Math.max(ia.startZ, ia.currentZ),
      };
      const r = skylightRect(ghost, pxW, pxH, roomW, roomD);
      ctx.fillStyle = 'rgba(255,220,120,0.35)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(255,220,120,0.9)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      ctx.restore();
    }

    // Empty-room hint
    if (windows.length === 0 && !ia) {
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.textAlign = 'center';
      ctx.fillText('Drag along a wall edge → window',      pxW / 2, pxH / 2 - 8);
      ctx.fillText('Drag inside the room → skylight',       pxW / 2, pxH / 2 + 8);
    }

    ctx.restore();

    // ── Rotating compass rose (in canvas-absolute coords) ─────────────────
    // Draws N / E / S / W letters in a circle around the room. The N marker
    // is emphasised and draggable — the others are visual reference.
    const isRotating = ia && ia.type === 'rotating';
    ctx.save();
    // Faint ring hint
    ctx.strokeStyle = 'rgba(120,120,160,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(compassCx, compassCy, compassR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const m of compassMarkers) {
      const isN = m.label === 'N';
      ctx.fillStyle = isN
        ? (isRotating ? '#ffe890' : '#ffd45a')
        : 'rgba(180,180,200,0.55)';
      if (isN) {
        ctx.beginPath();
        ctx.arc(m.x, m.y, 9, 0, Math.PI * 2);
        ctx.fillStyle = isRotating ? 'rgba(255,232,144,0.25)' : 'rgba(255,212,90,0.15)';
        ctx.fill();
        ctx.strokeStyle = isRotating ? '#ffe890' : '#ffd45a';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = isRotating ? '#ffe890' : '#ffd45a';
      }
      ctx.fillText(m.label, m.x, m.y);
    }
    ctx.restore();
  }, [grid, windows, selectedId, showGridLines, roomW, roomD, roomH, pxW, pxH, pxOffsetX, pxOffsetY, bearingDeg, compassMarkers]);

  // ── Mouse handlers ────────────────────────────────────────────────────────
  // Returns coords inside the ROOM rect (0..pxW, 0..pxH), accounting for
  // letterbox offsets.
  const getCanvasPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleX = canvasRef.current.width  / rect.width;
    const scaleY = canvasRef.current.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX - pxOffsetX,
      y: (e.clientY - rect.top)  * scaleY - pxOffsetY,
    };
  };

  // Canvas-absolute coords (no offset subtraction), for compass interactions.
  const getAbsPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleX = canvasRef.current.width  / rect.width;
    const scaleY = canvasRef.current.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top)  * scaleY,
    };
  };

  // Is the absolute point close enough to the N marker to start rotation?
  const isNearCompassN = (absX, absY) => {
    const n = compassMarkers[0];
    return Math.hypot(absX - n.x, absY - n.y) <= COMPASS_HIT_PX;
  };

  // Compute bearingDeg such that the given absolute point sits on the N
  // marker direction from the compass centre.
  const bearingFromAbsPoint = (absX, absY) => {
    const dx = absX - compassCx;
    const dy = absY - compassCy;
    if (Math.hypot(dx, dy) < 1) return bearingDeg;  // avoid NaN at centre
    const rad = Math.atan2(-dx, -dy);
    return normalizeBearing((rad * 180) / Math.PI);
  };

  // True if a point is inside (or very near) the current room rect.
  const inRoomRect = (x, y) => (
    x >= -2 && x <= pxW + 2 && y >= -2 && y <= pxH + 2
  );

  const hitTestAny = (win, x, y) =>
    isSkylight(win) ? hitTestSkylight(win, x, y, pxW, pxH, roomW, roomD)
                    : hitTestWallWindow(win, x, y, pxW, pxH, roomW, roomD);

  const onMouseDown = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Priority 0: compass-N rotation handle (sits OUTSIDE the room rect).
    const abs = getAbsPos(e);
    if (onBearingChange && isNearCompassN(abs.x, abs.y)) {
      interactionRef.current = { type: 'rotating' };
      setSelectedId(null);
      onBearingChange(bearingFromAbsPoint(abs.x, abs.y));
      bumpRender();
      return;
    }

    const { x, y } = getCanvasPos(e);
    if (!inRoomRect(x, y)) { setSelectedId(null); return; }

    // 1. Currently-selected item has priority.
    if (selectedId) {
      const sel = windows.find(w => w.id === selectedId);
      if (sel) {
        const hit = hitTestAny(sel, x, y);
        if (hit) {
          startInteraction(sel, hit, x, y);
          return;
        }
      }
    }

    // 2. Any other item (prefer wall windows over skylights since wall
    //    windows sit on top visually).
    const ordered = [...windows].sort((a, b) => {
      if (a.id === selectedId) return -1;
      if (b.id === selectedId) return 1;
      return Number(isSkylight(a)) - Number(isSkylight(b));
    });
    for (const win of ordered) {
      if (win.id === selectedId) continue;
      const hit = hitTestAny(win, x, y);
      if (hit) {
        setSelectedId(win.id);
        startInteraction(win, hit, x, y);
        return;
      }
    }

    // 3. Near a wall → draw wall window.
    const wall = wallAt(x, y, pxW, pxH);
    if (wall) {
      const alongM = canvasToAlong(x, y, wall, pxW, pxH, roomW, roomD);
      interactionRef.current = {
        type: 'drawing-wall',
        wall,
        startM: alongM,
        currentM: alongM,
      };
      setSelectedId(null);
      bumpRender();
      return;
    }

    // 4. Interior → draw skylight.
    const { X, Z } = canvasToRoomXZ(x, y, pxW, pxH, roomW, roomD);
    interactionRef.current = {
      type: 'drawing-skylight',
      startX: X, startZ: Z,
      currentX: X, currentZ: Z,
    };
    setSelectedId(null);
    bumpRender();
  };

  const startInteraction = (win, hit, x, y) => {
    if (isSkylight(win)) {
      const room = canvasToRoomXZ(x, y, pxW, pxH, roomW, roomD);
      interactionRef.current = {
        type: hit === 'body' ? 'skylight-moving' : `skylight-${hit}`,
        id: win.id,
        startMouseXZ: room,
        startWindow: { ...win },
      };
    } else {
      const startM = canvasToAlong(x, y, win.wall, pxW, pxH, roomW, roomD);
      interactionRef.current = {
        type: hit === 'body' ? 'wall-moving' : `wall-resize-${hit}`,
        wall: win.wall,
        id: win.id,
        startMouseAlong: startM,
        startWindow: { ...win },
      };
    }
  };

  const onMouseMove = (e) => {
    const ia = interactionRef.current;
    if (!ia) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (ia.type === 'rotating') {
      const abs = getAbsPos(e);
      if (onBearingChange) onBearingChange(bearingFromAbsPoint(abs.x, abs.y));
      bumpRender();
      return;
    }

    const { x, y } = getCanvasPos(e);

    if (ia.type === 'drawing-wall') {
      ia.currentM = canvasToAlong(x, y, ia.wall, pxW, pxH, roomW, roomD);
      bumpRender();
      return;
    }
    if (ia.type === 'drawing-skylight') {
      const { X, Z } = canvasToRoomXZ(x, y, pxW, pxH, roomW, roomD);
      ia.currentX = X; ia.currentZ = Z;
      bumpRender();
      return;
    }

    // Wall window move/resize
    if (ia.type.startsWith('wall-')) {
      const alongM = canvasToAlong(x, y, ia.wall, pxW, pxH, roomW, roomD);
      const deltaM = alongM - ia.startMouseAlong;
      const wallMax = isHorizontalWall(ia.wall) ? roomW : roomD;
      const orig = ia.startWindow;

      if (ia.type === 'wall-moving') {
        const width = orig.max - orig.min;
        let newMin = orig.min + deltaM;
        let newMax = orig.max + deltaM;
        if (newMin < 0)        { newMin = 0; newMax = width; }
        if (newMax > wallMax)  { newMax = wallMax; newMin = wallMax - width; }
        onUpdateWindow(ia.id, { min: newMin, max: newMax });
      } else if (ia.type === 'wall-resize-start') {
        const newMin = Math.max(0, Math.min(orig.max - MIN_WINDOW_WIDTH, orig.min + deltaM));
        onUpdateWindow(ia.id, { min: newMin });
      } else if (ia.type === 'wall-resize-end') {
        const newMax = Math.min(wallMax, Math.max(orig.min + MIN_WINDOW_WIDTH, orig.max + deltaM));
        onUpdateWindow(ia.id, { max: newMax });
      }
      return;
    }

    // Skylight move/resize
    if (ia.type.startsWith('skylight-')) {
      const { X, Z } = canvasToRoomXZ(x, y, pxW, pxH, roomW, roomD);
      const dx = X - ia.startMouseXZ.X;
      const dz = Z - ia.startMouseXZ.Z;
      const orig = ia.startWindow;

      if (ia.type === 'skylight-moving') {
        const wRoom = orig.xMax - orig.xMin;
        const dRoom = orig.zMax - orig.zMin;
        let nxMin = orig.xMin + dx;
        let nxMax = orig.xMax + dx;
        let nzMin = orig.zMin + dz;
        let nzMax = orig.zMax + dz;
        if (nxMin < 0)       { nxMin = 0;       nxMax = wRoom; }
        if (nxMax > roomW)   { nxMax = roomW;   nxMin = roomW - wRoom; }
        if (nzMin < 0)       { nzMin = 0;       nzMax = dRoom; }
        if (nzMax > roomD)   { nzMax = roomD;   nzMin = roomD - dRoom; }
        onUpdateWindow(ia.id, { xMin: nxMin, xMax: nxMax, zMin: nzMin, zMax: nzMax });
      } else {
        // Corner resize: name is 'skylight-corner-XZ' where X,Z ∈ {0,1}
        const m = /^skylight-corner-(\d)(\d)$/.exec(ia.type);
        if (!m) return;
        const xIsMax = m[1] === '1';
        const zIsMax = m[2] === '1';
        const patch = {};
        if (xIsMax) {
          patch.xMax = Math.min(roomW,
            Math.max(orig.xMin + MIN_SKYLIGHT_SIZE, orig.xMax + dx));
        } else {
          patch.xMin = Math.max(0,
            Math.min(orig.xMax - MIN_SKYLIGHT_SIZE, orig.xMin + dx));
        }
        if (zIsMax) {
          patch.zMax = Math.min(roomD,
            Math.max(orig.zMin + MIN_SKYLIGHT_SIZE, orig.zMax + dz));
        } else {
          patch.zMin = Math.max(0,
            Math.min(orig.zMax - MIN_SKYLIGHT_SIZE, orig.zMin + dz));
        }
        onUpdateWindow(ia.id, patch);
      }
    }
  };

  const onMouseUp = () => {
    const ia = interactionRef.current;
    if (!ia) return;

    if (ia.type === 'drawing-wall') {
      const min = Math.min(ia.startM, ia.currentM);
      const max = Math.max(ia.startM, ia.currentM);
      if (max - min >= MIN_WINDOW_WIDTH) {
        const id = onAddWindow({
          kind: 'wall',
          wall: ia.wall,
          min, max,
          yMin: Math.min(DEFAULT_WIN_Y_MIN, Math.max(0, roomH - 0.5)),
          yMax: Math.min(DEFAULT_WIN_Y_MAX, roomH),
        });
        if (id) setSelectedId(id);
      }
    } else if (ia.type === 'drawing-skylight') {
      const xMin = Math.min(ia.startX, ia.currentX);
      const xMax = Math.max(ia.startX, ia.currentX);
      const zMin = Math.min(ia.startZ, ia.currentZ);
      const zMax = Math.max(ia.startZ, ia.currentZ);
      if (xMax - xMin >= MIN_SKYLIGHT_SIZE && zMax - zMin >= MIN_SKYLIGHT_SIZE) {
        const id = onAddWindow({
          kind: 'skylight',
          xMin, xMax, zMin, zMax,
        });
        if (id) setSelectedId(id);
      }
    }

    interactionRef.current = null;
    bumpRender();
  };

  // Keyboard: Delete/Backspace removes selected; Escape deselects.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        if (wrapperRef.current && wrapperRef.current.contains(document.activeElement)) {
          e.preventDefault();
          onRemoveWindow(selectedId);
          setSelectedId(null);
        }
      } else if (e.key === 'Escape') {
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, onRemoveWindow]);

  // ── Cursor styling ────────────────────────────────────────────────────────
  const [cursor, setCursor] = useState('crosshair');
  const onHoverMove = (e) => {
    if (interactionRef.current) {
      if (interactionRef.current.type === 'rotating') setCursor('grabbing');
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Compass-N hover check (uses absolute canvas coords)
    if (onBearingChange) {
      const abs = getAbsPos(e);
      if (isNearCompassN(abs.x, abs.y)) { setCursor('grab'); return; }
    }
    const { x, y } = getCanvasPos(e);
    if (!inRoomRect(x, y)) { setCursor('default'); return; }
    // Hover over an existing item?
    for (const w of windows) {
      const hit = hitTestAny(w, x, y);
      if (!hit) continue;
      if (hit === 'body') return setCursor('move');
      if (isSkylight(w)) {
        // Diagonal resize cursors based on which corner.
        if (hit === 'corner-00' || hit === 'corner-11') return setCursor('nwse-resize');
        if (hit === 'corner-01' || hit === 'corner-10') return setCursor('nesw-resize');
      } else {
        return setCursor(isHorizontalWall(w.wall) ? 'ew-resize' : 'ns-resize');
      }
    }
    // Default: crosshair everywhere (you can either drag a wall or a skylight).
    setCursor('crosshair');
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const selected = selectedId ? windows.find(w => w.id === selectedId) : null;

  return (
    <div
      ref={wrapperRef}
      tabIndex={0}
      style={{ position: 'relative', outline: 'none' }}
    >
      <canvas
        ref={canvasRef}
        width={CANVAS_PX}
        height={CANVAS_PX}
        onMouseDown={onMouseDown}
        onMouseMove={(e) => { onMouseMove(e); onHoverMove(e); }}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        style={{
          width: '100%',
          maxWidth: CANVAS_PX,
          display: 'block',
          borderRadius: 6,
          imageRendering: 'pixelated',
          cursor,
          userSelect: 'none',
          touchAction: 'none',
        }}
      />

      {selected && !isSkylight(selected) && (
        <WallWindowPanel
          win={selected}
          roomH={roomH}
          bearingDeg={bearingDeg}
          onChangeY={(yMin, yMax) => onUpdateWindow(selected.id, { yMin, yMax })}
          onRemove={() => { onRemoveWindow(selected.id); setSelectedId(null); }}
        />
      )}
      {selected && isSkylight(selected) && (
        <SkylightPanel
          win={selected}
          roomH={roomH}
          onRemove={() => { onRemoveWindow(selected.id); setSelectedId(null); }}
        />
      )}
    </div>
  );
}

// ─── Floating panels ─────────────────────────────────────────────────────────

function panelShell(children) {
  return (
    <div style={{
      position: 'absolute',
      top: 8,
      right: 8,
      background: 'rgba(18,18,31,0.95)',
      border: '1px solid #3a3a5a',
      borderRadius: 6,
      padding: 10,
      minWidth: 170,
      color: '#e0e0f0',
      fontFamily: 'system-ui, sans-serif',
      fontSize: 12,
      boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
    }}>
      {children}
    </div>
  );
}

function WallWindowPanel({ win, roomH, bearingDeg = 0, onChangeY, onRemove }) {
  // Room-local wall bearings (N=0, E=90, S=180, W=270) rotated by bearingDeg
  // give the wall's true compass bearing.
  const WALL_BEARING = { N: 0, E: 90, S: 180, W: 270 };
  const trueBearing = (WALL_BEARING[win.wall] + bearingDeg) % 360;
  const facingLabel = bearingToCompassLabel(trueBearing);
  const width = (win.max - win.min).toFixed(2);
  const slider = { width: '100%', accentColor: '#f0c840' };
  const label  = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#9090b8' };

  return panelShell(
    <>
      <div style={{ fontWeight: 700, letterSpacing: '0.04em', marginBottom: 6 }}>
        {facingLabel}-facing window
      </div>
      <div style={{ color: '#8080a8', fontSize: 11, marginBottom: 10 }}>
        Width: <b style={{ color: '#c0c0e0' }}>{width} m</b>
      </div>

      <div style={{ ...label, marginBottom: 4 }}>
        <span>Bottom</span>
        <b style={{ color: '#c0c0e0', marginLeft: 'auto' }}>{win.yMin.toFixed(2)} m</b>
      </div>
      <input
        type="range" min={0} max={roomH} step={0.05}
        value={win.yMin}
        onChange={e => {
          const v = Math.min(Number(e.target.value), win.yMax - 0.1);
          onChangeY(v, win.yMax);
        }}
        style={slider}
      />

      <div style={{ ...label, marginBottom: 4, marginTop: 8 }}>
        <span>Top</span>
        <b style={{ color: '#c0c0e0', marginLeft: 'auto' }}>{win.yMax.toFixed(2)} m</b>
      </div>
      <input
        type="range" min={0} max={roomH} step={0.05}
        value={win.yMax}
        onChange={e => {
          const v = Math.max(Number(e.target.value), win.yMin + 0.1);
          onChangeY(win.yMin, v);
        }}
        style={slider}
      />

      <RemoveButton onClick={onRemove} />
    </>
  );
}

function SkylightPanel({ win, roomH, onRemove }) {
  const xSize = (win.xMax - win.xMin).toFixed(2);
  const zSize = (win.zMax - win.zMin).toFixed(2);
  const area  = ((win.xMax - win.xMin) * (win.zMax - win.zMin)).toFixed(2);

  return panelShell(
    <>
      <div style={{ fontWeight: 700, letterSpacing: '0.04em', marginBottom: 6 }}>
        Skylight
      </div>
      <div style={{ color: '#8080a8', fontSize: 11, lineHeight: 1.6 }}>
        Size:&nbsp;<b style={{ color: '#c0c0e0' }}>{xSize} × {zSize} m</b><br />
        Area:&nbsp;<b style={{ color: '#c0c0e0' }}>{area} m²</b><br />
        In ceiling (Y = {roomH.toFixed(2)} m)
      </div>
      <RemoveButton onClick={onRemove} />
    </>
  );
}

function RemoveButton({ onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        marginTop: 12,
        width: '100%',
        padding: '6px 10px',
        background: '#5a2a2a',
        color: '#ffb0b0',
        border: '1px solid #8a4040',
        borderRadius: 5,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.05em',
        cursor: 'pointer',
      }}
    >
      REMOVE
    </button>
  );
}
