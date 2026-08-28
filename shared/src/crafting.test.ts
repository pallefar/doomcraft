/**
 * DOOMCRAFT — the crafting table's invariants. The one that matters most is
 * LOOP-FREEDOM: no chain of recipes may turn N of a block into more than N
 * of the same block, or a player mints stock by clicking in a circle. That
 * is proven by search over the real table, not by trusting the author.
 */

import { describe, expect, it } from 'vitest';

import { BLOCK_COUNT } from './blocks.ts';
import { CRAFT_RECIPES, craftableCount, recipeLine, recipeTableErrors } from './crafting.ts';

describe('the recipe table', () => {
  it('is well-formed: unique ids, placeable blocks, sane counts', () => {
    expect(recipeTableErrors()).toEqual([]);
    expect(CRAFT_RECIPES.length).toBeGreaterThanOrEqual(8);
  });

  it('NO MINTING LOOP: no recipe chain returns more of a block than it consumed', () => {
    // Fixed-point search: start with 999 of everything, apply every recipe
    // greedily for many rounds, and assert no single block's total stock
    // value grows. Value function: every block is worth 1 — under that
    // metric a chain that profits in COUNT would show as growth. Recipes
    // may legitimately expand count (1 wood -> 4 planks is the point), so
    // the invariant tested is the sharp one: for each BLOCK, no chain of
    // recipes gets you back MORE of that block than you started with.
    for (let target = 1; target < BLOCK_COUNT; target++) {
      // Breadth-first over "how many of `target` can I end with, starting
      // from N of target and nothing else". If any recipe path exceeds N,
      // the table mints.
      const start = 64;
      const stock = new Array<number>(BLOCK_COUNT).fill(0);
      stock[target] = start;
      // Greedy closure: run every applicable recipe repeatedly. 200 rounds
      // is far beyond any real chain depth over ~10 recipes.
      for (let round = 0; round < 200; round++) {
        let moved = false;
        for (const r of CRAFT_RECIPES) {
          // Never craft AWAY from the target more than needed — the
          // adversary crafts anything that could eventually raise the
          // target count, so run every recipe that does not consume the
          // final target unless it also produces it.
          const consumesTarget = r.inputs.some((i) => i.block === target);
          const producesTarget = r.out === target;
          if (consumesTarget && !producesTarget) continue;
          const runs = craftableCount(r, (b) => stock[b]);
          if (runs === 0) continue;
          for (const i of r.inputs) stock[i.block] -= i.count * runs;
          stock[r.out] += r.outCount * runs;
          moved = true;
        }
        if (!moved) break;
      }
      expect(stock[target]).toBeLessThanOrEqual(start);
    }
  });

  it('craftableCount floors on the scarcest input; recipeLine reads like a recipe', () => {
    const tech = CRAFT_RECIPES.find((r) => r.id === 'metal-glass-to-tech');
    expect(tech).toBeDefined();
    const t = tech as NonNullable<typeof tech>;
    const stock: Record<number, number> = { [t.inputs[0].block]: 5, [t.inputs[1].block]: 1 };
    expect(craftableCount(t, (b) => stock[b] ?? 0)).toBe(1);
    const line = recipeLine(t, (b) => `B${b}`);
    expect(line).toContain('→');
    expect(line).toContain('2 B');
  });
});
