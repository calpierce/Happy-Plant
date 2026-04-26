import { useEffect, useRef, useState } from 'react';
import { OBSTACLE_TYPES, WINDOW_CONFIGS, intensityToRGB, makeFloorPalette } from '../simulation/lightSim';
import { normalizeBearing, bearingToCompassLabel } from '../simulation/solar';
import {
  DEFAULT_ROOM_W, DEFAULT_ROOM_D, DEFAULT_ROOM_H,
  DEFAULT_WIN_Y_MIN, DEFAULT_WIN_Y_MAX,
  MIN_WINDOW_WIDTH, MIN_SKYLIGHT_SIZE,
  MIN_ROOM_W, MAX_ROOM_W,
  MIN_ROOM_D, MAX_ROOM_D,
  MIN_ROOM_H, MAX_ROOM_H,
} from '../simulation/constants';

/**
 * 2D top-down heatmap + interactive window / skylight editor.
 *
 * Interactions:
 *   - Drag along any wall edge  →  create a wall window
 *   - Drag inside the room      →  create a skylight (rectangle in ceiling)
 *   - Click empty room space    →  show the room rotation handle
 *   - Drag room rotation handle →  rotate room bearing
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
// Padding on each side of the canvas reserved for the compass rose and room
// rotate handle. The drawable area (which holds the outdoor zone + the room
// rect) lives inside CANVAS_PX - 2*COMPASS_MARGIN.
const COMPASS_MARGIN  = 22;
const ROOM_ROTATE_HANDLE_OFFSET_PX = 40;
const ROOM_ROTATE_HIT_PX = 24;
const CLICK_DRAG_THRESHOLD_PX = 5;
const ROOM_ROTATION_IDLE_MS = 1100;
const PANEL_VISIBLE_MS = 300;
const PANEL_HOVER_VISIBLE_MS = 260;
const PANEL_FADE_MS = 95;
const ROOM_RESIZE_HIT_PX = 14;
// How much outdoor world-space we expose around the room, expressed as a
// fraction of the room's dimensions on each side. 0.5 means a 4 m room is
// surrounded by 2 m of placeable outdoor area on every side, so users can
// drop trees / hedges / fences a meaningful distance from the walls instead
// of being pinned to the immediate edge.
const OUTDOOR_BUFFER_RATIO = 0.5;

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

function canvasToWorldXZ(x, y, W, H, roomW, roomD) {
  return {
    X: (x / W) * roomW,
    Z: ((H - y) / H) * roomD,
  };
}

function obstacleToCanvas(obstacle, W, H, roomW, roomD) {
  return {
    x: (obstacle.x / roomW) * W,
    y: H - (obstacle.z / roomD) * H,
    r: ((obstacle.radius || 0.55) / Math.max(roomW, roomD)) * Math.max(W, H),
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

function roomResizeHit(x, y, W, H) {
  const hits = [
    ['NW', 0, 0],
    ['NE', W, 0],
    ['SW', 0, H],
    ['SE', W, H],
    ['N', W / 2, 0],
    ['E', W, H / 2],
    ['S', W / 2, H],
    ['W', 0, H / 2],
  ];
  for (const [name, hx, hy] of hits) {
    if (Math.hypot(x - hx, y - hy) <= ROOM_RESIZE_HIT_PX) return name;
  }
  return null;
}

function roomResizeCursor(hit) {
  if (hit === 'NW' || hit === 'SE') return 'nwse-resize';
  if (hit === 'NE' || hit === 'SW') return 'nesw-resize';
  if (hit === 'E' || hit === 'W') return 'ew-resize';
  if (hit === 'N' || hit === 'S') return 'ns-resize';
  return null;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function gridSizeFor(grid) {
  const size = Math.sqrt(grid?.length || 0);
  return Number.isInteger(size) && size > 0 ? size : 1;
}

function obstacleTypeFor(typeId) {
  return OBSTACLE_TYPES.find(type => type.id === typeId) || OBSTACLE_TYPES[0];
}

function windowConfigById(id) {
  return WINDOW_CONFIGS.find(c => c.id === id) || WINDOW_CONFIGS[0];
}

function drawWindowConfigPattern(ctx, r, configId, isSelected) {
  const config = windowConfigById(configId);
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();

  const baseAlpha = isSelected ? 0.95 : 0.82;
  if (config.id === 'clear') {
    ctx.fillStyle = `rgba(140,210,255,${baseAlpha})`;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(r.x + 2, r.y + r.h - 2);
    ctx.lineTo(r.x + r.w - 2, r.y + 2);
    ctx.stroke();
  } else if (config.id === 'low-e') {
    ctx.fillStyle = `rgba(90,150,220,${baseAlpha})`;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fillRect(r.x, r.y, Math.max(2, r.w * 0.28), r.h);
  } else if (config.id === 'frosted') {
    ctx.fillStyle = `rgba(210,222,220,${baseAlpha})`;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    const count = Math.max(8, Math.round((r.w + r.h) * 0.6));
    for (let i = 0; i < count; i++) {
      const x = r.x + ((i * 11) % Math.max(1, r.w));
      const y = r.y + ((i * 7) % Math.max(1, r.h));
      ctx.fillRect(x, y, 1.5, 1.5);
    }
  } else if (config.id === 'sheer-blinds') {
    ctx.fillStyle = `rgba(180,205,220,${baseAlpha})`;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = 'rgba(255,244,210,0.75)';
    ctx.lineWidth = 2;
    for (let y = r.y + 2; y < r.y + r.h; y += 5) {
      ctx.beginPath();
      ctx.moveTo(r.x, y);
      ctx.lineTo(r.x + r.w, y);
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = `rgba(160,132,88,${baseAlpha})`;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    for (let y = r.y; y < r.y + r.h; y += 5) {
      ctx.fillStyle = 'rgba(85,65,42,0.8)';
      ctx.fillRect(r.x, y, r.w, 2.5);
      ctx.fillStyle = 'rgba(230,205,160,0.45)';
      ctx.fillRect(r.x, y + 2.5, r.w, 1);
    }
  }

  ctx.restore();
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function Heatmap2D({
  grid,
  windows = [],
  onAddWindow,
  onUpdateWindow,
  onRemoveWindow,
  obstacles = [],
  onAddObstacle,
  onUpdateObstacle,
  onRemoveObstacle,
  showGridLines = true,
  bearingDeg = 0,
  onBearingChange,
  onDimsChange,
  onResetDims,
  dims = { W: DEFAULT_ROOM_W, D: DEFAULT_ROOM_D, H: DEFAULT_ROOM_H },
  sunPos = null,
}) {
  const { W: roomW, D: roomD, H: roomH } = dims;

  const canvasRef  = useRef(null);
  const wrapperRef = useRef(null);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedObstacleId, setSelectedObstacleId] = useState(null);
  const [roomSelected, setRoomSelected] = useState(false);
  const [panelVisible, setPanelVisible] = useState(false);
  const [obstacleType, setObstacleType] = useState('tree');

  const interactionRef = useRef(null);
  const panelHideTimerRef = useRef(null);
  const roomSelectionHideTimerRef = useRef(null);
  const panelPointerInsideRef = useRef(false);
  const [, setDragTick] = useState(0);
  const bumpRender = () => setDragTick(t => t + 1);

  const clearPanelTimer = () => {
    if (panelHideTimerRef.current) {
      clearTimeout(panelHideTimerRef.current);
      panelHideTimerRef.current = null;
    }
  };

  const revealPanel = (duration = PANEL_VISIBLE_MS) => {
    clearPanelTimer();
    setPanelVisible(true);
    if (duration > 0 && !panelPointerInsideRef.current) {
      panelHideTimerRef.current = setTimeout(() => {
        setPanelVisible(false);
        panelHideTimerRef.current = null;
      }, duration);
    }
  };

  const clearRoomSelectionTimer = () => {
    if (roomSelectionHideTimerRef.current) {
      clearTimeout(roomSelectionHideTimerRef.current);
      roomSelectionHideTimerRef.current = null;
    }
  };

  const showRoomRotation = () => {
    clearRoomSelectionTimer();
    setRoomSelected(true);
  };

  const hideRoomRotation = () => {
    clearRoomSelectionTimer();
    setRoomSelected(false);
  };

  const scheduleRoomRotationHide = () => {
    clearRoomSelectionTimer();
    roomSelectionHideTimerRef.current = setTimeout(() => {
      setRoomSelected(false);
      roomSelectionHideTimerRef.current = null;
    }, ROOM_ROTATION_IDLE_MS);
  };

  useEffect(() => {
    if (selectedId || selectedObstacleId) revealPanel();
    else {
      clearPanelTimer();
      setPanelVisible(false);
      panelPointerInsideRef.current = false;
    }
    return clearPanelTimer;
  }, [selectedId, selectedObstacleId]);

  useEffect(() => clearRoomSelectionTimer, []);

  // The 2D canvas stays square in pixels. Inside the drawable area
  // (CANVAS_PX - 2*COMPASS_MARGIN on a side) we letterbox the OUTDOOR area —
  // i.e. the room plus a buffer of OUTDOOR_BUFFER_RATIO * room-size on every
  // side — preserving its aspect ratio. The room itself is then centred
  // inside the outdoor area as a smaller rect, leaving real estate around
  // it where users can drop trees, hedges, fences, etc.
  //
  //   ┌── canvas ──────────────────────────────┐
  //   │  N E S W markers (compass rose)        │
  //   │   ┌── outdoor area ─────────────┐      │
  //   │   │ (placeable buffer)          │      │
  //   │   │   ┌── room rect ────┐       │      │
  //   │   │   │ heatmap, walls, │       │      │
  //   │   │   │ windows...      │       │      │
  //   │   │   └─────────────────┘       │      │
  //   │   └─────────────────────────────┘      │
  //   └────────────────────────────────────────┘
  const drawableSize = CANVAS_PX - 2 * COMPASS_MARGIN;
  // World extent of the outdoor area = room + buffer on each side.
  const worldW = roomW * (1 + 2 * OUTDOOR_BUFFER_RATIO);
  const worldD = roomD * (1 + 2 * OUTDOOR_BUFFER_RATIO);
  const worldLongest = Math.max(worldW, worldD);
  // Outdoor area in canvas pixels (letterboxed to preserve aspect ratio).
  const outW = (worldW / worldLongest) * drawableSize;
  const outH = (worldD / worldLongest) * drawableSize;
  const outOffsetX = (CANVAS_PX - outW) / 2;
  const outOffsetY = (CANVAS_PX - outH) / 2;
  // Room rect inside the outdoor area. Pixel-per-metre is uniform across the
  // outdoor area, so we can just scale the room dimensions by the same ratio.
  const pxPerM = outW / worldW;  // == outH / worldD by construction
  const pxW = roomW * pxPerM;
  const pxH = roomD * pxPerM;
  const roomInsetX = roomW * OUTDOOR_BUFFER_RATIO * pxPerM;
  const roomInsetY = roomD * OUTDOOR_BUFFER_RATIO * pxPerM;
  // pxOffsetX/Y is the canvas-absolute position of the ROOM rect's top-left.
  // (Kept under the same name so the rest of the file — getCanvasPos,
  // canvasToWorldXZ etc. — continues to work in room-relative coords.)
  const pxOffsetX = outOffsetX + roomInsetX;
  const pxOffsetY = outOffsetY + roomInsetY;

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

  const roomRotateHandle = {
    x: pxW / 2,
    y: -ROOM_ROTATE_HANDLE_OFFSET_PX,
  };

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
    const ia = interactionRef.current;

    // Work in a translated coord system so (0,0) is the room's top-left in canvas.
    ctx.save();
    ctx.translate(pxOffsetX, pxOffsetY);

    // Outdoor area background — a subtle, slightly-greenish "ground" tone
    // surrounding the room so the user can see where they can drop trees /
    // hedges / fences. Drawn first so the heatmap, walls, etc. paint on top.
    ctx.save();
    ctx.fillStyle = 'rgba(40,55,42,0.55)';
    ctx.fillRect(-roomInsetX, -roomInsetY, outW, outH);
    // Soft inner shadow at the room boundary to separate indoor/outdoor.
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(-roomInsetX + 0.5, -roomInsetY + 0.5, outW - 1, outH - 1);
    ctx.restore();

    const gridSize = gridSizeFor(grid);
    const cellW = pxW / gridSize;
    const cellH = pxH / gridSize;

    // Build a palette once per render, shifted by the sun's altitude
    // (warm at dawn/dusk, neutral near solar noon). When no sunPos is
    // available (e.g. first render), falls back to the default mid palette.
    const palette = makeFloorPalette(sunPos?.altitude);

    // Heatmap
    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        const val = grid[i * gridSize + j];
        const [r, g, b] = intensityToRGB(val, palette);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        const screenY = (gridSize - 1 - j) * cellH;
        ctx.fillRect(i * cellW, screenY, cellW + 0.5, cellH + 0.5);
      }
    }

    // Grid overlay
    if (showGridLines) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth   = 0.5;
      for (let i = 0; i <= gridSize; i++) {
        ctx.beginPath(); ctx.moveTo(i * cellW, 0); ctx.lineTo(i * cellW, pxH); ctx.stroke();
      }
      for (let j = 0; j <= gridSize; j++) {
        ctx.beginPath(); ctx.moveTo(0, j * cellH); ctx.lineTo(pxW, j * cellH); ctx.stroke();
      }
    }

    // Wall frame
    ctx.strokeStyle = roomSelected ? 'rgba(255,212,90,0.9)' : 'rgba(120,120,160,0.35)';
    ctx.lineWidth = roomSelected ? 1.5 : 1;
    ctx.strokeRect(0.5, 0.5, pxW - 1, pxH - 1);

    if (roomSelected && onBearingChange) {
      const isRotating = ia && ia.type === 'rotating-room';
      const hx = roomRotateHandle.x;
      const hy = roomRotateHandle.y;

      ctx.save();
      ctx.strokeStyle = isRotating ? '#ffe890' : 'rgba(255,212,90,0.82)';
      ctx.fillStyle = isRotating ? 'rgba(255,232,144,0.24)' : 'rgba(18,18,31,0.92)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(pxW / 2, 0);
      ctx.lineTo(hx, hy + 10);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(hx, hy, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.font = '700 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = isRotating ? '#ffe890' : '#ffd45a';
      ctx.fillText('↻', hx, hy - 0.5);

      ctx.font = '600 10px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,244,210,0.85)';
      ctx.fillText(`${Math.round(bearingDeg)}°`, hx, hy - 18);
      ctx.restore();
    }

    // Crop-style room resize handles: drag edges/corners to change W/D.
    if (onDimsChange) {
      const handle = 14;
      const edgeMid = [
        [pxW / 2, 0], [pxW, pxH / 2], [pxW / 2, pxH], [0, pxH / 2],
      ];
      ctx.save();
      ctx.strokeStyle = 'rgba(255,244,210,0.75)';
      ctx.fillStyle = 'rgba(18,18,31,0.8)';
      ctx.lineWidth = 2;
      const corners = [
        [0, 0, 1, 1], [pxW, 0, -1, 1], [pxW, pxH, -1, -1], [0, pxH, 1, -1],
      ];
      for (const [cx, cy, sx, sy] of corners) {
        ctx.beginPath();
        ctx.moveTo(cx, cy + sy * handle);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + sx * handle, cy);
        ctx.stroke();
      }
      for (const [cx, cy] of edgeMid) {
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    // ── Skylights first (underneath wall-window bars) ─────────────────────
    for (const win of windows) {
      if (!isSkylight(win)) continue;
      const isSel = win.id === selectedId;
      const r = skylightRect(win, pxW, pxH, roomW, roomD);

      drawWindowConfigPattern(ctx, r, win.config, isSel);
      ctx.fillStyle = isSel ? 'rgba(255,220,120,0.18)' : 'rgba(140,210,255,0.10)';
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
      drawWindowConfigPattern(ctx, r, win.config, isSel);
      if (isSel) {
        ctx.fillStyle = 'rgba(255,220,120,0.22)';
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }

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

    // ── Outdoor obstacles ────────────────────────────────────────────────
    for (const obstacle of obstacles) {
      const type = obstacleTypeFor(obstacle.type);
      const p = obstacleToCanvas(obstacle, pxW, pxH, roomW, roomD);
      const isSel = obstacle.id === selectedObstacleId;
      ctx.save();
      ctx.translate(p.x, p.y);
      if (type.id === 'tree') {
        ctx.fillStyle = isSel ? 'rgba(120,210,105,0.95)' : 'rgba(55,145,70,0.88)';
        ctx.beginPath();
        ctx.arc(0, 0, Math.max(8, p.r), 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(50,80,35,0.9)';
        ctx.beginPath();
        ctx.arc(0, 0, Math.max(2.5, p.r * 0.22), 0, Math.PI * 2);
        ctx.fill();
      } else if (type.id === 'hedge') {
        ctx.fillStyle = isSel ? 'rgba(125,205,90,0.95)' : 'rgba(70,145,55,0.88)';
        ctx.fillRect(-p.r * 1.3, -p.r * 0.55, p.r * 2.6, p.r * 1.1);
      } else if (type.id === 'fence') {
        ctx.strokeStyle = isSel ? 'rgba(230,205,160,0.95)' : 'rgba(170,135,95,0.9)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(-p.r * 1.4, 0);
        ctx.lineTo(p.r * 1.4, 0);
        ctx.stroke();
      } else {
        ctx.fillStyle = isSel ? 'rgba(170,155,135,0.95)' : 'rgba(120,105,90,0.9)';
        ctx.fillRect(-p.r, -p.r * 0.75, p.r * 2, p.r * 1.5);
      }
      if (isSel) {
        ctx.strokeStyle = '#fffbe8';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, Math.max(9, p.r + 3), 0, Math.PI * 2);
        ctx.stroke();
      }
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

    // ── Compass rose (in canvas-absolute coords) ──────────────────────────
    // Draws N / E / S / W letters around the room as passive orientation
    // reference. Rotation now happens from the selected room handle.
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
      ctx.fillStyle = isN ? '#ffd45a' : 'rgba(180,180,200,0.55)';
      if (isN) {
        ctx.beginPath();
        ctx.arc(m.x, m.y, 8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,212,90,0.12)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,212,90,0.7)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = '#ffd45a';
      }
      ctx.fillText(m.label, m.x, m.y);
    }
    ctx.restore();
  }, [grid, windows, obstacles, selectedId, selectedObstacleId, roomSelected, showGridLines, roomW, roomD, roomH, pxW, pxH, pxOffsetX, pxOffsetY, outW, outH, roomInsetX, roomInsetY, bearingDeg, compassMarkers, roomRotateHandle.x, roomRotateHandle.y, sunPos?.altitude, onDimsChange, onBearingChange]);

  // ── Pointer handlers ──────────────────────────────────────────────────────
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

  // Canvas-absolute coords (no offset subtraction).
  const getAbsPos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const scaleX = canvasRef.current.width  / rect.width;
    const scaleY = canvasRef.current.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top)  * scaleY,
    };
  };

  const isNearRoomRotateHandle = (x, y) => (
    roomSelected &&
    onBearingChange &&
    Math.hypot(x - roomRotateHandle.x, y - roomRotateHandle.y) <= ROOM_ROTATE_HIT_PX
  );

  const pointerMovedEnough = (startAbs, endAbs) => {
    if (!startAbs || !endAbs) return false;
    return Math.hypot(endAbs.x - startAbs.x, endAbs.y - startAbs.y) >= CLICK_DRAG_THRESHOLD_PX;
  };

  const angleFromRoomPoint = (x, y) => {
    const dx = x - pxW / 2;
    const dy = y - pxH / 2;
    if (Math.hypot(dx, dy) < 1) return null;  // avoid NaN at centre
    const rad = Math.atan2(-dx, -dy);
    return normalizeBearing((rad * 180) / Math.PI);
  };

  const signedAngleDelta = (startDeg, currentDeg) => (
    ((currentDeg - startDeg + 540) % 360) - 180
  );

  const addExternalObject = () => {
    if (!onAddObstacle) return;
    const type = OBSTACLE_TYPES.find(t => t.id === obstacleType) || OBSTACLE_TYPES[0];
    const id = onAddObstacle({
      type: type.id,
      x: clamp(roomW + roomW * OUTDOOR_BUFFER_RATIO * 0.5, worldMinX, worldMaxX),
      z: clamp(roomD / 2, worldMinZ, worldMaxZ),
      radius: type.radius,
      height: type.height,
    });
    setSelectedId(null);
    setSelectedObstacleId(id || null);
    hideRoomRotation();
    revealPanel();
    bumpRender();
  };

  // True if a point is inside (or very near) the current room rect.
  const inRoomRect = (x, y) => (
    x >= -2 && x <= pxW + 2 && y >= -2 && y <= pxH + 2
  );

  // True if a point is anywhere inside the outdoor area (the larger rect that
  // contains the room plus the OUTDOOR_BUFFER_RATIO buffer on every side).
  // Coords are in the room-relative frame returned by getCanvasPos, so the
  // outdoor area spans [-roomInsetX, pxW + roomInsetX] × [-roomInsetY, pxH + roomInsetY].
  const inOutdoorArea = (x, y) => (
    x >= -roomInsetX - 2 && x <= pxW + roomInsetX + 2 &&
    y >= -roomInsetY - 2 && y <= pxH + roomInsetY + 2
  );

  // World-coordinate bounds for placeable obstacles.
  const worldMinX = -roomW * OUTDOOR_BUFFER_RATIO;
  const worldMaxX =  roomW * (1 + OUTDOOR_BUFFER_RATIO);
  const worldMinZ = -roomD * OUTDOOR_BUFFER_RATIO;
  const worldMaxZ =  roomD * (1 + OUTDOOR_BUFFER_RATIO);

  const hitTestAny = (win, x, y) =>
    isSkylight(win) ? hitTestSkylight(win, x, y, pxW, pxH, roomW, roomD)
                    : hitTestWallWindow(win, x, y, pxW, pxH, roomW, roomD);

  const hitTestObstacle = (x, y) => {
    for (let k = obstacles.length - 1; k >= 0; k--) {
      const obstacle = obstacles[k];
      const p = obstacleToCanvas(obstacle, pxW, pxH, roomW, roomD);
      if (Math.hypot(x - p.x, y - p.y) <= Math.max(12, p.r + 4)) return obstacle;
    }
    return null;
  };

  const onPointerDown = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture?.(e.pointerId);

    const abs = getAbsPos(e);
    const { x, y } = getCanvasPos(e);

    // Priority 0: selected-room rotation handle.
    if (isNearRoomRotateHandle(x, y)) {
      const startAngle = angleFromRoomPoint(x, y);
      interactionRef.current = {
        type: 'rotating-room',
        startAngle: startAngle ?? 0,
        startBearing: bearingDeg,
      };
      setSelectedId(null);
      setSelectedObstacleId(null);
      showRoomRotation();
      bumpRender();
      return;
    }

    const roomHit = onDimsChange ? roomResizeHit(x, y, pxW, pxH) : null;
    if (roomHit) {
      interactionRef.current = {
        type: 'room-resize',
        handle: roomHit,
        startAbs: abs,
        startDims: { ...dims },
        metersPerPx: 1 / pxPerM,
      };
      setSelectedId(null);
      setSelectedObstacleId(null);
      hideRoomRotation();
      bumpRender();
      return;
    }

    const obstacleHit = hitTestObstacle(x, y);
    if (obstacleHit) {
      setSelectedId(null);
      setSelectedObstacleId(obstacleHit.id);
      hideRoomRotation();
      revealPanel();
      interactionRef.current = {
        type: 'obstacle-moving',
        id: obstacleHit.id,
        startAbs: abs,
        startObstacle: { ...obstacleHit },
        metersPerPx: 1 / pxPerM,
      };
      bumpRender();
      return;
    }

    if (!inRoomRect(x, y)) {
      setSelectedId(null);
      hideRoomRotation();
      setSelectedObstacleId(null);
      bumpRender();
      return;
    }

    // 1. Currently-selected item has priority.
    if (selectedId) {
      const sel = windows.find(w => w.id === selectedId);
      if (sel) {
        const hit = hitTestAny(sel, x, y);
        if (hit) {
          hideRoomRotation();
          revealPanel();
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
        hideRoomRotation();
        revealPanel();
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
        startAbs: abs,
      };
      setSelectedId(null);
      setSelectedObstacleId(null);
      hideRoomRotation();
      bumpRender();
      return;
    }

    // 4. Interior → draw skylight.
    const { X, Z } = canvasToRoomXZ(x, y, pxW, pxH, roomW, roomD);
    interactionRef.current = {
      type: 'drawing-skylight',
      startX: X, startZ: Z,
      currentX: X, currentZ: Z,
      startAbs: abs,
    };
    setSelectedId(null);
    setSelectedObstacleId(null);
    hideRoomRotation();
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

  const onPointerMove = (e) => {
    const ia = interactionRef.current;
    if (!ia) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (ia.type === 'rotating-room') {
      const { x, y } = getCanvasPos(e);
      const currentAngle = angleFromRoomPoint(x, y);
      if (onBearingChange && currentAngle != null) {
        onBearingChange(normalizeBearing(ia.startBearing + signedAngleDelta(ia.startAngle, currentAngle)));
      }
      bumpRender();
      return;
    }

    if (ia.type === 'room-resize') {
      const abs = getAbsPos(e);
      const dx = (abs.x - ia.startAbs.x) * ia.metersPerPx;
      const dy = (abs.y - ia.startAbs.y) * ia.metersPerPx;
      const patch = {};
      if (ia.handle.includes('E')) patch.W = clamp(ia.startDims.W + dx, MIN_ROOM_W, MAX_ROOM_W);
      if (ia.handle.includes('W')) patch.W = clamp(ia.startDims.W - dx, MIN_ROOM_W, MAX_ROOM_W);
      if (ia.handle.includes('S')) patch.D = clamp(ia.startDims.D + dy, MIN_ROOM_D, MAX_ROOM_D);
      if (ia.handle.includes('N')) patch.D = clamp(ia.startDims.D - dy, MIN_ROOM_D, MAX_ROOM_D);
      if (Object.keys(patch).length) onDimsChange(patch);
      bumpRender();
      return;
    }

    if (ia.type === 'obstacle-moving') {
      const abs = getAbsPos(e);
      const dx = (abs.x - ia.startAbs.x) * ia.metersPerPx;
      const dz = -(abs.y - ia.startAbs.y) * ia.metersPerPx;
      onUpdateObstacle?.(ia.id, {
        // Clamp to the outdoor area so obstacles can't be dragged off the
        // canvas where the user couldn't reach them again.
        x: clamp(ia.startObstacle.x + dx, worldMinX, worldMaxX),
        z: clamp(ia.startObstacle.z + dz, worldMinZ, worldMaxZ),
      });
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

  const onPointerUp = (e) => {
    const ia = interactionRef.current;
    if (!ia) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const endAbs = e ? getAbsPos(e) : null;

    if (ia.type === 'rotating-room') {
      scheduleRoomRotationHide();
    } else if (ia.type === 'drawing-wall') {
      if (!pointerMovedEnough(ia.startAbs, endAbs)) {
        interactionRef.current = null;
        bumpRender();
        return;
      }
      const min = Math.min(ia.startM, ia.currentM);
      const max = Math.max(ia.startM, ia.currentM);
      if (max - min >= MIN_WINDOW_WIDTH) {
        const id = onAddWindow({
          kind: 'wall',
          wall: ia.wall,
          min, max,
          config: 'clear',
          yMin: Math.min(DEFAULT_WIN_Y_MIN, Math.max(0, roomH - 0.5)),
          yMax: Math.min(DEFAULT_WIN_Y_MAX, roomH),
        });
        if (id) {
          setSelectedId(id);
          revealPanel();
        }
      }
    } else if (ia.type === 'drawing-skylight') {
      if (!pointerMovedEnough(ia.startAbs, endAbs)) {
        setSelectedId(null);
        setSelectedObstacleId(null);
        showRoomRotation();
        interactionRef.current = null;
        bumpRender();
        return;
      }
      const xMin = Math.min(ia.startX, ia.currentX);
      const xMax = Math.max(ia.startX, ia.currentX);
      const zMin = Math.min(ia.startZ, ia.currentZ);
      const zMax = Math.max(ia.startZ, ia.currentZ);
      if (xMax - xMin >= MIN_SKYLIGHT_SIZE && zMax - zMin >= MIN_SKYLIGHT_SIZE) {
        const id = onAddWindow({
          kind: 'skylight',
          config: 'clear',
          xMin, xMax, zMin, zMax,
        });
        if (id) {
          setSelectedId(id);
          revealPanel();
        }
      }
    }

    interactionRef.current = null;
    bumpRender();
  };

  const onPointerCancel = (e) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
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
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedObstacleId) {
        if (wrapperRef.current && wrapperRef.current.contains(document.activeElement)) {
          e.preventDefault();
          onRemoveObstacle?.(selectedObstacleId);
          setSelectedObstacleId(null);
        }
      } else if (e.key === 'Escape') {
        setSelectedId(null);
        setSelectedObstacleId(null);
        hideRoomRotation();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, selectedObstacleId, onRemoveWindow, onRemoveObstacle]);

  // ── Cursor styling ────────────────────────────────────────────────────────
  const [cursor, setCursor] = useState('crosshair');
  const onHoverMove = (e) => {
    if (interactionRef.current) {
      if (interactionRef.current.type === 'rotating-room') setCursor('grabbing');
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { x, y } = getCanvasPos(e);
    if (isNearRoomRotateHandle(x, y)) {
      setCursor('grab');
      return;
    }
    const roomHit = onDimsChange ? roomResizeHit(x, y, pxW, pxH) : null;
    if (roomHit) {
      setCursor(roomResizeCursor(roomHit));
      return;
    }
    if (hitTestObstacle(x, y)) {
      const obstacle = hitTestObstacle(x, y);
      setSelectedId(null);
      if (obstacle?.id !== selectedObstacleId) setSelectedObstacleId(obstacle.id);
      revealPanel(PANEL_HOVER_VISIBLE_MS);
      setCursor('move');
      return;
    }
    if (!inRoomRect(x, y)) {
      setCursor('default');
      return;
    }
    // Hover over an existing item?
    for (const w of windows) {
      const hit = hitTestAny(w, x, y);
      if (!hit) continue;
      if (w.id === selectedId) revealPanel(PANEL_HOVER_VISIBLE_MS);
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
  const selectedObstacle = selectedObstacleId ? obstacles.find(o => o.id === selectedObstacleId) : null;

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
        onPointerDown={onPointerDown}
        onPointerMove={(e) => { onPointerMove(e); onHoverMove(e); }}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={(e) => {
          if (!interactionRef.current) onHoverMove(e);
        }}
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

      {onAddObstacle && (
        <button
          type="button"
          onClick={addExternalObject}
          style={{
            position: 'absolute',
            top: 48,
            right: 8,
            height: 30,
            padding: '0 10px',
            background: '#24243c',
            color: '#e0e0f0',
            border: '1px solid #4a4a6a',
            borderRadius: 5,
            fontSize: 11,
            fontWeight: 700,
            cursor: 'pointer',
            boxShadow: '0 3px 12px rgba(0,0,0,0.25)',
          }}
        >
          Add external object
        </button>
      )}

      {selected && !isSkylight(selected) && (
        <WallWindowPanel
          win={selected}
          roomH={roomH}
          bearingDeg={bearingDeg}
          onChangeY={(yMin, yMax) => onUpdateWindow(selected.id, { yMin, yMax })}
          onChangeConfig={config => onUpdateWindow(selected.id, { config })}
          visible={panelVisible}
          onInteract={() => revealPanel()}
          onPointerEnter={() => {
            panelPointerInsideRef.current = true;
            clearPanelTimer();
            setPanelVisible(true);
          }}
          onPointerLeave={() => {
            panelPointerInsideRef.current = false;
            revealPanel(PANEL_HOVER_VISIBLE_MS);
          }}
          onRemove={() => { onRemoveWindow(selected.id); setSelectedId(null); }}
        />
      )}
      {selected && isSkylight(selected) && (
        <SkylightPanel
          win={selected}
          roomH={roomH}
          onChangeConfig={config => onUpdateWindow(selected.id, { config })}
          visible={panelVisible}
          onPointerEnter={() => {
            panelPointerInsideRef.current = true;
            clearPanelTimer();
            setPanelVisible(true);
          }}
          onPointerLeave={() => {
            panelPointerInsideRef.current = false;
            revealPanel(PANEL_HOVER_VISIBLE_MS);
          }}
          onRemove={() => { onRemoveWindow(selected.id); setSelectedId(null); }}
        />
      )}

      <RoomHeightControl
        dims={dims}
        onDimsChange={onDimsChange}
        onResetDims={onResetDims}
      />
      {selectedObstacle && (
        <ObstaclePanel
          obstacle={selectedObstacle}
          visible={panelVisible}
          onChangeType={typeId => {
            const type = OBSTACLE_TYPES.find(t => t.id === typeId) || OBSTACLE_TYPES[0];
            setObstacleType(type.id);
            onUpdateObstacle?.(selectedObstacle.id, {
              type: type.id,
              radius: type.radius,
              height: type.height,
            });
            revealPanel();
          }}
          onPointerEnter={() => {
            panelPointerInsideRef.current = true;
            clearPanelTimer();
            setPanelVisible(true);
          }}
          onPointerLeave={() => {
            panelPointerInsideRef.current = false;
            revealPanel(PANEL_HOVER_VISIBLE_MS);
          }}
          onRemove={() => {
            onRemoveObstacle?.(selectedObstacle.id);
            setSelectedObstacleId(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Floating panels ─────────────────────────────────────────────────────────

function panelShell(children, visible = true, handlers = {}) {
  return (
    <div
      {...handlers}
      style={{
      position: 'absolute',
      top: 88,
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
      opacity: visible ? 1 : 0,
      transform: visible ? 'translateY(0) scale(1)' : 'translateY(-2px) scale(0.99)',
      pointerEvents: visible ? 'auto' : 'none',
      transition: `opacity ${PANEL_FADE_MS}ms cubic-bezier(0.2, 0, 0.2, 1), transform ${PANEL_FADE_MS}ms cubic-bezier(0.2, 0, 0.2, 1)`,
      willChange: 'opacity, transform',
    }}>
      {children}
    </div>
  );
}

function WallWindowPanel({
  win, roomH, bearingDeg = 0, visible,
  onChangeY, onChangeConfig, onRemove, onInteract,
  onPointerEnter, onPointerLeave,
}) {
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

      <WindowConfigSelect win={win} onChange={onChangeConfig} onInteract={onInteract} />

      <div style={{ ...label, marginBottom: 4 }}>
        <span>Bottom</span>
        <b style={{ color: '#c0c0e0', marginLeft: 'auto' }}>{win.yMin.toFixed(2)} m</b>
      </div>
      <input
        type="range" min={0} max={roomH} step={0.05}
        value={win.yMin}
        onChange={e => {
          const v = Math.min(Number(e.target.value), win.yMax - 0.1);
          onInteract?.();
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
          onInteract?.();
          onChangeY(win.yMin, v);
        }}
        style={slider}
      />

      <RemoveButton onClick={onRemove} />
    </>,
    visible,
    { onPointerEnter, onPointerLeave }
  );
}

function SkylightPanel({
  win, roomH, visible, onChangeConfig, onRemove,
  onPointerEnter, onPointerLeave,
}) {
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
      <WindowConfigSelect win={win} onChange={onChangeConfig} />
      <RemoveButton onClick={onRemove} />
    </>,
    visible,
    { onPointerEnter, onPointerLeave }
  );
}

function WindowConfigSelect({ win, onChange, onInteract }) {
  return (
    <label style={{ display: 'grid', gap: 4, marginBottom: 10 }}>
      <span style={{
        color: '#9090b8',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
      }}>
        Configuration
      </span>
      <select
        value={win.config || 'clear'}
        onChange={e => {
          onInteract?.();
          onChange?.(e.target.value);
        }}
        style={{
          width: '100%',
          background: '#1a1a2e',
          color: '#e0e0f0',
          border: '1px solid #3a3a5a',
          borderRadius: 5,
          padding: '5px 7px',
          fontSize: 12,
        }}
      >
        {WINDOW_CONFIGS.map(config => (
          <option key={config.id} value={config.id}>
            {config.label} · {config.description}
          </option>
        ))}
      </select>
    </label>
  );
}

function RoomHeightControl({ dims, onDimsChange, onResetDims }) {
  if (!onDimsChange) return null;
  const isDefault = (
    Math.abs(dims.W - DEFAULT_ROOM_W) < 1e-3 &&
    Math.abs(dims.D - DEFAULT_ROOM_D) < 1e-3 &&
    Math.abs(dims.H - DEFAULT_ROOM_H) < 1e-3
  );
  return (
    <div style={{
      marginTop: 10,
      display: 'grid',
      gridTemplateColumns: 'repeat(3, minmax(0, 1fr)) auto',
      gap: 8,
      alignItems: 'end',
      color: '#c0c0e0',
      fontSize: 11,
    }}>
      <DimInput
        label="Room width"
        value={dims.W}
        min={MIN_ROOM_W}
        max={MAX_ROOM_W}
        onChange={v => onDimsChange({ W: v })}
      />
      <DimInput
        label="Room depth"
        value={dims.D}
        min={MIN_ROOM_D}
        max={MAX_ROOM_D}
        onChange={v => onDimsChange({ D: v })}
      />
      <DimInput
        label="Room height"
        value={dims.H}
        min={MIN_ROOM_H}
        max={MAX_ROOM_H}
        onChange={v => onDimsChange({ H: v })}
      />
      {onResetDims && (
        <button
          onClick={onResetDims}
          disabled={isDefault}
          style={{
            height: 28,
            padding: '0 8px',
            background: isDefault ? '#171724' : '#24243c',
            color: isDefault ? '#555570' : '#c0c0e0',
            border: `1px solid ${isDefault ? '#28283a' : '#4a4a6a'}`,
            borderRadius: 5,
            fontSize: 10,
            fontWeight: 700,
            cursor: isDefault ? 'default' : 'pointer',
          }}
        >
          Reset
        </button>
      )}
    </div>
  );
}

function ObstaclePanel({
  obstacle, visible, onChangeType, onRemove,
  onPointerEnter, onPointerLeave,
}) {
  const type = OBSTACLE_TYPES.find(option => option.id === obstacle.type) || OBSTACLE_TYPES[0];
  return panelShell(
    <>
      <div style={{ fontWeight: 700, letterSpacing: '0.04em', marginBottom: 6 }}>
        Outdoor object
      </div>
      <div style={{ color: '#8080a8', fontSize: 11, marginBottom: 10 }}>
        {type.label} · {Number(obstacle.height ?? type.height).toFixed(1)} m high
      </div>
      <label style={{ display: 'grid', gap: 4, marginBottom: 10 }}>
        <span style={{
          color: '#9090b8',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}>
          Object type
        </span>
        <select
          value={type.id}
          onChange={e => onChangeType?.(e.target.value)}
          style={{
            width: '100%',
            background: '#1a1a2e',
            color: '#e0e0f0',
            border: '1px solid #3a3a5a',
            borderRadius: 5,
            padding: '5px 7px',
            fontSize: 12,
          }}
        >
          {OBSTACLE_TYPES.map(option => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
      </label>
      <RemoveButton onClick={onRemove} />
    </>,
    visible,
    { onPointerEnter, onPointerLeave }
  );
}

function DimInput({ label, value, min, max, onChange }) {
  return (
    <label style={{ display: 'grid', gap: 3, minWidth: 0 }}>
      <span style={{
        color: '#8080a8',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
      }}>
        {label}
      </span>
      <input
        type="number"
        value={Number(value).toFixed(1)}
        min={min}
        max={max}
        step={0.1}
        onChange={e => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        style={{
          minWidth: 0,
          height: 28,
          boxSizing: 'border-box',
          background: '#1a1a2e',
          color: '#e0e0f0',
          border: '1px solid #3a3a5a',
          borderRadius: 5,
          padding: '4px 6px',
          fontSize: 12,
        }}
      />
    </label>
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
