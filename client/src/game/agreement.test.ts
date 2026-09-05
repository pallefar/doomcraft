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
import { BASE_ARSENAL, BASE_SLOT, SessionArsenal, type SessionArsenal as Arsenal } from '@shared/arsenal';
import {
  BTN_FIRE, createInputCommand,
} from '@shared/protocol';
import { MAX_HEALTH as FULL_HEALTH } from '@shared/constants';
import { createHitTargets, pushPlayerTarget } from './weapons';

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

/* ------------------------------------------------------------------------ *
 * SUSTAINED FIRE, SIDE BY SIDE
 *
 * The single-shot tests above hand BOTH predictors the same heat and the same
 * shot number, which is what makes them a clean test of the cone — and exactly
 * why they cannot see a disagreement about how that state EVOLVES. A reviewer
 * put it plainly: "The current agreement test supplies matching heat and
 * sequence itself." Three real divergences hid behind that and are fixed in
 * the same commit as this block:
 *
 *   - the server re-phased its fire clock to the tick on every shot
 *     (`now + interval`), so a 420 rpm pistol fired at 375 rpm while the
 *     client kept true spacing;
 *   - a weapon switch cleared the cone on the server and preserved it,
 *     per weapon, on the client;
 *   - a pooled body kept the previous occupant's shot counter.
 *
 * So this drives both predictors from one script and compares the state they
 * ARRIVE at, tick by tick, rather than the state it was given.
 * ------------------------------------------------------------------------ */

const TICK = 20;

interface Beat { readonly ticks: number; readonly fire: boolean; readonly slot: number; }

/** What one shot looked like on one side. Compared shot-for-shot, not tick-for-tick. */
interface ShotState {
  readonly beat: number;
  readonly seq: number;
  readonly weapon: number;
  readonly heat: number;
  readonly mag: number;
}

/**
 * The per-shot state that is comparable ACROSS the two clocks: which weapon
 * fired and the cone it fired through. The magazine and the sequence number
 * are cumulative, so they inherit any shot-count drift; both are checked
 * separately, by rate and by bound.
 */
function fmt(s: ShotState): string {
  return `w=${s.weapon} heat=${s.heat}`;
}

/**
 * Drive both predictors from one script and record the state AT EACH SHOT.
 *
 * Deliberately not tick-for-tick. The two schedule on different clocks — a
 * 20 ms server tick against a frame loop — so shot TIMES cannot agree, and a
 * tick-indexed comparison mostly measures that. What must agree is the CONTENT
 * of shot N: its cone, its sequence number and the magazine it came out of.
 */
function shotsBoth(script: readonly Beat[], arsenal: Arsenal, slot: number): { server: ShotState[]; client: ShotState[] } {
  const world = flatWorld();
  const yy = 200;
  const aim = new Float64Array(3);
  anglesToForward(aim, 0, 0, 0);

  const sim = new Simulation(world, SEED, arsenal);
  sim.lagCompensation = false;
  sim.fallDamageEnabled = false;
  sim.hazardsEnabled = false;
  sim.defaultWeaponMask = ALL_WEAPON_MASK;
  sim.spawnAnchor = { x: 0.5, y: yy, z: 0.5, yaw: 0 };
  const p = sim.addPlayer(OWNER, 'A', 0, false);
  p.variantSlots.fill(slot);
  sim.spawnPlayer(p);
  p.spawnProtectUntilMs = 0;

  const rt = new WeaponRuntime(undefined, undefined, undefined, arsenal);
  rt.variantSlots.fill(slot);
  rt.beginSession();
  rt.resetLoadout(ALL_WEAPON_MASK);

  const cmd = createInputCommand();
  const ctx = createFireContext();
  ctx.ownerId = OWNER;
  ctx.ox = 0.5; ctx.oy = yy + PLAYER_EYE_HEIGHT; ctx.oz = 0.5;
  ctx.dx = aim[0]; ctx.dy = aim[1]; ctx.dz = aim[2];
  ctx.world = null;
  ctx.targets = null;

  const server: ShotState[] = [];
  const client: ShotState[] = [];
  let seqBefore = p.shotSeq;
  let lastSlot = -1;

  for (let bi = 0; bi < script.length; bi++) {
    const b = script[bi];
    for (let t = 0; t < b.ticks; t++) {
      sim.beginTick(TICK);
      cmd.seq = t + 1;
      cmd.dtMs = TICK;
      cmd.yaw = 0; cmd.pitch = 0;
      cmd.slot = b.slot;
      cmd.buttons = b.fire ? BTN_FIRE : 0;
      sim.applyInput(p, cmd, TICK);
      sim.stepTick(TICK);
      if (p.shotSeq !== seqBefore) {
        server.push({ beat: bi, seq: p.shotSeq, weapon: p.weapon, heat: p.heatSpread, mag: p.mag[p.weapon] });
        seqBefore = p.shotSeq;
      }

      if (b.slot !== lastSlot) { rt.switchTo(b.slot); lastSlot = b.slot; }
      ctx.nowMs += TICK;
      ctx.firing = b.fire;
      const fired = rt.update(TICK / 1000, ctx);
      if (fired > 0) {
        client.push({ beat: bi, seq: rt.shotSeq, weapon: rt.current, heat: rt.heat[rt.current], mag: rt.mag[rt.current] });
      }
    }
  }
  return { server, client };
}

/**
 * Compared PER BURST, not across the whole script.
 *
 * A burst is the unit because the two clocks differ: over forty ticks the
 * client may fire three rounds where the server fires four, so a global shot
 * index shifts by one at the first burst boundary and every later comparison
 * is then aligning shot N against shot N+1. Within one burst the alignment
 * holds, and it is within a burst that the cone, the seed and the magazine
 * have to be identical. The residual — a count that differs by one, with the
 * server authoritative — is recorded in HANDOVER §6 rather than papered over.
 */
function compareShots(server: ShotState[], client: ShotState[]): void {
  expect(server.length, 'the script fired nothing on the server').toBeGreaterThan(3);
  expect(client.length, 'the script fired nothing on the client').toBeGreaterThan(3);
  if (process.env.DC_DEBUG === '1') {
    console.log('S:', server.map(fmt));
    console.log('C:', client.map(fmt));
  }
  const beats = new Set([...server, ...client].map((x) => x.beat));
  let compared = 0;
  for (const beat of beats) {
    const s = server.filter((x) => x.beat === beat);
    const c = client.filter((x) => x.beat === beat);
    expect(Math.abs(s.length - c.length),
      `burst ${beat}: shot counts drifted by more than one — server ${s.length}, client ${c.length}`)
      .toBeLessThanOrEqual(1);
    const n = Math.min(s.length, c.length);
    for (let i = 0; i < n; i++) {
      expect(fmt(s[i]), `burst ${beat}, shot ${i + 1}`).toBe(fmt(c[i]));
      compared++;
      // The magazine is cumulative, so its ABSOLUTE value inherits the drift.
      // What must hold on both sides is the rate: one round per shot.
      if (i > 0) {
        expect(s[i].mag, `burst ${beat}: server magazine per shot`).toBe(s[i - 1].mag - 1);
        expect(c[i].mag, `burst ${beat}: client magazine per shot`).toBe(c[i - 1].mag - 1);
      }
    }
  }
  expect(compared, 'nothing was actually compared').toBeGreaterThan(3);

  /*
   * THE SEQUENCE NUMBER IS NOT ASSERTED EQUAL, AND THAT IS A FINDING, NOT AN
   * OMISSION.
   *
   * `shotSeed(ownerId, shotSeq, pellet)` is the cone's seed, so two sides that
   * disagree about the shot COUNT seed every later shot differently — the
   * bit-identical cone proved above holds for a GIVEN shot number, and the
   * numbers themselves drift because the clocks do. Measured here: one shot
   * per burst, the client behind. It is bounded, it is the server that is
   * authoritative, and closing it needs the server to tell the client which
   * shot number it actually resolved — which is wire work, recorded in
   * HANDOVER §6 rather than pretended away here.
   */
  expect(Math.abs(server[server.length - 1].seq - client[client.length - 1].seq),
    'the shot counters drifted by more than one burst\'s worth')
    .toBeLessThanOrEqual(server.length);
  expect(server[0].seq, 'the FIRST shot of a session must be shot one on both sides').toBe(1);
  expect(client[0].seq).toBe(1);
}

describe('the two predictors stay together over time', () => {
  it('agrees shot for shot through a sustained burst', () => {
    const { server, client } = shotsBoth([
      { ticks: 4, fire: false, slot: WeaponId.CHAINGUN },
      { ticks: 60, fire: true, slot: WeaponId.CHAINGUN },
    ], BASE_ARSENAL, BASE_SLOT);
    compareShots(server, client);
  });

  it('agrees about the cone after switching away and back', () => {
    // The server clears its single heat on a slot change; the client kept heat
    // PER WEAPON and carried the bloom across the switch, so the shot after
    // coming back was predicted through 0.036 rad and resolved through 0.010.
    /*
     * THE SWITCH HAS TO BE FAST, or this test cannot fail.
     *
     * The first version idled 800 ms on the other weapon and 800 ms more after
     * switching back, and reverting the fix left it GREEN: the cone recovers
     * to its floor in that time whatever the switch did, so the bug had
     * nothing left to show. The window is the point — switch away only as long
     * as the switch itself takes, and fire the moment the gun is back up,
     * while the client's retained bloom is still above the floor.
     */
    const { server, client } = shotsBoth([
      { ticks: 4, fire: false, slot: WeaponId.CHAINGUN },
      { ticks: 40, fire: true, slot: WeaponId.CHAINGUN },
      { ticks: 12, fire: false, slot: WeaponId.SHOTGUN },
      { ticks: 60, fire: true, slot: WeaponId.CHAINGUN },
    ], BASE_ARSENAL, BASE_SLOT);
    compareShots(server, client);
  });

  it('agrees with a VARIANT equipped, which is what V3 exists to make true', () => {
    const arsenal = SessionArsenal.from([
      { id: 'probe', base: WeaponId.CHAINGUN, over: { rpm: 400.1, damage: 12 } },
    ]);
    const { server, client } = shotsBoth([
      { ticks: 4, fire: false, slot: WeaponId.CHAINGUN },
      { ticks: 80, fire: true, slot: WeaponId.CHAINGUN },
    ], arsenal, 1);
    compareShots(server, client);
  });

  it('a switch clears the cone on the client, as it does on the server', () => {
    /*
     * Asserted directly rather than through the driving script, and that is
     * deliberate: the scripted version could NOT be made to fail. A cone
     * recovers toward its floor whenever the trigger is up, so any switch long
     * enough to be realistic also recovers away the very difference the test
     * was meant to see. The rule itself is what matters and this is the rule.
     *
     * `sim.ts` zeroes its single `heatSpread` the moment a slot command
     * changes weapon; the client kept heat PER WEAPON and carried the bloom
     * across, so a shot after switching back was predicted through 0.036 rad
     * and resolved through 0.010.
     */
    const rt = new WeaponRuntime();
    rt.resetLoadout(ALL_WEAPON_MASK);
    rt.current = WeaponId.CHAINGUN;
    rt.heat[WeaponId.CHAINGUN] = 0.05;

    const ctx = createFireContext();
    expect(rt.switchTo(WeaponId.SHOTGUN)).toBe(true);
    // `switchTo` refuses a weapon that is already current or pending, so the
    // switch has to actually finish before asking for the other one back.
    for (let i = 0; i < 200 && rt.current !== WeaponId.SHOTGUN; i++) rt.update(TICK / 1000, ctx);
    expect(rt.current).toBe(WeaponId.SHOTGUN);
    expect(rt.switchTo(WeaponId.CHAINGUN)).toBe(true);
    expect(rt.heat[WeaponId.CHAINGUN], 'the client carried a bloom across a switch').toBe(0);

    // And the server's rule, asserted against the same weapon table rather
    // than against a remembered number. It zeroes on the slot change and the
    // same tick's recovery then lifts it to the NEW weapon's floor, which is
    // where the client's zero also lands on its next update.
    const sim = new Simulation(flatWorld(), SEED);
    sim.spawnAnchor = { x: 0.5, y: 200, z: 0.5, yaw: 0 };
    sim.defaultWeaponMask = ALL_WEAPON_MASK;
    const p = sim.addPlayer(OWNER, 'A', 0, false);
    sim.spawnPlayer(p);
    p.weapon = WeaponId.CHAINGUN;
    p.heatSpread = 0.05;
    const cmd = createInputCommand();
    cmd.dtMs = TICK; cmd.slot = WeaponId.SHOTGUN;
    sim.beginTick(TICK);
    sim.applyInput(p, cmd, TICK);
    expect(p.weapon).toBe(WeaponId.SHOTGUN);
    expect(p.heatSpread, 'the server carried a bloom across a switch')
      .toBe(WEAPONS[WeaponId.SHOTGUN].spread);
  });

  it('a recycled body does not carry the last occupant\'s shot counter', () => {
    // PlayerEntity.reset() omitted shotSeq, so a pooled body carried on at 41
    // while the new player's fresh client runtime started at 0 — and every
    // cone after that was seeded from a different number on the two sides.
    const world = flatWorld();
    const sim = new Simulation(world, SEED);
    sim.spawnAnchor = { x: 0.5, y: 200, z: 0.5, yaw: 0 };
    const first = sim.addPlayer(OWNER, 'A', 0, false);
    first.shotSeq = 41;
    sim.removePlayer(OWNER);
    const second = sim.addPlayer(OWNER + 1, 'B', 0, false);
    expect(second.shotSeq, 'a pooled body kept a stale shot counter').toBe(0);

    const rt = new WeaponRuntime();
    rt.shotSeq = 41;
    rt.beginSession();
    expect(rt.shotSeq).toBe(0);
  });
});

describe('a predicted kill is a kill the server also scores', () => {
  it('does not draw a kill marker for damage that leaves the target alive', () => {
    /*
     * Seven shotgun pellets of 100/7 against a 100-health target. The client's
     * damage tally was a Float32Array and accumulated to EXACTLY 100, so it
     * drew a kill; the server subtracted the same seven doubles from double
     * health and left the target on 0.00000095367431640625. The report's own
     * `totalDamage` was right all along at 99.99999904632568 — only the
     * separately narrowed accumulator was wrong, which is why nothing else
     * ever caught it.
     *
     * `SessionArsenal.from` is used directly and deliberately: this payload
     * would not survive the V2 power budget, and the point here is the
     * ARITHMETIC, not whether the variant is shippable.
     */
    const arsenal = SessionArsenal.from([
      { id: 'sevenths', base: WeaponId.SHOTGUN, over: { damage: 100 / 7 } },
    ]);
    const rt = new WeaponRuntime(undefined, undefined, undefined, arsenal);
    rt.variantSlots.fill(1);
    rt.resetLoadout(ALL_WEAPON_MASK);
    rt.current = WeaponId.SHOTGUN;
    rt.heat[WeaponId.SHOTGUN] = 0;

    const targets = createHitTargets();
    // Feet raised so the horizontal ray at eye height enters BELOW
    // PLAYER_HEAD_MIN_Y (1.42): a headshot multiplies the damage and the
    // point here is the exact 100.0 boundary.
    pushPlayerTarget(targets, 2, 0.5, 200 + 0.5, -1.6, true, 1, FULL_HEALTH);
    const ctx = createFireContext();
    ctx.ownerId = OWNER;
    ctx.ox = 0.5; ctx.oy = 200 + PLAYER_EYE_HEIGHT; ctx.oz = 0.5;
    ctx.dx = 0; ctx.dy = 0; ctx.dz = -1;
    ctx.targets = targets;
    ctx.world = null;

    const report = rt.fireOnce(ctx);
    expect(report.hits, 'every pellet must land, or this proves nothing').toBe(7);
    expect(report.totalDamage).toBeLessThan(FULL_HEALTH);
    expect(report.kills, `${report.totalDamage} damage is not ${FULL_HEALTH}`).toBe(0);
  });
});
