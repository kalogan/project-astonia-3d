// ── Scene Registry ─────────────────────────────────────────────────────────────
// Each scene descriptor holds a label, a 2-D tile grid, and a player spawn point.
// Grid values may be TILE constants (1=floor, 2=wall) or tileDictionary IDs.
// See LevelManager.js for the full tile key.

import { WORLDS } from './LevelManager.js';

// ── Town Spawn — 12 × 12 ───────────────────────────────────────────────────────
// Tile key used here:
//   1 = grass floor    3 = stone floor    5/6/7 = trees (prop, floorBase 1)
//   4 = mine cart (prop, floorBase 3)     8 = stone wall (collision-blocking)
const TOWN_SPAWN = [
  [ 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8 ],   // z=0  outer wall
  [ 8, 5, 1, 1, 1, 1, 1, 1, 1, 1, 6, 8 ],   // z=1  NW / NE trees
  [ 8, 1, 8, 8, 1, 1, 1, 1, 8, 8, 1, 8 ],   // z=2  building faces (NW / NE)
  [ 8, 1, 8, 1, 1, 1, 1, 1, 1, 8, 1, 8 ],   // z=3  building interiors open
  [ 8, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 8 ],   // z=4  open plaza (spawn row)
  [ 8, 1, 1, 1, 1, 3, 3, 1, 1, 1, 1, 8 ],   // z=5  stone market square
  [ 8, 1, 1, 1, 1, 3, 4, 1, 1, 1, 1, 8 ],   // z=6  mine cart on stone
  [ 8, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 8 ],   // z=7  open plaza
  [ 8, 1, 8, 1, 1, 1, 1, 1, 1, 8, 1, 8 ],   // z=8  building interiors open
  [ 8, 1, 8, 8, 1, 1, 1, 1, 8, 8, 1, 8 ],   // z=9  building faces (SW / SE)
  [ 8, 7, 1, 1, 1, 1, 1, 1, 1, 1, 5, 8 ],   // z=10 SW / SE trees
  [ 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8 ],   // z=11 outer wall
];

// ── Empty Test — 7 × 7 ────────────────────────────────────────────────────────
// Open floor with no obstacles. Useful for movement / mechanics testing.
const EMPTY_TEST = [
  [ 1, 1, 1, 1, 1, 1, 1 ],
  [ 1, 1, 1, 1, 1, 1, 1 ],
  [ 1, 1, 1, 1, 1, 1, 1 ],
  [ 1, 1, 1, 1, 1, 1, 1 ],
  [ 1, 1, 1, 1, 1, 1, 1 ],
  [ 1, 1, 1, 1, 1, 1, 1 ],
  [ 1, 1, 1, 1, 1, 1, 1 ],
];

// ── Registry ───────────────────────────────────────────────────────────────────
export const SCENES = {
  world_1:    { label: 'Dungeon Room',   grid: WORLDS[1], spawn: { x: 2, z: 2 } },
  world_2:    { label: 'Maze Corridor',  grid: WORLDS[2], spawn: { x: 2, z: 2 } },
  world_3:    { label: 'Asset Showcase', grid: WORLDS[3], spawn: { x: 2, z: 2 } },
  town_spawn: { label: 'Town Spawn',     grid: TOWN_SPAWN, spawn: { x: 5, z: 4 }, mapFile: 'town_spawn' },
  empty_test: { label: 'Empty Test',     grid: EMPTY_TEST, spawn: { x: 3, z: 3 } },
};
