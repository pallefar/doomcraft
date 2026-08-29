/**
 * DOOMCRAFT — the Competitions tab, decided here. No DOM in this file.
 *
 * Same split as `loadoutModel.ts`/`tradeModel.ts`. The rules that must not
 * soften in the rendering:
 *
 * - **Seasons auto-enrol on the first paying round** — a season NEVER shows
 *   an Enter button; only tournaments do, and only until entered.
 * - **`entered: true` with rank 0 and 0 points is a NORMAL state** (zero-point
 *   entrants are filtered from the ladder), rendered as "on the roster — play
 *   a match to get on the board", never as an error.
 * - **Standings highlight `you` by the boolean**, never by comparing ids —
 *   `who` is a redacted hash and matching on it is how a rename breaks you.
 * - **Points move on post-round sweeps, not in real time** — the refresh line
 *   says so instead of promising live numbers.
 * - Refusal sentences from the server render VERBATIM ("reach level 5 to
 *   enter" was written for the player, not for a translator).
 */

/* ------------------------------------------------------------------------ *
 * Wire shapes — server/src/competitions.ts views, restated for the client
 * ------------------------------------------------------------------------ */

export type CompetitionKind = 'season' | 'tournament';
export type CompetitionState = 'running' | 'finalised';

export interface WireCompetition {
  readonly id: string;
  readonly kind: CompetitionKind;
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly state: CompetitionState;
  readonly minLevel: number;
  readonly scrapByRank: readonly number[];
  readonly entrants: number;
  readonly entered: boolean;
  readonly yourRank: number;
  readonly yourPoints: number;
}

export interface WireStanding {
  readonly rank: number;
  readonly who: string;
  readonly name: string;
  readonly points: number;
  readonly wins: number;
  readonly you: boolean;
}

/* ------------------------------------------------------------------------ *
 * Inputs and rendered shapes
 * ------------------------------------------------------------------------ */

export interface CompetitionsInputs {
  readonly phase: 'loading' | 'offline' | 'ready';
  readonly competitions: readonly WireCompetition[];
  /** competitionId -> standings, for the ones the player expanded. */
  readonly standings: Readonly<Record<string, readonly WireStanding[]>>;
  /** The competition id currently expanded, or ''. */
  readonly open: string;
  readonly busy: boolean;
  /** The server's refusal sentence, verbatim. '' = none. */
  readonly error: string;
  readonly nowMs: number;
}

export interface CompetitionRow {
  readonly id: string;
  readonly name: string;
  readonly kindLabel: 'Season' | 'Tournament';
  /** 'ends in 12d' | 'ends in 3h' | 'finalised'. Never empty. */
  readonly clock: string;
  /** '1st place 500 Scrap · top 10 paid' style prize line. Never empty. */
  readonly prize: string;
  readonly entrants: number;
  /** 'rank #4 · 1,220 pts' | 'on the roster — play a match to get on the board' | ''. */
  readonly yours: string;
  /** Tournaments only, until entered. */
  readonly canEnter: boolean;
  /** 'entrants must be level 5' or ''. */
  readonly entryRule: string;
  readonly open: boolean;
  readonly finalised: boolean;
}

export interface StandingRow {
  readonly rank: string;
  readonly name: string;
  readonly points: string;
  readonly wins: string;
  readonly you: boolean;
}

export interface CompetitionsView {
  readonly line: string;
  readonly error: string;
  readonly rows: readonly CompetitionRow[];
  /** Rendered standings for the open row; null = not fetched yet. */
  readonly table: readonly StandingRow[] | null;
  /** Shown under the table when it is empty. */
  readonly emptyTable: string;
}

/* ------------------------------------------------------------------------ */

function safeInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function groupInt(v: unknown): string {
  const digits = Math.max(0, safeInt(v)).toString();
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return out;
}

export function clockText(endMs: number, state: CompetitionState, nowMs: number): string {
  if (state === 'finalised') return 'finalised';
  const left = safeInt(endMs) - nowMs;
  if (left <= 0) return 'closing';
  const d = Math.floor(left / 86_400_000);
  if (d >= 1) return `ends in ${d}d`;
  const h = Math.floor(left / 3_600_000);
  if (h >= 1) return `ends in ${h}h`;
  return `ends in ${Math.max(1, Math.floor(left / 60_000))}m`;
}

export function prizeText(scrapByRank: readonly number[]): string {
  const paid = scrapByRank.filter((s) => safeInt(s) > 0);
  if (paid.length === 0) return 'no Scrap prizes';
  const first = groupInt(paid[0]);
  return paid.length === 1
    ? `winner takes ${first} Scrap`
    : `1st place ${first} Scrap · top ${paid.length} paid`;
}

function yoursText(c: WireCompetition): string {
  if (!c.entered) return '';
  if (c.yourRank > 0) return `rank #${c.yourRank} · ${groupInt(c.yourPoints)} pts`;
  return 'on the roster — play a match to get on the board';
}

export function buildCompetitionsView(inputs: CompetitionsInputs): CompetitionsView {
  if (inputs.phase === 'loading') {
    return { line: 'Loading…', error: inputs.error, rows: [], table: null, emptyTable: '' };
  }
  if (inputs.phase === 'offline') {
    return {
      line: 'No server answered. Competitions live on the game server.',
      error: inputs.error, rows: [], table: null, emptyTable: '',
    };
  }

  const rows: CompetitionRow[] = inputs.competitions.map((c) => ({
    id: c.id,
    name: c.name,
    kindLabel: c.kind === 'season' ? 'Season' : 'Tournament',
    clock: clockText(c.endMs, c.state, inputs.nowMs),
    prize: prizeText(c.scrapByRank),
    entrants: Math.max(0, safeInt(c.entrants)),
    yours: yoursText(c),
    // Seasons auto-enrol; only a running tournament you have not joined asks.
    canEnter: c.kind === 'tournament' && c.state === 'running' && !c.entered && !inputs.busy,
    entryRule: c.kind === 'tournament' && c.minLevel > 0 ? `entrants must be level ${c.minLevel}` : '',
    open: inputs.open === c.id,
    finalised: c.state === 'finalised',
  }));

  const openRows = inputs.open !== '' && Object.prototype.hasOwnProperty.call(inputs.standings, inputs.open)
    ? inputs.standings[inputs.open] : null;
  const table: StandingRow[] | null = openRows === null ? null : openRows.map((s) => ({
    rank: `#${Math.max(1, safeInt(s.rank))}`,
    name: s.name.length > 0 ? s.name : 'Marine',
    points: groupInt(s.points),
    wins: groupInt(s.wins),
    you: s.you === true,
  }));

  return {
    line: rows.length === 0
      ? 'No competitions are running right now.'
      : 'Standings move after each match, not in real time. Season points come from XP earned while enrolled.',
    error: inputs.error,
    rows,
    table,
    emptyTable: 'Nobody on the board yet — the first paying match writes the first row.',
  };
}

/* ------------------------------------------------------------------------ *
 * Daily/weekly challenges (Studio S4) — the section rendered ABOVE the
 * competitions list, same tab, same flag. Decisions here, DOM in the tab.
 *
 * The honesty rules:
 * - `done` renders as done, never as a bar stuck at 100% — a finished
 *   challenge is a fact, not a progress state.
 * - The note says WHERE progress banks (online matches) and WHEN it resets
 *   (UTC midnight / Monday), because solo play silently banking nothing is
 *   the confusion the trust table guarantees.
 * - A null wire answer (older server, network) hides the section entirely —
 *   an empty board must never read as "you finished everything".
 * ------------------------------------------------------------------------ */

export interface WireChallenge {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly period: 'daily' | 'weekly';
  readonly target: number;
  readonly scrap: number;
  readonly item: string | null;
  readonly itemName: string;
  readonly progress: number;
  readonly done: boolean;
}

export interface ChallengeRowView {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly periodLabel: 'Daily' | 'Weekly';
  /** '3 / 5' while running, 'done' when paid. Never empty. */
  readonly progress: string;
  /** 0..1 for the bar width. done renders 1. */
  readonly frac: number;
  /** '40 Scrap' | '100 Scrap + Knee-Deep'. Never empty. */
  readonly reward: string;
  readonly done: boolean;
}

export interface ChallengesSectionView {
  /** '' = render nothing (no wire answer, or no defs shipped). */
  readonly heading: string;
  readonly rows: readonly ChallengeRowView[];
  /** The how-it-works teaching line. */
  readonly note: string;
}

export function buildChallengesSection(
  challenges: readonly WireChallenge[] | null,
): ChallengesSectionView {
  if (challenges === null || challenges.length === 0) {
    return { heading: '', rows: [], note: '' };
  }
  const rows: ChallengeRowView[] = challenges.map((c) => {
    const target = Math.max(1, safeInt(c.target));
    const progress = Math.max(0, Math.min(safeInt(c.progress), target));
    const scrap = Math.max(0, safeInt(c.scrap));
    const itemHalf = c.item === null ? ''
      : ` + ${typeof c.itemName === 'string' && c.itemName.length > 0 ? c.itemName : 'an item'}`;
    return {
      id: c.id,
      name: c.name.length > 0 ? c.name : c.id,
      blurb: c.blurb,
      periodLabel: c.period === 'weekly' ? 'Weekly' : 'Daily',
      progress: c.done ? 'done' : `${groupInt(progress)} / ${groupInt(target)}`,
      frac: c.done ? 1 : progress / target,
      reward: `${groupInt(scrap)} Scrap${itemHalf}`,
      done: c.done === true,
    };
  });
  return {
    heading: 'Challenges',
    rows,
    note: 'Daily challenges reset at midnight UTC, weeklies on Monday. Progress counts in '
      + 'public online matches — solo and private games do not bank. Rewards land with a '
      + 'match payout.',
  };
}

/** Every string the challenges section renders — the no-NaN test walks this. */
export function renderedChallengeStrings(v: ChallengesSectionView): string[] {
  const out: string[] = [v.heading, v.note];
  for (const r of v.rows) out.push(r.name, r.blurb, r.periodLabel, r.progress, r.reward);
  return out;
}

/** Every string the view renders — the no-NaN test walks this. */
export function renderedCompetitionStrings(v: CompetitionsView): string[] {
  const out: string[] = [v.line, v.error, v.emptyTable];
  for (const r of v.rows) {
    out.push(r.name, r.kindLabel, r.clock, r.prize, String(r.entrants), r.yours, r.entryRule);
  }
  for (const s of v.table ?? []) out.push(s.rank, s.name, s.points, s.wins);
  return out;
}
