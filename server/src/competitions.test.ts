/**
 * DOOMCRAFT — competitions: the state-based ladder (points are monotonic-
 * counter deltas, so there is no event to double-count), the merge fence
 * (one sweep admits at most one match's ceiling), auto-rolling seasons,
 * tournament entry rules, and finalisation that pays ONLY through the
 * journal — idempotent per player forever, proven by replay.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { JsonJournal } from './journal.js';
import { MemoryStore } from './persistence.js';
import { MATCH_XP_CAP } from './reward.js';
import {
  COMPETITIONS_FILE, CompetitionService, SEASON_LENGTH_MS, SEASON_SCRAP_BY_RANK, STANDINGS_LIMIT,
} from './competitions.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dc-comp-'));
  tempDirs.push(d);
  return d;
}

const T0 = Date.UTC(2026, 7, 28, 12, 0, 0);

interface Rig {
  root: string;
  svc: CompetitionService;
  store: MemoryStore;
  journal: JsonJournal;
  deps: { store: MemoryStore; journal: JsonJournal };
  setNow: (ms: number) => void;
}

async function rig(): Promise<Rig> {
  const root = tempDir();
  let now = T0;
  const svc = new CompetitionService(root, { clock: () => now });
  const store = new MemoryStore();
  const journal = new JsonJournal(root, { clock: () => now });
  const deps = { store, journal };
  await svc.ensure(deps);
  return { root, svc, store, journal, deps, setNow: (ms) => { now = ms; } };
}

/** Create the profile and take the season's baseline (round zero). */
async function enrol(r: Rig, key: string): Promise<void> {
  await r.store.update(key, () => { /* ensure exists */ });
  await r.svc.sweep(key, r.deps);
}

/** Simulate a paying round: bump the monotonic counters, then sweep. */
async function playRound(r: Rig, key: string, xp: number, won = false): Promise<void> {
  await r.store.update(key, (p) => {
    p.progress.xp += xp;
    p.stats.matches += 1;
    if (won) { p.stats.wins += 1; p.progress.name = p.progress.name || key.slice(0, 6); }
  });
  await r.svc.sweep(key, r.deps);
}

describe('the season machine', () => {
  it('a season exists at boot, players auto-enrol on their first paying round, points are deltas', async () => {
    const r = await rig();
    const view0 = await r.svc.overview('marine-aaaa-0001', r.deps);
    expect(view0.length).toBe(1);
    expect(view0[0].kind).toBe('season');
    expect(view0[0].entered).toBe(false);

    // A veteran with 4200 lifetime XP enrols: the ladder starts at ZERO,
    // not at their career total.
    await r.store.update('marine-aaaa-0001', (p) => { p.progress.xp = 4200; });
    await r.svc.sweep('marine-aaaa-0001', r.deps);
    let view = await r.svc.overview('marine-aaaa-0001', r.deps);
    expect(view[0].entered).toBe(true);
    expect(view[0].yourPoints).toBe(0);

    await playRound(r, 'marine-aaaa-0001', 300, true);
    view = await r.svc.overview('marine-aaaa-0001', r.deps);
    expect(view[0].yourPoints).toBe(300);
    expect(view[0].yourRank).toBe(1);
  });

  it('THE MERGE FENCE: a counter jump admits at most one match ceiling per sweep', async () => {
    const r = await rig();
    await enrol(r, 'marine-aaaa-0001');
    // An account merge lands 50k pre-season XP on the profile mid-season.
    await playRound(r, 'marine-aaaa-0001', 50_000);
    const view = await r.svc.overview('marine-aaaa-0001', r.deps);
    expect(view[0].yourPoints).toBe(MATCH_XP_CAP);
    // Honest rounds afterwards still accrue normally.
    await playRound(r, 'marine-aaaa-0001', 200);
    expect((await r.svc.overview('marine-aaaa-0001', r.deps))[0].yourPoints).toBe(MATCH_XP_CAP + 200);
  });

  it('a finished season pays the prize table through the journal and mints the next season', async () => {
    const r = await rig();
    for (const k of ['marine-aaaa-0001', 'marine-bbbb-0001', 'marine-cccc-0001']) await enrol(r, k);
    await playRound(r, 'marine-aaaa-0001', 500, true);
    await playRound(r, 'marine-bbbb-0001', 300);
    await playRound(r, 'marine-cccc-0001', 100);
    const before = (await r.store.load('marine-aaaa-0001'))!.economy.scrap;

    r.setNow(T0 + SEASON_LENGTH_MS + 1);
    const view = await r.svc.overview('marine-aaaa-0001', r.deps);   // upkeep finalises + mints
    const season2 = view.find((v) => v.state === 'running');
    const season1 = view.find((v) => v.state === 'finalised');
    expect(season2?.name).toBe('Season 2');
    expect(season1).toBeDefined();

    expect((await r.store.load('marine-aaaa-0001'))!.economy.scrap - before).toBe(SEASON_SCRAP_BY_RANK[0]);
    expect((await r.store.load('marine-bbbb-0001'))!.economy.scrap).toBe(SEASON_SCRAP_BY_RANK[1]);
    expect((await r.store.load('marine-cccc-0001'))!.economy.scrap).toBe(SEASON_SCRAP_BY_RANK[2]);
    expect(await r.journal.has('prize', 'prize:season-1', 'marine-aaaa-0001')).toBe(true);

    // Frozen standings survive finalisation, ranks intact.
    const table = await r.svc.standings('season-1', 'marine-bbbb-0001', r.deps);
    expect(table?.[0].rank).toBe(1);
    expect(table?.[1].you).toBe(true);
  });

  it('THE REPLAY: a crash between the journal append and the doc persist pays nobody twice', async () => {
    const r = await rig();
    await enrol(r, 'marine-aaaa-0001');
    await playRound(r, 'marine-aaaa-0001', 500, true);
    // Snapshot the doc as the crash leaves it: season 1 still RUNNING with
    // its entries, while the journal below will already hold the rows.
    const stale = readFileSync(join(r.root, COMPETITIONS_FILE), 'utf8');
    r.setNow(T0 + SEASON_LENGTH_MS + 1);
    await r.svc.ensure(r.deps);                              // finalises season 1, pays
    const paidOnce = (await r.store.load('marine-aaaa-0001'))!.economy.scrap;
    expect(paidOnce).toBeGreaterThan(0);

    // The process restarts on the stale doc and finalises season 1 AGAIN,
    // with the same entries — the journal is the only thing refusing it.
    writeFileSync(join(r.root, COMPETITIONS_FILE), stale, 'utf8');
    const replayed = new CompetitionService(r.root, { clock: () => T0 + SEASON_LENGTH_MS + 1 });
    await replayed.ensure(r.deps);
    expect((await r.store.load('marine-aaaa-0001'))!.economy.scrap).toBe(paidOnce);
  });
});

describe('tournaments', () => {
  it('need an explicit enter, check the entry rule at the door, and pay their own table', async () => {
    const r = await rig();
    const made = r.svc.createTournament({
      name: 'Friday Gib Fest', startMs: T0, endMs: T0 + 3600_000,
      minLevel: 5, scrapByRank: [100, 50], winnerItems: [], actor: 'admin:test',
    });
    if (!made.ok) throw new Error(made.error);

    // Playing does NOT auto-enrol a tournament.
    await playRound(r, 'marine-aaaa-0001', 200);
    let table = await r.svc.standings(made.id, 'marine-aaaa-0001', r.deps);
    expect(table).toEqual([]);

    // The door: level 1 is refused, level 5 admitted.
    const refused = await r.svc.enter('marine-aaaa-0001', made.id, r.deps);
    expect(refused).toMatchObject({ ok: false, status: 403 });
    await r.store.update('marine-aaaa-0001', (p) => { p.progress.level = 5; });
    expect((await r.svc.enter('marine-aaaa-0001', made.id, r.deps)).ok).toBe(true);

    await playRound(r, 'marine-aaaa-0001', 250, true);
    r.setNow(T0 + 3600_001);
    await r.svc.ensure(r.deps);
    expect((await r.store.load('marine-aaaa-0001'))!.economy.scrap).toBe(100);
    table = await r.svc.standings(made.id, 'marine-aaaa-0001', r.deps);
    expect(table?.[0]).toMatchObject({ rank: 1, points: 250, you: true });
    // The redacted handle never leaks the device id.
    expect(table?.[0].who).not.toContain('marine-aaaa-0001');
  });

  it('a cancelled tournament pays nobody; the bounds refuse a rigged table', async () => {
    const r = await rig();
    const made = r.svc.createTournament({
      name: 'Doomed Cup', startMs: T0, endMs: T0 + 3600_000,
      minLevel: 1, scrapByRank: [100], winnerItems: [], actor: 'admin:test',
    });
    if (!made.ok) throw new Error(made.error);
    await r.svc.enter('marine-aaaa-0001', made.id, r.deps);
    await playRound(r, 'marine-aaaa-0001', 200);
    expect(r.svc.cancelCompetition(made.id, 'admin:test')).toBe(true);
    r.setNow(T0 + 3600_001);
    await r.svc.ensure(r.deps);
    expect((await r.store.load('marine-aaaa-0001'))!.economy.scrap).toBe(0);

    expect(r.svc.createTournament({
      name: 'x', startMs: T0, endMs: T0 + 3600_000, minLevel: 1,
      scrapByRank: [10_000_000], winnerItems: [], actor: 'admin:test',
    }).ok).toBe(false);
    expect(r.svc.createTournament({
      name: 'x', startMs: T0, endMs: T0 + 5_000, minLevel: 1,
      scrapByRank: [], winnerItems: [], actor: 'admin:test',
    }).ok).toBe(false);
  });
});

describe('standings hygiene', () => {
  it('caps the table, appends the caller\'s own row when off the board, ties break by wins', async () => {
    const r = await rig();
    for (let i = 0; i < STANDINGS_LIMIT + 3; i++) {
      const key = `marine-${String(i).padStart(4, '0')}`;
      await enrol(r, key);
      await playRound(r, key, 100 + (STANDINGS_LIMIT + 3 - i));
    }
    await enrol(r, 'marine-lowly-001');
    await playRound(r, 'marine-lowly-001', 1);
    const table = await r.svc.standings('season-1', 'marine-lowly-001', r.deps);
    expect(table!.length).toBe(STANDINGS_LIMIT + 1);
    expect(table![table!.length - 1].you).toBe(true);
    expect(table![table!.length - 1].rank).toBeGreaterThan(STANDINGS_LIMIT);

    // Tie on points: the win takes the higher rank.
    const r2 = await rig();
    await enrol(r2, 'marine-tie-a-001');
    await enrol(r2, 'marine-tie-b-001');
    await playRound(r2, 'marine-tie-a-001', 200, false);
    await playRound(r2, 'marine-tie-b-001', 200, true);
    const t2 = await r2.svc.standings('season-1', 'marine-tie-b-001', r2.deps);
    expect(t2?.[0]).toMatchObject({ rank: 1, you: true, wins: 1 });
  });
});

describe('V4b: a tournament prize cannot mint a weapon variant', () => {
  /*
   * The FIFTH supply path, and the one the "supply is zero by three
   * mechanisms" argument never counted. `createTournament` validates
   * `winnerItems` with `parseItemRef` ALONE — pure syntax, no kind resolution,
   * no items manifest in scope — and finalisation hands the list to
   * `grantDrops(..., 'prize', ...)`. So the refusal cannot live at creation
   * (nothing there knows what a ref IS); it lives at the chokepoint, and this
   * is the end-to-end proof that it fires on the real path.
   */
  const VARIANT = 'items@1:weapon_variant-shotgun-slug';
  const SKIN = 'items@1:skin-rust-marine';

  it('accepts the ref at creation and grants only the non-variant half at payout', async () => {
    const r = await rig();
    const made = r.svc.createTournament({
      name: 'Slug Cup', startMs: T0, endMs: T0 + 3600_000, minLevel: 1,
      scrapByRank: [100], winnerItems: [SKIN, VARIANT], actor: 'admin:test',
    });
    // Creation says yes: syntax is all it checks, and that is the finding.
    expect(made.ok, 'createTournament rejected it — then this test proves nothing').toBe(true);
    if (!made.ok) throw new Error(made.error);

    await playRound(r, 'marine-aaaa-0001', 200);
    expect((await r.svc.enter('marine-aaaa-0001', made.id, r.deps)).ok).toBe(true);
    await playRound(r, 'marine-aaaa-0001', 250, true);
    r.setNow(T0 + 3600_001);
    await r.svc.ensure(r.deps);

    const winner = (await r.store.load('marine-aaaa-0001'))!;
    const refs = winner.inventory.items.map((i) => i.ref);
    // The rank-1 payout really ran — otherwise the absence below is vacuous.
    expect(winner.economy.scrap).toBe(100);
    expect(refs).toContain(SKIN);
    expect(refs, 'a tournament prize minted a weapon variant').not.toContain(VARIANT);
  });
});
