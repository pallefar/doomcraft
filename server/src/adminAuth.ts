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
  /** The token matched, or an owner session did. */
  OK = 0,
  /** No token configured, no credential supplied, or the wrong one. */
  DENIED = 1,
  /** Too many failures from this client address. Answer 429. */
  THROTTLED = 2,
  /**
   * A VALID session that is not an owner's. Answer 403, not 404.
   *
   * This is the one refusal that is allowed to be distinguishable, and it must
   * be: the 404 exists so an anonymous prober cannot tell an admin host from a
   * plain one, and a caller holding a session this host minted has already been
   * told the host has accounts. Answering 404 there would tell a signed-in
   * player their session is broken when it is fine, which is how a support
   * ticket becomes an afternoon.
   */
  FORBIDDEN = 3,
}

/** Why an attempt was denied, for the log line. Never sent to the client. */
export type DenyReason =
  | 'unconfigured'
  | 'no-credential'
  | 'bad-token'
  | 'throttled'
  /** A session resolved, and its account is a player. */
  | 'not-owner';

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
  /**
   * Resolve a session token to an account, or null.
   *
   * Injected rather than imported so this whole file stays a pure function of
   * strings and can be unit-tested without a store, a disk or a server —
   * which is the reason `adminAuth.ts` exists as a module at all.
   */
  resolveSession?: SessionResolver;
  /**
   * How many owner accounts this host has.
   *
   * Part of the answer to "does this host have an admin surface at all". With
   * no env token AND no owner there is nothing to sign in to, and the 404
   * philosophy holds; with an owner but no env token there IS a surface, and
   * answering 404 to its sign-in page would be a lie.
   */
  ownerCount?: () => number;
}

/** What a session token resolves to. `role` is read live, never cached. */
export interface SessionPrincipal {
  readonly accountId: string;
  readonly role: 'owner' | 'player';
}

export type SessionResolver = (token: string) => SessionPrincipal | null;

/** Which credential got in. `none` accompanies every refusal. */
export type AdminVia = 'none' | 'env' | 'owner';

export interface AdminDecision {
  readonly verdict: AdminVerdict;
  readonly via: AdminVia;
  /** The owner's account id when `via === 'owner'`, else null. */
  readonly accountId: string | null;
}

export interface AdmitOptions {
  /**
   * False on `GET /admin` only: decide, but do not count the refusal and do not
   * write a log line. See `admitRequest`.
   */
  readonly record?: boolean;
}

/** The two credentials a request may carry, already pulled off the headers. */
export interface AdminCredentials {
  readonly authorization?: string | string[] | undefined;
  /** From the `dc_sess` cookie, or from the bearer. See `sessionCredential`. */
  readonly sessionToken?: string | null;
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
 * The admin bearer, with its failure counter — and, since S5, the OWNER
 * SESSION beside it.
 *
 * One per process. **Two credentials, and they are not equals:**
 *
 *   1. `DOOMCRAFT_ADMIN_TOKEN` in the environment. **Root.** It is checked
 *      first, it is never throttled when correct, and it is the only credential
 *      `POST /api/admin/owner/transfer` accepts. It is the way back in when the
 *      owner account is lost, hostile or forgotten, so it cannot itself be
 *      reachable through the account system.
 *   2. A session whose account has `role === 'owner'`. Everything an operator
 *      does day to day, from a browser, without a shared secret in a password
 *      manager.
 *
 * A session whose account is a `player` is **not** a failed attempt. It is a
 * successful authentication of somebody who is not allowed here, and it gets
 * `FORBIDDEN` (403) without touching the failure bucket — counting it would let
 * an ordinary signed-in player lock their own NAT out of the console.
 *
 * With NEITHER an env token NOR any owner account, the surface does not exist:
 * `admitRequest` answers `DENIED` for every request and `index.ts` renders that
 * as a 404, so an unconfigured deployment advertises nothing.
 */
export class AdminGate {
  private readonly token: string;
  private readonly clock: () => number;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly onDenied: (d: AdminDenial) => void;
  private readonly resolveSession: SessionResolver;
  private readonly ownerCount: () => number;
  /** client address -> [failures, window start ms] */
  private readonly failures = new Map<string, { n: number; since: number; loggedThrottle?: boolean }>();
  private deniedCount = 0;
  private throttledCount = 0;

  constructor(token: string, opts: AdminGateOptions = {}) {
    this.token = token;
    this.clock = opts.clock ?? ((): number => Date.now());
    this.limit = opts.limit ?? ADMIN_FAILURE_LIMIT;
    this.windowMs = opts.windowMs ?? ADMIN_FAILURE_WINDOW_MS;
    this.onDenied = opts.onDenied ?? ((): void => { /* silent by default */ });
    this.resolveSession = opts.resolveSession ?? ((): null => null);
    this.ownerCount = opts.ownerCount ?? ((): number => 0);
  }

  /** True when an env token is configured at all. */
  get configured(): boolean { return this.token.length > 0; }

  /**
   * True when this host has an admin surface by EITHER route.
   *
   * `GET /admin` renders its sign-in page when this is true and no session is
   * held, and 404s when it is false. The 404 is reserved for "no admin token
   * AND no owner", because a host with an owner account plainly has a console
   * and pretending otherwise only locks the owner out.
   */
  get hasSurface(): boolean { return this.token.length > 0 || this.ownerCount() > 0; }

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
    return this.admitRequest({ authorization, sessionToken: null }, client, path).verdict;
  }

  /**
   * The same decision, with the session half wired in, and it says WHO got in.
   *
   * The order is the security property: the env bearer is tried first, so a
   * host whose owner account has been compromised is still operable with the
   * root credential, and a request carrying both a player cookie and the env
   * token is admitted as root rather than refused as a player.
   */
  admitRequest(cred: AdminCredentials, client: string, path = '', opts: AdmitOptions = {}): AdminDecision {
    const now = this.clock();
    /*
     * `record: false` is for `GET /admin` and nothing else.
     *
     * That route answers a credential-less request with the SIGN-IN PAGE, so
     * loading it is not a failed attempt — and counting it would mean twenty
     * page loads from one office lock that office out of its own console with
     * a 429. The bucket is still CONSULTED, so a client that burned its budget
     * guessing at `/api/admin/*` does not get a fresh page to guess from.
     */
    const record = opts.record !== false;

    /* 1. The env bearer. Root. */
    const supplied = bearerCredential(cred.authorization);
    if (this.token.length > 0 && supplied !== null && credentialMatches(supplied, this.token)) {
      // A success clears the client's failure history: an operator who mistypes
      // twice and then gets it right is not one attempt away from a lockout.
      this.failures.delete(client);
      return { verdict: AdminVerdict.OK, via: 'env', accountId: null };
    }

    /* 2. A session. Owner in, player out with a 403 and no failure counted. */
    const token = cred.sessionToken ?? null;
    const principal = token === null ? null : this.resolveSession(token);
    if (principal !== null) {
      if (principal.role === 'owner') {
        this.failures.delete(client);
        return { verdict: AdminVerdict.OK, via: 'owner', accountId: principal.accountId };
      }
      if (record) {
        this.deniedCount++;
        this.onDenied(Object.freeze({ ms: now, client, reason: 'not-owner', path }));
      }
      return { verdict: AdminVerdict.FORBIDDEN, via: 'none', accountId: principal.accountId };
    }

    /* 3. No surface at all: identical answer to every caller, forever, and no
     *    bucket, so it cannot even be probed for the existence of a limiter. */
    if (!this.hasSurface) {
      if (record) {
        this.deniedCount++;
        this.onDenied(Object.freeze({ ms: now, client, reason: 'unconfigured', path }));
      }
      return { verdict: AdminVerdict.DENIED, via: 'none', accountId: null };
    }

    const bucket = this.failures.get(client);
    if (bucket !== undefined && now - bucket.since < this.windowMs && bucket.n >= this.limit) {
      if (record) {
        this.throttledCount++;
        // One line per window, not one per request: a brute force at line rate
        // must not be able to turn the denial log into a disk-filling attack.
        // The counter above still moves on every request, so `status()` sees it.
        if (!bucket.loggedThrottle) {
          bucket.loggedThrottle = true;
          this.onDenied(Object.freeze({ ms: now, client, reason: 'throttled', path }));
        }
      }
      return { verdict: AdminVerdict.THROTTLED, via: 'none', accountId: null };
    }

    if (record) {
      this.deny(now, client, path, supplied === null && token === null ? 'no-credential' : 'bad-token');
    }
    return { verdict: AdminVerdict.DENIED, via: 'none', accountId: null };
  }

  /**
   * THE ENV BEARER ONLY — no session, not even an owner's.
   *
   * `POST /api/admin/owner/transfer` is the safety net for a hostile bootstrap:
   * the first signup on a fresh deploy becomes the owner, and if that was not
   * the operator, the operator needs a credential the squatter does not have.
   * An owner-session-callable transfer would let the squatter keep the role by
   * transferring it to themselves, which is the whole failure it exists to fix.
   */
  admitEnvOnly(authorization: string | string[] | undefined, client: string, path = ''): AdminVerdict {
    const now = this.clock();
    if (this.token.length === 0) {
      this.deniedCount++;
      this.onDenied(Object.freeze({ ms: now, client, reason: 'unconfigured', path }));
      return AdminVerdict.DENIED;
    }
    return this.admit(authorization, client, path);
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

/**
 * The same bucket, for `/api/auth/*`, and the ONE place it is deliberately
 * different from `AdminGate`.
 *
 * `AdminGate` compares the credential BEFORE it consults the bucket, and its
 * comment argues that nothing is lost by doing so: a sha-256 compare costs
 * microseconds, so the refusal is free either way and a correct token is never
 * locked out by somebody else on the same NAT.
 *
 * **That argument is false for a passphrase.** `scrypt` at N=2^15 is ~100 ms on
 * one of the four libuv threadpool workers. Twenty guesses a minute per address
 * with the compare first is 2 s of pool time bought for the price of two dozen
 * packets, and the pool is shared with every file read the profile store does.
 * So this limiter is consulted FIRST and refuses before it hashes.
 *
 * The lockout that ordering creates is real and is survivable here for a reason
 * `AdminGate` does not have: the console has a second credential. Twenty wrong
 * passphrases from an address make the *account* route answer 429 for the rest
 * of the minute; the env bearer is untouched, and it is root. A successful
 * sign-in clears the address's history, exactly as a correct bearer does.
 */
export class AttemptThrottle {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly buckets = new Map<string, { n: number; since: number }>();
  private refusedCount = 0;

  constructor(limit: number = ADMIN_FAILURE_LIMIT, windowMs: number = ADMIN_FAILURE_WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** How many refusals this process has issued, for the console. */
  get refused(): number { return this.refusedCount; }

  /** False means: answer 429 now, before doing any work. */
  allow(client: string, nowMs: number): boolean {
    const b = this.buckets.get(client);
    if (b === undefined || nowMs - b.since >= this.windowMs) return true;
    if (b.n < this.limit) return true;
    this.refusedCount++;
    return false;
  }

  /** Count one failure against this address. */
  fail(client: string, nowMs: number): void {
    const b = this.buckets.get(client);
    if (b === undefined || nowMs - b.since >= this.windowMs) {
      this.buckets.set(client, { n: 1, since: nowMs });
      return;
    }
    b.n++;
  }

  /** A success wipes the history, so a typo streak is not a lockout. */
  clear(client: string): void { this.buckets.delete(client); }

  sweep(nowMs: number): number {
    let dropped = 0;
    for (const [k, b] of [...this.buckets]) {
      if (nowMs - b.since < this.windowMs) continue;
      this.buckets.delete(k);
      dropped++;
    }
    return dropped;
  }
}
