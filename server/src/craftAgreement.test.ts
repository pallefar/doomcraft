/**
 * DOOMCRAFT V4e — the craft bench's TWO DOORS must accept the same set.
 *
 * `craftVerdict` (server) decides what a craft may produce; `craftTargetsFor`
 * (client, `loadoutModel.ts`) decides what the Loadout tab OFFERS. They are
 * separate implementations in separate languages of the same rule, and §0 rule
 * 29 is the whole reason this file exists: "each one refuses bad input" is not
 * a proof that they agree.
 *
 * The assertion is SET EQUALITY under matched conditions, never a subset. A
 * subset assertion ("the UI never offers more than the server accepts") is
 * vacuously true when the UI offers NOTHING — which is exactly the V4e failure
 * it would have been written to catch, since before V4e the tab offered no
 * variant target at all.
 *
 * It also carries the live bug V4e fixes: `craftTargetsFor` took the RAW copy
 * count and no Scrap balance, so a copy on a trade table (or a balance one
 * Scrap short) produced an enabled button against a server that answered 400.
 * That half is driven through the REAL `TradeService` escrow rather than a
 * hand-written reservation map, because a reservation that never happened is
 * rule 2 wearing a disguise.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseItemsManifest, type ItemDef } from '@doomcraft/shared/items';

import { craftVerdict } from './craft.js';
import { MemoryStore, createProfile, grantDrops } from './persistence.js';
import {
  TRADE_ITEM_COOLDOWN_MS, TRADE_MIN_ACCOUNT_AGE_MS, TRADE_MIN_MATCHES, TradeService,
} from './trades.js';

/*
 * THE CLIENT MODEL, LOADED AT RUNTIME. `client/` and `server/` are separate
 * composite TS projects with disjoint rootDirs, so a static cross-import fails
 * `tsc -b` by design — and the point of this file is to run BOTH REAL
 * implementations, not a restatement of one of them, so a copy would defeat it
 * entirely. The specifier is a variable, which is what keeps the compiler out
 * of it; vitest's module runner resolves and transforms it exactly as it does
 * for the client's own tests. `it('the client module really loaded')` below is
 * the negative control: a wrong path would otherwise make every equality here
 * pass over two empty sets.
 */
const CLIENT_MODEL = '../../client/src/ui/loadoutModel.ts';

/** The half of `LoadoutInputs` this file builds. Structural, checked at runtime. */
interface ClientInputs {
  phase: 'ready';
  inventory: { items: Array<{ ref: string; ms: number; source: string }>; equippedSkin: string; title: string };
  revoked: string[];
  scrap: number;
  lifetimeScrap: number;
  pack: { version: number; items: readonly ItemDef[] };
  reserved: Record<string, number>;
  scrapVisible: boolean;
  busyRef: string;
}
interface ClientView {
  sections: Array<{ rows: Array<{ ref: string; craftTargets: Array<{ localId: string }> }> }>;
}
type BuildLoadoutView = (inputs: ClientInputs) => ClientView;

let buildLoadoutView: BuildLoadoutView;
beforeAll(async () => {
  const mod = await import(CLIENT_MODEL) as { buildLoadoutView?: unknown };
  if (typeof mod.buildLoadoutView !== 'function') {
    throw new Error(`${CLIENT_MODEL} exported no buildLoadoutView — the agreement test would prove nothing`);
  }
  buildLoadoutView = mod.buildLoadoutView as BuildLoadoutView;
});

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

/** THE REAL BUNDLED PACK — not a fixture. The two doors must agree on ships. */
const MANIFEST = parseItemsManifest(readFileSync(join(repoRoot, 'content', 'items.json'), 'utf8')).manifest!;
const DEFS: ReadonlyMap<string, ItemDef> = new Map(MANIFEST.items.map((i) => [i.id, i]));
const PACK = { version: 1, items: MANIFEST.items };
const ALL_IDS = MANIFEST.items.map((i) => i.id);

const RUST = 'items@1:skin-rust-marine';   // COMMON skin, tradable
const IMP = 'items@1:emblem-imp-skull';    // COMMON emblem
const HAZARD = 'items@1:skin-void-hazard'; // UNCOMMON skin
const SLUG_ID = 'weapon_variant-shotgun-slug';
const SWIFT_ID = 'weapon_variant-rocket-swift';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

interface Case {
  readonly ref: string;
  readonly copies: number;
  readonly scrap: number;
  readonly reserved: Readonly<Record<string, number>>;
}

/** Every target the SERVER would accept for this case, sorted. */
function serverAccepts(c: Case): string[] {
  const p = createProfile('device-agreement');
  /*
   * SEEDED THROUGH 'trade', not 'drop'. `grantDrops` refuses to MINT a weapon
   * variant, so seeding the variant-source case with 'drop' would have given
   * the profile ZERO copies and made that test pass on the copy count instead
   * of on the kind rule — a green test for the wrong reason. 'trade' is a
   * transfer and lands every kind.
   */
  for (let i = 0; i < c.copies; i++) grantDrops(p, [c.ref], 'trade', `seed-${i}`, 1_000 + i);
  const held = p.inventory.items.filter((i) => i.ref === c.ref).length;
  if (held !== c.copies) throw new Error(`fixture holds ${held} of ${c.ref}, wanted ${c.copies}`);
  p.economy.scrap = c.scrap;
  const reserved = new Map(Object.entries(c.reserved));
  return ALL_IDS
    .filter((id) => craftVerdict(p, c.ref, id, DEFS, 1, reserved).ok)
    .sort();
}

function inputsFor(c: Case): ClientInputs {
  return {
    phase: 'ready',
    inventory: {
      items: Array.from({ length: c.copies }, (_, i) => ({ ref: c.ref, ms: 1_000 + i, source: 'drop' })),
      equippedSkin: '',
      title: '',
    },
    revoked: [],
    scrap: c.scrap,
    lifetimeScrap: c.scrap,
    pack: PACK,
    reserved: { ...c.reserved },
    scrapVisible: true,
    busyRef: '',
  };
}

/** Every target the CLIENT would OFFER for this case, sorted. */
function uiOffers(c: Case): string[] {
  const rows = buildLoadoutView(inputsFor(c)).sections.flatMap((sec) => sec.rows);
  const row = rows.find((r) => r.ref === c.ref);
  return (row?.craftTargets ?? []).map((t) => t.localId).sort();
}

describe('V4e: the tab offers exactly what the bench accepts', () => {
  it('the client module really loaded — the negative control for every set below', () => {
    expect(typeof buildLoadoutView).toBe('function');
    // And it answers about the real pack: an owned ref must produce a row.
    const rows = buildLoadoutView(inputsFor({ ref: RUST, copies: 3, scrap: 500, reserved: {} }))
      .sections.flatMap((sec) => sec.rows);
    expect(rows.map((r) => r.ref)).toContain(RUST);
  });

  const CASES: ReadonlyArray<readonly [string, Case]> = [
    ['a common skin, three free copies, plenty of Scrap', { ref: RUST, copies: 3, scrap: 500, reserved: {} }],
    ['the same at EXACTLY the fee', { ref: RUST, copies: 3, scrap: 50, reserved: {} }],
    ['one Scrap short of the fee', { ref: RUST, copies: 3, scrap: 49, reserved: {} }],
    ['one copy short', { ref: RUST, copies: 2, scrap: 500, reserved: {} }],
    ['four copies, two reserved', { ref: RUST, copies: 4, scrap: 500, reserved: { [RUST]: 2 } }],
    ['a common emblem', { ref: IMP, copies: 3, scrap: 500, reserved: {} }],
    ['an UNCOMMON skin — no rare variant exists, so skins only', { ref: HAZARD, copies: 3, scrap: 500, reserved: {} }],
  ];

  for (const [label, c] of CASES) {
    it(`agrees: ${label}`, () => {
      expect(uiOffers(c)).toEqual(serverAccepts(c));
    });
  }

  it('and the agreed set actually CONTAINS both variant tokens by name', () => {
    /*
     * The equality above is satisfied by two empty sets, so this is the
     * assertion that the entry recipe is REACHABLE from a real bundled item.
     * Both bundled tokens are uncommon, so a COMMON cosmetic reaches both.
     */
    const c: Case = { ref: RUST, copies: 3, scrap: 500, reserved: {} };
    const accepted = serverAccepts(c);
    expect(accepted).toContain(SLUG_ID);
    expect(accepted).toContain(SWIFT_ID);
    expect(uiOffers(c)).toContain(SLUG_ID);
    expect(uiOffers(c)).toContain(SWIFT_ID);
    // And the cross-kind bend is variant-only: the uncommon emblem is NOT a
    // legal target for a skin, which is what keeps this from being "anything
    // one rarity up".
    expect(accepted).not.toContain('emblem-keycard-blue');
  });

  it('offers NO craft target on a weapon variant, however many are held', () => {
    /*
     * `serverAccepts` throws if the fixture did not get three copies, so this
     * cannot pass because the tokens were never granted. It does NOT, however,
     * discriminate the source-kind rule over the BUNDLED pack: both tokens are
     * uncommon, so the rarity+1 rule refuses a variant trade-up regardless.
     * The input where the two implementations differ needs a RARE variant and
     * lives in `craft.test.ts` (§0 rule 38); this one guards the tab.
     */
    const c: Case = { ref: `items@1:${SLUG_ID}`, copies: 3, scrap: 5_000, reserved: {} };
    expect(serverAccepts(c)).toEqual([]);
    expect(uiOffers(c)).toEqual([]);
  });
});

describe('V4e: a copy on a LIVE trade table is not offered either', () => {
  /*
   * Obligation (e), and the reservation is ESTABLISHED, not asserted: the
   * trade is opened, joined and offered through the real `TradeService`, each
   * step checked, and `reservedRefs` is read back and checked to be exactly 1
   * before anything is concluded. A trade that quietly failed to set up would
   * leave reserved = {} and this test would go green for the wrong reason
   * (§0 rule 22).
   *
   * DISCRIMINATION: the entry recipe stays ENABLED throughout. With the raw
   * copy count, `craftTargetsFor` sees 3 and offers targets; with the free
   * count it sees 2 and offers none. Take the entry recipe away as well and
   * both sides collapse to empty for the wrong reason.
   */
  const ALFA = 'trader-alfa-0001';
  const BRAVO = 'trader-bravo-001';
  const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
  const OLD_ENOUGH = NOW - TRADE_ITEM_COOLDOWN_MS - 3_600_000;

  it('the escrow removes the third copy, and both doors stop offering', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-craft-agree-'));
    tempDirs.push(root);
    const svc = new TradeService(root, { clock: () => NOW });
    const store = new MemoryStore();
    const deps = { store, defs: (): ReadonlyMap<string, ItemDef> => DEFS };
    for (const key of [ALFA, BRAVO]) {
      await store.update(key, (p) => {
        p.createdMs = NOW - TRADE_MIN_ACCOUNT_AGE_MS - 1;
        p.stats.matches = TRADE_MIN_MATCHES;
      });
    }
    await store.update(ALFA, (p) => {
      grantDrops(p, [RUST, RUST, RUST], 'drop', 'seed', OLD_ENOUGH);
      p.economy.scrap = 500;
    });
    await store.update(BRAVO, (p) => { grantDrops(p, [HAZARD], 'drop', 'seed', OLD_ENOUGH); });

    const opened = await svc.open(ALFA, deps);
    expect(opened.ok, opened.ok ? '' : opened.error).toBe(true);
    if (!opened.ok) return;
    const view = await svc.stateFor(ALFA, opened.trade.id);
    const joined = await svc.join(BRAVO, view?.code ?? '', deps);
    expect(joined.ok, joined.ok ? '' : joined.error).toBe(true);
    const offered = await svc.offer(ALFA, opened.trade.id, [RUST], deps);
    expect(offered.ok, offered.ok ? '' : offered.error).toBe(true);

    // The reservation is REAL and is exactly one copy.
    const reservedMap = svc.reservedRefs(ALFA);
    expect(reservedMap.get(RUST), 'the escrow never took the copy').toBe(1);

    const profile = await store.load(ALFA);
    expect(profile).not.toBeNull();
    const owned = profile!.inventory.items.filter((i) => i.ref === RUST).length;
    expect(owned, 'still owns three; the escrow holds, it does not remove').toBe(3);
    expect(owned - (reservedMap.get(RUST) ?? 0)).toBe(2);

    const c: Case = { ref: RUST, copies: 3, scrap: 500, reserved: { [RUST]: 1 } };
    // The server: 3 owned − 1 reserved = 2 free < 3.
    const verdict = craftVerdict(profile!, RUST, SLUG_ID, DEFS, 1, reservedMap);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toContain('trade table');
    expect(serverAccepts(c)).toEqual([]);
    // The tab, which used to offer an enabled button here.
    expect(uiOffers(c)).toEqual([]);

    // Cancel frees it and BOTH doors open again — the same set, not an empty one.
    const cancelled = await svc.cancel(ALFA, opened.trade.id);
    expect(cancelled.ok).toBe(true);
    expect(svc.reservedRefs(ALFA).get(RUST)).toBeUndefined();
    const free: Case = { ref: RUST, copies: 3, scrap: 500, reserved: {} };
    expect(uiOffers(free)).toEqual(serverAccepts(free));
    expect(uiOffers(free)).toContain(SLUG_ID);
  });
});
