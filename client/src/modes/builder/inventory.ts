/**
 * DOOMCRAFT — Builder inventory: the palette, the hotbar and the stacks.
 *
 * The bar is `ref/mcclassic/mc-07-picker.png`: press B and you get a panel
 * titled "Select block" holding roughly three dozen isometric cubes in a flat
 * eight-wide grid. No names. No search. No categories. No scroll. No keyboard.
 * Click a cube and it lands in the current hotbar slot. That is the whole
 * creative inventory of the game this mode is measured against, and it is a
 * twenty-year-old design that only works because the palette is small.
 *
 * What this does instead, all of it earned off that screenshot:
 *
 *   - **Categories** across the top, because a palette that grows past one
 *     screen with no grouping is a scavenger hunt. Ours are derived from the
 *     block table, not hand-listed, so a new `BlockId` cannot be orphaned.
 *   - **Search**, matching on name and on a small synonym list ("cobble",
 *     "wood", "hell"), because typing three letters beats reading 36 icons.
 *   - **Names under the icons**, and the hardness and the dig time in the
 *     tooltip. The bar shows a cube and nothing else, so "which grey is which"
 *     is guesswork.
 *   - **Keyboard**: arrows/Home/End move, Enter assigns, 1..9 pick the hotbar
 *     slot to assign into, Escape closes. The bar is mouse-only.
 *   - **Middle-click block pick** in the world, the one modern affordance the
 *     Classic build predates, plus a spare-slot policy so picking never
 *     silently overwrites a slot you were using.
 *   - **Stacks** for the survival-build variant. Creative reports `Infinity`
 *     and never decrements, which is the same code path with one flag.
 *
 * Icons are inline SVG isometric cubes drawn from `BLOCK_COLOR`, so there is no
 * image, no network request, no atlas and no layout shift, and they stay crisp
 * on a 3x display. Nothing here runs per frame — the whole module is
 * event-driven, and the hotbar only touches the DOM when a slot's contents or
 * the selection actually change.
 */

import {
  BLOCK_COUNT,
  BLOCK_HARDNESS,
  BlockId,
  blockBreakMs,
  blockName,
  isPlaceable,
  minimapColor,
} from '@shared/blocks';
import { BLOCK_BREAK_BASE_MS } from '@shared/constants';
import { CRAFT_RECIPES, craftableCount, recipeLine, type CraftRecipe } from '@shared/crafting';

/* ------------------------------------------------------------------------ *
 * Palette model
 * ------------------------------------------------------------------------ */

/** Hotbar slots. Nine, to match the bar exactly (`mc-02-world.png`). */
export const HOTBAR_SLOTS = 9;

/** Stack ceiling in the survival-build variant. Creative ignores it. */
export const STACK_MAX = 999;

/** Sentinel for "this slot is empty". */
export const EMPTY_SLOT = BlockId.AIR;

export enum BlockCategory {
  ALL = 0,
  NATURAL = 1,
  STONE = 2,
  WOOD = 3,
  INDUSTRIAL = 4,
  HELL = 5,
  LIGHT = 6,
}
export const CATEGORY_COUNT = 7;

export const CATEGORY_NAMES: readonly string[] = [
  'All', 'Natural', 'Stone', 'Wood', 'Industrial', 'Hell', 'Light',
];

/**
 * Category per block id. Every placeable block appears in exactly one bucket
 * besides ALL, and the table is exhaustive over `BlockId` so adding a block
 * without classifying it lands it in NATURAL rather than nowhere.
 */
const CATEGORY_OF = new Uint8Array(BLOCK_COUNT);
CATEGORY_OF.fill(BlockCategory.NATURAL);
CATEGORY_OF[BlockId.STONE] = BlockCategory.STONE;
CATEGORY_OF[BlockId.COBBLESTONE] = BlockCategory.STONE;
CATEGORY_OF[BlockId.BRICK] = BlockCategory.STONE;
CATEGORY_OF[BlockId.OBSIDIAN] = BlockCategory.STONE;
CATEGORY_OF[BlockId.GRAVEL] = BlockCategory.STONE;
CATEGORY_OF[BlockId.BONE] = BlockCategory.STONE;
CATEGORY_OF[BlockId.WOOD] = BlockCategory.WOOD;
CATEGORY_OF[BlockId.PLANKS] = BlockCategory.WOOD;
CATEGORY_OF[BlockId.LEAVES] = BlockCategory.WOOD;
CATEGORY_OF[BlockId.METAL] = BlockCategory.INDUSTRIAL;
CATEGORY_OF[BlockId.RUSTED_METAL] = BlockCategory.INDUSTRIAL;
CATEGORY_OF[BlockId.TECH_PANEL] = BlockCategory.INDUSTRIAL;
CATEGORY_OF[BlockId.HELLSTONE] = BlockCategory.HELL;
CATEGORY_OF[BlockId.SLIME] = BlockCategory.HELL;
CATEGORY_OF[BlockId.NEON] = BlockCategory.LIGHT;
CATEGORY_OF[BlockId.GLASS] = BlockCategory.LIGHT;
CATEGORY_OF[BlockId.ICE] = BlockCategory.LIGHT;

export function categoryOf(blockId: number): BlockCategory {
  return (CATEGORY_OF[blockId] ?? BlockCategory.NATURAL) as BlockCategory;
}

/** Extra words that should match a block in search. Lowercase, no punctuation. */
const SYNONYMS: Readonly<Record<number, string>> = {
  [BlockId.COBBLESTONE]: 'cobble rough',
  [BlockId.PLANKS]: 'plank wood board',
  [BlockId.WOOD]: 'log trunk timber',
  [BlockId.TECH_PANEL]: 'panel tech scifi computer',
  [BlockId.RUSTED_METAL]: 'rust iron corroded',
  [BlockId.HELLSTONE]: 'hell demon red infernal',
  [BlockId.NEON]: 'light lamp glow green',
  [BlockId.OBSIDIAN]: 'black volcanic hard blast',
  [BlockId.GRASS]: 'turf lawn green',
  [BlockId.DIRT]: 'earth soil mud',
  [BlockId.SAND]: 'beach desert',
  [BlockId.SNOW]: 'white winter',
  [BlockId.BONE]: 'skull ivory white',
  [BlockId.SLIME]: 'goo green bounce',
  [BlockId.GLASS]: 'window clear transparent',
  [BlockId.ICE]: 'frozen slippery',
  [BlockId.BRICK]: 'red masonry wall',
  [BlockId.METAL]: 'steel iron plate',
  [BlockId.LEAVES]: 'foliage bush tree',
  [BlockId.GRAVEL]: 'pebble stones',
};

/** One palette entry. Built once at module load. */
export interface PaletteEntry {
  readonly id: number;
  readonly name: string;
  readonly category: BlockCategory;
  readonly hardness: number;
  /** Milliseconds to dig with the builder tool. */
  readonly digMs: number;
  readonly color: number;
  /** Lowercased haystack: name plus synonyms. */
  readonly search: string;
}

function buildPalette(): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (let id = 1; id < BLOCK_COUNT; id++) {
    if (!isPlaceable(id)) continue;
    const name = blockName(id);
    const extra = SYNONYMS[id] ?? '';
    out.push({
      id,
      name,
      category: categoryOf(id),
      hardness: BLOCK_HARDNESS[id],
      digMs: blockBreakMs(id, 3.2, BLOCK_BREAK_BASE_MS),
      color: minimapColor(id),
      search: `${name.toLowerCase()} ${extra}`.trim(),
    });
  }
  // Cheapest first inside a category reads as "simplest material first", which
  // is the order a builder reaches for things in.
  out.sort((a, b) => (a.category - b.category) || (a.hardness - b.hardness) || (a.id - b.id));
  return out;
}

/** Every placeable block, grouped and ordered. Frozen at load. */
export const PALETTE: readonly PaletteEntry[] = Object.freeze(buildPalette());

/** Palette entry for a block id, or null when the block is not placeable. */
export function paletteEntry(id: number): PaletteEntry | null {
  for (const e of PALETTE) if (e.id === id) return e;
  return null;
}

/**
 * Match `query` against the palette. An empty query returns the whole category.
 * Matching is substring over name + synonyms, with an exact-prefix bonus so
 * typing "st" puts Stone above Cobblestone.
 */
export function searchPalette(query: string, category: BlockCategory, out: PaletteEntry[]): PaletteEntry[] {
  out.length = 0;
  const q = query.trim().toLowerCase();
  for (const e of PALETTE) {
    if (category !== BlockCategory.ALL && e.category !== category) continue;
    if (q.length > 0 && e.search.indexOf(q) < 0) continue;
    out.push(e);
  }
  if (q.length > 0) {
    out.sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return (ap - bp) || (a.category - b.category) || (a.hardness - b.hardness);
    });
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Hotbar + stacks
 * ------------------------------------------------------------------------ */

export interface InventoryStats {
  creative: boolean;
  selected: number;
  selectedBlock: number;
  distinctBlocks: number;
  totalItems: number;
}

/**
 * Nine slots and, in the survival-build variant, a count per block id.
 *
 * Creative is not a different class: `creative` short-circuits `take()` and
 * `count()` reports `Infinity`, so every caller writes the same code and the
 * two variants cannot drift apart.
 */
export class Inventory {
  /** BlockId per hotbar slot; `EMPTY_SLOT` for an empty one. */
  readonly slots = new Uint8Array(HOTBAR_SLOTS);
  /** Count per block id. Ignored while `creative`. */
  readonly stock = new Int32Array(BLOCK_COUNT);

  creative: boolean;
  private sel = 0;
  private version = 0;

  constructor(creative = true) {
    this.creative = creative;
    this.resetToDefaults();
  }

  /** Bumped on any change. The UI redraws only when this moves. */
  get revision(): number { return this.version; }
  get selected(): number { return this.sel; }
  get selectedBlock(): number { return this.slots[this.sel]; }

  /** A starting nine that spans the palette rather than the first nine ids. */
  resetToDefaults(): void {
    const defaults = [
      BlockId.STONE, BlockId.COBBLESTONE, BlockId.PLANKS, BlockId.BRICK,
      BlockId.TECH_PANEL, BlockId.METAL, BlockId.GLASS, BlockId.NEON, BlockId.GRASS,
    ];
    for (let i = 0; i < HOTBAR_SLOTS; i++) this.slots[i] = defaults[i] ?? EMPTY_SLOT;
    this.sel = 0;
    this.version++;
  }

  select(slot: number): void {
    const s = ((slot % HOTBAR_SLOTS) + HOTBAR_SLOTS) % HOTBAR_SLOTS;
    if (s === this.sel) return;
    this.sel = s;
    this.version++;
  }

  /** Wheel / bracket keys. `dir` is +1 or -1. */
  cycle(dir: number): void {
    this.select(this.sel + (dir > 0 ? 1 : -1));
  }

  /** Put `blockId` in `slot`. Refuses non-placeable ids. */
  assign(slot: number, blockId: number): boolean {
    if (slot < 0 || slot >= HOTBAR_SLOTS) return false;
    if (blockId !== EMPTY_SLOT && !isPlaceable(blockId)) return false;
    if (this.slots[slot] === blockId) return false;
    this.slots[slot] = blockId;
    this.version++;
    return true;
  }

  /** Assign into the selected slot — what clicking a palette cell does. */
  assignSelected(blockId: number): boolean {
    return this.assign(this.sel, blockId);
  }

  /**
   * Middle-click block pick. If the block is already on the bar, just select
   * that slot; otherwise drop it into the first empty slot, and only overwrite
   * the current slot when the bar is full. Overwriting a slot the player is
   * mid-build with is the annoying part of every other implementation.
   */
  pick(blockId: number): boolean {
    if (!isPlaceable(blockId)) return false;
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      if (this.slots[i] === blockId) { this.select(i); return true; }
    }
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      if (this.slots[i] === EMPTY_SLOT) {
        this.slots[i] = blockId;
        this.sel = i;
        this.version++;
        return true;
      }
    }
    this.slots[this.sel] = blockId;
    this.version++;
    return true;
  }

  /* --- stacks ---------------------------------------------------------- */

  /** Items of `blockId` held. `Infinity` in creative. */
  count(blockId: number): number {
    if (this.creative) return Infinity;
    if (blockId <= 0 || blockId >= BLOCK_COUNT) return 0;
    return this.stock[blockId];
  }

  /** True when a placement of `blockId` can be paid for. */
  has(blockId: number): boolean {
    return this.creative ? isPlaceable(blockId) : this.count(blockId) > 0;
  }

  /** Spend one. Returns false when the stack was empty. Always true in creative. */
  take(blockId: number): boolean {
    if (this.creative) return isPlaceable(blockId);
    if (blockId <= 0 || blockId >= BLOCK_COUNT) return false;
    if (this.stock[blockId] <= 0) return false;
    this.stock[blockId]--;
    this.version++;
    return true;
  }

  /** Refund on break, or a starting grant. Clamped to `STACK_MAX`. */
  give(blockId: number, n = 1): number {
    if (this.creative) return Infinity;
    if (blockId <= 0 || blockId >= BLOCK_COUNT || n <= 0) return 0;
    const next = Math.min(STACK_MAX, this.stock[blockId] + n);
    if (next === this.stock[blockId]) return next;
    this.stock[blockId] = next;
    this.version++;
    return next;
  }

  /**
   * Run one recipe against the stock: all inputs taken, the output given,
   * atomically — a recipe either fully applies or does nothing. False in
   * creative (infinite everything makes crafting meaningless, and the bench
   * does not render there) and false when any input is short. The STACK_MAX
   * clamp on the output can eat overflow exactly as `give` documents; the
   * craftable count the UI shows comes from the same `count()` this reads.
   */
  craft(recipe: CraftRecipe): boolean {
    if (this.creative) return false;
    for (const input of recipe.inputs) {
      if (this.count(input.block) < input.count) return false;
    }
    for (const input of recipe.inputs) this.stock[input.block] -= input.count;
    this.stock[recipe.out] = Math.min(STACK_MAX, this.stock[recipe.out] + recipe.outCount);
    this.version++;
    return true;
  }

  /** Survival-build opening hand: enough of the basics to start a structure. */
  grantStarterKit(): void {
    if (this.creative) return;
    this.give(BlockId.STONE, 128);
    this.give(BlockId.COBBLESTONE, 128);
    this.give(BlockId.PLANKS, 96);
    this.give(BlockId.GLASS, 32);
    this.give(BlockId.TECH_PANEL, 32);
  }

  setCreative(on: boolean): void {
    if (this.creative === on) return;
    this.creative = on;
    if (!on) this.grantStarterKit();
    this.version++;
  }

  stats(): InventoryStats {
    let distinct = 0;
    let total = 0;
    if (!this.creative) {
      for (let i = 1; i < BLOCK_COUNT; i++) {
        if (this.stock[i] > 0) { distinct++; total += this.stock[i]; }
      }
    } else {
      distinct = PALETTE.length;
      total = Infinity;
    }
    return {
      creative: this.creative,
      selected: this.sel,
      selectedBlock: this.selectedBlock,
      distinctBlocks: distinct,
      totalItems: total,
    };
  }

  /** Serialise the bar (not the stock) so a world remembers your layout. */
  toLayout(): number[] {
    return Array.from(this.slots);
  }

  fromLayout(layout: readonly number[] | null | undefined): void {
    if (!Array.isArray(layout)) return;
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const v = layout[i];
      this.slots[i] = typeof v === 'number' && (v === EMPTY_SLOT || isPlaceable(v)) ? v : this.slots[i];
    }
    this.version++;
  }
}

/* ------------------------------------------------------------------------ *
 * Isometric SVG cube icons
 * ------------------------------------------------------------------------ */

function shadeHex(hex: number, mul: number): string {
  const r = Math.min(255, Math.round(((hex >>> 16) & 0xff) * mul));
  const g = Math.min(255, Math.round(((hex >>> 8) & 0xff) * mul));
  const b = Math.min(255, Math.round((hex & 0xff) * mul));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/**
 * One isometric cube as an inline SVG string. `size` is the viewBox edge.
 *
 * Three faces at 1.0 / 0.68 / 0.46 of the block's map colour — the same ramp
 * `FACE_SHADE` uses in the mesher, so an icon reads as the same material the
 * world draws.
 */
export function blockIconSvg(blockId: number, size = 34): string {
  const c = minimapColor(blockId);
  const cx = size / 2;
  const l = size * 0.08;
  const r = size - l;
  const yTop = size * 0.13;
  const yMid = size * 0.35;
  const dh = yMid - yTop;             // half-height of the top diamond
  const yDia = yMid + dh;             // south point of the diamond
  const sideH = size * 0.87 - yDia;   // how far the side faces drop
  const poly = (pts: string, mul: number): string =>
    `<polygon points="${pts}" fill="${shadeHex(c, mul)}"/>`;
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true" focusable="false">`
    + poly(`${l},${yMid} ${cx},${yDia} ${cx},${yDia + sideH} ${l},${yMid + sideH}`, 0.66)
    + poly(`${r},${yMid} ${cx},${yDia} ${cx},${yDia + sideH} ${r},${yMid + sideH}`, 0.46)
    + poly(`${cx},${yTop} ${r},${yMid} ${cx},${yDia} ${l},${yMid}`, 1)
    + `</svg>`;
}

/* ------------------------------------------------------------------------ *
 * The DOM
 * ------------------------------------------------------------------------ */

const STYLE_ID = 'dc-builder-inv-css';
let styleUsers = 0;

const CSS = `
.dcb-bar{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);
  display:flex;gap:4px;pointer-events:none;
  font:12px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.dcb-cell{position:relative;width:52px;height:52px;border-radius:4px;
  border:1px solid rgba(255,255,255,.16);background:rgba(8,8,11,.78);
  display:flex;align-items:center;justify-content:center}
.dcb-cell .k{position:absolute;left:4px;top:2px;font-size:9px;color:#7d7873}
.dcb-cell .q{position:absolute;right:3px;bottom:1px;font-size:10px;color:#e8e6e3;
  text-shadow:0 1px 2px #000}
.dcb-cell.on{border-color:#f0a020;background:rgba(48,28,10,.9);
  box-shadow:0 0 0 1px rgba(240,160,32,.5),0 0 12px rgba(240,160,32,.25)}
/* Out of stock dims the CONTENTS, never the cell. Fading the whole cell also faded the orange
   selection ring, so the survival hotbar's selected-but-empty slot read as neither selected nor
   empty — just muddy. The count goes red instead, because "0" in the same grey as "128" is the
   one number in this bar that needs to stop you. */
.dcb-cell.out svg{opacity:.3}
.dcb-cell.out .q{color:#ff9a86}
.dcb-cell svg{display:block}
.dcb-name{position:absolute;left:50%;bottom:74px;transform:translateX(-50%);
  padding:3px 10px;border-radius:3px;background:rgba(8,8,11,.8);color:#e8e6e3;
  font:12px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
  white-space:nowrap;opacity:0;transition:opacity 140ms linear;pointer-events:none}
.dcb-name.on{opacity:1}

.dcb-pick{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  background:rgba(4,4,6,.62);z-index:40;
  font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#e8e6e3}
.dcb-pick *{box-sizing:border-box}
.dcb-panel{width:min(760px,94vw);max-height:min(78vh,660px);display:flex;flex-direction:column;
  background:rgba(12,12,16,.96);border:1px solid rgba(255,255,255,.14);border-radius:8px;
  box-shadow:0 24px 60px rgba(0,0,0,.6)}
.dcb-hd{display:flex;align-items:center;gap:10px;padding:12px 14px;
  border-bottom:1px solid rgba(255,255,255,.1)}
.dcb-hd h2{margin:0;font-size:15px;font-weight:650;letter-spacing:.02em}
.dcb-hd .sp{flex:1}
.dcb-search{flex:0 0 240px;min-width:120px;height:36px;padding:0 10px;border-radius:4px;
  border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.4);color:#e8e6e3;font:13px/1 inherit}
.dcb-search:focus{outline:2px solid #f0a020;outline-offset:0}
.dcb-close{width:36px;height:36px;border-radius:4px;border:1px solid rgba(255,255,255,.16);
  background:rgba(0,0,0,.3);color:#e8e6e3;font-size:16px;cursor:pointer}
.dcb-cats{display:flex;flex-wrap:wrap;gap:6px;padding:10px 14px;
  border-bottom:1px solid rgba(255,255,255,.08)}
.dcb-cat{min-height:32px;padding:6px 12px;border-radius:16px;cursor:pointer;
  border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.03);color:#b8b3ae;
  font:12px/1.2 inherit}
.dcb-cat.on{background:#f0a020;border-color:#f0a020;color:#140d04;font-weight:640}
.dcb-grid{flex:1;overflow-y:auto;display:grid;gap:8px;padding:14px;
  grid-template-columns:repeat(auto-fill,minmax(88px,1fr))}
.dcb-item{min-height:88px;padding:8px 4px 6px;border-radius:5px;cursor:pointer;
  border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);color:#d8d4d0;
  display:flex;flex-direction:column;align-items:center;gap:4px;font:11px/1.25 inherit;text-align:center}
.dcb-item:hover,.dcb-item:focus-visible{border-color:rgba(240,160,32,.7);background:rgba(240,160,32,.1);outline:none}
.dcb-item.on{border-color:#f0a020;background:rgba(240,160,32,.16)}
.dcb-item .nm{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcb-item .hd{display:block;color:#8a857f;font-size:10px}
.dcb-empty{grid-column:1/-1;padding:26px 0;text-align:center;color:#8a857f}
.dcb-ft{display:flex;align-items:center;gap:10px;padding:10px 14px;color:#8a857f;font-size:11px;
  border-top:1px solid rgba(255,255,255,.08)}
.dcb-ft b{color:#d8d4d0;font-weight:600}
@media (max-width:520px){
  .dcb-cell{width:40px;height:40px}
  .dcb-grid{grid-template-columns:repeat(auto-fill,minmax(72px,1fr))}
}
/* Short viewport — a landscape phone at 915x412, the one shape the bar itself refuses.
   At the desktop metrics the header, the category row and the footer ate 250 of those 412 px and
   left one and a half rows of blocks showing: a palette you scroll past its own chrome. Trim the
   padding, raise the panel's share of the height from 78vh to 94vh, and three rows fit. Nothing
   drops below a 32 px hit box — 44 px chips would put us back where we started. */
@media (max-height:560px){
  .dcb-panel{max-height:94vh}
  .dcb-hd{padding:7px 12px;gap:8px}
  .dcb-hd h2{font-size:13px}
  .dcb-search{height:32px;flex-basis:200px}
  .dcb-close{width:32px;height:32px}
  .dcb-cats{padding:6px 12px;gap:5px}
  .dcb-cat{min-height:32px;padding:5px 10px}
  .dcb-grid{padding:8px;gap:6px;grid-template-columns:repeat(auto-fill,minmax(78px,1fr))}
  .dcb-item{min-height:76px;padding:6px 3px 4px}
  .dcb-ft{padding:6px 12px;font-size:10px}
}
`;

function ensureStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID) === null) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  styleUsers++;
}
function releaseStyle(): void {
  styleUsers--;
  if (styleUsers > 0 || typeof document === 'undefined') return;
  document.getElementById(STYLE_ID)?.remove();
}

/* ------------------------------------------------------------------------ *
 * Hotbar view
 * ------------------------------------------------------------------------ */

/**
 * The nine cells at the bottom of the screen, plus the transient block-name
 * label above them.
 *
 * Redraw is version-gated: `sync()` early-returns unless the inventory's
 * revision changed, so having it on the frame path costs one integer compare.
 */
export class HotbarView {
  readonly element: HTMLDivElement;
  private readonly label: HTMLDivElement;
  private readonly cells: HTMLDivElement[] = [];
  private readonly qty: HTMLSpanElement[] = [];
  private drawnRevision = -1;
  private labelUntilMs = 0;

  constructor(parent: HTMLElement) {
    ensureStyle();
    this.element = document.createElement('div');
    this.element.className = 'dcb-bar';
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const cell = document.createElement('div');
      cell.className = 'dcb-cell';
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = String(i + 1);
      const q = document.createElement('span');
      q.className = 'q';
      cell.appendChild(k);
      cell.appendChild(q);
      this.element.appendChild(cell);
      this.cells.push(cell);
      this.qty.push(q);
    }
    this.label = document.createElement('div');
    this.label.className = 'dcb-name';
    parent.appendChild(this.label);
    parent.appendChild(this.element);
  }

  /** Redraw if anything changed. `nowMs` only drives the label fade. */
  sync(inv: Inventory, nowMs: number): void {
    if (inv.revision !== this.drawnRevision) {
      this.drawnRevision = inv.revision;
      this.redraw(inv);
      this.showLabel(inv, nowMs);
    }
    if (this.labelUntilMs !== 0 && nowMs > this.labelUntilMs) {
      this.labelUntilMs = 0;
      this.label.classList.remove('on');
    }
  }

  private redraw(inv: Inventory): void {
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const cell = this.cells[i];
      const id = inv.slots[i];
      cell.classList.toggle('on', i === inv.selected);
      const stock = inv.count(id);
      cell.classList.toggle('out', id !== EMPTY_SLOT && stock <= 0);
      const icon = cell.querySelector('svg');
      if (id === EMPTY_SLOT) {
        icon?.remove();
        this.qty[i].textContent = '';
        cell.title = 'Empty';
        continue;
      }
      const want = String(id);
      if (icon === null || cell.dataset.block !== want) {
        icon?.remove();
        cell.insertAdjacentHTML('beforeend', blockIconSvg(id, 34));
        cell.dataset.block = want;
      }
      this.qty[i].textContent = inv.creative ? '' : String(stock);
      cell.title = blockName(id);
    }
  }

  private showLabel(inv: Inventory, nowMs: number): void {
    const id = inv.selectedBlock;
    if (id === EMPTY_SLOT) {
      this.label.classList.remove('on');
      this.labelUntilMs = 0;
      return;
    }
    const e = paletteEntry(id);
    const hardness = e === null ? 0 : e.hardness;
    this.label.textContent = inv.creative
      ? `${blockName(id)}  ·  hardness ${hardness.toFixed(1)}`
      : `${blockName(id)}  ·  ${inv.count(id)} left`;
    this.label.classList.add('on');
    this.labelUntilMs = nowMs + 1600;
  }

  dispose(): void {
    this.element.remove();
    this.label.remove();
    releaseStyle();
  }
}

/* ------------------------------------------------------------------------ *
 * The palette picker
 * ------------------------------------------------------------------------ */

export interface BlockPickerOptions {
  root: HTMLElement;
  inventory: Inventory;
  /** Called after a block is assigned to a slot. */
  onAssign?(slot: number, blockId: number): void;
  /** Called after a recipe ran — the feed line and the save both hang here. */
  onCraft?(recipe: CraftRecipe): void;
  onClose?(): void;
}

/**
 * The "Select block" panel, rebuilt from the bar's screenshot and then given
 * the four things the bar does not have: categories, search, names and a
 * keyboard.
 */
export class BlockPicker {
  readonly element: HTMLDivElement;
  private readonly grid: HTMLDivElement;
  private readonly search: HTMLInputElement;
  private readonly footer: HTMLDivElement;
  private readonly catButtons: HTMLButtonElement[] = [];
  private readonly inv: Inventory;
  private readonly opts: BlockPickerOptions;
  private readonly filtered: PaletteEntry[] = [];
  private category: BlockCategory = BlockCategory.ALL;
  private cursor = 0;
  private open = false;
  /** True while the grid shows the survival crafting bench, not blocks. */
  private craftMode = false;
  private craftButton: HTMLButtonElement | null = null;
  private readonly onKey: (e: KeyboardEvent) => void;

  constructor(options: BlockPickerOptions) {
    ensureStyle();
    this.opts = options;
    this.inv = options.inventory;

    this.element = document.createElement('div');
    this.element.className = 'dcb-pick';
    this.element.style.display = 'none';

    const panel = document.createElement('div');
    panel.className = 'dcb-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Select block');

    const hd = document.createElement('div');
    hd.className = 'dcb-hd';
    const h2 = document.createElement('h2');
    h2.textContent = 'Select block';
    const sp = document.createElement('div');
    sp.className = 'sp';
    this.search = document.createElement('input');
    this.search.className = 'dcb-search';
    this.search.type = 'search';
    this.search.placeholder = 'Search blocks…';
    this.search.setAttribute('aria-label', 'Search blocks');
    const close = document.createElement('button');
    close.className = 'dcb-close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    hd.append(h2, sp, this.search, close);

    const cats = document.createElement('div');
    cats.className = 'dcb-cats';
    for (let c = 0; c < CATEGORY_COUNT; c++) {
      const b = document.createElement('button');
      b.className = 'dcb-cat';
      b.type = 'button';
      b.textContent = CATEGORY_NAMES[c];
      b.addEventListener('click', () => { this.setCategory(c as BlockCategory); });
      cats.appendChild(b);
      this.catButtons.push(b);
    }
    /* The crafting bench rides the palette's own chrome: one more chip that
     * swaps the grid for the recipe table. Survival only — creative has
     * infinite everything, so `refresh()` hides the chip there. */
    const craftBtn = document.createElement('button');
    craftBtn.className = 'dcb-cat dcb-craft';
    craftBtn.type = 'button';
    craftBtn.textContent = 'Craft';
    craftBtn.addEventListener('click', () => { this.showCraft(); });
    cats.appendChild(craftBtn);
    this.craftButton = craftBtn;

    this.grid = document.createElement('div');
    this.grid.className = 'dcb-grid';
    this.grid.setAttribute('role', 'listbox');

    this.footer = document.createElement('div');
    this.footer.className = 'dcb-ft';

    panel.append(hd, cats, this.grid, this.footer);
    this.element.appendChild(panel);
    options.root.appendChild(this.element);

    close.addEventListener('click', () => this.close());
    this.element.addEventListener('mousedown', (e) => {
      if (e.target === this.element) this.close();
    });
    this.search.addEventListener('input', () => { this.cursor = 0; this.refresh(); });

    this.onKey = (e: KeyboardEvent): void => this.handleKey(e);
    this.element.addEventListener('keydown', this.onKey);

    this.setCategory(BlockCategory.ALL);
  }

  get isOpen(): boolean { return this.open; }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.element.style.display = 'flex';
    this.refresh();
    this.search.focus();
    this.search.select();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.element.style.display = 'none';
    this.opts.onClose?.();
  }

  toggle(): void { if (this.open) this.close(); else this.show(); }

  setCategory(c: BlockCategory): void {
    this.category = c;
    this.craftMode = false;
    this.cursor = 0;
    for (let i = 0; i < this.catButtons.length; i++) this.catButtons[i].classList.toggle('on', i === c);
    this.craftButton?.classList.remove('on');
    this.refresh();
  }

  /** Swap the grid for the survival crafting bench. */
  showCraft(): void {
    if (this.inv.creative) return;
    this.craftMode = true;
    this.cursor = 0;
    for (const b of this.catButtons) b.classList.remove('on');
    this.craftButton?.classList.add('on');
    this.refresh();
  }

  /** Rebuild the grid. Cold path: only on open, search, category or assignment. */
  refresh(): void {
    if (!this.open) return;
    if (this.craftButton !== null) {
      this.craftButton.style.display = this.inv.creative ? 'none' : '';
      if (this.inv.creative && this.craftMode) { this.craftMode = false; }
    }
    if (this.craftMode) { this.refreshCraft(); return; }
    searchPalette(this.search.value, this.category, this.filtered);
    this.grid.textContent = '';
    if (this.filtered.length === 0) {
      const none = document.createElement('div');
      none.className = 'dcb-empty';
      none.textContent = `No block matches “${this.search.value.trim()}”`;
      this.grid.appendChild(none);
    } else {
      const held = this.inv.selectedBlock;
      for (let i = 0; i < this.filtered.length; i++) {
        const e = this.filtered[i];
        const cell = document.createElement('button');
        cell.className = 'dcb-item';
        cell.type = 'button';
        cell.setAttribute('role', 'option');
        cell.setAttribute('aria-selected', e.id === held ? 'true' : 'false');
        cell.classList.toggle('on', i === this.cursor);
        cell.title = `${e.name} — hardness ${e.hardness.toFixed(1)}, ${Math.round(e.digMs)} ms to dig`;
        cell.insertAdjacentHTML('beforeend', blockIconSvg(e.id, 40));
        const nm = document.createElement('span');
        nm.className = 'nm';
        nm.textContent = e.name;
        const hd = document.createElement('span');
        hd.className = 'hd';
        hd.textContent = this.inv.creative
          ? `${e.hardness.toFixed(1)}`
          : `${this.inv.count(e.id)}`;
        cell.append(nm, hd);
        cell.addEventListener('click', () => { this.cursor = i; this.assign(e.id); });
        this.grid.appendChild(cell);
      }
    }
    this.footer.innerHTML = '';
    const slot = document.createElement('span');
    slot.innerHTML = `Assigning to slot <b>${this.inv.selected + 1}</b> — press <b>1</b>–<b>9</b> to change`;
    const hint = document.createElement('span');
    hint.style.marginLeft = 'auto';
    hint.innerHTML = `<b>${this.filtered.length}</b> of ${PALETTE.length} blocks · <b>Enter</b> assign · <b>Esc</b> close`;
    this.footer.append(slot, hint);
  }

  /** The bench: one card per recipe, output icon, the line, and how many run. */
  private refreshCraft(): void {
    this.grid.textContent = '';
    const stockOf = (b: number): number => this.inv.count(b);
    for (let i = 0; i < CRAFT_RECIPES.length; i++) {
      const recipe = CRAFT_RECIPES[i];
      const runs = craftableCount(recipe, stockOf);
      const cell = document.createElement('button');
      cell.className = 'dcb-item';
      cell.type = 'button';
      cell.setAttribute('role', 'option');
      cell.classList.toggle('on', i === this.cursor);
      if (runs === 0) cell.classList.add('out');
      cell.title = recipeLine(recipe, blockName);
      cell.insertAdjacentHTML('beforeend', blockIconSvg(recipe.out, 40));
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = `${recipe.outCount}× ${blockName(recipe.out)}`;
      const hd = document.createElement('span');
      hd.className = 'hd';
      hd.textContent = recipe.inputs.map((inp) => `${inp.count} ${blockName(inp.block)}`).join(' + ');
      const ct = document.createElement('span');
      ct.className = 'hd';
      ct.textContent = runs === 0 ? 'missing materials' : `craft up to ${runs}`;
      cell.append(nm, hd, ct);
      cell.addEventListener('click', () => { this.cursor = i; this.craft(recipe); });
      this.grid.appendChild(cell);
    }
    this.footer.innerHTML = '';
    const hint = document.createElement('span');
    hint.innerHTML = 'Mined blocks are your materials — <b>click</b> a recipe to craft it once · <b>Esc</b> close';
    this.footer.append(hint);
  }

  private craft(recipe: CraftRecipe): void {
    if (this.inv.craft(recipe)) this.opts.onCraft?.(recipe);
    this.refresh();
  }

  private assign(blockId: number): void {
    const slot = this.inv.selected;
    this.inv.assign(slot, blockId);
    this.opts.onAssign?.(slot, blockId);
    this.refresh();
  }

  private moveCursor(delta: number): void {
    const n = this.craftMode ? CRAFT_RECIPES.length : this.filtered.length;
    if (n === 0) return;
    this.cursor = ((this.cursor + delta) % n + n) % n;
    const cells = this.grid.querySelectorAll('.dcb-item');
    for (let i = 0; i < cells.length; i++) cells[i].classList.toggle('on', i === this.cursor);
    (cells[this.cursor] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }

  /** Columns actually laid out, so Up/Down move a visual row and not a guess. */
  private columns(): number {
    const first = this.grid.querySelector('.dcb-item') as HTMLElement | null;
    if (first === null) return 1;
    const w = first.getBoundingClientRect().width;
    if (w <= 0) return 1;
    return Math.max(1, Math.round(this.grid.clientWidth / (w + 8)));
  }

  private handleKey(e: KeyboardEvent): void {
    if (!this.open) return;
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (this.craftMode) {
        const recipe = CRAFT_RECIPES[this.cursor];
        if (recipe !== undefined) this.craft(recipe);
        return;
      }
      const pick = this.filtered[this.cursor];
      if (pick !== undefined) this.assign(pick.id);
      return;
    }
    if (e.key >= '1' && e.key <= '9' && !e.shiftKey && (e.target !== this.search || this.search.value === '')) {
      e.preventDefault();
      this.inv.select(Number(e.key) - 1);
      this.refresh();
      return;
    }
    const cols = this.columns();
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); this.moveCursor(1); break;
      case 'ArrowLeft': e.preventDefault(); this.moveCursor(-1); break;
      case 'ArrowDown': e.preventDefault(); this.moveCursor(cols); break;
      case 'ArrowUp': e.preventDefault(); this.moveCursor(-cols); break;
      case 'Home': e.preventDefault(); this.cursor = 0; this.moveCursor(0); break;
      case 'End': e.preventDefault(); this.cursor = this.filtered.length - 1; this.moveCursor(0); break;
      default: break;
    }
  }

  dispose(): void {
    this.element.removeEventListener('keydown', this.onKey);
    this.element.remove();
    releaseStyle();
  }
}
