/**
 * DOOMCRAFT — the signalling hub.
 *
 * This is the server you still need after everything else moves to peers, and
 * it is the cheapest one in the estate. Two players cannot open a DataChannel
 * until somebody has passed an SDP offer, an SDP answer and a handful of ICE
 * candidates between them. That is a few kilobytes, once, per match. After the
 * handshake this connection has no further job and the game traffic never
 * touches it.
 *
 * WHAT IT DELIBERATELY IS NOT
 *
 *   - It is not a game server. It holds no world, no simulation, no player
 *     state, and it never parses a game packet.
 *   - It is not a TURN relay. Relaying media is a different box with a
 *     different cost model (see docs/INFRASTRUCTURE.md); this one only hands
 *     out the credentials for it.
 *   - It is not a matchmaker. There is no lobby list, no skill rating, no
 *     queue. A room is reachable only by its code, which is a bearer token you
 *     send to a friend.
 *
 * WHY IT IS SAFE TO RUN AN OPEN RELAY OF SDP BLOBS
 *
 * The hub forwards opaque strings between exactly two sockets that are already
 * in the same room, and only in the star's shape: a guest may address the host
 * and nothing else, and the host may address only guests it has been told
 * about. There is no guest-to-guest path, so the hub can never be used as a
 * general-purpose message relay between arbitrary clients.
 *
 * RATE LIMITING IS LOAD-BEARING, NOT HYGIENE
 *
 * A room code is 40 bits (see shared/src/signal.ts). At 10,000 live rooms a
 * single random guess has a 9.1e-9 chance of hitting one, so an attacker needs
 * about 1.1e8 guesses for one expected hit. `MAX_FAILED_JOINS_PER_MINUTE` caps
 * a single source at 14,400 guesses per day even before the escalating ban, so
 * one expected hit costs roughly 7,600 IP-days. Entropy alone would only buy
 * time; the limit is what turns "unlikely" into "not worth attempting".
 *
 * Everything here is injectable — the socket, the clock, the id source — so it
 * is tested without a network. `attachSignalSocket()` at the bottom is the ten
 * lines that wire it to the `ws` server that already exists in index.ts.
 */

import { createHmac, randomBytes } from 'node:crypto';

import {
  HOST_PEER_ID,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  SIGNAL_MAX_CANDIDATE_BYTES,
  SIGNAL_MAX_CANDIDATES,
  SIGNAL_MAX_MESSAGE_BYTES,
  SIGNAL_MAX_MESSAGES_PER_SECOND,
  SIGNAL_MAX_SDP_BYTES,
  SIGNAL_PROTOCOL_VERSION,
  SIGNAL_ROOM_IDLE_MS,
  normaliseRoomCode,
  type IceServerConfig,
  type SignalC2S,
  type SignalErrorCode,
  type SignalS2C,
} from '@doomcraft/shared/signal';

/* ------------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------------ */

/** Guests one room may hold. Mirrors `PEER_CAP_MAX` in client peerHost.ts. */
export const SIGNAL_MAX_GUESTS = 7;
/** Concurrent signalling sockets from one address. */
export const MAX_SOCKETS_PER_IP = 8;
/** Rooms one address may open per minute. */
export const MAX_ROOMS_PER_IP_PER_MINUTE = 6;
/** Wrong-code join attempts per address per minute before the ban kicks in. */
export const MAX_FAILED_JOINS_PER_MINUTE = 10;
/** First ban. Doubles on each subsequent trip, up to `MAX_BAN_MS`. */
export const BASE_BAN_MS = 60_000;
export const MAX_BAN_MS = 15 * 60_000;
/** Burst allowance on top of the steady message rate. */
export const MESSAGE_BURST = SIGNAL_MAX_MESSAGES_PER_SECOND * 2;
/** Rooms the whole hub will hold. Beyond this, hosting is refused. */
export const MAX_ROOMS = 20_000;

/* ------------------------------------------------------------------------ *
 * Socket seam
 * ------------------------------------------------------------------------ */

/** The little a `ws` socket must expose. Tests supply a plain object. */
export interface SignalSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  readonly isOpen: boolean;
}

/* ------------------------------------------------------------------------ *
 * TURN credentials
 * ------------------------------------------------------------------------ */

export interface TurnCredential { username: string; credential: string }

/**
 * coturn's `use-auth-secret` scheme (the "TURN REST API"): the username is an
 * expiry timestamp, and the password is an HMAC of it under a secret only the
 * hub and the TURN server know.
 *
 * A static TURN password shipped in a JavaScript bundle is an open relay with
 * your name on it, and an unauthenticated relay is worth far more to an
 * attacker than any amount of game bandwidth — it is a free, attributable
 * proxy and a reflector. Credentials handed out here expire.
 */
export function turnCredentials(
  secret: string,
  ttlSeconds = 6 * 3600,
  label = 'dc',
  nowSeconds = Math.floor(Date.now() / 1000),
): TurnCredential {
  const username = `${nowSeconds + ttlSeconds}:${label}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

export interface IceConfigSource {
  /** STUN URLs. Never point production at a third party's public STUN. */
  stunUrls: string[];
  turnUrls: string[];
  turnSecret: string;
  turnTtlSeconds: number;
}

/** Read the ICE configuration out of the environment. */
export function iceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): IceConfigSource {
  const split = (v: string | undefined): string[] =>
    (v ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return {
    stunUrls: split(env.DOOMCRAFT_STUN_URLS),
    turnUrls: split(env.DOOMCRAFT_TURN_URLS),
    turnSecret: env.DOOMCRAFT_TURN_SECRET ?? '',
    turnTtlSeconds: Number.parseInt(env.DOOMCRAFT_TURN_TTL ?? '', 10) || 6 * 3600,
  };
}

/**
 * The `iceServers` array for one peer, with a fresh TURN credential.
 *
 * Returns an empty list when nothing is configured, and that is the correct
 * behaviour: a deployment with no STUN is visibly broken rather than quietly
 * leaning on someone else's public server.
 */
export function buildIceServers(src: IceConfigSource, nowMs = Date.now()): IceServerConfig[] {
  const out: IceServerConfig[] = [];
  if (src.stunUrls.length > 0) out.push({ urls: src.stunUrls });
  if (src.turnUrls.length > 0 && src.turnSecret.length > 0) {
    const cred = turnCredentials(src.turnSecret, src.turnTtlSeconds, 'dc', Math.floor(nowMs / 1000));
    out.push({ urls: src.turnUrls, username: cred.username, credential: cred.credential });
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Room codes
 * ------------------------------------------------------------------------ */

/**
 * A fresh 40-bit code. `randomBytes` rather than `Math.random`: the code is a
 * bearer token, and a predictable PRNG would make the entropy argument above
 * worthless no matter how many characters it has.
 */
export function generateRoomCode(rand: (n: number) => Buffer = randomBytes): string {
  // 32 symbols is exactly 5 bits, so a rejection-free mask is unbiased.
  const bytes = rand(ROOM_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) out += ROOM_CODE_ALPHABET[bytes[i] & 31];
  return out;
}

/* ------------------------------------------------------------------------ *
 * Connections and rooms
 * ------------------------------------------------------------------------ */

export type SignalRole = 'idle' | 'host' | 'guest';

export class SignalConnection {
  role: SignalRole = 'idle';
  /** Peer id inside the room: `'h'` for the host, `'g<N>'` for a guest. */
  peerId = '';
  code = '';
  closed = false;
  candidatesRelayed = 0;
  sdpsRelayed = 0;
  readonly openedMs: number;

  constructor(
    readonly socket: SignalSocket,
    readonly address: string,
    openedMs: number,
  ) {
    this.openedMs = openedMs;
  }

  send(msg: SignalS2C): void {
    if (this.closed || !this.socket.isOpen) return;
    this.socket.send(JSON.stringify(msg));
  }

  fail(code: SignalErrorCode, detail?: string): void {
    this.send(detail ? { t: 'error', code, detail } : { t: 'error', code });
  }
}

interface SignalRoom {
  code: string;
  host: SignalConnection;
  guests: Map<string, SignalConnection>;
  cap: number;
  label: string;
  createdMs: number;
  lastActivityMs: number;
  nextGuestNumber: number;
}

interface AddressRecord {
  sockets: number;
  /** Token bucket for messages. */
  tokens: number;
  lastRefillMs: number;
  roomsWindowStartMs: number;
  roomsCreated: number;
  failedWindowStartMs: number;
  failedJoins: number;
  banUntilMs: number;
  banStrikes: number;
}

export interface SignalHubOptions {
  ice?: IceConfigSource;
  now?: () => number;
  /** Injected in tests so codes are deterministic. */
  codeSource?: () => string;
  maxRooms?: number;
}

export interface SignalHubStats {
  rooms: number;
  connections: number;
  guestsConnected: number;
  roomsCreated: number;
  joinsAccepted: number;
  joinsRefused: number;
  bannedAddresses: number;
  messagesDropped: number;
}

/* ------------------------------------------------------------------------ *
 * The hub
 * ------------------------------------------------------------------------ */

export class SignalHub {
  private readonly rooms = new Map<string, SignalRoom>();
  private readonly connections = new Set<SignalConnection>();
  private readonly addresses = new Map<string, AddressRecord>();
  private readonly now: () => number;
  private readonly ice: IceConfigSource;
  private readonly codeSource: () => string;
  private readonly maxRooms: number;

  private roomsCreated = 0;
  private joinsAccepted = 0;
  private joinsRefused = 0;
  private messagesDropped = 0;

  constructor(options: SignalHubOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ice = options.ice ?? { stunUrls: [], turnUrls: [], turnSecret: '', turnTtlSeconds: 6 * 3600 };
    this.codeSource = options.codeSource ?? (() => generateRoomCode());
    this.maxRooms = options.maxRooms ?? MAX_ROOMS;
  }

  /* -------------------------------------------------------------- *
   * Lifecycle
   * -------------------------------------------------------------- */

  /** Returns null when the address is banned or already holds too many sockets. */
  attach(socket: SignalSocket, address: string): SignalConnection | null {
    const now = this.now();
    const rec = this.recordFor(address, now);
    if (now < rec.banUntilMs) {
      socket.close(1008, 'rate limited');
      return null;
    }
    if (rec.sockets >= MAX_SOCKETS_PER_IP) {
      socket.close(1008, 'too many connections');
      return null;
    }
    rec.sockets++;
    const conn = new SignalConnection(socket, address, now);
    this.connections.add(conn);
    return conn;
  }

  detach(conn: SignalConnection): void {
    if (conn.closed) return;
    conn.closed = true;
    this.connections.delete(conn);
    const rec = this.addresses.get(conn.address);
    if (rec && rec.sockets > 0) rec.sockets--;

    const room = this.rooms.get(conn.code);
    if (!room) return;

    if (conn.role === 'host') {
      // The host is gone before anyone connected. Everybody in the room learns
      // now rather than sitting on a spinner.
      for (const g of room.guests.values()) g.fail('host-gone');
      this.rooms.delete(room.code);
      return;
    }
    if (conn.role === 'guest' && room.guests.delete(conn.peerId)) {
      room.host.send({ t: 'peer-gone', peer: conn.peerId });
      room.lastActivityMs = this.now();
    }
  }

  /* -------------------------------------------------------------- *
   * Receive
   * -------------------------------------------------------------- */

  /** Feed one raw text frame. Anything malformed is an error, never a throw. */
  receive(conn: SignalConnection, raw: string): void {
    if (conn.closed) return;
    const now = this.now();

    // Size is checked before JSON.parse: parsing a megabyte to discover it is
    // too big is the denial of service.
    if (raw.length > SIGNAL_MAX_MESSAGE_BYTES) {
      this.messagesDropped++;
      this.kick(conn, 'bad-request', 'message too large');
      return;
    }
    if (!this.spendToken(conn, now)) return;

    let msg: SignalC2S;
    try {
      msg = JSON.parse(raw) as SignalC2S;
    } catch {
      this.messagesDropped++;
      conn.fail('bad-request', 'not json');
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
      conn.fail('bad-request');
      return;
    }

    switch (msg.t) {
      case 'host': this.onHost(conn, msg, now); break;
      case 'join': this.onJoin(conn, msg, now); break;
      case 'sdp': this.onSdp(conn, msg, now); break;
      case 'ice': this.onIce(conn, msg, now); break;
      case 'bye': this.onBye(conn, msg); break;
      default: conn.fail('bad-request', 'unknown message'); break;
    }
  }

  private onHost(conn: SignalConnection, msg: { v?: number; cap?: number; label?: string }, now: number): void {
    if (conn.role !== 'idle') { conn.fail('bad-request', 'already in a room'); return; }
    if (msg.v !== SIGNAL_PROTOCOL_VERSION) { conn.fail('bad-version'); return; }
    if (this.rooms.size >= this.maxRooms) { conn.fail('too-many-rooms'); return; }

    const rec = this.recordFor(conn.address, now);
    if (now - rec.roomsWindowStartMs >= 60_000) {
      rec.roomsWindowStartMs = now;
      rec.roomsCreated = 0;
    }
    if (++rec.roomsCreated > MAX_ROOMS_PER_IP_PER_MINUTE) {
      conn.fail('rate-limited', 'too many rooms');
      return;
    }

    const cap = clampInt(msg.cap ?? 1, 1, SIGNAL_MAX_GUESTS);
    const code = this.freshCode();
    if (code === null) { conn.fail('too-many-rooms'); return; }

    conn.role = 'host';
    conn.peerId = HOST_PEER_ID;
    conn.code = code;
    this.rooms.set(code, {
      code,
      host: conn,
      guests: new Map(),
      cap,
      // Stored, never interpreted. Whoever renders it escapes it.
      label: typeof msg.label === 'string' ? msg.label.slice(0, 48) : '',
      createdMs: now,
      lastActivityMs: now,
      nextGuestNumber: 1,
    });
    this.roomsCreated++;
    conn.send({
      t: 'hosted',
      v: SIGNAL_PROTOCOL_VERSION,
      code,
      self: HOST_PEER_ID,
      iceServers: buildIceServers(this.ice, now),
    });
  }

  private onJoin(conn: SignalConnection, msg: { v?: number; code?: string }, now: number): void {
    if (conn.role !== 'idle') { conn.fail('bad-request', 'already in a room'); return; }
    if (msg.v !== SIGNAL_PROTOCOL_VERSION) { conn.fail('bad-version'); return; }

    const code = normaliseRoomCode(typeof msg.code === 'string' ? msg.code : '');
    const room = code === '' ? undefined : this.rooms.get(code);

    if (!room) {
      // A malformed code and a wrong code are the SAME failure on purpose: the
      // response must not tell a scanner which of its guesses were well formed.
      this.countFailedJoin(conn, now);
      this.joinsRefused++;
      conn.fail('no-such-room');
      return;
    }
    if (room.guests.size >= room.cap) {
      // NOT a failed-join strike: this is a real room, the code was correct,
      // and punishing a friend for a full lobby would be nonsense.
      this.joinsRefused++;
      conn.fail('room-full');
      return;
    }
    if (!room.host.socket.isOpen) {
      this.rooms.delete(room.code);
      this.joinsRefused++;
      conn.fail('host-gone');
      return;
    }

    const peerId = `g${room.nextGuestNumber++}`;
    conn.role = 'guest';
    conn.peerId = peerId;
    conn.code = room.code;
    room.guests.set(peerId, conn);
    room.lastActivityMs = now;
    this.joinsAccepted++;

    conn.send({
      t: 'joined',
      v: SIGNAL_PROTOCOL_VERSION,
      code: room.code,
      self: peerId,
      host: HOST_PEER_ID,
      iceServers: buildIceServers(this.ice, now),
    });
    room.host.send({ t: 'peer', peer: peerId });
  }

  private onSdp(conn: SignalConnection, msg: { to?: string; kind?: string; sdp?: string }, now: number): void {
    const target = this.resolveTarget(conn, msg.to);
    if (target === null) return;
    if (msg.kind !== 'offer' && msg.kind !== 'answer') { conn.fail('bad-request', 'bad sdp kind'); return; }
    if (typeof msg.sdp !== 'string' || msg.sdp.length > SIGNAL_MAX_SDP_BYTES) {
      conn.fail('bad-request', 'sdp too large');
      return;
    }
    // Two per peer is offer+answer; a handful more covers one ICE restart.
    if (++conn.sdpsRelayed > 8) { conn.fail('rate-limited', 'too many sdp'); return; }
    this.touch(conn.code, now);
    target.send({ t: 'sdp', from: conn.peerId, kind: msg.kind, sdp: msg.sdp });
  }

  private onIce(
    conn: SignalConnection,
    msg: { to?: string; candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null },
    now: number,
  ): void {
    const target = this.resolveTarget(conn, msg.to);
    if (target === null) return;
    if (typeof msg.candidate !== 'string' || msg.candidate.length > SIGNAL_MAX_CANDIDATE_BYTES) {
      conn.fail('bad-request', 'bad candidate');
      return;
    }
    if (++conn.candidatesRelayed > SIGNAL_MAX_CANDIDATES) return; // silently stop; not an error
    this.touch(conn.code, now);
    target.send({
      t: 'ice',
      from: conn.peerId,
      candidate: msg.candidate,
      sdpMid: typeof msg.sdpMid === 'string' ? msg.sdpMid : null,
      sdpMLineIndex: typeof msg.sdpMLineIndex === 'number' ? msg.sdpMLineIndex : null,
    });
  }

  private onBye(conn: SignalConnection, msg: { to?: string }): void {
    if (typeof msg.to === 'string' && conn.role === 'host') {
      // The host refused a specific guest (room full, joining too fast).
      const room = this.rooms.get(conn.code);
      const guest = room?.guests.get(msg.to);
      if (guest) {
        guest.fail('room-full');
        room?.guests.delete(msg.to);
      }
      return;
    }
    // "I have my DataChannel; I do not need you any more."
    this.detach(conn);
    conn.socket.close(1000, 'signalling done');
  }

  /**
   * Resolve a relay target, enforcing the STAR. A guest may address only the
   * host; the host may address only a guest currently in its own room. There
   * is no path from one guest to another, so this hub can never be repurposed
   * as a general message relay between arbitrary clients.
   */
  private resolveTarget(conn: SignalConnection, to: unknown): SignalConnection | null {
    if (typeof to !== 'string' || to.length === 0 || to.length > 8) {
      conn.fail('bad-request', 'bad target');
      return null;
    }
    const room = this.rooms.get(conn.code);
    if (!room) { conn.fail('no-such-room'); return null; }

    if (conn.role === 'guest') {
      if (to !== HOST_PEER_ID) { conn.fail('bad-request', 'guests may only address the host'); return null; }
      if (!room.host.socket.isOpen) { conn.fail('host-gone'); return null; }
      return room.host;
    }
    if (conn.role === 'host') {
      const guest = room.guests.get(to);
      if (!guest || !guest.socket.isOpen) { conn.fail('bad-request', 'no such peer'); return null; }
      return guest;
    }
    conn.fail('bad-request', 'not in a room');
    return null;
  }

  /* -------------------------------------------------------------- *
   * Rate limiting
   * -------------------------------------------------------------- */

  private recordFor(address: string, now: number): AddressRecord {
    let rec = this.addresses.get(address);
    if (!rec) {
      rec = {
        sockets: 0,
        tokens: MESSAGE_BURST,
        lastRefillMs: now,
        roomsWindowStartMs: now,
        roomsCreated: 0,
        failedWindowStartMs: now,
        failedJoins: 0,
        banUntilMs: 0,
        banStrikes: 0,
      };
      this.addresses.set(address, rec);
    }
    return rec;
  }

  /** Token bucket. Returns false when the message must be dropped. */
  private spendToken(conn: SignalConnection, now: number): boolean {
    const rec = this.recordFor(conn.address, now);
    const elapsed = now - rec.lastRefillMs;
    if (elapsed > 0) {
      rec.lastRefillMs = now;
      rec.tokens = Math.min(MESSAGE_BURST, rec.tokens + (elapsed / 1000) * SIGNAL_MAX_MESSAGES_PER_SECOND);
    }
    if (rec.tokens < 1) {
      this.messagesDropped++;
      this.kick(conn, 'rate-limited', 'too many messages');
      return false;
    }
    rec.tokens -= 1;
    return true;
  }

  /**
   * A wrong code is the enumeration signal. Count it, and once an address has
   * spent its allowance, ban it for a doubling interval — the second layer of
   * the "40 bits is enough" argument in shared/src/signal.ts.
   */
  private countFailedJoin(conn: SignalConnection, now: number): void {
    const rec = this.recordFor(conn.address, now);
    if (now - rec.failedWindowStartMs >= 60_000) {
      rec.failedWindowStartMs = now;
      rec.failedJoins = 0;
    }
    if (++rec.failedJoins <= MAX_FAILED_JOINS_PER_MINUTE) return;
    rec.banStrikes++;
    rec.banUntilMs = now + Math.min(MAX_BAN_MS, BASE_BAN_MS * Math.pow(2, rec.banStrikes - 1));
    this.kick(conn, 'rate-limited', 'too many bad room codes');
  }

  private kick(conn: SignalConnection, code: SignalErrorCode, detail: string): void {
    conn.fail(code, detail);
    this.detach(conn);
    conn.socket.close(1008, detail);
  }

  /* -------------------------------------------------------------- *
   * Housekeeping
   * -------------------------------------------------------------- */

  private touch(code: string, now: number): void {
    const room = this.rooms.get(code);
    if (room) room.lastActivityMs = now;
  }

  /**
   * Pick a code that is not already live. One collision in 1.1e12 is not
   * worth a loop, but a loop costs nothing and removes the question.
   */
  private freshCode(): string | null {
    for (let i = 0; i < 8; i++) {
      const code = this.codeSource();
      if (code.length === ROOM_CODE_LENGTH && !this.rooms.has(code)) return code;
    }
    return null;
  }

  /** Drop idle rooms and forgotten address records. Call about once a minute. */
  sweep(nowMs = this.now()): void {
    for (const [code, room] of this.rooms) {
      const dead = !room.host.socket.isOpen;
      if (dead || nowMs - room.lastActivityMs > SIGNAL_ROOM_IDLE_MS) {
        for (const g of room.guests.values()) g.fail('host-gone');
        this.rooms.delete(code);
      }
    }
    for (const [address, rec] of this.addresses) {
      if (rec.sockets > 0) continue;
      if (nowMs < rec.banUntilMs) continue;
      if (nowMs - rec.lastRefillMs < SIGNAL_ROOM_IDLE_MS) continue;
      this.addresses.delete(address);
    }
  }

  stats(): SignalHubStats {
    let guestsConnected = 0;
    let banned = 0;
    const now = this.now();
    for (const r of this.rooms.values()) guestsConnected += r.guests.size;
    for (const rec of this.addresses.values()) if (now < rec.banUntilMs) banned++;
    return {
      rooms: this.rooms.size,
      connections: this.connections.size,
      guestsConnected,
      roomsCreated: this.roomsCreated,
      joinsAccepted: this.joinsAccepted,
      joinsRefused: this.joinsRefused,
      bannedAddresses: banned,
      messagesDropped: this.messagesDropped,
    };
  }

  /** Test and shutdown helper. */
  closeAll(code = 1001, reason = 'shutting down'): void {
    for (const conn of [...this.connections]) {
      this.detach(conn);
      try { conn.socket.close(code, reason); } catch { /* already gone */ }
    }
    this.rooms.clear();
  }

  /** For tests: does this code exist right now? */
  hasRoom(code: string): boolean { return this.rooms.has(code); }
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = Number.isFinite(v) ? Math.floor(v) : lo;
  return n < lo ? lo : n > hi ? hi : n;
}

/* ------------------------------------------------------------------------ *
 * Wiring to the existing `ws` server
 * ------------------------------------------------------------------------ */

/** The bits of a `ws` WebSocket this adapter needs. */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', cb: (data: unknown, isBinary: boolean) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: () => void): void;
}

/**
 * Attach one upgraded WebSocket to the hub. Called from the `upgrade` handler
 * in index.ts for `SIGNAL_PATH`; the game socket on `WS_PATH` is untouched.
 */
export function attachSignalSocket(hub: SignalHub, ws: WsLike, address: string): void {
  const socket: SignalSocket = {
    get isOpen(): boolean { return ws.readyState === 1; },
    send(text: string): void { if (ws.readyState === 1) ws.send(text); },
    close(code = 1000, reason = ''): void {
      try { ws.close(code, reason); } catch { /* already closing */ }
    },
  };
  const conn = hub.attach(socket, address);
  if (conn === null) return; // `attach` already closed it.

  ws.on('message', (data: unknown, isBinary: boolean) => {
    // Signalling is text-only. A binary frame here is either a bug or a probe.
    if (isBinary) return;
    hub.receive(conn, String(data));
  });
  ws.on('close', () => { hub.detach(conn); });
  ws.on('error', () => { hub.detach(conn); });
}

/** A random opaque id, for logs that must not contain a room code. */
export function traceId(): string {
  return randomBytes(6).toString('hex');
}

/** Exported so a test can prove the code space is what the comments claim. */
export function roomCodeSpace(): number {
  return Math.pow(ROOM_CODE_ALPHABET.length, ROOM_CODE_LENGTH);
}
