/**
 * DOOMCRAFT — the account routes, against the REAL binary over REAL HTTP.
 *
 * `accounts.test.ts` proves the store; `adminAuth.test.ts` proves the gate.
 * Neither proves the thing this repository keeps getting wrong: **code that
 * compiles, passes tests and is connected to nothing.** So this file spawns
 * `server/src/index.ts` as a child process with a fresh `DOOMCRAFT_DATA` and a
 * real `DOOMCRAFT_ADMIN_TOKEN`, and drives the whole flow over the wire.
 *
 * What is asserted, in the order it matters:
 *
 *   1. `GET /admin` with no credential is the SIGN-IN PAGE (200), and on a
 *      host with no owner it says "Create the owner account" — not a 404, which
 *      is reserved for a host with no admin surface at all.
 *   2. The FIRST `POST /api/auth/signup` answers `bootstrapped: true` and
 *      `role: 'owner'`; the second answers `player`.
 *   3. The owner's cookie renders the console; the player's cookie gets 403
 *      from `GET /admin` and from every `/api/admin/*`.
 *   4. The env bearer still reaches every admin route (the S4 contract).
 *   5. `POST /api/admin/owner/transfer` refuses an owner session and obeys the
 *      env bearer, leaving exactly one owner.
 *   6. **THE PASSHASH IS IN NO RESPONSE BODY.** The hash is read off
 *      `accounts-v1.json` on disk and every auth and admin body is scanned for
 *      it, along with the salt and the session token. This is the test that
 *      would have caught a route returning the record instead of
 *      `publicAccount(record)`.
 *   7. The 21st wrong sign-in inside a minute is a 429.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACCOUNTS_FILE, SESSION_COOKIE } from './accounts.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, 'index.ts');

const ADMIN_TOKEN = 'a-real-admin-token-thirty-two-plus-chars';
const OWNER_PASS = 'first-one-here-owns-the-box';
const PLAYER_PASS = 'second-one-here-is-a-player';

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      probe.close(() => done(port));
    });
  });
}

interface Booted {
  child: ChildProcess;
  origin: string;
  dataRoot: string;
}

async function boot(): Promise<Booted> {
  const port = await freePort();
  const staticRoot = mkdtempSync(join(tmpdir(), 'dc-acct-static-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'dc-acct-data-'));
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>x</title>', 'utf8');

  const child = spawn(process.execPath, ['--import', 'tsx', serverEntry], {
    cwd: join(here, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DOOMCRAFT_STATIC: staticRoot,
      DOOMCRAFT_DATA: dataRoot,
      DOOMCRAFT_BOTS: '0',
      DOOMCRAFT_PREWARM: '0',
      DOOMCRAFT_ADMIN_TOKEN: ADMIN_TOKEN,
    },
  });
  child.stdout?.resume();
  child.stderr?.resume();

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    if (Date.now() > deadline) throw new Error('server did not start');
    try {
      const res = await fetch(`${origin}/health`);
      if (res.ok) { await res.text(); break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, origin, dataRoot };
}

let server: Booted;

/** The `dc_sess` value out of a `set-cookie` header, or null. */
function sessionFrom(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  if (raw === null) return null;
  const m = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(raw);
  return m === null || m[1].length === 0 ? null : m[1];
}

interface Answer { status: number; text: string; json: Record<string, unknown> | null; cookie: string | null }

async function call(path: string, init: RequestInit = {}): Promise<Answer> {
  const res = await fetch(`${server.origin}${path}`, { ...init, redirect: 'manual' });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = null; }
  return { status: res.status, text, json, cookie: sessionFrom(res) };
}

function asCookie(token: string): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

function jsonPost(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

/** Every account record on disk, for the leak scan. */
function diskAccounts(): Array<{ passHash: string; salt: string; name: string; role: string }> {
  const text = readFileSync(join(server.dataRoot, ACCOUNTS_FILE), 'utf8');
  return (JSON.parse(text) as { accounts: Array<{ passHash: string; salt: string; name: string; role: string }> }).accounts;
}

let ownerSession = '';
let playerSession = '';

beforeAll(async () => {
  server = await boot();
}, 60_000);

afterAll(async () => {
  if (server?.child && server.child.exitCode === null) {
    server.child.kill('SIGKILL');
    await new Promise<void>((done) => { server.child.once('exit', () => done()); });
  }
});

/* ------------------------------------------------------------------------ *
 * 1. The console before anybody owns it
 * ------------------------------------------------------------------------ */

describe('GET /admin before there is an owner', () => {
  it('serves the sign-in page, and it offers to CREATE the owner account', async () => {
    const r = await call('/admin');
    expect(r.status, 'the sign-in page must not be a 404').toBe(200);
    expect(r.text).toContain('Create the owner account');
    expect(r.text).toContain('the first account created becomes the owner');
    // It is a page, not the console: no fleet table, no bearer box.
    expect(r.text).not.toContain('id="tab-fleet"');
    // And it is a page the CSP can carry: nonce-stamped, no inline handlers.
    expect(r.text).toMatch(/<script nonce="[^"]+">/);
    expect(r.text).not.toMatch(/\son[a-z]+="/);
    expect(r.text).not.toContain('<form');
  });

  it('is not cached and not indexed', async () => {
    const res = await fetch(`${server.origin}/admin`);
    await res.text();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('answers 401 on /api/auth/me with no session', async () => {
    const r = await call('/api/auth/me');
    expect(r.status).toBe(401);
  });
});

/* ------------------------------------------------------------------------ *
 * 2. The bootstrap
 * ------------------------------------------------------------------------ */

describe('POST /api/auth/signup', () => {
  it('makes the FIRST account the owner, and says so', async () => {
    const r = await call('/api/auth/signup', jsonPost({ name: 'karsten', passphrase: OWNER_PASS }));
    expect(r.status).toBe(201);
    expect(r.json?.bootstrapped, 'the first signup did not claim the owner role').toBe(true);
    expect((r.json?.account as Record<string, unknown>).role).toBe('owner');
    expect((r.json?.account as Record<string, unknown>).name).toBe('karsten');
    expect(r.cookie, 'no session cookie was set').not.toBeNull();
    ownerSession = r.cookie ?? '';

    const raw = (await fetch(`${server.origin}/api/auth/signup`, jsonPost({ name: 'x', passphrase: 'y' })));
    await raw.text();
  });

  it('sets the cookie httpOnly, Secure and SameSite=Lax', async () => {
    const res = await fetch(`${server.origin}/api/auth/signin`, jsonPost({ name: 'karsten', passphrase: OWNER_PASS }));
    await res.text();
    const raw = res.headers.get('set-cookie') ?? '';
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Secure');
    expect(raw).toContain('SameSite=Lax');
  });

  it('makes the SECOND account a player', async () => {
    const r = await call('/api/auth/signup', jsonPost({ name: 'stranger', passphrase: PLAYER_PASS }));
    expect(r.status).toBe(201);
    expect(r.json?.bootstrapped).toBe(false);
    expect((r.json?.account as Record<string, unknown>).role).toBe('player');
    playerSession = r.cookie ?? '';
    expect(playerSession.length).toBeGreaterThan(0);
  });

  it('refuses a duplicate name, a short passphrase and a bad name', async () => {
    expect((await call('/api/auth/signup', jsonPost({ name: 'karsten', passphrase: OWNER_PASS }))).status).toBe(409);
    expect((await call('/api/auth/signup', jsonPost({ name: 'newperson', passphrase: 'short' }))).status).toBe(400);
    expect((await call('/api/auth/signup', jsonPost({ name: 'no', passphrase: OWNER_PASS }))).status).toBe(400);
  });

  it('links a supplied deviceId, so the progress this browser earned follows the account', async () => {
    const device = 'device-linktest-01';
    // Give the device a profile first, the way a real player would have one.
    await (await fetch(`${server.origin}/api/profile?device=${device}`)).text();
    const r = await call('/api/auth/signup', jsonPost({ name: 'linker', passphrase: OWNER_PASS, deviceId: device }));
    expect(r.status).toBe(201);
    expect(r.json?.linkedDevice, 'the deviceId was not linked').toBe(true);
    const account = diskAccounts().find((a) => a.name === 'linker');
    expect(account).toBeTruthy();
  });
});

/* ------------------------------------------------------------------------ *
 * 3. Sign in, sign out, me
 * ------------------------------------------------------------------------ */

describe('the session', () => {
  it('answers /api/auth/me with the account, by cookie AND by bearer', async () => {
    const byCookie = await call('/api/auth/me', { headers: asCookie(ownerSession) });
    expect(byCookie.status).toBe(200);
    expect((byCookie.json?.account as Record<string, unknown>).role).toBe('owner');

    const byBearer = await call('/api/auth/me', { headers: { authorization: `Bearer ${ownerSession}` } });
    expect(byBearer.status).toBe(200);
  });

  it('refuses a wrong passphrase with 401 and the same words as a wrong name', async () => {
    const wrongPass = await call('/api/auth/signin', jsonPost({ name: 'karsten', passphrase: 'nope-nope-nope' }));
    const wrongName = await call('/api/auth/signin', jsonPost({ name: 'nobody', passphrase: 'nope-nope-nope' }));
    expect(wrongPass.status).toBe(401);
    expect(wrongName.status).toBe(401);
    expect(wrongPass.json?.error).toBe(wrongName.json?.error);
  });

  it('signs out: the session stops resolving and the cookie is expired', async () => {
    const made = await call('/api/auth/signin', jsonPost({ name: 'stranger', passphrase: PLAYER_PASS }));
    const token = made.cookie ?? '';
    expect((await call('/api/auth/me', { headers: asCookie(token) })).status).toBe(200);
    const out = await call('/api/auth/signout', jsonPost({}, asCookie(token)));
    expect(out.status).toBe(200);
    expect(out.json?.revoked).toBe(true);
    expect((await call('/api/auth/me', { headers: asCookie(token) })).status).toBe(401);
  });
});

/* ------------------------------------------------------------------------ *
 * 4. The gate, over the wire
 * ------------------------------------------------------------------------ */

describe('the admin gate takes either credential', () => {
  it('renders the CONSOLE for an owner session', async () => {
    expect(ownerSession.length, 'no owner session — this test would pass vacuously').toBeGreaterThan(0);
    const r = await call('/admin', { headers: asCookie(ownerSession) });
    expect(r.status).toBe(200);
    expect(r.text).toContain('id="tab-fleet"');
    expect(r.text).not.toContain('Create the owner account');
  });

  it('answers 403 for a PLAYER session, on /admin and on every /api/admin/*', async () => {
    expect(playerSession.length, 'no player session — this test would pass vacuously').toBeGreaterThan(0);
    const page = await call('/admin', { headers: asCookie(playerSession) });
    expect(page.status, 'a signed-in player reached the console').toBe(403);

    for (const path of [
      '/api/admin/whoami', '/api/admin/status', '/api/admin/flags',
      '/api/admin/entitlement', '/api/admin/audit', '/api/admin/journal?player=device-aaaaaaaa',
      '/api/admin/player?key=device-aaaaaaaa',
    ]) {
      const r = await call(path, { headers: asCookie(playerSession) });
      expect(r.status, `${path} admitted a player session`).toBe(403);
    }
  });

  it('lets an OWNER session read every admin route', async () => {
    for (const path of ['/api/admin/whoami', '/api/admin/status', '/api/admin/flags', '/api/admin/entitlement', '/api/admin/audit']) {
      const r = await call(path, { headers: asCookie(ownerSession) });
      expect(r.status, `${path} refused the owner`).toBe(200);
    }
    const who = await call('/api/admin/whoami', { headers: asCookie(ownerSession) });
    const identity = who.json?.identity as Record<string, unknown>;
    expect(identity.via).toBe('owner');
    expect((identity.account as Record<string, unknown>).name).toBe('karsten');
    expect(identity.sessionsSurviveRestart).toBe(false);
  });

  it('keeps the ENV BEARER working on every admin route — the S4 contract', async () => {
    for (const path of ['/api/admin/whoami', '/api/admin/status', '/api/admin/flags', '/api/admin/entitlement', '/api/admin/audit']) {
      const r = await call(path, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
      expect(r.status, `${path} refused the env bearer`).toBe(200);
    }
    const who = await call('/api/admin/whoami', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect((who.json?.identity as Record<string, unknown>).via).toBe('env');
  });

  it('still answers 404 to an anonymous caller on /api/admin/*', async () => {
    expect((await call('/api/admin/status')).status).toBe(404);
    expect((await call('/api/admin/status', { headers: { authorization: 'Bearer wrong' } })).status).toBe(404);
  });
});

/* ------------------------------------------------------------------------ *
 * 5. Owner transfer
 * ------------------------------------------------------------------------ */

describe('POST /api/admin/owner/transfer', () => {
  it('refuses an OWNER SESSION — the env bearer is the only key', async () => {
    /* Guard against a green-because-empty run: this file is one sequential
       flow and `ownerSession` is filled by the signup test above. Filter this
       file with `-t` and the cookie below would be empty, the server would
       answer 404 for the wrong reason, and the test would pass having proven
       nothing. */
    expect(ownerSession.length, 'no owner session — this test would pass vacuously').toBeGreaterThan(0);
    const r = await call('/api/admin/owner/transfer', jsonPost(
      { name: 'stranger', actor: 'tester', reason: 'trying it from a session' },
      asCookie(ownerSession),
    ));
    expect(r.status, 'an owner session moved the owner role').toBe(404);
  });

  it('refuses an anonymous caller', async () => {
    const r = await call('/api/admin/owner/transfer', jsonPost({ name: 'stranger', actor: 'x', reason: 'anonymous attempt' }));
    expect(r.status).toBe(404);
  });

  it('demands an actor and a reason even with the bearer', async () => {
    const r = await call('/api/admin/owner/transfer', jsonPost(
      { name: 'stranger' },
      { authorization: `Bearer ${ADMIN_TOKEN}` },
    ));
    expect(r.status).toBe(400);
  });

  it('moves the role with the env bearer and leaves EXACTLY ONE owner', async () => {
    const r = await call('/api/admin/owner/transfer', jsonPost(
      { name: 'stranger', actor: 'tester', reason: 'reclaiming after a hostile bootstrap' },
      { authorization: `Bearer ${ADMIN_TOKEN}` },
    ));
    expect(r.status).toBe(200);
    expect((r.json?.owner as Record<string, unknown>).name).toBe('stranger');
    expect(r.json?.owners).toEqual(['stranger']);
    expect(diskAccounts().filter((a) => a.role === 'owner').map((a) => a.name)).toEqual(['stranger']);

    // The demoted owner's OPEN session starts answering 403 on its next call:
    // the role is read live, so nothing has to hunt down the token.
    expect((await call('/api/admin/status', { headers: asCookie(ownerSession) })).status).toBe(403);

    // And it wrote an audit row, like every other mutation.
    const audit = await call('/api/admin/audit?limit=20', { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    const rows = audit.json?.rows as Array<Record<string, unknown>>;
    expect(rows.some((x) => x.verb === 'owner.transfer' && x.subject === 'stranger')).toBe(true);

    // Put it back, so the leak scan below runs against the owner it started with.
    const back = await call('/api/admin/owner/transfer', jsonPost(
      { name: 'karsten', actor: 'tester', reason: 'restoring the original owner' },
      { authorization: `Bearer ${ADMIN_TOKEN}` },
    ));
    expect(back.status).toBe(200);
    expect(back.json?.owners).toEqual(['karsten']);
  });
});

/* ------------------------------------------------------------------------ *
 * 6. THE LEAK SCAN
 * ------------------------------------------------------------------------ */

describe('no secret is ever in a response body', () => {
  it('never puts a passHash, a salt or a session token in ANY auth or admin body', async () => {
    const secrets: Array<{ what: string; value: string }> = [];
    for (const a of diskAccounts()) {
      secrets.push({ what: `${a.name}.passHash`, value: a.passHash });
      secrets.push({ what: `${a.name}.salt`, value: a.salt });
    }
    secrets.push({ what: 'the owner session token', value: ownerSession });
    secrets.push({ what: 'the owner passphrase', value: OWNER_PASS });
    expect(secrets.length).toBeGreaterThan(4);

    const bearer = { authorization: `Bearer ${ADMIN_TOKEN}` };
    const bodies: Array<{ path: string; text: string }> = [];
    const reads = [
      '/api/auth/me',
      '/api/admin/whoami', '/api/admin/status', '/api/admin/flags', '/api/admin/entitlement',
      '/api/admin/audit?limit=200', '/api/admin/player?key=device-linktest-01',
      '/api/admin/journal?player=device-linktest-01',
    ];
    for (const path of reads) {
      bodies.push({ path, text: (await call(path, { headers: { ...bearer, ...asCookie(ownerSession) } })).text });
    }
    // The write paths too, refusals included: an error body is a body.
    bodies.push({ path: 'signin ok', text: (await call('/api/auth/signin', jsonPost({ name: 'karsten', passphrase: OWNER_PASS }))).text });
    bodies.push({ path: 'signin bad', text: (await call('/api/auth/signin', jsonPost({ name: 'karsten', passphrase: 'wrong-wrong-wrong' }))).text });
    bodies.push({ path: 'signup dup', text: (await call('/api/auth/signup', jsonPost({ name: 'karsten', passphrase: OWNER_PASS }))).text });
    bodies.push({ path: 'signout', text: (await call('/api/auth/signout', jsonPost({}, asCookie('not-a-real-token')))).text });
    bodies.push({ path: 'me anon', text: (await call('/api/auth/me')).text });

    const offenders: string[] = [];
    for (const body of bodies) {
      for (const s of secrets) {
        if (s.value.length > 0 && body.text.includes(s.value)) offenders.push(`${body.path} leaked ${s.what}`);
      }
    }
    expect(offenders, 'a secret reached an HTTP response body').toEqual([]);
    // The scan is only worth anything if it CAN see: prove it finds a value
    // that really is in one of those bodies.
    const control = bodies.find((b) => b.path === '/api/auth/me');
    expect(control?.text).toContain('karsten');
  });

  it('never puts a session token in the console document either', async () => {
    const page = await call('/admin', { headers: asCookie(ownerSession) });
    expect(page.text).not.toContain(ownerSession);
    expect(page.text).not.toContain(ADMIN_TOKEN);
  });
});

/* ------------------------------------------------------------------------ *
 * 7. The throttle
 * ------------------------------------------------------------------------ */

describe('the sign-in throttle', () => {
  it('answers 429 after the budget, with a retry-after', async () => {
    // The gate's numbers: 20 failures per client address per minute, so the
    // 21st attempt inside the window is refused before it hashes.
    //
    // A SUCCESS FIRST, deliberately: every test above ran against the same
    // client address (127.0.0.1) and left failures in the bucket, and a
    // success clears it. Without this line the count below is a function of
    // how many refusals the rest of the file happened to make — which is a
    // test that passes for a reason nobody can state.
    const cleared = await call('/api/auth/signin', jsonPost({ name: 'karsten', passphrase: OWNER_PASS }));
    expect(cleared.status).toBe(200);

    let sawThrottle = false;
    let attempts = 0;
    for (let i = 0; i < 30; i++) {
      attempts++;
      const res = await fetch(`${server.origin}/api/auth/signin`, jsonPost({ name: 'karsten', passphrase: `wrong-${i}-aaaa` }));
      await res.text();
      if (res.status === 429) {
        sawThrottle = true;
        expect(res.headers.get('retry-after')).toBe('60');
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(sawThrottle, 'twenty wrong passphrases in a row were never throttled').toBe(true);
    expect(attempts).toBe(21);
  }, 60_000);
});

describe('cross-site writes', () => {
  it('refuses a text/plain form POST to signup, so a stranger cannot claim the owner by CSRF', async () => {
    // A <form enctype="text/plain"> on any site can reach this URL with a
    // JSON-looking body. Before the fix it was a 201 and, on a virgin host, the
    // owner role. The route must demand application/json.
    const r = await call('/api/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example.com' },
      body: JSON.stringify({ name: 'csrfmade', passphrase: 'twelve-chars-long-ok' }),
    });
    expect([403, 415]).toContain(r.status);
    expect(diskAccounts().some((a) => a.name === 'csrfmade')).toBe(false);
  });
});
