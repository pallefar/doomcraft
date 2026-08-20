/**
 * Movement contract tests.
 *
 * These four are the ones the design brief names, plus the two guards that
 * caught real bugs while this file was written:
 *   - top speed actually reaches SPEED_RUN (a flat ACCEL_GROUND loses to
 *     FRICTION_GROUND and silently caps the player at 5.9 m/s)
 *   - replaying the same input sequence is bit-identical, which is the whole
 *     basis of client prediction
 */

import { describe, it, expect } from 'vitest';
import {
  SPEED_RUN, SPEED_SPRINT, SPEED_CROUCH,
  PLAYER_HALF_WIDTH, PLAYER_HEIGHT, PLAYER_CROUCH_HEIGHT, PLAYER_EYE_HEIGHT,
} from '@shared/constants';
import { BlockId } from '@shared/blocks';
import { aabbHitsSolid } from '@shared/math';
import { VoxelWorld } from '../world/voxelWorld';
import { PlayerController, createMoveInput, type MoveInput } from './controller';

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

function makeWorld(chunkRadius = 2): VoxelWorld {
  const w = new VoxelWorld();
  for (let cz = -chunkRadius; cz <= chunkRadius; cz++) {
    for (let cx = -chunkRadius; cx <= chunkRadius; cx++) {
      const rec = w.ensureChunk(cx, cz);
      rec.loaded = true;
    }
  }
  return w;
}

function fill(
  w: VoxelWorld,
  x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
  id: number = BlockId.STONE,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) w.setBlock(x, y, z, id);
    }
  }
}

function makeController(w: VoxelWorld): PlayerController {
  return new PlayerController(w.solidAt, (x, y, z) => w.blockAt(x, y, z));
}

/** Yaw that makes `forward` point along +X, per `anglesToForward`. */
const YAW_PLUS_X = -Math.PI / 2;

function horizontalSpeed(pc: PlayerController): number {
  return Math.hypot(pc.vel[0], pc.vel[2]);
}

function overlapsSolid(w: VoxelWorld, pc: PlayerController): boolean {
  return aabbHitsSolid(pc.pos[0], pc.pos[1], pc.pos[2], PLAYER_HALF_WIDTH, pc.height, w.solidAt);
}

/* ------------------------------------------------------------------------ *
 * 1. Tunnelling
 * ------------------------------------------------------------------------ */

describe('no tunnelling', () => {
  it('cannot cross a 1-block wall at 50 m/s with a 5 ms step', () => {
    const w = makeWorld();
    // A 3-block-tall wall one voxel thick at x = 5, so step-up cannot cheat it.
    fill(w, 5, 5, 8, 13, -4, 4);

    const pc = makeController(w);
    // Airborne, so ground friction does not quietly bleed off the test speed.
    pc.teleport(0, 10, 0);

    const input = createMoveInput();
    const wallFace = 5 - PLAYER_HALF_WIDTH;   // 4.7

    for (let i = 0; i < 60; i++) {
      pc.vel[0] = 50;                         // hold 50 m/s into the wall
      pc.vel[1] = 0;
      pc.step(input, 0.005);                  // 0.25 m of intended travel per step
      expect(pc.pos[0]).toBeLessThanOrEqual(wallFace + 1e-6);
      expect(overlapsSolid(w, pc)).toBe(false);
    }
    // It must actually have reached the wall, or the test proved nothing.
    expect(pc.pos[0]).toBeGreaterThan(wallFace - 0.05);
  });

  it('cannot cross the wall in one 5 ms step launched from just in front of it', () => {
    const w = makeWorld();
    fill(w, 5, 5, 8, 13, -4, 4);
    const pc = makeController(w);
    pc.teleport(4.65, 10, 0);
    pc.vel[0] = 50;
    pc.step(createMoveInput(), 0.005);
    expect(pc.pos[0]).toBeLessThanOrEqual(5 - PLAYER_HALF_WIDTH + 1e-6);
    expect(overlapsSolid(w, pc)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * 2. Step-up
 * ------------------------------------------------------------------------ */

describe('step-up', () => {
  it('walks up a 1-block ledge without jumping', () => {
    const w = makeWorld();
    fill(w, -8, 40, 0, 0, -6, 6);        // ground
    fill(w, 3, 40, 1, 1, -6, 6);         // 1-block ledge from x = 3

    const pc = makeController(w);
    pc.teleport(0, 1, 0);

    const input: MoveInput = createMoveInput();
    input.moveZ = 1;
    input.yaw = YAW_PLUS_X;

    for (let i = 0; i < 90; i++) pc.step(input, 1 / 60);

    expect(pc.pos[1]).toBeGreaterThan(1.9);      // standing on the ledge (y = 2)
    expect(pc.pos[0]).toBeGreaterThan(5);        // and kept going
    expect(pc.onGround).toBe(true);
    expect(overlapsSolid(w, pc)).toBe(false);
  });

  it('is stopped by a 2-block ledge', () => {
    const w = makeWorld();
    fill(w, -8, 40, 0, 0, -6, 6);
    fill(w, 3, 40, 1, 2, -6, 6);         // 2-block ledge from x = 3

    const pc = makeController(w);
    pc.teleport(0, 1, 0);

    const input: MoveInput = createMoveInput();
    input.moveZ = 1;
    input.yaw = YAW_PLUS_X;

    for (let i = 0; i < 90; i++) pc.step(input, 1 / 60);

    expect(pc.pos[0]).toBeLessThan(3 - PLAYER_HALF_WIDTH + 1e-3);
    expect(pc.pos[1]).toBeLessThan(1.5);
    expect(overlapsSolid(w, pc)).toBe(false);
  });

  it('does not lift the camera instantly when it steps', () => {
    const w = makeWorld();
    fill(w, -8, 40, 0, 0, -6, 6);
    fill(w, 3, 40, 1, 1, -6, 6);

    const pc = makeController(w);
    pc.teleport(0, 1, 0);
    const input: MoveInput = createMoveInput();
    input.moveZ = 1;
    input.yaw = YAW_PLUS_X;

    let sawStep = false;
    for (let i = 0; i < 90; i++) {
      pc.step(input, 1 / 60);
      if (pc.steppedUp) {
        sawStep = true;
        // Feet snapped up a whole block; the eye must trail behind it.
        expect(pc.stepOffset).toBeGreaterThan(0.2);
        expect(pc.eyeY).toBeLessThan(pc.pos[1] + pc.eyeHeight);
        break;
      }
    }
    expect(sawStep).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * 3. Air strafing
 * ------------------------------------------------------------------------ */

describe('air strafing', () => {
  /**
   * Classic strafe jump: hold one strafe key and rotate the view so the wish
   * direction stays ~77 degrees off the velocity. The projection cap in
   * `accelerate` then adds speed perpendicular to travel every substep.
   */
  function strafeRun(pc: PlayerController, holdStrafe: boolean, steps: number): void {
    const input: MoveInput = createMoveInput();
    input.moveX = holdStrafe ? 1 : 0;
    input.moveZ = 0;
    const delta = 1.35;
    for (let i = 0; i < steps; i++) {
      const phi = Math.atan2(pc.vel[2], pc.vel[0]);
      input.yaw = -(phi + delta);
      pc.step(input, 1 / 120);
    }
  }

  it('gains speed above the ground cap', () => {
    const w = makeWorld();
    const pc = makeController(w);
    pc.teleport(0, 40, 0);
    pc.vel[0] = SPEED_RUN;

    strafeRun(pc, true, 90);   // 0.75 s of air time

    expect(pc.onGround).toBe(false);
    expect(horizontalSpeed(pc)).toBeGreaterThan(SPEED_RUN + 2.5);
  });

  it('does not gain speed with no strafe input', () => {
    const w = makeWorld();
    const pc = makeController(w);
    pc.teleport(0, 40, 0);
    pc.vel[0] = SPEED_RUN;

    strafeRun(pc, false, 90);

    expect(horizontalSpeed(pc)).toBeLessThanOrEqual(SPEED_RUN + 1e-6);
  });

  it('is bounded so a long fall cannot outrun chunk streaming', () => {
    const w = makeWorld();
    const pc = makeController(w);
    pc.teleport(0, 60, 0);
    pc.vel[0] = SPEED_RUN;

    strafeRun(pc, true, 600);  // 5 s of air time

    expect(horizontalSpeed(pc)).toBeLessThan(SPEED_SPRINT * 1.6);
  });
});

/* ------------------------------------------------------------------------ *
 * 4. Corner diagonal
 * ------------------------------------------------------------------------ */

describe('corner diagonal', () => {
  it('cannot squeeze through the seam between two blocks that meet at a corner', () => {
    const w = makeWorld();
    fill(w, -6, 6, 0, 0, -6, 6);      // ground
    // Two 2-tall pillars sharing only the corner point at (1, 1).
    fill(w, 1, 1, 1, 2, 0, 0);
    fill(w, 0, 0, 1, 2, 1, 1);

    const pc = makeController(w);
    pc.teleport(0.5, 1, 0.5);

    const input: MoveInput = createMoveInput();
    input.yaw = 0;      // forward = -Z, right = +X
    input.moveX = 1;    // +X
    input.moveZ = -1;   // +Z

    for (let i = 0; i < 240; i++) {
      pc.step(input, 1 / 60);
      expect(overlapsSolid(w, pc)).toBe(false);
    }

    // Cell (1, ., 1) is open, but the diagonal gap has zero width: the body must
    // still be inside cell (0, ., 0).
    expect(pc.pos[0]).toBeLessThan(1 - PLAYER_HALF_WIDTH + 1e-3);
    expect(pc.pos[2]).toBeLessThan(1 - PLAYER_HALF_WIDTH + 1e-3);
    expect(pc.pos[1]).toBeLessThan(1.5);   // and did not climb the pillars
  });
});

/* ------------------------------------------------------------------------ *
 * 5. The headline number
 * ------------------------------------------------------------------------ */

describe('ground speed', () => {
  it('reaches SPEED_RUN and holds it against friction', () => {
    const w = makeWorld();
    fill(w, -40, 120, 0, 0, -8, 8);
    const pc = makeController(w);
    pc.teleport(0, 1, 0);

    const input: MoveInput = createMoveInput();
    input.moveZ = 1;
    input.yaw = YAW_PLUS_X;

    for (let i = 0; i < 120; i++) pc.step(input, 1 / 60);

    expect(pc.horizontalSpeed).toBeGreaterThan(SPEED_RUN * 0.98);
    expect(pc.horizontalSpeed).toBeLessThan(SPEED_RUN * 1.02);
  });

  it('reaches SPEED_SPRINT while sprinting forward', () => {
    const w = makeWorld();
    fill(w, -40, 200, 0, 0, -8, 8);
    const pc = makeController(w);
    pc.teleport(0, 1, 0);

    const input: MoveInput = createMoveInput();
    input.moveZ = 1;
    input.sprint = true;
    input.yaw = YAW_PLUS_X;

    for (let i = 0; i < 120; i++) pc.step(input, 1 / 60);

    expect(pc.horizontalSpeed).toBeGreaterThan(SPEED_SPRINT * 0.98);
    expect(pc.sprinting).toBe(true);
  });

  it('is near instant: 90% of SPEED_RUN inside 0.12 s', () => {
    const w = makeWorld();
    fill(w, -40, 120, 0, 0, -8, 8);
    const pc = makeController(w);
    pc.teleport(0, 1, 0);

    const input: MoveInput = createMoveInput();
    input.moveZ = 1;
    input.yaw = YAW_PLUS_X;

    for (let i = 0; i < 7; i++) pc.step(input, 1 / 60);   // 0.117 s
    expect(pc.horizontalSpeed).toBeGreaterThan(SPEED_RUN * 0.9);
  });
});

/* ------------------------------------------------------------------------ *
 * 6. Determinism — the basis of prediction
 * ------------------------------------------------------------------------ */

describe('determinism', () => {
  it('replays a saved state and input sequence to the same position', () => {
    const w = makeWorld();
    fill(w, -40, 60, 0, 0, -20, 20);
    fill(w, 6, 9, 1, 1, -20, 20);      // something to step over

    const a = makeController(w);
    const b = makeController(w);
    a.teleport(0, 1, 0);
    b.teleport(0, 1, 0);

    const input: MoveInput = createMoveInput();
    const state = new Float64Array(16);

    for (let i = 0; i < 200; i++) {
      input.moveZ = 1;
      input.moveX = Math.sin(i * 0.11) > 0 ? 1 : -1;
      input.jump = (i % 37) === 0;
      input.yaw = YAW_PLUS_X + Math.sin(i * 0.05) * 0.8;
      a.step(input, 1 / 60);
      b.step(input, 1 / 60);
    }

    expect(b.pos[0]).toBe(a.pos[0]);
    expect(b.pos[1]).toBe(a.pos[1]);
    expect(b.pos[2]).toBe(a.pos[2]);

    // Round-trip through the prediction buffer must be lossless too.
    a.writeState(state, 0);
    b.teleport(123, 45, -67);
    b.readState(state, 0);
    expect(b.pos[0]).toBe(a.pos[0]);
    expect(b.pos[1]).toBe(a.pos[1]);
    expect(b.pos[2]).toBe(a.pos[2]);
    expect(b.vel[1]).toBe(a.vel[1]);
  });
});

/* ------------------------------------------------------------------------ *
 * 7. Crouch, jump, water and lava
 * ------------------------------------------------------------------------ */

describe('body states', () => {
  it('crouches to a smaller box and a slower cap, then stands back up', () => {
    const w = makeWorld();
    fill(w, -40, 60, 0, 0, -8, 8);
    const pc = makeController(w);
    pc.teleport(0.5, 1, 0.5);

    const input: MoveInput = createMoveInput();
    input.moveZ = 1;
    input.yaw = YAW_PLUS_X;
    input.crouch = true;
    for (let i = 0; i < 90; i++) pc.step(input, 1 / 60);

    expect(pc.crouching).toBe(true);
    expect(pc.height).toBe(PLAYER_CROUCH_HEIGHT);
    expect(pc.eyeHeight).toBeLessThan(PLAYER_EYE_HEIGHT - 0.5);
    expect(pc.horizontalSpeed).toBeGreaterThan(SPEED_CROUCH * 0.98);
    expect(pc.horizontalSpeed).toBeLessThan(SPEED_CROUCH * 1.02);

    input.crouch = false;
    for (let i = 0; i < 60; i++) pc.step(input, 1 / 60);
    expect(pc.crouching).toBe(false);
    expect(pc.height).toBe(PLAYER_HEIGHT);
    expect(pc.horizontalSpeed).toBeGreaterThan(SPEED_RUN * 0.98);
    expect(overlapsSolid(w, pc)).toBe(false);
  });

  it('refuses to stand up when the space above the crouched box is solid', () => {
    // A voxel world cannot produce a crouch-only gap (crouch height 1.15 needs
    // two blocks of headroom, and two blocks also fit the 1.8 standing box), so
    // the clearance rule is exercised directly against a filled head volume.
    const w = makeWorld();
    fill(w, -6, 6, 0, 0, -6, 6);
    const pc = makeController(w);
    pc.teleport(0.5, 1, 0.5);

    const input: MoveInput = createMoveInput();
    input.crouch = true;
    pc.step(input, 1 / 60);
    expect(pc.crouching).toBe(true);

    // Someone builds into the top half of the doorway you are crouched in.
    fill(w, 0, 0, 2, 2, 0, 0);
    input.crouch = false;
    for (let i = 0; i < 30; i++) pc.step(input, 1 / 60);
    expect(pc.crouching).toBe(true);
    expect(pc.height).toBe(PLAYER_CROUCH_HEIGHT);

    // Clear it again and the player stands.
    fill(w, 0, 0, 2, 2, 0, 0, BlockId.AIR);
    for (let i = 0; i < 10; i++) pc.step(input, 1 / 60);
    expect(pc.crouching).toBe(false);
  });

  it('jumps roughly 1.4 m and lands again', () => {
    const w = makeWorld();
    fill(w, -6, 6, 0, 0, -6, 6);
    const pc = makeController(w);
    pc.teleport(0.5, 1, 0.5);

    const input: MoveInput = createMoveInput();
    input.jump = true;
    let peak = 1;
    for (let i = 0; i < 120; i++) {
      pc.step(input, 1 / 60);
      if (pc.pos[1] > peak) peak = pc.pos[1];
      input.jump = false;
    }
    expect(peak - 1).toBeGreaterThan(1.2);
    expect(peak - 1).toBeLessThan(1.7);
    expect(pc.onGround).toBe(true);
  });

  it('takes lava damage and none from water', () => {
    const w = makeWorld();
    fill(w, -6, 6, 0, 0, -6, 6);
    fill(w, -6, 6, 1, 2, -6, 6, BlockId.LAVA);

    const pc = makeController(w);
    pc.teleport(0.5, 1, 0.5);
    const input = createMoveInput();
    for (let i = 0; i < 60; i++) pc.step(input, 1 / 60);
    expect(pc.inLava).toBe(true);
    expect(pc.drainEnvDamage()).toBeGreaterThan(15);

    const w2 = makeWorld();
    fill(w2, -6, 6, 0, 0, -6, 6);
    fill(w2, -6, 6, 1, 2, -6, 6, BlockId.WATER);
    const pc2 = makeController(w2);
    pc2.teleport(0.5, 1, 0.5);
    for (let i = 0; i < 60; i++) pc2.step(input, 1 / 60);
    expect(pc2.inWater).toBe(true);
    expect(pc2.drainEnvDamage()).toBe(0);
  });

  it('takes no fall damage by default', () => {
    const w = makeWorld();
    fill(w, -6, 6, 0, 0, -6, 6);
    const pc = makeController(w);
    pc.teleport(0.5, 55, 0.5);
    const input = createMoveInput();
    for (let i = 0; i < 300; i++) pc.step(input, 1 / 60);
    expect(pc.onGround).toBe(true);
    expect(pc.landImpactSpeed).toBeGreaterThan(20);
    expect(pc.fallDamage).toBe(0);
    expect(pc.drainEnvDamage()).toBe(0);
  });
});
