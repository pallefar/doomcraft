/**
 * DOOMCRAFT — character asset load, merge and animation bake.
 *
 * Loads ONE rig (`characters/cast.glb`) and ONE skin atlas
 * (`characters/cast.png`), produced by `tools/pack-characters.mjs`, and turns
 * them into the three things the renderer needs: a single merged geometry, a
 * single shared material, and animation clips baked to flat float arrays.
 *
 * THE DRAW-CALL PROBLEM, AND WHAT IS ACTUALLY DONE ABOUT IT
 *
 * vendor/kenney-blocky-characters/README.md states the constraint: six meshes
 * per character is six draw calls per character unless they are merged, and
 * eight visible enemies at six calls each is 48 draw calls against a budget the
 * Horde mode already fills at 124. Merging each character to one mesh gets that
 * to eight. That is still eight more than the box renderer it replaces, which
 * drew the entire cast — players, demons, pickups, projectiles — from ONE
 * InstancedMesh.
 *
 * So the merge here goes one step further. The six parts are concatenated into
 * a single geometry in which every vertex carries the index of the part it
 * belongs to (`aPart`). An *instance* is then one PART of one character rather
 * than a whole character: its `instanceMatrix` is that part's world matrix and
 * its `aInstPart` says which part it is. The vertex shader collapses every
 * vertex whose `aPart` disagrees to a point, so each instance rasterises only
 * its own 12 triangles.
 *
 * The result is one draw call for the whole cast at any population, not one per
 * character. The price is that each instance runs the vertex shader over all
 * 143 vertices of the rig instead of its own ~24 — a 6x vertex-shading
 * overdraw on a 72-triangle model, which at 24 characters is 20k vertex
 * invocations against the ~300k a voxel scene already pushes. Trading vertex
 * invocations for draw calls is the correct direction on this engine: draw
 * calls track `game.medianMs` almost linearly, vertices do not.
 *
 * This is only possible because the pack has NO `skins` array — the characters
 * are rigid parts driven by node TRS tracks, not GPU-skinned meshes. A skinned
 * cast would need a bone texture and could not use `instanceMatrix` this way.
 *
 * PAYLOAD
 *
 * Nothing here is on the critical path. `loadCharacterAssets()` is called after
 * first interactivity and the GLTFLoader itself is a dynamic import, so a
 * player who never sees a monster never downloads either. Total added transfer
 * is the 38.6 KB GLB, the 8.9 KB atlas, and the GLTFLoader chunk.
 */

import * as THREE from 'three';
import { FACE_SHADE, SUN_DIR_X, SUN_DIR_Y, SUN_DIR_Z } from '@doomcraft/shared';
import {
  ATLAS_COLS,
  ATLAS_ROWS,
  PART_COUNT,
  PART_NAMES,
} from './registry';

/* ------------------------------------------------------------------ *
 * Baked animation
 * ------------------------------------------------------------------ */

/**
 * Nodes whose local transform is baked. `root` is index 0 and is the parent of
 * the legs and the torso; it is animated (walk and die both translate it), so
 * it cannot be folded away.
 */
export const RIG_NODE_NAMES = ['root', ...PART_NAMES] as const;
export const RIG_NODE_COUNT = RIG_NODE_NAMES.length;
/** Parent index per rig node; -1 is the character origin. */
export const RIG_PARENT = Int8Array.from([-1, 0, 0, 0, 3, 3, 3]);
/** Rig-node index of each renderable part, in PART_NAMES order. */
export const PART_NODE = Int8Array.from([1, 2, 3, 4, 5, 6]);

/** Floats per node per frame: position 3, quaternion 4, scale 3. */
export const TRS_STRIDE = 10;
/** Floats per baked frame. */
export const FRAME_STRIDE = RIG_NODE_COUNT * TRS_STRIDE;
/** Bake rate. 30 Hz over clips of 0.17-1.33 s is 134 frames for the whole cast. */
export const BAKE_HZ = 30;
/** How far inside the clip the final frame is sampled. See `bakeClips`. */
const LAST_FRAME_EPS = 1e-4;

export interface BakedClip {
  readonly name: string;
  /** First frame index into `CharacterAssets.frames`. */
  readonly first: number;
  /** Number of baked frames, including the duplicated loop-closing frame. */
  readonly count: number;
  readonly duration: number;
  /**
   * Bit per rig node this clip actually animates, taken from the glTF channel
   * list. The upper-body layer blends only these, which is what lets
   * `holding-right` (arm-right alone) ride on top of `walk` without flattening
   * the walk's torso sway.
   */
  readonly mask: number;
}

/* ------------------------------------------------------------------ *
 * Assets
 * ------------------------------------------------------------------ */

export interface CharacterAssets {
  /** All six parts in one buffer, tagged per vertex with `aPart`. */
  readonly geometry: THREE.BufferGeometry;
  /** The one material every character in the game shares. */
  readonly material: THREE.MeshBasicMaterial;
  readonly texture: THREE.Texture;
  /** Baked local TRS, [frame][node][pos3 quat4 scale3]. */
  readonly frames: Float32Array;
  readonly clips: ReadonlyMap<string, BakedClip>;
  /** Rest-pose local TRS of the seven rig nodes, same layout as one frame. */
  readonly rest: Float32Array;
  /** Axis-aligned bounds of each part's raw geometry, [minX,minY,minZ,maxX,maxY,maxZ]. */
  readonly partBounds: Float32Array;
  dispose(): void;
}

export interface CharacterAssetOptions {
  /** Base URL the packer wrote to. Trailing slash included. */
  baseUrl?: string;
  /**
   * Uniform objects to SHARE with the world material, so fog and the hurt tint
   * track the terrain with no per-frame copying. Pass
   * `VoxelMaterials.uniforms`.
   */
  worldUniforms?: Record<string, THREE.IUniform>;
}

const DEFAULT_BASE = 'characters/';

let pending: Promise<CharacterAssets> | null = null;
let cached: CharacterAssets | null = null;
let cachedKey = '';

/** The assets, if a previous load already finished. Never triggers a load. */
export function peekCharacterAssets(): CharacterAssets | null { return cached; }

/**
 * Load (or return the in-flight load of) the character assets. Cached by URL:
 * every mode, every archetype and every player share one geometry, one
 * material and one texture.
 */
export function loadCharacterAssets(opts: CharacterAssetOptions = {}): Promise<CharacterAssets> {
  const base = opts.baseUrl ?? DEFAULT_BASE;
  if (cached !== null && cachedKey === base) return Promise.resolve(cached);
  if (pending !== null && cachedKey === base) return pending;
  cachedKey = base;
  pending = build(base, opts.worldUniforms).then((a) => {
    cached = a;
    pending = null;
    return a;
  }).catch((err) => {
    pending = null;
    cachedKey = '';
    throw err;
  });
  return pending;
}

/** Drop the cache. Tests and teardown only. */
export function resetCharacterAssets(): void {
  cached?.dispose();
  cached = null;
  pending = null;
  cachedKey = '';
}

async function build(
  base: string,
  worldUniforms: Record<string, THREE.IUniform> | undefined,
): Promise<CharacterAssets> {
  // Dynamic: GLTFLoader is ~50 KB of parser that the menu must never wait for.
  const [{ GLTFLoader }, texture] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    loadAtlas(`${base}cast.png`),
  ]);

  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(`${base}cast.glb`);
  const scene = gltf.scene;

  /* --- the seven rig nodes ------------------------------------------ */
  const nodes: THREE.Object3D[] = [];
  for (const name of RIG_NODE_NAMES) {
    const n = scene.getObjectByName(name);
    if (n === undefined) throw new Error(`cast.glb has no node "${name}"`);
    nodes.push(n);
  }
  // The hierarchy the bake assumes. Assert it rather than trust it: a repacked
  // GLB with a different parenting would silently animate the arms off the body.
  for (let i = 0; i < RIG_NODE_COUNT; i++) {
    const want = RIG_PARENT[i] < 0 ? null : nodes[RIG_PARENT[i]];
    const got = nodes[i].parent;
    if (want !== null && got !== want) {
      throw new Error(`cast.glb: "${RIG_NODE_NAMES[i]}" is parented to "${got?.name ?? 'nothing'}", expected "${want.name}"`);
    }
  }

  const rest = new Float32Array(FRAME_STRIDE);
  writePose(nodes, rest, 0);

  /* --- merged geometry ---------------------------------------------- */
  const { geometry, partBounds } = mergeParts(scene);

  /* --- baked clips --------------------------------------------------- */
  const { frames, clips } = bakeClips(scene, gltf.animations, nodes);

  /* --- the one shared material --------------------------------------- */
  const material = makeCharacterMaterial(texture, worldUniforms);

  // The loaded scene was only ever a source of vertices and keyframes.
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    mesh.geometry.dispose();
    const m = mesh.material;
    if (Array.isArray(m)) for (const x of m) x.dispose();
    else m.dispose();
  });

  return {
    geometry,
    material,
    texture,
    frames,
    clips,
    rest,
    partBounds,
    dispose(): void {
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Atlas
 * ------------------------------------------------------------------ */

function loadAtlas(url: string): Promise<THREE.Texture> {
  return new THREE.TextureLoader().loadAsync(url).then((tex) => {
    // Nearest with no mipmaps is not a shortcut here, it is the art direction:
    // the world is hard-edged flat-shaded voxels and the skins are authored at
    // Minecraft's native 64 px. It also makes the atlas safe — nearest sampling
    // can never blend one cell into its neighbour, so no padding is needed.
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 1;
    tex.flipY = false;
    tex.needsUpdate = true;
    return tex;
  });
}

/* ------------------------------------------------------------------ *
 * Merge
 * ------------------------------------------------------------------ */

function mergeParts(scene: THREE.Object3D): {
  geometry: THREE.BufferGeometry;
  partBounds: Float32Array;
} {
  const sources: THREE.BufferGeometry[] = [];
  for (const name of PART_NAMES) {
    const node = scene.getObjectByName(name);
    const mesh = node as THREE.Mesh | undefined;
    if (mesh === undefined || mesh.isMesh !== true) {
      throw new Error(`cast.glb: part "${name}" is not a mesh`);
    }
    sources.push(mesh.geometry);
  }

  let vertexCount = 0;
  let indexCount = 0;
  for (const g of sources) {
    vertexCount += g.attributes.position.count;
    const idx = g.getIndex();
    if (idx === null) throw new Error('cast.glb: a part is not indexed');
    indexCount += idx.count;
  }

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const part = new Float32Array(vertexCount);
  const index = new Uint16Array(indexCount);
  const partBounds = new Float32Array(PART_COUNT * 6);

  let vo = 0;
  let io = 0;
  for (let p = 0; p < sources.length; p++) {
    const g = sources[p];
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nrm = g.attributes.normal as THREE.BufferAttribute;
    const tex = g.attributes.uv as THREE.BufferAttribute;
    const idx = g.getIndex() as THREE.BufferAttribute;
    const n = pos.count;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      position[(vo + i) * 3] = x;
      position[(vo + i) * 3 + 1] = y;
      position[(vo + i) * 3 + 2] = z;
      normal[(vo + i) * 3] = nrm.getX(i);
      normal[(vo + i) * 3 + 1] = nrm.getY(i);
      normal[(vo + i) * 3 + 2] = nrm.getZ(i);
      uv[(vo + i) * 2] = tex.getX(i);
      uv[(vo + i) * 2 + 1] = tex.getY(i);
      part[vo + i] = p;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    partBounds.set([minX, minY, minZ, maxX, maxY, maxZ], p * 6);

    for (let i = 0; i < idx.count; i++) index[io + i] = idx.getX(i) + vo;
    vo += n;
    io += idx.count;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  // Bounds are meaningless for this geometry: every instance is one part of one
  // character somewhere in a 416 m arena. Culling is done per character on the
  // CPU instead (see characterRenderer.ts).
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(-1e6, -1e6, -1e6), new THREE.Vector3(1e6, 1e6, 1e6),
  );
  return { geometry, partBounds };
}

/* ------------------------------------------------------------------ *
 * Bake
 * ------------------------------------------------------------------ */

function writePose(nodes: readonly THREE.Object3D[], out: Float32Array, frame: number): void {
  const base = frame * FRAME_STRIDE;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const o = base + i * TRS_STRIDE;
    out[o] = n.position.x; out[o + 1] = n.position.y; out[o + 2] = n.position.z;
    out[o + 3] = n.quaternion.x; out[o + 4] = n.quaternion.y;
    out[o + 5] = n.quaternion.z; out[o + 6] = n.quaternion.w;
    out[o + 7] = n.scale.x; out[o + 8] = n.scale.y; out[o + 9] = n.scale.z;
  }
}

/**
 * Sample every clip onto a fixed 30 Hz grid of LOCAL node transforms.
 *
 * Local, not model-space, on purpose. Local transforms compose and therefore
 * blend: the rig can run `walk` on the legs and `holding-right` on the gun arm
 * at the same time, which is how the Trooper walks with its rifle up. Baked
 * model-space matrices cannot do that — an arm pose baked against a still torso
 * detaches the moment the torso turns.
 *
 * three's own AnimationMixer does the sampling, so glTF interpolation semantics
 * are exact rather than reimplemented.
 *
 * Exported for `characters.test.ts`, which drives it with a hand-built clip to
 * hold the LoopRepeat wrap bug below closed. It has no other caller.
 */
export function bakeClips(
  scene: THREE.Object3D,
  animations: readonly THREE.AnimationClip[],
  nodes: readonly THREE.Object3D[],
): { frames: Float32Array; clips: Map<string, BakedClip> } {
  const mixer = new THREE.AnimationMixer(scene);
  const clips = new Map<string, BakedClip>();

  let total = 0;
  const counts: number[] = [];
  for (const clip of animations) {
    const n = Math.max(2, Math.round(clip.duration * BAKE_HZ) + 1);
    counts.push(n);
    total += n;
  }

  const frames = new Float32Array(total * FRAME_STRIDE);
  let first = 0;
  for (let c = 0; c < animations.length; c++) {
    const clip = animations[c];
    const count = counts[c];

    // Which rig nodes this clip touches, straight off the track names
    // ("arm-right.quaternion"). Deriving it from the channel list rather than
    // from the sampled data means a track that happens to hold still for a
    // whole clip is still counted as owned by it.
    let mask = 0;
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.');
      const node = dot < 0 ? track.name : track.name.slice(0, dot);
      const i = (RIG_NODE_NAMES as readonly string[]).indexOf(node);
      if (i >= 0) mask |= 1 << i;
    }

    const action = mixer.clipAction(clip);
    mixer.stopAllAction();
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.play();

    const step = count > 1 ? clip.duration / (count - 1) : 0;
    for (let f = 0; f < count; f++) {
      // BUG THIS FIXES — the reason for the epsilon, which is not cosmetic.
      //
      // `AnimationAction` under LoopRepeat wraps `t === duration` back to
      // `t === 0`, so sampling the last frame at exactly `duration` baked the
      // FIRST frame into it for every clip in the pack. For a loop that is
      // harmless (frame[n-1] === frame[0] IS the loop-closing frame). For
      // `die` it is fatal and it is exactly the thing rig.ts's header promises
      // cannot happen: the clip's final key is root.rotation
      // (0.707, 0, 0, -0.707), a 90-degree faceplant, and the wrap replaced it
      // with the standing rest pose. Every corpse in the game stood back up the
      // instant it hit the floor, and `Rig` holding its last frame forever held
      // the wrong one. Verified against the baked buffer, not assumed: before
      // this, `die`'s first and last baked root quaternion were both identity.
      //
      // A tenth of a millisecond inside the clip is past the last keyframe's
      // neighbourhood for a 30 Hz bake, so a real loop still closes on its own
      // first pose to within float noise.
      const t = f === count - 1 ? Math.max(0, clip.duration - LAST_FRAME_EPS) : f * step;
      mixer.setTime(0);
      mixer.setTime(t);
      writePose(nodes, frames, first + f);
    }
    clips.set(clip.name, { name: clip.name, first, count, duration: clip.duration, mask });
    first += count;
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(scene);
  return { frames, clips };
}

/* ------------------------------------------------------------------ *
 * The shared material
 * ------------------------------------------------------------------ */

/** How much a face pointing into the sun brightens. Azimuth only, no shadows. */
const SUN_BOOST = 0.20;

/**
 * ONE MeshBasicMaterial for every character in the game, patched with four
 * things the stock material does not do:
 *
 *   1. part selection  — collapse vertices that belong to another part
 *   2. atlas offset    — five skins in one texture, chosen per instance
 *   3. stepped shade   — the world's own FACE_SHADE ramp, rotated with the limb
 *   4. fog + hurt tint — SHARED uniform objects with the voxel material, so
 *                        distance haze and the damage flash match the terrain
 *                        with no per-frame copying
 *
 * Deliberately NOT applied: the world's desaturate/contrast grade. The voxel
 * shader's own comment says the grade exists "so muzzle flashes, lava and
 * enemies are the only saturated things on screen" — running it over the cast
 * as well would undo the readability it was written to create.
 */
function makeCharacterMaterial(
  texture: THREE.Texture,
  worldUniforms: Record<string, THREE.IUniform> | undefined,
): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    vertexColors: false,
    toneMapped: false,
    fog: false,
    side: THREE.FrontSide,
  });

  const uFogColor = worldUniforms?.uFogColor ?? { value: new THREE.Vector3(0.23, 0.16, 0.14) };
  const uFogDensity = worldUniforms?.uFogDensity ?? { value: 0 };
  const uFogStart = worldUniforms?.uFogStart ?? { value: 0 };
  const uTint = worldUniforms?.uTint ?? { value: new THREE.Vector3(1, 1, 1) };

  let sun = Math.hypot(SUN_DIR_X, SUN_DIR_Y, SUN_DIR_Z);
  if (sun < 1e-5) sun = 1;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFogColor = uFogColor;
    shader.uniforms.uFogDensity = uFogDensity;
    shader.uniforms.uFogStart = uFogStart;
    shader.uniforms.uWorldTint = uTint;
    shader.uniforms.uCell = { value: new THREE.Vector2(1 / ATLAS_COLS, 1 / ATLAS_ROWS) };
    // Light travels FROM the sun; the shade wants the direction TOWARD it.
    shader.uniforms.uSunDir = {
      value: new THREE.Vector3(-SUN_DIR_X / sun, -SUN_DIR_Y / sun, -SUN_DIR_Z / sun),
    };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aPart;
attribute float aInstPart;
attribute vec2 aSkinUv;
uniform vec2 uCell;
uniform vec3 uSunDir;
varying vec3 vShadeTint;
varying float vEyeDist;
`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  // One instance is one PART. Everything belonging to a different part folds to
  // a point and rasterises nothing, which is what buys one draw call for the
  // entire cast instead of one per character.
  if ( abs( aPart - aInstPart ) > 0.25 ) transformed = vec3( 0.0 );

  // The world's own stepped face ramp, rotated with the limb. Box normals stay
  // axis-aligned under the per-part stretch, so transforming by the matrix
  // rather than its inverse-transpose is exact here, not an approximation.
  vec3 wNormal = normalize( mat3( modelMatrix ) * ( mat3( instanceMatrix ) * normal ) );
  float wSum = abs( wNormal.x ) + abs( wNormal.y ) + abs( wNormal.z );
  float ramp =
      abs( wNormal.x ) * ${FACE_SHADE[0].toFixed(3)}
    + abs( wNormal.z ) * ${FACE_SHADE[4].toFixed(3)}
    + max( wNormal.y, 0.0 ) * ${FACE_SHADE[2].toFixed(3)}
    + max( -wNormal.y, 0.0 ) * ${FACE_SHADE[3].toFixed(3)};
  ramp /= max( wSum, 1e-4 );
  float shade = ramp * ( 1.0 + ${SUN_BOOST.toFixed(3)} * max( dot( wNormal, uSunDir ), 0.0 ) );
#ifdef USE_INSTANCING_COLOR
  // instanceColor carries the archetype tint and is deliberately allowed above
  // 1.0: an enemy has to read brighter than the wall behind it.
  vShadeTint = instanceColor * shade;
#else
  vShadeTint = vec3( shade );
#endif
`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
#ifdef USE_MAP
  vMapUv = vMapUv * uCell + aSkinUv;
#endif
`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
  // Radial, matching the voxel shader's length(mv.xyz) rather than -mv.z, or
  // the haze would step as you turn.
  vEyeDist = length( mvPosition.xyz );
`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogStart;
uniform vec3 uWorldTint;
varying vec3 vShadeTint;
varying float vEyeDist;
`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  diffuseColor.rgb *= vShadeTint * uWorldTint;
`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
  // The same hold-off-then-exp2 curve the voxel shader uses, reading the SAME
  // uniform objects, so a demon at 70 m sits in the same haze as the wall
  // behind it instead of being pasted on top of it.
  float fd = max( vEyeDist - uFogStart, 0.0 ) * uFogDensity;
  float fogAmount = clamp( 1.0 - exp( -fd * fd ), 0.0, 1.0 );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, uFogColor, fogAmount );
`);
  };
  material.customProgramCacheKey = () => 'doomcraft-character-v1';
  return material;
}
