/**
 * DOOMCRAFT — per-mode save slots.
 *
 * One document, four sections, one version number, and a migration chain so an
 * old save is never thrown away. The rule that keeps this honest:
 *
 *   **`migrateSave` is total.** Hand it `undefined`, a string, a v1 blob, a
 *   half-written v2 with a corrupt array — it returns a valid `SaveFile` every
 *   time. A player who alt-tabs mid-write must not lose a campaign.
 *
 * The shipped v1 save is the flat `SaveProgress` in constants.ts, which only
 * ever described deathmatch. v2 keeps every one of its numbers (they migrate
 * into `deathmatch` and `profile`) and adds Quest campaign slots, the Builder
 * world list and Horde run records.
 *
 * Nothing here touches `localStorage`, `fetch` or the DOM — storage is injected
 * as a two-method interface so the same code runs in the page, in a Worker and
 * on the server.
 */

import { DEFAULT_PROGRESS, STORAGE_PREFIX, clamp, levelForXp } from './constants.ts';
import type { SaveProgress } from './constants.ts';
import { DEFAULT_SKILL, ModeId, SKILL_COUNT, clampSkill, isModeId } from './modes.ts';
import { WeaponId } from './weapons.ts';

/* ------------------------------------------------------------------------ *
 * Version
 * ------------------------------------------------------------------------ */

/** v1 = the flat SaveProgress. v2 = per-mode slots. v3 = the packed avatar. */
export const SAVES_VERSION = 3;

export const SAVE_STORAGE_KEY = `${STORAGE_PREFIX}saves`;
/** The v1 key, read once during migration and then left alone. */
export const LEGACY_PROGRESS_KEY = `${STORAGE_PREFIX}progress`;

export const MAX_QUEST_SLOTS = 6;
export const MAX_BUILDER_WORLDS = 24;
export const MAX_SAVE_NAME = 24;
/** Level records kept per campaign slot before the oldest are dropped. */
export const MAX_LEVEL_RECORDS = 64;

/* ------------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------------ */

export interface SaveProfile {
  name: string;
  /**
   * Legacy appearance: an index into the six flat marine colours the renderer
   * used before the Kenney rig. Kept because the wire still carries it and an
   * older client still reads it; `avatar` is the truth.
   */
  skin: number;
  /**
   * The packed avatar — four outfit indices and two palette indices in one
   * uint32. See `client/src/characters/avatar.ts` for the bit layout; nothing
   * on the server or in this file needs to understand it, which is exactly why
   * it is stored as a number and not as a struct.
   */
  avatar: number;
  xp: number;
  level: number;
  /** Total seconds across every mode. */
  secondsPlayed: number;
  /** Server truth mirrored locally so the menu can hide the buy button. */
  adsRemoved: boolean;
  createdMs: number;
  lastMode: ModeId;
}

/** One Quest level's record inside a campaign slot. */
export interface QuestLevelRecord {
  levelId: string;
  completed: boolean;
  /** Best clear time in seconds, 0 when never cleared. */
  bestTimeSec: number;
  /** Best of each counter across every attempt. */
  kills: number;
  killsTotal: number;
  items: number;
  itemsTotal: number;
  secrets: number;
  secretsTotal: number;
  deaths: number;
  attempts: number;
  firstClearedMs: number;
  lastPlayedMs: number;
}

/** What the marine is carrying between levels — Doom keeps the arsenal. */
export interface QuestLoadout {
  health: number;
  armor: number;
  /** Weapon-ownership bitmask. */
  weaponMask: number;
  weapon: number;
  /** Reserve per AmmoType, index 0 unused. */
  ammo: number[];
  /** Keycard bitmask; cleared on every new level, like Doom. */
  keys: number;
  backpack: boolean;
}

export interface QuestSlot {
  id: string;
  name: string;
  skill: number;
  episodeId: string;
  /** Where "Continue" resumes. */
  levelId: string;
  createdMs: number;
  updatedMs: number;
  totalTimeSec: number;
  deaths: number;
  completed: boolean;
  loadout: QuestLoadout;
  levels: QuestLevelRecord[];
}

export interface QuestSave {
  /** Index into `slots`, or -1 when nothing has been started. */
  activeSlot: number;
  slots: QuestSlot[];
}

export interface BuilderWorld {
  id: string;
  name: string;
  seed: number;
  createdMs: number;
  updatedMs: number;
  /** Wall-clock seconds spent in this world. */
  secondsPlayed: number;
  blocksPlaced: number;
  blocksBroken: number;
  /** Chunks that carry at least one edit. */
  editedChunks: number;
  /** True when the world lives on a server rather than only in this browser. */
  online: boolean;
  /** Short code a friend types to join. '' when the world is local-only. */
  shareCode: string;
  /** Packed 0xRRGGBB used as the tile swatch until a real thumbnail exists. */
  swatch: number;
}

export interface BuilderSave {
  activeWorldId: string;
  worlds: BuilderWorld[];
}

export interface HordeMapRecord {
  mapId: string;
  bestWave: number;
  bestScore: number;
  bestTimeSec: number;
}

export interface HordeSave {
  bestWave: number;
  bestScore: number;
  runs: number;
  totalKills: number;
  totalBlocksPlaced: number;
  lastSkill: number;
  maps: HordeMapRecord[];
}

export interface DeathmatchSave {
  matches: number;
  wins: number;
  kills: number;
  deaths: number;
  bestStreak: number;
  headshots: number;
  damageDealt: number;
  secondsPlayed: number;
  favouriteWeapon: number;
  /** Per-weapon kills, indexed by WeaponId. */
  weaponKills: number[];
}

export interface SaveFile {
  version: number;
  updatedMs: number;
  profile: SaveProfile;
  quest: QuestSave;
  builder: BuilderSave;
  horde: HordeSave;
  deathmatch: DeathmatchSave;
}

/* ------------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------------ */

export function createQuestLoadout(): QuestLoadout {
  return {
    health: 100, armor: 0,
    weaponMask: (1 << WeaponId.PISTOL) | (1 << WeaponId.CHAINSAW),
    weapon: WeaponId.PISTOL,
    ammo: [0, 50, 0, 0, 0],
    keys: 0,
    backpack: false,
  };
}

export function createQuestLevelRecord(levelId: string): QuestLevelRecord {
  return {
    levelId, completed: false, bestTimeSec: 0,
    kills: 0, killsTotal: 0, items: 0, itemsTotal: 0, secrets: 0, secretsTotal: 0,
    deaths: 0, attempts: 0, firstClearedMs: 0, lastPlayedMs: 0,
  };
}

export function createQuestSlot(id: string, name: string, skill: number, episodeId: string, levelId: string, nowMs: number): QuestSlot {
  return {
    id, name, skill: clampSkill(skill), episodeId, levelId,
    createdMs: nowMs, updatedMs: nowMs, totalTimeSec: 0, deaths: 0, completed: false,
    loadout: createQuestLoadout(),
    levels: [],
  };
}

export function createBuilderWorld(id: string, name: string, seed: number, nowMs: number): BuilderWorld {
  return {
    id, name, seed: seed >>> 0, createdMs: nowMs, updatedMs: nowMs,
    secondsPlayed: 0, blocksPlaced: 0, blocksBroken: 0, editedChunks: 0,
    online: false, shareCode: '', swatch: 0x4fb84a,
  };
}

export function createSaveFile(nowMs = 0): SaveFile {
  return {
    version: SAVES_VERSION,
    updatedMs: nowMs,
    profile: {
      name: '', skin: 0, avatar: 0, xp: 0, level: 1, secondsPlayed: 0, adsRemoved: false,
      createdMs: nowMs, lastMode: ModeId.QUEST,
    },
    quest: { activeSlot: -1, slots: [] },
    builder: { activeWorldId: '', worlds: [] },
    horde: { bestWave: 0, bestScore: 0, runs: 0, totalKills: 0, totalBlocksPlaced: 0, lastSkill: DEFAULT_SKILL, maps: [] },
    deathmatch: {
      matches: 0, wins: 0, kills: 0, deaths: 0, bestStreak: 0, headshots: 0,
      damageDealt: 0, secondsPlayed: 0, favouriteWeapon: WeaponId.PISTOL,
      weaponKills: [0, 0, 0, 0, 0, 0, 0],
    },
  };
}

/* ------------------------------------------------------------------------ *
 * Coercion helpers — every field is validated, nothing is trusted
 * ------------------------------------------------------------------------ */

function rec(v: unknown): Record<string, unknown> {
  return (v !== null && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
}
function arr(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function n(v: unknown, dflt: number, lo = -Number.MAX_SAFE_INTEGER, hi = Number.MAX_SAFE_INTEGER): number {
  const x = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return clamp(x, lo, hi);
}
function i(v: unknown, dflt: number, lo = 0, hi = Number.MAX_SAFE_INTEGER): number {
  return Math.round(n(v, dflt, lo, hi));
}
function s(v: unknown, dflt = '', max = MAX_SAVE_NAME): string {
  return typeof v === 'string' ? v.slice(0, max) : dflt;
}
function b(v: unknown, dflt = false): boolean { return typeof v === 'boolean' ? v : dflt; }

function numArray(v: unknown, length: number, dflt: number): number[] {
  const src = arr(v);
  const out = new Array<number>(length);
  for (let k = 0; k < length; k++) out[k] = i(src[k], dflt, 0, 999999);
  return out;
}

/** Slug-safe id. Generates a deterministic-ish one when the input is unusable. */
export function normaliseSaveId(v: unknown, fallbackSeed: number): string {
  const raw = typeof v === 'string' ? v.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) : '';
  if (raw.length >= 3) return raw;
  return `s${(fallbackSeed >>> 0).toString(36)}`;
}

/* ------------------------------------------------------------------------ *
 * Coercion of each section
 * ------------------------------------------------------------------------ */

function coerceProfile(v: unknown, nowMs: number): SaveProfile {
  const r = rec(v);
  const xp = i(r.xp, 0, 0, 1e9);
  const mode = i(r.lastMode, ModeId.QUEST, 0, 255);
  return {
    name: s(r.name, ''),
    skin: i(r.skin, 0, 0, 255),
    // uint32, so it survives a round trip through JSON without losing bits.
    avatar: i(r.avatar, 0, 0, 0xffffffff),
    xp,
    level: i(r.level, levelForXp(xp), 1, 200),
    secondsPlayed: i(r.secondsPlayed, 0, 0, 1e9),
    adsRemoved: b(r.adsRemoved, false),
    createdMs: i(r.createdMs, nowMs, 0, 1e15),
    lastMode: isModeId(mode) ? mode : ModeId.QUEST,
  };
}

function coerceLoadout(v: unknown): QuestLoadout {
  const r = rec(v);
  const d = createQuestLoadout();
  return {
    health: i(r.health, d.health, 0, 999),
    armor: i(r.armor, d.armor, 0, 999),
    weaponMask: i(r.weaponMask, d.weaponMask, 0, 0xffff),
    weapon: i(r.weapon, d.weapon, 0, 15),
    ammo: numArray(r.ammo, 5, 0),
    keys: i(r.keys, 0, 0, 7),
    backpack: b(r.backpack, false),
  };
}

function coerceLevelRecord(v: unknown): QuestLevelRecord | null {
  const r = rec(v);
  const levelId = s(r.levelId, '', 48);
  if (levelId.length === 0) return null;
  const out = createQuestLevelRecord(levelId);
  out.completed = b(r.completed, false);
  out.bestTimeSec = i(r.bestTimeSec, 0, 0, 1e7);
  out.kills = i(r.kills, 0, 0, 1e6);
  out.killsTotal = i(r.killsTotal, 0, 0, 1e6);
  out.items = i(r.items, 0, 0, 1e6);
  out.itemsTotal = i(r.itemsTotal, 0, 0, 1e6);
  out.secrets = i(r.secrets, 0, 0, 1e6);
  out.secretsTotal = i(r.secretsTotal, 0, 0, 1e6);
  out.deaths = i(r.deaths, 0, 0, 1e6);
  out.attempts = i(r.attempts, 0, 0, 1e6);
  out.firstClearedMs = i(r.firstClearedMs, 0, 0, 1e15);
  out.lastPlayedMs = i(r.lastPlayedMs, 0, 0, 1e15);
  return out;
}

function coerceQuestSlot(v: unknown, index: number, nowMs: number): QuestSlot {
  const r = rec(v);
  const slot = createQuestSlot(
    normaliseSaveId(r.id, index + 1),
    s(r.name, `Slot ${index + 1}`),
    i(r.skill, DEFAULT_SKILL, 0, SKILL_COUNT - 1),
    s(r.episodeId, 'e1', 48),
    s(r.levelId, '', 48),
    i(r.createdMs, nowMs, 0, 1e15),
  );
  slot.updatedMs = i(r.updatedMs, slot.createdMs, 0, 1e15);
  slot.totalTimeSec = i(r.totalTimeSec, 0, 0, 1e8);
  slot.deaths = i(r.deaths, 0, 0, 1e6);
  slot.completed = b(r.completed, false);
  slot.loadout = coerceLoadout(r.loadout);
  const levels: QuestLevelRecord[] = [];
  for (const raw of arr(r.levels).slice(0, MAX_LEVEL_RECORDS)) {
    const lr = coerceLevelRecord(raw);
    if (lr !== null) levels.push(lr);
  }
  slot.levels = levels;
  return slot;
}

function coerceQuest(v: unknown, nowMs: number): QuestSave {
  const r = rec(v);
  const slots: QuestSlot[] = [];
  const rawSlots = arr(r.slots).slice(0, MAX_QUEST_SLOTS);
  for (let k = 0; k < rawSlots.length; k++) slots.push(coerceQuestSlot(rawSlots[k], k, nowMs));
  const active = i(r.activeSlot, -1, -1, MAX_QUEST_SLOTS);
  return { activeSlot: active >= slots.length ? (slots.length > 0 ? 0 : -1) : active, slots };
}

function coerceBuilderWorld(v: unknown, index: number, nowMs: number): BuilderWorld {
  const r = rec(v);
  const w = createBuilderWorld(
    normaliseSaveId(r.id, index + 1),
    s(r.name, `World ${index + 1}`),
    i(r.seed, 0, 0, 0xffffffff),
    i(r.createdMs, nowMs, 0, 1e15),
  );
  w.updatedMs = i(r.updatedMs, w.createdMs, 0, 1e15);
  w.secondsPlayed = i(r.secondsPlayed, 0, 0, 1e8);
  w.blocksPlaced = i(r.blocksPlaced, 0, 0, 1e9);
  w.blocksBroken = i(r.blocksBroken, 0, 0, 1e9);
  w.editedChunks = i(r.editedChunks, 0, 0, 100000);
  w.online = b(r.online, false);
  w.shareCode = s(r.shareCode, '', 16);
  w.swatch = i(r.swatch, 0x4fb84a, 0, 0xffffff);
  return w;
}

function coerceBuilder(v: unknown, nowMs: number): BuilderSave {
  const r = rec(v);
  const worlds: BuilderWorld[] = [];
  const raw = arr(r.worlds).slice(0, MAX_BUILDER_WORLDS);
  for (let k = 0; k < raw.length; k++) worlds.push(coerceBuilderWorld(raw[k], k, nowMs));
  let active = s(r.activeWorldId, '', 32);
  if (active.length > 0 && !worlds.some((w) => w.id === active)) active = '';
  return { activeWorldId: active, worlds };
}

function coerceHorde(v: unknown): HordeSave {
  const r = rec(v);
  const maps: HordeMapRecord[] = [];
  for (const raw of arr(r.maps).slice(0, 32)) {
    const m = rec(raw);
    const mapId = s(m.mapId, '', 48);
    if (mapId.length === 0) continue;
    maps.push({
      mapId,
      bestWave: i(m.bestWave, 0, 0, 100000),
      bestScore: i(m.bestScore, 0, 0, 1e9),
      bestTimeSec: i(m.bestTimeSec, 0, 0, 1e7),
    });
  }
  return {
    bestWave: i(r.bestWave, 0, 0, 100000),
    bestScore: i(r.bestScore, 0, 0, 1e9),
    runs: i(r.runs, 0, 0, 1e7),
    totalKills: i(r.totalKills, 0, 0, 1e9),
    totalBlocksPlaced: i(r.totalBlocksPlaced, 0, 0, 1e9),
    lastSkill: i(r.lastSkill, DEFAULT_SKILL, 0, SKILL_COUNT - 1),
    maps,
  };
}

function coerceDeathmatch(v: unknown): DeathmatchSave {
  const r = rec(v);
  return {
    matches: i(r.matches, 0, 0, 1e7),
    wins: i(r.wins, 0, 0, 1e7),
    kills: i(r.kills, 0, 0, 1e9),
    deaths: i(r.deaths, 0, 0, 1e9),
    bestStreak: i(r.bestStreak, 0, 0, 100000),
    headshots: i(r.headshots, 0, 0, 1e9),
    damageDealt: i(r.damageDealt, 0, 0, 1e12),
    secondsPlayed: i(r.secondsPlayed, 0, 0, 1e9),
    favouriteWeapon: i(r.favouriteWeapon, WeaponId.PISTOL, 0, 15),
    weaponKills: numArray(r.weaponKills, 7, 0),
  };
}

/* ------------------------------------------------------------------------ *
 * Migration
 * ------------------------------------------------------------------------ */

export interface SaveMigration {
  from: number;
  to: number;
  /** Rewrites the raw document in place and returns it. Must not throw. */
  apply(raw: Record<string, unknown>, nowMs: number): Record<string, unknown>;
}

/**
 * v1 -> v2. The old save was the flat `SaveProgress`: one set of counters that
 * only ever meant deathmatch. Nothing is discarded — the identity fields move
 * to `profile`, the combat counters to `deathmatch`, and Builder inherits the
 * `lastSeed` as a first world so the player's terrain is still there.
 */
const migrateV1toV2: SaveMigration = {
  from: 1,
  to: 2,
  apply(raw, nowMs) {
    const p = raw as unknown as Partial<SaveProgress>;
    const out = createSaveFile(nowMs) as unknown as Record<string, unknown>;
    const file = out as unknown as SaveFile;
    file.profile.name = s(p.name, '');
    file.profile.skin = i(p.skin, 0, 0, 255);
    // Straight to v3's representation: a v1 player who was purple stays purple.
    file.profile.avatar = LEGACY_AVATAR_BY_SKIN[file.profile.skin % LEGACY_AVATAR_BY_SKIN.length];
    file.profile.xp = i(p.xp, 0, 0, 1e9);
    file.profile.level = i(p.level, levelForXp(file.profile.xp), 1, 200);
    file.profile.secondsPlayed = i(p.secondsPlayed, 0, 0, 1e9);
    file.profile.adsRemoved = b(p.adsRemoved, false);
    file.profile.lastMode = ModeId.DEATHMATCH;

    file.deathmatch.matches = i(p.gamesPlayed, 0, 0, 1e7);
    file.deathmatch.wins = i(p.wins, 0, 0, 1e7);
    file.deathmatch.kills = i(p.kills, 0, 0, 1e9);
    file.deathmatch.deaths = i(p.deaths, 0, 0, 1e9);
    file.deathmatch.bestStreak = i(p.bestKillstreak, 0, 0, 100000);
    file.deathmatch.secondsPlayed = i(p.secondsPlayed, 0, 0, 1e9);
    file.deathmatch.favouriteWeapon = i(p.favouriteWeapon, WeaponId.PISTOL, 0, 15);

    const seed = i(p.lastSeed, 0, 0, 0xffffffff);
    const placed = i(p.blocksPlaced, 0, 0, 1e9);
    const broken = i(p.blocksBroken, 0, 0, 1e9);
    if (seed !== 0 || placed > 0 || broken > 0) {
      const world = createBuilderWorld('world1', 'My World', seed, nowMs);
      world.blocksPlaced = placed;
      world.blocksBroken = broken;
      file.builder.worlds.push(world);
      file.builder.activeWorldId = world.id;
    }
    file.version = 2;
    return out;
  },
};

/**
 * The six legacy `skin` bytes, pre-packed as avatars.
 *
 * The bit layout and the outfit roster live in
 * `client/src/characters/avatar.ts`; this table is the one place the SERVER-side
 * schema needs to know a concrete value, so it is stated as constants rather
 * than by importing client code into shared. `avatar.test.ts` asserts that
 * `packAvatar(avatarFromLegacySkin(k))` equals each entry, so the two can never
 * drift apart silently.
 *
 *   0 green  -> Marine   1 purple -> Warden   2 orange -> Timber
 *   3 blue   -> Enforcer 4 red    -> Ranger   5 grey   -> Sentry
 */
export const LEGACY_AVATAR_BY_SKIN: readonly number[] = Object.freeze([
  0x00000000, 0x00a09999, 0x00404444, 0x00c01111, 0x00602222, 0x01808888,
]);

/**
 * v2 -> v3. Adds `profile.avatar`. Nobody who has already picked a colour loses
 * it: the old `skin` byte is translated into the nearest full avatar, so a
 * player who was purple comes back purple rather than coming back as the
 * default marine.
 */
const migrateV2toV3: SaveMigration = {
  from: 2,
  to: 3,
  apply(raw) {
    const profile = rec(raw.profile);
    const skin = i(profile.skin, 0, 0, 255);
    if (profile.avatar === undefined) {
      profile.avatar = LEGACY_AVATAR_BY_SKIN[skin % LEGACY_AVATAR_BY_SKIN.length];
    }
    raw.profile = profile;
    raw.version = 3;
    return raw;
  },
};

/** Applied in order. A v4 is one more entry here and a bump of SAVES_VERSION. */
export const SAVE_MIGRATIONS: readonly SaveMigration[] = Object.freeze([migrateV1toV2, migrateV2toV3]);

/** True for a document that at least claims to be a v2+ per-mode save. */
function looksLikeV2(raw: Record<string, unknown>): boolean {
  return i(raw.version, 0, 0, 1000) >= 2
    || raw.quest !== undefined || raw.builder !== undefined || raw.deathmatch !== undefined;
}

/**
 * Turn anything at all into a valid `SaveFile`. Never throws, never returns a
 * partially filled object, never silently drops a recognisable v1 save.
 */
export function migrateSave(input: unknown, nowMs = 0): SaveFile {
  let raw: Record<string, unknown>;
  if (typeof input === 'string') {
    try { raw = rec(JSON.parse(input)); } catch { raw = {}; }
  } else {
    raw = rec(input);
  }

  let version = i(raw.version, looksLikeV2(raw) ? 2 : 1, 0, 1000);
  if (version < 1) version = 1;

  // v1 documents that were never written at all: start clean.
  if (version === 1 && Object.keys(raw).length === 0) return createSaveFile(nowMs);

  for (const m of SAVE_MIGRATIONS) {
    if (version !== m.from) continue;
    try {
      raw = m.apply(raw, nowMs);
      version = m.to;
    } catch {
      // A migration that blows up must not cost the player everything else.
      raw = createSaveFile(nowMs) as unknown as Record<string, unknown>;
      version = SAVES_VERSION;
      break;
    }
  }

  const file: SaveFile = {
    version: SAVES_VERSION,
    updatedMs: i(raw.updatedMs, nowMs, 0, 1e15),
    profile: coerceProfile(raw.profile, nowMs),
    quest: coerceQuest(raw.quest, nowMs),
    builder: coerceBuilder(raw.builder, nowMs),
    horde: coerceHorde(raw.horde),
    deathmatch: coerceDeathmatch(raw.deathmatch),
  };
  return file;
}

/** A v1 blob rebuilt from a v2 save, for the parts of the stack still on v1. */
export function toLegacyProgress(save: SaveFile): SaveProgress {
  const d = save.deathmatch;
  let blocksPlaced = 0;
  let blocksBroken = 0;
  let lastSeed = 0;
  for (const w of save.builder.worlds) {
    blocksPlaced += w.blocksPlaced;
    blocksBroken += w.blocksBroken;
    if (w.id === save.builder.activeWorldId) lastSeed = w.seed;
  }
  return {
    ...DEFAULT_PROGRESS,
    name: save.profile.name,
    skin: save.profile.skin,
    xp: save.profile.xp,
    level: save.profile.level,
    kills: d.kills,
    deaths: d.deaths,
    wins: d.wins,
    gamesPlayed: d.matches,
    bestKillstreak: d.bestStreak,
    blocksPlaced,
    blocksBroken,
    secondsPlayed: save.profile.secondsPlayed,
    favouriteWeapon: d.favouriteWeapon,
    lastSeed,
    adsRemoved: save.profile.adsRemoved,
  };
}

/* ------------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------------ */

/** The two methods this module needs from `localStorage` (or a stub, or a file). */
export interface SaveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** An in-memory storage, for tests, private-mode browsers and the server. */
export class MemorySaveStorage implements SaveStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
}

/**
 * Read the save, migrating v1 in from its own key when there is no v2 document
 * yet. Any exception from a hostile `storage` is swallowed: a save that cannot
 * be read is a fresh save, never a crash on boot.
 */
export function loadSave(storage: SaveStorage, nowMs = 0): SaveFile {
  let text: string | null = null;
  try { text = storage.getItem(SAVE_STORAGE_KEY); } catch { text = null; }
  if (text !== null && text.length > 0) return migrateSave(text, nowMs);

  let legacy: string | null = null;
  try { legacy = storage.getItem(LEGACY_PROGRESS_KEY); } catch { legacy = null; }
  if (legacy !== null && legacy.length > 0) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(legacy); } catch { parsed = null; }
    const asRec = rec(parsed);
    asRec.version = 1;
    return migrateSave(asRec, nowMs);
  }
  return createSaveFile(nowMs);
}

/** Serialise and write. Returns false when the storage refused (private mode). */
export function storeSave(storage: SaveStorage, save: SaveFile, nowMs = 0): boolean {
  save.version = SAVES_VERSION;
  save.updatedMs = nowMs;
  try {
    storage.setItem(SAVE_STORAGE_KEY, JSON.stringify(save));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------ *
 * Quest updaters — pure, they mutate and return the slot they were given
 * ------------------------------------------------------------------------ */

export function activeQuestSlot(save: SaveFile): QuestSlot | null {
  const q = save.quest;
  if (q.activeSlot < 0 || q.activeSlot >= q.slots.length) return null;
  return q.slots[q.activeSlot];
}

/**
 * Start a campaign. Reuses a slot with the same episode+skill when one exists,
 * otherwise appends (evicting the least recently updated when full).
 */
export function beginQuest(
  save: SaveFile, episodeId: string, levelId: string, skill: number, nowMs: number,
): QuestSlot {
  const wanted = clampSkill(skill);
  const q = save.quest;
  for (let k = 0; k < q.slots.length; k++) {
    const sl = q.slots[k];
    if (sl.episodeId === episodeId && sl.skill === wanted) {
      q.activeSlot = k;
      sl.levelId = levelId;
      sl.updatedMs = nowMs;
      return sl;
    }
  }
  if (q.slots.length >= MAX_QUEST_SLOTS) {
    let oldest = 0;
    for (let k = 1; k < q.slots.length; k++) if (q.slots[k].updatedMs < q.slots[oldest].updatedMs) oldest = k;
    q.slots.splice(oldest, 1);
  }
  const slot = createQuestSlot(
    `q${nowMs.toString(36)}${q.slots.length}`,
    `${episodeId.toUpperCase()} · ${wanted}`,
    wanted, episodeId, levelId, nowMs,
  );
  q.slots.push(slot);
  q.activeSlot = q.slots.length - 1;
  save.profile.lastMode = ModeId.QUEST;
  return slot;
}

export function questLevelRecord(slot: QuestSlot, levelId: string): QuestLevelRecord {
  for (const r of slot.levels) if (r.levelId === levelId) return r;
  const r = createQuestLevelRecord(levelId);
  if (slot.levels.length >= MAX_LEVEL_RECORDS) slot.levels.shift();
  slot.levels.push(r);
  return r;
}

export interface QuestLevelResult {
  levelId: string;
  completed: boolean;
  timeSec: number;
  kills: number;
  killsTotal: number;
  items: number;
  itemsTotal: number;
  secrets: number;
  secretsTotal: number;
  deaths: number;
  /** Level the exit points at. '' ends the episode. */
  nextLevelId: string;
  /** What the marine walked out with. */
  loadout?: QuestLoadout;
}

/**
 * Fold one level attempt into a campaign slot. Counters keep the best of every
 * run, the clear time keeps the fastest, and `slot.levelId` advances so
 * "Continue" resumes at the right place. Returns true when this run set a new
 * personal best on the clock or on any counter.
 */
export function recordQuestLevel(save: SaveFile, slot: QuestSlot, result: QuestLevelResult, nowMs: number): boolean {
  const r = questLevelRecord(slot, result.levelId);
  let record = false;

  r.attempts++;
  r.lastPlayedMs = nowMs;
  r.deaths += Math.max(0, result.deaths | 0);
  r.killsTotal = Math.max(r.killsTotal, result.killsTotal | 0);
  r.itemsTotal = Math.max(r.itemsTotal, result.itemsTotal | 0);
  r.secretsTotal = Math.max(r.secretsTotal, result.secretsTotal | 0);
  if ((result.kills | 0) > r.kills) { r.kills = result.kills | 0; record = true; }
  if ((result.items | 0) > r.items) { r.items = result.items | 0; record = true; }
  if ((result.secrets | 0) > r.secrets) { r.secrets = result.secrets | 0; record = true; }

  if (result.completed) {
    const t = Math.max(0, Math.round(result.timeSec));
    if (!r.completed) { r.completed = true; r.firstClearedMs = nowMs; record = true; }
    if (r.bestTimeSec === 0 || (t > 0 && t < r.bestTimeSec)) { r.bestTimeSec = t; record = true; }
    slot.levelId = result.nextLevelId.length > 0 ? result.nextLevelId : result.levelId;
    if (result.nextLevelId.length === 0) slot.completed = true;
  }

  slot.deaths += Math.max(0, result.deaths | 0);
  slot.totalTimeSec += Math.max(0, Math.round(result.timeSec));
  slot.updatedMs = nowMs;
  if (result.loadout !== undefined) slot.loadout = coerceLoadout(result.loadout);
  save.profile.secondsPlayed += Math.max(0, Math.round(result.timeSec));
  save.profile.lastMode = ModeId.QUEST;
  return record;
}

/** Cleared levels over levels attempted, as a percentage. */
export function questCompletion(slot: QuestSlot): number {
  if (slot.levels.length === 0) return 0;
  let done = 0;
  for (const r of slot.levels) if (r.completed) done++;
  return Math.round((done / slot.levels.length) * 100);
}

/** Best-effort "have I finished this level" for the level picker. */
export function isLevelCleared(save: SaveFile, episodeId: string, levelId: string): boolean {
  for (const slot of save.quest.slots) {
    if (slot.episodeId !== episodeId) continue;
    for (const r of slot.levels) if (r.levelId === levelId && r.completed) return true;
  }
  return false;
}

/* ------------------------------------------------------------------------ *
 * Builder updaters
 * ------------------------------------------------------------------------ */

export function findBuilderWorld(save: SaveFile, id: string): BuilderWorld | null {
  for (const w of save.builder.worlds) if (w.id === id) return w;
  return null;
}

/** Create a world, or return the existing one with that id. */
export function addBuilderWorld(save: SaveFile, name: string, seed: number, nowMs: number): BuilderWorld {
  const id = `w${nowMs.toString(36)}${save.builder.worlds.length}`;
  if (save.builder.worlds.length >= MAX_BUILDER_WORLDS) {
    let oldest = 0;
    for (let k = 1; k < save.builder.worlds.length; k++) {
      if (save.builder.worlds[k].updatedMs < save.builder.worlds[oldest].updatedMs) oldest = k;
    }
    save.builder.worlds.splice(oldest, 1);
  }
  const w = createBuilderWorld(id, s(name, 'New World'), seed, nowMs);
  save.builder.worlds.push(w);
  save.builder.activeWorldId = w.id;
  save.profile.lastMode = ModeId.BUILDER;
  return w;
}

export function removeBuilderWorld(save: SaveFile, id: string): boolean {
  const k = save.builder.worlds.findIndex((w) => w.id === id);
  if (k < 0) return false;
  save.builder.worlds.splice(k, 1);
  if (save.builder.activeWorldId === id) {
    save.builder.activeWorldId = save.builder.worlds.length > 0 ? save.builder.worlds[0].id : '';
  }
  return true;
}

export interface BuilderSessionResult {
  worldId: string;
  secondsPlayed: number;
  blocksPlaced: number;
  blocksBroken: number;
  editedChunks: number;
}

export function recordBuilderSession(save: SaveFile, result: BuilderSessionResult, nowMs: number): BuilderWorld | null {
  const w = findBuilderWorld(save, result.worldId);
  if (w === null) return null;
  w.secondsPlayed += Math.max(0, Math.round(result.secondsPlayed));
  w.blocksPlaced += Math.max(0, result.blocksPlaced | 0);
  w.blocksBroken += Math.max(0, result.blocksBroken | 0);
  w.editedChunks = Math.max(w.editedChunks, result.editedChunks | 0);
  w.updatedMs = nowMs;
  save.profile.secondsPlayed += Math.max(0, Math.round(result.secondsPlayed));
  save.profile.lastMode = ModeId.BUILDER;
  return w;
}

/** Most recently touched first — the order the world picker shows. */
export function builderWorldsByRecency(save: SaveFile): BuilderWorld[] {
  return save.builder.worlds.slice().sort((a, b) => b.updatedMs - a.updatedMs);
}

/* ------------------------------------------------------------------------ *
 * Horde + Deathmatch updaters
 * ------------------------------------------------------------------------ */

export interface HordeRunResult {
  mapId: string;
  wave: number;
  score: number;
  kills: number;
  blocksPlaced: number;
  timeSec: number;
  skill: number;
}

/** Returns true when the run beat the stored best wave. */
export function recordHordeRun(save: SaveFile, result: HordeRunResult, nowMs: number): boolean {
  const h = save.horde;
  h.runs++;
  h.totalKills += Math.max(0, result.kills | 0);
  h.totalBlocksPlaced += Math.max(0, result.blocksPlaced | 0);
  h.lastSkill = clampSkill(result.skill);
  const better = (result.wave | 0) > h.bestWave;
  if (better) h.bestWave = result.wave | 0;
  if ((result.score | 0) > h.bestScore) h.bestScore = result.score | 0;

  const mapId = s(result.mapId, 'arena', 48);
  let m: HordeMapRecord | undefined;
  for (const r of h.maps) if (r.mapId === mapId) { m = r; break; }
  if (m === undefined) {
    m = { mapId, bestWave: 0, bestScore: 0, bestTimeSec: 0 };
    if (h.maps.length < 32) h.maps.push(m);
  }
  m.bestWave = Math.max(m.bestWave, result.wave | 0);
  m.bestScore = Math.max(m.bestScore, result.score | 0);
  m.bestTimeSec = Math.max(m.bestTimeSec, Math.round(result.timeSec));

  save.profile.secondsPlayed += Math.max(0, Math.round(result.timeSec));
  save.profile.lastMode = ModeId.HORDE;
  save.updatedMs = nowMs;
  return better;
}

export interface DeathmatchResult {
  kills: number;
  deaths: number;
  won: boolean;
  bestStreak: number;
  headshots: number;
  damageDealt: number;
  secondsPlayed: number;
  /** Kills per WeaponId this match. Short arrays are fine. */
  weaponKills?: number[];
}

export function recordDeathmatch(save: SaveFile, result: DeathmatchResult, nowMs: number): void {
  const d = save.deathmatch;
  d.matches++;
  if (result.won) d.wins++;
  d.kills += Math.max(0, result.kills | 0);
  d.deaths += Math.max(0, result.deaths | 0);
  d.bestStreak = Math.max(d.bestStreak, result.bestStreak | 0);
  d.headshots += Math.max(0, result.headshots | 0);
  d.damageDealt += Math.max(0, Math.round(result.damageDealt));
  d.secondsPlayed += Math.max(0, Math.round(result.secondsPlayed));
  if (result.weaponKills !== undefined) {
    for (let k = 0; k < d.weaponKills.length; k++) {
      d.weaponKills[k] += Math.max(0, (result.weaponKills[k] ?? 0) | 0);
    }
    let best = 0;
    for (let k = 1; k < d.weaponKills.length; k++) if (d.weaponKills[k] > d.weaponKills[best]) best = k;
    d.favouriteWeapon = best;
  }
  save.profile.secondsPlayed += Math.max(0, Math.round(result.secondsPlayed));
  save.profile.lastMode = ModeId.DEATHMATCH;
  save.updatedMs = nowMs;
}

/** Kills per death, to two decimals. Deaths of zero returns the kill count. */
export function kdr(d: DeathmatchSave): number {
  if (d.deaths <= 0) return d.kills;
  return Math.round((d.kills / d.deaths) * 100) / 100;
}

/** Percentage of matches won. */
export function winRate(d: DeathmatchSave): number {
  if (d.matches <= 0) return 0;
  return Math.round((d.wins / d.matches) * 100);
}

/* ------------------------------------------------------------------------ *
 * Menu-facing summary
 * ------------------------------------------------------------------------ */

/** `1 run` / `2 runs`. The tiles show these counts, so the grammar shows too. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export interface ModeSaveSummary {
  modeId: ModeId;
  /** Big number on the tile, e.g. "E1M3" or "Wave 14". */
  headline: string;
  /** Small line under it. */
  detail: string;
  /** True when a "Continue" affordance should be offered. */
  canContinue: boolean;
}

/** One line per tile in the mode select, straight from the save. */
export function summariseSaves(save: SaveFile): ModeSaveSummary[] {
  const q = activeQuestSlot(save);
  const activeWorld = findBuilderWorld(save, save.builder.activeWorldId);
  const d = save.deathmatch;
  return [
    {
      modeId: ModeId.QUEST,
      headline: q === null ? 'New campaign' : (q.levelId.toUpperCase() || 'New campaign'),
      detail: q === null
        ? 'Start at the beginning'
        : `${questCompletion(q)}% cleared · ${plural(q.deaths, 'death')}`,
      canContinue: q !== null && q.levelId.length > 0,
    },
    {
      modeId: ModeId.BUILDER,
      headline: activeWorld === null
        ? (save.builder.worlds.length > 0 ? plural(save.builder.worlds.length, 'world') : 'New world')
        : activeWorld.name,
      detail: activeWorld === null
        ? 'Full palette, infinite blocks'
        : `${plural(activeWorld.blocksPlaced, 'block')} placed`,
      canContinue: save.builder.worlds.length > 0,
    },
    {
      modeId: ModeId.HORDE,
      headline: save.horde.bestWave > 0 ? `Wave ${save.horde.bestWave}` : 'No runs yet',
      detail: save.horde.runs > 0
        ? `${plural(save.horde.runs, 'run')} · ${plural(save.horde.totalKills, 'kill')}`
        : 'Fortify and hold',
      canContinue: false,
    },
    {
      modeId: ModeId.DEATHMATCH,
      headline: d.matches > 0 ? `${kdr(d).toFixed(2)} K/D` : 'Unranked',
      detail: d.matches > 0
        ? `${plural(d.matches, 'match', 'matches')} · ${winRate(d)}% won`
        : 'Bots are already fighting',
      canContinue: false,
    },
  ];
}
