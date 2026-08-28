/**
 * DOOMCRAFT — nothing gets paid out of a room we did not run.
 *
 * The headline claim, and the reason this file exists at all:
 *
 * > A reward submitted from a peer-hosted session is rejected server-side.
 *
 * Everything else here is the ways somebody would try to get around that. Each
 * of these is a real attack on a game with tradable items and sponsor-funded
 * prizes, and each one is a single `it(...)` because each one is a single line
 * in the guard:
 *
 *   - claim the session was server-hosted (the guard reads its own ledger)
 *   - submit for a session id we never issued (fail closed)
 *   - post the result over HTTP instead (the client never grants)
 *   - settle for the other three players in your own room (participants)
 *   - send the same honest result twice (one payout per player)
 *   - ask a casual match for ranked rating (stripped, not accepted)
 *   - ask a private match for anything at all (the participation rule)
 *   - post your XP straight to /api/profile (field ownership)
 */

import { describe, expect, it } from 'vitest';
import {
  MatchType,
  REWARD_ITEM_DROP,
  REWARD_RANKED_RATING,
  REWARD_SPONSOR_PRIZE,
  SessionOrigin,
  Topology,
  rewardKeys,
} from '@doomcraft/shared/trust';
import { ModeId } from '@doomcraft/shared/modes';

import type { ChallengeDef } from '@doomcraft/shared/challenges';

import {
  EntitlementGuard,
  MAX_CHALLENGE_IDS,
  MAX_XP_PER_MATCH,
  RejectCode,
  SessionLedger,
  SubmitterKind,
  emptyStats,
  guardProfileWrite,
  mayPersistWorld,
  reviewSubmission,
  toMatchResult,
  type ResultSubmission,
} from './entitlementGuard.js';

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

const DEVICE = 'device-abcdef12';
const OTHER = 'device-99887766';

/** A generous submission: asks for one of everything. */
function richSubmission(sessionId: string, deviceId = DEVICE): ResultSubmission {
  return {
    sessionId,
    deviceId,
    submittedBy: SubmitterKind.ROOM_SIM,
    xp: 250,
    scrap: 90,
    drops: ['skin.slug-shotgun'],
    ratingDelta: 24,
    competitionPoints: 500,
    leaderboard: true,
    shareCard: true,
    challengeIds: ['daily.kill-40'],
    stats: { ...emptyStats(), kills: 12, deaths: 4, seconds: 600, won: true },
    worldDeltaCount: 30,
  };
}

interface Fixture {
  guard: EntitlementGuard;
  sessionId: string;
}

/** Open a session the way the server would, and put `DEVICE` in it. */
function openWith(
  modeId: ModeId, origin: SessionOrigin, intent: MatchType, devices: string[] = [DEVICE],
  challenges?: readonly ChallengeDef[],
): Fixture {
  const guard = new EntitlementGuard(() => 1_000);
  const sessionId = `s-${modeId}-${origin}-${intent}`;
  guard.open({ sessionId, modeId, origin, serverIntent: intent, challenges });
  for (const d of devices) guard.ledger.addParticipant(sessionId, d);
  return { guard, sessionId };
}

/** Hand-built defs for the evaluation tests — the parser is tested in shared. */
function challengeDef(over: Partial<ChallengeDef> = {}): ChallengeDef {
  return {
    id: 'daily.kill-5', name: 'Five', blurb: 'Take down five.',
    period: 'daily', stat: 'kills', target: 5, scrap: 40, item: null, ...over,
  };
}

/* ------------------------------------------------------------------------ *
 * 1. THE CLAIM
 * ------------------------------------------------------------------------ */

describe('a reward submitted from a peer-hosted session', () => {
  it('is rejected, and grants literally nothing', () => {
    const { guard, sessionId } = openWith(ModeId.HORDE, SessionOrigin.PEER_HOST, MatchType.PRIVATE);

    const v = guard.submit(richSubmission(sessionId));

    expect(v.accepted).toBe(false);
    expect(v.code).toBe(RejectCode.PEER_HOSTED);
    expect(v.reason).toMatch(/peer-hosted/);
    expect(v.granted.xp).toBe(0);
    expect(v.granted.scrap).toBe(0);
    expect(v.granted.drops).toEqual([]);
    expect(v.granted.ratingDelta).toBe(0);
    expect(v.granted.competitionPoints).toBe(0);
    expect(v.granted.leaderboard).toBe(false);
    expect(v.granted.shareCard).toBe(false);
    expect(v.granted.challengeIds).toEqual([]);
    expect(v.granted.stats).toBeNull();
    expect(v.granted.worldDeltaCount).toBe(0);
    // And nothing can be folded into a profile from it.
    expect(toMatchResult(v)).toBeNull();
  });

  it('is rejected even when the submission insists it was server-hosted', () => {
    const { guard, sessionId } = openWith(ModeId.QUEST, SessionOrigin.PEER_HOST, MatchType.PRIVATE);

    const v = guard.submit({
      ...richSubmission(sessionId),
      claimedTopology: Topology.SERVER_AUTHORITATIVE,
      claimedMatchType: MatchType.RANKED,
    });

    expect(v.accepted).toBe(false);
    expect(v.code).toBe(RejectCode.PEER_HOSTED);
    // The lie is recorded, not corrected.
    expect(v.violation).toBe(true);
    expect(v.trust?.topology).toBe(Topology.PEER_HOSTED);
    expect(v.trust?.matchType).toBe(MatchType.PRIVATE);
  });

  it('is rejected for a session that ran in the player\'s own Worker', () => {
    const { guard, sessionId } = openWith(ModeId.QUEST, SessionOrigin.CLIENT_WORKER, MatchType.SOLO);
    const v = guard.submit(richSubmission(sessionId));
    expect(v.accepted).toBe(false);
    expect(v.code).toBe(RejectCode.CLIENT_LOCAL);
    expect(v.granted.xp).toBe(0);
  });

  it('cannot write a persistent world either', () => {
    const { guard, sessionId } = openWith(ModeId.BUILDER, SessionOrigin.PEER_HOST, MatchType.PRIVATE);
    expect(mayPersistWorld(guard.ledger.get(sessionId))).toBe(false);
    expect(guard.submit(richSubmission(sessionId)).granted.worldDeltaCount).toBe(0);
  });

  it('is still rejected after the same room is re-created as a server room', () => {
    // The row's zeroes are a property of the row, not of the run: moving a peer
    // row onto our own hardware must not quietly switch rewards on.
    const { guard, sessionId } = openWith(ModeId.HORDE, SessionOrigin.SERVER_INVITE, MatchType.PRIVATE);
    const v = guard.submit(richSubmission(sessionId));
    expect(v.accepted).toBe(false);
    expect(v.code).toBe(RejectCode.GRANTS_NOTHING);
    expect(v.trust?.topology).toBe(Topology.SERVER_AUTHORITATIVE);
    expect(v.granted.xp).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * 1b. Evaluation in the guard — the challenge half of step 8 (Studio S4)
 * ------------------------------------------------------------------------ */

describe('challenge evaluation against the session\'s recorded defs', () => {
  const KILLS = challengeDef();
  const WINS = challengeDef({ id: 'daily.win-1', stat: 'wins', target: 1, scrap: 30 });

  it('passes a verified claim through, drops a forged or unearned one, and says so in clamped', () => {
    const { guard, sessionId } = openWith(
      ModeId.DEATHMATCH, SessionOrigin.SERVER_MATCHMAKER, MatchType.PUBLIC, [DEVICE], [KILLS, WINS],
    );
    // kills: 12 contributes to KILLS; won: false means WINS is unearned;
    // 'daily.ghost' names no def at all. The submission asks ONLY for what
    // the casual row grants, so any violation could only come from the
    // challenge path — which must clamp, never accuse.
    const v = guard.submit({
      sessionId,
      deviceId: DEVICE,
      submittedBy: SubmitterKind.ROOM_SIM,
      xp: 250,
      scrap: 90,
      stats: { ...emptyStats(), kills: 12, seconds: 600, won: false },
      challengeIds: ['daily.kill-5', 'daily.win-1', 'daily.ghost'],
    });
    expect(v.accepted).toBe(true);
    expect(v.granted.challengeIds).toEqual(['daily.kill-5']);
    expect(v.clamped).toContain('challengeIds');
    // Dropping is a clamp, not a violation: ROOM_SIM is the only admissible
    // submitter, so a bad id is an ours-bug, not an attack.
    expect(v.violation).toBe(false);
  });

  it('a session opened with no defs grants no challenge ids at all', () => {
    const { guard, sessionId } = openWith(
      ModeId.DEATHMATCH, SessionOrigin.SERVER_MATCHMAKER, MatchType.PUBLIC,
    );
    const v = guard.submit(richSubmission(sessionId));
    expect(v.accepted).toBe(true);
    expect(v.granted.challengeIds).toEqual([]);
  });

  it('caps the claimed list at MAX_CHALLENGE_IDS', () => {
    const many = Array.from({ length: MAX_CHALLENGE_IDS + 1 }, (_, i) =>
      challengeDef({ id: `daily.c-${i}`, target: 1 }));
    const { guard, sessionId } = openWith(
      ModeId.DEATHMATCH, SessionOrigin.SERVER_MATCHMAKER, MatchType.PUBLIC, [DEVICE], many,
    );
    const v = guard.submit({
      ...richSubmission(sessionId),
      stats: { ...emptyStats(), kills: 12, seconds: 600, won: true },
      challengeIds: many.map((d) => d.id),
    });
    expect(v.granted.challengeIds.length).toBe(MAX_CHALLENGE_IDS);
    expect(v.clamped).toContain('challengeIds');
  });

  it('toMatchResult carries the ids and the payment gates: Deathmatch pays, Builder owes', () => {
    const dm = openWith(
      ModeId.DEATHMATCH, SessionOrigin.SERVER_MATCHMAKER, MatchType.PUBLIC, [DEVICE], [KILLS],
    );
    const paid = toMatchResult(dm.guard.submit({
      ...richSubmission(dm.sessionId),
      challengeIds: ['daily.kill-5'],
    }));
    expect(paid?.challengeIds).toEqual(['daily.kill-5']);
    expect(paid?.mayPayChallenges).toBe(true);
    expect(paid?.mayGrantChallengeItems).toBe(true);

    /* Public Builder grants REWARD_CHALLENGE but deliberately not Scrap or
     * drops — progress banks, payment waits for a session that can pay. */
    const blocks = challengeDef({ id: 'daily.blocks-40', stat: 'blocksPlaced', target: 40, scrap: 25 });
    const b = openWith(
      ModeId.BUILDER, SessionOrigin.SERVER_MATCHMAKER, MatchType.PUBLIC, [DEVICE], [blocks],
    );
    const owed = toMatchResult(b.guard.submit({
      ...richSubmission(b.sessionId),
      stats: { ...emptyStats(), blocksPlaced: 64, seconds: 600 },
      challengeIds: ['daily.blocks-40'],
    }));
    expect(owed?.challengeIds).toEqual(['daily.blocks-40']);
    expect(owed?.mayPayChallenges).toBe(false);
    expect(owed?.mayGrantChallengeItems).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * 2. The trusted path still works
 * ------------------------------------------------------------------------ */

describe('a matchmade session on our own hardware', () => {
  it('pays what its row allows', () => {
    const { guard, sessionId } = openWith(
      ModeId.DEATHMATCH, SessionOrigin.SERVER_MATCHMAKER, MatchType.PUBLIC,
    );
    const v = guard.submit(richSubmission(sessionId));

    expect(v.accepted).toBe(true);
    expect(v.code).toBe(RejectCode.OK);
    expect(v.granted.xp).toBe(250);
    expect(v.granted.scrap).toBe(90);
    expect(v.granted.drops).toEqual(['skin.slug-shotgun']);
    expect(v.granted.shareCard).toBe(true);
    expect(v.granted.stats?.kills).toBe(12);

    const result = toMatchResult(v);
    expect(result).not.toBeNull();
    expect(result?.xp).toBe(250);
    expect(result?.kills).toBe(12);
    expect(result?.won).toBe(true);
  });

  it('strips the rewards its row does not carry, and keeps the rest', () => {
    const { guard, sessionId } = openWith(
      ModeId.DEATHMATCH, SessionOrigin.SERVER_MATCHMAKER, MatchType.PUBLIC,
    );
    const v = guard.submit(richSubmission(sessionId));

    // A casual queue moves no rating, awards no standing, funds no prize and
    // does not put anybody on a public board.
    expect(v.granted.ratingDelta).toBe(0);
    expect(v.granted.competitionPoints).toBe(0);
    expect(v.granted.leaderboard).toBe(false);
    expect(rewardKeys(v.stripped).sort())
      .toEqual(['competition', 'leaderboard', 'prize', 'rating']);
    expect(v.accepted).toBe(true);
    expect(v.violation).toBe(true);
  });

  it('moves rating only in the ranked queue', () => {
    const { guard, sessionId } = openWith(
      ModeId.DEATHMATCH, SessionOrigin.SERVER_MATCHMAKER, MatchType.RANKED,
    );
    const v = guard.submit(richSubmission(sessionId));
    expect(v.granted.ratingDelta).toBe(24);
    expect(v.granted.competitionPoints).toBe(0);
    expect(v.stripped & REWARD_RANKED_RATING).toBe(0);
    expect(v.stripped & REWARD_SPONSOR_PRIZE).not.toBe(0);
  });

  it('funds a prize only in a scheduled event', () => {
    const { guard, sessionId } = openWith(
      ModeId.DEATHMATCH, SessionOrigin.SERVER_EVENT, MatchType.COMPETITION,
    );
    const v = guard.submit(richSubmission(sessionId));
    expect(v.granted.competitionPoints).toBe(500);
    expect(v.stripped).toBe(0);
  });

  it('will not let the matchmaker open a tournament by itself', () => {
    const { guard, sessionId } = openWith(
      ModeId.DEATHMATCH, SessionOrigin.SERVER_MATCHMAKER, MatchType.COMPETITION,
    );
    expect(guard.ledger.get(sessionId)?.trust.matchType).toBe(MatchType.PUBLIC);
    expect(guard.submit(richSubmission(sessionId)).granted.competitionPoints).toBe(0);
  });

  it('refuses item drops from a creative Builder world', () => {
    const { guard, sessionId } = openWith(
      ModeId.BUILDER, SessionOrigin.SERVER_MATCHMAKER, MatchType.PUBLIC,
    );
    const v = guard.submit(richSubmission(sessionId));
    expect(v.accepted).toBe(true);
    expect(v.granted.drops).toEqual([]);
    expect(v.granted.scrap).toBe(0);
    expect(v.stripped & REWARD_ITEM_DROP).not.toBe(0);
    // The world itself is still saved: that is a write, not a reward.
    expect(mayPersistWorld(guard.ledger.get(sessionId))).toBe(true);
    expect(v.granted.worldDeltaCount).toBe(30);
  });
});

/* ------------------------------------------------------------------------ *
 * 3. Fail closed
 * ------------------------------------------------------------------------ */

describe('the guard fails closed', () => {
  it('refuses a session id it never issued', () => {
    const guard = new EntitlementGuard(() => 1_000);
    const v = guard.submit(richSubmission('s-forged'));
    expect(v.accepted).toBe(false);
    expect(v.code).toBe(RejectCode.NO_SESSION);
    expect(v.violation).toBe(true);
    expect(v.trust).toBeNull();
  });

  it('refuses a result that arrived over the wire rather than from the room', () => {
    const { guard, sessionId } = openWith(
      ModeId.DEATHMATCH, SessionOrigin.SERVER_MATCHMAKER, MatchType.RANKED,
    );
    const v = guard.submit({ ...richSubmission(sessionId), submittedBy: SubmitterKind.CLIENT_REPORT });
    expect(v.accepted).toBe(false);
    expect(v.code).toBe(RejectCode.CLIENT_REPORTED);
    expect(v.granted.xp).toBe(0);
  });

  it('refuses a device the server never saw in the match', () => {
    const { guard, sessionId } = openWith(
      ModeId.DEATHMATCH, SessionOrigin.SERVER_MATCHMAKER, MatchType.RANKED,
    );
    const v = guard.submit(richSubmission(sessionId, OTHER));
    expect(v.accepted).toBe(false);
    expect(v.code).toBe(RejectCode.NOT_A_PARTICIPANT);
  });

  it('pays each player once per session', () => {
    const { guard, sessionId } = openWith(
      ModeId.HORDE, SessionOrigin.SERVER_MATCHMAKER, MatchType.PUBLIC,
    );
    expect(guard.submit(richSubmission(sessionId)).accepted).toBe(true);
    const second = guard.submit(richSubmission(sessionId));
    expect(second.accepted).toBe(false);
    expect(second.code).toBe(RejectCode.ALREADY_SETTLED);
  });

  it('refuses a result that arrives after the session closed', () => {
    let now = 1_000;
    const guard = new EntitlementGuard(() => now);
    const sessionId = 's-late';
    guard.open({ sessionId, modeId: ModeId.HORDE, origin: SessionOrigin.SERVER_MATCHMAKER, serverIntent: MatchType.PUBLIC });
    guard.ledger.addParticipant(sessionId, DEVICE);
    guard.ledger.close(sessionId, 2_000);
    now = 3_000;
    const v = guard.submit(richSubmission(sessionId));
    expect(v.accepted).toBe(false);
    expect(v.code).toBe(RejectCode.SESSION_CLOSED);
  });

  it('refuses a submission with no session or no device', () => {
    const guard = new EntitlementGuard(() => 1_000);
    expect(guard.submit({ ...richSubmission(''), sessionId: '' }).code).toBe(RejectCode.MALFORMED);
    expect(guard.submit({ ...richSubmission('s'), deviceId: '' }).code).toBe(RejectCode.MALFORMED);
  });

  it('clamps a room that has gone wrong rather than paying it out', () => {
    const { guard, sessionId } = openWith(
      ModeId.HORDE, SessionOrigin.SERVER_MATCHMAKER, MatchType.PUBLIC,
    );
    const v = guard.submit({ ...richSubmission(sessionId), xp: 1e9, drops: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(v.accepted).toBe(true);
    expect(v.granted.xp).toBe(MAX_XP_PER_MATCH);
    expect(v.granted.drops).toHaveLength(4);
    expect(v.clamped).toContain('xp');
    expect(v.clamped).toContain('drops');
  });

  it('will not be paid by a NaN', () => {
    const { guard, sessionId } = openWith(
      ModeId.HORDE, SessionOrigin.SERVER_MATCHMAKER, MatchType.PUBLIC,
    );
    const v = guard.submit({ ...richSubmission(sessionId), xp: NaN, scrap: Infinity });
    expect(v.granted.xp).toBe(0);
    expect(v.granted.scrap).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * 4. The audit trail
 * ------------------------------------------------------------------------ */

describe('the audit trail', () => {
  it('records every refusal with the reason and the session it was for', () => {
    const { guard, sessionId } = openWith(ModeId.HORDE, SessionOrigin.PEER_HOST, MatchType.PRIVATE);
    guard.submit(richSubmission(sessionId));
    guard.submit(richSubmission('s-forged'));

    const log = guard.recent();
    expect(log).toHaveLength(2);
    expect(log[0].code).toBe(RejectCode.NO_SESSION);
    expect(log[1].code).toBe(RejectCode.PEER_HOSTED);
    expect(log[1].trust).toMatch(/private/);
    expect(log[1].trust).toMatch(/grants nothing/);

    const status = guard.status();
    expect(status.rejected).toBe(2);
    expect(status.accepted).toBe(0);
    expect(status.violations).toBe(2);
  });

  it('logs a trimmed acceptance but not a clean one', () => {
    const casual = openWith(ModeId.HORDE, SessionOrigin.SERVER_MATCHMAKER, MatchType.PUBLIC);
    casual.guard.submit({
      sessionId: casual.sessionId, deviceId: DEVICE, submittedBy: SubmitterKind.ROOM_SIM, xp: 10,
    });
    expect(casual.guard.recent()).toHaveLength(0);

    casual.guard.ledger.addParticipant(casual.sessionId, OTHER);
    casual.guard.submit({
      sessionId: casual.sessionId, deviceId: OTHER, submittedBy: SubmitterKind.ROOM_SIM,
      xp: 10, ratingDelta: 50,
    });
    const log = casual.guard.recent();
    expect(log).toHaveLength(1);
    expect(log[0].stripped).toContain('rating');
  });
});

/* ------------------------------------------------------------------------ *
 * 5. The ledger
 * ------------------------------------------------------------------------ */

describe('the session ledger', () => {
  it('derives the topology from how the session was made, not from a request', () => {
    const ledger = new SessionLedger(() => 0);
    const peer = ledger.open({
      sessionId: 'a', modeId: ModeId.QUEST, origin: SessionOrigin.PEER_HOST,
      serverIntent: MatchType.COMPETITION,
    });
    expect(peer.trust.topology).toBe(Topology.PEER_HOSTED);
    expect(peer.trust.matchType).toBe(MatchType.PRIVATE);
    expect(peer.simulatedHere).toBe(false);
  });

  it('will not add a participant to a closed session', () => {
    const ledger = new SessionLedger(() => 0);
    ledger.open({
      sessionId: 'a', modeId: ModeId.HORDE, origin: SessionOrigin.SERVER_MATCHMAKER,
      serverIntent: MatchType.PUBLIC,
    });
    expect(ledger.addParticipant('a', DEVICE)).toBe(true);
    ledger.close('a', 10);
    expect(ledger.addParticipant('a', OTHER)).toBe(false);
    expect(ledger.addParticipant('nope', DEVICE)).toBe(false);
  });

  it('sweeps old sessions out', () => {
    const ledger = new SessionLedger(() => 0);
    ledger.open({
      sessionId: 'a', modeId: ModeId.HORDE, origin: SessionOrigin.SERVER_MATCHMAKER,
      serverIntent: MatchType.PUBLIC, nowMs: 0,
    });
    expect(ledger.sweep(1_000, 500)).toBe(0);
    expect(ledger.sweep(1_000, 5_000)).toBe(1);
    expect(ledger.size).toBe(0);
  });

  it('is what reviewSubmission reads, with no guard wrapper in the way', () => {
    const ledger = new SessionLedger(() => 0);
    ledger.open({
      sessionId: 'a', modeId: ModeId.QUEST, origin: SessionOrigin.PEER_HOST,
      serverIntent: MatchType.PRIVATE,
    });
    ledger.addParticipant('a', DEVICE);
    const v = reviewSubmission(ledger, richSubmission('a'), 1);
    expect(v.accepted).toBe(false);
    expect(v.code).toBe(RejectCode.PEER_HOSTED);
  });
});

/* ------------------------------------------------------------------------ *
 * 6. Profile writes — the other client-grants hole
 * ------------------------------------------------------------------------ */

describe('guardProfileWrite', () => {
  it('drops the fields only a match result may move', () => {
    const v = guardProfileWrite({
      deviceId: DEVICE,
      settings: { fov: 90 },
      progress: { name: 'Marine', skin: 3, xp: 999_999_999, kills: 10_000, level: 200 },
      entitlements: { adsRemoved: true },
    });

    expect(v.violation).toBe(true);
    expect(v.rejectedFields).toContain('entitlements');
    expect(v.rejectedFields).toContain('progress.xp');
    expect(v.rejectedFields).toContain('progress.kills');
    expect(v.rejectedFields).toContain('progress.level');

    const progress = v.accepted.progress as Record<string, unknown>;
    expect(progress.name).toBe('Marine');
    expect(progress.skin).toBe(3);
    expect('xp' in progress).toBe(false);
    expect((v.accepted.settings as Record<string, unknown>).fov).toBe(90);
  });

  it('lets an honest client save its own preferences with no complaint', () => {
    const v = guardProfileWrite({
      deviceId: DEVICE,
      settings: { fov: 90 },
      bindings: { forward: 'KeyW' },
      loadout: { primary: 2 },
      progress: { name: 'Marine' },
    });
    expect(v.violation).toBe(false);
    expect(v.rejectedFields).toEqual([]);
  });

  it('is not fooled by a non-object body', () => {
    expect(guardProfileWrite(null).violation).toBe(false);
    expect(guardProfileWrite('xp=999').accepted).toEqual({});
  });

  /* ---------------------------------------------------------------------- *
   * The spelling that walked straight past all of the above
   * ---------------------------------------------------------------------- */

  it('refuses __proto__, which is an OWN key after JSON.parse', () => {
    // Built by parsing, not by an object literal: a literal `__proto__:` in
    // source sets the prototype at construction time and never becomes an own
    // key, so a test written the obvious way tests nothing at all. This is the
    // exact body that paid a device a billion XP against the live binary.
    const body = JSON.parse(
      '{"deviceId":"device-pwn00001","__proto__":{"progress":{"xp":1000000000,"level":200,"kills":99999}}}',
    ) as unknown;

    const v = guardProfileWrite(body);

    // Named, not silently dropped — and it raises `violation`, which is what
    // an operator sees.
    expect(v.rejectedFields).toContain('__proto__');
    expect(v.violation).toBe(true);

    // THE ASSERTION THAT MATTERS. `index.ts` reads `filtered.accepted.progress`
    // and merges it. Before the fix that read resolved through a prototype the
    // attacker had just installed, so it was an object full of counters.
    expect(v.accepted.progress).toBeUndefined();
    expect(Object.getPrototypeOf(v.accepted)).toBeNull();
    expect(({} as Record<string, unknown>).progress).toBeUndefined();
  });

  it('refuses the same trick one level down, and by its other two names', () => {
    // Checking only the top level moves the hole one line deeper.
    const nested = JSON.parse(
      '{"deviceId":"device-pwn00001","progress":{"name":"Marine","__proto__":{"xp":777},"constructor":{"x":1},"prototype":{"y":2}}}',
    ) as unknown;

    const v = guardProfileWrite(nested);
    expect(v.rejectedFields).toContain('progress.__proto__');
    expect(v.rejectedFields).toContain('progress.constructor');
    expect(v.rejectedFields).toContain('progress.prototype');
    expect(v.violation).toBe(true);

    const progress = v.accepted.progress as Record<string, unknown>;
    expect(progress.name).toBe('Marine');
    expect(progress.xp).toBeUndefined();
    expect(Object.getPrototypeOf(progress)).toBeNull();

    // And nothing global was harmed on the way through.
    expect(({} as Record<string, unknown>).xp).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------ *
 * 7. The violation the guard was not counting
 * ------------------------------------------------------------------------ */

describe('a refused profile write reaches the counters', () => {
  it('counts as a violation and lands in the audit ring', () => {
    // `guardProfileWrite` has always returned `violation`. Until `index.ts`
    // read it, the field had zero readers in the entire tree — so the detector
    // for "post your XP straight to /api/profile" was wired to nothing and an
    // operator watching `violations` saw a flat zero through the attack.
    const guard = new EntitlementGuard(() => 1_000);
    expect(guard.status().violations).toBe(0);

    const clean = guardProfileWrite({ deviceId: DEVICE, progress: { name: 'Marine' } });
    expect(guard.noteProfileWrite(DEVICE, clean)).toBe(false);
    expect(guard.status().violations).toBe(0);
    expect(guard.recent()).toEqual([]);

    const attack = guardProfileWrite({ deviceId: DEVICE, progress: { xp: 999_999 } });
    expect(guard.noteProfileWrite(DEVICE, attack)).toBe(true);

    const status = guard.status();
    expect(status.violations).toBe(1);
    expect((status.codes as Record<string, number>).PROFILE_FIELDS).toBe(1);

    const [line] = guard.recent();
    expect(line.code).toBe(RejectCode.PROFILE_FIELDS);
    expect(line.deviceId).toBe(DEVICE);
    expect(line.stripped).toContain('progress.xp');
  });

  it('bounds what one hostile body can push into the ring', () => {
    const guard = new EntitlementGuard(() => 1_000);
    const progress: Record<string, unknown> = {};
    // Every server-owned name at once, so the refusal list is long.
    for (const k of ['xp', 'level', 'kills', 'deaths', 'wins', 'gamesPlayed',
      'bestKillstreak', 'blocksPlaced', 'blocksBroken', 'secondsPlayed',
      'favouriteWeapon', 'adsRemoved', 'rating', 'trophies', 'titles', 'items',
      'drops', 'scrap']) progress[k] = 1;
    guard.noteProfileWrite(DEVICE, guardProfileWrite({ deviceId: DEVICE, progress }));
    expect(guard.recent()[0].stripped.length).toBe(16);
  });
});
