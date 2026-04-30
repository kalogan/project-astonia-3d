import * as THREE from 'three';

export const TILE = { EMPTY: 0, FLOOR: 1, WALL: 2 };

// World 1 — Dungeon room with scattered interior walls (12 × 12)
const WORLD_1 = [
  [2,2,2,2,2,2,2,2,2,2,2,2],
  [2,1,1,1,1,1,1,1,1,1,1,2],
  [2,1,1,1,2,2,1,1,1,1,1,2],
  [2,1,1,1,2,1,1,1,1,1,1,2],
  [2,1,2,1,1,1,1,2,2,1,1,2],
  [2,1,2,1,1,1,1,1,2,1,1,2],
  [2,1,1,1,1,2,1,1,1,1,1,2],
  [2,1,1,1,1,2,1,1,1,1,1,2],
  [2,1,1,2,1,1,1,2,1,1,1,2],
  [2,1,1,2,1,1,1,1,1,1,1,2],
  [2,1,1,1,1,1,1,1,1,1,1,2],
  [2,2,2,2,2,2,2,2,2,2,2,2],
];

// World 2 — Maze corridor layout (15 × 15)
const WORLD_2 = [
  [2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],
  [2,1,1,1,1,2,1,1,1,1,1,2,1,1,2],
  [2,1,2,2,1,1,1,2,2,1,1,1,2,1,2],
  [2,1,2,1,1,2,1,1,2,1,2,1,1,1,2],
  [2,1,1,1,2,2,1,1,1,1,2,2,1,1,2],
  [2,2,1,1,1,1,1,1,1,1,1,1,1,2,2],
  [2,1,1,2,2,1,1,2,1,1,2,1,1,1,2],
  [2,1,2,2,1,1,2,2,1,1,1,2,2,1,2],
  [2,1,1,1,1,2,2,1,1,2,1,1,1,1,2],
  [2,2,1,2,1,1,1,1,2,2,1,2,1,2,2],
  [2,1,1,2,1,2,1,1,1,1,2,2,1,1,2],
  [2,1,1,1,1,1,2,2,1,1,1,1,1,1,2],
  [2,1,2,2,1,1,2,1,1,2,2,1,2,1,2],
  [2,1,1,1,1,1,1,1,1,1,1,1,1,1,2],
  [2,2,2,2,2,2,2,2,2,2,2,2,2,2,2],
];

export const WORLDS = [null, WORLD_1, WORLD_2];

export class LevelManager {
  constructor(scene) {
    this.scene = scene;
    this.grid = [];      // grid[z][x] = TILE value
    this.meshMap = new Map(); // "x,z" → { mesh, type }
    this.currentWorld = 0;
  }

  loadWorld(n) {
    this.clearGrid();
    this.currentWorld = n;
    const mapData = WORLDS[n];
    if (!mapData) return;

    this.grid = mapData.map(row => [...row]);

    for (let z = 0; z < this.grid.length; z++) {
      for (let x = 0; x < this.grid[z].length; x++) {
        const t = this.grid[z][x];
        if (t === TILE.FLOOR) this._createFloor(x, z);
        else if (t === TILE.WALL) this._createWall(x, z);
      }
    }
  }

  spawnFloor(gx, gz) {
    const key = `${gx},${gz}`;
    if (this.meshMap.has(key)) this._removeMesh(key);
    this._ensureCell(gx, gz);
    this.grid[gz][gx] = TILE.FLOOR;
    this._createFloor(gx, gz);
  }

  spawnWall(gx, gz) {
    const key = `${gx},${gz}`;
    if (this.meshMap.has(key)) this._removeMesh(key);
    this._ensureCell(gx, gz);
    this.grid[gz][gx] = TILE.WALL;
    this._createWall(gx, gz);
  }

  clearGrid() {
    for (const { mesh } of this.meshMap.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.meshMap.clear();
    this.grid = [];
  }

  isWall(x, z) {
    const row = this.grid[z];
    if (!row) return false;
    return row[x] === TILE.WALL;
  }

  setAllVisible(v) {
    for (const { mesh } of this.meshMap.values()) mesh.visible = v;
  }

  setMeshVisible(x, z, v) {
    const entry = this.meshMap.get(`${x},${z}`);
    if (entry) entry.mesh.visible = v;
  }

  getFloorMeshes() {
    return [...this.meshMap.values()].filter(e => e.type === TILE.FLOOR).map(e => e.mesh);
  }

  getWallMeshes() {
    return [...this.meshMap.values()].filter(e => e.type === TILE.WALL).map(e => e.mesh);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _createFloor(x, z) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshLambertMaterial({ color: 0x2a2a3e, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0, z);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.meshMap.set(`${x},${z}`, { mesh, type: TILE.FLOOR });
  }

  _createWall(x, z) {
    const geo = new THREE.BoxGeometry(1, 1.5, 1);
    const mat = new THREE.MeshLambertMaterial({ color: 0x52527a });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0.75, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.meshMap.set(`${x},${z}`, { mesh, type: TILE.WALL });
  }

  _removeMesh(key) {
    const entry = this.meshMap.get(key);
    if (!entry) return;
    this.scene.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    entry.mesh.material.dispose();
    this.meshMap.delete(key);
  }

  _ensureCell(x, z) {
    while (this.grid.length <= z) this.grid.push([]);
    while (this.grid[z].length <= x) this.grid[z].push(TILE.EMPTY);
  }
}
