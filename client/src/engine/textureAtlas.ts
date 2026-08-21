/**
 * DOOMCRAFT — procedural surface atlas.
 *
 * ref/BAR.md line 58: "blocks **are textured**, not flat-coloured — close up
 * stone shows a clear running-bond brick pattern, grass a fine speckle, sand a
 * dither." That was the single biggest art loss we still carried: three stone
 * blocks a metre from the camera rendered as one uniform grey quad because the
 * whole surface term was `vColor * uTint * lit`.
 *
 * What this module is, and just as importantly what it is NOT:
 *
 *  - It is a 4 x 4 atlas of 128 x 128 GREYSCALE DETAIL tiles, generated into a
 *    typed array at boot. No asset files, no fetch, no canvas, no DOM — so it
 *    works identically in a worker, a test and the browser, and it adds zero
 *    bytes to the bundle payload.
 *  - The tiles are a signed DEVIATION around a neutral 0.5. The shader reads
 *    `m = (tile - 0.5) * 2` and applies it twice — once as a percentage of the
 *    albedo and once as an absolute offset — so the authored block palette in
 *    shared/src/blocks.ts survives untouched and the grade, AO, fog and dynamic
 *    lights all keep working on top. Zero-mean also makes mip bleeding between
 *    tiles harmless: every tile averages to 0.5.
 *  - It is NOT a geometry change. Nothing here touches the 12-byte vertex
 *    format, the mesher or the chunk buffers (docs/CONTRACT.md), and it costs
 *    exactly zero extra draw calls.
 *
 * How the shader knows which tile a face wants, without a new vertex attribute:
 * the mesher already writes the UNSHADED `BLOCK_FACE_COLOR` into `aColor`, and
 * that colour is a unique key per block-face-slot. `buildSurfaceLut()` bakes a
 * 256 x 256 lookup indexed by (red, green) holding {tile, detail, seam}. The
 * vertex shader does one `texelFetch` and flats the result down. Free.
 *
 * WHY THE TILES ARE DENSER THAN THEY WERE. The first version of this atlas was
 * authored for subtlety and measured invisible: at a 10x amplitude boost the
 * stone tile was effectively blank and the hellstone vein showed roughly ONE
 * crack per block, against a bar whose sand carries a dense ripple and whose
 * masonry carries eight courses. Amplitude was only half the problem — the
 * high-pass residual a surface produces scales with how often adjacent texels
 * differ, so a low-frequency tile has a ceiling no amount of strength can lift.
 * Every painter is now authored for eight or more countable features per block
 * in each axis and finishes with `speckle`, the per-texel layer that is the
 * only detail still resolvable when one block fills half the screen.
 *
 * `detail` (typically 0.07 .. 0.23) remains the one number that retunes a
 * material without regenerating a pixel; the shader now spends it on both the
 * relative and the absolute term.
 */

import * as THREE from 'three';
import { BLOCK_COLOR, BLOCK_COUNT, BlockId } from '@doomcraft/shared';

/* ------------------------------------------------------------------------ *
 * Atlas geometry
 * ------------------------------------------------------------------------ */

/**
 * Edge of one tile, in texels. Power of two so box-filter mips never cross a
 * tile.
 *
 * 128, not 64. One tile covers exactly one block, and a block at nose range
 * fills ~600 screen pixels, so at 64 a single texel was 9 pixels wide under
 * NearestFilter magnification. The high-pass metric only sees energy where
 * adjacent texels differ, and at 9 px per texel that is under 40% of the
 * surface — which put a hard ceiling on how much visible detail ANY tile could
 * carry up close, whatever its amplitude. At 128 a texel is 4.7 px, the tile
 * can hold twice the feature density in each axis, and the ceiling moves.
 *
 * The cost is one 512x512 R8 texture (256 KB + mips) instead of 256x256, still
 * generated at boot with no asset file, and the fragment shader does exactly
 * the same single fetch it did before.
 */
export const ATLAS_TILE = 128;
export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 4;
export const ATLAS_W = ATLAS_TILE * ATLAS_COLS; // 512
export const ATLAS_H = ATLAS_TILE * ATLAS_ROWS; // 512
export const ATLAS_TILE_COUNT = ATLAS_COLS * ATLAS_ROWS;

/**
 * Texels per unit of the original 64-texel authoring grid. Painter constants
 * that are genuinely a THICKNESS (a mortar joint, a nail head) scale with this;
 * constants that are a COUNT PER BLOCK (courses, pebbles, chevrons) do not,
 * because the whole point of the bigger tile is to raise those counts.
 */
const S = ATLAS_TILE / 64;

/**
 * Tile ids. The value IS the atlas slot: `col = id % 4`, `row = floor(id / 4)`.
 * Keep in sync with the painters in `paintTile`.
 */
export const Tile = {
  /** Flat 0.5 — glass, water, neon: anything a pattern would only spoil. */
  PLAIN: 0,
  /** Running-bond stone blocks. The bar's signature close-up look. */
  STONE: 1,
  /** Cellular pebbles with dark mortar gaps. */
  COBBLE: 2,
  /** Fine running-bond brick, more courses and harder mortar than STONE. */
  BRICK: 3,
  /** Coarse clumpy grain. */
  DIRT: 4,
  /** Fine per-pixel speckle with a few blade flecks. */
  GRASS: 5,
  /** Chevron dither — measured off ref/voxiom/desktop-10-place.png. */
  SAND: 6,
  /** Vertical wood grain with knots. */
  WOOD: 7,
  /** Horizontal boards, separators and nail dots. */
  PLANKS: 8,
  /** Panel with an inset seam, corner rivets and brushed lines. */
  METAL: 9,
  /** Quartered grid, scanlines and two lit cells. */
  TECH: 10,
  /** Branching crack veins. */
  VEIN: 11,
  /** Clumped canopy with holes. */
  LEAVES: 12,
  /** Thin horizontal striations. */
  STRIA: 13,
  /** Finer cellular than COBBLE. */
  GRAVEL: 14,
  /** Concentric growth rings — log end grain. */
  RINGS: 15,
} as const;

/* ------------------------------------------------------------------------ *
 * Deterministic noise
 *
 * A fixed seed means the atlas is byte-identical every boot, so a screenshot
 * diff between two runs is a real regression and not the RNG.
 * ------------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Field = Float32Array; // ATLAS_TILE^2, neutral 0.5

function newField(v = 0.5): Field {
  const f = new Float32Array(ATLAS_TILE * ATLAS_TILE);
  f.fill(v);
  return f;
}

const wrap = (v: number): number => ((v % ATLAS_TILE) + ATLAS_TILE) % ATLAS_TILE;

function put(f: Field, x: number, y: number, v: number): void {
  f[wrap(y) * ATLAS_TILE + wrap(x)] = v;
}
function get(f: Field, x: number, y: number): number {
  return f[wrap(y) * ATLAS_TILE + wrap(x)];
}
function mul(f: Field, x: number, y: number, v: number): void {
  const i = wrap(y) * ATLAS_TILE + wrap(x);
  f[i] *= v;
}

/** Wrapping value-noise lattice, so a tile meets itself cleanly at its edges. */
function lattice(rnd: () => number, cells: number): Float32Array {
  const a = new Float32Array(cells * cells);
  for (let i = 0; i < a.length; i++) a[i] = rnd();
  return a;
}

function sampleLattice(a: Float32Array, cells: number, x: number, y: number): number {
  const s = ATLAS_TILE / cells;
  const fx = x / s;
  const fy = y / s;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const ux = tx * tx * (3 - 2 * tx);
  const uy = ty * ty * (3 - 2 * ty);
  const j0 = ((x0 % cells) + cells) % cells;
  const j1 = (j0 + 1) % cells;
  const i0 = ((y0 % cells) + cells) % cells;
  const i1 = (i0 + 1) % cells;
  const top = a[i0 * cells + j0] + (a[i0 * cells + j1] - a[i0 * cells + j0]) * ux;
  const bot = a[i1 * cells + j0] + (a[i1 * cells + j1] - a[i1 * cells + j0]) * ux;
  return top + (bot - top) * uy;
}

/** Add fractal value noise, centred on zero, amplitude `amp`. */
function addFbm(f: Field, rnd: () => number, cells: number, octaves: number, amp: number): void {
  let a = amp;
  let c = cells;
  for (let o = 0; o < octaves; o++) {
    const l = lattice(rnd, c);
    for (let y = 0; y < ATLAS_TILE; y++) {
      for (let x = 0; x < ATLAS_TILE; x++) {
        f[y * ATLAS_TILE + x] += (sampleLattice(l, c, x, y) - 0.5) * 2 * a;
      }
    }
    a *= 0.5;
    c = Math.min(c * 2, ATLAS_TILE);
  }
}

/** Add uncorrelated per-texel grain. */
function addGrain(f: Field, rnd: () => number, amp: number): void {
  for (let i = 0; i < f.length; i++) f[i] += (rnd() - 0.5) * 2 * amp;
}

/* ------------------------------------------------------------------------ *
 * Painters
 * ------------------------------------------------------------------------ */

/**
 * Running bond. `courses` rows per BLOCK of `units` wide stones, every other
 * row shifted half a unit, `mortar` texels of darker joint between them, and a
 * per-unit value jitter so no two stones are the same value.
 *
 * Counts, not texel sizes: the density of a masonry pattern is what the eye
 * reads, and it must not silently halve when the tile resolution changes.
 */
function bond(
  f: Field, rnd: () => number,
  courses: number, units: number, mortar: number,
  jointDark: number, jitter: number,
): void {
  const courseH = ATLAS_TILE / courses;
  const brickW = ATLAS_TILE / units;
  for (let y = 0; y < ATLAS_TILE; y++) {
    const course = Math.floor(y / courseH);
    const shift = (course & 1) === 1 ? brickW * 0.5 : 0;
    const yIn = y - course * courseH;
    for (let x = 0; x < ATLAS_TILE; x++) {
      const sx = x + shift;
      const unit = Math.floor(sx / brickW);
      const xIn = sx - unit * brickW;
      // One deterministic jitter per (course, unit), wrapped so the tile repeats.
      const key = ((course % courses) * 71 + (unit % units) * 131) % 997;
      const j = ((Math.sin(key * 12.9898) * 43758.5453) % 1 + 1) % 1;
      let v = 0.5 + (j - 0.5) * 2 * jitter;
      // Joints: bottom rows of the course and left columns of the unit.
      if (yIn < mortar || xIn < mortar) v -= jointDark;
      // A highlight just inside the joint reads as a chamfer.
      else if (yIn < mortar + S || xIn < mortar + S) v += jointDark * 0.35;
      f[y * ATLAS_TILE + x] = v;
    }
  }
}

/**
 * Jittered-grid cellular. `edge` controls how dark the gap between pebbles is,
 * the per-cell value gives each pebble its own tone.
 */
function cellular(
  f: Field, rnd: () => number, cells: number, edge: number, spread: number,
): void {
  const n = cells * cells;
  const cxs = new Float32Array(n);
  const cys = new Float32Array(n);
  const cvs = new Float32Array(n);
  const s = ATLAS_TILE / cells;
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      const i = cy * cells + cx;
      cxs[i] = (cx + 0.2 + rnd() * 0.6) * s;
      cys[i] = (cy + 0.2 + rnd() * 0.6) * s;
      cvs[i] = 0.5 + (rnd() - 0.5) * 2 * spread;
    }
  }
  for (let y = 0; y < ATLAS_TILE; y++) {
    for (let x = 0; x < ATLAS_TILE; x++) {
      const gy = Math.floor(y / s);
      const gx = Math.floor(x / s);
      let d0 = 1e9;
      let d1 = 1e9;
      let best = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const wy = ((gy + oy) % cells + cells) % cells;
          const wx = ((gx + ox) % cells + cells) % cells;
          const i = wy * cells + wx;
          // Unwrap the seed back next to this pixel.
          const px = cxs[i] + (gx + ox - wx) * s;
          const py = cys[i] + (gy + oy - wy) * s;
          const dx = x - px;
          const dy = y - py;
          // Squared distance for the ranking; the two survivors get the only
          // sqrts. Nine per texel was most of the atlas's boot cost.
          const d = dx * dx + dy * dy;
          if (d < d0) { d1 = d0; d0 = d; best = i; }
          else if (d < d1) { d1 = d; }
        }
      }
      // (d1 - d0) is ~0 exactly on a cell border and grows toward the centre.
      const rim = Math.min(1, (Math.sqrt(d1) - Math.sqrt(d0)) / (s * 0.42));
      f[y * ATLAS_TILE + x] = cvs[best] - (1 - rim) * edge;
    }
  }
}

/**
 * Per-texel speckle at the FINEST scale the tile has.
 *
 * This is not decoration, it is the highest-frequency thing in the atlas and
 * therefore the only detail that still has somewhere to go when a block fills
 * half the screen. Structure (courses, pebbles, chevrons) carries the read at
 * two metres; speckle is what stops a wall going smooth at arm's length. The
 * bar does exactly this — its grass is a fine per-texel speckle over a coarse
 * tone — and it is why the bar's grass scores 4.4 where our old stone scored
 * 0.66.
 *
 * Two octaves: a 1-texel layer and a 2-texel layer, so it reads as grain rather
 * than as television static.
 */
function speckle(f: Field, rnd: () => number, amp: number): void {
  addGrain(f, rnd, amp * 0.62);
  const T = ATLAS_TILE;
  const half = new Float32Array((T >> 1) * (T >> 1));
  for (let i = 0; i < half.length; i++) half[i] = (rnd() - 0.5) * 2 * amp * 0.72;
  for (let y = 0; y < T; y++) {
    const row = (y >> 1) * (T >> 1);
    for (let x = 0; x < T; x++) f[y * T + x] += half[row + (x >> 1)];
  }
}

/**
 * One tile's worth of pixels, neutral 0.5, values usually inside [0.15, 0.85].
 *
 * DENSITY IS THE BRIEF. One tile is one block, and at 10x boost the old stone
 * tile was effectively blank while the old hellstone vein showed about one
 * crack per block — against a bar whose sand shows dense ripple and whose
 * masonry shows eight courses. Every painter below is authored for at least
 * eight features per block in each axis, and every one of them finishes with
 * `speckle`, which is the only detail fine enough to survive a block filling
 * half the screen.
 */
function paintTile(tile: number): Field {
  // Per-tile seed: changing one tile never reshuffles another.
  const rnd = mulberry32(0x5eed_0000 + tile * 7919);
  const f = newField();
  const T = ATLAS_TILE;

  switch (tile) {
    case Tile.PLAIN:
      return f;

    case Tile.STONE: {
      // Eight courses of four stones — the density the bar's close-up stone
      // has, and double what this tile used to carry.
      bond(f, rnd, 8, 4, 2 * S, 0.24, 0.085);
      // A second, offset bond at half scale breaks the regularity so the wall
      // does not read as graph paper, and doubles the joint count again.
      const sub = newField(0);
      bond2(sub, 16, 8, S, 0.11, 0.0);
      for (let i = 0; i < f.length; i++) f[i] += sub[i];
      addFbm(f, rnd, 16, 3, 0.06);
      speckle(f, rnd, 0.245);
      break;
    }

    case Tile.BRICK: {
      bond(f, rnd, 10, 6, 2 * S, 0.30, 0.075);
      addFbm(f, rnd, 32, 2, 0.045);
      speckle(f, rnd, 0.165);
      break;
    }

    case Tile.COBBLE: {
      cellular(f, rnd, 10, 0.30, 0.13);
      addFbm(f, rnd, 16, 2, 0.05);
      speckle(f, rnd, 0.155);
      break;
    }

    case Tile.GRAVEL: {
      cellular(f, rnd, 17, 0.24, 0.14);
      speckle(f, rnd, 0.15);
      break;
    }

    case Tile.DIRT: {
      addFbm(f, rnd, 16, 4, 0.20);
      speckle(f, rnd, 0.13);
      // Dark grit specks: dirt without them reads as noise, not soil.
      for (let i = 0; i < 26 * S * S; i++) {
        const x = (rnd() * T) | 0;
        const y = (rnd() * T) | 0;
        const r = S + ((rnd() * 2 * S) | 0);
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy > r * r) continue;
            mul(f, x + dx, y + dy, 0.78);
          }
        }
      }
      break;
    }

    case Tile.GRASS: {
      addFbm(f, rnd, 32, 3, 0.10);
      speckle(f, rnd, 0.125);
      // Blade flecks: short vertical strokes, half light half dark.
      for (let i = 0; i < 90 * S * S; i++) {
        const x = (rnd() * T) | 0;
        const y = (rnd() * T) | 0;
        const v = rnd() < 0.5 ? -0.13 : 0.13;
        for (let k = 0; k < 2 * S; k++) {
          put(f, x, y + k, get(f, x, y + k) + v * (1 - k * 0.3));
        }
      }
      break;
    }

    case Tile.SAND: {
      // Chevrons: a triangle wave in x offsets a horizontal band pattern, which
      // is precisely how the bar's beach reads at 4x loupe. Four chevrons and
      // sixteen bands per block, against the old two and eight.
      const zigW = T / 4;
      const bandH = T / 16;
      for (let y = 0; y < T; y++) {
        for (let x = 0; x < T; x++) {
          const zig = Math.abs((x % zigW) - zigW * 0.5);
          const band = Math.floor(y + zig) % (bandH * 4);
          let v: number;
          if (band < bandH) v = 0.36;
          else if (band < bandH * 2) v = 0.46;
          else if (band < bandH * 3) v = 0.60;
          else v = 0.52;
          f[y * T + x] = v;
        }
      }
      speckle(f, rnd, 0.085);
      break;
    }

    case Tile.WOOD: {
      // Vertical grain: a warped sine in x, so the log side has direction.
      const warp = lattice(rnd, 8);
      for (let y = 0; y < T; y++) {
        for (let x = 0; x < T; x++) {
          const w = (sampleLattice(warp, 8, x, y) - 0.5) * 5 * S;
          // Two grain frequencies, ~16 and ~40 lines per block.
          const s1 = Math.sin((x + w) * (Math.PI * 2 * 16) / T);
          const s2 = Math.sin((x + w * 0.4) * (Math.PI * 2 * 41) / T);
          f[y * T + x] = 0.5 + s1 * 0.13 + s2 * 0.05;
        }
      }
      // Knots.
      for (let i = 0; i < 3; i++) {
        const kx = (rnd() * T) | 0;
        const ky = (rnd() * T) | 0;
        const kr = 5 * S;
        for (let dy = -kr; dy <= kr; dy++) {
          for (let dx = -kr; dx <= kr; dx++) {
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d > kr) continue;
            put(f, kx + dx, ky + dy, 0.5 - 0.24 * (1 - d / kr));
          }
        }
      }
      speckle(f, rnd, 0.10);
      break;
    }

    case Tile.PLANKS: {
      const boards = 8;
      const boardH = T / boards;
      for (let y = 0; y < T; y++) {
        const board = Math.floor(y / boardH);
        const yIn = y - board * boardH;
        const tone = 0.5 + (board % 2 === 0 ? 0.04 : -0.04) + (board % 3 === 1 ? 0.022 : 0);
        for (let x = 0; x < T; x++) {
          let v = tone + Math.sin(x * (Math.PI * 2 * 11) / T + board * 2.1) * 0.045;
          if (yIn < S) v -= 0.26;                    // board separator
          else if (yIn < 2 * S) v += 0.08;           // lit lip below it
          f[y * T + x] = v;
        }
      }
      // Nail dots, two per board.
      for (let board = 0; board < boards; board++) {
        for (const nx of [7 * S, T - 8 * S]) {
          const ny = board * boardH + boardH * 0.5;
          for (let dy = 0; dy < S; dy++) {
            for (let dx = 0; dx < S; dx++) {
              put(f, nx + dx, ny + dy, 0.28);
              put(f, nx + S + dx, ny + dy, 0.36);
              put(f, nx + dx, ny + S + dy, 0.36);
            }
          }
        }
      }
      speckle(f, rnd, 0.09);
      break;
    }

    case Tile.METAL: {
      // Brushed horizontal lines, ~32 per block.
      for (let y = 0; y < T; y++) {
        for (let x = 0; x < T; x++) {
          f[y * T + x] = 0.5 + ((y & (2 * S - 1)) < S ? -0.05 : 0.02);
        }
      }
      // Four inset panels rather than one: a merged metal wall used to show a
      // single frame per block and read as a flat sheet between the frames.
      for (const q of [0, 1]) {
        for (const r of [0, 1]) {
          const ox = q * (T / 2);
          const oy = r * (T / 2);
          const lo = 3 * S;
          const hi = T / 2 - 4 * S;
          for (let i = lo; i < hi; i++) {
            put(f, ox + i, oy + lo, 0.28);
            put(f, ox + lo, oy + i, 0.28);
            put(f, ox + i, oy + lo + S, 0.66);
            put(f, ox + lo + S, oy + i, 0.66);
            put(f, ox + i, oy + hi, 0.30);
            put(f, ox + hi, oy + i, 0.30);
          }
          // Corner rivets, one cluster per panel corner.
          for (const cx of [ox + 7 * S, ox + T / 2 - 8 * S]) {
            for (const cy of [oy + 7 * S, oy + T / 2 - 8 * S]) {
              for (let dy = 0; dy < S; dy++) {
                for (let dx = 0; dx < S; dx++) {
                  put(f, cx + dx, cy + dy, 0.76);
                  put(f, cx + S + dx, cy + dy, 0.66);
                  put(f, cx + dx, cy + S + dy, 0.32);
                  put(f, cx + S + dx, cy + S + dy, 0.28);
                }
              }
            }
          }
        }
      }
      speckle(f, rnd, 0.075);
      break;
    }

    case Tile.TECH: {
      const cellN = 4;              // 4 x 4 lit cells per block
      const cell = T / cellN;
      for (let y = 0; y < T; y++) {
        for (let x = 0; x < T; x++) {
          // Scanlines, 16 per block.
          let v = 0.5 + ((y % (T / 16)) < S ? -0.07 : 0.008);
          if (x % cell < S || y % cell < S) v = 0.26;
          f[y * T + x] = v;
        }
      }
      // Lit windows, one in a third of the cells, deterministic per cell.
      for (let cy = 0; cy < cellN; cy++) {
        for (let cx = 0; cx < cellN; cx++) {
          if (((cx * 5 + cy * 3) % 3) !== 0) continue;
          const ox = cx * cell + 4 * S;
          const oy = cy * cell + 5 * S;
          for (let j = 0; j < 4 * S; j++) {
            for (let i = 0; i < 8 * S; i++) put(f, ox + i, oy + j, 0.84);
          }
        }
      }
      speckle(f, rnd, 0.07);
      break;
    }

    case Tile.VEIN: {
      // The worst offender in the old atlas: four random walks over a whole
      // block, i.e. roughly ONE crack per block, on the darkest materials in
      // the palette. Now a real fracture network — twenty seeded walks that
      // branch, over a mottled base — so hellstone and obsidian read as damaged
      // rock instead of as flat paint.
      addFbm(f, rnd, 16, 4, 0.10);
      const walks: Array<{ x: number; y: number; a: number; len: number }> = [];
      for (let c = 0; c < 20; c++) {
        walks.push({ x: rnd() * T, y: rnd() * T, a: rnd() * Math.PI * 2, len: 26 * S + ((rnd() * 22 * S) | 0) });
      }
      while (walks.length > 0) {
        const w = walks.pop()!;
        for (let s = 0; s < w.len; s++) {
          w.a += (rnd() - 0.5) * 0.9;
          w.x += Math.cos(w.a);
          w.y += Math.sin(w.a);
          put(f, w.x | 0, w.y | 0, 0.14);
          // A hot lip on one side sells it as a glowing fissure.
          const lx = (w.x | 0) + 1, ly = w.y | 0;
          put(f, lx, ly, Math.min(0.92, get(f, lx, ly) + 0.20));
          // Branch, but only from the first generation, so the network is dense
          // without turning into a solid black scribble.
          if (w.len > 20 * S && s > 8 && rnd() < 0.035 && walks.length < 40) {
            walks.push({ x: w.x, y: w.y, a: w.a + (rnd() < 0.5 ? 1.1 : -1.1), len: 10 * S });
          }
        }
      }
      speckle(f, rnd, 0.095);
      break;
    }

    case Tile.LEAVES: {
      addFbm(f, rnd, 16, 4, 0.20);
      speckle(f, rnd, 0.12);
      // Punch holes: a canopy needs gaps or it reads as green stone.
      for (let i = 0; i < 16 * S * S; i++) {
        const x = (rnd() * T) | 0;
        const y = (rnd() * T) | 0;
        const r = S + ((rnd() * 2 * S) | 0);
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy > r * r) continue;
            mul(f, x + dx, y + dy, 0.64);
          }
        }
      }
      break;
    }

    case Tile.STRIA: {
      const jitterL = lattice(rnd, 8);
      for (let y = 0; y < T; y++) {
        for (let x = 0; x < T; x++) {
          const j = (sampleLattice(jitterL, 8, x, y) - 0.5) * 3 * S;
          // ~18 striations per block plus a finer second layer.
          const s1 = Math.sin((y + j) * (Math.PI * 2 * 18) / T);
          const s2 = Math.sin((y - j * 0.5) * (Math.PI * 2 * 43) / T);
          f[y * T + x] = 0.5 + s1 * 0.12 + s2 * 0.045;
        }
      }
      speckle(f, rnd, 0.10);
      break;
    }

    case Tile.RINGS: {
      const cx = T * 0.5;
      const cy = T * 0.5;
      for (let y = 0; y < T; y++) {
        for (let x = 0; x < T; x++) {
          const dx = x - cx;
          const dy = y - cy;
          const d = Math.sqrt(dx * dx + dy * dy);
          // ~22 rings across the block, plus a radial checker so the end grain
          // is not concentric-only.
          f[y * T + x] = 0.5
            + Math.sin(d * (Math.PI * 2 * 22) / T) * 0.13
            + Math.sin(Math.atan2(dy, dx) * 9.0) * 0.035;
        }
      }
      addFbm(f, rnd, 16, 2, 0.05);
      speckle(f, rnd, 0.10);
      break;
    }

    default:
      break;
  }
  return f;
}

/**
 * A second bond laid straight into an already-painted field, additively and
 * without jitter. Used to put a finer course inside a coarse one: two bonds an
 * octave apart read as dressed stone, where one bond twice as fine just reads
 * as smaller bricks.
 */
function bond2(
  f: Field, courses: number, units: number, mortar: number, jointDark: number, phase: number,
): void {
  const courseH = ATLAS_TILE / courses;
  const brickW = ATLAS_TILE / units;
  for (let y = 0; y < ATLAS_TILE; y++) {
    const course = Math.floor(y / courseH);
    const shift = ((course & 1) === 1 ? brickW * 0.5 : 0) + phase;
    const yIn = y - course * courseH;
    for (let x = 0; x < ATLAS_TILE; x++) {
      const sx = x + shift;
      const xIn = sx - Math.floor(sx / brickW) * brickW;
      if (yIn < mortar || xIn < mortar) f[y * ATLAS_TILE + x] -= jointDark;
    }
  }
}

/**
 * Force a tile's mean back onto the neutral 0.5 and clamp it into range.
 *
 * This is not cosmetic. The shader reads the tile as `1 + (v - 0.5) * 2 * amp`,
 * so a tile whose mean sits at 0.39 — which the cellular painters do naturally,
 * because their mortar gaps only ever subtract — would darken every cobblestone
 * in the world by 11% and quietly redefine the authored palette. Zero-mean is
 * what makes this a DETAIL map instead of a recolour, and it is also what makes
 * mip bleeding between tiles invisible.
 */
function normalise(f: Field): void {
  for (let pass = 0; pass < 3; pass++) {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i];
    const shift = 0.5 - sum / f.length;
    if (Math.abs(shift) < 0.001 && pass > 0) break;
    for (let i = 0; i < f.length; i++) {
      const v = f[i] + shift;
      f[i] = v < 0.04 ? 0.04 : v > 0.96 ? 0.96 : v;
    }
  }
}

/** The whole atlas as one 8-bit red-channel image, row 0 first. */
export function buildAtlasData(): Uint8Array {
  const out = new Uint8Array(ATLAS_W * ATLAS_H);
  for (let tile = 0; tile < ATLAS_TILE_COUNT; tile++) {
    const f = paintTile(tile);
    normalise(f);
    const ox = (tile % ATLAS_COLS) * ATLAS_TILE;
    const oy = Math.floor(tile / ATLAS_COLS) * ATLAS_TILE;
    for (let y = 0; y < ATLAS_TILE; y++) {
      const dst = (oy + y) * ATLAS_W + ox;
      for (let x = 0; x < ATLAS_TILE; x++) {
        const v = f[y * ATLAS_TILE + x];
        out[dst + x] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Block -> surface table
 * ------------------------------------------------------------------------ */

export interface Surface {
  /** Atlas tile id. */
  tile: number;
  /** How far the tile pushes the base colour, 0 .. 1. Read as +/- this fraction. */
  detail: number;
  /** How strongly the per-block seam groove is drawn on this material, 0 .. 1. */
  seam: number;
  /**
   * Mirror the tile per block on a hash of the block's world position. One tile
   * repeated identically over a forty-block hellstone wall reads as wallpaper;
   * four orientations kill that for two ALU. Only for materials with no
   * directional structure — a running bond or a plank line must stay aligned
   * with its neighbours or the wall falls apart.
   */
  vary: boolean;
}

function s(tile: number, detail: number, seam = 1, vary = false): Surface {
  return { tile, detail, seam, vary };
}

/** Slot order matches BLOCK_COLOR: 0 top, 1 side, 2 bottom. */
type Triple = readonly [Surface, Surface, Surface];

function same(x: Surface): Triple {
  return [x, x, x];
}

const PLAIN = s(Tile.PLAIN, 0, 0);

/**
 * One entry per BlockId. Numbers are tuned against ref/voxiom: the bar's sand
 * dither is clearly visible at a metre and gone at thirty, and that is the
 * target. Anything above ~0.25 starts fighting the flat-shaded voxel read.
 */
const SURFACES: readonly Triple[] = (() => {
  const t: Triple[] = new Array<Triple>(BLOCK_COUNT).fill(same(PLAIN));
  const rock = s(Tile.STONE, 0.225);
  const dirt = s(Tile.DIRT, 0.19, 1, true);
  const wood = s(Tile.WOOD, 0.18);
  const logEnd = s(Tile.RINGS, 0.15);

  t[BlockId.AIR] = same(PLAIN);
  t[BlockId.STONE] = same(rock);
  t[BlockId.DIRT] = same(dirt);
  // Grass shares dirt's side and bottom colour, so those keys land on the dirt
  // tile automatically; only the top is its own thing.
  t[BlockId.GRASS] = [s(Tile.GRASS, 0.16, 1, true), dirt, dirt];
  t[BlockId.SAND] = same(s(Tile.SAND, 0.15));
  // Water and lava are liquids with a shader ripple already; a grid on a lake
  // surface looks like a bug, so both stay smooth.
  t[BlockId.WATER] = same(s(Tile.PLAIN, 0, 0));
  t[BlockId.WOOD] = [logEnd, wood, logEnd];
  t[BlockId.LEAVES] = same(s(Tile.LEAVES, 0.22, 0.25, true));
  t[BlockId.METAL] = same(s(Tile.METAL, 0.15));
  t[BlockId.LAVA] = same(s(Tile.VEIN, 0.10, 0.15, true));
  t[BlockId.GLASS] = same(s(Tile.PLAIN, 0, 0));
  t[BlockId.BRICK] = same(s(Tile.BRICK, 0.19));
  t[BlockId.PLANKS] = same(s(Tile.PLANKS, 0.18));
  t[BlockId.COBBLESTONE] = same(s(Tile.COBBLE, 0.22, 1, true));
  t[BlockId.SNOW] = same(s(Tile.GRASS, 0.07, 0.55, true));
  t[BlockId.ICE] = same(s(Tile.VEIN, 0.07, 0.30, true));
  t[BlockId.OBSIDIAN] = same(s(Tile.VEIN, 0.18, 0.85, true));
  t[BlockId.GRAVEL] = same(s(Tile.GRAVEL, 0.19, 1, true));
  t[BlockId.RUSTED_METAL] = same(s(Tile.METAL, 0.21));
  t[BlockId.TECH_PANEL] = same(s(Tile.TECH, 0.17));
  t[BlockId.HELLSTONE] = same(s(Tile.VEIN, 0.18, 1, true));
  t[BlockId.BONE] = same(s(Tile.STRIA, 0.12));
  t[BlockId.SLIME] = same(s(Tile.LEAVES, 0.10, 0.40, true));
  // Neon is a light source. Patterning it just makes the emissive read dirty.
  t[BlockId.NEON] = same(s(Tile.PLAIN, 0, 0.45));
  t[BlockId.BEDROCK] = same(s(Tile.COBBLE, 0.13, 1, true));
  return t;
})();

/** LUT edge, in texels: indexed by the red and green bytes of the face colour. */
export const LUT_SIZE = 256;

const byte = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0);

/**
 * 256 x 256 RGBA lookup, indexed by `texelFetch(lut, ivec2(r8, g8), 0)`:
 *
 *     R  atlas tile id
 *     G  detail strength * 255
 *     B  seam strength * 255
 *     A  255 mirror the tile per block, 0 keep every block aligned
 *
 * Why (red, green) and not the full colour: a 2D texelFetch is exact and free,
 * a 24-bit key needs a hash. The 75 authored face colours have no (r,g)
 * collision — `collisions` reports any that a future palette edit introduces so
 * this fails loudly in the console instead of quietly texturing the wrong block.
 */
export function buildSurfaceLut(): { data: Uint8Array; collisions: string[] } {
  const data = new Uint8Array(LUT_SIZE * LUT_SIZE * 4);
  // Default for any colour we did not author: plain, no detail, but keep the
  // block grid so an unmapped material still reads as blocks.
  for (let i = 0; i < LUT_SIZE * LUT_SIZE; i++) {
    data[i * 4 + 2] = 255;
  }
  const claimed = new Map<number, number>();
  const collisions: string[] = [];

  for (let id = 1; id < BLOCK_COUNT; id++) {
    for (let slot = 0; slot < 3; slot++) {
      const colour = BLOCK_COLOR[id * 3 + slot];
      const r = (colour >>> 16) & 0xff;
      const g = (colour >>> 8) & 0xff;
      const key = g * LUT_SIZE + r;
      const surf = SURFACES[id][slot];
      const prev = claimed.get(key);
      if (prev !== undefined && prev !== colour) {
        collisions.push(
          `block ${id} slot ${slot} colour #${colour.toString(16)} collides with #${prev.toString(16)} on (r,g)`,
        );
      }
      claimed.set(key, colour);
      const o = key * 4;
      data[o + 0] = surf.tile;
      data[o + 1] = byte(surf.detail);
      data[o + 2] = byte(surf.seam);
      data[o + 3] = surf.vary ? 255 : 0;
    }
  }
  return { data, collisions };
}

/* ------------------------------------------------------------------------ *
 * Textures
 * ------------------------------------------------------------------------ */

/**
 * The detail atlas. Nearest magnification keeps it crisp and blocky rather than
 * blurry, mipmaps kill the shimmer at range. Auto mipmaps are safe here: the
 * atlas is a power-of-two grid of power-of-two tiles, so a box filter never
 * crosses a tile boundary until the whole atlas is under 4 x 4 texels, and by
 * then every tile has averaged to its neutral 0.5 anyway.
 */
export function createAtlasTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(
    buildAtlasData(), ATLAS_W, ATLAS_H, THREE.RedFormat, THREE.UnsignedByteType,
  );
  tex.internalFormat = 'R8';
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.anisotropy = 1;
  tex.flipY = false;
  tex.unpackAlignment = 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.name = 'voxel-detail-atlas';
  tex.needsUpdate = true;
  return tex;
}

/** The colour -> surface lookup. Point sampled, never filtered, never mipped. */
export function createSurfaceLutTexture(): THREE.DataTexture {
  const { data, collisions } = buildSurfaceLut();
  if (collisions.length > 0) {
    console.warn('[textureAtlas] face-colour LUT collisions:\n  ' + collisions.join('\n  '));
  }
  const tex = new THREE.DataTexture(
    data, LUT_SIZE, LUT_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType,
  );
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.unpackAlignment = 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.name = 'voxel-surface-lut';
  tex.needsUpdate = true;
  return tex;
}
