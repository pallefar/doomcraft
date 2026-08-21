/**
 * DOOMCRAFT — the demons, as bodies.
 *
 * This is the piece `characters/loader.ts` was written against and that did not
 * exist: its header points at "characterRenderer.ts" for the culling and the
 * instance layout, and `rig.ts`'s header says the caller "turns those into a
 * `RigInput` and the machine turns that into clips". This file is that caller.
 * Before it, `loader.ts`, `rig.ts` and `registry.ts` were 1,255 lines that
 * nothing in `client/src/game`, `client/src/engine` or `main.ts` imported, and
 * every monster in the game was six coloured boxes out of `ActorRenderer`.
 *
 * WHAT DRIVES THE ANIMATION — the sim, and nothing invented beside it
 *
 * `server/src/sim.ts` publishes per entity: a position, a yaw, a velocity
 * (`EF_VEL`, already on the wire and already interpolated — it was simply never
 * copied out of the track into the view, which is a three-line fix in
 * `net/client.ts` and zero extra bytes), and a state byte carrying
 * ES_MOVING / ES_ATTACK / ES_PAIN / ES_DEAD / ES_FLYING / ES_ALERT / ES_WINDUP.
 * That is the whole input:
 *
 *   horizontal speed  ->  idle / walk / sprint, and the playback rate
 *   ES_ATTACK|WINDUP  ->  holding-right-shoot on the gun arm, or a melee swing
 *   archetype.armed   ->  holding-right, so a Trooper walks with its rifle up
 *   death             ->  `die`, once, and it never gets back up
 *
 * DEATH IS A CLIENT-SIDE FACT, WHICH IS NOT OBVIOUS
 *
 * `sim.damageEntity()` sets ES_DEAD and calls `removeEntity()` in the SAME
 * statement, so a dead monster is never transmitted as dead — it stops being
 * transmitted at all. A renderer that waits to see ES_DEAD on the wire will
 * wait forever and every kill will pop out of existence. So the corpse is
 * owned here: `entityGone()` takes the `RemoveReason` byte the snapshot already
 * carries, and only `KILLED` leaves a body. A monster that despawned or walked
 * out of the snapshot is dropped without a corpse, which is why the arena does
 * not fill with the dead of things that were never killed.
 *
 * THE DRAW-CALL ARGUMENT
 *
 * Horde already sits near the practical ceiling and `game.medianMs` tracks draw
 * calls close to linearly, so the entire cast has to be one call. It is:
 *
 *   - ONE `InstancedMesh` over the merged 144-vertex / 72-triangle rig
 *     geometry `loader.ts` builds, and the ONE `MeshBasicMaterial` it patches.
 *   - An instance is one PART of one character. Its `instanceMatrix` is that
 *     part's world matrix, `aInstPart` says which part, and the vertex shader
 *     collapses every vertex belonging to another part to a point. That is
 *     loader.ts's design; this file supplies the attributes it declares.
 *   - The skin is a per-instance UV offset into the one 192x128 atlas
 *     (`aSkinUv`), and the archetype tint is `instanceColor`. Neither is a
 *     material, so neither is a draw call.
 *
 * Cost: +1 draw call for every demon on screen, at any population, and it
 * replaces monsters that previously rode in `ActorRenderer`'s box batch for
 * +0. The honest number is therefore ONE draw call for the whole enemy cast,
 * not one per enemy — measured, see the report.
 *
 * SILHOUETTE, WHICH IS THE POINT
 *
 * `registry.ts` already authored five outlines out of one mesh by stretching
 * individual rig nodes and deleting limbs. The stretch model it documents is
 * "a node's stretch scales its own geometry AND the attachment offset of its
 * children" — note what that does NOT say. It is deliberately NOT an inherited
 * scale: a Baron's 1.55x torso carries the shoulders outward to +-0.62 m so the
 * arms butt-joint the chest, while each arm's own 1.55x sets the arm's own
 * thickness. Compounding the two (the naive hierarchical scale) would make the
 * arms 2.4x and wider than the torso they hang off. `emit()` implements the
 * documented model: rotation and translation inherit, scale does not.
 */

import * as THREE from 'three';

import { EntityType, RemoveReason } from '@shared/protocol';

import {
  loadCharacterAssets, peekCharacterAssets,
  RIG_NODE_COUNT, RIG_PARENT, PART_NODE, TRS_STRIDE, FRAME_STRIDE,
  type CharacterAssets,
} from './loader';
import { Rig, createRigInput, CLIP_IDLE, type RigInput } from './rig';
import {
  lookForEntity, nodeOfPart, PART_COUNT, PART_TORSO,
  skinOffsetU, skinOffsetV,
  type CharacterLook,
} from './registry';

/* ------------------------------------------------------------------------ *
 * Entity state bits
 *
 * Mirrored rather than imported, exactly as `game.ts` already mirrors ES_DEAD
 * and ES_WINDUP: a value import from `server/src/sim.ts` would drag the whole
 * authoritative simulation into the client bundle.
 * ------------------------------------------------------------------------ */

const ES_ATTACK = 1 << 1;
const ES_PAIN = 1 << 2;
const ES_DEAD = 1 << 3;
const ES_WINDUP = 1 << 6;

/* ------------------------------------------------------------------------ *
 * Budget
 * ------------------------------------------------------------------------ */

/**
 * Bodies posed per frame. Horde's own cap is well under this and everything
 * beyond it is culled by distance first, so the limit is a guarantee that a
 * pathological wave cannot make the frame unbounded, not a number the game
 * reaches.
 */
export const MAX_BODIES = 48;
/** Worst case is every body showing all six parts. */
export const MAX_INSTANCES = MAX_BODIES * PART_COUNT;
/** Metres past which a demon is not drawn at all. Fog is total well inside it. */
export const DRAW_DISTANCE = 140;
/** Seconds a corpse lies on the floor before it is recycled. */
export const CORPSE_LIFETIME = 14;
/** Seconds a corpse spends sinking out of sight at the end of that. */
export const CORPSE_SINK = 1.5;

/** The rig is 2.7 m from sole to crown before any stretch. */
const RIG_HEIGHT = 2.7;

/** How hard a hit whitens the body, and how fast that decays. */
const PAIN_GAIN = 0.55;
const PAIN_FADE = 4.5;

/* ------------------------------------------------------------------------ *
 * What the renderer needs from the net client
 *
 * Structural, so this module never imports `NetClient` and the tests can drive
 * it with three plain objects.
 * ------------------------------------------------------------------------ */

export interface EnemyEntityView {
  readonly id: number;
  readonly active: boolean;
  readonly type: number;
  readonly state: number;
  readonly health: number;
  readonly x: number; readonly y: number; readonly z: number;
  readonly yaw: number;
  readonly vx: number; readonly vy: number; readonly vz: number;
}

export interface EnemySource {
  readonly entities: readonly EnemyEntityView[];
}

/* ------------------------------------------------------------------------ *
 * Per-look metrics
 *
 * `CharacterLook.height` is documented as "metres, sole of the foot to the
 * crown, AFTER the stretch is applied", so the uniform scale cannot be
 * `height / 2.7` — a Cacodemon has no legs and a Lost Soul is a head, and both
 * would be planted underground by that. The real rest-pose extent of the parts
 * a look actually shows is measured once, from `assets.partBounds` and the rest
 * pose, and the scale and the ground offset fall out of it.
 * ------------------------------------------------------------------------ */

interface LookMetrics {
  /** Model units -> metres. */
  readonly scale: number;
  /** Model-space y of the lowest visible point, so the feet land on the floor. */
  readonly footY: number;
}

function measureLook(assets: CharacterAssets, look: CharacterLook): LookMetrics {
  const rest = assets.rest;
  const st = look.stretch;

  // Rest-pose node origins. Rotations are identity in the pack's rest pose, so
  // origins compose by addition; the child offset is scaled by the PARENT's
  // stretch, which is the documented rule.
  const oy = new Float64Array(RIG_NODE_COUNT);
  for (let i = 0; i < RIG_NODE_COUNT; i++) {
    const p = RIG_PARENT[i];
    const root = p < 0;
    oy[i] = (root ? 0 : oy[p]) + rest[i * TRS_STRIDE + 1] * (root ? 1 : st[p * 3 + 1]);
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (let part = 0; part < PART_COUNT; part++) {
    if ((look.parts & (1 << part)) === 0) continue;
    const node = nodeOfPart(part);
    const b = node * TRS_STRIDE;
    // Own stretch times the rest-pose local scale (the head carries a 0.1).
    const sy = rest[b + 8] * st[node * 3 + 1];
    const minY = assets.partBounds[part * 6 + 1] * sy;
    const maxY = assets.partBounds[part * 6 + 4] * sy;
    const a = oy[node] + Math.min(minY, maxY);
    const c = oy[node] + Math.max(minY, maxY);
    if (a < lo) lo = a;
    if (c > hi) hi = c;
  }
  if (!Number.isFinite(lo) || hi <= lo) return { scale: look.height / RIG_HEIGHT, footY: 0 };
  return { scale: look.height / (hi - lo), footY: lo };
}

/* ------------------------------------------------------------------------ *
 * One body
 * ------------------------------------------------------------------------ */

class Body {
  id = 0;
  look: CharacterLook | null = null;
  metrics: LookMetrics = { scale: 1, footY: 0 };
  readonly rig = new Rig();
  readonly input: RigInput = createRigInput();
  x = 0; y = 0; z = 0; yaw = 0;
  speed = 0;
  pain = 0;
  seen = false;
  /** Seconds since death, or -1 while alive. */
  corpse = -1;
  /** Y the body is falling toward, or -Infinity if it is already on the floor. */
  fallTo = -Infinity;
  /** Y the body is drawn at while it falls. */
  fallY = 0;
  /** Phase offset so a wave of Imps does not breathe in lockstep. */
  phase = 0;

  reset(): void {
    this.id = 0;
    this.look = null;
    this.rig.reset();
    this.pain = 0;
    this.corpse = -1;
    this.speed = 0;
    this.fallTo = -Infinity;
  }
}

/** Metres per second a dead flyer drops. Fast enough to read as a kill. */
const CORPSE_FALL_SPEED = 9;

/* ------------------------------------------------------------------------ *
 * Scratch — nothing in the frame loop allocates
 * ------------------------------------------------------------------------ */

const _pose = new Float32Array(FRAME_STRIDE);
const _charMat = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _geom = new THREE.Matrix4();
const _frames: THREE.Matrix4[] = [];
for (let i = 0; i < RIG_NODE_COUNT; i++) _frames.push(new THREE.Matrix4());
const _v = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _lean = new THREE.Quaternion();
const _qNode = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
const _yawQ = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _xAxis = new THREE.Vector3(1, 0, 0);
const _sphere = new THREE.Sphere();
const _projScreen = new THREE.Matrix4();
const FRUSTUM = new THREE.Frustum();

/* ------------------------------------------------------------------------ *
 * The renderer
 * ------------------------------------------------------------------------ */

export interface EnemyRendererOptions {
  /**
   * Share the world material's uniform OBJECTS so fog range, fog colour and the
   * hurt tint reach the demons with no per-frame copying and can never be a
   * frame behind the wall behind them. Pass `VoxelMaterials.uniforms`.
   */
  worldUniforms?: Record<string, THREE.IUniform>;
  /**
   * World Y of the first solid surface below a point, or `-Infinity` if there
   * is none. Only ever called ONCE per corpse, and only for a flying archetype:
   * a Cacodemon that dies mid-air has to fall, and this renderer deliberately
   * does not know about the voxel world. `game.ts` wires it to the raycast it
   * already owns.
   */
  groundBelow?: (x: number, y: number, z: number) => number;
  /** Asset base URL. */
  baseUrl?: string;
  /** Start the fetch immediately instead of waiting for `preload()`. */
  autoLoad?: boolean;
  /**
   * Already-built assets, used instead of fetching. This is the seam the unit
   * tests drive the renderer through: `loadCharacterAssets` needs a network, a
   * GLTF parser and an `Image`, none of which exist under vitest, but the
   * corpse lifecycle and the instance accounting are pure and must be tested.
   */
  assets?: CharacterAssets;
}

export class EnemyRenderer {
  private readonly scene: THREE.Scene;
  private readonly opts: EnemyRendererOptions;

  private assets: CharacterAssets | null = null;
  private mesh: THREE.InstancedMesh | null = null;
  private instPart: THREE.InstancedBufferAttribute | null = null;
  private skinUv: THREE.InstancedBufferAttribute | null = null;
  private loading = false;
  private failed = false;

  private readonly bodies: Body[] = [];
  private readonly byId = new Map<number, Body>();
  private readonly metricsCache = new Map<CharacterLook, LookMetrics>();

  /** Instances emitted last frame. */
  private instances = 0;
  /** Bodies posed last frame — alive and corpses. */
  private posed = 0;

  constructor(scene: THREE.Scene, opts: EnemyRendererOptions = {}) {
    this.scene = scene;
    this.opts = opts;
    for (let i = 0; i < MAX_BODIES; i++) this.bodies.push(new Body());
    if (opts.assets !== undefined) this.adopt(opts.assets);
    else if (opts.autoLoad !== false) this.preload();
  }

  /**
   * True once the rig can be drawn. Until then `game.ts` keeps drawing monsters
   * as boxes, so a slow or failed asset fetch degrades to exactly the game that
   * shipped before rather than to an empty arena.
   */
  get ready(): boolean { return this.assets !== null; }
  /** 1 while any demon is on screen, 0 otherwise. Never more. */
  get drawCalls(): number { return this.instances > 0 ? 1 : 0; }
  get instanceCount(): number { return this.instances; }
  get bodyCount(): number { return this.posed; }

  /**
   * Fetch the 38.6 KB rig and the 8.9 KB atlas. Off the critical path on
   * purpose — a player who never leaves the menu never downloads either, and
   * `GLTFLoader` is a dynamic import inside `loadCharacterAssets`.
   */
  preload(): void {
    if (this.assets !== null || this.loading || this.failed) return;
    const already = this.opts.assets ?? peekCharacterAssets();
    if (already !== null) { this.adopt(already); return; }
    this.loading = true;
    void loadCharacterAssets({
      baseUrl: this.opts.baseUrl,
      worldUniforms: this.opts.worldUniforms,
    }).then((a) => {
      this.loading = false;
      this.adopt(a);
    }).catch(() => {
      // Boxes are a complete game. Do not retry in a loop on a 404.
      this.loading = false;
      this.failed = true;
    });
  }

  private adopt(assets: CharacterAssets): void {
    if (this.assets !== null) return;
    this.assets = assets;

    // A geometry per renderer, but the vertex buffers by REFERENCE: 144
    // vertices exist once in memory however many batches there are.
    const g = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv', 'aPart']) {
      const attr = assets.geometry.getAttribute(name);
      if (attr !== undefined) g.setAttribute(name, attr);
    }
    g.setIndex(assets.geometry.getIndex());
    g.boundingSphere = assets.geometry.boundingSphere;
    g.boundingBox = assets.geometry.boundingBox;

    const part = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES), 1);
    part.setUsage(THREE.DynamicDrawUsage);
    const uv = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES * 2), 2);
    uv.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aInstPart', part);
    g.setAttribute('aSkinUv', uv);
    this.instPart = part;
    this.skinUv = uv;

    const mesh = new THREE.InstancedMesh(g, assets.material, MAX_INSTANCES);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const color = new THREE.InstancedBufferAttribute(new Float32Array(MAX_INSTANCES * 3), 3);
    color.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = color;
    // Culling is per character on the CPU below; the batch spans the arena.
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 0;
    mesh.name = 'demons';
    mesh.count = 0;
    this.mesh = mesh;
    this.scene.add(mesh);
  }

  /**
   * An entity left the snapshot. Only a kill leaves a corpse — see the header.
   * Called from `NetClient`'s `onEntityGone`, i.e. during the net update and
   * before the frame that would have missed the body.
   */
  entityGone(view: EnemyEntityView, reason: number): void {
    const body = this.byId.get(view.id);
    if (body === undefined) return;
    if (reason === RemoveReason.KILLED && body.corpse < 0) {
      body.corpse = 0;
      body.input.dead = true;
      body.input.attacking = false;
      body.speed = 0;
      this.startFall(body);
      return;
    }
    this.release(body);
  }

  /** Drop every body. Mode teardown and respawn. */
  clear(): void {
    for (const b of this.bodies) if (b.id !== 0) this.release(b);
    this.instances = 0;
    this.posed = 0;
    if (this.mesh !== null) this.mesh.count = 0;
  }

  private release(body: Body): void {
    if (body.id !== 0) this.byId.delete(body.id);
    body.reset();
  }

  private acquire(id: number, look: CharacterLook, assets: CharacterAssets): Body | null {
    let free: Body | null = null;
    for (const b of this.bodies) {
      if (b.id === 0) { free = b; break; }
    }
    if (free === null) {
      // Full: evict the oldest corpse rather than refuse a live monster.
      let oldest: Body | null = null;
      for (const b of this.bodies) {
        if (b.corpse >= 0 && (oldest === null || b.corpse > oldest.corpse)) oldest = b;
      }
      if (oldest === null) return null;
      this.release(oldest);
      free = oldest;
    }
    free.id = id;
    free.look = look;
    free.metrics = this.metricsFor(assets, look);
    free.rig.reset();
    free.rig.snapTo(assets, CLIP_IDLE);
    free.pain = 0;
    free.corpse = -1;
    free.phase = (id * 0.618) % 1;
    this.byId.set(id, free);
    return free;
  }

  /**
   * A dead Cacodemon stops flying. Nothing else in the cast needs this: a body
   * that was already walking is already on the floor.
   */
  private startFall(body: Body): void {
    body.fallTo = -Infinity;
    body.fallY = body.y;
    const look = body.look;
    const probe = this.opts.groundBelow;
    if (look === null || !look.hovers || probe === undefined) return;
    const ground = probe(body.x, body.y, body.z);
    if (Number.isFinite(ground) && ground < body.y) body.fallTo = ground;
  }

  private metricsFor(assets: CharacterAssets, look: CharacterLook): LookMetrics {
    let m = this.metricsCache.get(look);
    if (m === undefined) {
      m = measureLook(assets, look);
      this.metricsCache.set(look, m);
    }
    return m;
  }

  /* ---------------------------------------------------------------- frame */

  update(net: EnemySource, camera: THREE.Camera, dt: number, time: number): void {
    const assets = this.assets;
    const mesh = this.mesh;
    if (assets === null || mesh === null) { this.posed = 0; this.instances = 0; return; }
    if (dt < 0) dt = 0; else if (dt > 0.25) dt = 0.25;

    for (const b of this.bodies) b.seen = false;

    /* --- 1. drive the state machines from the sim ---------------------- */
    const list = net.entities;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.active || e.type >= EntityType.PICKUP_HEALTH) continue;
      const look = lookForEntity(e.type);
      if (look === null) continue;

      let body = this.byId.get(e.id);
      if (body === undefined || body.look !== look) {
        if (body !== undefined) this.release(body);
        body = this.acquire(e.id, look, assets) ?? undefined;
        if (body === undefined) continue;
      }
      body.seen = true;
      body.x = e.x; body.y = e.y; body.z = e.z; body.yaw = e.yaw;

      // Velocity straight off the wire. Vertical motion counts for a flyer,
      // whose whole locomotion is vertical, and not for anything that walks —
      // otherwise a Baron falling off a ledge breaks into a sprint.
      const speed = look.hovers
        ? Math.hypot(e.vx, e.vy, e.vz)
        : Math.hypot(e.vx, e.vz);
      body.speed = speed;

      const dead = (e.state & ES_DEAD) !== 0;
      if (dead && body.corpse < 0) { body.corpse = 0; this.startFall(body); }

      const inp = body.input;
      inp.speed = speed;
      inp.dead = body.corpse >= 0;
      inp.attacking = (e.state & (ES_ATTACK | ES_WINDUP)) !== 0;
      inp.armed = look.armed;
      inp.melee = look.melee;
      inp.hovers = look.hovers;
      inp.cadence = look.cadence;
      inp.pickup = false;

      if ((e.state & ES_PAIN) !== 0 && body.pain < PAIN_GAIN) body.pain = PAIN_GAIN;
      body.pain = body.pain > 0 ? Math.max(0, body.pain - dt * PAIN_FADE) : 0;

      body.rig.update(assets, dt, inp);
    }

    /* --- 2. corpses and orphans ----------------------------------------- */
    for (const b of this.bodies) {
      if (b.id === 0 || b.seen) continue;
      if (b.corpse < 0) {
        // Vanished without a kill: out of the snapshot, not out of the fight.
        this.release(b);
        continue;
      }
      b.corpse += dt;
      if (b.corpse > CORPSE_LIFETIME + CORPSE_SINK) { this.release(b); continue; }
      // -Infinity is "already on the floor, do not fall" — without the finite
      // check every corpse sank through the world at 9 m/s.
      if (Number.isFinite(b.fallTo) && b.fallY > b.fallTo) {
        b.fallY -= CORPSE_FALL_SPEED * dt;
        if (b.fallY < b.fallTo) b.fallY = b.fallTo;
        b.y = b.fallY;
      }
      b.input.dead = true;
      b.input.attacking = false;
      b.input.speed = 0;
      b.pain = b.pain > 0 ? Math.max(0, b.pain - dt * PAIN_FADE) : 0;
      b.rig.update(assets, dt, b.input);
    }

    /* --- 3. emit ---------------------------------------------------------- */
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    FRUSTUM.setFromProjectionMatrix(_projScreen);
    const cam = camera.matrixWorld.elements;
    const camX = cam[12], camY = cam[13], camZ = cam[14];

    let n = 0;
    let bodies = 0;
    const matrices = mesh.instanceMatrix.array as Float32Array;
    const colors = (mesh.instanceColor as THREE.InstancedBufferAttribute).array as Float32Array;
    const parts = (this.instPart as THREE.InstancedBufferAttribute).array as Float32Array;
    const skins = (this.skinUv as THREE.InstancedBufferAttribute).array as Float32Array;

    for (const b of this.bodies) {
      const look = b.look;
      if (b.id === 0 || look === null) continue;
      if (n + PART_COUNT > MAX_INSTANCES) break;

      const dx = b.x - camX, dy = b.y - camY, dz = b.z - camZ;
      if (dx * dx + dy * dy + dz * dz > DRAW_DISTANCE * DRAW_DISTANCE) continue;

      const half = look.height * 0.5;
      _sphere.center.set(b.x, b.y + half, b.z);
      _sphere.radius = look.height * 0.8;
      if (!FRUSTUM.intersectsSphere(_sphere)) continue;

      bodies++;
      n = this.emit(assets, b, look, time, n, matrices, colors, parts, skins);
    }

    this.instances = n;
    this.posed = bodies;
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    (mesh.instanceColor as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.instPart as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.skinUv as THREE.InstancedBufferAttribute).needsUpdate = true;
  }

  /** Pose one body and write its parts. Returns the new instance count. */
  private emit(
    assets: CharacterAssets, b: Body, look: CharacterLook, time: number,
    start: number,
    matrices: Float32Array, colors: Float32Array,
    parts: Float32Array, skins: Float32Array,
  ): number {
    b.rig.pose(assets, _pose);

    const m = b.metrics;
    const s = m.scale;

    /* --- where the body sits ---------------------------------------- */
    let y = b.y - m.footY * s + look.lift;
    if (look.bob > 0 && b.corpse < 0) y += Math.sin(time * 2.4 + b.phase * 6.283) * look.bob;
    if (b.corpse >= 0) {
      // The last second and a half: sink through the floor rather than blink
      // out. `die` itself has already put the body flat and is holding its
      // final frame — the rig will not stand it back up.
      const over = b.corpse - CORPSE_LIFETIME;
      if (over > 0) y -= (over / CORPSE_SINK) * look.height * 1.2;
    }

    _yawQ.setFromAxisAngle(_yAxis, b.yaw + Math.PI);
    _charMat.compose(_v.set(b.x, y, b.z), _yawQ, _scale.setScalar(s));

    /* --- the seven node frames --------------------------------------- *
     * Rotation and translation inherit; scale does not. See the header.  */
    const st = look.stretch;
    if (look.lean !== 0) _lean.setFromAxisAngle(_xAxis, look.lean);

    for (let i = 0; i < RIG_NODE_COUNT; i++) {
      const o = i * TRS_STRIDE;
      const p = RIG_PARENT[i];
      const kx = p < 0 ? 1 : st[p * 3];
      const ky = p < 0 ? 1 : st[p * 3 + 1];
      const kz = p < 0 ? 1 : st[p * 3 + 2];
      _qNode.set(_pose[o + 3], _pose[o + 4], _pose[o + 5], _pose[o + 6]);
      // The torso carries the archetype's constant forward lean, applied on the
      // parent side so the clip's own torso motion rides on top of it.
      if (look.lean !== 0 && i === nodeOfPart(PART_TORSO)) _qNode.premultiply(_lean);
      _local.compose(
        _v.set(_pose[o] * kx, _pose[o + 1] * ky, _pose[o + 2] * kz),
        _qNode, _one,
      );  // scale is deliberately 1: it does not inherit
      _frames[i].multiplyMatrices(p < 0 ? _charMat : _frames[p], _local);
    }

    /* --- tint ---------------------------------------------------------- */
    const t = look.tint;
    let r = t[0], g = t[1], bl = t[2];
    if (b.corpse < 0) {
      // The wind-up telegraph is what makes an attack dodgeable, so it is the
      // loudest thing a demon can do: a hard pulse well above 1, which the
      // material passes through unclamped on purpose.
      const inp = b.input;
      if (inp.attacking) {
        const f = 0.5 + 0.5 * Math.sin(time * 34);
        r += (2.30 - r) * f * 0.75;
        g += (1.85 - g) * f * 0.75;
        bl += (1.05 - bl) * f * 0.75;
      }
      if (b.pain > 0) {
        r += (2.4 - r) * b.pain;
        g += (2.4 - g) * b.pain;
        bl += (2.4 - bl) * b.pain;
      }
    } else {
      // Corpses drop out of the readable band so a pile of the dead cannot be
      // mistaken for a pile of the living.
      const k = 0.55;
      r *= k; g *= k; bl *= k;
    }

    const su = skinOffsetU(look.skin);
    const sv = skinOffsetV(look.skin);

    let n = start;
    for (let part = 0; part < PART_COUNT; part++) {
      if ((look.parts & (1 << part)) === 0) continue;
      const node = PART_NODE[part];
      const o = node * TRS_STRIDE;
      _geom.copy(_frames[node]).scale(_scale.set(
        _pose[o + 7] * st[node * 3],
        _pose[o + 8] * st[node * 3 + 1],
        _pose[o + 9] * st[node * 3 + 2],
      ));
      _geom.toArray(matrices, n * 16);
      colors[n * 3] = r; colors[n * 3 + 1] = g; colors[n * 3 + 2] = bl;
      parts[n] = part;
      skins[n * 2] = su; skins[n * 2 + 1] = sv;
      n++;
    }
    return n;
  }

  dispose(): void {
    this.clear();
    const mesh = this.mesh;
    if (mesh !== null) {
      mesh.removeFromParent();
      // The geometry's vertex buffers and the material are SHARED with the
      // asset cache; only this renderer's own instanced attributes die here.
      mesh.geometry.deleteAttribute('position');
      mesh.geometry.deleteAttribute('normal');
      mesh.geometry.deleteAttribute('uv');
      mesh.geometry.deleteAttribute('aPart');
      mesh.geometry.setIndex(null);
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.mesh = null;
    this.instPart = null;
    this.skinUv = null;
    this.assets = null;
  }
}

/** Named for the report: what a look actually measures out to, in metres. */
export function lookMetrics(assets: CharacterAssets, look: CharacterLook): LookMetrics {
  return measureLook(assets, look);
}
