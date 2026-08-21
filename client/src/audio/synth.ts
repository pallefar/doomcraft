/**
 * DOOMCRAFT — synthesis primitives.
 *
 * Every sound in this game is computed, not fetched. `docs/INFRASTRUCTURE.md`
 * puts cold transfer at 1.23 MB against voxiom's 12.6 MB and time-to-interactive
 * at 305 ms against their 3,161 ms; a sound pack is the one thing that could
 * hand that lead back. So the catalogue is DATA — a `SoundSpec` is a plain
 * object — and this file is the renderer that turns data into PCM.
 *
 * ── The numbers here are measured, not remembered ─────────────────────────
 *
 * The premise handed to this work was that `ref/doom/doom-gameplay.webm` has an
 * audio track to analyse. It does not: it is a Playwright canvas capture, and
 * Playwright records video only. `ffprobe` reports exactly one stream (vp9,
 * video) in that file and in every other capture under `ref/`. Working from the
 * video would have meant working from memory, which the brief explicitly ruled
 * out, so the grounding came from the source instead: DOOM 1.9 shareware, the
 * same build `ref/doom/doom-metrics.json` records archive.org as serving to
 * em-dosbox, whose DOOM1.WAD carries the original DMX sound lumps as 11025 Hz
 * 8-bit unsigned PCM. Those lumps were decoded and measured directly. Nothing
 * was downloaded into the repo and no sample ships — the WAD was a ruler, and
 * what survives here is a table of numbers.
 *
 * What the measurements actually said, and where each one shows up below:
 *
 *  1. **DOOM's shotgun is not a click, it is a roar.** DSSHOTGN runs 854 ms:
 *     a 410 ms PLATEAU that never drops more than 6 dB below its own peak,
 *     then a 420 ms tail. The obvious synthesis — a 60 ms noise burst under an
 *     exponential decay — is wrong by an order of magnitude in length and wrong
 *     in shape. Hence `Env` has an explicit `holdMs` between attack and decay,
 *     and hence the shotgun's hold is the longest in the catalogue.
 *
 *  2. **It is dark.** 85% of DSSHOTGN's energy is below 548 Hz and 64.6% is
 *     below 200 Hz, with the dominant peak at 153 Hz. This is why `lowpass`
 *     and a resonant `body` layer exist and why the shotgun leans on both.
 *     A bright noise burst reads as a cap gun no matter how loud it is.
 *
 *  3. **It is saturated, not merely loud.** Crest factor 13.8 dB with the
 *     samples touching both 8-bit rails. You cannot reach that by scaling an
 *     envelope; you reach it by driving a waveshaper. Hence `saturate`.
 *
 *  4. **The medium is part of the sound.** 11025 Hz means nothing above
 *     5512 Hz ever existed, and 8-bit unsigned means 256 levels of quantisation
 *     hiss under everything. Hence `bandLimitHz` defaults to 5512 and
 *     `bitcrush` defaults to 8 bits. Skipping these is the single biggest
 *     reason synthesised "Doom" sounds come out sounding like a modern
 *     synthesiser playing a Doom-shaped patch.
 *
 * ── The performance contract ──────────────────────────────────────────────
 *
 * These functions run ONCE per sound variant, at unlock, and write into an
 * AudioBuffer that is then reused forever. They are deliberately plain scalar
 * loops over Float32Array: no Web Audio graph, no OfflineAudioContext, no
 * allocation beyond the one output buffer. A shot at runtime costs one
 * `createBufferSource` and nothing else — see `engine.ts` for the measurement
 * that made that the design.
 */

/* ------------------------------------------------------------------------ *
 * Deterministic noise
 * ------------------------------------------------------------------------ */

/**
 * A sound must be reproducible: the same spec and the same seed give the same
 * PCM on every device, so a variant is a fixed thing we can reason about rather
 * than whatever `Math.random` happened to produce on that machine.
 */
export function makeRng(seed: number): () => number {
  let s = (seed | 0) || 0x9e3779b9;
  return function next(): number {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    // >>> 0 then scale: a full 32-bit mantissa mapped to [-1, 1).
    return ((s >>> 0) / 0x80000000) - 1;
  };
}

/* ------------------------------------------------------------------------ *
 * Envelope
 * ------------------------------------------------------------------------ */

/**
 * Attack / hold / decay, with the hold segment as a first-class citizen.
 *
 * The hold is the whole reason this is not a two-stage ADSR: measurement (1)
 * above found a 410 ms near-flat plateau in the shotgun, and a plateau is not
 * expressible as "a slow decay" — a slow exponential is 6 dB down a third of
 * the way through, and the real thing is not.
 */
export interface Env {
  /** Time to full amplitude. DSPISTOL reaches peak inside one 10 ms frame. */
  attackMs: number;
  /** Time held within a few dB of peak before the decay starts. */
  holdMs: number;
  /** Time from the end of the hold to silence. */
  decayMs: number;
  /**
   * Decay shape. 1 = linear, >1 = holds level then drops late (percussive
   * tails), <1 = drops fast then lingers. Measured tails sit near 2.2.
   */
  curve?: number;
  /** Level the hold segment sits at relative to the attack peak, 0..1. */
  hold?: number;
}

/** Envelope value at `t` seconds. */
export function envAt(e: Env, t: number): number {
  const a = e.attackMs / 1000;
  const h = e.holdMs / 1000;
  const d = e.decayMs / 1000;
  const holdLevel = e.hold ?? 1;
  if (t < 0) return 0;
  if (t < a) return a <= 0 ? 1 : (t / a);
  if (t < a + h) {
    // Ease from the attack peak down to the hold level across the plateau, so
    // a plateau that sits slightly under the peak does not step there.
    const u = h <= 0 ? 1 : (t - a) / h;
    return 1 + (holdLevel - 1) * u;
  }
  const dt = t - a - h;
  if (dt >= d || d <= 0) return 0;
  const u = 1 - dt / d;
  const c = e.curve ?? 2.2;
  return holdLevel * Math.pow(u, c);
}

/* ------------------------------------------------------------------------ *
 * Filters — RBJ biquads, evaluated in place
 * ------------------------------------------------------------------------ */

interface BiquadCoef { b0: number; b1: number; b2: number; a1: number; a2: number }

function lowpassCoef(sr: number, freq: number, q: number): BiquadCoef {
  const w = (2 * Math.PI * Math.min(freq, sr * 0.49)) / sr;
  const cw = Math.cos(w), sw = Math.sin(w);
  const alpha = sw / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cw) / 2) / a0,
    b1: (1 - cw) / a0,
    b2: ((1 - cw) / 2) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

function highpassCoef(sr: number, freq: number, q: number): BiquadCoef {
  const w = (2 * Math.PI * Math.min(freq, sr * 0.49)) / sr;
  const cw = Math.cos(w), sw = Math.sin(w);
  const alpha = sw / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cw) / 2) / a0,
    b1: (-(1 + cw)) / a0,
    b2: ((1 + cw) / 2) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

function bandpassCoef(sr: number, freq: number, q: number): BiquadCoef {
  const w = (2 * Math.PI * Math.min(freq, sr * 0.49)) / sr;
  const cw = Math.cos(w), sw = Math.sin(w);
  const alpha = sw / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

function applyBiquad(buf: Float32Array, c: BiquadCoef, from = 0, to = -1): void {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const end = to < 0 ? buf.length : to;
  for (let i = from; i < end; i++) {
    const x0 = buf[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    buf[i] = y0;
  }
}

/**
 * Lowpass over the whole buffer. `q` of 0.707 is flat-response.
 *
 * `order` is 2 by default (one biquad, 12 dB/octave). Pass 4 to cascade two,
 * which is 24 dB/octave — needed because a single biquad simply cannot produce
 * the rolloff the reference material has. DSSHOTGN puts 85% of its energy under
 * 548 Hz and 64.6% under 200 Hz; a 12 dB/octave slope leaves far too much
 * midrange behind to reach that, and the shot comes out sounding thin no matter
 * where the corner is placed.
 */
export function lowpass(buf: Float32Array, sr: number, freq: number, q = 0.707, order = 2): void {
  const stages = order >= 4 ? 2 : 1;
  for (let i = 0; i < stages; i++) applyBiquad(buf, lowpassCoef(sr, freq, q));
}
export function highpass(buf: Float32Array, sr: number, freq: number, q = 0.707): void {
  applyBiquad(buf, highpassCoef(sr, freq, q));
}
export function bandpass(buf: Float32Array, sr: number, freq: number, q = 2): void {
  applyBiquad(buf, bandpassCoef(sr, freq, q));
}

/**
 * A lowpass whose cutoff slides over the life of the sound.
 *
 * This is what makes an explosion open bright and close dark, and what makes a
 * plasma bolt "peow" instead of "beep". Coefficients are recomputed on a block
 * boundary rather than per sample — 64 samples at 48 kHz is 1.3 ms, far finer
 * than the ear resolves a filter sweep, and 64x less trig.
 */
export function lowpassSweep(
  buf: Float32Array, sr: number, fromHz: number, toHz: number, q = 0.9, curve = 1, order = 2,
): void {
  const BLOCK = 64;
  const stages = order >= 4 ? 2 : 1;
  // One set of filter state per cascaded stage, held across blocks so the
  // sweep is continuous rather than restarting every 64 samples.
  const x1 = new Float64Array(stages), x2 = new Float64Array(stages);
  const y1 = new Float64Array(stages), y2 = new Float64Array(stages);
  for (let i = 0; i < buf.length; i += BLOCK) {
    const u = Math.pow(i / buf.length, curve);
    const f = fromHz + (toHz - fromHz) * u;
    const c = lowpassCoef(sr, Math.max(20, f), q);
    const end = Math.min(i + BLOCK, buf.length);
    for (let j = i; j < end; j++) {
      let v = buf[j];
      for (let st = 0; st < stages; st++) {
        const x0 = v;
        const y0 = c.b0 * x0 + c.b1 * x1[st] + c.b2 * x2[st] - c.a1 * y1[st] - c.a2 * y2[st];
        x2[st] = x1[st]; x1[st] = x0; y2[st] = y1[st]; y1[st] = y0;
        v = y0;
      }
      buf[j] = v;
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Shapers
 * ------------------------------------------------------------------------ */

/**
 * Drive into soft clipping.
 *
 * Measurement (3): DSSHOTGN has a 13.8 dB crest factor and slams both 8-bit
 * rails. That is a saturated signal, and saturation is a shape, not a level —
 * it adds the odd-harmonic grit that makes a blast sound like it overloaded
 * whatever recorded it. `drive` of 1 is transparent; 4-8 is where the shotgun
 * and the explosions live.
 */
export function saturate(buf: Float32Array, drive: number): void {
  if (drive <= 1.0001) return;
  // Normalise so saturation changes TIMBRE without changing apparent loudness;
  // otherwise every drive tweak becomes a volume tweak and the mix drifts.
  const norm = 1 / Math.tanh(drive);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * drive) * norm;
}

/**
 * Quantise to `bits` and optionally decimate the sample rate.
 *
 * Measurement (4). DOOM's lumps are 8-bit unsigned at 11025 Hz. The
 * quantisation floor is audible on quiet tails and it is a substantial part of
 * why the originals sound like themselves rather than like clean synthesis.
 */
export function bitcrush(buf: Float32Array, bits: number, downsample = 1): void {
  const levels = Math.pow(2, bits) / 2;
  const inv = 1 / levels;
  if (downsample <= 1) {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.round(buf[i] * levels) * inv;
    return;
  }
  const step = Math.max(1, Math.floor(downsample));
  let held = 0;
  for (let i = 0; i < buf.length; i++) {
    if (i % step === 0) held = Math.round(buf[i] * levels) * inv;
    buf[i] = held;
  }
}

/* ------------------------------------------------------------------------ *
 * Reverb — early reflections only
 * ------------------------------------------------------------------------ */

/**
 * A tap-delay early-reflection network.
 *
 * A ConvolverNode with a 2 s impulse costs a multiply-accumulate per sample per
 * tap of the impulse and would be the single most expensive thing in the audio
 * graph; it is also the wrong tool. What sells "this gunshot happened inside a
 * corridor" is the first 80 ms of reflections, not the diffuse tail, and eight
 * taps buy that for eight multiply-adds per sample, applied once at bake time
 * rather than continuously at playback.
 *
 * Taps are prime-ish millisecond offsets so the comb peaks do not align into an
 * obvious metallic pitch.
 */
const REFLECTION_TAPS_MS = [11, 19, 31, 43, 57, 73, 89, 107];

export function earlyReflections(
  buf: Float32Array, sr: number, amount: number, sizeScale = 1, decay = 0.62,
): void {
  if (amount <= 0.001) return;
  const src = buf.slice();
  let g = amount;
  for (let t = 0; t < REFLECTION_TAPS_MS.length; t++) {
    const delay = Math.floor((REFLECTION_TAPS_MS[t] * sizeScale * sr) / 1000);
    if (delay >= buf.length) break;
    const n = buf.length - delay;
    for (let i = 0; i < n; i++) buf[i + delay] += src[i] * g;
    g *= decay;
  }
}

/* ------------------------------------------------------------------------ *
 * Layers — the vocabulary a SoundSpec is written in
 * ------------------------------------------------------------------------ */

export type LayerKind = 'noise' | 'osc' | 'fm' | 'body' | 'sweep';
export type Wave = 'sine' | 'saw' | 'square' | 'tri';

export interface Layer {
  kind: LayerKind;
  /** Peak contribution of this layer before the master normalise. */
  gain: number;
  env: Env;
  /** Seconds to wait before this layer starts. Builds two-part sounds. */
  delayMs?: number;

  /* noise */
  /** 0 = white, 1 = heavily red/brown. Low-frequency weighting. */
  colour?: number;

  /* osc / fm / sweep */
  freq?: number;
  /** End frequency for `sweep`, and for `osc` when set (a glide). */
  freqTo?: number;
  wave?: Wave;
  /** Frequency-sweep shape: >1 falls fast then flattens. */
  freqCurve?: number;

  /* fm */
  modFreq?: number;
  modIndex?: number;

  /* body: a decaying resonant ring, the pitched core of an impact */
  q?: number;

  /* per-layer filtering, applied before the layer is summed */
  lp?: number;
  lpQ?: number;
  /** 2 (default, 12 dB/oct) or 4 (24 dB/oct). See `lowpass`. */
  lpOrder?: number;
  hp?: number;
  bp?: number;
  bpQ?: number;
  /** Sweep this layer's lowpass from `lp` down (or up) to `lpTo`. */
  lpTo?: number;
}

export interface SoundSpec {
  /** Total length. Anything past this is truncated, so it bounds the cost. */
  durationMs: number;
  layers: Layer[];
  /** Waveshaper drive over the summed layers. */
  drive?: number;
  /** Quantisation depth. DOOM's own lumps are 8. */
  bits?: number;
  /** Sample-and-hold decimation factor, on top of `bandLimitHz`. */
  crushDownsample?: number;
  /**
   * Hard ceiling on content. Defaults to DOOM's own Nyquist (11025 / 2), which
   * is the frequency above which the reference material contains, by
   * construction, nothing at all.
   */
  bandLimitHz?: number;
  /** Early-reflection send, 0..1. */
  reverb?: number;
  reverbSize?: number;
  /** Peak normalisation target. Keeps the catalogue's levels comparable. */
  peak?: number;
  /** How many differing bakes to make, so a burst never machine-guns one file. */
  variants?: number;
}

/* ------------------------------------------------------------------------ *
 * The renderer
 * ------------------------------------------------------------------------ */

function oscValue(wave: Wave, phase: number): number {
  switch (wave) {
    case 'sine': return Math.sin(phase);
    case 'saw': {
      const t = (phase / (2 * Math.PI)) % 1;
      return 2 * t - 1;
    }
    case 'square': return Math.sin(phase) >= 0 ? 1 : -1;
    case 'tri': {
      const t = (phase / (2 * Math.PI)) % 1;
      return 4 * Math.abs(t - 0.5) - 1;
    }
    default: return 0;
  }
}

/** Render one layer additively into `out`. */
function renderLayer(out: Float32Array, l: Layer, sr: number, rng: () => number): void {
  const n = out.length;
  const startAt = Math.floor(((l.delayMs ?? 0) * sr) / 1000);
  if (startAt >= n) return;
  const len = n - startAt;
  const tmp = new Float32Array(len);

  switch (l.kind) {
    case 'noise': {
      // A one-pole lowpass on white noise gives brown/red noise; `colour`
      // interpolates. This is the cheapest way to weight noise toward the low
      // end, which measurement (2) says is where DOOM's weapons live.
      const c = l.colour ?? 0;
      let last = 0;
      const a = c * 0.985;
      // Brown noise loses a lot of level; compensate so `gain` stays meaningful.
      const comp = 1 + c * 6;
      for (let i = 0; i < len; i++) {
        const w = rng();
        last = a * last + (1 - a) * w;
        tmp[i] = (c > 0 ? last * comp : w);
      }
      break;
    }
    case 'osc': {
      const f0 = l.freq ?? 220;
      const f1 = l.freqTo ?? f0;
      const wave = l.wave ?? 'sine';
      const curve = l.freqCurve ?? 1;
      let phase = 0;
      for (let i = 0; i < len; i++) {
        const u = Math.pow(i / len, curve);
        const f = f0 + (f1 - f0) * u;
        phase += (2 * Math.PI * f) / sr;
        tmp[i] = oscValue(wave, phase);
      }
      break;
    }
    case 'fm': {
      // Two-operator FM. The chainsaw, the plasma bolt and the BFG all live
      // here: a metallic, inharmonic timbre that no filtered noise reaches.
      const f0 = l.freq ?? 220;
      const f1 = l.freqTo ?? f0;
      const mf = l.modFreq ?? f0 * 1.5;
      const mi = l.modIndex ?? 3;
      const curve = l.freqCurve ?? 1;
      let cphase = 0, mphase = 0;
      for (let i = 0; i < len; i++) {
        const u = Math.pow(i / len, curve);
        const f = f0 + (f1 - f0) * u;
        mphase += (2 * Math.PI * mf) / sr;
        const m = Math.sin(mphase) * mi;
        cphase += (2 * Math.PI * f) / sr;
        tmp[i] = Math.sin(cphase + m);
      }
      break;
    }
    case 'body': {
      // A resonant ring: noise through a high-Q bandpass. This is how the
      // 153 Hz peak measured in DSSHOTGN is reproduced — not as a sine, which
      // sounds like a test tone, but as a resonance excited by broadband
      // energy, which sounds like a barrel.
      for (let i = 0; i < len; i++) tmp[i] = rng();
      applyBiquad(tmp, bandpassCoef(sr, l.freq ?? 150, l.q ?? 6));
      // A high-Q bandpass throws most of the energy away; renormalise so the
      // layer's `gain` still means what it says.
      let mx = 0;
      for (let i = 0; i < len; i++) { const a = Math.abs(tmp[i]); if (a > mx) mx = a; }
      if (mx > 1e-6) { const s = 1 / mx; for (let i = 0; i < len; i++) tmp[i] *= s; }
      break;
    }
    case 'sweep': {
      // A pure pitch fall. Explosions and the rocket launch use it under the
      // noise to supply the sub-100 Hz weight measurement (2) found.
      const f0 = l.freq ?? 200;
      const f1 = l.freqTo ?? 40;
      const curve = l.freqCurve ?? 2.5;
      const wave = l.wave ?? 'sine';
      let phase = 0;
      for (let i = 0; i < len; i++) {
        const u = Math.pow(i / len, curve);
        const f = f0 + (f1 - f0) * u;
        phase += (2 * Math.PI * f) / sr;
        tmp[i] = oscValue(wave, phase);
      }
      break;
    }
    default: break;
  }

  /* per-layer filtering */
  if (l.hp !== undefined) highpass(tmp, sr, l.hp);
  if (l.lp !== undefined) {
    const order = l.lpOrder ?? 2;
    if (l.lpTo !== undefined) lowpassSweep(tmp, sr, l.lp, l.lpTo, l.lpQ ?? 0.9, 1, order);
    else lowpass(tmp, sr, l.lp, l.lpQ ?? 0.707, order);
  }
  if (l.bp !== undefined) bandpass(tmp, sr, l.bp, l.bpQ ?? 2);

  /* envelope and sum */
  const g = l.gain;
  for (let i = 0; i < len; i++) {
    out[startAt + i] += tmp[i] * envAt(l.env, i / sr) * g;
  }
}

/**
 * Bake a spec to mono PCM.
 *
 * Deterministic in (`spec`, `seed`), which is what makes variants a controlled
 * set rather than a lottery.
 */
export function render(spec: SoundSpec, sampleRate: number, seed: number): Float32Array {
  const n = Math.max(1, Math.floor((spec.durationMs * sampleRate) / 1000));
  const out = new Float32Array(n);
  const rng = makeRng(seed);

  for (let i = 0; i < spec.layers.length; i++) renderLayer(out, spec.layers[i], sampleRate, rng);

  if (spec.reverb) earlyReflections(out, sampleRate, spec.reverb, spec.reverbSize ?? 1);

  /* Normalise BEFORE the waveshaper.
   *
   * Without this, how hard a sound is driven depends on how many layers it
   * happens to have and what gains they happen to carry, so `drive: 7` means
   * something different in every spec and adding a quiet fourth layer silently
   * re-voices the whole sound. Normalising first makes `drive` an absolute
   * statement about SHAPE — the input to `tanh` is always in [-1, 1] — which is
   * what lets the shotgun be tuned to the measured 13.8 dB crest factor and
   * stay there. */
  normalisePeak(out, 1);
  if (spec.drive) saturate(out, spec.drive);

  // Band-limit BEFORE quantising: this is the order the original hardware
  // imposed (anti-alias filter, then the 8-bit converter), and doing it the
  // other way round leaves the quantisation hiss sitting above the band limit
  // where nothing else in the sound lives, which is audible as fizz.
  const bl = spec.bandLimitHz ?? 5512;
  if (bl > 0 && bl < sampleRate * 0.5) lowpass(out, sampleRate, bl, 0.707);

  if (spec.bits && spec.bits < 16) bitcrush(out, spec.bits, spec.crushDownsample ?? 1);

  /* De-offset, THEN normalise — in that order.
   *
   * The other way round is a real bug and the test suite caught it: subtracting
   * the mean after scaling to the peak pushes every sample on one side of zero
   * back OUT past the ceiling the normalise had just established, so a spec
   * asking for `peak: 0.98` shipped samples above full scale. Layered sweeps
   * that start mid-cycle genuinely do carry an offset, so this is not a
   * hypothetical. */
  let mean = 0;
  for (let i = 0; i < n; i++) mean += out[i];
  mean /= n;
  if (Math.abs(mean) > 1e-5) for (let i = 0; i < n; i++) out[i] -= mean;

  normalisePeak(out, spec.peak ?? 0.9);

  // Guarantee the buffer starts and ends at zero. A discontinuity at either
  // end is a click, and a click on every shot is the most fatiguing artefact
  // an FPS can have.
  const fade = Math.min(32, n >> 2);
  for (let i = 0; i < fade; i++) {
    const u = i / fade;
    out[i] *= u;
    out[n - 1 - i] *= u;
  }
  return out;
}

/** Scale so the largest absolute sample is exactly `target`. */
function normalisePeak(buf: Float32Array, target: number): void {
  let mx = 0;
  for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > mx) mx = a; }
  if (mx <= 1e-9) return;
  const s = target / mx;
  for (let i = 0; i < buf.length; i++) buf[i] *= s;
}

/** Peak, RMS and crest factor in dB — the measurements the catalogue is tuned against. */
export function measure(buf: Float32Array): { peak: number; rms: number; crestDb: number } {
  let mx = 0, sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > mx) mx = a;
    sum += buf[i] * buf[i];
  }
  const rms = Math.sqrt(sum / Math.max(1, buf.length));
  return { peak: mx, rms, crestDb: 20 * Math.log10(Math.max(mx, 1e-9) / Math.max(rms, 1e-9)) };
}
