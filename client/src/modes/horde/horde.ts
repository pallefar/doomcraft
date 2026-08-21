/**
 * DOOMCRAFT — HORDE, the mode.
 *
 * `docs/MODES.md` §3 does not give this mode a shipped game to copy, it gives
 * it a test: *"graded on whether the two halves interlock rather than sit next
 * to each other."* So the whole client is arranged around making the interlock
 * visible, and there is exactly one place where it happens:
 *
 *     A Baron stops making progress toward you. It probes the voxel in front of
 *     its face, slides along the wall looking for the end of it, does not find
 *     one, and commits. It winds up — `ES_WINDUP`, which is the same bit that
 *     telegraphs a swing at your body, so you can read it — and hits the block.
 *     The block has hit points because you paid for it. They go down. At zero
 *     the server writes AIR through the ordinary `setBlock` path, which
 *     journals the change, ships a BLOCK_DELTA, bumps `editSerial` and makes
 *     the nav field re-flood through the hole. The pack behind the Baron
 *     repaths — through the gap it just made, at the wall you just lost.
 *
 * Everything on this screen exists to put the player inside that loop:
 *
 *   - **The fortify window is a countdown with a shopping list attached.**
 *     The bar across the top is the clock; the gates the *next* wave will use
 *     are already lit in the world (`waveDirector.ts`'s beacons) and on the
 *     compass, because a wall only matters if the next wave walks into it.
 *   - **Every block has a price, and it is the gun's price.** `economy.ts`
 *     prices the wall side in gates closed and the gun side in seconds off the
 *     wave, from the same wave table the server spawns from. There is no block
 *     budget: the wall and the Rocket Launcher come out of the same number.
 *   - **The breach is an event, not a surprise.** SIEGE puts a marker and a
 *     compass flare on the wall being chewed while it is still standing;
 *     BREACH flashes the hole the moment it opens and spikes the pressure
 *     model. You get told which wall is going, in time to do something.
 *   - **Rockets cut both ways.** Splash carves terrain, so the rocket that
 *     clears a breach also widens it, and the mode says so on the ghost: the
 *     one blast-proof material in the palette is obsidian, at 6.2x stone.
 *
 * ## What this file owns
 *
 *   run structure (build ↔ combat ↔ game over), the phase clock and its UI,
 *   lives and the downed state, the run-end card and the save, the placement
 *   and salvage input path with its ghost, and the wiring that hands the wave
 *   to `waveDirector.ts` and the purse to `economy.ts`.
 *
 * ## What it does not own
 *
 *   Authority. `server/src/horde.ts` runs the phase machine, spawns the waves,
 *   charges the purse off the world's block journal and runs the siege. Nothing
 *   here is trusted: the phase, the clock, the balance, the wave and the lives
 *   are all mirrored from the 40-byte state sidecar, and the local clock is
 *   only used to interpolate between the sidecars (which land at 100 ms
 *   granularity) so the countdown does not stutter.
 *
 * ## Taking the mouse
 *
 * `game.ts` owns a crude build path on the right mouse button that places
 * `PLACEABLE_BLOCKS[private index]`, and it is not this mode's file to change.
 * Horde needs the *material* to be the decision, so it takes the action —
 * `InputManager.setActionTaken(action, true)`, which switches it off at every
 * source rather than at one binding layer, restored through the `ModeScope`
 * ledger on exit — and reads the button from raw DOM events, exactly as
 * `builder.ts` does and for the same reason. It takes only what it must:
 * AltFire and BuildMode always, Fire and the weapon wheel only while the
 * fortify cursor is up, so the guns stay live for the other 90% of the run.
 *
 * ## Cost
 *
 * `update()` is one raycast (only while the cursor is up or the right button is
 * down), a walk of the entity array for the nearest demon, and a set of DOM
 * writes each guarded by a cached previous value. No allocation, no closures
 * per frame. The scene additions are one ghost box, one edge overlay, one siege
 * marker and eight pooled breach flashes, all created at enter and disposed by
 * the scope.
 */

import * as THREE from 'three';

import {
  AMMO_START,
  AMMO_TYPE_COUNT,
  BlockAction,
  BlockId,
  EntityType,
  InputAction,
  MAX_ARMOR,
  MAX_HEALTH,
  PacketWriter,
  ammoTypeOf,
  grantWeapon,
  minimapColor,
} from '@shared';
import {
  ModeAction,
  ModeEventKind,
  ModeId,
  ModePhase,
  SKILL_NAMES,
  clampSkill,
  getMode,
  createModeActionMessage,
  createModeSelectMessage,
  encodeModeAction,
  encodeModeSelect,
  type ModeContextMessage,
  type ModeEventMessage,
  type ModeStateBuffer,
} from '@shared/modes';
import {
  loadSave,
  recordHordeRun,
  storeSave,
  type SaveStorage,
} from '@shared/saves';

import {
  toModeSelectMessage,
  type ModeContext,
  type ModeInstance,
} from '@/modes/registry';

import {
  HordeItem,
  HORDE_EV_BREACH,
  HORDE_EV_DOWNED,
  HORDE_EV_HOLD,
  HORDE_EV_REVIVED,
  HORDE_EV_RUN_OVER,
  HORDE_EV_SIEGE,
  HORDE_ENEMY_COUNT,
  HORDE_GATE_COUNT,
  HORDE_GATE_LONG_NAMES,
  decodeCoord,
  gateIsHot,
} from '@doomcraft/server/src/horde.js';

import {
  Armoury,
  ArmouryPanel,
  DEFAULT_WALL_INDEX,
  FortifyRail,
  HordeWallet,
  PLACE_BROKE,
  PLACE_REFUSALS,
  PlacementPricer,
  WALL_STOCK,
  WalletStrip,
  createShopperState,
  createTradeReadout,
  evaluateTrade,
  installEconomyStyle,
  priceTag,
} from './economy';
import {
  WaveDirectorView,
  describeComposition,
  gateLabel,
  rosterUi,
  waveHeadline,
} from './waveDirector';

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

/** Minimum gap between two edits, matching `game.ts`'s own rate limit. */
export const HORDE_EDIT_INTERVAL_MS = 140;
/** How long the wave banner stays up. */
export const HORDE_BANNER_MS = 2600;
/** How long a breach flash lives. */
export const HORDE_BREACH_MS = 1500;
/** Breach flashes on screen at once. Pooled. */
export const HORDE_BREACH_SLOTS = 8;
/** Fortify clock under this many seconds turns the bar red. */
export const HORDE_CLOCK_URGENT_SEC = 8;
/** The siege marker fades out after this long without a fresh ping. */
export const HORDE_SIEGE_HOLD_MS = 2400;
/** Vertical search window when an event gives x/z but not y. */
const COLUMN_SEARCH = 10;

const STYLE_ID = 'dc-horde-css';

const CSS = `
.dch,.dch *{box-sizing:border-box}
.dch{font:12px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
  color:#c9c4bf;-webkit-user-select:none;user-select:none}

/* ---- compass ribbon (owned by waveDirector.ts, styled here) ---- */
.dch-compass{position:absolute;left:50%;top:4px;transform:translateX(-50%);
  width:min(84vw,620px);height:16px;pointer-events:none}
.dch-compass .dch-tick{position:absolute;top:0;transform:translateX(-50%);
  font:600 10px/16px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;
  color:#7d7873;white-space:nowrap}
.dch-compass .dch-tick.hot{color:#f0a020}
.dch-compass.armed .dch-tick.hot{color:#ffb733;text-shadow:0 0 8px rgba(240,160,32,.8)}

/* ---- phase bar ---- */
.dch-bar{position:absolute;left:50%;top:22px;transform:translateX(-50%);
  width:min(88vw,520px);padding:6px 12px 8px;border-radius:4px;
  background:rgba(10,9,12,.78);border:1px solid rgba(255,255,255,.12);
  box-shadow:0 6px 20px rgba(0,0,0,.5);pointer-events:none}
.dch-bar.off{display:none}
.dch-brow{display:flex;align-items:baseline;gap:10px;white-space:nowrap}
.dch-ph{font:800 13px/1 "Arial Black",Impact,system-ui,sans-serif;letter-spacing:.14em;
  color:#f0c98a;text-shadow:0 2px 0 #40120a}
.dch-bar.live .dch-ph{color:#f09a86}
.dch-bar.urgent .dch-ph{color:#ff6a4a}
.dch-clock{font:650 15px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f4ece0;
  font-variant-numeric:tabular-nums}
.dch-sub{margin-left:auto;font-size:11px;color:#8c8781;overflow:hidden;
  text-overflow:ellipsis}
.dch-track{margin-top:6px;height:4px;border-radius:2px;background:rgba(255,255,255,.10);
  overflow:hidden}
.dch-fill{display:block;height:100%;width:0%;background:#f0a020;
  transition:width .12s linear}
.dch-bar.live .dch-fill{background:#e03c1c}
.dch-bar.urgent .dch-fill{background:#ff6a4a}
.dch-lives{display:flex;gap:3px;align-items:center;margin-left:2px}
.dch-pip{width:9px;height:11px;border-radius:2px;background:#7fc96a;opacity:.9}
.dch-pip.gone{background:rgba(255,255,255,.14)}

/* ---- banner ---- */
.dch-banner{position:absolute;left:50%;top:calc(50% - 120px);transform:translateX(-50%);
  text-align:center;pointer-events:none;opacity:0;transition:opacity .16s linear}
.dch-banner.on{opacity:1}
.dch-banner em{display:block;font:800 30px/1 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.06em;font-style:normal;color:#f4ece0;
  text-shadow:0 3px 0 #40120a,0 6px 22px rgba(0,0,0,.9)}
.dch-banner.hot em{color:#ff7a52}
.dch-banner span{display:block;margin-top:5px;font-size:12.5px;color:#c9c4bf;
  text-shadow:0 2px 6px rgba(0,0,0,.9)}

/* ---- siege alert ---- */
.dch-siege{position:absolute;left:12px;top:calc(50% - 20px);
  padding:6px 10px;border-radius:3px;background:rgba(30,6,4,.86);
  border:1px solid rgba(224,60,28,.62);color:#ffb9a6;pointer-events:none;
  opacity:0;transition:opacity .12s linear;max-width:230px}
.dch-siege.on{opacity:1}
.dch-siege b{display:block;font:800 11px/1.2 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.12em;color:#ff8a68}
.dch-siege span{display:block;margin-top:2px;font-size:11px}

/* ---- ghost price tag ---- */
.dch-tag{position:absolute;left:50%;top:calc(50% + 26px);transform:translateX(-50%);
  padding:3px 9px;border-radius:3px;background:rgba(8,8,11,.82);
  border:1px solid rgba(240,160,32,.5);color:#f0c98a;white-space:nowrap;
  pointer-events:none;font-size:11px;opacity:0;transition:opacity .1s linear}
.dch-tag.on{opacity:1}
.dch-tag.bad{border-color:rgba(224,60,28,.7);color:#ff9a80}

/* ---- touch pads ---- */
.dch-pads{position:absolute;right:10px;top:50%;transform:translateY(-50%);
  display:none;flex-direction:column;gap:8px;pointer-events:auto}
.dch-pads.on{display:flex}
.dch-pad{width:58px;height:44px;border-radius:6px;background:rgba(10,9,12,.72);
  border:1px solid rgba(255,255,255,.22);color:#e8e1d8;font:600 11px/44px sans-serif;
  text-align:center;letter-spacing:.06em}
.dch-pad.hot{border-color:#f0a020;color:#f0c98a;background:rgba(38,24,6,.82)}

/* ---- cards ---- */
.dch-card{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:min(92vw,480px);padding:20px 22px;border-radius:5px;
  background:rgba(10,9,11,.95);border:1px solid rgba(240,160,32,.34);
  box-shadow:0 18px 60px rgba(0,0,0,.7);pointer-events:auto;text-align:center}
.dch-card.off{display:none}
.dch-card h2{margin:0 0 3px;font:800 26px/1 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.06em;color:#ff7a52}
.dch-card.win h2{color:#7fc96a}
.dch-card p{margin:0 0 14px;font-size:12.5px;color:#8c8781}
.dch-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 6px;margin-bottom:16px}
.dch-st{padding:7px 4px;border-radius:3px;background:rgba(255,255,255,.045)}
.dch-st b{display:block;font:650 19px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:#f4ece0;font-variant-numeric:tabular-nums}
.dch-st span{display:block;margin-top:3px;font-size:9.5px;letter-spacing:.1em;color:#7d7873}
.dch-btns{display:flex;gap:8px;justify-content:center}
.dch-btn{flex:1 1 0;min-height:42px;border-radius:4px;border:1px solid rgba(255,255,255,.2);
  background:rgba(255,255,255,.06);color:#e8e1d8;font:600 13px/1 system-ui,sans-serif;
  letter-spacing:.06em;cursor:pointer}
.dch-btn.go{background:#f0a020;border-color:#f0a020;color:#140d02}
.dch-btn:hover{background:rgba(255,255,255,.12)}
.dch-btn.go:hover{background:#ffb733}
.dch-note{margin-top:12px;font-size:11px;color:#7d7873;line-height:1.4}

/* ---- downed ---- */
.dch-down{position:absolute;left:50%;top:calc(50% + 60px);transform:translateX(-50%);
  padding:9px 16px;border-radius:4px;background:rgba(30,6,4,.88);
  border:1px solid rgba(224,60,28,.6);text-align:center;pointer-events:none}
.dch-down.off{display:none}
.dch-down b{display:block;font:800 18px/1 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.1em;color:#ff6a4a}
.dch-down span{display:block;margin-top:4px;font-size:11.5px;color:#e0b8ac}

@media (max-width:760px){
  .dch-bar{width:94vw;top:20px}
  .dch-banner em{font-size:22px}
  /* A 412 px-wide screen has no free left margin at eye level: the siege
     alert would land on the ghost's price tag. It goes under the phase bar,
     where it is also the first thing read. */
  .dch-siege{top:74px;left:8px;right:8px;max-width:none;font-size:11px}
  .dch-grid{grid-template-columns:repeat(2,1fr)}
}
/* A 412 px-tall screen has no room for a vertical stack of pads on the right:
   it lands straight on top of the wallet. Short viewports get a row under the
   phase bar instead, still 44 px tall so a thumb can hit it. */
@media (max-height:560px){
  .dch-bar{top:18px;padding:4px 10px 6px}
  .dch-banner{top:calc(50% - 86px)}
  .dch-banner em{font-size:20px}
  .dch-siege{top:auto;bottom:12px;max-width:200px}
  .dch-pads{top:52px;right:10px;transform:none;flex-direction:row;gap:6px}
  .dch-pad{width:54px;height:44px;line-height:44px}
  .dch-down{top:auto;bottom:64px}
}
`;

/**
 * Bindings the fortify cursor borrows. `game.ts` fires on Mouse0 and cycles
 * weapons on the wheel; while the cursor is up those two do something else.
 */
const CURSOR_SET: readonly InputAction[] = Object.freeze([
  InputAction.Fire, InputAction.NextWeapon, InputAction.PrevWeapon,
]);

/** Bindings the open armoury borrows, so a digit buys instead of switching. */
const SHOP_SET: readonly InputAction[] = Object.freeze([
  InputAction.Slot1, InputAction.Slot2, InputAction.Slot3, InputAction.Slot4,
  InputAction.Slot5, InputAction.Slot6, InputAction.Slot7,
]);

/* ------------------------------------------------------------------------ *
 * Small DOM helpers
 * ------------------------------------------------------------------------ */

function div(cls: string, parent?: HTMLElement): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  if (parent !== undefined) parent.appendChild(d);
  return d;
}

function clockText(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/* ------------------------------------------------------------------------ *
 * The mode
 * ------------------------------------------------------------------------ */

/** Everything the run-over card prints. Mirrored from the sidecar and the ledger. */
export interface HordeRunCard {
  wave: number;
  kills: number;
  score: number;
  credits: number;
  blocks: number;
  breaches: number;
  seconds: number;
  survived: boolean;
}

export class HordeMode implements ModeInstance {
  readonly id = ModeId.HORDE;

  /* --- authoritative mirror --- */
  private phase: ModePhase = ModePhase.LOADING;
  private wave = 0;
  private waveKills = 0;
  private waveTotal = 0;
  private score = 0;
  private lives = 3;
  private maxLives = 3;
  private skill = 2;
  private elapsedMs = 0;
  private phaseMsLeft = 0;
  private phaseMsFull = 1;
  private gateMask = 0;
  private archMask = 0;
  private boss = false;
  private holdX = 0;
  private holdY = 0;
  private holdZ = 0;
  private holdKnown = false;
  private sawState = false;
  private downed = false;
  private runOver = false;
  private survived = false;
  private saved = false;

  /* --- local view state --- */
  private wallIndex = DEFAULT_WALL_INDEX;
  private cursor = false;
  private lastNowMs = -1;
  /**
   * The frame clock the registry hands `update()`. Every timer in this file is
   * measured against it and never against `performance.now()` directly — a mode
   * that mixes two clocks shows a banner that never fades or never appears,
   * depending on which one the shell happens to be using.
   */
  private nowMs = 0;
  private lastEditMs = -1e9;
  private bannerUntilMs = 0;
  private siegeUntilMs = 0;
  private siegeGate = -1;
  private paused = false;
  private actionSeq = 1;

  /* --- economy --- */
  private readonly wallet = new HordeWallet();
  private readonly armoury = new Armoury();
  private readonly shopper = createShopperState();
  private readonly trade = createTradeReadout();
  private readonly pricer = new PlacementPricer();

  /* --- wire scratch, allocated once --- */
  private readonly writer = new PacketWriter(128);
  private readonly selectMsg = createModeSelectMessage();
  private readonly actionMsg = createModeActionMessage();

  /* --- DOM --- */
  private bar!: HTMLElement;
  private phaseLabel!: HTMLElement;
  private clock!: HTMLElement;
  private subLabel!: HTMLElement;
  private fill!: HTMLElement;
  private readonly pips: HTMLElement[] = [];
  private banner!: HTMLElement;
  private bannerTitle!: HTMLElement;
  private bannerSub!: HTMLElement;
  private siege!: HTMLElement;
  private siegeText!: HTMLElement;
  private tag!: HTMLElement;
  private downCard!: HTMLElement;
  private downText!: HTMLElement;
  private card!: HTMLElement;
  private cardTitle!: HTMLElement;
  private cardSub!: HTMLElement;
  private cardNote!: HTMLElement;
  private readonly cardStats: HTMLElement[] = [];
  private pads!: HTMLElement;
  private padFortify!: HTMLElement;
  private padArmoury!: HTMLElement;
  private padReady!: HTMLElement;

  private rail!: FortifyRail;
  private shop!: ArmouryPanel;
  private strip!: WalletStrip;
  private view!: WaveDirectorView;

  /* --- scene --- */
  private ghost!: THREE.Mesh;
  private ghostEdges!: THREE.LineSegments;
  private ghostMaterial!: THREE.MeshBasicMaterial;
  private ghostEdgeMaterial!: THREE.LineBasicMaterial;
  private siegeMesh!: THREE.Mesh;
  private siegeMaterial!: THREE.MeshBasicMaterial;
  private readonly breachMeshes: THREE.Mesh[] = [];
  private readonly breachMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly breachBornMs = new Float64Array(HORDE_BREACH_SLOTS);
  private breachCursor = 0;

  /* --- raw input --- */
  private wantPlace = false;
  private wantSalvage = false;

  /* --- cached DOM values --- */
  private cPhaseLabel = '';
  private cClock = '';
  private cClockTick = -1;
  private cSub = '';
  private cSubKey = -1;
  private cFill = -1;
  private cBarClass = '';
  private cBarKey = -1;
  private cLabelKey = -1;
  private cLives = -1;
  private cBanner = '';
  private cSiege = '';
  private cTag = '';
  private cTagBad = false;
  private cDown = '';
  private cCursorPad = false;
  private cShopPad = false;
  private cPadsOn = false;

  /* --- bound callbacks, created once --- */
  private readonly sampleBlock = (x: number, y: number, z: number): number =>
    this.ctx.host.game.net.world.getBlock(x, y, z);

  constructor(private readonly ctx: ModeContext) {}

  /* -------------------------------------------------------------------- *
   * Lifecycle
   * -------------------------------------------------------------------- */

  enter(): void {
    const { host, scope, params } = this.ctx;
    this.skill = clampSkill(params.skill);
    this.resetLoadoutMirror();

    this.installStyle();
    this.buildDom();
    this.buildScene();
    this.takeBindings();
    this.addListeners();

    this.view = new WaveDirectorView({
      scene: host.game.renderer.scene,
      scope,
      hudRoot: host.hudRoot,
    });
    this.view.configure(host.game.net.seed >>> 0, this.skill, 1);
    this.view.setWave(1);
    this.view.setPhase(true, 0.4);

    this.wallet.reset();
    this.sendSelect();
    host.setStatus('');
    this.setBanner('FORTIFY', 'Wall the lit gates. Wheel picks the material, right mouse builds.', false);
  }

  exit(): void {
    this.writeSave();
    this.ctx.host.setStatus('');
  }

  onPause(paused: boolean): void {
    this.paused = paused;
    if (paused) { this.wantPlace = false; this.wantSalvage = false; }
  }

  onModeContext(context: ModeContextMessage): void {
    if (context.modeId !== ModeId.HORDE) return;
    this.skill = clampSkill(context.skill);
    this.view.configure(this.ctx.host.game.net.seed >>> 0, this.skill, this.playerCount());
  }

  /**
   * Bodies in the room. `composeWave` scales the count by it, so the forecast
   * is only exact in co-op if the client counts the same heads the server does.
   */
  private playerCount(): number {
    const players = this.ctx.host.game.net.players;
    let n = 0;
    for (let i = 0; i < players.length; i++) if (players[i].active) n++;
    return Math.max(1, Math.min(4, n));
  }

  /* -------------------------------------------------------------------- *
   * Authoritative state
   * -------------------------------------------------------------------- */

  onModeState(state: ModeStateBuffer): void {
    if (state.modeId !== ModeId.HORDE) return;
    const first = !this.sawState;
    this.sawState = true;

    const wasPhase = this.phase;
    this.phase = state.phase;
    this.wave = state.index;
    this.waveKills = state.a;
    this.waveTotal = state.aTotal;
    this.score = state.score;
    this.elapsedMs = state.elapsedMs;
    this.skill = clampSkill(state.skill);
    this.wallet.apply(state.budget);

    if (state.lives !== 255) {
      if (state.lives > this.maxLives) this.maxLives = state.lives;
      this.lives = state.lives;
    }

    this.holdX = decodeCoord(state.b);
    this.holdZ = decodeCoord(state.bTotal);
    this.holdY = state.c;
    if (!this.holdKnown && (this.holdX !== 0 || this.holdZ !== 0)) {
      this.holdKnown = true;
      this.view.setHold(this.holdX, this.holdY, this.holdZ);
    }

    this.gateMask = state.cTotal & 0xff;
    this.archMask = (state.cTotal >>> 8) & 0x1f;
    this.boss = (state.cTotal & (1 << 13)) !== 0;

    if (this.phase === ModePhase.BUILD) {
      if (wasPhase !== ModePhase.BUILD || state.phaseMsLeft > this.phaseMsFull) {
        this.phaseMsFull = Math.max(1, state.phaseMsLeft);
      }
      this.phaseMsLeft = state.phaseMsLeft;
    } else {
      this.phaseMsLeft = 0;
    }

    this.view.configure(this.ctx.host.game.net.seed >>> 0, this.skill, this.playerCount());
    this.view.setWave(Math.max(1, this.wave));
    // setPhase picks a mask off the forecast; the server's own mask wins, so it
    // is applied last.
    this.view.setPhase(this.phase === ModePhase.BUILD, this.buildUrgency());
    this.view.applyAuthoritativeGates(this.gateMask, this.boss);
    this.view.pressure.setWave(
      this.waveKills, Math.max(1, this.waveTotal),
      this.view.current.threat, this.view.pressureBaseline,
    );

    if (first) this.rail.setVisible(true);

    if (wasPhase !== this.phase) this.onPhaseChanged(wasPhase, this.phase);
  }

  private onPhaseChanged(from: ModePhase, to: ModePhase): void {
    if (to === ModePhase.BUILD) {
      this.cursor = true;
      this.syncCursorBindings();
      this.setBanner('FORTIFY', describeComposition(this.view.next), false);
    } else if (to === ModePhase.LIVE) {
      if (this.shop.isOpen) this.toggleShop(false);
      this.cursor = false;
      this.syncCursorBindings();
      const headline = waveHeadline(this.view.current, from === ModePhase.BUILD ? null : this.view.next);
      this.setBanner(`WAVE ${this.wave}`, headline, true);
    } else if (to === ModePhase.GAME_OVER || to === ModePhase.INTERMISSION) {
      this.survived = to === ModePhase.INTERMISSION;
      this.showRunCard();
    }
  }

  /* -------------------------------------------------------------------- *
   * Events
   * -------------------------------------------------------------------- */

  onModeEvent(e: ModeEventMessage): void {
    const now = this.nowMs;
    const localId = this.ctx.host.game.net.playerId;

    switch (e.kind) {
      case ModeEventKind.BUILD_PHASE:
        this.gateMask = e.c & 0xff;
        this.phaseMsFull = Math.max(1000, e.a * 1000);
        this.phaseMsLeft = this.phaseMsFull;
        break;

      case ModeEventKind.WAVE_INCOMING: {
        this.wave = e.a;
        this.waveTotal = e.b;
        this.waveKills = 0;
        this.archMask = e.c & 0x1f;
        this.boss = (e.c & (1 << 5)) !== 0;
        this.gateMask = (e.c >>> 6) & 0xff;
        this.view.setWave(this.wave);
        this.view.applyAuthoritativeGates(this.gateMask, this.boss);
        const line = this.boss ? 'BOSS WAVE' : waveHeadline(this.view.current, this.view.next);
        this.setBanner(`WAVE ${this.wave}`, `${line} · ${gateLabel(this.gateMask)}`, true);
        break;
      }

      case ModeEventKind.WAVE_CLEARED:
        this.setBanner('WAVE CLEARED', `${e.b} killed · +${e.c} credits · fortify`, false);
        this.view.pressure.reset();
        break;

      case ModeEventKind.PAYOUT:
        this.wallet.note(e.a, e.b, now);
        if (e.b === 4) this.flashTag('NOT ENOUGH CREDITS', true, now);
        break;

      case ModeEventKind.WEAPON_TAKEN:
        if (e.playerId === localId) {
          this.ownedMask = grantWeapon(this.ownedMask, e.a);
          this.ctx.host.game.hud.pushFeed(`Bought ${e.text}`, 's');
        }
        break;

      case ModeEventKind.LEVEL_COMPLETE:
        this.survived = true;
        this.wave = e.a;
        this.score = e.c;
        this.showRunCard();
        break;

      case ModeEventKind.LEVEL_FAILED:
        this.survived = false;
        this.wave = e.a;
        this.score = e.c;
        this.showRunCard();
        break;

      case ModeEventKind.OBJECTIVE:
        this.onObjective(e, localId, now);
        break;

      default:
        break;
    }
  }

  /**
   * Horde's own one-shots ride on OBJECTIVE with a sub-code in `c`, because
   * `ModeEventKind` has no BREACH and `shared/src/modes.ts` is not this mode's
   * file to edit. The sub-codes are imported from the server module, so the two
   * ends cannot disagree about what a 3 means.
   */
  private onObjective(e: ModeEventMessage, localId: number, now: number): void {
    switch (e.c) {
      case HORDE_EV_HOLD:
        this.holdX = decodeCoord(e.a);
        this.holdZ = decodeCoord(e.b);
        this.holdKnown = true;
        this.view.setHold(this.holdX, this.holdY, this.holdZ);
        this.ctx.host.game.hud.pushFeed('Hold this position', 's');
        break;

      case HORDE_EV_SIEGE: {
        const x = decodeCoord(e.a);
        const z = decodeCoord(e.b);
        this.siegeUntilMs = now + HORDE_SIEGE_HOLD_MS;
        this.siegeGate = this.gateOf(x, z);
        if (this.repairHint < 99) this.repairHint++;
        this.placeSiegeMarker(x, z);
        this.view.pressure.pingSiege();
        break;
      }

      case HORDE_EV_BREACH: {
        const x = decodeCoord(e.a);
        const z = decodeCoord(e.b);
        this.spawnBreach(x, z, now);
        if (this.repairHint < 99) this.repairHint++;
        this.view.pressure.pingSiege();
        this.ctx.host.game.camera.addShake(0.05, 220, 16);
        this.ctx.host.game.hud.pushFeed(`Wall breached — ${this.gateName(this.gateOf(x, z))}`, 'k');
        break;
      }

      case HORDE_EV_DOWNED:
        if (e.playerId === localId) {
          this.downed = true;
          this.lives = e.a;
          if (this.shop.isOpen) this.toggleShop(false);
        }
        break;

      case HORDE_EV_REVIVED:
        if (e.playerId === localId) this.downed = false;
        break;

      case HORDE_EV_RUN_OVER:
        this.survived = false;
        this.wave = e.a;
        this.showRunCard();
        break;

      default:
        break;
    }
  }

  /* -------------------------------------------------------------------- *
   * Frame
   * -------------------------------------------------------------------- */

  update(_dt: number, nowMs: number): void {
    if (this.lastNowMs < 0) {
      // `enter()` runs before the first frame, so any deadline it armed — the
      // opening FORTIFY banner, most obviously — is measured against a clock
      // the registry has not handed over yet. Rebase them all once, and every
      // timer in this file is on one clock from here on.
      const shift = nowMs - this.nowMs;
      if (this.bannerUntilMs > 0) this.bannerUntilMs += shift;
      if (this.siegeUntilMs > 0) this.siegeUntilMs += shift;
      if (this.tagUntilMs > 0) this.tagUntilMs += shift;
    }
    const dtMs = this.lastNowMs < 0 ? 0 : Math.min(250, Math.max(0, nowMs - this.lastNowMs));
    this.lastNowMs = nowMs;
    this.nowMs = nowMs;
    if (this.paused) return;

    const game = this.ctx.host.game;
    const net = game.net;

    /* --- the clock runs locally between sidecars ---------------------- */
    if (this.phase === ModePhase.BUILD && this.phaseMsLeft > 0) {
      this.phaseMsLeft = Math.max(0, this.phaseMsLeft - dtMs);
    }

    /* --- pressure ------------------------------------------------------ */
    this.view.pressure.setNearest(this.nearestDemon());
    this.view.update(dtMs, game.camera.viewYaw);

    /* --- placement ----------------------------------------------------- */
    this.stepBuilding(nowMs);

    /* --- economy -------------------------------------------------------
     * `evaluateTrade`, `Armoury.refresh` and `ArmouryPanel.update` all build
     * strings, and a string per frame is a string per frame. None of their
     * inputs can change without one of these twelve numbers changing, so the
     * whole block runs on a change and not on a clock. A steady frame costs
     * twelve integer compares. */
    const combat = this.phase !== ModePhase.BUILD;
    this.refreshShopper();
    if (this.economyMoved(combat)) {
      this.armoury.refresh(this.shopper);
      evaluateTrade(
        this.wallet.credits, this.view.next, this.shopper.weaponMask,
        WALL_STOCK[this.wallIndex], this.trade, this.litGateCount(),
      );
      this.shop.update(
        this.armoury, this.trade, this.wallIndex, this.wallet.credits,
        combat, this.view.next, this.wallet,
      );
    }

    this.rail.setVisible(!this.runOver && (this.cursor || this.phase === ModePhase.BUILD));
    this.rail.update(this.wallIndex, this.wallet.credits, combat);
    this.strip.setHidden(this.shop.isOpen || this.runOver);
    this.strip.update(this.wallet, this.trade, nowMs);

    /* --- chrome -------------------------------------------------------- */
    this.paintBar();
    this.paintBanner(nowMs);
    this.paintSiege(nowMs);
    this.paintDowned(net.local.dead);
    this.paintPads();
    this.stepBreaches(nowMs);
  }

  /* -------------------------------------------------------------------- *
   * Building — the half that has to be worth paying for
   * -------------------------------------------------------------------- */

  private stepBuilding(nowMs: number): void {
    const game = this.ctx.host.game;
    const net = game.net;
    const combat = this.phase !== ModePhase.BUILD;
    const wall = WALL_STOCK[this.wallIndex];
    const active = !this.runOver && !this.downed && game.playing && !net.local.dead
      && (this.cursor || this.wantPlace || this.wantSalvage);

    if (!active) {
      this.hideGhost();
      return;
    }

    const cam = game.camera;
    const f = cam.forward;
    const q = this.pricer.solve(
      cam.eyeX, cam.eyeY, cam.eyeZ, f[0], f[1], f[2],
      this.sampleBlock,
      net.renderPos[0], net.renderPos[1], net.renderPos[2],
      wall.blockId, this.wallet.credits, combat, net.local.dead,
    );

    /* --- the ghost --------------------------------------------------- */
    if (q.hasHit) {
      const gx = q.ok || q.refusal === PLACE_BROKE ? q.x : q.hitX;
      const gy = q.ok || q.refusal === PLACE_BROKE ? q.y : q.hitY;
      const gz = q.ok || q.refusal === PLACE_BROKE ? q.z : q.hitZ;
      this.ghost.position.set(gx + 0.5, gy + 0.5, gz + 0.5);
      this.ghostEdges.position.copy(this.ghost.position);
      this.ghost.visible = true;
      this.ghostEdges.visible = true;
      const good = q.ok;
      const colour = good ? minimapColor(wall.blockId) : 0xe03c1c;
      this.ghostMaterial.color.setHex(colour);
      this.ghostEdgeMaterial.color.setHex(good ? 0xf0a020 : 0xe03c1c);
      this.ghostMaterial.opacity = good ? 0.26 : 0.16;
      if (this.tagUntilMs <= nowMs) {
        this.setTag(q.ok ? priceTag(wall, combat) : PLACE_REFUSALS[q.refusal], !q.ok);
      }
    } else {
      this.hideGhost();
    }

    /* --- the click ---------------------------------------------------- */
    if (nowMs - this.lastEditMs < HORDE_EDIT_INTERVAL_MS) return;

    if (this.wantPlace && q.ok) {
      this.lastEditMs = nowMs;
      if (net.requestEdit(BlockAction.PLACE, q.x, q.y, q.z, wall.blockId)) {
        game.chunks.setBlock(q.x, q.y, q.z, wall.blockId);
        game.fx.impact(q.x + 0.5, q.y + 0.5, q.z + 0.5, 0, 1, 0, minimapColor(wall.blockId), 0.35);
        game.viewmodel.fire();
      }
      return;
    }

    // Salvage. Breaking your own wall pays back half of what is left in it,
    // which is how a keep you no longer need turns back into a rocket.
    if (this.wantSalvage && this.cursor && q.hasHit && q.hitBlock !== BlockId.AIR
      && q.hitBlock !== BlockId.BEDROCK) {
      this.lastEditMs = nowMs;
      if (net.requestEdit(BlockAction.BREAK, q.hitX, q.hitY, q.hitZ, 0)) {
        game.chunks.setBlock(q.hitX, q.hitY, q.hitZ, BlockId.AIR);
        game.fx.blockBreak(q.hitX, q.hitY, q.hitZ, q.hitBlock);
        game.camera.addShake(0.02, 60, 22);
        game.viewmodel.fire();
      }
    }
  }

  private hideGhost(): void {
    if (this.ghost.visible) {
      this.ghost.visible = false;
      this.ghostEdges.visible = false;
    }
    if (this.tagUntilMs <= this.nowMs) this.setTag('', false);
  }

  /* -------------------------------------------------------------------- *
   * Input
   * -------------------------------------------------------------------- */

  /**
   * Bindings taken for the whole run: the right mouse button, because
   * `game.ts` would otherwise place a second block of the wrong material on the
   * same click, and the build-mode key, because this mode's cursor is not that
   * cursor.
   */
  private takeBindings(): void {
    this.takeBinding(InputAction.AltFire);
    this.takeBinding(InputAction.BuildMode);
  }

  private takeBinding(action: InputAction): void {
    const input = this.ctx.host.game.input;
    if (input.isActionTaken(action)) return;
    input.setActionTaken(action, true);
    this.ctx.scope.add(() => { input.setActionTaken(action, false); });
  }

  /**
   * Taken and given back as the two toggles move.
   *
   * CURSOR_SET: the left button salvages instead of shooting and the wheel
   * picks a material instead of a gun, so both are taken while the fortify
   * cursor is up or the armoury is open, and handed straight back afterwards.
   * That is what keeps the guns live for the other 90% of the run.
   *
   * SHOP_SET: the number row buys rows 1-7 while the armoury is open. Without
   * taking these, pressing 3 would buy rockets AND switch to the chaingun,
   * because `InputManager` reads the raw keydown and does not care that this
   * mode called `preventDefault`.
   */
  private syncCursorBindings(): void {
    this.setTaken(CURSOR_SET, this.cursor || this.shop.isOpen);
    this.setTaken(SHOP_SET, this.shop.isOpen);
  }

  private setTaken(set: readonly InputAction[], want: boolean): void {
    const input = this.ctx.host.game.input;
    for (let i = 0; i < set.length; i++) {
      const action = set[i];
      const held = this.taken.has(action);
      if (want === held) continue;
      if (want) this.taken.add(action); else this.taken.delete(action);
      input.setActionTaken(action, want);
    }
  }

  /**
   * Actions currently held hostage.
   *
   * A mask on the action, not a blanked binding: a control scheme can give an
   * action a second key (Classic fires on Ctrl as well as the mouse), and
   * clearing one layer would have left the other one live — the fortify cursor
   * would have salvaged AND fired.
   */
  private readonly taken = new Set<InputAction>();

  private addListeners(): void {
    const { scope, host } = this.ctx;
    const canvas = host.canvas;

    scope.addListener(canvas, 'mousedown', this.onMouseDown as EventListener);
    scope.addListener(canvas, 'pointerdown', this.onPointerDown as EventListener);
    scope.addListener(window, 'mouseup', this.onMouseUp as EventListener);
    scope.addListener(window, 'pointerup', this.onPointerUp as EventListener);
    scope.addListener(window, 'pointercancel', this.onPointerUp as EventListener);
    scope.addListener(canvas, 'contextmenu', this.onContextMenu as EventListener);
    scope.addListener(window, 'wheel', this.onWheel as EventListener, { passive: true });
    scope.addListener(window, 'keydown', this.onKeyDown as EventListener);
    scope.addListener(window, 'blur', this.onBlur as EventListener);

    // Whatever state the two toggles are left in, the ledger hands every
    // hostage binding back on exit. `scopeStats().live === 0` covers the DOM;
    // this covers the input map.
    scope.add(() => {
      const input = host.game.input;
      for (const action of this.taken) input.setActionTaken(action, false);
      this.taken.clear();
    });
  }

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (this.paused || this.runOver) return;
    if (e.button === 2) { this.wantPlace = true; e.preventDefault(); }
    else if (e.button === 0 && this.cursor) { this.wantSalvage = true; e.preventDefault(); }
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 2) this.wantPlace = false;
    else if (e.button === 0) this.wantSalvage = false;
  };

  private readonly onPointerUp = (): void => { this.wantPlace = false; };

  private readonly onContextMenu = (e: Event): void => { e.preventDefault(); };

  private readonly onBlur = (): void => { this.wantPlace = false; this.wantSalvage = false; };

  private readonly onWheel = (e: WheelEvent): void => {
    if (this.paused || !this.taken.has(InputAction.NextWeapon)) return;
    this.cycleWall(e.deltaY > 0 ? 1 : -1);
  };

  /**
   * Touch has no right mouse button. A press on the canvas while the fortify
   * cursor is up is a placement; the look-drag is unaffected because the ghost
   * only commits on the rate-limited edit tick and `game.ts` still owns look.
   */
  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.paused || this.runOver || e.pointerType !== 'touch') return;
    if (this.cursor) this.wantPlace = true;
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.paused || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

    switch (e.code) {
      case 'KeyB':
        this.toggleCursor(!this.cursor);
        break;
      case 'KeyX':
        this.toggleShop(!this.shop.isOpen);
        break;
      case 'KeyF':
        if (this.phase === ModePhase.BUILD) this.sendAction(ModeAction.READY, 0, 0);
        break;
      case 'KeyG':
        this.cycleWall(1);
        break;
      default: {
        if (!this.shop.isOpen) return;
        const digit = e.code.startsWith('Digit') ? Number(e.code.slice(5)) : -1;
        if (digit >= 1 && digit <= 9) {
          const offer = this.armoury.offerAt(digit);
          if (offer !== null) this.sendAction(ModeAction.BUY, offer.itemId, 1);
          e.preventDefault();
        }
        return;
      }
    }
    e.preventDefault();
  };

  private cycleWall(dir: number): void {
    const n = WALL_STOCK.length;
    this.wallIndex = (this.wallIndex + dir + n) % n;
  }

  private toggleCursor(on: boolean): void {
    if (this.cursor === on) return;
    this.cursor = on;
    this.wantSalvage = false;
    this.syncCursorBindings();
    this.ctx.host.game.hud.pushFeed(
      on ? 'Fortify cursor ON — RMB builds, LMB salvages, wheel picks material' : 'Fortify cursor off',
      's',
    );
  }

  private toggleShop(on: boolean): void {
    this.shop.setOpen(on);
    this.syncCursorBindings();
  }

  /** The shell may route a local action here; Horde only cares about two. */
  onAction(action: ModeAction, a: number, b: number): boolean {
    if (action === ModeAction.BUY) { this.sendAction(ModeAction.BUY, a, Math.max(1, b)); return true; }
    if (action === ModeAction.READY) { this.sendAction(ModeAction.READY, 0, 0); return true; }
    return false;
  }

  /* -------------------------------------------------------------------- *
   * Wire
   * -------------------------------------------------------------------- */

  private sendSelect(): void {
    const m = toModeSelectMessage(this.ctx.params, this.selectMsg);
    m.modeId = ModeId.HORDE;
    m.skill = this.skill;
    m.levelId = '';
    m.worldId = '';
    this.ctx.host.send(encodeModeSelect(this.writer, m).copy());
  }

  private sendAction(action: ModeAction, a: number, b: number): void {
    // A repair pays for everything within reach, so the "what I saw chewed"
    // floor resets with it.
    if (action === ModeAction.BUY && a === HordeItem.REPAIR) this.repairHint = 0;
    const m = this.actionMsg;
    m.action = action;
    m.a = a;
    m.b = b;
    m.x = 0; m.y = 0; m.z = 0;
    m.seq = this.actionSeq++;
    this.ctx.host.send(encodeModeAction(this.writer, m).copy());
  }

  /* -------------------------------------------------------------------- *
   * Chrome
   * -------------------------------------------------------------------- */

  private paintBar(): void {
    if (this.runOver) {
      if (this.cBarClass !== 'off') {
        this.cBarClass = 'off';
        this.cBarKey = -1;
        this.bar.className = 'dch dch-bar off';
      }
      return;
    }
    const build = this.phase === ModePhase.BUILD;
    const live = this.phase === ModePhase.LIVE;
    const secondsLeft = this.phaseMsLeft / 1000;
    const urgent = build && secondsLeft <= HORDE_CLOCK_URGENT_SEC;

    const clsKey = (live ? 1 : 0) | (urgent ? 2 : 0);
    if (clsKey !== this.cBarKey) {
      this.cBarKey = clsKey;
      this.bar.className = `dch dch-bar${live ? ' live' : ''}${urgent ? ' urgent' : ''}`;
      this.cBarClass = '';
    }

    const labelKey = (this.wave << 3) | (live ? 1 : 0) | (build ? 2 : 0) | (this.sawState ? 4 : 0);
    if (labelKey !== this.cLabelKey) {
      this.cLabelKey = labelKey;
      const label = build ? 'FORTIFY' : live ? `WAVE ${this.wave}` : this.sawState ? 'STANDBY' : 'CONNECTING';
      if (label !== this.cPhaseLabel) { this.cPhaseLabel = label; this.phaseLabel.textContent = label; }
    }

    // The clock ticks once a second and the kill tally once a kill; neither is
    // a reason to build a string sixty times a second.
    const tick = build ? Math.ceil(this.phaseMsLeft / 1000) : (this.waveKills << 8) | (this.waveTotal & 0xff);
    if (tick !== this.cClockTick) {
      this.cClockTick = tick;
      const clock = build
        ? clockText(this.phaseMsLeft)
        : `${this.waveKills} / ${Math.max(this.waveTotal, this.waveKills)}`;
      if (clock !== this.cClock) { this.cClock = clock; this.clock.textContent = clock; }
    }

    const subKey = (this.wave << 20) | ((this.gateMask & 0xff) << 12) | ((this.archMask & 0x1f) << 7)
      | ((this.view.pressure.stage & 3) << 5) | ((this.boss ? 1 : 0) << 4) | (this.phase & 0xf);
    if (subKey !== this.cSubKey) {
      this.cSubKey = subKey;
      const sub = build ? this.fortifyLine() : live ? this.liveLine() : 'Waiting for the wave director';
      if (sub !== this.cSub) { this.cSub = sub; this.subLabel.textContent = sub; }
    }

    const frac = build
      ? Math.max(0, Math.min(1, this.phaseMsLeft / this.phaseMsFull))
      : this.waveTotal > 0 ? Math.max(0, Math.min(1, this.waveKills / this.waveTotal)) : 0;
    const pct = Math.round(frac * 100);
    if (pct !== this.cFill) { this.cFill = pct; this.fill.style.width = `${pct}%`; }

    if (this.lives !== this.cLives) {
      this.cLives = this.lives;
      for (let i = 0; i < this.pips.length; i++) {
        const gone = i >= this.lives;
        this.pips[i].classList.toggle('gone', gone);
        this.pips[i].style.display = i < Math.max(this.maxLives, this.lives) ? '' : 'none';
      }
    }
  }

  private fortifyLine(): string {
    const next = this.view.next;
    const gates = gateLabel(this.gateMask !== 0 ? this.gateMask : next.gateMask);
    return `Wave ${Math.max(1, this.wave + 1)} · ${next.total} demons from ${gates} · F starts it early`;
  }

  private liveLine(): string {
    let heaviest = -1;
    for (let t = 0; t < HORDE_ENEMY_COUNT; t++) {
      if ((this.archMask & (1 << t)) !== 0) heaviest = t;
    }
    const bossTag = this.boss ? 'BOSS · ' : '';
    const arch = heaviest >= 0 ? rosterUi(heaviest).plural : 'demons';
    return `${bossTag}${arch} from ${gateLabel(this.gateMask)} · ${this.view.pressure.stageName}`;
  }

  private setBanner(title: string, sub: string, hot: boolean): void {
    this.bannerUntilMs = this.nowMs + HORDE_BANNER_MS;
    const sig = `${title}|${sub}|${hot ? 1 : 0}`;
    if (sig === this.cBanner) return;
    this.cBanner = sig;
    this.bannerTitle.textContent = title;
    this.bannerSub.textContent = sub;
    this.banner.classList.toggle('hot', hot);
  }

  private paintBanner(nowMs: number): void {
    const on = nowMs < this.bannerUntilMs && !this.runOver;
    if (this.banner.classList.contains('on') !== on) this.banner.classList.toggle('on', on);
  }

  private paintSiege(nowMs: number): void {
    const on = nowMs < this.siegeUntilMs && !this.runOver;
    if (this.siege.classList.contains('on') !== on) this.siege.classList.toggle('on', on);
    if (!on) return;
    const text = `${this.gateName(this.siegeGate)} wall — something is chewing through it`;
    if (text !== this.cSiege) { this.cSiege = text; this.siegeText.textContent = text; }
  }

  private paintDowned(dead: boolean): void {
    const down = (this.downed || dead) && !this.runOver;
    if (this.downCard.classList.contains('off') === down) this.downCard.classList.toggle('off', !down);
    if (!down) return;
    const text = this.lives > 0
      ? `Back on your feet when the wave ends. ${this.lives} live${this.lives === 1 ? '' : 's'} left.`
      : 'No lives left. The run ends when the last of you goes down.';
    if (text !== this.cDown) { this.cDown = text; this.downText.textContent = text; }
  }

  private paintPads(): void {
    // Nothing on the pads does anything once the run card is up.
    const show = this.isTouch() && !this.runOver;
    if (show !== this.cPadsOn) {
      this.cPadsOn = show;
      this.pads.classList.toggle('on', show);
    }
    if (this.cCursorPad !== this.cursor) {
      this.cCursorPad = this.cursor;
      this.padFortify.classList.toggle('hot', this.cursor);
    }
    if (this.cShopPad !== this.shop.isOpen) {
      this.cShopPad = this.shop.isOpen;
      this.padArmoury.classList.toggle('hot', this.shop.isOpen);
    }
  }

  private setTag(text: string, bad: boolean): void {
    if (text === this.cTag && bad === this.cTagBad) return;
    this.cTag = text;
    this.cTagBad = bad;
    this.tag.textContent = text;
    this.tag.classList.toggle('on', text.length > 0);
    this.tag.classList.toggle('bad', bad);
  }

  private flashTag(text: string, bad: boolean, nowMs: number): void {
    this.setTag(text, bad);
    this.tagUntilMs = nowMs + 1200;
  }
  private tagUntilMs = 0;

  /* -------------------------------------------------------------------- *
   * The run card
   * -------------------------------------------------------------------- */

  private showRunCard(): void {
    if (this.runOver) return;
    this.runOver = true;
    this.hideGhost();
    if (this.shop.isOpen) this.toggleShop(false);
    this.cursor = false;
    this.syncCursorBindings();
    this.rail.setVisible(false);

    this.cardTitle.textContent = this.survived ? 'HELD' : 'OVERRUN';
    this.card.classList.toggle('win', this.survived);
    this.cardSub.textContent = this.survived
      ? `Every wave held, on ${SKILL_NAMES[this.skill]}.`
      : `Wave ${this.wave} took the position, on ${SKILL_NAMES[this.skill]}.`;

    const seconds = Math.round(this.elapsedMs / 1000);
    const values = [
      `${this.wave}`,
      `${this.totalKills()}`,
      `${this.score}`,
      `${this.wallet.blocksPlaced}`,
      `${this.wallet.earned}`,
      clockText(seconds * 1000),
    ];
    for (let i = 0; i < this.cardStats.length && i < values.length; i++) {
      this.cardStats[i].textContent = values[i];
    }

    const wallShare = this.wallet.spent > 0
      ? Math.round((this.wallet.onWalls / this.wallet.spent) * 100)
      : 0;
    this.cardNote.textContent = this.wallet.spent === 0
      ? 'You never spent a credit. The demons noticed.'
      : `${wallShare}% of everything you earned went into walls, ${100 - wallShare}% into guns.`
        + (this.wallet.refusals > 0 ? ` ${this.wallet.refusals} purchase${this.wallet.refusals === 1 ? '' : 's'} refused for want of funds.` : '');

    this.card.classList.remove('off');
    this.writeSave();
  }

  private writeSave(): void {
    if (this.saved || this.wave <= 0) return;
    this.saved = true;
    const store = this.storage();
    if (store === null) return;
    try {
      const now = Date.now();
      const save = loadSave(store, now);
      recordHordeRun(save, {
        mapId: 'arena',
        wave: this.wave,
        score: this.score,
        kills: this.totalKills(),
        blocksPlaced: this.wallet.blocksPlaced,
        timeSec: Math.round(this.elapsedMs / 1000),
        skill: this.skill,
      }, now);
      storeSave(store, save, now);
    } catch {
      // A private-mode browser is not a reason to lose the run card.
    }
  }

  private storage(): SaveStorage | null {
    try {
      const ls = window.localStorage;
      return ls === null || ls === undefined ? null : ls;
    } catch {
      return null;
    }
  }

  private totalKills(): number {
    return this.ctx.host.game.net.local.kills;
  }

  /* -------------------------------------------------------------------- *
   * Scene
   * -------------------------------------------------------------------- */

  private buildScene(): void {
    const scene = this.ctx.host.game.renderer.scene;
    const scope = this.ctx.scope;

    const geometry = new THREE.BoxGeometry(1.001, 1.001, 1.001);
    this.ghostMaterial = new THREE.MeshBasicMaterial({
      color: 0xf0a020, transparent: true, opacity: 0.26,
      depthWrite: false, fog: false,
    });
    this.ghost = new THREE.Mesh(geometry, this.ghostMaterial);
    this.ghost.frustumCulled = false;
    this.ghost.visible = false;
    scope.addObject3D(this.ghost, scene);

    this.ghostEdgeMaterial = new THREE.LineBasicMaterial({ color: 0xf0a020, transparent: true, opacity: 0.85, fog: false });
    this.ghostEdges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), this.ghostEdgeMaterial);
    this.ghostEdges.frustumCulled = false;
    this.ghostEdges.visible = false;
    scope.addObject3D(this.ghostEdges, scene);

    this.siegeMaterial = new THREE.MeshBasicMaterial({
      color: 0xe03c1c, transparent: true, opacity: 0.3,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    this.siegeMesh = new THREE.Mesh(new THREE.BoxGeometry(1.14, 1.14, 1.14), this.siegeMaterial);
    this.siegeMesh.frustumCulled = false;
    this.siegeMesh.visible = false;
    scope.addObject3D(this.siegeMesh, scene);

    const breachGeometry = new THREE.BoxGeometry(1.3, 1.3, 1.3);
    for (let i = 0; i < HORDE_BREACH_SLOTS; i++) {
      const m = new THREE.MeshBasicMaterial({
        color: 0xff6a3a, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      });
      const mesh = new THREE.Mesh(breachGeometry, m);
      mesh.frustumCulled = false;
      mesh.visible = false;
      scope.addObject3D(mesh, scene);
      this.breachMeshes.push(mesh);
      this.breachMaterials.push(m);
    }
  }

  /**
   * SIEGE and BREACH carry x and z but not y — the sidecar's coordinate fields
   * are uint16 and the third one is already the hold's floor. Finding the
   * column's solid block is eight samples of a hash map, once per event, which
   * is cheaper than widening the wire for it.
   */
  private columnY(x: number, z: number): number {
    const world = this.ctx.host.game.net.world;
    const base = Math.round(this.holdY);
    for (let dy = COLUMN_SEARCH; dy >= -2; dy--) {
      const y = base + dy;
      if (y < 1) continue;
      if (world.getBlock(x, y, z) !== BlockId.AIR) return y;
    }
    return base;
  }

  private placeSiegeMarker(x: number, z: number): void {
    const y = this.columnY(x, z);
    this.siegeMesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    this.siegeMesh.visible = true;
  }

  private spawnBreach(x: number, z: number, nowMs: number): void {
    const slot = this.breachCursor;
    this.breachCursor = (this.breachCursor + 1) % HORDE_BREACH_SLOTS;
    const y = this.columnY(x, z);
    const mesh = this.breachMeshes[slot];
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    mesh.visible = true;
    this.breachBornMs[slot] = nowMs;
  }

  private stepBreaches(nowMs: number): void {
    for (let i = 0; i < HORDE_BREACH_SLOTS; i++) {
      const mesh = this.breachMeshes[i];
      if (!mesh.visible) continue;
      const age = nowMs - this.breachBornMs[i];
      if (age >= HORDE_BREACH_MS) { mesh.visible = false; continue; }
      const t = 1 - age / HORDE_BREACH_MS;
      this.breachMaterials[i].opacity = t * 0.6;
      const s = 1 + (1 - t) * 0.9;
      mesh.scale.set(s, s, s);
    }
    if (this.siegeMesh.visible) {
      const left = this.siegeUntilMs - nowMs;
      if (left <= 0) this.siegeMesh.visible = false;
      else this.siegeMaterial.opacity = 0.16 + 0.18 * (0.5 + 0.5 * Math.sin(nowMs * 0.012));
    }
    if (this.tagUntilMs > 0 && nowMs > this.tagUntilMs) {
      this.tagUntilMs = 0;
      this.setTag('', false);
    }
  }

  /* -------------------------------------------------------------------- *
   * Reads off the snapshot
   * -------------------------------------------------------------------- */

  /** Metres from the hold to the nearest live demon. 999 when the map is clear. */
  private nearestDemon(): number {
    const entities = this.ctx.host.game.net.entities;
    const hx = this.holdKnown ? this.holdX : this.ctx.host.game.net.renderPos[0];
    const hz = this.holdKnown ? this.holdZ : this.ctx.host.game.net.renderPos[2];
    let best = 999;
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];
      if (!e.active || e.type >= EntityType.PICKUP_HEALTH) continue;
      const dx = e.x - hx;
      const dz = e.z - hz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * The snapshot carries the reserve of the gun in your hands and nothing else,
   * and `game.ts` resets its own owned mask to "everything" on respawn (which
   * is right for Deathmatch and wrong here). So Horde keeps its own two-field
   * mirror: the mask starts at the mode table's `startWeaponMask` and is OR-ed
   * by every WEAPON_TAKEN the server sends plus whatever is actually in hand;
   * the reserves start at `AMMO_START` — the loadout the run really spawns
   * with — and each type is refreshed the moment its gun is drawn. Showing a
   * stale-but-once-true number beats showing a zero that was never true.
   */
  private resetLoadoutMirror(): void {
    this.ownedMask = getMode(ModeId.HORDE).startWeaponMask;
    for (let i = 0; i < AMMO_TYPE_COUNT; i++) this.reserveCache[i] = AMMO_START[i];
  }

  private refreshShopper(): void {
    const net = this.ctx.host.game.net;
    const s = this.shopper;

    // You cannot be holding a gun you do not own.
    this.ownedMask = grantWeapon(this.ownedMask, net.local.weapon);
    const ammo = ammoTypeOf(net.local.weapon);
    if (ammo > 0) this.reserveCache[ammo] = net.local.reserve;

    s.credits = this.wallet.credits;
    s.weaponMask = this.ownedMask;
    s.health = Math.min(MAX_HEALTH, net.local.health);
    s.armor = Math.min(MAX_ARMOR, net.local.armor);
    s.phase = this.phase;
    s.lives = this.lives;
    for (let i = 0; i < AMMO_TYPE_COUNT; i++) s.reserve[i] = this.reserveCache[i];
    // Repairs are priced by the server, which is the only end that knows how
    // much of your wall is missing. The client only reports what it watched
    // get chewed, as a floor.
    s.repairBlocks = this.repairHint;
    s.repairCost = 0;
  }

  private repairHint = 0;
  private ownedMask = 0;
  private readonly reserveCache = new Uint16Array(AMMO_TYPE_COUNT);

  /**
   * The economy's inputs, as twelve integers. Element-wise compare rather than
   * a hash: a hash collision here would freeze the shop on a stale row, and
   * twelve compares are cheaper than the string it would have built anyway.
   */
  private readonly ecoNow = new Int32Array(12);
  private readonly ecoWas = new Int32Array(12).fill(-1);

  private economyMoved(combat: boolean): boolean {
    const s = this.shopper;
    const n = this.ecoNow;
    n[0] = this.wallet.credits;
    n[1] = s.weaponMask;
    n[2] = s.phase;
    n[3] = Math.round(s.health);
    n[4] = Math.round(s.armor);
    n[5] = s.lives;
    n[6] = this.wallIndex;
    n[7] = this.gateMask;
    n[8] = this.view.next.wave;
    n[9] = this.repairHint;
    n[10] = (combat ? 1 : 0) | (this.shop.isOpen ? 2 : 0);
    let reserves = 0;
    for (let i = 0; i < AMMO_TYPE_COUNT; i++) reserves = (reserves * 31 + s.reserve[i]) | 0;
    n[11] = reserves;

    let moved = false;
    for (let i = 0; i < n.length; i++) {
      if (this.ecoWas[i] === n[i]) continue;
      this.ecoWas[i] = n[i];
      moved = true;
    }
    return moved;
  }

  private gateOf(x: number, z: number): number {
    if (!this.holdKnown) return -1;
    const dx = x + 0.5 - this.holdX;
    const dz = z + 0.5 - this.holdZ;
    if (dx === 0 && dz === 0) return -1;
    // Gate 0 is north (-z) and they run clockwise, matching `gateBearing`.
    const bearing = Math.atan2(dx, -dz);
    const idx = Math.round((bearing / (Math.PI * 2)) * HORDE_GATE_COUNT);
    return ((idx % HORDE_GATE_COUNT) + HORDE_GATE_COUNT) % HORDE_GATE_COUNT;
  }

  private gateName(gate: number): string {
    if (gate < 0 || gate >= HORDE_GATE_COUNT) return 'A';
    return HORDE_GATE_LONG_NAMES[gate];
  }

  /** Gates the server says are hot, or 0 before the first sidecar. */
  private litGateCount(): number {
    let n = 0;
    for (let g = 0; g < HORDE_GATE_COUNT; g++) if (gateIsHot(this.gateMask, g)) n++;
    return n;
  }

  private buildUrgency(): number {
    if (this.phase !== ModePhase.BUILD) return 0;
    const left = this.phaseMsLeft / Math.max(1, this.phaseMsFull);
    return Math.max(0, Math.min(1, 1 - left));
  }

  /* -------------------------------------------------------------------- *
   * Construction
   * -------------------------------------------------------------------- */

  private installStyle(): void {
    const economy = installEconomyStyle();
    if (economy !== null) this.ctx.scope.addElement(economy);
    if (document.getElementById(STYLE_ID) !== null) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
    this.ctx.scope.addElement(el);
  }

  private buildDom(): void {
    const { host, scope } = this.ctx;
    const hud = host.hudRoot;
    const ui = host.uiRoot;

    /* ---- phase bar ---- */
    this.bar = div('dch dch-bar', hud);
    const row = div('dch-brow', this.bar);
    this.phaseLabel = div('dch-ph', row);
    this.phaseLabel.textContent = 'CONNECTING';
    this.clock = div('dch-clock', row);
    this.clock.textContent = '0:00';
    const livesRow = div('dch-lives', row);
    for (let i = 0; i < 8; i++) {
      const pip = div('dch-pip', livesRow);
      pip.style.display = i < 3 ? '' : 'none';
      this.pips.push(pip);
    }
    this.subLabel = div('dch-sub', row);
    const track = div('dch-track', this.bar);
    this.fill = document.createElement('u');
    this.fill.className = 'dch-fill';
    track.appendChild(this.fill);
    scope.addElement(this.bar);

    /* ---- banner ---- */
    this.banner = div('dch dch-banner', hud);
    this.bannerTitle = document.createElement('em');
    this.bannerSub = document.createElement('span');
    this.banner.appendChild(this.bannerTitle);
    this.banner.appendChild(this.bannerSub);
    scope.addElement(this.banner);

    /* ---- siege alert ---- */
    this.siege = div('dch dch-siege', hud);
    const sb = document.createElement('b');
    sb.textContent = 'UNDER SIEGE';
    this.siege.appendChild(sb);
    this.siegeText = document.createElement('span');
    this.siege.appendChild(this.siegeText);
    scope.addElement(this.siege);

    /* ---- ghost price tag ---- */
    this.tag = div('dch dch-tag', hud);
    scope.addElement(this.tag);

    /* ---- downed ---- */
    this.downCard = div('dch dch-down off', hud);
    const db = document.createElement('b');
    db.textContent = 'DOWN';
    this.downCard.appendChild(db);
    this.downText = document.createElement('span');
    this.downCard.appendChild(this.downText);
    scope.addElement(this.downCard);

    /* ---- economy surfaces ---- */
    this.strip = new WalletStrip();
    hud.appendChild(this.strip.element);
    scope.addElement(this.strip.element);

    this.rail = new FortifyRail();
    hud.appendChild(this.rail.element);
    scope.addElement(this.rail.element);

    this.shop = new ArmouryPanel({
      onBuy: (itemId, quantity) => { this.sendAction(ModeAction.BUY, itemId, quantity); },
      onSelectWall: (index) => { this.wallIndex = index; },
      onClose: () => { this.toggleShop(false); },
    });
    ui.appendChild(this.shop.element);
    scope.addElement(this.shop.element);

    /* ---- touch pads ---- */
    this.pads = div('dch dch-pads', ui);
    this.padFortify = div('dch-pad', this.pads);
    this.padFortify.textContent = 'BUILD';
    this.padArmoury = div('dch-pad', this.pads);
    this.padArmoury.textContent = 'BUY';
    this.padReady = div('dch-pad', this.pads);
    this.padReady.textContent = 'READY';
    this.touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    if (this.touch) { this.pads.classList.add('on'); this.cPadsOn = true; }
    scope.addListener(this.padFortify, 'click', () => { this.toggleCursor(!this.cursor); });
    scope.addListener(this.padArmoury, 'click', () => { this.toggleShop(!this.shop.isOpen); });
    scope.addListener(this.padReady, 'click', () => { this.sendAction(ModeAction.READY, 0, 0); });
    scope.addElement(this.pads);

    /* ---- run card ---- */
    this.card = div('dch dch-card off', ui);
    this.cardTitle = document.createElement('h2');
    this.cardTitle.textContent = 'OVERRUN';
    this.card.appendChild(this.cardTitle);
    this.cardSub = document.createElement('p');
    this.card.appendChild(this.cardSub);
    const grid = div('dch-grid', this.card);
    const labels = ['WAVE', 'KILLS', 'SCORE', 'BLOCKS', 'EARNED', 'TIME'];
    for (let i = 0; i < labels.length; i++) {
      const cell = div('dch-st', grid);
      const b = document.createElement('b');
      b.textContent = '0';
      const s = document.createElement('span');
      s.textContent = labels[i];
      cell.appendChild(b);
      cell.appendChild(s);
      this.cardStats.push(b);
    }
    const btns = div('dch-btns', this.card);
    const again = document.createElement('button');
    again.className = 'dch-btn go';
    again.textContent = 'RUN IT AGAIN';
    const leave = document.createElement('button');
    leave.className = 'dch-btn';
    leave.textContent = 'LEAVE';
    btns.appendChild(again);
    btns.appendChild(leave);
    this.cardNote = div('dch-note', this.card);
    scope.addListener(again, 'click', () => { this.restart(); });
    scope.addListener(leave, 'click', () => { this.ctx.host.requestExit('horde-run-over'); });
    scope.addElement(this.card);
  }

  private restart(): void {
    this.sendAction(ModeAction.RESTART, 0, 0);
    this.runOver = false;
    this.saved = false;
    this.survived = false;
    this.downed = false;
    this.wave = 0;
    this.score = 0;
    this.wallet.reset();
    this.repairHint = 0;
    this.resetLoadoutMirror();
    this.card.classList.add('off');
    this.view.pressure.reset();
    this.setBanner('FORTIFY', 'Fresh run. Same gates, same purse.', false);
  }

  /** Cached at enter: a pointer does not become coarse mid-run. */
  private touch = false;
  private isTouch(): boolean { return this.touch; }
}

/* ------------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------------ */

/**
 * Registered with the shell as
 * `registry.register(ModeId.HORDE, createHordeMode)`.
 */
export function createHordeMode(ctx: ModeContext): ModeInstance {
  return new HordeMode(ctx);
}

/**
 * The stylesheet id, so the shell can key a rule off it if the base HUD ever
 * needs a competing surface suppressed while Horde is up.
 */
export const HORDE_STYLE_ID = STYLE_ID;
