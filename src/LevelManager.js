// ── LevelManager — pure data layer ────────────────────────────────────────────
// Owns only the grid array and collision queries.
// No Three.js imports, no meshes, no scene references.
// All visual representation is handled by WorldRenderer.

export const TILE = { EMPTY: 0, FLOOR: 1, WALL: 2 };

/** Build a public-folder sprite path from folder + filename. */
export const getSpritePath = (folder, filename) => `/sprites/${folder}/${filename}`;

// ── Tile Dictionary ────────────────────────────────────────────────────────────
// Maps integer tile IDs to sprite metadata used by WorldRenderer in 2D mode.
//   type      — 'floor' | 'wall' | 'prop'
//   src       — public-folder path; use getSpritePath() for consistency
//   fallback  — colored diamond fallback when PNG is missing (404)
//   floorBase — (prop only) tile ID to auto-spawn as ground beneath the prop
//   mesh3d    — (prop only) geometry descriptor used in 3D mode
export const tileDictionary = {
  1: { type: 'floor', src: getSpritePath('tiles', 'grass_00.png'),
       fallback: { fill: '#3a6b2a', border: '#4d8a38' } },
  2: { type: 'floor', src: getSpritePath('tiles', 'grass_with_path_00.png'),
       fallback: { fill: '#8a7040', border: '#a8894f' } },
  3: { type: 'floor', src: getSpritePath('tiles', 'mines_00.png'),
       fallback: { fill: '#2c2e3b', border: '#424451' } },
  4: { type: 'prop',  src: getSpritePath('props', 'mine_cart_sw.png'),
       floorBase: 3,
       mesh3d: { shape: 'box', color: 0x777777, w: 0.6, h: 0.4, d: 0.6, oy: 0.2 },
       fallback: { fill: '#777777', border: '#999999' } },
  5: { type: 'prop',  src: getSpritePath('props', 'tree_00.png'),
       floorBase: 1,
       mesh3d: { shape: 'cylinder', color: 0x1a4a1a, r: 0.25, h: 1.8, oy: 0.9 },
       fallback: { fill: '#1a4a1a', border: '#2a6a2a' } },
  6: { type: 'prop',  src: getSpritePath('props', 'tree_01.png'),
       floorBase: 1,
       mesh3d: { shape: 'cylinder', color: 0x1e5a1e, r: 0.25, h: 1.8, oy: 0.9 },
       fallback: { fill: '#1e5a1e', border: '#2e7a2e' } },
  7: { type: 'prop',  src: getSpritePath('props', 'tree_02.png'),
       floorBase: 1,
       mesh3d: { shape: 'cylinder', color: 0x245e24, r: 0.25, h: 1.8, oy: 0.9 },
       fallback: { fill: '#245e24', border: '#347e34' } },
};

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

// World 3 — Asset showcase (5 × 5)
// Corner trees (5,6,7), mine floor interior (3), path accent (2),
// mine cart prop (4) in the centre. Switch to this world and press R.
const WORLD_3 = [
  [5, 3, 3, 3, 6],
  [3, 1, 2, 1, 3],
  [3, 2, 4, 2, 3],
  [3, 1, 2, 1, 3],
  [7, 3, 3, 3, 5],
];

export const WORLDS = [null, WORLD_1, WORLD_2, WORLD_3];

export class LevelManager {
  constructor() {
    this.grid = [];       // grid[z][x] = TILE value
    this.currentWorld = 0;
  }

  /** Populate the grid from a preset world map.  No meshes are touched here. */
  loadWorld(n) {
    this.currentWorld = n;
    const mapData = WORLDS[n];
    if (!mapData) return;
    this.grid = mapData.map(row => [...row]);
  }

  /** Update a single cell to FLOOR in the data layer only. */
  spawnFloor(gx, gz) {
    this._ensureCell(gx, gz);
    this.grid[gz][gx] = TILE.FLOOR;
  }

  /** Update a single cell to WALL in the data layer only. */
  spawnWall(gx, gz) {
    this._ensureCell(gx, gz);
    this.grid[gz][gx] = TILE.WALL;
  }

  /** Returns true if the cell at (x, z) is a wall or out-of-bounds. */
  isWall(x, z) {
    const row = this.grid[z];
    if (!row) return false;
    return row[x] === TILE.WALL;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _ensureCell(x, z) {
    while (this.grid.length <= z)    this.grid.push([]);
    while (this.grid[z].length <= x) this.grid[z].push(TILE.EMPTY);
  }
}
