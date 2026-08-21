/**
 * DOOMCRAFT — a match.
 *
 * The bar makes you wait roughly 25 seconds for players. We do the opposite:
 * a Room is LIVE from the instant it is constructed, pre-filled with bots and
 * with the spawn chunks already generated, so the path from "click play" to
 * "shooting something" is a socket handshake and one chunk burst. Humans take
 * bot slots as they arrive.
 *
 * Fixed 20 Hz accumulator tick. Deterministic given the seed and the input
 * stream. No node:*, no ws — the same class runs inside the client's worker.
 */

import {
  BOT_FILL_TARGET,
  BOT_SPAWN_DELAY_MS,
  ChatChannel,
  DEFAULT_GAME_MODE,
  EntityType,
  GameMode,
  MATCH_DURATION_MS,
  MAX_PLAYERS,
  SCORE_LIMIT,
  TICK_MS,
  WORLD_MIN_BLOCK_X,
  WORLD_MIN_BLOCK_Z,
  WORLD_SIZE_BLOCKS,
  ALL_WEAPON_MASK,
  AMMO_MAX,
  MAX_HEALTH,
  SPAWN_PROTECTION_MS,
  WEAPON_COUNT,
  getWeapon,
  XP_PER_KILL,
  XP_PER_MINUTE,
  XP_PER_WIN,
  Rng,
  clamp,
} from '@doomcraft/shared';
import {
  ModeAction,
  ModeEventKind,
  ModeId,
  ModePhase,
  MODE_KEYS,
  createModeContextMessage,
  createModeEventMessage,
  getMode,
  legacyGameMode,
  type ModeActionMessage,
  type ModeContextMessage,
  type ModeEventMessage,
  type ModeSelectMessage,
} from '@doomcraft/shared/modes';
import { BotDriver, MonsterManager, botSkillFor } from './bots.js';
import { HordeDirector } from './horde.js';
import {
  ModeStateTracker,
  applyMonsterBudget,
  createModePlayerState,
  createModeRoomState,
  defaultPlan,
  resolveModePlan,
  sanitiseJoin,
  type ContentResolver,
  type ModePlayerState,
  type ModeRoomState,
  type ModeSimPlan,
} from './modes.js';
import { Connection, NetHub, sanitiseChat } from './net.js';
import type { NetHost, NetTransport } from './net.js';
import type { MatchResult, PersistenceStore } from './persistence.js';
import { applyMatchResult } from './persistence.js';
import { PlayerEntity, Simulation } from './sim.js';
import { ServerWorld } from './world.js';

export enum RoundState {
  /** Bots only, clock stopped, waiting for a human. Never blocks play. */
  IDLE = 0,
  LIVE = 1,
  ENDED = 2,
}

export const ROUND_STATE_NAMES: readonly string[] = ['idle', 'live', 'ended'];

/** How long the scoreboard stays up before the next round starts. */
export const END_SCREEN_MS = 8000;
/** Seconds between a pickup being taken and it coming back. */
export const PICKUP_RESPAWN_MS = 22000;
/** Pickup spots placed at world generation. */
export const PICKUP_COUNT = 28;
/** Ticks the room may catch up in one `advance` call before it gives up. */
export const MAX_CATCHUP_TICKS = 8;
/** Live Doom monsters a Quest room will hold at once. E1M6 authors 31. */
export const QUEST_MONSTER_CEILING = 64;

export interface RoomOptions {
  seed?: number;
  mode?: GameMode;
  maxPlayers?: number;
  /** Total bodies (humans + bots) the room tries to keep in the match. */
  botFill?: number;
  /** Doom monsters alive at once. -1 uses the mode default. */
  enemies?: number;
  store?: PersistenceStore | null;
  /** Monotonic wall clock in ms. Defaults to Date.now. */
  clock?: () => number;
  /**
   * Generate all 169 chunks up front (a real server, once, at boot) or trickle
   * them in from the spawn outward (the browser worker, to protect the 3 s
   * interactive budget).
   */
  eagerWorld?: boolean;
  /**
   * Spawn every body holding the full arsenal. The local single-player room
   * uses it so all seven weapons are on the hotbar from the first second —
   * hunting for a shotgun is a lobby mechanic, not a Doom one.
   */
  allWeapons?: boolean;
  name?: string;
  /**
   * Start the room already running a mode plan. Omitted, the room behaves
   * exactly as it always has (a Deathmatch-shaped arena) until a client sends
   * `C2S_MODE.SELECT` — which is what keeps every pre-mode test honest.
   */
  plan?: ModeSimPlan;
  /** Level manifest, so a `SELECT` naming an unknown level can be refused. */
  levels?: ContentResolver | null;
}

interface PickupSpot {
  x: number; y: number; z: number;
  type: number;
  variant: number;
  nextSpawnMs: number;
  entityId: number;
}

interface Membership {
  conn: Connection | null;
  player: PlayerEntity;
  isBot: boolean;
  joinedMs: number;
  /** Snapshot of the player's counters at join, so a match result is a delta. */
  baseKills: number;
  baseDeaths: number;
}

export class Room implements NetHost {
  readonly name: string;
  readonly world: ServerWorld;
  readonly sim: Simulation;
  readonly net: NetHub;
  readonly monsters: MonsterManager;
  readonly bots: BotDriver;
  readonly store: PersistenceStore | null;

  seed: number;
  gameMode: GameMode;
  readonly maxPlayers: number;
  /** Bodies the room tries to hold. A mode SELECT can move it. */
  botFill: number;
  private readonly enemyOverride: number;

  /* --- the mode layer --------------------------------------------------- *
   * A room with no mode plan is the room this file has always been. The plan
   * only starts steering once somebody selects one, so nothing below changes
   * the behaviour of a `new Room()` that never hears from a mode-aware client.
   * ---------------------------------------------------------------------- */

  /** The resolved plan the room is ticking against. */
  plan: ModeSimPlan;
  /** Null until a mode actually needs a wave director (Horde). */
  horde: HordeDirector | null = null;
  /** True once a client has selected a mode on this room. */
  modeSelected = false;
  /**
   * True while the running mode has neither monsters nor PvP — Builder. In a
   * creative world nothing may hurt you, and "nothing" has to include the
   * demon that was already mid-attack when the mode changed, so this is
   * re-asserted every tick rather than set once.
   */
  private sanctuary = false;

  private readonly allWeaponsAtBoot: boolean;
  private readonly levelsResolver: ContentResolver | null;
  private readonly modeRoomState: ModeRoomState = createModeRoomState();
  private modeTracker: ModeStateTracker;
  private readonly modePlayers = new Map<number, ModePlayerState>();
  private readonly modeContextMsg: ModeContextMessage = createModeContextMessage();
  private readonly modeEventMsg: ModeEventMessage = createModeEventMessage();

  state: RoundState = RoundState.IDLE;
  /** Milliseconds left in the round. Only counts down while a human is present. */
  timeLeftMs = MATCH_DURATION_MS;
  stateEndsMs = 0;
  round = 0;

  private readonly clock: () => number;
  private readonly members = new Map<number, Membership>();
  private readonly pickups: PickupSpot[] = [];
  private nextPlayerId = 1;
  private accumulatorMs = 0;
  private lastAdvanceMs = 0;
  private botSpawnTimer = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private worldReady = false;
  private eagerWorld: boolean;
  /** Total simulated milliseconds — the room clock the net layer stamps with. */
  private elapsedMs = 0;

  constructor(options: RoomOptions = {}) {
    this.name = options.name ?? 'doomcraft';
    this.seed = (options.seed ?? ((Math.random() * 0xffffffff) >>> 0)) >>> 0;
    this.gameMode = options.mode ?? DEFAULT_GAME_MODE;
    this.maxPlayers = clamp(options.maxPlayers ?? MAX_PLAYERS, 2, MAX_PLAYERS);
    this.botFill = clamp(options.botFill ?? BOT_FILL_TARGET, 0, this.maxPlayers);
    this.enemyOverride = options.enemies ?? -1;
    this.store = options.store ?? null;
    this.clock = options.clock ?? (() => Date.now());
    this.eagerWorld = options.eagerWorld ?? true;

    this.world = new ServerWorld(this.seed);
    this.sim = new Simulation(this.world, this.seed);
    this.allWeaponsAtBoot = options.allWeapons === true;
    if (this.allWeaponsAtBoot) this.sim.defaultWeaponMask = ALL_WEAPON_MASK;
    this.monsters = new MonsterManager(this.sim, this.seed);
    this.bots = new BotDriver(this.sim, this.monsters.nav, this.seed);
    this.net = new NetHub(this.sim, this.world, this, () => this.elapsedMs);

    this.levelsResolver = options.levels ?? null;
    this.plan = options.plan ?? defaultPlan({ seed: this.seed });
    this.modeTracker = new ModeStateTracker(this.plan);

    this.buildWorld();
    this.applyModeBudget();
    if (options.plan !== undefined) this.applyPlan(options.plan, false);
    this.lastAdvanceMs = this.clock();
  }

  /* -------------------------------------------------------------- *
   * World lifecycle
   * -------------------------------------------------------------- */

  private buildWorld(): void {
    if (this.eagerWorld) {
      this.world.generateAll();
      this.worldReady = true;
    } else {
      // Spawn neighbourhood only: enough to place players and start shooting.
      this.world.pumpGeneration(25);
      this.worldReady = false;
    }
    this.seedPickups();
  }

  /** Deterministic pickup spots spread over the arena. */
  private seedPickups(): void {
    this.pickups.length = 0;
    const rng = new Rng(this.seed ^ 0x9e3779b9);
    const lo = 20;
    const hi = WORLD_SIZE_BLOCKS - 20;
    let guard = 0;
    while (this.pickups.length < PICKUP_COUNT && guard++ < PICKUP_COUNT * 40) {
      const x = Math.round(WORLD_MIN_BLOCK_X + rng.range(lo, hi));
      const z = Math.round(WORLD_MIN_BLOCK_Z + rng.range(lo, hi));
      if (this.world.surfaceKnown(x, z) < 0 && !this.eagerWorld) continue;
      const y = this.world.standableY(x, z);
      if (y < 0) continue;
      let clash = false;
      for (const p of this.pickups) {
        const dx = p.x - x, dz = p.z - z;
        if (dx * dx + dz * dz < 18 * 18) { clash = true; break; }
      }
      if (clash) continue;
      const roll = rng.next();
      let type = EntityType.PICKUP_AMMO;
      let variant = 1;
      if (roll < 0.28) { type = EntityType.PICKUP_HEALTH; variant = rng.next() < 0.18 ? 1 : 0; }
      else if (roll < 0.48) { type = EntityType.PICKUP_ARMOR; variant = rng.next() < 0.22 ? 1 : 0; }
      else if (roll < 0.70) { type = EntityType.PICKUP_AMMO; variant = 1 + rng.int(4); }
      else { type = EntityType.PICKUP_WEAPON; variant = 1 + rng.int(6); }
      this.pickups.push({ x: x + 0.5, y: y + 0.1, z: z + 0.5, type, variant, nextSpawnMs: 0, entityId: -1 });
    }
    for (const spot of this.pickups) this.spawnPickupSpot(spot);
  }

  private spawnPickupSpot(spot: PickupSpot): void {
    const slot = this.sim.spawnPickup(spot.type, spot.x, spot.y, spot.z, spot.variant);
    spot.entityId = slot >= 0 ? this.sim.entId[slot] : -1;
    spot.nextSpawnMs = 0;
  }

  private applyModeBudget(): void {
    const b = this.monsters.budget;
    switch (this.gameMode) {
      case GameMode.HORDE:
        b.target = this.enemyOverride >= 0 ? this.enemyOverride : 6;
        b.spawnIntervalMs = 900;
        b.maxTier = 2;
        break;
      case GameMode.SANDBOX:
        b.target = this.enemyOverride >= 0 ? this.enemyOverride : 0;
        b.spawnIntervalMs = 2500;
        b.maxTier = 4;
        break;
      default:
        // Deathmatch still has demons in it. The bar's sandbox is empty; ours
        // always has something coming at you.
        b.target = this.enemyOverride >= 0 ? this.enemyOverride : 5;
        b.spawnIntervalMs = 2200;
        b.maxTier = 4;
        break;
    }
  }

  /* -------------------------------------------------------------- *
   * The mode layer
   *
   * `C2S_MODE.SELECT` arrives after HELLO, so the room is already live and
   * already streaming when the mode lands. Rather than tear the world down and
   * rebuild it — which would cost the player the seconds we beat the bar by —
   * the plan re-points the parts of the room that a mode actually owns: the
   * monster budget, the bot fill, the arsenal you spawn with, and whether a
   * wave director exists. The world itself stays; Quest paints its authored
   * level over it and Builder keeps whatever is there.
   * -------------------------------------------------------------- */

  onModeSelect(conn: Connection, msg: ModeSelectMessage): void {
    const req = sanitiseJoin(msg, this.levelsResolver);
    if (req.seed === 0) req.seed = this.seed;
    this.applyPlan(resolveModePlan(req), true);
    this.sendModeContext(conn);
  }

  onModeAction(conn: Connection, msg: ModeActionMessage): void {
    const id = conn.playerId;
    if (id === 0) return;

    if (this.horde !== null) {
      this.horde.onAction(id, msg.action, msg.a, msg.b, msg.seq);
      return;
    }

    // Modes without a director still owe an ack, or a client that waits on
    // `ackActionSeq` waits forever.
    const st = this.modePlayers.get(id);
    if (st !== undefined) st.ackActionSeq = msg.seq;

    if (msg.action === ModeAction.SPAWN_ENEMY) { this.spawnAuthoredEnemy(msg); return; }
    if (msg.action === ModeAction.SET_SPAWN) { this.setAuthoredSpawn(msg); return; }

    if (msg.action === ModeAction.RESTART) {
      // A Quest restart is the level going back to how it was authored, and the
      // client has already re-armed every trigger — so the demons it asked for
      // last life have to go, or the second run starts with two of each.
      if (this.plan.modeId === ModeId.QUEST) { this.clearMonsters(); return; }
      if (this.plan.runRoundTimer) this.beginRound(true);
    }
  }

  /** `ModeAction.SET_SPAWN` — where an authored level says the player starts. */
  private setAuthoredSpawn(msg: ModeActionMessage): void {
    if (this.plan.modeId !== ModeId.QUEST) return;
    const x = msg.x + 0.5;
    const y = msg.y;
    const z = msg.z + 0.5;
    if (x < WORLD_MIN_BLOCK_X || z < WORLD_MIN_BLOCK_Z) return;
    if (x > WORLD_MIN_BLOCK_X + WORLD_SIZE_BLOCKS || z > WORLD_MIN_BLOCK_Z + WORLD_SIZE_BLOCKS) return;
    this.sim.spawnAnchor = { x, y, z, yaw: ((msg.a % 360) * Math.PI) / 180 };
  }

  /**
   * Give an authored Quest enemy a body. Only legal in a Quest room, only for
   * the five monster types, only inside the arena, and only up to a ceiling —
   * this is a client asking the server for an entity, so it is rate-limited by
   * construction rather than by trust.
   */
  private spawnAuthoredEnemy(msg: ModeActionMessage): void {
    if (this.plan.modeId !== ModeId.QUEST) return;
    const type = msg.a | 0;
    if (type < EntityType.IMP || type > EntityType.LOST_SOUL) return;
    if (this.monsters.liveCount >= QUEST_MONSTER_CEILING) return;
    const x = msg.x + 0.5;
    const y = msg.y;
    const z = msg.z + 0.5;
    if (x < WORLD_MIN_BLOCK_X || z < WORLD_MIN_BLOCK_Z) return;
    if (x > WORLD_MIN_BLOCK_X + WORLD_SIZE_BLOCKS || z > WORLD_MIN_BLOCK_Z + WORLD_SIZE_BLOCKS) return;
    this.monsters.spawnAt(type, x, y, z);
  }

  /**
   * Point the room at a plan. Called from `SELECT` and, for a server that knows
   * its mode up front, once from the constructor.
   */
  applyPlan(plan: ModeSimPlan, announce: boolean): void {
    const changed = plan.modeId !== this.plan.modeId;
    this.plan = plan;
    this.modeSelected = true;
    this.gameMode = legacyGameMode(plan.modeId);
    this.botFill = clamp(plan.botFill, 0, this.maxPlayers);

    /* --- monsters ------------------------------------------------------- */
    applyMonsterBudget(plan, this.monsters.budget);
    if (this.enemyOverride >= 0 && plan.runMonsters) this.monsters.budget.target = this.enemyOverride;
    if (!plan.runMonsters) this.clearMonsters();

    /* --- arsenal -------------------------------------------------------- *
     * Deathmatch spawns you holding everything, on purpose: hunting for a
     * shotgun is a lobby mechanic and the bar already makes you wait 25 s
     * (ref/BAR.md weakness #5). Quest and Horde take the arsenal away on
     * purpose too — the campaign is paced by what you have not found yet, and
     * Horde's guns come out of the same wallet as the walls. So a mode may
     * restrict the boot arsenal, and only Deathmatch inherits it.
     * -------------------------------------------------------------------- */
    const inheritsArsenal = this.allWeaponsAtBoot && plan.modeId === ModeId.DEATHMATCH;
    this.sim.defaultWeaponMask = plan.grantAllWeapons || inheritsArsenal
      ? ALL_WEAPON_MASK
      : plan.startWeaponMask;

    /* --- the wave director ---------------------------------------------- */
    if (plan.runWaveDirector) {
      if (this.horde === null || changed) {
        this.horde = new HordeDirector({
          sim: this.sim,
          monsters: this.monsters,
          plan,
          seed: this.seed,
          emit: (kind, playerId, a, b, c, text) => { this.emitModeEvent(kind, playerId, a, b, c, text); },
        });
        for (const id of this.members.keys()) {
          if (this.members.get(id)?.isBot === false) this.horde.addPlayer(id);
        }
      }
    } else if (this.horde !== null) {
      this.horde = null;
      this.clearMonsters();
    }

    /* --- per-client state ------------------------------------------------ */
    this.modeTracker = new ModeStateTracker(plan);
    for (const m of this.members.values()) {
      if (m.isBot) continue;
      this.modeTracker.add(m.player.id);
      if (!this.modePlayers.has(m.player.id)) this.modePlayers.set(m.player.id, createModePlayerState());
    }

    /* --- what may hurt you ------------------------------------------------ *
     * The plan already says whether the mode has fall damage, hazards, PvP or
     * monsters. Until now nothing read those fields, so Builder — a creative
     * mode with no monsters at all in its definition — still let a zombieman
     * shoot you dead while you were placing your third block.
     * -------------------------------------------------------------------- */
    // Only an authored level pins the spawn. Everything else spawns on the
    // arena, so a Quest run must not leave its start behind for Deathmatch.
    if (plan.modeId !== ModeId.QUEST) this.sim.spawnAnchor = null;
    this.sim.fallDamageEnabled = plan.fallDamage;
    this.sim.hazardsEnabled = plan.hazards;
    this.sanctuary = !plan.runMonsters && !plan.allowPvp;
    if (this.sanctuary) this.enforceSanctuary(true);
    else this.clearSanctuary();

    /* --- bodies ---------------------------------------------------------- */
    // Drop bots the new mode does not want. `maintainBots` adds any it does.
    while (this.botCount > 0 && this.sim.players.length > Math.max(this.humanCount, this.botFill)) {
      if (!this.dropWorstBot()) break;
    }

    /* --- the world ------------------------------------------------------- *
     * Quest paints an authored level straight into the CLIENT's voxel store,
     * which the server never sees and the scope ledger cannot undo — a mode's
     * teardown can free its own objects but not somebody else's world. So a
     * mode change re-streams the authoritative world to every client, and the
     * next mode starts on the terrain the server actually has.
     * -------------------------------------------------------------------- */
    // ...but not when the mode we are entering is the one that paints. Quest
    // covers the terrain with its own level the moment it places; re-streaming
    // 169 chunks into it would just race the blit for a second and lose.
    if (changed && announce && plan.modeId !== ModeId.QUEST) this.net.resetWorldStreams();

    // Only on a real change: the shell announces a mode and then the mode
    // announces itself, and two identical lines in the feed is a bug people see.
    if (announce && changed) {
      this.net.broadcastChat(0, ChatChannel.SYSTEM, `Mode: ${getMode(plan.modeId).name}`);
    }
  }

  /**
   * Nothing may hurt a builder. `spawnProtectUntilMs` is the sim's existing
   * "cannot be damaged" latch, so this parks it past the end of the session and
   * re-parks it after any respawn. Cheap: the member map is at most 32 entries
   * and this only runs while a sanctuary mode is live.
   */
  private enforceSanctuary(heal: boolean): void {
    for (const m of this.members.values()) {
      if (m.isBot) continue;
      const p = m.player;
      if (heal) {
        if (p.dead) this.sim.spawnPlayer(p);
        p.health = MAX_HEALTH;
      }
      p.spawnProtectUntilMs = Number.MAX_SAFE_INTEGER;
    }
  }

  /** Hand mortality back when the next mode is one you can die in. */
  private clearSanctuary(): void {
    const until = this.sim.nowMs + SPAWN_PROTECTION_MS;
    for (const m of this.members.values()) {
      if (m.isBot) continue;
      const p = m.player;
      if (p.spawnProtectUntilMs > until) p.spawnProtectUntilMs = until;
    }
  }

  /** Every live demon, gone. Used when a mode says there are no monsters. */
  private clearMonsters(): void {
    for (let i = 0; i < this.sim.entCapacity; i++) {
      if (this.sim.entActive[i] !== 1) continue;
      if (this.sim.entType[i] >= EntityType.PICKUP_HEALTH) continue;
      this.sim.removeEntity(i, 5 /* DESPAWNED */);
    }
  }

  private emitModeEvent(
    kind: number, playerId: number, a: number, b: number, c: number, text: string,
  ): void {
    const e = this.modeEventMsg;
    e.kind = kind;
    e.playerId = playerId;
    e.a = a; e.b = b; e.c = c;
    e.text = text;
    // The client mode renders the event itself; mirroring it into chat as well
    // is how the same line ends up on screen twice.
    this.net.broadcastModeEvent(e);
  }

  private sendModeContext(conn: Connection): void {
    const plan = this.plan;
    const def = getMode(plan.modeId);
    const c = this.modeContextMsg;
    c.modeId = plan.modeId;
    c.skill = plan.skill;
    c.levelId = plan.levelId;
    c.worldId = plan.worldId;
    c.title = plan.levelId.length > 0 ? plan.levelId : def.name;
    c.contentHash = 0;
    c.parTimeSec = 0;
    c.skyColor = def.accent;
    c.fogColor = def.accent;
    c.ambient = 0.6;
    c.maxPlayers = this.maxPlayers;
    this.net.sendModeContext(conn, c);
  }

  /**
   * Fill the room half of the state sidecar. Horde composes its own (it owns
   * the phase machine); every other mode reports the round the room is running,
   * which is what makes the Deathmatch strip real without a second director.
   */
  private fillRoomState(): void {
    const r = this.modeRoomState;
    r.elapsedMs = this.elapsedMs;
    r.index = this.round;
    r.failed = false;
    r.objectiveDone = false;
    r.exitOpen = false;
    r.waveActive = false;

    switch (this.state) {
      case RoundState.IDLE:
        r.phase = ModePhase.WAITING;
        r.phaseMsLeft = 0;
        break;
      case RoundState.ENDED:
        r.phase = ModePhase.INTERMISSION;
        r.phaseMsLeft = Math.max(0, this.stateEndsMs - this.elapsedMs);
        break;
      default:
        r.phase = ModePhase.LIVE;
        r.phaseMsLeft = this.plan.runRoundTimer ? Math.max(0, this.timeLeftMs) : 0;
        break;
    }

    let leader = 0;
    let bodies = 0;
    let humans = 0;
    for (const m of this.members.values()) {
      bodies++;
      if (!m.isBot) humans++;
      if (m.player.kills > leader) leader = m.player.kills;
    }
    r.score = leader;
    r.a = leader;
    r.aTotal = this.plan.scoreLimit;
    // `b` is humans and `bTotal` is bodies — the shape the Deathmatch strip
    // reads ("6 bodies, 1 human, 5 bots holding slots").
    r.b = humans;
    r.bTotal = bodies;
    r.c = this.monsters.liveCount;
    r.cTotal = Math.max(this.monsters.liveCount, this.monsters.budget.target);
  }

  /**
   * One STATE packet per client, but only when something moved — and only for a
   * mode the room can actually speak for.
   *
   * Quest is deliberately excluded. The authored level lives on the CLIENT
   * (`levelRuntime.ts` blits it and owns the doors, the secrets and the item
   * count); this room streams generated terrain and has never heard of a
   * keycard. Sending it a sidecar full of Deathmatch numbers would not be
   * "partial support", it would be the campaign HUD confidently printing
   * `items 1/32` — the player count — as if it were the item count. Silence is
   * the honest answer until a Quest-authoritative room exists, and the mode
   * already treats an absent sidecar as "I am the authority".
   */
  private publishModeState(): void {
    if (!this.modeSelected) return;
    if (this.plan.modeId === ModeId.QUEST) return;
    const conns = this.net.connections;
    if (conns.length === 0) return;

    if (this.horde === null) this.fillRoomState();

    for (let i = 0; i < conns.length; i++) {
      const conn = conns[i];
      if (!conn.ready || conn.playerId === 0) continue;
      const id = conn.playerId;

      if (this.horde !== null) {
        const state = this.horde.composeState(id);
        if (state !== null) this.net.sendModeState(conn, state);
        continue;
      }

      let pstate = this.modePlayers.get(id);
      if (pstate === undefined) {
        pstate = createModePlayerState();
        this.modePlayers.set(id, pstate);
      }
      const state = this.modeTracker.compose(id, this.modeRoomState, pstate);
      if (state !== null) this.net.sendModeState(conn, state);
    }
  }

  /** For the status endpoint and the tests. */
  modeKeyName(): string { return MODE_KEYS[this.plan.modeId] ?? MODE_KEYS[ModeId.DEATHMATCH]; }

  /* -------------------------------------------------------------- *
   * NetHost
   * -------------------------------------------------------------- */

  get matchOver(): boolean { return this.state === RoundState.ENDED; }

  onHello(conn: Connection, name: string, skin: number, _caps: number): number {
    const humans = this.humanCount;
    if (humans >= this.maxPlayers) return 0;
    // Take a bot's slot rather than refusing a human.
    if (this.sim.players.length >= this.maxPlayers) {
      if (!this.dropWorstBot()) return 0;
    }

    const id = this.allocateId();
    const player = this.sim.addPlayer(id, name, skin, false);
    this.members.set(id, {
      conn, player, isBot: false, joinedMs: this.elapsedMs,
      baseKills: 0, baseDeaths: 0,
    });

    // An idle room belongs to whoever walks in: fresh scores, fresh clock.
    if (humans === 0) this.beginRound(false);
    else if (this.state === RoundState.IDLE) this.state = RoundState.LIVE;

    this.modeTracker.add(id);
    this.modePlayers.set(id, createModePlayerState());
    this.horde?.addPlayer(id);
    if (this.sanctuary) this.enforceSanctuary(true);

    this.net.broadcastChat(id, ChatChannel.SYSTEM, `${name} joined`);
    this.net.sendChatTo(conn, 0, ChatChannel.TIP, 'Rockets carve the world. Aim at the floor and jump.');
    if (this.modeSelected) this.sendModeContext(conn);
    return id;
  }

  onDisconnect(conn: Connection): void {
    const id = conn.playerId;
    if (id === 0) return;
    const member = this.members.get(id);
    if (member) {
      void this.persistMember(member, false);
      this.net.broadcastChat(id, ChatChannel.SYSTEM, `${member.player.name} left`);
    }
    this.members.delete(id);
    this.bots.detach(id);
    this.sim.removePlayer(id);
    this.modeTracker.remove(id);
    this.modePlayers.delete(id);
    this.horde?.removePlayer(id);
  }

  onChat(conn: Connection, text: string): void {
    const clean = sanitiseChat(text);
    if (clean.length === 0) return;
    this.net.broadcastChat(conn.playerId, ChatChannel.ALL, clean);
  }

  onRespawnRequest(conn: Connection): void {
    const p = this.sim.getPlayer(conn.playerId);
    if (!p || !p.dead) return;
    // The respawn delay is a floor, not a prompt: this only skips the wait for
    // a player who is already past it.
    if (this.sim.nowMs >= p.respawnAtMs) this.sim.spawnPlayer(p);
  }

  /* -------------------------------------------------------------- *
   * Membership
   * -------------------------------------------------------------- */

  get humanCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (!m.isBot) n++;
    return n;
  }

  get botCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.isBot) n++;
    return n;
  }

  private allocateId(): number {
    for (let i = 0; i < 65535; i++) {
      const id = this.nextPlayerId;
      this.nextPlayerId = this.nextPlayerId >= 65535 ? 1 : this.nextPlayerId + 1;
      if (!this.sim.getPlayer(id)) return id;
    }
    return 0;
  }

  private addBot(): boolean {
    if (this.sim.players.length >= this.maxPlayers) return false;
    const id = this.allocateId();
    if (id === 0) return false;
    const name = this.bots.nextName();
    const player = this.sim.addPlayer(id, name, (id * 7) & 7, true);
    this.bots.attach(player, botSkillFor(this.seed, id));
    this.members.set(id, {
      conn: null, player, isBot: true, joinedMs: this.elapsedMs,
      baseKills: 0, baseDeaths: 0,
    });
    return true;
  }

  private dropWorstBot(): boolean {
    let worst: Membership | null = null;
    for (const m of this.members.values()) {
      if (!m.isBot) continue;
      if (!worst) { worst = m; continue; }
      // Prefer to remove the bot with the least going on: dead first, then
      // lowest score, so a human never displaces the bot that is winning.
      const a = (m.player.dead ? -1000 : 0) + m.player.kills * 10 - m.player.deaths;
      const b = (worst.player.dead ? -1000 : 0) + worst.player.kills * 10 - worst.player.deaths;
      if (a < b) worst = m;
    }
    if (!worst) return false;
    const id = worst.player.id;
    this.members.delete(id);
    this.bots.detach(id);
    this.sim.removePlayer(id);
    return true;
  }

  /** Keep the body count at `botFill` without ever displacing a human. */
  private maintainBots(dtMs: number): void {
    this.botSpawnTimer -= dtMs;
    const total = this.sim.players.length;
    const humans = this.humanCount;
    const want = Math.max(humans, Math.min(this.botFill, this.maxPlayers));
    if (total < want) {
      if (this.botSpawnTimer <= 0) {
        this.botSpawnTimer = BOT_SPAWN_DELAY_MS;
        this.addBot();
      }
    } else if (total > want && this.botCount > 0) {
      this.dropWorstBot();
    }
  }

  /* -------------------------------------------------------------- *
   * Round state machine
   * -------------------------------------------------------------- */

  private beginRound(newSeed: boolean): void {
    this.round++;
    if (newSeed) {
      this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
      this.world.reset(this.seed);
      this.sim.seed = this.seed;
      if (this.eagerWorld) { this.world.generateAll(); this.worldReady = true; }
      else { this.world.pumpGeneration(25); this.worldReady = false; }
      this.sim.clearWorldEntities();
      this.seedPickups();
      this.net.resetWorldStreams();
    }
    this.state = RoundState.LIVE;
    this.timeLeftMs = MATCH_DURATION_MS;
    this.monsters.wave = 1;
    this.applyModeBudget();
    for (const m of this.members.values()) {
      m.player.kills = 0;
      m.player.deaths = 0;
      m.player.streak = 0;
      m.player.bestStreak = 0;
      m.player.damageDealt = 0;
      m.player.blocksPlaced = 0;
      m.player.blocksBroken = 0;
      m.baseKills = 0;
      m.baseDeaths = 0;
      m.joinedMs = this.elapsedMs;
      this.sim.spawnPlayer(m.player);
    }
    this.net.broadcastChat(0, ChatChannel.SYSTEM,
      this.round === 1 ? 'Match live. Go.' : `Round ${this.round}. New world.`);
  }

  private endRound(reason: string): void {
    if (this.state === RoundState.ENDED) return;
    this.state = RoundState.ENDED;
    this.stateEndsMs = this.elapsedMs + END_SCREEN_MS;
    let best: PlayerEntity | null = null;
    for (const m of this.members.values()) {
      if (!best || m.player.kills > best.kills) best = m.player;
    }
    for (const m of this.members.values()) {
      void this.persistMember(m, best !== null && m.player.id === best.id);
    }
    this.net.broadcastChat(best ? best.id : 0, ChatChannel.SYSTEM,
      best ? `${best.name} wins with ${best.kills} — ${reason}` : `Round over — ${reason}`);
  }

  private updateRound(dtMs: number): void {
    switch (this.state) {
      case RoundState.IDLE:
        if (this.humanCount > 0) this.state = RoundState.LIVE;
        break;
      case RoundState.LIVE: {
        if (this.humanCount === 0) {
          // Nobody to play for: hold the clock so the bots do not burn a match.
          this.state = RoundState.IDLE;
          break;
        }
        this.timeLeftMs -= dtMs;
        let leader = 0;
        for (const m of this.members.values()) if (m.player.kills > leader) leader = m.player.kills;
        if (leader >= SCORE_LIMIT) this.endRound('score limit');
        else if (this.timeLeftMs <= 0) this.endRound('time');
        break;
      }
      case RoundState.ENDED:
        if (this.elapsedMs >= this.stateEndsMs) this.beginRound(true);
        break;
      default:
        break;
    }

    if (this.gameMode === GameMode.HORDE && this.state === RoundState.LIVE) {
      if (this.monsters.liveCount === 0 && this.monsters.budget.target > 0) {
        this.monsters.wave++;
        this.monsters.budget.target = Math.min(40, 5 + this.monsters.wave * 2);
        this.monsters.budget.maxTier = Math.min(4, 1 + Math.floor(this.monsters.wave / 3));
        this.net.broadcastChat(0, ChatChannel.SYSTEM, `Wave ${this.monsters.wave}`);
      }
    }
  }

  private updatePickups(): void {
    for (const spot of this.pickups) {
      if (spot.entityId >= 0) {
        // Still on the map?
        let alive = false;
        for (let i = 0; i < this.sim.entCapacity; i++) {
          if (this.sim.entActive[i] === 1 && this.sim.entId[i] === spot.entityId) { alive = true; break; }
        }
        if (alive) continue;
        spot.entityId = -1;
        spot.nextSpawnMs = this.elapsedMs + PICKUP_RESPAWN_MS;
      } else if (this.elapsedMs >= spot.nextSpawnMs) {
        this.spawnPickupSpot(spot);
      }
    }
  }

  /* -------------------------------------------------------------- *
   * Tick
   * -------------------------------------------------------------- */

  /** Exactly one 50 ms simulation step. */
  step(): void {
    const dtMs = TICK_MS;
    this.elapsedMs += dtMs;

    if (!this.worldReady) {
      // Trickle the rest of the arena in without blowing the frame budget.
      if (this.world.pumpGeneration(2) === 0) {
        this.worldReady = true;
        if (this.pickups.length < PICKUP_COUNT) this.seedPickups();
      }
    }

    this.sim.beginTick(dtMs);
    this.net.nowMs = this.sim.nowMs;

    this.maintainBots(dtMs);
    this.net.consumeInputs(dtMs);
    this.bots.step(dtMs);
    this.monsters.step(dtMs);
    this.sim.stepTick(dtMs);

    // Must run after `stepTick` (it needs this tick's kills and this tick's
    // block journal) and before `flush` (its entity writes have to reach the
    // snapshot). See the wiring note at the top of horde.ts.
    this.horde?.step(dtMs);

    this.updatePickups();
    this.updateRound(dtMs);
    if (this.sanctuary) this.enforceSanctuary(false);
    this.publishModeState();

    this.net.flush();
    this.sim.clearEvents();
    this.world.journal.reset();
    this.net.reapTimeouts();
  }

  /**
   * Run whatever whole ticks are due at `nowMs`. Catch-up is capped so a
   * suspended tab (or a stalled worker) resumes instead of running a spiral of
   * death through an hour of missed physics.
   */
  advance(nowMs: number): number {
    let delta = nowMs - this.lastAdvanceMs;
    this.lastAdvanceMs = nowMs;
    if (delta < 0) delta = 0;
    if (delta > TICK_MS * MAX_CATCHUP_TICKS) delta = TICK_MS * MAX_CATCHUP_TICKS;
    this.accumulatorMs += delta;
    let ticks = 0;
    while (this.accumulatorMs >= TICK_MS && ticks < MAX_CATCHUP_TICKS) {
      this.accumulatorMs -= TICK_MS;
      this.step();
      ticks++;
    }
    return ticks;
  }

  /** Drive the room from a timer. Idempotent. */
  start(): void {
    if (this.timer !== null) return;
    this.lastAdvanceMs = this.clock();
    this.timer = setInterval(() => {
      this.advance(this.clock());
    }, Math.max(5, Math.floor(TICK_MS / 2)));
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /* -------------------------------------------------------------- *
   * Connections
   * -------------------------------------------------------------- */

  join(transport: NetTransport): Connection {
    return this.net.attach(transport, this.maxPlayers);
  }

  receive(conn: Connection, data: ArrayBuffer | Uint8Array): void {
    this.net.receive(conn, data);
  }

  leave(conn: Connection): void {
    this.net.detach(conn, 1000, 'client left');
  }

  /* -------------------------------------------------------------- *
   * Persistence
   * -------------------------------------------------------------- */

  private async persistMember(member: Membership, won: boolean): Promise<void> {
    if (!this.store || member.isBot || !member.conn) return;
    const deviceId = member.conn.deviceId;
    if (!deviceId) return;
    const p = member.player;
    const seconds = Math.max(0, (this.elapsedMs - member.joinedMs) / 1000);
    const kills = Math.max(0, p.kills - member.baseKills);
    const deaths = Math.max(0, p.deaths - member.baseDeaths);
    const result: MatchResult = {
      kills,
      deaths,
      won,
      bestStreak: p.bestStreak,
      damageDealt: p.damageDealt,
      blocksPlaced: p.blocksPlaced,
      blocksBroken: p.blocksBroken,
      seconds,
      xp: kills * XP_PER_KILL + (won ? XP_PER_WIN : 0) + (seconds / 60) * XP_PER_MINUTE,
      favouriteWeapon: p.weapon,
    };
    member.baseKills = p.kills;
    member.baseDeaths = p.deaths;
    try {
      await this.store.update(deviceId, (profile) => {
        applyMatchResult(profile, result);
        profile.progress.lastSeed = this.seed;
        if (profile.progress.name.length === 0) profile.progress.name = p.name;
      });
    } catch {
      // A failed save must never take the match down.
    }
  }

  /* -------------------------------------------------------------- *
   * Introspection (health endpoint, tests, the local worker)
   * -------------------------------------------------------------- */

  scoreboard(): Array<{ id: number; name: string; kills: number; deaths: number; bot: boolean; ping: number }> {
    const out: Array<{ id: number; name: string; kills: number; deaths: number; bot: boolean; ping: number }> = [];
    for (const m of this.members.values()) {
      out.push({
        id: m.player.id,
        name: m.player.name,
        kills: m.player.kills,
        deaths: m.player.deaths,
        bot: m.isBot,
        ping: Math.round(m.player.rttMs),
      });
    }
    out.sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths));
    return out;
  }

  status(): Record<string, unknown> {
    return {
      name: this.name,
      seed: this.seed,
      mode: GameMode[this.gameMode],
      modeKey: this.modeKeyName(),
      wave: this.horde !== null ? this.horde.wave : this.monsters.wave,
      round: this.round,
      state: ROUND_STATE_NAMES[this.state],
      tick: this.sim.tick,
      timeLeftMs: Math.max(0, Math.round(this.timeLeftMs)),
      players: this.sim.players.length,
      humans: this.humanCount,
      bots: this.botCount,
      monsters: this.monsters.liveCount,
      projectiles: this.sim.projCount,
      chunks: this.world.generatedChunks,
      worldReady: this.worldReady,
      connections: this.net.connections.length,
    };
  }

  /** Spawn a demon on demand — used by horde scripting and by tests. */
  spawnMonster(type: EntityType, x: number, y: number, z: number): number {
    return this.monsters.spawnAt(type, x, y, z);
  }

  /** Give a player every weapon, loaded. Sandbox mode and the tutorial use this. */
  grantAllWeapons(playerId: number): void {
    const p = this.sim.getPlayer(playerId);
    if (!p) return;
    p.weaponMask = ALL_WEAPON_MASK;
    for (let i = 0; i < WEAPON_COUNT; i++) p.mag[i] = getWeapon(i).magSize;
    p.reserve.set(AMMO_MAX);
  }
}
