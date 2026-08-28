/**
 * DOOMCRAFT — block crafting: new materials from mined ones, the Minecraft
 * loop, as DATA (docs/PACKS.md Rule A: a recipe is numbers over the block
 * table the build already ships, not code).
 *
 * Recipes are one-way refinements — raw stock in, built material out — and
 * the table is kept loop-free ON PURPOSE: no pair of recipes may turn N of
 * a block into more than N of the same block round-trip, or a player mints
 * stock by clicking in a circle. `crafting.test.ts` proves that property
 * over every recipe pair rather than trusting the author's arithmetic.
 *
 * Consumed by the Builder SURVIVAL bench (`client/src/modes/builder`),
 * where the stock ledger already exists: mining gives the block
 * (`inventory.give` on break), crafting refines it. Creative has infinite
 * everything, so the bench simply does not show there.
 */

import { BLOCK_FLAGS, BF_PLACEABLE, BlockId } from './blocks.ts';

export interface CraftInput {
  readonly block: BlockId;
  readonly count: number;
}

export interface CraftRecipe {
  /** Slug, unique across the table — UI keys and tests hang on it. */
  readonly id: string;
  readonly out: BlockId;
  readonly outCount: number;
  readonly inputs: readonly CraftInput[];
}

function r(id: string, out: BlockId, outCount: number, ...inputs: [BlockId, number][]): CraftRecipe {
  return Object.freeze({
    id, out, outCount,
    inputs: Object.freeze(inputs.map(([block, count]) => Object.freeze({ block, count }))),
  });
}

export const CRAFT_RECIPES: readonly CraftRecipe[] = Object.freeze([
  r('wood-to-planks', BlockId.PLANKS, 4, [BlockId.WOOD, 1]),
  r('gravel-to-cobble', BlockId.COBBLESTONE, 2, [BlockId.GRAVEL, 4]),
  r('cobble-to-stone', BlockId.STONE, 1, [BlockId.COBBLESTONE, 2]),
  r('stone-to-brick', BlockId.BRICK, 4, [BlockId.STONE, 4]),
  r('sand-to-glass', BlockId.GLASS, 4, [BlockId.SAND, 4]),
  r('rusted-to-metal', BlockId.METAL, 1, [BlockId.RUSTED_METAL, 2]),
  r('metal-glass-to-tech', BlockId.TECH_PANEL, 2, [BlockId.METAL, 2], [BlockId.GLASS, 1]),
  r('snow-to-ice', BlockId.ICE, 1, [BlockId.SNOW, 2]),
  r('bone-stone-to-hellstone', BlockId.HELLSTONE, 2, [BlockId.BONE, 4], [BlockId.STONE, 4]),
  r('glass-slime-to-neon', BlockId.NEON, 2, [BlockId.GLASS, 2], [BlockId.SLIME, 1]),
]);

/** How many times `recipe` can run against the given stock. */
export function craftableCount(
  recipe: CraftRecipe,
  stockOf: (block: number) => number,
): number {
  let times = Number.POSITIVE_INFINITY;
  for (const input of recipe.inputs) {
    times = Math.min(times, Math.floor(stockOf(input.block) / input.count));
  }
  return Number.isFinite(times) ? Math.max(0, times) : 0;
}

/** `4 Gravel → 2 Cobblestone`, built from a names table the caller owns. */
export function recipeLine(recipe: CraftRecipe, nameOf: (block: number) => string): string {
  const ins = recipe.inputs.map((i) => `${i.count} ${nameOf(i.block)}`).join(' + ');
  return `${ins} → ${recipe.outCount} ${nameOf(recipe.out)}`;
}

/** Every block a recipe touches must be real and placeable, or the table lies. */
export function recipeTableErrors(): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const recipe of CRAFT_RECIPES) {
    if (seen.has(recipe.id)) errors.push(`duplicate recipe id "${recipe.id}"`);
    seen.add(recipe.id);
    if (recipe.outCount < 1 || recipe.outCount > 64) errors.push(`${recipe.id}: output count out of range`);
    if (recipe.inputs.length === 0) errors.push(`${recipe.id}: no inputs`);
    const blocks = [recipe.out, ...recipe.inputs.map((i) => i.block)];
    for (const b of blocks) {
      if ((BLOCK_FLAGS[b] & BF_PLACEABLE) === 0) errors.push(`${recipe.id}: block ${b} is not placeable`);
    }
    for (const i of recipe.inputs) {
      if (i.count < 1 || i.count > 64) errors.push(`${recipe.id}: input count out of range`);
      if (i.block === recipe.out) errors.push(`${recipe.id}: output is its own input`);
    }
  }
  return errors;
}
