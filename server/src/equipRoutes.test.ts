/**
 * DOOMCRAFT — equipping over the wire: the REAL binary, a fresh
 * DOOMCRAFT_DATA, a seeded owner, and POST /api/equip driven over real HTTP,
 * read back through GET /api/profile — the same lens the Loadout tab uses.
 *
 * A second, flagless boot proves the kill switch: with `economy_items`
 * unforced the route 404s and a probe learns nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, 'index.ts');

const ALFA = 'aeaeaeaeaeaeaeaeaeaeaeae';
const RUST = 'items@1:skin-rust-marine';
const HAZARD = 'items@1:skin-void-hazard';
const TITLE = 'items@1:title-hangar-rat';
const NOWHERE = 'items@9:skin-from-nowhere';

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

function seedOwner(dataRoot: string, device: string): void {
  const shard = join(dataRoot, 'profiles', device.slice(0, 2));
  mkdirSync(shard, { recursive: true });
  writeFileSync(join(shard, `${device}.json`), JSON.stringify({
    version: 5, deviceId: device, createdMs: 1_700_000_000_000,
    inventory: {
      items: [RUST, TITLE, HAZARD, NOWHERE].map((ref) => ({ ref, ms: 1, source: 'drop', sourceId: 'seed' })),
      equippedSkin: '', title: '',
    },
    moderation: { banned: false, bannedUntilMs: 0, reason: '', revokedItems: [{ ref: HAZARD, ms: 2, reason: 'seeded take-back' }] },
  }), 'utf8');
}

interface Boot { child: ChildProcess; origin: string }

async function boot(env: Record<string, string>, seed: (dataRoot: string) => void): Promise<Boot> {
  const port = await freePort();
  const staticRoot = mkdtempSync(join(tmpdir(), 'dc-equip-static-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'dc-equip-data-'));
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>x</title>', 'utf8');
  seed(dataRoot);
  const child = spawn(process.execPath, ['--import', 'tsx', serverEntry], {
    cwd: join(here, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      DOOMCRAFT_STATIC: staticRoot, DOOMCRAFT_DATA: dataRoot,
      DOOMCRAFT_BOTS: '0', DOOMCRAFT_PREWARM: '0',
      ...env,
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
  return { child, origin };
}

let on: Boot;
let off: Boot;

beforeAll(async () => {
  [on, off] = await Promise.all([
    boot(
      { DOOMCRAFT_FLAGS: '{"rules":{"economy_items":{"force":true}}}' },
      (dataRoot) => { seedOwner(dataRoot, ALFA); },
    ),
    boot({}, (dataRoot) => { seedOwner(dataRoot, ALFA); }),
  ]);
}, 90_000);

afterAll(() => { on?.child.kill('SIGKILL'); off?.child.kill('SIGKILL'); });

async function call(origin: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${origin}${path}`, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, json };
}

async function claims(origin: string, device: string): Promise<{ equippedSkin: string; title: string }> {
  const { status, json } = await call(origin, `/api/profile?device=${device}`);
  expect(status).toBe(200);
  const inv = (json.profile as { inventory: { equippedSkin: string; title: string } }).inventory;
  return { equippedSkin: inv.equippedSkin, title: inv.title };
}

describe('the kill switch', () => {
  it('404s every equip when economy_items is not resolved on', async () => {
    const { status } = await call(off.origin, '/api/equip', { deviceId: ALFA, skin: RUST });
    expect(status).toBe(404);
  });
});

describe('POST /api/equip', () => {
  it('refuses a caller with no device identity', async () => {
    const { status } = await call(on.origin, '/api/equip', { skin: RUST });
    expect(status).toBe(400);
  });

  it('refuses an empty request rather than inventing a slot', async () => {
    const { status } = await call(on.origin, '/api/equip', { deviceId: ALFA });
    expect(status).toBe(400);
  });

  it('equips an owned skin and title in one call, and the profile says so', async () => {
    const { status, json } = await call(on.origin, '/api/equip', { deviceId: ALFA, skin: RUST, title: TITLE });
    expect(status).toBe(200);
    expect(json.inventory).toEqual({ equippedSkin: RUST, title: TITLE });
    expect(await claims(on.origin, ALFA)).toEqual({ equippedSkin: RUST, title: TITLE });
  });

  it('refuses the unowned, and a mixed request writes NEITHER slot', async () => {
    const before = await claims(on.origin, ALFA);
    const { status, json } = await call(on.origin, '/api/equip', {
      deviceId: ALFA, title: '', skin: 'items@1:skin-ember-core',
    });
    expect(status).toBe(400);
    expect(String(json.error)).toContain('own');
    // Both-or-nothing: the valid '' title unequip must NOT have landed.
    expect(await claims(on.origin, ALFA)).toEqual(before);
  });

  it('refuses a kind mismatch — a title is not a skin', async () => {
    const { status, json } = await call(on.origin, '/api/equip', { deviceId: ALFA, skin: TITLE });
    expect(status).toBe(400);
    expect(String(json.error)).toContain('title');
  });

  it('refuses a revoked item even though it is still owned', async () => {
    const { status, json } = await call(on.origin, '/api/equip', { deviceId: ALFA, skin: HAZARD });
    expect(status).toBe(400);
    expect(String(json.error)).toContain('revoked');
  });

  it('refuses a ref no installed pack defines, rather than guessing its kind', async () => {
    const { status, json } = await call(on.origin, '/api/equip', { deviceId: ALFA, skin: NOWHERE });
    expect(status).toBe(400);
    expect(String(json.error)).toContain('pack');
  });

  it("'' unequips one slot and leaves the other claimed", async () => {
    const { status, json } = await call(on.origin, '/api/equip', { deviceId: ALFA, skin: '' });
    expect(status).toBe(200);
    expect(json.inventory).toEqual({ equippedSkin: '', title: TITLE });
    expect(await claims(on.origin, ALFA)).toEqual({ equippedSkin: '', title: TITLE });
  });
});
