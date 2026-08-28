/**
 * DOOMCRAFT — viral tier 1: referral codes, engagement conversion, and the
 * fraud controls that ship WITH the feature (docs/ECONOMY.md "Viral
 * sharing"; the 2026-08-22 handover §3.8, verbatim rules).
 *
 * The three rules everything hangs on:
 *
 *  1. **Attribution is first-wins, forever.** One referrer per player,
 *     recorded server-side at claim; a second claim changes nothing.
 *  2. **Conversion = engagement, never signup.** The referred player must
 *     reach a threshold the SERVER measured itself — 30 minutes of paid
 *     play (`stats.secondsPlayed`, which only match payouts move) or level
 *     5 — before either side is paid. Rewarding signups is what turns a
 *     referral system into a bot farm.
 *  3. **The journal is the payment.** Both rewards land as `kind:
 *     'referral'` rows with `sourceId: referral:<referredKey>` — idempotent
 *     on the referred player forever, so a conversion can never pay twice,
 *     whatever crashes or replays.
 *
 * Fraud controls, in the door not bolted on: per-referrer day cap (over it
 * the conversion PARKS in a review queue instead of paying), self-referral
 * refused at claim, same-/24 claims flagged for review, and a player who is
 * already past the threshold cannot be "recruited" at all — attribution is
 * for new players, not a coupon for veterans.
 */

import { readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { randomCrockford } from './credentials.js';
import { newLedgerId, type Journal } from './journal.js';
import { MAX_SCRAP_BALANCE, type PersistenceStore, type StoredProfile } from './persistence.js';

export const REFERRALS_FILE = 'referrals.json';
export const REFERRER_SCRAP = 100;
export const REFERRED_SCRAP = 50;
export const REFERRAL_CONVERSIONS_PER_DAY = 5;
export const CONVERT_SECONDS_PLAYED = 30 * 60;
export const CONVERT_LEVEL = 5;

export interface Attribution {
  code: string;
  referrerKey: string;
  ms: number;
  /** 0 until converted (paid); -1 while parked in the review queue. */
  convertedMs: number;
  /** Set at claim when the fraud heuristics want a human decision. */
  review: string;
}

interface ReferralDoc {
  version: 1;
  /** code -> { key, addr, ms } — who owns it, minted from where. */
  codes: Record<string, { key: string; addr: string; ms: number }>;
  byKey: Record<string, string>;
  /** referredKey -> attribution. First wins, forever. */
  attributions: Record<string, Attribution>;
  /** referrerKey -> UTC day rollup, for the cap. */
  days: Record<string, { day: string; conversions: number }>;
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; reason: 'unknown-code' | 'self-referral' | 'already-attributed' | 'too-late' };

export interface ReferralDeps {
  store: PersistenceStore;
  journal: Journal | null;
}

function utcDayOf(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function block24(addr: string): string { return addr.split('.').slice(0, 3).join('.'); }

/** §3.1-style countable-for-referrals: past either threshold already. */
export function pastThreshold(p: StoredProfile): boolean {
  return p.stats.secondsPlayed >= CONVERT_SECONDS_PLAYED || p.progress.level >= CONVERT_LEVEL;
}

export class ReferralService {
  private readonly root: string;
  private readonly clock: () => number;
  private doc: ReferralDoc = { version: 1, codes: {}, byKey: {}, attributions: {}, days: {} };
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dataRoot: string, options: { clock?: () => number } = {}) {
    this.root = dataRoot.replace(/\/+$/, '');
    this.clock = options.clock ?? (() => Date.now());
    try {
      const raw = JSON.parse(readFileSync(join(this.root, REFERRALS_FILE), 'utf8')) as ReferralDoc;
      if (raw.version === 1) this.doc = { ...this.doc, ...raw };
    } catch { /* first boot */ }
  }

  /** Serialise every mutation; referral traffic is rare, one lock is fine. */
  private locked<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private persist(): void {
    try {
      mkdirSync(this.root, { recursive: true });
      const tmp = join(this.root, `${REFERRALS_FILE}.tmp`);
      writeFileSync(tmp, JSON.stringify(this.doc, null, 2), 'utf8');
      renameSync(tmp, join(this.root, REFERRALS_FILE));
    } catch { /* an unwritable doc must not break play */ }
  }

  /** Idempotent: one code per profile key, minted on first ask. */
  codeFor(profileKey: string, addr: string): Promise<string> {
    return this.locked(() => {
      const existing = this.doc.byKey[profileKey];
      if (existing !== undefined) return existing;
      let code = '';
      do { code = `RF${randomCrockford(6)}`; } while (this.doc.codes[code] !== undefined);
      this.doc.codes[code] = { key: profileKey, addr, ms: this.clock() };
      this.doc.byKey[profileKey] = code;
      this.persist();
      return code;
    });
  }

  attributionOf(referredKey: string): Attribution | null {
    return this.doc.attributions[referredKey] ?? null;
  }

  conversionsFor(referrerKey: string): number {
    let n = 0;
    for (const a of Object.values(this.doc.attributions)) {
      if (a.referrerKey === referrerKey && a.convertedMs > 0) n++;
    }
    return n;
  }

  /**
   * `?ref=` lands here. First wins forever; a veteran cannot be recruited;
   * nobody recruits themselves. A same-/24 claim is ACCEPTED but marked for
   * review — the conversion will park instead of paying.
   */
  claim(referredKey: string, code: string, addr: string, deps: ReferralDeps): Promise<ClaimResult> {
    return this.locked(async () => {
      const owner = this.doc.codes[code];
      if (owner === undefined) return { ok: false as const, reason: 'unknown-code' as const };
      if (owner.key === referredKey) return { ok: false as const, reason: 'self-referral' as const };
      if (this.doc.attributions[referredKey] !== undefined) return { ok: false as const, reason: 'already-attributed' as const };
      const profile = await deps.store.load(referredKey);
      if (profile !== null && pastThreshold(profile)) return { ok: false as const, reason: 'too-late' as const };
      const review = addr !== '' && owner.addr !== '' && block24(addr) === block24(owner.addr)
        ? `claimed from the code's own /24 (${block24(addr)}.x)` : '';
      this.doc.attributions[referredKey] = {
        code, referrerKey: owner.key, ms: this.clock(), convertedMs: 0, review,
      };
      this.persist();
      return { ok: true as const };
    });
  }

  /**
   * Called after every paying round for the profile that banked it. Cheap
   * when there is nothing to do; pays through the journal when the referred
   * player has newly crossed the threshold.
   */
  sweep(referredKey: string, deps: ReferralDeps): Promise<'none' | 'paid' | 'queued'> {
    return this.locked(async () => {
      const a = this.doc.attributions[referredKey];
      if (a === undefined || a.convertedMs !== 0) return 'none' as const;
      const profile = await deps.store.load(referredKey);
      if (profile === null || !pastThreshold(profile)) return 'none' as const;

      const now = this.clock();
      const day = utcDayOf(now);
      const tally = this.doc.days[a.referrerKey] ?? { day, conversions: 0 };
      if (tally.day !== day) { tally.day = day; tally.conversions = 0; }

      if (a.review !== '' || tally.conversions >= REFERRAL_CONVERSIONS_PER_DAY) {
        // Parked, not paid: the cap and the queue are part of tier 1.
        a.convertedMs = -1;
        if (a.review === '') a.review = `over the ${REFERRAL_CONVERSIONS_PER_DAY}/day cap`;
        this.persist();
        return 'queued' as const;
      }

      await this.pay(a, referredKey, deps, now);
      tally.conversions += 1;
      this.doc.days[a.referrerKey] = tally;
      a.convertedMs = now;
      this.persist();
      return 'paid' as const;
    });
  }

  /** The operator's release valve: pay a parked conversion after review. */
  approve(referredKey: string, deps: ReferralDeps): Promise<boolean> {
    return this.locked(async () => {
      const a = this.doc.attributions[referredKey];
      if (a === undefined || a.convertedMs > 0) return false;
      await this.pay(a, referredKey, deps, this.clock());
      a.convertedMs = this.clock();
      a.review = '';
      this.persist();
      return true;
    });
  }

  /** For the console: the parked conversions a human owes a decision. */
  reviewQueue(): { referredKey: string; attribution: Attribution }[] {
    return Object.entries(this.doc.attributions)
      .filter(([, a]) => a.convertedMs === -1)
      .map(([referredKey, attribution]) => ({ referredKey, attribution }));
  }

  status(): Record<string, number> {
    const all = Object.values(this.doc.attributions);
    return {
      codes: Object.keys(this.doc.codes).length,
      attributed: all.length,
      converted: all.filter((a) => a.convertedMs > 0).length,
      queued: all.filter((a) => a.convertedMs === -1).length,
    };
  }

  /**
   * Both sides, through the journal, idempotent on the REFERRED player
   * forever: `sourceId = referral:<referredKey>` and the journal's
   * (kind, sourceId, playerId) key make a second payment structurally
   * impossible — the client never computes any of this.
   */
  private async pay(a: Attribution, referredKey: string, deps: ReferralDeps, now: number): Promise<void> {
    const sourceId = `referral:${referredKey}`;
    const sides: { key: string; amount: number; reason: string }[] = [
      { key: a.referrerKey, amount: REFERRER_SCRAP, reason: 'referral converted — recruiter reward' },
      { key: referredKey, amount: REFERRED_SCRAP, reason: 'referral converted — welcome reward' },
    ];
    for (const side of sides) {
      // Same shape as the match payout: the idempotency check FIRST and
      // inside the same update, the append LAST but still inside — the
      // journal reaches disk before the debounced profile save, so on a
      // crash the journal LEADS the balance, which is the recoverable
      // direction.
      await deps.store.update(side.key, async (p) => {
        if (deps.journal !== null && await deps.journal.has('referral', sourceId, side.key)) return;
        p.economy.scrap = Math.min(p.economy.scrap + side.amount, MAX_SCRAP_BALANCE);
        p.economy.lifetimeScrap = Math.min(p.economy.lifetimeScrap + side.amount, MAX_SCRAP_BALANCE);
        if (deps.journal !== null) {
          await deps.journal.append([{
            id: newLedgerId(now), ms: now, kind: 'referral', sourceId,
            playerId: side.key, currency: 'scrap',
            delta: side.amount, balanceAfter: p.economy.scrap,
            actor: 'system:referral', reason: side.reason,
          }]);
        }
      });
    }
  }
}
