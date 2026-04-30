import * as THREE from 'three';

export const MODE = { FOV: 'A', SPOT: 'B' };

// Bresenham's line from (x0,z0) to (x1,z1) — returns every grid cell crossed.
function bresenham(x0, z0, x1, z1) {
  const cells = [];
  let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  let dz = Math.abs(z1 - z0), sz = z0 < z1 ? 1 : -1;
  let err = dx - dz;
  let cx = x0, cz = z0;
  for (;;) {
    cells.push([cx, cz]);
    if (cx === x1 && cz === z1) break;
    const e2 = 2 * err;
    if (e2 > -dz) { err -= dz; cx += sx; }
    if (e2 <  dx) { err += dx; cz += sz; }
  }
  return cells;
}

export class LightingManager {
  constructor(scene, worldRenderer) {
    this.scene = scene;
    this.lm = worldRenderer;
    this.mode = MODE.FOV;
    this.fovRadius = 7;
    // Cache the last grid position so _computeFOV only runs when the player
    // actually crosses a cell boundary, not on every animation frame.
    this._cachedGX = null;
    this._cachedGZ = null;

    // ── Mode A lights (FOV) ─────────────────────────────────────────────────
    this.hemi = new THREE.HemisphereLight(0x334466, 0x111122, 1.0);
    scene.add(this.hemi);

    this.dirLight = new THREE.DirectionalLight(0x8899cc, 0.7);
    this.dirLight.position.set(10, 20, 10);
    scene.add(this.dirLight);

    // ── Mode B light (hard spotlight) ───────────────────────────────────────
    this.spot = new THREE.SpotLight(0xffeedd, 4.0);
    this.spot.angle = Math.PI / 5;  // ~36° cone
    this.spot.penumbra = 0;         // hard pixel-perfect edge
    this.spot.distance = 22;
    this.spot.castShadow = true;
    this.spot.shadow.mapSize.set(1024, 1024);
    this.spot.shadow.camera.near = 0.5;
    this.spot.shadow.camera.far = 28;

    this.spotTarget = new THREE.Object3D();
    scene.add(this.spotTarget);
    this.spot.target = this.spotTarget;
    this.spot.visible = false;
    scene.add(this.spot);

    this._applyMode();
  }

  toggle() {
    this.mode = this.mode === MODE.FOV ? MODE.SPOT : MODE.FOV;
    this._applyMode();
    // Invalidate so the next computeFOV() call runs unconditionally.
    this._cachedGX = null;
    this._cachedGZ = null;
  }

  // Called every animation frame — drives spotlight position only.
  // FOV visibility is computed on-demand via computeFOV(), not here.
  update(playerPos) {
    if (this.mode === MODE.SPOT) {
      this.spot.position.set(playerPos.x, playerPos.y + 9, playerPos.z);
      this.spotTarget.position.set(playerPos.x, 0, playerPos.z);
    }
  }

  // Public: run the FOV only when the player has moved to a new grid cell.
  // Exits immediately if the grid position is unchanged — safe to call
  // from handleInput() every frame without measurable cost.
  computeFOV(playerPos) {
    if (this.mode !== MODE.FOV) return;
    const gx = Math.round(playerPos.x);
    const gz = Math.round(playerPos.z);
    if (gx === this._cachedGX && gz === this._cachedGZ) return;
    this._cachedGX = gx;
    this._cachedGZ = gz;
    this._computeFOV(playerPos);
  }

  // Force the next computeFOV() call to recompute regardless of cached position.
  // Use this after world switches or radius changes.
  invalidateFOV() {
    this._cachedGX = null;
    this._cachedGZ = null;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _applyMode() {
    const isFov = this.mode === MODE.FOV;
    this.hemi.visible     = isFov;
    this.dirLight.visible = isFov;
    this.spot.visible     = !isFov;
    // Spotlight mode: restore full visibility — the light itself handles shading.
    if (!isFov) this.lm.setAllVisible(true);
  }

  // Recursive Bresenham shadowcasting:
  //  • For every grid cell within fovRadius, trace a line from the player.
  //  • Accumulate every cell along the trace into `visible`.
  //  • Stop tracing past the first wall hit (wall is visible, cells behind are not).
  _computeFOV(playerPos) {
    const px = Math.round(playerPos.x);
    const pz = Math.round(playerPos.z);
    const R  = this.fovRadius;
    const R2 = R * R;
    const visible = new Set();

    for (let tx = px - R; tx <= px + R; tx++) {
      for (let tz = pz - R; tz <= pz + R; tz++) {
        if ((tx - px) ** 2 + (tz - pz) ** 2 > R2) continue;

        for (const [lx, lz] of bresenham(px, pz, tx, tz)) {
          visible.add(`${lx},${lz}`);
          // Wall is visible but occludes everything behind it.
          if (this.lm.isWall(lx, lz) && !(lx === px && lz === pz)) break;
        }
      }
    }

    this.lm.setAllVisible(false);
    for (const key of visible) {
      const [x, z] = key.split(',').map(Number);
      this.lm.setMeshVisible(x, z, true);
    }
  }
}
