/**
 * GUNFEEL — the viewmodel, measured against the bar's exact failure.
 *
 * `ref/BAR.md` weakness #2 is not an impression, it is a measurement: across
 * 1.2 s of continuous mouselook in `ref/voxiom/desktop-gameplay.webm` the bar's
 * held item does not move ONE PIXEL relative to the camera. Every test in the
 * first block below is that measurement run against us, in reverse — the
 * quantity the bar leaves at zero has to be non-zero here, and by an amount a
 * player can see rather than by a float epsilon.
 *
 * The second block is the harder claim, and the one the piece is judged on:
 * that a shot which HIT reads differently from a shot which missed, and that a
 * KILL reads differently again — not louder, different.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Viewmodel, createViewmodelInput, type ViewmodelInput } from './viewmodel';
import { WeaponId } from '@shared/weapons';

const FRAME = 1 / 60;

interface Pose { x: number; y: number; z: number; rx: number; ry: number; rz: number }

function poseOf(vm: Viewmodel): Pose {
  return {
    x: vm.root.position.x, y: vm.root.position.y, z: vm.root.position.z,
    rx: vm.root.rotation.x, ry: vm.root.rotation.y, rz: vm.root.rotation.z,
  };
}

/** Largest single-axis difference between two poses, positional and angular. */
function poseDelta(a: Pose, b: Pose): { pos: number; rot: number } {
  return {
    pos: Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z)),
    rot: Math.max(Math.abs(a.rx - b.rx), Math.abs(a.ry - b.ry), Math.abs(a.rz - b.rz)),
  };
}

/** A viewmodel settled at rest with `weapon` in hand. */
function settled(weapon: number = WeaponId.PISTOL, motionScale = 1): {
  vm: Viewmodel; input: ViewmodelInput; rest: Pose;
} {
  const vm = new Viewmodel({ fov: 68, motionScale });
  vm.setWeapon(weapon, true);
  const input = createViewmodelInput();
  for (let i = 0; i < 180; i++) vm.update(FRAME, input);
  return { vm, input, rest: poseOf(vm) };
}

/**
 * A matched PAIR of viewmodels, stepped in lockstep with identical input.
 *
 * The model is never actually motionless — it has an idle breath of about two
 * millimetres, which is deliberate and is itself part of beating a bar whose
 * weapon is welded to the camera. That breath makes "compare against the pose
 * you saw earlier" a broken measurement: the drift is real motion, not error.
 * So anything that has to isolate ONE event measures the difference between a
 * viewmodel that got the event and an identical one that did not, at the same
 * moment in the same idle cycle.
 */
function pair(weapon: number = WeaponId.PISTOL): {
  a: Viewmodel; b: Viewmodel; input: ViewmodelInput; step(): void; diff(): { pos: number; rot: number };
} {
  const mk = (): Viewmodel => {
    const vm = new Viewmodel({ fov: 68 });
    vm.setWeapon(weapon, true);
    return vm;
  };
  const a = mk();
  const b = mk();
  const input = createViewmodelInput();
  const step = (): void => { a.update(FRAME, input); b.update(FRAME, input); };
  for (let i = 0; i < 180; i++) step();
  return { a, b, input, step, diff: () => poseDelta(poseOf(a), poseOf(b)) };
}

/** The RawShaderMaterial the weapon body is drawn with. */
function bodyMaterial(vm: Viewmodel): THREE.RawShaderMaterial {
  let found: THREE.RawShaderMaterial | null = null;
  vm.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const mat = mesh.material as THREE.RawShaderMaterial | undefined;
    if (found === null && mat !== undefined && mat.uniforms?.uKill !== undefined) found = mat;
  });
  if (found === null) throw new Error('no viewmodel body material');
  return found;
}

function killTint(vm: Viewmodel): THREE.Vector3 {
  return bodyMaterial(vm).uniforms.uKill.value as THREE.Vector3;
}

/* ------------------------------------------------------------------------ *
 * The bar's measurement, run in reverse
 * ------------------------------------------------------------------------ */

describe('the weapon is not a decal', () => {
  it('moves under continuous mouselook, where the bar moves zero pixels', () => {
    const { vm, input, rest } = settled();
    // 1.2 seconds of steady turning, exactly the window BAR.md measured.
    let moved = 0;
    for (let i = 0; i < 72; i++) {
      input.yaw += 0.05;
      input.pitch = Math.sin(i * 0.09) * 0.25;
      vm.update(FRAME, input);
      const d = poseDelta(poseOf(vm), rest);
      moved = Math.max(moved, Math.max(d.pos, d.rot));
    }
    // A centimetre or a hundredth of a radian is the floor for "visible".
    expect(moved).toBeGreaterThan(0.01);
  });

  it('breathes at a stand and BOBS at a run, and the two are far apart', () => {
    const { vm, input, rest } = settled();
    let still = 0;
    for (let i = 0; i < 120; i++) {
      vm.update(FRAME, input);
      still = Math.max(still, poseDelta(poseOf(vm), rest).pos);
    }
    // An idle breath, not a hold: the bar's weapon is welded to the camera and
    // this one is not, even standing still. Small enough not to be noise.
    expect(still).toBeGreaterThan(1e-4);
    expect(still).toBeLessThan(0.012);

    input.speed = 9.5;
    input.grounded = true;
    let walking = 0;
    for (let i = 0; i < 90; i++) {
      vm.update(FRAME, input);
      walking = Math.max(walking, poseDelta(poseOf(vm), rest).pos);
    }
    expect(walking).toBeGreaterThan(still * 2.5);
    expect(walking).toBeGreaterThan(0.02);
  });

  it('kicks when it fires and returns to exactly where it was', () => {
    const p = pair();
    p.a.fire();
    let peak = 0;
    for (let i = 0; i < 8; i++) {
      p.step();
      peak = Math.max(peak, p.diff().rot);
    }
    /* 0.005 rad. At the viewmodel's own 32-degree lens over a 900 px canvas
     * that is about six pixels of muzzle travel on the pistol — the LIGHTEST
     * row in the table — against a bar measured at zero. */
    expect(peak).toBeGreaterThan(0.005);

    for (let i = 0; i < 240; i++) p.step();
    const back = p.diff();
    expect(back.pos).toBeLessThan(1e-5);
    expect(back.rot).toBeLessThan(1e-5);
  });

  it('kicks by the FIRING weapon amount, not by one house constant', () => {
    const peakOf = (weapon: number): number => {
      const p = pair(weapon);
      p.a.fire(weapon);
      let peak = 0;
      for (let i = 0; i < 10; i++) {
        p.step();
        peak = Math.max(peak, p.diff().rot);
      }
      return peak;
    };
    const pistol = peakOf(WeaponId.PISTOL);
    const bfg = peakOf(WeaponId.BFG);
    expect(pistol).toBeGreaterThan(0.005);
    // viewKickPitch runs 0.045 -> 0.260 across those two rows of the table.
    expect(bfg).toBeGreaterThan(pistol * 2.5);
  });

  it('motionScale 0 pins it, which is the accessibility contract', () => {
    const { vm, input, rest } = settled(WeaponId.SHOTGUN, 0);
    vm.fire();
    let moved = 0;
    for (let i = 0; i < 40; i++) {
      input.yaw += 0.06;
      input.speed = 9;
      vm.update(FRAME, input);
      moved = Math.max(moved, poseDelta(poseOf(vm), rest).pos);
    }
    expect(moved).toBeLessThan(1e-6);
  });
});

/* ------------------------------------------------------------------------ *
 * Which shot felt like it hit something
 * ------------------------------------------------------------------------ */

describe('the hands know whether the shot landed', () => {
  /** Pitch of the model one frame after firing, with an optional confirm. */
  function firstFramePitch(confirm: null | { strength: number; killed: boolean }): number {
    const { vm, input, rest } = settled();
    vm.fire();
    if (confirm !== null) vm.hitConfirm(confirm.strength, confirm.killed);
    vm.update(FRAME, input);
    return vm.root.rotation.x - rest.rx;
  }

  it('a hit is a different motion from a miss', () => {
    const miss = firstFramePitch(null);
    const hit = firstFramePitch({ strength: 1, killed: false });
    expect(Math.abs(hit - miss)).toBeGreaterThan(0.002);
  });

  it('a KILL is not a bigger hit — it starts in the OPPOSITE direction', () => {
    /* This is the whole design claim, and it is the one thing amplitude can
     * never buy. The hit jolt drives the muzzle DOWN and forward into what it
     * struck; the kill jolt brings the nose UP and rolls the gun out. On a
     * spring, two impulses of opposite sign are distinguishable inside three
     * frames at 60 Hz, where two impulses of the same sign and different size
     * are just "that one felt stronger". */
    const miss = firstFramePitch(null);
    const hit = firstFramePitch({ strength: 1, killed: false }) - miss;
    const kill = firstFramePitch({ strength: 1, killed: true }) - miss;

    expect(hit).not.toBe(0);
    expect(kill).not.toBe(0);
    expect(Math.sign(hit)).toBe(-Math.sign(kill));
  });

  it('a kill flares the weapon in COLOUR; a hit does not', () => {
    const { vm, input } = settled();
    expect(killTint(vm).length()).toBe(0);

    vm.hitConfirm(1, false);
    vm.update(FRAME, input);
    expect(killTint(vm).length()).toBe(0);

    vm.hitConfirm(1, true);
    vm.update(FRAME, input);
    const t = killTint(vm);
    expect(t.length()).toBeGreaterThan(0);
    // Hot amber, so it cannot be confused with the achromatic hit pop.
    expect(t.x).toBeGreaterThan(t.y);
    expect(t.y).toBeGreaterThan(t.z);
  });

  it('the kill flare fades out on its own', () => {
    const { vm, input } = settled();
    vm.hitConfirm(1, true);
    vm.update(FRAME, input);
    expect(killTint(vm).length()).toBeGreaterThan(0);
    for (let i = 0; i < 120; i++) vm.update(FRAME, input);
    expect(killTint(vm).length()).toBe(0);
  });

  it('the kill glow outlasts the hit glow — duration is what reads as different', () => {
    const framesLit = (killed: boolean): number => {
      const { vm, input } = settled();
      vm.hitConfirm(1, killed);
      const mat = bodyMaterial(vm);
      const base = mat.uniforms.uBright.value as number;
      let n = 0;
      for (let i = 0; i < 200; i++) {
        vm.update(FRAME, input);
        if ((mat.uniforms.uBright.value as number) > base * 1.02) n++;
      }
      return n;
    };
    expect(framesLit(true)).toBeGreaterThan(framesLit(false) * 2);
  });

  it('a graze does not confirm as hard as a slug', () => {
    const { vm: a, input: ia, rest: ra } = settled();
    a.hitConfirm(0.2, false);
    a.update(FRAME, ia);
    const graze = Math.abs(a.root.rotation.x - ra.rx);

    const { vm: b, input: ib, rest: rb } = settled();
    b.hitConfirm(1.0, false);
    b.update(FRAME, ib);
    const slug = Math.abs(b.root.rotation.x - rb.rx);

    expect(slug).toBeGreaterThan(graze * 2);
  });

  it('a confirm on a hidden viewmodel is dropped, not banked', () => {
    const p = pair();
    p.a.setEnabled(false);
    p.a.hitConfirm(1, true);
    p.a.setEnabled(true);
    for (let i = 0; i < 10; i++) p.step();
    expect(p.diff().rot).toBeLessThan(1e-9);
    expect(killTint(p.a).length()).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Stability
 * ------------------------------------------------------------------------ */

describe('the kick spring cannot run away', () => {
  it('survives an unbroken burst of the heaviest weapon', () => {
    const { vm, input } = settled(WeaponId.BFG);
    for (let i = 0; i < 240; i++) {
      vm.fire(WeaponId.BFG);
      vm.hitConfirm(1, i % 3 === 0);
      vm.update(FRAME, input);
      expect(Number.isFinite(vm.root.position.x)).toBe(true);
      expect(Math.abs(vm.root.rotation.x)).toBeLessThan(2);
    }
  });

  it('survives a 250 ms frame hitch without exploding', () => {
    const p = pair(WeaponId.ROCKET);
    p.a.fire(WeaponId.ROCKET);
    p.a.update(0.25, p.input);
    p.b.update(0.25, p.input);
    expect(Number.isFinite(p.a.root.position.y)).toBe(true);
    for (let i = 0; i < 300; i++) p.step();
    expect(p.diff().rot).toBeLessThan(1e-5);
  });
});
