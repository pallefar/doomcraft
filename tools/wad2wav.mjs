/**
 * DOOMCRAFT — decode DMX sound lumps out of a DOOM IWAD.
 *
 * The reference material for every weapon in this game is DOOM 1.9's own sound
 * lumps, and `ref/doom/doom-gameplay.webm` cannot supply them: it is a
 * Playwright `canvas.captureStream()` recording, which is video only — ffprobe
 * reports exactly one stream in it. So the ruler is the WAD.
 *
 * No sample ever ships. This tool exists so a measurement can be REPRODUCED:
 * point it at a shareware DOOM1.WAD, get WAVs in a scratch directory, measure
 * them, throw them away.
 *
 *   node tools/wad2wav.mjs --wad /path/DOOM1.WAD --out /tmp/doomsfx [--list]
 *   node tools/wad2wav.mjs --wad ... --out ... DSSHOTGN DSBAREXP
 *
 * The md5 of the shareware v1.9 IWAD is f0cefca49926d00903cf57551d901abe; the
 * tool prints what it saw and refuses nothing, but a mismatch is worth knowing
 * about before you quote a number from it.
 *
 * DMX format (the only one DOOM ships): u16 format tag = 3, u16 sample rate,
 * u32 sample count, then that many UNSIGNED 8-bit samples. The first and last
 * 16 bytes are pad — DMX's own interpolator reads past both ends — and they are
 * counted in the header's length, so they must be dropped or every lump gains
 * 1.5 ms of DC at each end.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KNOWN_SHAREWARE_MD5 = 'f0cefca49926d00903cf57551d901abe';
const DMX_PAD = 16;

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(k);

/** Every `DS*` lump in the WAD, decoded to Float32 in [-1, 1]. */
export function readWad(wadPath) {
  const buf = fs.readFileSync(wadPath);
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== 'IWAD' && magic !== 'PWAD') throw new Error(`not a WAD: magic ${JSON.stringify(magic)}`);
  const numLumps = buf.readInt32LE(4);
  const dirOfs = buf.readInt32LE(8);
  const lumps = new Map();
  for (let i = 0; i < numLumps; i++) {
    const o = dirOfs + i * 16;
    const filepos = buf.readInt32LE(o);
    const size = buf.readInt32LE(o + 4);
    const name = buf.toString('ascii', o + 8, o + 16).replace(/\0+$/, '');
    lumps.set(name, { filepos, size });
  }
  return { buf, lumps, md5: crypto.createHash('md5').update(buf).digest('hex') };
}

/** Decode one DMX lump. Returns { sampleRate, samples: Float32Array } or null. */
export function decodeDmx(buf, entry) {
  if (entry.size < 8) return null;
  const p = entry.filepos;
  const fmt = buf.readUInt16LE(p);
  if (fmt !== 3) return null;
  const rate = buf.readUInt16LE(p + 2);
  let count = buf.readUInt32LE(p + 4);
  if (count > entry.size - 8) count = entry.size - 8;
  // Drop DMX's leading/trailing guard pad, which is DC at the signal's own
  // first/last value and would otherwise show up as a click and a DC term.
  let from = p + 8;
  let n = count;
  if (n > DMX_PAD * 2 + 1) { from += DMX_PAD; n -= DMX_PAD * 2; }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (buf[from + i] - 128) / 128;
  return { sampleRate: rate, samples: out };
}

export function writeWav(file, samples, sampleRate) {
  const n = samples.length;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    let v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const wadPath = arg('--wad', '');
  if (!wadPath) { console.error('usage: node tools/wad2wav.mjs --wad DOOM1.WAD --out DIR [LUMP...]'); process.exit(2); }
  const { buf, lumps, md5 } = readWad(wadPath);
  console.log(`[wad] ${wadPath}  md5=${md5}${md5 === KNOWN_SHAREWARE_MD5 ? ' (DOOM 1.9 shareware, verified)' : ' (UNKNOWN BUILD)'}`);
  const names = process.argv.slice(2).filter((a) => /^DS[A-Z0-9]+$/.test(a));
  const wanted = names.length > 0 ? names : [...lumps.keys()].filter((k) => k.startsWith('DS'));
  if (has('--list')) {
    for (const name of wanted) {
      const d = decodeDmx(buf, lumps.get(name));
      if (d) console.log(`${name}\t${d.sampleRate} Hz\t${d.samples.length} samples\t${(1000 * d.samples.length / d.sampleRate).toFixed(0)} ms`);
    }
    process.exit(0);
  }
  const out = arg('--out', '');
  if (!out) { console.error('--out DIR required'); process.exit(2); }
  fs.mkdirSync(out, { recursive: true });
  let n = 0;
  for (const name of wanted) {
    const e = lumps.get(name);
    if (!e) { console.error(`[wad] no lump ${name}`); continue; }
    const d = decodeDmx(buf, e);
    if (!d) { console.error(`[wad] ${name} is not a DMX sound`); continue; }
    writeWav(path.join(out, `${name}.wav`), d.samples, d.sampleRate);
    n++;
  }
  console.log(`[wad] wrote ${n} lumps to ${out}`);
}
