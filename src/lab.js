// ── Asset index via Vite glob ──────────────────────────────────────────────────
// Keys are like '/public/raw-assets/FOLDER/file.png'.
// Served URL = key with '/public' stripped → '/raw-assets/FOLDER/file.png'.
// We only use the keys for enumeration — no lazy import calls needed.
const GLOB = import.meta.glob('/public/raw-assets/**/*.png', { eager: false });

const PREFIX   = '/public/raw-assets/';
const folderMap = new Map(); // folderName → [{ filename, url }]

for (const key of Object.keys(GLOB)) {
  const rel    = key.slice(PREFIX.length);
  const slash  = rel.indexOf('/');
  const folder = slash === -1 ? '(root)' : rel.slice(0, slash);
  const fname  = slash === -1 ? rel : rel.slice(slash + 1);
  const url    = key.slice('/public'.length);   // '/raw-assets/...'
  if (!folderMap.has(folder)) folderMap.set(folder, []);
  folderMap.get(folder).push({ filename: fname, url });
}
for (const files of folderMap.values()) {
  files.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
}
const allFolders = [...folderMap.keys()].sort();

// ── Persistent state ───────────────────────────────────────────────────────────
let curated = JSON.parse(localStorage.getItem('lab-curated') ?? '{}');

// ── Runtime state ──────────────────────────────────────────────────────────────
let activeFolder  = null;
let selectedEntry = null;   // { filename, url }

let flipFiles   = [];
let flipIdx     = 0;
let flipFps     = 12;
let flipPlaying = true;
let flipTimer   = null;

let gridObserver = null;

// ── DOM shorthand ──────────────────────────────────────────────────────────────
const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

// ── Boot ───────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const totalFiles = [...folderMap.values()].reduce((s, f) => s + f.length, 0);
  $('lab-stats').textContent =
    `${allFolders.length} folders · ${totalFiles.toLocaleString()} sprites`;
  $('folder-count').textContent = allFolders.length;

  buildFolderList(allFolders);
  renderCuratedList();
  bindEvents();
});

// ── Left pane: folder list ─────────────────────────────────────────────────────
function buildFolderList(names) {
  const list = $('folder-list');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const name of names) {
    const count = folderMap.get(name)?.length ?? 0;
    const div   = document.createElement('div');
    div.className = 'folder-item' + (name === activeFolder ? ' active' : '');
    div.dataset.folder = name;
    div.innerHTML =
      `<span class="fi-name">${name}</span><span class="fi-count">${count}</span>`;
    div.addEventListener('click', () => selectFolder(name));
    frag.appendChild(div);
  }
  list.appendChild(frag);
}

function selectFolder(name) {
  activeFolder = name;
  $$('.folder-item').forEach(el =>
    el.classList.toggle('active', el.dataset.folder === name));

  const files = folderMap.get(name) ?? [];
  $('flip-folder-name').textContent = `${name}  (${files.length})`;
  startFlipbook(files);
  buildGrid(files);
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
    img.style.display = 'none';
    empty.style.display = '';
    counter.textContent = '';
    fname.textContent   = '';
    return;
  }
  const entry = flipFiles[flipIdx];
  img.src = entry.url;
  img.style.display = 'block';
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
  const grid = $('sprite-grid');
  grid.innerHTML = '';

  if (gridObserver) {
    gridObserver.disconnect();
    gridObserver = null;
  }

  if (!files.length) {
    grid.innerHTML = '<div id="grid-empty">This folder is empty.</div>';
    return;
  }

  gridObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const cell = entry.target;
      if (cell.dataset.url && !cell.querySelector('img')) {
        const img = document.createElement('img');
        img.src = cell.dataset.url;
        img.alt = cell.dataset.filename ?? '';
        cell.appendChild(img);
      }
      gridObserver.unobserve(cell);
    }
  }, { root: $('grid-wrap'), rootMargin: '300px' });

  const frag = document.createDocumentFragment();
  for (const f of files) {
    const cell = document.createElement('div');
    cell.className = 'grid-cell' + (isCurated(f.url) ? ' curated' : '');
    cell.dataset.url      = f.url;
    cell.dataset.filename = f.filename;
    cell.title = f.filename;
    cell.addEventListener('click', () => selectSprite(f));
    frag.appendChild(cell);
    gridObserver.observe(cell);
  }
  grid.appendChild(frag);

  // Reset scroll
  $('grid-wrap').scrollTop = 0;
}

function isCurated(url) {
  return Object.values(curated).some(item => item.src === url);
}

// ── Sprite selection ───────────────────────────────────────────────────────────
function selectSprite(entry) {
  selectedEntry = entry;

  // Highlight in grid
  $$('.grid-cell').forEach(el =>
    el.classList.toggle('selected', el.dataset.url === entry.url));

  // Jump flipbook to this frame
  const idx = flipFiles.findIndex(f => f.url === entry.url);
  if (idx !== -1) { flipIdx = idx; renderFlipFrame(); }

  // Update curation form
  $('curate-filename').textContent = entry.filename;
  $('curate-filename').classList.add('has-file');
  $('curate-name').value = entry.filename.replace(/\.[^.]+$/, '');

  // Thumbnail
  const thumb = $('curate-thumb');
  thumb.innerHTML = '';
  const img = document.createElement('img');
  img.src = entry.url;
  thumb.appendChild(img);

  // Auto-suggest next free ID
  const usedIds = Object.keys(curated).map(Number);
  $('curate-id').value = usedIds.length ? Math.max(...usedIds) + 1 : 1;
  $('curate-add').disabled = false;
}

// ── Right pane: curation ───────────────────────────────────────────────────────
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

  // Mark cell as curated
  $$('.grid-cell').forEach(el => {
    if (el.dataset.url === selectedEntry.url) el.classList.add('curated');
  });

  // Advance ID
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
  // Search
  $('lib-search').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    buildFolderList(q ? allFolders.filter(n => n.toLowerCase().includes(q)) : allFolders);
  });

  // Flipbook controls
  $('flip-fps').addEventListener('input', e => {
    flipFps = parseInt(e.target.value, 10);
    $('flip-fps-val').textContent = flipFps;
    if (flipPlaying) restartFlipTimer();
  });

  $('flip-play').addEventListener('click', () => {
    flipPlaying = !flipPlaying;
    $('flip-play').textContent = flipPlaying ? '⏸' : '▶';
    $('flip-play').classList.toggle('active', flipPlaying);
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

  // Curation
  $('curate-add').addEventListener('click', addToDict);
  $('curate-copy').addEventListener('click', copyConfig);
  $('curate-clear').addEventListener('click', () => {
    if (!confirm('Clear all curated items?')) return;
    curated = {};
    saveCurated();
    renderCuratedList();
    refreshCuratedBadges();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft')  { $('flip-prev').click(); e.preventDefault(); }
    if (e.key === 'ArrowRight') { $('flip-next').click(); e.preventDefault(); }
    if (e.key === ' ')          { $('flip-play').click(); e.preventDefault(); }
  });
}
