// ── Asset Slicer ──────────────────────────────────────────────────────────────
// Pure DOM/Canvas 2D module — zero Three.js imports, zero game-loop coupling.
// Call initSlicer() once after devPanel.innerHTML has been written.

export function initSlicer() {

  // ── State ──────────────────────────────────────────────────────────────────
  let srcImage = null;
  let tileW    = 32;
  let tileH    = 32;

  // ── Create the floating canvas panel (injected once into <body>) ───────────
  const panel = document.createElement('div');
  panel.id = 'slicer-panel';
  panel.style.display = 'none';
  panel.innerHTML = `
    <div class="slicer-panel-hdr">
      <span>SLICER PREVIEW</span>
      <span class="slicer-hint">click tile to download</span>
      <button id="slicer-close" title="Close">✕</button>
    </div>
    <div class="slicer-canvas-wrap">
      <canvas id="slicer-canvas"></canvas>
    </div>
  `;
  document.body.appendChild(panel);

  // ── Element refs ───────────────────────────────────────────────────────────
  const fileInput  = document.getElementById('slicer-file');
  const tileWInput = document.getElementById('tile-w');
  const tileHInput = document.getElementById('tile-h');
  const infoEl     = document.getElementById('slicer-info');
  const canvas     = document.getElementById('slicer-canvas');
  const ctx        = canvas.getContext('2d');

  // ── Close button ───────────────────────────────────────────────────────────
  document.getElementById('slicer-close').addEventListener('click', () => {
    panel.style.display = 'none';
    srcImage            = null;
    infoEl.textContent  = 'no image loaded';
    fileInput.value     = '';
  });

  // ── File loading ───────────────────────────────────────────────────────────
  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      srcImage      = img;
      canvas.width  = img.width;
      canvas.height = img.height;

      panel.style.display = 'flex';
      infoEl.textContent  = `${img.width} × ${img.height}px`;

      draw();
      URL.revokeObjectURL(url);
    };

    img.onerror = () => {
      infoEl.textContent = 'failed to load image';
      URL.revokeObjectURL(url);
    };

    img.src = url;
  });

  // ── Tile dimension inputs ──────────────────────────────────────────────────
  tileWInput.addEventListener('input', () => {
    tileW = Math.max(1, parseInt(tileWInput.value, 10) || 32);
    if (srcImage) draw();
  });

  tileHInput.addEventListener('input', () => {
    tileH = Math.max(1, parseInt(tileHInput.value, 10) || 32);
    if (srcImage) draw();
  });

  // ── Draw: image + semi-transparent grid overlay ────────────────────────────
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(srcImage, 0, 0);

    ctx.save();
    ctx.strokeStyle = 'rgba(80, 200, 255, 0.55)';
    ctx.lineWidth   = 1;

    // Vertical grid lines
    for (let x = 0; x <= canvas.width; x += tileW) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, canvas.height);
      ctx.stroke();
    }

    // Horizontal grid lines
    for (let y = 0; y <= canvas.height; y += tileH) {
      ctx.beginPath();
      ctx.moveTo(0,            y + 0.5);
      ctx.lineTo(canvas.width, y + 0.5);
      ctx.stroke();
    }

    ctx.restore();
  }

  // ── Hover highlight ────────────────────────────────────────────────────────
  canvas.addEventListener('mousemove', e => {
    if (!srcImage) return;
    draw();

    const col = Math.floor(e.offsetX / tileW);
    const row = Math.floor(e.offsetY / tileH);

    ctx.save();
    ctx.fillStyle = 'rgba(80, 200, 255, 0.20)';
    ctx.strokeStyle = 'rgba(80, 200, 255, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.fillRect(col * tileW,   row * tileH,   tileW, tileH);
    ctx.strokeRect(col * tileW + 0.75, row * tileH + 0.75, tileW - 1.5, tileH - 1.5);
    ctx.restore();
  });

  canvas.addEventListener('mouseleave', () => {
    if (srcImage) draw();
  });

  // ── Click → crop → download ───────────────────────────────────────────────
  canvas.addEventListener('click', e => {
    if (!srcImage) return;

    const col  = Math.floor(e.offsetX / tileW);
    const row  = Math.floor(e.offsetY / tileH);
    const srcX = col * tileW;
    const srcY = row * tileH;

    // Clamp to actual image bounds (handles partial tiles at edges)
    const cropW = Math.min(tileW, srcImage.width  - srcX);
    const cropH = Math.min(tileH, srcImage.height - srcY);
    if (cropW <= 0 || cropH <= 0) return;

    // Temporary off-screen canvas — never inserted into the DOM
    const tmp    = document.createElement('canvas');
    tmp.width    = cropW;
    tmp.height   = cropH;
    tmp.getContext('2d').drawImage(
      srcImage,
      srcX, srcY, cropW, cropH,  // source rect
      0,    0,    cropW, cropH,  // dest rect
    );

    // Trigger download without navigating away
    const link      = document.createElement('a');
    link.href       = tmp.toDataURL('image/png');
    link.download   = `tile_${col}_${row}.png`;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  });
}
