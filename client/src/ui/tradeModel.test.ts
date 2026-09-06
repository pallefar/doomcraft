/**
 * DOOMCRAFT — the Trade tab's decisions, proven off the DOM.
 *
 * The expensive rules: the picker must never mark offerable what the server
 * would refuse (non-tradable, dormant, revoked, cooldown), the join code
 * exists only on the waiting screen, mode comes from `trade.state` and not
 * from any HTTP status, and no rendered string ever says NaN.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_TRADE_REFS,
  TRADE_ITEM_COOLDOWN_MS,
  buildTradeView,
  renderedTradeStrings,
  type TradeInputs,
  type WireTrade,
} from '@/ui/tradeModel';
import type { WireItemsPack } from '@/ui/loadoutModel';
import { parseItemsManifest } from '@shared/items';

const RUST = 'items@1:skin-rust-marine';
const EMBER = 'items@1:skin-ember-core';
const TITLE = 'items@1:title-hangar-rat';
const GONE = 'items@1:trail-retired';
const HAZARD = 'items@1:skin-void-hazard';

const NOW = 1_756_400_000_000;
const OLD = NOW - TRADE_ITEM_COOLDOWN_MS - 1;

const PACK: WireItemsPack = {
  version: 1,
  items: parseItemsManifest(JSON.stringify({
    items: [
      { id: 'skin-rust-marine', kind: 'skin', name: 'Rust Marine', rarity: 'common', tradable: true },
      { id: 'skin-ember-core', kind: 'skin', name: 'Ember Core', rarity: 'rare', tradable: true },
      { id: 'skin-void-hazard', kind: 'skin', name: 'Void Hazard', rarity: 'uncommon', tradable: true },
      { id: 'title-hangar-rat', kind: 'title', name: 'Hangar Rat', rarity: 'common', text: 'HANGAR RAT' },
    ],
  })).manifest!.items,
};

function tradeOf(patch: Partial<WireTrade> = {}): WireTrade {
  return {
    id: 'tr1', code: '', state: 'active', note: '', updatedMs: NOW, expiresMs: NOW + 600_000,
    you: { offer: [], confirmed: false },
    them: { offer: [], confirmed: false, present: true },
    ...patch,
  };
}

function inputsOf(patch: Partial<TradeInputs> = {}): TradeInputs {
  return {
    phase: 'ready',
    trade: tradeOf(),
    mine: [],
    inventory: {
      items: [
        { ref: RUST, ms: OLD, source: 'drop' },
        { ref: RUST, ms: NOW - 1000, source: 'drop' },
        { ref: EMBER, ms: NOW - 1000, source: 'drop' },
        { ref: TITLE, ms: OLD, source: 'prize' },
        { ref: GONE, ms: OLD, source: 'drop' },
        { ref: HAZARD, ms: OLD, source: 'drop' },
      ],
      equippedSkin: '', title: '', variants: {},
    },
    revoked: [HAZARD],
    pack: PACK,
    selected: [],
    busy: false,
    error: '',
    nowMs: NOW,
    ...patch,
  };
}

function pickerRow(inputs: TradeInputs, ref: string) {
  return buildTradeView(inputs).picker.find((p) => p.ref === ref) ?? null;
}

describe('the picker never composes a refusable offer', () => {
  it('marks tradable, active, off-cooldown items offerable', () => {
    const rust = pickerRow(inputsOf(), RUST);
    // The OLDEST copy sets the cooldown clock — one old copy suffices.
    expect(rust?.offerable).toBe(true);
    expect(rust?.copies).toBe(2);
  });

  it('blocks titles as earned, dormant as gone, revoked as revoked, fresh as cooldown', () => {
    expect(pickerRow(inputsOf(), TITLE)?.blocked).toBe('earned, not tradable');
    expect(pickerRow(inputsOf(), GONE)?.blocked).toBe('not in the live pack');
    expect(pickerRow(inputsOf(), HAZARD)?.blocked).toBe('revoked');
    const fresh = pickerRow(inputsOf(), EMBER);
    expect(fresh?.offerable).toBe(false);
    expect(fresh?.blocked).toMatch(/on cooldown — \d+h left/);
    for (const p of buildTradeView(inputsOf()).picker) {
      expect(p.offerable).toBe(p.blocked === '');
    }
  });

  it('selection is the caller\'s whole set — an offered ref can be UNTICKED', () => {
    const ticked = inputsOf({ selected: [RUST] });
    expect(pickerRow(ticked, RUST)?.selected).toBe(true);
    // In your offer but not in the selection: rendered unticked, so the next
    // Offer (which REPLACES the array) can drop it. The DOM half seeds the
    // selection from you.offer when the trade loads.
    const offered = inputsOf({ trade: tradeOf({ you: { offer: [RUST], confirmed: false } }), selected: [] });
    expect(pickerRow(offered, RUST)?.selected).toBe(false);
    // And an offered ref is never blocked by its own cooldown clock.
    const freshOffered = inputsOf({ trade: tradeOf({ you: { offer: [EMBER], confirmed: false } }) });
    expect(pickerRow(freshOffered, EMBER)?.offerable).toBe(true);
  });
});

describe('modes come from trade.state, never from a status code', () => {
  it('maps every state', () => {
    expect(buildTradeView(inputsOf({ trade: null })).mode).toBe('idle');
    expect(buildTradeView(inputsOf({ trade: tradeOf({ state: 'open', code: 'tr3fk9qz' }) })).mode).toBe('waiting');
    expect(buildTradeView(inputsOf()).mode).toBe('active');
    for (const state of ['settled', 'settling', 'cancelled'] as const) {
      expect(buildTradeView(inputsOf({ trade: tradeOf({ state }) })).mode).toBe('done');
    }
    expect(buildTradeView(inputsOf({ phase: 'loading' })).mode).toBe('loading');
    expect(buildTradeView(inputsOf({ phase: 'offline' })).mode).toBe('offline');
  });

  it('shows the join code UPPERCASE on the waiting screen and nowhere else', () => {
    const waiting = buildTradeView(inputsOf({ trade: tradeOf({ state: 'open', code: 'tr3fk9qz', expiresMs: NOW + 9 * 60_000 }) }));
    expect(waiting.code).toBe('TR3FK9QZ');
    expect(waiting.expiresInMin).toBe(9);
    expect(buildTradeView(inputsOf()).code).toBe('');
    expect(buildTradeView(inputsOf({ trade: tradeOf({ state: 'settled' }) })).code).toBe('');
  });

  it('renders the server note verbatim in every terminal state', () => {
    const note = 'your partner revoked an item mid-trade; nothing moved';
    const v = buildTradeView(inputsOf({ trade: tradeOf({ state: 'cancelled', note }) }));
    expect(v.note).toBe(note);
  });
});

describe('what the buttons may do', () => {
  it('confirm needs a present partner and an unconfirmed you; busy freezes everything', () => {
    expect(buildTradeView(inputsOf()).can.confirm).toBe(true);
    const confirmed = inputsOf({ trade: tradeOf({ you: { offer: [], confirmed: true } }) });
    expect(buildTradeView(confirmed).can.confirm).toBe(false);
    const absent = inputsOf({ trade: tradeOf({ them: { offer: [], confirmed: false, present: false } }) });
    expect(buildTradeView(absent).can.confirm).toBe(false);
    const busy = inputsOf({ busy: true });
    const v = buildTradeView(busy);
    expect(v.can.confirm).toBe(false);
    expect(v.can.offer).toBe(false);
    expect(v.can.cancel).toBe(false);
  });

  it('refuses to offer past the engine cap', () => {
    const over = inputsOf({ selected: Array.from({ length: MAX_TRADE_REFS + 1 }, (_, i) => `items@1:skin-x${i}`) });
    expect(buildTradeView(over).can.offer).toBe(false);
  });

  it('the idle screen can open and join, and lists at most five recent trades', () => {
    const mine = Array.from({ length: 8 }, (_, i) => tradeOf({ id: `t${i}`, state: 'settled' }));
    const v = buildTradeView(inputsOf({ trade: null, mine }));
    expect(v.can.open).toBe(true);
    expect(v.can.join).toBe(true);
    expect(v.recent).toHaveLength(5);
  });
});

describe('laundering', () => {
  it('no rendered string ever says NaN, Infinity or undefined', () => {
    const hostile = inputsOf({
      trade: tradeOf({ state: 'open', code: 'trx', expiresMs: Number.NaN }),
      inventory: { items: [{ ref: RUST, ms: Number.NaN, source: 'drop' }], equippedSkin: '', title: '', variants: {} },
    });
    for (const v of [buildTradeView(hostile), buildTradeView(inputsOf()), buildTradeView(inputsOf({ trade: null }))]) {
      for (const s of renderedTradeStrings(v)) expect(s).not.toMatch(/NaN|Infinity|undefined/);
    }
  });
});
