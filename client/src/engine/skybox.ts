/**
 * DOOMCRAFT — sky.
 *
 * The bar's sky is one flat light blue with no gradient and no fog, so the
 * horizon is a hard line and distance carries no information (ref/BAR.md,
 * "Art"). Ours is a dark gradient with a hot ember band sitting exactly on the
 * horizon, and its horizon colour IS the fog colour — that is the whole trick.
 * Terrain fades into a value the sky is already showing at the same screen
 * height, so the render-distance boundary and the world edge become invisible
 * instead of becoming a wall.
 *
 * It draws as ONE full-screen triangle. The view ray is reconstructed per
 * fragment from the inverse projection and the view matrix, which means:
 *
 *   - one triangle and no depth buffer traffic instead of a 384-triangle dome,
 *   - no per-frame transform to keep in sync (a dome that is not re-centred on
 *     the camera every frame silently stops covering the screen, which is
 *     exactly the bug this replaced),
 *   - no near/far plane interaction at all.
 *
 * The only per-frame work is one uniform write, done from onBeforeRender, so
 * there is nothing a caller can forget.
 */

import * as THREE from 'three';
import {
  DOOM_FOG,
  DOOM_SKY_EMBER,
  DOOM_SKY_GROUND,
  DOOM_SKY_HIGH,
  DOOM_SKY_ZENITH,
} from './material';
import { SUN_DIR_X, SUN_DIR_Y, SUN_DIR_Z } from '@doomcraft/shared';

const VERT = /* glsl */ `
precision highp float;
uniform mat4 viewMatrix;
uniform mat4 uInvProjection;
in vec2 aPos;
out vec3 vDir;
void main() {
  // Clip-space triangle that covers the viewport; z = w pins it to the far plane.
  gl_Position = vec4(aPos, 1.0, 1.0);
  vec4 v = uInvProjection * vec4(aPos, 1.0, 1.0);
  vec3 viewDir = v.xyz / v.w;
  // The rotation part of a view matrix is orthonormal, so transpose inverts it.
  vDir = transpose(mat3(viewMatrix)) * viewDir;
}
`;

const FRAG = /* glsl */ `
precision mediump float;

uniform vec3  uZenith;
uniform vec3  uHigh;
uniform vec3  uHorizon;
uniform vec3  uGround;
uniform vec3  uEmber;
uniform vec3  uSunDir;
uniform float uEmberTightness;
uniform float uSunGlow;

in vec3 vDir;
layout(location = 0) out vec4 fragColor;

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;

  vec3 col;
  if (h >= 0.0) {
    // Two stops on the way up, so the band above the horizon stays warm for a
    // while instead of snapping to the dark zenith.
    float t = pow(h, 0.42);
    vec3 low = mix(uHorizon, uHigh, smoothstep(0.0, 0.55, t));
    col = mix(low, uZenith, smoothstep(0.45, 1.0, t));
  } else {
    col = mix(uHorizon, uGround, pow(-h, 0.55));
  }

  // The hot line on the horizon. It is the only bright thing in the sky, and it
  // is what gives distant silhouettes something to read against.
  col += uEmber * exp(-abs(h) * uEmberTightness) * 0.48;

  // Sun: a tight core plus a wide haze, both in the ember colour so the whole
  // sky stays on one palette.
  float s = max(dot(d, uSunDir), 0.0);
  col += uEmber * (pow(s, 220.0) * 1.4 + pow(s, 7.0) * 0.16) * uSunGlow;

  // Two instructions of ordered dither: an 8-bit dark gradient across a 900 px
  // screen bands badly, and this removes all of it.
  float dth = fract(dot(gl_FragCoord.xy, vec2(0.5, 0.25)));
  col += (dth - 0.375) * (2.0 / 255.0);

  fragColor = vec4(col, 1.0);
}
`;

function vec3FromHex(hex: number): THREE.Vector3 {
  return new THREE.Vector3(
    ((hex >>> 16) & 0xff) / 255,
    ((hex >>> 8) & 0xff) / 255,
    (hex & 0xff) / 255,
  );
}

export interface SkyboxOptions {
  zenith?: number;
  high?: number;
  /** Must equal the fog colour or the horizon shows a seam. */
  horizon?: number;
  ground?: number;
  ember?: number;
  /** Higher = thinner hot band. 30 is about one degree of sky. */
  emberTightness?: number;
  sunGlow?: number;
}

export class Skybox {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.RawShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private readonly uniforms: Record<string, THREE.IUniform>;

  constructor(opts: SkyboxOptions = {}) {
    this.uniforms = {
      uInvProjection: { value: new THREE.Matrix4() },
      uZenith: { value: vec3FromHex(opts.zenith ?? DOOM_SKY_ZENITH) },
      uHigh: { value: vec3FromHex(opts.high ?? DOOM_SKY_HIGH) },
      uHorizon: { value: vec3FromHex(opts.horizon ?? DOOM_FOG) },
      uGround: { value: vec3FromHex(opts.ground ?? DOOM_SKY_GROUND) },
      uEmber: { value: vec3FromHex(opts.ember ?? DOOM_SKY_EMBER) },
      uSunDir: { value: new THREE.Vector3(-SUN_DIR_X, -SUN_DIR_Y, -SUN_DIR_Z).normalize() },
      uEmberTightness: { value: opts.emberTightness ?? 30 },
      uSunGlow: { value: opts.sunGlow ?? 1 },
    };

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.FrontSide,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      fog: false,
      lights: false,
      toneMapped: false,
    });
    this.material.name = 'skybox';

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      'aPos', new THREE.BufferAttribute(new Float32Array([-1, -1, 3, -1, -1, 3]), 2),
    );
    this.geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'skybox';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.matrixWorldAutoUpdate = false;
    // Opaque, sorted by renderOrder first: this is effectively the clear.
    this.mesh.renderOrder = -10000;
    this.mesh.raycast = (): void => { /* the sky is not pickable */ };
    this.mesh.onBeforeRender = (
      _r: THREE.WebGLRenderer, _s: THREE.Scene, camera: THREE.Camera,
    ): void => {
      (this.uniforms.uInvProjection.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
      this.material.uniformsNeedUpdate = true;
    };
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.mesh);
  }

  /**
   * Kept for symmetry with the rest of the engine, and free to call. The sky
   * needs nothing per frame — onBeforeRender does the one uniform it wants.
   */
  update(_camera: THREE.Camera): void {
    /* intentionally empty */
  }

  /**
   * Horizon colour. Keep this equal to the fog colour; VoxelMaterials.fogColor
   * is the source of truth.
   */
  setHorizonColor(hex: number): void {
    (this.uniforms.uHorizon.value as THREE.Vector3).copy(vec3FromHex(hex));
    this.material.uniformsNeedUpdate = true;
  }

  setColors(opts: SkyboxOptions): void {
    const u = this.uniforms;
    if (opts.zenith !== undefined) (u.uZenith.value as THREE.Vector3).copy(vec3FromHex(opts.zenith));
    if (opts.high !== undefined) (u.uHigh.value as THREE.Vector3).copy(vec3FromHex(opts.high));
    if (opts.horizon !== undefined) (u.uHorizon.value as THREE.Vector3).copy(vec3FromHex(opts.horizon));
    if (opts.ground !== undefined) (u.uGround.value as THREE.Vector3).copy(vec3FromHex(opts.ground));
    if (opts.ember !== undefined) (u.uEmber.value as THREE.Vector3).copy(vec3FromHex(opts.ember));
    if (opts.emberTightness !== undefined) u.uEmberTightness.value = opts.emberTightness;
    if (opts.sunGlow !== undefined) u.uSunGlow.value = opts.sunGlow;
    this.material.uniformsNeedUpdate = true;
  }

  /** Direction light travels FROM the sun, matching SUN_DIR_* in constants. */
  setSunDirection(x: number, y: number, z: number): void {
    (this.uniforms.uSunDir.value as THREE.Vector3).set(-x, -y, -z).normalize();
    this.material.uniformsNeedUpdate = true;
  }

  /** Scale the sun core and haze, e.g. flare the sky during a BFG discharge. */
  setSunGlow(v: number): void {
    this.uniforms.uSunGlow.value = v;
    this.material.uniformsNeedUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
