/**
 * DOOMCRAFT — the movement contract, asserted against the kernel that ships.
 *
 * WHY THIS FILE EXISTS, AND WHAT IT REPLACES.
 *
 * These claims used to live in `client/src/player/controller.test.ts`, pointed
 * at `client/src/player/PlayerController` — a second, complete implementation of
 * player movement that **nothing imported**. It was superseded by `moveStep`
 * below (the client's predictor and the server's simulation both call it, which
 * is the whole basis of prediction) and then left in the tree for months. Twenty
 * green tests certified a file the game does not run, while the file it does run
 * had no step-up test, no tunnelling test and no top-speed test at all. That is
 * the failure mode `docs/BUGS-FOUND.md` §3 names: a test that is green in both
 * directions is worse than no test.
 *
 * So the dead implementation is gone and its contract moved here, onto
 * `server/src/sim.ts`. Everything asserted below is asserted about the bytes
 * that run in a real match.
 *
 * WHAT IS DELIBERATELY NOT HERE. `moveStep` moves a body; it does not decide
 * what hurts. Fall damage and lava burn are per-mode (`SYS_FALL_DAMAGE`,
 * `SYS_HAZARDS` in `shared/src/modes.ts`, applied by `Sim`), so the old
 * "no fall damage by default" and "lava hurts, water does not" tests do not
 * belong to the kernel — what the kernel owes is `landImpact`, and that is
 * asserted. `PlayerController`'s eye-lag on a step-up moved to `NetClient`
 * (`STEP_SMOOTH_RATE` in `client/src/net/client.ts`); what the kernel owes there
 * is the `stepped` flag, and that is asserted too.
 */

import { describe, expect, it } from 'vitest';
import {
  BLOCK_SOLID,
  BTN_CROUCH,
  BTN_JUMP,
  BTN_SPRINT,
  BlockId,
  CHUNK_HEIGHT,
  PLAYER_CROUCH_HEIGHT,
  PLAYER_EYE_HEIGHT,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  SPEED_CROUCH,
  SPEED_RUN,
  SPEED_SPRINT,
  aabbHitsSolid,
} from '@doomcraft/shared';
import type { SolidAt } from '@doomcraft/shared';
import { copyMoveState, createMoveState, eyeHeightOf, moveStep } from './sim.js';
import type { CollisionWorld, MoveState } from './sim.js';

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

/**
 * The smallest thing that satisfies `CollisionWorld`. A sparse map, not a chunk
 * store, so a test can describe its geometry in three lines and read like the
 * shape it is testing. It answers BEDROCK below y=0 exactly as `ServerWorld`
 * and `ClientWorld` do, because that difference is load-bearing at the rim.
 */
class TestWorld implements CollisionWorld {
  private readonly blocks = new Map<string, number>();
  readonly solidAt: SolidAt;

  constructor() {
    this.solidAt = (x: number, y: number, z: number): boolean => BLOCK_SOLID[this.getBlock(x, y, z)] === 1;
  }

  getBlock(x: number, y: number, z: number): number {
    if (y < 0) return BlockId.BEDROCK;
    if (y >= CHUNK_HEIGHT) return BlockId.AIR;
    return this.blocks.get(`${x},${y},${z}`) ?? BlockId.AIR;
  }

  setBlock(x: number, y: number, z: number, id: number): void {
    if (id === BlockId.AIR) this.blocks.delete(`${x},${y},${z}`);
    else this.blocks.set(`${x},${y},${z}`, id);
  }

  fill(
    x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
    id: number = BlockId.STONE,
  ): this {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) this.setBlock(x, y, z, id);
      }
    }
    return this;
  }
}

function bodyAt(x: number, y: number, z: number, yaw = 0): MoveState {
  const m = createMoveState();
  m.pos[0] = x; m.pos[1] = y; m.pos[2] = z;
  m.yaw = yaw;
  return m;
}

/** Yaw that makes the forward wish direction point along +X. See `moveStep`. */
const YAW_PLUS_X = -Math.PI / 2;

function speed(m: MoveState): number {
  return Math.hypot(m.vel[0], m.vel[2]);
}

function overlapsSolid(w: TestWorld, m: MoveState): boolean {
  return aabbHitsSolid(m.pos[0], m.pos[1], m.pos[2], PLAYER_HALF_WIDTH, m.height, w.solidAt);
}

/** Hold one input for `steps` ticks of `dt`. Returns the last HIT_* flags. */
function hold(
  m: MoveState, w: TestWorld,
  moveX: number, moveZ: number, buttons: number,
  steps: number, dt = 1 / 60,
): number {
  let flags = 0;
  for (let i = 0; i < steps; i++) flags = moveStep(m, moveX, moveZ, buttons, dt, w);
  return flags;
}

/* ------------------------------------------------------------------------ *
 * 1. Tunnelling
 * ------------------------------------------------------------------------ */

describe('no tunnelling', () => {
  it('cannot cross a 1-block wall at 50 m/s with a 5 ms step', () => {
    // Three blocks tall and one voxel thick at x = 5, so step-up cannot cheat it.
    const w = new TestWorld().fill(5, 5, 8, 13, -4, 4);
    const m = bodyAt(0, 10, 0);
    const wallFace = 5 - PLAYER_HALF_WIDTH;   // 4.7

    for (let i = 0; i < 60; i++) {
      m.vel[0] = 50;                          // hold 50 m/s into the wall
      m.vel[1] = 0;                           // airborne, no friction to bleed it
      moveStep(m, 0, 0, 0, 0.005, w);         // 0.25 m of intended travel per step
      expect(m.pos[0]).toBeLessThanOrEqual(wallFace + 1e-6);
      expect(overlapsSolid(w, m)).toBe(false);
    }
    // It must actually have reached the wall, or the test proved nothing.
    expect(m.pos[0]).toBeGreaterThan(wallFace - 0.05);
  });

  it('cannot cross the wall in one 5 ms step launched from just in front of it', () => {
    const w = new TestWorld().fill(5, 5, 8, 13, -4, 4);
    const m = bodyAt(4.65, 10, 0);
    m.vel[0] = 50;
    moveStep(m, 0, 0, 0, 0.005, w);
    expect(m.pos[0]).toBeLessThanOrEqual(5 - PLAYER_HALF_WIDTH + 1e-6);
    expect(overlapsSolid(w, m)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * 2. Step-up
 * ------------------------------------------------------------------------ */

describe('step-up', () => {
  it('walks up a 1-block ledge without jumping', () => {
    const w = new TestWorld()
      .fill(-8, 40, 0, 0, -6, 6)        // ground
      .fill(3, 40, 1, 1, -6, 6);        // 1-block ledge from x = 3
    const m = bodyAt(0, 1, 0, YAW_PLUS_X);

    hold(m, w, 0, 1, 0, 90);

    expect(m.pos[1]).toBeGreaterThan(1.9);   // standing on the ledge (y = 2)
    expect(m.pos[0]).toBeGreaterThan(5);     // and kept going
    expect(m.onGround).toBe(true);
    expect(overlapsSolid(w, m)).toBe(false);
  });

  it('is stopped by a 2-block ledge', () => {
    const w = new TestWorld()
      .fill(-8, 40, 0, 0, -6, 6)
      .fill(3, 40, 1, 2, -6, 6);        // 2-block ledge from x = 3
    const m = bodyAt(0, 1, 0, YAW_PLUS_X);

    hold(m, w, 0, 1, 0, 90);

    expect(m.pos[0]).toBeLessThan(3 - PLAYER_HALF_WIDTH + 1e-3);
    expect(m.pos[1]).toBeLessThan(1.5);
    expect(overlapsSolid(w, m)).toBe(false);
  });

  it('reports the step so the camera can be left behind', () => {
    // The body steps a whole block in one tick and always will — the server
    // runs the same kernel, so the physics cannot be softened. `stepped` is the
    // only signal the renderer gets that it happened, and NetClient's
    // STEP_SMOOTH_RATE hangs off it. Nothing reading this flag was the bug that
    // made a waist-high wall look like walking through it.
    const w = new TestWorld()
      .fill(-8, 40, 0, 0, -6, 6)
      .fill(3, 40, 1, 1, -6, 6);
    const m = bodyAt(0, 1, 0, YAW_PLUS_X);

    let sawStep = false;
    let riseOnStep = 0;
    for (let i = 0; i < 90; i++) {
      const before = m.pos[1];
      moveStep(m, 0, 1, 0, 1 / 60, w);
      if (m.stepped) { sawStep = true; riseOnStep = m.pos[1] - before; break; }
    }

    expect(sawStep).toBe(true);
    expect(riseOnStep).toBeGreaterThan(0.2);   // a real block of rise, in one tick
  });
});

/* ------------------------------------------------------------------------ *
 * 3. Air strafing
 * ------------------------------------------------------------------------ */

describe('air strafing', () => {
  /**
   * Classic strafe jump: hold one strafe key and rotate the view so the wish
   * direction stays ~77 degrees off the velocity. `moveStep`'s Quake air
   * acceleration only ever adds along the wish direction and caps the
   * PROJECTION, not the speed, so the perpendicular component accumulates.
   */
  function strafeRun(m: MoveState, w: TestWorld, holdStrafe: boolean, steps: number): void {
    const delta = 1.35;
    for (let i = 0; i < steps; i++) {
      const phi = Math.atan2(m.vel[2], m.vel[0]);
      m.yaw = -(phi + delta);
      moveStep(m, holdStrafe ? 1 : 0, 0, 0, 1 / 120, w);
    }
  }

  it('gains speed above the ground cap', () => {
    const w = new TestWorld();
    const m = bodyAt(0, 40, 0);
    m.vel[0] = SPEED_RUN;

    strafeRun(m, w, true, 90);   // 0.75 s of air time

    expect(m.onGround).toBe(false);
    expect(speed(m)).toBeGreaterThan(SPEED_RUN + 2.5);
  });

  it('does not gain speed with no strafe input', () => {
    const w = new TestWorld();
    const m = bodyAt(0, 40, 0);
    m.vel[0] = SPEED_RUN;

    strafeRun(m, w, false, 90);

    expect(speed(m)).toBeLessThanOrEqual(SPEED_RUN + 1e-6);
  });

  it('cannot outrun chunk streaming over the longest fall the world allows', () => {
    // The world is CHUNK_HEIGHT tall, so this is the most air time anybody can
    // buy, strafing the whole way down onto the bedrock plane.
    const w = new TestWorld();
    const m = bodyAt(0, CHUNK_HEIGHT - 1, 0);
    m.vel[0] = SPEED_RUN;

    let peak = SPEED_RUN;
    for (let i = 0; i < 5000 && !m.onGround; i++) {
      const phi = Math.atan2(m.vel[2], m.vel[0]);
      m.yaw = -(phi + 1.35);
      moveStep(m, 1, 0, 0, 1 / 120, w);
      if (speed(m) > peak) peak = speed(m);
    }

    expect(m.onGround).toBe(true);
    expect(peak).toBeGreaterThan(SPEED_RUN);        // it did strafe, all the way down
    expect(peak).toBeLessThan(SPEED_SPRINT * 1.6);  // measured 18.4 of a 20.2 budget
  });

  it('is bounded by GRAVITY, not by the acceleration law — which tops out at 4.5x run', () => {
    // Worth stating out loud, because the dead controller this contract came
    // from capped air speed at 1.5x sprint in the accel law itself and the
    // shipped kernel does not. `moveStep` caps the PROJECTION of velocity onto
    // the wish direction at SPEED_AIR_MAX, so a strafe held at 77 degrees off
    // travel converges on SPEED_AIR_MAX / cos(77 deg) ~= 43 m/s. The only reason
    // a player never sees that is that nothing keeps them in the air long
    // enough. Anything that changes — a jetpack, low gravity, a launcher, a
    // taller world — and the test above stops holding while this one still does.
    const w = new TestWorld();
    const m = bodyAt(0, 40, 0);
    m.vel[0] = SPEED_RUN;

    for (let i = 0; i < 3000; i++) {
      const phi = Math.atan2(m.vel[2], m.vel[0]);
      m.yaw = -(phi + 1.35);
      m.vel[1] = 0; m.pos[1] = 40;   // hold it airborne; isolate the accel law
      moveStep(m, 1, 0, 0, 1 / 120, w);
    }

    expect(speed(m)).toBeGreaterThan(SPEED_RUN * 4);
    expect(speed(m)).toBeLessThan(SPEED_RUN * 5);
  });
});

/* ------------------------------------------------------------------------ *
 * 4. Corner diagonal
 * ------------------------------------------------------------------------ */

describe('corner diagonal', () => {
  it('cannot squeeze through the seam between two blocks that meet at a corner', () => {
    const w = new TestWorld()
      .fill(-6, 6, 0, 0, -6, 6)      // ground
      .fill(1, 1, 1, 2, 0, 0)        // two 2-tall pillars sharing only the
      .fill(0, 0, 1, 2, 1, 1);       // corner point at (1, 1)
    const m = bodyAt(0.5, 1, 0.5, 0); // yaw 0: forward = -Z, right = +X

    for (let i = 0; i < 240; i++) {
      moveStep(m, 1, -1, 0, 1 / 60, w);   // +X and +Z
      expect(overlapsSolid(w, m)).toBe(false);
    }

    // Cell (1, ., 1) is open, but the diagonal gap has zero width: the body must
    // still be inside cell (0, ., 0).
    expect(m.pos[0]).toBeLessThan(1 - PLAYER_HALF_WIDTH + 1e-3);
    expect(m.pos[2]).toBeLessThan(1 - PLAYER_HALF_WIDTH + 1e-3);
    expect(m.pos[1]).toBeLessThan(1.5);   // and did not climb the pillars
  });
});

/* ------------------------------------------------------------------------ *
 * 5. The headline number
 * ------------------------------------------------------------------------ */

describe('ground speed', () => {
  it('reaches SPEED_RUN and holds it against friction', () => {
    const w = new TestWorld().fill(-40, 120, 0, 0, -8, 8);
    const m = bodyAt(0, 1, 0, YAW_PLUS_X);

    hold(m, w, 0, 1, 0, 120);

    expect(speed(m)).toBeGreaterThan(SPEED_RUN * 0.98);
    expect(speed(m)).toBeLessThan(SPEED_RUN * 1.02);
  });

  it('reaches SPEED_SPRINT while sprinting forward', () => {
    const w = new TestWorld().fill(-40, 200, 0, 0, -8, 8);
    const m = bodyAt(0, 1, 0, YAW_PLUS_X);

    hold(m, w, 0, 1, BTN_SPRINT, 120);

    expect(speed(m)).toBeGreaterThan(SPEED_SPRINT * 0.98);
    expect(m.sprinting).toBe(true);
  });

  it('does not sprint sideways or backwards, only forward', () => {
    const w = new TestWorld().fill(-40, 120, 0, 0, -40, 40);
    const m = bodyAt(0, 1, 0, YAW_PLUS_X);

    hold(m, w, 1, 0, BTN_SPRINT, 120);   // pure strafe, sprint held

    expect(m.sprinting).toBe(false);
    expect(speed(m)).toBeLessThan(SPEED_RUN * 1.02);
  });

  it('is near instant: 90% of SPEED_RUN inside 0.12 s', () => {
    const w = new TestWorld().fill(-40, 120, 0, 0, -8, 8);
    const m = bodyAt(0, 1, 0, YAW_PLUS_X);

    hold(m, w, 0, 1, 0, 7);              // 0.117 s

    expect(speed(m)).toBeGreaterThan(SPEED_RUN * 0.9);
  });

  it('stops crisply when the stick is let go', () => {
    const w = new TestWorld().fill(-40, 120, 0, 0, -8, 8);
    const m = bodyAt(0, 1, 0, YAW_PLUS_X);
    hold(m, w, 0, 1, 0, 60);
    expect(speed(m)).toBeGreaterThan(SPEED_RUN * 0.98);

    hold(m, w, 0, 0, 0, 30);             // 0.5 s of nothing

    expect(speed(m)).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * 6. Determinism — the basis of prediction
 * ------------------------------------------------------------------------ */

describe('determinism', () => {
  it('replays the same input sequence to bit-identical positions', () => {
    const w = new TestWorld()
      .fill(-40, 60, 0, 0, -20, 20)
      .fill(6, 9, 1, 1, -20, 20);      // something to step over

    const a = bodyAt(0, 1, 0);
    const b = bodyAt(0, 1, 0);

    for (let i = 0; i < 200; i++) {
      const moveX = Math.sin(i * 0.11) > 0 ? 1 : -1;
      const buttons = (i % 37) === 0 ? BTN_JUMP : 0;
      const yaw = YAW_PLUS_X + Math.sin(i * 0.05) * 0.8;
      a.yaw = yaw; b.yaw = yaw;
      moveStep(a, moveX, 1, buttons, 1 / 60, w);
      moveStep(b, moveX, 1, buttons, 1 / 60, w);
    }

    expect(b.pos[0]).toBe(a.pos[0]);
    expect(b.pos[1]).toBe(a.pos[1]);
    expect(b.pos[2]).toBe(a.pos[2]);
    // The body has to have actually gone somewhere for that to mean anything.
    expect(Math.hypot(a.pos[0], a.pos[2])).toBeGreaterThan(5);
  });

  it('round-trips through the prediction buffer without losing a bit', () => {
    // `copyMoveState` is what the predictor stores and replays from. A field it
    // forgets is a field that snaps back on every reconcile.
    const w = new TestWorld().fill(-40, 60, 0, 0, -20, 20).fill(6, 9, 1, 1, -20, 20);
    const live = bodyAt(0, 1, 0, YAW_PLUS_X);
    for (let i = 0; i < 40; i++) moveStep(live, 1, 1, (i % 13) === 0 ? BTN_JUMP : 0, 1 / 60, w);

    const saved = createMoveState();
    copyMoveState(live, saved);

    const restored = bodyAt(123, 45, -67);
    copyMoveState(saved, restored);

    // Same state in, same 60 ticks, same state out.
    for (let i = 0; i < 60; i++) {
      moveStep(live, 0, 1, 0, 1 / 60, w);
      moveStep(restored, 0, 1, 0, 1 / 60, w);
    }
    expect(restored.pos[0]).toBe(live.pos[0]);
    expect(restored.pos[1]).toBe(live.pos[1]);
    expect(restored.pos[2]).toBe(live.pos[2]);
    expect(restored.vel[1]).toBe(live.vel[1]);
  });
});

/* ------------------------------------------------------------------------ *
 * 7. Stance and jump
 * ------------------------------------------------------------------------ */

describe('body states', () => {
  it('crouches to a smaller box and a slower cap, then stands back up', () => {
    const w = new TestWorld().fill(-40, 60, 0, 0, -8, 8);
    const m = bodyAt(0.5, 1, 0.5, YAW_PLUS_X);

    hold(m, w, 0, 1, BTN_CROUCH, 90);

    expect(m.crouching).toBe(true);
    expect(m.height).toBe(PLAYER_CROUCH_HEIGHT);
    expect(eyeHeightOf(m)).toBeLessThan(PLAYER_EYE_HEIGHT - 0.5);
    expect(speed(m)).toBeGreaterThan(SPEED_CROUCH * 0.98);
    expect(speed(m)).toBeLessThan(SPEED_CROUCH * 1.02);

    hold(m, w, 0, 1, 0, 60);

    expect(m.crouching).toBe(false);
    expect(m.height).toBe(PLAYER_HEIGHT);
    expect(speed(m)).toBeGreaterThan(SPEED_RUN * 0.98);
    expect(overlapsSolid(w, m)).toBe(false);
  });

  it('refuses to stand up when the space above the crouched box is solid', () => {
    // A voxel world cannot produce a crouch-only gap (crouch height 1.15 needs
    // two blocks of headroom, and two blocks also fit the 1.8 standing box), so
    // the clearance rule is exercised by filling the head volume directly.
    const w = new TestWorld().fill(-6, 6, 0, 0, -6, 6);
    const m = bodyAt(0.5, 1, 0.5);

    moveStep(m, 0, 0, BTN_CROUCH, 1 / 60, w);
    expect(m.crouching).toBe(true);

    // Someone builds into the top half of the doorway you are crouched in.
    w.fill(0, 0, 2, 2, 0, 0);
    hold(m, w, 0, 0, 0, 30);
    expect(m.crouching).toBe(true);
    expect(m.height).toBe(PLAYER_CROUCH_HEIGHT);

    // Clear it again and the player stands.
    w.fill(0, 0, 2, 2, 0, 0, BlockId.AIR);
    hold(m, w, 0, 0, 0, 10);
    expect(m.crouching).toBe(false);
  });

  it('jumps roughly 1.4 m and lands again', () => {
    const w = new TestWorld().fill(-6, 6, 0, 0, -6, 6);
    const m = bodyAt(0.5, 1, 0.5);

    let peak = 1;
    for (let i = 0; i < 120; i++) {
      moveStep(m, 0, 0, i === 0 ? BTN_JUMP : 0, 1 / 60, w);
      if (m.pos[1] > peak) peak = m.pos[1];
    }

    expect(peak - 1).toBeGreaterThan(1.2);
    expect(peak - 1).toBeLessThan(1.7);
    expect(m.onGround).toBe(true);
  });

  it('records the landing speed the damage rules read, and judges nothing itself', () => {
    // `landImpact` is the kernel's whole contribution to fall damage: whether it
    // hurts is `SYS_FALL_DAMAGE`, per mode, in `Sim`. Keeping the two apart is
    // why Builder can be a sandbox and Deathmatch cannot.
    const w = new TestWorld().fill(-6, 6, 0, 0, -6, 6);
    const m = bodyAt(0.5, 55, 0.5);

    let landed = 0;
    for (let i = 0; i < 300; i++) {
      moveStep(m, 0, 0, 0, 1 / 60, w);
      if (m.landImpact > 0) { landed = m.landImpact; break; }
    }

    expect(m.onGround).toBe(true);
    expect(landed).toBeGreaterThan(20);      // a lethal-looking drop
    // ...and exactly one tick reports it, so damage cannot be charged twice.
    moveStep(m, 0, 0, 0, 1 / 60, w);
    expect(m.landImpact).toBe(0);
  });
});
