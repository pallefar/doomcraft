/**
 * DOOMCRAFT — C6 over the wire: the operator verbs against the real binary.
 *
 * The PLATFORM C6 test list, the route half: a banned player mints no
 * socket credential; admin.adjust lands as a journal row with a non-empty
 * actor and reason AND the reconciliation still agrees; and the two-phase
 * confirm refuses a confirm submitted inside the delay window.
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
const ADMIN_TOKEN = 'an-operator-token-thirty-two-plus-chars';
const DEVICE = 'adadadadadadadadadadadad';
const CONFIRM_DELAY_MS = 400;

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

beforeAll(async () => {
  const port = await freePort();
  const staticRoot = mkdtempSync(join(tmpdir(), 'dc-c6-static-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'dc-c6-data-'));
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>x</title>', 'utf8');
  const shard = join(dataRoot, 'profiles', DEVICE.slice(0, 2));
  mkdirSync(shard, { recursive: true });
  writeFileSync(join(shard, `${DEVICE}.json`), JSON.stringify({
    version: 5, deviceId: DEVICE, createdMs: 1_700_000_000_000,
    progress: { xp: 100, gamesPlayed: 3 },
    economy: { scrap: 50, lifetimeScrap: 50, day: '2026-01-01', dayXp: 0, dayScrap: 0, dayMatches: 0 },
  }), 'utf8');

  child = spawn(process.execPath, ['--import', 'tsx', serverEntry], {
    cwd: join(here, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      DOOMCRAFT_STATIC: staticRoot, DOOMCRAFT_DATA: dataRoot,
      DOOMCRAFT_BOTS: '0', DOOMCRAFT_PREWARM: '0',
      DOOMCRAFT_ADMIN_TOKEN: ADMIN_TOKEN,
      DOOMCRAFT_CONFIRM_DELAY_MS: String(CONFIRM_DELAY_MS),
    },
  });
  child.stdout?.resume();
  child.stderr?.resume();
  origin = `http://127.0.0.1:${port}`;
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

async function admin(path: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> };
}

/** Walk the two-phase confirm: arm, prove the early confirm refused, land it. */
async function confirmed(path: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const armed = await admin(path, body);
  expect(armed.status).toBe(428);
  const token = armed.json.confirmToken as string;
  // THE SPEC TEST: a confirm submitted inside the delay window is refused.
  const early = await admin(path, { ...body, confirm: token });
  expect(early.status).toBe(425);
  await new Promise((r) => setTimeout(r, CONFIRM_DELAY_MS + 150));
  return admin(path, { ...body, confirm: token });
}

describe('C6 — the operator verbs', () => {
  it('admin.adjust: a journal row with actor and reason, and the reconciliation still agrees', async () => {
    const done = await confirmed('/api/admin/player/currency', {
      deviceId: DEVICE, delta: 120, actor: 'operator', reason: 'C6 verification adjust',
    });
    expect(done.status).toBe(200);

    const look = await fetch(`${origin}/api/admin/player?key=${DEVICE}`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    }).then(async (r) => (await r.json()) as {
      profile: { economy: { scrap: number } };
      rows: { kind: string; actor: string; reason: string; delta: number }[];
      reconcile: { scrap: { stored: number; journal: number } };
    });
    expect(look.profile.economy.scrap).toBe(170);
    const row = look.rows.find((r) => r.kind === 'admin.adjust');
    expect(row?.delta).toBe(120);
    expect((row?.actor ?? '').length).toBeGreaterThan(0);
    expect((row?.reason ?? '').length).toBeGreaterThan(0);
    // §4.4's invariant, read the way the console reads it: within the
    // retained window the stored balance minus the pre-window base equals
    // the journal sum — here the journal holds every row since the seed, so
    // stored - seed == journal.
    expect(look.profile.economy.scrap - 50).toBe(look.reconcile.scrap.journal);
  });

  it('a banned player mints NO socket credential; lifting the ban restores it', async () => {
    const banned = await confirmed('/api/admin/player/moderate', {
      deviceId: DEVICE, banned: true, untilMs: 0, actor: 'operator', reason: 'C6 verification ban',
    });
    expect(banned.status).toBe(200);

    const refused = await fetch(`${origin}/api/session/ticket`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE }),
    });
    expect(refused.status).toBe(403);

    const lifted = await confirmed('/api/admin/player/moderate', {
      deviceId: DEVICE, banned: false, untilMs: 0, actor: 'operator', reason: 'C6 verification unban',
    });
    expect(lifted.status).toBe(200);
    const minted = await fetch(`${origin}/api/session/ticket`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE }),
    });
    expect(minted.status).toBe(200);
  });

  it('revoke-item writes the ONLY written item state, and the lookup shows it', async () => {
    const done = await confirmed('/api/admin/player/revoke-item', {
      deviceId: DEVICE, ref: 'trail-coolant-leak', actor: 'operator', reason: 'C6 verification revoke',
    });
    expect(done.status).toBe(200);
    const look = await fetch(`${origin}/api/admin/player?key=${DEVICE}`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    }).then(async (r) => (await r.json()) as { moderation: { revokedItems: number } });
    expect(look.moderation.revokedItems).toBe(1);
  });

  it('a stale or foreign confirm token starts the arm over instead of firing', async () => {
    const armed = await admin('/api/admin/player/currency', {
      deviceId: DEVICE, delta: 10, actor: 'operator', reason: 'C6 verification stale token',
    });
    expect(armed.status).toBe(428);
    const wrong = await admin('/api/admin/player/currency', {
      deviceId: DEVICE, delta: 10, confirm: 'not-the-token', actor: 'operator', reason: 'C6 verification stale token',
    });
    expect(wrong.status).toBe(428);   // re-armed, never applied
  });
});

describe('C6.1 — reset-progress', () => {
  it('archives first, zeroes progress/stats/economy through the journal, keeps identity', async () => {
    const before = await fetch(`${origin}/api/admin/player?key=${DEVICE}`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    }).then(async (r) => (await r.json()) as { profile: { economy: { scrap: number } } });
    const hadScrap = before.profile.economy.scrap;
    expect(hadScrap).toBeGreaterThan(0);

    const done = await confirmed('/api/admin/player/reset-progress', {
      deviceId: DEVICE, actor: 'operator', reason: 'C6.1 verification reset',
    });
    expect(done.status).toBe(200);
    expect(String(done.json.result)).toContain('archived');

    const look = await fetch(`${origin}/api/admin/player?key=${DEVICE}`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    }).then(async (r) => (await r.json()) as {
      profile: { progress: { xp: number }; economy: { scrap: number }; stats: { matches: number } };
      rows: { kind: string; sourceId: string; delta: number }[];
    });
    expect(look.profile.progress.xp).toBe(0);
    expect(look.profile.economy.scrap).toBe(0);
    expect(look.profile.stats.matches).toBe(0);
    // The zeroing is a journal row, not a silent field edit.
    const row = look.rows.find((r) => r.sourceId.startsWith('reset:'));
    expect(row?.kind).toBe('admin.adjust');
    expect(row?.delta).toBe(-hadScrap);
  });
});
