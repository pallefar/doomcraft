/**
 * DOOMCRAFT — the survival bench over the real Inventory: a recipe either
 * fully applies or does nothing, creative refuses (infinite everything
 * makes crafting meaningless), and the mined-block loop actually closes —
 * give() what breaking grants, craft() what the table says, place from the
 * crafted stack.
 */

import { describe, expect, it } from 'vitest';

import { BlockId } from '@shared/blocks';
import { CRAFT_RECIPES, craftableCount } from '@shared/crafting';

import { Inventory, STACK_MAX } from '@/modes/builder/inventory';

const PLANKS = CRAFT_RECIPES.find((r) => r.id === 'wood-to-planks')!;
const TECH = CRAFT_RECIPES.find((r) => r.id === 'metal-glass-to-tech')!;

describe('Inventory.craft', () => {
  it('closes the mine → craft → place loop', () => {
    const inv = new Inventory(false);
    // Mining a wood block is `give(WOOD, 1)` — the hook at builder.ts.
    inv.give(BlockId.WOOD, 1);
    const planksBefore = inv.count(BlockId.PLANKS);
    expect(inv.craft(PLANKS)).toBe(true);
    expect(inv.count(BlockId.WOOD)).toBe(0);
    expect(inv.count(BlockId.PLANKS)).toBe(planksBefore + 4);
    // The crafted stack pays for a placement like any mined one.
    expect(inv.take(BlockId.PLANKS)).toBe(true);
  });

  it('is atomic: a short input leaves every stack untouched', () => {
    const inv = new Inventory(false);
    inv.stock.fill(0);
    inv.give(BlockId.METAL, 2);            // glass missing
    const rev = inv.revision;
    expect(inv.craft(TECH)).toBe(false);
    expect(inv.count(BlockId.METAL)).toBe(2);
    expect(inv.count(BlockId.TECH_PANEL)).toBe(0);
    expect(inv.revision).toBe(rev);
  });

  it('multi-input recipes consume every input; the output clamps at STACK_MAX', () => {
    const inv = new Inventory(false);
    inv.stock.fill(0);
    inv.give(BlockId.METAL, 2);
    inv.give(BlockId.GLASS, 1);
    expect(inv.craft(TECH)).toBe(true);
    expect(inv.count(BlockId.METAL)).toBe(0);
    expect(inv.count(BlockId.GLASS)).toBe(0);
    expect(inv.count(BlockId.TECH_PANEL)).toBe(2);

    inv.give(BlockId.PLANKS, STACK_MAX);
    inv.give(BlockId.WOOD, 1);
    expect(inv.craft(PLANKS)).toBe(true);
    expect(inv.count(BlockId.PLANKS)).toBe(STACK_MAX);
  });

  it('creative refuses — the bench does not exist where everything is infinite', () => {
    const inv = new Inventory(true);
    expect(inv.craft(PLANKS)).toBe(false);
    // Infinite stock answers 0 runs, not NaN/Infinity — nothing to render.
    expect(craftableCount(PLANKS, (b) => inv.count(b))).toBe(0);
  });
});
