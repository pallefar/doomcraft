/**
 * Gate 5, the only thing in the sponsor system that pays a player.
 *
 * docs/SPONSORS.md §4.5 opens with the sentence these tests exist to keep true:
 * "The client never says 'I watched it'." Every refusal below is a way of
 * saying that, and every one of them can be deleted by an edit that looks
 * harmless.
 */
import { describe, expect, it } from 'vitest';

import {
  AD_REWARDS_PER_DAY, AD_REWARD_MIN_GAP_MS, AD_REWARD_MIN_LIFETIME_SECONDS,
  AD_REWARD_SCRAP_LADDER,
} from '@doomcraft/shared/sponsor';
import {
  attentionOk, beatSpacingOk, beatsRequired, claimVerdict, rewardScrapFor,
  type ClaimInput, type RewardSession,
} from './adReward.js';

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
const TODAY = '2026-09-05';

function session(over: Partial<RewardSession> = {}): RewardSession {
  return {
    rewardId: 'rw_1', deviceId: 'device-1',
    serverStartMs: NOW - 20_000, minMs: 15_000,
    beats: 8, attentive: 8, lastSeq: 8, lastBeatMs: NOW - 1_000,
    claimed: false, ...over,
  };
}

function input(over: Partial<ClaimInput> = {}): ClaimInput {
  return {
    session: session(), nowMs: NOW, today: TODAY,
    rewards: { day: TODAY, count: 0, lastMs: 0 },
    lifetimeSeconds: AD_REWARD_MIN_LIFETIME_SECONDS, inPvp: false, adsRemoved: false,
    ...over,
  };
}

describe('the diminishing ladder', () => {
  it('pays down the ladder and then nothing', () => {
    expect(rewardScrapFor(0)).toBe(AD_REWARD_SCRAP_LADDER[0]);
    expect(rewardScrapFor(3)).toBe(AD_REWARD_SCRAP_LADDER[3]);
    // Past the end pays 0 rather than repeating the last rung.
    expect(rewardScrapFor(4)).toBe(0);
    expect(rewardScrapFor(99)).toBe(0);
    expect(rewardScrapFor(-1)).toBe(0);
  });

  it('is strictly decreasing, which is what "diminishing" means', () => {
    for (let i = 1; i < AD_REWARD_SCRAP_LADDER.length; i++) {
      expect(AD_REWARD_SCRAP_LADDER[i]).toBeLessThan(AD_REWARD_SCRAP_LADDER[i - 1]);
    }
  });
});

describe('the heartbeat rules', () => {
  it('requires one beat per two seconds of watch', () => {
    expect(beatsRequired(15_000)).toBe(7);
    expect(beatsRequired(0)).toBe(0);
  });

  /**
   * The rule's real target: a client that sits silent and then posts a burst of
   * beats to fake elapsed time. Those arrive milliseconds apart.
   */
  it('refuses a burst of beats, and tolerates ordinary jitter', () => {
    expect(beatSpacingOk(NOW - 5, NOW), 'a burst was accepted').toBe(false);
    expect(beatSpacingOk(NOW - 2_000, NOW)).toBe(true);
    expect(beatSpacingOk(NOW - 1_700, NOW), 'ordinary jitter was refused').toBe(true);
    expect(beatSpacingOk(NOW - 3_400, NOW), 'a slow frame was refused').toBe(true);
    // Too slow is also wrong: a tab that was away is not a tab that watched.
    expect(beatSpacingOk(NOW - 9_000, NOW)).toBe(false);
    // The first beat has nothing to space itself against.
    expect(beatSpacingOk(0, NOW)).toBe(true);
  });

  it('requires four fifths of beats to be visible and focused', () => {
    expect(attentionOk(10, 8)).toBe(true);
    expect(attentionOk(10, 7)).toBe(false);
    expect(attentionOk(0, 0), 'no beats is not attention').toBe(false);
  });
});

describe('the claim', () => {
  it('pays a clean watch', () => {
    const v = claimVerdict(input());
    expect(v.refusal).toBe('ok');
    expect(v.scrap).toBe(AD_REWARD_SCRAP_LADDER[0]);
    expect(v.countAfter).toBe(1);
  });

  /**
   * THE HEADLINE RULE. RED WITHOUT THE FIX: compare against a client-supplied
   * elapsed time instead of `nowMs - serverStartMs`.
   */
  it('refuses a claim that arrives before the server\'s own clock says it may', () => {
    const v = claimVerdict(input({ session: session({ serverStartMs: NOW - 9_000 }) }));
    expect(v.refusal).toBe('too-soon');
    expect(v.scrap).toBe(0);
  });

  it('refuses too few beats even when the wall clock is satisfied', () => {
    const v = claimVerdict(input({ session: session({ beats: 3, attentive: 3 }) }));
    expect(v.refusal).toBe('too-few-beats');
  });

  it('refuses a watch that was mostly in a background tab', () => {
    const v = claimVerdict(input({ session: session({ beats: 8, attentive: 4 }) }));
    expect(v.refusal).toBe('not-watched');
  });

  it('refuses a session it never opened, and a second claim on one it did', () => {
    expect(claimVerdict(input({ session: undefined })).refusal).toBe('unknown-session');
    expect(claimVerdict(input({ session: session({ claimed: true }) })).refusal).toBe('already-claimed');
  });

  it('refuses past the daily cap', () => {
    const v = claimVerdict(input({ rewards: { day: TODAY, count: AD_REWARDS_PER_DAY, lastMs: 0 } }));
    expect(v.refusal).toBe('daily-cap');
  });

  it('refuses inside the minimum gap, and allows just outside it', () => {
    const tooSoon = claimVerdict(input({ rewards: { day: TODAY, count: 1, lastMs: NOW - 60_000 } }));
    expect(tooSoon.refusal).toBe('gap');
    const ok = claimVerdict(input({ rewards: { day: TODAY, count: 1, lastMs: NOW - AD_REWARD_MIN_GAP_MS } }));
    expect(ok.refusal).toBe('ok');
    expect(ok.scrap).toBe(AD_REWARD_SCRAP_LADDER[1]);
  });

  /**
   * A fresh account that exists only to watch ads is the whole shape of
   * rewarded-video fraud, and playtime is the cheapest thing to require.
   */
  it('pays a brand-new account nothing at all', () => {
    const v = claimVerdict(input({ lifetimeSeconds: AD_REWARD_MIN_LIFETIME_SECONDS - 1 }));
    expect(v.refusal).toBe('too-new');
  });

  it('pays nothing while the player can be shot at', () => {
    expect(claimVerdict(input({ inPvp: true })).refusal).toBe('in-pvp');
  });

  /**
   * A new UTC day forgives the count, and the ladder starts at the top again.
   * RED WITHOUT THE FIX: drop the `rewards.day === today` roll and yesterday's
   * count keeps refusing today's first claim.
   */
  it('rolls the count on a new UTC day', () => {
    const v = claimVerdict(input({
      rewards: { day: '2026-09-04', count: AD_REWARDS_PER_DAY, lastMs: NOW - 86_400_000 },
    }));
    expect(v.refusal).toBe('ok');
    expect(v.scrap).toBe(AD_REWARD_SCRAP_LADDER[0]);
    expect(v.countAfter).toBe(1);
  });
});

/**
 * The ad-free path. §1a: "Do not simply remove it. If ad-free removes the
 * reward, the $4.99 purchase makes you strictly worse off — the worst possible
 * shape for a monetisation design."
 */
describe('a player who bought ads off', () => {
  it('is paid without a session, because there was no video to watch', () => {
    const v = claimVerdict(input({ adsRemoved: true, session: undefined }));
    expect(v.refusal).toBe('ok');
    expect(v.scrap).toBe(AD_REWARD_SCRAP_LADDER[0]);
  });

  /**
   * The purchase removes the VIDEO, not the economy. RED WITHOUT THE FIX: move
   * the cap checks inside the `!adsRemoved` branch and an ad-free player can
   * claim without limit — the purchase becomes a scrap tap.
   */
  it('is still capped, still rate-limited, and still needs the playtime', () => {
    expect(claimVerdict(input({
      adsRemoved: true, session: undefined,
      rewards: { day: TODAY, count: AD_REWARDS_PER_DAY, lastMs: 0 },
    })).refusal).toBe('daily-cap');

    expect(claimVerdict(input({
      adsRemoved: true, session: undefined,
      rewards: { day: TODAY, count: 1, lastMs: NOW - 1_000 },
    })).refusal).toBe('gap');

    expect(claimVerdict(input({
      adsRemoved: true, session: undefined, lifetimeSeconds: 60,
    })).refusal).toBe('too-new');

    expect(claimVerdict(input({ adsRemoved: true, session: undefined, inPvp: true })).refusal).toBe('in-pvp');
  });
});
