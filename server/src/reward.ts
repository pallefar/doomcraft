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

/**
 * The claim a room hands to the entitlement guard.
 *
 * `stats` is never omitted: `toMatchResult` returns null without it, so an
 * XP-only submission would be accepted, mark the device settled, and then pay
 * exactly nothing — the worst of both outcomes.
 */
export function buildSubmission(t: RoundTally): ResultSubmission {
  return {
    sessionId: t.sessionId,
    deviceId: t.deviceId,
    submittedBy: SubmitterKind.ROOM_SIM,
    xp: xpForRound(t),
    scrap: scrapForRound(t),
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
