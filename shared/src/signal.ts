/**
 * DOOMCRAFT — the signalling contract.
 *
 * Two peers cannot talk until somebody introduces them: they have to exchange
 * an SDP offer/answer and a handful of ICE candidates. That exchange is the
 * server you can never delete, and it is also the cheapest one you will ever
 * run — a few kilobytes, once, per match. This file is the wire format for it,
 * shared by `client/src/net/webrtc.ts` and `server/src/signal.ts` so the two
 * cannot drift.
 *
 * Nothing here touches the DOM, node:*, or the game protocol. Signalling
 * carries no game state and never sees a game packet: the moment the
 * DataChannel is up, this connection has no further job.
 *
 * SECURITY NOTE — room codes are a bearer token.
 *
 * Anyone holding the code can ask to join. There is no account check, because
 * a P2P room awards nothing and therefore has nothing worth stealing (see
 * docs/ECONOMY.md decision 1 and the hard rules in peerHost.ts). What the code
 * MUST resist is enumeration: a script that walks the code space would find
 * every open lobby on the service and could flood each one with join attempts.
 *
 * Defence is two-layer, because either layer alone is not enough:
 *
 *   1. ENTROPY. 8 characters from a 32-symbol alphabet is 32^8 = 2^40 =
 *      1.1e12 codes. With a realistic 10,000 live rooms the chance that a
 *      single random guess hits one is 9.1e-9, so an attacker needs ~1.1e8
 *      guesses for one expected hit.
 *   2. RATE LIMIT. server/src/signal.ts caps wrong-code attempts per IP hard
 *      enough that 1.1e8 guesses is not reachable, which is what turns the
 *      number above from "unlikely" into "impossible in practice". Entropy
 *      without a rate limit only buys time; a rate limit without entropy is
 *      defeated by a botnet. Both, or neither.
 *
 * The alphabet is Crockford base32 (no I, L, O or U): no character pair a
 * human can confuse when reading a code aloud to a friend, and no accidental
 * profanity from the vowel set.
 */

/** WebSocket path the signalling hub listens on. Distinct from `WS_PATH`. */
export const SIGNAL_PATH = '/rtc';

/** Bump when any message below changes shape. */
export const SIGNAL_PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------------ *
 * Room codes
 * ------------------------------------------------------------------------ */

/** Crockford base32: digits plus consonants, minus I, L, O and U. */
export const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ROOM_CODE_LENGTH = 8;
/** log2(32^8). Quoted in the security note above and asserted in the tests. */
export const ROOM_CODE_ENTROPY_BITS = 40;

/**
 * Fold a typed code into canonical form: upper case, look-alikes mapped the
 * Crockford way (I/l -> 1, O -> 0), and separators stripped so "abcd-efgh"
 * works. Returns '' when the result is not a valid code.
 */
export function normaliseRoomCode(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length && out.length <= ROOM_CODE_LENGTH; i++) {
    const c = raw[i].toUpperCase();
    if (c === '-' || c === ' ' || c === '_') continue;
    if (c === 'I' || c === 'L') { out += '1'; continue; }
    if (c === 'O') { out += '0'; continue; }
    if (c === 'U') { out += 'V'; continue; }
    if (ROOM_CODE_ALPHABET.indexOf(c) < 0) return '';
    out += c;
  }
  return out.length === ROOM_CODE_LENGTH ? out : '';
}

export function isRoomCode(v: unknown): v is string {
  return typeof v === 'string' && normaliseRoomCode(v) === v;
}

/** Pretty form for the UI: `XXXX-XXXX`. */
export function formatRoomCode(code: string): string {
  return code.length === ROOM_CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/* ------------------------------------------------------------------------ *
 * Hard limits
 *
 * Every one of these is enforced on the SERVER (signal.ts). They are declared
 * here so the client can refuse to build a message the hub will reject rather
 * than discovering it by being disconnected.
 * ------------------------------------------------------------------------ */

/** Whole JSON frame. An SDP with a dozen candidates is ~4 KB. */
export const SIGNAL_MAX_MESSAGE_BYTES = 16 * 1024;
/** One SDP blob. */
export const SIGNAL_MAX_SDP_BYTES = 12 * 1024;
/** One trickled ICE candidate line. */
export const SIGNAL_MAX_CANDIDATE_BYTES = 1024;
/** ICE candidates one peer may trickle before the hub stops relaying them. */
export const SIGNAL_MAX_CANDIDATES = 64;
/** Signalling frames per second per socket before the socket is dropped. */
export const SIGNAL_MAX_MESSAGES_PER_SECOND = 30;
/** A room with no completed handshake this long is garbage collected. */
export const SIGNAL_ROOM_IDLE_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------------ *
 * Messages — client to hub
 * ------------------------------------------------------------------------ */

/** "I am willing to host; give me a code." */
export interface SigHost {
  t: 'host';
  v: number;
  /** Guests this host will accept. Clamped by the hub to the star limit. */
  cap: number;
  /** Free-form label for the lobby list. Never trusted, never rendered raw. */
  label?: string;
}

/** "Put me through to the host of this code." */
export interface SigJoin {
  t: 'join';
  v: number;
  code: string;
}

/** SDP offer or answer, relayed verbatim to exactly one peer in the room. */
export interface SigSdp {
  t: 'sdp';
  /** Peer id within the room. Guests may only address the host. */
  to: string;
  kind: 'offer' | 'answer';
  sdp: string;
}

/** One trickled ICE candidate. */
export interface SigIce {
  t: 'ice';
  to: string;
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/** "I am done with signalling" — the DataChannel is up, or the join failed. */
export interface SigBye { t: 'bye'; to?: string }

export type SignalC2S = SigHost | SigJoin | SigSdp | SigIce | SigBye;

/* ------------------------------------------------------------------------ *
 * Messages — hub to client
 * ------------------------------------------------------------------------ */

export interface SigHosted {
  t: 'hosted';
  v: number;
  code: string;
  /** This socket's peer id. The host is always `'h'`. */
  self: string;
  iceServers: IceServerConfig[];
}

/** Sent to a guest once the hub has put it in a room. */
export interface SigJoined {
  t: 'joined';
  v: number;
  code: string;
  self: string;
  /** Peer id of the host to address. */
  host: string;
  iceServers: IceServerConfig[];
}

/** Sent to the HOST when a guest arrives. The host then expects an offer. */
export interface SigPeer { t: 'peer'; peer: string }

/** Sent to the host when a guest gives up or disconnects before connecting. */
export interface SigPeerGone { t: 'peer-gone'; peer: string }

/** Relayed SDP / ICE, stamped with who sent it. */
export interface SigSdpFrom extends Omit<SigSdp, 'to'> { from: string }
export interface SigIceFrom extends Omit<SigIce, 'to'> { from: string }

export type SignalErrorCode =
  | 'bad-request'
  | 'bad-version'
  | 'no-such-room'
  | 'room-full'
  | 'rate-limited'
  | 'too-many-rooms'
  | 'host-gone';

export interface SigError { t: 'error'; code: SignalErrorCode; detail?: string }

export type SignalS2C =
  | SigHosted | SigJoined | SigPeer | SigPeerGone
  | SigSdpFrom | SigIceFrom | SigError;

/* ------------------------------------------------------------------------ *
 * ICE configuration
 * ------------------------------------------------------------------------ */

/**
 * A STUN or TURN server, in the shape `RTCPeerConnection` wants.
 *
 * TURN credentials handed out here are EPHEMERAL — an HMAC over an expiry
 * timestamp, the coturn `use-auth-secret` scheme. A static TURN password in a
 * JavaScript bundle is an open relay with your name on it, and an open relay
 * is worth more to an attacker than any amount of game bandwidth. See
 * `turnCredentials()` in server/src/signal.ts.
 */
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Peer id the hub always assigns to the host of a room. */
export const HOST_PEER_ID = 'h';
