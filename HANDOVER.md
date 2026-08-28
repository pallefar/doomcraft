# Doomcraft — handover: where it stands, and what is left

Written 2026-08-28, end of the session that shipped the content-pack machine, the release
console, items, the Creator Studio and the ad pipeline's phase one. The previous handover
(2026-08-22, the server tier + accounts) is in git history at `0bb98bb..557c7b6` — its §0 rules
are restated below because they keep earning it.

**Live:**
- **https://doomcraft-production.up.railway.app** — the Node origin at build `09a0257`: game,
  rooms, API, the release tier (`/api/version` → `release.packs`, six packs, `unsatisfied []`),
  the admin console at `/admin` (now with Inventory / Review / History / **Studio** screens).
  Railway project `doomcraft`, volume at `/data`, `DOOMCRAFT_PACKS=/data/packs`.
- **https://doomcraft.vercel.app** — static single-player, same bundle, menu recentered.
- **https://doomcraft-site.vercel.app** — the landing page. **https://github.com/pallefar/doomcraft** — `main`.
- **CI exists now** (`.github/workflows/ci.yml`): `tsc -b` + `vitest run` + `release:verify` on
  every push. Every push this session is green. Suite: **73 files / 2053 tests**.

Read this, then `docs/PACKS.md` (phases 0–3 DONE, status notes inline), `docs/STUDIO.md`,
`docs/SPONSORS.md`, `docs/ECONOMY.md`, `docs/PLATFORM.md` §12, `ref/BAR.md`. All decision
records: options are marked SHIP / LATER / REJECTED with what killed the rejected ones.

---

## 0. The rules this project learned expensively. Do not relearn them.

1. **"It compiles and tests pass" is not evidence.** Demand an import trace from
   `server/src/index.ts` or `client/src/main.ts` PLUS a screenshot or a measurement.
   `client/src/ui/wiring.test.ts` fails the suite when a UI module ships to nobody.
2. **A green test that cannot fail is worse than no test.** Prove every regression test red with
   its fix reverted. The phase-1 audit red-proved all seven pack ratchets this way.
3. **Measure, don't eyeball.** The menu "slightly off to the left" turned out to be two stacked
   faults (asymmetric ad-rail padding AND a component sized in viewport units that `safe center`
   then left-pinned) — found by measuring element centers in the page, fixed to delta 0px.
4. **The bar is real and fetchable** (voxiom, DOOM 1993, Minecraft Classic, in `ref/`). Compare
   against the artefact. The gauntlet is still **0/23** — no piece has won a blind A/B.
5. **`grep` silently skips `shared/src/flags.ts`** (deliberate NUL bytes). Use `grep -a` or `rg`,
   and edit that file with python, never sed.
6. **Simulated-failure tests must pick platform-identical failure inputs.** The first CI run ever
   caught `/proc/definitely-not-writable` hanging on Linux; an unwritable root is now a path
   under a regular file (ENOTDIR everywhere).
7. **A gate that verifies the wrong tree is worse than no gate.** `release:verify` refuses to run
   when `@doomcraft/shared` resolves outside the repo (a worktree without its own `npm install`
   silently audits the MAIN checkout — this bit the audit's first red-proof).
8. **Workflow/worktree agents check out HEAD**: uncommitted changes are invisible to them. Commit
   first, then audit.

---

## 1. What this session shipped (all pushed, all green, all deployed)

| Commit | What |
|---|---|
| `895442c` + `381edea` | **PACKS phase 1** — per-pack content identity (core/weapons/characters/levels/campaign), checked-in fingerprints AND input literals (a firing ratchet prints a line diff), `npm run release:verify` (12→13 checks, each proven refusable), first CI. Audit found 2 real gate-vs-loader bugs; fixed with the audit's own inputs as regression tests. |
| `c4f57da` | **PACKS phase 2** — `server/src/packs.ts`: `PackInventory` (versioned dirs under `DOOMCRAFT_PACKS/<key>/<v>/`, `content/` fallback as v1, frozen version-bound room views) + `ReleaseService` (durable CAS document, §5 state machine, `release.jsonl`, D6 history cap that trims the rollback chain at its deepest ancestor). Factory resolves per room with `randomBytes` instance ids. Eight audited routes under `/api/admin/release*`, proven over HTTP. |
| `b3d9535` | **PACKS phase 3** — Inventory / Review / History screens in the existing console; approve enforced server-side; screenshot-verified on a booted host. |
| `85e2b0e` | **Items as a content pack** — `PackKind.ITEMS` producer (`shared/src/items.ts` + `content/items.json`, 11 starters), `PERSIST_VERSION` 4→5 in ONE bump (inventory + C6's `moderation` + `ageBand`), server-rolled drops inside the payout's idempotency lock (dark behind `economy_items`), `/api/items`, item state DERIVED from the live release (§7: rollback recomputes ownership, writes nothing), `items.dormanted` gate count. |
| `3ee6d25` | Menu centered on the true centerline (≥1360px), measured delta 0px. |
| `29e135d` | **Creator Studio** (`docs/STUDIO.md` + Studio screen + `server/src/studio.ts`): levels / campaign / items authored in the panel → validated with the REAL gate checks → NEW immutable pack version on the volume → still walks the release machine. Weapons/characters save as **drafts** under `DOOMCRAFT_DATA/studio/` for the platform lane (build-class). PACKS §9 "no upload path" REVISED in writing for the operator-only case. |
| `09a0257` | **Ad pipeline phase 1a** (`docs/SPONSORS.md`) — `shared/src/sponsor.ts` (§2.1 verbatim), `server/src/ads.ts` (fail-closed cascade, single-use nonces, `ads.jsonl`, `/r/<clickId>` redirector with Gates 1/2/4), `client/src/ads/` (§3.2 MRC meter — pure state machine + IO wiring — and the menu-entry pipeline; inert without server + `sponsor_slots` flag). |

Operational fix: `DOOMCRAFT_BUILD_ID` was a static Railway var no deploy updated — `/api/version`
lied about the build. The deploy runbook (§4) now stamps it per deploy.

## 2. Architecture delta since 2026-08-22

```
DOOMCRAFT_PACKS=/data/packs        versioned data packs: levels/<v>/ campaign/<v>/ items/<v>/
DOOMCRAFT_DATA=/data               + releases.json, release.jsonl, ads.jsonl, sponsors.json, studio/ drafts
factory: roomInstanceId ─► releases.resolveFor() ─► Room pins {ordinal, packSetHash, viewFor(release)}
console: Inventory | Review | History | Studio | Flags   (all same-origin, AdminGate, audited)
ads: decide ─► fill+nonce ─► client §3.2 meter ─► /api/ads/event ─► ads.jsonl; click = GET /r/<id>
```

`PERSIST_VERSION = 5`. `FLAG_ORDER` gained `economy_items` (bit 10). The character look table
lives in `shared/src/characters.ts` (client registry re-exports it) so the server can recompute
its pack fingerprint.

---

## 3. What is left — in the order I would do it

1. **Sponsors phase 1b — the three first-party surfaces.** S3 mode-tile badge
   (`client/src/ui/modeSelect.ts`, `.dcm-ribbon` precedent), S4 boot line (text-only, the
   `.boot-tip`), S12 intermission card (`QuestIntermission` + deathmatch `Scoreboard`). All fed
   from `/api/ads/decide` (surfaces are already in `PHASE_ONE_SURFACES`), all in `#ui` so
   blockers don't touch them, all dark behind `sponsor_slots`. The decide/event/measure plumbing
   is DONE — this is rendering plus two decide calls at the right moments.
2. **Sponsors §2.2 — the asset pipeline.** Content-addressed creative storage
   (`/cdn/crv/<sha256>.<ext>`), upload via admin route (operator-only, Rule B), image campaigns
   stop being skipped in `server/src/ads.ts:decideOne` (the skip logs "needs the asset pipeline").
   Then the S1 slots can serve real display creatives.
3. **Platform C4** (`docs/PLATFORM.md`) — accounts on the socket (`?ticket=` replacing
   `?device=`) and the `dc_dev` httpOnly cookie. Today a returning Safari player loses everything
   on day 8 to ITP. `/api/auth/*` exists server-side; the game bundle has NO caller yet.
4. **Platform C5** — device→account merge, specified to implementation in PLATFORM §3 (day
   buckets are *max*, XP sums, Scrap must equal Σ journal).
5. **Platform C6** — user management UI on the console. The v5 schema fields (`moderation`,
   `ageBand`) ALREADY EXIST from `85e2b0e`; this is routes + screens (ban/suspend/refund/currency
   adjust/item revoke — revoke writes `moderation.revokedItems`, the only written item state).
6. **Viral tier 1** (previous handover §3.8, still exact): referral codes, `?ref=` attribution
   (first wins, forever), conversion on ENGAGEMENT (30 min paid play or level 5), journal rows
   `kind:'referral'` idempotent on the referred device, caps + review queue WITH the feature.
   Then server-rendered share cards. Tier 2 (cash) stays blocked on Paddle + legal.
7. **Trading + competitions** (`docs/ECONOMY.md`) — two-sided escrow (confirm resets on any
   change, ACTIVE-state check at offer AND confirm), seasons/tournaments. Items and the journal
   exist; this is the exchange and the calendar.
8. **Studio S2–S4** (`docs/STUDIO.md` §3) — level preview render, expansion one-click release,
   and the challenge engine (platform lane) that unlocks quest packs + `PackKind.QUESTS`.
9. **The gauntlet — 0/23.** Real remaining work, not a formality. `tools/gauntlet.js` is blind
   and honest; the three bars are on disk.
10. **Portals + app stores** (previous handover §4, unchanged and still accurate): Poki/
    CrazyGames first (needs `frame-ancestors` allow-list per portal), then the TWA (needs a web
    app manifest — still missing), then iOS.

## 4. Deploy runbook (follow exactly)

- **Vercel (static):** `npx vercel --prod --yes` from the repo root.
- **Railway (origin):** from a CLEAN WORKTREE at HEAD (`railway up` uploads the directory, not
  the commit): `git worktree add <tmp> HEAD && cd <tmp> && railway link --project doomcraft
  --service doomcraft && railway variables --set DOOMCRAFT_BUILD_ID=$(git rev-parse --short
  HEAD) && railway up --detach`. Verify: `/api/version` → `build.id` equals the commit and
  `release.unsatisfied` is `[]`. `railway logs --build` explains failures.
- Commit → push → redeploy **at every green stage**; the full suite green before any commit.

## 5. Blocked on the user, not on engineering

A domain · AdSense/GAM + a games ad network + a CMP (before any third-party tag) · WorkOS /
Paddle / PostHog accounts · ElevenLabs key · legal review before real-money prizes · Play
Console $25 / Apple Developer $99 / Steamworks $100 · a Mac with Xcode for iOS · GTA mode has no
obtainable bar. **And: sign into the Railway console and confirm you hold the owner account.**
