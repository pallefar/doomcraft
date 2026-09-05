/**
 * DOOMCRAFT — Deathmatch killfeed and kill confirmation.
 *
 * What the bar does (ref/voxiom/desktop-08-combat.png, and the text dump in
 * ref/voxiom/desktop-uitext.txt): kills land in the same bottom-left panel as
 * chat, joins and tips, as plain 12 px text on a translucent slab —
 * "Soldier#001 joined the battle" sitting one line above whatever killed you.
 * There is no weapon in the line, no emphasis when *you* are the one who died,
 * and — this is the real gap — **no kill confirmation at all**. You shoot
 * somebody, they stop moving, and the game says nothing. The only feedback in
 * the whole capture is a static white plus that never twitches.
 *
 * So this module does two jobs the bar does neither of:
 *
 *   1. **A killfeed you can parse at a glance.** Its own column, top-right,
 *      away from chat. Killer, a real weapon glyph, victim. Your own kills and
 *      your own death are styled so you find them without reading. Headshots,
 *      melee, suicides and demon maulings each read differently. Everything is
 *      drawn with an opaque backing plate and a text shadow, because the bar's
 *      low-contrast overlay vanishes against bright terrain (weakness #10).
 *   2. **A kill confirmation that actually lands.** A frag punches a chip up
 *      over the crosshair with the victim's name, a rising "+1", and the
 *      multi-kill / streak callout when one is due. It is CSS-animated, so the
 *      confirmation costs the compositor and not the frame budget.
 *
 * Performance contract: `update()` is the only per-frame call and it touches at
 * most `maxRows + POOL` elements, comparing two numbers each. Rows are pooled
 * and recycled; nothing here allocates once the pool is warm, and no layout is
 * read back (no `offsetWidth`, no `getBoundingClientRect`).
 */

import { KILL_ENVIRONMENT, KILL_HEADSHOT, KILL_MELEE, KILL_SELF } from '@shared/protocol';
import { WEAPON_COUNT, WeaponId, weaponName } from '@shared/weapons';

/* ------------------------------------------------------------------------ *
 * Weapon glyphs
 *
 * Seven silhouettes on a 24x12 grid, inline so they cost no request, no
 * decode and no layout shift, and stay crisp at any DPI. The bar puts no
 * weapon in its feed at all, so any legible glyph is already ahead; these are
 * shaped closely enough that the shotgun and the chaingun are told apart at a
 * glance, which is the whole point of an icon.
 * ------------------------------------------------------------------------ */

const WEAPON_PATHS: readonly string[] = Object.freeze([
  // PISTOL — short slide over a grip
  'M3 3h11v3H9l-1 4H5l1-4H3z',
  // SHOTGUN — long barrel, pump under it
  'M1 4h20v2.4H1zM7 6.8h7v2H7zM1 3h3v4H1z',
  // CHAINGUN — three barrels and a housing
  'M2 2.6h6v6.8H2zM8 3.2h13v1.6H8zM8 5.6h13v1.6H8zM8 8h13v1.6H8z',
  // ROCKET LAUNCHER — tube, warhead, fin
  'M2 4h15v4H2zM17 3.2l5 2.8-5 2.8zM4 8h3l-1.4 3H2.6z',
  // PLASMA RIFLE — tube with a coil stack
  'M2 4.2h17v3.6H2zM5 2.6h1.6v6.8H5zM8.4 2.6H10v6.8H8.4zM11.8 2.6h1.6v6.8h-1.6z',
  // BFG 9000 — chunky body, wide muzzle
  'M2 3.4h13v5.2H2zM15 2h4v8h-4zM19 4h3v4h-3zM4 9h4l-1 2.6H4.4z',
  // CHAINSAW — bar with teeth
  'M1 3.4h6v5.2H1zM7 4.4h15v3.2H7zM8 2.8h1.6v1.6H8zM11 2.8h1.6v1.6H11zM14 2.8h1.6v1.6H14zM17 2.8h1.6v1.6H17z',
]);

/** A world/hazard kill has no weapon: a flame. */
const HAZARD_PATH = 'M12 1c2 3-1 4 0 6 1-1 1-2 2-3 2 2 3 4 3 5a5 5 0 0 1-10 0c0-2 2-4 5-8z';
/** A demon did it: horns. */
const DEMON_PATH = 'M4 2l3 4h10l3-4 1 6a9 5 0 0 1-18 0zM8 8h2v2H8zM14 8h2v2h-2z';

function glyphPath(weaponId: number, flags: number): string {
  if ((flags & KILL_ENVIRONMENT) !== 0) return weaponId === 0 ? DEMON_PATH : HAZARD_PATH;
  if (weaponId >= 0 && weaponId < WEAPON_COUNT) return WEAPON_PATHS[weaponId];
  return WEAPON_PATHS[WeaponId.PISTOL];
}

function svgGlyph(weaponId: number, flags: number): string {
  return `<svg viewBox="0 0 24 12" aria-hidden="true"><path d="${glyphPath(weaponId, flags)}"/></svg>`;
}

/* ------------------------------------------------------------------------ *
 * Callouts
 * ------------------------------------------------------------------------ */

/** Kills inside this window chain into a multi-kill. Quake's number. */
export const MULTI_KILL_WINDOW_MS = 3000;

/** Multi-kill names, index = chain length - 2. */
export const MULTI_KILL_NAMES: readonly string[] = Object.freeze([
  'DOUBLE KILL', 'TRIPLE KILL', 'MULTI KILL', 'ULTRA KILL', 'MONSTER KILL',
]);

/** Streak milestones: [frags, name]. Checked from the top down. */
export const STREAK_MILESTONES: ReadonlyArray<readonly [number, string]> = Object.freeze([
  [25, 'GODLIKE'],
  [20, 'UNSTOPPABLE'],
  [15, 'DOMINATING'],
  [10, 'RAMPAGE'],
  [5, 'KILLING SPREE'],
]);

function streakName(streak: number): string {
  for (let i = 0; i < STREAK_MILESTONES.length; i++) {
    if (streak === STREAK_MILESTONES[i][0]) return STREAK_MILESTONES[i][1];
  }
  return '';
}

/* ------------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------------ */

const STYLE_ID = 'dm-killfeed-css';

const CSS = `
/* The inset is deliberately larger than the slide-in distance below, so a row
   entering from the right is never clipped by the window edge mid-animation. */
#hud .dm-kf{position:absolute;top:var(--dm-kf-top,12px);right:18px;width:min(340px,42vw);
  display:flex;flex-direction:column;align-items:flex-end;gap:4px;
  font:12px/1.1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;pointer-events:none;
  contain:layout style}
#hud .dm-kf .row{display:flex;align-items:center;gap:7px;max-width:100%;
  padding:4px 8px 4px 9px;border-radius:var(--dc-r);
  background:var(--dc-plate);border:1px solid var(--dc-line);
  border-right:3px solid #4a4a55;
  box-shadow:0 2px 10px rgba(0,0,0,.55);
  text-shadow:0 1px 2px rgba(0,0,0,.95);
  opacity:1;transform:translateX(0);
  transition:opacity .28s linear,transform .28s cubic-bezier(.2,.7,.3,1)}
#hud .dm-kf .row.in{animation:dmkfin .22s cubic-bezier(.2,.9,.3,1) both}
#hud .dm-kf .row.out{opacity:0;transform:translateX(12px)}
@keyframes dmkfin{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:translateX(0)}}

#hud .dm-kf .who{max-width:118px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-weight:700;letter-spacing:.01em;color:#cfc9c3}
#hud .dm-kf .who.me{color:#f0a020}
#hud .dm-kf .who.bot{color:#9b9793;font-weight:600}
#hud .dm-kf .who.dead{color:#e8e6e3}
#hud .dm-kf .row.mine{border-right-color:#f0a020;background:rgba(30,20,6,.9)}
#hud .dm-kf .row.death{border-right-color:#e03c1c;background:rgba(34,9,6,.92)}
#hud .dm-kf .row.death .who.victim{color:#ff7a5a}

#hud .dm-kf .gun{display:flex;align-items:center;gap:4px;flex:0 0 auto;
  padding:2px 5px;border-radius:2px;background:rgba(255,255,255,.07)}
#hud .dm-kf .gun svg{width:24px;height:12px;display:block;fill:currentColor;color:#d8d2cc}
#hud .dm-kf .row.mine .gun svg{color:#ffc857}
#hud .dm-kf .row.death .gun svg{color:#ff8a68}
#hud .dm-kf .tag{font-size:9px;letter-spacing:.1em;font-weight:700;color:#0a0a0d;
  background:#e03c1c;border-radius:2px;padding:1px 3px;text-shadow:none}
#hud .dm-kf .tag.hs{background:#f0a020}
#hud .dm-kf .tag.saw{background:#c03020;color:#f6e3c8}
#hud .dm-kf .note{color:#8a8078;font-weight:600;letter-spacing:.06em}

/* ---- the confirmation, over the crosshair ---- */
#hud .dm-conf{position:absolute;left:50%;top:50%;width:0;height:0;pointer-events:none;
  font:700 13px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
#hud .dm-conf .chip{position:absolute;left:0;top:-96px;transform:translate(-50%,0);
  display:flex;align-items:center;gap:6px;white-space:nowrap;
  padding:4px 10px;border-radius:var(--dc-r);
  background:rgba(14,6,4,.9);border:1px solid rgba(240,160,32,.55);
  color:#ffd98a;text-shadow:0 1px 3px rgba(0,0,0,.9);
  box-shadow:0 0 18px rgba(224,60,28,.28);
  opacity:0;animation:dmconf 1100ms cubic-bezier(.16,.9,.3,1) forwards}
#hud .dm-conf .chip svg{width:22px;height:11px;fill:#ffb347}
#hud .dm-conf .chip b{color:#fff2dc;font-weight:800;letter-spacing:.02em;
  max-width:150px;overflow:hidden;text-overflow:ellipsis}
#hud .dm-conf .chip i{font-style:normal;color:#e03c1c;font-weight:800}
@keyframes dmconf{
  0%{opacity:0;transform:translate(-50%,10px) scale(.86)}
  14%{opacity:1;transform:translate(-50%,0) scale(1.06)}
  26%{transform:translate(-50%,0) scale(1)}
  72%{opacity:1;transform:translate(-50%,-6px) scale(1)}
  100%{opacity:0;transform:translate(-50%,-22px) scale(1)}
}
#hud .dm-conf .plus{position:absolute;left:0;top:-58px;transform:translate(-50%,0);
  font:800 19px/1 "Arial Black",Impact,system-ui,sans-serif;color:#ffd05a;
  text-shadow:0 2px 0 #4a1005,0 4px 14px rgba(0,0,0,.8);
  opacity:0;animation:dmplus 900ms cubic-bezier(.16,.9,.3,1) forwards}
@keyframes dmplus{
  0%{opacity:0;transform:translate(-50%,14px) scale(.7)}
  18%{opacity:1;transform:translate(-50%,0) scale(1.15)}
  30%{transform:translate(-50%,-2px) scale(1)}
  100%{opacity:0;transform:translate(-50%,-40px) scale(1)}
}
#hud .dm-conf .burst{position:absolute;left:0;top:0;width:52px;height:52px;margin:-26px 0 0 -26px;
  border:2px solid rgba(240,160,32,.9);transform:rotate(45deg) scale(.4);opacity:0;
  animation:dmburst 340ms ease-out forwards}
@keyframes dmburst{
  0%{opacity:.95;transform:rotate(45deg) scale(.34)}
  100%{opacity:0;transform:rotate(45deg) scale(1.15)}
}
#hud .dm-conf .call{position:absolute;left:0;top:-146px;transform:translate(-50%,0);
  font:900 clamp(15px,2.2vw,23px)/1 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.14em;color:#ffe3a8;white-space:nowrap;
  text-shadow:0 2px 0 #7a1a08,0 5px 20px rgba(224,60,28,.6);
  opacity:0;animation:dmcall 1500ms cubic-bezier(.16,.9,.3,1) forwards}
@keyframes dmcall{
  0%{opacity:0;transform:translate(-50%,0) scale(.7)}
  10%{opacity:1;transform:translate(-50%,0) scale(1.12)}
  20%{transform:translate(-50%,0) scale(1)}
  78%{opacity:1}
  100%{opacity:0;transform:translate(-50%,-14px) scale(1)}
}

/* The desktop FPS read-out sits in the top-right and would land under the
   first row. Applied as a class, not an inline style, so the compact rules
   below still win — an inline top would pin the feed over the chat lane on a
   phone, which is the exact bug this file's layout is trying to avoid. */
#hud .dm-kf.fps{--dm-kf-top:58px}

/* ---- compact: 412px-tall phones. The bar ships its desktop feed here
       unchanged (weakness #11); this one halves and moves off the thumb. ---- */
#hud[data-compact="1"] .dm-kf{--dm-kf-top:8px;right:14px;width:min(230px,52vw);gap:3px;font-size:10px}
#hud[data-compact="1"] .dm-kf .row{padding:2px 6px 2px 7px;gap:5px}
#hud[data-compact="1"] .dm-kf .who{max-width:74px}
#hud[data-compact="1"] .dm-kf .gun svg{width:18px;height:9px}
#hud[data-compact="1"] .dm-conf .chip{top:-64px;font-size:11px}
#hud[data-compact="1"] .dm-conf .plus{top:-40px;font-size:15px}
#hud[data-compact="1"] .dm-conf .call{top:-96px}
/* Portrait is 412 px WIDE, and the base HUD's chat lane already owns
   x=116..366 at the top. Two right-aligned panels on one row would overlap, so
   the killfeed drops to the row below the chat lane; the chip column under the
   minimap ends at x=112, so nothing meets it there either. */
#hud[data-portrait="1"] .dm-kf{--dm-kf-top:124px;right:10px;width:min(200px,52vw)}
#hud[data-portrait="1"] .dm-conf .chip{top:-108px}
#hud[data-portrait="1"] .dm-conf .call{top:-152px}

@media (prefers-reduced-motion:reduce){
  #hud .dm-kf .row.in{animation:none}
  #hud .dm-conf .chip,#hud .dm-conf .plus,#hud .dm-conf .call{animation-duration:1ms}
  #hud .dm-conf .burst{display:none}
}
`;

let styleNode: HTMLStyleElement | null = null;
let styleRefs = 0;

function retainStyle(): void {
  styleRefs++;
  if (styleNode !== null) return;
  const existing = document.getElementById(STYLE_ID);
  if (existing instanceof HTMLStyleElement) { styleNode = existing; return; }
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
  styleNode = el;
}

function releaseStyle(): void {
  styleRefs = Math.max(0, styleRefs - 1);
  if (styleRefs > 0 || styleNode === null) return;
  styleNode.remove();
  styleNode = null;
}

/* ------------------------------------------------------------------------ *
 * Killfeed
 * ------------------------------------------------------------------------ */

export interface KillfeedOptions {
  /** `#hud`. The feed is never interactive. */
  root: HTMLElement;
  /** Entity id of the local player, read fresh each time (it changes on join). */
  localId: () => number;
  /** Display name for an id. `0` should map to the world/demons. */
  nameOf: (id: number) => string;
  /** True when this id is a bot, so the feed can grey it. */
  isBot?: (id: number) => boolean;
  /**
   * What to CALL the gun a shot was fired with (V4d).
   *
   * Injected rather than imported, because the answer depends on the table
   * THIS ROOM pinned and this module must not reach for a live or compiled
   * one. Absent = the archetype's name, which is what this feed said before
   * variants existed and what it still says when the names message never
   * arrives.
   */
  weaponLabel?: (weaponId: number, variantSlot: number) => string;
  maxRows?: number;
  /** How long a row stays before it fades. */
  rowLifeMs?: number;
}

/** Exactly the fields `S2C.KILL` carries, so a decoded packet is passable as-is. */
export interface KillfeedEvent {
  killerId: number;
  victimId: number;
  weaponId: number;
  flags: number;
  killerStreak: number;
  /** The variant slot the killing shot was FIRED with; 0 is the base (V4d). */
  variantSlot: number;
}

interface Row {
  el: HTMLElement;
  killer: HTMLElement;
  gun: HTMLElement;
  victim: HTMLElement;
  tag: HTMLElement;
  /** Wall clock at which the row starts fading. 0 = free. */
  expiresAtMs: number;
  fading: boolean;
  /** Cached text so a repeat write is skipped. */
  lastKiller: string;
  lastVictim: string;
  lastWeapon: number;
  lastFlags: number;
}

const DEFAULT_MAX_ROWS = 5;
const DEFAULT_ROW_LIFE_MS = 6000;
const FADE_MS = 300;
/** Confirmation nodes kept alive and recycled. */
const CONFIRM_POOL = 4;

export class Killfeed {
  readonly element: HTMLElement;
  /** Frags confirmed since construction. The mode reports it as telemetry. */
  confirmations = 0;

  private readonly opts: Required<Pick<KillfeedOptions, 'maxRows' | 'rowLifeMs'>> & KillfeedOptions;
  private readonly rows: Row[] = [];
  private readonly confirmRoot: HTMLElement;
  private readonly confirmPool: HTMLElement[] = [];
  private confirmCursor = 0;
  private destroyed = false;

  /** Multi-kill chain state. */
  private chain = 0;
  private chainEndsAtMs = 0;

  constructor(options: KillfeedOptions) {
    retainStyle();
    this.opts = {
      maxRows: DEFAULT_MAX_ROWS,
      rowLifeMs: DEFAULT_ROW_LIFE_MS,
      ...options,
    };

    this.element = document.createElement('div');
    this.element.className = 'dm-kf';
    options.root.appendChild(this.element);

    this.confirmRoot = document.createElement('div');
    this.confirmRoot.className = 'dm-conf';
    options.root.appendChild(this.confirmRoot);
    for (let i = 0; i < CONFIRM_POOL; i++) {
      const n = document.createElement('div');
      n.style.display = 'none';
      this.confirmRoot.appendChild(n);
      this.confirmPool.push(n);
    }

    for (let i = 0; i < this.opts.maxRows; i++) this.rows.push(this.makeRow());
  }

  /* ---------------------------------------------------------------- *
   * Feed
   * ---------------------------------------------------------------- */

  /**
   * Record a kill. Returns true when the local player was the killer, so the
   * caller knows a confirmation fired.
   */
  push(e: KillfeedEvent, nowMs: number): boolean {
    if (this.destroyed) return false;
    const me = this.opts.localId();
    const suicide = (e.flags & KILL_SELF) !== 0 || (e.killerId === e.victimId && e.killerId !== 0);
    const world = (e.flags & KILL_ENVIRONMENT) !== 0 || e.killerId === 0;
    const iKilled = !suicide && !world && e.killerId === me && e.victimId !== me;
    const iDied = e.victimId === me;

    const row = this.claimRow(nowMs);
    const killerName = suicide || world ? '' : this.opts.nameOf(e.killerId);
    const victimName = this.opts.nameOf(e.victimId);

    // Killer half. A suicide or a hazard has no killer worth naming; the glyph
    // carries the story instead, which keeps the line short and scannable.
    if (killerName !== row.lastKiller) {
      row.killer.textContent = killerName;
      row.lastKiller = killerName;
    }
    row.killer.style.display = killerName === '' ? 'none' : '';
    row.killer.className = 'who'
      + (e.killerId === me ? ' me' : '')
      + (killerName !== '' && this.opts.isBot?.(e.killerId) === true ? ' bot' : '');

    if (e.weaponId !== row.lastWeapon || e.flags !== row.lastFlags) {
      row.gun.innerHTML = svgGlyph(e.weaponId, e.flags);
      row.lastWeapon = e.weaponId;
      row.lastFlags = e.flags;
    }
    const gunTitle = world
      ? 'Hell'
      : this.opts.weaponLabel?.(e.weaponId, e.variantSlot) ?? weaponName(e.weaponId);
    row.gun.setAttribute('aria-label', gunTitle);

    if (victimName !== row.lastVictim) {
      row.victim.textContent = victimName;
      row.lastVictim = victimName;
    }
    row.victim.className = 'who victim' + (iDied ? ' dead' : '')
      + (this.opts.isBot?.(e.victimId) === true ? ' bot' : '');

    // One badge, chosen by priority: a headshot outranks a saw outranks a fall.
    let tag = '';
    let tagClass = 'tag';
    if ((e.flags & KILL_HEADSHOT) !== 0) { tag = 'HS'; tagClass = 'tag hs'; }
    else if ((e.flags & KILL_MELEE) !== 0) { tag = 'SAW'; tagClass = 'tag saw'; }
    else if (suicide) { tag = 'SELF'; }
    else if (world) { tag = 'HELL'; }
    row.tag.textContent = tag;
    row.tag.className = tagClass;
    row.tag.style.display = tag === '' ? 'none' : '';

    row.el.className = 'row in' + (iKilled ? ' mine' : iDied ? ' death' : '');

    if (iKilled) this.confirmKill(victimName, e.weaponId, e.flags, e.killerStreak, nowMs);
    return iKilled;
  }

  /** A non-kill line in the same column: "X joined", "Round 2". */
  pushNote(text: string, nowMs: number): void {
    if (this.destroyed || text.length === 0) return;
    const row = this.claimRow(nowMs);
    row.killer.style.display = 'none';
    row.gun.innerHTML = '';
    row.tag.style.display = 'none';
    row.victim.textContent = text;
    row.lastVictim = text;
    row.victim.className = 'who note';
    row.el.className = 'row in';
  }

  /* ---------------------------------------------------------------- *
   * Confirmation
   * ---------------------------------------------------------------- */

  /**
   * The thing the bar has none of: unmissable, centred, and gone in a second.
   * A frag gets a diamond burst on the crosshair, a chip naming who you just
   * removed, a rising "+1", and — when one is due — the multi-kill or streak
   * callout above it.
   */
  confirmKill(
    victimName: string, weaponId: number, flags: number, streak: number, nowMs: number,
  ): void {
    if (this.destroyed) return;
    this.confirmations++;

    this.chain = nowMs < this.chainEndsAtMs ? this.chain + 1 : 1;
    this.chainEndsAtMs = nowMs + MULTI_KILL_WINDOW_MS;

    const headshot = (flags & KILL_HEADSHOT) !== 0;
    const node = this.nextConfirm();
    const call = this.chain >= 2
      ? MULTI_KILL_NAMES[Math.min(this.chain - 2, MULTI_KILL_NAMES.length - 1)]
      : streakName(streak);

    node.innerHTML =
      '<div class="burst"></div>'
      + `<div class="chip">${svgGlyph(weaponId, flags)}<b>${escapeHtml(victimName)}</b>`
      + (headshot ? '<i>HEADSHOT</i>' : '') + '</div>'
      + `<div class="plus">+1</div>`
      + (call !== '' ? `<div class="call">${escapeHtml(call)}</div>` : '');
    // Restart the CSS animations on a recycled node: display:none -> reflow-free
    // re-add is enough because the node's children are brand new every time.
    node.style.display = '';
  }

  /**
   * You died. There is deliberately no centre-screen chip here: the mode's
   * death card owns that space and says the same thing with more in it, and two
   * overlapping banners on the frame you die is worse than one.
   * Dying breaks the multi-kill chain, which is the whole job of this call.
   */
  confirmDeath(): void {
    this.chain = 0;
    this.chainEndsAtMs = 0;
  }

  /* ---------------------------------------------------------------- *
   * Frame
   * ---------------------------------------------------------------- */

  /** Expire rows. The only per-frame work: `maxRows` number comparisons. */
  update(nowMs: number): void {
    if (this.destroyed) return;
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (r.expiresAtMs === 0) continue;
      if (!r.fading && nowMs >= r.expiresAtMs) {
        r.fading = true;
        r.el.classList.remove('in');
        r.el.classList.add('out');
      } else if (r.fading && nowMs >= r.expiresAtMs + FADE_MS) {
        this.freeRow(r);
      }
    }
    if (this.chain !== 0 && nowMs >= this.chainEndsAtMs) this.chain = 0;
  }

  /** Drop everything — a new round, or a mode switch. */
  clear(): void {
    for (let i = 0; i < this.rows.length; i++) this.freeRow(this.rows[i]);
    for (let i = 0; i < this.confirmPool.length; i++) {
      this.confirmPool[i].style.display = 'none';
      this.confirmPool[i].innerHTML = '';
    }
    this.chain = 0;
    this.chainEndsAtMs = 0;
  }

  /** Live rows, for the tests and the debug overlay. */
  get visibleRows(): number {
    let n = 0;
    for (let i = 0; i < this.rows.length; i++) if (this.rows[i].expiresAtMs !== 0) n++;
    return n;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.element.remove();
    this.confirmRoot.remove();
    this.rows.length = 0;
    this.confirmPool.length = 0;
    releaseStyle();
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private makeRow(): Row {
    const el = document.createElement('div');
    el.className = 'row';
    el.style.display = 'none';

    const killer = document.createElement('span');
    killer.className = 'who';
    const gun = document.createElement('span');
    gun.className = 'gun';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.style.display = 'none';
    const victim = document.createElement('span');
    victim.className = 'who victim';

    el.append(killer, gun, tag, victim);
    this.element.appendChild(el);
    return {
      el, killer, gun, victim, tag,
      expiresAtMs: 0, fading: false,
      lastKiller: '', lastVictim: '', lastWeapon: -1, lastFlags: -1,
    };
  }

  /**
   * The oldest row is recycled when every row is busy, so the feed is a fixed
   * five DOM nodes for the life of the match however many people are dying.
   */
  private claimRow(nowMs: number): Row {
    let target: Row | null = null;
    let oldest = Infinity;
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i];
      if (r.expiresAtMs === 0) { target = r; break; }
      if (r.expiresAtMs < oldest) { oldest = r.expiresAtMs; target = r; }
    }
    const row = target as Row;
    row.expiresAtMs = nowMs + this.opts.rowLifeMs;
    row.fading = false;
    row.el.style.display = '';
    row.el.classList.remove('out');
    // Newest at the top: move the claimed row to the front of the column.
    if (this.element.firstChild !== row.el) this.element.insertBefore(row.el, this.element.firstChild);
    return row;
  }

  private freeRow(r: Row): void {
    r.expiresAtMs = 0;
    r.fading = false;
    r.el.className = 'row';
    r.el.style.display = 'none';
  }

  private nextConfirm(): HTMLElement {
    const node = this.confirmPool[this.confirmCursor];
    this.confirmCursor = (this.confirmCursor + 1) % this.confirmPool.length;
    node.style.display = 'none';
    return node;
  }
}

/** Names come off the wire. They are text, never markup. */
export function escapeHtml(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) out += '&amp;';
    else if (c === 60) out += '&lt;';
    else if (c === 62) out += '&gt;';
    else if (c === 34) out += '&quot;';
    else if (c === 39) out += '&#39;';
    else out += s[i];
  }
  return out;
}
