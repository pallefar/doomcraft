/**
 * DOOMCRAFT — the camera rig.
 *
 * ref/BAR.md weakness #2, measured not guessed: across 1.2 s of continuous
 * mouselook in the bar's own capture the held weapon does not move ONE PIXEL.
 * No bob, no sway, no kick, no shake. That is the open goal, and this file is
 * the half of it that lives in the camera rather than the viewmodel.
 *
 * What it produces every frame:
 *   - aim angles from mouse / touch / gamepad look input, pitch-clamped
 *   - additive weapon RECOIL that decays back to your aim
 *   - view BOB whose amplitude and rate track ground speed
 *   - a spring LANDING DIP scaled by impact speed
 *   - overlapping SCREEN SHAKE, trauma-style, consumed from the weapon table
 *   - an FOV that widens with sprint and punches on a heavy shot
 *
 * It never imports three. `applyTo` takes anything shaped like a
 * PerspectiveCamera, which `THREE.PerspectiveCamera` structurally is — that
 * keeps the rig unit-testable in node and keeps renderer ownership clean.
 *
 * Allocation: none after construction.
 */

import {
  FOV_DEFAULT, FOV_MIN, FOV_MAX, FOV_SPRINT_BONUS, NEAR_PLANE, FAR_PLANE,
  MOUSE_RADIANS_PER_PIXEL, TOUCH_RADIANS_PER_PIXEL, PITCH_LIMIT,
  SENSITIVITY_MIN, SENSITIVITY_MAX,
  VIEW_BOB_AMPLITUDE, VIEW_BOB_HZ, LAND_DIP_MAX,
  SPEED_RUN, SPEED_SPRINT, TERMINAL_VELOCITY,
} from '@shared/constants';
import { TAU, clampf, expDecay, anglesToForward, yawToRight, Rng } from '@shared/math';

/* ------------------------------------------------------------------------ *
 * Structural interfaces
 * ------------------------------------------------------------------------ */

/** Whatever the renderer hands us. `THREE.PerspectiveCamera` satisfies this. */
export interface CameraTargetLike {
  position: { set(x: number, y: number, z: number): unknown };
  quaternion: { set(x: number, y: number, z: number, w: number): unknown };
  fov: number;
  near: number;
  far: number;
  updateProjectionMatrix(): void;
}

/**
 * What the camera reads off the movement state each frame.
 *
 * Structural on purpose — do not couple this to a class. The live implementor
 * is `Game.driver` (`client/src/game/game.ts`), a plain object refilled each
 * frame from `NetClient.renderPos` / `NetClient.predicted`, which is where the
 * body actually is after prediction and reconciliation.
 */
export interface CameraDriver {
  readonly pos: Float64Array;
  readonly vel: Float64Array;
  readonly eyeY: number;
  readonly horizontalSpeed: number;
  readonly onGround: boolean;
  readonly justLanded: boolean;
  readonly landImpactSpeed: number;
  readonly crouching: boolean;
  readonly sprinting: boolean;
}

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

/** Concurrent screen-shake sources. Overlapping a rocket and a hit is normal. */
const SHAKE_SLOTS = 4;
/** Shake envelope exponent: >1 front-loads the punch. */
const SHAKE_DECAY_POW = 1.7;
/** Radians of camera roll produced at full shake amplitude. */
const SHAKE_ROLL = 0.09;

/** Landing-dip spring, rad/s and damping ratio. */
const DIP_STIFFNESS = 150;
const DIP_DAMPING = 17;

/** Bob roll relative to bob amplitude. */
const BOB_ROLL_SCALE = 0.85;
/** How fast bob amplitude fades in and out, 1/s. */
const BOB_BLEND_RATE = 9;
/** Strafe lean, radians at full sideways speed. */
const STRAFE_LEAN = 0.026;
const STRAFE_LEAN_RATE = 8;

/** FOV smoothing rate, 1/s. */
const FOV_RATE = 8;

/* ------------------------------------------------------------------------ *
 * Camera
 * ------------------------------------------------------------------------ */

export class PlayerCamera {
  /* --- aim --- */
  /** Player aim, radians. Yaw follows `anglesToForward`: 0 looks -Z. */
  yaw = 0;
  pitch = 0;

  /* --- settings --- */
  sensitivity = 1;
  touchSensitivity = 1;
  invertY = false;
  /** Base FOV in degrees before sprint bonus and punch. */
  baseFov = FOV_DEFAULT;
  near = NEAR_PLANE;
  far = FAR_PLANE;
  /** 0 disables bob entirely (settings.viewBob). */
  bobScale = 1;
  /** 0..1 multiplier on every shake amplitude (settings.screenShake). */
  shakeScale = 1;

  /* --- outputs, read by the renderer and the weapon runtime --- */
  /** Final view angles: aim plus recoil. Fire along these, not `yaw`/`pitch`. */
  viewYaw = 0;
  viewPitch = 0;
  viewRoll = 0;
  /** World-space eye position after bob, dip and shake. */
  eyeX = 0; eyeY = 0; eyeZ = 0;
  /** Current vertical FOV in degrees. */
  fov = FOV_DEFAULT;

  /** Unit basis of the final view. Reused every frame — do not retain. */
  readonly forward = new Float64Array(3);
  readonly right = new Float64Array(3);
  readonly up = new Float64Array(3);

  /* --- recoil --- */
  private recoilPitch = 0;
  private recoilYaw = 0;
  private recoilRate = 9;
  /** Alternates so consecutive shots do not all kick the same way. */
  private recoilSide = 1;

  /* --- bob --- */
  private bobPhase = 0;
  private bobAmount = 0;
  private bobX = 0;
  private bobY = 0;
  private bobRoll = 0;

  /* --- landing dip --- */
  private dip = 0;
  private dipVel = 0;

  /* --- strafe lean --- */
  private lean = 0;

  /* --- fov --- */
  private fovPunch = 0;
  private fovPunchRate = 9;

  /* --- shake --- */
  private readonly shakeAmp = new Float64Array(SHAKE_SLOTS);
  private readonly shakeDur = new Float64Array(SHAKE_SLOTS);
  private readonly shakeTime = new Float64Array(SHAKE_SLOTS);
  private readonly shakeFreq = new Float64Array(SHAKE_SLOTS);
  private readonly shakePhase = new Float64Array(SHAKE_SLOTS * 3);
  private shakeX = 0; private shakeY = 0; private shakeZ = 0;
  private shakeRoll = 0;
  private readonly rng = new Rng(0x5eed1234);

  /* -------------------------------------------------------------------- *
   * Look input
   * -------------------------------------------------------------------- */

  /** Apply a look delta already converted to radians. */
  addLook(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    if (this.yaw > Math.PI) this.yaw -= TAU;
    else if (this.yaw < -Math.PI) this.yaw += TAU;
    this.pitch = clampf(this.pitch + dPitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /**
   * Apply a raw pointer delta in CSS pixels.
   *
   * Sign convention follows `anglesToForward`, where increasing yaw rotates the
   * forward vector counter-clockwise about +Y. Moving the pointer right must
   * therefore DECREASE yaw; get this backwards and the whole game plays mirrored.
   */
  addLookPixels(dx: number, dy: number, touch: boolean = false): void {
    const sens = touch
      ? TOUCH_RADIANS_PER_PIXEL * clampf(this.touchSensitivity, SENSITIVITY_MIN, SENSITIVITY_MAX)
      : MOUSE_RADIANS_PER_PIXEL * clampf(this.sensitivity, SENSITIVITY_MIN, SENSITIVITY_MAX);
    const py = this.invertY ? dy : -dy;
    this.addLook(-dx * sens, py * sens);
  }

  /** Analogue stick look: `x`/`y` in -1..1, scaled by `radiansPerSecond`. */
  addLookStick(x: number, y: number, radiansPerSecond: number, dt: number): void {
    const k = radiansPerSecond * dt;
    const py = this.invertY ? y : -y;
    this.addLook(-x * k, py * k);
  }

  setAngles(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = clampf(pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /* -------------------------------------------------------------------- *
   * Feedback the weapon runtime pushes in
   * -------------------------------------------------------------------- */

  /**
   * Weapon recoil. `pitchKick` climbs the view, `yawKick` is applied with an
   * alternating sign, and both decay exponentially at `recovery` (1/s).
   */
  addRecoil(pitchKick: number, yawKick: number, recovery: number): void {
    this.recoilPitch += pitchKick;
    this.recoilYaw += yawKick * this.recoilSide;
    this.recoilSide = -this.recoilSide;
    this.recoilRate = recovery > 0 ? recovery : 9;
  }

  /**
   * Screen shake. Amplitude is in metres of camera offset, `ms` its lifetime and
   * `frequency` its oscillation in Hz — exactly the three fields every
   * `WeaponDef` carries. Overlapping calls stack up to SHAKE_SLOTS sources; a
   * new one replaces the weakest when full, so a BFG never loses to a footstep.
   */
  addShake(amplitude: number, ms: number, frequency: number): void {
    const amp = amplitude * this.shakeScale;
    if (amp <= 0 || ms <= 0) return;
    let slot = -1;
    let weakest = Infinity;
    for (let i = 0; i < SHAKE_SLOTS; i++) {
      if (this.shakeTime[i] >= this.shakeDur[i]) { slot = i; break; }
      const remaining = this.shakeAmp[i] * (1 - this.shakeTime[i] / this.shakeDur[i]);
      if (remaining < weakest) { weakest = remaining; slot = i; }
    }
    if (slot < 0) slot = 0;
    if (this.shakeTime[slot] < this.shakeDur[slot]) {
      const remaining = this.shakeAmp[slot] * (1 - this.shakeTime[slot] / this.shakeDur[slot]);
      if (remaining > amp) return;
    }
    this.shakeAmp[slot] = amp;
    this.shakeDur[slot] = ms / 1000;
    this.shakeTime[slot] = 0;
    this.shakeFreq[slot] = frequency;
    this.shakePhase[slot * 3 + 0] = this.rng.next() * TAU;
    this.shakePhase[slot * 3 + 1] = this.rng.next() * TAU;
    this.shakePhase[slot * 3 + 2] = this.rng.next() * TAU;
  }

  /** Momentary FOV widening — a heavy shot, a teleport, a berserk pickup. */
  addFovPunch(degrees: number, recovery: number = 9): void {
    this.fovPunch += degrees;
    this.fovPunchRate = recovery > 0 ? recovery : 9;
  }

  /** Clear transient state — respawn, teleport, match start. */
  resetTransients(): void {
    this.recoilPitch = 0; this.recoilYaw = 0;
    this.bobPhase = 0; this.bobAmount = 0; this.bobX = 0; this.bobY = 0; this.bobRoll = 0;
    this.dip = 0; this.dipVel = 0;
    this.lean = 0;
    this.fovPunch = 0;
    this.shakeX = 0; this.shakeY = 0; this.shakeZ = 0; this.shakeRoll = 0;
    for (let i = 0; i < SHAKE_SLOTS; i++) { this.shakeAmp[i] = 0; this.shakeDur[i] = 0; this.shakeTime[i] = 0; }
  }

  /* -------------------------------------------------------------------- *
   * Per-frame update
   * -------------------------------------------------------------------- */

  update(dt: number, driver: CameraDriver): void {
    if (dt > 0.1) dt = 0.1;
    if (dt < 0) dt = 0;

    /* --- recoil decay --- */
    this.recoilPitch = expDecay(this.recoilPitch, 0, this.recoilRate, dt);
    this.recoilYaw = expDecay(this.recoilYaw, 0, this.recoilRate, dt);
    if (Math.abs(this.recoilPitch) < 1e-5) this.recoilPitch = 0;
    if (Math.abs(this.recoilYaw) < 1e-5) this.recoilYaw = 0;

    /* --- bob --- */
    const speed = driver.horizontalSpeed;
    const speedFrac = clampf(speed / SPEED_RUN, 0, 1.35);
    const wantBob = driver.onGround && speed > 0.6 ? speedFrac : 0;
    this.bobAmount = expDecay(this.bobAmount, wantBob, BOB_BLEND_RATE, dt);
    if (this.bobAmount > 1e-4) {
      this.bobPhase += TAU * VIEW_BOB_HZ * (0.55 + speedFrac * 0.75) * dt;
      if (this.bobPhase > TAU) this.bobPhase -= TAU;
      const amp = VIEW_BOB_AMPLITUDE * this.bobAmount * this.bobScale;
      // Vertical bobs at twice the lateral rate: one dip per footfall.
      this.bobY = -Math.abs(Math.sin(this.bobPhase)) * amp;
      this.bobX = Math.cos(this.bobPhase) * amp * 0.85;
      this.bobRoll = Math.sin(this.bobPhase) * amp * BOB_ROLL_SCALE;
    } else {
      this.bobX = 0; this.bobY = 0; this.bobRoll = 0;
    }

    /* --- landing dip --- */
    if (driver.justLanded) {
      const f = clampf(driver.landImpactSpeed / (TERMINAL_VELOCITY * 0.35), 0, 1);
      this.dipVel -= LAND_DIP_MAX * (0.35 + f * 0.65) * DIP_STIFFNESS * 0.06;
    }
    // Critically damped-ish spring back to rest.
    this.dipVel += (-this.dip * DIP_STIFFNESS - this.dipVel * DIP_DAMPING) * dt;
    this.dip += this.dipVel * dt;
    if (this.dip < -LAND_DIP_MAX) { this.dip = -LAND_DIP_MAX; if (this.dipVel < 0) this.dipVel = 0; }

    /* --- strafe lean: roll away from the direction you are sliding --- */
    let lateral = 0;
    if (speed > 0.1) {
      // right vector at the *aim* yaw, before recoil, so a kick does not roll you.
      const rx = Math.cos(this.yaw);
      const rz = -Math.sin(this.yaw);
      lateral = clampf((driver.vel[0] * rx + driver.vel[2] * rz) / SPEED_RUN, -1, 1);
    }
    this.lean = expDecay(this.lean, -lateral * STRAFE_LEAN, STRAFE_LEAN_RATE, dt);

    /* --- shake --- */
    this.shakeX = 0; this.shakeY = 0; this.shakeZ = 0; this.shakeRoll = 0;
    for (let i = 0; i < SHAKE_SLOTS; i++) {
      const dur = this.shakeDur[i];
      if (dur <= 0) continue;
      let t = this.shakeTime[i];
      if (t >= dur) continue;
      t += dt;
      this.shakeTime[i] = t;
      if (t >= dur) { this.shakeDur[i] = 0; this.shakeAmp[i] = 0; continue; }
      const k = 1 - t / dur;
      const env = this.shakeAmp[i] * Math.pow(k, SHAKE_DECAY_POW);
      const w = TAU * this.shakeFreq[i] * t;
      const p = i * 3;
      this.shakeX += Math.sin(w + this.shakePhase[p]) * env;
      this.shakeY += Math.sin(w * 1.13 + this.shakePhase[p + 1]) * env;
      this.shakeZ += Math.sin(w * 0.87 + this.shakePhase[p + 2]) * env * 0.5;
      this.shakeRoll += Math.sin(w * 0.71 + this.shakePhase[p]) * env * SHAKE_ROLL;
    }

    /* --- fov --- */
    this.fovPunch = expDecay(this.fovPunch, 0, this.fovPunchRate, dt);
    if (Math.abs(this.fovPunch) < 1e-3) this.fovPunch = 0;
    const sprintFrac = driver.sprinting
      ? clampf((speed - SPEED_RUN) / Math.max(0.001, SPEED_SPRINT - SPEED_RUN), 0, 1)
      : 0;
    const targetFov = clampf(this.baseFov, FOV_MIN, FOV_MAX) + FOV_SPRINT_BONUS * sprintFrac;
    this.fov = expDecay(this.fov, targetFov, FOV_RATE, dt) + this.fovPunch;

    /* --- final angles --- */
    this.viewYaw = this.yaw + this.recoilYaw;
    this.viewPitch = clampf(this.pitch + this.recoilPitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.viewRoll = this.bobRoll + this.shakeRoll + this.lean;

    /* --- final position --- */
    anglesToForward(this.forward, 0, this.viewYaw, this.viewPitch);
    yawToRight(this.right, 0, this.viewYaw);
    // up = right x forward
    this.up[0] = this.right[1] * this.forward[2] - this.right[2] * this.forward[1];
    this.up[1] = this.right[2] * this.forward[0] - this.right[0] * this.forward[2];
    this.up[2] = this.right[0] * this.forward[1] - this.right[1] * this.forward[0];

    const ox = this.bobX + this.shakeX;
    const oy = this.bobY + this.dip + this.shakeY;
    const oz = this.shakeZ;
    this.eyeX = driver.pos[0] + this.right[0] * ox + this.forward[0] * oz;
    this.eyeY = driver.eyeY + oy;
    this.eyeZ = driver.pos[2] + this.right[2] * ox + this.forward[2] * oz;
  }

  /** Drive a camera without a controller — the in-engine menu background. */
  updateFree(dt: number, x: number, y: number, z: number): void {
    if (dt > 0.1) dt = 0.1;
    this.recoilPitch = expDecay(this.recoilPitch, 0, this.recoilRate, dt);
    this.recoilYaw = expDecay(this.recoilYaw, 0, this.recoilRate, dt);
    this.fov = expDecay(this.fov, clampf(this.baseFov, FOV_MIN, FOV_MAX), FOV_RATE, dt);
    this.viewYaw = this.yaw + this.recoilYaw;
    this.viewPitch = clampf(this.pitch + this.recoilPitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.viewRoll = 0;
    anglesToForward(this.forward, 0, this.viewYaw, this.viewPitch);
    yawToRight(this.right, 0, this.viewYaw);
    this.up[0] = this.right[1] * this.forward[2] - this.right[2] * this.forward[1];
    this.up[1] = this.right[2] * this.forward[0] - this.right[0] * this.forward[2];
    this.up[2] = this.right[0] * this.forward[1] - this.right[1] * this.forward[0];
    this.eyeX = x; this.eyeY = y; this.eyeZ = z;
  }

  /* -------------------------------------------------------------------- *
   * Output
   * -------------------------------------------------------------------- */

  /**
   * Push the rig onto a three camera. Euler order is YXZ (yaw, then pitch, then
   * roll), which is the only order that keeps the horizon level while pitching.
   */
  applyTo(target: CameraTargetLike): void {
    const hx = this.viewPitch * 0.5;
    const hy = this.viewYaw * 0.5;
    const hz = this.viewRoll * 0.5;
    const c1 = Math.cos(hx), s1 = Math.sin(hx);
    const c2 = Math.cos(hy), s2 = Math.sin(hy);
    const c3 = Math.cos(hz), s3 = Math.sin(hz);

    const qx = s1 * c2 * c3 + c1 * s2 * s3;
    const qy = c1 * s2 * c3 - s1 * c2 * s3;
    const qz = c1 * c2 * s3 - s1 * s2 * c3;
    const qw = c1 * c2 * c3 + s1 * s2 * s3;

    target.position.set(this.eyeX, this.eyeY, this.eyeZ);
    target.quaternion.set(qx, qy, qz, qw);
    if (target.fov !== this.fov || target.near !== this.near || target.far !== this.far) {
      target.fov = this.fov;
      target.near = this.near;
      target.far = this.far;
      target.updateProjectionMatrix();
    }
  }

  /** Fire direction for the weapon runtime — always the VIEW angles. */
  writeAimDirection(out: Float64Array | Float32Array, offset: number): void {
    anglesToForward(out, offset, this.viewYaw, this.viewPitch);
  }
}
