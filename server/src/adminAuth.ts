/**
 * DOOMCRAFT — the admin bearer, and why it needed its own file.
 *
 * `docs/PACKS.md` §0.2 item 5 and `docs/PLATFORM.md` §5.2 both say the same
 * thing about the check that used to live inline in `server/src/index.ts`:
 *
 * ```ts
 *   const supplied = header.startsWith('Bearer ') ? header.slice(7) : header;
 *   if (supplied.length !== ADMIN_TOKEN.length) return false;     // <-- oracle
 *   let diff = 0;
 *   for (let i = 0; i < ADMIN_TOKEN.length; i++) diff |= …;       // <-- equal lengths only
 * ```
 *
 * Three defects, and a fourth that is an absence:
 *
 *   1. **Token length is an oracle.** The early return on length is one
 *      request per guess: send 1, 2, 3… characters and the first one that
 *      takes the slow path tells you exactly how long the secret is. The XOR
 *      loop below it is constant-time *only* for inputs that already passed
 *      the length test, so the "constant-time-ish" comment was true of the
 *      loop and false of the function.
 *   2. **`'Bearer '` was stripped case-sensitively**, and RFC 7235 §2.1 says
 *      the scheme is case-insensitive. `authorization: bearer <tok>` is a
 *      legal request that this refused, and a bare token with no scheme at all
 *      was accepted, which is the opposite of strict.
 *   3. **No rate limit.** The bearer was brute-forceable at line rate.
 *   4. **No log of a failed attempt anywhere in the tree.** An operator could
 *      not tell an attack from a typo, because neither left a mark.
 *
 * ## How the oracle is removed
 *
 * Both sides are hashed to a fixed 32 bytes before they are compared, and the
 * compare is `timingSafeEqual` over those two fixed-length buffers. There is no
 * length branch left to take, because after `sha256` there is no length
 * difference left to branch on — a 1-character guess and a 10,000-character
 * guess cost the same. That is a stronger property than "compare carefully":
 * it is "there is nothing to compare carefully".
 *
 * ## Why this is a module and not four lines in `index.ts`
 *
 * `index.ts` is the process entry point: it opens a port, spawns rooms and
 * cannot be imported by a test without booting a server. Every claim above is
 * about a pure function of a header string, and a claim that can only be tested
 * through a child process is a claim that will be tested loosely or not at all.
 * `adminAuth.test.ts` tests this file directly; `csp.test.ts` proves `index.ts`
 * actually calls it.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** How many failed attempts one client address gets per window. */
export const ADMIN_FAILURE_LIMIT = 20;
/** The window those failures are counted over. */
export const ADMIN_FAILURE_WINDOW_MS = 60_000;

export enum AdminVerdict {
  /** The token matched. */
  OK = 0,
  /** No token configured, no credential supplied, or the wrong one. */
  DENIED = 1,
  /** Too many failures from this client address. Answer 429. */
  THROTTLED = 2,
}

/** Why an attempt was denied, for the log line. Never sent to the client. */
export type DenyReason = 'unconfigured' | 'no-credential' | 'bad-token' | 'throttled';

export interface AdminDenial {
  readonly ms: number;
  readonly client: string;
  readonly reason: DenyReason;
  /** The path that was asked for, when the caller knows it. */
  readonly path: string;
}

export interface AdminGateOptions {
  /** Wall clock, ms. */
  clock?: () => number;
  /** Failures allowed per client address per window. */
  limit?: number;
  windowMs?: number;
  /**
   * Called once per refusal. `index.ts` writes a line to stderr; a test
   * records them. Never called on success — a successful admin request is the
   * normal case and does not want a line.
   */
  onDenied?: (d: AdminDenial) => void;
}

/**
 * Pull the credential out of an `authorization` header.
 *
 * REQUIRES the scheme, and matches it case-insensitively per RFC 7235 §2.1.
 * Returning null for a bare token is deliberate: accepting one meant the
 * server had two accepted spellings of a credential, one of which no client
 * sends and only a hand-rolled attack tool produces.
 */
export function bearerCredential(raw: string | string[] | undefined): string | null {
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== 'string') return null;
  const m = /^[ \t]*bearer[ \t]+([^ \t]+)[ \t]*$/i.exec(header);
  return m === null ? null : m[1];
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/**
 * Constant-time credential compare with NO length branch.
 *
 * Both sides go through `sha256` first, so `timingSafeEqual` always sees two
 * 32-byte buffers and cannot throw on a length mismatch — which is the other
 * reason the naive version had to test lengths first, and the reason removing
 * that test naively would have turned the oracle into a crash.
 */
export function credentialMatches(supplied: string, token: string): boolean {
  return timingSafeEqual(sha256(supplied), sha256(token));
}

/**
 * The admin bearer, with its failure counter.
 *
 * One per process. An unset token disables the surface entirely — that part of
 * the old behaviour is right and is kept: `admit` answers `DENIED` for every
 * request and `index.ts` still renders that as a 404, so an unconfigured
 * deployment advertises nothing.
 */
export class AdminGate {
  private readonly token: string;
  private readonly clock: () => number;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly onDenied: (d: AdminDenial) => void;
  /** client address -> [failures, window start ms] */
  private readonly failures = new Map<string, { n: number; since: number }>();
  private deniedCount = 0;
  private throttledCount = 0;

  constructor(token: string, opts: AdminGateOptions = {}) {
    this.token = token;
    this.clock = opts.clock ?? ((): number => Date.now());
    this.limit = opts.limit ?? ADMIN_FAILURE_LIMIT;
    this.windowMs = opts.windowMs ?? ADMIN_FAILURE_WINDOW_MS;
    this.onDenied = opts.onDenied ?? ((): void => { /* silent by default */ });
  }

  /** True when a token is configured at all. */
  get configured(): boolean { return this.token.length > 0; }

  get denied(): number { return this.deniedCount; }
  get throttled(): number { return this.throttledCount; }

  /**
   * Decide one request.
   *
   * `client` is the rate-limit key and must be `clientAddress(req)` — which
   * reads `x-forwarded-for` only when `DOOMCRAFT_TRUST_PROXY=1`. A limiter
   * keyed on an untrusted header is a limiter an attacker turns off with a
   * header.
   *
   * Only FAILURES are counted, and **the credential is checked before the
   * bucket is consulted**, so a correct token is never throttled. That
   * ordering is deliberate and it is the whole design of this limiter:
   *
   *   - Refusing a *correct* token because somebody else on the same NAT is
   *     guessing locks the operator out of the drain switch at precisely the
   *     moment they need it. An attack is not a reason to disarm the defender.
   *   - Nothing is lost by comparing first. The attacker's guess is refused
   *     either way; the 429 replaces a 404 it was already going to get. What
   *     the limit buys is a bound on the guess rate, a bound on the log
   *     volume, and a state an operator can see — not the refusal itself,
   *     which the constant-time compare above already guarantees.
   *
   * An unset token short-circuits before the bucket entirely, so a host with
   * no admin surface answers identically to every caller forever and cannot be
   * probed for the existence of a rate limiter.
   */
  admit(authorization: string | string[] | undefined, client: string, path = ''): AdminVerdict {
    const now = this.clock();
    if (this.token.length === 0) {
      this.deniedCount++;
      this.onDenied(Object.freeze({ ms: now, client, reason: 'unconfigured', path }));
      return AdminVerdict.DENIED;
    }

    const supplied = bearerCredential(authorization);
    if (supplied !== null && credentialMatches(supplied, this.token)) {
      // A success clears the client's failure history: an operator who mistypes
      // twice and then gets it right is not one attempt away from a lockout.
      this.failures.delete(client);
      return AdminVerdict.OK;
    }

    const bucket = this.failures.get(client);
    if (bucket !== undefined && now - bucket.since < this.windowMs && bucket.n >= this.limit) {
      this.throttledCount++;
      this.onDenied(Object.freeze({ ms: now, client, reason: 'throttled', path }));
      return AdminVerdict.THROTTLED;
    }

    return this.deny(now, client, path, supplied === null ? 'no-credential' : 'bad-token');
  }

  /** Drop expired failure buckets. Cheap and idempotent; call on a timer. */
  sweep(nowMs?: number): number {
    const now = nowMs ?? this.clock();
    let dropped = 0;
    for (const [k, b] of [...this.failures]) {
      if (now - b.since < this.windowMs) continue;
      this.failures.delete(k);
      dropped++;
    }
    return dropped;
  }

  private deny(now: number, client: string, path: string, reason: DenyReason): AdminVerdict {
    this.deniedCount++;
    const bucket = this.failures.get(client);
    if (bucket === undefined || now - bucket.since >= this.windowMs) {
      this.failures.set(client, { n: 1, since: now });
    } else {
      bucket.n++;
    }
    this.onDenied(Object.freeze({ ms: now, client, reason, path }));
    return AdminVerdict.DENIED;
  }
}
