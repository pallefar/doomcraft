/**
 * DOOMCRAFT — Deathmatch scoreboard.
 *
 * The bar does not really have one. In `ref/voxiom/desktop-08-combat.png` Tab
 * is bound to "Press `Tab` for full map", and the only standings anywhere on
 * screen are two unlabelled pill chips — a person icon reading "2" and a skull
 * reading "0". You cannot find out who is winning without leaving the match.
 *
 * So the brief for this file is legibility at a glance, and "at a glance" is
 * defined as: **half a second, one eye movement, no arithmetic.** Concretely,
 * every one of these is a decision against a generic arena board:
 *
 *   - **Rank is a column, not an inference.** 1/2/3 are tinted gold, silver,
 *     bronze so the podium reads as shape before it reads as text.
 *   - **You are unmissable.** Your row gets a solid accent bar, a lifted
 *     background and brighter type. You never scan for yourself.
 *   - **The frag limit is a bar, not a subtraction.** The header shows the
 *     leader's progress toward the limit as a filled track, so "is this nearly
 *     over" is answered by a shape.
 *   - **Ping is four bars, not three digits.** A number needs reading and a
 *     scale to compare against; bars are pre-compared.
 *   - **Numbers are tabular.** Columns line up digit-for-digit, which is what
 *     makes a column of scores scannable rather than readable.
 *   - **State is a pill, not a colour alone.** DEAD and BOT are labelled, so
 *     the board still works for a colour-blind player and on a washed-out
 *     phone screen in daylight.
 *
 * Performance: `update()` writes a cell only when its value actually changed,
 * and the row nodes are built once and reused. Holding Tab through a whole
 * match costs a handful of string compares per frame and no allocation.
 */

/* ------------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------------ */

/** One player's standings. Mirrors `DmScoreRow` on the server. */
export interface ScoreRow {
  id: number;
  name: string;
  bot: boolean;
  kills: number;
  deaths: number;
  /** Frags the round is decided on. Usually equals `kills`. */
  score: number;
  streak: number;
  ping: number;
  dead: boolean;
  /** Identity colour index 0..7. */
  colour: number;
  local: boolean;
}

/** Everything above the table. */
export interface ScoreboardHeader {
  /** "DEATHMATCH", "DEATHMATCH · WARMUP". */
  title: string;
  /** Seconds left on the round clock; negative or 0 hides the clock. */
  timeLeftSec: number;
  /** Leading frag count and the limit. `limit` 0 hides the progress track. */
  leaderScore: number;
  scoreLimit: number;
  /** Humans / bodies, for the "2 of 6 human" line. */
  humans: number;
  bodies: number;
  /** A short status line, e.g. "Bots hand their slots to humans as they join". */
  note: string;
}

export function createScoreboardHeader(): ScoreboardHeader {
  return {
    title: 'DEATHMATCH', timeLeftSec: 0, leaderScore: 0, scoreLimit: 0,
    humans: 0, bodies: 0, note: '',
  };
}

/** Eight identity colours, packed 0xRRGGBB. Distinguishable at 8 px. */
export const SCORE_COLOURS: readonly string[] = Object.freeze([
  '#e03c1c', '#f0a020', '#4fb84a', '#50a8f0',
  '#b45cf0', '#f05c9a', '#3ad6c0', '#c8c04a',
]);

export function scoreColour(index: number): string {
  return SCORE_COLOURS[((index | 0) % SCORE_COLOURS.length + SCORE_COLOURS.length) % SCORE_COLOURS.length];
}

/** `M:SS`, clamped at zero. */
export function clockText(seconds: number): string {
  const s = seconds < 0 ? 0 : Math.floor(seconds);
  const m = (s / 60) | 0;
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/** Kill/death ratio, shown to one decimal. A clean sheet reports the kills. */
export function kdText(kills: number, deaths: number): string {
  if (deaths <= 0) return kills === 0 ? '—' : kills.toFixed(1);
  return (kills / deaths).toFixed(1);
}

/**
 * Bars 0..4 for a round-trip time, or -1 when there is no measurement to show.
 * A bot has no connection, so it gets four grey bars and a dash rather than
 * four green ones — an unknown must never read as a perfect score.
 */
export function pingBars(ms: number): number {
  if (!(ms > 0)) return -1;
  if (ms < 45) return 4;
  if (ms < 90) return 3;
  if (ms < 160) return 2;
  if (ms < 260) return 1;
  return 0;
}

/** The text next to the bars. */
export function pingText(ms: number): string {
  return ms > 0 ? `${Math.round(ms)}ms` : '—';
}

/* ------------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------------ */

const STYLE_ID = 'dm-scoreboard-css';

const CSS = `
#hud .dm-sb{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:min(660px,92vw);max-height:86vh;display:none;flex-direction:column;
  background:rgba(9,9,12,.95);border:1px solid var(--dc-line);border-radius:var(--dc-r);
  box-shadow:0 28px 70px rgba(0,0,0,.72),0 0 0 1px rgba(0,0,0,.5);
  font:13px/1.25 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e8e6e3;
  pointer-events:none;contain:layout style}
#hud .dm-sb.open{display:flex}

#hud .dm-sb .hd{padding:13px 16px 11px;border-bottom:1px solid rgba(255,255,255,.10);
  background:linear-gradient(180deg,rgba(40,14,6,.55),rgba(9,9,12,0))}
#hud .dm-sb .hd .t{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
#hud .dm-sb .hd h3{margin:0;font:900 16px/1 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.18em;text-transform:uppercase;color:#f0a020}
#hud .dm-sb .hd .clock{font:800 26px/1 "Arial Black",Impact,system-ui,sans-serif;
  font-variant-numeric:tabular-nums;color:#f2efec;text-shadow:0 2px 0 #4a1005}
#hud .dm-sb .hd .clock.low{color:#ff6a48;animation:dmsbtick 1s steps(2,end) infinite}
@keyframes dmsbtick{50%{opacity:.45}}
#hud .dm-sb .hd .sub{display:flex;align-items:center;justify-content:space-between;gap:10px;
  margin-top:7px;font-size:11px;letter-spacing:.08em;color:#8a8078;text-transform:uppercase}
#hud .dm-sb .hd .sub b{color:#cfc9c3;font-weight:700}
#hud .dm-sb .track{position:relative;height:5px;margin-top:8px;border-radius:3px;
  background:rgba(255,255,255,.09);overflow:hidden}
#hud .dm-sb .track i{position:absolute;inset:0;transform-origin:left center;transform:scaleX(0);
  background:linear-gradient(90deg,#8f1a08,#e03c1c 60%,#f0a020);
  transition:transform .2s linear}

#hud .dm-sb .tbl{overflow-y:auto;min-height:0;flex:1;scrollbar-width:thin;
  scrollbar-color:rgba(255,255,255,.22) transparent}
#hud .dm-sb table{width:100%;border-collapse:collapse}
#hud .dm-sb thead th{position:sticky;top:0;z-index:1;background:rgba(9,9,12,.98);
  text-align:right;font-size:10px;letter-spacing:.17em;text-transform:uppercase;
  color:#6f6a66;font-weight:700;padding:8px 10px 7px;border-bottom:1px solid rgba(255,255,255,.09)}
#hud .dm-sb thead th.l{text-align:left}
#hud .dm-sb tbody td{padding:0 10px;height:28px;font-variant-numeric:tabular-nums;
  text-align:right;color:#cfc9c3;border-bottom:1px solid rgba(255,255,255,.045)}
#hud .dm-sb tbody tr:nth-child(even) td{background:rgba(255,255,255,.022)}
#hud .dm-sb tbody td.l{text-align:left}

#hud .dm-sb td.rank{width:34px;color:#7d7873;font-weight:700;position:relative;padding-left:14px}
#hud .dm-sb tr.r1 td.rank{color:#ffd05a}
#hud .dm-sb tr.r2 td.rank{color:#cfd4da}
#hud .dm-sb tr.r3 td.rank{color:#d99a5e}
#hud .dm-sb td.rank::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;
  background:transparent}
#hud .dm-sb tr.me td.rank::before{background:#f0a020}
#hud .dm-sb tr.me td{background:rgba(52,32,8,.62);color:#f6e3c8;font-weight:700}
#hud .dm-sb tr.me td.name{color:#ffe3a8}
#hud .dm-sb tr.dead td{opacity:.52}
#hud .dm-sb tr.dead td.name::after{content:"DEAD";margin-left:7px;font-size:9px;letter-spacing:.1em;
  color:#0a0a0d;background:#8a3a2a;border-radius:2px;padding:1px 4px;vertical-align:1px}

#hud .dm-sb td.name{width:44%;overflow:hidden;white-space:nowrap}
#hud .dm-sb td.name .swatch{display:inline-block;width:9px;height:9px;border-radius:2px;
  margin-right:8px;vertical-align:-1px;box-shadow:0 0 0 1px rgba(0,0,0,.65)}
#hud .dm-sb td.name .who{display:inline-block;max-width:calc(100% - 74px);overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
#hud .dm-sb td.name .bot{margin-left:7px;font-size:9px;letter-spacing:.1em;color:#9b9793;
  border:1px solid rgba(255,255,255,.22);border-radius:2px;padding:0 3px;vertical-align:1px}

#hud .dm-sb td.score{font-weight:800;color:#f2efec;width:56px}
#hud .dm-sb tr.r1 td.score{color:#ffd05a}
#hud .dm-sb td.k,#hud .dm-sb td.d,#hud .dm-sb td.kd{width:48px}
#hud .dm-sb td.d{color:#9b9793}
#hud .dm-sb td.streak{width:52px;color:#8a8078}
#hud .dm-sb td.streak.hot{color:#f0a020;font-weight:700}

#hud .dm-sb td.ping{width:74px;white-space:nowrap}
#hud .dm-sb td.ping .bars{display:inline-flex;align-items:flex-end;gap:1px;height:10px;
  margin-right:6px;vertical-align:-1px}
#hud .dm-sb td.ping .bars i{width:3px;background:rgba(255,255,255,.18);border-radius:1px}
#hud .dm-sb td.ping .bars i:nth-child(1){height:3px}
#hud .dm-sb td.ping .bars i:nth-child(2){height:5px}
#hud .dm-sb td.ping .bars i:nth-child(3){height:7.5px}
#hud .dm-sb td.ping .bars i:nth-child(4){height:10px}
#hud .dm-sb td.ping[data-b="4"] .bars i{background:#4fb84a}
#hud .dm-sb td.ping[data-b="3"] .bars i:nth-child(-n+3){background:#8fc63d}
#hud .dm-sb td.ping[data-b="2"] .bars i:nth-child(-n+2){background:#f0a020}
#hud .dm-sb td.ping[data-b="1"] .bars i:nth-child(1){background:#e03c1c}
#hud .dm-sb td.ping .ms{font-size:11px;color:#8a8078}

#hud .dm-sb .sponsor{padding:8px 16px 2px}
#hud .dm-sb .sponsor:empty{display:none;padding:0}
#hud .dm-sb .ft{display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:8px 16px 10px;border-top:1px solid rgba(255,255,255,.09);
  font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#6f6a66}
#hud .dm-sb .ft b{color:#9b9793;font-weight:700}
#hud .dm-sb .more{padding:6px 16px;font-size:11px;color:#7d7873;letter-spacing:.06em}

/* ---- compact: drop the columns you can live without, keep the ranking ---- */
#hud[data-compact="1"] .dm-sb{width:min(96vw,560px);font-size:12px;max-height:92vh}
#hud[data-compact="1"] .dm-sb .hd{padding:9px 12px 8px}
#hud[data-compact="1"] .dm-sb .hd h3{font-size:13px}
#hud[data-compact="1"] .dm-sb .hd .clock{font-size:20px}
#hud[data-compact="1"] .dm-sb tbody td{height:24px;padding:0 7px}
#hud[data-compact="1"] .dm-sb td.kd,#hud[data-compact="1"] .dm-sb th.kd,
#hud[data-compact="1"] .dm-sb td.streak,#hud[data-compact="1"] .dm-sb th.streak{display:none}
#hud[data-compact="1"] .dm-sb td.ping .ms{display:none}
#hud[data-compact="1"] .dm-sb td.ping{width:34px}
#hud[data-compact="1"] .dm-sb td.name{width:40%}
#hud[data-compact="1"] .dm-sb td.name .who{max-width:calc(100% - 44px)}
#hud[data-compact="1"] .dm-sb td.name .bot{display:none}
#hud[data-compact="1"] .dm-sb tr.dead td.name::after{margin-left:5px}
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
 * Scoreboard
 * ------------------------------------------------------------------------ */

export interface ScoreboardOptions {
  /** `#hud`. Never interactive — the board is a read-out, not a menu. */
  root: HTMLElement;
  /** Rows past this are folded into a "+N more" line. */
  maxRows?: number;
}

interface RowNodes {
  tr: HTMLTableRowElement;
  rank: HTMLTableCellElement;
  name: HTMLTableCellElement;
  swatch: HTMLElement;
  who: HTMLElement;
  botTag: HTMLElement;
  score: HTMLTableCellElement;
  k: HTMLTableCellElement;
  d: HTMLTableCellElement;
  kd: HTMLTableCellElement;
  streak: HTMLTableCellElement;
  ping: HTMLTableCellElement;
  ms: HTMLElement;
  /** Last values written, so an unchanged cell is not touched. */
  vRank: number;
  vName: string;
  vColour: number;
  vBot: boolean;
  vScore: number;
  vK: number;
  vD: number;
  vStreak: number;
  vBars: number;
  vPing: number;
  vClass: string;
}

export const DEFAULT_MAX_ROWS = 14;

export class Scoreboard {
  readonly element: HTMLElement;
  /**
   * S12 (docs/SPONSORS.md §1b): where the deathmatch intermission's sponsor
   * card mounts. Empty it costs zero pixels; the MODE decides when to fill it
   * (intermission only — a Tab-hold mid-round is live play, and live play
   * carries no sponsor surface). Inside `#hud`, so never interactive.
   */
  readonly sponsorMount: HTMLElement;

  private readonly body: HTMLTableSectionElement;
  private readonly rows: RowNodes[] = [];
  private readonly maxRows: number;

  private readonly titleEl: HTMLElement;
  private readonly clockEl: HTMLElement;
  private readonly subLeft: HTMLElement;
  private readonly subRight: HTMLElement;
  private readonly trackFill: HTMLElement;
  private readonly moreEl: HTMLElement;
  private readonly footLeft: HTMLElement;
  private readonly footRight: HTMLElement;

  private open = false;
  private destroyed = false;
  private lastTitle = '';
  private lastClock = '';
  private lastClockLow = false;
  private lastSubLeft = '';
  private lastSubRight = '';
  private lastFill = -1;
  private lastMore = '';
  private lastFootRight = '';
  private shown = 0;

  constructor(options: ScoreboardOptions) {
    retainStyle();
    this.maxRows = Math.max(1, options.maxRows ?? DEFAULT_MAX_ROWS);

    const el = document.createElement('div');
    el.className = 'dm-sb';
    el.setAttribute('role', 'table');
    el.setAttribute('aria-label', 'Scoreboard');

    /* ---- header ---- */
    const hd = document.createElement('div');
    hd.className = 'hd';
    const t = document.createElement('div');
    t.className = 't';
    this.titleEl = document.createElement('h3');
    this.titleEl.textContent = 'DEATHMATCH';
    this.clockEl = document.createElement('div');
    this.clockEl.className = 'clock';
    this.clockEl.textContent = '0:00';
    t.append(this.titleEl, this.clockEl);

    const sub = document.createElement('div');
    sub.className = 'sub';
    this.subLeft = document.createElement('span');
    this.subRight = document.createElement('span');
    sub.append(this.subLeft, this.subRight);

    const track = document.createElement('div');
    track.className = 'track';
    this.trackFill = document.createElement('i');
    track.appendChild(this.trackFill);

    hd.append(t, sub, track);

    /* ---- table ---- */
    const wrap = document.createElement('div');
    wrap.className = 'tbl';
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (const [cls, label] of [
      ['l rank', '#'], ['l name', 'Player'], ['score', 'Score'],
      ['k', 'K'], ['d', 'D'], ['kd', 'K/D'], ['streak', 'Streak'], ['ping', 'Ping'],
    ] as ReadonlyArray<readonly [string, string]>) {
      const th = document.createElement('th');
      th.className = cls;
      th.textContent = label;
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    this.body = document.createElement('tbody');
    table.append(thead, this.body);
    wrap.appendChild(table);

    this.moreEl = document.createElement('div');
    this.moreEl.className = 'more';
    this.moreEl.style.display = 'none';

    /* ---- footer ---- */
    const ft = document.createElement('div');
    ft.className = 'ft';
    this.footLeft = document.createElement('span');
    this.footLeft.innerHTML = 'Hold <b>Tab</b> for scores';
    this.footRight = document.createElement('span');
    ft.append(this.footLeft, this.footRight);

    this.sponsorMount = document.createElement('div');
    this.sponsorMount.className = 'sponsor';

    el.append(hd, wrap, this.moreEl, this.sponsorMount, ft);
    options.root.appendChild(el);
    this.element = el;

    for (let i = 0; i < this.maxRows; i++) this.rows.push(this.makeRow());
  }

  /* ---------------------------------------------------------------- *
   * Visibility
   * ---------------------------------------------------------------- */

  get isOpen(): boolean { return this.open; }

  setOpen(open: boolean): void {
    if (this.open === open || this.destroyed) return;
    this.open = open;
    this.element.classList.toggle('open', open);
  }

  /* ---------------------------------------------------------------- *
   * Content
   * ---------------------------------------------------------------- */

  /**
   * Write the board. Cheap enough to call every frame while Tab is held: each
   * cell is compared against what it already says and skipped when equal.
   */
  update(rows: readonly ScoreRow[], header: ScoreboardHeader): void {
    if (this.destroyed || !this.open) return;

    if (header.title !== this.lastTitle) {
      this.titleEl.textContent = header.title;
      this.lastTitle = header.title;
    }

    const showClock = header.timeLeftSec > 0;
    const clock = showClock ? clockText(header.timeLeftSec) : '--:--';
    if (clock !== this.lastClock) {
      this.clockEl.textContent = clock;
      this.lastClock = clock;
    }
    const low = showClock && header.timeLeftSec <= 30;
    if (low !== this.lastClockLow) {
      this.clockEl.classList.toggle('low', low);
      this.lastClockLow = low;
    }

    const left = header.scoreLimit > 0
      ? `Frag limit ${header.leaderScore} / ${header.scoreLimit}`
      : `Leader ${header.leaderScore}`;
    if (left !== this.lastSubLeft) { this.subLeft.textContent = left; this.lastSubLeft = left; }

    const right = `${header.humans} human${header.humans === 1 ? '' : 's'} · ${header.bodies} in match`;
    if (right !== this.lastSubRight) { this.subRight.textContent = right; this.lastSubRight = right; }

    const frac = header.scoreLimit > 0
      ? Math.max(0, Math.min(1, header.leaderScore / header.scoreLimit))
      : 0;
    const quantised = Math.round(frac * 100);
    if (quantised !== this.lastFill) {
      this.trackFill.style.transform = `scaleX(${(quantised / 100).toFixed(2)})`;
      this.lastFill = quantised;
    }

    const shown = Math.min(rows.length, this.maxRows);
    for (let i = 0; i < shown; i++) this.writeRow(this.rows[i], rows[i], i);
    for (let i = shown; i < this.shown; i++) this.rows[i].tr.style.display = 'none';
    this.shown = shown;

    const more = rows.length > this.maxRows ? `+ ${rows.length - this.maxRows} more in the match` : '';
    if (more !== this.lastMore) {
      this.moreEl.textContent = more;
      this.moreEl.style.display = more === '' ? 'none' : '';
      this.lastMore = more;
    }

    if (header.note !== this.lastFootRight) {
      this.footRight.textContent = header.note;
      this.lastFootRight = header.note;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.element.remove();
    this.rows.length = 0;
    releaseStyle();
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private makeRow(): RowNodes {
    const tr = document.createElement('tr');
    tr.style.display = 'none';

    const rank = document.createElement('td');
    rank.className = 'l rank';

    const name = document.createElement('td');
    name.className = 'l name';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    const who = document.createElement('span');
    who.className = 'who';
    const botTag = document.createElement('span');
    botTag.className = 'bot';
    botTag.textContent = 'BOT';
    botTag.style.display = 'none';
    name.append(swatch, who, botTag);

    const score = document.createElement('td');
    score.className = 'score';
    const k = document.createElement('td');
    k.className = 'k';
    const d = document.createElement('td');
    d.className = 'd';
    const kd = document.createElement('td');
    kd.className = 'kd';
    const streak = document.createElement('td');
    streak.className = 'streak';

    const ping = document.createElement('td');
    ping.className = 'ping';
    const bars = document.createElement('span');
    bars.className = 'bars';
    bars.innerHTML = '<i></i><i></i><i></i><i></i>';
    const ms = document.createElement('span');
    ms.className = 'ms';
    ping.append(bars, ms);

    tr.append(rank, name, score, k, d, kd, streak, ping);
    this.body.appendChild(tr);

    return {
      tr, rank, name, swatch, who, botTag, score, k, d, kd, streak, ping, ms,
      vRank: -1, vName: '', vColour: -1, vBot: false, vScore: -1,
      vK: -1, vD: -1, vStreak: -1, vBars: -1, vPing: -1, vClass: '',
    };
  }

  private writeRow(n: RowNodes, r: ScoreRow, index: number): void {
    if (n.tr.style.display !== '') n.tr.style.display = '';

    const rank = index + 1;
    if (rank !== n.vRank) {
      n.rank.textContent = String(rank);
      n.vRank = rank;
    }

    const cls = `r${rank <= 3 ? rank : 0}${r.local ? ' me' : ''}${r.dead ? ' dead' : ''}`;
    if (cls !== n.vClass) { n.tr.className = cls; n.vClass = cls; }

    if (r.name !== n.vName) {
      n.who.textContent = r.name === '' ? `#${r.id}` : r.name;
      n.vName = r.name;
    }
    if (r.colour !== n.vColour) {
      n.swatch.style.background = scoreColour(r.colour);
      n.vColour = r.colour;
    }
    if (r.bot !== n.vBot) {
      n.botTag.style.display = r.bot ? '' : 'none';
      n.vBot = r.bot;
    }

    if (r.score !== n.vScore) { n.score.textContent = String(r.score); n.vScore = r.score; }
    if (r.kills !== n.vK || r.deaths !== n.vD) {
      n.k.textContent = String(r.kills);
      n.d.textContent = String(r.deaths);
      n.kd.textContent = kdText(r.kills, r.deaths);
      n.vK = r.kills;
      n.vD = r.deaths;
    }
    if (r.streak !== n.vStreak) {
      n.streak.textContent = r.streak > 0 ? `${r.streak}×` : '—';
      n.streak.className = r.streak >= 5 ? 'streak hot' : 'streak';
      n.vStreak = r.streak;
    }

    const bars = pingBars(r.ping);
    if (bars !== n.vBars) { n.ping.dataset.b = String(bars); n.vBars = bars; }
    if (r.ping !== n.vPing) {
      n.ms.textContent = pingText(r.ping);
      n.vPing = r.ping;
    }
  }
}

/* ------------------------------------------------------------------------ *
 * Row assembly
 * ------------------------------------------------------------------------ */

/**
 * The shape the net client's roster hands back.
 *
 * `active` matters and is not optional: `NetClient.players` is a FIXED array of
 * MAX_PLAYERS slots, most of them empty in a small match. A board that renders
 * the array rather than the occupied slots prints a wall of blank, "dead",
 * zero-score rows and buries the eight people actually playing — which is the
 * opposite of the half-second read this board exists for.
 */
export interface ScoreSource {
  id: number;
  name: string;
  kills: number;
  deaths: number;
  state: number;
  health: number;
  /** False for an unoccupied roster slot. Those are never rows. */
  active: boolean;
}

/** `PS_BOT` from the protocol, mirrored so this file imports no protocol enum. */
export const PS_BOT_BIT = 1 << 7;
/** `PS_DEAD`. */
export const PS_DEAD_BIT = 1 << 3;

function blankRow(): ScoreRow {
  return {
    id: 0, name: '', bot: false, kills: 0, deaths: 0, score: 0,
    streak: 0, ping: 0, dead: false, colour: 0, local: false,
  };
}

/**
 * Frags first, then fewest deaths, then id. The id tiebreak is what stops a
 * board reshuffling under itself while you read it — two players on 4 frags
 * and 4 deaths must not swap places every frame.
 */
function compareRows(a: ScoreRow, b: ScoreRow): number {
  return (b.score - a.score) || (a.deaths - b.deaths) || (a.id - b.id);
}

/**
 * Turns the net client's live player views into sorted board rows without
 * allocating one. The row objects are pooled for the life of the buffer and
 * `view` holds references to them, so holding Tab through a match costs a
 * sort of N references and nothing on the heap.
 */
export class ScoreRowBuffer {
  /** Pool. Grows to the largest roster seen and is never shrunk. */
  private readonly pool: ScoreRow[] = [];
  /** Sorted references into the pool. This is what the board renders. */
  private readonly view: ScoreRow[] = [];
  /**
   * Live killstreaks, keyed by player id. The snapshot does not carry them, so
   * they are accumulated from the kill stream — which is exact, because every
   * kill packet carries the killer's streak after the kill and a death is the
   * only thing that resets one.
   */
  private readonly streaks = new Map<number, number>();

  get rows(): readonly ScoreRow[] { return this.view; }
  get count(): number { return this.view.length; }

  /**
   * Fold one `S2C.KILL` into the streak table. `killerStreak` is the server's
   * own count, so this never drifts; the victim's reset is the only thing
   * derived locally and it cannot be wrong.
   */
  noteKill(killerId: number, victimId: number, killerStreak: number): void {
    if (killerId !== 0 && killerId !== victimId) {
      this.streaks.set(killerId, killerStreak > 0 ? killerStreak : (this.streaks.get(killerId) ?? 0) + 1);
    }
    if (victimId !== 0) this.streaks.set(victimId, 0);
  }

  /** A new round wipes every streak. */
  resetStreaks(): void { this.streaks.clear(); }

  fill(source: readonly ScoreSource[], localId: number, pingMs: number): readonly ScoreRow[] {
    const n = source.length;
    while (this.pool.length < n) this.pool.push(blankRow());
    this.view.length = 0;
    // `k` is the pool cursor, deliberately not `i`: the source is a fixed
    // roster array with holes in it, and only the occupied slots become rows.
    let k = 0;
    for (let i = 0; i < n; i++) {
      const p = source[i];
      // An empty slot is not a player. A slot that is occupied but has not had
      // its name delivered yet is also not a row worth printing — it would show
      // as a blank line for one snapshot and then jump.
      if (!p.active || p.id === 0) continue;
      const r = this.pool[k++];
      r.id = p.id;
      r.name = p.name;
      r.bot = (p.state & PS_BOT_BIT) !== 0;
      r.kills = p.kills;
      r.deaths = p.deaths;
      r.score = p.kills;
      r.streak = this.streaks.get(p.id) ?? 0;
      r.ping = p.id === localId ? pingMs : 0;
      r.dead = (p.state & PS_DEAD_BIT) !== 0 || p.health <= 0;
      r.colour = p.id & 7;
      r.local = p.id === localId;
      this.view.push(r);
    }
    this.view.sort(compareRows);
    return this.view;
  }

  /** Row for a player id, after `fill`. Null when they are not on the board. */
  find(id: number): ScoreRow | null {
    for (let i = 0; i < this.view.length; i++) if (this.view[i].id === id) return this.view[i];
    return null;
  }
}
