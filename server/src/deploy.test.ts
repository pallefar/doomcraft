/**
 * DOOMCRAFT — the patch system is actually mounted.
 *
 * This project's recurring failure mode is code that compiles, passes its unit
 * tests, and is wired to nothing (`ModeRouter` sat unreferenced outside its own
 * tests; the whole server tier had no client). `deploy.ts` and `flags.ts` would
 * be the next two if nobody checked, so these tests spawn the REAL server
 * binary over real HTTP and ask it the questions an operator would ask during a
 * deploy.
 *
 * Everything here is about routing and configuration, not about logic — the
 * logic is covered by `drain.test.ts` and `flags.test.ts` without paying for a
 * process launch.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROTOCOL_MIN_SUPPORTED, PROTOCOL_VERSION } from '@doomcraft/shared';
import { CONTENT_VERSION, protocolFingerprint } from '@doomcraft/shared/version';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, 'index.ts');
const ADMIN_TOKEN = 'test-token-not-a-secret';

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

interface Booted { child: ChildProcess; origin: string }

async function boot(env: Record<string, string> = {}): Promise<Booted> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', serverEntry], {
    cwd: join(here, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DOOMCRAFT_DATA: mkdtempSync(join(tmpdir(), 'dc-deploy-data-')),
      DOOMCRAFT_STATIC: mkdtempSync(join(tmpdir(), 'dc-deploy-static-')),
      DOOMCRAFT_BOTS: '0',
      DOOMCRAFT_BUILD_ID: 'deadbeef1234',
      DOOMCRAFT_ADMIN_TOKEN: ADMIN_TOKEN,
      ...env,
    },
  });

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try {
      const res = await fetch(`${origin}/health`);
      await res.text();
      break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
  return { child, origin };
}

const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };

/* ------------------------------------------------------------------------ *
 * The version document
 * ------------------------------------------------------------------------ */

describe('/api/version names all three axes separately', () => {
  let server: Booted;
  beforeAll(async () => { server = await boot(); }, 60_000);
  afterAll(() => { server?.child.kill('SIGKILL'); });

  it('answers with the protocol window, the content, and the build', async () => {
    const doc = await (await fetch(`${server.origin}/api/version`)).json() as Record<string, {
      version?: number; minSupported?: number; fingerprint?: number; id?: string; hash?: number;
    }>;
    expect(doc.protocol.version).toBe(PROTOCOL_VERSION);
    expect(doc.protocol.minSupported).toBe(PROTOCOL_MIN_SUPPORTED);
    expect(doc.protocol.minSupported).toBeLessThan(doc.protocol.version as number);
    expect(doc.content.version).toBe(CONTENT_VERSION);
    expect(doc.build.id).toBe('deadbeef1234');
  });

  it('publishes a protocol fingerprint, so a mixed fleet is visible', async () => {
    // Two hosts claiming the same protocol version but hashing differently is
    // the failure nobody thinks to look for. Comparing this field between hosts
    // is how you find it.
    const doc = await (await fetch(`${server.origin}/api/version`)).json() as {
      protocol: { fingerprint: number };
    };
    expect(doc.protocol.fingerprint).toBe(protocolFingerprint());
  });

  it('is on /health too, so one probe answers everything a deploy asks', async () => {
    const res = await fetch(`${server.origin}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; version: unknown; deploy: { state: string } };
    expect(body.ok).toBe(true);
    expect(body.version).toBeTruthy();
    expect(body.deploy.state).toBe('admitting');
  });
});

/* ------------------------------------------------------------------------ *
 * Flags over HTTP
 * ------------------------------------------------------------------------ */

describe('/api/flags is the menu\'s copy, and it is cheap', () => {
  let server: Booted;
  beforeAll(async () => {
    server = await boot({
      DOOMCRAFT_FLAGS: JSON.stringify({ revision: 3, rules: { share_cards: { force: true } } }),
    });
  }, 60_000);
  afterAll(() => { server?.child.kill('SIGKILL'); });

  it('serves the document the host booted with', async () => {
    const body = await (await fetch(`${server.origin}/api/flags`)).json() as {
      revision: number; frozen: boolean; flags: Record<string, boolean>;
    };
    expect(body.revision).toBe(3);
    expect(body.frozen).toBe(false);
    expect(body.flags.share_cards).toBe(true);
    // Everything else is still dark: the economy and sponsor work can sit in
    // the bundle without being reachable.
    expect(body.flags.economy_scrap).toBe(false);
    expect(body.flags.sponsor_interstitial).toBe(false);
  });

  it('answers 304 on a repeat, which is what makes it one request per session', async () => {
    const first = await fetch(`${server.origin}/api/flags`);
    const etag = first.headers.get('etag');
    await first.text();
    expect(etag).toBeTruthy();
    expect(first.headers.get('cache-control')).toContain('stale-while-revalidate');

    const second = await fetch(`${server.origin}/api/flags`, {
      headers: { 'if-none-match': etag as string },
    });
    expect(second.status).toBe(304);
  });
});

/* ------------------------------------------------------------------------ *
 * The admin surface
 * ------------------------------------------------------------------------ */

describe('the admin surface', () => {
  it('does not exist at all without a token', async () => {
    // 404, not 401: an unconfigured deployment must not advertise that there is
    // an admin surface to attack.
    const server = await boot({ DOOMCRAFT_ADMIN_TOKEN: '' });
    try {
      const res = await fetch(`${server.origin}/api/admin/drain`, { method: 'POST' });
      expect(res.status).toBe(404);
      await res.text();
      const health = await (await fetch(`${server.origin}/health`)).json() as { deploy: { state: string } };
      expect(health.deploy.state).toBe('admitting');
    } finally {
      server.child.kill('SIGKILL');
    }
  }, 60_000);

  it('refuses a wrong token', async () => {
    const server = await boot();
    try {
      const res = await fetch(`${server.origin}/api/admin/drain`, {
        method: 'POST', headers: { Authorization: 'Bearer wrong' },
      });
      expect(res.status).toBe(404);
      await res.text();
    } finally {
      server.child.kill('SIGKILL');
    }
  }, 60_000);

  it('flips a flag for the whole host without a deploy', async () => {
    const server = await boot();
    try {
      const before = await (await fetch(`${server.origin}/api/flags`)).json() as { flags: Record<string, boolean> };
      expect(before.flags.economy_scrap).toBe(false);

      const res = await fetch(`${server.origin}/api/admin/flags`, {
        method: 'POST',
        headers: { ...admin, 'content-type': 'application/json' },
        body: JSON.stringify({ revision: 9, rules: { economy_scrap: { force: true } } }),
      });
      expect(res.status).toBe(200);
      await res.text();

      const after = await (await fetch(`${server.origin}/api/flags`)).json() as {
        revision: number; flags: Record<string, boolean>;
      };
      expect(after.revision).toBe(9);
      expect(after.flags.economy_scrap).toBe(true);
    } finally {
      server.child.kill('SIGKILL');
    }
  }, 60_000);

  it('freezes every partial rollout with one call', async () => {
    const server = await boot();
    try {
      await (await fetch(`${server.origin}/api/admin/flags`, {
        method: 'POST',
        headers: { ...admin, 'content-type': 'application/json' },
        body: JSON.stringify({
          revision: 2,
          rules: { share_cards: { rolloutBp: 10000 }, economy_scrap: { rolloutBp: 5000 } },
        }),
      })).text();

      await (await fetch(`${server.origin}/api/admin/flags`, {
        method: 'POST',
        headers: { ...admin, 'content-type': 'application/json' },
        body: JSON.stringify({
          revision: 3,
          frozen: true,
          rules: { share_cards: { rolloutBp: 10000 }, economy_scrap: { rolloutBp: 5000 } },
        }),
      })).text();

      const body = await (await fetch(`${server.origin}/api/flags?device=aaaaaaaaaaaaaaaa`)).json() as {
        frozen: boolean; flags: Record<string, boolean>;
      };
      expect(body.frozen).toBe(true);
      // The half-rolled-out one is stopped; the finished one is untouched.
      expect(body.flags.economy_scrap).toBe(false);
      expect(body.flags.share_cards).toBe(true);
    } finally {
      server.child.kill('SIGKILL');
    }
  }, 60_000);
});

/* ------------------------------------------------------------------------ *
 * The deploy drain, end to end
 * ------------------------------------------------------------------------ */

describe('POST /api/admin/drain takes a host out of rotation', () => {
  it('turns /health to 503 and stops creating rooms, without killing the process', async () => {
    // PREWARM off, so the host starts with an empty room table and the drain
    // completes immediately — the "quiet host drains in seconds" path.
    const server = await boot({ DOOMCRAFT_PREWARM: '0' });
    try {
      const before = await fetch(`${server.origin}/health`);
      expect(before.status).toBe(200);
      await before.text();

      const drain = await fetch(`${server.origin}/api/admin/drain`, { method: 'POST', headers: admin });
      expect(drain.status).toBe(200);
      const body = await drain.json() as { deploy: { state: string; admitting: boolean } };
      expect(body.deploy.admitting).toBe(false);
      expect(['draining', 'drained']).toContain(body.deploy.state);

      // 503, so a load balancer stops sending players by itself...
      const after = await fetch(`${server.origin}/health`);
      expect(after.status).toBe(503);
      const health = await after.json() as { ok: boolean; deploy: { state: string } };
      expect(health.ok).toBe(false);

      // ...but the PROCESS is still up and still serving. That is the whole
      // difference between a deploy drain and a shutdown: the matches already
      // running are untouched, and here that includes the HTTP surface.
      const status = await fetch(`${server.origin}/api/version`);
      expect(status.status).toBe(200);
      await status.text();
      expect(server.child.exitCode).toBeNull();

      // A second drain is idempotent, not an error.
      const again = await fetch(`${server.origin}/api/admin/drain`, { method: 'POST', headers: admin });
      expect(again.status).toBe(200);
      await again.text();
    } finally {
      server.child.kill('SIGKILL');
    }
  }, 60_000);
});
