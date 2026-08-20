/**
 * DOOMCRAFT — server-side mode rules.
 *
 * `shared/src/modes.ts` says WHAT each mode is. This file turns that table into
 * the three things a server actually needs:
 *
 *   1. **A sim plan** — which systems tick. `resolveModePlan` expands the
 *      `ModeDef.systems` bitmask plus the join request into a flat struct of
 *      booleans and numbers. The room reads `plan.runWaveDirector`; it never
 *      asks "is this Horde?". Adding a mode cannot miss a branch, because
 *      there are no branches to miss.
 *   2. **Join routing** — which room a request lands in. Deathmatch and Horde
 *      share instances; Quest is keyed by level and skill and Builder by world,
 *      so two people who pick the same content end up in the same session.
 *      `ModeRouter` owns the room table, creates on demand through an injected
 *      factory (so this file never imports `Room` at runtime) and reaps rooms
 *      that have been empty for a while.
 *   3. **Per-mode room configuration** — a `RoomOptions` object, ready to hand
 *      to the existing constructor, with the monster budget, bot fill, weapon
 *      grant and world source already decided.
 *
 * The per-mode snapshot sidecar is also assembled here: `ModeStateTracker`
 * keeps one `ModeStateBuffer` per client, compares it against the previous one
 * and reports whether a packet is worth sending this tick.
 */

import {
  MATCH_DURATION_MS,
  MAX_PLAYERS,
  clamp,
} from '@doomcraft/shared';
import {
  BuildPolicy,
  BreakPolicy,
  EnemyPolicy,
  KeyColor,
  MODE_KEYS,
  ModeId,
  ModePhase,
  MSF_COOP,
  MSF_FRESH,
  MSF_NO_BOTS,
  MST_CAN_BUILD,
  MST_EXIT_OPEN,
  MST_FAILED,
  MST_LOCAL_FINISHED,
  MST_MONSTERS_RESPAWN,
  MST_OBJECTIVE_DONE,
  MST_WAVE_ACTIVE,
  ModeStateBuffer,
  PvpPolicy,
  RespawnPolicy,
  RoundStructure,
  SKILL_ENEMY_BONUS,
  SKILL_ENEMY_INTERVAL,
  SKILL_RESPAWN_MONSTERS,
  SYS_BLOCK_ECONOMY,
  SYS_BOTS,
  SYS_FALL_DAMAGE,
  SYS_HAZARDS,
  SYS_INTERMISSION,
  SYS_KILLFEED,
  SYS_LEVEL_SCRIPT,
  SYS_MONSTERS,
  SYS_MONSTER_DIRECTOR,
  SYS_PICKUPS,
  SYS_PVP_DAMAGE,
  SYS_ROUND_TIMER,
  SYS_SCORE_LIMIT,
  SYS_TERRAIN_DAMAGE,
  SYS_WAVE_DIRECTOR,
  SYS_WORLD_PERSISTENCE,
  WorldSource,
  clampSkill,
  createModeSelectMessage,
  getMode,
  hasSystem,
  isModeId,
  legacyGameMode,
  modeStateChanged,
  roomKeyFor,
  sanitiseContentId,
  systemNames,
  type ModeDef,
  type ModeSelectMessage,
} from '@doomcraft/shared/modes';

import type { RoomOptions } from './room.js';

/* ------------------------------------------------------------------------ *
 * Join request
 * ------------------------------------------------------------------------ */

/**
 * A `C2S_MODE.SELECT` after every field has been clamped and every id checked
 * against what is actually installed. Nothing downstream re-validates.
 */
export interface ModeJoinRequest {
  modeId: ModeId;
  skill: number;
  levelId: string;
  worldId: string;
  seed: number;
  flags: number;
}

/** What `sanitiseJoin` needs to know about the installed content. */
export interface ContentResolver {
  /** Map a requested level id to one that exists and validates. '' when none. */
  resolveId(requested: string): string;
}

/**
 * Clamp and resolve. `decodeModeSelect` has already made the strings safe
 * slugs; this step decides whether the *content* exists and drops a request for
 * an authored level onto a level that is actually installed.
 */
export function sanitiseJoin(msg: ModeSelectMessage, levels?: ContentResolver | null): ModeJoinRequest {
  const modeId = isModeId(msg.modeId) ? msg.modeId : ModeId.DEATHMATCH;
  const def = getMode(modeId);
  let levelId = sanitiseContentId(msg.levelId);
  if (def.world === WorldSource.AUTHORED) {
    levelId = levels != null ? levels.resolveId(levelId) : levelId;
  } else {
    levelId = '';
  }
  const worldId = def.world === WorldSource.PERSISTENT ? sanitiseContentId(msg.worldId) : '';
  return {
    modeId,
    skill: clampSkill(msg.skill),
    levelId,
    worldId,
    seed: msg.seed >>> 0,
    flags: msg.flags & 0xffff,
  };
}

/** A join request straight from a mode id, for tests and for `?mode=` boots. */
export function joinRequestFor(modeId: ModeId, levelId = '', worldId = '', skill = 2, seed = 0): ModeJoinRequest {
  return { modeId, skill: clampSkill(skill), levelId, worldId, seed: seed >>> 0, flags: 0 };
}

/** Build the wire message a client would have sent for this request. */
export function toSelectMessage(req: ModeJoinRequest): ModeSelectMessage {
  const m = createModeSelectMessage();
  m.modeId = req.modeId;
  m.skill = req.skill;
  m.flags = req.flags;
  m.seed = req.seed;
  m.levelId = req.levelId;
  m.worldId = req.worldId;
  return m;
}

/* ------------------------------------------------------------------------ *
 * Sim plan
 * ------------------------------------------------------------------------ */

/**
 * The flat, per-room answer to "what runs this tick". Every field is decided
 * once at room construction; the tick loop only reads booleans.
 */
export interface ModeSimPlan {
  readonly modeId: ModeId;
  readonly key: string;
  readonly def: ModeDef;

  /* --- systems --- */
  readonly runBots: boolean;
  readonly runMonsters: boolean;
  readonly runMonsterDirector: boolean;
  readonly runWaveDirector: boolean;
  readonly runPickups: boolean;
  readonly runRoundTimer: boolean;
  readonly runScoreLimit: boolean;
  readonly runBlockEconomy: boolean;
  readonly runLevelScript: boolean;
  readonly runWorldPersistence: boolean;
  readonly runIntermission: boolean;

  /* --- permissions --- */
  readonly allowPvp: boolean;
  readonly allowFriendlyFire: boolean;
  readonly allowPlacing: boolean;
  readonly allowBreaking: boolean;
  readonly instantBreak: boolean;
  readonly allowTerrainDamage: boolean;
  readonly fallDamage: boolean;
  readonly hazards: boolean;
  readonly killfeed: boolean;
  readonly creativeFlight: boolean;

  /* --- numbers --- */
  readonly botFill: number;
  readonly enemyBudget: number;
  readonly enemySpawnIntervalMs: number;
  readonly enemyMaxTier: number;
  readonly monstersRespawn: boolean;
  readonly durationMs: number;
  readonly scoreLimit: number;
  readonly respawnPolicy: RespawnPolicy;
  readonly respawnDelayMs: number;
  readonly buildPhaseMs: number;
  readonly buildDuringCombat: boolean;
  readonly blockBudget: number;
  readonly finalWave: number;
  readonly maxPlayers: number;
  readonly startWeaponMask: number;
  readonly startWeapon: number;
  readonly grantAllWeapons: boolean;

  /* --- content --- */
  readonly worldSource: WorldSource;
  readonly levelId: string;
  readonly worldId: string;
  readonly seed: number;
  readonly skill: number;
  readonly coop: boolean;
  readonly fresh: boolean;
}

/** Numeric knobs a caller may override, e.g. from an env var or a test. */
export interface ModePlanOverrides {
  botFill?: number;
  enemyBudget?: number;
  durationMs?: number;
  scoreLimit?: number;
  maxPlayers?: number;
  buildPhaseMs?: number;
  blockBudget?: number;
  grantAllWeapons?: boolean;
  seed?: number;
}

/** Milliseconds between ambient monster spawns, per mode. */
const AMBIENT_SPAWN_MS = 2200;
const HORDE_SPAWN_MS = 900;
/** Highest monster tier the director may pick. */
const DEFAULT_MAX_TIER = 4;
const HORDE_START_TIER = 2;

/**
 * Expand a validated join request into the plan the room ticks against. This
 * is the ONLY place a `ModeDef` is read for behaviour.
 */
export function resolveModePlan(req: ModeJoinRequest, overrides: ModePlanOverrides = {}): ModeSimPlan {
  const def = getMode(req.modeId);
  const sys = def.systems;
  const skill = clampSkill(req.skill);
  const coop = (req.flags & MSF_COOP) !== 0;
  const noBots = (req.flags & MSF_NO_BOTS) !== 0;

  const authoredEnemies = def.enemies === EnemyPolicy.AUTHORED;
  const baseBudget = overrides.enemyBudget ?? def.enemyBudget;
  const budget = authoredEnemies || baseBudget < 0
    ? -1
    : Math.round(baseBudget * (1 + SKILL_ENEMY_BONUS[skill]));

  return {
    modeId: def.id,
    key: def.key,
    def,

    runBots: hasSystem(sys, SYS_BOTS) && !noBots && (overrides.botFill ?? def.botFill) > 0,
    runMonsters: hasSystem(sys, SYS_MONSTERS),
    runMonsterDirector: hasSystem(sys, SYS_MONSTER_DIRECTOR),
    runWaveDirector: hasSystem(sys, SYS_WAVE_DIRECTOR),
    runPickups: hasSystem(sys, SYS_PICKUPS),
    runRoundTimer: hasSystem(sys, SYS_ROUND_TIMER),
    runScoreLimit: hasSystem(sys, SYS_SCORE_LIMIT),
    runBlockEconomy: hasSystem(sys, SYS_BLOCK_ECONOMY),
    runLevelScript: hasSystem(sys, SYS_LEVEL_SCRIPT),
    runWorldPersistence: hasSystem(sys, SYS_WORLD_PERSISTENCE),
    runIntermission: hasSystem(sys, SYS_INTERMISSION),

    allowPvp: hasSystem(sys, SYS_PVP_DAMAGE) && def.pvp === PvpPolicy.FREE_FOR_ALL,
    allowFriendlyFire: def.pvp === PvpPolicy.FREE_FOR_ALL,
    allowPlacing: def.build !== BuildPolicy.NONE,
    allowBreaking: def.break !== BreakPolicy.NONE,
    instantBreak: def.break === BreakPolicy.INSTANT,
    allowTerrainDamage: hasSystem(sys, SYS_TERRAIN_DAMAGE),
    fallDamage: hasSystem(sys, SYS_FALL_DAMAGE),
    hazards: hasSystem(sys, SYS_HAZARDS),
    killfeed: hasSystem(sys, SYS_KILLFEED),
    creativeFlight: def.creativeFlight,

    botFill: noBots ? 0 : clamp(overrides.botFill ?? def.botFill, 0, MAX_PLAYERS),
    enemyBudget: budget,
    enemySpawnIntervalMs: Math.round(
      (def.enemies === EnemyPolicy.WAVES ? HORDE_SPAWN_MS : AMBIENT_SPAWN_MS) * SKILL_ENEMY_INTERVAL[skill],
    ),
    enemyMaxTier: def.enemies === EnemyPolicy.WAVES ? HORDE_START_TIER : DEFAULT_MAX_TIER,
    monstersRespawn: SKILL_RESPAWN_MONSTERS[skill] === 1,

    durationMs: Math.max(0, overrides.durationMs ?? def.durationMs),
    scoreLimit: Math.max(0, overrides.scoreLimit ?? def.scoreLimit),
    respawnPolicy: def.respawn,
    respawnDelayMs: def.respawnDelayMs,
    buildPhaseMs: Math.max(0, overrides.buildPhaseMs ?? def.buildPhaseMs),
    buildDuringCombat: def.buildDuringCombat,
    blockBudget: Math.max(0, overrides.blockBudget ?? def.blockBudget),
    finalWave: def.finalWave,
    maxPlayers: clamp(overrides.maxPlayers ?? def.maxPlayers, 1, MAX_PLAYERS),
    startWeaponMask: def.startWeaponMask,
    startWeapon: def.startWeapon,
    grantAllWeapons: overrides.grantAllWeapons ?? (def.build === BuildPolicy.CREATIVE),

    worldSource: def.world,
    levelId: req.levelId,
    worldId: req.worldId,
    seed: (overrides.seed ?? req.seed) >>> 0,
    skill,
    coop: coop || def.coopPlayers > 1,
    fresh: (req.flags & MSF_FRESH) !== 0,
  };
}

/** Human-readable systems list, for `/api/status`. */
export function describePlan(plan: ModeSimPlan): Record<string, unknown> {
  return {
    mode: plan.key,
    skill: plan.skill,
    levelId: plan.levelId,
    worldId: plan.worldId,
    seed: plan.seed,
    maxPlayers: plan.maxPlayers,
    botFill: plan.botFill,
    enemyBudget: plan.enemyBudget,
    systems: systemNames(plan.def.systems),
  };
}

/* ------------------------------------------------------------------------ *
 * Room configuration
 * ------------------------------------------------------------------------ */

/**
 * A `RoomOptions` for this plan. The room keeps its own three-way `GameMode`
 * (that enum is frozen); the plan carries every rule the mode layer adds on top.
 */
export function roomOptionsFor(plan: ModeSimPlan, extra: Partial<RoomOptions> = {}): RoomOptions {
  return {
    seed: plan.seed !== 0 ? plan.seed : undefined,
    mode: legacyGameMode(plan.modeId),
    maxPlayers: plan.maxPlayers,
    botFill: plan.botFill,
    enemies: plan.enemyBudget,
    // An authored Quest level replaces the terrain anyway; generating all 169
    // chunks first would just be thrown away, so trickle instead.
    eagerWorld: plan.worldSource !== WorldSource.AUTHORED,
    allWeapons: plan.grantAllWeapons,
    name: `${plan.key}-${plan.levelId || plan.worldId || 'default'}`,
    ...extra,
  };
}

/** The three fields `MonsterManager.budget` exposes, described structurally. */
export interface MonsterBudgetLike {
  target: number;
  spawnIntervalMs: number;
  maxTier: number;
}

/** Point a monster budget at the plan. Authored levels get target 0 — the level places them. */
export function applyMonsterBudget(plan: ModeSimPlan, budget: MonsterBudgetLike): void {
  if (!plan.runMonsters) {
    budget.target = 0;
    return;
  }
  budget.target = plan.enemyBudget < 0 ? 0 : plan.enemyBudget;
  budget.spawnIntervalMs = plan.enemySpawnIntervalMs;
  budget.maxTier = plan.enemyMaxTier;
}

/**
 * Wave N's monster target and tier ceiling. Doubling roughly every six waves
 * keeps the fortify phase meaningful without an unwinnable cliff.
 */
export function waveBudget(plan: ModeSimPlan, wave: number): { target: number; maxTier: number; payout: number } {
  const w = Math.max(1, wave | 0);
  const base = 4 + Math.round(w * 1.8 + w * w * 0.06);
  const target = clamp(Math.round(base * (1 + SKILL_ENEMY_BONUS[plan.skill])), 1, 40);
  const maxTier = clamp(1 + Math.floor(w / 3), 1, 4);
  return { target, maxTier, payout: 40 + w * 18 };
}

/** Blocks a player is handed at the start of a build phase. */
export function buildPhaseBudget(plan: ModeSimPlan, wave: number): number {
  if (plan.blockBudget <= 0) return 0;
  return plan.blockBudget + Math.min(240, (wave | 0) * 10);
}

/** True when this edit is legal right now, given the plan and the phase. */
export function canPlaceBlock(plan: ModeSimPlan, phase: ModePhase, budgetLeft: number): boolean {
  if (!plan.allowPlacing) return false;
  if (plan.def.build === BuildPolicy.CREATIVE) return true;
  if (plan.def.build === BuildPolicy.PHASED) {
    if (phase !== ModePhase.BUILD && !plan.buildDuringCombat) return false;
    return plan.blockBudget <= 0 || budgetLeft > 0;
  }
  return true;
}

/** True when a shot from `attacker` may damage `victim`. */
export function canDamagePlayer(plan: ModeSimPlan, attackerId: number, victimId: number): boolean {
  if (attackerId === victimId) return true;   // self-damage / rocket jumps always apply
  return plan.allowPvp;
}

/* ------------------------------------------------------------------------ *
 * Join routing
 * ------------------------------------------------------------------------ */

/** The little a router needs from a room. `Room` satisfies this structurally. */
export interface RoomLike {
  readonly maxPlayers: number;
  readonly humanCount: number;
  status(): Record<string, unknown>;
  stop(): void;
}

export interface ModeRouterOptions<T extends RoomLike> {
  /** Build a room. Called only when no existing room can take the request. */
  create(key: string, plan: ModeSimPlan, options: RoomOptions): T;
  /** Wall clock, ms. */
  clock?: () => number;
  /** How long a room with no humans lingers before it is reaped. */
  idleMs?: number;
  /** Hard cap on live rooms. A request past the cap reuses the fullest room. */
  maxRooms?: number;
  /** Applied to every plan this router builds. */
  overrides?: ModePlanOverrides;
  /** Resolves level ids against installed content. */
  levels?: ContentResolver | null;
}

export interface RoutedRoom<T extends RoomLike> {
  key: string;
  room: T;
  plan: ModeSimPlan;
  /** True when this call constructed the room. */
  created: boolean;
}

interface RoomSlot<T extends RoomLike> {
  key: string;
  room: T;
  plan: ModeSimPlan;
  createdMs: number;
  /** Wall clock at which the room last had a human in it. */
  lastOccupiedMs: number;
}

export const DEFAULT_ROOM_IDLE_MS = 120_000;
export const DEFAULT_MAX_ROOMS = 32;

/**
 * Owns the room table. One key per playable "place": `deathmatch`,
 * `horde`, `quest:e1m1-hangar:3`, `builder:world1`. Instances of a shared key
 * get a `#2` suffix when the first one is full.
 */
export class ModeRouter<T extends RoomLike> {
  private readonly slots = new Map<string, RoomSlot<T>>();
  private readonly create: (key: string, plan: ModeSimPlan, options: RoomOptions) => T;
  private readonly clock: () => number;
  private readonly idleMs: number;
  private readonly maxRooms: number;
  private readonly overrides: ModePlanOverrides;
  private readonly levels: ContentResolver | null;

  constructor(options: ModeRouterOptions<T>) {
    this.create = options.create;
    this.clock = options.clock ?? (() => Date.now());
    this.idleMs = options.idleMs ?? DEFAULT_ROOM_IDLE_MS;
    this.maxRooms = Math.max(1, options.maxRooms ?? DEFAULT_MAX_ROOMS);
    this.overrides = options.overrides ?? {};
    this.levels = options.levels ?? null;
  }

  get size(): number { return this.slots.size; }
  keys(): string[] { return [...this.slots.keys()]; }
  get(key: string): T | null { return this.slots.get(key)?.room ?? null; }
  planOf(key: string): ModeSimPlan | null { return this.slots.get(key)?.plan ?? null; }

  /** Route a raw wire message. Sanitises, plans and finds or creates a room. */
  routeMessage(msg: ModeSelectMessage): RoutedRoom<T> {
    return this.route(sanitiseJoin(msg, this.levels));
  }

  /** Route a sanitised request. */
  route(req: ModeJoinRequest): RoutedRoom<T> {
    const plan = resolveModePlan(req, this.overrides);
    const base = roomKeyFor(toSelectMessage(req));

    // A key with room for one more human wins. Quest and Builder are keyed by
    // content, so this is also how two friends land in the same session.
    for (let n = 0; n < this.maxRooms; n++) {
      const key = n === 0 ? base : `${base}#${n + 1}`;
      const slot = this.slots.get(key);
      if (slot === undefined) {
        if (this.slots.size >= this.maxRooms) break;
        const room = this.create(key, plan, roomOptionsFor(plan));
        const now = this.clock();
        this.slots.set(key, { key, room, plan, createdMs: now, lastOccupiedMs: now });
        return { key, room, plan, created: true };
      }
      if (slot.room.humanCount < slot.room.maxPlayers) {
        slot.lastOccupiedMs = this.clock();
        return { key, room: slot.room, plan: slot.plan, created: false };
      }
    }

    // Every instance is full and the cap is reached: give back the emptiest one
    // rather than refusing a player outright.
    let best: RoomSlot<T> | null = null;
    for (const slot of this.slots.values()) {
      if (best === null || slot.room.humanCount < best.room.humanCount) best = slot;
    }
    if (best === null) throw new Error('ModeRouter: maxRooms is zero');
    return { key: best.key, room: best.room, plan: best.plan, created: false };
  }

  /** Note that a room currently has players, so the reaper leaves it alone. */
  touch(key: string): void {
    const slot = this.slots.get(key);
    if (slot !== undefined) slot.lastOccupiedMs = this.clock();
  }

  /**
   * Stop and forget rooms that have had no humans for `idleMs`. Returns how
   * many were reaped. Call this on a timer; it is cheap and idempotent.
   */
  sweep(): number {
    const now = this.clock();
    let reaped = 0;
    for (const [key, slot] of [...this.slots]) {
      if (slot.room.humanCount > 0) { slot.lastOccupiedMs = now; continue; }
      if (now - slot.lastOccupiedMs < this.idleMs) continue;
      try { slot.room.stop(); } catch { /* a room that will not stop is still forgotten */ }
      this.slots.delete(key);
      reaped++;
    }
    return reaped;
  }

  /** Stop every room. Called on shutdown. */
  stopAll(): void {
    for (const slot of this.slots.values()) {
      try { slot.room.stop(); } catch { /* best effort */ }
    }
    this.slots.clear();
  }

  status(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const slot of this.slots.values()) {
      out.push({
        key: slot.key,
        mode: MODE_KEYS[slot.plan.modeId],
        ageMs: this.clock() - slot.createdMs,
        ...slot.room.status(),
      });
    }
    return out;
  }
}

/* ------------------------------------------------------------------------ *
 * State sidecar
 * ------------------------------------------------------------------------ */

/** The room-wide facts the tracker folds into every client's state record. */
export interface ModeRoomState {
  phase: ModePhase;
  phaseMsLeft: number;
  elapsedMs: number;
  /** Level index, wave number or round number. */
  index: number;
  /** Currency, blocks placed, or the leading score. */
  score: number;
  /** Kills / total, items / total, secrets / total. */
  a: number; aTotal: number;
  b: number; bTotal: number;
  c: number; cTotal: number;
  objectiveDone: boolean;
  exitOpen: boolean;
  waveActive: boolean;
  failed: boolean;
}

export function createModeRoomState(): ModeRoomState {
  return {
    phase: ModePhase.LOADING, phaseMsLeft: 0, elapsedMs: 0, index: 0, score: 0,
    a: 0, aTotal: 0, b: 0, bTotal: 0, c: 0, cTotal: 0,
    objectiveDone: false, exitOpen: false, waveActive: false, failed: false,
  };
}

/** Per-player facts that differ between clients in the same room. */
export interface ModePlayerState {
  keys: number;
  budget: number;
  lives: number;
  ackActionSeq: number;
  finished: boolean;
}

export function createModePlayerState(): ModePlayerState {
  return { keys: 0, budget: 0, lives: 255, ackActionSeq: 0, finished: false };
}

/**
 * Keeps the last state sent to each client and answers "is a packet worth
 * sending". Two buffers per client, reused forever — nothing here allocates
 * after the client is registered.
 */
export class ModeStateTracker {
  private readonly plan: ModeSimPlan;
  private readonly next = new Map<number, ModeStateBuffer>();
  private readonly last = new Map<number, ModeStateBuffer>();

  constructor(plan: ModeSimPlan) {
    this.plan = plan;
  }

  /** Allocate the pair of buffers for a client. Idempotent. */
  add(playerId: number): void {
    if (this.next.has(playerId)) return;
    this.next.set(playerId, new ModeStateBuffer());
    const seen = new ModeStateBuffer();
    // A fresh baseline that cannot equal any real state, so the first compose
    // always produces a packet.
    seen.phase = ModePhase.GAME_OVER;
    seen.lives = 254;
    this.last.set(playerId, seen);
  }

  remove(playerId: number): void {
    this.next.delete(playerId);
    this.last.delete(playerId);
  }

  clear(): void {
    this.next.clear();
    this.last.clear();
  }

  /**
   * Fill this client's buffer from the room state and their own state. Returns
   * the buffer when something changed and it should go on the wire, else null.
   */
  compose(playerId: number, room: ModeRoomState, player: ModePlayerState): ModeStateBuffer | null {
    const s = this.next.get(playerId);
    const prev = this.last.get(playerId);
    if (s === undefined || prev === undefined) return null;

    s.modeId = this.plan.modeId;
    s.phase = room.phase;
    s.skill = this.plan.skill;
    s.phaseMsLeft = room.phaseMsLeft;
    s.elapsedMs = room.elapsedMs;
    s.index = room.index;
    s.score = room.score;
    s.a = room.a; s.aTotal = room.aTotal;
    s.b = room.b; s.bTotal = room.bTotal;
    s.c = room.c; s.cTotal = room.cTotal;
    s.budget = player.budget;
    s.keys = player.keys;
    s.lives = player.lives;
    s.ackActionSeq = player.ackActionSeq;

    let flags = 0;
    if (player.finished) flags |= MST_LOCAL_FINISHED;
    if (room.objectiveDone) flags |= MST_OBJECTIVE_DONE;
    if (room.failed) flags |= MST_FAILED;
    if (canPlaceBlock(this.plan, room.phase, player.budget)) flags |= MST_CAN_BUILD;
    if (room.waveActive) flags |= MST_WAVE_ACTIVE;
    if (room.exitOpen) flags |= MST_EXIT_OPEN;
    if (this.plan.monstersRespawn) flags |= MST_MONSTERS_RESPAWN;
    s.flags = flags;

    if (!modeStateChanged(s, prev)) return null;
    prev.copyFrom(s);
    return s;
  }

  /** Force the next `compose` for this client to emit, e.g. after a reconnect. */
  invalidate(playerId: number): void {
    const prev = this.last.get(playerId);
    if (prev === undefined) return;
    prev.phase = ModePhase.GAME_OVER;
    prev.lives = 254;
  }
}

/* ------------------------------------------------------------------------ *
 * Phase machine helpers
 * ------------------------------------------------------------------------ */

/** The phase a room should be in, given its plan and what is happening. */
export function nextPhase(
  plan: ModeSimPlan, current: ModePhase,
  opts: { worldReady: boolean; humans: number; objectiveDone: boolean; failed: boolean; buildMsLeft: number },
): ModePhase {
  if (!opts.worldReady) return ModePhase.LOADING;
  if (opts.failed) return ModePhase.GAME_OVER;
  if (opts.objectiveDone) return plan.runIntermission ? ModePhase.INTERMISSION : ModePhase.GAME_OVER;
  if (plan.def.round === RoundStructure.WAVES && opts.buildMsLeft > 0) return ModePhase.BUILD;
  // Deathmatch holds its clock until a human turns up; Quest and Builder do not
  // wait for anybody.
  if (plan.def.round === RoundStructure.TIMED && opts.humans === 0) return ModePhase.WAITING;
  if (current === ModePhase.LOADING) return ModePhase.LIVE;
  return ModePhase.LIVE;
}

/** Seconds on the round clock, or 0 when the mode has none. */
export function roundClockMs(plan: ModeSimPlan, elapsedMs: number): number {
  if (plan.durationMs <= 0) return 0;
  const left = plan.durationMs - elapsedMs;
  return left < 0 ? 0 : left;
}

/** Doom's key ring: cleared at the start of every level. */
export function clearKeys(): number { return 0; }
export function grantKey(mask: number, colour: KeyColor): number {
  return colour === KeyColor.NONE ? mask : mask | (1 << (colour - 1));
}

/** Default room configuration used when nothing at all was requested. */
export const DEFAULT_JOIN: ModeJoinRequest = Object.freeze({
  modeId: ModeId.DEATHMATCH,
  skill: 2,
  levelId: '',
  worldId: '',
  seed: 0,
  flags: 0,
});

/** A plan for the process-wide default room, matching the pre-mode behaviour. */
export function defaultPlan(overrides: ModePlanOverrides = {}): ModeSimPlan {
  return resolveModePlan(DEFAULT_JOIN, { durationMs: MATCH_DURATION_MS, ...overrides });
}
