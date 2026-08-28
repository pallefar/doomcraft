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
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

interface Booted {
  child: ChildProcess;
  origin: string;
  data: string;
  /** Everything the process has written to stderr so far. */
  err(): string;
}

async function boot(env: Record<string, string> = {}): Promise<Booted> {
  const port = await freePort();
  /* Returned, because the reward journal writes under it and "the directory
   * exists on a host nobody configured" is the cheapest possible proof that the
   * journal is constructed in the real binary rather than only in a test. */
  const data = mkdtempSync(join(tmpdir(), 'dc-deploy-data-'));
  const child = spawn(process.execPath, ['--import', 'tsx', serverEntry], {
    cwd: join(here, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DOOMCRAFT_DATA: data,
      DOOMCRAFT_STATIC: mkdtempSync(join(tmpdir(), 'dc-deploy-static-')),
      DOOMCRAFT_BOTS: '0',
      DOOMCRAFT_BUILD_ID: 'deadbeef1234',
      DOOMCRAFT_ADMIN_TOKEN: ADMIN_TOKEN,
      ...env,
    },
  });

  /* Collected because a REFUSED admin bearer is supposed to leave a line, and
   * "there is no trace of a brute-force attempt anywhere in the tree" was the
   * fourth defect `adminAuth.ts` was written to fix. A counter alone can be
   * satisfied by a counter that nobody reads. */
  let errText = '';
  child.stderr?.on('data', (b: Buffer) => { errText += b.toString('utf8'); });
  child.stdout?.on('data', () => { /* drained so the pipe cannot fill and stall */ });

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
  return { child, origin, data, err: (): string => errText };
}

const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const adminJson = { ...admin, 'content-type': 'application/json' };

/**
 * Every mutating admin route now REQUIRES an `actor` and a `reason` of at least
 * ten characters (`docs/PLATFORM.md` §5.7), so the tests below that are about
 * merge semantics and the drain say so once here rather than eleven times.
 *
 * The guards themselves are tested against the route directly, further down, by
 * sending bodies that are missing each field — never through this helper, which
 * would only ever prove that the helper fills them in.
 */
function audited(body: Record<string, unknown> = {}): string {
  return JSON.stringify({
    actor: 'deploy-test',
    reason: 'exercising the documented admin path from the test suite',
    ...body,
  });
}

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
        headers: adminJson,
        body: audited({ revision: 9, rules: { economy_scrap: { force: true } } }),
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
        headers: adminJson,
        /* 5000 bp is deliberately NOT on the docs/PATCHING.md ladder, so this
         * body has to say so — which is the guard doing its job, not noise. */
        body: audited({
          revision: 2,
          allowCustomRollout: true,
          rules: { share_cards: { rolloutBp: 10000 }, economy_scrap: { rolloutBp: 5000 } },
        }),
      })).text();

      await (await fetch(`${server.origin}/api/admin/flags`, {
        method: 'POST',
        headers: adminJson,
        body: audited({
          revision: 3,
          frozen: true,
          allowCustomRollout: true,
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

      const drain = await fetch(`${server.origin}/api/admin/drain`, {
        method: 'POST', headers: adminJson, body: audited(),
      });
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
      const again = await fetch(`${server.origin}/api/admin/drain`, {
        method: 'POST', headers: adminJson, body: audited(),
      });
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
  /**
   * The exact body `docs/PATCHING.md` tells an operator to paste, plus the two
   * fields every mutation now requires.
   *
   * The runbook's shape is what is under test — a patch naming ONLY `revision`
   * and `frozen`, which under the old full-replace deleted every force and
   * every rolloutBp on the host. `actor` and `reason` are audit metadata and
   * name no rule, so adding them does not weaken the case; the runbook itself
   * is corrected in `docs/PATCHING.md`.
   */
  const DOCUMENTED_FREEZE = JSON.stringify({
    revision: 9,
    frozen: true,
    actor: 'deploy-test',
    reason: 'pausing every rollout while we look at the error rate',
  });

  it('leaves every rule intact when sent the freeze command from the runbook', async () => {
    const server = await boot();
    try {
      const seeded = await (await fetch(`${server.origin}/api/admin/flags`, {
        method: 'POST',
        headers: adminJson,
        body: audited({
          revision: 2,
          allowCustomRollout: true,
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
        headers: adminJson,
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
        headers: adminJson,
        body: audited({ revision: 4, rules: { economy_scrap: { rolloutBp: 2500 } } }),
      })).text();

      const stale = await fetch(`${server.origin}/api/admin/flags`, {
        method: 'POST',
        headers: adminJson,
        body: audited({ expectRevision: 3, rules: { economy_scrap: { rolloutBp: 10000 } } }),
      });
      expect(stale.status).toBe(409);
      const conflict = await stale.json() as { expected: number; revision: number };
      expect(conflict.expected).toBe(3);
      expect(conflict.revision).toBe(4);

      // Nothing moved: not the rule, not the revision.
      const fresh = await fetch(`${server.origin}/api/admin/flags`, {
        method: 'POST',
        headers: adminJson,
        body: audited({ expectRevision: 4 }),
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


/* ------------------------------------------------------------------------ *
 * The reward journal is mounted
 *
 * `journal.test.ts` proves the ledger sums to the balance; `economy.test.ts`
 * proves the room writes it. These prove the real binary constructs one and
 * serves the read half an operator needs — the failure mode this project keeps
 * repeating is a feature that compiles, passes hundreds of tests, and is
 * imported by nothing.
 * ------------------------------------------------------------------------ */

describe('the reward journal, in the real binary', () => {
  let server: Booted;
  beforeAll(async () => { server = await boot(); }, 60_000);
  afterAll(() => { server?.child.kill('SIGKILL'); });

  it('creates both streams under the data root, on a host nobody configured', () => {
    // The two-file split of §4.5 is made at WRITE time because it cannot be
    // made at delete time: erasure removes one and keeps the other.
    expect(existsSync(join(server.data, 'journal'))).toBe(true);
    expect(existsSync(join(server.data, 'financial'))).toBe(true);
  });

  it('names THIS host in the version document, so two of them can be told apart', async () => {
    const doc = await (await fetch(`${server.origin}/api/version`)).json() as {
      build: { id: string; host: string };
    };
    // `build.id` is the bundle and every host in a fleet shares it. `host` is
    // the process — and it is the first component of every payout's
    // idempotency key, because a room's session id repeats across a restart.
    expect(doc.build.id).toBe('deadbeef1234');
    expect(doc.build.host).toMatch(/^[0-9a-f]{12}$/);
  });

  it('answers the operator with a page of rows AND the reconciliation', async () => {
    const res = await fetch(
      `${server.origin}/api/admin/journal?player=device-live0001&limit=10`, { headers: admin },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as {
      player: string;
      rows: unknown[];
      reconcile: { xp: { stored: number | null; journal: number }; scrap: { stored: number | null; journal: number }; fromDay: string };
      status: { appended: number; failed: number };
    };
    // A divergence between these two numbers is the ONLY evidence that a payout
    // moved a balance without being recorded, and it is invisible from either
    // number alone. That is the whole reason this route answers both.
    expect(body.reconcile.xp.journal).toBe(0);
    expect(body.reconcile.scrap.journal).toBe(0);
    // Nobody has played on this host, so there is no profile and no row.
    expect(body.reconcile.xp.stored).toBeNull();
    expect(body.rows).toEqual([]);
    expect(body.status.failed).toBe(0);
  });

  it('never puts the full device id in the response it just took one in', async () => {
    // docs/PLATFORM.md §5.7: no admin serialiser may emit a full device id, and
    // a journal row carries one on every line.
    const res = await fetch(
      `${server.origin}/api/admin/journal?player=device-live0001`, { headers: admin },
    );
    const text = await res.text();
    expect(text).not.toContain('device-live0001');
    expect(JSON.parse(text).player).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is admin-gated, and refuses a device id that is not one', async () => {
    const open = await fetch(`${server.origin}/api/admin/journal?player=device-live0001`);
    expect(open.status).toBe(404);
    expect(open.headers.get('content-type')).toContain('application/json');
    const bad = await fetch(`${server.origin}/api/admin/journal?player=../etc`, { headers: admin });
    expect(bad.status).toBe(400);
  });
});

/* ------------------------------------------------------------------------ *
 * THE ADMIN CONSOLE, against the real binary
 *
 * `server/src/admin/console.ts` is an HTML string. `console.test.ts` proves it
 * parses and that its decisions are imported rather than computed; nothing
 * there proves the SERVER serves it, gates it, or refuses the writes it is
 * supposed to refuse. That is what these do, over real HTTP, against a spawned
 * process — the only honest way to test an HTTP surface in this repo.
 *
 * The static root holds a real index.html on purpose. Every route added here
 * would otherwise fall through `handleApi` to `serveStatic`'s SPA fallback and
 * answer 200 with the GAME, which is exactly how `/api/levels` was broken for
 * months and how `GET /api/admin/flags` was broken until this commit. A missing
 * route must be provable as a missing route, not masked by a 404.
 * ------------------------------------------------------------------------ */

function consoleStatic(): string {
  const root = mkdtempSync(join(tmpdir(), 'dc-admin-static-'));
  writeFileSync(join(root, 'index.html'), SPA_HTML, 'utf8');
  return root;
}

describe('GET /admin serves the console, and only when there is a token', () => {
  it('DOES NOT EXIST without a token — and answers JSON, not the game', async () => {
    const server = await boot({ DOOMCRAFT_ADMIN_TOKEN: '', DOOMCRAFT_STATIC: consoleStatic() });
    try {
      const res = await fetch(`${server.origin}/admin`);
      expect(res.status).toBe(404);
      const type = res.headers.get('content-type') ?? '';
      expect(type).toContain('application/json');
      const text = await res.text();
      // An unconfigured deployment must not advertise an admin surface, and it
      // must not hand back the SPA either — a 200 with the game in it reads as
      // "the console is there, you are just not logged in".
      expect(text).not.toContain('DOOMCRAFT');
      expect(text).not.toContain('operator console');
    } finally {
      server.child.kill('SIGKILL');
    }
  }, 60_000);

  it('serves the shell with a token configured, uncacheable and unindexed', async () => {
    const server = await boot({ DOOMCRAFT_STATIC: consoleStatic() });
    try {
      // Note: NO bearer on this request. The page is a shell that ships no data
      // and asks for the token itself; every /api/admin/* call it makes is gated.
      const res = await fetch(`${server.origin}/admin`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-robots-tag')).toContain('noindex');
      const html = await res.text();
      expect(html).toContain('operator console');
      // It is NOT the game's index.html.
      expect(html).not.toBe(SPA_HTML);
      // And it carries no secret.
      expect(html).not.toContain(ADMIN_TOKEN);
    } finally {
      server.child.kill('SIGKILL');
    }
  }, 60_000);

  it('is stamped with this response\'s CSP nonce, so its own script can run', async () => {
    const server = await boot({ DOOMCRAFT_STATIC: consoleStatic() });
    try {
      const res = await fetch(`${server.origin}/admin`);
      const csp = res.headers.get('content-security-policy') ?? '';
      const html = await res.text();
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? '';
      expect(nonce.length).toBeGreaterThan(8);
      // Both the style and the script must carry it, or the page renders
      // unstyled and dead — and `script-src` has no 'unsafe-inline' to fall
      // back on, which is the entire point of the game's CSP.
      expect(html).toContain(`<script nonce="${nonce}"`);
      expect(html).toContain(`<style nonce="${nonce}"`);
      // Two responses, two nonces: a stamped document can never be cached into
      // a page whose nonce no longer matches its header.
      const again = await fetch(`${server.origin}/admin`);
      const csp2 = again.headers.get('content-security-policy') ?? '';
      await again.text();
      expect(/'nonce-([^']+)'/.exec(csp2)?.[1]).not.toBe(nonce);
    } finally {
      server.child.kill('SIGKILL');
    }
  }, 60_000);
});

describe('the admin bearer, over real HTTP', () => {
  let server: Booted;
  beforeAll(async () => { server = await boot({ DOOMCRAFT_STATIC: consoleStatic() }); }, 60_000);
  afterAll(() => { server?.child.kill('SIGKILL'); });

  async function attempt(headers: Record<string, string>): Promise<number> {
    const res = await fetch(`${server.origin}/api/admin/flags`, { headers });
    await res.text();
    return res.status;
  }

  it('answers the five wrong ways to ask identically, and in JSON', async () => {
    const cases: Array<[string, Record<string, string>]> = [
      ['no header at all', {}],
      ['a wrong token', { Authorization: 'Bearer definitely-not-the-token' }],
      /* THE LENGTH ORACLE. The version this replaced returned early on a length
       * mismatch, so one request per guess told an attacker exactly how long the
       * secret is. Both sides are sha256'd now: there is no length left to
       * branch on, and a 1-character guess costs what a 10,000-character one does. */
      ['a wrong token of the RIGHT length', { Authorization: `Bearer ${'x'.repeat(ADMIN_TOKEN.length)}` }],
      ['a wrong token of the wrong length', { Authorization: `Bearer ${ADMIN_TOKEN}xxxxxxxxxxxxxxxx` }],
      ['a bare token with no scheme', { Authorization: ADMIN_TOKEN }],
    ];
    for (const [what, headers] of cases) {
      const res = await fetch(`${server.origin}/api/admin/flags`, { headers });
      const type = res.headers.get('content-type') ?? '';
      expect(res.status, `${what} should be refused`).toBe(404);
      /* JSON and not the SPA. Before `/api/admin/flags` had a GET at all, this
       * request fell through to the static fallback and answered 200 with the
       * game's index.html — so the flag document was readable only as a side
       * effect of WRITING it. */
      expect(type, `${what} answered ${type}`).toContain('application/json');
      expect(await res.text()).not.toContain('DOOMCRAFT');
    }
  });

  it('takes the scheme in any case, because RFC 7235 says it is case-insensitive', async () => {
    expect(await attempt({ authorization: `bearer ${ADMIN_TOKEN}` })).toBe(200);
    expect(await attempt({ Authorization: `BEARER ${ADMIN_TOKEN}` })).toBe(200);
  });

  it('counts every refusal and writes a line for it — a brute force used to leave no trace', async () => {
    const before = await (await fetch(`${server.origin}/api/admin/entitlement`, { headers: admin }))
      .json() as { auth: { denied: number; throttled: number } };
    await attempt({ Authorization: 'Bearer wrong-again' });
    await attempt({});
    const after = await (await fetch(`${server.origin}/api/admin/entitlement`, { headers: admin }))
      .json() as { auth: { denied: number; throttled: number } };
    expect(after.auth.denied).toBeGreaterThanOrEqual(before.auth.denied + 2);
    // And the operator can see it without the console: one line per refusal,
    // naming the reason and the path.
    const log = server.err();
    expect(log).toContain('[admin] denied bad-token');
    expect(log).toContain('[admin] denied no-credential');
    expect(log).toContain('/api/admin/flags');
    // The token itself is NEVER in the log.
    expect(log).not.toContain(ADMIN_TOKEN);
  });

  it('429s a client that has burned its budget, and still admits the RIGHT token', async () => {
    for (let i = 0; i < 30; i++) await attempt({ Authorization: `Bearer guess-${i}` });
    expect(await attempt({ Authorization: 'Bearer one-more-guess' })).toBe(429);
    // An attack is not a reason to disarm the defender: the credential is
    // checked BEFORE the bucket, so the operator is never locked out of their
    // own console while somebody on the same address is guessing.
    expect(await attempt(admin)).toBe(200);
  });
});

describe('the mutation guards, called directly rather than through the panel', () => {
  let server: Booted;
  beforeAll(async () => { server = await boot({ DOOMCRAFT_STATIC: consoleStatic() }); }, 60_000);
  afterAll(() => { server?.child.kill('SIGKILL'); });

  async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${server.origin}${path}`, {
      method: 'POST', headers: adminJson, body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { text }; }
    return { status: res.status, body: parsed };
  }
  async function auditRows(): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(`${server.origin}/api/admin/audit?limit=200`, { headers: admin });
    return (await res.json() as { rows: Array<Record<string, unknown>> }).rows;
  }
  async function revision(): Promise<number> {
    const res = await fetch(`${server.origin}/api/admin/flags`, { headers: admin });
    return (await res.json() as { revision: number }).revision;
  }

  /**
   * THE POINT OF THIS BLOCK. `docs/PLATFORM.md` §5.8 argues that the confirm
   * ritual is the review for a one-person team — but a ritual the panel
   * performs is a ritual `curl` skips by accident. None of these requests come
   * from the console; they are what an operator, a script or an attacker with
   * the bearer can actually send.
   */
  it('refuses a write with no reason, no short reason and no actor — and writes NO audit row', async () => {
    const rowsBefore = (await auditRows()).length;
    const revBefore = await revision();

    const noActor = await post('/api/admin/flags', { reason: 'a perfectly adequate reason' });
    expect(noActor.status).toBe(400);
    expect(String(noActor.body.error)).toContain('actor');

    const shortReason = await post('/api/admin/flags', { actor: 'me', reason: 'oops' });
    expect(shortReason.status).toBe(400);
    expect(String(shortReason.body.error)).toContain('reason');

    const noReason = await post('/api/admin/flags', { actor: 'me', rules: { share_cards: { force: true } } });
    expect(noReason.status).toBe(400);

    const shortActor = await post('/api/admin/flags', { actor: 'm', reason: 'a perfectly adequate reason' });
    expect(shortActor.status).toBe(400);

    // Nothing happened, in either place: no rule moved, no revision moved, and
    // the log is not full of unattributable noise a scanner can generate.
    expect(await revision()).toBe(revBefore);
    expect((await auditRows()).length).toBe(rowsBefore);
  });

  it('refuses the same four on the DRAIN route, and the host keeps admitting', async () => {
    const bad = await post('/api/admin/drain', { actor: 'me' });
    expect(bad.status).toBe(400);
    const health = await fetch(`${server.origin}/health`);
    expect(health.status).toBe(200);
    await health.text();
  });

  it('refuses a rollout that is not on the docs/PATCHING.md ladder', async () => {
    const off = await post('/api/admin/flags', {
      actor: 'me', reason: 'stepping the rollout somewhere in between',
      rules: { economy_scrap: { rolloutBp: 5000 } },
    });
    expect(off.status).toBe(400);
    expect(String(off.body.error)).toContain('ladder');
    expect(off.body.ladder).toEqual([0, 100, 500, 2500, 10000]);
    expect(off.body.offLadder).toEqual(['economy_scrap']);
  });

  it('takes the same off-ladder write when the request says so in as many words', async () => {
    const ok = await post('/api/admin/flags', {
      actor: 'me', reason: 'holding at 50 percent for the weekend on purpose',
      allowCustomRollout: true,
      rules: { economy_scrap: { rolloutBp: 5000 } },
    });
    expect(ok.status).toBe(200);
    const registry = ok.body.registry as Array<{ key: string; rolloutBp: number; onLadder: boolean }>;
    const row = registry.find((r) => r.key === 'economy_scrap');
    expect(row?.rolloutBp).toBe(5000);
    // And the row still says it is off the ladder, so the console keeps saying so.
    expect(row?.onLadder).toBe(false);
  });

  it('writes an audit row with the BEFORE and AFTER state, which is what makes undo one paste', async () => {
    const rev = await revision();
    const applied = await post('/api/admin/flags', {
      actor: 'karsten', expectRevision: rev,
      reason: 'turning share cards on for everybody',
      rules: { share_cards: { force: true } },
    });
    expect(applied.status).toBe(200);
    const rows = await auditRows();
    const row = rows.find((r) => r.id === applied.body.action);
    expect(row, 'the response named an audit row that is not in the log').toBeDefined();
    expect(row?.actor).toBe('karsten');
    expect(row?.verb).toBe('flags.set');
    expect(row?.subject).toBe('share_cards');
    expect(row?.outcome).toBe('applied');
    expect(row?.reason).toBe('turning share cards on for everybody');
    // The undo is readable off the row: this is what the document WAS.
    const before = JSON.parse(String(row?.before)) as { rules: Record<string, { force: boolean | null } | undefined> };
    const after = JSON.parse(String(row?.after)) as { rules: Record<string, { force: boolean | null }> };
    expect(after.rules.share_cards.force).toBe(true);
    expect(before.rules.share_cards?.force ?? null).not.toBe(true);
  });

  it('409s a stale write AND records the refusal, so two operators can see they collided', async () => {
    const stale = await post('/api/admin/flags', {
      actor: 'karsten', expectRevision: 0,
      reason: 'racing myself from a second tab on purpose',
      rules: { share_cards: { force: false } },
    });
    expect(stale.status).toBe(409);
    const rows = await auditRows();
    const refused = rows.find((r) => r.outcome === 'refused');
    expect(refused, 'a 409 that leaves no trace is how a collision goes unnoticed').toBeDefined();
    expect(refused?.reason).toBe('racing myself from a second tab on purpose');
  });

  it('plans a write without changing anything, including the audit log', async () => {
    const rev = await revision();
    const rowsBefore = (await auditRows()).length;
    const plan = await post('/api/admin/flags/plan', {
      expectRevision: rev, rules: { economy_scrap: { rolloutBp: 10000 } },
    });
    expect(plan.status).toBe(200);
    expect(plan.body.risk).toBe('expands');
    expect(plan.body.delayMs).toBe(60_000);
    expect(plan.body.subject).toBe('economy_scrap');
    const warnings = plan.body.warnings as string[];
    // The blast radius, verbatim and inline, is what makes a human dare.
    expect(warnings.some((w) => w.includes('Player balances'))).toBe(true);
    expect(warnings.some((w) => w.includes('ONE process'))).toBe(true);
    // Planning is reading.
    expect(await revision()).toBe(rev);
    expect((await auditRows()).length).toBe(rowsBefore);
  });

  it('409s a stale PLAN rather than showing a diff against a document that moved', async () => {
    const plan = await post('/api/admin/flags/plan', { expectRevision: 0, frozen: true });
    expect(plan.status).toBe(409);
  });
});

describe('no admin response carries a full identifier', () => {
  let server: Booted;
  const DEVICE = 'device-consoletest01';
  beforeAll(async () => {
    server = await boot({ DOOMCRAFT_STATIC: consoleStatic() });
    // A profile, and a refused write so the guard's ring has a row in it.
    await (await fetch(`${server.origin}/api/profile`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE, settings: { fov: 95 } }),
    })).text();
    await (await fetch(`${server.origin}/api/profile`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE, progress: { xp: 999999999 } }),
    })).text();
  }, 60_000);
  afterAll(() => { server?.child.kill('SIGKILL'); });

  /**
   * `docs/PLATFORM.md` §5.7: no admin serialiser may put a full device id on
   * the wire. `GET /api/admin/entitlement` did — `guard.recent(64)` carries one
   * on every row — so the surface built to watch for somebody probing the
   * reward gate was itself handing out the stable identifier of every player
   * who tripped it.
   */
  it('is true of EVERY /api/admin/* route, including the one that was leaking', async () => {
    const paths = [
      '/api/admin/whoami',
      '/api/admin/status',
      '/api/admin/flags',
      '/api/admin/entitlement',
      '/api/admin/audit',
      `/api/admin/journal?player=${DEVICE}`,
      `/api/admin/player?key=${DEVICE}`,
    ];
    for (const path of paths) {
      const res = await fetch(`${server.origin}${path}`, { headers: admin });
      expect(res.status, path).toBe(200);
      const text = await res.text();
      expect(text, `${path} put a full device id on the wire`).not.toContain(DEVICE);
    }
  });

  it('still answers the operator\'s question — the refusal is visible, the player is not', async () => {
    const body = await (await fetch(`${server.origin}/api/admin/entitlement`, { headers: admin }))
      .json() as { status: { violations: number }; recent: Array<{ device: string; stripped: string[] }> };
    expect(body.status.violations).toBeGreaterThan(0);
    expect(body.recent.length).toBeGreaterThan(0);
    expect(body.recent[0].device.length).toBe(8);
    expect(body.recent[0].stripped).toContain('progress.xp');
  });

  it('looks a player up by exact id and answers with a reconciliation', async () => {
    const body = await (await fetch(`${server.origin}/api/admin/player?key=${DEVICE}`, { headers: admin }))
      .json() as {
        onThisHost: boolean;
        reconcile: { xp: { stored: number | null; journal: number } };
        missing: Array<{ verb: string }>;
      };
    expect(body.onThisHost).toBe(true);
    expect(body.reconcile.xp.stored).toBe(0);
    expect(body.reconcile.xp.journal).toBe(0);
    // And it says, with every lookup, what it STILL cannot do — C6 built
    // ban/kick/currency out of the list and C6.1 built the merge undo and
    // reset-progress out, so the remaining honest gaps are real refunds
    // and the storage-shaped ones.
    expect(body.missing.length).toBeGreaterThan(3);
    expect(body.missing.map((m) => m.verb).join(' ')).toContain('Refund a real purchase');
    expect(body.missing.map((m) => m.verb).join(' ')).not.toContain('Undo a merge');
  });

  it('refuses a lookup key that is not a device id, in JSON', async () => {
    const res = await fetch(`${server.origin}/api/admin/player?key=../../etc/passwd`, { headers: admin });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    await res.text();
  });

  it('serves the operator MORE than the public status, and the public one loses the seed', async () => {
    const open = await (await fetch(`${server.origin}/api/status`)).json() as Record<string, unknown>;
    const gated = await (await fetch(`${server.origin}/api/admin/status`, { headers: admin }))
      .json() as Record<string, unknown>;

    // A room seed lets anybody generate the world offline and know the map
    // before they join it. docs/PLATFORM.md §5.9 names it as the reason it
    // wants /api/status gated; cutting the one dangerous field costs nothing.
    const openRooms = open.rooms as Array<Record<string, unknown>>;
    expect(openRooms.length).toBeGreaterThan(0);
    for (const r of openRooms) expect(Object.keys(r)).not.toContain('seed');
    expect(open.signal, 'the public route grew an operator field').toBeUndefined();
    expect(open.connections).toBeUndefined();

    // The operator gets both, plus the two counters that were computed every
    // second and served nowhere.
    const gatedRooms = gated.rooms as Array<Record<string, unknown>>;
    expect(Object.keys(gatedRooms[0])).toContain('seed');
    expect(gated.signal).toBeTruthy();
    expect((gated.connections as Record<string, unknown>).violations).toBeTruthy();
    expect(gated.journal).toBeTruthy();
    expect(gated.audit).toBeTruthy();
  });
});
