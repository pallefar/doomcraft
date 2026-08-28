/**
 * DOOMCRAFT — Quest: the intermission.
 *
 * DOOM's between-levels screen is a real piece of design, not a summary. It
 * grades you on three axes you could not have optimised for simultaneously —
 * kills, items, secrets — against a clock with a par time, and it *counts each
 * row up* so the number arriving at 100% is an event rather than a fact. The
 * count is skippable, and a skip snaps the current row and moves on rather than
 * dumping the whole screen, so mashing the key still feels like progress.
 *
 * All four of those behaviours are reproduced here:
 *
 *   - one row at a time, counting from zero at a fixed rate with a tick,
 *   - a short beat between rows,
 *   - a key press snaps the row in flight and advances,
 *   - time versus par, with the delta called out.
 *
 * COST. The counter is driven from the mode's existing `update(dt)` — no timers,
 * no `requestAnimationFrame` of its own — and each row writes DOM only when its
 * integer percentage actually changes.
 */

import { formatTime, percentOf, type IntermissionStats } from '@shared/modes';

import { createMatchShareButton, type MatchShareButton } from '@/ui/shareCard';

/* ------------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------------ */

const STYLE_ID = 'dc-quest-inter-css';
let styleRefs = 0;

const CSS = `
.dcqi{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(120% 90% at 50% 40%,rgba(28,10,6,.86),rgba(6,5,8,.97));
  pointer-events:auto;-webkit-user-select:none;user-select:none;
  font:14px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e8e6e3;
  padding:16px;overflow-y:auto}
.dcqi-panel{width:min(560px,94vw);text-align:center}
.dcqi-ep{font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:#8f7a62}
.dcqi-name{margin-top:6px;font:800 clamp(24px,4.6vw,42px)/1 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.02em;color:#f0e2c8;text-shadow:0 3px 0 #40120a,0 8px 28px rgba(0,0,0,.8)}
.dcqi-fin{margin-top:8px;font:800 15px/1 "Arial Black",Impact,system-ui,sans-serif;
  letter-spacing:.34em;color:#e03c1c}

.dcqi-rows{margin:24px auto 0;width:min(420px,100%);display:flex;flex-direction:column;gap:11px}
.dcqi-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;
  opacity:.18;transition:opacity .12s linear}
.dcqi-row.live,.dcqi-row.done{opacity:1}
.dcqi-row .k{font:800 15px/1 "Arial Black",Impact,system-ui,sans-serif;letter-spacing:.2em;
  text-transform:uppercase;color:#c9beb6}
.dcqi-row .v{font:800 26px/1 "Arial Black",Impact,system-ui,sans-serif;
  font-variant-numeric:tabular-nums;color:#e03c1c;text-shadow:0 2px 0 #40120a;min-width:4ch;
  text-align:right}
.dcqi-row.live .v{animation:dcqi-tick .09s steps(2,end) infinite}
.dcqi-row.perfect .v{color:#ffd76a;text-shadow:0 2px 0 #5a3200,0 0 20px rgba(255,190,70,.45)}
@keyframes dcqi-tick{50%{filter:brightness(1.7)}}

.dcqi-time{margin-top:22px;display:flex;justify-content:center;gap:28px;flex-wrap:wrap}
.dcqi-time div{text-align:center}
.dcqi-time .k{font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:#8f8a85}
.dcqi-time .v{margin-top:3px;font:800 22px/1 "Arial Black",Impact,system-ui,sans-serif;
  font-variant-numeric:tabular-nums;color:#e8e6e3}
.dcqi-time .v.under{color:#7ef0a8}
.dcqi-time .v.over{color:#e07a4a}

.dcqi-note{margin-top:14px;font-size:12px;color:#b4aea8;min-height:18px}
.dcqi-note b{color:#ffd76a;font-weight:700}

.dcqi-actions{margin-top:26px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.dcqi-btn{appearance:none;border:1px solid rgba(255,255,255,.18);border-radius:3px;
  background:rgba(255,255,255,.05);color:#e8e6e3;padding:11px 20px;min-height:44px;
  font:800 12px/1 "Arial Black",Impact,system-ui,sans-serif;letter-spacing:.16em;
  text-transform:uppercase;cursor:pointer}
.dcqi-btn:hover{background:rgba(255,255,255,.1)}
.dcqi-btn:focus-visible{outline:2px solid #f0a020;outline-offset:2px}
.dcqi-btn.go{background:#8f1a08;border-color:#e03c1c;color:#ffe6d8}
.dcqi-btn.go:hover{background:#b02510}
.dcqi-hint{margin-top:12px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;
  color:#736c66}
.dcqi-sponsor{margin-top:22px}
.dcqi-sponsor:empty{margin:0}
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

export interface QuestIntermissionOptions {
  /** `#ui`. */
  root: HTMLElement;
  stats: IntermissionStats;
  episodeName: string;
  /** Display name of the level the exit points at. '' ends the episode. */
  nextLevelName: string;
  /** True when this exit ends the episode. */
  endsEpisode: boolean;
  /**
   * Show the two reward rows. Both gates already ANDed by the caller
   * (`economySurfacesOn`); this panel does not re-decide policy.
   */
  economy?: boolean;
  /**
   * What the SERVER granted, straight off `S2C.MATCH_AWARD`. The panel counts
   * these up; it never computes them. An offline run has no server and
   * therefore no rows.
   */
  xp?: number;
  scrap?: number;
  onAdvance(): void;
  onRestart(): void;
  onQuit(): void;
  /**
   * S12 (docs/SPONSORS.md §1b): the shell's sponsor-card hook, handed a mount
   * this panel owns. The returned disposer runs in `destroy()`. Absent (an
   * offline run, a test) the panel is exactly what it was before S12 existed.
   */
  sponsorCard?(mount: HTMLElement): () => void;
}

/** Percentage points per second while a percentage row counts. */
const COUNT_RATE = 92;
/** How long any row takes to count all the way up, seconds. */
const COUNT_SECONDS = 100 / COUNT_RATE;
/** Beat between rows, seconds. */
const ROW_PAUSE = 0.3;

/** The first row. Every other index is now derived from `intermissionRows()`. */
const ROW_FIRST = 0;

/**
 * One counted row, decided before any DOM exists.
 *
 * Pulled out of the constructor so the *contents* of this screen can be tested
 * in a runner with no DOM at all — which is what this repo has. The class
 * builds whatever this returns and knows nothing else about what a row means.
 */
export interface IntermissionRow {
  label: string;
  /** The value the count walks to. */
  target: number;
  /** Rendered as `${prefix}${value}${suffix}`. */
  prefix: string;
  suffix: string;
  /** Units per second. Every row takes the same ~1.1 s whatever its scale. */
  rate: number;
  /** At or above this the row is styled `perfect`. Infinity = never. */
  perfectAt: number;
}

/**
 * The rows this screen will count, in order.
 *
 * The three DOOM percentages always; the two reward rows only when the caller
 * says both gates are open. A zero reward row is still SHOWN when the economy
 * is on — "+0 XP" after a full level is a fact the player is owed (they hit the
 * day cap, or the room was private), and hiding it would make a real refusal
 * look like a missing feature.
 */
export function intermissionRows(
  stats: IntermissionStats, economy = false, xp = 0, scrap = 0,
): IntermissionRow[] {
  const pct = (label: string, target: number): IntermissionRow => ({
    label, target, prefix: '', suffix: '%', rate: COUNT_RATE, perfectAt: 100,
  });
  const rows: IntermissionRow[] = [
    pct('Kills', percentOf(stats.kills, stats.killsTotal)),
    pct('Items', percentOf(stats.items, stats.itemsTotal)),
    pct('Secrets', percentOf(stats.secrets, stats.secretsTotal)),
  ];
  if (!economy) return rows;
  const earned = (label: string, target: number): IntermissionRow => ({
    label,
    target: Math.max(0, Math.round(target)),
    prefix: '+',
    suffix: '',
    // Same wall-clock as a percentage row, so a 900 XP level does not sit there
    // ticking for ten seconds.
    rate: Math.max(COUNT_RATE, Math.max(0, Math.round(target)) / COUNT_SECONDS),
    perfectAt: Infinity,
  });
  rows.push(earned('XP', xp), earned('Scrap', scrap));
  return rows;
}

/* ------------------------------------------------------------------------ *
 * QuestIntermission
 * ------------------------------------------------------------------------ */

export class QuestIntermission {
  readonly element: HTMLElement;

  private readonly stats: IntermissionStats;
  private readonly rows: readonly IntermissionRow[];
  /** Index of the "reveal the clock" phase. One past the last counted row. */
  private readonly rowTime: number;
  /** Index of the finished phase. `rowTime + 1`. */
  private readonly rowDone: number;
  private readonly rowEls: HTMLElement[] = [];
  private readonly valueEls: HTMLElement[] = [];
  private readonly elTime: HTMLElement;
  private readonly elPar: HTMLElement;
  private readonly elNote: HTMLElement;
  private readonly elTimeBlock: HTMLElement;
  private readonly btnGo: HTMLButtonElement;

  private readonly onAdvance: () => void;

  private phase = ROW_FIRST;
  private value = 0;
  private pause = 0.45;
  private readonly shown: number[] = [];
  private disposed = false;
  private disposeSponsor: (() => void) | null = null;
  private shareBtn: MatchShareButton | null = null;

  private readonly onKey: (e: KeyboardEvent) => void;

  constructor(opts: QuestIntermissionOptions) {
    ensureStyle();
    const s = opts.stats;
    this.stats = s;
    this.onAdvance = opts.onAdvance;
    this.rows = intermissionRows(s, opts.economy === true, opts.xp ?? 0, opts.scrap ?? 0);
    this.rowTime = this.rows.length;
    this.rowDone = this.rowTime + 1;

    const wrap = div('dcqi');
    const panel = div('dcqi-panel');

    const ep = div('dcqi-ep');
    ep.textContent = opts.episodeName;
    const name = div('dcqi-name');
    name.textContent = s.levelName || s.levelId;
    const fin = div('dcqi-fin');
    fin.textContent = 'FINISHED';
    panel.append(ep, name, fin);

    const rows = div('dcqi-rows');
    for (const r of this.rows) this.buildRow(rows, r);
    panel.appendChild(rows);

    const time = div('dcqi-time');
    this.elTimeBlock = time;
    this.elTime = timeCell(time, 'Time', '--:--');
    this.elPar = timeCell(time, 'Par', formatTime(s.parSec));
    time.style.opacity = '0.18';
    panel.appendChild(time);

    this.elNote = div('dcqi-note');
    panel.appendChild(this.elNote);

    const actions = div('dcqi-actions');
    this.btnGo = button(
      opts.endsEpisode ? 'Episode complete' : `Next: ${opts.nextLevelName || 'continue'}`,
      'dcqi-btn go',
    );
    this.btnGo.addEventListener('click', () => { this.advance(); });
    const restart = button('Replay level', 'dcqi-btn');
    restart.addEventListener('click', () => { if (!this.disposed) opts.onRestart(); });
    const quit = button('Main menu', 'dcqi-btn');
    quit.addEventListener('click', () => { if (!this.disposed) opts.onQuit(); });
    actions.append(this.btnGo, restart, quit);
    /* The share card (S36): self-gating on the server's share_cards flag via
     * the page's one flags probe — quest runs in the local Worker, whose
     * session bits can never carry it. Null when this build has no server. */
    this.shareBtn = createMatchShareButton('dcqi-btn');
    if (this.shareBtn !== null) actions.appendChild(this.shareBtn.element);
    panel.appendChild(actions);

    const hint = div('dcqi-hint');
    hint.textContent = 'Enter or Space to continue';
    panel.appendChild(hint);

    // S12: the results card, below the actions where it can never sit between
    // the player and the Next button. The mount is built either way; empty it
    // costs zero pixels, and the shell decides whether anything fills it.
    const sponsorMount = div('dcqi-sponsor');
    panel.appendChild(sponsorMount);
    this.disposeSponsor = opts.sponsorCard?.(sponsorMount) ?? null;

    wrap.appendChild(panel);
    this.element = wrap;
    opts.root.appendChild(wrap);

    this.onKey = (e: KeyboardEvent): void => {
      if (this.disposed) return;
      if (e.code !== 'Enter' && e.code !== 'NumpadEnter' && e.code !== 'Space') return;
      e.preventDefault();
      this.advance();
    };
    window.addEventListener('keydown', this.onKey);

    // The button takes focus so a keyboard-only player is never stranded, but
    // the count still runs — focus does not imply the screen is finished.
    this.btnGo.focus({ preventScroll: true });
    this.setRowState();
  }

  private buildRow(host: HTMLElement, spec: IntermissionRow): void {
    const row = div('dcqi-row');
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = spec.label;
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = `${spec.prefix}0${spec.suffix}`;
    row.append(k, v);
    host.appendChild(row);
    this.rowEls.push(row);
    this.valueEls.push(v);
    this.shown.push(-1);
  }

  /* -------------------------------------------------------------------- *
   * Count-up
   * -------------------------------------------------------------------- */

  /** Drive from the mode's frame loop. Cheap and idempotent once finished. */
  update(dt: number): void {
    if (this.disposed || this.phase >= this.rowDone) return;

    if (this.pause > 0) {
      this.pause -= dt;
      return;
    }

    if (this.phase === this.rowTime) {
      this.revealTime();
      return;
    }

    const spec = this.rows[this.phase];
    this.value += spec.rate * dt;
    if (this.value >= spec.target) {
      this.value = spec.target;
      this.writeRow(this.phase, spec.target);
      this.finishRow(this.phase);
      return;
    }
    this.writeRow(this.phase, Math.floor(this.value));
  }

  private writeRow(row: number, value: number): void {
    if (this.shown[row] === value) return;
    this.shown[row] = value;
    const spec = this.rows[row];
    this.valueEls[row].textContent = `${spec.prefix}${value}${spec.suffix}`;
  }

  private finishRow(row: number): void {
    this.rowEls[row].classList.remove('live');
    this.rowEls[row].classList.add('done');
    if (this.rows[row].target >= this.rows[row].perfectAt) {
      this.rowEls[row].classList.add('perfect');
    }
    this.phase = row + 1;
    this.value = 0;
    this.pause = ROW_PAUSE;
    this.setRowState();
  }

  private setRowState(): void {
    for (let i = 0; i < this.rowEls.length; i++) {
      this.rowEls[i].classList.toggle('live', i === this.phase);
    }
  }

  private revealTime(): void {
    const s = this.stats;
    this.elTimeBlock.style.opacity = '1';
    this.elTime.textContent = formatTime(s.timeSec);
    if (s.parSec > 0) {
      const under = s.timeSec <= s.parSec;
      this.elTime.classList.toggle('under', under);
      this.elTime.classList.toggle('over', !under);
    }
    this.elNote.innerHTML = this.noteHtml();
    this.phase = this.rowDone;
    this.setRowState();
  }

  private noteHtml(): string {
    const s = this.stats;
    const bits: string[] = [];
    if (s.parSec > 0) {
      const delta = s.parSec - s.timeSec;
      bits.push(delta >= 0
        ? `<b>${formatTime(Math.abs(delta))}</b> under par`
        : `${formatTime(Math.abs(delta))} over par`);
    }
    if (s.secretsTotal > 0 && s.secrets >= s.secretsTotal) bits.push('every secret found');
    if (s.killsTotal > 0 && s.kills >= s.killsTotal) bits.push('100% kills');
    if (s.newRecord) bits.push('<b>NEW RECORD</b>');
    return bits.join(' &nbsp;·&nbsp; ');
  }

  /**
   * Enter, Space or the button. A count in flight is snapped and the screen
   * moves on one row; a finished screen loads the next level.
   */
  advance(): void {
    if (this.disposed) return;
    if (this.phase < this.rowDone) {
      this.skipAll();
      return;
    }
    this.onAdvance();
  }

  /** Snap every row to its final value. */
  skipAll(): void {
    if (this.disposed) return;
    for (let row = 0; row < this.rowTime; row++) {
      if (this.phase > row) continue;
      this.writeRow(row, this.rows[row].target);
      this.rowEls[row].classList.remove('live');
      this.rowEls[row].classList.add('done');
      if (this.rows[row].target >= this.rows[row].perfectAt) {
        this.rowEls[row].classList.add('perfect');
      }
    }
    this.phase = this.rowTime;
    this.pause = 0;
    this.value = 0;
    this.revealTime();
  }

  get finished(): boolean { return this.phase >= this.rowDone; }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.disposeSponsor?.(); } catch { /* a card must never break teardown */ }
    this.disposeSponsor = null;
    try { this.shareBtn?.dispose(); } catch { /* same rule */ }
    this.shareBtn = null;
    window.removeEventListener('keydown', this.onKey);
    this.element.remove();
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

function button(label: string, cls: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  return b;
}

function timeCell(host: HTMLElement, label: string, initial: string): HTMLElement {
  const wrap = div('');
  const k = div('k');
  k.textContent = label;
  const v = div('v');
  v.textContent = initial;
  wrap.append(k, v);
  host.appendChild(wrap);
  return v;
}
