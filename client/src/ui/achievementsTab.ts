/**
 * DOOMCRAFT — the Achievements tab inside the profile overlay. The DOM half.
 *
 * Decisions live in `achievementsModel.ts`; this file is one fetch and
 * `document.createElement`, in `competitionsTab.ts`'s conventions. There is no
 * poll: an achievement moves at the end of a match, so the tab refetches when
 * it is shown and the model's own note tells the player where the numbers come
 * from.
 */

import {
  buildAchievementsSection,
  type WireAchievement,
} from '@/ui/achievementsModel';

export interface AchievementsTabOptions {
  /** '' = same origin. */
  serverBase: string;
  deviceId: () => string;
}

const STYLE_ID = 'dc-achievements-css';
let styleUsers = 0;

const CSS = `
.dca{font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#e8e6e3}
.dca-line{margin:0 0 10px;font-size:12.5px;color:#9d968f}
.dca-err{margin:0 0 10px;font-size:12px;color:#e8695a;min-height:1.2em}
.dca-box{border:1px solid rgba(255,255,255,.13);border-radius:3px;background:rgba(10,10,14,.86);
  padding:12px 14px;margin:0 0 11px}
.dca-head{display:flex;gap:10px;align-items:baseline;margin:0 0 8px}
.dca-head b{font:700 14px/1.2 system-ui;color:#f4f1ee}
.dca-tally{margin-left:auto;font:600 11px/1.2 system-ui;letter-spacing:.14em;
  text-transform:uppercase;color:#8d8781;font-variant-numeric:tabular-nums}
.dca-row{display:flex;gap:10px;align-items:center;padding:8px 0;
  border-top:1px solid rgba(255,255,255,.06)}
.dca-row:first-of-type{border-top:0}
.dca-main{flex:1;min-width:0}
.dca-name{font:600 12.5px/1.3 system-ui;color:#e8e6e3}
.dca-name em{font-style:normal;font-size:10px;letter-spacing:.14em;text-transform:uppercase;
  color:#8d8781;margin-left:7px}
.dca-blurb{font-size:11.5px;color:#9d968f;margin-top:1px}
.dca-bar{height:3px;border-radius:2px;background:rgba(255,255,255,.1);margin-top:5px;overflow:hidden}
.dca-bar i{display:block;height:100%;background:#e03c1c}
.dca-row.is-earned .dca-bar i{background:#e0a01c}
.dca-row.is-paid .dca-bar i{background:#5da05a}
.dca-note{font-size:11px;color:#e0a01c;margin-top:3px}
.dca-right{flex:0 0 auto;text-align:right}
.dca-prog{font-variant-numeric:tabular-nums;font-size:12px;color:#c9c3bd}
.dca-row.is-earned .dca-prog{color:#e8c47a}
.dca-row.is-paid .dca-prog{color:#8fc48c}
.dca-reward{font-size:11px;color:#ffd9a0;margin-top:1px}
.dca-foot{margin:9px 0 0;font-size:11.5px;color:#7d7873}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) === null) {
    const node = document.createElement('style');
    node.id = STYLE_ID;
    node.textContent = CSS;
    document.head.appendChild(node);
  }
  styleUsers++;
}
function releaseStyle(): void {
  styleUsers = Math.max(0, styleUsers - 1);
  if (styleUsers > 0) return;
  document.getElementById(STYLE_ID)?.remove();
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export class AchievementsTab {
  readonly element: HTMLElement;

  private readonly opts: AchievementsTabOptions;
  private destroyed = false;
  /** null until the wire answers — a hidden section, never an empty board. */
  private achievements: WireAchievement[] | null = null;
  private phase: 'loading' | 'ready' | 'offline' = 'loading';

  constructor(opts: AchievementsTabOptions) {
    this.opts = opts;
    ensureStyle();
    this.element = el('div', 'dca');
    this.render();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.element.remove();
    releaseStyle();
  }

  /** Called by the overlay on every switch to this tab. */
  async refresh(): Promise<void> {
    this.phase = 'loading';
    this.render();
    const device = encodeURIComponent(this.opts.deviceId());
    const res = await this.get(`/api/achievements?device=${device}`);
    if (this.destroyed) return;
    if (res.status === 200 && Array.isArray(res.achievements)) {
      this.achievements = res.achievements as WireAchievement[];
      this.phase = 'ready';
    } else {
      /* NOT an empty board. A player who has earned nothing and a server that
       * did not answer look identical in a list of zero rows, and only one of
       * those is the player's fault. */
      this.achievements = null;
      this.phase = 'offline';
    }
    this.render();
  }

  private async get(path: string): Promise<Record<string, unknown> & { status: number }> {
    try {
      const res = await fetch(`${this.opts.serverBase}${path}`);
      const json = await res.json().catch(() => ({})) as Record<string, unknown>;
      return { status: res.status, ...json };
    } catch {
      return { status: 0 };
    }
  }

  private render(): void {
    const root = this.element;
    root.textContent = '';

    if (this.phase === 'loading') {
      root.appendChild(el('p', 'dca-line', 'Loading your record…'));
      return;
    }
    if (this.phase === 'offline') {
      root.appendChild(el('p', 'dca-err', 'No server answered, so your record is not shown.'));
      root.appendChild(el('p', 'dca-line',
        'Achievements live on your account, not on this device — nothing has been lost.'));
      return;
    }

    const view = buildAchievementsSection(this.achievements);
    if (view.heading === '') {
      root.appendChild(el('p', 'dca-line', 'No achievements are running yet.'));
      return;
    }

    const box = el('div', 'dca-box');
    const head = el('div', 'dca-head');
    head.appendChild(el('b', undefined, view.heading));
    head.appendChild(el('span', 'dca-tally', view.tally));
    box.appendChild(head);

    for (const r of view.rows) {
      const row = el('div', `dca-row is-${r.state}`);
      const main = el('div', 'dca-main');
      const name = el('div', 'dca-name', r.name);
      if (r.state === 'paid') name.appendChild(el('em', undefined, 'unlocked'));
      main.appendChild(name);
      main.appendChild(el('div', 'dca-blurb', r.blurb));
      const bar = el('div', 'dca-bar');
      const fill = el('i');
      fill.style.width = `${Math.round(Math.max(0, Math.min(1, r.frac)) * 100)}%`;
      bar.appendChild(fill);
      main.appendChild(bar);
      if (r.note !== '') main.appendChild(el('div', 'dca-note', r.note));
      row.appendChild(main);

      const right = el('div', 'dca-right');
      right.appendChild(el('div', 'dca-prog', r.progress));
      right.appendChild(el('div', 'dca-reward', r.reward));
      row.appendChild(right);
      box.appendChild(row);
    }

    box.appendChild(el('p', 'dca-foot', view.note));
    root.appendChild(box);
  }
}

export function createAchievementsTab(opts: AchievementsTabOptions): AchievementsTab {
  return new AchievementsTab(opts);
}
