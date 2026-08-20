/**
 * DOOMCRAFT — the Builder world browser.
 *
 * There is nothing to A/B this against, because the bar has no such screen.
 * `classic.minecraft.net` generates one world on load and forgets it on unload:
 * no list, no name, no save, no ownership, no way back (`ref/mcclassic/`, and
 * `mc-uitext.txt` is empty because the whole game is a canvas). Every world in
 * the bar is a world you will never see again.
 *
 * So the reference for this screen is the rest of our own menu — it has to sit
 * next to `ui/modeSelect.ts` without looking like a different product — and the
 * job list from `docs/MODES.md`: create, name, rename, delete, duplicate, join
 * by code, last played and size.
 *
 * Decisions worth stating:
 *
 *   - **Join-by-code is the first control, not a footnote.** "Join a friend's
 *     world" is the headline feature of Builder multiplayer, and burying it
 *     under a list of your own worlds gets the priority backwards. It accepts
 *     the code in any case with any spacing, because people read codes out
 *     loud, and it says why a code is wrong before you press anything.
 *   - **Rename is inline.** A modal to change a string is a modal too many;
 *     the row's name is a text input that commits on blur and on Enter.
 *   - **Destructive actions confirm in place.** Delete turns into "Delete?
 *     yes / no" inside the row rather than opening a dialog that steals focus
 *     and then has to give it back.
 *   - **Size is honest.** The column shows what the world costs on disk as
 *     reported by the server (`WorldSummary.bytes`), and falls back to the edit
 *     count for a local world that has never been uploaded. A world browser
 *     that cannot tell you which world is the big one is a filing cabinet with
 *     no labels.
 *   - **Fixed-height scroller.** Same rule as the mode select: the list scrolls
 *     inside itself and the actions are anchored, so 1 world and 24 worlds
 *     produce the same page height and the reserved ad slots never move.
 *
 * The component owns no state beyond the rows it was handed: every mutation
 * goes out through a callback and comes back as a fresh `setWorlds()`, so the
 * server and the save file stay the single source of truth.
 */

/* ------------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------------ */

/** One row. Built from a `BuilderWorld` save record, a server summary, or both. */
export interface WorldRow {
  id: string;
  name: string;
  seed: number;
  /** Share code, uppercased for display. '' for a local-only world. */
  code: string;
  /** Epoch ms of the last edit. 0 when never played. */
  updatedMs: number;
  createdMs: number;
  blocksPlaced: number;
  blocksBroken: number;
  /** Bytes on the server. 0 when unknown; the row then estimates from edits. */
  bytes: number;
  /** Distinct voxels this world differs from its terrain by. */
  edits: number;
  /** True when the server has a copy. */
  online: boolean;
  /** 'owner' | 'builder' | 'visitor'. Drives which buttons are enabled. */
  role: string;
  /** Packed 0xRRGGBB tile swatch. */
  swatch: number;
}

export function createWorldRow(id: string, name: string, seed: number): WorldRow {
  return {
    id, name, seed, code: '', updatedMs: 0, createdMs: 0,
    blocksPlaced: 0, blocksBroken: 0, bytes: 0, edits: 0,
    online: false, role: 'owner', swatch: 0x74b449,
  };
}

/** Shape of the `BuilderWorld` records in `shared/src/saves.ts`. */
export interface SaveWorldLike {
  id: string;
  name: string;
  seed: number;
  createdMs: number;
  updatedMs: number;
  blocksPlaced: number;
  blocksBroken: number;
  editedChunks: number;
  online: boolean;
  shareCode: string;
  swatch: number;
}

/** Shape of `WorldSummary` from `server/src/worlds.ts`, as it arrives as JSON. */
export interface ServerWorldLike {
  id: string;
  name: string;
  code: string;
  seed: number;
  updatedMs: number;
  createdMs: number;
  members: number;
  edits: number;
  bytes: number;
  yourRole: string;
}

/** Rows from the local save file. */
export function rowsFromSave(worlds: readonly SaveWorldLike[]): WorldRow[] {
  return worlds.map((w) => ({
    id: w.id,
    name: w.name,
    seed: w.seed,
    code: w.shareCode,
    updatedMs: w.updatedMs,
    createdMs: w.createdMs,
    blocksPlaced: w.blocksPlaced,
    blocksBroken: w.blocksBroken,
    bytes: 0,
    edits: w.blocksPlaced + w.blocksBroken,
    online: w.online,
    role: 'owner',
    swatch: w.swatch,
  }));
}

/**
 * Fold the server's list over the local one. The server wins on everything it
 * knows (size, code, your role) and the save keeps what it alone knows (how
 * many blocks *you* placed), so a world you have played on two devices reads
 * correctly on both.
 */
export function mergeServerRows(local: readonly WorldRow[], remote: readonly ServerWorldLike[]): WorldRow[] {
  const out = local.map((r) => ({ ...r }));
  const byId = new Map<string, WorldRow>();
  for (const r of out) byId.set(r.id, r);
  for (const s of remote) {
    const existing = byId.get(s.id);
    if (existing !== undefined) {
      existing.name = s.name;
      existing.code = s.code;
      existing.bytes = s.bytes;
      existing.edits = s.edits;
      existing.online = true;
      existing.role = s.yourRole;
      existing.updatedMs = Math.max(existing.updatedMs, s.updatedMs);
      continue;
    }
    const row = createWorldRow(s.id, s.name, s.seed);
    row.code = s.code;
    row.updatedMs = s.updatedMs;
    row.createdMs = s.createdMs;
    row.bytes = s.bytes;
    row.edits = s.edits;
    row.online = true;
    row.role = s.yourRole;
    out.push(row);
    byId.set(row.id, row);
  }
  return out;
}

/* ------------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------------ */

/** "just now" / "14 min ago" / "3 days ago" / "never". */
export function formatAgo(thenMs: number, nowMs: number): string {
  if (thenMs <= 0) return 'never';
  const s = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.round(d / 30);
  return `${mo} month${mo === 1 ? '' : 's'} ago`;
}

/** Human bytes, two significant figures. */
export function formatBytes(n: number): string {
  if (n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/**
 * Size for a world the server has not reported. The `.dcw` encoder writes a
 * varint gap plus an id byte plus a varint actor per changed voxel; in a real
 * world that averages a shade over three bytes, so this is an estimate the row
 * can show without lying about being measured — it is rendered with a `~`.
 */
export function estimateBytes(edits: number): number {
  return edits <= 0 ? 0 : 320 + edits * 3;
}

/** Split a 6-character code into "ABC DEF" so it can be read out loud. */
export function formatCode(code: string): string {
  const c = code.toUpperCase();
  return c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
}

/** Accepts any spacing/case; returns lowercase or '' when it is not a code. */
export function normaliseCodeInput(raw: string): string {
  const alphabet = '23456789abcdefghjkmnpqrstuvwxyz';
  let out = '';
  const s = raw.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ' || c === '-' || c === '_') continue;
    if (alphabet.indexOf(c) < 0) return '';
    if (out.length >= 6) return '';
    out += c;
  }
  return out.length === 6 ? out : '';
}

/** A fresh, human-ish default name so nobody has to think of one. */
const NAME_WORDS_A = ['Iron', 'Hollow', 'Bright', 'Quiet', 'Deep', 'Amber', 'Cold', 'Red'];
const NAME_WORDS_B = ['Hold', 'Reach', 'Terrace', 'Yard', 'Spire', 'Basin', 'Works', 'Landing'];

export function suggestWorldName(existing: readonly WorldRow[], seed: number): string {
  const a = NAME_WORDS_A[(seed >>> 3) % NAME_WORDS_A.length];
  const b = NAME_WORDS_B[(seed >>> 11) % NAME_WORDS_B.length];
  const base = `${a} ${b}`;
  let name = base;
  let n = 2;
  const taken = new Set(existing.map((w) => w.name.toLowerCase()));
  while (taken.has(name.toLowerCase())) { name = `${base} ${n}`; n++; }
  return name;
}

/* ------------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------------ */

export interface WorldBrowserOptions {
  root: HTMLElement;
  worlds?: WorldRow[];
  /** Epoch ms; injectable so the "3 days ago" column is testable. */
  now?: () => number;
  /** Play the world. */
  onPlay(id: string, row: WorldRow): void;
  /** Create one. Return the new id, or '' to refuse. */
  onCreate(name: string, seed: number): string;
  onRename?(id: string, name: string): void;
  onDelete?(id: string): void;
  onDuplicate?(id: string): void;
  /** Join by share code. Return '' to reject the code with a message. */
  onJoinCode?(code: string): string;
  /** Fired whenever the selection moves, so the shell can preview the world. */
  onSelect?(id: string): void;
}

/* ------------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------------ */

const STYLE_ID = 'dc-worldbrowser-css';
let styleUsers = 0;

const CSS = `
.dcw{--dcw-ink:#e8e6e3;--dcw-dim:#938e89;--dcw-line:rgba(255,255,255,.13);
  --dcw-panel:rgba(10,10,14,.86);--dcw-hot:#f0a020;
  display:flex;flex-direction:column;gap:12px;width:min(940px,94vw);margin:0 auto;
  font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--dcw-ink);
  text-align:left}
.dcw *{box-sizing:border-box}
.dcw-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.dcw-head h2{margin:0;font-size:19px;font-weight:660;letter-spacing:.01em}
.dcw-head p{margin:0;color:var(--dcw-dim);font-size:12px}

.dcw-join{display:flex;gap:8px;align-items:center;flex-wrap:wrap;
  padding:12px;border:1px solid var(--dcw-line);border-radius:6px;background:var(--dcw-panel)}
.dcw-join label{color:var(--dcw-dim);font-size:12px}
.dcw-code{flex:0 0 190px;min-width:140px;height:44px;padding:0 12px;border-radius:4px;
  border:1px solid var(--dcw-line);background:rgba(0,0,0,.4);color:var(--dcw-ink);
  font:16px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.18em;
  text-transform:uppercase}
.dcw-code:focus{outline:2px solid var(--dcw-hot);outline-offset:0}
.dcw-msg{color:#ff9a86;font-size:12px;min-height:16px;flex:1 1 100%}
.dcw-msg.ok{color:#8fd07a}

.dcw-list{border:1px solid var(--dcw-line);border-radius:6px;background:var(--dcw-panel);
  overflow-y:auto;max-height:min(48vh,420px)}
.dcw-row{display:grid;grid-template-columns:34px minmax(0,1fr) 104px 92px 78px auto;gap:10px;
  align-items:center;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06)}
.dcw-row:last-child{border-bottom:none}
.dcw-row.on{background:rgba(240,160,32,.09)}
.dcw-sw{width:26px;height:26px;border-radius:4px;border:1px solid rgba(0,0,0,.5)}
.dcw-nm{min-width:0}
.dcw-nm input{width:100%;height:32px;padding:0 6px;border-radius:3px;border:1px solid transparent;
  background:transparent;color:var(--dcw-ink);font:14px/1.2 inherit;font-weight:600}
.dcw-nm input:hover{border-color:var(--dcw-line)}
.dcw-nm input:focus{outline:none;border-color:var(--dcw-hot);background:rgba(0,0,0,.35)}
.dcw-nm input:disabled{border-color:transparent;color:var(--dcw-ink);opacity:1}
.dcw-sub{color:var(--dcw-dim);font-size:11px;padding-left:6px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcw-col{color:var(--dcw-dim);font-size:12px;white-space:nowrap}
.dcw-col b{color:var(--dcw-ink);font-weight:600}
.dcw-acts{display:flex;gap:6px;justify-content:flex-end}
.dcw-btn{min-width:44px;min-height:36px;padding:0 12px;border-radius:4px;cursor:pointer;
  border:1px solid var(--dcw-line);background:rgba(255,255,255,.04);color:var(--dcw-ink);
  font:12px/1 inherit}
.dcw-btn:hover:not(:disabled){border-color:var(--dcw-hot);background:rgba(240,160,32,.12)}
.dcw-btn:disabled{opacity:.35;cursor:not-allowed}
.dcw-btn.pri{background:var(--dcw-hot);border-color:var(--dcw-hot);color:#140d04;font-weight:660}
.dcw-btn.dgr:hover:not(:disabled){border-color:#e03c1c;background:rgba(224,60,28,.16);color:#ffb9a6}
.dcw-empty{padding:34px 16px;text-align:center;color:var(--dcw-dim)}
.dcw-foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dcw-foot .sp{flex:1}
.dcw-tag{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#8a857f;
  border:1px solid var(--dcw-line);border-radius:9px;padding:2px 7px}
.dcw-tag.on{color:#8fd07a;border-color:rgba(143,208,122,.45)}
/* Narrow: three lines per row — identity, stats, actions.
   The obvious mobile reflow is to let every grid child claim its own row, and that is what this
   used to do. Rendered at 412x915 it made each world 450 px tall, so the list's own 420 px
   scroller showed one world and the top half of the next one's buttons — a row sliced through
   the middle reads as a broken page, not as "scroll for more". Flex instead, and keep the three
   stat cells on ONE shared line: they are short ("11 hours ago", "3.4 KB", "OWNER") and together
   they fit inside 412 px with room to spare. A row is ~130 px, so three of them fit whole. */
@media (max-width:700px){
  .dcw-row{display:flex;flex-wrap:wrap;align-items:center;row-gap:8px}
  .dcw-sw{flex:0 0 26px}
  /* The name takes the whole of line one. Letting it merely flex against the three stat cells
     is what the first attempt did, and at 412 px it left "Hangar R…", "Sky Fo…", "Cathed…" —
     truncating the single field the row exists to identify. A basis of 100% minus the swatch
     and its gap leaves no room beside it, so the stats are forced onto line two. */
  .dcw-nm{flex:1 1 calc(100% - 46px);min-width:0}
  .dcw-col{flex:0 0 auto;margin-right:16px}
  .dcw-col:last-of-type{margin-right:0}
  .dcw-acts{flex:1 1 100%;justify-content:flex-start;flex-wrap:wrap}
  .dcw-list{max-height:min(62vh,560px)}
}
`;

function ensureStyle(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID) === null) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  styleUsers++;
}
function releaseStyle(): void {
  styleUsers--;
  if (styleUsers > 0 || typeof document === 'undefined') return;
  document.getElementById(STYLE_ID)?.remove();
}

function hexOf(color: number): string {
  return `#${(color >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;
}

/* ------------------------------------------------------------------------ *
 * The component
 * ------------------------------------------------------------------------ */

export class WorldBrowser {
  readonly element: HTMLDivElement;

  private readonly opts: WorldBrowserOptions;
  private readonly list: HTMLDivElement;
  private readonly message: HTMLDivElement;
  private readonly codeInput: HTMLInputElement;
  private readonly joinButton: HTMLButtonElement;
  private readonly now: () => number;

  private rows: WorldRow[] = [];
  private selectedId = '';
  private confirmingDelete = '';
  private busy = false;

  constructor(options: WorldBrowserOptions) {
    ensureStyle();
    this.opts = options;
    this.now = options.now ?? Date.now;

    this.element = document.createElement('div');
    this.element.className = 'dcw';

    /* header */
    const head = document.createElement('div');
    head.className = 'dcw-head';
    const h2 = document.createElement('h2');
    h2.textContent = 'Your worlds';
    const p = document.createElement('p');
    p.textContent = 'Persistent, shared and saved on the server — they survive a restart.';
    head.append(h2, p);

    /* join by code */
    const join = document.createElement('div');
    join.className = 'dcw-join';
    const label = document.createElement('label');
    label.textContent = "Join a friend's world";
    label.htmlFor = 'dcw-code-input';
    this.codeInput = document.createElement('input');
    this.codeInput.className = 'dcw-code';
    this.codeInput.id = 'dcw-code-input';
    this.codeInput.placeholder = 'ABC DEF';
    this.codeInput.autocomplete = 'off';
    this.codeInput.spellcheck = false;
    this.codeInput.maxLength = 9;
    this.joinButton = button('Join', 'pri');
    this.joinButton.disabled = true;
    const create = button('New world');
    this.message = document.createElement('div');
    this.message.className = 'dcw-msg';
    join.append(label, this.codeInput, this.joinButton, spacer(), create, this.message);

    /* list */
    this.list = document.createElement('div');
    this.list.className = 'dcw-list';
    this.list.setAttribute('role', 'list');

    this.element.append(head, join, this.list);
    options.root.appendChild(this.element);

    this.codeInput.addEventListener('input', () => this.onCodeInput());
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.joinByCode(); }
    });
    this.joinButton.addEventListener('click', () => this.joinByCode());
    create.addEventListener('click', () => this.createWorld());

    this.setWorlds(options.worlds ?? []);
  }

  /* --- public API -------------------------------------------------------- */

  setWorlds(rows: WorldRow[]): void {
    this.rows = rows.slice().sort((a, b) => b.updatedMs - a.updatedMs);
    if (this.selectedId === '' || !this.rows.some((r) => r.id === this.selectedId)) {
      this.selectedId = this.rows.length > 0 ? this.rows[0].id : '';
    }
    this.confirmingDelete = '';
    this.render();
  }

  get worlds(): readonly WorldRow[] { return this.rows; }
  get selected(): string { return this.selectedId; }

  select(id: string): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.confirmingDelete = '';
    this.render();
    this.opts.onSelect?.(id);
  }

  /** Disable everything while a network call is in flight. */
  setBusy(busy: boolean, label = ''): void {
    this.busy = busy;
    if (label !== '') this.setMessage(label, true);
    this.render();
  }

  setMessage(text: string, ok = false): void {
    this.message.textContent = text;
    this.message.classList.toggle('ok', ok);
  }

  focus(): void { this.codeInput.focus(); }

  destroy(): void {
    this.element.remove();
    releaseStyle();
  }

  /* --- actions ------------------------------------------------------------ */

  private onCodeInput(): void {
    const code = normaliseCodeInput(this.codeInput.value);
    this.joinButton.disabled = code === '' || this.busy;
    if (this.codeInput.value.trim() === '') { this.setMessage(''); return; }
    this.setMessage(code === '' ? 'A world code is 6 characters — no O, I, L, 0 or 1.' : '');
  }

  private joinByCode(): void {
    if (this.busy) return;
    const code = normaliseCodeInput(this.codeInput.value);
    if (code === '') { this.setMessage('That is not a world code.'); return; }
    const handler = this.opts.onJoinCode;
    if (handler === undefined) { this.setMessage('Joining by code needs a connection.'); return; }
    const id = handler(code);
    if (id === '') { this.setMessage(`No world answers to ${formatCode(code)}.`); return; }
    this.setMessage(`Joining ${formatCode(code)}…`, true);
    this.selectedId = id;
  }

  private createWorld(): void {
    if (this.busy) return;
    const seed = (this.now() ^ (this.rows.length * 0x9e3779b9)) >>> 0;
    const name = suggestWorldName(this.rows, seed);
    const id = this.opts.onCreate(name, seed);
    if (id === '') { this.setMessage('Could not create a world.'); return; }
    this.selectedId = id;
    this.setMessage(`Created “${name}”.`, true);
  }

  private rename(row: WorldRow, next: string): void {
    const clean = next.trim().slice(0, 32);
    if (clean === '' || clean === row.name) return;
    row.name = clean;
    this.opts.onRename?.(row.id, clean);
  }

  /* --- rendering ---------------------------------------------------------- */

  private render(): void {
    this.list.textContent = '';
    this.joinButton.disabled = this.busy || normaliseCodeInput(this.codeInput.value) === '';

    if (this.rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dcw-empty';
      empty.innerHTML = 'No worlds yet.<br>Make one, or type a friend’s code above.';
      this.list.appendChild(empty);
      return;
    }

    const now = this.now();
    for (const row of this.rows) {
      this.list.appendChild(this.renderRow(row, now));
    }
  }

  private renderRow(row: WorldRow, now: number): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'dcw-row';
    el.setAttribute('role', 'listitem');
    el.classList.toggle('on', row.id === this.selectedId);
    el.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      this.select(row.id);
    });

    const sw = document.createElement('div');
    sw.className = 'dcw-sw';
    sw.style.background = hexOf(row.swatch);

    const nm = document.createElement('div');
    nm.className = 'dcw-nm';
    const input = document.createElement('input');
    input.value = row.name;
    input.maxLength = 32;
    input.setAttribute('aria-label', `Name of ${row.name}`);
    input.disabled = this.busy || row.role === 'visitor';
    input.addEventListener('blur', () => this.rename(row, input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = row.name; input.blur(); }
    });
    const sub = document.createElement('div');
    sub.className = 'dcw-sub';
    const codeText = row.code === '' ? 'local only' : `code ${formatCode(row.code)}`;
    sub.textContent = `${codeText} · seed ${row.seed >>> 0} · ${row.blocksPlaced} placed`;
    nm.append(input, sub);

    const played = document.createElement('div');
    played.className = 'dcw-col';
    played.innerHTML = `<b>${formatAgo(row.updatedMs, now)}</b><br>last played`;

    const size = document.createElement('div');
    size.className = 'dcw-col';
    const measured = row.bytes > 0;
    const bytes = measured ? row.bytes : estimateBytes(row.edits);
    size.innerHTML = `<b>${measured ? '' : '~'}${formatBytes(bytes)}</b><br>${row.edits} edits`;

    const tags = document.createElement('div');
    tags.className = 'dcw-col';
    const tag = document.createElement('span');
    tag.className = `dcw-tag${row.online ? ' on' : ''}`;
    tag.textContent = row.online ? row.role : 'offline';
    tags.appendChild(tag);

    const acts = document.createElement('div');
    acts.className = 'dcw-acts';
    if (this.confirmingDelete === row.id) {
      const q = document.createElement('span');
      q.className = 'dcw-col';
      q.textContent = 'Delete?';
      const yes = button('Yes', 'dgr');
      const no = button('No');
      yes.addEventListener('click', () => {
        this.confirmingDelete = '';
        this.opts.onDelete?.(row.id);
        this.rows = this.rows.filter((r) => r.id !== row.id);
        if (this.selectedId === row.id) this.selectedId = this.rows.length > 0 ? this.rows[0].id : '';
        this.setMessage(`Deleted “${row.name}”.`, true);
        this.render();
      });
      no.addEventListener('click', () => { this.confirmingDelete = ''; this.render(); });
      acts.append(q, yes, no);
    } else {
      const play = button('Play', 'pri');
      play.disabled = this.busy;
      play.addEventListener('click', () => { this.select(row.id); this.opts.onPlay(row.id, row); });

      const dup = button('Duplicate');
      dup.disabled = this.busy || this.opts.onDuplicate === undefined || row.role === 'visitor';
      dup.addEventListener('click', () => {
        this.opts.onDuplicate?.(row.id);
        this.setMessage(`Duplicating “${row.name}”…`, true);
      });

      const del = button('Delete', 'dgr');
      del.disabled = this.busy || this.opts.onDelete === undefined || row.role !== 'owner';
      del.title = row.role === 'owner' ? 'Delete this world' : 'Only the owner can delete a world';
      del.addEventListener('click', () => { this.confirmingDelete = row.id; this.render(); });

      acts.append(play, dup, del);
    }

    el.append(sw, nm, played, size, tags, acts);
    return el;
  }
}

/* ------------------------------------------------------------------------ *
 * Tiny DOM helpers
 * ------------------------------------------------------------------------ */

function button(text: string, kind = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `dcw-btn${kind === '' ? '' : ` ${kind}`}`;
  b.textContent = text;
  return b;
}

function spacer(): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = 'sp';
  s.style.flex = '1';
  return s;
}

/** Convenience for the shell: build, mount and return in one call. */
export function createWorldBrowser(options: WorldBrowserOptions): WorldBrowser {
  return new WorldBrowser(options);
}
