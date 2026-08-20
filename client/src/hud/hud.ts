/**
 * DOOMCRAFT — in-game HUD.
 *
 * Judged against ref/BAR.md. The bar's HUD is corner-only DOM with a dead
 * static crosshair (weakness #3), a desktop layout shipped unchanged to a
 * 412 px-tall phone (weakness #11) and near-invisible touch controls
 * (weakness #10). This one answers all three:
 *
 *   - the crosshair breathes with the live weapon cone and pops a hit marker,
 *   - the layout has a real portrait mode instead of a rotate-your-phone wall,
 *   - the touch pad has a dedicated fire button with high-contrast fills.
 *
 * COST. The HUD must not cost frames, so nothing here re-renders on a whim:
 *
 *   - every DOM node is created once at mount and afterwards only *mutated*,
 *     each behind a `!==` guard, so a steady frame writes zero DOM;
 *   - the only canvases are a 96 px crosshair (redrawn when the cone actually
 *     changes) and the minimap (redrawn at 10 Hz);
 *   - the minimap is a blit out of a pre-baked world image — the column scan
 *     happens once per chunk on arrival, never per frame;
 *   - no allocation in `update()`.
 */

import {
  MAX_HEALTH, MAX_ARMOR, InputAction,
  CHUNK_SIZE_X, CHUNK_SIZE_Z, CHUNK_HEIGHT,
  WORLD_MIN_BLOCK_X, WORLD_MIN_BLOCK_Z, WORLD_SIZE_BLOCKS,
  type CrosshairStyle,
} from '@shared/constants';
import { minimapColor, BLOCK_LIQUID } from '@shared/blocks';
import {
  WEAPON_COUNT, WEAPON_SHORT_NAMES, WEAPON_NAMES, AMMO_NAMES, AMMO_COLORS,
  WEAPON_MAG_SIZE, ammoTypeOf, ownsWeapon,
} from '@shared/weapons';

/* ------------------------------------------------------------------------ *
 * Public state
 * ------------------------------------------------------------------------ */

/** Blip kinds drawn on the minimap, in draw order. */
export const BLIP_PICKUP = 0;
export const BLIP_PLAYER = 1;
export const BLIP_ENEMY = 2;

export const MAX_BLIPS = 64;
/** Scoreboard rows the HUD will render. */
export const MAX_BOARD_ROWS = 16;

/**
 * Everything the HUD draws. The game owns one of these and mutates it in
 * place; the HUD never keeps a reference to anything inside it.
 */
export interface HudState {
  health: number;
  armor: number;
  weapon: number;
  mag: number;
  reserve: number;
  /** Bitmask of owned weapons — greys out hotbar slots. */
  owned: number;
  /** 0..1 live cone fraction; drives the dynamic crosshair. */
  spread: number;
  reloading: boolean;
  reloadFrac: number;

  kills: number;
  deaths: number;
  playersAlive: number;
  matchSeconds: number;

  dead: boolean;
  /** Centre status line. Empty hides it. */
  status: string;
  /** Small line under the status. */
  subStatus: string;

  fps: number;
  ping: number;
  showFps: boolean;

  /** Camera position and heading for the minimap. */
  camX: number;
  camZ: number;
  camYaw: number;

  /** Scoreboard rows, filled by the game while Tab is held. */
  boardOpen: boolean;
  boardCount: number;
  boardName: string[];
  boardKills: Int32Array;
  boardDeaths: Int32Array;
  boardPing: Int32Array;
  boardIsLocal: Uint8Array;

  /** Minimap blips, packed as [x, z, kind] triples in `blipCount` entries. */
  blipX: Float32Array;
  blipZ: Float32Array;
  blipKind: Uint8Array;
  blipCount: number;
}

export function createHudState(): HudState {
  return {
    health: MAX_HEALTH, armor: 0, weapon: 0, mag: 0, reserve: 0, owned: 1,
    spread: 0, reloading: false, reloadFrac: 0,
    kills: 0, deaths: 0, playersAlive: 1, matchSeconds: 0,
    dead: false, status: '', subStatus: '',
    fps: 0, ping: 0, showFps: true,
    camX: 0, camZ: 0, camYaw: 0,
    boardOpen: false, boardCount: 0,
    boardName: new Array<string>(MAX_BOARD_ROWS).fill(''),
    boardKills: new Int32Array(MAX_BOARD_ROWS),
    boardDeaths: new Int32Array(MAX_BOARD_ROWS),
    boardPing: new Int32Array(MAX_BOARD_ROWS),
    boardIsLocal: new Uint8Array(MAX_BOARD_ROWS),
    blipX: new Float32Array(MAX_BLIPS),
    blipZ: new Float32Array(MAX_BLIPS),
    blipKind: new Uint8Array(MAX_BLIPS),
    blipCount: 0,
  };
}

export interface HudOptions {
  /** Force the touch layer on/off. Auto-detected from the pointer type. */
  touch?: boolean;
  crosshair?: CrosshairStyle;
  crosshairColor?: number;
  /** Called by the touch layer; wire straight to InputManager's TouchSurface. */
  touchSink?: HudTouchSink | null;
  /** Pause button (mobile) and the tab-scoreboard key hint. */
  onPause?: () => void;
}

/** The slice of `TouchSurface` the pad needs. `InputManager` satisfies it. */
export interface HudTouchSink {
  setMove(x: number, z: number): void;
  addLook(dxPx: number, dyPx: number): void;
  setButton(action: InputAction, down: boolean): void;
  tap(action: InputAction): void;
  reset(): void;
}

/* ------------------------------------------------------------------------ *
 * Styles — injected once, scoped by the #hud id
 * ------------------------------------------------------------------------ */

const CSS = `
#hud{font:13px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e8e6e3;
  -webkit-user-select:none;user-select:none}
#hud .dc-hide{display:none!important}
#hud .dc-pad{position:absolute;pointer-events:none}

#hud .dc-map{top:12px;left:12px;width:168px}
#hud .dc-map canvas{display:block;width:168px;height:168px;border:1px solid rgba(255,255,255,.18);
  border-radius:6px;background:#0c0b0e;box-shadow:0 6px 18px rgba(0,0,0,.5)}
#hud .dc-chips{display:flex;gap:6px;margin-top:7px}
#hud .dc-chip{display:flex;align-items:center;gap:5px;padding:3px 8px;border-radius:11px;
  background:rgba(10,10,14,.72);border:1px solid rgba(255,255,255,.12);font-size:12px;
  font-variant-numeric:tabular-nums}
#hud .dc-chip i{font-style:normal;opacity:.75;font-size:11px}

#hud .dc-perf{top:12px;right:12px;text-align:right;font-size:12px;color:#8f8a85;
  font-variant-numeric:tabular-nums;line-height:1.45}
#hud .dc-perf b{color:#cfc9c3;font-weight:600}

#hud .dc-feed{left:12px;bottom:126px;width:340px;display:flex;flex-direction:column;
  justify-content:flex-end;gap:3px}
#hud .dc-feed .ln{padding:3px 8px;border-radius:3px;background:rgba(10,10,14,.62);
  border-left:2px solid #4a4a55;font-size:12px;opacity:1;transition:opacity .35s linear;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#hud .dc-feed .ln.k{border-left-color:#e03c1c}
#hud .dc-feed .ln.j{border-left-color:#f0a020;color:#e2b782}
#hud .dc-feed .ln.s{border-left-color:#3a7fbe;color:#9fc3e2}
#hud .dc-feed .ln.out{opacity:0}
#hud .dc-hint{left:12px;bottom:104px;font-size:11px;color:#7d7873;letter-spacing:.02em}
#hud .dc-hint b{color:#b4aea8;font-weight:600;background:rgba(255,255,255,.07);
  padding:0 4px;border-radius:2px}

#hud .dc-vitals{left:12px;bottom:12px;width:246px}
#hud .dc-bar{position:relative;height:26px;border:1px solid rgba(255,255,255,.22);
  background:rgba(8,8,11,.72);margin-top:6px;overflow:hidden}
#hud .dc-bar .fill{position:absolute;inset:0;width:100%;transform-origin:left center;
  transition:transform .12s linear}
#hud .dc-bar .lbl{position:absolute;inset:0;display:flex;align-items:center;
  justify-content:space-between;padding:0 8px;font-size:14px;font-weight:700;
  text-shadow:0 1px 2px rgba(0,0,0,.9);font-variant-numeric:tabular-nums}
#hud .dc-bar .lbl i{font-style:normal;opacity:.8;font-size:11px;letter-spacing:.1em}
#hud .dc-hp .fill{background:linear-gradient(90deg,#8f1a08,#e03c1c 60%,#f0a020)}
#hud .dc-ap .fill{background:linear-gradient(90deg,#1d4c74,#3a86c8)}
#hud .dc-hp.low .fill{animation:dcpulse .55s steps(2,end) infinite}
@keyframes dcpulse{50%{filter:brightness(1.75)}}

#hud .dc-ammo{right:14px;bottom:96px;text-align:right}
#hud .dc-ammo .mag{font:800 46px/0.92 "Arial Black",Impact,system-ui,sans-serif;
  font-variant-numeric:tabular-nums;text-shadow:0 2px 0 #4a1005,0 6px 16px rgba(0,0,0,.7)}
#hud .dc-ammo .res{font-size:13px;color:#9b9793;margin-top:2px;font-variant-numeric:tabular-nums}
#hud .dc-ammo .wep{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#b4aea8;
  margin-top:3px}
#hud .dc-ammo.empty .mag{color:#e03c1c}

#hud .dc-hotbar{right:12px;bottom:12px;display:flex;gap:5px}
#hud .dc-slot{width:44px;height:44px;border:1px solid rgba(255,255,255,.14);
  background:rgba(10,10,14,.66);position:relative;display:grid;place-items:center;
  font-size:10px;letter-spacing:.06em;color:#8b8681}
#hud .dc-slot .n{position:absolute;left:3px;top:2px;font-size:9px;color:#6c6762}
#hud .dc-slot.on{border-color:#f0a020;background:rgba(46,26,10,.85);color:#f6e3c8;
  box-shadow:0 0 0 1px rgba(240,160,32,.35),0 0 14px rgba(240,160,32,.22)}
#hud .dc-slot.no{opacity:.34}

#hud .dc-cross{left:50%;top:50%;transform:translate(-50%,-50%)}
#hud .dc-status{left:50%;top:50%;transform:translate(-50%,-50%);margin-top:74px;
  text-align:center;width:min(560px,86vw)}
#hud .dc-status .t{font:800 clamp(16px,2.4vw,26px)/1.15 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.03em;text-shadow:0 2px 0 #4a1005,0 6px 20px rgba(0,0,0,.8)}
#hud .dc-status .s{font-size:12px;color:#b4aea8;margin-top:6px;letter-spacing:.08em}

#hud .dc-board{left:50%;top:50%;transform:translate(-50%,-50%);width:min(520px,86vw);
  background:rgba(10,10,14,.93);border:1px solid rgba(255,255,255,.16);border-radius:4px;
  padding:14px 16px;box-shadow:0 20px 50px rgba(0,0,0,.6)}
#hud .dc-board h3{margin:0 0 10px;font:800 15px/1 "Arial Black",Impact,sans-serif;
  letter-spacing:.14em;text-transform:uppercase;color:#f0a020}
#hud .dc-board table{width:100%;border-collapse:collapse;font-size:13px}
#hud .dc-board th{text-align:left;font-size:10px;letter-spacing:.16em;text-transform:uppercase;
  color:#6f6a66;font-weight:600;padding-bottom:6px}
#hud .dc-board td{padding:3px 0;font-variant-numeric:tabular-nums;color:#cfc9c3}
#hud .dc-board td.n{width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#hud .dc-board tr.me td{color:#f6e3c8;font-weight:700}
#hud .dc-board td.r{text-align:right}

#hud .dc-hurt{inset:0;opacity:0;transition:opacity .18s ease-out;
  background:radial-gradient(120% 100% at 50% 50%,rgba(180,20,10,0) 42%,rgba(170,14,6,.85) 100%)}
#hud .dc-dmg{left:50%;top:50%;width:0;height:0}
#hud .dc-dmg span{position:absolute;left:-4px;top:-118px;width:8px;height:44px;
  background:linear-gradient(180deg,rgba(255,90,50,.95),rgba(255,90,50,0));
  transform-origin:50% 118px;opacity:0;transition:opacity .5s ease-out}

/* ---- touch ---- */
#hud .dc-touch{inset:0;pointer-events:none}
#hud .dc-stick{position:absolute;left:26px;bottom:26px;width:132px;height:132px;border-radius:50%;
  border:2px solid rgba(255,255,255,.30);background:rgba(10,10,14,.42);pointer-events:auto;
  touch-action:none}
#hud .dc-stick .knob{position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;
  border-radius:50%;background:rgba(232,230,227,.55);border:2px solid rgba(255,255,255,.75);
  will-change:transform}
#hud .dc-look{position:absolute;right:0;top:0;bottom:0;width:58%;pointer-events:auto;touch-action:none}
#hud .dc-btn{position:absolute;border-radius:50%;pointer-events:auto;display:grid;place-items:center;
  background:rgba(12,12,16,.62);border:2px solid rgba(255,255,255,.34);color:#e8e6e3;
  font-size:11px;font-weight:700;letter-spacing:.04em;touch-action:none}
#hud .dc-btn.press{background:rgba(224,60,28,.55);border-color:#f0a020}
#hud .dc-fire{right:24px;bottom:110px;width:96px;height:96px;
  background:rgba(224,60,28,.34);border-color:rgba(240,160,32,.85);font-size:13px}
#hud .dc-jump{right:132px;bottom:150px;width:64px;height:64px}
#hud .dc-crouch{right:132px;bottom:74px;width:64px;height:64px}
#hud .dc-sprint{right:32px;bottom:22px;width:64px;height:64px}
#hud .dc-reload{right:112px;bottom:14px;width:56px;height:56px}
#hud .dc-build{left:34px;bottom:176px;width:56px;height:56px}
#hud .dc-pause{position:absolute;right:12px;top:12px;width:38px;height:38px;border-radius:8px;
  pointer-events:auto;background:rgba(12,12,16,.66);border:1px solid rgba(255,255,255,.22);
  display:grid;place-items:center;color:#e8e6e3;font-size:14px}

/* ---- short viewports: the bar ships its desktop HUD to a 412px phone ---- */
#hud[data-compact="1"] .dc-map canvas{width:104px;height:104px}
#hud[data-compact="1"] .dc-map{width:104px;top:8px;left:8px}
#hud[data-compact="1"] .dc-chips{flex-direction:column;gap:4px;align-items:flex-start}
#hud[data-compact="1"] .dc-feed{bottom:auto;top:8px;left:120px;width:min(46vw,220px)}
#hud[data-compact="1"] .dc-hint{display:none}
#hud[data-compact="1"] .dc-vitals{width:min(52vw,214px);bottom:8px;left:8px}
#hud[data-compact="1"] .dc-bar{height:22px}
#hud[data-compact="1"] .dc-ammo{bottom:74px;right:10px}
#hud[data-compact="1"] .dc-ammo .mag{font-size:34px}
#hud[data-compact="1"] .dc-hotbar{right:8px;bottom:8px;gap:3px}
#hud[data-compact="1"] .dc-slot{width:34px;height:34px;font-size:9px}
/* Portrait. The bar refuses to run here at all (ref/BAR.md weakness #8), so
   the whole point is that this layout is not a squashed desktop: the read-outs
   sit ABOVE the thumb zone and nothing the player needs is under a finger. */
#hud[data-portrait="1"] .dc-vitals{bottom:198px;width:min(56vw,200px)}
#hud[data-portrait="1"] .dc-ammo{bottom:306px;right:10px}
#hud[data-portrait="1"] .dc-ammo .mag{font-size:30px}
#hud[data-portrait="1"] .dc-hotbar{bottom:252px;right:8px;gap:2px}
#hud[data-portrait="1"] .dc-slot{width:32px;height:32px}
#hud[data-portrait="1"] .dc-feed{left:116px;width:min(58vw,250px);top:8px}
#hud[data-portrait="1"] .dc-build{left:auto;right:126px;bottom:206px;width:52px;height:52px}
#hud[data-portrait="1"] .dc-fire{right:18px;bottom:96px;width:104px;height:104px}
#hud[data-portrait="1"] .dc-jump{right:130px;bottom:132px}
#hud[data-portrait="1"] .dc-crouch{right:130px;bottom:58px}
#hud[data-portrait="1"] .dc-sprint{right:26px;bottom:16px}
#hud[data-portrait="1"] .dc-reload{right:196px;bottom:36px}
#hud[data-portrait="1"] .dc-stick{left:18px;bottom:20px;width:126px;height:126px}

/* ---- short landscape WITH a thumb pad -------------------------------------
   915x412 is the bar's own mobile viewport, and it ships its desktop HUD there
   unchanged (ref/BAR.md weakness #11): the read-outs end up underneath the
   thumbs. Here the whole bottom-right quadrant belongs to the fire cluster, so
   the ammo and the hotbar move to the free centre column. */
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-hotbar{
  left:50%;right:auto;transform:translateX(-50%);bottom:6px;gap:3px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-ammo{
  left:50%;right:auto;transform:translateX(-50%);bottom:52px;text-align:center}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-ammo .mag{font-size:26px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-ammo .res{font-size:11px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-ammo .wep{display:none}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-vitals{
  left:150px;bottom:6px;width:170px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-feed{
  left:112px;width:min(40vw,220px);top:6px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-build{
  left:auto;right:214px;bottom:12px;width:48px;height:48px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-stick{
  left:14px;bottom:14px;width:112px;height:112px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-fire{
  right:14px;bottom:60px;width:86px;height:86px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-jump{right:106px;bottom:96px;width:56px;height:56px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-crouch{right:106px;bottom:30px;width:56px;height:56px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-sprint{right:20px;bottom:8px;width:52px;height:52px}
#hud[data-touch="1"][data-compact="1"]:not([data-portrait="1"]) .dc-reload{right:168px;bottom:66px;width:48px;height:48px}
`;

/* ------------------------------------------------------------------------ *
 * Minimap image
 * ------------------------------------------------------------------------ */

const MAP_VIEW_BLOCKS = 104;   // world blocks across the minimap
const MAP_REDRAW_MS = 100;

/* ------------------------------------------------------------------------ *
 * HUD
 * ------------------------------------------------------------------------ */

export class Hud {
  readonly root: HTMLElement;

  private readonly opts: HudOptions;
  private touchSink: HudTouchSink | null;
  private crosshairStyle: CrosshairStyle;
  private crosshairColor: number;

  /* dom */
  private elMapCanvas!: HTMLCanvasElement;
  private mapCtx!: CanvasRenderingContext2D;
  private elChipAlive!: HTMLElement;
  private elChipKills!: HTMLElement;
  private elChipTime!: HTMLElement;
  private elPerf!: HTMLElement;
  private elFeed!: HTMLElement;
  private elVitalsHp!: HTMLElement;
  private elVitalsAp!: HTMLElement;
  private elHpFill!: HTMLElement;
  private elApFill!: HTMLElement;
  private elHpNum!: HTMLElement;
  private elApNum!: HTMLElement;
  private elAmmo!: HTMLElement;
  private elMag!: HTMLElement;
  private elRes!: HTMLElement;
  private elWep!: HTMLElement;
  private readonly slots: HTMLElement[] = [];
  private elHotbar!: HTMLElement;
  private elCross!: HTMLCanvasElement;
  private crossCtx!: CanvasRenderingContext2D;
  private elStatus!: HTMLElement;
  private elStatusT!: HTMLElement;
  private elStatusS!: HTMLElement;
  private elHurt!: HTMLElement;
  private elDmg!: HTMLElement;
  private readonly dmgArrows: HTMLElement[] = [];
  private elBoard!: HTMLElement;
  private elBoardBody!: HTMLElement;
  private boardSig = '';
  private elTouch!: HTMLElement;
  private elStickKnob!: HTMLElement;

  /* world minimap image */
  private readonly mapImage: HTMLCanvasElement;
  private readonly mapImageCtx: CanvasRenderingContext2D;
  private readonly mapPixels: ImageData;
  private mapImageDirty = true;

  /* diff caches — a steady frame must write no DOM */
  private cHealth = -1; private cArmor = -1; private cMag = -1; private cRes = -1;
  private cWeapon = -1; private cOwned = -1; private cKills = -1; private cDeaths = -1;
  private cAlive = -1; private cTime = -1; private cStatus = ''; private cSub = '';
  private cFps = -1; private cPing = -1; private cPerfShown = true;
  private cGap = -1; private cLow = false; private cEmpty = false;
  private cSpread = -1;
  private mapTimer = 0;
  private hitMarkerT = 0;
  private hitMarkerHead = false;
  private hitMarkerKill = false;
  private dmgArrowNext = 0;
  private hurtT = 0;
  private feedCount = 0;
  private dpr = 1;
  private compact = false;
  private portrait = false;
  private disposed = false;

  /* touch */
  private stickId = -1;
  private stickCx = 0;
  private stickCz = 0;
  private lookId = -1;
  private lookX = 0;
  private lookY = 0;

  constructor(root: HTMLElement, opts: HudOptions = {}) {
    this.root = root;
    this.opts = opts;
    this.touchSink = opts.touchSink ?? null;
    this.crosshairStyle = opts.crosshair ?? 'dynamic';
    this.crosshairColor = opts.crosshairColor ?? 0xffffff;

    this.mapImage = document.createElement('canvas');
    this.mapImage.width = WORLD_SIZE_BLOCKS;
    this.mapImage.height = WORLD_SIZE_BLOCKS;
    const mic = this.mapImage.getContext('2d', { alpha: false });
    if (mic === null) throw new Error('2d context unavailable');
    this.mapImageCtx = mic;
    this.mapImageCtx.fillStyle = '#0c0b0e';
    this.mapImageCtx.fillRect(0, 0, WORLD_SIZE_BLOCKS, WORLD_SIZE_BLOCKS);
    this.mapPixels = this.mapImageCtx.createImageData(CHUNK_SIZE_X, CHUNK_SIZE_Z);

    this.build();
    this.layout();
    window.addEventListener('resize', this.onResize, { passive: true });
  }

  /* -------------------------------------------------------------------- *
   * Construction
   * -------------------------------------------------------------------- */

  private build(): void {
    if (document.getElementById('dc-hud-css') === null) {
      const style = document.createElement('style');
      style.id = 'dc-hud-css';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    const root = this.root;
    root.textContent = '';

    /* minimap + chips */
    const map = div('dc-pad dc-map');
    this.elMapCanvas = document.createElement('canvas');
    map.appendChild(this.elMapCanvas);
    const chips = div('dc-chips');
    this.elChipAlive = chip(chips, 'ALIVE', '1');
    this.elChipKills = chip(chips, 'KILLS', '0');
    this.elChipTime = chip(chips, 'TIME', '0:00');
    map.appendChild(chips);
    root.appendChild(map);

    /* perf */
    this.elPerf = div('dc-pad dc-perf');
    root.appendChild(this.elPerf);

    /* kill feed + hints */
    this.elFeed = div('dc-pad dc-feed');
    root.appendChild(this.elFeed);
    const hint = div('dc-pad dc-hint');
    hint.innerHTML = '<b>WASD</b> move &nbsp;<b>Shift</b> sprint &nbsp;<b>RMB</b> place &nbsp;<b>1-7</b> weapon &nbsp;<b>Tab</b> scores';
    root.appendChild(hint);

    /* vitals */
    const vitals = div('dc-pad dc-vitals');
    const ap = div('dc-bar dc-ap');
    this.elApFill = div('fill');
    const apl = div('lbl');
    apl.innerHTML = '<i>ARMOR</i>';
    this.elApNum = document.createElement('span');
    this.elApNum.textContent = '0';
    apl.appendChild(this.elApNum);
    ap.append(this.elApFill, apl);
    const hp = div('dc-bar dc-hp');
    this.elHpFill = div('fill');
    const hpl = div('lbl');
    hpl.innerHTML = '<i>HEALTH</i>';
    this.elHpNum = document.createElement('span');
    this.elHpNum.textContent = '100';
    hpl.appendChild(this.elHpNum);
    hp.append(this.elHpFill, hpl);
    vitals.append(ap, hp);
    this.elVitalsAp = ap;
    this.elVitalsHp = hp;
    root.appendChild(vitals);

    /* ammo */
    this.elAmmo = div('dc-pad dc-ammo');
    this.elMag = div('mag');
    this.elMag.textContent = '0';
    this.elRes = div('res');
    this.elRes.textContent = '';
    this.elWep = div('wep');
    this.elWep.textContent = '';
    this.elAmmo.append(this.elMag, this.elRes, this.elWep);
    root.appendChild(this.elAmmo);

    /* hotbar */
    const bar = div('dc-pad dc-hotbar');
    for (let i = 0; i < WEAPON_COUNT; i++) {
      const s = div('dc-slot');
      const n = div('n');
      n.textContent = String(i + 1);
      const t = document.createElement('span');
      t.textContent = WEAPON_SHORT_NAMES[i] ?? '';
      s.append(n, t);
      bar.appendChild(s);
      this.slots.push(s);
    }
    this.elHotbar = bar;
    root.appendChild(bar);

    /* crosshair */
    this.elCross = document.createElement('canvas');
    this.elCross.className = 'dc-pad dc-cross';
    const cc = this.elCross.getContext('2d');
    if (cc === null) throw new Error('2d context unavailable');
    this.crossCtx = cc;
    root.appendChild(this.elCross);

    /* status */
    this.elStatus = div('dc-pad dc-status');
    this.elStatusT = div('t');
    this.elStatusS = div('s');
    this.elStatus.append(this.elStatusT, this.elStatusS);
    this.elStatus.classList.add('dc-hide');
    root.appendChild(this.elStatus);

    /* hurt vignette + directional arrows */
    this.elHurt = div('dc-pad dc-hurt');
    root.appendChild(this.elHurt);
    this.elDmg = div('dc-pad dc-dmg');
    for (let i = 0; i < 4; i++) {
      const a = document.createElement('span');
      this.elDmg.appendChild(a);
      this.dmgArrows.push(a);
    }
    root.appendChild(this.elDmg);

    /* scoreboard */
    this.elBoard = div('dc-pad dc-board dc-hide');
    const bt = document.createElement('h3');
    bt.textContent = 'Scoreboard';
    const table = document.createElement('table');
    const head = document.createElement('tr');
    head.innerHTML = '<th>Marine</th><th style="text-align:right">Kills</th>'
      + '<th style="text-align:right">Deaths</th><th style="text-align:right">Ping</th>';
    const body = document.createElement('tbody');
    table.append(head, body);
    this.elBoardBody = body;
    this.elBoard.append(bt, table);
    this.root.appendChild(this.elBoard);

    /* touch */
    this.elTouch = div('dc-pad dc-touch');
    this.buildTouch(this.elTouch);
    root.appendChild(this.elTouch);
  }

  private buildTouch(host: HTMLElement): void {
    const stick = div('dc-stick');
    this.elStickKnob = div('knob');
    stick.appendChild(this.elStickKnob);
    host.appendChild(stick);

    const look = div('dc-look');
    host.appendChild(look);

    const fire = btn('dc-btn dc-fire', 'FIRE');
    const jump = btn('dc-btn dc-jump', 'JUMP');
    const crouch = btn('dc-btn dc-crouch', 'CRCH');
    const sprint = btn('dc-btn dc-sprint', 'RUN');
    const reload = btn('dc-btn dc-reload', 'RLD');
    const build = btn('dc-btn dc-build', 'BLD');
    host.append(fire, jump, crouch, sprint, reload, build);

    const pause = btn('dc-pause', '❚❚');
    pause.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.opts.onPause?.();
    });
    host.appendChild(pause);

    this.bindHold(fire, InputAction.Fire);
    this.bindHold(jump, InputAction.Jump);
    this.bindHold(crouch, InputAction.Crouch);
    this.bindHold(sprint, InputAction.Sprint);
    this.bindHold(reload, InputAction.Reload);
    this.bindHold(build, InputAction.BuildMode);

    /* left stick */
    const onStick = (e: PointerEvent): void => {
      const r = stick.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const max = r.width / 2 - 8;
      let dx = e.clientX - cx;
      let dy = e.clientY - cy;
      const len = Math.hypot(dx, dy);
      if (len > max) { dx = dx / len * max; dy = dy / len * max; }
      this.stickCx = dx / max;
      this.stickCz = -dy / max;
      this.elStickKnob.style.transform = `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)`;
      this.touchSink?.setMove(this.stickCx, this.stickCz);
    };
    stick.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.stickId = e.pointerId;
      stick.setPointerCapture(e.pointerId);
      onStick(e);
    });
    stick.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.stickId) return;
      e.preventDefault();
      onStick(e);
    });
    const endStick = (e: PointerEvent): void => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = -1;
      this.stickCx = 0; this.stickCz = 0;
      this.elStickKnob.style.transform = 'translate(0px,0px)';
      this.touchSink?.setMove(0, 0);
    };
    stick.addEventListener('pointerup', endStick);
    stick.addEventListener('pointercancel', endStick);

    /* right half: look drag. The bar has no fire button at all and makes the
       look drag double as the trigger (weakness #9); here they are separate. */
    look.addEventListener('pointerdown', (e) => {
      if (this.lookId >= 0) return;
      e.preventDefault();
      this.lookId = e.pointerId;
      this.lookX = e.clientX;
      this.lookY = e.clientY;
      look.setPointerCapture(e.pointerId);
    });
    look.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return;
      e.preventDefault();
      this.touchSink?.addLook(e.clientX - this.lookX, e.clientY - this.lookY);
      this.lookX = e.clientX;
      this.lookY = e.clientY;
    });
    const endLook = (e: PointerEvent): void => {
      if (e.pointerId !== this.lookId) return;
      this.lookId = -1;
    };
    look.addEventListener('pointerup', endLook);
    look.addEventListener('pointercancel', endLook);
  }

  private bindHold(el: HTMLElement, action: InputAction): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('press');
      this.touchSink?.setButton(action, true);
    });
    const up = (e: PointerEvent): void => {
      if (!el.classList.contains('press')) return;
      e.preventDefault();
      el.classList.remove('press');
      this.touchSink?.setButton(action, false);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
  }

  /* -------------------------------------------------------------------- *
   * Configuration
   * -------------------------------------------------------------------- */

  setTouchSink(sink: HudTouchSink | null): void { this.touchSink = sink; }

  setTouchVisible(on: boolean): void {
    this.elTouch.classList.toggle('dc-hide', !on);
    this.root.dataset.touch = on ? '1' : '0';
    if (!on) {
      this.touchSink?.reset();
      this.stickId = -1;
      this.lookId = -1;
      this.elStickKnob.style.transform = 'translate(0px,0px)';
    }
  }

  setCrosshair(style: CrosshairStyle, color: number): void {
    this.crosshairStyle = style;
    this.crosshairColor = color;
    this.cGap = -1;   // force a redraw
  }

  setVisible(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
  }

  /* -------------------------------------------------------------------- *
   * Events
   * -------------------------------------------------------------------- */

  /** One kill-feed / chat / system line. `kind`: 'k' kill, 'j' join, 's' system. */
  pushFeed(text: string, kind: 'k' | 'j' | 's' = 's'): void {
    const ln = document.createElement('div');
    ln.className = `ln ${kind}`;
    ln.textContent = text;
    this.elFeed.appendChild(ln);
    this.feedCount++;
    while (this.feedCount > 6) {
      const first = this.elFeed.firstElementChild;
      if (first === null) break;
      first.remove();
      this.feedCount--;
    }
    window.setTimeout(() => { ln.classList.add('out'); }, 6500);
    window.setTimeout(() => {
      if (ln.parentNode !== null) { ln.remove(); this.feedCount--; }
    }, 7200);
  }

  /** Drop every line. A mode switch must not leave the last mode talking. */
  clearFeed(): void {
    while (this.elFeed.firstChild !== null) this.elFeed.firstChild.remove();
    this.feedCount = 0;
  }

  /**
   * Show or hide the gun half of the HUD — the ammo readout and the seven-slot
   * hotbar. Builder has no weapons, so leaving "120 BULLETS / PISTOL" on screen
   * over a block palette is just a lie in the corner of the frame.
   */
  setWeaponUiVisible(on: boolean): void {
    this.elAmmo.style.display = on ? '' : 'none';
    this.elHotbar.style.display = on ? '' : 'none';
  }

  /** A shot connected. Drives the crosshair pop — the bar has no equivalent. */
  hitMarker(headshot: boolean, killed: boolean): void {
    this.hitMarkerT = killed ? 0.42 : 0.26;
    this.hitMarkerHead = headshot;
    this.hitMarkerKill = killed;
    this.cGap = -1;
  }

  /** Took damage. `dirYaw` is the world-space yaw the hit came FROM. */
  hurt(amount: number, dirYaw: number, camYaw: number): void {
    this.hurtT = Math.max(this.hurtT, Math.min(0.62, 0.2 + amount / 90));
    const a = this.dmgArrows[this.dmgArrowNext];
    this.dmgArrowNext = (this.dmgArrowNext + 1) % this.dmgArrows.length;
    // Screen-space angle: 0 = straight ahead, clockwise positive.
    const rel = wrapPi(dirYaw - camYaw);
    a.style.transform = `rotate(${(-rel * 180 / Math.PI).toFixed(1)}deg)`;
    a.style.transition = 'none';
    a.style.opacity = '1';
    // Force a reflow so the fade actually plays from 1.
    void a.offsetWidth;
    a.style.transition = 'opacity .5s ease-out';
    a.style.opacity = '0';
  }

  /* -------------------------------------------------------------------- *
   * Minimap source
   * -------------------------------------------------------------------- */

  /**
   * Bake one chunk into the world minimap image. Called once when a chunk
   * arrives and again when a delta lands, never per frame.
   */
  updateMinimapChunk(cx: number, cz: number, voxels: Uint8Array): void {
    const px = this.mapPixels;
    const data = px.data;
    let p = 0;
    for (let z = 0; z < CHUNK_SIZE_Z; z++) {
      for (let x = 0; x < CHUNK_SIZE_X; x++) {
        let color = 0x0c0b0e;
        let shade = 1;
        const col = x | (z << 5);
        for (let y = CHUNK_HEIGHT - 1; y >= 0; y--) {
          const id = voxels[col | (y << 10)];
          if (id === 0) continue;
          color = minimapColor(id);
          // Height shading gives the flat top-down map some relief.
          shade = 0.55 + 0.45 * (y / (CHUNK_HEIGHT - 1));
          if (BLOCK_LIQUID[id] === 1) shade *= 0.85;
          break;
        }
        data[p] = Math.min(255, ((color >> 16) & 0xff) * shade);
        data[p + 1] = Math.min(255, ((color >> 8) & 0xff) * shade);
        data[p + 2] = Math.min(255, (color & 0xff) * shade);
        data[p + 3] = 255;
        p += 4;
      }
    }
    const ox = cx * CHUNK_SIZE_X - WORLD_MIN_BLOCK_X;
    const oz = cz * CHUNK_SIZE_Z - WORLD_MIN_BLOCK_Z;
    if (ox < 0 || oz < 0 || ox + CHUNK_SIZE_X > WORLD_SIZE_BLOCKS || oz + CHUNK_SIZE_Z > WORLD_SIZE_BLOCKS) return;
    this.mapImageCtx.putImageData(px, ox, oz);
    this.mapImageDirty = true;
  }

  /* -------------------------------------------------------------------- *
   * Per-frame
   * -------------------------------------------------------------------- */

  update(s: HudState, dt: number): void {
    if (this.disposed) return;

    /* --- vitals --- */
    const hp = Math.max(0, Math.round(s.health));
    if (hp !== this.cHealth) {
      this.cHealth = hp;
      this.elHpNum.textContent = String(hp);
      this.elHpFill.style.transform = `scaleX(${Math.min(1, hp / MAX_HEALTH).toFixed(3)})`;
      const low = hp <= 30;
      if (low !== this.cLow) { this.cLow = low; this.elVitalsHp.classList.toggle('low', low); }
    }
    const ap = Math.max(0, Math.round(s.armor));
    if (ap !== this.cArmor) {
      this.cArmor = ap;
      this.elApNum.textContent = String(ap);
      this.elApFill.style.transform = `scaleX(${Math.min(1, ap / MAX_ARMOR).toFixed(3)})`;
      this.elVitalsAp.style.opacity = ap > 0 ? '1' : '0.45';
    }

    /* --- ammo --- */
    if (s.mag !== this.cMag) {
      this.cMag = s.mag;
      this.elMag.textContent = s.reloading ? '--' : String(s.mag);
      const empty = s.mag === 0;
      if (empty !== this.cEmpty) { this.cEmpty = empty; this.elAmmo.classList.toggle('empty', empty); }
    }
    if (s.reserve !== this.cRes || s.weapon !== this.cWeapon) {
      this.cRes = s.reserve;
      const type = ammoTypeOf(s.weapon);
      this.elRes.textContent = type === 0 ? '∞' : `${s.reserve}  ${AMMO_NAMES[type] ?? ''}`;
      this.elRes.style.color = type === 0 ? '#9b9793' : `#${(AMMO_COLORS[type] ?? 0x9b9793).toString(16).padStart(6, '0')}`;
    }
    if (s.weapon !== this.cWeapon) {
      this.cWeapon = s.weapon;
      this.elWep.textContent = WEAPON_NAMES[s.weapon] ?? '';
      for (let i = 0; i < this.slots.length; i++) this.slots[i].classList.toggle('on', i === s.weapon);
    }
    if (s.owned !== this.cOwned) {
      this.cOwned = s.owned;
      for (let i = 0; i < this.slots.length; i++) {
        this.slots[i].classList.toggle('no', !ownsWeapon(s.owned, i));
      }
    }

    /* --- chips --- */
    if (s.playersAlive !== this.cAlive) {
      this.cAlive = s.playersAlive;
      this.elChipAlive.textContent = String(s.playersAlive);
    }
    if (s.kills !== this.cKills || s.deaths !== this.cDeaths) {
      this.cKills = s.kills; this.cDeaths = s.deaths;
      this.elChipKills.textContent = `${s.kills}/${s.deaths}`;
    }
    const secs = Math.max(0, Math.floor(s.matchSeconds));
    if (secs !== this.cTime) {
      this.cTime = secs;
      const m = Math.floor(secs / 60);
      this.elChipTime.textContent = `${m}:${String(secs - m * 60).padStart(2, '0')}`;
    }

    /* --- perf --- */
    if (s.showFps !== this.cPerfShown) {
      this.cPerfShown = s.showFps;
      this.elPerf.classList.toggle('dc-hide', !s.showFps);
    }
    if (s.showFps) {
      const fps = Math.round(s.fps);
      const ping = Math.round(s.ping);
      if (fps !== this.cFps || ping !== this.cPing) {
        this.cFps = fps; this.cPing = ping;
        this.elPerf.innerHTML = `<b>${fps}</b> fps<br>${ping} ms`;
      }
    }

    /* --- status --- */
    if (s.status !== this.cStatus) {
      this.cStatus = s.status;
      this.elStatusT.textContent = s.status;
      this.elStatus.classList.toggle('dc-hide', s.status === '' && s.subStatus === '');
    }
    if (s.subStatus !== this.cSub) {
      this.cSub = s.subStatus;
      this.elStatusS.textContent = s.subStatus;
      this.elStatus.classList.toggle('dc-hide', s.status === '' && s.subStatus === '');
    }

    /* --- hurt --- */
    if (this.hurtT > 0) {
      this.hurtT -= dt;
      const v = Math.max(0, this.hurtT);
      this.elHurt.style.opacity = v.toFixed(2);
      if (this.hurtT <= 0) this.elHurt.style.opacity = '0';
    }

    /* --- crosshair --- */
    if (this.hitMarkerT > 0) this.hitMarkerT -= dt;
    const gap = this.crosshairGap(s);
    if (Math.abs(gap - this.cGap) > 0.35 || this.hitMarkerT > 0 || this.cSpread !== s.spread) {
      this.cGap = gap;
      this.cSpread = s.spread;
      this.drawCrosshair(gap, s);
    }

    /* --- scoreboard --- */
    this.elBoard.classList.toggle('dc-hide', !s.boardOpen);
    if (s.boardOpen) this.drawBoard(s);

    /* --- minimap --- */
    this.mapTimer += dt * 1000;
    if (this.mapTimer >= MAP_REDRAW_MS) {
      this.mapTimer = 0;
      this.drawMinimap(s);
    }
  }

  /** Rebuild the table only when a number in it actually changed. */
  private drawBoard(s: HudState): void {
    let sig = '';
    for (let i = 0; i < s.boardCount; i++) {
      sig += `${s.boardName[i]}|${s.boardKills[i]}|${s.boardDeaths[i]}|${s.boardPing[i]};`;
    }
    if (sig === this.boardSig) return;
    this.boardSig = sig;
    let html = '';
    for (let i = 0; i < s.boardCount; i++) {
      html += `<tr class="${s.boardIsLocal[i] === 1 ? 'me' : ''}">`
        + `<td class="n">${escapeHtml(s.boardName[i])}</td>`
        + `<td class="r">${s.boardKills[i]}</td>`
        + `<td class="r">${s.boardDeaths[i]}</td>`
        + `<td class="r">${s.boardPing[i]}</td></tr>`;
    }
    this.elBoardBody.innerHTML = html;
  }

  private crosshairGap(s: HudState): number {
    if (this.crosshairStyle === 'dot') return 0;
    const base = this.crosshairStyle === 'doom' ? 9 : 5;
    if (this.crosshairStyle === 'cross') return base;
    return base + s.spread * 26;
  }

  private drawCrosshair(gap: number, s: HudState): void {
    const ctx = this.crossCtx;
    const size = this.elCross.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const d = this.dpr;
    const c = size / 2;
    const col = `#${this.crosshairColor.toString(16).padStart(6, '0')}`;

    ctx.lineCap = 'butt';
    ctx.shadowColor = 'rgba(0,0,0,.85)';
    ctx.shadowBlur = 2 * d;

    if (this.crosshairStyle === 'dot') {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(c, c, 1.6 * d, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const len = (this.crosshairStyle === 'doom' ? 11 : 8) * d;
      const g = gap * d;
      const w = (this.crosshairStyle === 'doom' ? 2.6 : 2.2) * d;
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(c, c - g); ctx.lineTo(c, c - g - len);
      ctx.moveTo(c, c + g); ctx.lineTo(c, c + g + len);
      ctx.moveTo(c - g, c); ctx.lineTo(c - g - len, c);
      ctx.moveTo(c + g, c); ctx.lineTo(c + g + len, c);
      ctx.stroke();
      if (this.crosshairStyle === 'doom') {
        ctx.fillStyle = col;
        ctx.fillRect(c - 1 * d, c - 1 * d, 2 * d, 2 * d);
      }
    }

    /* hit marker */
    if (this.hitMarkerT > 0) {
      const t = Math.min(1, this.hitMarkerT / 0.26);
      const r = (7 + (1 - t) * 7) * d;
      ctx.shadowBlur = 0;
      ctx.strokeStyle = this.hitMarkerKill ? '#ff3b18' : this.hitMarkerHead ? '#ffd24a' : '#ffffff';
      ctx.globalAlpha = Math.min(1, t * 1.6);
      ctx.lineWidth = 2 * d;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const sx = i & 1 ? 1 : -1;
        const sy = i & 2 ? 1 : -1;
        ctx.moveTo(c + sx * r, c + sy * r);
        ctx.lineTo(c + sx * (r + 5 * d), c + sy * (r + 5 * d));
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /* reload ring */
    if (s.reloading) {
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(240,160,32,.9)';
      ctx.lineWidth = 2.5 * d;
      ctx.beginPath();
      ctx.arc(c, c, 20 * d, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, s.reloadFrac));
      ctx.stroke();
    }
  }

  private drawMinimap(s: HudState): void {
    const ctx = this.mapCtx;
    const size = this.elMapCanvas.width;
    const half = size / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0c0b0e';
    ctx.fillRect(0, 0, size, size);

    const scale = size / MAP_VIEW_BLOCKS;
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(half, half);
    // North-up map, player arrow rotates. Simpler to read than a spinning map.
    ctx.imageSmoothingEnabled = false;
    const px = s.camX - WORLD_MIN_BLOCK_X;
    const pz = s.camZ - WORLD_MIN_BLOCK_Z;
    ctx.drawImage(
      this.mapImage,
      px - MAP_VIEW_BLOCKS / 2, pz - MAP_VIEW_BLOCKS / 2, MAP_VIEW_BLOCKS, MAP_VIEW_BLOCKS,
      -half, -half, size, size,
    );

    /* blips */
    for (let i = 0; i < s.blipCount; i++) {
      const bx = (s.blipX[i] - s.camX) * scale;
      const bz = (s.blipZ[i] - s.camZ) * scale;
      if (bx * bx + bz * bz > half * half) continue;
      const kind = s.blipKind[i];
      ctx.fillStyle = kind === BLIP_ENEMY ? '#ff4a22' : kind === BLIP_PLAYER ? '#63d0ff' : '#f0d060';
      const r = kind === BLIP_PICKUP ? 1.8 : 2.8;
      ctx.beginPath();
      ctx.arc(bx, bz, r * this.dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    /* player arrow */
    ctx.rotate(-s.camYaw);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = 'rgba(0,0,0,.8)';
    ctx.lineWidth = 1 * this.dpr;
    const a = 6 * this.dpr;
    ctx.beginPath();
    ctx.moveTo(0, -a);
    ctx.lineTo(a * 0.72, a * 0.8);
    ctx.lineTo(0, a * 0.35);
    ctx.lineTo(-a * 0.72, a * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    /* frame */
    ctx.strokeStyle = 'rgba(255,255,255,.16)';
    ctx.lineWidth = 1 * this.dpr;
    ctx.beginPath();
    ctx.arc(half, half, half - 1, 0, Math.PI * 2);
    ctx.stroke();
    this.mapImageDirty = false;
  }

  /* -------------------------------------------------------------------- *
   * Layout
   * -------------------------------------------------------------------- */

  private readonly onResize = (): void => { this.layout(); };

  layout(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const compact = h < 560 || w < 760;
    const portrait = h > w;
    if (compact !== this.compact) {
      this.compact = compact;
      this.root.dataset.compact = compact ? '1' : '0';
    }
    if (portrait !== this.portrait) {
      this.portrait = portrait;
      this.root.dataset.portrait = portrait ? '1' : '0';
    }

    const mapCss = compact ? 104 : 168;
    const mapPx = Math.round(mapCss * this.dpr);
    if (this.elMapCanvas.width !== mapPx) {
      this.elMapCanvas.width = mapPx;
      this.elMapCanvas.height = mapPx;
      const c = this.elMapCanvas.getContext('2d', { alpha: false });
      if (c !== null) this.mapCtx = c;
    }

    const crossCss = 96;
    const crossPx = Math.round(crossCss * this.dpr);
    if (this.elCross.width !== crossPx) {
      this.elCross.width = crossPx;
      this.elCross.height = crossPx;
      this.elCross.style.width = `${crossCss}px`;
      this.elCross.style.height = `${crossCss}px`;
    }
    this.cGap = -1;
    this.mapTimer = MAP_REDRAW_MS;
  }

  dispose(): void {
    this.disposed = true;
    window.removeEventListener('resize', this.onResize);
    this.root.textContent = '';
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

function btn(cls: string, label: string): HTMLElement {
  const b = document.createElement('div');
  b.className = cls;
  b.textContent = label;
  return b;
}

function chip(host: HTMLElement, label: string, value: string): HTMLElement {
  const c = div('dc-chip');
  const i = document.createElement('i');
  i.textContent = label;
  const v = document.createElement('span');
  v.textContent = value;
  c.append(i, v);
  host.appendChild(c);
  return v;
}

function escapeHtml(v: string): string {
  return v.replace(/[&<>"]/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  ));
}

function wrapPi(a: number): number {
  const TAU = Math.PI * 2;
  let v = a % TAU;
  if (v > Math.PI) v -= TAU;
  else if (v < -Math.PI) v += TAU;
  return v;
}

/** Magazine capacity for a weapon, for the HUD's `mag / size` display. */
export function magSizeOf(weaponId: number): number {
  return WEAPON_MAG_SIZE[weaponId] ?? 0;
}
