/**
 * DOOMCRAFT — pure sample-domain DSP, and the structural contract the audio
 * layer is wired through.
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * `engine.ts`, `synth.ts`, `sfx.ts` and `spatial.ts` are owned by another agent
 * this round and were not on disk when this was written. Rather than guess at
 * their concrete classes and import a file that may never land, everything here
 * is either (a) a TYPE describing the narrowest thing a caller needs, satisfied
 * structurally by whatever the engine turns out to be, or (b) a pure function
 * over `Float32Array` that touches no Web Audio API at all. When `synth.ts`
 * lands with equivalents, the duplicates below are deleted and the callers
 * re-pointed; nothing in `monsters.ts`, `ambience.ts` or `music.ts` changes,
 * because none of them build a graph — they bake buffers and hand them over.
 *
 * WHY THE BAKING MODEL, AND WHY IT IS THE FAST ONE
 *
 * The project runs to a ~120 draw-call / 0.90 ms frame budget and audio must
 * not touch it. A demon that screams by assembling four oscillators, three
 * biquads and an envelope every time it sees you pays that cost on the MAIN
 * thread, at the exact moment the frame is already full of the thing that
 * screamed. So no voice in this layer is ever a graph: every sound is rendered
 * ONCE into an `AudioBuffer` and afterwards costs one `AudioBufferSourceNode`
 * plus one gain. The rendering is a plain sample loop over a typed array, which
 * has the second, larger benefit that it runs under `vitest` with no
 * `AudioContext` in sight — the demons' spectra are asserted in a unit test
 * rather than described in a comment.
 *
 * THE SAMPLE RATE IS A MEASUREMENT, NOT A PREFERENCE
 *
 * Every sound effect in DOOM's IWAD is an 11,025 Hz 8-bit DMX lump — 54 of the
 * 55 lumps in the shareware WAD, the lone exception being DSITMBK at 22,050.
 * Measured across all 55: the 95% spectral rolloff never exceeds 5,430 Hz,
 * because it cannot; Nyquist is 5,512. That band limit is a large part of why
 * DOOM sounds like DOOM, and it is free here: buffers are generated AT 11,025
 * and the browser resamples them up to the device rate on playback, so the
 * ceiling is enforced by construction rather than by a filter node, and every
 * bake costs a quarter of what it would at 44.1 kHz.
 *
 * (Measured by parsing the shareware DOOM1.WAD in a scratchpad. No sample, and
 * nothing derived from a sample, is in this repository or in the shipped
 * bundle — see `vendor/kenney-blocky-characters/README.md` for the standing
 * licence rule. What crossed the line is a table of numbers.)
 */

/** The four category buses plus the master, and the save keys they use. */
export type MixBus = 'master' | 'sfx' | 'music' | 'ambience' | 'ui';

/* ------------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------------ */

/**
 * Bake rate. DOOM's own, and therefore the band limit as well: nothing this
 * layer produces has energy above 5,512 Hz, which is what the WAD measures.
 */
export const BAKE_RATE = 11025;

/** Two-pi, spelled once. */
const TAU = Math.PI * 2;

/* ------------------------------------------------------------------------ *
 * Deterministic noise
 *
 * `Math.random` is not usable here: a baked buffer has to be identical between
 * a test run and the browser or the spectral assertions are theatre. This is
 * the same mulberry32 the simulation uses, inlined so the audio layer does not
 * allocate an `Rng` per sample.
 * ------------------------------------------------------------------------ */

export class NoiseSource {
  private a: number;
  constructor(seed: number) { this.a = seed >>> 0; }
  /** Uniform in [-1, 1). */
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 2147483648) - 1;
  }
}

/* ------------------------------------------------------------------------ *
 * Biquads — RBJ cookbook, evaluated one sample at a time
 *
 * A `BiquadFilterNode` would do this on the audio thread, but only for a LIVE
 * graph. Baking needs the maths in userland, and having it here is what makes
 * the formant structure of a demon testable.
 * ------------------------------------------------------------------------ */

export class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0;
  private a1 = 0; private a2 = 0;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;

  reset(): void { this.x1 = this.x2 = this.y1 = this.y2 = 0; }

  /** Constant-skirt bandpass with unity peak gain — the formant workhorse. */
  bandpass(freq: number, q: number, rate = BAKE_RATE): this {
    const w = TAU * Math.min(freq, rate * 0.49) / rate;
    const cs = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(0.05, q));
    const a0 = 1 + alpha;
    this.b0 = alpha / a0; this.b1 = 0; this.b2 = -alpha / a0;
    this.a1 = (-2 * cs) / a0; this.a2 = (1 - alpha) / a0;
    return this;
  }

  lowpass(freq: number, q: number, rate = BAKE_RATE): this {
    const w = TAU * Math.min(freq, rate * 0.49) / rate;
    const cs = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(0.05, q));
    const a0 = 1 + alpha;
    this.b0 = ((1 - cs) / 2) / a0; this.b1 = (1 - cs) / a0; this.b2 = this.b0;
    this.a1 = (-2 * cs) / a0; this.a2 = (1 - alpha) / a0;
    return this;
  }

  highpass(freq: number, q: number, rate = BAKE_RATE): this {
    const w = TAU * Math.min(freq, rate * 0.49) / rate;
    const cs = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(0.05, q));
    const a0 = 1 + alpha;
    this.b0 = ((1 + cs) / 2) / a0; this.b1 = -(1 + cs) / a0; this.b2 = this.b0;
    this.a1 = (-2 * cs) / a0; this.a2 = (1 - alpha) / a0;
    return this;
  }

  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
      - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/* ------------------------------------------------------------------------ *
 * Envelopes and curves
 * ------------------------------------------------------------------------ */

/**
 * Read a normalised breakpoint envelope at 0..1, linearly interpolated.
 *
 * The tables that use this are the eight-bucket peak envelopes measured off the
 * real lumps, which is why the shape is data and not an ADSR: DOOM's monster
 * voices are not ADSR-shaped. DSBRSSIT (the Baron) peaks in its FIFTH eighth
 * and is still at 35% in its last; an attack/decay pair cannot express that.
 */
export function envAt(shape: readonly number[], t01: number): number {
  const n = shape.length;
  if (n === 0) return 0;
  if (n === 1) return shape[0];
  const t = t01 <= 0 ? 0 : t01 >= 1 ? 1 : t01;
  const p = t * (n - 1);
  const i = Math.min(n - 2, Math.floor(p));
  const f = p - i;
  return shape[i] + (shape[i + 1] - shape[i]) * f;
}

/* ------------------------------------------------------------------------ *
 * Sources
 * ------------------------------------------------------------------------ */

/**
 * A glottal pulse train — the voice source for every demon in `monsters.ts`.
 *
 * This is the Rosenberg pulse: a cubic opening phase and a quadratic closing
 * phase, ASYMMETRIC, closing roughly three times faster than it opens. The
 * asymmetry is the whole point and it was learned the hard way. The obvious
 * source is a symmetric raised cosine over the open phase, and it sounds fine
 * in isolation, but its spectrum has deep periodic nulls at every multiple of
 * f0/openQuotient — and those nulls SWEEP WITH f0. Sweeping the Baron's
 * fundamental from 92 to 128 Hz with everything else held fixed moved its
 * spectral centroid 366, 484, 842, 1234, 1000, 599: not a trend, a comb, with
 * a null crossing a formant at each dip. One monster read as three different
 * animals depending on which cue it happened to be making.
 *
 * A real larynx closes far faster than it opens, and the sharp closure is what
 * gives a voice its smooth -12 dB/octave rolloff instead of a comb. Modelling
 * that removes the nulls, and the archetype's timbre stops depending on the
 * arithmetic coincidence of where a harmonic falls.
 *
 * Cheap, alias-free enough at 11 kHz, and it is the reason the baked voices
 * measure as TONAL — spectral flatness 0.003 to 0.39 across the real lumps,
 * median 0.07, which a noise-based scream cannot hit.
 */
export class Glottis {
  private phase = 0;
  /** 0..1 of the period the pulse occupies. Lower = brighter, buzzier. */
  openQuotient = 0.42;
  /** Fraction of the OPEN phase spent opening. The rest is the fast closure. */
  closeRatio = 0.72;

  reset(): void { this.phase = 0; }

  /** One sample at fundamental `f0` Hz. */
  step(f0: number, rate = BAKE_RATE): number {
    this.phase += f0 / rate;
    if (this.phase >= 1) this.phase -= Math.floor(this.phase);
    const oq = this.openQuotient <= 0.02 ? 0.02 : this.openQuotient;
    const p = this.phase;
    if (p >= oq) return -0.25;
    const o1 = oq * this.closeRatio;
    if (p < o1) {
      const u = p / o1;
      return (3 * u * u - 2 * u * u * u) - 0.25;   // smooth cubic opening
    }
    const u = (p - o1) / (oq - o1);
    return (1 - u * u) - 0.25;                      // fast quadratic closure
  }
}

/* ------------------------------------------------------------------------ *
 * Seamless loops
 *
 * A looped noise buffer clicks at the wrap unless the signal is genuinely
 * periodic at the loop length. Crossfading the tail over the head is the usual
 * dodge and it audibly ducks. This does it properly: the loop is a sum of
 * sinusoids at EXACT integer multiples of 1/length with random phase, so the
 * waveform and every derivative match across the seam by construction. Any
 * spectrum can be dialled in by weighting the partials, and the cost is paid
 * once, at 11 kHz, for a buffer that then runs for the whole level.
 * ------------------------------------------------------------------------ */

/** Spectral weight for a partial at `hz`. Return 0 to omit it entirely. */
export type SpectrumFn = (hz: number) => number;

/** Lowest partial `bakeLoop` will consider. Below this is rumble, not tone. */
const LOOP_MIN_HZ = 18;

/**
 * Render `seconds` of perfectly-looping noise shaped by `spectrum`.
 *
 * The partials are LOG-SPACED across the band rather than being the first N
 * harmonics of 1/seconds, and that is not a refinement — it is the difference
 * between working and not. A 6.1-second loop has a fundamental of 0.164 Hz, so
 * "the first 200 harmonics" reaches 33 Hz and nothing above it: the first
 * version of this measured a spectral centroid of 28 Hz for a room tone that
 * was supposed to sit at 190. Log spacing puts the budget where the ear is,
 * with about a 2.5% frequency step, which is well inside a critical band at
 * every frequency and therefore reads as noise rather than as a chord.
 *
 * Every partial is still an EXACT integer multiple of 1/seconds, which is what
 * makes the wrap seamless; the log spacing only chooses WHICH integers.
 */
export function bakeLoop(
  seconds: number, spectrum: SpectrumFn, seed: number,
  partials = 220, rate = BAKE_RATE,
): Float32Array {
  const n = Math.max(1, Math.round(seconds * rate));
  const out = new Float32Array(n);
  const rng = new NoiseSource(seed);
  const nyq = rate * 0.5;

  // Candidate harmonic indices, log-spaced, de-duplicated.
  const kLo = Math.max(1, Math.round(LOOP_MIN_HZ * seconds));
  const kHi = Math.max(kLo + 1, Math.floor(nyq * 0.98 * seconds));
  const want = Math.max(8, partials);
  const chosen: number[] = [];
  let last = -1;
  for (let s2 = 0; s2 < want; s2++) {
    const k = Math.round(kLo * Math.pow(kHi / kLo, s2 / (want - 1)));
    if (k === last) continue;
    last = k;
    chosen.push(k);
  }

  let peak = 0;
  for (const k of chosen) {
    const hz = k / seconds;
    const amp = spectrum(hz);
    if (!(amp > 0)) continue;
    const phase = rng.next() * Math.PI;
    const w = TAU * k / n;
    // Recurrence instead of a Math.sin per sample: two multiplies and an add.
    const c = Math.cos(w);
    const sw = Math.sin(w);
    let sn = Math.sin(phase);
    let cn = Math.cos(phase);
    for (let i = 0; i < n; i++) {
      out[i] += amp * sn;
      const t = sn * c + cn * sw;
      cn = cn * c - sn * sw;
      sn = t;
    }
  }
  for (let i = 0; i < n; i++) { const a = out[i] < 0 ? -out[i] : out[i]; if (a > peak) peak = a; }
  if (peak > 0) { const g = 0.92 / peak; for (let i = 0; i < n; i++) out[i] *= g; }
  return out;
}

/** Pink-ish 1/f weighting, rolled off below `lo` and above `hi`. */
export function bandSpectrum(lo: number, hi: number, tilt = 1): SpectrumFn {
  return (hz) => {
    if (hz < lo * 0.25 || hz > hi * 3) return 0;
    const loRoll = hz < lo ? (hz / lo) ** 2 : 1;
    const hiRoll = hz > hi ? (hi / hz) ** 2 : 1;
    return (loRoll * hiRoll) / Math.pow(hz / lo, tilt);
  };
}

/* ------------------------------------------------------------------------ *
 * Measurement — the same numbers the WAD was measured with
 *
 * These exist so the tests can hold the synthesis to the measurements instead
 * of to an opinion. `spectralCentroid` on a baked Imp has to land in the band
 * the real Imp lumps landed in, and every archetype has to be separable from
 * every other one; that assertion is what "identifiable by sound alone" means
 * in a form a machine can check.
 * ------------------------------------------------------------------------ */

/**
 * Welch power spectrum: 512-sample Hann windows at 50% overlap, averaged.
 *
 * The window length is not a detail, it is the whole measurement. The obvious
 * implementation probes a long window (4,096 samples, a 2.7 Hz main lobe) at
 * each of `bins` evenly spaced frequencies — and at 96 bins across 5,512 Hz
 * those probes are 57 Hz apart, so a voice with a 104 Hz fundamental is being
 * sampled BETWEEN its own harmonics. The result is a comb, and it moves as the
 * fundamental moves: sweeping a Baron from 92 to 128 Hz produced centroids of
 * 826, 951, 877, 365, 517, 840, 1082, 1254, 820, 661 — which reads exactly like
 * a synthesis instability and is not one. Short windows have a main lobe wider
 * than the bin spacing, so every bin integrates real energy instead of
 * sampling a point, and averaging several of them across the clip removes the
 * dependence on which part of the utterance got looked at.
 */
function powerSpectrum(x: Float32Array, bins: number, rate: number): { f: Float64Array; p: Float64Array } {
  const f = new Float64Array(bins);
  const p = new Float64Array(bins);
  const W = Math.min(512, x.length);
  const hop = Math.max(1, W >> 1);
  const nwin = Math.max(1, Math.floor((x.length - W) / hop) + 1);
  const nyq = rate * 0.5;
  const win = new Float64Array(W);
  for (let i = 0; i < W; i++) win[i] = 0.5 - 0.5 * Math.cos(TAU * i / Math.max(1, W - 1));
  for (let b = 0; b < bins; b++) {
    const hz = (b + 0.5) * nyq / bins;
    f[b] = hz;
    const w = TAU * hz / rate;
    const c = Math.cos(w); const s = Math.sin(w);
    let acc = 0;
    for (let k = 0; k < nwin; k++) {
      const off = k * hop;
      let re = 0; let im = 0; let cn = 1; let sn = 0;
      for (let i = 0; i < W; i++) {
        const v = x[off + i] * win[i];
        re += v * cn; im += v * sn;
        const t = cn * c - sn * s;
        sn = sn * c + cn * s;
        cn = t;
      }
      acc += re * re + im * im;
    }
    p[b] = acc / nwin;
  }
  return { f, p };
}

/** Energy-weighted mean frequency, Hz. The single best "is it bright" number. */
export function spectralCentroid(x: Float32Array, rate = BAKE_RATE, bins = 96): number {
  const { f, p } = powerSpectrum(x, bins, rate);
  let num = 0; let den = 0;
  for (let b = 0; b < bins; b++) { num += f[b] * p[b]; den += p[b]; }
  return den > 0 ? num / den : 0;
}

/** Geometric mean over arithmetic mean of the power spectrum: 0 tonal, 1 noise. */
export function spectralFlatness(x: Float32Array, rate = BAKE_RATE, bins = 96): number {
  const { p } = powerSpectrum(x, bins, rate);
  let logSum = 0; let sum = 0;
  for (let b = 0; b < bins; b++) { const v = p[b] + 1e-20; logSum += Math.log(v); sum += v; }
  const geo = Math.exp(logSum / bins);
  const ari = sum / bins;
  return ari > 0 ? geo / ari : 0;
}

/** Peak absolute sample. */
export function peakOf(x: Float32Array): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > m) m = a; }
  return m;
}

/** Root-mean-square over the whole buffer. */
export function rmsOf(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return x.length > 0 ? Math.sqrt(s / x.length) : 0;
}

/**
 * The seam test, as a number.
 *
 * The wrap discontinuity — the step from the last sample back to the first —
 * divided by the RMS of the steps the buffer already takes inside itself. A
 * genuinely periodic loop scores about 1, because its wrap IS an ordinary step
 * and there is nothing special about it. A loop that is not periodic scores in
 * the tens or hundreds, because its wrap is a jump of order the signal
 * amplitude against steps of order the signal's slope.
 *
 * Normalising by the RMS step rather than the largest one is what makes the
 * number mean something: against the largest step, any periodic loop scores
 * some arbitrary fraction under 1 and the test cannot tell a good loop from a
 * lucky one.
 */
export function seamRatio(x: Float32Array): number {
  if (x.length < 3) return 0;
  let sumSq = 0;
  for (let i = 1; i < x.length; i++) { const d = x[i] - x[i - 1]; sumSq += d * d; }
  const rmsStep = Math.sqrt(sumSq / (x.length - 1));
  const wrap = Math.abs(x[0] - x[x.length - 1]);
  return rmsStep > 0 ? wrap / rmsStep : 0;
}

/** Normalise in place to a target peak, and return the gain that was applied. */
export function normalise(x: Float32Array, target = 0.9): number {
  const p = peakOf(x);
  if (p <= 0) return 0;
  const g = target / p;
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return g;
}

/**
 * Resample a baked buffer from `from` Hz to `to` Hz, Catmull-Rom.
 *
 * `engine.ts` builds its `AudioBuffer`s at `ctx.sampleRate`, so everything this
 * layer bakes has to arrive there. Baking at the device rate instead would
 * work and would be four times the arithmetic for a signal whose top octave is
 * empty by construction; resampling a 5.5 kHz-limited signal up to 48 kHz is
 * the cheap direction and the interpolator's error sits entirely above the
 * band the signal occupies.
 *
 * `wrap` matters for the ambience loops and only for them: a loop's last
 * sample's right-hand neighbour is its FIRST sample, and interpolating against
 * a zero there would put back the exact discontinuity `bakeLoop` exists to
 * avoid.
 */
export function resampleTo(data: Float32Array, from: number, to: number, wrap = false): Float32Array {
  if (from === to || data.length === 0) return data;
  const ratio = to / from;
  const n = Math.max(1, Math.round(data.length * ratio));
  const out = new Float32Array(n);
  const last = data.length - 1;
  const at = (i: number): number => {
    if (wrap) { let k = i % data.length; if (k < 0) k += data.length; return data[k]; }
    return data[i < 0 ? 0 : i > last ? last : i];
  };
  for (let i = 0; i < n; i++) {
    const src = i / ratio;
    const i1 = Math.floor(src);
    const t = src - i1;
    const p0 = at(i1 - 1); const p1 = at(i1); const p2 = at(i1 + 1); const p3 = at(i1 + 2);
    out[i] = p1 + 0.5 * t * (p2 - p0
      + t * (2 * p0 - 5 * p1 + 4 * p2 - p3
        + t * (3 * (p1 - p2) + p3 - p0)));
  }
  return out;
}
