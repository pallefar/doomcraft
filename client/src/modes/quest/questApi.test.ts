/**
 * DOOMCRAFT — Quest content discovery: what the static build is NOT allowed to ask for.
 *
 * The live site is static hosting with no server (`docs/DEPLOY.md`). Quest used
 * to open by probing `GET /api/levels` and `GET /api/levels/<id>/data` and then
 * falling back to the bundled `import.meta.glob`. The campaign played fine, so
 * nothing failed — but every launch put two 404s and two red lines in the
 * console of doomcraft.vercel.app, and the first thing anyone does with a game
 * that "feels off" is open devtools. Two guaranteed 404s at the top of that log
 * is a game that looks broken.
 *
 * The page already knows the answer before it asks: `resolveServerUrl()` is ''
 * when no server is configured. So these tests are a REQUEST COUNT, not a
 * behaviour check — "the campaign still loads" was already true with the bug.
 * The load-bearing assertion in the static case is `calls.length === 0`.
 *
 * The other half matters just as much: a build that DOES have a server must
 * still ask it, on the server's own origin, and must still prefer the server's
 * compiled `.dcl` over the bundled source — because those are the exact bytes
 * the room is simulating.
 *
 * `questCatalog()` memoises per module instance, so every case re-imports the
 * module through `vi.resetModules()` rather than sharing one cached catalogue.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { compileLevel, encodeLevel, parseLevelJson } from '@shared/level';

const CONTENT = join(fileURLToPath(new URL('.', import.meta.url)), '../../../../content/levels');

/** A shipped level id that exists as a bundled file. */
const BUNDLED_ID = 'e1m1-hangar';
/** A second one, so "the server's bytes won" can be told apart from "the bundle won". */
const OTHER_ID = 'e1m2-coolant';

/** The compiled bytes a real server would serve for `id`. */
function dcl(id: string): Uint8Array {
  const src = parseLevelJson(readFileSync(join(CONTENT, `${id}.json`), 'utf8'));
  if (src === null) throw new Error(`fixture ${id} did not parse`);
  return encodeLevel(compileLevel(src));
}

interface Recorder { calls: string[] }

/**
 * Install a `fetch` that records every URL it is given.
 *
 * `answer` returns a response for a URL, or null to make the request fail the
 * way a static host does — which is the point: if the code under test asks, the
 * test must be able to see that it asked.
 */
function recordFetch(answer: (url: string) => unknown | null = () => null): Recorder {
  const rec: Recorder = { calls: [] };
  vi.stubGlobal('fetch', async (input: unknown): Promise<unknown> => {
    const url = String(input);
    rec.calls.push(url);
    const res = answer(url);
    if (res === null) return { ok: false, status: 404, async json() { return {}; }, async text() { return ''; }, async arrayBuffer() { return new ArrayBuffer(0); } };
    return res;
  });
  return rec;
}

function jsonResponse(body: unknown): unknown {
  return { ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } };
}

function bytesResponse(bytes: Uint8Array): unknown {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return { ok: true, status: 200, async arrayBuffer() { return buf; } };
}

/** A fresh module instance, so the memoised catalogue and API base are clean. */
async function freshQuest(): Promise<typeof import('./quest')> {
  vi.resetModules();
  return import('./quest');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/* ------------------------------------------------------------------------ *
 * The static build: zero requests, full campaign
 * ------------------------------------------------------------------------ */

describe('the static build never probes an API that is definitionally absent', () => {
  it('builds the whole campaign catalogue without making one request', async () => {
    const rec = recordFetch();
    const quest = await freshQuest();
    quest.setLevelApiBase('');

    const catalog = await quest.questCatalog();

    expect(rec.calls).toEqual([]);
    // ...and it is a real catalogue, not an empty one that trivially passes.
    expect(catalog.order.length).toBeGreaterThan(0);
    expect(catalog.order).toContain(BUNDLED_ID);
    expect(catalog.episodes.length).toBeGreaterThan(0);
  });

  it('loads a level without making one request', async () => {
    const rec = recordFetch();
    const quest = await freshQuest();
    quest.setLevelApiBase('');

    const level = await quest.loadQuestLevel(BUNDLED_ID);

    expect(rec.calls).toEqual([]);
    expect(level.meta.id).toBe(BUNDLED_ID);
    expect(level.spawns.length).toBeGreaterThan(0);
  });

  it('is what the shipped bundle actually resolves to, with no override', async () => {
    // No `setLevelApiBase` here: this is the real `resolveServerUrl()` with no
    // ?server, no localStorage, no <meta name="doomcraft-server"> and no
    // VITE_DOOMCRAFT_SERVER — i.e. exactly doomcraft.vercel.app.
    const rec = recordFetch();
    const quest = await freshQuest();

    await quest.questCatalog();
    const level = await quest.loadQuestLevel(BUNDLED_ID);

    expect(rec.calls).toEqual([]);
    expect(level.meta.id).toBe(BUNDLED_ID);
  });
});

/* ------------------------------------------------------------------------ *
 * The server build: still asks, still wins
 * ------------------------------------------------------------------------ */

describe('a build with a server configured still uses it', () => {
  const BASE = 'https://rooms.example';

  it('reads the manifest from the server origin, not the static host', async () => {
    const rec = recordFetch((url) => (
      url === `${BASE}/api/levels`
        ? jsonResponse({ levels: [{ id: BUNDLED_ID, name: 'HANGAR, SERVER CUT' }, { id: 'srv-only', name: 'SERVER ONLY' }] })
        : null
    ));
    const quest = await freshQuest();
    quest.setLevelApiBase(BASE);

    const catalog = await quest.questCatalog();

    expect(rec.calls).toEqual([`${BASE}/api/levels`]);
    expect(catalog.names.get(BUNDLED_ID)).toBe('HANGAR, SERVER CUT');
    // A level only the server has is playable; the bundle is not the ceiling.
    expect(catalog.order).toContain('srv-only');
  });

  it("prefers the server's compiled .dcl over the bundled source", async () => {
    // Serve e1m1's bytes when asked for e1m2. If the bundle had won we would
    // get e1m2 back, so the id is proof of which path ran.
    const served = dcl(BUNDLED_ID);
    const rec = recordFetch((url) => (
      url === `${BASE}/api/levels/${OTHER_ID}/data` ? bytesResponse(served) : null
    ));
    const quest = await freshQuest();
    quest.setLevelApiBase(BASE);

    const level = await quest.loadQuestLevel(OTHER_ID);

    expect(rec.calls).toEqual([`${BASE}/api/levels/${OTHER_ID}/data`]);
    expect(level.meta.id).toBe(BUNDLED_ID);
  });

  it('falls back to the bundle when the configured server does not answer', async () => {
    const rec = recordFetch(() => { throw new Error('ECONNREFUSED'); });
    const quest = await freshQuest();
    quest.setLevelApiBase(BASE);

    const level = await quest.loadQuestLevel(BUNDLED_ID);

    // It asked — that is correct here, a server IS configured — and recovered.
    expect(rec.calls).toEqual([`${BASE}/api/levels/${BUNDLED_ID}/data`]);
    expect(level.meta.id).toBe(BUNDLED_ID);
  });

  it('converts a ws:// server origin to http:// for the level API', async () => {
    const rec = recordFetch();
    const quest = await freshQuest();
    quest.setLevelApiBase('wss://rooms.example');

    await quest.loadQuestLevel(BUNDLED_ID);

    expect(rec.calls).toEqual([`https://rooms.example/api/levels/${BUNDLED_ID}/data`]);
  });
});
