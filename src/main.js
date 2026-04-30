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

// ── Keyboard Input ────────────────────────────────────────────────────────────
const keys = new Set();
const ATTACK_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

window.addEventListener('keydown', e => {
  keys.add(e.code);
  if (ATTACK_KEYS.has(e.code)) console.log('Attack Action');
});
window.addEventListener('keyup', e => keys.delete(e.code));

const SPEED = 0.08;

function handleInput() {
  if (keys.has('KeyW')) player.position.z -= SPEED;
  if (keys.has('KeyS')) player.position.z += SPEED;
  if (keys.has('KeyA')) player.position.x -= SPEED;
  if (keys.has('KeyD')) player.position.x += SPEED;
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
});

$id('btn-light').addEventListener('click', () => {
  lighting.toggle();
  refreshBadge();
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

animate();
console.log('Three.js initialized');
