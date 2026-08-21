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
 *   - Every arena wider than KEEP_MIN_RADIUS gets a KEEP: a roofed blockhouse
 *     on the centre line with four doorways, a clerestory slit you can shoot
 *     ankles through, glowing corner piers, a lava basin on the floor and a
 *     parapeted roof deck reached by an external stair or a rocket jump. It is
 *     the one thing the bar's world does not have anywhere: an INSIDE. A roof
 *     zeroes the mesher's sky channel, so a keep is not just geometry that
 *     casts no shadow — its floor is measurably a different key from the arena
 *     outside its door, and the doorway you are silhouetted in is the whole
 *     fight. Its panels are breachable and its piers are not, so a rocket opens
 *     a new sightline into the room without dissolving the room.
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
import { BlockId, BLOCK_COUNT, BLOCK_HARDNESS } from './blocks.ts';
import {
  TAU, clampf, smootherstep, seedChannel, hash2i, hash3f,
  warpedFbm2, ridged2, fbm2,
} from './math.ts';

/**
 * Any change that moves a voxel must bump this; the server asserts on it.
 *
 * v2 — arena keeps. Adds roofed interiors, so a column can now be solid, then
 * air, then solid again.
 * v3 — bastions. Paired 4-block masses with an arch through one of them, on a
 * 24-block lattice over the whole dry plane and not only inside the arenas.
 * v4 — crags. A second, denser occluder lattice at 12 blocks that fills the
 * plane between the bastions, so no eye-height sightline runs to the skyline.
 * v5 — battle damage. Every arena ships already fought over: blast craters cut
 * by the same arithmetic `carveSphere` runs at runtime, charred rims and rubble
 * settled on the first surface under each hole. See `applyBattleDamage`.
 */
export const TERRAIN_VERSION = 5;

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

/* --- bastions ------------------------------------------------------------ *
 *
 * THE GAP THIS CLOSES. Everything above stood inside an arena and most of it
 * stood below the eye line: cover is 2-3 blocks (waist to chest), pillars are
 * 2x2 posts you can see straight past, and outside an arena floor there was
 * nothing placed at all. So from most points in this world you could see to the
 * skyline in most directions, and a plane you can see across is scenery however
 * well it is lit. PLAYER_EYE_HEIGHT is 1.62, so "cover" and "occluder" are two
 * different jobs and only one of them was being done.
 *
 * A BASTION is a PAIR of solid masses on a 24-block lattice, over the whole dry
 * playable plane and not just inside arenas. Plan view, axis = X, `#` solid:
 *
 *            u = -6 -5 -4 -3 -2 -1  0  1  2  3  4  5  6
 *      v = +5      1  2  3  4  4  4                        <- mass A, heights
 *      v = +4      1  2  3  4  4  4
 *      v = +3      1  2  3  4  4  4
 *      v = +2   . . . . . . . . . . . . . . . . . . . .
 *      v = +1   .            the lane, 5 blocks          .  <- you fight here
 *      v =  0   .   nothing in it, and it runs through   .
 *      v = -1   .                                        .
 *      v = -2   . . . . . . . . . . . . . . . . . . . . .
 *      v = -3                        4  A  A  4  3  2  1    <- mass B
 *      v = -4                        4  A  A  4  3  2  1
 *      v = -5                        4  A  A  4  3  2  1
 *
 * Three things are deliberate:
 *
 *  - **The masses top out at 4 blocks**, which is over the eye line by 2.4 m.
 *    They are occluders, not cover: a body behind one is gone, and the frame
 *    stops running to the skyline.
 *  - **They are staggered along the lane as well as offset across it**, so the
 *    pair reads as a lane with a gap and not as a wall with a door. You can run
 *    the lane, cut the diagonal, or take either roof.
 *  - **Each mass is a STAIR on its outer end** — 1, 2, 3, then 4 — so the roof
 *    is reachable on foot (JUMP_VELOCITY clears one block, never two) and the
 *    outer columns double as the chest-high cover the brief asks for. The steps
 *    are also why a terrace beside one reads as something you mount rather than
 *    as a painted ramp: there is a countable staircase next to it for scale.
 *
 * `A` marks the ARCH: a 2-wide, 2-tall hole cut clean through mass B, floor to
 * lintel. It is a sightline that exists only through the hole — the one shot
 * down the lane that the geometry allows — and it is the seed a rocket widens,
 * because the lintel over it is two blocks of breachable wall material and
 * nothing else is holding it up.
 *
 * Cost is one hash per column and no neighbour scan: the pair's bounding box is
 * 13 x 11 and the jitter is +/-5, so 6 + 5 + 5 < 24 and a pair can never leave
 * its own cell. Roughly 122 voxels and ~40 merged quads per 576 columns.
 */
export const BASTION_CELL = 24;
const BASTION_CELL_HALF = 12;
/** Max displacement of a pair centre from its cell centre. Keeps 6 + 5 < 12. */
const BASTION_JITTER = 5;
/** Out of 256. High, because "two masses within 20 m" is the whole point. */
const BASTION_CHANCE = 224;
/** Half-length along the lane. Each mass is 6 long. */
const BASTION_U = 6;
/** The mass occupies |v| in [BASTION_V_IN, BASTION_V_OUT]; the lane is inside. */
const BASTION_V_IN = 3;
const BASTION_V_OUT = 5;
/** Top of the tall part, above the ground under it. */
const BASTION_TOP = 4;
/** The arch tunnel, in |u|. Two wide, so a body fits and a rocket fits. */
const BASTION_ARCH_U0 = 2;
const BASTION_ARCH_U1 = 3;
/** Clear air inside the arch: PLAYER_HEIGHT is 1.8, so two blocks. */
const BASTION_ARCH_CLEAR = 2;

/* --- crags ---------------------------------------------------------------- *
 *
 * THE GAP THIS CLOSES, measured rather than argued. `tools/`-free probe: stand
 * at every standable dry column on a 4-block grid over 7x7 chunks, put the eye
 * at PLAYER_EYE_HEIGHT over the feet plane, and cast 24 rays out to 40 m.
 * Against the v3 world:
 *
 *     median sightline   13.2 m
 *     rays reaching 40 m 29.4%          <- nearly a third of the horizon is open
 *     directions per point still open past 15 m:  median 11 of 24, p90 21 of 24
 *
 * So one point in ten could see past 15 m down 21 of its 24 directions. The
 * bastions are real occluders but they sit one per 24 m cell and cover a
 * quarter of their cell, and everything else — the corridor lanes, the banked
 * rim band around every arena, the terrace shelves between arenas — was bare
 * ground you could see straight across. A frame with a wall on the left and
 * open ground to the horizon on the right is still scenery on the right.
 *
 * A CRAG is a rock outcrop on a 12-block lattice, jittered +/-3, over
 * everything the bastions do not already own. Section along its long axis,
 * `#` solid, ground at the bottom:
 *
 *      s = -3  -2  -1   0  +1  +2  +3
 *                       #   #   #   #     <- top, 4 / 5 / 6 by hash
 *               .   #   #   #   #   #
 *           .   #   #   #   #   #   #
 *           #   #   #   #   #   #   #
 *      ===========================        <- the ground under it, unlevelled
 *
 * Three blocks wide across `v`, seven long, so 21 columns of a 144-column cell.
 * The design rules behind those numbers:
 *
 *  - **Pitch 12, not 24.** The critic's number was "mass that breaks line of
 *    sight at roughly 10-15 m intervals". 12 with +/-3 of jitter puts the
 *    nearest crag centre 6-18 m away from wherever you are standing and the
 *    next one behind it, so a ray that misses the first meets the second.
 *  - **Top 4 to 6 blocks, never 2 or 3.** PLAYER_EYE_HEIGHT is 1.62: three
 *    blocks is the first height that hides a standing body, four is the first
 *    that hides one standing on the step below you. The tapered end columns
 *    come out at 1-3 blocks, which is the chest-high cover the same object owes
 *    the player at its edges.
 *  - **The taper is one-sided.** The low end steps 1, 2, 3 into the mass, so a
 *    top-4 crag is walk-up high ground and the taller ones are rocket-jump
 *    high ground. A symmetric lump would be neither.
 *
 * The ground under a crag is NOT levelled, unlike a bastion pad: a crag is rock
 * that grew where it stands, it wants to sit on the terrace riser rather than
 * cut it, and skipping the pad also skips the cache and the second `baseHeight`
 * evaluation. Cost is one hash per column, no neighbour scan, and a crag can
 * never leave its own cell (3 of half-length + 3 of jitter == the 6-block half
 * cell), which is what keeps chunk generation seam-free and order-independent.
 *
 * Materials are the natural rocks, one value step apart and NOT the bastions'
 * built brick/metal, so at a glance you can tell the thing that was quarried
 * from the thing that was placed. All three bodies are breachable — cobble
 * resists 2.2, rusted metal 3.7, hellstone 3.3, against a rocket's 9.6 at the
 * centre — so a rocket into a crag is the cheapest new sightline in the game.
 */
export const CRAG_CELL = 12;
const CRAG_CELL_HALF = 6;
/** Max displacement of a crag centre from its cell centre. Keeps 3 + 3 <= 6. */
const CRAG_JITTER = 3;
/** Out of 256. 74% leaves enough empty cells that the lattice never reads as a grid. */
const CRAG_CHANCE = 190;
/** Half-length along the long axis: 7 columns. */
const CRAG_U = 3;
/** Half-width across it: 3 columns. */
const CRAG_V = 1;
/** Height of the plateau over the ground under it. 4 is 2.4 m — over the eye line. */
const CRAG_TOP_MIN = 4;
const CRAG_TOP_SPAN = 3;
/** Keep-out ring around a keep, in blocks past its half-extent. Its stair is 5 long. */
const CRAG_KEEP_CLEAR = 6;

/* --- the keep ------------------------------------------------------------ *
 *
 * Heights are all relative to the arena floor:
 *
 *      +7  ####        ####          parapet, chest high on the roof deck
 *      +6  ####        ####
 *      +5  ##################        roof slab  (deck surface is +6)
 *      +4  ##            ##          clerestory slit; piers only, glowing cap
 *      +3  ####        ####
 *      +2  ####  door  ####          wall panels
 *      +1  ####        ####
 *       0  ==================        arena floor, lava basin at the middle
 *
 * The slit is the design: it is the one place a defender inside can see and
 * shoot a pair of legs outside, and the one place an attacker outside can see
 * the fire inside moving. Everything else about the box is a silhouette.
 */

/** Arenas narrower than this stay open — a keep would eat the whole floor. */
export const KEEP_MIN_RADIUS = 20;
/** Half-extent of the square footprint, so a keep is 9 or 11 blocks across. */
const KEEP_HALF_MIN = 4;
const KEEP_HALF_SPAN = 2;
/** Top of the corner piers, above the floor. The roof slab sits one higher. */
const KEEP_WALL_H = 4;
/** Wall panels stop here, leaving the clerestory slit at KEEP_WALL_H. */
const KEEP_PANEL_H = 3;
/** Length of the external stair, in steps. Its top step is level with the deck. */
const KEEP_STAIR_LEN = 5;
/** Half-width of a doorway: 1 gives a three-block opening. */
const KEEP_DOOR_HALF = 1;

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
/**
 * Keep wall panels. All three are BREACHABLE by a rocket
 * (`destruction.blastResist`: hellstone 3.3, brick 2.8, metal 5.2 against a
 * rocket's 9.6 at the centre), which is the point — a rocket into a panel opens
 * a new sightline into the room.
 */
function keepWallMaterial(theme: Theme): number {
  return theme === Theme.HELL ? BlockId.HELLSTONE : theme === Theme.TECH ? BlockId.METAL : BlockId.BRICK;
}
/**
 * Keep roof and parapet, deliberately a different VALUE from the walls rather
 * than a different hue: a bone-white cap on a blood-red hell keep is visible
 * across the whole arena and tells you where the high ground is from anywhere.
 * Also breachable, so a BFG can drop the roof in on whoever is under it.
 */
function keepRoofMaterial(theme: Theme): number {
  return theme === Theme.HELL ? BlockId.BONE : theme === Theme.TECH ? BlockId.TECH_PANEL : BlockId.COBBLESTONE;
}
/**
 * Corner piers. Obsidian in every theme, and obsidian is blast-proof at every
 * radius in the weapon table: the keep can be shot to pieces but it always
 * keeps its four legs and its roof, so the arena never loses its landmark.
 */
function keepPierMaterial(): number {
  return BlockId.OBSIDIAN;
}
/**
 * Bastion walls. Same three materials as the keep panels and breachable for the
 * same reason: `destruction.blastResist` puts brick at 2.8, metal at 5.2 and
 * hellstone at 3.3 against a rocket's 9.6 at the centre, so one rocket into a
 * mass opens a hole and a second one joins it to the arch.
 */
function bastionWallMaterial(theme: Theme): number {
  return theme === Theme.HELL ? BlockId.HELLSTONE : theme === Theme.TECH ? BlockId.METAL : BlockId.BRICK;
}
/**
 * The cap course, one block deep on every top face. A different VALUE from the
 * wall rather than a different hue — the same trick as the keep roof — so each
 * step of the stair is drawn as a line at a glance and the mass reads as four
 * countable blocks instead of one painted slab.
 */
function bastionCapMaterial(theme: Theme): number {
  return theme === Theme.HELL ? BlockId.BONE : theme === Theme.TECH ? BlockId.TECH_PANEL : BlockId.COBBLESTONE;
}
/**
 * Crag bodies. Deliberately the QUARRIED rocks, not the bastions' built
 * brick/metal/hellstone-wall: cobble against outland's grass, rusted scrap in a
 * tech zone, hellstone in hell. Every one of them is breachable — cobble
 * resists 2.2, rusted metal 3.7, hellstone 3.3 against a rocket's 9.6 at the
 * centre — because a crag is the occluder you are most often nose-to-nose with
 * and the whole point of the piece is that a rocket opens a new sightline.
 */
function cragMaterial(theme: Theme): number {
  return theme === Theme.HELL ? BlockId.HELLSTONE : theme === Theme.TECH ? BlockId.RUSTED_METAL : BlockId.COBBLESTONE;
}
/**
 * The cap course, one block on the top face. A LIGHTER value than the body in
 * all three themes (stone 0x8b8d92 over cobble 0x807f7c, metal 0xa3a9b1 over
 * rust 0x9a5730, bone 0xeae4d0 over hellstone 0x7d2422) so the top edge draws
 * itself and a crag silhouettes as a shape with a lit rim instead of a blob.
 */
function cragCapMaterial(theme: Theme): number {
  return theme === Theme.HELL ? BlockId.BONE : theme === Theme.TECH ? BlockId.METAL : BlockId.STONE;
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
 * A cache slot is 12 doubles:
 *   0 centreX  1 centreZ  2 radius  3 floorY  4 theme
 *   5 pitX     6 pitZ     7 pitRadius (0 = none)
 *   8 ledgePhase (0..1)   9 structure seed
 *  10 keepHalf (0 = no keep)         11 keep orientation, 0..3
 */

const ARENA_STRIDE = 12;
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

  // A wide arena gets a keep; a narrow one stays an open pit fight. The rule is
  // radius alone and not a coin flip, so the map reads as designed: you learn
  // that a big room has a building in it and a small one does not.
  const kh = hash2i(cellX, cellZ, s ^ 0x3d81c7);
  const keepHalf = radius >= KEEP_MIN_RADIUS ? KEEP_HALF_MIN + (kh % KEEP_HALF_SPAN) : 0;
  const keepOrient = (kh >>> 8) & 3;

  const ph = hash2i(cellX, cellZ, s ^ 0x51ed21);
  let pitR = 0, pitX = 0, pitZ = 0;
  // A keep brings its own lava with it, and an open pit under the footprint
  // would punch a hole through the floor of the room. One or the other.
  if (keepHalf === 0 && (ph & 255) < 110) {
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
  data[o + 10] = keepHalf;
  data[o + 11] = keepOrient;
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
/**
 * A SECOND solid span, above an air gap: roof slabs and parapets.
 *
 * One extra span is all an interior needs and all the column model gains — the
 * generator stays a per-column function with no global pass, and a chunk still
 * generates identically whether or not its neighbours exist.
 */
const mRoofBase = new Int16Array(MAP_AREA);
const mRoofTop = new Int16Array(MAP_AREA);
const mRoofMat = new Uint8Array(MAP_AREA);     // 0 = no roof over this column
/** Snapshot of mHeight taken before the vent pass so a vent never reads a vented root. */
const mHeight0 = new Int16Array(MAP_AREA);

const MF_SITE = 1 << 0;      // inside an arena or corridor
const MF_ARENA = 1 << 1;     // inside an arena specifically
const MF_PIT = 1 << 2;       // inside a lava pit
const MF_BUILT = 1 << 3;     // a bastion owns this column (or is one block off it)
/**
 * A keep owns this column. Set so the battle-damage pass can leave the one
 * authored interior in the world alone: its doorway, its clerestory slit, its
 * crates and its roof deck are all load-bearing for the fight, and a stray
 * crater through any of them turns a room back into rubble geometry.
 */
const MF_KEEP = 1 << 4;

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

/* --- the keep ------------------------------------------------------------ */

/**
 * Outputs of the last `stampKeep`. Module scope for the same reason
 * `evaluateSite`'s are: this runs once per column of every generated chunk and
 * a returned object would be an allocation per voxel column.
 */
let kGround = -1;        // ground-top override, -1 = leave the site height alone
let kStructTop = 0;
let kStructMat = 0;
let kStructCap = 0;
let kRoofBase = 0;
let kRoofTop = 0;
let kRoofMat = 0;
let kLiquidTop = -1;
let kLiquidId = 0;

/**
 * Stamp the keep at (ax, az) into the module outputs for world column (x, z).
 *
 * Returns true when the keep owns this column, in which case the caller must
 * skip the cover lattice, the pillars and the centre plinth — a crate half
 * inside a wall is the single most common way a stamped structure stops
 * reading as architecture.
 */
function stampKeep(
  x: number, z: number, ax: number, az: number,
  floorY: number, half: number, orient: number, theme: Theme,
): boolean {
  kGround = -1;
  kStructTop = 0; kStructMat = 0; kStructCap = 0;
  kRoofBase = 0; kRoofTop = 0; kRoofMat = 0;
  kLiquidTop = -1; kLiquidId = 0;

  const dx = x - Math.round(ax);
  const dz = z - Math.round(az);
  // The box is four-fold symmetric, so the orientation only decides which side
  // the stair climbs.
  let u: number, v: number;
  if (orient === 0) { u = dx; v = dz; }
  else if (orient === 1) { u = dz; v = -dx; }
  else if (orient === 2) { u = -dx; v = -dz; }
  else { u = -dz; v = dx; }

  const eu = u < 0 ? -u : u;
  const ev = v < 0 ? -v : v;
  const m = eu > ev ? eu : ev;

  // External stair, three wide, offset off the doorway so it does not seal it.
  // Its top step's surface is exactly the roof deck, so the climb is five
  // one-block steps and never needs a jump — the rocket jump is the fast way
  // up, not the only way up.
  const onStair = v >= 2 && v <= 4;
  if (onStair && u > half && u <= half + KEEP_STAIR_LEN) {
    kStructTop = floorY + KEEP_WALL_H + 1 - (u - half - 1);
    kStructMat = keepWallMaterial(theme);
    return true;
  }
  if (m > half) return false;

  // Roof over the whole footprint, plus a one-block parapet on the ring: chest
  // high from the deck, so the roof is cover and not a diving board.
  kRoofMat = keepRoofMaterial(theme);
  kRoofBase = floorY + KEEP_WALL_H + 1;
  kRoofTop = kRoofBase;

  if (m === half) {
    // The stair arrives here; leave a gap in the parapet or it arrives at a wall.
    if (!(u === half && onStair)) kRoofTop = kRoofBase + 1;

    const pier = eu >= half - 1 && ev >= half - 1;
    const door = (eu === half && ev <= KEEP_DOOR_HALF) || (ev === half && eu <= KEEP_DOOR_HALF);
    if (pier) {
      kStructTop = floorY + KEEP_WALL_H;
      kStructMat = keepPierMaterial();
      kStructCap = pillarCap(theme);
    } else if (!door) {
      kStructTop = floorY + KEEP_PANEL_H;
      kStructMat = keepWallMaterial(theme);
    }
    return true;
  }

  // Interior. A lava basin flush with the floor: the light source that makes
  // the room worth having a roof over, and a hazard in the one place everybody
  // has to walk through.
  const basinHalf = theme === Theme.HELL ? 1 : 0;
  if (eu <= basinHalf && ev <= basinHalf) {
    kGround = floorY - 1;
    kLiquidTop = floorY;
    kLiquidId = BlockId.LAVA;
    return true;
  }

  // Four chest-high crates on the interior diagonals. An empty box with a pool
  // in it is a killbox; four blocks of cover make it a room two people can
  // fight over, and they break the sightline straight through from one doorway
  // to the opposite one.
  if (eu === half - 2 && ev === half - 2) {
    kStructTop = floorY + 2;
    kStructMat = coverMaterial(theme);
  }
  return true;
}

/* --- bastions ------------------------------------------------------------ */

/** Outputs of the last `stampBastion`. Module scope: this runs per column. */
let baHeight = 0;      // solid blocks above the ground, for a mass column
let baArchLo = 0;      // arch lintel, relative to the ground under it
let baArchHi = 0;
let baMat = 0;
let baCap = 0;
let baAnchorX = 0;     // the pair's centre column; the whole pad levels to it
let baAnchorZ = 0;
let baCellX = 0;
let baCellZ = 0;

/**
 * The pad height of one bastion cell, cached.
 *
 * A bastion needs LEVEL GROUND or it is not a bastion: a lane with a 3-block
 * terrace riser across it is not a lane, and a tunnel whose far end is filled in
 * by the hillside is a decoration. So the pair's whole 13x11 footprint — masses,
 * arch and the lane between them — is cut to the height of its own centre
 * column, which turns the terrace it sits on into a plinth.
 *
 * `baseHeight` is pure in (seed, x, z) with nothing cached behind it, so every
 * chunk that touches a pad computes the same number and no seam can open. The
 * cache here is only about cost: a padded chunk patch spans at most 3x3 bastion
 * cells, so 9 evaluations replace ~120.
 */
const BA_PAD_SLOTS = 16;
const baPadX = new Int32Array(BA_PAD_SLOTS);
const baPadZ = new Int32Array(BA_PAD_SLOTS);
const baPadSeed = new Float64Array(BA_PAD_SLOTS);
const baPadY = new Int32Array(BA_PAD_SLOTS);
const baPadOk = new Uint8Array(BA_PAD_SLOTS);

function bastionPadY(seed: number, cellX: number, cellZ: number, px: number, pz: number): number {
  const slot = (cellX * 5 + cellZ * 11) & (BA_PAD_SLOTS - 1);
  if (baPadOk[slot] === 1 && baPadSeed[slot] === seed && baPadX[slot] === cellX && baPadZ[slot] === cellZ) {
    return baPadY[slot];
  }
  const y = Math.round(baseHeight(seed, px, pz));
  baPadOk[slot] = 1; baPadSeed[slot] = seed; baPadX[slot] = cellX; baPadZ[slot] = cellZ; baPadY[slot] = y;
  return y;
}

/** What a bastion does to one column. */
const BA_NONE = 0;
const BA_LANE = 1;     // inside the pair's box but in the lane or the gap
const BA_MASS = 2;     // solid, `baHeight` blocks of it
const BA_ARCH = 3;     // the tunnel: ground, two of air, then the lintel

/**
 * Stamp the bastion pair of (x, z)'s own 24-block cell into the outputs above.
 *
 * Pure in (seed, x, z) like everything else here, and deliberately arranged so
 * a pair can never cross a cell boundary — that is what lets this be one hash
 * and no neighbour scan on the hottest loop in worldgen. See the diagram at
 * BASTION_CELL for what it builds and why.
 */
function stampBastion(x: number, z: number, bseed: number, theme: Theme): number {
  baHeight = 0; baArchLo = 0; baArchHi = 0; baMat = 0; baCap = 0;

  const cellX = Math.floor(x / BASTION_CELL);
  const cellZ = Math.floor(z / BASTION_CELL);
  const hh = hash2i(cellX, cellZ, bseed);
  if ((hh & 255) >= BASTION_CHANCE) return BA_NONE;

  const span = BASTION_JITTER * 2 + 1;
  const px = cellX * BASTION_CELL + BASTION_CELL_HALF + (((hh >>> 8) % span) - BASTION_JITTER);
  const pz = cellZ * BASTION_CELL + BASTION_CELL_HALF + (((hh >>> 14) % span) - BASTION_JITTER);
  baAnchorX = px;
  baAnchorZ = pz;
  baCellX = cellX;
  baCellZ = cellZ;

  const dx = x - px, dz = z - pz;
  // The lane runs along +u. Two bits: one turns the pair 90 degrees, one
  // mirrors it, which is what moves the arch to the other side of the lane.
  let u: number, v: number;
  if (((hh >>> 20) & 1) === 0) { u = dx; v = dz; } else { u = dz; v = -dx; }
  if (((hh >>> 21) & 1) === 1) { u = -u; v = -v; }

  const au = u < 0 ? -u : u;
  const av = v < 0 ? -v : v;
  if (au > BASTION_U || av > BASTION_V_OUT) return BA_NONE;

  // Inside the pair's box. Everything from here is either a mass or the lane,
  // and the lane still reports back so nothing plants a tree in it.
  const onA = v >= BASTION_V_IN && u <= -1;
  const onB = v <= -BASTION_V_IN && u >= 1;
  if (!onA && !onB) return BA_LANE;

  baMat = bastionWallMaterial(theme);
  baCap = bastionCapMaterial(theme);

  // The arch, through mass B only, at |u| in [2, 3].
  if (onB && au >= BASTION_ARCH_U0 && au <= BASTION_ARCH_U1) {
    baArchLo = BASTION_ARCH_CLEAR + 1;
    baArchHi = BASTION_TOP;
    return BA_ARCH;
  }

  // 1, 2, 3, 4 outward-in: a stair you can walk up one block at a time.
  const th = BASTION_U + 1 - au;
  baHeight = th > BASTION_TOP ? BASTION_TOP : th;
  return BA_MASS;
}

/* --- crags ---------------------------------------------------------------- */

/** Outputs of the last `stampCrag`. Module scope: this runs per column. */
let crHeight = 0;      // solid blocks above the ground under this column
let crMat = 0;
let crCap = 0;

/**
 * Stamp the crag of (x, z)'s own 12-block cell. Returns its height in blocks,
 * 0 for "no crag here".
 *
 * Pure in (seed, x, z), one hash, no neighbour scan and no cache — see the
 * diagram at CRAG_CELL for the shape and for why the pitch is 12.
 */
function stampCrag(x: number, z: number, cseed: number, theme: Theme): number {
  crHeight = 0; crMat = 0; crCap = 0;

  const cellX = Math.floor(x / CRAG_CELL);
  const cellZ = Math.floor(z / CRAG_CELL);
  const hh = hash2i(cellX, cellZ, cseed);
  if ((hh & 255) >= CRAG_CHANCE) return 0;

  const span = CRAG_JITTER * 2 + 1;
  const px = cellX * CRAG_CELL + CRAG_CELL_HALF + (((hh >>> 8) % span) - CRAG_JITTER);
  const pz = cellZ * CRAG_CELL + CRAG_CELL_HALF + (((hh >>> 11) % span) - CRAG_JITTER);

  const dx = x - px, dz = z - pz;
  // Two bits again: one lays the long axis along Z instead of X, the other
  // flips which end the walk-up taper is on. Without them a whole region of
  // crags points the same way and the field reads as corduroy.
  let u: number, v: number;
  if (((hh >>> 14) & 1) === 0) { u = dx; v = dz; } else { u = dz; v = dx; }
  if (((hh >>> 15) & 1) === 1) u = -u;

  const au = u < 0 ? -u : u;
  const av = v < 0 ? -v : v;
  if (au > CRAG_U || av > CRAG_V) return 0;

  const top = CRAG_TOP_MIN + ((hh >>> 16) % CRAG_TOP_SPAN);
  // One-sided taper: 1, 2, 3 climbing in from u = -3, then the plateau. A
  // top-4 crag is therefore walk-up high ground and a top-6 one is a wall with
  // a chest-high shoulder — both are over the eye line where it matters.
  const h = u < 0 ? top + u : top;
  crHeight = h < 1 ? 1 : h;
  crMat = cragMaterial(theme);
  crCap = cragCapMaterial(theme);
  return crHeight;
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
  const bastionSeed = seedChannel(seed, 9);
  const cragSeed = seedChannel(seed, 10);

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
      const corridor = siteCorridor;
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
      let roofBase = 0;
      let roofTop = 0;
      let roofMat = 0;
      // Hoisted out of the arena branch: the bastion pass below runs on every
      // column, arena or not, and a keep owns its footprint against all comers.
      let ownedByKeep = false;
      // Wider than the footprint: a crag parked against a keep would seal a
      // doorway or the foot of the external stair, and the doorway is the fight.
      let nearKeep = false;

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

        // The keep owns its footprint outright. It runs before the furniture
        // and short-circuits it: a cover crate half inside a wall is the fastest
        // way to make a stamped building stop reading as a building.
        let inKeep = false;
        const keepHalf = cacheA[arena + 10];
        if (!inPit && keepHalf > 0) {
          const kdx = Math.abs(x - Math.round(ax)), kdz = Math.abs(z - Math.round(az));
          nearKeep = (kdx > kdz ? kdx : kdz) <= keepHalf + CRAG_KEEP_CLEAR;
          inKeep = stampKeep(x, z, ax, az, floorY, keepHalf, cacheA[arena + 11], theme);
          ownedByKeep = inKeep;
          if (inKeep) {
            flags |= MF_KEEP;
            if (kGround >= 0) h = kGround;
            structTop = kStructMat !== 0 ? kStructTop : h;
            structMat = kStructMat;
            structCap = kStructCap;
            roofBase = kRoofBase;
            roofTop = kRoofTop;
            roofMat = kRoofMat;
            if (kLiquidTop >= 0) { liquidTop = kLiquidTop; liquidId = kLiquidId; }
          }
        }

        if (!inPit && !inKeep) {
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

      // Bastions. The one pass that runs OUTSIDE the arenas as well as inside
      // them, because the open plane between the arenas was the part of this
      // world you could see across to the skyline.
      //
      // Four things it stays off, in order of how badly it would break them:
      // a keep footprint (a mass half inside a wall stops both reading as
      // architecture), a lava pit, a corridor lane (that is the connective
      // tissue and it has to stay walkable end to end), and anything the sea or
      // the lava has already claimed.
      //
      // A bastion also needs a ground it can stand on level: `w > 0.88` is a
      // flat arena floor and `w == 0` is untouched terrain, but the rim band
      // between them is a blend, and a mass stamped across a blend is a lump.
      const flatSite = w > 0.88;
      if ((flatSite || w <= 0) && !ownedByKeep && (flags & MF_PIT) === 0 && !corridor) {
        const ba = stampBastion(x, z, bastionSeed, theme);
        if (ba !== BA_NONE) {
          const pad = flatSite ? h : bastionPadY(seed, baCellX, baCellZ, baAnchorX, baAnchorZ);
          const floor = theme === Theme.HELL ? LAVA_LEVEL : SEA_LEVEL;
          if (pad >= floor && pad <= TERRAIN_MAX_HEIGHT - BASTION_TOP - 2) {
            // The whole footprint, lane included, is BUILT and LEVEL: a tree in
            // the lane, or a terrace riser across it, would each undo the one
            // thing the lane is for.
            flags |= MF_BUILT;
            h = pad;
            if (structMat === 0) structTop = h;
            else if (structTop < h) structTop = h;

            if (ba === BA_MASS) {
              const top = h + baHeight;
              if (top > structTop) {
                structTop = top;
                structMat = baMat;
                structCap = baCap;
              }
            } else if (ba === BA_ARCH && roofMat === 0) {
              // Ground, two blocks of air, then a two-block lintel carried on
              // the second solid span. The tunnel is the sightline; the lintel
              // is what a rocket takes out to widen it.
              roofBase = h + baArchLo;
              roofTop = h + baArchHi;
              roofMat = baCap;
            }
          }
        }
      }

      // Crags. Everything above this line put mass either inside an arena or
      // inside a 24-block bastion cell; this is the pass that says no eye-height
      // ray anywhere on the dry plane gets to run to the skyline. It stays off
      // exactly four things — a bastion footprint (MF_BUILT, lane included, so a
      // rock never plugs the lane or the arch), a keep and the ring around its
      // doorways, a lava pit, and anything the sea has already drowned — and
      // takes everything else, including the two places nothing was reaching
      // before: the banked rim band around every arena, and the corridors.
      //
      // No pad and no height clamp: a crag stacks on whatever ground it lands
      // on, and `structTop` is a running max, so a crag over a cover crate just
      // swallows the crate instead of fighting it for the column.
      if ((flags & MF_BUILT) === 0 && !ownedByKeep && !nearKeep && (flags & MF_PIT) === 0) {
        const drown = theme === Theme.HELL ? LAVA_LEVEL : SEA_LEVEL;
        if (h >= drown - 1) {
          const ch = stampCrag(x, z, cragSeed, theme);
          if (ch > 0) {
            const top = h + ch;
            if (top > structTop) {
              structTop = top;
              structMat = crMat;
              structCap = crCap;
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
      mRoofBase[mi] = roofBase;
      mRoofTop[mi] = roofTop;
      mRoofMat[mi] = roofMat;
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
  // A bastion's lane has no structure in it, so without this a trunk plants
  // itself in the middle of the gap the pair exists to create.
  if ((mFlags[mi] & MF_BUILT) !== 0) return false;
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


/* --- pass 4: battle damage ----------------------------------------------- *
 *
 * WHY THE GENERATOR CUTS CRATERS AND NOT ONLY THE ROCKET LAUNCHER.
 *
 * Every wall the passes above stamp used to come out of the ground factory
 * fresh: six flat faces, twelve perfect ninety-degree edges, not a chip on any
 * of them. That is an honest picture of a level nobody has fought in yet, and
 * it is exactly the wrong picture, because the claim this piece is judged on is
 * that the terrain comes apart. A player looking at an unmarked wall has no
 * reason to believe it is anything but scenery, and the first frame anyone ever
 * sees is a frame in which nothing has been shot yet.
 *
 * So the arenas ship ALREADY FOUGHT OVER. This pass is not a decal generator
 * and not a second, parallel description of damage: it runs the same arithmetic
 * `destruction.ts` runs at runtime — the same `power * (1 - (d/r)^2)` against
 * the same `hardness^1.5` blast resistance, the same hardness jitter band that
 * gives a rim its spall, the same `BLAST_CHAR` table for the surviving skin —
 * at a lattice of impact points. A pre-baked crater and the crater your next
 * rocket cuts beside it are the same object made by the same code, which is
 * the only way the pre-baked ones are allowed to count as evidence.
 *
 * Five rules keep it a scar and not a demolition:
 *
 *  - Nothing is cut below the plane the impact went off over (`floorPlane`).
 *    On flat ground that dishes a floor by one course and no more: no pit to
 *    fall into, no spawn made unstandable, no corridor opened to the bedrock.
 *    On a terrace riser or a cliff face — most of the standing surface in a
 *    world whose heights are quantised into three-block steps — the same rule
 *    lets the blast eat sideways into the face and leave an alcove.
 *  - A KEEP burns but does not break (`scarCharOnly`). Its doorway, clerestory,
 *    crates and roof deck are authored and stay bit-identical; only their
 *    colour changes. Deathmatch often spawns a player inside one, and the first
 *    frame they see must not be the one frame in the world with no damage.
 *  - Nothing at all happens to a lava pit or to a column carrying the second
 *    solid span (`mRoofMat`) — keep roofs and bastion arch lintels. An arch is a
 *    sightline somebody has to be able to run through.
 *  - Debris never seals a way through (`plugsAWay`), and it only settles in
 *    columns the blast actually bit (`sBitten`), so the mouth of an arch two
 *    metres from a crater stays swept.
 *  - Obsidian resists 27 against a scar's 11-21, exactly as it resists a rocket,
 *    so the skeleton of every arena survives this pass unmarked. What gets
 *    chewed is what was authored to be chewable: panels, crag flanks, cover.
 *
 * Seam safety. The removal and char tests read nothing but the voxel itself,
 * the voxel directly over it and the site; the rubble test reads nothing but
 * its own column. No voxel's fate depends on a neighbour that might live in
 * another chunk, which is what lets chunk (7, -3) come out identical whether or
 * not (8, -3) has ever been generated.
 */

/**
 * Char target per source id; 0 means "this material does not char".
 *
 * Exported and imported by `client/src/world/destruction.ts`, which used to
 * carry its own copy. One table, so a wall scorched by the generator and a wall
 * scorched by a rocket are the same colour.
 */
export const BLAST_CHAR = new Uint8Array(BLOCK_COUNT);
for (const id of [
  BlockId.GRASS, BlockId.DIRT, BlockId.SAND, BlockId.SNOW, BlockId.STONE,
  BlockId.COBBLESTONE, BlockId.BRICK, BlockId.PLANKS,
  BlockId.WOOD, BlockId.BONE,
]) BLAST_CHAR[id] = BlockId.HELLSTONE;
/**
 * The tech theme burns RED, not rust.
 *
 * Rust was the first answer and it was the wrong one for a measurable reason:
 * `cragMaterial(TECH)` is RUSTED_METAL and the tech surface stratum is 22%
 * rusted metal already, so a rusted scar on a metal wall did not read as
 * damage — it read as the next wall material along. Hellstone is in nothing a
 * tech zone is built from, it is the strongest value AND hue break available
 * against tech panel's blue-grey 0x4e5966, and it emits light 5, so a burn in a
 * dark tech corridor is still faintly hot. It also resists 3.26 against tech
 * panel's 4.19: scarring a wall makes it SOFTER, never armoured.
 */
BLAST_CHAR[BlockId.METAL] = BlockId.HELLSTONE;
BLAST_CHAR[BlockId.TECH_PANEL] = BlockId.HELLSTONE;
BLAST_CHAR[BlockId.RUSTED_METAL] = BlockId.HELLSTONE;
/**
 * Hellstone burns to ASH, and this entry is what stops the hell theme from
 * being the one place in the world where damage is invisible. Everything hell
 * is built out of is hellstone or obsidian; obsidian is blast-proof on purpose,
 * and charring hellstone to a darker rock is impossible — at luminance 59 it is
 * already the second darkest thing in the palette, and the two below it are
 * obsidian and bedrock, both of which would ARMOUR the scar.
 *
 * So it burns upward in value, to gravel. Bone was tried first and lost: at
 * 0xeae4d0 it is near white, and a hell arena with a bone rim on every crater
 * photographed as a red-and-white chequerboard rather than as scorched rock.
 * Gravel's 0x8f8b83 is the ash reading, it holds a clear value step over
 * hellstone, and at resist 0.46 a scarred wall is the softest thing on the map
 * — the opposite of armour, which is the property that matters most.
 */
BLAST_CHAR[BlockId.HELLSTONE] = BlockId.GRAVEL;

/** Impact lattice pitch. Coprime with the 5, 9, 12, 24 and 64 lattices above. */
export const SCAR_CELL = 12;
/** Share of lattice nodes that carry an impact. */
const SCAR_CHANCE = 0.72;
/** Sub-cell displacement of an impact from its node, so no grid is visible. */
const SCAR_JITTER = 6;
const SCAR_MIN_RADIUS = 3.0;
const SCAR_RADIUS_SPAN = 2.6;
/**
 * Blast strength per block of radius. The same number as
 * `TERRAIN_POWER_PER_BLOCK` in destruction.ts, and it has to be: at 3.7 a scar
 * of radius 3.0-5.6 carries 11.1-20.7 at its centre, which puts it between one
 * rocket (9.6) and two, and leaves obsidian's 27 untouched at every radius.
 */
const SCAR_POWER_PER_BLOCK = 3.7;
/** Impact height over the natural surface, in blocks: knee to over the head. */
const SCAR_LIFT_MIN = 1;
const SCAR_LIFT_SPAN = 3;
/** Hardness jitter band. Matches destruction.ts, so rims spall the same way. */
const SCAR_JITTER_MIN = 0.74;
const SCAR_JITTER_SPAN = 0.54;
/** The same band on the one course of floor a blast may dish. See the call site. */
const SCAR_FLOOR_JITTER_MIN = 0.94;
const SCAR_FLOOR_JITTER_SPAN = 0.16;
/**
 * The char reach, as a multiple of the crater radius.
 *
 * It is a separate radius and not a band inside the blast for a measured
 * reason. Blast strength falls off as `1 - (d/r)^2` while a wall's resistance
 * is a constant, so with a rocket's ten units of power against stone's 1.84 the
 * removal boundary already sits at 0.91r: the set of voxels that "nearly
 * survived" is a shell 0.13 blocks thick, which is a shell nobody can see. The
 * burn a blast leaves is wider than the hole it cuts, so it is measured from
 * the centre in its own right.
 */
const SCAR_CHAR_REACH = 1.24;
/** Char density at the crater lip; it thins to nothing at the char reach. */
const SCAR_CHAR_CHANCE = 0.9;
/**
 * The lip shell, in blocks past the crater edge, inside which a surviving voxel
 * chars whether or not it has open sky over it. Past that only voxels with air
 * directly above them take the burn, which is what puts scorch on the floor
 * around a crater and on the top of the wall it bit into without blackening
 * rock nobody will ever excavate.
 */
const SCAR_LIP = 1.0;
/** How far past the crater lip debris is thrown. */
const RUBBLE_MARGIN = 1.6;
/** Share of columns under a crater that catch a block of settled debris. */
const RUBBLE_CHANCE = 0.85;
/** Longest solid run a fresh hole may leave hanging over it before it falls. */
const SPALL_MAX_RUN = 2;

/**
 * Blast resistance. Duplicated from `destruction.ts` deliberately — `shared`
 * cannot import from `client` — and pinned by a test that fires a real rocket
 * into a scar and requires it to widen it.
 */
function scarResist(hardness: number): number {
  return hardness * Math.sqrt(hardness);
}

/** Debris a theme leaves behind, given a per-column hash. */
function rubbleBlock(theme: Theme, r: number): number {
  if (theme === Theme.TECH) return r < 0.55 ? BlockId.RUSTED_METAL : BlockId.GRAVEL;
  // Never hellstone on hellstone: a pile you cannot see is not a pile. Mostly
  // ash, with a little bone through it — hell's own crag caps are bone, so a
  // few pale shards read as masonry that came off something, not as snow.
  if (theme === Theme.HELL) return r < 0.9 ? BlockId.GRAVEL : BlockId.BONE;
  return r < 0.62 ? BlockId.GRAVEL : BlockId.COBBLESTONE;
}

/**
 * Columns nothing may happen to at all: a lava pit, and any column carrying the
 * second solid span — keep roofs and bastion arch lintels. An arch is a
 * sightline somebody has to be able to run through; a hole in it is not a scar,
 * it is a broken level.
 */
function scarProtected(mi: number): boolean {
  return (mFlags[mi] & MF_PIT) !== 0 || mRoofMat[mi] !== 0;
}

/**
 * Columns the blast may BURN but not break.
 *
 * The keep is the one authored interior in the world — its doorway, clerestory
 * slit, crates and roof deck are all load-bearing for the fight it exists to
 * host, and a generator crater through any of them turns a room back into
 * rubble geometry. But leaving it untouched had a worse failure: a deathmatch
 * spawn often puts the player INSIDE it, and the frame they see first was then
 * the one frame in the whole world with no damage in it anywhere.
 *
 * So a keep chars and does not break. Every solid stays solid and every void
 * stays void — the geometry is bit-identical to the authored keep — but its
 * panels, its floor and its crates come out of the ground already blackened,
 * and the rocket the player is holding still opens a real hole in them, because
 * runtime destruction does not consult this.
 */
function scarCharOnly(mi: number): boolean {
  return (mFlags[mi] & MF_KEEP) !== 0;
}

/**
 * Drop the stranded cap over the lowest fresh hole in one column.
 *
 * Walks up from the floor of the crater box to the first air-under-solid step,
 * measures the solid run above it, and deletes the run when it is thin enough
 * to be rubble rather than structure. Bounded to the crater's own y span, so a
 * scar can never reach up a tower and take its top off.
 */
function collapseSpall(
  out: Uint8Array, lx: number, lz: number, y0: number, y1: number, maxY: number,
): void {
  for (let y = y0; y <= y1; y++) {
    if (out[voxelIndex(lx, y, lz)] !== BlockId.AIR) continue;
    const base = y + 1;
    if (base > maxY || out[voxelIndex(lx, base, lz)] === BlockId.AIR) continue;
    let top = base;
    while (top <= maxY && out[voxelIndex(lx, top, lz)] !== BlockId.AIR) top++;
    const run = top - base;
    if (run <= SPALL_MAX_RUN && top <= y1 + SPALL_MAX_RUN) {
      for (let k = base; k < top; k++) {
        if (BLOCK_HARDNESS[out[voxelIndex(lx, k, lz)]] < 0) return;   // bedrock: nothing falls
      }
      for (let k = base; k < top; k++) out[voxelIndex(lx, k, lz)] = BlockId.AIR;
    }
    return;
  }
}

/**
 * True when a block dropped on the surface at `y` would plug a route.
 *
 * The profile it refuses is exact and it is the only one that matters: two
 * blocks of clear (a standing player is 1.8 m) closed off by a solid lintel
 * above them, which is a doorway, a keep clerestory or a bastion arch. Debris
 * is allowed to gather inside a crater bowl, where the clear above it is deeper
 * than a doorway or open to the sky; it is never allowed to seal a way through.
 */
function plugsAWay(out: Uint8Array, lx: number, y: number, lz: number, maxY: number): boolean {
  if (y + 3 > maxY) return false;
  return out[voxelIndex(lx, y + 2, lz)] === BlockId.AIR
      && out[voxelIndex(lx, y + 3, lz)] !== BlockId.AIR;
}

/**
 * Columns the current impact actually bit — removed or charred at least one
 * voxel in. Debris is only allowed to settle in these, which is what keeps a
 * scar from sprinkling gravel across untouched ground: the mouth of a bastion
 * arch two metres from a crater must stay swept, or the tunnel stops reading
 * as a route you can run. Module scope, cleared per impact.
 */
const sBitten = new Uint8Array(MAP_AREA);

function applyBattleDamage(seed: number, cx: number, cz: number, out: Uint8Array): void {
  const baseX = cx * CHUNK_SIZE_X;
  const baseZ = cz * CHUNK_SIZE_Z;
  const scarSeed = seedChannel(seed, 11);
  const charSeed = seedChannel(seed, 12);
  const rubbleSeed = seedChannel(seed, 13);
  const maxY = CHUNK_HEIGHT - 2;

  // A site can reach into this chunk from `radius + rubble margin + jitter`
  // blocks outside it, and the lattice is walked over that widened box so both
  // sides of every chunk border see the identical set of impacts.
  const reach = Math.ceil(SCAR_MIN_RADIUS + SCAR_RADIUS_SPAN + RUBBLE_MARGIN + SCAR_JITTER) + 1;
  const n0x = Math.ceil((baseX - reach) / SCAR_CELL) * SCAR_CELL;
  const n0z = Math.ceil((baseZ - reach) / SCAR_CELL) * SCAR_CELL;
  const n1x = baseX + CHUNK_SIZE_X - 1 + reach;
  const n1z = baseZ + CHUNK_SIZE_Z - 1 + reach;

  for (let nz = n0z; nz <= n1z; nz += SCAR_CELL) {
    for (let nx = n0x; nx <= n1x; nx += SCAR_CELL) {
      const h = hash2i(nx, nz, scarSeed);
      if ((h & 1023) >= SCAR_CHANCE * 1024) continue;

      const sx = nx + 0.5 + (((h >>> 10) & 7) - 3.5) * (SCAR_JITTER / 4);
      const sz = nz + 0.5 + (((h >>> 13) & 7) - 3.5) * (SCAR_JITTER / 4);
      const radius = SCAR_MIN_RADIUS + SCAR_RADIUS_SPAN * (((h >>> 16) & 255) / 256);
      const lift = SCAR_LIFT_MIN + ((h >>> 24) % SCAR_LIFT_SPAN);
      const ground = surfaceHeightAt(seed, Math.round(sx - 0.5), Math.round(sz - 0.5));
      const sy = ground + lift + 0.5;
      const power = radius * SCAR_POWER_PER_BLOCK;
      const jseed = scarSeed ^ Math.imul(h, 0x9e3779b1);
      /**
       * THE FLOOR OF THE BLAST — the one rule that decides whether this pass
       * scars a level or ruins it.
       *
       * Nothing is cut below the plane the impact went off over. On flat ground
       * that is one course under the surface, so an arena floor can be dished
       * and scorched but never pitted: there is no hole to fall into, no spawn
       * left unstandable, no corridor floor opened into the bedrock.
       *
       * On a TERRACE RISER or a CLIFF FACE — which is most of the standing
       * surface in this world, because the height field is quantised into
       * three-block steps — the column's own ground is metres above the impact,
       * so the same rule lets the blast eat sideways into the face and leave an
       * alcove with the shelf still over it. That is the difference between a
       * generator that scars its buildings and one that scars everything you
       * can shoot, and it is the reason the guard is measured from the impact
       * rather than from each column.
       */
      const floorPlane = ground;

      const r2 = radius * radius;
      const inv = 1 / r2;
      const charR = radius * SCAR_CHAR_REACH;
      const charR2 = charR * charR;
      const lip = radius + SCAR_LIP;
      const lip2 = lip * lip;
      sBitten.fill(0);

      /* --- the hole and the burn around it ------------------------------ */
      const lx0 = Math.max(0, Math.floor(sx - charR) - baseX);
      const lx1 = Math.min(CHUNK_SIZE_X - 1, Math.ceil(sx + charR) - baseX);
      const lz0 = Math.max(0, Math.floor(sz - charR) - baseZ);
      const lz1 = Math.min(CHUNK_SIZE_Z - 1, Math.ceil(sz + charR) - baseZ);
      const y0 = Math.max(1, Math.floor(sy - charR));
      const y1 = Math.min(maxY, Math.ceil(sy + charR));

      for (let lz = lz0; lz <= lz1; lz++) {
        const z = baseZ + lz;
        const dz = z + 0.5 - sz;
        const dz2 = dz * dz;
        if (dz2 > charR2) continue;
        for (let lx = lx0; lx <= lx1; lx++) {
          const x = baseX + lx;
          const dx = x + 0.5 - sx;
          const dxz2 = dx * dx + dz2;
          if (dxz2 > charR2) continue;
          const mi = mapIndex(lx, lz);
          if (scarProtected(mi)) continue;
          const burnOnly = scarCharOnly(mi);
          let cut = false;

          // Downward, so a voxel sees the hole above it before it decides
          // whether it is exposed: that is what puts the burn on a crater floor
          // and not only on its lip.
          for (let y = y1; y >= y0; y--) {
            if (y < floorPlane) break;
            const dy = y + 0.5 - sy;
            const d2 = dxz2 + dy * dy;
            if (d2 > charR2) continue;
            const i = voxelIndex(lx, y, lz);
            const id = out[i];
            if (id === BlockId.AIR) continue;
            const hardness = BLOCK_HARDNESS[id];
            if (hardness < 0) continue;                 // bedrock, water, lava
            // Never undercut standing liquid; a drained lava basin reads as a
            // generator bug, not as damage.
            const above = out[voxelIndex(lx, y + 1, lz)];
            if (above === BlockId.WATER || above === BlockId.LAVA) continue;

            if (d2 <= r2 && !burnOnly) {
              // Ragged everywhere except on the floor plane. A wall wants the
              // full jitter band — that is what spalls its rim. A FLOOR cannot
              // be cut deeper than one course, so the same jitter there does
              // not read as a ragged edge, it reads as a chequerboard of
              // alternating pits, and a chequerboard is a pattern rather than a
              // crater. On that one course the edge is nearly clean, so the
              // dish comes out round.
              const jitter = y === floorPlane
                ? SCAR_FLOOR_JITTER_MIN + SCAR_FLOOR_JITTER_SPAN * hash3f(x, y, z, jseed)
                : SCAR_JITTER_MIN + SCAR_JITTER_SPAN * hash3f(x, y, z, jseed);
              if (power * (1 - d2 * inv) > scarResist(hardness) * jitter) {
                out[i] = BlockId.AIR;
                cut = true;
                sBitten[mi] = 1;
                continue;
              }
            }

            const to = BLAST_CHAR[id];
            if (to === 0) continue;
            if (d2 > lip2 && above !== BlockId.AIR) continue;
            // Linear in distance, so the ash is densest at the lip and gone
            // at the reach. A squared falloff was tried to tighten the halo
            // further and cut the burn by a factor of twenty — at this reach
            // the ring is already most of the term, and squaring it deleted
            // the thing it was supposed to sharpen.
            const near = 1 - Math.sqrt(d2) / charR;
            if (hash3f(x, y, z, charSeed) >= SCAR_CHAR_CHANCE * near) continue;
            out[i] = to;
            sBitten[mi] = 1;
          }

          // SPALL. A blast that eats the bottom out of a wall leaves whatever
          // was resting on it hanging in the air, and one or two courses of
          // masonry with nothing under them do not hang — they come down. So
          // any run of one or two solid voxels left stranded over a fresh hole
          // is dropped with it. Without this the generator produces exactly the
          // thing the arch test is built to catch: a two-block lintel over two
          // blocks of clear that nobody built and nobody can walk through.
          if (cut) collapseSpall(out, lx, lz, Math.max(y0, floorPlane), y1, maxY);
        }
      }

      /* --- the debris -------------------------------------------------- *
       * Settled, not sprayed: the scan starts one block UNDER the detonation
       * and walks down, so rubble can only ever come to rest below the height
       * the blast went off at. That is what a pile of spall looks like, and it
       * also means no crater can drop a block into the sightline it just cut.
       */
      const rr = radius + RUBBLE_MARGIN;
      const rr2 = rr * rr;
      const bx0 = Math.max(0, Math.floor(sx - rr) - baseX);
      const bx1 = Math.min(CHUNK_SIZE_X - 1, Math.ceil(sx + rr) - baseX);
      const bz0 = Math.max(0, Math.floor(sz - rr) - baseZ);
      const bz1 = Math.min(CHUNK_SIZE_Z - 1, Math.ceil(sz + rr) - baseZ);
      const scanTop = Math.min(maxY - 1, Math.floor(sy) - 1);
      const scanBottom = Math.max(1, Math.floor(sy - radius) - 1);

      for (let lz = bz0; lz <= bz1; lz++) {
        const z = baseZ + lz;
        const dz = z + 0.5 - sz;
        const dz2 = dz * dz;
        if (dz2 > rr2) continue;
        for (let lx = bx0; lx <= bx1; lx++) {
          const x = baseX + lx;
          const dx = x + 0.5 - sx;
          const d2 = dx * dx + dz2;
          if (d2 > rr2) continue;
          const mi = mapIndex(lx, lz);
          if (scarProtected(mi) || scarCharOnly(mi) || sBitten[mi] === 0) continue;
          // Thickest under the hole, thinning outward — but never to nothing
          // inside the throw limit, or the pile stops reading as a pile.
          const fall = 1 - 0.62 * (Math.sqrt(d2) / rr);
          if (hash3f(x, 0, z, rubbleSeed) >= RUBBLE_CHANCE * fall) continue;

          // Down to the ground at the latest: spall off a wall lands at the
          // foot of the wall, which is the pile you actually see from eye level.
          const colBottom = Math.max(1, Math.min(scanBottom, mHeight[mi] - 2));
          for (let y = scanTop; y >= colBottom; y--) {
            const below = out[voxelIndex(lx, y, lz)];
            if (below === BlockId.AIR) continue;
            if (below === BlockId.WATER || below === BlockId.LAVA) break;
            if (below === BlockId.LEAVES) break;
            const ti = voxelIndex(lx, y + 1, lz);
            if (out[ti] === BlockId.AIR && !plugsAWay(out, lx, y, lz, maxY)) {
              out[ti] = rubbleBlock(mTheme[mi] as Theme, hash3f(x, y, z, rubbleSeed ^ 0x51ed27));
            }
            break;
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

      // The second span: roof slab and parapet, above the air the room is made
      // of. Always higher than everything written above it, so nothing here can
      // overwrite a wall.
      const roofMat = mRoofMat[mi];
      if (roofMat !== 0) {
        const rb = mRoofBase[mi];
        const rt = mRoofTop[mi] > maxY ? maxY : mRoofTop[mi];
        for (let y = rb; y <= rt; y++) out[voxelIndex(lx, y, lz)] = roofMat;
      }
    }
  }

  applyTrees(seed, cx, cz, out);
  applyBattleDamage(seed, cx, cz, out);
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
  baPadOk.fill(0);
}
