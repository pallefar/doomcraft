/**
 * DOOMCRAFT — the escrow over the wire: the REAL binary, spawned with a
 * fresh DOOMCRAFT_DATA, two seeded traders, and the whole open → join →
 * offer → confirm → settled arc driven over real HTTP — because the failure
 * this repo keeps refusing to re-learn is code that compiles, passes tests
 * and is connected to nothing. The settled inventories are read back
 * through `/api/admin/player`, the same lens an operator would use.
 *
 * A second, flagless boot proves the kill switch: with `economy_trading`
 * unforced every trade verb 404s, and a probe learns nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { utcDayKey, utcWeekKey } from '@doomcraft/shared/challenges';

import { TRADE_ITEM_COOLDOWN_MS, TRADE_MIN_ACCOUNT_AGE_MS, TRADE_MIN_MATCHES } from './trades.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, 'index.ts');

const ALFA = 'adadadadadadadadadadadad';
const BRAVO = 'bdbdbdbdbdbdbdbdbdbdbdbd';
/** Challenge progress from a PAST period — the view roll must zero it. */
const STALE = 'cdcdcdcdcdcdcdcdcdcdcdcd';
/** Challenge progress from the CURRENT period — the view must show it. */
const FRESH = 'dddddddddddddddddddddde1';
const RUST = 'items@1:skin-rust-marine';
const EMBER = 'items@1:skin-ember-core';
const ADMIN_TOKEN = 'trade-routes-test-token';

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

function seedTrader(dataRoot: string, device: string, refs: string[]): void {
  const shard = join(dataRoot, 'profiles', device.slice(0, 2));
  mkdirSync(shard, { recursive: true });
  const old = Date.now() - TRADE_ITEM_COOLDOWN_MS - 3_600_000;
  writeFileSync(join(shard, `${device}.json`), JSON.stringify({
    version: 5, deviceId: device,
    createdMs: Date.now() - TRADE_MIN_ACCOUNT_AGE_MS - 3_600_000,
    stats: {
      matches: TRADE_MIN_MATCHES,
      last: { ms: Date.now(), kills: 18, deaths: 4, won: true, seconds: 372, bestStreak: 7, xp: 320, scrap: 41 },
    },
    inventory: { items: refs.map((ref) => ({ ref, ms: old, source: 'drop', sourceId: 'seed' })), equippedSkin: '', title: '' },
  }), 'utf8');
}

function seedChallenger(
  dataRoot: string, device: string, challenges: Record<string, unknown>,
): void {
  const shard = join(dataRoot, 'profiles', device.slice(0, 2));
  mkdirSync(shard, { recursive: true });
  writeFileSync(join(shard, `${device}.json`), JSON.stringify({
    version: 6, deviceId: device, createdMs: Date.now() - 86_400_000,
    challenges,
  }), 'utf8');
}

interface Boot { child: ChildProcess; origin: string }

async function boot(env: Record<string, string>, seed: (dataRoot: string) => void): Promise<Boot> {
  const port = await freePort();
  const staticRoot = mkdtempSync(join(tmpdir(), 'dc-trade-static-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'dc-trade-data-'));
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
      {
        DOOMCRAFT_FLAGS: '{"rules":{"economy_trading":{"force":true},"economy_competitions":{"force":true},"share_cards":{"force":true}}}',
        DOOMCRAFT_ADMIN_TOKEN: ADMIN_TOKEN,
      },
      (dataRoot) => {
        seedTrader(dataRoot, ALFA, [RUST, RUST]);
        seedTrader(dataRoot, BRAVO, [EMBER]);
        seedChallenger(dataRoot, STALE, {
          day: '2020-01-01', week: '2020-W01',
          counts: { 'daily.kill-25': 25, 'weekly.wins-10': 10 },
          done: ['daily.kill-25', 'weekly.wins-10'],
        });
        seedChallenger(dataRoot, FRESH, {
          day: utcDayKey(Date.now()), week: utcWeekKey(Date.now()),
          counts: { 'daily.kill-25': 10 }, done: ['daily.win-1'],
        });
      },
    ),
    boot({}, (dataRoot) => { seedTrader(dataRoot, ALFA, [RUST]); }),
  ]);
}, 90_000);

afterAll(() => { on?.child.kill('SIGKILL'); off?.child.kill('SIGKILL'); });

async function call(origin: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${origin}${path}`, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = null; }
  return { status: res.status, json };
}

function tradeOf(json: Record<string, unknown> | null): Record<string, unknown> {
  return (json?.trade ?? {}) as Record<string, unknown>;
}

async function itemsOf(device: string): Promise<string[]> {
  const res = await fetch(`${on.origin}/api/admin/player?key=${device}`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  const body = await res.json() as { inventory: { items: { ref: string }[] } };
  return body.inventory.items.map((i) => i.ref).sort();
}

describe('the whole arc, over HTTP', () => {
  it('open → join → offer → confirm both → settled, and the items really moved', async () => {
    const opened = await call(on.origin, '/api/trade/open', { deviceId: ALFA });
    expect(opened.status).toBe(200);
    const id = tradeOf(opened.json).id as string;
    const code = tradeOf(opened.json).code as string;
    expect(code).toMatch(/^TR[0-9A-Z]{6}$/);

    const joined = await call(on.origin, '/api/trade/join', { deviceId: BRAVO, code });
    expect(joined.status).toBe(200);
    expect(tradeOf(joined.json).state).toBe('active');

    expect((await call(on.origin, '/api/trade/offer', { deviceId: ALFA, tradeId: id, refs: [RUST] })).status).toBe(200);
    expect((await call(on.origin, '/api/trade/offer', { deviceId: BRAVO, tradeId: id, refs: [EMBER] })).status).toBe(200);

    const one = await call(on.origin, '/api/trade/confirm', { deviceId: ALFA, tradeId: id });
    expect(tradeOf(one.json).state).toBe('active');
    const two = await call(on.origin, '/api/trade/confirm', { deviceId: BRAVO, tradeId: id });
    expect(tradeOf(two.json).state).toBe('settled');

    expect(await itemsOf(ALFA)).toEqual([EMBER, RUST].sort());
    expect(await itemsOf(BRAVO)).toEqual([RUST]);

    // Both parties can read the outcome; a stranger cannot.
    const mine = await call(on.origin, `/api/trade/state?id=${id}&device=${ALFA}`);
    expect(tradeOf(mine.json).state).toBe('settled');
    const stranger = await call(on.origin, `/api/trade/state?id=${id}&device=${'cf'.repeat(12)}`);
    expect(stranger.status).toBe(404);
  });

  it('an ineligible caller is refused with the sentence, not a stack trace', async () => {
    const fresh = await call(on.origin, '/api/trade/open', { deviceId: 'efefefefefefefefefefefef' });
    expect(fresh.status).toBe(403);
    expect(String(fresh.json?.error)).toContain('no profile');
  });
});

describe('competitions over the wire', () => {
  it('a season exists at boot and the flagless host hides the tab', async () => {
    const view = await call(on.origin, `/api/competitions?device=${ALFA}`);
    expect(view.status).toBe(200);
    const list = (view.json?.competitions ?? []) as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].kind).toBe('season');
    expect(list[0].state).toBe('running');

    const standings = await call(on.origin, `/api/competitions/standings?id=${list[0].id}&device=${ALFA}`);
    expect(standings.status).toBe(200);

    const hidden = await call(off.origin, `/api/competitions?device=${ALFA}`);
    expect(hidden.status).toBe(404);
  });
});

describe('challenges over the wire (Studio S4)', () => {
  it('serves the shipped board with per-caller progress; the flagless host hides it', async () => {
    const view = await call(on.origin, `/api/challenges?device=${FRESH}`);
    expect(view.status).toBe(200);
    expect(view.json?.day).toBe(utcDayKey(Date.now()));
    expect(view.json?.week).toBe(utcWeekKey(Date.now()));
    const list = (view.json?.challenges ?? []) as Array<Record<string, unknown>>;
    expect(list.length).toBeGreaterThan(0);
    // The current-period seed renders: 10/25 on the kill daily, win-1 done.
    expect(list.find((c) => c.id === 'daily.kill-25')?.progress).toBe(10);
    expect(list.find((c) => c.id === 'daily.win-1')?.done).toBe(true);
    // The item half resolves its display name from the live items manifest.
    const streak = list.find((c) => c.id === 'weekly.streak-8');
    expect(streak?.item).toBe('title-knee-deep');
    expect(streak?.itemName).toBe('Knee-Deep');

    const hidden = await call(off.origin, `/api/challenges?device=${FRESH}`);
    expect(hidden.status).toBe(404);
  });

  it('zeroes a stale period at READ time — yesterday\'s finished board never renders as today\'s', async () => {
    const view = await call(on.origin, `/api/challenges?device=${STALE}`);
    expect(view.status).toBe(200);
    const list = (view.json?.challenges ?? []) as Array<Record<string, unknown>>;
    const daily = list.find((c) => c.id === 'daily.kill-25');
    const weekly = list.find((c) => c.id === 'weekly.wins-10');
    expect(daily?.progress).toBe(0);
    expect(daily?.done).toBe(false);
    expect(weekly?.progress).toBe(0);
    expect(weekly?.done).toBe(false);
  });
});

describe('the share card over the wire', () => {
  it('answers a real PNG of the seeded last round; the flagless host hides it', async () => {
    const res = await fetch(`${on.origin}/api/share/card?device=${ALFA}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(bytes.readUInt32BE(16)).toBe(1200);
    expect(bytes.readUInt32BE(20)).toBe(630);

    // No last round (fresh key on the SAME host) = an honest 404, not a blank card.
    const blank = await call(on.origin, `/api/share/card?device=${'ab'.repeat(12)}`);
    expect(blank.status).toBe(404);

    const hidden = await fetch(`${off.origin}/api/share/card?device=${ALFA}`);
    expect(hidden.status).toBe(404);
  });
});

describe('the kill switch', () => {
  it('with economy_trading unforced, every trade verb 404s', async () => {
    const opened = await call(off.origin, '/api/trade/open', { deviceId: ALFA });
    expect(opened.status).toBe(404);
    expect(String(opened.json?.error)).toContain('not enabled');
    const mine = await call(off.origin, `/api/trade/mine?device=${ALFA}`);
    expect(mine.status).toBe(404);
  });
});
