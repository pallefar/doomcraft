/**
 * DOOMCRAFT — character asset packer.
 *
 *   node tools/pack-characters.mjs
 *
 * Turns the vendored Kenney "Blocky Characters" pack into the two files the
 * game actually ships, and nothing else:
 *
 *   client/public/characters/cast.glb   one rig, geometry + the 9 clips we use
 *   client/public/characters/cast.png   one 3x2 skin atlas, 64 px per skin
 *
 * WHY A PACKER AND NOT THE RAW GLBs
 *
 * Measured facts about the vendored pack (see the checks this script re-asserts
 * on every run, so a pack update cannot silently invalidate them):
 *
 *   - All 18 characters have byte-identical geometry AND byte-identical UVs.
 *     They differ only in which 1024x1024 texture they point at. So the cast
 *     needs ONE mesh and ONE animation set, not eighteen. Shipping all 18 GLBs
 *     would be 2.0 MB for 17 redundant copies of the same 143 vertices.
 *   - There is no `skins` array. These are not skinned meshes: they are six
 *     rigid boxes driven by node TRS tracks. That is what makes the whole cast
 *     drawable from one InstancedMesh (see characters/renderer.ts).
 *   - 27 clips ship; a shooter needs 9. The other 18 (wheelchair variants,
 *     emotes, left-handed mirrors, sit, drive) are 61% of the animation keys.
 *   - TANGENT is present and useless to us: nothing here is normal-mapped.
 *   - The textures are 1024x1024 for a 72-triangle character. Minecraft skins
 *     are 64x64 and this art style is Minecraft's; 64 is the native resolution,
 *     not a compromise. A face lands on ~10x11 texels, which is what the bar's
 *     own characters use.
 *
 * THE DOWNSCALE IS NOT A PLAIN RESIZE
 *
 * A 16x box filter across a UV island edge pulls the dark inter-island
 * background into the outermost texel of every face, which at 64 px is a 10%
 * dark rim on each face. So every UV quad's pixel rect is marked valid, the
 * invalid pixels are flood-dilated outward from them, and only then is the box
 * filter run. The averages near an island edge then blend the edge colour with
 * copies of itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'vendor/kenney-blocky-characters');
const OUT = path.join(ROOT, 'client/public/characters');

/* ------------------------------------------------------------------ *
 * What we ship. Keep in sync with shared/src/characters.ts.
 * ------------------------------------------------------------------ */

/** The rig donor. Geometry and clips are identical across the pack. */
const RIG = 'character-a';

/**
 * Skin atlas cells, in order. Index here == SkinId in registry.ts.
 * Five cells used, six laid out: a 3x2 grid keeps the atlas at 192x128.
 */
const SKINS = [
  'character-l', // 0 GHOUL    green-skinned, torn suit      -> Imp
  'character-j', // 1 TROOPER  navy security uniform         -> Zombie trooper
  'character-d', // 2 HAZARD   yellow/black armoured mech    -> Baron, Lost Soul
  'character-g', // 3 CORE     grey armour, red chest core   -> Cacodemon
  'character-f', // 4 MARINE   teal/blue civvies             -> players
];

/** Clips a shooter needs. Everything else in the pack is dropped. */
const CLIPS = [
  'idle',
  'walk',
  'sprint',
  'die',
  'pick-up',
  'holding-right',
  'holding-right-shoot',
  'holding-both-shoot',
  'attack-melee-right',
];

/** Skin cell size, px. Minecraft's native skin resolution. */
const CELL = 64;
const ATLAS_COLS = 3;
const ATLAS_ROWS = 2;

/* ------------------------------------------------------------------ *
 * GLB container
 * ------------------------------------------------------------------ */

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  const total = buf.readUInt32LE(8);
  let off = 12;
  let json = null;
  let bin = null;
  while (off < total) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === JSON_CHUNK) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === BIN_CHUNK) bin = data;
    off += 8 + len;
    off += (4 - (off % 4)) % 4;
  }
  if (json === null || bin === null) throw new Error(`${file}: missing chunk`);
  return { json, bin };
}

function writeGlb(file, json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const jsonLen = jsonBytes.length + jsonPad;
  const binLen = bin.length + binPad;
  const out = Buffer.alloc(12 + 8 + jsonLen + 8 + binLen);
  let o = 0;
  out.writeUInt32LE(0x46546c67, o); o += 4;
  out.writeUInt32LE(2, o); o += 4;
  out.writeUInt32LE(out.length, o); o += 4;
  out.writeUInt32LE(jsonLen, o); o += 4;
  out.writeUInt32LE(JSON_CHUNK, o); o += 4;
  jsonBytes.copy(out, o); o += jsonBytes.length;
  out.fill(0x20, o, o + jsonPad); o += jsonPad;
  out.writeUInt32LE(binLen, o); o += 4;
  out.writeUInt32LE(BIN_CHUNK, o); o += 4;
  bin.copy(out, o); o += bin.length;
  out.fill(0, o, o + binPad);
  fs.writeFileSync(file, out);
  return out.length;
}

const CTOR = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(g, bin, index) {
  const a = g.accessors[index];
  const view = g.bufferViews[a.bufferView];
  const T = CTOR[a.componentType];
  const n = COMPONENTS[a.type];
  const byteOffset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const stride = view.byteStride ?? 0;
  if (stride !== 0 && stride !== T.BYTES_PER_ELEMENT * n) {
    throw new Error(`accessor ${index}: interleaved buffer views are not supported`);
  }
  // Copy: the source buffer is a subarray of a Buffer whose byteOffset need not
  // be aligned to the component size.
  const bytes = bin.subarray(byteOffset, byteOffset + a.count * n * T.BYTES_PER_ELEMENT);
  const copy = new T(a.count * n);
  Buffer.from(copy.buffer).set(bytes);
  return { data: copy, count: a.count, type: a.type, componentType: a.componentType };
}

/* ------------------------------------------------------------------ *
 * Output glTF builder
 * ------------------------------------------------------------------ */

class GltfOut {
  constructor() {
    this.chunks = [];
    this.length = 0;
    this.bufferViews = [];
    this.accessors = [];
  }

  /** Append a typed array, returning its accessor index. */
  push(array, type, componentType, extra = {}) {
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    const pad = (4 - (this.length % 4)) % 4;
    if (pad > 0) { this.chunks.push(Buffer.alloc(pad)); this.length += pad; }
    const offset = this.length;
    this.chunks.push(bytes);
    this.length += bytes.length;
    this.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    const n = COMPONENTS[type];
    this.accessors.push({
      bufferView: this.bufferViews.length - 1,
      componentType,
      count: array.length / n,
      type,
      ...extra,
    });
    return this.accessors.length - 1;
  }

  binary() { return Buffer.concat(this.chunks, this.length); }
}

/**
 * De-index, give every triangle its geometric normal, then weld back on
 * (position, normal, uv). The result is per-face flat shading with no vertex
 * shared across a cube edge.
 */
function flatten(pos, nrm, uv, idx) {
  const keys = new Map();
  const P = [];
  const N = [];
  const T = [];
  const index = [];
  const snap = (v) => (Math.abs(v) < 0.5 ? 0 : Math.sign(v));

  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    // Every face of every part is axis-aligned; snapping removes float noise so
    // the shade ramp lands exactly on the world's own six values.
    const sx = snap(nx), sy = snap(ny), sz = snap(nz);
    if (Math.abs(sx) + Math.abs(sy) + Math.abs(sz) !== 1) {
      throw new Error(`non-axis-aligned face normal (${nx}, ${ny}, ${nz})`);
    }
    for (const vi of [a, b, c]) {
      const key = `${pos[vi * 3]},${pos[vi * 3 + 1]},${pos[vi * 3 + 2]},${sx},${sy},${sz},${uv[vi * 2]},${uv[vi * 2 + 1]}`;
      let at = keys.get(key);
      if (at === undefined) {
        at = P.length / 3;
        keys.set(key, at);
        P.push(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
        N.push(sx, sy, sz);
        T.push(uv[vi * 2], uv[vi * 2 + 1]);
      }
      index.push(at);
    }
  }
  // The original NORMAL array is read only to prove it was worth replacing.
  void nrm;
  return {
    position: Float32Array.from(P),
    normal: Float32Array.from(N),
    uv: Float32Array.from(T),
    index: Uint16Array.from(index),
  };
}

function bounds(array, stride) {
  const min = new Array(stride).fill(Infinity);
  const max = new Array(stride).fill(-Infinity);
  for (let i = 0; i < array.length; i += stride) {
    for (let c = 0; c < stride; c++) {
      const v = array[i + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return { min, max };
}

/* ------------------------------------------------------------------ *
 * PNG through ffmpeg (no image dependency in the repo)
 * ------------------------------------------------------------------ */

function decodePng(file, width, height) {
  const raw = execFileSync('ffmpeg', [
    '-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { maxBuffer: 1 << 28 });
  if (raw.length !== width * height * 3) {
    throw new Error(`${file}: expected ${width}x${height} rgb24, got ${raw.length} bytes`);
  }
  return raw;
}

function encodePng(file, rgb, width, height) {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`, '-i', 'pipe:0',
    '-frames:v', '1', '-compression_level', '100', file,
  ], { input: rgb });
}

/* ------------------------------------------------------------------ *
 * 1. Read the rig and assert the facts this packer depends on
 * ------------------------------------------------------------------ */

const rig = readGlb(path.join(SRC, 'glb', `${RIG}.glb`));
const g = rig.json;

if (g.skins !== undefined) {
  throw new Error('the pack grew a skin: the renderer assumes rigid parts, not GPU skinning');
}
const PART_ORDER = ['leg-left', 'leg-right', 'torso', 'arm-left', 'arm-right', 'head'];
const meshNames = g.meshes.map((m) => m.name);
for (const p of PART_ORDER) {
  if (!meshNames.includes(p)) throw new Error(`rig is missing part "${p}"`);
}
if (g.meshes.length !== PART_ORDER.length) {
  throw new Error(`rig has ${g.meshes.length} parts, renderer expects ${PART_ORDER.length}`);
}

// Every character must still be geometry-identical, or one rig is a lie.
{
  const key = (glb) => glb.json.meshes.map((m) => {
    const p = m.primitives[0];
    const pos = readAccessor(glb.json, glb.bin, p.attributes.POSITION).data;
    const uv = readAccessor(glb.json, glb.bin, p.attributes.TEXCOORD_0).data;
    return `${m.name}:${Buffer.from(pos.buffer).toString('base64')}:${Buffer.from(uv.buffer).toString('base64')}`;
  }).join('|');
  const want = key(rig);
  for (const name of SKINS) {
    if (name === RIG) continue;
    const other = readGlb(path.join(SRC, 'glb', `${name}.glb`));
    if (key(other) !== want) {
      throw new Error(`${name} no longer shares ${RIG}'s geometry — the shared-rig packing is invalid`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 2. Geometry: POSITION, NORMAL, TEXCOORD_0 (wrapped into [0,1)), indices
 * ------------------------------------------------------------------ */

const out = new GltfOut();
const outMeshes = [];
/** Pixel rects of every UV quad, for the dilation pass. */
const quadRects = [];
/** Per-part vertex counts before and after the flat-normal re-split. */
const weldStats = [];

for (const name of PART_ORDER) {
  const mesh = g.meshes[meshNames.indexOf(name)];
  const prim = mesh.primitives[0];
  const pos = readAccessor(g, rig.bin, prim.attributes.POSITION).data;
  const nrm = readAccessor(g, rig.bin, prim.attributes.NORMAL).data;
  const uvSrc = readAccessor(g, rig.bin, prim.attributes.TEXCOORD_0).data;
  const idx = readAccessor(g, rig.bin, prim.indices).data;

  // The pack authors UVs outside [0,1] and relies on REPEAT. An atlas cannot
  // repeat, so wrap them here where it can be checked, not in the shader where
  // fract() would split a quad that lands exactly on 1.0.
  const uv = new Float32Array(uvSrc.length);
  for (let i = 0; i < uvSrc.length; i++) {
    let v = uvSrc[i] - Math.floor(uvSrc[i]);
    if (v >= 1) v = 0;
    uv[i] = v;
  }
  // A quad whose corners wrapped to opposite ends of the texture would tear.
  for (let q = 0; q < uv.length / 8; q++) {
    let u0 = 2, u1 = -1, v0 = 2, v1 = -1;
    for (let k = 0; k < 4; k++) {
      const u = uv[q * 8 + k * 2];
      const v = uv[q * 8 + k * 2 + 1];
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    if (u1 - u0 > 0.6 || v1 - v0 > 0.6) {
      throw new Error(`${name}: UV quad ${q} straddles a wrap boundary; cannot atlas it`);
    }
    quadRects.push([u0, v0, u1, v1]);
  }

  // The vendored NORMALs are corner-AVERAGED, not per-face: the head's top
  // corners all carry (-1,1,1). Shading a hard-edged voxel character off those
  // rounds every cube. Rebuild them from the triangle winding instead, snapped
  // to the axis they are already within a rounding error of, and re-split any
  // vertex two faces were sharing.
  const flat = flatten(pos, nrm, uv, idx);

  const pb = bounds(flat.position, 3);
  outMeshes.push({
    name,
    primitives: [{
      attributes: {
        POSITION: out.push(flat.position, 'VEC3', 5126, pb),
        NORMAL: out.push(flat.normal, 'VEC3', 5126),
        TEXCOORD_0: out.push(flat.uv, 'VEC2', 5126),
      },
      indices: out.push(flat.index, 'SCALAR', 5123),
      material: 0,
    }],
  });
  weldStats.push(`${name} ${pos.length / 3}->${flat.position.length / 3}v`);
}

/* ------------------------------------------------------------------ *
 * 3. Animations: keep CLIPS, drop the rest
 * ------------------------------------------------------------------ */

const outAnimations = [];
for (const clipName of CLIPS) {
  const src = g.animations.find((a) => a.name === clipName);
  if (src === undefined) throw new Error(`rig has no clip "${clipName}"`);
  const samplers = [];
  const channels = [];
  const remap = new Map();
  for (const ch of src.channels) {
    let s = remap.get(ch.sampler);
    if (s === undefined) {
      const sm = src.samplers[ch.sampler];
      const input = readAccessor(g, rig.bin, sm.input).data;
      const output = readAccessor(g, rig.bin, sm.output);
      const ib = bounds(input, 1);
      samplers.push({
        input: out.push(Float32Array.from(input), 'SCALAR', 5126, ib),
        output: out.push(Float32Array.from(output.data), output.type, 5126),
        interpolation: sm.interpolation ?? 'LINEAR',
      });
      s = samplers.length - 1;
      remap.set(ch.sampler, s);
    }
    channels.push({ sampler: s, target: { node: ch.target.node, path: ch.target.path } });
  }
  outAnimations.push({ name: clipName, samplers, channels });
}

/* ------------------------------------------------------------------ *
 * 4. Emit the GLB
 * ------------------------------------------------------------------ */

const nodes = g.nodes.map((n) => {
  const copy = { name: n.name };
  if (n.children !== undefined) copy.children = n.children.slice();
  if (n.translation !== undefined) copy.translation = n.translation.slice();
  if (n.rotation !== undefined) copy.rotation = n.rotation.slice();
  if (n.scale !== undefined) copy.scale = n.scale.slice();
  if (n.mesh !== undefined) copy.mesh = PART_ORDER.indexOf(meshNames[n.mesh]);
  return copy;
});

const bin = out.binary();
const gltf = {
  asset: { version: '2.0', generator: 'doomcraft tools/pack-characters.mjs' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes,
  meshes: outMeshes,
  // No baseColorTexture: the skin atlas is assigned at runtime so one rig can
  // wear any cell of it.
  materials: [{
    name: 'character',
    pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
  }],
  accessors: out.accessors,
  bufferViews: out.bufferViews,
  buffers: [{ byteLength: bin.length }],
  animations: outAnimations,
};

fs.mkdirSync(OUT, { recursive: true });
const glbBytes = writeGlb(path.join(OUT, 'cast.glb'), gltf, bin);

/* ------------------------------------------------------------------ *
 * 5. Skin atlas
 * ------------------------------------------------------------------ */

const SRC_SIZE = 1024;
const BLOCK = SRC_SIZE / CELL;
if (!Number.isInteger(BLOCK)) throw new Error('cell size must divide the source texture');

/** Mark every pixel covered by a UV quad, then dilate outward into the gaps. */
function dilateToValid(rgb, size) {
  const valid = new Uint8Array(size * size);
  for (const [u0, v0, u1, v1] of quadRects) {
    const x0 = Math.max(0, Math.floor(u0 * size) - 1);
    const x1 = Math.min(size - 1, Math.ceil(u1 * size) + 1);
    const y0 = Math.max(0, Math.floor(v0 * size) - 1);
    const y1 = Math.min(size - 1, Math.ceil(v1 * size) + 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) valid[y * size + x] = 1;
  }
  // Enough passes to cover one box-filter block plus the widest island gap.
  const next = new Uint8Array(valid);
  for (let pass = 0; pass < BLOCK + 8; pass++) {
    let grew = false;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (valid[i] === 1) continue;
        let sx = -1, sy = -1;
        if (x > 0 && valid[i - 1] === 1) { sx = x - 1; sy = y; }
        else if (x + 1 < size && valid[i + 1] === 1) { sx = x + 1; sy = y; }
        else if (y > 0 && valid[i - size] === 1) { sx = x; sy = y - 1; }
        else if (y + 1 < size && valid[i + size] === 1) { sx = x; sy = y + 1; }
        if (sx < 0) continue;
        rgb[i * 3] = rgb[(sy * size + sx) * 3];
        rgb[i * 3 + 1] = rgb[(sy * size + sx) * 3 + 1];
        rgb[i * 3 + 2] = rgb[(sy * size + sx) * 3 + 2];
        next[i] = 1;
        grew = true;
      }
    }
    valid.set(next);
    if (!grew) break;
  }
}

const atlasW = ATLAS_COLS * CELL;
const atlasH = ATLAS_ROWS * CELL;
const atlas = Buffer.alloc(atlasW * atlasH * 3);

SKINS.forEach((name, slot) => {
  const rgb = decodePng(path.join(SRC, 'glb/Textures', `texture-${name.slice(-1)}.png`), SRC_SIZE, SRC_SIZE);
  dilateToValid(rgb, SRC_SIZE);
  const col = slot % ATLAS_COLS;
  const row = (slot / ATLAS_COLS) | 0;
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      let r = 0, gg = 0, b = 0;
      for (let by = 0; by < BLOCK; by++) {
        const sy = y * BLOCK + by;
        for (let bx = 0; bx < BLOCK; bx++) {
          const si = (sy * SRC_SIZE + x * BLOCK + bx) * 3;
          r += rgb[si]; gg += rgb[si + 1]; b += rgb[si + 2];
        }
      }
      const n = BLOCK * BLOCK;
      const di = ((row * CELL + y) * atlasW + (col * CELL + x)) * 3;
      atlas[di] = Math.round(r / n);
      atlas[di + 1] = Math.round(gg / n);
      atlas[di + 2] = Math.round(b / n);
    }
  }
});

encodePng(path.join(OUT, 'cast.png'), atlas, atlasW, atlasH);
const pngBytes = fs.statSync(path.join(OUT, 'cast.png')).size;

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

const srcBytes = SKINS.reduce(
  (n, s) => n + fs.statSync(path.join(SRC, 'glb', `${s}.glb`)).size
    + fs.statSync(path.join(SRC, 'glb/Textures', `texture-${s.slice(-1)}.png`)).size,
  0,
);
console.log(`cast.glb  ${glbBytes} B   ${outMeshes.length} parts, ${outAnimations.length} clips`);
console.log(`flat-normal re-split: ${weldStats.join(', ')}`);
console.log(`cast.png  ${pngBytes} B   ${atlasW}x${atlasH}, ${SKINS.length} skins @ ${CELL}px`);
console.log(`total     ${glbBytes + pngBytes} B  (raw vendored equivalent: ${srcBytes} B)`);
console.log(`atlas cells: ${SKINS.map((s, i) => `${i}=${s}`).join(' ')}`);
