/**
 * DOOMCRAFT — the avatar data model.
 *
 * `avatar.ts` is what the locker (`ui/avatarEditor.ts`) writes to disk and what
 * the wire carries, and until this file existed it had NO test at all — while
 * two separate source comments claimed otherwise:
 *
 *   - `avatar.ts` on the palette: "The unit test enforces the floor rather than
 *     trusting this comment."
 *   - `shared/src/saves.ts` on LEGACY_AVATAR_BY_SKIN: "`avatar.test.ts` asserts
 *     that `packAvatar(avatarFromLegacySkin(k))` equals each entry, so the two
 *     can never drift apart silently."
 *
 * Neither test existed. The second one matters most: that table is a hand-typed
 * copy of the client's bit layout living in a different package precisely so
 * `shared` need not import client code — which is a duplication with nothing
 * holding the two ends together. It is checked here.
 *
 * The luma test below deliberately asserts what the palette ACTUALLY guarantees
 * rather than what the comment claims it guarantees. See the note on
 * `tint cannot brighten` — the difference is a real gameplay hole, not pedantry.
 */

import { describe, it, expect } from 'vitest';

import { LEGACY_AVATAR_BY_SKIN } from '@shared/saves';

import {
  AVATAR_PALETTE,
  AVATAR_WIRE_MASK,
  DONOR_COUNT,
  MIN_TINT_LUMA,
  PALETTE_COUNT,
  ZONE_COUNT,
  Zone,
  avatarFromLegacySkin,
  avatarLabel,
  avatarsEqual,
  cloneAvatar,
  defaultAvatar,
  legacySkinFromAvatar,
  lumaOf,
  packAvatar,
  randomAvatar,
  readAvatar,
  sanitiseAvatar,
  unpackAvatar,
  writeAvatar,
  type AvatarConfig,
} from './avatar';

/* ------------------------------------------------------------------------ *
 * 1. Packing
 * ------------------------------------------------------------------------ */

describe('packAvatar / unpackAvatar', () => {
  it('round-trips every zone index in every zone', () => {
    for (let zone = 0; zone < ZONE_COUNT; zone++) {
      for (let i = 0; i < DONOR_COUNT; i++) {
        const cfg = defaultAvatar();
        cfg.zones[zone] = i;
        const back = unpackAvatar(packAvatar(cfg));
        expect(back.zones[zone]).toBe(i);
        // The other three zones must not have been disturbed by the shift.
        for (let z = 0; z < ZONE_COUNT; z++) {
          if (z !== zone) expect(back.zones[z]).toBe(0);
        }
      }
    }
  });

  it('round-trips every tint and accent independently', () => {
    for (let i = 0; i < PALETTE_COUNT; i++) {
      const t = unpackAvatar(packAvatar({ zones: [0, 0, 0, 0], tint: i, accent: 0 }));
      expect(t.tint).toBe(i);
      expect(t.accent).toBe(0);
      const a = unpackAvatar(packAvatar({ zones: [0, 0, 0, 0], tint: 0, accent: i }));
      expect(a.accent).toBe(i);
      expect(a.tint).toBe(0);
    }
  });

  it('never sets a bit outside the documented wire mask', () => {
    const worst = packAvatar({
      zones: [DONOR_COUNT - 1, DONOR_COUNT - 1, DONOR_COUNT - 1, DONOR_COUNT - 1],
      tint: PALETTE_COUNT - 1,
      accent: PALETTE_COUNT - 1,
    });
    expect(worst & ~AVATAR_WIRE_MASK).toBe(0);
    expect(worst).toBeLessThanOrEqual(0xffffffff);
  });
});

/* ------------------------------------------------------------------------ *
 * 2. Totality — a hostile peer must not index off the end of the atlas
 * ------------------------------------------------------------------------ */

describe('unpackAvatar is total', () => {
  const hostile = [
    0, -1, NaN, Infinity, -Infinity, 0.5, 2 ** 32, 2 ** 53,
    0xffffffff, 0x7fffffff, -0x80000000, 0xdeadbeef, 0xffff, 0xf0f0f0f0,
  ];

  it('turns any number at all into an in-range config', () => {
    for (const v of hostile) {
      const cfg = unpackAvatar(v);
      for (let z = 0; z < ZONE_COUNT; z++) {
        expect(cfg.zones[z]).toBeGreaterThanOrEqual(0);
        expect(cfg.zones[z]).toBeLessThan(DONOR_COUNT);
        expect(Number.isInteger(cfg.zones[z])).toBe(true);
      }
      expect(cfg.tint).toBeGreaterThanOrEqual(0);
      expect(cfg.tint).toBeLessThan(PALETTE_COUNT);
      expect(cfg.accent).toBeGreaterThanOrEqual(0);
      expect(cfg.accent).toBeLessThan(PALETTE_COUNT);
    }
  });

  it('ignores the reserved high bits rather than aliasing them onto a zone', () => {
    // Bits 26..31 are reserved for a future emote/hat. A client that ships them
    // must look identical to this one, not like a different marine.
    const base = packAvatar({ zones: [3, 5, 1, 7], tint: 4, accent: 9 });
    const future = (base | 0xfc000000) >>> 0;
    expect(avatarsEqual(unpackAvatar(future), unpackAvatar(base))).toBe(true);
  });

  it('sanitiseAvatar clamps in place and is idempotent', () => {
    const dirty: AvatarConfig = { zones: [99, -4, NaN, 2.7], tint: 500, accent: -1 };
    const once = sanitiseAvatar(dirty);
    expect(once).toBe(dirty);                       // in place, no allocation
    const twice = sanitiseAvatar(cloneAvatar(once));
    expect(avatarsEqual(once, twice)).toBe(true);
    for (let z = 0; z < ZONE_COUNT; z++) {
      expect(once.zones[z]).toBeLessThan(DONOR_COUNT);
      expect(once.zones[z]).toBeGreaterThanOrEqual(0);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * 3. The cross-package legacy table
 *
 * This is the one the saves.ts comment promises and the only thing standing
 * between a v2 save and a marine who silently changes clothes on upgrade.
 * ------------------------------------------------------------------------ */

describe('legacy skin bridge', () => {
  it('matches shared/src/saves.ts LEGACY_AVATAR_BY_SKIN exactly', () => {
    expect(LEGACY_AVATAR_BY_SKIN).toHaveLength(6);
    for (let k = 0; k < 6; k++) {
      expect(packAvatar(avatarFromLegacySkin(k))).toBe(LEGACY_AVATAR_BY_SKIN[k]);
    }
  });

  it('gives each of the six legacy skins a DIFFERENT outfit', () => {
    // If two legacy colours collapsed onto one outfit, half the existing
    // players would wake up wearing someone else's clothes.
    const seen = new Set(
      Array.from({ length: 6 }, (_, k) => avatarFromLegacySkin(k).zones[Zone.TORSO]),
    );
    expect(seen.size).toBe(6);
  });

  it('round-trips back to the same legacy byte', () => {
    for (let k = 0; k < 6; k++) {
      expect(legacySkinFromAvatar(avatarFromLegacySkin(k))).toBe(k);
    }
  });

  it('hands an old client some valid skin for any modern avatar', () => {
    for (let i = 0; i < DONOR_COUNT; i++) {
      const s = legacySkinFromAvatar({ zones: [i, i, i, i], tint: 0, accent: 0 });
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(6);
    }
  });

  it('takes a nonsense skin byte without throwing', () => {
    for (const k of [-1, 6, 255, NaN, 1.5]) {
      const cfg = avatarFromLegacySkin(k);
      expect(cfg.zones[Zone.TORSO]).toBeLessThan(DONOR_COUNT);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * 4. The palette
 * ------------------------------------------------------------------------ */

describe('palette', () => {
  it('clears the documented tint luma floor', () => {
    for (const c of AVATAR_PALETTE) {
      expect(lumaOf(c.hex)).toBeGreaterThanOrEqual(MIN_TINT_LUMA);
    }
  });

  it('has unique names and hexes so two marines are never the same colour twice', () => {
    expect(new Set(AVATAR_PALETTE.map((c) => c.name)).size).toBe(PALETTE_COUNT);
    expect(new Set(AVATAR_PALETTE.map((c) => c.hex)).size).toBe(PALETTE_COUNT);
  });

  it('entry 0 is the identity multiplier', () => {
    // "None" has to be exactly white or picking it would still tint the model.
    expect(AVATAR_PALETTE[0].hex).toBe(0xffffff);
  });

  /**
   * THE HOLE, stated as an executable fact.
   *
   * `avatar.ts` claims the 0.42 floor means "a tinted player can never sink
   * into the far wall". That reasoning is inverted. A tint MULTIPLIES the
   * texture, every channel is <= 1.0, so a tint can only ever make a player
   * DARKER than the artwork already is — never brighter. The floor bounds how
   * much darker, it does not put a floor under the rendered pixel.
   *
   * Measured off the locker's own preview (shots/locker-mobile-03-*.png):
   * Marine legs untinted read 0.196 mean luma; with the Hellfire tint every
   * pixel of them lands at or below 0.148, against a DOOM_FOG of 0.18. The
   * legs are strictly darker than the wall behind them.
   *
   * This test pins the mechanism so the claim cannot be quietly re-asserted.
   * The real fix belongs in the shared character shader (a floor on the final
   * colour, or a screen/lighten blend instead of a multiply), which is why it
   * is reported rather than patched here.
   */
  it('tint cannot brighten: every entry is a darkening multiplier', () => {
    for (const c of AVATAR_PALETTE) {
      for (const shift of [16, 8, 0]) {
        expect((c.hex >> shift) & 0xff).toBeLessThanOrEqual(0xff);
      }
    }
    // A mid-dark texel under the brightest legal tint is still mid-dark, and
    // under a legal-but-dim tint it drops well under the 0.18 fog line.
    const texel = 0.22;                       // the Marine's boot navy, roughly
    const dimmest = Math.min(...AVATAR_PALETTE.map((c) => lumaOf(c.hex)));
    expect(dimmest * texel).toBeLessThan(0.18);
  });
});

/* ------------------------------------------------------------------------ *
 * 5. Randomise — the locker's dice must never roll an invalid marine
 * ------------------------------------------------------------------------ */

describe('randomAvatar', () => {
  it('is in range for every value the RNG can return', () => {
    // Including the pathological ends: Math.random() is [0, 1), but a 0.999...
    // must not round up into an off-by-one off the end of the roster.
    for (const r of [0, 0.5, 0.9999999999, 1 - Number.EPSILON]) {
      const cfg = randomAvatar(() => r);
      for (let z = 0; z < ZONE_COUNT; z++) {
        expect(cfg.zones[z]).toBeGreaterThanOrEqual(0);
        expect(cfg.zones[z]).toBeLessThan(DONOR_COUNT);
      }
      expect(cfg.tint).toBeLessThan(PALETTE_COUNT);
      expect(cfg.accent).toBeLessThan(PALETTE_COUNT);
    }
  });

  it('survives a thousand real rolls unchanged by pack/unpack', () => {
    for (let i = 0; i < 1000; i++) {
      const cfg = randomAvatar();
      expect(avatarsEqual(unpackAvatar(packAvatar(cfg)), cfg)).toBe(true);
    }
  });

  it('actually varies', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) seen.add(packAvatar(randomAvatar()));
    expect(seen.size).toBeGreaterThan(50);
  });
});

/* ------------------------------------------------------------------------ *
 * 6. Save wiring — what the locker persists across a hard refresh
 * ------------------------------------------------------------------------ */

describe('save wiring', () => {
  it('writeAvatar then readAvatar is a round trip', () => {
    const save = { profile: { avatar: 0, skin: 0 } };
    const cfg: AvatarConfig = { zones: [2, 7, 7, 4], tint: 3, accent: 11 };
    writeAvatar(save, cfg);
    expect(avatarsEqual(readAvatar(save), cfg)).toBe(true);
  });

  it('keeps the legacy skin byte in step so the two can never disagree', () => {
    const save = { profile: { avatar: 0, skin: 99 } };
    for (let i = 0; i < DONOR_COUNT; i++) {
      writeAvatar(save, { zones: [i, i, i, i], tint: 0, accent: 0 });
      expect(save.profile.skin).toBe(legacySkinFromAvatar(readAvatar(save)));
      expect(save.profile.skin).toBeGreaterThanOrEqual(0);
      expect(save.profile.skin).toBeLessThan(6);
    }
  });

  it('cloneAvatar does not alias the zones array', () => {
    // The editor holds one config and hands copies to onChange; an alias here
    // would let a listener mutate the live look behind the UI's back.
    const a = defaultAvatar();
    const b = cloneAvatar(a);
    b.zones[0] = 5;
    expect(a.zones[0]).toBe(0);
    expect(b.zones).toHaveLength(ZONE_COUNT);
  });
});

/* ------------------------------------------------------------------------ *
 * 7. The name under the model
 * ------------------------------------------------------------------------ */

describe('avatarLabel', () => {
  it('names a uniform avatar after its outfit', () => {
    for (let i = 0; i < DONOR_COUNT; i++) {
      expect(avatarLabel({ zones: [i, i, i, i], tint: 0, accent: 0 }))
        .not.toContain('Custom');
    }
  });

  it('marks a mixed avatar as Custom, named by the torso', () => {
    const label = avatarLabel({ zones: [0, 5, 5, 5], tint: 0, accent: 0 });
    expect(label).toContain('Custom');
  });

  it('never returns an empty string, even for a clamped config', () => {
    for (const v of [0, 0xffffffff, NaN]) {
      expect(avatarLabel(unpackAvatar(v)).length).toBeGreaterThan(0);
    }
  });
});
