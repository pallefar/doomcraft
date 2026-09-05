/**
 * THE CLIENT'S CARVE IS A SECOND IMPLEMENTATION, AND IT HAS THE SAME HAZARD.
 *
 * `destruction.ts` owns its own `carveSphere`, with its own arithmetic — a
 * strength/resistance test instead of the server's hardness ceiling — and the
 * server-side bound does not reach it. Anything that can hang one can hang the
 * other, on a different thread with a different consequence: the server loses
 * the room, the client loses the tab.
 *
 * The mechanism is the same one `server/src/carveBounds.test.ts` describes:
 * `for (let x = x0; x <= x1; x++)` is only a loop while `x + 1` differs from
 * `x`, and `-1e20 + 1 === -1e20`. What differs here is WHICH loop. This
 * implementation already clamped y to `[0, CHUNK_HEIGHT - 1]`, so a huge `cy`
 * was never the hazard on this side — but x and z were clamped to nothing at
 * all, so `carveSphere(w, 1e20, ...)` with a radius of ONE spins the inner
 * loop forever. That asymmetry is exactly why the y clamp was not enough
 * evidence that this side was safe.
 *
 * There is a second, unrelated defect this file pins down while it is here:
 * `power` is not a loop bound, but `strength <= resist * jitter` with a NaN
 * strength is FALSE, so a NaN power carved every voxel in the sphere including
 * the ones blast resistance is supposed to save. Measured: 72 voxels against
 * the 36 a real rocket takes. Refusing non-finite input closes both.
 *
 * The hang cases run in a child process under a hard deadline for the reason
 * given in the server file: a spin loop cannot be interrupted by a timer on its
 * own thread, so an unbounded carve has to fail this suite, not wedge it.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHUNK_VOLUME, TERRAIN_CARVE_MAX_RADIUS } from '@shared/constants';
import { VoxelWorld } from './voxelWorld';
import { generateChunkInto, surfaceHeightAt } from './terrain';
import { carveSphere, TERRAIN_POWER_PER_BLOCK } from './destruction';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../..');
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLIENT_TSCONFIG = path.join(REPO_ROOT, 'client', 'tsconfig.json');
const CLIENT_SRC = path.join(REPO_ROOT, 'client', 'src', 'world');

/** The seed `destruction.test.ts` uses, so both files stand in the same terrain. */
const SEED = 1337;
const CX = 8.5, CZ = 8.5;
/** surfaceHeightAt(1337, 8, 8) is 21; carve from just under the surface block. */
const CY = 20.5;

function generatedWorld(radius = 2): VoxelWorld {
  const w = new VoxelWorld();
  const voxels = new Uint8Array(CHUNK_VOLUME);
  for (let cz = -radius; cz <= radius; cz++) {
    for (let cx = -radius; cx <= radius; cx++) {
      voxels.fill(0);
      generateChunkInto(SEED, cx, cz, voxels);
      w.copyChunkIn(cx, cz, voxels).loaded = true;
    }
  }
  return w;
}

/** Records every voxel the carve changed, in order, so "the same blocks" is real. */
class RecordingSink {
  readonly rows: string[] = [];
  push(x: number, y: number, z: number, id: number): boolean {
    this.rows.push(`${x},${y},${z}:${id}`);
    return true;
  }
  get digest(): string {
    let h = 2166136261 >>> 0;
    for (const ch of this.rows.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16);
  }
}

describe('client carveSphere is bounded', () => {
  it('surface is where this file thinks it is', () => {
    expect(surfaceHeightAt(SEED, 8, 8)).toBe(21);
  });

  /**
   * The clamp, in-process: radius 21 is only 42 blocks across, so the unbounded
   * version still terminates and can be compared against. `power` is held fixed
   * at the ceiling's own power so the only thing moving is the radius — which
   * matters, because radius also sets the falloff through `inv = 1 / r2`.
   * Pre-bound this removed 23311 voxels against the ceiling's 10808.
   */
  it('treats a radius past the ceiling as the ceiling, block for block', () => {
    const power = TERRAIN_CARVE_MAX_RADIUS * TERRAIN_POWER_PER_BLOCK;
    const capped = new RecordingSink();
    const over = new RecordingSink();
    const a = carveSphere(generatedWorld(), CX, CY, CZ,
      TERRAIN_CARVE_MAX_RADIUS, power, 0x51de, undefined, capped);
    const b = carveSphere(generatedWorld(), CX, CY, CZ,
      TERRAIN_CARVE_MAX_RADIUS + 5, power, 0x51de, undefined, over);
    expect(a).toBe(10808);
    expect(b).toBe(a);
    expect(over.digest).toBe(capped.digest);
  });

  /**
   * The no-op control. 2.6 is the rocket's `terrainDamage` and 5.5 is the BFG's;
   * they are the only non-zero radii the shipped game ever passes here, so a
   * ceiling of 16 has to be invisible to both. Both numbers and the exact voxel
   * list were measured before the bound existed.
   */
  it('leaves a rocket-sized carve exactly as it was', () => {
    const sink = new RecordingSink();
    const removed = carveSphere(generatedWorld(), CX, CY, CZ,
      2.6, 2.6 * TERRAIN_POWER_PER_BLOCK, 0xcafe, undefined, sink);
    expect(removed).toBe(36);
    // 36 removals plus the rim voxels scorch and settle write.
    expect(sink.rows.length).toBe(60);
    expect(sink.digest).toBe('62376bfa');
  });

  it('leaves a BFG-sized carve exactly as it was', () => {
    const removed = carveSphere(generatedWorld(), CX, CY, CZ,
      5.5, 5.5 * TERRAIN_POWER_PER_BLOCK, 0xbf6);
    expect(removed).toBe(475);
  });

  /**
   * The NaN-power defect, in-process because it never hung — it over-carved.
   * `strength = NaN` makes `NaN <= resist * jitter` false, which reads as "this
   * voxel loses", so obsidian and every other blast-resistant block came out.
   */
  it('refuses a non-finite power instead of carving through everything', () => {
    expect(carveSphere(generatedWorld(), CX, CY, CZ, 2.6, NaN, 0xcafe)).toBe(0);
  });

  /**
   * The hazards, out of process, each timed by the child itself so a case that
   * came back is proved to have come back quickly rather than eventually.
   */
  it('returns from every huge-input carve inside a deadline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doomcraft-carve-client-'));
    const probe = path.join(dir, 'probe.ts');
    fs.writeFileSync(probe, `
import fs from 'node:fs';
import { CHUNK_VOLUME } from '@shared/constants';
import { VoxelWorld } from ${JSON.stringify(path.join(CLIENT_SRC, 'voxelWorld.ts'))};
import { generateChunkInto } from ${JSON.stringify(path.join(CLIENT_SRC, 'terrain.ts'))};
import { carveSphere, TERRAIN_POWER_PER_BLOCK } from ${JSON.stringify(path.join(CLIENT_SRC, 'destruction.ts'))};

const w = new VoxelWorld();
const voxels = new Uint8Array(CHUNK_VOLUME);
for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) {
  voxels.fill(0);
  generateChunkInto(${SEED}, cx, cz, voxels);
  w.copyChunkIn(cx, cz, voxels).loaded = true;
}
const cases: [string, number, number, number, number][] = [
  ['huge-radius',       ${CX}, ${CY}, ${CZ}, 1e20],
  ['huge-centre-x',     1e20,  ${CY}, ${CZ}, 1],
  ['huge-centre-z',     ${CX}, ${CY}, 1e20,  1],
  ['huge-centre-y',     ${CX}, 1e20,  ${CZ}, 1],
  ['negative-centre-x', -1e20, ${CY}, ${CZ}, 1],
  ['infinite-radius',   ${CX}, ${CY}, ${CZ}, Infinity],
  ['nan-radius',        ${CX}, ${CY}, ${CZ}, NaN],
  ['nan-centre',        NaN,   ${CY}, ${CZ}, 1],
];
for (const [name, x, y, z, r] of cases) {
  const power = (Number.isFinite(r) ? Math.min(r, 16) : 16) * TERRAIN_POWER_PER_BLOCK;
  const t = Date.now();
  const removed = carveSphere(w, x, y, z, r, power, 0x51de);
  fs.writeSync(1, JSON.stringify({ name, removed, ms: Date.now() - t }) + '\\n');
}
`, 'utf8');

    const res = spawnSync(TSX, ['--tsconfig', CLIENT_TSCONFIG, probe], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL',
    });
    const done = res.stdout.split('\n').filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as { name: string; removed: number; ms: number });

    expect({ finished: done.map((d) => d.name), stderr: res.stderr.slice(-400) }).toEqual({
      finished: [
        'huge-radius', 'huge-centre-x', 'huge-centre-z', 'huge-centre-y',
        'negative-centre-x', 'infinite-radius', 'nan-radius', 'nan-centre',
      ],
      stderr: '',
    });
    for (const d of done) expect(`${d.name} took ${d.ms}ms`).toBe(`${d.name} took ${Math.min(d.ms, 2000)}ms`);

    const by = new Map(done.map((d) => [d.name, d.removed]));
    expect(by.get('huge-radius')).toBe(10808);
    for (const n of ['huge-centre-x', 'huge-centre-z', 'huge-centre-y',
      'negative-centre-x', 'infinite-radius', 'nan-radius', 'nan-centre']) {
      expect(`${n}=${by.get(n)}`).toBe(`${n}=0`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
