/**
 * DOOMCRAFT — the trade-up over the wire: the REAL binary, a seeded crafter,
 * POST /api/craft driven over real HTTP and read back through /api/profile.
 * Proves the nonce makes a replay a no-op, the fee moves through the journal
 * exactly once, and a copy sitting on a live trade's table is not material.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatItemRef, parseItemRef } from '@doomcraft/shared/items';
import { MAX_PACK_VERSION } from '@doomcraft/shared/packs';

import { grantRefusal } from './persistence.js';
import { TRADE_ITEM_COOLDOWN_MS, TRADE_MIN_ACCOUNT_AGE_MS, TRADE_MIN_MATCHES } from './trades.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, 'index.ts');

const ALFA = 'afafafafafafafafafafafaf';
const BRAVO = 'bfbfbfbfbfbfbfbfbfbfbfbf';
const CHARLIE = 'cfcfcfcfcfcfcfcfcfcfcfcf';
const DELTA = 'dfdfdfdfdfdfdfdfdfdfdfdf';
const ECHO = 'efefefefefefefefefefefef';
const RUST = 'items@1:skin-rust-marine';     // common skin in the live pack
const HAZARD = 'skin-void-hazard';           // uncommon skin — the target
const EMBER = 'items@1:skin-ember-core';
const SLUG_ID = 'weapon_variant-shotgun-slug';   // uncommon token in the live pack
const SLUG = `items@1:${SLUG_ID}`;

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

function seed(dataRoot: string, device: string, refs: string[], scrap: number): void {
  const shard = join(dataRoot, 'profiles', device.slice(0, 2));
  mkdirSync(shard, { recursive: true });
  const old = Date.now() - TRADE_ITEM_COOLDOWN_MS - 3_600_000;
  writeFileSync(join(shard, `${device}.json`), JSON.stringify({
    version: 5, deviceId: device,
    createdMs: Date.now() - TRADE_MIN_ACCOUNT_AGE_MS - 3_600_000,
    stats: { matches: TRADE_MIN_MATCHES },
    economy: { scrap, lifetimeScrap: scrap, day: '', dayXp: 0, dayScrap: 0, dayMatches: 0 },
    inventory: { items: refs.map((ref, i) => ({ ref, ms: old + i, source: 'drop', sourceId: `seed-${i}` })), equippedSkin: '', title: '' },
  }), 'utf8');
}

interface Boot { child: ChildProcess; origin: string }

async function boot(env: Record<string, string>, seedFn: (dataRoot: string) => void): Promise<Boot> {
  const port = await freePort();
  const staticRoot = mkdtempSync(join(tmpdir(), 'dc-craft-static-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'dc-craft-data-'));
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

const FLAGS_ON = '{"rules":{"economy_items":{"force":true},"economy_trading":{"force":true}}}';

/**
 * A packs root whose newest items version is 100000 — installable today
 * (`PackInventory.itemsVersions` accepts any integer >= 1) and OUTSIDE what
 * `parseItemRef` will read back (`items@(\d{1,5})`, capped at 0xffff). Every
 * ref the live pack can mint is therefore unparseable, which is the ONE
 * product-reachable way to make `grantDrops` land nothing after a green craft
 * verdict. It is what obligation (a2) needs and it is also a real defect in
 * its own right — see the report.
 */
beforeAll(async () => {
  [on, off] = await Promise.all([
    boot(
      { DOOMCRAFT_FLAGS: FLAGS_ON },
      (dataRoot) => {
        seed(dataRoot, ALFA, [RUST, RUST, RUST, RUST], 500);
        seed(dataRoot, BRAVO, [RUST, RUST, RUST, RUST], 500);
        seed(dataRoot, CHARLIE, [EMBER], 500);
        // V4e (a): exactly three free copies and exactly the uncommon fee.
        seed(dataRoot, DELTA, [RUST, RUST, RUST], 50);
      },
    ),
    boot({}, (dataRoot) => { seed(dataRoot, ALFA, [RUST, RUST, RUST], 500); }),
  ]);
}, 120_000);

afterAll(() => {
  on?.child.kill('SIGKILL');
  off?.child.kill('SIGKILL');
});

async function call(origin: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${origin}${path}`, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
}

async function stock(device: string, origin = on.origin): Promise<{ refs: string[]; scrap: number }> {
  const { status, json } = await call(origin, `/api/profile?device=${device}`);
  expect(status).toBe(200);
  const profile = json.profile as {
    inventory: { items: Array<{ ref: string; source: string }> };
    economy: { scrap: number };
  };
  return { refs: profile.inventory.items.map((i) => i.ref).sort(), scrap: profile.economy.scrap };
}

describe('the kill switch', () => {
  it('404s crafting when economy_items is not resolved on', async () => {
    const { status } = await call(off.origin, '/api/craft', { deviceId: ALFA, source: RUST, target: HAZARD, nonce: 'nonce-off-1' });
    expect(status).toBe(404);
  });
});

describe('POST /api/craft', () => {
  it('refuses a missing or malformed nonce — idempotency is not optional', async () => {
    expect((await call(on.origin, '/api/craft', { deviceId: ALFA, source: RUST, target: HAZARD })).status).toBe(400);
    expect((await call(on.origin, '/api/craft', { deviceId: ALFA, source: RUST, target: HAZARD, nonce: 'x' })).status).toBe(400);
  });

  it('crafts 3 duplicates + 50 Scrap into the chosen uncommon, and a replayed nonce is a no-op', async () => {
    const nonce = 'craft-routes-nonce-0001';
    const first = await call(on.origin, '/api/craft', { deviceId: ALFA, source: RUST, target: HAZARD, nonce });
    expect(first.status).toBe(200);
    expect(first.json.crafted).toBe(`items@1:${HAZARD}`);
    expect(first.json.replay).toBe(false);
    expect(first.json.balance).toBe(450);

    const after = await stock(ALFA);
    expect(after.refs).toEqual([RUST, `items@1:${HAZARD}`].sort());
    expect(after.scrap).toBe(450);

    // The replay: same nonce, same answer, NOTHING moves again.
    const again = await call(on.origin, '/api/craft', { deviceId: ALFA, source: RUST, target: HAZARD, nonce });
    expect(again.status).toBe(200);
    expect(again.json.replay).toBe(true);
    expect(again.json.crafted).toBe(`items@1:${HAZARD}`);
    expect(await stock(ALFA)).toEqual(after);
  });

  it('refuses when the copies left are not enough, with the count in the sentence', async () => {
    const { status, json } = await call(on.origin, '/api/craft', { deviceId: ALFA, source: RUST, target: HAZARD, nonce: 'craft-routes-nonce-0002' });
    expect(status).toBe(400);
    expect(String(json.error)).toContain('you have 1');
  });

  it('copies on a live trade table are not material', async () => {
    // BRAVO opens, CHARLIE joins, BRAVO puts two rust copies on the table.
    const opened = await call(on.origin, '/api/trade/open', { deviceId: BRAVO });
    expect(opened.status).toBe(200);
    const trade = opened.json.trade as { id: string; code: string };
    const joined = await call(on.origin, '/api/trade/join', { deviceId: CHARLIE, code: trade.code });
    expect(joined.status).toBe(200);
    const offered = await call(on.origin, '/api/trade/offer', { deviceId: BRAVO, tradeId: trade.id, refs: [RUST, RUST] });
    expect(offered.status).toBe(200);

    // 4 owned − 2 escrowed = 2 free < 3: refused, and the sentence says why.
    const { status, json } = await call(on.origin, '/api/craft', { deviceId: BRAVO, source: RUST, target: HAZARD, nonce: 'craft-routes-nonce-0003' });
    expect(status).toBe(400);
    expect(String(json.error)).toContain('trade table');

    /*
     * V4e — and the ANSWER the tab reads has to carry that reservation, or the
     * client cannot possibly agree with this refusal. `GET /api/profile` now
     * reports the escrow's hold beside the profile; without it `reserved` is
     * `{}` on the client and the Loadout tab offers an enabled Craft button
     * against this exact 400.
     */
    const profileAnswer = await call(on.origin, `/api/profile?device=${BRAVO}`);
    expect(profileAnswer.status).toBe(200);
    expect(profileAnswer.json.reserved).toEqual({ [RUST]: 2 });

    // Cancel frees the copies; the same craft (new nonce) now goes through.
    expect((await call(on.origin, '/api/trade/cancel', { deviceId: BRAVO, tradeId: trade.id })).status).toBe(200);
    expect((await call(on.origin, `/api/profile?device=${BRAVO}`)).json.reserved).toEqual({});
    const freed = await call(on.origin, '/api/craft', { deviceId: BRAVO, source: RUST, target: HAZARD, nonce: 'craft-routes-nonce-0004' });
    expect(freed.status).toBe(200);
    expect(freed.json.crafted).toBe(`items@1:${HAZARD}`);
  });
});

/* ------------------------------------------------------------------------ *
 * V4e — acquisition: the entry recipe, over the real wire
 * ------------------------------------------------------------------------ */

describe('V4e: the entry craft is where variant supply comes from', () => {
  it('(a) three common skins + 50 Scrap put a Slug token IN THE INVENTORY', async () => {
    /*
     * THE ASSERTION IS THE INVENTORY, never the route's `crafted` field
     * (§0 rule 38). `crafted` used to be `landed[0]?.ref ?? plan.targetRef`,
     * so with the mint door shut it reported the Slug the player did not get
     * and this test would have passed against a server that granted nothing.
     *
     * Measured with V4b's blanket refusal restored (`grantRefusal` minus the
     * craft exemption, and with the old `??` fallback): Slug 0, Rust 0,
     * Scrap 0 — three copies and the fee gone, 200 OK, nothing delivered.
     */
    const before = await stock(DELTA);
    expect(before.refs).toEqual([RUST, RUST, RUST]);
    expect(before.scrap).toBe(50);

    const { status, json } = await call(on.origin, '/api/craft', {
      deviceId: DELTA, source: RUST, target: SLUG_ID, nonce: 'craft-v4e-entry-001',
    });
    expect(status).toBe(200);

    const after = await stock(DELTA);
    expect(after.refs.filter((r) => r === SLUG)).toEqual([SLUG]);
    expect(after.refs.filter((r) => r === RUST)).toEqual([]);
    expect(after.scrap).toBe(0);
    expect(json.crafted).toBe(SLUG);
  });

  it('(a2) the delivery pre-check refuses a ref the grant loop would refuse', () => {
    /*
     * THIS TEST LOST ITS LEVER, AND THAT IS THE GOOD OUTCOME. It used to boot a
     * host with a live items pack at version 100000 — legal to install, because
     * `itemsVersions` accepted any integer >= 1, and unreadable by
     * `parseItemRef` — so `craftVerdict` said yes while `grantDrops` could
     * deliver nothing. That was the separating input, and it was a DEFECT being
     * used as a fixture (HANDOVER §3).
     *
     * The defect is now closed at the door: `isPackVersion` bounds discovery,
     * lookup AND minting at MAX_PACK_VERSION, so no installed pack can produce
     * an unreadable ref and the integration fixture can no longer reach this
     * branch. Rather than leave a test that boots a host and proves nothing —
     * with the pack at 100000 now invisible, that host silently falls back to
     * items@1 and crafts SUCCEED — the proof moves to the predicate the route
     * actually calls, driven with the exact input the retired fixture produced.
     *
     * The pre-check stays. It is defence in depth for a state content can no
     * longer create, and `index.ts` asks it BEFORE anything is consumed.
     */
    const unreadable = formatItemRef(100000, 'skin-void-hazard');
    expect(parseItemRef(unreadable), 'the ref became readable — this test is asleep').toBeNull();

    const blocked = grantRefusal(unreadable, 'craft');
    expect(blocked).not.toBeNull();
    expect(String(blocked)).toContain('is not an item ref');

    // The control: the same id at a version a pack may actually be installed
    // at is deliverable, so the refusal is about the VERSION and not about the
    // item or the source.
    expect(grantRefusal(formatItemRef(1, 'skin-void-hazard'), 'craft')).toBeNull();
    expect(grantRefusal(formatItemRef(MAX_PACK_VERSION, 'skin-void-hazard'), 'craft')).toBeNull();
  });
});
