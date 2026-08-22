/**
 * DOOMCRAFT — the profile overlay's DOM half, driven for real.
 *
 * There is no jsdom in this repo (`vitest.config.ts` sets
 * `environment: 'node'`), and adding one is a 40 MB dev dependency to test
 * ~200 lines of `createElement`. So this file stands up the smallest possible
 * document that `profile.ts` and `matchType.ts` actually touch — the eleven
 * methods and six properties grepped out of both files — and then constructs
 * the REAL `ProfileScreen` against it.
 *
 * WHAT THAT BUYS, AND WHAT IT DOES NOT
 *
 * It buys the structural claims, which are the ones that were going to be
 * wrong: that the overlay mounts as a direct child of the root it was given,
 * that `open()`/`close()` toggle a class and nothing else, that it never writes
 * `data-screen` (which would feed `main.ts`'s MutationObserver into
 * `location.reload()`), that every string the model produced actually reaches a
 * node, and that the stylesheet is refcounted so two overlays closing in the
 * wrong order do not strip each other's CSS.
 *
 * It does NOT buy layout, cascade or paint. Nothing here can tell you the panel
 * is the right width. That is what `node tools/capture-ours.mjs` is for, and
 * the screenshot is part of this stage for exactly that reason.
 *
 * The stub is deliberately dumb: `textContent` concatenates the subtree the way
 * a real one does, `appendChild` reparents, `remove()` unparents. A stub that
 * modelled more would be a stub that could be wrong in its own right.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_PROGRESS, type SaveProgress } from '@shared/constants';
import { defaultFlagBits, FLAG_ORDER } from '@shared/flags';
import { createSaveFile } from '@shared/saves';

import { deviceOnlyAccount, type ProfileInputs } from '@/ui/profileModel';

/* ------------------------------------------------------------------------ *
 * The smallest document that runs this component
 * ------------------------------------------------------------------------ */

class FakeNode {
  readonly tag: string;
  className = '';
  id = '';
  type = '';
  title = '';
  scrollTop = 0;
  disabled = false;
  parent: FakeNode | null = null;
  readonly kids: FakeNode[] = [];
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  readonly events: Record<string, Array<(e: unknown) => void>> = {};
  focused = 0;
  private own = '';

  constructor(tag: string) { this.tag = tag; }

  get classList() {
    const self = this;
    return {
      add(...names: string[]): void {
        const have = new Set(self.className.split(/\s+/).filter(Boolean));
        for (const n of names) have.add(n);
        self.className = [...have].join(' ');
      },
      remove(...names: string[]): void {
        const have = new Set(self.className.split(/\s+/).filter(Boolean));
        for (const n of names) have.delete(n);
        self.className = [...have].join(' ');
      },
      contains(n: string): boolean {
        return self.className.split(/\s+/).includes(n);
      },
    };
  }

  get textContent(): string {
    return this.own + this.kids.map((k) => k.textContent).join('');
  }

  set textContent(v: string) {
    this.kids.length = 0;
    this.own = String(v);
  }

  appendChild<T extends FakeNode>(n: T): T {
    n.parent?.removeChild(n);
    n.parent = this;
    this.kids.push(n);
    return n;
  }

  append(...ns: FakeNode[]): void { for (const n of ns) this.appendChild(n); }

  replaceChildren(...ns: FakeNode[]): void {
    for (const k of this.kids) k.parent = null;
    this.kids.length = 0;
    this.own = '';
    for (const n of ns) this.appendChild(n);
  }

  removeChild(n: FakeNode): void {
    const i = this.kids.indexOf(n);
    if (i >= 0) { this.kids.splice(i, 1); n.parent = null; }
  }

  remove(): void { this.parent?.removeChild(this); }

  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  addEventListener(t: string, f: (e: unknown) => void): void {
    (this.events[t] ??= []).push(f);
  }
  focus(): void { this.focused++; }
  querySelector(): null { return null; }

  /** Fire a listener the way a click would. */
  click(): void {
    for (const f of this.events.click ?? []) f({ preventDefault(): void { /* noop */ } });
  }

  /** Every node in this subtree, self first. */
  all(out: FakeNode[] = []): FakeNode[] {
    out.push(this);
    for (const k of this.kids) k.all(out);
    return out;
  }
}

interface FakeDocument {
  head: FakeNode;
  body: FakeNode;
  createElement(tag: string): FakeNode;
  createTextNode(text: string): FakeNode;
  getElementById(id: string): FakeNode | null;
}

function makeDocument(): FakeDocument {
  const head = new FakeNode('head');
  const body = new FakeNode('body');
  return {
    head,
    body,
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => { const n = new FakeNode('#text'); n.textContent = text; return n; },
    getElementById(id) {
      for (const root of [head, body]) {
        for (const n of root.all()) if (n.id === id) return n;
      }
      return null;
    },
  };
}

/* ------------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------------ */

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const MADE = Date.UTC(2026, 1, 14, 9, 30, 0);

const globals = globalThis as unknown as { document?: FakeDocument };
let doc: FakeDocument;

function inputsOf(patch: Partial<ProfileInputs> = {}): ProfileInputs {
  return {
    save: createSaveFile(MADE),
    progress: { ...DEFAULT_PROGRESS } as SaveProgress,
    remote: null,
    liveBalance: null,
    economyProduct: false,
    flagBits: defaultFlagBits(),
    account: deviceOnlyAccount(),
    nowMs: NOW,
    ...patch,
  };
}

/**
 * `profile.ts` is imported through a fresh module registry on every test, so
 * its module-level `styleUsers` refcount starts at zero and the sheet tests
 * mean something. A single top-level import would carry the count across.
 */
async function loadProfile(): Promise<typeof import('@/ui/profile')> {
  vi.resetModules();
  return import('@/ui/profile');
}

beforeEach(() => {
  doc = makeDocument();
  globals.document = doc;
});

afterEach(() => { delete globals.document; });

/* ------------------------------------------------------------------------ *
 * Mounting
 * ------------------------------------------------------------------------ */

describe('the overlay mounts', () => {
  it('is a DIRECT child of the root it was handed, not a new screen', async () => {
    const { createProfileScreen } = await loadProfile();
    const root = doc.createElement('div');
    root.id = 'ui';
    const screen = createProfileScreen({ root: root as unknown as HTMLElement, inputs: inputsOf });
    expect(root.kids).toHaveLength(1);
    expect(root.kids[0]).toBe(screen.element as unknown as FakeNode);
    expect((screen.element as unknown as FakeNode).className).toBe('dcp');
  });

  it('never writes data-screen, which would feed the reload observer', async () => {
    const { createProfileScreen } = await loadProfile();
    const root = doc.createElement('div');
    root.id = 'ui';
    const screen = createProfileScreen({ root: root as unknown as HTMLElement, inputs: inputsOf });
    screen.open();
    screen.close();
    screen.open();
    for (const n of root.all()) {
      expect(Object.keys(n.dataset), `${n.tag}.${n.className}`).not.toContain('screen');
    }
  });

  it('announces itself as a modal dialog', async () => {
    const { createProfileScreen } = await loadProfile();
    const root = doc.createElement('div');
    const screen = createProfileScreen({ root: root as unknown as HTMLElement, inputs: inputsOf });
    const node = screen.element as unknown as FakeNode;
    expect(node.getAttribute('role')).toBe('dialog');
    expect(node.getAttribute('aria-modal')).toBe('true');
    expect(node.getAttribute('aria-label')).toBe('Player profile');
  });
});

/* ------------------------------------------------------------------------ *
 * Open, close, and the three close paths
 * ------------------------------------------------------------------------ */

describe('open and close', () => {
  it('toggles exactly one class and nothing else', async () => {
    const { createProfileScreen } = await loadProfile();
    const root = doc.createElement('div');
    const screen = createProfileScreen({ root: root as unknown as HTMLElement, inputs: inputsOf });
    const node = screen.element as unknown as FakeNode;
    expect(screen.isOpen).toBe(false);
    expect(node.classList.contains('is-open')).toBe(false);
    screen.open();
    expect(screen.isOpen).toBe(true);
    expect(node.classList.contains('is-open')).toBe(true);
    expect(node.className).toBe('dcp is-open');
    screen.close();
    expect(screen.isOpen).toBe(false);
    expect(node.className).toBe('dcp');
  });

  it('calls back on every close path, and only when it was open', async () => {
    const { createProfileScreen } = await loadProfile();
    const root = doc.createElement('div');
    let closes = 0;
    const screen = createProfileScreen({
      root: root as unknown as HTMLElement, inputs: inputsOf, onClose: () => { closes++; },
    });
    screen.close();                       // never opened: no callback
    expect(closes).toBe(0);
    screen.open(); screen.close();        // the API path (Escape, setScreen)
    expect(closes).toBe(1);
    screen.open();
    (screen.element as unknown as FakeNode).all()
      .find((n) => n.className === 'dcp-x')!.click();   // the × button
    expect(closes).toBe(2);
    expect(screen.isOpen).toBe(false);
    screen.open();
    (screen.element as unknown as FakeNode).all()
      .find((n) => n.className.includes('dcp-done'))!.click();  // the Done button
    expect(closes).toBe(3);
  });

  it('moves focus onto the close button, so Escape is not the only way out', async () => {
    const { createProfileScreen } = await loadProfile();
    const root = doc.createElement('div');
    const screen = createProfileScreen({ root: root as unknown as HTMLElement, inputs: inputsOf });
    const x = (screen.element as unknown as FakeNode).all().find((n) => n.className === 'dcp-x')!;
    expect(x.focused).toBe(0);
    screen.open();
    expect(x.focused).toBe(1);
  });

  it('re-reads its inputs on every open, because the numbers move while it is shut', async () => {
    const { createProfileScreen } = await loadProfile();
    const root = doc.createElement('div');
    const progress = { ...DEFAULT_PROGRESS, kills: 3 } as SaveProgress;
    const screen = createProfileScreen({
      root: root as unknown as HTMLElement, inputs: () => inputsOf({ progress }),
    });
    screen.open();
    expect(screen.view!.tiles[0].value).toBe('3');
    screen.close();
    progress.kills = 1_204;               // a match happened
    screen.open();
    expect(screen.view!.tiles[0].value).toBe('1,204');
    const text = (screen.element as unknown as FakeNode).textContent;
    expect(text).toContain('1,204');
    expect(text).not.toContain('>3<');
  });
});

/* ------------------------------------------------------------------------ *
 * What actually reaches a node
 * ------------------------------------------------------------------------ */

describe('the model reaches the DOM', () => {
  it('renders every panel title, every row and every caveat', async () => {
    const { createProfileScreen } = await loadProfile();
    const root = doc.createElement('div');
    const save = createSaveFile(MADE);
    save.horde.maps.push({ mapId: 'unmistakable', bestWave: 14, bestScore: 9_100, bestTimeSec: 733 });
    save.deathmatch.matches = 12;
    save.deathmatch.kills = 66;
    save.deathmatch.deaths = 33;
    save.deathmatch.weaponKills = [3, 40, 0, 20, 0, 0, 3];
    const screen = createProfileScreen({
      root: root as unknown as HTMLElement, inputs: () => inputsOf({ save }),
    });
    screen.open();
    const text = (screen.element as unknown as FakeNode).textContent;
    const v = screen.view!;
    for (const p of v.panels) {
      expect(text, `panel "${p.title}" is in the model and not on screen`).toContain(p.title);
      for (const r of p.rows) expect(text).toContain(r.right);
      if (p.caveat !== '') expect(text).toContain(p.caveat);
    }
    for (const t of v.tiles) expect(text).toContain(t.value);
    expect(text).toContain(v.sourceNote);
    expect(text).toContain('UNMISTAKABLE');
  });

  it('puts the trust table on the screen through matchType.ts, not in its own words', async () => {
    const { createProfileScreen } = await loadProfile();
    const root = doc.createElement('div');
    const screen = createProfileScreen({ root: root as unknown as HTMLElement, inputs: inputsOf });
    screen.open();
    const notice = (screen.element as unknown as FakeNode).all()
      .find((n) => n.className.includes('dcmt-notice'));
    expect(notice, 'MatchTypeNotice was not mounted — matchType.ts is orphaned again').toBeDefined();
    expect(notice!.textContent).toContain('You earn:');
    expect(['counts', 'unranked']).toContain(notice!.dataset.tone);
    expect(screen.view!.worth.heading).toContain('worth');
  });

  it('sets the bar width from the fraction, as a percentage that is never NaN', async () => {
    const { createProfileScreen } = await loadProfile();
    const root = doc.createElement('div');
    const screen = createProfileScreen({
      root: root as unknown as HTMLElement,
      inputs: () => inputsOf({ progress: { ...DEFAULT_PROGRESS, xp: 100, level: 1 } as SaveProgress }),
    });
    screen.open();
    const fill = (screen.element as unknown as FakeNode).all().find((n) => n.className === 'dcp-fill')!;
    expect(fill.style.width).toMatch(/^\d+(\.\d)?%$/);
    expect(fill.style.width).not.toContain('NaN');
  });

  it('shows the currency panel only when both halves of the gate agree', async () => {
    const { createProfileScreen } = await loadProfile();
    const withScrap = (defaultFlagBits() | (1 << FLAG_ORDER.indexOf('economy_scrap'))) >>> 0;
    const root = doc.createElement('div');
    const dark = createProfileScreen({ root: root as unknown as HTMLElement, inputs: inputsOf });
    dark.open();
    expect((dark.element as unknown as FakeNode).textContent).not.toContain('Points and Scrap');

    const root2 = doc.createElement('div');
    const lit = createProfileScreen({
      root: root2 as unknown as HTMLElement,
      inputs: () => inputsOf({
        economyProduct: true, flagBits: withScrap, liveBalance: { xp: 120, scrap: 14 },
      }),
    });
    lit.open();
    const text = (lit.element as unknown as FakeNode).textContent;
    expect(text).toContain('Points and Scrap');
    expect(text).toContain('120 XP');
  });

  it('never renders a raw NaN, Infinity or undefined into a node', async () => {
    const { createProfileScreen } = await loadProfile();
    const root = doc.createElement('div');
    const save = createSaveFile(MADE) as unknown as Record<string, unknown>;
    (save.profile as Record<string, unknown>).name = null;
    (save.deathmatch as Record<string, unknown>).kills = Number.NaN;
    (save.horde as Record<string, unknown>).maps = [{ mapId: 7, bestWave: undefined }];
    const screen = createProfileScreen({
      root: root as unknown as HTMLElement,
      inputs: () => inputsOf({
        save: save as never,
        progress: { ...DEFAULT_PROGRESS, kills: Number.NaN } as SaveProgress,
      }),
    });
    screen.open();
    const text = (screen.element as unknown as FakeNode).textContent;
    expect(text).not.toMatch(/NaN|Infinity|undefined/);
    for (const n of (screen.element as unknown as FakeNode).all()) {
      for (const val of Object.values(n.style)) expect(val).not.toMatch(/NaN|undefined/);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * The stylesheet
 * ------------------------------------------------------------------------ */

describe('the stylesheet', () => {
  it('is installed once and refcounted, so a second screen closing does not strip it', async () => {
    const { createProfileScreen } = await loadProfile();
    const a = createProfileScreen({
      root: doc.createElement('div') as unknown as HTMLElement, inputs: inputsOf,
    });
    const b = createProfileScreen({
      root: doc.createElement('div') as unknown as HTMLElement, inputs: inputsOf,
    });
    expect(doc.head.kids.filter((n) => n.id === 'dc-profile-css')).toHaveLength(1);
    a.destroy();
    expect(doc.getElementById('dc-profile-css')).not.toBeNull();
    b.destroy();
    expect(doc.getElementById('dc-profile-css')).toBeNull();
  });

  it('restates the button typography at #ui specificity', async () => {
    // `#ui button{font:inherit}` in main.ts is (1,0,1) and beats every class
    // rule. modeSelect.ts never restated its own and that is why the shipped
    // PLAY button is 14 px system-ui rather than the 19 px Arial Black it asks
    // for — `letter-spacing` survives, which is why it looks nearly right.
    const { PROFILE_CSS } = await loadProfile();
    expect(PROFILE_CSS).toContain('#ui .dcp-x{font:');
    expect(PROFILE_CSS).toContain('#ui .dcp-done{font:');
  });

  it('uses its own prefix and the safe-area variables', async () => {
    const { PROFILE_CSS } = await loadProfile();
    // A fourth `.dc-` block would collide the way `.dc-note` already does.
    expect(PROFILE_CSS).not.toMatch(/^\.dc-[a-z]/m);
    for (const v of ['--safe-t', '--safe-b', '--safe-l', '--safe-r']) {
      expect(PROFILE_CSS).toContain(v);
    }
  });

  it('takes the overlay down and unparents it on destroy', async () => {
    const { createProfileScreen } = await loadProfile();
    const root = doc.createElement('div');
    const screen = createProfileScreen({ root: root as unknown as HTMLElement, inputs: inputsOf });
    screen.open();
    screen.destroy();
    expect(root.kids).toHaveLength(0);
    expect(screen.isOpen).toBe(false);
    screen.open();                       // destroyed screens stay destroyed
    expect(screen.isOpen).toBe(false);
  });
});
