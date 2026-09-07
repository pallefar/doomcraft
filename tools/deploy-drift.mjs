/**
 * DOOMCRAFT — is what is LIVE the tree you are standing in?
 *
 *   node tools/deploy-drift.mjs            # check both tiers against HEAD
 *   node tools/deploy-drift.mjs --no-build # reuse the dist/ already there
 *
 * WHY THIS EXISTS. On 2026-09-07 the origin ran seven commits behind for most
 * of a day, and one of the seven was a fix for a live money bug — a challenge
 * debt paying out an item no manifest defined. Nothing said so. The commits
 * were pushed, CI was green, and "deployed" had quietly become "committed".
 * The runbook already described how to check by hand; a procedure you have to
 * remember is one you find out you forgot afterwards.
 *
 * WHY IT DOES NOT ASK THE SERVER WHAT COMMIT IT IS. Because the server does
 * not know and says so wrongly: `/api/version`'s `build.id` is a Railway
 * environment variable, it read `b453e8b` before and after three separate
 * deploys today, and HANDOVER §0 rule 17 is the scar. Anything self-reported
 * can be stale in exactly the case you are testing for.
 *
 * So both checks are CONTENT-DERIVED and falsifiable, and they differ per tier
 * because the two builds are not reproducible in the same way:
 *
 *   RAILWAY — compare the served bundle's content hash against a local
 *     `npm run build`. Vite hashes by content, and Railway builds in Docker
 *     with neither `DOOMCRAFT_BUILD_ID` nor `VERCEL_GIT_COMMIT_SHA` set, so a
 *     plain local build lands on the same inputs and the same hash.
 *
 *   VERCEL — do NOT compare hashes. `client/vite.config.ts` defines
 *     `__DC_BUILD_ID__` from `VERCEL_GIT_COMMIT_SHA`, so a Vercel bundle can
 *     never equal a plain local one; and even with the define reproduced,
 *     Rollup's chunk hashing differs between Vercel's Linux builder and arm64
 *     macOS (measured, 2026-09-05: identical byte length, byte-identical
 *     vendor chunk, different chunk hashes). Instead READ THIS COMMIT'S ID OUT
 *     OF THE SERVED BUNDLE. It is injected from the build environment, so a
 *     stale build cannot contain it — which names the commit directly rather
 *     than proving it by proxy.
 *
 * Exits non-zero on drift, so it can gate a deploy or run from a loop.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const ORIGIN = process.env.DOOMCRAFT_ORIGIN ?? 'https://doomcraft-production.up.railway.app';
const STATIC = process.env.DOOMCRAFT_STATIC_ORIGIN ?? 'https://doomcraft.vercel.app';
const BUNDLE_RE = /a\/index-[A-Za-z0-9_-]+\.js/;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'DRIFT'} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}

/** The `a/index-*.js` the origin's index.html actually references. */
async function servedBundle(origin) {
  const html = await fetchText(`${origin}/`);
  const m = BUNDLE_RE.exec(html);
  if (m === null) throw new Error(`no bundle reference in ${origin}/ — the page shape changed`);
  return m[0];
}

const head = sh('git', ['rev-parse', 'HEAD']);
const shortId = head.slice(0, 12);
const dirty = sh('git', ['status', '--porcelain']).length > 0;

console.log(`HEAD    ${head.slice(0, 7)}${dirty ? '  (WORKING TREE DIRTY — comparing against uncommitted code)' : ''}`);

if (!process.argv.includes('--no-build')) {
  console.log('building locally, the way Railway does (neither build-id variable set)…');
  sh('npm', ['run', 'build']);
}

/* The local bundle. Read from disk rather than parsed out of build output, so
 * a change to vite's logging cannot quietly make this read nothing. */
const distDir = join(repoRoot, 'dist', 'a');
const local = readdirSync(distDir).filter((f) => /^index-[A-Za-z0-9_-]+\.js$/.test(f));
if (local.length !== 1) {
  console.error(`expected exactly one dist/a/index-*.js, found ${local.length} — cannot compare`);
  process.exit(2);
}
const localBundle = `a/${local[0]}`;
console.log(`local   ${localBundle}\n`);

/* ---- Railway: content hash ------------------------------------------- */
try {
  const served = await servedBundle(ORIGIN);
  check('origin serves this tree\'s bundle', served === localBundle,
    served === localBundle ? served : `serving ${served}, this tree builds ${localBundle}`);
} catch (e) {
  check('origin serves this tree\'s bundle', false, String(e.message ?? e));
}

/* ---- Vercel: this commit's id, inside the served bundle --------------- */
try {
  const served = await servedBundle(STATIC);
  const js = await fetchText(`${STATIC}/${served}`);
  const found = js.includes(shortId);
  check('static bundle was built from this commit', found,
    found ? `${served} carries ${shortId}` : `${served} does not carry ${shortId}`);
} catch (e) {
  check('static bundle was built from this commit', false, String(e.message ?? e));
}

/* ---- The volume, because a live origin that cannot write is not live --- */
try {
  const v = JSON.parse(await fetchText(`${ORIGIN}/api/version`));
  const d = v.data ?? {};
  check('origin volume is writable', d.writable === true,
    `writable=${d.writable} unflushed=${d.unflushed} quarantined=${d.quarantined} lostWrites=${d.lostWrites}`);
} catch (e) {
  check('origin volume is writable', false, String(e.message ?? e));
}

console.log(failures === 0
  ? '\nboth tiers are current'
  : `\n${failures} tier(s) adrift — what is live is not this tree`);
process.exit(failures === 0 ? 0 : 1);
