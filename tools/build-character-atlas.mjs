/**
 * DOOMCRAFT — character atlas + rig baker.
 *
 * Run:  node tools/build-character-atlas.mjs
 *
 * WHY THIS TOOL EXISTS — the measurement that decides the whole design.
 *
 * The 18 Kenney "Blocky Characters" GLBs are NOT 18 models. Their geometry,
 * their UVs and their node hierarchies are BYTE-IDENTICAL; the only thing that
 * differs between character-a and character-r is the 1024x1024 PNG each one
 * points at. (Verified: 18 files, 6 meshes each, one unique POSITION hash, one
 * unique TEXCOORD_0 hash, per part, across all 18.)
 *
 * That has three consequences, and they are the reason the avatar system looks
 * the way it does:
 *
 *   1. Shipping 18 GLBs (2.0 MB) would ship the same 72 triangles 18 times.
 *      One bake of the geometry serves every character, forever.
 *   2. "Part swapping" cannot mean swapping shapes — every character is the
 *      same six boxes. It means swapping which texture each of the six boxes
 *      samples. So an avatar is four small integers, not a mesh.
 *   3. If all the source textures live in ONE atlas, then one geometry + one
 *      material + one texture draws every player in the match, and the outfit
 *      choice is a per-instance UV offset. That is 1 draw call for all remote
 *      players, not 6 per player.
 *
 * OUTPUTS
 *   client/public/c/kenney-chars.png   the atlas (COLS x ROWS cells)
 *   client/src/characters/kenneyRig.ts generated: baked geometry + atlas facts
 *
 * The PNG lives in public/ on purpose: it must be fetchable lazily, AFTER the
 * menu is interactive, and must never enter the JS bundle (ref/BAR.md: our
 * 0.3 s time-to-interactive against the bar's 3.16 s is the thing we are not
 * allowed to spend).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const GLB_DIR = path.join(repo, 'vendor/kenney-blocky-characters/glb');
const TEX_DIR = path.join(GLB_DIR, 'Textures');
const OUT_PNG = path.join(repo, 'client/public/c/kenney-chars.png');
const OUT_TS = path.join(repo, 'client/src/characters/kenneyRig.ts');

/* ------------------------------------------------------------------------ *
 * The shipped roster
 *
 * Twelve of the eighteen, chosen for a DOOM arena rather than for a village:
 * every one has to be pickable out of a dark corridor by silhouette and value
 * alone (ref/doom/doom-gameplay.webm is the bar). The six left behind are the
 * low-contrast civilians that read as brown smudges at 20 m.
 * ------------------------------------------------------------------------ */
const ROSTER = [
  { key: 'm', name: 'Marine' },     //  0 — green fatigues, the default
  { key: 'j', name: 'Enforcer' },   //  1 — blue uniform, peaked cap
  { key: 'b', name: 'Ranger' },     //  2 — red hoodie, high value
  { key: 'o', name: 'Wrench' },     //  3 — green coveralls
  { key: 'k', name: 'Timber' },     //  4 — red plaid, beard
  { key: 'f', name: 'Diver' },      //  5 — teal, dark skin
  { key: 'l', name: 'Revenant' },   //  6 — dead green, sunken
  { key: 'r', name: 'Cultist' },    //  7 — black hood, red trim
  { key: 'g', name: 'Sentry' },     //  8 — grey mech, red optic
  { key: 'h', name: 'Warden' },     //  9 — violet mech
  { key: 'd', name: 'Gilded' },     // 10 — gold plate, brightest in the set
  { key: 'n', name: 'Medic' },      // 11 — white and red
];

const CELL = 160;
const COLS = 4;
const ROWS = 3;

/* ------------------------------------------------------------------------ *
 * GLB reading — just enough glTF to pull one primitive out
 * ------------------------------------------------------------------------ */

function loadGlb(file) {
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
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  if (json === null || bin === null) throw new Error(`${file}: missing chunk`);
  return { json, bin };
}

const COMPONENT = {
  5120: ['getInt8', 1], 5121: ['getUint8', 1], 5122: ['getInt16', 2],
  5123: ['getUint16', 2], 5125: ['getUint32', 4], 5126: ['getFloat32', 4],
};
const COMPONENTS_PER = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(g, bin, index) {
  const a = g.accessors[index];
  const bv = g.bufferViews[a.bufferView];
  const [fn, size] = COMPONENT[a.componentType];
  const n = COMPONENTS_PER[a.type];
  const stride = bv.byteStride || size * n;
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out = [];
  for (let i = 0; i < a.count; i++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(dv[fn](base + i * stride + c * size, true));
    out.push(row);
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Step 1 — prove the 18 really are one model, then bake that one model
 * ------------------------------------------------------------------------ */

function assertIdenticalGeometry() {
  const files = fs.readdirSync(GLB_DIR).filter((f) => f.endsWith('.glb')).sort();
  let sig = null;
  for (const f of files) {
    const { json: g, bin } = loadGlb(path.join(GLB_DIR, f));
    const parts = g.meshes.map((m) => {
      const p = m.primitives[0];
      return JSON.stringify([
        readAccessor(g, bin, p.attributes.POSITION),
        readAccessor(g, bin, p.attributes.TEXCOORD_0),
        readAccessor(g, bin, p.indices),
      ]);
    }).join('|');
    if (sig === null) sig = parts;
    else if (sig !== parts) throw new Error(`${f}: geometry differs from character-a — the one-mesh assumption is broken`);
  }
  console.log(`geometry: ${files.length} GLBs, all byte-identical. Baking one.`);
}

/**
 * The six meshes, in the order the node tree declares them, with the pivot each
 * one rotates about. Pivots come from the node translations, accumulated down
 * the hierarchy (arms and head hang off the torso), so the baked mesh is in a
 * single flat space and the shader needs no matrix stack.
 *
 *   root -> leg-left, leg-right, torso -> arm-left, arm-right, head
 */
const PART_ORDER = ['leg-left', 'leg-right', 'torso', 'arm-left', 'arm-right', 'head'];
/** Which of the four customisable ZONES each part belongs to. */
const PART_ZONE = { 'leg-left': 3, 'leg-right': 3, torso: 1, 'arm-left': 2, 'arm-right': 2, head: 0 };

function bakeGeometry() {
  const { json: g, bin } = loadGlb(path.join(GLB_DIR, 'character-a.glb'));
  const nodeByName = new Map();
  g.nodes.forEach((n, i) => nodeByName.set(n.name, { ...n, index: i }));

  // Accumulate world translation + scale down the tree. No rotations are
  // present in the rest pose (verified), so a translate+scale is exact.
  const world = new Map();
  const walk = (nodeIndex, tx, ty, tz, s) => {
    const n = g.nodes[nodeIndex];
    const t = n.translation ?? [0, 0, 0];
    const ns = n.scale ? n.scale[0] : 1;
    const wx = tx + t[0] * s;
    const wy = ty + t[1] * s;
    const wz = tz + t[2] * s;
    world.set(n.name, { x: wx, y: wy, z: wz, s: s * ns });
    for (const c of n.children ?? []) walk(c, wx, wy, wz, s * ns);
  };
  walk(0, 0, 0, 0, 1);

  const pos = [];
  const uv = [];
  const pivot = [];
  const zone = [];
  const shade = [];
  const index = [];

  // Baked face shade — the world is flat-shaded hard-edged voxels, and the
  // Kenney art is soft-shaded. Stamping the SAME six-face ramp the voxel
  // meshser uses onto the characters is what stops them reading as visitors
  // from another game (brief constraint 3).
  const FACE_SHADE = { px: 0.80, nx: 0.66, py: 1.0, ny: 0.52, pz: 0.88, nz: 0.72 };

  for (const partName of PART_ORDER) {
    const node = world.get(partName);
    const meshIndex = nodeByName.get(partName).mesh;
    const prim = g.meshes[meshIndex].primitives[0];
    const P = readAccessor(g, bin, prim.attributes.POSITION);
    const T = readAccessor(g, bin, prim.attributes.TEXCOORD_0);
    const I = readAccessor(g, bin, prim.indices).map((r) => r[0]);
    const z = PART_ZONE[partName];

    // The export welds some corners and ships bent normals ([-1,1,1] on the
    // head). Re-split every triangle so each face is flat and can carry its own
    // shade — 72 triangles either way, and it removes the bad normals entirely.
    for (let t = 0; t < I.length; t += 3) {
      const tri = [I[t], I[t + 1], I[t + 2]];
      const p = tri.map((k) => [
        node.x + P[k][0] * node.s,
        node.y + P[k][1] * node.s,
        node.z + P[k][2] * node.s,
      ]);
      // Flat normal from the winding.
      const ax = p[1][0] - p[0][0], ay = p[1][1] - p[0][1], az = p[1][2] - p[0][2];
      const bx = p[2][0] - p[0][0], by = p[2][1] - p[0][1], bz = p[2][2] - p[0][2];
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      let sh = FACE_SHADE.py;
      const ex = Math.abs(nx), ey = Math.abs(ny), ez = Math.abs(nz);
      if (ey >= ex && ey >= ez) sh = ny > 0 ? FACE_SHADE.py : FACE_SHADE.ny;
      else if (ex >= ez) sh = nx > 0 ? FACE_SHADE.px : FACE_SHADE.nx;
      else sh = nz > 0 ? FACE_SHADE.pz : FACE_SHADE.nz;

      for (let c = 0; c < 3; c++) {
        const k = tri[c];
        index.push(pos.length / 3);
        pos.push(p[c][0], p[c][1], p[c][2]);
        // UVs run outside [0,1] (the exporter relies on REPEAT). Fold them back
        // into one period, then pre-divide into one atlas cell so the shader's
        // only per-instance job is to add the donor's cell offset.
        const u0 = T[k][0] - Math.floor(T[k][0]);
        const v0 = T[k][1] - Math.floor(T[k][1]);
        uv.push(u0 / COLS, v0 / ROWS);
        pivot.push(node.x, node.y, node.z);
        zone.push(z);
        shade.push(sh);
      }
    }
  }

  return { pos, uv, pivot, zone, shade, index, world };
}

/* ------------------------------------------------------------------------ *
 * Step 2 — pack the roster's textures into one atlas
 * ------------------------------------------------------------------------ */

async function buildAtlas() {
  const images = ROSTER.map((r) => {
    const file = path.join(TEX_DIR, `texture-${r.key}.png`);
    return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
  });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const dataUrl = await page.evaluate(async ({ images, CELL, COLS, ROWS }) => {
    const canvas = document.createElement('canvas');
    canvas.width = CELL * COLS;
    canvas.height = CELL * ROWS;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (let i = 0; i < images.length; i++) {
      const img = new Image();
      img.src = images[i];
      await img.decode();
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      ctx.drawImage(img, col * CELL, row * CELL, CELL, CELL);
    }
    return canvas.toDataURL('image/png');
  }, { images, CELL, COLS, ROWS });
  await browser.close();

  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  fs.mkdirSync(path.dirname(OUT_PNG), { recursive: true });
  fs.writeFileSync(OUT_PNG, png);
  return png.length;
}

/* ------------------------------------------------------------------------ *
 * Step 3 — emit the generated module
 * ------------------------------------------------------------------------ */

function b64(typed) {
  return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64');
}

function emit(baked, pngBytes) {
  const n = baked.pos.length / 3;
  // Positions quantise to 1/1024 m over a +/-4 m model: exact for every value
  // Kenney ships (they are all multiples of 0.05 or 0.1) and half the bytes.
  const qpos = new Int16Array(n * 3);
  for (let i = 0; i < n * 3; i++) qpos[i] = Math.round(baked.pos[i] * 1024);
  const qpiv = new Int16Array(n * 3);
  for (let i = 0; i < n * 3; i++) qpiv[i] = Math.round(baked.pivot[i] * 1024);
  const quv = new Uint16Array(n * 2);
  for (let i = 0; i < n * 2; i++) quv[i] = Math.round(baked.uv[i] * 65535);
  // zone (0..3) and shade (0..1 in 1/255) share one byte pair.
  const misc = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    misc[i * 2] = baked.zone[i];
    misc[i * 2 + 1] = Math.round(baked.shade[i] * 255);
  }
  const idx = new Uint16Array(baked.index);

  const w = baked.world;
  const modelHeight = 2.7; // legs 0..1, torso 1..1.9, head 1.9..2.7 (measured)

  const src = `/**
 * GENERATED by tools/build-character-atlas.mjs — do not edit by hand.
 *
 * The Kenney "Blocky Characters" rig, baked once. All 18 shipped characters
 * have byte-identical geometry and UVs (the tool asserts it on every run), so
 * this is the ONLY character mesh in the game: ${n} vertices, ${idx.length / 3} triangles,
 * six parts, four customisable zones.
 *
 * UVs are pre-folded into one period and pre-divided by the atlas grid, so a
 * consumer picks an outfit by ADDING a cell offset — no second geometry, no
 * second material, no second draw call.
 *
 * Atlas: ${COLS}x${ROWS} cells of ${CELL}px in client/public/c/kenney-chars.png (${(pngBytes / 1024).toFixed(1)} KB).
 */

/** Cells across the atlas. */
export const ATLAS_COLS = ${COLS};
/** Cells down the atlas. */
export const ATLAS_ROWS = ${ROWS};
export const ATLAS_CELL_PX = ${CELL};
/** Fetched lazily, after the menu is interactive. Never bundled. */
export const ATLAS_URL = 'c/kenney-chars.png';

/** Model height in metres, feet at y=0. Scale by PLAYER_HEIGHT / this. */
export const RIG_HEIGHT = ${modelHeight};

/** The six meshes the GLB actually contains, in baked order. */
export const RIG_PART_NAMES = ${JSON.stringify(PART_ORDER)} as const;

/** Pivot of each part, metres, model space. Indexed by RIG_PART_NAMES order. */
export const RIG_PIVOTS: readonly (readonly [number, number, number])[] = [
${PART_ORDER.map((p) => `  [${w.get(p).x.toFixed(4)}, ${w.get(p).y.toFixed(4)}, ${w.get(p).z.toFixed(4)}],`).join('\n')}
];

/** One outfit donor: a cell in the atlas. */
export interface RigDonor { readonly key: string; readonly name: string; }
export const RIG_DONORS: readonly RigDonor[] = [
${ROSTER.map((r) => `  { key: '${r.key}', name: '${r.name}' },`).join('\n')}
];

const POS_Q = 1 / 1024;
const UV_Q = 1 / 65535;

function unpack(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function i16(b64: string): Int16Array {
  const u = unpack(b64);
  return new Int16Array(u.buffer, u.byteOffset, u.byteLength >> 1);
}
function u16(b64: string): Uint16Array {
  const u = unpack(b64);
  return new Uint16Array(u.buffer, u.byteOffset, u.byteLength >> 1);
}

/** Baked attribute arrays. Built on first call, then cached. */
export interface RigArrays {
  /** ${n} * 3 metres, feet at y = 0, +Z forward. */
  readonly position: Float32Array;
  /** ${n} * 2, already inside atlas cell 0. Add the donor offset. */
  readonly uv: Float32Array;
  /** ${n} * 3 — the point this vertex's part rotates about. */
  readonly pivot: Float32Array;
  /** ${n} — 0 head, 1 torso, 2 arms, 3 legs. */
  readonly zone: Float32Array;
  /** ${n} — baked flat-face shade, matching the voxel mesher's ramp. */
  readonly shade: Float32Array;
  readonly index: Uint16Array;
}

let cached: RigArrays | null = null;

export function rigArrays(): RigArrays {
  if (cached !== null) return cached;
  const qp = i16('${b64(qpos)}');
  const qv = i16('${b64(qpiv)}');
  const qu = u16('${b64(quv)}');
  const mi = unpack('${b64(misc)}');
  const n = ${n};
  const position = new Float32Array(n * 3);
  const pivot = new Float32Array(n * 3);
  for (let k = 0; k < n * 3; k++) { position[k] = qp[k] * POS_Q; pivot[k] = qv[k] * POS_Q; }
  const uv = new Float32Array(n * 2);
  for (let k = 0; k < n * 2; k++) uv[k] = qu[k] * UV_Q;
  const zone = new Float32Array(n);
  const shade = new Float32Array(n);
  for (let k = 0; k < n; k++) { zone[k] = mi[k * 2]; shade[k] = mi[k * 2 + 1] / 255; }
  cached = { position, uv, pivot, zone, shade, index: u16('${b64(idx)}') };
  return cached;
}
`;
  fs.mkdirSync(path.dirname(OUT_TS), { recursive: true });
  fs.writeFileSync(OUT_TS, src);
  return { verts: n, tris: idx.length / 3, tsBytes: Buffer.byteLength(src) };
}

/* ------------------------------------------------------------------------ */

assertIdenticalGeometry();
const baked = bakeGeometry();
const pngBytes = await buildAtlas();
const stats = emit(baked, pngBytes);

console.log(`atlas:    ${COLS}x${ROWS} x ${CELL}px -> ${(pngBytes / 1024).toFixed(1)} KB  (${ROSTER.length} donors)`);
console.log(`rig:      ${stats.verts} verts, ${stats.tris} tris, module ${(stats.tsBytes / 1024).toFixed(1)} KB`);
console.log(`vram:     ${((CELL * COLS * CELL * ROWS * 4) / 1048576).toFixed(2)} MB decoded (no mips)`);
console.log(`wrote     ${path.relative(repo, OUT_PNG)}`);
console.log(`wrote     ${path.relative(repo, OUT_TS)}`);
