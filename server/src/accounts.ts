/**
 * DOOMCRAFT — accounts, and the one rule that makes the admin console ownable:
 * **the first account created on a host becomes its owner.**
 *
 * ## Why this file exists at all
 *
 * `docs/PLATFORM.md` §2.1 lists nine defects in the identity code that shipped,
 * four of them critical, and S0 answered the worst of them by DELETING the two
 * unauthenticated HTTP routes (`POST /api/account/link`, `POST
 * /api/account/resolve`). What survived is the substrate:
 * `PersistenceStore.linkAccount` / `resolveAccount` and the `accountIndex` in
 * `server/src/persistence.ts`. Those are still right; what was missing was
 * anything that could *prove* a human owns an account before the link is made.
 *
 * This module is that proof, and nothing more:
 *
 *   - a **name** and a **passphrase**, hashed with `scrypt` from `node:crypto`,
 *   - a **role**, `owner` or `player`, decided once, at signup, under a lock,
 *   - a **session**, in memory, delivered as an `httpOnly` cookie.
 *
 * It deliberately does NOT implement `docs/PLATFORM.md` §2.4's
 * `CredentialProvider`, the account graph of §2.3, or the merge of §3. A
 * passphrase account is *stronger* than the house recovery code that §2.4
 * describes (that one is labelled `authenticates: false` and exists for
 * recovery), and it is the smallest thing that can put a human behind
 * `GET /admin`. The provider interface lands with WorkOS, and every field this
 * record carries survives that day unchanged.
 *
 * ## THE BOOTSTRAP RULE, AND THE RACE IT HAS
 *
 * "First signup becomes the owner" is a read (`ownerCount() === 0`) followed by
 * a write (`role = 'owner'`) with an **`await` in between** — the scrypt of the
 * new passphrase, which is ~100 ms of a libuv thread. Two requests that arrive
 * inside that window both read zero and both write `owner`. That is not a
 * theoretical interleaving: it is what happens the first time somebody scripts
 * two signups, and the result is a host with two owners and no way to tell
 * which one was meant.
 *
 * So `signup()` runs its whole body — the count, the hash and the write —
 * inside `withLock`, a single process-wide write lock. `accounts.test.ts`
 * drives both promises in the same tick and asserts exactly one owner; remove
 * the `withLock` wrapper and that test goes red with two.
 *
 * ## What is NOT protected
 *
 * - **Sessions do not survive a restart.** They are a `Map` in one process.
 *   That is stated in the console, in `HANDOVER.md` §3.1, and here. One box,
 *   one operator; a session store is a database decision and there is no
 *   database (`docs/PLATFORM.md` §10).
 * - **Anyone who learns the passphrase owns the account.** No second factor and
 *   no email reset, exactly as §2.4 says of the house credential. The env
 *   bearer stays root precisely so there is a way back in.
 * - **A hostile first signup.** Between deploy and the operator's first signup,
 *   whoever gets there first is the owner. `POST /api/admin/owner/transfer`,
 *   callable only with the env bearer, is the answer, and the window is the
 *   reason it exists.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

/* ------------------------------------------------------------------------ *
 * The shape on disk
 * ------------------------------------------------------------------------ */

/** The file, under `DOOMCRAFT_DATA`, beside `profiles/` and the journal. */
export const ACCOUNTS_FILE = 'accounts-v1.json';
export const ACCOUNTS_VERSION = 1;

export type AccountRole = 'owner' | 'player';

export interface Account {
  id: string;
  /** Lowercase, exactly as typed after `nameKey` normalisation. */
  name: string;
  /** The unique key. Lowercased name; two accounts may never share one. */
  nameKey: string;
  /** scrypt(passphrase, salt), hex. NEVER leaves this process. */
  passHash: string;
  /** 16 CSPRNG bytes, hex. */
  salt: string;
  role: AccountRole;
  createdMs: number;
  lastSeenMs: number;
  /** Devices whose profile has been linked to this account. Capped. */
  deviceIds: string[];
}

/**
 * The ONLY shape an account may take on the wire.
 *
 * Three fields, and the three that are missing are the point: `passHash`,
 * `salt` and `deviceIds` are not in it, so no route can leak them by
 * forgetting to strip them — a serialiser that builds the safe shape cannot be
 * out of date the way a redactor that deletes the unsafe one can.
 */
export interface PublicAccount {
  readonly id: string;
  readonly name: string;
  readonly role: AccountRole;
}

export function publicAccount(a: Account): PublicAccount {
  return { id: a.id, name: a.name, role: a.role };
}

/* ------------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------------ */

export const NAME_MIN = 3;
export const NAME_MAX = 32;
const NAME_RE = /^[a-z0-9_-]+$/;

/** 12, and it is a floor on a *passphrase*, not a password complexity ritual. */
export const PASSPHRASE_MIN = 12;
/** A ceiling only so an attacker cannot post 64 KB into scrypt as a DoS. */
export const PASSPHRASE_MAX = 256;

/** Devices one account may link. Beyond this the oldest link is dropped. */
export const MAX_LINKED_DEVICES = 8;

/**
 * The storage key for a name. Lowercased, so `Owner` and `owner` are the same
 * account and a second signup cannot shadow the first with a case change.
 */
export function nameKeyOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if (key.length < NAME_MIN || key.length > NAME_MAX) return null;
  if (!NAME_RE.test(key)) return null;
  return key;
}

export function passphraseOk(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length >= PASSPHRASE_MIN && raw.length <= PASSPHRASE_MAX;
}

/* ------------------------------------------------------------------------ *
 * The hash
 * ------------------------------------------------------------------------ */

export interface ScryptParams {
  /** CPU/memory cost. 2^15 = 32768. */
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keyLen: number;
}

/**
 * `docs/PLATFORM.md` §2.4's requirement, met with the standard library.
 *
 * N=2^15, r=8, p=1 is ~32 MB and ~100 ms per hash on this class of machine —
 * the RFC 7914 "interactive login" point. `maxmem` is raised to 64 MB because
 * node's default is 32 MB and `128 * N * r` for these parameters is 32 MB
 * exactly, which is close enough to the limit to be a portability bet.
 *
 * NO NEW DEPENDENCY. argon2id is better and is a native module; a native module
 * in this tree is a build break on the first platform that has no prebuilt.
 */
export const DEFAULT_SCRYPT: ScryptParams = Object.freeze({ N: 32768, r: 8, p: 1, keyLen: 32 });

const SALT_BYTES = 16;

function scrypt(passphrase: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((done, fail) => {
    scryptCb(
      passphrase,
      salt,
      params.keyLen,
      { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 },
      (err, key) => { if (err) fail(err); else done(key); },
    );
  });
}

/* ------------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------------ */

/** 30 days, slid forward on every use. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** The cookie name. `dc_` matches nothing else this origin sets. */
export const SESSION_COOKIE = 'dc_sess';

export interface SessionRecord {
  readonly accountId: string;
  expiresMs: number;
}

/**
 * In-memory sessions.
 *
 * A `Map` keyed by a 256-bit CSPRNG token. There is no disk copy on purpose:
 * a session file is a credential at rest with no expiry the operator can see,
 * and this process is one box. A restart signs everybody out, which is a
 * property the console states out loud rather than a surprise.
 */
export class SessionTable {
  private readonly rows = new Map<string, SessionRecord>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = SESSION_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  get size(): number { return this.rows.size; }

  /** A new session token. `randomBytes`, never `Math.random` — §2.1 defect 1. */
  mint(accountId: string, nowMs: number): string {
    const token = randomBytes(32).toString('hex');
    this.rows.set(token, { accountId, expiresMs: nowMs + this.ttlMs });
    return token;
  }

  /**
   * Resolve and SLIDE. An operator with the console open all week is not signed
   * out mid-rollout because the session was minted 30 days ago.
   */
  resolve(token: string | null | undefined, nowMs: number): SessionRecord | null {
    if (typeof token !== 'string' || token.length === 0) return null;
    const row = this.rows.get(token);
    if (row === undefined) return null;
    if (row.expiresMs <= nowMs) { this.rows.delete(token); return null; }
    row.expiresMs = nowMs + this.ttlMs;
    return row;
  }

  revoke(token: string | null | undefined): boolean {
    if (typeof token !== 'string') return false;
    return this.rows.delete(token);
  }

  /** Every session of one account, for a role change or a forced sign-out. */
  revokeAllFor(accountId: string): number {
    let n = 0;
    for (const [k, v] of [...this.rows]) {
      if (v.accountId !== accountId) continue;
      this.rows.delete(k);
      n++;
    }
    return n;
  }

  /** Drop expired rows. Cheap and idempotent; call on a timer. */
  sweep(nowMs: number): number {
    let dropped = 0;
    for (const [k, v] of [...this.rows]) {
      if (v.expiresMs > nowMs) continue;
      this.rows.delete(k);
      dropped++;
    }
    return dropped;
  }
}

/* ------------------------------------------------------------------------ *
 * The cookie
 * ------------------------------------------------------------------------ */

/**
 * `httpOnly` so no script on this origin can read it — including the console's
 * own, which is why the token is never in a response body either. `Secure` so
 * it never rides a plaintext hop; browsers treat `http://localhost` as a
 * trustworthy origin and still store it, but **`curl` will not send a Secure
 * cookie over http**, so a local transcript passes it with `-H cookie:`.
 * `SameSite=Lax` so a POST from another site does not carry it — the console's
 * writes are all POSTs, which Lax excludes.
 */
export function sessionCookie(token: string, ttlMs: number = SESSION_TTL_MS): string {
  const maxAge = Math.max(0, Math.floor(ttlMs / 1000));
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/** The same cookie, expired. Sent by sign-out so the browser drops it. */
export function expiredSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** One cookie out of a `cookie:` header. Returns null rather than ''. */
export function cookieValue(raw: string | string[] | undefined, name: string): string | null {
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const v = part.slice(eq + 1).trim();
    return v.length === 0 ? null : v;
  }
  return null;
}

/**
 * The session token a request carries, cookie first, `Authorization: Bearer`
 * second.
 *
 * Both are accepted because the console is a browser (cookie) and `curl` is
 * not. The bearer is ALSO where the env admin token arrives, so a caller that
 * sends the env token here simply resolves to no session — the gate has already
 * tried it as the env token by then.
 */
export function sessionCredential(headers: {
  cookie?: string | string[] | undefined;
  authorization?: string | string[] | undefined;
}): string | null {
  const fromCookie = cookieValue(headers.cookie, SESSION_COOKIE);
  if (fromCookie !== null) return fromCookie;
  const raw = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  if (typeof raw !== 'string') return null;
  const m = /^[ \t]*bearer[ \t]+([^ \t]+)[ \t]*$/i.exec(raw);
  return m === null ? null : m[1];
}

/* ------------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------------ */

export type SignupError = 'bad-name' | 'bad-passphrase' | 'name-taken';
export type SignupResult =
  | { ok: true; account: Account; bootstrapped: boolean }
  | { ok: false; error: SignupError };

export type SigninResult =
  | { ok: true; account: Account }
  | { ok: false; error: 'bad-credentials' };

export type TransferResult =
  | { ok: true; owner: Account; demoted: string[] }
  | { ok: false; error: 'no-such-account' };

export interface AccountStoreOptions {
  clock?: () => number;
  /** Lowered ONLY by tests that need many hashes. Production uses the default. */
  scrypt?: ScryptParams;
}

interface AccountsFile {
  version: number;
  accounts: Account[];
}

export class AccountStore {
  private readonly root: string;
  private readonly clock: () => number;
  private readonly params: ScryptParams;
  private readonly byKey = new Map<string, Account>();
  private readonly byIdMap = new Map<string, Account>();
  /** THE write lock. One per process; see the header. */
  private tail: Promise<unknown> = Promise.resolve();
  private loading: Promise<void> | null = null;
  /** Set when the disk is unusable. The store keeps working in memory. */
  degraded = false;

  constructor(root: string, opts: AccountStoreOptions = {}) {
    this.root = root.replace(/\/+$/, '');
    this.clock = opts.clock ?? ((): number => Date.now());
    this.params = opts.scrypt ?? DEFAULT_SCRYPT;
  }

  /** Read `accounts-v1.json`. Idempotent; every entry point awaits it. */
  ready(): Promise<void> {
    if (this.loading === null) this.loading = this.loadOnce();
    return this.loading;
  }

  private async loadOnce(): Promise<void> {
    let text: string;
    try {
      text = await readFile(`${this.root}/${ACCOUNTS_FILE}`, 'utf8');
    } catch {
      // No file yet: the normal first-run state, and the state in which the
      // next signup becomes the owner.
      return;
    }
    try {
      const parsed = JSON.parse(text) as AccountsFile;
      for (const raw of parsed.accounts ?? []) {
        const a = sanitiseAccount(raw);
        if (a === null) continue;
        this.byKey.set(a.nameKey, a);
        this.byIdMap.set(a.id, a);
      }
    } catch {
      // A corrupt file is NOT treated as "no accounts": that would hand the
      // owner role to the next signup. Refuse to start from a broken file.
      throw new Error(`${ACCOUNTS_FILE} is present but unreadable`);
    }
  }

  /**
   * Serialise every mutation of this store.
   *
   * Not a per-account lock: the invariant being defended — "exactly one owner
   * is created" — is a fact about the WHOLE table, so a lock keyed on the name
   * being written would let two different names race to the same conclusion.
   */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  get size(): number { return this.byIdMap.size; }

  ownerCount(): number {
    let n = 0;
    for (const a of this.byIdMap.values()) if (a.role === 'owner') n++;
    return n;
  }

  byId(id: string): Account | null {
    return this.byIdMap.get(id) ?? null;
  }

  byName(name: string): Account | null {
    const key = nameKeyOf(name);
    return key === null ? null : this.byKey.get(key) ?? null;
  }

  roleOf(accountId: string | null | undefined): AccountRole | null {
    if (typeof accountId !== 'string') return null;
    return this.byIdMap.get(accountId)?.role ?? null;
  }

  /** Every owner's name, for the console and the transfer audit row. */
  owners(): string[] {
    const out: string[] = [];
    for (const a of this.byIdMap.values()) if (a.role === 'owner') out.push(a.name);
    return out.sort();
  }

  /**
   * Create an account. **The whole body is the critical section.**
   *
   * Read the header for why. In short: `ownerCount()` is read, `scrypt` is
   * awaited, and the role is written — and without the lock the two signups
   * that arrive in the same tick both read zero.
   */
  signup(name: unknown, passphrase: unknown, nowMs?: number): Promise<SignupResult> {
    const key = nameKeyOf(name);
    if (key === null) return Promise.resolve({ ok: false, error: 'bad-name' as const });
    if (!passphraseOk(passphrase)) return Promise.resolve({ ok: false, error: 'bad-passphrase' as const });
    return this.withLock(async () => {
      await this.ready();
      if (this.byKey.has(key)) return { ok: false as const, error: 'name-taken' as const };
      /* THE BOOTSTRAP DECISION. Read and write are both inside this lock. */
      const role: AccountRole = this.ownerCount() === 0 ? 'owner' : 'player';
      const salt = randomBytes(SALT_BYTES);
      const derived = await scrypt(passphrase as string, salt, this.params);
      const now = nowMs ?? this.clock();
      const account: Account = {
        id: `house:${randomBytes(12).toString('hex')}`,
        name: key,
        nameKey: key,
        passHash: derived.toString('hex'),
        salt: salt.toString('hex'),
        role,
        createdMs: now,
        lastSeenMs: now,
        deviceIds: [],
      };
      this.byKey.set(key, account);
      this.byIdMap.set(account.id, account);
      await this.persist();
      return { ok: true as const, account, bootstrapped: role === 'owner' };
    });
  }

  /**
   * Check a passphrase.
   *
   * An unknown name still pays for a hash, against a fixed decoy salt, so the
   * response time does not say whether the name exists. Without it this route
   * is a user enumerator with a stopwatch.
   */
  async signin(name: unknown, passphrase: unknown, nowMs?: number): Promise<SigninResult> {
    await this.ready();
    const key = nameKeyOf(name);
    const account = key === null ? null : this.byKey.get(key) ?? null;
    if (!passphraseOk(passphrase)) {
      if (account !== null) await scrypt('', Buffer.from(account.salt, 'hex'), this.params);
      return { ok: false, error: 'bad-credentials' };
    }
    if (account === null) {
      await scrypt(passphrase, DECOY_SALT, this.params);
      return { ok: false, error: 'bad-credentials' };
    }
    const derived = await scrypt(passphrase, Buffer.from(account.salt, 'hex'), this.params);
    const stored = Buffer.from(account.passHash, 'hex');
    if (derived.length !== stored.length || !timingSafeEqual(derived, stored)) {
      return { ok: false, error: 'bad-credentials' };
    }
    account.lastSeenMs = nowMs ?? this.clock();
    void this.withLock(() => this.persist());
    return { ok: true, account };
  }

  /**
   * Record that a device's profile now belongs to this account.
   *
   * The profile side of the link is `PersistenceStore.linkAccount`, called by
   * the route; this is the account's own list, so the console can say how many
   * devices an account has without opening every profile file. A MERGE of two
   * devices' progress is `docs/PLATFORM.md` §3 and is NOT this: a second device
   * simply links.
   */
  linkDevice(accountId: string, deviceId: string): Promise<boolean> {
    return this.withLock(async () => {
      await this.ready();
      const a = this.byIdMap.get(accountId);
      if (a === undefined) return false;
      if (a.deviceIds.includes(deviceId)) return true;
      a.deviceIds.push(deviceId);
      while (a.deviceIds.length > MAX_LINKED_DEVICES) a.deviceIds.shift();
      await this.persist();
      return true;
    });
  }

  /**
   * THE SAFETY NET for the bootstrap window.
   *
   * Between a deploy and the operator's first signup, anybody who finds the URL
   * can be the owner. This re-assigns the role and demotes every other owner,
   * and the route that calls it accepts ONLY the env bearer — so the credential
   * that fixes a hostile bootstrap is the one an attacker never had.
   *
   * Idempotent: naming the current owner leaves exactly one owner.
   */
  transferOwner(name: unknown): Promise<TransferResult> {
    const key = nameKeyOf(name);
    if (key === null) return Promise.resolve({ ok: false as const, error: 'no-such-account' as const });
    return this.withLock(async () => {
      await this.ready();
      const target = this.byKey.get(key);
      if (target === undefined) return { ok: false as const, error: 'no-such-account' as const };
      const demoted: string[] = [];
      for (const a of this.byIdMap.values()) {
        if (a.role !== 'owner' || a.id === target.id) continue;
        a.role = 'player';
        demoted.push(a.name);
      }
      target.role = 'owner';
      await this.persist();
      return { ok: true as const, owner: target, demoted: demoted.sort() };
    });
  }

  /** Force everything to disk. Called by the shutdown drain. */
  flush(): Promise<void> {
    return this.withLock(() => this.persist());
  }

  /**
   * Atomic write: temp file then rename, the same shape `JsonFileStore` uses.
   * A half-written accounts file is a host with no owner.
   */
  private async persist(): Promise<void> {
    const doc: AccountsFile = {
      version: ACCOUNTS_VERSION,
      accounts: [...this.byIdMap.values()],
    };
    const text = JSON.stringify(doc);
    try {
      await mkdir(this.root, { recursive: true });
      const tmp = `${this.root}/${ACCOUNTS_FILE}.tmp`;
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, `${this.root}/${ACCOUNTS_FILE}`);
      this.degraded = false;
    } catch {
      // Memory keeps working; the operator finds out from `degraded` on the
      // console rather than from a crash mid-signup.
      this.degraded = true;
    }
  }
}

/** A fixed salt for the "no such account" hash. Never used for a real account. */
const DECOY_SALT = Buffer.alloc(SALT_BYTES, 0x5a);

/**
 * Accept a record off disk, or reject it.
 *
 * A missing `role` is NOT defaulted to `owner`, and a record with no `passHash`
 * is dropped rather than loaded as an account nobody can sign in to but which
 * still counts against `ownerCount()`.
 */
function sanitiseAccount(raw: unknown): Account | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const key = nameKeyOf(r.nameKey ?? r.name);
  if (key === null) return null;
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  if (typeof r.passHash !== 'string' || !/^[0-9a-f]{64}$/.test(r.passHash)) return null;
  if (typeof r.salt !== 'string' || !/^[0-9a-f]{32}$/.test(r.salt)) return null;
  const role: AccountRole = r.role === 'owner' ? 'owner' : 'player';
  const devices = Array.isArray(r.deviceIds)
    ? r.deviceIds.filter((d): d is string => typeof d === 'string').slice(0, MAX_LINKED_DEVICES)
    : [];
  return {
    id: r.id,
    name: key,
    nameKey: key,
    passHash: r.passHash,
    salt: r.salt,
    role,
    createdMs: typeof r.createdMs === 'number' ? r.createdMs : 0,
    lastSeenMs: typeof r.lastSeenMs === 'number' ? r.lastSeenMs : 0,
    deviceIds: devices,
  };
}
