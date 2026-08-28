# Doomcraft — handover: where it stands, and what is left

Written 2026-08-28, end of the THIRD session that day. This one shipped the whole
player-facing economy tier (Loadout, Trade, Competitions, Share — every flag
flipped and DURABLE on production), cosmetic crafting end to end, the Basic
Training tutorial episode, the console's Guides screen, Studio S2+S3, and the
VARIANTS.md scoping doc. The previous handovers are in git history at `108efa5`
(second 28th), `9da410b`, `bfdc647`, `557c7b6`. §0 is restated because it keeps
earning it — rule 14 is new and expensive.

**Live:**
- **https://doomcraft-production.up.railway.app** — the Node origin, build `f1b7193`:
  game, rooms, API, release tier, admin console at `/admin` (now with Studio S2/S3
  and a Guides screen). Railway project `doomcraft`, volume `/data`, writable.
- **The profile overlay is a four-tab economy surface** for every player:
  Overview (+ Share panel), Loadout (equip + craft), Trade (live escrow), 
  Competitions (Season 1 is running with a real prize table). Flags
  `economy_items`, `economy_scrap`, `economy_trading`, `economy_competitions`,
  `share_cards` are ALL ON and survive deploys (rule 14).
- **https://doomcraft.vercel.app** — static single-player, same bundle, now
  carrying the Basic Training episode (first in the picker, the fresh-save
  default). **github.com/pallefar/doomcraft** — `main`.
- Owner seat claimed and durable: `house:b4f3d3a327c021ea4d0a4728` / `karsten`,
  credentials in `~/youtube/doomcraft-owner-credentials.txt` (mode 600).
- CI: `tsc -b` + `vitest run` + `release:verify` on every push; all pushes green.
  Suite: **95 files / 2246 tests (+3 deliberate skips — campaign design
  invariants visibly skipped for tutorial drills)**.

Read this, then `docs/ECONOMY.md` (its "As built" notes now lag TWO sessions —
trading/competitions/share/crafting/equip are all BUILT), `docs/VARIANTS.md`
(new — the scoped variants arc), `docs/STUDIO.md`, `docs/PACKS.md`, `ref/BAR.md`.

---

## 0. The rules this project learned expensively. Do not relearn them.

1. **"It compiles and tests pass" is not evidence.** Demand an import trace PLUS a
   boot with a screenshot or a measurement. `client/src/ui/wiring.test.ts` fails
   the suite when a UI module ships to nobody.
2. **A green test that cannot fail is worse than no test.** Prove every regression
   test red with its fix reverted — and check WHAT goes red.
3. **Measure, don't eyeball.**
4. **The bar is real and fetchable** (`ref/`). The gauntlet is still **0/23**.
5. **`grep` silently skips `shared/src/flags.ts`** (NUL bytes). `grep -a`; edit
   with python, never sed. rg is NOT installed on this machine.
6. **Simulated-failure tests must pick platform-identical failure inputs.**
7. **A gate that verifies the wrong tree is worse than no gate.**
8. **Workflow/worktree agents check out HEAD** — commit first, then audit.
9. **`MemoryStore.load` returns the live object** — snapshot before mutating.
   **Vercel deploys from the REPO ROOT only.**
10. **Railway volume was root-owned and ate six days of writes silently.** Fixed +
    guarded: after ANY volume/deploy surgery, `curl /api/version | jq .data` must
    say `{"writable": true}`; verify deploys via `railway deployment list --json`
    newest == SUCCESS (build id and hostname prove nothing).
11. **A capture that cannot fail is rule 2 for screenshots.** When a screenshot is
    the proof, look at the screenshot.
12. **The admin console is TWO giant template literals** (`server/src/admin/
    console.ts`). No backticks, ever, in that file's embedded JS — and no `${`
    in static content.
13. **Two stores, two durability models: flush before you conclude.** Profile
    writes debounce ~800ms; service docs write synchronously. Cross-store
    settlement must `await store.flush()` BEFORE its doc says "done"
    (`server/src/trades.ts settle()` is the pattern).
14. New this session: **`FlagService` is IN-MEMORY. Every `/api/admin/flags` flip
    dies on the next restart or deploy** — the first economy flips silently
    reverted on the next `railway up`. Production durability = the Railway env
    `DOOMCRAFT_FLAGS`, which FULL-REPLACES the document at boot. Flip = update
    that env with the WHOLE intended document (today it forces the five economy
    flags; `online_play` is deliberately NOT forced — rooms routes are unflagged
    and multiplayer works without it). The console's Guides screen documents this.
15. **Menu-time flag bits lie.** On the menu, `game.net.flagBits` comes from the
    local Worker session, which can never carry the economy bits. Every menu-time
    surface gates on ONE cached GET of `/api/flags?device=` (`probeServerFlags`
    in `client/src/ui/loadoutTab.ts`); quest/horde end-of-match surfaces (always
    local-Worker sessions) do the same. A killed flag is false in both sources.
16. **Two adjacent CLEAR carves have no wall between them.** The tut-03 keycard
    bypass was caught by quest.test.ts's cannot-finish-without-the-card solver.
    Room rects that must be separate must not touch.

## 1. What the third 2026-08-28 session shipped (all pushed, green, deployed)

| Commit | What |
|---|---|
| `8b815b9` | **Loadout tab + POST /api/equip** — the claim half of §7 ownership (owned/not-revoked/kind-fits, both-or-nothing writes); tab strip in the profile overlay decided by the flags probe (rule 15); scrap balance panel gates on the server flag unless the player explicitly overrode the product toggle. |
| `dd97e13` | **Trade tab** — full escrow UI over `/api/trade/*`; 2.5s poll ONLY while visible (shown()/hidden() on every switch and close); HTTP 200 ≠ success — renders from `trade.state` + verbatim `note`; the confirm-reset is VISIBLE (a banner when the poll reveals your confirm vanished). Proof: two real browsers trade, offer-change mid-confirm, settle; inventories swap server-side. |
| `83ed716` | **Basic Training** — 3 tutorial drills as pure content (episodeIndex 0 = first + fresh-save default; secret-region lessons; works on the static build); `shared/src/tutorial.test.ts` holds drills STRICTER than the gate; campaign design invariants scoped to CAMPAIGN with visible skips. |
| `24ba858` | **Console Guides screen** — 8 static as-built operator walkthroughs (levels, items, flags incl. rule 14, competitions/creatives via curl — no tabs exist, referrals, merge undo), every dangerous step a red callout. |
| `4640303` | **Competitions tab** — seasons never show Enter (auto-enrol); entered-at-rank-0 is a normal state; standings highlight by the `you` boolean; proof harness creates a REAL tournament through the 428 confirm walk (create answers **201**). |
| `0469e88` | **Share button** — `client/src/ui/shareCard.ts`: fetch the server-drawn card, `navigator.share` with files, else download + the referral link note; mounted on quest intermission, horde run card, profile Overview (DM deferred — its scoreboard is pointer-events:none). Proof: finishes drill 1 by real input and verifies the downloaded 1200×630 PNG. |
| `8214d95` | **Cosmetic crafting** — `POST /api/craft`: 3 duplicates + Scrap fee → the CHOSEN same-kind next-rarity item (deterministic — no loot boxes); the journal's FIRST 'spend' emitter, idempotent on a client nonce; copies on a trade table are not material (`TradeService.reservedRefs`); craft picker in the Loadout tab; fees drift-guarded client↔server. |
| `d9a8544` | **docs/VARIANTS.md** — the variants arc scoped (see §3). |
| `91c177c` | **Studio S2** — `POST /api/admin/studio/level/preview`: top-down slice PNG at spawn walking height (pixel-proven); items palette swatches; campaign order editor writing JSON back. |
| `f1b7193` | **Studio S3** — `createDraft(ifRevision, DraftPicks)`: the expansion one-click — picked versions per data pack (refusal, never fallback) + the name on the draft; studio card with per-pack selects. |

## 2. Architecture delta

```
equip:     POST /api/equip                     {skin?, title?} claims; both-or-nothing
craft:     POST /api/craft                     {source, target, nonce}; journal 'spend'; TradeService.reservedRefs
tabs:      client/src/ui/{loadout,trade,competitions}{Model,Tab}.ts + profile.ts strip
share:     client/src/ui/shareCard.ts          probe-gated button for intermission/horde/profile
tutorial:  content/levels/tut-*.json + episodes.json 'tut' ep + shared/src/tutorial.test.ts
preview:   POST /api/admin/studio/level/preview  -> PNG (server/src/studioPreview.ts)
expansion: POST /api/admin/release {picks}     DraftPicks in server/src/packs.ts
flags:     Railway env DOOMCRAFT_FLAGS         THE durable document (rule 14)
harnesses: tools/shot-{loadout,trade,competitions,share,tutorial}.mjs + shot-console.mjs
```

## 3. What is left — decided order

1. **Studio S4 — the challenge engine** (docs/STUDIO.md §3): platform lane builds
   producers for `challengeIds` (the transport slot exists in entitlementGuard with
   ZERO producers), evaluation in the guard, journal rows; then the studio quest
   editor and `PackKind.QUESTS` gains its producer honestly. This also unlocks
   ECONOMY.md daily/weekly challenges.
2. **Sponsors phase 2** — interstitial/rewarded in `#ad-overlay` (constants exist),
   §3.5 metrics dashboard (`ads.jsonl` is the truth it renders).
3. **The variants arc, V1–V5** (docs/VARIANTS.md §5) — background, interleavable:
   V1 SessionArsenal seam (byte-identical proof) → V2 schema+pack+power-budget →
   V3 wire (new S2C opcode) → V4 slug shotgun/burst pistol + craft finish tier →
   V5 standing gate. Three §7 decisions wait on the user before V2.
4. **The gauntlet — 0/23.** Then portals/TWA (manifest still missing), C7 analytics.
5. **Deathmatch share surface** (deferred from 1d): needs its own #ui element —
   the scoreboard lives in pointer-events:none #hud.
6. **docs/ECONOMY.md "As built" refresh** — now lags two sessions.

## 4. Deploy runbook (follow exactly)

- **Vercel (static): from the REPO ROOT** — `npx vercel --prod --yes`. Never a worktree.
- **Railway (origin):** from a CLEAN WORKTREE at HEAD: `git worktree add <tmp> HEAD &&
  cd <tmp> && railway link --project doomcraft --service doomcraft && railway variables
  --set DOOMCRAFT_BUILD_ID=$(git rev-parse --short HEAD) && railway up --detach`.
- **Verify THREE things**: (1) `railway deployment list --json` newest == SUCCESS;
  (2) probe a route the new build ADDS; (3) `curl /api/version | jq .data` →
  `{"writable": true}`.
- **Flag changes**: update the Railway env `DOOMCRAFT_FLAGS` with the FULL document
  (rule 14) — currently:
  `{"rules":{"economy_scrap":{"force":true},"economy_items":{"force":true},"economy_trading":{"force":true},"economy_competitions":{"force":true},"share_cards":{"force":true}}}`
- Commit → push → redeploy at every green stage; full suite green before any commit.
- Local env for harnesses: `DOOMCRAFT_FLAGS` forcing what the stage needs +
  `DOOMCRAFT_STATIC=dist` (vite proxies only /ws and /rtc — /api needs the real
  server) + seeded profiles at `<data>/profiles/<id[0:2]>/<id>.json`; preset the
  browser device via localStorage `doomcraft:progress:device`.
- Proof harnesses: `tools/shot-loadout.mjs` (equip+craft), `shot-trade.mjs` (two
  browsers, full escrow), `shot-competitions.mjs`, `shot-share.mjs` (plays drill 1
  for real), `shot-tutorial.mjs`, `shot-console.mjs <tab>`, `shot-craft.mjs`,
  `capture-ours.mjs`.

## 5. Blocked on the user, not on engineering

A domain · AdSense/GAM + a games ad network + a CMP (before any third-party tag) ·
WorkOS / Paddle / PostHog accounts · ElevenLabs key · legal review before real-money
prizes · Play Console $25 / Apple Developer $99 / Steamworks $100 · a Mac with Xcode ·
GTA mode has no obtainable bar · **VARIANTS.md §7's three decisions** (power-budget
weights, variant rarity floor, competitive parity) before variants V2.
