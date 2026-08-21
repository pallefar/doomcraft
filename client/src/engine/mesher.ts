/**
 * DOOMCRAFT — greedy chunk mesher.
 *
 * Turns one 32 x 64 x 32 chunk (plus a one-voxel skirt of its neighbours) into
 * up to three interleaved vertex buffers, one per RenderLayer, so a chunk costs
 * at most three draw calls (contract decision 9).
 *
 * Two things make this worth reading:
 *
 *  1. AO. ref/BAR.md weakness #4 is that voxiom has no ambient occlusion and the
 *     beach "reads as one mass". Every quad corner carries a 2-bit occlusion term
 *     derived from the three voxels around that corner, and the triangulation
 *     diagonal is flipped when the AO is anisotropic. Skipping that flip is what
 *     produces the classic diagonal seam across every merged quad.
 *
 *  2. A REAL LIGHT FIELD, which is the other half of the same weakness. Two
 *     independent channels are baked per face:
 *
 *       - SKY, 0..15: a downward scan per column (15 until the first
 *         sky-blocking voxel) followed by a bounded HORIZONTAL BLEED, so the
 *         number ramps from open ground into a room instead of stepping. That
 *         one channel is what separates a roofed room from open ground and it is
 *         the whole reason terrain can build interiors at all — without it a
 *         bunker's floor is lit exactly like the arena outside and the roof is
 *         decoration.
 *
 *         The bleed replaces a binary field, and the reason is a measurement,
 *         not taste. Histogrammed over 16 chunks of the shipped generator,
 *         **40% of all emitted quads came out sky = 0** — not because 40% of the
 *         world is indoors but because the test was "is anything directly
 *         overhead", which is true of every square metre under a crag lip, a
 *         bastion cap or an arch. Those faces were all being rendered at the
 *         interior key, so the outdoors was as murky as the indoors and there
 *         was no contrast left to spend on an actual room. See `buildSkyField`
 *         for the sweep and why it is seam-exact.
 *
 *       - BLOCK, 0..15 plus a 2-bit hue class, flood-filled from every emissive
 *         voxel with `LIGHT_ATTEN` lost per step, so a lava pool lights the room
 *         it sits in for `LIGHT_REACH` blocks in every direction instead of the
 *         one-voxel rim the old max-of-neighbours gave. `PAD_R` was always sized
 *         for this (see below); this is the code that finally uses it.
 *
 *     Both are packed into the greedy merge key, so a merged quad is only ever
 *     merged across faces that agree on their lighting.
 *
 *  3. Zero allocation after warmup. All scratch (masks, light fields, vertex
 *     bytes, indices) lives at module scope and is reused. `meshChunk()` returns
 *     views into that scratch; they are valid only until the next call. The
 *     worker copies them into exact-size transferables at the boundary — that is
 *     the only allocation.
 *
 * VERTEX FORMAT (12 bytes, three uint8x4 attributes, one interleaved buffer):
 *
 *     byte 0..2   position x,y,z   chunk-local integers 0..32 / 0..64  (NOT normalized)
 *     byte 3      face             0..5, matches the shared `Face` enum
 *     byte 4      ao               0..3, 0 = fully occluded corner
 *     byte 5      light            block light: level 0..15 in bits 0..3,
 *                                  hue class 0..2 in bits 4..5
 *     byte 6      alpha            block alpha * 255
 *     byte 7      flags            VF_LIQUID | VF_EMISSIVE
 *     byte 8..10  colour r,g,b     BLOCK_FACE_COLOR, UNSHADED  (normalized in GL)
 *     byte 11     sky              sky exposure 0..15 scaled to 0..255 (normalized
 *                                  in GL as aColor.a). This byte used to be 255
 *                                  of padding, so the whole sky channel costs
 *                                  zero extra bytes per vertex and zero extra
 *                                  attributes.
 *
 * Deliberate deviation from the brief's "position float32x3": three.js derives a
 * GL attribute's component type from the InterleavedBuffer's array type, so a
 * mixed float/byte interleaving needs two InterleavedBuffers over the same data
 * and therefore uploads every chunk to the GPU twice. Greedy quad corners are
 * always integers in 0..64, so uint8 is lossless here and the buffer is 12 bytes
 * per vertex in ONE upload instead of 20 bytes in two.
 *
 * Deliberate deviation from contract note 9's "use BLOCK_FACE_SHADED": the colour
 * written here is the UNSHADED `BLOCK_FACE_COLOR`. The face shade is applied
 * exactly once, in the shader (see material.ts), where it can also respond to the
 * sun azimuth so +X and -X are not the same value. `MESHER_APPLIES_FACE_SHADE`
 * records this so nobody double-shades.
 */

import {
  BLOCK_ALPHA,
  BLOCK_COUNT,
  BLOCK_FACE_COLOR,
  BLOCK_LAYER,
  BLOCK_LIGHT,
  BLOCK_LIQUID,
  BLOCK_OPAQUE,
  BLOCK_SOLID,
  BlockId,
  CHUNK_HEIGHT,
  CHUNK_SIZE_X,
  CHUNK_SIZE_Z,
  RENDER_LAYER_COUNT,
  RenderLayer,
  shouldRenderFace,
} from '@doomcraft/shared';

/* ------------------------------------------------------------------------ *
 * Hot-loop aliases
 *
 * A cross-module ESM binding is a namespace property read, not a constant: V8
 * cannot hoist it out of a loop and every single access pays for the
 * indirection. Measured in this file with a 152 064-element scan, reading a
 * 25-byte lookup table through the import cost 3.09 ms and reading the exact
 * same object through a module-local const cost 0.21 ms. Fifteen times.
 *
 * Everything the per-voxel loops touch is therefore aliased once here. These
 * are the same objects, not copies, so a table stays authoritative.
 * ------------------------------------------------------------------------ */

const LIGHT_OF = BLOCK_LIGHT;
const RENDER_FACE = shouldRenderFace;
const LAYER_OF = BLOCK_LAYER;

/* ------------------------------------------------------------------------ *
 * Padded neighbourhood
 * ------------------------------------------------------------------------ */

/**
 * Horizontal skirt, in blocks, around the chunk being meshed.
 *
 * Face culling and AO only ever need 1. This is 8 because of the light field
 * below: light loses `LIGHT_ATTEN` per block, so a source can reach at most
 * `LIGHT_REACH` blocks, and PAD_R > LIGHT_REACH means every source that could
 * possibly light a voxel of this chunk is already inside the neighbourhood.
 * That is what makes the baked lighting seam-free without a persistent
 * world-space light volume — and 8 still only reads into the eight immediate
 * neighbour chunks, which `hasAllNeighbours` already guarantees are loaded.
 */
export const PAD_R = 8;

/** Padded neighbourhood dimensions: the chunk plus PAD_R on x/z and 1 on y. */
export const PAD_X = CHUNK_SIZE_X + PAD_R * 2;   // 48
export const PAD_Y = CHUNK_HEIGHT + 2;           // 66
export const PAD_Z = CHUNK_SIZE_Z + PAD_R * 2;   // 48
export const PAD_XZ = PAD_X * PAD_Z;             // 2304
export const PAD_VOLUME = PAD_XZ * PAD_Y;        // 152064

/** Strides of the padded array, per axis (0 = x, 1 = y, 2 = z). */
const PAD_STRIDE_X = 1;
const PAD_STRIDE_Y = PAD_XZ;
const PAD_STRIDE_Z = PAD_X;
/** Index of chunk-local (0,0,0) inside the padded array. */
const PAD_ORIGIN = PAD_R * PAD_STRIDE_X + PAD_STRIDE_Y + PAD_R * PAD_STRIDE_Z;

/**
 * Index into a padded neighbourhood. Accepts chunk-local coordinates in
 * [-PAD_R, 32 + PAD_R) for x/z and [-1, 64] for y.
 */
export function padIndex(x: number, y: number, z: number): number {
  return (x + PAD_R) + (z + PAD_R) * PAD_X + (y + 1) * PAD_XZ;
}

/** Allocate a padded neighbourhood buffer. Callers should keep and reuse one. */
export function createPadded(): Uint8Array {
  return new Uint8Array(PAD_VOLUME);
}

/** Fetches the raw 65536-byte voxel array of a chunk, or null when unknown. */
export type ChunkFetch = (cx: number, cz: number) => Uint8Array | null;

/**
 * Fill `pad` with chunk (cx,cz) and the one-voxel skirt taken from its eight
 * horizontal neighbours. Unknown neighbours become air, which means the chunk
 * meshes with a wall on that side and must be re-meshed when the neighbour
 * lands — ChunkRenderer does that automatically.
 *
 * `floorBlock` fills the y = -1 plane. Bedrock (opaque) by default so the world
 * never emits a downward-facing skin under its own floor. Pass BlockId.AIR when
 * you want the bottom faces, which the unit tests do.
 */
export function buildPadded(
  pad: Uint8Array,
  cx: number,
  cz: number,
  fetch: ChunkFetch,
  floorBlock: number = BlockId.BEDROCK,
): boolean {
  const centre = fetch(cx, cz);
  pad.fill(0);
  // y = -1 plane is the contiguous first slab of the padded array.
  if (floorBlock !== 0) pad.fill(floorBlock, 0, PAD_XZ);
  if (centre === null) return false;

  // One rectangle per member of the 3x3 chunk block, clipped to the pad. PAD_R
  // is under one chunk wide, so the ring is exactly the eight neighbours.
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const src = dx === 0 && dz === 0 ? centre : fetch(cx + dx, cz + dz);
      if (src === null) continue;
      copyChunkRect(pad, src, dx * CHUNK_SIZE_X, dz * CHUNK_SIZE_Z);
    }
  }
  return true;
}

/**
 * Copy the part of one chunk that falls inside the pad. `(offX, offZ)` is that
 * chunk's origin in the centre chunk's local coordinates.
 */
function copyChunkRect(pad: Uint8Array, src: Uint8Array, offX: number, offZ: number): void {
  const lx0 = offX < -PAD_R ? -PAD_R : offX;
  const lx1 = offX + CHUNK_SIZE_X > CHUNK_SIZE_X + PAD_R ? CHUNK_SIZE_X + PAD_R : offX + CHUNK_SIZE_X;
  if (lx0 >= lx1) return;
  const lz0 = offZ < -PAD_R ? -PAD_R : offZ;
  const lz1 = offZ + CHUNK_SIZE_Z > CHUNK_SIZE_Z + PAD_R ? CHUNK_SIZE_Z + PAD_R : offZ + CHUNK_SIZE_Z;
  if (lz0 >= lz1) return;

  const run = lx1 - lx0;
  for (let y = 0; y < CHUNK_HEIGHT; y++) {
    const srcY = y << 10;
    const dstY = PAD_ORIGIN + y * PAD_STRIDE_Y;
    for (let lz = lz0; lz < lz1; lz++) {
      let s = srcY + ((lz - offZ) << 5) + (lx0 - offX);
      let d = dstY + lz * PAD_STRIDE_Z + lx0;
      for (let k = 0; k < run; k++) pad[d++] = src[s++];
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Vertex format
 * ------------------------------------------------------------------------ */

export const VERTEX_STRIDE = 12;
/** uint8x4 (x, y, z, face) — position is NOT normalized. */
export const VA_POSFACE_OFFSET = 0;
/** uint8x4 (ao, light, alpha, flags) — NOT normalized. */
export const VA_DATA_OFFSET = 4;
/** uint8x4 (r, g, b, 255) — normalized. */
export const VA_COLOR_OFFSET = 8;
export const VERTS_PER_QUAD = 4;
export const INDICES_PER_QUAD = 6;

/** Vertex flag: this face belongs to a liquid; the water shader ripples it. */
export const VF_LIQUID = 1 << 0;
/** Vertex flag: the source block emits light. */
export const VF_EMISSIVE = 1 << 1;

/* ------------------------------------------------------------------------ *
 * Light field constants
 * ------------------------------------------------------------------------ */

/** Brightest light level. Both channels share the range so both pack in 4 bits. */
export const LIGHT_MAX = 15;
/**
 * Block light lost per voxel step. 2 gives a level-15 source a 7-block reach,
 * which is one arena bay: stand in a doorway of a lava-lit keep and the light
 * dies just short of the far wall. 1 would flood the whole chunk and cost the
 * greedy mesher its merges; 3 makes lava a rim light on its own pit and nothing
 * more, which is what the old one-voxel spill already looked like.
 */
export const LIGHT_ATTEN = 2;
/** Blocks a full-strength source reaches. PAD_R must be >= this. */
export const LIGHT_REACH = (LIGHT_MAX - 1) / LIGHT_ATTEN;   // 7

/** Hue classes a light can carry. Indexes `uLightHue[]` in material.ts. */
export const LIGHT_HUE_COUNT = 3;
/** 0 = fire (lava, hellstone). */
export const LIGHT_HUE_FIRE = 0;
/** 1 = toxic green (neon, slime). */
export const LIGHT_HUE_TOXIC = 1;
/** 2 = cold instrument blue (tech panel). */
export const LIGHT_HUE_COLD = 2;

/**
 * False on purpose. The mesher writes `BLOCK_FACE_COLOR` (unshaded); the shader
 * multiplies by the face-shade ramp exactly once. Do not apply FACE_SHADE to
 * anything that consumes these buffers.
 */
export const MESHER_APPLIES_FACE_SHADE = false;

/* ------------------------------------------------------------------------ *
 * Derived lookup tables
 * ------------------------------------------------------------------------ */

/**
 * Whether a block casts ambient occlusion. Solid but see-through blocks (glass,
 * ice, slime) must not, or every window sits in a dark socket.
 */
const AO_OCCLUDES = new Uint8Array(BLOCK_COUNT);
/**
 * Whether a block stops sunlight. Opaque blocks obviously do; liquids do too,
 * because a lava lake with a lit floor under it reads as a glowing sheet of
 * glass and the seabed under water should be the darkest place on the map.
 */
const SKY_BLOCKS = new Uint8Array(BLOCK_COUNT);
/** Whether block light may pass. Same test as face culling uses for opacity. */
const LIGHT_PASSES = new Uint8Array(BLOCK_COUNT);
/** Hue class of the light a block emits, valid when BLOCK_LIGHT[id] > 0. */
const LIGHT_HUE = new Uint8Array(BLOCK_COUNT);
/** Colour channels split out so the inner loop never re-shifts a packed int. */
const COLOR_R = new Uint8Array(BLOCK_COUNT * 6);
const COLOR_G = new Uint8Array(BLOCK_COUNT * 6);
const COLOR_B = new Uint8Array(BLOCK_COUNT * 6);
const ALPHA_BYTE = new Uint8Array(BLOCK_COUNT);
const FLAG_BYTE = new Uint8Array(BLOCK_COUNT);

for (let id = 0; id < BLOCK_COUNT; id++) {
  AO_OCCLUDES[id] = (BLOCK_SOLID[id] === 1 && BLOCK_LAYER[id] !== RenderLayer.TRANSPARENT) ? 1 : 0;
  SKY_BLOCKS[id] = (BLOCK_OPAQUE[id] === 1 || BLOCK_LIQUID[id] === 1) ? 1 : 0;
  LIGHT_PASSES[id] = BLOCK_OPAQUE[id] === 1 ? 0 : 1;
  LIGHT_HUE[id] = LIGHT_HUE_FIRE;
  for (let f = 0; f < 6; f++) {
    const c = BLOCK_FACE_COLOR[id * 6 + f];
    COLOR_R[id * 6 + f] = (c >>> 16) & 0xff;
    COLOR_G[id * 6 + f] = (c >>> 8) & 0xff;
    COLOR_B[id * 6 + f] = c & 0xff;
  }
  const a = Math.round(BLOCK_ALPHA[id] * 255);
  ALPHA_BYTE[id] = a < 0 ? 0 : a > 255 ? 255 : a;
  let flags = 0;
  if (BLOCK_LIQUID[id] === 1) flags |= VF_LIQUID;
  if (BLOCK_LIGHT[id] > 0) flags |= VF_EMISSIVE;
  FLAG_BYTE[id] = flags;
}

LIGHT_HUE[BlockId.NEON] = LIGHT_HUE_TOXIC;
LIGHT_HUE[BlockId.SLIME] = LIGHT_HUE_TOXIC;
LIGHT_HUE[BlockId.TECH_PANEL] = LIGHT_HUE_COLD;

/* ------------------------------------------------------------------------ *
 * Scratch
 * ------------------------------------------------------------------------ */

/** Largest (u,v) slice is 64 x 32. */
const MASK_CAPACITY = CHUNK_HEIGHT * CHUNK_SIZE_X;
const maskPos = new Int32Array(MASK_CAPACITY);
const maskNeg = new Int32Array(MASK_CAPACITY);

const AXIS_DIM = [CHUNK_SIZE_X, CHUNK_HEIGHT, CHUNK_SIZE_Z];
const AXIS_STRIDE = [PAD_STRIDE_X, PAD_STRIDE_Y, PAD_STRIDE_Z];

/** Four corners x (x,y,z) of the quad currently being emitted. */
const quadCorners = new Int32Array(12);
const coordScratch = new Int32Array(3);

class LayerScratch {
  readonly layer: number;
  quadCap = 0;
  quadCount = 0;
  bytes: Uint8Array;
  indices: Uint32Array;

  constructor(layer: number) {
    this.layer = layer;
    this.bytes = new Uint8Array(0);
    this.indices = new Uint32Array(0);
    this.grow(2048);
  }

  private grow(cap: number): void {
    const bytes = new Uint8Array(cap * VERTS_PER_QUAD * VERTEX_STRIDE);
    const indices = new Uint32Array(cap * INDICES_PER_QUAD);
    if (this.quadCap > 0) {
      bytes.set(this.bytes);
      indices.set(this.indices);
    }
    this.bytes = bytes;
    this.indices = indices;
    this.quadCap = cap;
  }

  ensureRoom(): void {
    if (this.quadCount >= this.quadCap) this.grow(this.quadCap * 2);
  }

  reset(): void {
    this.quadCount = 0;
  }
}

const layerScratch: LayerScratch[] = [];
for (let i = 0; i < RENDER_LAYER_COUNT; i++) layerScratch.push(new LayerScratch(i));

/* ------------------------------------------------------------------------ *
 * Result
 * ------------------------------------------------------------------------ */

export interface MeshLayerResult {
  readonly layer: number;
  quadCount: number;
  vertexCount: number;
  indexCount: number;
  /** Interleaved vertex bytes. View into scratch — valid until the next meshChunk(). */
  vertexBytes: Uint8Array;
  /** View into scratch — valid until the next meshChunk(). */
  indices: Uint32Array;
}

export interface ChunkMeshResult {
  /** Always RENDER_LAYER_COUNT entries, indexed by RenderLayer. */
  readonly layers: MeshLayerResult[];
  totalQuads: number;
  /** Tight vertical bounds of the emitted geometry; 0/0 when empty. */
  minY: number;
  maxY: number;
  empty: boolean;
}

const result: ChunkMeshResult = {
  layers: [
    { layer: 0, quadCount: 0, vertexCount: 0, indexCount: 0, vertexBytes: new Uint8Array(0), indices: new Uint32Array(0) },
    { layer: 1, quadCount: 0, vertexCount: 0, indexCount: 0, vertexBytes: new Uint8Array(0), indices: new Uint32Array(0) },
    { layer: 2, quadCount: 0, vertexCount: 0, indexCount: 0, vertexBytes: new Uint8Array(0), indices: new Uint32Array(0) },
  ],
  totalQuads: 0,
  minY: 0,
  maxY: 0,
  empty: true,
};

/* ------------------------------------------------------------------------ *
 * Light fields
 *
 * Two Uint8Arrays the size of the padded neighbourhood, rebuilt per mesh. They
 * are the reason a roofed room is dark and a lava pit is not, and between them
 * they cost ~300 KB of worker-resident scratch and one linear pass each.
 * ------------------------------------------------------------------------ */

/** Block light: level 0..15 in bits 0..3, hue class in bits 4..5. */
const lightField = new Uint8Array(PAD_VOLUME);
/** Sky exposure, 0..15. No hue: the sun has exactly one colour. */
const skyField = new Uint8Array(PAD_VOLUME);
/**
 * Label-correcting FIFO of pad indices for the block-light flood.
 *
 * Sized at one slot per voxel, which is far more than the flood ever needs
 * (a source reaches at most (2 * LIGHT_REACH + 1)^3 = 3375 cells) but makes the
 * bound unarguable: the ring is checked for space before every push and a push
 * that will not fit is dropped rather than wrapping over live entries, so a
 * pathological lava sea degrades its own light and never corrupts a mesh.
 */
const lightQueue = new Int32Array(PAD_VOLUME);

/**
 * Sky exposure: a straight-down occlusion scan per column, then a bounded
 * horizontal bleed so the field is a RAMP and not a switch.
 *
 * WHY THE BLEED EXISTS. The column test alone answers "is anything directly
 * overhead", and in this world that is true far more often than "indoors" is:
 * the generator puts a crag on a 12-block lattice, a bastion pair on a 24-block
 * one and an arch through half of those, so a histogram over 16 real chunks put
 * 40% of all emitted quads at sky 0. Every one of them was drawn at the
 * interior key. The outdoors was therefore rendered as murky as the indoors,
 * and the whole "dark room, bright doorway" contrast the interior split exists
 * to buy was being spent on open ground standing under an overhang.
 *
 * THE SWEEP. Two chamfer passes over the scan box, both descending in y so
 * downward flow composes inside a single pass:
 *
 *   forward   y desc, z asc,  x asc   <- takes -x, -z and above
 *   backward  y desc, z desc, x desc  <- takes +x, +z and above
 *
 * Horizontal steps cost SKY_BLEED_ATTEN, a downward step costs
 * SKY_BLEED_DROP. Two passes resolve every straight and single-turn path, which
 * is all a doorway or an arch needs; a labyrinth would need more and would look
 * the same, because at atten 3 the light is gone after five steps anyway.
 *
 * WHY IT IS SEAM-EXACT, which is the only hard constraint here. A face reads
 * `skyField[air]` for `air` inside the chunk plus one voxel. Light dies at
 * `ceil(LIGHT_MAX / SKY_BLEED_ATTEN)` = 5 steps, so a source further than 5
 * cells from such a cell contributes exactly nothing. Sweeping the box out to
 * `SKY_SCAN_PAD` = 6 therefore makes every value a face can read independent of
 * where the box ends — chunk (7, -3) computes the same number for a shared face
 * as chunk (8, -3) does, with no cross-chunk state. PAD_R is 8, so the column
 * scan has real voxels everywhere the sweep reads.
 */
const SKY_SCAN_PAD = 6;
/** Sky lost per horizontal step. 3 puts the reach at 5 blocks. */
const SKY_BLEED_ATTEN = 3;
/**
 * Sky lost per downward step of BLED light. Not zero: without it, light that
 * gets one block through a doorway falls to the bottom of a shaft undimmed and
 * a cellar under a lit room is as bright as the room. Straight-down light under
 * open sky is unaffected — the column pass already wrote 15 there and the sweep
 * only ever raises a value.
 */
const SKY_BLEED_DROP = 1;

function buildSkyField(pad: Uint8Array): void {
  skyField.fill(0);
  const lo = -SKY_SCAN_PAD;
  const hi = CHUNK_SIZE_X + SKY_SCAN_PAD;
  const hiZ = CHUNK_SIZE_Z + SKY_SCAN_PAD;
  const top = CHUNK_HEIGHT;                     // the pad's y = 64 plane

  // Pass 1 — the column scan. Also records the y band that actually has an open
  // but unlit cell in it, because that is the only band the bleed can change and
  // on an open-sky chunk it is empty and the sweep is skipped outright.
  let darkLo = top + 1;
  let darkHi = -2;
  for (let z = lo; z < hiZ; z++) {
    for (let x = lo; x < hi; x++) {
      let i = padIndex(x, top, z);
      let y = top;
      for (; y >= -1; y--, i -= PAD_STRIDE_Y) {
        if (SKY_BLOCKS[pad[i]] === 1) break;
        skyField[i] = LIGHT_MAX;
      }
      // Everything from here down is sky 0. Find the open cells among it.
      for (; y >= -1; y--, i -= PAD_STRIDE_Y) {
        if (LIGHT_PASSES[pad[i]] === 0) continue;
        if (y > darkHi) darkHi = y;
        if (y < darkLo) darkLo = y;
      }
    }
  }
  if (darkHi < darkLo) return;                  // nothing roofed anywhere

  // Pass 2 — the sweep. Bounded to the dark band plus one level above it, which
  // is where the light it reads comes from.
  const yTop = darkHi + 1 > top ? top : darkHi + 1;
  const yBot = darkLo;
  const A = SKY_BLEED_ATTEN;
  const D = SKY_BLEED_DROP;

  for (let y = yTop; y >= yBot; y--) {
    // At the very top plane there is no cell above to read; offset 0 reads self,
    // which after the -D can never win, so the inner loop stays branchless.
    const up = y < top ? PAD_STRIDE_Y : 0;
    for (let z = lo; z < hiZ; z++) {
      let i = padIndex(lo, y, z);
      for (let x = lo; x < hi; x++, i += PAD_STRIDE_X) {
        if (LIGHT_PASSES[pad[i]] === 0) continue;
        let v = skyField[i];
        if (v === LIGHT_MAX) continue;
        const above = skyField[i + up] - D;
        if (above > v) v = above;
        if (x > lo) { const a = skyField[i - PAD_STRIDE_X] - A; if (a > v) v = a; }
        if (z > lo) { const b = skyField[i - PAD_STRIDE_Z] - A; if (b > v) v = b; }
        skyField[i] = v;
      }
    }
  }
  for (let y = yTop; y >= yBot; y--) {
    const up = y < top ? PAD_STRIDE_Y : 0;
    for (let z = hiZ - 1; z >= lo; z--) {
      let i = padIndex(hi - 1, y, z);
      for (let x = hi - 1; x >= lo; x--, i -= PAD_STRIDE_X) {
        if (LIGHT_PASSES[pad[i]] === 0) continue;
        let v = skyField[i];
        if (v === LIGHT_MAX) continue;
        const above = skyField[i + up] - D;
        if (above > v) v = above;
        if (x < hi - 1) { const a = skyField[i + PAD_STRIDE_X] - A; if (a > v) v = a; }
        if (z < hiZ - 1) { const b = skyField[i + PAD_STRIDE_Z] - A; if (b > v) v = b; }
        skyField[i] = v;
      }
    }
  }
}

/**
 * Block light by flood fill from every emissive voxel in the neighbourhood.
 *
 * Returns false when there is nothing emissive anywhere in range, which is the
 * common case (an OUTLAND chunk has no emitters at all) and skips the flood
 * entirely. The emitter scan itself is one linear pass with a single table
 * lookup per voxel.
 */
/** True when `lightField` holds this chunk's flood rather than a stale one. */
let lightActive = false;

/** Ring state, at module scope so `spill` needs no closure. */
let qHead = 0;
let qTail = 0;
let qCount = 0;
/** The pad currently being flooded. Set for the duration of buildLightField. */
let litPad: Uint8Array = lightField;

function push(i: number): void {
  const cap = lightQueue.length;
  if (qCount === cap) return;                   // ring full: drop, never wrap
  lightQueue[qTail] = i;
  qTail = qTail + 1 === cap ? 0 : qTail + 1;
  qCount++;
}

/** Try to raise neighbour `n` to `next`; enqueue it when that succeeds. */
function spill(n: number, next: number, hue: number): void {
  if (LIGHT_PASSES[litPad[n]] === 0) return;
  if ((lightField[n] & 15) >= next) return;
  lightField[n] = next | hue;
  push(n);
}

function buildLightField(pad: Uint8Array): boolean {
  qHead = 0; qTail = 0; qCount = 0;
  const cap = lightQueue.length;

  // Pass 1 — collect only the emitters that can actually light something else,
  // and bail before touching 152 KB of scratch when there are none. Two prunes,
  // both worth several milliseconds a chunk on this palette:
  //
  //  * `lv <= LIGHT_ATTEN` can never reach even one voxel away, so it never
  //    needs to be in the flood. That retires every TECH_PANEL (2) and SLIME
  //    (1) in the world — and the whole TECH biome is floored in tech panel, so
  //    without this the cheapest possible light floods the largest area.
  //  * An opaque emitter walled in on all six sides lights nothing but its own
  //    faces, and `faceKey` already covers those from `BLOCK_LIGHT` directly.
  //    HELLSTONE is three strata deep across the HELL biome, so this turns a
  //    solid volume of seeds into a surface.
  //
  // The scan runs from the second y slab to the second-last so all six
  // neighbour reads are in bounds. That is not tidiness: a single out-of-range
  // typed-array read anywhere in this loop makes V8 deoptimise every array
  // access in the function, and measured, that alone was 2.2 ms of the 2.4 ms
  // this pass used to cost — fifteen times the cost of the flood it feeds.
  // Emitters in the two boundary slabs (y = -1, y = 64) are seeded unchecked;
  // there are none in practice and an extra seed is free.
  //
  // Pad wrap is deliberately NOT guarded here. A wrap can only change whether
  // an emitter at the extreme edge of the neighbourhood gets seeded, which is
  // 8 blocks outside the chunk and past every face this mesh will emit. The
  // flood itself IS guarded, because there a wrap teleports light across the
  // whole pad.
  const scanEnd = PAD_VOLUME - PAD_XZ;
  for (let i = 0; i < PAD_XZ; i++) {
    if (LIGHT_OF[pad[i]] > LIGHT_ATTEN) { lightQueue[qTail++] = i; qCount++; }
  }
  for (let i = PAD_XZ; i < scanEnd; i++) {
    const id = pad[i];
    if (LIGHT_OF[id] <= LIGHT_ATTEN) continue;
    if (LIGHT_PASSES[id] === 0
      && LIGHT_PASSES[pad[i - 1]] === 0
      && LIGHT_PASSES[pad[i + 1]] === 0
      && LIGHT_PASSES[pad[i - PAD_X]] === 0
      && LIGHT_PASSES[pad[i + PAD_X]] === 0
      && LIGHT_PASSES[pad[i - PAD_XZ]] === 0
      && LIGHT_PASSES[pad[i + PAD_XZ]] === 0) continue;
    if (qCount === cap) break;
    lightQueue[qTail++] = i;
    qCount++;
  }
  for (let i = scanEnd; i < PAD_VOLUME; i++) {
    if (LIGHT_OF[pad[i]] > LIGHT_ATTEN && qCount < cap) {
      lightQueue[qTail++] = i;
      qCount++;
    }
  }
  if (qCount === 0) return false;

  lightField.fill(0);
  litPad = pad;
  for (let k = 0; k < qCount; k++) {
    const i = lightQueue[k];
    const id = pad[i];
    lightField[i] = LIGHT_OF[id] | (LIGHT_HUE[id] << 4);
  }

  // Label-correcting flood: a cell reached first by a weak source is re-pushed
  // when a stronger one arrives, which is why the seeds do not have to be
  // sorted by level. Uniform edge cost keeps the number of corrections tiny.
  //
  // The six steps are guarded by the cell's own pad coordinates rather than by
  // an index range, because +/-1 on x and +/-PAD_X on z WRAP into the next row
  // and the next slab. An unguarded wrap teleports a lava pool to the opposite
  // edge of the neighbourhood and lights a wall eight chunks of nothing away.
  while (qCount > 0) {
    const i = lightQueue[qHead];
    qHead = qHead + 1 === cap ? 0 : qHead + 1;
    qCount--;

      const v = lightField[i];
    const next = (v & 15) - LIGHT_ATTEN;
    if (next <= 0) continue;
    const hue = v & 0x30;

    const iy = (i / PAD_XZ) | 0;
    const r = i - iy * PAD_XZ;
    const iz = (r / PAD_X) | 0;
    const ix = r - iz * PAD_X;

    if (ix > 0) spill(i - 1, next, hue);
    if (ix < PAD_X - 1) spill(i + 1, next, hue);
    if (iz > 0) spill(i - PAD_X, next, hue);
    if (iz < PAD_Z - 1) spill(i + PAD_X, next, hue);
    if (iy > 0) spill(i - PAD_XZ, next, hue);
    if (iy < PAD_Y - 1) spill(i + PAD_XZ, next, hue);
  }
  return true;
}

/* ------------------------------------------------------------------------ *
 * Ambient occlusion
 * ------------------------------------------------------------------------ */

/**
 * The standard three-sample corner term. Two solid sides fully close the corner
 * regardless of the diagonal, which is what makes interior corners read as
 * corners rather than as a smooth gradient.
 */
function vertexAO(side1: number, side2: number, corner: number): number {
  if (side1 !== 0 && side2 !== 0) return 0;
  return 3 - (side1 + side2 + corner);
}

/* ------------------------------------------------------------------------ *
 * Emit
 * ------------------------------------------------------------------------ */

let emitMinY = 0;
let emitMaxY = 0;

/** Reused AO tuple; a fresh [a,b,c,d] per quad would be an allocation per quad. */
const aoTuple = new Int32Array(4);

function emitQuad(
  sc: LayerScratch,
  face: number,
  ao0: number, ao1: number, ao2: number, ao3: number,
  light: number, alpha: number, flags: number,
  r: number, g: number, b: number,
  sky: number, reversed: boolean,
): void {
  sc.ensureRoom();
  const q = sc.quadCount;
  const bytes = sc.bytes;
  const idx = sc.indices;

  let o = q * VERTS_PER_QUAD * VERTEX_STRIDE;
  aoTuple[0] = ao0; aoTuple[1] = ao1; aoTuple[2] = ao2; aoTuple[3] = ao3;
  for (let c = 0; c < 4; c++) {
    const cx = quadCorners[c * 3 + 0];
    const cy = quadCorners[c * 3 + 1];
    const cz = quadCorners[c * 3 + 2];
    if (cy < emitMinY) emitMinY = cy;
    if (cy > emitMaxY) emitMaxY = cy;
    bytes[o + 0] = cx;
    bytes[o + 1] = cy;
    bytes[o + 2] = cz;
    bytes[o + 3] = face;
    bytes[o + 4] = aoTuple[c];
    bytes[o + 5] = light;
    bytes[o + 6] = alpha;
    bytes[o + 7] = flags;
    bytes[o + 8] = r;
    bytes[o + 9] = g;
    bytes[o + 10] = b;
    bytes[o + 11] = sky;
    o += VERTEX_STRIDE;
  }

  // Anisotropy flip: when the two corners on the default diagonal are brighter
  // than the other two, triangulating along that diagonal bends the shading and
  // leaves a visible crease across the quad. Swap to the other diagonal.
  const flip = (ao0 + ao2) > (ao1 + ao3);
  const v = q * VERTS_PER_QUAD;
  const i = q * INDICES_PER_QUAD;
  if (reversed) {
    if (flip) {
      idx[i] = v + 1; idx[i + 1] = v + 3; idx[i + 2] = v + 2;
      idx[i + 3] = v + 1; idx[i + 4] = v + 0; idx[i + 5] = v + 3;
    } else {
      idx[i] = v + 0; idx[i + 1] = v + 2; idx[i + 2] = v + 1;
      idx[i + 3] = v + 0; idx[i + 4] = v + 3; idx[i + 5] = v + 2;
    }
  } else if (flip) {
    idx[i] = v + 1; idx[i + 1] = v + 2; idx[i + 2] = v + 3;
    idx[i + 3] = v + 1; idx[i + 4] = v + 3; idx[i + 5] = v + 0;
  } else {
    idx[i] = v + 0; idx[i + 1] = v + 1; idx[i + 2] = v + 2;
    idx[i + 3] = v + 0; idx[i + 4] = v + 2; idx[i + 5] = v + 3;
  }
  sc.quadCount = q + 1;
}

/* ------------------------------------------------------------------------ *
 * The mesher
 * ------------------------------------------------------------------------ */

/**
 * Greedy-mesh one padded neighbourhood.
 *
 * The returned object and every typed array inside it are module scratch: read
 * or copy them before calling `meshChunk` again.
 */
export function meshChunk(pad: Uint8Array): ChunkMeshResult {
  for (let i = 0; i < RENDER_LAYER_COUNT; i++) layerScratch[i].reset();
  emitMinY = CHUNK_HEIGHT;
  emitMaxY = 0;

  buildSkyField(pad);
  // False leaves `lightField` holding the previous chunk's flood, so the flag —
  // not the array — is what says whether a face may read it.
  lightActive = buildLightField(pad);

  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const sd = AXIS_STRIDE[d];
    const su = AXIS_STRIDE[u];
    const sv = AXIS_STRIDE[v];
    const dimD = AXIS_DIM[d];
    const dimU = AXIS_DIM[u];
    const dimV = AXIS_DIM[v];

    for (let w = -1; w < dimD; w++) {
      const slabBase = PAD_ORIGIN + w * sd;

      // ---- build both masks for this slice ---------------------------------
      let n = 0;
      for (let j = 0; j < dimV; j++) {
        let ia = slabBase + j * sv;
        for (let i = 0; i < dimU; i++, ia += su, n++) {
          const a = pad[ia];
          const ib = ia + sd;
          const b = pad[ib];
          if (a === b) { maskPos[n] = 0; maskNeg[n] = 0; continue; }

          if (RENDER_FACE(a, b)) {
            maskPos[n] = faceKey(pad, a, ib, su, sv);
          } else {
            maskPos[n] = 0;
          }
          if (RENDER_FACE(b, a)) {
            maskNeg[n] = faceKey(pad, b, ia, su, sv);
          } else {
            maskNeg[n] = 0;
          }
        }
      }

      mergeAndEmit(maskPos, dimU, dimV, d, u, v, w + 1, d * 2, false);
      mergeAndEmit(maskNeg, dimU, dimV, d, u, v, w + 1, d * 2 + 1, true);
    }
  }

  let total = 0;
  for (let i = 0; i < RENDER_LAYER_COUNT; i++) {
    const sc = layerScratch[i];
    const out = result.layers[i];
    const verts = sc.quadCount * VERTS_PER_QUAD;
    out.quadCount = sc.quadCount;
    out.vertexCount = verts;
    out.indexCount = sc.quadCount * INDICES_PER_QUAD;
    out.vertexBytes = sc.bytes.subarray(0, verts * VERTEX_STRIDE);
    out.indices = sc.indices.subarray(0, sc.quadCount * INDICES_PER_QUAD);
    total += sc.quadCount;
  }
  result.totalQuads = total;
  result.empty = total === 0;
  result.minY = total === 0 ? 0 : emitMinY;
  result.maxY = total === 0 ? 0 : emitMaxY;
  return result;
}

/**
 * Pack everything a merged quad needs into one int so the greedy pass can merge
 * on strict equality: block id, four 2-bit AO terms, and both light channels.
 *
 *   bits  0..7   blockId + 1   (0 means "no face here")
 *   bits  8..15  ao0..ao3, two bits each
 *   bits 16..19  block light 0..15
 *   bits 20..21  block light hue class
 *   bits 22..25  sky exposure 0..15
 *
 * Both light channels are sampled at `air` — the voxel the face looks INTO —
 * which is the only place the answer can come from: the light inside a wall is
 * meaningless and the light one step further out belongs to the next face.
 */
function faceKey(pad: Uint8Array, id: number, air: number, su: number, sv: number): number {
  const nu = pad[air - su];
  const pu = pad[air + su];
  const nv = pad[air - sv];
  const pv = pad[air + sv];

  const oNU = AO_OCCLUDES[nu];
  const oPU = AO_OCCLUDES[pu];
  const oNV = AO_OCCLUDES[nv];
  const oPV = AO_OCCLUDES[pv];

  const ao0 = vertexAO(oNU, oNV, AO_OCCLUDES[pad[air - su - sv]]);
  const ao1 = vertexAO(oPU, oNV, AO_OCCLUDES[pad[air + su - sv]]);
  const ao2 = vertexAO(oPU, oPV, AO_OCCLUDES[pad[air + su + sv]]);
  const ao3 = vertexAO(oNU, oPV, AO_OCCLUDES[pad[air - su + sv]]);

  // A block that emits always lights its own face, even when the flood could
  // not reach the air in front of it (a lava voxel sealed in rock still glows
  // where it is exposed).
  let light = lightActive ? lightField[air] & 15 : 0;
  let hue = lightActive ? (lightField[air] >> 4) & 3 : 0;
  const own = LIGHT_OF[id];
  if (own > light) { light = own; hue = LIGHT_HUE[id]; }

  return (id + 1)
    | (ao0 << 8) | (ao1 << 10) | (ao2 << 12) | (ao3 << 14)
    | (light << 16) | (hue << 20) | (skyField[air] << 22);
}

function mergeAndEmit(
  mask: Int32Array,
  dimU: number, dimV: number,
  d: number, u: number, v: number,
  plane: number, face: number, reversed: boolean,
): void {
  for (let j = 0; j < dimV; j++) {
    const row = j * dimU;
    for (let i = 0; i < dimU;) {
      const key = mask[row + i];
      if (key === 0) { i++; continue; }

      // Run along u.
      let qw = 1;
      while (i + qw < dimU && mask[row + i + qw] === key) qw++;

      // Extend along v while the whole run matches.
      let qh = 1;
      grow: while (j + qh < dimV) {
        const r2 = (j + qh) * dimU + i;
        for (let k = 0; k < qw; k++) {
          if (mask[r2 + k] !== key) break grow;
        }
        qh++;
      }

      const id = (key & 0xff) - 1;
      const ao0 = (key >>> 8) & 3;
      const ao1 = (key >>> 10) & 3;
      const ao2 = (key >>> 12) & 3;
      const ao3 = (key >>> 14) & 3;
      // Level and hue travel in one byte; the shader splits them with a mod.
      const light = ((key >>> 16) & 15) | (((key >>> 20) & 3) << 4);
      // 0..15 spread over the full byte so the normalized attribute lands on
      // exactly 0.0 and exactly 1.0 at the ends.
      const sky = ((key >>> 22) & 15) * 17;

      setCorner(0, d, u, v, plane, i, j);
      setCorner(1, d, u, v, plane, i + qw, j);
      setCorner(2, d, u, v, plane, i + qw, j + qh);
      setCorner(3, d, u, v, plane, i, j + qh);

      const cbase = id * 6 + face;
      emitQuad(
        layerScratch[LAYER_OF[id]],
        face, ao0, ao1, ao2, ao3,
        light, ALPHA_BYTE[id], FLAG_BYTE[id],
        COLOR_R[cbase], COLOR_G[cbase], COLOR_B[cbase],
        sky, reversed,
      );

      for (let jj = 0; jj < qh; jj++) {
        const r2 = (j + jj) * dimU + i;
        for (let ii = 0; ii < qw; ii++) mask[r2 + ii] = 0;
      }
      i += qw;
    }
  }
}

function setCorner(c: number, d: number, u: number, v: number, pd: number, pu: number, pv: number): void {
  coordScratch[d] = pd;
  coordScratch[u] = pu;
  coordScratch[v] = pv;
  quadCorners[c * 3 + 0] = coordScratch[0];
  quadCorners[c * 3 + 1] = coordScratch[1];
  quadCorners[c * 3 + 2] = coordScratch[2];
}

/* ------------------------------------------------------------------------ *
 * Small readers used by tests and by debug tooling
 * ------------------------------------------------------------------------ */

/** Face index (0..5) of vertex `i` inside an interleaved vertex byte buffer. */
export function readVertexFace(bytes: Uint8Array, i: number): number {
  return bytes[i * VERTEX_STRIDE + 3];
}
/** Baked AO term (0..3) of vertex `i`. */
export function readVertexAO(bytes: Uint8Array, i: number): number {
  return bytes[i * VERTEX_STRIDE + 4];
}
/** Baked block-light level (0..15) of vertex `i`. */
export function readVertexLight(bytes: Uint8Array, i: number): number {
  return bytes[i * VERTEX_STRIDE + 5] & 15;
}
/** Block-light hue class (0..2) of vertex `i`. */
export function readVertexLightHue(bytes: Uint8Array, i: number): number {
  return (bytes[i * VERTEX_STRIDE + 5] >> 4) & 3;
}
/** Baked sky exposure (0..15) of vertex `i`. */
export function readVertexSky(bytes: Uint8Array, i: number): number {
  return Math.round(bytes[i * VERTEX_STRIDE + 11] / 17);
}
/** Chunk-local X of vertex `i`. */
export function readVertexX(bytes: Uint8Array, i: number): number {
  return bytes[i * VERTEX_STRIDE + 0];
}
/** Chunk-local Y of vertex `i`. */
export function readVertexY(bytes: Uint8Array, i: number): number {
  return bytes[i * VERTEX_STRIDE + 1];
}
/** Chunk-local Z of vertex `i`. */
export function readVertexZ(bytes: Uint8Array, i: number): number {
  return bytes[i * VERTEX_STRIDE + 2];
}

/* ------------------------------------------------------------------------ *
 * Worker protocol
 *
 * Declared here rather than in mesher.worker.ts so the main thread can import
 * the constants and the types without pulling the worker's `onmessage`
 * registration into the page bundle.
 * ------------------------------------------------------------------------ */

/** main -> worker: hand over a chunk's 65536-byte voxel array (transferable). */
export const MSG_CHUNK = 1;
/** main -> worker: a single voxel changed, in WORLD block coordinates. */
export const MSG_EDIT = 2;
/** main -> worker: (re)mesh a chunk. */
export const MSG_MESH = 3;
/** main -> worker: forget a chunk. */
export const MSG_DROP = 4;
/** main -> worker: an output buffer the main thread is done with (transferable). */
export const MSG_RECYCLE = 5;
/** main -> worker: forget everything. */
export const MSG_CLEAR = 6;
/** worker -> main: a finished mesh. */
export const MSG_RESULT = 20;

export interface MeshResultLayer {
  layer: number;
  vertexCount: number;
  indexCount: number;
  /** Interleaved vertex bytes; byteLength may exceed vertexCount * VERTEX_STRIDE. */
  vertices: ArrayBuffer;
  /** Uint32 indices; byteLength may exceed indexCount * 4. */
  indices: ArrayBuffer;
}

export interface MeshResultMessage {
  t: typeof MSG_RESULT;
  cx: number;
  cz: number;
  job: number;
  minY: number;
  maxY: number;
  /** Only non-empty layers are present. */
  layers: MeshResultLayer[];
}

export type MesherRequest =
  | { t: typeof MSG_CHUNK; cx: number; cz: number; buf: ArrayBuffer }
  | { t: typeof MSG_EDIT; x: number; y: number; z: number; id: number }
  | { t: typeof MSG_MESH; cx: number; cz: number; job: number; floor: number }
  | { t: typeof MSG_DROP; cx: number; cz: number }
  | { t: typeof MSG_RECYCLE; buf: ArrayBuffer }
  | { t: typeof MSG_CLEAR };
