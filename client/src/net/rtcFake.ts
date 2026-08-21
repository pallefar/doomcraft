/**
 * DOOMCRAFT — a WebRTC test double.
 *
 * TEST SUPPORT ONLY. Nothing in the game imports this file, so it never
 * reaches the bundle; it exists because the two facts that matter most about
 * the WebRTC transport cannot be tested against a real browser stack:
 *
 *   1. that a LOST unreliable datagram is detected, repaired and — critically
 *      — does not stall the packets behind it. Real packet loss is not
 *      reproducible; loss you inject is.
 *   2. that the two channels are wired the way `webrtc.ts` claims. Here the
 *      reliable channel really is lossless and ordered and the unreliable one
 *      really can drop, so a routing mistake shows up as a broken test rather
 *      than as a rare bug on someone's hotel wifi.
 *
 * The fake implements the structural interfaces in webrtc.ts, not lib.dom, and
 * it is deliberately synchronous-with-an-explicit-flush: every send queues, and
 * `flush()` delivers. A test therefore controls exactly which packets exist
 * when, which is the only way a loss test can be deterministic.
 */

import type {
  RtcDataChannelInitLike,
  RtcDataChannelLike,
  RtcFactory,
  RtcIceCandidateLike,
  RtcPeerConnectionLike,
  RtcSessionDescriptionLike,
  RtcStatsLike,
} from './webrtc.js';

export interface DropInfo {
  /** 'dc-rt' (unreliable) or 'dc-rel' (reliable). */
  label: string;
  /** Sending connection's id. */
  from: string;
  to: string;
  /** How many messages this channel has sent so far, this one included. */
  index: number;
  bytes: Uint8Array;
  /** Wrapping datagram sequence, unreliable channel only; -1 otherwise. */
  seq: number;
}

interface Pending { channel: FakeChannel; bytes: Uint8Array }

class FakeChannel implements RtcDataChannelLike {
  readyState = 'connecting';
  binaryType = 'blob';
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | Uint8Array | unknown }) => void) | null = null;

  peer: FakeChannel | null = null;
  sentCount = 0;

  constructor(
    readonly label: string,
    readonly id: number,
    private readonly pc: FakePeerConnection,
    private readonly net: FakeRtcNetwork,
  ) {}

  send(data: ArrayBuffer | Uint8Array): void {
    if (this.readyState !== 'open') throw new Error(`send on ${this.readyState} channel`);
    const bytes = data instanceof Uint8Array
      ? new Uint8Array(data)
      : new Uint8Array(data as ArrayBuffer);
    this.sentCount++;
    const target = this.peer;
    if (!target) return;
    const seq = this.label === 'dc-rt' && bytes.length >= 2 ? (bytes[0] | (bytes[1] << 8)) : -1;
    const info: DropInfo = {
      label: this.label,
      from: this.pc.id,
      to: target.pc.id,
      index: this.sentCount,
      bytes,
      seq,
    };
    this.net.record(info);
    if (this.net.drop?.(info) === true) {
      this.net.dropped++;
      return;
    }
    this.net.queue({ channel: target, bytes });
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
  }

  /** Test hook: open this channel. */
  open(): void {
    if (this.readyState === 'open') return;
    this.readyState = 'open';
    this.onopen?.();
  }
}

class FakePeerConnection implements RtcPeerConnectionLike {
  connectionState = 'new';
  iceConnectionState = 'new';
  sctp: { readonly maxMessageSize: number } | null = { maxMessageSize: 64 * 1024 };
  onicecandidate: ((ev: { candidate: RtcIceCandidateLike | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  readonly channels = new Map<number, FakeChannel>();
  remote: FakePeerConnection | null = null;
  closed = false;

  constructor(readonly id: string, private readonly net: FakeRtcNetwork) {}

  createDataChannel(label: string, init: RtcDataChannelInitLike = {}): RtcDataChannelLike {
    const id = init.id ?? this.channels.size;
    const ch = new FakeChannel(label, id, this, this.net);
    this.channels.set(id, ch);
    return ch;
  }

  createOffer(): Promise<RtcSessionDescriptionLike> {
    return Promise.resolve({ type: 'offer', sdp: `fake-sdp:${this.id}` });
  }

  createAnswer(): Promise<RtcSessionDescriptionLike> {
    return Promise.resolve({ type: 'answer', sdp: `fake-sdp:${this.id}` });
  }

  setLocalDescription(): Promise<void> {
    // One host candidate, so the signalling relay is genuinely exercised.
    this.onicecandidate?.({
      candidate: { candidate: `candidate:1 1 udp 2130706431 10.0.0.1 5000 typ host ${this.id}`, sdpMid: '0', sdpMLineIndex: 0 },
    });
    this.onicecandidate?.({ candidate: null });
    return Promise.resolve();
  }

  setRemoteDescription(desc: RtcSessionDescriptionLike): Promise<void> {
    const id = (desc.sdp ?? '').replace('fake-sdp:', '');
    const other = this.net.find(id);
    if (!other) return Promise.reject(new Error(`no such fake peer: ${id}`));
    this.remote = other;
    if (other.remote === this) this.net.link(this, other);
    return Promise.resolve();
  }

  addIceCandidate(): Promise<void> { return Promise.resolve(); }

  getStats(): Promise<RtcStatsLike> {
    const rows: Array<Record<string, unknown>> = [
      { type: 'local-candidate', id: 'lc1', candidateType: this.net.relayed ? 'relay' : 'srflx' },
      { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'lc1' },
    ];
    return Promise.resolve({ forEach: (cb) => { for (const r of rows) cb(r); } });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const ch of this.channels.values()) ch.close();
    this.connectionState = 'closed';
  }

  /** Test hook: pretend ICE gave up. */
  fail(): void {
    this.connectionState = 'failed';
    this.iceConnectionState = 'failed';
    this.onconnectionstatechange?.();
  }
}

export class FakeRtcNetwork {
  /** Return true to drop this message on the floor. */
  drop: ((info: DropInfo) => boolean) | null = null;
  /** Makes `probeRelay()` report a TURN path. */
  relayed = false;
  /** Every message offered to the wire, dropped or not. */
  readonly log: DropInfo[] = [];
  dropped = 0;

  private readonly peers = new Map<string, FakePeerConnection>();
  private inflight: Pending[] = [];
  private nextId = 1;

  /**
   * Hand this to `rtc:` on a PeerLink, peerHost or joinPeerRoom. `tag` names
   * the connections it makes, so a test can tell which DIRECTION a logged
   * message travelled — which matters, because C2S and S2C reuse the same
   * message-id numbers (C2S.INPUT and S2C.CHUNK are both 2).
   */
  factory(tag = 'pc'): RtcFactory {
    return (): RtcPeerConnectionLike => {
      const pc = new FakePeerConnection(`${tag}${this.nextId++}`, this);
      this.peers.set(pc.id, pc);
      return pc;
    };
  }

  find(id: string): FakePeerConnection | undefined { return this.peers.get(id); }

  record(info: DropInfo): void { this.log.push(info); }

  queue(p: Pending): void { this.inflight.push(p); }

  /** Both sides have each other's SDP: open the matching channels. */
  link(a: FakePeerConnection, b: FakePeerConnection): void {
    for (const [id, ca] of a.channels) {
      const cb = b.channels.get(id);
      if (!cb) continue;
      ca.peer = cb;
      cb.peer = ca;
    }
    a.connectionState = 'connected';
    b.connectionState = 'connected';
    for (const ch of a.channels.values()) ch.open();
    for (const ch of b.channels.values()) ch.open();
    a.onconnectionstatechange?.();
    b.onconnectionstatechange?.();
  }

  /**
   * Deliver everything queued, and everything the deliveries themselves
   * produce, until the wire is quiet. Returns how many messages were handed
   * over. The iteration cap turns an accidental packet storm into a failing
   * test rather than a hung one.
   */
  flush(maxRounds = 200): number {
    let delivered = 0;
    for (let round = 0; round < maxRounds && this.inflight.length > 0; round++) {
      const batch = this.inflight;
      this.inflight = [];
      for (const p of batch) {
        if (p.channel.readyState !== 'open') continue;
        delivered++;
        p.channel.onmessage?.({ data: p.bytes });
      }
    }
    return delivered;
  }

  /** How many messages this network carried on a given channel label. */
  countSent(label: string): number {
    let n = 0;
    for (const e of this.log) if (e.label === label) n++;
    return n;
  }
}
