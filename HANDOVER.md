# Doomcraft — handover and plan for the next session

Written 2026-08-22. **Live at https://doomcraft.vercel.app** (static, single-player, $0).
~100k lines, 1462 tests green, `tsc -b` clean.

Read this, then `ref/BAR.md`, `docs/INFRASTRUCTURE.md`, `docs/ECONOMY.md`, `docs/SPONSORS.md`.

---

## 0. Start here — three things that will save you hours

**1. "It compiles and tests pass" is not evidence.** Five times on this project, code has been
written, typechecked, passed hundreds of tests, and been **imported by nothing**. The character
system (2,395 lines), the whole server tier, `ModeRouter`, and more. Every verifier prompt must
demand *an import traced from the live entry point* **plus** a screenshot or a measurement.

**2. A green test that cannot fail is worse than no test.** See `docs/BUGS-FOUND.md` §3: three
drafts of one regression test all passed **with the bug still in the tree**. Always prove a
regression test goes red — `git stash push <file>`, re-run, confirm failure, `git stash pop`. If it
cannot fail, say so and do not count it as coverage.

**3. The performance metrics lie unless you pick the right one.**
- Page-level `fps1pctLow` is **saturated at 53.5–53.8** in every configuration ever measured —
  headless and headed, 1× to 20× CPU throttle, 20 draw calls and 132. It is Chrome's rAF jitter
  floor. It cannot prove a win or catch a regression.
- `game.medianMs` times **only CPU submission** inside `renderer.render()`. It is structurally
  **blind to fragment-shader changes**. For those use `EXT_disjoint_timer_query_webgl2` with a
  pinned camera and a pixel sweep (ms/Mpx).
- `game.medianMs` tracks **draw calls**, not throttle: ~46 → 0.1 ms, ~124–132 → 0.9–1.0 ms. The real
  budget is **~120 draw calls**, and `drawCalls ≈ 1.85 × visibleChunks + 17.9` — it is nearly all
  terrain.

---

## 1. Immediate — finish what is in flight

**A workflow may still be running** (`doomcraft-defects`): three deploy gaps, the shotgun crack, the
silent multiplayer digging, and the Quest 404s. Check `/workflows`. If it died, resume from
`.../workflows/scripts/doomcraft-defects-wf_7ae4b4c9-c1c.js` (a fresh session must re-run from the
script path — `resumeFromRunId` is same-session only).

**Then the GitHub push, which is BLOCKED on a security step:**

```bash
cd /Users/karstenhaldan/youtube/doomcraft
git status --porcelain                 # must be clean for filter-branch
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --index-filter \
  'git rm -r --cached --ignore-unmatch tools/.profile-mc' --prune-empty -- --all
git log --all --oneline -- tools/.profile-mc | wc -l   # MUST be 0
git ls-files | grep -cF tools/.profile-mc              # MUST be 0
git remote add origin https://github.com/pallefar/doomcraft.git
git push -u origin main
```

`tools/.profile-mc/` was tracked — 298 files including `Default/Cookies`, `Default/Login Data`,
`Account Web Data`. It is out of the index and `.gitignore` now covers `tools/.profile-*/`, but it
is **still in 2 commits of history**. `pallefar/doomcraft` is **public and empty**. Do not push
before that count reads 0.

Everything else scanned clean: the "secret" grep hits are Doom level secrets; the user's email is in
no tracked file. Use `grep -F` for path searches — an unescaped `.` matched 298 wrong files here.

---

## 2. The plan — what is left, in the order I would do it

### Phase A · Economy (the user's item 5) — the biggest remaining chunk
Spec: `docs/ECONOMY.md`. Nothing is built. This is likely more code than everything so far.

Build in this order, because each depends on the last:
1. **Points** — two currencies. XP (monotonic, gates unlocks) + Scrap (spendable). **Server grants
   every reward; the client never does.** Anti-farm: per-match and per-day caps, diminishing
   returns, zero reward from a match joined after it is decided.
2. **Items** — weapon variants (sidegrades, never upgrades), skins as **palette + emissive mask, never
   new geometry or a new material** (a material per player is a draw call per player, and draw calls
   are the budget). Five rarity tiers. Titles and trophies are **untradable** — they are proof of
   achievement, so trading launders them.
3. **Trading** — two-sided escrow where **confirm resets whenever either offer changes** (that is the
   specific defence against the last-instant swap scam), atomic settlement, audit log, cooldowns,
   no trading for new accounts.
4. **Viral** — server-rendered share cards; referrals pay on **engagement, not signup** (rewarding
   signups is what makes a referral system a bot farm); fraud caps and a review queue ship *with* it.
5. **Competitions** — seasons, tournaments, prize claim. Default skill-based; **random draw behind an
   explicit per-event flag**, because the random element — not the prize value — is what makes a
   promotion a lottery. Real-money events refuse to open without jurisdiction allowlist, age floor,
   tax field and published rules.

Gate: cosmetics must not move `game.medianMs` or the draw-call count. Ship it **dark behind
`shared/src/features.ts`** and switch on via the admin toggle — that is what the flag system is for.

### Phase B · Sponsors and ads (item 6, revenue half)
Spec: `docs/SPONSORS.md` (1,389 lines, already decided — do not redesign it).
Phase-one slice it names: **S1 (three DOM slots) + S3 (mode-tile badge) + S4 (boot line) + S12
(intermission card)**, all zero in-game frame cost, plus `POST /api/ads/decide` and `/api/ads/event`,
the 2D viewability implementation, and the `/r/<clickId>` HMAC redirector.

Two hard constraints from that doc: the **1.5% screen-coverage floor** means in-world placements must
be authored at **16×8 m minimum** or the inventory is a rounding error; and 3D viewability is
**server-side reconstruction** from the yaw/pitch already on the wire — client-side WebGL2 occlusion
queries were measured and rejected (0.19 ms spike landing on the p99 tail).

**Before any third-party ad tag ships**, the static CSP is no longer adequate — see `docs/DEPLOY.md`.
Move to the Node origin with its nonce CSP, or isolate the ad frame to a separate origin.

### Phase C · Platform (item 6, tooling half)
Profile page, feedback, admin **UI** (only `/api/admin/drain` and `/api/admin/flags` exist today),
user management, billing, analytics. All picks are already decided in `docs/INFRASTRUCTURE.md` —
WorkOS AuthKit, Paddle as merchant of record, PostHog + self-hosted ClickHouse. **Buy, don't build.**

**My honest advice on ordering:** this phase mostly wants real players to be worth building. An admin
panel and analytics dashboard for a game with no users is premature. Economy changes what players do;
this measures it. If the user wants it earlier, that is their call.

### Phase D · Known defects and polish
- Integration test owed for `BUGS-FOUND.md` §3 (needs a real server with levels loaded).
- ~Half the Kenney outfits clash — Medic reads as a clown, Timber is a lumberjack in plaid. Fix is
  pipeline-side in `tools/build-character-atlas.mjs`: cut the roster to the ~7 military ones or
  re-tint toward ash/blood. Costs nothing at runtime and shrinks `cast.png`.
- `client/src/player/controller.ts` (630 lines) is dead code with a duplicate `STEP_SMOOTH_RATE`.
- Quest tile floor regressed 4.03 → 2.56 grey levels (seam strength was cut).
- Distant walls still flat past ~25 m.
- **Run the gauntlet.** `tools/gauntlet.js` works and is now genuinely blind, but the board still
  reads 0/23 — no piece has a clean admissible win yet.

### Blocked on the user, not on engineering
ElevenLabs API key · **GTA mode has no obtainable bar** (no browser-playable GTA found; do not fake
the comparison) · payment processor · ad network account · CDN origin · legal review for real-money
prizes.

---

## 3. Tooling invariants — do not break

`playwright@1.62.1` is a required root devDependency; it is the measuring apparatus.
`tools/`: `capture-ref.mjs` (voxiom, **headed only** — Cloudflare blocks headless), `capture-doom.mjs`
(**the webm has NO audio track** — `canvas.captureStream()` is video-only; decode DMX lumps from
`DOOM1.WAD` via `wad2wav.mjs` instead), `capture-ours.mjs`, `reccanvas.mjs`, `strip.mjs`,
`blind.mjs`, `bw-verify.mjs`, `gauntlet.js`, `progress/build.mjs`.

Deploy: `npx vercel --prod --yes`. Preview URLs sit behind Vercel's login wall — verify production.
`.vercelignore` is mandatory (first attempt uploaded 1.7 GB) but **must not ignore `shared/`**.
`buildCommand` is `vite build` only — `tsc -b` fails there because the root tsconfig references
`server/`.

Live progress page: https://claude.ai/code/artifact/7fc179b3-ad71-4681-ad40-38f20e75f672
(`node progress/build.mjs`, then republish the same file path).
