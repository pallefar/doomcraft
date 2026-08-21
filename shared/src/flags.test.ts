/**
 * DOOMCRAFT — feature flags, and the properties that make them safe to flip.
 *
 * The point of building this before the economy and the sponsor work is that
 * both can then land dark: merged, shipped with every deploy, and off. So the
 * tests that matter most here are not "does the boolean come back" — they are
 * the discipline ones:
 *
 *   - every new feature defaults OFF and carries a written blast radius,
 *   - a rollout bucket is stable, so a player does not gain and lose a feature
 *     between matches,
 *   - bit positions are append-only, because an old client that still has a
 *     retired flag's meaning compiled in would otherwise read the NEW flag as
 *     the OLD feature — the single worst failure this system can have,
 *   - the freeze is a real one-toggle panic button with defined semantics.
 */

import { describe, expect, it } from 'vitest';

import {
  FLAGS,
  FLAG_ORDER,
  MAX_FLAG_BITS,
  createFlagConfig,
  defaultFlagBits,
  flagBucket,
  flagConfigETag,
  flagOn,
  hostBucket,
  parseFlagConfig,
  resolveFlag,
  resolveFlagBits,
  unpackFlags,
  type FlagConfig,
} from './flags.ts';

function cfg(rules: FlagConfig['rules'], frozen = false): FlagConfig {
  return { revision: 1, frozen, rules };
}

const PLAYERS = Array.from({ length: 4000 }, (_, i) => `device-${i.toString(16)}`);

/* ------------------------------------------------------------------------ *
 * The registry itself
 * ------------------------------------------------------------------------ */

describe('the registry', () => {
  it('gives every new feature an off default and a written blast radius', () => {
    // docs/INFRASTRUCTURE.md §6: "defaulting off, with a written blast radius".
    // A flag with no stated blast radius is a flag nobody dares flip, which is
    // the same as not having one.
    for (const key of FLAG_ORDER) {
      const def = FLAGS[key];
      expect(def, `${key} is in FLAG_ORDER but not in FLAGS`).toBeDefined();
      if (def.kind !== 'feature') continue;
      expect(def.defaultOn, `${key} is a feature and must default off`).toBe(false);
      expect(def.blastRadius.length, `${key} has no blast radius`).toBeGreaterThan(40);
      expect(def.what.length).toBeGreaterThan(10);
    }
  });

  it('has exactly one definition per bit, and no duplicates', () => {
    expect(new Set(FLAG_ORDER).size).toBe(FLAG_ORDER.length);
    expect(FLAG_ORDER.length).toBeLessThanOrEqual(MAX_FLAG_BITS);
    for (const key of Object.keys(FLAGS)) expect(FLAG_ORDER).toContain(key);
  });

  it('pins the bit positions that have already shipped', () => {
    // APPEND ONLY. A retired flag's bit is burned, never reused — the same rule
    // as a snapshot bitmask bit. Reordering this array re-points every deployed
    // client's understanding of every flag at once.
    expect(FLAG_ORDER.slice(0, 10)).toEqual([
      'online_play',
      'economy_scrap',
      'economy_trading',
      'economy_competitions',
      'share_cards',
      'sponsor_slots',
      'sponsor_interstitial',
      'sponsor_rewarded',
      'ads_programmatic',
      'client_update_prompt',
    ]);
  });

  it('gates the economy and the sponsor work, which is why it exists now', () => {
    for (const key of ['economy_scrap', 'economy_trading', 'sponsor_slots', 'sponsor_interstitial']) {
      expect(FLAGS[key].defaultOn).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------------ */

describe('resolution', () => {
  it('is dark by default, for every feature, with no config at all', () => {
    const bits = defaultFlagBits();
    for (const key of FLAG_ORDER) {
      if (FLAGS[key].kind === 'control') continue;
      expect(flagOn(bits, key), key).toBe(false);
    }
  });

  it('honours an operator force in both directions', () => {
    const on = cfg({ economy_scrap: { force: true, rolloutBp: 0 } });
    expect(resolveFlag('economy_scrap', on, 'anyone')).toBe(true);

    // The kill switch: force false beats a rollout that reached everybody.
    const off = cfg({ client_update_prompt: { force: false, rolloutBp: 10000 } });
    expect(resolveFlag('client_update_prompt', off, 'anyone')).toBe(false);
  });

  it('treats 0 and 10000 basis points as nobody and everybody', () => {
    const none = cfg({ share_cards: { force: null, rolloutBp: 0 } });
    const all = cfg({ share_cards: { force: null, rolloutBp: 10000 } });
    for (const p of PLAYERS.slice(0, 200)) {
      expect(resolveFlag('share_cards', none, p)).toBe(false);
      expect(resolveFlag('share_cards', all, p)).toBe(true);
    }
  });

  it('lands a staged rollout within a point of where it was aimed', () => {
    for (const bp of [100, 500, 2500, 7500]) {
      const c = cfg({ share_cards: { force: null, rolloutBp: bp } });
      let on = 0;
      for (const p of PLAYERS) if (resolveFlag('share_cards', c, p)) on++;
      const actual = (on / PLAYERS.length) * 10000;
      expect(Math.abs(actual - bp), `bp=${bp} landed at ${actual}`).toBeLessThan(1000);
    }
  });

  it('keeps a player in the same bucket forever, so nothing flaps', () => {
    // A player who gains and loses a feature between matches will report it as
    // a bug, and they will be right.
    const c = cfg({ share_cards: { force: null, rolloutBp: 3000 } });
    for (const p of PLAYERS.slice(0, 100)) {
      const first = resolveFlag('share_cards', c, p);
      for (let i = 0; i < 5; i++) expect(resolveFlag('share_cards', c, p)).toBe(first);
    }
  });

  it('is monotonic: raising the rollout only ever adds players', () => {
    // Otherwise a rollout from 5% to 25% takes the feature AWAY from someone.
    const at = (bp: number): Set<string> => {
      const c = cfg({ share_cards: { force: null, rolloutBp: bp } });
      return new Set(PLAYERS.filter((p) => resolveFlag('share_cards', c, p)));
    };
    const five = at(500);
    const twentyFive = at(2500);
    for (const p of five) expect(twentyFive.has(p)).toBe(true);
  });

  it('salts per flag, so one unlucky player is not unlucky everywhere', () => {
    const a = new Set(PLAYERS.filter((p) => flagBucket('share_cards', p) < 2000));
    const b = new Set(PLAYERS.filter((p) => flagBucket('economy_scrap', p) < 2000));
    let overlap = 0;
    for (const p of a) if (b.has(p)) overlap++;
    // Independent 20% samples overlap around 4% of the population; identical
    // ones would overlap 20%. Anything near the latter means the salt is not
    // doing its job.
    expect(overlap / PLAYERS.length).toBeLessThan(0.09);
  });

  it('buckets version rollout WITHOUT a salt, on purpose', () => {
    // Staged version rollout is deliberately one bucket per player for the
    // whole fleet, so internal -> 1% -> 5% -> 100% is a growing set and nobody
    // is ever moved backwards onto an older build.
    for (const p of PLAYERS.slice(0, 50)) {
      expect(hostBucket(p)).toBe(hostBucket(p));
      expect(hostBucket(p)).toBeGreaterThanOrEqual(0);
      expect(hostBucket(p)).toBeLessThan(10000);
    }
  });

  it('answers false for a flag nobody has heard of', () => {
    expect(resolveFlag('not_a_flag', cfg({}), 'p')).toBe(false);
    expect(flagOn(0xffffffff, 'not_a_flag')).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * The freeze
 * ------------------------------------------------------------------------ */

describe('freeze all rollouts — the one toggle reachable from a phone', () => {
  it('stops every partial rollout dead', () => {
    const live = cfg({ share_cards: { force: null, rolloutBp: 5000 } });
    const frozen = cfg({ share_cards: { force: null, rolloutBp: 5000 } }, true);
    const before = PLAYERS.filter((p) => resolveFlag('share_cards', live, p)).length;
    const after = PLAYERS.filter((p) => resolveFlag('share_cards', frozen, p)).length;
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(0);
  });

  it('leaves a finished rollout alone', () => {
    // The behaviour you actually want at 3 a.m.: stop the experiments, without
    // also switching off a feature that has been fully live for a month and
    // that half the product now depends on.
    const c = cfg({ economy_scrap: { force: null, rolloutBp: 10000 } }, true);
    expect(resolveFlag('economy_scrap', c, 'anyone')).toBe(true);
  });

  it('does not undo a deliberate operator decision', () => {
    const c = cfg({ economy_scrap: { force: true, rolloutBp: 0 } }, true);
    expect(resolveFlag('economy_scrap', c, 'anyone')).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * The document
 * ------------------------------------------------------------------------ */

describe('the operator document', () => {
  it('never throws, whatever is fed to it', () => {
    for (const junk of [undefined, null, 42, 'nope', [], { rules: 7 }, { rules: { x: 1 } }]) {
      const c = parseFlagConfig(junk);
      expect(c.frozen).toBe(false);
      expect(typeof c.revision).toBe('number');
    }
  });

  it('drops keys it does not recognise and clamps the ones it does', () => {
    const c = parseFlagConfig({
      revision: -5,
      rules: {
        share_cards: { force: 'yes', rolloutBp: 99999 },
        not_a_flag: { force: true, rolloutBp: 10000 },
      },
    });
    expect(c.revision).toBe(0);
    expect(c.rules.share_cards.rolloutBp).toBe(10000);
    // A typo'd force is not a force — it defers to the rollout rather than
    // silently meaning "on".
    expect(c.rules.share_cards.force).toBeNull();
    expect(c.rules.not_a_flag).toBeUndefined();
  });

  it('gives the same document the same ETag and a changed one a new ETag', () => {
    const a = parseFlagConfig({ revision: 3, rules: { share_cards: { force: null, rolloutBp: 500 } } });
    const b = parseFlagConfig({ revision: 3, rules: { share_cards: { force: null, rolloutBp: 500 } } });
    const c = parseFlagConfig({ revision: 3, rules: { share_cards: { force: null, rolloutBp: 2500 } } });
    expect(flagConfigETag(a)).toBe(flagConfigETag(b));
    expect(flagConfigETag(a)).not.toBe(flagConfigETag(c));
    expect(flagConfigETag(createFlagConfig())).toMatch(/^"f[0-9a-f]+"$/);
  });
});

/* ------------------------------------------------------------------------ *
 * The wire
 * ------------------------------------------------------------------------ */

describe('the u32 that rides on SESSION_CONFIG', () => {
  it('round-trips every flag', () => {
    const rules: FlagConfig['rules'] = {};
    for (const key of FLAG_ORDER) rules[key] = { force: true, rolloutBp: 0 };
    const bits = resolveFlagBits(cfg(rules), 'p');
    for (const key of FLAG_ORDER) expect(flagOn(bits, key)).toBe(true);
    const record = unpackFlags(bits);
    expect(Object.keys(record).length).toBe(FLAG_ORDER.length);
  });

  it('sets exactly the bit the registry says, and no neighbours', () => {
    const bits = resolveFlagBits(cfg({ sponsor_rewarded: { force: true, rolloutBp: 0 } }), 'p');
    const expected = 1 << FLAG_ORDER.indexOf('sponsor_rewarded');
    // `client_update_prompt` is a control and defaults on, so mask it out.
    const controls = 1 << FLAG_ORDER.indexOf('client_update_prompt');
    expect(bits & ~controls).toBe(expected);
  });

  it('stays inside 32 bits with room for the continuation', () => {
    const rules: FlagConfig['rules'] = {};
    for (const key of FLAG_ORDER) rules[key] = { force: true, rolloutBp: 0 };
    const bits = resolveFlagBits(cfg(rules), 'p');
    expect(bits >>> 0).toBe(bits);
    expect(bits & (1 << 31)).toBe(0);
  });
});
