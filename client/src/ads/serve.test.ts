/**
 * DOOMCRAFT — the client pipeline's pure decisions (docs/SPONSORS.md §1a, §2.4).
 * The DOM halves are screenshot-verified on a booted host; what is provable in
 * a DOM-less runner is the refusal logic the first-party surfaces hang on, and
 * the decide set the menu entry actually requests.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { SurfaceId, type AdFill } from '@doomcraft/shared/sponsor';

import {
  MENU_DECIDE_SURFACES, createAdPipeline, interCardModel, mustReleaseBefore,
  interstitialModel, interstitialWanted, rewardOffer, rewardSecondsLeft, skipAllowedAt,
  staleCompletion, textFillOrNull, writesOwnCreative,
} from './serve';

function fill(over: Partial<AdFill> = {}): AdFill {
  return {
    surface: SurfaceId.MODE_TILE, source: 'direct', creativeId: 'crv_1', kind: 'text',
    assetUrl: '', clickUrl: '', altText: '', text: 'CubeRealm — voxel worlds, free',
    label: 'Sponsored', modeId: 2, nonce: 'n1', expiresMs: 1,
    ...over,
  };
}

describe('the first-party text gate (S3 badge, S4 boot line)', () => {
  it('accepts exactly a direct-sold text creative with a line', () => {
    expect(textFillOrNull(fill())).not.toBeNull();
  });

  it('refuses house — these surfaces have no house filler by design', () => {
    expect(textFillOrNull(fill({ source: 'house' }))).toBeNull();
  });

  it('refuses asset kinds — nothing can render an image before §2.2', () => {
    expect(textFillOrNull(fill({ kind: 'display' }))).toBeNull();
    expect(textFillOrNull(fill({ kind: 'image' }))).toBeNull();
  });

  it('refuses an empty line, a missing fill, and an absent decide', () => {
    expect(textFillOrNull(fill({ text: '' }))).toBeNull();
    expect(textFillOrNull(null)).toBeNull();
    expect(textFillOrNull(undefined)).toBeNull();
  });
});

describe('the S12 card model', () => {
  const inter = (over: Partial<AdFill> = {}): AdFill =>
    fill({ surface: SurfaceId.INTERMISSION_CARD, clickUrl: '/r/abc', modeId: -1, ...over });

  it('a direct text fill carries its disclosure label, and a click only on an interactive mount', () => {
    const m = interCardModel(inter(), true);
    expect(m).toEqual({ kind: 'text', label: 'Sponsored', text: inter().text, href: '/r/abc', src: '' });
    // The deathmatch board is #hud, pointer-events none — an anchor there
    // would render as a link nobody can follow.
    expect(interCardModel(inter(), false)?.href).toBe('');
  });

  it('a house fill renders the house card, never a click', () => {
    const m = interCardModel(inter({ source: 'house', text: '', label: '' }), true);
    expect(m?.kind).toBe('house');
    expect(m?.href).toBe('');
  });

  it('refuses the wrong surface, an asset kind, and an empty decide', () => {
    expect(interCardModel(fill(), true)).toBeNull();                       // MODE_TILE is not a card
    expect(interCardModel(inter({ kind: 'display' }), true)).toBeNull();   // §2.2 has not shipped
    expect(interCardModel(undefined, true)).toBeNull();
  });
});

describe('the kill-switch probe — the 1a inertness defect', () => {
  const g = globalThis as Record<string, unknown>;
  const realFetch = g.fetch;
  const realLocation = g.location;
  afterEach(() => { g.fetch = realFetch; g.location = realLocation; });

  it('a menu entry whose session bits CANNOT know the flag still asks /api/flags and then decides', async () => {
    // The 1a shape: the menu session is the local worker, whose flag bits
    // never carry sponsor_slots — enabled() is false forever, and the old
    // guard made that terminal. The pipeline must ask the server itself.
    const calls: string[] = [];
    g.location = { origin: 'http://game.test' };
    g.fetch = (url: unknown): Promise<unknown> => {
      calls.push(String(url));
      const body = String(url).includes('/api/flags')
        ? { flags: { sponsor_slots: true } }
        : { fills: [] };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    };
    const pipe = createAdPipeline({
      serverBase: '', deviceId: () => 'd', enabled: () => false,
      adsRemoved: () => false, platform: 'desktop',
    });
    pipe.onMenuEnter();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.some((u) => u.includes('/api/flags'))).toBe(true);
    expect(calls.some((u) => u.includes('/api/ads/decide'))).toBe(true);
  });

  it('a flag the server also says is OFF still kills everything — no decide, ever', async () => {
    const calls: string[] = [];
    g.location = { origin: 'http://game.test' };
    g.fetch = (url: unknown): Promise<unknown> => {
      calls.push(String(url));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ flags: { sponsor_slots: false } }) });
    };
    const pipe = createAdPipeline({
      serverBase: '', deviceId: () => 'd', enabled: () => false,
      adsRemoved: () => false, platform: 'desktop',
    });
    pipe.onMenuEnter();
    const dispose = pipe.intermissionCard({ appendChild: () => {} } as unknown as HTMLElement, {
      mode: 0, interactive: true, active: () => true,
    });
    await new Promise((r) => setTimeout(r, 10));
    dispose();
    expect(calls.filter((u) => u.includes('/api/ads/decide'))).toEqual([]);
  });
});

describe('the menu-entry decide set', () => {
  it('requests the three reserved slots AND the S3 mode-tile badge', () => {
    expect(MENU_DECIDE_SURFACES).toContain(SurfaceId.MENU_TOP);
    expect(MENU_DECIDE_SURFACES).toContain(SurfaceId.MENU_SIDE);
    expect(MENU_DECIDE_SURFACES).toContain(SurfaceId.MENU_BOTTOM);
    expect(MENU_DECIDE_SURFACES).toContain(SurfaceId.MODE_TILE);
  });

  it('does NOT request the boot line or the intermission card there — those decide at their own moments', () => {
    expect(MENU_DECIDE_SURFACES).not.toContain(SurfaceId.BOOT_LINE);
    expect(MENU_DECIDE_SURFACES).not.toContain(SurfaceId.INTERMISSION_CARD);
  });
});

/**
 * Whose pixels is the meter actually measuring?
 *
 * A direct creative REPLACES the house card, and nothing put the house card
 * back. So a slot could still be showing campaign A while a new observer
 * measured it under a HOUSE nonce — crediting unsold inventory with a
 * sponsor's delivery and losing it from the sponsor's own numbers. Everything
 * downstream (the daily rollup, the Viewable Rate, the invoice that layer will
 * one day produce) inherits whatever this decides, so it is decided here, as
 * data, where a DOM-less runner can hold it to account.
 */
describe('a slot is never measured over another fill\'s creative', () => {
  const HOUSE = fill({ source: 'house', kind: 'text', nonce: 'n-house', surface: SurfaceId.MENU_TOP });
  const DIRECT_TEXT = fill({ source: 'direct', kind: 'text', nonce: 'n-direct', surface: SurfaceId.MENU_TOP });
  const DIRECT_IMG = fill({
    source: 'direct', kind: 'display', assetUrl: '/cdn/crv/abc', nonce: 'n-img', surface: SurfaceId.MENU_TOP,
  });

  it('knows which fills write their own creative', () => {
    expect(writesOwnCreative(DIRECT_TEXT)).toBe(true);
    expect(writesOwnCreative(DIRECT_IMG)).toBe(true);
    // House writes nothing by design, and so does a display with no asset.
    expect(writesOwnCreative(HOUSE)).toBe(false);
    expect(writesOwnCreative(fill({ source: 'direct', kind: 'display', assetUrl: '' }))).toBe(false);
  });

  /**
   * THE BUG, as data. RED WITHOUT THE FIX: make `mustReleaseBefore` return
   * false always. The house fill is then measured over campaign A's art.
   */
  it('releases the slot when a house fill would inherit a sponsor\'s art', () => {
    expect(mustReleaseBefore('n-direct', HOUSE), 'house would be measured over a direct creative').toBe(true);
  });

  it('does not release when the fill is about to overwrite the slot anyway', () => {
    expect(mustReleaseBefore('n-direct', DIRECT_TEXT)).toBe(false);
    expect(mustReleaseBefore('n-direct', DIRECT_IMG)).toBe(false);
  });

  it('does not release an unowned slot — the house card is the resting state', () => {
    expect(mustReleaseBefore('', HOUSE)).toBe(false);
  });

  it('does not release when the slot already belongs to this very fill', () => {
    expect(mustReleaseBefore('n-house', HOUSE)).toBe(false);
  });

  /**
   * A late `img.onload` from an earlier menu visit must not drop its bytes into
   * a later visit's slot. RED WITHOUT THE FIX: make `staleCompletion` always
   * false and the earlier visit's art lands under the later visit's nonce.
   */
  it('drops an image completion whose slot has moved on to another fill', () => {
    expect(staleCompletion('n-someone-else', DIRECT_IMG)).toBe(true);
    expect(staleCompletion('n-img', DIRECT_IMG)).toBe(false);
    // An unowned slot is not this fill's either — it was released underneath us.
    expect(staleCompletion('', DIRECT_IMG)).toBe(true);
  });
});

/**
 * S10 — the between-match interstitial.
 *
 * The one surface that interrupts a player who asked for nothing, which is why
 * every rule here fails closed and why the skip timing is a legal requirement
 * rather than a preference.
 */
describe('the interstitial refuses more than it accepts', () => {
  const DIRECT_TEXT = fill({
    surface: SurfaceId.INTERSTITIAL, source: 'direct', kind: 'text',
    text: 'CubeRealm — voxel worlds, free', label: 'Ad',
  });
  const DIRECT_IMG = fill({
    surface: SurfaceId.INTERSTITIAL, source: 'direct', kind: 'display',
    assetUrl: '/cdn/crv/abc', altText: 'CubeRealm key art', text: '',
  });

  it('renders a direct text or display creative', () => {
    expect(interstitialModel(DIRECT_TEXT)?.text).toContain('CubeRealm');
    expect(interstitialModel(DIRECT_IMG)?.imgUrl).toBe('/cdn/crv/abc');
  });

  /**
   * Interrupting a player to show our own house card is pure cost with no
   * revenue against it. The server already declines to mint a house
   * interstitial; this is the client refusing to render one if it ever
   * arrives, because a surface this intrusive should fail closed at both ends.
   */
  it('refuses HOUSE — an interruption with nothing sold behind it', () => {
    expect(interstitialModel(fill({ ...DIRECT_TEXT, source: 'house' }))).toBeNull();
  });

  it('refuses a display creative with no altText', () => {
    // §5.5(10): a creative nobody can describe is a creative nobody can prove
    // was seen, so this is an anti-fraud rule as well as an accessibility one.
    expect(interstitialModel({ ...DIRECT_IMG, altText: '' })).toBeNull();
  });

  it('refuses an empty line, a missing asset, and a missing fill', () => {
    expect(interstitialModel({ ...DIRECT_TEXT, text: '' })).toBeNull();
    expect(interstitialModel({ ...DIRECT_IMG, assetUrl: '' })).toBeNull();
    expect(interstitialModel(null)).toBeNull();
    expect(interstitialModel(undefined)).toBeNull();
  });

  /**
   * THE LEGAL ONE. The UK Age Appropriate Design Code names "a countdown
   * interstitial with a low-contrast or delayed skip control" as a nudge
   * pattern, and docs/SPONSORS.md §5.3 cites it directly. Skip is reachable
   * from the FIRST SECOND.
   *
   * RED WITHOUT THE FIX: raise AD_SKIP_ENABLED_AFTER_MS. The delayed-skip
   * pattern being legislated against is exactly what a larger number builds.
   */
  it('allows the skip from the first second, not later', () => {
    expect(skipAllowedAt(0)).toBe(false);
    expect(skipAllowedAt(999)).toBe(false);
    expect(skipAllowedAt(1_000), 'the skip is delayed past one second').toBe(true);
    expect(skipAllowedAt(15_000)).toBe(true);
  });

  /**
   * `adsRemoved` short-circuits BEFORE the decide, which the spec requires in as
   * many words: the purchase buys silence on the network, so a player who paid
   * must not generate a decide at all — not merely be refused one.
   */
  it('never even asks when the player bought ads off', () => {
    expect(interstitialWanted(true, true, 99, 3), 'a paying player generated a decide').toBe(false);
  });

  it('never asks when the kill switch is off', () => {
    expect(interstitialWanted(false, false, 99, 3)).toBe(false);
  });

  it('waits for the death threshold', () => {
    expect(interstitialWanted(false, true, 2, 3)).toBe(false);
    expect(interstitialWanted(false, true, 3, 3)).toBe(true);
  });
});

/**
 * S11 — the rewarded offer.
 *
 * §1a, on the ad-free player: "Do not simply remove it. If ad-free removes the
 * reward, the $4.99 purchase makes you strictly worse off — the worst possible
 * shape for a monetisation design."
 */
describe('the rewarded offer', () => {
  /**
   * RED WITHOUT THE FIX: drop the `adsRemoved` branch from `rewardOffer`. The
   * ad-free player then falls through to the fill path, gets no offer when no
   * campaign is booked, and the purchase silently costs them the reward.
   */
  it('offers an ad-free player an INSTANT grant with nothing to watch', () => {
    const o = rewardOffer(null, true);
    expect(o.instant, 'the ad-free player was sent to watch a video').toBe(true);
    expect(o.imgUrl).toBe('');
    expect(o.text).toBe('');
  });

  it('offers the creative to everyone else', () => {
    const o = rewardOffer(fill({
      surface: SurfaceId.REWARDED, source: 'direct', kind: 'display',
      assetUrl: '/cdn/crv/x', altText: 'art', label: 'Ad',
    }), false);
    expect(o.instant).toBe(false);
    expect(o.imgUrl).toBe('/cdn/crv/x');
    expect(o.altText).toBe('art');
  });

  /**
   * HOUSE is fine here, unlike the interstitial: the reward is the GRANT, not
   * the ad, so an unsold rewarded watch still pays and is still worth offering.
   */
  it('accepts a house fill, because the reward is the grant and not the ad', () => {
    const o = rewardOffer(fill({ surface: SurfaceId.REWARDED, source: 'house', kind: 'text', text: 'Doomcraft' }), false);
    expect(o.instant).toBe(false);
    expect(o.text).toBe('Doomcraft');
  });

  it('counts the watch down to zero and no further', () => {
    expect(rewardSecondsLeft(0, 15_000)).toBe(15);
    expect(rewardSecondsLeft(14_100, 15_000)).toBe(1);
    expect(rewardSecondsLeft(15_000, 15_000)).toBe(0);
    expect(rewardSecondsLeft(99_000, 15_000)).toBe(0);
  });
});
