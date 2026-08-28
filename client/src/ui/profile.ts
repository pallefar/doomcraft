/**
 * DOOMCRAFT — the profile screen. The DOM half, and nothing else.
 *
 * Every decision this file could make has already been made in
 * `client/src/ui/profileModel.ts`, which is pure and therefore tested. What is
 * left here is `document.createElement` and one stylesheet, which vitest cannot
 * see under `environment: 'node'` — so the rule is that if a line in this file
 * looks like it is *choosing* something, it belongs in the model instead.
 *
 * FOUR THINGS THAT ARE NOT ARBITRARY
 *
 * 1. **It is an overlay, not a fifth `data-screen`.** `client/src/main.ts`
 *    installs a `MutationObserver` with `attributeFilter: ['data-screen']` that
 *    feeds `boot/updates.ts`, and that path ends in `location.reload()`. A
 *    profile screen that set `uiRoot.dataset.screen = 'profile'` would be a
 *    screen that sometimes reloads the page out from under the player. So this
 *    mounts as a direct child of `#ui` and toggles its own `.is-open`, exactly
 *    as `avatarEditor.ts` does — and `wiring.test.ts` asserts the string
 *    `dataset.screen` never appears in this file.
 *
 * 2. **`#ui button{font:inherit}` (main.ts) beats every class rule**, because
 *    an id in the selector outranks any number of classes. `modeSelect.ts` never
 *    restated its button typography and that is why the shipped PLAY button is
 *    14 px system-ui instead of the 19 px Arial Black its rule asks for. The
 *    `#ui .dcp-*` block at the bottom of the sheet is the fix, not a duplicate.
 *
 * 3. **New prefix, own sheet, refcounted.** `SHELL_CSS` already declares
 *    `.dc-note` twice with two different meanings; a fourth `.dc-` block here
 *    would be a third. `ensureStyle`/`releaseStyle` are the pattern from
 *    `avatarEditor.ts:301-315`, so opening the profile and the locker together
 *    and closing one does not strip the other's stylesheet.
 *
 * 4. **The view is rebuilt on every `open()`.** `ProfileScreenOptions.inputs`
 *    is a callback, not a value, because the balance and the save both move
 *    while this screen is closed. A screen built once at boot would show the
 *    numbers from boot, which is the kind of bug nobody reports and everybody
 *    notices.
 *
 * `--safe-t/-b/-l/-r` (client/index.html) are consumed in the padding so the
 * overlay clears a notch, and `.dc-panel`/`.dc-actions`/`.dc-ghost` from
 * `SHELL_CSS` are reused verbatim where they fit rather than restyled.
 */

import { Feature, hasOverride, isEnabled } from '@shared/features';

import { AVATAR_PALETTE, avatarLabel, unpackAvatar } from '@/characters/avatar';
import { createAccountPanel, type AccountPanel, type AccountPanelOptions } from '@/ui/accountPanel';
import { createLoadoutTab, economyTabs, probeServerFlags, type LoadoutTab } from '@/ui/loadoutTab';
import { createMatchShareButton } from '@/ui/shareCard';
import { createCompetitionsTab, type CompetitionsTab } from '@/ui/competitionsTab';
import { createTradeTab, type TradeTab } from '@/ui/tradeTab';
import { MatchTypeNotice } from '@/ui/matchType';
import {
  buildProfileView,
  type ProfileInputs,
  type ProfilePanel,
  type ProfileView,
} from '@/ui/profileModel';

/* ------------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------------ */

export interface ProfileScreenOptions {
  /** Where the overlay mounts. Must be `#ui` itself, not one of its screens. */
  root: HTMLElement;
  /** Read fresh on every open. See rule 4 above. */
  inputs(): ProfileInputs;
  /** Fired on every close path: the button, Escape, and `setScreen`. */
  onClose?(): void;
  /**
   * C4: mount the interactive account panel (sign in / the row-3 question /
   * sign out). Absent, the overlay is exactly what it was — the static
   * build's model sentence stands alone and stays true.
   */
  account?: AccountPanelOptions;
}

/* ------------------------------------------------------------------------ *
 * Styles — one sheet, refcounted, scoped to `.dcp-`
 * ------------------------------------------------------------------------ */

const STYLE_ID = 'dc-profile-css';
let styleUsers = 0;

export const PROFILE_CSS = `
.dcp{--dcp-ink:#e8e6e3;--dcp-dim:#938e89;--dcp-line:rgba(255,255,255,.13);
  --dcp-panel:rgba(10,10,14,.86);--dcp-hell:#e03c1c;
  position:absolute;inset:0;z-index:5;display:none;overflow:auto;overscroll-behavior:contain;
  font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
  color:var(--dcp-ink);text-align:left;
  background:
    radial-gradient(78% 58% at 50% 0%,rgba(46,14,7,.62),rgba(0,0,0,0) 68%),
    rgba(5,5,8,.94);
  -webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);
  padding:calc(24px + var(--safe-t,0px)) calc(22px + var(--safe-r,0px))
    calc(24px + var(--safe-b,0px)) calc(22px + var(--safe-l,0px))}
.dcp.is-open{display:grid;place-items:safe center;align-content:safe center}
.dcp *{box-sizing:border-box}
@media (max-width:900px){
  .dcp{padding:calc(12px + var(--safe-t,0px)) calc(11px + var(--safe-r,0px))
    calc(12px + var(--safe-b,0px)) calc(11px + var(--safe-l,0px))}
}

.dcp-shell{width:min(1060px,100%);margin:0 auto;display:flex;flex-direction:column;gap:11px}

/* ---- header ---- */
.dcp-head{display:flex;align-items:center;gap:14px}
/* Named rather than a .dcp-head>div child selector: the look chip is a div
   too, and that selector stretched it across the whole header. */
.dcp-titles{flex:1;min-width:0}
.dcp-head h2{margin:0;font:900 clamp(20px,3vw,30px)/0.95 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.06em;text-transform:uppercase;color:#f4f1ee;
  text-shadow:0 2px 0 #6d1707,0 10px 26px rgba(224,60,28,.30);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dcp-head h2 span{color:var(--dcp-hell)}
.dcp-since{margin:5px 0 0;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#6f6a66}
.dcp-source{margin:6px 0 0;font-size:12px;color:#b4aea8}
.dcp-x{width:44px;height:44px;flex:0 0 44px;border:1px solid var(--dcp-line);border-radius:3px;
  background:rgba(255,255,255,.04);color:#b4aea8;font:400 20px/1 system-ui;cursor:pointer}
.dcp-x:hover{border-color:rgba(255,255,255,.42);color:#fff}

/* ---- the look, without a GL context ----
   The locker owns the 3D preview and the whole point of that module is that its
   context only exists while it is open. Two swatches and the packed name say
   which marine this is for a few bytes and no draw calls. */
.dcp-look{display:flex;align-items:center;gap:9px;padding:7px 12px;border-radius:2px;
  border:1px solid var(--dcp-line);background:rgba(255,255,255,.03);flex:0 0 auto}
.dcp-look i{width:13px;height:13px;border-radius:50%;flex:0 0 13px;
  box-shadow:0 0 0 1px rgba(0,0,0,.6),0 0 0 2px rgba(255,255,255,.18)}
.dcp-look span{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#b4aea8;
  white-space:nowrap}
.dcp-look span.dcp-cap{color:#6f6a66;letter-spacing:.2em}
@media (max-width:700px){ .dcp-look{display:none} }

/* ---- tiles ---- */
.dcp-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:9px}
@media (max-width:640px){ .dcp-tiles{grid-template-columns:repeat(2,1fr)} }
.dcp-tile{padding:12px 14px;border:1px solid var(--dcp-line);border-radius:3px;
  background:var(--dcp-panel)}
.dcp-tile b{display:block;font:800 clamp(20px,3.4vw,28px)/1 "Arial Black",Impact,sans-serif;
  color:#f4f1ee;font-variant-numeric:tabular-nums}
.dcp-tile em{display:block;margin-top:6px;font:600 10px/1.2 system-ui;font-style:normal;
  letter-spacing:.18em;text-transform:uppercase;color:#8d8781}
.dcp-tile small{display:block;margin-top:3px;font-size:11px;color:#6f6a66}

/* ---- level bar ---- */
.dcp-level{padding:12px 14px;border:1px solid var(--dcp-line);border-radius:3px;
  background:var(--dcp-panel)}
.dcp-level-top{display:flex;justify-content:space-between;gap:12px;font-size:11px;
  letter-spacing:.16em;text-transform:uppercase;color:#8d8781}
.dcp-track{margin-top:8px;height:8px;border-radius:2px;overflow:hidden;
  background:rgba(255,255,255,.07)}
.dcp-fill{height:100%;background:linear-gradient(90deg,#8f1a08,#e03c1c);
  transition:width .18s ease-out}
@media (prefers-reduced-motion:reduce){ .dcp-fill{transition:none} }

/* ---- panels ---- */
.dcp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(304px,1fr));gap:11px;
  align-items:start}
.dcp-panel{border:1px solid var(--dcp-line);border-radius:3px;background:var(--dcp-panel);
  padding:12px 14px 13px}
.dcp-panel h3{margin:0 0 9px;font:700 11px/1.2 system-ui;letter-spacing:.2em;
  text-transform:uppercase;color:#8d8781}
.dcp-line{display:flex;gap:12px;justify-content:space-between;align-items:baseline;
  padding:4px 0;border-top:1px solid rgba(255,255,255,.06)}
.dcp-line:first-of-type{border-top:0}
.dcp-line b{font-weight:600;color:#e2ddd8;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.dcp-line span{color:#9d968f;text-align:right;font-variant-numeric:tabular-nums;
  font-size:12.5px;flex:0 1 auto}
.dcp-line.is-dim b{font-weight:400;color:#8d8781;padding-left:10px}
.dcp-line.is-dim span{color:#7d7873}
.dcp-caveat{margin:9px 0 0;font-size:11.5px;line-height:1.5;color:#7d7873}
.dcp-caveat b{color:#b4aea8;font-weight:600}

/* ---- the trust notice ---- */
.dcp-worth{border:1px solid var(--dcp-line);border-radius:3px;background:var(--dcp-panel);
  padding:12px 14px 13px}
.dcp-worth h3{margin:0 0 9px;font:700 11px/1.2 system-ui;letter-spacing:.2em;
  text-transform:uppercase;color:#8d8781}

/* ---- the tab strip (economy surfaces) ----
   Hidden until the server's flag probe says a tab exists, so the static
   build and a dark host render the overlay byte-identical to before. */
.dcp-tabs{display:none;gap:8px;flex-wrap:wrap}
.dcp-tabs.is-shown{display:flex}
.dcp-tab{padding:9px 18px;border:1px solid var(--dcp-line);border-radius:2px;
  background:rgba(255,255,255,.04);color:#b4aea8;cursor:pointer;text-transform:uppercase}
.dcp-tab:hover{border-color:rgba(255,255,255,.42);color:#fff}
.dcp-tab[aria-selected="true"]{background:#8f1a08;border-color:#e03c1c;color:#ffe6d8}
.dcp-tabwrap{display:none}
.dcp-tabwrap.is-on{display:block}
.dcp-tabwrap > * + *{margin-top:11px}

.dcp-foot{display:flex;gap:10px;align-items:center;flex-wrap:wrap;
  border-top:1px solid rgba(255,255,255,.09);padding-top:13px}
.dcp-foot p{margin:0;flex:1;min-width:200px;font-size:11.5px;color:#7d7873}
.dcp-done{padding:12px 30px;border-radius:2px;text-transform:uppercase}

/* The shell sets \`#ui button{font:inherit}\` (client/src/main.ts) and an id in
   the selector outranks any number of classes, so every button rule above
   silently loses its typography without these. Deliberate duplicates: the class
   rules still stand if this component is ever mounted outside #ui. */
#ui .dcp-x{font:400 20px/1 system-ui}
#ui .dcp-done{font:800 14px/1 "Arial Black",Impact,sans-serif;letter-spacing:.16em;
  padding:12px 30px;text-transform:uppercase}
#ui .dcp-tab{font:700 12px/1 system-ui;letter-spacing:.14em}
#ui .dcp-share{font:700 12px/1 system-ui;letter-spacing:.08em;min-height:36px;margin-top:9px;
  padding:9px 18px;border:1px solid rgba(255,255,255,.22);border-radius:2px;
  background:rgba(255,255,255,.06);color:#e8e6e3;cursor:pointer;text-transform:uppercase}
#ui .dcp-share:hover{border-color:rgba(255,255,255,.4)}
#ui .dcp-share:disabled{opacity:.5;cursor:progress}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) === null) {
    const node = document.createElement('style');
    node.id = STYLE_ID;
    node.textContent = PROFILE_CSS;
    document.head.appendChild(node);
  }
  styleUsers++;
}

function releaseStyle(): void {
  styleUsers = Math.max(0, styleUsers - 1);
  if (styleUsers > 0) return;
  document.getElementById(STYLE_ID)?.remove();
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function hexCss(hex: number): string {
  return `#${(hex >>> 0).toString(16).padStart(6, '0')}`;
}

/* ------------------------------------------------------------------------ *
 * The screen
 * ------------------------------------------------------------------------ */

export class ProfileScreen {
  readonly element: HTMLDivElement;

  private readonly opts: ProfileScreenOptions;
  private readonly nameEl: HTMLElement;
  private readonly sinceEl: HTMLElement;
  private readonly sourceEl: HTMLElement;
  private readonly lookEl: HTMLElement;
  private readonly lookTint: HTMLElement;
  private readonly lookAccent: HTMLElement;
  private readonly lookName: HTMLElement;
  private readonly tilesEl: HTMLElement;
  private readonly levelTop: HTMLElement;
  private readonly levelXp: HTMLElement;
  private readonly fillEl: HTMLElement;
  private readonly worthEl: HTMLElement;
  private readonly worthHead: HTMLElement;
  private readonly notice: MatchTypeNotice;
  private readonly gridEl: HTMLElement;
  private readonly closeBtn: HTMLButtonElement;

  private readonly accountPanel: AccountPanel | null;
  private readonly tabsEl: HTMLElement;
  private readonly overviewWrap: HTMLElement;
  private readonly loadoutWrap: HTMLElement;
  private readonly tradeWrap: HTMLElement;
  private readonly competitionsWrap: HTMLElement;
  private loadoutTab: LoadoutTab | null = null;
  private tradeTab: TradeTab | null = null;
  private competitionsTab: CompetitionsTab | null = null;
  private tabButtons = new Map<string, HTMLButtonElement>();
  private opened = false;
  private destroyed = false;
  private last: ProfileView | null = null;

  constructor(opts: ProfileScreenOptions) {
    this.opts = opts;
    ensureStyle();

    this.element = el('div', 'dcp');
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'true');
    this.element.setAttribute('aria-label', 'Player profile');

    const shell = el('div', 'dcp-shell');
    this.element.appendChild(shell);

    /* ---- header ---- */
    const head = el('div', 'dcp-head');
    const titles = el('div', 'dcp-titles');
    this.nameEl = el('h2');
    this.sinceEl = el('p', 'dcp-since');
    this.sourceEl = el('p', 'dcp-source');
    titles.append(this.nameEl, this.sinceEl, this.sourceEl);
    head.appendChild(titles);

    this.lookEl = el('div', 'dcp-look');
    this.lookTint = el('i');
    this.lookAccent = el('i');
    this.lookName = el('span');
    this.lookEl.append(el('span', 'dcp-cap', 'Look'), this.lookTint, this.lookAccent, this.lookName);
    this.lookEl.setAttribute('title', 'Change it in the Locker');
    head.appendChild(this.lookEl);

    this.closeBtn = el('button', 'dcp-x', '✕');
    this.closeBtn.type = 'button';
    this.closeBtn.setAttribute('aria-label', 'Close profile');
    this.closeBtn.addEventListener('click', (e) => { e.preventDefault(); this.close(); });
    head.appendChild(this.closeBtn);
    shell.appendChild(head);

    /* ---- the tab strip — hidden until the flags probe grants a tab ---- */
    this.tabsEl = el('div', 'dcp-tabs');
    this.tabsEl.setAttribute('role', 'tablist');
    shell.appendChild(this.tabsEl);
    this.overviewWrap = el('div', 'dcp-tabwrap is-on');
    this.loadoutWrap = el('div', 'dcp-tabwrap');
    this.tradeWrap = el('div', 'dcp-tabwrap');
    this.competitionsWrap = el('div', 'dcp-tabwrap');

    /* ---- tiles ---- */
    this.tilesEl = el('div', 'dcp-tiles');
    this.overviewWrap.appendChild(this.tilesEl);

    /* ---- level ---- */
    const level = el('div', 'dcp-level');
    const top = el('div', 'dcp-level-top');
    this.levelTop = el('span');
    this.levelXp = el('span');
    top.append(this.levelTop, this.levelXp);
    const track = el('div', 'dcp-track');
    this.fillEl = el('div', 'dcp-fill');
    track.appendChild(this.fillEl);
    level.append(top, track);
    this.overviewWrap.appendChild(level);

    /* ---- what a match is worth: `matchType.ts`, which decides nothing ---- */
    this.worthEl = el('div', 'dcp-worth');
    this.worthHead = el('h3');
    this.worthEl.appendChild(this.worthHead);
    // Seeded from the same model field it is repainted from, so there is never
    // a first frame showing a mode the player did not last play.
    const seed = buildProfileView(opts.inputs());
    this.notice = new MatchTypeNotice(seed.worth.modeId, seed.worth.matchType);
    this.worthEl.appendChild(this.notice.element);
    this.overviewWrap.appendChild(this.worthEl);

    /* ---- the account panel (C4) — interactive, so not a model panel ---- */
    this.accountPanel = opts.account === undefined ? null : createAccountPanel(opts.account);
    if (this.accountPanel !== null) this.overviewWrap.appendChild(this.accountPanel.element);

    /* ---- share (S36) — hidden until the probe grants share_cards ---- */
    if (opts.account !== undefined) {
      const shareBox = el('div', 'dcp-panel');
      shareBox.style.display = 'none';
      shareBox.appendChild(el('h3', undefined, 'Share'));
      shareBox.appendChild(el('p', 'dcp-caveat',
        'Your last paying round as a card, rendered by the server with your referral code on it.'));
      const share = createMatchShareButton('dcp-share');
      if (share !== null) {
        shareBox.appendChild(share.element);
        share.element.style.display = '';
        const acc = opts.account;
        void probeServerFlags(acc.serverBase, acc.deviceId()).then((flags) => {
          if (!this.destroyed && flags?.share_cards === true) shareBox.style.display = '';
        });
      }
      this.overviewWrap.appendChild(shareBox);
    }

    /* ---- panels ---- */
    this.gridEl = el('div', 'dcp-grid');
    this.overviewWrap.appendChild(this.gridEl);

    shell.appendChild(this.overviewWrap);
    shell.appendChild(this.loadoutWrap);
    shell.appendChild(this.tradeWrap);
    shell.appendChild(this.competitionsWrap);

    /* ---- the economy tabs — the server's flag probe decides existence ----
     * Async on purpose: the overlay is complete without an answer, and a
     * host with every flag dark (or the static build, where the probe finds
     * no server) never shows a strip at all. */
    if (opts.account !== undefined) void this.initEconomyTabs(opts.account);

    /* ---- footer ---- */
    const foot = el('div', 'dcp-foot');
    foot.appendChild(el(
      'p', undefined,
      'Everything above is read from this browser unless a line says otherwise.',
    ));
    const done = el('button', 'dc-primary dcp-done', 'Done');
    done.type = 'button';
    done.addEventListener('click', (e) => { e.preventDefault(); this.close(); });
    foot.appendChild(done);
    shell.appendChild(foot);

    opts.root.appendChild(this.element);
    this.paint(seed);
  }

  get isOpen(): boolean { return this.opened; }

  /** The view last painted. The harness reads it; nothing else should. */
  get view(): ProfileView | null { return this.last; }

  /** The visible tab id. The harness reads it; nothing else should. */
  get tab(): 'overview' | 'loadout' | 'trade' | 'competitions' {
    if (this.loadoutWrap.classList.contains('is-on')) return 'loadout';
    if (this.tradeWrap.classList.contains('is-on')) return 'trade';
    if (this.competitionsWrap.classList.contains('is-on')) return 'competitions';
    return 'overview';
  }

  /**
   * Build the strip only when the server grants at least one tab. One probe
   * per page (`probeServerFlags` caches), so reopening the overlay is free.
   */
  private async initEconomyTabs(account: AccountPanelOptions): Promise<void> {
    const tabs = await economyTabs(account.serverBase, account.deviceId());
    if (this.destroyed || tabs.length === 0) return;
    if (tabs.includes('loadout')) {
      this.loadoutTab = createLoadoutTab({
        serverBase: account.serverBase,
        deviceId: account.deviceId,
        /* NOT `inputs().economyProduct`: that is `game.economyProduct`, a
         * snapshot taken at Game construction, and on the MENU the only
         * session is the local Worker whose flag bridge writes
         * `economy: false` — so both the snapshot AND a live `isEnabled`
         * answer false here forever, and the balance this tab fetches FROM
         * the server would hide behind a gate the server cannot open. On
         * this surface the player's EXPLICIT toggle still wins both ways;
         * absent one, the server's own `economy_scrap` flag (the probe,
         * ANDed inside the tab) is the whole answer. The HUD keeps its
         * stricter snapshot on purpose — nothing may appear mid-match. */
        product: () => (hasOverride(Feature.ECONOMY) ? isEnabled(Feature.ECONOMY) : true),
      });
      this.loadoutWrap.appendChild(this.loadoutTab.element);
    }
    if (tabs.includes('trade')) {
      this.tradeTab = createTradeTab({
        serverBase: account.serverBase,
        deviceId: account.deviceId,
      });
      this.tradeWrap.appendChild(this.tradeTab.element);
    }
    if (tabs.includes('competitions')) {
      this.competitionsTab = createCompetitionsTab({
        serverBase: account.serverBase,
        deviceId: account.deviceId,
      });
      this.competitionsWrap.appendChild(this.competitionsTab.element);
    }
    const add = (id: 'overview' | 'loadout' | 'trade' | 'competitions', label: string): void => {
      const b = el('button', 'dcp-tab', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', id === 'overview' ? 'true' : 'false');
      b.addEventListener('click', (e) => { e.preventDefault(); this.showTab(id); });
      this.tabButtons.set(id, b);
      this.tabsEl.appendChild(b);
    };
    add('overview', 'Overview');
    if (this.loadoutTab !== null) add('loadout', 'Loadout');
    if (this.tradeTab !== null) add('trade', 'Trade');
    if (this.competitionsTab !== null) add('competitions', 'Competitions');
    this.tabsEl.classList.add('is-shown');
  }

  showTab(id: 'overview' | 'loadout' | 'trade' | 'competitions'): void {
    if (this.destroyed) return;
    const target = id === 'loadout' && this.loadoutTab !== null ? 'loadout'
      : id === 'trade' && this.tradeTab !== null ? 'trade'
      : id === 'competitions' && this.competitionsTab !== null ? 'competitions' : 'overview';
    // The trade tab polls while visible; leaving it MUST stop the poll.
    if (target !== 'trade') this.tradeTab?.hidden();
    for (const [wrap, on] of [
      [this.overviewWrap, target === 'overview'],
      [this.loadoutWrap, target === 'loadout'],
      [this.tradeWrap, target === 'trade'],
      [this.competitionsWrap, target === 'competitions'],
    ] as const) {
      if (on) wrap.classList.add('is-on'); else wrap.classList.remove('is-on');
    }
    for (const [tabId, b] of this.tabButtons) {
      b.setAttribute('aria-selected', tabId === target ? 'true' : 'false');
    }
    if (target === 'loadout') void this.loadoutTab?.refresh();
    if (target === 'trade') void this.tradeTab?.shown();
    if (target === 'competitions') void this.competitionsTab?.refresh();
  }

  open(): void {
    if (this.opened || this.destroyed) return;
    this.opened = true;
    this.showTab('overview');
    this.paint(buildProfileView(this.opts.inputs()));
    void this.accountPanel?.refresh();
    this.element.classList.add('is-open');
    this.element.scrollTop = 0;
    this.closeBtn.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.tradeTab?.hidden(); // the poll must not outlive the overlay
    this.element.classList.remove('is-open');
    this.opts.onClose?.();
  }

  toggle(): void { if (this.opened) this.close(); else this.open(); }

  /** Repaint in place. Cheap; the whole view is ~40 rows of text. */
  refresh(): void {
    if (this.destroyed) return;
    this.paint(buildProfileView(this.opts.inputs()));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.opened = false;
    this.element.classList.remove('is-open');
    this.notice.destroy();
    this.accountPanel?.destroy();
    this.loadoutTab?.destroy();
    this.tradeTab?.destroy();
    this.competitionsTab?.destroy();
    this.element.remove();
    releaseStyle();
  }

  /* -------------------------------------------------------------------- *
   * Painting — no decisions, only placement
   * -------------------------------------------------------------------- */

  private paint(v: ProfileView): void {
    this.last = v;

    this.nameEl.replaceChildren();
    this.nameEl.append(document.createTextNode(v.name), el('span', undefined, ' · PROFILE'));
    this.sinceEl.textContent = v.since;
    this.sourceEl.textContent = v.sourceNote;

    const cfg = unpackAvatar(v.avatarPacked);
    this.lookTint.style.background = hexCss(AVATAR_PALETTE[cfg.tint]?.hex ?? 0xffffff);
    this.lookAccent.style.background = hexCss(AVATAR_PALETTE[cfg.accent]?.hex ?? 0xffffff);
    this.lookName.textContent = avatarLabel(cfg);

    this.tilesEl.replaceChildren();
    for (const t of v.tiles) {
      const tile = el('div', 'dcp-tile');
      tile.append(
        el('b', undefined, t.value),
        el('em', undefined, t.label),
        el('small', undefined, t.hint),
      );
      this.tilesEl.appendChild(tile);
    }

    this.levelTop.textContent = `Level ${v.level}`;
    this.levelXp.textContent = v.xpForLevel === 0
      ? 'level cap'
      : `${v.xpIntoLevel} / ${v.xpForLevel} XP`;
    this.fillEl.style.width = `${Math.round(v.levelFraction * 1000) / 10}%`;

    this.worthHead.textContent = v.worth.heading;
    this.notice.update(v.worth.modeId, v.worth.matchType);

    this.gridEl.replaceChildren();
    for (const p of v.panels) this.gridEl.appendChild(this.panelEl(p));
  }

  private panelEl(p: ProfilePanel): HTMLElement {
    const box = el('div', 'dcp-panel');
    box.appendChild(el('h3', undefined, p.title));
    for (const r of p.rows) {
      const line = el('div', r.dim ? 'dcp-line is-dim' : 'dcp-line');
      line.append(el('b', undefined, r.left), el('span', undefined, r.right));
      box.appendChild(line);
    }
    if (p.caveat !== '') box.appendChild(el('p', 'dcp-caveat', p.caveat));
    return box;
  }
}

export function createProfileScreen(opts: ProfileScreenOptions): ProfileScreen {
  return new ProfileScreen(opts);
}
