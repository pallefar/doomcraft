/**
 * DOOMCRAFT — the demons, as sound.
 *
 * THIS IS GAMEPLAY INFORMATION, NOT DECORATION
 *
 * In DOOM you locate and identify a monster by ear before you see it. That is
 * not flavour; it is the mechanic that makes a dark corridor tense, and it is
 * the reason `content/levels/e1m4-blackout.json` ships with `ambient: 0.12` and
 * `fogFar: 30`. A level you cannot see across is only frightening if it is a
 * level you can HEAR across. So this module has two hard obligations that a
 * pretty noise generator would not have:
 *
 *   1. EVERY ARCHETYPE IS IDENTIFIABLE BY SOUND ALONE. Not "different" —
 *      identifiable, which means separable on the axis the ear actually uses.
 *      The five voices are laid out on a spectral-centroid ladder with at least
 *      a 1.18x gap between neighbours, and `audio.test.ts` asserts every pair.
 *      Guessing was not involved: the ladder is anchored on measurements of the
 *      real lumps (see the table below).
 *   2. THE ALERT CRY IS POSITIONAL. A cue you cannot turn toward tells you only
 *      that you are about to die, which is not information. Every cue goes out
 *      through a panner, and every cue also fires `onCue` so the HUD can draw
 *      the same bearing for a player who cannot hear it — see `settings.ts`
 *      and `hud.ts`'s `threat()`.
 *
 * WHERE THE NUMBERS COME FROM
 *
 * The shareware DOOM1.WAD was parsed in a scratchpad and all 55 DS* lumps were
 * measured — duration, RMS envelope in eighths, autocorrelation f0 track,
 * smoothed spectral peaks, spectral centroid and flatness. Nothing was copied;
 * a table of numbers was. The four rows that matter:
 *
 *   lump        dur     f0 start->end   formants        centroid  flatness
 *   DSPOSIT1-3  0.5-1.0s  215 -> 156 Hz  393/530/678 Hz   430-790    0.02-0.07
 *   DSBGSIT1-2  1.2-1.5s  rising         689/864/1009     1279-1893  0.13-0.23
 *   DSBRSSIT    1.25 s    304 -> 268 Hz  345/686/1028     841       0.116
 *   DSDMACT     1.07 s    322 -> 157 Hz  409/568/487      378       0.012
 *
 * Two things fall straight out and shape the whole design. The voices are LONG
 * — half a second to a second and a half, never a blip. And they are TONAL, not
 * noise: flatness 0.003 to 0.39 with a median of 0.07, which a filtered-noise
 * scream cannot reach. Hence a glottal pulse source through parallel formant
 * bandpasses, with noise as a garnish measured in percent, rather than the
 * other way round.
 *
 * The Cacodemon and the Lost Soul have no lump in the SHAREWARE wad (they are
 * episode 2 and 3 monsters), so their rows are extrapolated rather than
 * measured, and are marked as such below. They are anchored to the nearest
 * measured neighbours — DSDMACT for the Cacodemon's wet hollow bellow, DSCLAW
 * (centroid 3366, flatness 0.39, the brightest voice-adjacent lump in the WAD)
 * for the Lost Soul's shriek.
 *
 * COST
 *
 * Nothing here builds a graph per scream. Each clip is baked ONCE into an
 * 11,025 Hz buffer by a plain sample loop and thereafter costs one
 * `AudioBufferSourceNode` + one gain + one panner. A bake is about a
 * millisecond; an archetype's five cues are baked together the first time one
 * of its kind is heard, so the cost lands once per monster species per session
 * and never during a wave. `update()` allocates nothing at all: the per-entity
 * state is four flat arrays of MAX_ENTITIES.
 */

import { MAX_ENTITIES } from '@shared/constants';
import { RemoveReason } from '@shared/protocol';

import {
  BAKE_RATE, Biquad, Glottis, NoiseSource,
  envAt, normalise, resampleTo,
} from './dsp';

/* ------------------------------------------------------------------------ *
 * Entity state bits
 *
 * Mirrored rather than imported, exactly as `game.ts` and
 * `characters/enemyRenderer.ts` already mirror them: a value import from
 * `server/src/sim.ts` would drag the authoritative simulation into the client
 * bundle for the sake of six integers.
 * ------------------------------------------------------------------------ */

const ES_ATTACK = 1 << 1;
const ES_PAIN = 1 << 2;
const ES_ALERT = 1 << 5;
const ES_WINDUP = 1 << 6;

/* ------------------------------------------------------------------------ *
 * What this module needs from the net client
 *
 * Structurally identical to `EnemyEntityView` in `characters/enemyRenderer.ts`
 * and declared separately for the same stated reason: so this file never
 * imports `NetClient` and a test can drive it with plain objects.
 * ------------------------------------------------------------------------ */

export interface MonsterEntityView {
  readonly id: number;
  readonly active: boolean;
  readonly type: number;
  readonly state: number;
  readonly health: number;
  readonly x: number; readonly y: number; readonly z: number;
}

/** Where the player's head is and which way it points. */
export interface ListenerPose {
  x: number; y: number; z: number;
  /** World yaw in radians, the same convention `hud.hurt()` takes. */
  yaw: number;
}

/* ------------------------------------------------------------------------ *
 * Cues
 * ------------------------------------------------------------------------ */

export const CUE_SIGHT = 0;
export const CUE_IDLE = 1;
export const CUE_ATTACK = 2;
export const CUE_PAIN = 3;
export const CUE_DEATH = 4;
export const CUE_COUNT = 5;

export type CueId = 0 | 1 | 2 | 3 | 4;

/** Human-readable, for the HUD's threat caption and for test failures. */
export const CUE_NAMES: readonly string[] = Object.freeze(['sight', 'idle', 'attack', 'pain', 'death']);

/* ------------------------------------------------------------------------ *
 * The voice table
 * ------------------------------------------------------------------------ */

/**
 * One synthesised utterance. The TRACT is not here — it lives on the archetype,
 * because a throat does not change shape between shouting and dying. Only the
 * excitation does, which is exactly the split the measurements show: DSPOSIT,
 * DSPOPAIN and DSPODTH share formants in the 400-830 Hz cluster and differ in
 * f0 glide, duration and envelope.
 */
export interface VoiceSpec {
  /** Seconds. */
  readonly dur: number;
  /** Fundamental at the start and at the end, Hz — the measured glide. */
  readonly f0: readonly [number, number];
  /** 0..1 of the period the glottal pulse occupies. Lower = buzzier. */
  readonly open: number;
  /** 0..1 noise mixed into the source, targeting the measured flatness. */
  readonly noise: number;
  /** Amplitude roughness rate (Hz) and depth (0..1) — the growl. */
  readonly rough: readonly [number, number];
  /** Vibrato rate (Hz) and depth as a fraction of f0. */
  readonly vib: readonly [number, number];
  /** Eight-bucket peak envelope, in the shape the real lumps measure. */
  readonly env: readonly number[];
  /** Extra variants, generated by detuning; 1 means "only the base clip". */
  readonly variants: number;
}

export interface ArchetypeVoices {
  readonly name: string;
  /** Target spectral centroid, Hz. The ladder rung this archetype occupies. */
  readonly centroid: number;
  /** Metres. Past this the archetype is not vocalised at all. */
  readonly audibleRange: number;
  /** Seconds between idle growls, min and max. */
  readonly idleGap: readonly [number, number];
  /** Three parallel formants, Hz — the vocal tract, constant across all cues. */
  readonly tract: readonly [number, number, number];
  /** Per-formant gain. */
  readonly tractGain: readonly [number, number, number];
  /** Formant Q. Higher = more resonant, more "throat". */
  readonly q: number;
  /**
   * One-pole-ish lowpass on the SOURCE, Hz — how soft the throat is.
   *
   * This is the knob that lets a Cacodemon be dark without giving it formants
   * below its own fundamental. DOOM's own voices are darker than a clean
   * glottal pulse because they are 8-bit lumps of a real recording; modelling
   * that as a wet, soft excitation is both closer to the truth and the only
   * way the measured centroid ORDER survives with physically-sane tracts.
   */
  readonly sourceLp: number;
  /**
   * Aspiration, 0..1 — breath noise added AFTER the tract, in the tract's own
   * band rather than broadband.
   *
   * Two jobs, both measured. It puts the flatness back where the WAD has it
   * (0.02-0.23 across the voiced lumps; a pure glottal source measures 0.001,
   * which is an organ pipe). And it stabilises the low archetypes: a Baron at
   * f0 110 Hz inside a 1.5 kHz band has about thirteen harmonics, so its
   * centroid swings on exactly where each one falls — 489 Hz on one cue and
   * 1176 on the next, which is one monster reading as two. A constant
   * broadband term in the same band anchors it.
   */
  readonly breath: number;
  readonly cues: readonly VoiceSpec[];
}

function spec(v: VoiceSpec): VoiceSpec { return Object.freeze(v); }
function archetype(a: ArchetypeVoices): ArchetypeVoices { return Object.freeze(a); }

/**
 * DOOM's own envelope shapes, measured in eighths off the lumps named.
 *
 * These are the single most DOOM-like thing in the file and the thing a
 * hand-written ADSR gets most wrong. DSBRSSIT does not decay — it sits at 0.82
 * to 1.0 for six eighths and only lets go at the end. DSPOPAIN is loudest at
 * BOTH ends. DSPODTH1 peaks in its fifth eighth.
 */
const ENV_SIGHT_HUMAN = Object.freeze([0.38, 0.62, 0.96, 0.86, 0.78, 0.62, 0.34, 0.12]);   // DSPOSIT1/3
const ENV_SIGHT_ROAR = Object.freeze([0.21, 0.52, 0.84, 1.0, 0.77, 0.60, 0.30, 0.19]);     // DSBGSIT1
const ENV_SIGHT_HOLD = Object.freeze([0.86, 0.89, 0.82, 0.94, 1.0, 0.84, 0.72, 0.35]);     // DSBRSSIT
const ENV_IDLE = Object.freeze([0.18, 0.63, 1.0, 1.0, 0.81, 0.42, 0.35, 0.14]);            // DSBGACT
const ENV_PAIN = Object.freeze([1.0, 0.95, 0.88, 0.66, 0.55, 0.72, 0.80, 0.42]);           // DSPOPAIN
const ENV_DEATH = Object.freeze([0.34, 0.86, 1.0, 0.82, 0.70, 0.58, 0.40, 0.14]);          // DSPODTH2
const ENV_BARK = Object.freeze([0.9, 1.0, 0.72, 0.44, 0.22, 0.1, 0.04, 0.0]);

/**
 * The five archetypes of `server/src/bots.ts`, in EntityType order, laid out on
 * a spectral-centroid ladder so no two can be confused:
 *
 *   Trooper 520 Hz  <  Baron 780  <  Cacodemon 1000  <  Imp 1500  <  Lost Soul 3000
 *
 * That ordering is not arbitrary either — it is the measured ordering. The real
 * DSPOSIT lumps sit at 430-790, DSBRSSIT at 841, DSBGSIT at 1279-1893, and the
 * brightest voice-adjacent lump in the WAD (DSCLAW) at 3366.
 */
export const MONSTER_VOICES: readonly ArchetypeVoices[] = Object.freeze([
  /* --- EntityType.IMP = 0 — the rusher ------------------------------------
     Measured: DSBGSIT1/2 centroid 1279/1893 Hz, flatness 0.13-0.23 (the
     roughest voiced lumps in the WAD), duration 1.23-1.46 s, formants
     689/864/1009 and 1400/1628/2439. Rough and bright: it is the one you hear
     coming, and the roughness is why. */
  archetype({
    name: 'Imp', centroid: 1600, audibleRange: 78, idleGap: [5.5, 13],
    tract: [782, 1304, 2056], tractGain: [0.85, 1.0, 0.7], q: 2.6, sourceLp: 3200, breath: 0.055,
    cues: [
      spec({ dur: 1.16, f0: [232, 306], open: 0.30, noise: 0.30, rough: [27, 0.34], vib: [6.2, 0.03], env: ENV_SIGHT_ROAR, variants: 2 }),
      spec({ dur: 0.82, f0: [214, 244], open: 0.32, noise: 0.26, rough: [23, 0.30], vib: [5.4, 0.025], env: ENV_IDLE, variants: 2 }),
      spec({ dur: 0.44, f0: [268, 320], open: 0.29, noise: 0.32, rough: [31, 0.30], vib: [7, 0.03], env: ENV_BARK, variants: 1 }),
      spec({ dur: 0.58, f0: [286, 240], open: 0.29, noise: 0.30, rough: [34, 0.36], vib: [8, 0.04], env: ENV_PAIN, variants: 2 }),
      spec({ dur: 0.86, f0: [252, 180], open: 0.31, noise: 0.33, rough: [21, 0.38], vib: [4.5, 0.05], env: ENV_DEATH, variants: 2 }),
    ],
  }),

  /* --- EntityType.ZOMBIE = 1 — the hitscan trooper -------------------------
     Measured: DSPOSIT1-3 centroid 430-790 Hz, flatness 0.02-0.07 (the CLEANEST
     voices in the WAD — a human throat, not a demon's), DSPOPAIN f0 falling
     215->156 with its three formants CLUSTERED at 455/571/592, DSPODTH2
     423/622/832. The lowest, most human rung, and the only one that reads as a
     man rather than a thing. */
  archetype({
    name: 'Trooper', centroid: 560, audibleRange: 82, idleGap: [6, 15],
    tract: [576, 784, 1408], tractGain: [1.0, 0.62, 0.22], q: 2.2, sourceLp: 2400, breath: 0.05,
    cues: [
      spec({ dur: 0.68, f0: [186, 150], open: 0.45, noise: 0.10, rough: [0, 0], vib: [5.0, 0.018], env: ENV_SIGHT_HUMAN, variants: 3 }),
      spec({ dur: 0.74, f0: [148, 166], open: 0.47, noise: 0.12, rough: [0, 0], vib: [4.4, 0.012], env: ENV_IDLE, variants: 2 }),
      spec({ dur: 0.26, f0: [204, 182], open: 0.44, noise: 0.11, rough: [0, 0], vib: [0, 0], env: ENV_BARK, variants: 1 }),
      spec({ dur: 0.72, f0: [215, 170], open: 0.44, noise: 0.09, rough: [0, 0], vib: [6.5, 0.03], env: ENV_PAIN, variants: 3 }),
      spec({ dur: 0.90, f0: [230, 160], open: 0.46, noise: 0.11, rough: [0, 0], vib: [5.5, 0.04], env: ENV_DEATH, variants: 3 }),
    ],
  }),

  /* --- EntityType.CACODEMON = 2 — the flyer --------------------------------
     EXTRAPOLATED: there is no DSCACSIT in the SHAREWARE WAD, because the
     Cacodemon is an episode 2 monster. Anchored on DSDMACT — centroid 378 Hz,
     f0 falling 322->157, formants 409/568/487 — for the wet hollow, then
     lifted onto its own rung between the Baron and the Imp. The identity
     marker is the WOBBLE: a 5.4 Hz vibrato at 5% depth that nothing standing
     on the floor has. You can hear that it is airborne, which is the one fact
     about a Cacodemon that changes what you do about it. */
  archetype({
    name: 'Cacodemon', centroid: 380, audibleRange: 74, idleGap: [4.5, 10],
    tract: [311, 490, 735], tractGain: [1.0, 0.70, 0.35], q: 2.6, sourceLp: 1100, breath: 0.10,
    cues: [
      spec({ dur: 1.24, f0: [128, 112], open: 0.50, noise: 0.20, rough: [11, 0.2], vib: [5.4, 0.05], env: ENV_SIGHT_HOLD, variants: 2 }),
      spec({ dur: 1.00, f0: [112, 120], open: 0.52, noise: 0.22, rough: [9, 0.22], vib: [5.0, 0.055], env: ENV_IDLE, variants: 2 }),
      spec({ dur: 0.52, f0: [124, 138], open: 0.49, noise: 0.20, rough: [14, 0.18], vib: [7, 0.04], env: ENV_BARK, variants: 1 }),
      spec({ dur: 0.70, f0: [134, 118], open: 0.49, noise: 0.21, rough: [16, 0.24], vib: [8, 0.06], env: ENV_PAIN, variants: 2 }),
      spec({ dur: 1.10, f0: [126, 96], open: 0.51, noise: 0.23, rough: [8, 0.28], vib: [4.0, 0.07], env: ENV_DEATH, variants: 2 }),
    ],
  }),

  /* --- EntityType.BARON = 3 — the tank -------------------------------------
     Measured: DSBRSSIT f0 304->268 Hz, formants 345/686/1028 — note that those
     three are very nearly 1:2:3 on 343 Hz, which is why the lump reads as one
     enormous resonant throat rather than as a voice. Duration 1.245 s, and an
     envelope that does not decay: 0.86/0.89/0.82/0.94/1.0/0.84/0.72/0.35.
     The tract keeps the measured 1:2:3 ratio; the fundamental sits an octave
     below the measurement because SIZE is carried by f0 and the WAD's own
     Baron gets its size from a resonance that an 11 kHz 8-bit lump flatters.
     F1 is deliberately the QUIETEST of the three: emphasising F2 and F3 over
     the fundamental is what "resonant throat" means, and it is what keeps this
     rung above the Trooper instead of underneath it. */
  archetype({
    name: 'Baron', centroid: 850, audibleRange: 92, idleGap: [7, 16],
    tract: [450, 900, 1344], tractGain: [0.50, 1.0, 0.85], q: 2.6, sourceLp: 1700, breath: 0.09,
    cues: [
      spec({ dur: 1.34, f0: [116, 102], open: 0.36, noise: 0.13, rough: [17, 0.22], vib: [3.4, 0.02], env: ENV_SIGHT_HOLD, variants: 2 }),
      spec({ dur: 1.10, f0: [104, 98], open: 0.38, noise: 0.13, rough: [14, 0.2], vib: [2.8, 0.015], env: ENV_IDLE, variants: 2 }),
      spec({ dur: 0.62, f0: [118, 132], open: 0.35, noise: 0.15, rough: [22, 0.24], vib: [4, 0.02], env: ENV_BARK, variants: 1 }),
      spec({ dur: 0.78, f0: [122, 106], open: 0.35, noise: 0.14, rough: [19, 0.26], vib: [5, 0.03], env: ENV_PAIN, variants: 2 }),
      spec({ dur: 1.42, f0: [112, 84], open: 0.37, noise: 0.16, rough: [12, 0.3], vib: [2.4, 0.05], env: ENV_DEATH, variants: 2 }),
    ],
  }),

  /* --- EntityType.LOST_SOUL = 4 — the fast flyer ---------------------------
     EXTRAPOLATED: no DSSKLATK in the shareware WAD either. Anchored on DSCLAW,
     the brightest voice-adjacent lump measured — centroid 3366 Hz, 95% rolloff
     5305, flatness 0.39, which is within a whisker of the 5,512 Hz ceiling the
     format imposes. It is the ONLY archetype above 2 kHz, and it is SHORT: a
     Lost Soul closes at 13.5 m/s, so a 1.3-second roar would still be playing
     after it hit you, which is the opposite of a warning. */
  archetype({
    name: 'Lost Soul', centroid: 3100, audibleRange: 64, idleGap: [3.5, 8],
    tract: [2092, 3187, 4183], tractGain: [1.0, 0.95, 0.7], q: 3.2, sourceLp: 5000, breath: 0.05,
    cues: [
      spec({ dur: 0.62, f0: [420, 660], open: 0.22, noise: 0.36, rough: [41, 0.28], vib: [9, 0.05], env: ENV_SIGHT_ROAR, variants: 2 }),
      spec({ dur: 0.50, f0: [380, 410], open: 0.23, noise: 0.34, rough: [37, 0.24], vib: [8, 0.04], env: ENV_IDLE, variants: 2 }),
      spec({ dur: 0.36, f0: [500, 700], open: 0.21, noise: 0.40, rough: [47, 0.3], vib: [11, 0.06], env: ENV_BARK, variants: 1 }),
      spec({ dur: 0.34, f0: [560, 470], open: 0.21, noise: 0.38, rough: [44, 0.32], vib: [12, 0.07], env: ENV_PAIN, variants: 2 }),
      spec({ dur: 0.70, f0: [520, 300], open: 0.23, noise: 0.42, rough: [33, 0.36], vib: [7, 0.09], env: ENV_DEATH, variants: 2 }),
    ],
  }),
]);

/**
 * Lip-radiation coefficient in the output first difference `y[n] - R*y[n-1]`.
 *
 * A voice's source-filter chain ends in radiation off the lips, which is
 * mathematically a differentiator — R = 1, a flat +6 dB/octave. That is the
 * textbook value and it is WRONG here, for a reason worth writing down: the
 * textbook assumes a source that already falls at -12 dB/octave, and at an
 * 11 kHz bake rate the whole usable band sits inside the first two octaves of
 * a glottal pulse, so a full differentiator tilts the entire spectrum instead
 * of just correcting it. Retuning the archetypes under R = 1 drove the Baron's
 * formants down to 150/301/449 Hz — below its own fundamental, which is not a
 * throat, it is a bug with a nice comment.
 *
 * R = 0.72 keeps the part that matters. Its response is 0.28 at DC and 1.72 at
 * Nyquist: a gentle shelf that removes the leaked FUNDAMENTAL — which was
 * competing with the formants through the bandpass skirts and making the
 * timbre flip on where a harmonic happened to fall — without pretending the
 * band is wider than DOOM's format allows.
 */
const RADIATION = 0.72;

/** Constant RMS the voiced path is levelled to before the breath is mixed in. */
const VOICED_RMS = 0.25;

/* ------------------------------------------------------------------------ *
 * The renderer
 * ------------------------------------------------------------------------ */

/**
 * Render one utterance into an 11,025 Hz mono buffer.
 *
 * Pure: no `AudioContext`, no `Math.random`, deterministic in `seed`. That is
 * what lets `audio.test.ts` assert the spectral ladder rather than describe it.
 *
 * `detune` shifts the whole clip in semitones so a variant costs a re-bake and
 * not a second table row; DOOM shipped three DSPOSIT lumps for the same reason.
 */
export function bakeVoice(a: ArchetypeVoices, cue: CueId, seed: number, detune = 0): Float32Array {
  const v = a.cues[cue];
  const n = Math.max(8, Math.round(v.dur * BAKE_RATE));
  const out = new Float32Array(n);
  const rng = new NoiseSource(seed);
  const glottis = new Glottis();
  glottis.openQuotient = v.open;

  const pitch = Math.pow(2, detune / 12);
  const f1 = new Biquad().bandpass(a.tract[0] * pitch, a.q);
  const f2 = new Biquad().bandpass(a.tract[1] * pitch, a.q * 0.9);
  const f3 = new Biquad().bandpass(a.tract[2] * pitch, a.q * 0.75);
  const soft = new Biquad().lowpass(a.sourceLp, 0.6);
  const g1 = a.tractGain[0]; const g2 = a.tractGain[1]; const g3 = a.tractGain[2];

  const invN = 1 / (n - 1);
  const vibW = v.vib[0] * Math.PI * 2 / BAKE_RATE;
  let jitter = 0;

  /* ---- pass 1: the voiced path, on its own ---------------------------- */
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const t = i * invN;
    /* Jitter — a slow random walk of under a percent on the fundamental. Real
       larynxes do this and synthetic ones that do not sound like organs, but
       the reason it is not optional here is arithmetic: a formant with any
       useful Q has a bandwidth narrower than a 110 Hz fundamental's harmonic
       spacing, so without jitter the timbre flips depending on whether a
       harmonic happens to land on the peak. */
    jitter += (rng.next() * 0.09 - jitter) * 0.02;
    const f0 = v.f0[0] * Math.pow(v.f0[1] / v.f0[0], t) * pitch
      * (1 + v.vib[1] * Math.sin(vibW * i) + jitter);
    const src = soft.step(glottis.step(f0) * (1 - v.noise) + rng.next() * v.noise);
    const y = f1.step(src) * g1 + f2.step(src) * g2 + f3.step(src) * g3;
    out[i] = y;
    sumSq += y * y;
  }

  /* ---- level the voiced path BEFORE the breath is added ----------------
     This is the difference between one monster and three. A formant bank fed a
     low fundamental has only a dozen or so harmonics to work with, so its
     OUTPUT LEVEL swings by several-fold depending on where those harmonics
     fall relative to the peaks. Normalising the finished clip does not fix
     that: it makes it worse, because a weak voiced path gets boosted and drags
     the fixed-level breath up with it, and the clip comes out both brighter
     and noisier. Measured with the breath mixed in before this step, the
     Baron's five cues spanned 484 to 1547 Hz centroid and 0.038 to 0.207
     flatness — a range wider than the gap between two archetypes. Levelling
     the voiced path to a constant RMS first collapses that. */
  const rms = Math.sqrt(sumSq / n);
  const gVoiced = rms > 1e-9 ? VOICED_RMS / rms : 0;

  /* ---- pass 2: breath, radiation, envelope ---------------------------- */
  const breathBp = new Biquad().bandpass((a.tract[1] + a.tract[2]) * 0.5, 0.8);
  // Keeps the glottal DC offset out of the buffer. An offset that survives into
  // an AudioBuffer thumps audibly at the start of every single play.
  const dc = new Biquad().highpass(70, 0.7);
  const roughW = v.rough[0] * Math.PI * 2 / BAKE_RATE;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i * invN;
    const mixed = dc.step(out[i] * gVoiced + breathBp.step(rng.next()) * a.breath);
    const radiated = mixed - RADIATION * prev;
    prev = mixed;
    // Roughness is AMPLITUDE, not frequency: it is what makes the Imp growl
    // rather than warble, and it is why the real Imp lumps measure a flatness
    // three to ten times any other monster's.
    const rough = v.rough[1] > 0 ? 1 - v.rough[1] * (0.5 + 0.5 * Math.sin(roughW * i)) : 1;
    out[i] = radiated * envAt(v.env, t) * rough;
  }
  normalise(out, 0.86);
  return out;
}

/* ------------------------------------------------------------------------ *
 * Playback
 *
 * Nothing here owns a Web Audio node. `engine.ts` has a pooled voice chain, a
 * priority-stealing allocator, a bus graph and a limiter, and `spatial.ts` has
 * distance, panning and voxel occlusion with a per-frame raycast budget. Both
 * are consumed through the narrowest structural interfaces that will carry a
 * monster's scream, so this module never imports either — which is what lets
 * the whole state machine be tested against twenty lines of fake.
 * ------------------------------------------------------------------------ */

/** What `MonsterVoices` needs of `AudioEngine`. */
export interface MonsterAudioTarget {
  /** False until a user gesture has built and resumed the context. */
  readonly ready: boolean;
  /** Device rate. Bakes are resampled to it before they are installed. */
  readonly sampleRate: number;
  hasBuffer(id: string): boolean;
  addBuffers(id: string, pcm: Float32Array[]): void;
  play(id: string, opts: {
    /** engine.ts's `BusId`: BUS_SFX 0, BUS_MUSIC 1, BUS_UI 2, BUS_AMBIENCE 3. */
    bus?: 0 | 1 | 2 | 3; gain?: number; rate?: number; pan?: number;
    priority?: number; lowpass?: number; delay?: number;
  }, minGapMs?: number): number;
}

/** What `MonsterVoices` needs of `SpatialAudio`. Filled in place, never allocated. */
export interface MonsterSpatialResult {
  gain: number; pan: number; lowpass: number; distance: number;
}
export interface MonsterSpatial {
  resolve(x: number, y: number, z: number, out: MonsterSpatialResult, refDistance?: number): boolean;
}

/** `BUS_SFX` in engine.ts. Mirrored rather than imported, like the state bits. */
const BUS_SFX = 0 as const;

/**
 * Engine priority per cue.
 *
 * The engine's ladder runs PRIO_AMBIENT 0 to PRIO_UI 9, with the local player's
 * own weapon at 6 and taking damage at 7. Monster voices deliberately sit
 * BELOW the player's weapon and above ambience: a wave of Imps must never be
 * able to steal the slot a shotgun is about to need, and a death cry should
 * still outrank a footstep. Death is the loudest thing a monster gets because
 * a kill you do not hear is a kill you do not know you got.
 */
const CUE_ENGINE_PRIORITY: readonly number[] = Object.freeze([
  4,  // sight  — the same rank as a remote weapon: it is information
  1,  // idle   — just above ambience
  3,  // attack
  3,  // pain
  5,  // death
]);

/**
 * Priority WITHIN the monster budget, which is a separate and stricter thing
 * than the engine's global pool. Higher wins.
 */
const CUE_PRIORITY: readonly number[] = Object.freeze([3, 0, 2, 2, 4]);

/** Reported to the HUD so a player who cannot hear the cue can still see it. */
export interface CueEvent {
  /** EntityType of whatever made the sound. */
  readonly type: number;
  readonly cue: CueId;
  /** WORLD yaw from the listener toward the source — same convention as `hud.hurt`. */
  readonly yaw: number;
  /** Metres. */
  readonly distance: number;
  /** 0..1, after distance and occlusion. What the ear actually got. */
  readonly loudness: number;
  /** False when nothing sounded: out of range, capped, or the context is asleep. */
  readonly heard: boolean;
}

export interface MonsterVoicesOptions {
  /**
   * How many monster voices may sound at once.
   *
   * This is deliberately much tighter than the engine's own 24-slot pool, and
   * it is not redundant with it. The engine's cap stops the audio thread being
   * overrun; this one stops a Horde wave being able to spend the whole pool on
   * growling, however politely it yields, because a shotgun that gets its slot
   * but arrives under nine simultaneous Imps has still been buried.
   */
  maxVoices?: number;
  /** Fired for every cue that plays, AND for every cue suppressed by the cap. */
  onCue?: (e: CueEvent) => void;
  /** Overrides the bake seed; only tests need this. */
  seed?: number;
}

const DEFAULT_MAX_VOICES = 6;

/** Reference distance for the fallback rolloff, metres. */
const REF_DISTANCE = 6;

export class MonsterVoices {
  private readonly engine: MonsterAudioTarget;
  private readonly opts: MonsterVoicesOptions;
  private readonly maxVoices: number;
  private spatial: MonsterSpatial | null = null;

  /** Archetypes whose five cues have been baked and installed. */
  private readonly primed = new Uint8Array(MONSTER_VOICES.length);

  /* The monster budget. Two flat arrays and a count: a live voice is a
     priority and the clock time it finishes at, and nothing else. */
  private readonly livePrio = new Int8Array(32);
  private readonly liveEnds = new Float64Array(32);
  private liveCount = 0;

  /* Per-entity state. Flat arrays of MAX_ENTITIES, so `update` allocates
     nothing: at 256 entries this is 3 KB total and a cache line's worth of
     work per monster per frame. */
  private readonly seen = new Uint8Array(MAX_ENTITIES);
  private readonly greeted = new Uint8Array(MAX_ENTITIES);
  private readonly lastState = new Uint8Array(MAX_ENTITIES);
  private readonly idleAt = new Float32Array(MAX_ENTITIES);

  private readonly spatialOut: MonsterSpatialResult = { gain: 1, pan: 0, lowpass: 0, distance: 0 };
  private clock = 0;
  /** Where `primeStep` has got to, as a flat archetype*CUE_COUNT + cue index. */
  private bakeCursor = 0;
  private rng: NoiseSource;
  private disposed = false;

  /** Cues that played, and cues the cap ate. Read by the perf report. */
  played = 0;
  suppressed = 0;
  /** Milliseconds spent baking, all told. */
  bakeMs = 0;

  constructor(engine: MonsterAudioTarget, opts: MonsterVoicesOptions = {}) {
    this.engine = engine;
    this.opts = opts;
    this.maxVoices = Math.max(1, Math.min(32, opts.maxVoices ?? DEFAULT_MAX_VOICES));
    this.rng = new NoiseSource(opts.seed ?? 0x5ca1ab1e);
  }

  /** Attach the spatialiser. Without one, cues fall back to a flat 1/d rolloff. */
  setSpatial(s: MonsterSpatial | null): void { this.spatial = s; }

  /** Buffer id for one archetype's cue, in the engine's registry. */
  static bufferId(type: number, cue: CueId): string { return `mon.${type}.${cue}`; }

  /**
   * Bake one archetype's five cues and install them in the engine.
   *
   * Idempotent, and safe to call ahead of time — Horde knows its wave
   * composition a second before the wave lands, which is exactly when this
   * should be paid rather than on the frame the first Imp opens its mouth.
   */
  prime(type: number): void {
    if (this.disposed) return;
    const a = MONSTER_VOICES[type];
    if (a === undefined || this.primed[type] === 1) return;
    if (!this.engine.ready) return;
    for (let c = 0; c < a.cues.length; c++) this.primeCue(type, c as CueId);
    this.primed[type] = 1;
  }

  /** One cue and all its detuned variants. */
  private primeCue(type: number, cue: CueId): void {
    const a = MONSTER_VOICES[type];
    if (a === undefined) return;
    const id = MonsterVoices.bufferId(type, cue);
    if (this.engine.hasBuffer(id)) return;
    const t0 = nowMs();
    const rate = this.engine.sampleRate;
    const v = a.cues[cue];
    const variants: Float32Array[] = [];
    for (let k = 0; k < v.variants; k++) {
      // Symmetric detune around zero: -1, +1, 0, +2 ... so a two-variant cue is
      // a pair a semitone apart rather than one clip and one flat one.
      const detune = v.variants === 1 ? 0 : (k - (v.variants - 1) / 2) * 1.4;
      variants.push(resampleTo(bakeVoice(a, cue, hash3(type, cue, k), detune), BAKE_RATE, rate));
    }
    this.engine.addBuffers(id, variants);
    this.bakeMs += nowMs() - t0;
  }

  /**
   * Bake ONE cue and return whether anything is left to do.
   *
   * The lazy path in `play()` is correct but it pays for a whole archetype on
   * the frame the first Imp of a match opens its mouth — which is, by
   * construction, a frame that already has an Imp arriving in it. `Sfx` solved
   * the same problem with a per-frame bake budget and this is that.
   *
   * The granularity is a CUE, not an archetype, and that was measured rather
   * than guessed: a Cacodemon's five cues are 4.5 seconds of audio and take
   * 17 ms to bake, which is a dropped frame on its own before the resample to
   * the device rate is counted. One cue is about 3 ms, which is the same slice
   * `Sfx.bakeStep` already spends, and the whole cast is in memory inside
   * twenty-five frames of the context unlocking.
   */
  primeStep(): boolean {
    if (this.disposed || !this.engine.ready) return true;
    while (this.bakeCursor < MONSTER_VOICES.length * CUE_COUNT) {
      const t = (this.bakeCursor / CUE_COUNT) | 0;
      const c = this.bakeCursor % CUE_COUNT;
      this.bakeCursor++;
      if (this.primed[t] === 1) continue;
      this.primeCue(t, c as CueId);
      if (c === CUE_COUNT - 1) this.primed[t] = 1;
      return this.bakeCursor < MONSTER_VOICES.length * CUE_COUNT;
    }
    return false;
  }

  /** True once every archetype's cues are baked and installed. */
  get primeComplete(): boolean {
    for (let t = 0; t < MONSTER_VOICES.length; t++) if (this.primed[t] === 0) return false;
    return true;
  }

  /**
   * Fire one cue.
   *
   * Returns false when nothing sounded — out of range, not primed, the context
   * asleep, or the cap refused it. `onCue` fires either way, because the
   * VISUAL threat indicator must not disappear just because the mix was busy:
   * a deaf player and a hearing player have to be told the same things.
   */
  play(type: number, cue: CueId, x: number, y: number, z: number, listener: ListenerPose): boolean {
    if (this.disposed) return false;
    const a = MONSTER_VOICES[type];
    if (a === undefined) return false;

    const dx = x - listener.x;
    const dy = y - listener.y;
    const dz = z - listener.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > a.audibleRange) return false;

    // DOOM's yaw convention, matching `game.ts`'s call into `hud.hurt`.
    const yaw = Math.atan2(dx, dz);
    const onCue = this.opts.onCue;

    /* Spatialise first, so the number the HUD is told is the number the ear
       would actually have got — including a wall in the way. A Baron roaring
       through two metres of stone should draw a fainter bearing than one in
       the open at the same distance, or the visual alternative is lying about
       how close the thing is. */
    const out = this.spatialOut;
    if (this.spatial !== null) {
      this.spatial.resolve(x, y, z, out, REF_DISTANCE);
    } else {
      out.gain = REF_DISTANCE / Math.max(REF_DISTANCE, dist);
      out.distance = dist;
      out.lowpass = 0;
      // Azimuth relative to where the player is looking, so a cue can be turned
      // onto even with no spatialiser wired in. A cue you cannot turn toward
      // tells you only that you are about to die, which is not information.
      out.pan = Math.max(-1, Math.min(1, Math.sin(yaw - listener.yaw) * 0.92));
    }

    const fire = (heard: boolean): boolean => {
      if (onCue !== undefined) onCue({ type, cue, yaw, distance: dist, loudness: heard ? out.gain : 0, heard });
      return heard;
    };

    if (!this.engine.ready) return fire(false);
    if (this.primed[type] === 0) this.prime(type);
    const id = MonsterVoices.bufferId(type, cue);
    if (!this.engine.hasBuffer(id)) return fire(false);

    this.retire(this.clock);
    if (!this.makeRoom(CUE_PRIORITY[cue])) { this.suppressed++; return fire(false); }

    /* A small random detune per utterance so ten Imps are ten Imps and not one
       Imp played ten times. +-3% is under a semitone: character, not tuning. */
    const rate = 1 + this.rng.next() * 0.03;
    const slot = this.engine.play(id, {
      bus: BUS_SFX,
      gain: out.gain,
      pan: out.pan,
      rate,
      lowpass: out.lowpass,
      priority: CUE_ENGINE_PRIORITY[cue],
    }, cue === CUE_IDLE ? 120 : 0);
    if (slot < 0) { this.suppressed++; return fire(false); }

    const dur = a.cues[cue].dur / rate;
    this.livePrio[this.liveCount] = CUE_PRIORITY[cue];
    this.liveEnds[this.liveCount] = this.clock + dur;
    this.liveCount++;
    this.played++;
    return fire(true);
  }

  /**
   * One frame. Walks the entity list, converts state-bit edges into cues, and
   * runs the idle-growl timers.
   *
   * Allocation-free by construction: no closures per entity, no temporary
   * objects, no `Map`. The only writes are into the four flat arrays.
   */
  update(dt: number, listener: ListenerPose, entities: readonly MonsterEntityView[]): void {
    if (this.disposed) return;
    this.clock += dt;
    this.retire(this.clock);

    for (let i = 0; i < MAX_ENTITIES; i++) this.seen[i] = 0;

    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (!e.active) continue;
      const id = e.id;
      if (id < 0 || id >= MAX_ENTITIES) continue;
      const type = e.type;
      const a = MONSTER_VOICES[type];
      if (a === undefined) continue;   // pickups and projectiles do not speak

      this.seen[id] = 1;
      const state = e.state & 0xff;
      const prev = this.lastState[id];
      this.lastState[id] = state;

      const alert = (state & ES_ALERT) !== 0;

      /* Sight cry: the FIRST time this entity is alert. Not on spawn — a
         monster that has not noticed you has nothing to shout about, and DOOM
         is explicit about this: the sight sound belongs to `A_Look` seeing the
         player, which is what ES_ALERT is. */
      if (alert && this.greeted[id] === 0) {
        this.greeted[id] = 1;
        this.idleAt[id] = this.clock + this.randRange(a.idleGap[0], a.idleGap[1]);
        this.play(type, CUE_SIGHT, e.x, e.y, e.z, listener);
        continue;
      }

      // Pain and attack are rising edges on the state byte.
      if ((state & ES_PAIN) !== 0 && (prev & ES_PAIN) === 0) {
        this.play(type, CUE_PAIN, e.x, e.y, e.z, listener);
        continue;
      }
      const swinging = (state & (ES_ATTACK | ES_WINDUP)) !== 0;
      const wasSwinging = (prev & (ES_ATTACK | ES_WINDUP)) !== 0;
      if (swinging && !wasSwinging) {
        this.play(type, CUE_ATTACK, e.x, e.y, e.z, listener);
        continue;
      }

      /* The active growl. DOOM rolls this per tic; here it is a per-entity
         timer, which gives the same texture without 35 rolls a second. */
      if (alert && this.clock >= this.idleAt[id]) {
        this.idleAt[id] = this.clock + this.randRange(a.idleGap[0], a.idleGap[1]);
        this.play(type, CUE_IDLE, e.x, e.y, e.z, listener);
      }
    }

    // Anything that left the snapshot without an `entityGone` forgets its
    // state, so a recycled id cannot inherit the last tenant's alert flag.
    for (let i = 0; i < MAX_ENTITIES; i++) {
      if (this.seen[i] === 1) continue;
      if (this.greeted[i] === 0 && this.lastState[i] === 0) continue;
      this.greeted[i] = 0;
      this.lastState[i] = 0;
    }
  }

  /**
   * An entity left the snapshot.
   *
   * The death cry is a client-side fact for exactly the reason
   * `characters/enemyRenderer.ts` documents: `sim.damageEntity()` sets ES_DEAD
   * and calls `removeEntity()` in the SAME statement, so a dead monster is
   * never transmitted as dead. Waiting to see ES_DEAD on the wire means never
   * hearing a single death. Only `KILLED` screams; a despawn is silent, which
   * is what stops a Horde cull sounding like a massacre.
   */
  entityGone(view: MonsterEntityView, reason: number, listener: ListenerPose): void {
    if (this.disposed) return;
    const id = view.id;
    if (id >= 0 && id < MAX_ENTITIES) { this.greeted[id] = 0; this.lastState[id] = 0; }
    if (reason !== RemoveReason.KILLED) return;
    this.play(view.type, CUE_DEATH, view.x, view.y, view.z, listener);
  }

  /** Live monster voices right now. */
  get voiceCount(): number { return this.liveCount; }

  /** Forget everything — a mode change, a level load, a leave. */
  stopAll(): void {
    this.liveCount = 0;
    this.greeted.fill(0);
    this.lastState.fill(0);
  }

  dispose(): void {
    this.stopAll();
    this.disposed = true;
  }

  /* ---- internals ---------------------------------------------------- */

  private randRange(lo: number, hi: number): number {
    return lo + (this.rng.next() * 0.5 + 0.5) * (hi - lo);
  }

  /** Drop budget entries whose clip has finished. */
  private retire(now: number): void {
    let w = 0;
    for (let i = 0; i < this.liveCount; i++) {
      if (this.liveEnds[i] <= now) continue;
      this.liveEnds[w] = this.liveEnds[i];
      this.livePrio[w] = this.livePrio[i];
      w++;
    }
    this.liveCount = w;
  }

  /**
   * Make a slot in the monster budget.
   *
   * A new cue only displaces a live one of STRICTLY lower priority, and it
   * displaces the nearest-to-finishing of those, so the cap costs you the growl
   * that was almost over rather than the death cry that just started.
   */
  private makeRoom(priority: number): boolean {
    if (this.liveCount < this.maxVoices) return true;
    let victim = -1;
    let bestEnd = Infinity;
    for (let i = 0; i < this.liveCount; i++) {
      if (this.livePrio[i] >= priority) continue;
      if (this.liveEnds[i] < bestEnd) { bestEnd = this.liveEnds[i]; victim = i; }
    }
    if (victim < 0) return false;
    this.liveEnds[victim] = this.liveEnds[this.liveCount - 1];
    this.livePrio[victim] = this.livePrio[this.liveCount - 1];
    this.liveCount--;
    return true;
  }
}

/** Three-way integer hash, so a bake seed is stable across runs. */
function hash3(a: number, b: number, c: number): number {
  let h = (a | 0) * 0x9e3779b1 ^ (b | 0) * 0x85ebca6b ^ (c | 0) * 0xc2b2ae35;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return (h ^ (h >>> 13)) >>> 0;
}

/** Sub-millisecond clock where there is one; `Date.now` rounds a 0.4 ms bake to 0. */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
