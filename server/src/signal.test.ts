/**
 * DOOMCRAFT — the signalling hub.
 *
 * Two things are being proved here, and only one of them is "does it relay an
 * SDP".
 *
 * The first is the STAR. The hub is a message relay between strangers, which
 * is exactly the shape of thing that gets abused, so the tests assert what it
 * refuses to carry: nothing from a guest to another guest, nothing to a peer
 * outside your own room, nothing oversized, and nothing at all before you have
 * joined something.
 *
 * The second is ENUMERATION. A room code is a bearer token with 40 bits behind
 * it, which is only enough because the hub throttles guessing. The rate-limit
 * tests are therefore not hygiene tests — they are half of the security
 * argument, and if they stay green after the limits are removed the argument
 * has gone with them.
 */

import { describe, expect, it } from 'vitest';

import {
  HOST_PEER_ID,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_ENTROPY_BITS,
  ROOM_CODE_LENGTH,
  SIGNAL_MAX_CANDIDATES,
  SIGNAL_MAX_MESSAGE_BYTES,
  SIGNAL_MAX_SDP_BYTES,
  SIGNAL_PROTOCOL_VERSION,
  formatRoomCode,
  isRoomCode,
  normaliseRoomCode,
  type SignalC2S,
  type SignalS2C,
} from '@doomcraft/shared/signal';

import {
  MAX_FAILED_JOINS_PER_MINUTE,
  MAX_ROOMS_PER_IP_PER_MINUTE,
  MAX_SOCKETS_PER_IP,
  MESSAGE_BURST,
  SIGNAL_MAX_GUESTS,
  SignalConnection,
  SignalHub,
  buildIceServers,
  generateRoomCode,
  roomCodeSpace,
  turnCredentials,
  type SignalSocket,
} from './signal.js';

const V = SIGNAL_PROTOCOL_VERSION;

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

interface Client {
  readonly conn: SignalConnection;
  readonly got: SignalS2C[];
  readonly closed: [number, string] | null;
  send(msg: SignalC2S): void;
  /** Bypass the typed API — for frames a real client would never build. */
  raw(text: string): void;
  /** Simulate the socket going away. */
  drop(): void;
  ofType<T extends SignalS2C['t']>(t: T): Extract<SignalS2C, { t: T }>[];
}

function makeHub(nowRef: { ms: number } = { ms: 0 }): SignalHub {
  return new SignalHub({ now: () => nowRef.ms });
}

function connect(hub: SignalHub, address = '10.0.0.1'): Client | null {
  const got: SignalS2C[] = [];
  let closed: [number, string] | null = null;
  let open = true;
  const socket: SignalSocket = {
    get isOpen(): boolean { return open; },
    send(text: string): void { got.push(JSON.parse(text) as SignalS2C); },
    close(code = 1000, reason = ''): void { open = false; closed = [code, reason]; },
  };
  const conn = hub.attach(socket, address);
  if (conn === null) return null;
  return {
    conn,
    got,
    get closed(): [number, string] | null { return closed; },
    send(msg: SignalC2S): void { hub.receive(conn, JSON.stringify(msg)); },
    raw(text: string): void { hub.receive(conn, text); },
    drop(): void { open = false; hub.detach(conn); },
    ofType<T extends SignalS2C['t']>(t: T): Extract<SignalS2C, { t: T }>[] {
      return got.filter((m) => m.t === t) as Extract<SignalS2C, { t: T }>[];
    },
  };
}

function mustConnect(hub: SignalHub, address: string): Client {
  const c = connect(hub, address);
  if (c === null) throw new Error(`hub refused ${address}`);
  return c;
}

function host(hub: SignalHub, address = '10.0.0.1', cap = 3): { c: Client; code: string } {
  const c = mustConnect(hub, address);
  c.send({ t: 'host', v: V, cap });
  const hosted = c.ofType('hosted')[0];
  expect(hosted).toBeTruthy();
  return { c, code: hosted.code };
}

function join(hub: SignalHub, code: string, address: string): Client {
  const c = mustConnect(hub, address);
  c.send({ t: 'join', v: V, code });
  return c;
}

/* ------------------------------------------------------------------------ *
 * Codes
 * ------------------------------------------------------------------------ */

describe('room codes', () => {
  it('is a 40-bit space, which is the number the rate limits are sized against', () => {
    expect(ROOM_CODE_ALPHABET.length).toBe(32);
    expect(ROOM_CODE_LENGTH).toBe(8);
    expect(roomCodeSpace()).toBe(Math.pow(2, ROOM_CODE_ENTROPY_BITS));
    expect(roomCodeSpace()).toBe(1_099_511_627_776);
  });

  it('has no character a human can misread aloud', () => {
    for (const c of 'ILOU') expect(ROOM_CODE_ALPHABET).not.toContain(c);
  });

  it('generates well-formed codes and covers the whole alphabet', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const code = generateRoomCode();
      expect(isRoomCode(code)).toBe(true);
      for (const ch of code) seen.add(ch);
    }
    // 3,200 symbols. A missing one would mean a biased generator, which would
    // quietly cost bits off the 40 the security argument is built on.
    expect(seen.size).toBe(32);
  });

  it('folds what a player actually types', () => {
    expect(normaliseRoomCode('abcd-efgh')).toBe('ABCDEFGH');
    // Crockford look-alikes: I and L are 1, O is 0, U is V.
    expect(normaliseRoomCode('1i1l 0o0u')).toBe('1111000V');
    expect(normaliseRoomCode('short')).toBe('');
    expect(normaliseRoomCode('TOOLONGCODE1')).toBe('');
    expect(normaliseRoomCode('ABCD!FGH')).toBe('');
    expect(formatRoomCode('ABCD1234')).toBe('ABCD-1234');
  });
});

/* ------------------------------------------------------------------------ *
 * The handshake
 * ------------------------------------------------------------------------ */

describe('handshake', () => {
  it('introduces a guest to a host and relays an offer, an answer and ICE', () => {
    const hub = makeHub();
    const h = host(hub, '10.0.0.1');
    const g = join(hub, h.code, '10.0.0.2');

    const joined = g.ofType('joined')[0];
    expect(joined.host).toBe(HOST_PEER_ID);
    expect(joined.self).toBe('g1');
    expect(h.c.ofType('peer')[0]).toEqual({ t: 'peer', peer: 'g1' });

    g.send({ t: 'sdp', to: HOST_PEER_ID, kind: 'offer', sdp: 'v=0 offer' });
    expect(h.c.ofType('sdp')[0]).toEqual({ t: 'sdp', from: 'g1', kind: 'offer', sdp: 'v=0 offer' });

    h.c.send({ t: 'sdp', to: 'g1', kind: 'answer', sdp: 'v=0 answer' });
    expect(g.ofType('sdp')[0]).toEqual({ t: 'sdp', from: HOST_PEER_ID, kind: 'answer', sdp: 'v=0 answer' });

    g.send({ t: 'ice', to: HOST_PEER_ID, candidate: 'candidate:1 1 udp', sdpMid: '0', sdpMLineIndex: 0 });
    expect(h.c.ofType('ice')[0]).toMatchObject({ from: 'g1', candidate: 'candidate:1 1 udp' });
  });

  it('accepts a code the player typed in lower case with a dash', () => {
    const hub = makeHub();
    const h = host(hub, '10.0.0.1');
    const g = join(hub, formatRoomCode(h.code).toLowerCase(), '10.0.0.2');
    expect(g.ofType('joined')).toHaveLength(1);
  });

  it('refuses a mismatched protocol version', () => {
    const hub = makeHub();
    const c = mustConnect(hub, '10.0.0.9');
    c.raw(JSON.stringify({ t: 'host', v: V + 1, cap: 1 }));
    expect(c.ofType('error')[0]).toMatchObject({ code: 'bad-version' });
  });

  it('tells the guests when the host disappears', () => {
    const hub = makeHub();
    const h = host(hub, '10.0.0.1');
    const g = join(hub, h.code, '10.0.0.2');

    // A closed host socket is the only notice a guest gets before it has a
    // DataChannel — after that, `PEER_SILENCE_MS` in webrtc.ts takes over.
    h.c.drop();
    expect(g.ofType('error')[0]).toMatchObject({ code: 'host-gone' });
    expect(hub.hasRoom(h.code)).toBe(false);
  });

  it('tells the host when a guest gives up mid-handshake', () => {
    const hub = makeHub();
    const h = host(hub, '10.0.0.1');
    const g = join(hub, h.code, '10.0.0.2');
    g.drop();
    expect(h.c.ofType('peer-gone')[0]).toEqual({ t: 'peer-gone', peer: 'g1' });
  });

  it('lets the host refuse one guest without touching the others', () => {
    const hub = makeHub();
    const h = host(hub, '10.0.0.1', 3);
    const g1 = join(hub, h.code, '10.0.0.2');
    const g2 = join(hub, h.code, '10.0.0.3');

    // This is what `peerHost.refuse()` sends when its own cap or its join
    // stagger says no, and it must reach the guest as an answer rather than a
    // silence.
    h.c.send({ t: 'bye', to: 'g2' });
    expect(g2.ofType('error')[0]).toMatchObject({ code: 'room-full' });
    expect(g1.ofType('error')).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ *
 * The star — what the relay refuses to carry
 * ------------------------------------------------------------------------ */

describe('the relay is a star and nothing else', () => {
  it('will not carry a message from one guest to another', () => {
    const hub = makeHub();
    const h = host(hub, '10.0.0.1', 3);
    const g1 = join(hub, h.code, '10.0.0.2');
    const g2 = join(hub, h.code, '10.0.0.3');
    expect(g2.ofType('joined')[0].self).toBe('g2');

    g1.send({ t: 'sdp', to: 'g2', kind: 'offer', sdp: 'sneaky' });
    expect(g1.ofType('error')[0]).toMatchObject({ code: 'bad-request' });
    expect(g2.ofType('sdp')).toHaveLength(0);
  });

  it("will not let a host address a peer in someone else's room", () => {
    const hub = makeHub();
    const a = host(hub, '10.0.0.1');
    const b = host(hub, '10.0.0.4');
    const guestOfB = join(hub, b.code, '10.0.0.5');
    expect(guestOfB.ofType('joined')).toHaveLength(1);

    a.c.send({ t: 'sdp', to: 'g1', kind: 'offer', sdp: 'cross-room' });
    expect(a.c.ofType('error')[0]).toMatchObject({ code: 'bad-request' });
    expect(guestOfB.ofType('sdp')).toHaveLength(0);
  });

  it('will not relay for a socket that has not joined anything', () => {
    const hub = makeHub();
    const lurker = mustConnect(hub, '10.0.0.7');
    lurker.send({ t: 'sdp', to: HOST_PEER_ID, kind: 'offer', sdp: 'x' });
    expect(lurker.ofType('error')[0]).toMatchObject({ code: 'no-such-room' });
  });

  it('caps SDP size', () => {
    const hub = makeHub();
    const h = host(hub, '10.0.0.1');
    const g = join(hub, h.code, '10.0.0.2');

    g.send({ t: 'sdp', to: HOST_PEER_ID, kind: 'offer', sdp: 'x'.repeat(SIGNAL_MAX_SDP_BYTES + 1) });
    expect(g.ofType('error')[0]).toMatchObject({ code: 'bad-request', detail: 'sdp too large' });
    expect(h.c.ofType('sdp')).toHaveLength(0);
  });

  it('stops relaying ICE past the per-peer candidate cap', () => {
    // The clock moves so the token bucket refills: this test is about the
    // CANDIDATE cap, and letting the message-rate limit trip first would test
    // the wrong thing while still going green.
    const ref = { ms: 0 };
    const hub = makeHub(ref);
    const h = host(hub, '10.0.0.1');
    const g = join(hub, h.code, '10.0.0.2');

    for (let i = 0; i < SIGNAL_MAX_CANDIDATES + 5; i++) {
      ref.ms += 50;
      g.send({ t: 'ice', to: HOST_PEER_ID, candidate: `c${i}`, sdpMid: '0', sdpMLineIndex: 0 });
    }
    expect(g.closed).toBeNull();
    expect(h.c.ofType('ice')).toHaveLength(SIGNAL_MAX_CANDIDATES);
  });

  it('refuses an oversized frame without ever parsing it', () => {
    const hub = makeHub();
    const c = mustConnect(hub, '10.6.6.6');
    // Parsing a megabyte to discover it is too big IS the denial of service.
    c.raw('{"t":"host","v":1,"junk":"' + 'x'.repeat(SIGNAL_MAX_MESSAGE_BYTES) + '"}');
    expect(c.ofType('error')[0]).toMatchObject({ code: 'bad-request', detail: 'message too large' });
    expect(c.closed?.[0]).toBe(1008);
  });

  it('survives junk', () => {
    const hub = makeHub();
    const c = mustConnect(hub, '10.6.6.7');
    c.raw('not json at all');
    expect(c.ofType('error')[0]).toMatchObject({ code: 'bad-request', detail: 'not json' });
    c.raw('null');
    c.raw('{"t":42}');
    c.raw('{"nope":1}');
    expect(c.ofType('error').length).toBeGreaterThanOrEqual(3);
  });

  it('refuses a guest past the room cap', () => {
    const hub = makeHub();
    const h = host(hub, '10.0.0.1', 1);
    join(hub, h.code, '10.0.0.2');
    const second = join(hub, h.code, '10.0.0.3');
    expect(second.ofType('error')[0]).toMatchObject({ code: 'room-full' });
    expect(second.ofType('joined')).toHaveLength(0);
  });

  it('clamps a host that asks for a 31-guest room', () => {
    const hub = makeHub();
    const h = host(hub, '10.0.0.1', 31);
    for (let i = 0; i < SIGNAL_MAX_GUESTS; i++) {
      expect(join(hub, h.code, `10.1.0.${i}`).ofType('joined')).toHaveLength(1);
    }
    expect(join(hub, h.code, '10.2.0.1').ofType('error')[0]).toMatchObject({ code: 'room-full' });
  });
});

/* ------------------------------------------------------------------------ *
 * Enumeration — the other half of "40 bits is enough"
 * ------------------------------------------------------------------------ */

describe('code enumeration', () => {
  it('answers a malformed code exactly as it answers a wrong one', () => {
    // A scanner must not be able to tell which of its guesses were even well
    // formed: that would hand it a free filter on the search space.
    const hub = makeHub();
    const a = join(hub, 'ZZZZZZZZ', '10.0.1.1');
    const b = join(hub, '!!!', '10.0.1.2');
    expect(a.ofType('error')[0]).toEqual(b.ofType('error')[0]);
    expect(a.ofType('error')[0]).toEqual({ t: 'error', code: 'no-such-room' });
  });

  it('bans an address that keeps guessing, and only that address', () => {
    const hub = makeHub();
    const attacker = '10.66.66.66';

    // A real scanner reuses one socket, so this does too.
    const c = mustConnect(hub, attacker);
    for (let i = 0; i <= MAX_FAILED_JOINS_PER_MINUTE; i++) {
      c.send({ t: 'join', v: V, code: generateRoomCode() });
    }
    expect(c.closed?.[0]).toBe(1008);
    expect(hub.stats().bannedAddresses).toBe(1);

    // The ban outlives the socket: reconnecting does not reset the counter.
    expect(connect(hub, attacker)).toBeNull();
    // And an innocent neighbour behind a different address is unaffected.
    expect(connect(hub, '10.66.66.67')).not.toBeNull();
  });

  it('does not punish a friend who typed the right code into a full room', () => {
    const hub = makeHub();
    const h = host(hub, '10.0.0.1', 1);
    join(hub, h.code, '10.0.0.2');
    for (let i = 0; i < MAX_FAILED_JOINS_PER_MINUTE + 3; i++) {
      const c = join(hub, h.code, '10.0.0.55');
      expect(c.ofType('error')[0]).toMatchObject({ code: 'room-full' });
      c.drop();
    }
    // A correct code into a full lobby is not a guess.
    expect(hub.stats().bannedAddresses).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Rate limits
 * ------------------------------------------------------------------------ */

describe('rate limits', () => {
  it('caps sockets per address', () => {
    const hub = makeHub();
    for (let i = 0; i < MAX_SOCKETS_PER_IP; i++) expect(connect(hub, '10.9.9.9')).not.toBeNull();
    expect(connect(hub, '10.9.9.9')).toBeNull();
    expect(connect(hub, '10.9.9.10')).not.toBeNull();
  });

  it('caps rooms per address per minute, and lets the window roll', () => {
    const ref = { ms: 0 };
    const hub = makeHub(ref);
    let created = 0;
    for (let i = 0; i < MAX_ROOMS_PER_IP_PER_MINUTE + 2; i++) {
      const c = mustConnect(hub, '10.8.8.8');
      c.send({ t: 'host', v: V, cap: 1 });
      if (c.ofType('hosted').length > 0) created++;
      c.drop();
    }
    expect(created).toBe(MAX_ROOMS_PER_IP_PER_MINUTE);

    ref.ms += 61_000;
    const c = mustConnect(hub, '10.8.8.8');
    c.send({ t: 'host', v: V, cap: 1 });
    expect(c.ofType('hosted')).toHaveLength(1);
  });

  it('drops a flood and closes the socket', () => {
    const hub = makeHub();
    const c = mustConnect(hub, '10.7.7.7');
    for (let i = 0; i < MESSAGE_BURST + 5; i++) c.send({ t: 'ice', to: 'h', candidate: 'x', sdpMid: null, sdpMLineIndex: null });
    expect(c.closed?.[0]).toBe(1008);
    expect(hub.stats().messagesDropped).toBeGreaterThan(0);
  });

  it('refills the token bucket over time', () => {
    const ref = { ms: 0 };
    const hub = makeHub(ref);
    const c = mustConnect(hub, '10.7.7.8');
    for (let i = 0; i < MESSAGE_BURST - 1; i++) {
      ref.ms += 1;
      c.send({ t: 'ice', to: 'h', candidate: 'x', sdpMid: null, sdpMLineIndex: null });
    }
    expect(c.closed).toBeNull();
    ref.ms += 5_000;
    c.send({ t: 'host', v: V, cap: 1 });
    expect(c.ofType('hosted')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------ *
 * TURN credentials
 * ------------------------------------------------------------------------ */

describe('TURN credentials', () => {
  it('are ephemeral and bound to the shared secret', () => {
    const a = turnCredentials('s3cret', 3600, 'dc', 1_000_000);
    expect(a.username).toBe(`${1_000_000 + 3600}:dc`);
    expect(turnCredentials('s3cret', 3600, 'dc', 1_000_000).credential).toBe(a.credential);
    expect(turnCredentials('other', 3600, 'dc', 1_000_000).credential).not.toBe(a.credential);
    expect(turnCredentials('s3cret', 3600, 'dc', 1_000_060).username).not.toBe(a.username);
  });

  it('hands out nothing when nothing is configured, rather than a public STUN', () => {
    // A deployment with no STUN must be visibly broken. Silently falling back
    // to somebody else's public server is how you end up depending on it.
    expect(buildIceServers({ stunUrls: [], turnUrls: [], turnSecret: '', turnTtlSeconds: 60 })).toEqual([]);
  });

  it('omits TURN when the secret is missing, rather than shipping a static password', () => {
    const servers = buildIceServers({
      stunUrls: ['stun:stun.example.com:3478'],
      turnUrls: ['turn:turn.example.com:3478'],
      turnSecret: '',
      turnTtlSeconds: 60,
    });
    expect(servers).toHaveLength(1);
    expect(servers[0].urls).toEqual(['stun:stun.example.com:3478']);
  });

  it('issues a credentialed TURN entry when it is configured', () => {
    const servers = buildIceServers({
      stunUrls: ['stun:stun.example.com:3478'],
      turnUrls: ['turn:turn.example.com:3478?transport=udp'],
      turnSecret: 'shared',
      turnTtlSeconds: 3600,
    }, 1_700_000_000_000);
    expect(servers).toHaveLength(2);
    expect(servers[1].username).toBe(`${1_700_000_000 + 3600}:dc`);
    expect(servers[1].credential?.length).toBeGreaterThan(10);
  });

  it('gives every peer a fresh credential', () => {
    const ref = { ms: 1_700_000_000_000 };
    const hub = new SignalHub({
      now: () => ref.ms,
      ice: {
        stunUrls: ['stun:stun.example.com:3478'],
        turnUrls: ['turn:turn.example.com:3478'],
        turnSecret: 'shared',
        turnTtlSeconds: 3600,
      },
    });
    const h = host(hub, '10.0.0.1');
    ref.ms += 120_000;
    const g = join(hub, h.code, '10.0.0.2');
    const hostTurn = h.c.ofType('hosted')[0].iceServers[1];
    const guestTurn = g.ofType('joined')[0].iceServers[1];
    expect(hostTurn.username).not.toBe(guestTurn.username);
  });
});

/* ------------------------------------------------------------------------ *
 * Housekeeping
 * ------------------------------------------------------------------------ */

describe('housekeeping', () => {
  it('sweeps an idle room away', () => {
    const ref = { ms: 0 };
    const hub = makeHub(ref);
    const h = host(hub, '10.0.0.1');
    expect(hub.hasRoom(h.code)).toBe(true);

    ref.ms += 60_000;
    hub.sweep();
    expect(hub.hasRoom(h.code)).toBe(true);

    ref.ms += 11 * 60_000;
    hub.sweep();
    expect(hub.hasRoom(h.code)).toBe(false);
  });

  it('reports what it is doing', () => {
    const hub = makeHub();
    const h = host(hub, '10.0.0.1');
    join(hub, h.code, '10.0.0.2');
    const s = hub.stats();
    expect(s.rooms).toBe(1);
    expect(s.guestsConnected).toBe(1);
    expect(s.roomsCreated).toBe(1);
    expect(s.joinsAccepted).toBe(1);
  });

  it('closes everything on shutdown', () => {
    const hub = makeHub();
    const h = host(hub, '10.0.0.1');
    const g = join(hub, h.code, '10.0.0.2');
    hub.closeAll(1001, 'bye');
    expect(h.c.closed).toEqual([1001, 'bye']);
    expect(g.closed).toEqual([1001, 'bye']);
    expect(hub.stats().rooms).toBe(0);
  });
});
