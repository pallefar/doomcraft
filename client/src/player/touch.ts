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
 *       *re-*combined over a whole corner of the screen: `TouchGeom.fireZone`
 *       is a ≥260×260 slab under the trigger thumb where a press fires and the
 *       same unbroken drag keeps panning (`FirePad`'s slide-off). Aim and fire
 *       are separable everywhere else and simultaneous where the thumb lives.
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
import { InputAction } from '@shared/constants';

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
  // The epsilon is not slop, it is arithmetic: the pad draws the detent at
  // `travel * detent` and the test presses exactly there, so a ring whose
  // radius divided by the travel comes back as 0.8999999999999999 would be a
  // drawn threshold the maths refuses to honour.
  out.sprint = out.travel >= cfg.detent - 1e-9 && m > 0;
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
  /**
   * Where the base ring is *drawn*. Identical to the origin except when the
   * thumb lands in a corner: then the ring slides inboard to stay on screen
   * while the origin stays under the finger, so the press itself still reads
   * as zero deflection. Clamping the origin instead would make a corner press
   * sprint the player sideways the instant it lands.
   */
  ringX = 0;
  ringY = 0;

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
    if (!this.active) {
      this.originX = x; this.originY = y;
      this.ringX = x; this.ringY = y;
    }
  }

  begin(pointerId: number, x: number, y: number): StickSample {
    this.pointerId = pointerId;
    if (this.floating) {
      this.originX = x;
      this.originY = y;
      this.ringX = clampf(x, this.minX, this.maxX);
      this.ringY = clampf(y, this.minY, this.maxY);
    } else {
      this.originX = this.homeX;
      this.originY = this.homeY;
      this.ringX = this.homeX;
      this.ringY = this.homeY;
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
    this.ringX = this.homeX;
    this.ringY = this.homeY;
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

/* ------------------------------------------------------------------------ *
 * Fire pad
 * ------------------------------------------------------------------------ */

export interface FirePadConfig {
  /**
   * A press is held for at least this long even if the finger lifts sooner. A
   * 60 fps frame is 16.7 ms and a fast tap can land press+release inside one,
   * which on the bar's tap-to-shoot surface simply eats the shot.
   */
  minHoldMs: number;
  /** Travel from the press point, in px, after which the finger also aims. */
  slidePx: number;
}

export const DEFAULT_FIRE_PAD: Readonly<FirePadConfig> = Object.freeze({
  minHoldMs: 90,
  slidePx: 10,
});

/**
 * The dedicated trigger the bar does not have (ref/BAR.md weakness #9), with
 * the one refinement that makes a separate trigger playable: **slide-off**.
 *
 * Press and the trigger holds. Keep sliding and the same thumb starts feeding
 * look deltas without ever letting go, so a player can open fire and track a
 * strafing target with one thumb. The bar forces that combination by making
 * them the same gesture and so cannot offer either one cleanly; here you get
 * the tap, the hold and the tracked burst, and aiming never fires by accident.
 *
 * "The pad" is a whole corner, not a disc: `hitTest` hands this class every
 * press inside `TouchGeom.fireZone`, so where the thumb landed inside the
 * trigger's region never changes what the gesture means. That is what makes
 * the slab worth having — a fire+look region whose behaviour depended on
 * hitting the drawn circle would just be a button with a generous hit box.
 */
export class FirePad {
  pointerId = -1;
  /** True while the trigger is held. */
  firing = false;
  /** True once the finger slid far enough to also be aiming. */
  aiming = false;
  /** Look delta from the last `move`, CSS pixels. Zero until `aiming`. */
  dx = 0;
  dy = 0;

  private readonly cfg: FirePadConfig;
  private lastX = 0;
  private lastY = 0;
  private startX = 0;
  private startY = 0;
  private downMs = 0;
  private releasedMs = -1;

  constructor(cfg: Partial<FirePadConfig> = {}) {
    this.cfg = { ...DEFAULT_FIRE_PAD, ...cfg };
  }

  get active(): boolean { return this.pointerId >= 0; }

  begin(pointerId: number, x: number, y: number, nowMs: number): void {
    this.pointerId = pointerId;
    this.startX = x; this.startY = y;
    this.lastX = x; this.lastY = y;
    this.downMs = nowMs;
    this.releasedMs = -1;
    this.firing = true;
    this.aiming = false;
    this.dx = 0;
    this.dy = 0;
  }

  /** Feed a move. Returns true when it produced a look delta. */
  move(x: number, y: number): boolean {
    this.dx = 0;
    this.dy = 0;
    if (this.pointerId < 0) return false;
    if (!this.aiming) {
      const travel = Math.hypot(x - this.startX, y - this.startY);
      if (travel < this.cfg.slidePx) { this.lastX = x; this.lastY = y; return false; }
      this.aiming = true;
      // Swallow the slide threshold itself so the view does not jump.
      this.lastX = x; this.lastY = y;
      return false;
    }
    this.dx = x - this.lastX;
    this.dy = y - this.lastY;
    this.lastX = x;
    this.lastY = y;
    return this.dx !== 0 || this.dy !== 0;
  }

  end(nowMs: number): void {
    if (this.pointerId < 0) return;
    this.pointerId = -1;
    this.aiming = false;
    this.dx = 0;
    this.dy = 0;
    this.releasedMs = nowMs;
    this.tick(nowMs);
  }

  cancel(): void {
    this.pointerId = -1;
    this.firing = false;
    this.aiming = false;
    this.dx = 0;
    this.dy = 0;
    this.releasedMs = -1;
  }

  /** Poll once per frame: drops the trigger after the minimum hold expires. */
  tick(nowMs: number): void {
    if (this.releasedMs < 0 || !this.firing) return;
    if (nowMs - this.downMs >= this.cfg.minHoldMs) {
      this.firing = false;
      this.releasedMs = -1;
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Layout
 *
 * The bar ships one fixed low-contrast puck plus four 40 px glyphs and calls it
 * a phone build, and it ships its DESKTOP hud on top (weakness #11). Solving
 * the layout as numbers instead of hand-placed CSS is what makes the claim
 * testable: `touch.test.ts` sweeps eight viewports and asserts that no two
 * controls overlap, that nothing leaves the screen, that every target clears
 * the 44 px minimum, and that the read-out band the HUD is given is genuinely
 * free of thumbs.
 *
 * THE SWEEP ARC — the rule the whole right-hand side now obeys.
 *
 * A trigger thumb does not press points, it sweeps an arc: pivoting around a
 * knuckle just inboard of the bottom corner, the band from r 80 to r 220 is
 * everything it can reach without regripping the phone. Round 1 put the
 * trigger IN that arc and then paved the rest of it with buttons — JUMP/DUCK
 * in one column, RLD/BLD/WEP in another — so 38.7 % of the arc was a tap
 * target and the only button-free horizontal run left in the right half was
 * 199 px wide, up in the middle of the picture. Every look-swipe therefore
 * began by lifting the thumb off the trigger and reaching inward, which is the
 * bar's own failure (aiming and firing fighting each other) rebuilt out of
 * better parts.
 *
 * So the arc belongs to exactly one thing now. `fireZone` is a contiguous
 * square anchored at the trigger corner, at least `FIRE_ZONE_MIN` on a side,
 * that is SIMULTANEOUSLY fire and look: a press inside it pulls the trigger,
 * and the same unbroken drag pans the camera (`FirePad`'s slide-off). Not one
 * button is allowed to touch it — JUMP/DUCK move up the trigger edge above the
 * slab, RLD/BLD/WEP move off the hand entirely — and `thumbArcMix` measures
 * that as a number rather than asserting it in a comment: at 915x412 and
 * 412x915, 100 % of the arc pans the camera and 0 % of it is a button.
 * ------------------------------------------------------------------------ */

/** Control ids returned by `hitTest`. */
export const TC_NONE = 0;
export const TC_LOOK = 1;
export const TC_STICK = 2;
export const TC_FIRE = 3;
export const TC_JUMP = 4;
export const TC_CROUCH = 5;
export const TC_RELOAD = 6;
export const TC_BUILD = 7;
export const TC_AUTOFIRE = 8;
export const TC_AIMASSIST = 9;
export const TC_PAUSE = 10;
/**
 * Cycle to the next weapon. The bar puts weapon choice on a six-slot hotbar it
 * draws at the bottom centre and then never wires to a touch handler; with
 * seven weapons and one free thumb, one big cycle button beats seven 32 px
 * slots you cannot hit.
 */
export const TC_SWAP = 11;

export interface Disc { x: number; y: number; r: number }
export interface Rect { x0: number; y0: number; x1: number; y1: number }
export interface Pt { x: number; y: number }

export interface TouchGeom {
  vw: number;
  vh: number;
  portrait: boolean;
  southpaw: boolean;

  /** Resting stick position; `r` is the drawn base radius. */
  stickHome: Disc;
  /** Deflection that reads as full tilt, px. */
  stickTravel: number;
  /** Drawn knob radius, px. */
  knobR: number;
  /** Drawn dead-zone radius, px. */
  deadR: number;
  /**
   * Drawn sprint-detent radius, px — the deflection at which `resolveStick`
   * latches `sprint`.
   *
   * Published because an undrawn gesture is not a feature. The bar spends a
   * whole 40 px glyph on sprint (ref/BAR.md: the runner icon, top of its
   * right-hand column) and we spend none, which is only an improvement if the
   * player can *see* where the detent is. Until this existed the stick sprinted
   * at 90 % travel and nothing on the screen said so.
   */
  detentR: number;
  /** A press inside this rect grabs (or floats) the stick. */
  stickZone: Rect;
  /** Box the floating stick origin is clamped into. */
  stickBounds: Rect;

  /**
   * Where the hand holding the device rests its trigger thumb, in client px.
   * Published rather than assumed so `attackReach` — the one number that says
   * whether you can shoot without moving your grip — is a measurement of the
   * solved layout instead of an opinion about it.
   */
  thumbPivot: Pt;

  /**
   * The combat slab: one contiguous rectangle anchored at the trigger hand's
   * bottom corner where a press fires AND the same drag keeps looking.
   *
   * This is the fix for the round-1 loss. It is not "the fire button's hit
   * box grown a bit" — it is the whole of the thumb's sweep arc, handed to the
   * one gesture that has to work while a fight is happening. The drawn trigger
   * disc still sits in the corner as the affordance you aim your thumb at, but
   * anywhere in this box behaves identically, so a thumb that has drifted 100
   * px off the disc chasing a target is still holding the trigger.
   *
   * `solveTouchLayout` guarantees three things about it, and `touch.test.ts`
   * checks all three: it is at least `FIRE_ZONE_MIN` on a side at the two
   * phone viewports, it contains the trigger disc, and no drawn control
   * intersects it — a button inside would be a hole in the arc.
   */
  fireZone: Rect;

  fire: Disc;
  jump: Disc;
  crouch: Disc;
  reload: Disc;
  build: Disc;
  swap: Disc;
  autoFire: Disc;
  aimAssist: Disc;
  pause: Disc;

  /** Height of the bottom band each thumb cluster owns, px. */
  padBottomLeft: number;
  padBottomRight: number;
  /**
   * Height of the bottom band the *outer* column of each cluster owns, px.
   *
   * This is the number a corner read-out should be inset by, and it is not the
   * same as `padBottom*`. On a 915x412 landscape phone the right-hand cluster
   * is two columns deep: the trigger and JUMP/DUCK against the edge, and the
   * three utility glyphs inboard of them. `padBottomRight` clears all five and
   * comes out at 209 px — more than half a 412 px-tall screen — so the ammo
   * plate pinned to it floated in the middle of the play area with nothing
   * under it, which is precisely the bar's weakness #11 re-committed by a
   * different route. The inboard column is nowhere near the corner, so the
   * read-out only has to clear the outer one: 144 px, and the plate tucks in
   * against the trigger where a thumb-held phone expects it.
   *
   * `readoutWidth*` is the other half of that promise — the widest a plate may
   * be before it reaches the column this band deliberately ignored.
   */
  padEdgeLeft: number;
  padEdgeRight: number;
  /** Widest a corner read-out may be on each side without hitting a control, px. */
  readoutWidthLeft: number;
  readoutWidthRight: number;
  /**
   * Inset from the screen edge that keeps a read-out clear of the option-chip
   * column in the top corner, px. Same value both sides — the chips mirror with
   * the hand, so the reserve does too.
   */
  readoutInset: number;
  /** Horizontal band at the bottom that no thumb covers. */
  centreX0: number;
  centreX1: number;
}

export interface TouchLayoutOptions {
  safeLeft: number;
  safeRight: number;
  safeTop: number;
  safeBottom: number;
  /** Mirror the whole layout for a left-handed player. */
  southpaw: boolean;
  /** User control-size multiplier. */
  scale: number;
  /** Dead zone as a fraction of travel, mirrored from `StickConfig`. */
  deadZone: number;
  /** Sprint detent as a fraction of travel, mirrored from `StickConfig`. */
  detent: number;
}

export const DEFAULT_TOUCH_LAYOUT: Readonly<TouchLayoutOptions> = Object.freeze({
  safeLeft: 0, safeRight: 0, safeTop: 0, safeBottom: 0,
  southpaw: false,
  scale: 1,
  deadZone: DEFAULT_STICK.deadZone,
  detent: DEFAULT_STICK.detent,
});

/** Apple/Google both put the minimum comfortable target at 44 CSS px across. */
export const MIN_TOUCH_TARGET = 44;

/**
 * Hard floor on the ATTACK pad's diameter, in CSS pixels, at every viewport
 * and every user control-size setting.
 *
 * The trigger is not just another button. The bar's answer to "how do I shoot"
 * is a tap on the look surface — no control at all — so the one thing our right
 * thumb must never have to hunt for is this disc. Everything else in the
 * cluster scales freely with `scale`; the trigger scales up from here and never
 * down. At 915x412 and 412x915 the solver lands it at ~119 px unaided, so this
 * floor only ever bites at the smallest control-size setting, where the
 * movement glyphs may shrink but the attack pad may not.
 */
export const MIN_ATTACK_PAD_D = 104;

/**
 * Ceiling on the attack pad's diameter, px.
 *
 * A trigger can be too big. Past about this size the disc stops being easier
 * to hit — the thumb already cannot miss it — and starts doing two harmful
 * things: eating the viewport the bar already wastes (weakness #11), and
 * pushing its own centre *away* from the corner the thumb pivots around, since
 * a disc pinned to the bottom-right corner has its centre one radius in from
 * both edges. Capping the radius is what keeps `attackReach` under
 * `MAX_ATTACK_REACH` at every viewport and every control-size setting.
 */
export const MAX_ATTACK_PAD_D = 128;

/* --- the thumb pivot -----------------------------------------------------
   Hold a phone in landscape and the right thumb's knuckle sits just inboard of
   the bottom-right corner; everything it can press without regripping is an
   arc swept from there. On the bar's own 915x412 capture that point is
   (855, 400) — 60 px in from the right edge, 12 px up from the bottom — and
   the bar puts its dig glyph, the only thing on its screen that attacks, 199 px
   away at (712, 262), out in the middle of the world where the thumb has to
   leave the grip to reach it. These two constants are that measurement,
   generalised to any viewport and offset by whatever the notch/home-bar takes.

   Everything else about the trigger is downstream of this: the pad is placed
   at the corner and sized so the pivot lands on it. */
export const THUMB_PIVOT_INSET_X = 60;
export const THUMB_PIVOT_INSET_Y = 12;

/**
 * The comfortable thumb annulus, measured from the trigger hand's corner, px.
 *
 * Inside `THUMB_ARC_INNER` the thumb is folded under itself; past
 * `THUMB_ARC_OUTER` the hand has to regrip. Everything between is what a
 * trigger thumb can sweep, and it is the region `thumbArcMix` measures.
 */
export const THUMB_ARC_INNER = 80;
export const THUMB_ARC_OUTER = 220;

/**
 * Smallest side of the fire-and-look slab, px — the number the round-2 work
 * order named, and it is not arbitrary: a square this size anchored at the
 * corner contains the whole of the r≤220 sweep arc, so there is no reachable
 * spot where a thumb can press and *not* be firing and aiming at once.
 */
export const FIRE_ZONE_MIN = 260;

/**
 * Largest side of the slab, px. On a tablet, 62 % of the short edge would run
 * to 476 px and hand half the screen to the trigger; the thumb's arc does not
 * grow with the screen, so neither does this.
 */
export const FIRE_ZONE_MAX = 320;

/**
 * Base radius the movement stick is guaranteed before the slab may take any
 * more width, px. Portrait is the case that binds: 412 px of screen minus a
 * 260 px slab leaves 152, which is exactly a 16 px margin, a Ø124 stick and a
 * 12 px gap. The stick loses 10 % of its diameter in portrait and the trigger
 * arc gains its 260th pixel; that is the trade, made explicitly.
 */
export const MIN_STICK_BASE_R = 62;

/**
 * Hard ceiling on how far the trigger's centre may sit from the thumb pivot,
 * px. Under this and the pad is a control you press; over it and it is a
 * control you *reach for*, which in a firefight is a control you do not press.
 */
export const MAX_ATTACK_REACH = 90;

/** Gap kept between neighbouring controls, px. */
const GAP = 10;

/**
 * The block the HUD keeps in the movement hand's top corner while the pad is
 * mounted: the 92 px minimap, the three match chips under it and the status
 * corner under those. Measured off the running build at 915x412 — the chips
 * end at y 140 — and shared with `MOBILE_CSS`, which is what draws them.
 *
 * The solver has to know it exists. A control placed there is not *overlapping
 * a control*, so no amount of disc-vs-disc testing catches it; it is simply
 * illegible, which is how the utility row spent its first landscape frame
 * underneath the match clock.
 */
export const HUD_CORNER_W = 106;
export const HUD_CORNER_H = 146;

/**
 * Screen-edge margin for the trigger specifically, px. Tighter than the 16/14
 * the rest of the cluster uses, because every pixel the disc is inset from the
 * corner is a pixel its centre moves away from the thumb pivot.
 */
const TRIGGER_EDGE = 10;

/**
 * Margin from the screen edge to a bottom-corner read-out, px. Shared with the
 * stylesheet in `hud/mobile.ts` so the box the solver promises and the box the
 * browser paints are the same box.
 */
export const READOUT_MARGIN = 10;

/** Clear space kept between a read-out and the nearest control, px. */
export const READOUT_CLEARANCE = 8;

/**
 * Ceiling on a corner read-out's width, px. Nothing on a phone HUD needs to be
 * wider than this, and without a cap the portrait layout hands the ammo plate
 * the entire gap between the thumbs, which the HUD would then fill with type.
 */
const READOUT_MAX_W = 208;

/**
 * Vertical space the trigger corner keeps free for the ammo plate, px — the
 * plate's own 80 px plus its clearance.
 *
 * The solver has to know this number because the plate is the one HUD element
 * that lives *inside* the slab (it is inert, so it may) while JUMP/DUCK live
 * just above it (they are not). Without the reserve the two collide on a short
 * screen, and the read-out is what loses.
 */
const READOUT_RESERVE_H = 88;

function disc(): Disc { return { x: 0, y: 0, r: 0 }; }
function rect(): Rect { return { x0: 0, y0: 0, x1: 0, y1: 0 }; }

export function createTouchGeom(): TouchGeom {
  return {
    vw: 0, vh: 0, portrait: false, southpaw: false,
    stickHome: disc(), stickTravel: 0, knobR: 0, deadR: 0, detentR: 0,
    stickZone: rect(), stickBounds: rect(),
    thumbPivot: { x: 0, y: 0 }, fireZone: rect(),
    fire: disc(), jump: disc(), crouch: disc(), reload: disc(),
    build: disc(), swap: disc(), autoFire: disc(), aimAssist: disc(), pause: disc(),
    padBottomLeft: 0, padBottomRight: 0,
    padEdgeLeft: 0, padEdgeRight: 0,
    readoutWidthLeft: 0, readoutWidthRight: 0, readoutInset: 0,
    centreX0: 0, centreX1: 0,
  };
}

/**
 * Distance from the trigger thumb's pivot to the centre of the attack pad, px.
 * The one number that answers "can you shoot without looking at your hands".
 */
export function attackReach(g: TouchGeom): number {
  return Math.hypot(g.fire.x - g.thumbPivot.x, g.fire.y - g.thumbPivot.y);
}

/**
 * The rectangle a corner read-out is promised, in client coordinates.
 *
 * `side` is the SCREEN side, not the hand: 0 = left, 1 = right. `height` is
 * however tall the HUD's plate turns out to be; the caller passes its own
 * number so the assertion in `touch.test.ts` — that this rectangle touches no
 * control at any viewport, hand or control size — is an assertion about the
 * real plate rather than about a convenient one.
 */
export function readoutRect(g: TouchGeom, side: 0 | 1, height: number, out: Rect): Rect {
  const band = side === 0 ? g.padEdgeLeft : g.padEdgeRight;
  const width = side === 0 ? g.readoutWidthLeft : g.readoutWidthRight;
  // Both plates now sit at the plain margin. The option chips used to run down
  // the trigger edge from the top corner and the ammo plate had to be inset
  // past them; they are a top-edge row now (see `readoutInset`, which is still
  // the reserve the kill feed needs up there), so the bottom corner is clear
  // and the plate can tuck all the way into it.
  const inset = READOUT_MARGIN;
  out.x0 = side === 0 ? inset : g.vw - inset - width;
  out.x1 = out.x0 + width;
  out.y1 = g.vh - band - READOUT_CLEARANCE;
  out.y0 = out.y1 - Math.max(0, height);
  return out;
}

/**
 * Place every control for a viewport. Pure arithmetic — no DOM, no measuring,
 * which is also why the pad never calls `getBoundingClientRect()` in a pointer
 * handler. A layout read inside a move event is a forced synchronous reflow,
 * and at 4x CPU throttle that is exactly how a 1 % low gets lost.
 */
export function solveTouchLayout(
  vw: number, vh: number,
  opts: Partial<TouchLayoutOptions>,
  out: TouchGeom,
): TouchGeom {
  const o: TouchLayoutOptions = { ...DEFAULT_TOUCH_LAYOUT, ...opts };
  const w = Math.max(240, vw);
  const h = Math.max(240, vh);
  const short = Math.min(w, h);
  const scale = clampf(o.scale, 0.7, 1.4);

  out.vw = w;
  out.vh = h;
  out.portrait = h >= w;
  out.southpaw = o.southpaw;

  /* --- sizes -----------------------------------------------------------
     Nothing here is allowed below `MIN_TOUCH_TARGET` across, at any viewport
     or any user scale. The bar's four glyph buttons measure ~40 px, which is
     under both Apple's and Google's floor, and they are the buttons you
     mis-hit. */
  const unit = clampf(short * 0.145, 42, 64) * scale;
  const btnR = clampf(unit * 0.5, MIN_TOUCH_TARGET / 2, 32);
  const smallR = clampf(unit * 0.42, MIN_TOUCH_TARGET / 2, 26);
  const chipR = clampf(unit * 0.46, MIN_TOUCH_TARGET / 2, 28);
  const rim = clampf(unit * 0.24, 10, 16);
  /* The trigger is the exception to the size slider: it may grow with it but
     never shrink past `MIN_ATTACK_PAD_D`, and never grow past
     `MAX_ATTACK_PAD_D` either. A player who has dialled the controls down to
     keep the screen clear has still got to be able to shoot; a player who has
     dialled them up must not end up with a trigger so fat that its centre —
     one radius in from each edge — walks out of the thumb's arc. */
  const fireR = clampf(Math.max(unit, MIN_ATTACK_PAD_D / 2),
    MIN_ATTACK_PAD_D / 2, MAX_ATTACK_PAD_D / 2);
  let travel = clampf(short * 0.14, 40, 62) * scale;
  let baseR = travel + rim;

  const ml = 16 + Math.max(0, o.safeLeft);
  const mr = 16 + Math.max(0, o.safeRight);
  const mt = 12 + Math.max(0, o.safeTop);
  const mb = 14 + Math.max(0, o.safeBottom);

  /* --- the trigger, and the slab around it -----------------------------
     The trigger disc is placed against the corner with its own tighter
     margin, and the thumb pivot is recorded so `attackReach` is a measurement
     rather than an opinion. At 915x412 that lands the disc's centre 58.9 px
     from the pivot with a 59.9 px radius — the resting thumb is already
     *inside* the pad. The bar's equivalent reach is 199 px.

     Then the slab. Its side is the thumb's arc, not the screen's size, so it
     is clamped to [FIRE_ZONE_MIN, FIRE_ZONE_MAX] and only ever shrinks when
     the viewport genuinely cannot hold it beside a usable stick (width) or
     under the two movement glyphs (height). It is anchored hard into the
     corner — no margin, no safe-area inset — because a slab that stops 16 px
     short of the bezel has a 16 px strip along the edge where the thumb's
     press is not a shot, and the edge is exactly where a gripping thumb
     lands. */
  const trigMR = TRIGGER_EDGE + Math.max(0, o.safeRight);
  const trigMB = TRIGGER_EDGE + Math.max(0, o.safeBottom);
  const fx = w - trigMR - fireR;
  const fy = h - trigMB - fireR;
  out.fire.x = fx; out.fire.y = fy; out.fire.r = fireR;
  out.thumbPivot.x = w - Math.max(0, o.safeRight) - THUMB_PIVOT_INSET_X;
  out.thumbPivot.y = h - Math.max(0, o.safeBottom) - THUMB_PIVOT_INSET_Y;
  const fireTop = fy - fireR;

  const pauseR = clampf(smallR * 0.9, MIN_TOUCH_TARGET / 2, 24);
  /* The slab may never be smaller than the disc it contains, or the corner
     would hold a control the surrounding region disagrees with. */
  const slabFloor = 2 * fireR + TRIGGER_EDGE + 4;
  const slabWant = clampf(short * 0.62, FIRE_ZONE_MIN, FIRE_ZONE_MAX);
  const stickBand = ml + 2 * MIN_STICK_BASE_R + 12;
  const topBand = mt + 2 * chipR + GAP + 2 * btnR + GAP;
  const slabW = clampf(slabWant, slabFloor, Math.max(slabFloor, w - stickBand));
  const slabH = clampf(slabWant, slabFloor, Math.max(slabFloor, h - topBand));
  const slabX0 = w - slabW;
  const slabY0 = h - slabH;
  out.fireZone.x0 = slabX0;
  out.fireZone.y0 = slabY0;
  out.fireZone.x1 = w;
  out.fireZone.y1 = h;

  /* --- option chips ----------------------------------------------------
     Auto-fire, aim-assist and pause are pressed between fights and never
     during one, so they live in the far top corner, as far from the sweep arc
     as the screen allows. They stack under the pause glyph where the corner is
     tall enough and run inboard along the top edge where it is not — on a
     412 px-tall landscape phone a vertical column would reach down into the
     band JUMP/DUCK now need. */
  out.pause.x = w - mr - pauseR;
  out.pause.y = mt + pauseR;
  out.pause.r = pauseR;
  out.autoFire.r = chipR;
  out.aimAssist.r = chipR;
  const chipColumn = (slabY0 - mt) >= (2 * pauseR + 4 * chipR + 4 * btnR + 40);
  if (chipColumn) {
    out.autoFire.x = out.pause.x;
    out.autoFire.y = out.pause.y + pauseR + 8 + chipR;
    out.aimAssist.x = out.pause.x;
    out.aimAssist.y = out.autoFire.y + chipR * 2 + 6;
  } else {
    out.autoFire.y = mt + chipR;
    out.aimAssist.y = mt + chipR;
    out.autoFire.x = out.pause.x - pauseR - 8 - chipR;
    out.aimAssist.x = out.autoFire.x - chipR * 2 - 6;
  }
  const optionsBottom = Math.max(out.pause.y + pauseR, out.aimAssist.y + chipR);
  const optionsLeft = Math.min(out.pause.x - pauseR, out.aimAssist.x - chipR);

  /* --- JUMP and DUCK ---------------------------------------------------
     Out of the arc, and no further out than they have to be: they hug the
     same screen edge the thumb is already resting against, immediately above
     the slab, so the gesture is "slide up the bezel" rather than "reach into
     the middle of the picture". Their lowest edge is bounded twice — by the
     slab (which they may not touch, or the arc has a hole in it) and by the
     corner read-out's reserve (which they may not sit on, or the ammo plate
     goes back to floating up the screen).

     Three placements, in order of preference: stacked up the edge, side by
     side above the slab, and — only when the trigger edge is genuinely too
     short for either, which takes a 360x640 phone with the size slider at
     1.4x — inboard along the bottom, still 270 px clear of the pivot. */
  const plateTop = fireTop - READOUT_CLEARANCE - READOUT_RESERVE_H;
  const pairFloor = optionsBottom + GAP;
  const pairBottom = Math.min(slabY0 - GAP, plateTop - READOUT_CLEARANCE);
  const edgeX = w - mr - btnR;
  let pairInboard = false;
  out.jump.r = btnR;
  out.crouch.r = btnR;
  if (pairBottom - 4 * btnR - GAP >= pairFloor) {
    out.crouch.x = edgeX;
    out.crouch.y = pairBottom - btnR;
    out.jump.x = edgeX;
    out.jump.y = out.crouch.y - 2 * btnR - GAP;
  } else if (pairBottom - 2 * btnR >= pairFloor) {
    const y = pairBottom - btnR;
    out.crouch.x = edgeX;
    out.crouch.y = y;
    out.jump.x = edgeX - 2 * btnR - GAP;
    out.jump.y = y;
  } else {
    pairInboard = true;
    const y = h - mb - btnR;
    out.crouch.x = slabX0 - GAP - btnR;
    out.crouch.y = y;
    out.jump.x = out.crouch.x - 2 * btnR - GAP;
    out.jump.y = y;
  }
  const pairTop = Math.min(out.jump.y, out.crouch.y) - btnR;

  /* --- left-hand stick -------------------------------------------------
     The stick may never reach the slab. On a narrow portrait phone with the
     control-size slider pushed up, the honest answer is a smaller stick, not a
     thumb that starts a shot every time it reaches for a strafe. */
  const rightWall = pairInboard ? out.jump.x - btnR : slabX0;
  const maxBase = (rightWall - 12 - ml) * 0.5;
  if (baseR > maxBase) {
    baseR = Math.max(MIN_TOUCH_TARGET, maxBase);
    travel = Math.max(30, baseR - rim);
  }
  const knobR = clampf(travel * 0.46, 18, 30);
  const sx = ml + baseR;
  const sy = h - mb - baseR;
  const stickTop = sy - baseR;
  const stickRight = sx + baseR;
  out.stickHome.x = sx; out.stickHome.y = sy; out.stickHome.r = baseR;
  out.stickTravel = travel;
  out.knobR = knobR;
  out.deadR = travel * clampf(o.deadZone, 0, 0.9);
  out.detentR = travel * clampf(o.detent, 0.5, 1);

  /* --- RLD, BLD, WEP ---------------------------------------------------
     Utility, not combat, and they used to be the second column inboard of
     JUMP/DUCK — i.e. the other half of what paved the arc. They are off the
     trigger thumb's sweep entirely now: a row above the stick where the
     movement hand can reach them between fights, and where that row will not
     fit before the slab (a 412 px-wide portrait phone), a row high up the
     trigger edge above JUMP/DUCK, which is still 400 px from the pivot. The
     column up the movement edge is the last resort for a small screen at a
     large control size. */
  const rowW = smallR * 6 + GAP * 2;
  /* The movement corner is stacked exactly like the trigger corner: control,
     then the read-out's reserve, then whatever else. The vitals plate hangs
     off the top of the stick, so the utility row starts above the plate — a
     row parked directly on the stick would be sat on by the plate at large
     control sizes, which is how a read-out ends up printed over a button. */
  const leftPlateTop = stickTop - READOUT_CLEARANCE - READOUT_RESERVE_H;
  const utilY = Math.max(mt + smallR, leftPlateTop - READOUT_CLEARANCE - smallR);
  const topRowY = mt + smallR;
  const topRowFirst = optionsLeft - GAP - smallR;
  let utilLeft = true;
  let topRowLeft = optionsLeft;
  if (ml + rowW + 12 <= rightWall && utilY - smallR >= HUD_CORNER_H) {
    /* 1. Above the stick, where the movement hand reaches it between fights.
          Needs the width AND clear air below the HUD's corner block: on a
          412 px-tall landscape phone the minimap and the match chips already
          own everything above the vitals plate. */
    out.reload.x = ml + smallR;
    out.build.x = ml + smallR * 3 + GAP;
    out.swap.x = ml + smallR * 5 + GAP * 2;
    out.reload.y = utilY; out.build.y = utilY; out.swap.y = utilY;
  } else if (!chipColumn && topRowFirst - smallR * 5 - GAP * 2 - smallR >= HUD_CORNER_W + 12) {
    /* 2. The short-screen answer: continue the top-edge option row inboard.
          Furthest of all from the sweep arc (400 px and more), on the one
          strip of a landscape phone that neither the HUD nor a thumb wants. */
    utilLeft = false;
    out.reload.x = topRowFirst;
    out.build.x = out.reload.x - 2 * smallR - GAP;
    out.swap.x = out.build.x - 2 * smallR - GAP;
    out.reload.y = topRowY; out.build.y = topRowY; out.swap.y = topRowY;
    topRowLeft = out.swap.x - smallR;
  } else if (pairTop - GAP - 2 * smallR >= optionsBottom + GAP
    && edgeX - smallR * 5 - GAP * 2 - smallR >= ml + 12) {
    /* 3. Portrait: a row up the trigger edge above JUMP/DUCK. The corner is
          tall there and the arc still ends 400 px below it. */
    utilLeft = false;
    const uy = pairTop - GAP - smallR;
    out.reload.x = w - mr - smallR;
    out.build.x = out.reload.x - 2 * smallR - GAP;
    out.swap.x = out.build.x - 2 * smallR - GAP;
    out.reload.y = uy; out.build.y = uy; out.swap.y = uy;
  } else {
    /* 4. Last resort — a column up the movement edge. Only a small phone at a
          large control size gets here. */
    const x = ml + smallR;
    out.reload.x = x; out.reload.y = utilY;
    out.build.x = x; out.build.y = utilY - 2 * smallR - GAP;
    out.swap.x = x; out.swap.y = out.build.y - 2 * smallR - GAP;
  }
  out.reload.r = smallR;
  out.build.r = smallR;
  out.swap.r = smallR;

  /* --- zones ----------------------------------------------------------
     The grab zone is deliberately much bigger than the drawn stick, because a
     floating stick that only floats where the stick already is has not
     floated. It stops short of the slab: the two may not overlap, or a thumb
     reaching for a strafe would open fire. Nothing is lost by letting it run
     under the utility row, because `hitTest` resolves the buttons FIRST —
     RLD/BLD/WEP each answer inside their own radius plus 6 px of slop, and
     neighbouring chips are 60 px apart with 62 px of combined slop, so there
     is no seam between them for the stick to steal. */
  const zoneRight = Math.min(w * 0.5, rightWall - 6, slabX0 - 6);
  let zoneHeight = Math.min(h * 0.62, baseR * 2 + 96);
  /* …and it always keeps real headroom ABOVE the drawn base, or a thumb that
     lands a centimetre high becomes a look-drag — i.e. the player looks at the
     sky instead of backing out of a fight. On a 360 px-tall phone with the
     size slider up, `h * 0.62` alone does not leave any. */
  const minZone = baseR * 2.5 + mb + 6;
  if (zoneHeight < minZone) zoneHeight = Math.min(h, minZone);
  const zoneTop = Math.max(0, h - zoneHeight);
  out.stickZone.x0 = 0;
  out.stickZone.y0 = zoneTop;
  out.stickZone.x1 = zoneRight;
  out.stickZone.y1 = h;

  out.stickBounds.x0 = ml + baseR * 0.7;
  out.stickBounds.y0 = Math.min(sy, zoneTop + baseR * 0.7);
  out.stickBounds.x1 = Math.max(out.stickBounds.x0, zoneRight - baseR * 0.7);
  out.stickBounds.y1 = Math.max(out.stickBounds.y0, h - mb - baseR * 0.7);

  /* --- the bands the HUD may draw read-outs in -------------------------
     Only a control whose CENTRE is in the bottom half of the screen can hide a
     corner read-out, and that is the same filter `mobile.test.ts` sweeps with,
     so the promise and the check are the same rule. JUMP/DUCK up the trigger
     edge are above that line on a landscape phone and below it on a portrait
     one, and the band follows them either way. */
  let leftTop = h;
  leftTop = lowestTop(h, out.stickHome, leftTop);
  if (utilLeft) {
    leftTop = lowestTop(h, out.reload, leftTop);
    leftTop = lowestTop(h, out.build, leftTop);
    leftTop = lowestTop(h, out.swap, leftTop);
  }
  let rightTop = h;
  rightTop = lowestTop(h, out.fire, rightTop);
  rightTop = lowestTop(h, out.jump, rightTop);
  rightTop = lowestTop(h, out.crouch, rightTop);
  if (!utilLeft) {
    rightTop = lowestTop(h, out.reload, rightTop);
    rightTop = lowestTop(h, out.build, rightTop);
    rightTop = lowestTop(h, out.swap, rightTop);
  }
  const leftBottomBand = h - leftTop;
  const rightBottomBand = h - rightTop;

  const leftClusterRight = utilLeft
    ? Math.max(stickRight, out.swap.x + smallR)
    : stickRight;
  const rightClusterLeft = pairInboard ? out.jump.x - btnR : slabX0;

  /* --- and the tighter band the CORNER read-outs get -------------------
     The corner plate only has to clear what is actually in the corner. On the
     trigger side that is now the trigger disc alone: JUMP/DUCK were placed
     above `plateTop` by construction, and the slab itself is a gesture region
     rather than a drawn control, so the plate is allowed to sit inside it —
     which is how the ammo ends up tucked against the trigger instead of
     floating 205 px up a 412 px-tall screen. When the pair had to go inboard
     the width cap below is what keeps the plate off them. */
  const leftEdgeBand = h - stickTop;
  const rightEdgeBand = h - Math.min(fireTop, pairInboard ? pairTop : fireTop);
  const rightEdgeLimit = Math.max(
    leftClusterRight,
    pairInboard ? out.crouch.x + btnR : 0,
  );
  const rightEdgeW = clampf(
    w - READOUT_MARGIN - rightEdgeLimit - READOUT_CLEARANCE,
    MIN_TOUCH_TARGET, READOUT_MAX_W,
  );
  /* The two plates share one row of screen on a short phone, so the second one
     is also bounded by what the first one left: two 208 px promises on a
     412 px-wide portrait phone is how two read-outs end up printed on top of
     each other. */
  const leftEdgeW = clampf(
    Math.min(
      rightClusterLeft - READOUT_MARGIN - READOUT_CLEARANCE,
      w - READOUT_MARGIN * 2 - rightEdgeW - READOUT_CLEARANCE,
    ),
    MIN_TOUCH_TARGET, READOUT_MAX_W,
  );

  /* The kill feed runs along the top and must stop before the option row, so
     the reserve is measured off whatever is furthest inboard up there —
     including the utility glyphs when they joined that row. */
  out.readoutInset = Math.max(0, w - topRowLeft) + 8;

  if (o.southpaw) {
    mirrorDisc(out.fire, w);
    mirrorDisc(out.jump, w);
    mirrorDisc(out.crouch, w);
    mirrorDisc(out.reload, w);
    mirrorDisc(out.build, w);
    mirrorDisc(out.swap, w);
    mirrorDisc(out.autoFire, w);
    mirrorDisc(out.aimAssist, w);
    mirrorDisc(out.stickHome, w);
    mirrorDisc(out.pause, w);
    // The pivot is a property of the hand, so it mirrors with the hand.
    out.thumbPivot.x = w - out.thumbPivot.x;
    const fx0 = w - out.fireZone.x1;
    out.fireZone.x1 = w - out.fireZone.x0;
    out.fireZone.x0 = fx0;
    const zx0 = w - out.stickZone.x1;
    out.stickZone.x0 = zx0;
    out.stickZone.x1 = w;
    const bx0 = w - out.stickBounds.x1;
    const bx1 = w - out.stickBounds.x0;
    out.stickBounds.x0 = bx0;
    out.stickBounds.x1 = bx1;
    out.padBottomLeft = rightBottomBand;
    out.padBottomRight = leftBottomBand;
    out.padEdgeLeft = rightEdgeBand;
    out.padEdgeRight = leftEdgeBand;
    out.readoutWidthLeft = rightEdgeW;
    out.readoutWidthRight = leftEdgeW;
    out.centreX0 = w - rightClusterLeft + 10;
    out.centreX1 = w - leftClusterRight - 10;
  } else {
    out.padBottomLeft = leftBottomBand;
    out.padBottomRight = rightBottomBand;
    out.padEdgeLeft = leftEdgeBand;
    out.padEdgeRight = rightEdgeBand;
    out.readoutWidthLeft = leftEdgeW;
    out.readoutWidthRight = rightEdgeW;
    out.centreX0 = leftClusterRight + 10;
    out.centreX1 = rightClusterLeft - 10;
  }
  // A narrow portrait phone has no free centre column at all. Report that
  // honestly as a zero-width band rather than an inside-out one, so the HUD
  // switches to its stacked layout instead of drawing into a negative box.
  if (out.centreX1 < out.centreX0) {
    const mid = (out.centreX0 + out.centreX1) * 0.5;
    out.centreX0 = mid;
    out.centreX1 = mid;
  }
  return out;
}

/**
 * The top edge of `d`, but only when its centre is in the bottom half of the
 * screen; otherwise `cur` unchanged. Folded over a cluster this gives the
 * height of the band that cluster's bottom-anchored controls occupy.
 */
function lowestTop(h: number, d: Disc, cur: number): number {
  if (d.y <= h * 0.5) return cur;
  const t = d.y - d.r;
  return t < cur ? t : cur;
}

function mirrorDisc(d: Disc, w: number): void { d.x = w - d.x; }

function inDisc(d: Disc, x: number, y: number, slop: number): boolean {
  const r = d.r + slop;
  const dx = x - d.x;
  const dy = y - d.y;
  return dx * dx + dy * dy <= r * r;
}

function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

/**
 * Which control a press at (x, y) belongs to.
 *
 * Order matters and is deliberate: buttons win over the trigger, the trigger
 * wins over the stick zone, and everything left over is look. `slop` grows the
 * hit area past the drawn circle — a 60 px glyph that only answers inside its
 * own 60 px is a glyph you miss in a firefight, and the bar's 40 px ones are
 * exactly that.
 *
 * The trigger is TWO tests, and the second one is the point of round 2: the
 * drawn disc, and then the whole `fireZone` slab around it. Inside the slab a
 * press is a shot and the drag that follows still pans the camera, so the
 * thumb's entire sweep arc is one gesture instead of an obstacle course.
 * `solveTouchLayout` keeps every button out of the slab, so nothing above this
 * line can steal a press from it.
 */
export function hitTest(g: TouchGeom, x: number, y: number, slop: number = 6): number {
  if (inDisc(g.pause, x, y, slop)) return TC_PAUSE;
  if (inDisc(g.autoFire, x, y, slop)) return TC_AUTOFIRE;
  if (inDisc(g.aimAssist, x, y, slop)) return TC_AIMASSIST;
  if (inDisc(g.jump, x, y, slop)) return TC_JUMP;
  if (inDisc(g.crouch, x, y, slop)) return TC_CROUCH;
  if (inDisc(g.reload, x, y, slop)) return TC_RELOAD;
  if (inDisc(g.build, x, y, slop)) return TC_BUILD;
  if (inDisc(g.swap, x, y, slop)) return TC_SWAP;
  if (inDisc(g.fire, x, y, slop)) return TC_FIRE;
  if (inRect(g.fireZone, x, y)) return TC_FIRE;
  if (inRect(g.stickZone, x, y)) return TC_STICK;
  return TC_LOOK;
}

/** Every disc the layout draws, in hit-test order. For tests and for drawing. */
export function touchDiscs(g: TouchGeom): Disc[] {
  return [
    g.pause, g.autoFire, g.aimAssist, g.jump, g.crouch,
    g.reload, g.build, g.swap, g.fire, g.stickHome,
  ];
}

/* ------------------------------------------------------------------------ *
 * The sweep arc, as a measurement
 * ------------------------------------------------------------------------ */

/** What a trigger thumb finds when it sweeps its arc. Fractions, summing to 1. */
export interface ThumbArcMix {
  /** Presses that pan the camera — look surface plus the fire-and-look slab. */
  pan: number;
  /** Presses that fire AND pan: the slab. A subset of `pan`. */
  fire: number;
  /** Presses that are a discrete button, and therefore cannot pan. */
  button: number;
  /** Presses the movement stick claims. */
  stick: number;
  /** Points sampled, for a caller that wants to know the resolution. */
  samples: number;
}

/**
 * Classify the trigger thumb's comfortable arc, from its own corner.
 *
 * This is the round-1 loss expressed as a number so it cannot come back: of
 * the annulus r 80–220 swept from the trigger corner, how much can the thumb
 * press *without stopping the camera*. Round 1 scored 38.7 % button; the bar
 * scores 10.4 %; a layout that keeps its promise scores 0 %, with `pan` at
 * 1.0 because every reachable pixel either looks or fires-and-looks.
 *
 * Test-only — it walks a grid — but it lives here beside `hitTest` because it
 * is only meaningful if it asks the same function a real finger asks.
 */
export function thumbArcMix(g: TouchGeom, step: number = 2): ThumbArcMix {
  const cx = g.southpaw ? 0 : g.vw;
  const cy = g.vh;
  const r0 = THUMB_ARC_INNER * THUMB_ARC_INNER;
  const r1 = THUMB_ARC_OUTER * THUMB_ARC_OUTER;
  const x0 = Math.max(0, cx - THUMB_ARC_OUTER);
  const x1 = Math.min(g.vw, cx + THUMB_ARC_OUTER);
  const y0 = Math.max(0, cy - THUMB_ARC_OUTER);
  const y1 = Math.min(g.vh, cy + THUMB_ARC_OUTER);
  let n = 0;
  let pan = 0;
  let fire = 0;
  let button = 0;
  let stick = 0;
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d < r0 || d > r1) continue;
      n++;
      const c = hitTest(g, x, y);
      if (c === TC_FIRE) { fire++; pan++; }
      else if (c === TC_LOOK) pan++;
      else if (c === TC_STICK) stick++;
      else button++;
    }
  }
  const k = n > 0 ? 1 / n : 0;
  return { pan: pan * k, fire: fire * k, button: button * k, stick: stick * k, samples: n };
}

/* ------------------------------------------------------------------------ *
 * Contrast
 *
 * Weakness #10 measured rather than asserted. Sampled off the bar's own
 * landscape capture (ref/voxiom/mobileland-08-combat.png), its joystick's base
 * ring is rgb(116,126,97) against rgb(101,112,69) of grass — a contrast ratio
 * of **1.24:1**, i.e. invisible — and its knob is rgb(178,178,178) on the same
 * grass, **2.39:1**, under the 3:1 WCAG floor for a non-text control.
 *
 * Its own glyph edges measure the same way. Sampled as annuli either side of
 * each rim on that capture: the dig disc — the only attack affordance it has —
 * reads 1.37:1 against the grass behind it, crouch 1.35:1, and the two glyphs
 * that sit on the dark tree trunk read 1.73:1 and 1.32:1. So it does not
 * recover on a dark backdrop either: the fill is a translucent white wash with
 * no stroke at all, so whatever is behind it drags it along.
 *
 * The fix is not "use a brighter colour", because no single colour survives
 * both a sunlit sand cliff and a black corridor. It is a two-tone edge, drawn
 * in FULLY OPAQUE ink: every control is stroked light AND dark. Whatever the
 * background does, one of the two strokes is in contrast with it, and the
 * guaranteed worst case over the entire RGB cube is 4.58:1. That is a theorem
 * about the palette, and `touch.test.ts` proves it by sweeping the cube.
 * ------------------------------------------------------------------------ */

export function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function contrastRatio(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
): number {
  const l1 = relativeLuminance(r1, g1, b1);
  const l2 = relativeLuminance(r2, g2, b2);
  return l1 > l2 ? (l1 + 0.05) / (l2 + 0.05) : (l2 + 0.05) / (l1 + 0.05);
}

/** Source-over of a straight-alpha colour on an opaque background, one channel. */
function over(fg: number, a: number, bg: number): number {
  return fg * a + bg * (1 - a);
}

export interface EdgePalette {
  lightR: number; lightG: number; lightB: number; lightA: number;
  darkR: number; darkG: number; darkB: number; darkA: number;
}

/**
 * The exact strokes `hud/mobile.ts` draws: **fully opaque**, both of them.
 *
 * The alphas used to be 0.96 and 0.90, which was already twenty times better
 * than the bar and still the wrong answer. A stroke's whole job is to be the
 * boundary, and a boundary that lets 4 % of the terrain through is a boundary
 * whose measured contrast depends on the terrain. Opaque means the light
 * stroke is *exactly* white at relative luminance 1.0 and the dark stroke is
 * exactly black at 0.0, on every frame, so the numbers below are properties of
 * the palette rather than of the level:
 *
 *   - on the bar's own bright grass (the pixels its crouch glyph sits on,
 *     rgb(107,114,59), L = 0.155) the white stroke alone measures **5.13:1** —
 *     clear of the 3:1 WCAG floor for a non-text control, and 3.8x the 1.35:1
 *     that same glyph's own edge measures;
 *   - on the bar's dark tree trunk (rgb(54,35,24), L = 0.021) it measures
 *     **14.9:1**;
 *   - and against *any* background whatsoever, the light/dark pair measures at
 *     least **4.58:1** (`worstEdgeContrast`), because the worst case is the
 *     luminance where white and black are equally bad and opaque ink puts that
 *     crossover at (L+0.05)^2 = 0.0525.
 *
 * Raising the alphas to 1 is worth 4.40 -> 4.58 on the guaranteed floor and,
 * more importantly, it makes the floor a *guarantee* instead of an average.
 */
export const TOUCH_EDGE: Readonly<EdgePalette> = Object.freeze({
  lightR: 255, lightG: 255, lightB: 255, lightA: 1,
  darkR: 0, darkG: 0, darkB: 0, darkA: 1,
});

/**
 * Stroke widths, in CSS px, shared with the stylesheet so the two cannot drift.
 * 2 px is the floor named by the work order; the light stroke is drawn at 2.5
 * and the trigger's at `TRIGGER_STROKE_PX`, because the primary verb should
 * read as the primary verb from the corner of the eye.
 */
export const MIN_EDGE_STROKE_PX = 2;
export const EDGE_STROKE_PX = 2.5;
export const EDGE_HALO_PX = 2;
export const TRIGGER_STROKE_PX = 3;

/** Contrast of the light stroke alone against one background. */
export function lightStrokeContrast(
  bgR: number, bgG: number, bgB: number,
  pal: EdgePalette = TOUCH_EDGE,
): number {
  return contrastRatio(
    over(pal.lightR, pal.lightA, bgR),
    over(pal.lightG, pal.lightA, bgG),
    over(pal.lightB, pal.lightA, bgB),
    bgR, bgG, bgB,
  );
}

/** Contrast of the dark stroke alone against one background. */
export function darkStrokeContrast(
  bgR: number, bgG: number, bgB: number,
  pal: EdgePalette = TOUCH_EDGE,
): number {
  return contrastRatio(
    over(pal.darkR, pal.darkA, bgR),
    over(pal.darkG, pal.darkA, bgG),
    over(pal.darkB, pal.darkA, bgB),
    bgR, bgG, bgB,
  );
}

/**
 * Contrast of the better of the two strokes against one background. This is
 * the number that decides whether a control is visible, because a control the
 * player can see the outline of is a control they can hit.
 */
export function edgeContrast(
  bgR: number, bgG: number, bgB: number,
  pal: EdgePalette = TOUCH_EDGE,
): number {
  const a = lightStrokeContrast(bgR, bgG, bgB, pal);
  const b = darkStrokeContrast(bgR, bgG, bgB, pal);
  return a > b ? a : b;
}

/**
 * Worst `edgeContrast` over an evenly sampled RGB cube. `step` of 17 gives
 * 16^3 = 4096 backgrounds, which is plenty to catch the mid-luminance valley
 * where a single-tone outline dies.
 */
export function worstEdgeContrast(pal: EdgePalette = TOUCH_EDGE, step: number = 17): number {
  let worst = Infinity;
  for (let r = 0; r <= 255; r += step) {
    for (let g = 0; g <= 255; g += step) {
      for (let b = 0; b <= 255; b += step) {
        const c = edgeContrast(r, g, b, pal);
        if (c < worst) worst = c;
      }
    }
  }
  return worst;
}

/* ------------------------------------------------------------------------ *
 * Router
 *
 * One surface, many fingers. Every pointer that lands anywhere on the screen
 * comes through here, is classified once by `hitTest` against the solved
 * geometry, and is then owned by exactly one control until it lifts.
 *
 * That is the whole answer to "can you aim and shoot with one thumb per side".
 * The bar cannot answer it: it has no fire button, so the right thumb's single
 * gesture has to mean *both* look and shoot, and the two cancel out. Here the
 * right thumb has three separable gestures on one surface —
 *
 *   tap the look area              one shot, no view movement
 *   drag the look area             aim, and never fire by accident
 *   press the corner, keep sliding trigger held AND aiming, same thumb
 *
 * — while the left thumb keeps the stick, and neither thumb has to leave the
 * glass. The third one is the gesture round 1 could not really offer: the
 * corner it starts in is now a 260 px slab covering the thumb's whole sweep,
 * so it is the DEFAULT thing that happens when a resting thumb moves, not a
 * trick that needs the disc hit first. It is deliberately DOM-free: `hud/mobile.ts` feeds it plain numbers,
 * so `touch.test.ts` can replay a two-thumb firefight in node.
 * ------------------------------------------------------------------------ */

/** Everything the router pushes input into. `InputManager` satisfies it. */
export interface TouchSink {
  setMove(x: number, z: number): void;
  addLook(dxPx: number, dyPx: number): void;
  setButton(action: InputAction, down: boolean): void;
  tap(action: InputAction): void;
  reset(): void;
}

export interface TouchAimTarget { yaw: number; pitch: number; dist: number }

/**
 * The three things aim assist needs from the game. `Game` already exposes all
 * of them publicly (`nearestEnemyAim`, `viewClearance`, `camera.addLook`), so
 * the mobile layer needs no new engine surface to be wired in.
 */
export interface TouchAimSource {
  /** Signed angles from the view to the nearest live enemy. False if none. */
  nearestEnemyAim(out: TouchAimTarget): boolean;
  /** Metres of clear line straight ahead, saturating at some finite probe range. */
  viewClearance(): number;
  /** Apply an assist correction, in radians. */
  addLookRadians(yaw: number, pitch: number): void;
}

export interface TouchRouterHooks {
  onPause?(): void;
  /** `control` is TC_AUTOFIRE or TC_AIMASSIST. */
  onToggle?(control: number, on: boolean): void;
  /** Milliseconds of haptic buzz. The view decides whether to honour it. */
  onHaptic?(ms: number): void;
}

/**
 * Beyond this the clearance probe has saturated and cannot prove occlusion, so
 * a target further away is treated as visible rather than never shootable.
 */
const CLEARANCE_PROBE_M = 23.5;

/** Slack allowed between the clearance probe and the target distance, metres. */
const CLEARANCE_SLACK_M = 0.6;

/** Simultaneous fingers tracked. Ten is more than any hand will produce. */
const MAX_POINTERS = 10;

/** A held button that slides more than this off its centre is let go. */
const BUTTON_SLIDE_OFF = 1.9;

/**
 * Extra look gain applied to a slide-off drag, on top of `lookScale`.
 *
 * The two aiming gestures do not have the same room to work in and pretending
 * they do makes the better one useless. The look surface at 915x412 is 457 px
 * wide and 412 tall — a full flick in any direction. A trigger press, by
 * contrast, starts wherever the thumb was resting, and a thumb resting on the
 * trigger is 70 px from the right edge and 70 px from the bottom: track a
 * target to the RIGHT from there and you have 70 px of glass before you run
 * out of phone. At 1:1 that is a few degrees, i.e. the one gesture that lets
 * you fire and aim with a single thumb — the whole answer to the bar's
 * weakness #9 — dies against the bezel. The slab widened where that gesture
 * may BEGIN; it did not widen the bezel.
 *
 * 1.45x is chosen to be modest rather than clever: it is smaller than the
 * 3.2x the travel budget alone would justify, and it is partly cancelled again
 * by aim-assist friction (down to 0.55) exactly when a target is centred, so
 * the fast half of the gesture is the half with nothing to hit.
 */
export const FIRE_SLIDE_GAIN = 1.45;

function actionForControl(control: number): InputAction | null {
  switch (control) {
    case TC_JUMP: return InputAction.Jump;
    case TC_CROUCH: return InputAction.Crouch;
    case TC_RELOAD: return InputAction.Reload;
    default: return null;
  }
}

function discForControl(g: TouchGeom, control: number): Disc | null {
  switch (control) {
    case TC_JUMP: return g.jump;
    case TC_CROUCH: return g.crouch;
    case TC_RELOAD: return g.reload;
    case TC_BUILD: return g.build;
    case TC_SWAP: return g.swap;
    case TC_AUTOFIRE: return g.autoFire;
    case TC_AIMASSIST: return g.aimAssist;
    case TC_PAUSE: return g.pause;
    default: return null;
  }
}

export class TouchRouter {
  readonly geom: TouchGeom = createTouchGeom();
  readonly stick = new ThumbStick();
  readonly look = new DragTracker();
  readonly firePad = new FirePad();
  readonly autoFire = new AutoFire();
  readonly assistCfg: AimAssistConfig = { ...DEFAULT_AIM_ASSIST };
  readonly assistOut: AimAssistOut = createAimAssistOut();
  readonly target: TouchAimTarget = { yaw: 0, pitch: 0, dist: 0 };

  /** Aim assist on/off. On by default: it is the point of the piece. */
  aimAssistEnabled = true;
  /** Extra multiplier on every look delta, from the settings slider. */
  lookScale = 1;

  /* ---- read by the view; never written from outside ---- */
  /** True while the trigger is pulled, by the pad or by auto-fire. */
  firing = false;
  /** 0..1 assist engagement — the reticle draws this. */
  engaged = 0;
  /** True while auto-fire holds a genuine lock. */
  locked = false;
  /** Bitmask of `1 << TC_*` for every control currently held. */
  held = 0;
  /** Look multiplier currently applied by assist friction, 0..1. */
  friction = 1;
  /** Shots the look surface answered with a tap, for the view's flash. */
  tapShots = 0;

  private readonly sink: TouchSink;
  private readonly hooks: TouchRouterHooks;
  private readonly ptrId = new Int32Array(MAX_POINTERS).fill(-1);
  private readonly ptrCtl = new Uint8Array(MAX_POINTERS);
  private dragPx = 0;
  private lastFiring = false;

  constructor(sink: TouchSink, hooks: TouchRouterHooks = {}) {
    this.sink = sink;
    this.hooks = hooks;
    this.stick.config.radius = this.geom.stickTravel || DEFAULT_STICK.radius;
  }

  get autoFireEnabled(): boolean { return this.autoFire.enabled; }
  set autoFireEnabled(on: boolean) {
    this.autoFire.enabled = on;
    if (!on) this.autoFire.reset();
    this.syncFire();
  }

  /** Re-solve the layout for a viewport. Call on resize/rotate only. */
  resize(vw: number, vh: number, opts: Partial<TouchLayoutOptions> = {}): TouchGeom {
    const g = solveTouchLayout(vw, vh, opts, this.geom);
    this.stick.config.radius = g.stickTravel;
    this.stick.config.deadZone = opts.deadZone ?? DEFAULT_STICK.deadZone;
    // The detent the maths latches on and the ring the pad draws are the same
    // number by construction, so a drawn sprint threshold can never lie.
    this.stick.config.detent = opts.detent ?? DEFAULT_STICK.detent;
    this.stick.setHome(
      g.stickHome.x, g.stickHome.y,
      g.stickBounds.x0, g.stickBounds.y0, g.stickBounds.x1, g.stickBounds.y1,
    );
    return g;
  }

  /* -------------------------------------------------------------------- *
   * Pointers
   * -------------------------------------------------------------------- */

  /**
   * Route a press. Returns the control it was given to, or `TC_NONE` when the
   * press was refused (a second finger in a zone that is already owned — on
   * glass that is a palm, not an intent).
   */
  down(pointerId: number, x: number, y: number, nowMs: number): number {
    if (this.slotOf(pointerId) >= 0) return TC_NONE;
    let control = hitTest(this.geom, x, y);

    if (control === TC_STICK && this.stick.active) return TC_NONE;
    if (control === TC_LOOK && this.look.active) return TC_NONE;
    if (control === TC_FIRE && this.firePad.active) return TC_NONE;

    switch (control) {
      case TC_STICK:
        this.stick.begin(pointerId, x, y);
        this.pushStick();
        break;
      case TC_FIRE:
        this.firePad.begin(pointerId, x, y, nowMs);
        this.hooks.onHaptic?.(8);
        this.syncFire();
        break;
      case TC_LOOK:
        this.look.begin(pointerId, x, y, nowMs);
        break;
      case TC_PAUSE:
        this.hooks.onPause?.();
        break;
      case TC_AUTOFIRE:
        this.autoFireEnabled = !this.autoFire.enabled;
        this.hooks.onToggle?.(TC_AUTOFIRE, this.autoFire.enabled);
        this.hooks.onHaptic?.(12);
        break;
      case TC_AIMASSIST:
        this.aimAssistEnabled = !this.aimAssistEnabled;
        if (!this.aimAssistEnabled) { this.friction = 1; this.engaged = 0; }
        this.hooks.onToggle?.(TC_AIMASSIST, this.aimAssistEnabled);
        this.hooks.onHaptic?.(12);
        break;
      case TC_BUILD:
        this.sink.tap(InputAction.BuildMode);
        this.hooks.onHaptic?.(8);
        break;
      case TC_SWAP:
        this.sink.tap(InputAction.NextWeapon);
        this.hooks.onHaptic?.(8);
        break;
      default: {
        const action = actionForControl(control);
        if (action !== null) {
          this.sink.setButton(action, true);
          this.hooks.onHaptic?.(6);
        } else {
          control = TC_NONE;
        }
        break;
      }
    }

    if (control !== TC_NONE) {
      this.claim(pointerId, control);
      if (control !== TC_LOOK && control !== TC_STICK) this.held |= 1 << control;
    }
    return control;
  }

  /** Route a move. Returns the control that consumed it. */
  move(pointerId: number, x: number, y: number): number {
    const slot = this.slotOf(pointerId);
    if (slot < 0) return TC_NONE;
    const control = this.ptrCtl[slot];

    switch (control) {
      case TC_STICK:
        this.stick.move(x, y);
        this.pushStick();
        break;
      case TC_FIRE:
        if (this.firePad.move(x, y)) {
          this.dragPx += Math.hypot(this.firePad.dx, this.firePad.dy);
          this.pushLook(this.firePad.dx * FIRE_SLIDE_GAIN, this.firePad.dy * FIRE_SLIDE_GAIN);
        }
        break;
      case TC_LOOK:
        if (this.look.move(x, y)) {
          this.dragPx += this.look.speed;
          this.pushLook(this.look.dx, this.look.dy);
        }
        break;
      default: {
        // A held glyph the thumb has rolled off. Letting go beats a stuck
        // crouch, which is the classic phone-shooter bug.
        const disc = discForControl(this.geom, control);
        if (disc !== null) {
          const r = disc.r * BUTTON_SLIDE_OFF;
          if (Math.hypot(x - disc.x, y - disc.y) > r) this.release(slot);
        }
        break;
      }
    }
    return control;
  }

  /** Route a lift. Returns the control that owned the pointer. */
  up(pointerId: number, nowMs: number): number {
    const slot = this.slotOf(pointerId);
    if (slot < 0) return TC_NONE;
    const control = this.ptrCtl[slot];

    switch (control) {
      case TC_STICK:
        this.stick.end();
        this.pushStick();
        break;
      case TC_FIRE:
        this.firePad.end(nowMs);
        this.syncFire();
        break;
      case TC_LOOK:
        // A short, still press is a shot. A drag never is — which is exactly
        // the distinction the bar does not draw.
        if (this.look.end(nowMs)) {
          this.sink.tap(InputAction.Fire);
          this.tapShots++;
          this.hooks.onHaptic?.(8);
        }
        break;
      default:
        this.releaseAction(control);
        break;
    }
    this.free(slot);
    if (control !== TC_LOOK && control !== TC_STICK) this.held &= ~(1 << control);
    return control;
  }

  /** A cancelled pointer (a system gesture stole it). Never fires anything. */
  cancel(pointerId: number): void {
    const slot = this.slotOf(pointerId);
    if (slot < 0) return;
    const control = this.ptrCtl[slot];
    switch (control) {
      case TC_STICK: this.stick.end(); this.pushStick(); break;
      case TC_FIRE: this.firePad.cancel(); this.syncFire(); break;
      case TC_LOOK: this.look.cancel(); break;
      default: this.releaseAction(control); break;
    }
    this.free(slot);
    if (control !== TC_LOOK && control !== TC_STICK) this.held &= ~(1 << control);
  }

  /** Drop every finger and every held action. Blur, pause, unmount. */
  releaseAll(): void {
    for (let i = 0; i < MAX_POINTERS; i++) {
      if (this.ptrId[i] < 0) continue;
      this.releaseAction(this.ptrCtl[i]);
      this.ptrId[i] = -1;
      this.ptrCtl[i] = TC_NONE;
    }
    this.stick.end();
    this.look.cancel();
    this.firePad.cancel();
    this.autoFire.reset();
    this.held = 0;
    this.engaged = 0;
    this.friction = 1;
    this.dragPx = 0;
    this.firing = false;
    this.lastFiring = false;
    // Fire and Sprint are not owned by any pointer — the trigger can be held by
    // auto-fire and sprint by the stick detent — so releasing the fingers is
    // not enough. Drop them by hand rather than trusting the sink's `reset` to
    // mean the same thing this class does.
    this.sink.setButton(InputAction.Fire, false);
    this.sink.setButton(InputAction.Sprint, false);
    this.sink.setMove(0, 0);
    this.sink.reset();
  }

  /* -------------------------------------------------------------------- *
   * Per-step
   * -------------------------------------------------------------------- */

  /**
   * One simulation step. `aim` may be null (menu, dead, no world yet), in which
   * case nothing assists and auto-fire lets go.
   *
   * Cost: one `nearestEnemyAim` and at most one clearance raycast per step, and
   * both are skipped unless a thumb is actually engaged. No allocation.
   */
  update(dt: number, nowMs: number, aim: TouchAimSource | null, playing: boolean): void {
    this.firePad.tick(nowMs);

    const engagedThumb = this.look.active || this.firePad.active;
    const wantAssist = playing && aim !== null && this.aimAssistEnabled && engagedThumb;
    const wantAuto = playing && aim !== null && this.autoFire.enabled;

    this.assistOut.yaw = 0;
    this.assistOut.pitch = 0;
    this.assistOut.friction = 1;
    this.assistOut.engaged = 0;

    if (aim !== null && playing && (wantAssist || wantAuto)) {
      const has = aim.nearestEnemyAim(this.target);
      if (has) {
        const err = Math.hypot(this.target.yaw, this.target.pitch);
        if (wantAssist) {
          aimAssist(
            this.target.yaw, this.target.pitch, this.target.dist,
            this.dragPx, dt, this.assistCfg, this.assistOut,
          );
          if (this.assistOut.yaw !== 0 || this.assistOut.pitch !== 0) {
            aim.addLookRadians(this.assistOut.yaw, this.assistOut.pitch);
          }
        }
        if (wantAuto) {
          // The clearance probe saturates; past that it cannot prove occlusion,
          // so a distant target counts as visible rather than never shootable.
          const clear = aim.viewClearance();
          const need = Math.min(this.target.dist, CLEARANCE_PROBE_M);
          const los = clear + CLEARANCE_SLACK_M >= need;
          this.autoFire.update(true, err, this.target.dist, los, nowMs);
        }
      } else if (wantAuto) {
        this.autoFire.update(false, Math.PI, Infinity, false, nowMs);
      }
    } else if (!wantAuto) {
      this.autoFire.reset();
    }

    this.engaged = this.assistOut.engaged;
    this.friction = this.assistOut.friction;
    this.locked = this.autoFire.locked;
    this.dragPx = 0;
    this.syncFire();
  }

  /* -------------------------------------------------------------------- *
   * Internals
   * -------------------------------------------------------------------- */

  private pushStick(): void {
    const s = this.stick.sample;
    this.sink.setMove(s.x, s.z);
    this.sink.setButton(InputAction.Sprint, s.sprint);
  }

  private pushLook(dx: number, dy: number): void {
    const k = this.friction * this.lookScale;
    if (k === 0) return;
    this.sink.addLook(dx * k, dy * k);
  }

  private syncFire(): void {
    const on = this.firePad.firing || this.autoFire.firing;
    // Re-assert every step while the trigger is DOWN, and write once when it
    // goes up. A window blur makes `InputManager.releaseAll()` clear the held
    // state behind this class's back; a purely change-gated write would then
    // never put it back and the player would be holding a dead trigger. The
    // up edge stays gated, so a still frame writes nothing.
    if (on || on !== this.lastFiring) this.sink.setButton(InputAction.Fire, on);
    this.firing = on;
    this.lastFiring = on;
  }

  private releaseAction(control: number): void {
    const action = actionForControl(control);
    if (action !== null) this.sink.setButton(action, false);
  }

  private release(slot: number): void {
    const control = this.ptrCtl[slot];
    this.releaseAction(control);
    this.held &= ~(1 << control);
    this.free(slot);
  }

  private slotOf(pointerId: number): number {
    for (let i = 0; i < MAX_POINTERS; i++) if (this.ptrId[i] === pointerId) return i;
    return -1;
  }

  private claim(pointerId: number, control: number): void {
    for (let i = 0; i < MAX_POINTERS; i++) {
      if (this.ptrId[i] < 0) { this.ptrId[i] = pointerId; this.ptrCtl[i] = control; return; }
    }
  }

  private free(slot: number): void {
    this.ptrId[slot] = -1;
    this.ptrCtl[slot] = TC_NONE;
  }
}
