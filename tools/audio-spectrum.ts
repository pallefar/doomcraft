/**
 * DOOMCRAFT — spectral verifier for the sound catalogue.
 *
 * The question this answers is the only one that matters about a synthesised
 * gun: does it occupy the same part of the spectrum as the thing it claims to
 * copy? Loudness, envelope and "does it sound good in isolation" all pass
 * trivially and none of them catch a shotgun that reads as a door slam.
 *
 * It measures OUR baked PCM (the real `render()` over the real `SoundSpec`, so
 * there is no second implementation to drift) against DOOM 1.9's own DMX lumps
 * decoded straight out of a shareware IWAD by `tools/wad2wav.mjs`.
 *
 *   node --import tsx tools/audio-spectrum.ts --wad /path/DOOM1.WAD
 *   npx tsx --tsconfig client/tsconfig.json tools/audio-spectrum.ts --wad ...
 *
 * Options:
 *   --wad PATH     the IWAD to measure against (required for the DOOM column)
 *   --rate N       our render rate (default 48000, what a browser gives us)
 *   --json PATH    also dump every number as JSON
 *   --pairs a=b,…  override the lump↔sound pairing
 *
 * ── Definitions, stated because "spectral centroid" is not one number ─────
 *
 * All four global metrics come from ONE FFT over the whole sound, Hann
 * windowed, zero-padded to the next power of two, on the peak-normalised
 * signal. That is deliberate: a per-frame mean silently weights 900 ms of tail
 * the same as the 20 ms transient, and the failure being hunted here is
 * precisely "bright for 20 ms, dark for the rest".
 *
 *   centroid   Sum(f·|X|) / Sum(|X|)                 — magnitude weighted
 *   rolloff85  lowest f with cumulative |X| >= 85%   — magnitude weighted
 *   band share Sum(|X|^2 in band) / Sum(|X|^2)       — POWER, as labelled
 *   flatness   mean over 46 ms Hann frames of geomean(|X|)/mean(|X|). Frame
 *              based, and on MAGNITUDE: a whole-signal power flatness is
 *              dominated by the deepest null in the spectrum and reads ~0 for
 *              everything, which distinguishes nothing.
 *
 * Every one of them is summed over 20 Hz .. 5512 Hz and nothing else. 5512 is
 * DOOM's own Nyquist: the reference contains, by construction, nothing above
 * it, and our renders are band-limited there too. Letting the sum run to a
 * 48 kHz Nyquist would compare DOOM's real spectrum against 18 kHz of our
 * numerical silence — harmless for the centroid, fatal for the flatness, whose
 * geometric mean is then set entirely by empty bins and reads 0.000 for every
 * sound we could possibly write.
 *
 * The time-resolved track is the decisive one and is separate: 2–5 kHz RMS per
 * 20 ms frame, in dBFS against a peak of 1.0, which is what showed that DOOM
 * holds its top end for 800 ms and a one-shot crack layer does not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain ESM sibling, no types
import { readWad, decodeDmx } from './wad2wav.mjs';
import { specById } from '@/audio/sfx';
import { render } from '@/audio/synth';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d;
};

/* ------------------------------------------------------------------ FFT -- */

/** In-place iterative radix-2 FFT. `re`/`im` are length 2^k. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function nextPow2(n: number): number { let p = 1; while (p < n) p <<= 1; return p; }

/** Magnitude spectrum (bins 0..N/2) of a Hann-windowed signal. */
function magnitudeSpectrum(x: Float32Array): { mag: Float64Array; binHz: (i: number) => number; n: number } {
  const n = nextPow2(x.length);
  const re = new Float64Array(n), im = new Float64Array(n);
  const L = x.length;
  for (let i = 0; i < L; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (L - 1)));
  fft(re, im);
  const half = n >> 1;
  const mag = new Float64Array(half);
  for (let i = 0; i < half; i++) mag[i] = Math.hypot(re[i], im[i]);
  return { mag, binHz: (i: number) => i, n };
}

/* -------------------------------------------------------------- metrics -- */

export interface Spectral {
  durationMs: number;
  peak: number;
  rms: number;
  crestDb: number;
  centroidHz: number;
  rolloff85Hz: number;
  band2to6: number;
  band2to5: number;
  sub200: number;
  flatness: number;
  /** 2–5 kHz RMS per 20 ms frame, dBFS at peak 1.0. */
  track: number[];
  trackMs: number;
  /** Fraction of the sound's length whose 2–5 kHz level is within 8 dB of the loudest frame. */
  topSustain: number;
  /** Samples at or beyond 99% of full scale, as a fraction — hard clipping. */
  clipFraction: number;
}

function peakOf(x: Float32Array): number {
  let m = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; }
  return m;
}

function normalised(x: Float32Array): Float32Array {
  const p = peakOf(x);
  if (p <= 1e-9) return x;
  const out = new Float32Array(x.length);
  const s = 1 / p;
  for (let i = 0; i < x.length; i++) out[i] = x[i] * s;
  return out;
}

/** One biquad bandpass, used only for the time-resolved band track. */
function bandpassed(x: Float32Array, sr: number, lo: number, hi: number): Float32Array {
  const out = Float32Array.from(x);
  const stage = (f: number, kind: 'hp' | 'lp'): void => {
    const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
    const cw = Math.cos(w), sw = Math.sin(w);
    const alpha = sw / (2 * 0.707);
    const a0 = 1 + alpha;
    const b0 = kind === 'lp' ? ((1 - cw) / 2) / a0 : ((1 + cw) / 2) / a0;
    const b1 = kind === 'lp' ? (1 - cw) / a0 : (-(1 + cw)) / a0;
    const b2 = b0;
    const a1 = (-2 * cw) / a0, a2 = (1 - alpha) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < out.length; i++) {
      const x0 = out[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      out[i] = y0;
    }
  };
  // 4th order each side: the band has to actually be the band, or a 64 dB
  // louder neighbour leaks in and the whole track is a measurement of the bass.
  stage(lo, 'hp'); stage(lo, 'hp'); stage(hi, 'lp'); stage(hi, 'lp');
  return out;
}

const TRACK_MS = 20;
/** DOOM's own Nyquist. Every global metric is summed over 20 Hz .. this. */
const ANALYSIS_HI_HZ = 5512;

/**
 * Frame-based spectral flatness on the magnitude spectrum.
 *
 * This is the metric that separates NOISE from RESONANCE, which is the whole
 * difference between DOOM's shotgun and a synthesised one: a lump recorded off
 * a real gun is broadband hash (flatness ~0.57), a stack of filtered layers is
 * a handful of peaks (flatness ~0.16) however loud it is.
 */
function frameFlatness(x: Float32Array, sr: number): number {
  const N = nextPow2(Math.round((0.0464 * sr)));
  if (x.length < N) return 0;
  const hop = N >> 2;
  const hiBin = Math.min(N >> 1, Math.floor((ANALYSIS_HI_HZ * N) / sr));
  const re = new Float64Array(N), im = new Float64Array(N);
  let acc = 0, frames = 0;
  for (let s = 0; s + N <= x.length; s += hop) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < N; i++) re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    fft(re, im);
    let ls = 0, as = 0, c = 0;
    for (let i = 1; i < hiBin; i++) { const m = Math.hypot(re[i], im[i]); ls += Math.log(m + 1e-20); as += m; c++; }
    acc += Math.exp(ls / c) / Math.max(1e-20, as / c);
    frames++;
  }
  return frames > 0 ? acc / frames : 0;
}

export function analyse(raw: Float32Array, sr: number): Spectral {
  const x = normalised(raw);
  const { mag } = magnitudeSpectrum(x);
  const nfft = mag.length * 2;
  const hz = (i: number): number => (i * sr) / nfft;

  let sumMag = 0, sumFMag = 0, sumPow = 0, pow26 = 0, pow25 = 0, powSub = 0;
  const loBin = Math.max(1, Math.ceil((20 * nfft) / sr));
  const hiBin = Math.min(mag.length, Math.floor((ANALYSIS_HI_HZ * nfft) / sr) + 1);
  for (let i = loBin; i < hiBin; i++) {
    const m = mag[i], p = m * m, f = hz(i);
    sumMag += m; sumFMag += f * m; sumPow += p;
    if (f >= 2000 && f < 6000) pow26 += p;
    if (f >= 2000 && f < 5000) pow25 += p;
    if (f < 200) powSub += p;
  }
  let cum = 0, rolloff = 0;
  const target = 0.85 * sumMag;
  for (let i = loBin; i < hiBin; i++) {
    cum += mag[i];
    if (cum >= target) { rolloff = hz(i); break; }
  }
  /* time-resolved 2–5 kHz */
  const band = bandpassed(x, sr, 2000, 5000);
  const step = Math.max(1, Math.round((TRACK_MS * sr) / 1000));
  const track: number[] = [];
  for (let i = 0; i + step <= band.length; i += step) {
    let s = 0;
    for (let k = i; k < i + step; k++) s += band[k] * band[k];
    track.push(20 * Math.log10(Math.sqrt(s / step) + 1e-9));
  }
  const top = track.length ? Math.max(...track) : -120;
  const sustain = track.length ? track.filter((v) => v >= top - 8).length / track.length : 0;

  let sq = 0, clipped = 0;
  for (let i = 0; i < x.length; i++) { sq += x[i] * x[i]; if (Math.abs(x[i]) >= 0.99) clipped++; }
  const rms = Math.sqrt(sq / Math.max(1, x.length));

  return {
    durationMs: (1000 * x.length) / sr,
    peak: peakOf(raw), rms,
    crestDb: 20 * Math.log10(1 / Math.max(rms, 1e-9)),
    centroidHz: sumFMag / Math.max(1e-12, sumMag),
    rolloff85Hz: rolloff,
    band2to6: pow26 / Math.max(1e-12, sumPow),
    band2to5: pow25 / Math.max(1e-12, sumPow),
    sub200: powSub / Math.max(1e-12, sumPow),
    flatness: frameFlatness(x, sr),
    track, trackMs: TRACK_MS,
    topSustain: sustain,
    clipFraction: clipped / Math.max(1, x.length),
  };
}

/* ------------------------------------------------------------------ main -- */

const PAIRS: Array<[string, string, string]> = [
  ['DSSHOTGN', 'w1.fire', 'shotgun'],
  ['DSBAREXP', 'exp.s', 'explosion (small)'],
  ['DSBAREXP', 'exp.b', 'explosion (big)'],
  ['DSPISTOL', 'w0.fire', 'pistol'],
  ['DSRLAUNC', 'w3.fire', 'rocket'],
];

function fmtTrack(t: number[], everyMs: number, stepMs: number, maxMs: number): string {
  const stride = Math.max(1, Math.round(stepMs / everyMs));
  const out: string[] = [];
  for (let i = 0; i < t.length && i * everyMs <= maxMs; i += stride) {
    out.push(`${Math.round(i * everyMs)}ms:${t[i].toFixed(0)}`);
  }
  return out.join('  ');
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const wadPath = arg('--wad', '');
  const rate = Number(arg('--rate', '48000'));
  const jsonOut = arg('--json', '');
  if (!wadPath || !fs.existsSync(wadPath)) {
    console.error('--wad PATH to a DOOM IWAD is required'); process.exit(2);
  }
  const { buf, lumps, md5 } = readWad(wadPath);
  console.log(`[wad] md5=${md5}`);
  console.log(`[ours] rendered by the real render() at ${rate} Hz, mean of seeds 1 / 4242 / 777\n`);

  /* Three seeds, averaged.
   *
   * `render` draws every layer from ONE rng stream, and the `body` layer
   * renormalises itself to whatever peak its noise realisation happened to
   * reach — so a single seed moves the 2-6 kHz share by around 10% on its own.
   * Quoting one seed as a measurement would be quoting a lottery. */
  const SEEDS = [1, 4242, 777];
  const rows: Record<string, unknown>[] = [];
  const H = ['metric', 'DOOM', 'OURS', ''];
  for (const [lump, id, label] of PAIRS) {
    const e = lumps.get(lump);
    if (!e) { console.error(`no lump ${lump}`); continue; }
    const d = decodeDmx(buf, e) as { sampleRate: number; samples: Float32Array };
    const spec = specById(id);
    if (!spec) { console.error(`no sound ${id}`); continue; }
    const A = analyse(d.samples, d.sampleRate);
    const each = SEEDS.map((sd) => analyse(render(spec, rate, sd), rate));
    const avg = (pick: (s: Spectral) => number): number =>
      each.reduce((t, s) => t + pick(s), 0) / each.length;
    const B: Spectral = {
      durationMs: avg((s) => s.durationMs), peak: avg((s) => s.peak), rms: avg((s) => s.rms),
      crestDb: avg((s) => s.crestDb), centroidHz: avg((s) => s.centroidHz),
      rolloff85Hz: avg((s) => s.rolloff85Hz), band2to6: avg((s) => s.band2to6),
      band2to5: avg((s) => s.band2to5), sub200: avg((s) => s.sub200),
      flatness: avg((s) => s.flatness),
      track: each[0].track.map((_, i) => each.reduce((t, s) => t + (s.track[i] ?? -180), 0) / each.length),
      trackMs: TRACK_MS, topSustain: avg((s) => s.topSustain),
      clipFraction: avg((s) => s.clipFraction),
    };

    console.log(`══ ${label}   ${lump} vs ${id} ${'═'.repeat(Math.max(0, 46 - label.length - lump.length - id.length))}`);
    const line = (name: string, a: number, b: number, dp = 3, unit = ''): void => {
      const f = (v: number): string => (dp === 0 ? String(Math.round(v)) : v.toFixed(dp));
      console.log(`  ${name.padEnd(26)}${(f(a) + unit).padStart(10)}${(f(b) + unit).padStart(12)}`);
    };
    console.log(`  ${'metric'.padEnd(26)}${'DOOM'.padStart(10)}${'OURS'.padStart(12)}`);
    line('duration ms', A.durationMs, B.durationMs, 0);
    line('spectral centroid Hz', A.centroidHz, B.centroidHz, 0);
    line('rolloff 85% Hz', A.rolloff85Hz, B.rolloff85Hz, 0);
    line('2-6 kHz share (power)', A.band2to6, B.band2to6, 4);
    line('2-5 kHz share (power)', A.band2to5, B.band2to5, 4);
    line('<200 Hz share (power)', A.sub200, B.sub200, 3);
    line('spectral flatness', A.flatness, B.flatness, 3);
    line('crest dB', A.crestDb, B.crestDb, 1);
    line('clipped samples', A.clipFraction, B.clipFraction, 3);
    line('2-5k sustain (>=top-8dB)', A.topSustain, B.topSustain, 2);
    console.log(`  2-5 kHz track, dBFS per ${TRACK_MS} ms:`);
    console.log(`    DOOM  ${fmtTrack(A.track, TRACK_MS, 100, 1000)}`);
    console.log(`    OURS  ${fmtTrack(B.track, TRACK_MS, 100, 1000)}`);
    console.log('');
    rows.push({ label, lump, id, doom: A, ours: B });
  }
  void H;
  if (jsonOut) {
    fs.writeFileSync(path.resolve(ROOT, jsonOut), JSON.stringify(rows, null, 2));
    console.log(`[json] ${jsonOut}`);
  }
}
