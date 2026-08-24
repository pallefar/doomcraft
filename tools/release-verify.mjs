#!/usr/bin/env tsx
/**
 * DOOMCRAFT — `npm run release:verify` (docs/PACKS.md phase 1).
 *
 * The first thing in this repo that can refuse a change without a human
 * choosing to be refused. Runs the offline release gate over the working
 * tree — declared build-pack fingerprints, installed levels, canonical
 * encoding, campaign refs, protocol stability, flag order, schema movement —
 * prints every check and the per-pack input diff, and exits non-zero on any
 * refusal. CI runs it on every push (.github/workflows/ci.yml); it is also
 * the pre-flight for a release document once phase 2 lands.
 *
 * Runs under tsx so it imports the same TS modules the game compiles —
 * checking the sources, not a copy of them.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { runReleaseVerify } from '../server/src/gate.ts';

/*
 * Refuse to verify somebody else's tree. Run from a git worktree (or any
 * copy) without its own node_modules, Node resolves @doomcraft/shared UP the
 * directory tree into the MAIN checkout's workspace symlink — and the gate
 * then fingerprints sources that are not the ones being edited. The phase-1
 * audit hit exactly this: a weapons edit "passed" because the gate was
 * reading a different repo. A gate that quietly verifies the wrong tree is
 * worse than no gate.
 */
const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const sharedPath = fileURLToPath(import.meta.resolve('@doomcraft/shared/package.json'));
if (!resolve(sharedPath).startsWith(repoRoot + '/')) {
  console.error('REFUSED: @doomcraft/shared resolves OUTSIDE this repo:');
  console.error(`  tool root: ${repoRoot}`);
  console.error(`  resolved : ${sharedPath}`);
  console.error('Run npm install in THIS checkout first — otherwise the gate verifies a different tree.');
  process.exit(2);
}

const { report, packs } = runReleaseVerify();

const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m';
const tty = process.stdout.isTTY === true;
const paint = (c, s) => (tty ? c + s + X : s);

console.log('doomcraft release gate');
console.log('');
for (const c of report.checks) {
  const mark = c.ok ? paint(G, '  ok  ') : paint(R, ' FAIL ');
  console.log(`${mark}${c.id}${c.detail.length > 0 ? ` — ${c.detail}` : ''}`);
}

console.log('');
console.log('pack set this tree would release:');
for (const p of packs) {
  const fp = `0x${(p.fingerprint >>> 0).toString(16).padStart(8, '0')}`;
  const digest = p.digest.length > 0 ? `  sha256 ${p.digest.slice(0, 12)}…` : '';
  console.log(`  ${p.label.padEnd(14)} ${fp}  ${p.inputs.length} inputs${digest}`);
}

if (report.diff.length > 0) {
  console.log('');
  console.log('diff against the compiled-in declaration:');
  for (const d of report.diff) {
    console.log(`  ${d.key}: ${d.from === '' ? '(new)' : d.from} -> ${d.to}`);
    for (const line of d.changes) {
      console.log(paint(line.startsWith('+') ? G : R, `    ${line}`));
    }
  }
}

console.log('');
if (report.ok) {
  console.log(paint(G, `PASS`) + paint(D, ` — ${report.checks.length} checks in ${report.ranMs} ms`));
} else {
  const n = report.checks.filter((c) => !c.ok).length;
  console.log(paint(R, `REFUSED`) + ` — ${n} check${n === 1 ? '' : 's'} failed in ${report.ranMs} ms`);
  process.exit(1);
}
