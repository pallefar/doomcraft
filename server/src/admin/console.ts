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
 * in, kept in `sessionStorage` (which dies with the tab, unlike the other Web
 * Storage area), never in the URL and never in a query string. Every
 * `/api/admin/*` call it makes is gated by `AdminGate`; this route is not,
 * because there is nothing here to gate.
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
 *    is no escaping to get right and no injection path to miss. The nav icons
 *    are built with `createElementNS`, under the same rule.
 * 2. **`fetch`, never a `<form>`.** The Node CSP is `form-action 'none'`
 *    (`server/src/index.ts`), so a form would not submit; more to the point, a
 *    form is a navigation and this page must never navigate away from a
 *    half-armed confirm.
 *
 * ## The chrome
 *
 * A fixed left sidebar groups the six panels the way an operator reaches for
 * them — Live (fleet, players), Releases (flags), Audit (refusals, actions),
 * Analytics (metrics) — and a top bar carries the host/build facts, who is
 * signed in, and the refresh control. On a phone the sidebar slides in from a
 * hamburger. The Doomcraft vocabulary (ground `#131010`, panel `#1E1917`, bone
 * `#DED4C4`, hell `#E0431C`) is applied with **local-first font stacks only**:
 * the CSP is `style-src 'self' 'nonce-…'; font-src 'self'`, so the Google
 * Fonts stylesheet cannot load here and this page does not try — the families
 * ("Big Shoulders Display", Barlow, "IBM Plex Mono") are named first in each
 * stack and a system face carries the design when they are not installed.
 * Nothing on this page loads off-origin, and the console test enforces that.
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
  :root {
    color-scheme: dark;
    --ground: #131010;
    --panel: #1E1917;
    --sunk: #0C0A09;
    --rule: #463731;
    --rule-soft: #2E2622;
    --bone: #DED4C4;
    --hell: #E0431C;
    --amber: #E5A02E;
    --tox: #86C232;
    --faded: #A29584;
    --dim: #7C7061;
    --font-display: "Big Shoulders Display", "Arial Narrow", "Avenir Next Condensed", "Helvetica Neue", system-ui, sans-serif;
    --font-body: "Barlow", "Helvetica Neue", Arial, system-ui, sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--ground); color: var(--bone); font: 14px/1.5 var(--font-body); }
  a { color: var(--amber); }
  h1 { margin: 0; }
  :focus-visible { outline: 2px solid var(--amber); outline-offset: 1px; }

  /* ---- frame: sidebar + content column ---- */
  .shell { display: flex; min-height: 100vh; }
  .sidebar {
    width: 230px; flex: none; background: var(--sunk);
    border-right: 1px solid var(--rule);
    position: sticky; top: 0; height: 100vh; overflow-y: auto;
    display: flex; flex-direction: column;
  }
  .brand { padding: 16px 16px 12px; border-bottom: 1px solid var(--rule-soft); }
  .wordmark {
    font-family: var(--font-display); font-weight: 700; font-size: 26px; line-height: 1;
    letter-spacing: .05em; text-transform: uppercase; color: var(--hell);
  }
  .brand-sub {
    font-family: var(--font-display); font-size: 11px; letter-spacing: .32em;
    text-transform: uppercase; color: var(--dim); margin-top: 4px;
  }
  nav { flex: 1; padding: 8px 10px 16px; }
  .nav-label {
    font-family: var(--font-display); font-size: 11px; letter-spacing: .26em;
    text-transform: uppercase; color: var(--dim); padding: 14px 10px 4px;
  }
  .nav-item {
    display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
    background: none; border: 0; border-left: 2px solid transparent; border-radius: 0 3px 3px 0;
    color: var(--faded); font: 500 14px/1 var(--font-body);
    padding: 9px 10px; cursor: pointer;
  }
  .nav-item:hover { background: var(--panel); color: var(--bone); }
  .nav-item.on { background: var(--panel); border-left-color: var(--hell); color: var(--bone); }
  .ico { width: 16px; height: 16px; flex: none; color: var(--dim); }
  .nav-item.on .ico { color: var(--hell); }
  .side-sec { border-top: 1px solid var(--rule-soft); padding: 4px 16px 16px; }
  .bearer { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
  .bearer input { width: 100%; }

  .content { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .topbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    background: var(--panel); border-bottom: 1px solid var(--rule);
    padding: 8px 16px; min-height: 48px;
  }
  .tb-brand {
    display: none; font-family: var(--font-display); font-weight: 700; font-size: 18px;
    letter-spacing: .05em; text-transform: uppercase; color: var(--hell);
  }
  .facts { display: flex; gap: 6px; overflow-x: auto; flex: 1 1 200px; min-width: 0; }
  .fact {
    flex: none; display: flex; gap: 6px; align-items: baseline;
    background: var(--sunk); border: 1px solid var(--rule-soft); border-radius: 3px;
    padding: 2px 8px; font-family: var(--font-mono); font-size: 11px; white-space: nowrap;
  }
  .fact b { color: var(--dim); font-weight: 400; }
  .fact span { color: var(--bone); }
  .tb-right { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  #who { max-width: 44ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #freshness { font-family: var(--font-mono); font-size: 11px; }

  main { padding: 18px 20px 40px; max-width: 1240px; width: 100%; }
  section { display: none; }
  section.live { display: block; }
  .page-title {
    font-family: var(--font-display); font-weight: 700; font-size: 26px; line-height: 1.1;
    letter-spacing: .06em; text-transform: uppercase; color: var(--bone);
    margin: 2px 0 14px;
  }

  /* ---- cards ---- */
  .card { background: var(--panel); border: 1px solid var(--rule); border-radius: 5px; margin: 0 0 14px; }
  .card-head {
    font-family: var(--font-display); font-weight: 700; font-size: 13px; letter-spacing: .2em;
    text-transform: uppercase; color: var(--amber);
    padding: 9px 14px; border-bottom: 1px solid var(--rule-soft);
  }
  .card-body { padding: 12px 14px; }
  #player-body { padding: 12px 14px; }
  #player-body:empty { display: none; }
  h2 {
    font-family: var(--font-display); font-weight: 700; font-size: 13px; letter-spacing: .18em;
    text-transform: uppercase; color: var(--amber); margin: 16px 0 6px;
  }
  h2:first-child { margin-top: 0; }
  .tscroll { overflow-x: auto; }

  /* ---- tables: ruled + zebra, monospace figures ---- */
  table { border-collapse: collapse; width: 100%; margin: 0 0 8px; font-family: var(--font-mono); font-size: 12px; }
  th {
    text-align: left; font-family: var(--font-body); font-weight: 600; font-size: 11px;
    letter-spacing: .08em; text-transform: uppercase; color: var(--dim);
    padding: 6px 10px; border-bottom: 1px solid var(--rule); white-space: nowrap;
  }
  td { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--rule-soft); vertical-align: top; }
  tbody tr:nth-child(even) { background: rgba(222, 212, 196, .03); }
  tbody tr:hover { background: rgba(224, 67, 28, .07); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td button { padding: 3px 9px; font-size: 12px; }

  /* ---- controls ---- */
  button {
    font: 500 13px/1.3 var(--font-body); background: #2A2320; color: var(--bone);
    border: 1px solid var(--rule); padding: 6px 12px; cursor: pointer; border-radius: 3px;
  }
  button:hover:enabled { border-color: var(--amber); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.on { background: #3A1D14; border-color: var(--hell); color: #F2BFA9; }
  button.danger { border-color: #8A3B27; color: #F0A088; }
  button.go { border-color: #4E7030; color: #B3DE8B; }
  .iconbtn { display: none; align-items: center; justify-content: center; padding: 6px 8px; background: none; }
  .iconbtn .ico { width: 18px; height: 18px; color: var(--bone); }
  input, textarea {
    font: 13px/1.4 var(--font-mono); background: var(--sunk); color: var(--bone);
    border: 1px solid var(--rule); padding: 6px 8px; border-radius: 3px;
  }
  input { width: 24ch; max-width: 100%; }
  textarea { width: 100%; max-width: 80ch; height: 4.6em; }
  label { color: var(--faded); }

  /* ---- prose, states, chips ---- */
  .note { color: var(--faded); margin: 6px 0 12px; max-width: 84ch; }
  .note.mono { font-family: var(--font-mono); font-size: 12px; }
  .note:empty, .warn:empty { display: none; }
  .warn {
    border-left: 3px solid var(--amber); background: #201810; color: #E7CB93;
    padding: 10px 12px; margin: 10px 0; max-width: 100ch; border-radius: 0 3px 3px 0;
  }
  .warn.bad { border-left-color: var(--hell); background: #221110; color: #F0B2A2; }
  .warn > div + div { margin-top: 6px; }
  .blast { color: #E7CB93; }
  .muted { color: var(--dim); }
  .empty {
    border: 1px dashed var(--rule); border-radius: 4px; color: var(--dim);
    padding: 16px; text-align: center; margin: 4px 0 8px;
  }
  .pill { display: inline-block; padding: 0 8px; border: 1px solid var(--rule); border-radius: 10px; color: var(--faded); font-size: 12px; }
  .pill.yes { border-color: #4E7030; color: #B3DE8B; }
  .pill.no { border-color: #8A3B27; color: #F0A088; }
  .err { color: #F0A088; }
  .ok { color: #B3DE8B; }
  code, pre { font-family: var(--font-mono); background: var(--sunk); border: 1px solid var(--rule-soft); border-radius: 3px; }
  code { padding: 1px 5px; }
  pre { padding: 10px 12px; overflow-x: auto; max-width: 100ch; font-size: 12px; }
  .rowline { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 6px 0; }
  .stack { display: block; margin: 6px 0; }

  /* ---- the confirm dialog ---- */
  dialog {
    background: var(--panel); color: var(--bone); border: 1px solid var(--rule);
    border-radius: 6px; max-width: 90ch; width: calc(100vw - 40px); padding: 16px;
  }
  dialog::backdrop { background: rgba(5, 3, 2, .78); }
  dialog h2 { color: var(--hell); }

  /* ---- phone: the sidebar becomes a drawer behind the hamburger ---- */
  #scrim { display: none; }
  @media (max-width: 900px) {
    .sidebar {
      position: fixed; z-index: 40; top: 0; bottom: 0; left: 0; height: 100%;
      transform: translateX(-104%); transition: transform .16s ease-out;
      box-shadow: 4px 0 24px rgba(0, 0, 0, .5);
    }
    body.nav-open .sidebar { transform: none; }
    #scrim { position: fixed; inset: 0; background: rgba(5, 3, 2, .6); z-index: 30; }
    body.nav-open #scrim { display: block; }
    .iconbtn { display: inline-flex; }
    .tb-brand { display: block; }
    main { padding: 12px 12px 32px; }
    #who { max-width: 22ch; }
    .rowline input { flex: 1 1 12ch; }
  }
</style>
</head>
<body>
<div id="scrim"></div>
<div class="shell">
  <aside class="sidebar">
    <div class="brand">
      <h1 class="wordmark">Doomcraft</h1>
      <div class="brand-sub">operator console</div>
    </div>
    <nav id="tabs"></nav>
    <div class="side-sec">
      <div class="nav-label">environment bearer</div>
      <div class="bearer">
        <input id="token" type="password" autocomplete="off" spellcheck="false" aria-label="bearer token" placeholder="DOOMCRAFT_ADMIN_TOKEN">
        <div class="rowline">
          <button id="save-token">use</button>
          <button id="forget-token">forget</button>
        </div>
        <div id="auth-state" class="muted">no token in this tab</div>
      </div>
    </div>
  </aside>
  <div class="content">
    <header class="topbar">
      <button id="menu-toggle" class="iconbtn" aria-label="toggle navigation">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
      <span class="tb-brand">Doomcraft</span>
      <div class="facts" id="facts"></div>
      <div class="tb-right">
        <span id="freshness" class="muted">not synced yet</span>
        <button id="refresh">refresh</button>
        <span id="who" class="muted">not signed in</span>
        <button id="signout">sign out</button>
      </div>
    </header>
    <main>
      <section id="tab-fleet">
        <div class="page-title">Fleet</div>
        <div class="card">
          <div class="card-head">who owns this host</div>
          <div class="card-body">
            <div class="warn" id="owner-note"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-head">this host</div>
          <div class="card-body">
            <div class="tscroll" id="fleet-deploy"></div>
            <div class="warn" id="drain-warning"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-head">rooms</div>
          <div class="card-body tscroll" id="fleet-rooms"></div>
        </div>
        <div class="card">
          <div class="card-head">directory &amp; signalling</div>
          <div class="card-body tscroll" id="fleet-signal"></div>
        </div>
      </section>

      <section id="tab-studio">
        <div class="page-title">Studio</div>
        <div class="note">
          The Creator Studio (docs/STUDIO.md): author DATA content here — it lands as a NEW pack
          version on the volume and still walks draft &rarr; gate &rarr; approve &rarr; promote on the
          Review screen. Build-class designs (weapons, characters) save as <em>drafts</em> for the
          platform lane: hand one to a Claude Code session and it ships as a commit.
        </div>
        <div class="warn" id="studio-warning"></div>
        <div class="card">
          <div class="card-head">items editor — skins, emblems, trails, titles, trophies</div>
          <div class="card-body">
            <div class="stack">
              <textarea id="studio-items" spellcheck="false" rows="12"></textarea>
            </div>
            <div class="rowline">
              <button id="studio-items-save" class="go">save as next items version</button>
              <span class="muted" id="studio-items-state"></span>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-head">level lab — quest maps, validated by the real solver</div>
          <div class="card-body">
            <div class="stack">
              <textarea id="studio-level" spellcheck="false" rows="12"
                placeholder='paste a level source JSON ("doomcraft-level-source/1") here'></textarea>
            </div>
            <div class="rowline">
              <button id="studio-level-check">validate</button>
              <button id="studio-level-save" class="go">save as next levels version</button>
              <span class="muted" id="studio-level-state"></span>
            </div>
            <div class="tscroll mono" id="studio-level-report"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-head">campaign — the order levels are played in</div>
          <div class="card-body">
            <div class="stack">
              <textarea id="studio-campaign" spellcheck="false" rows="8"></textarea>
            </div>
            <div class="rowline">
              <button id="studio-campaign-save" class="go">save as next campaign version</button>
              <span class="muted" id="studio-campaign-state"></span>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-head">designers — weapons &amp; characters (drafts for the platform lane)</div>
          <div class="card-body">
            <div class="note">
              These are BUILD-class: the client predicts from its compiled tables, so a change here
              is a code change. Saving writes a structured draft under <code>DOOMCRAFT_DATA/studio/</code>
              beside the current compiled values — the change request a Claude Code session applies.
            </div>
            <div class="stack">
              <textarea id="studio-draft" spellcheck="false" rows="6"
                placeholder='{"pistol": {"damage": 18, "note": "slug sidegrade"}}'></textarea>
            </div>
            <div class="rowline">
              <button id="studio-draft-weapons">save weapons draft</button>
              <button id="studio-draft-characters">save characters draft</button>
              <span class="muted" id="studio-draft-state"></span>
            </div>
            <div class="tscroll mono" id="studio-drafts-list"></div>
          </div>
        </div>
      </section>

      <section id="tab-flags">
        <div class="page-title">Flags</div>
        <div class="note mono" id="flags-head"></div>
        <div class="warn" id="flags-warning"></div>
        <div class="card">
          <div class="card-head">rollout freeze</div>
          <div class="card-body">
            <div class="rowline">
              <button id="freeze-toggle"></button>
              <span class="muted" id="freeze-note"></span>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-head">registry</div>
          <div class="card-body tscroll" id="flags-table"></div>
        </div>
      </section>

      <section id="tab-packs">
        <div class="page-title">Inventory</div>
        <div class="note">
          What is INSTALLED on this host, per pack, per version. Installing bytes is a deploy or a
          volume write — this console decides which installed version is <em>live</em>, never uploads
          one. A version with a refused member cannot pass the gate, and its row says why here first.
        </div>
        <div class="card">
          <div class="card-head">build packs — compiled into this binary</div>
          <div class="card-body tscroll" id="inv-build"></div>
        </div>
        <div class="card">
          <div class="card-head">levels — data, versioned on disk</div>
          <div class="card-body tscroll" id="inv-levels"></div>
        </div>
        <div class="card">
          <div class="card-head">campaign — data, versioned on disk</div>
          <div class="card-body tscroll" id="inv-campaign"></div>
        </div>
      </section>

      <section id="tab-review">
        <div class="page-title">Review</div>
        <div class="note mono" id="rel-head"></div>
        <div class="warn" id="rel-warning"></div>
        <div class="card">
          <div class="card-head">the machine</div>
          <div class="card-body">
            <div class="rowline" id="rel-actions"></div>
            <div class="rowline" id="rel-note-row" hidden>
              <label for="rel-note" class="muted">release note</label>
              <input id="rel-note" autocomplete="off" spellcheck="false"
                placeholder="one sentence saying why — required to approve">
            </div>
            <div class="muted" id="rel-actions-note"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-head">draft under review</div>
          <div class="card-body tscroll" id="rel-draft"></div>
        </div>
        <div class="card">
          <div class="card-head">gate verdict — failures first, details verbatim</div>
          <div class="card-body tscroll" id="rel-gate"></div>
        </div>
        <div class="card">
          <div class="card-head">what this draft changes</div>
          <div class="card-body tscroll" id="rel-diff"></div>
        </div>
      </section>

      <section id="tab-rhistory">
        <div class="page-title">History</div>
        <div class="note">
          The release document, newest first. Rollback appears only on the row the server would
          accept it for; everywhere else the button is replaced by the reason it is not one.
        </div>
        <div class="card">
          <div class="card-head">releases</div>
          <div class="card-body tscroll" id="rel-history"></div>
        </div>
      </section>

      <section id="tab-refusals">
        <div class="page-title">Refusals</div>
        <div class="note">
          Only refusals and strips are recorded, so an empty ring beside a non-zero
          <code>accepted</code> is what a healthy process looks like. A ring full of one code is
          somebody probing. Device ids are reduced to eight characters before they leave the process.
        </div>
        <div class="card">
          <div class="card-head">gate</div>
          <div class="card-body tscroll" id="guard-status"></div>
        </div>
        <div class="card">
          <div class="card-head">recent refusals</div>
          <div class="card-body tscroll" id="guard-ring"></div>
        </div>
      </section>

      <section id="tab-player">
        <div class="page-title">Players</div>
        <div class="card">
          <div class="card-head">look up a player</div>
          <div class="card-body">
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
          </div>
        </div>
        <div class="card tscroll" id="player-body"></div>
        <div class="card">
          <div class="card-head">actions</div>
          <div class="card-body">
            <div class="note">
              Every action is audited with your actor and reason. The dangerous ones carry the server's own
              two-phase confirm on top of this page's dialog — the first request arms it, and a confirm
              inside the server's delay window is refused, so a double-click cannot ban anybody.
              The subject is the device id in the lookup box; a claimed device resolves to its account.
            </div>
            <div class="rowline">
              <label class="muted">ban</label>
              <input id="act-ban-hours" autocomplete="off" placeholder="hours (blank = permanent)" size="20">
              <button id="act-ban" class="danger">ban…</button>
              <button id="act-unban">lift ban…</button>
            </div>
            <div class="rowline">
              <label class="muted">scrap</label>
              <input id="act-delta" autocomplete="off" placeholder="+100 or -100" size="12">
              <button id="act-currency">adjust…</button>
            </div>
            <div class="rowline">
              <label class="muted">item</label>
              <input id="act-ref" autocomplete="off" placeholder="item ref, e.g. trail-coolant-leak" size="24">
              <button id="act-revoke" class="danger">revoke…</button>
            </div>
            <div class="rowline">
              <label class="muted">remove-ads</label>
              <button id="act-ads-on">grant…</button>
              <button id="act-ads-off" class="danger">take away…</button>
            </div>
            <div class="rowline">
              <label class="muted">live</label>
              <button id="act-kick">kick this player's connections…</button>
            </div>
            <div class="rowline">
              <label class="muted">progress</label>
              <button id="act-reset" class="danger">reset progress…</button>
            </div>
            <div class="muted" id="act-state"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-head">merges — the §3.6 undo</div>
          <div class="card-body">
            <div class="note">
              Applied merges, newest first. Undo restores the absorbed profile from its archive, claws
              the Scrap back through the journal (a shortfall is documented, never hidden), and the
              device banks to its own file again.
            </div>
            <div class="tscroll" id="player-merges"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-head">what this console cannot do</div>
          <div class="card-body">
            <div class="note">
              These are not disabled buttons. There is no storage behind them yet, and a console that renders
              them anyway is one that lies about its own powers.
            </div>
            <div class="tscroll" id="player-missing"></div>
          </div>
        </div>
      </section>

      <section id="tab-referrals">
        <div class="page-title">Referrals</div>
        <div class="note">
          Conversions the fraud heuristics parked — over the day cap, or claimed from the code's own
          /24. Approve is the release valve: it PAYS both sides through the journal, so it walks the
          same two-phase confirm as the player verbs. A queue left alone pays nobody.
        </div>
        <div class="card">
          <div class="card-head">status</div>
          <div class="card-body tscroll" id="ref-status"></div>
        </div>
        <div class="card">
          <div class="card-head">review queue</div>
          <div class="card-body tscroll" id="ref-queue"></div>
        </div>
      </section>

      <section id="tab-metrics">
        <div class="page-title">Metrics</div>
        <div class="note" id="metrics-note"></div>
        <div class="card">
          <div class="card-head">fleet</div>
          <div class="card-body tscroll" id="metrics-fleet"></div>
        </div>
        <div class="card">
          <div class="card-head">connections — per-connection counters, rolled up</div>
          <div class="card-body tscroll" id="metrics-conn"></div>
        </div>
        <div class="card">
          <div class="card-head">signalling</div>
          <div class="card-body tscroll" id="metrics-signal"></div>
        </div>
        <div class="card">
          <div class="card-head">journal &amp; audit</div>
          <div class="card-body tscroll" id="metrics-stores"></div>
        </div>
      </section>

      <section id="tab-audit">
        <div class="page-title">Actions</div>
        <div class="note">
          Every mutation writes one row with its before and after state. Rows whose verb starts with
          <code>player.</code> are moderation records and are retained past the ordinary window.
        </div>
        <div class="card">
          <div class="card-head">audit log</div>
          <div class="card-body tscroll" id="audit-body"></div>
        </div>
      </section>
    </main>
  </div>
</div>

<dialog id="confirm">
  <h2 id="c-title">confirm</h2>
  <div class="tscroll" id="c-diff"></div>
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
  <div class="stack">
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
  var TABS = ['fleet', 'packs', 'review', 'rhistory', 'studio', 'flags', 'refusals', 'player', 'referrals', 'metrics', 'audit'];

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

  /* ---- the nav icons: inline SVG, built with createElementNS — never
     innerHTML — so the no-markup-from-data rule covers the chrome too. ---- */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(d) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'ico');
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.7');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    s.appendChild(p);
    return s;
  }

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
      if (rows.length === 0) rooms.appendChild(make('div', 'empty', 'no rooms on this host'));
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

  /* ---- C6: player actions through the same confirm dialog ---- */
  function armPlayer(verb, title, patch, lines) {
    var key = el('player-key').value.trim();
    if (key.length === 0) { el('act-state').textContent = 'look a player up first — the subject is the lookup box'; return; }
    armed = { player: verb, patch: patch, subject: key, plan: { delayMs: 3000 } };
    var diff = el('c-diff'); var warns = el('c-warnings');
    clear(diff); clear(warns);
    el('c-title').textContent = title + ' — ' + key;
    for (var i = 0; i < lines.length; i++) diff.appendChild(make('div', 'muted', lines[i]));
    el('c-subject').value = '';
    el('c-subject-want').textContent = 'exactly: ' + key;
    el('c-reason').value = '';
    el('c-state').textContent = '';
    el('c-state').className = 'muted';
    countdown = 3;
    if (ticker) clearInterval(ticker);
    ticker = setInterval(tick, 250);
    tick();
    el('confirm').showModal();
  }

  function firePlayer() {
    var verb = armed.player;
    var body = {};
    for (var k in armed.patch) if (Object.prototype.hasOwnProperty.call(armed.patch, k)) body[k] = armed.patch[k];
    body.deviceId = armed.subject;
    body.actor = el('c-actor').value.trim();
    body.reason = el('c-reason').value.trim();
    var state = el('c-state');
    var send = function () {
      return api('/api/admin/player/' + verb, 'POST', body).then(function (r) {
        if (r.status === 428 && r.body && r.body.confirmToken) {
          // The server's own delay: wait it out, then send the armed confirm.
          body.confirm = r.body.confirmToken;
          var wait = Math.max(0, (r.body.notBeforeMs || 0) - Date.now()) + 200;
          state.textContent = 'server armed — confirming in ' + Math.ceil(wait / 1000) + 's…';
          return new Promise(function (res2) { setTimeout(res2, wait); }).then(send);
        }
        if (r.status === 200) {
          state.textContent = 'applied — ' + (r.body && r.body.result ? r.body.result : 'ok');
          state.className = 'ok';
          el('act-state').textContent = verb + ': ' + (r.body && r.body.result ? r.body.result : 'ok');
          loadPlayer();
          loadAudit();
          setTimeout(function () { el('confirm').close(); }, 1200);
          return;
        }
        state.textContent = 'refused: HTTP ' + r.status + ' — ' + (r.body && r.body.error ? r.body.error : r.text.slice(0, 200));
        state.className = 'err';
      });
    };
    state.textContent = 'writing…';
    state.className = 'muted';
    send();
  }

  /* Any confirm-gated admin ROUTE (referral approve, merge undo): the same
     dialog and the same server 428 walk as the player verbs, generalised to
     a path + body. andThen reloads whatever screen armed it. */
  function armRoute(route, title, subject, patch, lines, andThen) {
    armed = { route: route, patch: patch, subject: subject, plan: { delayMs: 3000 }, andThen: andThen };
    var diff = el('c-diff'); var warns = el('c-warnings');
    clear(diff); clear(warns);
    el('c-title').textContent = title + ' — ' + subject;
    for (var i = 0; i < lines.length; i++) diff.appendChild(make('div', 'muted', lines[i]));
    el('c-subject').value = '';
    el('c-subject-want').textContent = 'exactly: ' + subject;
    el('c-reason').value = '';
    el('c-state').textContent = '';
    el('c-state').className = 'muted';
    countdown = 3;
    if (ticker) clearInterval(ticker);
    ticker = setInterval(tick, 250);
    tick();
    el('confirm').showModal();
  }

  function fireRoute() {
    var body = {};
    for (var k in armed.patch) if (Object.prototype.hasOwnProperty.call(armed.patch, k)) body[k] = armed.patch[k];
    body.actor = el('c-actor').value.trim();
    body.reason = el('c-reason').value.trim();
    var route = armed.route;
    var andThen = armed.andThen;
    var state = el('c-state');
    var send = function () {
      return api(route, 'POST', body).then(function (r) {
        if (r.status === 428 && r.body && r.body.confirmToken) {
          body.confirm = r.body.confirmToken;
          var wait = Math.max(0, (r.body.notBeforeMs || 0) - Date.now()) + 200;
          state.textContent = 'server armed — confirming in ' + Math.ceil(wait / 1000) + 's…';
          return new Promise(function (res2) { setTimeout(res2, wait); }).then(send);
        }
        if (r.status === 200) {
          state.textContent = 'applied';
          state.className = 'ok';
          if (andThen) andThen();
          loadAudit();
          setTimeout(function () { el('confirm').close(); }, 1200);
          return;
        }
        state.textContent = 'refused: HTTP ' + r.status + ' — ' + (r.body && r.body.error ? r.body.error : r.text.slice(0, 200));
        state.className = 'err';
      });
    };
    state.textContent = 'writing…';
    state.className = 'muted';
    send();
  }

  function fire() {
    if (!armed) return;
    if (armed.player) { firePlayer(); return; }
    if (armed.route) { fireRoute(); return; }
    if (armed.release) { fireRelease(); return; }
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

  /* ---- releases: Inventory, Review, History (docs/PACKS.md §6) ---- */
  var relState = null;

  function fp(v) { return '0x' + ((v >>> 0).toString(16)); }

  function loadRelease() {
    return api('/api/admin/release').then(function (r) {
      var head = el('rel-head');
      if (r.status !== 200) { fail(el('rel-draft'), r); fail(el('inv-levels'), r); fail(el('rel-history'), r); return; }
      relState = r.body;
      paintInventory(relState);
      paintReview(relState);
      paintRelHistory(relState);
    });
  }

  function paintInventory(st) {
    var build = el('inv-build');
    clear(build);
    var rows = [];
    var packs = (st.installed && st.installed.packs) || [];
    for (var i = 0; i < packs.length; i++) {
      if (packs[i].digest) continue;
      rows.push([packs[i].label, fp(packs[i].fingerprint),
        'rollback requires redeploying build ' + packs[i].label]);
    }
    build.appendChild(table(['pack', 'fingerprint', 'delivery'], rows));
    build.appendChild(make('div', 'muted',
      'Build packs are compiled into the bundle. They get versions, fingerprints and diffs; they do '
      + 'not get a push button, and a release naming them only records what this binary already is.'));

    var lv = el('inv-levels');
    clear(lv);
    var detail = (st.installed && st.installed.detail) || { levels: [], campaign: [] };
    for (var v = 0; v < detail.levels.length; v++) {
      var d = detail.levels[v];
      var line = make('div');
      line.appendChild(make('b', null, 'levels@' + d.version));
      line.appendChild(make('span', 'muted',
        ' — ' + d.total + ' levels, ' + d.playable + ' playable · ' + fp(d.fingerprint)
        + ' · sha256 ' + (d.digest ? d.digest.slice(0, 12) + '…' : '—')));
      lv.appendChild(line);
      for (var q = 0; q < d.refused.length; q++) {
        lv.appendChild(make('div', 'err', '  ' + d.refused[q].id + ' REFUSED: ' + d.refused[q].detail));
      }
    }
    if (detail.levels.length === 0) lv.appendChild(make('div', 'empty', 'no levels installed'));

    var cp = el('inv-campaign');
    clear(cp);
    for (var c = 0; c < detail.campaign.length; c++) {
      var e = detail.campaign[c];
      cp.appendChild(make('div', null,
        'campaign@' + e.version + ' — ' + e.episodes + ' episode(s) · ' + fp(e.fingerprint)
        + ' · sha256 ' + (e.digest ? e.digest.slice(0, 12) + '…' : '—')));
    }
    if (detail.campaign.length === 0) cp.appendChild(make('div', 'empty', 'no campaign manifest installed'));
  }

  function relFind(st, pred) {
    var h = (st.document && st.document.history) || [];
    for (var i = h.length - 1; i >= 0; i--) if (pred(h[i])) return h[i];
    return null;
  }

  function paintReview(st) {
    var doc = st.document;
    var live = st.live || {};
    el('rel-head').textContent =
      'document revision ' + doc.revision
      + ' · live ' + (live.revision === 0 ? 'builtin' : 'revision ' + live.revision)
      + ' (ordinal ' + live.ordinal + ')'
      + ' · pending ' + (doc.pendingRevision || 'none')
      + (doc.frozen ? ' · FROZEN' : '');

    var warn = el('rel-warning');
    clear(warn);
    if (doc.frozen) {
      warn.appendChild(make('div', null,
        'RELEASES ARE FROZEN. Every staged release — including one at 100% — resolves to the live one. '
        + 'Freeze here beats a full stage on purpose; the terminal, freeze-proof state is live, and live '
        + 'needs a separate promote click.'));
    }
    if ((live.unsatisfied || []).length > 0) {
      warn.appendChild(make('div', null,
        'THIS HOST CANNOT SATISFY THE LIVE RELEASE: ' + live.unsatisfied.join(', ')
        + ' — it is serving the previous release instead and saying so (Rule E). Fix the volume, not the process.'));
    }

    var draft = relFind(st, function (x) { return x.state === 'draft' || x.state === 'review'; });
    var staged = relFind(st, function (x) { return x.state === 'staged'; });

    var acts = el('rel-actions');
    clear(acts);
    function actBtn(label, cls, verb, subject, sub, extra, disabledReason) {
      var b = make('button', cls, label);
      if (disabledReason) { b.disabled = true; b.title = disabledReason; }
      else b.addEventListener('click', function () { armRelease(verb, subject, sub, extra || {}); });
      acts.appendChild(b);
      return b;
    }
    actBtn('assemble draft', null, 'release.draft', 'draft', '', {},
      staged !== null ? 'a staged release is pending — promote or roll it back first' : '');
    el('rel-note-row').hidden = draft === null;
    if (draft !== null) {
      actBtn('run gate', null, 'release.gate', 'revision ' + draft.revision, '/gate', {});
      actBtn('approve', 'go', 'release.approve', 'revision ' + draft.revision, '/approve', { noteFrom: true },
        draft.state !== 'review' || !draft.gate || !draft.gate.ok
          ? 'the SERVER refuses approval until the gate has run green — this button firing anyway would just show you that refusal'
          : '');
    }
    if (staged !== null) {
      actBtn('stage 0%', null, 'release.stage', 'revision ' + staged.revision, '/stage', { bp: 0 });
      for (var li = 1; li < LADDER.length - 1; li++) {
        actBtn(bp(LADDER[li]), null, '', '', '', {},
          'decorative on one host: one long-lived room per key means a partial stage reaches zero rooms for hours');
      }
      actBtn('stage 100%', null, 'release.stage', 'revision ' + staged.revision, '/stage', { bp: 10000 });
      actBtn('PROMOTE', 'danger', 'release.promote', 'revision ' + staged.revision, '/promote', {},
        staged.rolloutBp !== 10000 ? 'promote requires a stage at 100% — live is the terminal, freeze-proof state' : '');
    }
    actBtn(doc.frozen ? 'unfreeze releases' : 'freeze releases', doc.frozen ? 'go' : 'danger',
      doc.frozen ? 'release.unfreeze' : 'release.freeze', 'document ' + doc.revision, '/freeze', { frozen: !doc.frozen });
    el('rel-actions-note').textContent = staged !== null
      ? 'staged: revision ' + staged.revision + ' at ' + bp(staged.rolloutBp) + ' of NEW rooms — the denominator is rooms created since staging, never players'
      : (draft !== null ? 'draft revision ' + draft.revision + ' (' + draft.state + ')' : 'no draft — assemble one from what is installed');

    var body = el('rel-draft');
    clear(body);
    var subject = draft || staged;
    if (subject === null) {
      body.appendChild(make('div', 'empty', 'nothing in flight'));
    } else {
      if (subject.gate && subject.gate.schemaTouching) {
        body.appendChild(make('div', 'warn bad',
          'THIS RELEASE TOUCHES THE PROFILE SCHEMA. It can NEVER be rolled back — a v(n-1) host has no '
          + '_unknown bag, and every balance it rewrites is gone for good. Promote it knowing that.'));
      }
      var rows = [];
      for (var i = 0; i < subject.packs.length; i++) {
        var pk = subject.packs[i];
        rows.push([pk.label, pk.digest ? 'data' : 'build', fp(pk.fingerprint),
          pk.digest ? pk.digest.slice(0, 12) + '…' : '—',
          pk.digest ? 'lands on the next NEW room' : 'rollback requires redeploying build ' + pk.label]);
      }
      body.appendChild(table(['pack', 'class', 'fingerprint', 'sha256', 'arrival / rollback'], rows));
      if (subject.note) body.appendChild(make('div', 'muted', 'note: ' + subject.note));
    }

    var gateHost = el('rel-gate');
    clear(gateHost);
    var g = subject && subject.gate;
    if (!g) {
      gateHost.appendChild(make('div', 'empty', 'the gate has not run'));
    } else {
      var grows = [];
      for (var ci = 0; ci < g.checks.length; ci++) {
        var ck = g.checks[ci];
        grows.push([make('span', ck.ok ? 'ok' : 'err', ck.ok ? 'ok' : 'FAIL'), ck.id, ck.detail || '']);
      }
      gateHost.appendChild(table(['', 'check', 'detail'], grows));
      gateHost.appendChild(make('div', g.ok ? 'ok' : 'err',
        (g.ok ? 'PASS' : 'REFUSED') + ' — ' + g.checks.length + ' checks in ' + g.ranMs + ' ms'));
    }

    var diffHost = el('rel-diff');
    clear(diffHost);
    var dl = (g && g.diff) || [];
    if (dl.length === 0) {
      diffHost.appendChild(make('div', 'empty', g
        ? 'this release changes nothing against what is live — same packs, same versions, same bytes'
        : 'no diff — run the gate to compute one'));
    }
    for (var di = 0; di < dl.length; di++) {
      var dd = dl[di];
      diffHost.appendChild(make('div', null, dd.key + ': ' + (dd.from || '(new)') + ' -> ' + dd.to));
      for (var li2 = 0; li2 < dd.changes.length; li2++) {
        diffHost.appendChild(make('div', dd.changes[li2].charAt(0) === '+' ? 'mono ok' : 'mono err', '  ' + dd.changes[li2]));
      }
    }
  }

  function paintRelHistory(st) {
    var host = el('rel-history');
    clear(host);
    var doc = st.document;
    var h = (doc.history || []).slice().reverse();
    if (h.length === 0) { host.appendChild(make('div', 'empty', 'no release has ever been assembled on this host')); return; }
    var rows = [];
    for (var i = 0; i < h.length; i++) {
      var r = h[i];
      var action;
      if (r.state === 'live') {
        if (r.gate && r.gate.schemaTouching) {
          action = make('span', 'muted', 'schema-touching: can never be rolled back');
        } else {
          action = make('button', 'danger', 'roll back');
          (function (rev) {
            action.addEventListener('click', function () {
              armRelease('release.rollback', 'revision ' + rev, '/rollback', {});
            });
          })(r.revision);
        }
      } else {
        action = make('span', 'muted',
          r.state === 'staged' ? 'pending' : r.state === 'rolled_back' ? 'was live, is not any more' : '—');
      }
      rows.push([
        r.revision, r.ordinal, r.state, bp(r.rolloutBp),
        r.packs.map(function (pk) { return pk.label; }).join(' '),
        r.note || '—', action,
      ]);
    }
    host.appendChild(table(['revision', 'ordinal', 'state', 'rollout', 'packs', 'note', ''], rows, [0, 1]));
  }

  function armRelease(verb, subject, sub, extra) {
    if (!relState) return;
    armed = { verb: verb, subject: subject, release: { sub: sub, extra: extra } };
    var diff = el('c-diff');
    var warns = el('c-warnings');
    clear(diff); clear(warns);
    el('c-title').textContent = verb + ' — ' + subject;
    diff.appendChild(make('div', 'muted',
      'POST /api/admin/release' + sub + ' with ifRevision ' + relState.document.revision
      + ' — a stale revision is a 409 and changes nothing.'));
    el('c-subject').value = '';
    el('c-subject-want').textContent = 'exactly: ' + subject;
    el('c-reason').value = '';
    el('c-state').textContent = '';
    el('c-state').className = 'muted';
    countdown = 0;
    if (ticker) clearInterval(ticker);
    ticker = setInterval(tick, 250);
    tick();
    el('confirm').showModal();
  }

  function fireRelease() {
    var body = {};
    var extra = armed.release.extra || {};
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k) && k !== 'noteFrom') body[k] = extra[k];
    if (extra.noteFrom) {
      var noteEl = el('rel-note');
      body.note = noteEl ? noteEl.value.trim() : '';
    }
    body.ifRevision = relState.document.revision;
    body.actor = el('c-actor').value.trim();
    body.reason = el('c-reason').value.trim();
    var state = el('c-state');
    state.textContent = 'writing…';
    state.className = 'muted';
    api('/api/admin/release' + armed.release.sub, 'POST', body).then(function (r) {
      if (r.status === 200) {
        state.textContent = 'applied — document revision ' + r.body.document.revision;
        state.className = 'ok';
        loadRelease();
        loadAudit();
        setTimeout(function () { el('confirm').close(); }, 900);
        return;
      }
      state.textContent = 'refused: HTTP ' + r.status + ' — ' + (r.body && r.body.error ? r.body.error : r.text.slice(0, 200));
      state.className = 'err';
      loadRelease();
    });
  }

  /* ---- the Creator Studio ---- */
  var studioSeeded = false;

  function loadStudio() {
    return api('/api/admin/studio').then(function (r) {
      var warn = el('studio-warning');
      if (r.status !== 200) { fail(warn, r); return; }
      clear(warn);
      var st = r.body.studio;
      if (!st.writable) {
        warn.appendChild(make('div', null, 'SAVES ARE REFUSED ON THIS HOST: ' + st.reason));
      }
      if (!studioSeeded) {
        el('studio-items').value = r.body.seeds.items || '';
        el('studio-campaign').value = r.body.seeds.campaign || '';
        studioSeeded = true;
      }
      var list = el('studio-drafts-list');
      clear(list);
      var rows = [];
      for (var i = 0; i < (st.drafts || []).length; i++) {
        rows.push([st.drafts[i].kind, st.drafts[i].file, new Date(st.drafts[i].ms).toISOString()]);
      }
      if (rows.length === 0) list.appendChild(make('div', 'empty', 'no drafts yet'));
      else list.appendChild(table(['kind', 'file', 'saved'], rows));
    });
  }

  function studioPost(sub, body, state) {
    state.textContent = 'saving…';
    state.className = 'muted';
    var actor = el('c-actor').value.trim() || 'operator';
    api('/api/admin/studio/' + sub, 'POST', Object.assign({
      actor: actor,
      reason: 'authored in the creator studio: ' + sub,
    }, body)).then(function (r) {
      if (r.status === 200) {
        state.textContent = 'saved ' + (r.body.label || '') + ' — ' + (r.body.detail || '');
        state.className = 'ok';
        loadStudio();
        loadAudit();
        return;
      }
      state.textContent = 'refused: ' + (r.body && r.body.error ? r.body.error : 'HTTP ' + r.status);
      state.className = 'err';
    });
  }

  el('studio-items-save').addEventListener('click', function () {
    studioPost('items', { manifest: el('studio-items').value }, el('studio-items-state'));
  });
  el('studio-level-check').addEventListener('click', function () {
    var report = el('studio-level-report');
    clear(report);
    api('/api/admin/studio/level/validate', 'POST', { source: el('studio-level').value }).then(function (r) {
      if (r.status !== 200) { fail(report, r); return; }
      var v = r.body;
      report.appendChild(make('div', v.ok ? 'ok' : 'err', (v.ok ? 'WOULD PASS the gate — ' : 'WOULD BE REFUSED — ') + (v.report || (v.errors || []).join('; '))));
    });
  });
  el('studio-level-save').addEventListener('click', function () {
    studioPost('level', { source: el('studio-level').value }, el('studio-level-state'));
  });
  el('studio-campaign-save').addEventListener('click', function () {
    studioPost('campaign', { manifest: el('studio-campaign').value }, el('studio-campaign-state'));
  });
  function draftSave(kind) {
    var raw = el('studio-draft').value;
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    if (parsed === null) {
      el('studio-draft-state').textContent = 'the draft must be valid JSON';
      el('studio-draft-state').className = 'err';
      return;
    }
    studioPost('draft', { kind: kind, body: parsed }, el('studio-draft-state'));
  }
  el('studio-draft-weapons').addEventListener('click', function () { draftSave('weapons'); });
  el('studio-draft-characters').addEventListener('click', function () { draftSave('characters'); });

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
      if (rows.length === 0) ring.appendChild(make('div', 'empty', 'no refusals since this process started — a healthy ring is empty'));
      else ring.appendChild(table(['when', 'player', 'code', 'reason', 'trust', 'stripped'], rows, [2]));
    });
  }

  /* ---- referrals (C6.1: the review queue as a screen) ---- */
  function loadReferrals() {
    return api('/api/admin/referrals').then(function (r) {
      var s = el('ref-status');
      var q = el('ref-queue');
      if (r.status !== 200) { fail(s, r); return; }
      clear(s);
      s.appendChild(pairs(r.body.status));
      clear(q);
      var queue = r.body.queue || [];
      if (queue.length === 0) {
        q.appendChild(make('div', 'empty', 'nothing parked — every conversion paid or none converted'));
        return;
      }
      var rows = [];
      for (var i = 0; i < queue.length; i++) {
        (function (row) {
          var b = make('button', 'danger', 'approve — PAYS both sides…');
          b.addEventListener('click', function () {
            armRoute('/api/admin/referrals/approve', 'approve referral', row.referred,
              { referredKey: row.referredKey }, [
                'Pays the recruiter and the referred player through the journal, idempotent forever.',
                'Parked because: ' + row.review,
              ], loadReferrals);
          });
          rows.push([new Date(row.claimedMs).toISOString(), row.referred, row.referrer, row.review, b]);
        })(queue[i]);
      }
      q.appendChild(table(['claimed', 'referred', 'recruiter', 'why it parked', ''], rows));
    });
  }

  /* ---- merges (C6.1: the §3.6 undo) ---- */
  function loadMerges() {
    return api('/api/admin/merges').then(function (r) {
      var host = el('player-merges');
      if (r.status !== 200) { fail(host, r); return; }
      clear(host);
      var merges = r.body.merges || [];
      if (merges.length === 0) {
        host.appendChild(make('div', 'empty', 'no applied merges on this host'));
        return;
      }
      var rows = [];
      for (var i = 0; i < merges.length; i++) {
        (function (m) {
          var act;
          if (m.undone) act = make('span', 'muted', 'undone');
          else {
            act = make('button', 'danger', 'undo…');
            act.addEventListener('click', function () {
              armRoute('/api/admin/merge/undo', 'undo merge', m.eventId, { eventId: m.eventId }, [
                'Restores the absorbed profile from its archive and claws ' + m.scrapMoved
                  + ' Scrap back through the journal — a shortfall is documented, never hidden.',
                'The device detaches and banks to its own file again.',
              ], loadMerges);
            });
          }
          rows.push([new Date(m.ms).toISOString(), m.eventId, m.into, m.from, String(m.scrapMoved), act]);
        })(merges[i]);
      }
      host.appendChild(table(['when', 'event', 'into account', 'from', 'scrap', ''], rows, [4]));
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
      if (rows.length === 0) body.appendChild(make('div', 'empty', 'no ledger rows in the retained window'));
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
      if (rows.length === 0) host.appendChild(make('div', 'empty', 'no admin action has been recorded on this host'));
      else host.appendChild(table(['when', 'actor', 'verb', 'subject', 'outcome', 'reason', 'before', 'after'], rows));
      host.appendChild(pairs(r.body.status));
    });
  }

  /* ---- shell ---- */
  function show(name) {
    for (var i = 0; i < TABS.length; i++) {
      el('tab-' + TABS[i]).className = TABS[i] === name ? 'live' : '';
      el('btn-' + TABS[i]).className = TABS[i] === name ? 'nav-item on' : 'nav-item';
    }
    if (name === 'flags') loadFlags();
    else if (name === 'packs' || name === 'review' || name === 'rhistory') loadRelease();
    else if (name === 'studio') loadStudio();
    else if (name === 'refusals') loadRefusals();
    else if (name === 'referrals') loadReferrals();
    else if (name === 'audit') loadAudit();
    else loadFleet();
    if (name === 'player') loadMerges();
  }

  function closeNav() { document.body.classList.remove('nav-open'); }

  function refresh() {
    api('/api/admin/whoami').then(function (r) {
      el('freshness').textContent = (r.status === 200 ? 'synced ' : 'sync failed ') + new Date().toLocaleTimeString();
      if (r.status !== 200) { paintFacts(null); paintWho(null); paintOwner(null); fail(el('fleet-deploy'), r); return; }
      paintFacts(r.body);
      paintWho(r.body.identity);
      paintOwner(r.body.identity);
      paintMissing(r.body.capabilities.missing);
      loadFleet();
    });
  }

  /* The sidebar: the same six panels TABS declares, grouped the way an
     operator reaches for them. TABS stays the one list the panels and the
     active-state loop are built from; GROUPS only decides order and labels. */
  var GROUPS = [
    { label: 'Live', tabs: ['fleet', 'player', 'referrals'] },
    { label: 'Releases', tabs: ['packs', 'review', 'rhistory', 'studio', 'flags'] },
    { label: 'Audit', tabs: ['refusals', 'audit'] },
    { label: 'Analytics', tabs: ['metrics'] },
  ];
  var TAB_META = {
    fleet: { title: 'Fleet', d: 'M4 4h16v7H4zM4 13h16v7H4zM7 7.5h.01M7 16.5h.01' },
    player: { title: 'Players', d: 'M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM5 20c.6-3.4 3.4-5 7-5s6.4 1.6 7 5' },
    packs: { title: 'Inventory', d: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12L4 7.5M12 12v9' },
    review: { title: 'Review', d: 'M9 11l2.5 2.5L16 9M12 3l7 2.5V11c0 4.5-3 7.9-7 9-4-1.1-7-4.5-7-9V5.5z' },
    rhistory: { title: 'History', d: 'M12 8v5l3 2M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4' },
    studio: { title: 'Studio', d: 'M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10zM13.5 7.5l3 3M4 20l1-4.5' },
    flags: { title: 'Flags', d: 'M6 21V4m0 1h11.5l-2.3 3.5 2.3 3.5H6' },
    refusals: { title: 'Refusals', d: 'M12 3l7 2.5V11c0 4.5-3 7.9-7 9-4-1.1-7-4.5-7-9V5.5zM9.5 9.5l5 5M14.5 9.5l-5 5' },
    referrals: { title: 'Referrals', d: 'M9 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 16c.4-2.6 2.6-4 6-4M17 10a3 3 0 1 0 0-6M15 21l3-3-3-3M21 18h-6' },
    audit: { title: 'Actions', d: 'M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5' },
    metrics: { title: 'Metrics', d: 'M4 20h16M7 16v-5M12 16V6M17 16v-8' },
  };

  var nav = el('tabs');
  for (var gi = 0; gi < GROUPS.length; gi++) {
    nav.appendChild(make('div', 'nav-label', GROUPS[gi].label));
    for (var ti = 0; ti < GROUPS[gi].tabs.length; ti++) {
      (function (name) {
        var b = make('button', 'nav-item');
        b.id = 'btn-' + name;
        b.appendChild(icon(TAB_META[name].d));
        b.appendChild(make('span', null, TAB_META[name].title));
        b.addEventListener('click', function () { show(name); closeNav(); });
        nav.appendChild(b);
      })(GROUPS[gi].tabs[ti]);
    }
  }

  el('menu-toggle').addEventListener('click', function () { document.body.classList.toggle('nav-open'); });
  el('scrim').addEventListener('click', closeNav);
  el('save-token').addEventListener('click', function () { setTok(el('token').value.trim()); el('token').value = ''; refresh(); });
  el('forget-token').addEventListener('click', function () { setTok(''); location.reload(); });
  el('refresh').addEventListener('click', refresh);
  el('signout').addEventListener('click', function () {
    api('/api/auth/signout', 'POST', {}).then(function () { setTok(''); location.reload(); });
  });
  el('player-go').addEventListener('click', function () { loadPlayer(); });
  el('player-key').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadPlayer(); });
  el('act-ban').addEventListener('click', function () {
    var hours = parseFloat(el('act-ban-hours').value);
    var untilMs = isFinite(hours) && hours > 0 ? Date.now() + hours * 3600000 : 0;
    armPlayer('moderate', 'ban', { banned: true, untilMs: untilMs }, [
      untilMs === 0 ? 'PERMANENT ban — no expiry.' : 'Ban until ' + new Date(untilMs).toISOString() + '.',
      'Live connections are kicked now; no new socket credential mints while it stands.',
    ]);
  });
  el('act-unban').addEventListener('click', function () {
    armPlayer('moderate', 'lift ban', { banned: false, untilMs: 0 }, ['The ban is lifted; the player can connect on the next attempt.']);
  });
  el('act-currency').addEventListener('click', function () {
    var delta = parseInt(el('act-delta').value, 10);
    if (!isFinite(delta) || delta === 0) { el('act-state').textContent = 'delta must be a non-zero integer'; return; }
    armPlayer('currency', 'adjust scrap', { delta: delta }, [
      (delta > 0 ? '+' : '') + delta + ' Scrap, written as an admin.adjust JOURNAL row — the balance follows the ledger, never the reverse.',
    ]);
  });
  el('act-revoke').addEventListener('click', function () {
    var ref = el('act-ref').value.trim();
    if (ref.length === 0) { el('act-state').textContent = 'type the item ref to revoke'; return; }
    armPlayer('revoke-item', 'revoke item', { ref: ref }, [
      'Adds ' + ref + ' to moderation.revokedItems — the only written item state; everything else stays derived from the live release.',
    ]);
  });
  el('act-ads-on').addEventListener('click', function () {
    armPlayer('entitlement', 'grant remove-ads', { adsRemoved: true }, ['Sets the entitlement on. A support grant, audited; not a purchase record.']);
  });
  el('act-ads-off').addEventListener('click', function () {
    armPlayer('entitlement', 'take remove-ads away', { adsRemoved: false }, ['Sets the entitlement off. If money moved, the refund itself needs the payment provider (C8).']);
  });
  el('act-kick').addEventListener('click', function () {
    armPlayer('kick', 'kick live connections', {}, ['Closes every live socket banking to this player, on this host. They can reconnect unless banned.']);
  });
  el('act-reset').addEventListener('click', function () {
    armPlayer('reset-progress', 'reset progress', {}, [
      'Progress, stats, economy and inventory go to zero. The name, settings, entitlements and the account link stay.',
      'The profile is ARCHIVED first — a reset that cannot archive refuses — and the Scrap zeroing is a journal row.',
    ]);
  });
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
  :root {
    color-scheme: dark;
    --ground: #131010;
    --panel: #1E1917;
    --sunk: #0C0A09;
    --rule: #463731;
    --rule-soft: #2E2622;
    --bone: #DED4C4;
    --hell: #E0431C;
    --amber: #E5A02E;
    --faded: #A29584;
    --dim: #7C7061;
    --font-display: "Big Shoulders Display", "Arial Narrow", "Avenir Next Condensed", "Helvetica Neue", system-ui, sans-serif;
    --font-body: "Barlow", "Helvetica Neue", Arial, system-ui, sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--ground); color: var(--bone); font: 14px/1.5 var(--font-body); }
  :focus-visible { outline: 2px solid var(--amber); outline-offset: 1px; }
  main { max-width: 62ch; margin: 0 auto; padding: 48px 16px 40px; }
  h1 {
    margin: 0; font-family: var(--font-display); font-weight: 700; font-size: 34px; line-height: 1;
    letter-spacing: .05em; text-transform: uppercase; color: var(--hell);
  }
  .brand-sub {
    font-family: var(--font-display); font-size: 12px; letter-spacing: .32em;
    text-transform: uppercase; color: var(--dim); margin: 4px 0 22px;
  }
  .card { background: var(--panel); border: 1px solid var(--rule); border-radius: 5px; margin: 0 0 18px; }
  .card-head {
    font-family: var(--font-display); font-weight: 700; font-size: 13px; letter-spacing: .2em;
    text-transform: uppercase; color: var(--amber);
    padding: 10px 16px; border-bottom: 1px solid var(--rule-soft);
  }
  .card-body { padding: 14px 16px 16px; }
  .lead { color: var(--faded); margin: 0 0 8px; }
  label { display: block; margin: 12px 0 4px; color: var(--faded); }
  input {
    font: 14px/1.4 var(--font-mono); background: var(--sunk); color: var(--bone);
    border: 1px solid var(--rule); padding: 8px 10px; border-radius: 3px; width: 100%;
  }
  button {
    font: 600 14px/1.3 var(--font-body); background: var(--hell); color: #1A0E0A;
    border: 1px solid var(--hell); padding: 8px 16px; cursor: pointer; border-radius: 3px; margin-top: 16px;
    letter-spacing: .02em;
  }
  button:hover:enabled { background: #F05A30; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  code, pre { font-family: var(--font-mono); background: var(--sunk); border: 1px solid var(--rule-soft); border-radius: 3px; }
  code { padding: 1px 5px; }
  pre { padding: 10px 12px; overflow-x: auto; font-size: 12px; }
  p { max-width: 66ch; }
  .muted { color: var(--dim); }
  .err { color: #F0A088; }
  .warn {
    border-left: 3px solid var(--amber); background: #201810; color: #E7CB93;
    padding: 10px 12px; margin: 16px 0; border-radius: 0 3px 3px 0;
  }
</style>
</head>
<body>
<main>
  <h1>Doomcraft</h1>
  <div class="brand-sub">operator console</div>
  <div class="card">
    <div class="card-head">${headline}</div>
    <div class="card-body">
      <p class="lead">${lead}</p>
      <label for="su-name">name</label>
      <input id="su-name" autocomplete="username" spellcheck="false" placeholder="${NAME_MIN}-${NAME_MAX} of a-z 0-9 _ -">
      <label for="su-pass">passphrase</label>
      <input id="su-pass" type="password" autocomplete="current-password" spellcheck="false" placeholder="${passHint}">
      <div><button id="su-go">${action}</button></div>
      <p id="su-state" class="muted">nothing sent yet</p>
    </div>
  </div>
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
