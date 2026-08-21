/**
 * DOOMCRAFT — the three version axes, and the ratchets that keep them honest.
 *
 * Two different kinds of test live here and they are worth telling apart.
 *
 * **Behaviour**: the window accepts what it says it accepts and refuses what it
 * says it refuses.
 *
 * **Ratchets**: a checked-in number that fails when someone moves a constant
 * they should not have moved. These do not prove the code is right; they prove
 * that a change was *noticed*. `docs/INFRASTRUCTURE.md` §6 is explicit that this
 * is the only mechanism that actually stops silent protocol drift — code review
 * does not catch a reordered bitmask bit, and a type system cannot see byte
 * layout. When one of them fails the fix is never "update the number until it
 * passes"; it is "decide which version axis you just moved, move it, and then
 * update the number in the same commit".
 */

import { describe, expect, it } from 'vitest';

import { MAX_NAME_LENGTH } from './constants.ts';
import {
  PROTOCOL_MIN_SUPPORTED,
  PROTOCOL_VERSION,
  PacketReader,
  PacketWriter,
  createHelloMessage,
  createSessionConfigMessage,
  createUpdateRequiredMessage,
  decodeHello,
  decodeSessionConfig,
  decodeUpdateRequired,
  encodeHello,
  encodeSessionConfig,
  encodeUpdateRequired,
  encodeWelcome,
} from './protocol.ts';
import {
  BUILD_ID,
  CLOSE_CODE_BY_REASON,
  CLOSE_PROTOCOL_TOO_NEW,
  CLOSE_PROTOCOL_TOO_OLD,
  CONTENT_FINGERPRINT,
  CONTENT_MIN_SUPPORTED,
  CONTENT_VERSION,
  PROTOCOL_WINDOW_DAYS,
  UPDATE_REASON_TEXT,
  UpdateReason,
  checkProtocol,
  contentFingerprint,
  contentHashFor,
  isProtocolSupported,
  protocolFingerprint,
  requiresClientReload,
  sanitiseBuildId,
} from './version.ts';

const hex = (u: Uint8Array): string => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
const bytes = (h: string): Uint8Array =>
  new Uint8Array((h.match(/../g) ?? []).map((p) => Number.parseInt(p, 16)));

/* ------------------------------------------------------------------------ *
 * The window
 * ------------------------------------------------------------------------ */

describe('the protocol window', () => {
  it('is a range, not an equality test', () => {
    expect(PROTOCOL_MIN_SUPPORTED).toBeLessThan(PROTOCOL_VERSION);
    expect(PROTOCOL_MIN_SUPPORTED).toBeGreaterThan(0);
  });

  it('accepts everything in it and nothing outside it', () => {
    for (let v = PROTOCOL_MIN_SUPPORTED; v <= PROTOCOL_VERSION; v++) {
      expect(isProtocolSupported(v)).toBe(true);
    }
    expect(isProtocolSupported(PROTOCOL_MIN_SUPPORTED - 1)).toBe(false);
    expect(isProtocolSupported(PROTOCOL_VERSION + 1)).toBe(false);
  });

  it('refuses nonsense without pretending it is merely old', () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      const verdict = checkProtocol(v);
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toBe(UpdateReason.PROTOCOL_TOO_OLD);
      expect(verdict.detail.length).toBeGreaterThan(0);
    }
  });

  it('distinguishes "you are behind" from "this host is behind"', () => {
    const old = checkProtocol(PROTOCOL_MIN_SUPPORTED - 1);
    expect(old.reason).toBe(UpdateReason.PROTOCOL_TOO_OLD);
    expect(old.closeCode).toBe(CLOSE_PROTOCOL_TOO_OLD);

    const future = checkProtocol(PROTOCOL_VERSION + 1);
    expect(future.reason).toBe(UpdateReason.PROTOCOL_TOO_NEW);
    expect(future.closeCode).toBe(CLOSE_PROTOCOL_TOO_NEW);
    // "Update your client" would be a lie: they already did. This is a routing
    // problem and the client is told to go find another host.
    expect(requiresClientReload(UpdateReason.PROTOCOL_TOO_NEW)).toBe(false);
  });

  it('only asks the client to reload when the client is the problem', () => {
    expect(requiresClientReload(UpdateReason.PROTOCOL_TOO_OLD)).toBe(true);
    expect(requiresClientReload(UpdateReason.CONTENT_UNAVAILABLE)).toBe(true);
    expect(requiresClientReload(UpdateReason.BUILD_REVOKED)).toBe(true);
    // A draining host is a routing event, not a client defect.
    expect(requiresClientReload(UpdateReason.HOST_DRAINING)).toBe(false);
    expect(requiresClientReload(UpdateReason.NONE)).toBe(false);
  });

  it('has a close code and a player-facing sentence for every reason', () => {
    for (const reason of Object.values(UpdateReason)) {
      if (typeof reason !== 'number') continue;
      expect(CLOSE_CODE_BY_REASON[reason]).toBeTypeOf('number');
      const text = UPDATE_REASON_TEXT[reason];
      expect(text).toBeTypeOf('string');
      if (reason !== UpdateReason.NONE) expect(text.length).toBeGreaterThan(0);
    }
  });

  it('uses private-range close codes, so nothing collides with the RFC ones', () => {
    for (const [reason, code] of Object.entries(CLOSE_CODE_BY_REASON)) {
      if (Number(reason) === UpdateReason.NONE) continue;
      expect(code).toBeGreaterThanOrEqual(4000);
      expect(code).toBeLessThanOrEqual(4999);
    }
  });

  it('publishes the window it promises', () => {
    // The number is a placeholder until there is telemetry to size it from —
    // but a written placeholder that CI can see is the whole point.
    expect(PROTOCOL_WINDOW_DAYS).toBeGreaterThanOrEqual(7);
  });
});

/* ------------------------------------------------------------------------ *
 * Content and build
 * ------------------------------------------------------------------------ */

describe('the other two axes', () => {
  it('keeps content independent of the protocol', () => {
    expect(CONTENT_VERSION).toBeGreaterThanOrEqual(CONTENT_MIN_SUPPORTED);
  });

  it('folds the room\'s own levels into the content hash', () => {
    const bare = contentHashFor();
    expect(contentHashFor([])).toBe(bare);
    // Two hosts on the same CONTENT_VERSION with different level files on disk
    // is a real operational mistake, and only a hash over what was LOADED
    // catches it.
    expect(contentHashFor([0x1234])).not.toBe(bare);
    expect(contentHashFor([0x1234, 0x5678])).not.toBe(contentHashFor([0x5678, 0x1234]));
  });

  it('has a build id that is safe to put in a header and a packet', () => {
    expect(BUILD_ID.length).toBeGreaterThan(0);
    expect(BUILD_ID).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(sanitiseBuildId('a b;c\nd')).toBe('abcd');
    expect(sanitiseBuildId('')).toBe('dev');
    expect(sanitiseBuildId('!!!')).toBe('dev');
    expect(sanitiseBuildId('x'.repeat(200)).length).toBeLessThanOrEqual(32);
  });
});

/* ------------------------------------------------------------------------ *
 * Ratchets
 * ------------------------------------------------------------------------ */

describe('the protocol ratchet', () => {
  it('fails when a quantisation constant, message id or bitmask moves', () => {
    // Moving any of these silently teleports every player, or makes one side
    // read a different field than the other wrote. If this fails:
    //   - was the change ADDITIVE (a new message id at the end, a new trailing
    //     field)? Then it should not have tripped this at all — put it back at
    //     the end where it belongs.
    //   - was it a real layout change? Bump PROTOCOL_VERSION, raise or hold
    //     PROTOCOL_MIN_SUPPORTED deliberately, update docs/CONTRACT.md §5, and
    //     then update this number.
    expect(protocolFingerprint()).toBe(0x04e8d61f);
  });

  it('is stable across calls, so it can be compared between hosts', () => {
    expect(protocolFingerprint()).toBe(protocolFingerprint());
  });
});

describe('the content ratchet', () => {
  it('fails when a weapon or a mode constant changes without a version bump', () => {
    // If this fails you changed balance. That is fine and expected — bump
    // CONTENT_VERSION in shared/src/version.ts and paste the new number here,
    // in the same commit. The point is that the two move together.
    expect(contentFingerprint()).toBe(CONTENT_FINGERPRINT);
  });
});

/* ------------------------------------------------------------------------ *
 * Golden vectors
 *
 * Checked-in bytes for every message the patch system depends on, at the
 * version that ships. A decoder change that alters the meaning of an existing
 * vector breaks these; an ADDITIVE change does not, which is exactly the line
 * the whole design draws.
 * ------------------------------------------------------------------------ */

describe('golden wire vectors', () => {
  const w = new PacketWriter(512);

  it('HELLO, current version, encodes to the frozen bytes', () => {
    expect(hex(encodeHello(w, 'Marine', 4, 0x11, 0x00a09999, 1).copy()))
      .toBe('0103064d6172696e650411009999a0000100');
  });

  it('WELCOME encodes to the frozen bytes', () => {
    expect(hex(encodeWelcome(w, 7, 0x51ee7, 20, 6, 32, 64, 32, 0, 1234, 169).copy()))
      .toBe('01030700e71e0500140620402000d2040000a900');
  });

  it('UPDATE_REQUIRED encodes to the frozen bytes', () => {
    expect(hex(encodeUpdateRequired(w, UpdateReason.PROTOCOL_TOO_OLD, 3, 2, 1, 'too old').copy()))
      .toBe('0a010302010007746f6f206f6c64');
  });

  it('SESSION_CONFIG encodes to the frozen bytes', () => {
    expect(hex(encodeSessionConfig(w, 3, 2, 1, 0xdeadbeef, 0x201, 'abc123').copy()))
      .toBe('0b03020100efbeadde0102000006616263313233');
  });

  it('round-trips every one of them', () => {
    const u = decodeUpdateRequired(
      new PacketReader(bytes('0a010302010007746f6f206f6c64')), createUpdateRequiredMessage(),
    );
    expect(u).toEqual({
      reason: UpdateReason.PROTOCOL_TOO_OLD, serverProtocol: 3, serverMinProtocol: 2,
      contentVersion: 1, detail: 'too old',
    });

    const c = decodeSessionConfig(
      new PacketReader(bytes('0b03020100efbeadde0102000006616263313233')), createSessionConfigMessage(),
    );
    expect(c).toEqual({
      serverProtocol: 3, serverMinProtocol: 2, contentVersion: 1,
      contentHash: 0xdeadbeef, flags: 0x201, buildId: 'abc123',
    });
  });
});

/* ------------------------------------------------------------------------ *
 * The append-only rule, exercised rather than asserted
 * ------------------------------------------------------------------------ */

describe('trailing fields are optional, which is what makes the window possible', () => {
  /** A HELLO as the build of that protocol version would have written it. */
  function helloAt(version: number): Uint8Array {
    const w = new PacketWriter(256);
    w.u8(1);
    w.u8(version);
    w.str('Marine', MAX_NAME_LENGTH * 4);
    w.u8(4);
    w.u16(0x11);
    if (version >= 2) w.u32(0x00a09999);
    if (version >= 3) w.u16(CONTENT_VERSION);
    return w.copy();
  }

  it('decodes a v1 HELLO, which has neither avatar nor content version', () => {
    const m = decodeHello(new PacketReader(helloAt(1)), createHelloMessage());
    expect(m.protocolVersion).toBe(1);
    expect(m.name).toBe('Marine');
    expect(m.caps).toBe(0x11);
    expect(m.avatar).toBe(0);
    expect(m.contentVersion).toBe(0);
  });

  it('decodes a v2 HELLO, which has an avatar but no content version', () => {
    const m = decodeHello(new PacketReader(helloAt(2)), createHelloMessage());
    expect(m.avatar).toBe(0x00a09999);
    expect(m.contentVersion).toBe(0);
  });

  it('decodes a v3 HELLO with everything', () => {
    const m = decodeHello(new PacketReader(helloAt(3)), createHelloMessage());
    expect(m.avatar).toBe(0x00a09999);
    expect(m.contentVersion).toBe(CONTENT_VERSION);
  });

  it('reuses its output object without letting a longer packet bleed into a shorter one', () => {
    const out = createHelloMessage();
    decodeHello(new PacketReader(helloAt(3)), out);
    expect(out.contentVersion).toBe(CONTENT_VERSION);
    // The v1 packet has no content version at all. A decoder that only assigned
    // when the field was present would leave the previous client's value here —
    // and every short HELLO would inherit the last long one's identity.
    decodeHello(new PacketReader(helloAt(1)), out);
    expect(out.contentVersion).toBe(0);
    expect(out.avatar).toBe(0);
  });
});
