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
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROTOCOL_MIN_SUPPORTED, PROTOCOL_VERSION } from '@doomcraft/shared';
import { CONTENT_VERSION, protocolFingerprint } from '@doomcraft/shared/version';
import { isLevelBinary } from '@doomcraft/shared/level';

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

/* ------------------------------------------------------------------------ *
 * The content hash is a HOST fact, not a build constant
 * ------------------------------------------------------------------------ */

const CONTENT_LEVELS = join(here, '..', '..', 'content', 'levels');

/**
 * A copy of the shipped campaign, with `mutate` applied to one file's text.
 *
 * The mutation is a single character inside a string value, so the two
 * directories differ by exactly one byte and both still parse, compile and
 * validate — which is the case that matters. A host with a corrupt level file
 * is obvious; a host with a level file that is merely DIFFERENT is the one that
 * silently splits a fleet in two.
 */
function levelDir(mutate: ((text: string) => string) | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'dc-levels-'));
  cpSync(CONTENT_LEVELS, dir, { recursive: true });
  if (mutate !== null) {
    const file = join(dir, 'e1m1-hangar.json');
    const before = readFileSync(file, 'utf8');
    const after = mutate(before);
    if (after === before || after.length !== before.length) {
      throw new Error('the fixture must differ by exactly one byte');
    }
    writeFileSync(file, after, 'utf8');
  }
  return dir;
}

describe('/api/version can tell two hosts apart', () => {
  /*
   * `docs/PATCHING.md`: the level fold exists precisely so that "two hosts on
   * the same CONTENT_VERSION with different files on disk produce different
   * hashes and are visible in /api/version".
   *
   * They did not. `versionDocument()` called a bare `contentHashFor()` with no
   * level hashes, so every host in the fleet published the same per-BUILD
   * constant, while the correctly folded value was computed in `index.ts` and
   * sent to PLAYERS on SESSION_CONFIG. The existing test above asserts
   * `doc.content.version`, which is a constant either way — that is exactly why
   * the missing fold survived, and why this test asks two processes.
   */
  it('publishes a different content hash for a level file that differs by one byte', async () => {
    const plain = levelDir(null);
    const edited = levelDir((t) => t.replace('"name": "Hangar"', '"name": "Hangbr"'));

    const a = await boot({ DOOMCRAFT_LEVELS: plain });
    try {
      const b = await boot({ DOOMCRAFT_LEVELS: edited });
      try {
        const da = await (await fetch(`${a.origin}/api/version`)).json() as {
          content: { version: number; hash: number };
        };
        const db = await (await fetch(`${b.origin}/api/version`)).json() as {
          content: { version: number; hash: number };
        };

        // Same build, same CONTENT_VERSION: the axis that was doing the work
        // before cannot see this at all.
        expect(db.content.version).toBe(da.content.version);
        expect(typeof da.content.hash).toBe('number');
        expect(
          db.content.hash,
          'two hosts with different level bytes published the same content hash',
        ).not.toBe(da.content.hash);
      } finally {
        b.child.kill('SIGKILL');
      }
    } finally {
      a.child.kill('SIGKILL');
    }
  }, 120_000);

  it('publishes the SAME hash for two hosts with identical files, or it is just noise', async () => {
    // The other half of the claim: a hash that differs between identical hosts
    // would make the comparison useless in the opposite direction.
    const one = levelDir(null);
    const two = levelDir(null);
    const a = await boot({ DOOMCRAFT_LEVELS: one });
    try {
      const b = await boot({ DOOMCRAFT_LEVELS: two });
      try {
        const da = await (await fetch(`${a.origin}/api/version`)).json() as { content: { hash: number } };
        const db = await (await fetch(`${b.origin}/api/version`)).json() as { content: { hash: number } };
        expect(db.content.hash).toBe(da.content.hash);
      } finally {
        b.child.kill('SIGKILL');
      }
    } finally {
      a.child.kill('SIGKILL');
    }
  }, 120_000);

  it('says the same thing on /health, which is the probe a deploy already polls', async () => {
    const server = await boot({ DOOMCRAFT_LEVELS: levelDir(null) });
    try {
      const version = await (await fetch(`${server.origin}/api/version`)).json() as { content: { hash: number } };
      const health = await (await fetch(`${server.origin}/health`)).json() as {
        version: { content: { hash: number } };
      };
      expect(health.version.content.hash).toBe(version.content.hash);
    } finally {
      server.child.kill('SIGKILL');
    }
  }, 60_000);
});

/* ------------------------------------------------------------------------ *
 * GET /api/levels exists
 * ------------------------------------------------------------------------ */

/** The SPA document a mis-routed GET used to fall through to. */
const SPA_HTML = '<!doctype html><html><head><title>DOOMCRAFT</title></head><body></body></html>\n';

describe('GET /api/levels is a route and not the SPA', () => {
  let server: Booted;
  beforeAll(async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'dc-levels-static-'));
    writeFileSync(join(staticRoot, 'index.html'), SPA_HTML, 'utf8');
    server = await boot({ DOOMCRAFT_STATIC: staticRoot, DOOMCRAFT_LEVELS: levelDir(null) });
  }, 60_000);
  afterAll(() => { server?.child.kill('SIGKILL'); });

  /*
   * `LevelLibrary.handle()` was a complete, tested HTTP surface with no caller.
   * `client/src/modes/quest/quest.ts` has been asking for these two URLs on
   * every campaign launch against a configured server and getting `index.html`
   * back with a 200 — the seventh "written, tested, imported by nothing" in
   * this repo. The static root here holds a real index.html so that the failure
   * this replaces is reproduced exactly, rather than being masked by a 404.
   */
  it('answers the manifest as application/json, not as text/html', async () => {
    const res = await fetch(`${server.origin}/api/levels`);
    expect(res.status).toBe(200);
    const type = res.headers.get('content-type') ?? '';
    expect(type).toContain('application/json');
    expect(type).not.toContain('text/html');
    const body = await res.json() as { levels?: unknown[]; episodes?: unknown[] };
    const rows = body.levels ?? [];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('serves the compiled .dcl bytes the room is actually running', async () => {
    const manifest = await (await fetch(`${server.origin}/api/levels`)).json() as {
      levels: Array<{ id: string }>;
    };
    const id = manifest.levels[0].id;
    const res = await fetch(`${server.origin}/api/levels/${id}/data`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/octet-stream');
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The client's own guard: `loadQuestLevel` throws this away and falls back
    // to the bundled source when it is false, which is how a 200 full of HTML
    // stayed invisible for so long.
    expect(isLevelBinary(bytes)).toBe(true);
  });

  it('answers 304 to a matching ETag, so a level is fetched once', async () => {
    const manifest = await (await fetch(`${server.origin}/api/levels`)).json() as {
      levels: Array<{ id: string }>;
    };
    const id = manifest.levels[0].id;
    const first = await fetch(`${server.origin}/api/levels/${id}/data`);
    const etag = first.headers.get('etag');
    await first.arrayBuffer();
    expect(etag).toBeTruthy();
    const second = await fetch(`${server.origin}/api/levels/${id}/data`, {
      headers: { 'if-none-match': etag as string },
    });
    expect(second.status).toBe(304);
  });

  it('404s an unknown level in JSON rather than handing back the game', async () => {
    const res = await fetch(`${server.origin}/api/levels/not-a-level`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    await res.text();
  });

  it('is still the SPA everywhere else — the fall-through is not broken', async () => {
    const res = await fetch(`${server.origin}/play/deathmatch`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    await res.text();
  });
});

/* ------------------------------------------------------------------------ *
 * The documented freeze command
 * ------------------------------------------------------------------------ */

describe('POST /api/admin/flags merges, and refuses a stale write', () => {
  /** The exact body `docs/PATCHING.md` tells an operator to paste. */
  const DOCUMENTED_FREEZE = '{"revision":9,"frozen":true}';

  it('leaves every rule intact when sent the freeze command from the runbook', async () => {
    const server = await boot();
    try {
      const seeded = await (await fetch(`${server.origin}/api/admin/flags`, {
        method: 'POST',
        headers: { ...admin, 'content-type': 'application/json' },
        body: JSON.stringify({
          revision: 2,
          rules: {
            share_cards: { force: true, rolloutBp: 10000 },
            economy_scrap: { rolloutBp: 5000 },
          },
        }),
      })).json() as { registry: Array<{ key: string; force: boolean | null; rolloutBp: number }> };
      const seededScrap = seeded.registry.find((r) => r.key === 'economy_scrap');
      expect(seededScrap?.rolloutBp).toBe(5000);

      // The runbook's body. Nothing else. Under the old full-replace parse this
      // request deleted every force and every rolloutBp on the host — the most
      // destructive call in the API was the one the documentation prescribed.
      const res = await fetch(`${server.origin}/api/admin/flags`, {
        method: 'POST',
        headers: { ...admin, 'content-type': 'application/json' },
        body: DOCUMENTED_FREEZE,
      });
      expect(res.status).toBe(200);
      const after = await res.json() as {
        revision: number;
        frozen: boolean;
        registry: Array<{ key: string; force: boolean | null; rolloutBp: number }>;
      };

      expect(after.frozen).toBe(true);
      expect(after.revision).toBe(9);
      const scrap = after.registry.find((r) => r.key === 'economy_scrap');
      const share = after.registry.find((r) => r.key === 'share_cards');
      expect(scrap?.rolloutBp, 'the freeze deleted the partial rollout it was meant to pause').toBe(5000);
      expect(share?.force, 'the freeze deleted an operator force it never mentioned').toBe(true);
      expect(share?.rolloutBp).toBe(10000);

      // And it still froze: the partial rollout resolves to the flag default,
      // the finished one is untouched. Freezing without destroying is the
      // whole point.
      const live = await (await fetch(`${server.origin}/api/flags?device=aaaaaaaaaaaaaaaa`)).json() as {
        frozen: boolean; flags: Record<string, boolean>;
      };
      expect(live.frozen).toBe(true);
      expect(live.flags.economy_scrap).toBe(false);
      expect(live.flags.share_cards).toBe(true);
    } finally {
      server.child.kill('SIGKILL');
    }
  }, 60_000);

  it('refuses a write whose expectRevision does not match, and changes nothing', async () => {
    const server = await boot();
    try {
      await (await fetch(`${server.origin}/api/admin/flags`, {
        method: 'POST',
        headers: { ...admin, 'content-type': 'application/json' },
        body: JSON.stringify({ revision: 4, rules: { economy_scrap: { rolloutBp: 2500 } } }),
      })).text();

      const stale = await fetch(`${server.origin}/api/admin/flags`, {
        method: 'POST',
        headers: { ...admin, 'content-type': 'application/json' },
        body: JSON.stringify({ expectRevision: 3, rules: { economy_scrap: { rolloutBp: 10000 } } }),
      });
      expect(stale.status).toBe(409);
      const conflict = await stale.json() as { expected: number; revision: number };
      expect(conflict.expected).toBe(3);
      expect(conflict.revision).toBe(4);

      // Nothing moved: not the rule, not the revision.
      const fresh = await fetch(`${server.origin}/api/admin/flags`, {
        method: 'POST',
        headers: { ...admin, 'content-type': 'application/json' },
        body: JSON.stringify({ expectRevision: 4 }),
      });
      expect(fresh.status).toBe(200);
      const doc = await fresh.json() as {
        revision: number; registry: Array<{ key: string; rolloutBp: number }>;
      };
      expect(doc.registry.find((r) => r.key === 'economy_scrap')?.rolloutBp).toBe(2500);
      // An accepted write always moves the revision, or the CAS token stands
      // still while the document changes underneath it.
      expect(doc.revision).toBe(5);
    } finally {
      server.child.kill('SIGKILL');
    }
  }, 60_000);
});
