# Doomcraft — handover: where it stands, and what is left

Written 2026-08-28, end of the session that shipped sponsors phase 1b, the §2.2 creative
pipeline (operator lane), the whole platform identity arc C4→C6, and viral tier 1. The
previous handover (the pack machine + studio + ads phase 1a) is in git history at
`bfdc647`; the one before (server tier + accounts) at `0bb98bb..557c7b6`. §0 is restated
because it keeps earning it.

**Live:**
- **https://doomcraft-production.up.railway.app** — the Node origin: game, rooms, API,
  release tier, the admin console at `/admin` (Fleet / Players-with-teeth / Inventory /
  Review / History / Studio / Flags / Refusals / Metrics / Audit). Railway project
  `doomcraft`, volume `/data`, `DOOMCRAFT_PACKS=/data/packs`.
- **https://doomcraft.vercel.app** — static single-player, same bundle.
- **https://doomcraft-site.vercel.app** — landing. **github.com/pallefar/doomcraft** — `main`.
- CI: `tsc -b` + `vitest run` + `release:verify` on every push; every push this session
  green. Suite: **80 files / 2118 tests**.

Read this, then `docs/SPONSORS.md` (STATUS notes inline at §1g/§2.2/§6), `docs/PLATFORM.md`
(C4–C6 shipped; the code deviates from the doc where the doc predates the passphrase
accounts — the deviations are written in the file headers), `docs/PACKS.md`, `docs/STUDIO.md`,
`docs/ECONOMY.md`, `ref/BAR.md`.

---

## 0. The rules this project learned expensively. Do not relearn them.

1. **"It compiles and tests pass" is not evidence.** Demand an import trace from
   `server/src/index.ts` or `client/src/main.ts` PLUS a screenshot or a measurement.
   `client/src/ui/wiring.test.ts` fails the suite when a UI module ships to nobody.
   This session's proof of the rule: ads phase 1a passed everything and was INERT on the
   menu — the menu session is the LOCAL worker, whose flag bits can never carry
   `sponsor_slots`. Only booting the thing found it.
2. **A green test that cannot fail is worse than no test.** Prove every regression test red
   with its fix reverted — and check WHAT goes red: the referral pay-twice guard looked
   proven until the mutation showed the state machine masking it; only a crash-replay test
   actually bites the journal guard.
3. **Measure, don't eyeball.** The S3 ribbon's "readable" was settled by `scrollWidth <=
   clientWidth`, not by looking at it.
4. **The bar is real and fetchable** (`ref/`). The gauntlet is still **0/23**.
5. **`grep` silently skips `shared/src/flags.ts`** (deliberate NUL bytes). `grep -a` or `rg`;
   edit that file with python, never sed.
6. **Simulated-failure tests must pick platform-identical failure inputs.**
7. **A gate that verifies the wrong tree is worse than no gate** (`release:verify` refuses a
   worktree without its own `npm install`).
8. **Workflow/worktree agents check out HEAD** — commit first, then audit.
9. New this session: **`MemoryStore.load` returns the live object** — snapshot
   (`structuredClone`) before mutating anything you loaded twice. **`git checkout -- file`
   after a mutation-proof discards your real changes too.** **Vercel deploys from the repo
   root only** (the project link lives in `.vercel/`; the Railway worktree 400s). **Verify a
   Railway deploy by probing a NEW route**, not `/api/version` — `variables --set` restarts
   the old build with the new build id before `railway up` lands.

## 1. What this session shipped (all pushed, all green, all deployed)

| Commit | What |
|---|---|
| `2641461` `c1238a3` `c2179a9` | **Sponsors 1b** — S3 gold tile ribbon (`AdFill.modeId`; for MODE_TILE `targeting.modes` NAMES the tile; editorial ribbon never displaced), S4 boot line (decides at shell start), S12 intermission card (`sponsorCard` seam on `ModeHost`; quest interactive, DM display-only, never mid-round). Fixed 1a's two inertness defects; the client now answers the kill switch itself via one GET `/api/flags`. |
| `f4ac8ca` | **§2.2 operator lane** — `server/src/creatives.ts`: content-addressed `/cdn/crv/<sha256>.<ext>`, magic-byte MIME (SVG/HTML refused by construction), static-only, exact IAB sizes read from the file's own header; display campaigns serve with a per-surface/per-platform size table; admin upload, audited. |
| `8be770c` `45504e9` `1043bf9` | **C4** — `shared/src/identity.ts` brands; `server/src/accountGraph.ts` (§2.3 graph + the §3.2 nine-row `signIn`, atomic under one graph lock); `credentials.ts` house provider (built+tested, wired later); `dc_dev` 400-day httpOnly cookie + `POST /api/device`; single-use 120 s socket tickets; the upgrade REFUSES `?device=` and sets `conn.deviceId = ticket.profileKey` — payouts/flags key per person with zero room.ts changes; client ticketed transport + account panel (row-3 question §3.2.1 verbatim). |
| `0d1d051` | **C5** — `server/src/merge.ts`: §3.3 field classes, §3.7 worked example test-locked, money ONLY as a merge.debit/credit journal pair (idempotent on the pre-minted event id), day buckets roll-then-max (red-proven against the exact wrong answer), §3.5 budget + review parking, B archived under `merged/` for the §3.6 undo. `/api/account/merge` (preview/decline/accept) + the panel offer. |
| `c7c7951` | **C6** — `/api/admin/player/{moderate,revoke-item,currency,entitlement,kick}` behind a server-side two-phase confirm (428 arm → 425 inside the delay → apply), `Room.kick()`, ban = profile+account+live-kick+no-ticket, `admin.adjust` journal rows, console Players action forms, MISSING_CAPABILITIES trimmed to the honest remainder. |
| (last) | **Viral tier 1** — `server/src/referrals.ts`: codes, first-wins-forever attribution, conversion on engagement (30 min paid play or level 5) as `kind:'referral'` journal rows idempotent on the referred player, day cap + same-/24 heuristic PARK conversions in a review queue, `approve` as the audited release valve. Client `?ref=` claim + panel share line. Room seam: `onProfilePersisted`. |

## 2. Architecture delta

```
identity: dc_dev cookie ─► /api/device mirror; play = /api/session/ticket ─► ws?t=<single-use>
          conn.deviceId IS the resolved profile key from the ticket — everything downstream is per-person
graph:    <data>/accounts/<2hex>/<id>.json ('pass:'-adopted ids); §3.2 rows decide every signup/signin bind
merge:    merge.jsonl (pending→applied) + merged/<dev>-<event>.json archive + journal pair
creatives:<data>/creatives/<sha256>.<ext> ─► /cdn/crv/…  (immutable, nosniff, CORP)
referrals:<data>/referrals.json  codes/attributions/day-caps/queue;  journal kind 'referral'
sponsors: S1 slots (display creatives live) · S3 ribbon · S4 boot line · S12 card — all §3.2-metered
```

`LEDGER_KINDS` gained `'referral'`. `AdFill` gained `modeId`. New admin routes:
creatives, player verbs, referrals; all audited, the paying/destructive ones confirm-gated.

## 3. What is left — in the order I would do it

1. **Trading + competitions** (`docs/ECONOMY.md`) — two-sided escrow (confirm resets on any
   change, ACTIVE-state check at offer AND confirm), seasons/tournaments. Items, the journal
   and per-person identity all exist now; this is the exchange and the calendar.
2. **Share cards** (viral tier 1's second half) — server-rendered 1200×630 PNG from match
   data with the join code and `?ref=` link. `SPONSORS.md` S36 reserves the lockup rules.
   The referral loop is live but has no shareable artefact yet.
3. **C6.1 small operator debts** — the merge UNDO route (`merged/` archive + the journal
   pair are already the raw material), the referral review queue as a console screen (the
   API is `/api/admin/referrals`; approve exists, no UI), reset-progress.
4. **Studio S2–S4** (`docs/STUDIO.md` §3) — level preview render, expansion one-click
   release, challenge engine.
5. **Sponsors phase 2** — interstitial/rewarded in `#ad-overlay` (constants exist), and the
   §3.5 metrics dashboard (item 10; `ads.jsonl` is the truth it renders).
6. **The gauntlet — 0/23.** Real remaining work. `tools/gauntlet.js` is blind and honest.
7. **Portals + app stores** — Poki/CrazyGames (`frame-ancestors` allow-list), TWA (manifest
   still missing), iOS.
8. **C7 analytics (house)** per PLATFORM; then **C8 vendors** — blocked on the user (§5).

## 4. Deploy runbook (follow exactly)

- **Vercel (static): from the REPO ROOT** — `npx vercel --prod --yes`. Never from a worktree.
- **Railway (origin):** from a CLEAN WORKTREE at HEAD: `git worktree add <tmp> HEAD && cd
  <tmp> && railway link --project doomcraft --service doomcraft && railway variables --set
  DOOMCRAFT_BUILD_ID=$(git rev-parse --short HEAD) && railway up --detach`. Verify by
  probing a route the new build ADDS (e.g. this session `/api/session/ticket`), because the
  var-set alone restarts the old build already answering the new id.
- Commit → push → redeploy at every green stage; full suite green before any commit.
- Local verification env: `DOOMCRAFT_FLAGS='{"rules":{"online_play":{"force":true},
  "sponsor_slots":{"force":true}}}'` + `DOOMCRAFT_ADMIN_TOKEN=…`; the flag doc shape is
  `rules.<key>.force|rolloutBp`. `DOOMCRAFT_CONFIRM_DELAY_MS` shortens the C6 confirm in tests.

## 5. Blocked on the user, not on engineering

A domain · AdSense/GAM + a games ad network + a CMP (before any third-party tag) ·
WorkOS / Paddle / PostHog accounts · ElevenLabs key · legal review before real-money
prizes · Play Console $25 / Apple Developer $99 / Steamworks $100 · a Mac with Xcode ·
GTA mode has no obtainable bar. **And: sign into the Railway console and confirm you hold
the owner account** — first `/api/auth/signup` on the LIVE host takes the owner role, and
that seat is still unclaimed in production.
