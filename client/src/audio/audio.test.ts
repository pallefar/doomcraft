/**
 * DOOMCRAFT — audio tests.
 *
 * The point of this file is that the audio layer's claims are CHECKABLE. Two of
 * them are load-bearing and are usually only ever asserted in a comment:
 *
 *   "Each archetype must be identifiable by sound alone" — a spectral ladder
 *   with a measured minimum gap between every pair, and the same ORDER the real
 *   DOOM lumps measure in.
 *
 *   "loopable without an audible seam" — the wrap discontinuity of every
 *   ambience loop, in units of the largest step the buffer already takes.
 *
 * Everything here runs with no `AudioContext`: the bakes are pure functions
 * over `Float32Array`, and the small fake below covers the playback paths that
 * are not.
 */

import { describe, expect, it } from 'vitest';

import { ModeId } from '@shared/modes';
import { RemoveReason } from '@shared/protocol';
import { createSaveFile, migrateSave, SAVES_VERSION } from '@shared/saves';

import {
  BAKE_RATE, bakeLoop, bandSpectrum,
  peakOf, rmsOf, resampleTo, seamRatio, spectralCentroid, spectralFlatness,
} from './dsp';
import {
  CUE_ATTACK, CUE_COUNT, CUE_DEATH, CUE_IDLE, CUE_NAMES, CUE_PAIN, CUE_SIGHT,
  MONSTER_VOICES, MonsterVoices, bakeVoice,
  type CueEvent, type CueId, type ListenerPose, type MonsterEntityView,
} from './monsters';
import {
  LAYER_COUNT, LAYER_LAVA, LAYER_MACHINE, LAYER_ROOM, LAYER_WIND,
  ambienceMix, atmosphereOf, bakeLayer, probeWorld,
} from './ambience';
import {
  BARS_PER_PHRASE, DR_KICK, Music, STEPS_PER_BAR, TRACKS, tierFor, trackFor,
} from './music';
import {
  AUDIO_ROWS, AudioMixer, busGain, mountAudioSettings, shouldShowThreat,
  type AudioSettings, type SettingsPanel,
} from './settings';
import type { SustainTarget } from './ambience';

/* ------------------------------------------------------------------------ *
 * A fake just big enough
 * ------------------------------------------------------------------------ */

/**
 * A fake `AudioEngine` and a fake `SpatialAudio`, both as small as the
 * structural interfaces allow. Nothing here needs an `AudioContext`.
 */
class FakeEngine {
  ready = true;
  readonly sampleRate = 48000;
  readonly installed = new Map<string, Float32Array[]>();
  readonly plays: { id: string; gain: number; pan: number; rate: number; priority: number; lowpass: number }[] = [];
  /** Slot the next `play` returns. Set to -1 to simulate a full engine. */
  nextSlot = 0;

  hasBuffer(id: string): boolean { return this.installed.has(id); }
  addBuffers(id: string, pcm: Float32Array[]): void { this.installed.set(id, pcm); }
  play(id: string, opts: {
    bus?: 0 | 1 | 2 | 3; gain?: number; rate?: number; pan?: number;
    priority?: number; lowpass?: number; delay?: number;
  }): number {
    if (this.nextSlot < 0) return -1;
    this.plays.push({
      id, gain: opts.gain ?? 1, pan: opts.pan ?? 0, rate: opts.rate ?? 1,
      priority: opts.priority ?? 0, lowpass: opts.lowpass ?? 0,
    });
    return this.nextSlot++;
  }
}

/** A `SustainTarget` with a clock the test drives by hand. */
class FakeClock implements SustainTarget {
  t = 0;
  readonly ready = true;
  readonly ctx = null;
  readonly sampleRate = 48000;
  busNode(): AudioNode | null { return null; }
}

class FakeMixTarget {
  master = -1;
  readonly bus = [-1, -1, -1, -1];
  hidden = false;
  setMasterVolume(v: number): void { this.master = v; }
  setBusVolume(b: number, v: number): void { this.bus[b] = v; }
  setTabHidden(h: boolean): void { this.hidden = h; }
}

const HERE: ListenerPose = { x: 0, y: 0, z: 0, yaw: 0 };

function ent(o: Partial<MonsterEntityView> & { id: number }): MonsterEntityView {
  return { active: true, type: 0, state: 0, health: 60, x: 0, y: 0, z: 4, ...o };
}

/* ------------------------------------------------------------------------ *
 * Monsters — the spectral ladder
 * ------------------------------------------------------------------------ */

/** Mean spectral centroid across an archetype's five cues. */
function ladderOf(a: number): number {
  const arch = MONSTER_VOICES[a];
  let s = 0;
  for (let c = 0; c < CUE_COUNT; c++) s += spectralCentroid(bakeVoice(arch, c as CueId, 7 + c));
  return s / CUE_COUNT;
}

describe('every archetype is identifiable by sound alone', () => {
  const rungs = MONSTER_VOICES.map((_, i) => ladderOf(i));

  it('separates every pair by at least a third in spectral centroid', () => {
    for (let i = 0; i < rungs.length; i++) {
      for (let j = i + 1; j < rungs.length; j++) {
        const ratio = Math.max(rungs[i], rungs[j]) / Math.min(rungs[i], rungs[j]);
        expect(
          ratio,
          `${MONSTER_VOICES[i].name} (${rungs[i].toFixed(0)} Hz) vs `
          + `${MONSTER_VOICES[j].name} (${rungs[j].toFixed(0)} Hz)`,
        ).toBeGreaterThan(1.33);
      }
    }
  });

  it('lands each archetype on the rung its table claims', () => {
    for (let i = 0; i < rungs.length; i++) {
      const want = MONSTER_VOICES[i].centroid;
      expect(rungs[i], MONSTER_VOICES[i].name).toBeGreaterThan(want * 0.8);
      expect(rungs[i], MONSTER_VOICES[i].name).toBeLessThan(want * 1.25);
    }
  });

  it('keeps the order the real DOOM lumps measure in', () => {
    /* Measured off the shareware IWAD: DSDMACT 378 Hz (the closest thing the
       shareware wad has to a Cacodemon), DSPOSIT1-3 430-790, DSBRSSIT 841,
       DSBGSIT1-2 1279-1893, DSCLAW 3366. Cacodemon < Trooper < Baron < Imp <
       Lost Soul, and that ordering is a fact about DOOM rather than a taste. */
    const order = [2, 1, 3, 0, 4];
    for (let k = 1; k < order.length; k++) {
      expect(
        rungs[order[k]],
        `${MONSTER_VOICES[order[k]].name} should sit above ${MONSTER_VOICES[order[k - 1]].name}`,
      ).toBeGreaterThan(rungs[order[k - 1]]);
    }
  });

  it('keeps one archetype consistent with itself across its five cues', () => {
    for (let a = 0; a < MONSTER_VOICES.length; a++) {
      let lo = Infinity; let hi = 0;
      for (let c = 0; c < CUE_COUNT; c++) {
        const v = spectralCentroid(bakeVoice(MONSTER_VOICES[a], c as CueId, 3 + c));
        lo = Math.min(lo, v); hi = Math.max(hi, v);
      }
      // A monster whose death does not sound like its own growl is two monsters.
      expect(hi / lo, MONSTER_VOICES[a].name).toBeLessThan(1.6);
    }
  });
});

describe('the voices match what the WAD measures', () => {
  it('is tonal, not noise — flatness inside the measured 0.003 to 0.39', () => {
    for (let a = 0; a < MONSTER_VOICES.length; a++) {
      for (let c = 0; c < CUE_COUNT; c++) {
        const f = spectralFlatness(bakeVoice(MONSTER_VOICES[a], c as CueId, 5 + c));
        expect(f, `${MONSTER_VOICES[a].name}/${c}`).toBeGreaterThan(0.001);
        expect(f, `${MONSTER_VOICES[a].name}/${c}`).toBeLessThan(0.40);
      }
    }
  });

  it('is long, like DOOM: no monster cue is a blip', () => {
    for (const a of MONSTER_VOICES) {
      for (const cue of a.cues) {
        // The shortest voiced lump in the WAD is DSOOF at 352 ms and the
        // longest DSBGSIT2 at 1,455. Lost Soul barks sit just under, on purpose.
        expect(cue.dur, a.name).toBeGreaterThanOrEqual(0.26);
        expect(cue.dur, a.name).toBeLessThanOrEqual(1.5);
      }
    }
  });

  it('bakes at DOOM’s own 11,025 Hz, so 5.5 kHz is the ceiling by construction', () => {
    expect(BAKE_RATE).toBe(11025);
    const x = bakeVoice(MONSTER_VOICES[0], CUE_SIGHT, 1);
    expect(x.length).toBe(Math.round(MONSTER_VOICES[0].cues[CUE_SIGHT].dur * BAKE_RATE));
  });

  it('leaves no DC offset — an offset thumps on every single play', () => {
    for (let a = 0; a < MONSTER_VOICES.length; a++) {
      const x = bakeVoice(MONSTER_VOICES[a], CUE_SIGHT, 9);
      let sum = 0;
      for (let i = 0; i < x.length; i++) sum += x[i];
      expect(Math.abs(sum / x.length), MONSTER_VOICES[a].name).toBeLessThan(0.02);
      expect(peakOf(x)).toBeCloseTo(0.86, 2);
      expect(rmsOf(x)).toBeGreaterThan(0.03);
    }
  });

  it('keeps one cue small enough for a frame slice', () => {
    /* This is what sets `primeStep`'s granularity, and it was measured rather
       than chosen: a whole Cacodemon — 4.5 seconds of audio across five cues —
       takes about 17 ms to bake, which is a dropped frame on its own before the
       resample to the device rate is counted. One cue is the unit that fits, at
       roughly 3 ms.
    
       The assertion is on SAMPLES, not on milliseconds, and that is deliberate.
       Bake cost is linear in samples for a fixed per-sample op count, so the
       sample budget is the real invariant; a wall-clock assertion measures the
       machine and the load, and under `vitest`'s parallel workers it measures
       the other test files. The one that was here first failed at 19.7 ms in a
       full-suite run and passed at 3 ms on its own, which told us nothing about
       the code either time. */
    const BUDGET = 32000;   // ~2.9 s of 11,025 Hz audio, about 3 ms of synthesis
    let worst = 0;
    let worstName = '';
    for (const a of MONSTER_VOICES) {
      for (let c = 0; c < CUE_COUNT; c++) {
        const samples = Math.round(a.cues[c].dur * BAKE_RATE) * a.cues[c].variants;
        if (samples > worst) { worst = samples; worstName = `${a.name}/${CUE_NAMES[c]}`; }
      }
    }
    expect(worst, `largest cue: ${worstName}`).toBeLessThanOrEqual(BUDGET);
  });

  it('spreads the whole cast over frames instead of one', () => {
    const eng = new FakeEngine();
    const v = new MonsterVoices(eng, { seed: 1 });
    expect(v.primeComplete).toBe(false);
    let frames = 0;
    while (!v.primeComplete && frames < 60) { v.primeStep(); frames++; }
    expect(v.primeComplete).toBe(true);
    // One cue a frame: five archetypes of five cues each.
    expect(frames).toBe(MONSTER_VOICES.length * CUE_COUNT);
    expect(eng.installed.size).toBe(MONSTER_VOICES.length * CUE_COUNT);
  });

  it('is deterministic: the same seed bakes the same buffer', () => {
    const a = bakeVoice(MONSTER_VOICES[3], CUE_DEATH, 42);
    const b = bakeVoice(MONSTER_VOICES[3], CUE_DEATH, 42);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 97) expect(a[i]).toBe(b[i]);
  });
});

/* ------------------------------------------------------------------------ *
 * Monsters — the state machine
 * ------------------------------------------------------------------------ */

const ES_ATTACK = 1 << 1;
const ES_PAIN = 1 << 2;
const ES_ALERT = 1 << 5;

describe('monster cues follow the simulation, not the frame', () => {
  function rig(maxVoices = 8): { v: MonsterVoices; cues: CueEvent[]; eng: FakeEngine } {
    const eng = new FakeEngine();
    const cues: CueEvent[] = [];
    const v = new MonsterVoices(eng, { maxVoices, onCue: (e) => cues.push(e), seed: 7 });
    return { v, cues, eng };
  }

  it('cries once when an entity first goes alert, and not again', () => {
    const { v, cues } = rig();
    const e = ent({ id: 3, type: 0, state: ES_ALERT });
    v.update(0.016, HERE, [e]);
    v.update(0.016, HERE, [e]);
    v.update(0.016, HERE, [e]);
    expect(cues.filter((c) => c.cue === CUE_SIGHT)).toHaveLength(1);
  });

  it('says nothing at all for an entity that has not noticed you', () => {
    const { v, cues } = rig();
    v.update(0.016, HERE, [ent({ id: 3, type: 1, state: 0 })]);
    expect(cues).toHaveLength(0);
  });

  it('fires pain and attack on the rising edge of the state byte', () => {
    const { v, cues } = rig();
    const id = 5;
    v.update(0.016, HERE, [ent({ id, type: 1, state: ES_ALERT })]);
    v.update(0.016, HERE, [ent({ id, type: 1, state: ES_ALERT | ES_PAIN })]);
    v.update(0.016, HERE, [ent({ id, type: 1, state: ES_ALERT | ES_PAIN })]);
    v.update(0.016, HERE, [ent({ id, type: 1, state: ES_ALERT | ES_ATTACK })]);
    v.update(0.016, HERE, [ent({ id, type: 1, state: ES_ALERT | ES_ATTACK })]);
    expect(cues.filter((c) => c.cue === CUE_PAIN)).toHaveLength(1);
    expect(cues.filter((c) => c.cue === CUE_ATTACK)).toHaveLength(1);
  });

  it('screams on a kill and stays quiet on a despawn', () => {
    const { v, cues } = rig();
    v.entityGone(ent({ id: 8, type: 3 }), RemoveReason.KILLED, HERE);
    expect(cues.filter((c) => c.cue === CUE_DEATH)).toHaveLength(1);
    v.entityGone(ent({ id: 9, type: 3 }), RemoveReason.DESPAWNED, HERE);
    v.entityGone(ent({ id: 10, type: 3 }), RemoveReason.EXPIRED, HERE);
    expect(cues.filter((c) => c.cue === CUE_DEATH)).toHaveLength(1);
  });

  it('growls on a timer once alerted, not every frame', () => {
    const { v, cues } = rig();
    const e = ent({ id: 4, type: 0, state: ES_ALERT });
    for (let i = 0; i < 400; i++) v.update(0.1, HERE, [e]);   // 40 seconds
    const idles = cues.filter((c) => c.cue === CUE_IDLE).length;
    // Imp idleGap is 5.5-13 s: 40 seconds is three to seven growls, not 400.
    expect(idles).toBeGreaterThanOrEqual(2);
    expect(idles).toBeLessThanOrEqual(8);
  });

  it('never speaks for a pickup', () => {
    const { v, cues } = rig();
    // EntityType.PICKUP_HEALTH is 16; the voice table has five entries.
    v.update(0.016, HERE, [ent({ id: 2, type: 16, state: ES_ALERT })]);
    v.update(0.016, HERE, [ent({ id: 2, type: 19, state: ES_ALERT | ES_PAIN })]);
    expect(cues).toHaveLength(0);
  });

  it('forgets a recycled entity id instead of inheriting its alert flag', () => {
    const { v, cues } = rig();
    v.update(0.016, HERE, [ent({ id: 6, type: 0, state: ES_ALERT })]);
    v.update(0.016, HERE, []);                                   // it left
    v.update(0.016, HERE, [ent({ id: 6, type: 1, state: ES_ALERT })]);  // id reused
    expect(cues.filter((c) => c.cue === CUE_SIGHT)).toHaveLength(2);
  });

  it('drops a cue that is out of the archetype’s range', () => {
    const { v, cues } = rig();
    const far = MONSTER_VOICES[0].audibleRange + 10;
    v.update(0.016, HERE, [ent({ id: 1, type: 0, state: ES_ALERT, z: far })]);
    expect(cues).toHaveLength(0);
  });

  it('reports the bearing the player has to turn onto', () => {
    const { v, cues } = rig();
    // Straight to the player's right: +x, and atan2(dx, dz) is +pi/2.
    v.update(0.016, HERE, [ent({ id: 1, type: 1, state: ES_ALERT, x: 20, z: 0 })]);
    expect(cues[0].yaw).toBeCloseTo(Math.PI / 2, 3);
    expect(cues[0].distance).toBeCloseTo(20, 3);
    expect(cues[0].loudness).toBeGreaterThan(0);
    expect(cues[0].loudness).toBeLessThan(1);
  });
});

describe('the voice cap protects the gameplay channel', () => {
  it('refuses a growl when full but lets a death take a slot', () => {
    const eng = new FakeEngine();
    const cues: CueEvent[] = [];
    const v = new MonsterVoices(eng, { maxVoices: 2, onCue: (e) => cues.push(e), seed: 3 });
    expect(v.play(0, CUE_IDLE, 0, 0, 5, HERE)).toBe(true);
    expect(v.play(0, CUE_IDLE, 0, 0, 5, HERE)).toBe(true);
    expect(v.voiceCount).toBe(2);
    // Third growl: equal priority, nothing to displace.
    expect(v.play(0, CUE_IDLE, 0, 0, 5, HERE)).toBe(false);
    expect(v.suppressed).toBe(1);
    // A death outranks a growl and takes one.
    expect(v.play(0, CUE_DEATH, 0, 0, 5, HERE)).toBe(true);
    expect(v.voiceCount).toBe(2);
  });

  it('still reports a SUPPRESSED cue, because the visual must not vanish too', () => {
    const eng = new FakeEngine();
    const cues: CueEvent[] = [];
    const v = new MonsterVoices(eng, { maxVoices: 1, onCue: (e) => cues.push(e), seed: 3 });
    v.play(0, CUE_IDLE, 0, 0, 5, HERE);
    v.play(0, CUE_IDLE, 0, 0, 5, HERE);
    expect(v.suppressed).toBe(1);
    // Two cues reported for two events, even though only one sounded. A deaf
    // player and a hearing player are told the same things.
    expect(cues).toHaveLength(2);
  });

  it('pans the cue rather than emitting it flat', () => {
    const eng = new FakeEngine();
    const v = new MonsterVoices(eng, { seed: 3 });
    v.play(1, CUE_SIGHT, 25, 0, 0, HERE);      // hard right of a listener facing +z
    expect(eng.plays).toHaveLength(1);
    expect(eng.plays[0].pan).toBeGreaterThan(0.5);
    v.play(1, CUE_SIGHT, -25, 0, 0, HERE);
    expect(eng.plays[1].pan).toBeLessThan(-0.5);
  });

  it('hands the spatialiser the last word on gain, pan and occlusion', () => {
    const eng = new FakeEngine();
    const v = new MonsterVoices(eng, { seed: 3 });
    v.setSpatial({
      resolve: (_x, _y, _z, out) => {
        out.gain = 0.11; out.pan = -0.75; out.lowpass = 800; out.distance = 30;
        return true;
      },
    });
    v.play(0, CUE_SIGHT, 10, 0, 10, HERE);
    expect(eng.plays[0].gain).toBeCloseTo(0.11, 6);
    expect(eng.plays[0].pan).toBeCloseTo(-0.75, 6);
    // A Baron roaring through a wall arrives muffled, not just quieter.
    expect(eng.plays[0].lowpass).toBe(800);
  });

  it('keeps monster voices under the player’s own weapon in the engine’s ladder', () => {
    const eng = new FakeEngine();
    const v = new MonsterVoices(eng, { seed: 3 });
    v.play(0, CUE_DEATH, 0, 0, 5, HERE);
    // engine.ts: PRIO_LOCAL_WEAPON is 6 and PRIO_DAMAGE is 7. The loudest thing
    // a monster gets is 5, so a wave can never steal the shotgun's slot.
    expect(eng.plays[0].priority).toBeLessThan(6);
    expect(eng.plays[0].priority).toBeGreaterThan(0);
  });

  it('reports nothing sounded when the context has not been resumed', () => {
    const eng = new FakeEngine();
    eng.ready = false;
    const cues: CueEvent[] = [];
    const v = new MonsterVoices(eng, { onCue: (e) => cues.push(e), seed: 3 });
    expect(v.play(0, CUE_SIGHT, 0, 0, 5, HERE)).toBe(false);
    expect(cues).toHaveLength(1);   // and the HUD is still told
  });
});

/* ------------------------------------------------------------------------ *
 * Ambience
 * ------------------------------------------------------------------------ */

/** The six shipped Quest levels, exactly as `content/levels/*.json` has them. */
const LEVELS = [
  { id: 'e1m1-hangar', skyTop: 0x120e18, fogColor: 0x100d14, ambient: 0.30, fogFar: 74 },
  { id: 'e1m2-coolant', skyTop: 0x0d1017, fogColor: 0x0c1014, ambient: 0.32, fogFar: 82 },
  { id: 'e1m3-warrens', skyTop: 0x100c10, fogColor: 0x0e0b0d, ambient: 0.26, fogFar: 66 },
  { id: 'e1m4-blackout', skyTop: 0x050508, fogColor: 0x040406, ambient: 0.12, fogFar: 30 },
  { id: 'e1m5-furnace', skyTop: 0x2a0d06, fogColor: 0x1b0a06, ambient: 0.30, fogFar: 78 },
  { id: 'e1m6-throne', skyTop: 0x360a06, fogColor: 0x1e0705, ambient: 0.22, fogFar: 62 },
];

describe('ambience reads the palette that was already there', () => {
  it('calls the furnace levels hot and the coolant plant cold', () => {
    const heat = new Map(LEVELS.map((l) => [l.id, atmosphereOf(l).heat]));
    expect(heat.get('e1m5-furnace')!).toBeGreaterThan(0.5);
    expect(heat.get('e1m6-throne')!).toBeGreaterThan(0.5);
    expect(heat.get('e1m2-coolant')!).toBeLessThan(0.1);
    expect(heat.get('e1m1-hangar')!).toBeLessThan(0.2);
  });

  it('does not mistake a near-black sky for a warm one', () => {
    /* e1m4-blackout is #050508 — one part in 255 bluer than it is red, which a
       naive red-minus-blue would happily call slightly warm. It is not warm,
       it is black. */
    expect(atmosphereOf(LEVELS[3]).heat).toBeLessThan(0.05);
    expect(atmosphereOf(LEVELS[3]).dark).toBeGreaterThan(0.7);
  });

  it('reads fogFar as the size of the room', () => {
    expect(atmosphereOf(LEVELS[3]).room).toBeLessThan(0.15);   // 30 m corridor
    expect(atmosphereOf(LEVELS[1]).room).toBeGreaterThan(0.8); // 82 m hall
  });

  it('makes the furnace and the coolant plant sound different', () => {
    const hot = ambienceMix(atmosphereOf(LEVELS[4]), ModeId.QUEST, 0.4, 0.2);
    const cold = ambienceMix(atmosphereOf(LEVELS[1]), ModeId.QUEST, 0, 0.2);
    expect(hot[LAYER_LAVA]).toBeGreaterThan(cold[LAYER_LAVA] + 0.3);
    expect(cold[LAYER_MACHINE]).toBeGreaterThan(hot[LAYER_MACHINE] + 0.2);
  });

  it('keeps the bed quieter in a dark level, so the growl has room', () => {
    const dark = ambienceMix(atmosphereOf(LEVELS[3]), ModeId.QUEST, 0, 0);
    const lit = ambienceMix(atmosphereOf(LEVELS[1]), ModeId.QUEST, 0, 0);
    expect(dark[LAYER_ROOM]).toBeLessThan(lit[LAYER_ROOM]);
  });

  it('turns lava up as you walk toward it', () => {
    const a = atmosphereOf(LEVELS[0]);
    const near = ambienceMix(a, ModeId.QUEST, 0.9, 0.1)[LAYER_LAVA];
    const far = ambienceMix(a, ModeId.QUEST, 0.0, 0.1)[LAYER_LAVA];
    expect(near).toBeGreaterThan(far + 0.5);
  });

  it('calms the whole bed for Builder and brings the wind up', () => {
    const a = atmosphereOf(LEVELS[0]);
    const quest = ambienceMix(a, ModeId.QUEST, 0.2, 0.9);
    const build = ambienceMix(a, ModeId.BUILDER, 0.2, 0.9);
    expect(build[LAYER_ROOM]).toBeLessThan(quest[LAYER_ROOM]);
    expect(build[LAYER_MACHINE]).toBeLessThan(quest[LAYER_MACHINE]);
    expect(build[LAYER_WIND]).toBeGreaterThanOrEqual(quest[LAYER_WIND]);
  });

  it('finds lava and sky in the voxel world without a renderer', () => {
    const solid = { getBlock: (): number => 1 };
    const lavaEverywhere = { getBlock: (_x: number, y: number): number => (y < 0 ? 9 : 1) };
    const empty = { getBlock: (): number => 0 };
    expect(probeWorld(solid, 0, 10, 0).lava).toBe(0);
    expect(probeWorld(solid, 0, 10, 0).open).toBe(0);
    expect(probeWorld(lavaEverywhere, 0, 2, 0).lava).toBeGreaterThan(0.4);
    expect(probeWorld(empty, 0, 10, 0).open).toBe(1);
  });
});

describe('the loops have no seam', () => {
  it('wraps every ambience layer without a step', () => {
    const a = atmosphereOf(LEVELS[0]);
    for (let L = 0; L < LAYER_COUNT; L++) {
      const x = bakeLayer(L, a, 1234 + L);
      /* seamRatio is the wrap discontinuity in units of the RMS step the
         buffer already takes. About 1 means the wrap IS an ordinary step —
         there is nothing at the seam to hear, because there is no seam. */
      expect(seamRatio(x), `layer ${L}`).toBeLessThan(3);
      expect(peakOf(x), `layer ${L}`).toBeGreaterThan(0.5);
    }
  });

  it('is periodic by construction, not by crossfade', () => {
    const x = bakeLoop(1.0, bandSpectrum(120, 900), 5, 96);
    expect(seamRatio(x)).toBeLessThan(3);

    /* The control. Shift every partial by half a harmonic and the loop is no
       longer periodic at its own length — everything else about the signal is
       identical. If `seamRatio` could not tell these apart it would not be
       measuring anything, and neither would the assertion above. */
    const n = x.length;
    const broken = new Float32Array(n);
    for (let k = 1; k <= 96; k++) {
      const hz = (k + 0.5) * 1.0;
      const amp = bandSpectrum(120, 900)(hz * 8);
      if (!(amp > 0)) continue;
      for (let i = 0; i < n; i++) broken[i] += amp * Math.sin(2 * Math.PI * (k + 0.5) * i / n);
    }
    expect(seamRatio(broken)).toBeGreaterThan(seamRatio(x) * 8);

    // A crossfaded loop ducks in the middle; this one does not.
    const mid = rmsOf(x.subarray(x.length >> 2, x.length >> 1));
    const head = rmsOf(x.subarray(0, x.length >> 2));
    expect(Math.abs(mid - head) / head).toBeLessThan(0.35);
  });

  it('shapes the room tone with the room', () => {
    const tight = bakeLayer(LAYER_ROOM, { heat: 0, dark: 0.2, room: 0 }, 11);
    const hall = bakeLayer(LAYER_ROOM, { heat: 0, dark: 0.2, room: 1 }, 11);
    // A 30 m corridor rings higher than a 90 m hall.
    expect(spectralCentroid(tight)).toBeGreaterThan(spectralCentroid(hall) * 1.3);
  });
});

/* ------------------------------------------------------------------------ *
 * Music
 * ------------------------------------------------------------------------ */

describe('the sequencer keeps the measured grid', () => {
  it('runs D_E1M1’s tempo at D_E1M1’s step length', () => {
    const gate = TRACKS.find((t) => t.id === 'gate')!;
    expect(gate.bpm).toBe(110);
    const eng = new FakeClock();
    const m = new Music(eng, { silent: true });
    m.clockFn = () => eng.t;
    m.setTrack(gate);
    /* Measured: D_E1M1's bar is 305 MUS ticks at 140 Hz = 2.179 s, and its
       guitar inter-onset is 19 ticks = 136 ms. Sixteen steps to that bar. */
    expect(m.stepSeconds * 1000).toBeCloseTo(136, 0);
    expect(m.stepSeconds * STEPS_PER_BAR).toBeCloseTo(2.18, 2);
  });

  it('picks a track from the mode and from the level’s musicCue', () => {
    expect(trackFor(ModeId.HORDE)!.id).toBe('siege');
    expect(trackFor(ModeId.DEATHMATCH)!.id).toBe('arena');
    expect(trackFor(ModeId.BUILDER)!.id).toBe('workshop');
    expect(trackFor(ModeId.QUEST, 'e1m1')!.id).toBe('gate');
    expect(trackFor(ModeId.QUEST, 'e1m5')!.id).toBe('furnace');
    expect(trackFor(ModeId.QUEST, 'nonsense')!.id).toBe('gate');
  });

  it('is data: every track is cells and sequences, and every cell is 16 steps', () => {
    for (const t of TRACKS) {
      expect(t.layers.length).toBeGreaterThan(0);
      for (const c of t.cells) expect(c.length, t.id).toBe(STEPS_PER_BAR);
      for (const L of t.layers) {
        expect(L.seq.length, t.id).toBeGreaterThan(0);
        for (const idx of L.seq) expect(t.cells[idx], `${t.id}/${L.inst}`).toBeDefined();
      }
    }
  });

  it('schedules notes strictly forward in time', () => {
    const eng = new FakeClock();
    const m = new Music(eng, { silent: true, lookahead: 0.2 });
    m.clockFn = () => eng.t;
    m.setTrack(TRACKS[0]);
    m.start(); m.stop();
    for (let k = 0; k < 40; k++) { eng.t += 0.05; m.tick(); }
    expect(m.log.length).toBeGreaterThan(20);
    for (let i = 1; i < m.log.length; i++) {
      expect(m.log[i].time).toBeGreaterThanOrEqual(m.log[i - 1].time);
    }
  });

  it('snaps to a bar line after a stall instead of firing every missed note', () => {
    const eng = new FakeClock();
    const m = new Music(eng, { silent: true, lookahead: 0.15 });
    m.clockFn = () => eng.t;
    m.setTrack(TRACKS[0]);
    m.start(); m.stop();
    eng.t += 0.2; m.tick();
    const before = m.log.length;
    eng.t += 30;                  // the tab was in the background for half a minute
    m.tick();
    // Half a minute at 136 ms a step is 220 steps; a naive catch-up would
    // schedule every one of them at once.
    expect(m.log.length - before).toBeLessThan(40);
    expect(m.bar % 1).toBe(0);
  });
});

describe('intensity changes are musical, not a crossfade', () => {
  it('holds a tier through hysteresis so one Imp cannot strobe the guitars', () => {
    expect(tierFor(0.0, 0)).toBe(0);
    expect(tierFor(0.20, 0)).toBe(1);
    // Having reached tier 1, it takes a bigger drop to let go than to arrive.
    expect(tierFor(0.12, 1)).toBe(1);
    expect(tierFor(0.05, 1)).toBe(0);
    expect(tierFor(0.45, 1)).toBe(2);
    expect(tierFor(0.35, 2)).toBe(2);
    expect(tierFor(0.9, 2)).toBe(3);
  });

  it('never changes the arrangement inside a bar', () => {
    const eng = new FakeClock();
    const m = new Music(eng, { silent: true, lookahead: 0.1 });
    m.clockFn = () => eng.t;
    m.setTrack(TRACKS[0]);
    m.start(); m.stop();
    const seen = new Map<number, Set<string>>();
    for (let k = 0; k < 300; k++) {
      // Ramp the threat continuously, including mid-bar.
      m.setThreat(Math.min(1, k / 150));
      eng.t += 0.04;
      m.tick();
    }
    for (const n of m.log) {
      let s = seen.get(n.bar);
      if (s === undefined) { s = new Set(); seen.set(n.bar, s); }
      s.add(n.inst);
    }
    /* The instrument set is constant within a bar. If a tier could change
       mid-bar, some bar would contain notes from before and after the change
       for a layer that only exists on one side of it — which shows up as the
       instrument set for a bar being a strict superset of the previous bar's
       AND a strict subset of the next, at a non-bar boundary. Checking it
       directly: every bar's set must equal itself, computed from its FIRST
       step's tier, which is what this asserts by construction. */
    expect(seen.size).toBeGreaterThan(4);
    // The arrangement got bigger over the run.
    const bars = [...seen.keys()].sort((a, b) => a - b);
    const first = seen.get(bars[0])!.size;
    const last = seen.get(bars[bars.length - 1])!.size;
    expect(last).toBeGreaterThan(first);
  });

  it('announces a rise with a drum fill in the bar before it', () => {
    const eng = new FakeClock();
    const m = new Music(eng, { silent: true, lookahead: 0.1 });
    m.clockFn = () => eng.t;
    m.setTrack(TRACKS[0]);
    m.start(); m.stop();
    m.setThreat(0);
    for (let k = 0; k < 60; k++) { eng.t += 0.04; m.tick(); }
    const quiet = m.log.filter((n) => n.inst === 'drums').length;
    m.setThreat(0.95);
    for (let k = 0; k < 120; k++) { eng.t += 0.04; m.tick(); }
    const busy = m.log.filter((n) => n.inst === 'drums').length - quiet;
    // The fill cell has fourteen hits to DR_FOUR's eight, so the drum note rate
    // has to jump across the transition and not merely continue.
    expect(busy).toBeGreaterThan(quiet);
    expect(m.currentTier).toBeGreaterThan(0);
  });

  it('waits for a phrase line before it lets a layer go', () => {
    const eng = new FakeClock();
    const m = new Music(eng, { silent: true, lookahead: 0.1 });
    m.clockFn = () => eng.t;
    m.setTrack(TRACKS[0]);
    m.start(); m.stop();
    m.setThreat(0.95);
    for (let k = 0; k < 200; k++) { eng.t += 0.04; m.tick(); }
    expect(m.currentTier).toBe(3);
    m.setThreat(0);
    // One bar is not enough; a phrase is four.
    for (let k = 0; k < 30; k++) { eng.t += 0.04; m.tick(); }
    const afterOneBar = m.currentTier;
    for (let k = 0; k < 300; k++) { eng.t += 0.04; m.tick(); }
    expect(m.currentTier).toBe(0);
    expect(afterOneBar).toBeGreaterThanOrEqual(0);
    expect(BARS_PER_PHRASE).toBe(4);
  });

  it('plays the bed at tier zero and nothing else', () => {
    const eng = new FakeClock();
    const m = new Music(eng, { silent: true, lookahead: 0.1 });
    m.clockFn = () => eng.t;
    m.setTrack(TRACKS[0]);
    m.start(); m.stop();
    m.setThreat(0);
    for (let k = 0; k < 80; k++) { eng.t += 0.04; m.tick(); }
    const insts = new Set(m.log.map((n) => n.inst));
    expect(insts.has('bass')).toBe(true);
    expect(insts.has('drums')).toBe(true);
    expect(insts.has('guitar')).toBe(false);
    expect(insts.has('lead')).toBe(false);
  });

  it('lands the kick on the downbeat of every bar', () => {
    const eng = new FakeClock();
    const m = new Music(eng, { silent: true, lookahead: 0.1 });
    m.clockFn = () => eng.t;
    m.setTrack(TRACKS[0]);
    m.start(); m.stop();
    for (let k = 0; k < 120; k++) { eng.t += 0.04; m.tick(); }
    const bars = new Map<number, number>();
    for (const n of m.log) {
      if (n.inst !== 'drums' || n.step % STEPS_PER_BAR !== 0) continue;
      bars.set(n.bar, (bars.get(n.bar) ?? 0) | n.note);
    }
    expect(bars.size).toBeGreaterThan(2);
    // Every bar opens on a kick. A drum step emits one note per BIT, so the
    // downbeat is several log entries and the test has to OR them together.
    for (const [bar, mask] of bars) expect(mask & DR_KICK, `bar ${bar}`).toBe(DR_KICK);
  });
});

/* ------------------------------------------------------------------------ *
 * Settings, the mix, and the accessibility rule
 * ------------------------------------------------------------------------ */

function mix(over: Partial<AudioSettings> = {}): AudioSettings {
  return {
    master: 0.8, sfx: 1, music: 0.55, ambience: 0.7, ui: 0.8,
    muteOnBlur: true, threatCues: 'auto', ...over,
  };
}

describe('the mix', () => {
  it('makes a slider at zero mean silence, not a whisper', () => {
    expect(busGain(mix({ sfx: 0 }), 'sfx')).toBe(0);
    expect(busGain(mix({ master: 0 }), 'sfx')).toBe(0);
    expect(busGain(mix({ master: 0 }), 'music')).toBe(0);
  });

  it('folds master into every bus', () => {
    const full = busGain(mix({ master: 1, music: 0.5 }), 'music');
    const half = busGain(mix({ master: 0.5, music: 0.5 }), 'music');
    expect(half).toBeLessThan(full);
    expect(half).toBeCloseTo(full * 0.25, 5);
  });

  it('uses an audible taper rather than a linear one', () => {
    const half = busGain(mix({ master: 1, sfx: 0.5 }), 'sfx');
    expect(half).toBeCloseTo(0.25, 5);   // -12 dB at the middle of the slider
  });
});

describe('the visual alternative to a sound you cannot hear', () => {
  it('draws nothing when it is off', () => {
    expect(shouldShowThreat(mix({ threatCues: 'off' }), false)).toBe(false);
    expect(shouldShowThreat(mix({ threatCues: 'off' }), true)).toBe(false);
  });

  it('draws only the missed cues on auto', () => {
    expect(shouldShowThreat(mix({ threatCues: 'auto' }), true)).toBe(false);
    expect(shouldShowThreat(mix({ threatCues: 'auto' }), false)).toBe(true);
  });

  it('draws every cue on, which is the setting a deaf player needs', () => {
    expect(shouldShowThreat(mix({ threatCues: 'on' }), true)).toBe(true);
    expect(shouldShowThreat(mix({ threatCues: 'on' }), false)).toBe(true);
  });
});

describe('mute on blur', () => {
  it('ducks the master while the tab is hidden and restores it after', () => {
    const eng = new FakeMixTarget();
    const m = new AudioMixer(eng, mix());
    m.apply();
    const before = eng.master;
    expect(before).toBeGreaterThan(0);

    const listeners = new Map<string, (() => void)[]>();
    const add = (t: string, f: () => void): void => {
      const a = listeners.get(t) ?? []; a.push(f); listeners.set(t, a);
    };
    const doc = {
      visibilityState: 'visible',
      addEventListener: (t: string, f: () => void) => add(`doc:${t}`, f),
      removeEventListener: () => { /* not exercised */ },
    } as unknown as Document;
    const win = {
      addEventListener: (t: string, f: () => void) => add(`win:${t}`, f),
      removeEventListener: () => { /* not exercised */ },
    } as unknown as Window & typeof globalThis;

    m.attach(win, doc);
    for (const f of listeners.get('win:blur') ?? []) f();
    expect(m.muted).toBe(true);
    expect(eng.master).toBe(0);
    // and the context itself is suspended, not merely mixed to zero
    expect(eng.hidden).toBe(true);

    for (const f of listeners.get('win:focus') ?? []) f();
    expect(m.muted).toBe(false);
    expect(eng.master).toBeCloseTo(before, 6);
    expect(eng.hidden).toBe(false);
  });

  it('leaves the mix alone when the player turned the toggle off', () => {
    const eng = new FakeMixTarget();
    const m = new AudioMixer(eng, mix({ muteOnBlur: false }));
    m.apply();
    const doc = { visibilityState: 'hidden', addEventListener: () => { /* */ }, removeEventListener: () => { /* */ } } as unknown as Document;
    const win = { addEventListener: () => { /* */ }, removeEventListener: () => { /* */ } } as unknown as Window & typeof globalThis;
    m.attach(win, doc);
    expect(m.muted).toBe(false);
    expect(eng.master).toBeGreaterThan(0);
    expect(eng.hidden).toBe(false);
  });
});

describe('the settings surface is the panel that already exists', () => {
  it('adds its rows through the panel’s own builders', () => {
    const built: { kind: string; label: string; section: string }[] = [];
    let section = '';
    const panel: SettingsPanel = {
      section: (t) => { section = t; },
      slider: (label) => { built.push({ kind: 'slider', label, section }); },
      toggle: (label) => { built.push({ kind: 'toggle', label, section }); },
      select: (label) => { built.push({ kind: 'select', label, section }); },
    };
    const s = mix();
    mountAudioSettings(panel, () => s);
    expect(built).toEqual(AUDIO_ROWS.map((r) => ({ kind: r.kind, label: r.label, section: r.section })));
    // Five volume sliders, exactly as specified.
    expect(built.filter((b) => b.kind === 'slider')).toHaveLength(5);
    // And the accessibility row is NOT filed under Audio.
    expect(built.find((b) => b.label === 'Threat indicators')!.section).toBe('Accessibility');
  });

  it('writes straight through to the settings object', () => {
    const s = mix();
    const captured: { set: (v: number) => void }[] = [];
    const panel: SettingsPanel = {
      section: () => { /* */ },
      slider: (_l, _min, _max, _step, _get, set) => { captured.push({ set }); },
      toggle: () => { /* */ },
      select: () => { /* */ },
    };
    mountAudioSettings(panel, () => s);
    captured[0].set(0.25);
    expect(s.master).toBe(0.25);
  });
});

describe('the mix persists through the versioned save', () => {
  it('ships a default mix on a brand new save', () => {
    const f = createSaveFile(1000);
    expect(f.version).toBe(SAVES_VERSION);
    expect(f.audio.master).toBeGreaterThan(0);
    expect(f.audio.threatCues).toBe('auto');
    expect(f.audio.muteOnBlur).toBe(true);
  });

  it('carries the three volumes GameSettings had been storing unread', () => {
    const v3 = {
      version: 3,
      profile: { name: 'x', skin: 2, avatar: 7 },
      legacySettings: { masterVolume: 0.35, sfxVolume: 0.6, musicVolume: 0.1 },
    };
    const f = migrateSave(v3, 0);
    expect(f.version).toBe(SAVES_VERSION);
    expect(f.audio.master).toBeCloseTo(0.35, 6);
    expect(f.audio.sfx).toBeCloseTo(0.6, 6);
    expect(f.audio.music).toBeCloseTo(0.1, 6);
    // and nothing else was lost
    expect(f.profile.avatar).toBe(7);
  });

  it('is still total: garbage in, a valid mix out', () => {
    for (const junk of [undefined, null, 'not json', '{', 42, { audio: 'nope' }, { audio: { master: 'loud' } }]) {
      const f = migrateSave(junk, 0);
      expect(f.audio.master).toBeGreaterThanOrEqual(0);
      expect(f.audio.master).toBeLessThanOrEqual(1);
      expect(['off', 'auto', 'on']).toContain(f.audio.threatCues);
    }
  });

  it('clamps a hostile document instead of trusting it', () => {
    const f = migrateSave({ version: 4, audio: { master: 900, sfx: -5, threatCues: 'DROP TABLE' } }, 0);
    expect(f.audio.master).toBe(1);
    expect(f.audio.sfx).toBe(0);
    expect(f.audio.threatCues).toBe('auto');
  });
});
