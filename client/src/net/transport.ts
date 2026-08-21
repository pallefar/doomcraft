/**
 * DOOMCRAFT — the transport seam.
 *
 * `NetClient` (client.ts) and the authoritative room (server/src/net.ts) have
 * always talked to each other through two tiny interfaces:
 *
 *     ClientTransport   what NetClient needs from a pipe
 *     ServerTransport   what NetHub needs from a socket  (server/src/net.ts
 *                       calls the same shape `NetTransport`)
 *
 * That is why `localServer.ts` can run the WHOLE authoritative stack in a Web
 * Worker and the client cannot tell it apart from a remote server. This file
 * makes the seam explicit and gives it a third implementation — WebRTC — while
 * keeping the protocol and the simulation single-sourced. Nothing in this file
 * knows what a packet means; it only knows how a packet must be delivered.
 *
 * THE ONE THING THIS FILE DECIDES: reliability per message id.
 *
 * A WebSocket is reliable and ordered for everything, and that is exactly what
 * hurts on a 20 Hz shooter: one lost snapshot head-of-line-blocks every
 * snapshot behind it, so a 200 ms retransmit freezes the world for 200 ms and
 * then fast-forwards it. WebRTC lets us say "this packet is worthless if it is
 * late" per message. Getting that split wrong is the single most common
 * mistake in browser P2P games, in both directions:
 *
 *   - everything reliable  -> no latency win at all over the WebSocket we
 *     already have, and you paid for ICE, TURN and a whole new failure class
 *     to get nothing;
 *   - everything unreliable -> a lost `S2C.CHUNK` is a permanently missing
 *     piece of world and a lost `S2C.BLOCK_DELTA` is a wall that is solid on
 *     one screen and not on another, forever.
 *
 * The rule that decides it: **a message is unreliable if and only if the next
 * one of its kind fully replaces it.**
 *
 *   S2C.SNAPSHOT   superseded 20x/s. Late is worse than lost.        UNRELIABLE
 *   S2C.PONG       superseded 1x/s; a retransmitted pong would also
 *                  poison the RTT estimate with its own queue delay. UNRELIABLE
 *   C2S.INPUT      superseded 60x/s, carries its own `seq`, and
 *                  `net.ts` onInput drops anything at or behind
 *                  `lastAcceptedSeq` anyway.                         UNRELIABLE
 *   C2S.PING       same as PONG.                                     UNRELIABLE
 *   everything else                                                  RELIABLE
 *
 * `S2C_MODE.STATE` looks like a snapshot sidecar but is NOT superseded — the
 * room sends it only when a field actually changed (see shared/src/modes.ts),
 * so a lost one is wrong until the next change, which may be the end of the
 * match. It is reliable.
 */

import { C2S, S2C } from '@shared';
import { C2S_MODE, S2C_MODE } from '@shared/modes';

/* ------------------------------------------------------------------------ *
 * Transport interfaces
 * ------------------------------------------------------------------------ */

/** Mirrors `WebSocket.readyState`, so a raw socket satisfies the interface. */
export const enum TransportState { CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3 }

/** Which pipe a transport is really made of. Telemetry and UI only. */
export type TransportKind = 'websocket' | 'worker' | 'webrtc' | 'memory';

/** Everything NetClient needs from a pipe. A WebSocket and a Worker both fit. */
export interface ClientTransport {
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((data: ArrayBuffer | Uint8Array) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
  onerror: ((err: unknown) => void) | null;
  /** Optional so the three existing implementations stayed unchanged. */
  readonly kind?: TransportKind;
}

/**
 * Everything the authoritative room needs from a socket. Structurally
 * identical to `NetTransport` in server/src/net.ts — declared again here so
 * the client bundle never imports the server package just for a type, and
 * asserted equal in transport.test.ts so the two cannot drift.
 */
export interface ServerTransport {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly isOpen: boolean;
  /** Bytes still queued for the wire. Return 0 when the transport cannot tell. */
  readonly bufferedAmount: number;
}

/* ------------------------------------------------------------------------ *
 * Reliability routing
 * ------------------------------------------------------------------------ */

export const enum Reliability {
  /** Send once, never retransmit, deliver out of order. */
  UNRELIABLE = 0,
  /** Retransmit until delivered, deliver in order. */
  RELIABLE = 1,
}

/**
 * Which channel a client->server packet belongs on.
 *
 * `bytes[0]` is the message id for every packet in the protocol — see
 * `readMessageId` in shared/src/protocol.ts — including the mode extension,
 * which deliberately numbered itself 16..18 so a dispatcher can stay flat.
 */
export function clientMessageReliability(messageId: number): Reliability {
  switch (messageId) {
    case C2S.INPUT:
    case C2S.PING:
      return Reliability.UNRELIABLE;
    // HELLO, BLOCK_EDIT, CHAT, RESPAWN, APPEARANCE, MODE.SELECT, MODE.ACTION.
    // Every one of them is a one-shot the room can never re-derive.
    default:
      return Reliability.RELIABLE;
  }
}

/** Which channel a server->client packet belongs on. */
export function serverMessageReliability(messageId: number): Reliability {
  switch (messageId) {
    case S2C.SNAPSHOT:
    case S2C.PONG:
      return Reliability.UNRELIABLE;
    // WELCOME, CHUNK, BLOCK_DELTA, DAMAGE, KILL, CHAT, MODE.STATE/EVENT/CONTEXT.
    default:
      return Reliability.RELIABLE;
  }
}

/** For logs and the net debug overlay. */
export function reliabilityName(r: Reliability): string {
  return r === Reliability.RELIABLE ? 'reliable' : 'unreliable';
}

/* ------------------------------------------------------------------------ *
 * Transport control messages
 *
 * The unreliable channel gives no loss signal — that is the whole point of it
 * — so the receiver has to notice a gap itself and ask for repair. Repair
 * requests are NOT game protocol: they are transport bookkeeping, they never
 * reach `net.ts` or `client.ts`, and they are stripped before the bytes are
 * handed up. To keep them unmistakable they start with an id the game
 * protocol can never produce: the base protocol uses 1..8 and the mode
 * extension 16..18, with 9..15 explicitly reserved for the base protocol to
 * grow into (shared/src/modes.ts). 0xFE is outside every one of those.
 * ------------------------------------------------------------------------ */

/** First byte of a transport control frame. Never a valid protocol id. */
export const TRANSPORT_CTRL = 0xfe;

export const enum CtrlType {
  /**
   * "I missed snapshots; my delta baseline is unusable." The peer host answers
   * by forcing the next snapshot to be a full one. See peerHost.ts.
   */
  RESYNC = 1,
  /**
   * "I am leaving, on purpose, right now." Turns a 15-second silent hang into
   * an immediate, explained end of match. See the host-migration note in
   * peerHost.ts.
   */
  BYE = 2,
  /** Liveness probe, so host death is detected in ~3 s instead of ~15 s. */
  ALIVE = 3,
}

/** Build a control frame. `arg` is a u32 payload, meaning depends on `type`. */
export function encodeCtrl(type: CtrlType, arg = 0): Uint8Array {
  const b = new Uint8Array(6);
  b[0] = TRANSPORT_CTRL;
  b[1] = type & 0xff;
  b[2] = arg & 0xff;
  b[3] = (arg >>> 8) & 0xff;
  b[4] = (arg >>> 16) & 0xff;
  b[5] = (arg >>> 24) & 0xff;
  return b;
}

export interface CtrlFrame { type: CtrlType; arg: number }

/** Null when `bytes` is game protocol rather than transport control. */
export function decodeCtrl(bytes: Uint8Array): CtrlFrame | null {
  if (bytes.length < 6 || bytes[0] !== TRANSPORT_CTRL) return null;
  const arg = (bytes[2] | (bytes[3] << 8) | (bytes[4] << 16) | (bytes[5] << 24)) >>> 0;
  return { type: bytes[1] as CtrlType, arg };
}

/** True for anything that must not be handed to the protocol decoders. */
export function isCtrlFrame(bytes: Uint8Array): boolean {
  return bytes.length > 0 && bytes[0] === TRANSPORT_CTRL;
}

/* ------------------------------------------------------------------------ *
 * Datagram sequencing
 *
 * SCTP in `maxRetransmits: 0, ordered: false` mode delivers what arrives and
 * says nothing about what did not. A 2-byte wrapping counter in front of each
 * unreliable datagram is the cheapest thing that turns "silence" into "you
 * lost 3". It costs 2 bytes against the 93 bytes of IP+UDP+DTLS+SCTP framing
 * every WebRTC datagram already pays, i.e. 2.1%.
 *
 * The counter is transport framing, not protocol: it is added on send and
 * removed on receive, and `net.ts` and `client.ts` never see it.
 * ------------------------------------------------------------------------ */

export const SEQ_HEADER_BYTES = 2;
const SEQ_MODULO = 0x10000;

/** Prefix `payload` with a 16-bit little-endian sequence number. */
export function frameDatagram(seq: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + SEQ_HEADER_BYTES);
  out[0] = seq & 0xff;
  out[1] = (seq >>> 8) & 0xff;
  out.set(payload, SEQ_HEADER_BYTES);
  return out;
}

/**
 * Signed distance from `from` to `to` on a 16-bit wrapping counter, in
 * (-32768, 32768]. Positive means `to` is newer.
 */
export function seqDelta(from: number, to: number): number {
  let d = (to - from) & 0xffff;
  if (d >= SEQ_MODULO / 2) d -= SEQ_MODULO;
  return d;
}

/** Tracks a wrapping datagram counter and counts what never showed up. */
export class DatagramCounter {
  /** Next sequence number this side will send. */
  private outSeq = 0;
  /** Highest sequence seen, or -1 before the first datagram. */
  private highest = -1;
  /** Datagrams that never arrived. */
  lost = 0;
  /** Datagrams that arrived out of order (already superseded, so dropped). */
  reordered = 0;
  /** Datagrams accepted and handed up. */
  received = 0;

  next(): number {
    const s = this.outSeq;
    this.outSeq = (s + 1) & 0xffff;
    return s;
  }

  /**
   * Account for an arrival. Returns the number of datagrams that went missing
   * immediately before this one (0 when nothing was lost), or -1 when this
   * datagram is itself stale and must be dropped.
   *
   * Dropping the stale one matters: on an unordered channel a snapshot that
   * overtook a newer snapshot would rewind every remote player by 50 ms.
   */
  accept(seq: number): number {
    if (this.highest < 0) {
      this.highest = seq;
      this.received++;
      return 0;
    }
    const d = seqDelta(this.highest, seq);
    if (d <= 0) {
      this.reordered++;
      return -1;
    }
    this.highest = seq;
    this.received++;
    const gap = d - 1;
    this.lost += gap;
    return gap;
  }

  reset(): void {
    this.highest = -1;
    this.lost = 0;
    this.reordered = 0;
    this.received = 0;
  }

  /** Fraction of datagrams that never arrived. 0 before anything arrives. */
  get lossRate(): number {
    const total = this.received + this.lost;
    return total === 0 ? 0 : this.lost / total;
  }
}

/* ------------------------------------------------------------------------ *
 * WebSocket implementation
 * ------------------------------------------------------------------------ */

/** Wrap a browser WebSocket as a ClientTransport. */
export function webSocketTransport(url: string): ClientTransport {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const t: ClientTransport = {
    kind: 'websocket',
    get readyState(): number { return ws.readyState; },
    send(data: Uint8Array): void {
      if (ws.readyState === 1) ws.send(data);
    },
    close(code?: number, reason?: string): void {
      try { ws.close(code, reason); } catch { /* already closed */ }
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = (): void => { t.onopen?.(); };
  ws.onmessage = (ev: MessageEvent): void => { t.onmessage?.(ev.data as ArrayBuffer); };
  ws.onclose = (ev: CloseEvent): void => { t.onclose?.(ev.code, ev.reason); };
  ws.onerror = (ev: Event): void => { t.onerror?.(ev); };
  return t;
}

/** The URL the game server lives at, in dev and in production. */
export function defaultServerUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

/* ------------------------------------------------------------------------ *
 * In-memory pair — used by the worker server, by peerHost's loopback and by
 * every test that wants the real Room without a real socket.
 * ------------------------------------------------------------------------ */

export interface MemoryTransportPair {
  readonly client: ClientTransport;
  readonly server: ServerTransport;
  /** Close both halves. `code`/`reason` reach the client's `onclose`. */
  close(code?: number, reason?: string): void;
}

/**
 * A ClientTransport and a ServerTransport wired straight to each other.
 * Delivery is synchronous and lossless; `deliverToServer` is called with every
 * byte the client sends, so the caller decides what the room does with it.
 */
export function memoryTransportPair(
  deliverToServer: (bytes: Uint8Array) => void,
): MemoryTransportPair {
  let open = true;

  const client: ClientTransport = {
    kind: 'memory',
    get readyState(): number { return open ? TransportState.OPEN : TransportState.CLOSED; },
    send(data: Uint8Array): void {
      if (!open) return;
      // The writers reuse their buffers, so copy before the bytes leave.
      deliverToServer(data.slice());
    },
    close(code = 1000, reason = 'closed'): void { pair.close(code, reason); },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  const server: ServerTransport = {
    get isOpen(): boolean { return open; },
    get bufferedAmount(): number { return 0; },
    send(data: Uint8Array): void {
      if (!open) return;
      client.onmessage?.(data.slice());
    },
    close(code = 1000, reason = 'closed'): void { pair.close(code, reason); },
  };

  const pair: MemoryTransportPair = {
    client,
    server,
    close(code = 1000, reason = 'closed'): void {
      if (!open) return;
      open = false;
      client.onclose?.(code, reason);
    },
  };
  return pair;
}
