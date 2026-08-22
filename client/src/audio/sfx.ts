/**
 * DOOMCRAFT — the sound catalogue.
 *
 * Every sound the game makes, as data, plus the thin semantic layer the rest of
 * the codebase calls ("a shotgun fired over there", "a boot landed on snow").
 * Nothing here allocates at fire time; the specs are baked to PCM once and the
 * play methods only place and start them.
 *
 * ── Where the weapon numbers come from ────────────────────────────────────
 *
 * Two sources, and it is worth being precise about which is which.
 *
 * TIMBRE is measured. See the header of `synth.ts` for how: DOOM 1.9's own
 * DMX lumps were decoded and analysed, because the video captures under `ref/`
 * turned out to carry no audio track at all. The numbers that came back and
 * that this catalogue is built to hit:
 *
 *     lump        dur   plateau  tail   85% rolloff  peak Hz  crest  <200 Hz
 *     DSSHOTGN    854     410    420       548 Hz     153     13.8    64.6%
 *     DSPISTOL    511     200    270       707 Hz     218     14.6    33.5%
 *     DSRLAUNC   1401     400    560      1268 Hz      76     15.0    30.5%
 *     DSBAREXP   1683     540   1143      1822 Hz      94     14.9    56.0%
 *     DSSAWFUL   1638    1638      -      4048 Hz     161     13.6     5.0%
 *     DSSGCOCK    532     440     92      3641 Hz     201     18.5    11.4%
 *     DSPUNCH     223      60    140       164 Hz      96     14.1    85.9%
 *     DSITEMUP    202     200      2       998 Hz     201     11.2    28.1%
 *
 * The single most useful thing in that table is the shape of DSSHOTGN, and it
 * is not what people build. A shotgun is usually synthesised as a short noise
 * burst with an exponential decay. The real one is a 410 ms PLATEAU that never
 * falls 6 dB, then a 420 ms tail — 854 ms of continuous roar — and 85% of its
 * energy is under 548 Hz. It is long, it is dark, and it is saturated to a
 * 13.8 dB crest factor. `ref/BAR.md` says gunfeel is the thing this piece is
 * judged on and that voxiom's weapon has no audio punch; a bright 60 ms tick
 * loses that comparison no matter how loud it is, so the shotgun below is 854 ms
 * with a 410 ms hold, a 153 Hz resonant body and a drive of 7.
 *
 * DURATION is derived, not copied, and this is the one deliberate departure.
 * DOOM's pistol fires about twice a second; ours is 420 rpm, seven times a
 * second. Playing a 511 ms sample at 7 Hz stacks three and a half copies and
 * turns the weapon into mud. So every weapon's fire sound is capped at
 * **1.6x its own fire interval** (`tailBudgetMs` below) — at most two shots
 * ever overlap, the attack of each one stays legible, and the measured SHAPE
 * (fast attack, held body, long-curve tail) is preserved inside whatever length
 * the cadence allows. The shotgun is the happy case: 75 rpm is an 800 ms
 * interval against a measured 854 ms sound, so it keeps essentially all of it.
 *
 * ── Voice discipline ──────────────────────────────────────────────────────
 *
 * A shotgun resolves seven pellets and reports seven impacts in one frame.
 * Seven copies of one buffer started in the same millisecond is not seven
 * impacts, it is one impact 17 dB too loud and comb-filtered. Every play method
 * that can be called per-pellet passes a retrigger gate (`minGapMs`) and the
 * engine collapses the burst.
 */

import {
  WEAPONS, WEAPON_COUNT, WeaponId, FireKind, BlockId, BLOCK_COUNT,
} from '@shared/index';
import type { SoundSpec } from './synth';
import { render } from './synth';
import {
  AudioEngine, BUS_SFX, BUS_UI, BUS_AMBIENCE,
  PRIO_AMBIENT, PRIO_FOOTSTEP, PRIO_IMPACT, PRIO_BLOCK, PRIO_REMOTE_WEAPON,
  PRIO_PICKUP, PRIO_LOCAL_WEAPON, PRIO_DAMAGE, PRIO_EXPLOSION, PRIO_UI,
  type PlayOptions,
} from './engine';
import { SpatialAudio, createSpatialResult, type SpatialResult } from './spatial';

/* ------------------------------------------------------------------------ *
 * Surface materials
 * ------------------------------------------------------------------------ */

export const MAT_STONE = 0;
export const MAT_DIRT = 1;
export const MAT_GRASS = 2;
export const MAT_WOOD = 3;
export const MAT_METAL = 4;
export const MAT_GLASS = 5;
export const MAT_SNOW = 6;
export const MAT_LIQUID = 7;
export const MAT_ORGANIC = 8;
export const MAT_COUNT = 9;

export const MATERIAL_NAMES: readonly string[] = Object.freeze([
  'stone', 'dirt', 'grass', 'wood', 'metal', 'glass', 'snow', 'liquid', 'organic',
]);

/**
 * Block id -> acoustic class.
 *
 * Grouped by how a surface SOUNDS when struck, which is not how it looks and
 * not how the mesher groups it: ice belongs with glass because both ring and
 * shatter, gravel belongs with dirt because both scatter, and a tech panel
 * belongs with metal because both ping. Twenty-five blocks collapse to nine
 * classes, which is nine impact sounds and nine footsteps rather than fifty.
 */
export const BLOCK_MATERIAL = new Uint8Array(BLOCK_COUNT);
{
  BLOCK_MATERIAL.fill(MAT_STONE);
  const m = BLOCK_MATERIAL;
  m[BlockId.AIR] = MAT_DIRT;
  m[BlockId.STONE] = MAT_STONE;
  m[BlockId.DIRT] = MAT_DIRT;
  m[BlockId.GRASS] = MAT_GRASS;
  m[BlockId.SAND] = MAT_DIRT;
  m[BlockId.WATER] = MAT_LIQUID;
  m[BlockId.WOOD] = MAT_WOOD;
  m[BlockId.LEAVES] = MAT_GRASS;
  m[BlockId.METAL] = MAT_METAL;
  m[BlockId.LAVA] = MAT_LIQUID;
  m[BlockId.GLASS] = MAT_GLASS;
  m[BlockId.BRICK] = MAT_STONE;
  m[BlockId.PLANKS] = MAT_WOOD;
  m[BlockId.COBBLESTONE] = MAT_STONE;
  m[BlockId.SNOW] = MAT_SNOW;
  m[BlockId.ICE] = MAT_GLASS;
  m[BlockId.OBSIDIAN] = MAT_STONE;
  m[BlockId.GRAVEL] = MAT_DIRT;
  m[BlockId.RUSTED_METAL] = MAT_METAL;
  m[BlockId.TECH_PANEL] = MAT_METAL;
  m[BlockId.HELLSTONE] = MAT_STONE;
  m[BlockId.BONE] = MAT_ORGANIC;
  m[BlockId.SLIME] = MAT_ORGANIC;
  m[BlockId.NEON] = MAT_GLASS;
  m[BlockId.BEDROCK] = MAT_STONE;
}

export function materialOf(blockId: number): number {
  return blockId >= 0 && blockId < BLOCK_COUNT ? BLOCK_MATERIAL[blockId] : MAT_STONE;
}

/* ------------------------------------------------------------------------ *
 * Sound ids
 * ------------------------------------------------------------------------ */

export const sndFire = (w: number): string => `w${w}.fire`;
export const sndReload = (w: number): string => `w${w}.reload`;
export const sndDry = (w: number): string => `w${w}.dry`;
export const sndSwitch = (w: number): string => `w${w}.swap`;
export const sndImpact = (m: number): string => `imp.${m}`;
export const sndStep = (m: number): string => `step.${m}`;
export const sndBreak = (m: number): string => `brk.${m}`;

export const SND_EXPLOSION_SMALL = 'exp.s';
export const SND_EXPLOSION_BIG = 'exp.b';
export const SND_PLACE = 'blk.place';
export const SND_FLESH = 'imp.flesh';
export const SND_HEADSHOT = 'imp.head';
export const SND_PICKUP_AMMO = 'pk.ammo';
export const SND_PICKUP_WEAPON = 'pk.weapon';
export const SND_PICKUP_HEALTH = 'pk.health';
export const SND_JUMP = 'mv.jump';
export const SND_LAND = 'mv.land';
export const SND_LAND_HARD = 'mv.landhard';
export const SND_HURT = 'pl.hurt';
export const SND_DEATH = 'pl.death';
export const SND_UI_CLICK = 'ui.click';
export const SND_UI_BACK = 'ui.back';
export const SND_SAW_IDLE = 'saw.idle';
export const SND_SPIN_UP = 'chg.spin';

/* ------------------------------------------------------------------------ *
 * Duration policy
 * ------------------------------------------------------------------------ */

/**
 * The longest a weapon's fire sound may be, given how fast that weapon fires.
 *
 * 1.6x the interval means the previous shot is down to the last third of its
 * tail when the next one lands: two voices overlap at most, the new transient
 * always arrives into a decaying bed rather than a fresh one, and a held
 * chaingun does not accumulate eleven simultaneous copies of itself.
 */
function tailBudgetMs(weaponId: number): number {
  const rpm = WEAPONS[weaponId].rpm;
  return (60000 / Math.max(1, rpm)) * 1.6;
}

/** Scale an attack/hold/decay triple to fit `budget`, keeping its proportions. */
function fit(
  budget: number, attackMs: number, holdMs: number, decayMs: number,
): { attackMs: number; holdMs: number; decayMs: number; total: number } {
  const total = attackMs + holdMs + decayMs;
  if (total <= budget) return { attackMs, holdMs, decayMs, total };
  // The attack is NOT scaled below its measured value: transient sharpness is
  // the whole of the punch, and shrinking a 2 ms attack to 0.5 ms changes
  // nothing audible while stretching it would ruin the weapon.
  const a = Math.min(attackMs, budget * 0.1);
  const rest = budget - a;
  const hk = holdMs / Math.max(1e-6, holdMs + decayMs);
  return { attackMs: a, holdMs: rest * hk, decayMs: rest * (1 - hk), total: budget };
}

/* ------------------------------------------------------------------------ *
 * Weapon fire specs
 * ------------------------------------------------------------------------ */

function shotgunFire(): SoundSpec {
  // The measured article: 854 ms, 410 ms plateau, 420 ms tail, dominant
  // resonance at 153 Hz, crest 13.8 dB. The 800 ms fire interval at 75 rpm
  // leaves room for essentially all of it.
  //
  // ── The 5.3% mistake, and what replaced it ──────────────────────────────
  //
  // The first version of this spec read "5.3% of DSSHOTGN's energy is above
  // 2 kHz" as licence to make the top end a 28 ms tick at gain 0.30, and
  // measured out at 0.03% — a 180x miss that turned the weapon into a door
  // slam. Two things were wrong with the reading.
  //
  // First, 5.3% of the energy of a 854 ms sound is not a transient, it is a
  // LAYER. `tools/audio-spectrum.ts` resolves the reference in time: DSSHOTGN
  // holds -22 to -31 dBFS in the 2-5 kHz band across the whole 854 ms, never
  // dropping out. The old crack layer gave one 20 ms window at -32 and then
  // collapsed to -63.
  //
  // Second, the "85% of energy under 548 Hz" figure in the header table is a
  // POWER-weighted rolloff. On the magnitude spectrum every analyser reaches
  // for, DSSHOTGN's 85% point is 3037 Hz — 5.5x higher — and the shot was
  // voiced against the darker of the two numbers.
  //
  // So the fix is not "brighter". The band profile below is fitted to the
  // reference band by band (9 bands, 20 Hz to DOOM's own 5512 Hz Nyquist,
  // 0.68 dB RMS error): the plateau, the 153 Hz barrel and the attack are
  // exactly what they were, and the missing 600 Hz - 4 kHz shelf that DOOM
  // carries for its entire length has been added as its own sustained layer.
  const b = tailBudgetMs(WeaponId.SHOTGUN);       // 1280 ms
  const e = fit(b, 2, 410, 420);
  return {
    durationMs: Math.min(854, e.total),
    peak: 0.98,
    // Tuned against the measured 13.8 dB crest factor, not guessed: `drive` is
    // an absolute statement about shape because `render` normalises before the
    // waveshaper, so this number is directly comparable to the reference.
    drive: 1.15,
    bits: 8,
    bandLimitHz: 5512,
    reverb: 0.16,
    reverbSize: 1.3,
    layers: [
      // The blast body: brown-weighted noise behind a 24 dB/octave lowpass.
      // The steep slope is not decoration — at 12 dB/octave the midrange that
      // survives keeps the sub-200 Hz share near 25% against a measured 64.6%,
      // and the shot reads as thin however loud it is.
      //
      // The corner sits at 520 rather than 620 because the grit layer below now
      // owns everything above it: left at 620 the two overlap in the 350-600 Hz
      // band and it measures 2 dB hot against the reference.
      {
        kind: 'noise', gain: 1.0, colour: 0.88, lp: 520, lpTo: 176, lpQ: 0.8, lpOrder: 4,
        env: { attackMs: e.attackMs, holdMs: e.holdMs, decayMs: e.decayMs, curve: 2.4, hold: 0.86 },
      },
      // The 153 Hz resonance — the barrel. This is the layer that makes it read
      // as a shotgun rather than as an explosion. Untouched: it measured right.
      {
        kind: 'body', gain: 0.85, freq: 153, q: 5.5,
        env: { attackMs: 1, holdMs: e.holdMs * 0.7, decayMs: e.decayMs * 1.1, curve: 2.0, hold: 0.72 },
      },
      // Sub weight: 17.9% of the measured energy is under 100 Hz. Without this
      // the shot has no chest and reads as thin on anything with a woofer.
      //
      // Adding a whole band of top costs the sub-200 share about 5 points, and
      // this pays it back — but by HOLDING longer (70 -> 220 ms), not by turning
      // up. Raising the gain instead was tried and `synth.test.ts` rejected it
      // correctly: a loud 70 ms sub spike owns the peak the plateau is measured
      // against, and the measured 410 ms plateau collapsed to 200 ms. Same
      // energy, spread over the body, keeps both.
      {
        kind: 'sweep', gain: 0.72, freq: 138, freqTo: 46, freqCurve: 2.6, wave: 'sine',
        env: { attackMs: 1, holdMs: 220, decayMs: Math.min(360, e.decayMs), curve: 2.3 },
      },
      // THE GRIT — the band that was missing.
      //
      // A saturated 12-gauge recorded onto a 1993 sampler is broadband hash for
      // as long as it is loud, and it is loud for 410 ms. This is that: white
      // noise across 520 Hz - 2.4 kHz (the master 5512 Hz band limit takes the
      // rest), on the SAME envelope as the body so it decays with the shot
      // instead of preceding it. It is what moves spectral flatness from 0.17
      // to 0.56 against DOOM's 0.57 — from "resonance" to "noise", which is the
      // measurement that separates a gunshot from a filter sweep.
      {
        kind: 'noise', gain: 1.85, colour: 0, hp: 520, lp: 2400,
        // curve 1.6, not the 2.2 the body uses: a grit layer that falls on the
        // body's own curve is 20 dB down by 700 ms, and the reference is not —
        // DSSHOTGN's 2-5 kHz band is still at -28 dBFS in its last frame.
        env: { attackMs: 1, holdMs: e.holdMs, decayMs: e.decayMs * 1.05, curve: 1.6, hold: 0.55 },
      },
      // The crack: a few milliseconds of bright noise so the shot has an edge
      // to arrive on. Still small — the grit now carries the sustained top and
      // this only has to supply the first transient.
      {
        kind: 'noise', gain: 0.22, colour: 0.1, hp: 1200, lp: 4600,
        env: { attackMs: 0.4, holdMs: 4, decayMs: 24, curve: 3.0 },
      },
    ],
  };
}

function pistolFire(): SoundSpec {
  // DSPISTOL: instant attack, 200 ms plateau, 270 ms tail, 707 Hz rolloff,
  // 218 Hz peak. Our 420 rpm caps it at 229 ms, so the shape is compressed.
  const b = tailBudgetMs(WeaponId.PISTOL);        // 229 ms
  const e = fit(b, 1, 200, 270);
  return {
    durationMs: e.total,
    peak: 0.92, drive: 1.05, bits: 8, bandLimitHz: 5512, reverb: 0.12,
    layers: [
      {
        kind: 'noise', gain: 1.0, colour: 0.72, lp: 1150, lpTo: 400, lpQ: 0.8, lpOrder: 4,
        env: { attackMs: e.attackMs, holdMs: e.holdMs, decayMs: e.decayMs, curve: 2.2, hold: 0.7 },
      },
      {
        kind: 'body', gain: 0.7, freq: 218, q: 6,
        env: { attackMs: 0.5, holdMs: e.holdMs * 0.5, decayMs: e.decayMs, curve: 2.1, hold: 0.6 },
      },
      {
        kind: 'sweep', gain: 0.46, freq: 210, freqTo: 72, freqCurve: 2.4, wave: 'sine',
        env: { attackMs: 0.5, holdMs: 15, decayMs: Math.min(150, e.decayMs), curve: 2.5 },
      },
      {
        kind: 'noise', gain: 0.30, colour: 0.05, hp: 1600, lp: 5000,
        env: { attackMs: 0.3, holdMs: 3, decayMs: 18, curve: 3 },
      },
    ],
  };
}

function chaingunFire(): SoundSpec {
  // 700 rpm is an 86 ms interval — 137 ms of budget. The chaingun's job is to
  // be a texture that stays legible at 11.7 shots a second, so it is the
  // pistol's spectrum with almost all of the tail removed and a touch more
  // top so individual rounds stay countable inside the roar.
  const b = tailBudgetMs(WeaponId.CHAINGUN);      // 137 ms
  const e = fit(b, 0.8, 40, 150);
  return {
    durationMs: e.total,
    peak: 0.85, drive: 1.1, bits: 8, bandLimitHz: 5512, reverb: 0.08,
    layers: [
      {
        kind: 'noise', gain: 1.0, colour: 0.78, lp: 1000, lpTo: 340, lpQ: 0.8, lpOrder: 4,
        env: { attackMs: e.attackMs, holdMs: e.holdMs, decayMs: e.decayMs, curve: 2.4, hold: 0.55 },
      },
      {
        kind: 'body', gain: 0.55, freq: 240, q: 5,
        env: { attackMs: 0.4, holdMs: e.holdMs * 0.4, decayMs: e.decayMs * 0.8, curve: 2.2, hold: 0.5 },
      },
      { kind: 'sweep', gain: 0.55, freq: 230, freqTo: 84, freqCurve: 2.2, wave: 'sine',
        env: { attackMs: 0.3, holdMs: 8, decayMs: 70, curve: 2.4 } },
      { kind: 'noise', gain: 0.22, colour: 0.02, hp: 2200, lp: 5400,
        env: { attackMs: 0.2, holdMs: 2, decayMs: 12, curve: 3 } },
    ],
  };
}

function rocketFire(): SoundSpec {
  // DSRLAUNC: 1401 ms, 400 ms plateau, 76 Hz dominant, 23.4% under 100 Hz —
  // the launch is a low whoosh, not a bang; the bang is the impact. 88 rpm
  // gives a 1091 ms budget so it keeps most of its length.
  const b = tailBudgetMs(WeaponId.ROCKET);
  const e = fit(b, 2, 400, 560);
  return {
    durationMs: Math.min(950, e.total),
    peak: 0.95, drive: 1.1, bits: 8, bandLimitHz: 5512, reverb: 0.2, reverbSize: 1.5,
    layers: [
      // Ignition: broadband, opens bright and closes down as the motor settles.
      { kind: 'noise', gain: 1.0, colour: 0.55, lp: 3200, lpTo: 380, lpQ: 1.0,
        env: { attackMs: 2, holdMs: e.holdMs * 0.55, decayMs: e.decayMs, curve: 2.0, hold: 0.7 } },
      // The 76 Hz measured fundamental, sustained rather than struck.
      { kind: 'sweep', gain: 0.75, freq: 132, freqTo: 62, freqCurve: 1.6, wave: 'sine',
        env: { attackMs: 4, holdMs: e.holdMs * 0.7, decayMs: e.decayMs * 0.8, curve: 2.0, hold: 0.8 } },
      { kind: 'body', gain: 0.5, freq: 262, q: 4,
        env: { attackMs: 2, holdMs: 120, decayMs: 320, curve: 2.2, hold: 0.6 } },
      // The departing motor: noise that keeps going after the launch transient.
      { kind: 'noise', gain: 0.4, colour: 0.35, bp: 900, bpQ: 1.4, delayMs: 40,
        env: { attackMs: 30, holdMs: 180, decayMs: 420, curve: 1.6, hold: 0.7 } },
    ],
  };
}

function plasmaFire(): SoundSpec {
  // No measured analogue survives in the shareware WAD's weapon set that maps
  // cleanly to a plasma rifle, so this is built from the same grammar rather
  // than from a specific lump: FM for the inharmonic electric edge, a falling
  // sweep for the "peow", and the same 5512 Hz / 8-bit medium so it sits in the
  // same world as the measured sounds. 660 rpm caps it at 145 ms.
  const b = tailBudgetMs(WeaponId.PLASMA);
  const e = fit(b, 0.6, 30, 150);
  return {
    durationMs: e.total,
    peak: 0.82, drive: 1.15, bits: 8, bandLimitHz: 5512, reverb: 0.1,
    layers: [
      { kind: 'fm', gain: 1.0, freq: 900, freqTo: 220, freqCurve: 2.2,
        modFreq: 430, modIndex: 5.5,
        env: { attackMs: e.attackMs, holdMs: e.holdMs, decayMs: e.decayMs, curve: 2.6, hold: 0.6 } },
      { kind: 'sweep', gain: 0.5, freq: 1500, freqTo: 180, freqCurve: 3, wave: 'tri',
        env: { attackMs: 0.5, holdMs: 10, decayMs: e.decayMs * 0.8, curve: 2.8 } },
      { kind: 'noise', gain: 0.3, colour: 0.2, bp: 2600, bpQ: 1.2,
        env: { attackMs: 0.4, holdMs: 6, decayMs: 60, curve: 2.6 } },
      { kind: 'sweep', gain: 0.35, freq: 180, freqTo: 70, freqCurve: 2, wave: 'sine',
        env: { attackMs: 0.5, holdMs: 10, decayMs: 90, curve: 2.4 } },
    ],
  };
}

function bfgFire(): SoundSpec {
  // 40 rpm — a 2.4 s budget for a weapon the table calls "a 1.5 s commitment
  // that deletes a room". The charge is the point: a rising FM tone under a
  // building noise bed, then the release.
  return {
    durationMs: 1400,
    peak: 1.0, drive: 1.15, bits: 8, bandLimitHz: 5512, reverb: 0.3, reverbSize: 2.0,
    layers: [
      { kind: 'fm', gain: 0.7, freq: 90, freqTo: 300, freqCurve: 0.7,
        modFreq: 61, modIndex: 7,
        env: { attackMs: 220, holdMs: 320, decayMs: 700, curve: 1.8, hold: 0.9 } },
      { kind: 'sweep', gain: 0.9, freq: 60, freqTo: 150, freqCurve: 0.8, wave: 'sine',
        env: { attackMs: 200, holdMs: 300, decayMs: 800, curve: 1.6, hold: 1 } },
      { kind: 'noise', gain: 0.8, colour: 0.75, lp: 500, lpTo: 2600, lpQ: 1.2,
        env: { attackMs: 260, holdMs: 240, decayMs: 780, curve: 1.7, hold: 0.95 } },
      // The discharge, landing after the charge has peaked.
      { kind: 'noise', gain: 1.0, colour: 0.8, lp: 3000, lpTo: 200, lpQ: 1.1, delayMs: 520,
        env: { attackMs: 3, holdMs: 200, decayMs: 620, curve: 2.2, hold: 0.8 } },
      { kind: 'sweep', gain: 0.85, freq: 190, freqTo: 38, freqCurve: 2.4, wave: 'sine',
        delayMs: 520,
        env: { attackMs: 2, holdMs: 90, decayMs: 560, curve: 2.4 } },
    ],
  };
}

function chainsawFire(): SoundSpec {
  // DSSAWFUL is the reference for the class: 1638 ms with NO decay at all (it
  // is a loop), 39% of energy above 2 kHz, only 0.3% below 100 Hz, dominant at
  // 161 Hz. That is a bright buzz on a low fundamental — a saw wave under
  // amplitude modulation, not noise. This is the per-bite sound at 480 rpm
  // (125 ms interval); the sustained loop is `SND_SAW_IDLE`.
  const b = tailBudgetMs(WeaponId.CHAINSAW);
  const e = fit(b, 1, 60, 120);
  return {
    durationMs: e.total,
    peak: 0.8, drive: 1.2, bits: 8, bandLimitHz: 5512, reverb: 0.06,
    layers: [
      { kind: 'osc', gain: 1.0, freq: 161, freqTo: 138, wave: 'saw', hp: 220, lp: 4600,
        env: { attackMs: e.attackMs, holdMs: e.holdMs, decayMs: e.decayMs, curve: 1.6, hold: 0.9 } },
      { kind: 'fm', gain: 0.6, freq: 322, modFreq: 161, modIndex: 4, hp: 500,
        env: { attackMs: 1, holdMs: e.holdMs, decayMs: e.decayMs, curve: 1.6, hold: 0.85 } },
      { kind: 'noise', gain: 0.45, colour: 0.15, bp: 3200, bpQ: 1.0,
        env: { attackMs: 1, holdMs: e.holdMs * 0.8, decayMs: e.decayMs, curve: 1.8, hold: 0.7 } },
    ],
  };
}

function sawIdle(): SoundSpec {
  // The held-down loop. Same timbre, no decay — DSSAWIDL measures a 670 ms
  // plateau with a 10 ms tail, i.e. it is meant to butt-join to itself.
  return {
    durationMs: 640,
    peak: 0.55, drive: 3.5, bits: 8, bandLimitHz: 5512,
    layers: [
      { kind: 'osc', gain: 1.0, freq: 205, wave: 'saw', hp: 180, lp: 3800,
        env: { attackMs: 18, holdMs: 604, decayMs: 18, curve: 1, hold: 1 } },
      { kind: 'fm', gain: 0.35, freq: 410, modFreq: 205, modIndex: 2.5, hp: 400,
        env: { attackMs: 18, holdMs: 604, decayMs: 18, curve: 1, hold: 1 } },
    ],
  };
}

/* ------------------------------------------------------------------------ *
 * Reload / dry / switch
 * ------------------------------------------------------------------------ */

/**
 * The mechanical family.
 *
 * DSSGCOCK measures 3641 Hz rolloff with 65% of its energy above 2 kHz and a
 * crest factor of 18.5 dB — the opposite end of the spectrum from the weapons.
 * Mechanism sounds are BRIGHT and SPIKY, and that contrast is what stops a
 * reload from disappearing under the gunfire it follows.
 */
function mechClick(freq: number, durMs: number, bright = 1): SoundSpec {
  return {
    durationMs: durMs,
    peak: 0.62, drive: 2.2, bits: 8, bandLimitHz: 5512, reverb: 0.05,
    layers: [
      { kind: 'noise', gain: 1.0, colour: 0.05, hp: 900 * bright, lp: 5200,
        env: { attackMs: 0.4, holdMs: 6, decayMs: durMs * 0.5, curve: 3 } },
      { kind: 'body', gain: 0.6, freq, q: 9,
        env: { attackMs: 0.4, holdMs: 8, decayMs: durMs * 0.7, curve: 2.6 } },
      { kind: 'body', gain: 0.3, freq: freq * 2.7, q: 12,
        env: { attackMs: 0.3, holdMs: 4, decayMs: durMs * 0.4, curve: 3 } },
    ],
  };
}

function reloadFor(weaponId: number): SoundSpec {
  const def = WEAPONS[weaponId];
  // Shell-by-shell weapons get one short insert sound; magazine weapons get a
  // two-part clack (out, then in) spread across the actual reload time so the
  // sound tells you how far through the animation you are.
  if (def.reloadShellMs > 0) return mechClick(430, Math.min(300, def.reloadShellMs * 0.7), 1.1);
  const total = Math.max(220, Math.min(900, def.reloadMs * 0.55));
  return {
    durationMs: total,
    peak: 0.6, drive: 2.4, bits: 8, bandLimitHz: 5512, reverb: 0.06,
    layers: [
      { kind: 'noise', gain: 0.9, colour: 0.08, hp: 800, lp: 5000,
        env: { attackMs: 0.5, holdMs: 8, decayMs: 90, curve: 3 } },
      { kind: 'body', gain: 0.7, freq: 320, q: 8,
        env: { attackMs: 0.5, holdMs: 10, decayMs: 130, curve: 2.6 } },
      // The magazine seating, landing late.
      { kind: 'noise', gain: 0.85, colour: 0.1, hp: 700, lp: 4600, delayMs: total * 0.55,
        env: { attackMs: 0.5, holdMs: 10, decayMs: 150, curve: 2.8 } },
      { kind: 'body', gain: 0.65, freq: 210, q: 7, delayMs: total * 0.55,
        env: { attackMs: 0.5, holdMs: 12, decayMs: 190, curve: 2.4 } },
    ],
  };
}

function dryFire(): SoundSpec {
  // The click on an empty mag: the shortest, driest thing in the catalogue.
  // It has to be unmistakable, because it is the game telling you the reason
  // nothing happened when you pulled the trigger.
  return {
    durationMs: 90,
    peak: 0.45, drive: 2, bits: 8, bandLimitHz: 5512,
    layers: [
      { kind: 'noise', gain: 1.0, colour: 0, hp: 1600, lp: 5400,
        env: { attackMs: 0.3, holdMs: 2, decayMs: 26, curve: 3.4 } },
      { kind: 'body', gain: 0.7, freq: 1250, q: 14,
        env: { attackMs: 0.3, holdMs: 2, decayMs: 55, curve: 3 } },
    ],
  };
}

function switchFor(weaponId: number): SoundSpec {
  const def = WEAPONS[weaponId];
  // Heavier weapons get a lower, longer draw. `switchInMs` already encodes the
  // weight — the BFG's 620 ms against the pistol's 200 ms — so the sound reads
  // off the same number the animation does and the two cannot drift apart.
  const heft = Math.min(1, def.switchInMs / 620);
  const dur = Math.max(120, Math.min(340, def.switchInMs * 0.7));
  return {
    durationMs: dur,
    peak: 0.5, drive: 2, bits: 8, bandLimitHz: 5512, reverb: 0.05,
    layers: [
      { kind: 'noise', gain: 0.8, colour: 0.15 + heft * 0.3, hp: 500 - heft * 300, lp: 4200,
        env: { attackMs: 1, holdMs: 12, decayMs: dur * 0.6, curve: 2.6 } },
      { kind: 'body', gain: 0.7, freq: 520 - heft * 300, q: 7,
        env: { attackMs: 1, holdMs: 14, decayMs: dur * 0.8, curve: 2.4 } },
    ],
  };
}

function spinUp(): SoundSpec {
  // The chaingun barrel coming up to speed. `spinUpMs` is 170, so this is the
  // whine that covers it.
  return {
    durationMs: 420,
    peak: 0.5, drive: 2.5, bits: 8, bandLimitHz: 5512,
    layers: [
      { kind: 'osc', gain: 0.8, freq: 120, freqTo: 520, freqCurve: 0.8, wave: 'saw', lp: 3200,
        env: { attackMs: 20, holdMs: 240, decayMs: 160, curve: 1.6, hold: 0.9 } },
      { kind: 'noise', gain: 0.5, colour: 0.3, bp: 1800, bpQ: 1.2,
        env: { attackMs: 30, holdMs: 220, decayMs: 170, curve: 1.6, hold: 0.8 } },
    ],
  };
}

/* ------------------------------------------------------------------------ *
 * Impacts, by material
 * ------------------------------------------------------------------------ */

/**
 * A round hitting a surface.
 *
 * Each class is a different answer to "what does this thing do when something
 * hard arrives at speed": stone cracks and throws grit, metal rings, wood
 * thuds, glass shatters, snow absorbs, liquid displaces, flesh is wet.
 */
function impactFor(mat: number): SoundSpec {
  const common = { peak: 0.62, bits: 8, bandLimitHz: 5512, reverb: 0.1 } as const;
  switch (mat) {
    case MAT_STONE:
      return {
        ...common, durationMs: 190, drive: 3.5,
        layers: [
          { kind: 'noise', gain: 1.0, colour: 0.25, hp: 500, lp: 5000,
            env: { attackMs: 0.3, holdMs: 5, decayMs: 70, curve: 3 } },
          { kind: 'body', gain: 0.7, freq: 620, q: 7,
            env: { attackMs: 0.3, holdMs: 4, decayMs: 110, curve: 2.8 } },
          { kind: 'sweep', gain: 0.4, freq: 190, freqTo: 70, freqCurve: 2.4, wave: 'sine',
            env: { attackMs: 0.4, holdMs: 4, decayMs: 90, curve: 2.6 } },
        ],
      };
    case MAT_METAL:
      // The ricochet: a high, long-ringing pair of resonances. This is the one
      // impact that should be recognisable across a whole arena.
      return {
        ...common, durationMs: 320, drive: 2.6, reverb: 0.18,
        layers: [
          { kind: 'noise', gain: 0.7, colour: 0.02, hp: 2200, lp: 5400,
            env: { attackMs: 0.2, holdMs: 3, decayMs: 40, curve: 3.4 } },
          { kind: 'body', gain: 1.0, freq: 2350, q: 22,
            env: { attackMs: 0.3, holdMs: 6, decayMs: 260, curve: 2.0 } },
          { kind: 'body', gain: 0.55, freq: 3480, q: 26,
            env: { attackMs: 0.3, holdMs: 4, decayMs: 190, curve: 2.2 } },
          { kind: 'body', gain: 0.35, freq: 1180, q: 14,
            env: { attackMs: 0.3, holdMs: 5, decayMs: 150, curve: 2.4 } },
        ],
      };
    case MAT_WOOD:
      return {
        ...common, durationMs: 170, drive: 3,
        layers: [
          { kind: 'noise', gain: 0.8, colour: 0.45, hp: 260, lp: 2600,
            env: { attackMs: 0.4, holdMs: 5, decayMs: 65, curve: 3 } },
          { kind: 'body', gain: 1.0, freq: 340, q: 9,
            env: { attackMs: 0.4, holdMs: 6, decayMs: 120, curve: 2.6 } },
          { kind: 'body', gain: 0.4, freq: 810, q: 11,
            env: { attackMs: 0.3, holdMs: 4, decayMs: 70, curve: 2.8 } },
        ],
      };
    case MAT_GLASS:
      return {
        ...common, durationMs: 300, drive: 2.2, peak: 0.55,
        layers: [
          { kind: 'noise', gain: 0.6, colour: 0, hp: 3000, lp: 5450,
            env: { attackMs: 0.2, holdMs: 3, decayMs: 90, curve: 3 } },
          { kind: 'body', gain: 1.0, freq: 3900, q: 30,
            env: { attackMs: 0.2, holdMs: 4, decayMs: 220, curve: 2.2 } },
          { kind: 'body', gain: 0.6, freq: 4900, q: 34, delayMs: 22,
            env: { attackMs: 0.2, holdMs: 3, decayMs: 170, curve: 2.4 } },
          { kind: 'body', gain: 0.45, freq: 2700, q: 24, delayMs: 48,
            env: { attackMs: 0.2, holdMs: 3, decayMs: 150, curve: 2.4 } },
        ],
      };
    case MAT_DIRT:
      return {
        ...common, durationMs: 140, drive: 2.4, peak: 0.5,
        layers: [
          { kind: 'noise', gain: 1.0, colour: 0.6, lp: 1400,
            env: { attackMs: 0.5, holdMs: 8, decayMs: 90, curve: 2.6 } },
          { kind: 'sweep', gain: 0.4, freq: 160, freqTo: 62, freqCurve: 2.2, wave: 'sine',
            env: { attackMs: 0.5, holdMs: 4, decayMs: 70, curve: 2.6 } },
        ],
      };
    case MAT_GRASS:
      return {
        ...common, durationMs: 130, drive: 2, peak: 0.42,
        layers: [
          { kind: 'noise', gain: 1.0, colour: 0.3, bp: 2400, bpQ: 0.9,
            env: { attackMs: 0.6, holdMs: 8, decayMs: 80, curve: 2.4 } },
          { kind: 'noise', gain: 0.4, colour: 0.7, lp: 900,
            env: { attackMs: 0.6, holdMs: 5, decayMs: 60, curve: 2.6 } },
        ],
      };
    case MAT_SNOW:
      return {
        ...common, durationMs: 150, drive: 1.6, peak: 0.36, reverb: 0.02,
        layers: [
          { kind: 'noise', gain: 1.0, colour: 0.35, bp: 3400, bpQ: 0.7,
            env: { attackMs: 1.5, holdMs: 10, decayMs: 100, curve: 2.2 } },
        ],
      };
    case MAT_LIQUID:
      return {
        ...common, durationMs: 280, drive: 2, peak: 0.5,
        layers: [
          { kind: 'noise', gain: 0.9, colour: 0.4, lp: 2600, lpTo: 700,
            env: { attackMs: 0.8, holdMs: 10, decayMs: 150, curve: 2.2 } },
          // The pitch-rising "bloop" of a bubble: the one cue everybody reads
          // as water without being told.
          { kind: 'sweep', gain: 0.7, freq: 380, freqTo: 900, freqCurve: 0.6, wave: 'sine',
            env: { attackMs: 3, holdMs: 12, decayMs: 130, curve: 2.4 } },
        ],
      };
    case MAT_ORGANIC:
    default:
      return {
        ...common, durationMs: 180, drive: 3, peak: 0.5,
        layers: [
          { kind: 'noise', gain: 1.0, colour: 0.55, lp: 1900, lpTo: 500,
            env: { attackMs: 0.5, holdMs: 8, decayMs: 110, curve: 2.4 } },
          { kind: 'body', gain: 0.5, freq: 280, q: 5,
            env: { attackMs: 0.5, holdMs: 6, decayMs: 120, curve: 2.4 } },
        ],
      };
  }
}

function fleshImpact(headshot: boolean): SoundSpec {
  // Wet, low, and short. DSPUNCH measures 85.9% of its energy below 100 Hz,
  // which is the useful lesson: a body hit is felt, not heard, and putting it
  // in the midrange makes it sound like hitting furniture.
  return {
    durationMs: headshot ? 200 : 160,
    peak: headshot ? 0.7 : 0.58, drive: 3.4, bits: 8, bandLimitHz: 5512, reverb: 0.05,
    layers: [
      { kind: 'noise', gain: 1.0, colour: 0.8, lp: 900, lpTo: 260,
        env: { attackMs: 0.4, holdMs: 10, decayMs: 90, curve: 2.6 } },
      { kind: 'sweep', gain: 0.75, freq: 150, freqTo: 52, freqCurve: 2.4, wave: 'sine',
        env: { attackMs: 0.5, holdMs: 8, decayMs: 100, curve: 2.6 } },
      // The headshot's extra: a short bright crack on top, so a head hit is a
      // different EVENT rather than a louder body hit.
      ...(headshot
        ? [{
          kind: 'body' as const, gain: 0.55, freq: 1700, q: 16,
          env: { attackMs: 0.2, holdMs: 3, decayMs: 120, curve: 2.8 },
        }]
        : []),
    ],
  };
}

/* ------------------------------------------------------------------------ *
 * Explosions
 * ------------------------------------------------------------------------ */

/**
 * DSBAREXP: 1683 ms, 540 ms plateau, 1143 ms tail, 56% of energy below 200 Hz,
 * dominant at 94 Hz. Long, low and loud, with far more top than a shotgun
 * because a blast throws debris and a barrel does not.
 *
 * The debris is not a garnish and it is not a transient. Measured band by band
 * (`tools/audio-spectrum.ts`), DSBAREXP is *louder* between 1.6 and 4 kHz
 * (-10.7 / -11.2 dB of total power) than it is between 600 Hz and 1 kHz
 * (-14.8 dB): the barrel has a rising shelf on top of the boom, and it holds
 * -18 to -30 dBFS in the 2-5 kHz band for well over a second. The first version
 * of this spec gave that shelf a 60 ms hold at gain 0.30 and measured 0.0004 of
 * the power in 2-6 kHz against the reference's 0.132 — boom, no debris.
 *
 * What follows is fitted to the reference across 9 bands from 20 Hz to DOOM's
 * own 5512 Hz Nyquist, 0.68 dB RMS error.
 */
function explosion(big: boolean): SoundSpec {
  const dur = big ? 1680 : 900;
  const hold = big ? 540 : 260;
  const tail = big ? 1100 : 600;
  return {
    durationMs: dur,
    peak: 1.0, drive: big ? 1.2 : 1.15, bits: 8, bandLimitHz: 5512,
    reverb: big ? 0.34 : 0.2, reverbSize: big ? 2.2 : 1.5,
    layers: [
      // The blast front. Corner pulled 900 -> 520 for the same reason as the
      // shotgun's: the debris bed below now owns the midrange, and leaving both
      // in it measured 7 dB hot in the 350-600 Hz band.
      { kind: 'noise', gain: 1.0, colour: 0.9, lp: 520, lpTo: 130, lpQ: 0.8, lpOrder: 4,
        env: { attackMs: 2, holdMs: hold, decayMs: tail, curve: 2.3, hold: 0.8 } },
      { kind: 'sweep', gain: 1.6, freq: 150, freqTo: 34, freqCurve: 2.2, wave: 'sine',
        env: { attackMs: 3, holdMs: hold * 0.5, decayMs: tail * 0.8, curve: 2.2, hold: 0.85 } },
      // The 94 Hz measured dominant, raised with the sweep so the added debris
      // does not cost the blast its sub-200 Hz share.
      { kind: 'body', gain: 1.5, freq: 94, q: 4,
        env: { attackMs: 2, holdMs: hold * 0.6, decayMs: tail, curve: 2.1, hold: 0.8 } },
      // DEBRIS — the crackle, and it lasts as long as the blast does.
      //
      // Still delayed 30 ms so it arrives after the front rather than inside
      // it, which is what the reference does too: DSBAREXP's 2-5 kHz band is
      // at -32 dBFS in its first frame and -18 forty milliseconds later. But it
      // now runs the full hold and the full tail, because that is what a barrel
      // full of shrapnel landing on concrete actually sounds like.
      { kind: 'noise', gain: 2.4, colour: 0, hp: 600, lp: 3000, delayMs: 30,
        env: { attackMs: 4, holdMs: hold, decayMs: tail, curve: 1.6, hold: 0.6 } },
    ],
  };
}

/* ------------------------------------------------------------------------ *
 * World interaction
 * ------------------------------------------------------------------------ */

/** A block coming apart. Louder, longer and grittier than a bullet impact. */
function blockBreak(mat: number): SoundSpec {
  const base = impactFor(mat);
  const scale = 1.9;
  return {
    ...base,
    durationMs: Math.min(700, base.durationMs * scale),
    peak: 0.72,
    reverb: (base.reverb ?? 0.1) * 1.3,
    layers: base.layers.map((l) => ({
      ...l,
      env: {
        ...l.env,
        holdMs: l.env.holdMs * scale,
        decayMs: l.env.decayMs * scale,
      },
    })).concat([
      // The scatter: the pieces landing, which is what separates "broken" from
      // "hit". Delayed past the strike so it reads as a consequence.
      {
        kind: 'noise', gain: 0.5, colour: 0.35, bp: 2000, bpQ: 0.8, delayMs: 40,
        env: { attackMs: 8, holdMs: 40, decayMs: 260, curve: 2.2 },
      },
    ]),
  };
}

function blockPlace(): SoundSpec {
  // Short, soft, positive. It fires as fast as the player can click in Builder,
  // so it must never be fatiguing — this is the sound with the strictest
  // loudness ceiling in the catalogue.
  return {
    durationMs: 130, peak: 0.4, drive: 1.8, bits: 8, bandLimitHz: 5512, reverb: 0.04,
    layers: [
      { kind: 'noise', gain: 0.8, colour: 0.5, lp: 2200,
        env: { attackMs: 1, holdMs: 6, decayMs: 60, curve: 2.6 } },
      { kind: 'body', gain: 0.9, freq: 440, q: 8,
        env: { attackMs: 1, holdMs: 8, decayMs: 90, curve: 2.4 } },
    ],
  };
}

/* ------------------------------------------------------------------------ *
 * Movement
 * ------------------------------------------------------------------------ */

/**
 * Footsteps.
 *
 * These are the most-repeated sounds in the game by a wide margin, so they are
 * the quietest and the shortest, and they carry the largest variant count —
 * an identical footstep at 2 Hz is the fastest way to make a game feel cheap.
 */
function footstepFor(mat: number): SoundSpec {
  const common = { peak: 0.3, bits: 8, bandLimitHz: 5512, reverb: 0.06, variants: 4 } as const;
  switch (mat) {
    case MAT_STONE:
      return {
        ...common, durationMs: 120, drive: 2,
        layers: [
          { kind: 'noise', gain: 1.0, colour: 0.3, hp: 380, lp: 4200,
            env: { attackMs: 1, holdMs: 6, decayMs: 55, curve: 2.8 } },
          { kind: 'body', gain: 0.5, freq: 250, q: 6,
            env: { attackMs: 1, holdMs: 5, decayMs: 70, curve: 2.6 } },
        ],
      };
    case MAT_METAL:
      return {
        ...common, durationMs: 200, drive: 2, peak: 0.32,
        layers: [
          { kind: 'noise', gain: 0.6, colour: 0.05, hp: 1800, lp: 5300,
            env: { attackMs: 0.5, holdMs: 3, decayMs: 35, curve: 3 } },
          { kind: 'body', gain: 1.0, freq: 1650, q: 16,
            env: { attackMs: 0.5, holdMs: 5, decayMs: 150, curve: 2.4 } },
          { kind: 'body', gain: 0.4, freq: 620, q: 9,
            env: { attackMs: 0.5, holdMs: 5, decayMs: 100, curve: 2.6 } },
        ],
      };
    case MAT_WOOD:
      return {
        ...common, durationMs: 140, drive: 2,
        layers: [
          { kind: 'noise', gain: 0.7, colour: 0.4, hp: 220, lp: 2600,
            env: { attackMs: 1, holdMs: 5, decayMs: 50, curve: 2.8 } },
          { kind: 'body', gain: 1.0, freq: 300, q: 8,
            env: { attackMs: 1, holdMs: 6, decayMs: 90, curve: 2.5 } },
        ],
      };
    case MAT_GRASS:
      return {
        ...common, durationMs: 110, drive: 1.5, peak: 0.24,
        layers: [
          { kind: 'noise', gain: 1.0, colour: 0.2, bp: 2800, bpQ: 0.8,
            env: { attackMs: 2, holdMs: 8, decayMs: 60, curve: 2.2 } },
        ],
      };
    case MAT_SNOW:
      return {
        ...common, durationMs: 130, drive: 1.4, peak: 0.24, reverb: 0.01,
        layers: [
          { kind: 'noise', gain: 1.0, colour: 0.25, bp: 3600, bpQ: 0.6,
            env: { attackMs: 3, holdMs: 12, decayMs: 70, curve: 2 } },
          { kind: 'noise', gain: 0.3, colour: 0.7, lp: 700,
            env: { attackMs: 3, holdMs: 8, decayMs: 50, curve: 2.4 } },
        ],
      };
    case MAT_GLASS:
      return {
        ...common, durationMs: 150, drive: 1.6, peak: 0.26,
        layers: [
          { kind: 'noise', gain: 0.6, colour: 0, hp: 2600, lp: 5400,
            env: { attackMs: 0.5, holdMs: 3, decayMs: 40, curve: 3 } },
          { kind: 'body', gain: 0.8, freq: 3200, q: 20,
            env: { attackMs: 0.5, holdMs: 4, decayMs: 110, curve: 2.4 } },
        ],
      };
    case MAT_LIQUID:
      return {
        ...common, durationMs: 220, drive: 1.8, peak: 0.34,
        layers: [
          { kind: 'noise', gain: 1.0, colour: 0.35, lp: 3000, lpTo: 800,
            env: { attackMs: 2, holdMs: 14, decayMs: 130, curve: 2.2 } },
          { kind: 'sweep', gain: 0.4, freq: 300, freqTo: 700, freqCurve: 0.7, wave: 'sine',
            env: { attackMs: 4, holdMs: 10, decayMs: 90, curve: 2.4 } },
        ],
      };
    case MAT_DIRT:
    case MAT_ORGANIC:
    default:
      return {
        ...common, durationMs: 110, drive: 1.8, peak: 0.26,
        layers: [
          { kind: 'noise', gain: 1.0, colour: 0.55, lp: 1500,
            env: { attackMs: 1.5, holdMs: 8, decayMs: 60, curve: 2.4 } },
        ],
      };
  }
}

function jumpSound(): SoundSpec {
  return {
    durationMs: 160, peak: 0.32, drive: 2, bits: 8, bandLimitHz: 5512,
    layers: [
      { kind: 'noise', gain: 0.7, colour: 0.5, lp: 1800, lpTo: 600,
        env: { attackMs: 4, holdMs: 10, decayMs: 80, curve: 2.2 } },
      // A short exhale: pitched low, so it reads as effort rather than as a
      // sound effect. This is the cue that makes a jump feel like a body.
      { kind: 'sweep', gain: 0.5, freq: 240, freqTo: 150, freqCurve: 1.5, wave: 'tri', lp: 1400,
        env: { attackMs: 8, holdMs: 20, decayMs: 90, curve: 2 } },
    ],
  };
}

function landSound(hard: boolean): SoundSpec {
  return {
    durationMs: hard ? 300 : 170,
    peak: hard ? 0.62 : 0.34, drive: hard ? 3.4 : 2, bits: 8, bandLimitHz: 5512,
    reverb: hard ? 0.12 : 0.05,
    layers: [
      { kind: 'noise', gain: 1.0, colour: 0.7, lp: hard ? 1400 : 1100, lpTo: 300,
        env: { attackMs: 1, holdMs: hard ? 16 : 8, decayMs: hard ? 150 : 80, curve: 2.5 } },
      { kind: 'sweep', gain: hard ? 0.9 : 0.5, freq: hard ? 170 : 130, freqTo: hard ? 44 : 60,
        freqCurve: 2.4, wave: 'sine',
        env: { attackMs: 1, holdMs: hard ? 14 : 6, decayMs: hard ? 190 : 90, curve: 2.5 } },
      // A hard landing grunts. Only the hard one — attaching a voice to every
      // step off a kerb is the fastest way to make a character annoying.
      ...(hard
        ? [{
          kind: 'fm' as const, gain: 0.4, freq: 190, freqTo: 130, modFreq: 95, modIndex: 2.5,
          lp: 1500, delayMs: 30,
          env: { attackMs: 12, holdMs: 40, decayMs: 150, curve: 2 },
        }]
        : []),
    ],
  };
}

/* ------------------------------------------------------------------------ *
 * The player
 * ------------------------------------------------------------------------ */

function hurtSound(): SoundSpec {
  // DSPLPAIN measures 49% of its energy in the 1-2 kHz band with a 2044 Hz
  // rolloff — a pain sound is a VOICE, and voices live in the midrange. Built
  // from FM rather than noise for the same reason: a vocal cry has harmonic
  // structure and filtered noise never gets there.
  return {
    durationMs: 380, peak: 0.6, drive: 1.05, bits: 8, bandLimitHz: 5512, reverb: 0.08,
    layers: [
      { kind: 'fm', gain: 1.0, freq: 320, freqTo: 210, freqCurve: 1.4,
        modFreq: 168, modIndex: 4.5, hp: 300, lp: 3400,
        env: { attackMs: 14, holdMs: 90, decayMs: 250, curve: 2, hold: 0.8 } },
      { kind: 'noise', gain: 0.35, colour: 0.25, bp: 1700, bpQ: 1.1,
        env: { attackMs: 10, holdMs: 60, decayMs: 200, curve: 2.2 } },
    ],
  };
}

function deathSound(): SoundSpec {
  // DSPLDETH: 996 ms, 850 ms plateau, 75% of its energy in 1-2 kHz, dominant
  // 399 Hz. A long falling cry — the plateau matters, a death that decays
  // immediately reads as a hit.
  return {
    durationMs: 980, peak: 0.85, drive: 1.05, bits: 8, bandLimitHz: 5512,
    reverb: 0.2, reverbSize: 1.6,
    layers: [
      { kind: 'fm', gain: 1.0, freq: 399, freqTo: 120, freqCurve: 2.2,
        modFreq: 205, modIndex: 6, hp: 200, lp: 3200,
        env: { attackMs: 20, holdMs: 520, decayMs: 420, curve: 1.8, hold: 0.85 } },
      { kind: 'fm', gain: 0.5, freq: 620, freqTo: 180, freqCurve: 2.4,
        modFreq: 311, modIndex: 4, lp: 3600,
        env: { attackMs: 26, holdMs: 380, decayMs: 480, curve: 1.9, hold: 0.7 } },
      { kind: 'noise', gain: 0.3, colour: 0.4, bp: 1400, bpQ: 0.9,
        env: { attackMs: 30, holdMs: 300, decayMs: 500, curve: 1.8, hold: 0.6 } },
    ],
  };
}

/* ------------------------------------------------------------------------ *
 * Pickups and UI
 * ------------------------------------------------------------------------ */

function pickup(kind: 'ammo' | 'weapon' | 'health'): SoundSpec {
  // DSITEMUP measures a 200 ms plateau with a 2 ms tail and a 998 Hz rolloff —
  // a short, bright, RISING blip. Rising is the important half: a falling pitch
  // reads as loss and a rising one reads as gain, and the player learns which
  // is which without being told.
  const f0 = kind === 'health' ? 420 : kind === 'weapon' ? 300 : 520;
  const f1 = kind === 'health' ? 880 : kind === 'weapon' ? 720 : 900;
  return {
    durationMs: kind === 'weapon' ? 300 : 210,
    peak: 0.5, drive: 1, bits: 8, bandLimitHz: 5512, reverb: 0.06,
    layers: [
      { kind: 'osc', gain: 0.9, freq: f0, freqTo: f1, freqCurve: 0.6, wave: 'square', lp: 2600,
        env: { attackMs: 2, holdMs: 120, decayMs: 70, curve: 2, hold: 0.9 } },
      { kind: 'osc', gain: 0.4, freq: f0 * 2, freqTo: f1 * 2, freqCurve: 0.6, wave: 'sine',
        env: { attackMs: 2, holdMs: 100, decayMs: 80, curve: 2.2, hold: 0.7 } },
      // The weapon pickup gets DSWPNUP's bright metallic top (65% above 2 kHz)
      // so picking up a gun is unmistakably a bigger event than picking up ammo.
      ...(kind === 'weapon'
        ? [{
          kind: 'body' as const, gain: 0.5, freq: 2900, q: 18, delayMs: 60,
          env: { attackMs: 1, holdMs: 8, decayMs: 200, curve: 2.4 },
        }]
        : []),
    ],
  };
}

function uiClick(down: boolean): SoundSpec {
  return {
    durationMs: 70, peak: 0.34, drive: 1.6, bits: 8, bandLimitHz: 5512,
    layers: [
      { kind: 'osc', gain: 0.8, freq: down ? 900 : 620, freqTo: down ? 640 : 900,
        wave: 'square', lp: 4600,
        env: { attackMs: 0.5, holdMs: 14, decayMs: 40, curve: 2.4 } },
      { kind: 'noise', gain: 0.25, colour: 0, hp: 2400, lp: 5400,
        env: { attackMs: 0.3, holdMs: 2, decayMs: 18, curve: 3 } },
    ],
  };
}

/* ------------------------------------------------------------------------ *
 * Building the catalogue
 * ------------------------------------------------------------------------ */

const FIRE_SPECS: Record<number, () => SoundSpec> = {
  [WeaponId.PISTOL]: pistolFire,
  [WeaponId.SHOTGUN]: shotgunFire,
  [WeaponId.CHAINGUN]: chaingunFire,
  [WeaponId.ROCKET]: rocketFire,
  [WeaponId.PLASMA]: plasmaFire,
  [WeaponId.BFG]: bfgFire,
  [WeaponId.CHAINSAW]: chainsawFire,
};

interface BakeJob { id: string; spec: SoundSpec }

/**
 * Every sound, in BAKE ORDER.
 *
 * The order is the priority order, because baking is spread across frames and
 * whatever is not baked yet is silent. The things a player does in the first
 * two seconds of a match — fire the weapon they spawned holding, hit a wall,
 * take a step — are first; the BFG, which nobody has yet, is last.
 */
function buildJobs(): BakeJob[] {
  const jobs: BakeJob[] = [];
  const add = (id: string, spec: SoundSpec): void => { jobs.push({ id, spec }); };

  /* The spawn loadout fires first, so it bakes first. */
  const order = [
    WeaponId.PISTOL, WeaponId.CHAINSAW, WeaponId.SHOTGUN, WeaponId.CHAINGUN,
    WeaponId.PLASMA, WeaponId.ROCKET, WeaponId.BFG,
  ];
  for (const w of order) add(sndFire(w), FIRE_SPECS[w]());

  /* Surfaces you will hit in the first second. */
  for (let m = 0; m < MAT_COUNT; m++) add(sndImpact(m), impactFor(m));
  add(SND_FLESH, fleshImpact(false));
  add(SND_HEADSHOT, fleshImpact(true));
  for (let m = 0; m < MAT_COUNT; m++) add(sndStep(m), footstepFor(m));

  /* Then everything else. */
  add(SND_EXPLOSION_SMALL, explosion(false));
  add(SND_EXPLOSION_BIG, explosion(true));
  add(SND_JUMP, jumpSound());
  add(SND_LAND, landSound(false));
  add(SND_LAND_HARD, landSound(true));
  add(SND_HURT, hurtSound());
  add(SND_DEATH, deathSound());

  for (let w = 0; w < WEAPON_COUNT; w++) {
    add(sndDry(w), dryFire());
    add(sndSwitch(w), switchFor(w));
    if (WEAPONS[w].kind !== FireKind.MELEE && WEAPONS[w].magSize > 0) {
      add(sndReload(w), reloadFor(w));
    }
  }
  add(SND_SPIN_UP, spinUp());
  add(SND_SAW_IDLE, sawIdle());

  for (let m = 0; m < MAT_COUNT; m++) add(sndBreak(m), blockBreak(m));
  add(SND_PLACE, blockPlace());

  add(SND_PICKUP_AMMO, pickup('ammo'));
  add(SND_PICKUP_WEAPON, pickup('weapon'));
  add(SND_PICKUP_HEALTH, pickup('health'));
  add(SND_UI_CLICK, uiClick(true));
  add(SND_UI_BACK, uiClick(false));

  return jobs;
}

/* ------------------------------------------------------------------------ *
 * Retrigger gates
 * ------------------------------------------------------------------------ */

/**
 * Minimum milliseconds between two starts of the same sound id.
 *
 * The impact gate is the load-bearing one: a shotgun resolves seven pellets in
 * a single frame and each reports an impact, so without a gate one trigger pull
 * spends seven voices on what should be one sound. 45 ms is long enough to
 * collapse a pellet spread and short enough that two genuinely separate hits
 * at chaingun cadence still both speak.
 */
const GATE_IMPACT_MS = 45;
const GATE_FLESH_MS = 40;
const GATE_BLOCK_MS = 30;
const GATE_STEP_MS = 90;

/* ------------------------------------------------------------------------ *
 * The public surface
 * ------------------------------------------------------------------------ */

export interface SfxOptions {
  /** Cut the bake into slices no longer than this, in ms of main-thread time. */
  bakeSliceMs?: number;
}

/**
 * The catalogue plus the semantic play layer.
 *
 * `game.ts` holds one of these and calls the verbs; it never touches
 * `SoundSpec`, buffer ids, priorities or gates.
 */
export class Sfx {
  readonly engine: AudioEngine;
  readonly spatial: SpatialAudio;

  private jobs: BakeJob[] = [];
  private jobIndex = 0;
  private bakeSliceMs: number;
  private bakeElapsedMs = 0;

  private readonly res: SpatialResult = createSpatialResult();
  private readonly play: PlayOptions = {};

  /** Local listener position, so first-person sounds skip the spatial maths. */
  private lastFootMat = MAT_STONE;

  constructor(engine: AudioEngine, spatial: SpatialAudio, opts: SfxOptions = {}) {
    this.engine = engine;
    this.spatial = spatial;
    this.bakeSliceMs = opts.bakeSliceMs ?? 2;
  }

  /* -------------------------------------------------------------------- *
   * Baking
   * -------------------------------------------------------------------- */

  /** Queue the whole catalogue. Call once, right after `engine.unlock()`. */
  beginBake(): void {
    if (this.jobs.length > 0) return;
    this.jobs = buildJobs();
    this.jobIndex = 0;
    this.bakeElapsedMs = 0;
  }

  get bakeComplete(): boolean { return this.jobs.length > 0 && this.jobIndex >= this.jobs.length; }
  get bakeProgress(): number {
    return this.jobs.length === 0 ? 0 : this.jobIndex / this.jobs.length;
  }

  /**
   * Bake for at most one slice. Call once per frame until `bakeComplete`.
   *
   * The whole catalogue is about 400 ms of synthesis. Spent in one frame that
   * is a 24-frame stall at the exact moment the player clicks into a match, so
   * it is sliced instead. 2 ms is the slice because the project's frame budget
   * is 0.90 ms of renderer submission inside a 16.7 ms frame: 2 ms is small
   * enough to disappear into the slack an idle frame already has, and a 4 ms
   * slice — which is what this used to be — would have been a quarter of the
   * frame and visible as judder.
   *
   * That makes the full bake take a few seconds of wall clock, which costs
   * nothing because of the ordering in `buildJobs`: the weapon the player
   * spawns holding is job zero, impacts and footsteps come next, and the BFG —
   * which nobody owns yet — is last.
   */
  bakeStep(): void {
    if (this.jobs.length === 0 || this.jobIndex >= this.jobs.length) return;
    const sr = this.engine.sampleRate;
    const t0 = now();
    while (this.jobIndex < this.jobs.length && now() - t0 < this.bakeSliceMs) {
      const job = this.jobs[this.jobIndex++];
      const n = job.spec.variants ?? 2;
      const pcm: Float32Array[] = [];
      for (let v = 0; v < n; v++) {
        // The seed is derived from the id so a variant is stable across runs;
        // debugging a sound you cannot reproduce is not debugging.
        pcm.push(render(job.spec, sr, hashId(job.id) + v * 7919));
      }
      this.engine.addBuffers(job.id, pcm);
    }
    this.bakeElapsedMs += now() - t0;
    if (this.jobIndex >= this.jobs.length) this.engine.noteBakeMs(this.bakeElapsedMs);
  }

  /* -------------------------------------------------------------------- *
   * First-person: no distance, no pan, no occlusion
   * -------------------------------------------------------------------- */

  /**
   * The local player's own weapon.
   *
   * Deliberately NOT spatialised. Your own gun is at your hands; running it
   * through the distance model would attenuate it by whatever floating-point
   * noise separates the emitter from the camera, and panning it would make the
   * most important sound in the game wander. It gets a fixed centre position,
   * the highest non-explosion priority, and a small random detune so a held
   * chaingun does not sound like a loop.
   */
  weaponFire(weaponId: number, spinFraction = 0): void {
    const o = this.play;
    o.bus = BUS_SFX;
    o.gain = 1;
    // +/-3% — enough that consecutive shots differ, small enough that the
    // weapon keeps a fixed identity. The chaingun additionally rises slightly
    // with spin-up so holding the trigger has a direction.
    o.rate = 0.97 + Math.random() * 0.06 + spinFraction * 0.04;
    o.pan = 0;
    o.priority = PRIO_LOCAL_WEAPON;
    o.lowpass = 0;
    o.delay = 0;
    this.engine.play(sndFire(weaponId), o);
  }

  weaponDry(weaponId: number): void {
    this.flat(sndDry(weaponId), 0.8, PRIO_LOCAL_WEAPON, 120);
  }

  weaponReload(weaponId: number): void {
    this.flat(sndReload(weaponId), 0.85, PRIO_LOCAL_WEAPON, 40);
  }

  weaponSwitch(weaponId: number): void {
    this.flat(sndSwitch(weaponId), 0.8, PRIO_LOCAL_WEAPON, 40);
  }

  chaingunSpin(): void { this.flat(SND_SPIN_UP, 0.7, PRIO_LOCAL_WEAPON, 400); }

  hurt(amount: number): void {
    const o = this.play;
    o.bus = BUS_SFX;
    // A graze and a rocket must not be the same cry. Level and pitch both move:
    // heavier damage is louder AND lower, which is how a voice actually behaves.
    o.gain = 0.5 + Math.min(0.5, amount / 90);
    o.rate = 1.08 - Math.min(0.22, amount / 320);
    o.pan = 0; o.priority = PRIO_DAMAGE; o.lowpass = 0; o.delay = 0;
    this.engine.play(SND_HURT, o, 140);
  }

  death(): void { this.flat(SND_DEATH, 1, PRIO_DAMAGE, 0); }

  jump(): void { this.flat(SND_JUMP, 0.7, PRIO_FOOTSTEP, 120); }

  /** `impactSpeed` is metres per second of downward velocity at contact. */
  land(impactSpeed: number): void {
    const hard = impactSpeed > 9;
    this.flat(hard ? SND_LAND_HARD : SND_LAND,
      hard ? Math.min(1, 0.55 + impactSpeed / 40) : 0.6, PRIO_FOOTSTEP, 90);
  }

  /**
   * A footstep on whatever is underfoot.
   *
   * `blockId` is the block the player is standing ON, not standing IN, so the
   * caller samples one below the feet. Remembering the last material means a
   * step that lands in the one frame the sampler returns air still sounds like
   * the ground you were just on rather than falling silent.
   */
  footstep(blockId: number, running: boolean): void {
    const mat = blockId > 0 ? materialOf(blockId) : this.lastFootMat;
    this.lastFootMat = mat;
    const o = this.play;
    o.bus = BUS_SFX;
    o.gain = running ? 0.85 : 0.55;
    o.rate = 0.92 + Math.random() * 0.16;
    o.pan = 0; o.priority = PRIO_FOOTSTEP; o.lowpass = 0; o.delay = 0;
    this.engine.play(sndStep(mat), o, GATE_STEP_MS);
  }

  uiClick(back = false): void {
    const o = this.play;
    o.bus = BUS_UI; o.gain = 1; o.rate = 1; o.pan = 0;
    o.priority = PRIO_UI; o.lowpass = 0; o.delay = 0;
    this.engine.play(back ? SND_UI_BACK : SND_UI_CLICK, o, 30);
  }

  pickup(kind: 'ammo' | 'weapon' | 'health'): void {
    const id = kind === 'ammo' ? SND_PICKUP_AMMO
      : kind === 'weapon' ? SND_PICKUP_WEAPON : SND_PICKUP_HEALTH;
    this.flat(id, 0.85, PRIO_PICKUP, 60);
  }

  /* -------------------------------------------------------------------- *
   * Positioned
   * -------------------------------------------------------------------- */

  /** A bullet hitting a block, somewhere in the world. */
  impact(x: number, y: number, z: number, blockId: number, strength = 1): void {
    this.positioned(sndImpact(materialOf(blockId)), x, y, z,
      0.9 * strength, PRIO_IMPACT, GATE_IMPACT_MS);
  }

  /** A bullet hitting a body. */
  flesh(x: number, y: number, z: number, headshot: boolean): void {
    this.positioned(headshot ? SND_HEADSHOT : SND_FLESH, x, y, z,
      1, PRIO_IMPACT, GATE_FLESH_MS);
  }

  /** A block coming apart. */
  blockBreak(x: number, y: number, z: number, blockId: number): void {
    this.positioned(sndBreak(materialOf(blockId)), x, y, z, 1, PRIO_BLOCK, GATE_BLOCK_MS);
  }

  blockPlace(x: number, y: number, z: number): void {
    this.positioned(SND_PLACE, x, y, z, 1, PRIO_BLOCK, GATE_BLOCK_MS);
  }

  /**
   * A detonation.
   *
   * The reference distance is widened with the blast radius: a BFG going off
   * 30 m away should still be loud, and the same inverse-distance curve that
   * is right for a footstep would make it a whisper.
   */
  explosion(x: number, y: number, z: number, radius: number): void {
    const big = radius >= 4;
    const o = this.play;
    if (!this.spatial.resolve(x, y, z, this.res, Math.max(6, radius * 2.5))) return;
    o.bus = BUS_SFX;
    o.gain = this.res.gain;
    o.rate = big ? 0.94 + Math.random() * 0.08 : 0.96 + Math.random() * 0.1;
    o.pan = this.res.pan;
    o.priority = PRIO_EXPLOSION;
    o.lowpass = this.res.lowpass;
    o.delay = 0;
    this.engine.play(big ? SND_EXPLOSION_BIG : SND_EXPLOSION_SMALL, o, 50);
  }

  /**
   * Somebody else's gun.
   *
   * Ranked below your own weapon so that in a firefight your own feedback loop
   * survives voice stealing, which is the only ranking that keeps the game
   * playable when eight people are shooting.
   */
  remoteFire(weaponId: number, x: number, y: number, z: number): void {
    this.positioned(sndFire(weaponId), x, y, z, 1, PRIO_REMOTE_WEAPON, 30, 12);
  }

  /**
   * The shared path for anything with a position.
   *
   * `resolve` returning false means the sound is past the audio horizon or
   * below the audibility floor, and the voice is never allocated at all — the
   * cheapest sound in any engine is the one that does not reach it.
   */
  private positioned(
    id: string, x: number, y: number, z: number,
    gain: number, priority: number, gateMs: number, refDist = 4,
  ): void {
    if (!this.spatial.resolve(x, y, z, this.res, refDist)) return;
    const o = this.play;
    o.bus = BUS_SFX;
    o.gain = this.res.gain * gain;
    o.rate = 0.94 + Math.random() * 0.12;
    o.pan = this.res.pan;
    o.priority = priority;
    o.lowpass = this.res.lowpass;
    o.delay = 0;
    this.engine.play(id, o, gateMs);
  }

  /** Unpositioned, centred, full level. */
  private flat(id: string, gain: number, priority: number, gateMs: number): void {
    const o = this.play;
    o.bus = BUS_SFX;
    o.gain = gain;
    o.rate = 0.97 + Math.random() * 0.06;
    o.pan = 0; o.priority = priority; o.lowpass = 0; o.delay = 0;
    this.engine.play(id, o, gateMs);
  }

  /** Ambience bed hook — kept so the bus is exercised and wired, not decorative. */
  ambient(id: string, x: number, y: number, z: number, gain = 1): void {
    if (!this.spatial.resolve(x, y, z, this.res, 8)) return;
    const o = this.play;
    o.bus = BUS_AMBIENCE;
    o.gain = this.res.gain * gain;
    o.rate = 1; o.pan = this.res.pan; o.priority = PRIO_AMBIENT;
    o.lowpass = this.res.lowpass; o.delay = 0;
    this.engine.play(id, o, 200);
  }
}

/* ------------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------------ */

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** FNV-1a over the sound id, so a variant's seed is stable and collision-free enough. */
function hashId(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Exposed for tests: the full id list the catalogue bakes. */
export function catalogueIds(): string[] {
  return buildJobs().map((j) => j.id);
}

/** Exposed for tests and tuning: one spec by id, unbaked. */
export function specById(id: string): SoundSpec | undefined {
  return buildJobs().find((j) => j.id === id)?.spec;
}
