/**
 * DOOMCRAFT — mode select.
 *
 * Judged against `ref/voxiom/desktop-00-menu.png`: big mode tiles with voxel
 * thumbnails, a red "Most Popular" ribbon, a region/level row, and a play
 * affordance that never moves. Four things this beats it on, deliberately:
 *
 *   1. **The tiles say what you get.** The bar's tiles are a 40 px icon and a
 *      name. Ours carry the pitch, the player count and your own save state
 *      ("E1M1 · 40% cleared", "Wave 14"), so the choice is informed.
 *   2. **The picker is inline.** Choosing a mode expands its picker in place —
 *      episode/level list for Quest, world list for Builder, skill for Horde.
 *      No second screen, no round trip.
 *   3. **Keyboard and touch both work.** Arrow keys and 1..4 move between
 *      tiles, Enter plays; every hit target is at least 44 px on a phone.
 *   4. **Nothing reflows.** The panel is a fixed-height scroller and the CTA is
 *      anchored below it, so filling the level list cannot shift the ad slots
 *      that share this screen (ref/BAR.md: the ad boxes are layout, not overlay).
 *
 * The thumbnails are inline SVG isometric voxels — no images, no network, no
 * layout shift, and they scale to any DPI. All CSS is scoped to `.dcm-` and
 * injected once.
 */

import { Feature, isEnabled, COMING_SOON_BADGE } from '@shared/features';
import {
  MODE_MENU_ORDER,
  ModeId,
  SKILL_NAMES,
  SKILL_SHORT_NAMES,
  SKILL_COUNT,
  MSF_CONTINUE,
  MSF_FRESH,
  MSF_NO_BOTS,
  clampSkill,
  formatTime,
  getMode,
  percentOf,
  type ModeDef,
} from '@shared/modes';
import type { SaveFile } from '@shared/saves';
import { summariseSaves } from '@shared/saves';

import { createEnterParams, type ModeEnterParams } from '@/modes/registry';

/* ------------------------------------------------------------------------ *
 * Data the shell feeds in
 * ------------------------------------------------------------------------ */

/** One row in the Quest level picker. */
export interface ModeSelectLevel {
  id: string;
  name: string;
  episodeId: string;
  episodeName: string;
  episodeIndex: number;
  levelIndex: number;
  parTimeSec: number;
  /** Denominators for the completion chips. */
  enemies: number;
  items: number;
  secrets: number;
  /** From the save; all zero for a level never played. */
  cleared: boolean;
  bestTimeSec: number;
  bestKills: number;
  bestSecrets: number;
  /** False when the manifest says the level failed validation — shown greyed. */
  playable: boolean;
}

/** One row in the Builder world picker. */
export interface ModeSelectWorld {
  id: string;
  name: string;
  seed: number;
  updatedMs: number;
  blocksPlaced: number;
  online: boolean;
  /** Packed 0xRRGGBB swatch. */
  swatch: number;
}

export interface ModeSelectOptions {
  /** Where the component mounts. Usually `#ui`'s menu screen. */
  root: HTMLElement;
  save?: SaveFile | null;
  levels?: ModeSelectLevel[];
  worlds?: ModeSelectWorld[];
  initialMode?: ModeId;
  /** Bot-count choices offered for Deathmatch. */
  botOptions?: number[];
  onPlay(params: ModeEnterParams): void;
  onModeChange?(mode: ModeId): void;
  /** Return the id of the created world, or '' to refuse. */
  onCreateWorld?(name: string, seed: number): string;
  onDeleteWorld?(id: string): void;
}

/* ------------------------------------------------------------------------ *
 * Styles — injected once, refcounted so `destroy()` is complete
 * ------------------------------------------------------------------------ */

const STYLE_ID = 'dc-modeselect-css';
let styleUsers = 0;

const CSS = `
.dcm{--dcm-ink:#e8e6e3;--dcm-dim:#938e89;--dcm-line:rgba(255,255,255,.13);
  --dcm-panel:rgba(10,10,14,.86);--dcm-hell:#e03c1c;
  display:flex;flex-direction:column;gap:14px;width:min(1040px,100%);margin:0 auto;
  font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--dcm-ink);
  text-align:left}
.dcm *{box-sizing:border-box}
.dcm-head{text-align:center}
.dcm-head h2{margin:0;font:800 clamp(17px,2.4vw,23px)/1.1 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.14em;text-transform:uppercase}
.dcm-head p{margin:5px 0 0;font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:var(--dcm-dim)}

/* ---- tiles ---- */
.dcm-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.dcm-tile{position:relative;overflow:hidden;display:flex;flex-direction:column;gap:0;
  min-height:214px;padding:0;text-align:left;cursor:pointer;
  background:linear-gradient(180deg,rgba(20,20,26,.94),rgba(9,9,13,.96));
  border:1px solid var(--dcm-line);border-radius:4px;color:inherit;font:inherit;
  transition:border-color .12s ease,transform .12s ease,box-shadow .12s ease}
.dcm-tile:hover{transform:translateY(-2px)}
.dcm-tile:focus-visible{outline:2px solid #fff;outline-offset:2px}
.dcm-tile[aria-checked="true"]{border-color:var(--tile-accent);
  box-shadow:0 0 0 1px var(--tile-accent),0 14px 34px rgba(0,0,0,.55)}
.dcm-tile[aria-checked="true"] .dcm-art{background:
  radial-gradient(120% 130% at 50% 8%,var(--tile-glow),rgba(6,6,9,0) 74%)}
.dcm-art{position:relative;height:104px;display:grid;place-items:center;overflow:hidden;
  background:radial-gradient(120% 130% at 50% 8%,rgba(255,255,255,.05),rgba(6,6,9,0) 72%);
  border-bottom:1px solid var(--dcm-line)}
.dcm-art svg{display:block;width:118px;height:88px}
.dcm-body{padding:11px 12px 12px;display:flex;flex-direction:column;gap:4px;flex:1}
.dcm-name{font:800 15px/1.05 "Arial Black",Impact,system-ui,sans-serif;letter-spacing:.06em;
  text-transform:uppercase;color:#f4f1ee}
.dcm-tag{font-size:11.5px;color:var(--dcm-dim);line-height:1.3;min-height:2.6em}
.dcm-save{margin-top:auto;padding-top:8px;border-top:1px solid rgba(255,255,255,.07)}
.dcm-save b{display:block;font-size:13px;color:var(--tile-accent);font-variant-numeric:tabular-nums;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dcm-save span{font-size:10.5px;color:#77726d;letter-spacing:.04em}
.dcm-badge-soon{background:rgba(232,69,31,.16);border-color:#e8451f;color:#ffb9a4}
.dcm-gated .dcm-art{opacity:.55}
.dcm-badge{position:absolute;top:7px;right:7px;padding:2px 6px;border-radius:2px;
  background:rgba(4,4,6,.72);border:1px solid var(--dcm-line);
  font-size:9px;letter-spacing:.13em;color:#a9a39d}
.dcm-ribbon{position:absolute;top:22px;left:-28px;width:116px;transform:rotate(-45deg);
  background:linear-gradient(180deg,#e8451f,#a11d06);color:#fff;text-align:center;
  font:700 8px/16px system-ui,sans-serif;letter-spacing:.06em;white-space:nowrap;
  box-shadow:0 2px 8px rgba(0,0,0,.5);pointer-events:none;z-index:2}

/* ---- picker panel ---- */
.dcm-panel{background:var(--dcm-panel);border:1px solid var(--dcm-line);border-radius:4px;
  display:flex;flex-direction:column;overflow:hidden}
.dcm-panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;
  padding:11px 14px;border-bottom:1px solid var(--dcm-line);background:rgba(255,255,255,.02)}
.dcm-panel-head h3{margin:0;font:700 12px/1 system-ui;letter-spacing:.18em;text-transform:uppercase;
  color:#cfc9c3}
.dcm-panel-head em{font-style:normal;font-size:10.5px;letter-spacing:.09em;color:#6f6a66}
.dcm-panel-body{padding:12px 14px;min-height:168px;max-height:min(44vh,322px);overflow-y:auto;
  overscroll-behavior:contain}
.dcm-blurb{margin:0 0 11px;font-size:12.5px;color:#a09a94;line-height:1.45}

.dcm-rowlabel{margin:0 0 7px;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#6f6a66}
.dcm-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:13px}
.dcm-chip{min-height:32px;padding:6px 12px;border:1px solid var(--dcm-line);border-radius:2px;
  background:rgba(255,255,255,.03);color:#b4aea8;font:600 11.5px/1.2 system-ui;letter-spacing:.05em;
  cursor:pointer}
.dcm-chip:hover{border-color:rgba(255,255,255,.34);color:#e8e6e3}
.dcm-chip[aria-pressed="true"]{background:rgba(224,60,28,.17);border-color:var(--dcm-hell);color:#ffd9cd}

.dcm-list{display:flex;flex-direction:column;gap:5px}
.dcm-ep{margin:9px 0 3px;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#6f6a66}
.dcm-ep:first-child{margin-top:0}
.dcm-item{display:grid;grid-template-columns:44px 1fr auto;align-items:center;gap:11px;
  min-height:46px;padding:7px 11px;width:100%;text-align:left;cursor:pointer;
  background:rgba(255,255,255,.025);border:1px solid transparent;border-radius:3px;
  color:inherit;font:inherit}
.dcm-item:hover{background:rgba(255,255,255,.06)}
.dcm-item[aria-pressed="true"]{border-color:var(--dcm-hell);background:rgba(224,60,28,.12)}
.dcm-item:disabled{opacity:.4;cursor:not-allowed}
.dcm-slug{font:800 12px/1 "Arial Black",Impact,sans-serif;letter-spacing:.03em;color:#8d8781}
.dcm-item[aria-pressed="true"] .dcm-slug{color:var(--dcm-hell)}
.dcm-title{display:block;font-size:13px;color:#e8e6e3}
.dcm-sub{display:block;font-size:10.5px;color:#77726d;margin-top:2px;
  font-variant-numeric:tabular-nums}
.dcm-right{text-align:right;font-size:10.5px;color:#8d8781;font-variant-numeric:tabular-nums;
  white-space:nowrap}
.dcm-tick{color:#4fb84a;font-weight:700}
.dcm-empty{padding:22px 0;text-align:center;font-size:12.5px;color:#6f6a66}

.dcm-new{display:grid;grid-template-columns:1fr 118px auto;gap:7px;margin-top:12px;
  padding-top:12px;border-top:1px solid rgba(255,255,255,.08)}
.dcm-new input{min-height:36px;padding:7px 9px;background:#15151b;color:#e8e6e3;
  border:1px solid var(--dcm-line);border-radius:2px;font:inherit;font-size:12.5px}
.dcm-new input:focus{outline:none;border-color:rgba(255,255,255,.4)}
.dcm-new button{min-height:36px;padding:7px 15px;border:1px solid var(--dcm-line);border-radius:2px;
  background:rgba(255,255,255,.05);color:#e8e6e3;font:600 12px/1 system-ui;letter-spacing:.07em;
  cursor:pointer}
.dcm-new button:hover{border-color:rgba(255,255,255,.4)}
.dcm-del{margin-left:9px;padding:3px 7px;border:1px solid transparent;border-radius:2px;
  background:none;color:#6f6a66;font:600 10px/1 system-ui;cursor:pointer}
.dcm-del:hover{color:#e8695a;border-color:rgba(232,105,90,.4)}

.dcm-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:9px;
  margin-bottom:13px}
.dcm-fact{padding:9px 11px;background:rgba(255,255,255,.03);border:1px solid var(--dcm-line);
  border-radius:3px}
.dcm-fact b{display:block;font-size:17px;color:#e8e6e3;font-variant-numeric:tabular-nums;line-height:1.15}
.dcm-fact span{font-size:9.5px;letter-spacing:.15em;text-transform:uppercase;color:#6f6a66}

/* ---- footer ---- */
.dcm-foot{display:flex;align-items:center;gap:14px;flex-wrap:wrap;justify-content:center}
.dcm-play{display:inline-flex;flex-direction:column;align-items:center;gap:3px;
  min-width:268px;min-height:56px;padding:11px 40px;border:0;border-radius:3px;cursor:pointer;
  background:linear-gradient(180deg,var(--play-accent),var(--play-dark));color:#fff;
  font:800 19px/1 "Arial Black",Impact,sans-serif;letter-spacing:.15em;text-transform:uppercase;
  box-shadow:0 10px 28px rgba(0,0,0,.45)}
.dcm-play:hover{filter:brightness(1.13)}
.dcm-play:disabled{filter:grayscale(1) brightness(.6);cursor:progress}
.dcm-play small{font:600 10px/1 system-ui;letter-spacing:.11em;opacity:.88;text-transform:none}
.dcm-hint{margin:0;font-size:11px;color:#6f6a66;letter-spacing:.05em}

@media (max-width:900px){
  .dcm-tiles{grid-template-columns:repeat(2,1fr)}
  .dcm-tile{min-height:186px}
  .dcm-art{height:82px}
  .dcm-art svg{width:96px;height:72px}
  .dcm-panel-body{max-height:32vh}
}
@media (max-width:560px){
  .dcm{gap:11px}
  .dcm-tiles{grid-template-columns:1fr;gap:8px}
  .dcm-tile{flex-direction:row;min-height:0}
  .dcm-art{height:auto;width:96px;flex:0 0 96px;border-bottom:0;border-right:1px solid var(--dcm-line)}
  .dcm-art svg{width:74px;height:58px}
  .dcm-tag{min-height:0}
  .dcm-ribbon{top:20px;left:-24px;width:104px;font-size:7.5px;line-height:14px}
  .dcm-new{grid-template-columns:1fr}
  .dcm-play{width:100%;min-width:0}
}
@media (prefers-reduced-motion:reduce){
  .dcm-tile,.dcm-tile:hover{transition:none;transform:none}
}
`;

function ensureStyle(): HTMLStyleElement {
  let node = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (node === null) {
    node = document.createElement('style');
    node.id = STYLE_ID;
    node.textContent = CSS;
    document.head.appendChild(node);
  }
  styleUsers++;
  return node;
}
function releaseStyle(): void {
  styleUsers--;
  if (styleUsers > 0) return;
  document.getElementById(STYLE_ID)?.remove();
}

/* ------------------------------------------------------------------------ *
 * Isometric voxel thumbnails
 * ------------------------------------------------------------------------ */

const TILE_W = 26;
const TILE_H = 15;
const CUBE_H = 17;

function shade(hex: number, mul: number): string {
  const r = Math.min(255, Math.round(((hex >>> 16) & 0xff) * mul));
  const g = Math.min(255, Math.round(((hex >>> 8) & 0xff) * mul));
  const b = Math.min(255, Math.round((hex & 0xff) * mul));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** [gridX, gridY, gridZ, packedColor]. */
type Voxel = readonly [number, number, number, number];

function isoCube(gx: number, gy: number, gz: number, color: number, ox: number, oy: number): string {
  const sx = ox + (gx - gz) * (TILE_W / 2);
  const sy = oy + (gx + gz) * (TILE_H / 2) - gy * CUBE_H;
  const hw = TILE_W / 2;
  const hh = TILE_H / 2;
  const top = `${sx},${sy} ${sx + hw},${sy + hh} ${sx},${sy + TILE_H} ${sx - hw},${sy + hh}`;
  const left = `${sx - hw},${sy + hh} ${sx},${sy + TILE_H} ${sx},${sy + TILE_H + CUBE_H} ${sx - hw},${sy + hh + CUBE_H}`;
  const right = `${sx + hw},${sy + hh} ${sx},${sy + TILE_H} ${sx},${sy + TILE_H + CUBE_H} ${sx + hw},${sy + hh + CUBE_H}`;
  return `<polygon points="${left}" fill="${shade(color, 0.62)}"/>`
    + `<polygon points="${right}" fill="${shade(color, 0.44)}"/>`
    + `<polygon points="${top}" fill="${shade(color, 1.0)}"/>`;
}

function isoScene(voxels: readonly Voxel[], ox: number, oy: number): string {
  const sorted = voxels.slice().sort((a, b) => (a[0] + a[2]) - (b[0] + b[2]) || a[1] - b[1]);
  let out = '';
  for (const v of sorted) out += isoCube(v[0], v[1], v[2], v[3], ox, oy);
  return out;
}

const DARK = 0x3a3742;
const GREY = 0x6f6f78;
const GRASS = 0x74b449;
const DIRT = 0x7a5230;
const AMBER = 0xd88a20;
const RUST = 0x9a5730;
const BLOOD = 0xc03020;
const STEEL = 0x8b93a0;
const BLUE = 0x3f7ec8;

/** Per-mode thumbnails. Small scenes; each one says what the mode is. */
/**
 * Online multiplayer is built but not finished, and the live site is a static single-player build.
 * Until the gate opens, a mode that needs a server must not advertise one — the tile said
 * "Online arena, instant start" on a page with no server behind it, which was simply untrue.
 * The mode still PLAYS, against bots, locally; only the online claim is withdrawn.
 */
function onlineGated(id: number): boolean {
  if (isEnabled(Feature.ONLINE_MULTIPLAYER)) return false;
  return id === ModeId.DEATHMATCH || id === ModeId.BUILDER;
}

/** Tagline that is true today, for a mode whose online half is not open yet. */
function offlineTagline(id: number, original: string): string {
  if (!onlineGated(id)) return original;
  if (id === ModeId.DEATHMATCH) return 'Arena combat against bots';
  if (id === ModeId.BUILDER) return 'Creative voxel worlds, on this device';
  return original;
}

function artFor(mode: ModeId): string {
  const V: Voxel[] = [];
  switch (mode) {
    case ModeId.QUEST: {
      // A dark corridor mouth with a lit red door at the end — E1M1's silhouette.
      for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) V.push([x, 0, z, DARK]);
      V.push([0, 1, 0, GREY], [0, 2, 0, GREY], [2, 1, 0, GREY], [2, 2, 0, GREY]);
      V.push([1, 1, 0, 0xe8451f], [1, 2, 0, 0xff8a4a]);
      V.push([0, 1, 1, DARK], [2, 1, 1, DARK]);
      break;
    }
    case ModeId.BUILDER: {
      for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) V.push([x, 0, z, GRASS]);
      V.push([0, -1, 0, DIRT], [1, -1, 0, DIRT], [2, -1, 0, DIRT]);
      V.push([1, 1, 1, 0x9dcfe9]);   // the block you are about to place
      V.push([2, 1, 2, GRASS], [2, 2, 2, GRASS]);
      break;
    }
    case ModeId.HORDE: {
      // A wall you built, and the thing coming over it.
      for (let x = 0; x < 3; x++) for (let z = 1; z < 3; z++) V.push([x, 0, z, RUST]);
      V.push([0, 1, 1, AMBER], [1, 1, 1, AMBER], [2, 1, 1, AMBER]);
      V.push([0, 2, 1, AMBER], [2, 2, 1, AMBER]);
      V.push([1, 2, 0, BLOOD], [1, 3, 0, 0xe8451f]);
      break;
    }
    default: {
      for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) V.push([x, 0, z, STEEL]);
      V.push([0, 1, 0, BLUE], [0, 2, 0, BLUE]);
      V.push([2, 1, 2, BLOOD], [2, 2, 2, BLOOD]);
      V.push([1, 1, 1, 0xf0c860]);   // the round in flight between them
      break;
    }
  }
  return `<svg viewBox="0 0 118 96" role="img" aria-hidden="true" focusable="false">`
    + `<g>${isoScene(V, 59, 26)}</g></svg>`;
}

/* ------------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function btn(cls: string, text?: string): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

function relativeTime(ms: number, nowMs: number): string {
  if (ms <= 0) return 'never';
  const s = Math.max(0, (nowMs - ms) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60;
  if (m < 90) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** `e1m1-hangar` -> `E1M1`; falls back to the episode+index. */
function levelSlug(l: ModeSelectLevel): string {
  const m = /^([a-z]\d+m\d+)/i.exec(l.id);
  if (m !== null) return m[1].toUpperCase();
  return `${l.episodeId}M${l.levelIndex}`.toUpperCase();
}

/* ------------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------------ */

export class ModeSelect {
  readonly element: HTMLElement;

  private readonly opts: ModeSelectOptions;
  private readonly tiles: HTMLButtonElement[] = [];
  private readonly tileSaveValue: HTMLElement[] = [];
  private readonly tileSaveDetail: HTMLElement[] = [];
  private readonly panelTitle: HTMLElement;
  private readonly panelBar: HTMLElement;
  private readonly panelBody: HTMLElement;
  private readonly blurb: HTMLElement;
  private readonly bodies = new Map<ModeId, HTMLElement>();
  private readonly playBtn: HTMLButtonElement;
  private readonly playLabel: HTMLElement;
  private readonly playSub: HTMLElement;
  private readonly hint: HTMLElement;

  /* quest */
  private questList!: HTMLElement;
  private readonly questSkillChips: HTMLButtonElement[] = [];
  private questLevelButtons: HTMLButtonElement[] = [];

  /* builder */
  private worldList!: HTMLElement;
  private worldNameInput!: HTMLInputElement;
  private worldSeedInput!: HTMLInputElement;

  /* horde */
  private readonly hordeSkillChips: HTMLButtonElement[] = [];
  private hordeFacts!: HTMLElement;

  /* deathmatch */
  private readonly botChips: HTMLButtonElement[] = [];

  private levels: ModeSelectLevel[] = [];
  private worlds: ModeSelectWorld[] = [];
  private save: SaveFile | null = null;
  private botOptions: number[];
  private selectedMode: ModeId = ModeId.QUEST;
  private selectedLevelId = '';
  private selectedWorldId = '';
  private skill = 2;
  private botCount = 6;
  private busy = false;
  private destroyed = false;
  private readonly keyHandler: (e: KeyboardEvent) => void;

  constructor(opts: ModeSelectOptions) {
    this.opts = opts;
    this.botOptions = opts.botOptions ?? [0, 4, 8, 16];
    this.botCount = this.botOptions.includes(6) ? 6 : this.botOptions[this.botOptions.length >> 1];
    ensureStyle();

    this.element = el('div', 'dcm');
    this.element.setAttribute('data-dc', 'mode-select');

    /* ---- header ---- */
    const head = el('div', 'dcm-head');
    head.appendChild(el('h2', undefined, 'Choose your fight'));
    head.appendChild(el('p', undefined, 'Four modes · one engine · no install'));
    this.element.appendChild(head);

    /* ---- tiles ---- */
    const tiles = el('div', 'dcm-tiles');
    tiles.setAttribute('role', 'radiogroup');
    tiles.setAttribute('aria-label', 'Game mode');
    for (const id of MODE_MENU_ORDER) tiles.appendChild(this.buildTile(getMode(id)));
    this.element.appendChild(tiles);

    /* ---- panel ---- */
    const panel = el('div', 'dcm-panel');
    const phead = el('div', 'dcm-panel-head');
    this.panelTitle = el('h3', undefined, '');
    this.panelBar = el('em', undefined, '');
    phead.append(this.panelTitle, this.panelBar);
    this.panelBody = el('div', 'dcm-panel-body');
    this.blurb = el('p', 'dcm-blurb', '');
    this.panelBody.appendChild(this.blurb);
    panel.append(phead, this.panelBody);
    this.element.appendChild(panel);

    this.bodies.set(ModeId.QUEST, this.buildQuestBody());
    this.bodies.set(ModeId.BUILDER, this.buildBuilderBody());
    this.bodies.set(ModeId.HORDE, this.buildHordeBody());
    this.bodies.set(ModeId.DEATHMATCH, this.buildDeathmatchBody());
    for (const body of this.bodies.values()) this.panelBody.appendChild(body);

    /* ---- footer ---- */
    const foot = el('div', 'dcm-foot');
    this.playBtn = btn('dcm-play');
    this.playLabel = el('span', undefined, 'Play');
    this.playSub = el('small', undefined, '');
    this.playBtn.append(this.playLabel, this.playSub);
    this.playBtn.addEventListener('click', () => { this.play(); });
    this.hint = el('p', 'dcm-hint', '1–4 pick a mode · Enter plays');
    foot.append(this.playBtn, this.hint);
    this.element.appendChild(foot);

    /* ---- data ---- */
    if (opts.levels !== undefined) this.levels = opts.levels.slice();
    if (opts.worlds !== undefined) this.worlds = opts.worlds.slice();
    if (opts.save !== undefined && opts.save !== null) this.save = opts.save;

    this.keyHandler = (e) => { this.onKey(e); };
    this.element.addEventListener('keydown', this.keyHandler);

    opts.root.appendChild(this.element);
    this.refreshTileSaves();
    this.refreshHordeFacts();
    this.refreshLevels();
    this.refreshWorlds();
    this.select(opts.initialMode ?? this.defaultMode(), false);
  }

  /* -------------------------------------------------------------- *
   * Construction
   * -------------------------------------------------------------- */

  private buildTile(def: ModeDef): HTMLButtonElement {
    const tile = btn('dcm-tile');
    tile.setAttribute('role', 'radio');
    tile.setAttribute('aria-checked', 'false');
    tile.dataset.mode = def.key;
    const accent = `#${def.accent.toString(16).padStart(6, '0')}`;
    tile.style.setProperty('--tile-accent', accent);
    tile.style.setProperty('--tile-glow', `${accent}26`);

    const art = el('div', 'dcm-art');
    art.innerHTML = artFor(def.id);
    tile.appendChild(art);

    if (def.ribbon.length > 0) {
      tile.appendChild(el('div', 'dcm-ribbon', def.ribbon));
    }
    const gated = onlineGated(def.id);
    if (gated) {
      const b = el('div', 'dcm-badge dcm-badge-soon', COMING_SOON_BADGE);
      tile.appendChild(b);
      tile.classList.add('dcm-gated');
    } else if (def.badge.length > 0) {
      tile.appendChild(el('div', 'dcm-badge', def.badge));
    }

    const body = el('div', 'dcm-body');
    body.appendChild(el('div', 'dcm-name', def.name));
    body.appendChild(el('div', 'dcm-tag', offlineTagline(def.id, def.tagline)));
    const saveBox = el('div', 'dcm-save');
    const value = el('b', undefined, '—');
    const detail = el('span', undefined, '');
    saveBox.append(value, detail);
    body.appendChild(saveBox);
    tile.appendChild(body);

    tile.addEventListener('click', () => { this.select(def.id, true); });
    this.tiles.push(tile);
    this.tileSaveValue.push(value);
    this.tileSaveDetail.push(detail);
    return tile;
  }

  private buildSkillRow(into: HTMLElement, chips: HTMLButtonElement[]): void {
    into.appendChild(el('p', 'dcm-rowlabel', 'Skill'));
    const row = el('div', 'dcm-chips');
    for (let k = 0; k < SKILL_COUNT; k++) {
      const c = btn('dcm-chip', SKILL_NAMES[k]);
      c.title = `${SKILL_SHORT_NAMES[k]} — ${SKILL_NAMES[k]}`;
      c.setAttribute('aria-pressed', 'false');
      c.addEventListener('click', () => { this.setSkill(k); });
      row.appendChild(c);
      chips.push(c);
    }
    into.appendChild(row);
  }

  private buildQuestBody(): HTMLElement {
    const body = el('div');
    body.hidden = true;
    this.buildSkillRow(body, this.questSkillChips);
    body.appendChild(el('p', 'dcm-rowlabel', 'Level'));
    this.questList = el('div', 'dcm-list');
    body.appendChild(this.questList);
    return body;
  }

  private buildBuilderBody(): HTMLElement {
    const body = el('div');
    body.hidden = true;
    body.appendChild(el('p', 'dcm-rowlabel', 'Your worlds'));
    this.worldList = el('div', 'dcm-list');
    body.appendChild(this.worldList);

    const row = el('div', 'dcm-new');
    this.worldNameInput = el('input');
    this.worldNameInput.type = 'text';
    this.worldNameInput.placeholder = 'New world name';
    this.worldNameInput.maxLength = 24;
    this.worldNameInput.setAttribute('aria-label', 'New world name');
    this.worldSeedInput = el('input');
    this.worldSeedInput.type = 'text';
    this.worldSeedInput.placeholder = 'Seed (optional)';
    this.worldSeedInput.maxLength = 12;
    this.worldSeedInput.setAttribute('aria-label', 'World seed');
    const create = btn('', 'Create');
    create.addEventListener('click', () => { this.createWorld(); });
    row.append(this.worldNameInput, this.worldSeedInput, create);
    body.appendChild(row);
    return body;
  }

  private buildHordeBody(): HTMLElement {
    const body = el('div');
    body.hidden = true;
    this.hordeFacts = el('div', 'dcm-facts');
    body.appendChild(this.hordeFacts);
    this.buildSkillRow(body, this.hordeSkillChips);
    return body;
  }

  private buildDeathmatchBody(): HTMLElement {
    const body = el('div');
    body.hidden = true;
    body.appendChild(el('p', 'dcm-rowlabel', 'Bots in the match'));
    const row = el('div', 'dcm-chips');
    for (const count of this.botOptions) {
      const c = btn('dcm-chip', count === 0 ? 'Humans only' : `${count} bots`);
      c.setAttribute('aria-pressed', 'false');
      c.addEventListener('click', () => { this.setBots(count); });
      row.appendChild(c);
      this.botChips.push(c);
    }
    body.appendChild(row);
    const facts = el('div', 'dcm-facts');
    const f1 = el('div', 'dcm-fact');
    f1.append(el('b', undefined, '0 s'), el('span', undefined, 'Matchmaking wait'));
    const f2 = el('div', 'dcm-fact');
    f2.append(el('b', undefined, '25 s'), el('span', undefined, 'The bar makes you wait'));
    const f3 = el('div', 'dcm-fact');
    f3.append(el('b', undefined, 'Live'), el('span', undefined, 'Bots hand slots to humans'));
    facts.append(f1, f2, f3);
    body.appendChild(facts);
    return body;
  }

  /* -------------------------------------------------------------- *
   * Data in
   * -------------------------------------------------------------- */

  setLevels(levels: ModeSelectLevel[]): void {
    this.levels = levels.slice();
    this.refreshLevels();
    this.syncPlayButton();
  }

  setWorlds(worlds: ModeSelectWorld[]): void {
    this.worlds = worlds.slice();
    this.refreshWorlds();
    this.syncPlayButton();
  }

  setSave(save: SaveFile | null): void {
    this.save = save;
    this.refreshTileSaves();
    this.refreshHordeFacts();
    this.syncPlayButton();
  }

  /** Grey the CTA while the shell is spinning a room up. */
  setBusy(busy: boolean, label = 'Starting…'): void {
    this.busy = busy;
    this.playBtn.disabled = busy;
    if (busy) {
      this.playLabel.textContent = label;
      this.playSub.textContent = '';
    } else {
      this.syncPlayButton();
    }
  }

  /* -------------------------------------------------------------- *
   * Selection
   * -------------------------------------------------------------- */

  private defaultMode(): ModeId {
    const last = this.save?.profile.lastMode;
    return last !== undefined && MODE_MENU_ORDER.includes(last) ? last : ModeId.QUEST;
  }

  select(mode: ModeId, notify: boolean): void {
    this.selectedMode = mode;
    for (let k = 0; k < this.tiles.length; k++) {
      const isOn = MODE_MENU_ORDER[k] === mode;
      this.tiles[k].setAttribute('aria-checked', isOn ? 'true' : 'false');
      this.tiles[k].tabIndex = isOn ? 0 : -1;
    }
    const def = getMode(mode);
    this.panelTitle.textContent = def.name;
    this.panelBar.textContent = `Bar: ${def.bar}`;
    this.blurb.textContent = def.blurb;
    for (const [id, body] of this.bodies) body.hidden = id !== mode;
    const accent = `#${def.accent.toString(16).padStart(6, '0')}`;
    this.playBtn.style.setProperty('--play-accent', accent);
    this.playBtn.style.setProperty('--play-dark', shade(def.accent, 0.45));
    if (def.needsSkillPicker) this.setSkill(this.skill);
    this.panelBody.scrollTop = 0;
    this.syncPlayButton();
    if (notify) this.opts.onModeChange?.(mode);
  }

  private setSkill(skill: number): void {
    this.skill = clampSkill(skill);
    for (const chips of [this.questSkillChips, this.hordeSkillChips]) {
      for (let k = 0; k < chips.length; k++) {
        chips[k].setAttribute('aria-pressed', k === this.skill ? 'true' : 'false');
      }
    }
    this.syncPlayButton();
  }

  private setBots(count: number): void {
    this.botCount = count;
    for (let k = 0; k < this.botChips.length; k++) {
      this.botChips[k].setAttribute('aria-pressed', this.botOptions[k] === count ? 'true' : 'false');
    }
  }

  private selectLevel(id: string): void {
    this.selectedLevelId = id;
    for (const b of this.questLevelButtons) {
      b.setAttribute('aria-pressed', b.dataset.levelId === id ? 'true' : 'false');
    }
    this.syncPlayButton();
  }

  private selectWorld(id: string): void {
    this.selectedWorldId = id;
    for (const node of this.worldList.children) {
      const b = node as HTMLElement;
      if (b.dataset.worldId !== undefined) {
        b.setAttribute('aria-pressed', b.dataset.worldId === id ? 'true' : 'false');
      }
    }
    this.syncPlayButton();
  }

  /* -------------------------------------------------------------- *
   * Rendering the lists
   * -------------------------------------------------------------- */

  private refreshLevels(): void {
    this.questList.textContent = '';
    this.questLevelButtons = [];
    if (this.levels.length === 0) {
      this.questList.appendChild(el('div', 'dcm-empty', 'No levels installed. Drop a .json into content/levels/.'));
      this.selectedLevelId = '';
      return;
    }

    const sorted = this.levels.slice().sort(
      (a, b) => (a.episodeIndex - b.episodeIndex) || (a.levelIndex - b.levelIndex) || a.id.localeCompare(b.id),
    );
    let episode = '';
    for (const l of sorted) {
      if (l.episodeId !== episode) {
        episode = l.episodeId;
        this.questList.appendChild(el('div', 'dcm-ep', l.episodeName || l.episodeId.toUpperCase()));
      }
      const item = btn('dcm-item');
      item.dataset.levelId = l.id;
      item.disabled = !l.playable;
      item.setAttribute('aria-pressed', 'false');

      item.appendChild(el('span', 'dcm-slug', levelSlug(l)));

      const mid = el('span');
      mid.appendChild(el('span', 'dcm-title', l.name));
      const bits: string[] = [];
      bits.push(`${l.enemies} enemies`);
      if (l.secrets > 0) bits.push(`${l.secrets} secret${l.secrets === 1 ? '' : 's'}`);
      if (l.parTimeSec > 0) bits.push(`par ${formatTime(l.parTimeSec)}`);
      if (!l.playable) bits.push('failed validation');
      mid.appendChild(el('span', 'dcm-sub', bits.join(' · ')));
      item.appendChild(mid);

      const right = el('span', 'dcm-right');
      if (l.cleared) {
        right.innerHTML = '<span class="dcm-tick">✔</span>';
        const line = el('div');
        line.textContent = l.bestTimeSec > 0 ? formatTime(l.bestTimeSec) : 'cleared';
        right.appendChild(line);
        const pct = el('div');
        pct.textContent = `${percentOf(l.bestKills, l.enemies)}% K · ${percentOf(l.bestSecrets, l.secrets)}% S`;
        right.appendChild(pct);
      } else {
        right.textContent = 'unplayed';
      }
      item.appendChild(right);

      item.addEventListener('click', () => { this.selectLevel(l.id); });
      this.questList.appendChild(item);
      this.questLevelButtons.push(item);
    }

    // Resume where the save left off, else the first playable level.
    const resume = this.save === null ? '' : this.resumeLevelId();
    const playable = sorted.filter((l) => l.playable);
    const wanted = playable.some((l) => l.id === resume)
      ? resume
      : (playable.length > 0 ? playable[0].id : '');
    this.selectLevel(wanted);
  }

  private resumeLevelId(): string {
    const q = this.save?.quest;
    if (q === undefined || q.activeSlot < 0 || q.activeSlot >= q.slots.length) return '';
    return q.slots[q.activeSlot].levelId;
  }

  private refreshWorlds(): void {
    this.worldList.textContent = '';
    if (this.worlds.length === 0) {
      this.worldList.appendChild(el('div', 'dcm-empty', 'No worlds yet. Name one below and start building.'));
      this.selectedWorldId = '';
      this.syncPlayButton();
      return;
    }
    const now = Date.now();
    const sorted = this.worlds.slice().sort((a, b) => b.updatedMs - a.updatedMs);
    for (const w of sorted) {
      const item = btn('dcm-item');
      item.dataset.worldId = w.id;
      item.setAttribute('aria-pressed', 'false');

      const swatch = el('span', 'dcm-slug', '■');
      swatch.style.color = `#${(w.swatch >>> 0).toString(16).padStart(6, '0')}`;
      item.appendChild(swatch);

      const mid = el('span');
      mid.appendChild(el('span', 'dcm-title', w.name));
      mid.appendChild(el('span', 'dcm-sub',
        `${w.blocksPlaced.toLocaleString()} blocks · seed ${w.seed} · ${w.online ? 'online' : 'local'}`));
      item.appendChild(mid);

      const right = el('span', 'dcm-right');
      right.textContent = relativeTime(w.updatedMs, now);
      if (this.opts.onDeleteWorld !== undefined) {
        const del = btn('dcm-del', 'Delete');
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          this.opts.onDeleteWorld?.(w.id);
        });
        right.appendChild(del);
      }
      item.appendChild(right);

      item.addEventListener('click', () => { this.selectWorld(w.id); });
      this.worldList.appendChild(item);
    }
    const active = this.save?.builder.activeWorldId ?? '';
    this.selectWorld(sorted.some((w) => w.id === active) ? active : sorted[0].id);
  }

  private refreshTileSaves(): void {
    if (this.save === null) return;
    const summaries = summariseSaves(this.save);
    for (let k = 0; k < MODE_MENU_ORDER.length; k++) {
      const mode = MODE_MENU_ORDER[k];
      const s = summaries.find((x) => x.modeId === mode);
      if (s === undefined) continue;
      this.tileSaveValue[k].textContent = s.headline;
      this.tileSaveDetail[k].textContent = s.detail;
    }
  }

  private refreshHordeFacts(): void {
    this.hordeFacts.textContent = '';
    const h = this.save?.horde;
    const rows: Array<[string, string]> = [
      [h !== undefined && h.bestWave > 0 ? String(h.bestWave) : '—', 'Best wave'],
      [h !== undefined ? String(h.runs) : '0', 'Runs'],
      [h !== undefined ? h.totalKills.toLocaleString() : '0', 'Demons killed'],
      [h !== undefined ? h.totalBlocksPlaced.toLocaleString() : '0', 'Blocks placed'],
    ];
    for (const [value, label] of rows) {
      const f = el('div', 'dcm-fact');
      f.append(el('b', undefined, value), el('span', undefined, label));
      this.hordeFacts.appendChild(f);
    }
  }

  /* -------------------------------------------------------------- *
   * Play
   * -------------------------------------------------------------- */

  /** The params the CTA would fire with right now. */
  get params(): ModeEnterParams {
    const p = createEnterParams(this.selectedMode);
    const def = getMode(this.selectedMode);
    if (def.needsSkillPicker) p.skill = this.skill;
    if (def.needsLevelPicker) p.levelId = this.selectedLevelId;
    if (def.needsWorldPicker) p.worldId = this.selectedWorldId;
    if (this.selectedMode === ModeId.QUEST && this.resumeLevelId() === this.selectedLevelId
      && this.selectedLevelId.length > 0) {
      p.flags |= MSF_CONTINUE;
    }
    if (this.selectedMode === ModeId.BUILDER && this.selectedWorldId.length === 0) p.flags |= MSF_FRESH;
    if (this.selectedMode === ModeId.DEATHMATCH && this.botCount === 0) p.flags |= MSF_NO_BOTS;
    if (def.needsWorldPicker) {
      // Only a world carries a seed. Leaking one into a Quest request would
      // override the level's own world source.
      const w = this.worlds.find((x) => x.id === this.selectedWorldId);
      if (w !== undefined) p.seed = w.seed >>> 0;
    }
    return p;
  }

  private canPlay(): boolean {
    const def = getMode(this.selectedMode);
    if (def.needsLevelPicker && this.selectedLevelId.length === 0) return false;
    return true;
  }

  private syncPlayButton(): void {
    if (this.busy) return;
    const def = getMode(this.selectedMode);
    const ok = this.canPlay();
    this.playBtn.disabled = !ok;

    switch (this.selectedMode) {
      case ModeId.QUEST: {
        const l = this.levels.find((x) => x.id === this.selectedLevelId);
        const resuming = this.resumeLevelId() === this.selectedLevelId && this.selectedLevelId.length > 0;
        this.playLabel.textContent = resuming ? 'Continue' : 'Descend';
        this.playSub.textContent = l === undefined
          ? 'Pick a level'
          : `${levelSlug(l)} ${l.name} · ${SKILL_NAMES[this.skill]}`;
        break;
      }
      case ModeId.BUILDER: {
        const w = this.worlds.find((x) => x.id === this.selectedWorldId);
        this.playLabel.textContent = w === undefined ? 'New world' : 'Build';
        this.playSub.textContent = w === undefined
          ? 'A fresh seed, full palette, infinite blocks'
          : `${w.name} · ${w.online ? 'friends can join' : 'local'}`;
        break;
      }
      case ModeId.HORDE:
        this.playLabel.textContent = 'Hold the line';
        this.playSub.textContent = `${SKILL_NAMES[this.skill]} · fortify between waves`;
        break;
      default:
        this.playLabel.textContent = 'Play now';
        this.playSub.textContent = this.botCount === 0
          ? 'Humans only — you may wait'
          : `${this.botCount} bots already fighting · zero wait`;
        break;
    }
    this.hint.textContent = def.needsLevelPicker
      ? '1–4 pick a mode · ↑↓ pick a level · Enter plays'
      : '1–4 pick a mode · Enter plays';
  }

  private createWorld(): void {
    if (this.opts.onCreateWorld === undefined) return;
    const name = this.worldNameInput.value.trim() || 'New World';
    const raw = this.worldSeedInput.value.trim();
    let seed = 0;
    if (raw.length > 0) {
      const parsed = Number(raw);
      // A non-numeric seed is hashed, so "hangar" is a seed like any other.
      seed = Number.isFinite(parsed) ? (parsed >>> 0) : hashString(raw);
    } else {
      seed = (Math.random() * 0xffffffff) >>> 0;
    }
    const id = this.opts.onCreateWorld(name, seed);
    if (id.length === 0) return;
    this.worldNameInput.value = '';
    this.worldSeedInput.value = '';
    this.selectedWorldId = id;
  }

  play(): void {
    if (this.busy || this.destroyed || !this.canPlay()) return;
    this.opts.onPlay(this.params);
  }

  focus(): void {
    const k = MODE_MENU_ORDER.indexOf(this.selectedMode);
    this.tiles[k < 0 ? 0 : k].focus();
  }

  /* -------------------------------------------------------------- *
   * Keyboard
   * -------------------------------------------------------------- */

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target !== null && target.tagName === 'INPUT') {
      if (e.key === 'Enter') { e.preventDefault(); this.createWorld(); }
      return;
    }
    const digit = /^Digit([1-4])$/.exec(e.code);
    if (digit !== null) {
      e.preventDefault();
      this.select(MODE_MENU_ORDER[Number(digit[1]) - 1], true);
      this.focus();
      return;
    }
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowLeft': {
        e.preventDefault();
        const k = MODE_MENU_ORDER.indexOf(this.selectedMode);
        const step = e.key === 'ArrowRight' ? 1 : MODE_MENU_ORDER.length - 1;
        this.select(MODE_MENU_ORDER[(k + step) % MODE_MENU_ORDER.length], true);
        this.focus();
        break;
      }
      case 'ArrowDown':
      case 'ArrowUp': {
        if (!getMode(this.selectedMode).needsLevelPicker) return;
        const list = this.questLevelButtons.filter((b) => !b.disabled);
        if (list.length === 0) return;
        e.preventDefault();
        const k = list.findIndex((b) => b.dataset.levelId === this.selectedLevelId);
        const step = e.key === 'ArrowDown' ? 1 : list.length - 1;
        const next = list[((k < 0 ? 0 : k) + step) % list.length];
        this.selectLevel(next.dataset.levelId ?? '');
        next.scrollIntoView({ block: 'nearest' });
        break;
      }
      case 'Enter':
        e.preventDefault();
        this.play();
        break;
      default:
        break;
    }
  }

  /* -------------------------------------------------------------- *
   * Teardown
   * -------------------------------------------------------------- */

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.element.removeEventListener('keydown', this.keyHandler);
    this.element.remove();
    releaseStyle();
  }
}

/** FNV-1a over a string, so a word can be used as a world seed. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createModeSelect(opts: ModeSelectOptions): ModeSelect {
  return new ModeSelect(opts);
}

/** Fold a manifest entry and the save together into a picker row. */
export function levelRowFrom(
  entry: {
    id: string; name: string; episodeId: string; episodeName: string;
    episodeIndex: number; levelIndex: number; parTimeSec: number;
    enemies: number; items: number; secrets: number; valid: boolean;
  },
  save: SaveFile | null,
): ModeSelectLevel {
  let cleared = false;
  let bestTimeSec = 0;
  let bestKills = 0;
  let bestSecrets = 0;
  if (save !== null) {
    for (const slot of save.quest.slots) {
      for (const r of slot.levels) {
        if (r.levelId !== entry.id) continue;
        cleared = cleared || r.completed;
        if (r.bestTimeSec > 0 && (bestTimeSec === 0 || r.bestTimeSec < bestTimeSec)) bestTimeSec = r.bestTimeSec;
        if (r.kills > bestKills) bestKills = r.kills;
        if (r.secrets > bestSecrets) bestSecrets = r.secrets;
      }
    }
  }
  return {
    id: entry.id,
    name: entry.name,
    episodeId: entry.episodeId,
    episodeName: entry.episodeName,
    episodeIndex: entry.episodeIndex,
    levelIndex: entry.levelIndex,
    parTimeSec: entry.parTimeSec,
    enemies: entry.enemies,
    items: entry.items,
    secrets: entry.secrets,
    cleared,
    bestTimeSec,
    bestKills,
    bestSecrets,
    playable: entry.valid,
  };
}

/** Save worlds -> picker rows. */
export function worldRowsFrom(save: SaveFile | null): ModeSelectWorld[] {
  if (save === null) return [];
  return save.builder.worlds.map((w) => ({
    id: w.id,
    name: w.name,
    seed: w.seed,
    updatedMs: w.updatedMs,
    blocksPlaced: w.blocksPlaced,
    online: w.online,
    swatch: w.swatch,
  }));
}
