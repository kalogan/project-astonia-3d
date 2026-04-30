import * as THREE from 'three';

// ── Pixel-art texture loader ───────────────────────────────────────────────────
//
// Asset placement — put your .png files here so Vite serves them at the root:
//
//   project-astonia-3d/
//   └── public/
//       └── textures/
//           ├── floor.png   ← referenced as '/textures/floor.png'
//           └── wall.png    ← referenced as '/textures/wall.png'
//
// Vite copies everything in /public verbatim to the build output, so no import
// statement is needed for static assets — just reference them by URL path.

const loader = new THREE.TextureLoader();

/**
 * Draw a 64×64 isometric diamond (top/right/bottom/left mid-points of the canvas).
 * Used as a fallback image when a texture URL returns 404.
 * The 1px border is inset so the stroke stays within canvas bounds.
 */
export function makeColorCanvas(fill, border = null, size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx    = canvas.getContext('2d');
  const cx = size / 2, cy = size / 2;

  ctx.beginPath();
  ctx.moveTo(cx,      1);        // top
  ctx.lineTo(size-1,  cy);       // right
  ctx.lineTo(cx,      size-1);   // bottom
  ctx.lineTo(1,       cy);       // left
  ctx.closePath();

  ctx.fillStyle = fill;
  ctx.fill();

  if (border) {
    ctx.strokeStyle = border;
    ctx.lineWidth   = 1;
    ctx.stroke();
  }
  return canvas;
}

/**
 * Load an image and configure it for crisp pixel-art rendering.
 * Pass an optional onError callback to swap in a fallback when the URL is missing.
 */
export function loadPixelTexture(url, onError = undefined) {
  const tex = loader.load(url, undefined, undefined, onError);
  tex.magFilter      = THREE.NearestFilter;
  tex.minFilter      = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

// ── Pre-loaded tileset textures ────────────────────────────────────────────────
// Replace the URL strings with your real asset paths.
// Three.js handles a 404 gracefully (logs an error, falls back to a solid
// colour), so the game will still run before the files exist.

// Floor — seamless tile, repeats exactly once per 1×1 grid cell.
export const floorTex = (() => {
  const tex = loadPixelTexture('/textures/floor.png');
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);
  return tex;
})();

// Wall — mapped once to every face of the BoxGeometry via Three.js default UVs.
export const wallTex = loadPixelTexture('/textures/wall.png');

// ── 2D isometric sprite textures ──────────────────────────────────────────────
// Replace these paths with your actual pre-rendered isometric PNG assets.
// Each PNG should have a transparent background and a baked-in isometric angle.
export const floorSpriteTex  = loadPixelTexture('/textures/floor_sprite.png');
export const wallSpriteTex   = loadPixelTexture('/textures/wall_sprite.png');
export const playerSpriteTex = (() => {
  const tex = loadPixelTexture('/textures/player_sprite.png', () => {
    // #ff4500 matches the 3D player mesh color for visual consistency.
    tex.image = makeColorCanvas('#ff4500', '#ff6a00');
    tex.needsUpdate = true;
  });
  return tex;
})();
