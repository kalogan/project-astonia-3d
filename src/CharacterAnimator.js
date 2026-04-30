import * as THREE from 'three';

// ── Direction helper ──────────────────────────────────────────────────────────
//
// Maps a (dx, dz) movement vector to the nearest of 8 compass directions.
//
// Engine coordinate convention (matches main.js / Three.js):
//   dz < 0  →  "up-screen"   = North    (W key)
//   dz > 0  →  "down-screen" = South    (S key)
//   dx > 0  →  right screen  = East     (D key)
//   dx < 0  →  left  screen  = West     (A key)

const DIR_NAMES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * Returns the compass direction string for a movement vector, or null if
 * the vector is zero.  Snaps to the nearest of 8 directions.
 */
export function vecToDirection(dx, dz) {
  if (dx === 0 && dz === 0) return null;
  // atan2(dx, -dz) gives the clockwise angle from North in radians.
  const angle = Math.atan2(dx, -dz);
  const idx   = Math.round((angle / Math.PI) * 4 + 8) % 8;
  return DIR_NAMES[idx];
}

// ── CharacterAnimator ─────────────────────────────────────────────────────────
//
// Consumes an animation dictionary exported by the Asset Lab and drives a
// shared THREE.Texture by hot-swapping its .image on each frame advance.
//
// Dictionary format (produced by the lab's "↓ Anim Dict" export):
//   {
//     "00162000_walk_NE": ["/raw-assets/00162000/frame0.png", ...],
//     "00162000_idle_S":  ["/raw-assets/00162000/frame45.png"],
//     ...
//   }
//
// Usage (main.js):
//   const animator = new CharacterAnimator(dict, '00162000', 12);
//   playerSpriteMat.map = animator.texture;
//   // in animate():  animator.update(deltaMs);
//   // on input:      animator.setState('walk', 'NE');

export class CharacterAnimator {
  /**
   * @param {Object} dict   Animation dictionary — see format above.
   *                        Also accepts the raw lab curated format where values
   *                        are { frames: string[] } objects.
   * @param {string} baseId Character folder/ID prefix, e.g. '00162000'
   * @param {number} fps    Playback rate in frames-per-second (default 12)
   */
  constructor(dict, baseId, fps = 12) {
    this.baseId = baseId;
    this.fps    = fps;

    // Normalise: accept both string[] and { frames: string[] } value shapes.
    this._dict = {};
    for (const [k, v] of Object.entries(dict)) {
      this._dict[k] = Array.isArray(v) ? v : (v.frames ?? []);
    }

    this.action    = 'idle';
    this.direction = 'S';

    // Animation lock — true while a non-interruptible action (e.g. cast_neutral)
    // is playing.  WASD state changes are suppressed during this window.
    this.isLocked  = false;
    // Called exactly once when a locked animation completes its final frame.
    // Set this in loadCharacter to re-evaluate WASD state immediately on unlock.
    this.onUnlock  = null;
    // Called on every frame advance while a locked action is playing.
    // Signature: (action: string, frameIndex: number) => void
    // Use this to trigger effects tied to a specific frame, e.g. spawn a
    // fireball on frame 4 of 'cast_neutral'.
    this.onActionFrame = null;

    this._frameIdx = 0;
    this._elapsed  = 0;      // ms accumulated in the current frame slot
    this._frames   = [];     // HTMLImageElement[] for the active state

    // Single THREE.Texture whose .image is hot-swapped each frame advance.
    // NearestFilter preserves pixel-art crispness without mipmapping cost.
    this.texture                 = new THREE.Texture();
    this.texture.magFilter       = THREE.NearestFilter;
    this.texture.minFilter       = THREE.NearestFilter;
    this.texture.generateMipmaps = false;

    this._loadState('idle', 'S');
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Switch to a new action + direction driven by WASD input.
   * No-op when the animation is locked (a combat action is playing) or when
   * already in the target state.  Falls back gracefully if the target key is
   * absent from the dictionary so the sprite never goes blank.
   */
  setState(action, direction) {
    if (this.isLocked) return;
    if (action === this.action && direction === this.direction) return;

    const key = `${this.baseId}_${action}_${direction}`;
    if (this._dict[key]) {
      this._loadState(action, direction);
      return;
    }

    // Fallback: same action, keep the current direction
    const fallback = `${this.baseId}_${action}_${this.direction}`;
    if (this.action !== action && this._dict[fallback]) {
      this._loadState(action, this.direction);
    }
    // If neither exists, hold the current state rather than going blank.
  }

  /**
   * Trigger a non-interruptible action (e.g. a combat spell) and lock the
   * animator until the animation completes its final frame.  The action plays
   * exactly once — no looping.  Ignored if already locked.
   *
   * @param {string} action    Action name, e.g. 'cast_neutral'
   * @param {string} direction Compass direction, e.g. 'NW'
   */
  triggerAction(action, direction) {
    if (this.isLocked) return;
    const key = `${this.baseId}_${action}_${direction}`;
    if (!this._dict[key]?.length) {
      console.warn(`[CharacterAnimator] triggerAction: state not found "${key}" — ignoring`);
      return;
    }
    this.isLocked = true;
    this._loadState(action, direction);
  }

  /**
   * Advance the animation.  Call once per game-loop iteration, passing the
   * elapsed milliseconds since the previous call (your delta-time value).
   */
  update(deltaMs) {
    if (this._frames.length === 0) return;

    // Single-frame states (e.g. Astonia "idle") need no cycling — but we
    // still call _pushFrame() on the very first update to ensure the texture
    // is populated even before any frame-advance logic runs.
    if (this._frames.length === 1) {
      this._pushFrame();
      // Single-frame locked actions (e.g. a missing state) resolve immediately.
      if (this.isLocked) {
        this.isLocked = false;
        this.onUnlock?.();
      }
      return;
    }

    this._elapsed += deltaMs;
    const frameDuration = 1000 / this.fps;

    if (this._elapsed >= frameDuration) {
      // Consume whole frame slots (handles extreme frame-lag without skipping a full cycle)
      const steps    = Math.floor(this._elapsed / frameDuration);
      this._elapsed -= steps * frameDuration;

      if (this.isLocked) {
        // Locked animations play exactly once — clamp to the final frame rather
        // than looping.  Unlock fires on reaching (or passing) that frame.
        const newIdx = this._frameIdx + steps;
        if (newIdx >= this._frames.length - 1) {
          this._frameIdx = this._frames.length - 1;
          this._pushFrame();
          // Fire the per-frame callback before unlocking so the listener can
          // still read isLocked === true if needed.
          this.onActionFrame?.(this.action, this._frameIdx);
          this.isLocked = false;
          this.onUnlock?.();
          return;
        }
        this._frameIdx = newIdx;
        this._pushFrame();
        this.onActionFrame?.(this.action, this._frameIdx);
      } else {
        this._frameIdx = (this._frameIdx + steps) % this._frames.length;
        this._pushFrame();
      }
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _loadState(action, direction) {
    const key  = `${this.baseId}_${action}_${direction}`;
    const urls = this._dict[key];

    if (!urls?.length) {
      console.warn(`[CharacterAnimator] State not found: "${key}"`);
      return;
    }

    this.action    = action;
    this.direction = direction;
    this._frameIdx = 0;
    this._elapsed  = 0;

    // Create Image elements and start loading.  The onload callback ensures
    // the texture updates even if the image wasn't cached when _pushFrame ran.
    this._frames = urls.map(url => {
      const img = new Image();
      img.onload = () => {
        // Apply immediately if this is still the current active frame.
        if (this._frames[this._frameIdx] === img) {
          this.texture.image       = img;
          this.texture.needsUpdate = true;
        }
      };
      img.onerror = () => {
        // 404 or CORS failure — the URL is not a real file on disk.
        // Export a Character Pack from the Asset Lab and unzip it into public/.
        console.error(
          `[CharacterAnimator] Failed to load frame: "${url}"\n` +
          `  Sprites must be real files under public/raw-assets/.\n` +
          `  Use the "↓ Character Pack" button in the Asset Lab, then\n` +
          `  unzip the downloaded file directly into your project's public/ folder.`
        );
      };
      img.src = url;
      return img;
    });

    this._pushFrame();
  }

  /**
   * Returns a Promise that resolves when the first frame image has decoded,
   * or rejects if it fails (e.g. 404).  Use this in loadCharacter() before
   * wiring up the sprite material — an empty THREE.Texture renders transparent.
   */
  waitForFirstFrame() {
    return new Promise((resolve, reject) => {
      const img = this._frames[0];
      if (!img) { resolve(); return; }
      if (img.complete && img.naturalWidth > 0) { this._pushFrame(); resolve(); return; }
      img.addEventListener('load',  () => resolve(), { once: true });
      img.addEventListener('error', () => reject(new Error(`Frame 0 failed: ${img.src}`)), { once: true });
    });
  }

  _pushFrame() {
    const img = this._frames[this._frameIdx];
    if (!img) return;
    // Only upload to GPU if the image has already decoded; otherwise the
    // onload callback above will do it as soon as it finishes.
    if (img.complete && img.naturalWidth > 0) {
      this.texture.image       = img;
      this.texture.needsUpdate = true;
    }
  }
}
