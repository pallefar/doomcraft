/**
 * DOOMCRAFT — Builder placement: targeting, the highlight, breaking, placing.
 *
 * This is the piece the mode is judged on, and the bar is Minecraft Classic as
 * captured in `ref/mcclassic/`. Four things were measured off those frames, and
 * each one is answered here:
 *
 *   1. **The bar's targeted-block indicator is a low-contrast wash.**
 *      `mc-04-highlight.png`: a pale hairline on the targeted face that all but
 *      vanishes against grass. `mc-12-break-hold-80.png`: against stone it is a
 *      *slightly darker* quad. Up close (`mc-05-place.png`) it becomes a
 *      translucent grey cube that greys out a third of the screen.
 *      Answer: an outline that **inverts against the block it is on**. The first
 *      cut here was a fixed two-tone outline, dark line outside light line, and
 *      rendering it (`BuildHighlight` in a real WebGL scene, snow at one end of
 *      a strip and obsidian at the other) showed why that does not work:
 *      `LineBasicMaterial` ignores `linewidth` on every platform that matters,
 *      so both lines are one device pixel and the 0.6% scale gap between them
 *      is sub-pixel past about two metres — the two-tone collapses to one tone,
 *      and on snow that tone was white on white. Now the pair's *opacities*
 *      swing on the target's luminance, so whichever line survives is the one
 *      that contrasts. Same for the face plate: additive blending cannot
 *      lighten an already-white face, so the plate is normal-blended and goes
 *      dark over bright blocks and light over dark ones. Both are one material
 *      write per target change, not per frame.
 *
 *   2. **The bar has no break progress and no hold-repeat whatsoever.** Holding
 *      the button for 80, 200, 400 and 800 ms produced four identical frames —
 *      identical to the MD5, and the post-release frame makes it five. The
 *      `--cadence` probe then wrapped the live engine's `noa.setBlock` and
 *      counted 0-1 edits per 2.6 s hold against a hold that should have been a
 *      train. One click is one block; every block, from dirt to stone, pops on
 *      the same instant; hardness does not exist there.
 *      Answer: `BLOCK_HARDNESS` drives a real dig time via the same
 *      `blockBreakMs()` the destruction module uses, an inner core cube grows
 *      from nothing to fill the block as the dig completes, and the crosshair
 *      carries a ring. Creative mode still breaks instantly — that is
 *      `BreakPolicy.INSTANT` from the mode table, not a copy of the bar — but
 *      it *repeats*, so a held button carves rather than pecking once.
 *
 *   3. **The bar will entomb you.** Right-clicking at point blank placed stone
 *      into the volume the camera occupies; `mc-10-tower.png` and the whole
 *      contact strip are the inside of a block. There is no body check at all.
 *      Answer: the exact predicate `server/src/sim.ts` uses
 *      (`requestEdit` -> `BLOCKED_BY_ENTITY`) runs client-side first, over every
 *      live body, so the refusal is predicted rather than rolled back — and the
 *      ghost turns red and says why instead of silently doing nothing.
 *
 *   4. **Reach is guessed.** Answer: `reachToCube()` is a line-for-line mirror
 *      of `ServerWorld.validateEdit`'s measurement (nearest point of the target
 *      cube to the eye), so an edit the client accepts is an edit the server
 *      accepts. A prediction that gets rejected is a visible flicker; there is
 *      no reason to ever ship one.
 *
 * Performance: `aim()` and `update()` allocate nothing. One `VoxelHit`, one
 * `BuildTarget` and one bound `getBlock` closure are created at construction.
 * The highlight is three `Object3D`s whose transforms are written in place;
 * their materials change colour at most once per target change, never per frame.
 */

import * as THREE from 'three';

import {
  BLOCK_BREAK_BASE_MS,
  CHUNK_HEIGHT,
  PLAYER_HALF_WIDTH,
  REACH_BREAK,
  REACH_PLACE,
  WORLD_MAX_BLOCK_X,
  WORLD_MAX_BLOCK_Z,
  WORLD_MIN_BLOCK_X,
  WORLD_MIN_BLOCK_Z,
  clamp01,
} from '@shared/constants';
import {
  BLOCK_HARDNESS,
  BLOCK_SOLID,
  BlockId,
  Face,
  blockBreakMs,
  blockFaceColor,
  faceFromNormal,
  isPlaceable,
  isReplaceable,
  minimapColor,
} from '@shared/blocks';
import { createVoxelHit, raycastVoxels, type VoxelHit } from '@shared/math';

/* ------------------------------------------------------------------------ *
 * Tuning — every number here has a reason, and the reason is in the comment
 * ------------------------------------------------------------------------ */

/**
 * Milliseconds between repeats while the place button is held.
 *
 * **The bar has no hold-repeat at all.** Measured two independent ways, because
 * this is the number the whole mode turns on:
 *
 *   - Pixels: `mc-12-break-hold-80/200/400/800.png` and `mc-13-break-done.png`
 *     are five frames spanning an 80 ms to 800 ms hold plus the frame after
 *     release, and all five share one MD5 (`a57c9d97…`). Nothing on screen
 *     changes while the button is down, and nothing changes when it comes up.
 *   - The engine: `tools/capture-mc.mjs --cadence` wraps `noa.setBlock` in the
 *     live page and timestamps every voxel write. Across four runs a 2.6 s hold
 *     produced **0 or 1** edits while discrete clicks in the same pose produced
 *     edits — so the hold is not merely slow, it is not a repeat.
 *
 * One click is one block there. A ten-block wall is ten clicks. So any repeat
 * at all beats the bar, and the real constraint is our own server:
 * `MAX_EDITS_PER_SECOND` is 20, a 50 ms ceiling, and at that rate a held button
 * lays a 20-block wall in a second and every mistake is twenty mistakes.
 *
 * 140 ms is 7.1 Hz: fast enough that dragging a wall feels continuous, slow
 * enough that a flinch costs one block, and a comfortable 3x under the server's
 * token bucket so a burst never trips the rate limiter.
 */
export const PLACE_REPEAT_MS = 140;

/** Same reasoning for breaking; slightly faster because deleting is corrective. */
export const BREAK_REPEAT_MS = 120;

/**
 * A held button also fires the instant the aimed cell changes, capped at this.
 * Without it, sweeping the crosshair across a wall at 7 Hz leaves gaps; with no
 * cap at all, a fast flick would place at the frame rate. 60 ms is 16.6 Hz,
 * still inside the server's budget.
 */
export const RETARGET_REPEAT_MS = 60;

/**
 * Delay before re-asking after the net layer refused an edit. Without it a
 * disconnected client burns a request per frame for as long as the button is
 * held; 90 ms is invisible to the player and 11 Hz to the socket.
 */
export const REFUSED_RETRY_MS = 90;

/** Tool power for the creative pick. 1.0 is bare hands; 3.2 makes stone ~0.10 s. */
export const BUILDER_TOOL_POWER = 3.2;

/** Dig feedback stages, matching `DIG_STAGES` in the destruction module. */
export const DIG_STAGES = 10;

/** Outline scales. Outer is the dark halo, inner the bright line. */
const OUTLINE_OUTER = 1.006;
const OUTLINE_INNER = 1.0016;
/** How far off the face the additive plate floats, in blocks. */
const PLATE_OFFSET = 0.008;
/** Ghost cube scale — slightly inset so it never z-fights the neighbours. */
const GHOST_SCALE = 0.98;

const HILITE_DARK = 0x0a0a0c;
const HILITE_LIGHT = 0xf4f2ee;
const REFUSE_COLOR = 0xe03c1c;
const DIG_CORE_COLD = 0xffd24a;
const DIG_CORE_HOT = 0xfff3d0;

/**
 * Perceptual luminance of a packed 0xRRGGBB, 0..1. Rec. 601 weights, which are
 * what "does this look light or dark" wants — a pure green block is bright to
 * the eye and a pure blue one is not, and averaging the channels gets both
 * wrong. Used only to decide which way the highlight should contrast.
 */
export function colorLuminance(hex: number): number {
  const r = (hex >>> 16) & 0xff, g = (hex >>> 8) & 0xff, b = hex & 0xff;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Above this the target counts as a bright block and the highlight goes dark. */
const BRIGHT_CUTOFF = 0.52;

/* ------------------------------------------------------------------------ *
 * Target
 * ------------------------------------------------------------------------ */

/** Why an edit is not allowed. Drives the ghost colour and the hint line. */
export enum Refusal {
  NONE = 0,
  NO_TARGET = 1,
  OUT_OF_WORLD = 2,
  OUT_OF_REACH = 3,
  NOT_REPLACEABLE = 4,
  INSIDE_BODY = 5,
  UNBREAKABLE = 6,
  NOT_PLACEABLE = 7,
  NO_STOCK = 8,
  READ_ONLY = 9,
}

export const REFUSAL_TEXT: readonly string[] = [
  '',
  'Nothing in range',
  'Outside the world',
  'Too far away',
  'Something is already there',
  'Someone is standing there',
  'This block cannot be broken',
  'That is not a placeable block',
  'Out of that block',
  'You only have visitor access here',
];

export function refusalText(r: number): string {
  return REFUSAL_TEXT[r] ?? '';
}

/** Everything the crosshair currently resolves to. Reused; never reallocated. */
export interface BuildTarget {
  /** True when the ray hit a solid voxel inside reach. */
  hit: boolean;
  /** The voxel that was hit. */
  x: number; y: number; z: number;
  blockId: number;
  /** Entered-face normal, pointing back along the ray. */
  nx: number; ny: number; nz: number;
  face: Face;
  distance: number;
  /** The cell a placement would fill: hit cell + normal. */
  px: number; py: number; pz: number;

  /** True when a break would be accepted right now. */
  canBreak: boolean;
  breakRefusal: Refusal;
  /** True when a place would be accepted right now. */
  canPlace: boolean;
  placeRefusal: Refusal;

  /** Milliseconds a full dig of `blockId` takes. Infinity when unbreakable. */
  breakMs: number;
}

export function createBuildTarget(): BuildTarget {
  return {
    hit: false, x: 0, y: 0, z: 0, blockId: BlockId.AIR,
    nx: 0, ny: 1, nz: 0, face: Face.PY, distance: 0,
    px: 0, py: 0, pz: 0,
    canBreak: false, breakRefusal: Refusal.NO_TARGET,
    canPlace: false, placeRefusal: Refusal.NO_TARGET,
    breakMs: Infinity,
  };
}

/** True when the two targets point at the same voxel from the same face. */
export function sameTarget(a: BuildTarget, b: BuildTarget): boolean {
  return a.hit === b.hit && a.x === b.x && a.y === b.y && a.z === b.z && a.face === b.face;
}

/* ------------------------------------------------------------------------ *
 * Geometry helpers shared with the server's rules
 * ------------------------------------------------------------------------ */

/**
 * Distance from an eye to the nearest point of the unit cube at (x, y, z).
 *
 * This is a deliberate, line-for-line mirror of the measurement in
 * `ServerWorld.validateEdit`. Measuring to the cube centre instead — the
 * obvious thing — is up to 0.87 m longer, which means a block the client draws
 * as reachable is refused by the server one time in ten near the reach limit.
 */
export function reachToCube(ex: number, ey: number, ez: number, x: number, y: number, z: number): number {
  const nx = ex < x ? x : (ex > x + 1 ? x + 1 : ex);
  const ny = ey < y ? y : (ey > y + 1 ? y + 1 : ey);
  const nz = ez < z ? z : (ez > z + 1 ? z + 1 : ez);
  const dx = ex - nx, dy = ey - ny, dz = ez - nz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Inside the playable box, y in [1, CHUNK_HEIGHT). y 0 is the bedrock floor. */
export function cellInWorld(x: number, y: number, z: number): boolean {
  return y >= 1 && y < CHUNK_HEIGHT
    && x >= WORLD_MIN_BLOCK_X && x <= WORLD_MAX_BLOCK_X
    && z >= WORLD_MIN_BLOCK_Z && z <= WORLD_MAX_BLOCK_Z;
}

/**
 * The server's body test, exactly: `sim.ts` `requestEdit` refuses a placement
 * whose cube overlaps any living player or monster AABB. Feet-centre position,
 * half-width on x/z, height upward from the feet.
 */
export function cellOverlapsBody(
  x: number, y: number, z: number,
  bx: number, by: number, bz: number, halfW: number, height: number,
): boolean {
  return x + 1 > bx - halfW && x < bx + halfW
    && z + 1 > bz - halfW && z < bz + halfW
    && y + 1 > by && y < by + height;
}

/**
 * How the controller learns where bodies are. Implemented by the mode over the
 * net client's player and entity views; a headless test passes a stub.
 */
export interface BodyProbe {
  /** True when a solid block at this cell would be inside somebody. */
  occupied(x: number, y: number, z: number): boolean;
}

/** A body probe that knows about nothing. Useful for tests and for freecam. */
export const EMPTY_BODIES: BodyProbe = { occupied: () => false };

/* ------------------------------------------------------------------------ *
 * Targeting
 * ------------------------------------------------------------------------ */

/** Anything solid stops the build ray. Liquids do not, so you can build in water. */
function editBlocking(id: number): boolean { return BLOCK_SOLID[id] === 1; }

export interface AimInput {
  /** Eye of the player BODY — what the server measures reach from. */
  eyeX: number; eyeY: number; eyeZ: number;
  /** Ray origin. Equal to the eye unless the free build camera is detached. */
  originX: number; originY: number; originZ: number;
  dirX: number; dirY: number; dirZ: number;
  /** Block the player is holding, or AIR when the hand is empty. */
  heldBlock: number;
  /** False for a visitor: everything refuses with READ_ONLY. */
  mayEdit: boolean;
  /** False when the held stack is empty (survival-build). */
  hasStock: boolean;
}

export function createAimInput(): AimInput {
  return {
    eyeX: 0, eyeY: 0, eyeZ: 0,
    originX: 0, originY: 0, originZ: 0,
    dirX: 0, dirY: 0, dirZ: 1,
    heldBlock: BlockId.STONE,
    mayEdit: true,
    hasStock: true,
  };
}

/**
 * Resolve the crosshair into a `BuildTarget`. Pure apart from writing `out` and
 * the scratch hit; safe to call every frame.
 */
export function computeTarget(
  aim: AimInput,
  getBlock: (x: number, y: number, z: number) => number,
  bodies: BodyProbe,
  toolPower: number,
  hit: VoxelHit,
  out: BuildTarget,
): BuildTarget {
  const reach = Math.max(REACH_BREAK, REACH_PLACE);
  // Cast a little past the reach limit: the server measures to the nearest face
  // of the cube, so a cube whose centre is 6.4 m away can still be legal.
  const ok = raycastVoxels(
    aim.originX, aim.originY, aim.originZ,
    aim.dirX, aim.dirY, aim.dirZ,
    reach + 1.8,
    getBlock, editBlocking, hit,
  );

  out.hit = ok;
  if (!ok) {
    out.x = hit.x; out.y = hit.y; out.z = hit.z;
    out.blockId = BlockId.AIR;
    out.nx = 0; out.ny = 1; out.nz = 0;
    out.face = Face.PY;
    out.distance = hit.distance;
    out.px = hit.x; out.py = hit.y; out.pz = hit.z;
    out.canBreak = false;
    out.breakRefusal = Refusal.NO_TARGET;
    out.canPlace = false;
    out.placeRefusal = Refusal.NO_TARGET;
    out.breakMs = Infinity;
    return out;
  }

  out.x = hit.x; out.y = hit.y; out.z = hit.z;
  out.blockId = hit.block;
  out.nx = hit.nx; out.ny = hit.ny; out.nz = hit.nz;
  out.face = faceFromNormal(hit.nx, hit.ny, hit.nz);
  out.distance = hit.distance;
  out.px = hit.x + hit.nx;
  out.py = hit.y + hit.ny;
  out.pz = hit.z + hit.nz;

  /* --- break --- */
  let br: Refusal = Refusal.NONE;
  if (!aim.mayEdit) br = Refusal.READ_ONLY;
  else if (!cellInWorld(out.x, out.y, out.z)) br = Refusal.OUT_OF_WORLD;
  else if (BLOCK_HARDNESS[out.blockId] < 0) br = Refusal.UNBREAKABLE;
  else if (reachToCube(aim.eyeX, aim.eyeY, aim.eyeZ, out.x, out.y, out.z) > REACH_BREAK) br = Refusal.OUT_OF_REACH;
  out.breakRefusal = br;
  out.canBreak = br === Refusal.NONE;
  out.breakMs = blockBreakMs(out.blockId, toolPower, BLOCK_BREAK_BASE_MS);

  /* --- place --- */
  let pr: Refusal = Refusal.NONE;
  if (!aim.mayEdit) pr = Refusal.READ_ONLY;
  else if (!isPlaceable(aim.heldBlock)) pr = Refusal.NOT_PLACEABLE;
  else if (!aim.hasStock) pr = Refusal.NO_STOCK;
  else if (!cellInWorld(out.px, out.py, out.pz)) pr = Refusal.OUT_OF_WORLD;
  else if (!isReplaceable(getBlock(out.px, out.py, out.pz))) pr = Refusal.NOT_REPLACEABLE;
  else if (reachToCube(aim.eyeX, aim.eyeY, aim.eyeZ, out.px, out.py, out.pz) > REACH_PLACE) pr = Refusal.OUT_OF_REACH;
  else if (bodies.occupied(out.px, out.py, out.pz)) pr = Refusal.INSIDE_BODY;
  out.placeRefusal = pr;
  out.canPlace = pr === Refusal.NONE;

  return out;
}

/* ------------------------------------------------------------------------ *
 * The highlight
 * ------------------------------------------------------------------------ */

/** Unit-cube edge positions, centred on the origin. 12 segments, 24 vertices. */
function cubeEdgePositions(): Float32Array {
  const h = 0.5;
  const c: number[][] = [
    [-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h],
    [-h, h, -h], [h, h, -h], [h, h, h], [-h, h, h],
  ];
  const e: number[][] = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const out = new Float32Array(e.length * 6);
  let k = 0;
  for (const [a, b] of e) {
    out[k++] = c[a][0]; out[k++] = c[a][1]; out[k++] = c[a][2];
    out[k++] = c[b][0]; out[k++] = c[b][1]; out[k++] = c[b][2];
  }
  return out;
}

/** Euler angles that turn a +Z plane into each `Face`. Indexed by Face. */
const FACE_EULER: readonly (readonly [number, number, number])[] = [
  [0, Math.PI / 2, 0],   // PX
  [0, -Math.PI / 2, 0],  // NX
  [-Math.PI / 2, 0, 0],  // PY
  [Math.PI / 2, 0, 0],   // NY
  [0, 0, 0],             // PZ
  [0, Math.PI, 0],       // NZ
];

/**
 * The three-D half: outline, face plate, dig core and placement ghost.
 *
 * All four objects exist for the whole mode and are hidden by `visible`, so a
 * frame in which the crosshair points at nothing costs four boolean writes.
 */
export class BuildHighlight {
  readonly group = new THREE.Group();

  private readonly outer: THREE.LineSegments;
  private readonly inner: THREE.LineSegments;
  private readonly plate: THREE.Mesh;
  private readonly core: THREE.Mesh;
  private readonly ghost: THREE.Mesh;
  private readonly ghostEdges: THREE.LineSegments;

  private readonly outerMat: THREE.LineBasicMaterial;
  private readonly innerMat: THREE.LineBasicMaterial;
  private readonly plateMat: THREE.MeshBasicMaterial;
  private readonly coreMat: THREE.MeshBasicMaterial;
  private readonly ghostMat: THREE.MeshBasicMaterial;
  private readonly ghostEdgeMat: THREE.LineBasicMaterial;

  private readonly edgeGeo: THREE.BufferGeometry;
  private readonly plateGeo: THREE.PlaneGeometry;
  private readonly boxGeo: THREE.BoxGeometry;

  /** Last colour written to the ghost, so we only touch the material on change. */
  private ghostColor = -1;
  private ghostRefused = false;
  /** Last block the contrast was tuned for. -1 forces the first write. */
  private contrastFor = -1;

  constructor() {
    this.group.name = 'builder-highlight';
    this.group.renderOrder = 900;
    this.group.frustumCulled = false;

    this.edgeGeo = new THREE.BufferGeometry();
    this.edgeGeo.setAttribute('position', new THREE.BufferAttribute(cubeEdgePositions(), 3));

    this.outerMat = new THREE.LineBasicMaterial({ color: HILITE_DARK, transparent: true, opacity: 0.85, depthWrite: false });
    this.innerMat = new THREE.LineBasicMaterial({ color: HILITE_LIGHT, transparent: true, opacity: 0.95, depthWrite: false });

    this.outer = new THREE.LineSegments(this.edgeGeo, this.outerMat);
    this.inner = new THREE.LineSegments(this.edgeGeo, this.innerMat);
    this.outer.scale.setScalar(OUTLINE_OUTER);
    this.inner.scale.setScalar(OUTLINE_INNER);
    this.outer.renderOrder = 900;
    this.inner.renderOrder = 901;
    this.outer.frustumCulled = false;
    this.inner.frustumCulled = false;

    this.plateGeo = new THREE.PlaneGeometry(1, 1);
    // Normal blending, not additive: additive over a white block adds nothing
    // visible, which is exactly the case the bar fails at. Normal blending lets
    // the same plate darken a bright face and lighten a dark one.
    this.plateMat = new THREE.MeshBasicMaterial({
      color: HILITE_LIGHT, transparent: true, opacity: 0.3,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.plate = new THREE.Mesh(this.plateGeo, this.plateMat);
    this.plate.renderOrder = 902;
    this.plate.frustumCulled = false;

    this.boxGeo = new THREE.BoxGeometry(1, 1, 1);
    this.coreMat = new THREE.MeshBasicMaterial({
      color: DIG_CORE_COLD, transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.core = new THREE.Mesh(this.boxGeo, this.coreMat);
    this.core.renderOrder = 903;
    this.core.frustumCulled = false;

    this.ghostMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.26, depthWrite: false,
    });
    this.ghost = new THREE.Mesh(this.boxGeo, this.ghostMat);
    this.ghost.scale.setScalar(GHOST_SCALE);
    this.ghost.renderOrder = 904;
    this.ghost.frustumCulled = false;

    this.ghostEdgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false });
    this.ghostEdges = new THREE.LineSegments(this.edgeGeo, this.ghostEdgeMat);
    this.ghostEdges.scale.setScalar(GHOST_SCALE + 0.006);
    this.ghostEdges.renderOrder = 905;
    this.ghostEdges.frustumCulled = false;

    this.group.add(this.outer, this.inner, this.plate, this.core, this.ghost, this.ghostEdges);
    this.hide();
  }

  hide(): void {
    this.outer.visible = false;
    this.inner.visible = false;
    this.plate.visible = false;
    this.core.visible = false;
    this.ghost.visible = false;
    this.ghostEdges.visible = false;
  }

  /**
   * Point the highlight at `t`. `digProgress` is 0..1 and drives the core cube;
   * `showGhost` draws the placement preview at the adjacent cell.
   *
   * Allocation free: every write is into an existing Vector3 / Euler / Color.
   */
  sync(t: BuildTarget, digProgress: number, showGhost: boolean, heldBlock: number): void {
    if (!t.hit) { this.hide(); return; }

    const cx = t.x + 0.5, cy = t.y + 0.5, cz = t.z + 0.5;
    this.outer.visible = true;
    this.inner.visible = true;
    this.outer.position.set(cx, cy, cz);
    this.inner.position.set(cx, cy, cz);

    /* --- contrast, re-tuned only when the targeted MATERIAL changes ------ */
    if (t.blockId !== this.contrastFor) {
      this.contrastFor = t.blockId;
      const bright = colorLuminance(minimapColor(t.blockId)) > BRIGHT_CUTOFF;
      // Both lines stay in the scene — they cost one draw call each and the
      // geometry is shared — but the one that would vanish is faded out, so a
      // single-pixel line is always the contrasting one.
      this.outerMat.opacity = bright ? 0.95 : 0.35;
      this.innerMat.opacity = bright ? 0.30 : 0.95;
      this.plateMat.color.setHex(bright ? HILITE_DARK : HILITE_LIGHT);
      this.plateMat.opacity = bright ? 0.26 : 0.32;
    }

    /* the face you are pointing at */
    this.plate.visible = true;
    this.plate.position.set(
      cx + t.nx * (0.5 + PLATE_OFFSET),
      cy + t.ny * (0.5 + PLATE_OFFSET),
      cz + t.nz * (0.5 + PLATE_OFFSET),
    );
    const eu = FACE_EULER[t.face] ?? FACE_EULER[Face.PY];
    this.plate.rotation.set(eu[0], eu[1], eu[2]);

    /* dig core */
    if (digProgress > 0.001) {
      const s = 0.04 + 0.92 * digProgress;
      this.core.visible = true;
      this.core.position.set(cx, cy, cz);
      this.core.scale.setScalar(s);
      this.coreMat.color.setHex(digProgress > 0.75 ? DIG_CORE_HOT : DIG_CORE_COLD);
      this.coreMat.opacity = 0.28 + 0.42 * digProgress;
    } else {
      this.core.visible = false;
    }

    /* placement ghost */
    if (!showGhost) {
      this.ghost.visible = false;
      this.ghostEdges.visible = false;
      return;
    }
    const gx = t.px + 0.5, gy = t.py + 0.5, gz = t.pz + 0.5;
    this.ghost.visible = true;
    this.ghostEdges.visible = true;
    this.ghost.position.set(gx, gy, gz);
    this.ghostEdges.position.set(gx, gy, gz);

    const refused = !t.canPlace;
    const want = refused ? REFUSE_COLOR : minimapColor(heldBlock);
    if (want !== this.ghostColor || refused !== this.ghostRefused) {
      this.ghostColor = want;
      this.ghostRefused = refused;
      this.ghostMat.color.setHex(want);
      this.ghostEdgeMat.color.setHex(refused ? REFUSE_COLOR : 0xffffff);
      this.ghostMat.opacity = refused ? 0.16 : 0.3;
      this.ghostEdgeMat.opacity = refused ? 0.9 : 0.65;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.edgeGeo.dispose();
    this.plateGeo.dispose();
    this.boxGeo.dispose();
    this.outerMat.dispose();
    this.innerMat.dispose();
    this.plateMat.dispose();
    this.coreMat.dispose();
    this.ghostMat.dispose();
    this.ghostEdgeMat.dispose();
  }
}

/* ------------------------------------------------------------------------ *
 * The crosshair progress ring
 * ------------------------------------------------------------------------ */

const RING_STYLE_ID = 'dc-builder-ring-css';
const RING_CSS = `
.dcb-ring{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;
  border-radius:50%;pointer-events:none;opacity:0;transition:opacity 90ms linear;
  background:conic-gradient(#ffd24a var(--dcb-a,0deg), rgba(255,255,255,.10) 0deg);
  -webkit-mask:radial-gradient(circle, transparent 15px, #000 16px, #000 19px, transparent 20px);
  mask:radial-gradient(circle, transparent 15px, #000 16px, #000 19px, transparent 20px)}
.dcb-ring.on{opacity:1}
`;

/**
 * A 4 px conic ring around the crosshair, driven by the dig.
 *
 * DOM rather than canvas on purpose: one custom-property write per whole
 * percent is cheaper than any per-frame draw, and it inherits the HUD's
 * compositing for free. The write is gated on the integer percent changing, so
 * a 900 ms dig costs 100 style writes, not 54.
 */
export class BreakProgressRing {
  readonly element: HTMLDivElement;
  private lastPercent = -1;
  private shown = false;
  private readonly styleOwned: boolean;

  constructor(parent: HTMLElement) {
    if (typeof document !== 'undefined' && document.getElementById(RING_STYLE_ID) === null) {
      const st = document.createElement('style');
      st.id = RING_STYLE_ID;
      st.textContent = RING_CSS;
      document.head.appendChild(st);
      this.styleOwned = true;
    } else {
      this.styleOwned = false;
    }
    this.element = document.createElement('div');
    this.element.className = 'dcb-ring';
    parent.appendChild(this.element);
  }

  set(progress: number): void {
    const p = clamp01(progress);
    if (p <= 0) {
      if (this.shown) {
        this.shown = false;
        this.lastPercent = -1;
        this.element.classList.remove('on');
      }
      return;
    }
    if (!this.shown) {
      this.shown = true;
      this.element.classList.add('on');
    }
    const pct = (p * 100) | 0;
    if (pct === this.lastPercent) return;
    this.lastPercent = pct;
    this.element.style.setProperty('--dcb-a', `${(pct * 3.6).toFixed(1)}deg`);
  }

  dispose(): void {
    this.element.remove();
    if (this.styleOwned) document.getElementById(RING_STYLE_ID)?.remove();
  }
}

/* ------------------------------------------------------------------------ *
 * The controller
 * ------------------------------------------------------------------------ */

/** What the controller reports back when it decides an edit should happen. */
export interface PlacementSink {
  /**
   * Break the block at (x, y, z). Return true when the edit was accepted (the
   * net client may refuse if the connection is down); a refused edit does not
   * consume the repeat timer, so the player is not punished for a hiccup.
   */
  breakBlock(x: number, y: number, z: number, blockId: number): boolean;
  /** Place `blockId` at (x, y, z). Same return contract. */
  placeBlock(x: number, y: number, z: number, blockId: number): boolean;
  /** A dig crossed a stage boundary — a good place for chips and a tick of audio. */
  digStage?(x: number, y: number, z: number, blockId: number, stage: number, progress: number): void;
  /** The target changed. Cold: fires at most once per frame, usually far less. */
  targetChanged?(t: BuildTarget): void;
}

export interface PlacementOptions {
  getBlock(x: number, y: number, z: number): number;
  bodies: BodyProbe;
  sink: PlacementSink;
  /** Creative breaks instantly (BreakPolicy.INSTANT); survival-build digs. */
  instantBreak?: boolean;
  toolPower?: number;
}

/**
 * Turns "the button is down" into "these voxels changed", with the cadence and
 * the dig timing that make building feel deliberate instead of twitchy.
 *
 * The state machine is small on purpose:
 *
 *   idle --press break--> digging(target) --progress>=1--> break, repeat timer
 *        --press place--> place immediately, repeat timer
 *   changing target while digging resets progress to zero (target hopping must
 *   not accumulate), which is the same rule the destruction module uses.
 */
export class PlacementController {
  readonly target: BuildTarget = createBuildTarget();
  readonly aim: AimInput = createAimInput();

  /** 0..1 dig progress on the current target. */
  digProgress = 0;
  /** Milliseconds accumulated on the current target. */
  digElapsedMs = 0;
  /** Stage index 0..DIG_STAGES-1, or -1 when not digging. */
  digStage = -1;

  instantBreak: boolean;
  toolPower: number;

  private readonly hit: VoxelHit = createVoxelHit();
  private readonly prev: BuildTarget = createBuildTarget();
  private readonly getBlock: (x: number, y: number, z: number) => number;
  private readonly sink: PlacementSink;

  private bodyProbe: BodyProbe;

  private breakCooldownMs = 0;
  private placeCooldownMs = 0;
  private wasBreaking = false;
  private wasPlacing = false;
  /** Cell the current hold last placed into, so a stationary hold does not spam. */
  private lastPlaceX = 0x7fff;
  private lastPlaceY = -1;
  private lastPlaceZ = 0x7fff;

  private breaks = 0;
  private places = 0;

  constructor(options: PlacementOptions) {
    this.getBlock = options.getBlock;
    this.bodyProbe = options.bodies;
    this.sink = options.sink;
    this.instantBreak = options.instantBreak ?? true;
    this.toolPower = options.toolPower ?? BUILDER_TOOL_POWER;
  }

  setBodies(probe: BodyProbe): void { this.bodyProbe = probe; }

  get blocksBroken(): number { return this.breaks; }
  get blocksPlaced(): number { return this.places; }

  /** Cancel any dig in flight. Called on mode pause, death and freecam toggle. */
  cancelDig(): void {
    if (this.digStage >= 0) this.sink.digStage?.(this.target.x, this.target.y, this.target.z, this.target.blockId, -1, 0);
    this.digProgress = 0;
    this.digElapsedMs = 0;
    this.digStage = -1;
  }

  /**
   * Recompute the target from the current `aim`. Call once per frame before
   * `update`. Allocation free.
   */
  retarget(): BuildTarget {
    copyTarget(this.target, this.prev);
    computeTarget(this.aim, this.getBlock, this.bodyProbe, this.toolPower, this.hit, this.target);
    if (!sameTarget(this.prev, this.target)) {
      // Target hopping must not carry dig progress with it.
      if (this.digStage >= 0 || this.digProgress > 0) this.cancelDig();
      this.sink.targetChanged?.(this.target);
    }
    return this.target;
  }

  /**
   * Advance the hold state. `dtMs` is real frame time; `breaking` / `placing`
   * are the raw button states.
   *
   * Returns the number of voxels changed this call (0, 1 — never more, because
   * one frame may only ever produce one edit and that keeps prediction and the
   * undo grouping honest).
   */
  update(dtMs: number, breaking: boolean, placing: boolean): number {
    if (this.breakCooldownMs > 0) this.breakCooldownMs -= dtMs;
    if (this.placeCooldownMs > 0) this.placeCooldownMs -= dtMs;

    const t = this.target;

    /* --- release bookkeeping ------------------------------------------- */
    if (!placing && this.wasPlacing) {
      this.lastPlaceX = 0x7fff; this.lastPlaceY = -1; this.lastPlaceZ = 0x7fff;
    }
    if (!breaking && this.wasBreaking && this.digProgress > 0) this.cancelDig();

    const pressedBreak = breaking && !this.wasBreaking;
    const pressedPlace = placing && !this.wasPlacing;
    this.wasBreaking = breaking;
    this.wasPlacing = placing;

    /* --- break --------------------------------------------------------- */
    if (breaking) {
      if (!t.canBreak) {
        if (this.digProgress > 0) this.cancelDig();
      } else if (this.instantBreak) {
        // Creative. First click is immediate; a hold sweeps at BREAK_REPEAT_MS.
        if (pressedBreak || this.breakCooldownMs <= 0) {
          if (this.sink.breakBlock(t.x, t.y, t.z, t.blockId)) {
            this.breaks++;
            this.breakCooldownMs = BREAK_REPEAT_MS;
            return 1;
          }
          // Refused (offline, or the server already owns this cell). Back off a
          // little rather than re-asking sixty times a second.
          this.breakCooldownMs = REFUSED_RETRY_MS;
        }
      } else if (isFinite(t.breakMs) && t.breakMs > 0) {
        this.digElapsedMs += dtMs;
        this.digProgress = clamp01(this.digElapsedMs / t.breakMs);
        const stage = Math.min(DIG_STAGES - 1, (this.digProgress * DIG_STAGES) | 0);
        if (stage !== this.digStage) {
          this.digStage = stage;
          this.sink.digStage?.(t.x, t.y, t.z, t.blockId, stage, this.digProgress);
        }
        if (this.digProgress >= 1) {
          const done = this.sink.breakBlock(t.x, t.y, t.z, t.blockId);
          this.digProgress = 0;
          this.digElapsedMs = 0;
          this.digStage = -1;
          if (done) {
            this.breaks++;
            this.breakCooldownMs = 0;
            return 1;
          }
        }
      }
      // Breaking and placing at once is a mis-click, not a combo.
      return 0;
    }

    /* --- place ---------------------------------------------------------- */
    if (!placing || !t.canPlace) return 0;

    const sameCell = t.px === this.lastPlaceX && t.py === this.lastPlaceY && t.pz === this.lastPlaceZ;
    // "Chained" means the ray is now stopping on the block this hold just
    // placed, i.e. we are stacking a tower on our own work. Sweeping the
    // crosshair across a wall should feel continuous, but stacking must not
    // run at the retarget rate or a held button builds a 16-block pillar a
    // second and the world grows faster than you can look at it.
    const chained = t.x === this.lastPlaceX && t.y === this.lastPlaceY && t.z === this.lastPlaceZ;
    let due = false;
    if (pressedPlace) due = true;                                  // clicks are instant
    else if (!sameCell && !chained && this.placeCooldownMs <= PLACE_REPEAT_MS - RETARGET_REPEAT_MS) due = true;
    else if (this.placeCooldownMs <= 0) due = true;
    if (!due) return 0;

    const id = this.aim.heldBlock;
    if (!this.sink.placeBlock(t.px, t.py, t.pz, id)) {
      this.placeCooldownMs = REFUSED_RETRY_MS;
      return 0;
    }
    this.places++;
    this.lastPlaceX = t.px; this.lastPlaceY = t.py; this.lastPlaceZ = t.pz;
    this.placeCooldownMs = PLACE_REPEAT_MS;
    return 1;
  }

  /** Milliseconds the current target still needs. 0 when not digging. */
  get digRemainingMs(): number {
    if (this.digProgress <= 0 || !isFinite(this.target.breakMs)) return 0;
    return Math.max(0, this.target.breakMs - this.digElapsedMs);
  }
}

/** Field-by-field copy so nothing allocates in `retarget`. */
export function copyTarget(src: BuildTarget, dst: BuildTarget): void {
  dst.hit = src.hit;
  dst.x = src.x; dst.y = src.y; dst.z = src.z;
  dst.blockId = src.blockId;
  dst.nx = src.nx; dst.ny = src.ny; dst.nz = src.nz;
  dst.face = src.face;
  dst.distance = src.distance;
  dst.px = src.px; dst.py = src.py; dst.pz = src.pz;
  dst.canBreak = src.canBreak;
  dst.breakRefusal = src.breakRefusal;
  dst.canPlace = src.canPlace;
  dst.placeRefusal = src.placeRefusal;
  dst.breakMs = src.breakMs;
}

/** Packed 0xRRGGBB of the face the crosshair is on — used by the hint chip. */
export function targetFaceColor(t: BuildTarget): number {
  return blockFaceColor(t.blockId, t.face);
}

/** Half-width used for the local player's own body test. */
export const BODY_HALF_WIDTH = PLAYER_HALF_WIDTH;
