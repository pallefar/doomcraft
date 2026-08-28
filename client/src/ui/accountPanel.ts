/**
 * DOOMCRAFT — the account panel inside the profile overlay (PLATFORM C4).
 *
 * The DOM half of `/api/auth/*`. Every decision that matters was made
 * server-side — the §3.2 rows run there, atomically, and this panel only
 * ever RENDERS an outcome: the sign-in form, the one row-3 question with
 * the numbers at stake, the signed-in state, or the merge offer it cannot
 * execute yet (C5). It holds the passphrase in a local variable exactly as
 * long as a retry needs it and never anywhere else.
 *
 * The row-3 wording is §3.2.1 VERBATIM — one question, two buttons, no
 * modal wall — because the sister who has never seen those numbers should
 * find her answer obvious.
 */

export interface AccountPanelOptions {
  /** '' = same origin. The static build with no server renders a sentence. */
  serverBase: string;
  deviceId: () => string;
  /** Fired whenever the signed-in state changes, for the shell's own view. */
  onChanged?: (signedIn: { name: string; role: string } | null) => void;
}

const STYLE_ID = 'dc-account-panel-css';
let styleUsers = 0;

const CSS = `
.dcpa{border:1px solid rgba(255,255,255,.13);border-radius:3px;background:rgba(10,10,14,.86);
  padding:12px 14px 13px;font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
  color:#e8e6e3}
.dcpa h3{margin:0 0 9px;font:700 11px/1.2 system-ui;letter-spacing:.2em;
  text-transform:uppercase;color:#8d8781}
.dcpa p{margin:0 0 8px;color:#9d968f;font-size:12.5px}
.dcpa p b{color:#e2ddd8;font-weight:600}
.dcpa-form{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dcpa-form input{min-height:38px;padding:8px 10px;background:#15151b;color:#e8e6e3;
  border:1px solid rgba(255,255,255,.16);border-radius:2px;font:inherit;font-size:13px}
.dcpa-form input:focus{outline:none;border-color:rgba(255,255,255,.4)}
.dcpa-row{grid-column:1/-1;display:flex;gap:8px;flex-wrap:wrap}
.dcpa-err{grid-column:1/-1;margin:0;color:#e8695a;font-size:12px;min-height:1.2em}
.dcpa-ask{border:1px solid rgba(240,160,32,.5);border-radius:3px;background:rgba(240,160,32,.07);
  padding:11px 12px;margin-top:4px}
.dcpa-ask b{display:block;color:#ffd9a0;font-size:13.5px;margin-bottom:5px}
.dcpa-ask p{color:#cfc9c3;margin:0 0 9px;font-variant-numeric:tabular-nums}
.dcpa-note{font-size:11.5px;color:#7d7873;margin:8px 0 0}
#ui .dcpa button{font:700 12px/1 system-ui;letter-spacing:.08em;min-height:38px;
  padding:9px 16px;border:1px solid rgba(255,255,255,.22);border-radius:2px;
  background:rgba(255,255,255,.06);color:#e8e6e3;cursor:pointer;text-transform:uppercase}
#ui .dcpa button:hover{border-color:rgba(255,255,255,.4)}
#ui .dcpa button.go{background:#8f1a08;border-color:#e03c1c;color:#ffe6d8}
#ui .dcpa button.go:hover{background:#b02510}
#ui .dcpa button:disabled{opacity:.5;cursor:progress}
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

interface AskSummary { level: number; xp: number; scrap: number; matches: number; firstPlayedMs: number }

type AuthAnswer = {
  status: number;
  account?: { name: string; role: string };
  ask?: AskSummary;
  merge?: { offered: boolean };
  decisionRow?: number;
  error?: string;
};

export class AccountPanel {
  readonly element: HTMLElement;

  private readonly opts: AccountPanelOptions;
  private readonly body: HTMLElement;
  private destroyed = false;
  private busy = false;
  /** Held only while a row-3 answer is pending, then dropped. */
  private pending: { mode: 'signup' | 'signin'; name: string; pass: string } | null = null;

  constructor(opts: AccountPanelOptions) {
    this.opts = opts;
    ensureStyle();
    this.element = el('div', 'dcpa');
    this.element.appendChild(el('h3', undefined, 'Account'));
    this.body = el('div');
    this.element.appendChild(this.body);
    this.renderLine('Checking…');
    void this.refresh();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.element.remove();
    releaseStyle();
  }

  /** Ask the server who this browser is and render accordingly. */
  async refresh(): Promise<void> {
    if (this.offline()) {
      this.renderLine('Progress lives in this browser. Accounts need a game server, and this build talks to none.');
      this.opts.onChanged?.(null);
      return;
    }
    const me = await this.call('/api/auth/me');
    if (this.destroyed) return;
    if (me.status === 200 && me.account !== undefined) {
      this.renderSignedIn(me.account);
      this.opts.onChanged?.(me.account);
    } else {
      this.renderSignedOut('');
      this.opts.onChanged?.(null);
    }
    void this.renderReferral();
  }

  /** Viral tier 1: the player's own code, minted server-side on first ask. */
  private async renderReferral(): Promise<void> {
    const mine = await this.call(`/api/referral/mine?device=${encodeURIComponent(this.opts.deviceId())}`) as
      { status: number; code?: string; converted?: number };
    if (this.destroyed || mine.status !== 200 || typeof mine.code !== 'string') return;
    const line = el('p', 'dcpa-note');
    line.append('Refer a friend: share ');
    const link = el('b', undefined, `${location.origin}/?ref=${mine.code}`);
    line.appendChild(link);
    line.append(` — you both earn Scrap when they reach level 5 or 30 minutes of play.${(mine.converted ?? 0) > 0 ? ` Converted so far: ${mine.converted}.` : ''}`);
    this.body.appendChild(line);
  }

  /* ---------------------------------------------------------------- */

  private offline(): boolean {
    return this.opts.serverBase === '' && location.origin === 'null';
  }

  private async call(path: string, body?: unknown): Promise<AuthAnswer> {
    try {
      const res = await fetch(`${this.opts.serverBase}${path}`, body === undefined ? {} : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({})) as Omit<AuthAnswer, 'status'>;
      return { status: res.status, ...json };
    } catch {
      return { status: 0 };
    }
  }

  private clear(): void {
    while (this.body.firstChild) this.body.removeChild(this.body.firstChild);
  }

  private renderLine(text: string): void {
    this.clear();
    this.body.appendChild(el('p', undefined, text));
  }

  private renderSignedIn(account: { name: string; role: string }): void {
    this.clear();
    const line = el('p');
    line.append('Signed in as ');
    line.appendChild(el('b', undefined, account.name));
    line.append(account.role === 'owner' ? ' — this host’s owner.' : '.');
    this.body.appendChild(line);
    this.body.appendChild(el('p', 'dcpa-note',
      'Your progress banks to this account on every device you sign in on. '
      + 'A name and passphrase prove possession, not identity — there is no reset if both are lost.'));
    const row = el('div', 'dcpa-row');
    const out = el('button', undefined, 'Sign out');
    out.type = 'button';
    out.addEventListener('click', () => { void this.signOut(); });
    row.appendChild(out);
    this.body.appendChild(row);
  }

  private renderSignedOut(error: string): void {
    this.clear();
    this.body.appendChild(el('p', undefined,
      'Keep your progress across devices and browser wipes: pick a name and a passphrase (12 characters or more).'));
    const form = el('form', 'dcpa-form');
    const name = el('input');
    name.type = 'text';
    name.placeholder = 'Name';
    name.autocomplete = 'username';
    name.maxLength = 32;
    const pass = el('input');
    pass.type = 'password';
    pass.placeholder = 'Passphrase (12+ characters)';
    pass.autocomplete = 'current-password';
    const row = el('div', 'dcpa-row');
    const signin = el('button', 'go', 'Sign in');
    signin.type = 'submit';
    const signup = el('button', undefined, 'Create account');
    signup.type = 'button';
    const err = el('p', 'dcpa-err', error);
    row.append(signin, signup);
    form.append(name, pass, row, err);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit('signin', name.value, pass.value, err, [signin, signup]);
    });
    signup.addEventListener('click', () => {
      void this.submit('signup', name.value, pass.value, err, [signin, signup]);
    });
    this.body.appendChild(form);
  }

  private async submit(
    mode: 'signup' | 'signin', name: string, pass: string,
    err: HTMLElement, buttons: HTMLButtonElement[],
  ): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    for (const b of buttons) b.disabled = true;
    const answer = await this.call(`/api/auth/${mode}`, {
      name, passphrase: pass, deviceId: this.opts.deviceId(),
    });
    this.busy = false;
    if (this.destroyed) return;
    for (const b of buttons) b.disabled = false;

    if (answer.status === 200 && answer.ask !== undefined) {
      // Row 3: the ONE question, before anything exists (signup) or before
      // this device is bound (signin).
      this.pending = { mode, name, pass };
      this.renderAsk(answer.ask);
      return;
    }
    if ((answer.status === 200 || answer.status === 201) && answer.account !== undefined) {
      this.renderSignedIn(answer.account);
      if (answer.merge?.offered === true) void this.renderMergeOffer(answer.account);
      this.opts.onChanged?.(answer.account);
      return;
    }
    err.textContent = answer.status === 0
      ? 'No server answered.'
      : answer.error ?? (answer.status === 401 ? 'Wrong name or passphrase.' : `Refused (${answer.status}).`);
  }

  private renderAsk(ask: AskSummary): void {
    this.clear();
    const card = el('div', 'dcpa-ask');
    card.appendChild(el('b', undefined, 'Keep this device’s progress?'));
    const first = ask.firstPlayedMs > 0 ? new Date(ask.firstPlayedMs).toLocaleDateString() : '—';
    card.appendChild(el('p', undefined,
      `Level ${ask.level} · ${ask.xp.toLocaleString()} XP · ${ask.scrap.toLocaleString()} Scrap · `
      + `${ask.matches.toLocaleString()} matches · first played ${first}`));
    const row = el('div', 'dcpa-row');
    const keep = el('button', 'go', 'Keep it');
    keep.type = 'button';
    const fresh = el('button', undefined, 'Start fresh');
    fresh.type = 'button';
    keep.addEventListener('click', () => { void this.answer(true); });
    fresh.addEventListener('click', () => { void this.answer(false); });
    row.append(keep, fresh);
    card.appendChild(row);
    this.body.appendChild(card);
    this.body.appendChild(el('p', 'dcpa-note',
      'Start fresh leaves this device’s progress unclaimed, so whoever earned it can still claim it later.'));
  }

  private async answer(keepProgress: boolean): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    if (pending === null) { void this.refresh(); return; }
    const answer = await this.call(`/api/auth/${pending.mode}`, {
      name: pending.name, passphrase: pending.pass,
      deviceId: this.opts.deviceId(), keepProgress,
    });
    if (this.destroyed) return;
    if ((answer.status === 200 || answer.status === 201) && answer.account !== undefined) {
      this.renderSignedIn(answer.account);
      this.opts.onChanged?.(answer.account);
      return;
    }
    this.renderSignedOut(answer.error ?? 'That did not go through — try again.');
  }

  /**
   * Row 8's offer (docs/PLATFORM.md §3.2/§3.8): the plan comes from the
   * server and its summary renders VERBATIM — the confirm dialog never
   * paraphrases what the merge will do with money.
   */
  private async renderMergeOffer(account: { name: string; role: string }): Promise<void> {
    const preview = await this.call('/api/account/merge', { deviceId: this.opts.deviceId(), preview: true });
    if (this.destroyed) return;
    const plan = (preview as { plan?: { summary?: string[]; notMerged?: string[] } }).plan;
    const card = el('div', 'dcpa-ask');
    card.appendChild(el('b', undefined, 'This device has separate progress. Merge it into your account?'));
    for (const line of plan?.summary ?? []) card.appendChild(el('p', undefined, line));
    const row = el('div', 'dcpa-row');
    const merge = el('button', 'go', 'Merge it in');
    merge.type = 'button';
    const keep = el('button', undefined, 'Keep separate');
    keep.type = 'button';
    merge.addEventListener('click', () => {
      void (async (): Promise<void> => {
        merge.disabled = true;
        const done = await this.call('/api/account/merge', { deviceId: this.opts.deviceId() });
        if (this.destroyed) return;
        card.remove();
        this.renderSignedIn(account);
        this.body.appendChild(el('p', 'dcpa-note', done.status === 200
          ? 'Merged. This device now banks to your account, and the Scrap moved as a journal entry.'
          : `The merge was refused: ${done.error ?? done.status}.`));
      })();
    });
    keep.addEventListener('click', () => {
      // Decline -> row 5: the device joins the account without the progress.
      void (async (): Promise<void> => {
        keep.disabled = true;
        await this.call('/api/account/merge', { deviceId: this.opts.deviceId(), decline: true });
        if (this.destroyed) return;
        card.remove();
        this.body.appendChild(el('p', 'dcpa-note',
          'Kept separate. This device plays under your account from here on; its old progress stays put.'));
      })();
    });
    row.append(merge, keep);
    card.appendChild(row);
    for (const line of plan?.notMerged ?? []) card.appendChild(el('p', 'dcpa-note', line));
    this.body.appendChild(card);
  }

  private async signOut(): Promise<void> {
    await this.call('/api/auth/signout', {});
    if (this.destroyed) return;
    this.renderSignedOut('');
    this.opts.onChanged?.(null);
  }
}

export function createAccountPanel(opts: AccountPanelOptions): AccountPanel {
  return new AccountPanel(opts);
}
