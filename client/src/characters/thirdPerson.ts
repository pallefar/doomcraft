/**
 * DOOMCRAFT — where your own model is actually seen.
 *
 * WHICH THIRD-PERSON VIEWS EXIST TODAY. Checked in the code, not assumed, and
 * corrected: two of these four are real, two are not.
 *
 *   1. OTHER PLAYERS IN MULTIPLAYER — REAL, wired, and the only one that costs
 *      frame time. `NetClient.players` carries up to MAX_PLAYERS remote bodies
 *      and `game.ts` calls `ThirdPersonRenderer.update()` every frame; the
 *      boxes are gone. Every mode has them: Deathmatch has humans and bots,
 *      Horde and Quest have bot marines, Builder has co-op peers.
 *   2. THE DEATH CAMERA — REAL, and it is `game.ts`'s `updateDeathCamera()`.
 *      Before it, the camera stayed in the first-person rig and `hud.ts`
 *      painted a card over whatever the corpse's eyes were pointed at. It now
 *      orbits the body, and the body is `localBody` below: the local marine
 *      pushed into this same batch, so seeing your own corpse is zero extra
 *      draw calls. There is still no ragdoll — the collapse is the rig's.
 *   3. THE AVATAR PREVIEW — DOES NOT EXIST. `ui/avatarEditor.ts` has never been
 *      written; an earlier revision of this header claimed it owned the preview
 *      and that was simply untrue. `CharacterActor` below is the hook it would
 *      use, and it is exercised by nothing today.
 *   4. A THIRD-PERSON PLAY MODE — DOES NOT EXIST, and nothing here creates one.
 *      `PlayerCamera` has no boom arm of its own; the death camera drives it
 *      through `updateFree()`, which is also all a play mode would need.
 *
 * THE DRAW-CALL ARGUMENT, which is the reason this file is shaped the way it is.
 *
 * Horde already runs at 124 draw calls against a ~120 practical ceiling, and
 * `game.medianMs` tracks draw calls almost linearly. The Kenney rig is six
 * meshes, so the naive thing — one Object3D per player — is 6 draws per player,
 * 48 for eight visible enemies, and the budget is gone before the world is
 * drawn. The brief's fix is to merge the six into one, which gets it to 8.
 *
 * This goes one step further and gets it to ONE, for every remote player in the
 * match, at every outfit and every colour:
 *
 *   - The six parts are baked into a single 216-vertex / 72-triangle buffer at
 *     build time (`kenneyRig.ts`), carrying the pivot each vertex rotates about.
 *   - All twelve outfits live in one 640x480 atlas, so one texture serves the
 *     whole roster and an outfit is a per-instance UV offset.
 *   - The skeleton is six rigid rotations about known pivots, which is cheap
 *     enough to run in the VERTEX SHADER from four per-instance floats. No
 *     SkinnedMesh, no AnimationMixer, no per-player Object3D, no CPU matrices.
 *   - Colour is two per-instance multiply tints, never a second material.
 *
 * Result: `InstancedMesh`, one geometry, one material, one texture, one draw
 * call, N players. Measured cost of going from 0 to 32 players is one extra
 * draw call and 32 * 56 bytes of attribute upload per frame.
 *
 * WHAT THIS DOES NOT DO. It does not load the GLB. It cannot: the GLB's
 * per-node TRS animation tracks are irrelevant once the parts are baked flat,
 * and the geometry they carry is already in `kenneyRig.ts`.
 *
 * THE DEMONS DO NOT SHARE THIS BATCH, and that is a deliberate second draw
 * call rather than an oversight. `characters/enemyRenderer.ts` runs the OTHER
 * rig — the GLB one with the pack's real `walk`/`die`/`holding-right-shoot`
 * clips and `registry.ts`'s per-node stretch — because a demon has to be
 * identifiable by silhouette and has to fall over when it dies, and this
 * module's four-float procedural pose can do neither. Two batches, two
 * materials, two textures: two draw calls for every body in the game at any
 * population, against the 8+ that one Object3D per character would cost.
 */

import * as THREE from 'three';

import { PLAYER_HEIGHT } from '@shared/constants';

import {
  ATLAS_COLS, ATLAS_ROWS, ATLAS_URL, RIG_HEIGHT, rigArrays,
} from './kenneyRig';
import {
  AVATAR_PALETTE, DONOR_COUNT, PALETTE_COUNT, ZONE_COUNT, Zone,
  type AvatarConfig, unpackAvatar,
} from './avatar';

/* ------------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------------ */

/** Model is 2.7 m tall with its feet at y=0; the player capsule is 1.8 m. */
export const CHARACTER_SCALE = PLAYER_HEIGHT / RIG_HEIGHT;

/**
 * Kenney's characters face +Z. The engine's forward is
 * `(-sin(yaw), sin(pitch), -cos(yaw))` (shared/math.ts `anglesToForward`), and a
 * yaw rotation about +Y sends model +Z to `(sin(yaw), 0, cos(yaw))` — exactly
 * backwards. One PI on the instance yaw fixes it; nothing is mirrored, so the
 * right hand stays the right hand and the gun stays on the correct side.
 */
export const MODEL_YAW_OFFSET = Math.PI;

/** Remote bodies drawn per frame. MAX_PLAYERS is 32; the pad is for corpses. */
export const CHARACTER_CAPACITY = 40;

/* ------------------------------------------------------------------------ *
 * Shared geometry — built once, handed to anyone who asks
 * ------------------------------------------------------------------------ */

let geometryCache: THREE.BufferGeometry | null = null;

/**
 * The one character mesh in the game. Non-instanced attributes only; the caller
 * adds its own per-instance attributes with `addInstanceAttributes()`, so the
 * enemy system and the player system can share this buffer without sharing a
 * capacity.
 */
export function sharedCharacterGeometry(): THREE.BufferGeometry {
  if (geometryCache !== null) return geometryCache;
  const r = rigArrays();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(r.position, 3));
  g.setAttribute('aUv', new THREE.BufferAttribute(r.uv, 2));
  g.setAttribute('aPivot', new THREE.BufferAttribute(r.pivot, 3));
  g.setAttribute('aZone', new THREE.BufferAttribute(r.zone, 1));
  g.setAttribute('aShade', new THREE.BufferAttribute(r.shade, 1));
  g.setIndex(new THREE.BufferAttribute(r.index, 1));
  // The rig is a fixed 2.7 m box; a real bounding sphere saves the frustum
  // culler from walking 216 vertices at construction.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.35, 0), 2.1);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-0.9, 0, -0.5), new THREE.Vector3(0.9, 2.7, 0.5));
  geometryCache = g;
  return g;
}

/** Per-instance buffers. Kept together so the layout is stated in one place. */
export interface InstanceBuffers {
  /** vec4: atlas cell index per Zone (head, torso, arms, legs). */
  readonly donor: THREE.InstancedBufferAttribute;
  /** vec3: multiplies head + legs. */
  readonly tint: THREE.InstancedBufferAttribute;
  /** vec3: multiplies torso + arms. */
  readonly accent: THREE.InstancedBufferAttribute;
  /** vec4: legSwing, armSwing, bob, aimPitch — all radians except bob (metres). */
  readonly pose: THREE.InstancedBufferAttribute;
}

/**
 * Attach the four per-instance attributes to a geometry. The geometry object
 * itself is shared, so this clones the attribute set onto a per-consumer
 * BufferGeometry that reuses the shared vertex buffers by reference.
 */
export function addInstanceAttributes(capacity: number): {
  geometry: THREE.BufferGeometry; buffers: InstanceBuffers;
} {
  const shared = sharedCharacterGeometry();
  const g = new THREE.BufferGeometry();
  // Reference, not copy: 216 vertices of position/uv/pivot/zone/shade exist
  // exactly once in memory no matter how many batches there are.
  for (const name of ['position', 'aUv', 'aPivot', 'aZone', 'aShade']) {
    g.setAttribute(name, shared.getAttribute(name));
  }
  g.setIndex(shared.getIndex());
  g.boundingSphere = shared.boundingSphere;
  g.boundingBox = shared.boundingBox;

  const mk = (size: number): THREE.InstancedBufferAttribute => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  };
  const buffers: InstanceBuffers = {
    donor: mk(4), tint: mk(3), accent: mk(3), pose: mk(4),
  };
  g.setAttribute('iDonor', buffers.donor);
  g.setAttribute('iTint', buffers.tint);
  g.setAttribute('iAccent', buffers.accent);
  g.setAttribute('iPose', buffers.pose);
  return { geometry: g, buffers };
}

/* ------------------------------------------------------------------------ *
 * The atlas
 * ------------------------------------------------------------------------ */

let atlasTexture: THREE.Texture | null = null;
let atlasPromise: Promise<THREE.Texture> | null = null;

/**
 * Fetch the outfit atlas. 65 KB, and it is deliberately NOT in the JS bundle:
 * the menu must be interactive before this is even requested (ref/BAR.md — our
 * 0.3 s time-to-interactive against the bar's 3.16 s is a measured advantage
 * and is not for sale). Until it resolves, every character draws in flat
 * palette colour, which is the same silhouette and the same one draw call.
 *
 * Idempotent: call it from the menu, from the editor and from the match; the
 * texture is created once.
 */
export function loadCharacterAtlas(baseUrl = ''): Promise<THREE.Texture> {
  if (atlasPromise !== null) return atlasPromise;
  atlasPromise = new Promise<THREE.Texture>((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = (): void => {
      const t = new THREE.Texture(img);
      // Hard-edged, no mips: the world is a nearest-filtered voxel atlas and a
      // bilinear character in front of it reads as a decal from another game.
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      // glTF UVs are top-down and this atlas was packed top-down to match.
      t.flipY = false;
      t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      atlasTexture = t;
      resolve(t);
    };
    img.onerror = (): void => reject(new Error('character atlas failed to load'));
    img.src = `${baseUrl}${ATLAS_URL}`;
  });
  return atlasPromise;
}

/** The atlas if it has already arrived, else null. Never triggers a fetch. */
export function characterAtlas(): THREE.Texture | null { return atlasTexture; }

/* ------------------------------------------------------------------------ *
 * Material
 * ------------------------------------------------------------------------ */

const CELL_U = (1 / ATLAS_COLS).toFixed(8);
const CELL_COLS = ATLAS_COLS.toFixed(1);

const CHAR_VERT = /* glsl */ `
precision highp float;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

/** Right arm rest angle: held forward with a weapon, not swinging by the hip. */
const float ARM_HOLD = -1.28;

in vec3 position;
in vec2 aUv;      // already folded into atlas cell 0
in vec3 aPivot;   // the point this vertex's part rotates about
in float aZone;   // 0 head, 1 torso, 2 arms, 3 legs
in float aShade;  // baked flat-face ramp, matching the voxel mesher

in mat4 instanceMatrix;
in vec4 iDonor;   // atlas cell per zone
in vec3 iTint;    // multiplies head + legs
in vec3 iAccent;  // multiplies torso + arms
in vec4 iPose;    // legSwing, armSwing, bob, aimPitch

out vec2 vUv;
out vec3 vColor;
out float vFogDepth;

vec3 rotX(vec3 p, float a) {
  float s = sin(a), c = cos(a);
  return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
}

void main() {
  // --- skeleton, six rigid rotations, no matrices ------------------------
  // side is +1 for the left half of the body, -1 for the right, 0 for the
  // centreline parts. It comes free from the pivot: Kenney puts leg-left at
  // x = +0.2 and arm-left at x = +0.4, mirrored on the right.
  float side = sign(aPivot.x);
  float isLegs = step(2.5, aZone);
  float isArms = step(1.5, aZone) * (1.0 - isLegs);
  float isHead = 1.0 - step(0.5, aZone);
  float isLeft = step(0.5, side);

  // Legs counter-swing; arms counter the legs. The right arm ignores the swing
  // entirely and holds the weapon forward, tracking the owner's aim — that is
  // what makes a distant player read as ARMED rather than as a pedestrian.
  float legAngle = iPose.x * side;
  float armLeft = -iPose.y;
  float armRight = ARM_HOLD - iPose.w;
  float armAngle = mix(armRight, armLeft, isLeft);
  float headAngle = -iPose.w * 0.65;

  float angle = legAngle * isLegs + armAngle * isArms + headAngle * isHead;
  vec3 local = rotX(position - aPivot, angle) + aPivot;
  local.y += iPose.z;

  vec4 mv = modelViewMatrix * instanceMatrix * vec4(local, 1.0);
  gl_Position = projectionMatrix * mv;
  vFogDepth = length(mv.xyz);

  // --- outfit ------------------------------------------------------------
  // Pick this zone's atlas cell without a dynamic index: a 4-way equality mask
  // and one dot, which every GLSL ES target compiles to a select.
  vec4 sel = vec4(equal(vec4(aZone), vec4(0.0, 1.0, 2.0, 3.0)));
  float cell = dot(iDonor, sel);
  float col = mod(cell, ${CELL_COLS});
  float row = floor(cell / ${CELL_COLS});
  vUv = aUv + vec2(col * ${CELL_U}, row * ${(1 / ATLAS_ROWS).toFixed(8)});

  // Accent dresses the uniform (torso + arms); tint dresses skin and boots.
  float body = isArms + (1.0 - isArms) * (1.0 - isHead) * (1.0 - isLegs);
  vColor = mix(iTint, iAccent, body) * aShade;
}
`;

const CHAR_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;

uniform sampler2D uAtlas;
uniform float uHasAtlas;
/** Shared, by reference, with VoxelMaterials — see attachWorldGrade(). */
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform float uFogStart;
uniform vec3  uTint;
uniform float uContrast;
uniform float uSaturation;
uniform float uExposure;
/**
 * Readability lift. DOOM 1993 lights its sprites brighter than its walls on
 * purpose, and ref/BAR.md's finding is that our scenes are murky in the
 * mid-ground. Characters therefore take the world's grade but with a small gain
 * in front of it and a slightly thinner fog, so a marine at 40 m is still a
 * marine and not a smudge the colour of the corridor.
 */
uniform float uActorGain;
uniform float uActorFog;

in vec2 vUv;
in vec3 vColor;
in float vFogDepth;

out vec4 fragColor;

void main() {
  vec3 tex = mix(vec3(0.62, 0.60, 0.58), texture(uAtlas, vUv).rgb, uHasAtlas);
  vec3 c = tex * vColor * uTint * uActorGain;

  c *= uExposure;
  c = clamp(c, 0.0, 1.0);
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(lum), c, uSaturation);
  c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);

  float fd = max(vFogDepth - uFogStart, 0.0) * uFogDensity;
  float fog = clamp(1.0 - exp(-fd * fd), 0.0, 1.0) * uActorFog;
  c = mix(c, uFogColor, fog);

  fragColor = vec4(c, 1.0);
}
`;

/** The subset of `VoxelMaterials` a character material borrows uniforms from. */
export interface WorldGradeSource {
  readonly uniforms: Record<string, THREE.IUniform>;
}

export interface CharacterMaterialOptions {
  /**
   * Share fog and grade uniform OBJECTS with the world material. Not values —
   * the same `IUniform` instances, so a palette change, a fog range change or a
   * hurt-flash tint reaches the characters with no sync code and no chance of
   * the two drifting a frame apart.
   */
  grade?: WorldGradeSource | null;
  /** Default 1.18. See uActorGain. */
  actorGain?: number;
  /** Default 0.88. See uActorFog. */
  actorFog?: number;
}

/**
 * One material for every character on screen. There is no per-player material
 * and there never can be: colour arrives as an instanced attribute.
 */
export function createCharacterMaterial(opts: CharacterMaterialOptions = {}): THREE.RawShaderMaterial {
  const g = opts.grade?.uniforms;
  const borrow = (name: string, fallback: THREE.IUniform): THREE.IUniform =>
    (g !== undefined && g[name] !== undefined ? g[name] : fallback);

  const m = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: CHAR_VERT,
    fragmentShader: CHAR_FRAG,
    uniforms: {
      uAtlas: { value: atlasTexture },
      uHasAtlas: { value: atlasTexture === null ? 0 : 1 },
      uFogColor: borrow('uFogColor', { value: new THREE.Vector3(0.231, 0.165, 0.141) }),
      uFogDensity: borrow('uFogDensity', { value: 0 }),
      uFogStart: borrow('uFogStart', { value: 0 }),
      uTint: borrow('uTint', { value: new THREE.Vector3(1, 1, 1) }),
      uContrast: borrow('uContrast', { value: 0.26 }),
      uSaturation: borrow('uSaturation', { value: 0.8 }),
      uExposure: borrow('uExposure', { value: 1 }),
      uActorGain: { value: opts.actorGain ?? 1.18 },
      uActorFog: { value: opts.actorFog ?? 0.88 },
    },
    transparent: false,
    depthWrite: true,
    side: THREE.FrontSide,
  });
  m.name = 'character';
  return m;
}

/** Point a material at the atlas once it lands. Safe to call repeatedly. */
export function bindAtlas(material: THREE.RawShaderMaterial): void {
  const t = atlasTexture;
  if (t === null || material.uniforms.uAtlas.value === t) return;
  material.uniforms.uAtlas.value = t;
  material.uniforms.uHasAtlas.value = 1;
  material.uniformsNeedUpdate = true;
}

/* ------------------------------------------------------------------------ *
 * Pose
 * ------------------------------------------------------------------------ */

/** Everything the shader needs to know about what a body is doing. */
export interface PoseInput {
  /** Horizontal speed, m/s. Drives stride length and cadence. */
  speed: number;
  /** Monotonic gait phase in radians. Kept by the caller, per body. */
  phase: number;
  /** Look pitch, radians. Positive is up (shared/math.ts). */
  pitch: number;
  /** 0 alive, 1 fully collapsed. */
  dead: number;
  /** Seconds, for the idle breath. */
  time: number;
}

const SCRATCH_POSE = new Float32Array(4);

/**
 * Turn one body's state into the four floats the vertex shader poses from.
 *
 * The clips shipped in the GLB (`walk`, `idle`, `holding-right-shoot`, ...) are
 * not used, and deliberately: they are per-node TRS tracks that would need an
 * AnimationMixer and one Object3D per player, which is the whole cost this
 * design exists to avoid. Six rigid rotations reproduce the readable part of
 * them — stride, counter-swing, breath, weapon carry — in four floats.
 */
export function computePose(p: PoseInput): Float32Array {
  const out = SCRATCH_POSE;
  // Stride grows with speed and then stops growing, so a sprint reads as faster
  // cadence rather than as the splits.
  const gait = Math.min(1, p.speed / 5.5);
  const swing = Math.sin(p.phase) * (0.15 + gait * 0.65);
  const breath = Math.sin(p.time * 1.9) * 0.035;

  out[0] = swing;                                     // legs, mirrored by side
  out[1] = swing * 0.75 + breath;                     // left arm counter-swing
  out[2] = Math.abs(Math.sin(p.phase)) * gait * 0.06  // stride bob
         + breath * 0.4;
  out[3] = p.pitch;

  if (p.dead > 0) {
    // Collapse: the legs fold, the arms drop, the head lolls. The body's fall
    // to the floor is in the instance matrix, not here.
    const d = p.dead;
    out[0] = swing * (1 - d) + d * 0.9;
    out[1] = out[1] * (1 - d) + d * 1.1;
    out[2] = out[2] * (1 - d);
    out[3] = p.pitch * (1 - d) - d * 0.5;
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * The batch
 * ------------------------------------------------------------------------ */

const paletteRgb = new Float32Array(PALETTE_COUNT * 3);
for (let i = 0; i < PALETTE_COUNT; i++) {
  const hex = AVATAR_PALETTE[i].hex;
  // Multiplier colours are authored in sRGB and multiply an sRGB-decoded
  // texture, so they are decoded the same way or a "white" tint darkens.
  paletteRgb[i * 3 + 0] = srgbToLinear(((hex >> 16) & 0xff) / 255);
  paletteRgb[i * 3 + 1] = srgbToLinear(((hex >> 8) & 0xff) / 255);
  paletteRgb[i * 3 + 2] = srgbToLinear((hex & 0xff) / 255);
}

function srgbToLinear(c: number): number {
  return c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const SCRATCH_CFG: AvatarConfig = { zones: [0, 0, 0, 0], tint: 0, accent: 0 };

/**
 * A pile of characters that draws in one call.
 *
 * Usage per frame: `begin()`, then `push(...)` per visible body, then `end()`.
 * Nothing allocates after construction.
 */
export class CharacterBatch {
  readonly mesh: THREE.InstancedMesh;
  readonly material: THREE.RawShaderMaterial;
  private readonly buffers: InstanceBuffers;
  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly euler = new THREE.Euler();
  private readonly scaleVec = new THREE.Vector3();
  private readonly capacity: number;
  private count = 0;

  constructor(capacity = CHARACTER_CAPACITY, opts: CharacterMaterialOptions = {}) {
    this.capacity = capacity;
    const { geometry, buffers } = addInstanceAttributes(capacity);
    this.buffers = buffers;
    this.material = createCharacterMaterial(opts);
    this.mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'characters';
    this.mesh.count = 0;
  }

  get drawn(): number { return this.count; }

  begin(): void {
    this.count = 0;
    bindAtlas(this.material);
  }

  /**
   * Add one body.
   *
   * @param packedAvatar the wire uint32 from `avatar.ts`
   * @param dead 0..1 collapse, which tips the whole body onto its face
   * @param flash 0..1 white-out for a hit, folded into the tint so no extra
   *              attribute and no extra draw call is needed
   */
  push(
    x: number, y: number, z: number, yaw: number,
    packedAvatar: number, pose: Float32Array, dead = 0, flash = 0, scale = CHARACTER_SCALE,
  ): void {
    if (this.count >= this.capacity) return;
    const i = this.count++;

    this.pos.set(x, y, z);
    // A dead body pitches forward onto its face about its own feet.
    this.euler.set(dead * -Math.PI * 0.5, yaw + MODEL_YAW_OFFSET, 0, 'YXZ');
    this.quat.setFromEuler(this.euler);
    this.scaleVec.setScalar(scale);
    this.matrix.compose(this.pos, this.quat, this.scaleVec);
    this.mesh.setMatrixAt(i, this.matrix);

    const cfg = unpackAvatar(packedAvatar, SCRATCH_CFG);
    const d = this.buffers.donor.array as Float32Array;
    for (let z2 = 0; z2 < ZONE_COUNT; z2++) {
      d[i * 4 + z2] = cfg.zones[z2] < DONOR_COUNT ? cfg.zones[z2] : 0;
    }

    const t = this.buffers.tint.array as Float32Array;
    const a = this.buffers.accent.array as Float32Array;
    writeTint(t, i, cfg.tint, flash);
    writeTint(a, i, cfg.accent, flash);

    const po = this.buffers.pose.array as Float32Array;
    po[i * 4 + 0] = pose[0];
    po[i * 4 + 1] = pose[1];
    po[i * 4 + 2] = pose[2];
    po[i * 4 + 3] = pose[3];
  }

  end(): void {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.buffers.donor.needsUpdate = true;
    this.buffers.tint.needsUpdate = true;
    this.buffers.accent.needsUpdate = true;
    this.buffers.pose.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}

function writeTint(dst: Float32Array, i: number, index: number, flash: number): void {
  const k = index >= 0 && index < PALETTE_COUNT ? index : 0;
  const f = flash > 0 ? (flash > 1 ? 1 : flash) : 0;
  dst[i * 3 + 0] = paletteRgb[k * 3 + 0] + (2.2 - paletteRgb[k * 3 + 0]) * f;
  dst[i * 3 + 1] = paletteRgb[k * 3 + 1] + (2.2 - paletteRgb[k * 3 + 1]) * f;
  dst[i * 3 + 2] = paletteRgb[k * 3 + 2] + (2.2 - paletteRgb[k * 3 + 2]) * f;
}

/* ------------------------------------------------------------------------ *
 * The in-game renderer
 * ------------------------------------------------------------------------ */

/** The slice of `NetClient` this needs. Structural so `Game` stays untyped here. */
export interface RemoteBodySource {
  readonly playerId: number;
  readonly players: readonly {
    id: number; active: boolean; name: string; skin: number; avatar?: number;
    x: number; y: number; z: number; yaw: number; pitch: number;
    vx: number; vy: number; vz: number; health: number;
  }[];
}

const MAX_TRACKED = 64;

/**
 * Draws every remote player. One instance of this exists per `Game`, it owns
 * exactly one `InstancedMesh`, and it adds exactly one draw call to the frame
 * no matter how many players are in the match.
 */
export class ThirdPersonRenderer {
  readonly batch: CharacterBatch;
  /** Gait phase per player slot. Time-based phase stutters when a body stops. */
  private readonly phase = new Float32Array(MAX_TRACKED);
  /** Collapse progress per slot, so a corpse falls over instead of popping. */
  private readonly collapse = new Float32Array(MAX_TRACKED);
  private lastTime = 0;

  /**
   * The LOCAL player's own body, drawn only when something is looking at it —
   * today that is the death camera in `game.ts` and nothing else, because the
   * game is otherwise first-person. It rides in the same batch as every remote
   * body, so seeing your own corpse costs zero extra draw calls; set it to null
   * and the instance simply is not emitted.
   */
  localBody: {
    x: number; y: number; z: number; yaw: number; pitch: number;
    avatar: number; dead: number;
  } | null = null;

  constructor(scene: THREE.Scene, opts: CharacterMaterialOptions = {}) {
    this.batch = new CharacterBatch(CHARACTER_CAPACITY, opts);
    scene.add(this.batch.mesh);
  }

  /** Draw calls this renderer contributes. Always 0 or 1. */
  get drawCalls(): number { return this.batch.drawn > 0 ? 1 : 0; }

  update(net: RemoteBodySource, time: number): void {
    const dt = this.lastTime === 0 ? 0 : Math.min(0.1, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    this.batch.begin();

    const players = net.players;
    const n = players.length < MAX_TRACKED ? players.length : MAX_TRACKED;
    for (let i = 0; i < n; i++) {
      const p = players[i];
      if (!p.active || p.id === net.playerId) continue;

      const speed = Math.hypot(p.vx, p.vz);
      const alive = p.health > 0;

      // Cadence, not clock: 2.05 rad per metre travelled means the stride
      // length is constant and the legs never skate.
      this.phase[i] += speed * dt * 2.05;
      if (speed < 0.15) {
        // Ease back to a neutral stance rather than freezing mid-stride.
        const rest = Math.round(this.phase[i] / Math.PI) * Math.PI;
        this.phase[i] += (rest - this.phase[i]) * Math.min(1, dt * 8);
      }

      const target = alive ? 0 : 1;
      this.collapse[i] += (target - this.collapse[i]) * Math.min(1, dt * (alive ? 12 : 5));
      if (!alive && this.collapse[i] > 0.995) this.collapse[i] = 1;

      const pose = computePose({
        speed, phase: this.phase[i], pitch: p.pitch,
        dead: this.collapse[i], time,
      });
      const avatar = p.avatar ?? 0;
      this.batch.push(p.x, p.y, p.z, p.yaw, avatar, pose, this.collapse[i]);
    }

    const own = this.localBody;
    if (own !== null) {
      const pose = computePose({
        speed: 0, phase: 0, pitch: own.pitch, dead: own.dead, time,
      });
      this.batch.push(own.x, own.y, own.z, own.yaw, own.avatar, pose, own.dead);
    }

    this.batch.end();
  }

  dispose(): void { this.batch.dispose(); }
}

/* ------------------------------------------------------------------------ *
 * A single posed model, for the editor preview and any future death camera
 * ------------------------------------------------------------------------ */

/**
 * One character, one draw call, no net client. This is what the avatar editor
 * puts in front of you and what a death camera would orbit.
 */
export class CharacterActor {
  readonly batch: CharacterBatch;
  private packed = 0;
  private phaseAcc = 0;

  constructor(scene: THREE.Scene, opts: CharacterMaterialOptions = {}) {
    this.batch = new CharacterBatch(1, opts);
    scene.add(this.batch.mesh);
  }

  setAvatar(packed: number): void { this.packed = packed >>> 0; }

  /**
   * @param walk 0 = idle breathing on the spot, 1 = walking. The preview walks
   *   on the spot so the player can see how the outfit reads in motion, which
   *   is the state it will actually be seen in.
   */
  update(time: number, dt: number, yaw: number, walk = 0, scale = CHARACTER_SCALE): void {
    this.phaseAcc += dt * (1.6 + walk * 7.4);
    const pose = computePose({
      speed: walk * 4.2, phase: this.phaseAcc, pitch: 0, dead: 0, time,
    });
    this.batch.begin();
    this.batch.push(0, 0, 0, yaw, this.packed, pose, 0, 0, scale);
    this.batch.end();
  }

  dispose(): void { this.batch.dispose(); }
}

/* ------------------------------------------------------------------------ *
 * Zone helper, exported for the editor's part list
 * ------------------------------------------------------------------------ */

/** Which of the rig's six meshes a zone owns. Reported, not guessed. */
export const ZONE_MESHES: Readonly<Record<Zone, readonly string[]>> = Object.freeze({
  [Zone.HEAD]: ['head'],
  [Zone.TORSO]: ['torso'],
  [Zone.ARMS]: ['arm-left', 'arm-right'],
  [Zone.LEGS]: ['leg-left', 'leg-right'],
});
