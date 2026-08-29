/**
 * DOOMCRAFT — the Competitions tab's decisions, proven off the DOM.
 *
 * The rules that cost trust if they drift: a season never asks for an Enter,
 * an entered-but-unranked player is a NORMAL state and not an error, `you` is
 * a boolean and never an id comparison, and nothing ever renders NaN.
 */

import { describe, expect, it } from 'vitest';

import {
  buildChallengesSection,
  buildCompetitionsView,
  clockText,
  prizeText,
  renderedChallengeStrings,
  renderedCompetitionStrings,
  type CompetitionsInputs,
  type WireChallenge,
  type WireCompetition,
} from '@/ui/competitionsModel';

const NOW = 1_756_400_000_000;

function comp(patch: Partial<WireCompetition> = {}): WireCompetition {
  return {
    id: 'season-1', kind: 'season', name: 'Season Zero',
    startMs: NOW - 86_400_000, endMs: NOW + 12 * 86_400_000,
    state: 'running', minLevel: 0, scrapByRank: [500, 250, 100],
    entrants: 12, entered: false, yourRank: 0, yourPoints: 0,
    ...patch,
  };
}

function inputsOf(patch: Partial<CompetitionsInputs> = {}): CompetitionsInputs {
  return {
    phase: 'ready',
    competitions: [comp()],
    standings: {},
    open: '',
    busy: false,
    error: '',
    nowMs: NOW,
    ...patch,
  };
}

describe('who may enter', () => {
  it('a season NEVER shows an enter action — it enrols on the first paying round', () => {
    const v = buildCompetitionsView(inputsOf());
    expect(v.rows[0].canEnter).toBe(false);
  });

  it('a running, un-entered tournament asks; entered or finalised never does', () => {
    const t = comp({ id: 't1', kind: 'tournament', minLevel: 5 });
    expect(buildCompetitionsView(inputsOf({ competitions: [t] })).rows[0].canEnter).toBe(true);
    expect(buildCompetitionsView(inputsOf({ competitions: [t] })).rows[0].entryRule).toBe('entrants must be level 5');
    const entered = comp({ id: 't1', kind: 'tournament', entered: true });
    expect(buildCompetitionsView(inputsOf({ competitions: [entered] })).rows[0].canEnter).toBe(false);
    const done = comp({ id: 't1', kind: 'tournament', state: 'finalised' });
    expect(buildCompetitionsView(inputsOf({ competitions: [done] })).rows[0].canEnter).toBe(false);
    expect(buildCompetitionsView(inputsOf({ competitions: [t], busy: true })).rows[0].canEnter).toBe(false);
  });
});

describe('the honest states', () => {
  it('entered with rank 0 reads as "on the roster", never as an error', () => {
    const c = comp({ entered: true, yourRank: 0, yourPoints: 0 });
    const row = buildCompetitionsView(inputsOf({ competitions: [c] })).rows[0];
    expect(row.yours).toContain('on the roster');
    const ranked = comp({ entered: true, yourRank: 4, yourPoints: 1220 });
    expect(buildCompetitionsView(inputsOf({ competitions: [ranked] })).rows[0].yours).toBe('rank #4 · 1,220 pts');
  });

  it('standings highlight by the you BOOLEAN and an empty board has a sentence', () => {
    const standings = { 's1': [
      { rank: 1, who: 'abcd1234', name: 'Alfa', points: 900, wins: 3, you: false },
      { rank: 2, who: 'ef567890', name: 'You', points: 700, wins: 2, you: true },
    ] };
    const v = buildCompetitionsView(inputsOf({ open: 's1', standings }));
    expect(v.table).toHaveLength(2);
    expect(v.table![0].you).toBe(false);
    expect(v.table![1].you).toBe(true);
    // Not fetched yet -> null (spinner), fetched-empty -> [] plus the sentence.
    expect(buildCompetitionsView(inputsOf({ open: 's1' })).table).toBeNull();
    const empty = buildCompetitionsView(inputsOf({ open: 's1', standings: { 's1': [] } }));
    expect(empty.table).toEqual([]);
    expect(empty.emptyTable).toContain('first paying match');
  });

  it('clocks and prizes are sentences, never raw numbers', () => {
    expect(clockText(NOW + 12 * 86_400_000, 'running', NOW)).toBe('ends in 12d');
    expect(clockText(NOW + 5 * 3_600_000, 'running', NOW)).toBe('ends in 5h');
    expect(clockText(NOW + 90_000, 'running', NOW)).toBe('ends in 1m');
    expect(clockText(NOW - 1, 'running', NOW)).toBe('closing');
    expect(clockText(0, 'finalised', NOW)).toBe('finalised');
    expect(prizeText([500, 250, 100])).toBe('1st place 500 Scrap · top 3 paid');
    expect(prizeText([1500])).toBe('winner takes 1,500 Scrap');
    expect(prizeText([])).toBe('no Scrap prizes');
    expect(prizeText([0, 0])).toBe('no Scrap prizes');
  });

  it('each phase says what is true', () => {
    expect(buildCompetitionsView(inputsOf({ phase: 'loading' })).line).toContain('Loading');
    expect(buildCompetitionsView(inputsOf({ phase: 'offline' })).line).toContain('No server');
    expect(buildCompetitionsView(inputsOf({ competitions: [] })).line).toContain('No competitions');
    expect(buildCompetitionsView(inputsOf()).line).toContain('not in real time');
  });
});

describe('laundering', () => {
  it('no rendered string ever says NaN, Infinity or undefined', () => {
    const hostile = inputsOf({
      competitions: [comp({ endMs: Number.NaN, entrants: Number.NaN, yourPoints: Number.POSITIVE_INFINITY, entered: true, yourRank: 3 })],
      open: 's1',
      standings: { 's1': [{ rank: Number.NaN, who: '', name: '', points: Number.NaN, wins: Number.NaN, you: false }] },
    });
    for (const v of [buildCompetitionsView(hostile), buildCompetitionsView(inputsOf())]) {
      for (const s of renderedCompetitionStrings(v)) expect(s).not.toMatch(/NaN|Infinity|undefined/);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * The challenges section (Studio S4)
 * ------------------------------------------------------------------------ */

function chal(patch: Partial<WireChallenge> = {}): WireChallenge {
  return {
    id: 'daily.kill-25', name: 'Exterminator', blurb: 'Take down 25 today.',
    period: 'daily', target: 25, scrap: 40, item: null, itemName: '',
    progress: 10, done: false,
    ...patch,
  };
}

describe('the challenges section', () => {
  it('hides entirely on a null wire answer — an empty board must never read as finished', () => {
    expect(buildChallengesSection(null).heading).toBe('');
    expect(buildChallengesSection([]).heading).toBe('');
  });

  it('renders progress as a fraction and done as done, never a stuck bar', () => {
    const v = buildChallengesSection([chal(), chal({ id: 'daily.win-1', done: true, progress: 1, target: 1 })]);
    expect(v.heading).toBe('Challenges');
    expect(v.rows[0]?.progress).toBe('10 / 25');
    expect(v.rows[0]?.frac).toBeCloseTo(0.4);
    expect(v.rows[1]?.progress).toBe('done');
    expect(v.rows[1]?.frac).toBe(1);
  });

  it('names the item half of a reward, with a fallback when the server sent no name', () => {
    const named = buildChallengesSection([chal({ item: 'title-knee-deep', itemName: 'Knee-Deep', scrap: 100 })]);
    expect(named.rows[0]?.reward).toBe('100 Scrap + Knee-Deep');
    const unnamed = buildChallengesSection([chal({ item: 'title-knee-deep', itemName: '' })]);
    expect(unnamed.rows[0]?.reward).toContain('+ an item');
  });

  it('teaches where progress banks and when it resets', () => {
    const v = buildChallengesSection([chal()]);
    expect(v.note).toContain('midnight UTC');
    expect(v.note).toContain('Monday');
    expect(v.note).toContain('public online matches');
    expect(v.note).toContain('private');
  });

  it('no rendered string ever says NaN, Infinity or undefined', () => {
    const hostile = buildChallengesSection([chal({
      target: Number.NaN, progress: Number.POSITIVE_INFINITY, scrap: Number.NaN,
    })]);
    for (const s of renderedChallengeStrings(hostile)) {
      expect(s).not.toMatch(/NaN|Infinity|undefined/);
    }
  });
});
