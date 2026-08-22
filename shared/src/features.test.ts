/**
 * DOOMCRAFT — the bridge between the client's `Feature` ids and the server's
 * `FLAG_ORDER` names.
 *
 * This file exists because of a specific, verified failure: step 3 of the
 * resolution order written at the top of `features.ts` — *"the server's flag
 * payload, when online"* — **had never executed in any build**. `grep -rn
 * applyServerFlags` over the whole tree returned its own declaration and a
 * mention in a comment, and nothing else.
 *
 * And it could not have worked if it had been called. `applyServerFlags` takes
 * a record keyed by `Feature` ids (`onlineMultiplayer`, `economy`); the only
 * producer in the tree — `FlagService.resolveFor()` — hands back one keyed by
 * `FLAG_ORDER` names (`online_play`, `economy_scrap`). Wiring the call without
 * the map would have written keys that `isEnabled` never reads: a green change
 * with no effect, which is worse than the hole it was closing because it looks
 * shut.
 *
 * So the tests here are about the JOIN, not about the lookup.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  Feature,
  SERVER_FLAG_FOR,
  applyServerFlags,
  featureFlagsFromBits,
  featureFlagsFromServer,
  isEnabled,
} from './features.ts';
import { FLAGS, FLAG_ORDER, createFlagConfig, resolveFlagBits, type FlagConfig } from './flags.ts';

/** Every `Feature` the enum declares. Read off the map, not restated. */
const FEATURES = Object.keys(SERVER_FLAG_FOR) as Feature[];

function bitsFor(rules: FlagConfig['rules']): number {
  return resolveFlagBits({ ...createFlagConfig(), rules }, 'device-does-not-matter');
}

afterEach(() => {
  // The module holds one record. Leaving a flag set would make the next test
  // pass for the previous test's reason.
  applyServerFlags({});
});

describe('the map between the two namespaces', () => {
  it('has a decision for every Feature, so adding one forces somebody to make it', () => {
    // A `Feature` with no entry is not a compile error on its own — the record
    // type would catch a missing key, but only while every key is spelled with
    // the enum. This asserts the shape from the outside as well.
    expect(FEATURES.length).toBeGreaterThanOrEqual(3);
    for (const f of [Feature.ONLINE_MULTIPLAYER, Feature.SHARED_WORLDS, Feature.ECONOMY]) {
      expect(FEATURES, `${f} is not in SERVER_FLAG_FOR`).toContain(f);
    }
  });

  it('names only flags the server actually has — a typo here is a permanent false', () => {
    for (const f of FEATURES) {
      const key = SERVER_FLAG_FOR[f];
      if (key === null) continue;
      expect(FLAG_ORDER, `${f} maps to '${key}', which is not a flag`).toContain(key);
      expect(FLAGS[key]).toBeDefined();
    }
  });

  it('has at least one deliberate null, and null means SILENT rather than false', () => {
    expect(SERVER_FLAG_FOR[Feature.SHARED_WORLDS]).toBeNull();
    const out = featureFlagsFromServer({ online_play: true, economy_scrap: true });
    expect(Object.prototype.hasOwnProperty.call(out, Feature.SHARED_WORLDS)).toBe(false);
  });
});

describe('translating what the server said', () => {
  it('turns FLAG_ORDER names into Feature ids — the join that had never happened', () => {
    const out = featureFlagsFromServer({ online_play: true, economy_scrap: false });
    expect(out[Feature.ONLINE_MULTIPLAYER]).toBe(true);
    expect(out[Feature.ECONOMY]).toBe(false);
    // And it emphatically does NOT pass the server's own key through.
    expect(Object.prototype.hasOwnProperty.call(out, 'online_play')).toBe(false);
  });

  it('omits a flag the server did not mention, rather than reading it as off', () => {
    const out = featureFlagsFromServer({ online_play: true });
    expect(Object.prototype.hasOwnProperty.call(out, Feature.ECONOMY)).toBe(false);
  });

  it('reads the same answer out of the u32 that rides SESSION_CONFIG', () => {
    const bits = bitsFor({
      online_play: { force: true, rolloutBp: 0 },
      economy_scrap: { force: false, rolloutBp: 10000 },
    });
    const out = featureFlagsFromBits(bits);
    expect(out[Feature.ONLINE_MULTIPLAYER]).toBe(true);
    expect(out[Feature.ECONOMY]).toBe(false);
  });
});

describe('the wire, end to end — the thing that had zero callers', () => {
  it('lets the server turn a feature ON for a player who has never touched the toggle', () => {
    expect(isEnabled(Feature.ONLINE_MULTIPLAYER)).toBe(false);   // shipped default
    applyServerFlags(featureFlagsFromBits(bitsFor({ online_play: { force: true, rolloutBp: 0 } })));
    expect(isEnabled(Feature.ONLINE_MULTIPLAYER)).toBe(true);
  });

  it('lets the server turn one OFF again', () => {
    applyServerFlags(featureFlagsFromBits(bitsFor({ online_play: { force: true, rolloutBp: 0 } })));
    expect(isEnabled(Feature.ONLINE_MULTIPLAYER)).toBe(true);
    applyServerFlags(featureFlagsFromBits(bitsFor({ online_play: { force: false, rolloutBp: 0 } })));
    expect(isEnabled(Feature.ONLINE_MULTIPLAYER)).toBe(false);
  });

  it('leaves a feature with no server flag on its shipped default', () => {
    applyServerFlags(featureFlagsFromBits(bitsFor({
      online_play: { force: true, rolloutBp: 0 },
      economy_scrap: { force: true, rolloutBp: 0 },
    })));
    expect(isEnabled(Feature.SHARED_WORLDS)).toBe(false);
  });

  /**
   * THE PROOF THAT THE OLD SHAPE WAS DEAD.
   *
   * Feeding `applyServerFlags` what the server actually produces — a record
   * keyed by `FLAG_ORDER` names — changes nothing at all, because `isEnabled`
   * looks up `Feature` ids. That is the state the repo was in, and it is why
   * "wire the call" was never enough on its own.
   */
  it('does NOTHING when handed the server\'s own key names — the bug, pinned', () => {
    applyServerFlags({ online_play: true, economy_scrap: true });
    expect(isEnabled(Feature.ONLINE_MULTIPLAYER)).toBe(false);
    expect(isEnabled(Feature.ECONOMY)).toBe(false);
  });

  /**
   * A PRODUCT GATE IS NOT A KILL SWITCH, and this is the line.
   *
   * `docs/PLATFORM.md` §5.5(b). The player's own override wins, deliberately:
   * these decide whether somebody is SHOWN something. Anything that grants
   * value is gated a second time on the server-resolved bits, which no browser
   * can reach — `economySurfacesOn` in `client/src/hud/hud.ts` is that pattern.
   */
  it('loses to a player\'s own stored override, which is what makes it a product gate', () => {
    const store = new Map<string, string>();
    const g = globalThis as unknown as { localStorage?: unknown };
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
    g.localStorage = {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => { store.set(k, v); },
      removeItem: (k: string): void => { store.delete(k); },
    };
    try {
      store.set(`dc.ff.${Feature.ONLINE_MULTIPLAYER}`, '0');
      applyServerFlags(featureFlagsFromBits(bitsFor({ online_play: { force: true, rolloutBp: 0 } })));
      expect(isEnabled(Feature.ONLINE_MULTIPLAYER)).toBe(false);
    } finally {
      if (had) delete g.localStorage; else delete g.localStorage;
    }
  });
});
