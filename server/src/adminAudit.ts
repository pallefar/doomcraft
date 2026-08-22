/**
 * DOOMCRAFT — the admin action log.
 *
 * Append-only NDJSON at `<dataRoot>/audit/<YYYY-MM-DD>.ndjson`, beside the
 * reward journal and deliberately shaped like it: one row per operator action,
 * with `before` and `after` on the row, so `docs/PLATFORM.md` §5.8's claim that
 * "undo is the real reviewer" is a fact about the file rather than an aspiration.
 *
 * ## Why `reason` is a parameter and not a policy
 *
 * `docs/INFRASTRUCTURE.md:481-486`: under the DSA you owe a statement of
 * reasons for every moderation action, *"so the ban tool must emit a document,
 * not flip a boolean"*. A required field that 400s on absence is how that
 * becomes structural instead of being a line in a runbook. `MIN_REASON_CHARS`
 * is 10 for the same reason a commit message minimum is not 1: "fix" is not a
 * statement of reasons.
 *
 * **`actor` is NOT authentication.** One shared bearer admits the request; the
 * `actor` field is a label so the row reads, and it is what makes the log
 * useful the day there are two operators. When SSO lands it comes from the
 * session and the body field is refused. Say so in the UI, which the console
 * does.
 *
 * ## The retention conflict, resolved where it is created
 *
 * `subject` carries a redacted 8-character profile key — 32 bits, effectively
 * unique across any realistic player base, therefore **pseudonymous personal
 * data and not anonymised**. An append-only file cannot honour an erasure
 * request, and `docs/INFRASTRUCTURE.md:851` says moderation records are kept
 * (*"a ban that deletes itself is an exploit"*). So the split is made at the
 * point the row is written, not argued about later:
 *
 *   - a row whose `verb` starts with `player.` is a MODERATION record. Retained,
 *     exempt from erasure and from the retention sweep.
 *   - every other row is retained `DOOMCRAFT_AUDIT_DAYS` (default 400) and is
 *     reachable by `forget()`.
 *
 * That is why the sweep REWRITES an expired day file instead of unlinking it:
 * the day is the storage unit but it is not the retention unit, and a file
 * holding one ban may not be deleted because the flag writes next to it aged
 * out. A day with no moderation rows left is unlinked whole.
 *
 * ## What is reused rather than reinvented
 *
 * `newLedgerId` (ULID, monotonic inside one millisecond) and `redactPlayerId`
 * both come from `server/src/journal.ts`. `journal.ts` says in its own source
 * that when this file landed its `redactProfileKey` must BE that function and
 * there must not be two — an admin surface with two redactors is an admin
 * surface where one of them is wrong.
 */

import {
  newLedgerId,
  redactPlayerId,
  type JournalFile,
  type JournalFs,
} from './journal.js';

/* ------------------------------------------------------------------------ *
 * The row
 * ------------------------------------------------------------------------ */

export type AdminOutcome = 'applied' | 'refused' | 'rolled_back';

export interface AdminAction {
  /** ULID, monotonic, sorts by time. */
  readonly id: string;
  readonly ms: number;
  /** From the required body field. A label, not a credential. */
  readonly actor: string;
  /** `flags.set` | `flags.freeze` | `drain` | `player.ban` | … */
  readonly verb: string;
  /** A flag key, a host id, or `redactProfileKey(k)` — NEVER a full device id. */
  readonly subject: string;
  /** REQUIRED, >= `MIN_REASON_CHARS`, no default, never prefilled. */
  readonly reason: string;
  /** JSON, capped at `MAX_STATE_CHARS`. This is what makes undo one click. */
  readonly before: string;
  readonly after: string;
  readonly outcome: AdminOutcome;
  /** Correlates the row with the response the operator saw. */
  readonly requestId: string;
}

export const MIN_REASON_CHARS = 10;
export const MAX_REASON_CHARS = 300;
export const MIN_ACTOR_CHARS = 2;
export const MAX_ACTOR_CHARS = 64;
export const MAX_VERB_CHARS = 40;
export const MAX_SUBJECT_CHARS = 80;
/** `docs/PLATFORM.md` §5.7 says 2 KB, per side. */
export const MAX_STATE_CHARS = 2048;
export const DEFAULT_AUDIT_DAYS = 400;

const OUTCOMES: readonly AdminOutcome[] = Object.freeze(['applied', 'refused', 'rolled_back']);

/**
 * Never more than 8 characters, and it is `journal.ts`'s function.
 *
 * Re-exported under the name `docs/PLATFORM.md` §5.7 uses so a reader looking
 * for `redactProfileKey` finds it here, without a second implementation
 * existing to drift from the first.
 */
export function redactProfileKey(k: string): string {
  return redactPlayerId(k);
}

/** True for a row the erasure path must leave alone. */
export function isModerationVerb(verb: string): boolean {
  return verb.startsWith('player.');
}

function clip(v: unknown, max: number): string {
  const s = typeof v === 'string' ? v : '';
  const clean = s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}

/** Bound every field, so one row can never be big enough to matter. */
export function clampAction(a: AdminAction): AdminAction {
  return Object.freeze({
    id: clip(a.id, 40),
    ms: Number.isFinite(a.ms) ? Math.floor(a.ms) : 0,
    actor: clip(a.actor, MAX_ACTOR_CHARS),
    verb: clip(a.verb, MAX_VERB_CHARS),
    subject: clip(a.subject, MAX_SUBJECT_CHARS),
    reason: clip(a.reason, MAX_REASON_CHARS),
    before: clip(a.before, MAX_STATE_CHARS),
    after: clip(a.after, MAX_STATE_CHARS),
    outcome: OUTCOMES.includes(a.outcome) ? a.outcome : 'refused',
    requestId: clip(a.requestId, 40),
  });
}

/** One NDJSON line back into a row, or null. Never throws. */
export function parseAction(line: string): AdminAction | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.verb !== 'string') return null;
  if (typeof r.ms !== 'number' || !Number.isFinite(r.ms)) return null;
  return clampAction({
    id: r.id,
    ms: r.ms,
    actor: typeof r.actor === 'string' ? r.actor : '',
    verb: r.verb,
    subject: typeof r.subject === 'string' ? r.subject : '',
    reason: typeof r.reason === 'string' ? r.reason : '',
    before: typeof r.before === 'string' ? r.before : '',
    after: typeof r.after === 'string' ? r.after : '',
    outcome: OUTCOMES.includes(r.outcome as AdminOutcome) ? r.outcome as AdminOutcome : 'refused',
    requestId: typeof r.requestId === 'string' ? r.requestId : '',
  });
}

/* ------------------------------------------------------------------------ *
 * The two required body fields
 * ------------------------------------------------------------------------ */

export interface MutationFields {
  readonly actor: string;
  readonly reason: string;
}

export type MutationCheck =
  | { readonly ok: true; readonly value: MutationFields }
  | { readonly ok: false; readonly error: string };

/**
 * The server-side guard on every mutating admin route.
 *
 * It is here, in a pure function with its own tests, rather than inline in a
 * route handler, because `docs/PLATFORM.md` §5.8's whole argument is that the
 * confirm ritual is the review — and a ritual enforced only by the panel is a
 * ritual an operator with `curl` skips by accident. The panel cannot talk the
 * server into a write this refuses, because the panel is not consulted.
 */
export function requireMutationFields(body: unknown): MutationCheck {
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: 'a mutation needs an actor and a reason' };
  }
  const r = body as Record<string, unknown>;
  const actor = clip(r.actor, MAX_ACTOR_CHARS);
  const reason = clip(r.reason, MAX_REASON_CHARS);
  if (actor.length < MIN_ACTOR_CHARS) {
    return { ok: false, error: `actor must be at least ${MIN_ACTOR_CHARS} characters — it names who did this, and it is a label, not authentication` };
  }
  if (reason.length < MIN_REASON_CHARS) {
    return { ok: false, error: `reason must be at least ${MIN_REASON_CHARS} characters — the audit row is the only record this ever happened` };
  }
  return { ok: true, value: { actor, reason } };
}

/* ------------------------------------------------------------------------ *
 * The log
 * ------------------------------------------------------------------------ */

export interface AdminAuditOptions {
  clock?: () => number;
  /** Retention for non-moderation rows, in days. */
  days?: number;
  /** Injected in tests. Production imports `node:fs/promises` at first use. */
  fs?: JournalFs;
}

export interface AdminAuditStatus {
  appended: number;
  failed: number;
  torn: number;
  degraded: boolean;
  days: number;
  retentionDays: number;
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class AdminAuditLog {
  private readonly root: string;
  private readonly clock: () => number;
  private readonly retentionDays: number;
  private fs: JournalFs | null;
  private readyPromise: Promise<JournalFs | null> | null = null;
  private open: { day: string; file: JournalFile } | null = null;
  private counters = { appended: 0, failed: 0, torn: 0 };
  private degraded = false;
  private dayCount = 0;

  constructor(root: string, opts: AdminAuditOptions = {}) {
    this.root = root.replace(/\/+$/, '');
    this.clock = opts.clock ?? ((): number => Date.now());
    this.retentionDays = Math.max(1, Math.floor(opts.days ?? DEFAULT_AUDIT_DAYS));
    this.fs = opts.fs ?? null;
  }

  private get dir(): string { return `${this.root}/audit`; }
  private pathFor(day: string): string { return `${this.dir}/${day}.ndjson`; }

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
      await this.fs.mkdir(this.dir, { recursive: true });
    } catch {
      this.degraded = true;
      return null;
    }
    return this.fs;
  }

  /**
   * Write one row. Returns the row as it was stored, so a caller can echo the
   * `id` back and an operator can find the line again.
   *
   * A failed write is counted and NEVER thrown: an admin action whose audit
   * append failed has still happened, and turning that into a 500 would leave
   * the operator believing the action did not fire. The failure is visible in
   * `status().failed`, which `GET /api/admin/audit` returns.
   */
  async record(input: Omit<AdminAction, 'id'> & { id?: string }): Promise<AdminAction> {
    const ms = Number.isFinite(input.ms) ? input.ms : this.clock();
    const row = clampAction({ ...input, ms, id: input.id ?? newLedgerId(ms) });
    const fs = await this.ready();
    if (fs === null) { this.counters.failed++; return row; }
    try {
      const file = await this.fileFor(fs, utcDay(ms));
      await file.write(JSON.stringify(row) + '\n');
      this.counters.appended++;
    } catch {
      this.degraded = true;
      this.counters.failed++;
    }
    return row;
  }

  /**
   * The append handle for one day, opened once.
   *
   * The blank line on first open of a non-empty file is `journal.ts`'s torn
   * write guard and it is here for the same reason: a process killed mid-write
   * leaves a line with no newline, and the next append would concatenate onto
   * it — turning one lost row into two.
   */
  private async fileFor(fs: JournalFs, day: string): Promise<JournalFile> {
    if (this.open !== null && this.open.day === day) return this.open.file;
    if (this.open !== null) {
      const prev = this.open;
      this.open = null;
      try { await prev.file.close(); } catch { /* the day is over anyway */ }
    }
    await fs.mkdir(this.dir, { recursive: true });
    let size = 0;
    try { size = (await fs.stat(this.pathFor(day))).size; } catch { size = 0; }
    const file = await fs.open(this.pathFor(day), 'a');
    if (size > 0) { try { await file.write('\n'); } catch { /* checked on write */ } }
    this.open = { day, file };
    return file;
  }

  private async days(): Promise<string[]> {
    const fs = await this.ready();
    if (fs === null) return [];
    let names: string[];
    try { names = await fs.readdir(this.dir); } catch { return []; }
    const out: string[] = [];
    for (const n of names) {
      const m = DAY_FILE.exec(n);
      if (m !== null) out.push(m[1]);
    }
    this.dayCount = out.length;
    return out.sort();
  }

  private async readDay(day: string): Promise<AdminAction[]> {
    const fs = this.fs;
    if (fs === null) return [];
    let text: string;
    try { text = await fs.readFile(this.pathFor(day), 'utf8'); } catch { return []; }
    const out: AdminAction[] = [];
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      const a = parseAction(line);
      if (a === null) { this.counters.torn++; continue; }
      out.push(a);
    }
    return out;
  }

  /** Newest first, across day files, stopping as soon as the page is full. */
  async read(sinceMs: number, limit: number): Promise<AdminAction[]> {
    await this.ready();
    const cap = Math.max(1, Math.min(500, Math.floor(limit)));
    const out: AdminAction[] = [];
    const days = (await this.days()).sort().reverse();
    for (const day of days) {
      const rows = await this.readDay(day);
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (r.ms < sinceMs) continue;
        out.push(r);
        if (out.length >= cap) return out;
      }
    }
    return out;
  }

  /**
   * Retention. A day past the bound is REWRITTEN with only its moderation rows
   * and unlinked when none are left — see the header for why it cannot simply
   * be deleted.
   *
   * Returns how many day files were touched.
   */
  async sweep(): Promise<number> {
    const fs = await this.ready();
    if (fs === null) return 0;
    const cutoff = utcDay(this.clock() - this.retentionDays * 86_400_000);
    let touched = 0;
    for (const day of await this.days()) {
      if (day >= cutoff) continue;
      const rows = await this.readDay(day);
      const keep = rows.filter((r) => isModerationVerb(r.verb));
      try {
        if (this.open !== null && this.open.day === day) {
          const prev = this.open;
          this.open = null;
          try { await prev.file.close(); } catch { /* closing anyway */ }
        }
        if (keep.length === 0) {
          await fs.unlink(this.pathFor(day));
        } else {
          const tmp = `${this.pathFor(day)}.tmp`;
          await fs.writeFile(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
          await fs.rename(tmp, this.pathFor(day));
        }
        touched++;
      } catch {
        this.degraded = true;
      }
    }
    return touched;
  }

  /**
   * Erasure. Rewrites every day file, dropping the non-moderation rows for this
   * subject and PSEUDONYMISING the moderation ones — the same resolution the
   * journal makes, for the same reason: a ban that deletes itself is an exploit.
   *
   * `subject` is the redacted key, because that is the only form this file ever
   * holds.
   */
  async forget(subject: string): Promise<number> {
    const fs = await this.ready();
    if (fs === null) return 0;
    let changed = 0;
    for (const day of await this.days()) {
      const rows = await this.readDay(day);
      let dirty = false;
      const next: AdminAction[] = [];
      for (const r of rows) {
        if (r.subject !== subject) { next.push(r); continue; }
        dirty = true;
        if (!isModerationVerb(r.verb)) continue;
        next.push(clampAction({ ...r, actor: 'deleted', before: '', after: '' }));
      }
      if (!dirty) continue;
      try {
        if (this.open !== null && this.open.day === day) {
          const prev = this.open;
          this.open = null;
          try { await prev.file.close(); } catch { /* closing anyway */ }
        }
        const tmp = `${this.pathFor(day)}.tmp`;
        const text = next.length === 0 ? '' : next.map((r) => JSON.stringify(r)).join('\n') + '\n';
        await fs.writeFile(tmp, text, 'utf8');
        await fs.rename(tmp, this.pathFor(day));
        changed++;
      } catch {
        this.degraded = true;
      }
    }
    return changed;
  }

  status(): AdminAuditStatus {
    return {
      appended: this.counters.appended,
      failed: this.counters.failed,
      torn: this.counters.torn,
      degraded: this.degraded,
      days: this.dayCount,
      retentionDays: this.retentionDays,
    };
  }

  async close(): Promise<void> {
    const open = this.open;
    this.open = null;
    if (open !== null) { try { await open.file.close(); } catch { /* best effort */ } }
  }
}
