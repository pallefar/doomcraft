/**
 * THE V1 GATE — the arsenal seam changed nothing.
 *
 * `lockstep.harness.ts` drives a fixed-seed scripted session through BOTH
 * shipping predictors, at two ranges, and writes down every number they derive
 * from the weapon tables. This file pins that recording to a checked-in golden.
 *
 * The golden was minted at ee0991c, BEFORE `SessionArsenal` existed. Every
 * phase of VARIANTS.md §5 has to leave it byte-identical until a variant is
 * actually installed, which is the whole claim V1 makes.
 *
 * The recording is ~2 MB of numbers, so the file is gzipped — but the digest of
 * the UNCOMPRESSED text is also asserted inline, right below, because a binary
 * blob in a diff tells a reviewer nothing and a changed hex string tells them
 * everything that matters: the numbers moved.
 *
 * Regenerate deliberately, never casually:
 *     DOOMCRAFT_WRITE_GOLDEN=1 npx vitest run client/src/game/lockstep.test.ts
 * then paste the digest it prints into GOLDEN_DIGEST. A regeneration is a
 * statement that the numbers were SUPPOSED to move. If you cannot say which
 * ones and why, it did not work.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  WEAPON_COUNT, WEAPON_DAMAGE, WEAPON_FIRE_INTERVAL_MS, WEAPON_SPLASH_RADIUS, WeaponId,
} from '@shared/weapons';

import { record, stats } from './lockstep.harness';

/** sha256 of the uncompressed recording, first 16 hex. */
const GOLDEN_DIGEST = '305e47ad09d5b10f';

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lockstep.golden.txt.gz');

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** First line that differs, so a failure names the field rather than the file. */
function firstDifference(a: string, b: string): string {
  const la = a.split('\n');
  const lb = b.split('\n');
  const n = Math.max(la.length, lb.length);
  for (let i = 0; i < n; i++) {
    if (la[i] !== lb[i]) {
      return `line ${i + 1}\n  golden: ${la[i] ?? '<end of file>'}\n  now:    ${lb[i] ?? '<end of file>'}`;
    }
  }
  return '<no line differs — the files differ only in length or trailing bytes>';
}

const recording = record();
const writing = process.env.DOOMCRAFT_WRITE_GOLDEN === '1';

describe('lockstep determinism', () => {
  it('records a session that actually fires, connects, kills and flies', () => {
    // Rule 2. A recording of a session where nothing happened would be
    // perfectly stable and would prove nothing at all, so the SHAPE of the
    // recording is asserted before its bytes are. Every weapon must fire on
    // the client and land on the server — including the chainsaw, which only
    // reaches anything in the near arena, and the BFG, which only fires at all
    // because `settle` outlasts its 940 ms switch.
    const s = stats(recording);
    const every = Array.from({ length: WEAPON_COUNT }, (_, i) => i);
    expect(s.clientFired).toEqual(every);
    expect(s.serverHit).toEqual(every);
    // Rocket, BFG and chainsaw all finish somebody — the third of those is the
    // only route to the KILL_MELEE branch in `killPlayer`.
    expect(s.killWeapons).toContain(WeaponId.CHAINSAW);
    expect(s.killWeapons.length).toBeGreaterThanOrEqual(3);
    expect(s.shotRows).toBeGreaterThan(120);
    expect(s.pelletRows).toBeGreaterThan(150);   // the shotgun's cone, seven at a time
    expect(s.damageRows).toBeGreaterThan(100);
    expect(s.projectileRows).toBeGreaterThan(1000);
  });

  it('is stable inside one process', () => {
    expect(digest(record())).toBe(digest(recording));
  });

  it('reproduces the golden recording', () => {
    if (writing || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, gzipSync(Buffer.from(recording, 'utf8'), { level: 9 }));
      // Minting is not passing. A run that wrote the file has proven nothing,
      // and the digest below is what must be pasted into GOLDEN_DIGEST.
      throw new Error(`golden written. GOLDEN_DIGEST = '${digest(recording)}'`);
    }
    const golden = gunzipSync(readFileSync(GOLDEN)).toString('utf8');
    if (golden !== recording) {
      throw new Error(
        'the lockstep recording moved.\n'
        + `golden ${digest(golden)} -> now ${digest(recording)}\n`
        + firstDifference(golden, recording),
      );
    }
    expect(digest(recording)).toBe(GOLDEN_DIGEST);
  });
});

/* ------------------------------------------------------------------------ *
 * The gate can fail
 *
 * Rule 2 applied to the gate itself: a golden comparison that does not observe
 * the weapon tables would stay green through exactly the refactor it exists to
 * catch. Each case moves ONE number in ONE hot table and demands the recording
 * move with it — and names which track must move, because a harness that
 * watches only the server would pass a client-side mistake in silence.
 * ------------------------------------------------------------------------ */

function withPerturbed(table: { [i: number]: number }, index: number, delta: number): string {
  const was = table[index];
  table[index] = was + delta;
  try {
    return record();
  } finally {
    table[index] = was;
  }
}

function tracks(text: string): { server: string; client: string } {
  const at = text.indexOf('## track: client far');
  return { server: text.slice(0, at), client: text.slice(at) };
}

describe('the golden can fail', () => {
  const baseline = tracks(recording);

  it('moves when the pistol damage moves — on both predictors', () => {
    const t = tracks(withPerturbed(WEAPON_DAMAGE, WeaponId.PISTOL, 1));
    expect(t.server).not.toBe(baseline.server);
    expect(t.client).not.toBe(baseline.client);
  });

  it('moves when the chaingun fire interval moves — on both predictors', () => {
    const t = tracks(withPerturbed(WEAPON_FIRE_INTERVAL_MS, WeaponId.CHAINGUN, 1));
    expect(t.server).not.toBe(baseline.server);
    expect(t.client).not.toBe(baseline.client);
  });

  it('moves when the rocket splash radius moves — the float32 table, on the server', () => {
    // This is the field the seam is most likely to get wrong: `splashDamageAt`
    // reads the float32 4.400000095367432 and `sim.ts` reads the double 4.4
    // three lines away. A seam that unifies them is a behaviour change wearing
    // a refactor's clothes.
    const t = tracks(withPerturbed(WEAPON_SPLASH_RADIUS, WeaponId.ROCKET, 1));
    expect(t.server).not.toBe(baseline.server);
  });

  it('restores every table it perturbed', () => {
    expect(digest(record())).toBe(digest(recording));
  });
});
