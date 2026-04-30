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

  /**
   * Translate every tileDictionary ID in the grid into a canonical TILE constant
   * so that 3D mode has correct floor/wall data after 2D edits.
   *
   * Mapping:
   *   type 'wall'          → TILE.WALL  (2) — collision-blocking BoxGeometry
   *   type 'floor'|'entity'→ TILE.FLOOR (1) — walkable PlaneGeometry
   *                                            (entities sit on top in 3D)
   *
   * Call this before switching from 2D → 3D (already wired into the render-toggle
   * button in main.js).  Also call it any time a tile is placed in 2D mode via
   * the dev-tools buttons so the collision grid stays in sync.
   */
  syncWorlds() {
    const grid = this.lm.grid;
    let changed = 0;

    for (let gz = 0; gz < grid.length; gz++) {
      const row = grid[gz];
      if (!row) continue;
      for (let gx = 0; gx < row.length; gx++) {
        const id  = row[gx];
        const def = this.tileDict[id];
        if (!def) continue;         // already a canonical TILE or EMPTY — skip

        const canon = def.type === 'wall' ? TILE.WALL : TILE.FLOOR;
        if (row[gx] !== canon) { row[gx] = canon; changed++; }
      }
    }

    console.log(`[WorldRenderer] syncWorlds — ${changed} cell(s) canonicalised for 3D.`);
    return changed;
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

  // Isometric scale derivation — camera sits at equal (20,20,20) offset (true iso):
  //   cell screen-width  = √2   ≈ 1.414 world units  (horizontal diamond diagonal)
  //   cell screen-height = 2/√6 ≈ 0.816 world units  (vertical diamond diagonal)
  //   1 world-Y unit = 2/√6 ≈ 0.816 screen-up units
  //
  // Wall: floor-height + 1-unit face = 2 × 0.816 = 1.633.
  // Wall y=0.8 → bottom at 0.8×0.816 − 1.633/2 ≈ 0, flush with the floor plane.
  static SPRITE_TYPE = {
    floor:  { sx: 1.414, sy: 0.816, y: 0.00, bias: 0  },
    wall:   { sx: 1.414, sy: 1.633, y: 0.80, bias: 10 },
    entity: { sx: 1.000, sy: 1.800, y: 0.50, bias: 50 },
  };

  _render2DWorld() {
    const grid = this.lm.grid;

    // Build the full spawn list up-front so we know exactly what to load.
    const toSpawn = [];
    for (let gz = 0; gz < grid.length; gz++) {
      for (let gx = 0; gx < grid[gz].length; gx++) {
        const id  = grid[gz][gx];
        const def = this.tileDict[id];
        if (def) toSpawn.push({ gx, gz, def });
      }
    }

    console.log(
      `[WorldRenderer] _render2DWorld` +
      ` | grid ${grid[0]?.length ?? 0}×${grid.length}` +
      ` | tileDict keys: [${Object.keys(this.tileDict).join(', ')}]` +
      ` | tiles to spawn: ${toSpawn.length}`
    );

    if (toSpawn.length === 0) {
      console.warn('[WorldRenderer] No matching tiles — check tileDictionary IDs match grid values.');
      return;
    }

    const spawnAll = () => {
      for (const { gx, gz, def } of toSpawn) {
        this._spawnTile2D(gx, gz, def);
      }
      console.log(`[WorldRenderer] Done — ${toSpawn.length} sprites added to scene.`);
    };

    // Collect src paths that are not yet in the texture cache.
    const newSrcs = [...new Set(toSpawn.map(t => t.def.src))].filter(s => !this._texCache.has(s));

    if (newSrcs.length === 0) {
      // Every texture is already resident — spawn synchronously this frame.
      console.log('[WorldRenderer] All textures cached — spawning immediately.');
      spawnAll();
      return;
    }

    // Some textures need a network/disk fetch.  Use LoadingManager so we spawn
    // only after every asset is decoded and on the GPU.
    console.log(`[WorldRenderer] Loading ${newSrcs.length} new texture(s):`, newSrcs);

    const manager = new THREE.LoadingManager(
      spawnAll,                                             // onLoad
      undefined,                                            // onProgress
      url => console.error(`[WorldRenderer] Failed to load texture: ${url}`)
    );

    // Build a src → fallback lookup so the onError handler can find the right colors.
    const fallbackBySrc = new Map(
      toSpawn
        .filter(t => t.def.fallback)
        .map(t => [t.def.src, t.def.fallback])
    );

    const loader = new THREE.TextureLoader(manager);
    for (const src of newSrcs) {
      const fb  = fallbackBySrc.get(src) ?? null;
      const tex = loader.load(src, undefined, undefined, () => {
        if (fb) {
          tex.image = this._makeFallbackCanvas(fb.fill, fb.border ?? null);
          tex.needsUpdate = true;
          console.log(`[WorldRenderer] Fallback applied for ${src} → fill:${fb.fill}`);
        }
      });
      tex.magFilter      = THREE.NearestFilter;
      tex.minFilter      = THREE.NearestFilter;
      tex.generateMipmaps = false;
      this._texCache.set(src, tex);
    }
  }

  // Dictionary-driven sprite spawn used by _render2DWorld().
  // def = { type: 'floor'|'wall'|'entity', src: '/path.png' }
  _spawnTile2D(gx, gz, def) {
    const cfg = WorldRenderer.SPRITE_TYPE[def.type] ?? WorldRenderer.SPRITE_TYPE.floor;

    const tex    = this._loadTex(def.src, def.fallback ?? null);
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
    // Entity/prop sprites use a bottom anchor so their feet stay on the grid cell.
    if (def.type === 'entity') sprite.center.set(0.5, 0.1);
    this.scene.add(sprite);
    console.log(`[WorldRenderer]   + sprite (${gx},${gz}) type=${def.type} pos=(${gx},${cfg.y},${gz}) renderOrder=${sprite.renderOrder}`);
    // greyMat and texMat both point to the same material — the dictionary already
    // supplies a texture for every entry so there is no separate "greybox" state.
    this.meshMap.set(`${gx},${gz}`, { mesh: sprite, greyMat: mat, texMat: mat });
  }

  // Cached pixel-art texture loader — each unique src path loads exactly once.
  // Pass a fallback config { fill, border? } to get a colored canvas on 404.
  _loadTex(src, fallback = null) {
    if (this._texCache.has(src)) return this._texCache.get(src);
    const tex = new THREE.TextureLoader().load(src, undefined, undefined, () => {
      if (fallback) {
        tex.image = this._makeFallbackCanvas(fallback.fill, fallback.border ?? null);
        tex.needsUpdate = true;
      }
    });
    tex.magFilter      = THREE.NearestFilter;
    tex.minFilter      = THREE.NearestFilter;
    tex.generateMipmaps = false;
    this._texCache.set(src, tex);
    return tex;
  }

  // Draw a 64×64 isometric diamond fallback texture.
  // Corners sit at the mid-point of each canvas edge; 1px stroke stays inset.
  _makeFallbackCanvas(fill, border = null, size = 64) {
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
