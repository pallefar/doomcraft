/**
 * DOOMCRAFT — first-person weapon viewmodel.
 *
 * ref/BAR.md weakness #2, measured not guessed: across 1.2 s of continuous
 * mouselook in the bar's own capture the held item "does not move one pixel
 * relative to the camera". No sway, no bob, no kick, no flash. It is a decal.
 *
 * This is the answer. Every weapon is a solid built out of voxel boxes (no
 * external assets, ~40 boxes for the whole arsenal, one draw call each) and it
 * is driven by five stacked motions:
 *
 *   1. look sway     - the gun lags the camera and overshoots back
 *   2. walk bob      - a figure-eight at VIEW_BOB_HZ scaled by real speed
 *   3. landing dip   - LAND_DIP_MAX, decaying
 *   4. fire kick     - an underdamped spring per axis, impulses straight off
 *                      the shared weapon table (viewKick*, viewKickRecovery)
 *   5. pose blends   - sprint carry, crouch, reload, and the switch raise/lower
 *                      timed by switchInMs / switchOutMs
 *
 * plus a muzzle glow that lights the model itself, and a barrel that actually
 * spins on the chaingun.
 *
 * It renders as an overlay pass into its own scene and camera with a cleared
 * depth buffer, which is the standard fix for a viewmodel poking through walls.
 */

import * as THREE from 'three';
import {
  clamp,
  expDecay,
  FACE_SHADE,
  FireKind,
  getWeapon,
  LAND_DIP_MAX,
  SPEED_RUN,
  SUN_DIR_X,
  SUN_DIR_Y,
  SUN_DIR_Z,
  TAU,
  VIEW_BOB_AMPLITUDE,
  VIEW_BOB_HZ,
  wrapAngle,
  WeaponId,
  WEAPON_COUNT,
} from '@doomcraft/shared';
import type { OverlayPass } from './renderer';

/* ------------------------------------------------------------------------ *
 * Box soup
 * ------------------------------------------------------------------------ */

/** [x, y, z, width, height, depth, 0xRRGGBB] — centre and size, in metres. */
type Box = readonly [number, number, number, number, number, number, number];

const GUNMETAL = 0x5b626d;
const GUNDARK = 0x33383f;
const GUNLIGHT = 0x878f9b;
const RUST = 0x8a5730;
const BRASS = 0xc09648;
const HOTRED = 0xbf3d22;
const PLASMA = 0x3f9ed6;
const PLASMA_HOT = 0x8fe4ff;
const BFG_GREEN = 0x84f04c;
const WOODGRIP = 0x6f4826;
const GLOVE = 0x69793d;
const GLOVE_DARK = 0x4e5b2c;
const SLEEVE = 0x39421f;
const STEEL = 0xa8b0ba;

/**
 * Hands, shared by every weapon. Authored for the right hand; mirrored if needed.
 *
 * Three boxes, not two: a single long forearm slab is the closest thing to the
 * near plane in the whole game and a featureless one reads as a floating green
 * brick. Fist, wrist and a darker armoured cuff give it a silhouette at the
 * size it is actually seen.
 */
const HANDS_BACK: readonly Box[] = [
  [0.000, -0.112, 0.048, 0.080, 0.098, 0.096, GLOVE],
  [0.010, -0.150, 0.128, 0.062, 0.062, 0.096, GLOVE_DARK],
  [0.014, -0.178, 0.208, 0.076, 0.076, 0.086, SLEEVE],
];

interface WeaponShape {
  readonly body: readonly Box[];
  /** Optional animated sub-assembly. */
  readonly moving?: readonly Box[];
  readonly motion?: 'rotate' | 'shake';
  /** Where the flash comes out, in viewmodel space. */
  readonly muzzle: readonly [number, number, number];
  /** Uniform scale applied to the whole solid. */
  readonly scale?: number;
}

function ring(count: number, radius: number, z: number, len: number, r: number, color: number): Box[] {
  const out: Box[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * TAU;
    out.push([Math.cos(a) * radius, Math.sin(a) * radius, z, r, r, len, color]);
  }
  return out;
}

const SHAPES: readonly WeaponShape[] = [
  // ---- PISTOL -----------------------------------------------------------
  {
    body: [
      ...HANDS_BACK,
      [0.00, -0.055, 0.020, 0.052, 0.130, 0.062, GUNDARK],   // grip
      [0.00, 0.030, -0.065, 0.056, 0.062, 0.200, GUNMETAL],  // frame
      [0.00, 0.068, -0.065, 0.050, 0.028, 0.205, GUNLIGHT],  // slide
      [0.00, 0.030, -0.190, 0.024, 0.024, 0.070, GUNDARK],   // barrel
      [0.00, -0.008, -0.020, 0.030, 0.030, 0.024, GUNDARK],  // trigger guard
      [0.00, 0.086, -0.150, 0.008, 0.012, 0.010, STEEL],     // front sight
    ],
    muzzle: [0, 0.030, -0.235],
  },
  // ---- SHOTGUN ----------------------------------------------------------
  {
    body: [
      ...HANDS_BACK,
      [0.00, -0.020, 0.215, 0.062, 0.095, 0.210, WOODGRIP],  // stock
      [0.00, 0.000, 0.030, 0.072, 0.092, 0.200, GUNMETAL],   // receiver
      [0.00, 0.052, -0.300, 0.036, 0.036, 0.440, GUNDARK],   // upper barrel
      [0.00, 0.008, -0.290, 0.036, 0.036, 0.420, GUNDARK],   // lower barrel
      [0.00, 0.030, -0.520, 0.052, 0.082, 0.030, STEEL],     // muzzle cap
      [0.00, -0.055, 0.085, 0.048, 0.075, 0.070, WOODGRIP],  // pistol grip
      [0.00, 0.086, -0.120, 0.010, 0.010, 0.240, STEEL],     // rib
      [0.075, -0.140, -0.150, 0.085, 0.100, 0.110, GLOVE],   // support hand
    ],
    moving: [
      [0.00, 0.028, -0.185, 0.060, 0.060, 0.120, RUST],      // pump
    ],
    motion: 'shake',
    muzzle: [0, 0.030, -0.545],
  },
  // ---- CHAINGUN ---------------------------------------------------------
  {
    body: [
      ...HANDS_BACK,
      [0.00, 0.000, 0.055, 0.100, 0.110, 0.230, GUNMETAL],   // receiver
      [0.00, 0.062, 0.045, 0.066, 0.016, 0.170, GUNDARK],    // top vent
      [0.052, 0.000, 0.055, 0.014, 0.084, 0.200, GUNDARK],   // right groove
      [-0.052, 0.000, 0.055, 0.014, 0.084, 0.200, GUNDARK],  // left groove
      [0.00, -0.058, 0.055, 0.066, 0.016, 0.190, GUNDARK],   // underside rail
      [0.092, -0.055, 0.140, 0.072, 0.096, 0.140, 0x47522f], // ammo box
      [0.052, -0.020, 0.140, 0.044, 0.028, 0.058, BRASS],    // feed belt
      [0.00, -0.088, 0.120, 0.046, 0.096, 0.052, GUNDARK],   // rear grip
      [0.00, -0.010, -0.090, 0.058, 0.058, 0.070, GUNLIGHT], // hub
      [0.00, 0.084, 0.040, 0.028, 0.028, 0.150, GUNDARK],    // carry handle
      [0.00, -0.010, -0.150, 0.026, 0.026, 0.060, GUNLIGHT], // spindle
      [0.00, -0.010, -0.360, 0.108, 0.108, 0.024, GUNDARK],  // front ring
      [0.00, 0.048, -0.360, 0.020, 0.020, 0.026, STEEL],     // ring lug
    ],
    moving: ring(6, 0.044, -0.245, 0.250, 0.019, STEEL),
    motion: 'rotate',
    muzzle: [0, -0.010, -0.380],
    scale: 0.92,
  },
  // ---- ROCKET LAUNCHER --------------------------------------------------
  {
    body: [
      ...HANDS_BACK,
      [0.00, 0.030, -0.110, 0.088, 0.088, 0.480, RUST],      // tube
      [0.00, 0.030, -0.355, 0.104, 0.104, 0.040, GUNDARK],   // muzzle ring
      [0.00, 0.030, 0.155, 0.098, 0.098, 0.034, GUNDARK],    // rear ring
      [0.00, 0.104, -0.090, 0.014, 0.055, 0.130, STEEL],     // sight rail
      [0.00, -0.075, 0.055, 0.050, 0.110, 0.062, GUNDARK],   // grip
      [0.00, -0.030, -0.240, 0.046, 0.046, 0.090, GUNMETAL], // fore grip
      [0.00, 0.030, -0.372, 0.036, 0.036, 0.055, HOTRED],    // warhead tip
    ],
    muzzle: [0, 0.030, -0.400],
  },
  // ---- PLASMA RIFLE -----------------------------------------------------
  {
    body: [
      ...HANDS_BACK,
      [0.00, 0.000, -0.040, 0.080, 0.096, 0.310, GUNMETAL],  // body
      [0.00, 0.072, -0.100, 0.034, 0.034, 0.180, PLASMA],    // coil
      [0.00, -0.062, -0.090, 0.034, 0.034, 0.150, PLASMA],   // lower coil
      [0.00, 0.000, -0.230, 0.058, 0.058, 0.060, GUNDARK],   // shroud
      [0.00, 0.000, -0.262, 0.038, 0.038, 0.020, PLASMA_HOT],// emitter
      [0.00, -0.092, 0.070, 0.050, 0.110, 0.058, GUNDARK],   // grip
      [0.00, 0.062, 0.090, 0.046, 0.030, 0.090, PLASMA],     // cell pack
    ],
    muzzle: [0, 0.000, -0.285],
  },
  // ---- BFG 9000 ---------------------------------------------------------
  {
    body: [
      ...HANDS_BACK,
      [0.00, -0.010, -0.010, 0.135, 0.130, 0.350, GUNMETAL], // body
      [0.00, -0.010, -0.205, 0.100, 0.100, 0.055, GUNDARK],  // barrel block
      [0.00, -0.010, -0.232, 0.062, 0.062, 0.024, BFG_GREEN],// core
      [0.00, 0.088, -0.250, 0.026, 0.052, 0.150, STEEL],     // prong up
      [0.00, -0.108, -0.250, 0.026, 0.052, 0.150, STEEL],    // prong down
      [0.090, -0.010, -0.250, 0.052, 0.026, 0.150, STEEL],   // prong right
      [-0.090, -0.010, -0.250, 0.052, 0.026, 0.150, STEEL],  // prong left
      [0.00, -0.115, 0.110, 0.052, 0.105, 0.062, GUNDARK],   // grip
      [0.00, 0.075, 0.115, 0.070, 0.040, 0.110, BFG_GREEN],  // capacitor
    ],
    muzzle: [0, -0.010, -0.255],
    scale: 0.95,
  },
  // ---- CHAINSAW ---------------------------------------------------------
  {
    body: [
      ...HANDS_BACK,
      [0.00, 0.000, 0.075, 0.092, 0.118, 0.210, HOTRED],     // motor housing
      [0.00, 0.085, 0.110, 0.032, 0.055, 0.150, GUNDARK],    // top handle
      [0.00, -0.045, -0.045, 0.060, 0.070, 0.090, GUNDARK],  // shroud
      [0.00, 0.040, 0.170, 0.052, 0.040, 0.040, BRASS],      // pull start
    ],
    moving: [
      [0.00, -0.020, -0.245, 0.026, 0.062, 0.360, STEEL],    // bar
      [0.00, 0.016, -0.245, 0.032, 0.014, 0.365, GUNLIGHT],  // top teeth
      [0.00, -0.056, -0.245, 0.032, 0.014, 0.365, GUNLIGHT], // bottom teeth
    ],
    motion: 'shake',
    muzzle: [0, -0.020, -0.420],
  },
];

/* ------------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------------ */

/** Cube corners per face, in the shared Face order, wound counter-clockwise. */
const CUBE_FACES: readonly number[][] = [
  [1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1],       // PX
  [-1, -1, -1, -1, -1, 1, -1, 1, 1, -1, 1, -1],   // NX
  [-1, 1, -1, -1, 1, 1, 1, 1, 1, 1, 1, -1],       // PY
  [-1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1],   // NY
  [-1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1],       // PZ
  [-1, -1, -1, -1, 1, -1, 1, 1, -1, 1, -1, -1],   // NZ
];

/** Global size trim applied on top of each weapon's own scale. */
const MODEL_SCALE = 0.68;

function buildBoxGeometry(boxes: readonly Box[], scale: number): THREE.BufferGeometry {
  const quads = boxes.length * 6;
  const pos = new Float32Array(quads * 4 * 3);
  const face = new Float32Array(quads * 4);
  const col = new Float32Array(quads * 4 * 3);
  const idx = new Uint16Array(quads * 6);

  let v = 0;
  let ii = 0;
  for (let b = 0; b < boxes.length; b++) {
    const box = boxes[b];
    const cx = box[0] * scale, cy = box[1] * scale, cz = box[2] * scale;
    const hx = box[3] * 0.5 * scale, hy = box[4] * 0.5 * scale, hz = box[5] * 0.5 * scale;
    const c = box[6];
    const r = ((c >>> 16) & 0xff) / 255;
    const g = ((c >>> 8) & 0xff) / 255;
    const bl = (c & 0xff) / 255;

    for (let f = 0; f < 6; f++) {
      const corners = CUBE_FACES[f];
      const base = v;
      for (let k = 0; k < 4; k++) {
        pos[v * 3 + 0] = cx + corners[k * 3 + 0] * hx;
        pos[v * 3 + 1] = cy + corners[k * 3 + 1] * hy;
        pos[v * 3 + 2] = cz + corners[k * 3 + 2] * hz;
        face[v] = f;
        col[v * 3 + 0] = r;
        col[v * 3 + 1] = g;
        col[v * 3 + 2] = bl;
        v++;
      }
      idx[ii++] = base;
      idx[ii++] = base + 1;
      idx[ii++] = base + 2;
      idx[ii++] = base;
      idx[ii++] = base + 2;
      idx[ii++] = base + 3;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aFace', new THREE.BufferAttribute(face, 1));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
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
uniform float uFaceLight[6];
in vec3 position;
in float aFace;
in vec3 aColor;
out vec3 vColor;
out float vLight;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vColor = aColor;
  vLight = uFaceLight[int(aFace + 0.5)];
}
`;

const VM_FRAG = /* glsl */ `
precision mediump float;
uniform float uMuzzle;
uniform vec3  uMuzzleColor;
uniform vec3  uTint;
in vec3 vColor;
in float vLight;
layout(location = 0) out vec4 fragColor;
void main() {
  vec3 c = vColor * uTint * vLight;
  // The flash lights the gun that made it. Half of "the shot happened" is this.
  // Kept under a full blow-out: a paper-white silhouette reads as a bug, a hot
  // rim on the metal reads as a gunshot.
  c += vColor * uMuzzleColor * uMuzzle * (0.30 + 0.55 * vLight);
  c += uMuzzleColor * uMuzzle * 0.11;
  fragColor = vec4(c, 1.0);
}
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

export interface ViewmodelOptions {
  fov?: number;
  handed?: 'right' | 'left';
  /** Multiplier on all procedural motion. 0 pins the gun (accessibility). */
  motionScale?: number;
}

/** Impulse gain converting the shared viewKick* table into spring velocity. */
const IMPULSE_GAIN = 6;
const KICK_DAMPING = 0.62;
const MAX_KICK_OFFSET = 0.22;
const MAX_KICK_ANGLE = 0.26;

export class Viewmodel implements OverlayPass {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly root = new THREE.Object3D();

  private readonly material: THREE.RawShaderMaterial;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly faceLight = new Float32Array(6);

  private readonly bodyGeo: (THREE.BufferGeometry | null)[] = new Array(WEAPON_COUNT).fill(null);
  private readonly moveGeo: (THREE.BufferGeometry | null)[] = new Array(WEAPON_COUNT).fill(null);
  private readonly bodyMesh: THREE.Mesh;
  private readonly moveMesh: THREE.Mesh;
  private readonly movePivot = new THREE.Object3D();

  private weapon: number = WeaponId.PISTOL;
  private pendingWeapon = -1;
  private handSign = 1;
  private motionScale = 1;
  private bobEnabled = true;
  private enabled = true;
  private aspect = 1.6;
  private disposed = false;

  // spring state
  private px = 0; private py = 0; private pz = 0;
  private vx = 0; private vy = 0; private vz = 0;
  private rx = 0; private ry = 0; private rz = 0;
  private wx = 0; private wy = 0; private wz = 0;
  private kickSide = 1;

  // procedural state
  private bobPhase = 0;
  private swayX = 0; private swayY = 0; private swayRoll = 0;
  private prevYaw = 0; private prevPitch = 0; private haveAngles = false;
  private landDip = 0;
  private sprintT = 0;
  private crouchT = 0;
  private raise = 1;
  private switchPhase: 'idle' | 'out' | 'in' = 'idle';
  private switchTimer = 0;
  private switchDuration = 1;
  private reloadTimer = 0;
  private reloadDuration = 0;
  private muzzle = 0;
  private muzzleDecay = 20;
  private ambient = 1.02;
  private sun = 0.46;
  private spin = 0;
  private spinAngle = 0;
  private shake = 0;

  constructor(opts: ViewmodelOptions = {}) {
    this.camera = new THREE.PerspectiveCamera(opts.fov ?? 58, this.aspect, 0.01, 8);
    this.handSign = opts.handed === 'left' ? -1 : 1;
    this.motionScale = opts.motionScale ?? 1;

    this.rebuildFaceLight();
    this.uniforms = {
      uFaceLight: { value: this.faceLight },
      uMuzzle: { value: 0 },
      uMuzzleColor: { value: new THREE.Vector3(1, 0.82, 0.55) },
      uTint: { value: new THREE.Vector3(1, 1, 1) },
    };
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader: VM_VERT,
      fragmentShader: VM_FRAG,
      side: THREE.FrontSide,
      depthTest: true,
      depthWrite: true,
      fog: false,
      lights: false,
      toneMapped: false,
    });
    this.material.name = 'viewmodel';

    this.bodyMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.moveMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.bodyMesh.frustumCulled = false;
    this.moveMesh.frustumCulled = false;
    this.movePivot.add(this.moveMesh);
    this.root.add(this.bodyMesh);
    this.root.add(this.movePivot);
    this.scene.add(this.root);
    this.scene.add(this.camera);

    this.setWeapon(WeaponId.PISTOL, true);
  }

  /* -- geometry cache ---------------------------------------------------- */

  private shapeFor(id: number): WeaponShape {
    return SHAPES[id] ?? SHAPES[WeaponId.PISTOL];
  }

  private geometryFor(id: number): [THREE.BufferGeometry, THREE.BufferGeometry | null] {
    let body = this.bodyGeo[id];
    if (body === null) {
      const shape = this.shapeFor(id);
      const scale = shape.scale ?? 1;
      body = buildBoxGeometry(shape.body, scale * MODEL_SCALE);
      this.bodyGeo[id] = body;
      if (shape.moving !== undefined) {
        this.moveGeo[id] = buildBoxGeometry(shape.moving, scale * MODEL_SCALE);
      }
    }
    return [body, this.moveGeo[id]];
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
    const [body, moving] = this.geometryFor(id);
    this.bodyMesh.geometry = body;
    if (moving !== null) {
      this.moveMesh.geometry = moving;
      this.moveMesh.visible = true;
    } else {
      this.moveMesh.visible = false;
    }
    this.movePivot.rotation.set(0, 0, 0);
    this.movePivot.position.set(0, 0, 0);
    this.spinAngle = 0;
    const def = getWeapon(id);
    const mc = def.muzzleColor;
    (this.uniforms.uMuzzleColor.value as THREE.Vector3).set(
      ((mc >>> 16) & 0xff) / 255, ((mc >>> 8) & 0xff) / 255, (mc & 0xff) / 255,
    );
  }

  /** One shot fired. Kicks the spring and lights the muzzle. */
  fire(weaponId?: number): void {
    const def = getWeapon(weaponId ?? this.weapon);
    const g = IMPULSE_GAIN * this.motionScale;
    const s = this.kickSide;
    this.kickSide = -s;

    this.vx += def.viewKickX * g * s * this.handSign;
    this.vy += def.viewKickY * g;
    this.vz += def.viewKickZ * g;
    this.wx += def.viewKickPitch * g;
    this.wy += def.viewKickYaw * g * s;
    this.wz += def.viewKickRoll * g * s;

    if (def.muzzleMs > 0) {
      this.muzzle = 1;
      this.muzzleDecay = 1000 / def.muzzleMs;
    }
    this.shake = Math.min(1, this.shake + 0.6);
  }

  /** Play a reload pose for `ms`. Pass the weapon's real reload duration. */
  reload(ms: number): void {
    this.reloadDuration = Math.max(0.05, ms / 1000);
    this.reloadTimer = 0;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.root.visible = on;
  }

  setBobEnabled(on: boolean): void {
    this.bobEnabled = on;
  }

  setMotionScale(v: number): void {
    this.motionScale = clamp(v, 0, 2);
  }

  setHanded(h: 'right' | 'left'): void {
    this.handSign = h === 'left' ? -1 : 1;
  }

  setFov(deg: number): void {
    this.camera.fov = deg;
    this.camera.updateProjectionMatrix();
  }

  /** Colour grade, e.g. push red while the player is hurt. */
  setTint(r: number, g: number, b: number): void {
    (this.uniforms.uTint.value as THREE.Vector3).set(r, g, b);
    this.material.uniformsNeedUpdate = true;
  }

  /** Overall brightness of the model. Higher reads better against dark fog. */
  setLightBalance(ambient: number, sun: number): void {
    this.ambient = ambient;
    this.sun = sun;
    this.rebuildFaceLight();
  }

  private rebuildFaceLight(): void {
    const nx = [1, -1, 0, 0, 0, 0];
    const ny = [0, 0, 1, -1, 0, 0];
    const nz = [0, 0, 0, 0, 1, -1];
    let len = Math.hypot(SUN_DIR_X, SUN_DIR_Y, SUN_DIR_Z);
    if (len < 1e-5) len = 1;
    const lx = -SUN_DIR_X / len, ly = -SUN_DIR_Y / len, lz = -SUN_DIR_Z / len;
    for (let f = 0; f < 6; f++) {
      const ndl = Math.max(0, nx[f] * lx + ny[f] * ly + nz[f] * lz);
      this.faceLight[f] = FACE_SHADE[f] * (this.ambient + this.sun * ndl);
    }
    // The constructor calls this before the material exists.
    if (this.material !== undefined) this.material.uniformsNeedUpdate = true;
  }

  /** Muzzle position in viewmodel space, after all animation. */
  getMuzzleLocal(out: THREE.Vector3): THREE.Vector3 {
    const m = this.shapeFor(this.weapon).muzzle;
    const s = (this.shapeFor(this.weapon).scale ?? 1) * MODEL_SCALE;
    out.set(m[0] * s, m[1] * s, m[2] * s);
    this.root.updateMatrix();
    out.applyMatrix4(this.root.matrix);
    return out;
  }

  /** 0..1, decays over the weapon's muzzleMs. Drive fx and audio from it. */
  get muzzleFlash(): number {
    return this.muzzle;
  }

  /* -- per frame --------------------------------------------------------- */

  update(dt: number, input: ViewmodelInput): void {
    if (this.disposed || !this.enabled) return;
    const step = Math.min(dt, 0.05);
    const ms = this.motionScale;

    // --- switch ---------------------------------------------------------
    if (this.switchPhase !== 'idle') {
      this.switchTimer += step;
      const t = clamp(this.switchTimer / this.switchDuration, 0, 1);
      if (this.switchPhase === 'out') {
        this.raise = 1 - t;
        if (t >= 1) {
          if (this.pendingWeapon >= 0) this.applyWeapon(this.pendingWeapon);
          this.pendingWeapon = -1;
          this.switchPhase = 'in';
          this.switchTimer = 0;
          this.switchDuration = Math.max(1, getWeapon(this.weapon).switchInMs) / 1000;
        }
      } else {
        this.raise = t;
        if (t >= 1) this.switchPhase = 'idle';
      }
    } else {
      this.raise = 1;
    }

    // --- sway -----------------------------------------------------------
    if (!this.haveAngles) {
      this.prevYaw = input.yaw;
      this.prevPitch = input.pitch;
      this.haveAngles = true;
    }
    const yawRate = wrapAngle(input.yaw - this.prevYaw) / Math.max(step, 1e-4);
    const pitchRate = (input.pitch - this.prevPitch) / Math.max(step, 1e-4);
    this.prevYaw = input.yaw;
    this.prevPitch = input.pitch;

    const swayTX = clamp(-yawRate * 0.016, -0.06, 0.06) * ms;
    const swayTY = clamp(pitchRate * 0.014, -0.05, 0.05) * ms;
    const swayTR = clamp(-yawRate * 0.045, -0.14, 0.14) * ms;
    this.swayX = expDecay(this.swayX, swayTX, 11, step);
    this.swayY = expDecay(this.swayY, swayTY, 11, step);
    this.swayRoll = expDecay(this.swayRoll, swayTR, 9, step);

    // --- bob ------------------------------------------------------------
    const speedFrac = clamp(input.speed / SPEED_RUN, 0, 1.4);
    let bobX = 0, bobY = 0, bobRoll = 0;
    if (this.bobEnabled && input.grounded && speedFrac > 0.06) {
      this.bobPhase += TAU * VIEW_BOB_HZ * speedFrac * step;
      if (this.bobPhase > TAU) this.bobPhase -= TAU;
      const amp = VIEW_BOB_AMPLITUDE * speedFrac * ms;
      bobX = Math.sin(this.bobPhase) * amp * 1.7;
      bobY = (Math.cos(this.bobPhase * 2) * 0.5 - 0.5) * amp * 1.25;
      bobRoll = Math.sin(this.bobPhase) * 0.030 * speedFrac * ms;
    } else {
      // Idle breathing, tiny but it stops the gun reading as a decal when still.
      this.bobPhase += TAU * 0.32 * step;
      if (this.bobPhase > TAU) this.bobPhase -= TAU;
      bobY = Math.sin(this.bobPhase) * 0.0035 * ms;
      bobX = Math.sin(this.bobPhase * 0.5) * 0.0025 * ms;
    }

    // --- landing --------------------------------------------------------
    if (input.landImpact > 0) {
      this.landDip = Math.max(this.landDip, LAND_DIP_MAX * clamp(input.landImpact, 0, 1) * ms);
      input.landImpact = 0;
    }
    this.landDip = expDecay(this.landDip, 0, 9, step);

    // --- pose blends ----------------------------------------------------
    const sprintTarget = input.sprinting && speedFrac > 0.55 && !input.firing ? 1 : 0;
    this.sprintT = expDecay(this.sprintT, sprintTarget, 9, step);
    this.crouchT = expDecay(this.crouchT, input.crouching ? 1 : 0, 12, step);

    let reloadPose = 0;
    if (this.reloadDuration > 0) {
      this.reloadTimer += step;
      const t = this.reloadTimer / this.reloadDuration;
      if (t >= 1) {
        this.reloadDuration = 0;
      } else {
        reloadPose = Math.sin(Math.PI * t);
      }
    } else if (input.reloading) {
      reloadPose = 1;
    }

    // --- kick spring ----------------------------------------------------
    this.integrateSpring(getWeapon(this.weapon).viewKickRecovery, step);

    // --- muzzle / spin --------------------------------------------------
    if (this.muzzle > 0) {
      this.muzzle -= this.muzzleDecay * step;
      if (this.muzzle < 0) this.muzzle = 0;
    }
    this.uniforms.uMuzzle.value = this.muzzle;

    const def = getWeapon(this.weapon);
    const shape = this.shapeFor(this.weapon);
    if (shape.motion === 'rotate') {
      const up = def.spinUpMs > 0 ? 1000 / def.spinUpMs : 12;
      const down = def.spinDownMs > 0 ? 1000 / def.spinDownMs : 6;
      const target = input.firing ? 1 : 0;
      const rate = target > this.spin ? up : down;
      this.spin += (target - this.spin) * Math.min(1, rate * step);
      this.spinAngle += this.spin * 26 * step;
      this.movePivot.rotation.z = this.spinAngle;
    } else if (shape.motion === 'shake') {
      const held = input.firing && def.kind === FireKind.MELEE;
      this.shake = expDecay(this.shake, held ? 0.8 : 0, 8, step);
      const t = this.bobPhase * 9 + this.spinAngle;
      this.spinAngle += step * 40;
      this.movePivot.position.set(
        Math.sin(t * 1.7) * 0.004 * this.shake,
        Math.cos(t * 2.3) * 0.005 * this.shake,
        this.shake * 0.012,
      );
    }
    this.material.uniformsNeedUpdate = true;

    // --- compose --------------------------------------------------------
    const aspectPull = clamp(this.aspect / 1.6, 0.34, 1);
    const restX = 0.185 * aspectPull * this.handSign;
    const restY = -0.132 - 0.018 * (1 - aspectPull);
    const restZ = -0.545;

    const lowered = 1 - this.raise;
    const px = restX
      + (this.swayX + bobX + this.px) * this.handSign
      + 0.055 * this.sprintT * this.handSign;
    const py = restY + this.swayY + bobY + this.py
      - this.landDip
      - 0.030 * this.sprintT
      - 0.018 * this.crouchT
      - 0.095 * reloadPose
      - 0.46 * lowered;
    const pz = restZ + this.pz + 0.030 * this.sprintT + 0.02 * reloadPose;

    this.root.position.set(px, py, pz);
    this.root.rotation.set(
      this.rx + this.landDip * 0.9 - 0.20 * this.sprintT - 0.55 * reloadPose - 0.95 * lowered,
      this.ry + 0.44 * this.sprintT * this.handSign + 0.10 * reloadPose * this.handSign,
      this.rz + this.swayRoll + bobRoll + 0.17 * this.sprintT * this.handSign + 0.22 * reloadPose * this.handSign,
    );
    this.root.updateMatrix();
    this.root.matrixWorld.copy(this.root.matrix);
  }

  /**
   * Underdamped spring per axis. Substepped so a 100 ms hitch cannot make the
   * BFG's recovery term explode.
   */
  private integrateSpring(omega: number, dt: number): void {
    const w = Math.max(1, omega);
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
      this.moveGeo[i]?.dispose();
      this.bodyGeo[i] = null;
      this.moveGeo[i] = null;
    }
    this.material.dispose();
  }
}

const _tmpSize = new THREE.Vector2();
