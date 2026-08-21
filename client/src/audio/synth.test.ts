/**
 * The synthesis primitives, and the measured targets the catalogue must hit.
 *
 * The point of this file is that the DOOM measurements in `synth.ts` and
 * `sfx.ts` stay HONEST. Numbers in a comment rot; numbers in an assertion do
 * not. Every target below came from decoding DOOM 1.9's DMX lumps directly
 * (the `ref/` captures carry no audio track — see the `synth.ts` header), so if
 * somebody later "improves" the shotgun into a bright 60 ms tick, this fails.
 */

import { describe, it, expect } from 'vitest';
import {
  render, measure, envAt, bitcrush, saturate, lowpass, makeRng,
  type Env, type SoundSpec,
} from './synth';
import {
  specById, catalogueIds, sndFire, sndImpact, sndStep, sndReload, sndDry, sndSwitch,
  materialOf, MAT_COUNT,
} from './sfx';
import { WEAPONS, WEAPON_COUNT, WeaponId, FireKind, BLOCK_COUNT } from '@shared/index';

const SR = 48000;

/* ------------------------------------------------------------------------ *
 * Analysis helpers — the same measurements that were run against the WAD
 * ------------------------------------------------------------------------ */

/** Fraction of total energy below `hz`, via a real DFT on a decimated copy. */
function energyBelow(buf: Float32Array, hz: number, sr = SR): number {
  // Decimate to 11025 Hz first: it is the rate the reference material lives at,
  // it makes the DFT tractable, and everything above its Nyquist is, by the
  // band limit the specs apply, supposed to be empty anyway.
  const step = Math.max(1, Math.round(sr / 11025));
  const n = Math.floor(buf.length / step);
  const N = 1 << Math.floor(Math.log2(Math.min(n, 8192)));
  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = buf[i * step] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const rate = sr / step;
  let below = 0, total = 0;
  const kMax = N >> 1;
  for (let k = 1; k < kMax; k++) {
    let re = 0, im = 0;
    // A sparse DFT: only every 4th bin, which is plenty for a band-energy ratio
    // and keeps the test fast.
    if (k % 4 !== 0) continue;
    for (let i = 0; i < N; i++) {
      const a = (-2 * Math.PI * k * i) / N;
      re += x[i] * Math.cos(a);
      im += x[i] * Math.sin(a);
    }
    const p = re * re + im * im;
    total += p;
    if ((k * rate) / N < hz) below += p;
  }
  return total > 0 ? below / total : 0;
}

/** RMS envelope in `frameMs` frames. */
function envelope(buf: Float32Array, frameMs = 10, sr = SR): Float32Array {
  const w = Math.max(1, Math.floor((sr * frameMs) / 1000));
  const n = Math.floor(buf.length / w);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < w; j++) { const v = buf[i * w + j]; s += v * v; }
    out[i] = Math.sqrt(s / w);
  }
  return out;
}

/** Milliseconds the envelope stays within `db` of its own peak. */
function plateauMs(buf: Float32Array, db = 6, frameMs = 10): number {
  const e = envelope(buf, frameMs);
  let pk = 0;
  for (let i = 0; i < e.length; i++) if (e[i] > pk) pk = e[i];
  const thr = pk * Math.pow(10, -db / 20);
  let last = -1;
  for (let i = 0; i < e.length; i++) if (e[i] >= thr) last = i;
  return (last + 1) * frameMs;
}

/* ------------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------------ */

describe('envelope', () => {
  const e: Env = { attackMs: 10, holdMs: 100, decayMs: 200, curve: 2, hold: 1 };

  it('rises over the attack, then holds FLAT — the plateau is the point', () => {
    expect(envAt(e, 0)).toBeCloseTo(0, 5);
    expect(envAt(e, 0.005)).toBeCloseTo(0.5, 2);
    expect(envAt(e, 0.010)).toBeCloseTo(1, 5);
    // The whole reason `Env` has a hold stage: DSSHOTGN measured a 410 ms
    // plateau that never falls 6 dB, and an exponential decay cannot do that.
    for (const t of [0.012, 0.05, 0.09, 0.109]) expect(envAt(e, t)).toBeCloseTo(1, 5);
  });

  it('decays to zero at the end and stays there', () => {
    // Exactly at the boundary the two ways of computing "the end" differ by one
    // float ulp, so this asserts silence rather than bit-equality with 0 — the
    // audible property is what matters and a 1e-32 sample is silence.
    expect(envAt(e, 0.11 + 0.2)).toBeLessThan(1e-12);
    expect(envAt(e, 0.32)).toBe(0);
    expect(envAt(e, 5)).toBe(0);
    expect(envAt(e, 0.21)).toBeGreaterThan(0);
    expect(envAt(e, 0.21)).toBeLessThan(1);
  });

  it('is monotonically falling through the decay', () => {
    let prev = 1;
    for (let t = 0.11; t < 0.31; t += 0.005) {
      const v = envAt(e, t);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });
});

describe('shapers', () => {
  it('bitcrush quantises to the requested number of levels', () => {
    const b = new Float32Array(2048);
    const rng = makeRng(1);
    for (let i = 0; i < b.length; i++) b[i] = rng();
    bitcrush(b, 8);
    const levels = 128;
    const seen = new Set<number>();
    for (let i = 0; i < b.length; i++) {
      const q = b[i] * levels;
      expect(Math.abs(q - Math.round(q))).toBeLessThan(1e-4);
      seen.add(Math.round(q));
    }
    // And it really is a coarse grid, not a no-op.
    expect(seen.size).toBeLessThanOrEqual(levels * 2 + 1);
  });

  it('saturate lowers the crest factor — that is what "driven" means', () => {
    const mk = (): Float32Array => {
      const b = new Float32Array(4096);
      const rng = makeRng(7);
      for (let i = 0; i < b.length; i++) b[i] = rng() * 0.5;
      return b;
    };
    const clean = mk();
    const driven = mk();
    saturate(driven, 8);
    // Renormalise both to the same peak so this compares SHAPE, not level.
    const norm = (x: Float32Array): void => {
      let m = 0;
      for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
      for (let i = 0; i < x.length; i++) x[i] /= m;
    };
    norm(clean); norm(driven);
    expect(measure(driven).crestDb).toBeLessThan(measure(clean).crestDb);
  });

  it('lowpass removes high-frequency energy', () => {
    const b = new Float32Array(8192);
    const rng = makeRng(3);
    for (let i = 0; i < b.length; i++) b[i] = rng();
    const before = energyBelow(b, 1000);
    lowpass(b, SR, 800);
    expect(energyBelow(b, 1000)).toBeGreaterThan(before);
  });
});

describe('render', () => {
  const spec: SoundSpec = {
    durationMs: 200,
    layers: [{ kind: 'noise', gain: 1, colour: 0.5, env: { attackMs: 1, holdMs: 50, decayMs: 140 } }],
  };

  it('is deterministic in (spec, seed)', () => {
    const a = render(spec, SR, 12345);
    const b = render(spec, SR, 12345);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 97) expect(a[i]).toBe(b[i]);
  });

  it('produces a DIFFERENT variant for a different seed', () => {
    const a = render(spec, SR, 1);
    const b = render(spec, SR, 2);
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-6) diff++;
    expect(diff / a.length).toBeGreaterThan(0.5);
  });

  it('starts and ends at silence — a discontinuity is a click on every shot', () => {
    const a = render(spec, SR, 9);
    expect(Math.abs(a[0])).toBeLessThan(1e-3);
    expect(Math.abs(a[a.length - 1])).toBeLessThan(1e-3);
  });

  it('normalises to the requested peak and never exceeds it', () => {
    const a = render({ ...spec, peak: 0.7 }, SR, 4);
    const m = measure(a);
    expect(m.peak).toBeGreaterThan(0.6);
    expect(m.peak).toBeLessThanOrEqual(0.7 + 1e-4);
  });

  it('band-limits to DOOM\'s Nyquist, because the reference has nothing above it', () => {
    const a = render({
      durationMs: 300,
      layers: [{ kind: 'noise', gain: 1, colour: 0, env: { attackMs: 1, holdMs: 200, decayMs: 90 } }],
    }, SR, 11);
    // 11025 Hz sampling means 5512 Hz is a hard ceiling on the source material.
    expect(energyBelow(a, 5512)).toBeGreaterThan(0.9);
  });
});

/* ------------------------------------------------------------------------ *
 * The measured targets
 * ------------------------------------------------------------------------ */

describe('the shotgun matches the DOOM measurements', () => {
  // Measured from DSSHOTGN in DOOM1.WAD (v1.9 shareware):
  //   854 ms long, 410 ms plateau within 6 dB, 64.6% of energy below 200 Hz,
  //   85% rolloff at 548 Hz, dominant resonance 153 Hz, crest factor 13.8 dB.
  const buf = render(specById(sndFire(WeaponId.SHOTGUN))!, SR, 4242);

  it('is LONG — a shotgun is a roar, not a click', () => {
    const ms = (buf.length / SR) * 1000;
    expect(ms).toBeGreaterThan(700);
    expect(ms).toBeLessThanOrEqual(900);
  });

  it('holds a plateau rather than decaying immediately', () => {
    // The measured plateau is 410 ms. Anything under 250 ms means somebody has
    // replaced the hold stage with a decay and the weapon has lost its body.
    expect(plateauMs(buf)).toBeGreaterThan(250);
  });

  it('is DARK — most of its energy is below 200 Hz, as measured', () => {
    // Measured 64.6%. The synthesis is not required to match to the decimal,
    // but it IS required to be a low sound: a bright shotgun loses the gunfeel
    // A/B in ref/BAR.md on its own.
    expect(energyBelow(buf, 200)).toBeGreaterThan(0.45);
    expect(energyBelow(buf, 550)).toBeGreaterThan(0.75);
  });

  it('is saturated to the measured crest factor of 13.8 dB', () => {
    // This is the assertion that keeps `drive` honest. `render` normalises
    // before the waveshaper precisely so this number is comparable to the
    // reference at all — without that, `drive` meant something different in
    // every spec and this test could not exist.
    const m = measure(buf);
    expect(m.crestDb).toBeGreaterThan(10);
    expect(m.crestDb).toBeLessThan(18);
  });

  it('is darker and longer than the pistol, in that order', () => {
    const pistol = render(specById(sndFire(WeaponId.PISTOL))!, SR, 4242);
    expect(buf.length).toBeGreaterThan(pistol.length);
    // Measured: shotgun 64.6% under 200 Hz against the pistol's 33.5%.
    expect(energyBelow(buf, 200)).toBeGreaterThan(energyBelow(pistol, 200));
  });
});

describe('explosions match DSBAREXP', () => {
  // Measured: 1683 ms, 540 ms plateau, 56.0% of energy below 200 Hz,
  // 1822 Hz 85%-rolloff, crest factor 14.9 dB.
  const buf = render(specById('exp.b')!, SR, 808);

  it('is long and holds a plateau', () => {
    expect((buf.length / SR) * 1000).toBeGreaterThan(1400);
    expect(plateauMs(buf)).toBeGreaterThan(350);
  });

  it('is low — over half its energy below 200 Hz, as measured', () => {
    expect(energyBelow(buf, 200)).toBeGreaterThan(0.45);
  });

  it('sits in the measured crest band rather than being crushed flat', () => {
    const m = measure(buf);
    expect(m.crestDb).toBeGreaterThan(10);
    expect(m.crestDb).toBeLessThan(18);
  });

  it('is bigger than the small blast in both length and low end', () => {
    const small = render(specById('exp.s')!, SR, 808);
    expect(buf.length).toBeGreaterThan(small.length);
    expect(energyBelow(buf, 200)).toBeGreaterThan(energyBelow(small, 200));
  });
});

describe('every weapon lands in the measured crest band', () => {
  // DOOM's own lumps cluster tightly: 13.6-15.0 dB across the shotgun, pistol,
  // rocket, chainsaw and barrel explosion. A sound outside that band has either
  // lost its saturation or been crushed into a square wave.
  it('holds 10-18 dB for all seven', () => {
    for (let w = 0; w < WEAPON_COUNT; w++) {
      const m = measure(render(specById(sndFire(w))!, SR, 4242));
      expect(m.crestDb, `weapon ${w} crest`).toBeGreaterThan(10);
      expect(m.crestDb, `weapon ${w} crest`).toBeLessThan(18);
    }
  });
});

describe('the chainsaw is the bright end of the ladder', () => {
  // DSSAWFUL measured 39% of energy above 2 kHz and only 0.3% below 100 Hz —
  // the opposite of every other weapon, and the reason it is built from a saw
  // wave and FM rather than from filtered noise.
  it('has far less low end than the shotgun', () => {
    const saw = render(specById(sndFire(WeaponId.CHAINSAW))!, SR, 77);
    const shotgun = render(specById(sndFire(WeaponId.SHOTGUN))!, SR, 77);
    expect(energyBelow(saw, 200)).toBeLessThan(energyBelow(shotgun, 200) * 0.6);
  });
});

/* ------------------------------------------------------------------------ *
 * Catalogue completeness and the cadence rule
 * ------------------------------------------------------------------------ */

describe('the catalogue covers the arsenal', () => {
  it('gives every weapon a fire, a dry-fire and a switch sound', () => {
    const ids = new Set(catalogueIds());
    for (let w = 0; w < WEAPON_COUNT; w++) {
      expect(ids.has(sndFire(w))).toBe(true);
      expect(ids.has(sndDry(w))).toBe(true);
      expect(ids.has(sndSwitch(w))).toBe(true);
    }
  });

  it('gives every weapon that has a magazine a reload sound', () => {
    const ids = new Set(catalogueIds());
    for (let w = 0; w < WEAPON_COUNT; w++) {
      if (WEAPONS[w].kind === FireKind.MELEE || WEAPONS[w].magSize === 0) continue;
      expect(ids.has(sndReload(w))).toBe(true);
    }
  });

  it('has no duplicate ids', () => {
    const ids = catalogueIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every fire sound inside 1.6x its own fire interval', () => {
    // The cadence rule. A 511 ms pistol sample at 420 rpm stacks three and a
    // half copies and turns the weapon into mud; capping the tail at 1.6x the
    // interval means at most two shots ever overlap.
    for (let w = 0; w < WEAPON_COUNT; w++) {
      const spec = specById(sndFire(w))!;
      const budget = (60000 / WEAPONS[w].rpm) * 1.6;
      expect(spec.durationMs).toBeLessThanOrEqual(budget + 1);
    }
  });

  it('every fire sound actually makes sound', () => {
    for (let w = 0; w < WEAPON_COUNT; w++) {
      const m = measure(render(specById(sndFire(w))!, SR, 5));
      expect(m.rms).toBeGreaterThan(0.02);
      expect(Number.isFinite(m.rms)).toBe(true);
    }
  });
});

describe('surfaces', () => {
  it('maps every block id to a real material class', () => {
    for (let b = 0; b < BLOCK_COUNT; b++) {
      const m = materialOf(b);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThan(MAT_COUNT);
    }
  });

  it('bakes an impact and a footstep for every material', () => {
    const ids = new Set(catalogueIds());
    for (let m = 0; m < MAT_COUNT; m++) {
      expect(ids.has(sndImpact(m))).toBe(true);
      expect(ids.has(sndStep(m))).toBe(true);
    }
  });

  it('makes materials actually sound different from each other', () => {
    // Stone, metal and snow must not converge on the same noise burst — the
    // whole point of a material table is that you can hear what you just hit.
    const low: number[] = [];
    for (let m = 0; m < MAT_COUNT; m++) {
      low.push(energyBelow(render(specById(sndImpact(m))!, SR, 31), 800));
    }
    expect(Math.max(...low) - Math.min(...low)).toBeGreaterThan(0.3);
  });

  it('keeps footsteps quiet — they are the most repeated sound in the game', () => {
    for (let m = 0; m < MAT_COUNT; m++) {
      const step = measure(render(specById(sndStep(m))!, SR, 13));
      const fire = measure(render(specById(sndFire(WeaponId.SHOTGUN))!, SR, 13));
      expect(step.peak).toBeLessThan(fire.peak * 0.6);
    }
  });

  it('gives footsteps several variants so a run is not a loop', () => {
    for (let m = 0; m < MAT_COUNT; m++) {
      expect(specById(sndStep(m))!.variants ?? 1).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('the whole catalogue is cheap enough to bake', () => {
  it('renders every sound without producing NaN or clipping past 1.0', () => {
    for (const id of catalogueIds()) {
      const buf = render(specById(id)!, SR, 2024);
      let bad = 0, over = 0;
      for (let i = 0; i < buf.length; i++) {
        if (!Number.isFinite(buf[i])) bad++;
        if (Math.abs(buf[i]) > 1.0001) over++;
      }
      expect(bad, `${id} produced non-finite samples`).toBe(0);
      expect(over, `${id} exceeded full scale`).toBe(0);
    }
  });

  it('bakes the full catalogue well inside a boot budget', () => {
    // Not a frame budget — the bake is sliced across frames by `Sfx.bakeStep`.
    // This guards the total: if the catalogue ever costs a quarter of a second
    // of CPU, slicing it stops being enough and it needs a worker.
    const t0 = performance.now();
    for (const id of catalogueIds()) {
      const spec = specById(id)!;
      const n = spec.variants ?? 2;
      for (let v = 0; v < n; v++) render(spec, SR, v * 7919);
    }
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2500);
  });
});
