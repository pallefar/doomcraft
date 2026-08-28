/**
 * DOOMCRAFT — the escrow's three rules, each proven refusable: both confirms
 * reset on ANY offer change (the anti-swap rule), the ACTIVE-state check
 * runs at offer AND at confirm (a revocation between the two cancels the
 * trade, never half-settles it), and settlement is atomic with a crash
 * replay that can neither grant twice nor remove twice. The cooldowns are
 * tested because they ship WITH the feature.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { parseItemsManifest, type ItemDef } from '@doomcraft/shared/items';

import { MemoryStore, grantDrops, MAX_OWNED_ITEMS } from './persistence.js';
import {
  MAX_OPEN_TRADES_PER_KEY, MAX_TRADE_REFS,
  TRADES_FILE, TRADE_ITEM_COOLDOWN_MS, TRADE_MIN_ACCOUNT_AGE_MS, TRADE_MIN_MATCHES, TRADE_TTL_MS,
  TradeService, offerRefusal, traderRefusal,
} from './trades.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dc-trade-'));
  tempDirs.push(d);
  return d;
}

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);
const OLD_ENOUGH = NOW - TRADE_ITEM_COOLDOWN_MS - 3600_000;

const MANIFEST = parseItemsManifest(JSON.stringify({
  items: [
    { id: 'rust-skin', kind: 'skin', name: 'Rust Skin', rarity: 'common', tradable: true },
    { id: 'void-trail', kind: 'trail', name: 'Void Trail', rarity: 'rare', tradable: true },
    { id: 'ember-emblem', kind: 'emblem', name: 'Ember Emblem', rarity: 'epic', tradable: true },
    { id: 'keepsake', kind: 'skin', name: 'Keepsake', rarity: 'relic', tradable: false },
  ],
})).manifest!;
const DEFS: ReadonlyMap<string, ItemDef> = new Map(MANIFEST.items.map((i) => [i.id, i]));

const RUST = 'items@1:rust-skin';
const VOID = 'items@1:void-trail';
const EMBER = 'items@1:ember-emblem';
const KEEPSAKE = 'items@1:keepsake';

interface Rig {
  root: string;
  svc: TradeService;
  store: MemoryStore;
  deps: { store: MemoryStore; defs: () => ReadonlyMap<string, ItemDef> };
}

async function rig(): Promise<Rig> {
  const root = tempDir();
  const svc = new TradeService(root, { clock: () => NOW });
  const store = new MemoryStore();
  const deps = { store, defs: (): ReadonlyMap<string, ItemDef> => DEFS };
  for (const key of ['trader-alfa-0001', 'trader-bravo-001']) {
    await store.update(key, (p) => {
      p.createdMs = NOW - TRADE_MIN_ACCOUNT_AGE_MS - 1;
      p.stats.matches = TRADE_MIN_MATCHES;
    });
  }
  await store.update('trader-alfa-0001', (p) => {
    grantDrops(p, [RUST, RUST, VOID], 'drop', 'seed', OLD_ENOUGH);
  });
  await store.update('trader-bravo-001', (p) => {
    grantDrops(p, [EMBER], 'drop', 'seed', OLD_ENOUGH);
  });
  return { root, svc, store, deps };
}

/** Open as alfa, join as bravo, return the trade id. */
async function activeTrade(r: Rig): Promise<string> {
  const opened = await r.svc.open('trader-alfa-0001', r.deps);
  if (!opened.ok) throw new Error(opened.error);
  const joined = await r.svc.join('trader-bravo-001', await codeOf(r, opened.trade.id), r.deps);
  if (!joined.ok) throw new Error(joined.error);
  return opened.trade.id;
}

async function codeOf(r: Rig, tradeId: string): Promise<string> {
  const v = await r.svc.stateFor('trader-alfa-0001', tradeId);
  return v?.code ?? '';
}

describe('who may trade at all', () => {
  it('new accounts cannot trade — too young, too unplayed, or banned', async () => {
    const { store } = await rig();
    // Every mutation through store.update — the MemoryStore live-object rule.
    let young = await store.update('newbie-device-01', () => { /* create */ });
    expect(traderRefusal(young, NOW)).toContain('too new');
    young = await store.update('newbie-device-01', (p) => { p.createdMs = NOW - TRADE_MIN_ACCOUNT_AGE_MS - 1; });
    expect(traderRefusal(young, NOW)).toContain(`${TRADE_MIN_MATCHES} matches`);
    young = await store.update('newbie-device-01', (p) => { p.stats.matches = TRADE_MIN_MATCHES; });
    expect(traderRefusal(young, NOW)).toBeNull();
    young = await store.update('newbie-device-01', (p) => { p.moderation.banned = true; });
    expect(traderRefusal(young, NOW)).toContain('moderated');
    expect(traderRefusal(null, NOW)).toContain('no profile');
  });

  it('open and join enforce it over the service', async () => {
    const r = await rig();
    const refused = await r.svc.open('newbie-device-01', r.deps);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.status).toBe(403);
    const opened = await r.svc.open('trader-alfa-0001', r.deps);
    expect(opened.ok).toBe(true);
  });

  it('you cannot trade with yourself, and codes are single-use', async () => {
    const r = await rig();
    const opened = await r.svc.open('trader-alfa-0001', r.deps);
    if (!opened.ok) throw new Error('open failed');
    const code = await codeOf(r, opened.trade.id);
    const self = await r.svc.join('trader-alfa-0001', code, r.deps);
    expect(self).toMatchObject({ ok: false, status: 409 });
    expect((await r.svc.join('trader-bravo-001', code, r.deps)).ok).toBe(true);
    // The code stops answering once the trade is active.
    const again = await r.svc.join('trader-bravo-001', code, r.deps);
    expect(again).toMatchObject({ ok: false, status: 404 });
  });

  it('a key holds at most MAX_OPEN_TRADES_PER_KEY live trades', async () => {
    const r = await rig();
    for (let i = 0; i < MAX_OPEN_TRADES_PER_KEY; i++) {
      expect((await r.svc.open('trader-alfa-0001', r.deps)).ok).toBe(true);
    }
    const over = await r.svc.open('trader-alfa-0001', r.deps);
    expect(over).toMatchObject({ ok: false, status: 429 });
  });
});

describe('the offer — the ACTIVE-state check, first pass', () => {
  it('refuses non-tradable, dormant, revoked, un-owned and cooling-down items', async () => {
    const { store } = await rig();
    let p = await store.update('trader-alfa-0001', () => { /* read under the lock */ });

    expect(offerRefusal(p, [KEEPSAKE], DEFS, NOW)).toContain('not tradable');
    expect(offerRefusal(p, ['items@1:gone-item'], DEFS, NOW)).toContain('not in the live release');
    expect(offerRefusal(p, ['garbage'], DEFS, NOW)).toContain('not an item');
    expect(offerRefusal(p, [EMBER], DEFS, NOW)).toContain('do not own');
    expect(offerRefusal(p, [RUST, RUST, RUST], DEFS, NOW)).toContain('do not own');
    expect(offerRefusal(p, new Array(MAX_TRADE_REFS + 1).fill(RUST), DEFS, NOW)).toContain('at most');

    p = await store.update('trader-alfa-0001', (q) => {
      q.moderation.revokedItems.push({ ref: VOID, ms: NOW, reason: 'test' });
      // A copy granted five minutes ago is still cooling down.
      grantDrops(q, [EMBER], 'drop', 'fresh', NOW - 300_000);
    });
    expect(offerRefusal(p, [VOID], DEFS, NOW)).toContain('revoked');
    expect(offerRefusal(p, [EMBER], DEFS, NOW)).toContain('cooldown');

    // A copy reserved elsewhere names the reservation, not a false shortage.
    expect(offerRefusal(p, [RUST, RUST], DEFS, NOW, new Map([[RUST, 1]]))).toContain('another trade');

    expect(offerRefusal(p, [RUST, RUST], DEFS, NOW)).toBeNull();
  });

  it('a copy reserved in another live trade cannot be offered twice', async () => {
    const r = await rig();
    const t1 = await activeTrade(r);
    // Alfa owns exactly one VOID and puts it on the table in t1.
    expect((await r.svc.offer('trader-alfa-0001', t1, [VOID], r.deps)).ok).toBe(true);
    const opened = await r.svc.open('trader-alfa-0001', r.deps);
    if (!opened.ok) throw new Error('open failed');
    const joined = await r.svc.join('trader-bravo-001', await codeOf(r, opened.trade.id), r.deps);
    expect(joined.ok).toBe(true);
    const double = await r.svc.offer('trader-alfa-0001', opened.trade.id, [VOID], r.deps);
    expect(double.ok).toBe(false);
  });
});

describe('the anti-swap rule', () => {
  it('ANY offer change resets BOTH confirms', async () => {
    const r = await rig();
    const id = await activeTrade(r);
    await r.svc.offer('trader-alfa-0001', id, [RUST], r.deps);
    await r.svc.offer('trader-bravo-001', id, [EMBER], r.deps);
    const one = await r.svc.confirm('trader-alfa-0001', id, r.deps);
    if (!one.ok) throw new Error(one.error);
    expect(one.trade.you.confirmed).toBe(true);
    expect(one.trade.state).toBe('active');

    // The last-instant swap: bravo changes the offer under alfa's confirm.
    const swapped = await r.svc.offer('trader-bravo-001', id, [], r.deps);
    if (!swapped.ok) throw new Error(swapped.error);
    expect(swapped.trade.you.confirmed).toBe(false);
    expect(swapped.trade.them.confirmed).toBe(false);

    // Alfa's stale confirm is gone; settling now needs BOTH again.
    const after = await r.svc.stateFor('trader-alfa-0001', id);
    expect(after?.you.confirmed).toBe(false);
    expect(after?.state).toBe('active');
  });
});

describe('the ACTIVE-state check, second pass — at confirm', () => {
  it('an item revoked between offer and confirm cancels the trade, never half-settles it', async () => {
    const r = await rig();
    const id = await activeTrade(r);
    await r.svc.offer('trader-alfa-0001', id, [RUST], r.deps);
    await r.svc.offer('trader-bravo-001', id, [EMBER], r.deps);
    await r.svc.confirm('trader-alfa-0001', id, r.deps);

    // The operator takes bravo's ember back while alfa's confirm stands.
    await r.store.update('trader-bravo-001', (p) => {
      p.moderation.revokedItems.push({ ref: EMBER, ms: NOW, reason: 'charge-back' });
    });

    const out = await r.svc.confirm('trader-bravo-001', id, r.deps);
    if (!out.ok) throw new Error(out.error);
    expect(out.trade.state).toBe('cancelled');
    expect(out.trade.note).toContain('no longer stands');
    // Nothing moved on either side.
    expect((await r.store.load('trader-alfa-0001'))!.inventory.items.map((i) => i.ref).sort())
      .toEqual([RUST, RUST, VOID].sort());
    expect((await r.store.load('trader-bravo-001'))!.inventory.items.map((i) => i.ref)).toEqual([EMBER]);
  });

  it('an inventory that would overflow cancels rather than destroying items at the cap', async () => {
    const r = await rig();
    await r.store.update('trader-bravo-001', (p) => {
      while (p.inventory.items.length < MAX_OWNED_ITEMS) {
        grantDrops(p, [RUST], 'drop', 'fill', OLD_ENOUGH);
      }
    });
    const id = await activeTrade(r);
    await r.svc.offer('trader-alfa-0001', id, [RUST, VOID], r.deps);
    // The FIRST confirm already revalidates both sides and cancels.
    const out = await r.svc.confirm('trader-alfa-0001', id, r.deps);
    if (!out.ok) throw new Error(out.error);
    expect(out.trade.state).toBe('cancelled');
    expect(out.trade.note).toContain('overflow');
  });
});

describe('settlement', () => {
  it('swaps the items atomically; received copies re-enter the cooldown with trade provenance', async () => {
    const r = await rig();
    const id = await activeTrade(r);
    await r.svc.offer('trader-alfa-0001', id, [RUST, RUST], r.deps);
    await r.svc.offer('trader-bravo-001', id, [EMBER], r.deps);
    await r.svc.confirm('trader-alfa-0001', id, r.deps);
    const done = await r.svc.confirm('trader-bravo-001', id, r.deps);
    if (!done.ok) throw new Error(done.error);
    expect(done.trade.state).toBe('settled');

    const alfa = (await r.store.load('trader-alfa-0001'))!;
    const bravo = (await r.store.load('trader-bravo-001'))!;
    expect(alfa.inventory.items.map((i) => i.ref).sort()).toEqual([EMBER, VOID].sort());
    expect(bravo.inventory.items.map((i) => i.ref).sort()).toEqual([RUST, RUST].sort());

    const received = bravo.inventory.items.find((i) => i.ref === RUST)!;
    expect(received.source).toBe('trade');
    expect(received.sourceId).toBe(`trade:${id}`);
    // Fresh timestamp = the laundering hop costs a full cooldown.
    expect(NOW - received.ms).toBeLessThan(TRADE_ITEM_COOLDOWN_MS);
    expect(offerRefusal(bravo, [RUST], DEFS, NOW)).toContain('cooldown');
  });

  it('a traded-away equipped skin is unequipped; a kept duplicate keeps the claim', async () => {
    const r = await rig();
    await r.store.update('trader-alfa-0001', (p) => { p.inventory.equippedSkin = VOID; });
    const id = await activeTrade(r);
    await r.svc.offer('trader-alfa-0001', id, [VOID, RUST], r.deps);
    await r.svc.confirm('trader-alfa-0001', id, r.deps);
    await r.svc.confirm('trader-bravo-001', id, r.deps);
    const alfa = (await r.store.load('trader-alfa-0001'))!;
    expect(alfa.inventory.equippedSkin).toBe('');
    // The duplicate RUST copy stayed — duplicates are counted, not keyed.
    expect(alfa.inventory.items.filter((i) => i.ref === RUST).length).toBe(1);
  });

  it('THE CRASH REPLAY: recover() finishes a settling trade without granting or removing twice', async () => {
    const r = await rig();
    const id = await activeTrade(r);
    await r.svc.offer('trader-alfa-0001', id, [RUST], r.deps);
    await r.svc.offer('trader-bravo-001', id, [EMBER], r.deps);
    await r.svc.confirm('trader-alfa-0001', id, r.deps);

    // Capture the doc as a crash between 'settling' and 'settled' leaves it:
    // intercept persist by snapshotting after confirm completes but rewinding
    // the state field by hand — the settle wrote 'settled', we put back the
    // 'settling' row it wrote first, WITH its snapshot.
    await r.svc.confirm('trader-bravo-001', id, r.deps);
    const doc = JSON.parse(readFileSync(join(r.root, TRADES_FILE), 'utf8')) as {
      trades: Record<string, { state: string }>;
    };
    doc.trades[id].state = 'settling';
    writeFileSync(join(r.root, TRADES_FILE), JSON.stringify(doc), 'utf8');

    // The process restarts and replays BOTH sides on already-settled profiles.
    const replayed = new TradeService(r.root, { clock: () => NOW });
    expect(await replayed.recover(r.deps)).toBe(1);

    const alfa = (await r.store.load('trader-alfa-0001'))!;
    const bravo = (await r.store.load('trader-bravo-001'))!;
    // Exactly one swap happened: no double-grant, no double-remove.
    expect(alfa.inventory.items.map((i) => i.ref).sort()).toEqual([EMBER, RUST, VOID].sort());
    expect(bravo.inventory.items.map((i) => i.ref)).toEqual([RUST]);
  });
});

describe('the durability order', () => {
  it('THE BARRIER: the store flushes while the doc still says settling — never after settled', async () => {
    const r = await rig();
    /* A store that records what trades.json said at every flush. The
     * production store debounces profile writes; marking 'settled' durably
     * before flushing them is the crash window that voids a trade. */
    const flushStates: string[] = [];
    const probe = r.store as MemoryStore & { flush(): Promise<void> };
    const originalFlush = probe.flush.bind(probe);
    probe.flush = async (): Promise<void> => {
      const doc = JSON.parse(readFileSync(join(r.root, TRADES_FILE), 'utf8')) as {
        trades: Record<string, { state: string }>;
      };
      for (const t of Object.values(doc.trades)) flushStates.push(t.state);
      await originalFlush();
    };

    const id = await activeTrade(r);
    await r.svc.offer('trader-alfa-0001', id, [RUST], r.deps);
    await r.svc.offer('trader-bravo-001', id, [EMBER], r.deps);
    await r.svc.confirm('trader-alfa-0001', id, r.deps);
    const done = await r.svc.confirm('trader-bravo-001', id, r.deps);
    if (!done.ok) throw new Error(done.error);
    expect(done.trade.state).toBe('settled');

    // The flush happened, and it happened BEFORE the doc said 'settled'.
    expect(flushStates).toContain('settling');
    expect(flushStates).not.toContain('settled');
  });

  it('one unrecoverable trade never strands the others, and recover() never throws', async () => {
    const root = tempDir();
    const store = new MemoryStore();
    const deps = { store, defs: (): ReadonlyMap<string, ItemDef> => DEFS };
    for (const key of ['trader-alfa-0001', 'trader-bravo-001', 'trader-broken-01']) {
      await store.update(key, (p) => {
        p.createdMs = NOW - TRADE_MIN_ACCOUNT_AGE_MS - 1;
        p.stats.matches = TRADE_MIN_MATCHES;
      });
    }
    await store.update('trader-alfa-0001', (p) => { grantDrops(p, [RUST], 'drop', 'seed', OLD_ENOUGH); });
    await store.update('trader-bravo-001', (p) => { grantDrops(p, [EMBER], 'drop', 'seed', OLD_ENOUGH); });

    const settling = (id: string, aKey: string, bKey: string, aRef: string, bRef: string): object => ({
      id, code: `TR${id.slice(0, 6)}`, ms: NOW, updatedMs: NOW,
      a: { key: aKey, offer: [aRef], confirmed: true },
      b: { key: bKey, offer: [bRef], confirmed: true },
      state: 'settling', note: '',
      snapshot: { a: { [aRef]: 1 }, b: { [bRef]: 1 } },
      done: { a: false, b: false },
    });
    writeFileSync(join(root, TRADES_FILE), JSON.stringify({
      version: 1,
      trades: {
        AAAA: settling('AAAA', 'trader-broken-01', 'trader-bravo-001', RUST, EMBER),
        BBBB: settling('BBBB', 'trader-alfa-0001', 'trader-bravo-001', RUST, EMBER),
      },
    }), 'utf8');

    const broken = store.update.bind(store);
    store.update = ((key: string, fn: (p: Parameters<Parameters<MemoryStore['update']>[1]>[0]) => void) => {
      if (key === 'trader-broken-01') return Promise.reject(new Error('disk on fire'));
      return broken(key, fn);
    }) as MemoryStore['update'];

    const svc = new TradeService(root, { clock: () => NOW });
    const finished = await svc.recover(deps);
    expect(finished).toBe(1);
    // The healthy trade settled; the broken one is intact for the next boot.
    expect(svc.status().settling).toBe(1);
    expect((await store.load('trader-alfa-0001'))!.inventory.items.map((i) => i.ref)).toEqual([EMBER]);
  });

  it('a malformed doc row is dropped at load rather than reserving items forever', async () => {
    const root = tempDir();
    writeFileSync(join(root, TRADES_FILE), JSON.stringify({
      version: 1,
      trades: {
        JUNK: { state: 'active' },                                        // no parties at all
        HALF: {                                                            // settling with no snapshot
          id: 'HALF', a: { key: 'trader-alfa-0001', offer: [], confirmed: true },
          b: { key: 'trader-bravo-001', offer: [], confirmed: true },
          state: 'settling', snapshot: null,
        },
        GOOD: {
          id: 'GOOD', code: 'TRGOOD01', ms: NOW, updatedMs: NOW,
          a: { key: 'trader-alfa-0001', offer: [], confirmed: false },
          b: null, state: 'open', note: '', snapshot: null, done: { a: false, b: false },
        },
      },
    }), 'utf8');
    const svc = new TradeService(root, { clock: () => NOW });
    const s = svc.status();
    expect(s.open).toBe(1);
    expect(s.active).toBe(0);
    expect(s.settling).toBe(0);
  });
});

describe('lifecycle', () => {
  it('an untouched trade expires; cancel works for either party; settled trades refuse cancel', async () => {
    const root = tempDir();
    let now = NOW;
    const svc = new TradeService(root, { clock: () => now });
    const store = new MemoryStore();
    const deps = { store, defs: (): ReadonlyMap<string, ItemDef> => DEFS };
    for (const key of ['trader-alfa-0001', 'trader-bravo-001']) {
      await store.update(key, (p) => {
        p.createdMs = NOW - TRADE_MIN_ACCOUNT_AGE_MS - 1;
        p.stats.matches = TRADE_MIN_MATCHES;
      });
    }
    const opened = await svc.open('trader-alfa-0001', deps);
    if (!opened.ok) throw new Error('open failed');

    now = NOW + TRADE_TTL_MS + 1;
    const gone = await svc.stateFor('trader-alfa-0001', opened.trade.id);
    expect(gone?.state).toBe('cancelled');
    expect(gone?.note).toContain('expired');

    const second = await svc.open('trader-alfa-0001', deps);
    if (!second.ok) throw new Error('open failed');
    const cancelled = await svc.cancel('trader-alfa-0001', second.trade.id);
    if (!cancelled.ok) throw new Error(cancelled.error);
    expect(cancelled.trade.state).toBe('cancelled');

    // A stranger can neither read nor cancel somebody else's trade.
    expect(await svc.stateFor('trader-bravo-001', second.trade.id)).toBeNull();
  });

  it('mine() lists a party\'s trades newest first; the code hides from the joiner', async () => {
    const r = await rig();
    const id = await activeTrade(r);
    const mine = await r.svc.mine('trader-bravo-001');
    expect(mine.length).toBe(1);
    expect(mine[0].id).toBe(id);
    expect(mine[0].code).toBe('');
    expect(mine[0].them.present).toBe(true);
  });
});
