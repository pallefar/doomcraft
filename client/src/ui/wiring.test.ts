/**
 * DOOMCRAFT — the wiring ratchet. "It compiles and the tests pass" is not
 * evidence that anything ships.
 *
 * Six features in this repo were written, typechecked, passed hundreds of tests
 * and were imported by NOTHING. Two of them are still here on purpose:
 * `client/src/ui/matchType.ts` is 566 lines of finished, styled, tested UI, and
 * `client/src/ui/worldBrowser.ts` is 645 more. Neither was ever a compile error
 * and neither was ever a failing test, because *a module nobody imports has no
 * behaviour to be wrong about*. That is the failure this file exists to make
 * loud, and it is the reason `client/src/ui/` — four files, ~3,400 lines —
 * carried zero test files until now.
 *
 * WHAT IS ACTUALLY CHECKED, and why each one is here
 *
 *   A. **Reachability, transitively, from `client/src/main.ts`.** Not "somebody
 *      imports it" — a pair of orphans that import each other would pass that.
 *      The walk starts at the real entry point and follows real imports.
 *   B. **Every `export function create*` is CALLED.** An import that only pulls
 *      a type, or a factory that is imported and never invoked, is a module
 *      that still does nothing.
 *   C. **At least one exported value of every UI module is referenced by name
 *      somewhere else in the reachable set.** `matchType.ts` exports no
 *      `create*` factory at all — it exports classes — so a ratchet written
 *      only around check B would have gone green on it while it was 100%
 *      orphaned. That is the exact shape of "a green test that cannot fail".
 *   D. **`KNOWN_UNWIRED` is a named list with a written reason per entry**, and
 *      every name on it must be a file that exists. Adding a name is a
 *      deliberate edit that a reviewer can see; it is not a silent skip.
 *   E. **No `data-screen` anywhere under `client/src/ui/`.** `main.ts` runs a
 *      `MutationObserver` with `attributeFilter: ['data-screen']` that feeds
 *      `boot/updates.ts`, and that path ends in `location.reload()`. An overlay
 *      that made itself a screen value would reload the page.
 *   F. **The profile's ten `main.ts` touch points**, asserted as source, so the
 *      overlay cannot be half-wired: constructed on `uiRoot`, opened from the
 *      launcher row, closed by `setScreen`, by Escape, and reachable from the
 *      `__DC__` automation surface the capture harness drives.
 *
 * The walk is text-based on purpose. A version that needed a real module
 * resolver would be a version that breaks on the next bundler change and gets
 * deleted rather than fixed. Its one known limitation is stated at
 * `importsOf`: it cannot see a specifier built at runtime, and nothing in this
 * tree has one.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const CLIENT_SRC = path.join(REPO, 'client', 'src');
const UI_DIR = path.join(CLIENT_SRC, 'ui');
const ENTRY = path.join(CLIENT_SRC, 'main.ts');

/* ------------------------------------------------------------------------ *
 * The exemption list — the whole point is that it is short and explained
 * ------------------------------------------------------------------------ */

/**
 * Files under `client/src/ui/` that are knowingly not wired into the shell.
 *
 * A name here is a debt, not an exemption: each one is a finished feature that
 * costs source weight and reader attention and returns nothing until it is
 * imported. Removing a name is the goal. Adding one requires writing the reason
 * below, which is the point.
 */
export const KNOWN_UNWIRED: Readonly<Record<string, string>> = Object.freeze({
  'worldBrowser.ts':
    'The Builder world manager. `client/src/ui/modeSelect.ts` grew its own world '
    + 'list before this landed, so the shell reads `worldRowsFrom(save)` instead and '
    + 'this module has never been mounted. Kept because it is the only place that '
    + 'implements share-code entry and the local/remote row merge, which the shared-'
    + 'worlds work needs. Do NOT delete it to make this test pass.',
});

/* ------------------------------------------------------------------------ *
 * The import graph
 * ------------------------------------------------------------------------ */

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/**
 * Comments blanked, line numbers preserved.
 *
 * Every scan below searches for a token that this file's own prose also has to
 * be able to say out loud — `data-screen`, `openPause()`, the word "recovery".
 * Without this, the ratchet fails on the paragraph explaining the ratchet, and
 * the fix somebody reaches for is to stop explaining it.
 */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

function tsFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && !n.endsWith('.d.ts'))
    .map((n) => path.join(dir, n))
    .filter((f) => statSync(f).isFile())
    .sort();
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) { walkTs(full, out); continue; }
    if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * Every module specifier this file imports **at run time**.
 *
 * `import type { X } from …` is stripped first, because `verbatimModuleSyntax`
 * is false in `tsconfig.base.json`: a type-only import is erased by the
 * compiler and is emphatically NOT evidence that a module ships. Treating one
 * as wiring is how this ratchet would go green on a dead module.
 *
 * Limitation, stated rather than hidden: a specifier assembled at run time
 * (`import(\`./\${name}.js\`)`) is invisible here. There is none in this tree,
 * and one would show up as an unreachable file rather than as a false pass.
 */
function importsOf(text: string): string[] {
  const src = text
    .replace(/^\s*import\s+type\s[\s\S]*?from\s*['"][^'"]+['"];?/gm, '')
    .replace(/^\s*export\s+type\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"];?/gm, '');
  const out: string[] = [];
  const from = /\bfrom\s*['"]([^'"]+)['"]/g;
  const bare = /^\s*import\s*['"]([^'"]+)['"]/gm;
  const dyn = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [from, bare, dyn]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push(m[1]);
  }
  return out;
}

/** Resolve a specifier to a file under `client/src`, or null if it leaves. */
function resolve(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(CLIENT_SRC, spec.slice(2));
  else if (spec.startsWith('./') || spec.startsWith('../')) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // '@shared/…', 'three', 'ws' — nothing under client/src/ui/ lives there
  const tries = [
    base,
    `${base}.ts`,
    base.replace(/\.js$/, '.ts'),
    path.join(base, 'index.ts'),
  ];
  for (const t of tries) {
    if (existsSync(t) && statSync(t).isFile()) return t;
  }
  return null;
}

/** Files reachable from `client/src/main.ts` by run-time imports. */
function reachableFromEntry(): Set<string> {
  const seen = new Set<string>([ENTRY]);
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop()!;
    for (const spec of importsOf(read(file))) {
      const target = resolve(file, spec);
      if (target === null || seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  return seen;
}

const REACHABLE = reachableFromEntry();
const UI_FILES = tsFilesIn(UI_DIR);
const rel = (f: string): string => path.relative(REPO, f);

/* ------------------------------------------------------------------------ *
 * D. The list itself
 * ------------------------------------------------------------------------ */

describe('the unwired list', () => {
  it('names only files that exist, each with a written reason', () => {
    for (const [name, reason] of Object.entries(KNOWN_UNWIRED)) {
      expect(existsSync(path.join(UI_DIR, name)), `${name} is on the list but not on disk`).toBe(true);
      expect(reason.length, `${name} needs a reason, not an empty string`).toBeGreaterThan(40);
    }
  });

  it('found the tree it is supposed to be scanning', () => {
    expect(UI_FILES.length).toBeGreaterThanOrEqual(4);
    expect(REACHABLE.size).toBeGreaterThan(40);
    expect(REACHABLE.has(ENTRY)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * A. Reachability
 * ------------------------------------------------------------------------ */

describe('every UI module is reachable from the shell', () => {
  it('is imported, transitively, from client/src/main.ts', () => {
    const orphans: string[] = [];
    for (const file of UI_FILES) {
      const name = path.basename(file);
      if (name in KNOWN_UNWIRED) continue;
      if (!REACHABLE.has(file)) orphans.push(rel(file));
    }
    expect(
      orphans,
      'these UI modules compile, are typechecked and ship in no bundle — '
      + 'import them from the shell or add them to KNOWN_UNWIRED with a reason',
    ).toEqual([]);
  });

  it('does not count a type-only import as wiring', () => {
    // The guard on the guard: if `importsOf` stopped stripping `import type`,
    // a dead module could be resurrected by a single type import.
    const stripped = importsOf("import type { A } from '@/ui/matchType';\n");
    expect(stripped).toEqual([]);
    const kept = importsOf("import { A } from '@/ui/matchType';\n");
    expect(kept).toEqual(['@/ui/matchType']);
  });
});

/* ------------------------------------------------------------------------ *
 * B. The factories are CALLED
 * ------------------------------------------------------------------------ */

const FACTORY = /^export function (create[A-Z][A-Za-z0-9_]*)\s*\(/gm;

describe('every create* factory is invoked, not merely imported', () => {
  it('is called from a file that is itself reachable', () => {
    const dead: string[] = [];
    for (const file of UI_FILES) {
      if (path.basename(file) in KNOWN_UNWIRED) continue;
      const text = read(file);
      FACTORY.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = FACTORY.exec(text)) !== null) {
        const fn = m[1];
        const called = [...REACHABLE].some(
          (other) => other !== file && new RegExp(`\\b${fn}\\s*\\(`).test(read(other)),
        );
        if (!called) dead.push(`${rel(file)} exports ${fn}() and nothing calls it`);
      }
    }
    expect(dead).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * C. Modules with no factory at all
 * ------------------------------------------------------------------------ */

const EXPORTED_VALUE = /^export (?:async function|function|class|const|enum) ([A-Za-z_][A-Za-z0-9_]*)/gm;

describe('every UI module has at least one export somebody uses', () => {
  it('is referenced by name from another reachable file', () => {
    const unused: string[] = [];
    for (const file of UI_FILES) {
      if (path.basename(file) in KNOWN_UNWIRED) continue;
      const text = read(file);
      EXPORTED_VALUE.lastIndex = 0;
      const names: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = EXPORTED_VALUE.exec(text)) !== null) names.push(m[1]);
      if (names.length === 0) continue;
      const used = names.some((n) => [...REACHABLE].some(
        (other) => other !== file && new RegExp(`\\b${n}\\b`).test(read(other)),
      ));
      if (!used) {
        unused.push(`${rel(file)} exports ${names.length} value(s) and no reachable file names any of them`);
      }
    }
    expect(
      unused,
      'a module can be imported for one type and still be dead weight — '
      + 'matchType.ts was exactly this for its whole life',
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * E. The anti-reload rule
 * ------------------------------------------------------------------------ */

describe('no overlay makes itself a screen', () => {
  it('never touches data-screen anywhere under client/src/ui/', () => {
    const offenders: string[] = [];
    for (const file of walkTs(UI_DIR)) {
      code(file).split('\n').forEach((line, i) => {
        if (/data-screen|dataset\s*\.\s*screen/.test(line)) {
          offenders.push(`${rel(file)}:${i + 1} ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      'main.ts observes [data-screen] and boot/updates.ts answers it with location.reload()',
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------------ *
 * F. The profile's own touch points
 * ------------------------------------------------------------------------ */

describe('the profile overlay is wired the whole way', () => {
  const main = code(ENTRY);

  it('reaches the overlay through a DYNAMIC import, so it is off the boot path', () => {
    expect(main).toMatch(/import\('@\/ui\/profile'\)/);
    // A static value import would put 36 kB back on the critical path. Type
    // imports are fine and are what the handle and the inputs shape use.
    expect(main).not.toMatch(/^import \{[^}]*\} from '@\/ui\/profile(Model)?';$/m);
  });

  it('mounts on #ui itself, not inside a screen', () => {
    expect(main).toMatch(/createProfileScreen\(\{\s*root: uiRoot!,\s*inputs: profileInputs,/);
  });

  it('is opened from the launcher row and closed by the screen machine', () => {
    expect(main).toMatch(/button\('Profile', 'dc-ghost', \(\) => \{ void openProfile\(\); \}\)/);
    expect(main).toMatch(/if \(s !== 'menu'\) \{[^}]*profileScreen\?\.close\(\)/);
  });

  it('builds ONE overlay when the button is hit twice before the chunk lands', () => {
    // Without the in-flight guard the second click starts a second import and
    // appends a second overlay to #ui; the first one is then unreachable and
    // permanently on top of the menu.
    expect(main).toMatch(/let profileLoading: Promise<ProfileScreen> \| null = null;/);
    expect(main).toMatch(/profileLoading \?\?= import\('@\/ui\/profile'\)/);
  });

  it('takes Escape before openPause, or it cannot be dismissed in a match', () => {
    const esc = main.slice(main.indexOf("if (e.code === 'Escape')"));
    const profileAt = esc.indexOf('profileScreen?.isOpen');
    const pauseAt = esc.indexOf('openPause()');
    expect(profileAt).toBeGreaterThan(-1);
    expect(profileAt).toBeLessThan(pauseAt);
  });

  it('swallows Enter, Space and the canvas click while it is up', () => {
    const swallows = main.split('\n').filter((l) => /profileScreen\?\.isOpen === true\) return/.test(l));
    expect(swallows.length).toBe(2);
  });

  it('is reachable from the automation surface the capture harness drives', () => {
    expect(main).toMatch(/openProfile\(\): Promise<void> \{ return openProfile\(\); \}/);
    expect(main).toMatch(/closeProfile\(\): void/);
    expect(main).toMatch(/get profileOpen\(\): boolean/);
  });

  it('never puts a recovery code on __DC__', () => {
    // docs/PLATFORM.md §6.4: `__DC__` is read by tools/capture-ours.mjs and
    // lands in screenshots. Whatever C4 adds, it does not go here.
    const dc = main.slice(main.indexOf('__DC__: Record<string, unknown>'));
    expect(/recovery|secret|accountSecret/i.test(dc)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ *
 * The server's flags reach the client
 *
 * `shared/src/features.ts` documents a four-step resolution order whose THIRD
 * step — "the server's flag payload, when online" — had never executed in any
 * shipped build. `applyServerFlags` had zero callers repo-wide: it was the
 * seventh instance of the failure this whole file exists to catch, except that
 * unlike the others it was not merely unimported, it was *documented as
 * working* at the top of its own module.
 *
 * `shared/src/features.test.ts` proves the bridge translates and that
 * `isEnabled` changes its answer. Nothing there proves the shell CALLS it, so
 * that is asserted here, as source, in the file that already owns the "is this
 * actually wired" question.
 * ------------------------------------------------------------------------ */

describe('the server\'s flags are adopted, not ignored', () => {
  const main = code(ENTRY);

  it('assigns a SESSION_CONFIG handler on the live NetClient', () => {
    // Beside onModeState / onModeEvent / onModeContext, on `game.net.events` —
    // the same object the three mode messages already use, so a room that never
    // sends one costs nothing.
    expect(main).toMatch(/game\.net\.events\.onSessionConfig = \(config\) => \{/);
  });

  it('calls applyServerFlags THROUGH the bridge, not with the server\'s own keys', () => {
    // `applyServerFlags(config.flags)` would compile, run, and do absolutely
    // nothing: the server's record is keyed by FLAG_ORDER names and `isEnabled`
    // reads Feature ids. That is the version that looks fixed.
    expect(main).toMatch(/applyServerFlags\(featureFlagsFromBits\(config\.flags\)\)/);
    expect(main).not.toMatch(/applyServerFlags\(config\.flags\)/);
  });

  it('imports both halves from shared/src/features.ts and nowhere else', () => {
    expect(main).toMatch(/import \{[\s\S]*?applyServerFlags,[\s\S]*?featureFlagsFromBits,[\s\S]*?\} from '@shared\/features';/);
  });

  it('does NOT treat it as a kill switch, which would be the dangerous reading', () => {
    // A product gate decides what a player is SHOWN and may be overridden by
    // that player; a kill switch decides what the server DOES and may not.
    // Anything that grants value reads the server-resolved bits a second time
    // through `economySurfacesOn`, which no browser can reach — so the handler
    // must not start gating a reward on `isEnabled`.
    const handler = main.slice(
      main.indexOf('game.net.events.onSessionConfig'),
      main.indexOf('game.net.events.onModeState'),
    );
    expect(handler.length).toBeGreaterThan(0);
    expect(/grant|award|scrap|balance/i.test(handler)).toBe(false);
  });
});
