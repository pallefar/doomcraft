# Doomcraft — handover: where it stands, and what is left

Written 2026-08-28, end of the second session that day. This one shipped the whole
economy tier server-side (trading, competitions, share cards), the Builder crafting
bench, the Quest pickup rendering fix, C6.1's operator debts — and found the
production data-loss bug that had been eating every durable write since the server
tier launched. The previous handover (sponsors 1b + C4–C6 + viral tier 1) is in git
history at `9da410b`; the ones before at `bfdc647` and `557c7b6`. §0 is restated
because it keeps earning it.

**Live:**
- **https://doomcraft-production.up.railway.app** — the Node origin: game, rooms, API,
  release tier, admin console at `/admin` (now also Referrals + the merges/undo table).
  Railway project `doomcraft`, volume `/data`.
- **DATA IS NOW ACTUALLY DURABLE.** Until 2026-08-28 ~12:45Z it was not — see §0 rule 10.
- **The production owner seat is CLAIMED and survives restarts**: account
  `house:b4f3d3a327c021ea4d0a4728`, name `karsten`. Passphrase + account id in
  `~/youtube/doomcraft-owner-credentials.txt` (outside the repo, mode 600).
- **https://doomcraft.vercel.app** — static single-player, same bundle.
  **https://doomcraft-site.vercel.app** — landing. **github.com/pallefar/doomcraft** — `main`.
- CI: `tsc -b` + `vitest run` + `release:verify` on every push; every push both
  2026-08-28 sessions green. Suite: **87 files / 2166 tests**.

Read this, then `docs/ECONOMY.md` (trading/competitions/share cards are BUILT — the
doc's "As built" notes lag one session), `docs/SPONSORS.md`, `docs/PLATFORM.md`,
`docs/STUDIO.md`, `ref/BAR.md`.

---

## 0. The rules this project learned expensively. Do not relearn them.

1. **"It compiles and tests pass" is not evidence.** Demand an import trace PLUS a boot
   with a screenshot or a measurement. `client/src/ui/wiring.test.ts` fails the suite
   when a UI module ships to nobody.
2. **A green test that cannot fail is worse than no test.** Prove every regression test
   red with its fix reverted — and check WHAT goes red. This session's proof: the first
   trade crash-replay test stayed green with the idempotency guard deleted; only
   rewriting it to replay against a stale doc made it bite.
3. **Measure, don't eyeball.**
4. **The bar is real and fetchable** (`ref/`). The gauntlet is still **0/23**.
5. **`grep` silently skips `shared/src/flags.ts`** (deliberate NUL bytes). `grep -a` or
   `rg`; edit that file with python, never sed.
6. **Simulated-failure tests must pick platform-identical failure inputs.**
7. **A gate that verifies the wrong tree is worse than no gate.**
8. **Workflow/worktree agents check out HEAD** — commit first, then audit.
9. **`MemoryStore.load` returns the live object** — snapshot before mutating anything
   loaded twice. **`git checkout -- file` after a mutation-proof discards real changes.**
   **Vercel deploys from the REPO ROOT only.**
10. New this session, the expensive one: **Railway mounted the volume root:root under
    the image's `USER node`, and every durable write from 2026-08-22 to 2026-08-28
    failed SILENTLY** — every store swallows its own write errors ("an unwritable doc
    must not break play"), and the locally-good reasons composed into a healthy-looking
    host that held everything in memory and lost it on each deploy. Fixed on the volume
    (`railway ssh -- chown node:node /data` — ssh runs as root; ownership persists) and
    guarded by a boot probe: **`curl /api/version | jq .data` must say
    `{"writable": true}` after ANY volume or deploy surgery.** Corollary: **verify a
    deploy is the new image via `railway deployment list --json` newest == SUCCESS** —
    `variables --set` alone restarts the OLD image with the new build id AND a new
    container hostname, so neither `/api/version`'s build id nor its host field proves
    anything.
11. **A capture that cannot fail is rule 2 for screenshots.** `tools/capture-ours.mjs`'s
    builder "palette" shot had been silently photographing an empty room: the desktop
    palette had a shipped bug where a keyboard B opened it AND latched a taken-tap that
    the next frame read as "close" — open for 3ms, proven with a MutationObserver on the
    panel's style. When a screenshot is the proof, look at the screenshot.
12. **The admin console is TWO giant template literals** (`server/src/admin/console.ts`:
    `ADMIN_CONSOLE_HTML` and the sign-in page from `adminSignInHtml()`). A backtick
    anywhere inside either — including a code comment — terminates the literal and the
    error points somewhere useless. No backticks, ever, in that file's embedded JS.
13. **Two stores, two durability models: flush before you conclude.** `JsonFileStore`
    debounces profile writes ~800ms while service docs (trades.json etc.) write
    synchronously — so any cross-store settlement must `await store.flush()` BEFORE its
    doc durably says "done", or a crash voids/half-applies what the doc claims finished.
    The trade escrow's barrier (`server/src/trades.ts` `settle()`) is the pattern.

## 1. What the second 2026-08-28 session shipped (all pushed, green, deployed)

| Commit | What |
|---|---|
| `7838e56` | **Trading** — `server/src/trades.ts` two-sided escrow: both confirms reset on ANY offer change; ACTIVE-state check at offer AND confirm (a mid-trade revocation cancels, never half-settles); 48h item cooldown that a traded copy re-enters; one copy never in two escrows; crash-recoverable settlement with `recover()` at boot. Routes `/api/trade/{open,join,offer,confirm,cancel,mine,state}`, gated per-caller on `economy_trading`. All three core rules mutation-proven. |
| `62a53cf` | **Trading hardening** after a 20-agent adversarial review workflow confirmed a real critical: 'settled' reached disk while inventories sat in the 800ms debounce. Now: `store.flush()` barrier before the doc leaves 'settling' (mutation-proven via a flush-probe store); settle refuses if the 'settling' record can't reach disk; per-side done-flags; `recover()` never throws and one wedged trade can't strand the rest; doc sanitised at load; 16-slot capacity margin + loud audit on truncation; junk refs refused not filtered. |
| `243619e` | **Competitions** — `server/src/competitions.ts` on the `onProfilePersisted` seam (zero room.ts changes). State-based ladder: points += min(xp − watermark, MATCH_XP_CAP) per sweep, excess FORGOTTEN — a mid-season merge smuggles at most one match's ceiling, once (mutation-proven). Seasons auto-roll (28d, top-10 scrap table); tournaments operator-created (creation confirm-gates — it writes the prize table the finaliser pays automatically) with `minLevel` entry rule. Prizes pay ONLY through the journal (new kind `'prize'`, sourceId `prize:<id>`) — a crash-replayed finalisation pays nobody twice (proven against a stale doc). Routes `/api/competitions{,/standings,/enter}` + admin create/cancel/list. Flag `economy_competitions` gates surfaces, never accrual. |
| `28a75d5` | **Quest pickups render** — authored ammo/keycards were invisible 1.35m trigger spheres. `LevelRuntime.pickupMarkers()` (world-space untaken set) → `Game.setGroundMarkers` seam → drawn in the existing actor batch, zero extra draw calls. Keycards = flat spinning card in `KEY_COLORS`; supplies = cubes in the arena pickup colours. Refreshed after placement and each take, never per frame. Proof: `shots/ours-quest-02-silhouette.png`. |
| `1a99fde` | **Builder crafting bench + the palette bug** — `shared/src/crafting.ts`: ten one-way refinement recipes (1 Wood→4 Planks … 2 Metal+1 Glass→2 Tech Panel), proven LOOP-FREE by search (no chain returns more of any block than consumed). `Inventory.craft` atomic; Craft chip in the palette, survival only. Fixed the rule-11 palette self-close. `tools/shot-craft.mjs` is the standing harness; proof `shots/craft-bench-*.png`. |
| `699c0b2` | **Share cards** — `server/src/shareCard.ts`: hand-written PNG encoder over `node:zlib` + a 5×7 pixel font (zero deps, voxel aesthetic). `GET /api/share/card` renders the caller's LAST paying round (`stats.last`, new on `StoredStats`, written by `applyMatchResult` with the amounts that LANDED) + referral code + `?ref=` URL. S36 proven at pixel level: a lockup changes no byte above the bottom 72px strip (11.4% < 12% cap); ad-free strip carries the house wordmark only. Flag `share_cards`. |
| `86fee83` | **C6.1** — `undoMerge` (`merge.ts`): restores B from the `merged/` archive, claws Scrap back through a journal pair idempotent on `undo:<eventId>` (crash-replay mutation-proven), un-sums archived contributions clamped at 0, detaches the device (`detachDeviceHoldingLock` — the primary can never detach). Shortfall documented, B still made whole. Routes `/api/admin/merge/undo` (confirm-gated) + `/api/admin/merges`. `reset-progress` player verb: archive-first or it REFUSES; journalled zeroing; identity stays. Console: Referrals screen (queue + approve via new generic `armRoute` confirm walk), merges/undo table, reset button; `MISSING_CAPABILITIES` trimmed again. `tools/shot-console.mjs` + `shots/console-*.png`. |
| `51e9e50` | **The writability probe** — boot writes `<dataRoot>/.writable`; failure screams on stderr with the fix spelled out and rides `/api/version` as `data.writable`. Proven over the real binary against a chmod-555 root. This is rule 10's guard. |

## 2. Architecture delta

```
trades:       <data>/trades.json + trades.jsonl   escrow rows; settle = snapshot → sides → store.flush() → settled
competitions: <data>/competitions.json + .jsonl   seasons auto-mint; entries carry {baseline, lastXp watermark, points}
share card:   GET /api/share/card                 stats.last (new) + referrals.codeFor → 1200×630 PNG, S36 strip
crafting:     shared/src/crafting.ts              CRAFT_RECIPES data; client-side bench over Builder survival stock
merge undo:   merged/<dev>-<event>.json + journal 'undo:<eventId>' pair; merge.jsonl gains state 'undone'
probe:        /api/version .data                  {writable, error} — read it after every deploy
```

`LEDGER_KINDS` gained `'prize'`. `StoredStats` gained `last` (LastMatch). Flags in
play (all default-off): `economy_trading`, `economy_competitions`, `share_cards`,
`economy_items`, `economy_scrap`.

## 3. What is left — decided order (user decisions 2026-08-28)

The user chose: **player-facing economy UI first**, **flags flip as each surface is
boot-proven** (not one big flip), and **weapon crafting = both tiers, cosmetic first,
variant engine as a background arc**.

1. **The economy surfaces, one stage per surface, flag flipped per stage:**
   a. **Loadout/inventory tab** — render `profile.inventory` against the live items
      pack (`itemStateFor`: active/dormant/revoked), equip skin/title (equipping is a
      claim; the renderer checks state). Flip `economy_items` (+ `economy_scrap` for
      the balance panel already built) when boot-proven.
   b. **Trade tab** — the escrow flow over `/api/trade/*`: open/share code, join,
      offer picker from inventory, the two confirms with the reset behaviour visible,
      outcome screen. Flip `economy_trading`.
   c. **Competitions tab** — `/api/competitions` overview, standings with your rank,
      tournament enter. Flip `economy_competitions`.
   d. **Share button** — end-of-match + profile: fetch `/api/share/card`, show it,
      native share/copy. Flip `share_cards`. (Online only — the static build has no
      server; the button hides there.)
2. **Cosmetic weapon crafting** (needs 1a): `POST /api/craft` — N duplicates + Scrap
   fee → next-rarity item through the journal (`'spend'` kind exists), idempotent on a
   client nonce; craft UI in the Loadout tab. This is ECONOMY.md's "crafting from
   Scrap + duplicates" sink and the user's "new weapons from existing ones" at the
   finish tier.
3. **The weapon-variant engine — background arc, start with a scoping doc** (
   `docs/VARIANTS.md`): data-driven stat tables on BOTH predictors, room pin, pack
   kind + ratchet plan, per `shared/src/items.ts` header and `docs/PACKS.md` §1.1.
   Real crafted weapons (slug shotgun etc.) land at the end of it.
4. **Studio S2–S4** (`docs/STUDIO.md` §3) — S2 in-panel level preview (the shareCard
   Raster/PNG path can render top-down slices server-side), S3 expansion one-click
   release, S4 challenge engine (also unlocks ECONOMY.md daily/weekly challenges).
5. **Sponsors phase 2** — interstitial/rewarded in `#ad-overlay` (constants exist),
   §3.5 metrics dashboard (`ads.jsonl` is the truth it renders).
6. **The gauntlet — 0/23.** Then portals/TWA (manifest still missing), C7 analytics.

## 4. Deploy runbook (follow exactly)

- **Vercel (static): from the REPO ROOT** — `npx vercel --prod --yes`. Never a worktree.
- **Railway (origin):** from a CLEAN WORKTREE at HEAD: `git worktree add <tmp> HEAD &&
  cd <tmp> && railway link --project doomcraft --service doomcraft && railway variables
  --set DOOMCRAFT_BUILD_ID=$(git rev-parse --short HEAD) && railway up --detach`.
- **Verify THREE things**: (1) `railway deployment list --json` newest == SUCCESS —
  build id and hostname prove nothing (rule 10); (2) probe a route the new build ADDS
  when there is one; (3) `curl /api/version | jq .data` → `{"writable": true}`.
- Commit → push → redeploy at every green stage; full suite green before any commit.
- Local env: `DOOMCRAFT_FLAGS='{"rules":{"online_play":{"force":true},"economy_trading":
  {"force":true},"economy_competitions":{"force":true},"share_cards":{"force":true}}}'`
  + `DOOMCRAFT_ADMIN_TOKEN=…`; `DOOMCRAFT_CONFIRM_DELAY_MS` shortens the C6 confirm.
- Proof harnesses: `tools/capture-ours.mjs --mode <m>`, `tools/shot-craft.mjs`,
  `tools/shot-console.mjs`.

## 5. Blocked on the user, not on engineering

A domain · AdSense/GAM + a games ad network + a CMP (before any third-party tag) ·
WorkOS / Paddle / PostHog accounts · ElevenLabs key · legal review before real-money
prizes · Play Console $25 / Apple Developer $99 / Steamworks $100 · a Mac with Xcode ·
GTA mode has no obtainable bar. The owner seat is no longer on this list — it is
claimed and durable.
