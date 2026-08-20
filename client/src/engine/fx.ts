/**
 * DOOMCRAFT — pooled effects.
 *
 * ref/BAR.md weakness #2 and #3: the bar has no muzzle flash, no tracer, no
 * impact spark, no screen shake and no hitmarker. A shot in the bar produces
 * nothing you can see. Everything in this file exists to make a shot produce
 * something you can see, inside the frame budget.
 *
 * Rules the whole file obeys:
 *
 *  - **Five draw calls, total.** Sparks, debris, tracers, explosion shells and
 *    shockwave rings are each one instanced mesh with one material. Nothing here
 *    ever creates an Object3D at runtime.
 *  - **Zero allocation per frame.** Every pool is a struct-of-arrays of
 *    Float32Arrays sized at construction; spawning writes into a slot and
 *    removal is a swap with the last live element.
 *  - **Light is the effect.** A muzzle flash that does not light the wall beside
 *    you is a sprite, not a flash. Fx feeds a small light list into
 *    VoxelMaterials every frame, ranked by contribution at the camera.
 *  - **Shake is trauma-based** (Squirrel Eiserloh's model): events add trauma,
 *    trauma decays, and the displacement is trauma squared, so small hits are
 *    almost invisible and big ones are violent. It moves the camera, never the
 *    world, so nothing desyncs.
 */

import * as THREE from 'three';
import {
  blockFaceColor,
  clamp,
  Face,
  getWeapon,
  minimapColor,
  TAU,
} from '@doomcraft/shared';
import type { VoxelMaterials } from './material';

/* ------------------------------------------------------------------------ *
 * Shared shader pieces
 * ------------------------------------------------------------------------ */

const SPRITE_VERT = /* glsl */ `
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec2 aCorner;
in vec3 iPos;
in vec4 iParams;   // size, rotation, alpha, glow
in vec3 iColor;
out vec3 vColor;
out float vAlpha;
out float vGlow;
out vec2 vUv;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float s = iParams.x;
  float r = iParams.y;
  float cs = cos(r);
  float sn = sin(r);
  vec2 c = vec2(aCorner.x * cs - aCorner.y * sn, aCorner.x * sn + aCorner.y * cs) * s;
  mv.xy += c;
  gl_Position = projectionMatrix * mv;
  vColor = iColor;
  vAlpha = iParams.z;
  vGlow = iParams.w;
  vUv = aCorner;
}
`;

const SPRITE_FRAG = /* glsl */ `
precision mediump float;
in vec3 vColor;
in float vAlpha;
in float vGlow;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
void main() {
#ifdef SOFT
  float d = length(vUv) * 2.0;
  float a = clamp(1.0 - d, 0.0, 1.0);
  a *= a;
  vec3 c = mix(vColor, vec3(1.0), vGlow * a);
  fragColor = vec4(c, a * vAlpha);
#else
  // Hard-edged square: voxel debris should read as a chip of the block, not
  // as a puff of smoke.
  fragColor = vec4(vColor, vAlpha);
#endif
}
`;

const BEAM_VERT = /* glsl */ `
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec2 aCorner;    // x: 0..1 along, y: -0.5..0.5 across
in vec3 iA;
in vec3 iB;
in vec4 iParams;    // width, alpha, spare, spare
in vec3 iColor;
uniform float uPxScale;   // world units per screen pixel, per unit of view depth
out vec3 vColor;
out float vAlpha;
out vec2 vUv;
void main() {
  vec4 a = modelViewMatrix * vec4(iA, 1.0);
  vec4 b = modelViewMatrix * vec4(iB, 1.0);
  vec4 mv = mix(a, b, aCorner.x);
  vec2 dir = b.xy - a.xy;
  float l = length(dir);
  dir = l > 1e-4 ? dir / l : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  // A 3.5 cm tracer is sub-pixel at 40 m and vanishes exactly when you most
  // want to see where the shot went. Floor the width in screen space.
  float w = max(iParams.x, uPxScale * abs(mv.z));
  mv.xy += nrm * aCorner.y * w;
  gl_Position = projectionMatrix * mv;
  vColor = iColor;
  vAlpha = iParams.y;
  vUv = aCorner;
}
`;

const BEAM_FRAG = /* glsl */ `
precision mediump float;
in vec3 vColor;
in float vAlpha;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
void main() {
  float across = 1.0 - abs(vUv.y) * 2.0;
  across *= across;
  // Bright at the head, fading to the tail.
  float along = mix(0.25, 1.0, vUv.x);
  fragColor = vec4(vColor, across * along * vAlpha);
}
`;

const SHELL_VERT = /* glsl */ `
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;
in vec3 position;
in vec3 normal;
in vec3 iPos;
in vec4 iParams;   // radius, alpha, spare, spare
in vec3 iColor;
out vec3 vColor;
out float vAlpha;
out float vRim;
void main() {
  vec3 p = position * iParams.x + iPos;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  vec3 nv = normalize(normalMatrix * normal);
  vRim = pow(1.0 - abs(nv.z), 1.7);
  vColor = iColor;
  vAlpha = iParams.y;
}
`;

const SHELL_FRAG = /* glsl */ `
precision mediump float;
in vec3 vColor;
in float vAlpha;
in float vRim;
layout(location = 0) out vec4 fragColor;
void main() {
  fragColor = vec4(mix(vColor, vec3(1.0), vRim * 0.55), (0.20 + 0.80 * vRim) * vAlpha);
}
`;

const RING_VERT = /* glsl */ `
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
in vec2 uv;
in vec3 iPos;
in vec4 iParams;   // radius, alpha, spare, spare
in vec3 iColor;
out vec3 vColor;
out float vAlpha;
out vec2 vUv;
void main() {
  // RingGeometry lives in XY; lay it flat on the ground.
  vec3 p = vec3(position.x, 0.0, position.y) * iParams.x + iPos;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  vColor = iColor;
  vAlpha = iParams.y;
  vUv = uv;
}
`;

const RING_FRAG = /* glsl */ `
precision mediump float;
in vec3 vColor;
in float vAlpha;
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
void main() {
  float band = sin(clamp(vUv.x, 0.0, 1.0) * 3.14159);
  fragColor = vec4(vColor, band * vAlpha);
}
`;

/* ------------------------------------------------------------------------ *
 * Instanced pool plumbing
 * ------------------------------------------------------------------------ */

function markRange(attr: THREE.InstancedBufferAttribute, count: number): void {
  attr.clearUpdateRanges();
  if (count > 0) attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
}

interface InstanceSet {
  geometry: THREE.InstancedBufferGeometry;
  mesh: THREE.Mesh;
  a: THREE.InstancedBufferAttribute;   // iPos or iA
  b: THREE.InstancedBufferAttribute;   // iParams or iB
  c: THREE.InstancedBufferAttribute;   // iColor
  d: THREE.InstancedBufferAttribute | null; // iParams for beams
}

function quadBase(alongBeam: boolean): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const corner = alongBeam
    ? new Float32Array([0, -0.5, 1, -0.5, 1, 0.5, 0, 0.5])
    : new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);
  g.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

/* ------------------------------------------------------------------------ *
 * Fx
 * ------------------------------------------------------------------------ */

export interface FxOptions {
  /** Where dynamic point lights are published. */
  materials?: VoxelMaterials | null;
  maxSparks?: number;
  maxDebris?: number;
  maxTracers?: number;
  maxBlasts?: number;
  /** 0..1 from GameSettings.screenShake. */
  shakeScale?: number;
}

export interface FxStats {
  sparks: number;
  debris: number;
  tracers: number;
  blasts: number;
  lights: number;
  trauma: number;
}

/** Solidity test used to bounce debris. World block coordinates. */
export type FxSolidAt = (x: number, y: number, z: number) => boolean;

const MAX_LIGHT_SLOTS = 12;

export class Fx {
  readonly group = new THREE.Group();
  readonly stats: FxStats = { sparks: 0, debris: 0, tracers: 0, blasts: 0, lights: 0, trauma: 0 };

  private materials: VoxelMaterials | null;
  private collider: FxSolidAt | null = null;
  private disposed = false;
  private time = 0;

  /* -- sprite pools ----------------------------------------------------- */
  private readonly sparkCap: number;
  private readonly debrisCap: number;
  private sparkCount = 0;
  private debrisCount = 0;

  private readonly sp: ParticleArrays;
  private readonly db: ParticleArrays;
  private readonly sparkSet: InstanceSet;
  private readonly debrisSet: InstanceSet;

  /* -- tracers ---------------------------------------------------------- */
  private readonly tracerCap: number;
  private tracerCount = 0;
  private readonly trOx: Float32Array;
  private readonly trDir: Float32Array;
  private readonly trLen: Float32Array;
  private readonly trSpeed: Float32Array;
  private readonly trHead: Float32Array;
  private readonly trTailLen: Float32Array;
  private readonly trWidth: Float32Array;
  private readonly trColor: Float32Array;
  private readonly tracerSet: InstanceSet;

  /* -- blasts (shell + ring share a slot) -------------------------------- */
  private readonly blastCap: number;
  private blastCount = 0;
  private readonly blPos: Float32Array;
  private readonly blRadius: Float32Array;
  private readonly blLife: Float32Array;
  private readonly blMax: Float32Array;
  private readonly blColor: Float32Array;
  private readonly shellSet: InstanceSet;
  private readonly ringSet: InstanceSet;

  /* -- lights ------------------------------------------------------------ */
  private lightCount = 0;
  private readonly liPos = new Float32Array(MAX_LIGHT_SLOTS * 3);
  private readonly liColor = new Float32Array(MAX_LIGHT_SLOTS * 3);
  private readonly liRadius = new Float32Array(MAX_LIGHT_SLOTS);
  private readonly liIntensity = new Float32Array(MAX_LIGHT_SLOTS);
  private readonly liLife = new Float32Array(MAX_LIGHT_SLOTS);
  private readonly liMax = new Float32Array(MAX_LIGHT_SLOTS);
  private readonly liOrder = new Int32Array(MAX_LIGHT_SLOTS);

  /* -- shake ------------------------------------------------------------- */
  private trauma = 0;
  private shakeAmp = 0;
  private shakeHz = 26;
  private shakeDecay = 6;
  private shakeScale = 1;

  private readonly materialList: THREE.RawShaderMaterial[] = [];
  private beamMaterial: THREE.RawShaderMaterial | null = null;
  /** Drawing-buffer height in pixels; drives the minimum tracer width. */
  private viewportHeight = 720;
  private minTracerPx = 2.2;

  constructor(scene: THREE.Scene, opts: FxOptions = {}) {
    this.materials = opts.materials ?? null;
    this.shakeScale = opts.shakeScale ?? 1;
    this.sparkCap = opts.maxSparks ?? 512;
    this.debrisCap = opts.maxDebris ?? 768;
    this.tracerCap = opts.maxTracers ?? 96;
    this.blastCap = opts.maxBlasts ?? 12;

    this.sp = new ParticleArrays(this.sparkCap);
    this.db = new ParticleArrays(this.debrisCap);

    this.sparkSet = this.makeSprites(this.sparkCap, true, THREE.AdditiveBlending, 60);
    this.debrisSet = this.makeSprites(this.debrisCap, false, THREE.NormalBlending, 20);
    this.tracerSet = this.makeBeams(this.tracerCap);
    this.beamMaterial = this.tracerSet.mesh.material as THREE.RawShaderMaterial;
    this.shellSet = this.makeShells(this.blastCap);
    this.ringSet = this.makeRings(this.blastCap);

    this.trOx = new Float32Array(this.tracerCap * 3);
    this.trDir = new Float32Array(this.tracerCap * 3);
    this.trLen = new Float32Array(this.tracerCap);
    this.trSpeed = new Float32Array(this.tracerCap);
    this.trHead = new Float32Array(this.tracerCap);
    this.trTailLen = new Float32Array(this.tracerCap);
    this.trWidth = new Float32Array(this.tracerCap);
    this.trColor = new Float32Array(this.tracerCap * 3);

    this.blPos = new Float32Array(this.blastCap * 3);
    this.blRadius = new Float32Array(this.blastCap);
    this.blLife = new Float32Array(this.blastCap);
    this.blMax = new Float32Array(this.blastCap);
    this.blColor = new Float32Array(this.blastCap * 3);

    this.group.name = 'fx';
    this.group.matrixAutoUpdate = false;
    this.group.matrixWorldAutoUpdate = false;
    this.group.add(
      this.debrisSet.mesh, this.shellSet.mesh, this.ringSet.mesh,
      this.tracerSet.mesh, this.sparkSet.mesh,
    );
    scene.add(this.group);
  }

  /* -- construction helpers ---------------------------------------------- */

  private makeSprites(
    cap: number, soft: boolean, blending: THREE.Blending, order: number,
  ): InstanceSet {
    const g = quadBase(false);
    const iPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const iParams = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const iColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    iPos.setUsage(THREE.DynamicDrawUsage);
    iParams.setUsage(THREE.DynamicDrawUsage);
    iColor.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', iPos);
    g.setAttribute('iParams', iParams);
    g.setAttribute('iColor', iColor);
    g.instanceCount = 0;

    const defines: Record<string, number> = {};
    if (soft) defines.SOFT = 1;
    const m = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SPRITE_VERT,
      fragmentShader: SPRITE_FRAG,
      defines,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending,
      side: THREE.DoubleSide,
      fog: false, lights: false, toneMapped: false,
    });
    m.name = soft ? 'fx-sparks' : 'fx-debris';
    this.materialList.push(m);

    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.renderOrder = order;
    mesh.raycast = noRaycast;
    return { geometry: g, mesh, a: iPos, b: iParams, c: iColor, d: null };
  }

  private makeBeams(cap: number): InstanceSet {
    const g = quadBase(true);
    const iA = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const iB = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const iParams = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const iColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    for (const a of [iA, iB, iParams, iColor]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', iA);
    g.setAttribute('iB', iB);
    g.setAttribute('iParams', iParams);
    g.setAttribute('iColor', iColor);
    g.instanceCount = 0;

    const m = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uPxScale: { value: 0.004 } },
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false, lights: false, toneMapped: false,
    });
    m.name = 'fx-tracers';
    this.materialList.push(m);

    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.renderOrder = 50;
    mesh.raycast = noRaycast;
    return { geometry: g, mesh, a: iA, b: iB, c: iColor, d: iParams };
  }

  private makeShells(cap: number): InstanceSet {
    const src = new THREE.IcosahedronGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', src.getAttribute('position'));
    g.setAttribute('normal', src.getAttribute('normal'));
    const index = src.getIndex();
    if (index !== null) g.setIndex(index);
    src.dispose();

    const iPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const iParams = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const iColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    for (const a of [iPos, iParams, iColor]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', iPos);
    g.setAttribute('iParams', iParams);
    g.setAttribute('iColor', iColor);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const m = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SHELL_VERT,
      fragmentShader: SHELL_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
      fog: false, lights: false, toneMapped: false,
    });
    m.name = 'fx-shells';
    this.materialList.push(m);

    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.renderOrder = 30;
    mesh.raycast = noRaycast;
    return { geometry: g, mesh, a: iPos, b: iParams, c: iColor, d: null };
  }

  private makeRings(cap: number): InstanceSet {
    const src = new THREE.RingGeometry(0.68, 1, 28, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', src.getAttribute('position'));
    g.setAttribute('uv', src.getAttribute('uv'));
    const index = src.getIndex();
    if (index !== null) g.setIndex(index);
    src.dispose();

    const iPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const iParams = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const iColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    for (const a of [iPos, iParams, iColor]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', iPos);
    g.setAttribute('iParams', iParams);
    g.setAttribute('iColor', iColor);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const m = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false, lights: false, toneMapped: false,
    });
    m.name = 'fx-rings';
    this.materialList.push(m);

    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.renderOrder = 40;
    mesh.raycast = noRaycast;
    return { geometry: g, mesh, a: iPos, b: iParams, c: iColor, d: null };
  }

  /* -- configuration ----------------------------------------------------- */

  setLightSink(materials: VoxelMaterials | null): void {
    this.materials = materials;
  }

  /** Optional world solidity test so debris bounces instead of sinking. */
  setCollider(fn: FxSolidAt | null): void {
    this.collider = fn;
  }

  /** Keep the minimum tracer width honest when the canvas resizes. */
  setViewportHeight(px: number): void {
    this.viewportHeight = Math.max(1, px);
  }

  /** GameSettings.screenShake, 0..1. */
  setShakeScale(v: number): void {
    this.shakeScale = clamp(v, 0, 2);
  }

  /* -- spawners ---------------------------------------------------------- */

  /**
   * Muzzle flash: an additive plume along the shot direction, a few sparks, a
   * point light sized from the weapon table, and a trauma bump.
   */
  muzzleFlash(
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    weaponId: number,
  ): void {
    const def = getWeapon(weaponId);
    if (def.muzzleMs <= 0) return;
    const col = def.muzzleColor;
    const r = ((col >>> 16) & 0xff) / 255;
    const g = ((col >>> 8) & 0xff) / 255;
    const b = (col & 0xff) / 255;
    const life = def.muzzleMs / 1000;

    // Core plume, stretched a little along the barrel.
    for (let i = 0; i < 3; i++) {
      const t = i * 0.16;
      this.spawnSpark(
        x + dx * (0.12 + t), y + dy * (0.12 + t), z + dz * (0.12 + t),
        dx * 3.5, dy * 3.5, dz * 3.5,
        life * (1 - i * 0.18),
        0.42 - i * 0.09, 0.10,
        r, g, b, 1 - i * 0.2, 0.85, 5, 0,
      );
    }
    // Sparks spitting out of the barrel.
    const n = def.pellets > 1 ? 8 : 5;
    for (let i = 0; i < n; i++) {
      const sx = dx + (Math.random() - 0.5) * 0.8;
      const sy = dy + (Math.random() - 0.5) * 0.8;
      const sz = dz + (Math.random() - 0.5) * 0.8;
      const sp = 6 + Math.random() * 10;
      this.spawnSpark(
        x + dx * 0.2, y + dy * 0.2, z + dz * 0.2,
        sx * sp, sy * sp - 1.5, sz * sp,
        0.10 + Math.random() * 0.14,
        0.055, 0.012,
        r, g, b, 1, 0.7, 9, 0,
      );
    }

    this.addLight(
      x + dx * 0.35, y + dy * 0.35, z + dz * 0.35,
      r, g, b, def.muzzleRadius, def.muzzleIntensity, def.muzzleMs / 1000,
    );
  }

  /**
   * A bullet streak from muzzle to impact. It travels rather than appearing all
   * at once, which is what makes fast weapons read as a stream.
   */
  tracer(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    color: number, width = 0.035, speed = 260,
  ): void {
    if (this.tracerCount >= this.tracerCap) return;
    const i = this.tracerCount++;
    let ex = x1 - x0, ey = y1 - y0, ez = z1 - z0;
    const len = Math.hypot(ex, ey, ez);
    if (len < 1e-4) { this.tracerCount--; return; }
    ex /= len; ey /= len; ez /= len;
    this.trOx[i * 3] = x0; this.trOx[i * 3 + 1] = y0; this.trOx[i * 3 + 2] = z0;
    this.trDir[i * 3] = ex; this.trDir[i * 3 + 1] = ey; this.trDir[i * 3 + 2] = ez;
    this.trLen[i] = len;
    this.trSpeed[i] = speed;
    this.trHead[i] = 0;
    this.trTailLen[i] = Math.min(len, 5 + len * 0.18);
    this.trWidth[i] = width;
    this.trColor[i * 3] = ((color >>> 16) & 0xff) / 255;
    this.trColor[i * 3 + 1] = ((color >>> 8) & 0xff) / 255;
    this.trColor[i * 3 + 2] = (color & 0xff) / 255;
  }

  /** Sparks off a surface, thrown along the hit normal. */
  impact(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    color: number, intensity = 1,
  ): void {
    const r = ((color >>> 16) & 0xff) / 255;
    const g = ((color >>> 8) & 0xff) / 255;
    const b = (color & 0xff) / 255;
    const n = Math.round(6 + 8 * intensity);
    for (let i = 0; i < n; i++) {
      const sx = nx + (Math.random() - 0.5) * 1.5;
      const sy = ny + (Math.random() - 0.5) * 1.5 + 0.4;
      const sz = nz + (Math.random() - 0.5) * 1.5;
      const sp = (3 + Math.random() * 7) * intensity;
      this.spawnSpark(
        x + nx * 0.04, y + ny * 0.04, z + nz * 0.04,
        sx * sp, sy * sp, sz * sp,
        0.14 + Math.random() * 0.24,
        0.05 * intensity, 0.008,
        1, 0.82, 0.45, 1, 0.55, 6, 14,
      );
    }
    // A short-lived puff in the surface colour so the material reads.
    for (let i = 0; i < 4; i++) {
      this.spawnDebris(
        x + nx * 0.05, y + ny * 0.05, z + nz * 0.05,
        (Math.random() - 0.5) * 3 + nx * 2,
        Math.random() * 2.4 + ny * 2,
        (Math.random() - 0.5) * 3 + nz * 2,
        0.25 + Math.random() * 0.3,
        0.055, 0.02,
        r * 0.8, g * 0.8, b * 0.8, 1, 0.4, 20, 1,
      );
    }
    this.addLight(x + nx * 0.2, y + ny * 0.2, z + nz * 0.2, 1, 0.8, 0.5, 2.6, 0.5, 0.07);
  }

  /** A block just broke: throw chips of it, in its own colour. */
  blockBreak(bx: number, by: number, bz: number, blockId: number): void {
    const top = blockFaceColor(blockId, Face.PY);
    const side = minimapColor(blockId);
    const n = 14;
    for (let i = 0; i < n; i++) {
      const c = i % 3 === 0 ? top : side;
      const r = ((c >>> 16) & 0xff) / 255;
      const g = ((c >>> 8) & 0xff) / 255;
      const b = (c & 0xff) / 255;
      const shade = 0.7 + Math.random() * 0.45;
      this.spawnDebris(
        bx + 0.15 + Math.random() * 0.7,
        by + 0.15 + Math.random() * 0.7,
        bz + 0.15 + Math.random() * 0.7,
        (Math.random() - 0.5) * 6.5,
        1.5 + Math.random() * 5.5,
        (Math.random() - 0.5) * 6.5,
        0.55 + Math.random() * 0.55,
        0.10 + Math.random() * 0.07, 0.05,
        r * shade, g * shade, b * shade, 1, 0.10, 22, 1,
      );
    }
  }

  /** Hit a body. Dark red, heavier, sticks around a beat longer. */
  blood(x: number, y: number, z: number, dx: number, dy: number, dz: number, amount = 1): void {
    const n = Math.round(10 * amount);
    for (let i = 0; i < n; i++) {
      const sp = 2.5 + Math.random() * 6;
      this.spawnDebris(
        x, y, z,
        (dx + (Math.random() - 0.5) * 1.2) * sp,
        (dy + (Math.random() - 0.5) * 1.2) * sp + 1.5,
        (dz + (Math.random() - 0.5) * 1.2) * sp,
        0.32 + Math.random() * 0.4,
        0.075, 0.02,
        0.42 + Math.random() * 0.18, 0.03, 0.03, 1, 0.35, 18, 1,
      );
    }
    for (let i = 0; i < 3; i++) {
      this.spawnSpark(
        x, y, z,
        dx * 2, dy * 2 + 1, dz * 2,
        0.18, 0.28, 0.55,
        0.55, 0.05, 0.05, 0.55, 0, 3, 0,
      );
    }
  }

  /**
   * Rocket / BFG detonation: an expanding additive shell, a ground shockwave
   * ring, a fireball of sparks, smoke, a bright decaying light, and trauma
   * scaled by how close the camera is.
   */
  explosion(x: number, y: number, z: number, radius: number, color: number): void {
    const r = ((color >>> 16) & 0xff) / 255;
    const g = ((color >>> 8) & 0xff) / 255;
    const b = (color & 0xff) / 255;

    if (this.blastCount < this.blastCap) {
      const i = this.blastCount++;
      this.blPos[i * 3] = x; this.blPos[i * 3 + 1] = y; this.blPos[i * 3 + 2] = z;
      this.blRadius[i] = radius;
      this.blLife[i] = 0;
      this.blMax[i] = 0.42 + radius * 0.035;
      this.blColor[i * 3] = r; this.blColor[i * 3 + 1] = g; this.blColor[i * 3 + 2] = b;
    }

    const n = Math.round(18 + radius * 6);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * TAU;
      const ph = Math.acos(2 * Math.random() - 1);
      const sp = (4 + Math.random() * 9) * (0.5 + radius * 0.16);
      const ux = Math.sin(ph) * Math.cos(th);
      const uy = Math.cos(ph);
      const uz = Math.sin(ph) * Math.sin(th);
      this.spawnSpark(
        x + ux * 0.3, y + uy * 0.3, z + uz * 0.3,
        ux * sp, uy * sp + 2, uz * sp,
        0.22 + Math.random() * 0.4,
        0.30 + Math.random() * 0.3 * radius * 0.2, 0.04,
        1, 0.62 + Math.random() * 0.3, 0.24, 1, 0.9, 3.2, 6,
      );
    }
    for (let i = 0; i < 10; i++) {
      const th = Math.random() * TAU;
      const sp = 1.5 + Math.random() * 3.5;
      this.spawnDebris(
        x, y + 0.2, z,
        Math.cos(th) * sp, 1.2 + Math.random() * 3, Math.sin(th) * sp,
        0.8 + Math.random() * 0.7,
        0.35, 1.1 + radius * 0.1,
        0.17, 0.15, 0.14, 0.75, 0.22, 1.2, 0,
      );
    }

    this.addLight(x, y, z, r, g, b, radius * 2.7, 2.2, 0.34 + radius * 0.02);
    this.addShake(clamp(0.16 + radius * 0.075, 0.1, 0.85), 240 + radius * 22, 19);
  }

  /* -- shake ------------------------------------------------------------- */

  /**
   * `amplitude` is metres of camera displacement at full trauma, `ms` how long
   * the trauma takes to bleed off, `hz` the wobble rate.
   */
  addShake(amplitude: number, ms: number, hz: number): void {
    this.trauma = clamp(this.trauma + 0.5 + amplitude * 0.55, 0, 1);
    if (amplitude > this.shakeAmp) this.shakeAmp = amplitude;
    this.shakeHz = hz;
    this.shakeDecay = 1000 / Math.max(40, ms);
  }

  /** Straight from the weapon table. */
  shakeFromWeapon(weaponId: number, scale = 1): void {
    const def = getWeapon(weaponId);
    if (def.shakeAmplitude <= 0) return;
    this.addShake(def.shakeAmplitude * scale, def.shakeMs, def.shakeFrequency);
  }

  addTrauma(v: number): void {
    this.trauma = clamp(this.trauma + v, 0, 1);
  }

  get traumaLevel(): number {
    return this.trauma;
  }

  /**
   * Displace the camera. Call AFTER the controller has placed the camera and
   * BEFORE culling and rendering, so what you see is what gets culled.
   */
  applyShake(camera: THREE.PerspectiveCamera): void {
    const s = this.trauma * this.trauma * this.shakeScale;
    if (s <= 1e-4) return;
    const amp = Math.min(this.shakeAmp, 0.30);
    const t = this.time * this.shakeHz;
    const ox = wobble(t, 0) * s * amp;
    const oy = wobble(t, 1) * s * amp;
    const oz = wobble(t, 2) * s * amp * 0.45;
    _shakeVec.set(ox, oy, oz).applyQuaternion(camera.quaternion);
    camera.position.add(_shakeVec);
    const rk = s * Math.min(this.shakeAmp, 0.9);
    camera.rotation.z += wobble(t, 3) * rk * 0.115;
    camera.rotation.x += wobble(t, 4) * rk * 0.055;
    camera.rotation.y += wobble(t, 5) * rk * 0.055;
    camera.updateMatrixWorld(true);
  }

  /* -- lights ------------------------------------------------------------ */

  /** A transient point light. Only the strongest few reach the shader. */
  addLight(
    x: number, y: number, z: number,
    r: number, g: number, b: number,
    radius: number, intensity: number, seconds: number,
  ): void {
    if (radius <= 0 || intensity <= 0 || seconds <= 0) return;
    let i = this.lightCount;
    if (i >= MAX_LIGHT_SLOTS) {
      // Replace the dimmest.
      let worst = 0;
      let worstScore = Infinity;
      for (let k = 0; k < MAX_LIGHT_SLOTS; k++) {
        const sc = this.liIntensity[k] * (1 - this.liLife[k] / this.liMax[k]);
        if (sc < worstScore) { worstScore = sc; worst = k; }
      }
      if (intensity <= worstScore) return;
      i = worst;
    } else {
      this.lightCount++;
    }
    this.liPos[i * 3] = x; this.liPos[i * 3 + 1] = y; this.liPos[i * 3 + 2] = z;
    this.liColor[i * 3] = r; this.liColor[i * 3 + 1] = g; this.liColor[i * 3 + 2] = b;
    this.liRadius[i] = radius;
    this.liIntensity[i] = intensity;
    this.liLife[i] = 0;
    this.liMax[i] = seconds;
  }

  /* -- the frame --------------------------------------------------------- */

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    if (this.disposed) return;
    const step = Math.min(dt, 0.1);
    this.time += step;

    this.trauma = Math.max(0, this.trauma - this.shakeDecay * step);
    if (this.trauma <= 0) this.shakeAmp = 0;
    else this.shakeAmp *= Math.max(0, 1 - this.shakeDecay * step * 0.9);

    this.sparkCount = this.stepParticles(this.sp, this.sparkCount, this.sparkSet, step, false);
    this.debrisCount = this.stepParticles(this.db, this.debrisCount, this.debrisSet, step, true);
    if (this.beamMaterial !== null) {
      const halfFov = Math.tan((camera.fov * Math.PI) / 360);
      this.beamMaterial.uniforms.uPxScale.value =
        (2 * halfFov * this.minTracerPx) / this.viewportHeight;
      this.beamMaterial.uniformsNeedUpdate = true;
    }
    this.stepTracers(step);
    this.stepBlasts(step);
    this.stepLights(step, camera);

    this.stats.sparks = this.sparkCount;
    this.stats.debris = this.debrisCount;
    this.stats.tracers = this.tracerCount;
    this.stats.blasts = this.blastCount;
    this.stats.lights = this.lightCount;
    this.stats.trauma = this.trauma;
  }

  private stepParticles(
    p: ParticleArrays, count: number, set: InstanceSet, dt: number, bounce: boolean,
  ): number {
    const pos = set.a.array as Float32Array;
    const par = set.b.array as Float32Array;
    const col = set.c.array as Float32Array;
    let n = count;
    let i = 0;
    while (i < n) {
      p.life[i] += dt;
      const t = p.life[i] / p.max[i];
      if (t >= 1) {
        n--;
        if (i !== n) p.copy(n, i);
        continue;
      }

      const drag = Math.max(0, 1 - p.drag[i] * dt);
      p.vy[i] -= p.grav[i] * dt;
      p.vx[i] *= drag; p.vy[i] *= drag; p.vz[i] *= drag;

      const nx = p.x[i] + p.vx[i] * dt;
      const ny = p.y[i] + p.vy[i] * dt;
      const nz = p.z[i] + p.vz[i] * dt;

      if (bounce && p.bounce[i] !== 0 && this.collider !== null) {
        if (this.collider(Math.floor(nx), Math.floor(ny), Math.floor(nz))) {
          // Cheap axis-resolve: kill the dominant component and damp.
          const ax = Math.abs(p.vx[i]), ay = Math.abs(p.vy[i]), az = Math.abs(p.vz[i]);
          if (ay >= ax && ay >= az) p.vy[i] = -p.vy[i] * 0.28;
          else if (ax >= az) p.vx[i] = -p.vx[i] * 0.28;
          else p.vz[i] = -p.vz[i] * 0.28;
          p.vx[i] *= 0.55; p.vz[i] *= 0.55;
          p.rotVel[i] *= 0.4;
        } else {
          p.x[i] = nx; p.y[i] = ny; p.z[i] = nz;
        }
      } else {
        p.x[i] = nx; p.y[i] = ny; p.z[i] = nz;
      }

      p.rot[i] += p.rotVel[i] * dt;

      const fade = 1 - t;
      pos[i * 3] = p.x[i];
      pos[i * 3 + 1] = p.y[i];
      pos[i * 3 + 2] = p.z[i];
      par[i * 4] = p.size0[i] + (p.size1[i] - p.size0[i]) * t;
      par[i * 4 + 1] = p.rot[i];
      par[i * 4 + 2] = p.alpha[i] * fade * fade;
      par[i * 4 + 3] = p.glow[i];
      col[i * 3] = p.r[i];
      col[i * 3 + 1] = p.g[i];
      col[i * 3 + 2] = p.b[i];
      i++;
    }

    set.geometry.instanceCount = n;
    if (n > 0) {
      markRange(set.a, n);
      markRange(set.b, n);
      markRange(set.c, n);
    }
    return n;
  }

  private stepTracers(dt: number): void {
    const A = this.tracerSet.a.array as Float32Array;
    const B = this.tracerSet.b.array as Float32Array;
    const P = (this.tracerSet.d as THREE.InstancedBufferAttribute).array as Float32Array;
    const C = this.tracerSet.c.array as Float32Array;
    let n = this.tracerCount;
    let i = 0;
    while (i < n) {
      this.trHead[i] += this.trSpeed[i] * dt;
      const head = Math.min(this.trHead[i], this.trLen[i]);
      const tail = this.trHead[i] - this.trTailLen[i];
      if (tail >= this.trLen[i]) {
        n--;
        if (i !== n) this.copyTracer(n, i);
        continue;
      }
      const t0 = Math.max(0, tail);
      const ox = this.trOx[i * 3], oy = this.trOx[i * 3 + 1], oz = this.trOx[i * 3 + 2];
      const dx = this.trDir[i * 3], dy = this.trDir[i * 3 + 1], dz = this.trDir[i * 3 + 2];
      A[i * 3] = ox + dx * t0; A[i * 3 + 1] = oy + dy * t0; A[i * 3 + 2] = oz + dz * t0;
      B[i * 3] = ox + dx * head; B[i * 3 + 1] = oy + dy * head; B[i * 3 + 2] = oz + dz * head;
      P[i * 4] = this.trWidth[i];
      P[i * 4 + 1] = clamp(1 - Math.max(0, tail) / Math.max(this.trLen[i], 1e-3), 0.15, 1);
      C[i * 3] = this.trColor[i * 3];
      C[i * 3 + 1] = this.trColor[i * 3 + 1];
      C[i * 3 + 2] = this.trColor[i * 3 + 2];
      i++;
    }
    this.tracerCount = n;
    this.tracerSet.geometry.instanceCount = n;
    if (n > 0) {
      markRange(this.tracerSet.a, n);
      markRange(this.tracerSet.b, n);
      markRange(this.tracerSet.c, n);
      markRange(this.tracerSet.d as THREE.InstancedBufferAttribute, n);
    }
  }

  private copyTracer(from: number, to: number): void {
    for (let k = 0; k < 3; k++) {
      this.trOx[to * 3 + k] = this.trOx[from * 3 + k];
      this.trDir[to * 3 + k] = this.trDir[from * 3 + k];
      this.trColor[to * 3 + k] = this.trColor[from * 3 + k];
    }
    this.trLen[to] = this.trLen[from];
    this.trSpeed[to] = this.trSpeed[from];
    this.trHead[to] = this.trHead[from];
    this.trTailLen[to] = this.trTailLen[from];
    this.trWidth[to] = this.trWidth[from];
  }

  private stepBlasts(dt: number): void {
    const sPos = this.shellSet.a.array as Float32Array;
    const sPar = this.shellSet.b.array as Float32Array;
    const sCol = this.shellSet.c.array as Float32Array;
    const rPos = this.ringSet.a.array as Float32Array;
    const rPar = this.ringSet.b.array as Float32Array;
    const rCol = this.ringSet.c.array as Float32Array;

    let n = this.blastCount;
    let i = 0;
    while (i < n) {
      this.blLife[i] += dt;
      const t = this.blLife[i] / this.blMax[i];
      if (t >= 1) {
        n--;
        if (i !== n) this.copyBlast(n, i);
        continue;
      }
      const R = this.blRadius[i];
      const ease = 1 - (1 - t) * (1 - t) * (1 - t);
      const x = this.blPos[i * 3], y = this.blPos[i * 3 + 1], z = this.blPos[i * 3 + 2];

      sPos[i * 3] = x; sPos[i * 3 + 1] = y; sPos[i * 3 + 2] = z;
      sPar[i * 4] = R * (0.22 + ease * 0.95);
      sPar[i * 4 + 1] = (1 - t) * (1 - t) * 1.15;
      sCol[i * 3] = this.blColor[i * 3];
      sCol[i * 3 + 1] = this.blColor[i * 3 + 1];
      sCol[i * 3 + 2] = this.blColor[i * 3 + 2];

      // The shockwave outruns the fireball and lives a little longer.
      const rt = Math.min(1, t * 1.35);
      rPos[i * 3] = x; rPos[i * 3 + 1] = y - R * 0.32; rPos[i * 3 + 2] = z;
      rPar[i * 4] = R * (0.4 + rt * 2.0);
      rPar[i * 4 + 1] = (1 - rt) * 0.85;
      rCol[i * 3] = this.blColor[i * 3];
      rCol[i * 3 + 1] = this.blColor[i * 3 + 1] * 0.85;
      rCol[i * 3 + 2] = this.blColor[i * 3 + 2] * 0.7;
      i++;
    }
    this.blastCount = n;
    this.shellSet.geometry.instanceCount = n;
    this.ringSet.geometry.instanceCount = n;
    if (n > 0) {
      markRange(this.shellSet.a, n);
      markRange(this.shellSet.b, n);
      markRange(this.shellSet.c, n);
      markRange(this.ringSet.a, n);
      markRange(this.ringSet.b, n);
      markRange(this.ringSet.c, n);
    }
  }

  private copyBlast(from: number, to: number): void {
    for (let k = 0; k < 3; k++) {
      this.blPos[to * 3 + k] = this.blPos[from * 3 + k];
      this.blColor[to * 3 + k] = this.blColor[from * 3 + k];
    }
    this.blRadius[to] = this.blRadius[from];
    this.blLife[to] = this.blLife[from];
    this.blMax[to] = this.blMax[from];
  }

  private stepLights(dt: number, camera: THREE.PerspectiveCamera): void {
    let n = this.lightCount;
    let i = 0;
    while (i < n) {
      this.liLife[i] += dt;
      if (this.liLife[i] >= this.liMax[i]) {
        n--;
        if (i !== n) {
          for (let k = 0; k < 3; k++) {
            this.liPos[i * 3 + k] = this.liPos[n * 3 + k];
            this.liColor[i * 3 + k] = this.liColor[n * 3 + k];
          }
          this.liRadius[i] = this.liRadius[n];
          this.liIntensity[i] = this.liIntensity[n];
          this.liLife[i] = this.liLife[n];
          this.liMax[i] = this.liMax[n];
        }
        continue;
      }
      i++;
    }
    this.lightCount = n;

    const mats = this.materials;
    if (mats === null) return;

    // Rank by what the player will actually see: brightness over distance.
    for (let k = 0; k < n; k++) this.liOrder[k] = k;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    for (let a = 1; a < n; a++) {
      const key = this.liOrder[a];
      const ks = this.lightScore(key, cx, cy, cz);
      let b = a - 1;
      while (b >= 0 && this.lightScore(this.liOrder[b], cx, cy, cz) < ks) {
        this.liOrder[b + 1] = this.liOrder[b];
        b--;
      }
      this.liOrder[b + 1] = key;
    }

    mats.beginLights();
    for (let k = 0; k < n; k++) {
      const j = this.liOrder[k];
      const fade = 1 - this.liLife[j] / this.liMax[j];
      const inten = this.liIntensity[j] * fade * fade;
      if (!mats.pushLight(
        this.liPos[j * 3], this.liPos[j * 3 + 1], this.liPos[j * 3 + 2],
        this.liColor[j * 3], this.liColor[j * 3 + 1], this.liColor[j * 3 + 2],
        this.liRadius[j], inten,
      )) break;
    }
    mats.endLights();
  }

  private lightScore(i: number, cx: number, cy: number, cz: number): number {
    const dx = this.liPos[i * 3] - cx;
    const dy = this.liPos[i * 3 + 1] - cy;
    const dz = this.liPos[i * 3 + 2] - cz;
    const d2 = dx * dx + dy * dy + dz * dz + 1;
    const fade = 1 - this.liLife[i] / this.liMax[i];
    return (this.liIntensity[i] * fade * this.liRadius[i]) / d2;
  }

  /* -- low-level spawn --------------------------------------------------- */

  private spawnSpark(
    x: number, y: number, z: number, vx: number, vy: number, vz: number,
    life: number, size0: number, size1: number,
    r: number, g: number, b: number, alpha: number, glow: number,
    drag: number, grav: number,
  ): void {
    if (this.sparkCount >= this.sparkCap) return;
    this.sp.set(this.sparkCount++, x, y, z, vx, vy, vz, life, size0, size1, r, g, b, alpha, glow, drag, grav, 0);
  }

  private spawnDebris(
    x: number, y: number, z: number, vx: number, vy: number, vz: number,
    life: number, size0: number, size1: number,
    r: number, g: number, b: number, alpha: number, glow: number,
    grav: number, bounce: number,
  ): void {
    if (this.debrisCount >= this.debrisCap) return;
    this.db.set(this.debrisCount++, x, y, z, vx, vy, vz, life, size0, size1, r, g, b, alpha, glow, 0.6, grav, bounce);
  }

  /* -- teardown ---------------------------------------------------------- */

  /** Wipe every live effect, e.g. on respawn or map change. */
  clear(): void {
    this.sparkCount = 0;
    this.debrisCount = 0;
    this.tracerCount = 0;
    this.blastCount = 0;
    this.lightCount = 0;
    this.trauma = 0;
    this.shakeAmp = 0;
    this.sparkSet.geometry.instanceCount = 0;
    this.debrisSet.geometry.instanceCount = 0;
    this.tracerSet.geometry.instanceCount = 0;
    this.shellSet.geometry.instanceCount = 0;
    this.ringSet.geometry.instanceCount = 0;
    if (this.materials !== null) {
      this.materials.beginLights();
      this.materials.endLights();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const set of [this.sparkSet, this.debrisSet, this.tracerSet, this.shellSet, this.ringSet]) {
      set.geometry.dispose();
    }
    for (const m of this.materialList) m.dispose();
    this.group.clear();
  }
}

/* ------------------------------------------------------------------------ *
 * Particle storage
 * ------------------------------------------------------------------------ */

class ParticleArrays {
  readonly x: Float32Array; readonly y: Float32Array; readonly z: Float32Array;
  readonly vx: Float32Array; readonly vy: Float32Array; readonly vz: Float32Array;
  readonly life: Float32Array; readonly max: Float32Array;
  readonly size0: Float32Array; readonly size1: Float32Array;
  readonly r: Float32Array; readonly g: Float32Array; readonly b: Float32Array;
  readonly alpha: Float32Array; readonly glow: Float32Array;
  readonly drag: Float32Array; readonly grav: Float32Array;
  readonly rot: Float32Array; readonly rotVel: Float32Array;
  readonly bounce: Uint8Array;

  constructor(cap: number) {
    this.x = new Float32Array(cap); this.y = new Float32Array(cap); this.z = new Float32Array(cap);
    this.vx = new Float32Array(cap); this.vy = new Float32Array(cap); this.vz = new Float32Array(cap);
    this.life = new Float32Array(cap); this.max = new Float32Array(cap);
    this.size0 = new Float32Array(cap); this.size1 = new Float32Array(cap);
    this.r = new Float32Array(cap); this.g = new Float32Array(cap); this.b = new Float32Array(cap);
    this.alpha = new Float32Array(cap); this.glow = new Float32Array(cap);
    this.drag = new Float32Array(cap); this.grav = new Float32Array(cap);
    this.rot = new Float32Array(cap); this.rotVel = new Float32Array(cap);
    this.bounce = new Uint8Array(cap);
  }

  set(
    i: number, x: number, y: number, z: number, vx: number, vy: number, vz: number,
    life: number, size0: number, size1: number,
    r: number, g: number, b: number, alpha: number, glow: number,
    drag: number, grav: number, bounce: number,
  ): void {
    this.x[i] = x; this.y[i] = y; this.z[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = 0; this.max[i] = Math.max(0.02, life);
    this.size0[i] = size0; this.size1[i] = size1;
    this.r[i] = r; this.g[i] = g; this.b[i] = b;
    this.alpha[i] = alpha; this.glow[i] = glow;
    this.drag[i] = drag; this.grav[i] = grav;
    this.rot[i] = Math.random() * TAU;
    this.rotVel[i] = (Math.random() - 0.5) * 9;
    this.bounce[i] = bounce;
  }

  copy(from: number, to: number): void {
    this.x[to] = this.x[from]; this.y[to] = this.y[from]; this.z[to] = this.z[from];
    this.vx[to] = this.vx[from]; this.vy[to] = this.vy[from]; this.vz[to] = this.vz[from];
    this.life[to] = this.life[from]; this.max[to] = this.max[from];
    this.size0[to] = this.size0[from]; this.size1[to] = this.size1[from];
    this.r[to] = this.r[from]; this.g[to] = this.g[from]; this.b[to] = this.b[from];
    this.alpha[to] = this.alpha[from]; this.glow[to] = this.glow[from];
    this.drag[to] = this.drag[from]; this.grav[to] = this.grav[from];
    this.rot[to] = this.rot[from]; this.rotVel[to] = this.rotVel[from];
    this.bounce[to] = this.bounce[from];
  }
}

/* ------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------ */

const _shakeVec = new THREE.Vector3();

/**
 * Smooth pseudo-random in [-1, 1]. Two sines at incommensurate rates beat a
 * noise texture lookup and cost nothing.
 */
function wobble(t: number, channel: number): number {
  const k = channel * 2.399963;
  return Math.sin(t * 1.0 + k) * 0.62 + Math.sin(t * 2.371 + k * 3.1) * 0.38;
}

function noRaycast(): void {
  // Effects are never pickable.
}
