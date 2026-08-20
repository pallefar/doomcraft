/**
 * DOOMCRAFT — the level format.
 *
 * This is what makes the game expandable: a new episode is a file dropped in
 * `content/levels/`, never a code change. Three representations, one truth:
 *
 *   LevelSource  the JSON a human (or an editor) writes. Geometry is a list of
 *                BRUSHES — boxes, hollow rooms, cylinders, stairs — because
 *                nobody hand-writes 589,824 voxels, and a diff of a brush list
 *                is readable in a pull request.
 *   Level        the compiled runtime object. Brushes have been rasterised into
 *                a LevelVolume: full-height 32x64x32 sections that are byte-for-
 *                byte the same shape as an engine chunk, so a section drops
 *                straight into ServerWorld.chunks and streams to clients over
 *                the EXISTING S2C.CHUNK message. No new chunk protocol.
 *   .dcl         the compact binary: RLE'd sections (reusing protocol.ts's run
 *                coder) plus a fixed-layout header and entity tables.
 *
 *   parseLevelSource -> compileLevel -> encodeLevel -> (network/disk) -> decodeLevel
 *
 * `validateLevel` is not a formality. It runs a real lock-and-key reachability
 * solve — a voxel flood fill over standable cells that respects step-up, drops
 * and closed doors, iterated to a fixpoint as keys and switches come within
 * reach — and it REFUSES a level whose exit cannot be walked to. A level that
 * cannot be finished never reaches a player.
 *
 * No DOM, no three, no node:*. Runs on the main thread, in a Worker and in Node.
 */

import {
  CHUNK_HEIGHT,
  CHUNK_SIZE_MASK,
  CHUNK_SIZE_X,
  CHUNK_SIZE_Z,
  CHUNK_VOLUME,
  WORLD_MAX_CHUNK,
  WORLD_MIN_CHUNK,
  blockToChunk,
  chunkKey,
  chunkKeyCX,
  chunkKeyCZ,
  clamp,
  voxelIndex,
} from './constants.ts';
import {
  BLOCKS,
  BLOCK_COUNT,
  BLOCK_LIQUID,
  BLOCK_SOLID,
  BlockId,
} from './blocks.ts';
import {
  PacketReader,
  PacketWriter,
  EntityType,
  rleDecode,
  rleEncodeInto,
  rleMaxBytes,
} from './protocol.ts';
import { AmmoType, WeaponId } from './weapons.ts';
import { KeyColor, SKILL_COUNT, Skill, hasKey, keyBit } from './modes.ts';

/* ------------------------------------------------------------------------ *
 * Format identity
 * ------------------------------------------------------------------------ */

/** 'D' 'C' 'L' '1' — the first four bytes of every .dcl file. */
export const LEVEL_MAGIC = 0x4c434431; // read big-endian as DCL1
export const LEVEL_MAGIC_BYTES: Uint8Array = new Uint8Array([0x44, 0x43, 0x4c, 0x31]);
/** Bump only for a shape change. `decodeLevel` refuses anything it does not know. */
export const LEVEL_FORMAT_VERSION = 1;
/** The JSON authoring schema version, carried in the source file. */
export const LEVEL_SOURCE_VERSION = 1;

/** Hard ceilings, enforced by the parser and the decoder. */
export const MAX_LEVEL_BRUSHES = 4096;
export const MAX_LEVEL_ENTITIES = 1024;
export const MAX_LEVEL_SECTIONS = 512;
export const MAX_PATROL_POINTS = 32;
export const MAX_SWITCH_TARGETS = 16;
export const MAX_LEVEL_STRING = 4096;
/** Above this many voxels the reachability solve is skipped with a warning. */
export const MAX_REACH_CELLS = 24_000_000;
/** Longest survivable drop the reachability solve will walk off, in blocks. */
export const REACH_MAX_DROP = 16;
/** Cells the flood may cross to reach a switch or a key. */
export const REACH_USE_RADIUS = 4;

/* ------------------------------------------------------------------------ *
 * Enums
 * ------------------------------------------------------------------------ */

export enum BrushKind {
  /** Solid box of `block`. */
  BOX = 0,
  /** Room: shell of `block` with `thickness` walls, interior cleared to air. */
  HOLLOW = 1,
  /** Vertical cylinder inscribed in the box. `thickness` > 0 makes it a tube. */
  CYLINDER = 2,
  /** Rising steps along `axis`, one block per step. */
  STAIRS = 3,
  /** Set the box to air. */
  CLEAR = 4,
}
export const BRUSH_KIND_COUNT = 5;
export const BRUSH_KIND_NAMES: readonly string[] = Object.freeze(['box', 'hollow', 'cylinder', 'stairs', 'clear']);

/** HOLLOW: leave the ceiling out. */
export const BR_OPEN_TOP = 1 << 0;
/** HOLLOW: leave the floor out. */
export const BR_OPEN_BOTTOM = 1 << 1;
export const BR_OPEN_NX = 1 << 2;
export const BR_OPEN_PX = 1 << 3;
export const BR_OPEN_NZ = 1 << 4;
export const BR_OPEN_PZ = 1 << 5;
/** HOLLOW: do not clear the interior — stamp only the shell. */
export const BR_KEEP_INTERIOR = 1 << 6;
/** Write only where the volume currently holds air. Additive detailing. */
export const BR_ONLY_AIR = 1 << 7;

export enum SpawnKind {
  /** Single player and the co-op host. */
  PLAYER = 0,
  /** Extra co-op starts, used in join order. */
  COOP = 1,
  /** Deathmatch starts, if the level is also played as an arena. */
  DEATHMATCH = 2,
  /** Destination of a teleporter. */
  TELEPORT = 3,
}
export const SPAWN_KIND_COUNT = 4;
export const SPAWN_KIND_NAMES: readonly string[] = Object.freeze(['player', 'coop', 'deathmatch', 'teleport']);

export enum TriggerKind {
  /** Awake from the first tick. */
  ALWAYS = 0,
  /** Wakes when it can see a player. */
  SIGHT = 1,
  /** Wakes when a player is within `triggerRadius`. */
  PROXIMITY = 2,
  /** Wakes when the switch named by `triggerId` is thrown. */
  SWITCH = 3,
  /** Wakes when a player enters the secret/sector named by `triggerId`. */
  AREA = 4,
  /** Wakes when the door named by `triggerId` opens — the classic ambush. */
  DOOR = 5,
}
export const TRIGGER_KIND_COUNT = 6;
export const TRIGGER_KIND_NAMES: readonly string[] = Object.freeze([
  'always', 'sight', 'proximity', 'switch', 'area', 'door',
]);

export enum PickupKind {
  /** `variant` 0 = bonus (+1, over-heals), 1 = stimpack, 2 = medikit, 3 = soulsphere. */
  HEALTH = 0,
  /** `variant` 0 = bonus, 1 = green armour, 2 = blue armour. */
  ARMOR = 1,
  /** `variant` = AmmoType. */
  AMMO = 2,
  /** `variant` = WeaponId. */
  WEAPON = 3,
  /** `variant` = KeyColor. */
  KEY = 4,
  /** Doubles every reserve cap and tops the player up. */
  BACKPACK = 5,
}
export const PICKUP_KIND_COUNT = 6;
export const PICKUP_KIND_NAMES: readonly string[] = Object.freeze([
  'health', 'armor', 'ammo', 'weapon', 'key', 'backpack',
]);

/** LevelPickup.flags */
export const PU_COUNTS_AS_ITEM = 1 << 0;
export const PU_IN_SECRET = 1 << 1;
/** Never respawns, even in a mode where pickups normally do. */
export const PU_NO_RESPAWN = 1 << 2;

/** LevelEnemy.flags */
export const EN_AMBUSH = 1 << 0;
/** Patrol runs back and forth instead of looping. */
export const EN_PATROL_PINGPONG = 1 << 1;
/** Counts toward the level's kill total. Cleared for scenery/harmless spawns. */
export const EN_COUNTS_AS_KILL = 1 << 2;

/** LevelDoor.flags */
export const DR_SWITCH_ONLY = 1 << 0;
export const DR_START_OPEN = 1 << 1;
/** Closes again after `stayMs`. */
export const DR_AUTO_CLOSE = 1 << 2;
/** Renders as a secret door — no frame trim, blends into the wall. */
export const DR_SECRET = 1 << 3;

/** LevelSwitch.flags */
export const SW_ONCE = 1 << 0;
/** Looks like ordinary wall — this is how a secret is hidden. */
export const SW_HIDDEN = 1 << 1;

/** LevelExit.flags */
export const EX_SECRET = 1 << 0;
/** Ends the episode rather than loading `nextLevelId`. */
export const EX_ENDS_EPISODE = 1 << 1;

/* ------------------------------------------------------------------------ *
 * Data shapes
 * ------------------------------------------------------------------------ */

export interface LevelMeta {
  id: string;
  name: string;
  episodeId: string;
  episodeName: string;
  episodeIndex: number;
  levelIndex: number;
  author: string;
  description: string;
  /** Doom's par time, seconds. The intermission grades against it. */
  parTimeSec: number;
  /** Key the audio layer looks up. Free-form. */
  musicCue: string;
  /** Packed 0xRRGGBB. */
  skyTop: number;
  skyHorizon: number;
  fogColor: number;
  /** Metres. Fog starts here and is full at fogFar. */
  fogNear: number;
  fogFar: number;
  /** 0..1. Quest levels run dark so demons read bright (docs/MODES.md §1). */
  ambient: number;
  sunLight: number;
  /** Block returned for anything outside the authored sections. */
  outsideBlock: number;
  defaultSkill: number;
}

export interface LevelBrush {
  kind: BrushKind;
  /** Primary BlockId. */
  block: number;
  /** Floor of a HOLLOW room / tread of STAIRS. -1 = same as `block`. */
  block2: number;
  /** Minimum corner, world block coordinates. */
  x: number; y: number; z: number;
  /** Size in blocks, each >= 1. */
  w: number; h: number; d: number;
  /** HOLLOW/CYLINDER wall thickness; STAIRS rise per step. */
  thickness: number;
  /** STAIRS direction: 0 = +x, 1 = -x, 2 = +z, 3 = -z. */
  axis: number;
  /** BR_* bits. */
  flags: number;
}

export interface LevelSpawn {
  kind: SpawnKind;
  x: number; y: number; z: number;
  /** Radians. 0 looks down -Z; see shared/src/math.ts anglesToForward. */
  yaw: number;
  /** Co-op / deathmatch ordering. */
  index: number;
}

export interface LevelEnemy {
  id: string;
  /** EntityType.IMP .. EntityType.LOST_SOUL. */
  type: number;
  x: number; y: number; z: number;
  yaw: number;
  minSkill: number;
  maxSkill: number;
  trigger: TriggerKind;
  triggerRadius: number;
  triggerId: string;
  /** Flattened waypoints [x,y,z, x,y,z, ...]. Empty = holds position. */
  patrol: number[];
  /** EN_* bits. */
  flags: number;
  /** Pickup id spawned where it dies. '' for none. */
  dropId: string;
}

export interface LevelPickup {
  id: string;
  kind: PickupKind;
  variant: number;
  /** Health points, armour points, rounds. 0 = the kind's default. */
  amount: number;
  x: number; y: number; z: number;
  minSkill: number;
  maxSkill: number;
  /** PU_* bits. */
  flags: number;
}

export interface LevelDoor {
  id: string;
  x: number; y: number; z: number;
  w: number; h: number; d: number;
  key: KeyColor;
  /** What the closed door is made of. */
  block: number;
  /** Frame trim block, -1 for none. */
  frameBlock: number;
  openMs: number;
  stayMs: number;
  /** DR_* bits. */
  flags: number;
  lockedMessage: string;
}

export interface LevelSwitch {
  id: string;
  x: number; y: number; z: number;
  /** Face the player must look at (blocks.ts Face), or -1 for any. */
  face: number;
  block: number;
  activeBlock: number;
  key: KeyColor;
  /** Door ids, and the literal id 'exit' to arm the exit. */
  targets: string[];
  /** SW_* bits. */
  flags: number;
  message: string;
}

export interface LevelSecret {
  id: string;
  x: number; y: number; z: number;
  w: number; h: number; d: number;
  message: string;
}

export interface LevelExit {
  x: number; y: number; z: number;
  w: number; h: number; d: number;
  /** Switch id that must be thrown first. '' = live from the start. */
  requiresSwitch: string;
  nextLevelId: string;
  /** EX_* bits. */
  flags: number;
}

/** The JSON authoring document. */
export interface LevelSource {
  sourceVersion: number;
  meta: LevelMeta;
  /** Chunk rect the level occupies, inclusive. */
  minCX: number; minCZ: number; maxCX: number; maxCZ: number;
  brushes: LevelBrush[];
  spawns: LevelSpawn[];
  enemies: LevelEnemy[];
  pickups: LevelPickup[];
  doors: LevelDoor[];
  switches: LevelSwitch[];
  secrets: LevelSecret[];
  exit: LevelExit | null;
}

/** The compiled runtime level. */
export interface Level {
  meta: LevelMeta;
  volume: LevelVolume;
  spawns: LevelSpawn[];
  enemies: LevelEnemy[];
  pickups: LevelPickup[];
  doors: LevelDoor[];
  switches: LevelSwitch[];
  secrets: LevelSecret[];
  exit: LevelExit | null;
}

/* ------------------------------------------------------------------------ *
 * Volume
 * ------------------------------------------------------------------------ */

/**
 * A set of full-height 32x64x32 sections on the engine's chunk grid. A section
 * is byte-identical to a `ServerWorld` chunk, indexed with `voxelIndex`, so
 * loading a level is a memcpy per chunk and streaming one is the existing
 * S2C.CHUNK message.
 */
export class LevelVolume {
  readonly minCX: number;
  readonly minCZ: number;
  readonly maxCX: number;
  readonly maxCZ: number;
  /** Everything outside the rect reads as this. BEDROCK seals the level. */
  readonly outsideBlock: number;
  /** chunkKey -> Uint8Array(CHUNK_VOLUME). */
  readonly sections = new Map<number, Uint8Array>();

  /** Bound so it can be handed to the shared AABB/raycast helpers. */
  readonly solidAt: (x: number, y: number, z: number) => boolean;
  readonly getBlockAt: (x: number, y: number, z: number) => number;

  constructor(minCX: number, minCZ: number, maxCX: number, maxCZ: number, outsideBlock = BlockId.BEDROCK) {
    this.minCX = minCX | 0;
    this.minCZ = minCZ | 0;
    this.maxCX = maxCX | 0;
    this.maxCZ = maxCZ | 0;
    this.outsideBlock = outsideBlock & 0xff;
    this.solidAt = (x, y, z) => BLOCK_SOLID[this.get(x, y, z)] === 1;
    this.getBlockAt = (x, y, z) => this.get(x, y, z);
  }

  get chunkCount(): number { return this.sections.size; }
  get sizeX(): number { return (this.maxCX - this.minCX + 1) * CHUNK_SIZE_X; }
  get sizeZ(): number { return (this.maxCZ - this.minCZ + 1) * CHUNK_SIZE_Z; }
  get minX(): number { return this.minCX * CHUNK_SIZE_X; }
  get minZ(): number { return this.minCZ * CHUNK_SIZE_Z; }
  get maxX(): number { return this.maxCX * CHUNK_SIZE_X + CHUNK_SIZE_X - 1; }
  get maxZ(): number { return this.maxCZ * CHUNK_SIZE_Z + CHUNK_SIZE_Z - 1; }

  containsChunk(cx: number, cz: number): boolean {
    return cx >= this.minCX && cx <= this.maxCX && cz >= this.minCZ && cz <= this.maxCZ;
  }
  contains(x: number, y: number, z: number): boolean {
    return y >= 0 && y < CHUNK_HEIGHT && this.containsChunk(blockToChunk(x), blockToChunk(z));
  }

  section(cx: number, cz: number): Uint8Array | undefined {
    return this.sections.get(chunkKey(cx, cz));
  }

  /** Section for a chunk, allocated (all air) if the rect covers it. */
  ensureSection(cx: number, cz: number): Uint8Array | null {
    if (!this.containsChunk(cx, cz)) return null;
    const key = chunkKey(cx, cz);
    let s = this.sections.get(key);
    if (s === undefined) {
      s = new Uint8Array(CHUNK_VOLUME);
      this.sections.set(key, s);
    }
    return s;
  }

  /** Allocate every section in the rect so iteration is dense. */
  materialise(): void {
    for (let cz = this.minCZ; cz <= this.maxCZ; cz++) {
      for (let cx = this.minCX; cx <= this.maxCX; cx++) this.ensureSection(cx, cz);
    }
  }

  get(x: number, y: number, z: number): number {
    if (y < 0) return this.outsideBlock;
    if (y >= CHUNK_HEIGHT) return BlockId.AIR;
    const cx = blockToChunk(x);
    const cz = blockToChunk(z);
    if (!this.containsChunk(cx, cz)) return this.outsideBlock;
    const s = this.sections.get(chunkKey(cx, cz));
    if (s === undefined) return BlockId.AIR;
    return s[voxelIndex(x & CHUNK_SIZE_MASK, y, z & CHUNK_SIZE_MASK)];
  }

  /** Returns false when the coordinate is outside the authored rect. */
  set(x: number, y: number, z: number, id: number): boolean {
    if (y < 0 || y >= CHUNK_HEIGHT) return false;
    const cx = blockToChunk(x);
    const cz = blockToChunk(z);
    const s = this.ensureSection(cx, cz);
    if (s === null) return false;
    s[voxelIndex(x & CHUNK_SIZE_MASK, y, z & CHUNK_SIZE_MASK)] = id & 0xff;
    return true;
  }

  fillBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number, onlyAir = false): void {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const ay = Math.max(0, Math.min(y0, y1)), by = Math.min(CHUNK_HEIGHT - 1, Math.max(y0, y1));
    const az = Math.min(z0, z1), bz = Math.max(z0, z1);
    for (let y = ay; y <= by; y++) {
      for (let z = az; z <= bz; z++) {
        for (let x = ax; x <= bx; x++) {
          if (onlyAir && this.get(x, y, z) !== BlockId.AIR) continue;
          this.set(x, y, z, id);
        }
      }
    }
  }

  /** Total non-air voxels. Cold path — used by the manifest and by tests. */
  countSolid(): number {
    let n = 0;
    for (const s of this.sections.values()) {
      for (let i = 0; i < s.length; i++) if (s[i] !== 0) n++;
    }
    return n;
  }

  /** Deep copy. */
  clone(): LevelVolume {
    const v = new LevelVolume(this.minCX, this.minCZ, this.maxCX, this.maxCZ, this.outsideBlock);
    for (const [k, s] of this.sections) v.sections.set(k, s.slice());
    return v;
  }
}

/* ------------------------------------------------------------------------ *
 * Defaults / constructors
 * ------------------------------------------------------------------------ */

export function createLevelMeta(): LevelMeta {
  return {
    id: '', name: '', episodeId: '', episodeName: '', episodeIndex: 1, levelIndex: 1,
    author: '', description: '', parTimeSec: 0, musicCue: '',
    skyTop: 0x161320, skyHorizon: 0x241a22, fogColor: 0x14121a,
    fogNear: 22, fogFar: 96, ambient: 0.34, sunLight: 0.5,
    outsideBlock: BlockId.BEDROCK, defaultSkill: Skill.HURT_ME_PLENTY,
  };
}

export function createLevelBrush(): LevelBrush {
  return {
    kind: BrushKind.BOX, block: BlockId.STONE, block2: -1,
    x: 0, y: 0, z: 0, w: 1, h: 1, d: 1,
    thickness: 1, axis: 0, flags: 0,
  };
}

export function createLevelSource(): LevelSource {
  return {
    sourceVersion: LEVEL_SOURCE_VERSION,
    meta: createLevelMeta(),
    minCX: 0, minCZ: 0, maxCX: 0, maxCZ: 0,
    brushes: [], spawns: [], enemies: [], pickups: [], doors: [], switches: [], secrets: [],
    exit: null,
  };
}

/* ------------------------------------------------------------------------ *
 * Name tables — so the JSON reads like a level, not like a memory dump
 * ------------------------------------------------------------------------ */

function buildBlockNameMap(): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < BLOCK_COUNT; i++) {
    const n = BLOCKS[i].name.toLowerCase().replace(/\s+/g, '_');
    m.set(n, i);
    m.set(n.replace(/_/g, ''), i);
  }
  return m;
}
const BLOCK_BY_NAME = /*#__PURE__*/ buildBlockNameMap();

/** 'tech_panel' | 'techpanel' | 19 -> 19. Returns `fallback` for anything else. */
export function blockIdFromName(v: unknown, fallback = BlockId.STONE): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < BLOCK_COUNT) return v;
  if (typeof v === 'string') {
    const id = BLOCK_BY_NAME.get(v.toLowerCase().replace(/\s+/g, '_'));
    if (id !== undefined) return id;
  }
  return fallback;
}
export function blockNameOf(id: number): string {
  return (BLOCKS[id]?.name ?? 'air').toLowerCase().replace(/\s+/g, '_');
}

const ENEMY_BY_NAME: ReadonlyMap<string, number> = new Map<string, number>([
  ['imp', EntityType.IMP],
  ['zombie', EntityType.ZOMBIE],
  ['zombieman', EntityType.ZOMBIE],
  ['sergeant', EntityType.ZOMBIE],
  ['cacodemon', EntityType.CACODEMON],
  ['caco', EntityType.CACODEMON],
  ['baron', EntityType.BARON],
  ['baron_of_hell', EntityType.BARON],
  ['lost_soul', EntityType.LOST_SOUL],
  ['lostsoul', EntityType.LOST_SOUL],
  ['soul', EntityType.LOST_SOUL],
]);
export const ENEMY_TYPE_NAMES: readonly string[] = Object.freeze(['imp', 'zombie', 'cacodemon', 'baron', 'lost_soul']);

export function enemyTypeFromName(v: unknown, fallback = EntityType.IMP): number {
  if (typeof v === 'number' && v >= EntityType.IMP && v <= EntityType.LOST_SOUL) return v | 0;
  if (typeof v === 'string') {
    const t = ENEMY_BY_NAME.get(v.toLowerCase().replace(/[\s-]+/g, '_'));
    if (t !== undefined) return t;
  }
  return fallback;
}
export function enemyTypeName(t: number): string { return ENEMY_TYPE_NAMES[t] ?? 'imp'; }

const WEAPON_BY_NAME: ReadonlyMap<string, number> = new Map<string, number>([
  ['pistol', WeaponId.PISTOL],
  ['shotgun', WeaponId.SHOTGUN],
  ['chaingun', WeaponId.CHAINGUN],
  ['rocket', WeaponId.ROCKET],
  ['rocket_launcher', WeaponId.ROCKET],
  ['plasma', WeaponId.PLASMA],
  ['plasma_rifle', WeaponId.PLASMA],
  ['bfg', WeaponId.BFG],
  ['chainsaw', WeaponId.CHAINSAW],
]);
export const WEAPON_PICKUP_NAMES: readonly string[] = Object.freeze([
  'pistol', 'shotgun', 'chaingun', 'rocket', 'plasma', 'bfg', 'chainsaw',
]);

const AMMO_BY_NAME: ReadonlyMap<string, number> = new Map<string, number>([
  ['bullets', AmmoType.BULLETS], ['clip', AmmoType.BULLETS],
  ['shells', AmmoType.SHELLS], ['shell', AmmoType.SHELLS],
  ['rockets', AmmoType.ROCKETS], ['rocket', AmmoType.ROCKETS],
  ['cells', AmmoType.CELLS], ['cell', AmmoType.CELLS],
]);
export const AMMO_PICKUP_NAMES: readonly string[] = Object.freeze(['none', 'bullets', 'shells', 'rockets', 'cells']);

const KEY_BY_NAME: ReadonlyMap<string, number> = new Map<string, number>([
  ['none', KeyColor.NONE], ['', KeyColor.NONE],
  ['blue', KeyColor.BLUE], ['yellow', KeyColor.YELLOW], ['red', KeyColor.RED],
]);
export const KEY_PICKUP_NAMES: readonly string[] = Object.freeze(['none', 'blue', 'yellow', 'red']);

export function keyColorFromName(v: unknown): KeyColor {
  if (typeof v === 'number' && v >= 0 && v < 4) return v as KeyColor;
  if (typeof v === 'string') {
    const k = KEY_BY_NAME.get(v.toLowerCase());
    if (k !== undefined) return k as KeyColor;
  }
  return KeyColor.NONE;
}

/**
 * Resolve `variant` for a pickup kind from either a number or the obvious name.
 * WEAPON takes a weapon name, AMMO an ammo name, KEY a colour.
 */
export function pickupVariantFromName(kind: PickupKind, v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v | 0;
  if (typeof v !== 'string') return 0;
  const s = v.toLowerCase().replace(/[\s-]+/g, '_');
  switch (kind) {
    case PickupKind.WEAPON: return WEAPON_BY_NAME.get(s) ?? WeaponId.SHOTGUN;
    case PickupKind.AMMO: return AMMO_BY_NAME.get(s) ?? AmmoType.BULLETS;
    case PickupKind.KEY: return keyColorFromName(s);
    case PickupKind.HEALTH: {
      if (s === 'bonus') return 0;
      if (s === 'stimpack' || s === 'small') return 1;
      if (s === 'medikit' || s === 'large' || s === 'big') return 2;
      if (s === 'soulsphere' || s === 'mega') return 3;
      return 1;
    }
    case PickupKind.ARMOR: {
      if (s === 'bonus') return 0;
      if (s === 'green' || s === 'small') return 1;
      if (s === 'blue' || s === 'mega' || s === 'large') return 2;
      return 1;
    }
    default: return 0;
  }
}

/** Name of a pickup's variant, for the manifest and the editor. */
export function pickupVariantName(kind: PickupKind, variant: number): string {
  switch (kind) {
    case PickupKind.WEAPON: return WEAPON_PICKUP_NAMES[variant] ?? String(variant);
    case PickupKind.AMMO: return AMMO_PICKUP_NAMES[variant] ?? String(variant);
    case PickupKind.KEY: return KEY_PICKUP_NAMES[variant] ?? String(variant);
    case PickupKind.HEALTH: return ['bonus', 'stimpack', 'medikit', 'soulsphere'][variant] ?? String(variant);
    case PickupKind.ARMOR: return ['bonus', 'green', 'blue'][variant] ?? String(variant);
    default: return String(variant);
  }
}

/** STAIRS direction names, index = `LevelBrush.axis`. */
export const BRUSH_DIR_NAMES: readonly string[] = Object.freeze(['+x', '-x', '+z', '-z']);

/**
 * Direction lookup for STAIRS. Deliberately NOT `indexOfName`: that helper
 * normalises hyphens to underscores, which would silently turn "-x" into "+x"
 * and build the staircase backwards.
 */
function axisFromName(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3) return v;
  if (typeof v === 'string') {
    const i = BRUSH_DIR_NAMES.indexOf(v.trim().toLowerCase());
    if (i >= 0) return i;
  }
  return fallback;
}

function indexOfName(list: readonly string[], v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < list.length) return v;
  if (typeof v === 'string') {
    const i = list.indexOf(v.toLowerCase().replace(/[\s-]+/g, '_'));
    if (i >= 0) return i;
  }
  return fallback;
}

/* ------------------------------------------------------------------------ *
 * JSON parsing — total, defensive, and lossless for anything it understands
 * ------------------------------------------------------------------------ */

function asRecord(v: unknown): Record<string, unknown> {
  return (v !== null && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
}
function asArray(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function int(v: unknown, fallback: number): number {
  const n = num(v, fallback);
  return Math.round(n) | 0;
}
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.slice(0, MAX_LEVEL_STRING) : fallback;
}
function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function flagBit(rec: Record<string, unknown>, key: string, bit: number, dflt: boolean): number {
  return bool(rec[key], dflt) ? bit : 0;
}
function colour(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return (v | 0) >>> 0 & 0xffffff;
  if (typeof v === 'string') {
    const m = /^#?([0-9a-fA-F]{6})$/.exec(v.trim());
    if (m) return parseInt(m[1], 16);
  }
  return fallback;
}

/** Parse a hand-written or editor-written level document. Never throws. */
export function parseLevelSource(input: unknown): LevelSource {
  const root = asRecord(input);
  const src = createLevelSource();
  src.sourceVersion = int(root.sourceVersion, LEVEL_SOURCE_VERSION);

  /* --- meta ---------------------------------------------------------- */
  const m = asRecord(root.meta ?? root);
  const meta = src.meta;
  meta.id = str(m.id ?? root.id);
  meta.name = str(m.name ?? root.name, meta.id);
  meta.episodeId = str(m.episodeId ?? m.episode, 'e1');
  meta.episodeName = str(m.episodeName, meta.episodeId.toUpperCase());
  meta.episodeIndex = clamp(int(m.episodeIndex, 1), 0, 255);
  meta.levelIndex = clamp(int(m.levelIndex, 1), 0, 255);
  meta.author = str(m.author);
  meta.description = str(m.description);
  meta.parTimeSec = clamp(int(m.parTimeSec ?? m.par, 0), 0, 65535);
  meta.musicCue = str(m.musicCue ?? m.music);
  const pal = asRecord(m.palette);
  meta.skyTop = colour(pal.skyTop ?? m.skyTop, meta.skyTop);
  meta.skyHorizon = colour(pal.skyHorizon ?? m.skyHorizon, meta.skyHorizon);
  meta.fogColor = colour(pal.fog ?? pal.fogColor ?? m.fogColor, meta.fogColor);
  meta.fogNear = num(pal.fogNear ?? m.fogNear, meta.fogNear);
  meta.fogFar = num(pal.fogFar ?? m.fogFar, meta.fogFar);
  meta.ambient = clamp(num(pal.ambient ?? m.ambient, meta.ambient), 0, 1);
  meta.sunLight = clamp(num(pal.sun ?? m.sunLight, meta.sunLight), 0, 1);
  meta.outsideBlock = blockIdFromName(m.outsideBlock, BlockId.BEDROCK);
  meta.defaultSkill = clamp(int(m.defaultSkill, Skill.HURT_ME_PLENTY), 0, SKILL_COUNT - 1);

  /* --- bounds -------------------------------------------------------- */
  const b = asRecord(root.bounds);
  src.minCX = clamp(int(b.minCX ?? root.minCX, 0), WORLD_MIN_CHUNK, WORLD_MAX_CHUNK);
  src.minCZ = clamp(int(b.minCZ ?? root.minCZ, 0), WORLD_MIN_CHUNK, WORLD_MAX_CHUNK);
  src.maxCX = clamp(int(b.maxCX ?? root.maxCX, src.minCX), src.minCX, WORLD_MAX_CHUNK);
  src.maxCZ = clamp(int(b.maxCZ ?? root.maxCZ, src.minCZ), src.minCZ, WORLD_MAX_CHUNK);

  /* --- brushes ------------------------------------------------------- */
  for (const raw of asArray(root.brushes).slice(0, MAX_LEVEL_BRUSHES)) {
    const r = asRecord(raw);
    const br = createLevelBrush();
    br.kind = indexOfName(BRUSH_KIND_NAMES, r.kind, BrushKind.BOX) as BrushKind;
    br.block = blockIdFromName(r.block, BlockId.STONE);
    br.block2 = r.block2 === undefined && r.floor === undefined
      ? -1
      : blockIdFromName(r.block2 ?? r.floor, br.block);
    br.x = int(r.x, 0); br.y = int(r.y, 0); br.z = int(r.z, 0);
    br.w = clamp(int(r.w, 1), 1, 4096);
    br.h = clamp(int(r.h, 1), 1, CHUNK_HEIGHT);
    br.d = clamp(int(r.d, 1), 1, 4096);
    br.thickness = clamp(int(r.thickness ?? r.wall, 1), 0, 64);
    br.axis = axisFromName(r.axis ?? r.dir, 0);
    br.flags = int(r.flags, 0)
      | flagBit(r, 'openTop', BR_OPEN_TOP, false)
      | flagBit(r, 'openBottom', BR_OPEN_BOTTOM, false)
      | flagBit(r, 'openNX', BR_OPEN_NX, false)
      | flagBit(r, 'openPX', BR_OPEN_PX, false)
      | flagBit(r, 'openNZ', BR_OPEN_NZ, false)
      | flagBit(r, 'openPZ', BR_OPEN_PZ, false)
      | flagBit(r, 'keepInterior', BR_KEEP_INTERIOR, false)
      | flagBit(r, 'onlyAir', BR_ONLY_AIR, false);
    src.brushes.push(br);
  }

  /* --- spawns -------------------------------------------------------- */
  for (const raw of asArray(root.spawns).slice(0, MAX_LEVEL_ENTITIES)) {
    const r = asRecord(raw);
    src.spawns.push({
      kind: indexOfName(SPAWN_KIND_NAMES, r.kind, SpawnKind.PLAYER) as SpawnKind,
      x: num(r.x, 0), y: num(r.y, 0), z: num(r.z, 0),
      yaw: num(r.yaw, 0),
      index: clamp(int(r.index, 0), 0, 65535),
    });
  }

  /* --- enemies ------------------------------------------------------- */
  for (const raw of asArray(root.enemies).slice(0, MAX_LEVEL_ENTITIES)) {
    const r = asRecord(raw);
    const patrolIn = asArray(r.patrol).slice(0, MAX_PATROL_POINTS);
    const patrol: number[] = [];
    for (const p of patrolIn) {
      if (Array.isArray(p) && p.length >= 3) {
        patrol.push(num(p[0], 0), num(p[1], 0), num(p[2], 0));
      } else {
        const pr = asRecord(p);
        if (pr.x !== undefined) patrol.push(num(pr.x, 0), num(pr.y, 0), num(pr.z, 0));
      }
    }
    src.enemies.push({
      id: str(r.id),
      type: enemyTypeFromName(r.type ?? r.kind),
      x: num(r.x, 0), y: num(r.y, 0), z: num(r.z, 0), yaw: num(r.yaw, 0),
      minSkill: clamp(int(r.minSkill, 0), 0, SKILL_COUNT - 1),
      maxSkill: clamp(int(r.maxSkill, SKILL_COUNT - 1), 0, SKILL_COUNT - 1),
      trigger: indexOfName(TRIGGER_KIND_NAMES, r.trigger, TriggerKind.SIGHT) as TriggerKind,
      triggerRadius: num(r.triggerRadius ?? r.radius, 12),
      triggerId: str(r.triggerId ?? r.target),
      patrol,
      flags: int(r.flags, 0)
        | flagBit(r, 'ambush', EN_AMBUSH, false)
        | flagBit(r, 'pingpong', EN_PATROL_PINGPONG, false)
        | flagBit(r, 'countsAsKill', EN_COUNTS_AS_KILL, true),
      dropId: str(r.dropId ?? r.drops),
    });
  }

  /* --- pickups ------------------------------------------------------- */
  for (const raw of asArray(root.pickups).slice(0, MAX_LEVEL_ENTITIES)) {
    const r = asRecord(raw);
    const kind = indexOfName(PICKUP_KIND_NAMES, r.kind, PickupKind.HEALTH) as PickupKind;
    src.pickups.push({
      id: str(r.id),
      kind,
      variant: pickupVariantFromName(kind, r.variant ?? r.item ?? r.weapon ?? r.ammo ?? r.color),
      amount: clamp(int(r.amount, 0), 0, 65535),
      x: num(r.x, 0), y: num(r.y, 0), z: num(r.z, 0),
      minSkill: clamp(int(r.minSkill, 0), 0, SKILL_COUNT - 1),
      maxSkill: clamp(int(r.maxSkill, SKILL_COUNT - 1), 0, SKILL_COUNT - 1),
      flags: int(r.flags, 0)
        | flagBit(r, 'countsAsItem', PU_COUNTS_AS_ITEM, kind !== PickupKind.KEY)
        | flagBit(r, 'secret', PU_IN_SECRET, false)
        | flagBit(r, 'noRespawn', PU_NO_RESPAWN, false),
    });
  }

  /* --- doors --------------------------------------------------------- */
  for (const raw of asArray(root.doors).slice(0, MAX_LEVEL_ENTITIES)) {
    const r = asRecord(raw);
    src.doors.push({
      id: str(r.id),
      x: int(r.x, 0), y: int(r.y, 0), z: int(r.z, 0),
      w: clamp(int(r.w, 1), 1, 64), h: clamp(int(r.h, 1), 1, CHUNK_HEIGHT), d: clamp(int(r.d, 1), 1, 64),
      key: keyColorFromName(r.key),
      block: blockIdFromName(r.block, BlockId.METAL),
      frameBlock: r.frameBlock === undefined ? -1 : blockIdFromName(r.frameBlock, BlockId.TECH_PANEL),
      openMs: clamp(int(r.openMs, 700), 0, 65535),
      stayMs: clamp(int(r.stayMs, 0), 0, 65535),
      flags: int(r.flags, 0)
        | flagBit(r, 'switchOnly', DR_SWITCH_ONLY, false)
        | flagBit(r, 'startOpen', DR_START_OPEN, false)
        | flagBit(r, 'autoClose', DR_AUTO_CLOSE, false)
        | flagBit(r, 'secret', DR_SECRET, false),
      lockedMessage: str(r.lockedMessage, ''),
    });
  }

  /* --- switches ------------------------------------------------------ */
  for (const raw of asArray(root.switches).slice(0, MAX_LEVEL_ENTITIES)) {
    const r = asRecord(raw);
    const targets: string[] = [];
    for (const t of asArray(r.targets).slice(0, MAX_SWITCH_TARGETS)) {
      const s = str(t);
      if (s.length > 0) targets.push(s);
    }
    if (targets.length === 0 && typeof r.target === 'string') targets.push(r.target);
    src.switches.push({
      id: str(r.id),
      x: int(r.x, 0), y: int(r.y, 0), z: int(r.z, 0),
      face: r.face === undefined ? -1 : clamp(int(r.face, -1), -1, 5),
      block: blockIdFromName(r.block, BlockId.TECH_PANEL),
      activeBlock: blockIdFromName(r.activeBlock, BlockId.NEON),
      key: keyColorFromName(r.key),
      targets,
      flags: int(r.flags, 0)
        | flagBit(r, 'once', SW_ONCE, true)
        | flagBit(r, 'hidden', SW_HIDDEN, false),
      message: str(r.message),
    });
  }

  /* --- secrets ------------------------------------------------------- */
  for (const raw of asArray(root.secrets).slice(0, MAX_LEVEL_ENTITIES)) {
    const r = asRecord(raw);
    src.secrets.push({
      id: str(r.id),
      x: int(r.x, 0), y: int(r.y, 0), z: int(r.z, 0),
      w: clamp(int(r.w, 1), 1, 256), h: clamp(int(r.h, 1), 1, CHUNK_HEIGHT), d: clamp(int(r.d, 1), 1, 256),
      message: str(r.message, 'A secret is revealed!'),
    });
  }

  /* --- exit ---------------------------------------------------------- */
  if (root.exit !== undefined && root.exit !== null) {
    const r = asRecord(root.exit);
    src.exit = {
      x: int(r.x, 0), y: int(r.y, 0), z: int(r.z, 0),
      w: clamp(int(r.w, 1), 1, 256), h: clamp(int(r.h, 1), 1, CHUNK_HEIGHT), d: clamp(int(r.d, 1), 1, 256),
      requiresSwitch: str(r.requiresSwitch ?? r.switch),
      nextLevelId: str(r.nextLevelId ?? r.next),
      flags: int(r.flags, 0)
        | flagBit(r, 'secret', EX_SECRET, false)
        | flagBit(r, 'endsEpisode', EX_ENDS_EPISODE, false),
    };
  }

  return src;
}

/** Parse a JSON string. Returns null when the text is not valid JSON. */
export function parseLevelJson(text: string): LevelSource | null {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  return parseLevelSource(data);
}

/* ------------------------------------------------------------------------ *
 * Compile — brushes to voxels
 * ------------------------------------------------------------------------ */

function stampBrush(v: LevelVolume, br: LevelBrush): void {
  const onlyAir = (br.flags & BR_ONLY_AIR) !== 0;
  const x0 = br.x, x1 = br.x + br.w - 1;
  const y0 = br.y, y1 = br.y + br.h - 1;
  const z0 = br.z, z1 = br.z + br.d - 1;
  const second = br.block2 < 0 ? br.block : br.block2;

  switch (br.kind) {
    case BrushKind.CLEAR:
      v.fillBox(x0, y0, z0, x1, y1, z1, BlockId.AIR, false);
      return;

    case BrushKind.BOX:
      v.fillBox(x0, y0, z0, x1, y1, z1, br.block, onlyAir);
      return;

    case BrushKind.HOLLOW: {
      const t = Math.max(1, br.thickness);
      // Shell first, then punch the interior out (unless asked not to).
      v.fillBox(x0, y0, z0, x1, y1, z1, br.block, onlyAir);
      const ix0 = x0 + ((br.flags & BR_OPEN_NX) !== 0 ? 0 : t);
      const ix1 = x1 - ((br.flags & BR_OPEN_PX) !== 0 ? 0 : t);
      const iz0 = z0 + ((br.flags & BR_OPEN_NZ) !== 0 ? 0 : t);
      const iz1 = z1 - ((br.flags & BR_OPEN_PZ) !== 0 ? 0 : t);
      const iy0 = y0 + ((br.flags & BR_OPEN_BOTTOM) !== 0 ? 0 : t);
      const iy1 = y1 - ((br.flags & BR_OPEN_TOP) !== 0 ? 0 : t);
      if ((br.flags & BR_KEEP_INTERIOR) === 0 && ix0 <= ix1 && iy0 <= iy1 && iz0 <= iz1) {
        v.fillBox(ix0, iy0, iz0, ix1, iy1, iz1, BlockId.AIR, false);
      }
      // A distinct floor material reads as a different room at a glance.
      if (br.block2 >= 0 && (br.flags & BR_OPEN_BOTTOM) === 0) {
        v.fillBox(x0, y0, z0, x1, y0 + t - 1, z1, second, false);
      }
      return;
    }

    case BrushKind.CYLINDER: {
      const cxf = (x0 + x1) / 2;
      const czf = (z0 + z1) / 2;
      const rx = (x1 - x0 + 1) / 2;
      const rz = (z1 - z0 + 1) / 2;
      const t = br.thickness;
      const innerRx = rx - t;
      const innerRz = rz - t;
      for (let y = Math.max(0, y0); y <= Math.min(CHUNK_HEIGHT - 1, y1); y++) {
        for (let z = z0; z <= z1; z++) {
          for (let x = x0; x <= x1; x++) {
            const dx = (x + 0.5 - cxf) / rx;
            const dz = (z + 0.5 - czf) / rz;
            if (dx * dx + dz * dz > 1) continue;
            if (t > 0 && innerRx > 0 && innerRz > 0) {
              const ix = (x + 0.5 - cxf) / innerRx;
              const iz = (z + 0.5 - czf) / innerRz;
              if (ix * ix + iz * iz <= 1) continue;
            }
            if (onlyAir && v.get(x, y, z) !== BlockId.AIR) continue;
            v.set(x, y, z, br.block);
          }
        }
      }
      return;
    }

    case BrushKind.STAIRS: {
      const rise = Math.max(1, br.thickness);
      const steps = br.axis === 0 || br.axis === 1 ? br.w : br.d;
      for (let s = 0; s < steps; s++) {
        let sx0 = x0, sx1 = x1, sz0 = z0, sz1 = z1;
        switch (br.axis) {
          case 0: sx0 = x0 + s; sx1 = sx0; break;
          case 1: sx0 = x1 - s; sx1 = sx0; break;
          case 2: sz0 = z0 + s; sz1 = sz0; break;
          default: sz0 = z1 - s; sz1 = sz0; break;
        }
        const top = y0 + (s + 1) * rise - 1;
        v.fillBox(sx0, y0, sz0, sx1, Math.min(top, y1), sz1, s === steps - 1 ? second : br.block, onlyAir);
      }
      return;
    }

    default:
      return;
  }
}

/**
 * Rasterise a source document into a runtime level. Brushes are applied in
 * order, later ones overwrite earlier ones, and every door's volume is stamped
 * with its closed block afterwards so a door always physically exists.
 */
export function compileLevel(src: LevelSource): Level {
  const volume = new LevelVolume(src.minCX, src.minCZ, src.maxCX, src.maxCZ, src.meta.outsideBlock);
  volume.materialise();
  for (const br of src.brushes) stampBrush(volume, br);

  for (const d of src.doors) {
    if ((d.flags & DR_START_OPEN) !== 0) {
      volume.fillBox(d.x, d.y, d.z, d.x + d.w - 1, d.y + d.h - 1, d.z + d.d - 1, BlockId.AIR, false);
    } else {
      volume.fillBox(d.x, d.y, d.z, d.x + d.w - 1, d.y + d.h - 1, d.z + d.d - 1, d.block, false);
    }
  }
  for (const s of src.switches) volume.set(s.x, s.y, s.z, s.block);

  return {
    meta: { ...src.meta },
    volume,
    spawns: src.spawns.map((s) => ({ ...s })),
    enemies: src.enemies.map((e) => ({ ...e, patrol: e.patrol.slice() })),
    pickups: src.pickups.map((p) => ({ ...p })),
    doors: src.doors.map((d) => ({ ...d })),
    switches: src.switches.map((s) => ({ ...s, targets: s.targets.slice() })),
    secrets: src.secrets.map((s) => ({ ...s })),
    exit: src.exit === null ? null : { ...src.exit },
  };
}

/* ------------------------------------------------------------------------ *
 * Binary encode / decode
 * ------------------------------------------------------------------------ */

const textEncoder = /*#__PURE__*/ new TextEncoder();
const textDecoder = /*#__PURE__*/ new TextDecoder('utf-8');

/** uint16 length prefix + UTF-8. The base protocol's `str` caps at 255 bytes. */
function putStr(w: PacketWriter, s: string): void {
  const bytes = textEncoder.encode(s.length > MAX_LEVEL_STRING ? s.slice(0, MAX_LEVEL_STRING) : s);
  const n = bytes.length > 65535 ? 65535 : bytes.length;
  w.u16(n);
  if (n > 0) w.raw(bytes, 0, n);
}
function getStr(r: PacketReader): string {
  const n = r.u16();
  if (n === 0) return '';
  return textDecoder.decode(r.rawView(n));
}

/** Section encodings. */
const SEC_UNIFORM = 0;
const SEC_RLE = 1;

/**
 * Serialise a compiled level. Positions and angles go out as f64 so
 * `decodeLevel(encodeLevel(l))` is bit-exact, not merely close.
 */
export function encodeLevel(level: Level, writer?: PacketWriter): Uint8Array {
  const w = writer ?? new PacketWriter(1 << 18);
  w.reset();
  w.raw(LEVEL_MAGIC_BYTES, 0, 4);
  w.u16(LEVEL_FORMAT_VERSION);
  w.u16(0); // reserved flags

  /* --- meta ---------------------------------------------------------- */
  const m = level.meta;
  putStr(w, m.id);
  putStr(w, m.name);
  putStr(w, m.episodeId);
  putStr(w, m.episodeName);
  putStr(w, m.author);
  putStr(w, m.description);
  putStr(w, m.musicCue);
  w.u8(m.episodeIndex & 0xff);
  w.u8(m.levelIndex & 0xff);
  w.u8(m.defaultSkill & 0xff);
  w.u8(m.outsideBlock & 0xff);
  w.u16(m.parTimeSec & 0xffff);
  w.u32(m.skyTop >>> 0);
  w.u32(m.skyHorizon >>> 0);
  w.u32(m.fogColor >>> 0);
  w.f64(m.fogNear);
  w.f64(m.fogFar);
  w.f64(m.ambient);
  w.f64(m.sunLight);

  /* --- volume -------------------------------------------------------- */
  const v = level.volume;
  w.i16(v.minCX); w.i16(v.minCZ); w.i16(v.maxCX); w.i16(v.maxCZ);
  const keys: number[] = [];
  for (const k of v.sections.keys()) keys.push(k);
  keys.sort((a, b) => a - b);
  w.u16(keys.length);
  for (const key of keys) {
    const s = v.sections.get(key) as Uint8Array;
    w.i16(chunkKeyCX(key));
    w.i16(chunkKeyCZ(key));
    let uniform = true;
    const first = s[0];
    for (let i = 1; i < s.length; i++) { if (s[i] !== first) { uniform = false; break; } }
    if (uniform) {
      w.u8(SEC_UNIFORM);
      w.u8(first);
    } else {
      w.u8(SEC_RLE);
      const lenOffset = w.offset;
      w.u32(0);
      w.ensure(rleMaxBytes(s.length));
      const written = rleEncodeInto(s, w.bytes, w.offset);
      w.offset += written;
      w.view.setUint32(lenOffset, written, true);
    }
  }

  /* --- spawns -------------------------------------------------------- */
  w.u16(level.spawns.length);
  for (const s of level.spawns) {
    w.u8(s.kind & 0xff);
    w.f64(s.x); w.f64(s.y); w.f64(s.z);
    w.f64(s.yaw);
    w.u16(s.index & 0xffff);
  }

  /* --- enemies ------------------------------------------------------- */
  w.u16(level.enemies.length);
  for (const e of level.enemies) {
    putStr(w, e.id);
    w.u8(e.type & 0xff);
    w.f64(e.x); w.f64(e.y); w.f64(e.z); w.f64(e.yaw);
    w.u8(e.minSkill & 0xff);
    w.u8(e.maxSkill & 0xff);
    w.u8(e.trigger & 0xff);
    w.f64(e.triggerRadius);
    putStr(w, e.triggerId);
    const pts = (e.patrol.length / 3) | 0;
    w.u16(pts);
    for (let i = 0; i < pts * 3; i++) w.f64(e.patrol[i]);
    w.u16(e.flags & 0xffff);
    putStr(w, e.dropId);
  }

  /* --- pickups ------------------------------------------------------- */
  w.u16(level.pickups.length);
  for (const p of level.pickups) {
    putStr(w, p.id);
    w.u8(p.kind & 0xff);
    w.u8(p.variant & 0xff);
    w.u16(p.amount & 0xffff);
    w.f64(p.x); w.f64(p.y); w.f64(p.z);
    w.u8(p.minSkill & 0xff);
    w.u8(p.maxSkill & 0xff);
    w.u16(p.flags & 0xffff);
  }

  /* --- doors --------------------------------------------------------- */
  w.u16(level.doors.length);
  for (const d of level.doors) {
    putStr(w, d.id);
    w.i32(d.x); w.i32(d.y); w.i32(d.z);
    w.u16(d.w); w.u16(d.h); w.u16(d.d);
    w.u8(d.key & 0xff);
    w.u8(d.block & 0xff);
    w.i16(d.frameBlock);
    w.u16(d.openMs & 0xffff);
    w.u16(d.stayMs & 0xffff);
    w.u16(d.flags & 0xffff);
    putStr(w, d.lockedMessage);
  }

  /* --- switches ------------------------------------------------------ */
  w.u16(level.switches.length);
  for (const s of level.switches) {
    putStr(w, s.id);
    w.i32(s.x); w.i32(s.y); w.i32(s.z);
    w.i8(s.face);
    w.u8(s.block & 0xff);
    w.u8(s.activeBlock & 0xff);
    w.u8(s.key & 0xff);
    w.u16(s.flags & 0xffff);
    w.u16(s.targets.length);
    for (const t of s.targets) putStr(w, t);
    putStr(w, s.message);
  }

  /* --- secrets ------------------------------------------------------- */
  w.u16(level.secrets.length);
  for (const s of level.secrets) {
    putStr(w, s.id);
    w.i32(s.x); w.i32(s.y); w.i32(s.z);
    w.u16(s.w); w.u16(s.h); w.u16(s.d);
    putStr(w, s.message);
  }

  /* --- exit ---------------------------------------------------------- */
  if (level.exit === null) {
    w.u8(0);
  } else {
    w.u8(1);
    const e = level.exit;
    w.i32(e.x); w.i32(e.y); w.i32(e.z);
    w.u16(e.w); w.u16(e.h); w.u16(e.d);
    putStr(w, e.requiresSwitch);
    putStr(w, e.nextLevelId);
    w.u16(e.flags & 0xffff);
  }

  return w.copy();
}

export class LevelDecodeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LevelDecodeError';
    this.code = code;
  }
}

/** Cheap sniff: does this buffer start with the .dcl magic? */
export function isLevelBinary(bytes: Uint8Array): boolean {
  return bytes.length >= 6
    && bytes[0] === 0x44 && bytes[1] === 0x43 && bytes[2] === 0x4c && bytes[3] === 0x31;
}

/** Inverse of `encodeLevel`. Throws `LevelDecodeError` on anything malformed. */
export function decodeLevel(bytes: Uint8Array | ArrayBuffer): Level {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isLevelBinary(u8)) throw new LevelDecodeError('E_MAGIC', 'not a DOOMCRAFT level (bad magic)');
  const r = new PacketReader(u8);
  r.skip(4);
  const version = r.u16();
  if (version !== LEVEL_FORMAT_VERSION) {
    throw new LevelDecodeError('E_VERSION', `level format v${version}, this build reads v${LEVEL_FORMAT_VERSION}`);
  }
  r.u16(); // reserved

  try {
    const meta = createLevelMeta();
    meta.id = getStr(r);
    meta.name = getStr(r);
    meta.episodeId = getStr(r);
    meta.episodeName = getStr(r);
    meta.author = getStr(r);
    meta.description = getStr(r);
    meta.musicCue = getStr(r);
    meta.episodeIndex = r.u8();
    meta.levelIndex = r.u8();
    meta.defaultSkill = r.u8();
    meta.outsideBlock = r.u8();
    meta.parTimeSec = r.u16();
    meta.skyTop = r.u32();
    meta.skyHorizon = r.u32();
    meta.fogColor = r.u32();
    meta.fogNear = r.f64();
    meta.fogFar = r.f64();
    meta.ambient = r.f64();
    meta.sunLight = r.f64();

    const minCX = r.i16(), minCZ = r.i16(), maxCX = r.i16(), maxCZ = r.i16();
    const volume = new LevelVolume(minCX, minCZ, maxCX, maxCZ, meta.outsideBlock);
    const sectionCount = r.u16();
    if (sectionCount > MAX_LEVEL_SECTIONS) {
      throw new LevelDecodeError('E_SECTIONS', `${sectionCount} sections exceeds the ${MAX_LEVEL_SECTIONS} cap`);
    }
    for (let i = 0; i < sectionCount; i++) {
      const cx = r.i16();
      const cz = r.i16();
      const kind = r.u8();
      const dst = new Uint8Array(CHUNK_VOLUME);
      if (kind === SEC_UNIFORM) {
        const id = r.u8();
        if (id !== 0) dst.fill(id);
      } else if (kind === SEC_RLE) {
        const len = r.u32();
        if (len > r.remaining) throw new LevelDecodeError('E_TRUNCATED', 'section run data runs past the end');
        rleDecode(r.bytes, r.offset, len, dst);
        r.skip(len);
      } else {
        throw new LevelDecodeError('E_SECTION_KIND', `unknown section encoding ${kind}`);
      }
      volume.sections.set(chunkKey(cx, cz), dst);
    }

    const spawnCount = r.u16();
    const spawns: LevelSpawn[] = [];
    for (let i = 0; i < spawnCount; i++) {
      spawns.push({
        kind: r.u8() as SpawnKind,
        x: r.f64(), y: r.f64(), z: r.f64(),
        yaw: r.f64(),
        index: r.u16(),
      });
    }

    const enemyCount = r.u16();
    const enemies: LevelEnemy[] = [];
    for (let i = 0; i < enemyCount; i++) {
      const id = getStr(r);
      const type = r.u8();
      const x = r.f64(), y = r.f64(), z = r.f64(), yaw = r.f64();
      const minSkill = r.u8();
      const maxSkill = r.u8();
      const trigger = r.u8() as TriggerKind;
      const triggerRadius = r.f64();
      const triggerId = getStr(r);
      const pts = r.u16();
      const patrol: number[] = [];
      for (let k = 0; k < pts * 3; k++) patrol.push(r.f64());
      const flags = r.u16();
      const dropId = getStr(r);
      enemies.push({ id, type, x, y, z, yaw, minSkill, maxSkill, trigger, triggerRadius, triggerId, patrol, flags, dropId });
    }

    const pickupCount = r.u16();
    const pickups: LevelPickup[] = [];
    for (let i = 0; i < pickupCount; i++) {
      pickups.push({
        id: getStr(r),
        kind: r.u8() as PickupKind,
        variant: r.u8(),
        amount: r.u16(),
        x: r.f64(), y: r.f64(), z: r.f64(),
        minSkill: r.u8(),
        maxSkill: r.u8(),
        flags: r.u16(),
      });
    }

    const doorCount = r.u16();
    const doors: LevelDoor[] = [];
    for (let i = 0; i < doorCount; i++) {
      doors.push({
        id: getStr(r),
        x: r.i32(), y: r.i32(), z: r.i32(),
        w: r.u16(), h: r.u16(), d: r.u16(),
        key: r.u8() as KeyColor,
        block: r.u8(),
        frameBlock: r.i16(),
        openMs: r.u16(),
        stayMs: r.u16(),
        flags: r.u16(),
        lockedMessage: getStr(r),
      });
    }

    const switchCount = r.u16();
    const switches: LevelSwitch[] = [];
    for (let i = 0; i < switchCount; i++) {
      const id = getStr(r);
      const x = r.i32(), y = r.i32(), z = r.i32();
      const face = r.i8();
      const block = r.u8();
      const activeBlock = r.u8();
      const key = r.u8() as KeyColor;
      const flags = r.u16();
      const tn = r.u16();
      const targets: string[] = [];
      for (let k = 0; k < tn; k++) targets.push(getStr(r));
      const message = getStr(r);
      switches.push({ id, x, y, z, face, block, activeBlock, key, targets, flags, message });
    }

    const secretCount = r.u16();
    const secrets: LevelSecret[] = [];
    for (let i = 0; i < secretCount; i++) {
      secrets.push({
        id: getStr(r),
        x: r.i32(), y: r.i32(), z: r.i32(),
        w: r.u16(), h: r.u16(), d: r.u16(),
        message: getStr(r),
      });
    }

    let exit: LevelExit | null = null;
    if (r.u8() === 1) {
      exit = {
        x: r.i32(), y: r.i32(), z: r.i32(),
        w: r.u16(), h: r.u16(), d: r.u16(),
        requiresSwitch: getStr(r),
        nextLevelId: getStr(r),
        flags: r.u16(),
      };
    }

    return { meta, volume, spawns, enemies, pickups, doors, switches, secrets, exit };
  } catch (err) {
    if (err instanceof LevelDecodeError) throw err;
    throw new LevelDecodeError('E_TRUNCATED', `level data ended early: ${String(err)}`);
  }
}

/** FNV-1a over the encoded bytes. The manifest and the CONTEXT packet carry it. */
export function hashLevelBytes(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* ------------------------------------------------------------------------ *
 * Skill filtering and totals
 * ------------------------------------------------------------------------ */

export function enemyAppearsAtSkill(e: LevelEnemy, skill: number): boolean {
  return skill >= e.minSkill && skill <= e.maxSkill;
}
export function pickupAppearsAtSkill(p: LevelPickup, skill: number): boolean {
  return skill >= p.minSkill && skill <= p.maxSkill;
}

export interface LevelTotals {
  enemies: number;
  items: number;
  secrets: number;
}

/** The denominators on Doom's intermission screen, for one skill. */
export function levelTotals(level: Level, skill: number): LevelTotals {
  let enemies = 0;
  for (const e of level.enemies) {
    if (enemyAppearsAtSkill(e, skill) && (e.flags & EN_COUNTS_AS_KILL) !== 0) enemies++;
  }
  let items = 0;
  for (const p of level.pickups) {
    if (pickupAppearsAtSkill(p, skill) && (p.flags & PU_COUNTS_AS_ITEM) !== 0) items++;
  }
  return { enemies, items, secrets: level.secrets.length };
}

/** Player starts for a spawn kind, in `index` order. */
export function spawnsOfKind(level: Level, kind: SpawnKind): LevelSpawn[] {
  return level.spawns.filter((s) => s.kind === kind).sort((a, b) => a.index - b.index);
}

/** The single-player start, falling back to any spawn, then to the volume centre. */
export function primarySpawn(level: Level): LevelSpawn {
  const player = spawnsOfKind(level, SpawnKind.PLAYER);
  if (player.length > 0) return player[0];
  if (level.spawns.length > 0) return level.spawns[0];
  const v = level.volume;
  return {
    kind: SpawnKind.PLAYER,
    x: (v.minX + v.maxX + 1) / 2, y: CHUNK_HEIGHT / 2, z: (v.minZ + v.maxZ + 1) / 2,
    yaw: 0, index: 0,
  };
}

export function findDoor(level: Level, id: string): LevelDoor | null {
  for (const d of level.doors) if (d.id === id) return d;
  return null;
}
export function findSwitch(level: Level, id: string): LevelSwitch | null {
  for (const s of level.switches) if (s.id === id) return s;
  return null;
}

/* ------------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------------ */

export interface LevelIssue {
  code: string;
  message: string;
  /** Entity id the issue is about, when there is one. */
  subject?: string;
}

export interface ReachabilityReport {
  /** False when the solve was skipped because the level is enormous. */
  ran: boolean;
  exitReachable: boolean;
  /** Standable cells the player can reach with every key they can collect. */
  visitedCells: number;
  /** KeyColor values collectable from the spawn. */
  keysFound: number[];
  /** Switch ids the player can throw. */
  switchesFound: string[];
  /** Pickup ids no route reaches. */
  unreachablePickups: string[];
  /** Secret ids no route reaches. */
  unreachableSecrets: string[];
  /** Iterations of the lock-and-key fixpoint. */
  passes: number;
}

export interface LevelValidation {
  ok: boolean;
  errors: LevelIssue[];
  warnings: LevelIssue[];
  reach: ReachabilityReport;
  totals: LevelTotals;
}

function err(list: LevelIssue[], code: string, message: string, subject?: string): void {
  list.push(subject === undefined ? { code, message } : { code, message, subject });
}

/* Grid cell codes for the reachability solve. */
const CELL_SOLID = 0;
const CELL_OPEN = 1;
const CELL_LIQUID = 2;
/** Door cells are `CELL_DOOR_BASE + doorIndex`. */
const CELL_DOOR_BASE = 3;
const MAX_REACH_DOORS = 250;

interface ReachGrid {
  cells: Uint8Array;
  minX: number; minZ: number;
  sizeX: number; sizeZ: number;
  doors: LevelDoor[];
}

function buildReachGrid(level: Level): ReachGrid {
  const v = level.volume;
  const minX = v.minX, minZ = v.minZ;
  const sizeX = v.sizeX, sizeZ = v.sizeZ;
  const cells = new Uint8Array(sizeX * CHUNK_HEIGHT * sizeZ);
  let i = 0;
  for (let z = 0; z < sizeZ; z++) {
    for (let y = 0; y < CHUNK_HEIGHT; y++) {
      for (let x = 0; x < sizeX; x++) {
        const id = v.get(minX + x, y, minZ + z);
        cells[i++] = BLOCK_SOLID[id] === 1 ? CELL_SOLID : (BLOCK_LIQUID[id] === 1 ? CELL_LIQUID : CELL_OPEN);
      }
    }
  }
  const doors = level.doors.slice(0, MAX_REACH_DOORS);
  for (let di = 0; di < doors.length; di++) {
    const d = doors[di];
    for (let y = Math.max(0, d.y); y < Math.min(CHUNK_HEIGHT, d.y + d.h); y++) {
      for (let z = d.z; z < d.z + d.d; z++) {
        for (let x = d.x; x < d.x + d.w; x++) {
          const gx = x - minX, gz = z - minZ;
          if (gx < 0 || gz < 0 || gx >= sizeX || gz >= sizeZ) continue;
          cells[gx + sizeX * (y + CHUNK_HEIGHT * gz)] = CELL_DOOR_BASE + di;
        }
      }
    }
  }
  return { cells, minX, minZ, sizeX, sizeZ, doors };
}

function gridIndex(g: ReachGrid, x: number, y: number, z: number): number {
  const gx = x - g.minX, gz = z - g.minZ;
  if (gx < 0 || gz < 0 || gx >= g.sizeX || gz >= g.sizeZ || y < 0 || y >= CHUNK_HEIGHT) return -1;
  return gx + g.sizeX * (y + CHUNK_HEIGHT * gz);
}

/** True when a body can occupy this cell right now. */
function cellPassable(g: ReachGrid, idx: number, keys: number, thrown: Set<string>): boolean {
  const v = g.cells[idx];
  if (v === CELL_SOLID) return false;
  if (v === CELL_OPEN || v === CELL_LIQUID) return true;
  const d = g.doors[v - CELL_DOOR_BASE];
  if (d === undefined) return false;
  if ((d.flags & DR_START_OPEN) !== 0) return true;
  if ((d.flags & DR_SWITCH_ONLY) !== 0) {
    for (const s of thrown) {
      // A door opens when a thrown switch names it.
      if (s === d.id) return true;
    }
    return false;
  }
  return hasKey(keys, d.key);
}

/**
 * A walkable standing position: two cells of headroom over something solid.
 * Wading counts — a liquid under your feet still holds you up.
 */
function standable(g: ReachGrid, x: number, y: number, z: number, keys: number, thrown: Set<string>): number {
  const i0 = gridIndex(g, x, y, z);
  if (i0 < 0) return -1;
  if (!cellPassable(g, i0, keys, thrown)) return -1;
  const i1 = gridIndex(g, x, y + 1, z);
  if (i1 < 0 || !cellPassable(g, i1, keys, thrown)) return -1;
  if (y === 0) return i0;
  const ib = gridIndex(g, x, y - 1, z);
  if (ib < 0) return i0;                    // outside the rect reads as sealed floor
  if (g.cells[ib] === CELL_LIQUID) return i0;
  return cellPassable(g, ib, keys, thrown) ? -1 : i0;
}

const NEIGHBOUR_DX = [1, -1, 0, 0];
const NEIGHBOUR_DZ = [0, 0, 1, -1];

/**
 * Flood the standable cells from `start` with the keys and switches currently
 * held. Fills `visited` (1 per reachable cell) and returns the count.
 */
function floodStandable(
  g: ReachGrid, visited: Uint8Array, sx: number, sy: number, sz: number,
  keys: number, thrown: Set<string>,
): number {
  visited.fill(0);
  const start = standable(g, sx, sy, sz, keys, thrown);
  if (start < 0) return 0;
  // Int32Array ring queue — no array churn on a 600k-cell flood.
  const queue = new Int32Array(g.cells.length);
  let head = 0, tail = 0;
  visited[start] = 1;
  queue[tail++] = sx; queue[tail++] = sy; queue[tail++] = sz;
  let count = 1;
  const cap = queue.length - 3;
  while (head < tail) {
    const x = queue[head++], y = queue[head++], z = queue[head++];
    for (let n = 0; n < 4; n++) {
      const nx = x + NEIGHBOUR_DX[n];
      const nz = z + NEIGHBOUR_DZ[n];
      // Step up one, walk level, or drop.
      for (let dy = 1; dy >= -REACH_MAX_DROP; dy--) {
        if (dy === 1) {
          // Need headroom over our own head before we can climb.
          const above = gridIndex(g, x, y + 2, z);
          if (above < 0 || !cellPassable(g, above, keys, thrown)) continue;
        }
        const ny = y + dy;
        if (ny < 0 || ny >= CHUNK_HEIGHT) continue;
        const ni = standable(g, nx, ny, nz, keys, thrown);
        if (ni < 0) continue;
        if (visited[ni] === 0) {
          visited[ni] = 1;
          count++;
          if (tail <= cap) { queue[tail++] = nx; queue[tail++] = ny; queue[tail++] = nz; }
        }
        break; // first surface found in this column wins
      }
    }
  }
  return count;
}

/** Any reachable standing cell within `radius` of a block, in x/z and y. */
function nearVisited(g: ReachGrid, visited: Uint8Array, x: number, y: number, z: number, radius: number): boolean {
  const ry = Math.min(radius, 3);
  for (let dy = -ry; dy <= ry; dy++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const i = gridIndex(g, x + dx, y + dy, z + dz);
        if (i >= 0 && visited[i] === 1) return true;
      }
    }
  }
  return false;
}

function boxVisited(
  g: ReachGrid, visited: Uint8Array,
  x: number, y: number, z: number, w: number, h: number, d: number,
): boolean {
  for (let yy = y - 1; yy < y + h + 1; yy++) {
    for (let zz = z; zz < z + d; zz++) {
      for (let xx = x; xx < x + w; xx++) {
        const i = gridIndex(g, xx, yy, zz);
        if (i >= 0 && visited[i] === 1) return true;
      }
    }
  }
  return false;
}

/**
 * Lock-and-key reachability. Flood, pick up every key and throw every switch
 * the flood touched, flood again, repeat until nothing new appears. Then ask
 * whether the exit sector was reached and whether its switch was thrown.
 */
export function solveReachability(level: Level, skill: number): ReachabilityReport {
  const report: ReachabilityReport = {
    ran: false, exitReachable: false, visitedCells: 0,
    keysFound: [], switchesFound: [], unreachablePickups: [], unreachableSecrets: [], passes: 0,
  };
  const v = level.volume;
  const cellCount = v.sizeX * CHUNK_HEIGHT * v.sizeZ;
  if (cellCount <= 0 || cellCount > MAX_REACH_CELLS) return report;
  report.ran = true;

  const g = buildReachGrid(level);
  const visited = new Uint8Array(g.cells.length);
  const spawn = primarySpawn(level);
  const sx = Math.floor(spawn.x);
  const sz = Math.floor(spawn.z);
  let sy = Math.floor(spawn.y);

  let keys = 0;
  const thrown = new Set<string>();
  let lastCount = -1;

  for (let pass = 0; pass < SKILL_COUNT + 4; pass++) {
    report.passes = pass + 1;
    // The author may have written the spawn a hair above the floor; settle it.
    let start = -1;
    for (let dy = 0; dy >= -3 && start < 0; dy--) start = standable(g, sx, sy + dy, sz, keys, thrown);
    for (let dy = 1; dy <= 3 && start < 0; dy++) start = standable(g, sx, sy + dy, sz, keys, thrown);
    if (start < 0) break;
    // Re-derive the settled y so the flood starts from the same cell.
    let settled = sy;
    for (let dy = 0; dy >= -3; dy--) { if (standable(g, sx, sy + dy, sz, keys, thrown) >= 0) { settled = sy + dy; break; } }
    if (standable(g, sx, settled, sz, keys, thrown) < 0) {
      for (let dy = 1; dy <= 3; dy++) { if (standable(g, sx, sy + dy, sz, keys, thrown) >= 0) { settled = sy + dy; break; } }
    }
    sy = settled;

    const count = floodStandable(g, visited, sx, sy, sz, keys, thrown);
    report.visitedCells = count;

    let grew = false;
    for (const p of level.pickups) {
      if (p.kind !== PickupKind.KEY) continue;
      if (!pickupAppearsAtSkill(p, skill)) continue;
      const bit = keyBit(p.variant);
      if (bit === 0 || (keys & bit) !== 0) continue;
      if (nearVisited(g, visited, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), 1)) {
        keys |= bit;
        grew = true;
      }
    }
    for (const s of level.switches) {
      if (thrown.has(s.id)) continue;
      if (!hasKey(keys, s.key)) continue;
      if (!nearVisited(g, visited, s.x, s.y, s.z, REACH_USE_RADIUS)) continue;
      thrown.add(s.id);
      grew = true;
      // Throwing a switch opens the doors it names.
      for (const t of s.targets) thrown.add(t);
    }
    if (!grew && count === lastCount) break;
    lastCount = count;
  }

  report.keysFound = [];
  for (let c = KeyColor.BLUE; c <= KeyColor.RED; c++) if ((keys & keyBit(c)) !== 0) report.keysFound.push(c);
  report.switchesFound = [];
  for (const s of level.switches) if (thrown.has(s.id)) report.switchesFound.push(s.id);

  for (const p of level.pickups) {
    if (!pickupAppearsAtSkill(p, skill)) continue;
    if (!nearVisited(g, visited, Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), 1)) {
      report.unreachablePickups.push(p.id.length > 0 ? p.id : `${PICKUP_KIND_NAMES[p.kind]}@${p.x},${p.y},${p.z}`);
    }
  }
  for (const s of level.secrets) {
    if (!boxVisited(g, visited, s.x, s.y, s.z, s.w, s.h, s.d)) {
      report.unreachableSecrets.push(s.id.length > 0 ? s.id : `${s.x},${s.y},${s.z}`);
    }
  }

  const exit = level.exit;
  if (exit !== null) {
    const inSector = boxVisited(g, visited, exit.x, exit.y, exit.z, exit.w, exit.h, exit.d);
    const armed = exit.requiresSwitch.length === 0 || thrown.has(exit.requiresSwitch);
    report.exitReachable = inSector && armed;
  }
  return report;
}

/**
 * Full validation. `skill` selects which conditional enemies and pickups exist;
 * a level that is only broken on Nightmare should still fail.
 */
export function validateLevel(level: Level, skill: number = Skill.HURT_ME_PLENTY): LevelValidation {
  const errors: LevelIssue[] = [];
  const warnings: LevelIssue[] = [];
  const v = level.volume;

  if (level.meta.id.length === 0) err(errors, 'E_NO_ID', 'the level has no id');
  if (level.meta.name.length === 0) err(warnings, 'W_NO_NAME', 'the level has no display name');
  if (level.meta.parTimeSec <= 0) err(warnings, 'W_NO_PAR', 'par time is zero; the intermission has nothing to grade against');

  if (v.minCX > v.maxCX || v.minCZ > v.maxCZ) {
    err(errors, 'E_BAD_BOUNDS', `chunk rect ${v.minCX},${v.minCZ}..${v.maxCX},${v.maxCZ} is inside out`);
  }
  if (v.minCX < WORLD_MIN_CHUNK || v.maxCX > WORLD_MAX_CHUNK || v.minCZ < WORLD_MIN_CHUNK || v.maxCZ > WORLD_MAX_CHUNK) {
    err(errors, 'E_OUT_OF_WORLD', `chunk rect leaves the ${WORLD_MIN_CHUNK}..${WORLD_MAX_CHUNK} world box`);
  }
  if (v.sections.size === 0) err(errors, 'E_EMPTY', 'the level has no voxel sections');

  /* --- ids ----------------------------------------------------------- */
  const seen = new Set<string>();
  const noteId = (id: string, what: string): void => {
    if (id.length === 0) return;
    if (seen.has(id)) err(errors, 'E_DUP_ID', `duplicate id "${id}" on a ${what}`, id);
    seen.add(id);
  };
  for (const d of level.doors) {
    if (d.id.length === 0) err(errors, 'E_DOOR_NO_ID', 'a door has no id, so no switch can name it');
    noteId(d.id, 'door');
  }
  for (const s of level.switches) {
    if (s.id.length === 0) err(errors, 'E_SWITCH_NO_ID', 'a switch has no id');
    noteId(s.id, 'switch');
  }
  for (const s of level.secrets) noteId(s.id, 'secret');
  for (const e of level.enemies) noteId(e.id, 'enemy');
  for (const p of level.pickups) noteId(p.id, 'pickup');

  /* --- switch wiring -------------------------------------------------- */
  const doorIds = new Set(level.doors.map((d) => d.id));
  for (const s of level.switches) {
    if (s.targets.length === 0) {
      err(warnings, 'W_SWITCH_NO_TARGET', `switch "${s.id}" opens nothing`, s.id);
    }
    for (const t of s.targets) {
      if (t === 'exit') continue;
      if (!doorIds.has(t)) err(errors, 'E_BAD_TARGET', `switch "${s.id}" targets "${t}", which is not a door`, s.id);
    }
    if (!v.contains(s.x, s.y, s.z)) {
      err(errors, 'E_SWITCH_OUTSIDE', `switch "${s.id}" at ${s.x},${s.y},${s.z} is outside the level volume`, s.id);
    }
  }

  /* --- keys ----------------------------------------------------------- */
  const keysPresent = new Set<number>();
  for (const p of level.pickups) {
    if (p.kind === PickupKind.KEY && pickupAppearsAtSkill(p, skill)) keysPresent.add(p.variant);
  }
  for (const d of level.doors) {
    if (d.key !== KeyColor.NONE && !keysPresent.has(d.key) && (d.flags & DR_SWITCH_ONLY) === 0) {
      err(errors, 'E_MISSING_KEY',
        `door "${d.id}" needs the ${KEY_PICKUP_NAMES[d.key]} key but no such key exists at this skill`, d.id);
    }
  }

  /* --- spawns ---------------------------------------------------------- */
  const playerSpawns = spawnsOfKind(level, SpawnKind.PLAYER);
  if (playerSpawns.length === 0) {
    err(errors, 'E_NO_SPAWN', 'the level has no player spawn');
  }
  for (const s of level.spawns) {
    if (!v.contains(Math.floor(s.x), Math.floor(s.y), Math.floor(s.z))) {
      err(errors, 'E_SPAWN_OUTSIDE', `${SPAWN_KIND_NAMES[s.kind]} spawn at ${s.x},${s.y},${s.z} is outside the volume`);
      continue;
    }
    const feet = v.get(Math.floor(s.x), Math.floor(s.y), Math.floor(s.z));
    const head = v.get(Math.floor(s.x), Math.floor(s.y) + 1, Math.floor(s.z));
    if (BLOCK_SOLID[feet] === 1 || BLOCK_SOLID[head] === 1) {
      err(errors, 'E_SPAWN_SOLID', `${SPAWN_KIND_NAMES[s.kind]} spawn at ${s.x},${s.y},${s.z} is inside solid geometry`);
    }
  }

  /* --- entity placement ------------------------------------------------ */
  for (const e of level.enemies) {
    if (!enemyAppearsAtSkill(e, skill)) continue;
    const bx = Math.floor(e.x), by = Math.floor(e.y), bz = Math.floor(e.z);
    if (!v.contains(bx, by, bz)) {
      err(errors, 'E_ENEMY_OUTSIDE', `enemy "${e.id}" at ${e.x},${e.y},${e.z} is outside the volume`, e.id);
    } else if (BLOCK_SOLID[v.get(bx, by, bz)] === 1) {
      err(warnings, 'W_ENEMY_IN_SOLID', `enemy "${e.id}" is embedded in a block`, e.id);
    }
    if (e.trigger === TriggerKind.SWITCH && findSwitch(level, e.triggerId) === null) {
      err(errors, 'E_ENEMY_TRIGGER', `enemy "${e.id}" waits on switch "${e.triggerId}", which does not exist`, e.id);
    }
    if (e.trigger === TriggerKind.DOOR && findDoor(level, e.triggerId) === null) {
      err(errors, 'E_ENEMY_TRIGGER', `enemy "${e.id}" waits on door "${e.triggerId}", which does not exist`, e.id);
    }
  }
  for (const p of level.pickups) {
    if (!pickupAppearsAtSkill(p, skill)) continue;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    if (!v.contains(bx, by, bz)) {
      err(errors, 'E_PICKUP_OUTSIDE', `pickup "${p.id}" at ${p.x},${p.y},${p.z} is outside the volume`, p.id);
    } else if (BLOCK_SOLID[v.get(bx, by, bz)] === 1) {
      err(warnings, 'W_PICKUP_IN_SOLID', `pickup "${p.id}" is embedded in a block`, p.id);
    }
  }

  /* --- the exit --------------------------------------------------------- */
  if (level.exit === null) {
    err(errors, 'E_NO_EXIT', 'the level has no exit');
  } else {
    const e = level.exit;
    if (!v.contains(e.x, e.y, e.z)) {
      err(errors, 'E_EXIT_OUTSIDE', `the exit at ${e.x},${e.y},${e.z} is outside the volume`);
    }
    if (e.requiresSwitch.length > 0 && findSwitch(level, e.requiresSwitch) === null) {
      err(errors, 'E_EXIT_SWITCH', `the exit waits on switch "${e.requiresSwitch}", which does not exist`);
    }
  }

  /* --- reachability ------------------------------------------------------ */
  const reach = solveReachability(level, skill);
  if (!reach.ran) {
    err(warnings, 'W_REACH_SKIPPED', 'the level is too large for the reachability solve; the exit was not verified');
  } else if (level.exit !== null) {
    if (reach.visitedCells === 0) {
      err(errors, 'E_SPAWN_SEALED', 'nothing is walkable from the player spawn');
    }
    if (!reach.exitReachable) {
      err(errors, 'E_EXIT_UNREACHABLE',
        'the exit cannot be reached from the player spawn, even after collecting every key and throwing every switch that is in reach');
    }
  }
  for (const id of reach.unreachableSecrets) {
    err(warnings, 'W_SECRET_UNREACHABLE', `secret "${id}" cannot be entered`, id);
  }
  for (const id of reach.unreachablePickups) {
    err(warnings, 'W_PICKUP_UNREACHABLE', `pickup "${id}" cannot be collected`, id);
  }
  if (level.secrets.length === 0) {
    err(warnings, 'W_NO_SECRETS', 'the level has no secrets; Doom levels always have at least one');
  }

  return { ok: errors.length === 0, errors, warnings, reach, totals: levelTotals(level, skill) };
}

/** One-line summary of a failed validation, for a log line or a 500 body. */
export function formatValidation(id: string, r: LevelValidation): string {
  if (r.ok && r.warnings.length === 0) return `${id}: ok`;
  const parts: string[] = [];
  for (const e of r.errors) parts.push(`ERROR ${e.code}: ${e.message}`);
  for (const w of r.warnings) parts.push(`warn  ${w.code}: ${w.message}`);
  return `${id}:\n  ${parts.join('\n  ')}`;
}

/* ------------------------------------------------------------------------ *
 * Manifest
 * ------------------------------------------------------------------------ */

export interface LevelManifestEntry {
  id: string;
  name: string;
  episodeId: string;
  episodeName: string;
  episodeIndex: number;
  levelIndex: number;
  author: string;
  description: string;
  parTimeSec: number;
  musicCue: string;
  /** Totals at the level's default skill. */
  enemies: number;
  items: number;
  secrets: number;
  chunkCount: number;
  /** Encoded .dcl size in bytes. */
  bytes: number;
  /** FNV-1a of the encoded bytes. */
  contentHash: number;
  valid: boolean;
  /** Non-empty only when `valid` is false. */
  problems: string[];
  nextLevelId: string;
  skyTop: number;
  fogColor: number;
  ambient: number;
}

export interface EpisodeManifest {
  id: string;
  name: string;
  index: number;
  levels: LevelManifestEntry[];
}

export interface LevelManifest {
  version: number;
  generatedMs: number;
  episodes: EpisodeManifest[];
  /** Flat list, same objects as in `episodes`. */
  levels: LevelManifestEntry[];
}

export const LEVEL_MANIFEST_VERSION = 1;

export function manifestEntryFor(level: Level, bytes: Uint8Array, validation: LevelValidation): LevelManifestEntry {
  const t = levelTotals(level, level.meta.defaultSkill);
  return {
    id: level.meta.id,
    name: level.meta.name,
    episodeId: level.meta.episodeId,
    episodeName: level.meta.episodeName,
    episodeIndex: level.meta.episodeIndex,
    levelIndex: level.meta.levelIndex,
    author: level.meta.author,
    description: level.meta.description,
    parTimeSec: level.meta.parTimeSec,
    musicCue: level.meta.musicCue,
    enemies: t.enemies,
    items: t.items,
    secrets: t.secrets,
    chunkCount: level.volume.chunkCount,
    bytes: bytes.length,
    contentHash: hashLevelBytes(bytes),
    valid: validation.ok,
    problems: validation.errors.map((e) => `${e.code}: ${e.message}`),
    nextLevelId: level.exit === null ? '' : level.exit.nextLevelId,
    skyTop: level.meta.skyTop,
    fogColor: level.meta.fogColor,
    ambient: level.meta.ambient,
  };
}

/** Group entries into episodes, both sorted by index then id. */
export function buildManifest(entries: LevelManifestEntry[], nowMs: number): LevelManifest {
  const byEpisode = new Map<string, EpisodeManifest>();
  for (const e of entries) {
    let ep = byEpisode.get(e.episodeId);
    if (ep === undefined) {
      ep = { id: e.episodeId, name: e.episodeName || e.episodeId, index: e.episodeIndex, levels: [] };
      byEpisode.set(e.episodeId, ep);
    }
    if (e.episodeIndex < ep.index) ep.index = e.episodeIndex;
    ep.levels.push(e);
  }
  const episodes = [...byEpisode.values()].sort((a, b) => (a.index - b.index) || a.id.localeCompare(b.id));
  for (const ep of episodes) {
    ep.levels.sort((a, b) => (a.levelIndex - b.levelIndex) || a.id.localeCompare(b.id));
  }
  const levels: LevelManifestEntry[] = [];
  for (const ep of episodes) for (const l of ep.levels) levels.push(l);
  return { version: LEVEL_MANIFEST_VERSION, generatedMs: nowMs, episodes, levels };
}

/* ------------------------------------------------------------------------ *
 * Applying a level to a live voxel world
 * ------------------------------------------------------------------------ */

/**
 * The slice of `ServerWorld` a level loader needs. Declared structurally so
 * this module never imports the server, and so a test can pass a fake.
 */
export interface LevelWorldTarget {
  /** Live, mutable chunk voxels. Mutating in place keeps the world's caches valid. */
  ensureChunk(cx: number, cz: number): Uint8Array;
  /** Topmost-solid-y cache, indexed `(x - minBlockX) + (z - minBlockZ) * WORLD_SIZE_BLOCKS`. */
  readonly surface: Int16Array;
  generation: number;
  editSerial: number;
}

/** Result of stamping a level onto a world. */
export interface LevelApplyResult {
  chunksWritten: number;
  voxelsChanged: number;
}

/**
 * Copy the level's sections into `world`, in place, and rebuild the surface
 * cache for every column touched. Chunks the level does not cover are left
 * exactly as they were, so a level can be stamped into generated terrain (an
 * arena drop) or into an empty world (a sealed Quest map).
 */
export function applyLevelToWorld(
  level: Level, world: LevelWorldTarget,
  minBlockX: number, minBlockZ: number, worldSizeBlocks: number,
): LevelApplyResult {
  const v = level.volume;
  let chunksWritten = 0;
  let voxelsChanged = 0;

  for (const [key, section] of v.sections) {
    const cx = chunkKeyCX(key);
    const cz = chunkKeyCZ(key);
    const dst = world.ensureChunk(cx, cz);
    if (dst.length !== section.length) continue;
    for (let i = 0; i < section.length; i++) if (dst[i] !== section[i]) voxelsChanged++;
    dst.set(section);
    chunksWritten++;

    const baseX = cx * CHUNK_SIZE_X;
    const baseZ = cz * CHUNK_SIZE_Z;
    for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
        let top = -1;
        for (let y = CHUNK_HEIGHT - 1; y >= 0; y--) {
          if (BLOCK_SOLID[section[voxelIndex(lx, y, lz)]] === 1) { top = y; break; }
        }
        const ix = baseX + lx - minBlockX;
        const iz = baseZ + lz - minBlockZ;
        if (ix < 0 || iz < 0 || ix >= worldSizeBlocks || iz >= worldSizeBlocks) continue;
        world.surface[ix + iz * worldSizeBlocks] = top;
      }
    }
  }

  world.generation++;
  world.editSerial += voxelsChanged;
  return { chunksWritten, voxelsChanged };
}

/**
 * Re-derive a `LevelSource`-shaped skeleton from a compiled level. The volume
 * cannot be turned back into brushes, so `brushes` comes back empty — this
 * exists so an editor can round-trip the *entities* of a shipped .dcl and
 * hand-write the geometry it wants to change.
 */
export function levelToSourceSkeleton(level: Level): LevelSource {
  return {
    sourceVersion: LEVEL_SOURCE_VERSION,
    meta: { ...level.meta },
    minCX: level.volume.minCX, minCZ: level.volume.minCZ,
    maxCX: level.volume.maxCX, maxCZ: level.volume.maxCZ,
    brushes: [],
    spawns: level.spawns.map((s) => ({ ...s })),
    enemies: level.enemies.map((e) => ({ ...e, patrol: e.patrol.slice() })),
    pickups: level.pickups.map((p) => ({ ...p })),
    doors: level.doors.map((d) => ({ ...d })),
    switches: level.switches.map((s) => ({ ...s, targets: s.targets.slice() })),
    secrets: level.secrets.map((s) => ({ ...s })),
    exit: level.exit === null ? null : { ...level.exit },
  };
}
