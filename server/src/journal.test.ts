/**
 * DOOMCRAFT — the reward journal.
 *
 * The load-bearing test in this file is the last one in section 4: ten thousand
 * matches across two hundred devices through the REAL `applyMatchResult`, under
 * the REAL per-device lock, with the day cap and the diminishing-returns ladder
 * biting thousands of times — and then, for every player and both currencies,
 * the sum of the journal's deltas read back off the NDJSON must equal the
 * stored balance EXACTLY.
 *
 * That test is the whole reason the journal records the OBSERVED movement
 * rather than the amount the room asked for. Revert that one decision and it
 * goes red by tens of thousands of XP, which is exactly the size of the lie a
 * naive journal would have told about this economy.
 *
 * Everything else here exists to stop that test being satisfiable by a journal
 * that is merely self-consistent: the day-cap counters are asserted to have
 * fired, the idempotency claim is proven to gate the MUTATION and not just the
 * row, and a torn tail is proven not to eat the rows in front of it.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DAY_SCRAP_CAP,
  DAY_XP_CAP,
  MemoryStore,
  applyMatchResult,
  utcDay,
} from './persistence.js';
import type { MatchResult } from './persistence.js';
import {
  JsonJournal,
  MATCH_PAYOUT,
  MAX_ROW_BYTES,
  clampEntry,
  idempotencyKey,
  matchPayoutRows,
  newLedgerId,
  parseEntry,
  redactPlayerId,
  streamFor,
} from './journal.js';
import type { JournalFile, JournalFs, LedgerEntry } from './journal.js';

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

interface FakeFs {
  fs: JournalFs;
  files: Map<string, string[]>;
  text(path: string): string;
  breakWrites(on: boolean): void;
}

/**
 * An in-memory `JournalFs`.
 *
 * Chunks rather than one string: the invariant test appends 20,000 rows to four
 * day files, and `prev + data` on a growing string is quadratic — the fake
 * would be the slowest thing in the suite for a reason that has nothing to do
 * with the code under test.
 */
function memoryFs(): FakeFs {
  const files = new Map<string, string[]>();
  let broken = false;
  const fs: JournalFs = {
    async mkdir(): Promise<unknown> { return undefined; },
    async open(path: string): Promise<JournalFile> {
      if (!files.has(path)) files.set(path, []);
      return {
        async write(data: string): Promise<unknown> {
          if (broken) throw new Error('ENOSPC');
          files.get(path)?.push(data);
          return data.length;
        },
        async close(): Promise<unknown> { return undefined; },
      };
    },
    async stat(path: string): Promise<{ size: number }> {
      const t = files.get(path);
      if (t === undefined) throw new Error('ENOENT');
      return { size: t.join('').length };
    },
    async readFile(path: string): Promise<string> {
      const t = files.get(path);
      if (t === undefined) throw new Error('ENOENT');
      return t.join('');
    },
    async writeFile(path: string, data: string): Promise<void> { files.set(path, [data]); },
    async readdir(dir: string): Promise<string[]> {
      const out: string[] = [];
      for (const p of files.keys()) {
        if (!p.startsWith(dir + '/')) continue;
        out.push(p.slice(dir.length + 1));
      }
      return out;
    },
    async rename(from: string, to: string): Promise<void> {
      files.set(to, files.get(from) ?? []);
      files.delete(from);
    },
    async unlink(path: string): Promise<void> {
      if (!files.has(path)) throw new Error('ENOENT');
      files.delete(path);
    },
  };
  return {
    fs,
    files,
    text: (p: string): string => (files.get(p) ?? []).join(''),
    breakWrites: (on: boolean): void => { broken = on; },
  };
}

const DAY_MS = 86_400_000;
const NOON = Date.UTC(2026, 7, 22, 12, 0, 0);

function matchResultOf(xp: number, scrap: number): MatchResult {
  return {
    kills: 3, deaths: 1, won: true, bestStreak: 2, damageDealt: 400,
    blocksPlaced: 0, blocksBroken: 0, seconds: 180, xp, scrap, favouriteWeapon: 0,
    drops: [], challengeIds: [], mayPayChallenges: false, mayGrantChallengeItems: false,
  };
}

/** A payout group for a player, built exactly the way `Room` builds one. */
function payout(playerId: string, sourceId: string, ms: number, before: { xp: number; scrap: number }, after: { xp: number; scrap: number }, asked: { xp: number; scrap: number }): LedgerEntry[] {
  return matchPayoutRows({ playerId, sourceId, ms, before, after, asked });
}

/** Deterministic, so a failure is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------------ *
 * 1. The pure half
 * ------------------------------------------------------------------------ */

describe('the idempotency key', () => {
  it('is a TRIPLE, because one round pays every player in the room', () => {
    // The bug this is here to stop: `docs/PLATFORM.md` §4.3 keys on
    // (kind, sourceId). A sourceId names a ROUND. Under that key the first
    // player paid in a 32-player match claims it and the other 31 are refused
    // as duplicates — and since the claim gates the mutation, unpaid.
    const source = 'host:room:deathmatch#3';
    const a = idempotencyKey(MATCH_PAYOUT, source, 'device-aaaa0001');
    const b = idempotencyKey(MATCH_PAYOUT, source, 'device-bbbb0002');
    expect(a).not.toBe(b);
  });

  it('cannot be forged by a room key containing the delimiters', () => {
    // Room keys really do contain `:`, `#` and `~` — a private room's key IS
    // `${mode}~${joinCode}`. A delimiter-joined key would let one room's
    // payout collide with another's and silently refuse it.
    const one = idempotencyKey(MATCH_PAYOUT, 'h:x:dm~ab#1', 'device-aaaa0001');
    const two = idempotencyKey(MATCH_PAYOUT, 'h:x:dm~ab#1device-aaaa0001', '');
    expect(one).not.toBe(two);
  });

  it('separates the kinds, so a refund is not the purchase it reverses', () => {
    expect(idempotencyKey('purchase.grant', 's', 'p'))
      .not.toBe(idempotencyKey('purchase.refund', 's', 'p'));
  });
});

describe('the ledger id', () => {
  it('sorts by time and is monotonic INSIDE one millisecond', () => {
    // Two payouts in the same millisecond is the normal case at the end of a
    // round: `endRound` pays every member in one synchronous loop.
    const ids = [newLedgerId(NOON), newLedgerId(NOON), newLedgerId(NOON), newLedgerId(NOON)];
    expect(ids).toHaveLength(new Set(ids).size);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('sorts a later millisecond after an earlier one', () => {
    const early = newLedgerId(NOON);
    const late = newLedgerId(NOON + 1000);
    expect(late > early).toBe(true);
  });
});

describe('a match payout', () => {
  it('records the OBSERVED movement, not the amount anybody asked for', () => {
    // The day cap ate 90 of the 100 XP. A row saying 100 is a row that makes
    // the balance unreconstructible, and it is what a journal written from
    // `MatchResult` rather than from the profile would say.
    const rows = payout('device-aaaa0001', 'h:r:s#1', NOON,
      { xp: 5990, scrap: 0 }, { xp: 6000, scrap: 0 }, { xp: 100, scrap: 0 });
    const xp = rows.find((r) => r.currency === 'xp');
    expect(xp?.delta).toBe(10);
    expect(xp?.balanceAfter).toBe(6000);
    expect(xp?.reason).toContain('metered from 100');
  });

  it('writes a row for BOTH currencies, and a zero one is still a row', () => {
    // A zero row is the answer to "I played forty rounds and got nothing".
    // It is also the thing that makes the idempotency claim exist for a match
    // that moved no money — without it a replay re-runs `applyMatchResult` and
    // increments gamesPlayed, kills and the day meter a second time.
    const rows = payout('device-aaaa0001', 'h:r:s#1', NOON,
      { xp: 6000, scrap: 800 }, { xp: 6000, scrap: 800 }, { xp: 40, scrap: 12 });
    expect(rows.map((r) => r.currency)).toEqual(['xp', 'scrap']);
    expect(rows.every((r) => r.delta === 0)).toBe(true);
    expect(rows.every((r) => r.kind === MATCH_PAYOUT)).toBe(true);
    expect(rows.every((r) => r.actor === 'system:room')).toBe(true);
  });

  it('sends a purchase to the financial stream and a payout to the ledger', () => {
    // The split is made at WRITE time because it cannot be made at delete time:
    // erasure must remove one and keep the other.
    expect(streamFor(MATCH_PAYOUT)).toBe('journal');
    expect(streamFor('spend')).toBe('journal');
    expect(streamFor('purchase.grant')).toBe('financial');
    expect(streamFor('purchase.refund')).toBe('financial');
  });
});

describe('row hygiene', () => {
  it('clamps every free-text field, so the on-disk bound is a fact', () => {
    const e = clampEntry({
      id: 'x'.repeat(80), ms: 1.7, playerId: 'p'.repeat(200), currency: 'xp',
      kind: MATCH_PAYOUT, sourceId: 's'.repeat(500), delta: 1.4, balanceAfter: 2.6,
      actor: 'a'.repeat(200), reason: 'r'.repeat(500),
    });
    expect(JSON.stringify(e).length).toBeLessThanOrEqual(MAX_ROW_BYTES);
    expect(e.ms).toBe(2);
    expect(e.delta).toBe(1);
  });

  it('refuses a line that is not a row this build can read', () => {
    expect(parseEntry('not json')).toBeNull();
    expect(parseEntry('{"id":"a"}')).toBeNull();
    expect(parseEntry('[1,2,3]')).toBeNull();
    expect(parseEntry(JSON.stringify({ ...payout('p', 's', 1, { xp: 0, scrap: 0 }, { xp: 1, scrap: 0 }, { xp: 1, scrap: 0 })[0], kind: 'nonsense' }))).toBeNull();
  });

  it('never puts a full device id in a redacted key', () => {
    const id = 'device-aaaa0001';
    expect(redactPlayerId(id)).toHaveLength(8);
    expect(redactPlayerId(id)).not.toContain(id);
    expect(redactPlayerId(id)).toBe(redactPlayerId(id));
    expect(redactPlayerId(id)).not.toBe(redactPlayerId('device-aaaa0002'));
  });
});

/* ------------------------------------------------------------------------ *
 * 2. The store
 * ------------------------------------------------------------------------ */

describe('the journal on disk', () => {
  it('writes one NDJSON line per currency, under a day file', async () => {
    const fake = memoryFs();
    const j = new JsonJournal('/data', { fs: fake.fs, clock: () => NOON });
    const n = await j.append(payout('device-aaaa0001', 'h:r:s#1', NOON,
      { xp: 0, scrap: 0 }, { xp: 140, scrap: 22 }, { xp: 140, scrap: 22 }));
    expect(n).toBe(2);
    const text = fake.text(`/data/journal/${utcDay(NOON)}.ndjson`);
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(parseEntry(lines[0])?.delta).toBe(140);
    expect(parseEntry(lines[1])?.delta).toBe(22);
  });

  it('refuses a replayed (kind, sourceId, playerId) and writes NO second row', async () => {
    const fake = memoryFs();
    const j = new JsonJournal('/data', { fs: fake.fs, clock: () => NOON });
    const rows = payout('device-aaaa0001', 'h:r:s#1', NOON,
      { xp: 0, scrap: 0 }, { xp: 140, scrap: 22 }, { xp: 140, scrap: 22 });
    expect(await j.append(rows)).toBe(2);
    expect(await j.append(rows)).toBe(0);
    const lines = fake.text(`/data/journal/${utcDay(NOON)}.ndjson`).split('\n').filter((l) => l.length > 0);
    expect(lines, 'the replay wrote a second row').toHaveLength(2);
    expect(j.status().duplicates).toBe(1);
  });

  it('pays a DIFFERENT player for the same round, which the doc key would not', async () => {
    const fake = memoryFs();
    const j = new JsonJournal('/data', { fs: fake.fs, clock: () => NOON });
    const source = 'h:r:deathmatch#3';
    expect(await j.append(payout('device-aaaa0001', source, NOON, { xp: 0, scrap: 0 }, { xp: 10, scrap: 1 }, { xp: 10, scrap: 1 }))).toBe(2);
    expect(await j.append(payout('device-bbbb0002', source, NOON, { xp: 0, scrap: 0 }, { xp: 10, scrap: 1 }, { xp: 10, scrap: 1 }))).toBe(2);
    expect(await j.append(payout('device-cccc0003', source, NOON, { xp: 0, scrap: 0 }, { xp: 10, scrap: 1 }, { xp: 10, scrap: 1 }))).toBe(2);
  });

  it('still knows about a claim after a RESTART, because it reads the day back', async () => {
    const fake = memoryFs();
    const rows = payout('device-aaaa0001', 'h:r:s#1', NOON,
      { xp: 0, scrap: 0 }, { xp: 140, scrap: 22 }, { xp: 140, scrap: 22 });
    const first = new JsonJournal('/data', { fs: fake.fs, clock: () => NOON });
    expect(await first.append(rows)).toBe(2);
    await first.close();

    // A new process over the same files. The dedup set is per-process, so this
    // is the seed-on-boot path and nothing else.
    const second = new JsonJournal('/data', { fs: fake.fs, clock: () => NOON });
    expect(await second.has(MATCH_PAYOUT, 'h:r:s#1', 'device-aaaa0001')).toBe(true);
    expect(await second.append(rows)).toBe(0);
    expect(fake.text(`/data/journal/${utcDay(NOON)}.ndjson`).split('\n').filter((l) => l.length > 0)).toHaveLength(2);
  });

  it('survives a TORN write: the rows in front of it are still readable', async () => {
    const fake = memoryFs();
    const day = utcDay(NOON);
    const good = payout('device-aaaa0001', 'h:r:s#1', NOON, { xp: 0, scrap: 0 }, { xp: 10, scrap: 2 }, { xp: 10, scrap: 2 });
    const first = new JsonJournal('/data', { fs: fake.fs, clock: () => NOON });
    await first.append(good);
    await first.close();
    // A process killed mid-write: a partial line with no newline on the end.
    fake.files.get(`/data/journal/${day}.ndjson`)?.push('{"id":"ZZZ","ms":1,"pla');

    const second = new JsonJournal('/data', { fs: fake.fs, clock: () => NOON });
    await second.append(payout('device-aaaa0001', 'h:r:s#2', NOON, { xp: 10, scrap: 2 }, { xp: 20, scrap: 4 }, { xp: 10, scrap: 2 }));
    const sums = await second.balances('device-aaaa0001');
    // Both complete payouts survive the torn row between them, and the torn
    // row is counted rather than thrown.
    expect(sums.xp).toBe(20);
    expect(sums.scrap).toBe(4);
    expect(second.status().torn).toBeGreaterThan(0);
    // And the next append did NOT concatenate onto the torn line.
    expect(fake.text(`/data/journal/${day}.ndjson`)).toContain('"pla\n');
  });

  it('counts a row it could not write, so a silent divergence is visible', async () => {
    const fake = memoryFs();
    const j = new JsonJournal('/data', { fs: fake.fs, clock: () => NOON });
    await j.ready();
    fake.breakWrites(true);
    const n = await j.append(payout('device-aaaa0001', 'h:r:s#1', NOON, { xp: 0, scrap: 0 }, { xp: 10, scrap: 2 }, { xp: 10, scrap: 2 }));
    expect(n).toBe(0);
    expect(j.status().failed).toBe(2);
    expect(j.status().degraded).toBe(true);
    // The claim is still held. The balance has already moved by the time
    // `append` is called, so a retry would move it twice: a lost row is a
    // counter, a double payout is money.
    expect(await j.has(MATCH_PAYOUT, 'h:r:s#1', 'device-aaaa0001')).toBe(true);
  });

  it('refuses a group that spans two idempotency keys', async () => {
    const fake = memoryFs();
    const j = new JsonJournal('/data', { fs: fake.fs, clock: () => NOON });
    const a = payout('device-aaaa0001', 'h:r:s#1', NOON, { xp: 0, scrap: 0 }, { xp: 1, scrap: 0 }, { xp: 1, scrap: 0 });
    const b = payout('device-bbbb0002', 'h:r:s#1', NOON, { xp: 0, scrap: 0 }, { xp: 1, scrap: 0 }, { xp: 1, scrap: 0 });
    await expect(j.append([a[0], b[0]])).rejects.toThrow(/share/);
  });
});

/* ------------------------------------------------------------------------ *
 * 3. Reading, retention and erasure
 * ------------------------------------------------------------------------ */

describe('the read path an operator uses', () => {
  it('answers newest first, honours `since`, and stops at the limit', async () => {
    const fake = memoryFs();
    let now = NOON;
    const j = new JsonJournal('/data', { fs: fake.fs, clock: () => now });
    let xp = 0;
    for (let i = 0; i < 5; i++) {
      await j.append(payout('device-aaaa0001', `h:r:s#${i}`, now, { xp, scrap: 0 }, { xp: xp + 10, scrap: 0 }, { xp: 10, scrap: 0 }));
      xp += 10;
      now += DAY_MS;
    }
    const all = await j.read('device-aaaa0001', 0, 100);
    expect(all).toHaveLength(10);
    expect(all[0].ms).toBeGreaterThan(all[9].ms);
    // Newest first, and within one payout the rows come back in the reverse of
    // the order they were written — which is what "newest first" means for two
    // rows with the same millisecond.
    expect(all[0].currency).toBe('scrap');
    expect(all[1].currency).toBe('xp');
    expect(all[1].balanceAfter).toBe(50);
    expect(all[9].balanceAfter).toBe(10);

    const recent = await j.read('device-aaaa0001', NOON + 3 * DAY_MS, 100);
    expect(recent).toHaveLength(4);
    expect((await j.read('device-aaaa0001', 0, 3))).toHaveLength(3);
    expect(await j.read('device-bbbb0002', 0, 100)).toEqual([]);
  });

  it('reports the oldest retained day, so a truncated sum is never read as a balance', async () => {
    const fake = memoryFs();
    let now = NOON;
    const j = new JsonJournal('/data', { fs: fake.fs, clock: () => now, journalDays: 2 });
    for (let i = 0; i < 5; i++) {
      await j.append(payout('device-aaaa0001', `h:r:s#${i}`, now, { xp: i * 10, scrap: 0 }, { xp: i * 10 + 10, scrap: 0 }, { xp: 10, scrap: 0 }));
      now += DAY_MS;
    }
    expect((await j.balances('device-aaaa0001')).xp).toBe(50);
    // THE BOUND: whole day files outside the window are deleted, and with them
    // the ability to reconstruct a balance from before that day.
    const removed = await j.sweep();
    expect(removed).toBe(3);
    const after = await j.balances('device-aaaa0001');
    expect(after.xp).toBe(20);
    expect(after.fromDay).toBe(utcDay(NOON + 3 * DAY_MS));
  });

  it('keeps the financial stream far longer than the ledger', async () => {
    const fake = memoryFs();
    const now = NOON;
    const j = new JsonJournal('/data', { fs: fake.fs, clock: () => now, journalDays: 2, financialDays: 3650 });
    const old = now - 40 * DAY_MS;
    await j.append(payout('device-aaaa0001', 'h:r:s#1', old, { xp: 0, scrap: 0 }, { xp: 10, scrap: 0 }, { xp: 10, scrap: 0 }));
    await j.append([{
      id: newLedgerId(old), ms: old, playerId: 'device-aaaa0001', currency: 'scrap',
      kind: 'purchase.grant', sourceId: 'paddle:evt_1', delta: 500, balanceAfter: 500,
      actor: 'system:billing', reason: 'purchase',
    }]);
    await j.sweep();
    expect(fake.files.has(`/data/journal/${utcDay(old)}.ndjson`)).toBe(false);
    expect(fake.files.has(`/data/financial/${utcDay(old)}.ndjson`)).toBe(true);
  });

  it('erases the ledger and PSEUDONYMISES the financial record', async () => {
    const fake = memoryFs();
    const j = new JsonJournal('/data', { fs: fake.fs, clock: () => NOON });
    await j.append(payout('device-aaaa0001', 'h:r:s#1', NOON, { xp: 0, scrap: 0 }, { xp: 10, scrap: 2 }, { xp: 10, scrap: 2 }));
    await j.append(payout('device-bbbb0002', 'h:r:s#1', NOON, { xp: 0, scrap: 0 }, { xp: 10, scrap: 2 }, { xp: 10, scrap: 2 }));
    await j.append([{
      id: newLedgerId(NOON), ms: NOON, playerId: 'device-aaaa0001', currency: 'scrap',
      kind: 'purchase.grant', sourceId: 'paddle:evt_1', delta: 500, balanceAfter: 500,
      actor: 'system:billing', reason: 'purchase',
    }]);

    const touched = await j.forget('device-aaaa0001');
    expect(touched).toBe(3);
    expect(await j.balances('device-aaaa0001')).toMatchObject({ rows: 0 });
    // The other player is untouched.
    expect((await j.balances('device-bbbb0002')).xp).toBe(10);
    // ...and the financial row is still there, under a tombstone.
    const fin = fake.text(`/data/financial/${utcDay(NOON)}.ndjson`);
    expect(fin).not.toContain('device-aaaa0001');
    expect(fin).toContain(`deleted:${redactPlayerId('device-aaaa0001')}`);
    expect(parseEntry(fin.split('\n')[0])?.delta).toBe(500);
  });
});

/* ------------------------------------------------------------------------ *
 * 4. THE INVARIANT
 *
 *   for every playerId: Σ journal.delta(currency) == profile balance(currency)
 * ------------------------------------------------------------------------ */

describe('ten thousand matches', () => {
  it('sums to the stored balance EXACTLY, per player and per currency', async () => {
    const fake = memoryFs();
    const store = new MemoryStore();
    let now = Date.UTC(2026, 7, 20, 0, 0, 0);
    const j = new JsonJournal('/data', { fs: fake.fs, clock: () => now, journalDays: 4000 });
    const devices = Array.from({ length: 200 }, (_, i) => `device-inv${String(i).padStart(5, '0')}`);
    const rng = mulberry32(0xd00d);

    let laddered = 0;
    let capped = 0;
    let paidNothing = 0;
    let payouts = 0;
    const days = new Set<string>();

    for (let m = 0; m < 10_000; m++) {
      // Thirty seconds of wall clock per match: ten thousand matches span three
      // and a half days, so every device plays about fourteen rounds a day —
      // deep into the diminishing-returns ladder and over the day cap — and
      // four UTC midnights pass underneath the run.
      now += 30_000;
      days.add(utcDay(now));
      const at = now;
      // ONE ROUND PAYS SEVERAL PLAYERS, and they share a `sourceId`. That is
      // the shape of a real match and it is what makes this run able to catch
      // an idempotency key that omits the player: under `(kind, sourceId)` the
      // first player in each round is paid and the rest are refused as
      // duplicates, which shows up here as a balance the journal cannot explain.
      const sourceId = `host:room${m % 7}:key#${m}`;
      const seats = 1 + Math.floor(rng() * 4);
      const start = Math.floor(rng() * devices.length);
      for (let seat = 0; seat < seats; seat++) {
        const deviceId = devices[(start + seat) % devices.length];
        const askedXp = 600 + Math.floor(rng() * 600);
        const askedScrap = 80 + Math.floor(rng() * 80);
        payouts++;
        await store.update(deviceId, async (profile) => {
          if (await j.has(MATCH_PAYOUT, sourceId, deviceId)) return;
          const before = { xp: profile.progress.xp, scrap: profile.economy.scrap };
          const landed = applyMatchResult(profile, matchResultOf(askedXp, askedScrap), at);
          const after = { xp: profile.progress.xp, scrap: profile.economy.scrap };
          if (landed.xp < askedXp) laddered++;
          if (landed.xp === 0 && landed.scrap === 0) paidNothing++;
          if (profile.economy.dayXp >= DAY_XP_CAP || profile.economy.dayScrap >= DAY_SCRAP_CAP) capped++;
          await j.append(matchPayoutRows({
            playerId: deviceId, sourceId, ms: at, before, after,
            asked: { xp: askedXp, scrap: askedScrap },
          }));
        });
      }
    }

    /* FIRST, because it is the failure with the most misleading symptoms: a
     * payout refused as a duplicate of ANOTHER PLAYER in the same round leaves
     * that player at zero with no rows, so `Σ delta == balance` still holds for
     * them and the invariant below is blind to it. The count is the thing that
     * is not blind. */
    expect(
      j.status().appended,
      'a payout was refused — the idempotency key is not per player',
    ).toBe(payouts * 2);
    expect(j.status().duplicates).toBe(0);

    /* The metering ACTUALLY BIT. Without these four the invariant could be
     * satisfied by a run in which nothing was ever clamped — which is the run
     * that proves nothing, because the amount asked for and the amount banked
     * would be the same number. */
    expect(days.size, 'no UTC midnight passed').toBeGreaterThanOrEqual(4);
    expect(laddered, 'the diminishing-returns ladder never fired').toBeGreaterThan(10_000);
    expect(capped, 'no day cap was ever reached').toBeGreaterThan(5_000);
    expect(paidNothing, 'no match was ever metered down to nothing').toBeGreaterThan(1_000);

    /* Read the sums back off the NDJSON the journal actually wrote, through the
     * same `parseEntry` a reader uses. Not off an in-memory tally: the file is
     * the artefact this whole stage exists to produce. */
    const sums = new Map<string, { xp: number; scrap: number }>();
    let rows = 0;
    for (const [path, chunks] of fake.files) {
      if (!path.startsWith('/data/journal/')) continue;
      for (const line of chunks.join('').split('\n')) {
        if (line.length === 0) continue;
        const e = parseEntry(line);
        expect(e, `unreadable row in ${path}`).not.toBeNull();
        if (e === null) continue;
        rows++;
        const acc = sums.get(e.playerId) ?? { xp: 0, scrap: 0 };
        if (e.currency === 'xp') acc.xp += e.delta; else acc.scrap += e.delta;
        sums.set(e.playerId, acc);
      }
    }
    // Every payout wrote both of its rows, and none of them was refused as a
    // duplicate of another player in the same round.
    expect(payouts).toBeGreaterThan(20_000);
    expect(rows).toBe(payouts * 2);

    let totalXp = 0;
    for (const deviceId of devices) {
      const profile = await store.ensure(deviceId);
      const acc = sums.get(deviceId) ?? { xp: 0, scrap: 0 };
      expect(acc.xp, `xp diverged for ${deviceId}`).toBe(profile.progress.xp);
      expect(acc.scrap, `scrap diverged for ${deviceId}`).toBe(profile.economy.scrap);
      totalXp += profile.progress.xp;
    }
    expect(totalXp).toBeGreaterThan(0);

    // And the journal's own reader agrees with the raw parse, for a sample —
    // `balances()` is what the admin route calls, and a full 200-device scan of
    // 20,000 rows is 4M parses that prove the same thing 200 times.
    for (const deviceId of devices.slice(0, 5)) {
      const profile = await store.ensure(deviceId);
      const b = await j.balances(deviceId);
      expect(b.xp).toBe(profile.progress.xp);
      expect(b.scrap).toBe(profile.economy.scrap);
    }
  }, 120_000);

  it('writes no second row for a replayed submission, and moves no balance', async () => {
    const fake = memoryFs();
    const store = new MemoryStore();
    const now = NOON;
    const j = new JsonJournal('/data', { fs: fake.fs, clock: () => now });
    const deviceId = 'device-aaaa0001';
    const sourceId = 'host:room:deathmatch#1';

    const once = async (): Promise<void> => {
      await store.update(deviceId, async (profile) => {
        if (await j.has(MATCH_PAYOUT, sourceId, deviceId)) return;
        const before = { xp: profile.progress.xp, scrap: profile.economy.scrap };
        applyMatchResult(profile, matchResultOf(300, 40), now);
        await j.append(matchPayoutRows({
          playerId: deviceId, sourceId, ms: now, before,
          after: { xp: profile.progress.xp, scrap: profile.economy.scrap },
          asked: { xp: 300, scrap: 40 },
        }));
      });
    };

    await once();
    const first = await store.ensure(deviceId);
    expect(first.progress.xp).toBe(300);
    expect(first.progress.gamesPlayed).toBe(1);

    await once();
    await once();
    const after = await store.ensure(deviceId);
    // Not just "no second row": no second MUTATION either. A journal that
    // declines to record a payout while `applyMatchResult` runs anyway is a
    // journal that lies about a balance it watched change.
    expect(after.progress.xp).toBe(300);
    expect(after.economy.scrap).toBe(40);
    expect(after.progress.gamesPlayed).toBe(1);
    expect(after.economy.dayMatches).toBe(1);
    const lines = fake.text(`/data/journal/${utcDay(now)}.ndjson`).split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect((await j.balances(deviceId)).xp).toBe(after.progress.xp);
  });
});

/* ------------------------------------------------------------------------ *
 * 5. On a real disk
 * ------------------------------------------------------------------------ */

describe('on a real filesystem', () => {
  it('writes real NDJSON that a restarted process reads back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-journal-'));
    const first = new JsonJournal(root, { clock: () => NOON });
    await first.append(payout('device-aaaa0001', 'h:r:s#1', NOON, { xp: 0, scrap: 0 }, { xp: 140, scrap: 22 }, { xp: 140, scrap: 22 }));
    await first.close();

    const day = utcDay(NOON);
    expect(readdirSync(join(root, 'journal'))).toContain(`${day}.ndjson`);
    const text = readFileSync(join(root, 'journal', `${day}.ndjson`), 'utf8');
    expect(text.split('\n').filter((l) => l.length > 0)).toHaveLength(2);

    const second = new JsonJournal(root, { clock: () => NOON });
    expect(await second.has(MATCH_PAYOUT, 'h:r:s#1', 'device-aaaa0001')).toBe(true);
    expect((await second.balances('device-aaaa0001')).xp).toBe(140);
    expect(await second.append(payout('device-aaaa0001', 'h:r:s#1', NOON, { xp: 140, scrap: 22 }, { xp: 280, scrap: 44 }, { xp: 140, scrap: 22 }))).toBe(0);
    await second.close();
    expect(readFileSync(join(root, 'journal', `${day}.ndjson`), 'utf8').split('\n').filter((l) => l.length > 0)).toHaveLength(2);
  });
});
