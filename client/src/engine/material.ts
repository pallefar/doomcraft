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
 *    strength is a uniform, not a shader edit. The ramp is SUPER-LINEAR — see
 *    `AO_FALLOFF` — because a linear one put the commonest case at a dip nobody
 *    could see and AO is the whole point.
 *  - **Sky exposure and coloured block light**, both baked per face by the
 *    mesher (see its header). Sky is what makes a roofed room read as indoors:
 *    the sun term is nearly gone under a roof and the ambient term is cut, so
 *    walking through a doorway is a change of key and not just of geometry.
 *    Block light is coloured by hue class, so a lava pit turns its room orange
 *    instead of merely turning it up.
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
 *
 * SURFACE DETAIL (ref/BAR.md weakness: "blocks **are textured**, not
 * flat-coloured"). The bar's stone is a running bond, its sand a chevron dither,
 * and every merged run of blocks still has a countable grid. Ours was one
 * unbroken field of colour, and ground plus walls are ~70% of every frame.
 *
 * SIDE-FACE SEPARATION, MEASURED — do not re-litigate this from a screenshot.
 * A round-2 critic asked for side faces at "0.72 / 0.55 of the top face, so the
 * terraces read as steps you can mount instead of a texture". Sampled off the
 * actual frames with 11x11 patches, in Rec.709 luma:
 *
 *   BAR sand top 229.7 / side 224.2   ->  0.98   (no side shading at all)
 *   BAR grass top 152.2 / side 128.4  ->  0.84
 *   OURS mass top 59.6  / side 30.7   ->  0.52
 *   OURS mass top 56.1  / side 33.6   ->  0.60
 *
 * So the ask describes the BAR's beach, and this ramp already sits past it on
 * both numbers. `FACE_SHADE` is [0.78, 0.78, 1.0, 0.5, 0.66, 0.66] and the sun
 * azimuth term below drives the rendered ratio lower still, because -X and -Z
 * get ambient only. Deepening it further would only crush the dark end.
 *
 * The fix is entirely fragment-side, which matters because `game.medianMs`
 * tracks CPU and the real budget is draw calls (~120 before the frame cost
 * moves). This adds ZERO draw calls and ZERO vertex bytes:
 *
 *  - **UV is derived from `vWorldPos` and `vNormal`**, both already varyings.
 *    +/-Y takes `worldPos.xz`, +/-X takes `worldPos.zy`, +/-Z takes
 *    `worldPos.xy`, so it tiles per block across a greedy quad of any size.
 *  - **The tile comes from `aColor`**, which the mesher already writes as the
 *    unshaded `BLOCK_FACE_COLOR` — a unique key per block-face. One
 *    `texelFetch` in the VERTEX stage turns it into {tile, detail, seam} and
 *    flats it down, so the fragment stage pays one atlas fetch and no lookup.
 *  - **The seam** is a `fract()` edge-distance darken in pixel space, which is
 *    what gives three adjacent stone blocks their grid back without splitting a
 *    single quad. It fades out below ~9 px per block so distance never moires.
 *
 * The atlas never replaces the palette: the baked face shade in the vertex
 * colour, AO, fog and the dynamic lights all still apply on top.
 *
 * WHY THE DETAIL TERM IS TWO TERMS. The first version modulated albedo purely
 * MULTIPLICATIVELY — `base *= 1 + m * amp`. Measured, its Weber contrast was
 * competitive with the bar (1.6-4.7% against 1.6-2.9%) and it was still
 * invisible on half the palette, because a percentage of a dark albedo is not
 * a quantity the framebuffer can hold: on a wall sitting at luminance 30 the
 * entire modulation landed under one 8-bit grey level. High-pass 3x3 residual
 * RMS on matched flat patches, in absolute levels:
 *
 *     BAR sand mid-near 3.32   BAR grass top 4.39      <- the target band
 *     DM stone wall, nose      0.66 -> 2.72
 *     builder red wall         0.88 -> 3.39
 *     quest brick              1.27 -> 2.57
 *     quest tile floor         0.98 -> 2.56
 *
 * The fix is an ADDITIVE term beside the multiplicative one, in linear albedo
 * units, so what the detail is worth in grey levels no longer depends on how
 * dark the material is — plus denser tiles (textureAtlas.ts) and a per-block
 * position hash, because a merged forty-block wall repeating one tile reads as
 * one painted mass however good the tile is. Re-measure with
 * `node tools/surface-probe.mjs`.
 *
 * None of it is free but all of it is close to it. Measured on ANGLE/Metal with
 * EXT_disjoint_timer_query_webgl2, a pinned camera and a scissor sweep over
 * pixel count, per-pixel fragment cost sits at 0.117-0.140 ms/Mpx where the old
 * atlas sat at 0.127-0.146, against a 0.024 ms/Mpx flat-shader floor: no
 * measurable increase, and the run-to-run spread is larger than the change.
 * `game.medianMs` cannot see any of this either way — it times CPU submission
 * inside `renderer.render()` and is structurally blind to a fragment-shader
 * change, which is why it must never be used to gate one.
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
import {
  ATLAS_COLS,
  ATLAS_ROWS,
  createAtlasTexture,
  createSurfaceLutTexture,
} from './textureAtlas';
import { LIGHT_HUE_COUNT, LIGHT_MAX } from './mesher';

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

/**
 * Where fog is allowed to start, as a fraction of the distance at which it is
 * closed. Everything nearer than this is rendered with no fog at all.
 *
 * Fog measured from the eye is the reason distant surfaces read as flat: exp2
 * fog to 188 m had already mixed 9% of the fog colour into a wall at 30 m and
 * 33% into one at 60 m, and 33% of the contrast is most of what a 1-3 grey
 * level surface residual has to give. Holding the first ~28% of the range
 * completely clear costs the horizon nothing — the ramp is simply steeper over
 * the remaining 72% — and buys back the entire near and mid field.
 */
const FOG_START_FRAC = 0.28;

/* ------------------------------------------------------------------------ *
 * Ambient occlusion ramp
 *
 * `aoStrength` is a slider in 0..1, and the four baked AO levels are
 * `1 - strength * AO_FALLOFF[level]`. The falloff is deliberately super-linear
 * at the top: with the old evenly-spaced ramp, level 2 — a floor tile with one
 * wall beside it, by far the commonest occluded case in a voxel world — came
 * out as a 12-14% dip at the strength the game actually ships (0.36), which is
 * about one JND on a dark Doom palette. Measured off shots/ours-deathmatch-08:
 * a pillar met the floor with no readable contact darkening at all, i.e. we had
 * AO in the maths and none on the screen, which is exactly the bar's failure.
 *
 * At the shipped 0.36 the ramp is now [0.478, 0.658, 0.838, 1.0]: a 16% step at
 * the single-wall case, a 34% step at the double, and a 52% well in the corner.
 * ------------------------------------------------------------------------ */
const AO_FALLOFF = [1.45, 0.95, 0.45, 0];
/** Nothing goes fully black on AO alone; the darkest corner keeps this much. */
const AO_FLOOR = 0.06;

/* ------------------------------------------------------------------------ *
 * Interior light
 *
 * How much of the outdoor light survives under a roof, per component. The
 * mesher's sky channel interpolates between these and 1.0.
 *
 * The sun is nearly gone indoors because there is no sun indoors; the ambient
 * is only trimmed because a voxel room with no ambient is a black rectangle and
 * Doom's rooms were never unlit — they were a different, flatter key with their
 * own light sources in them. Net effect on a top face: ~36% darker inside than
 * out. On a side wall: ~20%. That asymmetry is deliberate — it is what makes an
 * interior read as flat and enclosed rather than merely dim.
 * ------------------------------------------------------------------------ */
const INTERIOR_AMBIENT = 0.80;
const INTERIOR_SUN = 0.35;

/* ------------------------------------------------------------------------ *
 * Block-light colours, indexed by the mesher's hue class.
 *
 * The point of colouring them at all: a grey wall beside lava that merely gets
 * BRIGHTER reads as a lighting bug. A grey wall beside lava that goes orange
 * reads as a room with a fire in it. Same instruction count.
 * ------------------------------------------------------------------------ */
/**
 * Exponent on the baked light level before it becomes light.
 *
 * Not a taste knob. The palette gives HELLSTONE emissive 5 and hellstone is the
 * surface stratum of the whole HELL biome, so on a linear ramp every hell arena
 * renders as one saturated orange field with its own lava pit invisible inside
 * it — the bar's "reads as one mass" failure, in a hotter key. A gamma keeps the
 * strong sources strong and pushes ambient rock back down to a tint.
 */
const EMISSIVE_GAMMA = 1.9;
/**
 * How much an already-lit surface ignores block light. A torch outdoors is worth
 * almost nothing and indoors is worth everything, which is both what happens and
 * the reason building interiors pays.
 */
const EMISSIVE_DAMP = 0.72;

const LIGHT_HUE_RGB: readonly number[] = [
  0xff7a2a,   // fire   — lava, hellstone
  0x4bff9a,   // toxic  — neon, slime
  0x86b8ff,   // cold   — tech panel
];

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

/* ------------------------------------------------------------------------ *
 * Surface-detail tuning
 *
 * Four numbers, all measured rather than eyeballed, by
 * `node tools/surface-probe.mjs` — high-pass 3x3 residual RMS in absolute 8-bit
 * grey levels on matched flat patches, against the bar's own sand (3.32 levels
 * on mean luminance 205) and grass (4.39 on 152) measured with the same
 * operator off ref/voxiom.
 * ------------------------------------------------------------------------ */

/**
 * Scale on each material's authored RELATIVE detail strength (0.07 .. 0.23).
 * This is the percentage-of-albedo term. It is what bright materials live on.
 */
const DETAIL_REL = 1.0;

/**
 * Scale on the same authored strength, applied as an ABSOLUTE albedo offset.
 * A typical material (authored 0.17-0.20) therefore modulates albedo by roughly
 * +/-0.08 on top of its percentage term, which is worth ~3 grey levels after
 * lighting and the grade on a surface sitting at luminance 30-40 — inside the
 * band the bar's own surfaces occupy — and under 1% on a sand-bright one.
 */
const DETAIL_ABS = 0.46;

/** Per-block value jitter, relative. +/-4%, which is the brief's 3-5%. */
const BLOCK_JITTER_REL = 0.040;

/**
 * Per-block value jitter, absolute, in the same linear albedo units as
 * DETAIL_ABS and for the same reason: 4% of a dark block is not a grey level,
 * and a wall of identically-dark blocks is the thing this exists to break.
 */
const BLOCK_JITTER_ABS = 0.013;

/**
 * How dark the per-block groove goes. Was 0.17 when it was the only thing
 * separating one block from the next; now that the tiles and the hash both
 * carry that load it can go back to reading as a joint rather than a lattice.
 */
const SEAM_STRENGTH = 0.12;

/**
 * What each quality tier does to the surface term.
 *
 * This is half of the escape hatch the atlas shipped without: `setQuality` used
 * to change MAX_LIGHTS and nothing else, so a phone that picked "low" still
 * paid for every texture fetch. `low` still keeps a little, because a flat
 * untextured world is the failure this whole module exists to fix; a device
 * that cannot afford even that turns the atlas off outright with
 * `setTextureEnabled(false)`, which drops the define and the fetch with it.
 */
const QUALITY_DETAIL: Readonly<Record<VoxelQuality, number>> = {
  low: 0.6,
  medium: 0.85,
  high: 1.0,
};

function hexToVec3(hex: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(((hex >>> 16) & 0xff) / 255, ((hex >>> 8) & 0xff) / 255, (hex & 0xff) / 255);
}

/* ------------------------------------------------------------------------ *
 * Shaders
 * ------------------------------------------------------------------------ */

/** Width / height of one atlas tile in UV, as GLSL float literals. */
const TILE_U = (1 / ATLAS_COLS).toFixed(8);
const TILE_V = (1 / ATLAS_ROWS).toFixed(8);

const VERT = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

// Ambient (sky dome) and direct-sun shares of each face's light, kept apart so
// the sky-exposure term can attenuate them by different amounts.
uniform float uFaceAmbient[6];
uniform float uFaceSun[6];
uniform vec3  uFaceNormal[6];
uniform float uAoLevels[4];
uniform vec3  uLightHue[${LIGHT_HUE_COUNT}];
/** x = ambient share indoors, y = sun share indoors. */
uniform vec2  uInterior;
uniform float uTime;
uniform float uWaveAmp;
uniform float uWaveSpeed;
uniform float uEmissiveGain;
#ifdef USE_TEXTURE
uniform sampler2D uSurfaceLut;
#endif

in vec4 aPosFace;   // x, y, z (chunk-local integers), face 0..5
in vec4 aData;      // ao 0..3, light (level | hue<<4), alpha 0..255, flags
in vec4 aColor;     // rgb normalized, a = sky exposure normalized

out vec3  vColor;
out float vLightBase;
flat out vec3 vEmissive;
out float vAlpha;
out float vFogDepth;
out highp vec3 vWorldPos;
flat out vec3 vNormal;
flat out float vLiquid;
#ifdef USE_TEXTURE
// xy = atlas tile origin in UV, z = detail strength, w = seam strength.
flat out vec4 vSurf;
// 1 = mirror the tile per block so a big wall is not wallpaper, 0 = keep aligned.
flat out float vVary;
#endif

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

  // Sky exposure: 0 under a roof, 1 under open air. It attenuates the sun hard
  // and the ambient gently, so an interior loses its modelling before it loses
  // its visibility.
  float sky = aColor.a;
  float ambientMix = mix(uInterior.x, 1.0, sky);
  float sunMix = mix(uInterior.y, 1.0, sky);
  vLightBase = (uFaceAmbient[face] * ambientMix + uFaceSun[face] * sunMix)
             * uAoLevels[int(aData.x + 0.5)];

  // aData.y packs the block-light level in bits 0..3 and its hue class in
  // bits 4..5, so one byte carries both and the vertex format did not grow.
  float packed = aData.y;
  float hue = floor(packed / 16.0);
  float level = packed - hue * 16.0;
  // Gamma on the level, not a straight ramp. HELLSTONE emits 5 and floors the
  // entire HELL biome, so a linear response paints every square metre of a hell
  // arena the same hot orange and the lava pit in the middle of it stops being
  // brighter than the ground it sits in. See EMISSIVE_GAMMA: a level-5 ambient
  // rock is worth 12% and a level-15 lava pool is worth 100%.
  vEmissive = uLightHue[int(hue + 0.5)]
            * pow(level / ${LIGHT_MAX}.0, ${EMISSIVE_GAMMA.toFixed(2)})
            * uEmissiveGain;

  vAlpha = aData.z / 255.0;

#ifdef USE_TEXTURE
  // aColor is the mesher's UNSHADED BLOCK_FACE_COLOR, which is a unique key per
  // block face. One exact integer fetch per vertex — no hash, no new attribute.
  ivec2 key = ivec2(int(aColor.r * 255.0 + 0.5), int(aColor.g * 255.0 + 0.5));
  vec4 surf = texelFetch(uSurfaceLut, key, 0);
  float tile = floor(surf.r * 255.0 + 0.5);
  vSurf = vec4(
    mod(tile, ${ATLAS_COLS}.0) * ${TILE_U},
    floor(tile / ${ATLAS_COLS}.0) * ${TILE_V},
    surf.g,
    surf.b);
  vVary = surf.a;
#endif
}
`;

const FRAG = /* glsl */ `
precision mediump float;
precision mediump int;
precision mediump sampler2D;

uniform vec3  uFogColor;
uniform float uFogDensity;
/** Metres of completely clear air in front of the camera. See setFogRange. */
uniform float uFogStart;
uniform vec3  uTint;
uniform float uContrast;
uniform float uSaturation;
uniform float uExposure;
// Shared with the vertex stage, which runs highp: a uniform of the same name
// must carry the same precision in both or the program fails to validate.
uniform highp float uTime;
uniform float uRipple;
#ifdef USE_TEXTURE
uniform sampler2D uSurfaceAtlas;
uniform float uDetail;    // global scale on the RELATIVE (percentage) detail term
uniform float uDetailAbs; // global scale on the ABSOLUTE (albedo-offset) detail term
uniform vec2  uBlockJitter; // per-block value jitter: x relative, y absolute
uniform float uSeam;      // how dark the per-block groove goes, 0 .. 1
#endif
#if MAX_LIGHTS > 0
uniform int   uLightCount;
uniform vec3  uLightPos[MAX_LIGHTS];
uniform vec3  uLightColor[MAX_LIGHTS];
uniform float uLightRadius[MAX_LIGHTS];
#endif

in vec3  vColor;
in float vLightBase;
flat in vec3 vEmissive;
in float vAlpha;
in float vFogDepth;
in highp vec3 vWorldPos;
flat in vec3 vNormal;
flat in float vLiquid;
#ifdef USE_TEXTURE
flat in vec4 vSurf;
flat in float vVary;
#endif

layout(location = 0) out vec4 fragColor;

void main() {
  vec3 base = vColor * uTint;
  float lit = vLightBase;

#ifdef USE_TEXTURE
  // ---- surface detail -----------------------------------------------------
  // Derivatives first, at top level: they must not sit inside the face branch.
  highp vec3 ddx = dFdx(vWorldPos);
  highp vec3 ddy = dFdy(vWorldPos);
  // highp all the way down. These are world metres, and an fp16 mediump float
  // quantises to 0.125 by the time the world coordinate reaches 128 — which
  // would turn fract() into staircase garbage on any GPU that honours mediump.
  highp vec2 uv, dux, duy;
  vec3 an = abs(vNormal);
  if (an.y > 0.5)      { uv = vWorldPos.xz; dux = ddx.xz; duy = ddy.xz; }
  else if (an.x > 0.5) { uv = vWorldPos.zy; dux = ddx.zy; duy = ddy.zy; }
  else                 { uv = vWorldPos.xy; dux = ddx.xy; duy = ddy.xy; }

  // One block == one tile, whatever size the greedy quad ended up.
  highp vec2 cell = fract(uv);
  vec2 tileSize = vec2(${TILE_U}, ${TILE_V});

  float amp = vSurf.z * uDetail;
  float absAmp = vSurf.z * uDetailAbs;
  // One gate for the whole surface term, so uDetail == uDetailAbs == 0 really
  // is a flat untextured world and not a cheaper-looking textured one.
  if (amp + absAmp > 0.0) {
    // Four orientations, chosen by a hash of the block's own coordinates, so
    // rock and dirt do not tile visibly across a big face. Bonded and panelled
    // materials opt out (vVary == 0) because their lines must line up.
    highp float h = fract(sin(dot(floor(uv), vec2(127.1, 311.7))) * 43758.5453);
    cell = mix(cell, 1.0 - cell, step(0.5, vec2(h, fract(h * 97.13))) * vVary);
    // Explicit gradients: the atlas is addressed by hand, so the hardware must
    // be told the real footprint or every tile edge picks the wrong mip.
    float d = textureGrad(
      uSurfaceAtlas, vSurf.xy + cell * tileSize, dux * tileSize, duy * tileSize).r;

    // The tile's signed deviation from neutral, -1 .. 1.
    float m = (d - 0.5) * 2.0;

    // TWO terms, and the second one is the entire fix.
    //
    // A pure MULTIPLICATIVE modulation is a percentage of the albedo, so its
    // Weber contrast is constant and its absolute size is not. Measured, ours
    // sat at 1.6-4.7% against the bar's 1.6-2.9% — competitive — and still
    // vanished, because on a Doom palette a percentage of a small number is a
    // small number: at mean luminance 30 the whole modulation landed under one
    // grey level and fell through 8-bit quantisation. The texture was present
    // in the maths and absent on the screen.
    //
    // The ADDITIVE term is an albedo offset in linear units, so what it is
    // worth in grey levels does not depend on how dark the material is. It
    // still rides the lighting (it is added to albedo, not to the final pixel),
    // so a wall in shadow is still a wall in shadow — but a dark wall now has
    // texture and a bright wall barely notices, because relative to a 0.9
    // albedo the same offset is a few percent.
    base = base * (1.0 + m * amp) + m * absAmp;

    // ---- per-block value jitter -----------------------------------------
    // Greedy meshing merges forty blocks of the same material into one quad and
    // the tile repeats identically across all of them, so a big wall reads as
    // one painted mass however good the tile is. Hash the block's own integer
    // world position into a small value offset and the wall becomes countable
    // blocks again. Stepping half a block back along the face normal turns the
    // face plane's exact integer into the cell behind it, so every fragment of
    // one face agrees on the hash and two adjacent blocks never do.
    highp vec3 bp = floor(vWorldPos - vNormal * 0.5);
    float j = fract(sin(dot(bp, vec3(12.9898, 78.233, 37.719))) * 43758.5453) * 2.0 - 1.0;
    base = base * (1.0 + j * uBlockJitter.x) + j * uBlockJitter.y;

    base = max(base, vec3(0.0));
  }

  // ---- per-block seam -----------------------------------------------------
  // Edge distance measured in PIXELS, so the groove is the same weight at one
  // metre and at thirty, then faded out once a block is too small to hold it.
  //
  // Deliberately quieter than it was. When the tiles were invisible this groove
  // was the only thing breaking up a wall, so it had to be strong enough to do
  // that job alone — and a lattice drawn over flat colour is what it looked
  // like. With the tiles carrying the surface and the hash carrying the
  // block-to-block step, the seam goes back to being the shadow in a joint: it
  // finishes the grid instead of being the grid.
  highp vec2 w = max(abs(dux) + abs(duy), vec2(1e-6));
  highp vec2 edge = min(cell, 1.0 - cell) / w;
  highp float pxPerBlock = 1.0 / max(max(w.x, w.y), 1e-6);
  float groove = 1.0 - smoothstep(0.0, 1.6, min(edge.x, edge.y));
  base *= 1.0 - groove * groove * vSurf.w * uSeam * smoothstep(3.0, 9.0, pxPerBlock);
#endif

  // Greedy meshing merges a still lake into a handful of enormous quads, so a
  // vertex ripple has nothing to ripple. Do the shimmer per fragment instead.
  if (vLiquid > 0.5) {
    float rip = sin(vWorldPos.x * 1.7 + uTime * 1.9) * sin(vWorldPos.z * 2.1 - uTime * 1.35);
    lit *= 1.0 + rip * uRipple;
  }

  // Block light is ADDED to the sky/sun term, not maxed against it, so a lava
  // pit lights the room it is in instead of merely flattening it to one value.
  // The damping term keeps an already-sunlit face from blowing out: a torch
  // outdoors is worth almost nothing, indoors it is worth everything, which is
  // both physically right and the reason interiors are worth building.
  vec3 c = base * (vec3(lit) + vEmissive * (1.0 - min(lit, 1.0) * ${EMISSIVE_DAMP.toFixed(2)}));

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

  // Fog is atmosphere, not a filter on the lens. exp2 fog measured from the eye
  // starts eating contrast the moment anything is more than a few metres away:
  // at the old density it took a third of the contrast out of a wall at 60 m,
  // which is the range you fight at. Everything inside uFogStart is therefore
  // left completely alone, and the exp2 ramp runs from there to the render
  // distance so the world edge still dissolves into the horizon.
  // Two extra instructions: one subtract, one max.
  float fd = max(vFogDepth - uFogStart, 0.0) * uFogDensity;
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
  /** Procedural surface detail + per-block seam. On by default; it is GPU-only. */
  texture?: boolean;
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

  private readonly faceAmbient = new Float32Array(6);
  private readonly faceSun = new Float32Array(6);
  private readonly faceNormal = new Float32Array(18);
  private readonly aoLevels = new Float32Array(4);
  private readonly lightHue = new Float32Array(LIGHT_HUE_COUNT * 3);
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
  private textureEnabled: boolean;
  private fogFar: number;
  private fogStart: number;

  /** User multiplier on the surface term, composed with the quality tier. */
  private detailScale = 1;

  /** Greyscale detail atlas and the face-colour -> surface lookup. Owned here. */
  private atlasTexture: THREE.DataTexture | null;
  private lutTexture: THREE.DataTexture | null;

  constructor(opts: VoxelMaterialOptions = {}) {
    this.quality = opts.quality ?? 'high';
    this.aoStrength = opts.ao === false ? 0 : AO_STRENGTH;
    this.fogEnabled = opts.fog !== false;
    this.ditherEnabled = opts.dither !== false;
    this.textureEnabled = opts.texture !== false;
    this.fogFar = opts.fogFar ?? 6 * 32;
    this.fogStart = this.fogFar * FOG_START_FRAC;

    // Both are generated into typed arrays: no asset file, no fetch, no canvas,
    // and nothing added to the bundle payload. ~13 ms at boot on an M3 Pro for
    // the 512x512 atlas plus the 256x256 LUT, off the render path and skipped
    // entirely when the surface-detail setting is 'off' (the textures are then
    // built on first enable, not at construction).
    this.atlasTexture = this.textureEnabled ? createAtlasTexture() : null;
    this.lutTexture = this.textureEnabled ? createSurfaceLutTexture() : null;

    this.uniforms = {
      uFaceAmbient: { value: this.faceAmbient },
      uFaceSun: { value: this.faceSun },
      uFaceNormal: { value: this.faceNormal },
      uAoLevels: { value: this.aoLevels },
      uLightHue: { value: this.lightHue },
      uInterior: { value: new THREE.Vector2(INTERIOR_AMBIENT, INTERIOR_SUN) },
      uTime: { value: 0 },
      uWaveAmp: { value: 0.05 },
      uWaveSpeed: { value: 1.7 },
      uEmissiveGain: { value: 1.15 },
      uFogColor: { value: hexToVec3(opts.fogColor ?? DOOM_FOG, new THREE.Vector3()) },
      uFogDensity: { value: 0 },
      uFogStart: { value: 0 },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uContrast: { value: 0.26 },
      uSaturation: { value: 0.80 },
      uExposure: { value: 1.0 },
      uRipple: { value: 0.085 },
      uSurfaceAtlas: { value: this.atlasTexture },
      uSurfaceLut: { value: this.lutTexture },
      // Written by applyDetail(); see DETAIL_REL / DETAIL_ABS / BLOCK_JITTER.
      uDetail: { value: DETAIL_REL },
      uDetailAbs: { value: DETAIL_ABS },
      uBlockJitter: { value: new THREE.Vector2(BLOCK_JITTER_REL, BLOCK_JITTER_ABS) },
      uSeam: { value: SEAM_STRENGTH },
      uLightCount: { value: 0 },
      uLightPos: { value: this.lightPos },
      uLightColor: { value: this.lightColor },
      uLightRadius: { value: this.lightRadius },
    };

    // Face normals, in shared `Face` order: PX NX PY NY PZ NZ.
    this.faceNormal.set([1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]);
    for (let i = 0; i < LIGHT_HUE_COUNT; i++) {
      const hex = LIGHT_HUE_RGB[i];
      this.lightHue[i * 3 + 0] = ((hex >>> 16) & 0xff) / 255;
      this.lightHue[i * 3 + 1] = ((hex >>> 8) & 0xff) / 255;
      this.lightHue[i * 3 + 2] = (hex & 0xff) / 255;
    }
    this.rebuildFaceLight();
    this.rebuildAo();
    this.setFogFar(this.fogFar);
    this.applyDetail();

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
    if (this.textureEnabled) defines.USE_TEXTURE = 1;

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
    // different values. Ambient and sun stay in separate arrays because the
    // mesher's sky channel attenuates them by different amounts (see
    // INTERIOR_AMBIENT / INTERIOR_SUN).
    const nx = [1, -1, 0, 0, 0, 0];
    const ny = [0, 0, 1, -1, 0, 0];
    const nz = [0, 0, 0, 0, 1, -1];
    let len = Math.hypot(this.sunX, this.sunY, this.sunZ);
    if (len < 1e-5) len = 1;
    const lx = this.sunX / len, ly = this.sunY / len, lz = this.sunZ / len;
    for (let f = 0; f < 6; f++) {
      const ndl = Math.max(0, nx[f] * lx + ny[f] * ly + nz[f] * lz);
      this.faceAmbient[f] = FACE_SHADE[f] * this.skyAmbient;
      this.faceSun[f] = FACE_SHADE[f] * this.sunStrength * ndl;
    }
    this.flagUniforms();
  }

  private rebuildAo(): void {
    // Four exact levels beat a pow() in the vertex shader and let AO be a
    // slider. See AO_FALLOFF for why the ramp is not evenly spaced.
    for (let i = 0; i < 4; i++) {
      const v = 1 - this.aoStrength * AO_FALLOFF[i];
      this.aoLevels[i] = v < AO_FLOOR ? AO_FLOOR : v;
    }
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

  /* -- interior light ----------------------------------------------------- */

  /**
   * How much of the outdoor light reaches a face the mesher marked as roofed.
   * `ambient` and `sun` are both 0..1; 1/1 disables the interior/exterior split
   * entirely and gives back the pre-sky-channel look.
   *
   * A mode with no interiors at all can leave this alone — every face outdoors
   * has sky 15 and the term is exactly 1.
   */
  setInteriorLight(ambient: number, sun: number): void {
    (this.uniforms.uInterior.value as THREE.Vector2)
      .set(clamp(ambient, 0, 1), clamp(sun, 0, 1));
    this.flagUniforms();
  }

  /** Current interior shares as [ambient, sun]. */
  get interiorLight(): THREE.Vector2 {
    return this.uniforms.uInterior.value as THREE.Vector2;
  }

  /**
   * Global multiplier on baked block light. 0 turns lava and neon into plain
   * coloured blocks that light nothing.
   */
  setEmissiveGain(v: number): void {
    this.uniforms.uEmissiveGain.value = Math.max(0, v);
    this.flagUniforms();
  }

  /* -- fog --------------------------------------------------------------- */

  /**
   * Distance in metres at which fog is 98% closed. exp2 fog needs a density,
   * and a density is not a number anybody can reason about. The clear-air
   * distance in front of it comes along at FOG_START_FRAC of the same number,
   * so every existing caller gets the near field back without being changed.
   */
  setFogFar(metres: number): void {
    this.setFogRange(Math.max(8, metres) * FOG_START_FRAC, metres);
  }

  /**
   * Both ends of the fog, explicitly: clear air out to `startMetres`, then an
   * exp2 ramp that is 98% closed at `farMetres`. A mode that wants thick air
   * moves the start in; one that wants the bar's crisp distance moves it out.
   */
  setFogRange(startMetres: number, farMetres: number): void {
    this.fogFar = Math.max(8, farMetres);
    // Leave at least a quarter of the range for the ramp itself: a start that
    // crowds the far plane turns fog into a wall at the render distance, which
    // is the popping this is supposed to hide.
    this.fogStart = clamp(startMetres, 0, this.fogFar * 0.75);
    this.uniforms.uFogStart.value = this.fogStart;
    this.uniforms.uFogDensity.value = this.fogEnabled
      ? 1.978 / Math.max(1, this.fogFar - this.fogStart)
      : 0;
    this.flagUniforms();
  }

  /** Metres of clear air in front of the camera. */
  get fogStartDistance(): number { return this.fogStart; }

  /** Metres at which fog is 98% closed. */
  get fogFarDistance(): number { return this.fogFar; }

  /**
   * The correct way to set fog: it must close just inside the render distance
   * or chunks pop in against a clear sky at the edge of the world.
   */
  setFogFromRenderDistance(chunks: number): void {
    this.setFogFar(Math.max(2, chunks) * CHUNK_SIZE_X * FOG_FAR_FRAC);
  }

  setFogEnabled(on: boolean): void {
    this.fogEnabled = on;
    // Re-apply the range that is actually set, not the default fraction of it:
    // toggling fog in the settings must not silently undo a mode's palette.
    this.setFogRange(this.fogStart, this.fogFar);
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
    // The tier owns the surface term too, not just the light count.
    this.applyDetail();
  }

  /**
   * Global multiplier on every material's authored detail strength, composed
   * with the quality tier. 0 is a flat untextured world, 1 is as authored.
   * Anything past ~1.4 starts fighting the flat-shaded voxel read, which is
   * worse than no texture at all.
   *
   * Scales the relative term, the absolute term and the per-block jitter
   * together, so "half the detail" means half of all of it and not a surface
   * that loses its percentage modulation and keeps its offset.
   */
  setSurfaceDetail(scale: number): void {
    this.detailScale = clamp(scale, 0, 2);
    this.applyDetail();
  }

  /** The effective detail multiplier: the quality tier times the user's scale. */
  get surfaceDetail(): number {
    return QUALITY_DETAIL[this.quality] * this.detailScale;
  }

  private applyDetail(): void {
    const k = this.surfaceDetail;
    this.uniforms.uDetail.value = DETAIL_REL * k;
    this.uniforms.uDetailAbs.value = DETAIL_ABS * k;
    (this.uniforms.uBlockJitter.value as THREE.Vector2)
      .set(BLOCK_JITTER_REL * k, BLOCK_JITTER_ABS * k);
    this.flagUniforms();
  }

  /** How dark the per-block groove goes, 0 .. 1. Default 0.12. */
  setSeamStrength(v: number): void {
    this.uniforms.uSeam.value = clamp(v, 0, 1);
    this.flagUniforms();
  }

  /**
   * Turn the whole atlas path off — the define, the two fetches and the
   * derivatives with it, not just its amplitude. This is the setting a low-end
   * phone actually needs; `setSurfaceDetail(0)` leaves a shader that still
   * samples and then multiplies by zero.
   *
   * The atlas and LUT are built on first enable, so a session that never turns
   * it on never pays the boot cost or the texture memory.
   */
  setTextureEnabled(on: boolean): void {
    if (on === this.textureEnabled) return;
    this.textureEnabled = on;
    if (on && this.atlasTexture === null) {
      this.atlasTexture = createAtlasTexture();
      this.lutTexture = createSurfaceLutTexture();
      this.uniforms.uSurfaceAtlas.value = this.atlasTexture;
      this.uniforms.uSurfaceLut.value = this.lutTexture;
    }
    for (const m of this.all) {
      if (on) m.defines.USE_TEXTURE = 1;
      else delete m.defines.USE_TEXTURE;
      m.needsUpdate = true;
    }
    this.flagUniforms();
  }

  get textureOn(): boolean {
    return this.textureEnabled;
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
    this.atlasTexture?.dispose();
    this.lutTexture?.dispose();
  }
}
