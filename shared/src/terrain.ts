/**
 * DOOMCRAFT — worldgen. SHARED, because the client and the server have to agree
 * on every voxel or prediction fights the authority.
 *
 * Authored as the client's reference generator and promoted into `shared/`
 * during integration: `server/src/world.ts` calls `generateChunkInto` and
 * `surfaceHeightAt` from here, so there is exactly one description of the level
 * in the repo. `client/src/world/terrain.ts` re-exports it for the offline
 * sandbox and for the tests that were written against it.
 */
/**
 * DOOMCRAFT — worldgen.
 *
 * This is the reference implementation. It is deterministic in `seed` alone and
 * imports nothing but its sibling shared modules, so the server generates
 * byte-identical chunks. Bump `TERRAIN_VERSION` on any change that moves a
 * single voxel and the two sides will notice they disagree.
 *
 * DESIGN — the bar (voxiom.io) generates *scenery*: an open beach that reads as
 * one flat mass with nothing to fight over (ref/BAR.md weakness #4, and
 * ref/voxiom/desktop-08-combat.png where the whole frame is sand and sky).
 * Doomcraft generates *fighting space*:
 *
 *   - Height is TERRACED, not smooth. A 3-block riser is above the 1.05 m
 *     step-up and above the 1.41 m jump apex, so terraces read as walls and the
 *     silhouette is legible at a glance.
 *   - An ARENA is stamped on a jittered 64-block lattice: a flat disc with a
 *     banked rim, a rim ledge you reach by a ramp of single-block stairs,
 *     chest-high cover, pillars and (43% of the time) a lava pit you can be
 *     knocked into. That is the room.
 *   - Every arena is joined to its +X and +Z neighbour by a CORRIDOR cut down
 *     to a blended floor. That is the connective tissue, and it guarantees the
 *     whole map is one connected graph even though the terraces are walls.
 *   - Three high-contrast themes — OUTLAND (grass/stone), TECH (metal/panel,
 *     neon-capped pillars) and HELL (hellstone/obsidian, lava) — so you always
 *     know which room you are in.
 *
 * Everything is evaluated per column from world coordinates. No global pass, no
 * cross-chunk state: chunk (7, -3) generates identically whether or not its
 * neighbours exist. Allocation is limited to module-level scratch created once.
 */

import {
  CHUNK_SIZE_X, CHUNK_SIZE_Z, CHUNK_HEIGHT, CHUNK_VOLUME,
  voxelIndex, clamp,
  SEA_LEVEL, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT, SOIL_DEPTH,
  TERRAIN_FREQ, TERRAIN_OCTAVES, TERRAIN_LACUNARITY, TERRAIN_GAIN, TERRAIN_DETAIL_FREQ,
  TREE_DENSITY, VENT_DENSITY,
  WORLD_MIN_BLOCK_X, WORLD_MAX_BLOCK_X, WORLD_MIN_BLOCK_Z, WORLD_MAX_BLOCK_Z,
} from './constants.ts';
import { BlockId } from './blocks.ts';
import {
  TAU, clampf, smootherstep, seedChannel, hash2i, hash3f,
  warpedFbm2, ridged2, fbm2,
} from './math.ts';

/** Any change that moves a voxel must bump this; the server asserts on it. */
export const TERRAIN_VERSION = 1;

/* ------------------------------------------------------------------------ *
 * Tunables — the shape of the level
 * ------------------------------------------------------------------------ */

/** Height quantisation. 3 is above both step-up (1.05) and jump apex (1.41). */
export const TERRACE_STEP = 3;
/**
 * How abrupt a terrace riser is. At 14 the transition occupies ~7% of a step, so
 * a slope collapses into flat shelves joined by near-vertical faces. Anything
 * under ~6 and the world reads as one smooth ramp — which is exactly what the
 * bar looks like and exactly what we are trying not to build.
 */
export const TERRACE_SHARPNESS = 14;
/**
 * Mid-scale relief, added on top of the continental fbm. TERRAIN_FREQ is 1/190
 * and the world is only 416 blocks across, so the base field is barely two noise
 * cells wide: without this layer the whole map is a single hill.
 */
const RELIEF_FREQ = 1 / 74;
const RELIEF_AMPLITUDE = 7.5;
/** Ridge (cliff and canyon) amplitude in blocks. */
const RIDGE_AMPLITUDE = 26;
/** Biome patch size. Also world-scale-aware: 1/95 gives ~8 patches per axis. */
const BIOME_FREQ = 1 / 95;
const BIOME_HELL_BELOW = -0.115;
const BIOME_TECH_ABOVE = 0.115;

/** Arena lattice pitch in blocks. 64 = one arena every two chunks. */
export const ARENA_CELL = 64;
const ARENA_CELL_BITS = 6;
/** Max displacement of an arena centre from its cell centre. */
export const ARENA_JITTER = 16;
export const ARENA_MIN_RADIUS = 14;
export const ARENA_MAX_RADIUS = 26;
/** Width of the banked lip around an arena floor. */
export const ARENA_RIM = 3;

export const CORRIDOR_HALF_WIDTH = 4;
export const CORRIDOR_RIM = 2;

/** Rim ledge: an annulus [R - LEDGE_OUTER, R - LEDGE_INNER] raised LEDGE_HEIGHT. */
const LEDGE_OUTER = 8;
const LEDGE_INNER = 4.5;
const LEDGE_HEIGHT = 3;
/** Fraction of the arena circumference each of the two stair ramps occupies. */
const LEDGE_RAMP_FRAC = 0.13;

const COVER_GRID = 5;
const PILLAR_GRID = 9;

/** Lava fills hell basins to here. Below SEA_LEVEL so lava and water never meet. */
export const LAVA_LEVEL = 22;
const SNOW_LEVEL = 46;

/* ------------------------------------------------------------------------ *
 * Themes
 * ------------------------------------------------------------------------ */

export enum Theme {
  OUTLAND = 0,
  TECH = 1,
  HELL = 2,
}

/** Deterministic theme at a world column. */
export function themeAt(seed: number, x: number, z: number): Theme {
  const n = fbm2(x * BIOME_FREQ, z * BIOME_FREQ, seedChannel(seed, 2), 3, TERRAIN_LACUNARITY, TERRAIN_GAIN);
  if (n < BIOME_HELL_BELOW) return Theme.HELL;
  if (n > BIOME_TECH_ABOVE) return Theme.TECH;
  return Theme.OUTLAND;
}

function coverMaterial(theme: Theme): number {
  return theme === Theme.HELL ? BlockId.HELLSTONE : theme === Theme.TECH ? BlockId.METAL : BlockId.COBBLESTONE;
}
function ledgeMaterial(theme: Theme): number {
  return theme === Theme.HELL ? BlockId.OBSIDIAN : theme === Theme.TECH ? BlockId.TECH_PANEL : BlockId.BRICK;
}
function pillarMaterial(theme: Theme): number {
  return theme === Theme.HELL ? BlockId.OBSIDIAN : theme === Theme.TECH ? BlockId.TECH_PANEL : BlockId.STONE;
}
/** Emissive cap so pillars double as the light sources the bar's flat world lacks. */
function pillarCap(theme: Theme): number {
  return theme === Theme.HELL ? BlockId.HELLSTONE : theme === Theme.TECH ? BlockId.NEON : BlockId.BONE;
}
function plinthMaterial(theme: Theme): number {
  return theme === Theme.HELL ? BlockId.HELLSTONE : theme === Theme.TECH ? BlockId.METAL : BlockId.BRICK;
}

/* ------------------------------------------------------------------------ *
 * Base height field
 * ------------------------------------------------------------------------ */

/** Quantise a height into flat terraces joined by short vertical risers. */
function terrace(h: number, step: number, sharpness: number): number {
  const q = h / step;
  const f = Math.floor(q);
  const frac = q - f;
  const t = smootherstep(clampf((frac - 0.5) * sharpness + 0.5, 0, 1));
  return (f + t) * step;
}

/**
 * Terrain height BEFORE arenas and corridors are stamped. Pure function of
 * (seed, x, z) — arenas sample it at their own centre, so it must never depend
 * on them.
 */
export function baseHeight(seed: number, x: number, z: number): number {
  const hs = seedChannel(seed, 0);
  const n = warpedFbm2(x * TERRAIN_FREQ, z * TERRAIN_FREQ, hs, TERRAIN_OCTAVES, 0.45);
  let t = n * 0.5 + 0.5;
  t = smootherstep(t);
  let h = TERRAIN_MIN_HEIGHT + t * (TERRAIN_MAX_HEIGHT - TERRAIN_MIN_HEIGHT);

  h += fbm2(x * RELIEF_FREQ, z * RELIEF_FREQ, seedChannel(seed, 8), 3, TERRAIN_LACUNARITY, TERRAIN_GAIN)
    * RELIEF_AMPLITUDE;

  const r = ridged2(
    x * TERRAIN_DETAIL_FREQ, z * TERRAIN_DETAIL_FREQ,
    seedChannel(seed, 1), 3, TERRAIN_LACUNARITY, TERRAIN_GAIN,
  );
  h += (r - 0.42) * RIDGE_AMPLITUDE;

  h = terrace(h, TERRACE_STEP, TERRACE_SHARPNESS);
  return clampf(h, TERRAIN_MIN_HEIGHT, TERRAIN_MAX_HEIGHT);
}

/* ------------------------------------------------------------------------ *
 * Arena lattice
 * ------------------------------------------------------------------------ *
 *
 * A cache slot is 10 doubles:
 *   0 centreX  1 centreZ  2 radius  3 floorY  4 theme
 *   5 pitX     6 pitZ     7 pitRadius (0 = none)
 *   8 ledgePhase (0..1)   9 structure seed
 */

const ARENA_STRIDE = 10;
/** A chunk spans at most 2 cells per axis; +1 ring each side = 4. */
const CACHE_A_SPAN = 4;
/** A point query needs the 3x3 cells around its own. */
const CACHE_B_SPAN = 3;

const cacheA = new Float64Array(CACHE_A_SPAN * CACHE_A_SPAN * ARENA_STRIDE);
const cacheB = new Float64Array(CACHE_B_SPAN * CACHE_B_SPAN * ARENA_STRIDE);
let cacheAOriginX = 0, cacheAOriginZ = 0;
let cacheBOriginX = 0, cacheBOriginZ = 0;
let cacheASeed = 0, cacheBSeed = 0;
let cacheAValid = false, cacheBValid = false;

function writeArena(seed: number, cellX: number, cellZ: number, data: Float64Array, slot: number): void {
  const s = seedChannel(seed, 3);
  const h = hash2i(cellX, cellZ, s);
  const ax = cellX * ARENA_CELL + (ARENA_CELL >> 1) + ((h & 31) - ARENA_JITTER);
  const az = cellZ * ARENA_CELL + (ARENA_CELL >> 1) + (((h >>> 5) & 31) - ARENA_JITTER);
  const radius = ARENA_MIN_RADIUS + ((h >>> 10) % (ARENA_MAX_RADIUS - ARENA_MIN_RADIUS + 1));
  const theme = themeAt(seed, ax, az);

  let floorY = Math.round(baseHeight(seed, ax, az)) - 2;
  const floorMin = SEA_LEVEL + 2;
  const floorMax = TERRAIN_MAX_HEIGHT - 10;
  floorY = clamp(floorY, floorMin, floorMax);

  const ph = hash2i(cellX, cellZ, s ^ 0x51ed21);
  let pitR = 0, pitX = 0, pitZ = 0;
  if ((ph & 255) < 110) {
    pitR = 3 + ((ph >>> 8) % 4);
    const ang = (((ph >>> 12) & 1023) / 1024) * TAU;
    const dist = radius * 0.36;
    pitX = ax + Math.cos(ang) * dist;
    pitZ = az + Math.sin(ang) * dist;
  }

  const o = slot * ARENA_STRIDE;
  data[o + 0] = ax;
  data[o + 1] = az;
  data[o + 2] = radius;
  data[o + 3] = floorY;
  data[o + 4] = theme;
  data[o + 5] = pitX;
  data[o + 6] = pitZ;
  data[o + 7] = pitR;
  data[o + 8] = ((h >>> 22) & 511) / 512;
  data[o + 9] = hash2i(cellX, cellZ, s ^ 0x2f6a11) >>> 0;
}

function buildCache(
  seed: number, originCellX: number, originCellZ: number,
  data: Float64Array, span: number,
): void {
  for (let dz = 0; dz < span; dz++) {
    for (let dx = 0; dx < span; dx++) {
      writeArena(seed, originCellX + dx, originCellZ + dz, data, dz * span + dx);
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Site (arena + corridor) influence
 * ------------------------------------------------------------------------ */

/** Results of the last `evaluateSite` call. Module scope keeps the hot path allocation-free. */
let siteHeight = 0;
let siteWeight = 0;
let siteArena = -1;
let siteCorridor = false;

function segmentInfluence(
  x: number, z: number,
  data: Float64Array, sa: number, sb: number,
): void {
  const ax = data[sa], az = data[sa + 1], fa = data[sa + 3];
  const bx = data[sb], bz = data[sb + 1], fb = data[sb + 3];
  const ex = bx - ax, ez = bz - az;
  const len2 = ex * ex + ez * ez;
  let t = len2 > 0 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const qx = ax + ex * t, qz = az + ez * t;
  const dx = x - qx, dz = z - qz;
  const d = Math.sqrt(dx * dx + dz * dz);
  const edge = CORRIDOR_HALF_WIDTH + CORRIDOR_RIM;
  if (d >= edge) return;
  const w = smootherstep(clampf((edge - d) / CORRIDOR_RIM, 0, 1));
  if (w > siteWeight) {
    siteWeight = w;
    siteHeight = fa + (fb - fa) * t;
    siteArena = -1;
    siteCorridor = true;
  }
}

/**
 * Blend the base height toward whichever arena or corridor claims this column.
 * Writes `siteHeight` / `siteWeight` / `siteArena` / `siteCorridor`.
 *
 * Only the 3x3 cells around the column can reach it: an arena in a cell two
 * away is at least 80 blocks off and its radius tops out at 26 + 3 rim, and a
 * corridor two cells away is at least 16 blocks off against a 6-block half
 * width. That bound is what lets a 4-cell cache serve a whole chunk.
 */
function evaluateSite(
  x: number, z: number, baseH: number,
  data: Float64Array, originCellX: number, originCellZ: number, span: number,
): void {
  siteWeight = 0;
  siteArena = -1;
  siteCorridor = false;
  siteHeight = baseH;

  const cx = x >> ARENA_CELL_BITS;
  const cz = z >> ARENA_CELL_BITS;

  // Arenas.
  for (let dz = -1; dz <= 1; dz++) {
    const cellZ = cz + dz;
    const iz = cellZ - originCellZ;
    if (iz < 0 || iz >= span) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const cellX = cx + dx;
      const ix = cellX - originCellX;
      if (ix < 0 || ix >= span) continue;
      const o = (iz * span + ix) * ARENA_STRIDE;
      const ex = x - data[o], ez = z - data[o + 1];
      const r = data[o + 2];
      const d2 = ex * ex + ez * ez;
      const outer = r + ARENA_RIM;
      if (d2 >= outer * outer) continue;
      const d = Math.sqrt(d2);
      const w = smootherstep(clampf((outer - d) / (2 * ARENA_RIM), 0, 1));
      if (w > siteWeight) {
        siteWeight = w;
        siteHeight = data[o + 3];
        siteArena = o;
        siteCorridor = false;
      }
    }
  }

  // Corridors: this cell to +X, this cell to +Z, and the two incoming ones.
  const ix0 = cx - originCellX;
  const iz0 = cz - originCellZ;
  const here = (iz0 * span + ix0) * ARENA_STRIDE;
  if (ix0 >= 0 && ix0 < span && iz0 >= 0 && iz0 < span) {
    if (ix0 + 1 < span) segmentInfluence(x, z, data, here, here + ARENA_STRIDE);
    if (ix0 - 1 >= 0) segmentInfluence(x, z, data, here - ARENA_STRIDE, here);
    if (iz0 + 1 < span) segmentInfluence(x, z, data, here, here + span * ARENA_STRIDE);
    if (iz0 - 1 >= 0) segmentInfluence(x, z, data, here - span * ARENA_STRIDE, here);
  }

  siteHeight = baseH + (siteHeight - baseH) * siteWeight;
}

/**
 * Final ground height at a world column, arenas and corridors included but
 * before structures, vents and trees. Use it for spawn logic and bot pathing.
 */
export function surfaceHeightAt(seed: number, x: number, z: number): number {
  const cx = (x >> ARENA_CELL_BITS) - 1;
  const cz = (z >> ARENA_CELL_BITS) - 1;
  if (!cacheBValid || cacheBSeed !== seed || cacheBOriginX !== cx || cacheBOriginZ !== cz) {
    buildCache(seed, cx, cz, cacheB, CACHE_B_SPAN);
    cacheBOriginX = cx; cacheBOriginZ = cz; cacheBSeed = seed; cacheBValid = true;
  }
  evaluateSite(x, z, baseHeight(seed, x, z), cacheB, cx, cz, CACHE_B_SPAN);
  return Math.round(siteHeight);
}

/* ------------------------------------------------------------------------ *
 * Per-chunk column maps
 * ------------------------------------------------------------------------ */

/** Vents reach 3 blocks, trees 2 — so the column map carries a 3-block skirt. */
const MAP_PAD = 3;
const MAP_SIZE = CHUNK_SIZE_X + MAP_PAD * 2;   // 38
const MAP_AREA = MAP_SIZE * MAP_SIZE;          // 1444

const mHeight = new Int16Array(MAP_AREA);      // top solid y of the natural ground
const mTheme = new Uint8Array(MAP_AREA);
const mStructTop = new Int16Array(MAP_AREA);   // top y of any structure, == height when none
const mStructMat = new Uint8Array(MAP_AREA);
const mStructCap = new Uint8Array(MAP_AREA);   // 0 = no cap block
const mLiquidTop = new Int16Array(MAP_AREA);   // -1 when dry
const mLiquidId = new Uint8Array(MAP_AREA);
const mFlags = new Uint8Array(MAP_AREA);
/** Snapshot of mHeight taken before the vent pass so a vent never reads a vented root. */
const mHeight0 = new Int16Array(MAP_AREA);

const MF_SITE = 1 << 0;      // inside an arena or corridor
const MF_ARENA = 1 << 1;     // inside an arena specifically
const MF_PIT = 1 << 2;       // inside a lava pit

function mapIndex(lx: number, lz: number): number {
  return (lx + MAP_PAD) + (lz + MAP_PAD) * MAP_SIZE;
}

/* --- structures ---------------------------------------------------------- */

/** Height above the arena floor added by the rim ledge, 0 when outside it. */
function ledgeHeight(d: number, radius: number, x: number, z: number, ax: number, az: number, phase: number): number {
  const inner = radius - LEDGE_OUTER;
  const outer = radius - LEDGE_INNER;
  if (d <= inner || d >= outer) return -1;
  const ang = Math.atan2(z - az, x - ax);
  const frac = (ang + Math.PI) / TAU;
  let s = frac - phase;
  s -= Math.floor(s);
  if (s < LEDGE_RAMP_FRAC) {
    const step = Math.floor((s / LEDGE_RAMP_FRAC) * (LEDGE_HEIGHT + 1));
    return step > LEDGE_HEIGHT ? LEDGE_HEIGHT : step;
  }
  if (s >= 0.5 && s < 0.5 + LEDGE_RAMP_FRAC) {
    const step = Math.floor(((s - 0.5) / LEDGE_RAMP_FRAC) * (LEDGE_HEIGHT + 1));
    return step > LEDGE_HEIGHT ? LEDGE_HEIGHT : step;
  }
  return LEDGE_HEIGHT;
}

/* --- pass 1: height, theme, structures, liquid --------------------------- */

function buildColumnMaps(seed: number, cx: number, cz: number): void {
  const baseX = cx * CHUNK_SIZE_X;
  const baseZ = cz * CHUNK_SIZE_Z;

  const cellX0 = ((baseX >> ARENA_CELL_BITS) - 1);
  const cellZ0 = ((baseZ >> ARENA_CELL_BITS) - 1);
  if (!cacheAValid || cacheASeed !== seed || cacheAOriginX !== cellX0 || cacheAOriginZ !== cellZ0) {
    buildCache(seed, cellX0, cellZ0, cacheA, CACHE_A_SPAN);
    cacheAOriginX = cellX0; cacheAOriginZ = cellZ0; cacheASeed = seed; cacheAValid = true;
  }

  const structSeed = seedChannel(seed, 4);

  for (let lz = -MAP_PAD; lz < CHUNK_SIZE_Z + MAP_PAD; lz++) {
    const z = baseZ + lz;
    for (let lx = -MAP_PAD; lx < CHUNK_SIZE_X + MAP_PAD; lx++) {
      const x = baseX + lx;
      const mi = mapIndex(lx, lz);

      const bh = baseHeight(seed, x, z);
      evaluateSite(x, z, bh, cacheA, cellX0, cellZ0, CACHE_A_SPAN);

      let h = Math.round(siteHeight);
      const arena = siteArena;
      const w = siteWeight;
      let flags = 0;
      if (w > 0.25) flags |= MF_SITE;

      let theme: Theme;
      if (arena >= 0 && w > 0.5) theme = cacheA[arena + 4] as Theme;
      else theme = themeAt(seed, x, z);

      let structTop = h;
      let structMat = 0;
      let structCap = 0;
      let liquidTop = -1;
      let liquidId = 0;

      if (arena >= 0 && w > 0.88) {
        flags |= MF_ARENA;
        const ax = cacheA[arena], az = cacheA[arena + 1];
        const radius = cacheA[arena + 2];
        const floorY = cacheA[arena + 3];
        const pitR = cacheA[arena + 7];
        const phase = cacheA[arena + 8];
        const sseed = (cacheA[arena + 9] | 0) ^ structSeed;
        const ddx = x - ax, ddz = z - az;
        const d = Math.sqrt(ddx * ddx + ddz * ddz);

        let inPit = false;
        if (pitR > 0) {
          const px = x - cacheA[arena + 5], pz = z - cacheA[arena + 6];
          const pd = Math.sqrt(px * px + pz * pz);
          if (pd < pitR) {
            inPit = true;
            flags |= MF_PIT;
            h = floorY - 3;
            structTop = h;
            liquidTop = floorY - 1;
            liquidId = BlockId.LAVA;
          } else if (pd < pitR + 1.6) {
            structTop = floorY + 1;
            structMat = ledgeMaterial(theme);
          }
        }

        if (!inPit) {
          // Rim ledge with two stair ramps.
          const lh = ledgeHeight(d, radius, x, z, ax, az, phase);
          if (lh >= 0 && floorY + lh > structTop) {
            structTop = floorY + lh;
            structMat = ledgeMaterial(theme);
            structCap = 0;
          }

          // Chest-high cover, scattered on a 5-block lattice.
          if (d < radius - 4) {
            const gx = Math.floor(x / COVER_GRID);
            const gz = Math.floor(z / COVER_GRID);
            const hh = hash2i(gx, gz, sseed);
            if ((hh & 255) < 102) {
              const ox = gx * COVER_GRID + (hh >>> 8) % 3;
              const oz = gz * COVER_GRID + (hh >>> 11) % 3;
              const wide = 2 + ((hh >>> 14) & 1);
              if (x >= ox && x < ox + wide && z >= oz && z < oz + wide) {
                const ch = 2 + ((hh >>> 16) & 1);
                if (floorY + ch > structTop) {
                  structTop = floorY + ch;
                  structMat = coverMaterial(theme);
                  structCap = 0;
                }
              }
            }
          }

          // Pillars on a 9-block lattice, capped with an emissive block.
          if (d < radius - 5) {
            const px = Math.floor(x / PILLAR_GRID);
            const pz = Math.floor(z / PILLAR_GRID);
            const hh = hash2i(px, pz, sseed ^ 0x77aa33);
            if ((hh & 255) < 115) {
              const ox = px * PILLAR_GRID + (hh >>> 8) % 7;
              const oz = pz * PILLAR_GRID + (hh >>> 12) % 7;
              if (x >= ox && x < ox + 2 && z >= oz && z < oz + 2) {
                const ph = 4 + ((hh >>> 16) % 5);
                if (floorY + ph > structTop) {
                  structTop = floorY + ph;
                  structMat = pillarMaterial(theme);
                  structCap = pillarCap(theme);
                }
              }
            }
          }

          // Centre plinth: the focal point every arena needs.
          if (d < 3.2) {
            const ch = d < 1.7 ? 2 : 1;
            if (floorY + ch > structTop) {
              structTop = floorY + ch;
              structMat = plinthMaterial(theme);
              structCap = 0;
            }
          }
        }
      }

      // Standing liquid, when nothing has claimed the column yet.
      if (liquidTop < 0) {
        if (theme === Theme.HELL) {
          if (h < LAVA_LEVEL) { liquidTop = LAVA_LEVEL; liquidId = BlockId.LAVA; }
        } else if (h < SEA_LEVEL) {
          liquidTop = SEA_LEVEL; liquidId = BlockId.WATER;
        }
      }

      mHeight[mi] = h;
      mTheme[mi] = theme;
      mStructTop[mi] = structTop;
      mStructMat[mi] = structMat;
      mStructCap[mi] = structCap;
      mLiquidTop[mi] = liquidTop;
      mLiquidId[mi] = liquidId;
      mFlags[mi] = flags;
    }
  }
}

/* --- pass 2: hell vents -------------------------------------------------- */

const VENT_LATTICE = 8;
/** Density is per column; the lattice only offers one root per 64, so scale up. */
const VENT_ROOT_CHANCE = VENT_DENSITY * VENT_LATTICE * VENT_LATTICE;

function applyVents(seed: number, cx: number, cz: number): void {
  const baseX = cx * CHUNK_SIZE_X;
  const baseZ = cz * CHUNK_SIZE_Z;
  const ventSeed = seedChannel(seed, 5);
  mHeight0.set(mHeight);

  for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
    const z = baseZ + lz;
    for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
      const x = baseX + lx;
      const mi = mapIndex(lx, lz);
      if (mTheme[mi] !== Theme.HELL || (mFlags[mi] & MF_SITE) !== 0) continue;

      const rx0 = Math.ceil((x - 3) / VENT_LATTICE) * VENT_LATTICE;
      const rz0 = Math.ceil((z - 3) / VENT_LATTICE) * VENT_LATTICE;
      for (let rz = rz0; rz <= z + 3; rz += VENT_LATTICE) {
        for (let rx = rx0; rx <= x + 3; rx += VENT_LATTICE) {
          const ri = mapIndex(rx - baseX, rz - baseZ);
          if (ri < 0 || ri >= MAP_AREA) continue;
          if (mTheme[ri] !== Theme.HELL || (mFlags[ri] & MF_SITE) !== 0) continue;
          if ((hash2i(rx, rz, ventSeed) >>> 8) / 16777216 >= VENT_ROOT_CHANCE) continue;

          const dx = x - rx, dz = z - rz;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d >= 3.0) continue;
          const rh = mHeight0[ri];
          if (d < 1.6) {
            mHeight[mi] = rh - 1;
            mStructTop[mi] = rh - 1;
            mStructMat[mi] = 0;
            mStructCap[mi] = 0;
            mLiquidTop[mi] = rh;
            mLiquidId[mi] = BlockId.LAVA;
          } else if (mStructTop[mi] <= rh + 1) {
            mStructTop[mi] = rh + 1;
            mStructMat[mi] = BlockId.HELLSTONE;
            mStructCap[mi] = 0;
            if (mLiquidTop[mi] <= rh + 1) { mLiquidTop[mi] = -1; mLiquidId[mi] = 0; }
          }
        }
      }
    }
  }
}

/* --- strata -------------------------------------------------------------- */

function strataBlock(
  theme: Theme, depth: number, y: number, x: number, z: number,
  strataSeed: number, submerged: boolean,
): number {
  if (theme === Theme.HELL) {
    if (depth === 0) return BlockId.HELLSTONE;
    const r = hash3f(x, y, z, strataSeed);
    if (depth <= 2) return r < 0.34 ? BlockId.OBSIDIAN : BlockId.HELLSTONE;
    if (depth <= 6) return r < 0.12 ? BlockId.BONE : BlockId.STONE;
    return r < 0.05 ? BlockId.OBSIDIAN : BlockId.STONE;
  }
  if (theme === Theme.TECH) {
    if (depth === 0) return hash3f(x, y, z, strataSeed) < 0.22 ? BlockId.RUSTED_METAL : BlockId.TECH_PANEL;
    if (depth <= 2) return BlockId.METAL;
    if (depth <= 5) return BlockId.COBBLESTONE;
    return hash3f(x, y, z, strataSeed) < 0.06 ? BlockId.GRAVEL : BlockId.STONE;
  }
  if (depth === 0) {
    if (submerged) return BlockId.SAND;
    return y >= SNOW_LEVEL ? BlockId.SNOW : BlockId.GRASS;
  }
  if (depth <= SOIL_DEPTH) return submerged ? BlockId.SAND : BlockId.DIRT;
  const r = hash3f(x, y, z, strataSeed);
  if (depth <= SOIL_DEPTH + 3) return r < 0.18 ? BlockId.GRAVEL : BlockId.STONE;
  return r < 0.07 ? BlockId.COBBLESTONE : BlockId.STONE;
}

/* --- pass 3: trees ------------------------------------------------------- */

const TREE_LATTICE = 4;
const TREE_ROOT_CHANCE = TREE_DENSITY * TREE_LATTICE * TREE_LATTICE;

function treeTrunkHeight(rx: number, rz: number, treeSeed: number): number {
  const h = hash2i(rx, rz, treeSeed ^ 0x1a3b5c);
  return 3 + (h % 3);
}

function treeRootValid(mi: number, treeSeed: number, rx: number, rz: number): boolean {
  if (mi < 0 || mi >= MAP_AREA) return false;
  if (mTheme[mi] !== Theme.OUTLAND) return false;
  if ((mFlags[mi] & MF_SITE) !== 0) return false;
  if (mHeight[mi] <= SEA_LEVEL + 1) return false;
  if (mHeight[mi] >= SNOW_LEVEL) return false;
  if (mStructTop[mi] !== mHeight[mi]) return false;
  return (hash2i(rx, rz, treeSeed) >>> 8) / 16777216 < TREE_ROOT_CHANCE;
}

function applyTrees(seed: number, cx: number, cz: number, out: Uint8Array): void {
  const baseX = cx * CHUNK_SIZE_X;
  const baseZ = cz * CHUNK_SIZE_Z;
  const treeSeed = seedChannel(seed, 6);

  for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
    const z = baseZ + lz;
    for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
      const x = baseX + lx;
      const rx0 = Math.ceil((x - 2) / TREE_LATTICE) * TREE_LATTICE;
      const rz0 = Math.ceil((z - 2) / TREE_LATTICE) * TREE_LATTICE;
      for (let rz = rz0; rz <= z + 2; rz += TREE_LATTICE) {
        for (let rx = rx0; rx <= x + 2; rx += TREE_LATTICE) {
          const ri = mapIndex(rx - baseX, rz - baseZ);
          if (!treeRootValid(ri, treeSeed, rx, rz)) continue;

          const rh = mHeight[ri];
          const th = treeTrunkHeight(rx, rz, treeSeed);
          const topY = rh + th;
          const ddx = x - rx, ddz = z - rz;

          if (ddx === 0 && ddz === 0) {
            for (let y = rh + 1; y <= topY; y++) {
              if (y >= CHUNK_HEIGHT) break;
              out[voxelIndex(lx, y, lz)] = BlockId.WOOD;
            }
            if (topY + 2 < CHUNK_HEIGHT) {
              const i = voxelIndex(lx, topY + 2, lz);
              if (out[i] === BlockId.AIR) out[i] = BlockId.LEAVES;
            }
          }

          const r2 = ddx * ddx + ddz * ddz;
          if (r2 <= 4) {
            for (let y = topY - 1; y <= topY; y++) {
              if (y < 1 || y >= CHUNK_HEIGHT) continue;
              const i = voxelIndex(lx, y, lz);
              if (out[i] === BlockId.AIR) out[i] = BlockId.LEAVES;
            }
          }
          if (r2 <= 2 && topY + 1 < CHUNK_HEIGHT) {
            const i = voxelIndex(lx, topY + 1, lz);
            if (out[i] === BlockId.AIR) out[i] = BlockId.LEAVES;
          }
        }
      }
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Chunk generation
 * ------------------------------------------------------------------------ */

/**
 * Generate one chunk into `out` (CHUNK_VOLUME bytes). `out` is zeroed first, so
 * callers may reuse a single scratch array forever.
 */
export function generateChunkInto(seed: number, cx: number, cz: number, out: Uint8Array): void {
  if (out.length < CHUNK_VOLUME) {
    throw new Error(`generateChunkInto: need ${CHUNK_VOLUME} bytes, got ${out.length}`);
  }
  out.fill(0, 0, CHUNK_VOLUME);

  buildColumnMaps(seed, cx, cz);
  applyVents(seed, cx, cz);

  const baseX = cx * CHUNK_SIZE_X;
  const baseZ = cz * CHUNK_SIZE_Z;
  const strataSeed = seedChannel(seed, 7);
  const maxY = CHUNK_HEIGHT - 1;

  for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
    const z = baseZ + lz;
    for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
      const x = baseX + lx;
      const mi = mapIndex(lx, lz);

      const h = mHeight[mi] > maxY ? maxY : mHeight[mi];
      const theme = mTheme[mi] as Theme;
      const liquidTop = mLiquidTop[mi];
      const submerged = liquidTop > h && mLiquidId[mi] === BlockId.WATER;

      out[voxelIndex(lx, 0, lz)] = BlockId.BEDROCK;
      for (let y = 1; y <= h; y++) {
        out[voxelIndex(lx, y, lz)] = strataBlock(theme, h - y, y, x, z, strataSeed, submerged);
      }

      const structTop = mStructTop[mi] > maxY ? maxY : mStructTop[mi];
      const structMat = mStructMat[mi];
      if (structMat !== 0 && structTop > h) {
        const cap = mStructCap[mi];
        for (let y = h + 1; y <= structTop; y++) {
          out[voxelIndex(lx, y, lz)] = (cap !== 0 && y === structTop) ? cap : structMat;
        }
      }

      if (liquidTop >= 0) {
        const start = (structTop > h ? structTop : h) + 1;
        const end = liquidTop > maxY ? maxY : liquidTop;
        const id = mLiquidId[mi];
        for (let y = start; y <= end; y++) out[voxelIndex(lx, y, lz)] = id;
      }
    }
  }

  applyTrees(seed, cx, cz, out);
}

/** Convenience wrapper that allocates. Do not call this per frame. */
export function generateChunk(seed: number, cx: number, cz: number): Uint8Array {
  const out = new Uint8Array(CHUNK_VOLUME);
  generateChunkInto(seed, cx, cz, out);
  return out;
}

/* ------------------------------------------------------------------------ *
 * Spawns
 * ------------------------------------------------------------------------ */

/**
 * Deterministic spawn ring inside the arena nearest a lattice cell. Writes
 * `count * 3` floats (feet-centre x, y, z) and returns how many it wrote.
 *
 * y is the feet plane: one block above the arena floor's top solid voxel.
 */
export function findSpawnPoints(
  seed: number, out: Float64Array, count: number,
  minCell: number = -3, maxCell: number = 3,
): number {
  let written = 0;
  const scratch = new Float64Array(ARENA_STRIDE);
  for (let cz = minCell; cz <= maxCell && written < count; cz++) {
    for (let cx = minCell; cx <= maxCell && written < count; cx++) {
      writeArena(seed, cx, cz, scratch, 0);
      const ax = scratch[0], az = scratch[1], r = scratch[2], f = scratch[3];
      // Skip arenas the world edge clips: the outer lattice ring overhangs it.
      if (ax - r < WORLD_MIN_BLOCK_X || ax + r > WORLD_MAX_BLOCK_X) continue;
      if (az - r < WORLD_MIN_BLOCK_Z || az + r > WORLD_MAX_BLOCK_Z) continue;
      const phase = scratch[8];
      // Three spawns per arena, spaced around a ring clear of the centre plinth.
      for (let k = 0; k < 3 && written < count; k++) {
        const ang = (phase + k / 3 + 0.17) * TAU;
        // 0.42R sits inside the cover field but clear of the plinth and the rim
        // ledge; `resolveSpawnFeet` fixes up the ones that land on a block.
        const rad = r * 0.42;
        const px = ax + Math.cos(ang) * rad;
        const pz = az + Math.sin(ang) * rad;
        out[written * 3 + 0] = px + 0.5;
        out[written * 3 + 1] = f + 1;
        out[written * 3 + 2] = pz + 0.5;
        written++;
      }
    }
  }
  return written;
}

/**
 * Snap a spawn candidate onto whatever is actually on top of its column.
 *
 * `findSpawnPoints` only knows the arena FLOOR; a pillar, a cover block or a rim
 * ledge may stand on the exact square it picked, and a lava pit may have eaten
 * it. Callers must run every candidate through here against the real chunk data.
 * Pass `world.highestGroundY` and `world.blockAt` bound to the loaded world.
 *
 * Returns the feet plane, or -1 when the column is unusable.
 */
export function resolveSpawnFeet(
  x: number, z: number,
  highestGroundY: (x: number, z: number) => number,
  blockAt: (x: number, y: number, z: number) => number,
): number {
  const g = highestGroundY(x, z);
  if (g < 1) return -1;
  const feet = g + 1;
  if (feet + 2 >= CHUNK_HEIGHT) return -1;
  // Two clear blocks of headroom, and nothing standing in them.
  if (blockAt(x, feet, z) !== BlockId.AIR) return -1;
  if (blockAt(x, feet + 1, z) !== BlockId.AIR) return -1;
  if (blockAt(x, g, z) === BlockId.LAVA) return -1;
  return feet;
}

/**
 * Arena descriptor nearest a point, for bot navigation and the minimap.
 * Writes [centreX, centreZ, radius, floorY, theme] into `out`.
 */
export function nearestArena(seed: number, x: number, z: number, out: Float64Array): void {
  const cx = x >> ARENA_CELL_BITS;
  const cz = z >> ARENA_CELL_BITS;
  const scratch = cacheB;
  buildCache(seed, cx - 1, cz - 1, scratch, CACHE_B_SPAN);
  cacheBOriginX = cx - 1; cacheBOriginZ = cz - 1; cacheBSeed = seed; cacheBValid = true;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < CACHE_B_SPAN * CACHE_B_SPAN; i++) {
    const o = i * ARENA_STRIDE;
    const dx = x - scratch[o], dz = z - scratch[o + 1];
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = o; }
  }
  out[0] = scratch[best];
  out[1] = scratch[best + 1];
  out[2] = scratch[best + 2];
  out[3] = scratch[best + 3];
  out[4] = scratch[best + 4];
}

/** Drop cached lattice state. Only needed when the seed changes mid-session. */
export function resetTerrainCaches(): void {
  cacheAValid = false;
  cacheBValid = false;
}
