/**
 * DOOMCRAFT — the merge, proven against docs/PLATFORM.md §3.7's worked
 * example FIELD BY FIELD, plus the three wrong day-bucket answers §3.3.2
 * names, the money rule of §3.3.1, the §3.5 budget, and the full
 * device-into-account application over real stores and a real journal.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { levelForXp } from '@doomcraft/shared/constants';
import { asAccountId, asDeviceId } from '@doomcraft/shared/identity';

import { AccountGraph, MemoryGraphBackend } from './accountGraph.js';
import { JsonJournal } from './journal.js';
import { applyMergeFields, budgetRefusal, mergeDeviceIntoAccount, planMerge, undoMerge } from './merge.js';
import { MemoryStore, createProfile, utcDay, type StoredProfile } from './persistence.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dc-merge-'));
  tempDirs.push(d);
  return d;
}

/** §3.7's NOW: 22 Aug 2026, mid-day UTC. */
const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);

function profileA(): StoredProfile {
  const p = createProfile('dev-aaaaaaaa', NOW - 90 * 86400e3);
  p.progress = {
    ...p.progress, name: 'A', xp: 4200, level: 14, gamesPlayed: 62,
    kills: 500, deaths: 300, wins: 20, bestKillstreak: 7,
  };
  p.stats = { ...p.stats, matches: 62, bestStreak: 7, kills: 500, deaths: 300 };
  p.economy = {
    scrap: 380, lifetimeScrap: 1240,
    day: utcDay(NOW), dayXp: 900, dayScrap: 120, dayMatches: 2,
  };
  p.entitlements = { adsRemoved: true, product: 'remove-ads', receipt: 'rcp-a', purchasedMs: 111 };
  p.progress.adsRemoved = true;
  return p;
}

function profileB(): StoredProfile {
  const p = createProfile('dev-bbbbbbbb', NOW - 10 * 86400e3);
  p.progress = {
    ...p.progress, name: 'B', xp: 900, level: 6, gamesPlayed: 11,
    kills: 80, deaths: 90, wins: 2, bestKillstreak: 11,
  };
  p.stats = { ...p.stats, matches: 11, bestStreak: 11, kills: 80, deaths: 90 };
  p.economy = {
    scrap: 40, lifetimeScrap: 210,
    // Last played 20 Aug AT THE CAP — the stale bucket §3.3.2 is about.
    day: '2026-08-20', dayXp: 6000, dayScrap: 800, dayMatches: 12,
  };
  return p;
}

describe('applyMergeFields — the §3.7 worked example, field by field', () => {
  it('sums what happened, maxes the records, recomputes the level from the summed xp', () => {
    const a = profileA(); const b = profileB();
    applyMergeFields(a, b, NOW);
    expect(a.progress.xp).toBe(5100);
    expect(a.progress.level).toBe(levelForXp(5100));
    expect(a.progress.gamesPlayed).toBe(73);
    expect(a.progress.bestKillstreak).toBe(11);
    expect(a.stats.matches).toBe(73);
    expect(a.stats.bestStreak).toBe(11);
    expect(a.createdMs).toBe(Math.min(profileA().createdMs, profileB().createdMs));
  });

  it("THE DAY-BUCKET FIX: B's stale cap does not throttle A for the rest of the day", () => {
    const a = profileA(); const b = profileB();
    applyMergeFields(a, b, NOW);
    // Rolled first, THEN maxed: B's 20 Aug bucket zeroes before comparison.
    expect(a.economy.day).toBe(utcDay(NOW));
    expect(a.economy.dayXp).toBe(900);
    expect(a.economy.dayScrap).toBe(120);
    expect(a.economy.dayMatches).toBe(2);
  });

  it('MONEY IS NEVER ASSIGNED HERE — balances are exactly what they were', () => {
    const a = profileA(); const b = profileB();
    const { scrapDelta } = applyMergeFields(a, b, NOW);
    expect(scrapDelta).toBe(40);
    expect(a.economy.scrap).toBe(380);
    expect(a.economy.lifetimeScrap).toBe(1240);
  });

  it("entitlements: adsRemoved is an OR, purchasedMs the min of real grants, and A's preferences stand", () => {
    const a = profileA(); const b = profileB();
    b.entitlements = { adsRemoved: true, product: 'remove-ads', receipt: 'rcp-b', purchasedMs: 55 };
    const fov = a.settings;
    applyMergeFields(a, b, NOW);
    expect(a.entitlements.adsRemoved).toBe(true);
    expect(a.entitlements.purchasedMs).toBe(55);
    expect(a.entitlements.receipt).toBe('rcp-a');   // receipts stay on their records
    expect(a.settings).toBe(fov);                    // wholesale, untouched
  });
});

describe('the §3.5 budget', () => {
  it('two per window, five per lifetime, and the window rolls', () => {
    expect(budgetRefusal({ mergesLifetime: 0, mergesWindowStartMs: NOW, mergesInWindow: 0 }, NOW)).toBeNull();
    expect(budgetRefusal({ mergesLifetime: 1, mergesWindowStartMs: NOW, mergesInWindow: 2 }, NOW)).not.toBeNull();
    // A window that started 31 days ago has lapsed.
    expect(budgetRefusal({ mergesLifetime: 2, mergesWindowStartMs: NOW - 31 * 86400e3, mergesInWindow: 2 }, NOW)).toBeNull();
    expect(budgetRefusal({ mergesLifetime: 5, mergesWindowStartMs: 0, mergesInWindow: 0 }, NOW)).toBe(0);
  });
});

describe('mergeDeviceIntoAccount — over real stores and a real journal', () => {
  async function rig(): Promise<{
    root: string; graph: AccountGraph; store: MemoryStore; journal: JsonJournal;
    accountId: ReturnType<typeof asAccountId>;
  }> {
    const root = tempDir();
    const graph = new AccountGraph(new MemoryGraphBackend(), { clock: () => NOW });
    const store = new MemoryStore();
    const journal = new JsonJournal(root, { clock: () => NOW });
    // A's account, home = dev-aaaaaaaa, with A's profile on file.
    const made = await graph.signIn({
      provider: 'pass', secretHash: null, credentialAccount: null,
      mintAccountId: asAccountId('pass:acct-a'),
      deviceId: asDeviceId('dev-aaaaaaaa'), deviceHasProfile: true, deviceCountable: true,
      answer: 'keep',
    });
    if (made.kind !== 'account') throw new Error(made.kind);
    await store.update('dev-aaaaaaaa', (p) => { Object.assign(p, profileA()); });
    await store.update('dev-bbbbbbbb', (p) => { Object.assign(p, profileB()); });
    return { root, graph, store, journal, accountId: asAccountId('pass:acct-a') };
  }

  it('moves the balance THROUGH the journal, absorbs the fields, and repoints the device', async () => {
    const { root, graph, store, journal, accountId } = await rig();
    const result = await mergeDeviceIntoAccount(
      { graph, store, journal, dataRoot: root, clock: () => NOW },
      accountId, asDeviceId('dev-bbbbbbbb'), 'player', 'test',
    );
    expect(result.ok).toBe(true);

    const a = await store.load('dev-aaaaaaaa');
    const b = await store.load('dev-bbbbbbbb');
    expect(a?.economy.scrap).toBe(420);
    expect(a?.economy.lifetimeScrap).toBe(1280);
    expect(a?.progress.xp).toBe(5100);
    expect(b?.economy.scrap).toBe(0);

    // The journal holds the debit/credit pair, keyed to the merge event.
    const rows = readFileSync(join(root, 'journal', `${utcDay(NOW)}.ndjson`), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const debit = rows.find((r) => r.kind === 'merge.debit');
    const credit = rows.find((r) => r.kind === 'merge.credit');
    expect(debit?.delta).toBe(-40);
    expect(credit?.delta).toBe(40);
    expect(credit?.balanceAfter).toBe(420);
    expect(debit?.sourceId).toBe(credit?.sourceId);

    // The device now banks to the account's file.
    expect(await graph.resolveProfileKey(asDeviceId('dev-bbbbbbbb'))).toBe('dev-aaaaaaaa');
    // And the budget counted a NON-TRIVIAL absorb.
    expect((await graph.get(accountId))?.mergesLifetime).toBe(1);

    // The archive holds B as it was, for the §3.6 undo.
    const merged = readFileSync(join(root, 'merged', `dev-bbbbbbbb-${(result as { eventId: string }).eventId}.json`), 'utf8');
    expect((JSON.parse(merged) as StoredProfile).economy.scrap).toBe(40);
  });

  it('a second merge of the SAME device is refused — it is claimed now, and rows 6/9 own that case', async () => {
    const { root, graph, store, journal, accountId } = await rig();
    const first = await mergeDeviceIntoAccount({ graph, store, journal, dataRoot: root, clock: () => NOW }, accountId, asDeviceId('dev-bbbbbbbb'), 'player', 'test');
    expect(first.ok).toBe(true);
    const second = await mergeDeviceIntoAccount({ graph, store, journal, dataRoot: root, clock: () => NOW }, accountId, asDeviceId('dev-bbbbbbbb'), 'player', 'test');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe(409);
    // The balance moved exactly once.
    expect((await store.load('dev-aaaaaaaa'))?.economy.scrap).toBe(420);
  });

  it('the budget refuses the third countable absorb in a window, and the log says so', async () => {
    const { root, graph, store, journal, accountId } = await rig();
    for (const dev of ['dev-bbbbbbbb', 'dev-cccccccc', 'dev-dddddddd']) {
      await store.update(dev, (p) => { Object.assign(p, { ...profileB(), deviceId: dev }); });
    }
    const one = await mergeDeviceIntoAccount({ graph, store, journal, dataRoot: root, clock: () => NOW }, accountId, asDeviceId('dev-bbbbbbbb'), 'player', 'test');
    const two = await mergeDeviceIntoAccount({ graph, store, journal, dataRoot: root, clock: () => NOW }, accountId, asDeviceId('dev-cccccccc'), 'player', 'test');
    const three = await mergeDeviceIntoAccount({ graph, store, journal, dataRoot: root, clock: () => NOW }, accountId, asDeviceId('dev-dddddddd'), 'player', 'test');
    expect(one.ok && two.ok).toBe(true);
    expect(three.ok).toBe(false);
    if (!three.ok) expect(three.status).toBe(429);
    expect(readFileSync(join(root, 'merge.jsonl'), 'utf8')).toContain('"refused"');
  });

  it('planMerge names the numbers the confirm dialog shows', () => {
    const plan = planMerge(profileA(), profileB());
    expect(plan.scrapMoved).toBe(40);
    expect(plan.xpMoved).toBe(900);
    expect(plan.summary.some((s) => s.includes('journal entry'))).toBe(true);
    expect(plan.notMerged[0]).toContain('stay on the device');
  });
});

/* ------------------------------------------------------------------------ *
 * The §3.6 undo — C6.1
 * ------------------------------------------------------------------------ */

describe('undoMerge', () => {
  async function mergedRig(): Promise<{
    root: string; graph: AccountGraph; store: MemoryStore; journal: JsonJournal;
    accountId: ReturnType<typeof asAccountId>; eventId: string;
    deps: { graph: AccountGraph; store: MemoryStore; journal: JsonJournal; dataRoot: string; clock: () => number };
  }> {
    const root = tempDir();
    const graph = new AccountGraph(new MemoryGraphBackend(), { clock: () => NOW });
    const store = new MemoryStore();
    const journal = new JsonJournal(root, { clock: () => NOW });
    const made = await graph.signIn({
      provider: 'pass', secretHash: null, credentialAccount: null,
      mintAccountId: asAccountId('pass:acct-a'),
      deviceId: asDeviceId('dev-aaaaaaaa'), deviceHasProfile: true, deviceCountable: true,
      answer: 'keep',
    });
    if (made.kind !== 'account') throw new Error(made.kind);
    await store.update('dev-aaaaaaaa', (p) => { Object.assign(p, profileA()); });
    await store.update('dev-bbbbbbbb', (p) => { Object.assign(p, profileB()); });
    const deps = { graph, store, journal, dataRoot: root, clock: () => NOW };
    const merged = await mergeDeviceIntoAccount(deps, asAccountId('pass:acct-a'), asDeviceId('dev-bbbbbbbb'), 'player', 'test');
    if (!merged.ok) throw new Error(merged.error);
    return { root, graph, store, journal, accountId: asAccountId('pass:acct-a'), eventId: merged.eventId, deps };
  }

  it('restores B from the archive, claws the money back through the journal, detaches the device', async () => {
    const { graph, store, eventId, deps } = await mergedRig();
    const out = await undoMerge(deps, eventId, 'admin:test', 'wrong account');
    expect(out).toMatchObject({ ok: true, restoredScrap: 40, shortfall: 0 });

    const a = await store.load('dev-aaaaaaaa');
    const b = await store.load('dev-bbbbbbbb');
    // A is back to its §3.7 numbers — money, xp, counts, level.
    expect(a?.economy.scrap).toBe(380);
    expect(a?.progress.xp).toBe(4200);
    expect(a?.progress.level).toBe(levelForXp(4200));
    expect(a?.stats.matches).toBe(62);
    // B is whole again, and the tombstone marker is gone.
    expect(b?.economy.scrap).toBe(40);
    expect(b?.progress.xp).toBe(900);
    expect(b?._unknown?.mergedInto).toBeUndefined();
    // The device banks to its own file again.
    expect(await graph.resolveProfileKey(asDeviceId('dev-bbbbbbbb'))).toBe('dev-bbbbbbbb');
    // The log carries the undone row; the double undo is refused.
    const again = await undoMerge(deps, eventId, 'admin:test', 'twice');
    expect(again).toMatchObject({ ok: false, status: 409 });
  });

  it('THE CRASH REPLAY: a re-run undo with the journal already written moves nothing twice', async () => {
    const { root, store, eventId, deps } = await mergedRig();
    const staleLog = readFileSync(join(root, 'merge.jsonl'), 'utf8');
    expect((await undoMerge(deps, eventId, 'admin:test', 'undo')).ok).toBe(true);
    // The crash: the 'undone' row never reached the log, but the journal did.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(root, 'merge.jsonl'), staleLog, 'utf8');
    expect((await undoMerge(deps, eventId, 'admin:test', 'undo replay')).ok).toBe(true);
    expect((await store.load('dev-aaaaaaaa'))?.economy.scrap).toBe(380);   // not 340
    expect((await store.load('dev-bbbbbbbb'))?.economy.scrap).toBe(40);    // not 80
    expect((await store.load('dev-aaaaaaaa'))?.progress.xp).toBe(4200);    // not 3300
  });

  it('a spent balance documents the shortfall and still makes B whole', async () => {
    const { store, eventId, deps } = await mergedRig();
    await store.update('dev-aaaaaaaa', (p) => { p.economy.scrap = 10; });   // A spent it
    const out = await undoMerge(deps, eventId, 'admin:test', 'undo');
    expect(out).toMatchObject({ ok: true, restoredScrap: 40, shortfall: 30 });
    expect((await store.load('dev-aaaaaaaa'))?.economy.scrap).toBe(0);
    expect((await store.load('dev-bbbbbbbb'))?.economy.scrap).toBe(40);
  });

  it('refuses an unknown event id and a gone archive', async () => {
    const { root, eventId, deps } = await mergedRig();
    expect((await undoMerge(deps, 'NOSUCHEVENT', 'admin:test', 'x')).ok).toBe(false);
    rmSync(join(root, 'merged', `dev-bbbbbbbb-${eventId}.json`));
    const gone = await undoMerge(deps, eventId, 'admin:test', 'x');
    expect(gone).toMatchObject({ ok: false, status: 410 });
  });
});
