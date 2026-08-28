/**
 * DOOMCRAFT — the Trade tab, decided here. No DOM in this file.
 *
 * Same split as `loadoutModel.ts`. The engine (`server/src/trades.ts`) owns
 * every rule; this model only decides what the panel SAYS about the state the
 * server last answered with. The rules it must never soften:
 *
 * - **HTTP 200 is not success.** A confirm can come back 200 with
 *   `state:'cancelled'` (revalidation failed) or 200 back to `'active'` with
 *   both confirms cleared (settlement persist failed). Everything renders from
 *   `trade.state`, and `trade.note` is shown VERBATIM — the server wrote that
 *   sentence for the player.
 * - **Any offer change clears BOTH confirms.** The panel says so out loud
 *   ("re-confirm") rather than looking like it lost a click.
 * - **The join code exists only in the opener's answers while state is
 *   'open'.** It is captured from the open/state response and never invented.
 * - **The picker offers only what the server could accept**: ACTIVE, tradable
 *   per the LIVE pack, off its 48h cooldown, and not already escrowed in THIS
 *   trade's own offer. The server re-checks everything; the picker exists so
 *   an honest player never composes a refusable offer by accident.
 */

import {
  ItemKind,
  itemStateFor,
  parseItemRef,
  type ItemDef,
} from '@shared/items';

import { fallbackName, type WireInventory, type WireItemsPack } from '@/ui/loadoutModel';

/* ------------------------------------------------------------------------ *
 * Wire shapes — server/src/trades.ts TradeView, restated for the client
 * ------------------------------------------------------------------------ */

export type TradeState = 'open' | 'active' | 'settling' | 'settled' | 'cancelled';

export interface WireTradeSide {
  readonly offer: readonly string[];
  readonly confirmed: boolean;
}

export interface WireTrade {
  readonly id: string;
  readonly code: string;
  readonly state: TradeState;
  readonly note: string;
  readonly updatedMs: number;
  readonly expiresMs: number;
  readonly you: WireTradeSide;
  readonly them: WireTradeSide & { readonly present: boolean };
}

/** 48h, mirrored from server/src/trades.ts TRADE_ITEM_COOLDOWN_MS. */
export const TRADE_ITEM_COOLDOWN_MS = 48 * 3_600_000;
/** Engine cap on refs per side, server/src/trades.ts MAX_TRADE_REFS. */
export const MAX_TRADE_REFS = 6;

/* ------------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------------ */

export interface TradeInputs {
  readonly phase: 'loading' | 'offline' | 'ready';
  /** The trade the panel is inside, or null (the idle screen). */
  readonly trade: WireTrade | null;
  /** `GET /api/trade/mine`, newest first. Only the idle screen lists them. */
  readonly mine: readonly WireTrade[];
  readonly inventory: WireInventory | null;
  /** `moderation.revokedItems[].ref` — a revoked copy is never offerable. */
  readonly revoked: readonly string[];
  readonly pack: WireItemsPack | null;
  /** Refs ticked in the picker but not yet sent. */
  readonly selected: readonly string[];
  readonly busy: boolean;
  /** The server's last refusal sentence, shown verbatim. '' = none. */
  readonly error: string;
  readonly nowMs: number;
}

/* ------------------------------------------------------------------------ *
 * Rendered shapes
 * ------------------------------------------------------------------------ */

export interface TradePickerRow {
  readonly ref: string;
  readonly name: string;
  readonly copies: number;
  readonly selected: boolean;
  /** false + why in `blocked` when the server would refuse this ref. */
  readonly offerable: boolean;
  /** '' | 'on cooldown — Nh left' | 'not tradable' | 'not in the live pack' | 'revoked'. */
  readonly blocked: string;
}

export interface TradeOfferView {
  /** Item names, one per offered copy. */
  readonly lines: readonly string[];
  readonly confirmed: boolean;
}

export interface TradeView2 {
  readonly mode: 'loading' | 'offline' | 'idle' | 'waiting' | 'active' | 'done';
  /** The headline sentence for the current mode. NEVER empty. */
  readonly line: string;
  /** The server's note, verbatim. '' when it has nothing to say. */
  readonly note: string;
  readonly error: string;
  /** The join code to show BIG, '' unless mode is 'waiting'. */
  readonly code: string;
  /** Minutes until the open trade expires, for the waiting screen. */
  readonly expiresInMin: number;
  readonly you: TradeOfferView;
  readonly them: TradeOfferView & { readonly present: boolean };
  /** 'offer changed — confirm again' style notice, or ''. */
  readonly reconfirm: string;
  readonly picker: readonly TradePickerRow[];
  /** How many the picker will send; the Offer button says it. */
  readonly selectedCount: number;
  readonly can: {
    readonly open: boolean;
    readonly join: boolean;
    readonly offer: boolean;
    readonly confirm: boolean;
    readonly cancel: boolean;
  };
  /** The idle screen's recent-trades table: [state, whenText, note]. */
  readonly recent: readonly { readonly id: string; readonly state: TradeState; readonly note: string }[];
}

/* ------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------ */

function safeInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function nameOf(ref: string, defs: ReadonlyMap<string, ItemDef>): string {
  const parsed = parseItemRef(ref);
  if (parsed === null) return ref.slice(0, 24);
  return defs.get(parsed.localId)?.name ?? fallbackName(parsed.localId);
}

function hoursLeftText(ms: number): string {
  const h = Math.max(1, Math.ceil(ms / 3_600_000));
  return `on cooldown — ${h}h left`;
}

/* ------------------------------------------------------------------------ *
 * The view
 * ------------------------------------------------------------------------ */

export function buildTradeView(inputs: TradeInputs): TradeView2 {
  const defs = new Map((inputs.pack?.items ?? []).map((i) => [i.id, i]));
  const empty: TradeOfferView = { lines: [], confirmed: false };
  const base = {
    note: '', error: inputs.error, code: '', expiresInMin: 0,
    you: empty, them: { ...empty, present: false },
    reconfirm: '', picker: [] as TradePickerRow[], selectedCount: 0,
    can: { open: false, join: false, offer: false, confirm: false, cancel: false },
    recent: [] as TradeView2['recent'],
  };

  if (inputs.phase === 'loading') return { ...base, mode: 'loading', line: 'Loading…' };
  if (inputs.phase === 'offline') {
    return { ...base, mode: 'offline', line: 'No server answered. Trading needs the game server.' };
  }

  const t = inputs.trade;
  if (t === null) {
    return {
      ...base,
      mode: 'idle',
      line: 'Trade item for item, two confirms, no take-backs after both sides agree.',
      can: { ...base.can, open: !inputs.busy, join: !inputs.busy },
      recent: inputs.mine.slice(0, 5).map((m) => ({ id: m.id, state: m.state, note: m.note })),
    };
  }

  const you: TradeOfferView = {
    lines: t.you.offer.map((r) => nameOf(r, defs)),
    confirmed: t.you.confirmed,
  };
  const them = {
    lines: t.them.offer.map((r) => nameOf(r, defs)),
    confirmed: t.them.confirmed,
    present: t.them.present,
  };

  if (t.state === 'open') {
    return {
      ...base,
      mode: 'waiting',
      line: 'Share this code. The trade opens when your partner joins.',
      note: t.note,
      code: t.code.toUpperCase(),
      expiresInMin: Math.max(0, Math.ceil((safeInt(t.expiresMs) - inputs.nowMs) / 60_000)),
      you, them,
      can: { ...base.can, cancel: !inputs.busy },
    };
  }

  if (t.state === 'settled' || t.state === 'cancelled' || t.state === 'settling') {
    const line = t.state === 'settled'
      ? 'Settled. The items moved — check your Loadout.'
      : t.state === 'settling'
        ? 'Settling…'
        : 'This trade was cancelled.';
    return { ...base, mode: 'done', line, note: t.note, you, them };
  }

  /* ---- active ---- */
  const liveIds = new Set((inputs.pack?.items ?? []).map((i) => i.id));
  const revoked = new Set(inputs.revoked);
  const inOffer = new Set(t.you.offer);
  const counts = new Map<string, { copies: number; oldestMs: number }>();
  for (const owned of inputs.inventory?.items ?? []) {
    if (parseItemRef(owned.ref) === null) continue;
    const row = counts.get(owned.ref);
    if (row === undefined) counts.set(owned.ref, { copies: 1, oldestMs: safeInt(owned.ms) });
    else { row.copies += 1; row.oldestMs = Math.min(row.oldestMs, safeInt(owned.ms)); }
  }
  const picker: TradePickerRow[] = [];
  for (const [ref, { copies, oldestMs }] of counts) {
    const parsed = parseItemRef(ref);
    if (parsed === null) continue;
    const def = defs.get(parsed.localId);
    const state = itemStateFor(ref, liveIds, revoked);
    const cooldownLeft = oldestMs + TRADE_ITEM_COOLDOWN_MS - inputs.nowMs;
    // A ref already in your offer stays pickable-off: `selected` is the DOM
    // half's whole selection (seeded from you.offer when the trade loads),
    // so unticking an offered item is possible and Offer REPLACES the array.
    const blocked = state === 'revoked' ? 'revoked'
      : state !== 'active' ? 'not in the live pack'
      : def === undefined || !def.tradable
        ? (def !== undefined && (def.kind === ItemKind.TITLE || def.kind === ItemKind.TROPHY)
          ? 'earned, not tradable' : 'not tradable')
        : cooldownLeft > 0 && !inOffer.has(ref) ? hoursLeftText(cooldownLeft) : '';
    picker.push({
      ref,
      name: nameOf(ref, defs),
      copies,
      selected: inputs.selected.includes(ref),
      offerable: blocked === '',
      blocked,
    });
  }

  const selectedCount = inputs.selected.length;
  const bothConfirmable = t.them.present && !inputs.busy;
  return {
    ...base,
    mode: 'active',
    line: t.them.present
      ? 'Both sides offer, both confirm. Changing ANY offer resets both confirms.'
      : 'Your partner left. You can cancel.',
    note: t.note,
    you, them,
    reconfirm: !t.you.confirmed && t.note.length === 0 && (t.you.offer.length > 0 || t.them.offer.length > 0)
      ? 'Confirm when the deal on screen is the deal you mean.' : '',
    picker,
    selectedCount,
    can: {
      open: false, join: false,
      offer: bothConfirmable && selectedCount <= MAX_TRADE_REFS,
      confirm: bothConfirmable && !t.you.confirmed,
      cancel: !inputs.busy,
    },
  };
}

/** Every string a TradeView2 renders — the no-NaN test walks this. */
export function renderedTradeStrings(v: TradeView2): string[] {
  const out: string[] = [v.line, v.note, v.error, v.code, String(v.expiresInMin), v.reconfirm, String(v.selectedCount)];
  out.push(...v.you.lines, ...v.them.lines);
  for (const p of v.picker) out.push(p.name, String(p.copies), p.blocked);
  for (const r of v.recent) out.push(r.id, r.state, r.note);
  return out;
}
