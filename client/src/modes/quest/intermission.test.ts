/**
 * DOOMCRAFT — what the Quest intermission counts.
 *
 * The panel itself is DOM and this runner has none, so the thing under test is
 * the decision the panel is BUILT from: `intermissionRows()`. That is on
 * purpose rather than a workaround — the constructor now does nothing except
 * turn this list into elements, so a row that is wrong here is wrong on screen,
 * and a row that is right here cannot be wrong on screen without the loop
 * itself being broken.
 *
 * The claim being locked down is `docs/ECONOMY.md` decision 1: this screen
 * RENDERS what the server granted and computes none of it. There is no
 * arithmetic in here that turns a kill into a number.
 */

import { describe, expect, it } from 'vitest';

import { createIntermissionStats, percentOf } from '@shared/modes';

import { intermissionRows } from './intermission';

function stats(over: Partial<ReturnType<typeof createIntermissionStats>> = {}) {
  return { ...createIntermissionStats(), ...over };
}

describe('the rows the intermission counts', () => {
  it('is DOOM\'s three percentages and nothing else when the economy is off', () => {
    const rows = intermissionRows(stats({ kills: 9, killsTotal: 12 }));
    expect(rows.map((r) => r.label)).toEqual(['Kills', 'Items', 'Secrets']);
    for (const r of rows) expect(r.suffix).toBe('%');
    expect(rows[0].target).toBe(percentOf(9, 12));
  });

  it('leaves the three percentages untouched when it does add the reward rows', () => {
    const s = stats({ kills: 9, killsTotal: 12, secrets: 1, secretsTotal: 2 });
    const off = intermissionRows(s);
    const on = intermissionRows(s, true, 340, 26);
    expect(on.slice(0, 3)).toEqual(off);
  });

  it('shows what the SERVER granted, as a delta, with a plus on it', () => {
    const rows = intermissionRows(stats(), true, 340, 26);
    expect(rows.map((r) => r.label)).toEqual(['Kills', 'Items', 'Secrets', 'XP', 'Scrap']);
    expect(rows[3]).toMatchObject({ label: 'XP', target: 340, prefix: '+', suffix: '' });
    expect(rows[4]).toMatchObject({ label: 'Scrap', target: 26, prefix: '+', suffix: '' });
  });

  it('shows a zero reward rather than hiding it, because a refusal the player '
    + 'cannot see looks exactly like a missing feature', () => {
    // A private room, or the day cap already spent. Both are real, both pay 0,
    // and both are things the player is owed an answer about.
    const rows = intermissionRows(stats(), true, 0, 0);
    expect(rows).toHaveLength(5);
    expect(rows[3].target).toBe(0);
    expect(rows[4].target).toBe(0);
  });

  it('never marks a reward row "perfect", which is a percentage idea', () => {
    const rows = intermissionRows(stats(), true, 5000, 900);
    expect(rows[0].perfectAt).toBe(100);
    expect(rows[3].perfectAt).toBe(Infinity);
    expect(rows[4].perfectAt).toBe(Infinity);
  });

  it('counts a big reward at the same wall-clock as a percentage, so a 900 XP '
    + 'level does not sit there ticking for ten seconds', () => {
    const pctSeconds = 100 / intermissionRows(stats())[0].rate;
    for (const amount of [0, 40, 340, 900, 6000]) {
      const row = intermissionRows(stats(), true, amount, 0)[3];
      const seconds = row.target / row.rate;
      expect(seconds).toBeLessThanOrEqual(pctSeconds + 1e-9);
    }
  });

  it('refuses a negative or fractional grant on the way in', () => {
    const rows = intermissionRows(stats(), true, -500, 13.6);
    expect(rows[3].target).toBe(0);
    expect(rows[4].target).toBe(14);
  });
});
