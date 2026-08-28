/**
 * DOOMCRAFT — the merge, specified to implementation (docs/PLATFORM.md §3.3–
 * §3.8, phase C5).
 *
 * The merge is not "pick one" (destroys progress) and not "add everything"
 * (mints currency and defeats the day caps). It is class-by-class, and the
 * two rules everything else hangs on:
 *
 *  - **Money is never assigned by the merge** (§3.3.1). The merge writes two
 *    journal entries — `merge.debit` against B for its entire balance,
 *    `merge.credit` to A for the same amount — and the balances move with
 *    them. Anyone who writes `a.scrap = a.scrap + b.scrap` has written the
 *    bug this rule exists to prevent.
 *  - **Day buckets roll BOTH sides first, then MAX** (§3.3.2). Sum blows the
 *    caps and throttles the player for a day they did not play; min hands a
 *    farmer a fresh day; max without rolling copies a stale cap forward.
 *
 * In this codebase B is a DEVICE's anonymous profile (row 8's countable
 * unclaimed machine), not a second account — the §3.2 table already refuses
 * to auto-merge two claimed players (row 9), and merging two accounts is a
 * support action that does not exist yet. So the entry point is
 * `mergeDeviceIntoAccount`, the shape a player actually reaches from the
 * account panel's offer.
 *
 * Crash story (§3.4): the merge event is written FIRST in `pending` with
 * the ledger entry ids minted up front; both journal appends are idempotent
 * on `(kind, sourceId, playerId)` with the event id as sourceId; everything
 * runs inside the graph lock. Undo (§3.6) is enabled by the archive this
 * writes — the reversal itself ships with the console's user-management
 * screens (C6), where the support actor it needs actually exists.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { levelForXp } from '@doomcraft/shared/constants';
import type { AccountId, DeviceId } from '@doomcraft/shared/identity';

import type { AccountGraph } from './accountGraph.js';
import { MERGES_PER_LIFETIME, MERGES_PER_WINDOW, MERGE_WINDOW_MS, countableProfile } from './accountGraph.js';
import { newLedgerId, type Journal, type LedgerEntry } from './journal.js';
import {
  MAX_SCRAP_BALANCE, rollDayBucket, utcDay,
  type PersistenceStore, type StoredProfile,
} from './persistence.js';

export const MERGE_LOG_FILE = 'merge.jsonl';

function clampSafe(n: number): number {
  return Math.min(Math.max(0, Math.round(n)), Number.MAX_SAFE_INTEGER);
}

/* ------------------------------------------------------------------------ *
 * Pure planning — what the confirm dialog renders, verbatim
 * ------------------------------------------------------------------------ */

export interface MergePlan {
  readonly scrapMoved: number;
  readonly xpMoved: number;
  readonly matchesMoved: number;
  /** One line per class, rendered verbatim in the confirm dialog. */
  readonly summary: readonly string[];
  readonly notMerged: readonly string[];
}

export function planMerge(a: StoredProfile, b: StoredProfile): MergePlan {
  const scrapMoved = b.economy.scrap;
  const xpMoved = b.progress.xp;
  const matchesMoved = b.stats.matches;
  return Object.freeze({
    scrapMoved, xpMoved, matchesMoved,
    summary: Object.freeze([
      `${xpMoved.toLocaleString()} XP joins yours — level is recomputed from the total.`,
      `${scrapMoved.toLocaleString()} Scrap moves over as a journal entry, never a field edit.`,
      `${matchesMoved.toLocaleString()} matches, kills and build counts add up — they all really happened.`,
      'Records (best streak) keep whichever side is higher.',
      `Your settings and controls stay exactly as they are on ${a.progress.name || 'your account'}.`,
    ]),
    notMerged: Object.freeze([
      'Campaign progress, Builder worlds and Horde records stay on the device they were made on.',
    ]),
  });
}

/**
 * PURE. Mutates `a` in place per the §3.3 field classes and returns the
 * ledger delta the caller must write. MONEY IS NOT TOUCHED HERE.
 */
export function applyMergeFields(a: StoredProfile, b: StoredProfile, nowMs: number): { scrapDelta: number } {
  const pa = a.progress, pb = b.progress;
  const sa = a.stats, sb = b.stats;

  // SUM — counts of things that really happened, on two devices, by one human.
  for (const k of ['kills', 'deaths', 'wins', 'gamesPlayed', 'blocksPlaced', 'blocksBroken', 'secondsPlayed'] as const) {
    pa[k] = clampSafe(pa[k] + pb[k]);
  }
  for (const k of ['matches', 'wins', 'kills', 'deaths', 'damageDealt', 'blocksPlaced', 'blocksBroken', 'secondsPlayed'] as const) {
    sa[k] = clampSafe(sa[k] + sb[k]);
  }
  for (let i = 0; i < sa.weaponKills.length; i++) {
    sa.weaponKills[i] = clampSafe(sa.weaponKills[i] + (sb.weaponKills[i] ?? 0));
  }

  // XP, then and only then the level — summing LEVELS double-counts the curve.
  pa.xp = clampSafe(pa.xp + pb.xp);
  pa.level = levelForXp(pa.xp);

  // MAX — a record is a max, not a total.
  pa.bestKillstreak = Math.max(pa.bestKillstreak, pb.bestKillstreak);
  sa.bestStreak = Math.max(sa.bestStreak, sb.bestStreak);
  sa.lastSeenMs = Math.max(sa.lastSeenMs, sb.lastSeenMs);
  sa.favouriteWeapon = sa.weaponKills.indexOf(Math.max(0, ...sa.weaponKills));

  // DAY — roll BOTH first (§3.3.2), then max. Never sum, never min.
  rollDayBucket(a.economy, nowMs);
  rollDayBucket(b.economy, nowMs);
  a.economy.day = utcDay(nowMs);
  a.economy.dayXp = Math.max(a.economy.dayXp, b.economy.dayXp);
  a.economy.dayScrap = Math.max(a.economy.dayScrap, b.economy.dayScrap);
  a.economy.dayMatches = Math.max(a.economy.dayMatches, b.economy.dayMatches);

  // ENTITLEMENT — two purchases by one human is one entitlement and a
  // duplicate-refund case support must be able to see; receipts stay put on
  // their own records.
  if (b.entitlements.adsRemoved && !a.entitlements.adsRemoved) {
    a.entitlements.adsRemoved = true;
    a.entitlements.product = b.entitlements.product;
    a.entitlements.purchasedMs = b.entitlements.purchasedMs;
  } else if (a.entitlements.adsRemoved && b.entitlements.adsRemoved) {
    a.entitlements.purchasedMs = Math.min(a.entitlements.purchasedMs, b.entitlements.purchasedMs);
  }
  pa.adsRemoved = a.entitlements.adsRemoved;

  // PREFERENCE: A's settings, bindings and loadout are already in place and
  // are not touched — a half-merged control scheme is worse than either one.
  a.createdMs = Math.min(a.createdMs, b.createdMs);

  // BAG — union, A wins on collision; B's bag stays on B's tombstone too.
  if (b._unknown !== undefined) a._unknown = { ...b._unknown, ...(a._unknown ?? {}) };

  // MONEY: never assigned here. The caller writes the journal.
  return { scrapDelta: b.economy.scrap };
}

/* ------------------------------------------------------------------------ *
 * The budget (§3.5)
 * ------------------------------------------------------------------------ */

export interface MergeBudgetState {
  mergesLifetime: number;
  mergesWindowStartMs: number;
  mergesInWindow: number;
}

/** Null = allowed; otherwise when the window next opens (0 = never again). */
export function budgetRefusal(state: MergeBudgetState, nowMs: number): number | null {
  if (state.mergesLifetime >= MERGES_PER_LIFETIME) return 0;
  const windowLive = nowMs - state.mergesWindowStartMs < MERGE_WINDOW_MS;
  if (windowLive && state.mergesInWindow >= MERGES_PER_WINDOW) {
    return state.mergesWindowStartMs + MERGE_WINDOW_MS;
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * The application — impure, inside the graph lock
 * ------------------------------------------------------------------------ */

export interface MergeEventRow {
  id: string;
  ms: number;
  intoAccountId: AccountId;
  fromDeviceId: DeviceId;
  actor: string;
  reason: string;
  state: 'pending' | 'applied' | 'refused';
  ledgerEntryIds: readonly string[];
  scrapMoved: number;
  note: string;
}

export interface MergeDeps {
  graph: AccountGraph;
  store: PersistenceStore;
  journal: Journal | null;
  dataRoot: string;
  clock?: () => number;
}

export type MergeResult =
  | { ok: true; eventId: string; plan: MergePlan }
  | { ok: false; status: number; error: string };

/**
 * Row 8, accepted: absorb the device's anonymous profile into the account,
 * then attach the device so it banks to the account from now on.
 */
export async function mergeDeviceIntoAccount(
  deps: MergeDeps, intoId: AccountId, fromDevice: DeviceId, actor: string, reason: string,
): Promise<MergeResult> {
  const now = deps.clock?.() ?? Date.now();
  return deps.graph.withGraphLock(async () => {
    const account = await deps.graph.get(intoId);
    if (account === null) return { ok: false as const, status: 404, error: 'no such account' };
    if (account.moderation !== 'clear') return { ok: false as const, status: 403, error: 'account is moderated' };

    const home = await deps.graph.accountForDevice(fromDevice);
    if (home !== null) {
      // A claimed device is row 6 or row 9 — never a merge source (§3.2).
      return { ok: false as const, status: 409, error: 'that device already belongs to an account' };
    }

    // Snapshot, not reference: MemoryStore hands back the live object, and
    // the debit below zeroes B's balance — a shared reference would zero the
    // very delta the credit is about to move.
    const pbLive = await deps.store.load(fromDevice);
    if (pbLive === null) return { ok: false as const, status: 404, error: 'nothing to merge on that device' };
    const pb = structuredClone(pbLive);

    if (countableProfile(pb)) {
      const refused = budgetRefusal(account, now);
      if (refused !== null) {
        appendMergeLog(deps.dataRoot, {
          id: newLedgerId(now), ms: now, intoAccountId: intoId, fromDeviceId: fromDevice,
          actor, reason, state: 'refused', ledgerEntryIds: [], scrapMoved: 0,
          note: refused === 0 ? 'lifetime merge budget exhausted' : `window opens ${new Date(refused).toISOString()}`,
        });
        return { ok: false as const, status: 429, error: 'merge budget exhausted — this is the anti-farm cap, not an error' };
      }
    }

    const pa = await deps.store.load(account.primaryDeviceId);
    if (pa === null) return { ok: false as const, status: 409, error: 'the account has no profile of record yet — play one match first' };

    const plan = planMerge(pa, pb);
    const ids = [newLedgerId(now), newLedgerId(now + 1)];   // minted BEFORE any write (§3.4)
    const event: MergeEventRow = {
      id: newLedgerId(now + 2), ms: now, intoAccountId: intoId, fromDeviceId: fromDevice,
      actor, reason, state: 'pending', ledgerEntryIds: ids, scrapMoved: plan.scrapMoved, note: '',
    };
    appendMergeLog(deps.dataRoot, event);

    // §3.6: B is archived, not deleted — the undo's raw material.
    archiveProfile(deps.dataRoot, fromDevice, event.id, pb);

    // The debit against B, then B's balance follows its own journal row.
    await appendLedger(deps.journal, {
      id: ids[0], ms: now, kind: 'merge.debit', sourceId: event.id,
      playerId: fromDevice, currency: 'scrap',
      delta: -pb.economy.scrap, balanceAfter: 0, actor, reason,
    });
    await deps.store.update(fromDevice, (p) => {
      p.economy.scrap = 0;
      p._unknown = { ...(p._unknown ?? {}), mergedInto: intoId, mergedEventId: event.id, mergedMs: now };
    });

    // The credit to A, with every non-money class applied in the same write.
    await deps.store.update(account.primaryDeviceId, (p) => {
      const { scrapDelta } = applyMergeFields(p, pb, now);
      p.economy.scrap = Math.min(p.economy.scrap + scrapDelta, MAX_SCRAP_BALANCE);
      p.economy.lifetimeScrap = Math.min(p.economy.lifetimeScrap + scrapDelta, MAX_SCRAP_BALANCE);
    });
    const after = await deps.store.load(account.primaryDeviceId);
    await appendLedger(deps.journal, {
      id: ids[1], ms: now, kind: 'merge.credit', sourceId: event.id,
      playerId: account.primaryDeviceId, currency: 'scrap',
      delta: plan.scrapMoved, balanceAfter: after?.economy.scrap ?? 0, actor, reason,
    });

    // The device joins the account and banks there from now on.
    await deps.graph.absorbDeviceHoldingLock(intoId, fromDevice, countableProfile(pb), now);

    appendMergeLog(deps.dataRoot, { ...event, state: 'applied' });
    return { ok: true as const, eventId: event.id, plan };
  });
}

async function appendLedger(journal: Journal | null, entry: LedgerEntry): Promise<void> {
  if (journal === null) return;
  // Idempotent on (kind, sourceId, playerId): a crash replay re-runs the
  // same call and the journal refuses the duplicate row.
  if (await journal.has(entry.kind, entry.sourceId, entry.playerId)) return;
  await journal.append([entry]);
}

function appendMergeLog(dataRoot: string, row: MergeEventRow): void {
  try {
    mkdirSync(dataRoot, { recursive: true });
    appendFileSync(join(dataRoot, MERGE_LOG_FILE), JSON.stringify(row) + '\n', 'utf8');
  } catch { /* an unwritable log must not break the merge */ }
}

function archiveProfile(dataRoot: string, device: string, eventId: string, profile: StoredProfile): void {
  try {
    const dir = join(dataRoot, 'merged');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${device}-${eventId}.json`), JSON.stringify(profile, null, 2), 'utf8');
  } catch { /* archive failure is logged by its absence; the merge stands */ }
}
