/**
 * DOOMCRAFT — the admin console, as one HTML document.
 *
 * ## Where this runs, and why that is the whole design
 *
 * On the Node origin, at `GET /admin`, from this module bundled into
 * `server/dist/server.mjs` by esbuild. It is **never in `dist/`**, never on the
 * static host, never in a player's browser, and it does not widen the game's
 * CSP by one byte — it rides the same nonce stamp `index.html` does. When
 * `DOOMCRAFT_ADMIN_TOKEN` is unset the route **does not exist**: an
 * unconfigured deployment does not advertise an admin surface at all.
 *
 * The page is a shell. It ships no data and holds no secret: the token is typed
 * in, kept in `sessionStorage` (which dies with the tab, unlike localStorage),
 * never in the URL and never in a query string. Every `/api/admin/*` call it
 * makes is gated by `AdminGate`; this route is not, because there is nothing
 * here to gate.
 *
 * ## The rule this file lives under
 *
 * This is a template literal. **`tsc` does not see inside it and `vitest` does
 * not run it.** It is the one surface in this repository where "it compiles and
 * the tests pass" is not even on offer, so:
 *
 *   > Nothing that can be WRONG may live in here.
 *
 * Every decision is imported, not computed: `shared/src/flags.ts` produces the
 * diff, the risk verdict, the confirm delay, the ladder and the warning list;
 * `server/src/admin/model.ts` produces the redaction, the rollup and the list
 * of things this console cannot do. What is left here is `createElement`,
 * `textContent` and `addEventListener`.
 *
 * ## Two properties of the markup, both deliberate
 *
 * 1. **No `innerHTML` is ever given data.** Every value that reaches the page
 *    goes through `textContent`. Room keys, flag blast radii, audit reasons and
 *    operator-typed strings are all rendered as text by construction, so there
 *    is no escaping to get right and no injection path to miss.
 * 2. **`fetch`, never a `<form>`.** The Node CSP is `form-action 'none'`
 *    (`server/src/index.ts`), so a form would not submit; more to the point, a
 *    form is a navigation and this page must never navigate away from a
 *    half-armed confirm.
 *
 * ## What is deliberately NOT here
 *
 * **A DRAIN button.** The route exists and now requires a reason and an actor,
 * but `HostLifecycle` has `beginDrain()` and `finish()` and **no path back to
 * `ADMITTING`** — undoing a drain costs a process restart. A one-way door with
 * no undo does not belong one mis-click away from a flag row, so the console
 * prints the state, prints the warning, and prints the exact `curl` that does
 * it. `docs/PLATFORM.md` §5.4 lists drain among the writes; this is a
 * deliberate departure and it is stated in the UI rather than only here.
 */

import { ROLLOUT_LADDER } from '@doomcraft/shared/flags';
import { MIN_ACTOR_CHARS, MIN_REASON_CHARS } from '../adminAudit.js';
import { NAME_MAX, NAME_MIN, PASSPHRASE_MIN } from '../accounts.js';

const LADDER_JSON = JSON.stringify(ROLLOUT_LADDER);

/**
 * The document. `%NONCE%` is not used — `index.ts` stamps the nonce onto every
 * `<style>` and `<script>` on the way out with the same function it uses for
 * the game, so this string carries no per-response state and can be a constant.
 */
export const ADMIN_CONSOLE_HTML: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<!-- An empty data: icon, so the page does not fire a 404 for /favicon.ico on
     every load. The img-src 'self' data: directive already allows it. -->
<link rel="icon" href="data:,">
<title>doomcraft — operator console</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #0b0d10; color: #d7dde5;
    font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  a { color: #7fb6ff; }
  header {
    position: sticky; top: 0; z-index: 5; background: #11151b;
    border-bottom: 1px solid #232a33; padding: 10px 14px;
  }
  h1 { font-size: 14px; margin: 0 0 6px; letter-spacing: .12em; text-transform: uppercase; color: #9fb0c4; }
  .facts { display: flex; flex-wrap: wrap; gap: 4px 18px; }
  .fact b { color: #8ea3ba; font-weight: 400; }
  .fact span { color: #eef3f8; }
  nav { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 14px; border-bottom: 1px solid #232a33; }
  nav button { min-width: 96px; }
  button {
    font: inherit; background: #1b2129; color: #d7dde5; border: 1px solid #2e3844;
    padding: 5px 10px; cursor: pointer; border-radius: 3px;
  }
  button:hover:enabled { background: #232c37; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.on { background: #2a3d55; border-color: #3f5f85; color: #eaf2ff; }
  button.danger { border-color: #6b3535; color: #ffbcbc; }
  button.go { border-color: #3a6b45; color: #b9f0c6; }
  main { padding: 14px; }
  section { display: none; }
  section.live { display: block; }
  h2 { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: #8ea3ba; margin: 18px 0 6px; }
  h2:first-child { margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 8px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #1d242c; vertical-align: top; }
  th { color: #7f92a6; font-weight: 400; white-space: nowrap; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .note { color: #8ea3ba; margin: 6px 0 10px; max-width: 78ch; }
  .warn {
    border-left: 3px solid #7a5a20; background: #1a1710; color: #e8d5a8;
    padding: 8px 10px; margin: 8px 0; max-width: 100ch;
  }
  .bad { border-left-color: #7a2a2a; background: #1a1010; color: #f0bcbc; }
  .blast { color: #e8d5a8; }
  .muted { color: #6d7d8f; }
  .pill { display: inline-block; padding: 0 6px; border: 1px solid #2e3844; border-radius: 10px; color: #9fb0c4; }
  .pill.yes { border-color: #3a6b45; color: #b9f0c6; }
  .pill.no { border-color: #6b3535; color: #ffbcbc; }
  input, textarea { font: inherit; background: #0f141a; color: #eef3f8; border: 1px solid #2e3844; padding: 5px 7px; border-radius: 3px; }
  input { width: 22ch; }
  textarea { width: 100%; max-width: 80ch; height: 4.4em; }
  code, pre { background: #0f141a; border: 1px solid #1d242c; border-radius: 3px; }
  code { padding: 1px 5px; }
  pre { padding: 8px 10px; overflow-x: auto; max-width: 100ch; }
  .rowline { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 6px 0; }
  dialog {
    background: #11151b; color: #d7dde5; border: 1px solid #3a4756; border-radius: 4px;
    max-width: 90ch; width: calc(100vw - 40px);
  }
  dialog::backdrop { background: rgba(0,0,0,.72); }
  .err { color: #ffbcbc; }
  .ok { color: #b9f0c6; }
</style>
</head>
<body>
<header>
  <h1>doomcraft — operator console</h1>
  <div class="facts" id="facts"></div>
  <div class="rowline">
    <label for="token" class="muted">bearer</label>
    <input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="DOOMCRAFT_ADMIN_TOKEN">
    <button id="save-token">use</button>
    <button id="forget-token">forget</button>
    <button id="refresh">refresh</button>
    <span id="auth-state" class="muted">no token in this tab</span>
  </div>
  <div class="rowline">
    <span id="who" class="muted">not signed in</span>
    <button id="signout">sign out</button>
  </div>
</header>
<nav id="tabs"></nav>
<main>
  <section id="tab-fleet">
    <h2>who owns this host</h2>
    <div class="warn" id="owner-note"></div>
    <h2>this host</h2>
    <div id="fleet-deploy"></div>
    <div class="warn" id="drain-warning"></div>
    <h2>rooms</h2>
    <div id="fleet-rooms"></div>
    <h2>directory &amp; signalling</h2>
    <div id="fleet-signal"></div>
  </section>

  <section id="tab-flags">
    <div class="note" id="flags-head"></div>
    <div class="warn" id="flags-warning"></div>
    <div class="rowline">
      <button id="freeze-toggle"></button>
      <span class="muted" id="freeze-note"></span>
    </div>
    <h2>registry</h2>
    <div id="flags-table"></div>
  </section>

  <section id="tab-refusals">
    <div class="note">
      Only refusals and strips are recorded, so an empty ring beside a non-zero
      <code>accepted</code> is what a healthy process looks like. A ring full of one code is
      somebody probing. Device ids are reduced to eight characters before they leave the process.
    </div>
    <h2>gate</h2>
    <div id="guard-status"></div>
    <h2>recent refusals</h2>
    <div id="guard-ring"></div>
  </section>

  <section id="tab-player">
    <div class="rowline">
      <label for="player-key" class="muted">device id</label>
      <input id="player-key" autocomplete="off" spellcheck="false" placeholder="device-…">
      <button id="player-go">look up</button>
      <span id="player-state" class="muted"></span>
    </div>
    <div class="note">
      Lookup is by exact device id — the profile store cannot enumerate, so there is no list and no
      search. The id you type never comes back out: everything below is keyed by an eight-character
      handle.
    </div>
    <div id="player-body"></div>
    <h2>what this console cannot do</h2>
    <div class="note">
      These are not disabled buttons. There is no storage behind them yet, and a console that renders
      them anyway is one that lies about its own powers.
    </div>
    <div id="player-missing"></div>
  </section>

  <section id="tab-metrics">
    <div class="note" id="metrics-note"></div>
    <h2>fleet</h2>
    <div id="metrics-fleet"></div>
    <h2>connections — per-connection counters, rolled up</h2>
    <div id="metrics-conn"></div>
    <h2>signalling</h2>
    <div id="metrics-signal"></div>
    <h2>journal &amp; audit</h2>
    <div id="metrics-stores"></div>
  </section>

  <section id="tab-audit">
    <div class="note">
      Every mutation writes one row with its before and after state. Rows whose verb starts with
      <code>player.</code> are moderation records and are retained past the ordinary window.
    </div>
    <div id="audit-body"></div>
  </section>
</main>

<dialog id="confirm">
  <h2 id="c-title">confirm</h2>
  <div id="c-diff"></div>
  <div id="c-warnings"></div>
  <div class="rowline">
    <label for="c-actor" class="muted">actor</label>
    <input id="c-actor" autocomplete="off" spellcheck="false" placeholder="who you are">
    <span class="muted">a label, not authentication — one shared bearer admits the request</span>
  </div>
  <div class="rowline">
    <label for="c-subject" class="muted">type the subject back</label>
    <input id="c-subject" autocomplete="off" spellcheck="false">
    <span class="muted" id="c-subject-want"></span>
  </div>
  <div class="rowline" style="display:block">
    <label for="c-reason" class="muted">reason (min ${MIN_REASON_CHARS} characters, no default, never prefilled)</label>
    <textarea id="c-reason" spellcheck="false"></textarea>
  </div>
  <div class="rowline">
    <button id="c-go" class="danger" disabled>confirm</button>
    <button id="c-cancel">cancel</button>
    <span id="c-state" class="muted"></span>
  </div>
</dialog>

<script>
(function () {
  'use strict';

  var LADDER = ${LADDER_JSON};
  var MIN_REASON = ${MIN_REASON_CHARS};
  var MIN_ACTOR = ${MIN_ACTOR_CHARS};
  var TOKEN_KEY = 'dc.admin.token';
  var TABS = ['fleet', 'flags', 'refusals', 'player', 'metrics', 'audit'];

  /* ---- tiny DOM helpers. Everything below builds nodes; nothing sets
     innerHTML from data, so no value on this page needs escaping. ---- */
  function el(id) { return document.getElementById(id); }
  function make(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt !== undefined && txt !== null) n.textContent = String(txt);
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function table(head, rows, numeric) {
    var t = make('table');
    var thead = make('thead');
    var hr = make('tr');
    for (var i = 0; i < head.length; i++) hr.appendChild(make('th', null, head[i]));
    thead.appendChild(hr);
    t.appendChild(thead);
    var tb = make('tbody');
    for (var r = 0; r < rows.length; r++) {
      var tr = make('tr');
      for (var c = 0; c < rows[r].length; c++) {
        var v = rows[r][c];
        if (v && v.nodeType === 1) { var wrap = make('td'); wrap.appendChild(v); tr.appendChild(wrap); continue; }
        tr.appendChild(make('td', numeric && numeric.indexOf(c) >= 0 ? 'num' : null, v));
      }
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    return t;
  }
  function pairs(obj, order) {
    var keys = order || Object.keys(obj || {});
    var rows = [];
    for (var i = 0; i < keys.length; i++) {
      var v = obj ? obj[keys[i]] : undefined;
      if (v !== null && typeof v === 'object') v = JSON.stringify(v);
      rows.push([keys[i], v === undefined ? '—' : v]);
    }
    return table(['field', 'value'], rows, [1]);
  }
  function ms(v) {
    if (typeof v !== 'number' || v < 0) return '—';
    var s = Math.floor(v / 1000);
    var m = Math.floor(s / 60);
    var h = Math.floor(m / 60);
    if (h > 0) return h + 'h ' + (m % 60) + 'm';
    if (m > 0) return m + 'm ' + (s % 60) + 's';
    return s + 's';
  }
  function bp(v) { return (typeof v === 'number' ? (v / 100).toFixed(v % 100 === 0 ? 0 : 2) : '?') + '%'; }

  /* ---- token + transport ---- */
  function tok() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setTok(v) {
    try { if (v) sessionStorage.setItem(TOKEN_KEY, v); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
    paintAuth();
  }
  function paintAuth() {
    var s = el('auth-state');
    s.textContent = tok() ? 'token held in this tab only' : 'no token in this tab';
    s.className = tok() ? 'ok' : 'muted';
  }
  function paintWho(id) {
    var w = el('who');
    if (!id || !id.account) {
      w.textContent = id && id.via === 'env'
        ? 'admitted by the environment bearer (root) — no account session'
        : 'not signed in';
      w.className = 'muted';
      return;
    }
    w.textContent = 'signed in as ' + id.account.name + ' (' + id.account.role + ')'
      + ' — ' + id.sessions + ' live session(s) on this process';
    w.className = 'ok';
  }
  function paintOwner(id) {
    var host = el('owner-note');
    clear(host);
    var owners = id ? id.owners : 0;
    host.appendChild(make('div', null,
      'THE FIRST ACCOUNT CREATED ON A HOST BECOMES ITS OWNER. This host has '
      + owners + ' owner account(s). Between a deploy and that first signup, anybody who finds '
      + 'this URL can claim it — so if a stranger got here first, take it back with the '
      + 'environment bearer, which is the one credential they never had:'));
    host.appendChild(make('pre', null,
      'curl -X POST ' + location.origin + '/api/admin/owner/transfer \\\\\\n'
      + '  -H "authorization: Bearer $DOOMCRAFT_ADMIN_TOKEN" \\\\\\n'
      + '  -H "content-type: application/json" \\\\\\n'
      + '  -d \\'{"name":"you","actor":"you","reason":"reclaiming after a hostile bootstrap"}\\''));
    host.appendChild(make('div', null,
      'That route takes the ENVIRONMENT BEARER ONLY — never an owner session, because a squatter '
      + 'holding one would just transfer the role back to themselves.'));
    host.appendChild(make('div', null,
      'SESSIONS DO NOT SURVIVE A RESTART. They are a map in this one process, so a deploy signs '
      + 'everybody out and the console asks for a passphrase again. That is by design: there is no '
      + 'database, and a session file on disk is a credential at rest with no expiry anybody can see.'));
  }
  function api(path, method, body) {
    /* TWO credentials, and the request may carry either. credentials:
       'same-origin' sends the httpOnly dc_sess cookie; the bearer is only
       attached when one has been typed into this tab, because a bearer with an
       empty credential is malformed and would be counted as a failed attempt
       against this address. The server tries the env bearer first and the
       session second. */
    var opts = { method: method || 'GET', headers: {}, cache: 'no-store', credentials: 'same-origin' };
    if (tok()) opts.headers.authorization = 'Bearer ' + tok();
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts).then(function (res) {
      return res.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { j = null; }
        return { status: res.status, body: j, text: t };
      });
    });
  }
  function fail(node, r) {
    clear(node);
    var msg = r.status === 404
      ? 'refused (404). Either the token is wrong, or this host has no admin token configured at all — '
        + 'the two answer identically on purpose.'
      : r.status === 429
        ? 'throttled (429). Too many failed attempts from this address; wait a minute.'
        : 'HTTP ' + r.status + ' — ' + (r.body && r.body.error ? r.body.error : r.text.slice(0, 200));
    node.appendChild(make('div', 'warn bad', msg));
  }

  /* ---- header ---- */
  function paintFacts(v) {
    var f = el('facts');
    clear(f);
    function fact(k, val) {
      var d = make('div', 'fact');
      d.appendChild(make('b', null, k + ' '));
      d.appendChild(make('span', null, val));
      f.appendChild(d);
    }
    if (!v) { fact('state', 'not loaded'); return; }
    var ver = v.version || {};
    fact('host', (ver.build && ver.build.host) || '?');
    fact('build', (ver.build && ver.build.id) || '?');
    fact('protocol', (ver.protocol && ver.protocol.version) + ' fp:' + (ver.protocol && ver.protocol.fingerprint));
    fact('content', (ver.content && ver.content.version) + ' hash:' + (ver.content && ver.content.hash));
    fact('uptime', ms(v.uptimeMs));
    var dep = (ver.deploy || {});
    fact('deploy', dep.state || '?');
    fact('forced', 'rooms ' + dep.forcedRooms + ' / players ' + dep.forcedPlayers);
  }

  /* ---- fleet ---- */
  function loadFleet() {
    return api('/api/admin/status').then(function (r) {
      var host = el('fleet-deploy');
      if (r.status !== 200) { fail(host, r); return; }
      var s = r.body;
      clear(host);
      host.appendChild(pairs(s.deploy, ['state', 'admitting', 'rooms', 'humans', 'msUntilDeadline', 'forcedRooms', 'forcedPlayers']));

      var warn = el('drain-warning');
      clear(warn);
      warn.appendChild(make('div', null,
        'DRAIN IS A ONE-WAY DOOR. HostLifecycle goes ADMITTING -> DRAINING -> DRAINED and has no path back; '
        + 'undoing it costs a process restart. It also does not stop the process — /health answers 503 while '
        + 'HTTP keeps serving. There is no drain button on this page on purpose. When you mean it:'));
      warn.appendChild(make('pre', null,
        'curl -X POST ' + location.origin + '/api/admin/drain \\\\\\n'
        + '  -H "authorization: Bearer $DOOMCRAFT_ADMIN_TOKEN" \\\\\\n'
        + '  -H "content-type: application/json" \\\\\\n'
        + '  -d \\'{"actor":"you","reason":"rolling out build …"}\\''));

      var rooms = el('fleet-rooms');
      clear(rooms);
      var rows = [];
      for (var i = 0; i < (s.rooms || []).length; i++) {
        var m = s.rooms[i];
        rows.push([
          m.key + (m.private ? ' (private)' : ''), m.modeKey, m.state,
          m.humans + ' / ' + m.players + ' (+' + m.bots + ' bots)',
          m.monsters, m.wave, m.round, ms(m.timeLeftMs), m.chunks, String(m.worldReady),
        ]);
      }
      if (rows.length === 0) rooms.appendChild(make('div', 'muted', 'no rooms on this host'));
      else rooms.appendChild(table(
        ['key', 'mode', 'state', 'humans/players', 'monsters', 'wave', 'round', 'time left', 'chunks', 'world'],
        rows, [4, 5, 6, 8]));
      rooms.appendChild(make('div', 'muted',
        'A private room shows without its join code: the key IS the code, so it is cut before it leaves the process.'));

      var sig = el('fleet-signal');
      clear(sig);
      sig.appendChild(pairs(s.directory));
      sig.appendChild(pairs(s.signal));
      paintMetrics(s);
    });
  }

  /* ---- metrics: everything already computed, nothing new emitted ---- */
  function paintMetrics(s) {
    el('metrics-note').textContent =
      'Everything here is in-memory and per-process: it resets on restart, and it is this host only. '
      + 'No event is emitted, no player identifier is involved, and nothing leaves this origin — these are '
      + 'counters the server was already keeping and had never served.';
    var f = el('metrics-fleet');
    clear(f); f.appendChild(pairs(s.fleet)); f.appendChild(pairs(s.entitlement));
    var c = el('metrics-conn');
    clear(c);
    var cr = s.connections || {};
    var rows = [];
    var keys = Object.keys(cr);
    for (var i = 0; i < keys.length; i++) {
      var v = cr[keys[i]];
      if (v === null || typeof v !== 'object') continue;
      rows.push([keys[i], v.n, v.total, v.p50, v.p99, v.max]);
    }
    c.appendChild(make('div', 'muted', 'live connections: ' + (cr.connections || 0)));
    c.appendChild(table(['counter', 'n', 'total', 'p50', 'p99', 'max'], rows, [1, 2, 3, 4, 5]));
    c.appendChild(make('div', 'muted',
      'droppedInputs, rejectedEdits and violations are the three that mean something is wrong rather than busy.'));
    var g = el('metrics-signal');
    clear(g); g.appendChild(pairs(s.signal));
    var st = el('metrics-stores');
    clear(st); st.appendChild(pairs(s.journal)); st.appendChild(pairs(s.audit));
  }

  /* ---- flags ---- */
  var flagState = null;

  function loadFlags() {
    return api('/api/admin/flags').then(function (r) {
      var host = el('flags-table');
      if (r.status !== 200) { fail(host, r); return; }
      flagState = r.body;
      el('flags-head').textContent =
        'revision ' + flagState.revision + ' · ' + (flagState.frozen ? 'FROZEN' : 'not frozen')
        + ' · host ' + flagState.host;
      var w = el('flags-warning');
      clear(w);
      w.appendChild(make('div', null,
        'EVERY FLAG WRITE HITS ONE PROCESS. FlagService holds this document in memory and reads '
        + 'DOOMCRAFT_FLAGS at boot: this write changes this host, no other host in the fleet, and it is gone '
        + 'when this process restarts. The header names the host you are editing.'));
      w.appendChild(make('div', null,
        'A product gate is not a kill switch. A row marked "maskable" drives a client Feature a player can '
        + 'override in their own Settings — turning the flag ON may still show them nothing. Turning it OFF '
        + 'always wins, because the surfaces require both.'));

      var ft = el('freeze-toggle');
      ft.textContent = flagState.frozen ? 'UNFREEZE ROLLOUTS' : 'FREEZE ALL ROLLOUTS';
      ft.className = flagState.frozen ? 'go' : 'danger';
      el('freeze-note').textContent = flagState.frozen
        ? 'Every partial rollout is resolving to its registry default right now.'
        : 'Freezes every PARTIAL rollout to its registry default. Finished rollouts and explicit force values are untouched.';

      clear(host);
      var rows = [];
      for (var i = 0; i < flagState.registry.length; i++) rows.push(flagRow(flagState.registry[i]));
      host.appendChild(table(
        ['flag', 'bit', 'kind', 'default', 'force', 'rollout', 'reach', 'client gate', 'blast radius'],
        rows, [1]));
    });
  }

  function flagRow(f) {
    var name = make('div');
    name.appendChild(make('div', null, f.key));
    name.appendChild(make('div', 'muted', f.what));

    var force = make('div', 'rowline');
    force.appendChild(forceBtn(f, true, 'ON'));
    force.appendChild(forceBtn(f, false, 'OFF'));
    force.appendChild(forceBtn(f, null, 'defer'));

    var roll = make('div', 'rowline');
    for (var i = 0; i < LADDER.length; i++) roll.appendChild(ladderBtn(f, LADDER[i]));
    if (!f.onLadder) roll.appendChild(make('span', 'err', 'now at ' + f.rolloutBp + ' bp — off the ladder'));

    var gate = make('div');
    gate.appendChild(make('span', f.maskable ? 'pill no' : 'pill', f.clientFeature || 'no client feature'));
    if (f.maskable) gate.appendChild(make('div', 'muted', 'maskable by the player'));

    return [
      name, f.bit, f.kind, String(f.defaultOn),
      force, roll, bp(f.reachBp), gate,
      make('div', 'blast', f.blastRadius),
    ];
  }

  function forceBtn(f, value, label) {
    var b = make('button', f.force === value ? 'on' : null, label);
    b.addEventListener('click', function () {
      var rules = {};
      rules[f.key] = { force: value };
      arm('flags.set', f.key, { expectRevision: flagState.revision, rules: rules });
    });
    return b;
  }

  function ladderBtn(f, value) {
    var b = make('button', f.rolloutBp === value ? 'on' : null, bp(value));
    b.addEventListener('click', function () {
      var rules = {};
      rules[f.key] = { rolloutBp: value };
      arm('flags.set', f.key, { expectRevision: flagState.revision, rules: rules });
    });
    return b;
  }

  /* ---- the two-phase confirm ---- */
  var armed = null;
  var countdown = 0;
  var ticker = 0;

  function arm(verb, subject, patch) {
    api('/api/admin/flags/plan', 'POST', patch).then(function (r) {
      var diff = el('c-diff');
      var warns = el('c-warnings');
      clear(diff); clear(warns);
      if (r.status !== 200) { fail(warns, r); el('confirm').showModal(); return; }
      var plan = r.body;
      armed = { verb: verb, subject: plan.subject || subject, patch: patch, plan: plan };

      el('c-title').textContent = verb + ' — ' + armed.subject;
      var rows = [];
      for (var i = 0; i < plan.diff.length; i++) {
        var d = plan.diff[i];
        rows.push([d.key || '(document)', d.field, d.before, d.after,
          (d.exposureDeltaBp > 0 ? '+' : '') + bp(d.exposureDeltaBp)]);
      }
      if (rows.length === 0) diff.appendChild(make('div', 'muted', 'this write changes nothing'));
      else diff.appendChild(table(['flag', 'field', 'before', 'after', 'reach'], rows, [4]));
      diff.appendChild(make('div', 'muted', 'risk: ' + plan.risk
        + (plan.delayMs > 0
          ? ' — this write reaches MORE players, so it waits ' + Math.round(plan.delayMs / 1000) + 's before it can fire'
          : ' — this write reaches fewer players or none more, so there is no delay on it')));

      for (var w = 0; w < plan.warnings.length; w++) {
        warns.appendChild(make('div', 'warn', plan.warnings[w]));
      }
      if (plan.offLadder && plan.offLadder.length > 0) {
        warns.appendChild(make('div', 'warn bad',
          'This rollout is not on the ' + LADDER.join(' / ') + ' ladder. The server refuses it unless the '
          + 'request says so explicitly, and this page will send that flag with your reason attached.'));
      }

      el('c-subject').value = '';
      el('c-subject-want').textContent = 'exactly: ' + armed.subject;
      el('c-reason').value = '';
      el('c-state').textContent = '';
      el('c-state').className = 'muted';
      countdown = Math.ceil((plan.delayMs || 0) / 1000);
      if (ticker) clearInterval(ticker);
      ticker = setInterval(tick, 250);
      tick();
      el('confirm').showModal();
    });
  }

  function tick() {
    if (!armed) return;
    var subjOk = el('c-subject').value.trim() === armed.subject;
    var actorOk = el('c-actor').value.trim().length >= MIN_ACTOR;
    var reasonOk = el('c-reason').value.trim().length >= MIN_REASON;
    var go = el('c-go');
    if (countdown > 0) {
      go.disabled = true;
      go.textContent = 'confirm in ' + countdown + 's';
      countdown -= 0.25;
      if (countdown < 0) countdown = 0;
      return;
    }
    go.textContent = 'confirm';
    go.disabled = !(subjOk && actorOk && reasonOk);
  }

  function fire() {
    if (!armed) return;
    var body = {};
    for (var k in armed.patch) if (Object.prototype.hasOwnProperty.call(armed.patch, k)) body[k] = armed.patch[k];
    body.actor = el('c-actor').value.trim();
    body.reason = el('c-reason').value.trim();
    if (armed.plan.offLadder && armed.plan.offLadder.length > 0) body.allowCustomRollout = true;
    var state = el('c-state');
    state.textContent = 'writing…';
    state.className = 'muted';
    api('/api/admin/flags', 'POST', body).then(function (r) {
      if (r.status === 200) {
        state.textContent = 'applied — revision ' + r.body.revision + ', audit row ' + r.body.action;
        state.className = 'ok';
        loadFlags();
        loadAudit();
        setTimeout(function () { el('confirm').close(); }, 900);
        return;
      }
      state.textContent = 'refused: HTTP ' + r.status + ' — ' + (r.body && r.body.error ? r.body.error : r.text.slice(0, 200));
      state.className = 'err';
      if (r.status === 409) loadFlags();
    });
  }

  /* ---- refusals ---- */
  function loadRefusals() {
    return api('/api/admin/entitlement').then(function (r) {
      var s = el('guard-status');
      if (r.status !== 200) { fail(s, r); return; }
      clear(s);
      s.appendChild(pairs(r.body.status));
      s.appendChild(pairs(r.body.auth));
      var ring = el('guard-ring');
      clear(ring);
      var rows = [];
      for (var i = 0; i < (r.body.recent || []).length; i++) {
        var e = r.body.recent[i];
        rows.push([new Date(e.ms).toISOString(), e.device, e.code, e.reason, e.trust, (e.stripped || []).join(' ')]);
      }
      if (rows.length === 0) ring.appendChild(make('div', 'muted', 'nothing refused since this process started'));
      else ring.appendChild(table(['when', 'player', 'code', 'reason', 'trust', 'stripped'], rows, [2]));
    });
  }

  /* ---- player ---- */
  function loadPlayer() {
    var key = el('player-key').value.trim();
    var body = el('player-body');
    if (key.length === 0) { clear(body); el('player-state').textContent = 'type a device id'; return Promise.resolve(); }
    el('player-state').textContent = 'looking up…';
    return api('/api/admin/player?key=' + encodeURIComponent(key)).then(function (r) {
      clear(body);
      if (r.status !== 200) { el('player-state').textContent = ''; fail(body, r); return; }
      var p = r.body;
      el('player-state').textContent = p.onThisHost ? 'found on this host' : 'no profile on this host';
      body.appendChild(make('h2', null, 'profile — ' + p.key));
      if (!p.onThisHost) {
        body.appendChild(make('div', 'warn',
          'No profile for that id on this host. On a fleet that is normal: rows and balances can live on '
          + 'different boxes until there is one shared store. This host cannot tell "never existed" from '
          + '"lives elsewhere", and does not pretend to.'));
      } else {
        body.appendChild(pairs(p.profile.progress));
        body.appendChild(make('h2', null, 'economy'));
        body.appendChild(pairs(p.profile.economy));
      }
      body.appendChild(make('h2', null, 'reconciliation'));
      var rc = p.reconcile;
      body.appendChild(table(['currency', 'stored balance', 'sum of journal rows', 'agrees'], [
        ['xp', rc.xp.stored, rc.xp.journal, verdict(rc.xp)],
        ['scrap', rc.scrap.stored, rc.scrap.journal, verdict(rc.scrap)],
      ], [1, 2]));
      body.appendChild(make('div', 'muted',
        'Rows are retained from ' + (rc.fromDay || '—') + '. Before that day the sum is a lower bound, not a '
        + 'balance — do not read a mismatch as evidence on its own if the account is older than the window.'));
      body.appendChild(make('h2', null, 'ledger'));
      var rows = [];
      for (var i = 0; i < (p.rows || []).length; i++) {
        var e = p.rows[i];
        rows.push([new Date(e.ms).toISOString(), e.kind, e.currency, e.delta, e.balanceAfter, e.sourceId, e.reason]);
      }
      if (rows.length === 0) body.appendChild(make('div', 'muted', 'no ledger rows in the retained window'));
      else body.appendChild(table(['when', 'kind', 'currency', 'delta', 'balance after', 'source', 'reason'], rows, [3, 4]));
      paintMissing(p.missing);
    });
  }
  function verdict(c) {
    if (c.stored === null) return 'no profile here';
    return c.stored === c.journal ? 'yes' : 'NO — investigate';
  }
  function paintMissing(list) {
    var host = el('player-missing');
    clear(host);
    var rows = [];
    for (var i = 0; i < (list || []).length; i++) rows.push([list[i].verb, list[i].why, list[i].when]);
    host.appendChild(table(['not possible', 'why', 'built in'], rows));
  }

  /* ---- audit ---- */
  function loadAudit() {
    return api('/api/admin/audit?limit=200').then(function (r) {
      var host = el('audit-body');
      if (r.status !== 200) { fail(host, r); return; }
      clear(host);
      var rows = [];
      for (var i = 0; i < (r.body.rows || []).length; i++) {
        var a = r.body.rows[i];
        rows.push([new Date(a.ms).toISOString(), a.actor, a.verb, a.subject, a.outcome, a.reason, a.before, a.after]);
      }
      if (rows.length === 0) host.appendChild(make('div', 'muted', 'no admin action has been recorded on this host'));
      else host.appendChild(table(['when', 'actor', 'verb', 'subject', 'outcome', 'reason', 'before', 'after'], rows));
      host.appendChild(pairs(r.body.status));
    });
  }

  /* ---- shell ---- */
  function show(name) {
    for (var i = 0; i < TABS.length; i++) {
      el('tab-' + TABS[i]).className = TABS[i] === name ? 'live' : '';
      el('btn-' + TABS[i]).className = TABS[i] === name ? 'on' : '';
    }
    if (name === 'flags') loadFlags();
    else if (name === 'refusals') loadRefusals();
    else if (name === 'audit') loadAudit();
    else loadFleet();
  }

  function refresh() {
    api('/api/admin/whoami').then(function (r) {
      if (r.status !== 200) { paintFacts(null); paintWho(null); paintOwner(null); fail(el('fleet-deploy'), r); return; }
      paintFacts(r.body);
      paintWho(r.body.identity);
      paintOwner(r.body.identity);
      paintMissing(r.body.capabilities.missing);
      loadFleet();
    });
  }

  var nav = el('tabs');
  for (var i = 0; i < TABS.length; i++) {
    (function (name) {
      var b = make('button', null, name);
      b.id = 'btn-' + name;
      b.addEventListener('click', function () { show(name); });
      nav.appendChild(b);
    })(TABS[i]);
  }

  el('save-token').addEventListener('click', function () { setTok(el('token').value.trim()); el('token').value = ''; refresh(); });
  el('forget-token').addEventListener('click', function () { setTok(''); location.reload(); });
  el('refresh').addEventListener('click', refresh);
  el('signout').addEventListener('click', function () {
    api('/api/auth/signout', 'POST', {}).then(function () { setTok(''); location.reload(); });
  });
  el('player-go').addEventListener('click', function () { loadPlayer(); });
  el('player-key').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadPlayer(); });
  el('c-cancel').addEventListener('click', function () { armed = null; el('confirm').close(); });
  el('c-go').addEventListener('click', fire);
  el('confirm').addEventListener('close', function () { if (ticker) { clearInterval(ticker); ticker = 0; } });
  el('freeze-toggle').addEventListener('click', function () {
    if (!flagState) return;
    arm(flagState.frozen ? 'flags.unfreeze' : 'flags.freeze', 'revision ' + flagState.revision,
      { expectRevision: flagState.revision, frozen: !flagState.frozen });
  });

  paintAuth();
  show('fleet');
  /* Always. This document is only served to a caller the gate already admitted
     — the env bearer or an owner session — so there is a credential by
     construction, and waiting for a typed token would leave a signed-in owner
     staring at an empty page. */
  refresh();
})();
</script>
</body>
</html>`;

/* ------------------------------------------------------------------------ *
 * The sign-in page
 * ------------------------------------------------------------------------ */

/**
 * What `GET /admin` renders when the caller has no credential.
 *
 * Two states, and the server picks — not the page:
 *
 *   - `bootstrap: true` — `accounts.ownerCount() === 0`. THIS HOST HAS NO
 *     OWNER, and the form creates one. The copy says so in those words, because
 *     an operator who does not understand that the first signup wins is an
 *     operator who leaves the window open.
 *   - `bootstrap: false` — sign in.
 *
 * Deciding it on the server rather than in the page is the point: the page
 * cannot ask "how many owners are there" without a route that answers it, and a
 * route that answers it is a route that tells an anonymous prober whether this
 * host is still claimable. One document, chosen by a caller that already knows.
 */
export interface SignInView {
  /** True when this host has no owner account yet. */
  readonly bootstrap: boolean;
}

/**
 * The document. A function rather than a constant because of `SignInView`, and
 * the SAME rule applies to it as to `ADMIN_CONSOLE_HTML`: `tsc` does not see
 * inside the literal and `vitest` does not execute it, so nothing that can be
 * WRONG may live in here. Every interpolated value below is either a constant
 * imported from a tested module (`NAME_MIN`, `PASSPHRASE_MIN`) or one of two
 * literal strings chosen by the `if` above — never a request value, so there is
 * no escaping to get right.
 */
export function adminSignInHtml(view: SignInView): string {
  const headline = view.bootstrap ? 'Create the owner account' : 'Sign in';
  const lead = view.bootstrap
    ? 'This host has no owner yet, and the first account created becomes the owner. '
      + 'Do it now: until you do, anybody who finds this URL can.'
    : 'This console is for the owner account. Sign in with the name and passphrase you created.';
  const action = view.bootstrap ? 'create the owner account' : 'sign in';
  const mode = view.bootstrap ? 'bootstrap' : 'signin';
  const passHint = view.bootstrap
    ? `at least ${PASSPHRASE_MIN} characters — write it down, there is no reset`
    : 'your passphrase';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:,">
<title>doomcraft — operator sign-in</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #0b0d10; color: #d7dde5;
    font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  main { max-width: 72ch; margin: 0 auto; padding: 40px 16px; }
  h1 { font-size: 14px; margin: 0 0 6px; letter-spacing: .12em; text-transform: uppercase; color: #9fb0c4; }
  h2 { font-size: 13px; margin: 22px 0 6px; color: #eef3f8; }
  p { color: #8ea3ba; max-width: 66ch; }
  label { display: block; margin: 12px 0 4px; color: #8ea3ba; }
  input { font: inherit; background: #0f141a; color: #eef3f8; border: 1px solid #2e3844; padding: 6px 8px; border-radius: 3px; width: 32ch; max-width: 100%; }
  button { font: inherit; background: #1b2129; color: #d7dde5; border: 1px solid #2e3844; padding: 6px 12px; cursor: pointer; border-radius: 3px; margin-top: 14px; }
  button:hover:enabled { background: #232c37; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  code, pre { background: #0f141a; border: 1px solid #1d242c; border-radius: 3px; }
  code { padding: 1px 5px; }
  pre { padding: 8px 10px; overflow-x: auto; }
  .muted { color: #6d7d8f; }
  .err { color: #ffbcbc; }
  .warn { border-left: 3px solid #7a5a20; background: #1a1710; color: #e8d5a8; padding: 8px 10px; margin: 16px 0; }
</style>
</head>
<body>
<main>
  <h1>doomcraft — operator console</h1>
  <h2>${headline}</h2>
  <p>${lead}</p>
  <label for="su-name">name</label>
  <input id="su-name" autocomplete="username" spellcheck="false" placeholder="${NAME_MIN}-${NAME_MAX} of a-z 0-9 _ -">
  <label for="su-pass">passphrase</label>
  <input id="su-pass" type="password" autocomplete="current-password" spellcheck="false" placeholder="${passHint}">
  <div><button id="su-go">${action}</button></div>
  <p id="su-state" class="muted">nothing sent yet</p>
  <div class="warn">
    <div>Sessions do not survive a restart. They live in this one process, so a deploy signs everybody
    out and this page comes back. There is no database and no session file: a session on disk is a
    credential at rest with no expiry anybody can see.</div>
  </div>
  <p class="muted">Locked out, or somebody else claimed the owner role first? The environment bearer
  <code>DOOMCRAFT_ADMIN_TOKEN</code> is still root and can re-assign it — that route takes the bearer
  and nothing else, not even an owner session:</p>
  <pre>curl -X POST /api/admin/owner/transfer \\
  -H "authorization: Bearer $DOOMCRAFT_ADMIN_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"name":"you","actor":"you","reason":"reclaiming the owner role"}'</pre>
</main>
<script>
(function () {
  'use strict';

  /* Chosen by the SERVER — see adminSignInHtml. The page never asks how many
     owners this host has, because a route that answered would tell an
     anonymous prober whether the host is still claimable. */
  var MODE = '${mode}';
  var ROUTE = MODE === 'bootstrap' ? '/api/auth/signup' : '/api/auth/signin';

  function el(id) { return document.getElementById(id); }
  function say(msg, bad) {
    var s = el('su-state');
    s.textContent = msg;
    s.className = bad ? 'err' : 'muted';
  }

  function submit() {
    var name = el('su-name').value.trim();
    var pass = el('su-pass').value;
    if (name.length === 0 || pass.length === 0) { say('name and passphrase, both', true); return; }
    el('su-go').disabled = true;
    say('working…', false);
    /* fetch, and never a submitted element: the Node CSP is form-action
       'none', and a submit is a navigation. Same rule as the console. */
    fetch(ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      body: JSON.stringify({ name: name, passphrase: pass })
    }).then(function (res) {
      return res.text().then(function (t) {
        var j = null;
        try { j = JSON.parse(t); } catch (e) { j = null; }
        return { status: res.status, body: j };
      });
    }).then(function (r) {
      el('su-go').disabled = false;
      if (r.status === 200 || r.status === 201) {
        el('su-pass').value = '';
        /* The session arrived as an httpOnly cookie this script cannot read,
           which is the point: there is nothing here to store and nothing to
           leak. Reload, and the server decides what this caller may see. */
        location.reload();
        return;
      }
      if (r.status === 429) { say('too many attempts from this address — wait a minute', true); return; }
      say(r.body && r.body.error ? r.body.error : 'HTTP ' + r.status, true);
    }).catch(function () {
      el('su-go').disabled = false;
      say('the request did not complete', true);
    });
  }

  el('su-go').addEventListener('click', submit);
  el('su-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  el('su-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') el('su-pass').focus(); });
})();
</script>
</body>
</html>`;
}
