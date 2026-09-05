/**
 * DOOMCRAFT — the Trade tab inside the profile overlay. The DOM half.
 *
 * Every decision is `tradeModel.ts`'s; this file is fetches, a poll loop and
 * `document.createElement`. Conventions are `accountPanel.ts`'s: the fetch
 * wrapper answers `{status: 0}` on network error, the server's sentences
 * render VERBATIM, and the panel only ever shows an outcome the server
 * already decided.
 *
 * THERE IS NO PUSH CHANNEL for trades (verified: zero trade messages in
 * protocol.ts) — the tab POLLS `/api/trade/state?id=` while it is visible and
 * a trade is live, and STOPS the moment it is hidden. `shown()`/`hidden()`
 * are called by the profile overlay on every tab switch and close path; a
 * poll that outlives its panel is a leak the player pays for in requests.
 *
 * HTTP 200 is not success: everything re-renders from `trade.state`, which is
 * why every verb lands in the same `adopt()` and nothing branches on status
 * beyond "was there a JSON error sentence to show".
 */

import {
  buildTradeView,
  type TradeInputs,
  type WireTrade,
} from '@/ui/tradeModel';
import type { WireInventory, WireItemsPack } from '@/ui/loadoutModel';

export interface TradeTabOptions {
  /** '' = same origin. */
  serverBase: string;
  deviceId: () => string;
}

const POLL_MS = 2_500;

const STYLE_ID = 'dc-trade-css';
let styleUsers = 0;

const CSS = `
.dct{font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#e8e6e3}
.dct-line{margin:0 0 10px;font-size:12.5px;color:#9d968f}
.dct-note{margin:0 0 10px;padding:9px 12px;border:1px solid rgba(240,160,32,.5);border-radius:3px;
  background:rgba(240,160,32,.07);color:#ffd9a0;font-size:12.5px}
.dct-err{margin:0 0 10px;font-size:12px;color:#e8695a;min-height:1.2em}
.dct-box{border:1px solid rgba(255,255,255,.13);border-radius:3px;background:rgba(10,10,14,.86);
  padding:12px 14px;margin:0 0 11px}
.dct-box h3{margin:0 0 8px;font:700 11px/1.2 system-ui;letter-spacing:.2em;
  text-transform:uppercase;color:#8d8781}
.dct-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dct-row input{min-height:38px;padding:8px 10px;background:#15151b;color:#e8e6e3;
  border:1px solid rgba(255,255,255,.16);border-radius:2px;font:inherit;font-size:13px;
  text-transform:uppercase;width:11em}
.dct-row input:focus{outline:none;border-color:rgba(255,255,255,.4)}
.dct-code{font:900 clamp(26px,5vw,40px)/1.1 "Arial Black",Impact,sans-serif;letter-spacing:.14em;
  color:#f4f1ee;text-align:center;padding:14px 0 4px;user-select:all}
.dct-code-sub{text-align:center;font-size:11.5px;color:#7d7873;margin:0 0 10px}
.dct-sides{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin:0 0 11px}
@media (max-width:640px){ .dct-sides{grid-template-columns:1fr} }
.dct-offer{border:1px solid rgba(255,255,255,.13);border-radius:3px;background:rgba(10,10,14,.86);
  padding:11px 13px;min-height:88px}
.dct-offer h3{margin:0 0 7px;font:700 11px/1.2 system-ui;letter-spacing:.2em;
  text-transform:uppercase;color:#8d8781;display:flex;justify-content:space-between;gap:8px}
.dct-offer h3 i{font-style:normal;font-size:10px;letter-spacing:.12em;color:#8fd18a}
.dct-offer p{margin:2px 0;font-size:12.5px;color:#e2ddd8}
.dct-offer p.dct-nil{color:#6f6a66}
.dct-pick{display:flex;gap:10px;align-items:center;padding:6px 0;
  border-top:1px solid rgba(255,255,255,.06)}
.dct-pick:first-of-type{border-top:0}
.dct-pick b{flex:1;min-width:0;font-weight:600;color:#e2ddd8;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.dct-pick b small{font-weight:400;color:#8d8781;margin-left:6px}
.dct-pick span{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6f6a66}
#ui .dct button{font:700 12px/1 system-ui;letter-spacing:.08em;min-height:38px;
  padding:9px 16px;border:1px solid rgba(255,255,255,.22);border-radius:2px;
  background:rgba(255,255,255,.06);color:#e8e6e3;cursor:pointer;text-transform:uppercase}
#ui .dct button:hover{border-color:rgba(255,255,255,.4)}
#ui .dct button.go{background:#8f1a08;border-color:#e03c1c;color:#ffe6d8}
#ui .dct button.go:hover{background:#b02510}
#ui .dct button:disabled{opacity:.5;cursor:progress}
#ui .dct .dct-tick{min-height:30px;padding:6px 10px;font-size:11px}
#ui .dct .dct-tick[aria-pressed="true"]{background:#8f1a08;border-color:#e03c1c;color:#ffe6d8}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) === null) {
    const node = document.createElement('style');
    node.id = STYLE_ID;
    node.textContent = CSS;
    document.head.appendChild(node);
  }
  styleUsers++;
}
function releaseStyle(): void {
  styleUsers = Math.max(0, styleUsers - 1);
  if (styleUsers > 0) return;
  document.getElementById(STYLE_ID)?.remove();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

type Answer = { status: number; trade?: WireTrade; trades?: WireTrade[]; error?: string };

export class TradeTab {
  readonly element: HTMLElement;

  private readonly opts: TradeTabOptions;
  private destroyed = false;
  private visible = false;
  private busy = false;
  private error = '';
  private trade: WireTrade | null = null;
  private mine: WireTrade[] = [];
  private inventory: WireInventory | null = null;
  private revoked: string[] = [];
  private pack: WireItemsPack | null = null;
  private selected = new Set<string>();
  private phase: TradeInputs['phase'] = 'loading';
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** 'both confirms were reset' — set when a POLL reveals it, never by
   *  the player's own verb, and shown until the next action. */
  private flash = '';

  constructor(opts: TradeTabOptions) {
    this.opts = opts;
    ensureStyle();
    this.element = el('div', 'dct');
    this.render();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopPoll();
    this.element.remove();
    releaseStyle();
  }

  /** The profile overlay switched TO this tab. */
  async shown(): Promise<void> {
    this.visible = true;
    this.error = '';
    this.phase = 'loading';
    this.render();
    await Promise.all([this.loadStock(), this.loadMine()]);
    if (this.destroyed || !this.visible) return;
    this.phase = this.phaseFromLoads();
    // Rejoin a live trade if one exists — newest open/active first.
    const live = this.mine.find((t) => t.state === 'open' || t.state === 'active') ?? null;
    if (live !== null && this.trade === null) this.adopt(live);
    this.render();
    this.schedulePoll();
  }

  /** The overlay switched away or closed. The poll STOPS here, always. */
  hidden(): void {
    this.visible = false;
    this.stopPoll();
  }

  /* ------------------------------------------------------------------ */

  private phaseFromLoads(): TradeInputs['phase'] {
    return this.pack === null && this.inventory === null ? 'offline' : 'ready';
  }

  private async call(path: string, body?: unknown): Promise<Answer> {
    try {
      const res = await fetch(`${this.opts.serverBase}${path}`, body === undefined ? {} : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({})) as Omit<Answer, 'status'>;
      return { status: res.status, ...json };
    } catch {
      return { status: 0 };
    }
  }

  private async loadStock(): Promise<void> {
    const device = encodeURIComponent(this.opts.deviceId());
    const [profileRes, packRes] = await Promise.all([
      this.call(`/api/profile?device=${device}`),
      this.call('/api/items'),
    ]);
    const prof = (profileRes as unknown as {
      profile?: {
        inventory?: WireInventory;
        moderation?: { revokedItems?: Array<{ ref?: string }> };
      };
    }).profile;
    this.inventory = prof?.inventory !== undefined && Array.isArray(prof.inventory.items)
      ? prof.inventory
      : profileRes.status === 404 ? { items: [], equippedSkin: '', title: '', variants: {} } : null;
    this.revoked = (prof?.moderation?.revokedItems ?? [])
      .map((r) => typeof r.ref === 'string' ? r.ref : '').filter((r) => r.length > 0);
    const rawPack = packRes as unknown as { status: number; version?: number; items?: WireItemsPack['items'] };
    this.pack = rawPack.status === 200 && Array.isArray(rawPack.items)
      ? { version: rawPack.version ?? 0, items: rawPack.items } : null;
  }

  private async loadMine(): Promise<void> {
    const res = await this.call(`/api/trade/mine?device=${encodeURIComponent(this.opts.deviceId())}`);
    this.mine = res.status === 200 && Array.isArray(res.trades) ? res.trades : [];
  }

  /** Adopt a server answer as the trade on screen; seed the picker from it. */
  private adopt(trade: WireTrade | null, ownAction = false): void {
    const before = this.trade;
    this.trade = trade;
    /* The reset behaviour, made VISIBLE: any offer change clears BOTH
     * confirms server-side. When the poll (not the player's own verb)
     * reveals that this player's confirm vanished, say why — a silently
     * unticked confirm reads as a lost click, or worse, as a scam. */
    if (!ownAction && before !== null && trade !== null && before.id === trade.id
      && trade.state === 'active' && before.you.confirmed && !trade.you.confirmed) {
      this.flash = 'The offer changed — both confirms were reset. Check the deal again before confirming.';
    } else if (trade === null || trade.state !== 'active' || before === null || before.id !== trade.id) {
      this.flash = '';
    }
    if (trade !== null && (before === null || before.id !== trade.id
      || before.you.offer.join(',') !== trade.you.offer.join(','))) {
      this.selected = new Set(trade.you.offer);
    }
    if (trade === null) this.selected.clear();
  }

  private stopPoll(): void {
    if (this.pollTimer !== null) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  private schedulePoll(): void {
    this.stopPoll();
    if (!this.visible || this.destroyed) return;
    const t = this.trade;
    if (t === null || (t.state !== 'open' && t.state !== 'active' && t.state !== 'settling')) return;
    this.pollTimer = setTimeout(() => { void this.poll(); }, POLL_MS);
  }

  private async poll(): Promise<void> {
    const t = this.trade;
    if (t === null || !this.visible || this.destroyed) return;
    const res = await this.call(`/api/trade/state?id=${encodeURIComponent(t.id)}&device=${encodeURIComponent(this.opts.deviceId())}`);
    if (this.destroyed || !this.visible) return;
    if (res.status === 200 && res.trade !== undefined) {
      const was = this.trade?.state;
      this.adopt(res.trade);
      if (was !== 'settled' && res.trade.state === 'settled') void this.loadStock();
    } else if (res.status === 404) {
      // Terminal trades are reaped after an hour; the trade is simply gone.
      this.adopt(null);
      void this.loadMine();
    }
    this.render();
    this.schedulePoll();
  }

  private async verb(path: string, body: Record<string, unknown>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    this.render();
    this.flash = '';
    const res = await this.call(path, { deviceId: this.opts.deviceId(), ...body });
    if (this.destroyed) return;
    this.busy = false;
    if (res.status === 200 && res.trade !== undefined) {
      this.adopt(res.trade, true);
      if (res.trade.state === 'settled') void this.loadStock();
    } else {
      this.error = res.status === 0 ? 'No server answered.' : res.error ?? `Refused (${res.status}).`;
    }
    this.render();
    this.schedulePoll();
  }

  /* ------------------------------------------------------------------ *
   * Painting — no decisions, only placement
   * ------------------------------------------------------------------ */

  private render(): void {
    const v = buildTradeView({
      phase: this.phase,
      trade: this.trade,
      mine: this.mine,
      inventory: this.inventory,
      revoked: this.revoked,
      pack: this.pack,
      selected: [...this.selected],
      busy: this.busy,
      error: this.error,
      nowMs: Date.now(),
    });
    this.element.replaceChildren();
    this.element.appendChild(el('p', 'dct-line', v.line));
    if (v.note !== '') this.element.appendChild(el('div', 'dct-note', v.note));
    if (this.flash !== '') this.element.appendChild(el('div', 'dct-note', this.flash));
    if (v.error !== '') this.element.appendChild(el('p', 'dct-err', v.error));

    if (v.mode === 'idle') { this.renderIdle(v.can.open, v.can.join, v.recent); return; }
    if (v.mode === 'waiting') { this.renderWaiting(v.code, v.expiresInMin, v.can.cancel); return; }
    if (v.mode === 'active') { this.renderActive(v); return; }
    if (v.mode === 'done') this.renderDone(v);
  }

  private renderIdle(canOpen: boolean, canJoin: boolean, recent: ReturnType<typeof buildTradeView>['recent']): void {
    const box = el('div', 'dct-box');
    box.appendChild(el('h3', undefined, 'Start'));
    const row = el('div', 'dct-row');
    const open = el('button', 'go', 'Open a trade');
    open.type = 'button';
    open.disabled = !canOpen;
    open.addEventListener('click', () => { void this.verb('/api/trade/open', {}); });
    const code = el('input');
    code.placeholder = 'Partner code';
    code.maxLength = 12;
    const join = el('button', undefined, 'Join');
    join.type = 'button';
    join.disabled = !canJoin;
    join.addEventListener('click', () => {
      if (code.value.trim().length > 0) void this.verb('/api/trade/join', { code: code.value.trim() });
    });
    row.append(open, code, join);
    box.appendChild(row);
    this.element.appendChild(box);

    if (recent.length > 0) {
      const past = el('div', 'dct-box');
      past.appendChild(el('h3', undefined, 'Recent'));
      for (const r of recent) {
        const p = el('p', undefined, `${r.state}${r.note !== '' ? ` — ${r.note}` : ''}`);
        p.style.margin = '3px 0';
        p.style.fontSize = '12px';
        p.style.color = '#9d968f';
        past.appendChild(p);
      }
      this.element.appendChild(past);
    }
  }

  private renderWaiting(code: string, expiresInMin: number, canCancel: boolean): void {
    const box = el('div', 'dct-box');
    box.appendChild(el('div', 'dct-code', code));
    box.appendChild(el('p', 'dct-code-sub',
      `Your partner enters this code in their own Trade tab. Expires in ${expiresInMin} min if nobody joins.`));
    const row = el('div', 'dct-row');
    const cancel = el('button', undefined, 'Cancel');
    cancel.type = 'button';
    cancel.disabled = !canCancel;
    cancel.addEventListener('click', () => { void this.verb('/api/trade/cancel', { tradeId: this.trade?.id ?? '' }); });
    row.appendChild(cancel);
    box.appendChild(row);
    this.element.appendChild(box);
  }

  private renderActive(v: ReturnType<typeof buildTradeView>): void {
    const sides = el('div', 'dct-sides');
    for (const [label, side] of [['You give', v.you], ['You get', v.them]] as const) {
      const box = el('div', 'dct-offer');
      const h = el('h3');
      h.append(document.createTextNode(label));
      if (side.confirmed) h.appendChild(el('i', undefined, 'Confirmed'));
      box.appendChild(h);
      if (side.lines.length === 0) box.appendChild(el('p', 'dct-nil', 'nothing yet'));
      for (const line of side.lines) box.appendChild(el('p', undefined, line));
      sides.appendChild(box);
    }
    this.element.appendChild(sides);
    if (v.reconfirm !== '') this.element.appendChild(el('p', 'dct-line', v.reconfirm));

    const pick = el('div', 'dct-box');
    pick.appendChild(el('h3', undefined, 'Your items'));
    for (const p of v.picker) {
      const row = el('div', 'dct-pick');
      const name = el('b', undefined, p.name);
      if (p.copies > 1) name.appendChild(el('small', undefined, `×${p.copies}`));
      row.appendChild(name);
      if (p.blocked !== '') row.appendChild(el('span', undefined, p.blocked));
      else {
        const tick = el('button', 'dct-tick', p.selected ? 'Offered' : 'Offer');
        tick.type = 'button';
        tick.setAttribute('aria-pressed', p.selected ? 'true' : 'false');
        tick.addEventListener('click', () => {
          if (this.selected.has(p.ref)) this.selected.delete(p.ref);
          else this.selected.add(p.ref);
          this.render();
        });
        row.appendChild(tick);
      }
      pick.appendChild(row);
    }
    const actions = el('div', 'dct-row');
    const offer = el('button', undefined, 'Update offer');
    offer.type = 'button';
    offer.disabled = !v.can.offer;
    offer.addEventListener('click', () => {
      void this.verb('/api/trade/offer', { tradeId: this.trade?.id ?? '', refs: [...this.selected] });
    });
    const confirm = el('button', 'go', 'Confirm trade');
    confirm.type = 'button';
    confirm.disabled = !v.can.confirm;
    confirm.addEventListener('click', () => { void this.verb('/api/trade/confirm', { tradeId: this.trade?.id ?? '' }); });
    const cancel = el('button', undefined, 'Cancel');
    cancel.type = 'button';
    cancel.disabled = !v.can.cancel;
    cancel.addEventListener('click', () => { void this.verb('/api/trade/cancel', { tradeId: this.trade?.id ?? '' }); });
    actions.append(offer, confirm, cancel);
    pick.appendChild(actions);
    this.element.appendChild(pick);
  }

  private renderDone(v: ReturnType<typeof buildTradeView>): void {
    const sides = el('div', 'dct-sides');
    for (const [label, side] of [['You gave', v.you], ['You got', v.them]] as const) {
      const box = el('div', 'dct-offer');
      box.appendChild(el('h3', undefined, label));
      if (side.lines.length === 0) box.appendChild(el('p', 'dct-nil', 'nothing'));
      for (const line of side.lines) box.appendChild(el('p', undefined, line));
      sides.appendChild(box);
    }
    this.element.appendChild(sides);
    const row = el('div', 'dct-row');
    const back = el('button', undefined, 'Back');
    back.type = 'button';
    back.addEventListener('click', () => {
      this.adopt(null);
      void this.loadMine().then(() => { if (!this.destroyed) this.render(); });
      this.render();
    });
    row.appendChild(back);
    this.element.appendChild(row);
  }
}

export function createTradeTab(opts: TradeTabOptions): TradeTab {
  return new TradeTab(opts);
}
