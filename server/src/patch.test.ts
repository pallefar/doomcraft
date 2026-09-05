/**
 * DOOMCRAFT — the protocol window, and what a refused client is told.
 *
 * The bug being locked down is a one-liner that used to sit at
 * `server/src/net.ts:401`:
 *
 *     if (this.hello.protocolVersion !== PROTOCOL_VERSION) detach(1002, ...)
 *
 * Strict equality, hard disconnect. Under that rule the first byte of every
 * deploy is a fleet-wide simultaneous logout, because the moment the new binary
 * answers, every connected client is one version behind by definition.
 *
 * These tests drive the REAL `Room` — and therefore the real `NetHub`,
 * `Simulation` and `ServerWorld` — over an in-memory transport, and build the
 * HELLO bytes by hand so a version the current encoder cannot produce can
 * actually be sent. A test that used `encodeHello` could only ever send the
 * current version, which is precisely the case that was never broken.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_NAME_LENGTH,
  PROTOCOL_MIN_SUPPORTED,
  PROTOCOL_VERSION,
  PacketReader,
  PacketWriter,
  S2C,
  createSessionConfigMessage,
  createUpdateRequiredMessage,
  createWelcomeMessage,
  decodeSessionConfig,
  decodeUpdateRequired,
  decodeWelcome,
  readMessageId,
} from '@doomcraft/shared';
import {
  BUILD_ID,
  CLOSE_HOST_DRAINING,
  CLOSE_PROTOCOL_TOO_NEW,
  CLOSE_PROTOCOL_TOO_OLD,
  CONTENT_VERSION,
  UpdateReason,
  checkProtocol,
} from '@doomcraft/shared/version';
import { FLAG_ORDER, flagOn, resolveFlagBits } from '@doomcraft/shared/flags';

import { CAP_VARIANTS, WEAPON_COUNT, WeaponId } from '@doomcraft/shared';
import { parseVariantsManifest } from '@doomcraft/shared/variants';
import { Room } from './room.js';
import { FlagService, stableIdFor } from './deploy.js';
import type { Connection, NetTransport } from './net.js';

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

/**
 * A HELLO at an arbitrary protocol version, written the way that version's
 * client would have written it.
 *
 *   v1: no avatar, no content version   (outside the window — see below)
 *   v2: avatar                          (inside the window)
 *   v3: avatar + content version        (current)
 *
 * The trailing fields are exactly the append-only pattern the protocol relies
 * on, so this doubles as the proof that `decodeHello` really does tolerate a
 * short packet rather than merely claiming to.
 */
function helloBytes(version: number, opts: {
  name?: string; skin?: number; caps?: number; avatar?: number; contentVersion?: number;
} = {}): Uint8Array {
  const w = new PacketWriter(256);
  w.u8(1);                                  // C2S.HELLO
  w.u8(version & 0xff);
  w.str(opts.name ?? 'Marine', MAX_NAME_LENGTH * 4);
  w.u8((opts.skin ?? 0) & 0xff);
  w.u16((opts.caps ?? 0) & 0xffff);
  if (version >= 2) w.u32((opts.avatar ?? 0) >>> 0);
  if (version >= 3) w.u16((opts.contentVersion ?? CONTENT_VERSION) & 0xffff);
  return w.copy();
}

interface CloseRecord { code: number; reason: string }

/** A socket that keeps every message and the close it got. */
class Client {
  readonly conn: Connection;
  readonly messages: Uint8Array[] = [];
  close: CloseRecord | null = null;
  private open = true;

  constructor(private readonly room: Room) {
    const self = this;
    const transport: NetTransport = {
      get isOpen(): boolean { return self.open; },
      get bufferedAmount(): number { return 0; },
      close(code = 1000, reason = ''): void {
        if (!self.open) return;
        self.open = false;
        self.close = { code, reason };
      },
      send(data: Uint8Array): void {
        if (!self.open) return;
        // Copied: `net.ts` reuses one writer, so the bytes are overwritten on
        // the very next send.
        self.messages.push(data.slice());
      },
    };
    this.conn = room.join(transport);
  }

  hello(version: number, opts?: Parameters<typeof helloBytes>[1]): this {
    this.room.receive(this.conn, helloBytes(version, opts));
    return this;
  }

  first(id: number): Uint8Array | null {
    for (const m of this.messages) if (readMessageId(m) === id) return m;
    return null;
  }

  get welcomed(): boolean { return this.first(S2C.WELCOME) !== null; }
}

const rooms: Room[] = [];

function makeRoom(options: ConstructorParameters<typeof Room>[0] = {}): Room {
  const room = new Room({
    seed: 4242,
    botFill: 0,
    eagerWorld: true,
    clock: () => 0,
    ...options,
  });
  rooms.push(room);
  return room;
}

afterEach(() => {
  for (const r of rooms.splice(0)) r.stop();
});

/* ------------------------------------------------------------------------ *
 * The window
 * ------------------------------------------------------------------------ */

describe('the protocol is a supported window, not an equality test', () => {
  it('has a window that is actually wider than one version', () => {
    // If this ever reads `min === current`, the window has silently collapsed
    // back to equality and every deploy is a logout again.
    expect(PROTOCOL_MIN_SUPPORTED).toBeLessThan(PROTOCOL_VERSION);
  });

  it('serves a client one protocol version behind', () => {
    const c = new Client(makeRoom()).hello(PROTOCOL_VERSION - 1);
    expect(c.close).toBeNull();
    expect(c.welcomed).toBe(true);
    expect(c.conn.protocolVersion).toBe(PROTOCOL_VERSION - 1);
  });

  it('gives that older client a real playable session, not just a WELCOME', () => {
    const room = makeRoom();
    const c = new Client(room).hello(PROTOCOL_VERSION - 1);
    const bytes = c.first(S2C.WELCOME);
    expect(bytes).not.toBeNull();
    const w = decodeWelcome(new PacketReader(bytes as Uint8Array), createWelcomeMessage());
    expect(w.playerId).toBeGreaterThan(0);
    expect(w.chunkCount).toBeGreaterThan(0);
    // A player id it can act with, and terrain on the way.
    room.advance(50);
    expect(c.messages.length).toBeGreaterThan(1);
  });

  it('serves the current version, obviously', () => {
    const c = new Client(makeRoom()).hello(PROTOCOL_VERSION);
    expect(c.welcomed).toBe(true);
  });

  it('refuses a client below the window, with a reason it can act on', () => {
    const c = new Client(makeRoom()).hello(PROTOCOL_MIN_SUPPORTED - 1);
    expect(c.welcomed).toBe(false);
    expect(c.close?.code).toBe(CLOSE_PROTOCOL_TOO_OLD);

    // The structured half: a client new enough to decode it gets the numbers.
    const bytes = c.first(S2C.UPDATE_REQUIRED);
    expect(bytes).not.toBeNull();
    const m = decodeUpdateRequired(new PacketReader(bytes as Uint8Array), createUpdateRequiredMessage());
    expect(m.reason).toBe(UpdateReason.PROTOCOL_TOO_OLD);
    expect(m.serverProtocol).toBe(PROTOCOL_VERSION);
    expect(m.serverMinProtocol).toBe(PROTOCOL_MIN_SUPPORTED);
    expect(m.detail).toContain(String(PROTOCOL_MIN_SUPPORTED - 1));

    // The half that works for a client too old to know the message exists.
    expect(c.close?.reason.length).toBeGreaterThan(0);
  });

  it('tells a client from the FUTURE that the server is the old one', () => {
    // A rollback, or a stale DNS answer pointing at a host that was drained.
    // Nagging this player to "update" would be a lie: they already have.
    const c = new Client(makeRoom()).hello(PROTOCOL_VERSION + 1);
    expect(c.welcomed).toBe(false);
    expect(c.close?.code).toBe(CLOSE_PROTOCOL_TOO_NEW);
    const m = decodeUpdateRequired(
      new PacketReader(c.first(S2C.UPDATE_REQUIRED) as Uint8Array), createUpdateRequiredMessage(),
    );
    expect(m.reason).toBe(UpdateReason.PROTOCOL_TOO_NEW);
  });

  it('sends UPDATE_REQUIRED BEFORE the close, or the client never sees it', () => {
    const c = new Client(makeRoom()).hello(1);
    // The transport drops sends after close, so the message being present at
    // all is the ordering assertion.
    expect(c.first(S2C.UPDATE_REQUIRED)).not.toBeNull();
    expect(c.close).not.toBeNull();
  });

  it('agrees with `checkProtocol`, which is the only place the rule is written', () => {
    for (let v = 0; v <= PROTOCOL_VERSION + 2; v++) {
      const verdict = checkProtocol(v);
      const c = new Client(makeRoom()).hello(v);
      expect(c.welcomed).toBe(verdict.ok);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * Content, pinned per room
 * ------------------------------------------------------------------------ */

describe('content is per-room and pinned at construction', () => {
  it('tells every joiner the room content, not the build content', () => {
    // A room created BEFORE a content bump keeps serving what its players
    // joined for. This is the whole "no in-flight match has its TTK changed"
    // guarantee, expressed as a number on the wire.
    const oldRoom = makeRoom({ contentVersion: CONTENT_VERSION - 1, contentHash: 0xabc123 });
    const c = new Client(oldRoom).hello(PROTOCOL_VERSION, { contentVersion: CONTENT_VERSION });
    const cfg = decodeSessionConfig(
      new PacketReader(c.first(S2C.SESSION_CONFIG) as Uint8Array), createSessionConfigMessage(),
    );
    expect(cfg.contentVersion).toBe(CONTENT_VERSION - 1);
    expect(cfg.contentHash).toBe(0xabc123);
    // And it is not a disconnect. The client adopts; it is not turned away.
    expect(c.welcomed).toBe(true);
  });

  it('records what the client claimed, without trusting it', () => {
    const c = new Client(makeRoom()).hello(PROTOCOL_VERSION, { contentVersion: 99 });
    expect(c.conn.clientContentVersion).toBe(99);
    const cfg = decodeSessionConfig(
      new PacketReader(c.first(S2C.SESSION_CONFIG) as Uint8Array), createSessionConfigMessage(),
    );
    expect(cfg.contentVersion).toBe(CONTENT_VERSION);
  });

  it('reads 0 from a client too old to declare one, and carries on', () => {
    const c = new Client(makeRoom()).hello(2);
    expect(c.conn.clientContentVersion).toBe(0);
    expect(c.welcomed).toBe(true);
  });

  it('names the build for a bug report, and never gates on it', () => {
    const c = new Client(makeRoom()).hello(PROTOCOL_VERSION);
    const cfg = decodeSessionConfig(
      new PacketReader(c.first(S2C.SESSION_CONFIG) as Uint8Array), createSessionConfigMessage(),
    );
    expect(cfg.buildId).toBe(BUILD_ID);
    expect(cfg.serverProtocol).toBe(PROTOCOL_VERSION);
    expect(cfg.serverMinProtocol).toBe(PROTOCOL_MIN_SUPPORTED);
  });
});

/* ------------------------------------------------------------------------ *
 * Flags, resolved server-side
 * ------------------------------------------------------------------------ */

describe('feature flags are resolved by the server and transmitted', () => {
  it('lands a half-built feature dark by default', () => {
    const flags = new FlagService();
    const room = makeRoom({ resolveFlags: (conn) => flags.bitsFor(stableIdFor(conn)) });
    const c = new Client(room).hello(PROTOCOL_VERSION);
    const cfg = decodeSessionConfig(
      new PacketReader(c.first(S2C.SESSION_CONFIG) as Uint8Array), createSessionConfigMessage(),
    );
    expect(flagOn(cfg.flags, 'economy_scrap')).toBe(false);
    expect(flagOn(cfg.flags, 'sponsor_interstitial')).toBe(false);
  });

  it('switches one on for everybody without a deploy', () => {
    const flags = new FlagService();
    flags.load({ revision: 7, rules: { economy_scrap: { force: true, rolloutBp: 0 } } });
    const room = makeRoom({ resolveFlags: (conn) => flags.bitsFor(stableIdFor(conn)) });
    const c = new Client(room).hello(PROTOCOL_VERSION);
    const cfg = decodeSessionConfig(
      new PacketReader(c.first(S2C.SESSION_CONFIG) as Uint8Array), createSessionConfigMessage(),
    );
    expect(flagOn(cfg.flags, 'economy_scrap')).toBe(true);
    // Everything else stayed dark: a flag flip has the blast radius it says.
    for (const key of FLAG_ORDER) {
      if (key === 'economy_scrap' || key === 'client_update_prompt') continue;
      expect(flagOn(cfg.flags, key)).toBe(false);
    }
  });

  it('resolves per player, from the identity the ledger already uses', () => {
    const flags = new FlagService();
    flags.load({ rules: { share_cards: { force: null, rolloutBp: 5000 } } });
    const room = makeRoom({ resolveFlags: (conn) => flags.bitsFor(stableIdFor(conn)) });

    // Two different devices, resolved independently and stably.
    const seen = new Map<string, boolean>();
    for (const device of ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc']) {
      const c = new Client(room);
      c.conn.deviceId = device;
      c.hello(PROTOCOL_VERSION);
      const cfg = decodeSessionConfig(
        new PacketReader(c.first(S2C.SESSION_CONFIG) as Uint8Array), createSessionConfigMessage(),
      );
      seen.set(device, flagOn(cfg.flags, 'share_cards'));
      // The server's own answer and the shared resolver must agree exactly, or
      // the client is being told something the operator cannot reproduce.
      expect(flagOn(cfg.flags, 'share_cards'))
        .toBe(flagOn(resolveFlagBits(flags.document, device), 'share_cards'));
    }
    expect(seen.size).toBe(3);
  });

  it('stamps the resolved bits onto the connection, for logs and for the room', () => {
    const flags = new FlagService();
    flags.load({ rules: { economy_scrap: { force: true, rolloutBp: 0 } } });
    const room = makeRoom({ resolveFlags: (conn) => flags.bitsFor(stableIdFor(conn)) });
    const c = new Client(room).hello(PROTOCOL_VERSION);
    expect(flagOn(c.conn.flagBits, 'economy_scrap')).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * Appending a message id
 * ------------------------------------------------------------------------ */

describe('a message id added after the window opened', () => {
  it('goes to a client from BEFORE it existed without disturbing the session', () => {
    const room = makeRoom();
    // A real v2 handshake — the oldest version still inside the window, and
    // therefore a client whose dispatch switch cannot possibly have a case for
    // an id invented afterwards.
    const c = new Client(room).hello(PROTOCOL_MIN_SUPPORTED);
    expect(c.welcomed).toBe(true);
    const before = c.messages.length;

    room.net.sendMatchAwardTo(c.conn, 120, 14, 4200, 860, 0);

    // It went out, it is the trailing id, and the session is untouched: not
    // closed, still ready, still being served frames.
    expect(c.messages.length).toBe(before + 1);
    expect(readMessageId(c.messages[c.messages.length - 1])).toBe(S2C.MATCH_AWARD);
    expect(S2C.MATCH_AWARD).toBeGreaterThan(S2C.CHUNK_Z);
    expect(c.close).toBeNull();
    expect(c.conn.ready).toBe(true);

    const after = c.messages.length;
    room.advance(50);
    expect(c.messages.length).toBeGreaterThan(after);
    expect(c.close).toBeNull();
  });
});

/* ------------------------------------------------------------------------ *
 * Draining, at the socket
 * ------------------------------------------------------------------------ */

describe('a draining room refuses new players and keeps the ones it has', () => {
  it('turns a new HELLO away with HOST_DRAINING', () => {
    let admitting = true;
    const room = makeRoom({ admitting: () => admitting });

    const inside = new Client(room).hello(PROTOCOL_VERSION);
    expect(inside.welcomed).toBe(true);

    admitting = false;

    const late = new Client(room).hello(PROTOCOL_VERSION);
    expect(late.welcomed).toBe(false);
    expect(late.close?.code).toBe(CLOSE_HOST_DRAINING);
    const m = decodeUpdateRequired(
      new PacketReader(late.first(S2C.UPDATE_REQUIRED) as Uint8Array), createUpdateRequiredMessage(),
    );
    expect(m.reason).toBe(UpdateReason.HOST_DRAINING);
  });

  it('does not touch the player who was already in the match', () => {
    let admitting = true;
    const room = makeRoom({ admitting: () => admitting });
    const inside = new Client(room).hello(PROTOCOL_VERSION);
    const before = inside.messages.length;

    admitting = false;
    new Client(room).hello(PROTOCOL_VERSION);
    room.advance(200);

    expect(inside.close).toBeNull();
    // Still being simulated and still being sent snapshots: the match is live.
    expect(inside.messages.length).toBeGreaterThan(before);
  });
});

/* ------------------------------------------------------------------------ *
 * The capability interlock
 *
 * `onHello` checks the protocol window and whether the host is draining, and
 * nothing else — the test above admits a client declaring content version 99
 * on purpose. So there is no existing barrier that would stop a bundle which
 * predates variants from being welcomed into a room that has them, ignoring
 * opcode 13, and firing the compiled archetype while this server resolved a
 * variant. `CAP_VARIANTS` is that barrier, and this is what it costs to be
 * without it.
 * ------------------------------------------------------------------------ */

describe('a client that cannot decode the table is not given variants', () => {
  const parsed = parseVariantsManifest(JSON.stringify({
    variants: [
      { id: 'four-shell', base: WeaponId.SHOTGUN, name: 'Four Shell', over: { magSize: 4, damage: 10 } },
    ],
  }));

  function variantRoom(): Room {
    expect(parsed.errors).toEqual([]);
    const claims = new Uint8Array(WEAPON_COUNT);
    claims[WeaponId.SHOTGUN] = 1;
    return makeRoom({
      allWeapons: true, variants: parsed.manifest, variantClaims: () => claims,
    });
  }

  it('resolves every claim to the base, and says nothing it cannot decode', () => {
    const room = variantRoom();
    const c = new Client(room).hello(PROTOCOL_VERSION, { caps: 0 });
    expect(c.welcomed).toBe(true);
    expect(c.first(S2C.VARIANT_TABLE)).toBeNull();

    const p = room.sim.getPlayer(c.conn.playerId);
    expect(p).toBeDefined();
    expect([...p!.variantSlots]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    // THE NUMBER THAT MATTERS. Without the interlock this reads 4 while the
    // client, which never heard of variants, holds the archetype's eight.
    expect(p!.mag[WeaponId.SHOTGUN]).toBe(8);
    expect(room.sim.statsFor(p!, WeaponId.SHOTGUN).damage).toBe(11);
  });

  it('and DOES resolve them for a client that set the bit', () => {
    // The positive control, without which the test above passes on a server
    // that resolves nothing for anybody.
    const room = variantRoom();
    const c = new Client(room).hello(PROTOCOL_VERSION, { caps: CAP_VARIANTS });
    expect(c.welcomed).toBe(true);
    expect(c.first(S2C.VARIANT_TABLE)).not.toBeNull();

    const p = room.sim.getPlayer(c.conn.playerId)!;
    expect([...p.variantSlots]).toEqual([0, 1, 0, 0, 0, 0, 0]);
    expect(p.mag[WeaponId.SHOTGUN]).toBe(4);
    expect(room.sim.statsFor(p, WeaponId.SHOTGUN).damage).toBe(10);
  });

  it('a room with no variants pack sends an empty table, not silence', () => {
    // "Count zero" and "a server too old to say anything" are different facts.
    const room = makeRoom({ allWeapons: true });
    const c = new Client(room).hello(PROTOCOL_VERSION, { caps: CAP_VARIANTS });
    const msg = c.first(S2C.VARIANT_TABLE);
    expect(msg).not.toBeNull();
    expect(msg!.length).toBe(2 + WEAPON_COUNT);
  });
});
