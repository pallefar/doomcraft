/**
 * Daily aggregation and retention for the ad log.
 *
 * WHY THIS EXISTS BEFORE THE DASHBOARD, AND BEFORE PRUNING.
 *
 * `docs/SPONSORS.md` §3.7.5 makes two commitments that pull against each other:
 * "billing is a batch job over the log, never a live counter — so any dispute
 * can be replayed byte for byte", and "raw retention 90 days (30 days for any
 * row keyed to `deviceId`), aggregates indefinite". Every row in `ads.jsonl`
 * carries a device handle, so the 30-day clock applies to all of them; and
 * nothing in the tree ever deleted one, so the commitment was being breached in
 * the only direction that is a privacy problem rather than an accounting one.
 *
 * The obvious fix — start pruning — is the dangerous one. Deleting raw rows
 * before anything durable has read them destroys the substrate the billing job
 * is supposed to run over: ship pruning today and the first reader on day 31
 * finds day one already gone, and a monthly query that treats an absent shard
 * as an empty day publishes ZERO IMPRESSIONS FOR A DAY THAT HAD TRAFFIC. So the
 * aggregate comes first and the prune is gated on it. A day is only ever
 * deleted once its numbers are safely somewhere else.
 *
 * The aggregate is also what the dashboard reads. A panel that scanned the raw
 * log per request would inherit its unboundedness as a per-request cost.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AD_LOG_VERSION } from '@doomcraft/shared/sponsor';

const LOG_DIR = 'ads';
const ROLLUP_DIR = 'ads-daily';

/**
 * Device-keyed raw rows live this long. `docs/SPONSORS.md:1267`: "Keep raw
 * per-device rows for ≤30 days, aggregate after that." Every ad row carries a
 * device handle, so this governs the whole shard.
 */
export const AD_RAW_RETENTION_DAYS = 30;

/** One day's aggregate. Written once, kept indefinitely, never rewritten. */
export interface AdDayRollup {
  v: number;
  day: string;
  /** Rows read, including ones this rollup could not classify. */
  rows: number;
  /** Counts by row type: served, rendered, verdict, impression, exposure, … */
  byType: Record<string, number>;
  /** The §3.5 buckets. Kept apart; see the note on `undetermined`. */
  served: number;
  rendered: number;
  viewable: number;
  /** Measured failures ONLY. Never includes `undetermined`. */
  nonViewable: number;
  /**
   * Rendered but never measured. Caveat 6: not viewable, not billed — and not
   * a measured failure either, so it is never folded into `nonViewable`.
   * Includes fills whose verdict never arrived, counted by ABSENCE below.
   */
  undetermined: number;
  /** Rendered rows with no verdict row in this day: undetermined by absence. */
  renderedWithoutVerdict: number;
  byCampaign: Record<string, number>;
  bySurface: Record<string, number>;
  bySource: Record<string, number>;
  byMode: Record<string, number>;
  byPlatform: Record<string, number>;
  /** Session-uniques (NOT person-uniques): distinct session ids seen. */
  sessions: number;
  /** Distinct device handles seen. A 32-bit hash: a floor, not a headcount. */
  devices: number;
  /**
   * Exposure summed as MAX-PER-NONCE within this day, because exposure rows
   * carry a running total and summing them would multiply-count.
   */
  exposureMs: number;
  /**
   * Nonces whose rows also appear in an adjacent shard. Their exposure here is
   * only the part that landed on this day, so `exposureMs` is a LOWER BOUND
   * whenever this is non-zero — and the dashboard has to say so rather than
   * print a total it cannot support.
   */
  straddled: number;
  /** Rows with no `v`: the pre-instrumentation population. Reported apart. */
  unversioned: number;
}

function emptyRollup(day: string): AdDayRollup {
  return {
    v: AD_LOG_VERSION, day, rows: 0, byType: {},
    served: 0, rendered: 0, viewable: 0, nonViewable: 0, undetermined: 0,
    renderedWithoutVerdict: 0,
    byCampaign: {}, bySurface: {}, bySource: {}, byMode: {}, byPlatform: {},
    sessions: 0, devices: 0, exposureMs: 0, straddled: 0, unversioned: 0,
  };
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * Aggregate one day's rows.
 *
 * Pure over the parsed rows so it can be tested without a disk, which matters:
 * this function decides what a sponsor is told, and every bucket boundary in it
 * is one the spec argues about.
 */
export function rollupRows(day: string, rows: Record<string, unknown>[], noncesElsewhere: Set<string> = new Set()): AdDayRollup {
  const out = emptyRollup(day);
  const sessions = new Set<string>();
  const devices = new Set<string>();
  const exposureByNonce = new Map<string, number>();
  const renderedNonces = new Set<string>();
  const verdictNonces = new Set<string>();

  for (const r of rows) {
    out.rows++;
    if (typeof r.v !== 'number') { out.unversioned++; continue; }
    const type = typeof r.type === 'string' ? r.type : '';
    bump(out.byType, type);
    if (typeof r.sessionId === 'string' && r.sessionId !== '') sessions.add(r.sessionId);
    if (typeof r.device === 'string' && r.device !== '') devices.add(r.device);
    if (typeof r.campaignId === 'string' && r.campaignId !== '') bump(out.byCampaign, r.campaignId);
    if (typeof r.surface === 'number') bump(out.bySurface, String(r.surface));
    if (typeof r.source === 'string') bump(out.bySource, r.source);
    if (typeof r.mode === 'number') bump(out.byMode, String(r.mode));
    if (typeof r.platform === 'string' && r.platform !== '') bump(out.byPlatform, r.platform);

    const nonce = typeof r.nonce === 'string' ? r.nonce : '';
    if (type === 'served') out.served++;
    if (type === 'rendered') { out.rendered++; if (nonce !== '') renderedNonces.add(nonce); }
    if (type === 'verdict') {
      if (nonce !== '') verdictNonces.add(nonce);
      // The three-way split, and the one place it must not be simplified.
      if (r.qualified === true) out.viewable++;
      else if (r.basis === 'measured') out.nonViewable++;
      else out.undetermined++;
    }
    if (type === 'exposure' && nonce !== '' && typeof r.exposureMs === 'number') {
      // Running totals: the largest one wins, never the sum.
      exposureByNonce.set(nonce, Math.max(exposureByNonce.get(nonce) ?? 0, r.exposureMs));
    }
    if (nonce !== '' && noncesElsewhere.has(nonce)) out.straddled++;
  }

  /* A fill that rendered and whose verdict never arrived — the player closed
   * the tab — is UNDETERMINED BY ABSENCE. Counting it is what makes metric 4 a
   * measurement of the unmeasured rather than a guess, and leaving it out would
   * quietly shrink the denominator that the Measured Rate is judged on. */
  for (const n of renderedNonces) if (!verdictNonces.has(n)) out.renderedWithoutVerdict++;
  out.undetermined += out.renderedWithoutVerdict;

  out.sessions = sessions.size;
  out.devices = devices.size;
  for (const ms of exposureByNonce.values()) out.exposureMs += ms;
  return out;
}

/** `<root>/ads/<day>.jsonl` → parsed rows. Missing file = no rows, not an error. */
export function readDay(root: string, day: string): Record<string, unknown>[] {
  const path = join(root, LOG_DIR, `${day}.jsonl`);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8').trim();
  if (raw === '') return [];
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    // A torn final line (the process died mid-append) is skipped, not fatal —
    // one unreadable row must not cost a day's aggregate.
    try { out.push(JSON.parse(line) as Record<string, unknown>); } catch { /* torn */ }
  }
  return out;
}

/** The days that have raw shards on disk, oldest first. */
export function rawDays(root: string): string[] {
  const dir = join(root, LOG_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
}

/** The days that have a durable aggregate, oldest first. */
export function rolledDays(root: string): string[] {
  const dir = join(root, ROLLUP_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

export function readRollup(root: string, day: string): AdDayRollup | null {
  const path = join(root, ROLLUP_DIR, `${day}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')) as AdDayRollup; } catch { return null; }
}

/**
 * Aggregate every CLOSED day that has no aggregate yet.
 *
 * Today is deliberately skipped: its shard is still being appended to, and an
 * aggregate written now would be wrong and — because a rollup is written once
 * and never rewritten — permanently wrong.
 */
export function rollupPending(root: string, today: string): string[] {
  const done = new Set(rolledDays(root));
  const written: string[] = [];
  const days = rawDays(root);
  for (const day of days) {
    if (day >= today || done.has(day)) continue;
    // Nonces seen in the neighbouring shards tell us which fills straddle.
    const elsewhere = new Set<string>();
    for (const other of days) {
      if (other === day) continue;
      for (const r of readDay(root, other)) {
        if (typeof r.nonce === 'string' && r.nonce !== '') elsewhere.add(r.nonce);
      }
    }
    const roll = rollupRows(day, readDay(root, day), elsewhere);
    mkdirSync(join(root, ROLLUP_DIR), { recursive: true });
    writeFileSync(join(root, ROLLUP_DIR, `${day}.json`), JSON.stringify(roll), 'utf8');
    written.push(day);
  }
  return written;
}

/**
 * Delete raw shards past the retention window — but ONLY where the day's
 * numbers are already durable.
 *
 * The gate is the whole point. Without it, retention and the billing batch job
 * race, and retention always wins because it is the one on a timer.
 */
export function pruneRaw(root: string, today: string, retentionDays = AD_RAW_RETENTION_DAYS): string[] {
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const oldest = cutoff.toISOString().slice(0, 10);
  const rolled = new Set(rolledDays(root));
  const removed: string[] = [];
  for (const day of rawDays(root)) {
    if (day >= oldest) continue;
    // Not aggregated yet: keep the raw rows and let the next sweep try again.
    // Retaining device-keyed rows a little longer is the lesser harm against
    // deleting a day nobody has counted.
    if (!rolled.has(day)) continue;
    rmSync(join(root, LOG_DIR, `${day}.jsonl`), { force: true });
    removed.push(day);
  }
  return removed;
}

/** One pass: aggregate what is closed, then prune what is safely aggregated. */
export function sweepAdLog(root: string, today: string, retentionDays = AD_RAW_RETENTION_DAYS): {
  rolled: string[]; pruned: string[];
} {
  const rolled = rollupPending(root, today);
  const pruned = pruneRaw(root, today, retentionDays);
  return { rolled, pruned };
}
