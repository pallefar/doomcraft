/**
 * DOOMCRAFT — the animation state machine over one character.
 *
 * One `Rig` per body on screen. It owns nothing heavy: the clips are baked once
 * in loader.ts and shared, and a Rig is seven numbers plus two clip cursors.
 *
 * WHAT DRIVES IT
 *
 * The entity state the simulation already sends, and nothing invented beside
 * it. `server/src/sim.ts` publishes ES_MOVING / ES_ATTACK / ES_PAIN / ES_DEAD /
 * ES_FLYING / ES_ALERT / ES_WINDUP per entity, plus a position the client
 * interpolates; `RemotePlayerView` additionally carries a real velocity. The
 * caller turns those into a `RigInput` and the machine turns that into clips.
 * There is no parallel animation channel on the wire and no server change.
 *
 * TWO LAYERS, NOT ONE
 *
 * The base layer is locomotion — idle / walk / sprint / die — and it owns the
 * whole body. An optional upper layer runs over it for the things a shooter
 * needs to read at a glance: `holding-right` puts the gun arm up, and
 * `holding-right-shoot` snaps torso, gun arm and head into the recoil.
 *
 * That layering is the reason loader.ts bakes LOCAL node transforms instead of
 * model-space matrices. A Trooper walking with its rifle up is `walk` on the
 * legs and `holding-right` on the arm at the same time, and it is the single
 * clearest way to tell the hitscan enemy from the melee one at 40 m. The upper
 * layer only touches the nodes its clip actually animates — that mask comes
 * from the glTF channel list, so `holding-right` (arm-right only) leaves the
 * walk's torso sway alone while `holding-right-shoot` (torso, arm, head)
 * correctly takes them over.
 *
 * DEATH STAYS DOWN
 *
 * `die` runs once at rate 1 and then holds its final frame forever. It never
 * cross-fades out and no input can leave the state. The caller keeps a corpse
 * on screen for as long as it wants; the rig will not stand it back up.
 */

import type { BakedClip, CharacterAssets } from './loader';
import { FRAME_STRIDE, RIG_NODE_COUNT, TRS_STRIDE } from './loader';

/* ------------------------------------------------------------------ *
 * Clips
 * ------------------------------------------------------------------ */

export const CLIP_IDLE = 'idle';
export const CLIP_WALK = 'walk';
export const CLIP_SPRINT = 'sprint';
export const CLIP_DIE = 'die';
export const CLIP_PICKUP = 'pick-up';
export const CLIP_HOLD = 'holding-right';
export const CLIP_SHOOT = 'holding-right-shoot';
export const CLIP_SHOOT_BOTH = 'holding-both-shoot';
export const CLIP_MELEE = 'attack-melee-right';

/** Cross-fade between base clips, seconds. */
const FADE_TIME = 0.13;
/** Fade for the upper-body layer, seconds. Snappier: it is a read, not a drift. */
const OVERLAY_FADE = 0.08;

/** Below this ground speed the body is idling. */
const WALK_SPEED = 0.45;
/** Above this it is sprinting. Imps and Lost Souls live up here. */
const SPRINT_SPEED = 6.5;
/** Ground speed at which `walk` plays at rate 1. */
const WALK_REFERENCE = 4.6;
/** Ground speed at which `sprint` plays at rate 1. */
const SPRINT_REFERENCE = 9.5;

/** How long a one-shot attack pose is held before locomotion resumes. */
const ATTACK_HOLD = 0.10;

export interface RigInput {
  /** Horizontal speed, m/s. Drives clip choice and playback rate. */
  speed: number;
  /** Dead: play `die` once and stay down. */
  dead: boolean;
  /** Firing, or winding up to fire. */
  attacking: boolean;
  /** Carries a weapon, so the upper-body layer runs. */
  armed: boolean;
  /** Attacks by swinging: the attack is a full-body one-shot, not an overlay. */
  melee: boolean;
  /** Never touches the ground: locomotion clips are suppressed. */
  hovers: boolean;
  /** Gait multiplier from the archetype; a Baron steps slower than an Imp. */
  cadence: number;
  /** Picking something up — a one-shot that beats locomotion. */
  pickup: boolean;
}

export function createRigInput(): RigInput {
  return {
    speed: 0, dead: false, attacking: false, armed: false,
    melee: false, hovers: false, cadence: 1, pickup: false,
  };
}

/* ------------------------------------------------------------------ *
 * Rig
 * ------------------------------------------------------------------ */

export class Rig {
  /** Current base clip. Null until the first update. */
  private base: BakedClip | null = null;
  private baseTime = 0;
  private baseLoops = true;
  /** The clip being faded out of. */
  private prev: BakedClip | null = null;
  private prevTime = 0;
  private fade = 1;

  private overlay: BakedClip | null = null;
  private overlayTime = 0;
  private overlayWeight = 0;
  private overlayTarget = 0;

  /** Seconds remaining of a one-shot that outranks locomotion. */
  private oneShot = 0;
  private dying = false;

  /** True once `die` has reached its last frame. */
  get down(): boolean { return this.dying && this.base !== null && this.baseTime >= this.base.duration; }
  get isDying(): boolean { return this.dying; }

  reset(): void {
    this.base = null;
    this.baseTime = 0;
    this.baseLoops = true;
    this.prev = null;
    this.prevTime = 0;
    this.fade = 1;
    this.overlay = null;
    this.overlayTime = 0;
    this.overlayWeight = 0;
    this.overlayTarget = 0;
    this.oneShot = 0;
    this.dying = false;
  }

  /** Jump straight into a clip with no cross-fade. Spawns and pooled reuse. */
  snapTo(assets: CharacterAssets, name: string): void {
    const clip = assets.clips.get(name);
    if (clip === undefined) return;
    this.base = clip;
    this.baseTime = 0;
    this.baseLoops = true;
    this.prev = null;
    this.fade = 1;
  }

  update(assets: CharacterAssets, dt: number, input: RigInput): void {
    if (dt < 0) dt = 0;
    if (dt > 0.25) dt = 0.25;

    /* --- death outranks everything and is one-way --------------------- */
    if (input.dead && !this.dying) {
      this.dying = true;
      this.oneShot = 0;
      this.overlayTarget = 0;
      this.setBase(assets, CLIP_DIE, false, FADE_TIME);
    }
    if (this.dying) {
      this.advance(dt, 1);
      this.overlayWeight = Math.max(0, this.overlayWeight - dt / OVERLAY_FADE);
      return;
    }

    /* --- one-shots ---------------------------------------------------- */
    if (this.oneShot > 0) this.oneShot -= dt;

    const wantsMelee = input.attacking && input.melee;
    const wantsPickup = input.pickup;
    if (wantsMelee && this.oneShot <= 0 && this.base?.name !== CLIP_MELEE) {
      this.setBase(assets, CLIP_MELEE, false, 0.06);
      this.oneShot = (this.base?.duration ?? 0.4) + ATTACK_HOLD;
    } else if (wantsPickup && this.oneShot <= 0 && this.base?.name !== CLIP_PICKUP) {
      this.setBase(assets, CLIP_PICKUP, false, 0.08);
      this.oneShot = (this.base?.duration ?? 0.33) + ATTACK_HOLD;
    }

    /* --- locomotion --------------------------------------------------- */
    let rate = 1;
    if (this.oneShot <= 0) {
      const speed = input.hovers ? 0 : input.speed;
      if (speed >= SPRINT_SPEED) {
        this.setBase(assets, CLIP_SPRINT, true, FADE_TIME);
        rate = clampRate((speed / SPRINT_REFERENCE) * input.cadence);
      } else if (speed >= WALK_SPEED) {
        this.setBase(assets, CLIP_WALK, true, FADE_TIME);
        rate = clampRate((speed / WALK_REFERENCE) * input.cadence);
      } else {
        this.setBase(assets, CLIP_IDLE, true, FADE_TIME);
        rate = 1;
      }
    }

    /* --- upper body ---------------------------------------------------- */
    if (input.armed) {
      const want = input.attacking ? CLIP_SHOOT : CLIP_HOLD;
      if (this.overlay === null || this.overlay.name !== want) {
        const clip = assets.clips.get(want);
        if (clip !== undefined) {
          this.overlay = clip;
          this.overlayTime = 0;
        }
      }
      this.overlayTarget = 1;
    } else {
      this.overlayTarget = 0;
    }

    this.advance(dt, rate);

    if (this.overlay !== null) {
      this.overlayTime += dt;
      if (this.overlayTime > this.overlay.duration) {
        // holding-right is a 2-key static pose; shooting is a short punch that
        // should sit on its last frame until the next shot restarts it.
        this.overlayTime = this.overlay.duration;
      }
      const step = dt / OVERLAY_FADE;
      this.overlayWeight = this.overlayTarget > this.overlayWeight
        ? Math.min(this.overlayTarget, this.overlayWeight + step)
        : Math.max(this.overlayTarget, this.overlayWeight - step);
    }
  }

  /** Restart the shooting overlay, so a burst punches once per shot. */
  kick(assets: CharacterAssets): void {
    const clip = assets.clips.get(CLIP_SHOOT);
    if (clip === undefined) return;
    this.overlay = clip;
    this.overlayTime = 0;
    this.overlayTarget = 1;
  }

  /** Write the blended local TRS of all seven rig nodes into `out` (70 floats). */
  pose(assets: CharacterAssets, out: Float32Array): void {
    if (this.base === null) {
      out.set(assets.rest);
      return;
    }
    samplePose(assets.frames, this.base, this.baseTime, this.baseLoops, out);
    if (this.prev !== null && this.fade < 1) {
      samplePose(assets.frames, this.prev, this.prevTime, true, SCRATCH_A);
      blendPose(out, SCRATCH_A, 1 - this.fade, ALL_NODES);
    }
    if (this.overlay !== null && this.overlayWeight > 0.001) {
      samplePose(assets.frames, this.overlay, this.overlayTime, false, SCRATCH_B);
      blendPose(out, SCRATCH_B, this.overlayWeight, this.overlay.mask & UPPER_NODES);
    }
  }

  private setBase(assets: CharacterAssets, name: string, loops: boolean, fade: number): void {
    if (this.base !== null && this.base.name === name) {
      this.baseLoops = loops;
      return;
    }
    const clip = assets.clips.get(name);
    if (clip === undefined) return;
    if (this.base !== null && fade > 0) {
      this.prev = this.base;
      this.prevTime = this.baseTime;
      this.fade = 0;
      this.fadeRate = 1 / fade;
    } else {
      this.prev = null;
      this.fade = 1;
    }
    this.base = clip;
    this.baseTime = 0;
    this.baseLoops = loops;
  }

  private fadeRate = 1 / FADE_TIME;

  private advance(dt: number, rate: number): void {
    if (this.base === null) return;
    this.baseTime += dt * rate;
    if (this.baseLoops) {
      const d = this.base.duration;
      if (d > 0 && this.baseTime >= d) this.baseTime %= d;
    } else if (this.baseTime > this.base.duration) {
      this.baseTime = this.base.duration;
    }
    if (this.prev !== null) {
      this.prevTime += dt;
      const d = this.prev.duration;
      if (d > 0 && this.prevTime >= d) this.prevTime %= d;
      this.fade += dt * this.fadeRate;
      if (this.fade >= 1) { this.fade = 1; this.prev = null; }
    }
  }
}

function clampRate(r: number): number {
  return r < 0.45 ? 0.45 : r > 2.4 ? 2.4 : r;
}

/* ------------------------------------------------------------------ *
 * Pose sampling
 * ------------------------------------------------------------------ */

const ALL_NODES = (1 << RIG_NODE_COUNT) - 1;
/** torso, arm-left, arm-right, head — see RIG_NODE_NAMES. */
export const UPPER_NODES = (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6);

const SCRATCH_A = new Float32Array(FRAME_STRIDE);
const SCRATCH_B = new Float32Array(FRAME_STRIDE);

/**
 * Linear between the two baked frames that bracket `time`. The bake grid is
 * 30 Hz, so the two quaternions are never more than a few degrees apart and a
 * normalised lerp is indistinguishable from a slerp at a fraction of the cost.
 */
export function samplePose(
  frames: Float32Array, clip: BakedClip, time: number, loops: boolean, out: Float32Array,
): void {
  const last = clip.count - 1;
  let t = time;
  if (clip.duration > 0) {
    if (loops) {
      t %= clip.duration;
      if (t < 0) t += clip.duration;
    } else if (t > clip.duration) t = clip.duration;
  }
  if (t < 0) t = 0;
  const f = clip.duration > 0 ? (t / clip.duration) * last : 0;
  let i0 = f | 0;
  if (i0 > last) i0 = last;
  let i1 = i0 + 1;
  if (i1 > last) i1 = loops ? 0 : last;
  const a = f - i0;

  const b0 = (clip.first + i0) * FRAME_STRIDE;
  const b1 = (clip.first + i1) * FRAME_STRIDE;
  if (a <= 0.0001) {
    for (let i = 0; i < FRAME_STRIDE; i++) out[i] = frames[b0 + i];
    return;
  }
  for (let n = 0; n < RIG_NODE_COUNT; n++) {
    const o = n * TRS_STRIDE;
    const p0 = b0 + o;
    const p1 = b1 + o;
    out[o] = frames[p0] + (frames[p1] - frames[p0]) * a;
    out[o + 1] = frames[p0 + 1] + (frames[p1 + 1] - frames[p0 + 1]) * a;
    out[o + 2] = frames[p0 + 2] + (frames[p1 + 2] - frames[p0 + 2]) * a;
    nlerpQuat(frames, p0 + 3, frames, p1 + 3, a, out, o + 3);
    out[o + 7] = frames[p0 + 7] + (frames[p1 + 7] - frames[p0 + 7]) * a;
    out[o + 8] = frames[p0 + 8] + (frames[p1 + 8] - frames[p0 + 8]) * a;
    out[o + 9] = frames[p0 + 9] + (frames[p1 + 9] - frames[p0 + 9]) * a;
  }
}

/** dst = mix(dst, src, t) for every node whose bit is set in `mask`. */
export function blendPose(dst: Float32Array, src: Float32Array, t: number, mask: number): void {
  if (t <= 0 || mask === 0) return;
  if (t > 1) t = 1;
  for (let n = 0; n < RIG_NODE_COUNT; n++) {
    if ((mask & (1 << n)) === 0) continue;
    const o = n * TRS_STRIDE;
    dst[o] += (src[o] - dst[o]) * t;
    dst[o + 1] += (src[o + 1] - dst[o + 1]) * t;
    dst[o + 2] += (src[o + 2] - dst[o + 2]) * t;
    nlerpQuat(dst, o + 3, src, o + 3, t, dst, o + 3);
    dst[o + 7] += (src[o + 7] - dst[o + 7]) * t;
    dst[o + 8] += (src[o + 8] - dst[o + 8]) * t;
    dst[o + 9] += (src[o + 9] - dst[o + 9]) * t;
  }
}

function nlerpQuat(
  a: Float32Array, ai: number, b: Float32Array, bi: number, t: number,
  out: Float32Array, oi: number,
): void {
  const ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3];
  let bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
  // Shortest arc: q and -q are the same rotation but lerp between them is not.
  if (ax * bx + ay * by + az * bz + aw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
  const x = ax + (bx - ax) * t;
  const y = ay + (by - ay) * t;
  const z = az + (bz - az) * t;
  const w = aw + (bw - aw) * t;
  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  const s = len > 1e-8 ? 1 / len : 1;
  out[oi] = x * s; out[oi + 1] = y * s; out[oi + 2] = z * s; out[oi + 3] = w * s;
}
