import * as THREE from 'three';
import { LevelManager } from './LevelManager.js';
import { LightingManager, MODE } from './lighting.js';
import './style.css';

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

// ── Player Mesh ───────────────────────────────────────────────────────────────
const player = new THREE.Mesh(
  new THREE.BoxGeometry(0.65, 1.0, 0.65),
  new THREE.MeshLambertMaterial({ color: 0xff5533, emissive: 0x330a00 })
);
player.position.set(5, 0.5, 5);
player.castShadow = true;
scene.add(player);

// ── Level & Lighting ──────────────────────────────────────────────────────────
const levelManager = new LevelManager(scene);
levelManager.loadWorld(1);

const lighting = new LightingManager(scene, levelManager);

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
const ATTACK_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

window.addEventListener('keydown', e => {
  keys.add(e.code);
  if (ATTACK_KEYS.has(e.code)) console.log('Attack Action');
});
window.addEventListener('keyup', e => keys.delete(e.code));

const SPEED = 0.08;

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

  // Each axis is tested independently so the player slides along walls
  // rather than stopping dead on diagonal contact.
  if (dx !== 0) {
    const nx = player.position.x + dx;
    if (!levelManager.isWall(Math.round(nx), Math.round(player.position.z))) {
      player.position.x = nx;
    }
  }
  if (dz !== 0) {
    const nz = player.position.z + dz;
    if (!levelManager.isWall(Math.round(player.position.x), Math.round(nz))) {
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
let currentWorld = 1;
const devPanel = document.getElementById('dev-tools');

devPanel.innerHTML = `
  <div class="dt-header">
    <span class="dt-title">DEV TOOLS</span>
    <span id="dt-badge" class="mode-badge mode-a">MODE A · FOV</span>
  </div>
  <div class="dt-stats">
    <div class="stat-row"><span class="stat-label">POS</span><span id="dt-pos">—</span></div>
    <div class="stat-row"><span class="stat-label">GRID</span><span id="dt-grid">—</span></div>
    <div class="stat-row"><span class="stat-label">WORLD</span><span id="dt-world">1</span></div>
  </div>
  <div class="dt-divider"></div>
  <div class="btn-group">
    <button id="btn-wall">
      <span class="btn-key">W</span>Spawn Wall
    </button>
    <button id="btn-floor">
      <span class="btn-key">F</span>Spawn Floor
    </button>
    <button id="btn-switch">
      <span class="btn-key">X</span>Switch World
    </button>
    <button id="btn-light">
      <span class="btn-key">L</span>Toggle Lighting
    </button>
  </div>
  <div class="dt-divider"></div>
  <div class="slider-section">
    <div class="slider-label-row">
      <span class="stat-label">FOV</span>
      <span id="fov-value">7</span>
    </div>
    <input type="range" id="fov-slider" min="5" max="50" value="7" />
  </div>
  <div class="dt-divider"></div>
  <div class="preset-row">
    <span class="stat-label">ENV</span>
    <select id="lighting-preset">
      <option value="studio">Studio</option>
      <option value="warm">Warm</option>
      <option value="dark">Dark</option>
    </select>
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
  levelManager.spawnWall(gx, gz);
});

$id('btn-floor').addEventListener('click', () => {
  const { gx, gz } = playerGridPos();
  levelManager.spawnFloor(gx, gz);
});

$id('btn-switch').addEventListener('click', () => {
  currentWorld = currentWorld === 1 ? 2 : 1;
  levelManager.loadWorld(currentWorld);
  player.position.set(5, 0.5, 5);
  $id('dt-world').textContent = currentWorld;
  // New map loaded — reset cell tracker and force a fresh FOV pass.
  lastGX = null;
  lastGZ = null;
  lighting.invalidateFOV();
  lighting.computeFOV(player.position);
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

function refreshBadge() {
  const badge = $id('dt-badge');
  const isFov = lighting.mode === MODE.FOV;
  badge.textContent = isFov ? 'MODE A · FOV' : 'MODE B · SPOT';
  badge.className   = 'mode-badge ' + (isFov ? 'mode-a' : 'mode-b');
}

// Keyboard shortcuts that mirror the panel buttons
window.addEventListener('keydown', e => {
  if (e.code === 'KeyL') $id('btn-light').click();
  if (e.code === 'KeyX') $id('btn-switch').click();
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
function animate() {
  requestAnimationFrame(animate);

  handleInput();

  // Smooth isometric camera follow — maintain constant (20, 20, 20) offset
  camera.position.set(
    player.position.x + CAM_OFFSET.x,
    player.position.y + CAM_OFFSET.y,
    player.position.z + CAM_OFFSET.z,
  );
  camera.lookAt(player.position);

  lighting.update(player.position);
  updateDevUI();

  renderer.render(scene, camera);
}

// Run the initial FOV pass before the first rendered frame.
lighting.computeFOV(player.position);

animate();
console.log('Three.js initialized');
