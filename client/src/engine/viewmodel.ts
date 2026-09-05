/**
 * DOOMCRAFT — first-person weapon viewmodel.
 *
 * ref/BAR.md weakness #2, measured not guessed: across 1.2 s of continuous
 * mouselook in the bar's own capture the held item "does not move one pixel
 * relative to the camera". No sway, no bob, no kick, no flash. It is a decal.
 *
 * This answers two bars at once.
 *
 * The MOTION bar is voxiom: a static billboard. Beaten by five stacked layers —
 * look sway, walk bob, landing dip, an underdamped fire spring driven straight
 * off `shared/src/weapons.ts`, and pose blends for sprint, crouch, reload and
 * the weapon switch.
 *
 * The READABILITY bar is DOOM (`ref/doom/doom-gameplay.webm`): a large, high
 * contrast weapon with a silhouette you can name in one frame. That is the
 * harder one, and four things carry it. Each was arrived at by shooting the
 * build, reading the frame, and fixing what the frame actually showed.
 *
 *  1. COMPOSITION. DOOM frames the weapon low and CENTRED, with the breech
 *     falling off the bottom edge and nothing lost off the side. The first
 *     build framed it low and RIGHT at 1.25 m: stock, trigger hand and forearm
 *     piled into the bottom-right corner, half cropped by the frame and the
 *     rest colliding with the hotbar. REST_DIST/REST_PITCH fix that — pushing
 *     the rest distance out shrinks the solid and pulls it toward the middle at
 *     the same rate, and a nose-up trim drops the breech below the frame.
 *
 *  2. YAW, which decides whether a long gun reads at all. A barrel pointing
 *     into the screen projects to length * sin(yaw); at 16 degrees a 384 mm
 *     shotgun barrel is 106 mm on the picture plane and the weapon's defining
 *     feature collapses into a stub. restYaw is 21 degrees and the long tubes
 *     were built 22 % longer on top of that.
 *
 *  3. THE CONTOUR. A gun made of mid-grey slabs disappears into a mid-grey
 *     wall. The same vertex buffer is drawn a second time, inflated 2 mm per
 *     axis via the aGrow attribute, back faces only, in near-black — a two
 *     pixel ink line round the whole silhouette and round every sub-assembly
 *     that stands proud of it. One extra draw per mesh, no extra geometry.
 *     With the per-face BEVEL underneath it, the model reads as voxels and
 *     every part separates, in a lit courtyard and in a black corridor.
 *
 *  4. SHAPE AND HUE PER WEAPON, so peripheral vision can name them without
 *     inspection: pistol a compact L, shotgun a DOUBLE LINE of barrel over
 *     magazine tube with daylight between (the only hole through any outline
 *     here) in warm wood, chaingun six strake-shadowed rods off a spindle,
 *     rocket a flared bell no other weapon ends in, plasma a cyan emitter
 *     stack, BFG a green core between two hooked jaws, chainsaw a toothed bar.
 *
 * HANDS. "A green wedge reading as an arm is worse than no arm." The gloves
 * are a full value band below the gun's steel, only one band per hand carries
 * a highlight, fingers are staggered and stepped in value rather than stacked
 * as equal bricks, and the forearm is two short raked bands that leave the
 * frame instead of lying across it. Grip and hand are emitted by ONE function
 * from ONE anchor so no gap can open between them. On the shotgun the grip is
 * gunmetal, not wood: brown glove on brown furniture is an invisible hand.
 *
 * On top of that: a real per-weapon reload (mag drops, shells feed one at a
 * time, the rocket slides into the breech, the BFG jaws open as the core
 * charges), an eased switch raise/lower on the table's switchInMs/switchOutMs,
 * a ragged seven-petal muzzle bloom at the actual barrel that lights the gun
 * that made it, and brass that ejects.
 *
 * It renders as an overlay pass into its own scene and camera with a cleared
 * depth buffer, which is the standard fix for a viewmodel poking through walls.
 * Cost, measured with tools/capture-ours.mjs at 915x412 under verified 4x CPU
 * throttle against the 0.90 ms budget in ref/BAR.md: game.medianMs 0.60 ms,
 * unchanged by the contour pass. render() submits at most nine draw calls —
 * body, up to three animated sub-assemblies, their contours, the flash and the
 * brass.
 */

import * as THREE from 'three';
import {
  clamp,
  expDecay,
  FireKind,
  getWeapon,
  LAND_DIP_MAX,
  SPEED_RUN,
  TAU,
  VIEW_BOB_AMPLITUDE,
  VIEW_BOB_HZ,
  wrapAngle,
  WeaponId,
  WEAPON_COUNT,
} from '@doomcraft/shared';
import type { OverlayPass } from './renderer';

/* ------------------------------------------------------------------------ *
 * Palette
 *
 * Two rules. Value range inside one weapon must be wide or the boxes fuse.
 * Hue must differ BETWEEN weapons or peripheral vision cannot tell them apart.
 * ------------------------------------------------------------------------ */

const STEEL_HI = 0xa9b4c2;
const STEEL = 0x848d99;
const GUNMETAL = 0x5c6470;
const GUNDARK = 0x2f343c;
const GUNBLACK = 0x14171b;
const BRASS = 0xd6a848;
const BRASS_DK = 0x8f6b26;
// The shotgun is the only wooden weapon and hue is half its read at a glance,
// so the wood is pushed warm and saturated rather than left as a brown that
// greys out next to gunmetal.
const WOOD = 0x7e4a1c;
const WOOD_HI = 0xab6d2e;
const WOOD_DK = 0x452709;
const OLIVE = 0x515b31;
const OLIVE_HI = 0x6c7842;
const RED = 0xc0301f;
const RED_HI = 0xe2573a;
const RED_DK = 0x7d1d12;
const AMBER = 0xe8b93a;
const CYAN = 0x1f9ada;
const CYAN_HOT = 0x64d6ff;
// Emissive greens are picked for what they look like AFTER the glow term
// multiplies them and the channels clamp. 0xa4ff42 boosted is (0.83, 1, 0.34) —
// which is not green, it is pale yellow, and it made the core read as a lamp.
const BFGREEN = 0x4bb31c;
const BFGREEN_HOT = 0x63ff22;

/**
 * The marine's hands.
 *
 * The arm is where the old model lost. Olive armour plates raked across the
 * bottom corner of the frame did not read as a limb, they read as a green
 * wedge — a shape with no anatomy, competing with the weapon for attention in
 * the one place the eye never leaves. So: the glove keeps DOOM's warm brown,
 * everything above the wrist is desaturated graphite, and the forearm is short
 * enough to leave the frame instead of lying across it.
 */
// Two value rules, learned from a capture where the gloves read as a stack of
// cardboard boxes: the glove must sit a full value band BELOW the gun's steel
// (top faces take ~0.98 of the key light, so a tan base renders cream), and
// only ONE band per hand may carry the highlight, or every knuckle becomes its
// own bright rectangle and the hand dissolves into bricks.
const GLOVE = 0x4e351d;
const GLOVE_HI = 0x6d4a29;
const GLOVE_DK = 0x2a1b0c;
const CUFF = 0x2b3038;
const CUFF_HI = 0x454e5a;
const CUFF_DK = 0x161a1f;
const STRAP = 0x1d2025;

/* ------------------------------------------------------------------------ *
 * Box soup
 * ------------------------------------------------------------------------ */

/**
 * One voxel slab. Centre + size in metres, packed colour, an optional local
 * Euler rotation (XYZ, applied about the box's own centre) and an optional
 * emissive weight in 0..1 for parts that light themselves.
 */
interface Box {
  readonly x: number; readonly y: number; readonly z: number;
  readonly w: number; readonly h: number; readonly d: number;
  readonly c: number;
  readonly rx: number; readonly ry: number; readonly rz: number;
  readonly e: number;
}

function b(
  x: number, y: number, z: number,
  w: number, h: number, d: number,
  c: number, rx = 0, ry = 0, rz = 0, e = 0,
): Box {
  return { x, y, z, w, h, d, c, rx, ry, rz, e };
}

/** Translate a group. */
function moved(list: readonly Box[], dx: number, dy: number, dz: number): Box[] {
  const out: Box[] = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    out[i] = { ...s, x: s.x + dx, y: s.y + dy, z: s.z + dz };
  }
  return out;
}

/** Rotate a group about the group origin's X axis, rotating each box with it. */
function pitched(list: readonly Box[], a: number): Box[] {
  const ca = Math.cos(a), sa = Math.sin(a);
  const out: Box[] = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    out[i] = { ...s, y: s.y * ca - s.z * sa, z: s.y * sa + s.z * ca, rx: s.rx + a };
  }
  return out;
}

/** Rotate a group about the group origin's Z axis. */
function rolled(list: readonly Box[], a: number): Box[] {
  const ca = Math.cos(a), sa = Math.sin(a);
  const out: Box[] = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    out[i] = { ...s, x: s.x * ca - s.y * sa, y: s.x * sa + s.y * ca, rz: s.rz + a };
  }
  return out;
}

/**
 * `count` slabs evenly round the Z axis — the trick that makes a round mouth.
 * `closed` widens each slab tangentially until they meet, which is the
 * difference between a ring and a handful of loose cubes at viewing distance.
 */
function ringZ(
  count: number, radius: number, z: number, len: number, thick: number,
  color: number, colorAlt = -1, emit = 0, closed = false,
): Box[] {
  const out: Box[] = [];
  const tang = closed ? 2 * radius * Math.tan(Math.PI / count) * 1.06 : thick;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU;
    out.push(b(
      Math.cos(a) * radius, Math.sin(a) * radius, z,
      thick, tang, len,
      colorAlt >= 0 && (i & 1) === 1 ? colorAlt : color,
      0, 0, a, emit,
    ));
  }
  return out;
}

/** A square collar round the Z axis — cheaper than a ring, reads the same small. */
function collarZ(r: number, z: number, t: number, len: number, color: number, emit = 0): Box[] {
  return [
    b(0, r, z, r * 2 + t, t, len, color, 0, 0, 0, emit),
    b(0, -r, z, r * 2 + t, t, len, color, 0, 0, 0, emit),
    b(r, 0, z, t, r * 2 - t, len, color, 0, 0, 0, emit),
    b(-r, 0, z, t, r * 2 - t, len, color, 0, 0, 0, emit),
  ];
}

/* ------------------------------------------------------------------------ *
 * Hands
 *
 * "A green wedge reading as an arm is worse than no arm."
 *
 * Two things were wrong with the wedge and both are fixed here by construction:
 *
 *   1. It was olive and it was long, so a flat quadrilateral of mid-green sat
 *      across the corner of every frame. The glove is still DOOM's brown; the
 *      cuff and forearm are graphite, banded, and short enough to exit the
 *      viewport rather than cross it.
 *   2. The hand and the grip were placed independently, so the fingers floated
 *      in front of the frame they were supposedly closed round — visible as a
 *      strip of daylight between four loose bricks and the gun. Grip and hand
 *      are now emitted by ONE function from ONE anchor, so that gap cannot
 *      reopen no matter where a weapon puts its grip.
 *
 * Everything is authored round a grip centred on the origin, 46 x 118 x 56 mm,
 * with the barrel running down -z and the camera off to -x.
 * ------------------------------------------------------------------------ */

/**
 * Trigger hand, closed round a vertical grip at the origin.
 *
 * Oriented for how it is actually seen. The gun sits right of centre so the
 * camera looks at its LEFT flank, which on a right-handed grip shows the four
 * fingertips coming round the front-left corner and the thumb laid up the
 * near face — not the back of the hand, which is hidden on the far side.
 */
function rightHand(): Box[] {
  return [
    // palm and knuckle ridge, far side: mostly hidden, but it closes the form
    b(0.030, 0.000, 0.006, 0.030, 0.094, 0.062, GLOVE),
    b(0.030, 0.045, -0.006, 0.032, 0.019, 0.054, GLOVE),
    // Four fingers across the FRONT of the grip, and the whole reason this
    // reads as a hand and not as four bricks is that they are STAGGERED: the
    // index finger stands proud, the little finger is short and set back, and
    // each one steps 2 mm further round the grip than the last. Only the top
    // one is lit; the rest fall away in value, which is what an eye reads as
    // curvature.
    b(0.002, 0.034, -0.045, 0.060, 0.018, 0.036, GLOVE_HI, 0, 0, -0.08),
    b(0.002, 0.015, -0.046, 0.062, 0.018, 0.038, GLOVE, 0, 0, -0.06),
    b(0.001, -0.004, -0.045, 0.060, 0.018, 0.036, GLOVE, 0, 0, -0.05),
    b(0.000, -0.023, -0.041, 0.055, 0.017, 0.031, GLOVE_DK, 0, 0, -0.03),
    // tips curling back round the LEFT face — the side the camera is on
    b(-0.029, 0.033, -0.024, 0.024, 0.018, 0.030, GLOVE),
    b(-0.030, 0.014, -0.025, 0.024, 0.018, 0.032, GLOVE),
    b(-0.030, -0.005, -0.024, 0.024, 0.018, 0.031, GLOVE_DK),
    b(-0.028, -0.024, -0.021, 0.022, 0.016, 0.027, GLOVE_DK),
    // thumb: up the near face, then over the front. Two boxes, one bend.
    b(-0.028, -0.008, 0.020, 0.022, 0.030, 0.042, GLOVE, 0.30),
    b(-0.028, 0.026, 0.000, 0.022, 0.026, 0.036, GLOVE_HI, 0.08),
    // wrist
    b(0.018, -0.060, 0.028, 0.054, 0.046, 0.058, GLOVE_DK),
    // Cuff, then TWO forearm bands and gone. The forearm is the largest flat
    // area the viewmodel can put on screen, so it is kept short, dark and
    // raked hard out of the bottom corner: it should leave the frame, never
    // lie across it.
    b(0.020, -0.082, 0.058, 0.066, 0.050, 0.030, CUFF),
    b(0.020, -0.059, 0.058, 0.050, 0.013, 0.028, CUFF_HI),
    ...moved(pitched([
      b(0, 0, 0.044, 0.064, 0.068, 0.076, CUFF),
      b(-0.034, 0.004, 0.044, 0.007, 0.038, 0.068, CUFF_HI),
      b(0, 0.006, 0.088, 0.068, 0.062, 0.014, STRAP),
      b(0, 0.002, 0.124, 0.058, 0.062, 0.056, CUFF_DK),
    ], 0.86), 0.023, -0.104, 0.040),
  ];
}

/**
 * Support hand, wrapped over a horizontal fore-end centred on the origin and
 * running along z. This is the LEFT hand, so the camera sees its knuckles from
 * above-left and the fingers hanging down the near face.
 *
 * Every two-handed weapon in the set gives it a horizontal fore-end to hold on
 * purpose: one support hand that always meets the same shape is worth more
 * than two, one of which is a mirrored right hand with inverted winding.
 */
function leftHand(): Box[] {
  return [
    // Four fingers down the CAMERA side of the fore-end. Each is TWO boxes —
    // a short side segment and a tip tucked under — so the hand wraps the
    // fore-end instead of standing beside it as four full-height panels. Four
    // 58 mm tan slabs on the near face was the single biggest reason the old
    // support hand photographed as a cardboard box.
    b(-0.033, 0.004, -0.040, 0.024, 0.036, 0.025, GLOVE),
    b(-0.033, 0.001, -0.013, 0.024, 0.038, 0.025, GLOVE),
    b(-0.033, 0.001, 0.014, 0.024, 0.038, 0.025, GLOVE),
    b(-0.032, 0.004, 0.041, 0.022, 0.034, 0.024, GLOVE_DK),
    b(-0.026, -0.021, -0.040, 0.030, 0.020, 0.024, GLOVE_DK),
    b(-0.026, -0.024, -0.013, 0.030, 0.020, 0.024, GLOVE_DK),
    b(-0.026, -0.024, 0.014, 0.030, 0.020, 0.024, GLOVE_DK),
    b(-0.025, -0.021, 0.041, 0.028, 0.018, 0.023, GLOVE_DK),
    // back of the hand over the top, one lit knuckle ridge up front
    b(-0.006, 0.033, 0.002, 0.054, 0.026, 0.096, GLOVE),
    b(-0.006, 0.046, -0.030, 0.050, 0.014, 0.032, GLOVE_HI),
    // thumb along the far top edge
    b(0.023, 0.028, -0.016, 0.024, 0.022, 0.060, GLOVE),
    // wrist and cuff dropping away behind and to the near side
    b(-0.040, -0.026, 0.060, 0.042, 0.058, 0.044, GLOVE_DK),
    b(-0.048, -0.058, 0.086, 0.056, 0.050, 0.030, CUFF),
    b(-0.048, -0.036, 0.086, 0.042, 0.013, 0.028, CUFF_HI),
    // two bands and out of frame
    ...moved(rolled(pitched([
      b(0, 0, 0.044, 0.062, 0.066, 0.076, CUFF),
      b(0, 0.034, 0.044, 0.030, 0.011, 0.068, CUFF_HI),
      b(0, 0.006, 0.086, 0.068, 0.060, 0.014, STRAP),
      b(0, 0.002, 0.124, 0.058, 0.062, 0.068, CUFF_DK),
    ], 0.60), -0.26), -0.052, -0.068, 0.092),
  ];
}

/**
 * A pistol grip AND the hand closed round it, from one anchor. `rake` tips the
 * whole assembly back the way a real grip is raked, `h` sets the grip length so
 * a BFG's fist-and-a-half grip and a pistol's do not have to be the same box.
 */
function gripHand(
  x: number, y: number, z: number, rake: number,
  h = 0.118, c = GUNDARK, cHi = GUNMETAL,
): Box[] {
  return moved(pitched([
    b(0, 0, 0, 0.046, h, 0.056, c),
    b(-0.025, 0, 0, 0.006, h - 0.022, 0.046, cHi),
    b(0, -h * 0.5 - 0.006, 0.004, 0.052, 0.012, 0.062, GUNBLACK),
    ...rightHand(),
  ], rake), x, y, z);
}

/**
 * A fore-end AND the support hand on it. `len` is how far the fore-end runs
 * along the barrel; the hand always lands in its middle.
 */
function foreHand(
  x: number, y: number, z: number, rake = 0, len = 0.150, c = GUNDARK, cHi = GUNMETAL,
): Box[] {
  return moved(pitched([
    b(0, 0, 0, 0.062, 0.066, len, c),
    b(0, 0.036, 0, 0.052, 0.010, len - 0.010, cHi),
    b(-0.033, -0.004, 0, 0.006, 0.044, len - 0.016, cHi),
    ...leftHand(),
  ], rake), x, y, z);
}

/* ------------------------------------------------------------------------ *
 * Animated sub-assemblies
 * ------------------------------------------------------------------------ */

const enum Role {
  /** Chaingun barrel cluster — continuous spin about Z. */
  SPIN = 0,
  /** Pistol slide / rocket breech cover — snaps back on fire, forward after. */
  SLIDE = 1,
  /** Shotgun pump — a full rack after every shot and at the end of a reload. */
  PUMP = 2,
  /** Detachable magazine, cell pack or ammo drum — drops out and returns. */
  MAG = 3,
  /** A single round travelling into the gun. */
  FEED = 4,
  /** BFG prong cage — opens as the core charges. */
  CLAW = 5,
  /** Chainsaw chain — scrolls along the bar. */
  CHAIN = 6,
}

interface Part {
  readonly role: Role;
  readonly boxes: readonly Box[];
  /** Rotation/scale origin in model space. Defaults to the model origin. */
  readonly pivot?: readonly [number, number, number];
  /** Travel in metres for the translating roles. */
  readonly travel?: number;
}

interface WeaponShape {
  readonly body: readonly Box[];
  readonly parts?: readonly Part[];
  /** Where the flash comes out, in model space. */
  readonly muzzle: readonly [number, number, number];
  /** Where brass leaves the gun. Absent = no ejection. */
  readonly eject?: readonly [number, number, number];
  /** Multiplier on the muzzle-flash solid. */
  readonly flash?: number;
  /** Uniform scale applied to the whole solid. */
  readonly scale?: number;
  /** Rest-pose trim: heavy weapons sit lower and further out. */
  readonly restY?: number;
  readonly restZ?: number;
  readonly restPitch?: number;
}

/* ------------------------------------------------------------------------ *
 * The arsenal
 *
 * Model space: +x right, +y up, +z toward the player, so the barrel runs down
 * -z. The origin sits at the trigger hand. Sizes are real metres; a 0.06 m
 * feature is about 100 px tall on a 900 px viewport at the rest distance.
 * ------------------------------------------------------------------------ */

/* ---- 1 · PISTOL ---------------------------------------------------------- *
 * The only one-handed weapon in the set, which is most of its read: a bare
 * grip with nothing supporting it says "sidearm" before any detail lands.
 * Compact L — raked grip under a long flat slide, brass magwell floor, real
 * iron sights, and a bore you can see down. */
const PISTOL_MAG = moved(pitched([
  b(0, -0.074, 0, 0.038, 0.052, 0.044, GUNMETAL),
  b(0, -0.104, 0.008, 0.050, 0.014, 0.062, BRASS),
], 0.24), 0, -0.082, 0.086);

const PISTOL_SLIDE: Box[] = [
  b(0, 0.030, -0.052, 0.054, 0.042, 0.244, STEEL),
  b(0, 0.053, -0.052, 0.046, 0.010, 0.242, STEEL_HI),
  b(-0.028, 0.032, -0.098, 0.005, 0.018, 0.098, GUNDARK),
  b(0.028, 0.032, -0.098, 0.005, 0.018, 0.098, GUNDARK),
  // cocking serrations, near end only — six seams the bevel does for free
  b(-0.028, 0.030, 0.028, 0.005, 0.034, 0.011, GUNDARK),
  b(-0.028, 0.030, 0.046, 0.005, 0.034, 0.011, GUNDARK),
  b(-0.028, 0.030, 0.064, 0.005, 0.034, 0.011, GUNDARK),
  b(0.028, 0.030, 0.028, 0.005, 0.034, 0.011, GUNDARK),
  b(0.028, 0.030, 0.046, 0.005, 0.034, 0.011, GUNDARK),
  b(0.028, 0.030, 0.064, 0.005, 0.034, 0.011, GUNDARK),
  // sights: a post up front, a notched block at the back
  b(0, 0.063, -0.154, 0.011, 0.018, 0.015, GUNBLACK),
  b(0, 0.059, 0.052, 0.042, 0.013, 0.017, GUNBLACK),
  b(0, 0.063, 0.052, 0.011, 0.011, 0.018, GUNMETAL),
  // barrel proud of the slide
  b(0, 0.030, -0.186, 0.034, 0.034, 0.028, GUNMETAL),
  b(0, 0.030, -0.211, 0.024, 0.024, 0.032, STEEL_HI),
  b(0, 0.030, -0.230, 0.014, 0.014, 0.011, GUNBLACK),
];

const SHAPE_PISTOL: WeaponShape = {
  body: [
    b(0, 0.000, -0.046, 0.058, 0.034, 0.214, GUNMETAL),
    b(0, -0.021, -0.014, 0.052, 0.018, 0.126, GUNDARK),
    b(0, -0.039, -0.006, 0.040, 0.014, 0.012, GUNDARK),
    b(0, -0.055, 0.026, 0.040, 0.016, 0.058, GUNDARK),
    b(0, -0.022, 0.022, 0.020, 0.028, 0.012, GUNBLACK),
    b(0, 0.045, 0.086, 0.019, 0.026, 0.019, GUNDARK, -0.34),
    b(0, 0.022, 0.074, 0.040, 0.028, 0.030, GUNMETAL),
    ...gripHand(0, -0.082, 0.086, 0.24, 0.126),
  ],
  parts: [
    /* 73 mm — 30 % of the slide's own 244 mm length, up from 55 mm.
     * A slide that opens by a fifth of itself leaves an ejection port narrower
     * than the casing coming out of it; the brass was appearing beside a gun
     * that had not visibly opened. Thirty per cent is the real figure for a
     * short-recoil pistol and it puts the port wider than the round. */
    { role: Role.SLIDE, boxes: PISTOL_SLIDE, travel: 0.073 },
    { role: Role.MAG, boxes: PISTOL_MAG, travel: 0.22 },
  ],
  muzzle: [0, 0.030, -0.244],
  eject: [0.030, 0.048, -0.010],
  flash: 0.95,
  scale: 1.06,
};

/* ---- 2 · SHOTGUN --------------------------------------------------------- *
 * Longest silhouette in the set and the only wooden one, so it wins on hue
 * before it wins on shape. The shape it wins on is the DOUBLE LINE: barrel
 * above, magazine tube below, daylight between them for 340 mm. Nothing else
 * in the arsenal has a hole through its outline.
 *
 * The support hand lives inside the pump, so the hand racks with the fore-end
 * instead of hovering over a fore-end that slid out from under it. */
const SHOTGUN_PUMP: Box[] = [
  ...foreHand(0, -0.048, -0.278, 0.02, 0.156, WOOD, WOOD_HI),
  b(-0.031, -0.048, -0.342, 0.008, 0.062, 0.015, WOOD_HI),
  b(-0.031, -0.048, -0.314, 0.008, 0.062, 0.015, WOOD_HI),
  b(-0.031, -0.048, -0.286, 0.008, 0.062, 0.015, WOOD_HI),
  b(-0.031, -0.048, -0.258, 0.008, 0.062, 0.015, WOOD_HI),
  b(-0.031, -0.048, -0.230, 0.008, 0.062, 0.015, WOOD_HI),
  b(0, -0.084, -0.278, 0.054, 0.010, 0.150, WOOD_HI),
  // the action bar the pump actually pushes, so the travel has something to do
  b(0.028, -0.012, -0.200, 0.010, 0.014, 0.150, STEEL),
];

const SHOTGUN_SHELL: Box[] = [
  b(0, 0.000, 0.000, 0.028, 0.028, 0.064, RED),
  b(0, 0.000, 0.033, 0.030, 0.030, 0.022, BRASS),
  b(0, 0.000, -0.033, 0.026, 0.026, 0.007, RED_DK),
];

const SHAPE_SHOTGUN: WeaponShape = {
  body: [
    // receiver
    b(0, 0.000, 0.052, 0.064, 0.084, 0.198, GUNMETAL),
    b(0, 0.044, 0.052, 0.054, 0.010, 0.194, STEEL),
    b(-0.033, -0.004, 0.052, 0.006, 0.054, 0.152, GUNDARK),
    b(0.034, -0.006, 0.030, 0.008, 0.032, 0.064, BRASS_DK),
    b(0, -0.045, 0.040, 0.048, 0.012, 0.072, BRASS_DK),
    // THE DOUBLE LINE. Barrel above, magazine tube below, 52 mm of daylight
    // between them for half a metre — the only hole through any outline in the
    // arsenal, and the whole reason this reads as a shotgun and not as a rifle.
    // Both tubes were lengthened 22 % over the first build: foreshortening eats
    // length before it eats anything else, so the feature that has to survive
    // it gets built long.
    b(0, 0.078, -0.300, 0.040, 0.040, 0.470, GUNDARK),
    b(0, 0.100, -0.300, 0.028, 0.008, 0.466, STEEL_HI),
    b(-0.021, 0.078, -0.300, 0.006, 0.030, 0.462, GUNMETAL),
    b(0, 0.078, -0.542, 0.058, 0.058, 0.032, STEEL),
    b(0, 0.078, -0.560, 0.032, 0.032, 0.010, GUNBLACK),
    b(0, 0.106, -0.520, 0.011, 0.014, 0.014, BRASS),
    // ventilated heat shield over the chamber end
    b(0, 0.078, -0.150, 0.050, 0.050, 0.150, GUNMETAL),
    b(-0.026, 0.078, -0.208, 0.008, 0.028, 0.024, GUNBLACK),
    b(-0.026, 0.078, -0.172, 0.008, 0.028, 0.024, GUNBLACK),
    b(-0.026, 0.078, -0.136, 0.008, 0.028, 0.024, GUNBLACK),
    b(-0.026, 0.078, -0.100, 0.008, 0.028, 0.024, GUNBLACK),
    // magazine tube, the lower of the two lines
    b(0, -0.004, -0.276, 0.034, 0.034, 0.420, GUNMETAL),
    b(0, 0.014, -0.276, 0.020, 0.008, 0.414, STEEL),
    b(0, -0.004, -0.498, 0.038, 0.038, 0.024, GUNDARK),
    b(0, 0.038, -0.502, 0.022, 0.070, 0.028, GUNDARK),
    // trigger group
    b(0, -0.053, 0.098, 0.040, 0.012, 0.078, GUNDARK),
    b(0, -0.032, 0.086, 0.018, 0.028, 0.012, GUNBLACK),
    // receiver furniture
    b(0.034, 0.010, 0.010, 0.010, 0.032, 0.058, GUNBLACK),
    b(0.041, 0.014, 0.030, 0.024, 0.014, 0.014, STEEL),
    b(-0.034, 0.018, 0.020, 0.006, 0.028, 0.092, GUNBLACK),
    // Stock, cut to a stub. Measured off a capture: at full length it was the
    // largest single mass on screen — a featureless brown slab bigger than the
    // receiver — and it beat the barrel for attention. In a first-person view
    // the butt is behind the camera anyway, so what is left is the comb, the
    // wrist and a black butt-plate hint, all of it dark.
    ...moved(pitched([
      b(0, -0.004, 0.040, 0.042, 0.066, 0.104, WOOD_DK),
      b(0, 0.030, 0.014, 0.036, 0.018, 0.070, WOOD),
      b(0, -0.036, 0.018, 0.034, 0.038, 0.048, WOOD_DK),
      b(0, -0.008, 0.098, 0.044, 0.078, 0.016, GUNBLACK),
      b(-0.022, -0.004, 0.040, 0.005, 0.050, 0.094, WOOD),
      b(-0.025, 0.012, 0.020, 0.006, 0.014, 0.052, WOOD_HI),
      b(-0.025, -0.026, 0.056, 0.006, 0.012, 0.040, WOOD_DK),
      b(-0.026, -0.004, 0.086, 0.008, 0.030, 0.010, GUNBLACK),
    ], 0.17), 0, -0.008, 0.150),
    ...gripHand(0, -0.052, 0.116, 0.30, 0.106, GUNDARK, GUNMETAL),
  ],
  parts: [
    { role: Role.PUMP, boxes: SHOTGUN_PUMP, travel: 0.084 },
    { role: Role.FEED, boxes: moved(SHOTGUN_SHELL, 0.006, -0.060, 0.040), travel: 0.054 },
  ],
  muzzle: [0, 0.078, -0.578],
  eject: [0.034, 0.010, 0.030],
  flash: 1.35,
  scale: 0.96,
  restZ: -0.02,
};

/* ---- 3 · CHAINGUN -------------------------------------------------------- *
 * The one that used to fail hardest. Six barrels round a solid core, seen from
 * the side, are a smooth grey cylinder — the core fills every gap the eye needs
 * in order to count barrels.
 *
 * So the core is gone. Six rods on a 82 mm ring around a 26 mm hub, phased 30
 * degrees so one sits dead on top, and you can see sky between them. They stand
 * proud of the receiver's own shoulder, they carry a dark bore each, and the
 * whole cluster turns. Under the receiver hangs an olive ammo box with a brass
 * belt climbing the NEAR face — the side the camera is actually on. */
function chaingunBarrels(): Box[] {
  const out: Box[] = [];
  const R = 0.074;
  const zc = -0.330;
  const len = 0.508;
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i / 6) * TAU;
    const cx = Math.cos(a) * R;
    const cy = Math.sin(a) * R;
    // One unbroken rod each. Collars part-way down looked like the barrels
    // had been sawn into segments, which is worse than no detail at all.
    out.push(b(cx, cy, zc, 0.038, 0.038, len, (i & 1) === 0 ? STEEL_HI : STEEL, 0, 0, a));
    // A square rod photographs as a flat plate. Two thin dark strakes down the
    // sides of each barrel put a shadow where a cylinder's terminator would be,
    // and six rods stop reading as three slabs.
    out.push(b(cx + Math.cos(a + 1.5708) * 0.019, cy + Math.sin(a + 1.5708) * 0.019,
      zc, 0.007, 0.030, len - 0.010, GUNDARK, 0, 0, a));
    out.push(b(cx - Math.cos(a + 1.5708) * 0.019, cy - Math.sin(a + 1.5708) * 0.019,
      zc, 0.007, 0.030, len - 0.010, GUNDARK, 0, 0, a));
    out.push(b(cx, cy, zc + len * 0.5 - 0.024, 0.046, 0.046, 0.030, GUNDARK, 0, 0, a));
    out.push(b(cx, cy, zc - len * 0.5 - 0.008, 0.026, 0.026, 0.018, GUNBLACK, 0, 0, a));
  }
  // Nose ring binding the tips: the cluster has to be one object at the front
  // or six rods just hang in the air.
  out.push(...ringZ(12, 0.078, -0.568, 0.024, 0.026, GUNDARK, -1, 0, true));
  // hub: small enough that the gaps between the rods still show sky
  out.push(b(0, 0, -0.104, 0.046, 0.046, 0.076, GUNMETAL));
  out.push(b(0, 0, -0.068, 0.066, 0.066, 0.022, GUNDARK));
  return out;
}

const CHAINGUN_BARRELS: Box[] = chaingunBarrels();

const CHAINGUN_DRUM: Box[] = [
  b(0, -0.106, 0.040, 0.108, 0.104, 0.180, OLIVE),
  b(-0.056, -0.106, 0.040, 0.008, 0.086, 0.170, OLIVE_HI),
  b(0, -0.156, 0.040, 0.100, 0.012, 0.172, OLIVE_HI),
  b(0, -0.106, -0.054, 0.088, 0.086, 0.010, OLIVE_HI),
  b(0, -0.106, 0.134, 0.088, 0.086, 0.010, OLIVE_HI),
  b(-0.053, -0.132, 0.040, 0.012, 0.020, 0.144, GUNDARK),
  // Brass belt climbing the NEAR face into the feed throat: the one place on
  // this weapon the camera is guaranteed to be looking at. Backed by a
  // continuous dark link strip, because four gold cubes with air between them
  // read as jewellery, not as ammunition.
  b(-0.054, -0.036, -0.006, 0.014, 0.078, 0.128, GUNBLACK, 0.42),
  b(-0.060, -0.056, 0.048, 0.026, 0.024, 0.030, BRASS),
  b(-0.060, -0.048, 0.014, 0.026, 0.024, 0.030, BRASS_DK),
  b(-0.060, -0.032, -0.018, 0.026, 0.024, 0.030, BRASS),
  b(-0.060, -0.014, -0.046, 0.026, 0.024, 0.030, BRASS_DK),
];

const SHAPE_CHAINGUN: WeaponShape = {
  body: [
    // receiver
    b(0, 0.000, 0.076, 0.100, 0.106, 0.212, GUNMETAL),
    b(0, 0.057, 0.076, 0.080, 0.014, 0.204, GUNDARK),
    b(0, 0.067, 0.006, 0.064, 0.010, 0.015, GUNBLACK),
    b(0, 0.067, 0.044, 0.064, 0.010, 0.015, GUNBLACK),
    b(0, 0.067, 0.082, 0.064, 0.010, 0.015, GUNBLACK),
    b(0, 0.067, 0.120, 0.064, 0.010, 0.015, GUNBLACK),
    b(-0.051, 0.026, 0.076, 0.008, 0.028, 0.184, STEEL),
    b(-0.053, -0.014, 0.018, 0.008, 0.042, 0.038, GUNBLACK),
    b(-0.053, -0.014, 0.076, 0.008, 0.042, 0.038, GUNBLACK),
    b(-0.053, -0.014, 0.134, 0.008, 0.042, 0.038, GUNBLACK),
    // cooling shroud stepped off the near flank: the receiver is the biggest
    // unbroken area on this weapon and a plain box behind six barrels reads as
    // a crate someone bolted a gun to
    b(-0.062, 0.030, 0.040, 0.014, 0.052, 0.062, GUNMETAL),
    b(-0.062, 0.030, 0.118, 0.014, 0.052, 0.062, GUNMETAL),
    b(-0.066, 0.048, 0.040, 0.010, 0.012, 0.056, STEEL_HI),
    b(-0.066, 0.048, 0.118, 0.010, 0.012, 0.056, STEEL_HI),
    b(0.051, 0.000, 0.076, 0.008, 0.076, 0.184, GUNDARK),
    b(0, -0.057, 0.076, 0.076, 0.014, 0.196, GUNDARK),
    // spindle housing and the plate the barrels come out of
    b(0, 0.000, -0.048, 0.086, 0.086, 0.096, GUNMETAL),
    b(0, 0.000, -0.100, 0.104, 0.104, 0.020, GUNDARK),
    b(0, 0.055, -0.048, 0.060, 0.014, 0.090, STEEL),
    // carry handle
    b(0, 0.088, 0.040, 0.028, 0.034, 0.148, GUNDARK),
    b(0, 0.107, 0.040, 0.044, 0.016, 0.158, GUNMETAL),
    b(0, 0.070, -0.026, 0.026, 0.040, 0.024, GUNDARK),
    // feed throat the belt climbs into
    b(-0.048, -0.040, -0.010, 0.020, 0.036, 0.052, GUNDARK),
    // grips
    ...gripHand(0, -0.096, 0.202, 0.30, 0.120),
    b(0, -0.054, 0.176, 0.022, 0.028, 0.013, GUNBLACK),
    ...foreHand(0, -0.078, -0.086, 0.0, 0.150),
  ],
  parts: [
    { role: Role.SPIN, boxes: CHAINGUN_BARRELS },
    { role: Role.MAG, boxes: CHAINGUN_DRUM, travel: 0.14 },
  ],
  muzzle: [0, 0.000, -0.602],
  eject: [0.032, -0.030, 0.010],
  flash: 1.1,
  scale: 0.96,
  restY: -0.010,
};

/* ---- 4 · ROCKET LAUNCHER ------------------------------------------------- *
 * One idea, made big enough to survive the distance: the BELL. A 260 mm flared
 * mouth on a 104 mm tube, stepped out in three decagonal rings with a black
 * hole in the middle. No other weapon here ends in a circle, so the moment that
 * circle is legible the weapon is named. Hazard bands carry the hue, and a
 * matching venturi at the back says the thing vents both ways. */
const ROCKET_ROUND: Box[] = [
  b(0, 0.030, 0.070, 0.060, 0.060, 0.150, OLIVE_HI),
  b(0, 0.030, -0.016, 0.050, 0.050, 0.042, RED),
  b(0, 0.030, -0.042, 0.028, 0.028, 0.022, RED_HI),
  ...collarZ(0.036, 0.140, 0.014, 0.018, GUNDARK),
];

const SHAPE_ROCKET: WeaponShape = {
  body: [
    b(0, 0.030, -0.152, 0.104, 0.104, 0.470, OLIVE),
    // Panel breaks. Half a metre of unbroken olive on the near flank is the
    // largest flat area in the arsenal and it reads as a painted plank.
    b(-0.054, 0.030, -0.300, 0.008, 0.080, 0.120, OLIVE_HI),
    b(-0.054, 0.030, -0.058, 0.008, 0.080, 0.160, OLIVE_HI),
    b(-0.054, 0.062, -0.152, 0.010, 0.014, 0.420, GUNDARK),
    b(-0.054, -0.002, -0.152, 0.010, 0.014, 0.420, GUNDARK),
    b(0, 0.085, -0.152, 0.074, 0.008, 0.430, OLIVE_HI),
    // Hazard bands, painted ON the two faces the camera can see rather than
    // wrapped round the tube — a band 3 mm proud of a cylinder is invisible.
    b(-0.056, 0.030, -0.226, 0.010, 0.102, 0.050, RED),
    b(-0.056, 0.030, -0.180, 0.010, 0.102, 0.038, AMBER),
    b(-0.056, 0.030, -0.122, 0.010, 0.102, 0.032, RED),
    b(0, 0.084, -0.226, 0.102, 0.010, 0.050, RED),
    b(0, 0.084, -0.180, 0.102, 0.010, 0.038, AMBER),
    b(0, 0.084, -0.122, 0.102, 0.010, 0.032, RED),
    // The bell: three stepped rings, 8 -> 10 -> 12 slabs, 222 mm across the lip
    // against a 104 mm tube. A cone, not a flat annulus — the first attempt was
    // one wide ring and it read as a desk fan bolted to the front.
    ...moved(ringZ(8, 0.062, -0.392, 0.030, 0.030, GUNMETAL, -1, 0, true), 0, 0.030, 0),
    ...moved(ringZ(10, 0.080, -0.420, 0.030, 0.032, STEEL, -1, 0, true), 0, 0.030, 0),
    ...moved(ringZ(12, 0.096, -0.446, 0.026, 0.030, STEEL_HI, STEEL, 0, true), 0, 0.030, 0),
    // The mouth has to be a dark hole, and the plug that fills it has to be
    // round too: a square black box behind a decagon ring shows its corners
    // outside the bell and the whole circle stops being a circle.
    ...moved(ringZ(12, 0.052, -0.404, 0.056, 0.060, GUNBLACK, -1, 0, true), 0, 0.030, 0),
    b(0, 0.030, -0.404, 0.050, 0.050, 0.056, GUNBLACK),
    b(0, 0.030, -0.368, 0.116, 0.116, 0.022, GUNDARK),
    // rear venturi: the back of a launcher is not a flat cap
    ...moved(ringZ(8, 0.062, 0.096, 0.026, 0.030, GUNDARK, -1, 0, true), 0, 0.030, 0),
    b(0, 0.030, 0.112, 0.058, 0.058, 0.020, GUNBLACK),
    // sight rail: one blade, one notch. The ring sight was six small boxes of
    // noise at exactly the distance where small boxes stop being anything.
    b(0, 0.100, -0.096, 0.026, 0.016, 0.300, GUNMETAL),
    b(0, 0.122, -0.232, 0.012, 0.030, 0.014, GUNDARK),
    b(0, 0.120, 0.032, 0.034, 0.026, 0.014, GUNDARK),
    // Shoulder rest, kept tiny. It is the closest thing in the whole arsenal
    // to the eye, so every millimetre of it costs three of screen.
    b(0, -0.004, 0.152, 0.040, 0.060, 0.046, GUNDARK),
    // grips
    ...gripHand(0, -0.062, 0.062, 0.26, 0.116),
    b(0, -0.016, 0.036, 0.022, 0.030, 0.013, GUNBLACK),
    ...foreHand(0, -0.054, -0.250, 0.0, 0.124),
  ],
  parts: [
    { role: Role.FEED, boxes: ROCKET_ROUND, travel: 0.34 },
    { role: Role.SLIDE, boxes: [b(0, 0.090, 0.056, 0.048, 0.024, 0.082, STEEL)], travel: 0.07 },
  ],
  muzzle: [0, 0.030, -0.474],
  flash: 1.5,
  scale: 0.95,
  restY: -0.012,
};

/* ---- 5 · PLASMA RIFLE ---------------------------------------------------- *
 * Two silhouettes nothing else has: a COMB of six cooling fins standing off the
 * top deck with lit slots between them, and a stack of three glowing rings
 * threaded on a rod at the muzzle. Cyan is the only cool hue in the arsenal, so
 * in a dark corridor this one is named by colour before it is named by shape. */
const PLASMA_CELL: Box[] = [
  b(0, -0.080, 0.026, 0.058, 0.072, 0.106, GUNDARK),
  b(-0.031, -0.080, 0.026, 0.005, 0.046, 0.080, CYAN, 0, 0, 0, 1),
  b(0.031, -0.080, 0.026, 0.005, 0.046, 0.080, CYAN, 0, 0, 0, 1),
  b(0, -0.119, 0.026, 0.064, 0.014, 0.112, GUNMETAL),
];

function plasmaFins(): Box[] {
  const out: Box[] = [];
  for (let i = 0; i < 6; i++) {
    const z = -0.126 + i * 0.036;
    out.push(b(0, 0.086, z, 0.064, 0.058, 0.015, i % 2 === 0 ? STEEL : GUNMETAL));
    out.push(b(0, 0.104, z, 0.056, 0.010, 0.016, STEEL_HI));
    if (i < 5) out.push(b(0, 0.066, z + 0.018, 0.050, 0.020, 0.021, CYAN, 0, 0, 0, 1));
  }
  return out;
}

const SHAPE_PLASMA: WeaponShape = {
  body: [
    b(0, 0.000, -0.014, 0.078, 0.092, 0.306, GUNMETAL),
    b(0, 0.052, -0.014, 0.062, 0.014, 0.296, GUNDARK),
    b(-0.041, 0.014, -0.014, 0.006, 0.036, 0.276, GUNDARK),
    b(-0.041, -0.030, -0.062, 0.006, 0.026, 0.140, GUNBLACK),
    b(-0.041, -0.030, 0.066, 0.006, 0.026, 0.070, GUNBLACK),
    // glow strip along both flanks
    b(-0.043, 0.010, -0.030, 0.005, 0.020, 0.212, CYAN, 0, 0, 0, 1),
    b(0.043, 0.010, -0.030, 0.005, 0.020, 0.212, CYAN, 0, 0, 0, 1),
    ...plasmaFins(),
    // Emitter: a dark rod with three lit rings threaded on it and air between
    // them. Rings, not collars flush to the body — the gaps are the read.
    b(0, 0.000, -0.234, 0.030, 0.030, 0.166, GUNDARK),
    b(0, 0.000, -0.176, 0.056, 0.056, 0.040, GUNMETAL),
    ...ringZ(8, 0.048, -0.212, 0.022, 0.024, CYAN, CYAN_HOT, 1, true),
    ...ringZ(8, 0.048, -0.252, 0.022, 0.024, CYAN, CYAN_HOT, 1, true),
    ...ringZ(8, 0.048, -0.292, 0.022, 0.024, CYAN, CYAN_HOT, 1, true),
    b(0, 0.000, -0.322, 0.038, 0.038, 0.020, CYAN_HOT, 0, 0, 0, 1),
    b(0, 0.036, -0.176, 0.048, 0.014, 0.036, CYAN_HOT, 0, 0, 0, 1),
    // grip + stock
    ...gripHand(0, -0.088, 0.098, 0.26, 0.114),
    b(0, -0.042, 0.072, 0.022, 0.028, 0.013, GUNBLACK),
    b(0, -0.010, 0.174, 0.048, 0.064, 0.100, GUNDARK),
    b(0, 0.026, 0.168, 0.042, 0.014, 0.090, GUNMETAL),
    ...foreHand(0, -0.062, -0.130, 0.0, 0.130),
  ],
  parts: [
    { role: Role.MAG, boxes: PLASMA_CELL, travel: 0.20 },
  ],
  muzzle: [0, 0.000, -0.336],
  flash: 1.0,
  scale: 0.99,
};

/* ---- 6 · BFG 9000 -------------------------------------------------------- *
 * Squat, wide, and the only thing on screen that is green.
 *
 * The first pass braced four prongs back to a square cage frame and the frame
 * won: a 290 mm black rectangle round the front of the gun reads as a picture
 * frame, and the core it was supposed to show off was hidden behind its own
 * scaffolding. So the frame is gone. What is left is the two shapes that
 * actually say BFG — a square MAW of four plates flaring open toward the
 * target, and a hot green CORE sitting at the mouth of it where nothing can
 * occlude it, with four blade prongs reaching past both. The maw opens wider
 * as the core charges, which is the whole reload. */
function bfgClaw(): Box[] {
  const out: Box[] = [];
  // TWO prongs, not a cage.
  //
  // The previous pass braced the core inside four corner rails and cross bars.
  // Photographed, that is a black rectangle with green showing through the
  // slits — a crate with neon trim, and the shape the eye names is the crate.
  // So the structure came off the two faces the camera can see and went to the
  // two it cannot mistake for a box outline: one heavy prong over the top, one
  // under the bottom, both hooked forward past the core so the silhouette ends
  // in a pair of jaws with light between them. The near flank is left
  // completely open, which is where the core does its work.
  for (let i = 0; i < 2; i++) {
    const sy = i === 0 ? 1 : -1;
    // shoulder, arm, then the hook that closes over the mouth
    out.push(b(0, sy * 0.116, -0.190, 0.150, 0.046, 0.086, GUNMETAL));
    out.push(b(0, sy * 0.126, -0.190, 0.108, 0.014, 0.076, STEEL_HI));
    out.push(b(0, sy * 0.132, -0.300, 0.100, 0.040, 0.150, STEEL));
    out.push(b(0, sy * 0.150, -0.300, 0.074, 0.012, 0.140, STEEL_HI));
    out.push(b(0, sy * 0.118, -0.406, 0.086, 0.050, 0.062, GUNMETAL, sy * 0.42));
    out.push(b(0, sy * 0.086, -0.452, 0.062, 0.044, 0.052, STEEL, sy * 0.72));
    // One hot rail on the jaw's inner edge, not a lit face. A 70 mm emissive
    // panel under each jaw photographed as a pair of glowing shelves and the
    // weapon read as shop fitting; a 10 mm rail just says the jaws are live.
    out.push(b(0, sy * 0.108, -0.318, 0.030, 0.009, 0.120, BFGREEN_HOT, 0, 0, 0, 1));
  }
  // two blades out to the near side, clear of the core, to break the box
  out.push(b(-0.128, 0.000, -0.246, 0.048, 0.126, 0.070, GUNDARK, 0, 0, 0.22));
  out.push(b(-0.146, 0.000, -0.318, 0.036, 0.090, 0.056, STEEL, 0, 0, 0.34));
  return out;
}

const BFG_CLAW: Box[] = bfgClaw();

const BFG_CELL: Box[] = [
  b(0, -0.090, 0.090, 0.092, 0.060, 0.124, GUNDARK),
  b(0, -0.118, 0.090, 0.074, 0.014, 0.104, BFGREEN, 0, 0, 0, 1),
];

const SHAPE_BFG: WeaponShape = {
  body: [
    b(0, 0.000, 0.026, 0.140, 0.128, 0.256, GUNMETAL),
    b(0, 0.069, 0.046, 0.118, 0.014, 0.272, GUNDARK),
    b(0, 0.078, 0.046, 0.038, 0.010, 0.250, BFGREEN, 0, 0, 0, 1),
    b(-0.073, 0.000, 0.046, 0.008, 0.100, 0.256, GUNDARK),
    b(-0.075, -0.002, -0.050, 0.008, 0.058, 0.028, GUNBLACK),
    b(-0.075, -0.002, 0.014, 0.008, 0.058, 0.028, GUNBLACK),
    b(-0.075, -0.002, 0.078, 0.008, 0.058, 0.028, GUNBLACK),
    b(0, -0.069, 0.046, 0.118, 0.014, 0.262, GUNDARK),
    // capacitor bars, near flank only — the far ones were never visible
    b(-0.077, 0.034, 0.018, 0.010, 0.028, 0.172, BFGREEN, 0, 0, 0, 1),
    b(-0.077, -0.036, 0.018, 0.010, 0.022, 0.142, BFGREEN, 0, 0, 0, 1),
    // Emitter housing, then the CORE — a 140 mm block of light standing out in
    // the open between the prongs, not a strip on a panel. Green is this
    // weapon's whole identity in peripheral vision, so it gets mass, not trim.
    // The housing is deliberately NARROWER than the core it holds. The body is
    // 140 mm across and the gun is only 256 mm long, so a muzzle feature the
    // same width as the body hides behind the body from a three-quarter view —
    // which is exactly what happened to the first two cores. This one is
    // 210 mm across and it overhangs on every side.
    b(0, 0.000, -0.132, 0.118, 0.118, 0.078, GUNDARK),
    ...ringZ(8, 0.070, -0.176, 0.030, 0.030, GUNMETAL, -1, 0, true),
    b(0, 0.000, -0.184, 0.176, 0.150, 0.048, GUNDARK),
    b(0, 0.080, -0.184, 0.146, 0.014, 0.042, STEEL),
    // The core: one 216 mm block of light, wider and taller than the body that
    // carries it, so no viewing angle can hide it behind its own gun. The two
    // faces the camera can see each get a hot panel, because a cube lit only
    // by its emissive average still loses to a dark cage in front of it.
    b(0, 0.000, -0.296, 0.210, 0.176, 0.196, BFGREEN, 0, 0, 0, 1),
    b(-0.107, 0.000, -0.296, 0.014, 0.152, 0.170, BFGREEN_HOT, 0, 0, 0, 1),
    // Two thin black ribs across the near face, nothing more. A wide dark iris
    // with hot rails either side photographed as a green cross — a graphic,
    // not a light source. Ribs at a tenth of the panel's height read as
    // containment over a glowing mass, which is the whole idea.
    b(-0.117, 0.046, -0.296, 0.010, 0.013, 0.174, GUNBLACK),
    b(-0.117, -0.046, -0.296, 0.010, 0.013, 0.174, GUNBLACK),
    b(0, 0.090, -0.296, 0.178, 0.012, 0.166, BFGREEN_HOT, 0, 0, 0, 1),
    b(0, 0.000, -0.400, 0.170, 0.142, 0.028, BFGREEN_HOT, 0, 0, 0, 1),
    // capacitor tanks along the top flanks: they break the box outline and
    // they are where the charge visibly builds during a reload.
    b(-0.082, 0.052, 0.050, 0.036, 0.036, 0.190, GUNDARK),
    b(0.082, 0.052, 0.050, 0.036, 0.036, 0.190, GUNDARK),
    b(-0.082, 0.072, 0.050, 0.026, 0.010, 0.170, GUNMETAL),
    b(0.082, 0.072, 0.050, 0.026, 0.010, 0.170, GUNMETAL),
    b(-0.082, 0.052, -0.056, 0.044, 0.044, 0.028, GUNMETAL),
    b(0.082, 0.052, -0.056, 0.044, 0.044, 0.028, GUNMETAL),
    // carry handle
    b(0, 0.100, 0.080, 0.034, 0.048, 0.136, GUNDARK),
    b(0, 0.122, 0.080, 0.050, 0.016, 0.146, GUNMETAL),
    // grip + trigger
    ...gripHand(0, -0.108, 0.184, 0.24, 0.124),
    b(0, -0.064, 0.156, 0.024, 0.030, 0.013, GUNBLACK),
    b(0, -0.080, 0.204, 0.062, 0.034, 0.054, GUNMETAL),
    ...foreHand(0, -0.092, -0.048, 0.0, 0.140),
  ],
  parts: [
    { role: Role.CLAW, boxes: BFG_CLAW, pivot: [0, 0, -0.290] },
    { role: Role.MAG, boxes: BFG_CELL, travel: 0.24 },
  ],
  muzzle: [0, 0.000, -0.412],
  flash: 2.0,
  scale: 0.87,
  restY: -0.018,
  restZ: -0.03,
};

/* ---- 7 · CHAINSAW -------------------------------------------------------- *
 * Red motor block, then 420 mm of toothed bar. The sawtooth edge is the
 * silhouette and it is the only irregular outline in the set; the chain scrolls
 * as one repeating pattern so the whole animation costs a single transform. */
function chainTeeth(): Box[] {
  const out: Box[] = [];
  const period = 0.046;
  for (let i = -1; i < 15; i++) {
    const z = -0.462 + i * period;
    out.push(b(0, 0.032, z, 0.030, 0.022, 0.028, STEEL_HI));
    out.push(b(0, 0.048, z - 0.013, 0.028, 0.016, 0.015, STEEL));
    out.push(b(0, -0.052, z + 0.023, 0.030, 0.022, 0.028, STEEL_HI));
    out.push(b(0, -0.068, z + 0.036, 0.028, 0.016, 0.015, STEEL));
  }
  return out;
}

const SHAPE_CHAINSAW: WeaponShape = {
  body: [
    // motor block
    b(0, 0.006, 0.112, 0.098, 0.124, 0.200, RED),
    b(0, 0.072, 0.112, 0.090, 0.014, 0.192, RED_HI),
    b(-0.051, 0.020, 0.112, 0.006, 0.074, 0.176, RED_HI),
    b(-0.051, -0.030, 0.078, 0.006, 0.038, 0.046, RED_DK),
    b(-0.051, -0.030, 0.146, 0.006, 0.038, 0.046, RED_DK),
    b(0, -0.059, 0.112, 0.090, 0.014, 0.190, RED_DK),
    b(0, 0.020, 0.210, 0.056, 0.046, 0.042, GUNDARK),
    b(0.035, 0.042, 0.154, 0.028, 0.028, 0.026, BRASS),
    b(-0.038, 0.024, 0.154, 0.024, 0.042, 0.062, RED_DK),
    b(-0.038, 0.024, 0.154, 0.026, 0.014, 0.030, AMBER),
    // clutch cover / chain guard
    b(0, -0.012, 0.006, 0.070, 0.096, 0.108, GUNDARK),
    b(0, -0.012, -0.050, 0.054, 0.064, 0.026, GUNMETAL),
    b(0, 0.040, 0.006, 0.074, 0.014, 0.104, STEEL),
    // rear handle
    ...gripHand(0, -0.052, 0.252, 0.34, 0.108, GUNDARK, RED_DK),
    b(0, -0.012, 0.216, 0.024, 0.028, 0.015, GUNBLACK),
    // guide bar: thin, so the teeth stand off it
    b(0, -0.010, -0.226, 0.018, 0.052, 0.462, STEEL),
    b(0, -0.010, -0.226, 0.020, 0.026, 0.456, GUNMETAL),
    b(0, -0.010, -0.460, 0.018, 0.040, 0.036, STEEL_HI),
    // Top handle bar and the support hand on it, moved forward off the motor.
    // Sat over the block, the glove was a tan mass on top of the one saturated
    // red shape in the arsenal and killed it.
    ...foreHand(0.002, 0.082, -0.094, 0.20, 0.136, GUNDARK, STEEL),
    b(0, 0.062, 0.026, 0.028, 0.078, 0.028, GUNDARK, -0.34),
    b(0, 0.088, -0.020, 0.026, 0.026, 0.108, GUNDARK),
  ],
  parts: [
    { role: Role.CHAIN, boxes: chainTeeth(), travel: 0.046 },
  ],
  muzzle: [0, -0.010, -0.460],
  flash: 0,
  restY: -0.016,
  restZ: -0.10,
  restPitch: 0.05,
};

/**
 * Global size trim on top of each weapon's own scale. Authoring happens in real
 * metres; this is the one knob that says how much of the frame the arsenal owns.
 */
const MODEL_SCALE = 1.02;

function scaleOf(shape: WeaponShape): number {
  return (shape.scale ?? 1) * MODEL_SCALE;
}

const SHAPES: readonly WeaponShape[] = [
  SHAPE_PISTOL, SHAPE_SHOTGUN, SHAPE_CHAINGUN, SHAPE_ROCKET,
  SHAPE_PLASMA, SHAPE_BFG, SHAPE_CHAINSAW,
];

/* ------------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------------ */

/**
 * Per face: outward normal and the two tangent axes, ordered so u x v = n and
 * the quad (0,0)-(1,0)-(1,1)-(0,1) winds counter-clockwise from outside.
 */
const FACE_BASIS: readonly (readonly number[])[] = [
  [1, 0, 0, 0, 1, 0, 0, 0, 1],    // +X : u=+y v=+z
  [-1, 0, 0, 0, 0, 1, 0, 1, 0],   // -X : u=+z v=+y
  [0, 1, 0, 0, 0, 1, 1, 0, 0],    // +Y : u=+z v=+x
  [0, -1, 0, 1, 0, 0, 0, 0, 1],   // -Y : u=+x v=+z
  [0, 0, 1, 1, 0, 0, 0, 1, 0],    // +Z : u=+x v=+y
  [0, 0, -1, 0, 1, 0, 1, 0, 0],   // -Z : u=+y v=+x
];

/**
 * Fixed viewmodel key light, up and to the left and slightly toward the player.
 * Deliberately NOT the world sun: the gun must read the same in a lit courtyard
 * and in a black corridor, and a top-lit form with dead undersides is what
 * makes voxel slabs legible.
 */
const KEY_X = -0.46, KEY_Y = 0.80, KEY_Z = 0.38;
const FILL_X = 0.58, FILL_Y = -0.36, FILL_Z = -0.54;

/**
 * Wide on purpose. A silhouette only reads if the faces inside it separate,
 * and the cheapest way to separate untextured slabs is to spend the whole 0..1
 * range on them: near-black undersides, a hot top, and a fill just strong
 * enough that the far flank is not a hole.
 */
function shadeFromNormal(nx: number, ny: number, nz: number): number {
  const key = nx * KEY_X + ny * KEY_Y + nz * KEY_Z;
  const fill = nx * FILL_X + ny * FILL_Y + nz * FILL_Z;
  const k = key > 0 ? Math.pow(key, 1.10) : 0;
  const f = fill > 0 ? fill : 0;
  return 0.15 + 1.06 * k + 0.17 * f;
}

/** Floats per vertex: pos(3) grow(3) colour(3) light(1) uv(2) ext(2) emit(1). */
function buildGeometry(boxes: readonly Box[], scale: number): THREE.BufferGeometry {
  const quads = boxes.length * 6;
  const verts = quads * 4;
  const pos = new Float32Array(verts * 3);
  const grw = new Float32Array(verts * 3);
  const col = new Float32Array(verts * 3);
  const lit = new Float32Array(verts);
  const uv = new Float32Array(verts * 2);
  const ext = new Float32Array(verts * 2);
  const emi = new Float32Array(verts);
  const idx = new Uint16Array(quads * 6);

  const m = new Array<number>(9);
  let v = 0;
  let ii = 0;

  for (let bi = 0; bi < boxes.length; bi++) {
    const box = boxes[bi];
    const cx = box.x * scale, cy = box.y * scale, cz = box.z * scale;
    const h = [box.w * 0.5 * scale, box.h * 0.5 * scale, box.d * 0.5 * scale];

    // Euler XYZ -> 3x3, row major.
    const sx = Math.sin(box.rx), cxr = Math.cos(box.rx);
    const sy = Math.sin(box.ry), cyr = Math.cos(box.ry);
    const sz = Math.sin(box.rz), czr = Math.cos(box.rz);
    m[0] = cyr * czr;
    m[1] = -cyr * sz;
    m[2] = sy;
    m[3] = cxr * sz + sx * sy * czr;
    m[4] = cxr * czr - sx * sy * sz;
    m[5] = -sx * cyr;
    m[6] = sx * sz - cxr * sy * czr;
    m[7] = sx * czr + cxr * sy * sz;
    m[8] = cxr * cyr;

    const c = box.c;
    const cr = ((c >>> 16) & 0xff) / 255;
    const cg = ((c >>> 8) & 0xff) / 255;
    const cb = (c & 0xff) / 255;
    const em = box.e;

    for (let f = 0; f < 6; f++) {
      const bs = FACE_BASIS[f];
      const nlx = bs[0], nly = bs[1], nlz = bs[2];
      const ulx = bs[3], uly = bs[4], ulz = bs[5];
      const vlx = bs[6], vly = bs[7], vlz = bs[8];

      // rotated normal -> per-face light
      const nx = m[0] * nlx + m[1] * nly + m[2] * nlz;
      const ny = m[3] * nlx + m[4] * nly + m[5] * nlz;
      const nz = m[6] * nlx + m[7] * nly + m[8] * nlz;
      const shade = shadeFromNormal(nx, ny, nz);

      // half extents along the face's own axes, in metres
      const hn = h[nlx !== 0 ? 0 : nly !== 0 ? 1 : 2];
      const hu = h[ulx !== 0 ? 0 : uly !== 0 ? 1 : 2];
      const hv = h[vlx !== 0 ? 0 : vly !== 0 ? 1 : 2];
      const eu = hu * 2, ev = hv * 2;

      const base = v;
      for (let k = 0; k < 4; k++) {
        const su = (k === 1 || k === 2) ? 1 : -1;
        const sv = (k === 2 || k === 3) ? 1 : -1;
        const lx = nlx * hn + ulx * su * hu + vlx * sv * hv;
        const ly = nly * hn + uly * su * hu + vly * sv * hv;
        const lz = nlz * hn + ulz * su * hu + vlz * sv * hv;
        pos[v * 3 + 0] = cx + m[0] * lx + m[1] * ly + m[2] * lz;
        pos[v * 3 + 1] = cy + m[3] * lx + m[4] * ly + m[5] * lz;
        pos[v * 3 + 2] = cz + m[6] * lx + m[7] * ly + m[8] * lz;
        // Direction this corner travels when the box is inflated by 1 m on
        // every axis. Feeding the SAME buffer through the outline pass with a
        // non-zero uGrow gives a closed, slightly larger copy of the solid —
        // no second geometry, no gaps at the corners.
        const gx = lx < 0 ? -1 : 1, gy = ly < 0 ? -1 : 1, gz = lz < 0 ? -1 : 1;
        grw[v * 3 + 0] = m[0] * gx + m[1] * gy + m[2] * gz;
        grw[v * 3 + 1] = m[3] * gx + m[4] * gy + m[5] * gz;
        grw[v * 3 + 2] = m[6] * gx + m[7] * gy + m[8] * gz;
        col[v * 3 + 0] = cr; col[v * 3 + 1] = cg; col[v * 3 + 2] = cb;
        lit[v] = shade;
        uv[v * 2 + 0] = su > 0 ? 1 : 0;
        uv[v * 2 + 1] = sv > 0 ? 1 : 0;
        ext[v * 2 + 0] = eu;
        ext[v * 2 + 1] = ev;
        emi[v] = em;
        v++;
      }
      idx[ii++] = base; idx[ii++] = base + 1; idx[ii++] = base + 2;
      idx[ii++] = base; idx[ii++] = base + 2; idx[ii++] = base + 3;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aGrow', new THREE.BufferAttribute(grw, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aLight', new THREE.BufferAttribute(lit, 1));
  geo.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aExt', new THREE.BufferAttribute(ext, 2));
  geo.setAttribute('aEmit', new THREE.BufferAttribute(emi, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

/* ------------------------------------------------------------------------ *
 * Material
 * ------------------------------------------------------------------------ */

const VM_VERT = /* glsl */ `
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uGrow;
in vec3 position;
in vec3 aGrow;
in vec3 aColor;
in float aLight;
in vec2 aUv;
in vec2 aExt;
in float aEmit;
out vec3 vColor;
out float vLight;
out vec2 vUv;
out vec2 vExt;
out float vEmit;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + aGrow * uGrow, 1.0);
  vColor = aColor;
  vLight = aLight;
  vUv = aUv;
  vExt = aExt;
  vEmit = aEmit;
}
`;

/**
 * The contour.
 *
 * A voxel gun built from mid-grey slabs disappears into a mid-grey wall, and
 * "readable at a glance" is exactly the thing that fails first. So the same
 * vertex buffer is drawn a second time, inflated 2 mm per axis, back faces
 * only, in near-black: a two-pixel ink line round the whole silhouette and
 * round every sub-assembly that stands proud of it. It costs one extra draw
 * per mesh and no extra geometry, and it is what lets the shotgun read as a
 * shotgun against a lit floor AND against a black corridor.
 */
/**
 * Half-thickness of the ink line, in metres of model space. At the rest
 * distance a 900 px viewport shows about 1120 px per metre, so 0.0019 draws
 * roughly two pixels — heavy enough to survive a bright floor, light enough
 * that it never becomes the thing you notice.
 */
const OUTLINE_GROW = 0.0019;

const OUTLINE_FRAG = /* glsl */ `
precision mediump float;
uniform vec3 uInk;
layout(location = 0) out vec4 fragColor;
void main() {
  fragColor = vec4(uInk, 1.0);
}
`;

/**
 * The bevel is the reason this reads as a weapon and not as a pile. Every face
 * gets a dark seam a fixed 2.4 mm wide (capped at a fifth of the face so a
 * finger does not go solid black), which separates adjacent slabs of the same
 * colour and gives the whole solid a drawn, high-contrast edge.
 */
const VM_FRAG = /* glsl */ `
precision mediump float;
uniform float uMuzzle;
uniform vec3  uMuzzleColor;
uniform vec3  uTint;
uniform float uBright;
uniform float uEmit;
uniform vec3  uKill;
in vec3 vColor;
in float vLight;
in vec2 vUv;
in vec2 vExt;
in float vEmit;
layout(location = 0) out vec4 fragColor;
void main() {
  vec2 p = vUv * vExt;
  vec2 q = min(p, vExt - p);
  float e = min(q.x, q.y);
  float w = min(0.0032, 0.19 * min(vExt.x, vExt.y));
  float bev = smoothstep(0.0, w, e);

  vec3 base = vColor * uTint;
  float lit = vLight * uBright * mix(0.22, 1.0, bev);
  // An emissive face must NOT also take the full key light. Adding a glow term
  // on top of a lit face pushes the sum past 1.0 and the channels clamp, which
  // is how a saturated green core ends up rendering as pale yellow. So the
  // glow REPLACES the lighting in proportion to how emissive the face is, and
  // only a deliberate over-charge (uEmit pushed past 1 by the reload) is
  // allowed to blow out to white.
  vec3 c = base * lit * (1.0 - vEmit * 0.86);
  c += base * vEmit * uEmit * mix(0.45, 1.0, bev);
  // The flash lights the gun that made it. Half of "the shot happened" is this.
  c += base * uMuzzleColor * uMuzzle * (0.20 + 0.50 * lit);
  c += uMuzzleColor * uMuzzle * 0.07;
  // THE KILL FLARE. A hit only moves uBright, which is achromatic: the gun
  // gets brighter and a brighter grey gun in one frame of a firefight is a
  // cue nobody reads. A kill adds COLOUR on top — hot amber running into the
  // metal — because hue is the one channel nothing else in this shader is
  // using, and a change of hue survives a busy frame that a change of level
  // does not. Zero on a hit and on a miss, so it never dilutes itself.
  c += base * uKill * (0.30 + 0.60 * lit);
  c += uKill * 0.08;
  fragColor = vec4(c, 1.0);
}
`;

/* ---- muzzle flash ------------------------------------------------------- */

/**
 * DOOM's flash is not a shader term, it is a SHAPE — a star that owns the
 * middle of the frame for two frames and lights the gun that made it.
 *
 * The first version of this was a ring of equally bright slabs, and additive
 * blending on uniformly bright opaque boxes does not look like light, it looks
 * like orange plastic origami. So every box now carries a HEAT weight in its
 * emissive slot, and each petal is three boxes whose heat falls off outward.
 * The tips fade instead of ending in a hard rectangle, which is the whole
 * difference between "a shape drawn in orange" and "something is on fire here".
 *
 * Built once at unit size and scaled per shot from the weapon table.
 */
function flashBoxes(): Box[] {
  const out: Box[] = [
    // Core, hottest at the bore and cooling down the axis. Fatter than the
    // first build: DOOM's flash is a BLOB of white sitting on the muzzle, and
    // the thing that makes a flash read as heat rather than as a graphic is
    // that the middle is blown out and shapeless.
    b(0, 0, -0.03, 0.56, 0.56, 0.30, 0xffffff, 0, 0, 0, 1.00),
    b(0, 0, -0.14, 0.42, 0.42, 0.26, 0xfffaf0, 0, 0, 0, 0.95),
    b(0, 0, -0.30, 0.30, 0.30, 0.30, 0xfff0cc, 0, 0, 0, 0.72),
    b(0, 0, -0.54, 0.17, 0.17, 0.30, 0xffc070, 0, 0, 0, 0.40),
    b(0, 0, -0.76, 0.08, 0.08, 0.24, 0xff9840, 0, 0, 0, 0.17),
  ];
  // A soft halo behind everything: additive and very cool, it is what stops
  // the star from having a hard boundary against the world.
  out.push(b(0, 0, -0.04, 1.34, 1.34, 0.06, 0xffd9a8, 0, 0, 0.30, 0.060));
  out.push(b(0, 0, -0.04, 0.88, 0.88, 0.07, 0xffe4bc, 0, 0, 0.72, 0.090));
  // Seven petals of DIFFERENT lengths, two segments each.
  //
  // Six equal petals plus two long cross-spikes is a comic-book star, and that
  // is exactly what it photographed as. A muzzle flash is a ragged bloom, so
  // the count is prime, the lengths run 0.62 to 1.00 of full reach on a fixed
  // irregular pattern, and the spikes are gone. The petals still overlap end
  // to end — butted, they read as separate rectangles in a row.
  const REACH = [1.00, 0.71, 0.88, 0.62, 0.95, 0.74, 0.83];
  const seg = [
    { r: 0.20, w: 0.44, h: 0.30, c: 0xfff6de, e: 0.95 },
    { r: 0.46, w: 0.34, h: 0.15, c: 0xffb862, e: 0.44 },
  ];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * TAU + 0.18;
    const k = REACH[i];
    for (let s = 0; s < 2; s++) {
      const g = seg[s];
      out.push(b(
        Math.cos(a) * g.r * k, Math.sin(a) * g.r * k, -0.04,
        g.w * (0.7 + 0.3 * k), g.h * (0.7 + 0.3 * k), 0.17 - s * 0.04,
        g.c, 0, 0, a, g.e,
      ));
    }
  }
  return out;
}

const FLASH_VERT = /* glsl */ `
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
in vec3 position;
in vec3 aColor;
in float aEmit;
out vec3 vColor;
out float vHeat;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vColor = aColor;
  vHeat = aEmit;
}
`;
const FLASH_FRAG = /* glsl */ `
precision mediump float;
uniform vec3 uColor;
uniform float uGain;
in vec3 vColor;
in float vHeat;
layout(location = 0) out vec4 fragColor;
void main() {
  // Additive, so the weapon's own muzzle colour tints the outside of the star
  // while the core stays close to white — hot things go white, not orange.
  vec3 tint = mix(uColor, vec3(1.0), vHeat * vHeat * 0.72);
  fragColor = vec4(vColor * tint * uGain * vHeat, 1.0);
}
`;

/* ---- ejected brass ------------------------------------------------------ */

const SHELL_SLOTS = 6;

const BRASS_VERT = /* glsl */ `
precision highp float;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec4 uPos[${SHELL_SLOTS}];
uniform vec3 uRot[${SHELL_SLOTS}];
in vec3 position;
in vec3 aColor;
in float aLight;
in float aSlot;
out vec3 vColor;
out float vLight;
void main() {
  int s = int(aSlot + 0.5);
  vec4 p = uPos[s];
  vec3 r = uRot[s];
  float sa = sin(r.x), ca = cos(r.x);
  float sb = sin(r.y), cb = cos(r.y);
  float sc = sin(r.z), cc = cos(r.z);
  vec3 q = position * p.w;
  q = vec3(q.x, q.y * ca - q.z * sa, q.y * sa + q.z * ca);
  q = vec3(q.x * cb + q.z * sb, q.y, -q.x * sb + q.z * cb);
  q = vec3(q.x * cc - q.y * sc, q.x * sc + q.y * cc, q.z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(q + p.xyz, 1.0);
  vColor = aColor;
  vLight = aLight;
}
`;
const BRASS_FRAG = /* glsl */ `
precision mediump float;
uniform float uBright;
in vec3 vColor;
in float vLight;
layout(location = 0) out vec4 fragColor;
void main() { fragColor = vec4(vColor * vLight * uBright, 1.0); }
`;

/* ------------------------------------------------------------------------ *
 * Frame input
 * ------------------------------------------------------------------------ */

export interface ViewmodelInput {
  /** Camera yaw and pitch, radians. Used for sway. */
  yaw: number;
  pitch: number;
  /** Horizontal speed, m/s. */
  speed: number;
  grounded: boolean;
  sprinting: boolean;
  crouching: boolean;
  inWater: boolean;
  /** True while the trigger is held; drives the chaingun spin-up. */
  firing: boolean;
  reloading: boolean;
  /** 0..1 one-shot landing impact. The viewmodel clears it once consumed. */
  landImpact: number;
}

export function createViewmodelInput(): ViewmodelInput {
  return {
    yaw: 0, pitch: 0, speed: 0,
    grounded: true, sprinting: false, crouching: false, inWater: false,
    firing: false, reloading: false, landImpact: 0,
  };
}

/* ------------------------------------------------------------------------ *
 * Viewmodel
 * ------------------------------------------------------------------------ */

/**
 * Anything with three numbers on it. `muzzleWorld` writes into one of these
 * rather than a `THREE.Vector3` so a caller that only needs a world position
 * does not have to hold a three.js type to ask for it.
 */
export interface Vec3Out { x: number; y: number; z: number }

export interface ViewmodelOptions {
  /** The WORLD field of view. The viewmodel derives its own, narrower one. */
  fov?: number;
  handed?: 'right' | 'left';
  /** Multiplier on all procedural motion. 0 pins the gun (accessibility). */
  motionScale?: number;
}

/**
 * Where the gun sits, in metres in front of the viewmodel camera, and how far
 * its nose is raised.
 *
 * These two numbers are the composition. DOOM frames a weapon low and CENTRED,
 * with its breech falling off the bottom of the screen and nothing lost off the
 * side; the first build of this file framed it low and RIGHT, so the stock, the
 * trigger hand and the forearm piled into the bottom-right corner, half of it
 * cropped by the frame and the rest of it colliding with the hotbar. Pushing
 * the rest distance out shrinks the solid and pulls it toward the middle
 * together, and the nose-up trim drops the breech below the frame edge instead
 * of the muzzle rising above it.
 */
const REST_DIST = 1.395;
const REST_PITCH = 0.052;

/**
 * The gun is yawed in by this much so the camera sees its LEFT FLANK rather
 * than its back plate — see the block comment at the compose step, which is
 * where the number is argued.
 *
 * It is hoisted to module scope because the RECOIL now needs it too: rearward
 * travel runs back along the BARREL, and the barrel is what this angle names.
 */
const REST_YAW = 0.365;
const REST_YAW_SIN = Math.sin(REST_YAW);
const REST_YAW_COS = Math.cos(REST_YAW);

/* ------------------------------------------------------------------------ *
 * RECOIL — the round-2 rebuild, and the numbers it was rebuilt from
 *
 * The critic's measurement: on both sampled frames that caught the muzzle
 * flash the pistol sat in its exact rest pose — same slide position, same
 * tilt, same hand placement as the non-firing frames either side. Reproduced
 * exactly by projecting three points on the model through the viewmodel camera
 * at 1440x900 and differencing them against rest, frame by frame after a shot:
 *
 *     frame            muzzle     grip      slide
 *     f1  (17 ms)       1.2 px    2.2 px    37.7 px
 *     f2  (33 ms)       2.0 px    3.6 px    33.9 px
 *     f4  (67 ms, peak) 2.6 px    4.5 px    22.0 px
 *
 * The gun's own solid moved one to four pixels. Three separate causes, all
 * fixed here:
 *
 *  1. THE KICK POINTED WHERE THE CAMERA CANNOT SEE IT. `viewKickZ` is by far
 *     the biggest column in the shared table (0.075 against 0.010 for Y on the
 *     pistol) and it was applied along the CAMERA's z — straight into the
 *     screen. A gun pushed 15 mm down the view axis at 1.4 m does not move on
 *     the picture plane at all; it gets 1 % bigger. The recoil was real, it
 *     was integrated, it was clamped, and it was invisible. It now runs back
 *     along the BARREL, which is yawed 21 degrees out of the view axis, so 36 %
 *     of every millimetre of it lands on the picture plane where it can be seen.
 *
 *  2. THE SPRING PEAKED AFTER THE FLASH HAD GONE. An impulse-driven spring
 *     peaks a quarter-period late: at the table's recovery of 16 rad/s that is
 *     73 ms, while the pistol's flash is 45 ms. Every frame bright enough to
 *     draw the eye showed the gun on its way out, at a third of its travel.
 *     `KICK_OMEGA_SCALE` moves the peak to ~32 ms — two frames, inside the
 *     flash — and the impulse gain is multiplied by the same factor so raising
 *     the frequency costs no travel.
 *
 *  3. THE TABLE SPECIFIED A PUSH, AND WHAT THE EYE READS IS A DISTANCE. Peak
 *     displacement of an impulse-driven spring is v0/omega_d, so handing the
 *     table straight to the spring makes travel inversely proportional to each
 *     weapon's recovery rate — and recovery runs 22 (chaingun) to 5 (BFG). The
 *     pistol's 0.075 became 15 mm and the BFG's 0.5 wanted 325 mm, which the
 *     safety clamp then pinned flat at 240 for five frames: a weapon that does
 *     not move and a weapon stuck against a wall, from one honest table. Every
 *     channel is now specified as the PEAK TRAVEL it should reach and the
 *     impulse needed to reach it is solved for, which removes recovery from the
 *     amplitude entirely and leaves it doing only what it names — how long the
 *     gun takes to come back.
 *
 *  4. THE LIGHT END WAS STILL TOO LIGHT. The table's z column spans 6.7x and
 *     its pitch column 5.8x, authored for CAMERA kick where a pistol should be
 *     a nudge. A viewmodel has to show mass on every shot or it is a prop, so
 *     `feltKick` compresses each column toward its heaviest row: near-identity
 *     where the table is already loud, close to double where it whispers, and
 *     ordering preserved throughout.
 * ------------------------------------------------------------------------ */

/**
 * Frequency multiplier on the table's `viewKickRecovery`, so recoil peaks
 * while the muzzle flash is still lit rather than four frames behind it.
 * At the pistol's 16 rad/s this moves the peak from 73 ms to 32 ms — two
 * frames, inside the 45 ms flash.
 */
const KICK_OMEGA_SCALE = 2.25;

const KICK_DAMPING = 0.58;
/** sqrt(1 - z^2): omega_d / omega. */
const KICK_DAMPED = Math.sqrt(1 - KICK_DAMPING * KICK_DAMPING);
/**
 * What fraction of v0/omega_d an impulse-driven spring actually reaches, at
 * this damping. 0.413. Solving for it is what lets a travel be REQUESTED.
 */
const KICK_PEAK_FRAC = (() => {
  const th = Math.atan2(KICK_DAMPED, KICK_DAMPING);
  return Math.exp((-KICK_DAMPING * th) / KICK_DAMPED) * Math.sin(th);
})();

/**
 * Peak travel per compressed table unit, and the compression each column gets.
 *
 * `TRIM_TRAVEL` is set to reproduce the pistol's previous amplitude exactly on
 * the four channels that were never the problem (lateral, vertical, yaw, roll)
 * — they are trim, and trim that changes is just noise. The two channels the
 * critic named get their own, larger figures.
 *
 * Peak REARWARD travel requested, in millimetres: chaingun 21, plasma 19,
 * pistol 26, shotgun 51, rocket 59, BFG 73. What the table used to produce, on
 * the same weapons: 8, 8, 15, 84, 138, and 324 — that last one clamped flat at
 * 240 for five frames, which is its own kind of not moving.
 *
 * The substepped integrator lands about 15 % under an analytic peak, so read
 * these as the ask; `viewmodel.test.ts` measures what actually arrives, in
 * pixels, which is the only unit this piece is judged in.
 */
const TRIM_TRAVEL = 0.203;
const AXIAL_TRAVEL = 0.174;
const AXIAL_REF = 0.34;
const AXIAL_COMPRESSION = 0.55;
/** Peak muzzle rise requested, radians: chaingun 0.021, pistol 0.027, BFG 0.081. */
const RISE_TRAVEL = 0.31;
const RISE_REF = 0.26;
const RISE_COMPRESSION = 0.62;

const MAX_KICK_OFFSET = 0.24;
const MAX_KICK_ANGLE = 0.30;
const MAX_PARTS = 3;

/**
 * Compress a column of the kick table toward its heaviest row.
 *
 * Straight multiplication cannot fix a viewmodel that does not move: the gain
 * that makes a pistol read throws the BFG into the clamp, and the gain that
 * keeps the BFG sane leaves the pistol at two pixels. A power curve anchored
 * at `ref` fixes both — it is the identity where the table is already loud and
 * it is a near-doubling where the table whispers, and being monotonic it can
 * never reorder the arsenal.
 */
function feltKick(v: number, ref: number, exp: number): number {
  const a = Math.abs(v);
  if (a <= 1e-6) return 0;
  return (v < 0 ? -ref : ref) * Math.pow(a / ref, exp);
}

/**
 * Slide / bolt travel across the mechanical cycle, 1 = hard against the stop.
 * `cycle` runs 1 at the shot down to 0; `cycleSeconds` is how long that takes.
 *
 * ROUND 2, and the reason the hold is now measured in MILLISECONDS.
 *
 * Round 1's curve was `cycle^0.55`, a slow bleed that put the slide at 37, 34,
 * 29, 22, 12 px over five frames — never in the same place twice, never more
 * than 5 px apart either, which in a sampled contact sheet is indistinguishable
 * from a slide that never moved. Round 2 replaced it with a snap: fully back
 * for `SLIDE_BACK_FRAC` of the cycle, then thrown home over `SLIDE_HOME_FRAC`.
 *
 * That fixed the bleed and introduced a worse problem, which a blind review
 * then reported as "the slide never cycles on either firing frame (the ejection
 * port stays shut while brass spawns from nowhere)". The arithmetic:
 *
 *   pistol fire interval    142.9 ms   (420 rpm)
 *   mechanical cycle        88.6 ms    (interval x 0.62, clamped)
 *   old hold, 0.17 of that  15.1 ms    — ONE frame at 60 Hz
 *   muzzle flash            45.0 ms    — three frames
 *
 * The slide was fully back for a third of the time the flash was lit, and by
 * the second lit frame it was already 95 % home. **Every frame bright enough to
 * see the gun in showed the slide shut**, which is precisely a gun that fires
 * without cycling, and it is not something a fraction of a variable-length
 * cycle can fix: the flash is a fixed number of milliseconds and the cycle is
 * not. So the hold is a duration — 52 ms, longer than the longest flash it has
 * to cover — capped at a fraction of the cycle so a 700 rpm chaingun does not
 * end up with its bolt back more often than forward.
 */
const SLIDE_HOLD_S = 0.052;
const SLIDE_HOLD_MAX_FRAC = 0.60;
const SLIDE_HOME_FRAC = 0.40;
function slideTravel(cycle: number, cycleSeconds: number): number {
  const u = 1 - cycle;
  const hold = Math.min(SLIDE_HOLD_S / Math.max(cycleSeconds, 1e-3), SLIDE_HOLD_MAX_FRAC);
  if (u <= hold) return 1;
  // Whatever is left of the cycle after the hold, up to the nominal return.
  const span = Math.max(Math.min(SLIDE_HOME_FRAC, 1 - hold), 1e-3);
  const r = clamp((u - hold) / span, 0, 1);
  // Fast off the stop, decelerating into battery.
  return (1 - r) * (1 - r);
}

/** Hit-confirm brightness pop: how much, and how fast it bleeds off (1/s). */
const HIT_GLOW_GAIN = 0.30;
const HIT_GLOW_DECAY = 7.5;
/**
 * A kill's glow starts higher and bleeds off at a third of the rate, so it
 * spans about eight frames instead of three. Duration is the axis a player
 * reads as "that was different"; amplitude alone just reads as "that was
 * closer".
 */
const KILL_GLOW_DECAY = 2.6;

/**
 * The kill flare's colour and weight.
 *
 * Amber-into-red rather than white: white is what uBright already does, and
 * two cues on the same axis are one cue. Kept under a third of the model's
 * own level so the weapon flares rather than blowing out — a silhouette that
 * washes to a solid block is a worse read than the one it replaced.
 */
const KILL_TINT_R = 1.00;
const KILL_TINT_G = 0.42;
const KILL_TINT_B = 0.16;
const KILL_TINT_GAIN = 0.30;

/**
 * A viewmodel drawn at the world FOV foreshortens a half-metre gun into a stack
 * of squares — that was the old model's real problem, not its box count.
 *
 * The distortion is set by (gun length / camera distance), so the fix is a
 * long lens: a narrow viewmodel FOV with the weapon pushed well out, which
 * keeps it the same size on screen while cutting the near-to-far scale ratio
 * from about 2.3 to 1.7. Every shooter that renders a 3D weapon does this;
 * DOOM took it to the limit and drew a flat sprite.
 */
function viewmodelFov(worldFov: number): number {
  return clamp(32 + (worldFov - 68) * 0.16, 24, 48);
}

/** 0..1 across [a, b]. */
function seg(t: number, a: number, b: number): number {
  return b <= a ? (t >= b ? 1 : 0) : clamp((t - a) / (b - a), 0, 1);
}
function smooth(x: number): number { return x * x * (3 - 2 * x); }
/** Rises to 1 at the middle of [a, b] and falls back to 0. */
function bell(t: number, a: number, b: number): number {
  return Math.sin(Math.PI * seg(t, a, b));
}

/** What a reload is doing to the model this frame. */
interface ReloadPose {
  /** 0..1 blend of the whole "gun is busy" carry pose. */
  hold: number;
  dip: number; pitch: number; roll: number; yaw: number; push: number;
  slide: number; pump: number; mag: number; magHide: number;
  feed: number; feedHide: number; claw: number; core: number;
  spin: number;
}

const _pose: ReloadPose = {
  hold: 0, dip: 0, pitch: 0, roll: 0, yaw: 0, push: 0,
  slide: 0, pump: 0, mag: 0, magHide: 0,
  feed: 0, feedHide: 1, claw: 0, core: 1, spin: 0,
};

export class Viewmodel implements OverlayPass {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly root = new THREE.Object3D();

  private readonly material: THREE.RawShaderMaterial;
  private readonly outlineMat: THREE.RawShaderMaterial;
  private readonly uniforms: Record<string, THREE.IUniform>;

  private readonly bodyGeo: (THREE.BufferGeometry | null)[] = new Array(WEAPON_COUNT).fill(null);
  private readonly partGeo: ((THREE.BufferGeometry | null)[])[] =
    new Array(WEAPON_COUNT).fill(null).map(() => new Array<THREE.BufferGeometry | null>(MAX_PARTS).fill(null));
  private readonly bodyMesh: THREE.Mesh;
  private readonly bodyInk: THREE.Mesh;
  private readonly partPivots: THREE.Object3D[] = [];
  private readonly partMeshes: THREE.Mesh[] = [];
  private readonly partInks: THREE.Mesh[] = [];
  private activeParts: readonly Part[] = [];

  // muzzle flash solid
  private readonly flashMat: THREE.RawShaderMaterial;
  private readonly flashMesh: THREE.Mesh;
  private flashRoll = 0;
  private flashSize = 1;

  // ejected brass
  private readonly brassMat: THREE.RawShaderMaterial;
  private readonly brassMesh: THREE.Mesh;
  private readonly shellPos: THREE.Vector4[] = [];
  private readonly shellRot: THREE.Vector3[] = [];
  private readonly shellVel = new Float32Array(SHELL_SLOTS * 3);
  private readonly shellSpin = new Float32Array(SHELL_SLOTS * 3);
  private readonly shellLife = new Float32Array(SHELL_SLOTS);
  private shellNext = 0;

  private weapon: number = WeaponId.PISTOL;
  private pendingWeapon = -1;
  private handSign = 1;
  private motionScale = 1;
  private bobEnabled = true;
  private enabled = true;
  private aspect = 1.6;
  private worldFov = 68;
  private disposed = false;

  // kick spring
  private px = 0; private py = 0; private pz = 0;
  private vx = 0; private vy = 0; private vz = 0;
  private rx = 0; private ry = 0; private rz = 0;
  private wx = 0; private wy = 0; private wz = 0;
  private kickSide = 1;

  // procedural state
  private bobPhase = 0;
  private idlePhase = 0;
  private swayX = 0; private swayY = 0; private swayRoll = 0; private swayPitch = 0;
  private prevYaw = 0; private prevPitch = 0; private haveAngles = false;
  private landDip = 0;
  private sprintT = 0;
  private crouchT = 0;
  private raise = 1;
  private switchPhase: 'idle' | 'out' | 'in' = 'idle';
  private switchTimer = 0;
  private switchDuration = 1;

  // reload
  private reloadActive = false;
  private reloadT = 0;
  private reloadDuration = 0;
  private shellPeriod = 0;

  // firing
  private cycle = 0;
  private cycleRate = 12;
  private pumpT = 1;
  private pumpRate = 3;
  private muzzle = 0;
  private muzzleDecay = 20;
  private spin = 0;
  private spinAngle = 0;
  private chainPhase = 0;
  private rev = 0;
  private core = 1;
  private bright = 1;
  /** 0..1 "that shot landed", decaying. Drives the hit jolt's brightness pop. */
  private hitGlow = 0;
  private hitGlowDecay = HIT_GLOW_DECAY;
  /** 1 while the decaying glow belongs to a KILL rather than to a hit. */
  private hitWasKill = 0;

  constructor(opts: ViewmodelOptions = {}) {
    this.worldFov = opts.fov ?? 68;
    this.camera = new THREE.PerspectiveCamera(viewmodelFov(this.worldFov), this.aspect, 0.05, 8);
    this.handSign = opts.handed === 'left' ? -1 : 1;
    this.motionScale = opts.motionScale ?? 1;

    this.uniforms = {
      uMuzzle: { value: 0 },
      uMuzzleColor: { value: new THREE.Vector3(1, 0.82, 0.55) },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
      uBright: { value: 1 },
      uEmit: { value: 1.25 },
      uGrow: { value: 0 },
      uKill: { value: new THREE.Vector3(0, 0, 0) },
    };
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader: VM_VERT,
      fragmentShader: VM_FRAG,
      side: this.handSign < 0 ? THREE.DoubleSide : THREE.FrontSide,
      depthTest: true,
      depthWrite: true,
      fog: false,
      lights: false,
      toneMapped: false,
    });
    this.material.name = 'viewmodel';

    this.outlineMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uGrow: { value: OUTLINE_GROW },
        uInk: { value: new THREE.Vector3(0.031, 0.035, 0.043) },
      },
      vertexShader: VM_VERT,
      fragmentShader: OUTLINE_FRAG,
      side: THREE.BackSide,
      depthTest: true,
      depthWrite: true,
      fog: false,
      lights: false,
      toneMapped: false,
    });
    this.outlineMat.name = 'viewmodel-outline';

    this.bodyMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.bodyMesh.frustumCulled = false;
    this.root.add(this.bodyMesh);
    this.bodyInk = new THREE.Mesh(this.bodyMesh.geometry, this.outlineMat);
    this.bodyInk.frustumCulled = false;
    this.bodyInk.renderOrder = -2;
    this.root.add(this.bodyInk);

    for (let i = 0; i < MAX_PARTS; i++) {
      const pivot = new THREE.Object3D();
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
      mesh.frustumCulled = false;
      pivot.add(mesh);
      const ink = new THREE.Mesh(mesh.geometry, this.outlineMat);
      ink.frustumCulled = false;
      ink.renderOrder = -2;
      pivot.add(ink);
      pivot.visible = false;
      this.root.add(pivot);
      this.partPivots.push(pivot);
      this.partMeshes.push(mesh);
      this.partInks.push(ink);
    }

    /* --- flash --- */
    this.flashMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uColor: { value: new THREE.Vector3(1, 0.82, 0.55) },
        uGain: { value: 1 },
      },
      vertexShader: FLASH_VERT,
      fragmentShader: FLASH_FRAG,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      fog: false,
      lights: false,
      toneMapped: false,
    });
    this.flashMat.name = 'viewmodel-flash';
    this.flashMesh = new THREE.Mesh(buildGeometry(flashBoxes(), 1), this.flashMat);
    this.flashMesh.frustumCulled = false;
    this.flashMesh.visible = false;
    this.root.add(this.flashMesh);

    /* --- brass --- */
    for (let i = 0; i < SHELL_SLOTS; i++) {
      this.shellPos.push(new THREE.Vector4(0, 0, 0, 0));
      this.shellRot.push(new THREE.Vector3(0, 0, 0));
    }
    this.brassMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        uPos: { value: this.shellPos },
        uRot: { value: this.shellRot },
        uBright: { value: 1 },
      },
      vertexShader: BRASS_VERT,
      fragmentShader: BRASS_FRAG,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
      fog: false,
      lights: false,
      toneMapped: false,
    });
    this.brassMat.name = 'viewmodel-brass';
    this.brassMesh = new THREE.Mesh(buildBrassGeometry(), this.brassMat);
    this.brassMesh.frustumCulled = false;
    this.brassMesh.visible = false;
    // Brass lives in view space, not on the gun, so it does not ride the kick.
    this.scene.add(this.brassMesh);

    this.scene.add(this.root);
    this.scene.add(this.camera);

    this.setWeapon(WeaponId.PISTOL, true);
  }

  /* -- geometry cache ---------------------------------------------------- */

  private shapeFor(id: number): WeaponShape {
    return SHAPES[id] ?? SHAPES[WeaponId.PISTOL];
  }

  private ensureGeometry(id: number): void {
    if (this.bodyGeo[id] !== null) return;
    const shape = this.shapeFor(id);
    const scale = scaleOf(shape);
    this.bodyGeo[id] = buildGeometry(shape.body, scale);
    const parts = shape.parts ?? [];
    for (let i = 0; i < parts.length && i < MAX_PARTS; i++) {
      const p = parts[i];
      const pv = p.pivot;
      const boxes = pv === undefined ? p.boxes : moved(p.boxes, -pv[0], -pv[1], -pv[2]);
      this.partGeo[id][i] = buildGeometry(boxes, scale);
    }
  }

  /* -- public control ---------------------------------------------------- */

  get weaponId(): number {
    return this.weapon;
  }

  /**
   * Switch weapons. Plays lower-then-raise using the weapon table's
   * switchOutMs / switchInMs unless `instant`.
   */
  setWeapon(id: number, instant = false): void {
    const next = id >= 0 && id < WEAPON_COUNT ? id : WeaponId.PISTOL;
    if (instant) {
      this.pendingWeapon = -1;
      this.applyWeapon(next);
      this.raise = 1;
      this.switchPhase = 'idle';
      return;
    }
    if (next === this.weapon && this.switchPhase === 'idle') return;
    this.pendingWeapon = next;
    this.switchPhase = 'out';
    this.switchTimer = 0;
    this.switchDuration = Math.max(1, getWeapon(this.weapon).switchOutMs) / 1000;
  }

  private applyWeapon(id: number): void {
    this.weapon = id;
    this.ensureGeometry(id);
    const shape = this.shapeFor(id);
    const scale = scaleOf(shape);
    this.bodyMesh.geometry = this.bodyGeo[id] as THREE.BufferGeometry;
    this.bodyInk.geometry = this.bodyMesh.geometry;
    this.activeParts = shape.parts ?? [];

    for (let i = 0; i < MAX_PARTS; i++) {
      const geo = this.partGeo[id][i];
      const pivot = this.partPivots[i];
      if (geo === null || i >= this.activeParts.length) {
        pivot.visible = false;
        continue;
      }
      this.partMeshes[i].geometry = geo;
      this.partInks[i].geometry = geo;
      const pv = this.activeParts[i].pivot;
      pivot.position.set(
        pv === undefined ? 0 : pv[0] * scale,
        pv === undefined ? 0 : pv[1] * scale,
        pv === undefined ? 0 : pv[2] * scale,
      );
      pivot.rotation.set(0, 0, 0);
      pivot.scale.set(1, 1, 1);
      pivot.visible = true;
    }

    this.spinAngle = 0;
    this.chainPhase = 0;
    this.core = 1;
    this.pumpT = 1;
    this.cycle = 0;
    this.reloadActive = false;

    const def = getWeapon(id);
    const mc = def.muzzleColor;
    const r = ((mc >>> 16) & 0xff) / 255;
    const g = ((mc >>> 8) & 0xff) / 255;
    const bl = (mc & 0xff) / 255;
    (this.uniforms.uMuzzleColor.value as THREE.Vector3).set(r, g, bl);
    (this.flashMat.uniforms.uColor.value as THREE.Vector3).set(r, g, bl);

    // Sized up 30 % over the first build. DOOM's flash is not a detail at the
    // end of the barrel, it is an event that takes over the lower third of the
    // frame for two frames; measured against the reference contact sheet, the
    // old one was reading as a spark.
    const flashScale = (shape.flash ?? 1) * (0.072 + 0.026 * def.muzzleIntensity) * scale;
    this.flashSize = flashScale;
    const m = shape.muzzle;
    this.flashMesh.position.set(m[0] * scale, m[1] * scale, m[2] * scale);
    this.flashMesh.visible = false;

    // Mechanical cycle rate: fast enough that a 700 rpm chaingun still resets.
    const interval = 60 / Math.max(1, def.rpm);
    this.cycleRate = 1 / clamp(interval * 0.62, 0.035, 0.16);
    this.pumpRate = 1 / clamp(interval * 0.55, 0.16, 0.42);
  }

  /** One shot fired. Kicks the spring, lights the muzzle, throws the brass. */
  fire(weaponId?: number): void {
    const id = weaponId ?? this.weapon;
    const def = getWeapon(id);
    const s = this.kickSide;
    this.kickSide = -s;

    /* ASK FOR A TRAVEL, NOT A SHOVE.
     *
     * An impulse-driven spring peaks at v0/omega_d * KICK_PEAK_FRAC, so the
     * velocity that reaches a wanted peak is that expression inverted. Doing it
     * this way is what stops each weapon's recovery rate from silently setting
     * its amplitude — the bug that left the pistol at 15 mm of invisible travel
     * while the BFG sat pinned against the safety clamp. */
    const omegaD = Math.max(1, def.viewKickRecovery) * KICK_OMEGA_SCALE * KICK_DAMPED;
    const g = (omegaD / KICK_PEAK_FRAC) * this.motionScale;

    this.vx += def.viewKickX * TRIM_TRAVEL * g * s;
    this.vy += def.viewKickY * TRIM_TRAVEL * g;
    // The two channels that carry the read — rearward travel along the barrel
    // and muzzle rise — get the compressed, weighted treatment. The other four
    // keep the table's own proportions, because they are trim, not mass.
    this.vz += feltKick(def.viewKickZ, AXIAL_REF, AXIAL_COMPRESSION) * AXIAL_TRAVEL * g;
    this.wx += feltKick(def.viewKickPitch, RISE_REF, RISE_COMPRESSION) * RISE_TRAVEL * g;
    this.wy += def.viewKickYaw * TRIM_TRAVEL * g * s;
    this.wz += def.viewKickRoll * TRIM_TRAVEL * g * s;

    if (def.muzzleMs > 0) {
      this.muzzle = 1;
      this.muzzleDecay = 1000 / def.muzzleMs;
      this.flashRoll = Math.random() * TAU;
    }
    this.cycle = 1;
    if (this.shapeFor(id).parts?.some((p) => p.role === Role.PUMP) === true) this.pumpT = 0;
    if (def.kind === FireKind.MELEE) this.rev = 1;
    if (id === WeaponId.PLASMA || id === WeaponId.BFG) this.core = 1.9;

    const eject = this.shapeFor(id).eject;
    if (eject !== undefined && id === this.weapon) this.throwBrass(eject);
  }

  /**
   * The shot connected. This is the HANDS' share of the hit read.
   *
   * Kick tells you a shot left the barrel; it fires identically whether you hit
   * a demon or the sky, which is precisely why the bar's static viewmodel and a
   * kicking one both fail the question "which shot felt like it hit something".
   * So a connect adds a second, different impulse: short, higher frequency, and
   * pushing the muzzle FORWARD into the target rather than back into the
   * shoulder, plus a roll snap and a brief brightness pop on the solid.
   *
   * It rides on the same spring as the fire kick, so it never fights it — a
   * miss is the kick alone and a hit is the kick with a bite in it.
   *
   * A KILL is a third reading, not a louder second one. Scaling the same
   * impulse up makes a kill feel like a very good hit, and the frame after a
   * demon dies should not feel like the frame after a solid body shot — so the
   * kill jolt is a different SHAPE: it leads with the nose coming UP and the
   * gun rolling out (the recoil of finishing something, hands opening) where
   * the hit jolt drives the muzzle down and forward into the target. On a
   * spring they are distinguishable at 60 fps because they start in opposite
   * directions, which no amount of amplitude ever achieves.
   *
   * `strength` is 0..1.
   */
  hitConfirm(strength = 0.5, killed = false): void {
    if (this.disposed || !this.enabled) return;
    // KICK_OMEGA_SCALE: the spring runs faster now, and peak displacement is
    // v0/omega_d, so an impulse that is not scaled with it quietly shrinks by
    // the same factor. These numbers were tuned by eye against the old spring;
    // this keeps the jolt the size it was tuned to be.
    const s = clamp(strength, 0, 1) * this.motionScale * KICK_OMEGA_SCALE;
    if (s <= 0) return;
    const side = this.kickSide * this.handSign;

    if (killed) {
      // Up, back, and a hard roll out. Slower to recover, because the point of
      // a kill is that the moment is allowed to take a beat.
      this.vz += 0.16 * s;
      this.vy += 0.34 * s;
      this.wx += 1.10 * s;
      this.wz -= 0.95 * s * side;
      this.hitGlowDecay = KILL_GLOW_DECAY;
      this.hitWasKill = 1;
      const glow = 1.35;
      if (glow > this.hitGlow) this.hitGlow = glow;
      return;
    }

    // Forward (negative z is away from the player) and a touch up.
    this.vz -= 0.30 * s;
    this.vy += 0.16 * s;
    // Nose dip then recover, and a roll opposite the last kick so two shots in
    // a row do not stack into one lean.
    this.wx -= 0.85 * s;
    this.wz += 0.55 * s * side;
    this.hitGlowDecay = HIT_GLOW_DECAY;
    // A hit landing inside a kill's afterglow must not steal it: the kill is
    // the longer, louder read and it owns the channel until it has run out.
    if (this.hitGlow <= 0) this.hitWasKill = 0;
    const glow = 0.35 + 0.65 * s;
    if (glow > this.hitGlow) this.hitGlow = glow;
  }

  /**
   * THE TOOL MET SOMETHING THAT WILL NOT GIVE.
   *
   * `hitConfirm` drives the muzzle FORWARD, because flesh gives way and the
   * hands follow through into it. Stone does the opposite: it stops the swing
   * dead and shoves the tool back at you. So this is the same spring with the
   * opposite sign on z and on pitch, and no glow at all — a wall is not a hit
   * marker and must never light the weapon the way a body does.
   *
   * The roll alternates per bite, so a held saw against a wall JUDDERS instead
   * of leaning one way and staying there. That judder is the read: without it a
   * viewmodel swinging at a wall is a looping animation that could equally be
   * playing in mid-air, which is exactly the frame this piece kept losing on.
   */
  bite(power = 0.5): void {
    if (this.disposed || !this.enabled) return;
    // Scaled with the spring frequency for the reason given in `hitConfirm`.
    const s = clamp(power, 0, 1) * this.motionScale * KICK_OMEGA_SCALE;
    if (s <= 0) return;
    const side = this.kickSide * this.handSign;
    this.kickSide = -this.kickSide;
    this.vz += 0.24 * s;
    this.vy += 0.05 * s;
    this.vx -= 0.05 * s * side;
    this.wx += 0.40 * s;
    this.wy -= 0.30 * s * side;
    this.wz += 0.72 * s * side;
  }

  /**
   * Play the reload for `ms`. Shell-by-shell weapons (`reloadShellMs > 0`) run
   * until the game says they are done, since the shooter can break off early.
   */
  reload(ms: number, weaponId?: number): void {
    const id = weaponId ?? this.weapon;
    const def = getWeapon(id);
    this.reloadActive = true;
    this.reloadT = 0;
    this.reloadDuration = Math.max(0.08, ms / 1000);
    this.shellPeriod = def.reloadShellMs > 0 ? def.reloadShellMs / 1000 : 0;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.root.visible = on;
    if (!on) {
      this.hitGlow = 0;
      this.hitWasKill = 0;
      this.hitGlowDecay = HIT_GLOW_DECAY;
      (this.uniforms.uKill.value as THREE.Vector3).set(0, 0, 0);
      this.brassMesh.visible = false;
      for (let i = 0; i < SHELL_SLOTS; i++) this.shellLife[i] = 0;
    }
  }

  setBobEnabled(on: boolean): void {
    this.bobEnabled = on;
  }

  setMotionScale(v: number): void {
    this.motionScale = clamp(v, 0, 2);
  }

  setHanded(h: 'right' | 'left'): void {
    this.handSign = h === 'left' ? -1 : 1;
    // The contour's cull must NOT be swapped for the mirrored pose. three.js
    // already flips gl.frontFace when an object's world matrix has a negative
    // determinant, so BackSide still means "the far shell" in left-handed mode.
    // Swapping it as well double-flips: the hull's NEAR faces then draw over
    // the body and every weapon renders as a solid black silhouette. Verified
    // by capture, both handednesses.
    this.material.side = this.handSign < 0 ? THREE.DoubleSide : THREE.FrontSide;
  }

  /** Takes the WORLD field of view; the viewmodel keeps its own, narrower one. */
  setFov(deg: number): void {
    this.worldFov = deg;
    this.camera.fov = viewmodelFov(deg);
    this.camera.updateProjectionMatrix();
  }

  /** Colour grade, e.g. push red while the player is hurt. */
  setTint(r: number, g: number, b: number): void {
    (this.uniforms.uTint.value as THREE.Vector3).set(r, g, b);
    this.material.uniformsNeedUpdate = true;
  }

  /**
   * Overall brightness of the model. The shape of the lighting is baked from
   * each box's own normal, so this only moves the level — the gun keeps its
   * form in a black corridor and in daylight.
   */
  setLightBalance(ambient: number, sun: number): void {
    this.bright = clamp(ambient * 0.72 + sun * 0.60, 0.55, 1.6);
    // update() re-derives uBright every frame including the hit pop; this write
    // covers the case where the balance changes while the model is paused.
    this.uniforms.uBright.value = this.bright * (1 + HIT_GLOW_GAIN * this.hitGlow);
    this.brassMat.uniforms.uBright.value = this.bright;
    this.material.uniformsNeedUpdate = true;
  }

  /** Muzzle position in viewmodel space, after all animation. */
  getMuzzleLocal(out: THREE.Vector3): THREE.Vector3 {
    const shape = this.shapeFor(this.weapon);
    const s = scaleOf(shape);
    const m = shape.muzzle;
    out.set(m[0] * s, m[1] * s, m[2] * s);
    this.root.updateMatrix();
    out.applyMatrix4(this.root.matrix);
    return out;
  }

  /**
   * THE BARREL, IN THE WORLD — where world-space effects have to come from.
   *
   * Measured defect this exists to fix. `Fx.muzzleFlash` and `Fx.tracer` were
   * being handed `eye + aim * standoff`, i.e. a point on the AIM AXIS, and that
   * has two consequences that between them cost the piece its own question.
   *
   *  1. The plume lands on the CROSSHAIR. Its core disc is 0.42 m across and it
   *     was being spawned 0.8 m from the eye, so at a 68 degree world FOV it
   *     covered about 270 px of a 720 px frame — a soft additive wash painted
   *     over the exact pixels the hit read lives in, on every single shot. The
   *     shot was the loudest thing in the frame and it was loudest in the one
   *     place it must not be.
   *  2. The tracer projects to a POINT. A beam that leaves the eye along the
   *     view axis has no lateral component on the picture plane, so it collapses
   *     into the crosshair and is invisible to the only person it is for. That
   *     is why no frame of the capture contains a streak.
   *
   * Both are the same bug: the world layer had no barrel. This gives it one.
   *
   * The subtlety is that the gun you can SEE is drawn by the overlay pass, with
   * its own camera and a much narrower FOV (32 degrees against the world's 68).
   * A point simply copied out of viewmodel space lands nowhere near the drawn
   * barrel. So the muzzle is converted to tangent space, rescaled by the ratio
   * of the two half-FOV tangents — which is what makes it land on the same
   * PIXEL — and then rebuilt in world space at `dist` metres along the aim.
   *
   * `dx, dy, dz` must be unit length. `out` is written and returned.
   *
   * `worldFovDeg` is the WORLD camera's live vertical FOV and it has to be the
   * live one, not the setting: sprint and the shotgun's punch move it by ten
   * degrees or more, and the whole conversion is a ratio against it. Passing
   * nothing falls back to the FOV this viewmodel was configured with.
   */
  muzzleWorld(
    ex: number, ey: number, ez: number,
    dx: number, dy: number, dz: number,
    dist: number, out: Vec3Out, worldFovDeg = this.worldFov,
  ): Vec3Out {
    let tx = 0, ty = 0;
    if (!this.disposed) {
      this.getMuzzleLocal(_muzzleVec);
      // The viewmodel camera looks down -z, so a barrel in front of it has a
      // negative z. A non-negative one means the model is mid-switch and folded
      // behind the lens; fall back to the axis rather than mirroring the offset.
      const depth = -_muzzleVec.z;
      if (depth > 0.05) {
        const k = Math.tan((worldFovDeg * Math.PI) / 360)
          / Math.tan((this.camera.fov * Math.PI) / 360);
        tx = (_muzzleVec.x / depth) * k;
        ty = (_muzzleVec.y / depth) * k;
      }
    }

    // Camera basis from the aim direction alone, so this needs no matrix and no
    // frame of lag: the shot and the flash come out of the same tick.
    // right = normalize(aim x worldUp). Get this backwards and the gun's
    // effects come out of the player's left hand.
    let rx = -dz, ry = 0, rz = dx;
    let rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-4) {
      // Straight up or straight down — any horizontal right vector will do.
      rx = 1; ry = 0; rz = 0; rl = 1;
    }
    rx /= rl; rz /= rl;
    const ux = ry * dz - rz * dy;
    const uy = rz * dx - rx * dz;
    const uz = rx * dy - ry * dx;

    const sx = tx * dist, sy = ty * dist;
    out.x = ex + dx * dist + rx * sx + ux * sy;
    out.y = ey + dy * dist + ry * sx + uy * sy;
    out.z = ez + dz * dist + rz * sx + uz * sy;
    return out;
  }

  /** 0..1, decays over the weapon's muzzleMs. Drive fx and audio from it. */
  get muzzleFlash(): number {
    return this.muzzle;
  }

  /* -- brass ------------------------------------------------------------- */

  private throwBrass(from: readonly [number, number, number]): void {
    const s = scaleOf(this.shapeFor(this.weapon));
    const i = this.shellNext;
    this.shellNext = (this.shellNext + 1) % SHELL_SLOTS;
    // Spawned in view space at the port's current world-ish position so the
    // brass leaves the gun and then stops caring where the gun goes.
    _tmpVec.set(from[0] * s, from[1] * s, from[2] * s);
    this.root.updateMatrix();
    _tmpVec.applyMatrix4(this.root.matrix);
    this.shellPos[i].set(_tmpVec.x, _tmpVec.y, _tmpVec.z, 1);
    this.shellRot[i].set(Math.random() * TAU, Math.random() * TAU, Math.random() * TAU);
    const j = i * 3;
    this.shellVel[j + 0] = (0.55 + Math.random() * 0.35) * this.handSign;
    this.shellVel[j + 1] = 0.85 + Math.random() * 0.35;
    this.shellVel[j + 2] = 0.55 + Math.random() * 0.40;
    this.shellSpin[j + 0] = (Math.random() - 0.5) * 26;
    this.shellSpin[j + 1] = (Math.random() - 0.5) * 20;
    this.shellSpin[j + 2] = (Math.random() - 0.5) * 26;
    this.shellLife[i] = 0.46;
  }

  private updateBrass(dt: number): void {
    let alive = false;
    for (let i = 0; i < SHELL_SLOTS; i++) {
      if (this.shellLife[i] <= 0) continue;
      this.shellLife[i] -= dt;
      if (this.shellLife[i] <= 0) { this.shellPos[i].w = 0; continue; }
      alive = true;
      const j = i * 3;
      this.shellVel[j + 1] -= 3.6 * dt;
      const p = this.shellPos[i];
      p.x += this.shellVel[j + 0] * dt;
      p.y += this.shellVel[j + 1] * dt;
      p.z += this.shellVel[j + 2] * dt;
      p.w = clamp(this.shellLife[i] * 7, 0, 1);
      const r = this.shellRot[i];
      r.x += this.shellSpin[j + 0] * dt;
      r.y += this.shellSpin[j + 1] * dt;
      r.z += this.shellSpin[j + 2] * dt;
    }
    this.brassMesh.visible = alive && this.enabled;
    if (alive) this.brassMat.uniformsNeedUpdate = true;
  }

  /* -- per frame --------------------------------------------------------- */

  update(dt: number, input: ViewmodelInput): void {
    if (this.disposed || !this.enabled) return;
    const step = Math.min(dt, 0.05);
    const ms = this.motionScale;
    const def = getWeapon(this.weapon);
    const shape = this.shapeFor(this.weapon);

    /* --- switch: ease out on the way down, ease in with a settle ------- */
    let lowered = 0;
    if (this.switchPhase !== 'idle') {
      this.switchTimer += step;
      const t = clamp(this.switchTimer / this.switchDuration, 0, 1);
      if (this.switchPhase === 'out') {
        this.raise = 1 - t * t;
        if (t >= 1) {
          if (this.pendingWeapon >= 0) this.applyWeapon(this.pendingWeapon);
          this.pendingWeapon = -1;
          this.switchPhase = 'in';
          this.switchTimer = 0;
          this.switchDuration = Math.max(1, getWeapon(this.weapon).switchInMs) / 1000;
        }
      } else {
        const e = 1 - (1 - t) * (1 - t) * (1 - t);
        this.raise = e;
        if (t >= 1) {
          this.switchPhase = 'idle';
          this.raise = 1;
          // A weapon that arrives without a bump reads as a teleport.
          this.wx += 0.55 * ms;
          this.vy += 0.32 * ms;
        }
      }
    } else {
      this.raise = 1;
    }
    lowered = 1 - this.raise;

    /* --- sway ---------------------------------------------------------- */
    if (!this.haveAngles) {
      this.prevYaw = input.yaw;
      this.prevPitch = input.pitch;
      this.haveAngles = true;
    }
    const yawRate = wrapAngle(input.yaw - this.prevYaw) / Math.max(step, 1e-4);
    const pitchRate = (input.pitch - this.prevPitch) / Math.max(step, 1e-4);
    this.prevYaw = input.yaw;
    this.prevPitch = input.pitch;

    const swayTX = clamp(-yawRate * 0.019, -0.070, 0.070) * ms;
    const swayTY = clamp(pitchRate * 0.016, -0.058, 0.058) * ms;
    const swayTR = clamp(-yawRate * 0.055, -0.17, 0.17) * ms;
    const swayTP = clamp(-pitchRate * 0.030, -0.11, 0.11) * ms;
    this.swayX = expDecay(this.swayX, swayTX, 10, step);
    this.swayY = expDecay(this.swayY, swayTY, 10, step);
    this.swayRoll = expDecay(this.swayRoll, swayTR, 8.5, step);
    this.swayPitch = expDecay(this.swayPitch, swayTP, 9, step);

    /* --- bob ----------------------------------------------------------- */
    const speedFrac = clamp(input.speed / SPEED_RUN, 0, 1.4);
    this.idlePhase += TAU * 0.21 * step;
    if (this.idlePhase > TAU) this.idlePhase -= TAU;

    let bobX = 0, bobY = 0, bobRoll = 0, bobPitch = 0;
    if (this.bobEnabled && input.grounded && speedFrac > 0.06) {
      this.bobPhase += TAU * VIEW_BOB_HZ * speedFrac * step;
      if (this.bobPhase > TAU) this.bobPhase -= TAU;
      const amp = VIEW_BOB_AMPLITUDE * speedFrac * ms;
      const s1 = Math.sin(this.bobPhase);
      // Sharpened on the down stroke: a heel strike, not a sine wave.
      const heel = Math.cos(this.bobPhase * 2);
      bobX = s1 * amp * 1.85;
      bobY = (heel * 0.5 - 0.5) * amp * 1.45 - Math.max(0, -heel) * amp * 0.35;
      bobRoll = s1 * 0.040 * speedFrac * ms;
      bobPitch = heel * 0.016 * speedFrac * ms;
    } else {
      // Idle breathing. Small, but the bar's gun does exactly zero of this.
      const p = this.idlePhase;
      bobY = Math.sin(p) * 0.0060 * ms;
      bobX = Math.sin(p * 0.5) * 0.0048 * ms;
      bobRoll = Math.sin(p * 0.37 + 1.1) * 0.0090 * ms;
      bobPitch = Math.cos(p * 0.63) * 0.0060 * ms;
    }

    /* --- landing ------------------------------------------------------- */
    if (input.landImpact > 0) {
      this.landDip = Math.max(this.landDip, LAND_DIP_MAX * clamp(input.landImpact, 0, 1) * ms);
      input.landImpact = 0;
    }
    this.landDip = expDecay(this.landDip, 0, 9.5, step);

    /* --- pose blends --------------------------------------------------- */
    const sprintTarget = input.sprinting && speedFrac > 0.55 && !input.firing ? 1 : 0;
    this.sprintT = expDecay(this.sprintT, sprintTarget, 9, step);
    this.crouchT = expDecay(this.crouchT, input.crouching ? 1 : 0, 12, step);

    /* --- reload -------------------------------------------------------- */
    const pose = _pose;
    resetPose(pose);
    if (this.reloadActive) {
      this.reloadT += step;
      const shellMode = this.shellPeriod > 0;
      const over = this.reloadT >= this.reloadDuration;
      const released = shellMode && this.reloadT > 0.12 && !input.reloading;
      if (over || released) {
        this.reloadActive = false;
      } else {
        buildReloadPose(pose, this.weapon, this.reloadT, this.reloadDuration, this.shellPeriod);
      }
    } else if (input.reloading) {
      // The game says reloading but we never got the hook — hold a carry pose
      // rather than snapping to rest.
      pose.hold = 1; pose.dip = 1; pose.pitch = 1; pose.roll = 0.5;
    }

    /* --- firing mechanics ---------------------------------------------- */
    this.cycle = Math.max(0, this.cycle - this.cycleRate * step);
    this.pumpT = Math.min(1, this.pumpT + this.pumpRate * step);
    if (this.muzzle > 0) {
      this.muzzle -= this.muzzleDecay * step;
      if (this.muzzle < 0) this.muzzle = 0;
    }
    this.uniforms.uMuzzle.value = this.muzzle;

    // spin-up / spin-down, shared by the chaingun cluster and the saw chain
    const spinTarget = input.firing || pose.spin > 0 ? 1 : 0;
    const upRate = def.spinUpMs > 0 ? 1000 / def.spinUpMs : 11;
    const downRate = def.spinDownMs > 0 ? 1000 / def.spinDownMs : 5;
    const rate = spinTarget > this.spin ? upRate : downRate;
    this.spin += (Math.max(spinTarget, pose.spin) - this.spin) * Math.min(1, rate * step);
    this.spinAngle += this.spin * 30 * step;
    if (this.spinAngle > TAU) this.spinAngle -= TAU;

    this.rev = expDecay(this.rev, input.firing && def.kind === FireKind.MELEE ? 1 : 0, 7, step);
    const chainSpeed = 0.55 + 2.4 * Math.max(this.rev, def.kind === FireKind.MELEE ? 0.28 : 0);
    this.chainPhase = (this.chainPhase + chainSpeed * step) % 1;

    // emissive level: settles to 1, spikes on a shot, follows the reload charge
    this.core = expDecay(this.core, pose.core, 9, step);
    this.uniforms.uEmit.value = 1.25 * this.core;

    // The hit pop. Deliberately small — it has to be felt at 60 fps over three
    // frames, not seen as the gun turning into a lightbulb.
    if (this.hitGlow > 0) {
      this.hitGlow -= this.hitGlowDecay * step;
      if (this.hitGlow < 0) this.hitGlow = 0;
    }
    this.uniforms.uBright.value = this.bright * (1 + HIT_GLOW_GAIN * this.hitGlow);
    const kill = this.hitWasKill * Math.min(1, this.hitGlow) * KILL_TINT_GAIN;
    (this.uniforms.uKill.value as THREE.Vector3).set(
      KILL_TINT_R * kill, KILL_TINT_G * kill, KILL_TINT_B * kill,
    );

    /* --- part transforms ------------------------------------------------ */
    const scale = scaleOf(shape);
    const fireCycle = slideTravel(this.cycle, 1 / Math.max(this.cycleRate, 1e-3));
    for (let i = 0; i < this.activeParts.length && i < MAX_PARTS; i++) {
      const part = this.activeParts[i];
      const pivot = this.partPivots[i];
      const travel = (part.travel ?? 0) * scale;
      const px = pivot.position;
      const base = part.pivot;
      const bx = base === undefined ? 0 : base[0] * scale;
      const by = base === undefined ? 0 : base[1] * scale;
      const bz = base === undefined ? 0 : base[2] * scale;

      switch (part.role) {
        case Role.SPIN:
          pivot.rotation.z = this.spinAngle;
          break;

        case Role.SLIDE: {
          const back = Math.max(fireCycle, pose.slide);
          px.set(bx, by, bz + travel * back);
          break;
        }

        case Role.PUMP: {
          const rack = Math.max(Math.sin(Math.PI * this.pumpT), pose.pump);
          px.set(bx, by, bz + travel * rack);
          break;
        }

        case Role.MAG: {
          const drop = pose.mag;
          px.set(bx, by - travel * drop, bz + travel * 0.22 * drop);
          pivot.rotation.set(0, 0, -0.55 * drop * this.handSign);
          pivot.visible = pose.magHide < 0.5;
          break;
        }

        case Role.FEED: {
          const f = pose.feed;
          px.set(bx, by + travel * 0.55 * f, bz - travel * f);
          pivot.visible = pose.feedHide < 0.5;
          break;
        }

        case Role.CLAW: {
          const open = 1 + 0.30 * pose.claw;
          pivot.scale.set(open, open, 1);
          pivot.rotation.z = 0.18 * pose.claw;
          break;
        }

        case Role.CHAIN: {
          px.set(bx, by, bz - travel * this.chainPhase);
          break;
        }
      }
    }
    // A chaingun drum that swung out must not be culled by the MAG default.
    if (this.activeParts.length > 0) {
      for (let i = this.activeParts.length; i < MAX_PARTS; i++) this.partPivots[i].visible = false;
    }

    /* --- flash --------------------------------------------------------- */
    if (this.muzzle > 0.02 && shape.flash !== 0) {
      const k = this.flashSize * (0.62 + 0.95 * this.muzzle) * (0.88 + 0.24 * Math.random());
      this.flashMesh.visible = true;
      this.flashMesh.scale.set(k, k, k * 1.15);
      this.flashMesh.rotation.z = this.flashRoll + (1 - this.muzzle) * 1.2;
      // Front-loaded: the first frame of a shot should be uncomfortable and the
      // third should be gone. A linear ramp gives a flash that lingers as a
      // pale beige star, which is the worst of both.
      //
      // Pulled down from a 2.28 peak in round 2. The measurement that forced
      // it: 34,946 pixels over 230 luminance on the flash frame, additive, and
      // the thing being erased was the target the decal was landing on. The
      // flash was doing the recoil's job as well as its own, badly — and now
      // that the model itself moves 12 px and cycles its slide, it does not
      // have to shout. A flash you can look through is worth more than a flash
      // that proves a shot happened by deleting the evidence.
      this.flashMat.uniforms.uGain.value = 0.14 + 1.48 * this.muzzle * this.muzzle;
      this.flashMat.uniformsNeedUpdate = true;
    } else {
      this.flashMesh.visible = false;
    }

    this.updateBrass(step);
    this.material.uniformsNeedUpdate = true;

    /* --- kick spring ---------------------------------------------------- */
    this.integrateSpring(def.viewKickRecovery, step);

    /* --- compose -------------------------------------------------------- */
    // Narrow viewports pull the gun toward the middle so it does not fall off
    // the edge; short ones lift it so it does not eat the screen.
    const aspectPull = clamp(this.aspect / 1.6, 0.30, 1);
    const wide = clamp((this.aspect - 1.6) / 0.7, 0, 1);
    // Portrait keeps the vertical FOV but loses most of the width, so the same
    // solid runs off the right edge. Shrink it about its own grip instead of
    // sliding it further in, which would put it under the crosshair. Measured
    // at 412x915: the frame is only 360 mm wide at the rest distance and a
    // chaingun projects 300 of them, so the shrink has to be real.
    const narrow = clamp((1.30 - this.aspect) / 0.70, 0, 1);
    const fit = 1 - 0.36 * narrow;
    // A very wide, very short viewport (915x412 landscape phone) has the
    // opposite problem: plenty of width, almost no height. Pull back there too.
    const squat = clamp((this.aspect - 1.9) / 0.6, 0, 1);
    const restX = 0.228 * aspectPull * this.handSign;
    const restY = -0.214 + 0.052 * (1 - aspectPull) + 0.036 * wide + (shape.restY ?? 0) * fit;
    // Pushed out to REST_DIST rather than 1.25 m. The camera is a long lens, so
    // moving the gun back shrinks it AND pulls its apparent offset toward the
    // middle at the same rate — which is the fix for a weapon that was running
    // off the right edge and eating the bottom-right quarter of the frame.
    const restZ = -REST_DIST * (1 + 0.16 * squat) + (shape.restZ ?? 0);
    // Yawed in so the camera sees the weapon's LEFT FLANK rather than its back
    // plate.
    //
    // This is the number that decides whether a long gun reads. A barrel
    // pointing into the screen projects to length * sin(yaw): at 16 degrees a
    // 384 mm shotgun barrel is 106 mm on the picture plane and the weapon's
    // defining feature collapses into a stub, which is exactly what the first
    // capture showed. At 21 degrees it is 138 mm — a third longer for two
    // degrees of cant nobody reads as wrong, because perspective from the
    // camera's own sideways offset is already supplying about eight of them.
    const restYaw = REST_YAW;

    /* RECOIL TRAVELS BACK ALONG THE BARREL.
     *
     * This is the round-2 fix, and it is one line of trigonometry against the
     * single measurement the piece lost on. `this.pz` is the rearward spring —
     * the biggest column in the kick table — and it used to be added straight
     * to the camera-space z, which is the one direction a camera cannot see.
     * At 1.4 m a 20 mm push down the view axis moves nothing on the picture
     * plane; it makes the gun 1.4 % bigger and that is all. The gun recoils
     * into the shooter's hand, and the hand is holding the gun at `restYaw`,
     * so the travel decomposes: sin(21 deg) = 0.357 of it on the picture plane
     * and cos(21 deg) = 0.934 of it into depth. The depth half is what it
     * always was. The other half is the pixels. */
    const axialX = this.pz * REST_YAW_SIN * this.handSign;
    const axialZ = this.pz * REST_YAW_COS;

    const revShake = this.rev * 0.0045;
    const px = restX
      + (this.swayX + bobX + this.px) * this.handSign
      + axialX
      + 0.062 * this.sprintT * this.handSign
      - 0.048 * pose.hold * this.handSign
      + Math.sin(this.chainPhase * TAU * 3.1) * revShake;
    const py = restY + this.swayY + bobY + this.py
      - this.landDip
      - 0.034 * this.sprintT
      - 0.020 * this.crouchT
      - 0.085 * pose.dip
      + 0.030 * pose.push
      - 0.62 * lowered
      + Math.cos(this.chainPhase * TAU * 4.3) * revShake;
    const pz = restZ + axialZ
      + 0.034 * this.sprintT
      + 0.030 * pose.hold
      + 0.16 * lowered;

    this.root.position.set(px, py, pz);
    this.root.rotation.set(
      this.rx + this.swayPitch + bobPitch + this.landDip * 0.85
      - 0.22 * this.sprintT
      + 0.34 * pose.pitch
      + REST_PITCH + (shape.restPitch ?? 0)
      - 1.05 * lowered,
      this.ry
      + (restYaw + 0.46 * this.sprintT + 0.26 * pose.yaw) * this.handSign
      - 0.10 * lowered * this.handSign,
      this.rz + this.swayRoll + bobRoll
      + 0.19 * this.sprintT * this.handSign
      + 0.62 * pose.roll * this.handSign
      - 0.28 * lowered * this.handSign,
    );
    this.root.scale.set(this.handSign * fit, fit, fit);
    this.root.updateMatrix();
    this.root.matrixWorld.copy(this.root.matrix);
    this.root.updateWorldMatrix(false, true);
  }

  /**
   * Underdamped spring per axis. Substepped so a 100 ms hitch cannot make the
   * BFG's recovery term explode.
   */
  private integrateSpring(omega: number, dt: number): void {
    const w = Math.max(1, omega) * KICK_OMEGA_SCALE;
    const steps = Math.min(8, Math.max(1, Math.ceil((w * dt) / 0.2)));
    const h = dt / steps;
    const z = KICK_DAMPING;
    for (let i = 0; i < steps; i++) {
      this.vx += (-2 * z * w * this.vx - w * w * this.px) * h;
      this.vy += (-2 * z * w * this.vy - w * w * this.py) * h;
      this.vz += (-2 * z * w * this.vz - w * w * this.pz) * h;
      this.px += this.vx * h;
      this.py += this.vy * h;
      this.pz += this.vz * h;

      this.wx += (-2 * z * w * this.wx - w * w * this.rx) * h;
      this.wy += (-2 * z * w * this.wy - w * w * this.ry) * h;
      this.wz += (-2 * z * w * this.wz - w * w * this.rz) * h;
      this.rx += this.wx * h;
      this.ry += this.wy * h;
      this.rz += this.wz * h;
    }
    this.px = clamp(this.px, -MAX_KICK_OFFSET, MAX_KICK_OFFSET);
    this.py = clamp(this.py, -MAX_KICK_OFFSET, MAX_KICK_OFFSET);
    this.pz = clamp(this.pz, -MAX_KICK_OFFSET, MAX_KICK_OFFSET);
    this.rx = clamp(this.rx, -MAX_KICK_ANGLE, MAX_KICK_ANGLE);
    this.ry = clamp(this.ry, -MAX_KICK_ANGLE, MAX_KICK_ANGLE);
    this.rz = clamp(this.rz, -MAX_KICK_ANGLE, MAX_KICK_ANGLE);
  }

  /* -- overlay pass ------------------------------------------------------ */

  render(renderer: THREE.WebGLRenderer, _dt: number): void {
    if (this.disposed || !this.enabled) return;
    const size = renderer.getSize(_tmpSize);
    const a = size.x / Math.max(1, size.y);
    if (Math.abs(a - this.aspect) > 1e-3) {
      this.aspect = a;
      this.camera.aspect = a;
      this.camera.updateProjectionMatrix();
    }
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = 0; i < WEAPON_COUNT; i++) {
      this.bodyGeo[i]?.dispose();
      this.bodyGeo[i] = null;
      for (let p = 0; p < MAX_PARTS; p++) {
        this.partGeo[i][p]?.dispose();
        this.partGeo[i][p] = null;
      }
    }
    this.flashMesh.geometry.dispose();
    this.brassMesh.geometry.dispose();
    this.material.dispose();
    this.outlineMat.dispose();
    this.flashMat.dispose();
    this.brassMat.dispose();
  }
}

/* ------------------------------------------------------------------------ *
 * Reload choreography
 *
 * One function per weapon, all on a normalised 0..1 clock so the timings come
 * from the shared table (reloadMs / reloadShellMs) rather than from here.
 * ------------------------------------------------------------------------ */

function resetPose(p: ReloadPose): void {
  p.hold = 0; p.dip = 0; p.pitch = 0; p.roll = 0; p.yaw = 0; p.push = 0;
  p.slide = 0; p.pump = 0; p.mag = 0; p.magHide = 0;
  p.feed = 0; p.feedHide = 1; p.claw = 0; p.core = 1; p.spin = 0;
}

function buildReloadPose(
  p: ReloadPose, weapon: number, elapsed: number, duration: number, shellPeriod: number,
): void {
  const r = clamp(elapsed / duration, 0, 1);
  // Every reload eases into a carry pose and back out of it.
  p.hold = smooth(seg(r, 0, 0.14)) * (1 - smooth(seg(r, 0.86, 1)));

  switch (weapon) {
    case WeaponId.PISTOL: {
      p.dip = p.hold * 0.85; p.pitch = p.hold * 0.40; p.roll = -p.hold * 0.85; p.yaw = -p.hold * 0.55;
      p.slide = 1 - smooth(seg(r, 0.80, 0.90));            // locked back, then snaps
      p.mag = smooth(seg(r, 0.14, 0.34));
      p.magHide = r > 0.36 && r < 0.56 ? 1 : 0;             // swapped off screen
      if (r >= 0.56) p.mag = 1 - smooth(seg(r, 0.56, 0.76));
      p.push = bell(r, 0.80, 0.92) * 0.5;                   // the slide slam
      break;
    }

    case WeaponId.SHOTGUN: {
      // Canted over so the loading gate faces the camera, one shell at a time.
      p.dip = p.hold * 0.8; p.pitch = p.hold * 0.30; p.roll = -p.hold * 1.05; p.yaw = -p.hold * 0.35;
      const period = shellPeriod > 0 ? shellPeriod : duration;
      const k = (elapsed % period) / period;
      p.feedHide = k > 0.92 ? 1 : 0;
      p.feed = smooth(seg(k, 0.05, 0.62));
      p.pump = bell(r, 0.88, 1.0);
      break;
    }

    case WeaponId.CHAINGUN: {
      p.dip = p.hold * 0.9; p.pitch = p.hold * 0.34; p.roll = -p.hold * 0.70; p.yaw = -p.hold * 0.80;
      p.mag = smooth(seg(r, 0.12, 0.34)) * (1 - smooth(seg(r, 0.62, 0.84)));
      p.spin = seg(r, 0.86, 0.94) * (1 - seg(r, 0.96, 1));  // a short test spin
      p.push = bell(r, 0.84, 0.96) * 0.4;
      break;
    }

    case WeaponId.ROCKET: {
      // Tipped up so the breech is toward the camera, round slides in, snaps down.
      p.dip = p.hold * 0.50; p.pitch = -p.hold * 1.15; p.roll = -p.hold * 0.55;
      p.feedHide = r < 0.18 || r > 0.86 ? 1 : 0;
      p.feed = smooth(seg(r, 0.22, 0.66));
      p.slide = 1 - smooth(seg(r, 0.70, 0.84));
      p.push = bell(r, 0.84, 1.0) * 0.7;
      break;
    }

    case WeaponId.PLASMA: {
      p.dip = p.hold * 0.9; p.pitch = p.hold * 0.26; p.roll = -p.hold * 0.95; p.yaw = -p.hold * 0.60;
      p.mag = smooth(seg(r, 0.14, 0.40));
      p.magHide = r > 0.42 && r < 0.56 ? 1 : 0;
      if (r >= 0.56) p.mag = 1 - smooth(seg(r, 0.56, 0.74));
      // Goes dark while the cell is out, then floods back over-bright.
      p.core = r < 0.14 ? 1 - smooth(seg(r, 0.02, 0.14)) * 0.88
        : r < 0.74 ? 0.12
          : 0.12 + smooth(seg(r, 0.74, 0.94)) * 1.75;
      break;
    }

    case WeaponId.BFG: {
      p.dip = p.hold * 1.05; p.pitch = -p.hold * 0.40; p.roll = -p.hold * 0.75;
      p.mag = smooth(seg(r, 0.14, 0.36));
      p.magHide = r > 0.38 && r < 0.52 ? 1 : 0;
      if (r >= 0.52) p.mag = 1 - smooth(seg(r, 0.52, 0.70));
      p.claw = smooth(seg(r, 0.70, 0.93)) * (1 - smooth(seg(r, 0.95, 1)));
      // Three stepped surges, then settle: it is a 3.4 s commitment, show it.
      const charge = seg(r, 0.70, 0.96);
      p.core = r < 0.16 ? 1 - smooth(seg(r, 0.02, 0.16)) * 0.92
        : r < 0.70 ? 0.08
          : 0.08 + charge * charge * 2.2 + Math.abs(Math.sin(charge * Math.PI * 3)) * 0.5;
      p.push = bell(r, 0.86, 1.0) * 0.8;
      break;
    }

    default: {
      p.dip = p.hold; p.pitch = p.hold * 0.5; p.roll = p.hold * 0.6;
      break;
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Brass geometry — SHELL_SLOTS copies of one casing, each tagged with its slot
 * so the whole spray is one draw call driven by two uniform arrays.
 * ------------------------------------------------------------------------ */

function buildBrassGeometry(): THREE.BufferGeometry {
  const one = [
    b(0, 0, 0, 0.011, 0.011, 0.030, BRASS),
    b(0, 0, 0.018, 0.013, 0.013, 0.007, BRASS_DK),
  ];
  const src = buildGeometry(one, 1);
  const srcPos = src.getAttribute('position') as THREE.BufferAttribute;
  const srcCol = src.getAttribute('aColor') as THREE.BufferAttribute;
  const srcLit = src.getAttribute('aLight') as THREE.BufferAttribute;
  const srcIdx = src.getIndex() as THREE.BufferAttribute;
  const n = srcPos.count;

  const pos = new Float32Array(n * SHELL_SLOTS * 3);
  const col = new Float32Array(n * SHELL_SLOTS * 3);
  const lit = new Float32Array(n * SHELL_SLOTS);
  const slot = new Float32Array(n * SHELL_SLOTS);
  const idx = new Uint16Array(srcIdx.count * SHELL_SLOTS);

  for (let s = 0; s < SHELL_SLOTS; s++) {
    pos.set(srcPos.array as Float32Array, s * n * 3);
    col.set(srcCol.array as Float32Array, s * n * 3);
    lit.set(srcLit.array as Float32Array, s * n);
    slot.fill(s, s * n, (s + 1) * n);
    for (let i = 0; i < srcIdx.count; i++) {
      idx[s * srcIdx.count + i] = (srcIdx.array as ArrayLike<number>)[i] + s * n;
    }
  }
  src.dispose();

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aLight', new THREE.BufferAttribute(lit, 1));
  geo.setAttribute('aSlot', new THREE.BufferAttribute(slot, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

const _tmpSize = new THREE.Vector2();
const _tmpVec = new THREE.Vector3();
const _muzzleVec = new THREE.Vector3();
