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

/** Every string the view renders — the no-NaN test walks this. */
export function renderedCompetitionStrings(v: CompetitionsView): string[] {
  const out: string[] = [v.line, v.error, v.emptyTable];
  for (const r of v.rows) {
    out.push(r.name, r.kindLabel, r.clock, r.prize, String(r.entrants), r.yours, r.entryRule);
  }
  for (const s of v.table ?? []) out.push(s.rank, s.name, s.points, s.wins);
  return out;
}
