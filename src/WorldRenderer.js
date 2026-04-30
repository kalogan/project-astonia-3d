import * as THREE from 'three';
import { TILE } from './LevelManager.js';

export class WorldRenderer {
  constructor(scene, levelManager, textures = {}) {
    this.scene          = scene;
    this.lm             = levelManager;
    this.floorTex       = textures.floor       ?? null;
    this.wallTex        = textures.wall        ?? null;
    this.floorSpriteTex = textures.floorSprite ?? null;
    this.wallSpriteTex  = textures.wallSprite  ?? null;
    this.tileDict       = textures.tileDict    ?? {};
    this.textured       = false;
    this.renderMode     = '3D';

    // meshMap[`${gx},${gz}`] = { mesh, greyMat, texMat }
    this.meshMap = new Map();
    // Cache loaded textures by src path — one GPU upload per unique asset.
    this._texCache = new Map();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Dispose all meshes and rebuild from the current LevelManager grid. */
  rebuild() {
    this.clearMeshes();
    if (this.renderMode === '3D') {
      this._render3DWorld();
    } else {
      this._render2DWorld();
    }
  }

  /** Toggle between '3D' and '2D' render modes and rebuild. */
  toggleRenderMode() {
    this.renderMode = this.renderMode === '3D' ? '2D' : '3D';
    this.rebuild();
  }

  /** Swap all tile materials between greybox and textured. */
  setTextured(enabled) {
    this.textured = enabled;
    for (const entry of this.meshMap.values()) {
      entry.mesh.material = enabled ? entry.texMat : entry.greyMat;
    }
  }

  /** Update the data layer AND spawn/replace a single floor mesh. */
  spawnFloor(gx, gz) {
    this.lm.spawnFloor(gx, gz);
    this._removeMesh(gx, gz);
    if (this.renderMode === '3D') {
      this._spawnFloor3D(gx, gz);
    } else {
      this._spawnFloor2D(gx, gz);
    }
  }

  /** Update the data layer AND spawn/replace a single wall mesh. */
  spawnWall(gx, gz) {
    this.lm.spawnWall(gx, gz);
    this._removeMesh(gx, gz);
    if (this.renderMode === '3D') {
      this._spawnWall3D(gx, gz);
    } else {
      this._spawnWall2D(gx, gz);
    }
  }

  /** Dispose all existing meshes and remove them from the scene. */
  clearMeshes() {
    for (const entry of this.meshMap.values()) {
      this.scene.remove(entry.mesh);
      entry.greyMat.dispose();
      entry.texMat.dispose();
      // Sprites share an internal geometry — only dispose per-mesh geometries.
      if (!entry.mesh.isSprite) entry.mesh.geometry.dispose();
    }
    this.meshMap.clear();
  }

  // ── LightingManager interface (mirrors old LevelManager API) ───────────────

  isWall(x, z) {
    return this.lm.isWall(x, z);
  }

  setAllVisible(visible) {
    for (const entry of this.meshMap.values()) {
      entry.mesh.visible = visible;
    }
  }

  setMeshVisible(x, z, visible) {
    const entry = this.meshMap.get(`${x},${z}`);
    if (entry) entry.mesh.visible = visible;
  }

  // ── 3D world build ─────────────────────────────────────────────────────────

  _render3DWorld() {
    const grid = this.lm.grid;
    for (let gz = 0; gz < grid.length; gz++) {
      const row = grid[gz];
      for (let gx = 0; gx < row.length; gx++) {
        const tile = row[gx];
        if (tile === TILE.FLOOR) this._spawnFloor3D(gx, gz);
        if (tile === TILE.WALL)  this._spawnWall3D(gx, gz);
      }
    }
  }

  _spawnFloor3D(gx, gz) {
    const geo      = new THREE.PlaneGeometry(1, 1);
    const greyMat  = new THREE.MeshLambertMaterial({ color: 0x444455 });
    const texMat   = new THREE.MeshStandardMaterial({
      map: this.floorTex ?? null,
      color: this.floorTex ? 0xffffff : 0x666677,
    });
    const mesh     = new THREE.Mesh(geo, this.textured ? texMat : greyMat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(gx, 0, gz);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.meshMap.set(`${gx},${gz}`, { mesh, greyMat, texMat });
  }

  _spawnWall3D(gx, gz) {
    const geo     = new THREE.BoxGeometry(1, 1, 1);
    const greyMat = new THREE.MeshLambertMaterial({ color: 0x223344 });
    const texMat  = new THREE.MeshStandardMaterial({
      map: this.wallTex ?? null,
      color: this.wallTex ? 0xffffff : 0x334455,
    });
    const mesh    = new THREE.Mesh(geo, this.textured ? texMat : greyMat);
    mesh.position.set(gx, 0.5, gz);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    this.meshMap.set(`${gx},${gz}`, { mesh, greyMat, texMat });
  }

  // ── 2D isometric sprite build ──────────────────────────────────────────────
  //
  // Sprites always face the camera (billboard). With the isometric camera fixed
  // at a (20,20,20) offset the sprites appear at the correct isometric angle.
  //
  // Depth sorting: depthTest/depthWrite are disabled so renderOrder is the sole
  // stacking authority. Higher gz = visually closer to the viewer = drawn on top.
  // The formula  gz * 100 + gx  produces a stable, non-overlapping sort key.
  // Entities get an extra +50 so they always clear their own floor tile.
  //
  // Type config — adjust scales once you have real assets in place:
  //   floor:  flat tile, sits at y=0
  //   wall:   taller block, sits at y=0.5
  //   entity: character/prop height, sits at y=0.5

  static SPRITE_TYPE = {
    floor:  { sx: 1.4, sy: 1.4, y: 0,   bias: 0  },
    wall:   { sx: 1.4, sy: 2.0, y: 0.5, bias: 10 },
    entity: { sx: 1.0, sy: 1.8, y: 0.5, bias: 50 },
  };

  _render2DWorld() {
    const grid = this.lm.grid;
    for (let gz = 0; gz < grid.length; gz++) {
      const row = grid[gz];
      for (let gx = 0; gx < row.length; gx++) {
        const def = this.tileDict[row[gx]];
        if (def) this._spawnTile2D(gx, gz, def);
      }
    }
  }

  // Dictionary-driven sprite spawn used by _render2DWorld().
  // def = { type: 'floor'|'wall'|'entity', src: '/path.png' }
  _spawnTile2D(gx, gz, def) {
    const cfg = WorldRenderer.SPRITE_TYPE[def.type] ?? WorldRenderer.SPRITE_TYPE.floor;

    const tex    = this._loadTex(def.src);
    const mat    = new THREE.SpriteMaterial({
      map:        tex,
      color:      0xffffff,
      depthTest:  false,
      depthWrite: false,
      transparent: true,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(cfg.sx, cfg.sy, 1);
    sprite.position.set(gx, cfg.y, gz);
    sprite.renderOrder = gz * 100 + gx + cfg.bias;
    this.scene.add(sprite);
    // greyMat and texMat both point to the same material — the dictionary already
    // supplies a texture for every entry so there is no separate "greybox" state.
    this.meshMap.set(`${gx},${gz}`, { mesh: sprite, greyMat: mat, texMat: mat });
  }

  // Cached pixel-art texture loader — each unique src path loads exactly once.
  _loadTex(src) {
    if (this._texCache.has(src)) return this._texCache.get(src);
    const tex = new THREE.TextureLoader().load(src);
    tex.magFilter      = THREE.NearestFilter;
    tex.minFilter      = THREE.NearestFilter;
    tex.generateMipmaps = false;
    this._texCache.set(src, tex);
    return tex;
  }

  // Legacy per-tile spawn helpers — used by the public spawnFloor / spawnWall API
  // when the user manually places tiles while in 2D mode.

  _spawnFloor2D(gx, gz) {
    const greyMat = new THREE.SpriteMaterial({
      color: 0x33334a, depthTest: false, depthWrite: false, transparent: true,
    });
    const texMat = new THREE.SpriteMaterial({
      map: this.floorSpriteTex, color: 0xffffff,
      depthTest: false, depthWrite: false, transparent: true,
    });
    const sprite = new THREE.Sprite(this.textured ? texMat : greyMat);
    sprite.scale.set(1.4, 1.4, 1);
    sprite.position.set(gx, 0, gz);
    sprite.renderOrder = gz * 100 + gx;
    this.scene.add(sprite);
    this.meshMap.set(`${gx},${gz}`, { mesh: sprite, greyMat, texMat });
  }

  _spawnWall2D(gx, gz) {
    const greyMat = new THREE.SpriteMaterial({
      color: 0x1a1a2e, depthTest: false, depthWrite: false, transparent: true,
    });
    const texMat = new THREE.SpriteMaterial({
      map: this.wallSpriteTex, color: 0xffffff,
      depthTest: false, depthWrite: false, transparent: true,
    });
    const sprite = new THREE.Sprite(this.textured ? texMat : greyMat);
    sprite.scale.set(1.4, 2.0, 1);
    sprite.position.set(gx, 0.5, gz);
    sprite.renderOrder = gz * 100 + gx;
    this.scene.add(sprite);
    this.meshMap.set(`${gx},${gz}`, { mesh: sprite, greyMat, texMat });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _removeMesh(gx, gz) {
    const key   = `${gx},${gz}`;
    const entry = this.meshMap.get(key);
    if (!entry) return;
    this.scene.remove(entry.mesh);
    entry.greyMat.dispose();
    entry.texMat.dispose();
    if (!entry.mesh.isSprite) entry.mesh.geometry.dispose();
    this.meshMap.delete(key);
  }
}
