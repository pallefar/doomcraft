/**
 * DOOMCRAFT — authoritative server world.
 *
 * Owns every voxel. The client never generates terrain: it receives S2C.CHUNK
 * and applies S2C.BLOCK_DELTA. Everything in here is deterministic in the seed
 * so a replay, a bot and a rented match all produce byte-identical worlds.
 *
 * Nothing in this file touches node:*, `ws` or the DOM — it runs unchanged
 * inside the client's local-server Web Worker.
 */

import {
  BEDROCK_LEVEL,
  BLOCK_HARDNESS,
  BLOCK_SOLID,
  BlockId,
  CHUNK_HEIGHT,
  CHUNK_SIZE,
  CHUNK_SIZE_MASK,
  CHUNK_VOLUME,
  REACH_BREAK,
  REACH_PLACE,
  SEA_LEVEL,
  WORLD_CHUNK_COUNT,
  WORLD_MAX_BLOCK_X,
  WORLD_MAX_CHUNK,
  WORLD_MIN_BLOCK_X,
  WORLD_MIN_BLOCK_Z,
  WORLD_MIN_CHUNK,
  WORLD_SIZE_BLOCKS,
  blockToChunk,
  chunkInWorld,
  chunkKey,
  chunkKeyCX,
  chunkKeyCZ,
  clamp,
  isPlaceable,
  voxelIndex,
} from '@doomcraft/shared';
import {
  BlockAction,
  Rng,
  hash2i,
  seedChannel,
} from '@doomcraft/shared';
import {
  generateChunkInto,
  surfaceHeightAt,
  resetTerrainCaches,
  findSpawnPoints,
  nearestArena,
  TERRAIN_VERSION,
} from '@doomcraft/shared';
import type { SolidAt } from '@doomcraft/shared';
import { EditResult } from './sim.js';

export { EditResult, EDIT_RESULT_NAMES } from './sim.js';

/**
 * The shared generator this server was written against. A mismatch means the
 * level moved under us and every stamped structure is placed against the wrong
 * floor, so fail loudly at import rather than shipping a broken arena.
 */
const EXPECTED_TERRAIN_VERSION = 1;

/** Arena spawn candidates requested from the shared generator, before validation. */
const SPAWN_CANDIDATES = 96;

/** Distance past which a spawn stops being "further from the enemy", metres. */
const SPAWN_SPREAD = 55;
if (TERRAIN_VERSION !== EXPECTED_TERRAIN_VERSION) {
  throw new Error(
    `worldgen mismatch: shared terrain v${TERRAIN_VERSION}, server expects v${EXPECTED_TERRAIN_VERSION}`,
  );
}

/** Blocks an explosion is allowed to remove. Obsidian and bedrock survive. */
const TERRAIN_CARVE_MAX_HARDNESS = 7.5;

/* ------------------------------------------------------------------------ *
 * Block change journal
 * ------------------------------------------------------------------------ */

/**
 * Every voxel the server changed since the journal was last drained.
 * Struct-of-arrays, grows by doubling, never shrinks — the steady state is
 * allocation free.
 */
export class BlockJournal {
  count = 0;
  x: Int16Array;
  y: Uint8Array;
  z: Int16Array;
  id: Uint8Array;
  /** Player id that caused the change, 0 for the world itself. */
  by: Uint16Array;

  constructor(capacity = 1024) {
    this.x = new Int16Array(capacity);
    this.y = new Uint8Array(capacity);
    this.z = new Int16Array(capacity);
    this.id = new Uint8Array(capacity);
    this.by = new Uint16Array(capacity);
  }

  get capacity(): number { return this.x.length; }

  reset(): void { this.count = 0; }

  push(x: number, y: number, z: number, id: number, by: number): void {
    if (this.count >= this.x.length) this.grow();
    const i = this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.id[i] = id;
    this.by[i] = by;
  }

  private grow(): void {
    const n = this.x.length * 2;
    const nx = new Int16Array(n); nx.set(this.x); this.x = nx;
    const ny = new Uint8Array(n); ny.set(this.y); this.y = ny;
    const nz = new Int16Array(n); nz.set(this.z); this.z = nz;
    const ni = new Uint8Array(n); ni.set(this.id); this.id = ni;
    const nb = new Uint16Array(n); nb.set(this.by); this.by = nb;
  }
}

/* ------------------------------------------------------------------------ *
 * World
 * ------------------------------------------------------------------------ */

const HALF_WORLD = WORLD_SIZE_BLOCKS / 2;
const WORLD_CENTRE = (WORLD_MIN_BLOCK_X + WORLD_MAX_BLOCK_X) / 2;

/** Grid pitch of the arena structures, in blocks. */
const STRUCT_GRID = 48;

/** Ordered spiral of chunk keys from the world centre outward. */
function buildSpiral(): Int32Array {
  const out = new Int32Array(WORLD_CHUNK_COUNT);
  let n = 0;
  for (let r = 0; r <= WORLD_MAX_CHUNK; r++) {
    for (let cz = -r; cz <= r; cz++) {
      for (let cx = -r; cx <= r; cx++) {
        if (Math.max(Math.abs(cx), Math.abs(cz)) !== r) continue;
        out[n++] = chunkKey(cx, cz);
      }
    }
  }
  return out;
}

const SPIRAL = buildSpiral();

export interface SpawnPoint { x: number; y: number; z: number; yaw: number }

export class ServerWorld {
  seed: number;
  /** chunkKey -> 32x64x32 voxels, index = x | (z<<5) | (y<<10). */
  readonly chunks = new Map<number, Uint8Array>();
  /** Topmost solid block y per world column, -1 when the column is empty. */
  readonly surface = new Int16Array(WORLD_SIZE_BLOCKS * WORLD_SIZE_BLOCKS);
  /** Bumped whenever the world is regenerated so caches can invalidate. */
  generation = 0;
  /** Monotonic counter of applied voxel changes. */
  editSerial = 0;
  /** Every change since the journal was drained. */
  readonly journal = new BlockJournal();

  /** Bound predicates — created once, never per call. */
  readonly solidAt: SolidAt;
  readonly opaqueAt: SolidAt;
  readonly getBlockAt: (x: number, y: number, z: number) => number;

  private lastKey = -1;
  private lastChunk: Uint8Array | null = null;
  private spiralCursor = 0;
  private structSeed = 0;
  private spawnCache: Float64Array | null = null;
  private readonly arenaScratch = new Float64Array(5);
  private readonly rng = new Rng(1);
  private readonly scratchColumn = new Int16Array(CHUNK_SIZE * CHUNK_SIZE);

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.deriveSeeds();
    this.surface.fill(-1);
    this.solidAt = (x: number, y: number, z: number): boolean => BLOCK_SOLID[this.getBlock(x, y, z)] === 1;
    this.opaqueAt = (x: number, y: number, z: number): boolean => {
      const id = this.getBlock(x, y, z);
      return BLOCK_SOLID[id] === 1 && id !== BlockId.GLASS && id !== BlockId.LEAVES;
    };
    this.getBlockAt = (x: number, y: number, z: number): number => this.getBlock(x, y, z);
  }

  private deriveSeeds(): void {
    // The shared generator memoises per-column work per seed.
    resetTerrainCaches();
    this.spawnCache = null;
    this.structSeed = seedChannel(this.seed, 6);
  }

  /** Throw the world away and start again from a new seed. */
  reset(seed: number): void {
    this.seed = seed >>> 0;
    this.deriveSeeds();
    this.chunks.clear();
    this.surface.fill(-1);
    this.lastKey = -1;
    this.lastChunk = null;
    this.spiralCursor = 0;
    this.editSerial = 0;
    this.journal.reset();
    this.generation++;
  }

  /* -------------------------------------------------------------- *
   * Voxel access
   * -------------------------------------------------------------- */

  /**
   * Block id at world coordinates. Outside the world box this returns BEDROCK,
   * which makes the arena a sealed room without a special case in the
   * collision code. Above the world it returns AIR.
   */
  getBlock(x: number, y: number, z: number): number {
    if (y < 0) return BlockId.BEDROCK;
    if (y >= CHUNK_HEIGHT) return BlockId.AIR;
    const cx = blockToChunk(x);
    const cz = blockToChunk(z);
    if (cx < WORLD_MIN_CHUNK || cx > WORLD_MAX_CHUNK || cz < WORLD_MIN_CHUNK || cz > WORLD_MAX_CHUNK) {
      return BlockId.BEDROCK;
    }
    const key = chunkKey(cx, cz);
    let chunk: Uint8Array | null | undefined = key === this.lastKey ? this.lastChunk : this.chunks.get(key);
    if (chunk === undefined || chunk === null) chunk = this.ensureChunk(cx, cz);
    this.lastKey = key;
    this.lastChunk = chunk;
    return chunk[voxelIndex(x & CHUNK_SIZE_MASK, y, z & CHUNK_SIZE_MASK)];
  }

  /** True when the block at these coordinates stops movement. */
  isSolid(x: number, y: number, z: number): boolean {
    return BLOCK_SOLID[this.getBlock(x, y, z)] === 1;
  }

  /**
   * Write a voxel with no validation and journal the change. Returns true when
   * something actually changed.
   */
  setBlock(x: number, y: number, z: number, id: number, by: number): boolean {
    if (y < 0 || y >= CHUNK_HEIGHT) return false;
    const cx = blockToChunk(x);
    const cz = blockToChunk(z);
    if (!chunkInWorld(cx, cz)) return false;
    const chunk = this.ensureChunk(cx, cz);
    const idx = voxelIndex(x & CHUNK_SIZE_MASK, y, z & CHUNK_SIZE_MASK);
    if (chunk[idx] === id) return false;
    chunk[idx] = id;
    this.editSerial++;
    this.journal.push(x, y, z, id, by);
    this.touchSurface(x, y, z, id);
    return true;
  }

  private touchSurface(x: number, y: number, z: number, id: number): void {
    const si = this.surfaceIndex(x, z);
    if (si < 0) return;
    const cur = this.surface[si];
    if (BLOCK_SOLID[id] === 1) {
      if (y > cur) this.surface[si] = y;
      return;
    }
    if (y === cur) {
      let ny = y - 1;
      while (ny >= 0 && BLOCK_SOLID[this.getBlock(x, ny, z)] !== 1) ny--;
      this.surface[si] = ny;
    }
  }

  private surfaceIndex(x: number, z: number): number {
    const ix = x - WORLD_MIN_BLOCK_X;
    const iz = z - WORLD_MIN_BLOCK_Z;
    if (ix < 0 || iz < 0 || ix >= WORLD_SIZE_BLOCKS || iz >= WORLD_SIZE_BLOCKS) return -1;
    return ix + iz * WORLD_SIZE_BLOCKS;
  }

  /** Topmost solid block in a column, or -1. Generates the chunk if needed. */
  surfaceY(x: number, z: number): number {
    const si = this.surfaceIndex(x, z);
    if (si < 0) return -1;
    const cx = blockToChunk(x);
    const cz = blockToChunk(z);
    if (!this.chunks.has(chunkKey(cx, cz))) this.ensureChunk(cx, cz);
    return this.surface[si];
  }

  /**
   * Topmost solid block in a column WITHOUT forcing generation. Returns -1 when
   * the chunk is not built yet — navigation treats that as impassable rather
   * than stalling on a 169-chunk generate.
   */
  surfaceKnown(x: number, z: number): number {
    const si = this.surfaceIndex(x, z);
    if (si < 0) return -1;
    if (!this.chunks.has(chunkKey(blockToChunk(x), blockToChunk(z)))) return -1;
    return this.surface[si];
  }

  /** True when the chunk has already been generated. */
  hasChunk(cx: number, cz: number): boolean {
    return this.chunks.has(chunkKey(cx, cz));
  }

  /** Chunk voxels, generating on demand. */
  ensureChunk(cx: number, cz: number): Uint8Array {
    const key = chunkKey(cx, cz);
    const existing = this.chunks.get(key);
    if (existing !== undefined) return existing;
    const chunk = new Uint8Array(CHUNK_VOLUME);
    this.chunks.set(key, chunk);
    this.generateChunk(cx, cz, chunk);
    return chunk;
  }

  /** Generate every chunk in the world. ~200 ms for the 169-chunk arena. */
  generateAll(): void {
    for (let i = 0; i < SPIRAL.length; i++) {
      const key = SPIRAL[i];
      if (!this.chunks.has(key)) this.ensureChunk(chunkKeyCX(key), chunkKeyCZ(key));
    }
    this.spiralCursor = SPIRAL.length;
  }

  /**
   * Generate at most `maxChunks` not-yet-built chunks in spiral order from the
   * centre. Returns the number generated; 0 means the world is complete. This
   * is what keeps a cold start under the interactive budget: the spawn area
   * exists in the first few milliseconds and the rim fills in behind it.
   */
  pumpGeneration(maxChunks: number): number {
    let made = 0;
    while (made < maxChunks && this.spiralCursor < SPIRAL.length) {
      const key = SPIRAL[this.spiralCursor++];
      if (this.chunks.has(key)) continue;
      this.ensureChunk(chunkKeyCX(key), chunkKeyCZ(key));
      made++;
    }
    return made;
  }

  get generatedChunks(): number { return this.chunks.size; }
  get isComplete(): boolean { return this.chunks.size >= WORLD_CHUNK_COUNT; }

  /* -------------------------------------------------------------- *
   * Terrain generation
   * -------------------------------------------------------------- */

  /**
   * Surface height of a column, straight from the shared generator. This is the
   * same function the client's sandbox and every structure placement below use,
   * so a tower always lands on the floor the player actually walks on.
   */
  columnHeight(wx: number, wz: number): number {
    return surfaceHeightAt(this.seed, wx, wz);
  }

  /**
   * Build one chunk.
   *
   * The terrain comes from `shared/src/terrain.ts` — terraced height so a riser
   * reads as a wall, arenas stamped on a 64-block lattice and joined by
   * corridors, three themes, lava pits. That generator is shared precisely so
   * the client's offline sandbox and this server cannot disagree about a voxel.
   *
   * On top of it this file stamps the arena furniture (platforms, towers,
   * cover) the server owns, then rebuilds the surface index.
   */
  private generateChunk(cx: number, cz: number, out: Uint8Array): void {
    generateChunkInto(this.seed, cx, cz, out);
    this.stampStructures(cx, cz, out);
    this.refreshSurfaceForChunk(cx, cz, out);
  }

  /**
   * Arena furniture: raised platforms on pillars, cover walls and neon strips.
   * Placed on a fixed 48-block grid so a chunk can stamp only the cells that
   * reach into it, with no global pass.
   */
  private stampStructures(cx: number, cz: number, out: Uint8Array): void {
    const bx0 = cx * CHUNK_SIZE;
    const bz0 = cz * CHUNK_SIZE;
    const g0x = Math.floor((bx0 - STRUCT_GRID) / STRUCT_GRID);
    const g1x = Math.floor((bx0 + CHUNK_SIZE + STRUCT_GRID) / STRUCT_GRID);
    const g0z = Math.floor((bz0 - STRUCT_GRID) / STRUCT_GRID);
    const g1z = Math.floor((bz0 + CHUNK_SIZE + STRUCT_GRID) / STRUCT_GRID);

    for (let gz = g0z; gz <= g1z; gz++) {
      for (let gx = g0x; gx <= g1x; gx++) {
        const h = hash2i(gx, gz, this.structSeed);
        if ((h & 0xff) > 168) continue;               // ~66% of cells carry something
        const ox = gx * STRUCT_GRID + 8 + ((h >>> 8) % 26);
        const oz = gz * STRUCT_GRID + 8 + ((h >>> 14) % 26);
        const kind = (h >>> 20) % 3;
        const ground = this.columnHeight(ox, oz);
        if (ground <= SEA_LEVEL - 2) continue;
        // Arenas are already furnished by the shared generator — plinth, cover,
        // rim ledge, pillars. Dropping a tower on top of that buries the
        // fighting space and, worse, buries spawns. Structures live on the
        // terraced ground BETWEEN arenas.
        nearestArena(this.seed, ox, oz, this.arenaScratch);
        const adx = ox - this.arenaScratch[0];
        const adz = oz - this.arenaScratch[1];
        const keepOut = this.arenaScratch[2] + 6;
        if (adx * adx + adz * adz < keepOut * keepOut) continue;
        if (kind === 0) this.stampPlatform(cx, cz, out, ox, ground, oz, 5 + ((h >>> 24) % 3));
        else if (kind === 1) this.stampTower(cx, cz, out, ox, ground, oz);
        else this.stampCover(cx, cz, out, ox, ground, oz);
      }
    }
  }

  private stampPlatform(cx: number, cz: number, out: Uint8Array, ox: number, ground: number, oz: number, rad: number): void {
    const deck = ground + 6;
    if (deck >= CHUNK_HEIGHT - 3) return;
    for (let dz = -rad; dz <= rad; dz++) {
      for (let dx = -rad; dx <= rad; dx++) {
        this.putLocal(cx, cz, out, ox + dx, deck, oz + dz, BlockId.TECH_PANEL);
        const edge = Math.abs(dx) === rad || Math.abs(dz) === rad;
        if (edge && ((dx + dz) & 1) === 0) {
          this.putLocal(cx, cz, out, ox + dx, deck + 1, oz + dz, BlockId.RUSTED_METAL);
        }
      }
    }
    for (const [px, pz] of [[-rad + 1, -rad + 1], [rad - 1, -rad + 1], [-rad + 1, rad - 1], [rad - 1, rad - 1]]) {
      for (let y = ground; y < deck; y++) {
        this.putLocal(cx, cz, out, ox + px, y, oz + pz, BlockId.METAL);
      }
    }
    this.putLocal(cx, cz, out, ox, deck + 1, oz, BlockId.NEON);
  }

  private stampTower(cx: number, cz: number, out: Uint8Array, ox: number, ground: number, oz: number): void {
    const top = Math.min(CHUNK_HEIGHT - 4, ground + 11);
    for (let y = ground; y <= top; y++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ring = Math.abs(dx) === 2 || Math.abs(dz) === 2;
          if (!ring && y !== top) continue;
          const id = y === top ? BlockId.TECH_PANEL : BlockId.RUSTED_METAL;
          this.putLocal(cx, cz, out, ox + dx, y, oz + dz, id);
        }
      }
    }
    // A ramp of steps so the tower is reachable without a rocket jump.
    for (let i = 0; i < 12; i++) {
      const y = ground + i;
      if (y > top) break;
      this.putLocal(cx, cz, out, ox + 3, y, oz - 2 + i, BlockId.METAL);
    }
    this.putLocal(cx, cz, out, ox, top + 1, oz, BlockId.NEON);
  }

  private stampCover(cx: number, cz: number, out: Uint8Array, ox: number, ground: number, oz: number): void {
    const len = 7;
    const vertical = (hash2i(ox, oz, this.structSeed ^ 0x3131) & 1) === 0;
    for (let i = -len; i <= len; i++) {
      const wx = vertical ? ox : ox + i;
      const wz = vertical ? oz + i : oz;
      const h = this.columnHeight(wx, wz);
      for (let y = h; y < h + 3; y++) {
        if ((i & 3) === 3 && y === h + 2) continue;   // crenellations to shoot through
        this.putLocal(cx, cz, out, wx, y, wz, BlockId.BRICK);
      }
    }
  }

  /** Write a voxel only when it falls inside the chunk currently being built. */
  private putLocal(cx: number, cz: number, out: Uint8Array, wx: number, wy: number, wz: number, id: number): void {
    if (wy < 1 || wy >= CHUNK_HEIGHT) return;
    const lx = wx - cx * CHUNK_SIZE;
    const lz = wz - cz * CHUNK_SIZE;
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) return;
    out[voxelIndex(lx, wy, lz)] = id;
  }

  private refreshSurfaceForChunk(cx: number, cz: number, chunk: Uint8Array): void {
    const bx0 = cx * CHUNK_SIZE;
    const bz0 = cz * CHUNK_SIZE;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        let top = -1;
        for (let y = CHUNK_HEIGHT - 1; y >= 0; y--) {
          if (BLOCK_SOLID[chunk[voxelIndex(lx, y, lz)]] === 1) { top = y; break; }
        }
        const si = this.surfaceIndex(bx0 + lx, bz0 + lz);
        if (si >= 0) this.surface[si] = top;
      }
    }
  }

  /* -------------------------------------------------------------- *
   * Edits
   * -------------------------------------------------------------- */

  /**
   * Validate a player's block edit. The rate limit and the "is a player
   * standing there" test live in the simulation, which owns those; everything
   * geometric is decided here so the client can run the same check locally.
   */
  validateEdit(
    eyeX: number, eyeY: number, eyeZ: number,
    action: number, x: number, y: number, z: number, blockId: number,
  ): EditResult {
    if (y < 1 || y >= CHUNK_HEIGHT) return EditResult.OUT_OF_WORLD;
    const cx = blockToChunk(x);
    const cz = blockToChunk(z);
    if (!chunkInWorld(cx, cz)) return EditResult.OUT_OF_WORLD;

    // Reach is measured to the nearest point of the target cube, which is what
    // the player's crosshair actually touched.
    const nx = eyeX < x ? x : (eyeX > x + 1 ? x + 1 : eyeX);
    const ny = eyeY < y ? y : (eyeY > y + 1 ? y + 1 : eyeY);
    const nz = eyeZ < z ? z : (eyeZ > z + 1 ? z + 1 : eyeZ);
    const dx = eyeX - nx, dy = eyeY - ny, dz = eyeZ - nz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const reach = action === BlockAction.PLACE ? REACH_PLACE : REACH_BREAK;
    if (dist > reach) return EditResult.OUT_OF_REACH;

    const current = this.getBlock(x, y, z);
    if (action === BlockAction.BREAK) {
      if (current === BlockId.AIR) return EditResult.NO_CHANGE;
      if (BLOCK_HARDNESS[current] < 0) return EditResult.UNBREAKABLE;
      return EditResult.OK;
    }

    if (!isPlaceable(blockId)) return EditResult.NOT_PLACEABLE;
    if (current === blockId) return EditResult.NO_CHANGE;
    if (BLOCK_SOLID[current] === 1) return EditResult.OCCUPIED;
    return EditResult.OK;
  }

  /** Apply a validated edit. Returns the result of validation. */
  applyEdit(
    playerId: number,
    eyeX: number, eyeY: number, eyeZ: number,
    action: number, x: number, y: number, z: number, blockId: number,
  ): EditResult {
    const check = this.validateEdit(eyeX, eyeY, eyeZ, action, x, y, z, blockId);
    if (check !== EditResult.OK) return check;
    const id = action === BlockAction.PLACE ? blockId : BlockId.AIR;
    this.setBlock(x, y, z, id, playerId);
    return EditResult.OK;
  }

  /**
   * Blow a spherical hole in the world. Obsidian and bedrock survive, water and
   * lava are left alone so seas do not evaporate. Returns the block count removed.
   */
  carveSphere(cxf: number, cyf: number, czf: number, radius: number, by: number): number {
    if (radius <= 0) return 0;
    const r2 = radius * radius;
    const x0 = Math.floor(cxf - radius), x1 = Math.floor(cxf + radius);
    const y0 = Math.floor(cyf - radius), y1 = Math.floor(cyf + radius);
    const z0 = Math.floor(czf - radius), z1 = Math.floor(czf + radius);
    let removed = 0;
    for (let y = y0; y <= y1; y++) {
      if (y < 1 || y >= CHUNK_HEIGHT) continue;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - cxf, dy = y + 0.5 - cyf, dz = z + 0.5 - czf;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2) continue;
          const id = this.getBlock(x, y, z);
          if (id === BlockId.AIR || id === BlockId.WATER || id === BlockId.LAVA) continue;
          const hard = BLOCK_HARDNESS[id];
          if (hard < 0 || hard > TERRAIN_CARVE_MAX_HARDNESS) continue;
          // Feathered edge: the outer shell only partly crumbles, which reads
          // far better than a perfect sphere.
          if (d2 > r2 * 0.55) {
            const keep = hash2i(x * 31 + y, z * 17 + y, this.editSerial | 0) & 3;
            if (keep === 0) continue;
          }
          if (this.setBlock(x, y, z, BlockId.AIR, by)) removed++;
        }
      }
    }
    return removed;
  }

  /* -------------------------------------------------------------- *
   * Spawning
   * -------------------------------------------------------------- */

  /**
   * A standable spot near (x, z). Returns the feet-centre y, or -1 when the
   * column cannot hold a player.
   */
  standableY(x: number, z: number): number {
    const top = this.surfaceY(x, z);
    if (top < 1) return -1;
    const ground = this.getBlock(x, top, z);
    if (ground === BlockId.LAVA || ground === BlockId.WATER) return -1;
    for (let y = top + 1; y <= top + 3; y++) {
      if (BLOCK_SOLID[this.getBlock(x, y, z)] === 1) return -1;
    }
    if (top + 1 + 2 >= CHUNK_HEIGHT) return -1;
    return top + 1;
  }

  /**
   * Pick a spawn point. `avoid` is a flat [x,y,z,...] array of positions to stay
   * away from; the best of `tries` candidates by distance to the nearest one wins.
   */
  pickSpawn(out: SpawnPoint, avoid: Float64Array, avoidCount: number, seed: number, tries = 24): SpawnPoint {
    this.rng.reseed(seed >>> 0);
    out.x = 0.5; out.y = SEA_LEVEL + 4; out.z = 0.5; out.yaw = 0;

    const spots = this.arenaSpawns();
    let bestScore = -1;

    if (spots.length >= 3) {
      // Arena floors: open ground with a clear run in every direction, which is
      // what the terraced terrain does NOT give you on a random column.
      for (let i = 0; i < spots.length; i += 4) {
        const x = spots[i], y = spots[i + 1], z = spots[i + 2], yaw = spots[i + 3];
        let nearest = 1e9;
        for (let a = 0; a < avoidCount; a++) {
          const dx = x - avoid[a * 3];
          const dy = y - avoid[a * 3 + 1];
          const dz = z - avoid[a * 3 + 2];
          const d = dx * dx + dy * dy * 0.4 + dz * dz;
          if (d < nearest) nearest = d;
        }
        // Cap the reward for distance. Pure "spawn as far away as possible" is
        // correct on a 60 m competitive map and disastrous on a 416 m one: it
        // parks eight players in eight corners and nobody ever meets. Past
        // SPAWN_SPREAD every candidate scores the same and the jitter decides,
        // so spawns spread over a neighbourhood instead of the whole world.
        if (nearest > SPAWN_SPREAD * SPAWN_SPREAD) nearest = SPAWN_SPREAD * SPAWN_SPREAD;
        const score = nearest + this.rng.next() * 900;
        if (score > bestScore) {
          bestScore = score;
          out.x = x; out.y = y; out.z = z; out.yaw = yaw;
        }
      }
      return out;
    }

    // Fallback: no arena survived validation (a tiny or heavily edited world).
    const limit = HALF_WORLD * 0.72;
    for (let i = 0; i < tries; i++) {
      const x = Math.round(WORLD_CENTRE + this.rng.range(-limit, limit));
      const z = Math.round(WORLD_CENTRE + this.rng.range(-limit, limit));
      const y = this.standableY(x, z);
      if (y < 0) continue;
      let nearest = 1e9;
      for (let a = 0; a < avoidCount; a++) {
        const dx = x + 0.5 - avoid[a * 3];
        const dy = y - avoid[a * 3 + 1];
        const dz = z + 0.5 - avoid[a * 3 + 2];
        const d = dx * dx + dy * dy * 0.4 + dz * dz;
        if (d < nearest) nearest = d;
      }
      const score = nearest + this.rng.next() * 40;
      if (score > bestScore) {
        bestScore = score;
        out.x = x + 0.5;
        out.y = y;
        out.z = z + 0.5;
        out.yaw = Math.atan2(-(WORLD_CENTRE - out.x), -(WORLD_CENTRE - out.z));
      }
      if (avoidCount === 0 && bestScore > 0) break;
    }
    return out;
  }

  /**
   * Validated arena spawn ring, as flat [x, y, z, yaw] quads.
   *
   * The shared generator knows where the arenas are but only knows their FLOOR
   * height — a pillar or a lava pit may occupy the square — so every candidate
   * is re-tested against the real voxels here, and the yaw is aimed at the
   * arena centre so a fresh spawn always has the longest open run in front of
   * it. Built once per seed; generating the chunk under a candidate is the
   * point, not a side effect.
   */
  private arenaSpawns(): Float64Array {
    if (this.spawnCache !== null) return this.spawnCache;
    const raw = new Float64Array(SPAWN_CANDIDATES * 3);
    const found = findSpawnPoints(this.seed, raw, SPAWN_CANDIDATES);
    const arena = new Float64Array(5);
    const kept: number[] = [];
    for (let i = 0; i < found; i++) {
      const x = Math.floor(raw[i * 3]);
      const z = Math.floor(raw[i * 3 + 2]);
      const y = this.standableY(x, z);
      if (y < 0) continue;
      // Reject ledges: a spawn wants floor around it, not a one-block perch.
      let open = 0;
      for (let dz = -2; dz <= 2; dz += 2) {
        for (let dx = -2; dx <= 2; dx += 2) {
          const ny = this.standableY(x + dx, z + dz);
          if (ny >= 0 && Math.abs(ny - y) <= 1) open++;
        }
      }
      if (open < 7) continue;
      // And it wants a room, not a broom cupboard: a wall pressed against the
      // camera is the worst possible first frame. Require open air at body
      // height for four blocks in every cardinal direction.
      let boxed = false;
      for (let d = 1; d <= 4 && !boxed; d++) {
        if (BLOCK_SOLID[this.getBlock(x + d, y + 1, z)] === 1
          && BLOCK_SOLID[this.getBlock(x - d, y + 1, z)] === 1
          && BLOCK_SOLID[this.getBlock(x, y + 1, z + d)] === 1
          && BLOCK_SOLID[this.getBlock(x, y + 1, z - d)] === 1) boxed = true;
      }
      if (boxed) continue;
      nearestArena(this.seed, x, z, arena);
      const yaw = Math.atan2(-(arena[0] - (x + 0.5)), -(arena[1] - (z + 0.5)));
      kept.push(x + 0.5, y, z + 0.5, yaw);
    }
    this.spawnCache = Float64Array.from(kept);
    return this.spawnCache;
  }

  /** Distance in blocks from a chunk to a world position — the interest metric. */
  static chunkDistance(cx: number, cz: number, x: number, z: number): number {
    const ccx = cx * CHUNK_SIZE + CHUNK_SIZE * 0.5;
    const ccz = cz * CHUNK_SIZE + CHUNK_SIZE * 0.5;
    const dx = ccx - x;
    const dz = ccz - z;
    return Math.sqrt(dx * dx + dz * dz);
  }
}

/** Clamp a world position back inside the arena. */
export function clampToWorld(v: number): number {
  return clamp(v, WORLD_MIN_BLOCK_X + 1.5, WORLD_MAX_BLOCK_X - 0.5);
}
