/**
 * DOOMCRAFT — what one round of play is worth, as a number.
 *
 * This file answers "how much" and nothing else. It never answers "whether":
 * which kinds of reward a given match may pay at all is decided in exactly one
 * place, `shared/src/trust.ts`, and applied by `reviewSubmission`. So there is
 * deliberately not a single mode literal below. Hand this a Builder round and
 * it will happily compute a Scrap figure; the guard will strip it to zero
 * because the Builder row does not carry the Scrap bit, and the strip lands in
 * the audit ring where it can be seen. That is the design: one place decides,
 * one place computes, and the decision outranks the computation.
 *
 * `shared/src/trust.test.ts` scans the whole tree for a line that names a mode
 * and a reward in the same breath, because that is how a policy leaks back out
 * of the table one convenient `if` at a time. This file must stay clean of
 * them; if you ever need to branch, read `trustPolicyFor(...).grants`.
 */

import {
  SCRAP_PER_KILL,
  SCRAP_PER_MINUTE,
  SCRAP_PER_WIN,
  XP_PER_KILL,
  XP_PER_MINUTE,
  XP_PER_WIN,
} from '@doomcraft/shared';

import { SubmitterKind, type ResultSubmission } from './entitlementGuard.js';

/**
 * One player's round, as the simulation tallied it. Every field is a fact the
 * server observed; none of it comes from a client message.
 */
export interface RoundTally {
  sessionId: string;
  deviceId: string;
  won: boolean;
  kills: number;
  deaths: number;
  /** Seconds of this round the player was actually in. */
  seconds: number;
  bestStreak: number;
  damageDealt: number;
  blocksPlaced: number;
  blocksBroken: number;
  /** WeaponId held at the end. */
  favouriteWeapon: number;
}

/** XP for a round. The formula the room has always used, moved verbatim. */
export function xpForRound(t: RoundTally): number {
  return t.kills * XP_PER_KILL
    + (t.won ? XP_PER_WIN : 0)
    + (t.seconds / 60) * XP_PER_MINUTE;
}

/**
 * Scrap for a round, on the same shape as XP so the two stay comparable.
 *
 * Time pays, but slowly: the whole point of a currency is that it is earned by
 * playing rather than by idling, and the modes where idling is possible are the
 * ones the table refuses Scrap to outright.
 */
export function scrapForRound(t: RoundTally): number {
  return t.kills * SCRAP_PER_KILL
    + (t.won ? SCRAP_PER_WIN : 0)
    + (t.seconds / 60) * SCRAP_PER_MINUTE;
}

/* ------------------------------------------------------------------------ *
 * Anti-farm, part one: what one round may be worth at all
 *
 * `docs/ECONOMY.md` lists four rules — per-match caps, per-day caps with
 * diminishing returns, no reward for a match joined after it was decided, and
 * idle detection. They live in four different files on purpose, each one where
 * its facts are. The two below are the ones whose only fact is this round:
 *
 *   here            per-match ceilings, the minimum paid duration, idleness
 *   persistence.ts  the per-day buckets and the ladder (they need the profile)
 *   room.ts         the late-join refusal (it needs the round's own state)
 *   the guard       one payout per device per round (it holds the ledger)
 *
 * None of them is a mode branch, and none of them decides *whether* a kind of
 * reward is allowed. That is still the trust table's single job.
 * ------------------------------------------------------------------------ */

/**
 * The most one round may be worth, as a product decision.
 *
 * `MAX_XP_PER_MATCH` / `MAX_SCRAP_PER_MATCH` in `entitlementGuard.ts` are ten
 * times larger and mean something different: they are the ceilings a *bug* hits,
 * and the guard records hitting one in `verdict.clamped` where it reads as an
 * alarm. These are the ceilings ordinary play hits, so they are enforced before
 * the submission is built and are silent.
 *
 * 900 XP is roughly a full eight minutes plus a twenty-kill win.
 */
export const MATCH_XP_CAP = 900;
export const MATCH_SCRAP_CAP = 120;

/**
 * A round shorter than this pays nothing.
 *
 * Not "is refused": the round still goes to the guard and the player's kills
 * still land on their profile. What a thirty-second floor stops is the reward
 * loop being farmable by joining and quitting, which is the cheapest possible
 * farm and needs no bot at all.
 */
export const MIN_PAID_SECONDS = 30;

/**
 * Did the player do anything the simulation could see?
 *
 * This is the fourth item on the anti-farm list, and the one that matters most
 * to a Builder or a Horde room: those rooms run an eight-minute Deathmatch
 * clock they never asked for (`docs/BUGS-FOUND.md` §4, unfixed), so an idle
 * player is otherwise paid for existing. Rather than change what a round *is*
 * for those modes — a much larger change, and one that would take the ledger's
 * only session boundary with it — refuse to pay idleness.
 *
 * Deaths count as activity on purpose. Being repeatedly killed is not idling;
 * it is playing badly, and a currency that punishes that is a currency that
 * teaches people to hide.
 */
export function playedIdle(t: RoundTally): boolean {
  return t.kills === 0
    && t.deaths === 0
    && t.damageDealt === 0
    && t.blocksPlaced === 0
    && t.blocksBroken === 0;
}

/**
 * Is this round worth anything at all? Length and effort, nothing else — a
 * question about the round, never about the mode or the player.
 */
export function roundPays(t: RoundTally): boolean {
  return t.seconds >= MIN_PAID_SECONDS && !playedIdle(t);
}

/**
 * The claim a room hands to the entitlement guard.
 *
 * `stats` is never omitted: `toMatchResult` returns null without it, so an
 * XP-only submission would be accepted, mark the device settled, and then pay
 * exactly nothing — the worst of both outcomes.
 */
export function buildSubmission(t: RoundTally): ResultSubmission {
  // A round that is too short, or in which nothing at all happened, still
  // reports its stats — the match was played and the profile should say so —
  // but it is worth zero. The caps are applied here rather than after the
  // guard so that `verdict.clamped` keeps meaning "a bug got this far".
  const pays = roundPays(t);
  return {
    sessionId: t.sessionId,
    deviceId: t.deviceId,
    submittedBy: SubmitterKind.ROOM_SIM,
    xp: pays ? Math.min(xpForRound(t), MATCH_XP_CAP) : 0,
    scrap: pays ? Math.min(scrapForRound(t), MATCH_SCRAP_CAP) : 0,
    stats: {
      kills: t.kills,
      deaths: t.deaths,
      won: t.won,
      bestStreak: t.bestStreak,
      damageDealt: t.damageDealt,
      blocksPlaced: t.blocksPlaced,
      blocksBroken: t.blocksBroken,
      seconds: t.seconds,
      favouriteWeapon: t.favouriteWeapon,
    },
  };
}
