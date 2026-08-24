/**
 * DOOMCRAFT — the entitlement guard.
 *
 * `shared/src/trust.ts` says what each (mode, match type) may pay out. This
 * file is the only place that pays it, and it refuses everything the table does
 * not allow.
 *
 * `docs/ECONOMY.md` decision 1: **the server grants every reward; the client
 * never does.** Two things follow, and both are enforced here rather than
 * documented and hoped for:
 *
 *   1. **The client does not get to say what kind of match it was.** A
 *      submission may carry a `claimedMatchType` and a `claimedTopology`; the
 *      guard ignores both and reads the `SessionLedger` entry the server wrote
 *      when it created the session. A mismatch is not an error to correct, it
 *      is a violation to record.
 *   2. **A session we did not simulate pays nothing.** Peer-hosted and
 *      client-local sessions are rejected whole — not stripped down to a
 *      "safe" subset, rejected. There is no such thing as a partly trustworthy
 *      result from a room whose owner could edit the sim.
 *
 * ## The order of checks, and why it is that order
 *
 * ```
 *   unknown session id      -> reject   (fail closed; never default-accept)
 *   session already closed  -> reject   (a late submission is a replay)
 *   submitted by the client -> reject   (decision 1, regardless of session)
 *   untrusted topology      -> reject   (peer / local — the headline rule)
 *   device was not in it    -> reject   (a host submitting for other people)
 *   already submitted       -> reject   (one payout per player per session)
 *   reward not in `grants`  -> strip    (a Public match asking for rating)
 *   over the per-match cap  -> clamp    (defence in depth behind the room)
 * ```
 *
 * Rejection is whole-submission; stripping and clamping are per-field and leave
 * the rest of a legitimate result intact. Both count violations, because both
 * mean something upstream sent us a number it should not have had.
 *
 * ## What this file must never learn
 *
 * It contains no mode literal, no match-type literal and no "is this Horde?"
 * branch. Every policy answer comes from `trustPolicyFor` / `sealSessionTrust`.
 * `shared/src/trust.test.ts` scans this file to keep it that way, so the policy
 * cannot drift out of the table and into the enforcement.
 */

import {
  MATCH_TYPE_KEYS,
  MatchType,
  REWARD_CHALLENGE,
  REWARD_COMPETITION,
  REWARD_ITEM_DROP,
  REWARD_LEADERBOARD,
  REWARD_NONE,
  REWARD_RANKED_RATING,
  REWARD_SCRAP,
  REWARD_SHARE_CARD,
  REWARD_SPONSOR_PRIZE,
  REWARD_STATS,
  REWARD_TRADE_UNLOCK,
  REWARD_XP,
  SERVER_OWNED_PROFILE_FIELDS,
  SessionOrigin,
  Topology,
  WRITE_ACCOUNT_RECORD,
  WRITE_PERSISTENT_WORLD,
  isPrototypePollutingKey,
  isTrustedTopology,
  rewardKeys,
  sealSessionTrust,
  sessionMayGrant,
  sessionMayWrite,
  type SessionTrust,
} from '@doomcraft/shared/trust';
import type { ModeId } from '@doomcraft/shared/modes';

import type { MatchResult } from './persistence.js';

/* ------------------------------------------------------------------------ *
 * Caps — defence in depth behind the room's own tally
 * ------------------------------------------------------------------------ */

/**
 * Ceilings on what one match may pay, whatever the room says. The room is
 * supposed to be right; these exist so that a bug in the room is a capped bug
 * rather than an unbounded one, and so `docs/ECONOMY.md`'s "per-match and
 * per-day caps" have a floor to build on.
 */
export const MAX_XP_PER_MATCH = 5_000;
export const MAX_SCRAP_PER_MATCH = 2_000;
export const MAX_DROPS_PER_MATCH = 4;
export const MAX_RATING_DELTA = 60;
export const MAX_COMPETITION_POINTS = 10_000;
export const MAX_CHALLENGE_IDS = 8;

/** A session with no submission after this long is swept out of the ledger. */
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
/** How many rejections the audit ring keeps. */
export const AUDIT_RING_SIZE = 256;

/* ------------------------------------------------------------------------ *
 * Who is submitting
 * ------------------------------------------------------------------------ */

/**
 * The provenance of a submission inside our own process. A result assembled by
 * the room's own tally is the only kind that may carry reward numbers; anything
 * that arrived from a socket is a client report and pays nothing, even when the
 * session itself is perfectly trusted.
 */
export enum SubmitterKind {
  /** Built by `Room` from its own state, in this process. */
  ROOM_SIM = 0,
  /** Arrived over the wire or over HTTP. Advisory at best. */
  CLIENT_REPORT = 1,
}

/* ------------------------------------------------------------------------ *
 * Session ledger
 * ------------------------------------------------------------------------ */

/**
 * The server's own record of a session. Every field is a server fact: the
 * origin is how *we* created it, the participants are who *we* saw attach, and
 * `simulatedHere` is true only when this process ran the ticks.
 */
export interface SessionRecord {
  readonly sessionId: string;
  readonly trust: SessionTrust;
  readonly createdMs: number;
  /** True only when this process ran the simulation for the whole session. */
  readonly simulatedHere: boolean;
  closedMs: number;
  /** Device ids the server saw attach. A submitter must be one of them. */
  readonly participants: Set<string>;
  /** Device ids that have already been paid for this session. */
  readonly settled: Set<string>;
}

export interface OpenSessionSpec {
  sessionId: string;
  modeId: ModeId | number;
  /** How the server created the session. Never read off a packet. */
  origin: SessionOrigin;
  /**
   * What the matchmaker or the tournament scheduler intended. A server-side
   * fact; `resolveMatchType` clamps it by origin anyway.
   */
  serverIntent: MatchType;
  nowMs?: number;
}

/**
 * Every session this process knows about. Nothing is a session until it is in
 * here, and a submission for an id that is not in here is refused — an unknown
 * session is the shape a forged one takes.
 */
export class SessionLedger {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly clock: () => number;

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  get size(): number { return this.sessions.size; }

  /** Record a session the server just created. Returns its sealed trust facts. */
  open(spec: OpenSessionSpec): SessionRecord {
    const trust = sealSessionTrust(spec.modeId, spec.origin, spec.serverIntent);
    const record: SessionRecord = {
      sessionId: spec.sessionId,
      trust,
      createdMs: spec.nowMs ?? this.clock(),
      // We ran the ticks exactly when the topology says we did. Deriving it
      // from the same one fact keeps the two from disagreeing.
      simulatedHere: isTrustedTopology(trust.topology),
      closedMs: 0,
      participants: new Set<string>(),
      settled: new Set<string>(),
    };
    this.sessions.set(spec.sessionId, record);
    return record;
  }

  get(sessionId: string): SessionRecord | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Note that the server saw this device attach. Called from the join path, so
   * the participant set is observed rather than claimed.
   */
  addParticipant(sessionId: string, deviceId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (s === undefined) return false;
    if (s.closedMs !== 0) return false;
    s.participants.add(deviceId);
    return true;
  }

  close(sessionId: string, nowMs?: number): void {
    const s = this.sessions.get(sessionId);
    if (s === undefined) return;
    if (s.closedMs === 0) s.closedMs = nowMs ?? this.clock();
  }

  /** Forget sessions older than `ttlMs`. Cheap and idempotent; call on a timer. */
  sweep(ttlMs: number = SESSION_TTL_MS, nowMs?: number): number {
    const now = nowMs ?? this.clock();
    let removed = 0;
    for (const [id, s] of [...this.sessions]) {
      if (now - s.createdMs < ttlMs) continue;
      this.sessions.delete(id);
      removed++;
    }
    return removed;
  }

  clear(): void { this.sessions.clear(); }
}

/* ------------------------------------------------------------------------ *
 * Submission and verdict
 * ------------------------------------------------------------------------ */

/** The stat block a match may fold into a profile. Mirrors `MatchResult`. */
export interface SubmittedStats {
  kills: number;
  deaths: number;
  won: boolean;
  bestStreak: number;
  damageDealt: number;
  blocksPlaced: number;
  blocksBroken: number;
  seconds: number;
  favouriteWeapon: number;
}

export function emptyStats(): SubmittedStats {
  return {
    kills: 0, deaths: 0, won: false, bestStreak: 0, damageDealt: 0,
    blocksPlaced: 0, blocksBroken: 0, seconds: 0, favouriteWeapon: 0,
  };
}

/**
 * Everything one player would like credited for one session.
 *
 * `claimedMatchType` and `claimedTopology` exist so that a lying client has
 * somewhere to lie, and so the guard can *record* the lie. They are never used
 * to decide anything.
 */
export interface ResultSubmission {
  sessionId: string;
  deviceId: string;
  /** Where this object was built. `CLIENT_REPORT` pays nothing. */
  submittedBy: SubmitterKind;

  xp?: number;
  scrap?: number;
  /** Item ids the room rolled. */
  drops?: readonly string[];
  ratingDelta?: number;
  competitionPoints?: number;
  leaderboard?: boolean;
  shareCard?: boolean;
  challengeIds?: readonly string[];
  stats?: SubmittedStats;
  /** Block deltas to commit to a persistent world. */
  worldDeltaCount?: number;

  /** Advisory only. Never trusted, only compared. */
  claimedMatchType?: number;
  claimedTopology?: number;
}

/** What the guard decided may actually be granted. */
export interface GrantedRewards {
  readonly xp: number;
  readonly scrap: number;
  readonly drops: readonly string[];
  readonly ratingDelta: number;
  readonly competitionPoints: number;
  readonly leaderboard: boolean;
  readonly shareCard: boolean;
  readonly challengeIds: readonly string[];
  readonly stats: SubmittedStats | null;
  readonly worldDeltaCount: number;
}

export const EMPTY_GRANT: GrantedRewards = Object.freeze({
  xp: 0, scrap: 0, drops: Object.freeze([]) as readonly string[], ratingDelta: 0,
  competitionPoints: 0, leaderboard: false, shareCard: false,
  challengeIds: Object.freeze([]) as readonly string[], stats: null, worldDeltaCount: 0,
});

export enum RejectCode {
  OK = 0,
  /** No such session. The shape a forged submission takes. */
  NO_SESSION = 1,
  /** The result arrived after the session was closed. A replay. */
  SESSION_CLOSED = 2,
  /** Built from a client report rather than the room's own tally. */
  CLIENT_REPORTED = 3,
  /** Peer-hosted. The headline rule. */
  PEER_HOSTED = 4,
  /** Ran in the player's own Web Worker. */
  CLIENT_LOCAL = 5,
  /** The session is trusted but this process did not run its ticks. */
  NOT_SIMULATED_HERE = 6,
  /** The device was never seen in this session. */
  NOT_A_PARTICIPANT = 7,
  /** This device has already been paid for this session. */
  ALREADY_SETTLED = 8,
  /** The row grants nothing: a private or solo match. */
  GRANTS_NOTHING = 9,
  /** Missing or unusable identifiers. */
  MALFORMED = 10,
  /**
   * Not a submission at all: a `POST /api/profile` body that carried a field
   * only a match result may move. Recorded by `noteProfileWrite`, never
   * returned by `reviewSubmission`.
   */
  PROFILE_FIELDS = 11,
}

export const REJECT_REASONS: readonly string[] = Object.freeze([
  'accepted',
  'no such session — the server has no record of creating it',
  'the session was already closed; a later result is a replay',
  'a client-reported result never grants anything (ECONOMY.md decision 1)',
  'peer-hosted: the room ran on a player\'s own machine and can fabricate any result',
  'local: the room ran in this player\'s own Web Worker',
  'this process did not simulate the session',
  'the server never saw this device in this session',
  'this device has already been settled for this session',
  'this match type grants nothing — private and solo matches are unranked by policy',
  'malformed submission',
  'the profile write carried a field only a match result may move',
]);

export interface GuardVerdict {
  readonly accepted: boolean;
  readonly code: RejectCode;
  readonly reason: string;
  readonly sessionId: string;
  readonly deviceId: string;
  /** The session's sealed trust facts, or null when there was no session. */
  readonly trust: SessionTrust | null;
  /** What may be granted. `EMPTY_GRANT` on any rejection. */
  readonly granted: GrantedRewards;
  /** Reward bits the submission asked for that the row does not allow. */
  readonly stripped: number;
  /** Fields clamped to a per-match cap. */
  readonly clamped: readonly string[];
  /**
   * True when the submission asked for something it could not possibly have
   * been entitled to. Worth an alert, not just a log line.
   */
  readonly violation: boolean;
}

function reject(
  code: RejectCode, sessionId: string, deviceId: string,
  trust: SessionTrust | null, violation: boolean,
): GuardVerdict {
  return Object.freeze({
    accepted: false,
    code,
    reason: REJECT_REASONS[code] ?? 'rejected',
    sessionId,
    deviceId,
    trust,
    granted: EMPTY_GRANT,
    stripped: 0,
    clamped: Object.freeze([]) as readonly string[],
    violation,
  });
}

/* ------------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------------ */

function num(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Clamp to `0..max`, noting the field when the cap actually bit. */
function cap(v: number, max: number, field: string, clamped: string[]): number {
  const n = Math.max(0, Math.round(num(v)));
  if (n > max) { clamped.push(field); return max; }
  return n;
}

function idList(v: readonly string[] | undefined, max: number, field: string, clamped: string[]): string[] {
  if (!Array.isArray(v) || v.length === 0) return [];
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== 'string' || s.length === 0 || s.length > 64) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  if (v.length > max) clamped.push(field);
  return out;
}

/** The topology's own reject code, so the audit line says which kind of untrusted. */
function codeForTopology(t: Topology): RejectCode {
  if (t === Topology.PEER_HOSTED) return RejectCode.PEER_HOSTED;
  if (t === Topology.CLIENT_LOCAL) return RejectCode.CLIENT_LOCAL;
  return RejectCode.NOT_SIMULATED_HERE;
}

/**
 * Every reward bit a submission is asking for, as a mask. Used to work out what
 * had to be stripped, which is the number worth alerting on: a client that asks
 * for ranked rating in a casual match is telling you something.
 */
function requestedMask(sub: ResultSubmission): number {
  let m = 0;
  if (num(sub.xp) > 0) m |= REWARD_XP;
  if (num(sub.scrap) > 0) m |= REWARD_SCRAP;
  if (sub.drops !== undefined && sub.drops.length > 0) m |= REWARD_ITEM_DROP;
  if (num(sub.ratingDelta) !== 0) m |= REWARD_RANKED_RATING;
  if (num(sub.competitionPoints) > 0) m |= REWARD_COMPETITION | REWARD_SPONSOR_PRIZE;
  if (sub.leaderboard === true) m |= REWARD_LEADERBOARD;
  if (sub.shareCard === true) m |= REWARD_SHARE_CARD;
  if (sub.challengeIds !== undefined && sub.challengeIds.length > 0) m |= REWARD_CHALLENGE;
  if (sub.stats !== undefined) m |= REWARD_STATS | REWARD_TRADE_UNLOCK;
  return m;
}

/* ------------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------------ */

/**
 * Decide what a submission may be paid. Pure: no I/O, no clock beyond what is
 * passed in, no mutation except marking the device settled on acceptance.
 *
 * Read the order of the checks as the specification — anything that gets past
 * them has been simulated by us, in a match we filled, by a player we saw, once.
 */
export function reviewSubmission(
  ledger: SessionLedger, sub: ResultSubmission, nowMs = Date.now(),
): GuardVerdict {
  const sessionId = typeof sub.sessionId === 'string' ? sub.sessionId : '';
  const deviceId = typeof sub.deviceId === 'string' ? sub.deviceId : '';

  if (sessionId.length === 0 || deviceId.length === 0) {
    return reject(RejectCode.MALFORMED, sessionId, deviceId, null, false);
  }

  /* 1. Unknown session. Fail closed — an id we never issued is the shape a
   *    forged submission takes, and there is nothing to compare it against. */
  const record = ledger.get(sessionId);
  if (record === null) return reject(RejectCode.NO_SESSION, sessionId, deviceId, null, true);

  const trust = record.trust;

  /* 2. Late. The session is over; a result arriving now is a replay of one we
   *    have already seen or one that was never sent. */
  if (record.closedMs !== 0 && nowMs > record.closedMs) {
    // Not a violation on its own: a slow network loses this race honestly.
    return reject(RejectCode.SESSION_CLOSED, sessionId, deviceId, trust, false);
  }

  /* 3. The client never grants. A result that came off a socket pays nothing
   *    even when the session behind it is entirely trustworthy, because the
   *    numbers in it were not computed by anything we control. */
  if (sub.submittedBy !== SubmitterKind.ROOM_SIM) {
    return reject(RejectCode.CLIENT_REPORTED, sessionId, deviceId, trust, true);
  }

  /* 4. THE RULE. A session we did not simulate is rejected whole. Note that we
   *    read `record.trust.topology` — the fact the server stamped at creation —
   *    and never `sub.claimedTopology`. */
  if (!isTrustedTopology(trust.topology) || !record.simulatedHere) {
    // Always a violation. There is no legitimate path that assembles a payout
    // for a session we did not simulate, so reaching this line at all is either
    // a bug upstream or somebody probing — both are worth an alert, and neither
    // gets quieter because the submission was honest about its topology.
    return reject(codeForTopology(trust.topology), sessionId, deviceId, trust, true);
  }

  /* 5. The submitter has to have been in the match. Otherwise the winner of a
   *    four-player room can settle for the other three as well. */
  if (!record.participants.has(deviceId)) {
    return reject(RejectCode.NOT_A_PARTICIPANT, sessionId, deviceId, trust, true);
  }

  /* 6. One payout per player per session. Without this the same honest result
   *    can be replayed for as long as the session is open. */
  if (record.settled.has(deviceId)) {
    return reject(RejectCode.ALREADY_SETTLED, sessionId, deviceId, trust, true);
  }

  /* 7. The row may simply grant nothing — every SOLO and PRIVATE row does, on
   *    the participation rule, even though we hosted it. */
  const wanted = requestedMask(sub);
  if (trust.grants === REWARD_NONE) {
    return reject(RejectCode.GRANTS_NOTHING, sessionId, deviceId, trust, wanted !== 0);
  }

  /* 8. Strip what this row does not grant, clamp what it does. */
  const stripped = wanted & ~trust.grants;
  const clamped: string[] = [];

  const may = (bit: number): boolean => sessionMayGrant(trust, bit);

  const xp = may(REWARD_XP) ? cap(num(sub.xp), MAX_XP_PER_MATCH, 'xp', clamped) : 0;
  const scrap = may(REWARD_SCRAP) ? cap(num(sub.scrap), MAX_SCRAP_PER_MATCH, 'scrap', clamped) : 0;
  const drops = may(REWARD_ITEM_DROP) ? idList(sub.drops, MAX_DROPS_PER_MATCH, 'drops', clamped) : [];
  const competitionPoints = may(REWARD_COMPETITION)
    ? cap(num(sub.competitionPoints), MAX_COMPETITION_POINTS, 'competitionPoints', clamped)
    : 0;
  const challengeIds = may(REWARD_CHALLENGE)
    ? idList(sub.challengeIds, MAX_CHALLENGE_IDS, 'challengeIds', clamped)
    : [];
  const leaderboard = may(REWARD_LEADERBOARD) && sub.leaderboard === true;
  const shareCard = may(REWARD_SHARE_CARD) && sub.shareCard === true;
  const stats = may(REWARD_STATS) && sub.stats !== undefined ? sanitiseStats(sub.stats) : null;

  // Rating is signed: a loss must be able to cost you points, so it is clamped
  // to a symmetric window rather than to 0..max.
  let ratingDelta = 0;
  if (may(REWARD_RANKED_RATING)) {
    const raw = Math.round(num(sub.ratingDelta));
    ratingDelta = raw > MAX_RATING_DELTA ? MAX_RATING_DELTA
      : raw < -MAX_RATING_DELTA ? -MAX_RATING_DELTA : raw;
    if (raw !== ratingDelta) clamped.push('ratingDelta');
  }

  const worldDeltaCount = sessionMayWrite(trust, WRITE_PERSISTENT_WORLD)
    ? Math.max(0, Math.round(num(sub.worldDeltaCount)))
    : 0;

  record.settled.add(deviceId);

  const claimMismatch = sub.claimedMatchType !== undefined
    && sub.claimedMatchType !== trust.matchType;

  return Object.freeze({
    accepted: true,
    code: RejectCode.OK,
    reason: REJECT_REASONS[RejectCode.OK],
    sessionId,
    deviceId,
    trust,
    granted: Object.freeze({
      xp, scrap, drops: Object.freeze(drops), ratingDelta, competitionPoints,
      leaderboard, shareCard, challengeIds: Object.freeze(challengeIds), stats,
      worldDeltaCount,
    }),
    stripped,
    clamped: Object.freeze(clamped),
    violation: stripped !== 0 || claimMismatch,
  });
}

/** Coerce a stat block. Every field bounded; nothing here is trusted verbatim. */
function sanitiseStats(s: SubmittedStats): SubmittedStats {
  const i = (v: number, max: number): number => {
    const n = Math.round(num(v));
    return n < 0 ? 0 : n > max ? max : n;
  };
  return {
    kills: i(s.kills, 10_000),
    deaths: i(s.deaths, 10_000),
    won: s.won === true,
    bestStreak: i(s.bestStreak, 10_000),
    damageDealt: i(s.damageDealt, 10_000_000),
    blocksPlaced: i(s.blocksPlaced, 1_000_000),
    blocksBroken: i(s.blocksBroken, 1_000_000),
    seconds: i(s.seconds, 24 * 60 * 60),
    favouriteWeapon: i(s.favouriteWeapon, 255),
  };
}

/**
 * The `MatchResult` `applyMatchResult` takes, or null when nothing may be
 * folded into the profile. Note that XP rides in here: `applyMatchResult` is
 * the only writer of `progress.xp`, and this is the only producer of its input.
 */
export function toMatchResult(v: GuardVerdict): MatchResult | null {
  if (!v.accepted) return null;
  const s = v.granted.stats;
  if (s === null) return null;
  return {
    kills: s.kills,
    deaths: s.deaths,
    won: s.won,
    bestStreak: s.bestStreak,
    damageDealt: s.damageDealt,
    blocksPlaced: s.blocksPlaced,
    blocksBroken: s.blocksBroken,
    seconds: s.seconds,
    xp: v.granted.xp,
    // Already stripped to 0 by step 8 for any row without the Scrap bit, and
    // clamped to `MAX_SCRAP_PER_MATCH` for the rows that have it. Nothing
    // downstream re-decides this.
    scrap: v.granted.scrap,
    favouriteWeapon: s.favouriteWeapon,
    // Already gated by REWARD_ITEM_DROP and clamped to MAX_DROPS_PER_MATCH
    // in step 8; nothing downstream re-decides this either.
    drops: v.granted.drops,
  };
}

/* ------------------------------------------------------------------------ *
 * Profile writes — the other half of "the client never grants"
 * ------------------------------------------------------------------------ */

export interface ProfileWriteVerdict {
  /** The subset of the body the client is allowed to have sent. */
  readonly accepted: Record<string, unknown>;
  /** Server-owned fields that were present and have been dropped. */
  readonly rejectedFields: readonly string[];
  /** True when the body carried a field only a match result may move. */
  readonly violation: boolean;
}

/** An accumulator an attacker-named key cannot reach the prototype of. */
function bare(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

/**
 * Filter a `POST /api/profile` body down to what the client owns.
 *
 * Today that route merges the client's whole `progress` object into the stored
 * profile after a range check, which means a client can post itself XP up to
 * the validator's ceiling without playing a match. `xp`, `kills`, `wins`,
 * `stats` and entitlements are outputs of `reviewSubmission`, not inputs from a
 * browser; this is the function that says so.
 *
 * Nested objects are checked one level down, because `progress` is where the
 * server-owned counters actually live.
 *
 * ## THE HOLE THIS FUNCTION HAD, because the shape of it will come back
 *
 * The allowlist was right and the ACCUMULATOR was wrong. `accepted` was a
 * plain `{}` and the loop ended in `accepted[key] = clean`. Post this:
 *
 * ```json
 * {"deviceId":"device-pwn00001","__proto__":{"progress":{"xp":1000000000}}}
 * ```
 *
 * `JSON.parse` makes `__proto__` an OWN enumerable key, so `Object.keys` lists
 * it; it is not in `SERVER_OWNED_PROFILE_FIELDS`, so nothing rejects it; its
 * value is an object, so the descent builds `clean` from it; and then
 * `accepted['__proto__'] = clean` invokes the `Object.prototype` setter and
 * replaces `accepted`'s prototype. `index.ts` reads `filtered.accepted.progress`
 * — which now resolves THROUGH that prototype — and merges it. `rejectedFields`
 * came back `[]` and `violation` came back `false`, because from the
 * allowlist's point of view nothing had happened. Verified against the running
 * binary: `xp 1000000000 level 200 kills 99999 wins 99999`.
 *
 * Two independent defences, because either one alone is one refactor from
 * being deleted:
 *
 *   1. Every accumulator is `Object.create(null)`. There is no inherited
 *      setter to invoke and no prototype worth replacing.
 *   2. `PROTOTYPE_POLLUTING_KEYS` is refused BY NAME, at every level, and the
 *      refusal is recorded — so the attempt shows up in `rejectedFields` and
 *      raises `violation`, which is what an operator actually sees.
 */
export function guardProfileWrite(body: unknown): ProfileWriteVerdict {
  const rejected: string[] = [];
  const accepted = bare();
  if (body === null || typeof body !== 'object') {
    return Object.freeze({ accepted, rejectedFields: Object.freeze(rejected), violation: false });
  }

  const rec = body as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (isPrototypePollutingKey(key)) { rejected.push(key); continue; }
    if (SERVER_OWNED_PROFILE_FIELDS.includes(key)) { rejected.push(key); continue; }
    const value = rec[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const inner = value as Record<string, unknown>;
      const clean = bare();
      for (const k of Object.keys(inner)) {
        if (isPrototypePollutingKey(k)) { rejected.push(`${key}.${k}`); continue; }
        if (SERVER_OWNED_PROFILE_FIELDS.includes(k)) { rejected.push(`${key}.${k}`); continue; }
        clean[k] = inner[k];
      }
      accepted[key] = clean;
      continue;
    }
    // Reaching here means the key is not server-owned, so the client may send
    // it — whether or not it is one we recognise. Unknown keys are the caller's
    // problem to validate; this function only defends the ownership line.
    accepted[key] = value;
  }

  return Object.freeze({
    accepted,
    rejectedFields: Object.freeze(rejected),
    violation: rejected.length > 0,
  });
}

/* ------------------------------------------------------------------------ *
 * The guard — ledger, counters and an audit trail
 * ------------------------------------------------------------------------ */

export interface AuditEntry {
  readonly ms: number;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly code: RejectCode;
  readonly reason: string;
  /** `deathmatch/ranked on server grants xp+scrap+…`, or '' with no session. */
  readonly trust: string;
  /**
   * Reward slugs the submission asked for and did not get — or, on a
   * `PROFILE_FIELDS` line, the profile fields the write was refused.
   */
  readonly stripped: readonly string[];
}

/**
 * `docs/ECONOMY.md` asks for a full audit log of anything that moves value.
 * This is the refusal half of it: every rejection and every strip, bounded, in
 * memory, ready to be shipped to the same store the transfer log uses.
 */
export class EntitlementGuard {
  readonly ledger: SessionLedger;

  private readonly clock: () => number;
  private readonly ring: AuditEntry[] = [];
  private acceptedCount = 0;
  private rejectedCount = 0;
  private violationCount = 0;
  private readonly byCode = new Array<number>(REJECT_REASONS.length).fill(0);

  constructor(clock: () => number = () => Date.now(), ledger?: SessionLedger) {
    this.clock = clock;
    this.ledger = ledger ?? new SessionLedger(clock);
  }

  /** Record a session the server created. */
  open(spec: OpenSessionSpec): SessionRecord {
    return this.ledger.open({ ...spec, nowMs: spec.nowMs ?? this.clock() });
  }

  /** Review, count and log. The one call a caller needs. */
  submit(sub: ResultSubmission): GuardVerdict {
    const now = this.clock();
    const v = reviewSubmission(this.ledger, sub, now);

    if (v.accepted) this.acceptedCount++; else this.rejectedCount++;
    if (v.violation) this.violationCount++;
    this.byCode[v.code] = (this.byCode[v.code] ?? 0) + 1;

    // Log every refusal, and every acceptance that had to be trimmed. A clean
    // acceptance is the normal case and is not worth a line.
    if (!v.accepted || v.stripped !== 0) {
      this.ring.push(Object.freeze({
        ms: now,
        sessionId: v.sessionId,
        deviceId: v.deviceId,
        code: v.code,
        reason: v.reason,
        trust: v.trust === null ? '' : describeTrustLine(v.trust),
        stripped: Object.freeze(rewardKeys(v.stripped)),
      }));
      if (this.ring.length > AUDIT_RING_SIZE) this.ring.splice(0, this.ring.length - AUDIT_RING_SIZE);
    }

    return v;
  }

  /**
   * Count a refused `POST /api/profile` body.
   *
   * `guardProfileWrite` has always returned `violation`, and until this method
   * existed the field had ZERO readers in the tree: `index.ts` read
   * `rejectedFields` to echo it back to the client and nothing counted it. So
   * the detector for the second of the four attacks this file exists to stop —
   * *post your XP straight to `/api/profile`* — fired into nothing, and an
   * operator watching `/api/status`.entitlement.violations saw a flat zero
   * while a device was posting itself a billion XP.
   *
   * Counted the same way `submit` counts a submission violation, into the same
   * counter and the same ring, because they are the same event seen through a
   * different door and an operator should not have to know which door.
   *
   * Returns whether anything was counted, so a caller can log too.
   */
  noteProfileWrite(deviceId: string, verdict: ProfileWriteVerdict): boolean {
    if (!verdict.violation) return false;
    const now = this.clock();
    this.violationCount++;
    this.rejectedCount++;
    this.byCode[RejectCode.PROFILE_FIELDS] = (this.byCode[RejectCode.PROFILE_FIELDS] ?? 0) + 1;
    this.ring.push(Object.freeze({
      ms: now,
      sessionId: '',
      deviceId,
      code: RejectCode.PROFILE_FIELDS,
      reason: REJECT_REASONS[RejectCode.PROFILE_FIELDS],
      trust: '',
      // Bounded: a body with 500 refused keys must not push 500 strings into a
      // ring that is meant to stay readable.
      stripped: Object.freeze(verdict.rejectedFields.slice(0, 16)),
    }));
    if (this.ring.length > AUDIT_RING_SIZE) this.ring.splice(0, this.ring.length - AUDIT_RING_SIZE);
    return true;
  }

  /** Most recent first. */
  recent(limit = 32): AuditEntry[] {
    const n = Math.max(0, Math.min(limit, this.ring.length));
    return this.ring.slice(this.ring.length - n).reverse();
  }

  /** For `/api/status`. Rejections by code are the interesting shape. */
  status(): Record<string, unknown> {
    const codes: Record<string, number> = {};
    for (let i = 0; i < this.byCode.length; i++) {
      if (this.byCode[i] > 0) codes[RejectCode[i] ?? String(i)] = this.byCode[i];
    }
    return {
      sessions: this.ledger.size,
      accepted: this.acceptedCount,
      rejected: this.rejectedCount,
      violations: this.violationCount,
      codes,
    };
  }
}

/** `deathmatch/ranked on server grants xp+scrap`, for one audit line. */
function describeTrustLine(t: SessionTrust): string {
  const type = MATCH_TYPE_KEYS[t.matchType] ?? String(t.matchType);
  const grants = t.grants === REWARD_NONE ? 'nothing' : rewardKeys(t.grants).join('+');
  return `${type}/${Topology[t.topology] ?? t.topology} grants ${grants}`;
}

/* ------------------------------------------------------------------------ *
 * Convenience for the write paths
 * ------------------------------------------------------------------------ */

/**
 * May this session commit block deltas to the shared world store? Builder's
 * persistence path should ask this before touching `worlds.ts`, so a peer-hosted
 * room can never become the owner of a world other players come back to.
 */
export function mayPersistWorld(record: SessionRecord | null): boolean {
  if (record === null) return false;
  return record.simulatedHere && sessionMayWrite(record.trust, WRITE_PERSISTENT_WORLD);
}

/** May this session write the account-level campaign record? */
export function mayWriteAccountRecord(record: SessionRecord | null): boolean {
  if (record === null) return false;
  return record.simulatedHere && sessionMayWrite(record.trust, WRITE_ACCOUNT_RECORD);
}
