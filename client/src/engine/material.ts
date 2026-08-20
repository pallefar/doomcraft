/**
 * DOOMCRAFT — voxel materials.
 *
 * One GLSL3 RawShaderMaterial family for the whole world, three variants
 * (opaque / cutout / transparent) sharing a single uniforms object so a frame
 * update touches one place.
 *
 * Why it looks different from the bar (ref/BAR.md weakness #4 — "no AO, no fog,
 * no contrast, the beach reads as one mass"):
 *
 *  - **Stepped face light.** Six discrete values, one per face direction, built
 *    from the shared FACE_SHADE ramp and modulated by the sun azimuth so +X and
 *    -X are NOT the same value. The bar's four values have no azimuth term at
 *    all, so its cubes have no facing.
 *  - **Baked AO** from the mesher, remapped through a 4-entry lookup so the
 *    strength is a uniform, not a shader edit.
 *  - **Exponential-squared distance fog in a dark palette.** The bar has none;
 *    everything is the same value at 10 m and 200 m and depth reads as flat.
 *  - **Dynamic point lights.** Muzzle flashes and explosions light the walls.
 *    This is half of what makes a shot feel like it happened.
 *
 * All of it is per-vertex except the fog, the point lights and a two-instruction
 * dither, because greedy-meshed chunks are a few thousand vertices and several
 * hundred thousand fragments: the cheap side is the vertex side.
 *
 * Vertex format is mesher.ts's: three uint8x4 attributes, stride 12, one
 * interleaved buffer. Colour arrives UNSHADED; the face shade is applied here,
 * exactly once.
 */

import * as THREE from 'three';
import {
  AO_STRENGTH,
  CHUNK_SIZE_X,
  clamp,
  FACE_SHADE,
  FOG_FAR_FRAC,
  RenderLayer,
  SUN_DIR_X,
  SUN_DIR_Y,
  SUN_DIR_Z,
} from '@doomcraft/shared';

/* ------------------------------------------------------------------------ *
 * Palette
 *
 * shared/constants.ts ships a bright-blue sky/fog pair that matches the bar.
 * Doomcraft is not going for the bar's look, it is going for readability under
 * fire, so the renderer owns its own dark palette and the sky, the fog and the
 * clear colour all come from here. Everything is settable at runtime.
 * ------------------------------------------------------------------------ */

/** Straight up. Almost black, faintly blue. */
export const DOOM_SKY_ZENITH = 0x141827;
/** Upper dome, on the way down to the horizon. */
export const DOOM_SKY_HIGH = 0x242c40;
/** The horizon, and therefore the fog: geometry must dissolve into exactly this. */
export const DOOM_FOG = 0x3b2a24;
/** The hot band sitting on the horizon line, and the sun glow. */
export const DOOM_SKY_EMBER = 0xd0561e;
/** Below the horizon. */
export const DOOM_SKY_GROUND = 0x120d0c;

/* ------------------------------------------------------------------------ *
 * Uniform plumbing
 * ------------------------------------------------------------------------ */

export const MAX_DYNAMIC_LIGHTS = 4;

export type VoxelQuality = 'low' | 'medium' | 'high';

const QUALITY_LIGHTS: Readonly<Record<VoxelQuality, number>> = {
  low: 0,
  medium: 2,
  high: MAX_DYNAMIC_LIGHTS,
};

function hexToVec3(hex: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(((hex >>> 16) & 0xff) / 255, ((hex >>> 8) & 0xff) / 255, (hex & 0xff) / 255);
}

/* ------------------------------------------------------------------------ *
 * Shaders
 * ------------------------------------------------------------------------ */

const VERT = /* glsl */ `
precision highp float;
precision highp int;

uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

uniform float uFaceLight[6];
uniform vec3  uFaceNormal[6];
uniform float uAoLevels[4];
uniform float uTime;
uniform float uWaveAmp;
uniform float uWaveSpeed;
uniform float uEmissiveGain;

in vec4 aPosFace;   // x, y, z (chunk-local integers), face 0..5
in vec4 aData;      // ao 0..3, light 0..15, alpha 0..255, flags
in vec4 aColor;     // rgb, normalized

out vec3  vColor;
out float vLightBase;
out float vEmissive;
out float vAlpha;
out float vFogDepth;
out highp vec3 vWorldPos;
flat out vec3 vNormal;
flat out float vLiquid;

void main() {
  int face = int(aPosFace.w + 0.5);
  vec3 local = aPosFace.xyz;

  // Liquids sit a little below the block top so their side faces cap the
  // surface, then the top face alone ripples inside that gap.
  float flags = aData.w;
  float liquid = step(0.5, mod(flags, 2.0));
  vLiquid = liquid;
  if (liquid > 0.0) {
    local.y -= 0.08;
    float isTop = (face == 2) ? 1.0 : 0.0;
    vec3 wp = (modelMatrix * vec4(local, 1.0)).xyz;
    float wave = sin(wp.x * 0.75 + uTime * uWaveSpeed) * 0.5
               + sin(wp.z * 1.05 - uTime * uWaveSpeed * 0.83) * 0.5;
    local.y -= isTop * uWaveAmp * (1.0 + wave);
  }

  vec4 world = modelMatrix * vec4(local, 1.0);
  vWorldPos = world.xyz;

  vec4 mv = modelViewMatrix * vec4(local, 1.0);
  gl_Position = projectionMatrix * mv;

  // Radial fog: turning the camera must not change how far away a wall looks.
  vFogDepth = length(mv.xyz);

  vNormal = uFaceNormal[face];
  vColor = aColor.rgb;
  vLightBase = uFaceLight[face] * uAoLevels[int(aData.x + 0.5)];
  vEmissive = (aData.y / 15.0) * uEmissiveGain;
  vAlpha = aData.z / 255.0;
}
`;

const FRAG = /* glsl */ `
precision mediump float;
precision mediump int;

uniform vec3  uFogColor;
uniform float uFogDensity;
uniform vec3  uTint;
uniform float uContrast;
uniform float uSaturation;
uniform float uExposure;
// Shared with the vertex stage, which runs highp: a uniform of the same name
// must carry the same precision in both or the program fails to validate.
uniform highp float uTime;
uniform float uRipple;
#if MAX_LIGHTS > 0
uniform int   uLightCount;
uniform vec3  uLightPos[MAX_LIGHTS];
uniform vec3  uLightColor[MAX_LIGHTS];
uniform float uLightRadius[MAX_LIGHTS];
#endif

in vec3  vColor;
in float vLightBase;
in float vEmissive;
in float vAlpha;
in float vFogDepth;
in highp vec3 vWorldPos;
flat in vec3 vNormal;
flat in float vLiquid;

layout(location = 0) out vec4 fragColor;

void main() {
  vec3 base = vColor * uTint;
  float lit = max(vLightBase, vEmissive);

  // Greedy meshing merges a still lake into a handful of enormous quads, so a
  // vertex ripple has nothing to ripple. Do the shimmer per fragment instead.
  if (vLiquid > 0.5) {
    float rip = sin(vWorldPos.x * 1.7 + uTime * 1.9) * sin(vWorldPos.z * 2.1 - uTime * 1.35);
    lit *= 1.0 + rip * uRipple;
  }

  vec3 c = base * lit;

#if MAX_LIGHTS > 0
  vec3 add = vec3(0.0);
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    vec3 d = uLightPos[i] - vWorldPos;
    float r = uLightRadius[i];
    float dd = dot(d, d);
    float att = max(0.0, 1.0 - dd / max(r * r, 1e-4));
    att *= att;
    float nl = max(dot(vNormal, d * inversesqrt(max(dd, 1e-4))), 0.0);
    add += uLightColor[i] * att * (0.30 + 0.70 * nl);
  }
  c += base * add;
#endif

  // Grade. The shared block palette is authored bright and saturated to match
  // the bar; Doomcraft pulls it down and desaturates so muzzle flashes, lava
  // and enemies are the only saturated things on screen.
  c *= uExposure;
  c = clamp(c, 0.0, 1.0);
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(vec3(lum), c, uSaturation);
  c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);

  float fd = vFogDepth * uFogDensity;
  float fog = 1.0 - exp(-fd * fd);
  fog = clamp(fog, 0.0, 1.0);
  c = mix(c, uFogColor, fog);

#ifdef USE_DITHER
  // Two instructions of ordered dither. A dark palette in 8 bits bands badly
  // across a fog gradient and this removes all of it.
  float dth = fract(dot(gl_FragCoord.xy, vec2(0.5, 0.25)));
  c += (dth - 0.375) * (1.6 / 255.0);
#endif

#ifdef LAYER_TRANSPARENT
  float a = mix(vAlpha, 1.0, fog);
  fragColor = vec4(c, a);
#else
  #ifdef LAYER_CUTOUT
    if (vAlpha < 0.5) discard;
  #endif
  fragColor = vec4(c, 1.0);
#endif
}
`;

/* ------------------------------------------------------------------------ *
 * VoxelMaterials
 * ------------------------------------------------------------------------ */

export interface VoxelMaterialOptions {
  quality?: VoxelQuality;
  ao?: boolean;
  fog?: boolean;
  dither?: boolean;
  /** Metres at which fog is effectively total. Defaults to render distance x 32. */
  fogFar?: number;
  fogColor?: number;
}

/**
 * The three chunk materials plus everything a frame needs to poke at them.
 * They share one uniforms object, so a single `setTime` reaches all three.
 */
export class VoxelMaterials {
  readonly opaque: THREE.RawShaderMaterial;
  readonly cutout: THREE.RawShaderMaterial;
  readonly transparent: THREE.RawShaderMaterial;
  readonly all: THREE.RawShaderMaterial[];

  /** Shared uniform block. Mutate through the setters, not directly. */
  readonly uniforms: Record<string, THREE.IUniform>;

  private readonly faceLight = new Float32Array(6);
  private readonly faceNormal = new Float32Array(18);
  private readonly aoLevels = new Float32Array(4);
  private readonly lightPos = new Float32Array(MAX_DYNAMIC_LIGHTS * 3);
  private readonly lightColor = new Float32Array(MAX_DYNAMIC_LIGHTS * 3);
  private readonly lightRadius = new Float32Array(MAX_DYNAMIC_LIGHTS);
  private lightCount = 0;

  private aoStrength: number;
  private sunX = -SUN_DIR_X;
  private sunY = -SUN_DIR_Y;
  private sunZ = -SUN_DIR_Z;
  private skyAmbient = 0.46;
  private sunStrength = 0.34;
  private quality: VoxelQuality;
  private fogEnabled: boolean;
  private ditherEnabled: boolean;
  private fogFar: number;

  constructor(opts: VoxelMaterialOptions = {}) {
    this.quality = opts.quality ?? 'high';
    this.aoStrength = opts.ao === false ? 0 : AO_STRENGTH;
    this.fogEnabled = opts.fog !== false;
    this.ditherEnabled = opts.dither !== false;
    this.fogFar = opts.fogFar ?? 6 * 32;

    this.uniforms = {
      uFaceLight: { value: this.faceLight },
      uFaceNormal: { value: this.faceNormal },
      uAoLevels: { value: this.aoLevels },
      uTime: { value: 0 },
      uWaveAmp: { value: 0.05 },
      uWaveSpeed: { value: 1.7 },
      uEmissiveGain: { value: 1.15 },
      uFogColor: { value: hexToVec3(opts.fogColor ?? DOOM_FOG, new THREE.Vector3()) },
      uFogDensity: { value: 0 },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uContrast: { value: 0.26 },
      uSaturation: { value: 0.80 },
      uExposure: { value: 1.0 },
      uRipple: { value: 0.085 },
      uLightCount: { value: 0 },
      uLightPos: { value: this.lightPos },
      uLightColor: { value: this.lightColor },
      uLightRadius: { value: this.lightRadius },
    };

    // Face normals, in shared `Face` order: PX NX PY NY PZ NZ.
    this.faceNormal.set([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]);
    this.rebuildFaceLight();
    this.rebuildAo();
    this.setFogFar(this.fogFar);

    const lights = QUALITY_LIGHTS[this.quality];
    this.opaque = this.make('LAYER_OPAQUE', lights, {
      transparent: false, depthWrite: true, side: THREE.FrontSide,
    });
    this.cutout = this.make('LAYER_CUTOUT', lights, {
      // Leaves: double sided so a canopy is not see-through from inside.
      transparent: false, depthWrite: true, side: THREE.DoubleSide,
    });
    this.transparent = this.make('LAYER_TRANSPARENT', lights, {
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.all = [this.opaque, this.cutout, this.transparent];
    this.flagUniforms();
  }

  private make(
    layerDefine: string,
    lights: number,
    cfg: { transparent: boolean; depthWrite: boolean; side: THREE.Side },
  ): THREE.RawShaderMaterial {
    const defines: Record<string, number> = { MAX_LIGHTS: lights };
    defines[layerDefine] = 1;
    if (this.ditherEnabled) defines.USE_DITHER = 1;

    const m = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines,
      transparent: cfg.transparent,
      depthWrite: cfg.depthWrite,
      depthTest: true,
      side: cfg.side,
      fog: false,
      lights: false,
      toneMapped: false,
    });
    m.name = layerDefine;
    return m;
  }

  /** The material a mesher RenderLayer draws with. */
  byLayer(layer: number): THREE.RawShaderMaterial {
    if (layer === RenderLayer.TRANSPARENT) return this.transparent;
    if (layer === RenderLayer.CUTOUT) return this.cutout;
    return this.opaque;
  }

  /* -- lighting ---------------------------------------------------------- */

  private rebuildFaceLight(): void {
    // FACE_SHADE is the shared top/side/bottom ramp; the dot term adds the sun
    // azimuth the bar does not have, so opposite walls of the same building are
    // different values.
    const nx = [1, -1, 0, 0, 0, 0];
    const ny = [0, 0, 1, -1, 0, 0];
    const nz = [0, 0, 0, 0, 1, -1];
    let len = Math.hypot(this.sunX, this.sunY, this.sunZ);
    if (len < 1e-5) len = 1;
    const lx = this.sunX / len, ly = this.sunY / len, lz = this.sunZ / len;
    for (let f = 0; f < 6; f++) {
      const ndl = Math.max(0, nx[f] * lx + ny[f] * ly + nz[f] * lz);
      this.faceLight[f] = FACE_SHADE[f] * (this.skyAmbient + this.sunStrength * ndl);
    }
    this.flagUniforms();
  }

  private rebuildAo(): void {
    // Four exact levels beat a pow() in the vertex shader and let AO be a slider.
    // The ramp is linear on purpose: a convex ramp makes level 2 -- the single
    // most common case, a floor tile beside a wall -- a 9% dip nobody can see,
    // and AO is the whole point (ref/BAR.md weakness #4).
    const min = 1 - this.aoStrength;
    const curve = [0, 1 / 3, 2 / 3, 1];
    for (let i = 0; i < 4; i++) this.aoLevels[i] = min + (1 - min) * curve[i];
    this.flagUniforms();
  }

  /** Direction the light travels FROM the sun, matching SUN_DIR_* in constants. */
  setSunDirection(x: number, y: number, z: number): void {
    this.sunX = -x; this.sunY = -y; this.sunZ = -z;
    this.rebuildFaceLight();
  }

  /** Overall sky term and direct sun term. Defaults 0.46 / 0.34. */
  setLightBalance(ambient: number, sun: number): void {
    this.skyAmbient = ambient;
    this.sunStrength = sun;
    this.rebuildFaceLight();
  }

  setAoStrength(strength: number): void {
    this.aoStrength = strength < 0 ? 0 : strength > 1 ? 1 : strength;
    this.rebuildAo();
  }

  setAoEnabled(on: boolean): void {
    this.setAoStrength(on ? AO_STRENGTH : 0);
  }

  /* -- fog --------------------------------------------------------------- */

  /**
   * Distance in metres at which fog is 98% closed. exp2 fog needs a density,
   * and a density is not a number anybody can reason about.
   */
  setFogFar(metres: number): void {
    this.fogFar = Math.max(8, metres);
    this.uniforms.uFogDensity.value = this.fogEnabled ? 1.978 / this.fogFar : 0;
    this.flagUniforms();
  }

  /**
   * The correct way to set fog: it must close just inside the render distance
   * or chunks pop in against a clear sky at the edge of the world.
   */
  setFogFromRenderDistance(chunks: number): void {
    this.setFogFar(Math.max(2, chunks) * CHUNK_SIZE_X * FOG_FAR_FRAC);
  }

  setFogEnabled(on: boolean): void {
    this.fogEnabled = on;
    this.setFogFar(this.fogFar);
  }

  setFogColor(hex: number): void {
    hexToVec3(hex, this.uniforms.uFogColor.value as THREE.Vector3);
    this.flagUniforms();
  }

  get fogColor(): THREE.Vector3 {
    return this.uniforms.uFogColor.value as THREE.Vector3;
  }

  /** Full-screen colour grade, e.g. a red push while taking damage. */
  setTint(r: number, g: number, b: number): void {
    (this.uniforms.uTint.value as THREE.Vector3).set(r, g, b);
    this.flagUniforms();
  }

  setContrast(v: number): void {
    this.uniforms.uContrast.value = v;
    this.flagUniforms();
  }

  /** 0 = greyscale, 1 = the palette as authored. Default 0.84. */
  setSaturation(v: number): void {
    this.uniforms.uSaturation.value = clamp(v, 0, 2);
    this.flagUniforms();
  }

  /** Linear brightness multiplier before grading. Default 1. */
  setExposure(v: number): void {
    this.uniforms.uExposure.value = Math.max(0, v);
    this.flagUniforms();
  }

  /* -- per frame --------------------------------------------------------- */

  setTime(seconds: number): void {
    this.uniforms.uTime.value = seconds;
    this.flagUniforms();
  }

  /* -- dynamic lights ---------------------------------------------------- */

  /** Start a frame's light list. Call, push, then end. */
  beginLights(): void {
    this.lightCount = 0;
  }

  /**
   * Add one point light for this frame. Returns false when the slots are full,
   * which is normal — the caller should push the brightest first.
   */
  pushLight(
    x: number, y: number, z: number,
    r: number, g: number, b: number,
    radius: number, intensity: number,
  ): boolean {
    const i = this.lightCount;
    if (i >= MAX_DYNAMIC_LIGHTS || radius <= 0 || intensity <= 0) return false;
    this.lightPos[i * 3 + 0] = x;
    this.lightPos[i * 3 + 1] = y;
    this.lightPos[i * 3 + 2] = z;
    this.lightColor[i * 3 + 0] = r * intensity;
    this.lightColor[i * 3 + 1] = g * intensity;
    this.lightColor[i * 3 + 2] = b * intensity;
    this.lightRadius[i] = radius;
    this.lightCount = i + 1;
    return true;
  }

  /** Zero the unused slots and flush. */
  endLights(): void {
    this.uniforms.uLightCount.value = this.lightCount;
    for (let i = this.lightCount; i < MAX_DYNAMIC_LIGHTS; i++) {
      this.lightRadius[i] = 0;
      this.lightColor[i * 3 + 0] = 0;
      this.lightColor[i * 3 + 1] = 0;
      this.lightColor[i * 3 + 2] = 0;
    }
    this.flagUniforms();
  }

  get activeLightCount(): number {
    return this.lightCount;
  }

  /* -- quality ----------------------------------------------------------- */

  setQuality(q: VoxelQuality): void {
    if (q === this.quality) return;
    this.quality = q;
    const lights = QUALITY_LIGHTS[q];
    for (const m of this.all) {
      m.defines.MAX_LIGHTS = lights;
      m.needsUpdate = true;
    }
  }

  setDither(on: boolean): void {
    if (on === this.ditherEnabled) return;
    this.ditherEnabled = on;
    for (const m of this.all) {
      if (on) m.defines.USE_DITHER = 1;
      else delete m.defines.USE_DITHER;
      m.needsUpdate = true;
    }
  }

  /**
   * Water surface: vertex displacement amplitude in metres, wave speed, and the
   * per-fragment shimmer strength that does the actual visible work on the big
   * greedy-merged quads. 0 / 0 / 0 gives a dead flat lake like the bar's.
   */
  setWater(amplitude: number, speed: number, ripple = 0.085): void {
    this.uniforms.uWaveAmp.value = amplitude;
    this.uniforms.uWaveSpeed.value = speed;
    this.uniforms.uRipple.value = ripple;
    this.flagUniforms();
  }

  private flagUniforms(): void {
    // `all` is undefined during construction; the constructor flushes at the end.
    const list = this.all;
    if (list === undefined) return;
    for (let i = 0; i < list.length; i++) list[i].uniformsNeedUpdate = true;
  }

  dispose(): void {
    for (const m of this.all) m.dispose();
  }
}
