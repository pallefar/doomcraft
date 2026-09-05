/**
 * `ServerWorld.carveSphere` IS A LOOP BOUND WITH A PUBLIC SETTER.
 *
 * The carve is the one place in the tick where a number that came from outside
 * this process becomes the start and end of a `for` loop. That is fine while
 * `y + 1` is a different number from `y` — and past 2^53 it is not.
 * `-1e20 + 1 === -1e20`, so a single bad radius pins the counter and the tick
 * thread never comes back. Not slow: gone. No timeout fires, no request is
 * served, the room is dead until the process is killed.
 *
 * There are TWO independent inputs that reach that state and they need two
 * different answers, which is the whole reason this file exists:
 *
 *   1. a huge RADIUS, which a clamp on the radius fixes;
 *   2. a huge CENTRE, which a clamp on the radius does NOT fix —
 *      `carveSphere(0, 1e20, 0, 1, 0)` has a radius of ONE and still gives
 *      y0 === y1 === 1e20. Only bounding the loop's start and end to the
 *      world box fixes that one.
 *
 * A third input is worth stating because it is easy to get wrong in both
 * directions: a NaN radius is already harmless, by accident. It survives
 * `radius <= 0` (`NaN <= 0` is false), but then y0 and y1 are both NaN and
 * `NaN <= NaN` is false, so the loop body runs zero times and the function
 * returns 0. It never hung and it never carved. Infinity is a different story —
 * it floors to ±Infinity and hangs exactly like 1e20.
 *
 * HOW THE NON-TERMINATION IS TESTED. A spin loop cannot be interrupted from
 * inside the same thread: a `testTimeout` never fires, because the timer never
 * gets to run. So the hazard cases run in a CHILD PROCESS under a hard
 * `spawnSync` deadline, and the child reports each case as it finishes with a
 * synchronous write to fd 1. A hang therefore shows up here as a killed child
 * and a named missing case — a red test, not a wedged suite.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TERRAIN_CARVE_MAX_RADIUS } from '@doomcraft/shared';
import { ServerWorld } from './world.js';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const WORLD_TS = path.join(REPO_ROOT, 'server', 'src', 'world.ts');

/** Seed and centre every carve in this file uses. (8,8) has a surface at y=15. */
const SEED = 0xd00d;
const CX = 8.5, CZ = 8.5, CY = 14.5;

/** Fingerprint of a journal slice, so "the same blocks" is a real claim. */
function digest(w: ServerWorld, from: number): string {
  let h = 2166136261 >>> 0;
  for (let i = from; i < w.journal.count; i++) {
    for (const ch of `${w.journal.x[i]},${w.journal.y[i]},${w.journal.z[i]}:${w.journal.id[i]}|`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h.toString(16);
}

describe('carveSphere is bounded', () => {
  /**
   * The clamp, measured in-process because radius 21 still terminates — it is
   * only 42 blocks across. Pre-fix this carved a bigger sphere (20331 voxels
   * against 9378) and shaped it differently, because `radius` also sets the
   * falloff. Post-fix a radius past the ceiling is the ceiling in every respect.
   */
  it('treats a radius past the ceiling as the ceiling, block for block', () => {
    const capped = new ServerWorld(SEED);
    const over = new ServerWorld(SEED);
    const a = capped.carveSphere(CX, CY, CZ, TERRAIN_CARVE_MAX_RADIUS, 7);
    const b = over.carveSphere(CX, CY, CZ, TERRAIN_CARVE_MAX_RADIUS + 5, 7);
    expect(a).toBe(9378);
    expect(b).toBe(a);
    expect(digest(over, 0)).toBe(digest(capped, 0));
  });

  /**
   * The no-op control. Every radius that ships is a weapon's `terrainDamage`:
   * 2.6 for the rocket, 5.5 for the BFG, 0 for everything else — and a zero
   * skips the call. A bound of 16 is therefore supposed to be invisible to the
   * live game, and this is the assertion that says so with numbers rather than
   * with an argument. Both counts and the exact voxel list were measured before
   * the bound existed; if the clamp ever starts touching an in-range carve,
   * this goes red before anything a player would notice does.
   */
  it('leaves a rocket-sized carve exactly as it was', () => {
    const w = new ServerWorld(SEED);
    const removed = w.carveSphere(CX, CY, CZ, 2.6, 7);
    expect(removed).toBe(53);
    // 53 removals plus the 17 rim voxels scorchCrater chars.
    expect(w.journal.count).toBe(70);
    expect(digest(w, 0)).toBe('78d994cb');
  });

  /** A BFG-sized carve, the largest radius that ships. Same claim. */
  it('leaves a BFG-sized carve exactly as it was', () => {
    const w = new ServerWorld(SEED);
    const a = w.carveSphere(CX, CY, CZ, 5.5, 7);
    const fresh = new ServerWorld(SEED);
    expect(a).toBe(fresh.carveSphere(CX, CY, CZ, 5.5, 7));
    expect(a).toBeGreaterThan(100);
  });

  /**
   * The hazards, out of process. `ms` is the child's own measurement of each
   * call, so a case that came back is proved to have come back QUICKLY rather
   * than merely eventually.
   */
  it('returns from every huge-input carve inside a deadline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doomcraft-carve-'));
    const probe = path.join(dir, 'probe.ts');
    fs.writeFileSync(probe, `
import fs from 'node:fs';
import { ServerWorld } from ${JSON.stringify(WORLD_TS)};
const w = new ServerWorld(${SEED});
const cases: [string, number, number, number, number][] = [
  ['huge-radius',      ${CX}, ${CY}, ${CZ}, 1e20],
  ['huge-centre-y',    ${CX}, 1e20,  ${CZ}, 1],
  ['huge-centre-x',    1e20,  ${CY}, ${CZ}, 1],
  ['huge-centre-z',    ${CX}, ${CY}, 1e20,  1],
  ['negative-centre-y',${CX}, -1e20, ${CZ}, 1],
  ['infinite-radius',  ${CX}, ${CY}, ${CZ}, Infinity],
  ['nan-radius',       ${CX}, ${CY}, ${CZ}, NaN],
  ['nan-centre',       NaN,   ${CY}, ${CZ}, 1],
];
for (const [name, x, y, z, r] of cases) {
  const t = Date.now();
  const removed = w.carveSphere(x, y, z, r, 7);
  fs.writeSync(1, JSON.stringify({ name, removed, ms: Date.now() - t }) + '\\n');
}
`, 'utf8');

    const res = spawnSync(TSX, [probe], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
    });
    const done = res.stdout.split('\n').filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as { name: string; removed: number; ms: number });
    const names = done.map((d) => d.name);

    // Name the case that never came back, not just "it timed out".
    expect({ finished: names, stderr: res.stderr.slice(-400) }).toEqual({
      finished: [
        'huge-radius', 'huge-centre-y', 'huge-centre-x', 'huge-centre-z',
        'negative-centre-y', 'infinite-radius', 'nan-radius', 'nan-centre',
      ],
      stderr: '',
    });
    for (const d of done) expect(`${d.name} took ${d.ms}ms`).toBe(`${d.name} took ${Math.min(d.ms, 2000)}ms`);

    // A huge radius still carves — it is a legal shot with an absurd number on
    // it, clamped to the ceiling, not refused. A huge or non-finite CENTRE is
    // nowhere near the world box and carves nothing at all.
    const by = new Map(done.map((d) => [d.name, d.removed]));
    expect(by.get('huge-radius')).toBe(9378);
    for (const n of ['huge-centre-y', 'huge-centre-x', 'huge-centre-z',
      'negative-centre-y', 'infinite-radius', 'nan-radius', 'nan-centre']) {
      expect(`${n}=${by.get(n)}`).toBe(`${n}=0`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
