/**
 * DOOMCRAFT — character system tests.
 *
 * These cover the three things that were actually wrong or actually load-bearing
 * and that nothing else can catch:
 *
 *   1. The bake's final frame. `AnimationAction` under LoopRepeat wraps
 *      `t === duration` to `t === 0`, which silently replaced the last frame of
 *      every clip with its first. Harmless for a loop, fatal for `die`, and the
 *      failure mode is a corpse that stands back up — which no type check and
 *      no draw-call count can see.
 *   2. The per-look measurement. `registry.ts` states a height in metres, but
 *      the rig is 2.7 m of parts and a Cacodemon has no legs and a Lost Soul is
 *      a head. If the scale were `height / 2.7` both would be planted in the
 *      floor, and that is exactly the sort of thing that looks "nearly right"
 *      in a screenshot.
 *   3. The draw-call promise. One call for the whole enemy cast, at any
 *      population — the entire justification for the merged rig.
 *
 * The renderer is driven through the `assets` seam with a hand-built asset set:
 * `loadCharacterAssets` needs a network, a GLTF parser and an `Image`, none of
 * which exist under vitest, but everything interesting here is pure.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';

import {
  bakeClips, FRAME_STRIDE, RIG_NODE_COUNT, RIG_NODE_NAMES, TRS_STRIDE,
  type CharacterAssets,
} from './loader';
import { Rig, createRigInput, CLIP_DIE, CLIP_IDLE, CLIP_WALK } from './rig';
import {
  LOOK_IMP, LOOK_TROOPER, LOOK_BARON, LOOK_CACODEMON, LOOK_LOST_SOUL,
  PART_COUNT, PART_NAMES, nodeOfPart, type CharacterLook,
} from './registry';
import {
  EnemyRenderer, lookMetrics, CORPSE_LIFETIME, CORPSE_SINK,
} from './enemyRenderer';

/* ------------------------------------------------------------------------ *
 * A stand-in for cast.glb
 *
 * Every number below is measured off the real pack (the GLB's node table and
 * accessor bounds), so the metric assertions are assertions about the shipping
 * asset and not about a fixture invented to pass.
 * ------------------------------------------------------------------------ */

/** Rest-pose local translation per rig node: root, legs, torso, arms, head. */
const REST_T: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],          // root
  [0.2, 1, 0],        // leg-left
  [-0.2, 1, 0],       // leg-right
  [0, 0.7, 0],        // torso
  [0.4, 1.1, -0.1],   // arm-left   (relative to torso)
  [-0.4, 1.1, -0.1],  // arm-right
  [0, 1.2, 0],        // head
];
/** Rest-pose local scale. Only the head carries one: its box is 8 units tall. */
const REST_S: readonly (readonly [number, number, number])[] = [
  [1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1], [0.1, 0.1, 0.1],
];
/** Per-part geometry AABB, in that part's own local space. */
const PART_BOUNDS: readonly (readonly number[])[] = [
  [-0.2, -1, -0.2, 0.2, 0, 0.2],        // leg-left
  [-0.2, -1, -0.2, 0.2, 0, 0.2],        // leg-right
  [-0.4, 0.3, -0.3, 0.4, 1.2, 0.3],     // torso
  [0, -1, -0.2, 0.4, 0.1, 0.2],         // arm-left
  [-0.4, -1, -0.2, 0, 0.1, 0.2],        // arm-right
  [-4, 0, -4, 4, 8, 4],                 // head
];

function restBuffer(): Float32Array {
  const rest = new Float32Array(FRAME_STRIDE);
  for (let i = 0; i < RIG_NODE_COUNT; i++) {
    const o = i * TRS_STRIDE;
    rest[o] = REST_T[i][0]; rest[o + 1] = REST_T[i][1]; rest[o + 2] = REST_T[i][2];
    rest[o + 6] = 1;
    rest[o + 7] = REST_S[i][0]; rest[o + 8] = REST_S[i][1]; rest[o + 9] = REST_S[i][2];
  }
  return rest;
}

/** The seven rig nodes, parented the way `loader.ts` asserts cast.glb is. */
function buildRigScene(): { scene: THREE.Object3D; nodes: THREE.Object3D[] } {
  const scene = new THREE.Object3D();
  const nodes: THREE.Object3D[] = [];
  for (let i = 0; i < RIG_NODE_COUNT; i++) {
    const o = new THREE.Object3D();
    o.name = RIG_NODE_NAMES[i];
    o.position.set(...(REST_T[i] as [number, number, number]));
    o.scale.set(...(REST_S[i] as [number, number, number]));
    nodes.push(o);
  }
  scene.add(nodes[0]);
  nodes[0].add(nodes[1], nodes[2], nodes[3]);
  nodes[3].add(nodes[4], nodes[5], nodes[6]);
  return { scene, nodes };
}

/**
 * `die`, with the pack's real endpoints: the root ends at a quarter turn about
 * X, which is the faceplant, and gets there in a third of a second.
 */
function dieClip(): THREE.AnimationClip {
  const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  return new THREE.AnimationClip('die', 0.333, [
    new THREE.QuaternionKeyframeTrack('root.quaternion', [0, 0.333], [0, 0, 0, 1, flat.x, flat.y, flat.z, flat.w]),
    new THREE.VectorKeyframeTrack('root.position', [0, 0.333], [0, 0, 0, 0, 0.05, 0]),
  ]);
}

/** `walk`, a genuine loop: its last key is its first key. */
function walkClip(): THREE.AnimationClip {
  const a = new THREE.Quaternion();
  const b = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.6);
  return new THREE.AnimationClip('walk', 0.667, [
    new THREE.QuaternionKeyframeTrack('leg-left.quaternion',
      [0, 0.333, 0.667],
      [a.x, a.y, a.z, a.w, b.x, b.y, b.z, b.w, a.x, a.y, a.z, a.w]),
  ]);
}

function idleClip(): THREE.AnimationClip {
  return new THREE.AnimationClip('idle', 1.0, [
    new THREE.QuaternionKeyframeTrack('torso.quaternion', [0, 1.0], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]);
}

function makeAssets(): CharacterAssets {
  const { scene, nodes } = buildRigScene();
  const { frames, clips } = bakeClips(scene, [idleClip(), walkClip(), dieClip()], nodes);

  // A minimal merged geometry: one triangle per part, tagged with `aPart`.
  const geometry = new THREE.BufferGeometry();
  const pos = new Float32Array(PART_COUNT * 3 * 3);
  const part = new Float32Array(PART_COUNT * 3);
  const index = new Uint16Array(PART_COUNT * 3);
  for (let p = 0; p < PART_COUNT; p++) {
    for (let v = 0; v < 3; v++) {
      part[p * 3 + v] = p;
      index[p * 3 + v] = p * 3 + v;
    }
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pos.length), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(PART_COUNT * 3 * 2), 2));
  geometry.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));

  const partBounds = new Float32Array(PART_COUNT * 6);
  for (let p = 0; p < PART_COUNT; p++) partBounds.set(PART_BOUNDS[p], p * 6);

  return {
    geometry,
    material: new THREE.MeshBasicMaterial(),
    texture: new THREE.Texture(),
    frames,
    clips,
    rest: restBuffer(),
    partBounds,
    dispose(): void { geometry.dispose(); },
  };
}

/* ------------------------------------------------------------------------ *
 * 1. The bake
 * ------------------------------------------------------------------------ */

describe('bakeClips', () => {
  const assets = makeAssets();

  it('bakes the FINAL pose of a one-shot into its final frame, not the first', () => {
    // The regression. Under LoopRepeat, sampling at exactly `duration` wraps to
    // t = 0, so `die`'s last frame used to be the standing rest pose and every
    // corpse in the game got back up the instant it hit the floor.
    const die = assets.clips.get(CLIP_DIE);
    expect(die).toBeDefined();
    const last = (die!.first + die!.count - 1) * FRAME_STRIDE;
    const q = new THREE.Quaternion(
      assets.frames[last + 3], assets.frames[last + 4],
      assets.frames[last + 5], assets.frames[last + 6],
    );
    // A quarter turn about X, up to quaternion sign.
    expect(Math.abs(q.x)).toBeCloseTo(Math.SQRT1_2, 3);
    expect(Math.abs(q.w)).toBeCloseTo(Math.SQRT1_2, 3);
    // ...and it is genuinely NOT the first frame.
    const first = die!.first * FRAME_STRIDE;
    expect(Math.abs(assets.frames[first + 3])).toBeLessThan(0.01);
  });

  it('still closes a real loop on its own first pose', () => {
    const walk = assets.clips.get(CLIP_WALK);
    expect(walk).toBeDefined();
    const a = walk!.first * FRAME_STRIDE;
    const b = (walk!.first + walk!.count - 1) * FRAME_STRIDE;
    for (let n = 0; n < RIG_NODE_COUNT; n++) {
      for (let k = 3; k < 7; k++) {
        expect(assets.frames[b + n * TRS_STRIDE + k]).toBeCloseTo(assets.frames[a + n * TRS_STRIDE + k], 3);
      }
    }
  });

  it('derives each clip mask from the channel list', () => {
    // `walk` touches leg-left (node 1) and nothing else; the upper-body overlay
    // relies on this mask to leave the base layer's other nodes alone.
    expect(assets.clips.get(CLIP_WALK)!.mask).toBe(1 << 1);
    expect(assets.clips.get(CLIP_IDLE)!.mask).toBe(1 << nodeOfPart(2));
  });
});

/* ------------------------------------------------------------------------ *
 * 2. The rig contract
 * ------------------------------------------------------------------------ */

describe('Rig', () => {
  const assets = makeAssets();

  it('plays die once and never stands back up', () => {
    const rig = new Rig();
    const input = createRigInput();
    input.speed = 5;
    for (let i = 0; i < 20; i++) rig.update(assets, 1 / 60, input);

    input.dead = true;
    for (let i = 0; i < 200; i++) rig.update(assets, 1 / 60, input);
    expect(rig.down).toBe(true);

    // The sim can never un-kill an entity, but a recycled id could: the rig
    // must not be walkable out of the death state by any input at all.
    input.dead = false;
    input.speed = 9;
    input.attacking = true;
    for (let i = 0; i < 120; i++) rig.update(assets, 1 / 60, input);
    expect(rig.isDying).toBe(true);
    expect(rig.down).toBe(true);

    const pose = new Float32Array(FRAME_STRIDE);
    rig.pose(assets, pose);
    expect(Math.abs(pose[3])).toBeCloseTo(Math.SQRT1_2, 2);
  });
});

/* ------------------------------------------------------------------------ *
 * 3. Silhouette measurement
 * ------------------------------------------------------------------------ */

describe('lookMetrics', () => {
  const assets = makeAssets();
  const cases: readonly CharacterLook[] = [
    LOOK_IMP, LOOK_TROOPER, LOOK_BARON, LOOK_CACODEMON, LOOK_LOST_SOUL,
  ];

  for (const look of cases) {
    it(`${look.name} stands ${look.height} m tall with its lowest point on the floor`, () => {
      const m = lookMetrics(assets, look);
      // Rebuild the rest-pose extent the same way the renderer will draw it and
      // check the two agree: scale * extent === the authored height.
      const oy = new Float64Array(RIG_NODE_COUNT);
      for (let i = 0; i < RIG_NODE_COUNT; i++) {
        const parent = i === 0 ? -1 : (i <= 3 ? 0 : 3);
        const ky = parent < 0 ? 1 : look.stretch[parent * 3 + 1];
        oy[i] = (parent < 0 ? 0 : oy[parent]) + REST_T[i][1] * ky;
      }
      let lo = Infinity, hi = -Infinity;
      for (let p = 0; p < PART_COUNT; p++) {
        if ((look.parts & (1 << p)) === 0) continue;
        const node = nodeOfPart(p);
        const sy = REST_S[node][1] * look.stretch[node * 3 + 1];
        lo = Math.min(lo, oy[node] + PART_BOUNDS[p][1] * sy);
        hi = Math.max(hi, oy[node] + PART_BOUNDS[p][4] * sy);
      }
      expect((hi - lo) * m.scale).toBeCloseTo(look.height, 5);
      expect(m.footY).toBeCloseTo(lo, 5);
    });
  }

  it('gives the legless and the head-only looks a sane scale', () => {
    // The naive `height / 2.7` would put a Cacodemon's chin at 1.07 m and bury
    // a Lost Soul: their visible parts start well above the rig's own feet.
    expect(lookMetrics(assets, LOOK_CACODEMON).footY).toBeGreaterThan(0.5);
    expect(lookMetrics(assets, LOOK_LOST_SOUL).footY).toBeGreaterThan(1.5);
    expect(lookMetrics(assets, LOOK_TROOPER).footY).toBeCloseTo(0, 6);
  });
});

/* ------------------------------------------------------------------------ *
 * 4. The renderer
 * ------------------------------------------------------------------------ */

const ES_MOVING = 1 << 0;
const ES_DEAD = 1 << 3;
const REASON_KILLED = 3;
const REASON_DESPAWNED = 5;

interface Ent {
  id: number; active: boolean; type: number; state: number; health: number;
  x: number; y: number; z: number; yaw: number; vx: number; vy: number; vz: number;
}

function ent(id: number, type: number, x: number): Ent {
  return { id, active: true, type, state: ES_MOVING, health: 100, x, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0 };
}

/** A camera that sees everything in front of it. */
function camera(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(90, 2, 0.1, 500);
  c.position.set(0, 1.6, 30);
  c.lookAt(0, 1, 0);
  c.updateMatrixWorld(true);
  return c;
}

describe('EnemyRenderer', () => {
  it('draws the whole cast in ONE call, at any population', () => {
    const scene = new THREE.Scene();
    const r = new EnemyRenderer(scene, { assets: makeAssets() });
    const cam = camera();
    expect(r.ready).toBe(true);

    const ents: Ent[] = [];
    for (let i = 0; i < 24; i++) ents.push(ent(i + 1, i % 5, (i - 12) * 1.4));
    r.update({ entities: ents }, cam, 1 / 60, 0);

    expect(r.bodyCount).toBe(24);
    expect(r.drawCalls).toBe(1);
    // 24 bodies at 5 archetypes: Imp/Trooper/Baron 6 parts, Cacodemon 4,
    // Lost Soul 1. The instance count is the sum of the parts that exist, not
    // 24 * 6 — a missing limb is one fewer instance, not a hidden one.
    let want = 0;
    for (let i = 0; i < 24; i++) {
      const t = i % 5;
      want += t === 2 ? 4 : t === 4 ? 1 : 6;
    }
    expect(r.instanceCount).toBe(want);
    r.dispose();
  });

  it('emits nothing, and no draw call, when the arena is empty', () => {
    const r = new EnemyRenderer(new THREE.Scene(), { assets: makeAssets() });
    r.update({ entities: [] }, camera(), 1 / 60, 0);
    expect(r.drawCalls).toBe(0);
    expect(r.instanceCount).toBe(0);
    r.dispose();
  });

  it('culls a body behind the camera', () => {
    const r = new EnemyRenderer(new THREE.Scene(), { assets: makeAssets() });
    const cam = camera();
    const behind = ent(1, 0, 0);
    behind.z = 90;   // camera sits at z=30 looking at the origin
    r.update({ entities: [behind] }, cam, 1 / 60, 0);
    expect(r.bodyCount).toBe(0);
    expect(r.drawCalls).toBe(0);
    r.dispose();
  });

  it('leaves a corpse for a kill and nothing for a despawn', () => {
    const r = new EnemyRenderer(new THREE.Scene(), { assets: makeAssets() });
    const cam = camera();
    const a = ent(1, 0, -2);
    const b = ent(2, 0, 2);
    r.update({ entities: [a, b] }, cam, 1 / 60, 0);
    expect(r.bodyCount).toBe(2);

    // The sim kills and removes in the same tick, so this is the only notice.
    r.entityGone(a, REASON_KILLED);
    r.entityGone(b, REASON_DESPAWNED);
    a.active = false;
    b.active = false;
    r.update({ entities: [a, b] }, cam, 1 / 60, 0);

    expect(r.bodyCount).toBe(1);
    expect(r.instanceCount).toBe(6);
    r.dispose();
  });

  it('recycles a corpse once its lifetime is up', () => {
    const r = new EnemyRenderer(new THREE.Scene(), { assets: makeAssets() });
    const cam = camera();
    const a = ent(1, 0, 0);
    r.update({ entities: [a] }, cam, 1 / 60, 0);
    r.entityGone(a, REASON_KILLED);
    a.active = false;

    const steps = Math.ceil((CORPSE_LIFETIME + CORPSE_SINK) / 0.05) + 4;
    for (let i = 0; i < steps; i++) r.update({ entities: [a] }, cam, 0.05, i * 0.05);
    expect(r.bodyCount).toBe(0);
    r.dispose();
  });

  it('accepts ES_DEAD on the wire as a death too', () => {
    // Belt and braces: the sim does not currently transmit a dead monster, but
    // a mode that held one alive for a death animation must not make it stand.
    const r = new EnemyRenderer(new THREE.Scene(), { assets: makeAssets() });
    const cam = camera();
    const a = ent(1, 1, 0);
    r.update({ entities: [a] }, cam, 1 / 60, 0);
    a.state = ES_DEAD;
    for (let i = 0; i < 60; i++) r.update({ entities: [a] }, cam, 1 / 60, i / 60);
    expect(r.bodyCount).toBe(1);
    r.dispose();
  });

  it('drops a dead flyer onto the floor', () => {
    const scene = new THREE.Scene();
    const r = new EnemyRenderer(scene, { assets: makeAssets(), groundBelow: () => 0 });
    const cam = camera();
    const caco = ent(1, 2, 0);   // EntityType.CACODEMON
    caco.y = 6;
    r.update({ entities: [caco] }, cam, 1 / 60, 0);
    r.entityGone(caco, REASON_KILLED);
    caco.active = false;

    const mesh = scene.getObjectByName('demons') as THREE.InstancedMesh;
    for (let i = 0; i < 60; i++) r.update({ entities: [caco] }, cam, 1 / 30, i / 30);
    // Torso is instance index 0 for a legless look; read its world Y.
    const m = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array as Float32Array, 0);
    expect(m.elements[13]).toBeLessThan(1.0);
    r.dispose();
  });

  it('leaves a walker\'s corpse exactly where it fell', () => {
    // The mirror of the flyer case, and a real regression: treating "no ground
    // probe" as "fall forever" sent every corpse in the game through the floor
    // at 9 m/s, which reads as the body vanishing.
    const scene = new THREE.Scene();
    const r = new EnemyRenderer(scene, { assets: makeAssets(), groundBelow: () => 0 });
    const cam = camera();
    const imp = ent(1, 0, 0);
    imp.y = 3;                       // standing on a ledge
    r.update({ entities: [imp] }, cam, 1 / 60, 0);
    r.entityGone(imp, REASON_KILLED);
    imp.active = false;

    const mesh = scene.getObjectByName('demons') as THREE.InstancedMesh;
    for (let i = 0; i < 60; i++) r.update({ entities: [imp] }, cam, 1 / 30, i / 30);
    const m = new THREE.Matrix4().fromArray(mesh.instanceMatrix.array as Float32Array, 0);
    expect(m.elements[13]).toBeGreaterThan(2.5);
    r.dispose();
  });

  it('never exceeds one draw call however many corpses pile up', () => {
    const r = new EnemyRenderer(new THREE.Scene(), { assets: makeAssets() });
    const cam = camera();
    const ents: Ent[] = [];
    for (let i = 0; i < 30; i++) ents.push(ent(i + 1, 4, (i - 15) * 0.9));
    r.update({ entities: ents }, cam, 1 / 60, 0);
    for (const e of ents) { r.entityGone(e, REASON_KILLED); e.active = false; }
    r.update({ entities: ents }, cam, 1 / 60, 0.02);
    expect(r.bodyCount).toBe(30);
    expect(r.drawCalls).toBe(1);
    r.dispose();
  });
});

/* ------------------------------------------------------------------------ *
 * 5. The archetype map
 * ------------------------------------------------------------------------ */

describe('archetype silhouettes', () => {
  it('gives every Doom archetype a distinguishable outline', () => {
    const looks = [LOOK_IMP, LOOK_TROOPER, LOOK_BARON, LOOK_CACODEMON, LOOK_LOST_SOUL];
    // Height alone separates four of the five, and the fifth (Imp vs Trooper,
    // 1.75 vs 1.80) is separated by limb proportion and by tint.
    const heights = looks.map((l) => l.height);
    expect(new Set(heights).size).toBe(heights.length);
    // No two share a part mask AND a skin AND a body proportion.
    const keys = looks.map((l) => `${l.parts}|${l.skin}|${l.stretch.join(',')}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Every tint is above the fog's own luma so nothing sinks into a far wall.
    for (const l of looks) {
      const luma = 0.2126 * l.tint[0] + 0.7152 * l.tint[1] + 0.0722 * l.tint[2];
      expect(luma).toBeGreaterThan(0.85);
    }
  });

  it('has one look per monster EntityType and no orphan parts', () => {
    for (const l of [LOOK_IMP, LOOK_TROOPER, LOOK_BARON, LOOK_CACODEMON, LOOK_LOST_SOUL]) {
      expect(l.stretch.length).toBe((PART_COUNT + 1) * 3);
      expect(l.parts).toBeGreaterThan(0);
      expect(l.parts).toBeLessThan(1 << PART_NAMES.length);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * The characters pack ratchet — docs/PACKS.md phase 1
 * ------------------------------------------------------------------------ */

describe('the characters pack ratchet', () => {
  it('fails when a look changes without the characters pack moving', async () => {
    const { charactersFingerprintInputs, LOOKS } = await import('@doomcraft/shared/characters');
    const { CHARACTERS_FINGERPRINT } = await import('@doomcraft/shared/packs');
    const { fingerprint } = await import('@doomcraft/shared/version');
    // If this fails you changed how the cast looks. Bump
    // CHARACTERS_PACK_VERSION in shared/src/packs.ts and paste the new
    // fingerprint there, in the same commit.
    expect(fingerprint(charactersFingerprintInputs().join('|'))).toBe(CHARACTERS_FINGERPRINT);

    // And the independence half: one edited tint moves THIS fingerprint...
    const edited = LOOKS.map((l, i) => (i === 0 ? { ...l, tint: [9, 9, 9] as const } : l));
    expect(fingerprint(charactersFingerprintInputs(edited).join('|'))).not.toBe(CHARACTERS_FINGERPRINT);
    // ...and no other: weapons and core are untouched by construction, which
    // version.test.ts asserts from the other side.
  });
});
