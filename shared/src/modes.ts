/**
 * DOOMCRAFT — the mode layer.
 *
 * One table (`MODES`) describes every rule that differs between Quest, Builder,
 * Horde and Deathmatch, and one small set of binary messages carries the mode
 * choice up to the server and the per-mode state back down.
 *
 * Two hard rules this file exists to enforce:
 *
 *   1. **A mode is data.** Nothing outside this file may branch on "is this
 *      Horde?" to decide whether building is allowed or whether the round has a
 *      timer. It reads the flag off the `ModeDef`. Adding a fifth mode is a row
 *      in `MODES` plus a client factory; it is not a sweep through the sim.
 *   2. **The protocol is extended, never forked.** The messages below are new
 *      ids on the *existing* wire: same `PacketWriter` / `PacketReader`, same
 *      little-endian layout, same one-uint8 message header. Ids start at 16 so
 *      they cannot collide with `C2S` (1..6) or `S2C` (1..8) as those grow.
 *
 * The per-mode state ships as a **snapshot sidecar**: the server writes one
 * `S2C_MODE.STATE` packet immediately before the `S2C.SNAPSHOT` of the same
 * tick, and only when a field actually changed. It is a fixed 40-byte record,
 * so at 20 Hz worst case it costs 800 B/s — under one percent of a snapshot
 * stream — and it never has to be delta-coded.
 *
 * Nothing here imports the DOM, `three`, `ws` or `node:*`. It runs on the main
 * thread, in a Worker and in Node unchanged.
 */

import {
  BOT_FILL_TARGET,
  GameMode,
  MATCH_DURATION_MS,
  MAX_PLAYERS,
  RESPAWN_DELAY_MS,
  SCORE_LIMIT,
  clamp,
} from './constants.ts';
import { PacketReader, PacketWriter } from './protocol.ts';
import { ALL_WEAPON_MASK, STARTING_WEAPON_MASK, WeaponId } from './weapons.ts';

/* ------------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------------ */

/**
 * The four modes. These are NOT `GameMode` from constants.ts — that enum is the
 * old three-way sim switch (deathmatch / horde / sandbox) that `Room` still
 * takes, and it is frozen. `legacyGameMode()` maps one to the other so a
 * `ModeId` can be handed to the existing room constructor without editing it.
 */
export enum ModeId {
  QUEST = 0,
  BUILDER = 1,
  HORDE = 2,
  DEATHMATCH = 3,
}
export const MODE_COUNT = 4;

/** Stable url/save/room-key slug per mode. Never renamed once shipped. */
export const MODE_KEYS: readonly string[] = Object.freeze(['quest', 'builder', 'horde', 'deathmatch']);

/** Parse a slug (url `?mode=`, save file, room key) back to a ModeId. */
export function modeFromKey(key: string): ModeId | -1 {
  const i = MODE_KEYS.indexOf(key.toLowerCase());
  return i < 0 ? -1 : (i as ModeId);
}
export function isModeId(v: number): v is ModeId {
  return Number.isInteger(v) && v >= 0 && v < MODE_COUNT;
}

/* ------------------------------------------------------------------------ *
 * Rule enums
 * ------------------------------------------------------------------------ */

/** Who may hurt whom. */
export enum PvpPolicy {
  /** Player bullets pass through players. Quest, Builder. */
  OFF = 0,
  /** Free-for-all. Deathmatch. */
  FREE_FOR_ALL = 1,
  /** Players cannot hurt each other but monsters can hurt everyone. Horde co-op. */
  COOP = 2,
}

/** Whether and when a player may add blocks to the world. */
export enum BuildPolicy {
  /** No placing at all. Authored geometry only. */
  NONE = 0,
  /** Place from a finite budget, refilled between waves. Horde. */
  PHASED = 1,
  /** Place freely from a limited hotbar, costs nothing. Deathmatch. */
  FREE = 2,
  /** Infinite blocks, full palette, instant place, undo. Builder. */
  CREATIVE = 3,
}

/** Whether and how a player may remove blocks. */
export enum BreakPolicy {
  NONE = 0,
  /** Explosives and the chainsaw carve; the dig tool does not. Quest. */
  WEAPONS_ONLY = 1,
  /** Held-break with progress, plus weapon carving. */
  FULL = 2,
  /** Instant break, any hardness. Builder. */
  INSTANT = 3,
}

export enum RespawnPolicy {
  /** Back on your feet where you fell, no wait. Builder. */
  INSTANT = 0,
  /** RESPAWN_DELAY_MS then a spawn point. Deathmatch. */
  DELAYED = 1,
  /** Dead until the current wave ends; team-mates play on. Horde. */
  NEXT_WAVE = 2,
  /** Restart the level from the last checkpoint / the level start. Quest. */
  CHECKPOINT = 3,
  /** No respawn: the run is over. */
  PERMADEATH = 4,
}

/** Where hostile entities come from. */
export enum EnemyPolicy {
  NONE = 0,
  /** A trickle kept at a target population, spawned anywhere. */
  AMBIENT = 1,
  /** Escalating waves from a director, with a lull between them. */
  WAVES = 2,
  /** Exactly the placements in the level file, woken by triggers. */
  AUTHORED = 3,
}

export enum RoundStructure {
  /** Never ends. Builder. */
  ENDLESS = 0,
  /** A clock plus a score limit. Deathmatch. */
  TIMED = 1,
  /** Build phase, combat phase, repeat, until you die. Horde. */
  WAVES = 2,
  /** One authored level with an intermission at the end. Quest. */
  LEVEL = 3,
}

export enum WorldSource {
  /** Procedural terrain from a seed. */
  GENERATED = 0,
  /** A level file loaded from content/levels. */
  AUTHORED = 1,
  /** A saved world that survives restarts and is edited in place. */
  PERSISTENT = 2,
}

export enum InventoryStyle {
  /** Start with the pistol and the saw; everything else is on the floor. */
  PICKUP = 0,
  /** Spawn holding the full arsenal. */
  LOADOUT = 1,
  /** Full block palette, infinite stacks, no weapons needed. */
  CREATIVE = 2,
}

export enum WinCondition {
  NONE = 0,
  /** Touch the exit sector (after any required switch). Quest. */
  EXIT_REACHED = 1,
  /** First to SCORE_LIMIT frags, or the top score when the clock runs out. */
  SCORE_LIMIT = 2,
  /** Reach `finalWave`; 0 means the run is endless and ends on death. */
  SURVIVE_WAVES = 3,
}

/** Coarse phase a mode's round is in. Carried in the state sidecar. */
export enum ModePhase {
  /** World streaming / level loading. */
  LOADING = 0,
  /** Playable but the clock has not started (no humans yet, or a briefing). */
  WAITING = 1,
  /** Horde's fortify window. */
  BUILD = 2,
  /** The normal playing phase. */
  LIVE = 3,
  /** Quest's kills/items/secrets/par screen, Deathmatch's scoreboard. */
  INTERMISSION = 4,
  /** The run is over and will not resume without a new request. */
  GAME_OVER = 5,
}
export const MODE_PHASE_NAMES: readonly string[] = Object.freeze([
  'loading', 'waiting', 'build', 'live', 'intermission', 'over',
]);

/* ------------------------------------------------------------------------ *
 * Sim system mask
 *
 * Which server systems tick for a mode. `server/src/modes.ts` turns this into
 * the actual per-tick calls; nothing else should ask "what mode is this".
 * ------------------------------------------------------------------------ */

export const SYS_BOTS = 1 << 0;             // fake players that fight like players
export const SYS_MONSTERS = 1 << 1;         // Doom monster AI + melee/ranged attacks
export const SYS_MONSTER_DIRECTOR = 1 << 2; // ambient population top-up
export const SYS_WAVE_DIRECTOR = 1 << 3;    // wave escalation + build-phase timer
export const SYS_PICKUPS = 1 << 4;          // pickup spots + respawn timers
export const SYS_ROUND_TIMER = 1 << 5;      // match clock counts down
export const SYS_SCORE_LIMIT = 1 << 6;      // first to N ends the round
export const SYS_PVP_DAMAGE = 1 << 7;       // player bullets can hit players
export const SYS_BLOCK_ECONOMY = 1 << 8;    // currency + block budget
export const SYS_LEVEL_SCRIPT = 1 << 9;     // doors, switches, secrets, exit
export const SYS_WORLD_PERSISTENCE = 1 << 10; // block deltas written to a store
export const SYS_FALL_DAMAGE = 1 << 11;
export const SYS_HAZARDS = 1 << 12;         // lava, drowning
export const SYS_KILLFEED = 1 << 13;
export const SYS_INTERMISSION = 1 << 14;    // an end-of-round screen exists
export const SYS_TERRAIN_DAMAGE = 1 << 15;  // explosions carve the world

/** Human-readable names, index = bit position. Used by the status endpoint. */
export const SYS_NAMES: readonly string[] = Object.freeze([
  'bots', 'monsters', 'monsterDirector', 'waveDirector', 'pickups', 'roundTimer',
  'scoreLimit', 'pvpDamage', 'blockEconomy', 'levelScript', 'worldPersistence',
  'fallDamage', 'hazards', 'killfeed', 'intermission', 'terrainDamage',
]);

/** Expand a system mask to the list of names it contains. Cold path only. */
export function systemNames(mask: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < SYS_NAMES.length; i++) if ((mask & (1 << i)) !== 0) out.push(SYS_NAMES[i]);
  return out;
}
export function hasSystem(mask: number, bit: number): boolean { return (mask & bit) !== 0; }

/* ------------------------------------------------------------------------ *
 * Mode definition
 * ------------------------------------------------------------------------ */

export interface ModeDef {
  readonly id: ModeId;
  /** Stable slug. Room keys, save slots and `?mode=` all use this. */
  readonly key: string;
  /** Menu title. */
  readonly name: string;
  /** One line under the title on the mode tile. */
  readonly tagline: string;
  /** Two sentences in the tile's expanded state. */
  readonly blurb: string;
  /** What this mode is graded against — straight out of docs/MODES.md. */
  readonly bar: string;
  /** Packed 0xRRGGBB accent used by the tile and the HUD chrome. */
  readonly accent: number;

  /* --- rules ------------------------------------------------------------ */
  readonly pvp: PvpPolicy;
  readonly build: BuildPolicy;
  readonly break: BreakPolicy;
  readonly respawn: RespawnPolicy;
  readonly enemies: EnemyPolicy;
  readonly round: RoundStructure;
  readonly world: WorldSource;
  readonly inventory: InventoryStyle;
  readonly win: WinCondition;
  /** Bitwise OR of the SYS_* constants. */
  readonly systems: number;

  /* --- numbers ---------------------------------------------------------- */
  /** Bodies (humans + bots) the room keeps in the match. 0 disables bots. */
  readonly botFill: number;
  /** Monsters alive at once in the steady state. -1 = the level decides. */
  readonly enemyBudget: number;
  /** Round length in ms. 0 = no clock. */
  readonly durationMs: number;
  /** Frags that end the round. 0 = no score limit. */
  readonly scoreLimit: number;
  /** Milliseconds a corpse waits before it may respawn. */
  readonly respawnDelayMs: number;
  /** Horde's fortify window between waves, ms. 0 when there is no build phase. */
  readonly buildPhaseMs: number;
  /** True when blocks may also be placed while enemies are alive. */
  readonly buildDuringCombat: boolean;
  /** Blocks a player may place per build phase. 0 = unlimited. */
  readonly blockBudget: number;
  /** Wave the run is "won" at. 0 = endless. */
  readonly finalWave: number;
  /** Weapon-ownership bitmask a player spawns with. */
  readonly startWeaponMask: number;
  /** Weapon selected on spawn. */
  readonly startWeapon: number;
  /** Hard cap on bodies in one room. */
  readonly maxPlayers: number;
  /** Players a co-op session of this mode supports. 1 = single player only. */
  readonly coopPlayers: number;

  /* --- ui --------------------------------------------------------------- */
  /** The mode select must show an episode/level list for this mode. */
  readonly needsLevelPicker: boolean;
  /** The mode select must show a saved-world list for this mode. */
  readonly needsWorldPicker: boolean;
  /** The mode select must show a skill/difficulty row. */
  readonly needsSkillPicker: boolean;
  /** Show the "MOST POPULAR" ribbon (exactly one mode carries it). */
  readonly ribbon: string;
  /** Short badge in the corner of the tile, e.g. "1–4 PLAYERS". */
  readonly badge: string;
  /** Renders a flying/no-clip camera toggle. */
  readonly creativeFlight: boolean;
}

function def(d: ModeDef): ModeDef { return Object.freeze(d); }

/**
 * THE TABLE. Indexed by `ModeId`. Every rule the four mode builders need is a
 * field here; if a builder wants to branch on the mode, it is missing a field
 * and the field goes in.
 */
export const MODES: readonly ModeDef[] = Object.freeze([
  def({
    id: ModeId.QUEST,
    key: 'quest',
    name: 'Quest',
    tagline: 'The Doom campaign, in blocks',
    blurb: 'Hand-authored levels with keycards, locked doors, hidden secrets and an exit '
      + 'switch. Dark corridors, bright demons, never quite enough ammo.',
    bar: 'DOOM (1993) E1M1 "Hangar"',
    accent: 0xe03c1c,
    pvp: PvpPolicy.OFF,
    build: BuildPolicy.NONE,
    break: BreakPolicy.WEAPONS_ONLY,
    respawn: RespawnPolicy.CHECKPOINT,
    enemies: EnemyPolicy.AUTHORED,
    round: RoundStructure.LEVEL,
    world: WorldSource.AUTHORED,
    inventory: InventoryStyle.PICKUP,
    win: WinCondition.EXIT_REACHED,
    systems: SYS_MONSTERS | SYS_PICKUPS | SYS_LEVEL_SCRIPT | SYS_FALL_DAMAGE
      | SYS_HAZARDS | SYS_INTERMISSION | SYS_TERRAIN_DAMAGE,
    botFill: 0,
    enemyBudget: -1,
    durationMs: 0,
    scoreLimit: 0,
    respawnDelayMs: RESPAWN_DELAY_MS,
    buildPhaseMs: 0,
    buildDuringCombat: false,
    blockBudget: 0,
    finalWave: 0,
    startWeaponMask: STARTING_WEAPON_MASK,
    startWeapon: WeaponId.PISTOL,
    maxPlayers: 4,
    coopPlayers: 4,
    needsLevelPicker: true,
    needsWorldPicker: false,
    needsSkillPicker: true,
    ribbon: '',
    badge: 'CAMPAIGN · CO-OP',
    creativeFlight: false,
  }),
  def({
    id: ModeId.BUILDER,
    key: 'builder',
    name: 'Builder',
    tagline: 'Creative voxel worlds, shared',
    blurb: 'The whole block palette, infinite stacks, instant place and break, and a flying '
      + 'camera. Worlds persist and friends can join and edit the same one.',
    bar: 'Minecraft Classic',
    accent: 0x4fb84a,
    pvp: PvpPolicy.OFF,
    build: BuildPolicy.CREATIVE,
    break: BreakPolicy.INSTANT,
    respawn: RespawnPolicy.INSTANT,
    enemies: EnemyPolicy.NONE,
    round: RoundStructure.ENDLESS,
    world: WorldSource.PERSISTENT,
    inventory: InventoryStyle.CREATIVE,
    win: WinCondition.NONE,
    systems: SYS_WORLD_PERSISTENCE | SYS_TERRAIN_DAMAGE,
    botFill: 0,
    enemyBudget: 0,
    durationMs: 0,
    scoreLimit: 0,
    respawnDelayMs: 0,
    buildPhaseMs: 0,
    buildDuringCombat: true,
    blockBudget: 0,
    finalWave: 0,
    startWeaponMask: ALL_WEAPON_MASK,
    startWeapon: WeaponId.PISTOL,
    maxPlayers: 16,
    coopPlayers: 16,
    needsLevelPicker: false,
    needsWorldPicker: true,
    needsSkillPicker: false,
    ribbon: '',
    badge: 'PERSISTENT · ONLINE',
    creativeFlight: true,
  }),
  def({
    id: ModeId.HORDE,
    key: 'horde',
    name: 'Horde',
    tagline: 'Fortify, then hold the line',
    blurb: 'Waves of demons attack your position. Between waves you spend kill money on blocks '
      + 'and wall yourself in — then watch a rocket take the wall down again.',
    bar: "DOOM's pressure against our own Builder",
    accent: 0xf0a020,
    pvp: PvpPolicy.COOP,
    build: BuildPolicy.PHASED,
    break: BreakPolicy.FULL,
    respawn: RespawnPolicy.NEXT_WAVE,
    enemies: EnemyPolicy.WAVES,
    round: RoundStructure.WAVES,
    world: WorldSource.GENERATED,
    inventory: InventoryStyle.PICKUP,
    win: WinCondition.SURVIVE_WAVES,
    systems: SYS_MONSTERS | SYS_WAVE_DIRECTOR | SYS_PICKUPS | SYS_BLOCK_ECONOMY
      | SYS_FALL_DAMAGE | SYS_HAZARDS | SYS_KILLFEED | SYS_INTERMISSION | SYS_TERRAIN_DAMAGE,
    botFill: 0,
    enemyBudget: 6,
    durationMs: 0,
    scoreLimit: 0,
    respawnDelayMs: 0,
    buildPhaseMs: 30_000,
    buildDuringCombat: true,
    blockBudget: 120,
    finalWave: 0,
    startWeaponMask: STARTING_WEAPON_MASK | (1 << WeaponId.SHOTGUN),
    startWeapon: WeaponId.SHOTGUN,
    maxPlayers: 4,
    coopPlayers: 4,
    needsLevelPicker: false,
    needsWorldPicker: false,
    needsSkillPicker: true,
    ribbon: 'MOST POPULAR',
    badge: '1–4 PLAYERS',
    creativeFlight: false,
  }),
  def({
    id: ModeId.DEATHMATCH,
    key: 'deathmatch',
    name: 'Deathmatch',
    tagline: 'Online arena, instant start',
    blurb: 'Bots are already fighting when you click, and they hand their slots to humans as '
      + 'they arrive. Rounds, scoreboard, killfeed, weapon pickups, destructible cover.',
    bar: 'voxiom.io Battle Royale',
    accent: 0x50a8f0,
    pvp: PvpPolicy.FREE_FOR_ALL,
    build: BuildPolicy.FREE,
    break: BreakPolicy.FULL,
    respawn: RespawnPolicy.DELAYED,
    enemies: EnemyPolicy.AMBIENT,
    round: RoundStructure.TIMED,
    world: WorldSource.GENERATED,
    inventory: InventoryStyle.PICKUP,
    win: WinCondition.SCORE_LIMIT,
    systems: SYS_BOTS | SYS_MONSTERS | SYS_MONSTER_DIRECTOR | SYS_PICKUPS | SYS_ROUND_TIMER
      | SYS_SCORE_LIMIT | SYS_PVP_DAMAGE | SYS_FALL_DAMAGE | SYS_HAZARDS | SYS_KILLFEED
      | SYS_INTERMISSION | SYS_TERRAIN_DAMAGE,
    botFill: BOT_FILL_TARGET,
    enemyBudget: 3,
    durationMs: MATCH_DURATION_MS,
    scoreLimit: SCORE_LIMIT,
    respawnDelayMs: RESPAWN_DELAY_MS,
    buildPhaseMs: 0,
    buildDuringCombat: true,
    blockBudget: 0,
    finalWave: 0,
    startWeaponMask: STARTING_WEAPON_MASK,
    startWeapon: WeaponId.PISTOL,
    maxPlayers: MAX_PLAYERS,
    coopPlayers: 1,
    needsLevelPicker: false,
    needsWorldPicker: false,
    needsSkillPicker: false,
    ribbon: '',
    badge: 'UP TO 32',
    creativeFlight: false,
  }),
]);

/** Safe lookup. Falls back to Deathmatch for an unknown id. */
export function getMode(id: number): ModeDef {
  return isModeId(id) ? MODES[id] : MODES[ModeId.DEATHMATCH];
}
export function modeName(id: number): string { return getMode(id).name; }
export function modeKey(id: number): string { return getMode(id).key; }

/** Order the tiles appear in the menu — Quest first, it is the headline. */
export const MODE_MENU_ORDER: readonly ModeId[] = Object.freeze([
  ModeId.QUEST, ModeId.HORDE, ModeId.DEATHMATCH, ModeId.BUILDER,
]);

/* --- derived predicates, so nobody re-derives them wrongly ---------------- */

export function allowsPlacing(id: number): boolean { return getMode(id).build !== BuildPolicy.NONE; }
export function allowsBreaking(id: number): boolean { return getMode(id).break !== BreakPolicy.NONE; }
export function allowsPvp(id: number): boolean { return getMode(id).pvp === PvpPolicy.FREE_FOR_ALL; }
export function allowsCoop(id: number): boolean { return getMode(id).coopPlayers > 1; }
export function usesAuthoredLevel(id: number): boolean { return getMode(id).world === WorldSource.AUTHORED; }
export function usesPersistentWorld(id: number): boolean { return getMode(id).world === WorldSource.PERSISTENT; }
export function hasRoundClock(id: number): boolean { return getMode(id).durationMs > 0; }
export function hasBuildPhase(id: number): boolean { return getMode(id).buildPhaseMs > 0; }

/**
 * The mode's equivalent in the frozen three-way `GameMode` enum that `Room`
 * already takes. Quest and Builder both map to SANDBOX (no bots, no clock);
 * the mode layer supplies the real rules on top.
 */
export function legacyGameMode(id: number): GameMode {
  switch (id) {
    case ModeId.HORDE: return GameMode.HORDE;
    case ModeId.DEATHMATCH: return GameMode.DEATHMATCH;
    default: return GameMode.SANDBOX;
  }
}

/* ------------------------------------------------------------------------ *
 * Skill (Doom's five)
 * ------------------------------------------------------------------------ */

export enum Skill {
  TOO_YOUNG_TO_DIE = 0,
  HEY_NOT_TOO_ROUGH = 1,
  HURT_ME_PLENTY = 2,
  ULTRA_VIOLENCE = 3,
  NIGHTMARE = 4,
}
export const SKILL_COUNT = 5;
export const SKILL_NAMES: readonly string[] = Object.freeze([
  "I'm Too Young To Die", 'Hey, Not Too Rough', 'Hurt Me Plenty', 'Ultra-Violence', 'Nightmare!',
]);
export const SKILL_SHORT_NAMES: readonly string[] = Object.freeze(['ITYTD', 'HNTR', 'HMP', 'UV', 'NM']);
export const DEFAULT_SKILL = Skill.HURT_ME_PLENTY;

/** Damage the player takes, scaled by skill. */
export const SKILL_DAMAGE_TAKEN: Float32Array = new Float32Array([0.5, 0.75, 1.0, 1.0, 1.0]);
/** Monster attack cadence multiplier — lower is faster. */
export const SKILL_ENEMY_INTERVAL: Float32Array = new Float32Array([1.6, 1.25, 1.0, 0.8, 0.55]);
/** Ammo and health dropped by pickups, scaled by skill. */
export const SKILL_PICKUP_SCALE: Float32Array = new Float32Array([2.0, 1.5, 1.0, 1.0, 1.0]);
/** Extra monsters over the authored count, as a fraction. */
export const SKILL_ENEMY_BONUS: Float32Array = new Float32Array([0.0, 0.0, 0.0, 0.25, 0.6]);
/** Nightmare only: dead monsters come back. */
export const SKILL_RESPAWN_MONSTERS: Uint8Array = new Uint8Array([0, 0, 0, 0, 1]);

export function clampSkill(v: number): Skill {
  return clamp(Math.round(v) | 0, 0, SKILL_COUNT - 1) as Skill;
}

/* ------------------------------------------------------------------------ *
 * Keycards
 * ------------------------------------------------------------------------ */

export enum KeyColor {
  NONE = 0,
  BLUE = 1,
  YELLOW = 2,
  RED = 3,
}
export const KEY_COUNT = 4;
export const KEY_NAMES: readonly string[] = Object.freeze(['', 'Blue', 'Yellow', 'Red']);
/** Packed 0xRRGGBB per KeyColor, for the HUD key row and the door trim. */
export const KEY_COLORS: Uint32Array = new Uint32Array([0x000000, 0x3a7fe0, 0xe8c832, 0xd83a2a]);

/** Bit for a key in the `keys` mask carried by the state sidecar. */
export function keyBit(color: number): number {
  return color === KeyColor.NONE ? 0 : 1 << (color - 1);
}
export function hasKey(mask: number, color: number): boolean {
  return color === KeyColor.NONE || (mask & keyBit(color)) !== 0;
}
export function keyNameOf(color: number): string { return KEY_NAMES[color] ?? ''; }

/* ------------------------------------------------------------------------ *
 * Protocol extension — message ids
 *
 * These live above 15 so the base protocol can add ids 9..15 without a clash.
 * Both directions still start with a single uint8 id, so `readMessageId()`
 * routes them with no change.
 * ------------------------------------------------------------------------ */

export enum C2S_MODE {
  /** Choose a mode (and its level / world / skill) at or after join. */
  SELECT = 16,
  /** A per-mode verb: use a switch, buy, undo, ready up, restart. */
  ACTION = 17,
}

export enum S2C_MODE {
  /** The snapshot sidecar — fixed-size, sent only when a field changed. */
  STATE = 16,
  /** A one-shot notification: secret found, wave incoming, level complete. */
  EVENT = 17,
  /** Which level/world the room is running, so the client can fetch and theme it. */
  CONTEXT = 18,
}

/** Bump when any of the layouts below change shape. */
export const MODE_PROTOCOL_VERSION = 1;

/** True for any message id this module owns. Lets a dispatcher fall through. */
export function isModeMessage(id: number): boolean { return id >= 16 && id <= 18; }

/* --- ModeSelect flags ----------------------------------------------------- */

/** Join a friend's session rather than opening a fresh one. */
export const MSF_JOIN_EXISTING = 1 << 0;
/** Co-op Quest / shared Builder world rather than solo. */
export const MSF_COOP = 1 << 1;
/** Do not fill the room with bots even if the mode normally would. */
export const MSF_NO_BOTS = 1 << 2;
/** Continue a saved run instead of starting the level from scratch. */
export const MSF_CONTINUE = 1 << 3;
/** Create the world/level fresh, discarding any saved deltas. */
export const MSF_FRESH = 1 << 4;

/* --- ModeState flags ------------------------------------------------------ */

export const MST_PAUSED = 1 << 0;
/** The local player has finished the objective (touched the exit). */
export const MST_LOCAL_FINISHED = 1 << 1;
/** Every objective is done; the intermission is next. */
export const MST_OBJECTIVE_DONE = 1 << 2;
/** The run/round is lost. */
export const MST_FAILED = 1 << 3;
/** Placing blocks is legal right now. */
export const MST_CAN_BUILD = 1 << 4;
/** A wave is spawning; the build window has closed. */
export const MST_WAVE_ACTIVE = 1 << 5;
/** The exit switch has been thrown and the exit is live. */
export const MST_EXIT_OPEN = 1 << 6;
/** Nightmare: killed monsters come back. */
export const MST_MONSTERS_RESPAWN = 1 << 7;

/* ------------------------------------------------------------------------ *
 * C2S_MODE.SELECT
 * ------------------------------------------------------------------------ */

export interface ModeSelectMessage {
  modeId: ModeId;
  skill: Skill;
  flags: number;
  /** 0 asks the server to choose. */
  seed: number;
  /** Level id for Quest, '' otherwise. */
  levelId: string;
  /** Saved-world id for Builder, '' otherwise. */
  worldId: string;
}

/** Longest id string accepted on the wire and on disk. */
export const MAX_CONTENT_ID_LENGTH = 48;
/** Ids are lowercase slugs. Anything else is refused — this is also the guard
 *  that stops a level id being used as a filesystem path. */
export const CONTENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export function isContentId(v: string): boolean {
  return v.length === 0 || (v.length <= MAX_CONTENT_ID_LENGTH && CONTENT_ID_PATTERN.test(v));
}
/** Lowercase, strip anything illegal, truncate. Returns '' when nothing survives. */
export function sanitiseContentId(v: string): string {
  const s = v.toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[_-]+/, '').slice(0, MAX_CONTENT_ID_LENGTH);
  return CONTENT_ID_PATTERN.test(s) ? s : '';
}

export function createModeSelectMessage(): ModeSelectMessage {
  return {
    modeId: ModeId.DEATHMATCH, skill: DEFAULT_SKILL, flags: 0, seed: 0,
    levelId: '', worldId: '',
  };
}

export function encodeModeSelect(w: PacketWriter, m: ModeSelectMessage): PacketWriter {
  w.reset();
  w.u8(C2S_MODE.SELECT);
  w.u8(MODE_PROTOCOL_VERSION);
  w.u8(m.modeId & 0xff);
  w.u8(m.skill & 0xff);
  w.u16(m.flags & 0xffff);
  w.u32(m.seed >>> 0);
  w.str(m.levelId, MAX_CONTENT_ID_LENGTH);
  w.str(m.worldId, MAX_CONTENT_ID_LENGTH);
  return w;
}

/** Decode and sanitise in one step: the result is always safe to act on. */
export function decodeModeSelect(r: PacketReader, out: ModeSelectMessage): ModeSelectMessage {
  r.u8();
  r.u8(); // MODE_PROTOCOL_VERSION — reserved for a future shape change
  const raw = r.u8();
  out.modeId = isModeId(raw) ? raw : ModeId.DEATHMATCH;
  out.skill = clampSkill(r.u8());
  out.flags = r.u16();
  out.seed = r.u32();
  out.levelId = sanitiseContentId(r.str());
  out.worldId = sanitiseContentId(r.str());
  return out;
}

/* ------------------------------------------------------------------------ *
 * C2S_MODE.ACTION
 * ------------------------------------------------------------------------ */

export enum ModeAction {
  /** Press the block the player is looking at: switch, door, lever. */
  USE = 0,
  /** Ready up / skip the build phase early. */
  READY = 1,
  /** Buy from the Horde shop. `a` = item id, `b` = quantity. */
  BUY = 2,
  /** Undo the caller's own last placement. Builder. */
  UNDO = 3,
  /** Redo. Builder. */
  REDO = 4,
  /** Advance past the intermission to the next level. Quest. */
  NEXT_LEVEL = 5,
  /** Restart the current level from the top. Quest. */
  RESTART = 6,
  /** Toggle the creative no-clip camera. Builder. */
  TOGGLE_FLIGHT = 7,
  /** Change skill mid-run (allowed only from the intermission). */
  SET_SKILL = 8,
  /** Teleport to a saved spot. Builder. `a` = bookmark index. */
  WARP = 9,
}
export const MODE_ACTION_COUNT = 10;

export interface ModeActionMessage {
  action: ModeAction;
  /** Generic small operands; meaning is per-action, documented above. */
  a: number;
  b: number;
  /** Target block, when the action has one. */
  x: number;
  y: number;
  z: number;
  /** Client sequence, echoed back in the state sidecar's `ackActionSeq`. */
  seq: number;
}
export function createModeActionMessage(): ModeActionMessage {
  return { action: ModeAction.USE, a: 0, b: 0, x: 0, y: 0, z: 0, seq: 0 };
}

export function encodeModeAction(w: PacketWriter, m: ModeActionMessage): PacketWriter {
  w.reset();
  w.u8(C2S_MODE.ACTION);
  w.u8(m.action & 0xff);
  w.u16(m.a & 0xffff);
  w.u16(m.b & 0xffff);
  w.i16(m.x | 0);
  w.u8(m.y & 0xff);
  w.i16(m.z | 0);
  w.u32(m.seq >>> 0);
  return w;
}
export function decodeModeAction(r: PacketReader, out: ModeActionMessage): ModeActionMessage {
  r.u8();
  const a = r.u8();
  out.action = a < MODE_ACTION_COUNT ? a : ModeAction.USE;
  out.a = r.u16();
  out.b = r.u16();
  out.x = r.i16();
  out.y = r.u8();
  out.z = r.i16();
  out.seq = r.u32();
  return out;
}

/* ------------------------------------------------------------------------ *
 * S2C_MODE.STATE — the snapshot sidecar
 * ------------------------------------------------------------------------ */

/**
 * Wire size of one state record, in bytes, message-id byte included.
 * `level.test.ts` asserts the encoder actually writes exactly this many.
 */
export const MODE_STATE_BYTES = 40;

/**
 * Per-mode state, one flat record so it never allocates and never needs delta
 * coding. Field meanings are per mode:
 *
 * | field       | Quest                  | Builder        | Horde              | Deathmatch      |
 * |-------------|------------------------|----------------|--------------------|-----------------|
 * | `phase`     | live / intermission    | always live    | build / live       | waiting / live  |
 * | `phaseMsLeft`| 0                     | 0              | build window left  | round clock     |
 * | `index`     | level index in episode | 0              | wave number        | round number    |
 * | `score`     | 0                      | blocks placed  | currency           | leader's frags  |
 * | `a`/`aTotal`| kills / total kills    | 0              | wave kills / total | frags / limit   |
 * | `b`/`bTotal`| items / total items    | 0              | 0                  | 0               |
 * | `c`/`cTotal`| secrets / total        | 0              | 0                  | 0               |
 * | `budget`    | 0                      | 0              | blocks left        | 0               |
 * | `keys`      | keycard mask           | 0              | 0                  | 0               |
 */
export class ModeStateBuffer {
  modeId: ModeId = ModeId.DEATHMATCH;
  phase: ModePhase = ModePhase.LOADING;
  skill: Skill = DEFAULT_SKILL;
  flags = 0;
  /** Milliseconds left in the current phase. 0 when the phase has no clock. */
  phaseMsLeft = 0;
  /** Milliseconds the run/level/round has been going. */
  elapsedMs = 0;
  /** Level index, wave number or round number — see the table above. */
  index = 0;
  /** Currency, blocks placed, or the leading score. */
  score = 0;
  a = 0; aTotal = 0;
  b = 0; bTotal = 0;
  c = 0; cTotal = 0;
  /** Blocks the local player may still place this phase. */
  budget = 0;
  /** Keycard bitmask (see `keyBit`). */
  keys = 0;
  /** Lives / downs remaining. 255 = unlimited. */
  lives = 255;
  /** Last `ModeActionMessage.seq` from this client the server acted on. */
  ackActionSeq = 0;

  reset(): void {
    this.modeId = ModeId.DEATHMATCH;
    this.phase = ModePhase.LOADING;
    this.skill = DEFAULT_SKILL;
    this.flags = 0;
    this.phaseMsLeft = 0;
    this.elapsedMs = 0;
    this.index = 0;
    this.score = 0;
    this.a = 0; this.aTotal = 0;
    this.b = 0; this.bTotal = 0;
    this.c = 0; this.cTotal = 0;
    this.budget = 0;
    this.keys = 0;
    this.lives = 255;
    this.ackActionSeq = 0;
  }

  copyFrom(o: ModeStateBuffer): void {
    this.modeId = o.modeId;
    this.phase = o.phase;
    this.skill = o.skill;
    this.flags = o.flags;
    this.phaseMsLeft = o.phaseMsLeft;
    this.elapsedMs = o.elapsedMs;
    this.index = o.index;
    this.score = o.score;
    this.a = o.a; this.aTotal = o.aTotal;
    this.b = o.b; this.bTotal = o.bTotal;
    this.c = o.c; this.cTotal = o.cTotal;
    this.budget = o.budget;
    this.keys = o.keys;
    this.lives = o.lives;
    this.ackActionSeq = o.ackActionSeq;
  }
}

/**
 * True when anything the wire carries differs, AFTER quantisation. `elapsedMs`
 * and `phaseMsLeft` are compared at 100 ms granularity so a clock ticking down
 * does not force a packet every single tick.
 */
export function modeStateChanged(a: ModeStateBuffer, b: ModeStateBuffer): boolean {
  return a.modeId !== b.modeId
    || a.phase !== b.phase
    || a.skill !== b.skill
    || a.flags !== b.flags
    || ((a.phaseMsLeft / 100) | 0) !== ((b.phaseMsLeft / 100) | 0)
    || ((a.elapsedMs / 100) | 0) !== ((b.elapsedMs / 100) | 0)
    || a.index !== b.index
    || a.score !== b.score
    || a.a !== b.a || a.aTotal !== b.aTotal
    || a.b !== b.b || a.bTotal !== b.bTotal
    || a.c !== b.c || a.cTotal !== b.cTotal
    || a.budget !== b.budget
    || a.keys !== b.keys
    || a.lives !== b.lives
    || a.ackActionSeq !== b.ackActionSeq;
}

function u16(v: number): number { return v < 0 ? 0 : v > 65535 ? 65535 : v | 0; }
function u32(v: number): number { return v < 0 ? 0 : v > 4294967295 ? 4294967295 : v >>> 0; }

export function encodeModeState(w: PacketWriter, s: ModeStateBuffer): PacketWriter {
  w.reset();
  w.u8(S2C_MODE.STATE);
  w.u8(s.modeId & 0xff);
  w.u8(s.phase & 0xff);
  w.u8(s.skill & 0xff);
  w.u16(s.flags & 0xffff);
  w.u32(u32(s.phaseMsLeft));
  w.u32(u32(s.elapsedMs));
  w.u16(u16(s.index));
  w.u32(u32(s.score));
  w.u16(u16(s.a)); w.u16(u16(s.aTotal));
  w.u16(u16(s.b)); w.u16(u16(s.bTotal));
  w.u16(u16(s.c)); w.u16(u16(s.cTotal));
  w.u16(u16(s.budget));
  w.u8(s.keys & 0xff);
  w.u8(s.lives & 0xff);
  w.u32(u32(s.ackActionSeq));
  return w;
}

export function decodeModeState(r: PacketReader, out: ModeStateBuffer): ModeStateBuffer {
  r.u8();
  const m = r.u8();
  out.modeId = isModeId(m) ? m : ModeId.DEATHMATCH;
  out.phase = r.u8() as ModePhase;
  out.skill = clampSkill(r.u8());
  out.flags = r.u16();
  out.phaseMsLeft = r.u32();
  out.elapsedMs = r.u32();
  out.index = r.u16();
  out.score = r.u32();
  out.a = r.u16(); out.aTotal = r.u16();
  out.b = r.u16(); out.bTotal = r.u16();
  out.c = r.u16(); out.cTotal = r.u16();
  out.budget = r.u16();
  out.keys = r.u8();
  out.lives = r.u8();
  out.ackActionSeq = r.u32();
  return out;
}

/* ------------------------------------------------------------------------ *
 * S2C_MODE.EVENT
 * ------------------------------------------------------------------------ */

export enum ModeEventKind {
  SECRET_FOUND = 0,
  KEY_TAKEN = 1,
  /** Tried a locked door without the key. `a` = KeyColor. */
  DOOR_LOCKED = 2,
  DOOR_OPENED = 3,
  SWITCH_USED = 4,
  /** `a` = wave number, `b` = monsters in it. */
  WAVE_INCOMING = 5,
  WAVE_CLEARED = 6,
  /** Build window opened. `a` = seconds. */
  BUILD_PHASE = 7,
  /** Objective complete. `a` = kills %, `b` = items %, `c` = secrets %. */
  LEVEL_COMPLETE = 8,
  LEVEL_FAILED = 9,
  /** Currency changed. `a` = delta, `b` = reason. */
  PAYOUT = 10,
  /** Free-text objective / tutorial line. */
  OBJECTIVE = 11,
  /** A player picked up a weapon the whole room should hear about. */
  WEAPON_TAKEN = 12,
}
export const MODE_EVENT_KIND_COUNT = 13;
export const MAX_MODE_EVENT_TEXT = 96;

export interface ModeEventMessage {
  kind: ModeEventKind;
  /** Player the event is about, or 0 for the room. */
  playerId: number;
  a: number;
  b: number;
  c: number;
  text: string;
}
export function createModeEventMessage(): ModeEventMessage {
  return { kind: ModeEventKind.OBJECTIVE, playerId: 0, a: 0, b: 0, c: 0, text: '' };
}

export function encodeModeEvent(w: PacketWriter, e: ModeEventMessage): PacketWriter {
  w.reset();
  w.u8(S2C_MODE.EVENT);
  w.u8(e.kind & 0xff);
  w.u16(e.playerId & 0xffff);
  w.u16(u16(e.a));
  w.u16(u16(e.b));
  w.u16(u16(e.c));
  w.str(e.text, MAX_MODE_EVENT_TEXT);
  return w;
}
export function decodeModeEvent(r: PacketReader, out: ModeEventMessage): ModeEventMessage {
  r.u8();
  const k = r.u8();
  out.kind = k < MODE_EVENT_KIND_COUNT ? k : ModeEventKind.OBJECTIVE;
  out.playerId = r.u16();
  out.a = r.u16();
  out.b = r.u16();
  out.c = r.u16();
  out.text = r.str();
  return out;
}

/* ------------------------------------------------------------------------ *
 * S2C_MODE.CONTEXT
 *
 * Sent once at join and again whenever the room changes level or world, so the
 * client knows which content to fetch and how to theme the sky, the fog and the
 * ambient light before the first chunk lands.
 * ------------------------------------------------------------------------ */

export interface ModeContextMessage {
  modeId: ModeId;
  skill: Skill;
  levelId: string;
  worldId: string;
  /** Display name of the level/world. */
  title: string;
  /** FNV-1a of the encoded level bytes, so a client cache can be trusted. */
  contentHash: number;
  /** Par time in seconds, 0 when the mode has none. */
  parTimeSec: number;
  /** Packed 0xRRGGBB. */
  skyColor: number;
  fogColor: number;
  /** 0..1, sent as a byte. */
  ambient: number;
  /** Players the room will accept. */
  maxPlayers: number;
}
export function createModeContextMessage(): ModeContextMessage {
  return {
    modeId: ModeId.DEATHMATCH, skill: DEFAULT_SKILL, levelId: '', worldId: '', title: '',
    contentHash: 0, parTimeSec: 0, skyColor: 0x6ea9e0, fogColor: 0x8bb6dd, ambient: 0.46,
    maxPlayers: MAX_PLAYERS,
  };
}

export function encodeModeContext(w: PacketWriter, c: ModeContextMessage): PacketWriter {
  w.reset();
  w.u8(S2C_MODE.CONTEXT);
  w.u8(c.modeId & 0xff);
  w.u8(c.skill & 0xff);
  w.str(c.levelId, MAX_CONTENT_ID_LENGTH);
  w.str(c.worldId, MAX_CONTENT_ID_LENGTH);
  w.str(c.title, 64);
  w.u32(c.contentHash >>> 0);
  w.u16(u16(c.parTimeSec));
  w.u32(c.skyColor >>> 0);
  w.u32(c.fogColor >>> 0);
  w.u8(clamp(Math.round(c.ambient * 255), 0, 255));
  w.u8(clamp(c.maxPlayers | 0, 1, 255));
  return w;
}
export function decodeModeContext(r: PacketReader, out: ModeContextMessage): ModeContextMessage {
  r.u8();
  const m = r.u8();
  out.modeId = isModeId(m) ? m : ModeId.DEATHMATCH;
  out.skill = clampSkill(r.u8());
  out.levelId = sanitiseContentId(r.str());
  out.worldId = sanitiseContentId(r.str());
  out.title = r.str();
  out.contentHash = r.u32();
  out.parTimeSec = r.u16();
  out.skyColor = r.u32();
  out.fogColor = r.u32();
  out.ambient = r.u8() / 255;
  out.maxPlayers = r.u8();
  return out;
}

/* ------------------------------------------------------------------------ *
 * Room keys
 *
 * One string that identifies "the room a request should land in". Deathmatch
 * and Horde share instances; Quest and Builder are keyed by their content so
 * two people picking the same level end up in the same session.
 * ------------------------------------------------------------------------ */

export function roomKeyFor(m: ModeSelectMessage): string {
  const mode = MODE_KEYS[m.modeId] ?? 'deathmatch';
  switch (m.modeId) {
    case ModeId.QUEST:
      return `${mode}:${m.levelId || 'e1m1-hangar'}:${m.skill}`;
    case ModeId.BUILDER:
      return `${mode}:${m.worldId || 'default'}`;
    default:
      return mode;
  }
}

/* ------------------------------------------------------------------------ *
 * Intermission — Doom's kills / items / secrets / time panel
 * ------------------------------------------------------------------------ */

export interface IntermissionStats {
  levelId: string;
  levelName: string;
  kills: number;
  killsTotal: number;
  items: number;
  itemsTotal: number;
  secrets: number;
  secretsTotal: number;
  timeSec: number;
  parSec: number;
  /** True when this run beat the previously saved best. */
  newRecord: boolean;
}

export function createIntermissionStats(): IntermissionStats {
  return {
    levelId: '', levelName: '', kills: 0, killsTotal: 0, items: 0, itemsTotal: 0,
    secrets: 0, secretsTotal: 0, timeSec: 0, parSec: 0, newRecord: false,
  };
}

/** Integer percentage, 100 when the total is zero (nothing to miss). */
export function percentOf(got: number, total: number): number {
  if (total <= 0) return 100;
  const p = Math.round((got / total) * 100);
  return p < 0 ? 0 : p > 100 ? 100 : p;
}

/** `M:SS` for the intermission clock. */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = (s / 60) | 0;
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/** Fill an IntermissionStats from a finished state record. */
export function intermissionFromState(
  s: ModeStateBuffer, levelId: string, levelName: string, parSec: number, newRecord: boolean,
): IntermissionStats {
  return {
    levelId,
    levelName,
    kills: s.a, killsTotal: s.aTotal,
    items: s.b, itemsTotal: s.bTotal,
    secrets: s.c, secretsTotal: s.cTotal,
    timeSec: Math.round(s.elapsedMs / 1000),
    parSec,
    newRecord,
  };
}
