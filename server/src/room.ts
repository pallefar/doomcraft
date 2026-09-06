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
  Rng,
  BlockId,
  clamp,
  CAP_VARIANTS,
  PacketReader,
  PacketWriter,
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
  WinCondition,
  legacyGameMode,
  type ModeActionMessage,
  type ModeContextMessage,
  type ModeEventMessage,
  type ModeSelectMessage,
} from '@doomcraft/shared/modes';
import {
  DR_START_OPEN,
  applyLevelToWorld,
  primarySpawn,
  stampedLevelHash as levelStampHash,
  type Level,
} from '@doomcraft/shared/level';
import { CONTENT_VERSION } from '@doomcraft/shared/version';
import { BUILTIN_CONTENT_HASH } from '@doomcraft/shared/packs';
import {
  MAX_VARIANT_TABLE_BYTES,
  createVariantTableMessage, decodeVariantTable, encodeVariantTable,
  overlaysFromWire, variantNamesFor, wireEntriesFor,
  type VariantNameEntry, type VariantWireEntry, type VariantsManifest,
} from '@doomcraft/shared/variants';
import { BASE_SLOT, SessionArsenal } from '@doomcraft/shared/arsenal';
import { defaultFlagBits, flagOn } from '@doomcraft/shared/flags';
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
import type { AppliedRewards, PersistenceStore, StoredProfile } from './persistence.js';
import {
  applyMatchResult, grantDrops, randomToken, settleAchievements, settleChallenges,
} from './persistence.js';
import { contributingChallengeIds, type ChallengeDef } from '@doomcraft/shared/challenges';
import type { AchievementDef } from '@doomcraft/shared/achievements';
import type { Journal } from './journal.js';
import { MATCH_PAYOUT, matchPayoutRows, newLedgerId } from './journal.js';
import {
  EntitlementGuard,
  toMatchResult,
  type ResultSubmission,
} from './entitlementGuard.js';
import { buildSubmission } from './reward.js';
import { MatchType, SessionOrigin, trustPolicyFor } from '@doomcraft/shared/trust';
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

/**
 * A room's table, encoded and decoded once, so what the arsenal is built from
 * is literally what the wire will carry. See the note at the construction site.
 */
function decodeRoomVariantTable(manifest: VariantsManifest | null): readonly VariantWireEntry[] {
  if (manifest === null || manifest.variants.length === 0) return [];
  const w = encodeVariantTable(
    new PacketWriter(MAX_VARIANT_TABLE_BYTES), wireEntriesFor(manifest), ZERO_SLOTS,
  );
  const decoded = decodeVariantTable(
    new PacketReader(w.copy()), createVariantTableMessage(),
  );
  return decoded === null ? [] : decoded.variants;
}

const ZERO_SLOTS = new Uint8Array(WEAPON_COUNT);

/**
 * What this connection ACTUALLY fires with, from what it claims.
 *
 * Two refusals, and each one is the whole reason this function exists rather
 * than the claim being written straight onto the body:
 *
 *   1. NO `CAP_VARIANTS`, NO VARIANTS. A bundle that predates opcode 13 is
 *      admitted by `onHello` — it checks the protocol window and draining and
 *      nothing else — and would then fire the compiled archetype while this
 *      server resolved a variant. Every number on that shot would disagree.
 *   2. A SLOT THIS ROOM DOES NOT HAVE IS THE BASE. `statsFor` clamps too, so
 *      this is belt and braces; the belt matters because the slot map goes on
 *      the wire, and a client told "slot 3" by a room with two variants would
 *      be told a number it must then reinterpret.
 */
export function resolveVariantSlots(
  claims: Uint8Array | undefined, caps: number, slotCount: number,
): Uint8Array {
  const out = new Uint8Array(WEAPON_COUNT);
  if (claims === undefined || (caps & CAP_VARIANTS) === 0) return out;
  for (let i = 0; i < WEAPON_COUNT; i++) {
    const c = claims[i] ?? BASE_SLOT;
    out[i] = Number.isInteger(c) && c > 0 && c < slotCount ? c : BASE_SLOT;
  }
  return out;
}

export interface RoomOptions {
  /**
   * Roll this member's item drops for a paying round. Provided by the factory
   * (it holds the room's pinned release; the room must not know the release
   * tier exists). Never called for bots. Absent = no drops, which is the
   * browser worker and every test that does not care.
   */
  rollDrops?: (ctx: {
    deviceId: string; flagBits: number; kills: number; seconds: number; won: boolean;
  }) => readonly string[];
  /**
   * The challenge defs from this room's pinned quests pack. Provided by the
   * factory, same contract as `rollDrops`. Absent = no challenges, which is
   * the browser worker and every test that does not care.
   */
  challenges?: readonly ChallengeDef[];
  /** Lifetime awards, pinned for this room's life exactly as `challenges` are. */
  achievements?: readonly AchievementDef[];
  /** Does the pinned items manifest still define this local id? Payment-time membership. */
  itemKnown?: (localId: string) => boolean;
  /** The pinned items version challenge item rewards are formatted against. */
  challengeItemVersion?: number;
  /**
   * The variant table this room's pinned release names, already parsed and
   * refused-or-accepted by `parseVariantsManifest`. Provided by the factory,
   * same contract as `rollDrops` and `challenges`: the room must not know the
   * release tier exists. Absent = no variants, which is the browser Worker,
   * a host whose release names no variants pack, and every test that does not
   * care. docs/VARIANTS.md 3.
   */
  variants?: VariantsManifest | null;
  /**
   * This connection's CLAIMED variant slot per weapon — what the player says
   * they have equipped, straight off their profile and not yet trusted.
   * `Room.onHello` resolves it: a connection without `CAP_VARIANTS` gets the
   * base for everything, and a slot this room's table does not contain gets
   * the base too. Absent = nobody claims anything, which is V3 everywhere and
   * what V4 replaces with the real `inventory.variants` read.
   */
  variantClaims?: (conn: Connection) => Uint8Array;
  seed?: number;
  mode?: GameMode;
  maxPlayers?: number;
  /** Total bodies (humans + bots) the room tries to keep in the match. */
  botFill?: number;
  /** Doom monsters alive at once. -1 uses the mode default. */
  enemies?: number;
  store?: PersistenceStore | null;
  /**
   * The reward gate. Null means this room grants nothing at all — which is
   * what the browser worker wants, and what every test that does not care
   * about the economy gets by default.
   */
  guard?: EntitlementGuard | null;
  /**
   * The reward journal. Null means this room records nothing — the browser
   * worker and every test that does not care about the ledger — which is
   * consistent with `guard: null` meaning it pays nothing.
   *
   * A room with a `store` and a `guard` but no `journal` still pays: the
   * journal is not a gate, it is the record. Making it a gate would mean a
   * disk fault stops the game.
   */
  journal?: Journal | null;
  /**
   * Viral tier 1: called after a round's profile write lands for a player,
   * with the PROFILE KEY the payout banked to. The referral service checks
   * engagement thresholds there; the room knows nothing about referrals.
   */
  onProfilePersisted?: (profileKey: string) => void;
  /**
   * This PROCESS's id, from `server/src/deploy.ts`. It is the first component
   * of every payout's idempotency key; see `payoutSourceId`.
   */
  hostId?: string;
  /**
   * How the server created this room. A server fact, never read off a
   * packet; `sealSessionTrust` turns it into a topology and clamps the
   * intent below. Defaults to the matchmaker.
   */
  sessionOrigin?: SessionOrigin;
  /** What the matchmaker asked for. `resolveMatchType` clamps it by origin. */
  sessionIntent?: MatchType;
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
  /**
   * Refuse a `C2S_MODE.SELECT` that names a DIFFERENT place than this room is.
   *
   * A single-room server (and the local Worker) wants the old behaviour: one
   * room, and whoever selects a mode reconfigures it. A routed server does not
   * — `ModeRouter` already put one plan in each room, so a joiner sending
   * `SELECT quest` into a live Deathmatch would wipe out everybody else's
   * match. Locked, such a `SELECT` is answered with the room's real context and
   * otherwise ignored; the client is expected to reconnect to the right room.
   *
   * Off by default, so nothing that exists today changes behaviour.
   */
  lockMode?: boolean;
  /**
   * The `CONTENT_VERSION` this room runs for its whole life. Defaults to
   * whatever this build was compiled with.
   *
   * PINNED AT CONSTRUCTION, deliberately. A balance patch applies to every NEW
   * room immediately and no in-flight match ever has its time-to-kill changed
   * underneath it — changing weapon damage mid-match is not a rollout strategy,
   * it is a bug that looks like one (docs/INFRASTRUCTURE.md §6). A room that
   * outlives a deploy keeps serving the content its players joined for; the
   * next room on the same host gets the new one.
   */
  contentVersion?: number;
  /** Hash of the exact tables and levels this room loaded. */
  contentHash?: number;
  /**
   * False once this host is draining: `net.ts` refuses new HELLOs with
   * `UpdateReason.HOST_DRAINING` while everybody already inside plays on.
   * Read live, so flipping it is instant.
   */
  admitting?: () => boolean;
  /** Resolve this player's feature flags, server-side. See shared/src/flags.ts. */
  resolveFlags?(conn: Connection): number;
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
  readonly guard: EntitlementGuard | null;
  readonly journal: Journal | null;
  private readonly onProfilePersisted?: (profileKey: string) => void;
  private readonly hostId: string;
  /**
   * This room OBJECT's id, minted here and never reused.
   *
   * `sessionId` is `"<room key>#<round>"` and the room key is reused: the
   * router reaps an empty room and builds another under the same key, whose
   * rounds start at 1 again. So `"deathmatch#1"` names two different matches on
   * one host on one day, and a payout keyed on it would refuse the second as a
   * duplicate and pay that player nothing. `docs/PLATFORM.md` §4.2 names the
   * restart case and puts `HOST_ID` in front; that is necessary and not
   * sufficient. This is the missing component.
   */
  readonly instanceId: string;

  /**
   * This room's pinned variant table, DECODED from the bytes it sends —
   * `NetHost.variantTable`. Row `i` is slot `i + 1`, which is the numbering
   * `SessionArsenal.from` gives them and therefore the numbering the slot map
   * beside them on the wire is written in.
   */
  readonly variantEntries: readonly VariantWireEntry[];
  /**
   * The DISPLAY NAMES for those rows, in that order (V4d).
   *
   * Built from `variantEntries` rather than from the manifest's own array, so
   * the thing that carries the name is the thing that carries the slot: index
   * `i` here is row `i` there is slot `i + 1` in the arsenal. The manifest is
   * consulted for a string and for nothing else. `variantEntries` is what the
   * wire will carry and what `variantSlotsFor` resolves a claim against, and
   * a name resolved through any OTHER ordering is the V4c failure again with a
   * label instead of a gun.
   */
  readonly variantNames: readonly VariantNameEntry[];
  private readonly variantClaims?: (conn: Connection) => Uint8Array;

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
  private readonly rollDrops: RoomOptions['rollDrops'];
  private readonly challenges: readonly ChallengeDef[];
  private readonly achievements: readonly AchievementDef[];
  private readonly itemKnown: (localId: string) => boolean;
  private readonly challengeItemVersion: number;
  /**
   * The authored level this room's world currently holds, and its content hash.
   *
   * '' means "this room is running generated terrain". The hash is what
   * `sendModeContext` puts on the wire: a non-zero `contentHash` is the client's
   * proof that the ROOM owns the level's voxels, and therefore that the client
   * must place the level on its authored coordinates rather than relocating it
   * onto whatever arena spawn it happened to get. See `stampAuthoredLevel`.
   */
  private stampedLevelId = '';
  private stampedLevelHash = 0;
  /** The level behind `stampedLevelId`, kept so doors can be carved. */
  private stampedLevel: Level | null = null;
  /** Rows currently retracted per door, so a repeat or a no-op costs nothing. */
  private doorRows: Int16Array = new Int16Array(0);
  /** A level asked for but not yet in memory. See `ContentResolver.requestLevel`. */
  private levelRequestId = '';
  /** Ids already asked for, so a resolver that cannot produce one is asked once. */
  private readonly levelsRequested = new Set<string>();
  /** See `RoomOptions.lockMode`. */
  readonly modeLocked: boolean;

  /* --- the patch system's half of NetHost (see server/src/net.ts) ------- */

  /** Pinned at construction and never reassigned. See `RoomOptions.contentVersion`. */
  readonly contentVersion: number;
  readonly contentHash: number;
  private readonly admittingFn: () => boolean;
  private readonly flagResolver: ((conn: Connection) => number) | null;

  /** `NetHost.admitting` — false stops NEW players joining THIS room. */
  get admitting(): boolean { return this.admittingFn(); }

  /** `NetHost.resolveFlags` — server-side flag resolution for one player. */
  resolveFlags(conn: Connection): number {
    return this.flagResolver !== null ? this.flagResolver(conn) : defaultFlagBits();
  }

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
  /** `elapsedMs` when the round in progress began. Written every round. */
  roundStartMs = 0;

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

  /* --- the reward gate's two server facts and the round's ledger id ---- *
   * Set once at construction from `RoomOptions`, because how a room came
   * into existence is not something a player may influence later.
   * -------------------------------------------------------------------- */
  private readonly sessionOrigin: SessionOrigin;
  private readonly sessionIntent: MatchType;
  /**
   * The ledger id of the round in progress, `"<room>#<round>"`. Empty until
   * the first round opens. Per ROUND, not per room: the room key outlives
   * every round it holds, so a per-room id would make round 2 a replay of
   * round 1 and pay nobody.
   */
  private sessionId = '';

  constructor(options: RoomOptions = {}) {
    this.name = options.name ?? 'doomcraft';
    this.seed = (options.seed ?? ((Math.random() * 0xffffffff) >>> 0)) >>> 0;
    this.gameMode = options.mode ?? DEFAULT_GAME_MODE;
    this.maxPlayers = clamp(options.maxPlayers ?? MAX_PLAYERS, 2, MAX_PLAYERS);
    this.botFill = clamp(options.botFill ?? BOT_FILL_TARGET, 0, this.maxPlayers);
    this.enemyOverride = options.enemies ?? -1;
    this.store = options.store ?? null;
    this.guard = options.guard ?? null;
    this.journal = options.journal ?? null;
    this.onProfilePersisted = options.onProfilePersisted;
    this.hostId = options.hostId ?? 'local';
    this.instanceId = randomToken().slice(0, 8);
    this.sessionOrigin = options.sessionOrigin ?? SessionOrigin.SERVER_MATCHMAKER;
    this.sessionIntent = options.sessionIntent ?? MatchType.PUBLIC;
    this.clock = options.clock ?? (() => Date.now());
    this.variantClaims = options.variantClaims;
    this.eagerWorld = options.eagerWorld ?? true;

    this.world = new ServerWorld(this.seed);
    // THE V4 SEAM POINT. A room already resolves a release per
    // `roomInstanceId`, and the bucket is room-keyed precisely so two content
    // tables can never meet in one match (docs/VARIANTS.md §3). When a
    // variants pack exists, its parsed table becomes a `SessionArsenal` HERE
    // and nothing downstream changes — every reader on the firing path already
    // goes through `sim.statsFor`. Until then the default is the compiled
    // arsenal, which is also what the local Worker gets with no fetches at all.
    /* THE ROOM BUILDS ITS ARSENAL FROM THE BYTES IT WILL SEND.
     *
     * Not from the manifest it parsed. The encode/decode round trip is
     * lossless now that the fields travel as f64, so this costs nothing — and
     * that is exactly why it is worth doing: it makes "both predictors read
     * the same numbers" a property of the STRUCTURE rather than a fact about
     * today's field widths. `fc01475` was five separate versions of the two
     * sides computing the same quantity slightly differently.
     *
     * A table that will not decode leaves the room on the compiled arsenal
     * and tells its clients count 0, so the two sides still agree — agreement
     * over content, every time. */
    this.variantEntries = decodeRoomVariantTable(options.variants ?? null);
    this.variantNames = variantNamesFor(options.variants ?? null, this.variantEntries);
    this.sim = new Simulation(
      this.world, this.seed, SessionArsenal.from(overlaysFromWire(this.variantEntries)),
    );
    this.allWeaponsAtBoot = options.allWeapons === true;
    if (this.allWeaponsAtBoot) this.sim.defaultWeaponMask = ALL_WEAPON_MASK;
    this.monsters = new MonsterManager(this.sim, this.seed);
    this.bots = new BotDriver(this.sim, this.monsters.nav, this.seed);
    this.net = new NetHub(this.sim, this.world, this, () => this.elapsedMs);

    this.levelsResolver = options.levels ?? null;
    this.rollDrops = options.rollDrops;
    this.challenges = options.challenges ?? [];
    this.achievements = options.achievements ?? [];
    this.itemKnown = options.itemKnown ?? (() => false);
    this.challengeItemVersion = options.challengeItemVersion ?? 1;
    this.modeLocked = options.lockMode === true;
    this.contentVersion = options.contentVersion ?? CONTENT_VERSION;
    this.contentHash = options.contentHash ?? BUILTIN_CONTENT_HASH;
    this.admittingFn = options.admitting ?? ((): boolean => true);
    this.flagResolver = options.resolveFlags ?? null;
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
    /* A LOCKED room is one place, decided by the router before this socket ever
     * attached (server/src/index.ts). It answers a `SELECT` with what it
     * actually is and changes nothing at all — not even for a `SELECT` that
     * names this very room. Two reasons, and the second one is the subtle one:
     *
     *   1. A mismatched `SELECT` reconfiguring the room would take everybody
     *      else's match away. That is the obvious hole.
     *   2. A MATCHING `SELECT` re-planned from the client's own message would
     *      quietly discard the router's `ModePlanOverrides` — the operator's
     *      `DOOMCRAFT_BOTS` and `DOOMCRAFT_SEED` — and would honour the
     *      client's `flags`, which include `MSF_NO_BOTS`. One player could
     *      empty a public arena of its bots for everyone in it.
     *
     * A single-room server and the browser Worker keep the original behaviour:
     * there, the client selecting a mode IS how the room learns what to be. */
    if (this.modeLocked) {
      this.sendModeContext(conn);
      return;
    }
    const req = sanitiseJoin(msg, this.levelsResolver);
    if (req.seed === 0) req.seed = this.seed;
    this.applyPlan(resolveModePlan(req), true);
    // A level still being loaded means the honest answer to "do you own this
    // geometry?" is not known yet, and the client uses that answer to decide
    // where to put the level. Hold the reply; `finishLevelRequest` sends it.
    if (this.levelRequestId.length === 0) this.sendModeContext(conn);
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
    if (msg.action === ModeAction.SET_DOOR) { this.setAuthoredDoor(msg); return; }

    if (msg.action === ModeAction.RESTART) {
      // A Quest restart is the level going back to how it was authored, and the
      // client has already re-armed every trigger — so the demons it asked for
      // last life have to go, or the second run starts with two of each.
      if (this.plan.modeId === ModeId.QUEST) { this.clearMonsters(); return; }
      if (this.plan.runRoundTimer) this.beginRound(true);
    }
  }

  /* -------------------------------------------------------------- *
   * Authored geometry
   *
   * THE BUG THIS SOLVES. A Quest level used to exist only in the CLIENT's
   * voxel store: `client/src/modes/quest/levelRuntime.ts` blitted it into
   * `NetClient.world`, relocating it onto whatever arena spawn the room
   * happened to hand out, and this room went on colliding the player's body
   * against generated terrain it had never replaced. `NetClient.applyLocal`
   * rewinds the body onto the server's answer on every snapshot, so the server
   * won every argument about every wall — using hills and cliffs the player
   * could not see. Measured on e1m1: the two worlds agreed on ~20 % of their
   * columns, up to 40 blocks apart, which is a floor you fall through here and
   * an invisible wall in an empty corridor there.
   *
   * The room now owns the geometry. `RoomOptions.levels` supplies the campaign,
   * these methods stamp one level into `ServerWorld`, pin the respawn to the
   * authored player start, re-stream the world so every client is looking at
   * the voxels that are actually being simulated, and carve the doors the level
   * script opens (`setAuthoredDoor`). The client's own blit then lands on the
   * same coordinates — `quest.ts` keeps the authored origin when the room says
   * it owns the level — and the two simulations agree voxel for voxel.
   * -------------------------------------------------------------- */

  /** The level this room's world is running, '' for generated terrain. */
  get authoredLevelId(): string { return this.stampedLevelId; }

  /**
   * Put `levelId`'s voxels into the world. True when the world now holds it.
   *
   * Returns false — and asks for the level, once — when the resolver knows the
   * id but has not loaded it yet. The client is told nothing in that case, so
   * it keeps the old "relocate onto my spawn" behaviour, which is wrong but
   * playable. `finishLevelRequest` re-runs this the moment the level lands, and
   * `onModeSelect` holds the client's answer back until then.
   */
  private stampAuthoredLevel(levelId: string, repaint = false): boolean {
    if (levelId.length === 0) return false;
    if (this.stampedLevelId === levelId && !repaint) return true;
    const src = this.levelsResolver;
    if (src === null || src.levelFor === undefined) return false;

    const level = src.levelFor(levelId);
    if (level === null || level === undefined) {
      if (src.requestLevel === undefined) return false;
      if (this.levelsRequested.has(levelId)) return false;
      this.levelsRequested.add(levelId);
      this.levelRequestId = levelId;
      const settle = (): void => { this.finishLevelRequest(levelId); };
      void Promise.resolve(src.requestLevel(levelId)).then(settle, settle);
      return false;
    }

    this.paintAuthoredLevel(levelId, level);
    return true;
  }

  /**
   * A lazy level load finished, one way or the other.
   *
   * The context is broadcast either way, because the client is WAITING on it:
   * `onModeSelect` holds the reply back while a level is in flight so the
   * campaign never has to guess whether the room is going to own its geometry.
   */
  private finishLevelRequest(levelId: string): void {
    if (this.levelRequestId !== levelId) return;
    this.levelRequestId = '';
    if (this.plan.modeId === ModeId.QUEST && this.plan.levelId === levelId) {
      this.stampAuthoredLevel(levelId);
    }
    this.broadcastModeContext();
  }

  private paintAuthoredLevel(levelId: string, level: Level): void {
    applyLevelToWorld(level, this.world, WORLD_MIN_BLOCK_X, WORLD_MIN_BLOCK_Z, WORLD_SIZE_BLOCKS);
    this.stampedLevelId = levelId;
    this.stampedLevel = level;
    // 0 is reserved for "this room is running generated terrain", so a level
    // that hashes to zero still has to say something. The fold lives in
    // `stampedLevelHash` because the CLIENT now reproduces this exact number to
    // decide whether the room is running its copy of the level.
    this.stampedLevelHash = levelStampHash(level);

    // `compileLevel` has already carved the doors that start open; every other
    // door is stamped shut, which is exactly what the client's blit produces.
    this.doorRows = new Int16Array(level.doors.length);
    for (let i = 0; i < level.doors.length; i++) {
      if ((level.doors[i].flags & DR_START_OPEN) !== 0) this.doorRows[i] = level.doors[i].h;
    }

    const s = primarySpawn(level);
    this.sim.spawnAnchor = { x: s.x, y: s.y, z: s.z, yaw: s.yaw };
    // Everybody in the room is standing on an arena that no longer exists.
    for (const m of this.members.values()) this.sim.spawnPlayer(m.player);
    // A monster spawned against the old terrain is now inside a wall.
    this.clearMonsters();
    this.net.resetWorldStreams();
  }

  /**
   * `ModeAction.SET_DOOR` — carve a door to the row count the level script has
   * it at. See the enum for why the room has to be told rather than deciding.
   *
   * Every input is checked against the level file itself, so the worst a
   * malformed action can do is move voxels the level already authored as a
   * door, between fully shut and fully open.
   */
  private setAuthoredDoor(msg: ModeActionMessage): void {
    const level = this.stampedLevel;
    if (this.plan.modeId !== ModeId.QUEST || level === null) return;
    const i = msg.a | 0;
    if (i < 0 || i >= level.doors.length) return;

    const d = level.doors[i];
    let want = msg.b | 0;
    if (want < 0) want = 0;
    if (want > d.h) want = d.h;
    const have = this.doorRows[i];
    if (want === have) return;

    const y1 = d.y + d.h - 1;
    const x1 = d.x + d.w - 1;
    const z1 = d.z + d.d - 1;
    if (want > have) {
      for (let r = have; r < want; r++) {
        const y = y1 - r;
        for (let z = d.z; z <= z1; z++) {
          for (let x = d.x; x <= x1; x++) this.world.setBlock(x, y, z, BlockId.AIR, 0);
        }
      }
    } else {
      for (let r = have - 1; r >= want; r--) {
        const y = y1 - r;
        for (let z = d.z; z <= z1; z++) {
          for (let x = d.x; x <= x1; x++) this.world.setBlock(x, y, z, d.block, 0);
        }
      }
    }
    this.doorRows[i] = want;
  }

  /** Drop authored geometry and go back to the seed's terrain. */
  private clearAuthoredLevel(): void {
    if (this.stampedLevelId.length === 0) return;
    this.stampedLevelId = '';
    this.stampedLevelHash = 0;
    this.stampedLevel = null;
    this.doorRows = new Int16Array(0);
    this.levelRequestId = '';
    this.world.reset(this.seed);
    this.buildWorld();
    for (const m of this.members.values()) this.sim.spawnPlayer(m.player);
    this.net.resetWorldStreams();
  }

  private broadcastModeContext(): void {
    const conns = this.net.connections;
    for (let i = 0; i < conns.length; i++) {
      if (conns[i].ready) this.sendModeContext(conns[i]);
    }
  }

  /** `ModeAction.SET_SPAWN` — where an authored level says the player starts. */
  private setAuthoredSpawn(msg: ModeActionMessage): void {
    if (this.plan.modeId !== ModeId.QUEST) return;
    // The room owns this level's voxels and therefore its player start; a
    // client-relocated anchor would move the respawn off the geometry.
    if (this.stampedLevelId.length > 0) return;
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
    /* --- authored geometry ------------------------------------------------ *
     * Quest is the one mode whose world is a FILE. Stamp it into `ServerWorld`
     * so the body this room simulates is colliding with the level the player
     * is looking at; leaving Quest throws the level away and regenerates the
     * seed's terrain, or the next Deathmatch would be played inside E1M1.
     * -------------------------------------------------------------------- */
    let stamped = false;
    if (plan.modeId === ModeId.QUEST) {
      // A Quest `SELECT` is a level STARTING, and the client that sent it has a
      // brand-new level script with every door shut and every trigger re-armed
      // (a restart, or the next level). So the same level is REPAINTED, not
      // left alone: otherwise the room keeps the doors it carved for the last
      // attempt and the two worlds part company at the first doorway.
      const same = this.stampedLevelId.length > 0 && this.stampedLevelId === plan.levelId;
      if (!same) this.clearAuthoredLevel();
      stamped = this.stampAuthoredLevel(plan.levelId, same);
    } else {
      // Only an authored level pins the spawn. Everything else spawns on the
      // arena, so a Quest run must not leave its start behind for Deathmatch.
      //
      // THIS MUST HAPPEN BEFORE clearAuthoredLevel(), NOT AFTER IT. That call
      // regenerates the world AND respawns every member, and Sim.spawnPlayer
      // reads `spawnAnchor ?? world.pickSpawn()`. With the anchor still holding
      // the Quest level's authored player start, everyone was respawned onto a
      // coordinate the freshly generated terrain had filled in solid — buried
      // in the ground, unable to move, on the ordinary Quest → menu → Horde
      // path. Clearing it first sends spawnPlayer to pickSpawn as intended.
      this.sim.spawnAnchor = null;
      this.clearAuthoredLevel();
    }

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
    // ...but not when the mode we are entering is the one that paints and the
    // room could NOT take that level over: there the client's blit is the only
    // copy of the level there is, and re-streaming would just race it and lose.
    // A stamp that succeeded has already re-streamed from `paintAuthoredLevel`.
    if (changed && announce && plan.modeId !== ModeId.QUEST && !stamped) {
      this.net.resetWorldStreams();
    }

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
    /* Non-zero means "this room's world IS that level".
     *
     * It is the only thing that tells a Quest client not to relocate the level
     * onto its own spawn — the move that used to leave the client walking
     * around geometry the server had never heard of. Zero keeps the old
     * behaviour, so a room that could not load the level still plays. */
    c.contentHash = plan.levelId.length > 0 && this.stampedLevelId === plan.levelId
      ? this.stampedLevelHash
      : 0;
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

  /** `NetHost.variantTable` — what every joiner is told this room fires with. */
  get variantTable(): readonly VariantWireEntry[] { return this.variantEntries; }
  /** `NetHost.variantNameTable` — what those rows are CALLED. Display only. */
  get variantNameTable(): readonly VariantNameEntry[] { return this.variantNames; }

  onHello(conn: Connection, name: string, skin: number, caps: number): number {
    const humans = this.humanCount;
    if (humans >= this.maxPlayers) return 0;
    // Take a bot's slot rather than refusing a human.
    if (this.sim.players.length >= this.maxPlayers) {
      if (!this.dropWorstBot()) return 0;
    }

    const id = this.allocateId();
    /* RESOLVED BEFORE THE BODY EXISTS, because `addPlayer` spawns it and
     * `spawnPlayer` fills the first magazine through `sim.statsFor` — so a
     * slot decided one line later is a slot that arrived after the magazine
     * it was supposed to size. A variant that pays for its damage with four
     * shells instead of eight would hand this player eight. */
    /* AND WHETHER THIS ROW MAY WEAR ONE AT ALL is a COLUMN, not an `if`
     * (docs/VARIANTS.md §7.3). A ranked-adjacent row resolves everybody to
     * slot 0; the profile keeps its claim and it lights back up in the next
     * casual match, exactly as a dormant item does. Reading the table rather
     * than naming a mode is what `trust.test.ts`'s tree scan enforces. */
    const mayWearVariants = trustPolicyFor(this.plan.modeId, this.sessionIntent).variantsAllowed;
    const player = this.sim.addPlayer(
      id, name, skin, false, resolveVariantSlots(
        mayWearVariants ? this.variantClaims?.(conn) : undefined, caps, this.sim.arsenal.slotCount,
      ),
    );
    const member: Membership = {
      conn, player, isBot: false, joinedMs: this.elapsedMs,
      baseKills: 0, baseDeaths: 0,
    };
    this.members.set(id, member);

    // An idle room belongs to whoever walks in: fresh scores, fresh clock.
    if (humans === 0) this.beginRound(false);
    else if (this.state === RoundState.IDLE) this.state = RoundState.LIVE;

    // The server saw this device attach. That observation — not anything the
    // client will later claim — is what makes a payout possible at all.
    this.addSessionParticipant(member);

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
      this.beginSettle(member, false);
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
    // Open the ledger entry BEFORE the world reset: `generateAll()` can take
    // a while on a real host, and a payout landing in that window has to find
    // a session to land in.
    this.roundStartMs = this.elapsedMs;
    this.sessionId = `${this.name}#${this.round}`;
    this.guard?.open({
      sessionId: this.sessionId,
      modeId: this.plan.modeId,
      origin: this.sessionOrigin,
      serverIntent: this.sessionIntent,
      challenges: this.challenges,
    });
    if (newSeed) {
      this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
      this.world.reset(this.seed);
      this.sim.seed = this.seed;
      if (this.eagerWorld) { this.world.generateAll(); this.worldReady = true; }
      else { this.world.pumpGeneration(25); this.worldReady = false; }
      this.sim.clearWorldEntities();
      this.seedPickups();
      // A new seed just regenerated terrain over the authored level. Put it
      // back, or this room would go on claiming (in `sendModeContext`) to be
      // running a level whose voxels it has thrown away — which is precisely
      // the client/server split this whole path exists to close.
      const authored = this.stampedLevelId;
      if (authored.length > 0) {
        this.stampedLevelId = '';
        this.stampAuthoredLevel(authored);
      }
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
    // A SECOND pass, and it has to be second. `roundStillOpenToJoiners` reads
    // the top score across the whole room, so enrolling inside the loop above
    // would ask that question while some players still carried last round's
    // kills — and the first player in the map would be refused a round they
    // are plainly in.
    for (const m of this.members.values()) this.addSessionParticipant(m);
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
    /* A mode with no win condition has no winner to record. Builder's
     * WinCondition.NONE used to still stamp `won` on whoever led the kill
     * count (or, at 0 kills all round, on whoever happened to be first in
     * the member map) — harmless while it only inflated a stat, money the
     * moment a challenge pays for wins. Read off the mode DESCRIPTOR, never
     * a ModeId literal: reward code stays mode-blind by construction. */
    const winnable = getMode(this.plan.modeId).win !== WinCondition.NONE;
    for (const m of this.members.values()) {
      this.beginSettle(m, winnable && best !== null && m.player.id === best.id);
    }
    // AFTER the loop, never before. `reviewSubmission` refuses anything that
    // arrives past `closedMs`, so closing first would reject the whole room.
    //
    // `sessionId` is deliberately NOT cleared here. It keeps naming the round
    // that just ended, so a player who quits during the 8 s end screen still
    // reaches the guard and is *recorded* being refused a second payout,
    // rather than silently dropped. `beginRound` overwrites it.
    if (this.guard !== null && this.sessionId.length > 0) {
      this.guard.ledger.close(this.sessionId);
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
  /**
   * Settlements that have been STARTED but not finished.
   *
   * `persistMember` is fired with `void` from two places — `onDisconnect` and
   * `endRound` — and each one awaits a journal read, a journal append and a
   * debounced profile write before the money is durable. Nothing used to hold
   * those promises, so `shutdown()` could detach every player (starting a
   * settlement per player), close the store, and `process.exit(0)` while the
   * payout was still queued behind the device lock: the journal row reached the
   * disk, the balance it described did not. This set is what makes the drain
   * able to WAIT for the work it just triggered.
   */
  private readonly settling = new Set<Promise<void>>();

  /** Fire a settlement and remember it until it lands. */
  private beginSettle(member: Membership, won: boolean): void {
    const p = this.persistMember(member, won).catch(() => undefined);
    this.settling.add(p);
    void p.then(() => { this.settling.delete(p); });
  }

  /**
   * Resolve once every settlement this room has started has finished.
   *
   * Looped, not a single `allSettled`: a settlement can start another (the end
   * of a round detaches players), so waiting on one snapshot of the set is not
   * enough.
   */
  async quiesce(): Promise<void> {
    for (let guard = 0; this.settling.size > 0 && guard < 100; guard++) {
      await Promise.allSettled(Array.from(this.settling));
    }
  }

  /** True while money this room owes is still in the air. */
  get settlementsInFlight(): number { return this.settling.size; }

  /**
   * End the round properly because the DEPLOY drain's deadline expired.
   *
   * The deadline used to call `stop()`, which clears the tick timer and nothing
   * else: the round stayed frozen at LIVE, its ledger record stayed open, and
   * the players stayed connected to a dead room until SIGTERM — at which point
   * the settlement had five milliseconds to finish. Ending the round here means
   * the payout happens while the process is unambiguously alive.
   */
  forceEndForDeploy(): void {
    if (this.state === RoundState.LIVE) this.endRound('deploy deadline');
    this.stop();
  }

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

  /**
   * C6: remove every live connection banking to this profile key. The only
   * removal before this was POST /api/admin/drain, which closes EVERY room
   * on the host — a flamethrower where support needed tweezers.
   */
  /**
   * Is this device in this room, in a mode where players can shoot each other?
   *
   * Gate 5 pays ZERO while `SYS_PVP_DAMAGE` is live (§4.5), and that has to be
   * a fact the SERVER establishes — a client that is about to be paid is the
   * last thing that should be asked whether it qualifies. The room knows both
   * halves, so it answers both at once.
   */
  hasDeviceInPvp(profileKey: string): boolean {
    if (profileKey.length === 0 || !this.plan.allowPvp) return false;
    for (const m of this.members.values()) {
      if (m.conn !== null && m.conn.deviceId === profileKey) return true;
    }
    return false;
  }

  kick(profileKey: string, reason = 'removed by operator'): number {
    if (profileKey.length === 0) return 0;
    let kicked = 0;
    for (const m of this.members.values()) {
      if (m.conn !== null && m.conn.deviceId === profileKey) {
        this.net.detach(m.conn, 4403, reason);
        kicked++;
      }
    }
    return kicked;
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

    // Rebase BEFORE anything can throw or await, so a failure downstream loses
    // one payout rather than paying the same kills again on the next call.
    member.baseKills = p.kills;
    member.baseDeaths = p.deaths;

    // No gate, no money. A room built without one (the browser worker, and most
    // tests) writes nothing at all — which is the honest answer, because nothing
    // in that process is in a position to attest to the result.
    if (this.guard === null || this.sessionId.length === 0) return;

    /*
     * SYNCHRONOUS up to and including `submit`. `endRound` closes the session
     * immediately after its payout loop and the guard refuses anything that
     * arrives after `closedMs`, so an `await` before this line would reject the
     * whole room. See the note in `endRound`.
     *
     * Known and accepted for now: `reviewSubmission` marks the device settled
     * on acceptance and there is no un-settle, so if the `store.update` below
     * throws, that player's round is gone. Logged, not retried — a retry would
     * need a two-phase settle the ledger does not have.
     */
    // A device this round never enrolled is owed nothing — but ASK THE LEDGER,
    // do not ask the guard. The guard would answer NOT_A_PARTICIPANT and flag
    // it `violation: true`, which is exactly right for a forged submission and
    // exactly wrong for somebody who walked in after the match was decided. The
    // audit ring is for suspicion; filling it with honest latecomers is how a
    // security log stops being read.
    const record = this.guard.ledger.get(this.sessionId);
    if (record === null || !record.participants.has(deviceId)) return;

    /* And the same argument again, for the same reason.
     *
     * A player whose socket drops mid-round is settled right there by
     * `onDisconnect` — correctly, so a rage-quitter cannot go unpaid. The client
     * then reconnects on its own (it is unconditional for remote sessions, with
     * backoff), the directory hands them back the seat they just vacated, and if
     * anyone else is still in the room the round never restarted: same session,
     * same device, already settled. Their end-of-round submission then hits
     * check 6 and raises ALREADY_SETTLED with `violation: true`.
     *
     * That is exactly right for a replayed forgery and exactly wrong for a phone
     * moving from WiFi to cellular, which is the commonest event on the network
     * this game runs over. The room is the only thing that knows the difference,
     * so — as with the latecomer check above — the room does not ask.
     *
     * NOTE, and it is not fixed by this line: the player still loses the
     * earnings from their second segment, because the ledger has no un-settle
     * and the "one payout per device per session" invariant is what stops
     * double-payment. Recovering those needs a reconnect grace window that
     * re-attaches the membership instead of settling on disconnect. Specced in
     * HANDOVER §6; deliberately not attempted in the same commit as a set of
     * money-path fixes. */
    if (record.settled.has(deviceId)) return;

    const verdict = this.guard.submit(
      this.buildRoundSubmission(member, deviceId, won, kills, deaths, seconds),
    );
    const result = toMatchResult(verdict);
    if (result === null) return;

    // The connection is captured NOW. `store.update` awaits, and a player who
    // rage-quits during the end screen has a torn-down `member.conn` by the
    // time it resolves.
    const conn = member.conn;
    try {
      let landed = { xp: 0, scrap: 0 };
      let paid: boolean = false;
      /*
       * THE WHOLE MOVEMENT, INSIDE ONE LOCK. Ask the journal, move the balance,
       * record what moved — no await between the mutation and the row that
       * describes it, and no other writer for this device in between.
       *
       * The order is load-bearing in both directions. The idempotency check is
       * FIRST because a duplicate must not move the balance either: a journal
       * that merely declines to record a second payout, while
       * `applyMatchResult` runs twice, is a journal that lies about a balance
       * it watched change. And the append is LAST but still inside, so the row
       * reaches the disk before `save()` even marks the profile dirty (that
       * write is debounced 800 ms). The journal therefore LEADS the balance on
       * a crash, which is the recoverable direction — a row with no balance can
       * be re-applied, a balance with no row cannot be explained.
       */
      /* THE IDEMPOTENCY KEY IS PINNED HERE, OUTSIDE THE CALLBACK.
       *
       * `payoutSourceId()` reads `this.sessionId`, which `beginRound` replaces
       * after the 8 s end screen. The callback below runs behind the per-device
       * lock and behind a profile read, so it can easily still be waiting when
       * that happens — and it then journals round N's payout under round N+1's
       * key. The damage is not the mislabelled row: it is that the REAL N+1
       * settlement then finds its own key already present, takes the
       * `journal.has` early return, and pays the player nothing for a round
       * they played. Captured at submission time, it names the round that was
       * actually settled, whatever the room has moved on to. */
      const sourceId = this.payoutSourceId();
      const updated = await this.store.update(deviceId, async (profile) => {
        const journal = this.journal;
        // ONE wall clock for the whole settlement: drop timestamps, journal
        // ms, and — load-bearing for challenges — the period keys, derived
        // exactly once so a midnight straddle cannot split the receipt from
        // the journal's idempotency key.
        const now = Date.now();
        if (journal !== null && await journal.has(MATCH_PAYOUT, sourceId, deviceId)) return;
        const before = { xp: profile.progress.xp, scrap: profile.economy.scrap };
        landed = applyMatchResult(profile, result);
        /* Items land HERE, inside the same idempotency umbrella: the
         * journal.has check above already refused a replayed round, so a
         * granted drop can no more double than a balance can. */
        if (result.drops.length > 0) grantDrops(profile, result.drops, 'drop', sourceId, now);
        paid = true;
        profile.progress.lastSeed = this.seed;
        if (profile.progress.name.length === 0) profile.progress.name = p.name;
        if (journal !== null) {
          await journal.append(matchPayoutRows({
            playerId: deviceId,
            sourceId,
            ms: now,
            before,
            // Read back off the profile, not off `landed`: the two differ the
            // moment `MAX_SCRAP_BALANCE` clamps, and the row has to describe the
            // balance rather than the intention.
            after: { xp: profile.progress.xp, scrap: profile.economy.scrap },
            asked: { xp: result.xp, scrap: result.scrap },
            code: verdict.code,
          }));
        }
        /* Challenges settle LAST, same lock, own idempotency keys: accrual
         * folds this round's guard-verified ids into the period counters,
         * and every owed completion pays has-first, per completion, with
         * its own journal row (server/src/persistence.ts settleChallenges —
         * the crash-window analysis lives on that function). */
        /* The kill switch is real on BOTH halves: killing
         * economy_competitions stops the producer (challengeIdsFor) and the
         * payer, or an operator who pulls the flag over a mispriced def
         * keeps paying every player already at target. Item rewards ride
         * economy_items as well, exactly as match drops do — one flag, one
         * meaning, wherever an item is minted. */
        const challengeFlags = conn.flagBits;
        if (this.challenges.length > 0 && flagOn(challengeFlags, 'economy_competitions')) {
          await settleChallenges(profile, {
            defs: this.challenges,
            grantedIds: result.challengeIds,
            stats: result,
            nowMs: now,
            deviceId,
            mayPayScrap: result.mayPayChallenges,
            mayGrantItems: result.mayGrantChallengeItems && flagOn(challengeFlags, 'economy_items'),
            itemVersion: this.challengeItemVersion,
            journal,
            rowId: newLedgerId,
          });
        }

        /* Achievements settle after challenges and before the delta below.
         * AFTER `applyMatchResult`, because that is what pushes the lifetime
         * stats over a target this round; BEFORE the `landed` recomputation,
         * because the intermission's "+N Scrap" has to describe the whole
         * settlement — the same bug was shipped once for challenges and the
         * comment below is the repair.
         *
         * The flag gates PAYMENT and nothing else. It cannot gate progress:
         * progress is `profile.stats`, which `applyMatchResult` has already
         * written whatever the flag says. So play during a disabled period
         * counts, and re-enabling pays what was earned meanwhile — which is
         * what the flag's blastRadius string tells the operator. */
        if (this.achievements.length > 0 && flagOn(challengeFlags, 'economy_achievements')) {
          await settleAchievements(profile, {
            defs: this.achievements,
            nowMs: now,
            deviceId,
            mayPayScrap: result.mayPayChallenges,
            mayGrantItems: result.mayGrantChallengeItems && flagOn(challengeFlags, 'economy_items'),
            itemVersion: this.challengeItemVersion,
            itemKnown: this.itemKnown,
            journal,
            rowId: newLedgerId,
          });
        }

        /* THE DELTA THE PLAYER IS SHOWN MUST DESCRIBE THE WHOLE SETTLEMENT.
         *
         * `landed` came from `applyMatchResult` alone, which moves only the
         * metered match reward — it cannot see a challenge prize, because
         * `settleChallenges` credits after it. The packet then carried a
         * pre-challenge delta next to a post-challenge total, breaking the
         * contract `protocol.ts` states in as many words: "`xp`/`scrap` are the
         * DELTA this round produced after every server-side reduction;
         * `totalXp`/`totalScrap` are the balances the server just wrote."
         *
         * The balance was never wrong — the client adopts `totalScrap`
         * wholesale — so nothing was owed. What was wrong is the number on the
         * one surface that tells a player their reward worked: the intermission
         * counted "+0 Scrap" for a round that paid 40, on the very first daily
         * they ever completed. Derived from the same before/after pair the
         * journal already uses, it now absorbs anything credited inside this
         * lock, including a debt carried over from an earlier session. */
        landed = { xp: profile.progress.xp - before.xp, scrap: profile.economy.scrap - before.scrap };
      });
      if (paid) this.tellPlayerWhatLanded(conn, landed, updated, verdict.code);
      /* Viral tier 1: a paying round is the moment an engagement threshold
       * can newly be true. Fire-and-forget — a referral must never delay or
       * break a payout. */
      if (paid) this.onProfilePersisted?.(deviceId);
    } catch {
      // A failed save must never take the match down.
    }
  }

  /**
   * The idempotency source for this round's payouts: host, room object, round.
   *
   * All three are needed and none is decorative. `hostId` separates two
   * processes (`sessionId` repeats across a restart); `instanceId` separates
   * two rooms that held the same key at different times, whose rounds both
   * start at 1; `sessionId` separates the rounds inside one room. The PLAYER is
   * not in here — it is the third component of the idempotency key itself,
   * because one round pays every player in the room.
   */
  private payoutSourceId(): string {
    return `${this.hostId}:${this.instanceId}:${this.sessionId}`;
  }

  /* -------------------------------------------------------------- *
   * The reward path
   *
   * Everything the room knows about what a match was worth lives in this one
   * section, and it knows nothing about which mode pays what — that is
   * `shared/src/trust.ts`'s job and the guard applies it. Deliberately kept
   * clear of mode literals: `shared/src/trust.test.ts` scans the whole tree for
   * a line that names a mode and a reward in the same breath, because that is
   * how a policy leaks out of the table one convenient `if` at a time.
   * -------------------------------------------------------------- */

  /**
   * How much of a round may have run before a newcomer is playing somebody
   * else's match. Half of it: four minutes of the eight-minute clock.
   */
  private static readonly LATE_JOIN_LOCKOUT_MS = MATCH_DURATION_MS * 0.5;

  /**
   * One player's claim on the round in progress, as the room tallied it.
   *
   * `stats` is never omitted: `toMatchResult` returns null without it, so an
   * XP-only submission would be accepted, mark the device settled, and pay
   * exactly nothing.
   */
  private buildRoundSubmission(
    member: Membership, deviceId: string,
    won: boolean, kills: number, deaths: number, seconds: number,
  ): ResultSubmission {
    const p = member.player;
    // The amounts live in `reward.ts`; the room only reports what it saw.
    return buildSubmission({
      sessionId: this.sessionId,
      deviceId,
      won,
      kills,
      deaths,
      seconds,
      drops: this.rollDropsSafe(member, deviceId, won, kills, seconds),
      challengeIds: this.challengeIdsFor(member, won, kills),
      bestStreak: p.bestStreak,
      damageDealt: p.damageDealt,
      blocksPlaced: p.blocksPlaced,
      blocksBroken: p.blocksBroken,
      favouriteWeapon: p.weapon,
    });
  }

  /**
   * The challengeIds producer: the ids this member's round contributes to,
   * from the room's pinned defs — gated on the member's server-resolved
   * `economy_competitions` bit (the flag registry claims daily/weekly
   * challenges for it), the `rollDrops` pattern, so the kill switch is real.
   */
  private challengeIdsFor(member: Membership, won: boolean, kills: number): readonly string[] {
    if (this.challenges.length === 0 || !member.conn) return [];
    if (!flagOn(member.conn.flagBits, 'economy_competitions')) return [];
    const p = member.player;
    return contributingChallengeIds(this.challenges, {
      kills,
      won,
      bestStreak: p.bestStreak,
      damageDealt: p.damageDealt,
      blocksPlaced: p.blocksPlaced,
      blocksBroken: p.blocksBroken,
    });
  }

  /** A drop roll must never take a payout down with it. */
  private rollDropsSafe(
    member: Membership, deviceId: string, won: boolean, kills: number, seconds: number,
  ): readonly string[] {
    const roll = this.rollDrops;
    if (roll === undefined || member.conn === null) return [];
    try {
      return roll({ deviceId, flagBits: member.conn.flagBits, kills, seconds, won });
    } catch {
      return [];
    }
  }

  /**
   * Tell one player what the round actually paid them, once the write is done.
   *
   * Behind the server-resolved kill switch, NOT behind the client's own product
   * flag: `shared/src/features.ts` says in its own header that it is not a
   * security boundary, and a message is a thing this process chooses to send.
   * A client with the surface switched off simply ignores the packet; a client
   * with it switched on and the kill switch off is never sent one.
   *
   * The amounts are `AppliedRewards` — post-ladder, post-day-cap. Sending the
   * asked-for number instead would put a figure on the player's screen that
   * their profile does not contain, which is the one lie an economy cannot
   * afford.
   */
  private tellPlayerWhatLanded(
    conn: Connection, landed: Pick<AppliedRewards, 'xp' | 'scrap'>,
    updated: StoredProfile, code: number,
  ): void {
    if (!flagOn(conn.flagBits, 'economy_scrap')) return;
    if (!conn.ready || conn.closed) return;
    this.net.sendMatchAwardTo(
      conn, landed.xp, landed.scrap, updated.progress.xp, updated.economy.scrap, code,
    );
  }

  /**
   * Note that the server saw this device in this round. A device that is not in
   * the participant set cannot be paid for the round, however honest its
   * numbers look — which is what stops one player settling for everybody else.
   */
  private addSessionParticipant(m: Membership): void {
    if (this.guard === null || this.sessionId.length === 0) return;
    if (m.isBot || m.conn === null || m.conn.deviceId.length === 0) return;
    if (!this.roundStillOpenToJoiners()) return;
    this.guard.ledger.addParticipant(this.sessionId, m.conn.deviceId);
  }

  /**
   * May somebody arriving right now still earn anything from this round?
   *
   * The third of the four anti-farm rules in `docs/ECONOMY.md`: no reward from
   * a match you joined after it was decided. It is a refusal to ENROL rather
   * than a refusal to pay, because that is the only shape the ledger can hold —
   * `SessionRecord.participants` is a bare set of device ids with no join time,
   * so by the time a submission arrives the room is the only thing left that
   * remembers when the player walked in.
   *
   * Refusing the enrolment is also the kinder failure. A device outside the
   * participant set never reaches `guard.submit` at all (see `persistMember`),
   * so a latecomer costs the audit ring nothing.
   *
   * The player still plays, still appears on the scoreboard, and is enrolled
   * normally by the next `beginRound`. They just do not get paid for a match
   * whose result was settled before they arrived.
   */
  private roundStillOpenToJoiners(): boolean {
    // Over is over: the eight-second end screen is not the match.
    if (this.state === RoundState.ENDED) return false;
    if (this.timeLeftMs <= 0) return false;
    // Past the halfway mark there is not enough round left to have played it.
    if (this.elapsedMs - this.roundStartMs > Room.LATE_JOIN_LOCKOUT_MS) return false;
    // And a match somebody has already won is decided whatever the clock says.
    let leader = 0;
    for (const m of this.members.values()) if (m.player.kills > leader) leader = m.player.kills;
    return leader < SCORE_LIMIT;
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

  /**
   * Give a player every weapon, loaded.
   *
   * This comment used to say "Sandbox mode and the tutorial use this", and that
   * is FALSE: `grep -rn grantAllWeapons` finds no caller of this METHOD outside
   * tests. The hits in `modes.ts` and at :901 are `plan.grantAllWeapons`, a
   * different thing — a boolean that sets `sim.defaultWeaponMask`, which is the
   * mechanism sandbox actually uses. Corrected rather than deleted because the
   * method is public API, a room CAN legitimately be built with both a pinned
   * variant table and a full arsenal (`patch.test.ts` builds one), and the
   * magazine bug that lived on this line was real whether or not anything
   * calls it today.
   */
  grantAllWeapons(playerId: number): void {
    const p = this.sim.getPlayer(playerId);
    if (!p) return;
    p.weaponMask = ALL_WEAPON_MASK;
    /* Through `sim.statsFor`, not the compiled table — the same seam
     * `spawnPlayer` and `onHello` already go through, and for the same reason.
     * This room can hold a pinned variant table (the constructor builds its
     * `SessionArsenal` from the bytes it will send) AND hand somebody the full
     * arsenal: the two are independent options, `variants` and `allWeapons`,
     * and `patch.test.ts` already builds exactly that room. Filling from
     * `getWeapon(i)` here overwrote the magazines `spawnPlayer` had just sized
     * correctly, so a shotgun variant that pays for its damage with four
     * shells handed this player the base's eight and never charged the
     * drawback — and, worse, only on the sandbox and tutorial path, so the
     * player who was being TAUGHT the weapon was the one taught the wrong
     * number. */
    for (let i = 0; i < WEAPON_COUNT; i++) p.mag[i] = this.sim.statsFor(p, i).magSize;
    p.reserve.set(AMMO_MAX);
  }
}
