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
 *  2. Zero allocation after warmup. All scratch (masks, vertex bytes, indices)
 *     lives at module scope and is reused. `meshChunk()` returns views into that
 *     scratch; they are valid only until the next call. The worker copies them
 *     into exact-size transferables at the boundary — that is the only allocation.
 *
 * VERTEX FORMAT (12 bytes, three uint8x4 attributes, one interleaved buffer):
 *
 *     byte 0..2   position x,y,z   chunk-local integers 0..32 / 0..64  (NOT normalized)
 *     byte 3      face             0..5, matches the shared `Face` enum
 *     byte 4      ao               0..3, 0 = fully occluded corner
 *     byte 5      light            0..15 emissive level (self or spilled from a neighbour)
 *     byte 6      alpha            block alpha * 255
 *     byte 7      flags            VF_LIQUID | VF_EMISSIVE
 *     byte 8..10  colour r,g,b     BLOCK_FACE_COLOR, UNSHADED  (normalized in GL)
 *     byte 11     255              padding / keeps the stride 4-byte aligned
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
/** Colour channels split out so the inner loop never re-shifts a packed int. */
const COLOR_R = new Uint8Array(BLOCK_COUNT * 6);
const COLOR_G = new Uint8Array(BLOCK_COUNT * 6);
const COLOR_B = new Uint8Array(BLOCK_COUNT * 6);
const ALPHA_BYTE = new Uint8Array(BLOCK_COUNT);
const FLAG_BYTE = new Uint8Array(BLOCK_COUNT);

for (let id = 0; id < BLOCK_COUNT; id++) {
  AO_OCCLUDES[id] = (BLOCK_SOLID[id] === 1 && BLOCK_LAYER[id] !== RenderLayer.TRANSPARENT) ? 1 : 0;
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
  reversed: boolean,
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
    bytes[o + 11] = 255;
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

          if (shouldRenderFace(a, b)) {
            maskPos[n] = faceKey(pad, a, ib, su, sv);
          } else {
            maskPos[n] = 0;
          }
          if (shouldRenderFace(b, a)) {
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
 * on strict equality: block id, four 2-bit AO terms, and a 4-bit light level.
 *
 *   bits  0..7   blockId + 1   (0 means "no face here")
 *   bits  8..15  ao0..ao3, two bits each
 *   bits 16..19  light 0..15
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

  // Emissive spill: a stone wall beside lava should glow. One-block reach only,
  // taken from the samples we already have in registers.
  let light = BLOCK_LIGHT[id];
  const la = BLOCK_LIGHT[pad[air]];
  if (la > light) light = la;
  const l1 = BLOCK_LIGHT[nu]; if (l1 > light) light = l1;
  const l2 = BLOCK_LIGHT[pu]; if (l2 > light) light = l2;
  const l3 = BLOCK_LIGHT[nv]; if (l3 > light) light = l3;
  const l4 = BLOCK_LIGHT[pv]; if (l4 > light) light = l4;

  return (id + 1) | (ao0 << 8) | (ao1 << 10) | (ao2 << 12) | (ao3 << 14) | (light << 16);
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
      const light = (key >>> 16) & 15;

      setCorner(0, d, u, v, plane, i, j);
      setCorner(1, d, u, v, plane, i + qw, j);
      setCorner(2, d, u, v, plane, i + qw, j + qh);
      setCorner(3, d, u, v, plane, i, j + qh);

      const cbase = id * 6 + face;
      emitQuad(
        layerScratch[BLOCK_LAYER[id]],
        face, ao0, ao1, ao2, ao3,
        light, ALPHA_BYTE[id], FLAG_BYTE[id],
        COLOR_R[cbase], COLOR_G[cbase], COLOR_B[cbase],
        reversed,
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
