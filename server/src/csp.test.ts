/**
 * DOOMCRAFT — the Content-Security-Policy is real, strict, and on everything.
 *
 * docs/BUGS-FOUND.md §2: the server shipped with no CSP at all. That stops
 * being hygiene the moment third-party sponsor creative is served, because the
 * CSP is the only thing that keeps a hostile tag out of the game's origin.
 *
 * These tests run the ACTUAL server binary — spawned, over real HTTP — rather
 * than unit-testing a string builder, because the claim being defended is
 * "every served response carries it", and that claim is about routing, not
 * about a function. The static root is a fixture, so the test does not need a
 * built bundle and cannot pass or fail on what happens to be in dist/.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = join(here, 'index.ts');

/**
 * A stand-in for the built client. It carries every inline shape the real
 * index.html has — an inline stylesheet, an inline bootstrap script, a module
 * script with a src, a `<noscript>`, and a closing `</script>` — so the nonce
 * rewriting is exercised on the same edges.
 */
const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>DOOMCRAFT</title>
<style>body{margin:0;background:#0a0a0d}</style>
</head>
<body>
<canvas id="game"></canvas>
<noscript><div id="nojs">DOOMCRAFT needs JavaScript.</div></noscript>
<script>window.__DC_T0__ = performance.now();</script>
<script type="module" crossorigin src="./a/index-abc.js"></script>
</body>
</html>
`;

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
  /** `DOOMCRAFT_DATA`, so a test can assert what the server did NOT write. */
  dataRoot: string;
}

async function boot(env: Record<string, string> = {}): Promise<Booted> {
  const port = await freePort();
  const staticRoot = mkdtempSync(join(tmpdir(), 'dc-csp-static-'));
  const dataRoot = mkdtempSync(join(tmpdir(), 'dc-csp-data-'));
  writeFileSync(join(staticRoot, 'index.html'), FIXTURE_HTML, 'utf8');
  mkdirSync(join(staticRoot, 'a'), { recursive: true });
  writeFileSync(join(staticRoot, 'a', 'index-abc.js'), 'export const ok = 1;\n', 'utf8');

  const child = spawn(process.execPath, ['--import', 'tsx', serverEntry], {
    cwd: join(here, '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DOOMCRAFT_STATIC: staticRoot,
      DOOMCRAFT_DATA: dataRoot,
      DOOMCRAFT_BOTS: '0',
      ...env,
    },
  });

  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try {
      const res = await fetch(`${origin}/health`);
      if (res.ok) { await res.text(); break; }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
  return { child, origin, dataRoot };
}

function directive(csp: string, name: string): string | null {
  for (const part of csp.split(';')) {
    const t = part.trim();
    if (t === name || t.startsWith(`${name} `)) return t;
  }
  return null;
}

/* ------------------------------------------------------------------------ *
 * The shipping policy
 * ------------------------------------------------------------------------ */

describe('Content-Security-Policy', () => {
  let server: Booted;
  beforeAll(async () => { server = await boot(); }, 60_000);
  afterAll(() => { server?.child.kill('SIGKILL'); });

  it('is on every served response, not just the document', async () => {
    const paths = [
      '/',                       // the document
      '/index.html',
      '/a/index-abc.js',         // a hashed immutable asset
      '/health',                 // JSON
      '/api/status',             // JSON
      '/api/profile?device=x',   // a 400 from the API
      '/deep/link/that/does/not/exist',  // the SPA fallback
    ];
    for (const p of paths) {
      const res = await fetch(server.origin + p);
      const csp = res.headers.get('content-security-policy');
      expect(csp, `no CSP on ${p}`).toBeTruthy();
      expect(directive(csp ?? '', 'default-src'), p).toBe("default-src 'self'");
    }
  });

  it('is on the error paths too — 403, 405 and HEAD', async () => {
    const forbidden = await fetch(`${server.origin}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    expect(forbidden.headers.get('content-security-policy')).toBeTruthy();

    const wrongMethod = await fetch(`${server.origin}/`, { method: 'DELETE' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('content-security-policy')).toBeTruthy();

    const head = await fetch(`${server.origin}/`, { method: 'HEAD' });
    expect(head.headers.get('content-security-policy')).toBeTruthy();
  });

  it('refuses inline and eval script — the control that stops an ad tag', async () => {
    const csp = (await fetch(`${server.origin}/`)).headers.get('content-security-policy') ?? '';
    const script = directive(csp, 'script-src') ?? '';
    expect(script).toContain("'self'");
    expect(script).toContain("'nonce-");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain('*');
    expect(script).not.toContain('http:');
    expect(script).not.toContain('data:');
    expect(directive(csp, 'script-src-attr')).toBe("script-src-attr 'none'");
  });

  it('does not blanket-allow inline styles: elements are nonce-gated', async () => {
    const csp = (await fetch(`${server.origin}/`)).headers.get('content-security-policy') ?? '';
    const style = directive(csp, 'style-src') ?? '';
    expect(style).toContain("'nonce-");
    // The relaxation is scoped to attributes. A style attribute cannot load a
    // script or reach the network; a <style> element can carry an exfiltration
    // payload, so that one stays behind the nonce.
    expect(style).not.toContain("'unsafe-inline'");
    expect(directive(csp, 'style-src-attr')).toBe("style-src-attr 'unsafe-inline'");
  });

  it('locks the framing, base, object and form knobs', async () => {
    const res = await fetch(`${server.origin}/`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'self'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'none'");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'form-action')).toBe("form-action 'none'");
    expect(directive(csp, 'frame-src')).toBe("frame-src 'none'");
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self'");
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('keeps the workers loadable — a CSP that breaks the mesher gets deleted', async () => {
    const csp = (await fetch(`${server.origin}/`)).headers.get('content-security-policy') ?? '';
    const worker = directive(csp, 'worker-src') ?? '';
    expect(worker).toContain("'self'");
    expect(worker).toContain('blob:');
  });
});

/* ------------------------------------------------------------------------ *
 * The nonce
 * ------------------------------------------------------------------------ */

describe('per-response nonce', () => {
  let server: Booted;
  beforeAll(async () => { server = await boot(); }, 60_000);
  afterAll(() => { server?.child.kill('SIGKILL'); });

  async function document(): Promise<{ html: string; nonce: string }> {
    const res = await fetch(`${server.origin}/`);
    const csp = res.headers.get('content-security-policy') ?? '';
    const m = /'nonce-([^']+)'/.exec(csp);
    expect(m, 'header carries no nonce').not.toBeNull();
    return { html: await res.text(), nonce: (m as RegExpExecArray)[1] };
  }

  it('stamps the header nonce onto every inline block in the document', async () => {
    const { html, nonce } = await document();
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).toContain(`<script nonce="${nonce}">window.__DC_T0__`);
    expect(html).toContain(`<script nonce="${nonce}" type="module"`);
    // Every script and style tag in the document, no exceptions.
    const tags = html.match(/<(script|style)(?=[\s>])[^>]*>/gi) ?? [];
    expect(tags.length).toBeGreaterThanOrEqual(4);
    for (const tag of tags) expect(tag, tag).toContain(`nonce="${nonce}"`);
  });

  it('ships the runtime-style shim, nonced, before anything can create a style', async () => {
    const { html, nonce } = await document();
    const shim = html.indexOf('Document.prototype.createElement');
    expect(shim).toBeGreaterThan(0);
    expect(html.slice(0, shim)).toContain(`<script nonce="${nonce}">`);
    // Before the page's own inline style block, and before the module script.
    expect(shim).toBeLessThan(html.indexOf('<style'));
    expect(shim).toBeLessThan(html.indexOf('type="module"'));
  });

  it('does not maul <noscript> or the closing tags', async () => {
    const { html } = await document();
    expect(html).toContain('<noscript><div id="nojs">');
    expect(html).not.toContain('<noscript nonce');
    expect(html.match(/<\/script>/g)?.length).toBe(3);   // shim + inline + module
  });

  it('is different on every response, and the document is never stored', async () => {
    const a = await document();
    const b = await document();
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.nonce.length).toBeGreaterThanOrEqual(16);
    const res = await fetch(`${server.origin}/`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('leaves hashed assets immutable and unrewritten', async () => {
    const res = await fetch(`${server.origin}/a/index-abc.js`);
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(await res.text()).toBe('export const ok = 1;\n');
  });
});

/* ------------------------------------------------------------------------ *
 * The escape hatches, which must not be escapable
 * ------------------------------------------------------------------------ */

describe('sponsor origins and report-uri are validated, not trusted', () => {
  let server: Booted;
  beforeAll(async () => {
    server = await boot({
      DOOMCRAFT_SPONSOR_ORIGIN:
        'https://ads.example.com, javascript:alert(1), *, http://evil.example, https://a.example:8443/path',
      // A value that would smuggle a second header if it were pasted through.
      DOOMCRAFT_CSP_REPORT_URI: '/csp-report\r\nx-injected: yes',
    });
  }, 60_000);
  afterAll(() => { server?.child.kill('SIGKILL'); });

  it('admits only plain https origins, and only to img-src and frame-src', async () => {
    const res = await fetch(`${server.origin}/`);
    const csp = res.headers.get('content-security-policy') ?? '';

    expect(directive(csp, 'frame-src')).toBe('frame-src https://ads.example.com');
    expect(directive(csp, 'img-src')).toContain('https://ads.example.com');

    // Everything malformed is dropped rather than passed through.
    expect(csp).not.toContain('javascript:');
    expect(csp).not.toContain('http://evil.example');
    expect(csp).not.toContain('a.example:8443');
    expect(csp).not.toMatch(/(^|[\s;])\*/);

    // A sponsor origin never reaches the directive that can execute code.
    expect(directive(csp, 'script-src')).not.toContain('example.com');
  });

  it('drops a report-uri that carries a header separator', async () => {
    const res = await fetch(`${server.origin}/`);
    expect(res.headers.get('x-injected')).toBeNull();
    expect(res.headers.get('content-security-policy')).not.toContain('report-uri');
  });
});

/* ------------------------------------------------------------------------ *
 * The other door into the profile
 *
 * The CSP keeps hostile code out of the origin. `guardProfileWrite` keeps the
 * client out of the fields only a match result may move — the same "the server
 * grants every reward" line, one layer in. It is tested here because it is
 * about ROUTING, not about a function: `entitlementGuard.test.ts` already
 * proves the filter filters, and proved nothing about whether `index.ts` calls
 * it. This boots the real binary and posts the attack.
 * ------------------------------------------------------------------------ */

describe('POST /api/profile is not a self-grant', () => {
  let server: Booted;
  const adminToken = 'entitlement-test-token';
  beforeAll(async () => {
    server = await boot({ DOOMCRAFT_ADMIN_TOKEN: adminToken });
  }, 60_000);
  afterAll(() => { server?.child.kill('SIGKILL'); });

  const device = 'device-post0001';

  it('refuses xp, level and lifetime counters the client posted for itself', async () => {
    const posted = await fetch(`${server.origin}/api/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: device,
        progress: {
          name: 'Cheater',
          xp: 1_000_000_000,
          level: 99,
          kills: 500_000,
          wins: 500_000,
          gamesPlayed: 500_000,
          bestKillstreak: 999,
        },
        stats: { kills: 500_000, matches: 500_000 },
      }),
    });
    expect(posted.status).toBe(200);
    // The refusal is named, not silent.
    const echoed = await posted.json() as { rejected: string[] };
    expect(echoed.rejected).toContain('progress.xp');
    expect(echoed.rejected).toContain('progress.kills');
    expect(echoed.rejected).toContain('stats');

    // Read it back over the wire rather than trusting the POST's own echo.
    const res = await fetch(`${server.origin}/api/profile?device=${device}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { profile: { progress: Record<string, number | string>; stats: Record<string, number> } };

    expect(body.profile.progress.xp).toBe(0);
    expect(body.profile.progress.level).toBe(1);
    expect(body.profile.progress.kills).toBe(0);
    expect(body.profile.progress.wins).toBe(0);
    expect(body.profile.progress.gamesPlayed).toBe(0);
    expect(body.profile.progress.bestKillstreak).toBe(0);
    expect(body.profile.stats.kills).toBe(0);
    expect(body.profile.stats.matches).toBe(0);

    // The parts the client really does own still land, or the filter is just
    // a broken endpoint wearing a security hat.
    expect(body.profile.progress.name).toBe('Cheater');
  });

  /*
   * THE SPELLING THE TEST ABOVE DOES NOT COVER, and the reason it is here
   * rather than only in the unit test.
   *
   * The test above was a FALSE GREEN. It passed for months while the same
   * attack, written `__proto__` instead of `progress`, succeeded end to end
   * against this binary:
   *
   *     POST /api/profile {"deviceId":"device-pwn00001","__proto__":{"progress":{"xp":1000000000,…}}}
   *     rejected []
   *     xp 1000000000 level 200 kills 99999 wins 99999 gamesPlayed 123456
   *
   * `JSON.parse` makes `__proto__` an OWN key, so it enumerated; it was not in
   * `SERVER_OWNED_PROFILE_FIELDS`, so nothing rejected it; and the accumulator
   * was a plain `{}`, so writing it replaced the accumulator's prototype and
   * `index.ts` then read `accepted.progress` straight through it.
   *
   * The body is a hand-built STRING: `JSON.stringify({__proto__: {...}})`
   * silently drops the key, so a test that builds the payload the obvious way
   * sends `{}` and passes against a completely broken server.
   */
  const pwned = 'device-pwn00001';

  it('refuses the same attack spelled __proto__ — the one that got through', async () => {
    const raw = `{"deviceId":"${pwned}","__proto__":{"progress":{"xp":1000000000,"level":200,"kills":99999,"wins":99999,"gamesPlayed":123456}}}`;
    expect(JSON.parse(raw).progress, 'the payload must not be an own progress key').toBeUndefined();

    const posted = await fetch(`${server.origin}/api/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: raw,
    });
    expect(posted.status).toBe(200);
    const echoed = await posted.json() as { rejected: string[] };
    expect(echoed.rejected, 'the refusal must be named, not silent').toContain('__proto__');

    const res = await fetch(`${server.origin}/api/profile?device=${pwned}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { profile: { progress: Record<string, number> } };
    expect(body.profile.progress.xp).toBe(0);
    expect(body.profile.progress.level).toBe(1);
    expect(body.profile.progress.kills).toBe(0);
    expect(body.profile.progress.wins).toBe(0);
    expect(body.profile.progress.gamesPlayed).toBe(0);
  });

  it('counts the refused write, so the detector is not wired to nothing', async () => {
    // `guardProfileWrite`'s `violation` had ZERO readers in the whole tree.
    // The two POSTs above are exactly the attack this counter exists for, and
    // it read a flat zero through both of them.
    const res = await fetch(`${server.origin}/api/status`);
    const body = await res.json() as { entitlement: { violations: number; codes: Record<string, number> } };
    expect(body.entitlement.violations).toBeGreaterThan(0);
    expect(body.entitlement.codes.PROFILE_FIELDS).toBeGreaterThan(0);
  });

  it('does not create a profile on a GET — a read must not write to disk', async () => {
    // `store.ensure` on a GET made `curl "…?device=$(openssl rand -hex 6)"` in
    // a loop unauthenticated, unbounded disk growth, and nothing sweeps the
    // profile directory.
    const unseen = 'device-neverseen1';
    const res = await fetch(`${server.origin}/api/profile?device=${unseen}`);
    expect(res.status).toBe(404);
    await res.text();

    // Give the 800 ms flush debounce more than its chance to betray us.
    await new Promise<void>((r) => { setTimeout(r, 1200); });
    const files = existsSync(join(server.dataRoot, 'profiles'))
      ? readdirSync(join(server.dataRoot, 'profiles'), { recursive: true }) as string[]
      : [];
    expect(files.some((f) => String(f).includes(unseen)), `wrote a file for ${unseen}`).toBe(false);
  }, 20_000);

  it('never puts a durable identifier on the wire', async () => {
    const res = await fetch(`${server.origin}/api/profile?device=${device}`);
    const text = await res.text();
    expect(text).not.toContain('accountSecret');
    expect(text).not.toContain('accountId');
    expect(text).not.toContain('receipt');
  });

  it('has no unauthenticated account routes left to take an account over', async () => {
    // `link` returned `publicProfile(victim)` PLUS a fresh durable secret for
    // ANY device id, and permanently re-pointed the victim's account index.
    const link = await fetch(`${server.origin}/api/account/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: device, accountId: 'victim-account' }),
    });
    const linkBody = await link.text();
    expect(link.status).not.toBe(200);
    expect(linkBody).not.toContain('secret');

    const resolve = await fetch(`${server.origin}/api/account/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'victim-account', secret: 'anything' }),
    });
    const resolveBody = await resolve.text();
    expect(resolve.status).not.toBe(200);
    expect(resolveBody).not.toContain('progress');
  });

  it('refuses to grant a paid entitlement with no charging provider bound', async () => {
    // The one identity route the live client actually calls, and it used to
    // hand over the $4.99 product on an unverified receipt string.
    const res = await fetch(`${server.origin}/api/entitlement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: device, product: 'doomcraft.remove_ads', receipt: 'made-up' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { granted?: boolean };
    expect(body.granted).not.toBe(true);

    // And the refusal is real: the profile did not quietly get the product.
    const after = await (await fetch(`${server.origin}/api/profile?device=${device}`)).json() as {
      profile: { entitlements: { adsRemoved: boolean } };
    };
    expect(after.profile.entitlements.adsRemoved).toBe(false);
  });

  it('takes the admin bearer with a lower-case scheme and refuses a bare token', async () => {
    // RFC 7235 §2.1: the scheme is case-insensitive. The old check compared
    // `startsWith('Bearer ')` and fell back to accepting the raw header value.
    const lower = await fetch(`${server.origin}/api/admin/entitlement`, {
      headers: { authorization: `bearer ${adminToken}` },
    });
    expect(lower.status).toBe(200);
    await lower.text();

    const bare = await fetch(`${server.origin}/api/admin/entitlement`, {
      headers: { authorization: adminToken },
    });
    expect(bare.status).toBe(404);
    await bare.text();
  });

  /*
   * The gate is only real if an operator can see it running. These two are the
   * "is it wired in?" check the design asks for by name: a counter on the
   * status page and an admin-only view of every refusal.
   */
  it('reports the gate on /api/status, so a dark guard is visible', async () => {
    const res = await fetch(`${server.origin}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json() as { entitlement?: Record<string, number> };
    expect(body.entitlement, 'no entitlement block on /api/status').toBeTruthy();
    expect(typeof body.entitlement?.sessions).toBe('number');
    expect(typeof body.entitlement?.accepted).toBe('number');
    expect(typeof body.entitlement?.violations).toBe('number');
  });

  it('keeps the refusal log behind the admin token, 404 without one', async () => {
    const anon = await fetch(`${server.origin}/api/admin/entitlement`);
    expect(anon.status).toBe(404);

    const wrong = await fetch(`${server.origin}/api/admin/entitlement`, {
      headers: { authorization: 'Bearer not-the-token-at-all' },
    });
    expect(wrong.status).toBe(404);

    const ok = await fetch(`${server.origin}/api/admin/entitlement`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(ok.status).toBe(200);
    const body = await ok.json() as { status: Record<string, number>; recent: unknown[] };
    expect(Array.isArray(body.recent)).toBe(true);
    expect(typeof body.status.rejected).toBe('number');
  });
});
