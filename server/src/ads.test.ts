/**
 * DOOMCRAFT — the ad pipeline refuses (docs/SPONSORS.md §2.4, §3.7, §4.5).
 * Shape of every test: the exact input the spec names as a failure case,
 * fed to the real service, and the refusal observed — plus the log rows,
 * because billing is a batch job over the log.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { SurfaceId, type Campaign, type Creative } from '@doomcraft/shared/sponsor';

import { AdService } from './ads.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dc-ads-'));
  tempDirs.push(d);
  return d;
}

const T0 = Date.UTC(2026, 7, 26, 12, 0, 0);

function textCampaign(over: Partial<Campaign> = {}): { campaigns: Campaign[]; creatives: Creative[] } {
  return {
    creatives: [{
      id: 'crv_text1', sponsorId: 'spn_1', kind: 'text', status: 'approved',
      sha256: '', mime: 'text/plain', bytes: 40, width: 0, height: 0,
      altText: 'Try CubeRealm', text: 'CubeRealm — voxel worlds, free', clickUrl: 'https://example.com/cube',
      rejectReason: '',
    }],
    campaigns: [{
      schema: 1, id: 'cmp_1', sponsorId: 'spn_1', name: 'cube-launch', status: 'live',
      startMs: T0 - 86_400_000, endMs: T0 + 86_400_000,
      budgetMicros: 50_000_000, dailyCapMicros: 50_000_000, pacing: 'even',
      pricing: { model: 'cpm', bidMicros: 2_000_000 },
      targeting: {
        modes: [], regions: [], excludeRegions: [], platforms: [],
        minAccountLevel: 0, ageBands: [], levelIds: [], weekdayMaskUtc: 0, hourMaskUtc: 0,
      },
      caps: { perSessionImpressions: 2, perDayImpressions: 4, minSecondsBetween: 0, perDayInterstitials: 4 },
      placements: [{ surface: SurfaceId.MENU_TOP, creativeIds: ['crv_text1'], weight: 50, floorMicrosCpm: 0 }],
      disclosure: 'ad',
      ...over,
    }],
  };
}

function service(booking: object | null, clockRef: { now: number }): { ads: AdService; root: string } {
  const root = tempDir();
  if (booking !== null) writeFileSync(join(root, 'sponsors.json'), JSON.stringify(booking), 'utf8');
  const ads = new AdService(root, { clock: () => clockRef.now, log: () => {} });
  return { ads, root };
}

const REQ = {
  deviceId: 'device-ads-test-01', sessionId: 'sess-1',
  surfaces: [SurfaceId.MENU_TOP, SurfaceId.MENU_SIDE, SurfaceId.MENU_BOTTOM],
  mode: 0, platform: 'desktop' as const,
};
const CTX = { adsRemoved: false, ageBand: 'unknown' as const, region: '' };

describe('the cascade', () => {
  it('fills every menu slot with house when nothing is booked, and MODE_TILE with nothing', () => {
    const clock = { now: T0 };
    const { ads } = service(null, clock);
    const fills = ads.decide({ ...REQ, surfaces: [...REQ.surfaces, SurfaceId.MODE_TILE] }, CTX);
    expect(fills.map((f) => f.source)).toEqual(['house', 'house', 'house']);
    expect(fills.some((f) => f.surface === SurfaceId.MODE_TILE)).toBe(false);
  });

  it('buys silence with the purchase: adsRemoved short-circuits before any decision', () => {
    const clock = { now: T0 };
    const { ads } = service(textCampaign(), clock);
    expect(ads.decide(REQ, { ...CTX, adsRemoved: true })).toEqual([]);
    expect(ads.counters.fills).toBe(0);
  });

  it('a live text campaign takes its slot; house keeps the others', () => {
    const clock = { now: T0 };
    const { ads } = service(textCampaign(), clock);
    const fills = ads.decide(REQ, CTX);
    const top = fills.find((f) => f.surface === SurfaceId.MENU_TOP);
    expect(top?.source).toBe('direct');
    expect(top?.text).toContain('CubeRealm');
    expect(top?.label).toBe('Ad');
    expect(top?.clickUrl.startsWith('/r/')).toBe(true);
    expect(fills.find((f) => f.surface === SurfaceId.MENU_SIDE)?.source).toBe('house');
  });

  it('fails CLOSED on targeting: unknown region never matches a region list, unknown age never matches an age list', () => {
    const clock = { now: T0 };
    const regionBooked = textCampaign();
    regionBooked.campaigns[0].targeting.regions = ['DK'];
    expect(service(regionBooked, clock).ads.decide(REQ, CTX)
      .find((f) => f.surface === SurfaceId.MENU_TOP)?.source).toBe('house');
    const ageBooked = textCampaign();
    ageBooked.campaigns[0].targeting.ageBands = ['18plus'];
    expect(service(ageBooked, clock).ads.decide(REQ, CTX)
      .find((f) => f.surface === SurfaceId.MENU_TOP)?.source).toBe('house');
  });

  it('skips an unservable creative kind with the reason in the log: video needs phase 2, image has no phase-one surface', () => {
    const clock = { now: T0 };
    const booking = textCampaign();
    booking.creatives[0].kind = 'video';
    const a = service(booking, clock);
    expect(a.ads.decide(REQ, CTX).find((f) => f.surface === SurfaceId.MENU_TOP)?.source).toBe('house');
    expect(readFileSync(join(a.root, 'ads.jsonl'), 'utf8')).toContain('needs phase 2');
    booking.creatives[0].kind = 'image';
    const b = service(booking, clock);
    expect(b.ads.decide(REQ, CTX).find((f) => f.surface === SurfaceId.MENU_TOP)?.source).toBe('house');
    expect(readFileSync(join(b.root, 'ads.jsonl'), 'utf8')).toContain('no phase-one surface');
  });

  it('per-session and per-day caps stop serving after counted impressions', () => {
    const clock = { now: T0 };
    const { ads } = service(textCampaign(), clock);
    for (let i = 0; i < 2; i++) {
      const fill = ads.decide(REQ, CTX).find((f) => f.surface === SurfaceId.MENU_TOP);
      expect(fill?.source).toBe('direct');
      expect(ads.event(fill!.nonce, 'impression', clock.now).ok).toBe(true);
      clock.now += 60_000;
    }
    // Session cap 2 reached: the third decision falls to house.
    expect(ads.decide(REQ, CTX).find((f) => f.surface === SurfaceId.MENU_TOP)?.source).toBe('house');
  });

  it('MODE_TILE: targeting.modes NAMES the tile — the fill carries it and the mode filter is skipped', () => {
    const clock = { now: T0 };
    const booking = textCampaign();
    booking.campaigns[0].placements = [{
      surface: SurfaceId.MODE_TILE, creativeIds: ['crv_text1'], weight: 50, floorMicrosCpm: 0,
    }];
    booking.campaigns[0].targeting.modes = [2]; // HORDE — while the decide comes from the menu with mode 0
    const { ads } = service(booking, clock);
    const fill = ads.decide({ ...REQ, surfaces: [SurfaceId.MODE_TILE] }, CTX)[0];
    expect(fill?.source).toBe('direct');
    expect(fill?.modeId).toBe(2);
    // Every other surface still reports no tile.
    const top = ads.decide(REQ, CTX).find((f) => f.surface === SurfaceId.MENU_TOP);
    expect(top?.modeId).toBe(-1);
  });

  it('MODE_TILE: a badge with no tile named is refused, with the reason in the log — and never falls to house', () => {
    const clock = { now: T0 };
    const booking = textCampaign();
    booking.campaigns[0].placements = [{
      surface: SurfaceId.MODE_TILE, creativeIds: ['crv_text1'], weight: 50, floorMicrosCpm: 0,
    }];
    booking.campaigns[0].targeting.modes = [];
    const { ads, root } = service(booking, clock);
    expect(ads.decide({ ...REQ, surfaces: [SurfaceId.MODE_TILE] }, CTX)).toEqual([]);
    const log = readFileSync(join(root, 'ads.jsonl'), 'utf8');
    expect(log).toContain('must name its tile');
  });

  it('BOOT_LINE: a booked text campaign serves it; an empty book leaves it EMPTY, never house', () => {
    const clock = { now: T0 };
    const booking = textCampaign();
    booking.campaigns[0].placements = [{
      surface: SurfaceId.BOOT_LINE, creativeIds: ['crv_text1'], weight: 50, floorMicrosCpm: 0,
    }];
    const booked = service(booking, clock);
    const fill = booked.ads.decide({ ...REQ, surfaces: [SurfaceId.BOOT_LINE] }, CTX)[0];
    expect(fill?.source).toBe('direct');
    expect(fill?.label).toBe('Ad');
    const empty = service(null, clock);
    expect(empty.ads.decide({ ...REQ, surfaces: [SurfaceId.BOOT_LINE] }, CTX)).toEqual([]);
  });

  it('§2.2: a display campaign SERVES once its asset is uploaded — url from the store, size checked per platform', () => {
    const clock = { now: T0 };
    const booking = textCampaign();
    booking.creatives[0].kind = 'display';
    booking.creatives[0].sha256 = 'ab'.repeat(32);
    const root = tempDir();
    writeFileSync(join(root, 'sponsors.json'), JSON.stringify(booking), 'utf8');
    const ads = new AdService(root, {
      clock: () => clock.now, log: () => {},
      assetFor: (sha) => (sha === 'ab'.repeat(32)
        ? { url: `/cdn/crv/${sha}.png`, width: 728, height: 90 }
        : null),
    });
    const top = ads.decide(REQ, CTX).find((f) => f.surface === SurfaceId.MENU_TOP);
    expect(top?.source).toBe('direct');
    expect(top?.kind).toBe('display');
    expect(top?.assetUrl).toBe(`/cdn/crv/${'ab'.repeat(32)}.png`);
    // The same 728x90 does NOT fit the mobile top slot: house, with the reason logged.
    const mob = ads.decide({ ...REQ, platform: 'mobile' }, CTX).find((f) => f.surface === SurfaceId.MENU_TOP);
    expect(mob?.source).toBe('house');
    const log = readFileSync(join(root, 'ads.jsonl'), 'utf8');
    expect(log).toContain('does not fit surface');
  });

  it('§2.2: a display campaign whose asset was never uploaded still skips, with the reason in the log', () => {
    const clock = { now: T0 };
    const booking = textCampaign();
    booking.creatives[0].kind = 'display';
    booking.creatives[0].sha256 = 'cd'.repeat(32);
    const { ads, root } = service(booking, clock);   // no assetFor at all — §2.2 absent
    expect(ads.decide(REQ, CTX).find((f) => f.surface === SurfaceId.MENU_TOP)?.source).toBe('house');
    const log = readFileSync(join(root, 'ads.jsonl'), 'utf8');
    expect(log).toContain('no uploaded asset');
  });

  it('a broken booking file serves house and does not throw', () => {
    const clock = { now: T0 };
    const root = tempDir();
    writeFileSync(join(root, 'sponsors.json'), '{ not json', 'utf8');
    const ads = new AdService(root, { clock: () => clock.now, log: () => {} });
    expect(ads.decide(REQ, CTX).length).toBe(3);
  });
});

describe('events and the nonce discipline', () => {
  it('counts an impression once, refuses the replayed nonce, refuses the unknown one', () => {
    const clock = { now: T0 };
    const { ads, root } = service(null, clock);
    const fill = ads.decide(REQ, CTX)[0];
    expect(ads.event(fill.nonce, 'impression', clock.now).ok).toBe(true);
    const again = ads.event(fill.nonce, 'impression', clock.now);
    expect(again.ok).toBe(false);
    expect(again.reason).toContain('already counted');
    expect(ads.event('feedfacefeedface', 'impression', clock.now).ok).toBe(false);
    expect(ads.counters.impressions).toBe(1);
    expect(ads.counters.refusedEvents).toBe(2);
    const rows = readFileSync(join(root, 'ads.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string });
    expect(rows.filter((r) => r.type === 'impression').length).toBe(1);
  });
});

describe('the redirector (§4.5)', () => {
  function clickable(clock: { now: number }): { ads: AdService; clickId: string; nonce: string } {
    const { ads } = service(textCampaign(), clock);
    const fill = ads.decide(REQ, CTX).find((f) => f.surface === SurfaceId.MENU_TOP)!;
    return { ads, clickId: fill.clickUrl.slice(3), nonce: fill.nonce };
  }

  it('Gate 1: a click with no impression on record 302s the human and bills nothing', () => {
    const clock = { now: T0 };
    const { ads, clickId } = clickable(clock);
    const hit = ads.redirect(clickId)!;
    expect(hit.target).toBe('https://example.com/cube');
    expect(hit.billable).toBe(false);
    expect(hit.reason).toContain('no impression');
  });

  it('bills exactly once: dwell over 1 s, then the second fetch still 302s but is not counted', () => {
    const clock = { now: T0 };
    const { ads, clickId, nonce } = clickable(clock);
    ads.event(nonce, 'impression', clock.now);
    clock.now += 1_500;
    const first = ads.redirect(clickId)!;
    expect(first.billable).toBe(true);
    const second = ads.redirect(clickId)!;
    expect(second.target).toBe('https://example.com/cube');
    expect(second.billable).toBe(false);
    expect(second.reason).toContain('already used');
    expect(ads.counters.billableClicks).toBe(1);
    expect(ads.counters.clicks).toBe(2);
  });

  it('Gate 2: sub-300 ms dwell is invalid; 300 ms to 1 s is suspect — neither bills', () => {
    for (const [dwell, fragment] of [[120, 'dwell 120ms'], [600, 'suspect']] as const) {
      const clock = { now: T0 };
      const { ads, clickId, nonce } = clickable(clock);
      ads.event(nonce, 'impression', clock.now);
      clock.now += dwell;
      const hit = ads.redirect(clickId)!;
      expect(hit.billable).toBe(false);
      expect(hit.reason).toContain(fragment);
    }
  });

  it('Gate 4: one billable per device+creative per 24 h, even across sessions', () => {
    const clock = { now: T0 };
    const { ads } = service(textCampaign(), clock);
    const bill = (sessionId: string): boolean => {
      const fill = ads.decide({ ...REQ, sessionId }, CTX).find((f) => f.surface === SurfaceId.MENU_TOP)!;
      ads.event(fill.nonce, 'impression', clock.now);
      clock.now += 2_000;
      return ads.redirect(fill.clickUrl.slice(3))!.billable;
    };
    expect(bill('sess-a')).toBe(true);
    expect(bill('sess-b')).toBe(false); // same device, same creative, same day
    expect(ads.counters.billableClicks).toBe(1);
  });

  it('an unknown clickId is null — the route answers 404, never an open redirect', () => {
    const clock = { now: T0 };
    const { ads } = service(null, clock);
    expect(ads.redirect('AAAAAAAAAAAAAAAAAAAAAAAA')).toBeNull();
  });
});
