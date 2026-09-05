/**
 * S11 rewarded — Gate 5 (docs/SPONSORS.md §4.5).
 *
 * "The client never says 'I watched it'." Everything here exists to make that
 * sentence true: the server opens the session and stamps its own clock, counts
 * heartbeats it received itself, and pays against `Date.now()` rather than
 * against anything the client reports. A client that lies can lose a reward it
 * earned; it cannot invent one.
 *
 * The decisions live here as pure functions over plain data, so the rules that
 * decide whether money moves can be read and tested without a socket, a clock
 * or a profile. `adRewardRoutes` in index.ts is the only thing that holds state.
 */
import {
  AD_REWARDS_PER_DAY,
  AD_REWARD_BEAT_MAX_MS,
  AD_REWARD_BEAT_MIN_MS,
  AD_REWARD_BEAT_MS,
  AD_REWARD_FOCUS_RATIO,
  AD_REWARD_MIN_GAP_MS,
  AD_REWARD_MIN_LIFETIME_SECONDS,
  AD_REWARD_SCRAP_LADDER,
  type RewardRefusal,
} from '@doomcraft/shared/sponsor';

/** One open watch. In memory on purpose: a lost session loses a CLAIM, never a grant. */
export interface RewardSession {
  rewardId: string;
  deviceId: string;
  /** The server's own clock at open. The only start time that counts. */
  serverStartMs: number;
  minMs: number;
  /** Heartbeats accepted so far. */
  beats: number;
  /** Of those, how many reported the tab visible AND focused. */
  attentive: number;
  /** The last accepted `seq`, which must strictly increase. */
  lastSeq: number;
  /** Server arrival time of the last accepted beat, for spacing. */
  lastBeatMs: number;
  claimed: boolean;
}

/**
 * What the next grant is worth.
 *
 * ECONOMY.md's "diminishing returns" made concrete: index by grants ALREADY
 * taken today, so the first pays the top of the ladder and anything past its
 * end pays nothing. Returning 0 rather than refusing keeps one rule — the cap
 * check below is what refuses — and means a ladder change cannot accidentally
 * create a fifth paying grant.
 */
export function rewardScrapFor(countToday: number): number {
  if (countToday < 0) return 0;
  return AD_REWARD_SCRAP_LADDER[countToday] ?? 0;
}

/** How many heartbeats a watch of this length must have produced. */
export function beatsRequired(minMs: number): number {
  return Math.floor(Math.max(0, minMs) / AD_REWARD_BEAT_MS);
}

/**
 * Is this heartbeat's ARRIVAL plausible?
 *
 * The window is deliberately wide in both directions — it is clock-skew and
 * jitter tolerant, not a stopwatch. What it actually defeats is the client that
 * sits silent and then posts a burst of beats to fake elapsed time: those
 * arrive milliseconds apart and every one after the first is refused.
 * `lastBeatMs` of 0 means this is the first beat, which has nothing to space
 * itself against.
 */
export function beatSpacingOk(lastBeatMs: number, nowMs: number): boolean {
  if (lastBeatMs <= 0) return true;
  const gap = nowMs - lastBeatMs;
  return gap >= AD_REWARD_BEAT_MIN_MS && gap <= AD_REWARD_BEAT_MAX_MS;
}

/** Was the player actually there for enough of it? */
export function attentionOk(beats: number, attentive: number): boolean {
  if (beats <= 0) return false;
  return attentive / beats >= AD_REWARD_FOCUS_RATIO;
}

export interface ClaimInput {
  session: RewardSession | undefined;
  nowMs: number;
  /** UTC day string for `nowMs`. */
  today: string;
  /** The profile's durable grant record. */
  rewards: { day: string; count: number; lastMs: number };
  /** `progress.secondsPlayed` — server-recorded lifetime play. */
  lifetimeSeconds: number;
  /** True while the player is in a mode that can damage other players. */
  inPvp: boolean;
  /** True when the player bought ads off; they are paid without watching. */
  adsRemoved: boolean;
}

export interface ClaimVerdict {
  refusal: RewardRefusal;
  /** Scrap to credit. Zero unless `refusal` is 'ok'. */
  scrap: number;
  /** Grants taken today AFTER this one, for the durable record. */
  countAfter: number;
}

function refuse(refusal: RewardRefusal, countToday: number): ClaimVerdict {
  return { refusal, scrap: 0, countAfter: countToday };
}

/**
 * The whole of Gate 5's claim decision, in one place.
 *
 * Ordering is deliberate. The CAP rules are checked before the WATCH rules for
 * the ad-free path, and after them otherwise, because a player who bought ads
 * off never opened a session — the spec requires their button to work and pay
 * instantly, or "the $4.99 purchase makes you strictly worse off, the worst
 * possible shape for a monetisation design". They are still capped, still
 * rate-limited and still subject to the playtime floor: the purchase removes
 * the video, not the economy.
 */
export function claimVerdict(input: ClaimInput): ClaimVerdict {
  const rolled = input.rewards.day === input.today ? input.rewards : { day: input.today, count: 0, lastMs: input.rewards.lastMs };
  const countToday = rolled.count;

  // Rules about the ACCOUNT. These bind whether or not a video was watched.
  if (input.inPvp) return refuse('in-pvp', countToday);
  if (input.lifetimeSeconds < AD_REWARD_MIN_LIFETIME_SECONDS) return refuse('too-new', countToday);
  if (countToday >= AD_REWARDS_PER_DAY) return refuse('daily-cap', countToday);
  if (rolled.lastMs > 0 && input.nowMs - rolled.lastMs < AD_REWARD_MIN_GAP_MS) return refuse('gap', countToday);

  // Rules about the WATCH. Skipped for a player who bought the video away.
  if (!input.adsRemoved) {
    const s = input.session;
    if (s === undefined) return refuse('unknown-session', countToday);
    if (s.claimed) return refuse('already-claimed', countToday);
    // The server's own clock, never the client's elapsed-time claim.
    if (input.nowMs - s.serverStartMs < s.minMs) return refuse('too-soon', countToday);
    if (s.beats < beatsRequired(s.minMs)) return refuse('too-few-beats', countToday);
    if (!attentionOk(s.beats, s.attentive)) return refuse('not-watched', countToday);
  }

  const scrap = rewardScrapFor(countToday);
  return { refusal: 'ok', scrap, countAfter: countToday + 1 };
}
