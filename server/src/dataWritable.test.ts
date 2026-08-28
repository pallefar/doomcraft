/**
 * DOOMCRAFT — the data-root writability probe, over the real binary.
 *
 * The 2026-08-28 finding this guards: the Railway volume mounted
 * root-owned under `USER node`, every durable write failed SILENTLY (each
 * store swallows its own errors, each for a locally good reason), and six
 * days of profiles, accounts, journal rows and releases were lost. The
 * probe makes that state one curl away: /api/version carries
 * data.writable, and the boot log screams.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

let child: ChildProcess;
let origin: string;
let stderrText = '';
let lockedRoot = '';

beforeAll(async () => {
  const port = await freePort();
  const staticRoot = mkdtempSync(join(tmpdir(), 'dc-wr-static-'));
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>x</title>', 'utf8');
  // The root-owned volume, simulated: a data root this process cannot write.
  lockedRoot = mkdtempSync(join(tmpdir(), 'dc-wr-data-'));
  chmodSync(lockedRoot, 0o555);

  child = spawn(process.execPath, ['--import', 'tsx', serverEntry], {
    cwd: join(here, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port), HOST: '127.0.0.1',
      DOOMCRAFT_STATIC: staticRoot, DOOMCRAFT_DATA: join(lockedRoot, 'data'),
      DOOMCRAFT_BOTS: '0', DOOMCRAFT_PREWARM: '0',
    },
  });
  child.stdout?.resume();
  child.stderr?.on('data', (d: Buffer) => { stderrText += d.toString(); });

  origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    if (Date.now() > deadline) throw new Error('server did not start');
    try {
      const res = await fetch(`${origin}/health`);
      if (res.status > 0) { await res.text(); break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
}, 60_000);

afterAll(() => {
  child?.kill('SIGKILL');
  try { chmodSync(lockedRoot, 0o755); } catch { /* best effort */ }
});

describe('an unwritable data root', () => {
  it('is one curl away on /api/version, and the boot log screams', async () => {
    const v = await fetch(`${origin}/api/version`).then(async (r) => (await r.json()) as {
      data?: { writable: boolean; error: string };
    });
    const data = v.data as { writable: boolean; error: string };
    expect(data).toBeDefined();
    expect(data.writable).toBe(false);
    expect(data.error.length).toBeGreaterThan(0);
    expect(stderrText).toContain('IS NOT WRITABLE');
    expect(stderrText).toContain('WILL BE LOST');
  });
});
