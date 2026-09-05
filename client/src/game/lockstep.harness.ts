/**
 * DOOMCRAFT — the lockstep determinism harness.
 *
 * VARIANTS.md §5 phase V1 says the seam refactor must carry one proof: a
 * "fixed-seed scripted session on BOTH predictors, byte-compared against
 * pre-refactor recordings". This is that recorder. It is a plain module rather
 * than test-local code because the SAME recorder has to run before the
 * refactor (to mint the golden) and after it (to prove nothing moved), and
 * again at V3 when the wire starts carrying a variant table.
 *
 * What it records is every number the two predictors derive from the weapon
 * tables: fire intervals, magazine drain, the accumulated cone, per-pellet
 * damage, splash, knockback, projectile speed. If a refactor reads one field
 * off a slightly different table — the exact hazard here, since
 * `splashDamageAt` uses the float32 `WEAPON_SPLASH_RADIUS` (4.400000095367432)
 * while `sim.ts` reads the double `def.splashRadius` (4.4) three lines away —
 * a recorded number moves and the golden stops matching.
 *
 * Both tracks run against the SAME `ServerWorld` and the same shared
 * `raycastVoxels`, so the client track is not a mock of the server track; it
 * is the shipping client predictor pointed at the shipping server's world.
 *
 * PRECISION. Numbers are formatted to twelve significant digits, not to their
 * raw bits. Every arithmetic op in the sim is IEEE-754 exact and would survive
 * a raw comparison, but `anglesToForward` and `coneSpread` call Math.sin/cos,
 * which the spec does not require to be bit-reproducible across engine
 * versions — a golden pinned to the last bit would be a gate that fails on a
 * Node upgrade rather than on a real change. Twelve digits is far below any
 * change this harness exists to catch: the f32-vs-double hazard above diverges
 * in the EIGHTH digit, and a wrong table lookup diverges in the first.
 */

import { isSolid } from '@shared/blocks';
import { MAX_HEALTH, PLAYER_EYE_HEIGHT, PLAYER_HEIGHT } from '@shared/constants';
import {
  anglesToForward, createVoxelHit, forwardToAngles, raycastVoxels,
} from '@shared/math';
import {
  BTN_CROUCH, BTN_FIRE, BTN_JUMP, BTN_RELOAD, createInputCommand,
} from '@shared/protocol';
import { ALL_WEAPON_MASK, ammoTypeOf, WEAPON_COUNT, WeaponId } from '@shared/weapons';

import { Simulation } from '@doomcraft/server/src/sim.js';
import { ServerWorld } from '@doomcraft/server/src/world.js';

import {
  createFireContext, createHitTargets, pushPlayerTarget,
  WeaponRuntime, type WeaponWorld,
} from './weapons';

/* ------------------------------------------------------------------------ *
 * The script
 *
 * One shape, driven into both predictors. Every weapon gets the same six
 * beats, so a recording reads as seven comparable blocks and a divergence
 * names its weapon. `settle` is 1120 ms because the slowest pair of switch
 * times in the table (out 320 + in 620, into the BFG) is 940 ms — a settle
 * shorter than the slowest switch would silently record a weapon that never
 * came up.
 * ------------------------------------------------------------------------ */

export const TICK_MS = 20;
export const SEED = 0xd00c7a;

interface Beat {
  readonly label: string;
  readonly ticks: number;
  readonly fire: boolean;
  readonly reload: boolean;
  readonly jump: boolean;
  readonly crouch: boolean;
  /**
   * Release the trigger every other tick. A held trigger fires a semi-auto
   * weapon exactly ONCE (`triggerHeld` gates it on both sides), so a script
   * that only ever holds records four pistol shots and four hundred chaingun
   * ones. Pulsing is applied to every weapon identically — the script must
   * never branch on a weapon's own table, or it stops being a fixed script.
   */
  readonly pulse: boolean;
}

function beat(
  label: string, ticks: number,
  o: { fire?: boolean; reload?: boolean; jump?: boolean; crouch?: boolean; pulse?: boolean } = {},
): Beat {
  return {
    label, ticks,
    fire: o.fire === true, reload: o.reload === true,
    jump: o.jump === true, crouch: o.crouch === true,
    pulse: o.pulse === true,
  };
}

/** Is the trigger down on tick `t` of this beat? */
function firingOn(b: Beat, t: number): boolean {
  return b.fire && (!b.pulse || (t & 1) === 0);
}

export interface Segment {
  readonly weapon: number;
  readonly beats: readonly Beat[];
}

export const ALL_WEAPONS: readonly number[] =
  Object.freeze(Array.from({ length: WEAPON_COUNT }, (_, i) => i));

/** Seven weapons × seven beats. Long enough to empty a magazine and refill it. */
export function script(weapons: readonly number[] = ALL_WEAPONS): Segment[] {
  const out: Segment[] = [];
  for (const w of weapons) {
    out.push({
      weapon: w,
      beats: [
        beat('settle', 56),
        beat('sustained', 48, { fire: true }),
        beat('recover', 24),
        beat('pulsed', 96, { fire: true, pulse: true }),
        beat('reload', 40, { reload: true }),
        beat('crouched', 32, { fire: true, crouch: true, pulse: true }),
        beat('airborne', 32, { fire: true, jump: true, pulse: true }),
      ],
    });
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Canonical formatting
 * ------------------------------------------------------------------------ */

export function num(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  const s = v.toPrecision(12);
  if (s.includes('e')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

function row(fields: Array<readonly [string, number | string | boolean]>): string {
  const parts: string[] = [];
  for (const [k, v] of fields) {
    parts.push(`${k}=${typeof v === 'number' ? num(v) : String(v)}`);
  }
  return parts.join(' ');
}

/* ------------------------------------------------------------------------ *
 * The shared arena
 *
 * A real generated world, and two standable columns `gap` metres apart with a
 * clear line of sight between the eyes. Found by a deterministic outward scan,
 * so the arena is a function of the seed alone.
 * ------------------------------------------------------------------------ */

export interface Arena {
  readonly world: ServerWorld;
  readonly ax: number; readonly ay: number; readonly az: number;
  readonly bx: number; readonly by: number; readonly bz: number;
  /** Aim from A's eye to B's chest. */
  readonly yaw: number; readonly pitch: number;
}

const CHEST = 1.1;

export function buildArena(gap = 7): Arena {
  const world = new ServerWorld(SEED);
  world.generateAll();
  const probe = createVoxelHit();
  const ang = new Float64Array(2);

  for (let r = 0; r <= 48; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const ay = world.standableY(dx, dz);
        const by = world.standableY(dx + gap, dz);
        if (ay < 0 || by < 0 || ay !== by) continue;
        if (headBlocked(world, dx, ay, dz) || headBlocked(world, dx + gap, by, dz)) continue;

        const ax = dx + 0.5, az = dz + 0.5;
        const bx = dx + gap + 0.5, bz = dz + 0.5;
        const ex = ax, ey = ay + PLAYER_EYE_HEIGHT, ez = az;
        const vx = bx - ex, vy = (by + CHEST) - ey, vz = bz - ez;
        const d = Math.hypot(vx, vy, vz);
        if (d < 1) continue;
        // Nothing solid between the eye and the chest.
        if (raycastVoxels(ex, ey, ez, vx / d, vy / d, vz / d, d - 0.05,
          world.getBlockAt, isSolid, probe)) continue;

        forwardToAngles(ang, 0, vx / d, vy / d, vz / d);
        return { world, ax, ay, az, bx, by, bz, yaw: ang[0], pitch: ang[1] };
      }
    }
  }
  throw new Error('lockstep harness: no flat, unobstructed pair in the generated world');
}

function headBlocked(world: ServerWorld, x: number, y: number, z: number): boolean {
  for (let h = 0; h <= Math.ceil(PLAYER_HEIGHT); h++) {
    if (isSolid(world.getBlock(x, Math.floor(y) + h, z))) return true;
  }
  return false;
}

/* ------------------------------------------------------------------------ *
 * Track 1 — the server predictor
 * ------------------------------------------------------------------------ */

export interface ServerTrackOptions {
  /** Top the victim back up every tick, so no weapon's block ends early. */
  readonly immortalVictim: boolean;
  /** Which weapon segments to run. Defaults to all seven. */
  readonly weapons?: readonly number[];
}

export function recordServer(arena: Arena, opts: ServerTrackOptions): string[] {
  const lines: string[] = [];
  const sim = new Simulation(arena.world, SEED);
  sim.lagCompensation = false;      // rewind reads a live RTT; off is the deterministic path
  sim.fallDamageEnabled = false;    // isolate the weapon tables from the movement tables
  sim.hazardsEnabled = false;
  sim.defaultWeaponMask = ALL_WEAPON_MASK;
  sim.spawnAnchor = { x: arena.ax, y: arena.ay, z: arena.az, yaw: arena.yaw };

  const shooter = sim.addPlayer(1, 'A', 0, false);
  sim.spawnPlayer(shooter);
  const victim = sim.addPlayer(2, 'B', 1, false);
  sim.spawnPlayer(victim);

  victim.pos[0] = arena.bx; victim.pos[1] = arena.by; victim.pos[2] = arena.bz;
  victim.yaw = arena.yaw + Math.PI;
  victim.pushHistory(sim.nowMs);
  shooter.spawnProtectUntilMs = 0;
  victim.spawnProtectUntilMs = 0;

  const cmd = createInputCommand();
  let seq = 0;

  for (const seg of script(opts.weapons)) {
    for (const b of seg.beats) {
      for (let t = 0; t < b.ticks; t++) {
        sim.beginTick(TICK_MS);
        cmd.seq = ++seq;
        cmd.dtMs = TICK_MS;
        cmd.yaw = arena.yaw;
        cmd.pitch = arena.pitch;
        cmd.slot = seg.weapon;
        cmd.moveX = 0;
        cmd.moveZ = 0;
        cmd.buttons = (firingOn(b, t) ? BTN_FIRE : 0) | (b.reload ? BTN_RELOAD : 0)
          | (b.jump ? BTN_JUMP : 0) | (b.crouch ? BTN_CROUCH : 0);
        sim.applyInput(shooter, cmd, TICK_MS);
        sim.stepTick(TICK_MS);

        lines.push(`S w${seg.weapon} ${b.label} ${t} ` + row([
          ['now', sim.nowMs],
          ['weapon', shooter.weapon],
          ['mag', shooter.mag[shooter.weapon]],
          ['reserve', shooter.reserveFor(shooter.weapon)],
          ['heat', shooter.heatSpread],
          ['nextFire', shooter.nextFireMs],
          ['switchEnd', shooter.switchEndMs],
          ['reloadEnd', shooter.reloadEndMs],
          ['reloading', shooter.reloading],
          ['spinUp', shooter.spinUpMs],
          ['shotSeq', shooter.shotSeq],
          ['firing', shooter.firing],
          ['px', shooter.pos[0]],
          ['py', shooter.pos[1]],
          ['pz', shooter.pos[2]],
          ['vy', shooter.vel[1]],
          ['ground', shooter.onGround],
          ['crouch', shooter.crouching],
          ['shp', shooter.health],
          ['vhp', victim.health],
          ['varmor', victim.armor],
          ['vpx', victim.pos[0]],
          ['vpy', victim.pos[1]],
          ['vpz', victim.pos[2]],
          ['vvx', victim.vel[0]],
          ['vvy', victim.vel[1]],
          ['vvz', victim.vel[2]],
          ['proj', sim.projCount],
          ['dmg', sim.damageCount],
          ['kill', sim.killCount],
        ]));

        for (let i = 0; i < sim.damageCount; i++) {
          const e = sim.damageEvents[i];
          lines.push('  D ' + row([
            ['victim', e.victimId], ['attacker', e.attackerId],
            ['amount', e.amount], ['weapon', e.weaponId], ['flags', e.flags],
            ['dx', e.dirX], ['dy', e.dirY], ['dz', e.dirZ],
            ['hpAfter', e.healthAfter], ['armorAfter', e.armorAfter],
          ]));
        }
        for (let i = 0; i < sim.killCount; i++) {
          const e = sim.killEvents[i];
          lines.push('  K ' + row([
            ['victim', e.victimId], ['killer', e.killerId],
            ['weapon', e.weaponId], ['flags', e.flags], ['streak', e.killerStreak],
          ]));
        }
        for (let i = 0; i < sim.projCount; i++) {
          lines.push('  P ' + row([
            ['id', sim.projId[i]], ['weapon', sim.projWeapon[i]],
            ['x', sim.projX[i]], ['y', sim.projY[i]], ['z', sim.projZ[i]],
            ['vx', sim.projVX[i]], ['vy', sim.projVY[i]], ['vz', sim.projVZ[i]],
            ['life', sim.projLife[i]], ['dmg', sim.projDamage[i]],
          ]));
        }
        sim.clearEvents();

        if (opts.immortalVictim) {
          victim.health = MAX_HEALTH;
          victim.armor = 0;
          victim.dead = false;
        } else if (victim.spawnProtectUntilMs > sim.nowMs) {
          // It just respawned, and `spawnAnchor` puts it back on top of the
          // shooter under a protection shield — which silently turns every
          // later weapon's block into a different scenario, and makes the
          // chainsaw (the last segment) swing at a body no melee check will
          // ever accept. Put it back on its mark and drop the shield. Only on
          // the tick it respawns, so knockback displacement between deaths is
          // still the sim's and still recorded.
          victim.pos[0] = arena.bx; victim.pos[1] = arena.by; victim.pos[2] = arena.bz;
          victim.vel[0] = 0; victim.vel[1] = 0; victim.vel[2] = 0;
          victim.yaw = arena.yaw + Math.PI;
          victim.spawnProtectUntilMs = 0;
          victim.pushHistory(sim.nowMs);
        }
      }
    }
  }
  return lines;
}

/* ------------------------------------------------------------------------ *
 * Track 2 — the client predictor
 *
 * The shipping `WeaponRuntime`, pointed at the arena's real voxels through the
 * same shared raycast the server uses.
 * ------------------------------------------------------------------------ */

function voxelWorldFor(world: ServerWorld): WeaponWorld {
  return {
    raycast(ox, oy, oz, dx, dy, dz, maxDist, out, blocking) {
      return raycastVoxels(ox, oy, oz, dx, dy, dz, maxDist,
        world.getBlockAt, blocking ?? isSolid, out);
    },
  };
}

export function recordClient(arena: Arena, weapons?: readonly number[]): string[] {
  const lines: string[] = [];
  const rt = new WeaponRuntime();
  rt.resetLoadout(ALL_WEAPON_MASK);

  const ctx = createFireContext();
  ctx.ownerId = 1;
  ctx.world = voxelWorldFor(arena.world);
  ctx.team = 255;

  const aim = new Float64Array(3);
  anglesToForward(aim, 0, arena.yaw, arena.pitch);

  const targets = createHitTargets();
  const dt = TICK_MS / 1000;

  for (const seg of script(weapons)) {
    rt.switchTo(seg.weapon);
    for (const b of seg.beats) {
      for (let t = 0; t < b.ticks; t++) {
        targets.count = 0;
        // Health 0 means "unknown" and never predicts a kill, so a fixed
        // non-zero value is what exercises the kill-prediction path at all.
        pushPlayerTarget(targets, 2, arena.bx, arena.by, arena.bz, true, 1, MAX_HEALTH);
        ctx.targets = targets;
        ctx.nowMs += TICK_MS;
        ctx.ox = arena.ax; ctx.oy = arena.ay + PLAYER_EYE_HEIGHT; ctx.oz = arena.az;
        ctx.dx = aim[0]; ctx.dy = aim[1]; ctx.dz = aim[2];
        ctx.firing = firingOn(b, t);
        ctx.airborne = b.jump;
        ctx.crouched = b.crouch;
        if (b.reload && !rt.reloading) rt.startReload();

        const shots = rt.update(dt, ctx);
        const ammo = ammoTypeOf(rt.current);

        lines.push(`C w${seg.weapon} ${b.label} ${t} ` + row([
          ['now', ctx.nowMs],
          ['cur', rt.current],
          ['pending', rt.pending],
          ['shots', shots],
          ['mag', rt.mag[rt.current]],
          ['reserve', rt.reserve[ammo]],
          ['heat', rt.heat[rt.current]],
          ['spin', rt.spin],
          ['trauma', rt.trauma],
          ['reloading', rt.reloading],
          ['reloadLeft', rt.reloadRemainingMs],
          ['switchPhase', rt.switchPhase],
          ['switchLeft', rt.switchRemainingMs],
          ['shotSeq', rt.shotSeq],
          ['spread', rt.liveSpread(b.jump, b.crouch)],
          ['spreadFrac', rt.liveSpreadFraction(b.jump, b.crouch)],
        ]));

        if (shots > 0) {
          const r = rt.report;
          lines.push('  R ' + row([
            ['weapon', r.weaponId], ['seq', r.shotSeq], ['pellets', r.pellets],
            ['hits', r.hits], ['heads', r.headshots], ['total', r.totalDamage],
            ['kills', r.kills], ['lethal', r.lethalId],
            ['bestDmg', r.bestDamage], ['bestDist', r.bestDistance],
            ['bestX', r.bestX], ['bestY', r.bestY], ['bestZ', r.bestZ],
            ['knock', rt.knockbackFor(r)],
          ]));
          for (let p = 0; p < r.pellets; p++) {
            lines.push('    p ' + row([
              ['i', p], ['kind', r.kind[p]], ['target', r.targetId[p]],
              ['dmg', r.damage[p]], ['dist', r.distance[p]],
              ['dx', r.dirX[p]], ['dy', r.dirY[p]], ['dz', r.dirZ[p]],
            ]));
          }
        }
      }
    }
  }
  return lines;
}

/* ------------------------------------------------------------------------ *
 * The whole recording
 * ------------------------------------------------------------------------ */

export function record(): string {
  // TWO arenas, and the near one runs the CHAINSAW ALONE.
  //
  // Seven metres is where falloff, cone growth and splash all have room to
  // differ, and it is far enough that a rocket does not blow the shooter off
  // the map. But the chainsaw's reach is 2.6 m, so at seven metres it swings
  // at empty air — and the melee path reads the tables too (`meleeRange`,
  // `damageAtDistance` inside its own falloff window, the KILL_MELEE flag in
  // `killPlayer`). A far-only recording is rule 2 in miniature: perfectly
  // stable, and blind to the code it was supposed to watch.
  //
  // The first attempt at this ran ALL SEVEN weapons at two metres and recorded
  // a rocket detonating in the shooter's face: both bodies flung across the
  // arena, the victim dead for the rest of the run, and the chainsaw block
  // still hitting nothing. Hence the split.
  const far = buildArena(7);
  const near = buildArena(2);
  const melee = [WeaponId.CHAINSAW];
  const parts: string[] = [];
  parts.push('# doomcraft lockstep recording');
  parts.push(`# seed=${SEED} tick=${TICK_MS}ms`);
  parts.push('# ' + describeArena('far', far));
  parts.push('# ' + describeArena('near', near));
  parts.push('## track: server far (immortal victim)');
  parts.push(...recordServer(far, { immortalVictim: true }));
  parts.push('## track: server far (lethal)');
  parts.push(...recordServer(far, { immortalVictim: false }));
  parts.push('## track: server near (chainsaw, lethal)');
  parts.push(...recordServer(near, { immortalVictim: false, weapons: melee }));
  parts.push('## track: client far');
  parts.push(...recordClient(far));
  parts.push('## track: client near (chainsaw)');
  parts.push(...recordClient(near, melee));
  return parts.join('\n') + '\n';
}

function describeArena(label: string, a: Arena): string {
  return `arena ${label} a=(${num(a.ax)},${num(a.ay)},${num(a.az)}) `
    + `b=(${num(a.bx)},${num(a.by)},${num(a.bz)}) `
    + `yaw=${num(a.yaw)} pitch=${num(a.pitch)}`;
}

export interface RecordingStats {
  lines: number;
  damageRows: number;
  killRows: number;
  shotRows: number;
  pelletRows: number;
  projectileRows: number;
  /** Weapon ids that appear in a client shot report / a server damage event. */
  clientFired: number[];
  serverHit: number[];
  killWeapons: number[];
}

/**
 * What a recording actually contains. A recording that reaches no body and
 * fires no shot is stable for the wrong reason — rule 2 — so the test asserts
 * against these, not only against the digest.
 */
export function stats(text: string): RecordingStats {
  let damageRows = 0, killRows = 0, shotRows = 0, pelletRows = 0, projectileRows = 0;
  const clientFired = new Set<number>();
  const serverHit = new Set<number>();
  const killWeapons = new Set<number>();
  const lines = text.split('\n');
  for (const l of lines) {
    if (l.startsWith('  D ')) { damageRows++; note(serverHit, l); }
    else if (l.startsWith('  K ')) { killRows++; note(killWeapons, l); }
    else if (l.startsWith('  P ')) projectileRows++;
    else if (l.startsWith('  R ')) { shotRows++; note(clientFired, l); }
    else if (l.startsWith('    p ')) pelletRows++;
  }
  return {
    lines: lines.length, damageRows, killRows, shotRows, pelletRows, projectileRows,
    clientFired: [...clientFired].sort((a, b) => a - b),
    serverHit: [...serverHit].sort((a, b) => a - b),
    killWeapons: [...killWeapons].sort((a, b) => a - b),
  };
}

function note(into: Set<number>, line: string): void {
  const m = /\bweapon=(\d+)/.exec(line);
  if (m) into.add(Number(m[1]));
}
