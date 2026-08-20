/**
 * DOOMCRAFT — persistent multiplayer Builder worlds.
 *
 * The bar has nothing here at all. `classic.minecraft.net` generates one world
 * when the page loads, and when the tab closes it is gone: no list, no name, no
 * save, no ownership, no way back. Everything in this file is therefore net-new
 * ground rather than a copy, and the design brief from `docs/MODES.md` is
 * exact: *"multiplayer worlds that persist — join a friend's world, both edit,
 * both see it, it survives a restart."*
 *
 * ## What is stored, and why it is the deltas
 *
 * A world is **a seed plus an authoritative block-delta log**, never a dump of
 * voxels. The 169-chunk arena is 11 MB of `Uint8Array`; a world somebody has
 * actually built in is a few thousand changed cells. Storing the log means:
 *
 *   - a fresh world costs 300 bytes on disk instead of 11 MB,
 *   - `applyTo()` replays onto freshly generated terrain, so a worldgen fix
 *     improves every existing world instead of leaving them frozen,
 *   - and the log *is* the merge: two clients editing the same world write into
 *     one ordered map, last write wins per cell, and both of them are streamed
 *     the same result. There is no second convergence mechanism to get wrong.
 *
 * On disk it is `<id>.dcw`: a `DCW1` magic, a JSON metadata block, then the log
 * written as sorted keys with **varint gaps** and one byte of block id. Block
 * ids run to 24, so bit 7 of that byte is free and carries "same builder as the
 * previous delta", which drops the actor varint for every run by one person.
 * Cells a builder touches cluster, so a wall costs **two bytes per voxel**
 * against six for a flat `(i16, u8, i16, u8)` record, and even scattered edits
 * stay under five. Writes go to a temp file and are renamed, so a crash
 * mid-save leaves the previous world intact rather than a half file.
 *
 * ## Permissions
 *
 * Three roles: OWNER (rename, delete, invite, promote), BUILDER (edit) and
 * VISITOR (look). A world carries a `defaultRole` for anyone arriving on the
 * share code, so "give my friends the code, they can build" and "let people
 * come and look" are both one field. Nothing downstream re-derives them:
 * `applyEdit` is the only door and it checks the role itself.
 *
 * ## Share codes
 *
 * Six characters from a 31-letter alphabet with no `0/1/I/O`, which is 887
 * million codes and no ambiguity when read out loud. Stored lowercase because
 * the wire's `CONTENT_ID_PATTERN` only accepts lowercase slugs, so a code is a
 * legal `worldId` in a `C2S_MODE.SELECT` with no extra plumbing — joining a
 * friend's world is literally typing their code into the world picker.
 *
 * ## HTTP
 *
 * `handle()` is a pure function returning a plain record, exactly like
 * `levels.ts`, so `index.ts` mounts it in three lines and this file never
 * imports `node:http`:
 *
 * ```ts
 * const w = await worldStore().handle(url.pathname, req.method, bodyText, deviceId);
 * if (w !== null) { res.writeHead(w.status, w.headers); res.end(w.body); return true; }
 * ```
 */

import {
  CHUNK_HEIGHT,
  WORLD_MAX_BLOCK_X,
  WORLD_MAX_BLOCK_Z,
  WORLD_MIN_BLOCK_X,
  WORLD_MIN_BLOCK_Z,
  WORLD_SIZE_BLOCKS,
  clamp,
} from '@doomcraft/shared';
import { BlockId, isPlaceable, BLOCK_HARDNESS } from '@doomcraft/shared';
import { sanitiseContentId } from '@doomcraft/shared/modes';

/* ------------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------------ */

export const WORLD_FILE_MAGIC = 'DCW1';
export const WORLD_FORMAT_VERSION = 1;
export const WORLD_FILE_EXT = '.dcw';

/** Where worlds live unless `DOOMCRAFT_WORLDS` says otherwise. */
export const DEFAULT_WORLD_DIR =
  (typeof process !== 'undefined' && process.env && process.env.DOOMCRAFT_WORLDS)
    ? process.env.DOOMCRAFT_WORLDS
    : './server/.data/worlds';

/** Changed voxels one world may hold. 1.5 M is ~3.3 MB on disk. */
export const MAX_WORLD_DELTAS = 1_500_000;
/** Worlds one server keeps in memory. */
export const MAX_WORLDS = 512;
/** Recent changes kept for catch-up queries. */
export const RECENT_CAPACITY = 4096;
export const MAX_WORLD_NAME = 32;
export const MAX_MEMBERS = 64;
/** How long a dirty world waits before it is written. */
export const AUTOSAVE_MS = 15_000;
/** A dirty world is written at least this often even under constant editing. */
export const AUTOSAVE_MAX_MS = 60_000;
/** Refuse a file bigger than this. */
export const MAX_WORLD_FILE_BYTES = 64 * 1024 * 1024;

export const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export const CODE_LENGTH = 6;

/* ------------------------------------------------------------------------ *
 * Roles
 * ------------------------------------------------------------------------ */

export enum WorldRole {
  /** Not a member and the world does not admit strangers. */
  NONE = 0,
  VISITOR = 1,
  BUILDER = 2,
  OWNER = 3,
}
export const WORLD_ROLE_NAMES: readonly string[] = ['none', 'visitor', 'builder', 'owner'];

export function roleFromName(name: string): WorldRole {
  const i = WORLD_ROLE_NAMES.indexOf(String(name).toLowerCase());
  return i < 0 ? WorldRole.VISITOR : (i as WorldRole);
}
export function roleName(role: number): string {
  return WORLD_ROLE_NAMES[role] ?? 'none';
}
/** Builders and owners may change voxels. */
export function canEdit(role: number): boolean { return role >= WorldRole.BUILDER; }
/** Only the owner may rename, delete, promote or demote. */
export function canManage(role: number): boolean { return role >= WorldRole.OWNER; }

export enum WorldEditResult {
  OK = 0,
  NO_PERMISSION = 1,
  OUT_OF_WORLD = 2,
  NO_CHANGE = 3,
  FULL = 4,
  NOT_PLACEABLE = 5,
  UNBREAKABLE = 6,
}
export const WORLD_EDIT_NAMES: readonly string[] = [
  'ok', 'no-permission', 'out-of-world', 'no-change', 'full', 'not-placeable', 'unbreakable',
];

/* ------------------------------------------------------------------------ *
 * Cell packing
 * ------------------------------------------------------------------------ */

const SPAN = WORLD_SIZE_BLOCKS;          // 416
const AREA = SPAN * SPAN;                // 173056

/**
 * World cell -> one integer, y-major so a column's cells are AREA apart and a
 * row's cells are adjacent. Building is overwhelmingly horizontal, so sorting
 * on this key makes the varint gaps in the file mostly 1.
 *
 * Returns -1 for a cell outside the arena.
 */
export function packCell(x: number, y: number, z: number): number {
  if (y < 0 || y >= CHUNK_HEIGHT) return -1;
  const ix = x - WORLD_MIN_BLOCK_X;
  const iz = z - WORLD_MIN_BLOCK_Z;
  if (ix < 0 || ix >= SPAN || iz < 0 || iz >= SPAN) return -1;
  return y * AREA + iz * SPAN + ix;
}
export function cellX(key: number): number { return (key % SPAN) + WORLD_MIN_BLOCK_X; }
export function cellZ(key: number): number { return (((key / SPAN) | 0) % SPAN) + WORLD_MIN_BLOCK_Z; }
export function cellY(key: number): number { return (key / AREA) | 0; }

/* ------------------------------------------------------------------------ *
 * Varint
 * ------------------------------------------------------------------------ */

/** LEB128, unsigned. Returns the new offset. */
export function writeVarint(out: number[], v: number): void {
  let n = v >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n & 0x7f);
}

export interface VarintCursor { value: number; offset: number }

export function readVarint(src: Uint8Array, offset: number, out: VarintCursor): VarintCursor {
  let result = 0;
  let shift = 1;
  let i = offset;
  for (let k = 0; k < 5; k++) {
    if (i >= src.length) break;
    const b = src[i++];
    result += (b & 0x7f) * shift;
    if ((b & 0x80) === 0) break;
    shift *= 128;
  }
  out.value = result;
  out.offset = i;
  return out;
}

/* ------------------------------------------------------------------------ *
 * The delta log
 * ------------------------------------------------------------------------ */

/** One entry as it comes back out of the catch-up ring. */
export interface WorldChange {
  x: number; y: number; z: number; id: number; actor: number; serial: number;
}

/**
 * Every voxel this world differs from its generated terrain by.
 *
 * A `Map<number, number>` rather than an append-only array: a builder who
 * places and breaks the same cell forty times should cost one entry, not
 * forty, and the on-disk size should track the *shape* of the world rather
 * than how long it has been played.
 *
 * The append-only part that does still matter — "what changed since serial N",
 * for a client that has been away for a moment — is a bounded ring, because it
 * only ever needs to answer for the recent past. Anything older than the ring
 * is answered by re-sending the chunk, which the existing `S2C.CHUNK` path
 * already does.
 */
export class WorldDeltaLog {
  /** packed cell -> (actorIndex << 8) | blockId */
  private readonly cells = new Map<number, number>();
  /** Monotonic; bumped on every accepted change. */
  serial = 0;

  private readonly rKey = new Int32Array(RECENT_CAPACITY);
  private readonly rVal = new Uint16Array(RECENT_CAPACITY);
  private readonly rSerial = new Float64Array(RECENT_CAPACITY);
  private rHead = 0;
  private rCount = 0;

  get size(): number { return this.cells.size; }

  /** Block id recorded at this cell, or -1 when the terrain still decides. */
  get(key: number): number {
    const v = this.cells.get(key);
    return v === undefined ? -1 : (v & 0xff);
  }

  /** Actor index that last changed this cell, or -1. */
  actorOf(key: number): number {
    const v = this.cells.get(key);
    return v === undefined ? -1 : (v >>> 8);
  }

  has(key: number): boolean { return this.cells.has(key); }

  /**
   * Record a change. Returns false when nothing moved (same id already logged)
   * or the log is full. Last write wins, which is the whole convergence rule.
   */
  set(key: number, blockId: number, actorIndex: number): boolean {
    const packed = ((actorIndex & 0xffff) << 8) | (blockId & 0xff);
    const existing = this.cells.get(key);
    if (existing !== undefined && (existing & 0xff) === (blockId & 0xff)) return false;
    if (existing === undefined && this.cells.size >= MAX_WORLD_DELTAS) return false;
    this.cells.set(key, packed);
    this.serial++;
    const i = this.rHead;
    this.rKey[i] = key;
    this.rVal[i] = packed & 0xffff;
    this.rSerial[i] = this.serial;
    this.rHead = i + 1 === RECENT_CAPACITY ? 0 : i + 1;
    if (this.rCount < RECENT_CAPACITY) this.rCount++;
    return true;
  }

  /**
   * Drop a cell from the log entirely — used by `compact()` when an edit has
   * put the terrain's own block back and the entry is no longer information.
   */
  forget(key: number): boolean {
    return this.cells.delete(key);
  }

  /** Sorted cell keys. Allocates: called on save and on clone, never per tick. */
  sortedKeys(): number[] {
    const keys = Array.from(this.cells.keys());
    keys.sort((a, b) => a - b);
    return keys;
  }

  /** Walk every delta in sorted order. */
  forEachSorted(visit: (key: number, blockId: number, actorIndex: number) => void): void {
    for (const key of this.sortedKeys()) {
      const v = this.cells.get(key) as number;
      visit(key, v & 0xff, v >>> 8);
    }
  }

  /**
   * Changes newer than `sinceSerial`, oldest first. Returns -1 when the ring no
   * longer reaches back that far and the caller must resend whole chunks.
   */
  drainSince(sinceSerial: number, out: WorldChange[]): number {
    out.length = 0;
    if (this.rCount === 0) return this.serial;
    const oldestIndex = this.rCount < RECENT_CAPACITY ? 0 : this.rHead;
    const oldestSerial = this.rSerial[oldestIndex];
    if (sinceSerial + 1 < oldestSerial) return -1;
    for (let n = 0; n < this.rCount; n++) {
      const i = (oldestIndex + n) % RECENT_CAPACITY;
      if (this.rSerial[i] <= sinceSerial) continue;
      const key = this.rKey[i];
      const v = this.rVal[i];
      out.push({
        x: cellX(key), y: cellY(key), z: cellZ(key),
        id: v & 0xff, actor: v >>> 8, serial: this.rSerial[i],
      });
    }
    return this.serial;
  }

  /**
   * Drop entries that merely restore what the generator would have produced.
   * `baseline` is the terrain's own block at that cell. Returns how many went.
   */
  compact(baseline: (x: number, y: number, z: number) => number): number {
    let dropped = 0;
    for (const [key, v] of this.cells) {
      if ((v & 0xff) === baseline(cellX(key), cellY(key), cellZ(key))) {
        this.cells.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  clear(): void {
    this.cells.clear();
    this.serial = 0;
    this.rHead = 0;
    this.rCount = 0;
  }

  copyInto(other: WorldDeltaLog): void {
    other.clear();
    for (const [k, v] of this.cells) other.cells.set(k, v);
    other.serial = this.serial;
  }
}

/* ------------------------------------------------------------------------ *
 * Metadata
 * ------------------------------------------------------------------------ */

export interface WorldMember {
  id: string;
  name: string;
  role: WorldRole;
  joinedMs: number;
  lastSeenMs: number;
}

export interface WorldMeta {
  version: number;
  id: string;
  name: string;
  /** Lowercase share code. Also a legal `worldId` on the wire. */
  code: string;
  seed: number;
  ownerId: string;
  createdMs: number;
  updatedMs: number;
  /** Role granted to somebody who arrives with the code and is not a member. */
  defaultRole: WorldRole;
  members: WorldMember[];
  /** Actor id per index, referenced by the delta log. Index 0 is the world. */
  actors: string[];
  blocksPlaced: number;
  blocksBroken: number;
}

/** What the world list shows. Cheap to build; no voxels touched. */
export interface WorldSummary {
  id: string;
  name: string;
  code: string;
  seed: number;
  ownerId: string;
  createdMs: number;
  updatedMs: number;
  members: number;
  edits: number;
  /** Bytes the world costs on disk right now. */
  bytes: number;
  defaultRole: string;
  /** Your role, when the query carried an actor id. */
  yourRole: string;
}

/** The one thing this module needs from `ServerWorld`. */
export interface WorldVoxelTarget {
  setBlock(x: number, y: number, z: number, id: number, by: number): boolean;
  getBlock(x: number, y: number, z: number): number;
}

/* ------------------------------------------------------------------------ *
 * A world
 * ------------------------------------------------------------------------ */

export class PersistentWorld {
  readonly meta: WorldMeta;
  readonly log = new WorldDeltaLog();

  /** True when the log has moved since the last successful write. */
  dirty = false;
  /** Wall clock of the last successful write. */
  savedMs = 0;
  /** Wall clock the log first went dirty since the last write. */
  dirtySinceMs = 0;
  /** Serial at the last successful write, so a save can be skipped as a no-op. */
  savedSerial = 0;
  /** Bytes the last write produced; 0 until the first one. */
  bytes = 0;
  /** Live connections. The store will not reap a world anybody is standing in. */
  occupants = 0;

  private readonly actorIndex = new Map<string, number>();

  constructor(meta: WorldMeta) {
    this.meta = meta;
    for (let i = 0; i < meta.actors.length; i++) this.actorIndex.set(meta.actors[i], i);
  }

  get id(): string { return this.meta.id; }
  get code(): string { return this.meta.code; }

  /** Index for an actor id, adding it to the table the first time. */
  actorSlot(memberId: string): number {
    const id = memberId === '' ? '@world' : memberId;
    const existing = this.actorIndex.get(id);
    if (existing !== undefined) return existing;
    if (this.meta.actors.length >= 0xffff) return 0;
    const idx = this.meta.actors.length;
    this.meta.actors.push(id);
    this.actorIndex.set(id, idx);
    return idx;
  }

  /** Role of `memberId`, falling back to the world's default for strangers. */
  roleOf(memberId: string): WorldRole {
    if (memberId !== '' && memberId === this.meta.ownerId) return WorldRole.OWNER;
    for (const m of this.meta.members) if (m.id === memberId) return m.role;
    return this.meta.defaultRole;
  }

  member(memberId: string): WorldMember | null {
    for (const m of this.meta.members) if (m.id === memberId) return m;
    return null;
  }

  /** Record an arrival. Returns the effective role. */
  join(memberId: string, name: string, nowMs: number): WorldRole {
    if (memberId === '') return this.meta.defaultRole;
    let m = this.member(memberId);
    if (m === null) {
      if (this.meta.members.length >= MAX_MEMBERS) return this.meta.defaultRole;
      m = {
        id: memberId,
        name: name.slice(0, MAX_WORLD_NAME),
        role: memberId === this.meta.ownerId ? WorldRole.OWNER : this.meta.defaultRole,
        joinedMs: nowMs,
        lastSeenMs: nowMs,
      };
      this.meta.members.push(m);
      this.dirty = true;
      if (this.dirtySinceMs === 0) this.dirtySinceMs = nowMs;
    } else {
      m.lastSeenMs = nowMs;
      if (name !== '') m.name = name.slice(0, MAX_WORLD_NAME);
    }
    return m.role;
  }

  setRole(memberId: string, role: WorldRole, byId: string, nowMs: number): boolean {
    if (!canManage(this.roleOf(byId))) return false;
    if (memberId === this.meta.ownerId) return false;   // the owner cannot be demoted
    let m = this.member(memberId);
    if (m === null) {
      if (this.meta.members.length >= MAX_MEMBERS) return false;
      m = { id: memberId, name: '', role, joinedMs: nowMs, lastSeenMs: nowMs };
      this.meta.members.push(m);
    } else {
      m.role = role;
    }
    this.touch(nowMs);
    return true;
  }

  /**
   * The one door into the log.
   *
   * `blockId` is the block the cell becomes; `BlockId.AIR` is a break. The
   * caller has already run the sim's own geometric checks (reach, bodies); what
   * is decided here is permission, bounds and whether the change is real.
   */
  applyEdit(memberId: string, x: number, y: number, z: number, blockId: number, nowMs: number): WorldEditResult {
    if (!canEdit(this.roleOf(memberId))) return WorldEditResult.NO_PERMISSION;
    const key = packCell(x, y, z);
    if (key < 0) return WorldEditResult.OUT_OF_WORLD;
    if (y < 1) return WorldEditResult.OUT_OF_WORLD;        // bedrock floor is not editable
    if (blockId !== BlockId.AIR && !isPlaceable(blockId)) return WorldEditResult.NOT_PLACEABLE;
    if (!this.log.set(key, blockId, this.actorSlot(memberId))) {
      return this.log.size >= MAX_WORLD_DELTAS && !this.log.has(key)
        ? WorldEditResult.FULL
        : WorldEditResult.NO_CHANGE;
    }
    if (blockId === BlockId.AIR) this.meta.blocksBroken++;
    else this.meta.blocksPlaced++;
    this.touch(nowMs);
    return WorldEditResult.OK;
  }

  /**
   * Record a change the world itself made (an explosion, a level stamp) with no
   * permission check and no placement rules. `BLOCK_HARDNESS` is consulted only
   * so a carve cannot log the removal of bedrock, which the sim would refuse
   * anyway and which would then differ between a fresh world and a loaded one.
   */
  applyWorldEdit(x: number, y: number, z: number, blockId: number, nowMs: number): boolean {
    const key = packCell(x, y, z);
    if (key < 0 || y < 1) return false;
    if (blockId === BlockId.AIR && BLOCK_HARDNESS[this.blockAtOrAir(x, y, z)] < 0) return false;
    if (!this.log.set(key, blockId, 0)) return false;
    this.touch(nowMs);
    return true;
  }

  private blockAtOrAir(x: number, y: number, z: number): number {
    const v = this.log.get(packCell(x, y, z));
    return v < 0 ? BlockId.AIR : v;
  }

  /** Logged block at a cell, or -1 when the generator still decides it. */
  blockAt(x: number, y: number, z: number): number {
    const key = packCell(x, y, z);
    return key < 0 ? -1 : this.log.get(key);
  }

  touch(nowMs: number): void {
    this.meta.updatedMs = nowMs;
    if (!this.dirty) {
      this.dirty = true;
      this.dirtySinceMs = nowMs;
    }
  }

  /**
   * Replay the whole log into a live world. Returns the number of voxels that
   * actually changed — a fresh `ServerWorld` on the same seed plus this call is
   * bit-for-bit the world the last player left.
   */
  applyTo(target: WorldVoxelTarget): number {
    let n = 0;
    this.log.forEachSorted((key, blockId) => {
      if (target.setBlock(cellX(key), cellY(key), cellZ(key), blockId, 0)) n++;
    });
    return n;
  }

  summary(forActor = ''): WorldSummary {
    return {
      id: this.meta.id,
      name: this.meta.name,
      code: this.meta.code,
      seed: this.meta.seed,
      ownerId: this.meta.ownerId,
      createdMs: this.meta.createdMs,
      updatedMs: this.meta.updatedMs,
      members: this.meta.members.length,
      edits: this.log.size,
      bytes: this.bytes,
      defaultRole: roleName(this.meta.defaultRole),
      yourRole: roleName(this.roleOf(forActor)),
    };
  }
}

/* ------------------------------------------------------------------------ *
 * Encoding
 * ------------------------------------------------------------------------ */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class WorldDecodeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorldDecodeError';
    this.code = code;
  }
}

/** Set in the id byte when this delta has the same actor as the one before it. */
const SAME_ACTOR_BIT = 0x80;

/**
 * `DCW1` | u16 version | u32 metaLen | meta JSON | u32 count | delta*
 *
 * One delta is `varint gap, u8 (id | sameActorBit), [varint actor]`. The gap is
 * the difference from the previous key — cells are packed y-major, so a wall
 * is a run of gap 1 — and the actor is written only when it changed, which for
 * a world one person built means never after the first.
 *
 * `BLOCK_COUNT` is 25, so bit 7 of the id byte cannot collide with a real
 * block. If the palette ever passes 128 this needs a version bump.
 */
export function encodeWorld(world: PersistentWorld): Uint8Array {
  const metaJson = textEncoder.encode(JSON.stringify(world.meta));
  const body: number[] = [];
  let prev = 0;
  let prevActor = -1;
  let count = 0;
  world.log.forEachSorted((key, blockId, actor) => {
    writeVarint(body, key - prev);
    const same = actor === prevActor;
    body.push((blockId & 0x7f) | (same ? SAME_ACTOR_BIT : 0));
    if (!same) writeVarint(body, actor);
    prev = key;
    prevActor = actor;
    count++;
  });

  const header = 4 + 2 + 4 + metaJson.length + 4;
  const out = new Uint8Array(header + body.length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = WORLD_FILE_MAGIC.charCodeAt(i);
  view.setUint16(4, WORLD_FORMAT_VERSION, true);
  view.setUint32(6, metaJson.length, true);
  out.set(metaJson, 10);
  view.setUint32(10 + metaJson.length, count, true);
  out.set(Uint8Array.from(body), header);
  return out;
}

export function isWorldBinary(bytes: Uint8Array): boolean {
  return bytes.length >= 10
    && bytes[0] === 0x44 && bytes[1] === 0x43 && bytes[2] === 0x57 && bytes[3] === 0x31;
}

export function decodeWorld(bytes: Uint8Array): PersistentWorld {
  if (!isWorldBinary(bytes)) throw new WorldDecodeError('E_MAGIC', 'not a DCW1 world file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version > WORLD_FORMAT_VERSION) {
    throw new WorldDecodeError('E_VERSION', `world format v${version} is newer than v${WORLD_FORMAT_VERSION}`);
  }
  const metaLen = view.getUint32(6, true);
  if (10 + metaLen + 4 > bytes.length) throw new WorldDecodeError('E_TRUNCATED', 'metadata runs past the file');
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(bytes.subarray(10, 10 + metaLen)));
  } catch {
    throw new WorldDecodeError('E_META', 'metadata is not JSON');
  }
  const meta = coerceMeta(parsed);
  const world = new PersistentWorld(meta);

  const count = view.getUint32(10 + metaLen, true);
  let off = 10 + metaLen + 4;
  const cur: VarintCursor = { value: 0, offset: off };
  let key = 0;
  let actor = 0;
  for (let i = 0; i < count; i++) {
    if (off >= bytes.length) throw new WorldDecodeError('E_TRUNCATED', `delta ${i} of ${count} is missing`);
    readVarint(bytes, off, cur);
    key += cur.value;
    off = cur.offset;
    if (off >= bytes.length) throw new WorldDecodeError('E_TRUNCATED', `delta ${i} has no block id`);
    const tag = bytes[off++];
    if ((tag & SAME_ACTOR_BIT) === 0) {
      readVarint(bytes, off, cur);
      actor = cur.value;
      off = cur.offset;
    }
    world.log.set(key, tag & 0x7f, actor);
  }
  // Loading is not editing: the world starts clean and its serial starts at the
  // number of deltas, so a catch-up query against a just-loaded world is sane.
  world.dirty = false;
  world.dirtySinceMs = 0;
  world.savedSerial = world.log.serial;
  world.bytes = bytes.length;
  return world;
}

/* ------------------------------------------------------------------------ *
 * Coercion — nothing read off disk is trusted
 * ------------------------------------------------------------------------ */

function rec(v: unknown): Record<string, unknown> {
  return (v !== null && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {};
}
function str(v: unknown, dflt: string, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : dflt;
}
function int(v: unknown, dflt: number, lo: number, hi: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt;
  return clamp(n, lo, hi);
}

export function coerceMeta(input: unknown): WorldMeta {
  const r = rec(input);
  const now = int(r.createdMs, 0, 0, 1e15);
  const id = sanitiseContentId(str(r.id, '', 48));
  const members: WorldMember[] = [];
  const rawMembers = Array.isArray(r.members) ? r.members : [];
  for (const raw of rawMembers.slice(0, MAX_MEMBERS)) {
    const m = rec(raw);
    const mid = sanitiseContentId(str(m.id, '', 48));
    if (mid === '') continue;
    members.push({
      id: mid,
      name: str(m.name, '', MAX_WORLD_NAME),
      role: int(m.role, WorldRole.VISITOR, 0, WorldRole.OWNER) as WorldRole,
      joinedMs: int(m.joinedMs, now, 0, 1e15),
      lastSeenMs: int(m.lastSeenMs, now, 0, 1e15),
    });
  }
  const actors: string[] = ['@world'];
  const rawActors = Array.isArray(r.actors) ? r.actors : [];
  for (let i = 1; i < rawActors.length && i < 0xffff; i++) {
    actors.push(str(rawActors[i], `a${i}`, 48));
  }
  return {
    version: int(r.version, WORLD_FORMAT_VERSION, 0, 255),
    id: id === '' ? `w${(now || 1).toString(36)}` : id,
    name: str(r.name, 'World', MAX_WORLD_NAME),
    code: normaliseCode(str(r.code, '', CODE_LENGTH)),
    seed: int(r.seed, 1, 0, 0xffffffff) >>> 0,
    ownerId: sanitiseContentId(str(r.ownerId, '', 48)),
    createdMs: now,
    updatedMs: int(r.updatedMs, now, 0, 1e15),
    defaultRole: int(r.defaultRole, WorldRole.BUILDER, 0, WorldRole.OWNER) as WorldRole,
    members,
    actors,
    blocksPlaced: int(r.blocksPlaced, 0, 0, 1e12),
    blocksBroken: int(r.blocksBroken, 0, 0, 1e12),
  };
}

/* ------------------------------------------------------------------------ *
 * Codes and ids
 * ------------------------------------------------------------------------ */

/**
 * Lowercase, alphabet-only, exactly `CODE_LENGTH` or ''.
 *
 * Spaces and dashes are dropped, so "9K M-2 QD" is the same code as "9km2qd".
 * The alphabet already has no `0/1/i/l/o` in it, so there is nothing to fold:
 * a character outside it is a typo, and guessing at a typo would silently send
 * somebody into a stranger's world.
 */
export function normaliseCode(raw: string): string {
  let out = '';
  const s = String(raw).toLowerCase();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ' || c === '-' || c === '_') continue;
    if (CODE_ALPHABET.indexOf(c) < 0) return '';
    if (out.length >= CODE_LENGTH) return '';
    out += c;
  }
  return out.length === CODE_LENGTH ? out : '';
}

/** True when `s` could be a code rather than a world id. */
export function looksLikeCode(s: string): boolean {
  if (s.length !== CODE_LENGTH) return false;
  for (let i = 0; i < s.length; i++) if (CODE_ALPHABET.indexOf(s[i]) < 0) return false;
  return true;
}

/**
 * Deterministic given `rand`, which is what lets a test pin the code. Callers
 * pass the store's own generator so codes are unique per store.
 */
export function makeCode(rand: () => number): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  }
  return out;
}

/** Mulberry32, so a seeded store produces the same codes every run. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------------ *
 * Filesystem
 * ------------------------------------------------------------------------ */

/** The five calls the store makes. Swap it for a Map in a test. */
export interface WorldFs {
  mkdir(path: string, opts: { recursive: boolean }): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

/** An in-memory `WorldFs`. The restart test runs two stores over one of these. */
export class MemoryWorldFs implements WorldFs {
  readonly files = new Map<string, Uint8Array>();
  /** Every write that happened, for assertions about atomicity. */
  writes = 0;

  mkdir(): Promise<unknown> { return Promise.resolve(null); }

  readdir(path: string): Promise<string[]> {
    const prefix = `${path.replace(/\/+$/, '')}/`;
    const out: string[] = [];
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix) && key.indexOf('/', prefix.length) < 0) out.push(key.slice(prefix.length));
    }
    return Promise.resolve(out);
  }

  readFile(path: string): Promise<Uint8Array> {
    const v = this.files.get(path);
    if (v === undefined) return Promise.reject(new Error(`ENOENT ${path}`));
    return Promise.resolve(v);
  }

  writeFile(path: string, data: Uint8Array): Promise<void> {
    this.writes++;
    this.files.set(path, data.slice());
    return Promise.resolve();
  }

  rename(from: string, to: string): Promise<void> {
    const v = this.files.get(from);
    if (v === undefined) return Promise.reject(new Error(`ENOENT ${from}`));
    this.files.delete(from);
    this.files.set(to, v);
    return Promise.resolve();
  }

  unlink(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }
}

/* ------------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------------ */

export interface WorldStoreOptions {
  dir?: string;
  fs?: WorldFs | null;
  /** Injected so a test can drive the autosave clock. */
  now?: () => number;
  autosaveMs?: number;
  autosaveMaxMs?: number;
  maxWorlds?: number;
  /** Seeds the share-code generator. */
  codeSeed?: number;
}

export interface WorldStoreStats {
  worlds: number;
  dirty: number;
  loaded: number;
  saves: number;
  failures: number;
  degraded: boolean;
}

export interface WorldHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

/**
 * Every world this server knows about, and the disk they live on.
 *
 * Saving is debounced (`AUTOSAVE_MS` after the first change) and bounded
 * (`AUTOSAVE_MAX_MS` under continuous editing), so a builder who lays a
 * thousand blocks costs a handful of writes rather than a thousand, and a
 * server killed at any moment loses at most one autosave window.
 */
export class WorldStore {
  readonly dir: string;
  private readonly fsOverride: WorldFs | null;
  private readonly nowFn: () => number;
  private readonly autosaveMs: number;
  private readonly autosaveMaxMs: number;
  private readonly maxWorlds: number;
  private readonly rand: () => number;

  private readonly byId = new Map<string, PersistentWorld>();
  private readonly byCodeIndex = new Map<string, string>();
  private readonly saving = new Set<string>();
  private fs: WorldFs | null = null;
  private loaded = false;
  private saves = 0;
  private failures = 0;
  /** True once the disk has refused us; the store keeps serving from memory. */
  degraded = false;

  constructor(options: WorldStoreOptions = {}) {
    this.dir = (options.dir ?? DEFAULT_WORLD_DIR).replace(/\/+$/, '');
    this.fsOverride = options.fs ?? null;
    this.nowFn = options.now ?? Date.now;
    this.autosaveMs = options.autosaveMs ?? AUTOSAVE_MS;
    this.autosaveMaxMs = options.autosaveMaxMs ?? AUTOSAVE_MAX_MS;
    this.maxWorlds = options.maxWorlds ?? MAX_WORLDS;
    this.rand = seededRandom(options.codeSeed ?? ((Date.now() ^ 0x9e3779b9) >>> 0));
  }

  get size(): number { return this.byId.size; }
  get isLoaded(): boolean { return this.loaded; }

  stats(): WorldStoreStats {
    let dirty = 0;
    for (const w of this.byId.values()) if (w.dirty) dirty++;
    return {
      worlds: this.byId.size,
      dirty,
      loaded: this.loaded ? 1 : 0,
      saves: this.saves,
      failures: this.failures,
      degraded: this.degraded,
    };
  }

  private async ready(): Promise<WorldFs | null> {
    if (this.fs !== null) return this.fs;
    if (this.fsOverride !== null) {
      this.fs = this.fsOverride;
      await this.fs.mkdir(this.dir, { recursive: true });
      return this.fs;
    }
    try {
      // Built at runtime so a bundler cannot follow it into a browser build.
      const spec = 'node:fs' + '/promises';
      const mod = (await import(/* @vite-ignore */ spec)) as unknown as WorldFs;
      await mod.mkdir(this.dir, { recursive: true });
      this.fs = mod;
      return mod;
    } catch {
      this.degraded = true;
      return null;
    }
  }

  private pathOf(id: string): string { return `${this.dir}/${id}${WORLD_FILE_EXT}`; }

  /* --- loading --------------------------------------------------------- */

  /** Scan the directory. Safe to call twice; the second call is a no-op. */
  async load(): Promise<number> {
    if (this.loaded) return this.byId.size;
    this.loaded = true;
    const fs = await this.ready();
    if (fs === null) return 0;
    let names: string[];
    try { names = await fs.readdir(this.dir); } catch { return 0; }
    for (const name of names) {
      if (!name.endsWith(WORLD_FILE_EXT)) continue;
      const path = `${this.dir}/${name}`;
      try {
        const bytes = await fs.readFile(path);
        if (bytes.length > MAX_WORLD_FILE_BYTES) { this.failures++; continue; }
        const world = decodeWorld(bytes);
        this.register(world);
      } catch {
        this.failures++;
      }
    }
    return this.byId.size;
  }

  private register(world: PersistentWorld): void {
    this.byId.set(world.id, world);
    if (world.code !== '') this.byCodeIndex.set(world.code, world.id);
  }

  /* --- lookup ----------------------------------------------------------- */

  get(id: string): PersistentWorld | null {
    return this.byId.get(sanitiseContentId(id)) ?? null;
  }

  byCode(code: string): PersistentWorld | null {
    const c = normaliseCode(code);
    if (c === '') return null;
    const id = this.byCodeIndex.get(c);
    return id === undefined ? null : (this.byId.get(id) ?? null);
  }

  /**
   * Take whatever the wire said and find the world. A share code and a world id
   * are both lowercase slugs, so this tries the code first (six characters,
   * alphabet-restricted) and falls back to the id.
   */
  resolve(idOrCode: string): PersistentWorld | null {
    const s = sanitiseContentId(idOrCode);
    if (s === '') return null;
    if (looksLikeCode(s)) {
      const byCode = this.byCode(s);
      if (byCode !== null) return byCode;
    }
    return this.get(s);
  }

  list(forActor = ''): WorldSummary[] {
    const out: WorldSummary[] = [];
    for (const w of this.byId.values()) out.push(w.summary(forActor));
    out.sort((a, b) => b.updatedMs - a.updatedMs);
    return out;
  }

  /* --- mutation ---------------------------------------------------------- */

  /** A code nobody is using. Falls back to widening after enough collisions. */
  private freshCode(): string {
    for (let i = 0; i < 64; i++) {
      const c = makeCode(this.rand);
      if (!this.byCodeIndex.has(c)) return c;
    }
    // 64 collisions means the space is genuinely crowded; hand back one derived
    // from the size so `create` still succeeds rather than throwing.
    let n = this.byId.size;
    let c = '';
    for (let i = 0; i < CODE_LENGTH; i++) { c += CODE_ALPHABET[n % CODE_ALPHABET.length]; n = (n / CODE_ALPHABET.length) | 0; }
    return c;
  }

  private freshId(name: string, nowMs: number): string {
    const slug = sanitiseContentId(name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 20);
    const base = slug === '' ? 'world' : slug;
    let id = base;
    let n = 1;
    while (this.byId.has(id)) {
      id = sanitiseContentId(`${base}-${(nowMs % 100000).toString(36)}${n}`);
      n++;
      if (n > 100) { id = sanitiseContentId(`w${nowMs.toString(36)}${this.byId.size}`); break; }
    }
    return id;
  }

  create(opts: { name?: string; ownerId?: string; seed?: number; defaultRole?: WorldRole }): PersistentWorld | null {
    if (this.byId.size >= this.maxWorlds) return null;
    const now = this.nowFn();
    const name = (opts.name ?? 'New World').slice(0, MAX_WORLD_NAME) || 'New World';
    const ownerId = sanitiseContentId(opts.ownerId ?? '');
    const meta: WorldMeta = {
      version: WORLD_FORMAT_VERSION,
      id: this.freshId(name, now),
      name,
      code: this.freshCode(),
      seed: (opts.seed ?? Math.floor(this.rand() * 0xffffffff)) >>> 0,
      ownerId,
      createdMs: now,
      updatedMs: now,
      defaultRole: opts.defaultRole ?? WorldRole.BUILDER,
      members: [],
      actors: ['@world'],
      blocksPlaced: 0,
      blocksBroken: 0,
    };
    const world = new PersistentWorld(meta);
    if (ownerId !== '') world.join(ownerId, '', now);
    world.touch(now);
    this.register(world);
    return world;
  }

  rename(id: string, name: string, byId: string): boolean {
    const w = this.get(id);
    if (w === null || !canManage(w.roleOf(byId))) return false;
    const clean = name.slice(0, MAX_WORLD_NAME).trim();
    if (clean === '') return false;
    w.meta.name = clean;
    w.touch(this.nowFn());
    return true;
  }

  setRole(id: string, memberId: string, role: WorldRole, byId: string): boolean {
    const w = this.get(id);
    if (w === null) return false;
    return w.setRole(sanitiseContentId(memberId), role, byId, this.nowFn());
  }

  setDefaultRole(id: string, role: WorldRole, byId: string): boolean {
    const w = this.get(id);
    if (w === null || !canManage(w.roleOf(byId))) return false;
    w.meta.defaultRole = role;
    w.touch(this.nowFn());
    return true;
  }

  /** Copy the world, log and all, under a new id and a new code. */
  duplicate(id: string, name: string, byId: string): PersistentWorld | null {
    const src = this.get(id);
    if (src === null) return null;
    if (!canEdit(src.roleOf(byId))) return null;
    const copy = this.create({
      name: name === '' ? `${src.meta.name} copy` : name,
      ownerId: byId,
      seed: src.meta.seed,
      defaultRole: src.meta.defaultRole,
    });
    if (copy === null) return null;
    src.log.copyInto(copy.log);
    copy.meta.blocksPlaced = src.meta.blocksPlaced;
    copy.meta.blocksBroken = src.meta.blocksBroken;
    copy.touch(this.nowFn());
    return copy;
  }

  async remove(id: string, byId: string): Promise<boolean> {
    const w = this.get(id);
    if (w === null || !canManage(w.roleOf(byId))) return false;
    this.byId.delete(w.id);
    if (w.code !== '') this.byCodeIndex.delete(w.code);
    const fs = await this.ready();
    if (fs === null) return true;
    try { await fs.unlink(this.pathOf(w.id)); } catch { /* already gone */ }
    return true;
  }

  /* --- saving ------------------------------------------------------------ */

  /**
   * Write one world atomically. Returns false when the disk refused, which
   * marks the store degraded but never throws into the game loop.
   */
  async save(id: string): Promise<boolean> {
    const w = this.get(id);
    if (w === null) return false;
    if (this.saving.has(w.id)) return false;
    const fs = await this.ready();
    if (fs === null) return false;
    this.saving.add(w.id);
    const serial = w.log.serial;
    try {
      const bytes = encodeWorld(w);
      const tmp = `${this.pathOf(w.id)}.tmp`;
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, this.pathOf(w.id));
      w.bytes = bytes.length;
      w.savedSerial = serial;
      w.savedMs = this.nowFn();
      // Anything written while the await was in flight keeps the world dirty.
      if (w.log.serial === serial) {
        w.dirty = false;
        w.dirtySinceMs = 0;
      }
      this.saves++;
      return true;
    } catch {
      this.failures++;
      this.degraded = true;
      return false;
    } finally {
      this.saving.delete(w.id);
    }
  }

  /** Save every dirty world. Call on shutdown. */
  async flush(): Promise<number> {
    let n = 0;
    for (const w of Array.from(this.byId.values())) {
      if (!w.dirty) continue;
      if (await this.save(w.id)) n++;
    }
    return n;
  }

  /**
   * Autosave tick. Call it from the server's existing timer; it is cheap and
   * returns the ids it started writing. Debounced by `autosaveMs` since the
   * first change, forced by `autosaveMaxMs` so a world under constant editing
   * still lands on disk.
   */
  pump(nowMs = this.nowFn()): string[] {
    const started: string[] = [];
    for (const w of this.byId.values()) {
      if (!w.dirty || this.saving.has(w.id)) continue;
      const since = nowMs - w.dirtySinceMs;
      const sinceSave = nowMs - w.savedMs;
      if (since < this.autosaveMs && sinceSave < this.autosaveMaxMs) continue;
      started.push(w.id);
      void this.save(w.id);
    }
    return started;
  }

  /* --- session bookkeeping ------------------------------------------------ */

  /** A player arrived. Returns their effective role, or NONE for no such world. */
  enter(idOrCode: string, memberId: string, name: string): { world: PersistentWorld; role: WorldRole } | null {
    const w = this.resolve(idOrCode);
    if (w === null) return null;
    const role = w.join(sanitiseContentId(memberId), name, this.nowFn());
    w.occupants++;
    return { world: w, role };
  }

  /** A player left. The world is written out when the last one goes. */
  leave(id: string): void {
    const w = this.get(id);
    if (w === null) return;
    if (w.occupants > 0) w.occupants--;
    if (w.occupants === 0 && w.dirty) void this.save(w.id);
  }

  /* --- HTTP --------------------------------------------------------------- */

  /**
   * `GET  /api/worlds`                 list (add `?actor=<id>` for your role)
   * `POST /api/worlds`                 create   {name, seed, ownerId, defaultRole}
   * `GET  /api/worlds/<idOrCode>`      one world
   * `PATCH /api/worlds/<id>`           {name?, defaultRole?, member?, role?, actor}
   * `POST /api/worlds/<id>/duplicate`  {name, actor}
   * `DELETE /api/worlds/<id>`          `?actor=<id>`
   *
   * Returns null when the path is not ours, so the caller falls through.
   */
  async handle(pathname: string, method: string, body: string, actorId: string): Promise<WorldHttpResponse | null> {
    if (pathname !== '/api/worlds' && !pathname.startsWith('/api/worlds/')) return null;
    await this.load();
    const actor = sanitiseContentId(actorId);

    if (pathname === '/api/worlds' || pathname === '/api/worlds/') {
      if (method === 'GET' || method === 'HEAD') return json(200, { worlds: this.list(actor) });
      if (method === 'POST') {
        const b = rec(safeJson(body));
        const w = this.create({
          name: str(b.name, 'New World', MAX_WORLD_NAME),
          ownerId: actor === '' ? sanitiseContentId(str(b.ownerId, '', 48)) : actor,
          seed: typeof b.seed === 'number' ? b.seed >>> 0 : undefined,
          defaultRole: b.defaultRole === undefined ? WorldRole.BUILDER : roleFromName(String(b.defaultRole)),
        });
        if (w === null) return json(507, { error: 'world limit reached' });
        void this.save(w.id);
        return json(201, { world: w.summary(actor) });
      }
      return json(405, { error: 'method not allowed' });
    }

    const rest = pathname.slice('/api/worlds/'.length);
    const slash = rest.indexOf('/');
    const rawId = slash < 0 ? rest : rest.slice(0, slash);
    const tail = slash < 0 ? '' : rest.slice(slash + 1);
    const world = this.resolve(decodeURIComponentSafe(rawId));
    if (world === null) return json(404, { error: 'no such world', id: sanitiseContentId(rawId) });

    if (tail === 'duplicate') {
      if (method !== 'POST') return json(405, { error: 'method not allowed' });
      const b = rec(safeJson(body));
      const copy = this.duplicate(world.id, str(b.name, '', MAX_WORLD_NAME), actor);
      if (copy === null) return json(403, { error: 'not allowed to duplicate this world' });
      void this.save(copy.id);
      return json(201, { world: copy.summary(actor) });
    }
    if (tail !== '') return json(404, { error: 'unknown world route' });

    if (method === 'GET' || method === 'HEAD') {
      return json(200, {
        world: world.summary(actor),
        members: world.meta.members.map((m) => ({ id: m.id, name: m.name, role: roleName(m.role) })),
        yourRole: roleName(world.roleOf(actor)),
        canEdit: canEdit(world.roleOf(actor)),
      });
    }

    if (method === 'PATCH') {
      const b = rec(safeJson(body));
      if (!canManage(world.roleOf(actor))) return json(403, { error: 'only the owner may change this world' });
      let changed = false;
      if (typeof b.name === 'string') changed = this.rename(world.id, b.name, actor) || changed;
      if (b.defaultRole !== undefined) changed = this.setDefaultRole(world.id, roleFromName(String(b.defaultRole)), actor) || changed;
      if (typeof b.member === 'string') {
        changed = this.setRole(world.id, b.member, roleFromName(String(b.role ?? 'builder')), actor) || changed;
      }
      if (changed) void this.save(world.id);
      return json(200, { world: world.summary(actor), changed });
    }

    if (method === 'DELETE') {
      const ok = await this.remove(world.id, actor);
      return ok ? json(200, { removed: world.id }) : json(403, { error: 'only the owner may delete this world' });
    }

    return json(405, { error: 'method not allowed' });
  }
}

/* ------------------------------------------------------------------------ *
 * Module singleton, matching `levelLibrary()`
 * ------------------------------------------------------------------------ */

let singleton: WorldStore | null = null;

export function worldStore(options?: WorldStoreOptions): WorldStore {
  if (singleton === null) singleton = new WorldStore(options);
  return singleton;
}

export function resetWorldStore(): void { singleton = null; }

/* ------------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------------ */

function json(status: number, obj: unknown): WorldHttpResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
    body: JSON.stringify(obj),
  };
}

function safeJson(text: string): unknown {
  if (typeof text !== 'string' || text.length === 0) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

function decodeURIComponentSafe(v: string): string {
  try { return decodeURIComponent(v); } catch { return v; }
}

/** Bounds check used by the room before it hands an edit to the store. */
export function cellInsideWorld(x: number, y: number, z: number): boolean {
  return y >= 1 && y < CHUNK_HEIGHT
    && x >= WORLD_MIN_BLOCK_X && x <= WORLD_MAX_BLOCK_X
    && z >= WORLD_MIN_BLOCK_Z && z <= WORLD_MAX_BLOCK_Z;
}
