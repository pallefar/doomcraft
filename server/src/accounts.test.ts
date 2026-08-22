/**
 * DOOMCRAFT — the account store, and the one test this stage exists for.
 *
 * ## The mandatory one
 *
 * **"Two concurrent signups yield exactly one owner."** It is mandatory because
 * the rule it defends — first signup becomes the owner — is a read
 * (`ownerCount() === 0`) followed by a write (`role = 'owner'`) with an
 * `await scrypt(...)` sitting between them. Every naive implementation of that
 * rule is wrong, and wrong in a way no single-request test can see: the two
 * requests each answer 201, each say `bootstrapped: true`, and the host ends up
 * with two owners and no way to tell which was meant.
 *
 * The test drives both `signup()` promises IN THE SAME TICK with
 * `Promise.all`, so the interleaving is not a matter of timing luck. Delete the
 * `withLock` wrapper in `AccountStore.signup` and it goes red with
 * `expected 2 to be 1` — that was run, and the failure is pasted in the commit
 * message's report.
 *
 * ## The rest, and why each one can fail
 *
 * - Roles: first owner, second player. Fails if the count is read from the
 *   wrong side of the write.
 * - Round-trip: a SECOND `AccountStore` over the same directory can still sign
 *   the account in. Fails if the hash or the salt is not persisted, or if the
 *   file is written non-atomically and truncated.
 * - No secret in the public shape. Fails the moment somebody returns the
 *   record instead of `publicAccount(record)`.
 * - Transfer leaves exactly one owner, and is idempotent.
 * - Sessions expire, slide, and are revocable.
 *
 * Every test that does not measure the hash itself passes a cheap `scrypt`
 * cost, because 2^15 is ~100 ms and a suite that takes a minute is a suite
 * people stop running. `uses the real scrypt parameters by default` is the one
 * that pins the shipped cost, and it uses the default.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ACCOUNTS_FILE,
  AccountStore,
  DEFAULT_SCRYPT,
  PASSPHRASE_MIN,
  SESSION_COOKIE,
  SessionTable,
  cookieValue,
  expiredSessionCookie,
  nameKeyOf,
  publicAccount,
  sessionCookie,
  sessionCredential,
  type ScryptParams,
} from './accounts.js';

/** Cheap, for tests that are about the LOGIC and not about the cost factor. */
const CHEAP: ScryptParams = Object.freeze({ N: 16, r: 8, p: 1, keyLen: 32 });
const PASS = 'correct-horse-battery-staple';

const roots: string[] = [];
function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dc-accounts-'));
  roots.push(dir);
  return dir;
}
function storeAt(root: string): AccountStore {
  return new AccountStore(root, { scrypt: CHEAP });
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------ *
 * 1. The bootstrap rule
 * ------------------------------------------------------------------------ */

describe('first signup becomes the owner', () => {
  it('gives the owner role to the first account and player to the second', async () => {
    const s = storeAt(freshRoot());
    const first = await s.signup('alice', PASS);
    const second = await s.signup('bob', PASS);
    expect(first.ok && first.account.role).toBe('owner');
    expect(first.ok && first.bootstrapped).toBe(true);
    expect(second.ok && second.account.role).toBe('player');
    expect(second.ok && second.bootstrapped).toBe(false);
    expect(s.ownerCount()).toBe(1);
  });

  /**
   * THE MANDATORY ONE. See the header.
   *
   * Both promises are created before either is awaited, so both are in flight
   * across the `await scrypt(...)` inside `signup`. Without the store's write
   * lock both read `ownerCount() === 0` and both write `owner`.
   */
  it('yields EXACTLY ONE owner when two signups race in the same tick', async () => {
    const s = storeAt(freshRoot());
    const [a, b] = await Promise.all([s.signup('alice', PASS), s.signup('bob', PASS)]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const roles = [a.ok ? a.account.role : 'x', b.ok ? b.account.role : 'x'].sort();
    expect(roles, 'two concurrent signups both claimed the owner role').toEqual(['owner', 'player']);
    expect(s.ownerCount(), 'the host has more than one owner').toBe(1);
    // And the claim is reported honestly to exactly one of them.
    const claimed = [a.ok && a.bootstrapped, b.ok && b.bootstrapped].filter(Boolean).length;
    expect(claimed).toBe(1);
  });

  it('still yields one owner when EIGHT signups race', async () => {
    const s = storeAt(freshRoot());
    const names = ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff', 'ggg', 'hhh'];
    const out = await Promise.all(names.map((n) => s.signup(n, PASS)));
    expect(out.every((r) => r.ok)).toBe(true);
    expect(s.ownerCount()).toBe(1);
    expect(s.size).toBe(8);
  });

  it('refuses a duplicate name, including one racing for the same name', async () => {
    const s = storeAt(freshRoot());
    const [a, b] = await Promise.all([s.signup('alice', PASS), s.signup('ALICE', PASS)]);
    const errors = [a.ok ? null : a.error, b.ok ? null : b.error];
    expect(errors.filter((e) => e === 'name-taken').length).toBe(1);
    expect(s.size).toBe(1);
  });
});

/* ------------------------------------------------------------------------ *
 * 2. Names and passphrases
 * ------------------------------------------------------------------------ */

describe('validation', () => {
  it('normalises a name to lowercase and refuses everything outside the alphabet', () => {
    expect(nameKeyOf('Alice')).toBe('alice');
    expect(nameKeyOf('  Alice  ')).toBe('alice');
    expect(nameKeyOf('a-b_9')).toBe('a-b_9');
    expect(nameKeyOf('ab')).toBeNull();
    expect(nameKeyOf('a'.repeat(33))).toBeNull();
    expect(nameKeyOf('has space')).toBeNull();
    expect(nameKeyOf('bobby@example.com')).toBeNull();
    expect(nameKeyOf(42)).toBeNull();
  });

  it('refuses a short passphrase before it touches the store', async () => {
    const s = storeAt(freshRoot());
    const bad = await s.signup('alice', 'x'.repeat(PASSPHRASE_MIN - 1));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toBe('bad-passphrase');
    expect(s.size).toBe(0);
  });

  it('uses the real scrypt parameters by default — the shipped cost, pinned', () => {
    expect(DEFAULT_SCRYPT.N).toBe(32768);
    expect(DEFAULT_SCRYPT.r).toBe(8);
    expect(DEFAULT_SCRYPT.p).toBe(1);
    expect(DEFAULT_SCRYPT.keyLen).toBe(32);
  });

  it('really does hash with the default parameters end to end', async () => {
    // One account at the shipped cost, so "the default is 2^15" is not just an
    // assertion about a frozen object nobody passes to scrypt.
    const s = new AccountStore(freshRoot());
    const made = await s.signup('alice', PASS);
    expect(made.ok).toBe(true);
    expect((await s.signin('alice', PASS)).ok).toBe(true);
    expect((await s.signin('alice', `${PASS}!`)).ok).toBe(false);
  }, 30_000);
});

/* ------------------------------------------------------------------------ *
 * 3. Sign-in
 * ------------------------------------------------------------------------ */

describe('signin', () => {
  it('accepts the right passphrase and refuses a wrong one', async () => {
    const s = storeAt(freshRoot());
    await s.signup('alice', PASS);
    expect((await s.signin('alice', PASS)).ok).toBe(true);
    expect((await s.signin('Alice', PASS)).ok).toBe(true);
    const wrong = await s.signin('alice', 'not-the-passphrase');
    expect(wrong.ok).toBe(false);
    expect(!wrong.ok && wrong.error).toBe('bad-credentials');
  });

  it('answers an unknown name with the SAME error as a wrong passphrase', async () => {
    // Not cosmetic: a distinguishable answer is a user enumerator.
    const s = storeAt(freshRoot());
    await s.signup('alice', PASS);
    const unknown = await s.signin('nobody', PASS);
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.error).toBe('bad-credentials');
  });

  it('ROUND-TRIPS THROUGH A RESTART — a second store over the same directory', async () => {
    const root = freshRoot();
    const first = storeAt(root);
    const made = await first.signup('alice', PASS);
    expect(made.ok && made.account.role).toBe('owner');

    const second = storeAt(root);
    const back = await second.signin('alice', PASS);
    expect(back.ok, 'the account did not survive the restart').toBe(true);
    expect(back.ok && back.account.role).toBe('owner');
    expect(second.ownerCount()).toBe(1);

    // And the next signup on the restarted store is NOT handed the owner role.
    const later = await second.signup('bob', PASS);
    expect(later.ok && later.account.role).toBe('player');
  });

  it('refuses to start from a corrupt accounts file rather than re-bootstrapping', async () => {
    // The dangerous failure mode: an unreadable file treated as "no accounts"
    // hands the owner role to whoever signs up next.
    const root = freshRoot();
    const first = storeAt(root);
    await first.signup('alice', PASS);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(root, ACCOUNTS_FILE), '{ this is not json', 'utf8');
    const second = storeAt(root);
    await expect(second.signup('mallory', PASS)).rejects.toThrow(/unreadable/);
  });
});

/* ------------------------------------------------------------------------ *
 * 4. Nothing secret leaves
 * ------------------------------------------------------------------------ */

describe('the public shape', () => {
  it('carries the id, the name and the role — and NOTHING else', async () => {
    const s = storeAt(freshRoot());
    const made = await s.signup('alice', PASS);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const pub = publicAccount(made.account);
    expect(Object.keys(pub).sort()).toEqual(['id', 'name', 'role']);
    const json = JSON.stringify(pub);
    expect(json).not.toContain(made.account.passHash);
    expect(json).not.toContain(made.account.salt);
  });

  it('writes the hash to disk and the passphrase nowhere', async () => {
    const root = freshRoot();
    const s = storeAt(root);
    const made = await s.signup('alice', PASS);
    expect(made.ok).toBe(true);
    const text = readFileSync(join(root, ACCOUNTS_FILE), 'utf8');
    expect(text, 'the passphrase itself is on disk').not.toContain(PASS);
    expect(text).toContain(made.ok ? made.account.passHash : 'never');
  });
});

/* ------------------------------------------------------------------------ *
 * 5. Owner transfer
 * ------------------------------------------------------------------------ */

describe('transferOwner', () => {
  it('moves the role and demotes every other owner', async () => {
    const s = storeAt(freshRoot());
    await s.signup('alice', PASS);
    await s.signup('bob', PASS);
    const out = await s.transferOwner('bob');
    expect(out.ok).toBe(true);
    expect(out.ok && out.owner.name).toBe('bob');
    expect(out.ok && out.demoted).toEqual(['alice']);
    expect(s.ownerCount()).toBe(1);
    expect(s.byName('alice')?.role).toBe('player');
  });

  it('is idempotent — naming the current owner still leaves one owner', async () => {
    const s = storeAt(freshRoot());
    await s.signup('alice', PASS);
    const out = await s.transferOwner('alice');
    expect(out.ok && out.demoted).toEqual([]);
    expect(s.ownerCount()).toBe(1);
  });

  it('refuses a name nobody has', async () => {
    const s = storeAt(freshRoot());
    await s.signup('alice', PASS);
    const out = await s.transferOwner('nobody');
    expect(out.ok).toBe(false);
    expect(s.ownerCount()).toBe(1);
    expect(s.byName('alice')?.role).toBe('owner');
  });

  it('survives a restart', async () => {
    const root = freshRoot();
    const s = storeAt(root);
    await s.signup('alice', PASS);
    await s.signup('bob', PASS);
    await s.transferOwner('bob');
    const again = storeAt(root);
    await again.ready();
    expect(again.owners()).toEqual(['bob']);
  });
});

/* ------------------------------------------------------------------------ *
 * 6. Devices
 * ------------------------------------------------------------------------ */

describe('linkDevice', () => {
  it('records a device once and caps the list', async () => {
    const s = storeAt(freshRoot());
    const made = await s.signup('alice', PASS);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    await s.linkDevice(made.account.id, 'device-aaaaaaaa');
    await s.linkDevice(made.account.id, 'device-aaaaaaaa');
    expect(s.byId(made.account.id)?.deviceIds).toEqual(['device-aaaaaaaa']);
    for (let i = 0; i < 12; i++) await s.linkDevice(made.account.id, `device-${i}0000000`);
    expect(s.byId(made.account.id)?.deviceIds.length).toBe(8);
  });

  it('says no for an account that does not exist', async () => {
    const s = storeAt(freshRoot());
    expect(await s.linkDevice('house:nope', 'device-aaaaaaaa')).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * 7. Sessions and the cookie
 * ------------------------------------------------------------------------ */

describe('SessionTable', () => {
  it('mints a 256-bit token and resolves it', () => {
    const t = new SessionTable(1000);
    const token = t.mint('house:1', 0);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(t.resolve(token, 0)?.accountId).toBe('house:1');
    expect(t.resolve('nope', 0)).toBeNull();
    expect(t.resolve(undefined, 0)).toBeNull();
  });

  it('slides the expiry on use, and expires when it is not used', () => {
    const t = new SessionTable(1000);
    const token = t.mint('house:1', 0);
    expect(t.resolve(token, 900)).not.toBeNull();   // slides to 1900
    expect(t.resolve(token, 1500)).not.toBeNull();  // would have been dead at 1000
    expect(t.resolve(token, 5000)).toBeNull();
    expect(t.size).toBe(0);
  });

  it('revokes one session and every session of an account', () => {
    const t = new SessionTable(1000);
    const a = t.mint('house:1', 0);
    const b = t.mint('house:1', 0);
    const c = t.mint('house:2', 0);
    expect(t.revoke(a)).toBe(true);
    expect(t.revoke(a)).toBe(false);
    expect(t.revokeAllFor('house:1')).toBe(1);
    expect(t.resolve(b, 0)).toBeNull();
    expect(t.resolve(c, 0)).not.toBeNull();
  });

  it('sweeps expired rows so a long-lived process does not grow one per sign-in', () => {
    const t = new SessionTable(1000);
    for (let i = 0; i < 10; i++) t.mint(`house:${i}`, 0);
    expect(t.sweep(500)).toBe(0);
    expect(t.sweep(2000)).toBe(10);
    expect(t.size).toBe(0);
  });
});

describe('the cookie', () => {
  it('is httpOnly, Secure, SameSite=Lax and path-wide', () => {
    const c = sessionCookie('abc', 60_000);
    expect(c.startsWith(`${SESSION_COOKIE}=abc;`)).toBe(true);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('Secure');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
    expect(c).toContain('Max-Age=60');
  });

  it('expires with the same attributes, so the browser matches and drops it', () => {
    const c = expiredSessionCookie();
    expect(c).toContain('Max-Age=0');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
  });

  it('reads one cookie out of a header full of them', () => {
    expect(cookieValue('a=1; dc_sess=tok; b=2', SESSION_COOKIE)).toBe('tok');
    expect(cookieValue('dc_sess=tok', SESSION_COOKIE)).toBe('tok');
    expect(cookieValue('dc_sessx=tok', SESSION_COOKIE)).toBeNull();
    expect(cookieValue('dc_sess=', SESSION_COOKIE)).toBeNull();
    expect(cookieValue(undefined, SESSION_COOKIE)).toBeNull();
  });

  it('prefers the cookie and falls back to the bearer, so curl works too', () => {
    expect(sessionCredential({ cookie: 'dc_sess=fromcookie', authorization: 'Bearer frombearer' }))
      .toBe('fromcookie');
    expect(sessionCredential({ authorization: 'bearer frombearer' })).toBe('frombearer');
    expect(sessionCredential({ authorization: 'frombearer' })).toBeNull();
    expect(sessionCredential({})).toBeNull();
  });
});
