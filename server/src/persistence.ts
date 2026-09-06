/**
 * DOOMCRAFT — save games.
 *
 * Account-less by default: the client generates a device id, keeps it in
 * localStorage and sends it with every profile request. An optional account id
 * can be linked later so the same progress follows a player to another device.
 *
 * Storage is behind `PersistenceStore` so the JSON files under `server/.data/`
 * can be swapped for Postgres without touching the game. Every record carries a
 * schema version and goes through `migrateProfile` on load.
 *
 * The node:fs import is deliberately dynamic and built from a runtime string:
 * this module is safe to import (as types) from browser code.
 */

import {
  ITEM_KIND_NAMES, ItemKind, formatItemRef, parseItemRef, refIsWeaponVariant, type OwnedItem,
} from '@doomcraft/shared/items';
import {
  challengeAggregation,
  challengeContribution,
  challengePeriodKey,
  utcDayKey,
  utcWeekKey,
  type ChallengeDef,
  type ChallengeStatSource,
} from '@doomcraft/shared/challenges';
import type { LedgerEntry } from './journal.js';
import {
  DEFAULT_PROGRESS,
  DEFAULT_SETTINGS,
  IAP_PRODUCT_REMOVE_ADS,
  MAX_NAME_LENGTH,
  SAVE_VERSION,
  WEAPON_COUNT,
  PLACEABLE_BLOCKS,
  WeaponId,
  levelForXp,
} from '@doomcraft/shared';
import type { GameSettings, SaveProgress } from '@doomcraft/shared';
import { isPrototypePollutingKey } from '@doomcraft/shared/trust';

/**
 * Bump when the stored shape changes and add a step to MIGRATIONS.
 *
 * FOUR THINGS MOVE TOGETHER or the new field is destroyed on the next disk
 * read: this number, a step appended to `MIGRATIONS`, the field's block in the
 * `out` literal inside `migrateProfile`, and `createProfile()`. The literal is
 * the one people forget — `migrateProfile` rebuilds the profile from a
 * whitelist, so a migration step that adds a key the literal does not name is a
 * no-op with a version bump on it.
 */
export const PERSIST_VERSION = 7;

/** Hard ceiling on a stored balance. A bug, not a player, is what hits this. */
export const MAX_SCRAP_BALANCE = 1_000_000_000;
/**
 * Ceilings on the per-day earn buckets — the second of the four anti-farm rules
 * in `docs/ECONOMY.md`, filled by `meterReward` below.
 *
 * Roughly fifteen honest Deathmatch rounds' worth of XP. A player who reaches
 * either of these has had a very long day; a script reaches them by lunchtime
 * and then stops being worth running.
 */
export const DAY_XP_CAP = 6_000;
export const DAY_SCRAP_CAP = 800;

export interface StoredLoadout {
  /** WeaponId the player spawns holding when the mode allows a choice. */
  primary: number;
  /** Preferred weapon order for the hotbar. */
  weapons: number[];
  /** BlockId hotbar for build mode. */
  blocks: number[];
}

export interface StoredEntitlements {
  adsRemoved: boolean;
  product: string | null;
  receipt: string | null;
  purchasedMs: number;
}

/**
 * The one match most recently paid out — what a share card renders
 * (docs/ECONOMY.md "Share cards"). `xp`/`scrap` are the amounts that
 * actually LANDED after the caps and the ladder, because the card is a
 * public artefact and must not promise more than the ledger recorded.
 */
export interface LastMatch {
  ms: number;
  kills: number;
  deaths: number;
  won: boolean;
  seconds: number;
  bestStreak: number;
  xp: number;
  scrap: number;
}

export interface StoredStats {
  matches: number;
  wins: number;
  kills: number;
  deaths: number;
  bestStreak: number;
  damageDealt: number;
  blocksPlaced: number;
  blocksBroken: number;
  secondsPlayed: number;
  /** WeaponId with the most kills. */
  favouriteWeapon: number;
  weaponKills: number[];
  lastSeenMs: number;
  /** Null until the first paying round. */
  last: LastMatch | null;
}

/**
 * The currency half of a profile, kept off `progress` on purpose.
 *
 * `progress` is the merge target of the client-writable `POST /api/profile`
 * body and it is a *shared* type the browser's own save file also uses. A
 * balance that lives there is a balance the client has an opinion about. This
 * section has exactly two writers: `applyMatchResult`, and a future spend path.
 */
export interface StoredEconomy {
  /** Spendable balance. */
  scrap: number;
  /** Monotonic lifetime total, for audit and for "you have earned N". */
  lifetimeScrap: number;
  /** UTC 'YYYY-MM-DD' the buckets below belong to. */
  day: string;
  dayXp: number;
  dayScrap: number;
  dayMatches: number;
}

/**
 * Daily/weekly challenge state — progress counters and the PAID receipts,
 * on the profile so one `store.update` lock covers the count, the credit,
 * the item and the journal row atomically (the S4 design decision: the
 * competitions service marks its doc finalised BEFORE paying and a crash
 * mid-loop loses placements forever; one store has no such window).
 *
 * `done` is the durable once-per-period receipt: the journal's dedup set
 * only spans ~48 h and a weekly period outlives it. Ids carry their period
 * as a prefix by construction (`daily.`/`weekly.` — the parser refuses
 * anything else), which is what lets the roll prune by prefix.
 *
 * `owed` is the other durable half, and the reason a period roll cannot
 * eat a debt: a completion banked in a session that may not PAY (public
 * Builder grants challenge progress but not Scrap) lands here with the
 * period key it was earned in, survives the roll that wipes `counts`, and
 * pays at the first settlement that can. Without it the roll silently
 * forfeited every banked-but-unpaid completion at UTC midnight.
 */
export interface ChallengeOwed {
  readonly id: string;
  /** The period the completion was EARNED in — never recomputed at pay time. */
  readonly periodKey: string;
  /** `challenge:<id>:<periodKey>` — the journal idempotency source. */
  readonly sourceId: string;
  readonly scrap: number;
  /** Items-manifest local id, or null. */
  readonly item: string | null;
}

/**
 * Rewarded-ad grants, ON THE PROFILE because they are MONEY.
 *
 * The interstitial's frequency cap lives in memory with the rest of the ad
 * cap machine, and that is right: it protects a player, and a restart
 * forgiving the count errs towards showing FEWER ads. This one errs the other
 * way — an in-memory grant counter is reset by every deploy, and this project
 * deploys several times a day, so "four a day" would mean "four per deploy".
 * Rule 20's precedent: money that must survive a restart goes on the profile.
 */
export interface StoredAdRewards {
  /** UTC 'YYYY-MM-DD' the count belongs to. */
  day: string;
  /** Grants already taken today. Indexes the diminishing ladder. */
  count: number;
  /** When the last grant landed, for the minimum-gap rule. */
  lastMs: number;
}

export interface StoredChallenges {
  /** UTC 'YYYY-MM-DD' the daily counters belong to. */
  day: string;
  /** ISO week 'YYYY-Www' the weekly counters belong to. */
  week: string;
  /** Per-challenge progress, clamped at each def's target. */
  counts: Record<string, number>;
  /** Challenge ids completed AND PAID in their current period. */
  done: string[];
  /** Completions earned but not yet paid. Carries its own period key. */
  owed: ChallengeOwed[];
}

/**
 * What a player OWNS. `items` are granted refs with provenance; whether a
 * given ref is wearable is NEVER stored — it is derived from the live
 * release on read (docs/PACKS.md §7, `itemStateFor`), so a rollback
 * recomputes ownership for every player at once and writes nothing.
 * Duplicates are meaningful: crafting eats them (docs/ECONOMY.md).
 */
export interface StoredInventory {
  items: OwnedItem[];
  /** Item ref, or ''. Wearing is a claim; the renderer checks the state. */
  equippedSkin: string;
  title: string;
  /**
   * V4c — the equipped WEAPON VARIANT per base weapon: `String(weaponId)` ->
   * the owned item REF, absent meaning "the base gun".
   *
   * IT STORES THE REF AND NOT A SLOT INDEX, and that is the whole point. A
   * slot index is meaningful only against ONE variant table; this profile
   * outlives every table it will ever be read against, and two rooms pinned
   * to different releases order their rows differently. So the durable thing
   * is the identity of the token the player owns, and the slot is recomputed
   * per room from the ordering that room will actually SEND
   * (`server/src/variantClaims.ts`). A stored slot would hand the player the
   * other gun with no error anywhere.
   */
  variants: Record<string, string>;
}

/**
 * The operator's record — the C6 half of the v5 bump (docs/PLATFORM.md §12),
 * landed WITH the inventory so the schema moves once, not twice.
 * `revokedItems` is the only written item state there is: REVOKED means an
 * operator explicitly took it back, with a logged reason.
 */
export interface StoredModeration {
  banned: boolean;
  bannedUntilMs: number;
  reason: string;
  revokedItems: { ref: string; ms: number; reason: string }[];
}

/** 'unknown' | 'u13' | '13-17' | '18plus' — consent gating reads this, nothing else does. */
export type AgeBand = 'unknown' | 'u13' | '13-17' | '18plus';

export interface StoredProfile {
  version: number;
  deviceId: string;
  /** Set once an account is linked. */
  accountId: string | null;
  /** Server-issued opaque token, not a user password. Rotated on every link. */
  accountSecret: string | null;
  createdMs: number;
  updatedMs: number;
  progress: SaveProgress;
  settings: GameSettings;
  bindings: Record<string, string>;
  loadout: StoredLoadout;
  entitlements: StoredEntitlements;
  stats: StoredStats;
  economy: StoredEconomy;
  inventory: StoredInventory;
  moderation: StoredModeration;
  challenges: StoredChallenges;
  adRewards: StoredAdRewards;
  ageBand: AgeBand;
  /**
   * THE DOWNGRADE GUARD. Top-level keys this build does not recognise, carried
   * through untouched and written back out by `serialiseProfile`.
   *
   * `migrateProfile` rebuilds every profile from a whitelist and stamps
   * `PERSIST_VERSION` on it, which is right for reading and catastrophic for
   * writing: without this, a v5 profile opened by a rolled-back v4 server is
   * rewritten as v4 and every v5 field is gone from the player's account
   * permanently. `SaveFile._unknown` (`shared/src/saves.ts`) does exactly this
   * for the browser's local save; profiles had no equivalent, so a rollback
   * would have destroyed Scrap balances the first time one happened.
   *
   * Never read from this. It exists to be preserved, not consulted.
   */
  _unknown?: Record<string, unknown>;
}

/**
 * Top-level profile keys this build owns. Anything else goes to `_unknown` and
 * comes back out unchanged.
 *
 * Add a key here in the SAME change that adds it to `StoredProfile`, or the new
 * field round-trips through `_unknown` and is written twice.
 */
export const KNOWN_PROFILE_KEYS: readonly string[] = Object.freeze([
  'version', 'deviceId', 'accountId', 'accountSecret', 'createdMs', 'updatedMs',
  'progress', 'settings', 'bindings', 'loadout', 'entitlements', 'stats',
  'economy', 'inventory', 'moderation', 'challenges', 'adRewards', 'ageBand', '_unknown',
]);

/**
 * Sections the downgrade guard also protects INSIDE, not just at the top level.
 *
 * `docs/DEPLOY.md` claimed "a v5 profile opened by a v4 host comes back out with
 * its v5 fields intact". That was true only of top-level keys: the guard walked
 * `Object.entries(raw)` and stopped. A v5 field added inside `economy` — the
 * natural home for a second currency or a season, i.e. the most likely v5 field
 * there is — was annihilated by a v4 rollback, silently, with no counter and no
 * log line. The sentence was corrected by making it true.
 *
 * These are the sections whose sub-keys are a FIXED schema, so an unrecognised
 * one is a newer build's field. `bindings` is deliberately absent: its keys ARE
 * the data (`action -> key code`), so "unknown key" has no meaning there.
 *
 * The known sub-keys are never listed. They are read off the migrated section
 * itself, which is built from a whitelist literal in `migrateProfile` — so this
 * cannot drift out of date the way a second hand-written list would.
 */
export const GUARDED_PROFILE_SECTIONS: readonly string[] = Object.freeze([
  'progress', 'settings', 'loadout', 'entitlements', 'stats', 'economy',
  'inventory', 'moderation', 'challenges',
]);

/**
 * Where the per-section bags live: `_unknown._nested`, which `serialiseProfile`
 * spreads out as a single top-level `_nested` key.
 *
 * Deliberately NOT in `KNOWN_PROFILE_KEYS`, so a build that has the top-level
 * guard but not this one treats it as an ordinary unknown key and carries it
 * through untouched. That build is the one shipping today, which makes rolling
 * THIS commit back lossless as well.
 */
const NESTED_BAG_KEY = '_nested';

export interface MatchResult {
  kills: number;
  deaths: number;
  won: boolean;
  bestStreak: number;
  damageDealt: number;
  blocksPlaced: number;
  blocksBroken: number;
  seconds: number;
  xp: number;
  /**
   * REQUIRED, not optional. An optional money field is a field that silently
   * pays zero the day somebody builds a `MatchResult` and forgets it, and no
   * type error ever says so. `toMatchResult` is the only producer.
   */
  scrap: number;
  favouriteWeapon: number;
  /**
   * Item refs granted by the guard for this round. REQUIRED for the same
   * reason `scrap` is: an optional field silently drops loot the day a
   * producer forgets it. `toMatchResult` is the only producer; the drops it
   * carries are already clamped to MAX_DROPS_PER_MATCH and gated by
   * REWARD_ITEM_DROP. `applyMatchResult` ignores them — items land through
   * `grantDrops`, beside it, under the same lock.
   */
  drops: readonly string[];
  /**
   * Guard-verified challenge ids this match contributes to, and the payment
   * gates read off the sealed trust row. REQUIRED, same doctrine as `scrap`:
   * an optional field silently strands challenge progress the day a producer
   * forgets it. `toMatchResult` is the only producer; `settleChallenges`
   * consumes them under the same lock as everything else.
   */
  challengeIds: readonly string[];
  mayPayChallenges: boolean;
  mayGrantChallengeItems: boolean;
}

/**
 * What actually landed in a profile. `xp`/`scrap` are the amounts AFTER the
 * per-day cap and the diminishing-returns ladder, so they are what a client
 * may be told it earned — never what the room asked for.
 */
export interface AppliedRewards {
  profile: StoredProfile;
  xp: number;
  scrap: number;
}

export interface PersistenceStore {
  load(deviceId: string): Promise<StoredProfile | null>;
  /**
   * The profile THIS PROCESS ALREADY HAS IN MEMORY, or null. Never touches a
   * disk and never creates anything, so it is safe on a synchronous path.
   *
   * It exists for exactly one caller: the variant claim resolver, which runs
   * inside `Room.onHello` — a synchronous frame, deliberately, because
   * `spawnPlayer` fills the first magazine through `sim.statsFor` and a slot
   * decided one line later hands a four-shell variant an eight-shell
   * magazine. The websocket upgrade handler warms this with an `await` before
   * the connection is ever made, so a miss means "no ticket, or a profile this
   * host has never read" — which resolves to the base weapon, not to an error.
   *
   * A miss is therefore ORDINARY, and no caller may treat it as a fault.
   */
  peek(deviceId: string): StoredProfile | null;
  /** Load or create. Never returns null. */
  ensure(deviceId: string): Promise<StoredProfile>;
  save(profile: StoredProfile): Promise<void>;
  /**
   * Read-modify-write under a per-device lock.
   *
   * The callback may be ASYNC, and the lock is held for the whole of it. That
   * is what lets the reward journal be written from inside the same critical
   * section that moved the balance — a journal appended after the lock is
   * released is a journal that can disagree with the balance it describes.
   * Every await inside a callback is lock time for that one device, so what
   * belongs in here is the write that must not be separable from the mutation,
   * and nothing else.
   */
  update(deviceId: string, mutate: (p: StoredProfile) => void | Promise<void>): Promise<StoredProfile>;
  grantEntitlement(deviceId: string, product: string, receipt: string | null): Promise<StoredProfile>;
  linkAccount(deviceId: string, accountId: string): Promise<{ profile: StoredProfile; secret: string }>;
  resolveAccount(accountId: string, secret: string): Promise<StoredProfile | null>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------------ *
 * Defaults, validation and migration
 * ------------------------------------------------------------------------ */

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidDeviceId(id: unknown): id is string {
  return typeof id === 'string' && DEVICE_ID_RE.test(id);
}

export function defaultLoadout(): StoredLoadout {
  return {
    primary: WeaponId.PISTOL,
    weapons: [WeaponId.PISTOL, WeaponId.SHOTGUN, WeaponId.CHAINGUN, WeaponId.ROCKET, WeaponId.PLASMA, WeaponId.BFG, WeaponId.CHAINSAW],
    blocks: PLACEABLE_BLOCKS.slice(0, 9),
  };
}

export function defaultStats(): StoredStats {
  return {
    matches: 0, wins: 0, kills: 0, deaths: 0, bestStreak: 0, damageDealt: 0,
    blocksPlaced: 0, blocksBroken: 0, secondsPlayed: 0,
    favouriteWeapon: WeaponId.PISTOL,
    weaponKills: new Array<number>(WEAPON_COUNT).fill(0),
    lastSeenMs: 0,
    last: null,
  };
}

export function defaultEconomy(): StoredEconomy {
  return { scrap: 0, lifetimeScrap: 0, day: '', dayXp: 0, dayScrap: 0, dayMatches: 0 };
}

export function createProfile(deviceId: string, nowMs = Date.now()): StoredProfile {
  return {
    version: PERSIST_VERSION,
    deviceId,
    accountId: null,
    accountSecret: null,
    createdMs: nowMs,
    updatedMs: nowMs,
    progress: { ...DEFAULT_PROGRESS },
    settings: { ...DEFAULT_SETTINGS },
    bindings: {},
    loadout: defaultLoadout(),
    entitlements: { adsRemoved: false, product: null, receipt: null, purchasedMs: 0 },
    stats: defaultStats(),
    economy: defaultEconomy(),
    inventory: defaultInventory(),
    moderation: defaultModeration(),
    challenges: defaultChallenges(),
    adRewards: defaultAdRewards(),
    ageBand: 'unknown',
  };
}

function defaultInventory(): StoredInventory {
  return { items: [], equippedSkin: '', title: '', variants: {} };
}
function defaultChallenges(): StoredChallenges {
  return { day: '', week: '', counts: {}, done: [], owed: [] };
}
function defaultAdRewards(): StoredAdRewards {
  return { day: '', count: 0, lastMs: 0 };
}

/**
 * Read back a reward record, refusing anything that would loosen a cap.
 *
 * A profile is bytes on a disk this process does not exclusively own, so a
 * count is clamped and a future timestamp is discarded: `lastMs` in the future
 * would make the minimum-gap check pass forever, which is the one direction
 * that pays money.
 */
function sanitiseAdRewards(raw: unknown, nowMs: number): StoredAdRewards {
  const r = asRecord(raw);
  const lastMs = Math.max(0, num(r.lastMs, 0));
  return {
    day: str(r.day, '').slice(0, 10),
    count: clampInt(num(r.count, 0), 0, 1_000),
    lastMs: lastMs > nowMs ? 0 : lastMs,
  };
}
function defaultModeration(): StoredModeration {
  return { banned: false, bannedUntilMs: 0, reason: '', revokedItems: [] };
}

type AnyRecord = Record<string, unknown>;

function asRecord(v: unknown): AnyRecord {
  return v !== null && typeof v === 'object' ? (v as AnyRecord) : {};
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * Version steps. Each takes the raw object at version N and returns it at
 * version N+1. Missing fields are filled, unknown fields are dropped by the
 * final normalise pass.
 */
const MIGRATIONS: Array<(raw: AnyRecord) => AnyRecord> = [
  // 1 -> 2: loadout and per-weapon kill counters arrived.
  (raw) => {
    raw.loadout = raw.loadout ?? defaultLoadout();
    const stats = asRecord(raw.stats);
    if (!Array.isArray(stats.weaponKills)) stats.weaponKills = new Array<number>(WEAPON_COUNT).fill(0);
    raw.stats = stats;
    raw.version = 2;
    return raw;
  },
  // 2 -> 3: entitlements became an object with a receipt instead of a bare flag.
  (raw) => {
    const ent = raw.entitlements;
    if (typeof ent === 'boolean' || ent === undefined || ent === null) {
      raw.entitlements = {
        adsRemoved: ent === true,
        product: ent === true ? IAP_PRODUCT_REMOVE_ADS : null,
        receipt: null,
        purchasedMs: ent === true ? Date.now() : 0,
      };
    }
    raw.version = 3;
    return raw;
  },
  // 3 -> 4: the economy section — Scrap and the per-day earn buckets.
  //
  // Reads whatever is already there rather than overwriting it, so the step is
  // idempotent. That matters because of the `_unknown` downgrade guard: a
  // profile that has been through a newer server and back arrives here with its
  // v4 fields already populated at the top level, and a step that assumed
  // "absent" would wipe them on the way forward.
  (raw) => {
    const ec = asRecord(raw.economy);
    raw.economy = {
      scrap: num(ec.scrap, 0),
      lifetimeScrap: num(ec.lifetimeScrap, 0),
      day: str(ec.day, ''),
      dayXp: num(ec.dayXp, 0),
      dayScrap: num(ec.dayScrap, 0),
      dayMatches: num(ec.dayMatches, 0),
    };
    raw.version = 4;
    return raw;
  },
  // 4 -> 5: inventory, moderation and the age band — the items pack's
  // ownership store and the C6 operator fields, in ONE bump on purpose
  // (docs/PLATFORM.md §12: a schema-touching release disables rollback, so
  // it happens once). Reads what is there rather than overwriting it, same
  // idempotency argument as 3 -> 4.
  (raw) => {
    raw.inventory = raw.inventory ?? { items: [], equippedSkin: '', title: '' };
    raw.moderation = raw.moderation ?? { banned: false, bannedUntilMs: 0, reason: '', revokedItems: [] };
    raw.ageBand = raw.ageBand ?? 'unknown';
    raw.version = 5;
    return raw;
  },
  // 5 -> 6: daily/weekly challenge state arrived (Studio S4). Reads what is
  // there rather than overwriting it, same idempotency argument as 3 -> 4.
  (raw) => {
    raw.challenges = raw.challenges ?? { day: '', week: '', counts: {}, done: [], owed: [] };
    raw.version = 6;
    return raw;
  },
];

/** Bring any stored shape up to the current version and sanity-check it. */
export function migrateProfile(input: unknown, deviceId: string, nowMs = Date.now()): StoredProfile {
  let raw = asRecord(input);
  let version = num(raw.version, 1);
  if (version < 1) version = 1;
  while (version < PERSIST_VERSION) {
    const step = MIGRATIONS[version - 1];
    if (!step) break;
    raw = step(raw);
    version = num(raw.version, version + 1);
  }

  const base = createProfile(deviceId, nowMs);
  const progress = asRecord(raw.progress);
  const settings = asRecord(raw.settings);
  const loadout = asRecord(raw.loadout);
  const ent = asRecord(raw.entitlements);
  const stats = asRecord(raw.stats);
  const eco = asRecord(raw.economy);
  const inv = asRecord(raw.inventory);
  const mod = asRecord(raw.moderation);
  const chal = asRecord(raw.challenges);

  const out: StoredProfile = {
    version: PERSIST_VERSION,
    deviceId,
    accountId: typeof raw.accountId === 'string' ? raw.accountId : null,
    accountSecret: typeof raw.accountSecret === 'string' ? raw.accountSecret : null,
    createdMs: num(raw.createdMs, nowMs),
    updatedMs: num(raw.updatedMs, nowMs),
    progress: {
      version: SAVE_VERSION,
      name: str(progress.name, base.progress.name).slice(0, MAX_NAME_LENGTH),
      skin: clampInt(num(progress.skin, 0), 0, 255),
      xp: Math.max(0, num(progress.xp, 0)),
      level: 1,
      kills: Math.max(0, num(progress.kills, 0)),
      deaths: Math.max(0, num(progress.deaths, 0)),
      wins: Math.max(0, num(progress.wins, 0)),
      gamesPlayed: Math.max(0, num(progress.gamesPlayed, 0)),
      bestKillstreak: Math.max(0, num(progress.bestKillstreak, 0)),
      blocksPlaced: Math.max(0, num(progress.blocksPlaced, 0)),
      blocksBroken: Math.max(0, num(progress.blocksBroken, 0)),
      secondsPlayed: Math.max(0, num(progress.secondsPlayed, 0)),
      favouriteWeapon: clampInt(num(progress.favouriteWeapon, 0), 0, WEAPON_COUNT - 1),
      lastSeed: num(progress.lastSeed, 0) >>> 0,
      adsRemoved: bool(progress.adsRemoved, false),
    },
    settings: mergeSettings(settings),
    bindings: sanitiseBindings(raw.bindings),
    loadout: {
      primary: clampInt(num(loadout.primary, WeaponId.PISTOL), 0, WEAPON_COUNT - 1),
      weapons: intArray(loadout.weapons, base.loadout.weapons, 0, WEAPON_COUNT - 1, WEAPON_COUNT),
      blocks: intArray(loadout.blocks, base.loadout.blocks, 0, 24, 9),
    },
    entitlements: {
      adsRemoved: bool(ent.adsRemoved, false),
      product: typeof ent.product === 'string' ? ent.product : null,
      receipt: typeof ent.receipt === 'string' ? ent.receipt : null,
      purchasedMs: num(ent.purchasedMs, 0),
    },
    stats: {
      matches: Math.max(0, num(stats.matches, 0)),
      wins: Math.max(0, num(stats.wins, 0)),
      kills: Math.max(0, num(stats.kills, 0)),
      deaths: Math.max(0, num(stats.deaths, 0)),
      bestStreak: Math.max(0, num(stats.bestStreak, 0)),
      damageDealt: Math.max(0, num(stats.damageDealt, 0)),
      blocksPlaced: Math.max(0, num(stats.blocksPlaced, 0)),
      blocksBroken: Math.max(0, num(stats.blocksBroken, 0)),
      secondsPlayed: Math.max(0, num(stats.secondsPlayed, 0)),
      favouriteWeapon: clampInt(num(stats.favouriteWeapon, 0), 0, WEAPON_COUNT - 1),
      weaponKills: intArray(stats.weaponKills, new Array<number>(WEAPON_COUNT).fill(0), 0, 1e9, WEAPON_COUNT),
      lastSeenMs: num(stats.lastSeenMs, 0),
      last: lastMatchOf(stats.last),
    },
    /* Read from `eco`, NOT from `base`. The migration step above is a no-op
     * without these six lines: it writes `raw.economy` and this literal is the
     * only thing that decides what survives into the profile the server then
     * saves back over the file. `sim.test.ts`'s "round-trips a version 4
     * balance" is the test that says so. */
    economy: {
      scrap: clampInt(num(eco.scrap, 0), 0, MAX_SCRAP_BALANCE),
      lifetimeScrap: clampInt(num(eco.lifetimeScrap, 0), 0, MAX_SCRAP_BALANCE),
      day: str(eco.day, '').slice(0, 10),
      dayXp: clampInt(num(eco.dayXp, 0), 0, DAY_XP_CAP),
      dayScrap: clampInt(num(eco.dayScrap, 0), 0, DAY_SCRAP_CAP),
      dayMatches: clampInt(num(eco.dayMatches, 0), 0, 10_000),
    },
    inventory: sanitiseInventory(inv),
    moderation: sanitiseModeration(mod),
    challenges: sanitiseChallenges(chal),
    adRewards: sanitiseAdRewards(raw.adRewards, Date.now()),
    ageBand: ageBandOf(raw.ageBand),
  };

  /* The downgrade guard. `out.version` has just been stamped DOWN to what this
   * build understands, which is correct for reading and destructive for
   * writing: the next flush would overwrite a newer profile with a strictly
   * smaller one. Anything unrecognised is set aside here and `serialiseProfile`
   * puts it back verbatim. See `StoredProfile._unknown`. */
  const carried = collectUnknownProfileKeys(raw, out as unknown as AnyRecord);
  if (carried !== null) out._unknown = carried;

  // Derived, never trusted from disk.
  out.progress.level = levelForXp(out.progress.xp);
  out.progress.adsRemoved = out.entitlements.adsRemoved || out.progress.adsRemoved;
  out.entitlements.adsRemoved = out.progress.adsRemoved;
  if (out.entitlements.adsRemoved) out.settings.showAds = false;
  return out;
}

/**
 * Bounds on stored challenge state — a hostile or buggy write stays a small
 * one. The cap KEEPS THE NEWEST entries, never the oldest: `counts` and
 * `done` are append-ordered, so a profile that accumulated ids from re-cut
 * packs holds the stale ones at the front — trimming from the front would
 * evict exactly the live pack's counters and, worse, its paid receipts.
 * A `done` receipt older than the journal's ~48 h window is the ONLY thing
 * standing between a re-cut and a double payout.
 */
const MAX_CHALLENGE_STATE_ENTRIES = 256;
const MAX_CHALLENGE_OWED = 32;
const MAX_CHALLENGE_ID_CHARS = 64;
const MAX_CHALLENGE_SOURCE_CHARS = 160;

function sanitiseChallenges(raw: AnyRecord): StoredChallenges {
  const counts: Record<string, number> = {};
  const rawCounts = Object.entries(asRecord(raw.counts))
    .filter(([k]) => !isPrototypePollutingKey(k) && k.length > 0 && k.length <= MAX_CHALLENGE_ID_CHARS)
    .slice(-MAX_CHALLENGE_STATE_ENTRIES);
  for (const [k, v] of rawCounts) {
    const n = num(v, 0);
    if (n > 0) counts[k] = Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER);
  }
  const done: string[] = [];
  if (Array.isArray(raw.done)) {
    for (const id of raw.done) {
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_CHALLENGE_ID_CHARS) continue;
      if (!done.includes(id)) done.push(id);
    }
  }
  const owed: ChallengeOwed[] = [];
  if (Array.isArray(raw.owed)) {
    for (const entry of raw.owed) {
      const o = asRecord(entry);
      const id = str(o.id, '').slice(0, MAX_CHALLENGE_ID_CHARS);
      const periodKey = str(o.periodKey, '').slice(0, 16);
      const sourceId = str(o.sourceId, '').slice(0, MAX_CHALLENGE_SOURCE_CHARS);
      if (id.length === 0 || periodKey.length === 0 || sourceId.length === 0) continue;
      if (owed.some((x) => x.sourceId === sourceId)) continue;
      owed.push({
        id, periodKey, sourceId,
        scrap: clampInt(num(o.scrap, 0), 0, MAX_SCRAP_BALANCE),
        item: typeof o.item === 'string' && o.item.length > 0 ? o.item.slice(0, MAX_CHALLENGE_ID_CHARS) : null,
      });
    }
  }
  return {
    day: str(raw.day, '').slice(0, 10),
    week: str(raw.week, '').slice(0, 8),
    counts,
    done: done.slice(-MAX_CHALLENGE_STATE_ENTRIES),
    owed: owed.slice(-MAX_CHALLENGE_OWED),
  };
}

/** Inventory hard cap. Further grants are refused, never silently rotated. */
export const MAX_OWNED_ITEMS = 500;
const MAX_REVOKED_ITEMS = 200;

function ownedItemOf(v: unknown): OwnedItem | null {
  const e = asRecord(v);
  const ref = typeof e.ref === 'string' ? e.ref : '';
  if (parseItemRef(ref) === null) return null;
  return {
    ref,
    ms: num(e.ms, 0),
    source: str(e.source, 'grant').slice(0, 16),
    sourceId: str(e.sourceId, '').slice(0, 128),
  };
}

function sanitiseInventory(inv: AnyRecord): StoredInventory {
  const items: OwnedItem[] = [];
  if (Array.isArray(inv.items)) {
    for (const v of inv.items) {
      if (items.length >= MAX_OWNED_ITEMS) break;
      const it = ownedItemOf(v);
      if (it !== null) items.push(it);
    }
  }
  const refOrEmpty = (v: unknown): string =>
    (typeof v === 'string' && parseItemRef(v) !== null ? v : '');
  return {
    items,
    equippedSkin: refOrEmpty(inv.equippedSkin),
    title: refOrEmpty(inv.title),
    variants: sanitiseVariantClaims(inv.variants),
  };
}

/**
 * The stored variant claims, read back off a disk this process does not own.
 *
 * Every key must be a canonical decimal weapon id in range and every value a
 * parseable item ref — a claim that survives sanitising is still not TRUSTED
 * (ownership, revocation and the room's own table are all re-checked at every
 * join, `server/src/variantClaims.ts`); this is only about the SHAPE not being
 * able to reach the rest of the server as something other than a string map.
 * `'01'` and `'1.0'` are refused rather than coerced, because two keys that
 * normalise to the same weapon would make "which claim wins" depend on object
 * key order.
 */
function sanitiseVariantClaims(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof v !== 'object' || v === null) return out;
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (isPrototypePollutingKey(key)) continue;
    const id = Number(key);
    if (!Number.isInteger(id) || id < 0 || id >= WEAPON_COUNT) continue;
    if (String(id) !== key) continue;
    if (typeof value !== 'string' || parseItemRef(value) === null) continue;
    out[key] = value;
  }
  return out;
}

function sanitiseModeration(mod: AnyRecord): StoredModeration {
  const revoked: { ref: string; ms: number; reason: string }[] = [];
  if (Array.isArray(mod.revokedItems)) {
    for (const v of mod.revokedItems) {
      if (revoked.length >= MAX_REVOKED_ITEMS) break;
      const e = asRecord(v);
      const ref = typeof e.ref === 'string' ? e.ref : '';
      if (parseItemRef(ref) === null) continue;
      revoked.push({ ref, ms: num(e.ms, 0), reason: str(e.reason, '').slice(0, 200) });
    }
  }
  return {
    banned: bool(mod.banned, false),
    bannedUntilMs: num(mod.bannedUntilMs, 0),
    reason: str(mod.reason, '').slice(0, 200),
    revokedItems: revoked,
  };
}

function ageBandOf(v: unknown): AgeBand {
  return v === 'u13' || v === '13-17' || v === '18plus' ? v : 'unknown';
}

function lastMatchOf(v: unknown): LastMatch | null {
  const e = asRecord(v);
  if (typeof e.ms !== 'number' || !Number.isFinite(e.ms) || e.ms <= 0) return null;
  return {
    ms: num(e.ms, 0),
    kills: Math.max(0, num(e.kills, 0)),
    deaths: Math.max(0, num(e.deaths, 0)),
    won: e.won === true,
    seconds: Math.max(0, num(e.seconds, 0)),
    bestStreak: Math.max(0, num(e.bestStreak, 0)),
    xp: Math.max(0, num(e.xp, 0)),
    scrap: Math.max(0, num(e.scrap, 0)),
  };
}

/**
 * The grant sources that MOVE an existing copy rather than creating one.
 *
 * This list is an ALLOW-list and the default is the strict side on purpose:
 * anything not named here is treated as a MINT, so a sixth call site added
 * next year inherits the refusal instead of the hole. `grantDrops` is the one
 * chokepoint every write of an owned item flows through, and getting the
 * default wrong is the difference between a bug and a silent economy.
 */
const TRANSFER_SOURCES: ReadonlySet<string> = new Set(['trade']);

/**
 * V4e — the grant sources allowed to MINT a weapon variant. Also an ALLOW-list,
 * and for the same reason: `docs/VARIANTS.md` §7.2 makes the craft bench the
 * ONLY acquisition route, so 'drop', 'challenge', 'prize' and anything written
 * next year still mint none. V4b closed every door here; this opens exactly
 * one, by name.
 */
const VARIANT_MINT_SOURCES: ReadonlySet<string> = new Set(['craft']);

/**
 * Why `grantDrops` would REFUSE this ref from this source, or null when it will
 * write it.
 *
 * `grantDrops`' own loop calls this, so a caller that asks BEFORE spending
 * (the craft route, which must not consume three copies and a fee for a token
 * the grant then drops) and the loop that actually decides cannot drift — §0
 * rule 29: two doors onto the same data agree by construction only when one of
 * them runs the other's list.
 *
 * CAPACITY is deliberately not here: `MAX_OWNED_ITEMS` depends on how many refs
 * the same call has already pushed, so it is the loop's business alone.
 */
export function grantRefusal(ref: string, source: string): string | null {
  if (parseItemRef(ref) === null) return `"${ref}" is not an item ref`;
  const minting = !TRANSFER_SOURCES.has(source);
  if (minting && refIsWeaponVariant(ref) && !VARIANT_MINT_SOURCES.has(source)) {
    return `a weapon variant cannot be minted by '${source}' — the craft bench is the only route`;
  }
  return null;
}

/**
 * Append match drops to the inventory, inside the SAME store.update callback
 * that moved the balance — the idempotency check that guards the payout
 * guards these too, so a replayed round grants nothing twice. Deliberately
 * NOT part of applyMatchResult: that function is the economy's single
 * writer, and an item is not a currency. Returns what actually landed (the
 * cap can refuse).
 *
 * V4b — WHY THE VARIANT RULE IS HERE AND WHY IT IS NOT A BLANKET REFUSAL.
 *
 * Every path that writes into `inventory.items` through a grant comes through
 * this function: match drops ('drop'), challenge settlement ('challenge'),
 * competition winner prizes ('prize'), craft output ('craft') and trade
 * settlement ('trade'). Four of those five MINT; the fifth MOVES a copy that
 * already exists. docs/VARIANTS.md §7.2 makes variants craft-only, and clause
 * 14 makes them deliberately TRADABLE — so the invariant to protect is
 * "variant SUPPLY cannot increase", NOT "no variant ref may be written".
 * Refusing every variant here would have looked like the tidy one-line fix and
 * would have broken trading, which is the thing the token is FOR in V4b.
 *
 * The kind is read off the REF, not off a manifest: `parseItemsManifest`
 * enforces `id === "weapon_variant-<variantId>"` as a biconditional, so the
 * prefix is exact for anything a gated pack could contain, and this function
 * needs no pack registry, no async lookup and no new argument that a call site
 * can forget to pass. The three upstream refusals (`rollMatchDrops`'s kind
 * skip, `CRAFTABLE_KINDS`, `quests.refs`) all stay: they refuse EARLIER and
 * with a better message. This is the backstop that makes them redundant rather
 * than load-bearing — three separate checks drift, one invariant does not.
 *
 * V4e — ONE DOOR OPENS. `docs/VARIANTS.md` §7.2 makes the craft bench the sole
 * acquisition route, and V4b's blanket mint refusal made that rule circular: a
 * variant craft needed three variants and there were none. `VARIANT_MINT_SOURCES`
 * names 'craft' and nothing else, so 'drop', 'challenge' and 'prize' still mint
 * zero, and — because it is an allow-list rather than a deny-list of the three
 * sources that exist today — a sixth call site added next year still inherits
 * the refusal.
 */
export function grantDrops(
  profile: StoredProfile,
  refs: readonly string[],
  source: string,
  sourceId: string,
  nowMs = Date.now(),
): OwnedItem[] {
  const landed: OwnedItem[] = [];
  for (const ref of refs) {
    if (profile.inventory.items.length >= MAX_OWNED_ITEMS) break;
    if (grantRefusal(ref, source) !== null) continue;
    const item: OwnedItem = { ref, ms: nowMs, source: source.slice(0, 16), sourceId: sourceId.slice(0, 128) };
    profile.inventory.items.push(item);
    landed.push(item);
  }
  return landed;
}

/* ------------------------------------------------------------------------ *
 * Daily/weekly challenges (Studio S4) — accrual, completion, payment
 *
 * All of it runs INSIDE the same `store.update` callback that settles the
 * match, so the counter, the receipt, the credit, the item and the journal
 * row commit or vanish together. `docs/ECONOMY.md` "Daily / weekly
 * challenges feeding Scrap and drops".
 * ------------------------------------------------------------------------ */

/** One completion owed and not yet paid — the settlement's work item. */
export interface ChallengeCandidate {
  id: string;
  /** The period key the sourceId was derived from — NEVER recomputed later. */
  periodKey: string;
  /** `challenge:<id>:<periodKey>` — the journal idempotency source. */
  sourceId: string;
  scrap: number;
  /** Items-manifest local id, or null. */
  item: string | null;
}

/**
 * Roll the period buckets, fold this match's contributions into the
 * counters, and return every completion that is owed and unpaid. PURE
 * PROGRESS — no money moves here; `settleChallenges` pays.
 *
 * Candidates are scanned over ALL defs, not just this match's granted ids:
 * a completion banked in a session that could not pay (public Builder
 * grants challenge progress but not Scrap) is owed until the first
 * settlement that can.
 */
export function accrueChallenges(
  profile: StoredProfile,
  defs: readonly ChallengeDef[],
  grantedIds: readonly string[],
  stats: ChallengeStatSource,
  nowMs: number,
): ChallengeCandidate[] {
  const ch = profile.challenges;
  const day = utcDayKey(nowMs);
  const week = utcWeekKey(nowMs);
  if (ch.day !== day) {
    ch.day = day;
    for (const k of Object.keys(ch.counts)) if (k.startsWith('daily.')) delete ch.counts[k];
    ch.done = ch.done.filter((id) => !id.startsWith('daily.'));
  }
  if (ch.week !== week) {
    ch.week = week;
    for (const k of Object.keys(ch.counts)) if (k.startsWith('weekly.')) delete ch.counts[k];
    ch.done = ch.done.filter((id) => !id.startsWith('weekly.'));
  }
  const granted = new Set(grantedIds);
  const out: ChallengeCandidate[] = [];
  for (const def of defs) {
    if (granted.has(def.id)) {
      const c = challengeContribution(def, stats);
      const prev = ch.counts[def.id] ?? 0;
      const next = challengeAggregation(def.stat) === 'max' ? Math.max(prev, c) : prev + c;
      // Clamped at target: the profile stores "how close", never a
      // runaway counter.
      ch.counts[def.id] = Math.min(next, def.target);
    }
    if ((ch.counts[def.id] ?? 0) >= def.target && !ch.done.includes(def.id)) {
      const periodKey = challengePeriodKey(def.period, nowMs);
      out.push({
        id: def.id,
        periodKey,
        sourceId: `challenge:${def.id}:${periodKey}`,
        scrap: def.scrap,
        item: def.item,
      });
    }
  }
  return out;
}

/**
 * The one Scrap credit for a challenge completion. Bypasses `meterReward`
 * deliberately — the bound is the PARSER's per-def and per-manifest caps,
 * the prize precedent — and reports the OBSERVED movement, captured
 * immediately around this one credit (never the asked amount: the
 * `MAX_SCRAP_BALANCE` clamp is allowed to bite and the row must say so).
 */
export function creditChallengeScrap(
  profile: StoredProfile, amount: number,
): { before: number; after: number } {
  const e = profile.economy;
  const before = e.scrap;
  const add = Math.max(0, Math.round(amount));
  e.scrap = Math.min(before + add, MAX_SCRAP_BALANCE);
  e.lifetimeScrap = Math.min(e.lifetimeScrap + (e.scrap - before), MAX_SCRAP_BALANCE);
  return { before, after: e.scrap };
}

export interface ChallengeSettlementDeps {
  defs: readonly ChallengeDef[];
  /** The guard-verified ids this match contributes to. */
  grantedIds: readonly string[];
  stats: ChallengeStatSource;
  /** ONE timestamp for the whole settlement — buckets, sourceIds, rows. */
  nowMs: number;
  deviceId: string;
  /** The session grants REWARD_SCRAP — without it, progress banks and payment waits. */
  mayPayScrap: boolean;
  /** The session grants REWARD_ITEM_DROP — an item-bearing completion defers without it. */
  mayGrantItems: boolean;
  /** The paying room's pinned items version — grant-time ref formatting, as drops do. */
  itemVersion: number;
  journal: {
    has(kind: 'prize', sourceId: string, playerId: string): Promise<boolean>;
    append(rows: LedgerEntry[]): Promise<number>;
  } | null;
  /** Row id maker (`newLedgerId`) — injected so this module never imports the journal. */
  rowId: (nowMs: number) => string;
}

/**
 * Accrue, then pay what is owed — the has-first discipline of the match
 * payout, per completion: the journal is asked BEFORE anything moves, and a
 * yes means a torn write already paid this period, so the receipt is
 * REPAIRED (done[] pushed) while no balance moves and no row is written.
 * Without the repair, a weekly completion whose profile write was lost
 * would pay a second time once the journal's ~48 h dedup window forgets
 * the key.
 */
/**
 * Pay a rewarded-ad grant, durably, inside the caller's per-device lock.
 *
 * Shaped like `settleChallenges`: the journal's idempotency check comes FIRST
 * so a replayed claim moves no balance, and the row is appended inside the same
 * critical section that moved it, so the journal can never disagree with the
 * balance it describes. `sourceId` is the reward id, which the server minted
 * and which is single-use by construction.
 *
 * Scrap, never XP: docs/SPONSORS.md §4.5 — "XP is 'how far have I come' and an
 * ad must not move it."
 */
export async function settleAdReward(
  profile: StoredProfile,
  deps: {
    rewardId: string;
    scrap: number;
    nowMs: number;
    today: string;
    countAfter: number;
    deviceId: string;
    journal: {
      has(kind: 'prize', sourceId: string, playerId: string): Promise<boolean>;
      append(rows: LedgerEntry[]): Promise<number>;
    } | null;
    rowId: (ms: number) => string;
  },
): Promise<number> {
  const sourceId = `adreward:${deps.rewardId}`;
  if (deps.journal !== null && await deps.journal.has('prize', sourceId, deps.deviceId)) return 0;

  const moved = creditChallengeScrap(profile, deps.scrap);
  const delta = moved.after - moved.before;

  /* The durable record moves whether or not the credit was clamped away by the
   * balance ceiling: the player HAD their grant for the day, and a full wallet
   * must not hand back an extra one tomorrow-shaped hole in the cap. */
  profile.adRewards = { day: deps.today, count: deps.countAfter, lastMs: deps.nowMs };

  if (deps.journal !== null && delta > 0) {
    await deps.journal.append([{
      id: deps.rowId(deps.nowMs), ms: deps.nowMs, kind: 'prize', sourceId,
      playerId: deps.deviceId, currency: 'scrap',
      delta, balanceAfter: moved.after,
      actor: 'system:adreward',
      reason: `rewarded ad grant ${deps.countAfter} of the day`,
    }]);
  }
  return delta;
}

export async function settleChallenges(
  profile: StoredProfile, deps: ChallengeSettlementDeps,
): Promise<{ id: string; scrap: number }[]> {
  const ch = profile.challenges;
  const candidates = accrueChallenges(profile, deps.defs, deps.grantedIds, deps.stats, deps.nowMs);

  /* Every completion becomes a DEBT before it becomes a payment. The owed
   * list is durable and period-stamped, so the roll that wipes `counts` at
   * UTC midnight cannot eat a completion earned at 23:50 in a session that
   * was not allowed to pay it. */
  for (const c of candidates) {
    if (ch.done.includes(c.id)) continue;
    if (ch.owed.some((o) => o.sourceId === c.sourceId)) continue;
    if (ch.owed.length >= MAX_CHALLENGE_OWED) break;
    ch.owed.push({ id: c.id, periodKey: c.periodKey, sourceId: c.sourceId, scrap: c.scrap, item: c.item });
  }
  if (!deps.mayPayScrap) return [];

  const paid: { id: string; scrap: number }[] = [];
  const keep: ChallengeOwed[] = [];
  for (const o of ch.owed) {
    /* A receipt belongs to the period the completion was EARNED in. Paying
     * a debt carried across a boundary must not mark THIS period's copy of
     * the same challenge done — the journal key is what stops the double
     * pay, and dropping the entry from `owed` is the durable half. */
    const current = o.periodKey === ch.day || o.periodKey === ch.week;
    if (deps.journal !== null && await deps.journal.has('prize', o.sourceId, deps.deviceId)) {
      if (current && !ch.done.includes(o.id)) ch.done.push(o.id);
      continue;
    }
    if (o.item !== null && !deps.mayGrantItems) { keep.push(o); continue; }
    /* BOTH halves or neither, for real: grantDrops REFUSES at the inventory
     * cap and returns what actually landed. A receipt written while the item
     * silently dropped would lose it forever, so an item that cannot land
     * keeps the whole completion owed — it pays when space frees.
     *
     * V4b note: grantDrops also refuses to MINT a weapon variant, and that
     * refusal is permanent rather than "when space frees" — such a completion
     * would stay owed forever and its Scrap would never pay. That is the SAFE
     * failure (nothing is minted, and the operator sees an unpaid challenge)
     * and it is unreachable: `quests.refs` refuses a manifest whose challenge
     * pays a weapon_variant, in the release gate AND in the studio's CHECK
     * button, so no gated pack can create such an `owed` row. If V4e ever
     * makes a variant a legitimate challenge reward, this branch is the thing
     * that has to change with it. */
    if (o.item !== null) {
      const landed = grantDrops(
        profile, [formatItemRef(deps.itemVersion, o.item)], 'challenge', o.sourceId, deps.nowMs,
      );
      if (landed.length === 0) { keep.push(o); continue; }
    }
    const moved = creditChallengeScrap(profile, o.scrap);
    if (current) ch.done.push(o.id);
    if (deps.journal !== null) {
      await deps.journal.append([{
        id: deps.rowId(deps.nowMs), ms: deps.nowMs, kind: 'prize', sourceId: o.sourceId,
        playerId: deps.deviceId, currency: 'scrap',
        delta: moved.after - moved.before, balanceAfter: moved.after,
        actor: 'system:challenge',
        reason: `challenge ${o.id} (${o.periodKey})`,
      }]);
    }
    paid.push({ id: o.id, scrap: moved.after - moved.before });
  }
  ch.owed = keep;
  return paid;
}

/* ------------------------------------------------------------------------ *
 * Equipping — the claim, not the wear
 *
 * `inventory.equippedSkin` and `inventory.title` are CLAIMS: the renderer (and
 * anything else that shows an item) derives the item's state through
 * `itemStateFor` at read time and wears nothing that is not ACTIVE. So a
 * dormant item may stay equipped — if its pack returns, it lights back up with
 * no write — but a claim is still validated at the door: the caller must OWN
 * the copy, it must not be revoked, and its KIND must fit the slot, or the
 * player equips a title as a skin and the renderer silently shows nothing
 * forever, which reads as a lost item.
 * ------------------------------------------------------------------------ */

/**
 * A weapon-variant slot, addressed by the BASE WEAPON it is for and never by a
 * table row: `variant:1` is "what the shotgun fires with". Which row of which
 * table that becomes is a per-room question (docs/VARIANTS.md §3), and the
 * profile has no business holding an answer to it.
 */
export type VariantEquipSlot = `variant:${number}`;

export type EquipSlot = 'skin' | 'title' | VariantEquipSlot;

/** The base weapon id a `variant:<id>` slot names, or null if it is not one. */
export function variantSlotWeaponId(slot: string): number | null {
  if (!slot.startsWith('variant:')) return null;
  const rest = slot.slice('variant:'.length);
  const id = Number(rest);
  if (!Number.isInteger(id) || id < 0 || id >= WEAPON_COUNT) return null;
  // Canonical spelling only: `variant:01` and `variant:1.0` would be a second
  // name for one slot, and `applyEquip` keys the stored map by this number.
  return String(id) === rest ? id : null;
}

function kindForSlot(slot: EquipSlot): ItemKind {
  if (slot === 'skin') return ItemKind.SKIN;
  if (slot === 'title') return ItemKind.TITLE;
  return ItemKind.WEAPON_VARIANT;
}

export type EquipVerdict = { ok: true } | { ok: false; error: string };

/**
 * Validate one slot assignment against a profile WITHOUT writing anything.
 * `kindOf` resolves an owned ref to its kind — from the live items pack or the
 * pack version that granted it — and null means no installed pack knows the id,
 * in which case the claim is refused rather than guessed.
 *
 * `variantBaseOf` is the SECOND resolver, and it exists because a kind is not
 * enough for a variant slot. `variant:0` is the pistol and `variant:1` is the
 * shotgun; a kind-only check accepts a shotgun token for the pistol slot,
 * answers the player 200, and then the arsenal resolves the pistol row and
 * serves base pistol damage — a claim accepted at the door and silently
 * ignored by the body, which is the worst failure this repo ranks (HANDOVER
 * §0 rule 30). It follows `ref -> ItemDef.variantId -> VariantDef.base` and
 * returns null when no installed variants pack names that row; the resolver is
 * passed in, exactly as `kindOf` is, so this module still imports no pack
 * registry and no variants module.
 */
export function equipVerdict(
  profile: StoredProfile,
  slot: EquipSlot,
  ref: string,
  kindOf: (ref: string) => ItemKind | null,
  variantBaseOf: (ref: string) => number | null = () => null,
): EquipVerdict {
  /* AN UNRECOGNISED SLOT IS REFUSED BEFORE ANYTHING ELSE, including the
   * always-allowed unequip. `EquipSlot`'s template-literal arm is
   * `variant:${number}`, which the TYPE admits as `variant:1.5` and
   * `variant:-1` — and for those `variantSlotWeaponId` answers null, so the
   * base check below would be SKIPPED and `applyEquip` would then write
   * nothing. That is a 200 for a claim that was never stored: told yes, given
   * nothing, no error anywhere. The route only ever builds canonical slots;
   * this is what makes that a property of the function rather than of its one
   * caller. */
  if (slot !== 'skin' && slot !== 'title' && variantSlotWeaponId(slot) === null) {
    return { ok: false, error: `unknown equip slot "${slot}"` };
  }
  if (ref === '') return { ok: true }; // unequip is always allowed
  if (parseItemRef(ref) === null) return { ok: false, error: 'not an item ref' };
  if (!profile.inventory.items.some((i) => i.ref === ref)) {
    return { ok: false, error: 'you do not own this item' };
  }
  if (profile.moderation.revokedItems.some((r) => r.ref === ref)) {
    return { ok: false, error: 'this item was revoked' };
  }
  const kind = kindOf(ref);
  if (kind === null) return { ok: false, error: 'no installed pack defines this item' };
  if (kind !== kindForSlot(slot)) {
    return { ok: false, error: `a ${ITEM_KIND_NAMES[kind] ?? 'item'} cannot be equipped as a ${slot}` };
  }
  const weaponId = variantSlotWeaponId(slot);
  if (weaponId !== null) {
    const base = variantBaseOf(ref);
    if (base === null) {
      return { ok: false, error: 'no installed variants pack defines this variant' };
    }
    if (base !== weaponId) {
      return { ok: false, error: `that variant is for weapon ${base}, not weapon ${weaponId}` };
    }
  }
  return { ok: true };
}

/** Write the claims. Call ONLY after every slot passed `equipVerdict`. */
export function applyEquip(profile: StoredProfile, wants: ReadonlyMap<EquipSlot, string>): void {
  const skin = wants.get('skin');
  if (skin !== undefined) profile.inventory.equippedSkin = skin;
  const title = wants.get('title');
  if (title !== undefined) profile.inventory.title = title;
  for (const [slot, ref] of wants) {
    const weaponId = variantSlotWeaponId(slot);
    if (weaponId === null) continue;
    // '' is the unequip, and it DELETES rather than storing an empty string:
    // `variantClaims` iterates the map, and an empty value would be a claim
    // shaped row that resolves to nothing on every join forever.
    if (ref === '') delete profile.inventory.variants[String(weaponId)];
    else profile.inventory.variants[String(weaponId)] = ref;
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  const i = Math.round(v);
  return i < lo ? lo : i > hi ? hi : i;
}

function intArray(v: unknown, fallback: number[], lo: number, hi: number, length: number): number[] {
  if (!Array.isArray(v)) return fallback.slice();
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    const raw = v[i];
    out.push(typeof raw === 'number' && Number.isFinite(raw) ? clampInt(raw, lo, hi) : (fallback[i] ?? lo));
  }
  return out;
}

function mergeSettings(raw: AnyRecord): GameSettings {
  const out = { ...DEFAULT_SETTINGS } as GameSettings;
  const keys = Object.keys(DEFAULT_SETTINGS) as Array<keyof GameSettings>;
  for (const k of keys) {
    const v = raw[k as string];
    const def = DEFAULT_SETTINGS[k];
    if (typeof def === 'number' && typeof v === 'number' && Number.isFinite(v)) {
      (out[k] as number) = v;
    } else if (typeof def === 'boolean' && typeof v === 'boolean') {
      (out[k] as boolean) = v;
    } else if (typeof def === 'string' && typeof v === 'string') {
      (out[k] as string) = v;
    }
  }
  out.version = SAVE_VERSION;
  return out;
}

/**
 * Top-level keys this build has no idea about, or null when there are none.
 *
 * The accumulator has a NULL PROTOTYPE and `__proto__`, `constructor` and
 * `prototype` are dropped by name. `(out ??= {})[k] = v` over keys read out of
 * a JSON file is the same primitive that walked through `guardProfileWrite`
 * (see the long note there): a stored profile containing `"__proto__": {...}`
 * would have replaced this bag's prototype instead of adding a key to it.
 *
 * It is not exploitable today — nothing reads a field off the bag, it is only
 * spread back out by `serialiseProfile` — but it silently corrupts it: the
 * polluted key vanishes from `Object.keys`, so it is NOT written back on the
 * next flush and `migrate(migrate(x)) !== migrate(x)`. That is the downgrade
 * guard failing at exactly the job it exists for, quietly.
 */
function collectUnknownProfileKeys(raw: AnyRecord, known: AnyRecord): Record<string, unknown> | null {
  let out: Record<string, unknown> | null = null;
  const put = (k: string, v: unknown): void => {
    (out ??= Object.create(null) as Record<string, unknown>)[k] = v;
  };
  // An older reader may already have set a bag aside; merge it in first so a
  // field survives being opened by two different old builds in a row.
  const prior = raw._unknown;
  if (isPlainObject(prior)) {
    for (const [k, v] of Object.entries(prior)) {
      if (isPrototypePollutingKey(k)) continue;
      if (k === NESTED_BAG_KEY) continue;
      if (KNOWN_PROFILE_KEYS.includes(k)) continue;
      put(k, v);
    }
  }
  for (const [k, v] of Object.entries(raw)) {
    if (isPrototypePollutingKey(k)) continue;
    if (k === NESTED_BAG_KEY) continue;
    if (KNOWN_PROFILE_KEYS.includes(k)) continue;
    if (v === undefined) continue;
    put(k, v);
  }
  const nested = collectNestedUnknownKeys(raw, known);
  if (nested !== null) put(NESTED_BAG_KEY, nested);
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The `_nested` bag an older reader left behind, wherever it left it. */
function priorNestedBag(raw: AnyRecord): Record<string, unknown> {
  const inBag = isPlainObject(raw._unknown) ? raw._unknown[NESTED_BAG_KEY] : undefined;
  if (isPlainObject(inBag)) return inBag;
  // A build with only the top-level guard spreads the bag back out, so the key
  // arrives at the TOP level on the next read. Same data, one level up.
  const atTop = raw[NESTED_BAG_KEY];
  return isPlainObject(atTop) ? atTop : {};
}

/**
 * Sub-keys of a guarded section that this build does not own — one bag per
 * section, or null when every section is fully understood (the normal case, and
 * the one that must not add a byte to the file).
 *
 * `known` is the profile this build just rebuilt, so `known[section]` is exactly
 * the whitelist literal in `migrateProfile`. Comparing against it rather than
 * against a hand-maintained list is the whole reason this cannot rot: a field
 * added to `StoredEconomy` stops being "unknown" the moment the literal gains
 * it, with no second edit.
 *
 * Note the limit, stated rather than discovered later: this preserves fields
 * from a NEWER profile. A MIGRATION step that rewrites a section wholesale (the
 * v3 -> v4 economy step does) still drops sub-keys it does not name, because it
 * runs before this and rewrites `raw`. That direction is a forward migration
 * the author is looking at, not a silent rollback.
 */
function collectNestedUnknownKeys(raw: AnyRecord, known: AnyRecord): Record<string, unknown> | null {
  let out: Record<string, unknown> | null = null;
  const carried = priorNestedBag(raw);
  for (const section of GUARDED_PROFILE_SECTIONS) {
    const live = known[section];
    if (!isPlainObject(live)) continue;
    let bag: Record<string, unknown> | null = null;
    const take = (src: unknown): void => {
      if (!isPlainObject(src)) return;
      for (const [k, v] of Object.entries(src)) {
        if (isPrototypePollutingKey(k)) continue;
        if (Object.prototype.hasOwnProperty.call(live, k)) continue;
        if (v === undefined) continue;
        (bag ??= Object.create(null) as Record<string, unknown>)[k] = v;
      }
    };
    take(carried[section]);
    take(raw[section]);
    if (bag !== null) (out ??= Object.create(null) as Record<string, unknown>)[section] = bag;
  }
  return out;
}

/**
 * The profile as it goes to disk: this build's fields, plus every unknown key
 * put back at the top level exactly where it was found.
 *
 * The bag is spread FIRST so a known field always wins — an older build must
 * never be able to resurrect a stale copy of a field it does own, and the bag
 * is by definition made of fields it does not.
 */
export function serialiseProfile(p: StoredProfile): Record<string, unknown> {
  const { _unknown, ...known } = p;
  if (_unknown === undefined) return known as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ..._unknown, ...(known as unknown as Record<string, unknown>) };
  /* And the same rule one level down, for the sections in
   * `GUARDED_PROFILE_SECTIONS`: the newer build's fields go back first, this
   * build's own fields are written over them. `_unknown[NESTED_BAG_KEY]` itself
   * was already spread out as the top-level `_nested` key by the line above,
   * which is where the next reader will find it. */
  const nested = _unknown[NESTED_BAG_KEY];
  if (!isPlainObject(nested)) return out;
  for (const section of GUARDED_PROFILE_SECTIONS) {
    const bag = nested[section];
    const live = out[section];
    if (!isPlainObject(bag) || !isPlainObject(live)) continue;
    out[section] = { ...bag, ...live };
  }
  return out;
}

function sanitiseBindings(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const rec = asRecord(raw);
  let n = 0;
  for (const k of Object.keys(rec)) {
    if (n++ > 64) break;
    // Same primitive as the bag above. A string value makes the `__proto__`
    // setter a silent no-op rather than a takeover, so this one was never
    // exploitable — it is skipped by name anyway, because "harmless today
    // because of the value type" is not a property anybody will re-derive.
    if (isPrototypePollutingKey(k)) continue;
    const v = rec[k];
    if (typeof v === 'string' && v.length <= 24 && k.length <= 24) out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Anti-farm, part two: what a day may be worth
 *
 * These run inside `applyMatchResult`, which is the only code in the server
 * that both holds the profile and runs under `store.update`'s per-device lock.
 * Anywhere else — in the room, in the guard — two rooms paying the same device
 * at the same moment would read the same bucket and both write it.
 * ------------------------------------------------------------------------ */

/**
 * Diminishing returns, by matches already paid for today.
 *
 * The index is the count BEFORE this match, so the first five rounds of a day
 * are worth full price and the eleventh is worth a quarter. The floor is 0.15
 * and never 0: a player who has been at it all day should still see the number
 * move, because a reward that silently becomes zero reads as a broken game
 * rather than as a limit.
 */
export const DR_LADDER: readonly number[] = Object.freeze([
  1, 1, 1, 1, 1, 0.8, 0.8, 0.6, 0.6, 0.4, 0.25, 0.15,
]);

/**
 * The day the earn buckets belong to, as UTC 'YYYY-MM-DD'.
 *
 * UTC, stated out loud: a local-timezone day is a second clock the server does
 * not control, and a player who can choose their own timezone can choose their
 * own midnight. One boundary, the same one for everybody.
 */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Start a new day's buckets if this match is the first one after midnight. */
export function rollDayBucket(e: StoredEconomy, nowMs: number): void {
  const day = utcDay(nowMs);
  if (e.day === day) return;
  e.day = day;
  e.dayXp = 0;
  e.dayScrap = 0;
  e.dayMatches = 0;
}

/**
 * Meter one match's reward through today's bucket, and record what it used.
 *
 * Returns what may actually be banked. Both amounts are floored at 0 and capped
 * by whatever is left of the day, so the caller can add the result to a balance
 * without checking anything.
 *
 * A match worth nothing before metering — too short, idle, or a mode the trust
 * table pays no currency for — does not advance the ladder. Otherwise browsing
 * three dead rooms would cost a player the front of their day for free, which
 * is a rule that only ever punishes the honest.
 */
export function meterReward(
  e: StoredEconomy, xp: number, scrap: number, nowMs: number,
): { xp: number; scrap: number } {
  rollDayBucket(e, nowMs);
  const wantXp = Math.max(0, num(xp, 0));
  const wantScrap = Math.max(0, num(scrap, 0));
  if (wantXp <= 0 && wantScrap <= 0) return { xp: 0, scrap: 0 };

  const f = DR_LADDER[Math.min(e.dayMatches, DR_LADDER.length - 1)] ?? 1;
  const gx = Math.min(Math.round(wantXp * f), Math.max(0, DAY_XP_CAP - e.dayXp));
  const gs = Math.min(Math.round(wantScrap * f), Math.max(0, DAY_SCRAP_CAP - e.dayScrap));
  e.dayXp += gx;
  e.dayScrap += gs;
  e.dayMatches += 1;
  return { xp: gx, scrap: gs };
}

/**
 * Fold one match's results into a profile, and say what actually landed.
 *
 * The single writer of `progress.xp` and of `economy.scrap`, and it runs inside
 * `store.update`'s per-device lock — which is why the per-day metering belongs
 * here rather than in the room: two rooms paying the same device at once are
 * serialised here and nowhere else.
 */
export function applyMatchResult(profile: StoredProfile, r: MatchResult, nowMs = Date.now()): AppliedRewards {
  const p = profile.progress;
  const s = profile.stats;
  const e = profile.economy;
  // `Math.max(0, NaN)` is NaN, and a NaN balance serialises to `null` and never
  // comes back. Both amounts are money; coerce before, not after.
  // Per-day caps and diminishing returns, applied here because here is where
  // the lock is. `meterReward` also coerces: `Math.max(0, NaN)` is NaN, a NaN
  // balance serialises to `null`, and `null` never comes back as a number.
  const metered = meterReward(e, num(r.xp, 0), num(r.scrap, 0), nowMs);
  const grantedXp = Math.max(0, Math.round(metered.xp));
  const grantedScrap = Math.max(0, Math.round(metered.scrap));
  p.kills += r.kills;
  p.deaths += r.deaths;
  p.gamesPlayed += 1;
  if (r.won) p.wins += 1;
  if (r.bestStreak > p.bestKillstreak) p.bestKillstreak = r.bestStreak;
  p.blocksPlaced += r.blocksPlaced;
  p.blocksBroken += r.blocksBroken;
  p.secondsPlayed += r.seconds;
  p.xp += grantedXp;
  p.level = levelForXp(p.xp);
  p.favouriteWeapon = r.favouriteWeapon;

  e.scrap = Math.min(e.scrap + grantedScrap, MAX_SCRAP_BALANCE);
  e.lifetimeScrap = Math.min(e.lifetimeScrap + grantedScrap, MAX_SCRAP_BALANCE);

  s.matches += 1;
  if (r.won) s.wins += 1;
  s.kills += r.kills;
  s.deaths += r.deaths;
  if (r.bestStreak > s.bestStreak) s.bestStreak = r.bestStreak;
  s.damageDealt += Math.round(r.damageDealt);
  s.blocksPlaced += r.blocksPlaced;
  s.blocksBroken += r.blocksBroken;
  s.secondsPlayed += r.seconds;
  if (r.favouriteWeapon >= 0 && r.favouriteWeapon < s.weaponKills.length) {
    s.weaponKills[r.favouriteWeapon] += r.kills;
    let best = 0;
    for (let i = 1; i < s.weaponKills.length; i++) if (s.weaponKills[i] > s.weaponKills[best]) best = i;
    s.favouriteWeapon = best;
  }
  s.lastSeenMs = nowMs;
  // The share card's whole data source: what THIS round was, with the
  // amounts that actually landed — never the amounts the room asked for.
  s.last = {
    ms: nowMs, kills: r.kills, deaths: r.deaths, won: r.won,
    seconds: r.seconds, bestStreak: r.bestStreak,
    xp: grantedXp, scrap: grantedScrap,
  };
  profile.updatedMs = nowMs;
  return { profile, xp: grantedXp, scrap: grantedScrap };
}

/* ------------------------------------------------------------------------ *
 * In-memory store — tests and the local single-player worker
 * ------------------------------------------------------------------------ */

export class MemoryStore implements PersistenceStore {
  private readonly byDevice = new Map<string, StoredProfile>();
  private readonly byAccount = new Map<string, string>();
  private readonly locks = new Map<string, Promise<unknown>>();

  async load(deviceId: string): Promise<StoredProfile | null> {
    return this.byDevice.get(deviceId) ?? null;
  }

  peek(deviceId: string): StoredProfile | null {
    return this.byDevice.get(deviceId) ?? null;
  }

  async ensure(deviceId: string): Promise<StoredProfile> {
    let p = this.byDevice.get(deviceId);
    if (!p) {
      p = createProfile(deviceId);
      this.byDevice.set(deviceId, p);
    }
    return p;
  }

  async save(profile: StoredProfile): Promise<void> {
    profile.updatedMs = Date.now();
    this.byDevice.set(profile.deviceId, profile);
    if (profile.accountId) this.byAccount.set(profile.accountId, profile.deviceId);
  }

  update(deviceId: string, mutate: (p: StoredProfile) => void | Promise<void>): Promise<StoredProfile> {
    return this.withLock(deviceId, async () => {
      const p = await this.ensure(deviceId);
      await mutate(p);
      await this.save(p);
      return p;
    });
  }

  grantEntitlement(deviceId: string, product: string, receipt: string | null): Promise<StoredProfile> {
    return this.update(deviceId, (p) => grantInto(p, product, receipt));
  }

  linkAccount(deviceId: string, accountId: string): Promise<{ profile: StoredProfile; secret: string }> {
    return this.withLock(deviceId, async () => {
      const p = await this.ensure(deviceId);
      const secret = randomToken();
      p.accountId = accountId;
      p.accountSecret = secret;
      await this.save(p);
      this.byAccount.set(accountId, deviceId);
      return { profile: p, secret };
    });
  }

  async resolveAccount(accountId: string, secret: string): Promise<StoredProfile | null> {
    const deviceId = this.byAccount.get(accountId);
    if (!deviceId) return null;
    const p = this.byDevice.get(deviceId);
    if (!p || !p.accountSecret || !constantTimeEquals(p.accountSecret, secret)) return null;
    return p;
  }

  async flush(): Promise<void> { /* nothing to flush */ }
  async close(): Promise<void> { this.byDevice.clear(); this.byAccount.clear(); }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }
}

/* ------------------------------------------------------------------------ *
 * JSON file store
 * ------------------------------------------------------------------------ */

/**
 * The slice of `node:fs/promises` this store uses. Exported so a test can
 * substitute one whose `readFile` resolves when the test says so — the only
 * way to write a *deterministic* test about which of two concurrent readers
 * caches last, which is the bug in `load()` below.
 */
/**
 * ENOENT and nothing else. The distinction this function exists to make is the
 * whole of `docs/BUGS-FOUND.md`'s blank-profile class: "absent" is a new player,
 * "unreadable" is a player whose file we must not touch. Errno, not message —
 * a fake that throws `new Error('ENOENT')` is NOT what node throws (rule 6:
 * simulated-failure tests must pick platform-identical failure inputs).
 */
export function isMissingFile(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export interface FsLike {
  mkdir(path: string, opts: { recursive: boolean }): Promise<unknown>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
}

/**
 * One JSON file per device under `<root>/profiles/<shard>/<deviceId>.json`,
 * written atomically through a temp file. Writes are debounced so a busy match
 * does not hammer the disk; `flush()` forces everything out (shutdown calls it).
 */
export class JsonFileStore implements PersistenceStore {
  private readonly root: string;
  private readonly cache = new Map<string, StoredProfile>();
  private readonly dirty = new Set<string>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly accountIndex = new Map<string, string>();
  private fs: FsLike | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushDelayMs: number;
  private closed = false;
  /** Set when the disk is unusable; the store degrades to memory only. */
  degraded = false;
  /**
   * Devices whose file is PRESENT BUT UNREADABLE — a non-ENOENT read error, or
   * bytes that would not parse. `accounts.ts:378` already argues this policy for
   * the accounts file; this is the same argument one layer down, and it is the
   * one that was missing. Such a device gets a working in-memory profile so the
   * match it is in does not fall over, but it is NEVER written back, because the
   * only thing we could write is a blank that would destroy the real file
   * atomically and unrecoverably. The evidence survives for an operator.
   */
  private readonly unreadable = new Set<string>();
  /**
   * The in-flight `flush()`, so a second caller — the shutdown barrier, above
   * all — AWAITS the writes already in the air instead of seeing an emptied
   * dirty set and concluding there is nothing to do.
   */
  private flushing: Promise<void> | null = null;
  /** Writes that arrived after `close()`. Non-zero means settlements were lost. */
  postCloseWrites = 0;
  /** Profiles whose last write failed and have not since been written. */
  get unflushed(): number { return this.dirty.size; }

  constructor(root: string, flushDelayMs = 800) {
    this.root = root.replace(/\/+$/, '');
    this.flushDelayMs = flushDelayMs;
  }

  private async ready(): Promise<FsLike> {
    if (this.fs) return this.fs;
    // Built at runtime so a bundler cannot follow it into a browser build.
    const spec = 'node:fs' + '/promises';
    const mod = (await import(/* @vite-ignore */ spec)) as unknown as FsLike;
    this.fs = mod;
    await mod.mkdir(`${this.root}/profiles`, { recursive: true });
    await this.loadAccountIndex(mod);
    return mod;
  }

  private shardPath(deviceId: string): string {
    const shard = deviceId.slice(0, 2).toLowerCase();
    return `${this.root}/profiles/${shard}`;
  }

  private filePath(deviceId: string): string {
    return `${this.shardPath(deviceId)}/${deviceId}.json`;
  }

  private async loadAccountIndex(fs: FsLike): Promise<void> {
    try {
      const text = await fs.readFile(`${this.root}/accounts.json`, 'utf8');
      const parsed = JSON.parse(text) as Record<string, string>;
      for (const k of Object.keys(parsed)) {
        if (typeof parsed[k] === 'string') this.accountIndex.set(k, parsed[k]);
      }
    } catch {
      // No index yet: that is the normal first-run state.
    }
  }

  private async writeAccountIndex(fs: FsLike): Promise<void> {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.accountIndex) obj[k] = v;
    const tmp = `${this.root}/accounts.json.tmp`;
    await fs.writeFile(tmp, JSON.stringify(obj), 'utf8');
    await fs.rename(tmp, `${this.root}/accounts.json`);
  }

  /**
   * Read a profile, or null. **A CACHE WRITER, and therefore locked.**
   *
   * THE HALF-FIX THIS CLOSES. The per-device lock was put on `ensure()`, and
   * `docs/BUGS-FOUND.md` §5 was marked FIXED — but `ensure` and `ensureLocked`
   * both delegate to *this*, and this is the function that does
   * `cache.set(deviceId, profile)` after two `await`s. Every other caller was
   * still unlocked: `resolveAccount` called it directly, and after `GET
   * /api/profile` stopped creating, so does the busiest read path in the
   * server.
   *
   * The surviving race, deterministic rather than lucky:
   *
   * ```
   * payout: update() -> LOCK -> ensureLocked -> load -> readFile -> mutate -> save -> cache.set
   * reader: load()               (no lock)          -> readFile ............... -> cache.set
   *                                                    ^ resolves LAST, and caches
   *                                                      the pre-match profile over the paid one
   * ```
   *
   * The reader's copy is the one `markDirty` has already named, so `flush()`
   * writes the loss to disk 800 ms later; `reviewSubmission` has already
   * stamped `record.settled`, so the match cannot be replayed. Same silent,
   * permanent loss as §5, one layer down.
   *
   * A cache HIT still skips the lock: it hands back the very object `update`
   * mutates, so there is nothing to serialise and the common path stays free.
   */
  async load(deviceId: string): Promise<StoredProfile | null> {
    const cached = this.cache.get(deviceId);
    if (cached) return cached;
    return this.withLock(deviceId, () => this.loadLocked(deviceId));
  }

  /**
   * The cache and nothing else — the same live object `update` mutates, so a
   * claim read through it is never staler than the last settlement.
   */
  peek(deviceId: string): StoredProfile | null {
    return this.cache.get(deviceId) ?? null;
  }

  /**
   * The body of `load`, for callers that ALREADY hold the device's lock.
   * `withLock` is not reentrant, so `ensureLocked` must use this one.
   */
  private async loadLocked(deviceId: string): Promise<StoredProfile | null> {
    // Re-check: whoever held the lock before us may have filled it.
    const cached = this.cache.get(deviceId);
    if (cached) return cached;
    let fs: FsLike;
    try {
      fs = await this.ready();
    } catch {
      this.degraded = true;
      return null;
    }
    let text: string;
    try {
      text = await fs.readFile(this.filePath(deviceId), 'utf8');
    } catch (err) {
      // ONLY a missing file is "new player". Any other errno — EACCES from a
      // volume that came back with different ownership (this project has had
      // exactly that, for six days, silently), EIO on a bad block, EMFILE under
      // match-end load — means the profile EXISTS and we could not read it.
      // Returning null there tells `ensureLocked` to mint a blank, and the blank
      // is then renamed over the real file. Quarantine instead.
      if (!isMissingFile(err)) this.quarantine(deviceId, err);
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      // A file that parses to a non-object is corruption residue, not a profile.
      // `migrateProfile` would silently merge it over the defaults and return a
      // fully blank profile that LOOKS like a successful read — the worst shape
      // of this bug, because it does not even take the catch below.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.quarantine(deviceId, new Error('profile JSON is not an object'));
        return null;
      }
      const profile = migrateProfile(parsed, deviceId);
      // And AGAIN, after the awaits. Belt and braces: `save()` is a public
      // method that writes the cache without taking the lock, so a caller who
      // uses it directly would otherwise re-open the window this closes. A
      // live entry always wins over a copy read from disk.
      const live = this.cache.get(deviceId);
      if (live) return live;
      this.cache.set(deviceId, profile);
      if (profile.accountId) this.accountIndex.set(profile.accountId, deviceId);
      return profile;
    } catch (err) {
      // Truncated or corrupt bytes. Same argument as above: present, unreadable.
      this.quarantine(deviceId, err);
      return null;
    }
  }

  /**
   * Mark a device present-but-unreadable: degrade loudly, and bar it from every
   * future write for the life of the process. `flush()` skips it, so the file on
   * disk — the only copy of that player's progress — is preserved for recovery
   * rather than overwritten with the defaults we were about to invent.
   */
  private quarantine(deviceId: string, err: unknown): void {
    this.degraded = true;
    if (this.unreadable.has(deviceId)) return;
    this.unreadable.add(deviceId);
    this.dirty.delete(deviceId);
    const code = (err as NodeJS.ErrnoException)?.code ?? '';
    process.stderr.write(
      `persistence: profile ${deviceId} is present but UNREADABLE (${code || (err as Error)?.message}); ` +
      `it will not be written this process, so the file on disk survives for recovery\n`,
    );
  }

  /** Devices barred from writing because their file could not be read. */
  quarantined(): string[] { return Array.from(this.unreadable); }

  /**
   * Load or create — under the per-device lock.
   *
   * THE BUG THIS CLOSES. A cache miss means a disk read, and a disk read means
   * two `await`s: long enough for a match payout to run `update`, create the
   * same profile, fold the result into it and cache it. The reader, still
   * holding its own `createProfile()` from before all that, then cached the
   * blank one on top and the match was gone. `applyMatchResult` had already
   * run, the entitlement guard had already marked the device settled, and the
   * player's profile said they had played nothing — reproducible 12 times out
   * of 12 against a cold store, which is exactly the shape of "first match
   * after a deploy, while the menu fetches the profile".
   *
   * A cache hit skips the lock: it hands back the very object `update` mutates,
   * so there is nothing to serialise.
   *
   * NOTE that the lock has since been pushed down onto `load` as well, which is
   * where the `cache.set` actually happens — putting it only here left every
   * direct `load()` caller racing. See the note on `load`.
   */
  async ensure(deviceId: string): Promise<StoredProfile> {
    const cached = this.cache.get(deviceId);
    if (cached) return cached;
    return this.withLock(deviceId, () => this.ensureLocked(deviceId));
  }

  /**
   * The body of `ensure`, for callers that ALREADY hold the device's lock.
   * `withLock` is not reentrant — the inner call would chain onto a promise
   * that cannot settle until the inner call finishes — so `update` and
   * `linkAccount` must use this one.
   */
  private async ensureLocked(deviceId: string): Promise<StoredProfile> {
    const existing = await this.loadLocked(deviceId);
    if (existing) return existing;
    const fresh = createProfile(deviceId);
    this.cache.set(deviceId, fresh);
    // A quarantined device gets the blank in MEMORY — the round it is in has to
    // finish — but never on disk. `markDirty` is the line that used to rename a
    // blank over a real profile; skipping it is the whole fix.
    if (!this.unreadable.has(deviceId)) this.markDirty(deviceId);
    return fresh;
  }

  async save(profile: StoredProfile): Promise<void> {
    profile.updatedMs = Date.now();
    this.cache.set(profile.deviceId, profile);
    if (profile.accountId) this.accountIndex.set(profile.accountId, profile.deviceId);
    this.markDirty(profile.deviceId);
  }

  update(deviceId: string, mutate: (p: StoredProfile) => void | Promise<void>): Promise<StoredProfile> {
    return this.withLock(deviceId, async () => {
      const p = await this.ensureLocked(deviceId);
      await mutate(p);
      await this.save(p);
      return p;
    });
  }

  grantEntitlement(deviceId: string, product: string, receipt: string | null): Promise<StoredProfile> {
    return this.update(deviceId, (p) => grantInto(p, product, receipt));
  }

  linkAccount(deviceId: string, accountId: string): Promise<{ profile: StoredProfile; secret: string }> {
    return this.withLock(deviceId, async () => {
      const p = await this.ensureLocked(deviceId);
      const secret = randomToken();
      p.accountId = accountId;
      p.accountSecret = secret;
      this.accountIndex.set(accountId, deviceId);
      await this.save(p);
      try {
        const fs = await this.ready();
        await this.writeAccountIndex(fs);
      } catch {
        this.degraded = true;
      }
      return { profile: p, secret };
    });
  }

  async resolveAccount(accountId: string, secret: string): Promise<StoredProfile | null> {
    try { await this.ready(); } catch { this.degraded = true; return null; }
    const deviceId = this.accountIndex.get(accountId);
    if (!deviceId) return null;
    const p = await this.load(deviceId);
    if (!p || !p.accountSecret || !constantTimeEquals(p.accountSecret, secret)) return null;
    return p;
  }

  private markDirty(deviceId: string): void {
    // A quarantined profile is never written: the blank we hold would replace
    // the real bytes still on disk.
    if (this.unreadable.has(deviceId)) return;
    if (this.closed) {
      // This used to `return` in silence, and that silence is how a settlement
      // that completed a few milliseconds after `close()` disappeared without a
      // trace. Keep it dirty (a later flush can still save it) and SAY SO — a
      // non-zero `postCloseWrites` at exit means the drain raced the payout.
      this.postCloseWrites++;
      this.dirty.add(deviceId);
      process.stderr.write(
        `persistence: profile ${deviceId} was written AFTER close() — the drain did not ` +
        `wait for this settlement (postCloseWrites=${this.postCloseWrites})\n`,
      );
      return;
    }
    this.dirty.add(deviceId);
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushDelayMs);
    // Never hold the process open for a debounce timer.
    const t = this.flushTimer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  /**
   * Force every dirty profile to disk.
   *
   * Two properties this MUST have, both of which it used to lack, and both of
   * which cost a settlement when absent:
   *
   *   1. **A failed write stays dirty.** The id is removed only after `rename`
   *      resolves. Clearing the set up front meant an EACCES dropped that
   *      profile's pending write permanently — and because `flush()` still
   *      resolved, the trade barrier at `trades.ts:623` could stamp a swap
   *      'settled' with nothing on disk.
   *   2. **A concurrent caller awaits the writes already in the air.** The
   *      shutdown barrier calls `flush()` while a debounced flush may be
   *      mid-`rename`; with the dirty set already emptied it saw size 0 and
   *      returned instantly, then `process.exit` cut the write off.
   */
  flush(): Promise<void> {
    // Join the in-flight flush, then run again: ids re-dirtied by a failed write
    // (or arriving while it ran) still need their turn.
    if (this.flushing !== null) return this.flushing.then(() => this.runFlush());
    return this.runFlush();
  }

  private runFlush(): Promise<void> {
    if (this.dirty.size === 0) return Promise.resolve();
    const run = this.flushOnce().finally(() => { this.flushing = null; });
    this.flushing = run;
    return run;
  }

  private async flushOnce(): Promise<void> {
    let fs: FsLike;
    try {
      fs = await this.ready();
    } catch {
      // Keep the dirty set. The disk may come back, and these are payouts.
      this.degraded = true;
      this.rearm();
      return;
    }
    for (const id of Array.from(this.dirty)) {
      if (this.unreadable.has(id)) { this.dirty.delete(id); continue; }
      const p = this.cache.get(id);
      if (!p) { this.dirty.delete(id); continue; }
      try {
        await fs.mkdir(this.shardPath(id), { recursive: true });
        const path = this.filePath(id);
        const tmp = `${path}.tmp`;
        // `serialiseProfile`, not the profile: the downgrade guard's carried
        // keys have to go back to the top level or they are lost on this write.
        await fs.writeFile(tmp, JSON.stringify(serialiseProfile(p)), 'utf8');
        await fs.rename(tmp, path);
        // ONLY here. Before the write, and a rejection loses it forever.
        this.dirty.delete(id);
      } catch (err) {
        this.degraded = true;
        const code = (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.message ?? '';
        // A bare `catch {}` on a durability path is what made the 2026-08-22
        // volume incident invisible for six days.
        process.stderr.write(`persistence: FAILED to write profile ${id} (${code}); will retry\n`);
      }
    }
    // Anything still dirty failed. Come back for it.
    if (this.dirty.size > 0) this.rearm();
  }

  /** Re-arm the debounce so a failed write is retried without a new mutation. */
  private rearm(): void {
    if (this.closed || this.flushTimer !== null || this.dirty.size === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushDelayMs);
    const t = this.flushTimer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  }

  /**
   * Final barrier. Retries a few times, because the last flush of a process is
   * the one carrying the settlements nothing will ever re-dirty, and reports
   * what it could not save rather than exiting quietly on a loss.
   */
  async close(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (let attempt = 0; attempt < 3 && this.dirty.size > 0; attempt++) await this.flush();
    this.closed = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty.size > 0) {
      process.stderr.write(
        `persistence: SHUTDOWN LOST ${this.dirty.size} profile write(s): ` +
        `${Array.from(this.dirty).join(', ')}\n`,
      );
    }
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }
}

function grantInto(p: StoredProfile, product: string, receipt: string | null): void {
  if (product !== IAP_PRODUCT_REMOVE_ADS) return;
  p.entitlements.adsRemoved = true;
  p.entitlements.product = product;
  p.entitlements.receipt = receipt;
  p.entitlements.purchasedMs = Date.now();
  p.progress.adsRemoved = true;
  p.settings.showAds = false;
}

/**
 * 128 bits of opaque token. Not a password — the server issues and rotates it.
 *
 * A CSPRNG, and `server/src/signal.ts`'s note above `generateRoomCode` states
 * the rule this obeys, for a *40-bit room code*: the value is a bearer
 * credential, and a predictable PRNG makes the entropy argument worthless no
 * matter how many characters it has. An account secret is a longer-lived
 * bearer credential than a room code, so the rule applies with more force,
 * and it was the one place still minting one from the engine's PRNG.
 *
 * That was not a theoretical weakness. V8's is one process-wide xorshift128+
 * state recoverable from a handful of raw outputs — and this process publishes
 * raw outputs: the same generator seeds every room (`server/src/room.ts`), the
 * seed is broadcast to every joiner in `S2C.WELCOME`, and
 * `POST /api/rooms/private` mints rooms unauthenticated. Harvest seeds,
 * recover the state, predict the next secret.
 *
 * `globalThis.crypto` and not `node:crypto`: this module's header promises it
 * is importable (as types) from browser code and builds its `node:fs` specifier
 * at runtime so a bundler cannot follow it. A static `node:crypto` import would
 * break that promise. `crypto.getRandomValues` is on `globalThis` in Node 18+
 * and in every browser, so this line runs in both.
 */
export function randomToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Length-independent comparison so a token cannot be guessed byte by byte. */
export function constantTimeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0);
  }
  return diff === 0;
}

/**
 * What an unauthenticated caller may be shown.
 *
 * THREE fields come off, not one. Stripping only `accountSecret` was a
 * half-answer: `GET /api/profile?device=<id>` is unauthenticated, so it also
 * handed out `accountId` — the other half of the credential pair, and the
 * value an attacker needs before a secret is worth guessing — and
 * `entitlements.receipt`, which is a payment-provider token belonging to the
 * purchase, not to the game. `docs/INFRASTRUCTURE.md` already requires that a
 * profile surface leak no durable identifier.
 *
 * Written as an explicit destructure rather than a deny-list loop so that a
 * new secret-bearing field is a TYPE ERROR here on the day it is added, not a
 * leak nobody notices.
 */
export type PublicProfile =
  Omit<StoredProfile, 'accountSecret' | 'accountId' | 'entitlements'>
  & { entitlements: Omit<StoredEntitlements, 'receipt'> };

export function publicProfile(p: StoredProfile): PublicProfile {
  const { accountSecret: _secret, accountId: _account, entitlements, ...rest } = p;
  const { receipt: _receipt, ...safeEntitlements } = entitlements;
  return { ...rest, entitlements: safeEntitlements };
}
