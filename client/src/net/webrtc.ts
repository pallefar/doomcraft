/**
 * DOOMCRAFT — WebRTC transport.
 *
 * The same binary protocol as the WebSocket and the Worker, over an
 * RTCDataChannel pair. `client.ts` and `server/src/net.ts` are not modified
 * and not forked: this file produces a `ClientTransport` for the guest and a
 * `ServerTransport` for the host, and those two interfaces are the entire
 * contract (see transport.ts).
 *
 * TWO CHANNELS, AND WHY
 *
 *   dc0  unreliable, unordered   { ordered: false, maxRetransmits: 0 }
 *        snapshots (20 Hz) and input (60 Hz). Both are superseded faster than
 *        a retransmit can arrive, so a retransmit is not a repair — it is a
 *        stall. On a single reliable channel one lost snapshot holds back
 *        every snapshot behind it: the world freezes for a round trip and
 *        then fast-forwards. That is the failure this file exists to avoid,
 *        and it is the reason "just use a reliable DataChannel" buys nothing
 *        over the WebSocket we already have.
 *
 *   dc1  reliable, ordered       { ordered: true }
 *        the world stream (S2C.CHUNK), block deltas, HELLO/WELCOME, chat,
 *        kills, damage and the mode sidecar. Every one of these is a one-shot
 *        that nothing later re-sends; losing one is permanent. Head-of-line
 *        blocking is the correct behaviour here.
 *
 * Both channels are `negotiated: true` with fixed stream ids, so each side
 * creates both up front and there is no `ondatachannel` race to lose.
 *
 * WHAT AN UNRELIABLE CHANNEL COSTS YOU, AND HOW IT IS PAID
 *
 * `server/src/net.ts` advances the delta baseline at SEND time (`sendSnapshot`
 * rolls `conn.baseline` forward unconditionally) with no acknowledgement. On a
 * reliable transport that is correct and free. On an unreliable one a lost
 * snapshot leaves the client decoding player deltas against a baseline it
 * never received, and the only recovery is `FULL_SNAPSHOT_INTERVAL_MS` — up to
 * three seconds of a wrong world.
 *
 * We do NOT fix that by editing the delta encoder, because `net.ts` must stay
 * a single implementation shared by the real server and the peer host. We fix
 * it one layer down, where the loss is actually visible:
 *
 *   1. every unreliable datagram carries a 2-byte wrapping sequence number
 *      (transport framing, stripped before the bytes reach the protocol);
 *   2. the receiver notices a gap;
 *   3. the guest sends a RESYNC control frame on the RELIABLE channel;
 *   4. `peerHost.ts` answers by setting `conn.baselineTick = 0`, which is the
 *      public field `net.ts` already checks to decide "send a full snapshot".
 *
 * Nothing in `net.ts`, `client.ts` or `protocol.ts` changes. Worst case is one
 * round trip of stale player positions instead of three seconds, and requests
 * are rate limited so a lossy link cannot beg for a full snapshot 20x/s.
 *
 * Note the one thing that is NOT at risk: entities and projectiles are already
 * transmitted in full every snapshot (`net.ts` sets `EF_SPAWN | EF_ALL` and
 * `RF_SPAWN | RF_ALL` unconditionally — the egress bug the cost assessment
 * wants fixed), so only the player records are delta coded. When that bug is
 * fixed the resync path above is what keeps this transport correct, which is
 * why it is built now rather than later.
 */

import {
  ClientTransport,
  CtrlType,
  DatagramCounter,
  Reliability,
  SEQ_HEADER_BYTES,
  ServerTransport,
  TransportState,
  clientMessageReliability,
  decodeCtrl,
  encodeCtrl,
  frameDatagram,
  isCtrlFrame,
  serverMessageReliability,
} from './transport.js';
import {
  HOST_PEER_ID,
  SIGNAL_MAX_CANDIDATES,
  SIGNAL_PROTOCOL_VERSION,
  normaliseRoomCode,
  type IceServerConfig,
  type SignalC2S,
  type SignalErrorCode,
  type SignalS2C,
} from '@shared/signal';

/* ------------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------------ */

/** SCTP stream ids. Both sides must agree; that is what `negotiated` means. */
export const CHANNEL_ID_UNRELIABLE = 0;
export const CHANNEL_ID_RELIABLE = 1;

/**
 * Floor on how often a guest may ask for a full snapshot. A full snapshot is
 * roughly 2-3x a delta, so on a 10% loss link an unthrottled resync request
 * would cost more bandwidth than the loss it repairs.
 */
export const RESYNC_MIN_INTERVAL_MS = 250;

/** Liveness probe on the reliable channel, for lulls in game traffic. */
export const ALIVE_INTERVAL_MS = 1000;

/**
 * Declare the peer dead after this much total silence — on EITHER channel, so
 * 20 Hz snapshots or 60 Hz input keep it disarmed for free during play.
 *
 * This is deliberately far below `CLIENT_TIMEOUT_MS` (15 s), which is the
 * floor a host death would otherwise hit: a closed laptop lid sends no FIN, so
 * to every guest it is indistinguishable from packet loss and the match simply
 * hangs. Three seconds is about as low as this can honestly go — a mobile
 * radio handover can black-hole a link for well over a second, and ending the
 * match on a handover would be a worse bug than the one being fixed.
 */
export const PEER_SILENCE_MS = 3000;

/** ICE + DTLS must complete inside this or the join is reported as failed. */
export const HANDSHAKE_TIMEOUT_MS = 20000;

/**
 * Reliable messages larger than this are fragmented. 64 KB is the SCTP
 * message-size floor every implementation guarantees; the real limit is read
 * from `pc.sctp.maxMessageSize` when the browser exposes it.
 *
 * This is not theoretical. A chunk is CHUNK_VOLUME = 65,536 voxels and
 * `encodeChunk` run-length codes them, so the worst case is `rleMaxBytes` =
 * 196,608 bytes — three times the floor. Sending one oversized message does
 * not truncate it, it CLOSES THE DATA CHANNEL, which would look like a random
 * mid-match disconnect on exactly the worlds players built the most in.
 */
export const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024;

/** Ceiling on a half-assembled fragmented message, so a peer cannot OOM us. */
export const MAX_REASSEMBLY_BYTES = 512 * 1024;

/** First byte of a fragment header. Outside the protocol id space, like 0xFE. */
const FRAGMENT_TAG = 0xfd;
const FRAGMENT_HEADER_BYTES = 4;

/* ------------------------------------------------------------------------ *
 * Structural mirrors of the WebRTC API
 *
 * Typed structurally rather than against lib.dom for two reasons: this module
 * has to be unit-testable in Node, where there is no RTCPeerConnection, and a
 * fake implementation is the only way to test packet loss deterministically.
 * `browserRtc()` below is the single place that touches the real API.
 * ------------------------------------------------------------------------ */

export interface RtcSessionDescriptionLike { type: string; sdp?: string }
export interface RtcIceCandidateLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export interface RtcDataChannelInitLike {
  ordered?: boolean;
  maxRetransmits?: number;
  negotiated?: boolean;
  id?: number;
  protocol?: string;
}

export interface RtcDataChannelLike {
  readonly label: string;
  readonly readyState: string;
  binaryType: string;
  readonly bufferedAmount: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
  onmessage: ((ev: { data: ArrayBuffer | Uint8Array | unknown }) => void) | null;
  send(data: ArrayBuffer | Uint8Array): void;
  close(): void;
}

export interface RtcStatsLike { forEach(cb: (value: Record<string, unknown>) => void): void }

export interface RtcPeerConnectionLike {
  readonly connectionState: string;
  readonly iceConnectionState: string;
  readonly sctp?: { readonly maxMessageSize: number } | null;
  createDataChannel(label: string, init?: RtcDataChannelInitLike): RtcDataChannelLike;
  createOffer(options?: { iceRestart?: boolean }): Promise<RtcSessionDescriptionLike>;
  createAnswer(): Promise<RtcSessionDescriptionLike>;
  setLocalDescription(desc?: RtcSessionDescriptionLike): Promise<void>;
  setRemoteDescription(desc: RtcSessionDescriptionLike): Promise<void>;
  addIceCandidate(candidate: RtcIceCandidateLike): Promise<void>;
  getStats?(): Promise<RtcStatsLike>;
  close(): void;
  onicecandidate: ((ev: { candidate: RtcIceCandidateLike | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
}

export interface RtcConfigLike {
  iceServers?: IceServerConfig[];
  iceTransportPolicy?: 'all' | 'relay';
  bundlePolicy?: string;
}

export type RtcFactory = (config: RtcConfigLike) => RtcPeerConnectionLike;

/**
 * The real browser API, behind one cast.
 *
 * The cast is deliberate and is the only one in the file: lib.dom types
 * `createOffer` with overloads and `binaryType` as a string union, and fighting
 * that variance in five places would be noise. Everything downstream of here
 * is checked against the structural interfaces above.
 */
export function browserRtc(): RtcFactory {
  return (config: RtcConfigLike): RtcPeerConnectionLike => {
    const Ctor = (globalThis as unknown as { RTCPeerConnection?: new (c: unknown) => unknown }).RTCPeerConnection;
    if (!Ctor) throw new Error('WebRTC is not available in this browser');
    return new Ctor({
      iceServers: config.iceServers ?? [],
      iceTransportPolicy: config.iceTransportPolicy ?? 'all',
      bundlePolicy: config.bundlePolicy ?? 'balanced',
    }) as unknown as RtcPeerConnectionLike;
  };
}

/** True when this browser can do WebRTC data channels at all. */
export function webRtcSupported(): boolean {
  const g = globalThis as unknown as { RTCPeerConnection?: unknown };
  return typeof g.RTCPeerConnection === 'function';
}

/* ------------------------------------------------------------------------ *
 * Signalling seam
 * ------------------------------------------------------------------------ */

/** A two-way JSON pipe to the signalling hub. Injectable, so tests need no server. */
export interface SignalPort {
  send(msg: SignalC2S): void;
  onMessage: ((msg: SignalS2C) => void) | null;
  onClose: (() => void) | null;
  readonly open: boolean;
  close(): void;
}

/** Signalling over a WebSocket to `server/src/signal.ts`. */
export function webSocketSignalPort(url: string): SignalPort {
  const ws = new WebSocket(url);
  const queued: SignalC2S[] = [];
  const port: SignalPort = {
    get open(): boolean { return ws.readyState === 1; },
    send(msg: SignalC2S): void {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
      else if (ws.readyState === 0 && queued.length < 32) queued.push(msg);
    },
    onMessage: null,
    onClose: null,
    close(): void { try { ws.close(); } catch { /* already gone */ } },
  };
  ws.onopen = (): void => {
    for (const m of queued) ws.send(JSON.stringify(m));
    queued.length = 0;
  };
  ws.onmessage = (ev: MessageEvent): void => {
    if (typeof ev.data !== 'string') return;
    try { port.onMessage?.(JSON.parse(ev.data) as SignalS2C); } catch { /* junk */ }
  };
  ws.onclose = (): void => { port.onClose?.(); };
  ws.onerror = (): void => { /* onclose always follows */ };
  return port;
}

/** Default signalling URL, alongside the game WebSocket. */
export function defaultSignalUrl(path = '/rtc'): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${path}`;
}

/* ------------------------------------------------------------------------ *
 * Fragmentation for the reliable channel
 * ------------------------------------------------------------------------ */

/**
 * Split `payload` for an ordered reliable channel. Because the channel is
 * ordered and reliable, reassembly is a plain append — there is no need for
 * offsets, only a "this is the last piece" bit. The index is carried anyway so
 * a desynchronised stream is detected instead of silently concatenated.
 */
function fragment(payload: Uint8Array, maxBytes: number): Uint8Array[] {
  const room = maxBytes - FRAGMENT_HEADER_BYTES;
  const out: Uint8Array[] = [];
  for (let off = 0, idx = 0; off < payload.length; off += room, idx++) {
    const end = Math.min(payload.length, off + room);
    const last = end === payload.length ? 1 : 0;
    const piece = new Uint8Array(FRAGMENT_HEADER_BYTES + (end - off));
    piece[0] = FRAGMENT_TAG;
    piece[1] = last;
    piece[2] = idx & 0xff;
    piece[3] = (idx >>> 8) & 0xff;
    piece.set(payload.subarray(off, end), FRAGMENT_HEADER_BYTES);
    out.push(piece);
  }
  return out;
}

class Reassembler {
  private parts: Uint8Array[] = [];
  private bytes = 0;
  private nextIdx = 0;

  /**
   * Returns the completed message, or null while more fragments are expected.
   * Throws when the stream is inconsistent or oversized — the caller closes
   * the link, because a half-applied world stream is worse than a clean end.
   */
  push(frame: Uint8Array): Uint8Array | null {
    const last = frame[1] === 1;
    const idx = frame[2] | (frame[3] << 8);
    if (idx !== this.nextIdx) { this.reset(); throw new Error('fragment out of order'); }
    const body = frame.subarray(FRAGMENT_HEADER_BYTES);
    this.bytes += body.length;
    if (this.bytes > MAX_REASSEMBLY_BYTES) { this.reset(); throw new Error('fragment overflow'); }
    this.parts.push(body);
    this.nextIdx++;
    if (!last) return null;
    const out = new Uint8Array(this.bytes);
    let off = 0;
    for (const p of this.parts) { out.set(p, off); off += p.length; }
    this.reset();
    return out;
  }

  reset(): void { this.parts = []; this.bytes = 0; this.nextIdx = 0; }
}

/* ------------------------------------------------------------------------ *
 * PeerLink — one WebRTC connection, shared by both roles
 * ------------------------------------------------------------------------ */

export type PeerRole = 'offerer' | 'answerer';

export interface PeerLinkOptions {
  /** The guest offers, the host answers. */
  role: PeerRole;
  /** Peer id of the far side, as the signalling hub numbered it. */
  remoteId: string;
  signal: SignalPort;
  iceServers?: IceServerConfig[];
  /** Force every candidate through TURN. Diagnostics only — never ship it on. */
  relayOnly?: boolean;
  rtc?: RtcFactory;
  /** Monotonic milliseconds. Injected by tests. */
  now?: () => number;
  /** False in tests, which drive `pump()` themselves. */
  autoPump?: boolean;
  /** Ask the far side for a full snapshot after loss. Guests only. */
  requestResyncOnLoss?: boolean;
}

export interface PeerLinkStats {
  readonly state: string;
  readonly datagramsSent: number;
  readonly datagramsReceived: number;
  readonly datagramsLost: number;
  readonly datagramsReordered: number;
  readonly lossRate: number;
  readonly reliableSent: number;
  readonly reliableReceived: number;
  readonly resyncsRequested: number;
  readonly resyncsServed: number;
  readonly fragmentsSent: number;
  /** Null until the first `probeRelay()` resolves. */
  readonly relayed: boolean | null;
}

/**
 * One peer-to-peer connection. Owns the RTCPeerConnection, both channels, the
 * datagram sequencing, the loss repair handshake and liveness.
 *
 * It knows nothing about the game: bytes in, bytes out, plus a reliability
 * decision taken by the routing table in transport.ts.
 */
export class PeerLink {
  readonly role: PeerRole;
  readonly remoteId: string;

  /** Game bytes, control frames already stripped. */
  onData: ((bytes: Uint8Array) => void) | null = null;
  /** The far side asked for a full snapshot. Host wires this to `net.ts`. */
  onResyncRequest: (() => void) | null = null;
  onOpen: (() => void) | null = null;
  onClose: ((code: number, reason: string) => void) | null = null;
  onError: ((err: unknown) => void) | null = null;

  private readonly pc: RtcPeerConnectionLike;
  private readonly unreliable: RtcDataChannelLike;
  private readonly reliable: RtcDataChannelLike;
  private readonly signal: SignalPort;
  private readonly now: () => number;
  private readonly wantResync: boolean;

  private readonly outCounter = new DatagramCounter();
  private readonly inCounter = new DatagramCounter();
  private readonly reassembler = new Reassembler();

  private opened = false;
  private closed = false;
  private closeCode = 1000;
  private closeReason = '';
  private lastRecvMs: number;
  private lastAliveSentMs: number;
  private lastResyncMs = -1e9;
  private readonly startedMs: number;
  private iceRestarts = 0;
  private remoteDescriptionSet = false;
  private readonly pendingRemoteIce: RtcIceCandidateLike[] = [];
  private candidatesSent = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES;

  /* --- counters, surfaced through `stats()` --- */
  private reliableSent = 0;
  private reliableReceived = 0;
  private resyncsRequested = 0;
  private resyncsServed = 0;
  private fragmentsSent = 0;
  private relayed: boolean | null = null;

  constructor(options: PeerLinkOptions) {
    this.role = options.role;
    this.remoteId = options.remoteId;
    this.signal = options.signal;
    this.now = options.now ?? (() => Date.now());
    this.wantResync = options.requestResyncOnLoss ?? (options.role === 'offerer');
    this.startedMs = this.now();
    this.lastRecvMs = this.startedMs;
    this.lastAliveSentMs = this.startedMs;

    const make = options.rtc ?? browserRtc();
    this.pc = make({
      iceServers: options.iceServers ?? [],
      iceTransportPolicy: options.relayOnly ? 'relay' : 'all',
    });

    // Negotiated channels: both sides create both, with matching stream ids,
    // so neither has to wait for an `ondatachannel` that may never fire.
    this.unreliable = this.pc.createDataChannel('dc-rt', {
      ordered: false,
      maxRetransmits: 0,
      negotiated: true,
      id: CHANNEL_ID_UNRELIABLE,
      protocol: 'doomcraft/rt',
    });
    this.reliable = this.pc.createDataChannel('dc-rel', {
      ordered: true,
      negotiated: true,
      id: CHANNEL_ID_RELIABLE,
      protocol: 'doomcraft/rel',
    });
    this.unreliable.binaryType = 'arraybuffer';
    this.reliable.binaryType = 'arraybuffer';

    this.unreliable.onmessage = (ev): void => { this.onUnreliable(ev.data); };
    this.reliable.onmessage = (ev): void => { this.onReliable(ev.data); };
    this.unreliable.onopen = (): void => { this.maybeOpen(); };
    this.reliable.onopen = (): void => { this.maybeOpen(); };
    this.unreliable.onclose = (): void => { this.close(1006, 'unreliable channel closed'); };
    this.reliable.onclose = (): void => { this.close(1006, 'reliable channel closed'); };
    this.unreliable.onerror = (e): void => { this.onError?.(e); };
    this.reliable.onerror = (e): void => { this.onError?.(e); };

    this.pc.onicecandidate = (ev): void => {
      if (!ev.candidate) return;
      if (this.candidatesSent++ >= SIGNAL_MAX_CANDIDATES) return;
      this.signal.send({
        t: 'ice',
        to: this.remoteId,
        candidate: ev.candidate.candidate,
        sdpMid: ev.candidate.sdpMid ?? null,
        sdpMLineIndex: ev.candidate.sdpMLineIndex ?? null,
      });
    };
    this.pc.onconnectionstatechange = (): void => { this.onConnectionState(); };
    this.pc.oniceconnectionstatechange = (): void => { this.onConnectionState(); };

    if (options.autoPump !== false) {
      this.timer = setInterval(() => { this.pump(this.now()); }, 500);
      // Never hold a node process open just for a liveness probe.
      const t = this.timer as unknown as { unref?: () => void };
      if (typeof t.unref === 'function') t.unref();
    }
  }

  /* -------------------------------------------------------------- *
   * Handshake
   * -------------------------------------------------------------- */

  /** Offerer only: build and send the offer. Safe to call once. */
  async start(): Promise<void> {
    if (this.role !== 'offerer' || this.closed) return;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.signal.send({ t: 'sdp', to: this.remoteId, kind: 'offer', sdp: offer.sdp ?? '' });
    } catch (err) {
      this.onError?.(err);
      this.close(1006, 'offer failed');
    }
  }

  /** Feed one signalling message addressed to this link. */
  handleSignal(msg: SignalS2C): void {
    if (this.closed) return;
    if (msg.t === 'sdp') { void this.onRemoteSdp(msg.kind, msg.sdp); return; }
    if (msg.t === 'ice') {
      const c: RtcIceCandidateLike = {
        candidate: msg.candidate,
        sdpMid: msg.sdpMid,
        sdpMLineIndex: msg.sdpMLineIndex,
      };
      if (!this.remoteDescriptionSet) { this.pendingRemoteIce.push(c); return; }
      void this.pc.addIceCandidate(c).catch((e: unknown) => { this.onError?.(e); });
      return;
    }
    if (msg.t === 'peer-gone' || (msg.t === 'error' && msg.code === 'host-gone')) {
      this.close(1001, 'peer gone during signalling');
    }
  }

  private async onRemoteSdp(kind: 'offer' | 'answer', sdp: string): Promise<void> {
    try {
      await this.pc.setRemoteDescription({ type: kind, sdp });
      this.remoteDescriptionSet = true;
      for (const c of this.pendingRemoteIce) {
        await this.pc.addIceCandidate(c).catch((e: unknown) => { this.onError?.(e); });
      }
      this.pendingRemoteIce.length = 0;
      if (kind === 'offer') {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signal.send({ t: 'sdp', to: this.remoteId, kind: 'answer', sdp: answer.sdp ?? '' });
      }
    } catch (err) {
      this.onError?.(err);
      this.close(1006, 'sdp exchange failed');
    }
  }

  private onConnectionState(): void {
    const s = this.pc.connectionState;
    if (s === 'connected') {
      this.maxMessageBytes = Math.max(
        1024,
        Math.min(this.pc.sctp?.maxMessageSize ?? DEFAULT_MAX_MESSAGE_BYTES, MAX_REASSEMBLY_BYTES),
      );
      this.maybeOpen();
      return;
    }
    if (s === 'failed') {
      // One ICE restart. A second failure is a genuinely unreachable peer, and
      // retrying forever just holds the player on a spinner.
      if (this.role === 'offerer' && this.iceRestarts === 0 && !this.closed) {
        this.iceRestarts++;
        void this.restartIce();
        return;
      }
      this.close(1006, 'ice failed');
      return;
    }
    if (s === 'closed') this.close(1006, 'peer connection closed');
  }

  private async restartIce(): Promise<void> {
    try {
      const offer = await this.pc.createOffer({ iceRestart: true });
      await this.pc.setLocalDescription(offer);
      this.signal.send({ t: 'sdp', to: this.remoteId, kind: 'offer', sdp: offer.sdp ?? '' });
    } catch (err) {
      this.onError?.(err);
      this.close(1006, 'ice restart failed');
    }
  }

  private maybeOpen(): void {
    if (this.opened || this.closed) return;
    if (this.unreliable.readyState !== 'open' || this.reliable.readyState !== 'open') return;
    this.opened = true;
    this.lastRecvMs = this.now();
    this.onOpen?.();
  }

  /* -------------------------------------------------------------- *
   * Send
   * -------------------------------------------------------------- */

  get isOpen(): boolean { return this.opened && !this.closed; }
  get bufferedAmount(): number { return this.reliable.bufferedAmount; }

  /**
   * Send one game packet. The reliability decision is taken by the routing
   * table in transport.ts from the protocol's own message id — this class
   * never inspects a payload beyond `bytes[0]`.
   */
  sendGame(bytes: Uint8Array, reliability: Reliability): void {
    if (!this.isOpen || bytes.length === 0) return;
    if (reliability === Reliability.UNRELIABLE) {
      try {
        this.unreliable.send(frameDatagram(this.outCounter.next(), bytes));
      } catch (err) {
        // A dropped datagram is exactly what this channel promises. Never let
        // one failed send tear down a live match.
        this.onError?.(err);
      }
      return;
    }
    this.sendReliable(bytes);
  }

  private sendReliable(bytes: Uint8Array): void {
    try {
      if (bytes.length <= this.maxMessageBytes) {
        this.reliable.send(bytes);
        this.reliableSent++;
        return;
      }
      for (const piece of fragment(bytes, this.maxMessageBytes)) {
        this.reliable.send(piece);
        this.fragmentsSent++;
      }
      this.reliableSent++;
    } catch (err) {
      this.onError?.(err);
      this.close(1006, 'reliable send failed');
    }
  }

  /** Send a transport control frame. Always reliable — these are not superseded. */
  sendCtrl(type: CtrlType, arg = 0): void {
    if (this.closed || this.reliable.readyState !== 'open') return;
    try { this.reliable.send(encodeCtrl(type, arg)); } catch { /* link is dying anyway */ }
  }

  /* -------------------------------------------------------------- *
   * Receive
   * -------------------------------------------------------------- */

  private onUnreliable(data: unknown): void {
    const bytes = toBytes(data);
    if (bytes === null || bytes.length < SEQ_HEADER_BYTES) return;
    this.lastRecvMs = this.now();
    const seq = bytes[0] | (bytes[1] << 8);
    const gap = this.inCounter.accept(seq);
    if (gap < 0) return; // stale: a newer datagram already overtook it.
    const payload = bytes.subarray(SEQ_HEADER_BYTES);
    if (gap > 0 && this.wantResync) this.requestResync(gap);
    // Deliver FIRST and repair afterwards: the packet that did arrive is the
    // freshest state we have, and holding it back to wait for a repair is the
    // stall this transport exists to avoid.
    this.deliver(payload);
  }

  private onReliable(data: unknown): void {
    const bytes = toBytes(data);
    if (bytes === null || bytes.length === 0) return;
    this.lastRecvMs = this.now();
    if (bytes[0] === FRAGMENT_TAG && bytes.length >= FRAGMENT_HEADER_BYTES) {
      let whole: Uint8Array | null;
      try {
        whole = this.reassembler.push(bytes);
      } catch (err) {
        this.onError?.(err);
        this.close(1002, 'fragment stream broken');
        return;
      }
      if (whole === null) return;
      this.reliableReceived++;
      this.deliver(whole);
      return;
    }
    this.reliableReceived++;
    this.deliver(bytes);
  }

  private deliver(bytes: Uint8Array): void {
    if (isCtrlFrame(bytes)) {
      const ctrl = decodeCtrl(bytes);
      if (ctrl === null) return;
      switch (ctrl.type) {
        case CtrlType.RESYNC:
          this.resyncsServed++;
          this.onResyncRequest?.();
          break;
        case CtrlType.BYE:
          this.close(1000, 'peer left');
          break;
        case CtrlType.ALIVE:
          break;
        default:
          break;
      }
      return;
    }
    this.onData?.(bytes);
  }

  private requestResync(gap: number): void {
    const now = this.now();
    if (now - this.lastResyncMs < RESYNC_MIN_INTERVAL_MS) return;
    this.lastResyncMs = now;
    this.resyncsRequested++;
    this.sendCtrl(CtrlType.RESYNC, gap);
  }

  /* -------------------------------------------------------------- *
   * Liveness and teardown
   * -------------------------------------------------------------- */

  /**
   * Drive liveness. Called from an internal 500 ms interval in production and
   * directly from tests. Idempotent and cheap: a link that is exchanging game
   * traffic does two subtractions and returns.
   */
  pump(nowMs: number): void {
    if (this.closed) return;
    if (!this.opened) {
      if (nowMs - this.startedMs > HANDSHAKE_TIMEOUT_MS) this.close(1006, 'handshake timed out');
      return;
    }
    if (nowMs - this.lastRecvMs > PEER_SILENCE_MS) {
      this.close(1006, 'peer silent');
      return;
    }
    if (nowMs - this.lastAliveSentMs >= ALIVE_INTERVAL_MS) {
      this.lastAliveSentMs = nowMs;
      this.sendCtrl(CtrlType.ALIVE);
    }
  }

  /**
   * Tell the far side we are going, then tear everything down. Sending BYE is
   * what turns a host closing their laptop into "the host left" instead of a
   * fifteen-second hang — when the host gets the chance to send it at all.
   */
  close(code = 1000, reason = 'closed'): void {
    if (this.closed) return;
    // BYE goes out BEFORE `closed` is set, because `sendCtrl` refuses to write
    // to a closed link. Getting this order wrong is silent: the link still
    // tears down, the far side just never hears why and waits out
    // PEER_SILENCE_MS instead — a 3-second hang in place of an instant answer.
    if (code === 1000) this.sendCtrl(CtrlType.BYE);
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    this.unreliable.onmessage = null;
    this.reliable.onmessage = null;
    this.unreliable.onopen = null;
    this.reliable.onopen = null;
    this.unreliable.onclose = null;
    this.reliable.onclose = null;
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.oniceconnectionstatechange = null;
    try { this.unreliable.close(); } catch { /* already gone */ }
    try { this.reliable.close(); } catch { /* already gone */ }
    try { this.pc.close(); } catch { /* already gone */ }
    this.onClose?.(code, reason);
  }

  /* -------------------------------------------------------------- *
   * Diagnostics
   * -------------------------------------------------------------- */

  /**
   * Did this connection end up going through TURN?
   *
   * Worth measuring in production rather than assuming: the whole economic
   * case for peer hosting turns on the relay rate, published figures span
   * 4%-70%, and the only number that matters is the one your own players
   * produce. Resolves null when the browser will not say.
   */
  async probeRelay(): Promise<boolean | null> {
    if (!this.pc.getStats) return null;
    try {
      const report = await this.pc.getStats();
      let pairIsRelay: boolean | null = null;
      const candidates = new Map<string, string>();
      const pairs: Array<Record<string, unknown>> = [];
      report.forEach((s) => {
        if (s.type === 'local-candidate' && typeof s.id === 'string') {
          candidates.set(s.id, String(s.candidateType ?? ''));
        } else if (s.type === 'candidate-pair') {
          pairs.push(s);
        }
      });
      for (const p of pairs) {
        if (p.state !== 'succeeded' && p.nominated !== true) continue;
        const local = candidates.get(String(p.localCandidateId ?? ''));
        if (local !== undefined) pairIsRelay = local === 'relay';
      }
      this.relayed = pairIsRelay;
      return pairIsRelay;
    } catch {
      return null;
    }
  }

  stats(): PeerLinkStats {
    return {
      state: this.closed ? `closed:${this.closeCode}:${this.closeReason}`
        : this.opened ? 'open' : this.pc.connectionState,
      datagramsSent: this.outCounter.sent,
      datagramsReceived: this.inCounter.received,
      datagramsLost: this.inCounter.lost,
      datagramsReordered: this.inCounter.reordered,
      lossRate: this.inCounter.lossRate,
      reliableSent: this.reliableSent,
      reliableReceived: this.reliableReceived,
      resyncsRequested: this.resyncsRequested,
      resyncsServed: this.resyncsServed,
      fragmentsSent: this.fragmentsSent,
      relayed: this.relayed,
    };
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * Guest side — a ClientTransport
 * ------------------------------------------------------------------------ */

export interface WebRtcClientOptions extends Omit<PeerLinkOptions, 'role' | 'remoteId' | 'requestResyncOnLoss'> {
  /** Defaults to the hub's fixed host id. */
  hostId?: string;
}

export interface WebRtcClientTransport extends ClientTransport {
  readonly link: PeerLink;
  stats(): PeerLinkStats;
}

/**
 * Connect to a peer host and present the result as the same `ClientTransport`
 * a WebSocket produces. `NetClient` cannot tell the difference, which is the
 * whole point: one client, one protocol, one prediction path.
 */
export function webRtcClientTransport(options: WebRtcClientOptions): WebRtcClientTransport {
  const link = new PeerLink({
    ...options,
    role: 'offerer',
    remoteId: options.hostId ?? HOST_PEER_ID,
    requestResyncOnLoss: true,
  });

  let state: number = TransportState.CONNECTING;
  const transport: WebRtcClientTransport = {
    kind: 'webrtc',
    link,
    get readyState(): number { return state; },
    send(data: Uint8Array): void {
      if (state !== TransportState.OPEN) return;
      link.sendGame(data, clientMessageReliability(data[0]));
    },
    close(code = 1000, reason = 'client left'): void {
      state = TransportState.CLOSING;
      link.close(code, reason);
    },
    stats: () => link.stats(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  link.onOpen = (): void => { state = TransportState.OPEN; transport.onopen?.(); };
  link.onData = (bytes): void => { transport.onmessage?.(bytes); };
  link.onClose = (code, reason): void => { state = TransportState.CLOSED; transport.onclose?.(code, reason); };
  link.onError = (err): void => { transport.onerror?.(err); };
  void link.start();
  return transport;
}

/* ------------------------------------------------------------------------ *
 * Host side — a ServerTransport
 * ------------------------------------------------------------------------ */

export interface WebRtcServerOptions extends Omit<PeerLinkOptions, 'role' | 'requestResyncOnLoss'> {
  /** Called when the guest's delta baseline is unusable and needs a full snapshot. */
  onResyncRequest?: () => void;
  onData: (bytes: Uint8Array) => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
}

export interface WebRtcServerTransport extends ServerTransport {
  readonly link: PeerLink;
  stats(): PeerLinkStats;
}

/**
 * Serve one guest. Structurally a `NetTransport` (server/src/net.ts), so the
 * room's connection code — chunk budgets, `SOCKET_BACKLOG_LIMIT` backpressure,
 * timeout reaping, every anti-cheat check — runs completely unchanged.
 *
 * `bufferedAmount` deliberately reports the RELIABLE channel: that is where
 * the world stream goes, and it is the queue `net.ts` throttles chunks
 * against. Reporting the unreliable channel would let a slow guest be flooded
 * with chunks it can never absorb.
 */
export function webRtcServerTransport(options: WebRtcServerOptions): WebRtcServerTransport {
  const link = new PeerLink({ ...options, role: 'answerer', requestResyncOnLoss: false });
  link.onData = options.onData;
  link.onResyncRequest = options.onResyncRequest ?? null;
  if (options.onOpen) link.onOpen = options.onOpen;
  if (options.onClose) link.onClose = options.onClose;

  return {
    link,
    get isOpen(): boolean { return link.isOpen; },
    get bufferedAmount(): number { return link.bufferedAmount; },
    send(data: Uint8Array): void {
      link.sendGame(data, serverMessageReliability(data[0]));
    },
    close(code = 1000, reason = 'closed'): void { link.close(code, reason); },
    stats: () => link.stats(),
  };
}

/* ------------------------------------------------------------------------ *
 * Joining a room by code
 * ------------------------------------------------------------------------ */

export class SignalError extends Error {
  constructor(readonly code: SignalErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SignalError';
  }
}

export interface JoinPeerRoomOptions {
  /** As typed by the player. Folded through `normaliseRoomCode` first. */
  code: string;
  signal: SignalPort;
  rtc?: RtcFactory;
  now?: () => number;
  autoPump?: boolean;
  /** Diagnostics: force TURN so the relay path can be exercised on purpose. */
  relayOnly?: boolean;
}

/**
 * Ask the hub for the host of `code` and return a transport for it.
 *
 * Resolves as soon as the peer connection is under way — NOT when it is open.
 * That is deliberate: `NetClient` already knows how to wait for `onopen`, show
 * a connecting state and give up, and duplicating that here would give the UI
 * two different ways to be "connecting".
 */
export function joinPeerRoom(options: JoinPeerRoomOptions): Promise<WebRtcClientTransport> {
  const code = normaliseRoomCode(options.code);
  if (code === '') return Promise.reject(new SignalError('bad-request', 'malformed room code'));

  return new Promise<WebRtcClientTransport>((resolve, reject) => {
    const signal = options.signal;
    let transport: WebRtcClientTransport | null = null;
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    signal.onMessage = (msg: SignalS2C): void => {
      if (msg.t === 'error') { fail(new SignalError(msg.code, msg.detail)); return; }
      if (msg.t === 'joined') {
        if (settled) return;
        settled = true;
        transport = webRtcClientTransport({
          signal,
          hostId: msg.host,
          iceServers: msg.iceServers,
          rtc: options.rtc,
          now: options.now,
          autoPump: options.autoPump,
          relayOnly: options.relayOnly,
        });
        resolve(transport);
        return;
      }
      // Everything else (sdp, ice, peer-gone) belongs to the live link.
      transport?.link.handleSignal(msg);
    };
    signal.onClose = (): void => {
      fail(new SignalError('host-gone', 'signalling closed before the room answered'));
    };

    signal.send({ t: 'join', v: SIGNAL_PROTOCOL_VERSION, code } satisfies SignalC2S);
  });
}
