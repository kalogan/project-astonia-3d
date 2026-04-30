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

// ── Persistent state ───────────────────────────────────────────────────────────
let curated = JSON.parse(localStorage.getItem('lab-curated') ?? '{}');

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
  bindEvents();
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
  // Release the previous folder's blob URLs before we lose the references
  for (const u of activeBlobUrls) URL.revokeObjectURL(u);
  activeBlobUrls = [];

  activeFolder = name;
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
// All images are already in memory as blob URLs after zip extraction, so
// IntersectionObserver lazy-loading is unnecessary. Native img.loading="lazy"
// defers off-screen decode/paint without extra JS overhead.
function buildGrid(files) {
  const grid = $('sprite-grid');
  grid.innerHTML = '';

  if (!files.length) {
    grid.innerHTML = '<div id="grid-empty">This folder is empty.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const f of files) {
    const cell = document.createElement('div');
    cell.className        = 'grid-cell' + (isCurated(f.url) ? ' curated' : '');
    cell.dataset.url      = f.url;       // canonical — for curation checks
    cell.dataset.filename = f.filename;
    cell.title            = f.filename;
    cell.setAttribute('role', 'listitem');
    cell.setAttribute('tabindex', '0');
    cell.setAttribute('aria-label', f.filename);

    const img   = document.createElement('img');
    img.src     = f.blobUrl ?? f.url;
    img.alt     = f.filename;
    img.loading = 'lazy';
    cell.appendChild(img);

    const activate = () => selectSprite(f);
    cell.addEventListener('click', activate);
    cell.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
    frag.appendChild(cell);
  }
  grid.appendChild(frag);
  $('grid-wrap').scrollTop = 0;
}

function isCurated(url) {
  return Object.values(curated).some(item => item.src === url);
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
    row.querySelector('.cl-del').addEventListener('click', e => {
      delete curated[e.currentTarget.dataset.id];
      saveCurated();
      renderCuratedList();
      refreshCuratedBadges();
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
    const fb = `{ fill: '${item.fallback.fill}', border: '${item.fallback.border}' }`;
    lines.push(
      `  ${id}: { type: '${item.type}', src: '${item.src}',` +
      ` fallback: ${fb} }, // ${item.name}`
    );
  }
  lines.push('}');
  $('curate-json').value = lines.join('\n');
}

// ── Copy config to clipboard ───────────────────────────────────────────────────
function copyConfig() {
  const entries = Object.entries(curated).sort(([a], [b]) => Number(a) - Number(b));
  if (!entries.length) { alert('Nothing curated yet.'); return; }

  const lines = ['{'];
  for (const [id, item] of entries) {
    const fb = `{ fill: '${item.fallback.fill}', border: '${item.fallback.border}' }`;
    lines.push(
      `  ${id}: { type: '${item.type}', src: '${item.src}',` +
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

  $('curate-add').addEventListener('click', addToDict);
  $('curate-copy').addEventListener('click', copyConfig);
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
}
