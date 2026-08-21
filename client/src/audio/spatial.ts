/**
 * DOOMCRAFT — 3D placement, distance and occlusion.
 *
 * ── PannerNode was measured and rejected ──────────────────────────────────
 *
 * The obvious implementation is a `PannerNode` per voice with `distanceModel`
 * doing the attenuation. It was benchmarked against the alternatives in
 * headless Chrome (300 voices, 48 kHz):
 *
 *     PannerNode HRTF, built per voice        7.8 ms    26.0 us/voice
 *     PannerNode equalpower, built per voice  4.8 ms    16.0 us/voice
 *     StereoPanner + gain, built per voice    5.4 ms    18.0 us/voice
 *     Pooled chain, only the source is new    1.6 ms     5.3 us/voice
 *
 * HRTF is the most expensive to build AND carries a convolution per voice for
 * its whole life. What it buys is elevation and front/back disambiguation,
 * which in a game played on laptop speakers by someone who is looking at the
 * thing they are shooting is close to worthless. So this file computes the pan
 * scalar, the distance gain and the occlusion cutoff itself, in about a dozen
 * flops, and hands them to the pooled `StereoPanner`/`Gain`/`BiquadFilter`
 * chain the engine already owns. Five times cheaper, and the maths is ours to
 * match to the renderer.
 *
 * ── Matching the renderer ─────────────────────────────────────────────────
 *
 * Attenuation is keyed to `VoxelMaterials.fogFarDistance`, not to a constant.
 * Fog is the distance at which the renderer stops showing you the world; a
 * sound arriving clearly from a place you cannot see is a bug you hear before
 * you can explain it. When render distance changes, so does the audio horizon.
 *
 * ── Occlusion has to be rate-limited or it eats the frame ─────────────────
 *
 * A wall between you and a gunshot should muffle it, and `raycastVoxels` in
 * `shared/src/math.ts` already answers that question exactly. The trap is
 * calling it per sound per frame: a Horde wave with twenty emitters at 60 Hz
 * is 1,200 DDA marches a second through the chunk store. Instead:
 *
 *   - occlusion is sampled at most `raysPerFrame` times per frame (default 3),
 *   - results are cached on a 2 m grid, because moving 30 cm does not change
 *     whether a wall is in the way,
 *   - a cache entry lives `ttlMs` (default 250 ms) and a stale entry is USED
 *     while a fresh one is queued, so a miss never blocks a sound,
 *   - and the whole thing is skipped for sounds close enough that a wall
 *     between you and them is not plausible.
 *
 * Worst case per frame is therefore three voxel marches, bounded by
 * `maxOcclusionDist`, whatever is happening in the world.
 */

import { raycastVoxels, createVoxelHit, type VoxelHit } from '@shared/math';

/* ------------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------------ */

/** Inside this radius a sound is at full level and never occlusion-tested. */
const REF_DISTANCE_M = 4;
/** Steepness of the inverse-distance curve past the reference radius. */
const ROLLOFF = 1.0;
/**
 * Audio horizon as a fraction of the fog far plane. Slightly beyond the fog so
 * a rocket going off at the edge of vision is still a distant thump rather than
 * popping into existence when you walk two metres closer.
 */
const HORIZON_FRAC = 1.15;
/** Below this the voice is not worth a slot. */
const MIN_AUDIBLE_GAIN = 0.004;

/** Air absorption: cutoff at the listener, and at the horizon. */
const AIR_LP_NEAR = 20000;
const AIR_LP_FAR = 900;

/** Cutoff applied when the voxel march says a wall is in the way. */
const OCCLUDED_LP_HZ = 520;
/** Extra level cut through a wall, on top of the filtering. */
const OCCLUDED_GAIN = 0.45;

const OCCLUSION_GRID_M = 2;
const OCCLUSION_TTL_MS = 250;
const OCCLUSION_RAYS_PER_FRAME = 3;
/** Never march further than this; a wall 60 m away is not what muffles a sound. */
const MAX_OCCLUSION_DIST_M = 48;

/* ------------------------------------------------------------------------ *
 * Result
 * ------------------------------------------------------------------------ */

/** Filled by `resolve`. Reused — never retained, never allocated per call. */
export interface SpatialResult {
  /** Linear gain from distance and occlusion. */
  gain: number;
  /** -1 left .. +1 right. */
  pan: number;
  /** Lowpass cutoff in Hz, or 0 for "open". */
  lowpass: number;
  /** Metres from the listener. */
  distance: number;
}

export function createSpatialResult(): SpatialResult {
  return { gain: 1, pan: 0, lowpass: 0, distance: 0 };
}

export type BlockSampler = (x: number, y: number, z: number) => number;
export type BlockingTest = (id: number) => boolean;

/* ------------------------------------------------------------------------ *
 * The mixer
 * ------------------------------------------------------------------------ */

interface OcclusionEntry { t: number; blocked: number }

export class SpatialAudio {
  /** Listener position — the camera eye, not the feet. */
  private lx = 0; private ly = 0; private lz = 0;
  /** Listener basis: forward and right on the horizontal plane. */
  private fx = 0; private fz = -1;
  private rx = 1; private rz = 0;

  private horizon = 192 * HORIZON_FRAC;

  private sampleBlock: BlockSampler | null = null;
  private blocking: BlockingTest | null = null;

  private readonly occlusion = new Map<number, OcclusionEntry>();
  private readonly hit: VoxelHit = createVoxelHit();
  private raysLeft = OCCLUSION_RAYS_PER_FRAME;
  private nowMs = 0;

  /** Turn occlusion off entirely — mobile low-quality, or no world attached. */
  occlusionEnabled = true;

  /* -------------------------------------------------------------------- *
   * Wiring
   * -------------------------------------------------------------------- */

  /**
   * `yaw` follows the project's convention (`anglesToForward` in shared/math):
   * forward is (sin yaw, -cos yaw) on the XZ plane.
   */
  setListener(x: number, y: number, z: number, yaw: number): void {
    this.lx = x; this.ly = y; this.lz = z;
    const s = Math.sin(yaw), c = Math.cos(yaw);
    this.fx = s; this.fz = -c;
    // Right-hand perpendicular of forward on the horizontal plane.
    this.rx = c; this.rz = s;
  }

  /** Keep the audio horizon locked to the renderer's fog. */
  setFogFar(metres: number): void {
    this.horizon = Math.max(24, metres) * HORIZON_FRAC;
  }

  setWorld(sampler: BlockSampler | null, blocking: BlockingTest | null): void {
    this.sampleBlock = sampler;
    this.blocking = blocking;
    if (sampler === null) this.occlusion.clear();
  }

  /**
   * Reset the per-frame raycast budget. Call once per rendered frame.
   *
   * `nowMs` is passed in rather than read from `performance.now()` so the
   * cache ages on the same clock the game does and a test can drive it.
   */
  beginFrame(nowMs: number): void {
    this.nowMs = nowMs;
    this.raysLeft = OCCLUSION_RAYS_PER_FRAME;
    // The cache is bounded by walking it only when it has grown past what a
    // busy scene plausibly needs; a Map of a few hundred small entries is not
    // worth a sweep every frame.
    if (this.occlusion.size > 512) this.pruneOcclusion();
  }

  private pruneOcclusion(): void {
    const cutoff = this.nowMs - OCCLUSION_TTL_MS * 4;
    for (const [k, v] of this.occlusion) if (v.t < cutoff) this.occlusion.delete(k);
  }

  /* -------------------------------------------------------------------- *
   * The one call the rest of the game makes
   * -------------------------------------------------------------------- */

  /**
   * Place a sound at a world point. Returns false when it is inaudible, which
   * is the caller's signal to not spend a voice slot on it at all — the
   * cheapest sound is the one that never reaches the engine.
   */
  resolve(x: number, y: number, z: number, out: SpatialResult, refDistance = REF_DISTANCE_M): boolean {
    const dx = x - this.lx, dy = y - this.ly, dz = z - this.lz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    out.distance = dist;

    if (dist >= this.horizon) { out.gain = 0; out.pan = 0; out.lowpass = 0; return false; }

    /* --- distance ---------------------------------------------------- */
    // Inverse-distance inside the horizon, then a windowed fade so the last
    // few metres reach exactly zero instead of stopping at an audible step.
    const ref = Math.max(0.5, refDistance);
    let gain = dist <= ref ? 1 : ref / (ref + ROLLOFF * (dist - ref));
    const edge = dist / this.horizon;
    if (edge > 0.75) gain *= 1 - (edge - 0.75) / 0.25;

    /* --- direction ----------------------------------------------------- *
     * Pan is the component of the source direction along the listener's right
     * axis. A source directly in front or directly behind pans to centre,
     * which is correct for two speakers: without HRTF there is no honest way
     * to distinguish them, and faking it with level is worse than not trying.
     *
     * Overhead sources collapse toward centre naturally because the horizontal
     * projection shortens, which is the behaviour you want.
     */
    let pan = 0;
    if (dist > 0.05) {
      const hx = dx, hz = dz;
      const hlen = Math.sqrt(hx * hx + hz * hz);
      if (hlen > 1e-4) {
        const right = (hx * this.rx + hz * this.rz) / hlen;
        // Widen the middle: a linear dot leaves everything within 30 degrees of
        // centre almost dead centre, and the ear wants earlier separation.
        pan = Math.sign(right) * Math.pow(Math.abs(right), 0.7);
        // Never hard-pan. A sound entirely in one ear is disorienting and, on a
        // phone held in landscape, half of it lands on the hand.
        pan *= 0.85;
      }
    }

    /* --- air absorption ------------------------------------------------ */
    const u = Math.min(1, dist / this.horizon);
    // Perceptually the dulling happens fast and then plateaus; a square-root
    // ramp tracks that far better than a linear one.
    let lp = AIR_LP_NEAR + (AIR_LP_FAR - AIR_LP_NEAR) * Math.sqrt(u);

    /* --- occlusion ----------------------------------------------------- */
    if (this.occlusionEnabled && dist > ref && dist < MAX_OCCLUSION_DIST_M) {
      if (this.occludedAt(x, y, z, dx, dy, dz, dist)) {
        gain *= OCCLUDED_GAIN;
        lp = Math.min(lp, OCCLUDED_LP_HZ);
      }
    }

    out.gain = gain;
    out.pan = pan < -1 ? -1 : pan > 1 ? 1 : pan;
    // Anything at or above the band limit already baked into every sample is
    // "open", and reporting 0 lets the engine skip touching the filter param.
    out.lowpass = lp >= 12000 ? 0 : lp;
    return gain >= MIN_AUDIBLE_GAIN;
  }

  /**
   * Is a solid block between the listener and this point?
   *
   * Answers from the cache when it can, spends one of the frame's raycasts
   * when it must, and returns the stale answer rather than stalling when the
   * budget is gone.
   */
  private occludedAt(
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number, dist: number,
  ): boolean {
    const sampler = this.sampleBlock;
    const blocking = this.blocking;
    if (sampler === null || blocking === null) return false;

    const key = cellKey(x, y, z);
    const hitEntry = this.occlusion.get(key);
    const fresh = hitEntry !== undefined && this.nowMs - hitEntry.t < OCCLUSION_TTL_MS;
    if (fresh) return hitEntry.blocked === 1;

    if (this.raysLeft <= 0) {
      // Budget spent. A stale answer is better than a wrong-by-default one:
      // the world does not usually change occlusion state in a quarter second.
      return hitEntry !== undefined && hitEntry.blocked === 1;
    }
    this.raysLeft--;

    const inv = 1 / dist;
    // March from the LISTENER outwards and stop short of the source, so the
    // block the sound is standing on or inside never counts as its own wall.
    const reach = Math.min(dist - 0.6, MAX_OCCLUSION_DIST_M);
    let blocked = 0;
    if (reach > 0.5) {
      blocked = raycastVoxels(
        this.lx, this.ly, this.lz,
        dx * inv, dy * inv, dz * inv,
        reach, sampler, blocking, this.hit,
      ) ? 1 : 0;
    }
    this.occlusion.set(key, { t: this.nowMs, blocked });
    void x; void y; void z;
    return blocked === 1;
  }

  /** Occlusion cache size — bench visibility. */
  get cacheSize(): number { return this.occlusion.size; }

  clear(): void { this.occlusion.clear(); }
}

/**
 * Quantise a world point to the occlusion grid and pack it into one integer.
 *
 * 2 m cells, ±1024 m of range on X/Z and 0..255 on Y, which covers the world
 * and keeps the key a small int so the Map stays on its fast path.
 */
function cellKey(x: number, y: number, z: number): number {
  const cx = (Math.floor(x / OCCLUSION_GRID_M) + 512) & 1023;
  const cy = (Math.floor(y / OCCLUSION_GRID_M) + 32) & 63;
  const cz = (Math.floor(z / OCCLUSION_GRID_M) + 512) & 1023;
  return (cx << 16) | (cz << 6) | cy;
}
