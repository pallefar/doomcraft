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

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { levelForXp } from '@doomcraft/shared/constants';
import type { AccountId, DeviceId } from '@doomcraft/shared/identity';

import type { AccountGraph } from './accountGraph.js';
import { MERGES_PER_LIFETIME, MERGES_PER_WINDOW, MERGE_WINDOW_MS, countableProfile } from './accountGraph.js';
import { newLedgerId, type Journal, type LedgerEntry } from './journal.js';
import {
  MAX_ACHIEVEMENT_OWED_MERGED, MAX_ACHIEVEMENT_RECEIPTS, MAX_SCRAP_BALANCE,
  migrateProfile, rollDayBucket, utcDay,
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

  /* CHALLENGES — one human, one board. The journal's idempotency key ends
   * in the PROFILE KEY, so a receipt earned on B stops protecting anything
   * the moment the player is A: without this union the same daily could be
   * completed and paid a second time on the surviving profile in the same
   * period. Counts take the MAX for a shared period (progress is one
   * person's, not two), and debts union so a merge cannot swallow one. */
  const ca = a.challenges;
  const cb = b.challenges;
  /* SCOPED BY PREFIX, not just by clock. Each loop used to copy the WHOLE of
   * B's `done`, so a DAILY receipt crossed whenever the two profiles shared an
   * ISO WEEK — even with different days. The counts loop below already gets
   * this right, and `accrueChallenges` prunes by the same prefix on the roll;
   * only this pair disagreed.
   *
   * It was survivable while the payment loop ignored `done` altogether. It
   * stopped being survivable the moment that loop learned to let a receipt
   * discharge a debt: measured, A earns a daily TODAY in a session that cannot
   * pay, B was paid the same daily YESTERDAY in the same ISO week, and after
   * the merge A's debt is discharged against B's receipt and A is paid
   * NOTHING for a completion A genuinely earned. The prefix is what makes
   * "the same period" mean the same thing on both sides of the union. */
  if (cb.day === ca.day) {
    for (const id of cb.done) {
      if (id.startsWith('daily.') && !ca.done.includes(id)) ca.done.push(id);
    }
  }
  if (cb.week === ca.week) {
    for (const id of cb.done) {
      if (id.startsWith('weekly.') && !ca.done.includes(id)) ca.done.push(id);
    }
  }
  for (const [id, n] of Object.entries(cb.counts)) {
    const samePeriod = id.startsWith('daily.') ? cb.day === ca.day : cb.week === ca.week;
    if (!samePeriod) continue;
    ca.counts[id] = Math.max(ca.counts[id] ?? 0, n);
  }
  for (const o of cb.owed) {
    if (!ca.owed.some((x) => x.sourceId === o.sourceId)) ca.owed.push(o);
  }

  /* ACHIEVEMENTS — the same argument as the challenge receipts above, minus
   * the period test, and that difference is the whole point. A challenge
   * receipt is unioned only within a matching period because its key carries
   * one; an achievement key is `achievement:<id>` for the life of the account,
   * so B's receipt protects A unconditionally or not at all. Without this
   * union B's already-paid award pays a SECOND time under A's journal key —
   * which is not hypothetical: that exact shape was found live in
   * `settleChallenges` and fixed in the same week (the receipt outranks the
   * debt). Promises union by id so a merge cannot swallow one. */
  const aa = a.achievements, ab = b.achievements;
  for (const id of ab.done) if (!aa.done.includes(id)) aa.done.push(id);
  for (const o of ab.owed) if (!aa.owed.some((x) => x.id === o.id)) aa.owed.push(o);

  // BAG — union, A wins on collision; B's bag stays on B's tombstone too.
  if (b._unknown !== undefined) a._unknown = { ...b._unknown, ...(a._unknown ?? {}) };

  // MONEY: never assigned here. The caller writes the journal.
  return { scrapDelta: b.economy.scrap };
}

/**
 * Would this merge overflow A's achievement ledger? A reason to refuse, or null.
 *
 * Truncating either union is not an option: dropping a RECEIPT re-opens payment
 * for that award once the journal forgets the key, and dropping a PROMISE
 * cancels an award the player earned. Both are silent. So the merge is refused
 * whole, BEFORE the debit-and-archive sequence begins — a refused merge is a
 * message the player can act on, a truncated one is a loss nobody sees.
 */
export function achievementMergeRefusal(a: StoredProfile, b: StoredProfile): string | null {
  const done = new Set(a.achievements.done);
  for (const id of b.achievements.done) done.add(id);
  if (done.size > MAX_ACHIEVEMENT_RECEIPTS) {
    return `the merged account would hold ${done.size} achievement receipts, over the `
      + `${MAX_ACHIEVEMENT_RECEIPTS} ceiling — refusing rather than dropping one`;
  }
  const owed = new Set(a.achievements.owed.map((o) => o.id));
  for (const o of b.achievements.owed) owed.add(o.id);
  if (owed.size > MAX_ACHIEVEMENT_OWED_MERGED) {
    return `the merged account would hold ${owed.size} unpaid achievements, over the `
      + `${MAX_ACHIEVEMENT_OWED_MERGED} ceiling — refusing rather than dropping one`;
  }
  return null;
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
  state: 'pending' | 'applied' | 'refused' | 'undone';
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

    /* Refuse BEFORE the debit-and-archive sequence, not during it: past this
     * point B has been archived and debited, and a refusal would have to be
     * unwound. Truncating an achievement union instead would either re-open a
     * paid award or cancel an earned one, both silently. */
    const overflow = achievementMergeRefusal(pa, pb);
    if (overflow !== null) return { ok: false as const, status: 409, error: overflow };

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

/* ------------------------------------------------------------------------ *
 * The §3.6 undo — C6.1, on top of the archive and the journal pair
 * ------------------------------------------------------------------------ */

export type UndoResult =
  | { ok: true; restoredScrap: number; shortfall: number }
  | { ok: false; status: number; error: string };

/** Every row ever appended, oldest first. A bad line is skipped, not fatal. */
export function readMergeLog(dataRoot: string): MergeEventRow[] {
  try {
    const text = readFileSync(join(dataRoot, MERGE_LOG_FILE), 'utf8');
    const out: MergeEventRow[] = [];
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const row = JSON.parse(line) as MergeEventRow;
        if (typeof row.id === 'string' && typeof row.state === 'string') out.push(row);
      } catch { /* a torn line must not hide the rest */ }
    }
    return out;
  } catch {
    return [];
  }
}

function readArchive(dataRoot: string, device: string, eventId: string): StoredProfile | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataRoot, 'merged', `${device}-${eventId}.json`), 'utf8'));
    return migrateProfile(raw, device);
  } catch {
    return null;
  }
}

/**
 * Mutates `a` in place: the archived profile's SUMMED contributions come
 * back out, clamped at zero — A may have played since, and a count can
 * never go negative. MAX-class fields (records, entitlements) deliberately
 * stay: a record was genuinely achieved and an entitlement is support's
 * duplicate-refund case, not the undo's. MONEY IS NOT TOUCHED HERE — the
 * caller moves it with the journal, exactly as the merge did.
 */
export function unApplyMergeFields(a: StoredProfile, b: StoredProfile): void {
  const pa = a.progress, pb = b.progress;
  const sa = a.stats, sb = b.stats;
  for (const k of ['kills', 'deaths', 'wins', 'gamesPlayed', 'blocksPlaced', 'blocksBroken', 'secondsPlayed'] as const) {
    pa[k] = Math.max(0, pa[k] - pb[k]);
  }
  for (const k of ['matches', 'wins', 'kills', 'deaths', 'damageDealt', 'blocksPlaced', 'blocksBroken', 'secondsPlayed'] as const) {
    sa[k] = Math.max(0, sa[k] - sb[k]);
  }
  for (let i = 0; i < sa.weaponKills.length; i++) {
    sa.weaponKills[i] = Math.max(0, sa.weaponKills[i] - (sb.weaponKills[i] ?? 0));
  }
  pa.xp = Math.max(0, pa.xp - pb.xp);
  pa.level = levelForXp(pa.xp);
}

/**
 * Undo one APPLIED merge: the archive restores B, the journal moves the
 * money back (clamped at what A still holds — the shortfall is in the
 * result and the caller's audit row), the device detaches and banks to its
 * own file again. Idempotent and crash-ordered: both profile updates are
 * guarded by the journal's (kind, `undo:<eventId>`, player) key, and the
 * 'undone' log row is appended LAST — a crash mid-undo retries clean.
 */
export async function undoMerge(
  deps: MergeDeps, eventId: string, actor: string, reason: string,
): Promise<UndoResult> {
  const now = deps.clock?.() ?? Date.now();
  return deps.graph.withGraphLock(async () => {
    const rows = readMergeLog(deps.dataRoot);
    const applied = rows.find((r) => r.id === eventId && r.state === 'applied');
    if (applied === undefined) return { ok: false as const, status: 404, error: 'no applied merge with that event id' };
    if (rows.some((r) => r.id === eventId && r.state === 'undone')) {
      return { ok: false as const, status: 409, error: 'that merge is already undone' };
    }
    const archived = readArchive(deps.dataRoot, applied.fromDeviceId, eventId);
    if (archived === null) return { ok: false as const, status: 410, error: 'the archived profile for that merge is gone' };
    const account = await deps.graph.get(applied.intoAccountId);
    if (account === null) return { ok: false as const, status: 404, error: 'the account no longer exists' };

    const undoSource = `undo:${eventId}`;
    const moved = Math.max(0, applied.scrapMoved);

    // A gives back what it still can; the un-sum rides the same guard so a
    // replayed undo can neither double-debit nor double-subtract.
    let clawed = 0;
    await deps.store.update(account.primaryDeviceId, async (p) => {
      if (deps.journal !== null && await deps.journal.has('merge.debit', undoSource, account.primaryDeviceId)) return;
      clawed = Math.min(moved, p.economy.scrap);
      p.economy.scrap -= clawed;
      unApplyMergeFields(p, archived);
      if (deps.journal !== null) {
        await deps.journal.append([{
          id: newLedgerId(now), ms: now, kind: 'merge.debit', sourceId: undoSource,
          playerId: account.primaryDeviceId, currency: 'scrap',
          delta: -clawed, balanceAfter: p.economy.scrap, actor, reason,
        }]);
      }
    });

    // B comes back as archived, balance restored THROUGH the journal.
    await deps.store.update(applied.fromDeviceId, async (p) => {
      if (deps.journal !== null && await deps.journal.has('merge.credit', undoSource, applied.fromDeviceId)) return;
      p.progress = structuredClone(archived.progress);
      p.settings = structuredClone(archived.settings);
      p.bindings = structuredClone(archived.bindings);
      p.loadout = structuredClone(archived.loadout);
      p.entitlements = structuredClone(archived.entitlements);
      p.stats = structuredClone(archived.stats);
      p.inventory = structuredClone(archived.inventory);
      p.economy = structuredClone(archived.economy);
      p.economy.scrap = Math.min(archived.economy.scrap, MAX_SCRAP_BALANCE);
      if (p._unknown !== undefined) {
        delete p._unknown.mergedInto;
        delete p._unknown.mergedEventId;
        delete p._unknown.mergedMs;
      }
      if (deps.journal !== null) {
        await deps.journal.append([{
          id: newLedgerId(now + 1), ms: now, kind: 'merge.credit', sourceId: undoSource,
          playerId: applied.fromDeviceId, currency: 'scrap',
          delta: p.economy.scrap, balanceAfter: p.economy.scrap, actor, reason,
        }]);
      }
    });

    await deps.graph.detachDeviceHoldingLock(applied.intoAccountId, applied.fromDeviceId);

    appendMergeLog(deps.dataRoot, {
      ...applied, state: 'undone', actor, reason, ms: now,
      note: clawed < moved ? `shortfall ${moved - clawed} — the account had spent it` : '',
    });
    return { ok: true as const, restoredScrap: moved, shortfall: moved - clawed };
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
