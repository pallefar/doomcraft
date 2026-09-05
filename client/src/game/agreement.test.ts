/**
 * DO THE TWO PREDICTORS ACTUALLY AGREE?
 *
 * The lockstep golden proves the recording has not MOVED. It does not prove
 * the two tracks AGREE — it concatenates a server track and a client track and
 * compares the pair against history, so both predictors could drift together,
 * or disagree from the start, and it would stay green. It did stay green, for
 * as long as this repo has existed, over a disagreement of up to 8.9 degrees
 * on the first shot of a shotgun burst.
 *
 * This file is the missing assertion: given the same weapon, the same
 * accumulated cone, the same aim and the same (owner, shot), the pellet
 * directions the SERVER resolves are bit-for-bit the ones the CLIENT
 * predicted.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. Both sides are handed the same aim
 * vector. On the wire the client aims with its camera and the server rebuilds
 * the aim from the yaw/pitch in the input command, and whether those two agree
 * is the netcode's business, not the cone's. This isolates the cone.
 *
 * The server's directions are OBSERVED, never recomputed: a hitscan pellet is
 * read back off the damage event it produced, and a projectile off the
 * velocity it was actually spawned with. Recomputing the derivation in the
 * test would be a test that agrees with itself.
 */

import { describe, expect, it } from 'vitest';

import { PLAYER_EYE_HEIGHT } from '@shared/constants';
import { anglesToForward } from '@shared/math';
import { ALL_WEAPON_MASK, FireKind, WEAPON_COUNT, WEAPONS, WeaponId } from '@shared/weapons';

import { Simulation } from '@doomcraft/server/src/sim.js';
import { ServerWorld } from '@doomcraft/server/src/world.js';

import { createFireContext, WeaponRuntime } from './weapons';

const SEED = 20260905;
const OWNER = 7;

/**
 * One generated world, shared by every case. Nothing in this file mutates it —
 * no projectile is ever stepped, so `carveSphere` never runs — and generating
 * a fresh one per case cost ten seconds a weapon.
 */
let sharedWorld: ServerWorld | null = null;
function flatWorld(): ServerWorld {
  if (sharedWorld === null) {
    sharedWorld = new ServerWorld(SEED);
    sharedWorld.generateAll();
  }
  return sharedWorld;
}

interface Shot {
  readonly server: number[][];
  readonly client: number[][];
}

/**
 * Fire the same shot on both predictors and return the pellet directions each
 * one used. `heat` is the accumulated cone BEFORE the shot; `seq` is the shot
 * number both sides will have reached.
 */
function fireBoth(weapon: number, heat: number, seq: number, yaw: number, pitch: number): Shot {
  const def = WEAPONS[weapon];
  const world = flatWorld();

  /* --- server --- */
  const sim = new Simulation(world, SEED);
  sim.lagCompensation = false;
  sim.fallDamageEnabled = false;
  sim.hazardsEnabled = false;
  sim.defaultWeaponMask = ALL_WEAPON_MASK;

  // High above the terrain, so the ray meets the victim and nothing else.
  const y = 200;
  const aim = new Float64Array(3);
  anglesToForward(aim, 0, yaw, pitch);

  sim.spawnAnchor = { x: 0.5, y, z: 0.5, yaw };
  const shooter = sim.addPlayer(OWNER, 'A', 0, false);
  sim.spawnPlayer(shooter);
  shooter.pitch = pitch;
  shooter.yaw = yaw;
  shooter.heatSpread = heat;
  shooter.shotSeq = seq - 1;              // tryFire pre-increments
  shooter.nextFireMs = 0;
  shooter.spawnProtectUntilMs = 0;
  shooter.onGround = true;
  shooter.crouching = false;

  const server: number[][] = [];
  if (def.kind === FireKind.HITSCAN) {
    // A wide, close victim so every pellet of the widest cone lands on it and
    // the damage events line up one-per-pellet with the client's report.
    const victim = sim.addPlayer(OWNER + 1, 'B', 1, false);
    sim.spawnPlayer(victim);
    const reach = 1.6;
    victim.pos[0] = 0.5 + aim[0] * reach;
    victim.pos[1] = shooter.pos[1] + PLAYER_EYE_HEIGHT + aim[1] * reach - 0.9;
    victim.pos[2] = 0.5 + aim[2] * reach;
    victim.health = 1e9;
    victim.spawnProtectUntilMs = 0;
    victim.pushHistory(sim.nowMs);

    expect(sim.tryFire(shooter, weapon), 'the server fired').toBe(true);
    expect(sim.damageCount, `every pellet of ${def.short} must land, or the events do not line up`)
      .toBe(def.pellets);
    for (let i = 0; i < sim.damageCount; i++) {
      const e = sim.damageEvents[i];
      server.push([e.dirX, e.dirY, e.dirZ]);
    }
  } else {
    expect(sim.tryFire(shooter, weapon), 'the server fired').toBe(true);
    expect(sim.projCount, 'one projectile').toBe(1);
    const vx = sim.projVX[0], vy = sim.projVY[0], vz = sim.projVZ[0];
    const len = Math.hypot(vx, vy, vz);
    server.push([vx / len, vy / len, vz / len]);
  }

  /* --- client --- */
  const rt = new WeaponRuntime();
  rt.resetLoadout(ALL_WEAPON_MASK);
  rt.switchTo(weapon);
  rt.current = weapon;                    // skip the switch animation
  rt.heat[weapon] = heat;
  rt.shotSeq = seq - 1;                   // fireOnce pre-increments
  const ctx = createFireContext();
  ctx.ownerId = OWNER;
  ctx.ox = 0.5; ctx.oy = y + PLAYER_EYE_HEIGHT; ctx.oz = 0.5;
  ctx.dx = aim[0]; ctx.dy = aim[1]; ctx.dz = aim[2];
  ctx.airborne = false;
  ctx.crouched = false;
  ctx.world = null;                       // directions are recorded either way
  ctx.targets = null;

  const report = rt.fireOnce(ctx);
  const client: number[][] = [];
  for (let p = 0; p < report.pellets; p++) {
    client.push([report.dirX[p], report.dirY[p], report.dirZ[p]]);
  }
  return { server, client };
}

/**
 * Chord distance, not the angle between them.
 *
 * The first version of this test compared `acos(dot)`, and every weapon failed
 * by about 0.01 degrees while printing identical components to six decimals.
 * That was the metric, not the code: near a dot product of 1, acos has an
 * infinite derivative, so a float-noise dot of 1 - 1e-8 reads as 1.4e-4 radians
 * of "disagreement". The chord is stable, and for small angles it IS the angle.
 */
function apartMetres(a: number[], b: number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Put the server's double through the same two narrowings the client's
 * observation channel applies, so the comparison is of DIRECTIONS and not of
 * the instruments reading them.
 *
 *  - float32, because `ShotReport.dirX/dirY/dirZ` are Float32Arrays. The
 *    client computes and fires in double and records in float32; a raw
 *    comparison failed by 2e-8, which is float32 epsilon and not a pellet
 *    going anywhere else. (Worth knowing separately: the comment on those
 *    fields says "the netcode layer replays these", so whatever replays from
 *    a report is replaying a narrowed vector.)
 *  - signed zero, because a projectile is observed through its VELOCITY —
 *    `dir * speed + vel * 0.25` — and -0 + 0 is +0 in IEEE-754, so a straight
 *    -0 component comes back as +0 from that channel and from no other.
 */
function asObserved(v: number[]): number[] {
  return v.map((n) => (n === 0 ? 0 : Math.fround(n)));
}

const AIMS: Array<[number, number, string]> = [
  [0, 0, 'straight ahead'],
  [1.1, -0.24, 'off-axis and downward'],
  [-2.4, 0.31, 'behind and upward'],
];

describe('the two predictors resolve the same pellets', () => {
  for (let weapon = 0; weapon < WEAPON_COUNT; weapon++) {
    const def = WEAPONS[weapon];
    if (def.kind === FireKind.MELEE) continue;   // melee has no cone on either side

    it(`${def.name}: every pellet of every shot, bit for bit`, () => {
      for (const [yaw, pitch, where] of AIMS) {
        // A cold cone, a warm one and a saturated one — the accumulated spread
        // is the input the two sides used to read at different moments.
        for (const heat of [def.spread, (def.spread + def.spreadMax) / 2, def.spreadMax, def.spreadMax * 2]) {
          for (const seq of [1, 2, 9, 65535]) {
            const { server, client } = fireBoth(weapon, heat, seq, yaw, pitch);
            expect(server.length, `${def.short} pellet count, ${where}`).toBe(client.length);
            for (let p = 0; p < server.length; p++) {
              // Bit for bit. The pellet direction is a pure function of
              // (aim, cone, owner, shot, pellet) on both sides now, so there
              // is no float budget to spend and none is granted.
              const apart = apartMetres(asObserved(server[p]), asObserved(client[p]));
              expect(
                asObserved(server[p]),
                `${def.short} pellet ${p}, heat ${heat}, shot ${seq}, ${where}: `
                + `${apart.toExponential(3)} apart as a chord`,
              ).toEqual(asObserved(client[p]));
            }
          }
        }
      }
    });
  }

  it('the shot counter wraps at 16 bits on both sides', () => {
    // The server has always masked and the client counted without a bound, so
    // they agreed for 65 535 shots and then seeded every cone differently for
    // the rest of the session.
    const rt = new WeaponRuntime();
    rt.shotSeq = 65535;
    rt.resetLoadout(ALL_WEAPON_MASK);
    rt.shotSeq = 65535;
    const ctx = createFireContext();
    ctx.ownerId = OWNER;
    rt.fireOnce(ctx);
    expect(rt.shotSeq).toBe(0);
  });
});
