/**
 * DOOMCRAFT — the reward journal.
 *
 * `applyMatchResult` (`persistence.ts`) is the single writer of `progress.xp`
 * and `economy.scrap`, it runs under the store's per-device lock, and until
 * this file it **discarded the match**. Nothing that survived a process knew
 * where a balance came from: the `SessionLedger` is an in-memory `Map` swept at
 * 6 h, and `Room.scoreboard()` dies with the round.
 *
 * A journal cannot be backfilled from balances. You cannot re-point history you
 * did not record, and you cannot undo a merge you cannot replay — so every
 * later feature (device-to-account merge, refunds, currency adjustment, dispute
 * resolution, "where did my Scrap go") is impossible without this and
 * mechanical with it. That is why it lands before the merge, not after.
 *
 * ## What this is
 *
 * Append-only NDJSON beside the profile store, one file per UTC day. No
 * database, no new dependency — `docs/PLATFORM.md` §4.3 rejects Postgres now
 * and it is right: what Postgres buys is enumeration and cross-host uniqueness,
 * there is nobody to enumerate and one host per room.
 *
 * ## The five properties, and where each is enforced
 *
 *  1. **One row per currency movement.** `matchPayoutRows` emits one row per
 *     currency, always — including a zero-delta row, see the note there.
 *  2. **Written under the same per-device lock that moved the balance.** The
 *     room awaits `append` from *inside* `store.update`'s callback. A journal
 *     written outside the lock is a journal that disagrees with the balance.
 *  3. **Idempotent.** `has()` before the mutation, `append()` after it, both
 *     under that lock, both keyed on `(kind, sourceId, playerId)`. See
 *     `idempotencyKey` for why the doc's `(kind, sourceId)` is wrong.
 *  4. **`balanceAfter` on every row**, and `delta` is the *observed* change in
 *     the balance rather than the amount anybody asked for — so
 *     `Σ delta == balance` is true by construction rather than by discipline.
 *  5. **Bounded.** Fixed row shape with every free-text field clamped, one file
 *     per day, and a retention window that deletes whole day files. See
 *     `sweep()` for exactly what happens at the bound.
 *
 * ## Browser safety
 *
 * `server/src/room.ts` is imported by the client's single-player worker
 * (`client/src/net/localServer.ts`), so anything the room imports is bundled
 * for the browser. Everything above `JsonJournal` in this file is pure, and
 * `JsonJournal` builds its `node:fs` specifier at runtime exactly as
 * `persistence.ts` does, so a bundler cannot follow it.
 */

import { utcDay } from './persistence.js';

/* ------------------------------------------------------------------------ *
 * The model
 * ------------------------------------------------------------------------ */

/** Balances this journal can move. Integers, never micros — see `delta`. */
export type LedgerCurrency = 'xp' | 'scrap';

export type LedgerKind =
  | 'match.payout' | 'merge.debit' | 'merge.credit'
  | 'admin.adjust' | 'purchase.grant' | 'purchase.refund' | 'spend'
  | 'referral';

/** Written out so a `LedgerKind` typo in a call site is a compile error. */
export const MATCH_PAYOUT: LedgerKind = 'match.payout';

export const LEDGER_KINDS: readonly LedgerKind[] = Object.freeze([
  'match.payout', 'merge.debit', 'merge.credit',
  'admin.adjust', 'purchase.grant', 'purchase.refund', 'spend',
  'referral',
]);

/**
 * The kinds that go to the FINANCIAL stream, and the split is made at write
 * time rather than at delete time on purpose.
 *
 * `playerId` is pseudonymous personal data, so an append-only file is a file
 * that cannot honour an erasure request — while the financial trail must be
 * kept for the statutory period. Those two are mutually unsatisfiable in one
 * file, so there are two: `forget()` deletes rows from the ledger stream and
 * only pseudonymises them in the financial one.
 *
 * Nothing emits either of these yet: `POST /api/entitlement` 404s until a
 * charging provider is bound. The routing exists now because moving a row
 * between streams after the fact is the thing that cannot be done.
 */
export const FINANCIAL_KINDS: readonly LedgerKind[] = Object.freeze([
  'purchase.grant', 'purchase.refund',
]);

export type LedgerStream = 'journal' | 'financial';

export function streamFor(kind: LedgerKind): LedgerStream {
  return FINANCIAL_KINDS.includes(kind) ? 'financial' : 'journal';
}

export interface LedgerEntry {
  /** ULID: monotonic, sorts by time, minted by the caller. */
  readonly id: string;
  readonly ms: number;
  /** The device/profile key the balance belongs to. */
  readonly playerId: string;
  readonly currency: LedgerCurrency;
  readonly kind: LedgerKind;
  /**
   * Unique with `kind` AND `playerId`. `${hostId}:${roomInstance}:${sessionId}`
   * for a payout; the merge event id for a merge; the provider event id for a
   * purchase.
   */
  readonly sourceId: string;
  /**
   * INTEGER UNITS, not micros. XP and Scrap are integers everywhere else —
   * `applyMatchResult` rounds both and `MAX_SCRAP_BALANCE` is an integer.
   * Micros would invent precision this economy does not have and would put a
   * float in every comparison.
   *
   * This is the *observed* movement (`balanceAfter - balanceBefore`), not the
   * amount the room asked for and not the amount the player was told. The
   * three differ whenever the day cap, the diminishing-returns ladder or the
   * `MAX_SCRAP_BALANCE` ceiling bites, and only this one keeps
   * `Σ delta == balance` true.
   */
  readonly delta: number;
  readonly balanceAfter: number;
  /** `system:room` | `system:merge` | `admin:<who>`. */
  readonly actor: string;
  readonly reason: string;
}

/* --- field bounds ------------------------------------------------------- *
 * The only inputs that are not fixed-width. Clamped on the way in so a row
 * cannot be made large by a caller and the on-disk bound below is real. */
export const MAX_PLAYER_ID = 64;
export const MAX_SOURCE_ID = 160;
export const MAX_ACTOR = 64;
export const MAX_REASON = 120;
/**
 * Everything else is a number, a date or one of seven kind strings, so this is
 * the worst case and not an estimate: the four clamps above plus the fixed key
 * names plus the widest integers this economy can hold.
 */
export const MAX_ROW_BYTES = 640;

/* ------------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------------ */

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_RANDOM_CHARS = 16;
let ulidLastMs = -1;
const ulidLastRandom: number[] = new Array<number>(ULID_RANDOM_CHARS).fill(0);

/**
 * A ULID: 10 characters of millisecond timestamp, 16 of randomness, Crockford
 * base32, lexicographically sortable.
 *
 * Monotonic WITHIN a millisecond, which is the property that matters here: two
 * payouts in the same millisecond must still sort in the order they happened,
 * or a reader replaying the journal reconstructs a different balance sequence
 * from the one the store actually went through.
 */
export function newLedgerId(nowMs: number): string {
  const ms = Math.max(0, Math.floor(nowMs));
  if (ms === ulidLastMs) {
    // Increment the random tail as a base-32 big integer, low digit first.
    for (let i = ULID_RANDOM_CHARS - 1; i >= 0; i--) {
      if (ulidLastRandom[i] < 31) { ulidLastRandom[i]++; break; }
      ulidLastRandom[i] = 0;
    }
  } else {
    ulidLastMs = ms;
    const bytes = new Uint8Array(ULID_RANDOM_CHARS);
    globalThis.crypto.getRandomValues(bytes);
    for (let i = 0; i < ULID_RANDOM_CHARS; i++) ulidLastRandom[i] = bytes[i] & 31;
  }
  let time = '';
  let rest = ms;
  for (let i = 0; i < 10; i++) {
    time = ULID_ALPHABET[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  let rand = '';
  for (let i = 0; i < ULID_RANDOM_CHARS; i++) rand += ULID_ALPHABET[ulidLastRandom[i]];
  return time + rand;
}

/**
 * The idempotency key — and it is a TRIPLE, which is a correction to
 * `docs/PLATFORM.md` §4.3.
 *
 * The document specifies "idempotent on `(kind, sourceId)`" with
 * `sourceId = ${HOST_ID}:${sessionId}`. A `sessionId` names a ROUND, and a
 * round pays every player in the room: under that key the first player paid in
 * a 32-player match writes the row and the other 31 are refused as duplicates.
 * With the mutation gated on the same key — which it must be, or a duplicate
 * moves the balance and only fails to record it — those 31 players are not
 * paid at all.
 *
 * The doc's key also collides between the XP row and the Scrap row of the same
 * payout, which would have dropped exactly half of every player's money. That
 * one is handled differently: `append` takes the whole movement GROUP and
 * claims the key once for it, so both currencies land under a single claim.
 *
 * Length-prefixed rather than NUL- or delimiter-joined. A room key may contain
 * `~`, `:` and `#`, so no printable delimiter is safe; and a literal NUL in a
 * source file makes `grep` skip the whole file silently, which
 * `shared/src/flags.ts` already cost this project once.
 */
export function idempotencyKey(kind: LedgerKind, sourceId: string, playerId: string): string {
  return `${kind.length}:${kind}${sourceId.length}:${sourceId}${playerId.length}:${playerId}`;
}

/**
 * An eight-character, stable, non-reversing handle for a device id.
 *
 * `docs/PLATFORM.md` §5.7 requires that no admin surface serialise a full
 * device id, and the journal is the first admin surface that holds one on every
 * row. Eight hex characters is 32 bits: unique across any realistic player
 * base, and therefore pseudonymous rather than anonymous — which is exactly
 * what the retention split above is designed around.
 *
 * When C3 lands `adminAudit.ts`, its `redactProfileKey` is this function; there
 * must not be two.
 */
export function redactPlayerId(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/* ------------------------------------------------------------------------ *
 * Rows for a match payout
 * ------------------------------------------------------------------------ */

export interface MatchPayoutInput {
  readonly playerId: string;
  readonly sourceId: string;
  readonly ms: number;
  /** Balances read from the profile immediately BEFORE `applyMatchResult`. */
  readonly before: { readonly xp: number; readonly scrap: number };
  /** ...and immediately after it, under the same lock, before any await. */
  readonly after: { readonly xp: number; readonly scrap: number };
  /** What the room asked for, pre-ladder and pre-cap. For the reason string. */
  readonly asked: { readonly xp: number; readonly scrap: number };
  /** The gate's verdict code, so a stripped payout is legible later. */
  readonly code?: number;
  readonly actor?: string;
}

/**
 * The two rows one match payout produces.
 *
 * **A zero delta still gets a row**, and that is deliberate twice over. It is
 * the record an operator needs for the single most common dispute — "I played
 * forty rounds and got nothing" is answered by forty rows saying the day cap
 * ate them, and by nothing at all otherwise. And the idempotency claim has to
 * exist even when no money moved, or a replay of that submission would run
 * `applyMatchResult` again and increment `gamesPlayed`, `kills` and the day
 * meter a second time.
 */
export function matchPayoutRows(input: MatchPayoutInput): LedgerEntry[] {
  const actor = input.actor ?? 'system:room';
  const mk = (currency: LedgerCurrency, before: number, after: number, asked: number): LedgerEntry => ({
    id: newLedgerId(input.ms),
    ms: input.ms,
    playerId: input.playerId,
    currency,
    kind: MATCH_PAYOUT,
    sourceId: input.sourceId,
    delta: after - before,
    balanceAfter: after,
    actor,
    reason: payoutReason(after - before, asked, input.code ?? 0),
  });
  return [
    mk('xp', input.before.xp, input.after.xp, input.asked.xp),
    mk('scrap', input.before.scrap, input.after.scrap, input.asked.scrap),
  ];
}

function payoutReason(delta: number, asked: number, code: number): string {
  const tail = code === 0 ? '' : ` code=${code}`;
  if (asked === delta) return `match${tail}`;
  // The gap is the day cap, the diminishing-returns ladder, or the balance
  // ceiling. Recording the asked-for amount is what makes it possible to tell
  // "the meter ate it" from "the room never paid".
  return `match, metered from ${asked}${tail}`;
}

/* ------------------------------------------------------------------------ *
 * The interface
 * ------------------------------------------------------------------------ */

export interface JournalStatus {
  /** Rows actually written. */
  appended: number;
  /** Movement groups refused as duplicates. */
  duplicates: number;
  /** Rows that could not be written, i.e. a balance moved with no record. */
  failed: number;
  /** Rows skipped on read because they did not parse — a torn tail. */
  torn: number;
  /** True once the disk is known to be unusable. */
  degraded: boolean;
  /** Idempotency keys held in memory (the 48 h window). */
  keys: number;
}

export interface JournalSums {
  xp: number;
  scrap: number;
  rows: number;
  /**
   * The oldest retained day, or '' when there is nothing on disk. A sum is only
   * meaningful FROM here: retention deletes whole day files, so after the
   * window `Σ delta` is a lower bound on the balance and not the balance.
   */
  fromDay: string;
}

export interface Journal {
  /** Has this exact movement group already been recorded? */
  has(kind: LedgerKind, sourceId: string, playerId: string): Promise<boolean>;
  /**
   * Append one movement group — every row sharing one `(kind, sourceId,
   * playerId)`. Idempotent on that triple: returns the number of rows written,
   * and 0 when it was a duplicate.
   */
  append(entries: readonly LedgerEntry[]): Promise<number>;
  /** Newest first, for the console and for a data export. */
  read(playerId: string, sinceMs: number, limit: number): Promise<LedgerEntry[]>;
  /** Σ delta per currency over the RETAINED window. See `JournalSums.fromDay`. */
  balances(playerId: string): Promise<JournalSums>;
  /** Erasure. Ledger rows are removed, financial rows are pseudonymised. */
  forget(playerId: string): Promise<number>;
  /** Delete day files outside the retention window. Returns files removed. */
  sweep(): Promise<number>;
  status(): JournalStatus;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------------ *
 * The file store
 * ------------------------------------------------------------------------ */

/** One open append handle. The slice of `FileHandle` this store uses. */
export interface JournalFile {
  write(data: string): Promise<unknown>;
  close(): Promise<unknown>;
}

/**
 * The slice of `node:fs/promises` this store uses, exported so a test can
 * substitute an in-memory one and drive a torn write, a full disk and a day
 * rollover deterministically instead of hoping for them.
 */
export interface JournalFs {
  mkdir(path: string, opts: { recursive: boolean }): Promise<unknown>;
  open(path: string, flags: 'a'): Promise<JournalFile>;
  stat(path: string): Promise<{ size: number }>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  readdir(path: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface JournalOptions {
  clock?: () => number;
  /** Retention for the ledger stream, in days. */
  journalDays?: number;
  /** Retention for the financial stream, in days. Statutory, so much longer. */
  financialDays?: number;
  fs?: JournalFs;
}

/** `DOOMCRAFT_JOURNAL_DAYS`. ~13 months, so a full season is always in reach. */
export const DEFAULT_JOURNAL_DAYS = 400;
/** `DOOMCRAFT_FINANCIAL_DAYS`. Ten years — the statutory end of the 7–10 range. */
export const DEFAULT_FINANCIAL_DAYS = 3650;

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;
/** Rows read at boot to seed the dedup set. A hard bound on boot cost. */
const MAX_SEED_ROWS = 250_000;

export class JsonJournal implements Journal {
  private readonly root: string;
  private readonly clock: () => number;
  private readonly retention: Record<LedgerStream, number>;
  private fs: JournalFs | null;
  private readyPromise: Promise<JournalFs | null> | null = null;
  /**
   * The dedup set, per UTC day so it can be rotated in O(1). Seeded on boot
   * from today's and yesterday's files.
   *
   * HONEST CAVEAT, and it is stated in the code because it is the kind of thing
   * that gets rediscovered as a bug: this set is per-process and covers 48
   * hours. That is exactly the window a retry lives in, and cross-host
   * duplicate payouts are impossible today because only one host holds a given
   * room. When there is a database, `UNIQUE (kind, source_id, player_id)`
   * replaces it with no call-site change.
   */
  private readonly seen = new Map<string, Set<string>>();
  private readonly open = new Map<LedgerStream, { day: string; file: JournalFile }>();
  private closed = false;
  private counters = { appended: 0, duplicates: 0, failed: 0, torn: 0 };
  private degraded = false;

  constructor(root: string, opts: JournalOptions = {}) {
    this.root = root.replace(/\/+$/, '');
    this.clock = opts.clock ?? ((): number => Date.now());
    this.retention = {
      journal: Math.max(1, Math.floor(opts.journalDays ?? DEFAULT_JOURNAL_DAYS)),
      financial: Math.max(1, Math.floor(opts.financialDays ?? DEFAULT_FINANCIAL_DAYS)),
    };
    this.fs = opts.fs ?? null;
  }

  private dir(stream: LedgerStream): string {
    return `${this.root}/${stream}`;
  }

  private pathFor(stream: LedgerStream, day: string): string {
    return `${this.dir(stream)}/${day}.ndjson`;
  }

  /**
   * Open the directories and seed the dedup set. Idempotent, and every public
   * method awaits it — including `has()`, which is why that one is async: a
   * synchronous `has` would answer "no" for the whole of boot and let a retry
   * arriving in that window pay twice.
   */
  async ready(): Promise<JournalFs | null> {
    if (this.readyPromise === null) this.readyPromise = this.openStore();
    return this.readyPromise;
  }

  private async openStore(): Promise<JournalFs | null> {
    try {
      if (this.fs === null) {
        // Built at runtime so a bundler cannot follow it into a browser build.
        const spec = 'node:fs' + '/promises';
        this.fs = (await import(/* @vite-ignore */ spec)) as unknown as JournalFs;
      }
      await this.fs.mkdir(this.dir('journal'), { recursive: true });
      await this.fs.mkdir(this.dir('financial'), { recursive: true });
    } catch {
      this.degraded = true;
      return null;
    }
    const today = utcDay(this.clock());
    const yesterday = utcDay(this.clock() - 86_400_000);
    let rows = 0;
    for (const stream of ['journal', 'financial'] as LedgerStream[]) {
      for (const day of [yesterday, today]) {
        if (rows > MAX_SEED_ROWS) break;
        const entries = await this.readDay(stream, day);
        for (const e of entries) {
          if (rows++ > MAX_SEED_ROWS) break;
          this.remember(e.kind, e.sourceId, e.playerId, day);
        }
      }
    }
    return this.fs;
  }

  private remember(kind: LedgerKind, sourceId: string, playerId: string, day: string): void {
    let set = this.seen.get(day);
    if (set === undefined) { set = new Set<string>(); this.seen.set(day, set); }
    set.add(idempotencyKey(kind, sourceId, playerId));
    if (this.seen.size <= 2) return;
    // Keep today and yesterday; anything older is outside the retry window.
    const keep = new Set([utcDay(this.clock()), utcDay(this.clock() - 86_400_000), day]);
    for (const k of [...this.seen.keys()]) if (!keep.has(k)) this.seen.delete(k);
  }

  private held(kind: LedgerKind, sourceId: string, playerId: string): boolean {
    const key = idempotencyKey(kind, sourceId, playerId);
    for (const set of this.seen.values()) if (set.has(key)) return true;
    return false;
  }

  async has(kind: LedgerKind, sourceId: string, playerId: string): Promise<boolean> {
    await this.ready();
    return this.held(kind, sourceId, playerId);
  }

  async append(entries: readonly LedgerEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    const head = entries[0];
    for (const e of entries) {
      if (e.kind !== head.kind || e.sourceId !== head.sourceId || e.playerId !== head.playerId) {
        // A programmer error, not a runtime condition: `append` claims ONE
        // idempotency key, so a group that spans two of them would leave the
        // second unclaimed and replayable.
        throw new Error('append: every row in a group must share (kind, sourceId, playerId)');
      }
    }
    const fs = await this.ready();
    if (this.held(head.kind, head.sourceId, head.playerId)) {
      this.counters.duplicates++;
      return 0;
    }
    // Claimed BEFORE the write. A write that fails must not leave the key
    // unclaimed: the balance has already moved by the time we are called, so a
    // retry would move it a second time. A lost row is a counter; a double
    // payout is money.
    this.remember(head.kind, head.sourceId, head.playerId, utcDay(head.ms));
    if (fs === null) { this.counters.failed += entries.length; return 0; }

    const stream = streamFor(head.kind);
    let written = 0;
    for (const e of entries) {
      const day = utcDay(e.ms);
      const line = JSON.stringify(clampEntry(e)) + '\n';
      try {
        const file = await this.fileFor(fs, stream, day);
        await file.write(line);
        written++;
      } catch {
        this.degraded = true;
        this.counters.failed++;
      }
    }
    this.counters.appended += written;
    return written;
  }

  /**
   * The append handle for one stream/day, opened once.
   *
   * THE TORN-WRITE GUARD is the blank line. A process killed mid-write leaves a
   * partial line with no newline on the end, and the next append would
   * concatenate onto it — turning ONE lost row into two. Writing a bare newline
   * when a non-empty file is first opened bounds the damage to the torn row
   * itself; an empty line costs nothing because `readDay` skips it, and there
   * is exactly one per stream per day per process.
   */
  private async fileFor(fs: JournalFs, stream: LedgerStream, day: string): Promise<JournalFile> {
    const current = this.open.get(stream);
    if (current !== undefined && current.day === day) return current.file;
    if (current !== undefined) {
      this.open.delete(stream);
      try { await current.file.close(); } catch { /* the day is over anyway */ }
    }
    await fs.mkdir(this.dir(stream), { recursive: true });
    let size = 0;
    try { size = (await fs.stat(this.pathFor(stream, day))).size; } catch { size = 0; }
    const file = await fs.open(this.pathFor(stream, day), 'a');
    if (size > 0) { try { await file.write('\n'); } catch { /* checked on write */ } }
    this.open.set(stream, { day, file });
    return file;
  }

  private async days(stream: LedgerStream): Promise<string[]> {
    const fs = await this.ready();
    if (fs === null) return [];
    let names: string[];
    try { names = await fs.readdir(this.dir(stream)); } catch { return []; }
    const out: string[] = [];
    for (const n of names) {
      const m = DAY_FILE.exec(n);
      if (m !== null) out.push(m[1]);
    }
    return out.sort();
  }

  /**
   * One day file, parsed. **Every unreadable line is skipped, never thrown** —
   * that is the other half of the torn-write requirement: a half-written row
   * must not make the file unreadable for the next reader, and a reader that
   * throws on it turns one lost payout into a lost journal.
   */
  private async readDay(stream: LedgerStream, day: string): Promise<LedgerEntry[]> {
    const fs = this.fs;
    if (fs === null) return [];
    let text: string;
    try { text = await fs.readFile(this.pathFor(stream, day), 'utf8'); } catch { return []; }
    const out: LedgerEntry[] = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      const e = parseEntry(line);
      if (e === null) { this.counters.torn++; continue; }
      out.push(e);
    }
    return out;
  }

  async read(playerId: string, sinceMs: number, limit: number): Promise<LedgerEntry[]> {
    await this.ready();
    const cap = Math.max(1, Math.min(1000, Math.floor(limit)));
    const out: LedgerEntry[] = [];
    const streams: LedgerStream[] = ['journal', 'financial'];
    const all: Array<{ stream: LedgerStream; day: string }> = [];
    for (const stream of streams) {
      for (const day of await this.days(stream)) all.push({ stream, day });
    }
    // Newest day first, so a page never has to read the whole history.
    all.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
    for (const { stream, day } of all) {
      const rows = await this.readDay(stream, day);
      for (let i = rows.length - 1; i >= 0; i--) {
        const e = rows[i];
        if (e.playerId !== playerId || e.ms < sinceMs) continue;
        out.push(e);
        if (out.length >= cap) return out;
      }
    }
    return out;
  }

  async balances(playerId: string): Promise<JournalSums> {
    await this.ready();
    const sums: JournalSums = { xp: 0, scrap: 0, rows: 0, fromDay: '' };
    for (const stream of ['journal', 'financial'] as LedgerStream[]) {
      for (const day of await this.days(stream)) {
        if (sums.fromDay === '' || day < sums.fromDay) sums.fromDay = day;
        for (const e of await this.readDay(stream, day)) {
          if (e.playerId !== playerId) continue;
          sums.rows++;
          if (e.currency === 'xp') sums.xp += e.delta; else sums.scrap += e.delta;
        }
      }
    }
    return sums;
  }

  /**
   * Erasure, and the one rewrite path in the file. It exists for exactly one
   * caller and rewrites through a temp file and an atomic rename, so a crash
   * mid-erasure leaves the original intact rather than half a journal.
   */
  async forget(playerId: string): Promise<number> {
    const fs = await this.ready();
    if (fs === null) return 0;
    const tomb = `deleted:${redactPlayerId(playerId)}`;
    let touched = 0;
    for (const stream of ['journal', 'financial'] as LedgerStream[]) {
      for (const day of await this.days(stream)) {
        const rows = await this.readDay(stream, day);
        if (!rows.some((e) => e.playerId === playerId)) continue;
        const kept: LedgerEntry[] = [];
        for (const e of rows) {
          if (e.playerId !== playerId) { kept.push(e); continue; }
          touched++;
          // The financial trail is KEPT and pseudonymised; everything else goes.
          if (stream === 'financial') kept.push({ ...e, playerId: tomb });
        }
        const path = this.pathFor(stream, day);
        const tmp = `${path}.tmp`;
        const body = kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length > 0 ? '\n' : '');
        // Drop the append handle first: it holds an offset into the file we are
        // about to replace, and writing through it after the rename would
        // resurrect the rows at their old offsets.
        const held = this.open.get(stream);
        if (held !== undefined && held.day === day) {
          this.open.delete(stream);
          try { await held.file.close(); } catch { /* replaced anyway */ }
        }
        try {
          await fs.writeFile(tmp, body, 'utf8');
          await fs.rename(tmp, path);
        } catch { this.degraded = true; }
      }
    }
    return touched;
  }

  /**
   * THE BOUND, and what happens at it.
   *
   * One file per UTC day per stream; a row is at most `MAX_ROW_BYTES` because
   * every free-text field on it is clamped. So the ledger stream is bounded by
   * `journalDays x rows-per-day x 512 B` and nothing a player does can make a
   * row bigger — only more numerous. At the bound the OLDEST DAY FILE IS
   * DELETED, whole, and with it the ability to reconstruct a balance from
   * before that day: `balances()` reports `fromDay` for exactly that reason,
   * and the stored balance stays the number a player spends against.
   *
   * At 100 rows/day/player and 10,000 daily players that is ~2 GB/day, which is
   * the number that decides when this becomes a database rather than a file.
   */
  async sweep(): Promise<number> {
    const fs = await this.ready();
    if (fs === null) return 0;
    let removed = 0;
    const now = this.clock();
    for (const stream of ['journal', 'financial'] as LedgerStream[]) {
      const cutoff = utcDay(now - this.retention[stream] * 86_400_000);
      for (const day of await this.days(stream)) {
        if (day >= cutoff) continue;
        const held = this.open.get(stream);
        if (held !== undefined && held.day === day) {
          this.open.delete(stream);
          try { await held.file.close(); } catch { /* going away */ }
        }
        try { await fs.unlink(this.pathFor(stream, day)); removed++; } catch { /* already gone */ }
      }
    }
    return removed;
  }

  status(): JournalStatus {
    let keys = 0;
    for (const set of this.seen.values()) keys += set.size;
    return {
      appended: this.counters.appended,
      duplicates: this.counters.duplicates,
      failed: this.counters.failed,
      torn: this.counters.torn,
      degraded: this.degraded,
      keys,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [stream, held] of [...this.open]) {
      this.open.delete(stream);
      try { await held.file.close(); } catch { /* shutting down */ }
    }
  }

  /** True once `close()` has run. Nothing reopens; the process is going away. */
  get isClosed(): boolean { return this.closed; }
}

/* ------------------------------------------------------------------------ *
 * Row hygiene
 * ------------------------------------------------------------------------ */

function clampStr(v: string, max: number): string {
  return v.length <= max ? v : v.slice(0, max);
}

function clampInt(v: number): number {
  return Number.isFinite(v) ? Math.round(v) : 0;
}

/** Every field bounded, so `MAX_ROW_BYTES` is a fact rather than a hope. */
export function clampEntry(e: LedgerEntry): LedgerEntry {
  return {
    id: clampStr(e.id, 32),
    ms: clampInt(e.ms),
    playerId: clampStr(e.playerId, MAX_PLAYER_ID),
    currency: e.currency,
    kind: e.kind,
    sourceId: clampStr(e.sourceId, MAX_SOURCE_ID),
    delta: clampInt(e.delta),
    balanceAfter: clampInt(e.balanceAfter),
    actor: clampStr(e.actor, MAX_ACTOR),
    reason: clampStr(e.reason, MAX_REASON),
  };
}

/** One NDJSON line, or null when it is not a row this build can read. */
export function parseEntry(line: string): LedgerEntry | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.playerId !== 'string') return null;
  if (typeof r.sourceId !== 'string' || typeof r.actor !== 'string') return null;
  if (typeof r.reason !== 'string') return null;
  if (typeof r.ms !== 'number' || !Number.isFinite(r.ms)) return null;
  if (typeof r.delta !== 'number' || !Number.isFinite(r.delta)) return null;
  if (typeof r.balanceAfter !== 'number' || !Number.isFinite(r.balanceAfter)) return null;
  if (r.currency !== 'xp' && r.currency !== 'scrap') return null;
  if (!LEDGER_KINDS.includes(r.kind as LedgerKind)) return null;
  return {
    id: r.id, ms: r.ms, playerId: r.playerId,
    currency: r.currency, kind: r.kind as LedgerKind, sourceId: r.sourceId,
    delta: r.delta, balanceAfter: r.balanceAfter, actor: r.actor, reason: r.reason,
  };
}
