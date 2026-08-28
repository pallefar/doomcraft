/**
 * DOOMCRAFT — the Competitions tab inside the profile overlay. The DOM half.
 *
 * Decisions live in `competitionsModel.ts`; this file is three fetches and
 * `document.createElement`, in `accountPanel.ts`'s conventions. Data moves on
 * post-round sweeps, so there is NO poll here — the tab refetches when shown
 * and after an enter, and the model's own line tells the player the numbers
 * are not live. Standings are fetched lazily, per expanded competition, and
 * the server's refusal sentences render verbatim.
 */

import {
  buildChallengesSection,
  buildCompetitionsView,
  type CompetitionsInputs,
  type WireChallenge,
  type WireCompetition,
  type WireStanding,
} from '@/ui/competitionsModel';

export interface CompetitionsTabOptions {
  /** '' = same origin. */
  serverBase: string;
  deviceId: () => string;
}

const STYLE_ID = 'dc-competitions-css';
let styleUsers = 0;

const CSS = `
.dcc{font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#e8e6e3}
.dcc-line{margin:0 0 10px;font-size:12.5px;color:#9d968f}
.dcc-err{margin:0 0 10px;font-size:12px;color:#e8695a;min-height:1.2em}
.dcc-box{border:1px solid rgba(255,255,255,.13);border-radius:3px;background:rgba(10,10,14,.86);
  padding:12px 14px;margin:0 0 11px}
.dcc-head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.dcc-head b{font:700 14px/1.2 system-ui;color:#f4f1ee}
.dcc-kind{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#8d8781;
  border:1px solid rgba(255,255,255,.16);border-radius:2px;padding:2px 6px}
.dcc-clock{margin-left:auto;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#9d968f}
.dcc-sub{margin:6px 0 0;font-size:12px;color:#9d968f}
.dcc-you{margin:6px 0 0;font-size:12.5px;color:#ffd9a0}
.dcc-row{display:flex;gap:8px;margin-top:9px;align-items:center;flex-wrap:wrap}
.dcc-rule{font-size:11.5px;color:#7d7873}
.dcc-tbl{margin-top:9px;border-top:1px solid rgba(255,255,255,.09)}
.dcc-st{display:flex;gap:12px;padding:5px 0;border-top:1px solid rgba(255,255,255,.06);
  font-variant-numeric:tabular-nums;font-size:12.5px;color:#c9c3bd}
.dcc-st:first-of-type{border-top:0}
.dcc-st b{flex:0 0 3em;font-weight:600;color:#9d968f}
.dcc-st span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcc-st em{font-style:normal;flex:0 0 auto;color:#9d968f}
.dcc-st.is-you{color:#ffe6d8}
.dcc-st.is-you b,.dcc-st.is-you em{color:#ffd9a0}
.dcc-empty{padding:8px 0 2px;font-size:12px;color:#7d7873}
.dcc-chhead{font:700 14px/1.2 system-ui;color:#f4f1ee;margin:0 0 8px}
.dcc-ch{display:flex;gap:10px;align-items:center;padding:7px 0;border-top:1px solid rgba(255,255,255,.06)}
.dcc-ch:first-of-type{border-top:0}
.dcc-ch-main{flex:1;min-width:0}
.dcc-ch-name{font:600 12.5px/1.3 system-ui;color:#e8e6e3}
.dcc-ch-name em{font-style:normal;font-size:10px;letter-spacing:.14em;text-transform:uppercase;
  color:#8d8781;margin-left:7px}
.dcc-ch-blurb{font-size:11.5px;color:#9d968f;margin-top:1px}
.dcc-ch-bar{height:3px;border-radius:2px;background:rgba(255,255,255,.1);margin-top:5px;overflow:hidden}
.dcc-ch-bar i{display:block;height:100%;background:#e03c1c}
.dcc-ch.is-done .dcc-ch-bar i{background:#5da05a}
.dcc-ch-right{flex:0 0 auto;text-align:right}
.dcc-ch-prog{font-variant-numeric:tabular-nums;font-size:12px;color:#c9c3bd}
.dcc-ch.is-done .dcc-ch-prog{color:#8fc48c}
.dcc-ch-reward{font-size:11px;color:#ffd9a0;margin-top:1px}
.dcc-ch-note{margin:9px 0 0;font-size:11.5px;color:#7d7873}
#ui .dcc button{font:700 11px/1 system-ui;letter-spacing:.08em;min-height:32px;
  padding:8px 14px;border:1px solid rgba(255,255,255,.22);border-radius:2px;
  background:rgba(255,255,255,.06);color:#e8e6e3;cursor:pointer;text-transform:uppercase}
#ui .dcc button:hover{border-color:rgba(255,255,255,.4)}
#ui .dcc button.go{background:#8f1a08;border-color:#e03c1c;color:#ffe6d8}
#ui .dcc button:disabled{opacity:.5;cursor:progress}
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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls !== undefined) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export class CompetitionsTab {
  readonly element: HTMLElement;

  private readonly opts: CompetitionsTabOptions;
  private destroyed = false;
  private busy = false;
  private error = '';
  private phase: CompetitionsInputs['phase'] = 'loading';
  private competitions: WireCompetition[] = [];
  /** null until the wire answers — a hidden section, never an empty board. */
  private challenges: WireChallenge[] | null = null;
  private standings: Record<string, WireStanding[]> = {};
  private open = '';

  constructor(opts: CompetitionsTabOptions) {
    this.opts = opts;
    ensureStyle();
    this.element = el('div', 'dcc');
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
    this.error = '';
    this.phase = 'loading';
    this.render();
    const device = encodeURIComponent(this.opts.deviceId());
    const [res, chal] = await Promise.all([
      this.get(`/api/competitions?device=${device}`) as
        Promise<{ status: number; competitions?: WireCompetition[] }>,
      this.get(`/api/challenges?device=${device}`) as
        Promise<{ status: number; challenges?: WireChallenge[] }>,
    ]);
    if (this.destroyed) return;
    if (res.status === 200 && Array.isArray(res.competitions)) {
      this.competitions = res.competitions;
      this.phase = 'ready';
    } else {
      this.competitions = [];
      this.phase = 'offline';
    }
    this.challenges = chal.status === 200 && Array.isArray(chal.challenges)
      ? chal.challenges
      : null;
    // A stale expansion survives a refetch only if its competition still runs.
    if (this.open !== '' && !this.competitions.some((c) => c.id === this.open)) this.open = '';
    this.render();
  }

  /* ------------------------------------------------------------------ */

  private async get(path: string): Promise<Record<string, unknown> & { status: number }> {
    try {
      const res = await fetch(`${this.opts.serverBase}${path}`);
      const json = await res.json().catch(() => ({})) as Record<string, unknown>;
      return { status: res.status, ...json };
    } catch {
      return { status: 0 };
    }
  }

  private async toggle(id: string): Promise<void> {
    this.open = this.open === id ? '' : id;
    this.render();
    if (this.open === '' || Object.prototype.hasOwnProperty.call(this.standings, this.open)) return;
    const res = await this.get(
      `/api/competitions/standings?id=${encodeURIComponent(id)}&device=${encodeURIComponent(this.opts.deviceId())}`,
    ) as { status: number; standings?: WireStanding[] };
    if (this.destroyed) return;
    if (res.status === 200 && Array.isArray(res.standings)) this.standings[id] = res.standings;
    else this.standings[id] = [];
    this.render();
  }

  private async enter(id: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    this.render();
    let status = 0;
    let answer: { error?: string } = {};
    try {
      const res = await fetch(`${this.opts.serverBase}/api/competitions/enter`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, deviceId: this.opts.deviceId() }),
      });
      status = res.status;
      answer = await res.json().catch(() => ({})) as typeof answer;
    } catch { /* status stays 0 */ }
    if (this.destroyed) return;
    this.busy = false;
    if (status === 200) {
      await this.refresh(); // idempotent server-side; the list now says entered
      return;
    }
    this.error = status === 0 ? 'No server answered.' : answer.error ?? `Refused (${status}).`;
    this.render();
  }

  /* ------------------------------------------------------------------ *
   * Painting — no decisions, only placement
   * ------------------------------------------------------------------ */

  private render(): void {
    const v = buildCompetitionsView({
      phase: this.phase,
      competitions: this.competitions,
      standings: this.standings,
      open: this.open,
      busy: this.busy,
      error: this.error,
      nowMs: Date.now(),
    });
    this.element.replaceChildren();
    this.element.appendChild(el('p', 'dcc-line', v.line));
    if (v.error !== '') this.element.appendChild(el('p', 'dcc-err', v.error));

    const ch = buildChallengesSection(this.challenges);
    if (ch.heading !== '') {
      const box = el('div', 'dcc-box');
      box.appendChild(el('p', 'dcc-chhead', ch.heading));
      for (const row of ch.rows) {
        const line = el('div', row.done ? 'dcc-ch is-done' : 'dcc-ch');
        const main = el('div', 'dcc-ch-main');
        const name = el('div', 'dcc-ch-name', row.name);
        name.appendChild(el('em', undefined, row.periodLabel));
        main.appendChild(name);
        main.appendChild(el('div', 'dcc-ch-blurb', row.blurb));
        const bar = el('div', 'dcc-ch-bar');
        const fill = el('i');
        fill.style.width = `${Math.round(row.frac * 100)}%`;
        bar.appendChild(fill);
        main.appendChild(bar);
        const right = el('div', 'dcc-ch-right');
        right.appendChild(el('div', 'dcc-ch-prog', row.progress));
        right.appendChild(el('div', 'dcc-ch-reward', row.reward));
        line.append(main, right);
        box.appendChild(line);
      }
      box.appendChild(el('p', 'dcc-ch-note', ch.note));
      this.element.appendChild(box);
    }

    for (const row of v.rows) {
      const box = el('div', 'dcc-box');
      const head = el('div', 'dcc-head');
      head.append(
        el('b', undefined, row.name),
        el('span', 'dcc-kind', row.kindLabel),
        el('span', 'dcc-clock', row.clock),
      );
      box.appendChild(head);
      box.appendChild(el('p', 'dcc-sub', `${row.prize} · ${row.entrants} enrolled`));
      if (row.yours !== '') box.appendChild(el('p', 'dcc-you', row.yours));

      const actions = el('div', 'dcc-row');
      if (row.canEnter) {
        const enter = el('button', 'go', 'Enter');
        enter.type = 'button';
        enter.addEventListener('click', () => { void this.enter(row.id); });
        actions.appendChild(enter);
        if (row.entryRule !== '') actions.appendChild(el('span', 'dcc-rule', row.entryRule));
      }
      const standings = el('button', undefined, row.open ? 'Hide standings' : 'Standings');
      standings.type = 'button';
      standings.addEventListener('click', () => { void this.toggle(row.id); });
      actions.appendChild(standings);
      box.appendChild(actions);

      if (row.open) {
        const tbl = el('div', 'dcc-tbl');
        if (v.table === null) tbl.appendChild(el('p', 'dcc-empty', 'Loading standings…'));
        else if (v.table.length === 0) tbl.appendChild(el('p', 'dcc-empty', v.emptyTable));
        else {
          for (const s of v.table) {
            const line = el('div', s.you ? 'dcc-st is-you' : 'dcc-st');
            line.append(
              el('b', undefined, s.rank),
              el('span', undefined, s.name),
              el('em', undefined, `${s.points} pts · ${s.wins} wins`),
            );
            tbl.appendChild(line);
          }
        }
        box.appendChild(tbl);
      }
      this.element.appendChild(box);
    }
  }
}

export function createCompetitionsTab(opts: CompetitionsTabOptions): CompetitionsTab {
  return new CompetitionsTab(opts);
}
