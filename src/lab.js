import JSZip from 'jszip';

// ── Zip index ──────────────────────────────────────────────────────────────────
// Built by parsing assets_01.zip and assets_02.zip on boot.
// Maps  folderName → [{ filename, fullPath, zip }]
// The JSZip instances stay alive in memory so folder selection only needs
// in-process decompression — no further network requests after boot.
const zipIndex  = new Map();

// folderMap: folderName → [{ filename, url, blobUrl }]
// url     = canonical /raw-assets/FOLDER/FILE.png  (permanent, used for curation)
// blobUrl = URL.createObjectURL blob               (ephemeral, revoked on switch)
const folderMap = new Map();
let allFolders  = [];

// ── Astonia character animation config ────────────────────────────────────────
const ASTONIA_ANIMATION_MAP = [
  { name: 'idle',           framesPerDir: 1 },
  { name: 'walk',           framesPerDir: 8 },
  { name: 'grab',           framesPerDir: 4 },
  { name: 'pickup',         framesPerDir: 4 },
  { name: 'attack_neutral', framesPerDir: 4 },
  { name: 'attack_high',    framesPerDir: 4 },
  { name: 'shove',          framesPerDir: 4 },
  { name: 'cast_neutral',   framesPerDir: 8 },
  { name: 'cast_high',      framesPerDir: 4 },
  { name: 'die',            framesPerDir: 4 },
];
const DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
// Total frames = sum(framesPerDir) × 8 dirs = 45 × 8 = 360
const ASTONIA_TOTAL_FRAMES =
  ASTONIA_ANIMATION_MAP.reduce((s, a) => s + a.framesPerDir, 0) * DIRECTIONS.length;

// ── Persistent state ───────────────────────────────────────────────────────────
let curated = JSON.parse(localStorage.getItem('lab-curated') ?? '{}');

// ── Map editor state ───────────────────────────────────────────────────────────
const CELL_SIZE     = 40;
let   mapCols       = 16;
let   mapRows       = 16;
let   mapGrid       = [];        // [row][col] → tileId; 0 = empty
let   activeBrush   = null;      // null = no brush  |  0 = erase  |  N = tile ID
let   isPainting    = false;
let   hoverCell     = null;      // { col, row } | null
let   mapCanvas     = null;
let   mapCtx        = null;
let   mapInitialized = false;

// Blob URLs promoted out of activeBlobUrls at curation/load time so the canvas
// can render sprites even after the user switches folders (which revokes ephemeral URLs).
const tileImageMap = new Map();  // tileId → blob URL string  (never revoked)
const tileImageEls = new Map();  // tileId → HTMLImageElement (loaded lazily)

// ── Collections state ─────────────────────────────────────────────────────────
let collections       = JSON.parse(localStorage.getItem('lab-collections') ?? '[]');
// { id, name, type, urls: string[] }
let activeCollectionId = null;

// ── Batch slicer state ────────────────────────────────────────────────────────
let slicerActions   = [{ name: 'idle', frames: 4 }, { name: 'walk', frames: 8 }];
let generatedStates = [];   // [{ key: string, files: FileEntry[] }]

// ── Multi-select state ─────────────────────────────────────────────────────────
const multiSelected  = new Set();   // canonical URLs currently highlighted
let   lastClickedIdx = -1;          // grid index of last plain/ctrl click (for shift-range)
let   currentGridFiles = [];        // files array currently rendered in the grid

// ── Runtime state ──────────────────────────────────────────────────────────────
let activeFolder   = null;
let selectedEntry  = null;
let activeBlobUrls = [];  // revoked when the user switches folders

let flipFiles   = [];
let flipIdx     = 0;
let flipFps     = 12;
let flipPlaying = true;
let flipTimer   = null;

// ── DOM shorthand ──────────────────────────────────────────────────────────────
const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

// ── Boot ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => { loadAssetPacks(); });

// ── Loading UI helpers ─────────────────────────────────────────────────────────

function setStatus(msg, isError = false) {
  const el = $('ld-status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function updateBar(idx, received, total) {
  const fill = $(`ld-fill-${idx + 1}`);
  const pct  = $(`ld-pct-${idx + 1}`);
  const prog = $(`ld-prog-${idx + 1}`);

  if (total > 0) {
    const pctVal = Math.min(100, Math.round(received / total * 100));
    fill.classList.remove('indeterminate');
    fill.style.width = `${pctVal}%`;
    pct.textContent  = `${pctVal}%`;
    prog.setAttribute('aria-valuenow', pctVal);
  } else {
    // Content-Length header absent — show shimmer + bytes received
    fill.classList.add('indeterminate');
    pct.textContent = received > 0
      ? `${(received / 1_048_576).toFixed(1)} MB`
      : '—';
  }
}

function hideOverlay() {
  const el = $('lab-loading');
  el.classList.add('done');
  el.addEventListener('transitionend', () => { el.hidden = true; }, { once: true });
}

// ── Streaming fetch with per-file progress ─────────────────────────────────────
// Streams the response body for live progress, then assembles via Blob.arrayBuffer()
// which is more reliable than manual Uint8Array copy for large binary payloads.
async function fetchWithProgress(url, barIdx) {
  const res = await fetch(url);

  const contentType = res.headers.get('content-type') ?? '';
  console.log(`[lab] ${url} → HTTP ${res.status}  Content-Type: ${contentType}`);

  if (!res.ok) {
    throw new Error(`"${url}" not found — HTTP ${res.status}`);
  }
  if (contentType.includes('text/html')) {
    throw new Error(`"${url}" returned an HTML page instead of a zip file — the path is incorrect`);
  }

  const total  = parseInt(res.headers.get('content-length') || '0', 10);
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;

  updateBar(barIdx, 0, total);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    updateBar(barIdx, received, total);
  }

  updateBar(barIdx, received, received || 1);

  // Blob handles binary concatenation natively — avoids off-by-one errors in
  // manual Uint8Array assembly that can silently corrupt the zip end-of-central-dir.
  return new Blob(chunks).arrayBuffer();
}

// ── Parse a JSZip instance into a folder → entries map ────────────────────────
// Expected zip structure:  FOLDERNAME/filename.png
// Files at the root level (no slash in path) are skipped.
function indexZip(zip) {
  const map = new Map();

  for (const [filePath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (!filePath.toLowerCase().endsWith('.png')) continue;

    const slash  = filePath.indexOf('/');
    if (slash === -1) continue;               // root-level file — skip

    const folder = filePath.slice(0, slash);
    const fname  = filePath.slice(slash + 1);
    if (!fname) continue;                     // bare directory path — skip

    if (!map.has(folder)) map.set(folder, []);
    map.get(folder).push({ filename: fname, fullPath: filePath, zip });
  }

  return map;
}

// ── Main boot: download both zips in parallel, merge, then start the UI ───────
async function loadAssetPacks() {
  try {
    setStatus('Downloading asset packs…');

    // Fetch both zip files simultaneously — bars update independently as bytes arrive
    const [buf1, buf2] = await Promise.all([
      fetchWithProgress('/raw-assets/assets_01.zip', 0),
      fetchWithProgress('/raw-assets/assets_02.zip', 1),
    ]);

    setStatus('Parsing assets_01.zip…');
    let zip1;
    try {
      zip1 = await JSZip.loadAsync(buf1);
    } catch (e) {
      throw new Error(`assets_01.zip — invalid zip: ${e.message}`);
    }

    setStatus('Parsing assets_02.zip…');
    let zip2;
    try {
      zip2 = await JSZip.loadAsync(buf2);
    } catch (e) {
      throw new Error(`assets_02.zip — invalid zip: ${e.message}`);
    }

    setStatus('Merging folders…');

    // Index each zip then merge — folders that appear in both archives are combined
    for (const [folder, entries] of indexZip(zip1)) {
      zipIndex.set(folder, entries);
    }
    for (const [folder, entries] of indexZip(zip2)) {
      if (zipIndex.has(folder)) {
        zipIndex.get(folder).push(...entries);
      } else {
        zipIndex.set(folder, [...entries]);
      }
    }

    // Sort files within every folder by numeric filename
    for (const entries of zipIndex.values()) {
      entries.sort((a, b) =>
        a.filename.localeCompare(b.filename, undefined, { numeric: true }));
    }

    // Build folderMap: canonical URLs only — blob URLs are created on folder select
    for (const [folder, entries] of zipIndex) {
      folderMap.set(folder, entries.map(({ filename }) => ({
        filename,
        url:    `/raw-assets/${folder}/${filename}`,
        blobUrl: null,
      })));
    }
    allFolders = [...folderMap.keys()].sort();

    const total = [...folderMap.values()].reduce((s, f) => s + f.length, 0);
    setStatus(`${allFolders.length} folders · ${total.toLocaleString()} sprites ready`);

    hideOverlay();
    bootUI();

  } catch (err) {
    console.error('[lab] Failed to load asset packs:', err);
    setStatus(`Error: ${err.message}`, true);
  }
}

// ── UI boot (runs after zips are merged) ──────────────────────────────────────
function bootUI() {
  const totalFiles = [...folderMap.values()].reduce((s, f) => s + f.length, 0);
  $('lab-stats').textContent =
    `${allFolders.length} folders · ${totalFiles.toLocaleString()} sprites`;
  $('folder-count').textContent = allFolders.length;

  buildFolderList(allFolders);
  renderCuratedList();
  renderCollectionsList();
  updateSelectionCount();
  renderSlicerActionList();
  updateDirPreview();
  bindEvents();
  bindMapEditorEvents();
}

// ── Left pane: folder list ─────────────────────────────────────────────────────
function buildFolderList(names) {
  const list = $('folder-list');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const name of names) {
    const count    = folderMap.get(name)?.length ?? 0;
    const isActive = name === activeFolder;
    const div      = document.createElement('div');
    div.className      = 'folder-item' + (isActive ? ' active' : '');
    div.dataset.folder = name;
    div.setAttribute('role', 'listitem');
    div.setAttribute('tabindex', '0');
    div.setAttribute('aria-selected', isActive);
    div.setAttribute('aria-label', `${name}, ${count} sprites`);
    div.innerHTML =
      `<span class="fi-name">${name}</span><span class="fi-count">${count}</span>`;
    const activate = () => selectFolder(name);
    div.addEventListener('click', activate);
    div.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
    frag.appendChild(div);
  }
  list.appendChild(frag);
}

// ── Folder selection — extract from in-memory zip (no network request) ────────
async function selectFolder(name) {
  for (const u of activeBlobUrls) URL.revokeObjectURL(u);
  activeBlobUrls = [];

  activeFolder       = name;
  activeCollectionId = null;
  clearMultiSelect();
  renderCollectionsList();
  $$('.folder-item').forEach(el => {
    const on = el.dataset.folder === name;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', on);
  });

  $('flip-folder-name').textContent = `${name}  (extracting…)`;
  startFlipbook([]);
  buildGrid([]);

  try {
    const indexEntries = zipIndex.get(name) ?? [];

    // Decompress each PNG from the in-memory JSZip instance and create a blob URL
    const files = await Promise.all(indexEntries.map(async ({ filename, fullPath, zip }) => {
      const blob   = await zip.files[fullPath].async('blob');
      const blobUrl = URL.createObjectURL(blob);
      activeBlobUrls.push(blobUrl);
      return {
        filename,
        url:    `/raw-assets/${name}/${filename}`,  // canonical — for curation
        blobUrl,                                     // ephemeral — for display
      };
    }));

    folderMap.set(name, files);

    // Promote blob URLs for any curated tiles found in this folder so the map
    // editor can render them even if the user later switches away.
    for (const [idStr, item] of Object.entries(curated)) {
      const tileId = Number(idStr);
      if (tileImageMap.has(tileId)) continue;
      const file = files.find(f => f.url === item.src);
      if (!file?.blobUrl) continue;
      tileImageMap.set(tileId, file.blobUrl);
      tileImageEls.delete(tileId);
      activeBlobUrls = activeBlobUrls.filter(u => u !== file.blobUrl);
    }

    $('flip-folder-name').textContent = `${name}  (${files.length})`;
    startFlipbook(files);
    buildGrid(files);

  } catch (err) {
    console.error(`[lab] Failed to extract folder ${name}:`, err);
    $('flip-folder-name').textContent = `${name}  (error)`;
    buildGrid([]);
  }
}

// ── Center pane: flipbook ──────────────────────────────────────────────────────
function startFlipbook(files) {
  flipFiles = files;
  flipIdx   = 0;
  renderFlipFrame();
  if (flipPlaying) restartFlipTimer();
}

function renderFlipFrame() {
  const img     = $('flip-img');
  const empty   = $('flip-empty');
  const counter = $('flip-counter');
  const fname   = $('flip-filename');

  if (!flipFiles.length) {
    img.style.display   = 'none';
    empty.style.display = '';
    counter.textContent = '';
    fname.textContent   = '';
    return;
  }
  const entry = flipFiles[flipIdx];
  img.src             = entry.blobUrl ?? entry.url;
  img.alt             = entry.filename;
  img.style.display   = 'block';
  empty.style.display = 'none';
  counter.textContent = `${flipIdx + 1} / ${flipFiles.length}`;
  fname.textContent   = entry.filename;
}

function restartFlipTimer() {
  clearInterval(flipTimer);
  flipTimer = setInterval(() => {
    if (!flipFiles.length) return;
    flipIdx = (flipIdx + 1) % flipFiles.length;
    renderFlipFrame();
  }, 1000 / flipFps);
}

// ── Center pane: sprite grid ───────────────────────────────────────────────────
function buildGrid(files) {
  currentGridFiles = files;
  updateAstoniaBar(files.length);
  const grid = $('sprite-grid');
  grid.innerHTML = '';

  if (!files.length) {
    grid.innerHTML = '<div id="grid-empty">This folder is empty.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  files.forEach((f, idx) => {
    const cell = document.createElement('div');
    let cls = 'grid-cell';
    if (isCurated(f.url))        cls += ' curated';
    if (multiSelected.has(f.url)) cls += ' multi-sel';
    cell.className        = cls;
    cell.dataset.url      = f.url;
    cell.dataset.filename = f.filename;
    cell.dataset.gridIdx  = idx;
    cell.title            = f.filename;
    cell.setAttribute('role', 'listitem');
    cell.setAttribute('tabindex', '0');
    cell.setAttribute('aria-label', f.filename);

    const img   = document.createElement('img');
    img.src     = f.blobUrl ?? f.url;
    img.alt     = f.filename;
    img.loading = 'lazy';
    cell.appendChild(img);

    cell.addEventListener('click', e => handleGridClick(e, f, idx));
    cell.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleGridClick(e, f, idx); }
    });
    frag.appendChild(cell);
  });
  grid.appendChild(frag);
  $('grid-wrap').scrollTop = 0;
}

function handleGridClick(e, entry, idx) {
  if (e.shiftKey && lastClickedIdx >= 0) {
    // Range: add every URL between lastClickedIdx and idx (inclusive)
    const lo = Math.min(lastClickedIdx, idx);
    const hi = Math.max(lastClickedIdx, idx);
    for (let i = lo; i <= hi; i++) {
      if (currentGridFiles[i]) multiSelected.add(currentGridFiles[i].url);
    }
  } else if (e.ctrlKey || e.metaKey) {
    // Toggle individual frame
    if (multiSelected.has(entry.url)) multiSelected.delete(entry.url);
    else                              multiSelected.add(entry.url);
    lastClickedIdx = idx;
  } else {
    // Plain click — single select; also updates curation panel
    multiSelected.clear();
    multiSelected.add(entry.url);
    lastClickedIdx = idx;
    selectSprite(entry);
  }
  refreshMultiSelBadges();
  updateSelectionCount();
}

function isCurated(url) {
  return Object.values(curated).some(item => item.src === url);
}

function refreshMultiSelBadges() {
  $$('.grid-cell').forEach(el =>
    el.classList.toggle('multi-sel', multiSelected.has(el.dataset.url)));
}

function updateSelectionCount() {
  const n = multiSelected.size;
  $('coll-sel-count').textContent =
    n === 0 ? '0 selected' : n === 1 ? '1 frame selected' : `${n} frames selected`;
  const btn = $('coll-create-btn');
  btn.disabled = n === 0;
  btn.toggleAttribute('aria-disabled', n === 0);
}

function clearMultiSelect() {
  multiSelected.clear();
  lastClickedIdx = -1;
  refreshMultiSelBadges();
  updateSelectionCount();
}

// ── Sprite selection ───────────────────────────────────────────────────────────
function selectSprite(entry) {
  selectedEntry = entry;

  $$('.grid-cell').forEach(el =>
    el.classList.toggle('selected', el.dataset.url === entry.url));

  const idx = flipFiles.findIndex(f => f.url === entry.url);
  if (idx !== -1) { flipIdx = idx; renderFlipFrame(); }

  $('curate-filename').textContent = entry.filename;
  $('curate-filename').classList.add('has-file');
  $('curate-name').value = entry.filename.replace(/\.[^.]+$/, '');

  const thumb = $('curate-thumb');
  thumb.innerHTML = '';
  const img = document.createElement('img');
  img.src = entry.blobUrl ?? entry.url;
  thumb.appendChild(img);

  const usedIds = Object.keys(curated).map(Number);
  $('curate-id').value = usedIds.length ? Math.max(...usedIds) + 1 : 1;
  const addBtn = $('curate-add');
  addBtn.disabled = false;
  addBtn.removeAttribute('aria-disabled');
}

// ── Right pane: curation ───────────────────────────────────────────────────────
// Always stores canonical entry.url — not blob URLs, which are session-ephemeral
// and revoked when the user switches folders.
function addToDict() {
  if (!selectedEntry) return;
  const id  = parseInt($('curate-id').value, 10);
  const cat = $('curate-category').value;
  const nm  = $('curate-name').value.trim() || selectedEntry.filename.replace(/\.[^.]+$/, '');

  if (!id || id < 1) { alert('Enter a valid ID ≥ 1.'); return; }

  curated[id] = {
    type:     cat,
    src:      selectedEntry.url,
    name:     nm,
    fallback: defaultFallback(cat),
  };

  // Promote the blob URL out of the revoke pool so the map editor can always render
  // this tile even after the user switches to a different folder.
  if (selectedEntry.blobUrl) {
    tileImageMap.set(id, selectedEntry.blobUrl);
    tileImageEls.delete(id);
    activeBlobUrls = activeBlobUrls.filter(u => u !== selectedEntry.blobUrl);
  }

  saveCurated();
  renderCuratedList();

  $$('.grid-cell').forEach(el => {
    if (el.dataset.url === selectedEntry.url) el.classList.add('curated');
  });

  $('curate-id').value = id + 1;
}

function defaultFallback(cat) {
  return {
    floor:  { fill: '#3a3a4a', border: '#5a5a7a' },
    wall:   { fill: '#1a2230', border: '#2a3a50' },
    prop:   { fill: '#4a3a1a', border: '#7a6a2a' },
    entity: { fill: '#ff4500', border: '#ff6a00' },
  }[cat] ?? { fill: '#333344', border: '#555566' };
}

function saveCurated() {
  localStorage.setItem('lab-curated', JSON.stringify(curated));
}

function renderCuratedList() {
  const list    = $('curate-list');
  const entries = Object.entries(curated).sort(([a], [b]) => Number(a) - Number(b));
  $('curate-count').textContent = entries.length;

  if (!entries.length) {
    list.innerHTML = '<div class="cl-empty">No items yet.</div>';
    $('curate-json').value = '';
    return;
  }

  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const [id, item] of entries) {
    const row = document.createElement('div');
    row.className = 'cl-row';
    row.innerHTML = `
      <span class="cl-id">${id}</span>
      <span class="cl-type cl-type-${item.type}">${item.type}</span>
      <span class="cl-name" title="${item.src}">${item.name}</span>
      <button class="cl-del" data-id="${id}" title="Remove">×</button>
    `;
    row.dataset.tileId = id;
    row.querySelector('.cl-del').addEventListener('click', e => {
      delete curated[e.currentTarget.dataset.id];
      saveCurated();
      renderCuratedList();
      refreshCuratedBadges();
    });
    // Clicking the row (not the delete button) selects this tile as the active brush
    row.addEventListener('click', e => {
      if (e.target.closest('.cl-del')) return;
      selectBrush(Number(id));
    });
    frag.appendChild(row);
  }
  list.appendChild(frag);

  updateJsonPreview(entries);
}

function refreshCuratedBadges() {
  $$('.grid-cell').forEach(el => {
    el.classList.toggle('curated', isCurated(el.dataset.url));
  });
}

function updateJsonPreview(entries) {
  const lines = ['{'];
  for (const [id, item] of entries) {
    const fb          = `{ fill: '${item.fallback.fill}', border: '${item.fallback.border}' }`;
    const framesNote  = item.frames?.length ? ` [${item.frames.length} frames]` : '';
    lines.push(
      `  ${id}: { type: '${item.type}', src: '${item.src}',` +
      ` fallback: ${fb} }, //${framesNote} ${item.name}`
    );
  }
  lines.push('}');
  $('curate-json').value = lines.join('\n');
}

// ── Map editor ────────────────────────────────────────────────────────────────

function initMapGrid(cols, rows) {
  mapCols = cols;
  mapRows = rows;
  mapGrid = Array.from({ length: rows }, () => new Array(cols).fill(0));
}

function initMapCanvas() {
  mapCanvas = $('map-canvas');
  mapCtx    = mapCanvas.getContext('2d');
  resizeMapCanvas();
  bindMapCanvasEvents();
  redrawCanvas();
}

function resizeMapCanvas() {
  mapCanvas.width  = mapCols * CELL_SIZE;
  mapCanvas.height = mapRows * CELL_SIZE;
}

// Returns a loaded HTMLImageElement for the tile, or null if no image is available.
// Triggers a redraw when the image finishes loading.
function getTileImgEl(tileId) {
  if (tileImageEls.has(tileId)) return tileImageEls.get(tileId);
  const url = tileImageMap.get(tileId);
  if (!url) return null;
  const img = new Image();
  img.onload = () => redrawCanvas();
  img.src = url;
  tileImageEls.set(tileId, img);
  return img;
}

function hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function redrawCanvas() {
  if (!mapCtx) return;
  const ctx = mapCtx;
  ctx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);

  for (let row = 0; row < mapRows; row++) {
    for (let col = 0; col < mapCols; col++) {
      const x      = col * CELL_SIZE;
      const y      = row * CELL_SIZE;
      const tileId = mapGrid[row][col];

      // Cell fill
      ctx.fillStyle = tileId === 0
        ? '#0a0d14'
        : (curated[tileId]?.fallback?.fill ?? '#1a2030');
      ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);

      if (tileId !== 0) {
        // Sprite image
        const img = getTileImgEl(tileId);
        if (img?.complete && img.naturalWidth > 0) {
          ctx.drawImage(img, x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
        }
        // Tile-ID label
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x + 1, y + CELL_SIZE - 14, CELL_SIZE - 2, 13);
        ctx.fillStyle = '#e5e7eb';
        ctx.font = 'bold 9px monospace';
        ctx.textBaseline = 'bottom';
        ctx.fillText(String(tileId), x + 3, y + CELL_SIZE - 2);
        ctx.textBaseline = 'alphabetic';
      }

      // Grid lines
      ctx.strokeStyle = tileId === 0 ? '#1f2937' : 'rgba(0,0,0,0.28)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, CELL_SIZE - 1, CELL_SIZE - 1);
    }
  }

  // Hover overlay
  if (hoverCell) {
    const { col, row } = hoverCell;
    const x = col * CELL_SIZE;
    const y = row * CELL_SIZE;

    if (activeBrush === 0) {
      ctx.fillStyle = 'rgba(248,113,113,0.22)';
      ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
      ctx.strokeStyle = 'rgba(248,113,113,0.8)';
    } else if (activeBrush !== null) {
      const entry = curated[activeBrush];
      if (entry?.fallback?.fill) {
        ctx.fillStyle = hexToRgba(entry.fallback.fill, 0.45);
        ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
      }
      const img = getTileImgEl(activeBrush);
      if (img?.complete && img.naturalWidth > 0) {
        ctx.globalAlpha = 0.65;
        ctx.drawImage(img, x + 1, y + 1, CELL_SIZE - 2, CELL_SIZE - 2);
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = 'rgba(56,189,248,0.75)';
    } else {
      ctx.fillStyle = 'rgba(56,189,248,0.08)';
      ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
      ctx.strokeStyle = 'rgba(56,189,248,0.35)';
    }
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.5, y + 0.5, CELL_SIZE - 1, CELL_SIZE - 1);
  }
}

function getCanvasCell(e) {
  const rect = mapCanvas.getBoundingClientRect();
  const col  = Math.floor((e.clientX - rect.left) / CELL_SIZE);
  const row  = Math.floor((e.clientY - rect.top)  / CELL_SIZE);
  if (col < 0 || col >= mapCols || row < 0 || row >= mapRows) return null;
  return { col, row };
}

function paintCell(col, row) {
  const val = activeBrush ?? 0;
  if (mapGrid[row][col] === val) return;
  mapGrid[row][col] = val;
  redrawCanvas();
}

function bindMapCanvasEvents() {
  mapCanvas.addEventListener('pointerdown', e => {
    if (activeBrush === null) return;
    isPainting = true;
    mapCanvas.setPointerCapture(e.pointerId);
    const cell = getCanvasCell(e);
    if (cell) paintCell(cell.col, cell.row);
  });

  mapCanvas.addEventListener('pointermove', e => {
    hoverCell = getCanvasCell(e);
    redrawCanvas();
    if (isPainting && activeBrush !== null) {
      if (hoverCell) paintCell(hoverCell.col, hoverCell.row);
    }
  });

  mapCanvas.addEventListener('pointerup',     () => { isPainting = false; });
  mapCanvas.addEventListener('pointercancel', () => { isPainting = false; hoverCell = null; });
  mapCanvas.addEventListener('pointerleave',  () => {
    if (!isPainting) { hoverCell = null; redrawCanvas(); }
  });
}

function selectBrush(tileId) {
  activeBrush = tileId;
  $('map-btn-erase').classList.remove('active');
  $('map-btn-erase').setAttribute('aria-pressed', 'false');
  updateBrushDisplay();
  $$('.cl-row').forEach(el =>
    el.classList.toggle('brush-sel', Number(el.dataset.tileId) === tileId));
  if (mapCtx) redrawCanvas();
}

function updateBrushDisplay() {
  const swatch = $('brush-swatch');
  const label  = $('brush-label-text');
  swatch.innerHTML = '';

  if (activeBrush === null) {
    swatch.style.background = 'var(--bg)';
    label.textContent = '— none —';
    label.style.color = 'var(--text-dim)';
  } else if (activeBrush === 0) {
    swatch.style.background = '#0a0d14';
    swatch.innerHTML = '<span style="color:#f87171;font-size:15px;line-height:1">×</span>';
    label.textContent = 'Erase';
    label.style.color = 'var(--orange)';
  } else {
    const entry = curated[activeBrush];
    swatch.style.background = entry?.fallback?.fill ?? 'var(--surface)';
    const blobUrl = tileImageMap.get(activeBrush);
    if (blobUrl) {
      const img = document.createElement('img');
      img.src = blobUrl;
      swatch.appendChild(img);
    }
    label.textContent = entry ? `#${activeBrush} · ${entry.name}` : `#${activeBrush}`;
    label.style.color = 'var(--text-hi)';
  }
}

function switchMode(mode) {
  const isMap = mode === 'map';
  $('sprites-view').style.display  = isMap ? 'none' : '';
  $('map-editor').classList.toggle('active', isMap);
  $$('.vtab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
    btn.setAttribute('aria-selected', String(btn.dataset.mode === mode));
  });
  if (isMap && !mapInitialized) {
    mapInitialized = true;
    initMapGrid(mapCols, mapRows);
    initMapCanvas();
  }
}

function downloadMapJson() {
  const mapName = ($('map-name-input').value.trim() || 'map').replace(/[^a-z0-9_\-]/gi, '_');
  const spawnX  = parseInt($('map-spawn-x').value, 10) || 1;
  const spawnZ  = parseInt($('map-spawn-z').value, 10) || 1;

  // Split grid into floor layer (tile IDs, 0 under props) and props list.
  const floor = [];
  const props = [];
  for (let r = 0; r < mapRows; r++) {
    const row = [];
    for (let c = 0; c < mapCols; c++) {
      const id = mapGrid[r][c];
      const def = curated[id];
      if (def?.type === 'prop') {
        row.push(def.floorBase ?? 1);   // auto-floor under prop
        props.push({ id, x: c, z: r });
      } else {
        row.push(id);
      }
    }
    floor.push(row);
  }

  const data = {
    name:  mapName,
    cols:  mapCols,
    rows:  mapRows,
    spawn: { x: spawnX, z: spawnZ },
    floor,
    props,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: `${mapName}.json` });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function bindMapEditorEvents() {
  $$('.vtab').forEach(btn =>
    btn.addEventListener('click', () => switchMode(btn.dataset.mode)));

  $('map-btn-resize').addEventListener('click', () => {
    const c = Math.max(4, Math.min(64, parseInt($('map-cols-input').value, 10) || 16));
    const r = Math.max(4, Math.min(64, parseInt($('map-rows-input').value, 10) || 16));
    initMapGrid(c, r);
    if (mapCanvas) { resizeMapCanvas(); redrawCanvas(); }
  });

  $('map-btn-erase').addEventListener('click', () => {
    const turning_on = activeBrush !== 0;
    activeBrush = turning_on ? 0 : null;
    $('map-btn-erase').classList.toggle('active', turning_on);
    $('map-btn-erase').setAttribute('aria-pressed', String(turning_on));
    if (turning_on) $$('.cl-row').forEach(el => el.classList.remove('brush-sel'));
    updateBrushDisplay();
    if (mapCtx) redrawCanvas();
  });

  $('map-btn-clear').addEventListener('click', () => {
    if (!confirm('Clear the entire map?')) return;
    initMapGrid(mapCols, mapRows);
    if (mapCtx) redrawCanvas();
  });

  $('map-btn-download').addEventListener('click', downloadMapJson);
}

// ── Copy config to clipboard ───────────────────────────────────────────────────
function copyConfig() {
  const entries = Object.entries(curated).sort(([a], [b]) => Number(a) - Number(b));
  if (!entries.length) { alert('Nothing curated yet.'); return; }

  const lines = ['{'];
  for (const [id, item] of entries) {
    const fb           = `{ fill: '${item.fallback.fill}', border: '${item.fallback.border}' }`;
    const framesClause = item.frames?.length
      ? `, frames: ${JSON.stringify(item.frames)}` : '';
    lines.push(
      `  ${id}: { type: '${item.type}', src: '${item.src}',${framesClause}` +
      ` fallback: ${fb} }, // ${item.name}`
    );
  }
  lines.push('}');

  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    const btn = $('curate-copy');
    btn.textContent = '✓ Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy Config'; btn.classList.remove('copied'); }, 2200);
  }).catch(() => alert('Clipboard write failed — check browser permissions.'));
}

// ── Collections ───────────────────────────────────────────────────────────────

function saveCollections() {
  localStorage.setItem('lab-collections', JSON.stringify(collections));
}

function createCollection() {
  if (multiSelected.size === 0) return;
  const name = $('coll-name-input').value.trim();
  if (!name) { $('coll-name-input').focus(); return; }
  const type = $('coll-type-select').value;
  collections.push({ id: Date.now().toString(36), name, type, urls: [...multiSelected] });
  saveCollections();
  renderCollectionsList();
  $('coll-name-input').value = '';
}

function renderCollectionsList() {
  const list = $('coll-list');
  $('coll-count').textContent = collections.length;

  if (!collections.length) {
    list.innerHTML = '<div class="cl-empty">No collections yet.</div>';
    return;
  }

  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const coll of collections) {
    const typeClass = {
      animation: 'coll-type-animation',
      tilemap:   'coll-type-tilemap',
      prop:      'coll-type-prop',
    }[coll.type] ?? '';

    const item = document.createElement('div');
    item.className    = 'coll-item' + (activeCollectionId === coll.id ? ' active-coll' : '');
    item.dataset.collId = coll.id;
    item.innerHTML = `
      <span class="coll-type-badge ${typeClass}">${coll.type}</span>
      <span class="coll-item-name" title="${coll.name}">${coll.name}</span>
      <span class="coll-item-count">${coll.urls.length}</span>
      <button class="coll-item-del" data-coll-id="${coll.id}" title="Delete collection">×</button>
    `;
    item.addEventListener('click', e => {
      if (e.target.closest('.coll-item-del')) return;
      loadCollection(coll.id);
    });
    item.querySelector('.coll-item-del').addEventListener('click', e => {
      e.stopPropagation();
      if (activeCollectionId === coll.id) activeCollectionId = null;
      collections = collections.filter(c => c.id !== coll.id);
      saveCollections();
      renderCollectionsList();
    });
    frag.appendChild(item);
  }
  list.appendChild(frag);
}

async function loadCollection(id) {
  const coll = collections.find(c => c.id === id);
  if (!coll) return;

  for (const u of activeBlobUrls) URL.revokeObjectURL(u);
  activeBlobUrls = [];

  activeCollectionId = id;
  activeFolder       = null;
  clearMultiSelect();

  $$('.folder-item').forEach(el => {
    el.classList.remove('active');
    el.setAttribute('aria-selected', 'false');
  });
  renderCollectionsList();

  $('flip-folder-name').textContent = `${coll.name}  (loading…)`;
  startFlipbook([]);
  buildGrid([]);

  try {
    const files = (await Promise.all(coll.urls.map(async url => {
      // url shape: /raw-assets/FOLDER/FILENAME.png
      const parts    = url.split('/').filter(Boolean); // ['raw-assets','FOLDER','FILE']
      if (parts.length < 3) return null;
      const folder   = parts[1];
      const filename = parts[2];

      // Reuse already-extracted blob if this folder was previously loaded
      const existing = folderMap.get(folder)?.find(f => f.url === url);
      if (existing?.blobUrl) return existing;

      const entry = (zipIndex.get(folder) ?? []).find(e => e.filename === filename);
      if (!entry) return null;

      try {
        const blob    = await entry.zip.files[`${folder}/${filename}`].async('blob');
        const blobUrl = URL.createObjectURL(blob);
        activeBlobUrls.push(blobUrl);
        return { filename, url, blobUrl };
      } catch { return null; }
    }))).filter(Boolean);

    $('flip-folder-name').textContent = `${coll.name}  (${files.length})`;
    startFlipbook(files);
    buildGrid(files);
  } catch (err) {
    console.error(`[lab] loadCollection "${coll.name}":`, err);
    $('flip-folder-name').textContent = `${coll.name}  (error)`;
  }
}

// ── Animation dictionary export ───────────────────────────────────────────────
// Produces the flat { stateName: [url,...] } JSON consumed by CharacterAnimator.
// Only includes 'entity' entries that have a frames array (i.e. sliced animations).
function downloadAnimDict() {
  const entityEntries = Object.entries(curated)
    .filter(([, item]) => item.type === 'entity' && item.frames?.length > 0);

  if (!entityEntries.length) {
    alert(
      'No animation states in the dictionary.\n' +
      'Process a character folder first using the Batch Slicer or the ⚡ Astonia button.'
    );
    return;
  }

  // Build name-keyed dict: { "baseId_action_dir": [url, url, ...] }
  const dict = {};
  for (const [, item] of entityEntries) {
    dict[item.name] = item.frames;
  }

  // Derive a filename from the first state's baseId prefix (everything before
  // the first underscore-separated action token).
  const firstName = entityEntries[0][1].name ?? 'character';
  const baseId    = firstName.split('_')[0] || 'character';

  const blob = new Blob([JSON.stringify(dict, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url, download: `${baseId}.json`,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Character Pack export ─────────────────────────────────────────────────────
// Bundles the animation JSON + every referenced sprite into a single zip.
// The user unzips the download directly into public/ and the paths resolve.
//
// Resulting zip layout:
//   animations/<baseId>.json          ← dict for CharacterAnimator
//   raw-assets/<baseId>/<frame>.png   ← sprite files served at /raw-assets/...
async function downloadCharacterPack() {
  const entityEntries = Object.entries(curated)
    .filter(([, item]) => item.type === 'entity' && item.frames?.length > 0);

  if (!entityEntries.length) {
    alert(
      'No animation states in the dictionary.\n' +
      'Process a character folder first using the ⚡ Astonia button or Batch Slicer.'
    );
    return;
  }

  const dict = {};
  const allUrls = new Set();
  for (const [, item] of entityEntries) {
    dict[item.name] = item.frames;
    for (const url of item.frames) allUrls.add(url);
  }

  const firstName = entityEntries[0][1].name ?? 'character';
  const baseId    = firstName.split('_')[0] || 'character';

  const btn = $('curate-pack-btn');
  if (btn) { btn.disabled = true; btn.textContent = '…packing'; }

  try {
    const pack = new JSZip();
    pack.file(`animations/${baseId}.json`, JSON.stringify(dict, null, 2));

    // Re-extract every unique sprite from the in-memory JSZip instances.
    let done = 0;
    for (const url of allUrls) {
      // url shape: /raw-assets/FOLDER/FILENAME.png
      const parts    = url.split('/').filter(Boolean);
      if (parts.length < 3) continue;
      const folder   = parts[1];
      const filename = parts[2];
      const entry    = (zipIndex.get(folder) ?? []).find(e => e.filename === filename);
      if (!entry) continue;
      try {
        const blob = await entry.zip.files[`${folder}/${filename}`].async('blob');
        pack.file(`raw-assets/${folder}/${filename}`, blob);
        done++;
      } catch { /* skip broken entry */ }
    }

    const zipBlob = await pack.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(zipBlob);
    const a   = Object.assign(document.createElement('a'), {
      href: url, download: `${baseId}_pack.zip`,
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    console.log(`[lab] Character pack: ${done} sprites + animations/${baseId}.json`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↓ Character Pack'; }
  }
}

function exportManifest() {
  if (!collections.length) { alert('No collections to export.'); return; }
  const manifest = {
    version:    1,
    exportedAt: new Date().toISOString(),
    collections: collections.map(c => ({ id: c.id, name: c.name, type: c.type, frames: c.urls })),
  };
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: 'asset-manifest.json' });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Curation mode toggle ──────────────────────────────────────────────────────
function switchCurationMode(mode) {
  const isSlicer = mode === 'slicer';
  $('curation-manual-section').style.display  = isSlicer ? 'none' : '';
  $('curation-slicer-section').classList.toggle('active', isSlicer);
  $$('.ctab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.ctab === mode);
    btn.setAttribute('aria-selected', String(btn.dataset.ctab === mode));
  });
}

// ── Batch slicer ──────────────────────────────────────────────────────────────

const DIR_PRESETS = {
  4:  ['south', 'west', 'north', 'east'],
  6:  ['south', 'south_west', 'west', 'north', 'north_east', 'east'],
  8:  ['south', 'south_west', 'west', 'north_west', 'north', 'north_east', 'east', 'south_east'],
  16: ['s','ssw','sw','wsw','w','wnw','nw','nnw','n','nne','ne','ene','e','ese','se','sse'],
};

function getDirectionNames(n) {
  return DIR_PRESETS[n] ?? Array.from({ length: n }, (_, i) => `dir${i}`);
}

function updateDirPreview() {
  const n    = Math.max(1, parseInt($('slicer-dirs').value, 10) || 8);
  const dirs = getDirectionNames(n);
  $('slicer-dir-preview').textContent = dirs.join(' · ');
}

function renderSlicerActionList() {
  const container = $('slicer-actions-list');
  container.innerHTML = '';
  slicerActions.forEach((action, idx) => {
    const row = document.createElement('div');
    row.className = 'slicer-action-row';
    row.setAttribute('role', 'listitem');
    row.innerHTML = `
      <input class="map-dim-input" type="text"
             placeholder="action name" value="${action.name}"
             style="flex:1;width:auto;text-align:left"
             data-idx="${idx}" data-field="name"
             aria-label="Action name">
      <input class="map-dim-input" type="number" min="1" max="9999"
             value="${action.frames}"
             data-idx="${idx}" data-field="frames"
             aria-label="Frame count" title="Number of frames">
      <button class="slicer-del-btn" data-idx="${idx}" title="Remove action"
              aria-label="Remove action ${idx + 1}">×</button>
    `;
    row.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('input', () => {
        const i = Number(inp.dataset.idx);
        if (inp.dataset.field === 'name') {
          slicerActions[i].name = inp.value;
        } else {
          slicerActions[i].frames = Math.max(1, parseInt(inp.value, 10) || 1);
        }
      });
    });
    row.querySelector('.slicer-del-btn').addEventListener('click', () => {
      slicerActions.splice(idx, 1);
      if (!slicerActions.length) slicerActions.push({ name: 'idle', frames: 4 });
      renderSlicerActionList();
    });
    container.appendChild(row);
  });
}

function generateStates() {
  const baseId  = ($('slicer-base-id').value.trim() || 'character')
    .replace(/\s+/g, '_').replace(/[^a-z0-9_\-]/gi, '');
  const numDirs = Math.max(1, parseInt($('slicer-dirs').value, 10) || 8);
  const dirNames = getDirectionNames(numDirs);

  const actions = slicerActions.filter(a => a.name.trim() && a.frames > 0);
  if (!actions.length) { alert('Add at least one named action.'); return; }

  const files = currentGridFiles;
  if (!files.length) { alert('Select a folder first.'); return; }

  const framesPerDir = actions.reduce((s, a) => s + a.frames, 0);
  const totalNeeded  = framesPerDir * numDirs;
  if (files.length < totalNeeded) {
    alert(
      `Need ${totalNeeded} frames (${numDirs} dirs × ${framesPerDir} frames/dir)\n` +
      `but folder only has ${files.length} files.\n\n` +
      `Reduce directions or action frame counts.`
    );
    return;
  }

  generatedStates = [];
  let frameIdx = 0;
  for (let d = 0; d < numDirs; d++) {
    for (const action of actions) {
      const key        = `${baseId}_${dirNames[d]}_${action.name.trim()}`;
      const stateFiles = files.slice(frameIdx, frameIdx + action.frames);
      generatedStates.push({ key, files: stateFiles });
      frameIdx += action.frames;
    }
  }

  renderStatesDropdown();
  $('slicer-stats').textContent =
    `${generatedStates.length} states · ${totalNeeded} frames consumed · ${files.length - totalNeeded} unused`;

  if (generatedStates.length) previewGeneratedState(0);
}

function renderStatesDropdown() {
  const sel = $('slicer-state-select');
  sel.innerHTML = '';
  if (!generatedStates.length) {
    sel.innerHTML = '<option disabled selected>— generate first —</option>';
    return;
  }
  generatedStates.forEach((s, i) => {
    const opt = document.createElement('option');
    opt.value       = i;
    opt.textContent = `${s.key}  (${s.files.length}f)`;
    sel.appendChild(opt);
  });
  sel.selectedIndex = 0;
}

function previewGeneratedState(idx) {
  const state = generatedStates[idx];
  if (!state) return;
  $('flip-folder-name').textContent = `${state.key}  (${state.files.length})`;
  startFlipbook(state.files);
}

function appendStatesDictionary() {
  if (!generatedStates.length) { alert('Generate states first.'); return; }

  const usedIds = Object.keys(curated).map(Number);
  let nextId    = usedIds.length ? Math.max(...usedIds) + 1 : 1;

  for (const state of generatedStates) {
    const firstFile = state.files[0];
    curated[nextId] = {
      type:     'entity',
      src:      firstFile?.url ?? '',
      frames:   state.files.map(f => f.url),
      name:     state.key,
      fallback: defaultFallback('entity'),
    };
    // Promote first-frame blob URL so map editor can render the entity tile
    if (firstFile?.blobUrl) {
      tileImageMap.set(nextId, firstFile.blobUrl);
      tileImageEls.delete(nextId);
      activeBlobUrls = activeBlobUrls.filter(u => u !== firstFile.blobUrl);
    }
    nextId++;
  }

  saveCurated();
  renderCuratedList();
  $('curate-id').value = nextId;

  const msg = `${generatedStates.length} states appended (IDs ${nextId - generatedStates.length}–${nextId - 1}).`;
  $('slicer-stats').textContent = msg;
}

// ── Astonia character slicer ──────────────────────────────────────────────────

/**
 * Slices rawFrames (360 files, Action-major / Direction-minor order) into
 * named animation states using ASTONIA_ANIMATION_MAP × DIRECTIONS.
 * Returns the same [{ key, files }] shape used by the generic batch slicer.
 */
function sliceAstoniaCharacter(baseId, rawFrames) {
  const states = [];
  let frameIdx = 0;

  for (const action of ASTONIA_ANIMATION_MAP) {
    for (const dir of DIRECTIONS) {
      const key        = `${baseId}_${action.name}_${dir}`;
      const stateFiles = rawFrames.slice(frameIdx, frameIdx + action.framesPerDir);
      states.push({ key, files: stateFiles });
      frameIdx += action.framesPerDir;
    }
  }

  return states;
}

function processAstoniaCharacter() {
  if (currentGridFiles.length !== ASTONIA_TOTAL_FRAMES) return;

  const rawId  = $('astonia-base-id').value.trim() || activeFolder || 'character';
  const baseId = rawId.replace(/\s+/g, '_').replace(/[^a-z0-9_\-]/gi, '') || 'character';

  const states = sliceAstoniaCharacter(baseId, currentGridFiles);

  const usedIds = Object.keys(curated).map(Number);
  let nextId    = usedIds.length ? Math.max(...usedIds) + 1 : 1;
  const startId = nextId;

  for (const state of states) {
    const firstFile = state.files[0];
    curated[nextId] = {
      type:     'entity',
      src:      firstFile?.url ?? '',
      frames:   state.files.map(f => f.url),
      name:     state.key,
      fallback: defaultFallback('entity'),
    };
    if (firstFile?.blobUrl) {
      tileImageMap.set(nextId, firstFile.blobUrl);
      tileImageEls.delete(nextId);
      activeBlobUrls = activeBlobUrls.filter(u => u !== firstFile.blobUrl);
    }
    nextId++;
  }

  saveCurated();
  renderCuratedList();
  $('curate-id').value = nextId;

  // Mirror into generatedStates so the Batch Slicer dropdown reflects this run
  generatedStates = states;
  renderStatesDropdown();

  $('astonia-status').textContent =
    `✓ ${states.length} states appended · IDs ${startId}–${nextId - 1}`;
}

function updateAstoniaBar(fileCount) {
  const bar = $('astonia-quick-bar');
  if (!bar) return;
  const match = fileCount === ASTONIA_TOTAL_FRAMES;
  bar.hidden = !match;
  $('astonia-status').textContent = '';
  if (match && activeFolder) {
    const suggested = activeFolder.toLowerCase()
      .replace(/\s+/g, '_').replace(/[^a-z0-9_\-]/gi, '');
    $('astonia-base-id').value = suggested;
  }
}

function bindSlicerEvents() {
  $$('.ctab').forEach(btn =>
    btn.addEventListener('click', () => switchCurationMode(btn.dataset.ctab)));

  $('slicer-dirs').addEventListener('input', updateDirPreview);

  $('slicer-add-action').addEventListener('click', () => {
    slicerActions.push({ name: '', frames: 4 });
    renderSlicerActionList();
  });

  $('slicer-generate').addEventListener('click', generateStates);

  $('slicer-state-select').addEventListener('change', e => {
    previewGeneratedState(Number(e.target.value));
  });

  $('slicer-append').addEventListener('click', appendStatesDictionary);

  $('astonia-process-btn').addEventListener('click', processAstoniaCharacter);
}

function switchRightTab(tab) {
  const isColl = tab === 'collections';
  $('right-curation-panel').style.display = isColl ? 'none' : '';
  $('right-collections-panel').classList.toggle('active', isColl);
  $$('.rtab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.rtab === tab);
    btn.setAttribute('aria-selected', String(btn.dataset.rtab === tab));
  });
}

// ── Event bindings ─────────────────────────────────────────────────────────────
function bindEvents() {
  $('lib-search').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    buildFolderList(q ? allFolders.filter(n => n.toLowerCase().includes(q)) : allFolders);
  });

  $('flip-fps').addEventListener('input', e => {
    flipFps = parseInt(e.target.value, 10);
    $('flip-fps-val').textContent = flipFps;
    e.target.setAttribute('aria-valuetext', `${flipFps} frames per second`);
    if (flipPlaying) restartFlipTimer();
  });

  $('flip-play').addEventListener('click', () => {
    flipPlaying = !flipPlaying;
    const btn = $('flip-play');
    btn.textContent = flipPlaying ? '⏸' : '▶';
    btn.classList.toggle('active', flipPlaying);
    btn.setAttribute('aria-pressed', flipPlaying);
    btn.setAttribute('aria-label', flipPlaying ? 'Pause playback' : 'Play animation');
    if (flipPlaying) restartFlipTimer();
    else clearInterval(flipTimer);
  });

  $('flip-prev').addEventListener('click', () => {
    if (!flipFiles.length) return;
    flipIdx = (flipIdx - 1 + flipFiles.length) % flipFiles.length;
    renderFlipFrame();
  });

  $('flip-next').addEventListener('click', () => {
    if (!flipFiles.length) return;
    flipIdx = (flipIdx + 1) % flipFiles.length;
    renderFlipFrame();
  });

  // Right pane tabs
  $$('.rtab').forEach(btn =>
    btn.addEventListener('click', () => switchRightTab(btn.dataset.rtab)));

  // Collections panel
  $('coll-sel-clear').addEventListener('click', () => {
    clearMultiSelect();
    // Also deselect the single-curation selection
    $$('.grid-cell').forEach(el => el.classList.remove('selected'));
    selectedEntry = null;
  });
  $('coll-create-btn').addEventListener('click', createCollection);
  $('coll-export-btn').addEventListener('click', exportManifest);

  $('curate-add').addEventListener('click', addToDict);
  $('curate-copy').addEventListener('click', copyConfig);
  $('curate-anim-export').addEventListener('click', downloadAnimDict);
  $('curate-pack-btn').addEventListener('click', downloadCharacterPack);
  $('curate-clear').addEventListener('click', () => {
    if (!confirm('Clear all curated items?')) return;
    curated = {};
    saveCurated();
    renderCuratedList();
    refreshCuratedBadges();
  });

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft')  { $('flip-prev').click(); e.preventDefault(); }
    if (e.key === 'ArrowRight') { $('flip-next').click(); e.preventDefault(); }
    if (e.key === ' ')          { $('flip-play').click(); e.preventDefault(); }
  });

  bindSlicerEvents();
}
