// ── LevelManager — pure data layer ────────────────────────────────────────────
// Owns only the grid array and collision queries.
// No Three.js imports, no meshes, no scene references.
// All visual representation is handled by WorldRenderer.

export const TILE = { EMPTY: 0, FLOOR: 1, WALL: 2 };

// ── Tile Dictionary ────────────────────────────────────────────────────────────
// Maps integer tile IDs to sprite metadata used by WorldRenderer in 2D mode.
// 'type' controls scale and y-position; 'src' is the public-folder asset path.
// Add entries here as you expand your tileset — IDs are arbitrary positive ints.
export const tileDictionary = {
  // fallback.fill / fallback.border are used when the PNG is missing (404).
  // Colors match the 3D greybox palette so the 2D layout reads identically.
  // Remove the fallback key once your real assets are in /public.
  1: { type: 'floor',  src: '/00031530.png', fallback: { fill: '#2c2e3b', border: '#424451' } },
  2: { type: 'floor',  src: '/00031531.png', fallback: { fill: '#1a1c23', border: '#303239' } },
  3: { type: 'entity', src: '/00031377.png', fallback: { fill: '#FFA500', border: '#FFB733' } },
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

// World 3 — Hardcoded 2D sprite test (5 × 5)
// IDs map to tileDictionary entries above.
// Tile 1 and 2 are floor variants; tile 3 is the entity/prop in the centre.
// This world is designed for 2D render-mode testing — load it and press R.
const WORLD_3 = [
  [1, 2, 1, 2, 1],
  [2, 1, 2, 1, 2],
  [1, 2, 3, 2, 1],
  [2, 1, 2, 1, 2],
  [1, 2, 1, 2, 1],
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
