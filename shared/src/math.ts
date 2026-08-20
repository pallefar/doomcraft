/**
 * DOOMCRAFT — allocation-free math shared by client and server.
 *
 * Rules for everything in this file:
 *   1. No object or array is created at call time. Callers pass output buffers.
 *   2. Every function is deterministic: the same inputs give bit-identical
 *      outputs in a browser, in Node and in a Worker. The terrain the server
 *      generates from a seed must be the terrain the client would have generated.
 *   3. Nothing here imports the renderer, the protocol or the block table.
 */

/** Anything indexable by number that holds floats. */
export type NumArray = Float32Array | Float64Array | number[];

export const EPSILON = 1e-6;
export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/* ------------------------------------------------------------------------ *
 * Scalars
 * ------------------------------------------------------------------------ */

export function clampf(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function saturate(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
export function inverseLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}
export function smoothstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}
export function smootherstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * x * (x * (x * 6 - 15) + 10);
}
export function signf(v: number): number { return v > 0 ? 1 : v < 0 ? -1 : 0; }
export function approxEq(a: number, b: number, eps: number): boolean {
  const d = a - b;
  return (d < 0 ? -d : d) <= eps;
}
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (d > maxDelta) return current + maxDelta;
  if (d < -maxDelta) return current - maxDelta;
  return target;
}
/** Frame-rate independent exponential approach. `rate` is 1/s. */
export function expDecay(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}
/** Wrap an angle into [-PI, PI). */
export function wrapAngle(a: number): number {
  let x = a % TAU;
  if (x >= Math.PI) x -= TAU;
  else if (x < -Math.PI) x += TAU;
  return x;
}
/** Wrap an angle into [0, TAU). */
export function wrapAngle2Pi(a: number): number {
  const x = a % TAU;
  return x < 0 ? x + TAU : x;
}
/** Shortest signed delta from `a` to `b`, in [-PI, PI). */
export function angleDelta(a: number, b: number): number { return wrapAngle(b - a); }
/** Interpolate along the short arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  return wrapAngle(a + wrapAngle(b - a) * t);
}

/* ------------------------------------------------------------------------ *
 * vec3 on flat arrays
 * ------------------------------------------------------------------------ */

export function v3set(o: NumArray, oi: number, x: number, y: number, z: number): void {
  o[oi] = x; o[oi + 1] = y; o[oi + 2] = z;
}
export function v3copy(o: NumArray, oi: number, a: NumArray, ai: number): void {
  o[oi] = a[ai]; o[oi + 1] = a[ai + 1]; o[oi + 2] = a[ai + 2];
}
export function v3zero(o: NumArray, oi: number): void {
  o[oi] = 0; o[oi + 1] = 0; o[oi + 2] = 0;
}
export function v3add(o: NumArray, oi: number, a: NumArray, ai: number, b: NumArray, bi: number): void {
  o[oi] = a[ai] + b[bi]; o[oi + 1] = a[ai + 1] + b[bi + 1]; o[oi + 2] = a[ai + 2] + b[bi + 2];
}
export function v3sub(o: NumArray, oi: number, a: NumArray, ai: number, b: NumArray, bi: number): void {
  o[oi] = a[ai] - b[bi]; o[oi + 1] = a[ai + 1] - b[bi + 1]; o[oi + 2] = a[ai + 2] - b[bi + 2];
}
export function v3scale(o: NumArray, oi: number, a: NumArray, ai: number, s: number): void {
  o[oi] = a[ai] * s; o[oi + 1] = a[ai + 1] * s; o[oi + 2] = a[ai + 2] * s;
}
export function v3addScaled(o: NumArray, oi: number, a: NumArray, ai: number, b: NumArray, bi: number, s: number): void {
  o[oi] = a[ai] + b[bi] * s; o[oi + 1] = a[ai + 1] + b[bi + 1] * s; o[oi + 2] = a[ai + 2] + b[bi + 2] * s;
}
export function v3lerp(o: NumArray, oi: number, a: NumArray, ai: number, b: NumArray, bi: number, t: number): void {
  o[oi] = a[ai] + (b[bi] - a[ai]) * t;
  o[oi + 1] = a[ai + 1] + (b[bi + 1] - a[ai + 1]) * t;
  o[oi + 2] = a[ai + 2] + (b[bi + 2] - a[ai + 2]) * t;
}
export function v3dot(a: NumArray, ai: number, b: NumArray, bi: number): number {
  return a[ai] * b[bi] + a[ai + 1] * b[bi + 1] + a[ai + 2] * b[bi + 2];
}
export function v3cross(o: NumArray, oi: number, a: NumArray, ai: number, b: NumArray, bi: number): void {
  const ax = a[ai], ay = a[ai + 1], az = a[ai + 2];
  const bx = b[bi], by = b[bi + 1], bz = b[bi + 2];
  o[oi] = ay * bz - az * by;
  o[oi + 1] = az * bx - ax * bz;
  o[oi + 2] = ax * by - ay * bx;
}
export function v3lenSq(a: NumArray, ai: number): number {
  return a[ai] * a[ai] + a[ai + 1] * a[ai + 1] + a[ai + 2] * a[ai + 2];
}
export function v3len(a: NumArray, ai: number): number { return Math.sqrt(v3lenSq(a, ai)); }
export function v3distSq(a: NumArray, ai: number, b: NumArray, bi: number): number {
  const dx = a[ai] - b[bi], dy = a[ai + 1] - b[bi + 1], dz = a[ai + 2] - b[bi + 2];
  return dx * dx + dy * dy + dz * dz;
}
export function v3dist(a: NumArray, ai: number, b: NumArray, bi: number): number {
  return Math.sqrt(v3distSq(a, ai, b, bi));
}
/** Normalises in place-ish into `o`. Returns the original length (0 leaves o zeroed). */
export function v3normalize(o: NumArray, oi: number, a: NumArray, ai: number): number {
  const l = Math.sqrt(a[ai] * a[ai] + a[ai + 1] * a[ai + 1] + a[ai + 2] * a[ai + 2]);
  if (l < EPSILON) { o[oi] = 0; o[oi + 1] = 0; o[oi + 2] = 0; return 0; }
  const inv = 1 / l;
  o[oi] = a[ai] * inv; o[oi + 1] = a[ai + 1] * inv; o[oi + 2] = a[ai + 2] * inv;
  return l;
}
/** Clamp the length of a vector. */
export function v3clampLength(o: NumArray, oi: number, max: number): void {
  const l2 = o[oi] * o[oi] + o[oi + 1] * o[oi + 1] + o[oi + 2] * o[oi + 2];
  if (l2 > max * max && l2 > EPSILON) {
    const s = max / Math.sqrt(l2);
    o[oi] *= s; o[oi + 1] *= s; o[oi + 2] *= s;
  }
}

/** Yaw/pitch (radians) -> unit forward vector. Yaw 0 looks down -Z, +yaw turns right. */
export function anglesToForward(o: NumArray, oi: number, yaw: number, pitch: number): void {
  const cp = Math.cos(pitch);
  o[oi] = -Math.sin(yaw) * cp;
  o[oi + 1] = Math.sin(pitch);
  o[oi + 2] = -Math.cos(yaw) * cp;
}
/** Horizontal right vector for a yaw. */
export function yawToRight(o: NumArray, oi: number, yaw: number): void {
  o[oi] = Math.cos(yaw);
  o[oi + 1] = 0;
  o[oi + 2] = -Math.sin(yaw);
}
/** Inverse of anglesToForward. Writes [yaw, pitch] into `o`. */
export function forwardToAngles(o: NumArray, oi: number, x: number, y: number, z: number): void {
  o[oi] = Math.atan2(-x, -z);
  o[oi + 1] = Math.asin(clampf(y, -1, 1));
}

/**
 * Rotate a unit direction by a random offset inside a cone of half-angle
 * `spread` radians. `r1` and `r2` must be uniform in [0,1) — pass PRNG output so
 * the server can reproduce the client's pellet pattern from the input seed.
 */
export function coneSpread(o: NumArray, oi: number, dx: number, dy: number, dz: number, spread: number, r1: number, r2: number): void {
  if (spread <= 0) { o[oi] = dx; o[oi + 1] = dy; o[oi + 2] = dz; return; }
  // Build an orthonormal basis around d.
  let ux: number, uy: number, uz: number;
  if (dy > 0.999 || dy < -0.999) { ux = 1; uy = 0; uz = 0; }
  else { ux = 0; uy = 1; uz = 0; }
  // right = normalize(cross(up, d))
  let rx = uy * dz - uz * dy;
  let ry = uz * dx - ux * dz;
  let rz = ux * dy - uy * dx;
  const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  // upv = cross(d, right)
  const px = dy * rz - dz * ry;
  const py = dz * rx - dx * rz;
  const pz = dx * ry - dy * rx;

  const angle = spread * Math.sqrt(r1);
  const theta = TAU * r2;
  const s = Math.sin(angle), c = Math.cos(angle);
  const ox = Math.cos(theta) * s, oy = Math.sin(theta) * s;

  let vx = dx * c + rx * ox + px * oy;
  let vy = dy * c + ry * ox + py * oy;
  let vz = dz * c + rz * ox + pz * oy;
  const vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
  o[oi] = vx / vl; o[oi + 1] = vy / vl; o[oi + 2] = vz / vl;
}

/* ------------------------------------------------------------------------ *
 * AABB vs voxel field
 * ------------------------------------------------------------------------ */

export const HIT_NX = 1 << 0;
export const HIT_PX = 1 << 1;
export const HIT_NY = 1 << 2;   // landed on ground
export const HIT_PY = 1 << 3;   // hit a ceiling
export const HIT_NZ = 1 << 4;
export const HIT_PZ = 1 << 5;
export const HIT_STEPPED = 1 << 6;

/** Predicate used by every voxel query in this file. */
export type SolidAt = (x: number, y: number, z: number) => boolean;

const SWEEP_SKIN = 1e-3;
/** Largest distance any single collision substep may cover, metres. */
const SWEEP_MAX_STEP = 0.4;

/** True when the AABB (feet-centre `x,z`, base `y`) overlaps any solid voxel. */
export function aabbHitsSolid(x: number, y: number, z: number, halfW: number, height: number, solid: SolidAt): boolean {
  const x0 = Math.floor(x - halfW + SWEEP_SKIN);
  const x1 = Math.floor(x + halfW - SWEEP_SKIN);
  const y0 = Math.floor(y + SWEEP_SKIN);
  const y1 = Math.floor(y + height - SWEEP_SKIN);
  const z0 = Math.floor(z - halfW + SWEEP_SKIN);
  const z1 = Math.floor(z + halfW - SWEEP_SKIN);
  for (let bx = x0; bx <= x1; bx++) {
    for (let by = y0; by <= y1; by++) {
      for (let bz = z0; bz <= z1; bz++) {
        if (solid(bx, by, bz)) return true;
      }
    }
  }
  return false;
}

function blockedX(x: number, y: number, z: number, halfW: number, height: number, dir: number, solid: SolidAt): boolean {
  const bx = dir > 0 ? Math.floor(x + halfW - SWEEP_SKIN) : Math.floor(x - halfW + SWEEP_SKIN);
  const y0 = Math.floor(y + SWEEP_SKIN);
  const y1 = Math.floor(y + height - SWEEP_SKIN);
  const z0 = Math.floor(z - halfW + SWEEP_SKIN);
  const z1 = Math.floor(z + halfW - SWEEP_SKIN);
  for (let by = y0; by <= y1; by++) {
    for (let bz = z0; bz <= z1; bz++) if (solid(bx, by, bz)) return true;
  }
  return false;
}

function blockedZ(x: number, y: number, z: number, halfW: number, height: number, dir: number, solid: SolidAt): boolean {
  const bz = dir > 0 ? Math.floor(z + halfW - SWEEP_SKIN) : Math.floor(z - halfW + SWEEP_SKIN);
  const y0 = Math.floor(y + SWEEP_SKIN);
  const y1 = Math.floor(y + height - SWEEP_SKIN);
  const x0 = Math.floor(x - halfW + SWEEP_SKIN);
  const x1 = Math.floor(x + halfW - SWEEP_SKIN);
  for (let by = y0; by <= y1; by++) {
    for (let bx = x0; bx <= x1; bx++) if (solid(bx, by, bz)) return true;
  }
  return false;
}

function blockedY(x: number, y: number, z: number, halfW: number, height: number, dir: number, solid: SolidAt): boolean {
  const by = dir > 0 ? Math.floor(y + height - SWEEP_SKIN) : Math.floor(y + SWEEP_SKIN);
  const x0 = Math.floor(x - halfW + SWEEP_SKIN);
  const x1 = Math.floor(x + halfW - SWEEP_SKIN);
  const z0 = Math.floor(z - halfW + SWEEP_SKIN);
  const z1 = Math.floor(z + halfW - SWEEP_SKIN);
  for (let bx = x0; bx <= x1; bx++) {
    for (let bz = z0; bz <= z1; bz++) if (solid(bx, by, bz)) return true;
  }
  return false;
}

/** Cheap probe: is there a solid voxel immediately under the feet plane? */
function feetOnGround(x: number, y: number, z: number, halfW: number, solid: SolidAt): boolean {
  const by = Math.floor(y - 0.02);
  const x0 = Math.floor(x - halfW + SWEEP_SKIN);
  const x1 = Math.floor(x + halfW - SWEEP_SKIN);
  const z0 = Math.floor(z - halfW + SWEEP_SKIN);
  const z1 = Math.floor(z + halfW - SWEEP_SKIN);
  for (let bx = x0; bx <= x1; bx++) {
    for (let bz = z0; bz <= z1; bz++) if (solid(bx, by, bz)) return true;
  }
  return false;
}

/**
 * Move an axis-aligned player box through a voxel field and slide along whatever
 * it hits. This is THE collision routine: client prediction and server
 * simulation both call it with the same arguments and must agree exactly.
 *
 * `pos` is [x, y, z] where x/z are the box centre and y is the feet plane. Both
 * `pos` and `vel` are updated in place — velocity components are zeroed on the
 * axes that collided. `stepHeight` > 0 enables the auto step-up that keeps
 * DOOM-pace movement from stalling on single blocks; pass 0 to disable.
 *
 * Returns a bitmask of HIT_* flags.
 */
export function moveAABB(
  pos: NumArray, vel: NumArray,
  halfW: number, height: number,
  dt: number, stepHeight: number,
  solid: SolidAt,
): number {
  let flags = 0;
  let dx = vel[0] * dt;
  let dy = vel[1] * dt;
  let dz = vel[2] * dt;

  const total = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  let steps = Math.ceil(total / SWEEP_MAX_STEP);
  if (steps < 1) steps = 1;
  if (steps > 64) steps = 64;
  const sx = dx / steps, sy = dy / steps, sz = dz / steps;

  let x = pos[0], y = pos[1], z = pos[2];

  for (let s = 0; s < steps; s++) {
    // --- Y ---
    if (sy !== 0) {
      const ny = y + sy;
      if (blockedY(x, ny, z, halfW, height, sy > 0 ? 1 : -1, solid)) {
        if (sy > 0) {
          y = Math.floor(ny + height - SWEEP_SKIN) - height - SWEEP_SKIN;
          flags |= HIT_PY;
        } else {
          y = Math.floor(ny + SWEEP_SKIN) + 1 + SWEEP_SKIN;
          flags |= HIT_NY;
        }
        vel[1] = 0;
      } else {
        y = ny;
      }
    }

    // --- X ---
    if (sx !== 0) {
      const nx = x + sx;
      if (blockedX(nx, y, z, halfW, height, sx > 0 ? 1 : -1, solid)) {
        let stepped = false;
        if (stepHeight > 0 && ((flags & HIT_NY) !== 0 || feetOnGround(x, y, z, halfW, solid))) {
          const sy2 = y + stepHeight;
          if (!blockedX(nx, sy2, z, halfW, height, sx > 0 ? 1 : -1, solid) && !aabbHitsSolid(nx, sy2, z, halfW, height, solid)) {
            // settle back down onto the ledge
            let landed = sy2;
            for (let k = 0; k < 24; k++) {
              const probe = landed - 0.05;
              if (probe <= y || aabbHitsSolid(nx, probe, z, halfW, height, solid)) break;
              landed = probe;
            }
            y = landed;
            x = nx;
            stepped = true;
            flags |= HIT_STEPPED;
          }
        }
        if (!stepped) {
          if (sx > 0) x = Math.floor(nx + halfW - SWEEP_SKIN) - halfW - SWEEP_SKIN;
          else x = Math.floor(nx - halfW + SWEEP_SKIN) + 1 + halfW + SWEEP_SKIN;
          vel[0] = 0;
          flags |= sx > 0 ? HIT_PX : HIT_NX;
        }
      } else {
        x = nx;
      }
    }

    // --- Z ---
    if (sz !== 0) {
      const nz = z + sz;
      if (blockedZ(x, y, nz, halfW, height, sz > 0 ? 1 : -1, solid)) {
        let stepped = false;
        if (stepHeight > 0 && ((flags & HIT_NY) !== 0 || feetOnGround(x, y, z, halfW, solid))) {
          const sy2 = y + stepHeight;
          if (!blockedZ(x, sy2, nz, halfW, height, sz > 0 ? 1 : -1, solid) && !aabbHitsSolid(x, sy2, nz, halfW, height, solid)) {
            let landed = sy2;
            for (let k = 0; k < 24; k++) {
              const probe = landed - 0.05;
              if (probe <= y || aabbHitsSolid(x, probe, nz, halfW, height, solid)) break;
              landed = probe;
            }
            y = landed;
            z = nz;
            stepped = true;
            flags |= HIT_STEPPED;
          }
        }
        if (!stepped) {
          if (sz > 0) z = Math.floor(nz + halfW - SWEEP_SKIN) - halfW - SWEEP_SKIN;
          else z = Math.floor(nz - halfW + SWEEP_SKIN) + 1 + halfW + SWEEP_SKIN;
          vel[2] = 0;
          flags |= sz > 0 ? HIT_PZ : HIT_NZ;
        }
      } else {
        z = nz;
      }
    }
  }

  pos[0] = x; pos[1] = y; pos[2] = z;
  return flags;
}

/** True when a solid voxel sits directly under the box within `tolerance` metres. */
export function isGrounded(pos: NumArray, halfW: number, tolerance: number, solid: SolidAt): boolean {
  const y = pos[1] - tolerance;
  const by = Math.floor(y);
  const x0 = Math.floor(pos[0] - halfW + SWEEP_SKIN);
  const x1 = Math.floor(pos[0] + halfW - SWEEP_SKIN);
  const z0 = Math.floor(pos[2] - halfW + SWEEP_SKIN);
  const z1 = Math.floor(pos[2] + halfW - SWEEP_SKIN);
  for (let bx = x0; bx <= x1; bx++) {
    for (let bz = z0; bz <= z1; bz++) if (solid(bx, by, bz)) return true;
  }
  return false;
}

/**
 * Slab test of a ray against an axis-aligned box. Returns the entry distance
 * along the ray, or -1 when there is no hit inside [0, maxDist].
 */
export function rayAABB(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  minx: number, miny: number, minz: number,
  maxx: number, maxy: number, maxz: number,
  maxDist: number,
): number {
  let tmin = 0;
  let tmax = maxDist;

  let inv = dx !== 0 ? 1 / dx : Infinity;
  let t1 = (minx - ox) * inv;
  let t2 = (maxx - ox) * inv;
  if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return -1;

  inv = dy !== 0 ? 1 / dy : Infinity;
  t1 = (miny - oy) * inv;
  t2 = (maxy - oy) * inv;
  if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return -1;

  inv = dz !== 0 ? 1 / dz : Infinity;
  t1 = (minz - oz) * inv;
  t2 = (maxz - oz) * inv;
  if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
  if (t1 > tmin) tmin = t1;
  if (t2 < tmax) tmax = t2;
  if (tmin > tmax) return -1;

  return tmin;
}

/** Distance along the ray to a sphere, or -1. */
export function raySphere(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  cx: number, cy: number, cz: number, radius: number,
  maxDist: number,
): number {
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - radius * radius;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = 0;
  return t <= maxDist ? t : -1;
}

/* ------------------------------------------------------------------------ *
 * DDA voxel raycast (Amanatides & Woo, 1987)
 * ------------------------------------------------------------------------ */

export interface VoxelHit {
  hit: boolean;
  /** Block coordinates of the voxel that was hit. */
  x: number; y: number; z: number;
  /** Face normal of the entered face, pointing back along the ray. */
  nx: number; ny: number; nz: number;
  /** Distance from the ray origin to the contact point. */
  distance: number;
  /** Block id at the hit voxel, 0 when nothing was hit. */
  block: number;
  /** Exact world-space contact point. */
  px: number; py: number; pz: number;
  /** Number of voxels stepped through — useful for budgeting. */
  steps: number;
}

export function createVoxelHit(): VoxelHit {
  return { hit: false, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, distance: 0, block: 0, px: 0, py: 0, pz: 0, steps: 0 };
}

/** A module-level scratch hit for callers that only need one at a time. */
export const scratchVoxelHit: VoxelHit = createVoxelHit();

/**
 * March a ray through the voxel grid. `getBlock` returns the block id at integer
 * coordinates (return 0 or a non-blocking id for empty space); `isBlocking`
 * decides whether that id stops the ray — pass `isSolid` for movement and
 * building, or a predicate that also stops on liquids for a camera probe.
 *
 * The direction does not need to be normalised, but `distance` is only in metres
 * when it is. Writes into `out` and returns `out.hit`.
 */
export function raycastVoxels(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
  getBlock: (x: number, y: number, z: number) => number,
  isBlocking: (id: number) => boolean,
  out: VoxelHit,
): boolean {
  out.hit = false;
  out.block = 0;
  out.distance = 0;
  out.nx = 0; out.ny = 0; out.nz = 0;
  out.steps = 0;

  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < EPSILON || maxDist <= 0) {
    out.x = Math.floor(ox); out.y = Math.floor(oy); out.z = Math.floor(oz);
    out.px = ox; out.py = oy; out.pz = oz;
    return false;
  }
  const ndx = dx / len, ndy = dy / len, ndz = dz / len;

  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);

  const stepX = ndx > 0 ? 1 : ndx < 0 ? -1 : 0;
  const stepY = ndy > 0 ? 1 : ndy < 0 ? -1 : 0;
  const stepZ = ndz > 0 ? 1 : ndz < 0 ? -1 : 0;

  const tDeltaX = stepX !== 0 ? Math.abs(1 / ndx) : Infinity;
  const tDeltaY = stepY !== 0 ? Math.abs(1 / ndy) : Infinity;
  const tDeltaZ = stepZ !== 0 ? Math.abs(1 / ndz) : Infinity;

  let tMaxX = stepX > 0 ? (x + 1 - ox) * tDeltaX : stepX < 0 ? (ox - x) * tDeltaX : Infinity;
  let tMaxY = stepY > 0 ? (y + 1 - oy) * tDeltaY : stepY < 0 ? (oy - y) * tDeltaY : Infinity;
  let tMaxZ = stepZ > 0 ? (z + 1 - oz) * tDeltaZ : stepZ < 0 ? (oz - z) * tDeltaZ : Infinity;

  // The ray may start inside a blocking voxel.
  let id = getBlock(x, y, z);
  if (isBlocking(id)) {
    out.hit = true; out.x = x; out.y = y; out.z = z;
    out.nx = -stepX; out.ny = 0; out.nz = 0;
    out.distance = 0; out.block = id;
    out.px = ox; out.py = oy; out.pz = oz;
    return true;
  }

  let t = 0;
  const maxSteps = 512;
  for (let i = 0; i < maxSteps; i++) {
    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX;
        out.nx = -stepX; out.ny = 0; out.nz = 0;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ;
        out.nx = 0; out.ny = 0; out.nz = -stepZ;
      }
    } else {
      if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY;
        out.nx = 0; out.ny = -stepY; out.nz = 0;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ;
        out.nx = 0; out.ny = 0; out.nz = -stepZ;
      }
    }
    out.steps = i + 1;
    if (t > maxDist) break;

    id = getBlock(x, y, z);
    if (isBlocking(id)) {
      out.hit = true;
      out.x = x; out.y = y; out.z = z;
      out.distance = t;
      out.block = id;
      out.px = ox + ndx * t;
      out.py = oy + ndy * t;
      out.pz = oz + ndz * t;
      return true;
    }
  }

  out.x = x; out.y = y; out.z = z;
  out.distance = maxDist;
  out.px = ox + ndx * maxDist;
  out.py = oy + ndy * maxDist;
  out.pz = oz + ndz * maxDist;
  return false;
}

/* ------------------------------------------------------------------------ *
 * Deterministic PRNG and hashing
 * ------------------------------------------------------------------------ */

/** Mulberry32. Returns a closure producing floats in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stateful PRNG with the same stream as mulberry32, plus integer helpers. */
export class Rng {
  private a: number;
  constructor(seed: number) { this.a = seed >>> 0; }
  /** Reseed in place — lets a pooled Rng be reused without allocating. */
  reseed(seed: number): void { this.a = seed >>> 0; }
  /** Float in [0,1). */
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [0, n). */
  int(n: number): number { return (this.next() * n) | 0; }
  /** Float in [lo, hi). */
  range(lo: number, hi: number): number { return lo + this.next() * (hi - lo); }
  /** Float in [-1, 1). */
  signed(): number { return this.next() * 2 - 1; }
  bool(p: number): boolean { return this.next() < p; }
  /** A derived generator, deterministic in `salt`. */
  fork(salt: number): Rng { return new Rng(hash2i(this.a | 0, salt | 0, 0x5eed)); }
}

/** 32-bit integer avalanche. Returns an unsigned 32-bit integer. */
export function hashInt(x: number): number {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}
/** Hash of two integers plus a seed. Unsigned 32-bit. */
export function hash2i(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
/** Hash of three integers plus a seed. Unsigned 32-bit. */
export function hash3i(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x1b873593) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
/** Deterministic float in [0,1) from two integer coordinates. */
export function hash2f(x: number, y: number, seed: number): number {
  return hash2i(x, y, seed) / 4294967296;
}
/** Deterministic float in [0,1) from three integer coordinates. */
export function hash3f(x: number, y: number, z: number, seed: number): number {
  return hash3i(x, y, z, seed) / 4294967296;
}
/** Derive an independent seed channel from a world seed. */
export function seedChannel(seed: number, channel: number): number {
  return hash2i(seed | 0, channel | 0, 0x1234567) | 0;
}

/* ------------------------------------------------------------------------ *
 * Value noise + fbm — the terrain basis. Deterministic on every platform.
 * ------------------------------------------------------------------------ */

/** 2D value noise in [-1, 1]. */
export function valueNoise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smootherstep(xf);
  const v = smootherstep(yf);

  const n00 = hash2f(xi, yi, seed);
  const n10 = hash2f(xi + 1, yi, seed);
  const n01 = hash2f(xi, yi + 1, seed);
  const n11 = hash2f(xi + 1, yi + 1, seed);

  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 2 - 1;
}

/** 3D value noise in [-1, 1]. */
export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = smootherstep(xf);
  const v = smootherstep(yf);
  const w = smootherstep(zf);

  const n000 = hash3f(xi, yi, zi, seed);
  const n100 = hash3f(xi + 1, yi, zi, seed);
  const n010 = hash3f(xi, yi + 1, zi, seed);
  const n110 = hash3f(xi + 1, yi + 1, zi, seed);
  const n001 = hash3f(xi, yi, zi + 1, seed);
  const n101 = hash3f(xi + 1, yi, zi + 1, seed);
  const n011 = hash3f(xi, yi + 1, zi + 1, seed);
  const n111 = hash3f(xi + 1, yi + 1, zi + 1, seed);

  const x00 = n000 + (n100 - n000) * u;
  const x10 = n010 + (n110 - n010) * u;
  const x01 = n001 + (n101 - n001) * u;
  const x11 = n011 + (n111 - n011) * u;

  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return (y0 + (y1 - y0) * w) * 2 - 1;
}

/** Fractal Brownian motion over valueNoise2. Result is normalised to [-1, 1]. */
export function fbm2(x: number, y: number, seed: number, octaves: number, lacunarity: number, gain: number): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(x * freq, y * freq, seed + i * 1013) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Fractal Brownian motion over valueNoise3. Result is normalised to [-1, 1]. */
export function fbm3(x: number, y: number, z: number, seed: number, octaves: number, lacunarity: number, gain: number): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise3(x * freq, y * freq, z * freq, seed + i * 1013) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Ridged multifractal in [0, 1] — the cliff and canyon layer. */
export function ridged2(x: number, y: number, seed: number, octaves: number, lacunarity: number, gain: number): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise2(x * freq, y * freq, seed + i * 7919));
    sum += n * n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Domain-warped fbm. Cheap way to stop terrain reading as smooth blobs: offset
 * the sample point by a second, lower-frequency noise field.
 */
export function warpedFbm2(x: number, y: number, seed: number, octaves: number, warp: number): number {
  const wx = valueNoise2(x * 0.5, y * 0.5, seed ^ 0x1f3a) * warp;
  const wy = valueNoise2(x * 0.5 + 31.7, y * 0.5 - 17.3, seed ^ 0x77c1) * warp;
  return fbm2(x + wx, y + wy, seed, octaves, 2.03, 0.5);
}
