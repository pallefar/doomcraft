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
