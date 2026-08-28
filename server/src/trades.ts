/**
 * DOOMCRAFT — player-to-player trading: the two-sided escrow specified in
 * docs/ECONOMY.md "Trading", built to the three rules that section names:
 *
 *  1. **Two-sided escrow.** Both parties offer, both confirm, and BOTH
 *     confirms reset whenever EITHER side changes its offer — the specific
 *     defence against the swap-at-the-last-instant scam. The reset lives in
 *     `offer()` itself, not in the caller, so no route can forget it.
 *  2. **The ACTIVE-state check runs at offer AND at confirm.** An item can
 *     stop being tradable between the two — a release rollback dormants it,
 *     an operator revokes it, its owner offers the same copy in a second
 *     trade — so `confirm()` revalidates BOTH sides from scratch and a
 *     failure cancels the trade rather than settling half of it.
 *  3. **Atomic settlement with a crash story.** The trade row goes to
 *     'settling' WITH a per-side inventory snapshot before any profile is
 *     touched; each side's transfer is one `store.update` guarded so a
 *     replay after a crash can neither grant twice (the incoming items carry
 *     `sourceId: trade:<id>`, checked first) nor remove twice (the snapshot
 *     says how many copies the giver had, so "already removed" is a count
 *     comparison, not a guess). `recover()` finishes any 'settling' trade
 *     found at boot.
 *
 * Cooldowns ship WITH the feature, not after it goes wrong: a newly
 * acquired item is untradable for `TRADE_ITEM_COOLDOWN_MS` (and an item
 * received in a trade lands with a fresh timestamp, so it re-enters the
 * cooldown — laundering through throwaway accounts costs a cooldown per
 * hop), and a new account cannot trade at all until it is old enough AND
 * has actually played. Titles and trophies never reach here: the manifest
 * parser refuses `tradable: true` on them, and the tradable check reads the
 * live definition, not the client's claim.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseItemRef, type ItemDef } from '@doomcraft/shared/items';

import { randomCrockford } from './credentials.js';
import { newLedgerId } from './journal.js';
import {
  MAX_OWNED_ITEMS, grantDrops,
  type PersistenceStore, type StoredProfile,
} from './persistence.js';

export const TRADES_FILE = 'trades.json';
export const TRADE_LOG_FILE = 'trades.jsonl';

export const TRADE_MIN_ACCOUNT_AGE_MS = 72 * 3600_000;
export const TRADE_MIN_MATCHES = 5;
export const TRADE_ITEM_COOLDOWN_MS = 48 * 3600_000;
/** A trade nobody touches for this long expires — escrow is never forever. */
export const TRADE_TTL_MS = 15 * 60_000;
/** Terminal trades stay readable this long so both parties see the outcome. */
export const TRADE_KEEP_MS = 3600_000;
export const MAX_TRADE_REFS = 6;
export const MAX_OPEN_TRADES_PER_KEY = 3;

export type TradeState = 'open' | 'active' | 'settling' | 'settled' | 'cancelled';

interface TradeSide {
  key: string;
  offer: string[];
  confirmed: boolean;
}

interface TradeRow {
  id: string;
  /** The join code the opener shares. Only ever shown while state is 'open'. */
  code: string;
  ms: number;
  updatedMs: number;
  a: TradeSide;
  b: TradeSide | null;
  state: TradeState;
  /** Why a terminal state happened, shown verbatim to both parties. */
  note: string;
  /** ref -> copies owned per side, written at 'settling' — the replay guard. */
  snapshot: { a: Record<string, number>; b: Record<string, number> } | null;
}

interface TradesDoc {
  version: 1;
  trades: Record<string, TradeRow>;
}

export interface TradeDeps {
  store: PersistenceStore;
  /** The LIVE items pack, localId -> def. What ACTIVE and tradable mean. */
  defs: () => ReadonlyMap<string, ItemDef>;
}

export interface TradeSideView {
  readonly offer: readonly string[];
  readonly confirmed: boolean;
}

export interface TradeView {
  readonly id: string;
  /** '' unless the caller opened it and it is still waiting for a partner. */
  readonly code: string;
  readonly state: TradeState;
  readonly note: string;
  readonly updatedMs: number;
  readonly expiresMs: number;
  readonly you: TradeSideView;
  readonly them: TradeSideView & { readonly present: boolean };
}

export type TradeResult =
  | { ok: true; trade: TradeView }
  | { ok: false; status: number; error: string };

function refuse(status: number, error: string): TradeResult {
  return { ok: false, status, error };
}

/* ------------------------------------------------------------------------ *
 * Pure validation — every refusal is a sentence the player reads
 * ------------------------------------------------------------------------ */

/** Null = may trade; otherwise why not. The "new accounts cannot trade" rule. */
export function traderRefusal(p: StoredProfile | null, nowMs: number): string | null {
  if (p === null) return 'no profile yet — play a match first';
  if (p.moderation.banned) return 'this account is moderated and cannot trade';
  if (nowMs - p.createdMs < TRADE_MIN_ACCOUNT_AGE_MS) {
    return 'this account is too new to trade — come back in a few days';
  }
  if (p.stats.matches < TRADE_MIN_MATCHES) {
    return `play ${TRADE_MIN_MATCHES} matches before trading`;
  }
  return null;
}

function countByRef(refs: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of refs) out.set(r, (out.get(r) ?? 0) + 1);
  return out;
}

function ownedCount(p: StoredProfile, ref: string): number {
  let n = 0;
  for (const it of p.inventory.items) if (it.ref === ref) n++;
  return n;
}

/** Copies of `ref` whose cooldown has passed — the only copies that may move. */
function tradableCopies(p: StoredProfile, ref: string, nowMs: number): number {
  let n = 0;
  for (const it of p.inventory.items) {
    if (it.ref === ref && nowMs - it.ms >= TRADE_ITEM_COOLDOWN_MS) n++;
  }
  return n;
}

/**
 * The ACTIVE-state check, run at offer AND at confirm. `reserved` is what
 * this key has already put on the table in OTHER live trades — one copy
 * cannot sit in two escrows.
 */
export function offerRefusal(
  p: StoredProfile,
  refs: readonly string[],
  defs: ReadonlyMap<string, ItemDef>,
  nowMs: number,
  reserved: ReadonlyMap<string, number> = new Map(),
): string | null {
  if (refs.length > MAX_TRADE_REFS) return `at most ${MAX_TRADE_REFS} items per side`;
  const revoked = new Set(p.moderation.revokedItems.map((r) => r.ref));
  for (const [ref, wanted] of countByRef(refs)) {
    const parsed = parseItemRef(ref);
    if (parsed === null) return `"${ref}" is not an item`;
    if (revoked.has(ref)) return 'that item was revoked and cannot be traded';
    const def = defs.get(parsed.localId);
    if (def === undefined) return 'that item is not in the live release — it cannot move while dormant';
    if (!def.tradable) return `"${def.name}" is not tradable`;
    const have = tradableCopies(p, ref, nowMs) - (reserved.get(ref) ?? 0);
    if (have < wanted) {
      if (ownedCount(p, ref) < wanted + (reserved.get(ref) ?? 0)) return `you do not own ${wanted} of "${def.name}"`;
      return `"${def.name}" is still in its trade cooldown`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * The service
 * ------------------------------------------------------------------------ */

export class TradeService {
  private readonly root: string;
  private readonly clock: () => number;
  private doc: TradesDoc = { version: 1, trades: {} };
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dataRoot: string, options: { clock?: () => number } = {}) {
    this.root = dataRoot.replace(/\/+$/, '');
    this.clock = options.clock ?? (() => Date.now());
    try {
      const raw = JSON.parse(readFileSync(join(this.root, TRADES_FILE), 'utf8')) as TradesDoc;
      if (raw.version === 1 && raw.trades !== null && typeof raw.trades === 'object') {
        this.doc = { version: 1, trades: raw.trades };
      }
    } catch { /* first boot */ }
  }

  /** Serialise every mutation; trades are rare, one lock is fine. */
  private locked<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private persist(): void {
    try {
      mkdirSync(this.root, { recursive: true });
      const tmp = join(this.root, `${TRADES_FILE}.tmp`);
      writeFileSync(tmp, JSON.stringify(this.doc, null, 2), 'utf8');
      renameSync(tmp, join(this.root, TRADES_FILE));
    } catch { /* an unwritable doc must not break play */ }
  }

  private audit(row: Record<string, unknown>): void {
    try {
      mkdirSync(this.root, { recursive: true });
      appendFileSync(join(this.root, TRADE_LOG_FILE), JSON.stringify(row) + '\n', 'utf8');
    } catch { /* an unwritable log must not break the trade */ }
  }

  /** Expire idle trades, drop terminal ones past the keep window. */
  private prune(now: number): void {
    let dirty = false;
    for (const t of Object.values(this.doc.trades)) {
      if ((t.state === 'open' || t.state === 'active') && now - t.updatedMs > TRADE_TTL_MS) {
        t.state = 'cancelled';
        t.note = 'expired — nobody touched this trade for a while';
        t.updatedMs = now;
        this.audit({ ms: now, tradeId: t.id, event: 'expire' });
        dirty = true;
      }
      if ((t.state === 'settled' || t.state === 'cancelled') && now - t.updatedMs > TRADE_KEEP_MS) {
        delete this.doc.trades[t.id];
        dirty = true;
      }
    }
    if (dirty) this.persist();
  }

  /** What `key` has on the table in live trades other than `exceptId`. */
  private reservedFor(key: string, exceptId: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const t of Object.values(this.doc.trades)) {
      if (t.id === exceptId) continue;
      if (t.state !== 'open' && t.state !== 'active' && t.state !== 'settling') continue;
      for (const side of [t.a, t.b]) {
        if (side === null || side.key !== key) continue;
        for (const ref of side.offer) out.set(ref, (out.get(ref) ?? 0) + 1);
      }
    }
    return out;
  }

  private liveCountFor(key: string): number {
    let n = 0;
    for (const t of Object.values(this.doc.trades)) {
      if (t.state !== 'open' && t.state !== 'active' && t.state !== 'settling') continue;
      if (t.a.key === key || (t.b !== null && t.b.key === key)) n++;
    }
    return n;
  }

  private view(t: TradeRow, callerKey: string): TradeView {
    const mine = t.a.key === callerKey ? t.a : t.b;
    const theirs = t.a.key === callerKey ? t.b : t.a;
    return Object.freeze({
      id: t.id,
      code: t.state === 'open' && t.a.key === callerKey ? t.code : '',
      state: t.state,
      note: t.note,
      updatedMs: t.updatedMs,
      expiresMs: t.state === 'open' || t.state === 'active' ? t.updatedMs + TRADE_TTL_MS : 0,
      you: Object.freeze({ offer: Object.freeze((mine?.offer ?? []).slice()), confirmed: mine?.confirmed ?? false }),
      them: Object.freeze({
        present: theirs !== null,
        offer: Object.freeze((theirs?.offer ?? []).slice()),
        confirmed: theirs?.confirmed ?? false,
      }),
    });
  }

  private partyOf(t: TradeRow, key: string): TradeSide | null {
    if (t.a.key === key) return t.a;
    if (t.b !== null && t.b.key === key) return t.b;
    return null;
  }

  /* --- the verbs -------------------------------------------------------- */

  open(key: string, deps: TradeDeps): Promise<TradeResult> {
    return this.locked(async () => {
      const now = this.clock();
      this.prune(now);
      const who = traderRefusal(await deps.store.load(key), now);
      if (who !== null) return refuse(403, who);
      if (this.liveCountFor(key) >= MAX_OPEN_TRADES_PER_KEY) {
        return refuse(429, `at most ${MAX_OPEN_TRADES_PER_KEY} trades at a time`);
      }
      let code = '';
      do { code = `TR${randomCrockford(6)}`; } while (this.byCode(code) !== null);
      const t: TradeRow = {
        id: newLedgerId(now), code, ms: now, updatedMs: now,
        a: { key, offer: [], confirmed: false }, b: null,
        state: 'open', note: '', snapshot: null,
      };
      this.doc.trades[t.id] = t;
      this.persist();
      this.audit({ ms: now, tradeId: t.id, event: 'open', actor: key });
      return { ok: true as const, trade: this.view(t, key) };
    });
  }

  private byCode(code: string): TradeRow | null {
    for (const t of Object.values(this.doc.trades)) {
      if (t.code === code && t.state === 'open') return t;
    }
    return null;
  }

  join(key: string, code: string, deps: TradeDeps): Promise<TradeResult> {
    return this.locked(async () => {
      const now = this.clock();
      this.prune(now);
      const t = this.byCode(code);
      if (t === null) return refuse(404, 'no open trade with that code');
      if (t.a.key === key) return refuse(409, 'you cannot trade with yourself');
      const who = traderRefusal(await deps.store.load(key), now);
      if (who !== null) return refuse(403, who);
      if (this.liveCountFor(key) >= MAX_OPEN_TRADES_PER_KEY) {
        return refuse(429, `at most ${MAX_OPEN_TRADES_PER_KEY} trades at a time`);
      }
      t.b = { key, offer: [], confirmed: false };
      t.state = 'active';
      t.updatedMs = now;
      this.persist();
      this.audit({ ms: now, tradeId: t.id, event: 'join', actor: key });
      return { ok: true as const, trade: this.view(t, key) };
    });
  }

  /**
   * Replace the caller's offer. ANY change resets BOTH confirms — the
   * anti-swap rule, enforced here so no caller can forget it.
   */
  offer(key: string, tradeId: string, refs: readonly string[], deps: TradeDeps): Promise<TradeResult> {
    return this.locked(async () => {
      const now = this.clock();
      this.prune(now);
      const t = this.doc.trades[tradeId];
      if (t === undefined) return refuse(404, 'no such trade');
      const side = this.partyOf(t, key);
      if (side === null) return refuse(403, 'not your trade');
      if (t.state !== 'active') return refuse(409, `this trade is ${t.state} — offers are closed`);
      const p = await deps.store.load(key);
      const who = traderRefusal(p, now);
      if (who !== null) return refuse(403, who);
      const bad = offerRefusal(p as StoredProfile, refs, deps.defs(), now, this.reservedFor(key, t.id));
      if (bad !== null) return refuse(400, bad);
      side.offer = refs.slice();
      t.a.confirmed = false;
      if (t.b !== null) t.b.confirmed = false;
      t.updatedMs = now;
      this.persist();
      this.audit({ ms: now, tradeId: t.id, event: 'offer', actor: key, refs: refs.slice() });
      return { ok: true as const, trade: this.view(t, key) };
    });
  }

  /**
   * Confirm the trade as the caller sees it. The ACTIVE-state check runs
   * again HERE, on BOTH sides — a failure cancels the whole trade rather
   * than settling half of it. Both confirms present = settle, atomically.
   */
  confirm(key: string, tradeId: string, deps: TradeDeps): Promise<TradeResult> {
    return this.locked(async () => {
      const now = this.clock();
      this.prune(now);
      const t = this.doc.trades[tradeId];
      if (t === undefined) return refuse(404, 'no such trade');
      const side = this.partyOf(t, key);
      if (side === null) return refuse(403, 'not your trade');
      if (t.state !== 'active' || t.b === null) return refuse(409, `this trade is ${t.state} — nothing to confirm`);
      if (t.a.offer.length === 0 && t.b.offer.length === 0) return refuse(400, 'nothing is on the table');

      const cancel = await this.revalidate(t, deps, now);
      if (cancel !== null) {
        t.state = 'cancelled';
        t.note = cancel;
        t.updatedMs = now;
        this.persist();
        this.audit({ ms: now, tradeId: t.id, event: 'cancel', actor: 'system', note: cancel });
        return { ok: true as const, trade: this.view(t, key) };
      }

      side.confirmed = true;
      t.updatedMs = now;
      this.audit({ ms: now, tradeId: t.id, event: 'confirm', actor: key });
      if (t.a.confirmed && t.b.confirmed) {
        await this.settle(t, deps, now);
      } else {
        this.persist();
      }
      return { ok: true as const, trade: this.view(t, key) };
    });
  }

  cancel(key: string, tradeId: string): Promise<TradeResult> {
    return this.locked(() => {
      const now = this.clock();
      this.prune(now);
      const t = this.doc.trades[tradeId];
      if (t === undefined) return refuse(404, 'no such trade');
      if (this.partyOf(t, key) === null) return refuse(403, 'not your trade');
      if (t.state === 'settling' || t.state === 'settled') {
        return refuse(409, `this trade is ${t.state} and cannot be cancelled`);
      }
      if (t.state !== 'cancelled') {
        t.state = 'cancelled';
        t.note = 'cancelled by a trader';
        t.updatedMs = now;
        this.persist();
        this.audit({ ms: now, tradeId: t.id, event: 'cancel', actor: key });
      }
      return { ok: true as const, trade: this.view(t, key) };
    });
  }

  stateFor(key: string, tradeId: string): Promise<TradeView | null> {
    return this.locked(() => {
      this.prune(this.clock());
      const t = this.doc.trades[tradeId];
      if (t === undefined || this.partyOf(t, key) === null) return null;
      return this.view(t, key);
    });
  }

  /** Every trade this key is party to, newest first — the Trade tab's list. */
  mine(key: string): Promise<TradeView[]> {
    return this.locked(() => {
      this.prune(this.clock());
      return Object.values(this.doc.trades)
        .filter((t) => this.partyOf(t, key) !== null)
        .sort((x, y) => y.updatedMs - x.updatedMs)
        .map((t) => this.view(t, key));
    });
  }

  status(): Record<string, number> {
    const all = Object.values(this.doc.trades);
    const by = (s: TradeState): number => all.filter((t) => t.state === s).length;
    return { open: by('open'), active: by('active'), settling: by('settling'), settled: by('settled'), cancelled: by('cancelled') };
  }

  /* --- settlement ------------------------------------------------------- */

  /** Null = both sides still stand; otherwise the sentence that cancels it. */
  private async revalidate(t: TradeRow, deps: TradeDeps, now: number): Promise<string | null> {
    const defs = deps.defs();
    const sides: { side: TradeSide; other: TradeSide }[] = [
      { side: t.a, other: t.b as TradeSide },
      { side: t.b as TradeSide, other: t.a },
    ];
    for (const { side, other } of sides) {
      const p = await deps.store.load(side.key);
      const who = traderRefusal(p, now);
      if (who !== null) return `a trader can no longer trade: ${who}`;
      const bad = offerRefusal(p as StoredProfile, side.offer, defs, now, this.reservedFor(side.key, t.id));
      if (bad !== null) return `an offer no longer stands: ${bad}`;
      const after = (p as StoredProfile).inventory.items.length - side.offer.length + other.offer.length;
      if (after > MAX_OWNED_ITEMS) return 'a trader\'s inventory would overflow';
    }
    return null;
  }

  /** Runs inside the service lock, with both offers already revalidated. */
  private async settle(t: TradeRow, deps: TradeDeps, now: number): Promise<void> {
    const b = t.b as TradeSide;
    const snap = (p: StoredProfile | null, side: TradeSide): Record<string, number> => {
      const out: Record<string, number> = {};
      if (p === null) return out;
      for (const ref of new Set(side.offer)) out[ref] = ownedCount(p, ref);
      return out;
    };
    t.snapshot = {
      a: snap(await deps.store.load(t.a.key), t.a),
      b: snap(await deps.store.load(b.key), b),
    };
    t.state = 'settling';
    t.updatedMs = now;
    this.persist();
    this.audit({
      ms: now, tradeId: t.id, event: 'settling',
      a: { key: t.a.key, gives: t.a.offer.slice() },
      b: { key: b.key, gives: b.offer.slice() },
    });

    await this.settleSide(t, t.a, b, t.snapshot.a, deps, now);
    await this.settleSide(t, b, t.a, t.snapshot.b, deps, now);

    t.state = 'settled';
    t.updatedMs = this.clock();
    this.persist();
    this.audit({ ms: t.updatedMs, tradeId: t.id, event: 'settled' });
  }

  /**
   * One side's whole transfer in one `store.update`, idempotent under
   * replay: a side that RECEIVES is done iff the tagged grant is present; a
   * side that only GIVES is done iff the snapshot says its copies already
   * left. Removal takes the OLDEST cooled-down copies, so the copies that
   * stay are the ones still in cooldown — never the other way around.
   */
  private async settleSide(
    t: TradeRow, side: TradeSide, other: TradeSide,
    snapshot: Record<string, number>, deps: TradeDeps, now: number,
  ): Promise<void> {
    const tag = `trade:${t.id}`;
    await deps.store.update(side.key, (p) => {
      if (other.offer.length > 0 && p.inventory.items.some((it) => it.sourceId === tag)) return;
      if (other.offer.length === 0 && this.alreadyRemoved(p, side, snapshot)) return;
      this.removeCopies(p, side.offer, now);
      grantDrops(p, other.offer, 'trade', tag, now);
    });
  }

  private alreadyRemoved(p: StoredProfile, side: TradeSide, snapshot: Record<string, number>): boolean {
    if (side.offer.length === 0) return true;
    for (const [ref, wanted] of countByRef(side.offer)) {
      if (ownedCount(p, ref) > (snapshot[ref] ?? 0) - wanted) return false;
    }
    return true;
  }

  private removeCopies(p: StoredProfile, offer: readonly string[], now: number): void {
    for (const [ref, wanted] of countByRef(offer)) {
      const eligible = p.inventory.items
        .filter((it) => it.ref === ref && now - it.ms >= TRADE_ITEM_COOLDOWN_MS)
        .sort((x, y) => x.ms - y.ms)
        .slice(0, wanted);
      for (const victim of eligible) {
        const at = p.inventory.items.indexOf(victim);
        if (at >= 0) p.inventory.items.splice(at, 1);
      }
      if (p.inventory.equippedSkin === ref && ownedCount(p, ref) === 0) p.inventory.equippedSkin = '';
      if (p.inventory.title === ref && ownedCount(p, ref) === 0) p.inventory.title = '';
    }
  }

  /**
   * Boot-time crash recovery: any trade the last process left in 'settling'
   * had both confirms and a snapshot on disk — finish it. The per-side
   * guards make a half-done side a no-op and a not-done side a redo.
   */
  recover(deps: TradeDeps): Promise<number> {
    return this.locked(async () => {
      let finished = 0;
      for (const t of Object.values(this.doc.trades)) {
        if (t.state !== 'settling' || t.b === null || t.snapshot === null) continue;
        const now = this.clock();
        await this.settleSide(t, t.a, t.b, t.snapshot.a, deps, now);
        await this.settleSide(t, t.b, t.a, t.snapshot.b, deps, now);
        t.state = 'settled';
        t.note = 'settled after a restart';
        t.updatedMs = now;
        this.audit({ ms: now, tradeId: t.id, event: 'settled', note: 'recovered' });
        finished++;
      }
      if (finished > 0) this.persist();
      return finished;
    });
  }
}
