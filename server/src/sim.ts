/**
 * DOOMCRAFT — authoritative simulation.
 *
 * The movement kernel in here (`moveStep`) is the SAME function the client
 * calls for prediction — client/src/net/client.ts imports it. That is not a
 * convenience, it is the reason reconciliation converges: there is exactly one
 * implementation of DOOM-pace movement in the codebase.
 *
 * No node:*, no ws, no DOM: this file also runs inside the client's local
 * server Web Worker.
 */

import {
  ACCEL_AIR,
  ACCEL_GROUND,
  AIR_CONTROL,
  AMMO_MAX,
  AMMO_START,
  AMMO_TYPE_COUNT,
  ARMOR_ABSORB,
  AmmoType,
  BLOCK_DAMAGE,
  BLOCK_LIQUID,
  BLOCK_SOLID,
  BREATH_SECONDS,
  BlockAction,
  BlockId,
  COYOTE_TIME_MS,
  DEFAULT_WEAPON,
  DROWN_DAMAGE_PER_SEC,
  FALL_DAMAGE_MAX,
  FALL_DAMAGE_MIN_SPEED,
  FALL_DAMAGE_PER_MPS,
  FRICTION_GROUND,
  FireKind,
  GRAVITY,
  HEADSHOT_MULTIPLIER,
  HIT_STEPPED,
  HITSCAN_MAX_DISTANCE,
  JUMP_BUFFER_MS,
  JUMP_COOLDOWN_MS,
  JUMP_VELOCITY,
  KNOCKBACK_SCALE,
  LAG_COMP_MAX_MS,
  MAX_ARMOR,
  MAX_EDITS_PER_SECOND,
  MAX_ENTITIES,
  MAX_HEALTH,
  MAX_OVERHEAL,
  MAX_PELLETS,
  MAX_PROJECTILES,
  MONSTER_HEAD_HALF_WIDTH_FRAC,
  MONSTER_HEAD_MIN_Y_FRAC,
  PITCH_LIMIT,
  PLAYER_EYE_HEIGHT,
  PLAYER_EYE_HEIGHT_CROUCH,
  PLAYER_HALF_WIDTH,
  PLAYER_HEAD_HALF_WIDTH,
  PLAYER_HEAD_MIN_Y,
  PLAYER_HEIGHT,
  PLAYER_CROUCH_HEIGHT,
  RESPAWN_DELAY_MS,
  SELF_KNOCKBACK_SCALE,
  SPAWN_PROTECTION_MS,
  SPEED_AIR_MAX,
  SPEED_CROUCH,
  SPEED_RUN,
  SPEED_SPRINT,
  SPEED_SWIM,
  STARTING_WEAPON_MASK,
  STEP_HEIGHT,
  SWIM_UP_SPEED,
  TERMINAL_VELOCITY,
  WATER_DRAG,
  WATER_GRAVITY_SCALE,
  WEAPON_COUNT,
  WeaponId,
  aabbHitsSolid,
  ammoTypeOf,
  anglesToForward,
  clamp,
  coneSpread,
  createVoxelHit,
  getWeapon,
  grantWeapon,
  hash3i,
  nextShotSeq,
  shotSeed,
  isGrounded,
  moveAABB,
  moveTowards,
  ownsWeapon,
  rayAABB,
  raycastVoxels,
} from '@doomcraft/shared';
import {
  BTN_CROUCH,
  BTN_FIRE,
  BTN_JUMP,
  BTN_MELEE,
  BTN_RELOAD,
  BTN_SPRINT,
  DMG_ENVIRONMENT,
  DMG_FALL,
  DMG_FATAL,
  DMG_HEADSHOT,
  DMG_SELF,
  DMG_SPLASH,
  EntityType,
  KILL_ENVIRONMENT,
  KILL_HEADSHOT,
  KILL_MELEE,
  KILL_SELF,
  PS_CROUCHING,
  PS_DEAD,
  PS_FIRING,
  PS_IN_WATER,
  PS_ON_GROUND,
  PS_RELOADING,
  PS_SPRINTING,
  PS_BOT,
  RemoveReason,
  Rng,
} from '@doomcraft/shared';
import {
  applyShotSpreadOf,
  BASE_ARSENAL,
  BASE_SLOT,
  createVariantSlots,
  currentSpreadOf,
  damageAtDistanceOf,
  fireIntervalMsOf,
  knockbackImpulseOf,
  recoverSpreadOf,
  splashDamageAtOf,
  type EffectiveWeapon,
  type SessionArsenal,
  type VariantSlots,
} from '@doomcraft/shared/arsenal';
import { LEGACY_AVATAR_BY_SKIN } from '@doomcraft/shared/saves';
import type { InputCommand, SolidAt, VoxelHit } from '@doomcraft/shared';
import type { ServerWorld } from './world.js';

/* ------------------------------------------------------------------------ *
 * Edit outcomes
 * ------------------------------------------------------------------------ */

/**
 * Why a block edit was accepted or refused. Lives here rather than in world.ts
 * so that client-side prediction can import this module (and the movement
 * kernel with it) without pulling worldgen into the browser bundle.
 */
export enum EditResult {
  OK = 0,
  OUT_OF_WORLD = 1,
  OUT_OF_REACH = 2,
  RATE_LIMITED = 3,
  UNBREAKABLE = 4,
  NOT_PLACEABLE = 5,
  OCCUPIED = 6,
  BLOCKED_BY_ENTITY = 7,
  NO_CHANGE = 8,
  DEAD = 9,
}

export const EDIT_RESULT_NAMES: readonly string[] = [
  'ok', 'out-of-world', 'out-of-reach', 'rate-limited', 'unbreakable',
  'not-placeable', 'occupied', 'blocked-by-entity', 'no-change', 'dead',
];

/* ------------------------------------------------------------------------ *
 * Movement kernel — shared with client prediction
 * ------------------------------------------------------------------------ */

/** Everything `moveStep` needs from a voxel field. Both worlds satisfy it. */
export interface CollisionWorld {
  readonly solidAt: SolidAt;
  getBlock(x: number, y: number, z: number): number;
}

/**
 * The mutable half of a player that movement touches. `PlayerEntity`
 * implements it; the client's predictor allocates a bare one.
 */
export interface MoveState {
  pos: Float64Array;
  vel: Float64Array;
  yaw: number;
  pitch: number;
  height: number;
  onGround: boolean;
  crouching: boolean;
  sprinting: boolean;
  inWater: boolean;
  headUnderWater: boolean;
  jumpCooldown: number;
  coyote: number;
  jumpBuffer: number;
  /** Downward speed at the moment of the last landing, m/s. 0 when not landing. */
  landImpact: number;
  stepped: boolean;
}

export function createMoveState(): MoveState {
  return {
    pos: new Float64Array(3),
    vel: new Float64Array(3),
    yaw: 0,
    pitch: 0,
    height: PLAYER_HEIGHT,
    onGround: false,
    crouching: false,
    sprinting: false,
    inWater: false,
    headUnderWater: false,
    jumpCooldown: 0,
    coyote: 0,
    jumpBuffer: 0,
    landImpact: 0,
    stepped: false,
  };
}

export function copyMoveState(src: MoveState, dst: MoveState): void {
  dst.pos[0] = src.pos[0]; dst.pos[1] = src.pos[1]; dst.pos[2] = src.pos[2];
  dst.vel[0] = src.vel[0]; dst.vel[1] = src.vel[1]; dst.vel[2] = src.vel[2];
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  dst.height = src.height;
  dst.onGround = src.onGround;
  dst.crouching = src.crouching;
  dst.sprinting = src.sprinting;
  dst.inWater = src.inWater;
  dst.headUnderWater = src.headUnderWater;
  dst.jumpCooldown = src.jumpCooldown;
  dst.coyote = src.coyote;
  dst.jumpBuffer = src.jumpBuffer;
  dst.landImpact = src.landImpact;
  dst.stepped = src.stepped;
}

/** Eye height for a body state. */
export function eyeHeightOf(m: { crouching: boolean }): number {
  return m.crouching ? PLAYER_EYE_HEIGHT_CROUCH : PLAYER_EYE_HEIGHT;
}

const JUMP_BUFFER_S = JUMP_BUFFER_MS / 1000;
const JUMP_COOLDOWN_S = JUMP_COOLDOWN_MS / 1000;
const COYOTE_S = COYOTE_TIME_MS / 1000;

/**
 * Advance one player body by `dt` seconds. Deterministic, allocation free, and
 * bit-identical on the client and the server for the same inputs.
 *
 * Returns the HIT_* flags from `moveAABB`.
 */
export function moveStep(
  m: MoveState,
  moveX: number, moveZ: number, buttons: number,
  dt: number,
  world: CollisionWorld,
): number {
  if (dt <= 0) return 0;
  const solid = world.solidAt;
  const pos = m.pos;
  const vel = m.vel;

  /* --- stance ------------------------------------------------------- */
  const wantCrouch = (buttons & BTN_CROUCH) !== 0;
  if (wantCrouch) {
    m.crouching = true;
  } else if (m.crouching) {
    // Only stand when the full-height box fits, otherwise stay down.
    if (!aabbHitsSolid(pos[0], pos[1], pos[2], PLAYER_HALF_WIDTH, PLAYER_HEIGHT, solid)) m.crouching = false;
  }
  m.height = m.crouching ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;

  /* --- fluid -------------------------------------------------------- */
  const bx = Math.floor(pos[0]);
  const bz = Math.floor(pos[2]);
  m.inWater = BLOCK_LIQUID[world.getBlock(bx, Math.floor(pos[1] + 0.2), bz)] === 1;
  m.headUnderWater = BLOCK_LIQUID[world.getBlock(bx, Math.floor(pos[1] + eyeHeightOf(m)), bz)] === 1;

  /* --- wish direction ----------------------------------------------- */
  let wishLen = Math.sqrt(moveX * moveX + moveZ * moveZ);
  if (wishLen > 1) { moveX /= wishLen; moveZ /= wishLen; wishLen = 1; }
  const sy = Math.sin(m.yaw);
  const cy = Math.cos(m.yaw);
  const wx = cy * moveX - sy * moveZ;
  const wz = -sy * moveX - cy * moveZ;

  const sprinting = (buttons & BTN_SPRINT) !== 0 && !m.crouching && moveZ > 0.1;
  m.sprinting = sprinting;

  let target = m.inWater ? SPEED_SWIM : m.crouching ? SPEED_CROUCH : sprinting ? SPEED_SPRINT : SPEED_RUN;
  target *= wishLen;

  const grounded = m.onGround;

  /* --- horizontal acceleration -------------------------------------- */
  if (m.inWater) {
    const drag = 1 / (1 + WATER_DRAG * dt);
    vel[0] *= drag; vel[1] *= drag; vel[2] *= drag;
    accelerateToward(vel, wx, wz, target, ACCEL_GROUND * 0.5 * dt);
  } else if (grounded) {
    if (wishLen < 1e-4) {
      const sp = Math.sqrt(vel[0] * vel[0] + vel[2] * vel[2]);
      if (sp > 1e-6) {
        let ns = sp - sp * FRICTION_GROUND * dt;
        if (ns < 0.12) ns = 0;
        const k = ns / sp;
        vel[0] *= k; vel[2] *= k;
      }
    } else {
      accelerateToward(vel, wx, wz, target, ACCEL_GROUND * dt);
    }
  } else if (wishLen > 1e-4) {
    // Quake-style air acceleration: only ever ADD along the wish direction, so
    // a rocket jump keeps every metre per second it earned.
    const cur = vel[0] * wx + vel[2] * wz;
    const cap = target > SPEED_AIR_MAX * wishLen ? SPEED_AIR_MAX * wishLen : target;
    let add = cap - cur;
    if (add > 0) {
      const a = ACCEL_AIR * AIR_CONTROL * dt;
      if (a < add) add = a;
      vel[0] += wx * add;
      vel[2] += wz * add;
    }
  }

  /* --- jump / swim ---------------------------------------------------- */
  m.jumpCooldown = m.jumpCooldown > dt ? m.jumpCooldown - dt : 0;
  if ((buttons & BTN_JUMP) !== 0) m.jumpBuffer = JUMP_BUFFER_S;
  else m.jumpBuffer = m.jumpBuffer > dt ? m.jumpBuffer - dt : 0;

  let jumped = false;
  if (m.inWater) {
    if ((buttons & BTN_JUMP) !== 0) vel[1] = moveTowards(vel[1], SWIM_UP_SPEED, 34 * dt);
    else if (wantCrouch) vel[1] = moveTowards(vel[1], -SWIM_UP_SPEED, 34 * dt);
  } else if (m.jumpBuffer > 0 && m.jumpCooldown <= 0 && (grounded || m.coyote > 0)) {
    vel[1] = JUMP_VELOCITY;
    m.onGround = false;
    m.coyote = 0;
    m.jumpBuffer = 0;
    m.jumpCooldown = JUMP_COOLDOWN_S;
    jumped = true;
  }

  /* --- gravity -------------------------------------------------------- */
  if (m.inWater) {
    vel[1] -= GRAVITY * WATER_GRAVITY_SCALE * dt;
  } else if (grounded && !jumped) {
    // A light downward bias keeps the box glued to steps and ramps.
    vel[1] -= GRAVITY * 0.3 * dt;
  } else {
    vel[1] -= GRAVITY * dt;
  }
  if (vel[1] < -TERMINAL_VELOCITY) vel[1] = -TERMINAL_VELOCITY;

  /* --- integrate ------------------------------------------------------ */
  const preVy = vel[1];
  const flags = moveAABB(pos, vel, PLAYER_HALF_WIDTH, m.height, dt, STEP_HEIGHT, solid);

  const nowGrounded = vel[1] <= 1e-6 && isGrounded(pos, PLAYER_HALF_WIDTH, 0.06, solid);
  m.landImpact = 0;
  if (nowGrounded && !grounded && preVy < 0) m.landImpact = -preVy;
  m.onGround = nowGrounded;
  if (nowGrounded) m.coyote = COYOTE_S;
  else m.coyote = m.coyote > dt ? m.coyote - dt : 0;
  m.stepped = (flags & HIT_STEPPED) !== 0;
  return flags;
}

/** Move horizontal velocity toward `dir * target`, at most `maxDelta` m/s. */
function accelerateToward(vel: Float64Array, wx: number, wz: number, target: number, maxDelta: number): void {
  const tx = wx * target;
  const tz = wz * target;
  const dx = tx - vel[0];
  const dz = tz - vel[2];
  const dl = Math.sqrt(dx * dx + dz * dz);
  if (dl <= maxDelta || dl < 1e-9) {
    vel[0] = tx; vel[2] = tz;
  } else {
    const k = maxDelta / dl;
    vel[0] += dx * k;
    vel[2] += dz * k;
  }
}

/* ------------------------------------------------------------------------ *
 * Player
 * ------------------------------------------------------------------------ */

/** Frames of position history kept for lag compensation (32 ticks = 1.6 s). */
export const LAG_HISTORY = 32;

export class PlayerEntity implements MoveState {
  id = 0;
  name = '';
  skin = 0;
  /**
   * Packed appearance, uint32. The server is deliberately incurious about what
   * the bits mean — it clamps, stores and mirrors — so growing the outfit
   * roster is a client-only change.
   */
  avatar = 0;
  team = 0;
  isBot = false;
  /** False once the socket is gone but the body has not been reaped yet. */
  active = true;

  readonly pos = new Float64Array(3);
  readonly vel = new Float64Array(3);
  /**
   * Equipped variant slot per weapon — VARIANTS.md §4's `inventory.variants`
   * claim, resolved. All zeros is "no variants equipped", which is every
   * player in phase V1; the room will fill it at spawn from the profile's
   * claims checked against ITS pinned release, in the same place it already
   * resolves loadout masks.
   */
  readonly variantSlots: VariantSlots = createVariantSlots();
  yaw = 0;
  pitch = 0;
  height = PLAYER_HEIGHT;
  onGround = false;
  crouching = false;
  sprinting = false;
  inWater = false;
  headUnderWater = false;
  jumpCooldown = 0;
  coyote = 0;
  jumpBuffer = 0;
  landImpact = 0;
  stepped = false;

  health = MAX_HEALTH;
  armor = 0;
  dead = false;
  respawnAtMs = 0;
  spawnProtectUntilMs = 0;
  lastDamageMs = -1e9;
  lastAttacker = 0;
  breath = BREATH_SECONDS;
  envDamageAccum = 0;

  weapon: number = DEFAULT_WEAPON;
  weaponMask: number = STARTING_WEAPON_MASK;
  readonly mag = new Uint16Array(WEAPON_COUNT);
  readonly reserve = new Uint16Array(AMMO_TYPE_COUNT);
  heatSpread = 0;
  nextFireMs = 0;
  switchEndMs = 0;
  reloading = false;
  reloadEndMs = 0;
  spinUpMs = 0;
  firing = false;
  firePressed = false;
  shotSeq = 0;
  buildMode = false;
  buildBlock: number = BlockId.STONE;

  kills = 0;
  deaths = 0;
  streak = 0;
  bestStreak = 0;
  damageDealt = 0;
  blocksPlaced = 0;
  blocksBroken = 0;

  /** Token bucket for block edits. */
  editTokens = MAX_EDITS_PER_SECOND;
  lastEditSeq = 0;
  lastInputSeq = 0;
  /** Round-trip time the connection measured, used to size the lag rewind. */
  rttMs = 0;
  /**
   * Set by `applyInput`, cleared at the end of every tick. A player who sent
   * nothing this tick still gets integrated (see `stepTick`) so a stalled or
   * silent client cannot hang in mid-air, ignore gravity or shrug off the
   * knockback from a rocket.
   */
  hadInputThisTick = false;

  /** Ring of past positions for lag compensation. */
  readonly histTime = new Float64Array(LAG_HISTORY);
  readonly histX = new Float32Array(LAG_HISTORY);
  readonly histY = new Float32Array(LAG_HISTORY);
  readonly histZ = new Float32Array(LAG_HISTORY);
  readonly histCrouch = new Uint8Array(LAG_HISTORY);
  histCount = 0;
  histHead = 0;

  reset(): void {
    this.pos[0] = 0; this.pos[1] = 0; this.pos[2] = 0;
    this.vel[0] = 0; this.vel[1] = 0; this.vel[2] = 0;
    this.yaw = 0; this.pitch = 0;
    this.height = PLAYER_HEIGHT;
    this.onGround = false; this.crouching = false; this.sprinting = false;
    this.inWater = false; this.headUnderWater = false;
    this.jumpCooldown = 0; this.coyote = 0; this.jumpBuffer = 0;
    this.landImpact = 0; this.stepped = false;
    this.health = MAX_HEALTH; this.armor = 0;
    this.dead = false; this.respawnAtMs = 0; this.spawnProtectUntilMs = 0;
    this.lastDamageMs = -1e9; this.lastAttacker = 0;
    this.breath = BREATH_SECONDS; this.envDamageAccum = 0;
    this.weapon = DEFAULT_WEAPON;
    this.weaponMask = STARTING_WEAPON_MASK;
    this.variantSlots.fill(0);
    this.mag.fill(0);
    this.reserve.set(AMMO_START);
    // The compiled magazine, deliberately: a pooled body is being wiped and
    // has no session yet. `Simulation.spawnPlayer` refills through the room's
    // arsenal a moment later, and that is the fill a variant changes.
    for (let i = 0; i < WEAPON_COUNT; i++) {
      if (ownsWeapon(this.weaponMask, i)) this.mag[i] = getWeapon(i).magSize;
    }
    this.hadInputThisTick = false;
    // A POOLED BODY MUST NOT INHERIT THE LAST OCCUPANT'S SHOT COUNTER. It did,
    // so a recycled body carried on at seq 41 while the new player's fresh
    // client runtime started at 0 — and every cone from then on was seeded
    // from a different number on the two sides.
    this.shotSeq = 0;
    this.heatSpread = 0; this.nextFireMs = 0; this.switchEndMs = 0;
    this.reloading = false; this.reloadEndMs = 0; this.spinUpMs = 0;
    this.firing = false; this.firePressed = false;
    this.buildMode = false; this.buildBlock = BlockId.STONE;
    this.histCount = 0; this.histHead = 0;
  }

  get eyeY(): number { return this.pos[1] + eyeHeightOf(this); }

  stateBits(): number {
    let s = 0;
    if (this.onGround) s |= PS_ON_GROUND;
    if (this.crouching) s |= PS_CROUCHING;
    if (this.sprinting) s |= PS_SPRINTING;
    if (this.dead) s |= PS_DEAD;
    if (this.inWater) s |= PS_IN_WATER;
    if (this.firing) s |= PS_FIRING;
    if (this.reloading) s |= PS_RELOADING;
    if (this.isBot) s |= PS_BOT;
    return s;
  }

  /** Reserve ammo for the weapon currently held. */
  reserveFor(weapon: number): number {
    const t = ammoTypeOf(weapon);
    return t === AmmoType.NONE ? 0 : this.reserve[t];
  }

  pushHistory(timeMs: number): void {
    const i = this.histHead;
    this.histTime[i] = timeMs;
    this.histX[i] = this.pos[0];
    this.histY[i] = this.pos[1];
    this.histZ[i] = this.pos[2];
    this.histCrouch[i] = this.crouching ? 1 : 0;
    this.histHead = (i + 1) % LAG_HISTORY;
    if (this.histCount < LAG_HISTORY) this.histCount++;
  }
}

/**
 * Position of `p` as it was at `atMs` of server time, written into
 * `out[0..2]`; `out[3]` receives the body height at that moment. Returns false
 * when there is no history at all (the caller then uses the live position).
 *
 * Sampling before the oldest frame clamps to the oldest; after the newest
 * clamps to the newest. Frames are linearly interpolated, so a rewind lands on
 * the exact recorded position when `atMs` matches a recorded tick.
 */
export function sampleHistory(p: PlayerEntity, atMs: number, out: Float64Array): boolean {
  const n = p.histCount;
  if (n === 0) return false;
  const newest = (p.histHead - 1 + LAG_HISTORY) % LAG_HISTORY;
  const oldest = (p.histHead - n + LAG_HISTORY) % LAG_HISTORY;

  if (atMs >= p.histTime[newest]) {
    out[0] = p.histX[newest]; out[1] = p.histY[newest]; out[2] = p.histZ[newest];
    out[3] = p.histCrouch[newest] ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
    return true;
  }
  if (atMs <= p.histTime[oldest]) {
    out[0] = p.histX[oldest]; out[1] = p.histY[oldest]; out[2] = p.histZ[oldest];
    out[3] = p.histCrouch[oldest] ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
    return true;
  }
  // Walk back from the newest until the frame is older than the target.
  let b = newest;
  for (let k = 1; k < n; k++) {
    const a = (newest - k + LAG_HISTORY) % LAG_HISTORY;
    if (p.histTime[a] <= atMs) {
      const t0 = p.histTime[a];
      const t1 = p.histTime[b];
      const f = t1 > t0 ? (atMs - t0) / (t1 - t0) : 0;
      out[0] = p.histX[a] + (p.histX[b] - p.histX[a]) * f;
      out[1] = p.histY[a] + (p.histY[b] - p.histY[a]) * f;
      out[2] = p.histZ[a] + (p.histZ[b] - p.histZ[a]) * f;
      out[3] = (f < 0.5 ? p.histCrouch[a] : p.histCrouch[b]) ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
      return true;
    }
    b = a;
  }
  out[0] = p.histX[oldest]; out[1] = p.histY[oldest]; out[2] = p.histZ[oldest];
  out[3] = p.histCrouch[oldest] ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
  return true;
}

/* ------------------------------------------------------------------------ *
 * Entities (Doom monsters + pickups) and projectiles
 * ------------------------------------------------------------------------ */

/** Entity state bits, carried in EF_STATE. The renderer reads these. */
export const ES_MOVING = 1 << 0;
export const ES_ATTACK = 1 << 1;
export const ES_PAIN = 1 << 2;
export const ES_DEAD = 1 << 3;
export const ES_FLYING = 1 << 4;
export const ES_ALERT = 1 << 5;
export const ES_WINDUP = 1 << 6;

export interface SimDamageEvent {
  attackerId: number; victimId: number; amount: number; weaponId: number; flags: number;
  dirX: number; dirY: number; dirZ: number; healthAfter: number; armorAfter: number;
}
export interface SimKillEvent {
  killerId: number; victimId: number; weaponId: number; flags: number; killerStreak: number;
}

function makeDamageEvent(): SimDamageEvent {
  return { attackerId: 0, victimId: 0, amount: 0, weaponId: 0, flags: 0, dirX: 0, dirY: 0, dirZ: 0, healthAfter: 0, armorAfter: 0 };
}
function makeKillEvent(): SimKillEvent {
  return { killerId: 0, victimId: 0, weaponId: 0, flags: 0, killerStreak: 0 };
}

const SCRATCH_DIR = new Float64Array(3);
const SCRATCH_HIST = new Float64Array(4);

/* ------------------------------------------------------------------------ *
 * Simulation
 * ------------------------------------------------------------------------ */

export class Simulation {
  readonly world: ServerWorld;
  /**
   * The stats this room fires with — VARIANTS.md §2's seam. Rooms already pin
   * a release per `roomInstanceId`, so an arsenal is per-room by construction
   * and two variant tables can never meet in one match. Defaulted to the
   * compiled one because that is what a room with no variants release, the
   * local Worker and every test all want.
   */
  readonly arsenal: SessionArsenal;
  seed: number;
  /** Server clock in milliseconds since the room started. */
  nowMs = 0;
  tick = 0;
  /**
   * Weapons a body holds on spawn. A normal match starts you with the pistol
   * and the chainsaw and makes you find the rest; a local sandbox room hands
   * over the whole arsenal. Set once by the room, read by every respawn.
   */
  defaultWeaponMask = STARTING_WEAPON_MASK;
  /**
   * Environmental damage switches. A creative Builder world has no fall damage
   * and no lava burn — `ModeSimPlan` says so, and this is where saying so has
   * an effect. Both default true, which is the arena the rest of the game is.
   */
  fallDamageEnabled = true;
  hazardsEnabled = true;

  readonly players: PlayerEntity[] = [];
  /**
   * Bumped whenever the player array changes shape. Snapshot records are
   * emitted in array order, so a join or a leave shifts every later record's
   * index — the net layer forces a full snapshot when this moves, which is what
   * keeps a delta from inheriting another player's untransmitted fields.
   */
  rosterVersion = 0;
  private readonly playerById = new Map<number, PlayerEntity>();
  private readonly playerPool: PlayerEntity[] = [];

  /* --- entities (monsters + pickups) --- */
  readonly entCapacity = MAX_ENTITIES;
  readonly entActive = new Uint8Array(MAX_ENTITIES);
  readonly entId = new Uint16Array(MAX_ENTITIES);
  readonly entGen = new Uint16Array(MAX_ENTITIES);
  readonly entType = new Uint8Array(MAX_ENTITIES);
  readonly entVariant = new Uint8Array(MAX_ENTITIES);
  readonly entState = new Uint8Array(MAX_ENTITIES);
  readonly entHealth = new Int32Array(MAX_ENTITIES);
  readonly entMaxHealth = new Int32Array(MAX_ENTITIES);
  readonly entX = new Float64Array(MAX_ENTITIES);
  readonly entY = new Float64Array(MAX_ENTITIES);
  readonly entZ = new Float64Array(MAX_ENTITIES);
  readonly entVX = new Float64Array(MAX_ENTITIES);
  readonly entVY = new Float64Array(MAX_ENTITIES);
  readonly entVZ = new Float64Array(MAX_ENTITIES);
  readonly entYaw = new Float32Array(MAX_ENTITIES);
  readonly entHalfW = new Float32Array(MAX_ENTITIES);
  readonly entHeight = new Float32Array(MAX_ENTITIES);
  readonly entFlying = new Uint8Array(MAX_ENTITIES);
  readonly entTarget = new Uint16Array(MAX_ENTITIES);
  readonly entTimer = new Float32Array(MAX_ENTITIES);
  readonly entAttackCd = new Float32Array(MAX_ENTITIES);
  readonly entWindup = new Float32Array(MAX_ENTITIES);
  readonly entPain = new Float32Array(MAX_ENTITIES);
  readonly entStrafe = new Int8Array(MAX_ENTITIES);
  readonly entLos = new Float32Array(MAX_ENTITIES);
  readonly entGround = new Uint8Array(MAX_ENTITIES);
  readonly entRespawn = new Float64Array(MAX_ENTITIES);
  entCount = 0;
  private entNextId = 1;

  /** Entities removed during this tick: id + reason, drained by the net layer. */
  readonly removedEntityId = new Uint16Array(MAX_ENTITIES);
  readonly removedEntityReason = new Uint8Array(MAX_ENTITIES);
  removedEntityCount = 0;

  /* --- projectiles --- */
  readonly projActive = new Uint8Array(MAX_PROJECTILES);
  readonly projId = new Uint16Array(MAX_PROJECTILES);
  readonly projGen = new Uint16Array(MAX_PROJECTILES);
  readonly projOwner = new Uint16Array(MAX_PROJECTILES);
  readonly projWeapon = new Uint8Array(MAX_PROJECTILES);
  /** Variant slot the shot was fired with. See `spawnProjectile`. */
  readonly projVariant = new Uint8Array(MAX_PROJECTILES);
  readonly projX = new Float64Array(MAX_PROJECTILES);
  readonly projY = new Float64Array(MAX_PROJECTILES);
  readonly projZ = new Float64Array(MAX_PROJECTILES);
  readonly projVX = new Float64Array(MAX_PROJECTILES);
  readonly projVY = new Float64Array(MAX_PROJECTILES);
  readonly projVZ = new Float64Array(MAX_PROJECTILES);
  readonly projLife = new Float32Array(MAX_PROJECTILES);
  readonly projFromMonster = new Uint8Array(MAX_PROJECTILES);
  readonly projDamage = new Float32Array(MAX_PROJECTILES);
  projCount = 0;
  private projNextId = 1;

  readonly removedProjId = new Uint16Array(MAX_PROJECTILES);
  readonly removedProjReason = new Uint8Array(MAX_PROJECTILES);
  removedProjCount = 0;

  /* --- events --- */
  readonly damageEvents: SimDamageEvent[] = [];
  damageCount = 0;
  readonly killEvents: SimKillEvent[] = [];
  killCount = 0;

  /** True while lag compensation is enabled (off makes tests deterministic). */
  lagCompensation = true;

  private readonly rng = new Rng(1);
  private readonly hit: VoxelHit = createVoxelHit();
  private readonly hit2: VoxelHit = createVoxelHit();
  private readonly avoidScratch = new Float64Array(3 * 64);
  private readonly spawnPoint = { x: 0, y: 0, z: 0, yaw: 0 };
  /**
   * When set, every respawn happens exactly here instead of on an arena floor
   * chosen by `world.pickSpawn`. An authored campaign has one player start and
   * a death has to put you back on it; a generated arena does not and must not.
   */
  spawnAnchor: { x: number; y: number; z: number; yaw: number } | null = null;

  constructor(world: ServerWorld, seed: number, arsenal: SessionArsenal = BASE_ARSENAL) {
    this.world = world;
    this.arsenal = arsenal;
    this.seed = seed >>> 0;
    for (let i = 0; i < 64; i++) this.damageEvents.push(makeDamageEvent());
    for (let i = 0; i < 32; i++) this.killEvents.push(makeKillEvent());
  }

  /* -------------------------------------------------------------- *
   * Players
   * -------------------------------------------------------------- */

  /**
   * `variantSlots` is taken here rather than written by the caller afterwards
   * because `spawnPlayer` — three lines below — fills the first magazine
   * through `statsFor`, which reads them. A slot installed after `addPlayer`
   * returns is a slot that arrived after the magazine it was meant to size.
   * `reset()` zeroes them first, so a pooled body cannot inherit the last
   * occupant's claim the way it used to inherit their `shotSeq`.
   */
  addPlayer(
    id: number, name: string, skin: number, isBot: boolean,
    variantSlots?: Uint8Array,
  ): PlayerEntity {
    const p = this.playerPool.pop() ?? new PlayerEntity();
    p.reset();
    if (variantSlots !== undefined) p.variantSlots.set(variantSlots.subarray(0, WEAPON_COUNT));
    p.id = id;
    p.name = name;
    p.skin = skin;
    // Pooled bodies are reused; a recycled one must not wear the last
    // occupant's outfit until its owner's HELLO lands.
    //
    // A BOT has no HELLO and never will, so leaving it at 0 dressed the entire
    // bot fill as one identical marine — six copies of the same body in a
    // deathmatch, which is the readability failure the outfit system exists to
    // prevent. The room already hands each bot a distinct legacy skin byte;
    // `LEGACY_AVATAR_BY_SKIN` is the shared table that turns one into a full
    // packed avatar, so this costs no wire bytes (the u32 is sent either way)
    // and no new concept.
    p.avatar = isBot ? LEGACY_AVATAR_BY_SKIN[skin % LEGACY_AVATAR_BY_SKIN.length] : 0;
    p.isBot = isBot;
    p.active = true;
    p.kills = 0; p.deaths = 0; p.streak = 0; p.bestStreak = 0;
    p.damageDealt = 0; p.blocksPlaced = 0; p.blocksBroken = 0;
    p.editTokens = MAX_EDITS_PER_SECOND;
    p.lastEditSeq = 0; p.lastInputSeq = 0; p.rttMs = 0;
    this.players.push(p);
    this.playerById.set(id, p);
    this.rosterVersion++;
    this.spawnPlayer(p);
    return p;
  }

  removePlayer(id: number): void {
    const p = this.playerById.get(id);
    if (!p) return;
    this.playerById.delete(id);
    const i = this.players.indexOf(p);
    if (i >= 0) this.players.splice(i, 1);
    this.rosterVersion++;
    p.active = false;
    // Any monster that was hunting this player forgets it.
    for (let e = 0; e < this.entCapacity; e++) {
      if (this.entActive[e] === 1 && this.entTarget[e] === id) this.entTarget[e] = 0;
    }
    if (this.playerPool.length < 8) this.playerPool.push(p);
  }

  getPlayer(id: number): PlayerEntity | undefined { return this.playerById.get(id); }

  /**
   * The stats `p` fires `weaponId` with. One lookup, one place: every reader on
   * the firing path goes through here rather than importing a module table, so
   * a variant that a room revoked resolves to the base without any caller
   * knowing it happened (`statsFor` clamps an unknown slot to BASE_SLOT).
   */
  statsFor(p: PlayerEntity, weaponId: number): EffectiveWeapon {
    return this.arsenal.statsFor(weaponId, p.variantSlots[weaponId] ?? BASE_SLOT);
  }

  /** Place a player at a fresh spawn point with a full loadout. */
  spawnPlayer(p: PlayerEntity): void {
    let n = 0;
    for (let i = 0; i < this.players.length && n < 64; i++) {
      const o = this.players[i];
      if (o === p || o.dead) continue;
      this.avoidScratch[n * 3] = o.pos[0];
      this.avoidScratch[n * 3 + 1] = o.pos[1];
      this.avoidScratch[n * 3 + 2] = o.pos[2];
      n++;
    }
    for (let e = 0; e < this.entCapacity && n < 64; e++) {
      if (this.entActive[e] !== 1 || this.entType[e] >= EntityType.PICKUP_HEALTH) continue;
      this.avoidScratch[n * 3] = this.entX[e];
      this.avoidScratch[n * 3 + 1] = this.entY[e];
      this.avoidScratch[n * 3 + 2] = this.entZ[e];
      n++;
    }
    const sp = this.spawnAnchor
      ?? this.world.pickSpawn(this.spawnPoint, this.avoidScratch, n, hash3i(p.id, this.tick, this.seed, 0x5eed));
    p.pos[0] = sp.x; p.pos[1] = sp.y; p.pos[2] = sp.z;
    p.vel[0] = 0; p.vel[1] = 0; p.vel[2] = 0;
    p.yaw = sp.yaw;
    p.pitch = 0;
    p.health = MAX_HEALTH;
    p.armor = 0;
    p.dead = false;
    p.onGround = true;
    p.crouching = false;
    p.height = PLAYER_HEIGHT;
    p.breath = BREATH_SECONDS;
    p.envDamageAccum = 0;
    p.spawnProtectUntilMs = this.nowMs + SPAWN_PROTECTION_MS;
    p.weapon = DEFAULT_WEAPON;
    p.weaponMask = this.defaultWeaponMask;
    p.reserve.set(AMMO_START);
    p.mag.fill(0);
    for (let i = 0; i < WEAPON_COUNT; i++) {
      if (ownsWeapon(p.weaponMask, i)) p.mag[i] = this.statsFor(p, i).magSize;
    }
    p.heatSpread = 0;
    p.nextFireMs = this.nowMs;
    p.switchEndMs = this.nowMs;
    p.reloading = false;
    p.spinUpMs = 0;
    p.firing = false;
    p.histCount = 0;
    p.histHead = 0;
    p.pushHistory(this.nowMs);
  }

  /* -------------------------------------------------------------- *
   * Input
   * -------------------------------------------------------------- */

  /**
   * Apply one client command. `dtMs` has already been clamped by the net layer;
   * this is where the command becomes physics. Every command is stamped into
   * `lastInputSeq` so the snapshot can ack it.
   */
  applyInput(p: PlayerEntity, cmd: InputCommand, dtMs: number): void {
    p.lastInputSeq = cmd.seq;
    p.hadInputThisTick = true;
    p.yaw = cmd.yaw;
    p.pitch = clamp(cmd.pitch, -PITCH_LIMIT, PITCH_LIMIT);

    const dt = dtMs / 1000;
    if (p.dead) {
      p.firing = false;
      // Bodies still fall so they do not hang in the air.
      p.vel[0] *= 0.9; p.vel[2] *= 0.9;
      p.vel[1] -= GRAVITY * dt;
      moveAABB(p.pos, p.vel, PLAYER_HALF_WIDTH, 0.6, dt, 0, this.world.solidAt);
      return;
    }

    this.applyWeaponIntent(p, cmd, dtMs);
    moveStep(p, cmd.moveX, cmd.moveZ, cmd.buttons, dt, this.world);

    if (this.fallDamageEnabled && p.landImpact > FALL_DAMAGE_MIN_SPEED) {
      const dmg = Math.min(FALL_DAMAGE_MAX, (p.landImpact - FALL_DAMAGE_MIN_SPEED) * FALL_DAMAGE_PER_MPS);
      if (dmg >= 1) this.damagePlayer(p, 0, dmg, WeaponId.PISTOL, DMG_FALL | DMG_ENVIRONMENT, 0, -1, 0);
    }
  }

  /** Weapon switching, reloading, spin-up and the trigger itself. */
  private applyWeaponIntent(p: PlayerEntity, cmd: InputCommand, dtMs: number): void {
    const now = this.nowMs;

    // Slot 0..6 selects a weapon directly; 7 and 8 are build slots.
    if (cmd.slot <= 6) {
      const want = cmd.slot | 0;
      if (want !== p.weapon && ownsWeapon(p.weaponMask, want)) {
        // Switch times are FEEL fields and deliberately outside the variant
        // whitelist (VARIANTS.md §1.2), so these read the archetype.
        const outMs = getWeapon(p.weapon).switchOutMs;
        const inMs = getWeapon(want).switchInMs;
        p.weapon = want;
        p.reloading = false;
        p.spinUpMs = 0;
        p.heatSpread = 0;
        p.switchEndMs = now + outMs + inMs;
        p.nextFireMs = Math.max(p.nextFireMs, p.switchEndMs);
      }
      p.buildMode = false;
    } else {
      p.buildMode = true;
    }

    const def = this.statsFor(p, p.weapon);
    const ammoType = ammoTypeOf(p.weapon);

    // Reload, either as a block or shell by shell.
    if (p.reloading) {
      if (now >= p.reloadEndMs) {
        if (def.reloadShellMs > 0) {
          if (p.mag[p.weapon] < def.magSize && p.reserve[ammoType] > 0) {
            p.mag[p.weapon]++;
            p.reserve[ammoType]--;
            p.reloadEndMs = now + def.reloadShellMs;
          } else {
            p.reloading = false;
          }
        } else {
          const need = def.magSize - p.mag[p.weapon];
          const take = Math.min(need, p.reserve[ammoType]);
          p.mag[p.weapon] += take;
          p.reserve[ammoType] -= take;
          p.reloading = false;
        }
      }
      // A shell-by-shell reload is interruptible by pulling the trigger.
      if (p.reloading && def.reloadShellMs > 0 && (cmd.buttons & BTN_FIRE) !== 0 && p.mag[p.weapon] > 0) {
        p.reloading = false;
      }
    } else if ((cmd.buttons & BTN_RELOAD) !== 0) {
      this.startReload(p);
    }

    // Chaingun spin-up / spin-down.
    const wantFire = (cmd.buttons & BTN_FIRE) !== 0;
    if (def.spinUpMs > 0) {
      if (wantFire && !p.reloading) {
        p.spinUpMs = Math.min(def.spinUpMs, p.spinUpMs + dtMs);
      } else {
        const rate = def.spinDownMs > 0 ? (def.spinUpMs / def.spinDownMs) : 1;
        p.spinUpMs = Math.max(0, p.spinUpMs - dtMs * rate);
      }
    }

    // Melee is always available on the melee weapon slot, and BTN_MELEE gives a
    // quick chainsaw swipe without switching.
    const meleePunch = (cmd.buttons & BTN_MELEE) !== 0 && ownsWeapon(p.weaponMask, WeaponId.CHAINSAW);

    let fired = false;
    if (wantFire && !p.reloading && now >= p.switchEndMs) {
      if (def.automatic || !p.firePressed) {
        if (def.spinUpMs === 0 || p.spinUpMs >= def.spinUpMs) fired = this.tryFire(p, p.weapon);
      }
    } else if (meleePunch && now >= p.switchEndMs && !p.firePressed) {
      fired = this.tryFire(p, WeaponId.CHAINSAW);
    }

    p.firePressed = wantFire || meleePunch;
    p.firing = fired || (wantFire && now < p.nextFireMs && p.mag[p.weapon] > 0);

    // The cone recovers only while the trigger is UP. Recovering on every tick
    // that did not itself fire (the old `!fired`) recovered on five ticks out
    // of six during sustained fire, which is faster than any weapon accumulates
    // — so the cone never opened at all. Kept identical to the condition in
    // client/src/game/weapons.ts: the client predicts its own cone and this
    // reproduces it, so the two rules must not drift apart.
    if (!wantFire || p.reloading || now < p.switchEndMs) {
      p.heatSpread = recoverSpreadOf(def, p.heatSpread, dtMs / 1000);
    }
  }

  startReload(p: PlayerEntity): void {
    const def = this.statsFor(p, p.weapon);
    if (def.kind === FireKind.MELEE) return;
    if (p.reloading) return;
    if (p.mag[p.weapon] >= def.magSize) return;
    const ammoType = ammoTypeOf(p.weapon);
    if (p.reserve[ammoType] <= 0) return;
    p.reloading = true;
    p.reloadEndMs = this.nowMs + (def.reloadShellMs > 0 ? def.reloadShellMs : def.reloadMs);
  }

  /* -------------------------------------------------------------- *
   * Firing
   * -------------------------------------------------------------- */

  /** Server-authoritative shot. Returns true when a round actually left the barrel. */
  tryFire(p: PlayerEntity, weapon: number): boolean {
    const now = this.nowMs;
    if (p.dead) return false;
    if (now < p.nextFireMs) return false;             // fire-rate enforcement
    const def = this.statsFor(p, weapon);
    if (def.kind !== FireKind.MELEE) {
      if (p.mag[weapon] <= 0) {
        this.startReload(p);
        return false;
      }
      p.mag[weapon]--;
    }

    /*
     * `now + interval`, and NOT the client's carry-the-overshoot rule.
     *
     * The two schedule on different clocks — a 20 ms server tick against a
     * frame loop — so shot TIMES cannot be made to agree by matching a
     * formula, and trying made it worse: carrying `now - p.nextFireMs` forward
     * is only an overshoot while the trigger is held, and after an idle period
     * that difference is stale, which let a pistol fire its second round 17 ms
     * after its first. The client's own accumulator is bounded because its
     * cooldown stops decrementing at zero; the server has no equivalent bound
     * without carrying a second piece of per-player state.
     *
     * What IS made to agree is the CONTENT of shot N — its cone, its seed and
     * its pellets — which is what `agreement.test.ts` asserts. The residual is
     * that the client may be up to one shot ahead or behind, and the server is
     * authoritative about which shots happened. See HANDOVER §6.
     */
    const interval = fireIntervalMsOf(def);
    p.nextFireMs = now + interval;
    p.shotSeq = nextShotSeq(p.shotSeq);

    /* THE CONE IS READ BEFORE THE SHOT BLOOMS IT.
     *
     * This used to bloom first and read after, so the server resolved every
     * shot through a cone one `spreadPerShot` wider than the one the client
     * had predicted — the first shot of a burst included. Measured on the
     * shotgun that was 8.9 degrees of disagreement on shot one alone.
     * client/src/game/weapons.ts reads then blooms, and it is the one that is
     * right: the first shot of a burst is the accurate one, which is what
     * every shooter this is modelled on does.
     */
    const spread = currentSpreadOf(def, p.heatSpread, !p.onGround, p.crouching);
    p.heatSpread = applyShotSpreadOf(def, p.heatSpread);

    // Firing cancels spawn protection: you cannot shoot from behind the shield.
    if (p.spawnProtectUntilMs > now) p.spawnProtectUntilMs = now;

    const ex = p.pos[0];
    const ey = p.eyeY;
    const ez = p.pos[2];

    switch (def.kind) {
      case FireKind.HITSCAN: {
        // `hot.pellets`, not `def.pellets`, and clamped — the two halves of one
        // fix. The client has always read the uint8 (`weapons.ts` fireHitscan)
        // and this loop read the double, so a pellet count of 256 would be 0
        // there and 256 here; and clamping only this side's double would give
        // 16 against the client's 0, which is a worse disagreement than none.
        // Identical for every shipping weapon — the counts are [1,7,1,1,1,1,1]
        // and u8 of a small integer is that integer, so the lockstep golden and
        // the cone agreement do not move. See MAX_PELLETS in shared/weapons.ts.
        const pellets = def.hot.pellets > MAX_PELLETS ? MAX_PELLETS : def.hot.pellets;
        for (let i = 0; i < pellets; i++) {
          anglesToForward(SCRATCH_DIR, 0, p.yaw, p.pitch);
          // PER PELLET, from (owner, shot, pellet) and nothing else. The old
          // scheme reseeded ONCE per shot from `hash3i(id, seq, this.seed, …)`
          // and then walked one stream two draws at a time — which the client
          // cannot reproduce at all, because `this.seed` is the ROOM seed and
          // the pattern depends on pellet order. Same seed, same order, same
          // draws as client/src/game/weapons.ts fireHitscan.
          this.rng.reseed(shotSeed(p.id, p.shotSeq, i));
          if (spread > 0) {
            coneSpread(SCRATCH_DIR, 0, SCRATCH_DIR[0], SCRATCH_DIR[1], SCRATCH_DIR[2], spread, this.rng.next(), this.rng.next());
          }
          this.resolveHitscan(p, def, ex, ey, ez, SCRATCH_DIR[0], SCRATCH_DIR[1], SCRATCH_DIR[2]);
        }
        break;
      }
      case FireKind.PROJECTILE: {
        anglesToForward(SCRATCH_DIR, 0, p.yaw, p.pitch);
        // The client spreads its predicted bolt and the server did not, so
        // every plasma shot (the one projectile weapon with a cone: spread
        // 0.014, +0.0016 per shot) left the barrel along a different vector on
        // the two sides. Pellet 0, same seed, same draws as the client's
        // fireProjectile.
        this.rng.reseed(shotSeed(p.id, p.shotSeq, 0));
        if (spread > 0) {
          coneSpread(SCRATCH_DIR, 0, SCRATCH_DIR[0], SCRATCH_DIR[1], SCRATCH_DIR[2], spread, this.rng.next(), this.rng.next());
        }
        this.spawnProjectile(
          p.id, weapon, p.variantSlots[weapon] ?? BASE_SLOT,
          ex + SCRATCH_DIR[0] * 0.5, ey + SCRATCH_DIR[1] * 0.5, ez + SCRATCH_DIR[2] * 0.5,
          SCRATCH_DIR[0] * def.projectileSpeed + p.vel[0] * 0.25,
          SCRATCH_DIR[1] * def.projectileSpeed + p.vel[1] * 0.25,
          SCRATCH_DIR[2] * def.projectileSpeed + p.vel[2] * 0.25,
          def.damage, false,
        );
        break;
      }
      case FireKind.MELEE: {
        anglesToForward(SCRATCH_DIR, 0, p.yaw, p.pitch);
        this.resolveMelee(p, def, ex, ey, ez, SCRATCH_DIR[0], SCRATCH_DIR[1], SCRATCH_DIR[2], def.meleeRange);
        break;
      }
      default:
        break;
    }
    return true;
  }

  /** Milliseconds of rewind applied to `p`'s shots. */
  private rewindMsFor(p: PlayerEntity): number {
    if (!this.lagCompensation || p.isBot) return 0;
    return clamp(p.rttMs * 0.5, 0, LAG_COMP_MAX_MS);
  }

  private resolveHitscan(
    shooter: PlayerEntity, def: EffectiveWeapon,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
  ): void {
    const rewind = this.rewindMsFor(shooter);
    const atMs = this.nowMs - rewind;

    // Terrain first: it bounds how far the ray can reach.
    let bestT = HITSCAN_MAX_DISTANCE;
    if (raycastVoxels(ox, oy, oz, dx, dy, dz, HITSCAN_MAX_DISTANCE, this.world.getBlockAt, isBlockingId, this.hit)) {
      bestT = this.hit.distance;
    }

    let victim: PlayerEntity | null = null;
    let headshot = false;

    for (let i = 0; i < this.players.length; i++) {
      const o = this.players[i];
      if (o === shooter || o.dead || !o.active) continue;
      if (o.spawnProtectUntilMs > this.nowMs) continue;
      let hx = o.pos[0], hy = o.pos[1], hz = o.pos[2], hh = o.height;
      if (rewind > 0 && sampleHistory(o, atMs, SCRATCH_HIST)) {
        hx = SCRATCH_HIST[0]; hy = SCRATCH_HIST[1]; hz = SCRATCH_HIST[2]; hh = SCRATCH_HIST[3];
      }
      const t = rayAABB(
        ox, oy, oz, dx, dy, dz,
        hx - PLAYER_HALF_WIDTH, hy, hz - PLAYER_HALF_WIDTH,
        hx + PLAYER_HALF_WIDTH, hy + hh, hz + PLAYER_HALF_WIDTH,
        bestT,
      );
      if (t < 0 || t >= bestT) continue;
      bestT = t;
      victim = o;
      headshot = hh > PLAYER_CROUCH_HEIGHT && rayAABB(
        ox, oy, oz, dx, dy, dz,
        hx - PLAYER_HEAD_HALF_WIDTH, hy + PLAYER_HEAD_MIN_Y, hz - PLAYER_HEAD_HALF_WIDTH,
        hx + PLAYER_HEAD_HALF_WIDTH, hy + hh, hz + PLAYER_HEAD_HALF_WIDTH,
        HITSCAN_MAX_DISTANCE,
      ) >= 0;
    }

    /* Monsters share the same ray — and, since this line, the same HEAD BOX.
     *
     * `headshot = false` used to sit where the head test now is, and it was not
     * a simplification, it was a disagreement: the client has always predicted
     * monster headshots (`refillTargets` pushes every demon with a head box at
     * MONSTER_HEAD_*_FRAC and `traceTargets` tests it first), so putting a
     * pellet through an Imp's skull drew a GOLD hit marker and a doubled damage
     * number on the shooter's screen while the server quietly applied single
     * damage and reported no DMG_HEADSHOT. The marker was not merely late, it
     * was contradicted: the authoritative echo landed a round trip later and
     * repainted the same hit plain white. Same box, same multiplier, both
     * sides — the prediction is now a prediction rather than a guess.
     */
    let monster = -1;
    for (let e = 0; e < this.entCapacity; e++) {
      if (this.entActive[e] !== 1 || this.entType[e] >= EntityType.PICKUP_HEALTH) continue;
      const hw = this.entHalfW[e];
      const t = rayAABB(
        ox, oy, oz, dx, dy, dz,
        this.entX[e] - hw, this.entY[e], this.entZ[e] - hw,
        this.entX[e] + hw, this.entY[e] + this.entHeight[e], this.entZ[e] + hw,
        bestT,
      );
      if (t < 0 || t >= bestT) continue;
      bestT = t;
      monster = e;
      victim = null;
      const hh = this.entHeight[e];
      const hhw = hw * MONSTER_HEAD_HALF_WIDTH_FRAC;
      headshot = rayAABB(
        ox, oy, oz, dx, dy, dz,
        this.entX[e] - hhw, this.entY[e] + hh * MONSTER_HEAD_MIN_Y_FRAC, this.entZ[e] - hhw,
        this.entX[e] + hhw, this.entY[e] + hh, this.entZ[e] + hhw,
        HITSCAN_MAX_DISTANCE,
      ) >= 0;
    }

    if (monster >= 0) {
      let dmg = damageAtDistanceOf(def, bestT);
      let mflags = 0;
      if (headshot) {
        dmg *= def.headshotMultiplier > 0 ? def.headshotMultiplier : HEADSHOT_MULTIPLIER;
        mflags |= DMG_HEADSHOT;
      }
      this.damageEntity(monster, shooter.id, dmg, def.id, mflags, dx, dy, dz);
      return;
    }
    if (!victim) return;

    let dmg = damageAtDistanceOf(def, bestT);
    let flags = 0;
    if (headshot) {
      dmg *= def.headshotMultiplier > 0 ? def.headshotMultiplier : HEADSHOT_MULTIPLIER;
      flags |= DMG_HEADSHOT;
    }
    this.damagePlayer(victim, shooter.id, dmg, def.id, flags, dx, dy, dz);
    const imp = knockbackImpulseOf(def, dmg);
    victim.vel[0] += dx * imp;
    victim.vel[1] += Math.max(0, dy) * imp + imp * 0.25;
    victim.vel[2] += dz * imp;
  }

  private resolveMelee(
    attacker: PlayerEntity, def: EffectiveWeapon,
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    range: number,
  ): void {
    const cosLimit = 0.72;   // ~44 degree half-cone
    for (let i = 0; i < this.players.length; i++) {
      const o = this.players[i];
      if (o === attacker || o.dead || !o.active) continue;
      if (o.spawnProtectUntilMs > this.nowMs) continue;
      const cx = o.pos[0] - ox;
      const cy = o.pos[1] + o.height * 0.5 - oy;
      const cz = o.pos[2] - oz;
      const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (d > range + PLAYER_HALF_WIDTH) continue;
      if (d > 1e-4 && (cx * dx + cy * dy + cz * dz) / d < cosLimit) continue;
      const dmg = damageAtDistanceOf(def, d);
      this.damagePlayer(o, attacker.id, dmg, def.id, 0, dx, dy, dz);
      const imp = knockbackImpulseOf(def, dmg);
      o.vel[0] += dx * imp; o.vel[1] += imp * 0.5; o.vel[2] += dz * imp;
    }
    for (let e = 0; e < this.entCapacity; e++) {
      if (this.entActive[e] !== 1 || this.entType[e] >= EntityType.PICKUP_HEALTH) continue;
      const cx = this.entX[e] - ox;
      const cy = this.entY[e] + this.entHeight[e] * 0.5 - oy;
      const cz = this.entZ[e] - oz;
      const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (d > range + this.entHalfW[e]) continue;
      if (d > 1e-4 && (cx * dx + cy * dy + cz * dz) / d < cosLimit) continue;
      this.damageEntity(e, attacker.id, damageAtDistanceOf(def, d), def.id, 0, dx, dy, dz);
    }
  }

  /* -------------------------------------------------------------- *
   * Projectiles
   * -------------------------------------------------------------- */

  /**
   * `variantSlot` is the shooter's equipped slot AT THE MOMENT OF FIRING, kept
   * on the projectile rather than re-read at detonation. A rocket in flight
   * outlives a weapon switch, a death and a respawn, and its blast is the shot
   * that was taken — re-resolving the slot later would let a player change the
   * splash of a round already in the air.
   */
  spawnProjectile(
    ownerId: number, weapon: number, variantSlot: number,
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    damage: number, fromMonster: boolean,
  ): number {
    let slot = -1;
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      if (this.projActive[i] === 0) { slot = i; break; }
    }
    if (slot < 0) return -1;
    this.projActive[slot] = 1;
    this.projId[slot] = this.nextProjId();
    this.projGen[slot] = (this.projGen[slot] + 1) & 0xffff;
    this.projOwner[slot] = ownerId;
    this.projWeapon[slot] = weapon;
    this.projVariant[slot] = variantSlot;
    this.projX[slot] = x; this.projY[slot] = y; this.projZ[slot] = z;
    this.projVX[slot] = vx; this.projVY[slot] = vy; this.projVZ[slot] = vz;
    const def = this.arsenal.statsFor(weapon, variantSlot);
    this.projLife[slot] = def.projectileLifeMs > 0 ? def.projectileLifeMs : 3000;
    this.projFromMonster[slot] = fromMonster ? 1 : 0;
    this.projDamage[slot] = damage;
    this.projCount++;
    return slot;
  }

  private nextProjId(): number {
    let id = this.projNextId++;
    if (this.projNextId > 65535) this.projNextId = 1;
    if (id === 0) id = this.projNextId++;
    return id;
  }

  private removeProjectile(slot: number, reason: number): void {
    if (this.projActive[slot] === 0) return;
    this.projActive[slot] = 0;
    this.projCount--;
    if (this.removedProjCount < MAX_PROJECTILES) {
      this.removedProjId[this.removedProjCount] = this.projId[slot];
      this.removedProjReason[this.removedProjCount] = reason;
      this.removedProjCount++;
    }
  }

  private stepProjectiles(dt: number): void {
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      if (this.projActive[i] === 0) continue;
      const weapon = this.projWeapon[i];
      const def = this.arsenal.statsFor(weapon, this.projVariant[i]);

      this.projLife[i] -= dt * 1000;
      if (this.projLife[i] <= 0) {
        this.detonate(i, this.projX[i], this.projY[i], this.projZ[i], RemoveReason.EXPIRED);
        continue;
      }

      if (def.projectileGravity > 0) this.projVY[i] -= def.projectileGravity * dt;

      const vx = this.projVX[i], vy = this.projVY[i], vz = this.projVZ[i];
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (speed < 1e-4) { this.detonate(i, this.projX[i], this.projY[i], this.projZ[i], RemoveReason.EXPIRED); continue; }
      const travel = speed * dt;
      const ndx = vx / speed, ndy = vy / speed, ndz = vz / speed;
      const ox = this.projX[i], oy = this.projY[i], oz = this.projZ[i];

      let bestT = travel;
      let hitPlayer: PlayerEntity | null = null;
      let hitEntity = -1;
      let hitWorld = false;

      if (raycastVoxels(ox, oy, oz, ndx, ndy, ndz, travel + def.projectileRadius, this.world.getBlockAt, isBlockingId, this.hit2)) {
        bestT = Math.max(0, this.hit2.distance - def.projectileRadius * 0.5);
        hitWorld = true;
      }

      const radius = def.projectileRadius > 0 ? def.projectileRadius : 0.15;
      for (let pi = 0; pi < this.players.length; pi++) {
        const o = this.players[pi];
        if (o.dead || !o.active) continue;
        if (this.projFromMonster[i] === 0 && o.id === this.projOwner[i]) continue;
        if (o.spawnProtectUntilMs > this.nowMs) continue;
        const t = rayAABB(
          ox, oy, oz, ndx, ndy, ndz,
          o.pos[0] - PLAYER_HALF_WIDTH - radius, o.pos[1] - radius, o.pos[2] - PLAYER_HALF_WIDTH - radius,
          o.pos[0] + PLAYER_HALF_WIDTH + radius, o.pos[1] + o.height + radius, o.pos[2] + PLAYER_HALF_WIDTH + radius,
          bestT,
        );
        if (t >= 0 && t < bestT) { bestT = t; hitPlayer = o; hitWorld = false; hitEntity = -1; }
      }

      if (this.projFromMonster[i] === 0) {
        for (let e = 0; e < this.entCapacity; e++) {
          if (this.entActive[e] !== 1 || this.entType[e] >= EntityType.PICKUP_HEALTH) continue;
          const hw = this.entHalfW[e] + radius;
          const t = rayAABB(
            ox, oy, oz, ndx, ndy, ndz,
            this.entX[e] - hw, this.entY[e] - radius, this.entZ[e] - hw,
            this.entX[e] + hw, this.entY[e] + this.entHeight[e] + radius, this.entZ[e] + hw,
            bestT,
          );
          if (t >= 0 && t < bestT) { bestT = t; hitEntity = e; hitPlayer = null; hitWorld = false; }
        }
      }

      if (hitPlayer || hitEntity >= 0 || hitWorld) {
        const px = ox + ndx * bestT;
        const py = oy + ndy * bestT;
        const pz = oz + ndz * bestT;
        if (hitPlayer) {
          const direct = this.projDamage[i];
          // See detonate(): monster projectiles must not be credited to the
          // player who happens to share the monster's id.
          const attacker = this.projFromMonster[i] === 1 ? 0 : this.projOwner[i];
          this.damagePlayer(hitPlayer, attacker, direct, weapon, 0, ndx, ndy, ndz);
          const imp = knockbackImpulseOf(def, direct);
          hitPlayer.vel[0] += ndx * imp; hitPlayer.vel[1] += imp * 0.4; hitPlayer.vel[2] += ndz * imp;
        } else if (hitEntity >= 0) {
          this.damageEntity(hitEntity, this.projOwner[i], this.projDamage[i], weapon, 0, ndx, ndy, ndz);
        }
        this.detonate(i, px, py, pz, hitWorld ? RemoveReason.HIT_WORLD : RemoveReason.HIT_ENTITY);
        continue;
      }

      this.projX[i] = ox + vx * dt;
      this.projY[i] = oy + vy * dt;
      this.projZ[i] = oz + vz * dt;
    }
  }

  /** Splash damage, self-knockback and terrain carving. */
  private detonate(slot: number, x: number, y: number, z: number, reason: number): void {
    const weapon = this.projWeapon[slot];
    const def = this.arsenal.statsFor(weapon, this.projVariant[slot]);
    const ownerId = this.projOwner[slot];
    const fromMonster = this.projFromMonster[slot] === 1;
    this.removeProjectile(slot, reason);

    if (def.splashRadius > 0) {
      for (let i = 0; i < this.players.length; i++) {
        const o = this.players[i];
        if (o.dead || !o.active) continue;
        const cx = o.pos[0] - x;
        const cy = o.pos[1] + o.height * 0.5 - y;
        const cz = o.pos[2] - z;
        const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
        if (d >= def.splashRadius) continue;
        // Walls stop a blast — a rocket round the corner should not kill.
        if (d > 1.0 && this.blockedLineOfSight(x, y, z, o.pos[0], o.pos[1] + o.height * 0.5, o.pos[2])) continue;

        let dmg = splashDamageAtOf(def, d);
        const self = !fromMonster && o.id === ownerId;
        if (self) dmg *= def.selfDamageScale;
        if (dmg > 0.5 && (!self || def.selfDamageScale > 0)) {
          if (o.spawnProtectUntilMs <= this.nowMs || self) {
            // A monster's projectile carries the MONSTER's entity id as its
            // owner, and entity ids share the number space with player ids —
            // so crediting it directly makes a cacodemon's plasma read as a
            // suicide by whichever player happens to hold that id. Monster
            // kills belong to the world.
            const attacker = fromMonster ? 0 : ownerId;
            this.damagePlayer(o, attacker, dmg, weapon, DMG_SPLASH | (self ? DMG_SELF : 0),
              d > 1e-4 ? cx / d : 0, d > 1e-4 ? cy / d : 1, d > 1e-4 ? cz / d : 0);
          }
        }

        // The rocket jump. Self-knockback is scaled separately from self-damage
        // so riding a rocket survives even when the damage is turned down.
        const raw = splashDamageAtOf(def, d);
        const push = self
          ? raw * SELF_KNOCKBACK_SCALE * def.selfKnockbackScale
          : raw * KNOCKBACK_SCALE;
        const inv = d > 1e-4 ? 1 / d : 0;
        o.vel[0] += cx * inv * push;
        o.vel[1] += (cy * inv + 0.55) * push;
        o.vel[2] += cz * inv * push;
        if (o.vel[1] > 0.5) o.onGround = false;
      }

      for (let e = 0; e < this.entCapacity; e++) {
        if (this.entActive[e] !== 1 || this.entType[e] >= EntityType.PICKUP_HEALTH) continue;
        const cx = this.entX[e] - x;
        const cy = this.entY[e] + this.entHeight[e] * 0.5 - y;
        const cz = this.entZ[e] - z;
        const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
        if (d >= def.splashRadius) continue;
        const dmg = splashDamageAtOf(def, d);
        if (dmg > 0.5 && !fromMonster) {
          const inv = d > 1e-4 ? 1 / d : 0;
          this.damageEntity(e, ownerId, dmg, weapon, DMG_SPLASH, cx * inv, cy * inv, cz * inv);
        }
      }
    }

    // The thing the bar cannot do: the geometry itself gives way.
    if (def.terrainDamage > 0) this.world.carveSphere(x, y, z, def.terrainDamage, ownerId);
  }

  private blockedLineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-4) return false;
    return raycastVoxels(ax, ay, az, dx / d, dy / d, dz / d, d - 0.15, this.world.getBlockAt, isOpaqueId, this.hit2);
  }

  /** Public line-of-sight probe used by the monster AI. */
  hasLineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    return !this.blockedLineOfSight(ax, ay, az, bx, by, bz);
  }

  /* -------------------------------------------------------------- *
   * Damage
   * -------------------------------------------------------------- */

  damagePlayer(
    victim: PlayerEntity, attackerId: number, amount: number, weaponId: number, flags: number,
    dirX: number, dirY: number, dirZ: number,
  ): void {
    if (victim.dead || amount <= 0 || !victim.active) return;
    if (victim.spawnProtectUntilMs > this.nowMs && (flags & (DMG_SELF | DMG_FALL | DMG_ENVIRONMENT)) === 0) return;

    let dmg = amount;
    if (victim.armor > 0) {
      const absorbed = Math.min(victim.armor, dmg * ARMOR_ABSORB);
      victim.armor -= absorbed;
      dmg -= absorbed;
    }
    victim.health -= dmg;
    victim.lastDamageMs = this.nowMs;
    if (attackerId !== 0 && attackerId !== victim.id) victim.lastAttacker = attackerId;

    const attacker = attackerId !== 0 ? this.playerById.get(attackerId) : undefined;
    if (attacker && attacker !== victim) attacker.damageDealt += Math.min(dmg, Math.max(0, victim.health + dmg));

    const fatal = victim.health <= 0;
    if (fatal) flags |= DMG_FATAL;

    this.pushDamage(attackerId, victim.id, Math.round(amount), weaponId, flags, dirX, dirY, dirZ,
      Math.max(0, Math.round(victim.health)), Math.round(victim.armor));

    if (fatal) this.killPlayer(victim, attackerId, weaponId, flags);
  }

  /**
   * The kill-event flags a WEAPON implies, and the ONLY place either producer
   * derives them.
   *
   * It is a method rather than two copies of one line because the two copies
   * is what went wrong: `killPlayer` set KILL_MELEE from the weapon and the
   * entity branch of `damageEntity` wrote a flat `flags = 0`, so chainsawing a
   * player was a melee kill on the wire and chainsawing a demon was not. The
   * killfeed draws its glyph from exactly these bits
   * (client/src/modes/deathmatch/killfeed.ts), so the same swing rendered two
   * different ways depending on what it hit.
   *
   * `getWeapon`, not the arsenal, and on purpose: FireKind is not a
   * variant-able field (VARIANTS.md §1.5 — a variant that needs a new FireKind
   * is BUILD-class), so the archetype answers this and no lookup of the
   * killer's equipped slot is needed to know a chainsaw was a chainsaw.
   */
  private weaponKillFlags(weaponId: number): number {
    return getWeapon(weaponId).kind === FireKind.MELEE ? KILL_MELEE : 0;
  }

  private killPlayer(victim: PlayerEntity, killerId: number, weaponId: number, dmgFlags: number): void {
    victim.health = 0;
    victim.dead = true;
    victim.deaths++;
    victim.streak = 0;
    victim.firing = false;
    victim.reloading = false;
    victim.respawnAtMs = this.nowMs + RESPAWN_DELAY_MS;

    let killFlags = this.weaponKillFlags(weaponId);
    if (dmgFlags & DMG_HEADSHOT) killFlags |= KILL_HEADSHOT;

    let streak = 0;
    const killer = killerId !== 0 && killerId !== victim.id ? this.playerById.get(killerId) : undefined;
    if (killer) {
      killer.kills++;
      killer.streak++;
      if (killer.streak > killer.bestStreak) killer.bestStreak = killer.streak;
      streak = killer.streak;
    } else if ((dmgFlags & DMG_SELF) !== 0 || killerId === victim.id) {
      // Rocket-jumping into a wall is on you.
      killFlags |= KILL_SELF;
      victim.kills = Math.max(0, victim.kills - 1);
    } else {
      // A demon, a lava pool or a long drop. No score penalty: being eaten by
      // an Imp is not a suicide.
      killFlags |= KILL_ENVIRONMENT;
    }

    if (this.killCount < this.killEvents.length) {
      const e = this.killEvents[this.killCount++];
      // An environment kill has no killer. Reporting the VICTIM as the killer
      // makes every demon mauling and every lava bath read as a suicide in the
      // feed — the KILL_ENVIRONMENT flag says otherwise but the ids are what a
      // client renders. 0 is "not a player".
      e.killerId = killer ? killer.id : ((killFlags & KILL_ENVIRONMENT) !== 0 ? 0 : victim.id);
      e.victimId = victim.id;
      e.weaponId = weaponId;
      e.flags = killFlags;
      e.killerStreak = streak;
    }
  }

  private pushDamage(
    attackerId: number, victimId: number, amount: number, weaponId: number, flags: number,
    dirX: number, dirY: number, dirZ: number, healthAfter: number, armorAfter: number,
  ): void {
    if (this.damageCount >= this.damageEvents.length) return;
    const e = this.damageEvents[this.damageCount++];
    e.attackerId = attackerId;
    e.victimId = victimId;
    e.amount = amount;
    e.weaponId = weaponId;
    e.flags = flags;
    e.dirX = dirX; e.dirY = dirY; e.dirZ = dirZ;
    e.healthAfter = healthAfter;
    e.armorAfter = armorAfter;
  }

  /* -------------------------------------------------------------- *
   * Entities
   * -------------------------------------------------------------- */

  spawnEntity(type: number, x: number, y: number, z: number, health: number, halfW: number, height: number, flying: boolean, variant = 0): number {
    let slot = -1;
    for (let i = 0; i < this.entCapacity; i++) {
      if (this.entActive[i] === 0) { slot = i; break; }
    }
    if (slot < 0) return -1;
    this.entActive[slot] = 1;
    this.entId[slot] = this.nextEntId();
    this.entGen[slot] = (this.entGen[slot] + 1) & 0xffff;
    this.entType[slot] = type;
    this.entVariant[slot] = variant;
    this.entState[slot] = flying ? ES_FLYING : 0;
    this.entHealth[slot] = health;
    this.entMaxHealth[slot] = health;
    this.entX[slot] = x; this.entY[slot] = y; this.entZ[slot] = z;
    this.entVX[slot] = 0; this.entVY[slot] = 0; this.entVZ[slot] = 0;
    this.entYaw[slot] = 0;
    this.entHalfW[slot] = halfW;
    this.entHeight[slot] = height;
    this.entFlying[slot] = flying ? 1 : 0;
    this.entTarget[slot] = 0;
    this.entTimer[slot] = 0;
    this.entAttackCd[slot] = 0;
    this.entWindup[slot] = 0;
    this.entPain[slot] = 0;
    this.entStrafe[slot] = (hash3i(slot, this.tick, this.seed, 7) & 1) === 0 ? 1 : -1;
    this.entLos[slot] = 0;
    this.entGround[slot] = 0;
    this.entRespawn[slot] = 0;
    this.entCount++;
    return slot;
  }

  private nextEntId(): number {
    let id = this.entNextId++;
    if (this.entNextId > 65535) this.entNextId = 1;
    if (id === 0) id = this.entNextId++;
    return id;
  }

  removeEntity(slot: number, reason: number): void {
    if (this.entActive[slot] === 0) return;
    this.entActive[slot] = 0;
    this.entCount--;
    if (this.removedEntityCount < this.entCapacity) {
      this.removedEntityId[this.removedEntityCount] = this.entId[slot];
      this.removedEntityReason[this.removedEntityCount] = reason;
      this.removedEntityCount++;
    }
  }

  /**
   * `weaponId` is a PARAMETER for the same reason it is one on `damagePlayer`
   * and `killPlayer`: the weapon that fired is not the weapon the attacker is
   * holding when the damage lands. This block used to write
   * `e.weaponId = attacker.weapon`, read at the moment the entity died, and a
   * rocket has `projectileLifeMs` 4000 to be in the air across a weapon
   * switch — fire at a demon, switch to the chainsaw, let the rocket land, and
   * the kill event named the chainsaw. Hitscan and melee resolve inside
   * `tryFire` and never noticed; every projectile and every splash did.
   *
   * The projectile already keeps its firing identity for exactly this reason
   * (`projWeapon` / `projVariant`, see `spawnProjectile`), so the value is
   * sitting there at both projectile call sites — it only had to be carried
   * the last step, to the event.
   */
  damageEntity(
    slot: number, attackerId: number, amount: number, weaponId: number, flags: number,
    dirX: number, dirY: number, dirZ: number,
  ): void {
    if (this.entActive[slot] !== 1 || amount <= 0) return;
    if (this.entType[slot] >= EntityType.PICKUP_HEALTH) return;
    this.entHealth[slot] -= amount;
    this.entPain[slot] = 220;
    this.entState[slot] |= ES_PAIN | ES_ALERT;
    if (attackerId !== 0) this.entTarget[slot] = attackerId;

    // Knockback, lighter on the heavies.
    const mass = this.entMaxHealth[slot] / 60;
    const k = (amount * KNOCKBACK_SCALE) / (mass > 0.6 ? mass : 0.6);
    this.entVX[slot] += dirX * k;
    if (this.entFlying[slot] === 1) this.entVY[slot] += dirY * k;
    this.entVZ[slot] += dirZ * k;

    const attacker = this.playerById.get(attackerId);

    /* THE FATAL BIT, which is the whole hit marker.
     *
     * `flags` is a parameter and DMG_FATAL is raised here for the same reason
     * `damagePlayer` does both: the client's hit marker is driven by
     * `(flags & DMG_FATAL)` and `(flags & DMG_HEADSHOT)` and by nothing else
     * (`Game.onDamage` → `Hud.hitMarker`). A literal 0 sat in this argument, so
     * the ONLY producer that ever raised a kill marker was the client's own
     * prediction — and the server's echo of that same shot, arriving a round
     * trip later, called `hitMarker(false, false, …)` and painted the red kill
     * ring back out to plain white. Killing a demon looked, at the end of it,
     * exactly like grazing one.
     *
     * The kill EVENT a few lines below has always set its flags from
     * `weaponKillFlags`, which is why this read as a wire that worked: the
     * killfeed was right and the thing in the middle of the screen was not.
     *
     * Order matters. The health subtraction is above, so `entHealth <= 0` is
     * already decided; raising the bit BEFORE `pushDamage` is what puts it in
     * the packet, and raising it after would compile, pass a test that only
     * reads the entity, and ship the same silent marker.
     */
    if (this.entHealth[slot] <= 0) flags |= DMG_FATAL;

    // `weaponId`, where a literal 0 used to sit — so every hit on a monster
    // told the attacker's client it had been dealt by the PISTOL. Nothing on
    // the client reads this field today (`Game.onDamage` uses amount, flags
    // and the direction; the hitmarker takes flags and amount), which is the
    // only reason it was never seen. A wire field that names a weapon and
    // always says the same wrong weapon is a trap for the first reader that
    // does look, and the right value is now a parameter away. Same layout,
    // same u8, same offset: a value fix, not a format change.
    this.pushDamage(attackerId, 0, Math.round(amount), weaponId, flags, dirX, dirY, dirZ, Math.max(0, this.entHealth[slot]), 0);

    if (this.entHealth[slot] <= 0) {
      this.entState[slot] |= ES_DEAD;
      this.removeEntity(slot, RemoveReason.KILLED);
      if (attacker) {
        attacker.kills++;
        attacker.streak++;
        if (attacker.streak > attacker.bestStreak) attacker.bestStreak = attacker.streak;
        if (this.killCount < this.killEvents.length) {
          const e = this.killEvents[this.killCount++];
          e.killerId = attacker.id;
          e.victimId = 0;
          e.weaponId = weaponId;
          // Same derivation as `killPlayer`: the weapon's own bits plus the
          // headshot, so a demon dropped by a shot to the skull reads in the
          // killfeed exactly as a player dropped the same way does.
          e.flags = this.weaponKillFlags(weaponId) | ((flags & DMG_HEADSHOT) !== 0 ? KILL_HEADSHOT : 0);
          e.killerStreak = attacker.streak;
        }
      }
    }
  }

  /* -------------------------------------------------------------- *
   * Pickups
   * -------------------------------------------------------------- */

  spawnPickup(type: number, x: number, y: number, z: number, variant: number): number {
    const slot = this.spawnEntity(type, x, y, z, 1, 0.35, 0.7, false, variant);
    if (slot >= 0) this.entRespawn[slot] = 0;
    return slot;
  }

  private stepPickups(dt: number): void {
    for (let e = 0; e < this.entCapacity; e++) {
      if (this.entActive[e] !== 1) continue;
      const type = this.entType[e];
      if (type < EntityType.PICKUP_HEALTH) continue;
      // Pickups bob in place; the renderer spins them.
      this.entYaw[e] = (this.entYaw[e] + dt * 2.2) % (Math.PI * 2);
      for (let i = 0; i < this.players.length; i++) {
        const p = this.players[i];
        if (p.dead || !p.active) continue;
        const dx = p.pos[0] - this.entX[e];
        const dy = p.pos[1] + p.height * 0.5 - this.entY[e] - 0.35;
        const dz = p.pos[2] - this.entZ[e];
        if (dx * dx + dz * dz > 1.2 * 1.2 || dy * dy > 1.6 * 1.6) continue;
        if (this.applyPickup(p, type, this.entVariant[e])) {
          this.removeEntity(e, RemoveReason.PICKED_UP);
          break;
        }
      }
    }
  }

  private applyPickup(p: PlayerEntity, type: number, variant: number): boolean {
    switch (type) {
      case EntityType.PICKUP_HEALTH: {
        const amount = variant === 1 ? 100 : 25;
        const cap = variant === 1 ? MAX_OVERHEAL : MAX_HEALTH;
        if (p.health >= cap) return false;
        p.health = Math.min(cap, p.health + amount);
        return true;
      }
      case EntityType.PICKUP_ARMOR: {
        if (p.armor >= MAX_ARMOR) return false;
        p.armor = Math.min(MAX_ARMOR, p.armor + (variant === 1 ? 100 : 40));
        return true;
      }
      case EntityType.PICKUP_AMMO: {
        const t = variant >= 1 && variant < AMMO_TYPE_COUNT ? variant : AmmoType.BULLETS;
        if (p.reserve[t] >= AMMO_MAX[t]) return false;
        p.reserve[t] = Math.min(AMMO_MAX[t], p.reserve[t] + Math.ceil(AMMO_MAX[t] * 0.25));
        return true;
      }
      case EntityType.PICKUP_WEAPON: {
        const w = variant % WEAPON_COUNT;
        const had = ownsWeapon(p.weaponMask, w);
        p.weaponMask = grantWeapon(p.weaponMask, w);
        const mag = this.statsFor(p, w).magSize;
        if (!had) {
          p.mag[w] = mag;
          const t = ammoTypeOf(w);
          if (t !== AmmoType.NONE) p.reserve[t] = Math.min(AMMO_MAX[t], p.reserve[t] + mag * 2);
          return true;
        }
        const t = ammoTypeOf(w);
        if (t !== AmmoType.NONE && p.reserve[t] < AMMO_MAX[t]) {
          p.reserve[t] = Math.min(AMMO_MAX[t], p.reserve[t] + mag);
          return true;
        }
        return false;
      }
      default:
        return false;
    }
  }

  /* -------------------------------------------------------------- *
   * Block edits
   * -------------------------------------------------------------- */

  /**
   * A player asked to change a voxel. Reach, rate limit, protected blocks and
   * "am I standing there" all get decided here — nothing the client says about
   * geometry is trusted.
   */
  requestEdit(p: PlayerEntity, action: number, x: number, y: number, z: number, blockId: number, seq: number): EditResult {
    if (p.dead) return EditResult.DEAD;
    if (seq <= p.lastEditSeq) return EditResult.NO_CHANGE;
    if (p.editTokens < 1) return EditResult.RATE_LIMITED;

    const result = this.world.validateEdit(p.pos[0], p.eyeY, p.pos[2], action, x, y, z, blockId);
    if (result !== EditResult.OK) return result;

    if (action === BlockAction.PLACE) {
      // A block may not appear inside a living body.
      for (let i = 0; i < this.players.length; i++) {
        const o = this.players[i];
        if (o.dead || !o.active) continue;
        if (x + 1 > o.pos[0] - PLAYER_HALF_WIDTH && x < o.pos[0] + PLAYER_HALF_WIDTH &&
            z + 1 > o.pos[2] - PLAYER_HALF_WIDTH && z < o.pos[2] + PLAYER_HALF_WIDTH &&
            y + 1 > o.pos[1] && y < o.pos[1] + o.height) {
          return EditResult.BLOCKED_BY_ENTITY;
        }
      }
      for (let e = 0; e < this.entCapacity; e++) {
        if (this.entActive[e] !== 1 || this.entType[e] >= EntityType.PICKUP_HEALTH) continue;
        const hw = this.entHalfW[e];
        if (x + 1 > this.entX[e] - hw && x < this.entX[e] + hw &&
            z + 1 > this.entZ[e] - hw && z < this.entZ[e] + hw &&
            y + 1 > this.entY[e] && y < this.entY[e] + this.entHeight[e]) {
          return EditResult.BLOCKED_BY_ENTITY;
        }
      }
    }

    p.editTokens -= 1;
    p.lastEditSeq = seq;
    this.world.applyEdit(p.id, p.pos[0], p.eyeY, p.pos[2], action, x, y, z, blockId);
    if (action === BlockAction.PLACE) p.blocksPlaced++;
    else p.blocksBroken++;
    return EditResult.OK;
  }

  /* -------------------------------------------------------------- *
   * Tick
   * -------------------------------------------------------------- */

  /**
   * Move the clock forward. Call this FIRST in a tick, before any input is
   * applied, so weapon cooldowns and spawn protection are measured against the
   * time the commands are being simulated at.
   */
  beginTick(dtMs: number): void {
    this.nowMs += dtMs;
    this.tick++;
  }

  /**
   * Advance everything that is not driven by a client command. Call after
   * `beginTick` and after every queued input has been applied.
   */
  stepTick(dtMs: number): void {
    const dt = dtMs / 1000;

    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      p.editTokens = Math.min(MAX_EDITS_PER_SECOND, p.editTokens + MAX_EDITS_PER_SECOND * dt);

      if (p.dead) {
        if (!p.hadInputThisTick) {
          p.vel[0] *= 0.9; p.vel[2] *= 0.9;
          p.vel[1] -= GRAVITY * dt;
          moveAABB(p.pos, p.vel, PLAYER_HALF_WIDTH, 0.6, dt, 0, this.world.solidAt);
        }
        p.hadInputThisTick = false;
        if (this.nowMs >= p.respawnAtMs) this.spawnPlayer(p);
        p.pushHistory(this.nowMs);
        continue;
      }

      if (!p.hadInputThisTick) {
        // Silent client: run the body forward with no wish input. The client
        // will get one correction when it starts talking again, which is the
        // right trade — the alternative is a player frozen mid rocket jump.
        moveStep(p, 0, 0, 0, dt, this.world);
        if (p.landImpact > FALL_DAMAGE_MIN_SPEED) {
          const dmg = Math.min(FALL_DAMAGE_MAX, (p.landImpact - FALL_DAMAGE_MIN_SPEED) * FALL_DAMAGE_PER_MPS);
          if (dmg >= 1) this.damagePlayer(p, 0, dmg, WeaponId.PISTOL, DMG_FALL | DMG_ENVIRONMENT, 0, -1, 0);
        }
      }
      p.hadInputThisTick = false;

      this.applyEnvironment(p, dt);
      p.pushHistory(this.nowMs);
    }

    this.stepProjectiles(dt);
    this.stepPickups(dt);
  }

  /** Lava, drowning and other ways the level itself kills you. */
  private applyEnvironment(p: PlayerEntity, dt: number): void {
    if (!this.hazardsEnabled) { p.envDamageAccum = 0; p.breath = BREATH_SECONDS; return; }
    const bx = Math.floor(p.pos[0]);
    const bz = Math.floor(p.pos[2]);
    const feet = this.world.getBlock(bx, Math.floor(p.pos[1] + 0.1), bz);
    const dps = BLOCK_DAMAGE[feet];
    if (dps > 0) {
      p.envDamageAccum += dps * dt;
      if (p.envDamageAccum >= 1) {
        const whole = Math.floor(p.envDamageAccum);
        p.envDamageAccum -= whole;
        this.damagePlayer(p, 0, whole, WeaponId.PISTOL, DMG_ENVIRONMENT, 0, 1, 0);
      }
    } else if (p.envDamageAccum > 0) {
      p.envDamageAccum = 0;
    }

    if (p.headUnderWater) {
      p.breath -= dt;
      if (p.breath < 0) {
        p.envDamageAccum += DROWN_DAMAGE_PER_SEC * dt;
        if (p.envDamageAccum >= 1) {
          const whole = Math.floor(p.envDamageAccum);
          p.envDamageAccum -= whole;
          this.damagePlayer(p, 0, whole, WeaponId.PISTOL, DMG_ENVIRONMENT, 0, 1, 0);
        }
      }
    } else if (p.breath < BREATH_SECONDS) {
      p.breath = Math.min(BREATH_SECONDS, p.breath + dt * 4);
    }
  }

  /** Called by the net layer once the tick's events have been shipped. */
  clearEvents(): void {
    this.damageCount = 0;
    this.killCount = 0;
    this.removedEntityCount = 0;
    this.removedProjCount = 0;
  }

  /** Wipe every entity and projectile — used when the round restarts. */
  clearWorldEntities(): void {
    for (let i = 0; i < this.entCapacity; i++) {
      if (this.entActive[i] === 1) this.removeEntity(i, RemoveReason.DESPAWNED);
    }
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      if (this.projActive[i] === 1) this.removeProjectile(i, RemoveReason.DESPAWNED);
    }
  }
}

/** Ray blockers: anything solid stops a bullet. */
function isBlockingId(id: number): boolean { return BLOCK_SOLID[id] === 1; }
/** Sight blockers: glass and leaves do not hide you. */
function isOpaqueId(id: number): boolean {
  return BLOCK_SOLID[id] === 1 && id !== BlockId.GLASS && id !== BlockId.LEAVES;
}

