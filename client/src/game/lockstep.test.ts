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

import { BASE_ARSENAL, BASE_SLOT, SessionArsenal } from '@shared/arsenal';
import { WEAPON_COUNT, WEAPON_DAMAGE, WEAPONS, WeaponId, type WeaponDef } from '@shared/weapons';

import { record, recordServerWith, stats } from './lockstep.harness';

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
 * the weapon numbers would stay green through exactly the refactor it exists
 * to catch.
 *
 * THE LEVER CHANGED WITH V1c, AND THE CHANGE IS THE POINT. Before the seam,
 * poking `WEAPON_DAMAGE[PISTOL]` moved both tracks, because both predictors
 * read the module tables. The server now reads its room's arsenal, which
 * snapshots the compiled table once and never looks at it again — so a
 * module-table poke SHOULD leave the server track alone, and the honest proof
 * is to change the numbers where the session actually reads them: hand the
 * room a pinned table that differs, equip the claim, and watch the shots move.
 * That exercises the per-player `variantSlots` path too, which a compiled-only
 * recording never touches.
 *
 * The client track still reads the module tables. V1d moves it, and moves
 * these assertions with it.
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

/** The same far server track the golden opens with, under the compiled table. */
const serverBaseline = recordServerWith(BASE_ARSENAL, BASE_SLOT);

function serverUnder(over: Partial<WeaponDef>, base: number): string {
  return recordServerWith(SessionArsenal.from([{ id: 'probe', base, over }]), 1);
}

describe('the gate can fail', () => {
  it('an equipped variant that does nothing changes nothing', () => {
    // The other half of rule 2: if ANY equipped claim moved the recording, the
    // three cases below would be measuring the plumbing rather than the
    // numbers. An empty override must be invisible.
    expect(serverUnder({}, WeaponId.PISTOL)).toBe(serverBaseline);
  });

  it('moves when the room\'s pistol does one more point of damage', () => {
    expect(serverUnder({ damage: WEAPONS[WeaponId.PISTOL].damage + 1 }, WeaponId.PISTOL))
      .not.toBe(serverBaseline);
  });

  it('moves when the room\'s chaingun cycles faster', () => {
    expect(serverUnder({ rpm: WEAPONS[WeaponId.CHAINGUN].rpm + 20 }, WeaponId.CHAINGUN))
      .not.toBe(serverBaseline);
  });

  it('moves on a splash radius change of one centimetre', () => {
    // 4.4 -> 4.41 is invisible in play and unmistakable here. This is the
    // field the seam was most likely to get wrong: `splashDamageAtOf` reads
    // the float32 radius and sim.ts's detonate loop reads the double three
    // lines away, and the seam has to keep both.
    expect(serverUnder({ splashRadius: 4.41 }, WeaponId.ROCKET)).not.toBe(serverBaseline);
  });

  it('still moves the CLIENT track when a module table moves', () => {
    // Until V1d the client predictor reads the module tables directly, so this
    // is what proves the client half of the recording is watching anything.
    const t = tracks(withPerturbed(WEAPON_DAMAGE, WeaponId.PISTOL, 1));
    expect(t.client).not.toBe(tracks(recording).client);
  });

  it('leaves the SERVER track alone when a module table moves — the seam is live', () => {
    const t = tracks(withPerturbed(WEAPON_DAMAGE, WeaponId.PISTOL, 1));
    expect(t.server).toBe(tracks(recording).server);
  });

  it('restores every table it perturbed', () => {
    expect(digest(record())).toBe(digest(recording));
  });
});
