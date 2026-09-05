/**
 * DOOMCRAFT V4f — `GET /api/variants` over real HTTP, against the real binary.
 *
 * The Loadout tab is a MENU surface: it is not in a room, so the variant table
 * the wire already carries to every CAP_VARIANTS client is out of reach. It
 * still has to name a token's equip slot, and that slot is
 * `variant:<base weapon>` — a fact that lives in the VARIANTS pack and on no
 * `ItemDef`. This route is how the menu learns it.
 *
 * WHY THE "NO PACK LIVE" CASE IS ASSERTED ON THE BODY AND NOT ONLY THE STATUS.
 * An unmatched GET on this server does NOT 404: it falls through `handleApi`
 * to `serveStatic`, whose single-page fallback serves `index.html` with **HTTP
 * 200** (server/src/index.ts, `serveStatic`'s `// Single-page fallback` branch).
 * So "assert the status is 200, not 404" is satisfied by DELETING THE ROUTE —
 * 200 either way — and proves nothing at all. The discriminating assertions are
 * the content type and the exact JSON body.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PackKind, type Release } from '@doomcraft/shared/packs';
import { CONTENT_VERSION } from '@doomcraft/shared/version';

import { PackInventory } from './packs.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, 'index.ts');

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

interface Boot { child: ChildProcess; origin: string }

async function boot(seedFn: (dataRoot: string) => void): Promise<Boot> {
  const port = await freePort();
  const staticRoot = mkdtempSync(join(tmpdir(), 'dc-var-static-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'dc-var-data-'));
  // A real index.html, so the SPA fallback is LIVE: without it an unmatched
  // GET would 404 and the body assertion below would be free.
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>x</title>', 'utf8');
  seedFn(dataRoot);
  const child = spawn(process.execPath, ['--import', 'tsx', serverEntry], {
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
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try { await (await fetch(`${origin}/health`)).text(); break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
  return { child, origin };
}

/* ------------------------------------------------------------------------ *
 * Case 1 — the bundled pack, live, exactly as an unconfigured host serves it
 * ------------------------------------------------------------------------ */

describe('GET /api/variants — the live pack', () => {
  let host: Boot;
  beforeAll(async () => { host = await boot(() => { /* no release document */ }); }, 60_000);
  afterAll(() => { host?.child.kill('SIGKILL'); });

  it('answers the bundled variants pack as id/base/name', async () => {
    const res = await fetch(`${host.origin}/api/variants`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    const body = await res.json() as { version: number; variants: Array<Record<string, unknown>> };
    expect(body.version).toBe(1);
    const byId = new Map(body.variants.map((v) => [v.id as string, v]));
    /*
     * THE TWO BASES THE UI HAS TO GET RIGHT. `variant:1` is the shotgun and
     * `variant:3` is the rocket; a tab that swapped them would be answered
     * "that variant is for weapon 1, not weapon 3" by `equipVerdict`.
     */
    expect(byId.get('shotgun-slug')?.base).toBe(1);
    expect(byId.get('rocket-swift')?.base).toBe(3);
    expect(byId.get('shotgun-slug')?.name).toBe('Slug Shotgun');
  });

  it('publishes strictly LESS than the in-room wire: no override values', async () => {
    /*
     * The room's `S2C.VARIANT_TABLE` carries all sixteen effective values to
     * any CAP_VARIANTS client, so nothing here is a new disclosure — but this
     * route is public and unauthenticated, and "it is already public
     * elsewhere" is a claim that has to stay true as the pack grows. The tab
     * needs id, base and name; anything else is surface for nothing.
     */
    const body = await (await fetch(`${host.origin}/api/variants`)).json() as {
      variants: Array<Record<string, unknown>>;
    };
    expect(body.variants.length).toBeGreaterThan(0);
    for (const v of body.variants) {
      expect(Object.keys(v).sort()).toEqual(['base', 'id', 'name']);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * Case 2 — obligation (c): a live release that declares NO variants pack
 * ------------------------------------------------------------------------ */

describe('GET /api/variants — no variants pack live', () => {
  let host: Boot;

  beforeAll(async () => {
    /*
     * The state under test is a LIVE RELEASE THAT NAMES NO KIND 7, which is
     * every release this project published before V4a and every release an
     * operator cuts from a host with no variants content. It cannot be reached
     * through the admin API — `createDraft` starts from `installedPacks()` and
     * an unconfigured host always has the bundled `content/variants.json` — so
     * the release document is written directly, from the SAME `installedPacks()`
     * the server will compute, minus kind 7. `unsatisfied()` only inspects the
     * packs a release DECLARES, so the release stays satisfiable and `live()`
     * returns it rather than Rule-E-falling back to the host fallback (which
     * would carry the variants pack and defeat the whole case).
     */
    const packs = new PackInventory().installedPacks().filter((p) => p.kind !== PackKind.VARIANTS);
    expect(packs.some((p) => p.kind === PackKind.ITEMS), 'the fixture lost the items pack too').toBe(true);
    const release: Release = {
      revision: 1,
      state: 'live',
      // Distinct from CONTENT_VERSION so `/api/version` can prove this stored
      // release is the live one and not the compiled-in host fallback.
      ordinal: CONTENT_VERSION + 1,
      packs,
      rolloutBp: 10_000,
      baseRevision: 0,
      gate: null,
      createdMs: 1,
      publishedMs: 1,
      note: 'V4f fixture: no variants pack',
    };
    host = await boot((dataRoot) => {
      mkdirSync(dataRoot, { recursive: true });
      writeFileSync(join(dataRoot, 'releases.json'), JSON.stringify({
        history: [release], liveRevision: 1, pendingRevision: 0, frozen: false, revision: 2,
      }), 'utf8');
    });
  }, 60_000);

  afterAll(() => { host?.child.kill('SIGKILL'); });

  it('the fixture really is live — otherwise every assertion below is free', async () => {
    const v = await (await fetch(`${host.origin}/api/version`)).json() as {
      release: { ordinal: number; unsatisfied: string[] };
    };
    expect(v.release.unsatisfied, 'the release fell back; kind 7 would be back with it').toEqual([]);
    expect(v.release.ordinal, 'this is the host fallback, not the seeded release')
      .toBe(CONTENT_VERSION + 1);
  });

  it('(c) answers 200 with {version: 0, variants: []} — a menu must not fail on absent content', async () => {
    const res = await fetch(`${host.origin}/api/variants`);
    expect(res.status).toBe(200);
    /*
     * Both of these fail on a build with the route removed, where the SPA
     * fallback answers 200 text/html; the status alone does not.
     */
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    expect(await res.json()).toEqual({ version: 0, variants: [] });
  });

  it('and /api/items is unaffected, so this is absence and not an outage', async () => {
    const items = await (await fetch(`${host.origin}/api/items`)).json() as {
      version: number; items: unknown[];
    };
    expect(items.version).toBe(1);
    expect(items.items.length).toBeGreaterThan(5);
  });
});
