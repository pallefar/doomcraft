/**
 * DOOMCRAFT — the movement.
 *
 * This is the piece the whole game is judged on first. The bar (voxiom.io) moves
 * at Minecraft pace, ~4.3 m/s with a visible acceleration ramp and a 0.6 m step
 * that stalls you on every ledge (ref/BAR.md weakness #1). Doomcraft is Quake
 * physics wearing a voxel skin:
 *
 *   - 9.5 m/s base, 12.6 sprinting, reached in ~0.10 s. No felt ramp.
 *   - Zero air friction and Quake projection-capped air acceleration, so
 *     STRAFE JUMPING WORKS: hold a strafe key, turn into it, and you leave
 *     ground speed behind. Nothing else in this genre lets you do that.
 *   - CPM-style air control on pure-forward input, so a mid-air course change
 *     is crisp instead of a floating drift.
 *   - 1.05 m auto step-up: you run up a full block without touching jump.
 *   - No fall damage by default. Height is a route, not a punishment.
 *
 * Every collision query goes through the SHARED `moveAABB` / `isGrounded`, and
 * the substep schedule is a pure function of `dt`, so the server running the
 * same input sequence lands on the same position bit for bit. Do not fork this
 * logic; parameterise it.
 *
 * Allocation: none after construction.
 */

import {
  GRAVITY, TERMINAL_VELOCITY,
  SPEED_RUN, SPEED_SPRINT, SPEED_CROUCH, SPEED_SWIM, SPEED_AIR_MAX,
  ACCEL_GROUND, ACCEL_AIR, FRICTION_GROUND, AIR_CONTROL,
  JUMP_VELOCITY, JUMP_COOLDOWN_MS, COYOTE_TIME_MS, JUMP_BUFFER_MS, STEP_HEIGHT,
  WATER_GRAVITY_SCALE, WATER_DRAG, WATER_JUMP_VELOCITY, SWIM_UP_SPEED,
  FALL_DAMAGE_MIN_SPEED, FALL_DAMAGE_PER_MPS, FALL_DAMAGE_MAX,
  PLAYER_HALF_WIDTH, PLAYER_HEIGHT, PLAYER_CROUCH_HEIGHT,
  PLAYER_EYE_HEIGHT, PLAYER_EYE_HEIGHT_CROUCH,
  MAX_SUBSTEP_DT, MAX_FRAME_DT,
  BREATH_SECONDS, DROWN_DAMAGE_PER_SEC,
  CHUNK_HEIGHT,
} from '@shared/constants';
import {
  BLOCK_LIQUID, BLOCK_DAMAGE, BlockId,
} from '@shared/blocks';
import {
  moveAABB, isGrounded, aabbHitsSolid, expDecay, clampf,
  HIT_NY, HIT_STEPPED,
  type SolidAt,
} from '@shared/math';
import {
  PS_ON_GROUND, PS_CROUCHING, PS_SPRINTING, PS_IN_WATER, PS_DEAD,
} from '@shared/protocol';

/* ------------------------------------------------------------------------ *
 * Input frame
 * ------------------------------------------------------------------------ */

/**
 * The movement half of an input frame. `input.ts` produces it and the protocol
 * carries it, so keep the field meanings identical to `InputCommand`:
 * `moveX` +1 is right, `moveZ` +1 is forward, yaw 0 looks down -Z.
 */
export interface MoveInput {
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  crouch: boolean;
  sprint: boolean;
}

export function createMoveInput(): MoveInput {
  return { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, jump: false, crouch: false, sprint: false };
}

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

export interface ControllerConfig {
  /** Off by default. Doom does not punish height and neither do we. */
  fallDamage: boolean;
  /** Holding jump re-jumps the instant you touch down. */
  autoBhop: boolean;
  /** Auto step-up height. 0 disables it. */
  stepHeight: number;
  gravity: number;
  /** Extra impulse multiplier for explosive self-knockback (rocket jumps). */
  knockbackScale: number;
}

export const DEFAULT_CONTROLLER_CONFIG: Readonly<ControllerConfig> = Object.freeze({
  fallDamage: false,
  autoBhop: true,
  stepHeight: STEP_HEIGHT,
  gravity: GRAVITY,
  knockbackScale: 1,
});

/** Below this horizontal speed ground friction uses a floor value, so you stop crisply. */
const STOP_SPEED = 2.6;

/**
 * Ground acceleration is expressed PER UNIT OF WISH SPEED (the Quake form).
 *
 * This matters and it is easy to get wrong. Friction removes `speed * FRICTION_GROUND`
 * per second, which at SPEED_RUN is 9.5 * 16 = 152 m/s^2. A flat ACCEL_GROUND of
 * 95 m/s^2 loses that fight and the player tops out at 5.9 m/s — 38% under the
 * headline number, and the single most damaging bug this file could ship.
 * Scaling acceleration by wish speed makes the balance hold at every speed:
 * ground 190 vs 152 needed, sprint 252 vs 202, crouch 84 vs 67. From a standstill
 * it is 190 m/s^2, i.e. full speed in 0.05 s — no felt ramp, which is the point.
 */
const GROUND_ACCEL_PER_SPEED = (ACCEL_GROUND * 2) / SPEED_RUN;   // 20 s^-1
/** Swim acceleration, flat. Water drag, not this, sets the top speed. */
const SWIM_ACCEL = ACCEL_GROUND * 0.55;
/**
 * Ceiling on speed *gained* from air strafing. Momentum already above it (a
 * rocket jump) is preserved and can still be steered; it just cannot grow.
 * 1.5x sprint keeps strafe jumping worth learning without outrunning streaming.
 */
const AIR_SPEED_CAP = SPEED_SPRINT * 1.5;
/** CPMA air-control gain. Multiplied by AIR_CONTROL (0.55) -> ~6.4 rad/s of redirect. */
const AIR_CONTROL_GAIN = 110;
/** Rate the camera catches up after an auto step-up, 1/s. */
const STEP_SMOOTH_RATE = 14;
/** Rate the eye height follows a crouch transition, 1/s. */
const EYE_SMOOTH_RATE = 16;
/** Extra drag multiplier while swimming in lava. */
const LAVA_DRAG_SCALE = 1.75;

/** Number of doubles `writeState` / `readState` move. */
export const PLAYER_STATE_FLOATS = 13;

/* ------------------------------------------------------------------------ *
 * Controller
 * ------------------------------------------------------------------------ */

export class PlayerController {
  readonly config: ControllerConfig;

  /** Feet centre: x/z are the AABB centre, y is the bottom plane. */
  readonly pos = new Float64Array(3);
  readonly vel = new Float64Array(3);

  yaw = 0;
  pitch = 0;

  onGround = false;
  crouching = false;
  sprinting = false;
  /** Feet are inside a liquid. */
  inWater = false;
  inLava = false;
  /** Eye is inside a liquid: this is what starts the drown timer. */
  headSubmerged = false;
  dead = false;

  /** Current collision height — shrinks while crouched. */
  height = PLAYER_HEIGHT;
  /** Smoothed camera eye offset above `pos[1]`. */
  eyeHeight = PLAYER_EYE_HEIGHT;
  /** Metres the camera trails behind an auto step-up. Subtract from eye Y. */
  stepOffset = 0;

  /** Seconds of air left. */
  breath = BREATH_SECONDS;
  /** Damage accrued from lava / drowning since the caller last drained it. */
  envDamage = 0;
  /** Fall damage produced by the last landing, 0 when `config.fallDamage` is false. */
  fallDamage = 0;

  /** True for exactly one `step` when a jump left the ground. */
  justJumped = false;
  /** True for exactly one `step` when the feet hit the ground. */
  justLanded = false;
  /** Downward speed at the moment of the last landing, m/s. */
  landImpactSpeed = 0;
  /** True while the last `step` auto-stepped over a ledge. */
  steppedUp = false;

  /** Horizontal speed after the last `step`, m/s. Drives view bob and FOV. */
  horizontalSpeed = 0;

  private jumpBufferMs = 0;
  private coyoteMs = 0;
  private jumpCooldownMs = 0;
  private wasOnGround = false;
  private jumpHeld = false;
  private lastFallSpeed = 0;

  private readonly solid: SolidAt;
  private readonly blockAt: (x: number, y: number, z: number) => number;

  constructor(
    solid: SolidAt,
    blockAt: (x: number, y: number, z: number) => number,
    config?: Partial<ControllerConfig>,
  ) {
    this.solid = solid;
    this.blockAt = blockAt;
    this.config = { ...DEFAULT_CONTROLLER_CONFIG, ...(config ?? {}) };
  }

  /* -------------------------------------------------------------------- *
   * State plumbing
   * -------------------------------------------------------------------- */

  teleport(x: number, y: number, z: number): void {
    this.pos[0] = x; this.pos[1] = y; this.pos[2] = z;
    this.vel[0] = 0; this.vel[1] = 0; this.vel[2] = 0;
    this.onGround = false;
    this.wasOnGround = false;
    this.stepOffset = 0;
    this.crouching = false;
    this.height = PLAYER_HEIGHT;
    this.eyeHeight = PLAYER_EYE_HEIGHT;
    this.breath = BREATH_SECONDS;
    this.envDamage = 0;
    this.fallDamage = 0;
    this.jumpBufferMs = 0;
    this.coyoteMs = 0;
    this.jumpCooldownMs = 0;
    this.jumpHeld = false;
    this.lastFallSpeed = 0;
    this.horizontalSpeed = 0;
    this.justJumped = false;
    this.justLanded = false;
    this.landImpactSpeed = 0;
    this.steppedUp = false;
  }

  /** Add a velocity impulse — knockback, rocket jump, jump pad. */
  applyImpulse(x: number, y: number, z: number): void {
    const s = this.config.knockbackScale;
    this.vel[0] += x * s;
    this.vel[1] += y * s;
    this.vel[2] += z * s;
    if (y > 0.05) {
      this.onGround = false;
      this.coyoteMs = 0;
    }
  }

  /** Eye position Y for the camera, step-smoothed. */
  get eyeY(): number { return this.pos[1] + this.eyeHeight - this.stepOffset; }

  /** PS_* bits for the snapshot encoder. */
  stateBits(): number {
    let b = 0;
    if (this.onGround) b |= PS_ON_GROUND;
    if (this.crouching) b |= PS_CROUCHING;
    if (this.sprinting) b |= PS_SPRINTING;
    if (this.inWater || this.inLava) b |= PS_IN_WATER;
    if (this.dead) b |= PS_DEAD;
    return b;
  }

  /** Consume accumulated environment damage. */
  drainEnvDamage(): number {
    const d = this.envDamage;
    this.envDamage = 0;
    return d;
  }

  /** Serialise for the prediction ring buffer. Writes PLAYER_STATE_FLOATS doubles. */
  writeState(out: Float64Array, offset: number): void {
    out[offset + 0] = this.pos[0];
    out[offset + 1] = this.pos[1];
    out[offset + 2] = this.pos[2];
    out[offset + 3] = this.vel[0];
    out[offset + 4] = this.vel[1];
    out[offset + 5] = this.vel[2];
    out[offset + 6] = this.onGround ? 1 : 0;
    out[offset + 7] = this.crouching ? 1 : 0;
    out[offset + 8] = this.height;
    out[offset + 9] = this.jumpBufferMs;
    out[offset + 10] = this.coyoteMs;
    out[offset + 11] = this.jumpCooldownMs;
    out[offset + 12] = this.jumpHeld ? 1 : 0;
  }

  /** Restore from the prediction ring buffer. */
  readState(src: Float64Array, offset: number): void {
    this.pos[0] = src[offset + 0];
    this.pos[1] = src[offset + 1];
    this.pos[2] = src[offset + 2];
    this.vel[0] = src[offset + 3];
    this.vel[1] = src[offset + 4];
    this.vel[2] = src[offset + 5];
    this.onGround = src[offset + 6] !== 0;
    this.crouching = src[offset + 7] !== 0;
    this.height = src[offset + 8];
    this.jumpBufferMs = src[offset + 9];
    this.coyoteMs = src[offset + 10];
    this.jumpCooldownMs = src[offset + 11];
    this.jumpHeld = src[offset + 12] !== 0;
    this.wasOnGround = this.onGround;
  }

  /* -------------------------------------------------------------------- *
   * The step
   * -------------------------------------------------------------------- */

  /**
   * Advance by `dt` seconds. Deterministic: the substep count is
   * `ceil(min(dt, MAX_FRAME_DT) / MAX_SUBSTEP_DT)`, so replaying the same
   * (input, dt) sequence reproduces the same state exactly.
   */
  step(input: MoveInput, dt: number): void {
    this.justJumped = false;
    this.justLanded = false;
    this.steppedUp = false;
    this.fallDamage = 0;

    let remaining = dt;
    if (remaining > MAX_FRAME_DT) remaining = MAX_FRAME_DT;
    if (remaining <= 0) { this.finishFrame(0); return; }

    let steps = Math.ceil(remaining / MAX_SUBSTEP_DT);
    if (steps < 1) steps = 1;
    if (steps > 32) steps = 32;
    const sub = remaining / steps;

    this.yaw = input.yaw;
    this.pitch = input.pitch;

    for (let i = 0; i < steps; i++) this.substep(input, sub);
    this.finishFrame(remaining);
  }

  private finishFrame(dt: number): void {
    const vx = this.vel[0], vz = this.vel[2];
    this.horizontalSpeed = Math.sqrt(vx * vx + vz * vz);
    if (dt > 0) {
      this.stepOffset = expDecay(this.stepOffset, 0, STEP_SMOOTH_RATE, dt);
      if (this.stepOffset < 1e-4) this.stepOffset = 0;
      const targetEye = this.crouching ? PLAYER_EYE_HEIGHT_CROUCH : PLAYER_EYE_HEIGHT;
      this.eyeHeight = expDecay(this.eyeHeight, targetEye, EYE_SMOOTH_RATE, dt);
    }
  }

  private substep(input: MoveInput, dt: number): void {
    const dtMs = dt * 1000;
    const pos = this.pos;
    const vel = this.vel;
    const solid = this.solid;

    /* --- liquids -------------------------------------------------------- */
    this.sampleLiquids(dt);

    /* --- crouch --------------------------------------------------------- */
    const wantCrouch = input.crouch;
    if (wantCrouch) {
      this.crouching = true;
      this.height = PLAYER_CROUCH_HEIGHT;
    } else if (this.crouching) {
      if (!aabbHitsSolid(pos[0], pos[1], pos[2], PLAYER_HALF_WIDTH, PLAYER_HEIGHT, solid)) {
        this.crouching = false;
        this.height = PLAYER_HEIGHT;
      }
    }

    /* --- ground state --------------------------------------------------- */
    const grounded = vel[1] <= 0.0001 && isGrounded(pos, PLAYER_HALF_WIDTH, 0.02, solid);
    this.onGround = grounded;
    if (grounded) this.coyoteMs = COYOTE_TIME_MS;
    else if (this.coyoteMs > 0) this.coyoteMs -= dtMs;
    if (this.jumpCooldownMs > 0) this.jumpCooldownMs -= dtMs;

    if (grounded && !this.wasOnGround) {
      this.justLanded = true;
      this.landImpactSpeed = -this.lastFallSpeed;
      if (this.config.fallDamage && this.landImpactSpeed > FALL_DAMAGE_MIN_SPEED && !this.inWater) {
        const d = (this.landImpactSpeed - FALL_DAMAGE_MIN_SPEED) * FALL_DAMAGE_PER_MPS;
        this.fallDamage += d > FALL_DAMAGE_MAX ? FALL_DAMAGE_MAX : d;
      }
      this.lastFallSpeed = 0;
    }
    this.wasOnGround = grounded;

    /* --- wish direction ------------------------------------------------- */
    let mx = clampf(input.moveX, -1, 1);
    let mz = clampf(input.moveZ, -1, 1);
    let mag = Math.sqrt(mx * mx + mz * mz);
    let wishX = 0, wishZ = 0;
    if (mag > 1e-4) {
      const inv = 1 / mag;
      // forward = (-sin yaw, 0, -cos yaw); right = (cos yaw, 0, -sin yaw)
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      wishX = (-sy * mz + cy * mx) * inv;
      wishZ = (-cy * mz - sy * mx) * inv;
      if (mag > 1) mag = 1;
    } else {
      mag = 0;
    }

    /* --- speed target --------------------------------------------------- */
    const swimming = this.inWater || this.inLava;
    this.sprinting = !swimming && !this.crouching && input.sprint && mz > 0.1;
    let wishSpeed: number;
    if (swimming) wishSpeed = SPEED_SWIM;
    else if (this.crouching) wishSpeed = SPEED_CROUCH;
    else if (input.sprint && mz > 0.1 && !this.crouching) wishSpeed = SPEED_SPRINT;
    else wishSpeed = SPEED_RUN;
    wishSpeed *= mag;

    /* --- jump ----------------------------------------------------------- */
    if (input.jump) {
      // Auto-bhop keeps the buffer topped up so a held jump re-fires the instant
      // you touch down; without it only the press edge arms it.
      if (this.config.autoBhop || !this.jumpHeld) this.jumpBufferMs = JUMP_BUFFER_MS;
      else if (this.jumpBufferMs > 0) this.jumpBufferMs -= dtMs;
    } else if (this.jumpBufferMs > 0) {
      this.jumpBufferMs -= dtMs;
    }
    this.jumpHeld = input.jump;

    let jumpedThisStep = false;
    if (this.jumpBufferMs > 0 && this.jumpCooldownMs <= 0) {
      if (swimming) {
        if (!this.headSubmerged) {
          vel[1] = WATER_JUMP_VELOCITY;
          this.jumpCooldownMs = JUMP_COOLDOWN_MS;
          this.jumpBufferMs = 0;
          jumpedThisStep = true;
          this.justJumped = true;
        }
      } else if (grounded || this.coyoteMs > 0) {
        vel[1] = JUMP_VELOCITY;
        this.onGround = false;
        this.wasOnGround = false;
        this.coyoteMs = 0;
        this.jumpBufferMs = 0;
        this.jumpCooldownMs = JUMP_COOLDOWN_MS;
        jumpedThisStep = true;
        this.justJumped = true;
      }
    }

    /* --- horizontal acceleration --------------------------------------- */
    if (swimming) {
      accelerate(vel, wishX, wishZ, wishSpeed, SWIM_ACCEL, dt);
      const drag = WATER_DRAG * (this.inLava ? LAVA_DRAG_SCALE : 1);
      const damp = 1 / (1 + drag * dt);
      vel[0] *= damp; vel[2] *= damp;
      // Swim vertical: jump rises, crouch sinks, otherwise slow buoyant sink.
      if (input.jump && this.headSubmerged) {
        vel[1] += (SWIM_UP_SPEED - vel[1]) * Math.min(1, 8 * dt);
      } else if (input.crouch) {
        vel[1] += (-SWIM_UP_SPEED - vel[1]) * Math.min(1, 8 * dt);
      } else {
        vel[1] -= this.config.gravity * WATER_GRAVITY_SCALE * dt;
        vel[1] *= damp;
      }
    } else if (this.onGround && !jumpedThisStep) {
      // Friction first, Quake order. Skipped on the jump frame so bunny hops
      // carry their speed instead of being shaved every touchdown.
      applyFriction(vel, FRICTION_GROUND, dt);
      accelerate(vel, wishX, wishZ, wishSpeed, GROUND_ACCEL_PER_SPEED * wishSpeed, dt);
      vel[1] -= this.config.gravity * dt;
    } else {
      // Airborne. FRICTION_AIR is 0 by contract, so nothing bleeds speed and
      // the projection cap below is what makes strafe jumping pay.
      const airWish = wishSpeed > SPEED_AIR_MAX ? SPEED_AIR_MAX : wishSpeed;
      const hs0 = Math.sqrt(vel[0] * vel[0] + vel[2] * vel[2]);
      accelerate(vel, wishX, wishZ, airWish, ACCEL_AIR, dt);
      const hs1 = Math.sqrt(vel[0] * vel[0] + vel[2] * vel[2]);
      if (hs1 > AIR_SPEED_CAP && hs1 > hs0) {
        // Keep the new heading, discard the speed above the cap.
        const target = hs0 > AIR_SPEED_CAP ? hs0 : AIR_SPEED_CAP;
        const k = target / hs1;
        vel[0] *= k; vel[2] *= k;
      }
      if (mag > 1e-4 && Math.abs(mx) < 1e-3 && mz > 0) {
        airControl(vel, wishX, wishZ, AIR_CONTROL * AIR_CONTROL_GAIN, dt);
      }
      vel[1] -= this.config.gravity * dt;
    }

    if (vel[1] < -TERMINAL_VELOCITY) vel[1] = -TERMINAL_VELOCITY;
    if (vel[1] < 0) this.lastFallSpeed = vel[1];

    /* --- sweep ---------------------------------------------------------- */
    const beforeY = pos[1];
    const flags = moveAABB(
      pos, vel,
      PLAYER_HALF_WIDTH, this.height,
      dt, this.config.stepHeight, solid,
    );

    if ((flags & HIT_STEPPED) !== 0) {
      this.steppedUp = true;
      const rise = pos[1] - beforeY;
      if (rise > 0) {
        this.stepOffset += rise;
        if (this.stepOffset > this.config.stepHeight) this.stepOffset = this.config.stepHeight;
      }
    }
    if ((flags & HIT_NY) !== 0) {
      this.onGround = true;
      if (!this.wasOnGround) {
        this.justLanded = true;
        this.landImpactSpeed = -this.lastFallSpeed;
        if (this.config.fallDamage && this.landImpactSpeed > FALL_DAMAGE_MIN_SPEED && !this.inWater) {
          const d = (this.landImpactSpeed - FALL_DAMAGE_MIN_SPEED) * FALL_DAMAGE_PER_MPS;
          this.fallDamage += d > FALL_DAMAGE_MAX ? FALL_DAMAGE_MAX : d;
        }
        this.lastFallSpeed = 0;
      }
      this.wasOnGround = true;
    }

    // Hard clamp: the world roof is not a wall, so stop the box leaving it.
    if (pos[1] > CHUNK_HEIGHT - this.height) {
      pos[1] = CHUNK_HEIGHT - this.height;
      if (vel[1] > 0) vel[1] = 0;
    }
  }

  /* -------------------------------------------------------------------- *
   * Liquids and environment damage
   * -------------------------------------------------------------------- */

  private sampleLiquids(dt: number): void {
    const pos = this.pos;
    const bx = Math.floor(pos[0]);
    const bz = Math.floor(pos[2]);
    const feet = this.blockAt(bx, Math.floor(pos[1] + 0.1), bz);
    const eyeBlockY = Math.floor(pos[1] + this.eyeHeight);
    const eye = this.blockAt(bx, eyeBlockY, bz);

    const feetLiquid = BLOCK_LIQUID[feet] === 1;
    this.inWater = feetLiquid && feet === BlockId.WATER;
    this.inLava = feetLiquid && feet === BlockId.LAVA;
    this.headSubmerged = BLOCK_LIQUID[eye] === 1;

    // Contact damage: the worst damaging block the body overlaps.
    let worst = 0;
    const x0 = Math.floor(pos[0] - PLAYER_HALF_WIDTH + 1e-3);
    const x1 = Math.floor(pos[0] + PLAYER_HALF_WIDTH - 1e-3);
    const z0 = Math.floor(pos[2] - PLAYER_HALF_WIDTH + 1e-3);
    const z1 = Math.floor(pos[2] + PLAYER_HALF_WIDTH - 1e-3);
    const y0 = Math.floor(pos[1] + 1e-3);
    const y1 = Math.floor(pos[1] + this.height - 1e-3);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const d = BLOCK_DAMAGE[this.blockAt(x, y, z)];
          if (d > worst) worst = d;
        }
      }
    }
    if (worst > 0) this.envDamage += worst * dt;

    // Breath.
    if (this.headSubmerged && !this.inLava) {
      this.breath -= dt;
      if (this.breath < 0) {
        this.breath = 0;
        this.envDamage += DROWN_DAMAGE_PER_SEC * dt;
      }
    } else if (this.breath < BREATH_SECONDS) {
      this.breath += dt * 4;
      if (this.breath > BREATH_SECONDS) this.breath = BREATH_SECONDS;
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Free functions — exported so the server can call the identical maths
 * ------------------------------------------------------------------------ */

/**
 * Quake acceleration. The cap is on the component of velocity ALONG `wish`,
 * never on total speed — that asymmetry is the entire reason air strafing
 * accelerates you past your ground speed.
 */
export function accelerate(
  vel: Float64Array | Float32Array,
  wishX: number, wishZ: number, wishSpeed: number,
  accel: number, dt: number,
): void {
  if (wishSpeed <= 0) return;
  const current = vel[0] * wishX + vel[2] * wishZ;
  const add = wishSpeed - current;
  if (add <= 0) return;
  let a = accel * dt;
  if (a > add) a = add;
  vel[0] += wishX * a;
  vel[2] += wishZ * a;
}

/** Quake ground friction with a stop-speed floor so you halt crisply. */
export function applyFriction(
  vel: Float64Array | Float32Array,
  friction: number, dt: number,
): void {
  const speed = Math.sqrt(vel[0] * vel[0] + vel[2] * vel[2]);
  if (speed < 1e-4) { vel[0] = 0; vel[2] = 0; return; }
  const control = speed < STOP_SPEED ? STOP_SPEED : speed;
  let next = speed - control * friction * dt;
  if (next < 0) next = 0;
  const s = next / speed;
  vel[0] *= s;
  vel[2] *= s;
}

/**
 * CPMA air control: rotate the horizontal velocity toward `wish` while keeping
 * its magnitude. Only called on pure-forward input, so it never fights the
 * strafe-jump accelerator above.
 */
export function airControl(
  vel: Float64Array | Float32Array,
  wishX: number, wishZ: number,
  gain: number, dt: number,
): void {
  const speed = Math.sqrt(vel[0] * vel[0] + vel[2] * vel[2]);
  if (speed < 1e-4) return;
  const nx = vel[0] / speed;
  const nz = vel[2] / speed;
  const dot = nx * wishX + nz * wishZ;
  if (dot <= 0) return;
  const k = gain * dot * dot * dt;
  let ax = nx * speed + wishX * k;
  let az = nz * speed + wishZ * k;
  const len = Math.sqrt(ax * ax + az * az);
  if (len < 1e-6) return;
  vel[0] = (ax / len) * speed;
  vel[2] = (az / len) * speed;
}
