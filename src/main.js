import * as THREE from 'three';
import { LevelManager, tileDictionary } from './LevelManager.js';
import { WorldRenderer } from './WorldRenderer.js';
import { LightingManager, MODE } from './lighting.js';
import { floorTex, wallTex, floorSpriteTex, wallSpriteTex, playerSpriteTex } from './textures.js';
import { initSlicer } from './slicer.js';
import { SCENES } from './scenes.js';
import { CharacterAnimator, vecToDirection } from './CharacterAnimator.js';
import { Projectile } from './Projectile.js';
import './style.css';

// ── Active Projectiles ────────────────────────────────────────────────────────
const activeProjectiles = [];

// Set to true immediately before triggerAction so the onActionFrame handler
// knows to spawn exactly one fireball per cast — guards against frame-skip
// delivering frameIdx > 4 on the first callback.
let _castSpawnPending = false;

function spawnFireball(direction) {
  activeProjectiles.push(
    new Projectile(scene, player.position.x, player.position.z, direction)
  );
}

// ── Character configuration ───────────────────────────────────────────────────
// Set PLAYER_CHARACTER_ID to the folder/base ID used when slicing animations
// in the Asset Lab (the prefix before _action_direction in every state key).
// Export the dict from the lab with "↓ Anim Dict" and place it at:
//   public/animations/<PLAYER_CHARACTER_ID>.json
const PLAYER_CHARACTER_ID = '00162000';
const PLAYER_ANIM_FPS     = 12;

// ── Renderer ──────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('canvas-container').appendChild(renderer.domElement);

// ── Scene ─────────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07070f);

// ── Orthographic Isometric Camera ─────────────────────────────────────────────
const FRUSTUM = 14;
const getAspect = () => window.innerWidth / window.innerHeight;

const camera = new THREE.OrthographicCamera(
  -FRUSTUM * getAspect() / 2,
   FRUSTUM * getAspect() / 2,
   FRUSTUM / 2,
  -FRUSTUM / 2,
  0.1, 200
);
// Constant offset from the player in all three axes → classic isometric angle
const CAM_OFFSET = new THREE.Vector3(20, 20, 20);

// ── Grid Helper ───────────────────────────────────────────────────────────────
const gridHelper = new THREE.GridHelper(40, 40, 0x18182a, 0x18182a);
gridHelper.position.y = 0.003;
scene.add(gridHelper);

// ── Player Mesh (3D mode) ─────────────────────────────────────────────────────
const player = new THREE.Mesh(
  new THREE.BoxGeometry(0.65, 1.0, 0.65),
  new THREE.MeshLambertMaterial({ color: 0xff5533, emissive: 0x330a00 })
);
player.position.set(5, 0.5, 5);
player.castShadow = true;
scene.add(player);

// ── Player Sprite (2D mode) ───────────────────────────────────────────────────
// Replace '/textures/player_sprite.png' with your pre-rendered isometric character.
const playerSpriteMat = new THREE.SpriteMaterial({
  map:        playerSpriteTex,
  color:      0xffffff,
  depthTest:  false,
  depthWrite: false,
  transparent: true,
});
const playerSprite = new THREE.Sprite(playerSpriteMat);
// 0.7 × floor tile width (√2 ≈ 1.414) keeps the character smaller than a tile.
// Height is 2× the width for upright character proportions.
const PLAYER_SPRITE_W = 0.7 * 1.414;            // ≈ 0.99
playerSprite.scale.set(PLAYER_SPRITE_W, PLAYER_SPRITE_W * 2, 1);
// Anchor at (0.5, 0.1) — 10% from the bottom — so the feet sit on the grid
// intersection rather than the sprite center floating in mid-air.
playerSprite.center.set(0.5, 0.1);
playerSprite.visible = false;
scene.add(playerSprite);

// ── Character Animator ───────────────────────────────────────────────────────
// Nullable until the animation JSON has been fetched and parsed.
// The sprite material's .map is swapped to the animator's hot-swap texture
// once the dict loads; until then the static fallback diamond renders.
let animator = null;

async function loadCharacter(baseId, fps) {
  try {
    const res = await fetch(`/animations/${baseId}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const dict = await res.json();

    const anim = new CharacterAnimator(dict, baseId, fps);

    // IMPORTANT: wait for the first frame image to fully decode before wiring
    // the animator's texture to the sprite material.  THREE.Texture with an
    // undefined .image uploads as fully transparent — the sprite goes invisible.
    await anim.waitForFirstFrame();

    animator = anim;
    // When a combat animation finishes, immediately re-evaluate WASD so the
    // character snaps back to idle/walk without waiting for the next input event.
    animator.onUnlock = () => {
      _castSpawnPending = false;  // clean up if the spawn frame was never reached
      handleInput();
    };
    // Spawn a fireball on frame 4 of cast_neutral (the animation's action frame).
    // frameIdx >= 4 tolerates rare lag spikes that skip the exact index.
    animator.onActionFrame = (action, frameIdx) => {
      if (action === 'cast_neutral' && _castSpawnPending && frameIdx >= 4) {
        _castSpawnPending = false;
        spawnFireball(animator.direction);
      }
    };
    playerSpriteMat.map         = animator.texture;
    playerSpriteMat.needsUpdate = true;

    console.log(
      `[CharacterAnimator] "${baseId}" live — ${Object.keys(dict).length} states`
    );
  } catch (e) {
    // Keep animator null → sprite material retains playerSpriteTex (diamond fallback).
    // Visible > invisible: the player is always findable even without real sprites.
    animator = null;
    console.warn(
      `[CharacterAnimator] "${baseId}" failed — diamond fallback active.\n` +
      `  Reason: ${e.message}\n` +
      `  If the JSON loaded but sprites are missing:\n` +
      `  → Use "↓ Character Pack" in the Asset Lab and unzip into public/.`
    );
  }
}

// ── Level & Lighting ──────────────────────────────────────────────────────────
const levelManager = new LevelManager();
levelManager.loadWorld(1);

const worldRenderer = new WorldRenderer(scene, levelManager, {
  floor:       floorTex,
  wall:        wallTex,
  floorSprite: floorSpriteTex,
  wallSprite:  wallSpriteTex,
  tileDict:    tileDictionary,
});
worldRenderer.rebuild();

const lighting = new LightingManager(scene, worldRenderer);

// ── Global Environment Lights ─────────────────────────────────────────────────
// These are separate from the LightingManager's FOV/spot lights and are
// controlled exclusively by the preset system below.
const globalAmbient = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(globalAmbient);

const globalDir = new THREE.DirectionalLight(0xffffff, 1.0);
globalDir.position.set(20, 50, -20);  // high and angled for isometric shadow cast
globalDir.castShadow = true;
globalDir.shadow.mapSize.set(2048, 2048);
globalDir.shadow.camera.near   =   0.5;
globalDir.shadow.camera.far    = 200;
globalDir.shadow.camera.left   = -30;
globalDir.shadow.camera.right  =  30;
globalDir.shadow.camera.top    =  30;
globalDir.shadow.camera.bottom = -30;
scene.add(globalDir);

// ── Lighting Presets ──────────────────────────────────────────────────────────
const PRESETS = {
  studio: { ambColor: 0xffffff, ambInt: 0.6,  dirColor: 0xffffff, dirInt: 1.0, bg: 0x07070f },
  warm:   { ambColor: 0xffaa77, ambInt: 0.4,  dirColor: 0xffcc88, dirInt: 0.8, bg: 0x110a05 },
  dark:   { ambColor: 0x0a0a1a, ambInt: 0.05, dirColor: 0x444466, dirInt: 0.2, bg: 0x020205 },
};

function applyPreset(key) {
  const p = PRESETS[key];
  globalAmbient.color.set(p.ambColor);
  globalAmbient.intensity = p.ambInt;
  globalDir.color.set(p.dirColor);
  globalDir.intensity = p.dirInt;
  scene.background.set(p.bg);
}

// ── Keyboard Input ────────────────────────────────────────────────────────────
const keys = new Set();

// Isometric camera sits at (+20, +20, +20) — arrow keys map to the four
// diagonal compass directions as seen from that angle.
const ARROW_DIRECTION = {
  ArrowUp:    'NW',
  ArrowRight: 'NE',
  ArrowDown:  'SE',
  ArrowLeft:  'SW',
};

window.addEventListener('keydown', e => {
  keys.add(e.code);
  const dir = ARROW_DIRECTION[e.code];
  if (dir && animator) {
    _castSpawnPending = true;
    animator.triggerAction('cast_neutral', dir);
  }
});
window.addEventListener('keyup', e => keys.delete(e.code));

const SPEED = 0.08;
// Extra distance added to the wall-test point so the player's visible edge
// stops before the wall mesh rather than clipping into it.
const COLLISION_PADDING = 0.2;

// Tracks the last grid cell the player occupied so FOV only recomputes
// when the player crosses into a new cell, not on every sub-pixel movement.
let lastGX = Math.round(player.position.x);
let lastGZ = Math.round(player.position.z);

function handleInput() {
  let dx = 0, dz = 0;
  if (keys.has('KeyW')) dz -= SPEED;
  if (keys.has('KeyS')) dz += SPEED;
  if (keys.has('KeyA')) dx -= SPEED;
  if (keys.has('KeyD')) dx += SPEED;

  // ── Animator state ──
  // Use the raw input vector (before collision) so the character faces the
  // intended direction even when blocked by a wall.
  // setState() is a no-op while isLocked, but we skip the vecToDirection work too.
  if (animator && !animator.isLocked) {
    const moving = dx !== 0 || dz !== 0;
    const action = moving ? 'walk' : 'idle';
    // Keep facing the last direction when going idle — don't reset to default.
    const dir    = moving ? vecToDirection(dx, dz) : animator.direction;
    animator.setState(action, dir);
  }

  // Each axis is tested independently so the player slides along walls
  // rather than stopping dead on diagonal contact.
  // COLLISION_PADDING probes 0.2 units ahead of the player center in the
  // direction of movement so the player stops before meshes touch.
  if (dx !== 0) {
    const nx    = player.position.x + dx;
    const testX = nx + Math.sign(dx) * COLLISION_PADDING;
    if (!levelManager.isWall(Math.round(testX), Math.round(player.position.z))) {
      player.position.x = nx;
    }
  }
  if (dz !== 0) {
    const nz    = player.position.z + dz;
    const testZ = nz + Math.sign(dz) * COLLISION_PADDING;
    if (!levelManager.isWall(Math.round(player.position.x), Math.round(testZ))) {
      player.position.z = nz;
    }
  }

  // Fire FOV update only when the player crosses a grid-cell boundary.
  const gx = Math.round(player.position.x);
  const gz = Math.round(player.position.z);
  if (gx !== lastGX || gz !== lastGZ) {
    lastGX = gx;
    lastGZ = gz;
    lighting.computeFOV(player.position);
  }
}

// ── Dev Tools DOM ─────────────────────────────────────────────────────────────
const INITIAL_SCENE = 'world_1';
const devPanel = document.getElementById('dev-tools');

// Build scene <option> list from the registry
const sceneOptions = Object.entries(SCENES)
  .map(([key, s]) =>
    `<option value="${key}"${key === INITIAL_SCENE ? ' selected' : ''}>${s.label}</option>`)
  .join('');

devPanel.innerHTML = `
  <div class="dt-header">
    <span class="dt-title">DEV TOOLS</span>
    <span id="dt-badge" class="mode-badge mode-a">MODE A · FOV</span>
  </div>
  <div class="dt-stats">
    <div class="stat-row"><span class="stat-label">POS</span><span id="dt-pos">—</span></div>
    <div class="stat-row"><span class="stat-label">GRID</span><span id="dt-grid">—</span></div>
    <div class="stat-row"><span class="stat-label">WORLD</span><span id="dt-world">${SCENES[INITIAL_SCENE].label}</span></div>
  </div>
  <div class="dt-divider"></div>
  <div class="btn-group">
    <button id="btn-wall"   aria-label="Spawn wall at player position (W)">
      <span class="btn-key" aria-hidden="true">W</span>Spawn Wall
    </button>
    <button id="btn-floor"  aria-label="Spawn floor at player position (F)">
      <span class="btn-key" aria-hidden="true">F</span>Spawn Floor
    </button>
    <button id="btn-light"  aria-label="Toggle FOV / Spot lighting mode (L)" aria-pressed="false">
      <span class="btn-key" aria-hidden="true">L</span>Toggle Lighting
    </button>
  </div>
  <div class="dt-divider"></div>
  <div class="preset-row">
    <span class="stat-label">SCENE</span>
    <select id="world-select" aria-label="Select scene">${sceneOptions}</select>
  </div>
  <div class="dt-divider"></div>
  <div class="slider-section">
    <div class="slider-label-row">
      <span class="stat-label">FOV</span>
      <span id="fov-value">7</span>
    </div>
    <input type="range" id="fov-slider" min="5" max="50" value="7"
           aria-label="Field of view radius in grid cells"
           aria-valuetext="7 cells" />
  </div>
  <div class="dt-divider"></div>
  <div class="preset-row">
    <span class="stat-label">ENV</span>
    <select id="lighting-preset" aria-label="Lighting environment preset">
      <option value="studio">Studio</option>
      <option value="warm">Warm</option>
      <option value="dark">Dark</option>
    </select>
  </div>
  <div class="dt-divider"></div>
  <div class="dt-section">TILESETS</div>
  <div class="btn-group">
    <button id="btn-tex"    aria-label="Toggle texture / greybox display (T)" aria-pressed="false">
      <span class="btn-key" aria-hidden="true">T</span>Toggle Textures
    </button>
    <button id="btn-render" aria-label="Toggle 2D / 3D render mode (R)" aria-pressed="false">
      <span class="btn-key" aria-hidden="true">R</span>Toggle Render Mode
    </button>
  </div>
  <div class="stat-row">
    <span class="stat-label">VIEW</span>
    <span id="tex-mode" class="tex-badge greybox">GREYBOX</span>
  </div>
  <div class="stat-row">
    <span class="stat-label">RMODE</span>
    <span id="render-mode" class="mode-badge mode-3d">3D</span>
  </div>
  <div class="dt-divider"></div>
  <div class="dt-section">ASSET SLICER</div>
  <div class="slicer-controls">
    <div class="slicer-file-row">
      <span class="stat-label">SHEET</span>
      <label class="slicer-btn" for="slicer-file">Browse…</label>
      <input type="file" id="slicer-file" accept="image/*" />
    </div>
    <div class="slicer-dim-row">
      <span class="stat-label">TILE</span>
      <input type="number" id="tile-w" value="32" min="1" max="512" />
      <span class="slicer-sep">×</span>
      <input type="number" id="tile-h" value="32" min="1" max="512" />
      <span class="slicer-sep">px</span>
    </div>
    <div id="slicer-info" class="slicer-info">no image loaded</div>
  </div>
  <div class="dt-hint">WASD · move &nbsp;|&nbsp; ↑↓←→ · attack</div>
`;

const $id = id => document.getElementById(id);

function playerGridPos() {
  return {
    gx: Math.round(player.position.x),
    gz: Math.round(player.position.z),
  };
}

$id('btn-wall').addEventListener('click', () => {
  const { gx, gz } = playerGridPos();
  worldRenderer.spawnWall(gx, gz);
});

$id('btn-floor').addEventListener('click', () => {
  const { gx, gz } = playerGridPos();
  worldRenderer.spawnFloor(gx, gz);
});

// ── Scene seeding ─────────────────────────────────────────────────────────────
function seedScene(key) {
  const sceneData = SCENES[key];
  if (!sceneData) return;
  levelManager.seedWorld(sceneData.grid);
  if (worldRenderer.renderMode === '3D') worldRenderer.syncWorlds();
  worldRenderer.rebuild();
  player.position.set(sceneData.spawn.x, 0.5, sceneData.spawn.z);
  $id('dt-world').textContent = sceneData.label;
  lastGX = null;
  lastGZ = null;
  lighting.invalidateFOV();
  lighting.computeFOV(player.position);
}

// ── Map file loader ───────────────────────────────────────────────────────────
// Fetches /maps/<mapId>.json, merges floor + props into a single grid, then
// seeds the engine exactly as seedScene does.  Falls back to seedScene on error.
async function loadMap(mapId, fallbackKey) {
  let data;
  try {
    const res = await fetch(`/maps/${mapId}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    console.warn(`[loadMap] Could not load /maps/${mapId}.json (${e.message}), falling back to built-in scene.`);
    seedScene(fallbackKey);
    return;
  }

  // Build merged grid: start from floor layer, overlay prop tile IDs.
  const grid = data.floor.map(row => [...row]);
  for (const p of (data.props ?? [])) {
    if (grid[p.z] !== undefined) grid[p.z][p.x] = p.id;
  }

  levelManager.seedWorld(grid);
  if (worldRenderer.renderMode === '3D') worldRenderer.syncWorlds();
  worldRenderer.rebuild();
  const spawn = data.spawn ?? { x: 1, z: 1 };
  player.position.set(spawn.x, 0.5, spawn.z);
  $id('dt-world').textContent = data.name ?? mapId;
  lastGX = null;
  lastGZ = null;
  lighting.invalidateFOV();
  lighting.computeFOV(player.position);
}

$id('world-select').addEventListener('change', e => {
  const key = e.target.value;
  const sceneData = SCENES[key];
  if (sceneData?.mapFile) {
    loadMap(sceneData.mapFile, key);
  } else {
    seedScene(key);
  }
});

$id('btn-light').addEventListener('click', () => {
  lighting.toggle();
  refreshBadge();
  // When returning to FOV mode the cache was invalidated in toggle(),
  // so this call recomputes immediately; it's a no-op in SPOT mode.
  lighting.computeFOV(player.position);
});

// ── FOV Slider ─────────────────────────────────────────────────────────────
// Mode A: slider value = fovRadius (grid cells).
// Mode B: slider value interpreted as degrees → converted to radians for spot.angle.
$id('fov-slider').addEventListener('input', e => {
  const v = parseInt(e.target.value, 10);
  $id('fov-value').textContent = v;
  e.target.setAttribute('aria-valuetext', `${v} cells`);
  lighting.fovRadius = v;
  lighting.spot.angle = v * Math.PI / 180;
  lighting.spot.shadow.camera.updateProjectionMatrix();
  // Radius changed — invalidate cache so the new radius is reflected instantly.
  lighting.invalidateFOV();
  lighting.computeFOV(player.position);
});

$id('lighting-preset').addEventListener('change', e => {
  applyPreset(e.target.value);
});

// ── Texture Toggle ────────────────────────────────────────────────────────────
let texturedMode = false;

$id('btn-tex').addEventListener('click', () => {
  texturedMode = !texturedMode;
  worldRenderer.setTextured(texturedMode);
  const badge = $id('tex-mode');
  badge.textContent = texturedMode ? 'TEXTURED' : 'GREYBOX';
  badge.className   = 'tex-badge ' + (texturedMode ? 'textured' : 'greybox');
  const btn = $id('btn-tex');
  btn.classList.toggle('btn-active', texturedMode);
  btn.setAttribute('aria-pressed', texturedMode);
});

$id('btn-render').addEventListener('click', () => {
  // Before leaving 2D mode, translate any dict-ID placements into canonical
  // TILE constants so the 3D renderer has correct floor/wall data.
  if (worldRenderer.renderMode === '2D') worldRenderer.syncWorlds();
  worldRenderer.toggleRenderMode();
  const is3D = worldRenderer.renderMode === '3D';
  // Swap player representation — keep the invisible mesh as the position/collision anchor.
  player.visible       = is3D;
  playerSprite.visible = !is3D;
  // Ensure the orthographic camera recomputes its projection after the mode switch.
  camera.updateProjectionMatrix();
  lighting.invalidateFOV();
  lighting.computeFOV(player.position);
  const badge = $id('render-mode');
  badge.textContent = is3D ? '3D' : '2D';
  badge.className   = 'mode-badge ' + (is3D ? 'mode-3d' : 'mode-2d');
  // Lit-up when 2D mode is active (non-default state)
  const btn = $id('btn-render');
  btn.classList.toggle('btn-active', !is3D);
  btn.setAttribute('aria-pressed', !is3D);
});

function refreshBadge() {
  const badge = $id('dt-badge');
  const isFov = lighting.mode === MODE.FOV;
  badge.textContent = isFov ? 'MODE A · FOV' : 'MODE B · SPOT';
  badge.className   = 'mode-badge ' + (isFov ? 'mode-a' : 'mode-b');
  // Lit-up when the non-default SPOT mode is active
  const btn = $id('btn-light');
  btn.classList.toggle('btn-active', !isFov);
  btn.setAttribute('aria-pressed', !isFov);
}

// Keyboard shortcuts that mirror the panel buttons
window.addEventListener('keydown', e => {
  if (e.code === 'KeyL') $id('btn-light').click();
  if (e.code === 'KeyT') $id('btn-tex').click();
  if (e.code === 'KeyR') $id('btn-render').click();
});

function updateDevUI() {
  const p = player.position;
  const { gx, gz } = playerGridPos();
  $id('dt-pos').textContent  = `${p.x.toFixed(2)}, ${p.z.toFixed(2)}`;
  $id('dt-grid').textContent = `${gx}, ${gz}`;
}

// ── Window Resize ─────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  const a = getAspect();
  camera.left   = -FRUSTUM * a / 2;
  camera.right  =  FRUSTUM * a / 2;
  camera.top    =  FRUSTUM / 2;
  camera.bottom = -FRUSTUM / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Animation Loop ────────────────────────────────────────────────────────────
let _lastFrameTime = performance.now();

function animate() {
  requestAnimationFrame(animate);

  const now        = performance.now();
  const deltaMs    = Math.min(now - _lastFrameTime, 100); // cap at 100ms to survive tab-switch lag
  _lastFrameTime   = now;

  handleInput();

  // Advance sprite animation by elapsed real time — independent of render FPS.
  animator?.update(deltaMs);

  // Advance all live projectiles and GC any that have expired.
  // Iterating backwards lets splice() not skip elements.
  for (let i = activeProjectiles.length - 1; i >= 0; i--) {
    const p = activeProjectiles[i];
    p.update(deltaMs);
    if (!p.alive) {
      p.dispose();
      activeProjectiles.splice(i, 1);
    }
  }

  // Smooth isometric camera follow — maintain constant (20, 20, 20) offset
  camera.position.set(
    player.position.x + CAM_OFFSET.x,
    player.position.y + CAM_OFFSET.y,
    player.position.z + CAM_OFFSET.z,
  );
  camera.lookAt(player.position);

  lighting.update(player.position);

  // Keep the 2D player sprite locked to the 3D position reference.
  // renderOrder is updated every frame so depth sorting stays correct as the player moves.
  if (playerSprite.visible) {
    playerSprite.position.copy(player.position);
    const gx = Math.round(player.position.x);
    const gz = Math.round(player.position.z);
    playerSprite.renderOrder = gz * 100 + gx + 50;  // +50 so player draws above floor tiles
  }

  updateDevUI();

  renderer.render(scene, camera);
}

// Run the initial FOV pass before the first rendered frame.
lighting.computeFOV(player.position);

// Boot the slicer — completely isolated from the game loop.
initSlicer();

// Load the player character's animation dictionary.
// Place the exported JSON at public/animations/<PLAYER_CHARACTER_ID>.json
// (export it from the Asset Lab using the "↓ Anim Dict" button).
loadCharacter(PLAYER_CHARACTER_ID, PLAYER_ANIM_FPS);

animate();
console.log('Three.js initialized');
