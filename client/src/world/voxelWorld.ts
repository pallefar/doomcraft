/**
 * DOOMCRAFT — the client's voxel store.
 *
 * One `Uint8Array(65536)` per chunk, keyed by the packed `chunkKey`. Everything
 * a frame touches is a typed-array read: no strings, no objects created after
 * construction, no closures allocated per call. The two bound predicates
 * (`solidAt`, `blockingAt`) are created once in the constructor so
 * `moveAABB` / `raycastVoxels` can be handed the same function object forever.
 *
 * Responsibilities:
 *   - store / replace / drop chunks
 *   - world-space get + set with correct negative-coordinate handling
 *   - dirty tracking with the minimal neighbour fan-out a border edit needs
 *   - the padded 34 x 66 x 34 neighbourhood the greedy mesher consumes
 *
 * NOT here: meshing, rendering, networking, worldgen. Terrain lives in
 * ./terrain.ts, edits in ./destruction.ts.
 */

import {
  CHUNK_SIZE_X, CHUNK_SIZE_Z, CHUNK_HEIGHT, CHUNK_VOLUME,
  CHUNK_SIZE_BITS, CHUNK_SIZE_MASK,
  voxelIndex, blockToChunk, chunkKey, chunkKeyCX, chunkKeyCZ,
  WORLD_MIN_CHUNK, WORLD_MAX_CHUNK, WORLD_RADIUS_CHUNKS,
  WORLD_MIN_BLOCK_X, WORLD_MAX_BLOCK_X, WORLD_MIN_BLOCK_Z, WORLD_MAX_BLOCK_Z,
} from '@shared/constants';
import {
  BlockId, BLOCK_SOLID, BLOCK_LIQUID, BLOCK_OPAQUE, BLOCK_LIGHT,
} from '@shared/blocks';
import {
  raycastVoxels, type VoxelHit, type SolidAt,
} from '@shared/math';

/* ------------------------------------------------------------------------ *
 * Padded neighbourhood layout — the mesher's input format
 * ------------------------------------------------------------------------ */

/** One block of padding on every side so the mesher can read neighbours and AO corners. */
export const NB_PAD = 1;
export const NB_SIZE_X = CHUNK_SIZE_X + NB_PAD * 2;   // 34
export const NB_SIZE_Y = CHUNK_HEIGHT + NB_PAD * 2;   // 66
export const NB_SIZE_Z = CHUNK_SIZE_Z + NB_PAD * 2;   // 34
export const NB_STRIDE_Z = NB_SIZE_X;                 // 34
export const NB_STRIDE_Y = NB_SIZE_X * NB_SIZE_Z;     // 1156
export const NB_VOLUME = NB_STRIDE_Y * NB_SIZE_Y;     // 76296

/**
 * Index into a padded neighbourhood by LOCAL chunk coordinates.
 * Valid for x,z in [-1, 32] and y in [-1, 64].
 */
export function nbIndex(x: number, y: number, z: number): number {
  return (x + NB_PAD) + (z + NB_PAD) * NB_STRIDE_Z + (y + NB_PAD) * NB_STRIDE_Y;
}

/** Allocate a neighbourhood buffer. Call this once per mesh worker slot, never per job. */
export function createNeighbourhood(): Uint8Array {
  return new Uint8Array(NB_VOLUME);
}

/* ------------------------------------------------------------------------ *
 * Chunk record
 * ------------------------------------------------------------------------ */

export interface ChunkRecord {
  readonly key: number;
  readonly cx: number;
  readonly cz: number;
  /** CHUNK_VOLUME bytes, indexed by `voxelIndex(x, y, z)`. */
  voxels: Uint8Array;
  /**
   * Bumped on every write. A mesh job carries the version it was built from;
   * when it comes back stale the scheduler drops it instead of uploading.
   */
  version: number;
  /** In the dirty list right now. */
  dirty: boolean;
  /** Non-air voxel count. 0 means the mesher can skip the chunk outright. */
  solidCount: number;
  /** Highest y holding a non-air voxel, -1 when empty. Bounds the mesher's sweep. */
  maxY: number;
  /** Set once the chunk holds real data (generated or received). */
  loaded: boolean;
}

/* ------------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------------ */

export class VoxelWorld {
  readonly chunks = new Map<number, ChunkRecord>();

  /** Keys awaiting a remesh, in the order they were touched. */
  private readonly dirtyList: number[] = [];
  /** Read cursor into `dirtyList`, so draining is O(1) per key rather than a shift. */
  private dirtyHead = 0;
  /** Recycled voxel arrays so unload/load churn does not hit the GC. */
  private readonly pool: Uint8Array[] = [];

  /** Single-entry lookup cache — the win that makes raycasts and AABB sweeps cheap. */
  private cacheKey = -1;
  private cacheVoxels: Uint8Array | null = null;

  /** Total non-air voxels across every loaded chunk. */
  solidCount = 0;

  readonly minChunk: number;
  readonly maxChunk: number;
  readonly minBlockX: number;
  readonly maxBlockX: number;
  readonly minBlockZ: number;
  readonly maxBlockZ: number;

  /**
   * Movement predicate handed straight to `moveAABB` / `isGrounded`.
   * Out-of-world laterally and below y=0 both read as solid, so the arena is
   * closed: you cannot walk off the rim or fall out of the bottom. The server
   * must use the identical rule or prediction will fight the authority.
   */
  readonly solidAt: SolidAt;
  /** Stops a hitscan ray: solid blocks and the world shell, not water or lava. */
  readonly blockingAt: (id: number) => boolean;
  /** `getBlock` in the shape `raycastVoxels` wants. */
  readonly sampleBlock: (x: number, y: number, z: number) => number;
  /**
   * `ChunkFetch` for the mesher: raw voxels or null. Hand this straight to
   * `buildPadded` — it is the same signature `engine/mesher.ts` declares.
   */
  readonly fetchChunk: (cx: number, cz: number) => Uint8Array | null;

  /* -------------------------------------------------------------------- *
   * Write mirror
   * -------------------------------------------------------------------- *
   *
   * The renderer keeps its own copy of the voxels inside the mesh worker, so
   * every write here has to reach it or the two drift and chunks mesh stale.
   * Wiring these once at startup is far safer than remembering to call
   * `ChunkRenderer.setBlock` at every edit site.
   */
  onSetBlock: ((x: number, y: number, z: number, id: number) => void) | null = null;
  onChunkLoaded: ((cx: number, cz: number, voxels: Uint8Array) => void) | null = null;
  onChunkUnloaded: ((cx: number, cz: number) => void) | null = null;

  private batchDepth = 0;
  private readonly batchTouched: number[] = [];

  constructor(radiusChunks: number = WORLD_RADIUS_CHUNKS) {
    const r = radiusChunks | 0;
    this.minChunk = radiusChunks === WORLD_RADIUS_CHUNKS ? WORLD_MIN_CHUNK : -r;
    this.maxChunk = radiusChunks === WORLD_RADIUS_CHUNKS ? WORLD_MAX_CHUNK : r;
    this.minBlockX = radiusChunks === WORLD_RADIUS_CHUNKS ? WORLD_MIN_BLOCK_X : -r * CHUNK_SIZE_X;
    this.maxBlockX = radiusChunks === WORLD_RADIUS_CHUNKS ? WORLD_MAX_BLOCK_X : r * CHUNK_SIZE_X + CHUNK_SIZE_X - 1;
    this.minBlockZ = radiusChunks === WORLD_RADIUS_CHUNKS ? WORLD_MIN_BLOCK_Z : -r * CHUNK_SIZE_Z;
    this.maxBlockZ = radiusChunks === WORLD_RADIUS_CHUNKS ? WORLD_MAX_BLOCK_Z : r * CHUNK_SIZE_Z + CHUNK_SIZE_Z - 1;

    this.solidAt = (x: number, y: number, z: number): boolean => {
      if (y < 0) return true;
      if (y >= CHUNK_HEIGHT) return false;
      if (x < this.minBlockX || x > this.maxBlockX || z < this.minBlockZ || z > this.maxBlockZ) return true;
      return BLOCK_SOLID[this.rawBlock(x, y, z)] === 1;
    };
    this.blockingAt = (id: number): boolean => BLOCK_SOLID[id] === 1;
    this.sampleBlock = (x: number, y: number, z: number): number => this.blockAt(x, y, z);
    this.fetchChunk = (cx: number, cz: number): Uint8Array | null => {
      const rec = this.chunks.get(chunkKey(cx, cz));
      return rec === undefined ? null : rec.voxels;
    };
  }

  /* -------------------------------------------------------------------- *
   * Batched writes
   * -------------------------------------------------------------------- */

  /**
   * Suppress per-voxel mirror callbacks until `endBatch`, then resync each
   * touched chunk wholesale through `onChunkLoaded`. An explosion removes
   * hundreds of voxels; one 64 KB resync per chunk beats 600 postMessages.
   *
   * Nestable. `endBatch` must be called for every `beginBatch`.
   */
  beginBatch(): void {
    this.batchDepth++;
  }

  endBatch(): void {
    if (this.batchDepth === 0) return;
    this.batchDepth--;
    if (this.batchDepth > 0) return;
    const cb = this.onChunkLoaded;
    if (cb !== null) {
      for (let i = 0; i < this.batchTouched.length; i++) {
        const rec = this.chunks.get(this.batchTouched[i]);
        if (rec !== undefined) cb(rec.cx, rec.cz, rec.voxels);
      }
    }
    this.batchTouched.length = 0;
  }

  get batching(): boolean { return this.batchDepth > 0; }

  /* -------------------------------------------------------------------- *
   * Chunk lifecycle
   * -------------------------------------------------------------------- */

  inWorld(cx: number, cz: number): boolean {
    return cx >= this.minChunk && cx <= this.maxChunk && cz >= this.minChunk && cz <= this.maxChunk;
  }

  hasChunk(cx: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cz));
  }

  getChunk(cx: number, cz: number): ChunkRecord | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  getChunkByKey(key: number): ChunkRecord | undefined {
    return this.chunks.get(key);
  }

  get chunkCount(): number { return this.chunks.size; }

  /** Get or create an all-air chunk. `loaded` stays false until data lands. */
  ensureChunk(cx: number, cz: number): ChunkRecord {
    const key = chunkKey(cx, cz);
    let rec = this.chunks.get(key);
    if (rec !== undefined) return rec;
    rec = {
      key, cx, cz,
      voxels: this.takeBuffer(),
      version: 1,
      dirty: false,
      solidCount: 0,
      maxY: -1,
      loaded: false,
    };
    this.chunks.set(key, rec);
    return rec;
  }

  /**
   * Install chunk data. `voxels` must be exactly CHUNK_VOLUME bytes; the world
   * takes ownership of it (the previous buffer is recycled). This is the
   * S2C.CHUNK path — `decodeChunk` writes into a scratch array, you hand it here.
   */
  loadChunk(cx: number, cz: number, voxels: Uint8Array): ChunkRecord {
    if (voxels.length !== CHUNK_VOLUME) {
      throw new Error(`loadChunk: expected ${CHUNK_VOLUME} bytes, got ${voxels.length}`);
    }
    const rec = this.ensureChunk(cx, cz);
    this.solidCount -= rec.solidCount;
    if (rec.voxels !== voxels) {
      this.recycle(rec.voxels);
      rec.voxels = voxels;
    }
    rec.loaded = true;
    rec.version++;
    this.recount(rec);
    this.solidCount += rec.solidCount;
    this.invalidateCache();
    this.markDirty(cx, cz);
    this.markNeighboursDirty(cx, cz);
    if (this.onChunkLoaded !== null) this.onChunkLoaded(cx, cz, rec.voxels);
    return rec;
  }

  /**
   * Copy chunk data in without taking ownership of the source. Use this when the
   * caller keeps a reusable decode scratch buffer.
   */
  copyChunkIn(cx: number, cz: number, voxels: Uint8Array): ChunkRecord {
    const rec = this.ensureChunk(cx, cz);
    rec.voxels.set(voxels.subarray(0, CHUNK_VOLUME));
    this.solidCount -= rec.solidCount;
    rec.loaded = true;
    rec.version++;
    this.recount(rec);
    this.solidCount += rec.solidCount;
    this.invalidateCache();
    this.markDirty(cx, cz);
    this.markNeighboursDirty(cx, cz);
    if (this.onChunkLoaded !== null) this.onChunkLoaded(cx, cz, rec.voxels);
    return rec;
  }

  unloadChunk(cx: number, cz: number): boolean {
    const key = chunkKey(cx, cz);
    const rec = this.chunks.get(key);
    if (rec === undefined) return false;
    this.solidCount -= rec.solidCount;
    this.chunks.delete(key);
    this.invalidateCache();
    if (this.onChunkUnloaded !== null) this.onChunkUnloaded(cx, cz);
    this.recycle(rec.voxels);
    return true;
  }

  clear(): void {
    for (const rec of this.chunks.values()) this.recycle(rec.voxels);
    this.chunks.clear();
    this.dirtyList.length = 0;
    this.dirtyHead = 0;
    this.solidCount = 0;
    this.invalidateCache();
  }

  private takeBuffer(): Uint8Array {
    const b = this.pool.pop();
    if (b !== undefined) { b.fill(0); return b; }
    return new Uint8Array(CHUNK_VOLUME);
  }

  private recycle(b: Uint8Array): void {
    if (this.pool.length < 64 && b.length === CHUNK_VOLUME) this.pool.push(b);
  }

  private recount(rec: ChunkRecord): void {
    const v = rec.voxels;
    let n = 0;
    let maxY = -1;
    for (let y = CHUNK_HEIGHT - 1; y >= 0; y--) {
      const base = y << 10;
      let rowCount = 0;
      for (let i = base, end = base + 1024; i < end; i++) if (v[i] !== 0) rowCount++;
      if (rowCount > 0 && maxY < 0) maxY = y;
      n += rowCount;
    }
    rec.solidCount = n;
    rec.maxY = maxY;
  }

  private invalidateCache(): void {
    this.cacheKey = -1;
    this.cacheVoxels = null;
  }

  /* -------------------------------------------------------------------- *
   * Voxel access
   * -------------------------------------------------------------------- */

  /**
   * Raw block id with no world-shell rule: out of world or missing chunk is AIR.
   * Callers that need the closed arena want `solidAt` instead.
   */
  rawBlock(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_HEIGHT) return BlockId.AIR;
    const cx = x >> CHUNK_SIZE_BITS;
    const cz = z >> CHUNK_SIZE_BITS;
    const key = (((cx + 1024) << 11) | (cz + 1024)) >>> 0;
    let v: Uint8Array | null;
    if (key === this.cacheKey) {
      v = this.cacheVoxels;
    } else {
      const rec = this.chunks.get(key);
      if (rec === undefined) return BlockId.AIR;
      v = rec.voxels;
      this.cacheKey = key;
      this.cacheVoxels = v;
    }
    if (v === null) return BlockId.AIR;
    return v[(x & CHUNK_SIZE_MASK) | ((z & CHUNK_SIZE_MASK) << CHUNK_SIZE_BITS) | (y << 10)];
  }

  /**
   * Block id for gameplay queries. Below the world reads as BEDROCK so digging
   * and raycasts terminate; above and outside reads as AIR.
   */
  blockAt(x: number, y: number, z: number): number {
    if (y < 0) return BlockId.BEDROCK;
    return this.rawBlock(x, y, z);
  }

  /** Block id at a continuous world position. */
  blockAtPos(x: number, y: number, z: number): number {
    return this.blockAt(Math.floor(x), Math.floor(y), Math.floor(z));
  }

  isSolid(x: number, y: number, z: number): boolean {
    return this.solidAt(x, y, z);
  }

  isLiquid(x: number, y: number, z: number): boolean {
    return BLOCK_LIQUID[this.rawBlock(x, y, z)] === 1;
  }

  isOpaque(x: number, y: number, z: number): boolean {
    return BLOCK_OPAQUE[this.rawBlock(x, y, z)] === 1;
  }

  lightAt(x: number, y: number, z: number): number {
    return BLOCK_LIGHT[this.rawBlock(x, y, z)];
  }

  /**
   * Write a voxel in world space. Returns true when the world actually changed.
   * Dirty fan-out is minimal: the owning chunk always, plus the up-to-three
   * neighbours that share the touched border (corner edits touch three).
   */
  setBlock(x: number, y: number, z: number, id: number): boolean {
    if (y < 0 || y >= CHUNK_HEIGHT) return false;
    if (x < this.minBlockX || x > this.maxBlockX || z < this.minBlockZ || z > this.maxBlockZ) return false;
    const cx = x >> CHUNK_SIZE_BITS;
    const cz = z >> CHUNK_SIZE_BITS;
    const rec = this.chunks.get(chunkKey(cx, cz));
    if (rec === undefined) return false;

    const lx = x & CHUNK_SIZE_MASK;
    const lz = z & CHUNK_SIZE_MASK;
    const i = voxelIndex(lx, y, lz);
    const prev = rec.voxels[i];
    if (prev === id) return false;

    rec.voxels[i] = id;
    rec.version++;
    if (prev === 0 && id !== 0) { rec.solidCount++; this.solidCount++; if (y > rec.maxY) rec.maxY = y; }
    else if (prev !== 0 && id === 0) {
      rec.solidCount--; this.solidCount--;
      if (y === rec.maxY) rec.maxY = this.recomputeMaxY(rec, y);
    } else if (id !== 0 && y > rec.maxY) {
      rec.maxY = y;
    }

    this.markDirtyRecord(rec);
    // Only a border write can change a neighbour's visible faces or AO.
    if (lx === 0) this.markDirty(cx - 1, cz);
    else if (lx === CHUNK_SIZE_X - 1) this.markDirty(cx + 1, cz);
    if (lz === 0) this.markDirty(cx, cz - 1);
    else if (lz === CHUNK_SIZE_Z - 1) this.markDirty(cx, cz + 1);
    // Corner: the diagonal chunk shares an AO corner voxel.
    if (lx === 0 && lz === 0) this.markDirty(cx - 1, cz - 1);
    else if (lx === 0 && lz === CHUNK_SIZE_Z - 1) this.markDirty(cx - 1, cz + 1);
    else if (lx === CHUNK_SIZE_X - 1 && lz === 0) this.markDirty(cx + 1, cz - 1);
    else if (lx === CHUNK_SIZE_X - 1 && lz === CHUNK_SIZE_Z - 1) this.markDirty(cx + 1, cz + 1);

    if (this.batchDepth > 0) {
      if (this.batchTouched.indexOf(rec.key) < 0) this.batchTouched.push(rec.key);
    } else if (this.onSetBlock !== null) {
      this.onSetBlock(x, y, z, id);
    }
    return true;
  }

  private recomputeMaxY(rec: ChunkRecord, from: number): number {
    const v = rec.voxels;
    for (let y = from; y >= 0; y--) {
      const base = y << 10;
      for (let i = base, end = base + 1024; i < end; i++) if (v[i] !== 0) return y;
    }
    return -1;
  }

  /** Topmost non-air block at a column, or -1. Used for spawn placement and the minimap. */
  highestSolidY(x: number, z: number): number {
    const cx = x >> CHUNK_SIZE_BITS;
    const cz = z >> CHUNK_SIZE_BITS;
    const rec = this.chunks.get(chunkKey(cx, cz));
    if (rec === undefined) return -1;
    const v = rec.voxels;
    const col = (x & CHUNK_SIZE_MASK) | ((z & CHUNK_SIZE_MASK) << CHUNK_SIZE_BITS);
    const top = rec.maxY < 0 ? -1 : rec.maxY;
    for (let y = top; y >= 0; y--) {
      if (v[col | (y << 10)] !== 0) return y;
    }
    return -1;
  }

  /** Topmost *solid* (walkable) block at a column, skipping water and lava. */
  highestGroundY(x: number, z: number): number {
    const cx = x >> CHUNK_SIZE_BITS;
    const cz = z >> CHUNK_SIZE_BITS;
    const rec = this.chunks.get(chunkKey(cx, cz));
    if (rec === undefined) return -1;
    const v = rec.voxels;
    const col = (x & CHUNK_SIZE_MASK) | ((z & CHUNK_SIZE_MASK) << CHUNK_SIZE_BITS);
    const top = rec.maxY < 0 ? -1 : rec.maxY;
    for (let y = top; y >= 0; y--) {
      if (BLOCK_SOLID[v[col | (y << 10)]] === 1) return y;
    }
    return -1;
  }

  /* -------------------------------------------------------------------- *
   * Raycast
   * -------------------------------------------------------------------- */

  /**
   * DDA through the grid using the SHARED implementation — never reimplement
   * this locally or client hit registration drifts from the server's.
   */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
    out: VoxelHit,
    blocking: (id: number) => boolean = this.blockingAt,
  ): boolean {
    return raycastVoxels(ox, oy, oz, dx, dy, dz, maxDist, this.sampleBlock, blocking, out);
  }

  /* -------------------------------------------------------------------- *
   * Dirty tracking
   * -------------------------------------------------------------------- */

  markDirty(cx: number, cz: number): void {
    const rec = this.chunks.get(chunkKey(cx, cz));
    if (rec !== undefined) this.markDirtyRecord(rec);
  }

  private markDirtyRecord(rec: ChunkRecord): void {
    if (rec.dirty) return;
    rec.dirty = true;
    this.dirtyList.push(rec.key);
  }

  /** Mark the 8 chunks around (cx, cz) — used when a chunk first arrives. */
  markNeighboursDirty(cx: number, cz: number): void {
    this.markDirty(cx - 1, cz);
    this.markDirty(cx + 1, cz);
    this.markDirty(cx, cz - 1);
    this.markDirty(cx, cz + 1);
    this.markDirty(cx - 1, cz - 1);
    this.markDirty(cx + 1, cz - 1);
    this.markDirty(cx - 1, cz + 1);
    this.markDirty(cx + 1, cz + 1);
  }

  /** Mark the chunks a single world-space block edit can have made stale. */
  markBlockDirty(x: number, y: number, z: number): void {
    if (y < 0 || y >= CHUNK_HEIGHT) return;
    const cx = blockToChunk(x);
    const cz = blockToChunk(z);
    const lx = x & CHUNK_SIZE_MASK;
    const lz = z & CHUNK_SIZE_MASK;
    this.markDirty(cx, cz);
    if (lx === 0) this.markDirty(cx - 1, cz);
    else if (lx === CHUNK_SIZE_X - 1) this.markDirty(cx + 1, cz);
    if (lz === 0) this.markDirty(cx, cz - 1);
    else if (lz === CHUNK_SIZE_Z - 1) this.markDirty(cx, cz + 1);
    if (lx === 0 && lz === 0) this.markDirty(cx - 1, cz - 1);
    else if (lx === 0 && lz === CHUNK_SIZE_Z - 1) this.markDirty(cx - 1, cz + 1);
    else if (lx === CHUNK_SIZE_X - 1 && lz === 0) this.markDirty(cx + 1, cz - 1);
    else if (lx === CHUNK_SIZE_X - 1 && lz === CHUNK_SIZE_Z - 1) this.markDirty(cx + 1, cz + 1);
  }

  get dirtyCount(): number { return this.dirtyList.length - this.dirtyHead; }

  /**
   * Pop up to `max` dirty chunk keys into `out` and clear their flags.
   * Returns how many were written. `out` must be at least `max` long.
   */
  takeDirty(out: Int32Array | number[], max: number): number {
    const list = this.dirtyList;
    let written = 0;
    while (written < max && this.dirtyHead < list.length) {
      const key = list[this.dirtyHead++];
      const rec = this.chunks.get(key);
      if (rec === undefined) continue;
      rec.dirty = false;
      out[written++] = key;
    }
    if (this.dirtyHead >= list.length) { list.length = 0; this.dirtyHead = 0; }
    else if (this.dirtyHead > 256) { list.splice(0, this.dirtyHead); this.dirtyHead = 0; }
    return written;
  }

  /** Clear the dirty queue without remeshing — only for teardown. */
  dropDirty(): void {
    for (let i = this.dirtyHead; i < this.dirtyList.length; i++) {
      const rec = this.chunks.get(this.dirtyList[i]);
      if (rec !== undefined) rec.dirty = false;
    }
    this.dirtyList.length = 0;
    this.dirtyHead = 0;
  }

  /* -------------------------------------------------------------------- *
   * Padded neighbourhood extraction — the mesher's whole input
   * -------------------------------------------------------------------- */

  /**
   * True when every one of the 8 surrounding chunks is either loaded or outside
   * the world. The mesh scheduler should defer a chunk that fails this so it is
   * not meshed twice (once with air seams, once for real).
   */
  hasAllNeighbours(cx: number, cz: number): boolean {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx, nz = cz + dz;
        if (!this.inWorld(nx, nz)) continue;
        const rec = this.chunks.get(chunkKey(nx, nz));
        if (rec === undefined || !rec.loaded) return false;
      }
    }
    return true;
  }

  /**
   * Fill `out` (NB_VOLUME bytes) with the chunk plus a one-voxel skin of its
   * neighbours, indexed by `nbIndex`. Returns false when the centre chunk is
   * missing.
   *
   * Conventions the mesher relies on:
   *   - y = -1 is BEDROCK, so the world floor never emits downward faces.
   *   - y = CHUNK_HEIGHT is AIR, so the top layer does emit upward faces.
   *   - a missing or out-of-world horizontal neighbour is AIR, so the rim of
   *     the arena renders as a cliff face rather than an invisible seam.
   */
  extractNeighbourhood(cx: number, cz: number, out: Uint8Array): boolean {
    const centre = this.chunks.get(chunkKey(cx, cz));
    if (centre === undefined) return false;

    out.fill(0);
    // Bedrock skin under the world.
    out.fill(BlockId.BEDROCK, 0, NB_STRIDE_Y);

    const src = centre.voxels;
    // Centre body: 32 contiguous source bytes map to 32 contiguous dest bytes.
    for (let y = 0; y < CHUNK_HEIGHT; y++) {
      const sy = y << 10;
      const dy = (y + NB_PAD) * NB_STRIDE_Y;
      for (let z = 0; z < CHUNK_SIZE_Z; z++) {
        let s = sy + (z << CHUNK_SIZE_BITS);
        let d = dy + (z + NB_PAD) * NB_STRIDE_Z + NB_PAD;
        for (let x = 0; x < CHUNK_SIZE_X; x++) out[d + x] = src[s + x];
      }
    }

    // -X face: neighbour's x = 31 column becomes pad x = -1.
    this.copyFaceX(cx - 1, cz, CHUNK_SIZE_X - 1, -1, out);
    // +X face: neighbour's x = 0 column becomes pad x = 32.
    this.copyFaceX(cx + 1, cz, 0, CHUNK_SIZE_X, out);
    // -Z face.
    this.copyFaceZ(cx, cz - 1, CHUNK_SIZE_Z - 1, -1, out);
    // +Z face.
    this.copyFaceZ(cx, cz + 1, 0, CHUNK_SIZE_Z, out);

    // Four vertical corner columns (needed for AO on the chunk's corner voxels).
    this.copyCorner(cx - 1, cz - 1, CHUNK_SIZE_X - 1, CHUNK_SIZE_Z - 1, -1, -1, out);
    this.copyCorner(cx + 1, cz - 1, 0, CHUNK_SIZE_Z - 1, CHUNK_SIZE_X, -1, out);
    this.copyCorner(cx - 1, cz + 1, CHUNK_SIZE_X - 1, 0, -1, CHUNK_SIZE_Z, out);
    this.copyCorner(cx + 1, cz + 1, 0, 0, CHUNK_SIZE_X, CHUNK_SIZE_Z, out);

    return true;
  }

  private copyFaceX(ncx: number, ncz: number, srcX: number, dstX: number, out: Uint8Array): void {
    const rec = this.chunks.get(chunkKey(ncx, ncz));
    if (rec === undefined) return;
    const src = rec.voxels;
    for (let y = 0; y < CHUNK_HEIGHT; y++) {
      const sy = y << 10;
      const dy = (y + NB_PAD) * NB_STRIDE_Y;
      for (let z = 0; z < CHUNK_SIZE_Z; z++) {
        out[dy + (z + NB_PAD) * NB_STRIDE_Z + (dstX + NB_PAD)] = src[sy + (z << CHUNK_SIZE_BITS) + srcX];
      }
    }
  }

  private copyFaceZ(ncx: number, ncz: number, srcZ: number, dstZ: number, out: Uint8Array): void {
    const rec = this.chunks.get(chunkKey(ncx, ncz));
    if (rec === undefined) return;
    const src = rec.voxels;
    const srcRow = srcZ << CHUNK_SIZE_BITS;
    for (let y = 0; y < CHUNK_HEIGHT; y++) {
      const sy = (y << 10) + srcRow;
      const dy = (y + NB_PAD) * NB_STRIDE_Y + (dstZ + NB_PAD) * NB_STRIDE_Z + NB_PAD;
      for (let x = 0; x < CHUNK_SIZE_X; x++) out[dy + x] = src[sy + x];
    }
  }

  private copyCorner(
    ncx: number, ncz: number, srcX: number, srcZ: number,
    dstX: number, dstZ: number, out: Uint8Array,
  ): void {
    const rec = this.chunks.get(chunkKey(ncx, ncz));
    if (rec === undefined) return;
    const src = rec.voxels;
    const s0 = (srcZ << CHUNK_SIZE_BITS) + srcX;
    const d0 = (dstZ + NB_PAD) * NB_STRIDE_Z + (dstX + NB_PAD);
    for (let y = 0; y < CHUNK_HEIGHT; y++) {
      out[(y + NB_PAD) * NB_STRIDE_Y + d0] = src[(y << 10) + s0];
    }
  }

  /* -------------------------------------------------------------------- *
   * Iteration helpers for the renderer
   * -------------------------------------------------------------------- */

  /** Visit every loaded chunk. The callback must not add or remove chunks. */
  forEachChunk(fn: (rec: ChunkRecord) => void): void {
    for (const rec of this.chunks.values()) fn(rec);
  }

  /** Decode a chunk key without allocating. */
  static keyCX(key: number): number { return chunkKeyCX(key); }
  static keyCZ(key: number): number { return chunkKeyCZ(key); }
}
