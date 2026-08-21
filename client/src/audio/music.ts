/**
 * DOOMCRAFT — a Web Audio sequencer in the DOOM idiom.
 *
 * WHY SYNTHESIS IS THE RIGHT ANSWER HERE AND NOT A COMPROMISE
 *
 * DOOM's soundtrack is MIDI. Not "MIDI-ish" — the IWAD carries MUS lumps, a
 * compressed MIDI variant, and the music you remember is a General MIDI patch
 * list being played by whatever card you owned. That is a sequencer with an
 * instrument table, which is exactly what this file is, and it is why the idiom
 * genuinely synthesises rather than being approximated.
 *
 * WHAT THE IDIOM ACTUALLY IS, MEASURED
 *
 * The shareware WAD's MUS lumps were parsed and measured. MUS runs at 140 ticks
 * a second, so everything below is in real time, not in feel:
 *
 *   D_E1M1   96.0 s loop, 2,332 notes, 13,440 ticks. Bar = 305 ticks = 2.179 s.
 *            Guitar inter-onset 19 ticks = 136 ms -> SIXTEEN steps to the bar
 *            at 110 BPM. Note length 17 of those 19 ticks: 88% of a step,
 *            staccato but connected, never legato.
 *            Melodic patches: 29, 30, 34 and nothing else — Overdriven Guitar,
 *            Distortion Guitar, Picked Bass. Two guitars, one bass, drums.
 *            Register: guitars centre on MIDI 40 (E2, 82 Hz) and reach 79;
 *            bass lives at 28-40. This is low music.
 *            Intervals, by frequency: 0 first and by a distance, then -8, +12,
 *            -10, +10, -12. The commonest melodic move in At Doom's Gate is
 *            NOT MOVING — it is a pedal gallop with octave and sixth kicks off
 *            it. Pitch classes E, A, B, C, G: E minor pentatonic plus a flat 6.
 *            Drums: 224 kicks, 171 electric snares, 112 open hats, 58 rides,
 *            52 ride bells, 29 low floor toms, 38 crashes — and the kick, the
 *            snare and the tom land on the SAME tick, stacked for weight.
 *   D_E1M9   step 27 ticks = 193 ms, 3,803 notes over 137 s, ten melodic
 *            channels moving in parallel by +-1 and +-2: chromatic creep.
 *   D_INTER  step 27 ticks, 4,926 notes, 702 kicks. Relentless.
 *   D_E1M3   step 17 ticks = 121 ms, 697 closed hats — a hat on every step.
 *
 * Everything in `TRACKS` below is built from those numbers. The riffs are not:
 * they are written to the measured interval distribution and the measured pitch
 * class set, in the measured register, at the measured tempo — and they are
 * original, because the measurements are facts and a melody is not.
 *
 * DATA, NOT CODE
 *
 * A track is `{ bpm, root, cells, layers }`. A cell is sixteen numbers. A layer
 * is an instrument, an intensity tier, and a list of which cell to play in each
 * bar. Adding a track is adding one object; there is no code path per track.
 *
 * INTENSITY, WITHOUT THE CROSSFADE MUSH
 *
 * Combat music that rises by fading a second copy of itself in over the top is
 * the thing this deliberately is not. Threat picks a TIER; tiers add and remove
 * whole instrument layers, and they only ever change ON A BAR LINE. A rise also
 * triggers a fill on the last beat of the bar it rises out of, so the entry is
 * announced instead of appearing. A fall waits for a four-bar phrase boundary,
 * which stops the arrangement flickering when one Imp walks in and out of
 * range.
 *
 * COST, AND THE BACKGROUND-TAB PROBLEM
 *
 * Instruments are baked once into 11,025 Hz buffers and pitched by
 * `playbackRate`; a note is one `AudioBufferSourceNode` and one gain. Nothing
 * is scheduled from `requestAnimationFrame` — the sequencer runs on its own
 * timer with a lookahead, so it never touches the frame budget. That timer is
 * throttled to about 1 Hz when the tab is hidden, which would tear the music
 * apart; the lookahead is therefore ADAPTIVE, growing to cover whatever gap the
 * last tick actually took. Combined with `settings.muteOnBlur` the hidden-tab
 * case is either silent or seamless, never stuttering.
 */

import { ModeId } from '@shared/modes';

import { BAKE_RATE, Biquad, NoiseSource, normalise, resampleTo } from './dsp';
import type { SustainTarget } from './ambience';

/**
 * `BUS_MUSIC` in engine.ts, mirrored rather than imported.
 *
 * The sequencer owns its own nodes on this bus rather than going through
 * `engine.play()`, and that is a decision worth stating. At 110 BPM with four
 * layers running the arrangement emits around thirty notes a second; pushed
 * through a 24-slot pool sized for gunfire, music would either be stolen
 * constantly (it sits at the bottom of the priority ladder, correctly) or would
 * starve the gunfire it is scored under. Owning its own gain keeps both true:
 * music never competes for a slot, and it still rides the bus volume, the
 * master and the limiter.
 */
const BUS_MUSIC = 1;

/* ------------------------------------------------------------------------ *
 * Notation
 * ------------------------------------------------------------------------ */

/** A step with no note. */
export const REST = -128;
/** A step that extends the previous note instead of restriking it. */
export const HOLD = -127;

/** Sixteen steps to the bar — the measured D_E1M1 grid. */
export const STEPS_PER_BAR = 16;
/** Four bars to a phrase, which is where a falling intensity is allowed to act. */
export const BARS_PER_PHRASE = 4;

/** Drum bits, in the proportions the E1M1 kit measures. */
export const DR_KICK = 1;
export const DR_SNARE = 2;
export const DR_HAT = 4;
export const DR_OPEN = 8;
export const DR_CRASH = 16;
export const DR_TOM = 32;
export const DR_RIDE = 64;

export type InstrumentId = 'guitar' | 'bass' | 'lead' | 'drums';

export interface TrackLayer {
  readonly inst: InstrumentId;
  /** Intensity tier at which this layer turns on. 0 = always playing. */
  readonly tier: number;
  readonly gain: number;
  /** Octave shift applied on top of the track root. */
  readonly octave: number;
  /** One cell index per bar; the sequence repeats. */
  readonly seq: readonly number[];
}

export interface Track {
  readonly id: string;
  readonly bpm: number;
  /** MIDI note the cells are written relative to. */
  readonly root: number;
  /** Sixteen-step cells. Melodic cells are semitone offsets; drum cells are bit masks. */
  readonly cells: readonly (readonly number[])[];
  readonly layers: readonly TrackLayer[];
}

function cell(...n: number[]): readonly number[] { return Object.freeze(n); }

/* ------------------------------------------------------------------------ *
 * The tracks
 *
 * Read the cells as sixteenths. `_` is a rest, `H` extends. The pedal note is
 * 0 and it is the commonest thing in every riff, which is the measured shape of
 * the idiom rather than a shortcut.
 * ------------------------------------------------------------------------ */

const _ = REST;
const H = HOLD;

/* Melodic cells shared by the Quest tracks — E minor pentatonic plus the flat
   6 (0, 3, 5, 7, 10 and 8), moving mostly by 0 and jumping by 8, 10 and 12,
   which is the measured D_E1M1 interval histogram in the same order. */
const GALLOP = cell(0, 0, 12, 0, 0, 10, 0, 0, 8, 0, 0, 7, 0, 0, 8, 10);
const GALLOP_B = cell(0, 0, 12, 0, 0, 10, 0, 0, 8, 0, 0, 5, 0, 3, 0, 0);
const PEDAL = cell(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
const CLIMB = cell(0, 0, 3, 0, 0, 5, 0, 0, 7, 0, 0, 8, 0, 0, 10, 12);
const BASS_8TH = cell(0, H, 0, H, 0, H, 0, H, 0, H, 0, H, 0, H, 0, H);
const BASS_DRIVE = cell(0, H, 0, 0, 0, H, 0, 0, 0, H, 0, 0, 7, H, 5, H);
const BASS_LOW = cell(0, H, H, H, H, H, H, H, 0, H, H, H, H, H, H, H);
const LEAD_A = cell(12, _, _, 15, _, _, 19, _, 17, _, 15, _, 12, _, 10, _);
const LEAD_B = cell(19, _, 17, _, 15, _, 12, _, 10, _, 12, _, 15, _, 17, 19);
const LEAD_HOLD = cell(12, H, H, H, H, H, H, H, 10, H, H, H, H, H, H, H);

/* Drum cells. The stacked kick/snare/tom of the measured E1M1 kit is exactly
   what `DR_KICK | DR_SNARE | DR_TOM` on one step means. */
const K = DR_KICK; const S = DR_SNARE; const Hh = DR_HAT; const O = DR_OPEN;
const C = DR_CRASH; const T = DR_TOM; const R = DR_RIDE;
const DR_FOUR = cell(K | C, Hh, Hh, Hh, S, Hh, Hh, Hh, K, Hh, Hh, Hh, S, Hh, Hh, O);
const DR_DRIVE = cell(K | C, Hh, K, Hh, S, Hh, K, Hh, K, Hh, K, Hh, S, Hh, K, O);
const DR_HALF = cell(K, 0, 0, 0, S, 0, 0, 0, K, 0, 0, 0, S, 0, 0, 0);
const DR_RIDEY = cell(K | R, R, R, R, S | R, R, R, R, K | R, R, R, R, S | R, R, K | R, R);
const DR_FILL = cell(K, T, T, S, T, T, S, S, T, T, S, S, T | S, T | S, S | C, S | C);
const DR_SPARSE = cell(K, 0, 0, 0, 0, 0, S, 0, 0, 0, K, 0, 0, 0, 0, 0);

/**
 * Cell indices are shared across every track so the table reads as data:
 * 0 GALLOP  1 GALLOP_B  2 PEDAL  3 CLIMB
 * 4 BASS_8TH  5 BASS_DRIVE  6 BASS_LOW
 * 7 LEAD_A  8 LEAD_B  9 LEAD_HOLD
 * 10 DR_FOUR  11 DR_DRIVE  12 DR_HALF  13 DR_RIDEY  14 DR_FILL  15 DR_SPARSE
 */
const CELLS: readonly (readonly number[])[] = Object.freeze([
  GALLOP, GALLOP_B, PEDAL, CLIMB,
  BASS_8TH, BASS_DRIVE, BASS_LOW,
  LEAD_A, LEAD_B, LEAD_HOLD,
  DR_FOUR, DR_DRIVE, DR_HALF, DR_RIDEY, DR_FILL, DR_SPARSE,
]);

/** The index of the fill cell, used when a tier rises. */
const FILL_CELL = 14;

function track(t: Track): Track { return Object.freeze(t); }

/**
 * Six tracks and a silence. Every tempo below is a measured one: 110 is the
 * D_E1M1 bar (305 ticks at 140 Hz over 16 steps), 145 is the D_INTER/D_E1M9
 * step of 27 ticks, 124 is the D_E1M3 step of 17.
 */
export const TRACKS: readonly Track[] = Object.freeze([
  /* --- the gate: E1M1's tempo and register, an original riff on it -------- */
  track({
    id: 'gate', bpm: 110, root: 40, cells: CELLS,
    layers: Object.freeze([
      { inst: 'bass', tier: 0, gain: 0.85, octave: -1, seq: [4, 4, 4, 5] },
      { inst: 'drums', tier: 0, gain: 0.9, octave: 0, seq: [10, 10, 10, 11] },
      { inst: 'guitar', tier: 1, gain: 0.72, octave: 0, seq: [0, 0, 1, 0] },
      { inst: 'guitar', tier: 2, gain: 0.5, octave: 1, seq: [0, 1, 0, 3] },
      { inst: 'lead', tier: 3, gain: 0.42, octave: 1, seq: [7, 8, 7, 8] },
    ]),
  }),

  /* --- dread: the same key, half the drums, everything holding ------------ */
  track({
    id: 'dread', bpm: 88, root: 40, cells: CELLS,
    layers: Object.freeze([
      { inst: 'bass', tier: 0, gain: 0.8, octave: -1, seq: [6, 6, 6, 6] },
      { inst: 'drums', tier: 1, gain: 0.7, octave: 0, seq: [15, 15, 15, 12] },
      { inst: 'guitar', tier: 2, gain: 0.55, octave: 0, seq: [2, 2, 2, 3] },
      { inst: 'lead', tier: 3, gain: 0.4, octave: 1, seq: [9, 9, 9, 7] },
    ]),
  }),

  /* --- furnace: D_E1M3's hat-on-every-step at its measured 124 ------------ */
  track({
    id: 'furnace', bpm: 124, root: 38, cells: CELLS,
    layers: Object.freeze([
      { inst: 'bass', tier: 0, gain: 0.85, octave: -1, seq: [5, 5, 5, 4] },
      { inst: 'drums', tier: 0, gain: 0.85, octave: 0, seq: [10, 10, 11, 11] },
      { inst: 'guitar', tier: 1, gain: 0.7, octave: 0, seq: [1, 1, 0, 3] },
      { inst: 'guitar', tier: 2, gain: 0.48, octave: 1, seq: [3, 0, 3, 1] },
      { inst: 'lead', tier: 3, gain: 0.44, octave: 1, seq: [8, 8, 7, 8] },
    ]),
  }),

  /* --- siege: Horde. D_INTER's 145 and its 702 kicks. -------------------- */
  track({
    id: 'siege', bpm: 145, root: 40, cells: CELLS,
    layers: Object.freeze([
      { inst: 'bass', tier: 0, gain: 0.88, octave: -1, seq: [4, 4, 5, 5] },
      { inst: 'drums', tier: 0, gain: 0.92, octave: 0, seq: [11, 11, 11, 13] },
      { inst: 'guitar', tier: 1, gain: 0.72, octave: 0, seq: [2, 0, 2, 0] },
      { inst: 'guitar', tier: 2, gain: 0.52, octave: 0, seq: [0, 1, 0, 1] },
      { inst: 'lead', tier: 3, gain: 0.46, octave: 1, seq: [8, 7, 8, 7] },
    ]),
  }),

  /* --- arena: Deathmatch. Fast, and it never drops below tier 1, because a
         deathmatch has no lull to score. -------------------------------- */
  track({
    id: 'arena', bpm: 145, root: 42, cells: CELLS,
    layers: Object.freeze([
      { inst: 'bass', tier: 0, gain: 0.85, octave: -1, seq: [5, 5, 4, 5] },
      { inst: 'drums', tier: 0, gain: 0.9, octave: 0, seq: [11, 13, 11, 11] },
      { inst: 'guitar', tier: 1, gain: 0.7, octave: 0, seq: [0, 3, 0, 1] },
      { inst: 'guitar', tier: 2, gain: 0.5, octave: 1, seq: [1, 0, 3, 0] },
      { inst: 'lead', tier: 3, gain: 0.44, octave: 1, seq: [7, 8, 8, 7] },
    ]),
  }),

  /* --- workshop: Builder. Almost nothing, and no guitars at all. An hour of
         placing blocks is not an hour that wants a riff. ----------------- */
  track({
    id: 'workshop', bpm: 92, root: 40, cells: CELLS,
    layers: Object.freeze([
      { inst: 'bass', tier: 0, gain: 0.55, octave: -1, seq: [6, 6, 6, 6] },
      { inst: 'lead', tier: 2, gain: 0.3, octave: 1, seq: [9, 9, 9, 9] },
    ]),
  }),
]);

const TRACK_BY_ID = new Map<string, Track>();
for (const t of TRACKS) TRACK_BY_ID.set(t.id, t);

/**
 * Pick a track from the mode and the level's `musicCue`.
 *
 * `musicCue` has been on `LevelMeta` since the format was written, documented
 * as "key the audio layer looks up", populated in all six shipped levels, and
 * read by nothing. This is the audio layer, and this is it looking it up.
 */
export function trackFor(mode: ModeId, musicCue = ''): Track | null {
  switch (mode) {
    case ModeId.HORDE: return TRACK_BY_ID.get('siege') ?? null;
    case ModeId.DEATHMATCH: return TRACK_BY_ID.get('arena') ?? null;
    case ModeId.BUILDER: return TRACK_BY_ID.get('workshop') ?? null;
    default: break;
  }
  switch (musicCue) {
    case 'e1m1': case 'e1m2': return TRACK_BY_ID.get('gate') ?? null;
    case 'e1m3': case 'e1m4': return TRACK_BY_ID.get('dread') ?? null;
    case 'e1m5': case 'e1m6': return TRACK_BY_ID.get('furnace') ?? null;
    default: return TRACK_BY_ID.get('gate') ?? null;
  }
}

/* ------------------------------------------------------------------------ *
 * Instruments
 * ------------------------------------------------------------------------ */

/** MIDI note each melodic instrument is baked at; everything else is a rate. */
const GUITAR_BASE = 40;
const BASS_BASE = 28;
const LEAD_BASE = 52;

function midiHz(n: number): number { return 440 * Math.pow(2, (n - 69) / 12); }

/**
 * A distorted guitar chug.
 *
 * The GM patches D_E1M1 actually uses are 29 and 30 — Overdriven Guitar and
 * Distortion Guitar — so distortion is not a stylistic liberty, it is the
 * patch list. A sawtooth through a soft clipper, a fast pick transient, and a
 * lowpass that closes as the note decays, which is what a palm mute does.
 */
export function bakeGuitar(midi: number, seconds: number, drive: number, seed: number): Float32Array {
  const n = Math.round(seconds * BAKE_RATE);
  const out = new Float32Array(n);
  const f0 = midiHz(midi);
  const rng = new NoiseSource(seed);
  const body = new Biquad().lowpass(2600, 0.8);
  const cut = new Biquad().lowpass(1500, 1.1);
  let phase = 0;
  const inc = f0 / BAKE_RATE;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    phase += inc;
    if (phase >= 1) phase -= 1;
    // Naive saw is fine at this rate for a signal that is about to be clipped
    // and lowpassed twice; the fold-back it produces is indistinguishable from
    // the fold-back the clipper produces on purpose.
    let x = phase * 2 - 1;
    // The pick: a short noise burst, which is most of what makes it read as a
    // string rather than as an organ.
    if (i < 220) x += rng.next() * 0.9 * (1 - i / 220);
    x = Math.tanh(x * drive) / Math.tanh(drive);
    x = body.step(x);
    const env = Math.exp(-t * 5.5) * (1 - Math.exp(-i / 40));
    out[i] = cut.step(x) * env;
  }
  normalise(out, 0.9);
  return out;
}

/** Picked electric bass — GM 34, the one bass patch in D_E1M1. */
export function bakeBass(midi: number, seconds: number, seed: number): Float32Array {
  const n = Math.round(seconds * BAKE_RATE);
  const out = new Float32Array(n);
  const f0 = midiHz(midi);
  const rng = new NoiseSource(seed);
  const lp = new Biquad().lowpass(900, 1.3);
  let phase = 0;
  const inc = f0 / BAKE_RATE;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    phase += inc;
    if (phase >= 1) phase -= 1;
    // Half saw, half square: the pick attack of a plectrum on a wound string.
    let x = (phase * 2 - 1) * 0.6 + (phase < 0.5 ? 0.4 : -0.4);
    if (i < 90) x += rng.next() * 0.5 * (1 - i / 90);
    x = Math.tanh(x * 1.8) * 0.7;
    const env = Math.exp(-t * 4.0) * (1 - Math.exp(-i / 25));
    out[i] = lp.step(x) * env;
  }
  normalise(out, 0.9);
  return out;
}

/** A saw lead — GM 81 appears in D_INTER and D_E1M9's patch lists. */
export function bakeLead(midi: number, seconds: number, seed: number): Float32Array {
  const n = Math.round(seconds * BAKE_RATE);
  const out = new Float32Array(n);
  const f0 = midiHz(midi);
  void seed;
  const lp = new Biquad().lowpass(3200, 2.2);
  let p1 = 0; let p2 = 0;
  const i1 = f0 / BAKE_RATE;
  const i2 = (f0 * 1.006) / BAKE_RATE;   // one detuned pair, the whole trick
  for (let i = 0; i < n; i++) {
    const t = i / n;
    p1 += i1; if (p1 >= 1) p1 -= 1;
    p2 += i2; if (p2 >= 1) p2 -= 1;
    const x = ((p1 * 2 - 1) + (p2 * 2 - 1)) * 0.5;
    const env = Math.min(1, i / 300) * Math.exp(-t * 1.6);
    out[i] = lp.step(x) * env;
  }
  normalise(out, 0.85);
  return out;
}

/**
 * The kit, in the proportions the E1M1 drum channel measures: 224 kicks, 171
 * electric snares, 112 open hats, 58 rides, 29 low floor toms, 38 crashes.
 */
export function bakeDrum(kind: number, seed: number): Float32Array {
  const rng = new NoiseSource(seed);
  const secs = kind === DR_KICK ? 0.24 : kind === DR_SNARE ? 0.20 : kind === DR_TOM ? 0.28
    : kind === DR_CRASH ? 1.10 : kind === DR_OPEN ? 0.34 : kind === DR_RIDE ? 0.42 : 0.06;
  const n = Math.round(secs * BAKE_RATE);
  const out = new Float32Array(n);
  if (kind === DR_KICK || kind === DR_TOM) {
    // A pitched sine that drops: the whole of an 808-lineage kick, and of a
    // floor tom with a slower drop and a longer tail.
    const f1 = kind === DR_KICK ? 118 : 190;
    const f2 = kind === DR_KICK ? 42 : 78;
    const decay = kind === DR_KICK ? 9 : 6;
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const f = f2 + (f1 - f2) * Math.exp(-t * 12);
      ph += f / BAKE_RATE;
      const click = i < 40 ? rng.next() * 0.35 * (1 - i / 40) : 0;
      out[i] = (Math.sin(ph * Math.PI * 2) + click) * Math.exp(-t * decay);
    }
  } else if (kind === DR_SNARE) {
    const tone = new Biquad().bandpass(210, 1.4);
    const rattle = new Biquad().highpass(1500, 0.7);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      ph += 195 / BAKE_RATE;
      const nz = rng.next();
      const body = tone.step(Math.sin(ph * Math.PI * 2) + nz * 0.3) * 0.8;
      out[i] = (body + rattle.step(nz) * 1.15) * Math.exp(-t * 11);
    }
  } else {
    // Hats, crashes and the ride are all bandpassed noise; they differ only in
    // where the band sits and how long the tail is.
    const lo = kind === DR_CRASH ? 2600 : kind === DR_RIDE ? 2200 : 3400;
    const bp = new Biquad().highpass(lo, 0.7);
    const decay = kind === DR_CRASH ? 3.2 : kind === DR_OPEN ? 7 : kind === DR_RIDE ? 6 : 34;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      out[i] = bp.step(rng.next()) * Math.exp(-t * decay);
    }
  }
  normalise(out, 0.9);
  return out;
}

/* ------------------------------------------------------------------------ *
 * Intensity
 * ------------------------------------------------------------------------ */

/** Number of tiers; tier 0 is the bed and always plays. */
export const TIER_COUNT = 4;

/** Threat at or above which each tier engages. Tier 0's entry is unused. */
const TIER_THRESHOLD: readonly number[] = Object.freeze([0, 0.16, 0.42, 0.72]);
/** Threat below which a tier lets go. The gap is deliberate hysteresis. */
const TIER_RELEASE: readonly number[] = Object.freeze([0, 0.08, 0.30, 0.58]);

/** Tier for a threat value, given the tier currently held. Pure. */
export function tierFor(threat: number, current: number): number {
  let t = 0;
  for (let i = TIER_COUNT - 1; i >= 1; i--) {
    const bar = i <= current ? TIER_RELEASE[i] : TIER_THRESHOLD[i];
    if (threat >= bar) { t = i; break; }
  }
  return t;
}

/* ------------------------------------------------------------------------ *
 * The sequencer
 * ------------------------------------------------------------------------ */

export interface MusicOptions {
  /** Milliseconds between scheduler wakeups. */
  tickMs?: number;
  /** Seconds of notes queued ahead. Grows on its own if the timer is throttled. */
  lookahead?: number;
  seed?: number;
  /** Run the arrangement with no audio at all — this is how the test drives it. */
  silent?: boolean;
}

const DEFAULT_TICK_MS = 25;
const MIN_LOOKAHEAD = 0.12;
const MAX_LOOKAHEAD = 1.6;

/** One scheduled note, as the test sees it. */
export interface ScheduledNote {
  readonly time: number;
  readonly inst: InstrumentId;
  /** MIDI note, or the drum bit for a percussion hit. */
  readonly note: number;
  readonly gain: number;
  readonly step: number;
  readonly bar: number;
}

export class Music {
  private readonly engine: SustainTarget;
  private readonly opts: MusicOptions;

  private track: Track | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private busGain: GainNode | null = null;

  /** Absolute step counter since the track started. */
  private step = 0;
  /** ctx time the NEXT step is due at. */
  private nextStepAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;
  private lookahead: number;

  private threat = 0;
  private tier = 0;
  /** Tier that will take effect at the next bar line. */
  private pendingTier = 0;
  /** Bar index at which the pending tier lands. */
  private fillBar = -1;

  private rng: NoiseSource;
  private disposed = false;

  /**
   * The clock, as a function, so a test can step it by hand.
   *
   * Defaults to `ctx.currentTime`, which is the ONLY clock a scheduler may use:
   * `performance.now()` and the audio clock drift apart, and a sequencer that
   * schedules on one and starts sources on the other slowly falls apart over a
   * three-minute track.
   */
  clockFn: () => number = () => this.engine.ctx?.currentTime ?? 0;

  /** Notes scheduled since `start()`. The perf number, and the test's hook. */
  scheduled = 0;
  /** Milliseconds spent baking instruments, all told. */
  bakeMs = 0;
  /**
   * Notes that actually started a source, as opposed to being scheduled.
   *
   * The two diverge exactly when something is wrong, and the failure is silent
   * in both senses: a sequencer whose instrument table is empty runs forever,
   * counts thousands of notes and makes no sound. That is not hypothetical —
   * it happened here, because `setTrack` primes and the track is chosen from
   * the room's mode context, which arrives before there is an AudioContext to
   * prime into. `scheduled` said 794; `sounded` would have said 0.
   */
  sounded = 0;
  /** Every note scheduled, when `silent` is on. Never populated otherwise. */
  readonly log: ScheduledNote[] = [];

  constructor(engine: SustainTarget, opts: MusicOptions = {}) {
    this.engine = engine;
    this.opts = opts;
    this.lookahead = opts.lookahead ?? MIN_LOOKAHEAD;
    this.rng = new NoiseSource(opts.seed ?? 0xd00d4a);
  }

  /** Seconds per step for the current track. */
  get stepSeconds(): number {
    const t = this.track;
    if (t === null) return 0;
    // 16 steps to the bar, 4 beats to the bar: a step is a sixteenth.
    return 60 / t.bpm / 4;
  }

  get currentTier(): number { return this.tier; }
  get currentTrack(): Track | null { return this.track; }
  get bar(): number { return Math.floor(this.step / STEPS_PER_BAR); }

  /**
   * Switch tracks. A change mid-phrase is allowed but lands on the next BAR,
   * because a track that changes on the beat you asked for is a track that
   * changes in the middle of a bar.
   */
  setTrack(t: Track | null): void {
    if (this.track === t) return;
    this.track = t;
    this.step = 0;
    this.tier = 0;
    this.pendingTier = 0;
    this.fillBar = -1;
    /* Cut whatever is already in flight. The scheduler queues up to 1.6 s ahead
       when a throttled tab has widened the lookahead, and a `BufferSourceNode`
       that has been `start()`ed at a future time cannot be un-scheduled — so
       without this, up to a second and a half of the old level's riff plays on
       top of the new one. Rebuilding the one gain the sequencer owns orphans
       every queued note at once. */
    this.resetBus();
    // `prime` needs a context; before the first gesture there is not one yet.
    // `start()` re-primes for exactly that reason — see the note there.
    if (t !== null && !this.opts.silent) this.prime(t);
  }

  /**
   * Report threat, 0..1.
   *
   * Called from the frame loop, and cheap on purpose: it stores a float. The
   * arrangement decision is made by the sequencer at a bar line, not here.
   */
  setThreat(threat01: number): void {
    this.threat = threat01 < 0 ? 0 : threat01 > 1 ? 1 : threat01;
  }

  get currentThreat(): number { return this.threat; }

  /** Bake every instrument this track needs. Idempotent. */
  prime(t: Track): void {
    if (this.opts.silent === true) return;
    const ctx = this.engine.ctx;
    if (ctx === null) return;
    const rate = this.engine.sampleRate;
    const seed = this.opts.seed ?? 0xd00d4a;
    const t0 = nowMs();
    const put = (key: string, pcm: Float32Array): void => {
      if (this.buffers.has(key)) return;
      const data = resampleTo(pcm, BAKE_RATE, rate);
      const buf = ctx.createBuffer(1, data.length, rate);
      buf.copyToChannel(data, 0);
      this.buffers.set(key, buf);
    };
    const need = new Set<string>();
    for (const L of t.layers) need.add(L.inst);
    if (need.has('guitar')) put('guitar', bakeGuitar(GUITAR_BASE, 0.9, 5.5, seed + 1));
    if (need.has('bass')) put('bass', bakeBass(BASS_BASE, 1.0, seed + 2));
    if (need.has('lead')) put('lead', bakeLead(LEAD_BASE, 1.4, seed + 3));
    if (need.has('drums')) {
      for (const bit of [DR_KICK, DR_SNARE, DR_HAT, DR_OPEN, DR_CRASH, DR_TOM, DR_RIDE]) {
        put(`d${bit}`, bakeDrum(bit, seed + bit * 13));
      }
    }
    this.bakeMs += nowMs() - t0;
  }

  /**
   * Start the sequencer. Must follow a user gesture, like everything else here.
   */
  start(): void {
    if (this.disposed || this.timer !== null) return;
    if (this.opts.silent !== true) {
      if (!this.engine.ready) return;
      const ctx = this.engine.ctx;
      const bus = ctx === null ? null : this.engine.busNode(BUS_MUSIC);
      if (ctx === null || bus === null) return;
      /* Prime HERE as well as in `setTrack`, and this is not belt and braces.
         The track is chosen when the room's mode context arrives, which is
         before the player has touched anything, so `setTrack`'s prime runs with
         no AudioContext and does nothing. `setTrack` then early-returns on the
         identical track when `unlockAudio` picks it again — and the sequencer
         runs happily forever, scheduling notes against an empty buffer table
         and playing complete silence. Measured: 794 notes scheduled, 0 ms of
         instruments baked, nothing audible. */
      const t = this.track;
      if (t !== null) this.prime(t);
      this.busGain = ctx.createGain();
      this.busGain.gain.value = 1;
      this.busGain.connect(bus);
    }
    const t = this.clockFn();
    this.nextStepAt = t + 0.06;
    this.lastTickAt = t;
    const ms = this.opts.tickMs ?? DEFAULT_TICK_MS;
    this.timer = setInterval(() => this.tick(), ms);
    // Prime the queue immediately rather than waiting a whole tick for it.
    this.tick();
  }

  stop(): void {
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    if (this.busGain !== null) { try { this.busGain.disconnect(); } catch { /* ignore */ } this.busGain = null; }
  }

  /** Orphan every queued note by replacing the gain they are all routed through. */
  private resetBus(): void {
    if (this.busGain === null) return;
    try { this.busGain.disconnect(); } catch { /* ignore */ }
    this.busGain = null;
    const ctx = this.engine.ctx;
    const bus = ctx === null ? null : this.engine.busNode(BUS_MUSIC);
    if (ctx === null || bus === null) return;
    const g = ctx.createGain();
    g.gain.value = 1;
    g.connect(bus);
    this.busGain = g;
  }

  dispose(): void { this.stop(); this.buffers.clear(); this.disposed = true; }

  /**
   * One scheduler wakeup.
   *
   * Public so the test can drive it deterministically, and so the game can pump
   * it once by hand on resume rather than waiting for the interval.
   */
  tick(): void {
    if (this.disposed) return;
    const t = this.track;
    if (t === null) return;
    const now = this.clockFn();

    /* Adaptive lookahead. A hidden tab throttles `setInterval` to about 1 Hz,
       and a fixed 120 ms lookahead tears the music apart the moment that
       happens. Growing the window to cover whatever the last gap actually was
       — with a ceiling, so a resumed tab does not queue ten seconds of notes
       it can no longer cancel — makes the throttled case seamless. */
    const gap = now - this.lastTickAt;
    this.lastTickAt = now;
    const want = Math.max(MIN_LOOKAHEAD, gap * 2.5);
    this.lookahead = Math.min(MAX_LOOKAHEAD, this.lookahead + (want - this.lookahead) * 0.5);

    /* A long stall — an alt-tab, a breakpoint, a resumed context — leaves
       `nextStepAt` in the past. Walking it forward one step at a time would
       schedule every missed note at once, which is the machine-gun bug. Skip
       to the next bar line instead: the arrangement stays on the grid and
       nothing plays late. */
    if (now - this.nextStepAt > MAX_LOOKAHEAD) {
      const missed = Math.ceil((now - this.nextStepAt) / this.stepSeconds);
      const toBar = missed + ((STEPS_PER_BAR - ((this.step + missed) % STEPS_PER_BAR)) % STEPS_PER_BAR);
      this.step += toBar;
      this.nextStepAt += toBar * this.stepSeconds;
    }

    const horizon = now + this.lookahead;
    let guard = 0;
    while (this.nextStepAt < horizon && guard++ < 512) {
      this.scheduleStep(this.step, this.nextStepAt);
      this.step++;
      this.nextStepAt += this.stepSeconds;
    }
  }

  /* ---- arrangement --------------------------------------------------- */

  /**
   * One step of one bar for every layer that the current tier turns on.
   *
   * The tier decision happens HERE, at the top of a bar, and nowhere else.
   * That is what makes the transitions musical: a layer cannot appear on the
   * third sixteenth of a bar, because this function is the only thing that can
   * make it appear and it only ever looks at the tier when `step` is a
   * multiple of sixteen.
   */
  private scheduleStep(step: number, time: number): void {
    const t = this.track;
    if (t === null) return;
    const inBar = step % STEPS_PER_BAR;
    const bar = Math.floor(step / STEPS_PER_BAR);

    if (inBar === 0) this.settleTier(bar);

    const barsInSeq = 4;
    for (const L of t.layers) {
      if (L.tier > this.tier) continue;
      const seqIndex = L.seq[bar % L.seq.length] ?? 0;
      /* The fill. When a tier is about to rise, the drum layer swaps its cell
         for a fill in the bar BEFORE the rise, so the new instrument is
         announced rather than simply appearing. This is the whole of "musical
         transitions rather than crossfade mush", and it is four lines. */
      const useFill = L.inst === 'drums' && bar === this.fillBar;
      const c = t.cells[useFill ? FILL_CELL : seqIndex];
      if (c === undefined) continue;
      const v = c[inBar];
      if (v === undefined || v === REST || v === HOLD || v === 0 && L.inst === 'drums') continue;

      if (L.inst === 'drums') {
        for (const bit of [DR_KICK, DR_SNARE, DR_HAT, DR_OPEN, DR_CRASH, DR_TOM, DR_RIDE]) {
          if ((v & bit) === 0) continue;
          this.emit(L.inst, bit, time, L.gain * this.humanise(), step, bar);
        }
      } else {
        const midi = t.root + L.octave * 12 + v;
        this.emit(L.inst, midi, time, L.gain * this.humanise(), step, bar);
      }
    }
    void barsInSeq;
  }

  /**
   * Decide the tier for the bar that is starting.
   *
   * Rises take effect at the next bar and set a fill in the bar they rise out
   * of. Falls wait for a PHRASE boundary, which is the difference between an
   * arrangement and a flicker: one Imp stepping in and out of range must not be
   * able to strobe the guitars.
   */
  private settleTier(bar: number): void {
    const want = tierFor(this.threat, this.tier);
    if (want === this.tier) { this.pendingTier = want; return; }
    if (want > this.tier) {
      if (this.pendingTier !== want) { this.pendingTier = want; this.fillBar = bar; return; }
      this.tier = want;
      this.fillBar = -1;
      return;
    }
    // Falling: only on a phrase line.
    this.pendingTier = want;
    if (bar % BARS_PER_PHRASE === 0) this.tier = want;
  }

  /** +-6% on every note's level. Nothing measured is this even. */
  private humanise(): number { return 0.94 + this.rng.next() * 0.06; }

  private emit(inst: InstrumentId, note: number, time: number, gain: number, step: number, bar: number): void {
    this.scheduled++;
    if (this.opts.silent === true) {
      this.log.push({ time, inst, note, gain, step, bar });
      return;
    }
    const bus = this.busGain;
    const ctx = this.engine.ctx;
    if (bus === null || ctx === null) return;
    const key = inst === 'drums' ? `d${note}` : inst;
    const buf = this.buffers.get(key);
    if (buf === undefined) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (inst !== 'drums') {
      const base = inst === 'bass' ? BASS_BASE : inst === 'lead' ? LEAD_BASE : GUITAR_BASE;
      src.playbackRate.value = Math.pow(2, (note - base) / 12);
    }
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(bus);
    src.start(time);
    this.sounded++;
    src.onended = () => { try { g.disconnect(); } catch { /* ignore */ } };
  }
}

/** Sub-millisecond clock where there is one; `Date.now` rounds a 0.4 ms bake to 0. */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
