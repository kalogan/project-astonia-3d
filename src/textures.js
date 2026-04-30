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
 * Load an image and configure it for crisp pixel-art rendering.
 *
 * NearestFilter on both mag and min prevents the GPU from blending adjacent
 * pixels at any zoom level.  Mipmaps are disabled because the mip-chain would
 * pre-blur the image before it even reaches the fragment shader.
 */
export function loadPixelTexture(url) {
  const tex = loader.load(url);
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
export const playerSpriteTex = loadPixelTexture('/textures/player_sprite.png');
