/**
 * GUNFEEL — the world-side effects, measured.
 *
 * `ref/BAR.md` weakness #2: in the bar, a shot changes nothing on screen except
 * ammo. The claim this file has to defend is the opposite one — that a shot
 * produces a light you can see, a mark that stays, and sparks whose colour
 * tells you what you just hit. Each of those is a number here, not a vibe.
 *
 * Three assertions in particular exist because the code was WRONG in a way no
 * screenshot review caught:
 *   - a 45 ms point light whose fade starts at t=0 is already 42 % faded on the
 *     first frame that can display it, and gone by the third;
 *   - trauma banked without an accompanying amplitude moved the camera zero
 *     millimetres, so the kill shake in `hitConfirm` was a no-op;
 *   - every `addShake` jumped trauma to at least 0.5, which is a quarter of
 *     full violence for a pistol tap.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Fx } from './fx';
import type { VoxelMaterials } from './material';
import { WeaponId, getWeapon } from '@shared/weapons';
import { BlockId, Face, blockFaceColor, blockFaceShaded } from '@shared/blocks';

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

interface PushedLight {
  x: number; y: number; z: number;
  r: number; g: number; b: number;
  radius: number; intensity: number;
}

/** Stands in for VoxelMaterials as a light sink and records what it is given. */
function lightSink(): { lights: PushedLight[]; frames: PushedLight[][]; sink: VoxelMaterials } {
  const lights: PushedLight[] = [];
  const frames: PushedLight[][] = [];
  let current: PushedLight[] = [];
  const sink = {
    beginLights(): void { current = []; },
    pushLight(
      x: number, y: number, z: number,
      r: number, g: number, b: number,
      radius: number, intensity: number,
    ): boolean {
      const l = { x, y, z, r, g, b, radius, intensity };
      current.push(l);
      lights.push(l);
      return true;
    },
    endLights(): void { frames.push(current); },
  };
  return { lights, frames, sink: sink as unknown as VoxelMaterials };
}

function makeFx(): { fx: Fx; scene: THREE.Scene; camera: THREE.PerspectiveCamera } {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(68, 16 / 9, 0.1, 400);
  camera.position.set(0, 1.6, 0);
  camera.updateMatrixWorld(true);
  const fx = new Fx(scene);
  fx.setViewportHeight(900);
  return { fx, scene, camera };
}

const FRAME = 1 / 60;

/** The instanced colour buffer of one of the fx pools, by material name. */
function instanceColors(fx: Fx, materialName: string): Float32Array {
  for (const child of fx.group.children) {
    const mesh = child as THREE.Mesh;
    const mat = mesh.material as THREE.Material;
    if (mat.name === materialName) {
      const attr = mesh.geometry.getAttribute('iColor') as THREE.BufferAttribute;
      return attr.array as Float32Array;
    }
  }
  throw new Error(`no fx pool named ${materialName}`);
}

/** Mean colour of the first `n` live instances of a pool. */
function meanColor(buf: Float32Array, n: number): [number, number, number] {
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < n; i++) { r += buf[i * 3]; g += buf[i * 3 + 1]; b += buf[i * 3 + 2]; }
  return [r / n, g / n, b / n];
}

/* ------------------------------------------------------------------------ *
 * The muzzle flash is a real light
 * ------------------------------------------------------------------------ */

describe('point lights', () => {
  it('a held light is at FULL intensity on the frame after it is spawned', () => {
    const { fx, camera } = makeFx();
    const rec = lightSink();
    fx.setLightSink(rec.sink);

    fx.addLight(0, 2, -3, 1, 1, 1, 6, 2.0, 0.075, 0.45);
    fx.update(FRAME, camera);

    expect(rec.frames.length).toBe(1);
    expect(rec.frames[0].length).toBe(1);
    expect(rec.frames[0][0].intensity).toBeCloseTo(2.0, 5);
  });

  it('an UNHELD light of the same life is already well down on that frame', () => {
    const { fx, camera } = makeFx();
    const rec = lightSink();
    fx.setLightSink(rec.sink);

    fx.addLight(0, 2, -3, 1, 1, 1, 6, 2.0, 0.075, 0);
    fx.update(FRAME, camera);

    // (1 - 16.7/75)^2 = 0.60 of what it should be showing. This is the exact
    // shape of the bug: the light existed and was never seen.
    expect(rec.frames[0][0].intensity).toBeLessThan(2.0 * 0.7);
  });

  it('the hold ends and the light does go out', () => {
    const { fx, camera } = makeFx();
    const rec = lightSink();
    fx.setLightSink(rec.sink);

    fx.addLight(0, 2, -3, 1, 1, 1, 6, 2.0, 0.075, 0.45);
    for (let i = 0; i < 8; i++) fx.update(FRAME, camera);
    expect(fx.stats.lights).toBe(0);
  });

  it('a muzzle flash publishes a light that survives at least four frames', () => {
    const { fx, camera } = makeFx();
    const rec = lightSink();
    fx.setLightSink(rec.sink);

    // The chaingun is the worst case: a 32 ms flash is under two frames.
    fx.muzzleFlash(0, 1.6, -0.7, 0, 0, -1, WeaponId.CHAINGUN);
    let litFrames = 0;
    for (let i = 0; i < 6; i++) {
      fx.update(FRAME, camera);
      if (rec.frames[i].length > 0) litFrames++;
    }
    expect(litFrames).toBeGreaterThanOrEqual(4);
  });

  it('the flash light is HOTTER than the plume it came from', () => {
    const { fx, camera } = makeFx();
    const rec = lightSink();
    fx.setLightSink(rec.sink);

    // The plasma rifle's muzzle colour is a saturated blue, 0x8cd8ff.
    fx.muzzleFlash(0, 1.6, -0.7, 0, 0, -1, WeaponId.PLASMA);
    fx.update(FRAME, camera);
    const l = rec.frames[0][0];
    const def = getWeapon(WeaponId.PLASMA);
    const plumeR = ((def.muzzleColor >>> 16) & 0xff) / 255;
    // Light is dragged toward white, so its weakest channel beats the plume's.
    expect(l.r).toBeGreaterThan(plumeR);
    expect(l.intensity).toBeGreaterThan(def.muzzleIntensity);
  });

  it('never publishes more than the shader has slots for', () => {
    const { fx, camera } = makeFx();
    fx.setLightSink(lightSink().sink);
    for (let i = 0; i < 40; i++) fx.addLight(i, 2, -3, 1, 1, 1, 6, 1 + i * 0.01, 0.5, 0.3);
    fx.update(FRAME, camera);
    expect(fx.stats.lights).toBeLessThanOrEqual(12);
  });
});

/* ------------------------------------------------------------------------ *
 * The impact tells you what you hit
 * ------------------------------------------------------------------------ */

describe('impact inherits the surface', () => {
  const RED = 0xd03018;
  const BLUE = 0x1830d0;

  it('the bounce light is tinted by the material that was struck', () => {
    const shoot = (color: number): PushedLight => {
      const { fx, camera } = makeFx();
      const rec = lightSink();
      fx.setLightSink(rec.sink);
      fx.update(FRAME, camera);              // prime the camera cache
      fx.impact(0, 1.6, -6, 0, 0, 1, color, 1);
      fx.update(FRAME, camera);
      const lit = rec.frames[1];
      expect(lit.length).toBeGreaterThan(0);
      return lit[0];
    };
    const red = shoot(RED);
    const blue = shoot(BLUE);
    expect(red.r).toBeGreaterThan(red.b);
    expect(blue.b).toBeGreaterThan(blue.r);
  });

  it('the sparks carry the hue, not a fixed orange', () => {
    const sparkMean = (color: number): [number, number, number] => {
      const { fx, camera } = makeFx();
      fx.update(FRAME, camera);
      fx.impact(0, 1.6, -6, 0, 0, 1, color, 1);
      fx.update(FRAME, camera);
      return meanColor(instanceColors(fx, 'fx-sparks'), fx.stats.sparks);
    };
    const red = sparkMean(RED);
    const blue = sparkMean(BLUE);

    expect(red[0]).toBeGreaterThan(red[2]);
    expect(blue[2]).toBeGreaterThan(blue[0]);
    // And the separation has to be big enough to SEE, not merely non-zero.
    expect(red[0] - blue[0]).toBeGreaterThan(0.15);
    expect(blue[2] - red[2]).toBeGreaterThan(0.15);
  });

  it('leaves a mark that outlives the sparks', () => {
    const { fx, camera } = makeFx();
    fx.update(FRAME, camera);
    fx.impact(0, 1.6, -6, 0, 0, 1, RED, 1);
    for (let i = 0; i < 60; i++) fx.update(FRAME, camera);   // one second
    expect(fx.stats.sparks).toBe(0);
    expect(fx.stats.decals).toBe(1);
  });

  it('one shotgun blast does not spend seven light slots on one wall', () => {
    const { fx, camera } = makeFx();
    fx.setLightSink(lightSink().sink);
    fx.update(FRAME, camera);
    // Seven pellets inside a metre of each other, same frame.
    for (let p = 0; p < 7; p++) {
      fx.impact(p * 0.12, 1.6, -6, 0, 0, 1, RED, 1);
    }
    fx.update(FRAME, camera);
    expect(fx.stats.lights).toBe(1);
  });

  it('two aimed shots at different walls each get their own light', () => {
    const { fx, camera } = makeFx();
    fx.setLightSink(lightSink().sink);
    fx.update(FRAME, camera);
    fx.impact(0, 1.6, -6, 0, 0, 1, RED, 1);
    fx.impact(9, 1.6, -6, 0, 0, 1, RED, 1);
    fx.update(FRAME, camera);
    expect(fx.stats.lights).toBe(2);
  });
});

/* ------------------------------------------------------------------------ *
 * Tracers
 * ------------------------------------------------------------------------ */

describe('tracers', () => {
  it('a shot leaves a streak that travels and then expires', () => {
    const { fx, camera } = makeFx();
    fx.tracer(0, 1.6, 0, 0, 1.6, -40, 0xffe0a0);
    fx.update(FRAME, camera);
    expect(fx.stats.tracers).toBe(1);
    for (let i = 0; i < 120; i++) fx.update(FRAME, camera);
    expect(fx.stats.tracers).toBe(0);
  });

  it('a zero-length streak is rejected rather than dividing by zero', () => {
    const { fx, camera } = makeFx();
    fx.tracer(1, 1, 1, 1, 1, 1, 0xffffff);
    fx.update(FRAME, camera);
    expect(fx.stats.tracers).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Trauma-based screen shake
 * ------------------------------------------------------------------------ */

describe('screen shake', () => {
  it('does nothing at all when nothing has happened', () => {
    const { fx, camera } = makeFx();
    fx.setShakeScale(1);
    const before = camera.position.clone();
    fx.update(FRAME, camera);
    fx.applyShake(camera);
    expect(camera.position.distanceTo(before)).toBe(0);
  });

  it('trauma banked on its own still MOVES the camera', () => {
    // The kill shake in hitConfirm banks trauma and no amplitude. Before the
    // amplitude floor was added, that multiplied out to exactly zero pixels.
    const { fx, camera } = makeFx();
    fx.setShakeScale(1);
    fx.addTrauma(0.6);
    fx.update(FRAME, camera);
    const before = camera.position.clone();
    fx.applyShake(camera);
    expect(camera.position.distanceTo(before)).toBeGreaterThan(1e-4);
  });

  it('a light source does not slam trauma to half', () => {
    const { fx, camera } = makeFx();
    fx.addShake(0.02, 60, 30);
    fx.update(0, camera);
    expect(fx.stats.trauma).toBeLessThan(0.15);
  });

  it('a heavy source banks far more than a light one', () => {
    const light = makeFx();
    light.fx.addShake(0.05, 60, 34);
    light.fx.update(0, light.camera);

    const heavy = makeFx();
    heavy.fx.addShake(0.90, 420, 15);
    heavy.fx.update(0, heavy.camera);

    expect(heavy.fx.stats.trauma).toBeGreaterThan(light.fx.stats.trauma * 3);
  });

  it('bleeds off and stops', () => {
    const { fx, camera } = makeFx();
    fx.setShakeScale(1);
    fx.addShake(0.3, 140, 26);
    for (let i = 0; i < 60; i++) fx.update(FRAME, camera);
    expect(fx.stats.trauma).toBe(0);
    const before = camera.position.clone();
    fx.applyShake(camera);
    expect(camera.position.distanceTo(before)).toBe(0);
  });

  it('the accessibility scale of 0 is an absolute off switch', () => {
    const { fx, camera } = makeFx();
    fx.setShakeScale(0);
    fx.addShake(0.9, 420, 15);
    fx.update(FRAME, camera);
    const p = camera.position.clone();
    const q = camera.quaternion.clone();
    fx.applyShake(camera);
    expect(camera.position.distanceTo(p)).toBe(0);
    expect(camera.quaternion.angleTo(q)).toBe(0);
  });

  it('the angular shake is a rotation about the camera own axes at any pitch', () => {
    /* Regression: the roll used to be written into `camera.rotation.z`, which
     * three-js decomposes in XYZ order, while PlayerCamera composes the view in
     * YXZ. Adding a roll to the Z term of the wrong-order euler and recomposing
     * yaws the view, and the error grows with pitch — so shaking while looking
     * up drifted your aim. Composed as a local quaternion it cannot: the same
     * shake applied to a level camera and to a pitched one must turn each by
     * the same ANGLE. */
    const rot = (pitch: number): number => {
      const { fx, camera } = makeFx();
      camera.rotation.order = 'YXZ';
      camera.rotation.set(pitch, 0.7, 0);
      camera.updateMatrixWorld(true);
      fx.setShakeScale(1);
      fx.addShake(0.5, 200, 20);
      fx.update(FRAME, camera);
      const q = camera.quaternion.clone();
      fx.applyShake(camera);
      return camera.quaternion.angleTo(q);
    };
    const level = rot(0);
    const steep = rot(1.3);
    expect(level).toBeGreaterThan(1e-5);
    expect(steep).toBeCloseTo(level, 6);
  });
});

/* ------------------------------------------------------------------------ *
 * Housekeeping
 * ------------------------------------------------------------------------ */

describe('pools', () => {
  it('clear() empties everything', () => {
    const { fx, camera } = makeFx();
    fx.update(FRAME, camera);
    fx.impact(0, 1.6, -6, 0, 0, 1, 0x808080, 1);
    fx.tracer(0, 1.6, 0, 0, 1.6, -20, 0xffffff);
    fx.update(FRAME, camera);
    expect(fx.stats.sparks).toBeGreaterThan(0);

    fx.clear();
    fx.update(FRAME, camera);
    expect(fx.stats.sparks).toBe(0);
    expect(fx.stats.debris).toBe(0);
    expect(fx.stats.tracers).toBe(0);
    expect(fx.stats.decals).toBe(0);
    expect(fx.stats.lights).toBe(0);
  });

  it('survives far more impacts than its pools hold', () => {
    const { fx, camera } = makeFx();
    fx.update(FRAME, camera);
    for (let i = 0; i < 400; i++) {
      fx.impact((i % 20) - 10, 1.6, -6 - (i % 7), 0, 0, 1, 0x40a060, 1);
      if (i % 8 === 0) fx.update(FRAME, camera);
    }
    fx.update(FRAME, camera);
    expect(fx.stats.sparks).toBeLessThanOrEqual(512);
    expect(fx.stats.decals).toBeLessThanOrEqual(96);
  });
});

/* ------------------------------------------------------------------------ *
 * Impact AT THE POINT OF CONTACT
 * ------------------------------------------------------------------------ *
 *
 * The measured failure this section defends against, from a blind review of a
 * twelve-frame swing: "renders no impact at the point of contact — across all
 * twelve frames the targeted block face is byte-for-byte unchanged: no crack
 * stage, no dust, no light, no decal ... the only break evidence is four voxel
 * cubes hovering up and right of the crosshair, at a visibly different depth
 * from the aim point, in the wrong colour for the grey stone they came from."
 *
 * Three claims, three numbers: the light lands ON the face, the face degrades
 * across the swing, and the debris is the colour of the wall it came off.
 */

const STONE_FACE_SHADED = [Face.PY, Face.PX, Face.PZ].map((f) => blockFaceShaded(BlockId.STONE, f));

describe('a tool strike lands ON the block, not near it', () => {
  it('puts its light at the contact point, not at the block centre', () => {
    const { fx, camera } = makeFx();
    const rec = lightSink();
    fx.setLightSink(rec.sink);
    fx.update(FRAME, camera);

    // The +Z face of the block occupying [4,5] x [1,2] x [-6,-5]: contact at
    // z = -5, block centre at z = -5.5.
    fx.blockStrike(4.5, 1.5, -5, 0, 0, 1, BlockId.STONE, 0.5);
    fx.update(FRAME, camera);

    expect(rec.frames[1].length).toBe(1);
    const l = rec.frames[1][0];
    // In front of the face, within a quarter metre of it — never behind it and
    // never at the middle of the block.
    expect(l.z).toBeGreaterThan(-5);
    expect(l.z).toBeLessThan(-4.7);
    expect(Math.hypot(l.x - 4.5, l.y - 1.5)).toBeLessThan(0.05);
  });

  it('is a SHORT light — 60-80 ms, gone within five frames', () => {
    const { fx, camera } = makeFx();
    const rec = lightSink();
    fx.setLightSink(rec.sink);
    fx.update(FRAME, camera);
    fx.blockStrike(4.5, 1.5, -5, 0, 0, 1, BlockId.STONE, 0.5);

    fx.update(FRAME, camera);
    expect(rec.frames[1].length).toBe(1);
    for (let i = 0; i < 5; i++) fx.update(FRAME, camera);
    expect(rec.frames[rec.frames.length - 1].length).toBe(0);
  });

  it('throws dust that outlives the light, so the puff is catchable', () => {
    const { fx, camera } = makeFx();
    fx.update(FRAME, camera);
    fx.blockStrike(4.5, 1.5, -5, 0, 0, 1, BlockId.STONE, 0.5);
    fx.update(FRAME, camera);
    expect(fx.stats.sparks).toBeGreaterThan(2);
    // Five frames on, the light is out and the dust is still in the air.
    for (let i = 0; i < 5; i++) fx.update(FRAME, camera);
    expect(fx.stats.sparks).toBeGreaterThan(0);
  });
});

describe('the wall degrades across the swing', () => {
  it('the first strike is already visible, and further strikes deepen it', () => {
    const { fx, camera } = makeFx();
    fx.update(FRAME, camera);

    expect(fx.crackStage(4, 1, -6, Face.PZ)).toBe(0);
    fx.blockStrike(4.5, 1.5, -5, 0, 0, 1, BlockId.STONE, 0.4);
    const first = fx.crackStage(4, 1, -6, Face.PZ);
    // A crack that opens at nothing is a crack nobody sees on the frame that
    // matters — the first frame of contact.
    expect(first).toBeGreaterThan(0.2);

    fx.blockStrike(4.5, 1.5, -5, 0, 0, 1, BlockId.STONE, 0.4);
    const second = fx.crackStage(4, 1, -6, Face.PZ);
    expect(second).toBeGreaterThan(first);

    for (let i = 0; i < 8; i++) fx.blockStrike(4.5, 1.5, -5, 0, 0, 1, BlockId.STONE, 0.4);
    expect(fx.crackStage(4, 1, -6, Face.PZ)).toBe(1);
  });

  it('advances ONE overlay per face rather than stacking sprites', () => {
    const { fx, camera } = makeFx();
    fx.update(FRAME, camera);
    for (let i = 0; i < 12; i++) fx.blockStrike(4.5, 1.5, -5, 0, 0, 1, BlockId.STONE, 0.3);
    fx.update(FRAME, camera);
    expect(fx.stats.cracks).toBe(1);
  });

  it('a bullet bites the face too, so nine rounds into a wall show', () => {
    const { fx, camera } = makeFx();
    fx.update(FRAME, camera);
    for (let i = 0; i < 4; i++) {
      fx.impact(4.5, 1.5, -5, 0, 0, 1, 0x8b8d92, 1, BlockId.STONE);
    }
    expect(fx.crackStage(4, 1, -6, Face.PZ)).toBeGreaterThan(0.3);
  });

  it('does NOT crack anything when the caller did not say what was hit', () => {
    const { fx, camera } = makeFx();
    fx.update(FRAME, camera);
    fx.impact(4.5, 1.5, -5, 0, 0, 1, 0x8b8d92, 1);
    fx.update(FRAME, camera);
    expect(fx.stats.cracks).toBe(0);
  });

  it('takes its cracks with it when the block goes', () => {
    const { fx, camera } = makeFx();
    fx.update(FRAME, camera);
    fx.blockStrike(4.5, 1.5, -5, 0, 0, 1, BlockId.STONE, 0.4);
    fx.blockStrike(5, 1.5, -5.5, 1, 0, 0, BlockId.STONE, 0.4);
    fx.update(FRAME, camera);
    expect(fx.stats.cracks).toBe(2);

    fx.blockBreak(4, 1, -6, BlockId.STONE);
    fx.update(FRAME, camera);
    expect(fx.stats.cracks).toBe(0);
  });

  it('retires a crack whose block was removed by someone else', () => {
    const { fx, camera } = makeFx();
    let solid = true;
    fx.setCollider(() => solid);
    fx.update(FRAME, camera);
    fx.blockStrike(4.5, 1.5, -5, 0, 0, 1, BlockId.STONE, 0.4);
    fx.update(FRAME, camera);
    expect(fx.stats.cracks).toBe(1);

    solid = false;
    // The sweep runs at 10 Hz, so give it a tenth of a second.
    for (let i = 0; i < 8; i++) fx.update(FRAME, camera);
    expect(fx.stats.cracks).toBe(0);
  });
});

describe('debris is the wall coming apart', () => {
  it('carries the SHADED face colours of the block, not its raw albedo', () => {
    const { fx, camera } = makeFx();
    fx.update(FRAME, camera);
    fx.blockBreak(4, 1, -6, BlockId.STONE);
    fx.update(FRAME, camera);

    const n = fx.stats.debris;
    expect(n).toBeGreaterThan(8);
    const [r, g, b] = meanColor(instanceColors(fx, 'fx-debris'), n);

    // Every chip must be inside the span of the six face colours the mesher
    // actually paints, give or take the facet jitter. The raw top albedo alone
    // (0.545 for stone) sits ABOVE that span, which is what made the old chips
    // read as foreign geometry rather than as this wall.
    const shades = STONE_FACE_SHADED.map((c) => ((c >>> 16) & 0xff) / 255);
    const lo = Math.min(...shades), hi = Math.max(...shades);
    expect(r).toBeGreaterThan(lo * 0.85);
    expect(r).toBeLessThan(hi * 1.18);
    // Stone is grey: the chips must stay grey.
    expect(Math.abs(r - g)).toBeLessThan(0.05);
    expect(Math.abs(b - g)).toBeLessThan(0.05);

    // And it must be DARKER than the flat top albedo the old code used for
    // every chip, because most of a cube's faces are side faces.
    const rawTop = ((blockFaceColor(BlockId.STONE, Face.PY) >>> 16) & 0xff) / 255;
    expect(r).toBeLessThan(rawTop * 0.95);
  });

  it('the break itself puffs and lights at the face that was worked', () => {
    const { fx, camera } = makeFx();
    const rec = lightSink();
    fx.setLightSink(rec.sink);
    fx.update(FRAME, camera);
    fx.blockBreak(4, 1, -6, BlockId.STONE, 4.5, 1.5, -5, 0, 0, 1);
    fx.update(FRAME, camera);

    expect(fx.stats.sparks).toBeGreaterThan(0);
    expect(rec.frames[1].length).toBe(1);
    expect(rec.frames[1][0].z).toBeGreaterThan(-5);
  });
});
