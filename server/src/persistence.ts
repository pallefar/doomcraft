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
export const PERSIST_VERSION = 4;

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
  'economy', '_unknown',
]);

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
  /** Load or create. Never returns null. */
  ensure(deviceId: string): Promise<StoredProfile>;
  save(profile: StoredProfile): Promise<void>;
  /** Read-modify-write under a per-device lock. */
  update(deviceId: string, mutate: (p: StoredProfile) => void): Promise<StoredProfile>;
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
  };
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
  };

  /* The downgrade guard. `out.version` has just been stamped DOWN to what this
   * build understands, which is correct for reading and destructive for
   * writing: the next flush would overwrite a newer profile with a strictly
   * smaller one. Anything unrecognised is set aside here and `serialiseProfile`
   * puts it back verbatim. See `StoredProfile._unknown`. */
  const carried = collectUnknownProfileKeys(raw);
  if (carried !== null) out._unknown = carried;

  // Derived, never trusted from disk.
  out.progress.level = levelForXp(out.progress.xp);
  out.progress.adsRemoved = out.entitlements.adsRemoved || out.progress.adsRemoved;
  out.entitlements.adsRemoved = out.progress.adsRemoved;
  if (out.entitlements.adsRemoved) out.settings.showAds = false;
  return out;
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
function collectUnknownProfileKeys(raw: AnyRecord): Record<string, unknown> | null {
  let out: Record<string, unknown> | null = null;
  const put = (k: string, v: unknown): void => {
    (out ??= Object.create(null) as Record<string, unknown>)[k] = v;
  };
  // An older reader may already have set a bag aside; merge it in first so a
  // field survives being opened by two different old builds in a row.
  const prior = raw._unknown;
  if (prior !== null && typeof prior === 'object' && !Array.isArray(prior)) {
    for (const [k, v] of Object.entries(prior as AnyRecord)) {
      if (isPrototypePollutingKey(k)) continue;
      if (KNOWN_PROFILE_KEYS.includes(k)) continue;
      put(k, v);
    }
  }
  for (const [k, v] of Object.entries(raw)) {
    if (isPrototypePollutingKey(k)) continue;
    if (KNOWN_PROFILE_KEYS.includes(k)) continue;
    if (v === undefined) continue;
    put(k, v);
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
  return { ..._unknown, ...(known as unknown as Record<string, unknown>) };
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

  update(deviceId: string, mutate: (p: StoredProfile) => void): Promise<StoredProfile> {
    return this.withLock(deviceId, async () => {
      const p = await this.ensure(deviceId);
      mutate(p);
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
    try {
      const text = await fs.readFile(this.filePath(deviceId), 'utf8');
      const profile = migrateProfile(JSON.parse(text), deviceId);
      // And AGAIN, after the awaits. Belt and braces: `save()` is a public
      // method that writes the cache without taking the lock, so a caller who
      // uses it directly would otherwise re-open the window this closes. A
      // live entry always wins over a copy read from disk.
      const live = this.cache.get(deviceId);
      if (live) return live;
      this.cache.set(deviceId, profile);
      if (profile.accountId) this.accountIndex.set(profile.accountId, deviceId);
      return profile;
    } catch {
      return null;
    }
  }

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
    this.markDirty(deviceId);
    return fresh;
  }

  async save(profile: StoredProfile): Promise<void> {
    profile.updatedMs = Date.now();
    this.cache.set(profile.deviceId, profile);
    if (profile.accountId) this.accountIndex.set(profile.accountId, profile.deviceId);
    this.markDirty(profile.deviceId);
  }

  update(deviceId: string, mutate: (p: StoredProfile) => void): Promise<StoredProfile> {
    return this.withLock(deviceId, async () => {
      const p = await this.ensureLocked(deviceId);
      mutate(p);
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
    if (this.closed) return;
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

  async flush(): Promise<void> {
    if (this.dirty.size === 0) return;
    let fs: FsLike;
    try {
      fs = await this.ready();
    } catch {
      this.degraded = true;
      this.dirty.clear();
      return;
    }
    const ids = Array.from(this.dirty);
    this.dirty.clear();
    for (const id of ids) {
      const p = this.cache.get(id);
      if (!p) continue;
      try {
        await fs.mkdir(this.shardPath(id), { recursive: true });
        const path = this.filePath(id);
        const tmp = `${path}.tmp`;
        // `serialiseProfile`, not the profile: the downgrade guard's carried
        // keys have to go back to the top level or they are lost on this write.
        await fs.writeFile(tmp, JSON.stringify(serialiseProfile(p)), 'utf8');
        await fs.rename(tmp, path);
      } catch {
        this.degraded = true;
      }
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    this.closed = true;
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
