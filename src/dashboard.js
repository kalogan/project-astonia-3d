/**
 * dashboard.js — Level Design Dashboard engine
 * =============================================
 * Canvas-based isometric map editor with:
 *   • Staggered 2:1 isometric grid (TILE_W=40, TILE_H=20)
 *   • Dynamic zoom via ctx.scale (1× / 2× / 4×)
 *   • Y-sorted render loop (painter's algorithm)
 *   • Staggered iso picking (screen → tile)
 *   • Three-layer tile data: floor / prop / overhead
 *   • Asset browser fed from assets_01.zip + assets_02.zip
 *   • Tag-aware search using /api/tags sidecar
 */

import JSZip from 'jszip';

// ── Grid constants (base 1× — ctx.scale handles visual upscale) ───────────────
const TILE_W  = 40;   // diamond bounding-box width
const TILE_H  = 20;   // diamond bounding-box height
const STEP_X  = 20;   // odd-row stagger offset  (TILE_W / 2)
const STEP_Y  = 10;   // row vertical pitch       (TILE_H / 2)
const MAP_COLS = 24;
const MAP_ROWS = 24;

// ── Zoom / scale ──────────────────────────────────────────────────────────────
// Prompt 2 uses const SCALE = 2; Prompt 3 upgrades it to let currentScale = 2.
// We start with the final form.
let currentScale = 2;

// ── Camera / infinite viewport ────────────────────────────────────────────────
// World-space coordinates of the top-left corner of the visible canvas area.
// render() calls ctx.translate(-cameraX, -cameraY) after ctx.scale(currentScale)
// so all drawing uses world coords; screen-to-world simply adds the camera offset.
let cameraX = 0;
let cameraY = 0;

// Middle-mouse pan state
let isPanning = false;
let lastPanX  = 0;
let lastPanY  = 0;

// ── Map data ──────────────────────────────────────────────────────────────────
// Keys: "col,row"   Values: { floor, prop, overhead }  — null means empty
// `let` so undo can swap in a deep-copied snapshot.
let mapData = {};

// ── Paint state ───────────────────────────────────────────────────────────────
let activeBrush  = null;    // folderId string | null
let activeLayer  = 'floor'; // 'floor' | 'prop' | 'overhead'
let isErasing    = false;
let isPainting   = false;
let selectedTile = null;    // { col, row } | null
let lastPainted  = null;    // avoids repainting the same tile during drag

// ── Undo stack ─────────────────────────────────────────────────────────────────
const undoStack = [];
const MAX_UNDO  = 50;

// Deep-copy the current mapData and push it onto the undo stack.
// Trims the oldest entry when the cap is exceeded.
function saveState() {
  undoStack.push(JSON.parse(JSON.stringify(mapData)));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

// ── Asset library ─────────────────────────────────────────────────────────────
// folderId → { blobUrl, img, filename }   (one representative per folder)
const assetLib   = new Map();
let   allFolders = [];    // sorted folder ID list
let   assetTags  = {};    // from /api/tags: { folderId: { _folder, "file.png" } }
let   tagFilter  = null;  // active pill filter string | null

// ── Asset browser extended state ──────────────────────────────────────────────
const folderEntries   = new Map(); // fid → [{filename, jsEntry}]  — ALL sprites
let   activeLibFolder = null;      // fid of currently open folder in sprite-content
let   filteredFolders = [];        // current filtered/searched folder list
let   folderRailOffset = 0;        // number of folder items rendered so far
const FOLDER_BATCH    = 200;       // hard cap per virtual-scroll batch
let   railSentinelObs = null;      // IntersectionObserver for folder-rail sentinel

// ── DOM refs ──────────────────────────────────────────────────────────────────
const canvas      = document.getElementById('map-canvas');
const ctx         = canvas.getContext('2d');
const zoomSelect  = document.getElementById('canvas-zoom');
const brushSwatch = document.getElementById('brush-swatch');
const brushLabel  = document.getElementById('brush-label');

// ── Brush helpers ─────────────────────────────────────────────────────────────
// activeBrush may be "folderId" or "folderId/filename".

// Split a brushId value (which may come from activeBrush or from mapData)
// into its folder ID and optional filename parts.
function parseBrushId(value) {
  if (!value) return { fid: null, filename: null };
  const idx = value.indexOf('/');
  return idx === -1
    ? { fid: value,              filename: null }
    : { fid: value.slice(0, idx), filename: value.slice(idx + 1) };
}

// spriteCache holds one HTMLImageElement per specific "fid/filename" brushId.
// drawTileLayers checks this first before falling back to the folder representative.
const spriteCache = new Map(); // brushId → HTMLImageElement

// Lazily extract a specific sprite from its zip entry and cache it.
async function loadSpriteIntoCache(brushId) {
  if (!brushId || spriteCache.has(brushId)) return;
  const { fid, filename } = parseBrushId(brushId);
  if (!filename) return; // folder-level brush — assetLib already has it
  const entry = folderEntries.get(fid)?.find(e => e.filename === filename);
  if (!entry) return;
  try {
    const blob = await entry.jsEntry.async('blob');
    const img  = new Image();
    img.addEventListener('load', render, { once: true }); // repaint when ready
    img.src = URL.createObjectURL(blob);
    spriteCache.set(brushId, img);
  } catch { /* skip corrupt entries */ }
}

// ── Canvas sizing ─────────────────────────────────────────────────────────────
// The canvas is sized to exactly fill its parent container (#canvas-wrap).
// We no longer size to map extents — the camera / translate allows infinite panning.
function updateCanvasSize() {
  const wrap = canvas.parentElement;
  canvas.width  = Math.max(1, wrap.clientWidth);
  canvas.height = Math.max(1, wrap.clientHeight);
}

// ── Render loop ───────────────────────────────────────────────────────────────
function render() {
  // Step 1 — clear physical canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Step 2 — push scale + camera transform
  ctx.save();
  ctx.scale(currentScale, currentScale);

  // CRITICAL: re-apply after scale so pixel art stays crisp at every zoom level
  ctx.imageSmoothingEnabled = false;

  // Shift the coordinate origin so the camera position maps to (0,0) on screen.
  // All subsequent drawing uses world-space coordinates unchanged.
  ctx.translate(-cameraX, -cameraY);

  // Step 3 — draw empty grid (wireframe diamonds)
  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      drawDiamond(tileX(c, r), tileY(r), 'rgba(55,65,81,0.45)', null, 0.5);
    }
  }

  // Step 4 — draw painted tiles, Y-sorted so lower rows render on top (painter's algo)
  const sorted = Object.entries(mapData).sort((a, b) => {
    const [ca, ra] = a[0].split(',').map(Number);
    const [cb, rb] = b[0].split(',').map(Number);
    return ra !== rb ? ra - rb : ca - cb;
  });

  for (const [key, layers] of sorted) {
    const [col, row] = key.split(',').map(Number);
    const sx = tileX(col, row);
    const sy = tileY(row);
    drawTileLayers(sx, sy, layers);
  }

  // Step 5 — selection ring
  if (selectedTile) {
    const { col, row } = selectedTile;
    drawDiamond(tileX(col, row), tileY(row), null, 'rgba(56,189,248,0.9)', 1.5);
  }

  // Step 6 — restore transform
  ctx.restore();
}

// Screen position of a tile's bounding-box top-left corner (1× logical coords)
function tileX(col, row) { return col * TILE_W + (row % 2) * STEP_X; }
function tileY(row)       { return row * STEP_Y; }

// Draw a diamond path; fill and/or stroke if colours are non-null
function drawDiamond(sx, sy, fill, stroke, lineWidth = 1) {
  ctx.beginPath();
  ctx.moveTo(sx + TILE_W / 2, sy);
  ctx.lineTo(sx + TILE_W,     sy + TILE_H / 2);
  ctx.lineTo(sx + TILE_W / 2, sy + TILE_H);
  ctx.lineTo(sx,               sy + TILE_H / 2);
  ctx.closePath();
  if (fill)   { ctx.fillStyle   = fill;   ctx.fill();              }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
}

// Resolve the best available HTMLImageElement for a stored brushId value.
// Checks spriteCache (specific sprite) first, then falls back to the folder
// representative in assetLib.
function resolveImg(value) {
  const cached = spriteCache.get(value);
  if (cached) return cached;
  const { fid } = parseBrushId(value);
  return assetLib.get(fid)?.img ?? null;
}

// Render all layers for a tile at (sx, sy)
function drawTileLayers(sx, sy, layers) {
  for (const layer of ['floor', 'prop', 'overhead']) {
    const value = layers[layer];
    if (!value) continue;
    const img = resolveImg(value);
    if (img?.complete && img.naturalWidth > 0) {
      // Sprite is loaded — draw it scaled into the 40×20 bounding box
      ctx.drawImage(img, sx, sy, TILE_W, TILE_H);
    } else {
      // Fallback: solid-colour diamond derived from folder ID
      drawDiamond(sx, sy, folderHue(value), null);
    }
    // Subtle layer border so stacked layers are distinguishable
    drawDiamond(sx, sy, null, 'rgba(255,255,255,0.06)', 0.5);
  }
}

// Deterministic hue from a brushId string (uses the folder ID part only)
function folderHue(value) {
  const { fid } = parseBrushId(value);
  const s = fid ?? value;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return `hsl(${Math.abs(h) % 360},45%,28%)`;
}

// ── Isometric picking (screen → world) ────────────────────────────────────────
// Convert a raw canvas mouse event into world-space 1× coordinates:
//   divide by currentScale (undo the ctx.scale) then add cameraX/Y (undo translate).
// The picking algorithm itself always worked in base 1× coords — this just extends
// it to work correctly under the infinite-viewport camera.
function normCoords(e) {
  return {
    mx: (e.offsetX / currentScale) + cameraX,
    my: (e.offsetY / currentScale) + cameraY,
  };
}

// Staggered-iso diamond test.
// For a tile at (col, row) the bounding box starts at (tileX, tileY).
// A point (rx, ry) inside that box is inside the diamond if
//   |rx − hw| / hw  +  |ry − hh| / hh  ≤  1
function pickTile(mx, my) {
  const hw = TILE_W / 2;
  const hh = TILE_H / 2;

  // Approximate row, then search a ±2 neighbourhood to handle diamond boundaries
  const rowBase = Math.floor(my / STEP_Y);

  for (let r = rowBase - 1; r <= rowBase + 2; r++) {
    if (r < 0 || r >= MAP_ROWS) continue;
    const stagger  = (r % 2) * STEP_X;
    const colBase  = Math.floor((mx - stagger) / TILE_W);

    for (let c = colBase - 1; c <= colBase + 2; c++) {
      if (c < 0 || c >= MAP_COLS) continue;
      const rx = mx - (c * TILE_W + stagger);
      const ry = my - r * STEP_Y;
      if (rx < 0 || rx > TILE_W || ry < 0 || ry > TILE_H) continue;
      if (Math.abs(rx - hw) / hw + Math.abs(ry - hh) / hh <= 1.0) {
        return { col: c, row: r };
      }
    }
  }
  return null;
}

// ── Paint / erase ─────────────────────────────────────────────────────────────
function applyBrush(col, row) {
  const key = `${col},${row}`;
  if (isErasing) {
    if (mapData[key]) {
      mapData[key][activeLayer] = null;
      // Clean up fully empty tiles
      if (!Object.values(mapData[key]).some(Boolean)) delete mapData[key];
    }
  } else {
    if (!activeBrush) return;
    if (!mapData[key]) mapData[key] = { floor: null, prop: null, overhead: null };
    // Store the full brushId ("folderId" or "folderId/filename") so the renderer
    // can draw the exact sprite the user selected, not just the folder representative.
    mapData[key][activeLayer] = activeBrush;
  }
  render();
  if (selectedTile?.col === col && selectedTile?.row === row) renderInspector();
}

// ── Canvas mouse events ───────────────────────────────────────────────────────
canvas.addEventListener('mousedown', e => {
  // Middle-mouse (button 1): begin panning
  if (e.button === 1) {
    e.preventDefault();
    isPanning = true;
    lastPanX  = e.clientX;
    lastPanY  = e.clientY;
    canvas.style.cursor = 'grabbing';
    return;
  }

  if (e.button !== 0) return;
  e.preventDefault();
  isPainting   = true;
  lastPainted  = null;
  const { mx, my } = normCoords(e);
  const tile = pickTile(mx, my);
  if (!tile) return;
  saveState();   // snapshot before the stroke begins (once per drag)
  selectedTile = tile;
  lastPainted  = `${tile.col},${tile.row}`;
  applyBrush(tile.col, tile.row);
  renderInspector();
});

canvas.addEventListener('mousemove', e => {
  // Middle-mouse pan: translate camera by the delta in screen pixels
  if (isPanning) {
    const dx = e.clientX - lastPanX;
    const dy = e.clientY - lastPanY;
    lastPanX = e.clientX;
    lastPanY = e.clientY;
    // Divide by scale so one screen-pixel moves exactly one world-pixel
    cameraX -= dx / currentScale;
    cameraY -= dy / currentScale;
    render();
    return;
  }

  if (!isPainting) return;
  const { mx, my } = normCoords(e);
  const tile = pickTile(mx, my);
  if (!tile) return;
  const key = `${tile.col},${tile.row}`;
  if (key === lastPainted) return;   // avoid redundant repaints
  lastPainted  = key;
  selectedTile = tile;
  applyBrush(tile.col, tile.row);
  renderInspector();
});

// Right-click: select tile without painting (inspect only)
canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  const { mx, my } = normCoords(e);
  const tile = pickTile(mx, my);
  if (!tile) return;
  selectedTile = tile;
  render();
  renderInspector();
});

function stopPan() {
  if (isPanning) {
    isPanning = false;
    canvas.style.cursor = 'crosshair';
  }
}
window.addEventListener('mouseup', () => { isPainting = false; stopPan(); });

// Stop panning if the pointer leaves the canvas mid-drag
canvas.addEventListener('mouseleave', stopPan);

// ── Scroll-wheel zoom ─────────────────────────────────────────────────────────
// Zooms toward the cursor position: the world point under the mouse stays fixed.
canvas.addEventListener('wheel', e => {
  e.preventDefault();

  const factor   = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const oldScale = currentScale;

  // World-space position under the cursor before the zoom
  const wx = (e.offsetX / oldScale) + cameraX;
  const wy = (e.offsetY / oldScale) + cameraY;

  // Apply factor and clamp to [0.5, 4]
  let newScale = Math.min(4, Math.max(0.5, oldScale * factor));

  // Snap to clean dropdown values (1×, 2×, 4×) when close
  for (const s of [1, 2, 4]) {
    if (Math.abs(newScale - s) < 0.12) { newScale = s; break; }
  }

  currentScale = newScale;

  // Keep the world point under the cursor stationary
  cameraX = wx - e.offsetX / currentScale;
  cameraY = wy - e.offsetY / currentScale;

  // Sync zoom dropdown if the new scale matches one of its options
  const intStr = String(currentScale);
  if (zoomSelect.querySelector(`option[value="${intStr}"]`)) {
    zoomSelect.value = intStr;
  }

  render();
}, { passive: false });

// ── Resize observer ───────────────────────────────────────────────────────────
// Re-measure the container whenever the window changes size.
window.addEventListener('resize', () => {
  updateCanvasSize();
  render();
});

// ── Ctrl+Z / Cmd+Z  Undo ──────────────────────────────────────────────────────
window.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    const prev = undoStack.pop();
    if (prev !== undefined) {
      mapData = prev;
      render();
      renderInspector();
    }
  }
});

// ── Erase All ─────────────────────────────────────────────────────────────────
document.getElementById('btn-erase-all').addEventListener('click', () => {
  saveState();       // allow Ctrl+Z to recover the wipe
  mapData = {};
  selectedTile = null;
  render();
  renderInspector();
});

// ── Map payload formatter ──────────────────────────────────────────────────────
// Wraps mapData in the canonical engine schema so both export paths emit the
// same structure.  A unique ID and ISO timestamp are generated fresh each call.
function formatMapData() {
  return {
    id:        'level_' + Date.now(),
    timestamp: new Date().toISOString(),
    map_stack: mapData,
  };
}

// ── Export Local (browser download) ───────────────────────────────────────────
document.getElementById('btn-export').addEventListener('click', () => {
  const json = JSON.stringify(formatMapData(), null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href     = url;
  a.download = 'map_export.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Release the object URL after a short delay so the download can start
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

// ── Sync to Engine (server-side write) ────────────────────────────────────────
// Posts the formatted payload to /api/save-map (Vite dev-server plugin).
// The server writes public/maps/latest_map.json so the game engine can read it
// without a page reload.
const syncBtn = document.getElementById('btn-sync');
let   syncTimer = null;  // debounce for resetting button label

function setSyncState(state, label) {
  // Clear any previous auto-reset
  clearTimeout(syncTimer);
  syncBtn.classList.remove('synced', 'error');
  syncBtn.textContent = label;
  if (state) {
    syncBtn.classList.add(state);
    syncTimer = setTimeout(() => {
      syncBtn.classList.remove(state);
      syncBtn.textContent = '⬆ Sync';
    }, 2200);
  }
}

syncBtn.addEventListener('click', async () => {
  setSyncState(null, '…');
  try {
    const res = await fetch('/api/save-map', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(formatMapData()),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setSyncState('synced', '✓ Saved!');
  } catch (err) {
    console.error('[sync]', err);
    setSyncState('error', '✗ Failed');
  }
});

// ── Sprite-content: delegated selection ────────────────────────────────────────
// A single listener on the container replaces per-card closure handlers.
// It reads data-brush-id from the DOM at click time, so activeBrush is always
// the exact sprite that was clicked — never a stale captured variable.
function activateSpriteCard(card) {
  document.querySelectorAll('#sprite-content .selected').forEach(el =>
    el.classList.remove('selected'));
  card.classList.add('selected');
  // Read the baked data attribute — no closure, no ambiguity
  activeBrush = card.getAttribute('data-brush-id');
  updateBrushUI(activeBrush);
  // Pre-load the specific sprite blob so it is ready for the very first stroke
  loadSpriteIntoCache(activeBrush);
}

document.getElementById('sprite-content').addEventListener('click', e => {
  const card = e.target.closest('.sprite-card');
  if (!card) return;
  activateSpriteCard(card);
});

document.getElementById('sprite-content').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('.sprite-card');
  if (!card) return;
  e.preventDefault();
  activateSpriteCard(card);
});

// ── Zoom toggle ───────────────────────────────────────────────────────────────
// Selecting a zoom level from the dropdown snaps currentScale to an exact integer.
// No canvas resize needed — the canvas always fills the container.
zoomSelect.addEventListener('change', e => {
  currentScale = parseInt(e.target.value, 10);
  render();
});

// ── Layer toggle ──────────────────────────────────────────────────────────────
document.getElementById('layer-toggle').addEventListener('click', e => {
  const btn = e.target.closest('.layer-btn');
  if (!btn) return;
  activeLayer = btn.dataset.layer;
  document.querySelectorAll('.layer-btn').forEach(b => {
    const on = b === btn;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
});

// ── Eraser toggle ─────────────────────────────────────────────────────────────
document.getElementById('eraser-btn').addEventListener('click', () => {
  isErasing = !isErasing;
  const btn = document.getElementById('eraser-btn');
  btn.classList.toggle('active', isErasing);
  btn.setAttribute('aria-pressed', String(isErasing));
});

// ── Tile Inspector ─────────────────────────────────────────────────────────────
function renderInspector() {
  const coordEl    = document.getElementById('inspector-coord');
  const emptyEl    = document.getElementById('inspector-empty');
  const layersEl   = document.getElementById('inspector-layers');

  if (!selectedTile) {
    coordEl.textContent   = '—';
    emptyEl.style.display = '';
    layersEl.innerHTML    = '';
    return;
  }

  const { col, row } = selectedTile;
  coordEl.textContent   = `${col}, ${row}`;
  emptyEl.style.display = 'none';
  layersEl.innerHTML    = '';

  const key    = `${col},${row}`;
  const layers = mapData[key] ?? { floor: null, prop: null, overhead: null };

  const defs = [
    { id: 'floor',    label: 'Floor',    cls: 'layer-floor'    },
    { id: 'prop',     label: 'Prop',     cls: 'layer-prop'     },
    { id: 'overhead', label: 'Overhead', cls: 'layer-overhead' },
  ];

  for (const { id, label, cls } of defs) {
    const value = layers[id]; // may be "folderId" or "folderId/filename"
    const wrap  = document.createElement('div');
    wrap.className = `insp-layer ${cls}`;

    // Header row
    const hdr  = document.createElement('div');
    hdr.className = 'insp-layer-hdr';

    const dot  = document.createElement('div');  dot.className = 'insp-dot';
    const name = document.createElement('span'); name.className = 'insp-layer-name'; name.textContent = label;

    const clearBtn = document.createElement('button');
    clearBtn.className = 'insp-clear-btn';
    clearBtn.textContent = '×';
    clearBtn.title = `Clear ${label}`;
    if (value) clearBtn.style.display = 'block';
    clearBtn.addEventListener('click', () => {
      if (!mapData[key]) return;
      mapData[key][id] = null;
      if (!Object.values(mapData[key]).some(Boolean)) delete mapData[key];
      render();
      renderInspector();
    });

    hdr.appendChild(dot);
    hdr.appendChild(name);
    hdr.appendChild(clearBtn);

    // Body row
    const body = document.createElement('div');
    body.className = 'insp-layer-body';

    if (value) {
      const { fid, filename } = parseBrushId(value);
      const thumb = document.createElement('div'); thumb.className = 'insp-thumb';
      // Show the specific sprite if cached, otherwise the folder representative
      const img = new Image();
      img.alt = value;
      const cached = spriteCache.get(value);
      img.src = cached ? cached.src : (assetLib.get(fid)?.blobUrl ?? '');
      thumb.appendChild(img);

      const idEl = document.createElement('span');
      idEl.className = 'insp-folder-id';
      idEl.textContent = filename ? `${fid} / ${filename}` : fid;
      idEl.title = value;

      const setBrushBtn = document.createElement('button');
      setBrushBtn.className = 'insp-set-brush';
      setBrushBtn.textContent = '→ Brush';
      setBrushBtn.style.display = 'inline-block';
      setBrushBtn.addEventListener('click', () => selectBrush(fid, filename));

      body.appendChild(thumb);
      body.appendChild(idEl);
      body.appendChild(setBrushBtn);
    } else {
      const empty = document.createElement('span');
      empty.className = 'insp-empty-lbl';
      empty.textContent = 'empty';
      body.appendChild(empty);
    }

    wrap.appendChild(hdr);
    wrap.appendChild(body);
    layersEl.appendChild(wrap);
  }
}

// ── Tag helpers ────────────────────────────────────────────────────────────────
function getFolderTags(fid)         { return assetTags[fid]?._folder ?? []; }
function getFileTags(fid, filename) { return assetTags[fid]?.[filename] ?? []; }

async function saveTags(fid, fileId, tags) {
  if (!assetTags[fid]) assetTags[fid] = {};
  if (tags.length === 0) {
    delete assetTags[fid][fileId];
    if (Object.keys(assetTags[fid]).length === 0) delete assetTags[fid];
  } else {
    assetTags[fid][fileId] = tags;
  }
  await fetch('/api/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId: fid, fileId, tags }),
  }).catch(console.warn);
}

// ── Mini tag bar (per-sprite) ──────────────────────────────────────────────────
function renderMiniTagBar(container, fid, filename) {
  container.innerHTML = '';
  const tags = [...getFileTags(fid, filename)];

  for (const tag of tags) {
    const pill = document.createElement('span');
    pill.className = 'mini-tag-pill';
    pill.textContent = tag;

    const rm = document.createElement('button');
    rm.className = 'mini-tag-rm';
    rm.textContent = '×';
    rm.setAttribute('aria-label', `Remove tag ${tag}`);
    rm.addEventListener('click', async e => {
      e.stopPropagation();
      const next = tags.filter(t => t !== tag);
      await saveTags(fid, filename, next);
      renderMiniTagBar(container, fid, filename);
    });
    pill.appendChild(rm);
    container.appendChild(pill);
  }

  const addBtn = document.createElement('button');
  addBtn.className = 'mini-tag-add';
  addBtn.textContent = '+';
  addBtn.setAttribute('aria-label', 'Add tag');
  container.appendChild(addBtn);

  addBtn.addEventListener('click', e => {
    e.stopPropagation();
    addBtn.style.display = 'none';
    const inp = document.createElement('input');
    inp.className = 'mini-tag-input';
    inp.type = 'text';
    inp.placeholder = 'tag…';
    container.appendChild(inp);
    inp.focus();

    const commit = async () => {
      const val = inp.value.trim().toLowerCase();
      if (val && !tags.includes(val)) {
        tags.push(val);
        await saveTags(fid, filename, tags);
      }
      renderMiniTagBar(container, fid, filename);
    };
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); commit(); }
      if (e.key === 'Escape') renderMiniTagBar(container, fid, filename);
    });
    inp.addEventListener('blur', commit);
  });
}

// ── Brush UI update ────────────────────────────────────────────────────────────
// Single source of truth for every toolbar update when the brush changes.
// brushId may be "folderId" or "folderId/filename".
function updateBrushUI(brushId) {
  if (!brushId) return;

  // Split on the first '/' to recover fid and optional filename
  const slashIdx = brushId.indexOf('/');
  const fid      = slashIdx !== -1 ? brushId.slice(0, slashIdx) : brushId;
  const filename = slashIdx !== -1 ? brushId.slice(slashIdx + 1) : null;

  // Header label — shows "folderId / fileName" or just "folderId"
  brushLabel.textContent = filename ? `${fid} / ${filename}` : fid;

  // Swatch thumbnail uses the folder representative (always available)
  brushSwatch.innerHTML = '';
  const entry = assetLib.get(fid);
  if (entry?.blobUrl) {
    const img = new Image(); img.src = entry.blobUrl;
    brushSwatch.appendChild(img);
  }

  // Deactivate eraser whenever a brush is explicitly chosen
  isErasing = false;
  const eraserBtn = document.getElementById('eraser-btn');
  eraserBtn.classList.remove('active');
  eraserBtn.setAttribute('aria-pressed', 'false');
}

// ── Brush selection ────────────────────────────────────────────────────────────
// Called by the inspector "→ Brush" button and boot initialisation.
// Sprite-card clicks bypass this and go through the delegated listener below.
function selectBrush(fid, filename = null) {
  activeBrush = filename ? `${fid}/${filename}` : fid;
  updateBrushUI(activeBrush);
}

// ── Folder Rail ────────────────────────────────────────────────────────────────
function buildTagDropdown() {
  const sel  = document.getElementById('tag-dropdown');
  const prev = sel.value; // preserve current selection if tags are rebuilt
  sel.innerHTML = '<option value="">All Tags</option>';
  const tagSet = new Set();
  for (const data of Object.values(assetTags)) {
    (data._folder ?? []).forEach(t => tagSet.add(t));
  }
  for (const tag of [...tagSet].sort()) {
    const opt = document.createElement('option');
    opt.value = tag;
    opt.textContent = tag;
    if (tag === prev) opt.selected = true;
    sel.appendChild(opt);
  }
}

document.getElementById('tag-dropdown').addEventListener('change', e => {
  tagFilter = e.target.value || null;
  applyFilter(document.getElementById('folder-search').value);
});

function renderFolderRail() {
  const list = document.getElementById('folder-list');
  list.innerHTML = '';
  folderRailOffset = 0;

  if (railSentinelObs) { railSentinelObs.disconnect(); railSentinelObs = null; }

  if (!filteredFolders.length) {
    list.innerHTML = '<span style="color:var(--text-dim);font-size:12px;font-style:italic;padding:8px 12px;display:block">No folders found.</span>';
    return;
  }

  appendFolderBatch(list);
}

function appendFolderBatch(listEl) {
  const list = listEl || document.getElementById('folder-list');

  // Detach existing sentinel so we can re-add it after the new batch
  const existingSentinel = list.querySelector('.folder-rail-sentinel');
  if (existingSentinel) list.removeChild(existingSentinel);

  const batch = filteredFolders.slice(folderRailOffset, folderRailOffset + FOLDER_BATCH);
  folderRailOffset += batch.length;

  const frag = document.createDocumentFragment();
  for (const fid of batch) {
    const item = document.createElement('div');
    item.className = 'folder-item' + (fid === activeLibFolder ? ' active' : '');
    item.dataset.fid = fid;
    item.setAttribute('role', 'listitem');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', fid);

    // Thumbnail (representative)
    const thumb = document.createElement('div');
    thumb.className = 'folder-item-thumb';
    const rep = assetLib.get(fid);
    if (rep?.blobUrl) {
      const img = new Image(); img.src = rep.blobUrl; img.alt = '';
      thumb.appendChild(img);
    }

    // Info column
    const info = document.createElement('div');
    info.className = 'folder-item-info';

    const idEl = document.createElement('div');
    idEl.className = 'folder-item-id';
    const folderTags = getFolderTags(fid);
    idEl.textContent = folderTags.length ? folderTags[0] : fid;
    idEl.title = fid;

    const countEl = document.createElement('div');
    countEl.className = 'folder-item-count';
    const cnt = folderEntries.get(fid)?.length ?? 1;
    countEl.textContent = `${cnt} sprite${cnt !== 1 ? 's' : ''}`;

    const tagRow = document.createElement('div');
    tagRow.className = 'folder-item-tags';
    for (const tag of folderTags.slice(0, 3)) {
      const pill = document.createElement('span');
      pill.className = 'folder-tag-pill';
      pill.textContent = tag;
      tagRow.appendChild(pill);
    }

    info.appendChild(idEl);
    info.appendChild(countEl);
    info.appendChild(tagRow);
    item.appendChild(thumb);
    item.appendChild(info);

    item.addEventListener('click', () => openFolder(fid));
    item.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFolder(fid); }
    });

    frag.appendChild(item);
  }
  list.appendChild(frag);

  // If more folders remain, attach a sentinel to trigger the next batch
  if (folderRailOffset < filteredFolders.length) {
    const sentinel = document.createElement('div');
    sentinel.className = 'folder-rail-sentinel';
    list.appendChild(sentinel);

    if (railSentinelObs) railSentinelObs.disconnect();
    railSentinelObs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) appendFolderBatch();
    }, { root: list, threshold: 0 });
    railSentinelObs.observe(sentinel);
  }
}

// ── Sprite Content ─────────────────────────────────────────────────────────────
function openFolder(fid) {
  activeLibFolder = fid;
  document.querySelectorAll('.folder-item').forEach(el =>
    el.classList.toggle('active', el.dataset.fid === fid));

  const content = document.getElementById('sprite-content');
  content.innerHTML = '';

  const entries = folderEntries.get(fid);
  if (!entries?.length) {
    content.innerHTML = '<span style="color:var(--text-dim);font-size:12px;font-style:italic;padding:12px;display:block">No sprites in this folder.</span>';
    return;
  }

  // Sticky header
  const hdr = document.createElement('div');
  hdr.className = 'sprite-content-hdr';
  hdr.textContent = `${fid} — ${entries.length} sprite${entries.length !== 1 ? 's' : ''}`;
  content.appendChild(hdr);

  // Sprite grid
  const grid = document.createElement('div');
  grid.className = 'sprite-grid';
  content.appendChild(grid);

  // One observer for all cards in this folder — fires as each scrolls into view
  const cardObs = new IntersectionObserver(obsEntries => {
    for (const oe of obsEntries) {
      if (!oe.isIntersecting) continue;
      cardObs.unobserve(oe.target);
      const card  = oe.target;
      const fname = card.dataset.filename;
      const entry = folderEntries.get(fid)?.find(e => e.filename === fname);
      if (entry) loadSpriteCard(card, fid, fname, entry.jsEntry);
    }
  }, { root: content, rootMargin: '120px', threshold: 0 });

  const frag = document.createDocumentFragment();
  for (const { filename } of entries) {
    const card = document.createElement('div');
    card.className = 'sprite-card'; // no pre-applied selection on initial render
    card.dataset.fid      = fid;
    card.dataset.filename = filename;
    // THE FIX: data-brush-id is read at click time by the delegated listener,
    // so activeBrush always reflects the exact sprite — never a stale closure value.
    card.setAttribute('data-brush-id', `${fid}/${filename}`);
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `${fid} / ${filename}`);

    const imgWrap = document.createElement('div');
    imgWrap.className = 'sprite-card-img';
    imgWrap.innerHTML = '<div class="sprite-placeholder"></div>';

    const name = document.createElement('div');
    name.className = 'sprite-card-name';
    name.textContent = filename;
    name.title = filename;

    const tagBar = document.createElement('div');
    tagBar.className = 'mini-tag-bar';

    card.appendChild(imgWrap);
    card.appendChild(name);
    card.appendChild(tagBar);
    // Click/keyboard selection is handled by the delegated listeners on
    // #sprite-content — no per-card closure handlers attached here.

    frag.appendChild(card);
    cardObs.observe(card);
  }
  grid.appendChild(frag);
}

async function loadSpriteCard(card, fid, filename, jsEntry) {
  try {
    const blob    = await jsEntry.async('blob');
    const blobUrl = URL.createObjectURL(blob);
    const imgWrap = card.querySelector('.sprite-card-img');
    imgWrap.innerHTML = '';
    const img = new Image(); img.src = blobUrl; img.alt = filename;
    imgWrap.appendChild(img);
    // Populate mini tag bar now that the card is visible
    const tagBar = card.querySelector('.mini-tag-bar');
    renderMiniTagBar(tagBar, fid, filename);
  } catch { /* skip corrupt entries */ }
}

// ── Search / filter ────────────────────────────────────────────────────────────
function matchesSearch(fid, q) {
  if (fid.toLowerCase().includes(q)) return true;
  const data = assetTags[fid];
  if (data) {
    for (const tags of Object.values(data)) {
      if (Array.isArray(tags) && tags.some(t => t.toLowerCase().includes(q))) return true;
    }
  }
  return false;
}

function applyFilter(rawQuery = '') {
  const q = rawQuery.trim().toLowerCase();
  filteredFolders = allFolders.filter(fid => {
    if (tagFilter && !getFolderTags(fid).includes(tagFilter)) return false;
    return !q || matchesSearch(fid, q);
  });
  document.getElementById('folder-count').textContent = `${filteredFolders.length}`;
  renderFolderRail();
}

document.getElementById('folder-search').addEventListener('input', e => {
  applyFilter(e.target.value);
});

// ── Boot ───────────────────────────────────────────────────────────────────────
async function boot() {
  const status = document.getElementById('map-status');

  // Load tag sidecar (non-blocking — empty object on failure)
  try {
    const res = await fetch('/api/tags');
    if (res.ok) assetTags = await res.json();
  } catch { /* no sidecar yet */ }

  // Init canvas immediately so the empty grid renders while assets load
  updateCanvasSize();
  render();

  // Fetch both zip archives in parallel
  status.textContent = 'Downloading assets…';
  let zip1, zip2;
  try {
    const [buf1, buf2] = await Promise.all([
      fetch('/raw-assets/assets_01.zip').then(r => {
        if (!r.ok) throw new Error(`assets_01.zip HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
      fetch('/raw-assets/assets_02.zip').then(r => {
        if (!r.ok) throw new Error(`assets_02.zip HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
    ]);
    status.textContent = 'Parsing zips…';
    [zip1, zip2] = await Promise.all([JSZip.loadAsync(buf1), JSZip.loadAsync(buf2)]);
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
    console.error('[dashboard] zip load failed:', e);
    return;
  }

  // Build folderEntries (ALL sprites) + one representative per folder for assetLib
  const representative = new Map(); // fid → { jsEntry, filename }
  for (const zip of [zip1, zip2]) {
    const paths = Object.keys(zip.files).sort();
    for (const p of paths) {
      const entry = zip.files[p];
      if (entry.dir || !p.toLowerCase().endsWith('.png') || !p.includes('/')) continue;
      const parts    = p.split('/');
      const fid      = parts[0];
      const filename = parts.slice(1).join('/');

      // First sorted entry per folder = representative for assetLib / canvas
      if (!representative.has(fid)) {
        representative.set(fid, { jsEntry: entry, filename });
      }

      // Collect EVERY entry for the sprite-content panel
      if (!folderEntries.has(fid)) folderEntries.set(fid, []);
      folderEntries.get(fid).push({ filename, jsEntry: entry });
    }
  }

  allFolders      = [...representative.keys()].sort();
  filteredFolders = [...allFolders];
  status.textContent = `${allFolders.length} folders — extracting thumbnails…`;

  // Extract one representative blob per folder (used by assetLib + canvas render)
  await Promise.all([...representative.entries()].map(async ([fid, { jsEntry, filename }]) => {
    try {
      const blob    = await jsEntry.async('blob');
      const blobUrl = URL.createObjectURL(blob);
      const img     = new Image();
      img.addEventListener('load', render, { once: true });
      img.src = blobUrl;
      assetLib.set(fid, { blobUrl, img, filename });
    } catch { /* skip corrupt entries */ }
  }));

  status.textContent = `${allFolders.length} folders ready`;
  document.getElementById('folder-count').textContent = `${allFolders.length}`;

  buildTagDropdown();
  renderFolderRail();

  // Set initial brush to first folder
  if (allFolders.length) selectBrush(allFolders[0]);

  render(); // final pass with all sprites loaded
}

boot();
