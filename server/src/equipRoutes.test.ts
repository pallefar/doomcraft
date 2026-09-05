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
/* V4c. Both exist in content/items.json (items@1) and both name a row of
 * content/variants.json: shotgun-slug is base 1, rocket-swift is base 3. */
const SLUG = 'items@1:weapon_variant-shotgun-slug';
const SWIFT = 'items@1:weapon_variant-rocket-swift';

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
      items: [RUST, TITLE, HAZARD, NOWHERE, SLUG, SWIFT]
        .map((ref) => ({ ref, ms: 1, source: 'drop', sourceId: 'seed' })),
      equippedSkin: '', title: '', variants: {},
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

interface Claims { equippedSkin: string; title: string; variants: Record<string, string> }

async function claims(origin: string, device: string): Promise<Claims> {
  const { status, json } = await call(origin, `/api/profile?device=${device}`);
  expect(status).toBe(200);
  const inv = (json.profile as { inventory: Claims }).inventory;
  return { equippedSkin: inv.equippedSkin, title: inv.title, variants: inv.variants };
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
    expect(json.inventory).toEqual({ equippedSkin: RUST, title: TITLE, variants: {} });
    expect(await claims(on.origin, ALFA)).toEqual({ equippedSkin: RUST, title: TITLE, variants: {} });
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
    expect(json.inventory).toEqual({ equippedSkin: '', title: TITLE, variants: {} });
    expect(await claims(on.origin, ALFA)).toEqual({ equippedSkin: '', title: TITLE, variants: {} });
  });
});

/* ------------------------------------------------------------------------ *
 * V4c — the variant slots, over the same door
 *
 * The route answered 400 "nothing to equip" for every `variant:*` key before
 * this phase: it iterated two literal slots, so the key was never read and
 * `wants.size` stayed 0. These run against the REAL binary and the REAL live
 * release, so `ref -> ItemDef.variantId -> VariantDef.base` is resolved out of
 * content/items.json and content/variants.json rather than out of a stub.
 * ------------------------------------------------------------------------ */

describe('POST /api/equip — variant slots', () => {
  it('equips a shotgun variant on the shotgun slot and the profile says so', async () => {
    const { status, json } = await call(on.origin, '/api/equip', { deviceId: ALFA, 'variant:1': SLUG });
    expect(status).toBe(200);
    expect((json.inventory as Claims).variants).toEqual({ 1: SLUG });
    expect((await claims(on.origin, ALFA)).variants).toEqual({ 1: SLUG });
  });

  /*
   * THE ONE THAT MATTERS. A kind-only door answers 200 here and the arsenal
   * then resolves the PISTOL row — the player is told yes and fires base
   * pistol damage, with no error on any path.
   */
  it('refuses a shotgun variant on the pistol slot', async () => {
    const before = await claims(on.origin, ALFA);
    const { status, json } = await call(on.origin, '/api/equip', { deviceId: ALFA, 'variant:0': SLUG });
    expect(status).toBe(400);
    expect(String(json.error)).toContain('weapon 1');
    expect(await claims(on.origin, ALFA)).toEqual(before);
  });

  it('refuses a skin on a variant slot and a variant token on the skin slot', async () => {
    const a = await call(on.origin, '/api/equip', { deviceId: ALFA, 'variant:1': RUST });
    expect(a.status).toBe(400);
    const b = await call(on.origin, '/api/equip', { deviceId: ALFA, skin: SLUG });
    expect(b.status).toBe(400);
  });

  it('writes NEITHER slot when a cosmetic slot is fine and the variant slot is not', async () => {
    const before = await claims(on.origin, ALFA);
    const { status } = await call(on.origin, '/api/equip', {
      deviceId: ALFA, title: TITLE, 'variant:3': SLUG,
    });
    expect(status).toBe(400);
    expect(await claims(on.origin, ALFA)).toEqual(before);
  });

  it("'' unequips the variant slot and deletes the key", async () => {
    expect((await call(on.origin, '/api/equip', { deviceId: ALFA, 'variant:3': SWIFT })).status).toBe(200);
    expect((await claims(on.origin, ALFA)).variants).toEqual({ 1: SLUG, 3: SWIFT });
    const { status, json } = await call(on.origin, '/api/equip', { deviceId: ALFA, 'variant:3': '' });
    expect(status).toBe(200);
    expect((json.inventory as Claims).variants).toEqual({ 1: SLUG });
  });

  it('still refuses a request naming no slot at all', async () => {
    const { status, json } = await call(on.origin, '/api/equip', { deviceId: ALFA, 'variant:99': SLUG });
    expect(status).toBe(400);
    expect(String(json.error)).toContain('nothing to equip');
  });
});

/* ------------------------------------------------------------------------ *
 * V4c end to end: the equipped claim comes back down the SOCKET
 *
 * Everything above stops at the profile. This is the other end of the phase —
 * a real ticket, a real /ws upgrade into a real production room, and the slot
 * map the SERVER resolved, read off the wire.
 *
 * It is the only test that exercises the production wiring as a whole: the
 * upgrade handler's `await store.load(...)` warm-up, `conn.deviceId =
 * ticket.profileKey` landing before HELLO, the room factory's `variantClaims`
 * closure, `store.peek`, the room's OWN decoded ordering, and the `+ 1`.
 * Every one of those is invisible to a unit test — the room factory is a
 * literal in a 4000-line file, and `room.modes.test.ts` supplies its own
 * claim function.
 *
 * The assertion is the SLOT BYTE and not the damage, deliberately and with
 * the limit stated: a socket is told the table and its own slot map, and the
 * server's arsenal is not on the wire. `variantClaims.test.ts` is where the
 * slot becomes damage; this is where the slot becomes a byte the client will
 * resolve against the very rows in the same message. A non-zero byte here is
 * only meaningful because the row it names is asserted too.
 * ------------------------------------------------------------------------ */

describe('the equipped variant reaches the room over a real socket', () => {
  async function ticketFor(device: string): Promise<string> {
    const { status, json } = await call(on.origin, '/api/session/ticket', { deviceId: device });
    expect(status).toBe(200);
    const t = String(json.ticket ?? '');
    expect(t.length, 'no ticket minted').toBeGreaterThan(8);
    return t;
  }

  /** HELLO on a real /ws socket with a real ticket; every binary frame after. */
  async function joinAndCollect(ticket: string | null): Promise<Uint8Array[]> {
    const { WebSocket } = await import('ws');
    const { PacketWriter, encodeHello, CAP_VARIANTS } = await import('@doomcraft/shared/protocol');
    const url = new URL(on.origin.replace('http://', 'ws://') + '/ws');
    if (ticket !== null) url.searchParams.set('t', ticket);
    const ws = new WebSocket(url.toString());
    const frames: Uint8Array[] = [];
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('socket did not open')), 10_000);
      ws.on('open', () => { clearTimeout(timer); res(); });
      ws.on('error', (e: Error) => { clearTimeout(timer); rej(e); });
    });
    ws.on('message', (d: Buffer) => { frames.push(new Uint8Array(d)); });
    ws.send(encodeHello(new PacketWriter(256), 'v4c-probe', 0, CAP_VARIANTS).copy());
    await new Promise((r) => setTimeout(r, 1500));
    ws.close();
    return frames;
  }

  async function tableOf(ticket: string | null) {
    const { PacketReader, S2C } = await import('@doomcraft/shared/protocol');
    const { createVariantTableMessage, decodeVariantTable } =
      await import('@doomcraft/shared/variants');
    const frames = await joinAndCollect(ticket);
    const raw = frames.find((f) => f.length > 0 && f[0] === S2C.VARIANT_TABLE);
    expect(raw, 'no S2C.VARIANT_TABLE arrived at all').toBeDefined();
    const decoded = decodeVariantTable(new PacketReader(raw as Uint8Array), createVariantTableMessage());
    expect(decoded, 'the room sent a table this client refuses').not.toBeNull();
    return decoded!;
  }

  it('tells a ticketed owner the slot of the row they equipped', async () => {
    // Re-state the claim rather than relying on the tests above having run.
    expect((await call(on.origin, '/api/equip', { deviceId: ALFA, 'variant:1': SLUG })).status)
      .toBe(200);
    expect((await claims(on.origin, ALFA)).variants).toEqual({ 1: SLUG });

    const decoded = await tableOf(await ticketFor(ALFA));

    // The premise. A byte of 1 means nothing unless row 0 is the row the
    // player owns — that is the whole ordering argument, on the real wire.
    expect(decoded.variants.length, 'the room served an EMPTY table').toBeGreaterThan(0);
    expect(decoded.variants.map((r) => r.id)).toEqual(['shotgun-slug', 'rocket-swift']);

    // THE BYTE. Row 0 is slot 1; writing the row index would send 0, which is
    // the base, and no error would appear anywhere.
    expect(decoded.slots[1], 'the shotgun byte').toBe(1);
    expect(decoded.slots[3], 'nothing is equipped on the rocket').toBe(0);
    expect([...decoded.slots].filter((v) => v !== 0)).toHaveLength(1);
  });

  it('tells a socket with no ticket nothing but zeroes, from the same room', async () => {
    const decoded = await tableOf(null);
    // Same table — so the difference below is about the CLAIM and not about
    // the room having no content.
    expect(decoded.variants.map((r) => r.id)).toEqual(['shotgun-slug', 'rocket-swift']);
    expect([...decoded.slots].filter((v) => v !== 0)).toEqual([]);
  });
}, 60_000);
