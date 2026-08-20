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

/** Bump when the stored shape changes and add a step to MIGRATIONS. */
export const PERSIST_VERSION = 3;

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
}

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
  favouriteWeapon: number;
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
  };

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

function sanitiseBindings(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const rec = asRecord(raw);
  let n = 0;
  for (const k of Object.keys(rec)) {
    if (n++ > 64) break;
    const v = rec[k];
    if (typeof v === 'string' && v.length <= 24 && k.length <= 24) out[k] = v;
  }
  return out;
}

/** Fold one match's results into a profile. */
export function applyMatchResult(profile: StoredProfile, r: MatchResult, nowMs = Date.now()): StoredProfile {
  const p = profile.progress;
  const s = profile.stats;
  p.kills += r.kills;
  p.deaths += r.deaths;
  p.gamesPlayed += 1;
  if (r.won) p.wins += 1;
  if (r.bestStreak > p.bestKillstreak) p.bestKillstreak = r.bestStreak;
  p.blocksPlaced += r.blocksPlaced;
  p.blocksBroken += r.blocksBroken;
  p.secondsPlayed += r.seconds;
  p.xp += Math.max(0, Math.round(r.xp));
  p.level = levelForXp(p.xp);
  p.favouriteWeapon = r.favouriteWeapon;

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
  return profile;
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

interface FsLike {
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

  async load(deviceId: string): Promise<StoredProfile | null> {
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
      this.cache.set(deviceId, profile);
      if (profile.accountId) this.accountIndex.set(profile.accountId, deviceId);
      return profile;
    } catch {
      return null;
    }
  }

  async ensure(deviceId: string): Promise<StoredProfile> {
    const existing = await this.load(deviceId);
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
        await fs.writeFile(tmp, JSON.stringify(p), 'utf8');
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

/** 128 bits of opaque token. Not a password — the server issues and rotates it. */
export function randomToken(): string {
  let out = '';
  for (let i = 0; i < 4; i++) {
    out += Math.floor(Math.random() * 0x100000000).toString(36).padStart(7, '0');
  }
  return out.slice(0, 28);
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

/** Public view of a profile — never leaks the account secret. */
export function publicProfile(p: StoredProfile): Omit<StoredProfile, 'accountSecret'> {
  const { accountSecret: _secret, ...rest } = p;
  return rest;
}
