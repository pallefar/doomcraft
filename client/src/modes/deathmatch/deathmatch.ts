/**
 * DOOMCRAFT — Deathmatch, client side.
 *
 * The bar for this mode is voxiom.io Battle Royale, and its measured weakness
 * is not the art or the netcode — it is that clicking a mode tile buys you a
 * centred "Waiting for players...(2/50)" card for roughly twenty-five seconds
 * (ref/BAR.md, weakness #5; the card is right there in
 * ref/voxiom/desktop-08-combat.png). Everything in this file is built around
 * refusing to have that screen:
 *
 *   - The room is already running when the mode is entered. The local
 *     authoritative server booted with the page and `DeathmatchDirector.start()`
 *     filled it with bots before anybody clicked anything, so `enter()` has no
 *     handshake to wait on and no lobby to fill. It puts the HUD up and returns.
 *   - There is no blocking state. The only thing the mode says about an empty
 *     server is a two-and-a-half second ribbon that reads "bots are holding
 *     your slot", and it does not stop you playing while it is on screen.
 *   - The stopwatch is part of the product, not the test harness.
 *     `telemetry.clickToShootingMs` is measured live, from the click that
 *     entered the mode to the frame a round actually left the barrel, and is
 *     published on `window.__DC_DM__` so a capture run can read the real number
 *     out of the real build.
 *
 * The rest of the file is the match furniture the bar either lacks or buries:
 * a round strip (clock, frag limit as a *bar*, leader, your frags, bodies in
 * the match), a killfeed with weapon glyphs and a kill confirmation that lands
 * (`killfeed.ts`), a scoreboard built for a half-second read (`scoreboard.ts`),
 * a death card that counts you back in and then stands you up by itself instead
 * of parking you on "Click anywhere to respawn!", a spawn-protection indicator,
 * and Doom-style pickup toasts.
 *
 * Two rules this file keeps to, because it does not own the files it sits on:
 *
 *   1. **Nothing is edited, everything is registered.** The base HUD's
 *      competing surfaces are suppressed with one injected stylesheet keyed on
 *      a `data-dm` attribute, and the net client's kill callback is *chained*,
 *      not replaced. Both are undone through `ctx.scope`, so
 *      `registry.scopeStats().live` reads zero after the mode exits.
 *   2. **It works with or without the server sidecar.** If `S2C_MODE.STATE`
 *      is being routed, the round strip is authoritative. If it is not — the
 *      shell wiring is another module's job — every field falls back to
 *      something derived from the snapshot, so the mode is never blank.
 *
 * Per-frame cost: one `update` that reads a dozen numbers off the net client,
 * writes only the DOM cells whose value changed, and allocates nothing.
 */

import {
  InputAction,
  MATCH_DURATION_MS,
  MAX_ARMOR,
  MAX_HEALTH,
  RESPAWN_DELAY_MS,
  SCORE_LIMIT,
  SPAWN_PROTECTION_MS,
} from '@shared/constants';
import { PacketWriter, PS_BOT, PS_DEAD, type KillEvent } from '@shared/protocol';
import {
  AMMO_NAMES,
  AMMO_TYPE_COUNT,
  WEAPON_COUNT,
  ammoTypeOf,
  ownsWeapon,
  weaponName,
} from '@shared/weapons';
import {
  ModeId,
  ModePhase,
  encodeModeSelect,
  type ModeAction,
  type ModeContextMessage,
  type ModeEventMessage,
  type ModeStateBuffer,
} from '@shared/modes';

import {
  toModeSelectMessage,
  type ModeContext,
  type ModeHost,
  type ModeInstance,
} from '@/modes/registry';
import { MatchRail, awardText, economySurfacesOn, type RailCellSpec } from '@/hud/hud';

import { Killfeed, type KillfeedEvent } from './killfeed';
import {
  Scoreboard,
  ScoreRowBuffer,
  clockText,
  createScoreboardHeader,
  type ScoreboardHeader,
} from './scoreboard';

/* ------------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------------ */

/** How long the "match already live" ribbon stays up after entering. */
export const DM_RIBBON_MS = 2600;
/** Extra grace after the respawn floor before the mode stands you up itself. */
export const DM_AUTO_RESPAWN_MS = 3200;
/** Toast lifetime. */
export const DM_TOAST_MS = 2200;
/** Toasts on screen at once. Pooled; older ones are recycled. */
export const DM_TOAST_SLOTS = 4;
/** Pickup diffs inside this window after a respawn are the loadout, not a pickup. */
export const DM_RESPAWN_QUIET_MS = 500;
/** Round clock under this many seconds turns the clock cell red. */
export const DM_CLOCK_URGENT_SEC = 30;

/* ------------------------------------------------------------------------ *
 * The match rail
 * ------------------------------------------------------------------------ */

/**
 * The three cells this mode puts above the sightline, and the whole of the
 * mode's answer to "what is the state of the match".
 *
 * Round 1 shipped six pills here — ROUND 1 / TIME 7:43 / FRAG LIMIT 0/30 /
 * LEADER Marine 0 / YOU 0 / IN MATCH 1+5 — twelve strings across ~650 px of
 * the one band of screen the player is aiming through. FRAG LIMIT, LEADER and
 * YOU were three views of one number; "1+5" was not decodable at all.
 *
 * What survives is what only the top-centre can carry:
 *   - the clock, the one match fact checked on a rhythm rather than an event;
 *   - `YOU n / limit`, which fuses the three score cells into the pair you
 *     actually play against;
 *   - `PLAYERS n`, the roster size in plain digits.
 *
 * Leader and round went to the Tab board — a ranking is a sorted list, and the
 * board already sorts by frags and prints the round in its title — and the
 * humans/bots split went to the board's footer, in words. `MatchRail` refuses
 * to build a fourth cell, so this list cannot quietly grow back.
 */
export const RAIL_CELLS: readonly RailCellSpec[] = Object.freeze([
  { label: '', kind: 'clock' },
  { label: 'You', kind: 'you' },
  { label: 'Players', kind: '' },
]);

export const RAIL_CLOCK = 0;
export const RAIL_YOU = 1;
export const RAIL_PLAYERS = 2;

/* ------------------------------------------------------------------------ *
 * Telemetry
 * ------------------------------------------------------------------------ */

/**
 * The number this mode is judged on, measured in the shipping build rather
 * than in a harness. `clickToShootingMs` is the wall clock from the click that
 * entered Deathmatch to the frame on which a shot actually left the gun.
 */
export interface DeathmatchTelemetry {
  /** `performance.now()` at the click (or at `enter()` when the shell did not stamp one). */
  clickAtMs: number;
  /** First frame the player could have fired: world drawable, alive, in control. */
  armedAtMs: number;
  /** First frame a round actually left the barrel. */
  firstShotAtMs: number;
  /** `armedAtMs - clickAtMs`. -1 until it happens. */
  clickToArmedMs: number;
  /** `firstShotAtMs - clickAtMs`. -1 until it happens. */
  clickToShootingMs: number;
  /** Bodies in the match on the frame the player was armed. */
  bodiesAtArm: number;
  /** Of those, how many were bots holding a slot for a human. */
  botsAtArm: number;
  kills: number;
  deaths: number;
  confirmations: number;
}

function createTelemetry(): DeathmatchTelemetry {
  return {
    clickAtMs: 0, armedAtMs: -1, firstShotAtMs: -1,
    clickToArmedMs: -1, clickToShootingMs: -1,
    bodiesAtArm: 0, botsAtArm: 0, kills: 0, deaths: 0, confirmations: 0,
  };
}

/** The global the capture harness reads. Optional and side-effect free. */
export const DM_TELEMETRY_GLOBAL = '__DC_DM__';
/**
 * The shell may stamp `performance.now()` here on the click that starts a mode
 * so the stopwatch starts at the pointer-down rather than at `enter()`. When it
 * is absent the mode uses its own entry time, which is within a microtask.
 */
export const DM_CLICK_GLOBAL = '__DC_CLICK_MS__';

/* ------------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------------ */

const STYLE_ID = 'dm-mode-css';

const CSS = `
/* The base HUD's own board, kill lines and centred death text are replaced by
   this mode's richer versions. Suppressed by attribute, restored by removing
   it — the HUD module is never touched. */
#hud[data-dm="1"] .dc-board{display:none!important}
#hud[data-dm="1"] .dc-chips{display:none!important}
#hud[data-dm="1"] .dc-feed .ln.k{display:none!important}
#hud[data-dm="1"][data-dm-death="1"] .dc-status{display:none!important}

/* The round strip that used to live here is gone. It was six pills and twelve
   strings across ~650 px directly above the sightline — ROUND / TIME / FRAG
   LIMIT / LEADER / YOU / IN MATCH — three of which said the same thing about
   the score and one of which ("1+5") could not be decoded at all. The mode now
   fills the HUD's own three-cell MatchRail (client/src/hud/hud.ts), which
   caps the cell count in code and carries the HUD's shared plate tokens, so
   there is no per-mode container treatment here to drift out of sync. Leader
   and round moved to the Tab board, which is where a ranking belongs. */

/* ---- the entry ribbon ----------------------------------------------------
   It sits under the match rail, NOT over the crosshair. Centre screen belongs
   to combat feedback — the kill confirmation, the multi-kill callout and the
   death card all live there, and a welcome banner has no business competing
   with any of them. It also never blocks: it is 2.6 s of text you can shoot
   straight through, which is the entire difference from the bar's card. */
#hud .dm-ribbon{position:absolute;left:50%;top:52px;transform:translateX(-50%);
  width:min(520px,92vw);text-align:center;pointer-events:none;opacity:0;
  transition:opacity .3s ease-out;contain:layout style}
#hud .dm-ribbon.on{opacity:1}
#hud .dm-ribbon .t{font:900 clamp(15px,2.1vw,22px)/1 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.18em;color:#f6e3c8;text-shadow:0 2px 0 #7a1a08,0 6px 22px rgba(224,60,28,.55)}
#hud .dm-ribbon .s{margin-top:6px;font:11.5px/1.35 ui-monospace,Menlo,monospace;color:#cbc4be;
  letter-spacing:.04em;text-shadow:0 1px 3px rgba(0,0,0,.95)}
#hud .dm-ribbon .s b{color:#f0a020}
/* While the ribbon is up the toast lane steps out of its way. Nothing can have
   been picked up in the first two seconds anyway. */
#hud[data-dm-ribbon="1"] .dm-toasts{top:112px}

/* ---- death card ---- */
#hud .dm-death{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:min(360px,84vw);padding:16px 18px 14px;text-align:center;display:none;
  background:rgba(12,5,4,.9);border:1px solid rgba(224,60,28,.42);border-radius:var(--dc-r);
  box-shadow:0 22px 60px rgba(0,0,0,.7);pointer-events:none;contain:layout style}
#hud .dm-death.on{display:block}
#hud .dm-death .t{font:900 clamp(20px,3vw,30px)/1 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.14em;color:#ff6a48;text-shadow:0 2px 0 #4a1005}
#hud .dm-death .by{margin-top:8px;font:13px/1.3 ui-monospace,Menlo,monospace;color:#cfc9c3}
#hud .dm-death .by b{color:#f6e3c8}
#hud .dm-death .track{height:5px;margin:13px 0 9px;border-radius:3px;
  background:rgba(255,255,255,.10);overflow:hidden}
#hud .dm-death .track u{display:block;height:100%;width:100%;transform-origin:left center;
  transform:scaleX(0);text-decoration:none;background:linear-gradient(90deg,#8f1a08,#f0a020)}
#hud .dm-death .cta{font:12px/1.3 ui-monospace,Menlo,monospace;letter-spacing:.08em;color:#8a8078}
#hud .dm-death .cta b{color:#e8e6e3;background:rgba(255,255,255,.09);border-radius:2px;padding:0 5px}
#hud .dm-death.ready .cta{color:#f6e3c8}

/* ---- spawn protection ---- */
#hud .dm-shield{position:absolute;inset:0;pointer-events:none;display:none;
  box-shadow:inset 0 0 0 2px rgba(80,168,240,.5),inset 0 0 46px rgba(80,168,240,.22)}
#hud .dm-shield.on{display:block;animation:dmshield .9s ease-in-out infinite}
@keyframes dmshield{50%{box-shadow:inset 0 0 0 2px rgba(80,168,240,.22),
  inset 0 0 30px rgba(80,168,240,.10)}}
#hud .dm-shield span{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  margin-top:104px;font:700 11px/1 ui-monospace,Menlo,monospace;letter-spacing:.2em;
  color:#9fd0f5;text-shadow:0 1px 3px rgba(0,0,0,.95)}

/* ---- pickup toasts ---- */
#hud .dm-toasts{position:absolute;left:50%;top:56px;transform:translateX(-50%);
  display:flex;flex-direction:column;align-items:center;gap:4px;pointer-events:none;
  font:700 12px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;contain:layout style}
#hud .dm-toasts .toast{display:none;padding:4px 11px;border-radius:var(--dc-r);
  background:var(--dc-plate);border:1px solid var(--dc-line);
  border-left:3px solid #f0a020;color:#f2efec;letter-spacing:.06em;
  text-shadow:0 1px 2px rgba(0,0,0,.95);
  animation:dmtoast var(--life,2200ms) cubic-bezier(.2,.8,.3,1) forwards}
#hud .dm-toasts .toast.on{display:block}
#hud .dm-toasts .toast.hp{border-left-color:#4fb84a}
#hud .dm-toasts .toast.ap{border-left-color:#50a8f0}
#hud .dm-toasts .toast.wp{border-left-color:#e03c1c}
@keyframes dmtoast{
  0%{opacity:0;transform:translateY(-9px) scale(.96)}
  10%{opacity:1;transform:translateY(0) scale(1)}
  78%{opacity:1;transform:translateY(0) scale(1)}
  100%{opacity:0;transform:translateY(-6px) scale(1)}
}

/* ---- compact: 412 px of height, re-zoned rather than shrunk ---------------
   Measured, not guessed. On a short screen the base HUD parks its chat/kill
   lane at the TOP-LEFT — .dc-feed{top:8px;left:120px} at 915x412 and
   left:116px at 412x915 — which is exactly where a centred round strip
   lands. Squeezing the strip into the gap between that lane and the killfeed
   is how you end up with the bar's own mobile HUD (BAR.md #11): desktop
   furniture crammed into a quarter of the screen.

   So the strip stops being a strip. On a compact screen it becomes a chip
   COLUMN under the minimap — the lane the base HUD reserves for its own three
   chips, which this mode has already suppressed, and the same place the bar
   puts its alive/kills/timer pills. That lane is free by construction: the
   minimap ends at y=112, the thumb stick starts at y=286, and nothing else
   claims the left gutter in between. Nothing overlaps, nothing is clipped, and
   the four numbers that decide the match stay full size. */
/* The rail's own compact re-zoning lives with the rail, in hud.ts: on a short
   screen it leaves the centre entirely for the left gutter under the minimap. */
/* The ribbon and the toasts drop into the band between the chat lane (which
   ends around y=110) and the crosshair (y=206 on a 412 px screen). Both are
   transient, both are centred, and neither is ever on screen at the same time
   as the other — nothing can have been picked up in the ribbon's 2.6 s. */
#hud[data-compact="1"] .dm-ribbon{top:118px;width:min(420px,94vw)}
#hud[data-compact="1"] .dm-toasts{top:118px;font-size:10px}
#hud[data-compact="1"][data-dm-ribbon="1"] .dm-toasts{top:176px}
#hud[data-compact="1"] .dm-death{width:min(300px,82vw);padding:12px 14px 11px}
#hud[data-compact="1"] .dm-shield span{margin-top:74px}
/* 412 px of width cannot hold a 420 px ribbon beside a chip column, so in
   portrait the ribbon drops below the column instead of printing over it.
   There is room: the chips end at y=194 and the crosshair is at y=457. */
#hud[data-portrait="1"] .dm-ribbon{top:206px;width:min(340px,88vw)}
#hud[data-portrait="1"] .dm-toasts{top:206px}
#hud[data-portrait="1"][data-dm-ribbon="1"] .dm-toasts{top:282px}

@media (prefers-reduced-motion:reduce){
  #hud .dm-shield.on{animation:none}
  #hud .dm-toasts .toast{animation-duration:1ms;opacity:1}
}
`;

/* ------------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------------ */

function div(cls: string, parent?: HTMLElement): HTMLElement {
  const n = document.createElement('div');
  n.className = cls;
  if (parent !== undefined) parent.appendChild(n);
  return n;
}

/** Write only when the value differs. Every hot DOM write in this file goes through it. */
function setText(node: HTMLElement, value: string, cache: string): string {
  if (value === cache) return cache;
  node.textContent = value;
  return value;
}

/* ------------------------------------------------------------------------ *
 * Round view
 * ------------------------------------------------------------------------ */

/**
 * What the rail and the scoreboard header need, filled either from the
 * server's state sidecar or — while the shell has not wired it yet — derived
 * from the snapshot so nothing on screen is ever blank.
 */
interface RoundView {
  phase: ModePhase;
  round: number;
  timeLeftSec: number;
  leaderId: number;
  leaderName: string;
  leaderScore: number;
  scoreLimit: number;
  humans: number;
  bodies: number;
  myScore: number;
  /** True while the numbers come from the server rather than being derived. */
  authoritative: boolean;
}

/* ------------------------------------------------------------------------ *
 * The mode
 * ------------------------------------------------------------------------ */

export class DeathmatchMode implements ModeInstance {
  readonly id = ModeId.DEATHMATCH;
  readonly telemetry: DeathmatchTelemetry = createTelemetry();

  private readonly ctx: ModeContext;
  private readonly host: ModeHost;
  private readonly hudRoot: HTMLElement;

  private readonly board: Scoreboard;
  private readonly feed: Killfeed;
  private readonly rowBuffer = new ScoreRowBuffer();
  private readonly header: ScoreboardHeader = createScoreboardHeader();
  private readonly view: RoundView = {
    phase: ModePhase.WAITING, round: 0, timeLeftSec: 0,
    leaderId: 0, leaderName: '', leaderScore: 0, scoreLimit: SCORE_LIMIT,
    humans: 0, bodies: 0, myScore: 0, authoritative: false,
  };

  /* --- DOM --- */
  /**
   * The HUD's three-cell rail, filled here rather than re-implemented: clock,
   * your frags against the limit, roster size. `RAIL_CLOCK`/`RAIL_YOU`/
   * `RAIL_PLAYERS` are its only three indices and `MatchRail` will not build a
   * fourth cell, which is the point.
   */
  private rail!: MatchRail;

  private ribbon!: HTMLElement;
  private ribbonTitle!: HTMLElement;
  private ribbonSub!: HTMLElement;

  private death!: HTMLElement;
  private deathBy!: HTMLElement;
  private deathFill!: HTMLElement;
  private deathCta!: HTMLElement;

  private shield!: HTMLElement;
  private toastRoot!: HTMLElement;
  private readonly toasts: HTMLElement[] = [];
  private toastCursor = 0;

  /* --- cached DOM text, so an unchanged cell is never written --- */
  private cDeathBy = '';
  private cDeathCta = '';
  private cDeathFill = -1;
  private cShield = false;
  private cDeathOpen = false;
  private cBoardOpen = false;
  /** S12 state: are we inside the intermission the card was decided for. */
  private cInIntermission = false;
  private sponsorCardDispose: (() => void) | null = null;
  private cRibbon = false;
  private cRibbonSub = '';
  private lastRound = -1;

  /* --- state --- */
  private serverState: ModeStateBuffer | null = null;
  private serverStateAtMs = -1;
  private ribbonUntilMs = 0;
  private localRoundStartMs = -1;
  private wasDead = false;
  private deathAtMs = 0;
  private autoRespawnAtMs = 0;
  private lastKillerName = '';
  private lastKillerWeapon = 0;
  private lastKillerFlags = 0;
  /** Health the killer had left when they killed you. -1 = unknown. */
  private lastKillerHealth = -1;
  private protectUntilMs = 0;
  private quietUntilMs = 0;
  private lastShotSeq = -1;
  private prevHealth = -1;
  private prevArmor = -1;
  private prevOwned = -1;
  private readonly prevReserve = new Int32Array(AMMO_TYPE_COUNT).fill(-1);
  private paused = false;
  private entered = false;
  /** Bodies the room will accept, from `S2C_MODE.CONTEXT`. 0 = unknown. */
  private arenaCapacity = 0;

  constructor(ctx: ModeContext) {
    this.ctx = ctx;
    this.host = ctx.host;
    this.hudRoot = ctx.host.hudRoot;

    this.installStyle();
    this.buildDom();

    this.feed = new Killfeed({
      root: this.hudRoot,
      localId: () => this.host.game.net.playerId,
      nameOf: (id) => this.nameOf(id),
      isBot: (id) => this.isBot(id),
    });
    ctx.scope.add(() => { this.feed.destroy(); });

    this.board = new Scoreboard({ root: this.hudRoot });
    ctx.scope.add(() => { this.board.destroy(); });
    ctx.scope.add(() => { this.dropSponsorCard(); });

    this.hookKillEvents();
    this.applyFeedOffset();
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  enter(): void {
    if (this.entered) return;
    this.entered = true;

    const now = this.nowMs();
    const stamped = this.readClickStamp();
    this.telemetry.clickAtMs = stamped > 0 && stamped <= now ? stamped : now;

    // The room this mode is entering has been live since the page booted. The
    // only thing left to say is which mode we are in, and that is one packet.
    this.sendModeSelect();

    // The base HUD's board, chips, kill lines and death text step aside.
    this.hudRoot.dataset.dm = '1';
    this.ctx.scope.add(() => {
      delete this.hudRoot.dataset.dm;
      delete this.hudRoot.dataset.dmDeath;
      delete this.hudRoot.dataset.dmRibbon;
    });

    // The bar's equivalent moment is a card that blocks input for ~25 s. Ours
    // is a ribbon that says the fight is already happening and fades on its own.
    this.ribbonUntilMs = now + DM_RIBBON_MS;
    this.ribbonTitle.textContent = 'MATCH LIVE';
    this.showRibbon(true);
    this.host.setStatus('');

    this.publishTelemetry();
    this.ctx.scope.add(() => { this.unpublishTelemetry(); });
  }

  exit(): void {
    this.showRibbon(false);
    this.board.setOpen(false);
    delete this.hudRoot.dataset.dmDeath;
  }

  /* ---------------------------------------------------------------- *
   * Frame
   * ---------------------------------------------------------------- */

  update(dt: number, nowMs: number): void {
    if (this.paused) return;
    const game = this.host.game;
    const net = game.net;

    this.readRound(nowMs);
    this.trackArming(nowMs);
    this.trackShots(nowMs);
    this.trackDeath(nowMs);
    this.trackPickups(nowMs);

    this.paintRail(nowMs);
    this.paintDeath(nowMs);
    this.paintShield(nowMs);
    this.feed.update(nowMs);

    if (this.ribbonUntilMs !== 0) {
      if (nowMs >= this.ribbonUntilMs) this.dismissRibbon();
      else this.showRibbon(true);      // refresh the body count while it is up
    }

    // S12: the sponsor card exists exactly while the round is over — never on
    // a Tab-hold mid-round, which is live play and carries no sponsor surface
    // (docs/SPONSORS.md §4.3). One decision per intermission; the disposer
    // flushes the meter and empties the mount when the next round starts.
    const inIntermission = this.view.phase === ModePhase.INTERMISSION;
    if (inIntermission !== this.cInIntermission) {
      this.cInIntermission = inIntermission;
      if (inIntermission) {
        this.sponsorCardDispose = this.host.sponsorCard?.(this.board.sponsorMount, {
          mode: ModeId.DEATHMATCH,
          interactive: false,  // the board lives in #hud, pointer-events: none
          active: () => this.view.phase === ModePhase.INTERMISSION && this.board.isOpen,
        }) ?? null;
      } else {
        this.dropSponsorCard();
      }
    }

    // Tab holds the board; an intermission shows it without being asked, which
    // is the moment a player most wants to see where they finished.
    const wantBoard = (game.playing && game.input.isDown(InputAction.Scoreboard))
      || this.view.phase === ModePhase.INTERMISSION;
    if (wantBoard !== this.cBoardOpen) {
      this.cBoardOpen = wantBoard;
      this.board.setOpen(wantBoard);
    }
    if (wantBoard) {
      const rows = this.rowBuffer.fill(net.players, net.playerId, net.rttMs);
      this.fillHeader();
      this.board.update(rows, this.header);
    }

    this.telemetry.kills = net.local.kills;
    this.telemetry.deaths = net.local.deaths;
    this.telemetry.confirmations = this.feed.confirmations;
    void dt;
  }

  private dropSponsorCard(): void {
    try { this.sponsorCardDispose?.(); } catch { /* a card must never break the round loop */ }
    this.sponsorCardDispose = null;
  }

  onResize(): void {
    this.applyFeedOffset();
  }

  onPause(paused: boolean): void {
    this.paused = paused;
    if (paused) this.board.setOpen(false);
  }

  /* ---------------------------------------------------------------- *
   * Server messages
   * ---------------------------------------------------------------- */

  onModeState(state: ModeStateBuffer): void {
    this.serverState = state;
    this.serverStateAtMs = this.nowMs();
  }

  onModeEvent(event: ModeEventMessage): void {
    if (event.text.length > 0) this.feed.pushNote(event.text, this.nowMs());
  }

  onModeContext(context: ModeContextMessage): void {
    // The only field Deathmatch cares about: how big the arena can get, which
    // the scoreboard footer turns into "6 of 32".
    if (context.maxPlayers > 0) this.arenaCapacity = context.maxPlayers;
    if (context.title.length > 0) this.feed.pushNote(context.title, this.nowMs());
  }

  onAction(_action: ModeAction, _a: number, _b: number): boolean {
    return false;
  }

  /* ---------------------------------------------------------------- *
   * Round state
   * ---------------------------------------------------------------- */

  /**
   * Prefer the server's sidecar; fall back to the snapshot. A sidecar older
   * than two seconds is treated as absent, so a server that stops sending does
   * not freeze the clock on screen.
   */
  private readRound(nowMs: number): void {
    const net = this.host.game.net;
    const v = this.view;
    const s = this.serverState;
    const fresh = s !== null && nowMs - this.serverStateAtMs < 2000;

    /* --- roster, always from the snapshot: it is the cheapest truth --- */
    let bodies = 0;
    let humans = 0;
    let leaderId = 0;
    let leaderScore = -1;
    for (let i = 0; i < net.players.length; i++) {
      const p = net.players[i];
      if (!p.active) continue;
      bodies++;
      if ((p.state & PS_BOT) === 0) humans++;
      if (p.kills > leaderScore || (p.kills === leaderScore && p.id < leaderId)) {
        leaderScore = p.kills;
        leaderId = p.id;
      }
    }
    v.bodies = bodies;
    v.humans = humans;
    v.myScore = net.local.kills;

    if (fresh && s !== null) {
      v.authoritative = true;
      v.phase = s.phase;
      v.round = s.index;
      v.timeLeftSec = Math.ceil(s.phaseMsLeft / 1000);
      v.scoreLimit = s.aTotal > 0 ? s.aTotal : SCORE_LIMIT;
      v.leaderScore = s.a;
      if (s.bTotal > 0) v.bodies = s.bTotal;
      v.humans = s.b;
      v.leaderId = leaderId;
    } else {
      v.authoritative = false;
      v.scoreLimit = SCORE_LIMIT;
      v.leaderScore = leaderScore < 0 ? 0 : leaderScore;
      v.leaderId = leaderId;
      v.round = 1;
      // The clock starts when the local player does, which is exactly what the
      // server does with it: no human, no clock.
      if (this.localRoundStartMs < 0 && this.host.game.playing) this.localRoundStartMs = nowMs;
      if (net.matchOver) {
        v.phase = ModePhase.INTERMISSION;
        v.timeLeftSec = 0;
      } else if (this.localRoundStartMs < 0) {
        v.phase = ModePhase.WAITING;
        v.timeLeftSec = Math.ceil(MATCH_DURATION_MS / 1000);
      } else {
        v.phase = ModePhase.LIVE;
        const left = MATCH_DURATION_MS - (nowMs - this.localRoundStartMs);
        v.timeLeftSec = Math.max(0, Math.ceil(left / 1000));
      }
    }
    v.leaderName = v.leaderId === 0 ? '' : this.nameOf(v.leaderId);

    // A new round wipes the killfeed and every streak: carrying either across
    // an intermission would be a lie the scoreboard then repeats.
    if (v.round !== this.lastRound) {
      if (this.lastRound !== -1) {
        this.feed.clear();
        this.rowBuffer.resetStreaks();
      }
      this.lastRound = v.round;
    }
  }

  private fillHeader(): void {
    const v = this.view;
    const h = this.header;
    // The round number came off the rail and landed here, where it is read on
    // purpose rather than in peripheral vision over the top of a fight.
    const round = Math.max(1, v.round);
    h.title = v.phase === ModePhase.INTERMISSION
      ? `DEATHMATCH · ROUND ${round} OVER`
      : v.phase === ModePhase.WAITING
        ? 'DEATHMATCH · WARMUP'
        : `DEATHMATCH · ROUND ${round}`;
    h.timeLeftSec = v.phase === ModePhase.WAITING ? 0 : v.timeLeftSec;
    h.leaderScore = v.leaderScore;
    h.scoreLimit = v.scoreLimit;
    h.humans = v.humans;
    h.bodies = v.bodies;
    const cap = this.arenaCapacity > 0 ? ` of ${this.arenaCapacity}` : '';
    h.note = v.humans < v.bodies
      ? `${v.bodies - v.humans} bots holding slots${cap}`
      : `All human${cap}`;
    /* Deathmatch has no end-of-match card — the mode retitles this board and
     * that is the whole ceremony. So the reward goes on the one free string
     * channel the board already has (`header.note` -> `footRight`) rather than
     * onto the sightline, where `statusInk()` would price it over budget and
     * demote it to a corner chip anyway. A real card is A2.
     *
     * `awardText` returns '' until the server has actually paid something, so
     * an offline match reads exactly as it did before this existed. */
    const paid = awardText(this.host.game.net.sessionXp, this.host.game.net.sessionScrap);
    if (paid !== '' && economySurfacesOn(this.host.game.economyProduct, this.host.game.net.flagBits)) {
      h.note = `${h.note} · ${paid}`;
    }
  }

  /* ---------------------------------------------------------------- *
   * Instant start — the measured claim
   * ---------------------------------------------------------------- */

  /**
   * The frame the player could have fired. Everything must be true at once:
   * the world is drawable, the shell has handed over control, the net client
   * is in `playing`, and the body is alive. That is the honest definition of
   * "you can shoot now", and it is what the stopwatch stops on.
   */
  private trackArming(nowMs: number): void {
    if (this.telemetry.armedAtMs >= 0) return;
    const game = this.host.game;
    if (!game.ready || !game.playing) return;
    if (game.net.status !== 'playing') return;
    if (game.net.local.dead) return;

    this.telemetry.armedAtMs = nowMs;
    this.telemetry.clickToArmedMs = Math.max(0, nowMs - this.telemetry.clickAtMs);
    this.telemetry.bodiesAtArm = this.view.bodies;
    this.telemetry.botsAtArm = Math.max(0, this.view.bodies - this.view.humans);
    // First spawn is protected exactly as the server protects it.
    this.protectUntilMs = nowMs + SPAWN_PROTECTION_MS;
    this.publishTelemetry();
  }

  /** `WeaponRuntime.shotSeq` ticks once per shot; the first tick stops the clock. */
  private trackShots(nowMs: number): void {
    const seq = this.host.game.weapons.shotSeq;
    if (this.lastShotSeq < 0) { this.lastShotSeq = seq; return; }
    if (seq === this.lastShotSeq) return;
    this.lastShotSeq = seq;
    if (this.telemetry.firstShotAtMs >= 0) return;
    this.telemetry.firstShotAtMs = nowMs;
    this.telemetry.clickToShootingMs = Math.max(0, nowMs - this.telemetry.clickAtMs);
    this.publishTelemetry();
  }

  /* ---------------------------------------------------------------- *
   * Death and respawn
   * ---------------------------------------------------------------- */

  private trackDeath(nowMs: number): void {
    const net = this.host.game.net;
    const dead = net.local.dead;

    if (dead && !this.wasDead) {
      this.deathAtMs = nowMs;
      this.autoRespawnAtMs = nowMs + RESPAWN_DELAY_MS + DM_AUTO_RESPAWN_MS;
      this.feed.confirmDeath();
      this.dismissRibbon();
      this.hudRoot.dataset.dmDeath = '1';
    } else if (!dead && this.wasDead) {
      // Fresh body: protected, and the pickup diff baselines are reset so the
      // spawn loadout does not read as four pickups at once.
      this.protectUntilMs = nowMs + SPAWN_PROTECTION_MS;
      this.quietUntilMs = nowMs + DM_RESPAWN_QUIET_MS;
      this.lastKillerName = '';
      delete this.hudRoot.dataset.dmDeath;
    }
    this.wasDead = dead;

    // Nobody is left staring at a corpse. Past the floor plus a readable
    // grace, the mode asks for the respawn itself.
    if (dead && nowMs >= this.autoRespawnAtMs) {
      this.autoRespawnAtMs = nowMs + 500;      // retry cadence if the ask is refused
      net.requestRespawn();
    }
  }

  private paintDeath(nowMs: number): void {
    const dead = this.host.game.net.local.dead;
    if (dead !== this.cDeathOpen) {
      this.cDeathOpen = dead;
      this.death.classList.toggle('on', dead);
    }
    if (!dead) return;

    const by = this.lastKillerName === '' ? 'HELL' : this.lastKillerName;
    const weapon = this.lastKillerName === '' ? '' : ` · ${weaponName(this.lastKillerWeapon)}`;
    const left = this.lastKillerHealth >= 0 ? ` · ${this.lastKillerHealth} HP left` : '';
    this.cDeathBy = setText(this.deathBy, `${by}${weapon}${left}`, this.cDeathBy);

    const waited = nowMs - this.deathAtMs;
    const frac = Math.max(0, Math.min(1, waited / RESPAWN_DELAY_MS));
    const q = Math.round(frac * 50);
    if (q !== this.cDeathFill) {
      this.deathFill.style.transform = `scaleX(${(q / 50).toFixed(2)})`;
      this.cDeathFill = q;
    }
    const ready = frac >= 1;
    this.death.classList.toggle('ready', ready);
    const cta = ready
      ? 'SPACE or FIRE to respawn — auto in ' + Math.max(0, Math.ceil((this.autoRespawnAtMs - nowMs) / 1000)) + 's'
      : 'Respawning in ' + (((RESPAWN_DELAY_MS - waited) / 1000).toFixed(1)) + 's';
    this.cDeathCta = setText(this.deathCta, cta, this.cDeathCta);
  }

  private paintShield(nowMs: number): void {
    const on = !this.host.game.net.local.dead
      && this.protectUntilMs > nowMs
      && this.host.game.playing;
    if (on === this.cShield) return;
    this.cShield = on;
    this.shield.classList.toggle('on', on);
  }

  /* ---------------------------------------------------------------- *
   * Pickups
   * ---------------------------------------------------------------- */

  /**
   * Doom told you what you picked up. The bar tells you nothing — its own tip
   * line admits it: "You automatically pick up surrounding items". These
   * toasts are diffed off the authoritative local state rather than guessed
   * from proximity, so they only ever fire on something you really got.
   */
  private trackPickups(nowMs: number): void {
    const net = this.host.game.net;
    const w = this.host.game.weapons;
    const quiet = nowMs < this.quietUntilMs || net.local.dead;

    const health = net.local.health;
    if (this.prevHealth >= 0 && !quiet && health > this.prevHealth) {
      const gain = health - this.prevHealth;
      this.toast(`+${gain} HEALTH`, 'hp');
    }
    this.prevHealth = health;

    const armor = net.local.armor;
    if (this.prevArmor >= 0 && !quiet && armor > this.prevArmor) {
      this.toast(`+${armor - this.prevArmor} ARMOR`, 'ap');
    }
    this.prevArmor = armor;

    const owned = w.owned;
    if (this.prevOwned >= 0 && !quiet && owned !== this.prevOwned) {
      for (let i = 0; i < WEAPON_COUNT; i++) {
        if (ownsWeapon(owned, i) && !ownsWeapon(this.prevOwned, i)) {
          this.toast(weaponName(i).toUpperCase(), 'wp');
        }
      }
    }
    this.prevOwned = owned;

    // Ammo, but only for the type in hand: a toast per reserve is noise.
    const type = ammoTypeOf(w.current);
    if (type > 0 && type < AMMO_TYPE_COUNT) {
      const have = w.reserve[type];
      const prev = this.prevReserve[type];
      if (prev >= 0 && !quiet && have > prev) {
        this.toast(`+${have - prev} ${AMMO_NAMES[type].toUpperCase()}`, '');
      }
    }
    for (let i = 0; i < AMMO_TYPE_COUNT; i++) this.prevReserve[i] = w.reserve[i];
  }

  private toast(text: string, kind: string): void {
    const node = this.toasts[this.toastCursor];
    this.toastCursor = (this.toastCursor + 1) % this.toasts.length;
    node.className = 'toast';
    node.textContent = text;
    // Re-adding restarts the CSS animation without reading back any layout.
    this.toastRoot.removeChild(node);
    node.className = `toast on${kind === '' ? '' : ` ${kind}`}`;
    this.toastRoot.appendChild(node);
  }

  /* ---------------------------------------------------------------- *
   * Match rail
   * ---------------------------------------------------------------- */

  private paintRail(nowMs: number): void {
    const v = this.view;
    void nowMs;

    const warm = v.phase === ModePhase.WAITING;
    const over = v.phase === ModePhase.INTERMISSION;
    this.rail.set(RAIL_CLOCK, warm ? 'LIVE' : over ? 'OVER' : clockText(v.timeLeftSec));
    const urgent = !warm && !over && v.timeLeftSec <= DM_CLOCK_URGENT_SEC;
    this.rail.flag(RAIL_CLOCK, urgent ? 'urgent' : warm ? 'warm' : '');

    // ONE score cell, not three. Your frags against the number that ends the
    // match is the pair you play against; who is currently ahead is a ranking,
    // and a ranking is a sorted list, so it is the Tab board's job.
    this.rail.set(RAIL_YOU, `${v.myScore} / ${v.scoreLimit}`);

    // Roster size in plain digits. The humans-plus-bots split ("1+5") read as
    // arithmetic nobody does mid-fight; it is a lobby fact and it is spelled
    // out in words in the Tab board's footer.
    this.rail.set(RAIL_PLAYERS, String(v.bodies));
  }

  /* ---------------------------------------------------------------- *
   * Kill events
   * ---------------------------------------------------------------- */

  /**
   * Chain onto the net client's kill callback rather than replacing it: the
   * base HUD keeps whatever it does with the event and the mode adds its feed
   * on top. The previous handler is restored on exit through the scope, so
   * nothing survives a mode switch.
   */
  private hookKillEvents(): void {
    const events = this.host.game.net.events;
    const previous = events.onKill;
    const chained = (e: KillEvent): void => {
      this.onKill(e);
      previous?.call(events, e);
    };
    events.onKill = chained;
    this.ctx.scope.add(() => {
      // Only unhook our own handler. If something else layered on top after us
      // its hook stays, which is the correct behaviour for a chain.
      if (events.onKill === chained) events.onKill = previous;
    });
  }

  private onKill(e: KillfeedEvent): void {
    const now = this.nowMs();
    this.feed.push(e, now);
    this.rowBuffer.noteKill(e.killerId, e.victimId, e.killerStreak);
    // The first thing that actually happens retires the welcome ribbon.
    this.dismissRibbon();
    if (e.victimId === this.host.game.net.playerId) {
      const anon = e.killerId === 0 || e.killerId === e.victimId;
      this.lastKillerName = anon ? '' : this.nameOf(e.killerId);
      this.lastKillerWeapon = e.weaponId;
      this.lastKillerFlags = e.flags;
      // "You had them at 23" is the most useful thing a death screen can say,
      // and the snapshot already knows it.
      const killer = anon ? undefined : this.host.game.net.playerById(e.killerId);
      this.lastKillerHealth = killer === undefined ? -1 : Math.max(0, Math.round(killer.health));
    }
  }

  /* ---------------------------------------------------------------- *
   * Small helpers
   * ---------------------------------------------------------------- */

  private nowMs(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  private nameOf(id: number): string {
    if (id === 0) return 'HELL';
    const p = this.host.game.net.playerById(id);
    return p === undefined || p.name === '' ? `#${id}` : p.name;
  }

  private isBot(id: number): boolean {
    const p = this.host.game.net.playerById(id);
    return p !== undefined && (p.state & PS_BOT) !== 0;
  }

  /** True while the local body is dead. Exposed for the shell and the tests. */
  get localDead(): boolean { return this.host.game.net.local.dead; }
  /** The round as this mode currently understands it. */
  get round(): Readonly<RoundView> { return this.view; }

  private sendModeSelect(): void {
    // Exactly once. An older server that does not route id 16 records one
    // protocol violation and carries on; twenty-four are needed to matter.
    try {
      const writer = new PacketWriter(96);
      encodeModeSelect(writer, toModeSelectMessage(this.ctx.params));
      this.host.send(writer.copy());
    } catch {
      // A shell without a live socket yet is not a reason to fail the mode.
    }
  }

  private readClickStamp(): number {
    const w = window as unknown as Record<string, unknown>;
    const v = w[DM_CLICK_GLOBAL];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }

  private publishTelemetry(): void {
    (window as unknown as Record<string, unknown>)[DM_TELEMETRY_GLOBAL] = this.telemetry;
  }

  private unpublishTelemetry(): void {
    const w = window as unknown as Record<string, unknown>;
    if (w[DM_TELEMETRY_GLOBAL] === this.telemetry) delete w[DM_TELEMETRY_GLOBAL];
  }

  /** The killfeed clears the FPS read-out when the player has it switched on. */
  private applyFeedOffset(): void {
    this.feed.element.classList.toggle('fps', this.host.settings.fpsCounter);
  }

  /**
   * The ribbon's body count is only known once a snapshot has landed, so the
   * text is refreshed on every frame it is up rather than frozen at `enter()` —
   * otherwise it reads "1 already fighting" for its whole life.
   */
  private showRibbon(on: boolean): void {
    if (on !== this.cRibbon) {
      this.cRibbon = on;
      this.ribbon.classList.toggle('on', on);
      if (on) this.hudRoot.dataset.dmRibbon = '1';
      else delete this.hudRoot.dataset.dmRibbon;
      if (on) this.ribbonTitle.textContent = 'MATCH LIVE';
    }
    if (!on) return;
    const bodies = Math.max(1, this.view.bodies);
    const bots = Math.max(0, bodies - Math.max(1, this.view.humans));
    const sub = bots > 0
      ? `No lobby, no queue — ${bodies} already fighting. ${bots} of them are bots, `
        + 'and they hand their slots to humans as they arrive.'
      : `No lobby, no queue — ${bodies} in the arena.`;
    if (sub !== this.cRibbonSub) {
      this.ribbonSub.textContent = sub;
      this.cRibbonSub = sub;
    }
  }

  /** The ribbon has said its piece the moment something real happens. */
  private dismissRibbon(): void {
    if (this.ribbonUntilMs === 0 && !this.cRibbon) return;
    this.ribbonUntilMs = 0;
    this.showRibbon(false);
  }

  /* ---------------------------------------------------------------- *
   * Construction
   * ---------------------------------------------------------------- */

  private installStyle(): void {
    if (document.getElementById(STYLE_ID) !== null) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
    this.ctx.scope.addElement(el);
  }

  private buildDom(): void {
    const root = this.hudRoot;

    /* ---- match rail ---- */
    this.rail = new MatchRail(RAIL_CELLS);
    root.appendChild(this.rail.root);
    this.ctx.scope.addElement(this.rail.root);

    /* ---- ribbon ---- */
    this.ribbon = div('dm-ribbon');
    this.ribbonTitle = div('t', this.ribbon);
    this.ribbonSub = div('s', this.ribbon);
    root.appendChild(this.ribbon);
    this.ctx.scope.addElement(this.ribbon);

    /* ---- death card ---- */
    this.death = div('dm-death');
    const dt = div('t', this.death);
    dt.textContent = 'YOU DIED';
    this.deathBy = div('by', this.death);
    const track = div('track', this.death);
    const dfill = document.createElement('u');
    track.appendChild(dfill);
    this.deathFill = dfill;
    this.deathCta = div('cta', this.death);
    root.appendChild(this.death);
    this.ctx.scope.addElement(this.death);

    /* ---- spawn shield ---- */
    this.shield = div('dm-shield');
    const shieldLabel = document.createElement('span');
    shieldLabel.textContent = 'SPAWN PROTECTED';
    this.shield.appendChild(shieldLabel);
    root.appendChild(this.shield);
    this.ctx.scope.addElement(this.shield);

    /* ---- toasts ---- */
    this.toastRoot = div('dm-toasts');
    for (let i = 0; i < DM_TOAST_SLOTS; i++) {
      const t = div('toast', this.toastRoot);
      t.style.setProperty('--life', `${DM_TOAST_MS}ms`);
      this.toasts.push(t);
    }
    root.appendChild(this.toastRoot);
    this.ctx.scope.addElement(this.toastRoot);
  }
}

/* ------------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------------ */

/**
 * Register with `registry.register(ModeId.DEATHMATCH, createDeathmatchMode)`.
 * Construction is synchronous and cheap on purpose: the mode must never be the
 * reason a click takes a frame longer than it has to.
 */
export function createDeathmatchMode(ctx: ModeContext): ModeInstance {
  return new DeathmatchMode(ctx);
}

export default createDeathmatchMode;

/* ------------------------------------------------------------------------ *
 * Pure helpers, exported for the harness and for tests
 * ------------------------------------------------------------------------ */

/** Health/armour caps, re-exported so a HUD can size a bar without importing constants. */
export const DM_MAX_HEALTH = MAX_HEALTH;
export const DM_MAX_ARMOR = MAX_ARMOR;

/** True when a state record says the round is over and the board should show. */
export function isIntermission(state: ModeStateBuffer): boolean {
  return state.phase === ModePhase.INTERMISSION;
}

/** Death-card progress 0..1 given how long ago you died. */
export function respawnProgress(deadForMs: number): number {
  if (deadForMs <= 0) return 0;
  return deadForMs >= RESPAWN_DELAY_MS ? 1 : deadForMs / RESPAWN_DELAY_MS;
}

/** `PS_DEAD` re-exported so the scoreboard adapter has one source for the bit. */
export const DM_PS_DEAD = PS_DEAD;
