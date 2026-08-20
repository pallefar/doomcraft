/**
 * DOOMCRAFT — Quest HUD additions.
 *
 * This does NOT fork `client/src/hud/hud.ts`. The base HUD already owns health,
 * armour, ammo, the hotbar, the crosshair, the minimap and the kill feed, and it
 * owns all four screen corners. Quest needs four things the base HUD has no
 * concept of — keycards held, the current objective, the kills/items/secrets
 * tally, and Doom's "A secret is revealed!" flash — so it adds exactly those, in
 * the one region the base HUD leaves empty: the top centre.
 *
 * Everything else routes THROUGH the base HUD: log lines go to `Hud.pushFeed`,
 * damage flashes and the crosshair are untouched.
 *
 * COST. Same contract as the base HUD: every node is built once and afterwards
 * only mutated behind a `!==` guard, so a steady frame writes zero DOM and
 * allocates nothing. The only per-frame work is decrementing two fade timers.
 *
 * The stylesheet is injected once and reference counted, so `destroy()` on the
 * last live instance removes it — a mode switch must leave nothing behind.
 */

import { KEY_COLORS, KEY_NAMES, KeyColor, keyBit } from '@shared/modes';

/* ------------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------------ */

const STYLE_ID = 'dc-quest-hud-css';
let styleRefs = 0;

const CSS = `
.dcq-strip{position:absolute;left:50%;top:10px;transform:translateX(-50%);
  display:flex;align-items:center;gap:14px;padding:7px 14px;border-radius:4px;
  background:rgba(10,9,12,.78);border:1px solid rgba(255,255,255,.13);
  box-shadow:0 6px 20px rgba(0,0,0,.55);pointer-events:none;
  font:13px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e8e6e3;
  max-width:min(620px,calc(100vw - 400px));white-space:nowrap}
.dcq-keys{display:flex;gap:5px;align-items:center}
.dcq-key{width:15px;height:20px;border-radius:2px;border:1px solid rgba(255,255,255,.22);
  background:rgba(255,255,255,.05);position:relative;opacity:.3;transition:opacity .18s linear}
.dcq-key::after{content:'';position:absolute;left:2px;right:2px;top:3px;height:2px;
  background:rgba(0,0,0,.45);border-radius:1px}
.dcq-key.have{opacity:1}
.dcq-key.gone{display:none}
.dcq-obj{font:800 13px/1 "Arial Black",Impact,system-ui,sans-serif;letter-spacing:.14em;
  text-transform:uppercase;color:#f0d8a8;text-shadow:0 2px 0 #40120a,0 4px 12px rgba(0,0,0,.8);
  overflow:hidden;text-overflow:ellipsis}
.dcq-obj.open{color:#7ef0a8}
.dcq-tally{display:flex;gap:10px;font-variant-numeric:tabular-nums;font-size:12px;color:#b4aea8}
.dcq-tally b{color:#e8e6e3;font-weight:700}
.dcq-tally i{font-style:normal;opacity:.6;font-size:10px;letter-spacing:.12em}
.dcq-clock{font-variant-numeric:tabular-nums;font-size:12px;color:#8f8a85;
  border-left:1px solid rgba(255,255,255,.14);padding-left:12px}
.dcq-clock.over{color:#e07a4a}

/* The two centre call-outs share one bottom-anchored column so they can never
   land on top of each other, and so a 412px-tall landscape phone does not push
   them into the strip. Anchoring to the crosshair and growing UPWARD is the
   only arrangement where both hold at every viewport with no magic numbers. */
.dcq-centre{position:absolute;left:50%;bottom:50%;transform:translateX(-50%);
  margin-bottom:clamp(52px,11vh,92px);display:flex;flex-direction:column-reverse;
  align-items:center;gap:clamp(8px,1.6vh,16px);pointer-events:none;
  width:min(620px,88vw);text-align:center}
.dcq-centre.hidden{display:none}

.dcq-flash{opacity:0;width:100%}
.dcq-flash .t{font:800 clamp(17px,2.6vw,30px)/1.1 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.06em;color:#ffd76a;text-shadow:0 2px 0 #5a2c00,0 0 26px rgba(255,180,60,.5)}
.dcq-flash .s{margin-top:5px;font:600 12px/1 ui-monospace,Menlo,monospace;
  letter-spacing:.22em;text-transform:uppercase;color:#c9a24a}

.dcq-toast{opacity:0;width:100%;
  font:700 14px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em;
  color:#ffd2c4;text-shadow:0 2px 6px rgba(0,0,0,.9)}
.dcq-toast.lock{color:#ff9c86}

.dcq-banner{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  margin-top:-120px;text-align:center;pointer-events:none;display:none;
  width:min(680px,92vw)}
.dcq-banner.on{display:block}
.dcq-banner .t{font:800 clamp(26px,5vw,52px)/1 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.05em;color:#e03c1c;text-shadow:0 3px 0 #40100a,0 8px 30px rgba(0,0,0,.85)}
.dcq-banner .s{margin-top:10px;font:600 12px/1.4 ui-monospace,Menlo,monospace;
  letter-spacing:.2em;text-transform:uppercase;color:#c9beb6}

/* Short viewports: the strip cannot sit between a 168px minimap and the perf
   read-out, so it drops under the minimap and loses the clock. */
.dcq-strip[data-compact="1"]{left:auto;right:10px;top:8px;transform:none;
  max-width:calc(100vw - 128px);gap:9px;padding:5px 9px;font-size:11px}
.dcq-strip[data-compact="1"] .dcq-obj{font-size:11px;letter-spacing:.08em}
.dcq-strip[data-compact="1"] .dcq-clock{display:none}
.dcq-strip[data-compact="1"] .dcq-key{width:12px;height:16px}
.dcq-strip[data-portrait="1"]{right:auto;left:50%;transform:translateX(-50%);top:6px;
  max-width:calc(100vw - 20px);flex-wrap:nowrap}
.dcq-strip[data-portrait="1"] .dcq-tally i{display:none}
`;

function ensureStyle(): void {
  styleRefs++;
  if (document.getElementById(STYLE_ID) !== null) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

function releaseStyle(): void {
  styleRefs = Math.max(0, styleRefs - 1);
  if (styleRefs > 0) return;
  document.getElementById(STYLE_ID)?.remove();
}

/* ------------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------------ */

export interface QuestHudOptions {
  /** `#hud`. The strip is a sibling of the base HUD's pads. */
  root: HTMLElement;
  /** Bitmask of the keycard colours this level actually uses (`keyBit`). */
  keyMask: number;
  /** Par time in seconds; the clock turns amber past it. 0 disables that. */
  parTimeSec?: number;
}

const FLASH_SECONDS = 2.6;
const TOAST_SECONDS = 2.2;

/* ------------------------------------------------------------------------ *
 * QuestHud
 * ------------------------------------------------------------------------ */

export class QuestHud {
  /** The strip. The caller registers it on its `ModeScope`. */
  readonly element: HTMLElement;
  /** Overlays that must sit at screen centre, not inside the strip. */
  /** Bottom-anchored column above the crosshair holding the two call-outs. */
  readonly centreElement: HTMLElement;
  readonly flashElement: HTMLElement;
  readonly toastElement: HTMLElement;
  readonly bannerElement: HTMLElement;

  private readonly keyPips: HTMLElement[] = [];
  private readonly elObjective: HTMLElement;
  private readonly elKills: HTMLElement;
  private readonly elItems: HTMLElement;
  private readonly elSecrets: HTMLElement;
  private readonly elClock: HTMLElement;
  private readonly elFlashT: HTMLElement;
  private readonly elFlashS: HTMLElement;
  private readonly elBannerT: HTMLElement;
  private readonly elBannerS: HTMLElement;

  private readonly parSec: number;

  /* diff caches — a steady frame must write no DOM */
  private cKeys = -1;
  private cObjective = '';
  private cKills = -1; private cKillsTotal = -1;
  private cItems = -1; private cItemsTotal = -1;
  private cSecrets = -1; private cSecretsTotal = -1;
  private cClock = -1;
  private cOver = false;
  private cExitOpen = false;
  private cCompact = -1;
  private cPortrait = -1;

  private flashT = 0;
  private toastT = 0;
  private disposed = false;

  constructor(opts: QuestHudOptions) {
    ensureStyle();
    this.parSec = Math.max(0, opts.parTimeSec ?? 0);

    /* --- the strip ----------------------------------------------------- */
    const strip = div('dcq-strip');

    const keys = div('dcq-keys');
    for (let c = KeyColor.BLUE; c <= KeyColor.RED; c++) {
      const pip = div('dcq-key');
      pip.style.background = `#${KEY_COLORS[c].toString(16).padStart(6, '0')}`;
      pip.title = `${KEY_NAMES[c]} keycard`;
      if ((opts.keyMask & keyBit(c)) === 0) pip.classList.add('gone');
      keys.appendChild(pip);
      this.keyPips.push(pip);
    }
    strip.appendChild(keys);

    this.elObjective = div('dcq-obj');
    this.elObjective.textContent = 'LOADING';
    strip.appendChild(this.elObjective);

    const tally = div('dcq-tally');
    this.elKills = tallyCell(tally, 'K');
    this.elItems = tallyCell(tally, 'I');
    this.elSecrets = tallyCell(tally, 'S');
    strip.appendChild(tally);

    this.elClock = div('dcq-clock');
    this.elClock.textContent = '0:00';
    strip.appendChild(this.elClock);

    this.element = strip;
    opts.root.appendChild(strip);

    /* --- centre overlays ------------------------------------------------ *
     * `column-reverse`: the toast is first in the DOM and therefore lowest on
     * screen, nearest the crosshair, and the secret sting stacks above it. */
    const centre = div('dcq-centre');

    const toast = div('dcq-toast');
    this.toastElement = toast;
    centre.appendChild(toast);

    const flash = div('dcq-flash');
    this.elFlashT = div('t');
    this.elFlashS = div('s');
    this.elFlashS.textContent = 'SECRET FOUND';
    flash.append(this.elFlashT, this.elFlashS);
    this.flashElement = flash;
    centre.appendChild(flash);

    this.centreElement = centre;
    opts.root.appendChild(centre);

    const banner = div('dcq-banner');
    this.elBannerT = div('t');
    this.elBannerS = div('s');
    banner.append(this.elBannerT, this.elBannerS);
    this.bannerElement = banner;
    opts.root.appendChild(banner);

    this.layout();
  }

  /* -------------------------------------------------------------------- *
   * Setters — each is a no-op when nothing changed
   * -------------------------------------------------------------------- */

  /** Keycard bitmask (`keyBit`). */
  setKeys(mask: number): void {
    if (mask === this.cKeys) return;
    this.cKeys = mask;
    for (let c = KeyColor.BLUE; c <= KeyColor.RED; c++) {
      this.keyPips[c - 1].classList.toggle('have', (mask & keyBit(c)) !== 0);
    }
  }

  /** Which keycards this level contains at all. Others are hidden entirely. */
  setKeyMask(mask: number): void {
    for (let c = KeyColor.BLUE; c <= KeyColor.RED; c++) {
      this.keyPips[c - 1].classList.toggle('gone', (mask & keyBit(c)) === 0);
    }
  }

  setObjective(text: string): void {
    if (text === this.cObjective) return;
    this.cObjective = text;
    this.elObjective.textContent = text;
  }

  /** Green objective text once the exit is live — Doom's "the way is open". */
  setExitOpen(open: boolean): void {
    if (open === this.cExitOpen) return;
    this.cExitOpen = open;
    this.elObjective.classList.toggle('open', open);
  }

  setTally(
    kills: number, killsTotal: number,
    items: number, itemsTotal: number,
    secrets: number, secretsTotal: number,
  ): void {
    if (kills !== this.cKills || killsTotal !== this.cKillsTotal) {
      this.cKills = kills; this.cKillsTotal = killsTotal;
      this.elKills.textContent = `${kills}/${killsTotal}`;
    }
    if (items !== this.cItems || itemsTotal !== this.cItemsTotal) {
      this.cItems = items; this.cItemsTotal = itemsTotal;
      this.elItems.textContent = `${items}/${itemsTotal}`;
    }
    if (secrets !== this.cSecrets || secretsTotal !== this.cSecretsTotal) {
      this.cSecrets = secrets; this.cSecretsTotal = secretsTotal;
      this.elSecrets.textContent = `${secrets}/${secretsTotal}`;
    }
  }

  setTime(seconds: number): void {
    const s = Math.max(0, Math.floor(seconds));
    if (s !== this.cClock) {
      this.cClock = s;
      const m = (s / 60) | 0;
      this.elClock.textContent = `${m}:${String(s - m * 60).padStart(2, '0')}`;
    }
    const over = this.parSec > 0 && s > this.parSec;
    if (over !== this.cOver) {
      this.cOver = over;
      this.elClock.classList.toggle('over', over);
    }
  }

  /* -------------------------------------------------------------------- *
   * One-shots
   * -------------------------------------------------------------------- */

  /** Doom's secret sting. `message` comes from the level file. */
  flashSecret(message: string, found: number, total: number): void {
    this.elFlashT.textContent = message.length > 0 ? message : 'A secret is revealed!';
    this.elFlashS.textContent = `SECRET ${found} OF ${total}`;
    this.flashT = FLASH_SECONDS;
    this.flashElement.style.opacity = '1';
    this.flashElement.style.transform = 'scale(1.04)';
  }

  /** A short line just above the crosshair. `locked` tints it red. */
  toast(text: string, locked = false): void {
    if (text.length === 0) return;
    this.toastElement.textContent = text;
    this.toastElement.classList.toggle('lock', locked);
    this.toastT = TOAST_SECONDS;
    this.toastElement.style.opacity = '1';
  }

  /** Big centred text. Used for death; the intermission owns level completion. */
  banner(title: string, sub: string): void {
    this.elBannerT.textContent = title;
    this.elBannerS.textContent = sub;
    this.bannerElement.classList.add('on');
    // A death banner owns the middle of the screen; a half-faded pickup line
    // underneath it is noise, so the call-out column stands down.
    this.centreElement.classList.add('hidden');
    this.flashT = 0;
    this.toastT = 0;
    this.flashElement.style.opacity = '0';
    this.toastElement.style.opacity = '0';
  }

  clearBanner(): void {
    this.bannerElement.classList.remove('on');
    this.centreElement.classList.remove('hidden');
  }

  /* -------------------------------------------------------------------- *
   * Per-frame — two subtractions and, occasionally, one style write
   * -------------------------------------------------------------------- */

  update(dt: number): void {
    if (this.disposed) return;
    if (this.flashT > 0) {
      this.flashT -= dt;
      const t = this.flashT;
      if (t <= 0) {
        this.flashElement.style.opacity = '0';
      } else if (t < 0.85) {
        this.flashElement.style.opacity = (t / 0.85).toFixed(2);
        this.flashElement.style.transform = `scale(${(1 + t * 0.05).toFixed(3)})`;
      }
    }
    if (this.toastT > 0) {
      this.toastT -= dt;
      const t = this.toastT;
      if (t <= 0) this.toastElement.style.opacity = '0';
      else if (t < 0.7) this.toastElement.style.opacity = (t / 0.7).toFixed(2);
    }
  }

  /** Re-evaluate the compact/portrait variants. Call on resize. */
  layout(width = window.innerWidth, height = window.innerHeight): void {
    const compact = width < 900 || height < 560 ? 1 : 0;
    const portrait = height > width ? 1 : 0;
    if (compact !== this.cCompact) {
      this.cCompact = compact;
      this.element.dataset.compact = String(compact);
    }
    if (portrait !== this.cPortrait) {
      this.cPortrait = portrait;
      this.element.dataset.portrait = String(portrait);
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.element.remove();
    this.centreElement.remove();
    this.bannerElement.remove();
    releaseStyle();
  }
}

/* ------------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------------ */

function div(cls: string): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

function tallyCell(host: HTMLElement, label: string): HTMLElement {
  const wrap = document.createElement('span');
  const i = document.createElement('i');
  i.textContent = label;
  const b = document.createElement('b');
  b.textContent = '0/0';
  wrap.append(i, ' ', b);
  host.appendChild(wrap);
  return b;
}
