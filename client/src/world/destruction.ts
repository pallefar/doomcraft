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
  CHUNK_HEIGHT, clamp01,
} from '@shared/constants';
import {
  BlockId, BLOCK_HARDNESS, BLOCK_SOLID, Face,
  isReplaceable, isPlaceable, isBreakable, blockBreakMs, blockFaceColor,
} from '@shared/blocks';
import { WEAPONS } from '@shared/weapons';
import { hash3f, type VoxelHit } from '@shared/math';
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
 */
export function carveSphere(
  world: VoxelWorld,
  cx: number, cy: number, cz: number,
  radius: number, power: number, seed: number,
  fx?: DestructionFx, sink?: BlockChangeSink,
): number {
  if (radius <= 0 || power <= 0) return 0;
  const r2 = radius * radius;
  const inv = 1 / r2;
  const x0 = Math.floor(cx - radius), x1 = Math.floor(cx + radius);
  const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(CHUNK_HEIGHT - 1, Math.floor(cy + radius));
  const z0 = Math.floor(cz - radius), z1 = Math.floor(cz + radius);

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
  world.endBatch();
  return removed;
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
