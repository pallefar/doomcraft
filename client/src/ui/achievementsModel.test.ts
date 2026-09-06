/**
 * DOOMCRAFT — the achievements board model. Three states, and the middle one
 * is the whole reason this file is not a copy of the challenges section.
 */

import { describe, expect, it } from 'vitest';

import {
  buildAchievementsSection,
  renderedAchievementStrings,
  type WireAchievement,
} from '@/ui/achievementsModel';

function row(over: Partial<WireAchievement> = {}): WireAchievement {
  return {
    id: 'achievement.kills-1000', name: 'Exterminator', blurb: 'A thousand down.',
    stat: 'kills', target: 1000, scrap: 250, item: null, itemName: '',
    progress: 940, state: 'locked', ...over,
  };
}

describe('a missing answer is not an empty board', () => {
  it('renders nothing at all for null, and nothing for an empty list', () => {
    /* The defective implementation returns a heading with zero rows, which on
     * screen reads as "you have finished everything" — the opposite of the
     * truth, and indistinguishable from a player who genuinely has none. */
    expect(buildAchievementsSection(null).heading).toBe('');
    expect(buildAchievementsSection([]).heading).toBe('');
    expect(buildAchievementsSection([]).rows).toEqual([]);
  });
});

describe('earned is a state, not a full progress bar', () => {
  it('separates locked, earned and paid in words as well as in colour', () => {
    /* `progress === target && !done` is reachable in ordinary play: the award
     * is won and payment waits for a session allowed to grant Scrap. The
     * defective implementations are the two collapses — folding earned into
     * PAID claims money the player has not been given, and folding it into
     * LOCKED hides an award they have won. Both are caught by the rendered
     * strings differing, which is what the player actually reads. */
    const [locked] = buildAchievementsSection([row()]).rows;
    const [earned] = buildAchievementsSection([row({ progress: 1000, state: 'earned' })]).rows;
    const [paid] = buildAchievementsSection([row({ progress: 1000, state: 'paid' })]).rows;

    expect(locked.progress).toBe('940 / 1,000');
    expect(earned.progress).toBe('earned');
    expect(paid.progress).toBe('unlocked');

    expect(locked.state).toBe('locked');
    expect(earned.state).toBe('earned');
    expect(paid.state).toBe('paid');

    // The three read differently on screen, not merely in the data.
    expect(new Set([locked.progress, earned.progress, paid.progress]).size).toBe(3);

    // Only `earned` explains itself, because only `earned` needs explaining.
    expect(earned.note).toContain('pays at the end of your next online match');
    expect(locked.note).toBe('');
    expect(paid.note).toBe('');
  });

  it('fills the bar for earned and paid, and only proportionally for locked', () => {
    expect(buildAchievementsSection([row()]).rows[0].frac).toBeCloseTo(0.94);
    expect(buildAchievementsSection([row({ state: 'earned' })]).rows[0].frac).toBe(1);
    expect(buildAchievementsSection([row({ state: 'paid' })]).rows[0].frac).toBe(1);
  });

  it('counts only PAID rows in the tally', () => {
    /* The defective implementation counts `earned` as unlocked, so the tally
     * promises a reward the player has not been paid. */
    const v = buildAchievementsSection([
      row({ id: 'a.1', state: 'paid' }),
      row({ id: 'a.2', state: 'earned' }),
      row({ id: 'a.3', state: 'locked' }),
    ]);
    expect(v.tally).toBe('1 of 3 unlocked');
  });

  it('treats an unknown state as locked rather than trusting it', () => {
    const [r] = buildAchievementsSection([row({ state: 'PAID' })]).rows;
    expect(r.state).toBe('locked');
  });
});

describe('the numbers survive hostile input', () => {
  it('never renders NaN, Infinity or a negative, whatever the wire says', () => {
    const nasty = buildAchievementsSection([
      row({ progress: Number.NaN, target: Number.NaN, scrap: Number.NaN }),
      row({ id: 'a.2', progress: -5, target: 0, scrap: -1 }),
      row({ id: 'a.3', progress: Infinity, target: 10, scrap: Infinity }),
      row({ id: 'a.4', name: '', blurb: undefined as unknown as string }),
    ]);
    for (const s of renderedAchievementStrings(nasty)) {
      expect(s).not.toMatch(/NaN|Infinity|undefined|-\d/);
    }
    for (const r of nasty.rows) {
      expect(r.frac).toBeGreaterThanOrEqual(0);
      expect(r.frac).toBeLessThanOrEqual(1);
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.progress.length).toBeGreaterThan(0);
      expect(r.reward.length).toBeGreaterThan(0);
    }
  });

  it('names the item when it has a name and says "an item" when it does not', () => {
    expect(buildAchievementsSection([row({ item: 'trophy-first-season', itemName: 'Season Zero Veteran' })])
      .rows[0].reward).toBe('250 Scrap + Season Zero Veteran');
    expect(buildAchievementsSection([row({ item: 'trophy-x', itemName: '' })])
      .rows[0].reward).toBe('250 Scrap + an item');
    expect(buildAchievementsSection([row()]).rows[0].reward).toBe('250 Scrap');
  });

  it('says these are lifetime totals that already-played matches count towards', () => {
    /* The retroactive rule is the single most surprising thing about this
     * board, and a player who is not told will read a completed award as a
     * bug. */
    const note = buildAchievementsSection([row()]).note;
    expect(note).toContain('whole career');
    expect(note).toContain('already');
  });
});
