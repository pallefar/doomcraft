/**
 * DOOMCRAFT — touch control logic.
 *
 * This file is the *maths* of the mobile controls: sticks, drag/tap
 * discrimination, aim assist and auto-fire. It touches no DOM and reads no
 * globals, which is the point — `client/src/hud/mobile.ts` owns the pixels and
 * this owns the behaviour, so every rule below is unit-testable in node and is
 * actually tested in `touch.test.ts`.
 *
 * It exists because of four measured holes in the bar (ref/BAR.md):
 *
 *   #9  the bar has **no fire button**: a tap on the right half both looks and
 *       shoots, so aiming and firing fight each other. Here the two gestures are
 *       separated (`DragTracker` tells a tap from a drag) and then deliberately
 *       *re-*combined by `FirePad`'s slide-off, which keeps the trigger held
 *       while the same thumb keeps aiming.
 *   #9  no aim assist and no auto-fire at all. `aimAssist()` is a modest cone —
 *       friction plus a bounded pull that can never overshoot the target — and
 *       `AutoFire` holds the trigger only while a target is genuinely locked.
 *   #10 its joystick has no visible dead-zone or radius feedback. `resolveStick`
 *       produces both as numbers so the pad can *draw* them.
 *
 * COST. Everything here is allocation-free per frame: every function writes into
 * a caller-owned struct and every class keeps its state in number fields. The
 * whole file runs inside the 4× CPU-throttled 60 fps budget with room to spare.
 */

import { clampf, saturate, smoothstep, DEG2RAD } from '@shared/math';

/* ------------------------------------------------------------------------ *
 * Thumb stick
 * ------------------------------------------------------------------------ */

export interface StickConfig {
  /** Travel from the origin to full deflection, in CSS pixels. */
  radius: number;
  /**
   * Fraction of `radius` that reads as zero. A thumb resting on glass drifts;
   * without this the player creeps. Rescaled afterwards so magnitude is still
   * continuous from 0 at the edge of the zone — a hard dead-zone that jumps
   * straight to 0.18 is the classic bad stick.
   */
  deadZone: number;
  /** Response curve. >1 buys fine control near the centre. */
  curve: number;
  /**
   * Fraction of `radius` at which the stick latches into a sprint detent. The
   * bar has no such thing; on a phone "push the stick all the way" is the only
   * sprint gesture that does not cost a button.
   */
  detent: number;
}

export const DEFAULT_STICK: Readonly<StickConfig> = Object.freeze({
  radius: 58,
  deadZone: 0.16,
  curve: 1.35,
  detent: 0.9,
});

/** Everything one stick sample produces. Reused; never allocated per frame. */
export interface StickSample {
  /** Strafe, -1..1 (+1 right). */
  x: number;
  /** Forward, -1..1 (+1 forward). */
  z: number;
  /** Post-curve magnitude, 0..1. */
  magnitude: number;
  /** Raw deflection as a fraction of `radius`, 0..1 — what the rim ring draws. */
  travel: number;
  /** Knob offset from the origin, CSS pixels, already clamped to the radius. */
  knobX: number;
  knobY: number;
  /** True once travel leaves the dead zone. Drives the knob's colour change. */
  live: boolean;
  /** True at or past the detent. */
  sprint: boolean;
}

export function createStickSample(): StickSample {
  return { x: 0, z: 0, magnitude: 0, travel: 0, knobX: 0, knobY: 0, live: false, sprint: false };
}

export function resetStickSample(s: StickSample): void {
  s.x = 0; s.z = 0; s.magnitude = 0; s.travel = 0;
  s.knobX = 0; s.knobY = 0; s.live = false; s.sprint = false;
}

/**
 * Turn a pointer offset from the stick origin into a movement vector.
 *
 * Screen +Y is down and forward is -Y, hence the sign on `z`. Purely a function
 * of its arguments so the test can sweep it.
 */
export function resolveStick(dx: number, dy: number, cfg: StickConfig, out: StickSample): StickSample {
  const radius = cfg.radius > 1 ? cfg.radius : 1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    resetStickSample(out);
    return out;
  }
  const clamped = len > radius ? radius : len;
  const ux = dx / len;
  const uy = dy / len;

  out.knobX = ux * clamped;
  out.knobY = uy * clamped;
  out.travel = clamped / radius;

  const dz = clampf(cfg.deadZone, 0, 0.9);
  const t = saturate((out.travel - dz) / (1 - dz));
  const m = t === 0 ? 0 : Math.pow(t, cfg.curve);

  out.magnitude = m;
  out.x = ux * m;
  out.z = -uy * m;
  out.live = t > 0;
  out.sprint = out.travel >= cfg.detent && m > 0;
  return out;
}

/**
 * A live thumb stick: one pointer, an origin that can float to wherever the
 * thumb landed, and a sample.
 *
 * A *floating* origin is the single biggest usability gap against the bar's
 * fixed puck: on a 412 px-wide screen a fixed stick means the thumb has to find
 * a 130 px circle in the dark, and a miss is a dead second in a firefight.
 */
export class ThumbStick {
  readonly sample: StickSample = createStickSample();
  readonly config: StickConfig;

  /** Pointer currently owning the stick, or -1. */
  pointerId = -1;
  /** Origin the knob measures from, in client coordinates. */
  originX = 0;
  originY = 0;

  /** When true the origin moves to the press point; otherwise it stays at home. */
  floating = true;
  /** Resting origin, used when `floating` is off and as the visual home. */
  homeX = 0;
  homeY = 0;
  /**
   * Bounds the floating origin may land in, in client coordinates. Keeps the
   * ring on screen when the thumb lands in a corner.
   */
  minX = 0; minY = 0; maxX = 0; maxY = 0;

  constructor(config: Partial<StickConfig> = {}) {
    this.config = { ...DEFAULT_STICK, ...config };
  }

  get active(): boolean { return this.pointerId >= 0; }

  /** Set the resting origin and the box the floating origin is clamped into. */
  setHome(x: number, y: number, minX: number, minY: number, maxX: number, maxY: number): void {
    this.homeX = x; this.homeY = y;
    this.minX = minX; this.minY = minY;
    this.maxX = maxX; this.maxY = maxY;
    if (!this.active) { this.originX = x; this.originY = y; }
  }

  begin(pointerId: number, x: number, y: number): StickSample {
    this.pointerId = pointerId;
    if (this.floating) {
      this.originX = clampf(x, this.minX, this.maxX);
      this.originY = clampf(y, this.minY, this.maxY);
    } else {
      this.originX = this.homeX;
      this.originY = this.homeY;
    }
    return this.move(x, y);
  }

  move(x: number, y: number): StickSample {
    return resolveStick(x - this.originX, y - this.originY, this.config, this.sample);
  }

  end(): StickSample {
    this.pointerId = -1;
    this.originX = this.homeX;
    this.originY = this.homeY;
    resetStickSample(this.sample);
    return this.sample;
  }
}

/* ------------------------------------------------------------------------ *
 * Drag vs tap
 * ------------------------------------------------------------------------ */

export interface TapConfig {
  /** A press longer than this is never a tap, however still it was. */
  maxMs: number;
  /** Total travel above this is a drag, however short it was. */
  maxPx: number;
}

export const DEFAULT_TAP: Readonly<TapConfig> = Object.freeze({ maxMs: 240, maxPx: 14 });

/**
 * Tracks one look pointer and decides, on release, whether it was a tap.
 *
 * This is the mechanism that lets the right half be a *look* surface and still
 * answer a quick tap with a shot, without the bar's failure mode where every
 * aiming drag also pulls the trigger.
 */
export class DragTracker {
  pointerId = -1;
  /** Delta produced by the last `move`, CSS pixels. */
  dx = 0;
  dy = 0;
  /** Path length since `begin`, used for the tap test. */
  travel = 0;
  /** Magnitude of the last move, for the aim-assist drag term. */
  speed = 0;

  private lastX = 0;
  private lastY = 0;
  private startMs = 0;
  private readonly cfg: TapConfig;

  constructor(cfg: Partial<TapConfig> = {}) {
    this.cfg = { ...DEFAULT_TAP, ...cfg };
  }

  get active(): boolean { return this.pointerId >= 0; }

  begin(pointerId: number, x: number, y: number, nowMs: number): void {
    this.pointerId = pointerId;
    this.lastX = x;
    this.lastY = y;
    this.startMs = nowMs;
    this.travel = 0;
    this.dx = 0;
    this.dy = 0;
    this.speed = 0;
  }

  /** Feed a move. Returns true when the delta is non-zero. */
  move(x: number, y: number): boolean {
    this.dx = x - this.lastX;
    this.dy = y - this.lastY;
    this.lastX = x;
    this.lastY = y;
    this.speed = Math.hypot(this.dx, this.dy);
    this.travel += this.speed;
    return this.dx !== 0 || this.dy !== 0;
  }

  /** True when this press should count as a shot rather than an aim. */
  end(nowMs: number): boolean {
    const tap = this.pointerId >= 0
      && this.travel <= this.cfg.maxPx
      && (nowMs - this.startMs) <= this.cfg.maxMs;
    this.pointerId = -1;
    this.dx = 0;
    this.dy = 0;
    this.speed = 0;
    return tap;
  }

  cancel(): void {
    this.pointerId = -1;
    this.dx = 0; this.dy = 0; this.speed = 0; this.travel = 0;
  }
}

/* ------------------------------------------------------------------------ *
 * Aim assist
 * ------------------------------------------------------------------------ */

export interface AimAssistConfig {
  /** Half-angle of the cone, radians. Outside it nothing happens at all. */
  cone: number;
  /** Metres. Beyond this the assist is off; it fades in over the last stretch. */
  maxRange: number;
  /** Metres. Below this it is off too — point blank needs no help and sticks. */
  minRange: number;
  /** Strongest look slowdown at the centre of the cone, 0..1. */
  friction: number;
  /** Pull with the thumb still, radians/second at the centre of the cone. */
  idleRate: number;
  /** Extra pull scaled by how hard the thumb is dragging, radians/second. */
  dragRate: number;
  /** Drag speed, CSS pixels per step, at which `dragRate` saturates. */
  dragRef: number;
}

/**
 * Modest on purpose. The pull is bounded at `idleRate + dragRate` = 105 deg/s
 * inside a 7-degree cone, it can never move past the target, and it only ever
 * runs for a touch player — a mouse never sees it, so nothing about desktop
 * aiming changes.
 */
export const DEFAULT_AIM_ASSIST: Readonly<AimAssistConfig> = Object.freeze({
  cone: 7 * DEG2RAD,
  maxRange: 42,
  minRange: 1.5,
  friction: 0.45,
  idleRate: 20 * DEG2RAD,
  dragRate: 85 * DEG2RAD,
  dragRef: 26,
});

export interface AimAssistOut {
  /** Yaw correction to add this step, radians. */
  yaw: number;
  /** Pitch correction to add this step, radians. */
  pitch: number;
  /** Multiplier to apply to the player's own look delta, 0..1. */
  friction: number;
  /** True while the cone is engaged — the pad draws this. */
  engaged: number;
}

export function createAimAssistOut(): AimAssistOut {
  return { yaw: 0, pitch: 0, friction: 1, engaged: 0 };
}

/**
 * Range window: 0 below `minRange`, 1 across the middle, fading out over the
 * last 20 % of `maxRange`. A trapezoid rather than a step so a target walking
 * out of range does not make the reticle twitch.
 */
export function assistRangeWeight(dist: number, cfg: AimAssistConfig): number {
  if (!(dist > 0) || dist >= cfg.maxRange) return 0;
  const near = cfg.minRange;
  if (dist <= near) return 0;
  const fadeIn = smoothstep(saturate((dist - near) / Math.max(0.5, near)));
  const outStart = cfg.maxRange * 0.8;
  const fadeOut = dist <= outStart
    ? 1
    : 1 - smoothstep(saturate((dist - outStart) / Math.max(0.5, cfg.maxRange - outStart)));
  return fadeIn * fadeOut;
}

/**
 * One step of aim assist.
 *
 * `errYaw` / `errPitch` are the signed angles from the current view to the
 * target — exactly what `Game.nearestEnemyAim` produces. `dragPx` is how far the
 * look thumb moved this step, which scales the pull: a player actively turning
 * gets helped onto the target, a player holding still gets only a slow drift so
 * the game never feels like it is playing itself.
 *
 * Returns true when the cone engaged. `out.friction` is meaningful either way.
 */
export function aimAssist(
  errYaw: number, errPitch: number, dist: number,
  dragPx: number, dt: number,
  cfg: AimAssistConfig, out: AimAssistOut,
): boolean {
  out.yaw = 0;
  out.pitch = 0;
  out.friction = 1;
  out.engaged = 0;

  const err = Math.hypot(errYaw, errPitch);
  if (!(err < cfg.cone)) return false;

  const range = assistRangeWeight(dist, cfg);
  if (range <= 0) return false;

  // 1 at the centre of the cone, 0 at its edge, smooth in between.
  const centred = smoothstep(saturate(1 - err / cfg.cone));
  const weight = centred * range;
  if (weight <= 0) return false;

  out.engaged = weight;
  out.friction = 1 - cfg.friction * weight;

  const drag = saturate(dragPx / Math.max(1, cfg.dragRef));
  const rate = (cfg.idleRate + cfg.dragRate * drag) * weight;
  const step = rate * dt;
  if (step <= 0 || err <= 1e-9) return true;

  // Never move past the target: the correction is capped at the error itself.
  const k = step >= err ? 1 : step / err;
  out.yaw = errYaw * k;
  out.pitch = errPitch * k;
  return true;
}

/* ------------------------------------------------------------------------ *
 * Auto-fire
 * ------------------------------------------------------------------------ */

export interface AutoFireConfig {
  /** Angle inside which the trigger engages, radians. */
  lock: number;
  /** Angle at which an engaged trigger lets go. Hysteresis, so it cannot chatter. */
  release: number;
  /** Metres. */
  maxRange: number;
  /** Keep firing this long after the lock is lost, so a strafing target survives a frame. */
  holdMs: number;
}

export const DEFAULT_AUTO_FIRE: Readonly<AutoFireConfig> = Object.freeze({
  lock: 3.2 * DEG2RAD,
  release: 5.5 * DEG2RAD,
  maxRange: 42,
  holdMs: 140,
});

/**
 * Optional hands-free trigger.
 *
 * Off by default — it is a comfort option, not the main path, and the fire pad
 * stays live while it runs. The bar offers neither.
 */
export class AutoFire {
  enabled = false;
  /** True while the trigger is being held by this object. */
  firing = false;
  /** True while a target satisfies the lock — the pad draws this as a ring. */
  locked = false;

  private readonly cfg: AutoFireConfig;
  private lastLockMs = -1e9;

  constructor(cfg: Partial<AutoFireConfig> = {}) {
    this.cfg = { ...DEFAULT_AUTO_FIRE, ...cfg };
  }

  reset(): void {
    this.firing = false;
    this.locked = false;
    this.lastLockMs = -1e9;
  }

  /**
   * @param hasTarget  a live enemy exists
   * @param err        angle from the view to it, radians
   * @param dist       metres
   * @param lineOfSight false when a wall is in the way; never burn ammo into rock
   */
  update(hasTarget: boolean, err: number, dist: number, lineOfSight: boolean, nowMs: number): boolean {
    if (!this.enabled) {
      this.firing = false;
      this.locked = false;
      return false;
    }
    const gate = this.firing ? this.cfg.release : this.cfg.lock;
    const ok = hasTarget && lineOfSight && dist <= this.cfg.maxRange && err <= gate;
    this.locked = ok;
    if (ok) {
      this.lastLockMs = nowMs;
      this.firing = true;
    } else if (nowMs - this.lastLockMs > this.cfg.holdMs) {
      this.firing = false;
    }
    return this.firing;
  }
}
