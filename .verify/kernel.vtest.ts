/**
 * Independent re-run of the Diagnose-phase penetration battery, post-fix.
 *
 * Oracle: after every simulated step the player AABB must not overlap a solid
 * voxel (`aabbHitsSolid`, the kernel's own predicate).
 *
 * NOTE ON HEADING: moveStep maps forward (moveZ=+1) to the world vector
 * (-sin yaw, -cos yaw). yaw 0 therefore faces -Z, NOT +X. `yawFor(dx,dz)`
 * below converts a desired world direction into the yaw that produces it; a
 * harness that skips this runs the player away from the wall it thinks it is
 * testing and reports a triumphant zero.
 */
import { describe, expect, it } from 'vitest';
import {
  PLAYER_HALF_WIDTH, STEP_HEIGHT, SPEED_RUN, ACCEL_GROUND,
  BTN_SPRINT, BTN_JUMP, BTN_CROUCH,
  aabbHitsSolid,
  HIT_NX, HIT_PX, HIT_NZ, HIT_PZ,
  type SolidAt,
} from '@shared';
import { BlockId } from '@shared/blocks';
import { createMoveState, moveStep, type CollisionWorld, type MoveState } from '@doomcraft/server/src/sim.js';
import { ServerWorld } from '@doomcraft/server/src/world.js';

/* --------------------------------------------------------------- helpers */

/** The yaw that makes forward point along world (dx, dz). */
function yawFor(dx: number, dz: number): number { return Math.atan2(-dx, -dz); }

function worldOf(solid: SolidAt): CollisionWorld {
  return { solidAt: solid, getBlock: (x, y, z) => (solid(x, y, z) ? BlockId.STONE : BlockId.AIR) };
}

function embedded(m: MoveState, solid: SolidAt): boolean {
  return aabbHitsSolid(m.pos[0], m.pos[1], m.pos[2], PLAYER_HALF_WIDTH, m.height, solid);
}

function ground(extra: (x: number, y: number, z: number) => boolean): SolidAt {
  return (x, y, z) => y < 0 || extra(x, y, z);
}

class Rand {
  private s: number;
  constructor(seed: number) { this.s = (seed >>> 0) || 1; }
  next(): number {
    this.s ^= this.s << 13; this.s >>>= 0;
    this.s ^= this.s >>> 17;
    this.s ^= this.s << 5; this.s >>>= 0;
    return this.s / 4294967296;
  }
  range(a: number, b: number): number { return a + this.next() * (b - a); }
}

interface Report { steps: number; penetrations: number; worst: string; contacts: number }
const newReport = (): Report => ({ steps: 0, penetrations: 0, worst: '', contacts: 0 });

function run(
  solid: SolidAt,
  setup: (m: MoveState) => void,
  drive: (m: MoveState, tick: number) => { mx: number; mz: number; btn: number; dt: number },
  ticks: number,
  rep: Report,
): MoveState {
  const w = worldOf(solid);
  const m = createMoveState();
  setup(m);
  if (embedded(m, solid)) throw new Error(`harness spawned inside geometry at ${m.pos[0]},${m.pos[1]},${m.pos[2]}`);
  for (let t = 0; t < ticks; t++) {
    const c = drive(m, t);
    const flags = moveStep(m, c.mx, c.mz, c.btn, c.dt, w);
    rep.steps++;
    // "contact" = the sweep reported a horizontal collision this tick. Without
    // this the harness cannot tell "nothing penetrated" from "nothing was hit".
    if ((flags & (HIT_NX | HIT_PX | HIT_NZ | HIT_PZ)) !== 0) rep.contacts++;
    if (embedded(m, solid)) {
      rep.penetrations++;
      if (rep.worst === '') rep.worst = `tick ${t} pos ${m.pos[0].toFixed(3)},${m.pos[1].toFixed(3)},${m.pos[2].toFixed(3)}`;
    }
  }
  return m;
}

const done = (name: string, rep: Report): void => {
  console.log(`  ${name}: ${rep.steps} steps, ${rep.contacts} wall contacts, ${rep.penetrations} penetrations`);
};

/** A sealed 4-tall room, walls at +/-r, floor below y=0. */
function roomOf(r: number): SolidAt {
  return ground((x, y, z) => y >= 0 && y < 4 && (x <= -r || x >= r || z <= -r || z >= r));
}

/* --------------------------------------------------------------- cases */

describe('penetration battery (independent re-run of Diagnose)', () => {
  it('every heading 0-359 sprinted into the walls of a sealed room', () => {
    const rep = newReport();
    const solid = roomOf(12);
    for (let deg = 0; deg < 360; deg++) {
      const a = (deg * Math.PI) / 180;
      run(solid, (m) => {
        m.pos[0] = 0; m.pos[1] = 0.001; m.pos[2] = 0; m.yaw = yawFor(Math.cos(a), Math.sin(a)); m.onGround = true;
      }, () => ({ mx: 0, mz: 1, btn: BTN_SPRINT, dt: 1 / 20 }), 400, rep);
    }
    expect(rep.contacts, 'the harness never actually hit a wall').toBeGreaterThan(20000);
    expect(rep.penetrations, `first ${rep.worst}`).toBe(0);
    done('headings 0-359 in a sealed room', rep);
  });

  it('shallow grazing angles 1-89 deg along a wall, 20 s each', () => {
    const rep = newReport();
    const solid = ground((x, y) => x === 10 && y >= 0 && y < 4);
    for (let deg = 1; deg <= 89; deg++) {
      const a = (deg * Math.PI) / 180;
      // mostly along +Z, a sliver of +X into the wall
      run(solid, (m) => {
        m.pos[0] = 9.0; m.pos[1] = 0.001; m.pos[2] = -40;
        m.yaw = yawFor(Math.sin(a), Math.cos(a)); m.onGround = true;
      }, () => ({ mx: 0, mz: 1, btn: BTN_SPRINT, dt: 1 / 20 }), 400, rep);
    }
    expect(rep.contacts).toBeGreaterThan(5000);
    expect(rep.penetrations, `first ${rep.worst}`).toBe(0);
    done('shallow grazing angles', rep);
  });

  it('200 seeds x 600 ticks of randomised strafe/turn/jump/crouch inside a sealed room', () => {
    const rep = newReport();
    const solid = roomOf(3);
    for (let s = 0; s < 200; s++) {
      const r = new Rand(0x9e37 + s * 2654435761);
      run(solid, (m) => {
        m.pos[0] = 0; m.pos[1] = 0.001; m.pos[2] = 0; m.yaw = r.range(0, Math.PI * 2); m.onGround = true;
      }, (m) => {
        m.yaw += r.range(-0.35, 0.35);
        const btn = (r.next() < 0.5 ? BTN_SPRINT : 0)
          | (r.next() < 0.15 ? BTN_JUMP : 0)
          | (r.next() < 0.15 ? BTN_CROUCH : 0);
        // biased forward so the body is genuinely driving into the walls
        return { mx: r.range(-1, 1), mz: r.range(0.2, 1), btn, dt: 1 / 60 };
      }, 600, rep);
    }
    expect(rep.contacts).toBeGreaterThan(20000);
    expect(rep.penetrations, `first ${rep.worst}`).toBe(0);
    done('randomised wall-hug in a sealed room', rep);
  });

  it('concave corner, inner L-crease and a single 4-tall pillar', () => {
    const rep = newReport();
    const corner = ground((x, y, z) => y >= 0 && y < 4 && ((x === 10 && z <= 10) || (z === 10 && x <= 10)));
    for (let deg = 0; deg <= 90; deg++) {
      const a = (deg * Math.PI) / 180;
      run(corner, (m) => {
        m.pos[0] = 0; m.pos[1] = 0.001; m.pos[2] = 0; m.yaw = yawFor(Math.cos(a), Math.sin(a)); m.onGround = true;
      }, () => ({ mx: 0, mz: 1, btn: BTN_SPRINT, dt: 1 / 20 }), 400, rep);
    }
    const ell = ground((x, y, z) => y >= 0 && y < 4 && ((x === 5 && z >= -5 && z <= 5) || (z === 5 && x >= -5 && x <= 5)));
    for (let deg = 0; deg < 360; deg += 3) {
      const a = (deg * Math.PI) / 180;
      run(ell, (m) => {
        m.pos[0] = 2.5; m.pos[1] = 0.001; m.pos[2] = 2.5; m.yaw = yawFor(Math.cos(a), Math.sin(a)); m.onGround = true;
      }, () => ({ mx: 0, mz: 1, btn: BTN_SPRINT, dt: 1 / 20 }), 200, rep);
    }
    const pillar = ground((x, y, z) => x === 8 && z === 0 && y >= 0 && y < 4);
    for (let deg = 0; deg < 360; deg++) {
      for (const off of [-0.6, -0.3, 0, 0.3, 0.6]) {
        const a = (deg * Math.PI) / 180;
        run(pillar, (m) => {
          m.pos[0] = 8 - Math.cos(a) * 5; m.pos[1] = 0.001; m.pos[2] = off - Math.sin(a) * 5;
          m.yaw = yawFor(Math.cos(a), Math.sin(a)); m.onGround = true;
        }, () => ({ mx: 0, mz: 1, btn: BTN_SPRINT, dt: 1 / 20 }), 60, rep);
      }
    }
    expect(rep.contacts).toBeGreaterThan(10000);
    expect(rep.penetrations, `first ${rep.worst}`).toBe(0);
    done('corners + L-crease + pillar', rep);
  });

  it('diagonal corner-touch leak: two blocks meeting only at a corner, 360 headings', () => {
    const rep = newReport();
    const solid = ground((x, y, z) => y >= 0 && y < 4 && ((x === 5 && z === 5) || (x === 6 && z === 6)));
    for (let deg = 0; deg < 360; deg++) {
      const a = (deg * Math.PI) / 180;
      run(solid, (m) => {
        m.pos[0] = 6.0 - Math.cos(a) * 5; m.pos[1] = 0.001; m.pos[2] = 6.0 - Math.sin(a) * 5;
        m.yaw = yawFor(Math.cos(a), Math.sin(a)); m.onGround = true;
      }, () => ({ mx: 0, mz: 1, btn: BTN_SPRINT, dt: 1 / 20 }), 120, rep);
    }
    // and driven straight down the seam from both sides, the classic leak
    for (const [sx, sz, dx, dz] of [[3.5, 7.5, 1, -1], [7.5, 3.5, -1, 1]] as const) {
      run(solid, (m) => {
        m.pos[0] = sx; m.pos[1] = 0.001; m.pos[2] = sz; m.yaw = yawFor(dx, dz); m.onGround = true;
      }, () => ({ mx: 0, mz: 1, btn: BTN_SPRINT, dt: 1 / 20 }), 200, rep);
    }
    expect(rep.contacts).toBeGreaterThan(1000);
    expect(rep.penetrations, `first ${rep.worst}`).toBe(0);
    done('diagonal corner-touch', rep);
  });

  it('dt sweep 1-250 ms per step, straight into a wall', () => {
    const rep = newReport();
    const solid = ground((x, y) => x === 10 && y >= 0 && y < 4);
    for (let ms = 1; ms <= 250; ms++) {
      run(solid, (m) => {
        m.pos[0] = 0; m.pos[1] = 0.001; m.pos[2] = 0; m.yaw = yawFor(1, 0); m.onGround = true;
      }, () => ({ mx: 0, mz: 1, btn: BTN_SPRINT, dt: ms / 1000 }), Math.max(30, Math.ceil(6000 / ms)), rep);
    }
    expect(rep.contacts).toBeGreaterThan(5000);
    expect(rep.penetrations, `first ${rep.worst}`).toBe(0);
    done('dt sweep 1-250 ms', rep);
  });

  it('injected velocity 10-400 m/s into a wall in one 50 ms tick, 20 offsets', () => {
    const rep = newReport();
    const solid = ground((x, y) => x === 10 && y >= 0 && y < 8);
    const w = worldOf(solid);
    for (let v = 10; v <= 400; v += 5) {
      for (let o = 0; o < 20; o++) {
        const m = createMoveState();
        m.pos[0] = 9.0 - o * 0.05; m.pos[1] = 0.001; m.pos[2] = o * 0.13; m.onGround = true;
        m.vel[0] = v;
        for (let k = 0; k < 3; k++) {
          moveStep(m, 0, 0, 0, 0.05, w);
          rep.steps++;
          if (embedded(m, solid)) { rep.penetrations++; if (rep.worst === '') rep.worst = `v=${v} off=${o} k=${k} x=${m.pos[0]}`; }
        }
        if (m.pos[0] < 10) rep.contacts++;
      }
    }
    expect(rep.contacts).toBe(20 * 79);
    expect(rep.penetrations, `first ${rep.worst}`).toBe(0);
    done('injected velocity 10-400 m/s', rep);
  });

  it('falls from 5-60 m onto a single 1x1 block, and jumps into a 1-block hole in a wall', () => {
    const rep = newReport();
    const block = (x: number, y: number, z: number): boolean => y < 0 || (x === 0 && z === 0 && y === 0);
    for (let h = 5; h <= 60; h++) {
      run(block, (m) => { m.pos[0] = 0.5; m.pos[1] = h; m.pos[2] = 0.5; m.onGround = false; },
        () => ({ mx: 0, mz: 0, btn: 0, dt: 1 / 60 }), 400, rep);
    }
    const holed = ground((x, y, z) => x === 6 && y >= 0 && y < 6 && !(y === 2 && z === 0));
    for (let o = 0; o < 40; o++) {
      run(holed, (m) => {
        m.pos[0] = 0; m.pos[1] = 0.001; m.pos[2] = (o - 20) * 0.05; m.yaw = yawFor(1, 0); m.onGround = true;
      }, (_m, t) => ({ mx: 0, mz: 1, btn: BTN_SPRINT | (t > 6 && t < 12 ? BTN_JUMP : 0), dt: 1 / 60 }), 300, rep);
    }
    expect(rep.contacts).toBeGreaterThan(1000);
    expect(rep.penetrations, `first ${rep.worst}`).toBe(0);
    done('falls + 1-block holes', rep);
  });

  it('real generated terrain: 40 seeds x 3 bodies x 1200 ticks', () => {
    const rep = newReport();
    let bodies = 0;
    for (let s = 0; s < 40; s++) {
      const world = new ServerWorld(1000 + s * 7919);
      const solid = world.solidAt;
      const r = new Rand(0x51ed + s);
      for (let b = 0; b < 3; b++) {
        // Find a spawn where the whole BOX is clear and the feet are supported.
        let x = 0, z = 0, y = -1;
        for (let attempt = 0; attempt < 200 && y < 0; attempt++) {
          x = r.range(-60, 60); z = r.range(-60, 60);
          for (let py = 62; py > 1; py--) {
            if (!solid(Math.floor(x), py - 1, Math.floor(z))) continue;
            if (!aabbHitsSolid(x, py + 0.01, z, PLAYER_HALF_WIDTH, 1.8, solid)) { y = py + 0.01; }
            break;
          }
        }
        if (y < 0) continue;
        bodies++;
        run(solid, (m) => { m.pos[0] = x; m.pos[1] = y; m.pos[2] = z; m.yaw = r.range(0, 6.28); m.onGround = true; },
          (m) => {
            m.yaw += r.range(-0.25, 0.25);
            const btn = (r.next() < 0.6 ? BTN_SPRINT : 0)
              | (r.next() < 0.1 ? BTN_JUMP : 0)
              | (r.next() < 0.1 ? BTN_CROUCH : 0);
            return { mx: r.range(-1, 1), mz: r.range(-0.2, 1), btn, dt: 1 / 60 };
          }, 1200, rep);
      }
    }
    expect(bodies).toBeGreaterThanOrEqual(110);
    expect(rep.contacts).toBeGreaterThan(1000);
    expect(rep.penetrations, `first ${rep.worst}`).toBe(0);
    done(`real terrain (${bodies} bodies)`, rep);
  });

  it('chunk seams: 6 directions x 24 lanes crossing 32-block boundaries at sprint', () => {
    const rep = newReport();
    const world = new ServerWorld(4242);
    const solid = world.solidAt;
    const dirs: readonly (readonly [number, number])[] = [
      [1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071],
    ];
    let lanes = 0;
    for (const [dx, dz] of dirs) {
      for (let lane = 0; lane < 24; lane++) {
        const x = 26 + lane * 0.37;
        const z = 26 + lane * 0.53;
        let y = -1;
        for (let py = 62; py > 1; py--) {
          if (!solid(Math.floor(x), py - 1, Math.floor(z))) continue;
          if (!aabbHitsSolid(x, py + 0.01, z, PLAYER_HALF_WIDTH, 1.8, solid)) y = py + 0.01;
          break;
        }
        if (y < 0) continue;
        lanes++;
        run(solid, (m) => { m.pos[0] = x; m.pos[1] = y; m.pos[2] = z; m.yaw = yawFor(dx, dz); m.onGround = true; },
          () => ({ mx: 0, mz: 1, btn: BTN_SPRINT, dt: 1 / 60 }), 900, rep);
      }
    }
    expect(lanes).toBeGreaterThanOrEqual(120);
    expect(rep.penetrations, `first ${rep.worst}`).toBe(0);
    done(`chunk seams (${lanes} lanes)`, rep);
  });
});

/* ------------------------------------------------------- feel regressions */

describe('deliberate DOOM-feel deviations must survive', () => {
  it('SPEED_RUN / ACCEL_GROUND / STEP_HEIGHT / PLAYER_HALF_WIDTH unchanged', () => {
    expect(SPEED_RUN).toBe(9.5);
    expect(ACCEL_GROUND).toBe(95.0);
    expect(STEP_HEIGHT).toBe(1.05);
    expect(PLAYER_HALF_WIDTH).toBe(0.3);
  });

  it('a sprinting player still steps up a FULL block without jumping', () => {
    const solid = ground((x, y) => x >= 6 && y === 0);
    const w = worldOf(solid);
    const m = createMoveState();
    m.pos[0] = 0; m.pos[1] = 0.001; m.pos[2] = 0; m.yaw = yawFor(1, 0); m.onGround = true;
    let steppedTick = -1;
    let rise = 0;
    let speedOnContact = 0;
    for (let t = 0; t < 200; t++) {
      const before = m.pos[1];
      moveStep(m, 0, 1, BTN_SPRINT, 1 / 20, w);
      if (m.stepped && steppedTick < 0) {
        steppedTick = t; rise = m.pos[1] - before;
        speedOnContact = Math.hypot(m.vel[0], m.vel[2]);
      }
      expect(embedded(m, solid), `embedded at tick ${t}`).toBe(false);
    }
    expect(steppedTick, 'never stepped up the full block').toBeGreaterThanOrEqual(0);
    expect(m.pos[0], 'did not get past the ledge').toBeGreaterThan(8);
    expect(m.pos[1], 'did not end up on top of the block').toBeGreaterThan(0.9);
    console.log(`  step-up: stepped at tick ${steppedTick}, body rose ${rise.toFixed(3)} m in ONE tick, speed kept ${speedOnContact.toFixed(2)} m/s, ended x=${m.pos[0].toFixed(2)} y=${m.pos[1].toFixed(3)}`);
  });

  it('a 2-block wall still STOPS a sprinting player (step-up is not a wall-pass)', () => {
    const solid = ground((x, y) => x === 6 && y >= 0 && y < 2);
    const w = worldOf(solid);
    const m = createMoveState();
    m.pos[0] = 0; m.pos[1] = 0.001; m.pos[2] = 0; m.yaw = yawFor(1, 0); m.onGround = true;
    for (let t = 0; t < 200; t++) {
      moveStep(m, 0, 1, BTN_SPRINT, 1 / 20, w);
      expect(embedded(m, solid)).toBe(false);
    }
    expect(m.pos[0], 'a 2-block wall did not stop the player').toBeLessThan(6);
    console.log(`  2-block wall: stopped at x=${m.pos[0].toFixed(3)} (wall face at 5.699)`);
  });

  it('reaches SPEED_RUN in ~0.10 s', () => {
    const solid = ground(() => false);
    const w = worldOf(solid);
    const m = createMoveState();
    m.pos[1] = 0.001; m.onGround = true; m.yaw = 0;
    let ticks = 0;
    while (ticks < 100) {
      moveStep(m, 0, 1, 0, 1 / 60, w);
      ticks++;
      if (Math.hypot(m.vel[0], m.vel[2]) >= SPEED_RUN - 1e-6) break;
    }
    expect(ticks / 60).toBeLessThanOrEqual(0.12);
    console.log(`  reached ${SPEED_RUN} m/s in ${((ticks / 60) * 1000).toFixed(0)} ms`);
  });
});
