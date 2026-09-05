/**
 * GUNFEEL — the shot path, measured.
 *
 * The bar (`ref/BAR.md` weaknesses #2 and #3) is voxiom.io, where a held weapon
 * does not move one pixel across 1.2 s of mouselook and the crosshair is a
 * static plus. Beating that is not a matter of having a spread field and a
 * shake call somewhere in the file — it is a matter of those numbers actually
 * MOVING while you shoot, which is exactly the thing that had silently stopped
 * being true. Every test here asserts a quantity a player can see change.
 */

import { describe, it, expect } from 'vitest';
import {
  WeaponRuntime, createFireContext, createHitTargets, pushPlayerTarget,
  type WeaponFx, type CameraFeedback, type WeaponWorld,
} from './weapons';
import { WeaponId, getWeapon } from '@shared/weapons';
import { createVoxelHit, type VoxelHit } from '@shared/math';

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

/** Records every amplitude the camera was asked to shake by. */
function recordingCamera(): CameraFeedback & { shakes: number[]; punches: number[] } {
  const shakes: number[] = [];
  const punches: number[] = [];
  return {
    shakes, punches,
    addRecoil(): void { /* not under test here */ },
    addShake(amplitude: number): void { shakes.push(amplitude); },
    addFovPunch(degrees: number): void { punches.push(degrees); },
  };
}

interface FxLog {
  markers: { damage: number; headshot: boolean; killed: boolean; hits: number }[];
  confirms: { killed: boolean; damage: number; hits: number; pellets: number }[];
  muzzles: number;
  tracers: number;
  impacts: number;
  strikes: { x: number; y: number; z: number; blockId: number; power: number }[];
  misses: number;
}

function recordingFx(): WeaponFx & { log: FxLog } {
  const log: FxLog = {
    markers: [], confirms: [], muzzles: 0, tracers: 0, impacts: 0,
    strikes: [], misses: 0,
  };
  return {
    log,
    muzzleFlash(): void { log.muzzles++; },
    tracer(): void { log.tracers++; },
    impact(): void { log.impacts++; },
    meleeMiss(): void { log.misses++; },
    blockStrike(x, y, z, _nx, _ny, _nz, blockId, _weaponId, power): void {
      log.strikes.push({ x, y, z, blockId, power });
    },
    hitMarker(damage, headshot, killed, hits): void {
      log.markers.push({ damage, headshot, killed, hits: hits ?? 0 });
    },
    hitConfirm(_x, _y, _z, _nx, _ny, _nz, damage, _headshot, killed, hits, pellets): void {
      log.confirms.push({ killed, damage, hits: hits ?? -1, pellets: pellets ?? -1 });
    },
  };
}

/** A world made entirely of air: nothing stops a bullet. */
const EMPTY_WORLD: WeaponWorld = {
  raycast(): boolean { return false; },
};

/** A world that is solid at exactly `dist` metres along any ray. */
function wallAt(dist: number): WeaponWorld {
  return {
    raycast(_ox, _oy, _oz, _dx, _dy, _dz, maxDist, out: VoxelHit): boolean {
      if (dist > maxDist) return false;
      out.distance = dist;
      out.block = 1;
      out.nx = 0; out.ny = 0; out.nz = 1;
      return true;
    },
  };
}

/** Aim straight down -Z from the origin, eye height 1.6. */
function ctxAt(nowMs: number, firing: boolean): ReturnType<typeof createFireContext> {
  const c = createFireContext();
  c.nowMs = nowMs;
  c.ox = 0; c.oy = 1.6; c.oz = 0;
  c.dx = 0; c.dy = 0; c.dz = -1;
  c.firing = firing;
  c.ownerId = 1;
  c.world = EMPTY_WORLD;
  c.team = 255;
  return c;
}

const FRAME = 1 / 60;

/** Run `seconds` of frames of a PULSED trigger — one frame on, `gap` off. */
function pulse(w: WeaponRuntime, seconds: number, gapFrames: number): void {
  const ctx = ctxAt(0, false);
  const frames = Math.round(seconds / FRAME);
  for (let i = 0; i < frames; i++) {
    ctx.nowMs += FRAME * 1000;
    ctx.firing = i % (gapFrames + 1) === 0;
    w.update(FRAME, ctx);
  }
}

/** Run `seconds` of frames, returning the runtime. */
function run(
  w: WeaponRuntime, seconds: number, firing: boolean,
  ctx = ctxAt(0, firing),
): void {
  const frames = Math.round(seconds / FRAME);
  for (let i = 0; i < frames; i++) {
    ctx.nowMs += FRAME * 1000;
    ctx.firing = firing;
    w.update(FRAME, ctx);
  }
}

/* ------------------------------------------------------------------------ *
 * The crosshair actually blooms
 * ------------------------------------------------------------------------ */

describe('spread bloom — the dynamic crosshair has something to show', () => {
  /**
   * The regression this suite exists for.
   *
   * Recovery used to run on any frame inside the weapon's own cooldown, which
   * during sustained fire is five frames out of six. Recovery outruns
   * accumulation on every automatic weapon in the table — the pistol adds
   * 0.042 rad/s of cone and sheds 0.10 — so the cone never left its floor and
   * the dynamic crosshair was, in practice, the bar's static plus.
   */
  it('opens the cone while the trigger is held', () => {
    const w = new WeaponRuntime();
    expect(w.current).toBe(WeaponId.PISTOL);
    const cold = w.liveSpreadFraction(false, false);
    expect(cold).toBeLessThan(0.15);

    run(w, 0.6, true);

    const hot = w.liveSpreadFraction(false, false);
    expect(hot).toBeGreaterThan(0.4);
    expect(hot).toBeGreaterThan(cold + 0.3);
  });

  it('closes it again once the trigger is released', () => {
    const w = new WeaponRuntime();
    run(w, 0.6, true);
    expect(w.liveSpreadFraction(false, false)).toBeGreaterThan(0.4);

    run(w, 0.8, false);
    expect(w.liveSpreadFraction(false, false)).toBeLessThan(0.15);
  });

  it('does not open the cone while reloading — the gun is not cycling', () => {
    const w = new WeaponRuntime();
    run(w, 0.6, true);
    const hot = w.liveSpreadFraction(false, false);
    w.startReload();
    expect(w.reloading).toBe(true);
    // Trigger still held, but a reloading weapon recovers.
    run(w, 0.5, true);
    expect(w.liveSpreadFraction(false, false)).toBeLessThan(hot);
  });

  it('leaving the ground opens it immediately, with no shots fired', () => {
    const w = new WeaponRuntime();
    const ground = w.liveSpreadFraction(false, false);
    const air = w.liveSpreadFraction(true, false);
    expect(air).toBeGreaterThan(ground + 0.2);
  });

  it('a crouched shotgun still reads wider than a standing pistol', () => {
    // Absolute cones, not per-weapon normalised: the crosshair has to say
    // where the pellets go, and a shotgun's go everywhere.
    const w = new WeaponRuntime();
    w.grant(WeaponId.SHOTGUN);
    const pistolCone = w.liveSpread(false, false);
    w.switchTo(WeaponId.SHOTGUN);
    run(w, 1.0, false);
    expect(w.current).toBe(WeaponId.SHOTGUN);
    expect(w.liveSpread(false, true)).toBeGreaterThan(pistolCone);
  });
});

/* ------------------------------------------------------------------------ *
 * Trauma
 * ------------------------------------------------------------------------ */

describe('trauma — sustained fire escalates, and then stops', () => {
  it('starts at zero and a single shot barely moves it', () => {
    const w = new WeaponRuntime();
    expect(w.traumaLevel).toBe(0);
    expect(w.shakeGain).toBe(1);
    w.fireOnce(ctxAt(0, true));
    expect(w.traumaLevel).toBeGreaterThan(0);
    expect(w.traumaLevel).toBeLessThan(0.15);
    // Squared response: a tap must be nearly transparent.
    expect(w.shakeGain).toBeLessThan(1.03);
  });

  it('climbs under a held trigger and is bounded', () => {
    const w = new WeaponRuntime();
    w.grant(WeaponId.CHAINGUN);
    w.switchTo(WeaponId.CHAINGUN);
    run(w, 1.0, false);            // finish the switch
    run(w, 1.5, true);             // spin up, then hold
    expect(w.current).toBe(WeaponId.CHAINGUN);
    expect(w.traumaLevel).toBeGreaterThan(0.45);
    expect(w.traumaLevel).toBeLessThanOrEqual(1);
    expect(w.shakeGain).toBeGreaterThan(1.15);
    // The hard ceiling. No held trigger may ever exceed it.
    expect(w.shakeGain).toBeLessThanOrEqual(1.9);
  });

  it('bleeds back to nothing after the trigger is released', () => {
    const w = new WeaponRuntime();
    run(w, 0.6, true);
    expect(w.traumaLevel).toBeGreaterThan(0.1);
    run(w, 2.0, false);
    expect(w.traumaLevel).toBe(0);
    expect(w.shakeGain).toBe(1);
  });

  it('the amplitude the CAMERA is given grows across a burst', () => {
    const cam = recordingCamera();
    const w = new WeaponRuntime(undefined, cam);
    w.grant(WeaponId.CHAINGUN);
    w.switchTo(WeaponId.CHAINGUN);
    run(w, 1.0, false);
    cam.shakes.length = 0;
    run(w, 1.4, true);

    expect(cam.shakes.length).toBeGreaterThan(8);
    const first = cam.shakes[0];
    const last = cam.shakes[cam.shakes.length - 1];
    const base = getWeapon(WeaponId.CHAINGUN).shakeAmplitude;
    // The first round of a burst is essentially the weapon's own table value...
    expect(first).toBeGreaterThanOrEqual(base);
    expect(first).toBeLessThan(base * 1.06);
    // ...and the last is meaningfully harder, which is the whole point.
    expect(last).toBeGreaterThan(first * 1.15);
    expect(last).toBeLessThanOrEqual(base * 1.9 + 1e-6);
  });

  it('a slow heavy weapon is NOT doubled — its first round already hits', () => {
    const cam = recordingCamera();
    const w = new WeaponRuntime(undefined, cam);
    w.grant(WeaponId.SHOTGUN);
    w.switchTo(WeaponId.SHOTGUN);
    run(w, 1.0, false);
    cam.shakes.length = 0;
    // The shotgun is semi-auto: a held trigger is one shell. Pump it.
    pulse(w, 4.0, 55);

    const base = getWeapon(WeaponId.SHOTGUN).shakeAmplitude;
    expect(cam.shakes.length).toBeGreaterThan(2);
    for (const a of cam.shakes) expect(a).toBeLessThan(base * 1.25);
  });
});

/* ------------------------------------------------------------------------ *
 * "Which shot felt like it hit something"
 * ------------------------------------------------------------------------ */

describe('hit feedback', () => {
  function targetAhead(health: number): ReturnType<typeof createHitTargets> {
    const t = createHitTargets();
    /* Feet centre 2 m down -Z.
     *
     * The distance is load-bearing for the shotgun case and is chosen, not
     * guessed: the cone is 0.09 rad, so at 2 m every pellet lands inside a
     * 0.18 m radius, which fits entirely within the 0.3 m half-width and the
     * 1.42–1.8 m head box the eye ray at 1.62 m is pointed down. All seven
     * pellets therefore connect deterministically, which is what lets the
     * "one marker per shot, not one per pellet" assertion mean anything. */
    pushPlayerTarget(t, 42, 0, 0, -2, true, 7, health);
    return t;
  }

  it('a miss produces a muzzle flash and a tracer but no marker', () => {
    const fx = recordingFx();
    const w = new WeaponRuntime(fx);
    const c = ctxAt(0, true);
    w.fireOnce(c);
    expect(fx.log.muzzles).toBe(1);
    expect(fx.log.tracers).toBe(1);
    expect(fx.log.markers.length).toBe(0);
    expect(fx.log.confirms.length).toBe(0);
  });

  it('a wall hit marks the world but never the crosshair', () => {
    const fx = recordingFx();
    const w = new WeaponRuntime(fx);
    const c = ctxAt(0, true);
    c.world = wallAt(6);
    w.fireOnce(c);
    expect(fx.log.impacts).toBe(1);
    // A hit marker means "you hit a THING". Shooting scenery must not lie.
    expect(fx.log.markers.length).toBe(0);
  });

  /* A SAW AGAINST A WALL.
   *
   * The blind review that cost this piece a round named it exactly: "the blade
   * is a flat unlit silhouette that stops short of the wall in screen space so
   * it never visibly touches anything". In the code that was literally true —
   * melee traced bodies and nothing else, so a swing into stone resolved as a
   * clean miss and no hook anywhere was told that contact had happened. */
  it('a melee swing into a wall STRIKES it instead of whiffing', () => {
    const fx = recordingFx();
    const w = new WeaponRuntime(fx);
    w.grant(WeaponId.CHAINSAW);
    w.switchTo(WeaponId.CHAINSAW);
    run(w, 1.0, false);
    const c = ctxAt(0, true);
    c.world = wallAt(1.4);        // inside the 2.6 m reach
    w.fireOnce(c);

    expect(fx.log.strikes.length).toBe(1);
    expect(fx.log.misses).toBe(0);
    const s = fx.log.strikes[0];
    // On the face the ray met, 1.4 m down -Z from an eye at 1.6 m.
    expect(s.z).toBeCloseTo(-1.4, 6);
    expect(s.y).toBeCloseTo(1.6, 6);
    expect(s.power).toBeGreaterThan(0.15);
    expect(s.power).toBeLessThanOrEqual(1);
    // Scenery is not a kill: the crosshair must stay honest.
    expect(fx.log.markers.length).toBe(0);
    expect(fx.log.confirms.length).toBe(0);
  });

  it('a swing at open air is still a miss', () => {
    const fx = recordingFx();
    const w = new WeaponRuntime(fx);
    w.grant(WeaponId.CHAINSAW);
    w.switchTo(WeaponId.CHAINSAW);
    run(w, 1.0, false);
    const c = ctxAt(0, true);
    c.world = wallAt(9);          // well outside the 2.6 m reach
    w.fireOnce(c);
    expect(fx.log.strikes.length).toBe(0);
    expect(fx.log.misses).toBe(1);
  });

  it('a body in reach beats the wall behind it', () => {
    const fx = recordingFx();
    const w = new WeaponRuntime(fx);
    w.grant(WeaponId.CHAINSAW);
    w.switchTo(WeaponId.CHAINSAW);
    run(w, 1.0, false);
    const c = ctxAt(0, true);
    c.world = wallAt(2.4);
    c.targets = targetAhead(100);
    w.fireOnce(c);
    expect(fx.log.strikes.length).toBe(0);
    expect(fx.log.markers.length).toBe(1);
  });

  it('a body hit fires exactly one marker per SHOT, not one per pellet', () => {
    const fx = recordingFx();
    const w = new WeaponRuntime(fx);
    w.grant(WeaponId.SHOTGUN);
    w.switchTo(WeaponId.SHOTGUN);
    run(w, 1.0, false);

    const c = ctxAt(0, true);
    c.targets = targetAhead(0);
    c.team = 0;
    const report = w.fireOnce(c);

    expect(report.pellets).toBe(getWeapon(WeaponId.SHOTGUN).pellets);
    expect(report.hits).toBe(report.pellets);
    expect(fx.log.markers.length).toBe(1);
    expect(fx.log.markers[0].hits).toBe(report.hits);
    expect(fx.log.confirms.length).toBe(1);
  });

  it('a predicted kill is a DIFFERENT event, not a bigger hit', () => {
    const fx = recordingFx();
    const cam = recordingCamera();
    const w = new WeaponRuntime(fx, cam);
    const c = ctxAt(0, true);
    c.targets = targetAhead(1);          // one hit point: any pellet is lethal
    c.team = 0;
    const report = w.fireOnce(c);

    expect(report.connected).toBe(true);
    expect(report.kills).toBe(1);
    expect(report.lethalId).toBe(42);
    expect(fx.log.markers[0].killed).toBe(true);
    expect(fx.log.confirms[0].killed).toBe(true);
    // The kill adds a second shake source on top of the weapon's own.
    expect(cam.shakes.length).toBe(2);
  });

  it('never predicts a kill against a target of unknown health', () => {
    const fx = recordingFx();
    const w = new WeaponRuntime(fx);
    const c = ctxAt(0, true);
    c.targets = targetAhead(0);          // 0 == "the caller did not say"
    c.team = 0;
    const report = w.fireOnce(c);
    expect(report.connected).toBe(true);
    expect(report.kills).toBe(0);
    expect(fx.log.markers[0].killed).toBe(false);
  });

  it('a kill banks more trauma than the shot that produced it', () => {
    const a = new WeaponRuntime();
    a.fireOnce(ctxAt(0, true));
    const missTrauma = a.traumaLevel;

    const b = new WeaponRuntime();
    const c = ctxAt(0, true);
    c.targets = targetAhead(1);
    c.team = 0;
    b.fireOnce(c);
    expect(b.traumaLevel).toBeGreaterThan(missTrauma);
  });
});

/* ------------------------------------------------------------------------ *
 * Determinism — the server has to be able to replay this
 * ------------------------------------------------------------------------ */

describe('pellet cones are reproducible from (ownerId, shotSeq)', () => {
  it('two runtimes with the same inputs fire the same pattern', () => {
    const mk = (): WeaponRuntime => {
      const w = new WeaponRuntime();
      w.grant(WeaponId.SHOTGUN);
      w.switchTo(WeaponId.SHOTGUN);
      run(w, 1.0, false);
      return w;
    };
    const a = mk();
    const b = mk();
    const ca = ctxAt(0, true); ca.world = null;
    const cb = ctxAt(0, true); cb.world = null;

    const ra = a.fireOnce(ca);
    const dirs = Array.from(ra.dirX.slice(0, ra.pellets));
    const rb = b.fireOnce(cb);

    for (let p = 0; p < rb.pellets; p++) {
      expect(rb.dirX[p]).toBe(dirs[p]);
    }
  });

  it('a single-pellet weapon with no cone is not nudged by the rng at all', () => {
    const w = new WeaponRuntime();
    const c = ctxAt(0, true);
    c.world = null;
    // Rocket has spread 0 across the board.
    w.grant(WeaponId.ROCKET);
    w.switchTo(WeaponId.ROCKET);
    run(w, 1.2, false);
    const r = w.fireOnce(c);
    expect(r.dirX[0]).toBe(0);
    expect(r.dirY[0]).toBe(0);
    expect(r.dirZ[0]).toBe(-1);
  });
});

/* ------------------------------------------------------------------------ *
 * The viewmodel impulse table is actually per weapon
 * ------------------------------------------------------------------------ */

describe('view kick is emitted per weapon, not as one constant', () => {
  it('hands the viewmodel the firing weapon own row of the table', () => {
    const seen: number[] = [];
    const fx: WeaponFx = { viewKick(_x, _y, kz): void { seen.push(kz); } };
    const w = new WeaponRuntime(fx);

    w.fireOnce(ctxAt(0, true));
    w.grant(WeaponId.BFG);
    w.switchTo(WeaponId.BFG);
    run(w, 1.5, false);
    w.fireOnce(ctxAt(0, true));

    expect(seen.length).toBe(2);
    expect(seen[0]).toBeCloseTo(getWeapon(WeaponId.PISTOL).viewKickZ, 6);
    expect(seen[1]).toBeCloseTo(getWeapon(WeaponId.BFG).viewKickZ, 6);
    expect(seen[1]).toBeGreaterThan(seen[0] * 4);
  });
});

/* ------------------------------------------------------------------------ *
 * No allocation on the hot path
 * ------------------------------------------------------------------------ */

describe('the shot path reuses its buffers', () => {
  it('returns the same report object every time', () => {
    const w = new WeaponRuntime();
    const c = ctxAt(0, true);
    const a = w.fireOnce(c);
    const b = w.fireOnce(c);
    expect(a).toBe(b);
    expect(a).toBe(w.report);
  });

  it('a voxel hit scratch is shared, not allocated per pellet', () => {
    // Sanity on the helper the runtime uses, so the test above means something.
    const h = createVoxelHit();
    expect(typeof h.distance).toBe('number');
  });
});

/* ------------------------------------------------------------------------ *
 * A kill is the PEAK of the burst it ends
 *
 * The file's own rule, stated at the top of `emitFeedback`, is that trauma is
 * banked before the camera is driven — otherwise the shot that raised the
 * trauma is not the shot that feels it, and the first round of a burst reads
 * as the loudest. That rule was being applied to the shot and then broken for
 * the kill, which was banked one line AFTER the camera call. On an automatic
 * weapon that cost the kill one round of lag; on a single-shot weapon, where
 * there is no next round, the kill's own trauma never reached the camera at
 * all. These two tests are that ordering, measured.
 * ------------------------------------------------------------------------ */

describe('a kill is louder than the burst that produced it', () => {
  function killShot(weapon: number): { shakes: number[]; trauma: number } {
    const cam = recordingCamera();
    const w = new WeaponRuntime(recordingFx(), cam);
    if (weapon !== WeaponId.PISTOL) { w.grant(weapon); w.switchTo(weapon); run(w, 1.2, false); }
    const t = createHitTargets();
    // 1 hp: any connecting shot is fatal, so the kill path is deterministic.
    pushPlayerTarget(t, 42, 0, 0, -2, true, 7, 1);
    const c = ctxAt(0, true);
    c.targets = t;
    cam.shakes.length = 0;
    w.fireOnce(c);
    return { shakes: cam.shakes.slice(), trauma: w.traumaLevel };
  }

  function plainShot(weapon: number): { shakes: number[]; trauma: number } {
    const cam = recordingCamera();
    const w = new WeaponRuntime(recordingFx(), cam);
    if (weapon !== WeaponId.PISTOL) { w.grant(weapon); w.switchTo(weapon); run(w, 1.2, false); }
    const c = ctxAt(0, true);
    cam.shakes.length = 0;
    w.fireOnce(c);
    return { shakes: cam.shakes.slice(), trauma: w.traumaLevel };
  }

  it('the kill shake is scaled by the trauma the kill itself banked', () => {
    // One shot, one weapon, the only difference being whether it connected.
    const kill = killShot(WeaponId.PISTOL);
    const miss = plainShot(WeaponId.PISTOL);

    // The weapon's own shake is the first entry in both cases. It has to be
    // BIGGER on the killing shot, which only happens if the kill's trauma was
    // banked before the camera was driven.
    expect(kill.shakes[0]).toBeGreaterThan(miss.shakes[0]);
    expect(kill.trauma).toBeGreaterThan(miss.trauma);
  });

  it('a kill sends a second, separate jolt that a plain shot does not', () => {
    const kill = killShot(WeaponId.SHOTGUN);
    const miss = plainShot(WeaponId.SHOTGUN);
    expect(kill.shakes.length).toBe(miss.shakes.length + 1);
    expect(kill.shakes[kill.shakes.length - 1]).toBeGreaterThan(0);
  });

  it('bare hits still do not shake — only kills do', () => {
    const cam = recordingCamera();
    const w = new WeaponRuntime(recordingFx(), cam);
    const t = createHitTargets();
    pushPlayerTarget(t, 42, 0, 0, -2, true, 7, 400);   // will not die
    const c = ctxAt(0, true);
    c.targets = t;
    cam.shakes.length = 0;
    w.fireOnce(c);
    // Exactly one shake: the weapon's. A connecting chaingun burst must not
    // become one continuous rumble with no room left for the kill.
    expect(cam.shakes.length).toBe(1);
  });
});

describe('the shot report hands its COVERAGE to the effects layer', () => {
  /*
   * `Fx.hitConfirm` grades a burst on how much of it landed — that is the only
   * input that separates a shotgun that put all seven pellets into a demon at
   * range from one that clipped it with a single pellet, because falloff can
   * take both to the same damage number. The grade is worthless if the runtime
   * does not report the pair, and reporting it is this file's job.
   *
   * Read off the CONFIRM call, not off the report: the report is the runtime
   * agreeing with itself, and the confirm is what a consumer receives.
   */
  it('reports hits and pellets on the confirm, not just on the report', () => {
    const fx = recordingFx();
    const w = new WeaponRuntime(fx);
    w.grant(WeaponId.SHOTGUN);
    w.current = WeaponId.SHOTGUN;
    const t = createHitTargets();
    // 2 m: the shotgun's 0.09 rad cone lands every pellet inside the body box,
    // so `hits` must equal `pellets` and a short count is a real regression
    // rather than a stray pellet.
    pushPlayerTarget(t, 42, 0, 0, -2, true, 7, 1e6);
    const c = ctxAt(0, true);
    c.targets = t;
    const report = w.fireOnce(c);

    expect(report.pellets, 'the shotgun has to be firing a burst at all')
      .toBeGreaterThan(1);
    expect(fx.log.confirms.length, 'one confirm per shot').toBe(1);
    expect(fx.log.confirms[0].hits, 'the confirm was handed the landed count')
      .toBe(report.hits);
    expect(fx.log.confirms[0].pellets, 'and the burst size to measure it against')
      .toBe(report.pellets);
    expect(fx.log.confirms[0].hits, 'every pellet lands at 2 m, or this proves nothing')
      .toBe(report.pellets);
  });
});
