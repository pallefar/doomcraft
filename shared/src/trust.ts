/**
 * DOOMCRAFT — the trust boundary.
 *
 * One table (`TRUST_TABLE`) answers, for every (mode, match type) pair, three
 * questions and nothing else:
 *
 *   1. **Who simulated it?** `topology` — our server, another player's browser,
 *      or this player's own Web Worker.
 *   2. **May it pay out?** `grants` — a bitmask of REWARD_* kinds. Anything that
 *      touches the economy (XP, Scrap, item drops, ranked rating, competition
 *      standing, sponsor prizes, lifetime stats, share cards) is in this mask.
 *   3. **May it write durable shared state?** `writes` — persistent Builder
 *      worlds, and the device's own local record.
 *
 * `docs/ECONOMY.md` decision 1 is the whole reason this file exists:
 *
 * > **The server grants every reward. The client never does.**
 *
 * A host-authoritative peer runs `server/src/sim.ts` in readable JavaScript on
 * hardware the player owns. Every anti-cheat guard in the tree — the input dt
 * clamp at `net.ts:449`, the `INPUT_TIME_SCALE` time bank at `net.ts:605`, the
 * `OUT_OF_REACH` edit check at `net.ts:490`, the lag-compensated rewind at
 * `sim.ts:1037` — protects a room from its *clients*. Not one of them protects
 * anybody from the room's *owner*. A peer host can fabricate kills, wave counts,
 * drops, match duration and match results at will. So a peer-hosted match pays
 * out nothing, ever, and that is enforced here rather than remembered.
 *
 * ## Two independent reasons a match grants nothing
 *
 * **1. Untrusted simulation.** A peer or a local Worker computed the result. We
 *    have no way to tell a real match from a fabricated one.
 * **2. Uncontrolled participation.** An invite-only lobby lets four friends
 *    stand still and farm each other. The sim can be perfectly honest and the
 *    result still be worthless.
 *
 * A row must clear **both** before it may grant anything. That is why every
 * SOLO and PRIVATE row grants nothing even when we host it ourselves, and it is
 * the same rule every shipped competitive game applies to private lobbies.
 *
 * ## `topology` is a ceiling, not a description
 *
 * `TrustPolicy.topology` is the **weakest** trust the row is permitted to run
 * at. A row marked `PEER_HOSTED` may also be run on our own servers — for
 * reliability, or because no peer was eligible to host — and doing so changes
 * *nothing* about what it grants. Rewards are a property of the row, not of the
 * run. Turning rewards on for a mode therefore requires editing this file, and
 * `validateTrustTable` will refuse the edit unless the topology moves too.
 *
 * The actual topology of a live session is recorded separately by the server
 * (see `sealSessionTrust`), and it can only ever *reduce* what a row grants.
 *
 * ## Nothing else may decide this
 *
 * No other file may branch on "is this Horde?" to decide whether a match counts.
 * `server/src/entitlementGuard.ts` enforces the table and `client/src/ui/
 * matchType.ts` displays it; neither contains a single `ModeId` literal, and
 * `trust.test.ts` scans the tree to keep it that way.
 *
 * Nothing here imports the DOM, `three`, `ws` or `node:*`. It runs on the main
 * thread, in a Worker and in Node unchanged.
 */

import { MAX_PLAYERS } from './constants.ts';
import {
  MODES,
  MODE_KEYS,
  ModeId,
  PvpPolicy,
  WorldSource,
  getMode,
  isModeId,
} from './modes.ts';

/* ------------------------------------------------------------------------ *
 * Match type
 * ------------------------------------------------------------------------ */

/**
 * How a match came to exist and who could get into it. Orthogonal to `ModeId`:
 * Horde has a solo run, a private co-op game and a public matchmade game, and
 * they are three different trust situations played on the same rules.
 */
export enum MatchType {
  /** One human, on their own device. No matchmaking, no invite. */
  SOLO = 0,
  /** Invite-only. Friends, a room code, a share link. */
  PRIVATE = 1,
  /** Matchmade casual on our servers. Anyone may be placed in it. */
  PUBLIC = 2,
  /** Matchmade competitive on our servers. Carries rating. */
  RANKED = 3,
  /** A scheduled tournament or sponsor event on our servers. */
  COMPETITION = 4,
}
export const MATCH_TYPE_COUNT = 5;

/** Stable slug per match type. Room keys, telemetry and logs use this. */
export const MATCH_TYPE_KEYS: readonly string[] = Object.freeze([
  'solo', 'private', 'public', 'ranked', 'competition',
]);

/** Menu-facing name. */
export const MATCH_TYPE_NAMES: readonly string[] = Object.freeze([
  'Solo', 'Private', 'Public', 'Ranked', 'Competition',
]);

export function isMatchType(v: number): v is MatchType {
  return Number.isInteger(v) && v >= 0 && v < MATCH_TYPE_COUNT;
}
export function matchTypeFromKey(key: string): MatchType | -1 {
  const i = MATCH_TYPE_KEYS.indexOf(key.toLowerCase());
  return i < 0 ? -1 : (i as MatchType);
}

/**
 * True when the server chose who is in this match. SOLO and PRIVATE are not
 * participation-controlled: the player picked their own opponents, so results
 * are farmable even when the simulation is perfectly honest.
 */
export function isParticipationControlled(matchType: MatchType): boolean {
  return matchType === MatchType.PUBLIC
    || matchType === MatchType.RANKED
    || matchType === MatchType.COMPETITION;
}

/* ------------------------------------------------------------------------ *
 * Topology
 * ------------------------------------------------------------------------ */

/** Where the authoritative simulation for a session actually ran. */
export enum Topology {
  /** A room on hardware we control. The only trusted answer. */
  SERVER_AUTHORITATIVE = 0,
  /** Another player's browser, over a WebRTC DataChannel. Untrusted. */
  PEER_HOSTED = 1,
  /** This player's own Web Worker (`client/src/net/localServer.ts`). Untrusted. */
  CLIENT_LOCAL = 2,
}
export const TOPOLOGY_COUNT = 3;

export const TOPOLOGY_KEYS: readonly string[] = Object.freeze([
  'server', 'peer', 'local',
]);

/** Menu-facing name. Shown to the player, so it says who is running the match. */
export const TOPOLOGY_NAMES: readonly string[] = Object.freeze([
  'Server-hosted', 'Peer-hosted', 'On your device',
]);

export function isTopology(v: number): v is Topology {
  return Number.isInteger(v) && v >= 0 && v < TOPOLOGY_COUNT;
}

/** The single predicate the rest of the codebase should ask. */
export function isTrustedTopology(t: Topology): boolean {
  return t === Topology.SERVER_AUTHORITATIVE;
}

/* ------------------------------------------------------------------------ *
 * Session origin — how the server knows, without asking the client
 * ------------------------------------------------------------------------ */

/**
 * How a session was created. This is the fact the trust decision is made from,
 * because it is the one fact the client cannot supply: the server either
 * created the room or it did not.
 */
export enum SessionOrigin {
  /** `createLocalServer()` in the player's own tab. */
  CLIENT_WORKER = 0,
  /** A DataChannel to another player's browser. Signalling saw it; we did not run it. */
  PEER_HOST = 1,
  /** Our server, invite-only room (room code / share link). */
  SERVER_INVITE = 2,
  /** Our server, created by the matchmaker. */
  SERVER_MATCHMAKER = 3,
  /** Our server, created by the tournament scheduler. */
  SERVER_EVENT = 4,
}
export const SESSION_ORIGIN_COUNT = 5;

export const SESSION_ORIGIN_KEYS: readonly string[] = Object.freeze([
  'client-worker', 'peer-host', 'server-invite', 'server-matchmaker', 'server-event',
]);

export function isSessionOrigin(v: number): v is SessionOrigin {
  return Number.isInteger(v) && v >= 0 && v < SESSION_ORIGIN_COUNT;
}

/** The topology an origin implies. There is no other way to get a topology. */
export function topologyForOrigin(origin: SessionOrigin): Topology {
  switch (origin) {
    case SessionOrigin.CLIENT_WORKER: return Topology.CLIENT_LOCAL;
    case SessionOrigin.PEER_HOST: return Topology.PEER_HOSTED;
    case SessionOrigin.SERVER_INVITE:
    case SessionOrigin.SERVER_MATCHMAKER:
    case SessionOrigin.SERVER_EVENT: return Topology.SERVER_AUTHORITATIVE;
    // An origin we do not recognise is not one we ran. Fail closed.
    default: return Topology.PEER_HOSTED;
  }
}

/**
 * The match type a session may claim, given how it was created.
 *
 * `serverIntent` is the match type the matchmaker or the tournament scheduler
 * asked for. It is a **server-side fact** and must never be read off a packet —
 * a client that can name its own match type can name itself into Ranked.
 *
 * The origin then clamps it: a peer-hosted room is PRIVATE whatever anyone
 * intended, and a Worker in the player's own tab is SOLO.
 */
export function resolveMatchType(origin: SessionOrigin, serverIntent: MatchType): MatchType {
  const intent = isMatchType(serverIntent) ? serverIntent : MatchType.SOLO;
  switch (origin) {
    case SessionOrigin.CLIENT_WORKER:
      return MatchType.SOLO;
    case SessionOrigin.PEER_HOST:
      return MatchType.PRIVATE;
    case SessionOrigin.SERVER_INVITE:
      // An invite room is invite-only by definition, however it was requested.
      return intent === MatchType.SOLO ? MatchType.SOLO : MatchType.PRIVATE;
    case SessionOrigin.SERVER_MATCHMAKER:
      // The matchmaker cannot open a tournament; only the scheduler can.
      return intent === MatchType.COMPETITION ? MatchType.PUBLIC : intent;
    case SessionOrigin.SERVER_EVENT:
      return intent;
    default:
      return MatchType.SOLO;
  }
}

/* ------------------------------------------------------------------------ *
 * Reward kinds — everything that touches value
 * ------------------------------------------------------------------------ */

/** Account level. Monotonic, never spent, gates unlocks. `docs/ECONOMY.md`. */
export const REWARD_XP = 1 << 0;
/** The spendable currency. */
export const REWARD_SCRAP = 1 << 1;
/** Tradable items: weapon variants, skins, emblems, trails. */
export const REWARD_ITEM_DROP = 1 << 2;
/** Ranked rating / ladder position. */
export const REWARD_RANKED_RATING = 1 << 3;
/** Standing in a tournament or a season ladder. */
export const REWARD_COMPETITION = 1 << 4;
/** A sponsor-funded prize, including real money. */
export const REWARD_SPONSOR_PRIZE = 1 << 5;
/** A public leaderboard entry. */
export const REWARD_LEADERBOARD = 1 << 6;
/** Daily / weekly challenge progress, which pays Scrap and drops. */
export const REWARD_CHALLENGE = 1 << 7;
/** Lifetime profile stats — K/D, matches, wins. Public, and gates trading. */
export const REWARD_STATS = 1 << 8;
/** The server-rendered share card. `docs/ECONOMY.md`: "cannot be faked". */
export const REWARD_SHARE_CARD = 1 << 9;
/** Playtime that lifts a trade cooldown or a new-account trade lock. */
export const REWARD_TRADE_UNLOCK = 1 << 10;

export const REWARD_BIT_COUNT = 11;

/** Every reward kind. A row granting this is fully trusted. */
export const REWARD_ALL =
  REWARD_XP | REWARD_SCRAP | REWARD_ITEM_DROP | REWARD_RANKED_RATING
  | REWARD_COMPETITION | REWARD_SPONSOR_PRIZE | REWARD_LEADERBOARD
  | REWARD_CHALLENGE | REWARD_STATS | REWARD_SHARE_CARD | REWARD_TRADE_UNLOCK;

/** No rewards at all. What every untrusted or invite-only row grants. */
export const REWARD_NONE = 0;

/**
 * What a public casual match on our servers pays. Deliberately excludes rating,
 * competition standing and prizes — those need their own match type.
 */
export const REWARD_CASUAL =
  REWARD_XP | REWARD_SCRAP | REWARD_ITEM_DROP | REWARD_CHALLENGE
  | REWARD_STATS | REWARD_SHARE_CARD | REWARD_TRADE_UNLOCK;

/** Index = bit position. Used by the UI and by audit logs. */
export const REWARD_NAMES: readonly string[] = Object.freeze([
  'XP', 'Scrap', 'Item drops', 'Ranked rating', 'Competition standing',
  'Sponsor prizes', 'Leaderboard', 'Challenge progress', 'Profile stats',
  'Share card', 'Trade unlocks',
]);

/** Stable slugs, for telemetry and the audit log. */
export const REWARD_KEYS: readonly string[] = Object.freeze([
  'xp', 'scrap', 'drop', 'rating', 'competition', 'prize', 'leaderboard',
  'challenge', 'stats', 'sharecard', 'tradeunlock',
]);

/** Expand a reward mask to display names. Cold path only. */
export function rewardNames(mask: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < REWARD_BIT_COUNT; i++) if ((mask & (1 << i)) !== 0) out.push(REWARD_NAMES[i]);
  return out;
}
/** Expand a reward mask to slugs. Cold path only. */
export function rewardKeys(mask: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < REWARD_BIT_COUNT; i++) if ((mask & (1 << i)) !== 0) out.push(REWARD_KEYS[i]);
  return out;
}
export function hasReward(mask: number, bit: number): boolean { return (mask & bit) !== 0; }

/**
 * Rewards that are irreversible once granted, because a trade or a payout can
 * move them to somebody else before the fraud is noticed. These get the
 * strictest treatment in the guard.
 */
export const REWARD_IRREVERSIBLE =
  REWARD_ITEM_DROP | REWARD_SPONSOR_PRIZE | REWARD_COMPETITION | REWARD_TRADE_UNLOCK;

/* ------------------------------------------------------------------------ *
 * Durable writes — value that is not a reward
 * ------------------------------------------------------------------------ */

/**
 * A persistent Builder world other players come back to. Not a reward, but it
 * is shared durable state, so a peer must never own it: `server/src/worlds.ts`
 * shards by world id and a world lives on exactly one host.
 */
export const WRITE_PERSISTENT_WORLD = 1 << 0;
/**
 * The device's own save file: levels cleared, best times, secrets found.
 * Display-only, never uploaded, never converted into XP, Scrap or a drop.
 * An untrusted session may write this — it is the player's own scoreboard.
 */
export const WRITE_LOCAL_RECORD = 1 << 1;
/** A server-side campaign record shared across the account's devices. */
export const WRITE_ACCOUNT_RECORD = 1 << 2;

export const WRITE_BIT_COUNT = 3;
export const WRITE_NONE = 0;

export const WRITE_NAMES: readonly string[] = Object.freeze([
  'Persistent world', 'Local record', 'Account record',
]);
export const WRITE_KEYS: readonly string[] = Object.freeze([
  'world', 'localrecord', 'accountrecord',
]);

/** Writes that require a session we simulated. */
export const WRITE_SERVER_ONLY = WRITE_PERSISTENT_WORLD | WRITE_ACCOUNT_RECORD;

export function writeNames(mask: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < WRITE_BIT_COUNT; i++) if ((mask & (1 << i)) !== 0) out.push(WRITE_NAMES[i]);
  return out;
}
export function hasWrite(mask: number, bit: number): boolean { return (mask & bit) !== 0; }

/* ------------------------------------------------------------------------ *
 * Peer hosting rules
 * ------------------------------------------------------------------------ */

/**
 * Hard ceiling on a peer-hosted room, from the measured assessment in
 * `docs/P2P.md`: a host-authoritative star is comfortable at 4 and safe at 8,
 * and the join burst alone is 8.94 MB of the host's uplink at N=4. Four is what
 * ships.
 */
export const PEER_MAX_PLAYERS = 4;

/**
 * Who may be elected host. From `docs/P2P.md`: iOS Safari suspends background
 * JS within seconds, so any phone call, notification or app switch ends the
 * match for everyone in it. A phone is never a host, at any N.
 */
export interface PeerHostRequirements {
  /** Never true. A backgrounded phone ends the match for the whole room. */
  readonly allowMobileHost: boolean;
  /** Measured uplink floor, bits/s. 4 players costs the host ~0.45 Mbps steady. */
  readonly minUplinkBps: number;
  /** The host must have the tab focused or a Worker keeping it alive. */
  readonly requiresWorkerKeepalive: boolean;
  /** Peers to keep warm as migration candidates. */
  readonly standbyHosts: number;
  /** Liveness probe interval. `CLIENT_TIMEOUT_MS` (15 s) is far too slow here. */
  readonly livenessProbeMs: number;
  /** Below this, a mobile radio handover false-positives as a dead host. */
  readonly minFailoverMs: number;
}

export const PEER_HOST_REQUIREMENTS: PeerHostRequirements = Object.freeze({
  allowMobileHost: false,
  minUplinkBps: 3_000_000,
  requiresWorkerKeepalive: true,
  standbyHosts: 1,
  livenessProbeMs: 1_000,
  minFailoverMs: 2_000,
});

/* ------------------------------------------------------------------------ *
 * The row
 * ------------------------------------------------------------------------ */

export interface TrustPolicy {
  readonly modeId: ModeId;
  readonly matchType: MatchType;

  /**
   * The **weakest** topology this row may run at. A row may always be run on
   * something more trusted; that does not change `grants`.
   */
  readonly topology: Topology;

  /** REWARD_* bits this row may pay out. Zero for anything untrusted or private. */
  readonly grants: number;
  /** WRITE_* bits this row may commit. */
  readonly writes: number;

  /** Bodies the room accepts. Peer rows are capped at `PEER_MAX_PLAYERS`. */
  readonly maxPlayers: number;

  /** Short label for the UI chip, e.g. "Unranked · no rewards". */
  readonly label: string;
  /**
   * One sentence the player sees *before* they commit an hour to it. Written
   * for a player, not for an engineer.
   */
  readonly playerNote: string;
  /** Why the row is set this way. Read by a future engineer, not by the game. */
  readonly why: string;
}

function row(p: TrustPolicy): TrustPolicy { return Object.freeze(p); }

/* ------------------------------------------------------------------------ *
 * THE TABLE
 *
 * One row per (mode, match type) that the product offers. A pair with no row is
 * not offered, and `trustPolicyFor` fails closed on it.
 * ------------------------------------------------------------------------ */

export const TRUST_TABLE: readonly TrustPolicy[] = Object.freeze([
  /* --- Quest ------------------------------------------------------------ */
  row({
    modeId: ModeId.QUEST,
    matchType: MatchType.SOLO,
    topology: Topology.CLIENT_LOCAL,
    grants: REWARD_NONE,
    writes: WRITE_LOCAL_RECORD,
    maxPlayers: 1,
    label: 'Offline · no rewards',
    playerNote: 'Runs entirely on your device. Your times and cleared levels are saved here, '
      + 'but nothing you earn counts towards your account.',
    why: 'The whole authoritative stack runs in this tab\'s Web Worker, so the result is exactly '
      + 'as forgeable as any other client-side number. Costs $0 in bandwidth and is the best cost '
      + 'lever in docs/INFRASTRUCTURE.md — but it cannot pay out.',
  }),
  row({
    modeId: ModeId.QUEST,
    matchType: MatchType.PRIVATE,
    topology: Topology.PEER_HOSTED,
    grants: REWARD_NONE,
    writes: WRITE_LOCAL_RECORD,
    maxPlayers: PEER_MAX_PLAYERS,
    label: 'Co-op · unranked · no rewards',
    playerNote: 'Hosted by one of the players, not by us. Play the campaign together — '
      + 'nothing earned here counts towards your account.',
    why: 'THE peer build. docs/P2P.md recommends exactly this row and no other: online co-op '
      + 'Quest does not exist yet, so peer hosting avoids a cost rather than removing one. '
      + 'Four players, invite link only, no matchmaking, server fallback when no peer is eligible.',
  }),
  row({
    modeId: ModeId.QUEST,
    matchType: MatchType.PUBLIC,
    topology: Topology.SERVER_AUTHORITATIVE,
    grants: REWARD_CASUAL,
    writes: WRITE_ACCOUNT_RECORD,
    maxPlayers: 4,
    label: 'Matchmade · rewards count',
    playerNote: 'Hosted by us and matchmade. XP, Scrap, drops and challenges all count.',
    why: 'We simulate it and we chose who is in it, so both trust conditions are met.',
  }),
  row({
    modeId: ModeId.QUEST,
    matchType: MatchType.COMPETITION,
    topology: Topology.SERVER_AUTHORITATIVE,
    grants: REWARD_ALL & ~REWARD_RANKED_RATING,
    writes: WRITE_ACCOUNT_RECORD,
    maxPlayers: 4,
    label: 'Event · prizes',
    playerNote: 'A scheduled speedrun event, hosted by us. Times are official and prizes are real.',
    why: 'Speedrun tournaments key off level time, which only a room we ran can attest to. '
      + 'No ranked rating: Quest has no ladder.',
  }),

  /* --- Builder ---------------------------------------------------------- */
  row({
    modeId: ModeId.BUILDER,
    matchType: MatchType.SOLO,
    topology: Topology.CLIENT_LOCAL,
    grants: REWARD_NONE,
    writes: WRITE_LOCAL_RECORD,
    maxPlayers: 1,
    label: 'Offline · saved on this device',
    playerNote: 'This world lives on your device only. It will not appear in the online world list.',
    why: 'A local world is fine; a shared one is not. WRITE_PERSISTENT_WORLD needs a host that '
      + 'is still there tomorrow.',
  }),
  row({
    modeId: ModeId.BUILDER,
    matchType: MatchType.PRIVATE,
    topology: Topology.SERVER_AUTHORITATIVE,
    grants: REWARD_NONE,
    writes: WRITE_PERSISTENT_WORLD | WRITE_ACCOUNT_RECORD,
    maxPlayers: 16,
    label: 'Invite only · world saved · no rewards',
    playerNote: 'Hosted by us, so the world is saved and your friends can come back to it. '
      + 'Building here does not earn XP or drops.',
    why: 'Server-authoritative always — docs/P2P.md: `worlds.ts` shards by world id and a world '
      + 'lives on exactly one host; a peer cannot own something other players return to. Grants '
      + 'nothing because an invite-only creative world with infinite blocks is a reward farm.',
  }),
  row({
    modeId: ModeId.BUILDER,
    matchType: MatchType.PUBLIC,
    topology: Topology.SERVER_AUTHORITATIVE,
    grants: REWARD_XP | REWARD_CHALLENGE | REWARD_STATS | REWARD_TRADE_UNLOCK,
    writes: WRITE_PERSISTENT_WORLD | WRITE_ACCOUNT_RECORD,
    maxPlayers: 16,
    label: 'Public world · limited rewards',
    playerNote: 'Hosted by us and open to anyone. Time played earns XP; building does not '
      + 'drop items.',
    why: 'No REWARD_ITEM_DROP and no REWARD_SCRAP: Builder hands out infinite blocks and has no '
      + 'failure state, so any per-action payout is an idle farm. Time-based XP is capped '
      + 'elsewhere by the per-day limits in docs/ECONOMY.md.',
  }),

  /* --- Horde ------------------------------------------------------------ */
  row({
    modeId: ModeId.HORDE,
    matchType: MatchType.SOLO,
    topology: Topology.CLIENT_LOCAL,
    grants: REWARD_NONE,
    writes: WRITE_LOCAL_RECORD,
    maxPlayers: 1,
    label: 'Offline · no rewards',
    playerNote: 'Runs on your device. Your best wave is saved here; it does not count towards '
      + 'your account or the leaderboard.',
    why: 'Same Worker, same forgeability as Quest solo.',
  }),
  row({
    modeId: ModeId.HORDE,
    matchType: MatchType.PRIVATE,
    topology: Topology.PEER_HOSTED,
    grants: REWARD_NONE,
    writes: WRITE_LOCAL_RECORD,
    maxPlayers: PEER_MAX_PLAYERS,
    label: 'Co-op · unranked · no rewards',
    playerNote: 'Hosted by one of the players. Waves survived here do not count towards XP, '
      + 'Scrap, drops or the leaderboard.',
    why: 'SAFE to peer-host — but docs/P2P.md says it is not WORTH it below ~500k CCU, and it '
      + 'costs Horde its whole progression loop. The table describes what is permitted; the '
      + 'rollout note below says what to actually switch on. Running this row on our own servers '
      + 'is allowed and changes none of the zeroes above.',
  }),
  row({
    modeId: ModeId.HORDE,
    matchType: MatchType.PUBLIC,
    topology: Topology.SERVER_AUTHORITATIVE,
    grants: REWARD_CASUAL | REWARD_LEADERBOARD,
    writes: WRITE_ACCOUNT_RECORD,
    maxPlayers: 4,
    label: 'Matchmade · rewards count',
    playerNote: 'Hosted by us and matchmade. Waves survived earn XP, Scrap, drops and a '
      + 'leaderboard place.',
    why: 'docs/ECONOMY.md lists "horde waves survived" as an XP source, and only a room we ran '
      + 'can say how many waves there were.',
  }),
  row({
    modeId: ModeId.HORDE,
    matchType: MatchType.COMPETITION,
    topology: Topology.SERVER_AUTHORITATIVE,
    grants: REWARD_ALL & ~REWARD_RANKED_RATING,
    writes: WRITE_ACCOUNT_RECORD,
    maxPlayers: 4,
    label: 'Event · prizes',
    playerNote: 'A scheduled wave-survival event, hosted by us. Results are official and prizes '
      + 'are real.',
    why: 'Sponsor-funded prize pools settle from server-recorded results only.',
  }),

  /* --- Deathmatch ------------------------------------------------------- */
  row({
    modeId: ModeId.DEATHMATCH,
    matchType: MatchType.SOLO,
    topology: Topology.CLIENT_LOCAL,
    grants: REWARD_NONE,
    writes: WRITE_LOCAL_RECORD,
    maxPlayers: 1,
    label: 'Offline vs bots · no rewards',
    playerNote: 'You and the bots, on your device. Nothing here counts.',
    why: 'The default boot today. Zero bandwidth, zero trust.',
  }),
  row({
    modeId: ModeId.DEATHMATCH,
    matchType: MatchType.PRIVATE,
    topology: Topology.SERVER_AUTHORITATIVE,
    grants: REWARD_NONE,
    writes: WRITE_NONE,
    maxPlayers: MAX_PLAYERS,
    label: 'Private scrim · no rewards',
    playerNote: 'A private arena for you and your friends, hosted by us so nobody has a '
      + 'connection advantage. Kills here do not count.',
    why: 'Server-hosted even though it grants nothing: a peer host gets a free 0 ms latency edge '
      + 'in a PvP mode, which is unacceptable before you even reach the cheating. And it grants '
      + 'nothing because an invite-only free-for-all is the easiest kill farm in the game. '
      + '`validateTrustTable` refuses a PvP mode on a peer topology outright.',
  }),
  row({
    modeId: ModeId.DEATHMATCH,
    matchType: MatchType.PUBLIC,
    topology: Topology.SERVER_AUTHORITATIVE,
    grants: REWARD_CASUAL,
    writes: WRITE_ACCOUNT_RECORD,
    maxPlayers: MAX_PLAYERS,
    label: 'Matchmade · rewards count',
    playerNote: 'Hosted by us and matchmade. XP, Scrap, drops and challenges all count.',
    why: 'Casual queue. No rating — that is what the Ranked row is for.',
  }),
  row({
    modeId: ModeId.DEATHMATCH,
    matchType: MatchType.RANKED,
    topology: Topology.SERVER_AUTHORITATIVE,
    grants: REWARD_CASUAL | REWARD_RANKED_RATING | REWARD_LEADERBOARD,
    writes: WRITE_ACCOUNT_RECORD,
    maxPlayers: MAX_PLAYERS,
    label: 'Ranked · rating at stake',
    playerNote: 'Hosted by us, matchmade by rating. Everything counts, including your rank.',
    why: 'The one row that moves rating. docs/ECONOMY.md decision 1 in its purest form.',
  }),
  row({
    modeId: ModeId.DEATHMATCH,
    matchType: MatchType.COMPETITION,
    topology: Topology.SERVER_AUTHORITATIVE,
    grants: REWARD_ALL,
    writes: WRITE_ACCOUNT_RECORD,
    maxPlayers: MAX_PLAYERS,
    label: 'Tournament · prizes',
    playerNote: 'A scheduled tournament, hosted by us. Official results, real prizes.',
    why: 'The only row that may award a sponsor-funded prize alongside rating.',
  }),
]);

/* ------------------------------------------------------------------------ *
 * Lookup — fails closed
 * ------------------------------------------------------------------------ */

/**
 * What an unknown (mode, match type) pair resolves to. Server-authoritative so
 * nothing accidentally becomes peer-hostable, and granting nothing so nothing
 * accidentally pays out. A combination nobody wrote down is not one we offer.
 */
export const DENY_ALL: TrustPolicy = Object.freeze({
  modeId: ModeId.DEATHMATCH,
  matchType: MatchType.SOLO,
  topology: Topology.SERVER_AUTHORITATIVE,
  grants: REWARD_NONE,
  writes: WRITE_NONE,
  maxPlayers: 1,
  label: 'Not offered',
  playerNote: 'This combination is not available.',
  why: 'No row in TRUST_TABLE. Fail closed: no rewards, no peer hosting.',
});

/** modeId * MATCH_TYPE_COUNT + matchType -> row. Built once at module load. */
const INDEX: Array<TrustPolicy | undefined> = (() => {
  const a = new Array<TrustPolicy | undefined>(MODES.length * MATCH_TYPE_COUNT);
  for (const p of TRUST_TABLE) a[p.modeId * MATCH_TYPE_COUNT + p.matchType] = p;
  return a;
})();

/**
 * THE lookup. Every trust decision in the codebase goes through this function.
 * An unrecognised pair returns `DENY_ALL` rather than throwing, because a
 * throw on a hot path becomes a `try/catch` and a `try/catch` becomes a default.
 */
export function trustPolicyFor(modeId: number, matchType: number): TrustPolicy {
  if (!isModeId(modeId) || !isMatchType(matchType)) return DENY_ALL;
  return INDEX[modeId * MATCH_TYPE_COUNT + matchType] ?? DENY_ALL;
}

/** True when the product offers this pair at all. */
export function isOffered(modeId: number, matchType: number): boolean {
  if (!isModeId(modeId) || !isMatchType(matchType)) return false;
  return INDEX[modeId * MATCH_TYPE_COUNT + matchType] !== undefined;
}

/** The match types a mode offers, in menu order. Drives the UI picker. */
export function matchTypesFor(modeId: number): MatchType[] {
  const out: MatchType[] = [];
  if (!isModeId(modeId)) return out;
  for (let t = 0; t < MATCH_TYPE_COUNT; t++) {
    if (INDEX[modeId * MATCH_TYPE_COUNT + t] !== undefined) out.push(t as MatchType);
  }
  return out;
}

/** Rows whose permitted topology is a peer. The whole peer-hosting surface. */
export function peerHostableRows(): TrustPolicy[] {
  return TRUST_TABLE.filter((p) => p.topology === Topology.PEER_HOSTED);
}

/* --- derived predicates, so nobody re-derives them wrongly ---------------- */

export function grantsAnything(p: TrustPolicy): boolean { return p.grants !== REWARD_NONE; }
export function isPeerHostable(p: TrustPolicy): boolean { return p.topology === Topology.PEER_HOSTED; }
export function isUntrusted(p: TrustPolicy): boolean { return p.topology !== Topology.SERVER_AUTHORITATIVE; }
export function touchesEconomy(p: TrustPolicy): boolean { return (p.grants & REWARD_ALL) !== 0; }

/**
 * The player-facing verdict in one word. `matchType.ts` renders this; nothing
 * else should invent a synonym for it.
 */
export function verdictOf(p: TrustPolicy): 'counts' | 'unranked' {
  return grantsAnything(p) ? 'counts' : 'unranked';
}

/* ------------------------------------------------------------------------ *
 * Sealing a live session
 * ------------------------------------------------------------------------ */

/**
 * The trust facts of one live session, stamped at creation and never re-derived
 * from anything a client says. The server keeps this; the client is *told* it
 * so the UI can be honest, and telling the client is safe because the client
 * cannot change it.
 */
export interface SessionTrust {
  readonly modeId: ModeId;
  readonly matchType: MatchType;
  /** Where the sim ACTUALLY ran, from `SessionOrigin`. */
  readonly topology: Topology;
  readonly origin: SessionOrigin;
  /** Effective grants: the row's, zeroed if the actual run was untrusted. */
  readonly grants: number;
  /** Effective writes: server-only bits stripped if the actual run was untrusted. */
  readonly writes: number;
  /** The row this came from, for messages and audit lines. */
  readonly policy: TrustPolicy;
}

/**
 * Freeze the trust facts for a session at the moment the server creates it.
 *
 * Two independent reductions apply, and both are one-way:
 *
 *   1. The **row** decides the ceiling. A row that grants nothing grants
 *      nothing however the session is run.
 *   2. The **actual topology** can only reduce it further. A row that would
 *      grant is zeroed if this particular session did not run on our hardware
 *      — belt and braces, so a misconfigured matchmaker cannot pay out a peer.
 *
 * `modeId` and `origin` are server facts. `serverIntent` is the matchmaker's or
 * the scheduler's intent, never a field off a packet.
 */
export function sealSessionTrust(
  modeId: number, origin: SessionOrigin, serverIntent: MatchType,
): SessionTrust {
  const safeMode: ModeId = isModeId(modeId) ? modeId : ModeId.DEATHMATCH;
  const safeOrigin: SessionOrigin = isSessionOrigin(origin) ? origin : SessionOrigin.PEER_HOST;
  const topology = topologyForOrigin(safeOrigin);
  const matchType = resolveMatchType(safeOrigin, serverIntent);
  const policy = trustPolicyFor(safeMode, matchType);

  const trusted = isTrustedTopology(topology);
  return Object.freeze({
    modeId: safeMode,
    matchType,
    topology,
    origin: safeOrigin,
    grants: trusted ? policy.grants : REWARD_NONE,
    writes: trusted ? policy.writes : (policy.writes & ~WRITE_SERVER_ONLY),
    policy,
  });
}

/** True when this session may award this specific reward kind. */
export function sessionMayGrant(t: SessionTrust, rewardBit: number): boolean {
  return isTrustedTopology(t.topology) && (t.grants & rewardBit) === rewardBit && rewardBit !== 0;
}

/** True when this session may commit this specific durable write. */
export function sessionMayWrite(t: SessionTrust, writeBit: number): boolean {
  return (t.writes & writeBit) === writeBit && writeBit !== 0;
}

/** One line for an audit log. Deterministic, no timestamps, safe to diff. */
export function describeSessionTrust(t: SessionTrust): string {
  const mode = MODE_KEYS[t.modeId] ?? 'unknown';
  const type = MATCH_TYPE_KEYS[t.matchType] ?? 'unknown';
  const topo = TOPOLOGY_KEYS[t.topology] ?? 'unknown';
  const grants = t.grants === REWARD_NONE ? 'nothing' : rewardKeys(t.grants).join('+');
  return `${mode}/${type} on ${topo} grants ${grants}`;
}

/* ------------------------------------------------------------------------ *
 * Profile field ownership
 *
 * The other half of "the client never grants". `server/src/index.ts` accepts a
 * whole profile object on `POST /api/profile`; these two lists say which parts
 * of it the client is allowed to have written. `entitlementGuard.ts` enforces
 * them.
 * ------------------------------------------------------------------------ */

/** Profile fields a client owns and may send. Preferences and identity. */
export const CLIENT_OWNED_PROFILE_FIELDS: readonly string[] = Object.freeze([
  'name', 'skin', 'avatar', 'settings', 'bindings', 'loadout', 'lastSeed',
]);

/**
 * Profile fields only a server-authoritative match may move. A client that
 * sends any of these is not making a mistake.
 *
 * The last four are not counters and are here for a different reason:
 * `economy` is the Scrap balance and the per-day earn buckets (a client that
 * posts `economy.dayScrap: 0` resets its own anti-farm meter), `accountId` and
 * `accountSecret` are the credential pair, and `_unknown` is the downgrade
 * guard's carry bag — a client that can write it can smuggle any key it likes
 * back to the top level of the stored profile through `serialiseProfile`.
 */
export const SERVER_OWNED_PROFILE_FIELDS: readonly string[] = Object.freeze([
  'xp', 'level', 'scrap', 'kills', 'deaths', 'wins', 'gamesPlayed',
  'bestKillstreak', 'blocksPlaced', 'blocksBroken', 'secondsPlayed',
  'favouriteWeapon', 'adsRemoved', 'entitlements', 'stats', 'items',
  'drops', 'rating', 'trophies', 'titles',
  'economy', 'accountId', 'accountSecret', '_unknown',
]);

export function isClientOwnedProfileField(name: string): boolean {
  return CLIENT_OWNED_PROFILE_FIELDS.includes(name);
}
export function isServerOwnedProfileField(name: string): boolean {
  return SERVER_OWNED_PROFILE_FIELDS.includes(name);
}

/* ------------------------------------------------------------------------ *
 * The keys that are not keys
 * ------------------------------------------------------------------------ */

/**
 * Property names that ASSIGN A PROTOTYPE instead of setting a property.
 *
 * `JSON.parse('{"__proto__":{}}')` produces an object with an **own,
 * enumerable** `__proto__` property, so it survives `Object.keys` and every
 * allowlist built on it. Copy it into a plain `{}` accumulator with
 * `out[key] = value` and the `Object.prototype` setter fires instead: the
 * accumulator's prototype is replaced, `out.anything` now resolves through the
 * attacker's object, and every field check that already ran saw nothing wrong.
 *
 * That is not a hypothetical here. It walked straight through
 * `guardProfileWrite` and paid a device 1,000,000,000 XP with
 * `rejectedFields: []`. Any code that copies attacker-controlled keys into an
 * accumulator must skip these three at EVERY level it descends — checking only
 * the top level moves the hole one line deeper.
 */
export const PROTOTYPE_POLLUTING_KEYS: readonly string[] = Object.freeze([
  '__proto__', 'constructor', 'prototype',
]);

export function isPrototypePollutingKey(name: string): boolean {
  return PROTOTYPE_POLLUTING_KEYS.includes(name);
}

/* ------------------------------------------------------------------------ *
 * Validation — the table cannot drift
 *
 * Every invariant below is a rule somebody would otherwise have to remember.
 * `validateTrustTable(TRUST_TABLE)` runs at module load, so a bad edit fails
 * the first import rather than the first payout.
 * ------------------------------------------------------------------------ */

export class TrustTableError extends Error {
  override readonly name = 'TrustTableError';
}

/**
 * Check a set of rows against every trust invariant. Returns the list of
 * problems; empty means sound. Exported so a test can feed it a deliberately
 * broken row and prove the check bites.
 */
export function checkTrustTable(rows: readonly TrustPolicy[]): string[] {
  const problems: string[] = [];
  const seen = new Set<number>();
  const modesCovered = new Set<number>();

  for (const p of rows) {
    const where = `${MODE_KEYS[p.modeId] ?? p.modeId}/${MATCH_TYPE_KEYS[p.matchType] ?? p.matchType}`;

    if (!isModeId(p.modeId)) { problems.push(`${where}: not a ModeId`); continue; }
    if (!isMatchType(p.matchType)) { problems.push(`${where}: not a MatchType`); continue; }
    if (!isTopology(p.topology)) { problems.push(`${where}: not a Topology`); continue; }

    const key = p.modeId * MATCH_TYPE_COUNT + p.matchType;
    if (seen.has(key)) problems.push(`${where}: duplicate row — a pair must resolve to one policy`);
    seen.add(key);
    modesCovered.add(p.modeId);

    if ((p.grants & ~REWARD_ALL) !== 0) problems.push(`${where}: grants an unknown reward bit`);
    if ((p.writes & ~(WRITE_PERSISTENT_WORLD | WRITE_LOCAL_RECORD | WRITE_ACCOUNT_RECORD)) !== 0) {
      problems.push(`${where}: writes an unknown bit`);
    }

    /* 1. Untrusted simulation grants nothing. The headline rule. */
    if (p.grants !== REWARD_NONE && p.topology !== Topology.SERVER_AUTHORITATIVE) {
      problems.push(
        `${where}: grants ${rewardKeys(p.grants).join('+')} on a ${TOPOLOGY_KEYS[p.topology]} `
        + 'topology — a peer or a local Worker can fabricate any result it likes',
      );
    }

    /* 2. Uncontrolled participation grants nothing. */
    if (p.grants !== REWARD_NONE && !isParticipationControlled(p.matchType)) {
      problems.push(
        `${where}: grants ${rewardKeys(p.grants).join('+')} in a match the player picked the `
        + 'participants for — that is a farm, however honest the simulation was',
      );
    }

    /* 3. Rating only where rating is at stake. */
    if ((p.grants & REWARD_RANKED_RATING) !== 0
      && p.matchType !== MatchType.RANKED && p.matchType !== MatchType.COMPETITION) {
      problems.push(`${where}: moves ranked rating outside a Ranked or Competition match`);
    }

    /* 4. Prizes and standings only in a scheduled event. */
    if ((p.grants & (REWARD_SPONSOR_PRIZE | REWARD_COMPETITION)) !== 0
      && p.matchType !== MatchType.COMPETITION) {
      problems.push(`${where}: awards a prize or a standing outside a Competition match`);
    }

    /* 5. Durable shared state needs a host that is still there tomorrow. */
    if ((p.writes & WRITE_SERVER_ONLY) !== 0 && p.topology !== Topology.SERVER_AUTHORITATIVE) {
      problems.push(
        `${where}: writes ${writeNames(p.writes & WRITE_SERVER_ONLY).join('+')} from a `
        + `${TOPOLOGY_KEYS[p.topology]} session`,
      );
    }

    /* 6. A persistent world implies the mode actually has one. */
    if ((p.writes & WRITE_PERSISTENT_WORLD) !== 0
      && getMode(p.modeId).world !== WorldSource.PERSISTENT) {
      problems.push(`${where}: claims a persistent world but the mode does not have one`);
    }

    /* 7. PvP never peer-hosts. The host's 0 ms edge is unacceptable on its own. */
    if (p.topology === Topology.PEER_HOSTED && getMode(p.modeId).pvp === PvpPolicy.FREE_FOR_ALL) {
      problems.push(
        `${where}: peer-hosts a free-for-all mode — the host plays at 0 ms against everyone else`,
      );
    }

    /* 8. Room sizes stay inside what the mode and the measurements allow. */
    if (p.maxPlayers < 1 || p.maxPlayers > MAX_PLAYERS) {
      problems.push(`${where}: maxPlayers ${p.maxPlayers} is outside 1..${MAX_PLAYERS}`);
    }
    if (p.maxPlayers > getMode(p.modeId).maxPlayers) {
      problems.push(`${where}: maxPlayers ${p.maxPlayers} exceeds the mode's ${getMode(p.modeId).maxPlayers}`);
    }
    if (p.topology === Topology.PEER_HOSTED && p.maxPlayers > PEER_MAX_PLAYERS) {
      problems.push(
        `${where}: ${p.maxPlayers} players on a peer host — the measured ceiling is `
        + `${PEER_MAX_PLAYERS} (docs/P2P.md)`,
      );
    }
    if (p.topology === Topology.CLIENT_LOCAL && p.maxPlayers !== 1) {
      problems.push(`${where}: a local session has exactly one human`);
    }

    /* 9. Every row must be able to explain itself to a player and to an engineer. */
    if (p.label.length === 0) problems.push(`${where}: no label`);
    if (p.playerNote.length === 0) problems.push(`${where}: no playerNote — the player would find out later`);
    if (p.why.length === 0) problems.push(`${where}: no why`);
  }

  /* 10. No mode may be missing from the table: an absent mode has no policy. */
  for (const def of MODES) {
    if (!modesCovered.has(def.id)) problems.push(`${def.key}: no rows at all — every mode needs a policy`);
  }

  return problems;
}

/** Throwing form. Runs at module load against the real table. */
export function validateTrustTable(rows: readonly TrustPolicy[]): void {
  const problems = checkTrustTable(rows);
  if (problems.length > 0) {
    throw new TrustTableError(`trust table is unsound:\n  - ${problems.join('\n  - ')}`);
  }
}

// A bad edit to the table above fails the very first import of this module, in
// every build and every test, rather than the first time somebody is paid.
validateTrustTable(TRUST_TABLE);

/* ------------------------------------------------------------------------ *
 * Rollout note — a different question from the table
 *
 * The table says what is SAFE. This says what is WORTH switching on, from the
 * measured cost work in docs/P2P.md. The guard never reads it; it is here so
 * the two answers live next to each other and neither gets mistaken for the
 * other.
 * ------------------------------------------------------------------------ */

export interface PeerRolloutNote {
  readonly modeId: ModeId;
  readonly matchType: MatchType;
  /** Ship this one now? */
  readonly enabled: boolean;
  readonly note: string;
}

export const PEER_ROLLOUT: readonly PeerRolloutNote[] = Object.freeze([
  Object.freeze({
    modeId: ModeId.QUEST,
    matchType: MatchType.PRIVATE,
    enabled: true,
    note: 'Online co-op Quest does not exist yet, so peer hosting avoids a cost instead of '
      + 'removing one. ~$2,731/mo avoided at 1M CCU, net of relay.',
  }),
  Object.freeze({
    modeId: ModeId.HORDE,
    matchType: MatchType.PRIVATE,
    enabled: false,
    note: 'Safe, but not worth it: +$5,263/mo at 1M CCU, $0 or negative below that, and it '
      + 'costs Horde its progression loop. Revisit above 500k CCU and only after the '
      + 'net.ts:874 entity-delta fix has shipped.',
  }),
]);
