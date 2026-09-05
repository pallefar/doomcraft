/**
 * DOOMCRAFT — breaking, placing and blowing holes in the level.
 *
 * Destruction is the Minecraft half of the pitch, so it has to be *real*: a
 * rocket does not scorch a decal onto a wall, it deletes a sphere of voxels and
 * the arena is permanently different. The bar has building but no explosive
 * terrain damage at all, which is the whole reason rockets and the BFG carry a
 * `terrainDamage` radius in the weapon table.
 *
 * Everything here is deterministic given (position, radius, power, seed) so the
 * client can carve immediately on the predicted hit and the server's authoritative
 * BLOCK_DELTA reproduces exactly the same crater — no popping, no reconcile flash.
 *
 * Allocation: zero on the hot path. Callers pass sinks and scratch.
 */

import {
  BLOCK_BREAK_BASE_MS, REACH_BREAK, REACH_PLACE,
  CHUNK_HEIGHT, TERRAIN_CARVE_MAX_RADIUS, clamp01,
} from '@shared/constants';
import {
  BlockId, BLOCK_COUNT, BLOCK_HARDNESS, BLOCK_SOLID, BLOCK_OPAQUE, Face,
  isReplaceable, isPlaceable, isBreakable, blockBreakMs, blockFaceColor,
} from '@shared/blocks';
import { WEAPONS } from '@shared/weapons';
import { hash3f, type VoxelHit } from '@shared/math';
import { BLAST_CHAR } from '@shared/terrain';
import type { VoxelWorld } from './voxelWorld';

/* ------------------------------------------------------------------------ *
 * Hooks the renderer implements
 * ------------------------------------------------------------------------ */

/**
 * Presentation hooks. The renderer owns every one of these; destruction only
 * calls them. Every method is optional so headless code (tests, the server-side
 * mirror, bots) can pass a partial object or nothing at all.
 */
export interface DestructionFx {
  /**
   * Progressive dig feedback. `progress` is 0..1 and `stage` is 0..DIG_STAGES-1,
   * the crack-overlay frame index. Called with stage < 0 to clear the overlay.
   */
  digProgress?(x: number, y: number, z: number, progress: number, stage: number): void;
  /** A block finished breaking. `color` is the packed 0xRRGGBB of its top face. */
  blockBroken?(x: number, y: number, z: number, blockId: number, color: number): void;
  blockPlaced?(x: number, y: number, z: number, blockId: number): void;
  /**
   * Debris burst. `count` particles of `color` leaving (x,y,z) at ~`speed` m/s.
   * Called once per surviving voxel sample of an explosion, budget-limited.
   */
  debris?(x: number, y: number, z: number, color: number, count: number, speed: number): void;
  /** Blast light + shockwave at the centre. */
  explosion?(x: number, y: number, z: number, radius: number, color: number): void;
}

/**
 * Where changed voxels are recorded. `BlockDeltaBuffer` from
 * `@shared/protocol` satisfies this exactly, which is the point: the client
 * carves into one of these and ships the same buffer to the server.
 */
export interface BlockChangeSink {
  push(x: number, y: number, z: number, id: number): boolean;
}

/* ------------------------------------------------------------------------ *
 * Digging
 * ------------------------------------------------------------------------ */

/** Crack-overlay frames. The renderer needs an atlas of exactly this many. */
export const DIG_STAGES = 10;

/**
 * Progressive dig with a crack overlay. One of these per player (the local one
 * predicts; the server runs the authoritative copy).
 *
 * Contract with the caller: call `update` every frame with the block currently
 * under the crosshair. Switching target, releasing the button or losing the
 * block resets progress — Doom-pace digging is meant to punish target hopping.
 */
export class DigController {
  active = false;
  x = 0; y = 0; z = 0;
  blockId = BlockId.AIR;
  /** 0..1 */
  progress = 0;
  /** 0..DIG_STAGES-1, or -1 when idle. */
  stage = -1;
  /** Total milliseconds the current target needs. Infinity when unbreakable. */
  requiredMs = 0;
  elapsedMs = 0;
  /** Bare hands are 1.0. A pickaxe-equivalent tool raises it. */
  toolPower = 1;

  reset(fx?: DestructionFx): void {
    if (this.active && this.stage >= 0 && fx?.digProgress) {
      fx.digProgress(this.x, this.y, this.z, 0, -1);
    }
    this.active = false;
    this.progress = 0;
    this.stage = -1;
    this.elapsedMs = 0;
    this.requiredMs = 0;
    this.blockId = BlockId.AIR;
  }

  /**
   * Advance the dig. Returns true on the frame the block breaks — the caller
   * then applies `breakBlock` and sends the BLOCK_EDIT.
   *
   * `hasTarget` false (nothing under the crosshair, or out of reach) or
   * `holding` false both cancel.
   */
  update(
    world: VoxelWorld,
    holding: boolean, hasTarget: boolean,
    tx: number, ty: number, tz: number,
    dtMs: number, fx?: DestructionFx,
  ): boolean {
    if (!holding || !hasTarget) {
      if (this.active) this.reset(fx);
      return false;
    }

    const id = world.blockAt(tx, ty, tz);
    if (id === BlockId.AIR || !isBreakable(id)) {
      if (this.active) this.reset(fx);
      return false;
    }

    if (!this.active || tx !== this.x || ty !== this.y || tz !== this.z || id !== this.blockId) {
      if (this.active) this.reset(fx);
      this.active = true;
      this.x = tx; this.y = ty; this.z = tz;
      this.blockId = id;
      this.elapsedMs = 0;
      this.progress = 0;
      this.stage = -1;
      this.requiredMs = blockBreakMs(id, this.toolPower, BLOCK_BREAK_BASE_MS);
    }

    if (!isFinite(this.requiredMs)) return false;

    this.elapsedMs += dtMs;
    const p = clamp01(this.requiredMs > 0 ? this.elapsedMs / this.requiredMs : 1);
    this.progress = p;

    if (p >= 1) {
      if (fx?.digProgress) fx.digProgress(tx, ty, tz, 1, -1);
      this.active = false;
      this.stage = -1;
      this.elapsedMs = 0;
      this.progress = 0;
      return true;
    }

    const stage = (p * DIG_STAGES) | 0;
    if (stage !== this.stage) {
      this.stage = stage;
      if (fx?.digProgress) fx.digProgress(tx, ty, tz, p, stage);
    }
    return false;
  }
}

/* ------------------------------------------------------------------------ *
 * Single-block edits
 * ------------------------------------------------------------------------ */

/**
 * Remove one block. Returns the removed id, or 0 when nothing changed.
 * Dirty fan-out is handled inside `VoxelWorld.setBlock`.
 */
export function breakBlock(
  world: VoxelWorld, x: number, y: number, z: number,
  fx?: DestructionFx, sink?: BlockChangeSink,
): number {
  const id = world.blockAt(x, y, z);
  if (id === BlockId.AIR || !isBreakable(id)) return 0;
  if (!world.setBlock(x, y, z, BlockId.AIR)) return 0;

  const color = blockFaceColor(id, Face.PY);
  if (fx?.blockBroken) fx.blockBroken(x, y, z, id, color);
  if (fx?.debris) fx.debris(x + 0.5, y + 0.5, z + 0.5, color, 9, 4.5);
  if (sink) sink.push(x, y, z, BlockId.AIR);
  return id;
}

/**
 * Place a block. Returns true when the world changed.
 *
 * `occupied` lets the caller veto positions a body is standing in — pass the
 * predicate that tests every live player and entity AABB against the block
 * cube. Placing inside yourself is the classic griefing bug and the check is
 * cheap, so it is not optional in practice.
 */
export function placeBlock(
  world: VoxelWorld, x: number, y: number, z: number, id: number,
  occupied?: (x: number, y: number, z: number) => boolean,
  fx?: DestructionFx, sink?: BlockChangeSink,
): boolean {
  if (y < 0 || y >= CHUNK_HEIGHT) return false;
  if (!isPlaceable(id)) return false;
  const existing = world.blockAt(x, y, z);
  if (!isReplaceable(existing)) return false;
  if (BLOCK_SOLID[id] === 1 && occupied !== undefined && occupied(x, y, z)) return false;
  if (!world.setBlock(x, y, z, id)) return false;

  if (fx?.blockPlaced) fx.blockPlaced(x, y, z, id);
  if (sink) sink.push(x, y, z, id);
  return true;
}

/**
 * True when the axis-aligned player box overlaps the unit cube at (x, y, z).
 * Handed to `placeBlock` as the `occupied` predicate.
 */
export function boxOverlapsBlock(
  px: number, py: number, pz: number, halfW: number, height: number,
  x: number, y: number, z: number,
): boolean {
  return px - halfW < x + 1 && px + halfW > x &&
         py < y + 1 && py + height > y &&
         pz - halfW < z + 1 && pz + halfW > z;
}

/* ------------------------------------------------------------------------ *
 * Edit targeting
 * ------------------------------------------------------------------------ */

/** Anything solid stops the build ray; liquids do not. */
function editBlocking(id: number): boolean { return BLOCK_SOLID[id] === 1; }

/**
 * Raycast for a break target. `out.hit` true means `out.x/y/z` is the block to
 * break and `out.nx/ny/nz` is the face you are looking at.
 */
export function pickBreakTarget(
  world: VoxelWorld,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  out: VoxelHit, reach: number = REACH_BREAK,
): boolean {
  return world.raycast(ox, oy, oz, dx, dy, dz, reach, out, editBlocking);
}

/**
 * Raycast for a place target. On a hit, writes the *adjacent* cell into
 * `out.px/py/pz` as integers (the block coordinates the new voxel would occupy)
 * and leaves `out.x/y/z` as the surface that was hit.
 */
export function pickPlaceTarget(
  world: VoxelWorld,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  out: VoxelHit, reach: number = REACH_PLACE,
): boolean {
  if (!world.raycast(ox, oy, oz, dx, dy, dz, reach, out, editBlocking)) return false;
  out.px = out.x + out.nx;
  out.py = out.y + out.ny;
  out.pz = out.z + out.nz;
  return true;
}

/* ------------------------------------------------------------------------ *
 * Explosive carving
 * ------------------------------------------------------------------------ */

/**
 * Blast strength per block of `WeaponDef.terrainDamage`.
 *
 * Calibrated so a shot's `terrainDamage` really is its crater radius in STONE:
 * strength(0.9R) == blastResist(stone), i.e. a rocket opens a ~4.7 m hole and a
 * BFG opens a ~10 m one. Anything softer than stone craters to the full radius.
 */
export const TERRAIN_POWER_PER_BLOCK = 3.7;
/**
 * Blast resistance is hardness^1.5, not hardness. The exponent is what separates
 * the arena's skeleton from its walls: stone 1.84 and brick 2.83 give way, metal
 * 5.2 takes a small hole, and obsidian 27 is blast-proof at every radius in the
 * weapon table — so a level built on obsidian keeps its shape through a firefight.
 */
function blastResist(hardness: number): number {
  return hardness * Math.sqrt(hardness);
}
/** Hardness jitter band, so craters have a ragged edge instead of a billiard-ball surface. */
const CARVE_JITTER_MIN = 0.74;
const CARVE_JITTER_SPAN = 0.54;
/** Upper bound on debris bursts per explosion, whatever the radius. */
const MAX_DEBRIS_BURSTS = 40;

/* ------------------------------------------------------------------------ *
 * Scorching
 *
 * A crater you cannot see from across the arena has not changed the level, it
 * has only changed the collision. Removing voxels leaves a hole whose rim is
 * the same colour as the wall it was cut out of, so from twenty metres a
 * breached keep still reads as an intact keep and the player never learns that
 * shooting the wall was worth doing.
 *
 * So the blast also CONVERTS the surviving skin of the crater to slag. The
 * target is HELLSTONE for almost everything, and that is not a colour choice:
 * hellstone is the darkest breakable rock in the palette (luminance 59 against
 * stone's 141) AND it emits light level 5, so a fresh crater is a dark red
 * scar that glows for two blocks in the mesher's block-light channel. In a dark
 * room a rocket leaves something that is still hot. Metals go to rusted metal
 * instead, which is the same trick in the other direction — a blue-grey wall
 * turns orange-brown where it was hit.
 *
 * Nothing maps to air, so the removal count `carveSphere` returns stays exactly
 * the number of voxels it deleted, and every target is well under a rocket's
 * blast strength (hellstone resists 3.3, rusted metal 3.7, against 9.6 at the
 * centre) so sustained fire on one wall keeps widening the hole.
 * ------------------------------------------------------------------------ */

/**
 * Target id per source id; 0 means "this material does not scorch".
 *
 * `BLAST_CHAR` lives in `shared/terrain.ts` because the generator chars the
 * pre-baked craters it ships with the identical table (see `applyBattleDamage`).
 * Two copies of this list is two answers to "what colour is a burnt wall", and
 * the whole point of shipping fought-over terrain is that a crater the level
 * came with and a crater you just cut are indistinguishable.
 *
 * Hellstone, obsidian, bedrock, glass, ice, leaves, slime, neon and the liquids
 * are all absent from it on purpose: already slag, blast-proof, or not a
 * surface anybody reads a crater off.
 */
const SCORCHED = BLAST_CHAR;

/** Fraction of eligible rim voxels that actually char. Ragged beats uniform. */
const SCORCH_CHANCE = 0.55;
/**
 * Hard ceiling on scorch marks per blast, and a share of the removal count so a
 * small blast leaves a small mark.
 *
 * Both exist for the wire, not for looks: `MAX_BLOCK_DELTAS_PER_MESSAGE` is 512
 * and a BFG already spends all of that on the hole itself. `scorchCrater` also
 * stops the moment the sink refuses a push, so a blast can never turn a full
 * delta buffer into a silent desync.
 */
const SCORCH_MAX = 72;
/**
 * One scorch mark per this many voxels removed.
 *
 * Was 4, which starved the shot that matters. A rocket into a wall removes
 * roughly 40 voxels and exposes a rim of 50-60, so a quarter-share bought about
 * ten charred blocks scattered over the whole crater — from across the arena
 * that is speckle, not a hole. At 2 the same rocket gets ~20 and the rim reads
 * as a burnt edge. The wire is not the constraint at this size:
 * `MAX_BLOCK_DELTAS_PER_MESSAGE` is 512 and rocket + scorch is ~60. SCORCH_MAX
 * still caps a BFG, whose own removal count is what eats the budget.
 */
const SCORCH_PER_REMOVED = 2;


/* ------------------------------------------------------------------------ *
 * Settled debris
 *
 * A crater with nothing lying in it is a hole somebody BUILT. The difference
 * between a doorway and a breach, read from ten metres in a single frame, is
 * almost entirely the pile at the bottom: broken material that came off the
 * wall and stopped where gravity left it. Particles cannot do this job — they
 * live for a second and then the level is tidy again — so a blast also converts
 * a scatter of the air it just opened into voxels of rubble.
 *
 * Three rules, and each one is load-bearing:
 *
 *  - Debris settles BELOW the detonation. The column scan starts one block
 *    under the blast centre, so rubble can never come to rest in the sightline
 *    the same rocket just cut. "A rocket opens a new sightline" is the piece's
 *    claim; a system that filled the hole back in would be arguing with it.
 *  - Debris never plugs a way through. A block that would sit in the two-block
 *    clear under a lintel is refused: that profile is a doorway, a keep
 *    clerestory or a bastion arch, and generated rubble across a route is a bug
 *    however good it looks.
 *  - Debris is budgeted like scorch, off the removal count and hard-capped, so
 *    a BFG cannot overflow `MAX_BLOCK_DELTAS_PER_MESSAGE`.
 * ------------------------------------------------------------------------ */

/** What each material breaks down into. 0 means "leaves nothing behind". */
const DEBRIS_OF = new Uint8Array(BLOCK_COUNT);
for (const id of [
  BlockId.STONE, BlockId.COBBLESTONE, BlockId.BRICK, BlockId.GRAVEL,
  BlockId.DIRT, BlockId.GRASS, BlockId.SAND, BlockId.SNOW, BlockId.OBSIDIAN,
]) DEBRIS_OF[id] = BlockId.GRAVEL;
DEBRIS_OF[BlockId.METAL] = BlockId.RUSTED_METAL;
DEBRIS_OF[BlockId.RUSTED_METAL] = BlockId.RUSTED_METAL;
DEBRIS_OF[BlockId.TECH_PANEL] = BlockId.RUSTED_METAL;
DEBRIS_OF[BlockId.HELLSTONE] = BlockId.HELLSTONE;
DEBRIS_OF[BlockId.BONE] = BlockId.BONE;
DEBRIS_OF[BlockId.WOOD] = BlockId.PLANKS;
DEBRIS_OF[BlockId.PLANKS] = BlockId.PLANKS;

/** Hard ceiling on rubble voxels per blast. */
const DEBRIS_MAX = 30;
/** One rubble voxel per this many removed. A rocket leaves a dozen or so. */
const DEBRIS_PER_REMOVED = 3;
/** How far past the crater lip debris is thrown. */
const DEBRIS_MARGIN = 1.2;
/** Share of eligible columns that catch a block, before the distance falloff. */
const DEBRIS_CHANCE = 0.72;

let lastDebris = 0;
/**
 * Rubble voxels the last `carveSphere` settled. The solid count after a blast
 * is `before - removed + blastDebrisCount()`, which is what the world tests
 * assert; nothing on the hot path reads it.
 */
export function blastDebrisCount(): number { return lastDebris; }

/**
 * True when a block dropped on the surface at `y` would seal a route: two
 * blocks of clear closed off by something solid above them.
 */
function plugsAWay(world: VoxelWorld, x: number, y: number, z: number): boolean {
  if (y + 3 >= CHUNK_HEIGHT) return false;
  return world.rawBlock(x, y + 2, z) === BlockId.AIR
    && BLOCK_OPAQUE[world.rawBlock(x, y + 3, z)] === 1;
}

/**
 * Drop rubble into and around a fresh crater. Returns how many voxels it set.
 *
 * Deterministic in (centre, radius, seed) and in the post-carve world, and it
 * reads the world through the same accessors the carve did, so the client's
 * predicted pile and the server's authoritative one are the same blocks.
 */
function settleDebris(
  world: VoxelWorld,
  cx: number, cy: number, cz: number,
  radius: number, removed: number, seed: number,
  sink?: BlockChangeSink,
): number {
  const budget = Math.min(DEBRIS_MAX, Math.floor(removed / DEBRIS_PER_REMOVED));
  if (budget <= 0) return 0;

  const rr = radius + DEBRIS_MARGIN;
  const rr2 = rr * rr;
  const x0 = Math.floor(cx - rr), x1 = Math.floor(cx + rr);
  const z0 = Math.floor(cz - rr), z1 = Math.floor(cz + rr);
  // One block under the detonation, down to one under the crater floor.
  const top = Math.min(CHUNK_HEIGHT - 2, Math.floor(cy) - 1);
  const bottom = Math.max(1, Math.floor(cy - radius) - 1);
  const dseed = seed ^ 0x2b13ad;

  let n = 0;
  for (let z = z0; z <= z1; z++) {
    const dz = z + 0.5 - cz;
    const dz2 = dz * dz;
    if (dz2 > rr2) continue;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const d2 = dx * dx + dz2;
      if (d2 > rr2) continue;
      // Thickest under the hole, thinning to nothing at the throw limit.
      const fall = 1 - Math.sqrt(d2) / rr;
      if (hash3f(x, 0, z, dseed) >= DEBRIS_CHANCE * fall) continue;

      for (let y = top; y >= bottom; y--) {
        const below = world.rawBlock(x, y, z);
        if (below === BlockId.AIR) continue;
        const kind = DEBRIS_OF[below];
        if (kind === 0) break;                       // liquid, glass, leaves, bedrock
        if (world.rawBlock(x, y + 1, z) !== BlockId.AIR) break;
        if (plugsAWay(world, x, y, z)) break;
        if (!world.setBlock(x, y + 1, z, kind)) break;
        n++;
        if (sink !== undefined && !sink.push(x, y + 1, z, kind)) return n;
        break;
      }
      if (n >= budget) return n;
    }
  }
  return n;
}

/**
 * Delete a sphere of voxels.
 *
 * A voxel at distance `d` is removed when
 *   `power * (1 - (d/radius)^2)  >  blastResist(hardness) * jitter(x,y,z,seed)`
 * so soft ground craters wide and hard structures barely chip. Unbreakable
 * blocks (bedrock) and liquids (hardness -1) are skipped, which also stops a
 * blast from draining a lava pool.
 *
 * Returns the number of voxels removed.
 *
 * BOUNDS, BEFORE ANY OF THIS. `radius` and the centre are loop bounds, and
 * `for (let x = x0; x <= x1; x++)` is a loop only while `x + 1` is a different
 * number from `x` — which above 2^53 it is not, because `-1e20 + 1 === -1e20`.
 * The y range was already clamped to the column and looked like the whole
 * answer; it was not, because x and z were clamped to nothing at all. A centre
 * of 1e20 in x, with a radius of ONE, gives x0 === x1 === 1e20 and spins the
 * innermost loop forever on the render thread. So all three ranges are pinned
 * to the extents `world.setBlock` already enforces, and the radius is pinned to
 * TERRAIN_CARVE_MAX_RADIUS — two separate fixes for two separate inputs, since
 * neither one alone catches the other. `server/src/world.ts` carries the same
 * pair; a bound that only one of the two carve implementations honours is not a
 * bound.
 *
 * `power` is not a loop bound but is refused on the same line, because a
 * non-finite one is worse than useless: `strength` becomes NaN, `NaN <= resist
 * * jitter` is FALSE, and the "this voxel survived the blast" branch never
 * runs — a NaN power carved 72 voxels where a real rocket takes 36, straight
 * through the obsidian that is supposed to keep an arena's skeleton standing.
 *
 * None of this can move an in-range carve. Everything the range clamps cut is
 * outside the loaded world, where `rawBlock` reads AIR and `setBlock` refuses
 * the write.
 */
export function carveSphere(
  world: VoxelWorld,
  cx: number, cy: number, cz: number,
  radius: number, power: number, seed: number,
  fx?: DestructionFx, sink?: BlockChangeSink,
): number {
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) return 0;
  if (!Number.isFinite(radius) || !Number.isFinite(power)) return 0;
  if (radius <= 0 || power <= 0) return 0;
  const r = radius > TERRAIN_CARVE_MAX_RADIUS ? TERRAIN_CARVE_MAX_RADIUS : radius;
  const r2 = r * r;
  const inv = 1 / r2;
  const x0 = Math.max(world.minBlockX, Math.floor(cx - r));
  const x1 = Math.min(world.maxBlockX, Math.floor(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(CHUNK_HEIGHT - 1, Math.floor(cy + r));
  const z0 = Math.max(world.minBlockZ, Math.floor(cz - r));
  const z1 = Math.min(world.maxBlockZ, Math.floor(cz + r));

  let removed = 0;
  let bursts = 0;
  let sample = 0;

  // One chunk resync per touched chunk instead of a mirror message per voxel.
  world.beginBatch();
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    const dy2 = dy * dy;
    for (let z = z0; z <= z1; z++) {
      const dz = z + 0.5 - cz;
      const dz2 = dz * dz;
      if (dy2 + dz2 > r2) continue;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const d2 = dx * dx + dy2 + dz2;
        if (d2 > r2) continue;

        const id = world.rawBlock(x, y, z);
        if (id === BlockId.AIR) continue;
        const hardness = BLOCK_HARDNESS[id];
        if (hardness < 0) continue;              // bedrock, water, lava

        const strength = power * (1 - d2 * inv);
        const jitter = CARVE_JITTER_MIN + CARVE_JITTER_SPAN * hash3f(x, y, z, seed);
        if (strength <= blastResist(hardness) * jitter) continue;

        if (!world.setBlock(x, y, z, BlockId.AIR)) continue;
        removed++;
        if (sink) sink.push(x, y, z, BlockId.AIR);

        if (fx?.debris !== undefined && bursts < MAX_DEBRIS_BURSTS) {
          // Sample every third voxel so a BFG crater does not spawn 900 bursts.
          if ((sample++ % 3) === 0) {
            fx.debris(x + 0.5, y + 0.5, z + 0.5, blockFaceColor(id, Face.PY), 5, 7.5);
            bursts++;
          }
        }
      }
    }
  }
  lastDebris = 0;
  if (removed > 0) {
    // The clamped radius, so the scorch ring and the debris throw stay the
    // crater's own size. Neither needs a bound of its own: both only run when
    // the carve removed something, which puts the centre within a radius of
    // the loaded world.
    scorchCrater(world, cx, cy, cz, r, removed, seed, sink);
    lastDebris = settleDebris(world, cx, cy, cz, r, removed, seed, sink);
  }
  world.endBatch();
  return removed;
}

/**
 * Char the surviving skin of a crater. Returns how many voxels changed.
 *
 * "Skin" is any solid voxel inside `radius + 1` with at least one air neighbour,
 * which after a carve is the crater wall plus the ring of ground the blast
 * washed over — both of which is what you want blackened. Iteration order is
 * fixed and the gate is a position hash, so the client's predicted scorch and
 * the server's authoritative one are the same voxels.
 */
function scorchCrater(
  world: VoxelWorld,
  cx: number, cy: number, cz: number,
  radius: number, removed: number, seed: number,
  sink?: BlockChangeSink,
): number {
  const rr = radius + 1;
  const r2 = rr * rr;
  const budget = Math.min(SCORCH_MAX, Math.floor(removed / SCORCH_PER_REMOVED));
  if (budget <= 0) return 0;

  const x0 = Math.floor(cx - rr), x1 = Math.floor(cx + rr);
  const y0 = Math.max(0, Math.floor(cy - rr)), y1 = Math.min(CHUNK_HEIGHT - 1, Math.floor(cy + rr));
  const z0 = Math.floor(cz - rr), z1 = Math.floor(cz + rr);
  const hseed = seed ^ 0x5c0acb;

  let n = 0;
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    const dy2 = dy * dy;
    for (let z = z0; z <= z1; z++) {
      const dz = z + 0.5 - cz;
      const dz2 = dz * dz;
      if (dy2 + dz2 > r2) continue;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        if (dx * dx + dy2 + dz2 > r2) continue;

        const id = world.rawBlock(x, y, z);
        const to = SCORCHED[id];
        if (to === 0) continue;
        if (hash3f(x, y, z, hseed) >= SCORCH_CHANCE) continue;
        if (!exposedToAir(world, x, y, z)) continue;
        if (!world.setBlock(x, y, z, to)) continue;
        n++;
        if (sink !== undefined && !sink.push(x, y, z, to)) return n;
        if (n >= budget) return n;
      }
    }
  }
  return n;
}

/** True when any of the six neighbours is air — i.e. the voxel is on a surface. */
function exposedToAir(world: VoxelWorld, x: number, y: number, z: number): boolean {
  return world.rawBlock(x + 1, y, z) === BlockId.AIR
    || world.rawBlock(x - 1, y, z) === BlockId.AIR
    || world.rawBlock(x, y + 1, z) === BlockId.AIR
    || world.rawBlock(x, y - 1, z) === BlockId.AIR
    || world.rawBlock(x, y, z + 1) === BlockId.AIR
    || world.rawBlock(x, y, z - 1) === BlockId.AIR;
}

/**
 * Weapon-driven explosion: carves using the firing weapon's `terrainDamage`
 * radius and fires the blast fx. Non-destructive weapons (`terrainDamage === 0`)
 * still get the light and shockwave, they just do not reshape the world.
 *
 * `seed` must be identical on both sides — derive it from the projectile id, or
 * from `hash3i(quantised position, tick)` for a hitscan blast.
 */
export function explode(
  world: VoxelWorld,
  x: number, y: number, z: number,
  weaponId: number, seed: number,
  fx?: DestructionFx, sink?: BlockChangeSink,
): number {
  const def = WEAPONS[weaponId];
  if (def === undefined) return 0;
  if (fx?.explosion) {
    fx.explosion(x, y, z, def.splashRadius > 0 ? def.splashRadius : 1, def.projectileColor);
  }
  if (def.terrainDamage <= 0) return 0;
  return carveSphere(
    world, x, y, z,
    def.terrainDamage, def.terrainDamage * TERRAIN_POWER_PER_BLOCK, seed,
    fx, sink,
  );
}

/**
 * Apply an authoritative BLOCK_DELTA batch from the server. Separate from
 * `breakBlock` / `placeBlock` because it must never re-emit deltas and never
 * re-run the placement rules — the server already decided.
 */
export function applyServerDeltas(
  world: VoxelWorld,
  count: number,
  xs: Int16Array, ys: Uint8Array, zs: Int16Array, ids: Uint8Array,
  fx?: DestructionFx,
): number {
  let changed = 0;
  const batch = count > 24;
  if (batch) world.beginBatch();
  for (let i = 0; i < count; i++) {
    const x = xs[i], y = ys[i], z = zs[i], id = ids[i];
    const prev = world.rawBlock(x, y, z);
    if (prev === id) continue;
    if (!world.setBlock(x, y, z, id)) continue;
    changed++;
    if (id === BlockId.AIR) {
      if (fx?.blockBroken) fx.blockBroken(x, y, z, prev, blockFaceColor(prev, Face.PY));
    } else if (fx?.blockPlaced) {
      fx.blockPlaced(x, y, z, id);
    }
  }
  if (batch) world.endBatch();
  return changed;
}
