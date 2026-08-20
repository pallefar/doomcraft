/**
 * DOOMCRAFT — block registry.
 *
 * The mesher touches these lookups millions of times per chunk, so every hot
 * query is a typed-array read indexed by block id. The `BLOCKS` object table is
 * authoring data only: build tooling, UI and worldgen may read it, the mesher
 * must not.
 *
 * Palette note: the bar (voxiom.io) renders flat, low-contrast faces — grass tops
 * and sand read as one mass at distance (ref/BAR.md weakness #4). Doomcraft keeps
 * the same untextured voxel look but pushes value separation between top / side /
 * bottom and adds a per-face shade ramp so silhouettes read in a firefight.
 */

/* ------------------------------------------------------------------------ *
 * Ids
 * ------------------------------------------------------------------------ */

export enum BlockId {
  AIR = 0,
  STONE = 1,
  DIRT = 2,
  GRASS = 3,
  SAND = 4,
  WATER = 5,
  WOOD = 6,
  LEAVES = 7,
  METAL = 8,
  LAVA = 9,
  GLASS = 10,
  BRICK = 11,
  PLANKS = 12,
  COBBLESTONE = 13,
  SNOW = 14,
  ICE = 15,
  OBSIDIAN = 16,
  GRAVEL = 17,
  RUSTED_METAL = 18,
  TECH_PANEL = 19,
  HELLSTONE = 20,
  BONE = 21,
  SLIME = 22,
  NEON = 23,
  BEDROCK = 24,
}

/** One past the highest valid id. All lookup arrays are exactly this long. */
export const BLOCK_COUNT = 25;

/* ------------------------------------------------------------------------ *
 * Faces
 * ------------------------------------------------------------------------ */

export enum Face {
  PX = 0, // +x  east
  NX = 1, // -x  west
  PY = 2, // +y  top
  NY = 3, // -y  bottom
  PZ = 4, // +z  south
  NZ = 5, // -z  north
}
export const FACE_COUNT = 6;

/** 3 int8 per face, in Face order. */
export const FACE_NORMALS: Int8Array = new Int8Array([
  1, 0, 0,
  -1, 0, 0,
  0, 1, 0,
  0, -1, 0,
  0, 0, 1,
  0, 0, -1,
]);

/** Directional shade multiplier applied to a face colour by the mesher. */
export const FACE_SHADE: Float32Array = new Float32Array([0.78, 0.78, 1.0, 0.5, 0.66, 0.66]);

export const FACE_OPPOSITE: Uint8Array = new Uint8Array([1, 0, 3, 2, 5, 4]);

/** Axis index (0=x, 1=y, 2=z) each face is perpendicular to. */
export const FACE_AXIS: Uint8Array = new Uint8Array([0, 0, 1, 1, 2, 2]);

/** Map an axis-aligned unit normal to a Face. Returns Face.PY for a zero normal. */
export function faceFromNormal(nx: number, ny: number, nz: number): number {
  if (nx > 0) return Face.PX;
  if (nx < 0) return Face.NX;
  if (ny > 0) return Face.PY;
  if (ny < 0) return Face.NY;
  if (nz > 0) return Face.PZ;
  if (nz < 0) return Face.NZ;
  return Face.PY;
}

/* ------------------------------------------------------------------------ *
 * Render layers — one draw call per chunk per layer
 * ------------------------------------------------------------------------ */

export enum RenderLayer {
  OPAQUE = 0,
  CUTOUT = 1,      // leaves: depth-write, alpha-test
  TRANSPARENT = 2, // water, glass, ice: sorted, no depth-write
}
export const RENDER_LAYER_COUNT = 3;

/* ------------------------------------------------------------------------ *
 * Flag bits (packed into BLOCK_FLAGS)
 * ------------------------------------------------------------------------ */

export const BF_SOLID = 1 << 0;        // blocks player movement
export const BF_OPAQUE = 1 << 1;       // fully hides the face behind it
export const BF_LIQUID = 1 << 2;       // swimmable volume
export const BF_EMISSIVE = 1 << 3;     // light > 0
export const BF_REPLACEABLE = 1 << 4;  // a placed block may overwrite it (air, water, lava)
export const BF_PLACEABLE = 1 << 5;    // may appear in the build palette
export const BF_DAMAGING = 1 << 6;     // hurts on contact
export const BF_BREAKABLE = 1 << 7;    // may be dug

/* ------------------------------------------------------------------------ *
 * Authoring table
 * ------------------------------------------------------------------------ */

export interface BlockDef {
  readonly id: number;
  readonly name: string;
  readonly solid: boolean;
  readonly opaque: boolean;
  readonly liquid: boolean;
  /** Relative dig time. 1.0 == BLOCK_BREAK_BASE_MS. -1 means unbreakable. */
  readonly hardness: number;
  /** Packed 0xRRGGBB. */
  readonly colorTop: number;
  readonly colorSide: number;
  readonly colorBottom: number;
  /** Emitted light level, 0..15. */
  readonly emissive: number;
  readonly layer: RenderLayer;
  /** 0..1, used only by CUTOUT / TRANSPARENT layers. */
  readonly alpha: number;
  /** Damage per second while the player AABB overlaps this block. */
  readonly damage: number;
  readonly replaceable: boolean;
  readonly placeable: boolean;
}

function def(
  id: number, name: string, solid: boolean, opaque: boolean, liquid: boolean,
  hardness: number, colorTop: number, colorSide: number, colorBottom: number,
  emissive: number, layer: RenderLayer, alpha: number, damage: number,
  replaceable: boolean, placeable: boolean,
): BlockDef {
  return { id, name, solid, opaque, liquid, hardness, colorTop, colorSide, colorBottom, emissive, layer, alpha, damage, replaceable, placeable };
}

const O = RenderLayer.OPAQUE;
const C = RenderLayer.CUTOUT;
const T = RenderLayer.TRANSPARENT;

/** Indexed by BlockId. Frozen at module load. */
export const BLOCKS: readonly BlockDef[] = Object.freeze([
  //   id                     name            solid  opaque liquid hard   top       side      bottom    emis layer a     dmg  repl   place
  def(BlockId.AIR,           'Air',           false, false, false, -1,    0x000000, 0x000000, 0x000000,  0,  O, 0.0,  0,   true,  false),
  def(BlockId.STONE,         'Stone',         true,  true,  false, 1.5,   0x8b8d92, 0x83858a, 0x76787d,  0,  O, 1.0,  0,   false, true),
  def(BlockId.DIRT,          'Dirt',          true,  true,  false, 0.6,   0x7a5230, 0x7a5230, 0x6d4a2b,  0,  O, 1.0,  0,   false, true),
  def(BlockId.GRASS,         'Grass',         true,  true,  false, 0.7,   0x74b449, 0x7a5230, 0x6d4a2b,  0,  O, 1.0,  0,   false, true),
  def(BlockId.SAND,          'Sand',          true,  true,  false, 0.5,   0xe6d5a0, 0xdfcd95, 0xd4c188,  0,  O, 1.0,  0,   false, true),
  def(BlockId.WATER,         'Water',         false, false, true,  -1,    0x3a6fa8, 0x336499, 0x2d5a8a,  0,  T, 0.72, 0,   true,  false),
  def(BlockId.WOOD,          'Wood',          true,  true,  false, 1.0,   0xa07a4a, 0x6b4a2a, 0xa07a4a,  0,  O, 1.0,  0,   false, true),
  def(BlockId.LEAVES,        'Leaves',        true,  false, false, 0.25,  0x3f7f2e, 0x376f28, 0x2f5f22,  0,  C, 1.0,  0,   false, true),
  def(BlockId.METAL,         'Metal',         true,  true,  false, 3.0,   0xa3a9b1, 0x969ca4, 0x848a92,  0,  O, 1.0,  0,   false, true),
  def(BlockId.LAVA,          'Lava',          false, false, true,  -1,    0xff6a18, 0xe85a12, 0xc94a0e, 15,  T, 0.94, 22,  true,  false),
  def(BlockId.GLASS,         'Glass',         true,  false, false, 0.3,   0xc6e6f2, 0xbde0ee, 0xb0d6e6,  0,  T, 0.34, 0,   false, true),
  def(BlockId.BRICK,         'Brick',         true,  true,  false, 2.0,   0xa2503a, 0x9c4a34, 0x8a412d,  0,  O, 1.0,  0,   false, true),
  def(BlockId.PLANKS,        'Planks',        true,  true,  false, 0.9,   0xb98f56, 0xb08a50, 0x9c7845,  0,  O, 1.0,  0,   false, true),
  def(BlockId.COBBLESTONE,   'Cobblestone',   true,  true,  false, 1.7,   0x807f7c, 0x7b7b78, 0x6d6d6a,  0,  O, 1.0,  0,   false, true),
  def(BlockId.SNOW,          'Snow',          true,  true,  false, 0.3,   0xf4f8fc, 0xe8eef5, 0xdae2ec,  0,  O, 1.0,  0,   false, true),
  def(BlockId.ICE,           'Ice',           true,  false, false, 0.5,   0xa8d8f0, 0x9dcfe9, 0x8ec2de,  0,  T, 0.62, 0,   false, true),
  // Obsidian is the hell theme's pillar and ledge material, so it is the
  // block a player is most often pressed against. Authored at 0x2a2340 it
  // renders at #120f19 on a shaded face — a black hole in the frame with no
  // readable silhouette. Lifted into a dark violet that still reads as the
  // heaviest rock in the palette but survives a side face in shadow.
  def(BlockId.OBSIDIAN,      'Obsidian',      true,  true,  false, 9.0,   0x4b4270, 0x423a63, 0x352e52,  0,  O, 1.0,  0,   false, true),
  def(BlockId.GRAVEL,        'Gravel',        true,  true,  false, 0.6,   0x8f8b83, 0x8c8880, 0x7d7a73,  0,  O, 1.0,  0,   false, true),
  def(BlockId.RUSTED_METAL,  'Rusted Metal',  true,  true,  false, 2.4,   0x9a5730, 0x8a4b2a, 0x763f23,  0,  O, 1.0,  0,   false, true),
  def(BlockId.TECH_PANEL,    'Tech Panel',    true,  true,  false, 2.6,   0x4e5966, 0x46505c, 0x3a434e,  2,  O, 1.0,  0,   false, true),
  def(BlockId.HELLSTONE,     'Hellstone',     true,  true,  false, 2.2,   0x7d2422, 0x6b1f1f, 0x581919,  5,  O, 1.0,  0,   false, true),
  def(BlockId.BONE,          'Bone',          true,  true,  false, 1.2,   0xeae4d0, 0xe6e0cc, 0xd6d0bc,  0,  O, 1.0,  0,   false, true),
  def(BlockId.SLIME,         'Slime',         true,  false, false, 0.4,   0x59b845, 0x4fa83c, 0x449634,  1,  T, 0.78, 0,   false, true),
  def(BlockId.NEON,          'Neon',          true,  true,  false, 0.8,   0x35ff9e, 0x2ef092, 0x27db84, 15,  O, 1.0,  0,   false, true),
  def(BlockId.BEDROCK,       'Bedrock',       true,  true,  false, -1,    0x33313a, 0x2d2b33, 0x26242b,  0,  O, 1.0,  0,   false, false),
]);

/* ------------------------------------------------------------------------ *
 * Hot lookup tables — build once, read forever
 * ------------------------------------------------------------------------ */

export const BLOCK_FLAGS = new Uint8Array(BLOCK_COUNT);
export const BLOCK_SOLID = new Uint8Array(BLOCK_COUNT);
export const BLOCK_OPAQUE = new Uint8Array(BLOCK_COUNT);
export const BLOCK_LIQUID = new Uint8Array(BLOCK_COUNT);
/** Emitted light level 0..15. */
export const BLOCK_LIGHT = new Uint8Array(BLOCK_COUNT);
export const BLOCK_LAYER = new Uint8Array(BLOCK_COUNT);
export const BLOCK_HARDNESS = new Float32Array(BLOCK_COUNT);
export const BLOCK_ALPHA = new Float32Array(BLOCK_COUNT);
/** Damage per second on contact. */
export const BLOCK_DAMAGE = new Float32Array(BLOCK_COUNT);
/** [id * 3 + 0] top, +1 side, +2 bottom. Packed 0xRRGGBB. */
export const BLOCK_COLOR = new Uint32Array(BLOCK_COUNT * 3);
/** [id * 6 + face] packed 0xRRGGBB — one read per quad in the mesher. */
export const BLOCK_FACE_COLOR = new Uint32Array(BLOCK_COUNT * FACE_COUNT);
/** [id * 6 + face] colour pre-multiplied by FACE_SHADE, ready for a vertex-colour buffer. */
export const BLOCK_FACE_SHADED = new Uint32Array(BLOCK_COUNT * FACE_COUNT);
export const BLOCK_NAMES: string[] = new Array<string>(BLOCK_COUNT);

export function packRGB(r: number, g: number, b: number): number {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}
export function unpackR(c: number): number { return (c >>> 16) & 0xff; }
export function unpackG(c: number): number { return (c >>> 8) & 0xff; }
export function unpackB(c: number): number { return c & 0xff; }

/** Multiply a packed colour by a scalar, clamped. Allocation free. */
export function shadeColor(color: number, mul: number): number {
  const r = ((color >>> 16) & 0xff) * mul;
  const g = ((color >>> 8) & 0xff) * mul;
  const b = (color & 0xff) * mul;
  return (((r > 255 ? 255 : r) | 0) << 16) | (((g > 255 ? 255 : g) | 0) << 8) | ((b > 255 ? 255 : b) | 0);
}

for (let i = 0; i < BLOCK_COUNT; i++) {
  const b = BLOCKS[i];
  let flags = 0;
  if (b.solid) flags |= BF_SOLID;
  if (b.opaque) flags |= BF_OPAQUE;
  if (b.liquid) flags |= BF_LIQUID;
  if (b.emissive > 0) flags |= BF_EMISSIVE;
  if (b.replaceable) flags |= BF_REPLACEABLE;
  if (b.placeable) flags |= BF_PLACEABLE;
  if (b.damage > 0) flags |= BF_DAMAGING;
  if (b.hardness >= 0) flags |= BF_BREAKABLE;

  BLOCK_FLAGS[i] = flags;
  BLOCK_SOLID[i] = b.solid ? 1 : 0;
  BLOCK_OPAQUE[i] = b.opaque ? 1 : 0;
  BLOCK_LIQUID[i] = b.liquid ? 1 : 0;
  BLOCK_LIGHT[i] = b.emissive;
  BLOCK_LAYER[i] = b.layer;
  BLOCK_HARDNESS[i] = b.hardness;
  BLOCK_ALPHA[i] = b.alpha;
  BLOCK_DAMAGE[i] = b.damage;
  BLOCK_NAMES[i] = b.name;

  BLOCK_COLOR[i * 3 + 0] = b.colorTop;
  BLOCK_COLOR[i * 3 + 1] = b.colorSide;
  BLOCK_COLOR[i * 3 + 2] = b.colorBottom;

  const base = i * FACE_COUNT;
  BLOCK_FACE_COLOR[base + Face.PX] = b.colorSide;
  BLOCK_FACE_COLOR[base + Face.NX] = b.colorSide;
  BLOCK_FACE_COLOR[base + Face.PY] = b.colorTop;
  BLOCK_FACE_COLOR[base + Face.NY] = b.colorBottom;
  BLOCK_FACE_COLOR[base + Face.PZ] = b.colorSide;
  BLOCK_FACE_COLOR[base + Face.NZ] = b.colorSide;
  for (let f = 0; f < FACE_COUNT; f++) {
    BLOCK_FACE_SHADED[base + f] = shadeColor(BLOCK_FACE_COLOR[base + f], FACE_SHADE[f]);
  }
}

/* ------------------------------------------------------------------------ *
 * Queries — array reads, safe for unknown ids
 * ------------------------------------------------------------------------ */

export function isAir(id: number): boolean { return id === 0; }
export function isSolid(id: number): boolean { return BLOCK_SOLID[id] === 1; }
export function isOpaque(id: number): boolean { return BLOCK_OPAQUE[id] === 1; }
export function isLiquid(id: number): boolean { return BLOCK_LIQUID[id] === 1; }
export function isEmissive(id: number): boolean { return BLOCK_LIGHT[id] > 0; }
export function isReplaceable(id: number): boolean { return (BLOCK_FLAGS[id] & BF_REPLACEABLE) !== 0; }
export function isPlaceable(id: number): boolean { return (BLOCK_FLAGS[id] & BF_PLACEABLE) !== 0; }
export function isBreakable(id: number): boolean { return (BLOCK_FLAGS[id] & BF_BREAKABLE) !== 0; }
export function isDamaging(id: number): boolean { return (BLOCK_FLAGS[id] & BF_DAMAGING) !== 0; }
export function blockLight(id: number): number { return BLOCK_LIGHT[id]; }
export function blockHardness(id: number): number { return BLOCK_HARDNESS[id]; }
export function blockLayer(id: number): number { return BLOCK_LAYER[id]; }
export function blockAlpha(id: number): number { return BLOCK_ALPHA[id]; }
export function blockDamage(id: number): number { return BLOCK_DAMAGE[id]; }
export function blockName(id: number): string { return BLOCK_NAMES[id] ?? 'Unknown'; }
export function blockDef(id: number): BlockDef { return BLOCKS[id] ?? BLOCKS[0]; }

/** Packed 0xRRGGBB for one face, unshaded. */
export function blockFaceColor(id: number, face: number): number {
  return BLOCK_FACE_COLOR[id * FACE_COUNT + face];
}
/** Packed 0xRRGGBB for one face with FACE_SHADE already applied. */
export function blockFaceShaded(id: number, face: number): number {
  return BLOCK_FACE_SHADED[id * FACE_COUNT + face];
}

/**
 * The single rule the greedy mesher uses to decide whether the `face` of a
 * `self` voxel is drawn when `neighbor` sits against it. Client and server must
 * not disagree about this or occlusion queries drift.
 */
export function shouldRenderFace(self: number, neighbor: number): boolean {
  if (self === 0) return false;
  if (neighbor === 0) return true;
  if (BLOCK_OPAQUE[neighbor] === 1) return false;
  if (self === neighbor) return false;               // water/water, glass/glass merge
  if (BLOCK_LAYER[self] === RenderLayer.TRANSPARENT && BLOCK_LAYER[neighbor] === RenderLayer.TRANSPARENT) return false;
  return true;
}

/** Milliseconds to dig a block. `toolPower` 1.0 is bare hands. Infinity if unbreakable. */
export function blockBreakMs(id: number, toolPower: number, baseMs: number): number {
  const h = BLOCK_HARDNESS[id];
  if (h < 0) return Infinity;
  if (toolPower <= 0) return Infinity;
  return (baseMs * h) / toolPower;
}

/** Build palette, in hotbar order. */
export const PLACEABLE_BLOCKS: readonly number[] = Object.freeze([
  BlockId.STONE, BlockId.DIRT, BlockId.GRASS, BlockId.SAND, BlockId.WOOD,
  BlockId.PLANKS, BlockId.COBBLESTONE, BlockId.BRICK, BlockId.METAL,
  BlockId.TECH_PANEL, BlockId.RUSTED_METAL, BlockId.HELLSTONE, BlockId.OBSIDIAN,
  BlockId.GLASS, BlockId.LEAVES, BlockId.SNOW, BlockId.ICE, BlockId.BONE,
  BlockId.SLIME, BlockId.NEON, BlockId.GRAVEL,
]);

/** Minimap colour per block: the top face, unshaded. */
export function minimapColor(id: number): number {
  return BLOCK_COLOR[id * 3];
}
