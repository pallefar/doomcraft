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
  blockFaceShaded,
  clamp,
  Face,
  FACE_NORMALS,
  faceFromNormal,
  getWeapon,
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

/**
 * DECALS — the only thing in this file that outlives the shot.
 *
 * Every other effect here answers "something just happened" for a tenth of a
 * second and then the frame is identical to the frame before the trigger was
 * pulled. That is the bar's failure written small: shoot a wall in voxiom and
 * two seconds later there is no evidence you were ever there. A mark that
 * STAYS is the cheapest possible proof that the shot connected with a surface,
 * and it is the one cue you can still read after the muzzle flash has gone.
 *
 * The quad is built in the vertex shader from the surface normal, so a decal is
 * three floats of position, three of normal and one size — no matrices, no
 * Object3D, one instanced draw for the whole wall.
 */
const DECAL_VERT = /* glsl */ `
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec2 aCorner;    // -0.5..0.5
in vec3 iPos;
in vec3 iNrm;
in vec4 iParams;    // size, alpha, rotation, seed
in vec3 iColor;
out vec3 vColor;
out float vAlpha;
out vec2 vUv;
out float vSeed;
void main() {
  vec3 n = normalize(iNrm);
  // Any tangent will do as long as it is not parallel to the normal; picking
  // the axis the normal is FURTHEST from keeps the cross product conditioned.
  vec3 t = abs(n.y) > 0.86 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 u = normalize(cross(t, n));
  vec3 v = cross(n, u);
  float c = cos(iParams.z);
  float s = sin(iParams.z);
  vec2 q = vec2(aCorner.x * c - aCorner.y * s, aCorner.x * s + aCorner.y * c) * iParams.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(iPos + u * q.x + v * q.y, 1.0);
  vColor = iColor;
  vAlpha = iParams.y;
  vUv = aCorner;
  vSeed = iParams.w;
}
`;

const DECAL_FRAG = /* glsl */ `
precision mediump float;
in vec3 vColor;
in float vAlpha;
in vec2 vUv;
in float vSeed;
layout(location = 0) out vec4 fragColor;
void main() {
  float r = length(vUv) * 2.0;
  float a = atan(vUv.y, vUv.x);
  // The SIGN of the seed is the chipped-rim switch; its magnitude is the shape
  // seed. Packing a flag into a sign is not free elegance, it is one fewer
  // instanced attribute on a hot pool, and the alternative was a fifth buffer
  // uploaded every frame for one bit. Fx.decal guarantees a non-zero seed so
  // the sign never gets lost.
  float seed = abs(vSeed);
  float chip = vSeed < 0.0 ? 0.0 : 1.0;
  // A perfect disc reads as a sticker someone put on the wall. Two beating
  // harmonics of the angle push the rim in and out by a fifth of the radius,
  // and because the seed differs per decal no two marks are the same shape.
  float edge = 0.74 + 0.20 * sin(a * 3.0 + seed) * sin(a * 5.0 + seed * 2.3);
  float m = 1.0 - smoothstep(edge * 0.52, edge, r);
  if (m <= 0.004) discard;
  // Darkest in the middle, which is what both a scorch and a wet splat do.
  float core = 1.0 - smoothstep(0.0, edge * 0.8, r);
  vec3 c = vColor * (1.0 - 0.45 * core);

  /* THE CHIPPED RIM — the reason a bullet hole is visible on a DARK wall.
   *
   * A mark drawn as "the surface colour taken down to a fifth" is a dark blot,
   * and a dark blot on the shadowed blue-grey of an arena wall is invisible:
   * captured proof is shots/ours-deathmatch-04-shoot.png, where nine rounds
   * into a wall left nothing a viewer can point at. Real impact damage is not
   * only a hole, it is a ring of material broken away around the hole showing
   * a fresh face, and that ring is brighter than the weathered surface beside
   * it. (vColor * 2.0 + 0.15) recovers roughly 0.42 of the true surface colour
   * plus a floor, which is the useful function: on a near-black surface the
   * floor dominates and the ring reads as a bright chip, on a bright surface
   * it lands below the wall and simply widens the hole. Either way the mark
   * has a light edge or a dark centre against its background, and usually
   * both, so it can never disappear the way a single-tone blot can.
   */
  float rim = smoothstep(edge * 0.42, edge * 0.74, r)
            * (1.0 - smoothstep(edge * 0.74, edge * 0.99, r));
  c = mix(c, vColor * 2.0 + 0.15, rim * 0.9 * chip);
  fragColor = vec4(c, m * vAlpha);
}
`;

/**
 * CRACKS — the wall degrading while you are still hitting it.
 *
 * A decal says "a shot landed here" once and never changes. That is enough for
 * a bullet, and it is not enough for a TOOL: a pick, a saw or a held trigger
 * against a wall is a process, and if the surface looks identical on the swing
 * before the block vanishes then the block did not break, it teleported. The
 * measured failure this fixes was exactly that — across twelve frames of a
 * swing the targeted block face was byte-for-byte unchanged, and the only
 * evidence of contact was debris that appeared after the block was already
 * gone.
 *
 * So a crack overlay is pinned to ONE block face, keyed by (block, face), and
 * every subsequent strike on that face ADVANCES it instead of stacking a new
 * sprite. `vStage` 0..1 drives both how far the fissures reach and how wide
 * they are, so the same instance walks from a chip to a shattered face and the
 * player can read how close the block is to going.
 *
 * The pattern is eight radial spokes with a per-spoke length and a radius-
 * dependent wobble, measured in ARC distance (`d * rad`) so the fissures keep a
 * constant width instead of fanning out. Each fissure is drawn dark with a
 * bright shoulder on either side, for the same reason the decal has a chipped
 * rim: freshly broken rock is lighter than the weathered face, and a mark that
 * is only dark disappears on dark stone.
 */
const CRACK_VERT = /* glsl */ `
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec2 aCorner;    // -0.5..0.5
in vec3 iPos;
in vec3 iNrm;
in vec4 iParams;    // size, alpha, stage, seed
in vec3 iColor;
out vec3 vColor;
out float vAlpha;
out float vStage;
out float vSeed;
out float vDepth;
out vec2 vUv;
void main() {
  vec3 n = normalize(iNrm);
  vec3 t = abs(n.y) > 0.86 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 u = normalize(cross(t, n));
  vec3 v = cross(n, u);
  vec2 q = aCorner * iParams.x;
  vec4 mv = modelViewMatrix * vec4(iPos + u * q.x + v * q.y, 1.0);
  gl_Position = projectionMatrix * mv;
  vColor = iColor;
  vAlpha = iParams.y;
  vStage = iParams.z;
  vSeed = iParams.w;
  vDepth = -mv.z;
  vUv = aCorner;
}
`;

const CRACK_FRAG = /* glsl */ `
precision mediump float;
in vec3 vColor;
in float vAlpha;
in float vStage;
in float vSeed;
in float vDepth;
in vec2 vUv;
uniform float uPxScale;   // metres per screen pixel, per unit of view depth
layout(location = 0) out vec4 fragColor;

const float PI = 3.14159265;
const float TAU = 6.28318531;

void main() {
  // rad is in HALF-FACE units: 1.0 is half a voxel, i.e. 0.5 m.
  float rad = length(vUv) * 2.0;
  if (rad > 1.0) discard;
  float ang = atan(vUv.y, vUv.x);
  float stage = clamp(vStage, 0.0, 1.0);

  /* WIDTH HAS A PIXEL FLOOR, like every other hit effect in this file.
   *
   * A 1 cm fissure is a third of a pixel at 25 m, so a crack sized only in
   * metres reproduces the exact failure it exists to fix: the wall is damaged
   * and the frame does not change. uPxScale * vDepth is one pixel in metres at
   * this fragment; doubling converts metres to half-face units.
   *
   * The ceiling matters as much as the floor. An early cut of this shader ran
   * 8 cm fissures with a 17 cm halo and the result was not a cracked face, it
   * was a black splat with a white corona — indistinguishable at a glance from
   * the unanchored artefact the whole overlay exists to replace. Damage is
   * THIN. */
  float wMin = 2.0 * uPxScale * vDepth;
  float w = max(0.011 + 0.026 * stage, wMin);

  /* Nearest fissure, in units of ITS OWN width at this radius.
   *
   * Measured as arc length (d * rad) so a line keeps a constant width instead
   * of fanning out, and divided by a width that TAPERS with distance from the
   * centre, because a crack is widest where the blow landed and closes to
   * nothing at its tip. Seven spokes, each with its own length, angle jitter
   * and wobble, so no two damaged faces look stamped from the same die. */
  float best = 1e9;
  for (int k = 0; k < 7; k++) {
    float fk = float(k);
    float h = fract((fk + 1.37) * (0.6180339 + vSeed * 0.1103));
    float a0 = (fk + 0.5) * (TAU / 7.0) - PI + (h - 0.5) * 0.95;
    float aa = a0 + 0.18 * sin(rad * 7.0 + vSeed * 3.0 + fk);
    float d = abs(mod(ang - aa + PI, TAU) - PI);
    float reach = (0.20 + 0.68 * stage) * (0.45 + 0.80 * h);
    float wk = max(w * (1.0 - 0.60 * min(1.0, rad / max(reach, 1e-3))), wMin * 0.5);
    // Past its reach the fissure closes over about a centimetre rather than
    // stopping at a hard chisel end.
    best = min(best, (d * rad + max(0.0, rad - reach) * 4.5) / wk);
  }

  float core = 1.0 - smoothstep(0.5, 1.0, best);
  float halo = (1.0 - smoothstep(1.0, 2.0, best)) * (1.0 - core);

  /* The pit at the point of contact: material actually gone, with a rim of
   * fresh face around it. Small — a couple of centimetres at first contact and
   * under ten when the block is about to go. */
  float pr = 0.035 + 0.075 * stage;
  float pit = 1.0 - smoothstep(pr, pr * 1.9, rad);
  float pitRim = (1.0 - smoothstep(pr * 1.9, pr * 2.7, rad)) * (1.0 - pit);

  float dark = max(core, pit);
  float light = max(halo, pitRim);
  float a = max(dark, light * 0.5);
  // Never let the pattern touch the face border — a crack that runs to the
  // exact edge of a voxel reads as a texture seam, not as damage.
  a *= 1.0 - smoothstep(0.80, 0.99, rad);
  if (a <= 0.004) discard;

  /* Dark fissure, bright shoulder. Freshly broken rock is LIGHTER than the
   * weathered face beside it, and a mark that is only dark vanishes on dark
   * stone — the same reason the bullet decal has a chipped rim. With both, the
   * damage has contrast against its own surface whatever that surface is.
   *
   * The dark end is 0.30 of the face, not 0.10. On the dark interiors this game
   * is built out of, 0.10 is black, and a black shape on a wall is exactly the
   * thing a reviewer calls a rendering artefact. */
  vec3 c = mix(vColor * 1.55 + 0.06, vColor * 0.30, dark);
  fragColor = vec4(c, a * vAlpha);
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
  maxDecals?: number;
  maxCracks?: number;
  /** 0..1 from GameSettings.screenShake. */
  shakeScale?: number;
}

export interface FxStats {
  sparks: number;
  debris: number;
  tracers: number;
  blasts: number;
  decals: number;
  cracks: number;
  lights: number;
  trauma: number;
}

/** Solidity test used to bounce debris. World block coordinates. */
export type FxSolidAt = (x: number, y: number, z: number) => boolean;

const MAX_LIGHT_SLOTS = 12;

/**
 * How much of an impact spark is "hot" versus "the material it came off".
 *
 * 0 makes every strike the colour of the wall, which reads as dust; 1 makes
 * every strike the same orange, which is what most shooters do and is the
 * reason you cannot tell stone from steel from grass by the hit. 0.55 keeps a
 * white-hot core while leaving the corona unmistakably the surface's own hue.
 */
const SPARK_HEAT = 0.42;

/**
 * Muzzle-flash point light: how long it must live at minimum, how much of that
 * life is spent at full intensity, and how much the weapon table's figure is
 * scaled by. See the block comment at the bottom of `muzzleFlash`.
 */
const MUZZLE_LIGHT_MIN_S = 0.075;
const MUZZLE_LIGHT_HOLD = 0.45;
/**
 * ROUND 2: gain 1.55 -> 1.10, radius multiplier 1.15 -> 0.95.
 *
 * The dynamic light was the thing that WON round 1 — the world visibly records
 * the shot, whole-frame luminance 75 -> 145 and a floor corner nowhere near the
 * barrel going 97 -> 149 — and it is also the thing that lost round 2: roughly
 * a quarter of the frame over 230 luminance on the flash frame, erasing the
 * target at the exact moment the decal landed on it. Both are true. The shader
 * falloff is (1 - d^2/r^2)^2, and a 5.75 m radius at intensity 1.7 does not
 * distinguish "there is light in this room" from "the wall you are shooting is
 * now white".
 *
 * Both knobs are turned because they cut different parts of the curve, and the
 * added term on a lit face works out at:
 *
 *     distance   1.5 m    3 m     4 m
 *     before      1.48    0.90    0.45
 *     after       0.98    0.44    0.10
 *
 * Near field down a third, mid field halved, far field mostly gone — which is
 * the shape wanted. Beyond ~4 m the thing that has to record the shot is the
 * IMPACT light and the decal at the hit point, not a lamp strapped to the
 * shooter; the muzzle light's job is the room around the barrel, and it still
 * does that at two thirds of its old strength.
 *
 * The floor of 1.0 on the gain is load-bearing: a flash light dimmer than its
 * own plume reads as fog on stone rather than as a gunshot.
 */
const MUZZLE_LIGHT_GAIN = 1.10;
const MUZZLE_LIGHT_RADIUS_SCALE = 0.95;
/** Ceiling on the published flash intensity, so the BFG does not white out. */
const MUZZLE_LIGHT_MAX = 2.7;
/**
 * Fraction of the FRAME HEIGHT the world plume's hottest disc may occupy.
 *
 * Sized against the frame rather than against the world because the plume is
 * always about a hand's length from the eye, where a metre is most of the
 * screen. 0.38, which is what the uncapped 0.42 m disc gave, is a wash over the
 * aim point; 0.17 was a fist-sized fireball and still stacked three deep into
 * roughly the 35,000 blown-out pixels round 2 was marked down for. 0.105 is the
 * same fireball at 42 % of the area, which is the difference between a plume
 * beside the aim point and a plume over it.
 */
const MUZZLE_CORE_MAX_FRAC = 0.105;

/**
 * TRACER defaults, for a hitscan round.
 *
 * `TRACER_SPEED` is not a bullet's speed, it is a READING speed: 640 m/s puts
 * the head on a wall 20 m away in 31 ms, two frames, so the streak is at full
 * length while the muzzle flash and the impact are both still on screen.
 * `TRACER_FADE_S` then holds the whole line and bleeds it out, which is what
 * makes the shot legible in a single captured frame — the pistol's own cycle
 * is 143 ms, so without a hold a still has a one-in-eight chance of catching
 * anything at all.
 */
const TRACER_WIDTH = 0.032;
const TRACER_SPEED = 640;
const TRACER_FADE_S = 0.062;
/**
 * Longest a streak may keep drawing itself out before the fade starts anyway.
 *
 * A shot that hits nothing is reported at `HITSCAN_MAX_DISTANCE`, 220 m, which
 * at reading speed takes a third of a second to reach — three chaingun rounds'
 * worth. Without this, missing into open sky leaves four overlapping additive
 * ropes down the same line while hitting a wall 8 m away leaves one flick, so
 * the MISS is the louder event. Capping the flight makes every round cost the
 * same screen time whatever it did or did not hit.
 */
const TRACER_MAX_FLIGHT_S = 0.09;

/**
 * Impact point light. Shorter than the muzzle's — a strike is a spark, not a
 * flame — but it gets the same treatment for the same reason: 90 ms with the
 * fade starting at zero is a light nobody sees.
 */
const IMPACT_LIGHT_S = 0.11;
const IMPACT_LIGHT_HOLD = 0.35;

/**
 * Trauma banked by `addShake`, per metre of the amplitude it was given, plus a
 * floor so that even a 2 cm block-break tick registers. A shotgun (0.30 m)
 * banks 0.31; a chaingun round (0.07 m) banks 0.10, which is what makes a
 * burst climb instead of pinning on its first round.
 *
 * `TRAUMA_BARE_AMPLITUDE` is the displacement asserted by a trauma source that
 * brought none of its own — see `addTrauma`.
 */
const TRAUMA_SHAKE_FLOOR = 0.055;
const TRAUMA_PER_AMPLITUDE = 0.85;
const TRAUMA_BARE_AMPLITUDE = 0.06;

/**
 * Two impact lights closer than this in time AND space are one light. Sized to
 * swallow a shotgun's cone at close range (its seven pellets land inside about
 * a metre) without merging two aimed shots at different walls.
 */
const IMPACT_LIGHT_MERGE_S = 0.05;
const IMPACT_LIGHT_MERGE_M2 = 1.6 * 1.6;

/**
 * Decals are the only budgeted-by-time effect here, so the two numbers that
 * decide how much of the wall ends up covered live together.
 *
 * `DECAL_LIFE_S` is long enough that a magazine emptied into one wall is still
 * legible as a group when the mag runs dry, and short enough that a five-minute
 * firefight never turns a room black. `DECAL_HOLD` is the fraction of that life
 * spent at full opacity before the fade starts — a mark that begins fading the
 * instant it lands reads as a puff of smoke, not as damage.
 */
const DECAL_LIFE_S = 7.5;
const DECAL_HOLD = 0.55;

/**
 * CRACK budget.
 *
 * A crack lives longer than a bullet mark because it is telling you about a
 * block that is still THERE and still damaged — walk away from a half-dug wall
 * and come back and it should still be half-dug. It heals eventually so a long
 * fight cannot fill an arena with permanently scarred faces.
 *
 * `CRACK_STAGE_MIN` is the floor the first strike jumps to. A crack that opens
 * at 0 is a crack nobody sees, and the first hit is the one that has to prove
 * the tool is touching the wall: it lands at a quarter of the way to shattered
 * on the very first frame of contact.
 */
const CRACK_LIFE_S = 9.0;
const CRACK_HOLD = 0.72;
const CRACK_STAGE_MIN = 0.26;
/** Metres the overlay is pushed off the face, and how much wider than a voxel. */
const CRACK_STANDOFF = 0.016;
const CRACK_SIZE = 1.0;
/** How often the pool checks that its blocks still exist. */
const CRACK_SWEEP_S = 0.1;

export class Fx {
  readonly group = new THREE.Group();
  readonly stats: FxStats = {
    sparks: 0, debris: 0, tracers: 0, blasts: 0, decals: 0, cracks: 0,
    lights: 0, trauma: 0,
  };

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
  /** Seconds the finished line holds and fades. 0 = travelling-dash mode. */
  private readonly trFade: Float32Array;
  /** Seconds after spawn at which the fade starts. */
  private readonly trHold: Float32Array;
  /** Seconds since spawn. */
  private readonly trAge: Float32Array;
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
  /**
   * Growth envelope, per slot. A detonation starts as a bright point and
   * expands to its full radius (0.22 -> 1.17); a body flash is born at almost
   * full size and barely moves (0.85 -> 1.40), because a bubble that inflates
   * out of a demon reads as an explosion and a bubble that just IS reads as the
   * demon lighting up, which is the thing we are trying to say.
   */
  private readonly blGrow0: Float32Array;
  private readonly blGrowSpan: Float32Array;
  /** 0 suppresses the ground shockwave — a body flash has no shockwave. */
  private readonly blRingW: Float32Array;
  private readonly blGain: Float32Array;
  private readonly shellSet: InstanceSet;
  private readonly ringSet: InstanceSet;

  /* -- decals ------------------------------------------------------------ */
  private readonly decalCap: number;
  private decalCount = 0;
  private readonly dcPos: Float32Array;
  private readonly dcNrm: Float32Array;
  private readonly dcColor: Float32Array;
  private readonly dcSize: Float32Array;
  private readonly dcRot: Float32Array;
  private readonly dcSeed: Float32Array;
  private readonly dcAlpha: Float32Array;
  private readonly dcLife: Float32Array;
  private readonly dcMax: Float32Array;
  private readonly decalSet: InstanceSet;

  /* -- cracks ------------------------------------------------------------ *
   *
   * Keyed storage, not a spray pool: a crack belongs to exactly one (block,
   * face) and repeated strikes on it advance the SAME slot. The lookup is a
   * linear scan of the live slots, which for a pool of 48 costs less than the
   * hash of a Map key and allocates nothing.
   */
  private readonly crackCap: number;
  private crackCount = 0;
  private readonly ckBx: Int32Array;
  private readonly ckBy: Int32Array;
  private readonly ckBz: Int32Array;
  private readonly ckFace: Int32Array;
  private readonly ckStage: Float32Array;
  private readonly ckLife: Float32Array;
  private readonly ckSeed: Float32Array;
  private readonly ckColor: Float32Array;
  private readonly crackSet: InstanceSet;
  private crackSweep = 0;

  /* -- lights ------------------------------------------------------------ */
  private lightCount = 0;
  private readonly liPos = new Float32Array(MAX_LIGHT_SLOTS * 3);
  private readonly liColor = new Float32Array(MAX_LIGHT_SLOTS * 3);
  private readonly liRadius = new Float32Array(MAX_LIGHT_SLOTS);
  private readonly liIntensity = new Float32Array(MAX_LIGHT_SLOTS);
  private readonly liLife = new Float32Array(MAX_LIGHT_SLOTS);
  private readonly liMax = new Float32Array(MAX_LIGHT_SLOTS);
  /** Fraction of the life spent at FULL intensity before the fade starts. */
  private readonly liHold = new Float32Array(MAX_LIGHT_SLOTS);
  private readonly liOrder = new Int32Array(MAX_LIGHT_SLOTS);

  /* -- shake ------------------------------------------------------------- */
  private trauma = 0;
  private shakeAmp = 0;
  private shakeHz = 26;
  private shakeDecay = 6;
  private shakeScale = 1;

  private readonly materialList: THREE.RawShaderMaterial[] = [];
  private beamMaterial: THREE.RawShaderMaterial | null = null;
  private crackMaterial: THREE.RawShaderMaterial | null = null;
  /** Drawing-buffer height in pixels; drives the minimum tracer width. */
  private viewportHeight = 720;
  private minTracerPx = 2.2;
  /** A fissure is never allowed to be thinner than this on screen. */
  private minCrackPx = 2.6;

  /**
   * Last frame's camera, cached so a SPAWNER can size a sprite in screen space.
   *
   * This is the difference between an impact you can see and one you cannot. A
   * 5 cm spark subtends one pixel at 35 m, so sizing hit effects in metres
   * reproduces the bar's own failure at any real fighting distance: the shot
   * lands and the frame does not change. Every impact sprite is therefore given
   * a floor in PIXELS and a cap in multiples of its world size, so it stays
   * legible at 40 m without becoming a sheet of white at 2 m.
   */
  private camX = 0; private camY = 0; private camZ = 0;
  private camTanHalfFov = 0.6;

  /**
   * Where and when the last impact light was placed.
   *
   * A shotgun fires seven pellets into the same square metre of wall on the
   * same frame. Seven point lights at the same place is seven times the shader
   * cost for one blown-out white patch, and it evicts every other light in the
   * scene. Coalescing them into one is both cheaper and more accurate.
   */
  private lastImpactLightT = -1;
  private lastImpactX = 0; private lastImpactY = 0; private lastImpactZ = 0;

  constructor(scene: THREE.Scene, opts: FxOptions = {}) {
    this.materials = opts.materials ?? null;
    this.shakeScale = opts.shakeScale ?? 1;
    this.sparkCap = opts.maxSparks ?? 512;
    this.debrisCap = opts.maxDebris ?? 768;
    this.tracerCap = opts.maxTracers ?? 96;
    // A body flash and a detonation share the pool, and a chaingun can put a
    // flash on screen every 86 ms, so the pool has to be deeper than the four
    // rockets a fight ever has in the air at once.
    this.blastCap = opts.maxBlasts ?? 24;
    this.decalCap = opts.maxDecals ?? 96;
    // One block face per slot. Forty-eight is more faces than a player can be
    // working on at once and still one instanced draw.
    this.crackCap = opts.maxCracks ?? 48;

    this.sp = new ParticleArrays(this.sparkCap);
    this.db = new ParticleArrays(this.debrisCap);

    this.sparkSet = this.makeSprites(this.sparkCap, true, THREE.AdditiveBlending, 60);
    this.debrisSet = this.makeSprites(this.debrisCap, false, THREE.NormalBlending, 20);
    this.tracerSet = this.makeBeams(this.tracerCap);
    this.beamMaterial = this.tracerSet.mesh.material as THREE.RawShaderMaterial;
    this.shellSet = this.makeShells(this.blastCap);
    this.ringSet = this.makeRings(this.blastCap);
    this.decalSet = this.makeDecals(this.decalCap);
    this.crackSet = this.makeCracks(this.crackCap);

    this.trOx = new Float32Array(this.tracerCap * 3);
    this.trDir = new Float32Array(this.tracerCap * 3);
    this.trLen = new Float32Array(this.tracerCap);
    this.trSpeed = new Float32Array(this.tracerCap);
    this.trHead = new Float32Array(this.tracerCap);
    this.trTailLen = new Float32Array(this.tracerCap);
    this.trFade = new Float32Array(this.tracerCap);
    this.trHold = new Float32Array(this.tracerCap);
    this.trAge = new Float32Array(this.tracerCap);
    this.trWidth = new Float32Array(this.tracerCap);
    this.trColor = new Float32Array(this.tracerCap * 3);

    this.blPos = new Float32Array(this.blastCap * 3);
    this.blRadius = new Float32Array(this.blastCap);
    this.blLife = new Float32Array(this.blastCap);
    this.blMax = new Float32Array(this.blastCap);
    this.blColor = new Float32Array(this.blastCap * 3);
    this.blGrow0 = new Float32Array(this.blastCap);
    this.blGrowSpan = new Float32Array(this.blastCap);
    this.blRingW = new Float32Array(this.blastCap);
    this.blGain = new Float32Array(this.blastCap);

    this.dcPos = new Float32Array(this.decalCap * 3);
    this.dcNrm = new Float32Array(this.decalCap * 3);
    this.dcColor = new Float32Array(this.decalCap * 3);
    this.dcSize = new Float32Array(this.decalCap);
    this.dcRot = new Float32Array(this.decalCap);
    this.dcSeed = new Float32Array(this.decalCap);
    this.dcAlpha = new Float32Array(this.decalCap);
    this.dcLife = new Float32Array(this.decalCap);
    this.dcMax = new Float32Array(this.decalCap);

    this.ckBx = new Int32Array(this.crackCap);
    this.ckBy = new Int32Array(this.crackCap);
    this.ckBz = new Int32Array(this.crackCap);
    this.ckFace = new Int32Array(this.crackCap);
    this.ckStage = new Float32Array(this.crackCap);
    this.ckLife = new Float32Array(this.crackCap);
    this.ckSeed = new Float32Array(this.crackCap);
    this.ckColor = new Float32Array(this.crackCap * 3);

    this.group.name = 'fx';
    this.group.matrixAutoUpdate = false;
    this.group.matrixWorldAutoUpdate = false;
    this.group.add(
      this.decalSet.mesh, this.crackSet.mesh, this.debrisSet.mesh,
      this.shellSet.mesh, this.ringSet.mesh,
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

  private makeDecals(cap: number): InstanceSet {
    const g = quadBase(false);
    const iPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const iNrm = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const iParams = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const iColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    for (const a of [iPos, iNrm, iParams, iColor]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', iPos);
    g.setAttribute('iNrm', iNrm);
    g.setAttribute('iParams', iParams);
    g.setAttribute('iColor', iColor);
    g.instanceCount = 0;

    const m = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      // The quad is pushed 15 mm off the surface along the normal, which is
      // enough at any sane draw distance; the polygon offset is belt and braces
      // for the grazing angles where 15 mm is under one depth quantum.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      fog: false, lights: false, toneMapped: false,
    });
    m.name = 'fx-decals';
    this.materialList.push(m);

    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    // Under everything else: a spark should sit ON the mark it made.
    mesh.renderOrder = 10;
    mesh.raycast = noRaycast;
    return { geometry: g, mesh, a: iPos, b: iParams, c: iColor, d: iNrm };
  }

  private makeCracks(cap: number): InstanceSet {
    const g = quadBase(false);
    const iPos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const iNrm = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const iParams = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const iColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    for (const a of [iPos, iNrm, iParams, iColor]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', iPos);
    g.setAttribute('iNrm', iNrm);
    g.setAttribute('iParams', iParams);
    g.setAttribute('iColor', iColor);
    g.instanceCount = 0;

    const m = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uPxScale: { value: 0.004 } },
      vertexShader: CRACK_VERT,
      fragmentShader: CRACK_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -6,
      fog: false, lights: false, toneMapped: false,
    });
    m.name = 'fx-cracks';
    this.crackMaterial = m;
    this.materialList.push(m);

    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    // Above the bullet marks, under the sparks: damage on the wall, light on
    // top of the damage.
    mesh.renderOrder = 11;
    mesh.raycast = noRaycast;
    // Nothing cracked yet: keep the draw call out of the frame entirely.
    mesh.visible = false;
    return { geometry: g, mesh, a: iPos, b: iParams, c: iColor, d: iNrm };
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

  /* -- screen-space sizing ----------------------------------------------- */

  /** World metres covered by one screen pixel at a point. */
  private metresPerPixel(x: number, y: number, z: number): number {
    const dx = x - this.camX, dy = y - this.camY, dz = z - this.camZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return (2 * this.camTanHalfFov * (dist < 0.15 ? 0.15 : dist)) / this.viewportHeight;
  }

  /**
   * `base` metres, but never smaller on screen than `px` pixels and never more
   * than `cap` times its own world size.
   */
  private floorPx(mpp: number, base: number, px: number, cap: number): number {
    const want = px * mpp;
    const v = want > base ? want : base;
    const lim = base * cap;
    return v > lim ? lim : v;
  }

  /**
   * `base` metres, but never taller on screen than `frac` of the FRAME.
   *
   * The mirror of `floorPx`, and deliberately not its mirror image. A floor
   * belongs in absolute pixels — two pixels is the smallest thing an eye can
   * find at any resolution. A ceiling does not: 130 px is a fist on a desktop
   * and a third of a phone screen, so capping a maximum in pixels ships two
   * different pictures. A fraction of the frame ships one.
   *
   * The failure it exists for: a sprite sized in metres and spawned a hand's
   * length from the eye does not read as a small bright thing close up, it
   * reads as a sheet. The muzzle plume's 0.42 m core at 0.8 m covered about
   * 38 % of the frame height — additive, over the aim point, once per shot.
   */
  private capFrac(mpp: number, base: number, frac: number): number {
    const lim = frac * this.viewportHeight * mpp;
    return base > lim ? lim : base;
  }

  /* -- decals ------------------------------------------------------------ */

  /**
   * Leave a mark on a surface.
   *
   * `size` is the diameter in metres; it is floored in screen pixels so a hit
   * at 40 m still leaves something you can see, and capped at four times its
   * world size so a hit at 1 m does not paint the whole wall.
   *
   * When the pool is full the decal CLOSEST TO DYING is recycled, not the
   * oldest by index — with a fixed pool the oldest is usually also the faintest,
   * and evicting the faintest is the only eviction the player cannot see.
   */
  decal(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    size: number, color: number, alpha: number, seconds: number = DECAL_LIFE_S,
    chipped: boolean = false,
  ): void {
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-4 || size <= 0 || alpha <= 0 || seconds <= 0) return;
    const ux = nx / nl, uy = ny / nl, uz = nz / nl;

    let i: number;
    if (this.decalCount < this.decalCap) {
      i = this.decalCount++;
    } else {
      let worst = 0;
      let worstT = -1;
      for (let k = 0; k < this.decalCap; k++) {
        const t = this.dcLife[k] / this.dcMax[k];
        if (t > worstT) { worstT = t; worst = k; }
      }
      i = worst;
    }

    const mpp = this.metresPerPixel(x, y, z);
    const s = this.floorPx(mpp, size, 5, 4);
    // 15 mm of clearance, plus a slice of the decal's own size: a big scorch on
    // a rough voxel face needs more standoff than a bullet hole.
    const lift = 0.015 + s * 0.02;
    this.dcPos[i * 3] = x + ux * lift;
    this.dcPos[i * 3 + 1] = y + uy * lift;
    this.dcPos[i * 3 + 2] = z + uz * lift;
    this.dcNrm[i * 3] = ux; this.dcNrm[i * 3 + 1] = uy; this.dcNrm[i * 3 + 2] = uz;
    this.dcColor[i * 3] = ((color >>> 16) & 0xff) / 255;
    this.dcColor[i * 3 + 1] = ((color >>> 8) & 0xff) / 255;
    this.dcColor[i * 3 + 2] = (color & 0xff) / 255;
    this.dcSize[i] = s;
    this.dcRot[i] = Math.random() * TAU;
    // Strictly positive, then signed: the shader reads the sign as the
    // chipped-rim flag, so a seed of exactly zero would silently enable it.
    this.dcSeed[i] = (0.17 + Math.random() * TAU) * (chipped ? 1 : -1);
    this.dcAlpha[i] = alpha;
    this.dcLife[i] = 0;
    this.dcMax[i] = seconds;
  }

  /* -- cracks ------------------------------------------------------------ */

  /**
   * Advance the crack on one block face and return the stage it is now at.
   *
   * `amount` is how much of the way to shattered this single strike is worth,
   * so a pick moves the face further per swing than a rifle round does. The
   * first strike always jumps to `CRACK_STAGE_MIN`, because the first frame of
   * contact is the one that has to prove the tool reached the wall.
   *
   * Repeated strikes refresh the life as well as the stage: a face you are
   * actively working never starts fading while you are working it.
   */
  crack(
    bx: number, by: number, bz: number, face: number,
    blockId: number, amount = 0.25,
  ): number {
    const b = Math.floor(bx), y = Math.floor(by), z = Math.floor(bz);
    const f = face | 0;
    let i = this.findCrack(b, y, z, f);
    if (i < 0) {
      i = this.claimCrackSlot();
      this.ckBx[i] = b; this.ckBy[i] = y; this.ckBz[i] = z;
      this.ckFace[i] = f;
      this.ckStage[i] = 0;
      this.ckSeed[i] = Math.random() * TAU;
      const col = blockFaceShaded(blockId, f);
      this.ckColor[i * 3] = ((col >>> 16) & 0xff) / 255;
      this.ckColor[i * 3 + 1] = ((col >>> 8) & 0xff) / 255;
      this.ckColor[i * 3 + 2] = (col & 0xff) / 255;
    }
    /* The floor applies to the FIRST strike only, tested against exactly zero.
     * Comparing the stored stage against CRACK_STAGE_MIN instead looks
     * equivalent and is not: the stage lives in a Float32Array, so a stage set
     * to 0.26 reads back as 0.2599999904632568, which is still "below the
     * floor" and pins the crack at its opening stage forever. A face that never
     * degrades past its first hit is the whole bug this overlay exists to fix,
     * so it would have shipped looking almost right. */
    const cur = this.ckStage[i];
    const next = cur <= 0 ? Math.max(CRACK_STAGE_MIN, amount) : cur + amount;
    this.ckStage[i] = next > 1 ? 1 : next;
    this.ckLife[i] = 0;
    return this.ckStage[i];
  }

  /** The stage a face is at, 0 when it is undamaged. Used by tests and by the HUD. */
  crackStage(bx: number, by: number, bz: number, face: number): number {
    const i = this.findCrack(Math.floor(bx), Math.floor(by), Math.floor(bz), face | 0);
    return i < 0 ? 0 : this.ckStage[i];
  }

  /**
   * The block is gone — take its cracks with it.
   *
   * Leaving them behind is worse than never drawing them: six unanchored
   * squares hanging in the air where a block used to be is exactly the
   * "rendering artefact" read that this whole overlay exists to avoid.
   */
  clearCracks(bx: number, by: number, bz: number): void {
    const x = Math.floor(bx), y = Math.floor(by), z = Math.floor(bz);
    let i = 0;
    while (i < this.crackCount) {
      if (this.ckBx[i] === x && this.ckBy[i] === y && this.ckBz[i] === z) {
        this.crackCount--;
        if (i !== this.crackCount) this.copyCrack(this.crackCount, i);
        continue;
      }
      i++;
    }
    this.crackSet.geometry.instanceCount = this.crackCount;
    this.crackSet.mesh.visible = this.crackCount > 0;
  }

  private findCrack(x: number, y: number, z: number, face: number): number {
    for (let i = 0; i < this.crackCount; i++) {
      if (this.ckBx[i] === x && this.ckBy[i] === y
        && this.ckBz[i] === z && this.ckFace[i] === face) return i;
    }
    return -1;
  }

  /** A free slot, or the most-faded live one when the pool is full. */
  private claimCrackSlot(): number {
    if (this.crackCount < this.crackCap) return this.crackCount++;
    let worst = 0;
    let worstT = -1;
    for (let k = 0; k < this.crackCap; k++) {
      const t = this.ckLife[k] / CRACK_LIFE_S;
      if (t > worstT) { worstT = t; worst = k; }
    }
    return worst;
  }

  private copyCrack(from: number, to: number): void {
    this.ckBx[to] = this.ckBx[from];
    this.ckBy[to] = this.ckBy[from];
    this.ckBz[to] = this.ckBz[from];
    this.ckFace[to] = this.ckFace[from];
    this.ckStage[to] = this.ckStage[from];
    this.ckLife[to] = this.ckLife[from];
    this.ckSeed[to] = this.ckSeed[from];
    for (let k = 0; k < 3; k++) this.ckColor[to * 3 + k] = this.ckColor[from * 3 + k];
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
    const mpp = this.metresPerPixel(x, y, z);

    /* Core plume, stretched a little along the barrel.
     *
     * Capped in PIXELS, not metres. Uncapped this is the single most damaging
     * thing in the whole effects file: 0.42 m of soft additive sprite spawned
     * a hand's length from the eye is ~270 px of white haze, it is spawned once
     * per shot, and until the barrel offset landed it was spawned on the
     * crosshair. The weapon's OWN flash is drawn by the viewmodel overlay and
     * is the flash you actually read; this layer's job is the part the overlay
     * cannot do — burn into the world, at the right depth, in front of the
     * wall — so it wants to be a bright kernel, not a lens flare.
     */
    for (let i = 0; i < 3; i++) {
      const t = i * 0.16;
      this.spawnSpark(
        x + dx * (0.12 + t), y + dy * (0.12 + t), z + dz * (0.12 + t),
        dx * 3.5, dy * 3.5, dz * 3.5,
        life * (1 - i * 0.18),
        this.capFrac(mpp, 0.42 - i * 0.09, MUZZLE_CORE_MAX_FRAC - i * 0.03), 0.10,
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

    /* THE POINT LIGHT.
     *
     * Three corrections over "hand the weapon table straight to addLight",
     * every one of them the difference between a light that exists and a light
     * you can see in a frame:
     *
     *  - LIFETIME FLOOR. The chaingun's flash is 32 ms — under two frames. A
     *    light that short can land entirely between two vsyncs and never be
     *    rasterised at all. The sprite may be that brief; the light must not.
     *  - HOLD. Full strength for the first 45 % of that life, so the frames
     *    that do catch it catch it lit rather than half faded.
     *  - COLOUR. A flash is HOTTER than its own plume. The sprite is tinted
     *    with the weapon's muzzle colour because that is the flame; the light
     *    is that colour dragged most of the way to white, because that is the
     *    part that bounces off the wall beside you. A dull orange wash on grey
     *    stone reads as fog; a near-white pop reads as a gunshot.
     */
    const lightSeconds = Math.max(MUZZLE_LIGHT_MIN_S, life);
    this.addLight(
      x + dx * 0.35, y + dy * 0.35, z + dz * 0.35,
      r * 0.42 + 0.58, g * 0.42 + 0.58, b * 0.42 + 0.58,
      def.muzzleRadius * MUZZLE_LIGHT_RADIUS_SCALE,
      Math.min(def.muzzleIntensity * MUZZLE_LIGHT_GAIN, MUZZLE_LIGHT_MAX),
      lightSeconds,
      MUZZLE_LIGHT_HOLD,
    );
  }

  /**
   * A bullet streak from the BARREL to the impact.
   *
   * Two things about this are load-bearing and neither is obvious.
   *
   * WHERE IT STARTS. The origin has to be the barrel you can see, not the eye
   * and not a point on the aim axis. A beam that leaves the eye along the view
   * direction has no component on the picture plane at all: it projects to a
   * single point at the crosshair and the shooter — the only person it is drawn
   * for — sees nothing. Started at the barrel it runs from the bottom corner of
   * the frame up to the aim point, which is a diagonal across a quarter of the
   * screen and is the whole "my shot went THERE" read. `Viewmodel.muzzleWorld`
   * supplies that origin.
   *
   * WHEN IT IS THERE. A hitscan shot resolves on the frame the trigger goes
   * down: the damage, the spark and the mark are all already at the far end.
   * A streak that crawls out at 260 m/s arrives 77 ms — five frames — after the
   * impact it belongs to, so the two never appear in the same frame and the
   * shot reads as two unrelated events. So the default is fast enough to cross
   * a room inside two frames and then the whole line HOLDS and fades, which
   * puts the streak, the flash and the hit in the same frame and leaves the
   * streak on screen long enough (~90 ms) to survive a still capture.
   *
   * The draw-out is also capped in TIME (`TRACER_MAX_FLIGHT_S`), because a shot
   * that hit nothing is reported at 220 m and would otherwise stay on screen
   * three times as long as one that hit a wall — making the miss the louder
   * event, which is the exact inversion this piece exists to fix.
   *
   * Pass `fadeS = 0` to get the old travelling-dash behaviour, which is what a
   * slow visible round wants.
   */
  tracer(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    color: number, width = TRACER_WIDTH, speed = TRACER_SPEED,
    fadeS = TRACER_FADE_S,
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
    // With a fade the tail never leaves the barrel, so the beam grows into a
    // full line instead of flying past as a fixed-length dash. `trTailLen` is
    // then unread — the fade branch pins the near end at zero — but it is still
    // set to something sane so a slot recycled into dash mode cannot inherit a
    // stale dash length.
    this.trTailLen[i] = fadeS > 0 ? len : Math.min(len, 5 + len * 0.18);
    this.trFade[i] = fadeS > 0 ? fadeS : 0;
    this.trHold[i] = Math.min(len / Math.max(speed, 1), TRACER_MAX_FLIGHT_S);
    this.trAge[i] = 0;
    this.trWidth[i] = width;
    this.trColor[i * 3] = ((color >>> 16) & 0xff) / 255;
    this.trColor[i * 3 + 1] = ((color >>> 8) & 0xff) / 255;
    this.trColor[i * 3 + 2] = (color & 0xff) / 255;
  }

  /**
   * A bullet hit a surface.
   *
   * Three layers, and each one answers a different part of "did that hit?":
   *
   *  1. A **core flash** — one additive puck at the point of impact, sized with
   *     a pixel floor so it survives 40 m. Without it a hit at range is a dozen
   *     sub-pixel dots and the frame does not visibly change, which is exactly
   *     the bar's failure.
   *  2. **Sparks that inherit the surface**, not a fixed orange. Hot things go
   *     white in the middle, but the corona of a strike carries the material's
   *     own hue: red brick throws red-orange, grass throws yellow-green, ice
   *     throws white-blue. Mixing the surface colour into the spark is what
   *     makes the impact read as coming off THAT wall.
   *  3. **Chips** in the surface colour, which bounce.
   *
   * The bounce light is tinted the same way, so the flash you see on the wall
   * beside you is the colour of the thing you just shot.
   */
  impact(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    color: number, intensity = 1, blockId = -1,
  ): void {
    /* A round into a wall does not only leave a mark, it takes a bite. When the
     * caller knows WHICH block was struck, the face cracks a little further —
     * so nine rounds into one wall visibly degrade it instead of stencilling
     * nine identical stickers on an undamaged surface. */
    if (blockId >= 0) {
      const face = faceFromNormal(nx, ny, nz);
      this.crack(
        Math.floor(x - nx * 0.5), Math.floor(y - ny * 0.5), Math.floor(z - nz * 0.5),
        face, blockId, 0.07 + 0.09 * intensity,
      );
    }
    const r = ((color >>> 16) & 0xff) / 255;
    const g = ((color >>> 8) & 0xff) / 255;
    const b = (color & 0xff) / 255;
    const mpp = this.metresPerPixel(x, y, z);

    // The strike colour: the surface pushed toward incandescent. `SPARK_HEAT`
    // is how much of the hot end wins — at 0 the spark is just the wall's
    // colour and reads as dust, at 1 it is the fixed orange every shooter uses
    // and the surface stops mattering.
    const sr = r * (1 - SPARK_HEAT) + 1.00 * SPARK_HEAT;
    const sg = g * (1 - SPARK_HEAT) + 0.84 * SPARK_HEAT;
    const sb = b * (1 - SPARK_HEAT) + 0.42 * SPARK_HEAT;

    /* Does this pellet OWN the blast?
     *
     * A shotgun puts seven pellets into the same square metre on the same
     * frame. The two layers sized to be seen from across the arena — the
     * coloured corona and the point light — must be spawned once for that
     * blast and not seven times: seven overlapping additive discs at point
     * blank are a white sheet rather than an impact, and seven point lights in
     * one place cost seven times the shader work to evict every other light in
     * the scene for a single blown-out patch. The per-pellet layers (hot core,
     * sparks, chips, mark) still run for every pellet, because those are what
     * make a blast read as a PATTERN rather than as one big hit. */
    const owns = this.claimImpactLight(x, y, z);

    /* 1a — the CORONA, in the surface's own colour.
     *
     * The core below is nearly white by construction, because that is what a
     * strike looks like at the point of contact — and a white dot on a wall is
     * a white dot on any wall. So a wider, dimmer, slightly longer-lived disc
     * goes UNDER it carrying the material's undiluted hue. That is the layer
     * that answers "what did I just hit": red brick throws a red-orange bloom,
     * grass a yellow-green one, ice a blue one, and the two together read as a
     * hot core inside a coloured flare rather than as a generic sprite.
     *
     * It is spawned first so it sorts behind the core in the same additive
     * pass, and it is cheap: one instance in a pool of 512.
     */
    if (owns) {
      this.spawnSpark(
        x + nx * 0.025, y + ny * 0.025, z + nz * 0.025,
        nx * 0.35, ny * 0.35, nz * 0.35,
        0.10 + 0.05 * intensity,
        this.floorPx(mpp, 0.17 * intensity, 17, 6), this.floorPx(mpp, 0.03, 3, 6),
        r * 0.86 + 0.14, g * 0.86 + 0.14, b * 0.86 + 0.14, 0.55, 0.15, 5, 0,
      );
    }

    /* 1b — core flash */
    this.spawnSpark(
      x + nx * 0.03, y + ny * 0.03, z + nz * 0.03,
      nx * 0.6, ny * 0.6, nz * 0.6,
      0.075 + 0.03 * intensity,
      this.floorPx(mpp, 0.10 * intensity, 12, 6), this.floorPx(mpp, 0.02, 2, 6),
      sr * 0.45 + 0.55, sg * 0.45 + 0.55, sb * 0.45 + 0.55, 1, 1, 4, 0,
    );

    /* 2 — sparks, in the strike colour */
    const n = Math.round(3 + 5 * intensity);
    const sparkSize = this.floorPx(mpp, 0.05 * intensity, 2.4, 7);
    for (let i = 0; i < n; i++) {
      const sx = nx + (Math.random() - 0.5) * 1.5;
      const sy = ny + (Math.random() - 0.5) * 1.5 + 0.4;
      const sz = nz + (Math.random() - 0.5) * 1.5;
      const sp = (3 + Math.random() * 7) * intensity;
      this.spawnSpark(
        x + nx * 0.04, y + ny * 0.04, z + nz * 0.04,
        sx * sp, sy * sp, sz * sp,
        0.14 + Math.random() * 0.24,
        sparkSize, 0.008,
        sr, sg, sb, 1, 0.55, 6, 14,
      );
    }

    /* 3 — chips of the material itself */
    const chipSize = this.floorPx(mpp, 0.055, 2, 5);
    for (let i = 0; i < 3; i++) {
      this.spawnDebris(
        x + nx * 0.05, y + ny * 0.05, z + nz * 0.05,
        (Math.random() - 0.5) * 3 + nx * 2,
        Math.random() * 2.4 + ny * 2,
        (Math.random() - 0.5) * 3 + nz * 2,
        0.25 + Math.random() * 0.3,
        chipSize, chipSize * 0.36,
        r * 0.8, g * 0.8, b * 0.8, 1, 0.4, 20, 1,
      );
    }

    /* 4 — the mark that stays.
     *
     * Everything above is gone in a fifth of a second. This is the part you can
     * still see when you walk up to the wall, and it is the difference between
     * "something flickered" and "I put nine rounds THERE". It is the surface's
     * own colour taken down to a fifth, so a bullet hole in sandstone is a
     * brown bruise and one in ice is a blue one — never a generic black dot. */
    this.decal(
      x, y, z, nx, ny, nz,
      0.20 + 0.10 * intensity,
      packRgb(r * 0.22, g * 0.20, b * 0.19),
      0.62,
      DECAL_LIFE_S,
      true,
    );

    if (owns) {
      this.addLight(
        x + nx * 0.2, y + ny * 0.2, z + nz * 0.2,
        sr * 0.55 + 0.45, sg * 0.55 + 0.45, sb * 0.55 + 0.45,
        3.4, 1.0 * intensity, IMPACT_LIGHT_S, IMPACT_LIGHT_HOLD,
      );
    }
  }

  /**
   * True when this impact should own a point light. False for the second and
   * later pellets of a single blast landing in the same place.
   */
  private claimImpactLight(x: number, y: number, z: number): boolean {
    if (this.lastImpactLightT >= 0 && this.time - this.lastImpactLightT < IMPACT_LIGHT_MERGE_S) {
      const dx = x - this.lastImpactX;
      const dy = y - this.lastImpactY;
      const dz = z - this.lastImpactZ;
      if (dx * dx + dy * dy + dz * dz < IMPACT_LIGHT_MERGE_M2) return false;
    }
    this.lastImpactLightT = this.time;
    this.lastImpactX = x; this.lastImpactY = y; this.lastImpactZ = z;
    return true;
  }

  /**
   * A TOOL BIT THE WALL — the frame where contact becomes visible.
   *
   * This is the effect the whole piece was losing on. A swing that removes a
   * block one tick later, with nothing at the point of contact in between, is
   * indistinguishable from a swing at nothing: the frames are byte-for-byte
   * identical at the aim point and the only evidence is debris that appears
   * after the block is already gone. Four layers fix that, and all four are
   * anchored at the CONTACT POINT on the struck face, not at the tool and not
   * at the block centre:
   *
   *  1. a 70 ms bright core — the sharp cue, one to four frames, the thing that
   *     reads as "now";
   *  2. a dust plume in the block's own albedo, lifted off the face along its
   *     normal and living ~0.35 s, because dust that vanishes with the flash
   *     was never dust;
   *  3. grit in the SHADED face colours, so the specks are visibly chips of
   *     that wall;
   *  4. a real point light, 70 ms, tinted by the material, which re-lights the
   *     surrounding wall for the duration — the difference between a sprite
   *     drawn over the wall and a strike that happened ON it.
   *
   * And then the crack advances, so the face is permanently further gone than
   * it was before the swing.
   *
   * `power` 0..1 is how much of the block this strike took. A rifle round is
   * ~0.12, a pick swing ~0.3, the last swing before the block goes is ~1.
   */
  blockStrike(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    blockId: number, power = 0.3,
  ): void {
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-4) return;
    const ux = nx / nl, uy = ny / nl, uz = nz / nl;
    const p = clamp(power, 0.05, 1);

    const face = faceFromNormal(ux, uy, uz);
    const bx = Math.floor(x - ux * 0.5);
    const by = Math.floor(y - uy * 0.5);
    const bz = Math.floor(z - uz * 0.5);

    // The face as the mesher draws it: this is the colour the player is looking
    // at, so the dust and the grit come off it matching.
    const shaded = blockFaceShaded(blockId, face);
    const fr = ((shaded >>> 16) & 0xff) / 255;
    const fg = ((shaded >>> 8) & 0xff) / 255;
    const fb = (shaded & 0xff) / 255;

    const mpp = this.metresPerPixel(x, y, z);

    /* 1 — the 70 ms core. Nearly white, small, and gone almost immediately. */
    this.spawnSpark(
      x + ux * 0.03, y + uy * 0.03, z + uz * 0.03,
      ux * 0.4, uy * 0.4, uz * 0.4,
      0.07,
      this.floorPx(mpp, 0.09 + 0.06 * p, 10, 6), this.floorPx(mpp, 0.02, 2, 6),
      fr * 0.35 + 0.65, fg * 0.35 + 0.63, fb * 0.35 + 0.58, 0.95, 0.85, 4, 0,
    );

    /* 2 — the dust plume, in the material's own colour, lifted off the face.
     *
     * Deliberately small and dim. It is ADDITIVE, so it brightens whatever it
     * covers, and a half-metre additive cloud off one saw tooth does not read
     * as dust — it reads as smoke, or as a bloom bug. Twenty centimetres of it
     * at a third alpha is the amount that says "grinding" and still lets the
     * cracked face underneath be seen, which is the point. */
    const puffs = p > 0.5 ? 3 : 2;
    for (let i = 0; i < puffs; i++) {
      const jx = (Math.random() - 0.5) * 0.24;
      const jy = (Math.random() - 0.5) * 0.24;
      const jz = (Math.random() - 0.5) * 0.24;
      this.spawnSpark(
        x + ux * 0.05 + jx, y + uy * 0.05 + jy, z + uz * 0.05 + jz,
        ux * (0.7 + Math.random() * 1.1) + jx * 2,
        uy * (0.7 + Math.random() * 1.1) + jy * 2 + 0.45,
        uz * (0.7 + Math.random() * 1.1) + jz * 2,
        0.24 + Math.random() * 0.14,
        this.floorPx(mpp, 0.07 + 0.05 * p, 6, 5), this.floorPx(mpp, 0.19 + 0.13 * p, 13, 6),
        fr * 1.15 + 0.07, fg * 1.15 + 0.07, fb * 1.15 + 0.07,
        0.38, 0.0, 2.4, 1.1,
      );
    }

    /* 3 — grit, in the shaded colours of the faces it came off. */
    const grit = 3 + Math.round(3 * p);
    const gritSize = this.floorPx(mpp, 0.045 + 0.02 * p, 2.2, 5);
    for (let i = 0; i < grit; i++) {
      const c = blockFaceShaded(blockId, i % 3 === 0 ? Face.PY : face);
      const cr = ((c >>> 16) & 0xff) / 255;
      const cg = ((c >>> 8) & 0xff) / 255;
      const cb = (c & 0xff) / 255;
      const sp = 2.2 + Math.random() * 3.6;
      this.spawnDebris(
        x + ux * 0.04, y + uy * 0.04, z + uz * 0.04,
        (ux + (Math.random() - 0.5) * 1.5) * sp,
        (uy + (Math.random() - 0.5) * 1.5) * sp + 1.6,
        (uz + (Math.random() - 0.5) * 1.5) * sp,
        0.30 + Math.random() * 0.32,
        gritSize, gritSize * 0.4,
        cr, cg, cb, 1, 0, 20, 1,
      );
    }

    /* 4 — the light. Seventy milliseconds, held for a third of it. */
    this.addLight(
      x + ux * 0.22, y + uy * 0.22, z + uz * 0.22,
      fr * 0.45 + 0.55, fg * 0.45 + 0.52, fb * 0.45 + 0.46,
      2.9, 0.85 + 0.7 * p, 0.070, 0.34,
    );

    /* 5 — the wall is now visibly further gone than it was. */
    this.crack(bx, by, bz, face, blockId, 0.16 + 0.40 * p);

    this.addTrauma(0.05 + 0.10 * p, 0.045 + 0.05 * p);
  }

  /**
   * A block just broke: throw chips of it, in the colours of its own faces.
   *
   * The tint is `blockFaceShaded`, not the raw albedo, and that is the whole
   * point. The mesher paints the top face at full brightness and the sides at
   * 0.78 / 0.66, so debris carrying the raw albedo is uniformly brighter than
   * any face of the wall it supposedly came from and reads as foreign geometry
   * rather than as that wall coming apart. Spreading the chips across the six
   * face colours in world proportions — one top for every two sides — puts a
   * mix of exactly the greys already on screen into the air.
   *
   * `hx/hy/hz` and the normal are optional: pass the contact point and the
   * struck face and the puff and the light land THERE, which is where the
   * player is looking. Without them the burst is centred on the block, which is
   * what a rocket or a remote break wants.
   */
  blockBreak(
    bx: number, by: number, bz: number, blockId: number,
    hx?: number, hy?: number, hz?: number,
    nx = 0, ny = 1, nz = 0,
  ): void {
    const cx = bx + 0.5, cy = by + 0.5, cz = bz + 0.5;
    const px = hx === undefined ? cx : hx;
    const py = hy === undefined ? cy : hy;
    const pz = hz === undefined ? cz : hz;

    const n = 14;
    for (let i = 0; i < n; i++) {
      // PY : PX/NX : PZ/NZ in 1 : 2 : 2, i.e. roughly what you see of a cube.
      const m = i % 5;
      const face = m === 0 ? Face.PY : m <= 2 ? Face.PX : Face.PZ;
      const c = blockFaceShaded(blockId, face);
      const r = ((c >>> 16) & 0xff) / 255;
      const g = ((c >>> 8) & 0xff) / 255;
      const b = (c & 0xff) / 255;
      // A narrow spread only: the chips must stay recognisably the same
      // material, and +/- 12 % is the width of real facet-to-facet variation.
      const shade = 0.90 + Math.random() * 0.24;
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

    /* The block leaving is itself an impact, and it gets the same treatment as
     * the swings that led to it: a puff of its own dust and a short light, at
     * the face that was being worked. Without this the last swing is the only
     * one in the sequence with nothing at the contact point. */
    const top = blockFaceShaded(blockId, Face.PY);
    const tr = ((top >>> 16) & 0xff) / 255;
    const tg = ((top >>> 8) & 0xff) / 255;
    const tb = (top & 0xff) / 255;
    const mpp = this.metresPerPixel(px, py, pz);
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * TAU;
      const sp = 0.8 + Math.random() * 1.9;
      this.spawnSpark(
        cx + (Math.random() - 0.5) * 0.7,
        cy + (Math.random() - 0.5) * 0.7,
        cz + (Math.random() - 0.5) * 0.7,
        Math.cos(a) * sp, 0.7 + Math.random() * 1.5, Math.sin(a) * sp,
        0.32 + Math.random() * 0.18,
        this.floorPx(mpp, 0.14, 8, 6), this.floorPx(mpp, 0.42, 16, 7),
        tr * 1.15 + 0.08, tg * 1.15 + 0.08, tb * 1.15 + 0.08,
        0.34, 0.0, 2.0, 0.9,
      );
    }
    this.addLight(
      px + nx * 0.25, py + ny * 0.25, pz + nz * 0.25,
      tr * 0.4 + 0.6, tg * 0.4 + 0.58, tb * 0.4 + 0.52,
      3.4, 1.5, 0.085, 0.36,
    );

    // The face is gone; so is everything that was drawn on it.
    this.clearCracks(bx, by, bz);
  }

  /**
   * Hit a body.
   *
   * This is the single most important effect in the game, because it is the
   * only thing that separates "I fired" from "I connected", and the bar has
   * nothing here at all. It gets a bright hot puff so the hit is visible even
   * against a dark demon at 30 m, then the dark spray behind it so the READ is
   * blood and not a spark. Both are sized with a pixel floor.
   */
  blood(x: number, y: number, z: number, dx: number, dy: number, dz: number, amount = 1): void {
    const mpp = this.metresPerPixel(x, y, z);

    // The visible confirmation: one bright puff, hot pink-white at the core.
    this.spawnSpark(
      x + dx * 0.05, y + dy * 0.05, z + dz * 0.05,
      dx * 1.2, dy * 1.2 + 0.6, dz * 1.2,
      0.085 + 0.03 * amount,
      this.floorPx(mpp, 0.10 * amount, 8, 6), this.floorPx(mpp, 0.03, 2, 6),
      1, 0.42, 0.36, 1, 0.85, 5, 0,
    );

    const n = Math.round(8 * amount);
    const drop = this.floorPx(mpp, 0.075, 1.8, 5);
    for (let i = 0; i < n; i++) {
      const sp = 2.5 + Math.random() * 6;
      this.spawnDebris(
        x, y, z,
        (dx + (Math.random() - 0.5) * 1.2) * sp,
        (dy + (Math.random() - 0.5) * 1.2) * sp + 1.5,
        (dz + (Math.random() - 0.5) * 1.2) * sp,
        0.32 + Math.random() * 0.4,
        drop, drop * 0.27,
        0.42 + Math.random() * 0.18, 0.03, 0.03, 1, 0.35, 18, 1,
      );
    }
    for (let i = 0; i < 3; i++) {
      this.spawnSpark(
        x, y, z,
        dx * 2, dy * 2 + 1, dz * 2,
        0.18, this.floorPx(mpp, 0.28, 4, 3), 0.55,
        0.55, 0.05, 0.05, 0.55, 0, 3, 0,
      );
    }
  }

  /**
   * The shot connected — called ONCE per shot, after every pellet is resolved,
   * so it is the only place that knows whether the shot was fatal.
   *
   * Answering "which shot feels like it hit something?" needs three distinct
   * readings, not one: a graze, a solid hit, and a kill. Damage drives a
   * continuous strength, a headshot recolours the pop gold, and a kill adds a
   * white flash, a spray of gibs and a light — an event that is obviously not
   * the same event as a hit.
   */
  hitConfirm(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    damage: number, headshot: boolean, killed: boolean,
  ): void {
    const s = clamp(damage / 90, 0.22, 1);
    const mpp = this.metresPerPixel(x, y, z);

    // The pop: white for a hit, gold for a headshot, and blown out on a kill.
    const cr = 1;
    const cg = killed ? 0.86 : headshot ? 0.80 : 0.94;
    const cb = killed ? 0.72 : headshot ? 0.30 : 0.90;

    /* THE BODY FLASH.
     *
     * A sprite at the hit point is a mark ON the target; this is the target
     * itself going bright for two frames. It is the strongest hit read there
     * is and it is the one thing the sprite layer cannot fake, because a
     * sprite is flat and small and this engulfs the whole silhouette — at 40 m
     * a 2-pixel spark is noise and a demon-sized bubble of light is not.
     *
     * Sized off the target rather than off the damage so a graze and a
     * point-blank slug light the SAME body; strength goes into brightness and
     * duration instead, which is what separates the three readings. */
    this.flash(
      x, y, z,
      killed ? 1.35 : 0.62 + 0.30 * s,
      cr, cg, cb,
      killed ? 0.26 : 0.085 + 0.045 * s,
      killed ? 1.6 : 0.55 + 0.55 * s,
    );

    this.spawnSpark(
      x + nx * 0.05, y + ny * 0.05, z + nz * 0.05,
      nx * 0.4, ny * 0.4 + 0.3, nz * 0.4,
      killed ? 0.16 : 0.085,
      this.floorPx(mpp, (killed ? 0.34 : 0.13) * (0.55 + 0.45 * s), killed ? 20 : 11, 6),
      this.floorPx(mpp, 0.02, 2, 6),
      cr, cg, cb, 1, 1, killed ? 3 : 6, 0,
    );

    if (!killed) {
      /* THE CONNECT LIGHT.
       *
       * A round into a WALL lit the room — `impact()` has published a point
       * light since the file was written — and a round into a DEMON did not,
       * because only a kill lit anything. So the strongest environmental cue in
       * the game was firing for the shot that missed the target and staying
       * dark for the shot that hit it, which is precisely backwards for the one
       * question this piece is judged on.
       *
       * It is short and small: a body is not a muzzle and this must not turn a
       * chaingun burst into a strobe. At 11.6 rounds a second and 80 ms of life
       * roughly one is alive at a time, and the twelve-slot ranking drops it
       * first when a rocket needs the room.
       */
      this.addLight(
        x + nx * 0.15, y + ny * 0.15 + 0.15, z + nz * 0.15,
        cr * 0.45 + 0.55, cg * 0.45 + 0.55, cb * 0.45 + 0.55,
        2.2 + 1.4 * s, 0.55 + 0.75 * s, 0.08, 0.35,
      );
      // A solid hit throws a couple of extra hot flecks; a graze does not.
      const n = s > 0.5 ? 3 : 1;
      for (let i = 0; i < n; i++) {
        this.spawnSpark(
          x, y, z,
          (Math.random() - 0.5) * 5 + nx * 3,
          Math.random() * 3 + 1.2,
          (Math.random() - 0.5) * 5 + nz * 3,
          0.16 + Math.random() * 0.12,
          this.floorPx(mpp, 0.045, 2.2, 6), 0.006,
          1, 0.76, 0.55, 1, 0.7, 7, 12,
        );
      }
      return;
    }

    /* --- the kill --------------------------------------------------------- */
    const gib = this.floorPx(mpp, 0.11, 3, 5);
    for (let i = 0; i < 12; i++) {
      const th = Math.random() * TAU;
      const ph = Math.acos(2 * Math.random() - 1);
      const sp = 3.5 + Math.random() * 6.5;
      this.spawnDebris(
        x, y, z,
        Math.sin(ph) * Math.cos(th) * sp,
        Math.cos(ph) * sp + 2.6,
        Math.sin(ph) * Math.sin(th) * sp,
        0.55 + Math.random() * 0.45,
        gib, gib * 0.4,
        0.46 + Math.random() * 0.2, 0.05, 0.05, 1, 0.2, 16, 1,
      );
    }
    for (let i = 0; i < 6; i++) {
      this.spawnSpark(
        x, y, z,
        (Math.random() - 0.5) * 9, Math.random() * 5 + 1.5, (Math.random() - 0.5) * 9,
        0.20 + Math.random() * 0.2,
        this.floorPx(mpp, 0.06, 2.6, 6), 0.01,
        1, 0.55, 0.35, 1, 0.8, 5, 11,
      );
    }
    this.addLight(x + nx * 0.3, y + ny * 0.3 + 0.3, z + nz * 0.3, 1, 0.62, 0.45, 5.5, 1.5, 0.22);
    this.addTrauma(0.26);
  }

  /**
   * A body-sized bubble of light, with no shockwave and almost no growth.
   *
   * Shares the blast pool because it is the same draw call and the same
   * geometry; the growth envelope is what makes one read as a detonation and
   * the other as a target lighting up.
   */
  flash(
    x: number, y: number, z: number, radius: number,
    r: number, g: number, b: number, seconds: number, gain: number,
  ): void {
    if (this.blastCount >= this.blastCap || radius <= 0 || seconds <= 0) return;
    const i = this.blastCount++;
    this.blPos[i * 3] = x; this.blPos[i * 3 + 1] = y; this.blPos[i * 3 + 2] = z;
    this.blRadius[i] = radius;
    this.blLife[i] = 0;
    this.blMax[i] = seconds;
    this.blColor[i * 3] = r; this.blColor[i * 3 + 1] = g; this.blColor[i * 3 + 2] = b;
    this.blGrow0[i] = 0.85;
    this.blGrowSpan[i] = 0.55;
    this.blRingW[i] = 0;
    this.blGain[i] = gain;
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
      this.blGrow0[i] = 0.22;
      this.blGrowSpan[i] = 0.95;
      this.blRingW[i] = 1;
      this.blGain[i] = 1.15;
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

  /**
   * Detonate using the weapon table's own splash radius and projectile colour.
   *
   * The convenience matters: the client learns a rocket died by watching it
   * vanish out of a snapshot, at which point all it has is a weapon id, and
   * every caller that has to look up splashRadius itself is a caller that can
   * get it wrong. `up` is the surface normal to lay the scorch against, which
   * is +Y for an air burst and the wall normal for one that hit a wall.
   */
  explosionFor(
    weaponId: number, x: number, y: number, z: number,
    upX = 0, upY = 1, upZ = 0,
  ): void {
    const def = getWeapon(weaponId);
    const radius = def.splashRadius > 0 ? def.splashRadius : 1.2;
    this.explosion(x, y, z, radius, def.projectileColor);
    // The crater's own mark. Sized off the splash radius rather than the
    // terrain damage so a plasma bolt that carves nothing still says where it
    // went off.
    this.decal(
      x, y, z, upX, upY, upZ,
      radius * 1.15, 0x0e0b09, 0.72, DECAL_LIFE_S * 1.5,
    );
  }

  /**
   * One frame of a projectile in flight: an ember or two off the tail and, for
   * anything with `projectileLight`, a real point light that travels with it.
   *
   * The bar has no projectiles at all, so this is uncontested — but the reason
   * it is here is the hit read, not the flight. A rocket you can watch cross
   * the room is a rocket whose detonation you were WAITING for, and an event
   * you were waiting for lands harder than one that merely happened.
   */
  projectileTrail(
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    weaponId: number, dt: number,
  ): void {
    const def = getWeapon(weaponId);
    const col = def.projectileColor;
    const r = ((col >>> 16) & 0xff) / 255;
    const g = ((col >>> 8) & 0xff) / 255;
    const b = (col & 0xff) / 255;

    if (def.projectileLight > 0) {
      // Refreshed every frame with a life just over one frame at 30 fps, so the
      // light follows the round instead of smearing a trail of stale lights.
      this.addLight(x, y, z, r, g, b, def.projectileLight, 1.0, 0.05);
    }

    // Rate-limited by dt rather than spawned per frame: at 144 fps a per-frame
    // ember is a solid rope, at 30 fps it is a dotted line, and neither is the
    // same effect.
    if (Math.random() > dt * 90) return;
    const back = 0.28;
    this.spawnSpark(
      x - dx * back, y - dy * back, z - dz * back,
      -dx * 1.6 + (Math.random() - 0.5) * 1.2,
      -dy * 1.6 + (Math.random() - 0.5) * 1.2 + 0.5,
      -dz * 1.6 + (Math.random() - 0.5) * 1.2,
      0.18 + Math.random() * 0.16,
      0.10, 0.02,
      r, g, b, 0.9, 0.6, 5, 0,
    );
    if (def.splashRadius > 0 && Math.random() < 0.5) {
      // Smoke, only for the things that leave a trail you should be able to
      // follow back to the shooter.
      this.spawnDebris(
        x - dx * back, y - dy * back, z - dz * back,
        (Math.random() - 0.5) * 0.6, 0.5 + Math.random() * 0.5, (Math.random() - 0.5) * 0.6,
        0.55 + Math.random() * 0.35,
        0.14, 0.42,
        0.22, 0.20, 0.19, 0.5, 0, 0.6, 0,
      );
    }
  }

  /* -- shake ------------------------------------------------------------- */

  /**
   * `amplitude` is metres of camera displacement at full trauma, `ms` how long
   * the trauma takes to bleed off, `hz` the wobble rate.
   */
  addShake(amplitude: number, ms: number, hz: number): void {
    // The constant that used to sit here (`+ 0.5 + amplitude * 0.55`) meant a
    // pistol tick and a BFG both jumped straight to at least half trauma, and
    // since the visible shake goes as trauma SQUARED that is a quarter of full
    // violence for every shot in the game. Trauma has to be the thing that
    // separates a tap from a barrage, so it is now driven by the amplitude it
    // was handed, with only a small floor so the very lightest sources still
    // register as something.
    this.addTrauma(TRAUMA_SHAKE_FLOOR + amplitude * TRAUMA_PER_AMPLITUDE);
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

  /**
   * Bank trauma from something that is not a weapon — a kill, a nearby blast,
   * taking a hit.
   *
   * The amplitude floor is not decoration. `applyShake` multiplies trauma by
   * `shakeAmp`, and `shakeAmp` is only ever raised by `addShake`, so trauma
   * banked on its own against a rested camera was multiplied by zero and moved
   * nothing at all — `hitConfirm`'s kill trauma was, measurably, a no-op. A
   * trauma source with no amplitude of its own now asserts a small one.
   */
  addTrauma(v: number, amplitude: number = TRAUMA_BARE_AMPLITUDE): void {
    if (v <= 0) return;
    this.trauma = clamp(this.trauma + v, 0, 1);
    if (amplitude > this.shakeAmp) this.shakeAmp = amplitude;
    if (this.shakeDecay <= 0) this.shakeDecay = 1000 / 200;
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
    /* The angular shake is composed as a LOCAL quaternion rotation, not by
     * adding to `camera.rotation`.
     *
     * `PlayerCamera.applyTo` writes the view as a quaternion built in YXZ
     * order. Reading `.rotation` back off that gives three-js's default XYZ
     * decomposition of the same orientation, and adding a roll to the Z term
     * of an XYZ euler and recomposing does not produce "the same view plus a
     * roll" — it produces a different orientation whose error grows with
     * pitch, so shaking while looking up or down yawed the view as well.
     * Post-multiplying is order-agnostic and is the shake the player expects:
     * a rotation about the camera's own axes. */
    const rk = s * Math.min(this.shakeAmp, 0.9);
    _shakeEuler.set(wobble(t, 4) * rk * 0.055, wobble(t, 5) * rk * 0.055, wobble(t, 3) * rk * 0.115);
    _shakeQuat.setFromEuler(_shakeEuler);
    camera.quaternion.multiply(_shakeQuat);
    camera.updateMatrixWorld(true);
  }

  /* -- lights ------------------------------------------------------------ */

  /**
   * A transient point light. Only the strongest few reach the shader.
   *
   * `hold` is the fraction of the light's life spent at FULL intensity before
   * the quadratic fade begins, and it is the difference between a muzzle flash
   * that lights the room and one nobody ever sees. A pistol flash lives 45 ms —
   * under three frames at 60 Hz — and with a fade that starts at t=0 the very
   * first frame that can possibly display it already shows it at (1 - 16.7/45)²
   * = 0.42 of its intensity, the second at 0.13, the third at nothing. The
   * light was in the scene for the arithmetic and absent from the picture. A
   * hold of 0.45 puts two full-strength frames on screen and then drops it,
   * which is what a flash actually does.
   */
  addLight(
    x: number, y: number, z: number,
    r: number, g: number, b: number,
    radius: number, intensity: number, seconds: number, hold: number = 0,
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
    this.liHold[i] = hold < 0 ? 0 : hold > 0.9 ? 0.9 : hold;
  }

  /** 0..1 brightness envelope of light slot `i`: flat over the hold, then out. */
  private lightFade(i: number): number {
    const t = this.liLife[i] / this.liMax[i];
    const h = this.liHold[i];
    if (t <= h) return 1;
    const k = 1 - (t - h) / (1 - h);
    return k < 0 ? 0 : k;
  }

  /* -- the frame --------------------------------------------------------- */

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    if (this.disposed) return;
    const step = Math.min(dt, 0.1);
    this.time += step;

    this.trauma = Math.max(0, this.trauma - this.shakeDecay * step);
    if (this.trauma <= 0) this.shakeAmp = 0;
    else this.shakeAmp *= Math.max(0, 1 - this.shakeDecay * step * 0.9);

    // Cache the camera so the SPAWNERS can size hit effects in screen space.
    // They run in the fixed step, which is one frame ahead of this at worst.
    this.camX = camera.position.x;
    this.camY = camera.position.y;
    this.camZ = camera.position.z;
    const halfFov = Math.tan((camera.fov * Math.PI) / 360);
    this.camTanHalfFov = halfFov;

    this.sparkCount = this.stepParticles(this.sp, this.sparkCount, this.sparkSet, step, false);
    this.debrisCount = this.stepParticles(this.db, this.debrisCount, this.debrisSet, step, true);
    if (this.beamMaterial !== null) {
      this.beamMaterial.uniforms.uPxScale.value =
        (2 * halfFov * this.minTracerPx) / this.viewportHeight;
      this.beamMaterial.uniformsNeedUpdate = true;
    }
    if (this.crackMaterial !== null) {
      this.crackMaterial.uniforms.uPxScale.value =
        (2 * halfFov * this.minCrackPx) / this.viewportHeight;
      this.crackMaterial.uniformsNeedUpdate = true;
    }
    this.stepTracers(step);
    this.stepBlasts(step);
    this.stepDecals(step);
    this.stepCracks(step);
    this.stepLights(step, camera);

    this.stats.sparks = this.sparkCount;
    this.stats.debris = this.debrisCount;
    this.stats.tracers = this.tracerCount;
    this.stats.blasts = this.blastCount;
    this.stats.decals = this.decalCount;
    this.stats.cracks = this.crackCount;
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
      const fade = this.trFade[i];
      let alpha: number;
      let t0: number;
      if (fade > 0) {
        // Draw the line out, hold it, then bleed it out. The tail is PINNED at
        // the barrel — it must not be derived from the head, because the head
        // runs on past the far end and a tail chasing it walks the whole beam
        // off into the distance within two frames.
        this.trAge[i] += dt;
        const over = this.trAge[i] - this.trHold[i];
        if (over >= fade) {
          n--;
          if (i !== n) this.copyTracer(n, i);
          continue;
        }
        const k = over <= 0 ? 1 : 1 - over / fade;
        alpha = k * k;
        t0 = 0;
      } else {
        if (tail >= this.trLen[i]) {
          n--;
          if (i !== n) this.copyTracer(n, i);
          continue;
        }
        alpha = clamp(1 - Math.max(0, tail) / Math.max(this.trLen[i], 1e-3), 0.15, 1);
        t0 = Math.max(0, tail);
      }
      const ox = this.trOx[i * 3], oy = this.trOx[i * 3 + 1], oz = this.trOx[i * 3 + 2];
      const dx = this.trDir[i * 3], dy = this.trDir[i * 3 + 1], dz = this.trDir[i * 3 + 2];
      A[i * 3] = ox + dx * t0; A[i * 3 + 1] = oy + dy * t0; A[i * 3 + 2] = oz + dz * t0;
      B[i * 3] = ox + dx * head; B[i * 3 + 1] = oy + dy * head; B[i * 3 + 2] = oz + dz * head;
      P[i * 4] = this.trWidth[i];
      P[i * 4 + 1] = alpha;
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
    this.trFade[to] = this.trFade[from];
    this.trHold[to] = this.trHold[from];
    this.trAge[to] = this.trAge[from];
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
      const ringW = this.blRingW[i];

      sPos[i * 3] = x; sPos[i * 3 + 1] = y; sPos[i * 3 + 2] = z;
      sPar[i * 4] = R * (this.blGrow0[i] + ease * this.blGrowSpan[i]);
      sPar[i * 4 + 1] = (1 - t) * (1 - t) * this.blGain[i];
      sCol[i * 3] = this.blColor[i * 3];
      sCol[i * 3 + 1] = this.blColor[i * 3 + 1];
      sCol[i * 3 + 2] = this.blColor[i * 3 + 2];

      // The shockwave outruns the fireball and lives a little longer. A body
      // flash has none, and the instance is collapsed to zero radius rather
      // than merely made transparent — a transparent ring still shades every
      // pixel it covers, and a chaingun would be filling the screen with them.
      const rt = Math.min(1, t * 1.35);
      rPos[i * 3] = x; rPos[i * 3 + 1] = y - R * 0.32; rPos[i * 3 + 2] = z;
      rPar[i * 4] = R * (0.4 + rt * 2.0) * ringW;
      rPar[i * 4 + 1] = (1 - rt) * 0.85 * ringW;
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
    this.blGrow0[to] = this.blGrow0[from];
    this.blGrowSpan[to] = this.blGrowSpan[from];
    this.blRingW[to] = this.blRingW[from];
    this.blGain[to] = this.blGain[from];
  }

  /**
   * Decals do not move, so the step is only a fade and a compaction. Written
   * with the same swap-with-last removal as every other pool here, which keeps
   * the live instances at the head of the buffer and lets one `instanceCount`
   * cover them.
   */
  private stepDecals(dt: number): void {
    const pos = this.decalSet.a.array as Float32Array;
    const par = this.decalSet.b.array as Float32Array;
    const col = this.decalSet.c.array as Float32Array;
    const nrm = (this.decalSet.d as THREE.InstancedBufferAttribute).array as Float32Array;

    let n = this.decalCount;
    let i = 0;
    while (i < n) {
      this.dcLife[i] += dt;
      const t = this.dcLife[i] / this.dcMax[i];
      if (t >= 1) {
        n--;
        if (i !== n) this.copyDecal(n, i);
        continue;
      }
      // Full opacity for the hold, then a square fade — linear reads as the
      // mark being wiped off, square reads as it drying out.
      const f = t <= DECAL_HOLD ? 1 : 1 - (t - DECAL_HOLD) / (1 - DECAL_HOLD);
      pos[i * 3] = this.dcPos[i * 3];
      pos[i * 3 + 1] = this.dcPos[i * 3 + 1];
      pos[i * 3 + 2] = this.dcPos[i * 3 + 2];
      nrm[i * 3] = this.dcNrm[i * 3];
      nrm[i * 3 + 1] = this.dcNrm[i * 3 + 1];
      nrm[i * 3 + 2] = this.dcNrm[i * 3 + 2];
      par[i * 4] = this.dcSize[i];
      par[i * 4 + 1] = this.dcAlpha[i] * f * f;
      par[i * 4 + 2] = this.dcRot[i];
      par[i * 4 + 3] = this.dcSeed[i];
      col[i * 3] = this.dcColor[i * 3];
      col[i * 3 + 1] = this.dcColor[i * 3 + 1];
      col[i * 3 + 2] = this.dcColor[i * 3 + 2];
      i++;
    }
    this.decalCount = n;
    this.decalSet.geometry.instanceCount = n;
    if (n > 0) {
      markRange(this.decalSet.a, n);
      markRange(this.decalSet.b, n);
      markRange(this.decalSet.c, n);
      markRange(this.decalSet.d as THREE.InstancedBufferAttribute, n);
    }
  }

  private copyDecal(from: number, to: number): void {
    for (let k = 0; k < 3; k++) {
      this.dcPos[to * 3 + k] = this.dcPos[from * 3 + k];
      this.dcNrm[to * 3 + k] = this.dcNrm[from * 3 + k];
      this.dcColor[to * 3 + k] = this.dcColor[from * 3 + k];
    }
    this.dcSize[to] = this.dcSize[from];
    this.dcRot[to] = this.dcRot[from];
    this.dcSeed[to] = this.dcSeed[from];
    this.dcAlpha[to] = this.dcAlpha[from];
    this.dcLife[to] = this.dcLife[from];
    this.dcMax[to] = this.dcMax[from];
  }

  /**
   * Cracks do not move either, so the step is a fade, a compaction and the one
   * thing decals do not do: writing the live STAGE into the instance buffer, so
   * a face that was struck again this frame is drawn further gone than it was
   * on the frame before.
   */
  private stepCracks(dt: number): void {
    const pos = this.crackSet.a.array as Float32Array;
    const par = this.crackSet.b.array as Float32Array;
    const col = this.crackSet.c.array as Float32Array;
    const nrm = (this.crackSet.d as THREE.InstancedBufferAttribute).array as Float32Array;

    /* Is the block still there?
     *
     * A crack is the only effect in this file pinned to a voxel, so it is the
     * only one that can be orphaned: a rocket, a server delta or another player
     * can delete the block out from under it, and six squares hanging in empty
     * air where a wall used to be is precisely the "rendering artefact" read
     * this overlay exists to avoid. Swept ten times a second rather than every
     * frame — 48 world lookups at 10 Hz is free, and a stale crack that lives
     * for 100 ms was never seen. */
    const collider = this.collider;
    this.crackSweep += dt;
    const sweep = collider !== null && this.crackSweep >= CRACK_SWEEP_S;
    if (sweep) this.crackSweep = 0;

    let n = this.crackCount;
    let i = 0;
    while (i < n) {
      this.ckLife[i] += dt;
      const t = this.ckLife[i] / CRACK_LIFE_S;
      const orphaned = sweep && collider !== null
        && !collider(this.ckBx[i], this.ckBy[i], this.ckBz[i]);
      if (t >= 1 || orphaned) {
        n--;
        if (i !== n) this.copyCrack(n, i);
        continue;
      }
      const f = this.ckFace[i];
      const nx = FACE_NORMALS[f * 3];
      const ny = FACE_NORMALS[f * 3 + 1];
      const nz = FACE_NORMALS[f * 3 + 2];
      const lift = 0.5 + CRACK_STANDOFF;
      pos[i * 3] = this.ckBx[i] + 0.5 + nx * lift;
      pos[i * 3 + 1] = this.ckBy[i] + 0.5 + ny * lift;
      pos[i * 3 + 2] = this.ckBz[i] + 0.5 + nz * lift;
      nrm[i * 3] = nx; nrm[i * 3 + 1] = ny; nrm[i * 3 + 2] = nz;
      const fade = t <= CRACK_HOLD ? 1 : 1 - (t - CRACK_HOLD) / (1 - CRACK_HOLD);
      par[i * 4] = CRACK_SIZE;
      par[i * 4 + 1] = fade * fade;
      par[i * 4 + 2] = this.ckStage[i];
      par[i * 4 + 3] = this.ckSeed[i];
      col[i * 3] = this.ckColor[i * 3];
      col[i * 3 + 1] = this.ckColor[i * 3 + 1];
      col[i * 3 + 2] = this.ckColor[i * 3 + 2];
      i++;
    }
    this.crackCount = n;
    this.crackSet.geometry.instanceCount = n;
    this.crackSet.mesh.visible = n > 0;
    if (n > 0) {
      markRange(this.crackSet.a, n);
      markRange(this.crackSet.b, n);
      markRange(this.crackSet.c, n);
      markRange(this.crackSet.d as THREE.InstancedBufferAttribute, n);
    }
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
          this.liHold[i] = this.liHold[n];
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
      const fade = this.lightFade(j);
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
    const fade = this.lightFade(i);
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
    this.lastImpactLightT = -1;
    this.sparkCount = 0;
    this.debrisCount = 0;
    this.tracerCount = 0;
    this.blastCount = 0;
    this.decalCount = 0;
    this.crackCount = 0;
    this.lightCount = 0;
    this.trauma = 0;
    this.shakeAmp = 0;
    this.sparkSet.geometry.instanceCount = 0;
    this.debrisSet.geometry.instanceCount = 0;
    this.tracerSet.geometry.instanceCount = 0;
    this.shellSet.geometry.instanceCount = 0;
    this.ringSet.geometry.instanceCount = 0;
    this.decalSet.geometry.instanceCount = 0;
    this.crackSet.geometry.instanceCount = 0;
    this.crackSet.mesh.visible = false;
    if (this.materials !== null) {
      this.materials.beginLights();
      this.materials.endLights();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const set of [
      this.sparkSet, this.debrisSet, this.tracerSet,
      this.shellSet, this.ringSet, this.decalSet, this.crackSet,
    ]) {
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
const _shakeQuat = new THREE.Quaternion();
const _shakeEuler = new THREE.Euler(0, 0, 0, 'YXZ');

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

/** Fold three 0..1 channels back into the packed 0xRRGGBB the spawners take. */
function packRgb(r: number, g: number, b: number): number {
  const cr = Math.round(clamp(r, 0, 1) * 255);
  const cg = Math.round(clamp(g, 0, 1) * 255);
  const cb = Math.round(clamp(b, 0, 1) * 255);
  return (cr << 16) | (cg << 8) | cb;
}
