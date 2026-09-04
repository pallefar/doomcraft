/**
 * DOOMCRAFT — the ratchet on the one file `tsc` and `vitest` cannot see into.
 *
 * `console.ts` is a template literal holding a whole HTML document. The
 * compiler checks that it is a string and stops; the test runner never
 * evaluates it. So the ordinary guarantee this repository runs on — "it
 * compiles and the tests pass" — is not merely weak here, it is **absent**, and
 * `docs/PLATFORM.md` §5.1 responds by forbidding decisions from living inside
 * it at all.
 *
 * A rule that lives only in a document gets broken. These are the checks that
 * make it structural. Each one corresponds to a specific way this file can be
 * silently broken by an ordinary edit:
 *
 *   1. A stray backtick or `${` terminates the literal. `tsc` catches that one,
 *      loudly — it already caught it once while this file was being written.
 *   2. **A syntax error inside the page's own script does NOT fail the build.**
 *      `new Function(source)` compiles without executing, so a parse error is a
 *      thrown exception here rather than a blank page in production.
 *   3. A renamed or deleted element id makes `el('x')` return null and the
 *      handler throw at the first click. Every id the script asks for is
 *      checked against the markup.
 *   4. Computing something in the page instead of importing it. The script is
 *      scanned for the decisions that must not be re-implemented locally.
 *   5. `innerHTML` with data. The page builds nodes and sets `textContent`; the
 *      moment that stops being true, every room key and blast radius on the
 *      screen becomes an injection surface.
 */

import { describe, expect, it } from 'vitest';

import { ADMIN_CONSOLE_HTML, adminSignInHtml } from './console.js';
import { MIN_ACTOR_CHARS, MIN_REASON_CHARS } from '../adminAudit.js';
import { NAME_MAX, NAME_MIN, PASSPHRASE_MIN } from '../accounts.js';
import { ROLLOUT_LADDER } from '@doomcraft/shared/flags';

/** The page's own script, as source text. */
const SCRIPT = ((): string => {
  const m = /<script>([\s\S]*?)<\/script>/.exec(ADMIN_CONSOLE_HTML);
  if (m === null) throw new Error('the console has no script block');
  return m[1];
})();

/** Every `id="..."` the markup declares. */
const IDS = new Set<string>(
  [...ADMIN_CONSOLE_HTML.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]),
);

/** The tab names the script builds its panels from. */
const TABS: string[] = ((): string[] => {
  const m = /var TABS = \[([^\]]*)\]/.exec(SCRIPT);
  if (m === null) throw new Error('the console no longer declares TABS');
  return [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
})();

/** Every id the script looks up with `el(...)`, ignoring the computed ones. */
const WANTED = new Set<string>(
  [...SCRIPT.matchAll(/\bel\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]),
);

describe('the document', () => {
  it('is a whole HTML page with a title and no leftover placeholder', () => {
    expect(ADMIN_CONSOLE_HTML.startsWith('<!doctype html>')).toBe(true);
    expect(ADMIN_CONSOLE_HTML).toContain('<title>');
    expect(ADMIN_CONSOLE_HTML.trimEnd().endsWith('</html>')).toBe(true);
    // A `${` that survived into the output is an interpolation that did not
    // happen; a stray backtick would not have compiled at all.
    expect(ADMIN_CONSOLE_HTML).not.toContain('${');
  });

  it('asks not to be indexed and never carries a secret', () => {
    expect(ADMIN_CONSOLE_HTML).toContain('noindex');
    // The page is a shell: it ships no data and no token. If a build ever
    // interpolated one it would land in this string.
    expect(ADMIN_CONSOLE_HTML).not.toMatch(/DOOMCRAFT_ADMIN_TOKEN\s*=\s*['"]/);
    expect(SCRIPT).toContain('sessionStorage');
    expect(SCRIPT, 'a token in localStorage outlives the tab').not.toContain('localStorage');
  });

  it('loads nothing from off-origin, so the game CSP does not have to widen', () => {
    expect(ADMIN_CONSOLE_HTML).not.toMatch(/(src|href)="https?:/);
    expect(ADMIN_CONSOLE_HTML).not.toContain('//cdn');
  });
});

describe('the page script', () => {
  /**
   * THE ONE THAT COULD NOT OTHERWISE FAIL.
   *
   * `new Function` compiles the source without running it, so this is a real
   * parser over the exact bytes the browser receives. A missing bracket in the
   * console is otherwise discovered by opening the console.
   */
  it('PARSES — the only compile check this file will ever get', () => {
    expect(() => new Function(SCRIPT)).not.toThrow();
  });

  it('uses every element it is written against', () => {
    const missing = [...WANTED].filter((id) => !IDS.has(id));
    expect(missing, 'el() names an id the markup does not declare').toEqual([]);
  });

  it('declares no element the script never touches', () => {
    // Not a style rule — a dead id is usually half of a rename that stopped
    // short, and the other half is a handler wired to nothing. The tab panels
    // are looked up by concatenation (`el('tab-' + name)`), so they are added
    // from the same TABS list the script builds them from.
    const built = new Set<string>();
    for (const tab of TABS) { built.add(`tab-${tab}`); built.add(`btn-${tab}`); }
    const orphans = [...IDS].filter((id) => !WANTED.has(id) && !built.has(id));
    expect(orphans, 'these ids are in the markup and nothing reads them').toEqual([]);
  });

  it('never hands data to innerHTML — every value on this page is textContent', () => {
    expect(SCRIPT).not.toMatch(/\.innerHTML\b/);
    expect(SCRIPT).not.toMatch(/\.outerHTML\b/);
    expect(SCRIPT).not.toContain('insertAdjacentHTML');
    expect(SCRIPT).toContain('textContent');
  });

  it('uses no inline handler attributes, which script-src-attr \'none\' forbids', () => {
    expect(ADMIN_CONSOLE_HTML).not.toMatch(/\son[a-z]+="/);
    expect(SCRIPT).toContain('addEventListener');
  });

  it('uses fetch and never a form, because the CSP is form-action \'none\'', () => {
    expect(ADMIN_CONSOLE_HTML).not.toContain('<form');
    expect(SCRIPT).toContain('fetch(');
  });

  it('sends the bearer in a header, never in a URL', () => {
    expect(SCRIPT).toContain('authorization');
    expect(SCRIPT).not.toMatch(/[?&]token=/);
  });
});

describe('the decisions are imported, not computed here', () => {
  it('takes the ladder from shared/src/flags.ts rather than typing five numbers', () => {
    // The literal is interpolated from `ROLLOUT_LADDER`, so a change to the
    // ladder moves the buttons. A hand-written array here would silently offer
    // a rung the server refuses.
    expect(SCRIPT).toContain(`var LADDER = ${JSON.stringify(ROLLOUT_LADDER)};`);
    expect(SCRIPT).toContain(`var MIN_REASON = ${MIN_REASON_CHARS};`);
    expect(SCRIPT).toContain(`var MIN_ACTOR = ${MIN_ACTOR_CHARS};`);
  });

  it('asks the server to plan a write instead of deciding locally', () => {
    expect(SCRIPT).toContain('/api/admin/flags/plan');
    // The risk verdict, the delay and the warnings all come off the plan.
    expect(SCRIPT).toContain('plan.risk');
    expect(SCRIPT).toContain('plan.delayMs');
    expect(SCRIPT).toContain('plan.warnings');
    /* And it never works a reach out for itself: `exposureBp` is the one
     * function that reads a rollout as a population, it lives beside the
     * document it reads, and the page only ever prints what came back. */
    expect(SCRIPT).not.toContain('exposureBp');
    expect(SCRIPT).not.toContain('FLAG_ORDER');
    expect(SCRIPT).toContain('f.reachBp');
  });

  it('renders every read surface this stage added', () => {
    for (const route of [
      '/api/admin/whoami', '/api/admin/status', '/api/admin/flags',
      '/api/admin/entitlement', '/api/admin/player', '/api/admin/audit',
    ]) {
      expect(SCRIPT, `${route} is not rendered anywhere`).toContain(route);
    }
  });
});

describe('the warnings the screen is required to print', () => {
  it('says drain is a one-way door, and offers no button for it', () => {
    expect(SCRIPT).toContain('DRAIN IS A ONE-WAY DOOR');
    // The route exists and takes a reason; the console prints the curl instead
    // of putting an irreversible action one mis-click from a flag row.
    expect(SCRIPT).toContain('curl -X POST');
    expect(SCRIPT).not.toMatch(/api\/admin\/drain['"],\s*'POST'/);
  });

  it('says a flag write hits ONE process', () => {
    expect(SCRIPT).toContain('EVERY FLAG WRITE HITS ONE PROCESS');
    expect(SCRIPT).toContain('DOOMCRAFT_FLAGS');
  });

  it('says a product gate is not a kill switch, which is §5.5(b)\'s whole point', () => {
    expect(SCRIPT).toContain('A product gate is not a kill switch');
    expect(SCRIPT).toContain('maskable');
  });

  it('tells the operator that actor is a label and not authentication', () => {
    expect(ADMIN_CONSOLE_HTML).toContain('a label, not authentication');
  });

  /**
   * The delivery screen's rules are the ones a sponsor's money depends on, and
   * every one of them is a sentence that can be deleted by accident.
   */
  it('renders the delivery report and refuses with an em-dash, never a number', () => {
    expect(SCRIPT, 'the delivery route is not rendered anywhere').toContain('/api/admin/ads');
    /* The em-dash IS the refusal, and this asserts the RENDERING PATH, not the
     * mere presence of the character: an em-dash appears elsewhere in this
     * console (the journal window note), so a looser check passes happily even
     * when the refusal branch has been changed to print 0. */
    expect(SCRIPT, 'the refusal branch prints something other than an em-dash')
      .toContain("wrap.appendChild(make('span', 'muted', '\u2014'));");
    expect(SCRIPT, 'the reason is not shown beside the dash').toContain('mv.reason');
  });

  it('says the report is provisional and not an invoice', () => {
    expect(SCRIPT).toContain('PROVISIONAL');
    expect(SCRIPT).toContain('nothing here is an invoice');
  });

  it('prints the caveat that undetermined is not a measured failure', () => {
    expect(SCRIPT).toContain('Undetermined is not viewable and is not billed');
    expect(SCRIPT, 'the flattering conflation is not warned against')
      .toContain('folding it into non-viewable would flatter the Measured Rate');
  });

  it('shows all three buckets together, which is what makes the conflation impossible', () => {
    expect(SCRIPT).toContain('quoting the viewable share of the total AS the');
  });

  it('says served is not an impression', () => {
    expect(SCRIPT).toContain('served (server-side allocation, NOT an impression)');
    expect(SCRIPT).toContain('a fill can be allocated and never displayed');
  });

  it('says the in-world half does not exist yet, rather than leaving blanks', () => {
    expect(SCRIPT).toContain('are phase 3 and do not exist yet');
  });

  it('says the metrics are in-memory and per-process, so nobody reads them as history', () => {
    expect(SCRIPT).toContain('in-memory and per-process');
    expect(SCRIPT).toContain('No event is emitted');
  });
});

describe('the two-phase confirm', () => {
  it('requires the subject typed back, an actor and a reason before it enables the button', () => {
    expect(SCRIPT).toContain('var subjOk');
    expect(SCRIPT).toContain('var actorOk');
    expect(SCRIPT).toContain('var reasonOk');
    expect(SCRIPT).toContain('go.disabled = !(subjOk && actorOk && reasonOk)');
  });

  it('holds the button disabled while the delay the SERVER computed is running', () => {
    expect(SCRIPT).toContain('if (countdown > 0)');
    expect(SCRIPT).toContain('countdown = Math.ceil((plan.delayMs || 0) / 1000)');
  });

  it('never prefills a reason', () => {
    expect(SCRIPT).toContain("el('c-reason').value = ''");
    expect(SCRIPT).not.toMatch(/c-reason'\)\.value = '[^']/);
  });
});

/* ------------------------------------------------------------------------ *
 * The sign-in page — the same rules, because it is the same kind of file
 *
 * `adminSignInHtml` is a second HTML string outside `tsc` and outside `vitest`,
 * and every argument for the checks above applies to it unchanged. It is
 * checked in BOTH of its states, because the state is chosen on the server and
 * a page that only ever renders one of them is a page half of which nobody has
 * seen.
 * ------------------------------------------------------------------------ */

const SIGNIN_PAGES: Array<{ name: string; html: string; bootstrap: boolean }> = [
  { name: 'bootstrap', html: adminSignInHtml({ bootstrap: true }), bootstrap: true },
  { name: 'sign-in', html: adminSignInHtml({ bootstrap: false }), bootstrap: false },
];

function scriptOf(html: string): string {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (m === null) throw new Error('the sign-in page has no script block');
  return m[1];
}

describe('the sign-in page', () => {
  for (const page of SIGNIN_PAGES) {
    it(`${page.name}: PARSES — the only compile check it will ever get`, () => {
      expect(() => new Function(scriptOf(page.html))).not.toThrow();
    });

    it(`${page.name}: is a whole document with every interpolation resolved`, () => {
      expect(page.html.startsWith('<!doctype html>')).toBe(true);
      expect(page.html.trimEnd().endsWith('</html>')).toBe(true);
      expect(page.html, 'an interpolation did not happen').not.toContain('${');
      expect(page.html).toContain('noindex');
    });

    it(`${page.name}: uses every id it declares and declares every id it uses`, () => {
      const ids = new Set([...page.html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
      const wanted = new Set([...scriptOf(page.html).matchAll(/\bel\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
      expect([...wanted].filter((id) => !ids.has(id)), 'el() names an id the markup lacks').toEqual([]);
      expect([...ids].filter((id) => !wanted.has(id)), 'an id nothing reads').toEqual([]);
    });

    it(`${page.name}: fetch, no submitted element, no inline handler, no innerHTML`, () => {
      // Same three CSP facts as the console: form-action 'none',
      // script-src-attr 'none', and every value on the page is textContent.
      expect(page.html).not.toContain('<form');
      expect(page.html).not.toMatch(/\son[a-z]+="/);
      expect(scriptOf(page.html)).toContain('fetch(');
      expect(scriptOf(page.html)).not.toMatch(/\.innerHTML\b/);
      expect(scriptOf(page.html)).toContain('textContent');
    });

    it(`${page.name}: loads nothing off-origin`, () => {
      expect(page.html).not.toMatch(/(src|href)="https?:/);
    });

    it(`${page.name}: holds no credential and stores nothing`, () => {
      // The session is an httpOnly cookie. There is nothing for this page to
      // keep, so it must not have anywhere to keep it.
      expect(scriptOf(page.html)).not.toContain('localStorage');
      expect(scriptOf(page.html)).not.toContain('sessionStorage');
      expect(scriptOf(page.html)).not.toContain('document.cookie');
    });

    it(`${page.name}: says sessions do not survive a restart`, () => {
      expect(page.html).toContain('Sessions do not survive a restart');
    });

    it(`${page.name}: prints the env-bearer way back in`, () => {
      expect(page.html).toContain('/api/admin/owner/transfer');
      expect(page.html).toContain('DOOMCRAFT_ADMIN_TOKEN');
    });

    it(`${page.name}: takes its limits from accounts.ts rather than typing numbers`, () => {
      expect(page.html).toContain(`${NAME_MIN}-${NAME_MAX} of a-z 0-9 _ -`);
      if (page.bootstrap) expect(page.html).toContain(`at least ${PASSPHRASE_MIN} characters`);
    });
  }

  it('offers to CREATE the owner only when the host has none', () => {
    const [boot, signin] = SIGNIN_PAGES;
    expect(boot.html).toContain('Create the owner account');
    expect(boot.html).toContain('the first account created becomes the owner');
    expect(boot.html).toContain("var MODE = 'bootstrap'");
    expect(boot.html).toContain('/api/auth/signup');

    expect(signin.html).not.toContain('Create the owner account');
    expect(signin.html).toContain('Sign in');
    expect(signin.html).toContain("var MODE = 'signin'");
    expect(signin.html).toContain('/api/auth/signin');
  });
});

describe('the console knows there is a session now', () => {
  it('sends the cookie and only attaches a bearer when one was typed', () => {
    expect(SCRIPT).toContain("credentials: 'same-origin'");
    expect(SCRIPT).toContain("if (tok()) opts.headers.authorization = 'Bearer ' + tok();");
    // The old unconditional `Bearer ` + '' was a malformed credential and would
    // be counted as a failed attempt against the operator's own address.
    expect(SCRIPT).not.toContain("headers: { authorization: 'Bearer ' + tok() }");
  });

  it('renders who is signed in, and can sign them out', () => {
    expect(SCRIPT).toContain('/api/auth/signout');
    expect(SCRIPT).toContain('signed in as ');
  });

  it('prints the owner-transfer escape hatch and the restart warning', () => {
    expect(SCRIPT).toContain('/api/admin/owner/transfer');
    expect(SCRIPT).toContain('THE FIRST ACCOUNT CREATED ON A HOST BECOMES ITS OWNER');
    expect(SCRIPT).toContain('ENVIRONMENT BEARER ONLY');
    expect(SCRIPT).toContain('SESSIONS DO NOT SURVIVE A RESTART');
  });
});
