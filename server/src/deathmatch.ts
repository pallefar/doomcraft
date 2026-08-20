/**
 * DOOMCRAFT — Deathmatch, the authoritative half.
 *
 * The bar (voxiom.io Battle Royale, ref/BAR.md weakness #5) puts a
 * "Waiting for players...(2/50)" card in your face for roughly twenty-five
 * seconds before you are allowed to shoot anything. That is the single biggest
 * own-goal in the whole capture, and this file is the answer to it:
 *
 *   **A Deathmatch is populated before anybody clicks Play.**
 *
 * `DeathmatchDirector.start()` seeds the pickup field and fills the arena with
 * bots *while there are zero humans in the room*. The match is already live,
 * frags are already being traded, and the round clock is the only thing that is
 * held back. When a human finally arrives, `joinHuman()` hands them a bot's
 * seat — not a new one — so the body count, the pacing and the fight they are
 * dropping into do not change. That is the whole trick, and it is measurable:
 * a joining human costs zero matchmaking time because there was never anything
 * to match.
 *
 * Three things live here and nowhere else:
 *
 *   1. **Rounds.** WARMUP (no humans, clock frozen, still playable) → LIVE
 *      (clock running, frag limit armed) → INTERMISSION (scoreboard) → back.
 *      The clock never runs for an audience of bots, so a player who joins an
 *      idle server does not inherit four minutes of nothing.
 *   2. **The pickup field.** Deterministic spots from the seed, per-class
 *      respawn timers (Doom's rhythm: cells cycle fast, a megasphere makes you
 *      wait), and a claim that is idempotent — `tryTake` is the ONLY way a
 *      pickup leaves the floor, so two bodies arriving on the same tick cannot
 *      both get it.
 *   3. **Bot backfill.** Bodies are kept at `max(humans, botFill)`, bots are
 *      staggered in rather than popped in one tick, and the bot chosen to make
 *      way for a human is the one with the least going on — never the leader,
 *      never one standing on top of a human.
 *
 * This module imports nothing from `node:*`, `ws` or `Room`. It talks to the
 * simulation through the two structural interfaces below, which the real
 * `Simulation` and `ServerWorld` satisfy — asserted at compile time at the
 * bottom of the type section, so if `sim.ts` changes shape the build breaks
 * here instead of at runtime. That also means a test can drive the whole
 * director against a fake in a millisecond, and does.
 */

import {
  AMMO_MAX,
  AmmoType,
  ChatChannel,
  EntityType,
  MATCH_DURATION_MS,
  MAX_ARMOR,
  MAX_HEALTH,
  MAX_OVERHEAL,
  MAX_PLAYERS,
  RESPAWN_DELAY_MS,
  RemoveReason,
  Rng,
  SCORE_LIMIT,
  SPAWN_PROTECTION_MS,
  WEAPON_COUNT,
  WORLD_MIN_BLOCK_X,
  WORLD_MIN_BLOCK_Z,
  WORLD_SIZE_BLOCKS,
  ammoTypeOf,
  clamp,
  getWeapon,
  grantWeapon,
  ownsWeapon,
} from '@doomcraft/shared';
import { ModeEventKind, ModeId, ModePhase } from '@doomcraft/shared/modes';

import type { ModeRoomState, ModeSimPlan } from './modes.js';
import type { Simulation } from './sim.js';
import type { ServerWorld } from './world.js';

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

/** How long the end-of-round scoreboard stays up before the next round. */
export const DM_INTERMISSION_MS = 8000;
/**
 * A corpse that has not asked to respawn gets up by itself this long after it
 * became eligible. The bar leaves you staring at "Click anywhere to respawn!"
 * for as long as you are not looking; a dead player is a player not playing.
 */
export const DM_AUTO_RESPAWN_MS = 3200;
/** Bots trickle in rather than popping in on one tick. */
export const DM_BOT_JOIN_INTERVAL_MS = 320;
/** Pickup spots the arena is furnished with. */
export const DM_PICKUP_COUNT = 28;
/** Minimum spacing between two pickup spots, in blocks. */
export const DM_PICKUP_SPACING = 16;
/** Horizontal / vertical touch radius of a pickup, mirroring `Simulation.stepPickups`. */
export const DM_PICKUP_TOUCH_XZ = 1.2;
export const DM_PICKUP_TOUCH_Y = 1.6;
/** Re-seeding attempts per pass while the world is still streaming in. */
export const DM_SEED_ATTEMPTS = 96;
/** Frags a player must be ahead by for the "taking the lead" callout to fire. */
export const DM_LEAD_ANNOUNCE_MARGIN = 1;
/** Ammo variants a spot may roll: BULLETS..CELLS. */
const AMMO_TYPE_SPAN = 4;

/**
 * Seconds a pickup class stays gone. Doom's own rhythm: ammo is cheap and
 * cycles fast, armour makes you commit to a route, and the big health is worth
 * waiting for. The bar has no respawning pickups at all — it drops loot on
 * death — so this is a straight addition, not a copy.
 */
export function pickupRespawnMs(type: number, variant: number): number {
  switch (type) {
    case EntityType.PICKUP_HEALTH: return variant === 1 ? 45_000 : 20_000;
    case EntityType.PICKUP_ARMOR: return variant === 1 ? 45_000 : 25_000;
    case EntityType.PICKUP_AMMO: return 15_000;
    case EntityType.PICKUP_WEAPON: return 25_000;
    default: return 20_000;
  }
}

/* ------------------------------------------------------------------------ *
 * The shapes this module needs from the simulation
 *
 * Declared structurally rather than imported as classes: it keeps the director
 * testable without a world, and the two `Assert` lines below prove the real
 * classes still fit.
 * ------------------------------------------------------------------------ */

/** One body in the match — a human or a bot. `PlayerEntity` satisfies this. */
export interface DmBody {
  id: number;
  name: string;
  isBot: boolean;
  active: boolean;
  dead: boolean;
  health: number;
  armor: number;
  weapon: number;
  weaponMask: number;
  kills: number;
  deaths: number;
  streak: number;
  bestStreak: number;
  damageDealt: number;
  respawnAtMs: number;
  spawnProtectUntilMs: number;
  rttMs: number;
  readonly pos: Float64Array;
  readonly mag: Uint16Array;
  readonly reserve: Uint16Array;
}

/** The slice of `Simulation` the director drives. */
export interface DmSim {
  nowMs: number;
  readonly players: DmBody[];
  getPlayer(id: number): DmBody | undefined;
  addPlayer(id: number, name: string, skin: number, isBot: boolean): DmBody;
  removePlayer(id: number): void;
  spawnPlayer(p: DmBody): void;
  spawnPickup(type: number, x: number, y: number, z: number, variant: number): number;
  removeEntity(slot: number, reason: number): void;
  readonly entCapacity: number;
  readonly entActive: Uint8Array;
  readonly entId: Uint16Array;
  readonly entType: Uint8Array;
  readonly entVariant: Uint8Array;
}

/** The slice of `ServerWorld` the pickup field needs. */
export interface DmWorld {
  standableY(x: number, z: number): number;
  surfaceKnown(x: number, z: number): number;
}

type Assert<T extends true> = T;
/** Compile-time proof that the engine classes still satisfy the interfaces above. */
export type SimulationSatisfiesDmSim = Assert<Simulation extends DmSim ? true : false>;
export type ServerWorldSatisfiesDmWorld = Assert<ServerWorld extends DmWorld ? true : false>;

/* ------------------------------------------------------------------------ *
 * Pickups
 * ------------------------------------------------------------------------ */

export enum DmTake {
  /** The claim succeeded and the effect was applied. */
  TAKEN = 0,
  /** Somebody already has it, or it has not respawned yet. */
  ALREADY_TAKEN = 1,
  /** Out of reach. */
  TOO_FAR = 2,
  /** In reach and available, but the body could not use it (full health, etc). */
  NO_EFFECT = 3,
  /** No such spot. */
  UNKNOWN = 4,
}
export const DM_TAKE_NAMES: readonly string[] = Object.freeze([
  'taken', 'already-taken', 'too-far', 'no-effect', 'unknown',
]);

/** One furnished spot on the floor and everything the timer needs. */
export interface DmPickupSpot {
  readonly index: number;
  x: number; y: number; z: number;
  /** `EntityType.PICKUP_*`. */
  type: number;
  variant: number;
  /** Milliseconds this class waits before coming back. */
  respawnMs: number;
  /** Entity id while it is on the floor, -1 while it is gone. */
  entityId: number;
  /** Server clock at which it comes back. 0 while it is on the floor. */
  readyAtMs: number;
  /** Body that took it last. 0 = never taken. */
  takenBy: number;
  /** How many times this spot has been claimed, ever. */
  takenCount: number;
}

/**
 * The arena's furniture. Owns the spots, their timers and — importantly — the
 * only path by which a pickup can leave the floor. `tryTake` is idempotent per
 * cycle: the second caller on the same tick gets `ALREADY_TAKEN`, so a pickup
 * can never be counted twice however many bodies are standing on it.
 */
export class DmPickupField {
  readonly spots: DmPickupSpot[] = [];
  /** Spots the layout wants. Seeding tops up toward this as the world streams. */
  target: number;

  private readonly rng: Rng;
  private readonly seedValue: number;

  constructor(seed: number, target: number = DM_PICKUP_COUNT) {
    this.seedValue = seed >>> 0;
    this.rng = new Rng(this.seedValue ^ 0x9e3779b9);
    this.target = Math.max(0, target | 0);
  }

  get count(): number { return this.spots.length; }

  /** Spots currently lying on the floor and claimable. */
  get availableCount(): number {
    let n = 0;
    for (let i = 0; i < this.spots.length; i++) if (this.spots[i].entityId >= 0) n++;
    return n;
  }

  spot(index: number): DmPickupSpot | undefined { return this.spots[index]; }

  /** Discard the layout entirely. Used when the round regenerates the world. */
  reset(seed: number = this.seedValue): void {
    this.spots.length = 0;
    this.rng.reseed((seed >>> 0) ^ 0x9e3779b9);
  }

  /**
   * Add spots until the target is met or the world runs out of known ground.
   * Safe to call repeatedly while chunks are still trickling in: it only ever
   * appends, so a spot never moves under a player who is already running at it.
   */
  seed(world: DmWorld): number {
    const added0 = this.spots.length;
    const lo = 20;
    const hi = WORLD_SIZE_BLOCKS - 20;
    let attempts = 0;
    while (this.spots.length < this.target && attempts++ < DM_SEED_ATTEMPTS) {
      const x = Math.round(WORLD_MIN_BLOCK_X + this.rng.range(lo, hi));
      const z = Math.round(WORLD_MIN_BLOCK_Z + this.rng.range(lo, hi));
      if (world.surfaceKnown(x, z) < 0) continue;
      const y = world.standableY(x, z);
      if (y < 0) continue;
      let clash = false;
      for (let i = 0; i < this.spots.length; i++) {
        const dx = this.spots[i].x - (x + 0.5);
        const dz = this.spots[i].z - (z + 0.5);
        if (dx * dx + dz * dz < DM_PICKUP_SPACING * DM_PICKUP_SPACING) { clash = true; break; }
      }
      if (clash) continue;
      this.push(x + 0.5, y + 0.1, z + 0.5);
    }
    return this.spots.length - added0;
  }

  /**
   * Place one spot at an exact position. The class mix is Doom's: mostly ammo
   * and health with the occasional weapon, because an arena where everybody
   * already has the rocket launcher has no map control in it.
   */
  push(x: number, y: number, z: number): DmPickupSpot {
    const roll = this.rng.next();
    let type = EntityType.PICKUP_AMMO;
    let variant = 1;
    if (roll < 0.28) {
      type = EntityType.PICKUP_HEALTH;
      variant = this.rng.next() < 0.18 ? 1 : 0;
    } else if (roll < 0.48) {
      type = EntityType.PICKUP_ARMOR;
      variant = this.rng.next() < 0.22 ? 1 : 0;
    } else if (roll < 0.70) {
      type = EntityType.PICKUP_AMMO;
      variant = 1 + this.rng.int(AMMO_TYPE_SPAN);
    } else {
      type = EntityType.PICKUP_WEAPON;
      variant = 1 + this.rng.int(WEAPON_COUNT - 1);
    }
    const spot: DmPickupSpot = {
      index: this.spots.length,
      x, y, z,
      type,
      variant,
      respawnMs: pickupRespawnMs(type, variant),
      entityId: -1,
      readyAtMs: 0,
      takenBy: 0,
      takenCount: 0,
    };
    this.spots.push(spot);
    return spot;
  }

  /** Put every spot that is due back on the floor. Returns how many appeared. */
  spawnDue(sim: DmSim, nowMs: number): number {
    let n = 0;
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i];
      if (s.entityId >= 0) continue;
      if (nowMs < s.readyAtMs) continue;
      const slot = sim.spawnPickup(s.type, s.x, s.y, s.z, s.variant);
      if (slot < 0) continue;          // entity table full; try again next tick
      s.entityId = sim.entId[slot];
      s.readyAtMs = 0;
      n++;
    }
    return n;
  }

  /**
   * Notice pickups the simulation itself consumed (its own proximity pass) and
   * arm their timers. Without this the director and the sim would disagree
   * about what is on the floor the first time a bot walks over a medikit.
   */
  syncRemovals(sim: DmSim, nowMs: number): number {
    let n = 0;
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i];
      if (s.entityId < 0) continue;
      if (this.liveSlotOf(sim, s.entityId) >= 0) continue;
      s.entityId = -1;
      s.readyAtMs = nowMs + s.respawnMs;
      s.takenCount++;
      n++;
    }
    return n;
  }

  /** One pass: reconcile with the sim, then respawn whatever is due. */
  update(sim: DmSim, nowMs: number): void {
    this.syncRemovals(sim, nowMs);
    this.spawnDue(sim, nowMs);
  }

  /**
   * Claim a spot for `body`. The claim is authoritative and single-shot: the
   * spot's entity is removed here, so the second caller this tick — and the
   * simulation's own proximity pass — both find nothing left to take.
   */
  tryTake(index: number, body: DmBody, nowMs: number, sim: DmSim): DmTake {
    const s = this.spots[index];
    if (s === undefined) return DmTake.UNKNOWN;
    if (s.entityId < 0) return DmTake.ALREADY_TAKEN;
    if (body.dead || !body.active) return DmTake.NO_EFFECT;

    const dx = body.pos[0] - s.x;
    const dz = body.pos[2] - s.z;
    const dy = body.pos[1] - s.y;
    if (dx * dx + dz * dz > DM_PICKUP_TOUCH_XZ * DM_PICKUP_TOUCH_XZ) return DmTake.TOO_FAR;
    if (dy * dy > DM_PICKUP_TOUCH_Y * DM_PICKUP_TOUCH_Y) return DmTake.TOO_FAR;

    if (!applyPickupTo(body, s.type, s.variant)) return DmTake.NO_EFFECT;

    const slot = this.liveSlotOf(sim, s.entityId);
    if (slot >= 0) sim.removeEntity(slot, RemoveReason.PICKED_UP);
    s.entityId = -1;
    s.readyAtMs = nowMs + s.respawnMs;
    s.takenBy = body.id;
    s.takenCount++;
    return DmTake.TAKEN;
  }

  /** Index of the nearest claimable spot to a body, or -1. */
  nearestAvailable(x: number, z: number, maxDist: number): number {
    let best = -1;
    let bestD = maxDist * maxDist;
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i];
      if (s.entityId < 0) continue;
      const dx = s.x - x;
      const dz = s.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  private liveSlotOf(sim: DmSim, entityId: number): number {
    for (let i = 0; i < sim.entCapacity; i++) {
      if (sim.entActive[i] === 1 && sim.entId[i] === entityId) return i;
    }
    return -1;
  }
}

/**
 * Apply a pickup to a body, Doom rules. This mirrors `Simulation.applyPickup`
 * deliberately and with the same numbers: both paths can consume a pickup (the
 * sim's proximity sweep and an explicit director claim) and they must agree, or
 * a medikit would heal differently depending on who noticed you first.
 */
export function applyPickupTo(body: DmBody, type: number, variant: number): boolean {
  switch (type) {
    case EntityType.PICKUP_HEALTH: {
      const amount = variant === 1 ? 100 : 25;
      const cap = variant === 1 ? MAX_OVERHEAL : MAX_HEALTH;
      if (body.health >= cap) return false;
      body.health = Math.min(cap, body.health + amount);
      return true;
    }
    case EntityType.PICKUP_ARMOR: {
      if (body.armor >= MAX_ARMOR) return false;
      body.armor = Math.min(MAX_ARMOR, body.armor + (variant === 1 ? 100 : 40));
      return true;
    }
    case EntityType.PICKUP_AMMO: {
      const t = variant >= 1 && variant <= AMMO_TYPE_SPAN ? variant : AmmoType.BULLETS;
      if (body.reserve[t] >= AMMO_MAX[t]) return false;
      body.reserve[t] = Math.min(AMMO_MAX[t], body.reserve[t] + Math.ceil(AMMO_MAX[t] * 0.25));
      return true;
    }
    case EntityType.PICKUP_WEAPON: {
      const w = variant % WEAPON_COUNT;
      const had = ownsWeapon(body.weaponMask, w);
      body.weaponMask = grantWeapon(body.weaponMask, w);
      const t = ammoTypeOf(w);
      if (!had) {
        body.mag[w] = getWeapon(w).magSize;
        if (t !== AmmoType.NONE) {
          body.reserve[t] = Math.min(AMMO_MAX[t], body.reserve[t] + getWeapon(w).magSize * 2);
        }
        return true;
      }
      if (t !== AmmoType.NONE && body.reserve[t] < AMMO_MAX[t]) {
        body.reserve[t] = Math.min(AMMO_MAX[t], body.reserve[t] + getWeapon(w).magSize);
        return true;
      }
      return false;
    }
    default:
      return false;
  }
}

/* ------------------------------------------------------------------------ *
 * Seats
 * ------------------------------------------------------------------------ */

/** One occupant of the match. Humans and bots use the same record. */
export interface DmSeat {
  id: number;
  name: string;
  isBot: boolean;
  body: DmBody;
  /** Room clock at which this seat was taken. */
  joinedMs: number;
  /** Counters when the seat was taken, so a mid-round join scores from zero. */
  baseKills: number;
  baseDeaths: number;
  /** Non-zero when a human took this seat from a bot: the bot's id. */
  replacedBotId: number;
  /** Colour index 0..7, stable for the life of the seat. Drives the scoreboard. */
  colour: number;
  /** Wall-clock ms at which this corpse will get up by itself. 0 when alive. */
  autoRespawnAtMs: number;
}

/** One row of the authoritative scoreboard. */
export interface DmScoreRow {
  id: number;
  name: string;
  bot: boolean;
  kills: number;
  deaths: number;
  /** Frags minus suicides, which is what actually decides the round. */
  score: number;
  streak: number;
  bestStreak: number;
  ping: number;
  dead: boolean;
  colour: number;
  rank: number;
  leader: boolean;
}

/** Something the room should tell the players about. */
export interface DmAnnouncement {
  kind: ModeEventKind;
  playerId: number;
  a: number;
  b: number;
  text: string;
  /** Which chat channel a room without the mode wire should fall back to. */
  channel: ChatChannel;
}

/* ------------------------------------------------------------------------ *
 * Director
 * ------------------------------------------------------------------------ */

export enum DmPhase {
  /** Bots are fighting, the clock is parked, and the arena is fully playable. */
  WARMUP = 0,
  LIVE = 1,
  INTERMISSION = 2,
}
export const DM_PHASE_NAMES: readonly string[] = Object.freeze(['warmup', 'live', 'intermission']);

/** `DmPhase` in the shared `ModePhase` vocabulary the state sidecar carries. */
export function modePhaseOf(phase: DmPhase): ModePhase {
  switch (phase) {
    case DmPhase.LIVE: return ModePhase.LIVE;
    case DmPhase.INTERMISSION: return ModePhase.INTERMISSION;
    default: return ModePhase.WAITING;
  }
}

export interface DeathmatchOptions {
  /** The resolved plan. Supplies duration, score limit, bot fill and max players. */
  plan: ModeSimPlan;
  sim: DmSim;
  world: DmWorld;
  /** Deterministic layout seed. Defaults to the plan's. */
  seed?: number;
  /** Overrides, mostly for tests. */
  durationMs?: number;
  scoreLimit?: number;
  botFill?: number;
  maxPlayers?: number;
  pickupCount?: number;
  /** Bot display names. Defaults to `BOT-01`… */
  nextBotName?: () => string;
  /** Free player id. Defaults to a counter that skips ids the sim already has. */
  allocateId?: () => number;
  /** Called after a bot body exists, so the room can attach its AI driver. */
  onBotAdded?: (id: number, body: DmBody) => void;
  /** Called after a bot body is gone, so the room can detach its AI driver. */
  onBotRemoved?: (id: number) => void;
  /** Announcements. The room turns these into chat and/or `S2C_MODE.EVENT`. */
  onAnnounce?: (a: DmAnnouncement) => void;
}

export interface DmJoinResult {
  seat: DmSeat;
  /** Id of the bot that gave up its slot, or 0 when the room simply had room. */
  replacedBotId: number;
  /** True when this join started a fresh round (the first human in the room). */
  startedRound: boolean;
}

/**
 * Owns the Deathmatch match. Constructed with the room, `start()`ed once, and
 * `step()`ed from the room's fixed tick. Nothing in `step` allocates.
 */
export class DeathmatchDirector {
  readonly plan: ModeSimPlan;
  readonly sim: DmSim;
  readonly world: DmWorld;
  readonly pickups: DmPickupField;

  readonly durationMs: number;
  readonly scoreLimit: number;
  readonly botFill: number;
  readonly maxPlayers: number;

  phase: DmPhase = DmPhase.WARMUP;
  /** Round number. 0 while the room has never had a human in it. */
  round = 0;
  /** Milliseconds left on the round clock. Frozen outside LIVE. */
  timeLeftMs: number;
  /** Milliseconds this round has been LIVE. */
  elapsedMs = 0;
  /** Room clock, advanced by `step`. Independent of `sim.nowMs` on purpose. */
  nowMs = 0;

  private readonly seats = new Map<number, DmSeat>();
  private readonly seed: number;
  private readonly nextBotName: () => string;
  private readonly allocateIdFn: () => number;
  private readonly onBotAdded: ((id: number, body: DmBody) => void) | null;
  private readonly onBotRemoved: ((id: number) => void) | null;
  private readonly onAnnounce: ((a: DmAnnouncement) => void) | null;

  private botTimerMs = 0;
  private intermissionEndsMs = 0;
  private nextIdCursor = 1;
  private botNameCursor = 0;
  private colourCursor = 0;
  private leaderId = 0;
  private leaderScore = 0;
  private started = false;
  /** Reused announcement record — `step` must not allocate. */
  private readonly ann: DmAnnouncement = {
    kind: ModeEventKind.OBJECTIVE, playerId: 0, a: 0, b: 0, text: '', channel: ChatChannel.SYSTEM,
  };

  constructor(options: DeathmatchOptions) {
    this.plan = options.plan;
    this.sim = options.sim;
    this.world = options.world;
    this.seed = (options.seed ?? options.plan.seed) >>> 0;

    this.durationMs = Math.max(0, options.durationMs ?? options.plan.durationMs ?? MATCH_DURATION_MS);
    this.scoreLimit = Math.max(0, options.scoreLimit ?? options.plan.scoreLimit ?? SCORE_LIMIT);
    this.maxPlayers = clamp(options.maxPlayers ?? options.plan.maxPlayers, 2, MAX_PLAYERS);
    this.botFill = clamp(options.botFill ?? options.plan.botFill, 0, this.maxPlayers);
    this.timeLeftMs = this.durationMs;

    this.pickups = new DmPickupField(this.seed, options.pickupCount ?? DM_PICKUP_COUNT);

    this.nextBotName = options.nextBotName ?? ((): string => {
      const n = ++this.botNameCursor;
      return `BOT-${n < 10 ? '0' : ''}${n}`;
    });
    this.allocateIdFn = options.allocateId ?? ((): number => this.defaultAllocateId());
    this.onBotAdded = options.onBotAdded ?? null;
    this.onBotRemoved = options.onBotRemoved ?? null;
    this.onAnnounce = options.onAnnounce ?? null;
  }

  /* -------------------------------------------------------------- *
   * Lifecycle
   * -------------------------------------------------------------- */

  /**
   * Furnish the arena and fill it with bots. Called at room construction,
   * BEFORE anybody has clicked anything — this is the line that deletes the
   * bar's twenty-five second wait, so it must never depend on a human.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Furnish the whole arena up front where the world allows it. A pass that
    // places nothing means the terrain is still streaming; `step` tops up.
    for (let pass = 0; pass < 8 && this.pickups.count < this.pickups.target; pass++) {
      if (this.pickups.seed(this.world) === 0) break;
    }
    this.pickups.spawnDue(this.sim, this.nowMs);
    // The whole fill up front: a room nobody has joined yet has no frame budget
    // to protect, and "populated on arrival" is the entire product claim.
    for (let i = this.bodyCount; i < this.botFill; i++) {
      if (!this.addBot()) break;
    }
    this.phase = DmPhase.WARMUP;
  }

  /** True once `start()` has run. */
  get isStarted(): boolean { return this.started; }

  /* -------------------------------------------------------------- *
   * Membership
   * -------------------------------------------------------------- */

  get humanCount(): number {
    let n = 0;
    for (const s of this.seats.values()) if (!s.isBot) n++;
    return n;
  }

  get botCount(): number {
    let n = 0;
    for (const s of this.seats.values()) if (s.isBot) n++;
    return n;
  }

  get bodyCount(): number { return this.seats.size; }

  /** Bodies the match wants right now: never fewer than the humans present. */
  get wantedBodies(): number {
    const humans = this.humanCount;
    return Math.min(this.maxPlayers, Math.max(humans, this.botFill));
  }

  seat(id: number): DmSeat | undefined { return this.seats.get(id); }
  seatIds(): number[] { return [...this.seats.keys()]; }

  /**
   * A human arrived. If the arena is at its body count, a bot gives up its
   * seat rather than the room growing — the fight the human drops into has
   * exactly the shape it had a tick earlier.
   */
  joinHuman(id: number, name: string, skin = 0): DmJoinResult | null {
    if (this.seats.has(id)) return null;
    if (this.humanCount >= this.maxPlayers) return null;

    let replacedBotId = 0;
    if (this.bodyCount >= this.wantedBodies || this.bodyCount >= this.maxPlayers) {
      replacedBotId = this.dropWorstBot();
      if (replacedBotId === 0 && this.bodyCount >= this.maxPlayers) return null;
    }

    const body = this.sim.addPlayer(id, name, skin, false);
    const seat = this.makeSeat(id, name, false, body);
    seat.replacedBotId = replacedBotId;
    this.seats.set(id, seat);

    // The first human in an idle room owns it: fresh scores, fresh clock. Every
    // later human joins the match already in progress and disturbs nothing.
    const startedRound = this.humanCount === 1 && this.phase !== DmPhase.INTERMISSION;
    if (startedRound) this.beginRound();
    else if (this.phase === DmPhase.WARMUP) this.phase = DmPhase.LIVE;

    this.announce(
      ModeEventKind.OBJECTIVE, id, replacedBotId, 0,
      replacedBotId !== 0 ? `${name} took a bot's slot` : `${name} joined`,
      ChatChannel.SYSTEM,
    );
    return { seat, replacedBotId, startedRound };
  }

  /** A body left — a socket closed, or a bot was recycled. */
  leave(id: number): boolean {
    const seat = this.seats.get(id);
    if (seat === undefined) return false;
    this.seats.delete(id);
    if (seat.isBot) this.onBotRemoved?.(id);
    this.sim.removePlayer(id);
    if (!seat.isBot) {
      this.announce(ModeEventKind.OBJECTIVE, id, 0, 0, `${seat.name} left`, ChatChannel.SYSTEM);
      // The last human out parks the clock again rather than burning the round
      // down for an audience of bots.
      if (this.humanCount === 0 && this.phase === DmPhase.LIVE) this.phase = DmPhase.WARMUP;
    }
    return true;
  }

  /* -------------------------------------------------------------- *
   * Bots
   * -------------------------------------------------------------- */

  private addBot(): boolean {
    if (this.bodyCount >= this.maxPlayers) return false;
    const id = this.allocateIdFn();
    if (id === 0) return false;
    const name = this.nextBotName();
    const body = this.sim.addPlayer(id, name, (id * 7) & 7, true);
    this.seats.set(id, this.makeSeat(id, name, true, body));
    this.onBotAdded?.(id, body);
    return true;
  }

  /**
   * Pick the bot with the least invested in the match and remove it. Never the
   * leader — losing the player who is winning rewrites the scoreboard the human
   * is about to look at — and dead bots go first, because nobody notices a
   * corpse failing to respawn.
   */
  private dropWorstBot(): number {
    let worst: DmSeat | null = null;
    let worstRank = Infinity;
    for (const s of this.seats.values()) {
      if (!s.isBot) continue;
      if (s.id === this.leaderId && this.leaderScore > 0) continue;
      const rank = (s.body.dead ? -1000 : 0) + s.body.kills * 10 - s.body.deaths;
      if (rank < worstRank) { worstRank = rank; worst = s; }
    }
    // Everybody left is the leader: take them anyway rather than refuse a human.
    if (worst === null) {
      for (const s of this.seats.values()) { if (s.isBot) { worst = s; break; } }
    }
    if (worst === null) return 0;
    const id = worst.id;
    this.seats.delete(id);
    this.onBotRemoved?.(id);
    this.sim.removePlayer(id);
    return id;
  }

  /** Keep the body count at `wantedBodies`, staggered so bots do not pop in. */
  private maintainBots(dtMs: number): void {
    if (this.botFill <= 0) return;
    this.botTimerMs -= dtMs;
    const want = this.wantedBodies;
    const have = this.bodyCount;
    if (have < want) {
      if (this.botTimerMs <= 0) {
        this.botTimerMs = DM_BOT_JOIN_INTERVAL_MS;
        this.addBot();
      }
    } else if (have > want && this.botCount > 0) {
      this.dropWorstBot();
    }
  }

  /* -------------------------------------------------------------- *
   * Rounds
   * -------------------------------------------------------------- */

  /** Zero every score and restart the clock. Only ever called with humans in. */
  beginRound(): void {
    this.round++;
    this.phase = DmPhase.LIVE;
    this.timeLeftMs = this.durationMs;
    this.elapsedMs = 0;
    this.leaderId = 0;
    this.leaderScore = 0;
    for (const s of this.seats.values()) {
      const b = s.body;
      b.kills = 0; b.deaths = 0; b.streak = 0; b.bestStreak = 0; b.damageDealt = 0;
      s.baseKills = 0;
      s.baseDeaths = 0;
      s.joinedMs = this.nowMs;
      s.autoRespawnAtMs = 0;
      this.sim.spawnPlayer(b);
    }
    this.announce(
      ModeEventKind.OBJECTIVE, 0, this.round, this.scoreLimit,
      this.round === 1 ? 'Match live. Go.' : `Round ${this.round}`,
      ChatChannel.SYSTEM,
    );
  }

  private endRound(reason: string): void {
    if (this.phase === DmPhase.INTERMISSION) return;
    this.phase = DmPhase.INTERMISSION;
    this.intermissionEndsMs = this.nowMs + DM_INTERMISSION_MS;
    const winner = this.seats.get(this.leaderId);
    this.announce(
      ModeEventKind.LEVEL_COMPLETE, this.leaderId, this.leaderScore, 0,
      winner !== undefined ? `${winner.name} wins with ${this.leaderScore} — ${reason}`
        : `Round over — ${reason}`,
      ChatChannel.SYSTEM,
    );
  }

  /** Frags minus suicides for one seat, which is what the round is decided on. */
  scoreOf(seat: DmSeat): number {
    return Math.max(0, seat.body.kills - seat.baseKills);
  }

  private updateLeader(): void {
    let bestId = 0;
    let best = -1;
    for (const s of this.seats.values()) {
      const score = this.scoreOf(s);
      if (score > best) { best = score; bestId = s.id; }
    }
    if (best < 0) { this.leaderId = 0; this.leaderScore = 0; return; }
    const changed = bestId !== this.leaderId
      && best >= this.leaderScore + DM_LEAD_ANNOUNCE_MARGIN
      && best > 0;
    this.leaderId = bestId;
    this.leaderScore = best;
    if (changed && this.phase === DmPhase.LIVE) {
      const s = this.seats.get(bestId);
      if (s !== undefined) {
        this.announce(ModeEventKind.PAYOUT, bestId, best, this.scoreLimit,
          `${s.name} takes the lead — ${best}`, ChatChannel.KILLFEED);
      }
    }
  }

  /* -------------------------------------------------------------- *
   * Respawn
   * -------------------------------------------------------------- */

  /**
   * A player asked to get up. Honoured only once the respawn floor has passed;
   * the floor is a pacing rule, not a prompt.
   */
  requestRespawn(id: number): boolean {
    const seat = this.seats.get(id);
    if (seat === undefined) return false;
    const b = seat.body;
    if (!b.dead) return false;
    if (this.sim.nowMs < b.respawnAtMs) return false;
    this.respawn(seat);
    return true;
  }

  private respawn(seat: DmSeat): void {
    this.sim.spawnPlayer(seat.body);
    seat.body.spawnProtectUntilMs = this.sim.nowMs + SPAWN_PROTECTION_MS;
    seat.autoRespawnAtMs = 0;
  }

  /**
   * Corpses that are eligible and have not asked get up by themselves. Bots go
   * the instant the floor passes; humans get a short grace so the death card is
   * readable, then stand up regardless. Staying dead is never a state the game
   * puts you in and leaves you in.
   */
  private updateRespawns(): void {
    const simNow = this.sim.nowMs;
    for (const s of this.seats.values()) {
      const b = s.body;
      if (!b.dead) { s.autoRespawnAtMs = 0; continue; }
      if (simNow < b.respawnAtMs) continue;
      if (s.isBot) { this.respawn(s); continue; }
      if (s.autoRespawnAtMs === 0) { s.autoRespawnAtMs = simNow + DM_AUTO_RESPAWN_MS; continue; }
      if (simNow >= s.autoRespawnAtMs) this.respawn(s);
    }
  }

  /* -------------------------------------------------------------- *
   * Tick
   * -------------------------------------------------------------- */

  /**
   * One room step. `dtMs` is the fixed tick; `sim.nowMs` has already been
   * advanced by the caller. Allocation-free.
   */
  step(dtMs: number): void {
    if (!this.started) this.start();
    this.nowMs += dtMs;

    // The arena keeps streaming in on a lazily generated world; top the layout
    // up until it is furnished, then stop looking.
    if (this.pickups.count < this.pickups.target) this.pickups.seed(this.world);
    this.pickups.update(this.sim, this.nowMs);

    this.maintainBots(dtMs);
    this.updateRespawns();
    this.updateLeader();

    switch (this.phase) {
      case DmPhase.WARMUP:
        // Playable, scored, and completely unhurried. The clock waits.
        if (this.humanCount > 0) this.beginRound();
        break;
      case DmPhase.LIVE: {
        if (this.humanCount === 0) { this.phase = DmPhase.WARMUP; break; }
        this.elapsedMs += dtMs;
        if (this.durationMs > 0) {
          this.timeLeftMs -= dtMs;
          if (this.timeLeftMs <= 0) { this.timeLeftMs = 0; this.endRound('time'); break; }
        }
        if (this.scoreLimit > 0 && this.leaderScore >= this.scoreLimit) this.endRound('frag limit');
        break;
      }
      case DmPhase.INTERMISSION:
        if (this.nowMs >= this.intermissionEndsMs) {
          if (this.humanCount > 0) this.beginRound();
          else { this.phase = DmPhase.WARMUP; this.timeLeftMs = this.durationMs; }
        }
        break;
      default:
        break;
    }
  }

  /* -------------------------------------------------------------- *
   * Read-outs
   * -------------------------------------------------------------- */

  /** True when the round has finished and the scoreboard is up. */
  get matchOver(): boolean { return this.phase === DmPhase.INTERMISSION; }
  get leader(): number { return this.leaderId; }
  get leaderFrags(): number { return this.leaderScore; }

  /**
   * Fill the room half of the mode-state sidecar. Field meanings for
   * Deathmatch, extending the table in `shared/src/modes.ts`:
   *   index   round number
   *   score   the leader's frags
   *   a/aTotal   leader frags / frag limit
   *   b/bTotal   humans / bodies      (the "3/6 players" chip)
   *   c/cTotal   pickups on the floor / pickup spots
   */
  roomState(out: ModeRoomState): ModeRoomState {
    out.phase = modePhaseOf(this.phase);
    out.phaseMsLeft = this.phase === DmPhase.INTERMISSION
      ? Math.max(0, this.intermissionEndsMs - this.nowMs)
      : Math.max(0, this.timeLeftMs);
    out.elapsedMs = this.elapsedMs;
    out.index = this.round;
    out.score = this.leaderScore;
    out.a = this.leaderScore;
    out.aTotal = this.scoreLimit;
    out.b = this.humanCount;
    out.bTotal = this.bodyCount;
    out.c = this.pickups.availableCount;
    out.cTotal = this.pickups.count;
    out.objectiveDone = this.phase === DmPhase.INTERMISSION;
    out.exitOpen = false;
    out.waveActive = this.phase === DmPhase.LIVE;
    out.failed = false;
    return out;
  }

  /** Highest score first. Allocates — call it for the UI and the status page. */
  scoreboard(): DmScoreRow[] {
    const rows: DmScoreRow[] = [];
    for (const s of this.seats.values()) {
      rows.push({
        id: s.id,
        name: s.name,
        bot: s.isBot,
        kills: Math.max(0, s.body.kills - s.baseKills),
        deaths: Math.max(0, s.body.deaths - s.baseDeaths),
        score: this.scoreOf(s),
        streak: s.body.streak,
        bestStreak: s.body.bestStreak,
        ping: Math.round(s.body.rttMs),
        dead: s.body.dead,
        colour: s.colour,
        rank: 0,
        leader: false,
      });
    }
    rows.sort((a, b) => (b.score - a.score) || (a.deaths - b.deaths) || (a.id - b.id));
    for (let i = 0; i < rows.length; i++) {
      rows[i].rank = i + 1;
      rows[i].leader = i === 0 && rows[i].score > 0;
    }
    return rows;
  }

  status(): Record<string, unknown> {
    return {
      mode: 'deathmatch',
      modeId: ModeId.DEATHMATCH,
      phase: DM_PHASE_NAMES[this.phase],
      round: this.round,
      timeLeftMs: Math.round(this.timeLeftMs),
      elapsedMs: Math.round(this.elapsedMs),
      humans: this.humanCount,
      bots: this.botCount,
      bodies: this.bodyCount,
      wantedBodies: this.wantedBodies,
      leader: this.leaderId,
      leaderFrags: this.leaderScore,
      scoreLimit: this.scoreLimit,
      pickups: this.pickups.count,
      pickupsAvailable: this.pickups.availableCount,
    };
  }

  /* -------------------------------------------------------------- *
   * Internals
   * -------------------------------------------------------------- */

  private makeSeat(id: number, name: string, isBot: boolean, body: DmBody): DmSeat {
    const colour = this.colourCursor++ & 7;
    return {
      id,
      name,
      isBot,
      body,
      joinedMs: this.nowMs,
      baseKills: body.kills,
      baseDeaths: body.deaths,
      replacedBotId: 0,
      colour,
      autoRespawnAtMs: 0,
    };
  }

  private defaultAllocateId(): number {
    for (let i = 0; i < 65535; i++) {
      const id = this.nextIdCursor;
      this.nextIdCursor = this.nextIdCursor >= 65535 ? 1 : this.nextIdCursor + 1;
      if (this.sim.getPlayer(id) === undefined && !this.seats.has(id)) return id;
    }
    return 0;
  }

  private announce(
    kind: ModeEventKind, playerId: number, a: number, b: number, text: string, channel: ChatChannel,
  ): void {
    if (this.onAnnounce === null) return;
    const ann = this.ann;
    ann.kind = kind;
    ann.playerId = playerId;
    ann.a = a;
    ann.b = b;
    ann.text = text;
    ann.channel = channel;
    this.onAnnounce(ann);
  }
}

/* ------------------------------------------------------------------------ *
 * Convenience
 * ------------------------------------------------------------------------ */

/**
 * Milliseconds a body must still wait before it may respawn. Negative means it
 * is already eligible. The client renders this as the death-card countdown.
 */
export function respawnWaitMs(body: DmBody, simNowMs: number): number {
  return body.dead ? body.respawnAtMs - simNowMs : 0;
}

/** True while a body is still under spawn protection. */
export function isSpawnProtected(body: DmBody, simNowMs: number): boolean {
  return !body.dead && body.spawnProtectUntilMs > simNowMs;
}

/** The respawn floor a Deathmatch body waits out. Exported for the client HUD. */
export const DM_RESPAWN_DELAY_MS = RESPAWN_DELAY_MS;
/** Spawn protection window, exported so the client can draw the same shield. */
export const DM_SPAWN_PROTECT_MS = SPAWN_PROTECTION_MS;
