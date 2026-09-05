/**
 * DOOMCRAFT — the ad pipeline refuses (docs/SPONSORS.md §2.4, §3.7, §4.5).
 * Shape of every test: the exact input the spec names as a failure case,
 * fed to the real service, and the refusal observed — plus the log rows,
 * because billing is a batch job over the log.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { AD_INTERSTITIALS_PER_DAY, AD_LOG_VERSION, SurfaceId, type Campaign, type Creative } from '@doomcraft/shared/sponsor';

import { AdService } from './ads.js';

const tempDirs: string[] = [];
afterAll(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dc-ads-'));
  tempDirs.push(d);
  return d;
}

const T0 = Date.UTC(2026, 7, 26, 12, 0, 0);

/**
 * The log text for the day the test clock is on.
 *
 * Rows are day-sharded under `<root>/ads/<YYYY-MM-DD>.jsonl` so retention can
 * delete a whole day once its aggregate is durable (server/src/adsRollup.ts).
 * `T0` is 2026-08-26, so that is the shard every test here writes to.
 */
function logText(root: string, day = '2026-08-26'): string {
  const path = join(root, 'ads', day + '.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}


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
    expect(logText(a.root)).toContain('needs phase 2');
    booking.creatives[0].kind = 'image';
    const b = service(booking, clock);
    expect(b.ads.decide(REQ, CTX).find((f) => f.surface === SurfaceId.MENU_TOP)?.source).toBe('house');
    expect(logText(b.root)).toContain('no phase-one surface');
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
    const log = logText(root);
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
    const log = logText(root);
    expect(log).toContain('does not fit surface');
  });

  it('§2.2: a display campaign whose asset was never uploaded still skips, with the reason in the log', () => {
    const clock = { now: T0 };
    const booking = textCampaign();
    booking.creatives[0].kind = 'display';
    booking.creatives[0].sha256 = 'cd'.repeat(32);
    const { ads, root } = service(booking, clock);   // no assetFor at all — §2.2 absent
    expect(ads.decide(REQ, CTX).find((f) => f.surface === SurfaceId.MENU_TOP)?.source).toBe('house');
    const log = logText(root);
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
    const rows = logText(root).trim().split('\n').map((l) => JSON.parse(l) as { type: string });
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

/**
 * The log is the billing substrate (§3.7.5: "billing is a batch job over the
 * log, never a live counter"). Before P2a-0 it could not carry that weight: a
 * successful decide wrote NOTHING, so there was no denominator for anything;
 * no row named its fill, so an exposure could not be attributed; and a failed
 * write vanished into a bare `catch {}` while the in-memory counter had already
 * moved. These pin the instrumentation.
 */
describe('the ad log carries what a billing batch job needs', () => {
  /** Every row in the log, parsed. */
  function rowsOf(root: string): Record<string, unknown>[] {
    const raw = logText(root).trim();
    if (raw === '') return [];
    return raw.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  /**
   * RED WITHOUT THE FIX: delete the `served` append in `mint()`. A successful
   * decide then writes no row at all and this file stays empty — which is the
   * whole reason the §3.5 dashboard was found unbuildable.
   */
  it('writes a row when a fill is SERVED — the denominator that did not exist', () => {
    const clock = { now: T0 };
    const { ads, root } = service(textCampaign(), clock);

    const fills = ads.decide(REQ, CTX);
    expect(fills.length).toBeGreaterThan(0);

    const served = rowsOf(root).filter((r) => r.type === 'served');
    expect(served).toHaveLength(fills.length);
    expect(served[0].nonce).toBe(fills[0].nonce);
    expect(served[0].source).toBe(fills[0].source);
  });

  /**
   * The naming is the point, not a detail. `served` is a SERVER-SIDE
   * allocation; the client may never display it. Calling it `rendered` would
   * recreate the conflation §3.5's caveat block exists to forbid, one layer
   * along — an MRC "rendered impression" requires the creative to have begun
   * rendering, which only the client can attest.
   */
  it('does NOT call a server-side allocation "rendered"', () => {
    const clock = { now: T0 };
    const { ads, root } = service(textCampaign(), clock);
    ads.decide(REQ, CTX);
    expect(rowsOf(root).some((r) => r.type === 'rendered')).toBe(false);
  });

  /**
   * RED WITHOUT THE FIX: drop `nonce` from the event append. An exposure row
   * then cannot be tied to the fill it describes, and because exposure rows
   * carry a RUNNING TOTAL, two fills' rows under identical dimensions become
   * indistinguishable from one fill's — max-per-nonce stops being computable.
   */
  it('names the fill on every fill-scoped row, so exposure can be attributed', () => {
    const clock = { now: T0 };
    const { ads, root } = service(textCampaign(), clock);
    const fills = ads.decide(REQ, CTX);
    const nonce = fills[0].nonce;

    expect(ads.event(nonce, 'impression', clock.now).ok).toBe(true);
    clock.now += 5_000;
    expect(ads.event(nonce, 'exposure', clock.now, 5_000).ok).toBe(true);

    const rows = rowsOf(root);
    for (const type of ['served', 'impression', 'exposure']) {
      const row = rows.find((r) => r.type === type);
      expect(row, `no ${type} row`).toBeDefined();
      expect(row?.nonce, `${type} row does not name its fill`).toBe(nonce);
    }
  });

  /**
   * RED WITHOUT THE FIX: remove the `v` stamp in `append`. A reader then cannot
   * tell an instrumented row from a pre-P2a-0 one, and would blend two
   * populations of different quality into one total.
   */
  it('stamps a schema version and the two dimensions nothing could recover later', () => {
    const clock = { now: T0 };
    const { ads, root } = service(textCampaign(), clock);
    ads.decide({ ...REQ, mode: 3, platform: 'mobile' }, CTX);

    for (const row of rowsOf(root)) {
      expect(row.v, 'an unversioned row').toBe(AD_LOG_VERSION);
      expect(row.mode, 'a row with no mode').toBe(3);
      expect(row.platform, 'a row with no platform').toBe('mobile');
    }
  });

  /**
   * A `decide` row is a REFUSAL, not a decision. Several candidate skips and
   * the fill that finally served all belong to ONE decision; without a shared
   * id a reader counting `decide` rows reports several requests where there was
   * one, and computes a fill rate out of nothing.
   */
  it('groups a decision\'s refusals with the fill they preceded', () => {
    const clock = { now: T0 };
    // A video creative is refused ("needs phase 2"), so this decision both
    // skips and then falls through to a house fill.
    const booking = textCampaign();
    booking.creatives[0] = { ...booking.creatives[0], kind: 'video' };
    const { ads, root } = service(booking, clock);

    ads.decide({ ...REQ, surfaces: [SurfaceId.MENU_TOP] }, CTX);

    const rows = rowsOf(root);
    const skip = rows.find((r) => r.type === 'decide');
    const served = rows.find((r) => r.type === 'served');
    expect(skip, 'the video creative was not refused').toBeDefined();
    expect(served, 'no house fill followed the refusal').toBeDefined();
    expect(skip?.decisionId).toBeTruthy();
    expect(served?.decisionId, 'the refusal and the fill look like two decisions')
      .toBe(skip?.decisionId);
  });

  /**
   * RED WITHOUT THE FIX: restore the bare `catch {}` in the writer. The counters
   * then climb while nothing reaches disk and NOTHING SAYS SO — the exact shape
   * that hid the volume incident for six days. Serving still wins; the silence
   * is what is unacceptable in an accounting substrate.
   */
  it('COUNTS rows it failed to persist instead of swallowing them', () => {
    const clock = { now: T0 };
    // A root that cannot be created: a path underneath a regular file. This is
    // a real ENOTDIR from the real fs, not a simulated error (rule 6).
    const blocker = join(tempDir(), 'not-a-dir');
    writeFileSync(blocker, 'x', 'utf8');
    const ads = new AdService(join(blocker, 'nested'), { clock: () => clock.now, log: () => {} });

    const fills = ads.decide(REQ, CTX);
    expect(fills.length, 'serving must survive an unwritable log').toBeGreaterThan(0);
    expect(ads.counters.logWriteFailures, 'a dropped row was not counted').toBeGreaterThan(0);
    expect(ads.status().logWriteFailures).toBe(ads.counters.logWriteFailures);
  });
});

/**
 * The three buckets §3.5 keeps apart, and the arithmetic that depends on it.
 *
 * Metric 6, Viewable Rate, is 2/(2+3) — viewable over viewable plus MEASURED
 * non-viewable. Before this the log had no way to record a failure, so the
 * numerator and the denominator were the same number and the honest value was
 * "unavailable", not 100%. Metric 4, Undetermined, is a THIRD thing: caveat 6
 * says undetermined is not viewable and is not billed, but it is also not a
 * measured failure, and folding it into non-viewable flatters the Measured Rate
 * that MRC asks us to maximise.
 */
describe('viewable, non-viewable and undetermined are three different answers', () => {
  function rowsOf(root: string): Record<string, unknown>[] {
    const raw = logText(root).trim();
    return raw === '' ? [] : raw.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  function oneFill(clock: { now: number }): { ads: AdService; root: string; nonce: string } {
    const { ads, root } = service(textCampaign(), clock);
    const fills = ads.decide(REQ, CTX);
    return { ads, root, nonce: fills[0].nonce };
  }

  /**
   * RED WITHOUT THE FIX: remove the `rendered`/`verdict` branch from
   * `AdService.event`. Both events fall through to 'unknown event type', the
   * rows are never written, and every one of these counts stays 0.
   */
  it('counts a measured failure as non-viewable, NOT as undetermined', () => {
    const clock = { now: T0 };
    const { ads, nonce, root } = oneFill(clock);

    expect(ads.event(nonce, 'rendered', clock.now).ok).toBe(true);
    // Rendered, watched, never met the bar: a measured failure.
    expect(ads.event(nonce, 'verdict', clock.now, 0, { qualified: false, basis: 'measured' }).ok).toBe(true);

    expect(ads.counters.rendered).toBe(1);
    expect(ads.counters.nonViewable).toBe(1);
    expect(ads.counters.undetermined).toBe(0);
    expect(ads.counters.viewable).toBe(0);

    const v = rowsOf(root).find((r) => r.type === 'verdict');
    expect(v?.qualified).toBe(false);
    expect(v?.basis).toBe('measured');
  });

  it('counts a creative that never rendered as undetermined, NOT as a failure', () => {
    const clock = { now: T0 };
    const { ads } = oneFill(clock);
    const nonce = ads.decide({ ...REQ, sessionId: 'sess-2' }, CTX)[0].nonce;

    expect(ads.event(nonce, 'verdict', clock.now, 0, {
      qualified: false, basis: 'undetermined', reason: 'creative never rendered',
    }).ok).toBe(true);

    expect(ads.counters.undetermined).toBe(1);
    expect(ads.counters.nonViewable, 'an unmeasured fill was booked as a measured failure').toBe(0);
  });

  it('counts a qualified fill as viewable', () => {
    const clock = { now: T0 };
    const { ads, nonce } = oneFill(clock);
    expect(ads.event(nonce, 'rendered', clock.now).ok).toBe(true);
    expect(ads.event(nonce, 'verdict', clock.now, 0, { qualified: true, basis: 'measured' }).ok).toBe(true);
    expect(ads.counters.viewable).toBe(1);
    expect(ads.counters.nonViewable).toBe(0);
    expect(ads.counters.undetermined).toBe(0);
  });

  /**
   * A verdict counted twice would deflate the Viewable Rate, and the whole
   * point of these rows is that the rate is arithmetic over them.
   */
  it('refuses a second verdict for the same fill', () => {
    const clock = { now: T0 };
    const { ads, nonce } = oneFill(clock);
    expect(ads.event(nonce, 'verdict', clock.now, 0, { qualified: false, basis: 'measured' }).ok).toBe(true);
    const again = ads.event(nonce, 'verdict', clock.now, 0, { qualified: false, basis: 'measured' });
    expect(again.ok).toBe(false);
    expect(ads.counters.nonViewable, 'a duplicate verdict double-counted').toBe(1);
  });

  /**
   * The route reads a verdict defensively. A client that omits `qualified`, or
   * sends nonsense in `basis`, must not be able to manufacture a viewable
   * impression or a measured failure — it can only cost itself one.
   */
  it('a malformed verdict degrades to undetermined and never to viewable', () => {
    const clock = { now: T0 };
    const { ads, nonce } = oneFill(clock);
    expect(ads.event(nonce, 'verdict', clock.now, 0, { basis: 'nonsense' }).ok).toBe(true);
    expect(ads.counters.viewable).toBe(0);
    expect(ads.counters.nonViewable).toBe(0);
    expect(ads.counters.undetermined).toBe(1);
  });
});

/**
 * S10's platform gates.
 *
 * `FrequencyCap.perDayInterstitials` has been typed, defaulted to 4 and
 * documented as "PLATFORM ceiling ... over any campaign's own number" since the
 * type was written, and read by absolutely nothing. These are the gates a
 * SERVER can enforce; the client also gates on deaths-since-last, which only it
 * can know.
 */
describe('the between-match interstitial is rationed', () => {
  function interBooking(): { campaigns: Campaign[]; creatives: Creative[] } {
    const b = textCampaign();
    b.campaigns[0].placements = [{
      surface: SurfaceId.INTERSTITIAL, creativeIds: ['crv_text1'], weight: 50, floorMicrosCpm: 0,
    }];
    return b;
  }
  const INTER = { ...REQ, surfaces: [SurfaceId.INTERSTITIAL] };

  it('serves one, then refuses until the minimum interval has passed', () => {
    const clock = { now: T0 };
    const { ads } = service(interBooking(), clock);

    expect(ads.decide(INTER, CTX), 'the first interstitial was refused').toHaveLength(1);
    clock.now += 60_000; // well under the 180s floor
    expect(ads.decide(INTER, CTX), 'a second interstitial came too soon').toHaveLength(0);
    clock.now += 130_000; // now past 180s from the first
    expect(ads.decide(INTER, CTX)).toHaveLength(1);
  });

  /**
   * RED WITHOUT THE FIX: delete the `interstitialAllowed` call in `decideOne`.
   * The ceiling that has never been enforced goes back to never being enforced.
   */
  it('stops at the platform ceiling of four per device per day', () => {
    const clock = { now: T0 };
    const { ads } = service(interBooking(), clock);

    let served = 0;
    for (let i = 0; i < 10; i++) {
      served += ads.decide(INTER, CTX).length;
      clock.now += 200_000; // always past the interval, so only the cap can bite
    }
    expect(served, 'the platform ceiling did not hold').toBe(AD_INTERSTITIALS_PER_DAY);
  });

  it('forgives the count on a new UTC day', () => {
    const clock = { now: T0 };
    const { ads } = service(interBooking(), clock);
    for (let i = 0; i < 6; i++) { ads.decide(INTER, CTX); clock.now += 200_000; }

    /* +23h, not +24h: T0 is 12:00 UTC so this is genuinely the next UTC day,
     * and it stays inside the fixture campaign's window (endMs is T0 + 24h
     * exactly, and `now >= endMs` ends it). */
    clock.now = T0 + 23 * 60 * 60 * 1000;
    expect(ads.decide(INTER, CTX), 'the daily count did not roll over').toHaveLength(1);
  });

  it('counts the refusal in the log, with the reason', () => {
    const clock = { now: T0 };
    const { ads, root } = service(interBooking(), clock);
    ads.decide(INTER, CTX);
    clock.now += 1_000;
    ads.decide(INTER, CTX);

    expect(logText(root)).toContain('minimum is 180s');
  });

  /**
   * The decide route used to discard an unservable surface before AdService saw
   * it: no fill, no row, no counter, and a 200 whose fills array simply lacked
   * it. "Surfaces requested" was observable nowhere.
   */
  it('records a surface it cannot serve instead of dropping it silently', () => {
    const clock = { now: T0 };
    const { ads, root } = service(textCampaign(), clock);

    ads.refuseSurfaces([SurfaceId.REWARDED], 3, 'mobile');

    expect(ads.counters.refusedSurfaces).toBe(1);
    expect(logText(root)).toContain('is not servable by this build');
  });
});
