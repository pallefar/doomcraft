/**
 * DOOMCRAFT — the admin bearer.
 *
 * `docs/PACKS.md` §0.2 item 5 lists four defects in the check that used to be
 * inline in `index.ts`. Each one gets a test here that fails against that
 * version, because a hardening commit with no failing test behind it is a
 * hardening commit nobody can tell from a comment.
 *
 * The length oracle is the one that needs saying out loud: it cannot be proven
 * by timing in a unit test (a timing assertion is a flaky test wearing a
 * security hat), so it is proven STRUCTURALLY — the compare is fed two values
 * that are 1 and 10,000 characters long and must not throw, must not
 * short-circuit, and must answer false; and a source scan asserts the function
 * contains no length comparison to short-circuit on.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_FAILURE_LIMIT,
  ADMIN_FAILURE_WINDOW_MS,
  AdminGate,
  AdminVerdict,
  AttemptThrottle,
  bearerCredential,
  credentialMatches,
  type AdminDenial,
} from './adminAuth.js';

const TOKEN = 'a-token-that-is-long-enough-to-be-real';
const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------------ *
 * 1. The header
 * ------------------------------------------------------------------------ */

describe('the authorization header', () => {
  it('accepts the scheme in any case — RFC 7235 says it is case-insensitive', () => {
    expect(bearerCredential(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerCredential(`bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerCredential(`BEARER ${TOKEN}`)).toBe(TOKEN);
    expect(bearerCredential(`BeArEr ${TOKEN}`)).toBe(TOKEN);
  });

  it('requires the scheme — a bare token is not a credential', () => {
    // The old check fell back to the whole header value when it did not start
    // with a literal `Bearer `, so the server had two accepted spellings of a
    // secret, one of which no HTTP client produces.
    expect(bearerCredential(TOKEN)).toBeNull();
    expect(bearerCredential(`Basic ${TOKEN}`)).toBeNull();
    expect(bearerCredential('Bearer')).toBeNull();
    expect(bearerCredential('Bearer ')).toBeNull();
  });

  it('survives the shapes node can hand it', () => {
    expect(bearerCredential(undefined)).toBeNull();
    expect(bearerCredential([])).toBeNull();
    expect(bearerCredential([`Bearer ${TOKEN}`])).toBe(TOKEN);
    expect(bearerCredential(`  bearer\t${TOKEN}  `)).toBe(TOKEN);
  });
});

/* ------------------------------------------------------------------------ *
 * 2. The compare, and the oracle that is not there any more
 * ------------------------------------------------------------------------ */

describe('the credential compare', () => {
  it('answers false for a wrong token of ANY length, without throwing', () => {
    // `timingSafeEqual` throws on unequal buffer lengths. That throw is the
    // reason the old code tested lengths first, and testing lengths first is
    // the oracle. Hashing both sides removes both problems at once, and these
    // are the inputs that prove it: one character, and ten thousand.
    expect(credentialMatches('x', TOKEN)).toBe(false);
    expect(credentialMatches('x'.repeat(10_000), TOKEN)).toBe(false);
    expect(credentialMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(credentialMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(credentialMatches(TOKEN, TOKEN)).toBe(true);
  });

  it('has no length branch left to short-circuit on', () => {
    // Mechanical, in the `shared/src/trust.test.ts` style: a check that needs a
    // parser is a check that gets deleted the first time it is wrong. The claim
    // is about the SOURCE, so the source is what is read.
    const text = readFileSync(join(here, 'adminAuth.ts'), 'utf8');
    const body = text.slice(text.indexOf('export function credentialMatches'));
    const fn = body.slice(0, body.indexOf('\n}') + 2);
    expect(fn).toContain('timingSafeEqual');
    expect(fn).toContain('sha256');
    expect(fn, 'a length comparison is a length oracle').not.toMatch(/\.length\s*(!==|===|==|!=|<|>)/);
  });
});

/* ------------------------------------------------------------------------ *
 * 3. The gate
 * ------------------------------------------------------------------------ */

function gateWith(token: string, log: AdminDenial[] = []): { gate: AdminGate; log: AdminDenial[]; tick: (ms: number) => void } {
  let now = 1_000;
  const gate = new AdminGate(token, {
    clock: () => now,
    limit: 3,
    windowMs: 60_000,
    onDenied: (d) => { log.push(d); },
  });
  return { gate, log, tick: (ms: number) => { now += ms; } };
}

describe('AdminGate', () => {
  it('admits the right token and refuses everything else', () => {
    const { gate } = gateWith(TOKEN);
    expect(gate.admit(`Bearer ${TOKEN}`, '1.2.3.4')).toBe(AdminVerdict.OK);
    expect(gate.admit(`bearer ${TOKEN}`, '1.2.3.4')).toBe(AdminVerdict.OK);
    expect(gate.admit(TOKEN, '1.2.3.4')).toBe(AdminVerdict.DENIED);
    expect(gate.admit('Bearer nope', '1.2.3.4')).toBe(AdminVerdict.DENIED);
    expect(gate.admit(undefined, '1.2.3.4')).toBe(AdminVerdict.DENIED);
  });

  it('has no surface at all with no token configured', () => {
    const { gate } = gateWith('');
    expect(gate.configured).toBe(false);
    expect(gate.admit('Bearer anything', '1.2.3.4')).toBe(AdminVerdict.DENIED);
    // And it never throttles, so an unconfigured host answers every caller
    // identically forever and cannot be probed for a limiter.
    for (let i = 0; i < 50; i++) expect(gate.admit('Bearer x', '1.2.3.4')).toBe(AdminVerdict.DENIED);
    expect(gate.throttled).toBe(0);
  });

  it('logs every refusal, with a reason — there was no such line anywhere', () => {
    const { gate, log } = gateWith(TOKEN);
    gate.admit(undefined, '9.9.9.9', '/api/admin/drain');
    gate.admit('Bearer wrong', '9.9.9.9', '/api/admin/drain');
    gate.admit(`Bearer ${TOKEN}`, '9.9.9.9', '/api/admin/drain');
    expect(log.map((d) => d.reason)).toEqual(['no-credential', 'bad-token']);
    expect(log[0].client).toBe('9.9.9.9');
    expect(log[0].path).toBe('/api/admin/drain');
    // A success is the normal case and does not want a line.
    expect(log.length).toBe(2);
  });

  it('throttles a guessing client after its budget, and lets the window expire', () => {
    const { gate, tick } = gateWith(TOKEN);
    for (let i = 0; i < 3; i++) expect(gate.admit(`Bearer guess${i}`, '5.5.5.5')).toBe(AdminVerdict.DENIED);
    expect(gate.admit('Bearer guess4', '5.5.5.5')).toBe(AdminVerdict.THROTTLED);
    expect(gate.throttled).toBe(1);
    // Another address is unaffected: the key is the client, not the route.
    expect(gate.admit('Bearer guess4', '6.6.6.6')).toBe(AdminVerdict.DENIED);
    tick(60_001);
    expect(gate.admit('Bearer guess5', '5.5.5.5')).toBe(AdminVerdict.DENIED);
  });

  it('writes ONE denial line per throttled window, not one per request', () => {
    // A sustained brute force must not be able to turn the denial log into a
    // metered-disk attack: the counter is per request, the line is per window.
    const { gate, log, tick } = gateWith(TOKEN);
    for (let i = 0; i < 3; i++) gate.admit(`Bearer guess${i}`, '7.7.7.7');
    const before = log.length;                    // three 'bad-token' lines
    for (let i = 0; i < 50; i++) expect(gate.admit('Bearer still-guessing', '7.7.7.7')).toBe(AdminVerdict.THROTTLED);
    expect(gate.throttled).toBe(50);              // every request is counted…
    expect(log.length).toBe(before + 1);          // …and exactly one is written
    expect(log[log.length - 1]!.reason).toBe('throttled');
    tick(60_001);                                 // a new window logs again
    gate.admit('Bearer guess-later', '7.7.7.7');
    expect(log[log.length - 1]!.reason).toBe('bad-token');
  });

  it('never throttles a CORRECT token, whoever else is guessing from that address', () => {
    // The operator reaches for the drain switch exactly when somebody is
    // attacking. A limiter that locks them out then is a limiter that helps
    // the attacker.
    const { gate } = gateWith(TOKEN);
    for (let i = 0; i < 10; i++) gate.admit(`Bearer guess${i}`, '5.5.5.5');
    expect(gate.admit('Bearer guess-again', '5.5.5.5')).toBe(AdminVerdict.THROTTLED);
    expect(gate.admit(`Bearer ${TOKEN}`, '5.5.5.5')).toBe(AdminVerdict.OK);
    // And a success clears the history, so the next mistype is not a lockout.
    expect(gate.admit('Bearer guess-once-more', '5.5.5.5')).toBe(AdminVerdict.DENIED);
  });

  it('forgets expired buckets so a long-lived process does not grow one per address', () => {
    const { gate, tick } = gateWith(TOKEN);
    for (let i = 0; i < 20; i++) gate.admit('Bearer no', `10.0.0.${i}`);
    tick(60_001);
    expect(gate.sweep()).toBe(20);
    expect(gate.sweep()).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * 4. The second credential: an owner session
 *
 * All of this is unit-testable without booting a server, which is why the
 * session half was put INSIDE the gate rather than in a branch in `index.ts`.
 * `accountsRoutes.test.ts` proves the same facts over real HTTP against the
 * real binary; these prove them one at a time.
 * ------------------------------------------------------------------------ */

function sessionGate(token: string, roles: Record<string, 'owner' | 'player'>, owners = 1): {
  gate: AdminGate;
  log: AdminDenial[];
} {
  const log: AdminDenial[] = [];
  const gate = new AdminGate(token, {
    clock: () => 1_000,
    limit: 3,
    windowMs: 60_000,
    onDenied: (d) => { log.push(d); },
    resolveSession: (t) => (t in roles ? { accountId: `acct-${t}`, role: roles[t] } : null),
    ownerCount: () => owners,
  });
  return { gate, log };
}

describe('AdminGate with accounts behind it', () => {
  it('admits an owner session and says it was the owner that got in', () => {
    const { gate } = sessionGate(TOKEN, { 'sess-o': 'owner' });
    const d = gate.admitRequest({ sessionToken: 'sess-o' }, '1.2.3.4', '/api/admin/status');
    expect(d.verdict).toBe(AdminVerdict.OK);
    expect(d.via).toBe('owner');
    expect(d.accountId).toBe('acct-sess-o');
  });

  it('refuses a PLAYER session with 403, not 404 — and does not count it as a guess', () => {
    const { gate, log } = sessionGate(TOKEN, { 'sess-p': 'player' });
    const d = gate.admitRequest({ sessionToken: 'sess-p' }, '1.2.3.4', '/api/admin/status');
    expect(d.verdict).toBe(AdminVerdict.FORBIDDEN);
    expect(d.via).toBe('none');
    expect(log.map((x) => x.reason)).toEqual(['not-owner']);
    // A player loading the console twenty times must not lock their own
    // address out of it: the failure bucket is untouched.
    for (let i = 0; i < 20; i++) gate.admitRequest({ sessionToken: 'sess-p' }, '1.2.3.4');
    expect(gate.admitRequest({ sessionToken: 'sess-p' }, '1.2.3.4').verdict).toBe(AdminVerdict.FORBIDDEN);
    expect(gate.throttled).toBe(0);
  });

  it('keeps the env bearer as ROOT: it wins even beside a player session', () => {
    const { gate } = sessionGate(TOKEN, { 'sess-p': 'player' });
    const d = gate.admitRequest({ authorization: `Bearer ${TOKEN}`, sessionToken: 'sess-p' }, '1.2.3.4');
    expect(d.verdict).toBe(AdminVerdict.OK);
    expect(d.via).toBe('env');
  });

  it('reads the role LIVE, so a demoted owner stops being admitted', () => {
    const roles: Record<string, 'owner' | 'player'> = { 'sess-o': 'owner' };
    const { gate } = sessionGate(TOKEN, roles);
    expect(gate.admitRequest({ sessionToken: 'sess-o' }, '1.2.3.4').verdict).toBe(AdminVerdict.OK);
    roles['sess-o'] = 'player';
    expect(gate.admitRequest({ sessionToken: 'sess-o' }, '1.2.3.4').verdict).toBe(AdminVerdict.FORBIDDEN);
  });

  it('has a surface when there is an OWNER but no env token, and none when there is neither', () => {
    // The 404 is reserved for "no admin token AND no owner". A host with an
    // owner plainly has a console, and hiding its sign-in page locks the owner
    // out of their own box.
    const withOwner = sessionGate('', { 'sess-o': 'owner' }, 1).gate;
    expect(withOwner.configured).toBe(false);
    expect(withOwner.hasSurface).toBe(true);
    expect(withOwner.admitRequest({ sessionToken: 'sess-o' }, '1.2.3.4').verdict).toBe(AdminVerdict.OK);

    const bare = sessionGate('', {}, 0).gate;
    expect(bare.hasSurface).toBe(false);
    expect(bare.admitRequest({ sessionToken: 'nope' }, '1.2.3.4').verdict).toBe(AdminVerdict.DENIED);
  });

  it('refuses an OWNER SESSION on the env-only route — that is the whole safety net', () => {
    // `POST /api/admin/owner/transfer` exists because a stranger may have taken
    // the owner role during the bootstrap window. If their own session could
    // call it, they would simply transfer it back to themselves.
    const { gate } = sessionGate(TOKEN, { 'sess-o': 'owner' });
    expect(gate.admitEnvOnly(undefined, '1.2.3.4', '/api/admin/owner/transfer')).toBe(AdminVerdict.DENIED);
    expect(gate.admitEnvOnly(`Bearer ${TOKEN}`, '1.2.3.4')).toBe(AdminVerdict.OK);
  });

  it('does not count a refusal when asked not to — GET /admin is not a guess', () => {
    const { gate, log } = sessionGate(TOKEN, {}, 1);
    for (let i = 0; i < 10; i++) {
      expect(gate.admitRequest({}, '1.2.3.4', '/admin', { record: false }).verdict)
        .toBe(AdminVerdict.DENIED);
    }
    expect(log).toEqual([]);
    expect(gate.denied).toBe(0);
    // And the bucket is still CONSULTED, so a client that burned its budget on
    // /api/admin/* does not get a fresh page to guess from.
    for (let i = 0; i < 3; i++) gate.admitRequest({ authorization: 'Bearer no' }, '1.2.3.4');
    expect(gate.admitRequest({}, '1.2.3.4', '/admin', { record: false }).verdict)
      .toBe(AdminVerdict.THROTTLED);
  });
});

/* ------------------------------------------------------------------------ *
 * 5. The passphrase throttle
 * ------------------------------------------------------------------------ */

describe('AttemptThrottle', () => {
  it('refuses after the budget and forgets the window', () => {
    const t = new AttemptThrottle(3, 1000);
    for (let i = 0; i < 3; i++) { expect(t.allow('1.1.1.1', 0)).toBe(true); t.fail('1.1.1.1', 0); }
    expect(t.allow('1.1.1.1', 0)).toBe(false);
    expect(t.refused).toBe(1);
    // Another address is unaffected; the key is the client.
    expect(t.allow('2.2.2.2', 0)).toBe(true);
    expect(t.allow('1.1.1.1', 1001)).toBe(true);
  });

  it('clears a client on success, so a typo streak is not a lockout', () => {
    const t = new AttemptThrottle(3, 1000);
    for (let i = 0; i < 3; i++) t.fail('1.1.1.1', 0);
    expect(t.allow('1.1.1.1', 0)).toBe(false);
    t.clear('1.1.1.1');
    expect(t.allow('1.1.1.1', 0)).toBe(true);
  });

  it('sweeps expired buckets', () => {
    const t = new AttemptThrottle(3, 1000);
    for (let i = 0; i < 5; i++) t.fail(`10.0.0.${i}`, 0);
    expect(t.sweep(500)).toBe(0);
    expect(t.sweep(2000)).toBe(5);
  });

  it('uses the admin bearer numbers by default — 20 a minute', () => {
    const t = new AttemptThrottle();
    for (let i = 0; i < ADMIN_FAILURE_LIMIT; i++) { expect(t.allow('1.1.1.1', 0)).toBe(true); t.fail('1.1.1.1', 0); }
    expect(t.allow('1.1.1.1', 0), 'the 21st attempt in a minute must be refused').toBe(false);
    expect(t.allow('1.1.1.1', ADMIN_FAILURE_WINDOW_MS + 1)).toBe(true);
  });
});
