/**
 * The daily aggregate, and the retention gate that depends on it.
 *
 * Two things are being pinned here. The arithmetic — which bucket a fill lands
 * in, and the exposure sum that must never be a sum — and the ORDER: a raw day
 * is deletable only once its numbers are durable somewhere else.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { AD_LOG_VERSION } from '@doomcraft/shared/sponsor';
import { pruneRaw, readRollup, rollupPending, rollupRows, sweepAdLog } from './adsRollup.js';
import type { AdDayRollup } from './adsRollup.js';
import { adReport } from './admin/model.js';
import type { Measured } from './admin/model.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'dc-adsroll-'));
  dirs.push(d);
  return d;
}

function row(over: Record<string, unknown>): Record<string, unknown> {
  return {
    v: AD_LOG_VERSION, ms: 0, type: 'served', surface: 0, mode: 3, platform: 'desktop',
    source: 'direct', campaignId: 'cmp_1', creativeId: 'crv_1',
    device: 'aabbccdd', sessionId: 'sess-1', ...over,
  };
}

/** Write a raw day shard the way AdService does. */
function writeDay(root: string, day: string, rows: Record<string, unknown>[]): void {
  mkdirSync(join(root, 'ads'), { recursive: true });
  writeFileSync(join(root, 'ads', `${day}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

describe('the daily aggregate keeps the three buckets apart', () => {
  it('splits viewable, measured-failure and undetermined by the verdict basis', () => {
    const r = rollupRows('2026-09-01', [
      row({ type: 'served', nonce: 'n1' }),
      row({ type: 'rendered', nonce: 'n1' }),
      row({ type: 'verdict', nonce: 'n1', qualified: true, basis: 'measured' }),
      row({ type: 'served', nonce: 'n2' }),
      row({ type: 'rendered', nonce: 'n2' }),
      row({ type: 'verdict', nonce: 'n2', qualified: false, basis: 'measured' }),
      row({ type: 'served', nonce: 'n3' }),
      row({ type: 'rendered', nonce: 'n3' }),
      row({ type: 'verdict', nonce: 'n3', qualified: false, basis: 'undetermined' }),
    ]);

    expect(r.served).toBe(3);
    expect(r.rendered).toBe(3);
    expect(r.viewable).toBe(1);
    expect(r.nonViewable, 'undetermined leaked into measured failures').toBe(1);
    expect(r.undetermined).toBe(1);
  });

  /**
   * The player closed the tab, so no verdict was ever sent. That fill was
   * rendered and never measured — metric 4, counted rather than guessed. Leaving
   * it out would quietly shrink the denominator the Measured Rate is judged on,
   * which is the direction that flatters us.
   */
  it('counts a rendered fill with no verdict as undetermined BY ABSENCE', () => {
    const r = rollupRows('2026-09-01', [
      row({ type: 'served', nonce: 'n1' }),
      row({ type: 'rendered', nonce: 'n1' }),
      // no verdict row for n1
    ]);
    expect(r.renderedWithoutVerdict).toBe(1);
    expect(r.undetermined).toBe(1);
    expect(r.nonViewable, 'an unmeasured fill was booked as a measured failure').toBe(0);
  });

  /**
   * Exposure rows carry a RUNNING TOTAL (ads.ts writes the accumulated value on
   * every flush). Summing them multiplies the number by however often the
   * client happened to report.
   */
  it('takes the max per nonce for exposure, never the sum', () => {
    const r = rollupRows('2026-09-01', [
      row({ type: 'exposure', nonce: 'n1', exposureMs: 2_000 }),
      row({ type: 'exposure', nonce: 'n1', exposureMs: 5_000 }),
      row({ type: 'exposure', nonce: 'n1', exposureMs: 9_000 }),
      row({ type: 'exposure', nonce: 'n2', exposureMs: 1_000 }),
    ]);
    // 9000 + 1000. The sum of the rows would be 17000.
    expect(r.exposureMs).toBe(10_000);
  });

  /**
   * A fill whose rows straddle midnight has only part of its exposure in this
   * shard, so the day's total is a LOWER BOUND and the dashboard has to say so.
   */
  it('flags fills whose rows also appear in another shard', () => {
    const r = rollupRows('2026-09-01', [row({ type: 'exposure', nonce: 'n1', exposureMs: 2_000 })], new Set(['n1']));
    expect(r.straddled).toBe(1);
  });

  /**
   * Rows written before the instrumentation carry no `v` and no `nonce`. They
   * are real delivery history, but they cannot answer the same questions, so
   * they are counted apart rather than blended into totals that would imply
   * they are comparable.
   */
  it('counts pre-instrumentation rows apart instead of blending them in', () => {
    const r = rollupRows('2026-09-01', [
      { ms: 0, type: 'impression', surface: 0 },
      row({ type: 'served', nonce: 'n1' }),
    ]);
    expect(r.unversioned).toBe(1);
    expect(r.rows).toBe(2);
    expect(r.served, 'an unversioned row was counted as instrumented').toBe(1);
  });

  it('reports session-uniques and device handles as distinct counts', () => {
    const r = rollupRows('2026-09-01', [
      row({ nonce: 'n1', sessionId: 's1', device: 'd1' }),
      row({ nonce: 'n2', sessionId: 's1', device: 'd1' }),
      row({ nonce: 'n3', sessionId: 's2', device: 'd2' }),
    ]);
    expect(r.sessions).toBe(2);
    expect(r.devices).toBe(2);
  });
});

describe('retention never deletes a day nobody has counted', () => {
  it('rolls up closed days and leaves today alone', () => {
    const root = tempRoot();
    writeDay(root, '2026-09-01', [row({ nonce: 'n1' })]);
    writeDay(root, '2026-09-02', [row({ nonce: 'n2' })]);

    const written = rollupPending(root, '2026-09-02');

    expect(written).toEqual(['2026-09-01']);
    expect(readRollup(root, '2026-09-01')?.served).toBe(1);
    expect(readRollup(root, '2026-09-02'), 'today was rolled up while still being written').toBeNull();
  });

  it('does not rewrite an aggregate it already has', () => {
    const root = tempRoot();
    writeDay(root, '2026-09-01', [row({ nonce: 'n1' })]);
    rollupPending(root, '2026-09-02');
    const first = readFileSync(join(root, 'ads-daily', '2026-09-01.json'), 'utf8');

    writeDay(root, '2026-09-01', [row({ nonce: 'n1' }), row({ nonce: 'n2' })]);
    expect(rollupPending(root, '2026-09-02')).toEqual([]);
    expect(readFileSync(join(root, 'ads-daily', '2026-09-01.json'), 'utf8')).toBe(first);
  });

  /**
   * THE GATE. This is the finding that made aggregation come first: pruning on
   * a timer while the billing job runs on nobody's schedule is a race retention
   * always wins, and the loser is a day of delivery a sponsor was invoiced for.
   *
   * RED WITHOUT THE FIX: delete the `if (!rolled.has(day)) continue;` guard in
   * `pruneRaw`. The un-aggregated day is then destroyed and its numbers are
   * gone for good.
   */
  it('refuses to prune a day that has no durable aggregate', () => {
    const root = tempRoot();
    writeDay(root, '2026-01-01', [row({ nonce: 'n1' })]);

    const pruned = pruneRaw(root, '2026-09-01');

    expect(pruned, 'an uncounted day was deleted').toEqual([]);
    expect(existsSync(join(root, 'ads', '2026-01-01.jsonl'))).toBe(true);
  });

  it('prunes a day past the window once its aggregate is durable', () => {
    const root = tempRoot();
    writeDay(root, '2026-01-01', [row({ nonce: 'n1' })]);
    rollupPending(root, '2026-09-01');

    const pruned = pruneRaw(root, '2026-09-01');

    expect(pruned).toEqual(['2026-01-01']);
    expect(existsSync(join(root, 'ads', '2026-01-01.jsonl')), 'device-keyed rows outlived retention').toBe(false);
    // The aggregate survives. §3.7.5: "aggregates indefinite".
    expect(readRollup(root, '2026-01-01')?.served).toBe(1);
  });

  it('keeps raw days that are still inside the retention window', () => {
    const root = tempRoot();
    writeDay(root, '2026-08-30', [row({ nonce: 'n1' })]);
    rollupPending(root, '2026-09-01');

    expect(pruneRaw(root, '2026-09-01')).toEqual([]);
    expect(existsSync(join(root, 'ads', '2026-08-30.jsonl'))).toBe(true);
  });

  it('sweeps in the right order: aggregate, then prune', () => {
    const root = tempRoot();
    writeDay(root, '2026-01-01', [row({ nonce: 'n1' })]);

    // One pass does both: the day is aggregated and then, being past the
    // window and now durable, pruned.
    const { rolled, pruned } = sweepAdLog(root, '2026-09-01');

    expect(rolled).toContain('2026-01-01');
    expect(pruned).toContain('2026-01-01');
    expect(readRollup(root, '2026-01-01')).not.toBeNull();
    expect(existsSync(join(root, 'ads', '2026-01-01.jsonl'))).toBe(false);
  });
});

/**
 * The report's honesty rules.
 *
 * A wrong number here is worse than no number, because a sponsor prices a buy
 * off it. §3.5's caveat block exists for exactly this, and these are the cases
 * where the tempting answer and the true one differ.
 */
describe('the delivery report refuses rather than invents', () => {
  function report(over: Partial<AdDayRollup> = {}, days = 1): Record<string, unknown> {
    const day: AdDayRollup = {
      v: AD_LOG_VERSION, day: '2026-09-01', rows: 0, byType: {},
      served: 0, rendered: 0, viewable: 0, nonViewable: 0, undetermined: 0,
      renderedWithoutVerdict: 0, byCampaign: {}, bySurface: {}, bySource: {},
      byMode: {}, byPlatform: {}, sessions: 0, devices: 0, exposureMs: 0,
      straddled: 0, unversioned: 0, ...over,
    };
    return adReport({
      days: Array.from({ length: days }, () => day),
      fromDay: '2026-09-01', pendingDays: 0, live: {},
    });
  }

  function m(doc: Record<string, unknown>, group: string, key: string): Measured {
    return (doc[group] as Record<string, Measured>)[key];
  }

  /**
   * THE ONE THAT KILLED THE ORIGINAL DASHBOARD. Viewable Rate is 2/(2+3). With
   * viewable impressions but no measured failures the tempting answer is 100%,
   * and MRC explicitly forbids quoting the viewable share of Total as the
   * Viewable Rate. The honest answer is that it is unavailable.
   *
   * RED WITHOUT THE FIX: change `rate()` to return 100 when the denominator is
   * zero, or to divide by `rendered` instead of by measured.
   */
  it('does not print 100% for a Viewable Rate with no measured failures', () => {
    const doc = report({ rendered: 10, viewable: 0, nonViewable: 0, undetermined: 10 });
    const vr = m(doc, 'rates', 'viewableRate');
    expect(vr.value, 'a rate was invented from an empty denominator').toBeNull();
    expect(vr.reason).toContain('nothing was measured');
  });

  it('does not print 0 for a rate that simply has no denominator', () => {
    const doc = report({ rendered: 0 });
    expect(m(doc, 'rates', 'measuredRate').value).toBeNull();
    expect(m(doc, 'rates', 'measuredRate').reason).toContain('no rendered impressions');
  });

  it('computes both rates from the right denominators when it can', () => {
    /* The two denominators are deliberately DIFFERENT here — 10 rendered, 9
     * measured — because with them equal this test passes just as happily when
     * the Viewable Rate is (wrongly) computed off Total, which is the precise
     * conflation MRC forbids. 8/9 = 88.89%, and 8/10 = 80% is the wrong answer
     * this asserts against. */
    const doc = report({ rendered: 10, viewable: 8, nonViewable: 1, undetermined: 1 });
    expect(m(doc, 'rates', 'measuredRate').value).toBe(90);
    expect(m(doc, 'rates', 'viewableRate').value, 'the rate was computed off Total, not off measured').toBe(88.89);
  });

  /**
   * Metric 7: all three side by side, so quoting the viewable share of Total as
   * the Viewable Rate is impossible rather than merely discouraged.
   */
  it('renders the impression distribution as all three buckets at once', () => {
    const doc = report({ rendered: 10, viewable: 5, nonViewable: 2, undetermined: 3 });
    const dist = (doc.rates as Record<string, unknown>).distributionOfRendered as Record<string, number>;
    expect(dist.viewable).toBe(50);
    expect(dist.nonViewable).toBe(20);
    expect(dist.undetermined).toBe(30);
  });

  /** Exposure that spans a shard boundary is a floor, and says so. */
  it('marks exposure as a lower bound when a fill straddled two days', () => {
    const doc = report({ exposureMs: 9_000, straddled: 1 });
    const e = m(doc, 'exposure', 'totalMs');
    expect(e.value).toBe(9_000);
    expect(e.lowerBound).toBe(true);
    expect(e.reason).toContain('floor');
  });

  /**
   * §3.5 promises the quality-of-exposure block, and it is the part that
   * justifies pricing an in-world surface above a banner. It needs the phase-3
   * ray pipeline, which does not exist — so it is refused BY NAME. A missing
   * row would read as zero.
   */
  it('names the metrics it cannot produce instead of omitting them', () => {
    const doc = report();
    for (const key of ['screenCoverageP50', 'viewAngleBuckets', 'occludedSplit']) {
      const q = m(doc, 'quality', key);
      expect(q.value, `${key} invented a value`).toBeNull();
      expect(q.reason, `${key} gave no reason`).toContain('phase 3');
    }
  });

  /** §3.5: "labelled session-uniques, not person-uniques". */
  it('reports session-uniques and refuses person-uniques', () => {
    const doc = report({ sessions: 12, devices: 9 });
    expect(m(doc, 'audience', 'sessionUniques').value).toBe(12);
    expect(m(doc, 'audience', 'personUniques').value).toBeNull();
    expect(m(doc, 'audience', 'deviceHandles').lowerBound).toBe(true);
  });

  /**
   * No settlement layer exists (docs/SPONSORS.md:1338 claims one shipped and is
   * wrong), so nothing on this screen is an invoice.
   */
  it('marks the whole report provisional', () => {
    expect(report().provisional).toBe(true);
  });

  it('says how many days it could not include', () => {
    const doc = adReport({ days: [], fromDay: '', pendingDays: 3, live: {} });
    expect(doc.pendingDays).toBe(3);
    expect(doc.fromDay).toBe('');
  });

  /** With nothing booked, every impression is unsold house inventory. */
  it('splits house from direct rather than reporting one delivery number', () => {
    const doc = report({ bySource: { house: 7, direct: 3 } });
    const inv = doc.inventory as Record<string, number>;
    expect(inv.house).toBe(7);
    expect(inv.direct).toBe(3);
  });
});
