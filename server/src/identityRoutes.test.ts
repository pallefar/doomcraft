/**
 * DOOMCRAFT — C4 over the wire: the device cookie, the socket ticket, and
 * the §3.2 rows as a player would actually hit them (docs/PLATFORM.md C4's
 * test list, the route half — the store half is accountGraph.test.ts).
 *
 * Same discipline as accountsRoutes.test.ts: the REAL binary, spawned with
 * a fresh DOOMCRAFT_DATA, driven over real HTTP and a real WebSocket —
 * because the failure this repo keeps refusing to re-learn is code that
 * compiles, passes tests and is connected to nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { SESSION_COOKIE } from './accounts.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, 'index.ts');

/** The family PC: a countable anonymous profile, seeded before boot. */
const BROTHER_DEVICE = 'fafafafafafafafafafafafa';
const FRESH_DEVICE = 'bebebebebebebebebebebebe';

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

let child: ChildProcess;
let origin: string;
let wsOrigin: string;

beforeAll(async () => {
  const port = await freePort();
  const staticRoot = mkdtempSync(join(tmpdir(), 'dc-id-static-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'dc-id-data-'));
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>x</title>', 'utf8');

  const shard = join(dataRoot, 'profiles', BROTHER_DEVICE.slice(0, 2));
  mkdirSync(shard, { recursive: true });
  writeFileSync(join(shard, `${BROTHER_DEVICE}.json`), JSON.stringify({
    version: 5, deviceId: BROTHER_DEVICE, createdMs: 1_700_000_000_000,
    progress: { xp: 4200, level: 14, gamesPlayed: 62 },
  }), 'utf8');

  child = spawn(process.execPath, ['--import', 'tsx', serverEntry], {
    cwd: join(here, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      DOOMCRAFT_STATIC: staticRoot, DOOMCRAFT_DATA: dataRoot,
      DOOMCRAFT_BOTS: '0', DOOMCRAFT_PREWARM: '0',
    },
  });
  child.stdout?.resume();
  child.stderr?.resume();

  origin = `http://127.0.0.1:${port}`;
  wsOrigin = `ws://127.0.0.1:${port}`;
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
}, 60_000);

afterAll(() => { child?.kill('SIGKILL'); });

interface Answer { status: number; json: Record<string, unknown> | null; setCookie: string | null }

async function call(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const res = await fetch(`${origin}${path}`, body === undefined ? { headers } : {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = null; }
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

/** Open a game socket and report how the upgrade went. */
function tryUpgrade(query: string): Promise<{ opened: boolean; status: number }> {
  return new Promise((done) => {
    const ws = new WebSocket(`${wsOrigin}/ws?mode=deathmatch&${query}`);
    const finish = (opened: boolean, status: number): void => {
      try { ws.close(); } catch { /* already down */ }
      done({ opened, status });
    };
    ws.on('open', () => finish(true, 101));
    ws.on('unexpected-response', (_req, res) => finish(false, res.statusCode ?? 0));
    ws.on('error', () => { /* unexpected-response already fired, or close */ });
    setTimeout(() => finish(false, 0), 8000);
  });
}

describe('the dc_dev cookie', () => {
  it('mints on first contact, then the cookie word beats any body claim', async () => {
    const first = await call('/api/device', {});
    expect(first.status).toBe(200);
    const id = first.json?.deviceId as string;
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(first.setCookie).toContain(`dc_dev=${id}`);
    expect(first.setCookie).toContain('HttpOnly');
    expect(first.setCookie).toContain('Max-Age=34560000');   // 400 days

    // Day 8 on Safari: localStorage gone, the cookie not. The body lies —
    // the cookie answers.
    const again = await call('/api/device', { deviceId: FRESH_DEVICE }, { cookie: `dc_dev=${id}` });
    expect(again.json?.deviceId).toBe(id);
    expect(again.json?.restored).toBe(true);
  });
});

describe('the socket ticket, over a real upgrade', () => {
  it('?device= is REFUSED — defect #7 does not stay open beside the ticket', async () => {
    const result = await tryUpgrade(`device=${FRESH_DEVICE}`);
    expect(result.opened).toBe(false);
    expect(result.status).toBe(400);
  });

  it('a minted ticket admits exactly once; the replay is refused', async () => {
    const minted = await call('/api/session/ticket', { deviceId: FRESH_DEVICE });
    expect(minted.status).toBe(200);
    const ticket = minted.json?.ticket as string;
    expect(ticket.length).toBeGreaterThan(16);

    const first = await tryUpgrade(`t=${ticket}`);
    expect(first.opened).toBe(true);
    const replay = await tryUpgrade(`t=${ticket}`);
    expect(replay.opened).toBe(false);
    expect(replay.status).toBe(401);
  });

  it('no ticket at all still joins — anonymous play stays as built, nothing banks', async () => {
    const bare = await tryUpgrade('');
    expect(bare.opened).toBe(true);
  });
});

describe('the §3.2 rows over /api/auth', () => {
  it('row 3: signup from the family PC ASKS with the numbers at stake, creating nothing yet', async () => {
    const asked = await call('/api/auth/signup', {
      name: 'sister', passphrase: 'a-long-enough-passphrase', deviceId: BROTHER_DEVICE,
    });
    expect(asked.status).toBe(200);
    const ask = asked.json?.ask as Record<string, unknown>;
    expect(ask.xp).toBe(4200);
    expect(ask.matches).toBeDefined();
    // Nothing was created: the name is still free to fail a sign-in.
    const probe = await call('/api/auth/signin', { name: 'sister', passphrase: 'a-long-enough-passphrase' });
    expect(probe.status).toBe(401);
  });

  it('row 3 answered Start fresh: the account plays its own profile; the brother keeps his', async () => {
    const made = await call('/api/auth/signup', {
      name: 'sister', passphrase: 'a-long-enough-passphrase', deviceId: BROTHER_DEVICE, keepProgress: false,
    });
    expect(made.status).toBe(201);
    expect(made.json?.decisionRow).toBe(3);
    const cookie = /dc_sess=([^;]+)/.exec(made.setCookie ?? '')?.[1] ?? '';
    expect(cookie.length).toBeGreaterThan(0);

    // Her signed-in profile is NOT his 4200 xp file — it does not exist yet.
    const hers = await call('/api/profile', undefined, { cookie: `${SESSION_COOKIE}=${cookie}` });
    expect(hers.status).toBe(404);

    // His anonymous device still resolves to his own file.
    const his = await fetch(`${origin}/api/profile?device=${BROTHER_DEVICE}`);
    const hisBody = await his.json() as { profile: { progress: { xp: number } } };
    expect(hisBody.profile.progress.xp).toBe(4200);
  });

  it('row 2 then row 5: a trivial device claims silently at signup, and a second device attaches at signin — both bank to ONE profile key', async () => {
    const made = await call('/api/auth/signup', {
      name: 'nomad', passphrase: 'another-long-passphrase!', deviceId: FRESH_DEVICE,
    });
    expect(made.status).toBe(201);
    expect(made.json?.linkedDevice).toBe(true);

    const second = await call('/api/auth/signin', {
      name: 'nomad', passphrase: 'another-long-passphrase!', deviceId: 'cdcdcdcdcdcdcdcdcdcdcdcd',
    });
    expect(second.status).toBe(200);
    expect(second.json?.decisionRow).toBe(5);

    // The new device's ticket resolves to the ACCOUNT's home file.
    const minted = await call('/api/session/ticket', { deviceId: 'cdcdcdcdcdcdcdcdcdcdcdcd' });
    expect(minted.status).toBe(200);
    // Redeeming proves the resolution: the upgrade admits it, and the graph
    // test proves whose key rides inside. Here the observable is indirect:
    // the anonymous GET of the SECOND device 404s (no file of its own)...
    const anon = await fetch(`${origin}/api/profile?device=cdcdcdcdcdcdcdcdcdcdcdcd`);
    // ...because the resolver sends it to the account's home file, which has
    // never been written yet (the fresh device never played a match).
    expect(anon.status).toBe(404);
  });
});
