/**
 * DOOMCRAFT — the achievements board: decisions here, DOM in the tab.
 *
 * The honesty rules, inherited from `buildChallengesSection` and extended by
 * one that challenges do not need:
 *
 * - A null wire answer renders NOTHING. An empty board must never read as
 *   "you have finished everything."
 * - `paid` renders as a fact, never as a bar stuck at 100%.
 * - `earned` IS A REAL STATE AND GETS ITS OWN WORDS. It is reachable in
 *   ordinary play: the award is won and payment waits for a session allowed to
 *   grant Scrap. Collapsing it into `paid` claims money the player has not
 *   been given; collapsing it into `locked` hides an award they have won.
 * - The note says these are LIFETIME totals from the SERVER ACCOUNT, because
 *   the profile screen also has a device-local fallback and "lifetime" is
 *   ambiguous between the two.
 */

/** One row as the server sends it. `state` is decided server-side; the client never re-derives it. */
export interface WireAchievement {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly stat: string;
  readonly target: number;
  readonly scrap: number;
  readonly item: string | null;
  readonly itemName: string;
  readonly progress: number;
  readonly state: string;
}

export type AchievementState = 'locked' | 'earned' | 'paid';

export interface AchievementRowView {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  /** '940 / 1,000' while locked; 'earned' or 'unlocked' otherwise. Never empty. */
  readonly progress: string;
  /** 0..1 for the bar. earned and paid render 1. */
  readonly frac: number;
  /** '250 Scrap' | '150 Scrap + Season Zero Veteran'. Never empty. */
  readonly reward: string;
  readonly state: AchievementState;
  /** Why this row looks the way it does, in the player's terms. '' when locked. */
  readonly note: string;
}

export interface AchievementsSectionView {
  /** '' = render nothing (no wire answer, or no defs shipped). */
  readonly heading: string;
  readonly rows: readonly AchievementRowView[];
  /** '3 of 6 unlocked'. Never empty when `heading` is set. */
  readonly tally: string;
  readonly note: string;
}

function safeInt(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 0;
  return v;
}

function groupInt(n: number): string {
  return n.toLocaleString('en-GB');
}

/** Only the three the server sends; anything else is treated as locked. */
function stateOf(raw: string): AchievementState {
  return raw === 'paid' ? 'paid' : raw === 'earned' ? 'earned' : 'locked';
}

export function buildAchievementsSection(
  achievements: readonly WireAchievement[] | null,
): AchievementsSectionView {
  if (achievements === null || achievements.length === 0) {
    return { heading: '', rows: [], tally: '', note: '' };
  }
  const rows: AchievementRowView[] = achievements.map((a) => {
    const target = Math.max(1, safeInt(a.target));
    const progress = Math.max(0, Math.min(safeInt(a.progress), target));
    const scrap = Math.max(0, safeInt(a.scrap));
    const state = stateOf(a.state);
    const itemHalf = a.item === null || a.item === undefined ? ''
      : ` + ${typeof a.itemName === 'string' && a.itemName.length > 0 ? a.itemName : 'an item'}`;
    return {
      id: a.id,
      name: typeof a.name === 'string' && a.name.length > 0 ? a.name : a.id,
      blurb: typeof a.blurb === 'string' ? a.blurb : '',
      progress: state === 'paid' ? 'unlocked'
        : state === 'earned' ? 'earned'
          : `${groupInt(progress)} / ${groupInt(target)}`,
      frac: state === 'locked' ? progress / target : 1,
      reward: `${groupInt(scrap)} Scrap${itemHalf}`,
      state,
      note: state === 'earned'
        ? 'Earned — it pays at the end of your next online match.'
        : '',
    };
  });
  const unlocked = rows.filter((r) => r.state === 'paid').length;
  return {
    heading: 'Achievements',
    rows,
    tally: `${groupInt(unlocked)} of ${groupInt(rows.length)} unlocked`,
    note: 'Achievements count your whole career on this account and are paid once. '
      + 'They track the lifetime totals on your profile, so matches you have already '
      + 'played count towards them.',
  };
}

/** Every string the section renders — the no-NaN test walks this. */
export function renderedAchievementStrings(v: AchievementsSectionView): string[] {
  const out: string[] = [v.heading, v.tally, v.note];
  for (const r of v.rows) out.push(r.name, r.blurb, r.progress, r.reward, r.note);
  return out;
}
