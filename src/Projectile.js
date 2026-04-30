import * as THREE from 'three';

// ── Direction vectors ─────────────────────────────────────────────────────────
// Maps compass strings to normalised (dx, dz) unit vectors in world space.
// Diagonals are divided by √2 so all directions travel at identical speed.
const INV_SQRT2 = 1 / Math.sqrt(2);

const DIRECTION_VECTORS = {
  N:  { dx:  0,         dz: -1         },
  NE: { dx:  INV_SQRT2, dz: -INV_SQRT2 },
  E:  { dx:  1,         dz:  0         },
  SE: { dx:  INV_SQRT2, dz:  INV_SQRT2 },
  S:  { dx:  0,         dz:  1         },
  SW: { dx: -INV_SQRT2, dz:  INV_SQRT2 },
  W:  { dx: -1,         dz:  0         },
  NW: { dx: -INV_SQRT2, dz: -INV_SQRT2 },
};

// ── Fireball texture ──────────────────────────────────────────────────────────
// Radial gradient on a canvas element — created once and shared by all
// Projectile instances.  No external asset required.
let _fireballTex = null;

function getFireballTexture() {
  if (_fireballTex) return _fireballTex;

  const SIZE   = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const ctx  = canvas.getContext('2d');
  const half = SIZE / 2;

  const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
  grad.addColorStop(0,    'rgba(255, 255, 200, 1.00)');  // white-yellow core
  grad.addColorStop(0.25, 'rgba(255, 170,  20, 0.95)');  // bright orange
  grad.addColorStop(0.55, 'rgba(220,  50,   0, 0.70)');  // deep red
  grad.addColorStop(1,    'rgba( 80,   0,   0, 0.00)');  // transparent edge

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, SIZE, SIZE);

  _fireballTex = new THREE.CanvasTexture(canvas);
  return _fireballTex;
}

// ── Projectile ────────────────────────────────────────────────────────────────
//
// A single travelling fireball.  Rendered as a THREE.Sprite with additive
// blending for a natural glow.  The caller owns the activeProjectiles array
// and is responsible for calling dispose() once alive === false.
//
// Usage (main.js):
//   const p = new Projectile(scene, player.position.x, player.position.z, 'NE');
//   activeProjectiles.push(p);
//
//   // in animate():
//   for (let i = activeProjectiles.length - 1; i >= 0; i--) {
//     activeProjectiles[i].update(deltaMs);
//     if (!activeProjectiles[i].alive) {
//       activeProjectiles[i].dispose();
//       activeProjectiles.splice(i, 1);
//     }
//   }

export class Projectile {
  /**
   * @param {THREE.Scene} scene     Scene to add the sprite to.
   * @param {number}      x         World-space X start position.
   * @param {number}      z         World-space Z start position.
   * @param {string}      direction Compass direction string, e.g. 'NE'.
   * @param {number}      speed     Travel speed in world units/second (default 8).
   */
  constructor(scene, x, z, direction, speed = 8) {
    const vec  = DIRECTION_VECTORS[direction] ?? DIRECTION_VECTORS.S;
    this._dx   = vec.dx;
    this._dz   = vec.dz;
    this._speed = speed;

    this._distanceTraveled = 0;
    this.MAX_DISTANCE      = 16;  // world units — ~1 full grid diameter on 12×12 map

    this.alive  = true;
    this._scene = scene;

    const mat = new THREE.SpriteMaterial({
      map:         getFireballTexture(),
      transparent: true,
      depthTest:   false,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
    });

    this._sprite = new THREE.Sprite(mat);
    this._sprite.scale.set(0.7, 0.7, 1);
    // Start slightly above the floor (0.9) so it clears tile edges visually.
    this._sprite.position.set(x, 0.9, z);
    scene.add(this._sprite);
  }

  /**
   * Translate the projectile by its velocity for this frame.
   * Sets alive = false once MAX_DISTANCE is exceeded — the caller must then
   * call dispose() and remove the instance from the active list.
   *
   * @param {number} deltaMs Elapsed ms since the last frame (delta-time).
   */
  update(deltaMs) {
    if (!this.alive) return;

    const step = (this._speed * deltaMs) / 1000;  // world units this frame
    this._sprite.position.x += this._dx * step;
    this._sprite.position.z += this._dz * step;
    this._distanceTraveled  += step;

    // Depth-sort against floor tiles and player sprite so the fireball always
    // renders at the correct isometric layer as it moves across the grid.
    const gz = Math.round(this._sprite.position.z);
    const gx = Math.round(this._sprite.position.x);
    this._sprite.renderOrder = gz * 100 + gx + 60;

    if (this._distanceTraveled >= this.MAX_DISTANCE) this.alive = false;
  }

  /**
   * Remove the sprite from the scene and release GPU resources.
   * The shared fireball texture is NOT disposed — it is module-owned.
   */
  dispose() {
    this._scene.remove(this._sprite);
    this._sprite.material.dispose();
    this._sprite = null;
    this.alive   = false;
  }
}
