# Doomcraft — handover: where it stands, and what is left to go fully to market

Written 2026-08-22, end of the session that deployed the server tier.

**Live:**
- **https://doomcraft-production.up.railway.app** — the Node origin: the game (online, with bots and
  real multiplayer), the rooms, the API, and the admin console at `/admin`. Railway project
  `doomcraft`, service `doomcraft`, volume at `/data`.
- **https://doomcraft.vercel.app** — the static single-player build. Still honest, still $0.
- **https://github.com/pallefar/doomcraft** — `main`, pushed at every stage of this session.
- **https://doomcraft-site.vercel.app** — the landing page (own Vercel project `doomcraft-site`,
  source in `doomcraft-site/`): "Play now" → the Railway origin, "Play offline" → the static build.
- Live progress page: https://claude.ai/code/artifact/7fc179b3-ad71-4681-ad40-38f20e75f672

Read this, then `docs/PLATFORM.md`, `docs/PACKS.md`, `docs/ECONOMY.md`, `docs/SPONSORS.md`,
`docs/INFRASTRUCTURE.md`, `ref/BAR.md`. Every one of them is a decision record — options are marked
SHIP / LATER / REJECTED with what killed the rejected ones — not a wish list.

---

## 0. The four rules this project learned expensively. Do not relearn them.

1. **"It compiles and tests pass" is not evidence.** *Seven* features in this repo were written,
   typechecked, passed hundreds of tests, and were imported by **nothing** — the whole reward trust
   boundary (`shared/src/trust.ts` + `server/src/entitlementGuard.ts`, 1,766 lines) among them. Every
   verifier must demand an import traced from `server/src/index.ts` or `client/src/main.ts` **plus** a
   screenshot or a measurement. `client/src/ui/wiring.test.ts` now fails the suite when a UI module ships
   to nobody; `KNOWN_UNWIRED` names the two deliberate exceptions.
2. **A green test that cannot fail is worse than no test.** This session found one in
   `server/src/csp.test.ts` named *"refuses xp the client posted for itself"* — green while
   `{"__proto__":{"progress":{"xp":1e9}}}` landed 1e9 XP. Prove every regression test red with its fix
   reverted. And ask of every security test: *what is the nearest variant of the bug it would not catch?*
3. **Page-level fps is saturated at 53.8 and `game.medianMs` is blind to fragment shaders.** `drawCalls`
   is noise at 21–144 across identical runs. The fields with signal in `shots/ours-metrics.json` are
   `bytes`, `consoleErrors`, `pageErrors`, `game.medianMs`. See §0 of the previous handover in git history.
4. **The bar is real and fetchable** — voxiom.io, DOOM 1993, Minecraft Classic, captured in `ref/`.
   Compare against the artefact, never a description of it.

Plus one operational rule from today: **`grep` silently skips `shared/src/flags.ts`** if it carries raw
NUL bytes (they were deliberate hash separators). Use `grep -a` or `rg` in `shared/`. If that file ever
regresses to literal `\x00`, fix it to `\u0000` (a literal NUL byte) before trusting any grep over it.

---

## 1. What this session shipped (all pushed, all deployed)

| Commit | What | Proof |
|---|---|---|
| `375e8f1` | **The reward spine.** `EntitlementGuard`/`SessionLedger` wired into every live room. One ledger session per round. Found and closed a live double-pay (quit during the 8 s end screen = paid twice) and a store race that erased finished matches. | `server/src/economy.test.ts`; `online.test.ts` plays a real socket through the real binary and reads XP back over HTTP |
| `56c71cb` | **Scrap**, server-granted only. `PERSIST_VERSION` 3→4, `StoredEconomy`, `MatchResult.scrap` required. | v3→v4 fixture + v4 round-trip tests (the round-trip is the one that catches the forgotten whitelist literal) |
| `cfda9e4` | **Anti-farm**: per-match caps, UTC day caps, diminishing returns ladder, late-join lockout, 30 s floor, idle detection (zero kills/deaths/damage/blocks = zero pay). | each rule red-first; the day-cap invariant holds across a 10k-match sim |
| `41d4a94` | **Client surfaces**, dark: `Feature.ECONOMY` (default off) + server kill switch `economy_scrap`; `S2C.MATCH_AWARD = 12` (no protocol bump, fingerprint unchanged); HUD chips; Quest intermission rows; DM scoreboard line. | flag-off/flag-on screenshot pair; +2503 B first-load |
| `c9a1e21` | `docs/PACKS.md`, `docs/PLATFORM.md` | — |
| `42371e9` | **Five live security holes closed**: `__proto__` past `guardProfileWrite`; unlocked cache writer in `JsonFileStore.load`; `Math.random()` account secrets (the same PRNG seeded rooms and was broadcast in `WELCOME`); `POST /api/account/link` handing any caller a credential for any device — **deleted**; `/api/status` leaking private join codes; admin bearer length oracle. | each exploit re-run against the real binary before/after |
| `7ae627b` | **PACKS phase 0**: `/api/version` folds level hashes (two hosts one byte apart now differ); `GET /api/levels` mounted (it was written, tested, and unreachable); flag freeze is a merge + CAS 409, not a wipe; the client refuses a blit when the room's level bytes are not its own. | `deploy.test.ts` one-byte test; `{"revision":9,"frozen":true}` leaves rules intact |
| `bb98758` | **The reward journal**: append-only NDJSON beside the profile store, written under the same per-device lock that moves the balance, idempotent on `(kind, sourceId)`, `balanceAfter` per row. | Σ delta == balance across 10k matches incl. day-cap clamps |
| `c173f68` | **The player profile overlay** (client-only, on the static site too) + `wiring.test.ts`. | screenshot; ratchet proven red against an orphan |
| `f0824bd` | **The admin console** at `/admin` on the Node origin, 404 without `DOOMCRAFT_ADMIN_TOKEN`, never in the game bundle. Flags (registry read at runtime, freeze-all + per-flag force/rollout with typed-subject confirm and the blast radius quoted verbatim), fleet, entitlement ring (device ids redacted), journal, player lookup. `applyServerFlags` finally called — the `Feature` and `FLAG_ORDER` namespaces had never met. | boot + curl; server-side mutation guards tested by calling the routes directly |
| `609ba72` | Dockerfile: Railway refuses `VOLUME`. | deployed |
| `440e968` | **Accounts, and the console became ownable.** `server/src/accounts.ts`: scrypt (N=2^15, `node:crypto`, no new dependency) passphrases, `accounts-v1.json` written tmp+rename, in-memory sessions on an httpOnly+Secure+SameSite=Lax `dc_sess` cookie, and **the first account created becomes the owner** under the store's write lock. `AdminGate` now admits the env bearer (root) **or** an owner session; a player session gets 403 from `GET /admin` and from every `/api/admin/*`. `POST /api/admin/owner/transfer` is the safety net for the bootstrap window and takes the **env bearer only**. | two concurrent signups proven to yield two owners without the lock; full curl flow against the real binary on a spare port; a live scan of every auth and admin body for the on-disk `passHash` |

Suite: 53 files / 1562 tests at `41d4a94` → **64 / 1944** at the end. `tsc -b` clean throughout.

### 1.1 Session outcome

- **Suite: 64 files / 1944 tests, all green; `tsc -b` clean.** Every commit in the table was green on its own, verified by an auditor in a clean worktree per commit.
- **S5 landed and was attacked** (`440e968`, then `49fc3da` + the commit after it): the owner-bootstrap race was proven to yield two owners without the lock and one with it; 105 surgical reverts showed every new test red; the auditor found four real holes — a player cookie skipped the admin throttle, `/api/auth/signup` accepted a cross-site `text/plain` form (a remote owner-claim by CSRF), an unreadable accounts file re-opened the bootstrap window, and the auth-throttle sweep was unwired. **All four are closed, each red-first.**
- **Railway is running the final commit.** `GET /admin` with no session is the sign-in page (200); with a player session 403; 404 only when there is neither an env token nor an owner.
- **The landing site is live: https://doomcraft-site.vercel.app** — static, own Vercel project, `script-src 'none'`, a "Play now" CTA to the online build and "Play offline" to the static one. Honest copy: what is real, what is not yet.
- **Known, deliberately left:** `wiring.test.ts` guards `client/src/ui/` only (an orphan one directory deeper is invisible — the auditor planted four and 1855 tests stayed green); eight pre-existing unreachable modules totalling 5,052 lines, the worst `server/src/deathmatch.ts` (1,135 lines, and it has already drifted from the client copy); the journal's added lock-hold latency is stated, not measured; `linkDevice`'s route test is vacuous (production verified working by hand); the `/api/auth/*` surface has no caller in the game bundle yet — the game's account panel is PLATFORM C4.

---

## 2. The architecture you are inheriting, in one screen

```
browser ──(static, offline)──► doomcraft.vercel.app        single-player, Worker-hosted Room, pays nothing (trust table)
browser ──(same origin)──────► doomcraft-production.up.railway.app
                                 ├─ GET /            the same bundle + <meta name="doomcraft-server" content="self">
                                 ├─ /ws              rooms (authoritative sim, bots, 20 Hz)
                                 ├─ /api/*           profile (guarded), levels, status, version, flags, auth/*
                                 ├─ /api/admin/*     env bearer OR owner session; audit row per mutation
                                 └─ /admin           sign-in page → the console; 403 to a player; 404 only with no token AND no owner
                                 /data               JsonFileStore: profiles, accounts, journal, audit  (Railway volume)
```

Three version axes (`docs/PATCHING.md`): `PROTOCOL_VERSION` (window), `CONTENT_VERSION` (per-room pin —
**gates nothing today**, see PACKS §0), `BUILD_ID` (telemetry). Two flag systems: `shared/src/flags.ts`
(server-resolved, in-band on `SESSION_CONFIG`, the real one) and `shared/src/features.ts` (localStorage
product gate, now mapped onto the server's bits). The server grants every reward; the client never does;
`docs/ECONOMY.md` decision 1 is enforced in code, not documented and hoped for.

---

## 3. What is left to go fully to market — in the order I would do it

### 3.1 This week — make what is deployed safe to leave running
1. **Sign up first.** The first account created on the Railway origin becomes the owner. Until you do,
   anyone who finds the URL could. If someone beats you: `POST /api/admin/owner/transfer {name}` with
   the env bearer re-assigns it. The bearer is in the Railway dashboard and nowhere else.
2. **Back up `/data`.** It is one Railway volume. Railway has volume backups; turn them on. Without it a
   volume loss is every profile, every balance, every journal row.
3. **Watch `/api/status`** — `entitlement.violations` is the number worth an alert. There is no alerting.
4. **Sessions do not survive a restart** (in-memory by design). Fine for one operator; say so if it ever
   surprises you.
5. **A domain.** `up.railway.app` is fine to test; it is not a product. A domain unlocks: the console on
   `admin.<domain>`, cookies with a real scope, the CSP `connect-src` story in `docs/PACKS.md` §0.3.

### 3.2 Phase A — the rest of the economy (`docs/ECONOMY.md`), now through packs
The spine, Scrap, anti-farm and the journal exist. **Not built:** items (weapon sidegrades, skins as
palette + emissive mask, emblems, trails, titles, trophies), trading (two-sided escrow where confirm
resets on any change), viral (server-rendered share cards; referral pays on engagement not signup),
competitions (seasons, tournaments, prize claim; random draw behind an explicit per-event flag).
**Order changed this session:** items are content, so build `docs/PACKS.md` phases 1–2 first (pack
identity + the server reading a release) and ship items *as a pack*. Otherwise you build the shipping
pipeline twice. `docs/PACKS.md` §7 already states the ownership rule for items under rollback.

### 3.3 Phase B — sponsors and ads (`docs/SPONSORS.md`, 1,452 lines, decided)
Phase-one slice: S1 (three DOM slots) + S3 (mode-tile badge) + S4 (boot line) + S12 (intermission
card), `POST /api/ads/decide` + `/api/ads/event`, 2D viewability, the `/r/<clickId>` HMAC redirector.
Zero in-game frame cost by construction. **Blocked on the user:** an AdSense/GAM account and a games
network (AdInPlay is what the bar uses) — and **a CMP before any third-party tag**. The nonce CSP is
now live on the Node origin, which was the prerequisite.

### 3.4 Phase C — the platform (`docs/PLATFORM.md` §12)
C0–C3 done this session. Left: **C4** accounts on the socket (`?ticket=` replacing `?device=`; the
`dc_dev` httpOnly cookie — today a returning Safari player loses everything on day 8 to ITP), **C5 the
device→account merge** (specified to implementation in §3 of that doc — day buckets are *max*, never
sum; XP sums; Scrap must equal Σ journal), **C6** user management (ban/suspend/refund/currency adjust
— needs `PERSIST_VERSION` 5 with `moderation` + `ageBand` in one bump), **C7** house analytics
(aggregate `match_end` with no player id — the only event that is outside the consent question by
construction), **C8** the vendors: WorkOS AuthKit, Paddle as merchant of record, PostHog — **the only
phase blocked on the user creating accounts.** Buy, don't build.

### 3.5 Phase D — the packs and the release console (`docs/PACKS.md` §11)
Phase 0 done. **Phase 1 (1 week, no infra)**: `shared/src/packs.ts`, per-pack fingerprints,
`npm run release:verify` — *the first thing in this repo that can refuse a change without a human
choosing to be refused.* There is no CI; `.github/workflows/ci.yml` running `tsc -b` + `vitest run` +
`release:verify` is one file and it does not exist. **Phase 2–3**: the server reads a release, the
console reviews and promotes it. **Phase 4**: levels leave the bundle (−43 KB gz; they are currently
shipped *twice*). Maps as a pack were **rejected** with the number (~11 MB per arena).

### 3.6 Phase E — the gauntlet is still 0/23
`tools/gauntlet.js` is blind and honest, and no piece has yet won an admissible comparison against the
bar. Five economy pieces are on the board with no brief. **This is real remaining work, not a
formality**, and the three bars are on disk so a critic can still do a real A/B.

### 3.8 Viral sharing and an affiliate programme — so people promote it and can make money
Requested at the end of this session. Nothing is built; this is the design, and it is deliberately in
two tiers because the second carries legal and tax load the first does not.

**What already exists to build on:** the reward journal (`server/src/journal.ts` — append-only,
idempotent on `(kind, sourceId)`, `balanceAfter` per row) is the ledger every payout needs; the
entitlement guard grants rewards server-side only; `docs/ECONOMY.md` "Viral sharing" already decides
the rules — *referrals pay on engagement, never on signup* (rewarding signups is what makes a referral
system a bot farm), share cards are server-rendered from match data so they cannot be faked, and fraud
caps + a review queue ship *with* the feature; `docs/SPONSORS.md` §4.5 has the HMAC `/r/<clickId>`
redirector and the 7-day-click / 1-day-view attribution window, both of which transfer unchanged.

**Tier 1 — in-game rewards for everyone (ship first; no money, no legal load).**
- Every account gets a referral code; `?ref=<code>` on the landing site and the share card. Attribution
  is server-recorded at first connect and stored on the referred player's profile (one referrer, forever,
  first wins).
- **Conversion = engagement, not signup:** the referred player reaches a threshold the server has
  measured itself — e.g. 30 minutes of *paid* play per the anti-farm rules, or level 5. On conversion
  both sides get Scrap + an untradable "Recruiter" title tier, written through the journal with
  `kind: 'referral'`, `sourceId: <referredDeviceId>` (so it can never pay twice).
- "Beat my time" challenge links for Quest drop the recipient into the same level with the sender's
  ghost time — the highest-intent share there is.
- Caps per account per day, self-referral detection (same device id, same account, same IP block
  within the window), and a review queue in the console. **The cap and the queue are part of tier 1,
  not after it.**

**Tier 2 — cash affiliates (revenue share; needs a payout provider, tax handling and an agreement).**
- Model: a revenue share on what the *referred* player actually generates — ad revenue attributed per
  player (the sponsor event log + the ads decide/event pipeline in `SPONSORS.md` give per-player
  impressions) and IAP net of the store's cut — e.g. 20% for 12 months, paid monthly above a $25
  threshold. Never a CPA bounty on signups; never a flat per-referral fee (both are bot magnets).
- The journal gains `kind: 'affiliate_accrual'` and `kind: 'affiliate_payout'`; balances reconcile to
  Σ delta exactly as Scrap does today; clawback rows on refunds/chargebacks within the attribution
  window. Payouts via the merchant of record's payout rail (Paddle) or PayPal Payouts — **blocked on
  the user's account**, like every other vendor.
- Compliance that cannot be skipped: an affiliate agreement and published terms; KYC + tax forms
  (W-9 / W-8BEN in the US, equivalents elsewhere) above the reporting thresholds; the FTC disclosure
  rule for promoters (`#ad` / "I earn a commission"); GDPR basis for storing attribution; and a
  **fraud model before the first dollar** — device/IP clustering, velocity, conversion-rate outliers,
  manual review for the top payouts, and the ability to hold a payout.
- The affiliate dashboard is a **tab in the existing admin/owner console first** (read-only: clicks,
  conversions, accruals per code) and a self-serve page second.

**Build order:** tier 1 referral codes + attribution + journal rows (server) → share cards (server-
rendered PNG from match data; `SPONSORS.md` S36 reserves the lockup rules) → landing-site `?ref=` and
the "Recruiter" titles → the review queue in the console → *then* tier 2 behind the payout provider.
Every payout path goes through `EntitlementGuard` and the journal; the client never computes a
referral reward, ever.

### 3.7 Known defects, unfixed, filed
`docs/BUGS-FOUND.md` §4: Builder/Horde rooms hit `endRound('time')` after 8 min and regenerate the
world (idle farming is refused; the timer is not). Quest tile floor regressed 4.03→2.56 grey levels.
Distant walls flat past ~25 m. Half the Kenney outfits clash (pipeline fix in
`tools/build-character-atlas.mjs`). `client/src/player/controller.ts` is dead code. GTA mode has **no
obtainable bar** — do not fake the comparison.

---

## 4. Getting on the app stores — what is actually involved

Be clear-eyed about what this is: a **browser WebGL FPS with ads and a $4.99 IAP**. The stores that
matter most for that are not Apple and Google first.

### 4.1 The natural distribution first: web game portals
**Poki, CrazyGames, itch.io, Newgrounds** are where voxiom-class games live. They bring the audience
*and* the ad network (CrazyGames and Poki each have their own SDK that replaces AdSense for the menu
slots and adds rewarded video). `docs/SPONSORS.md`'s `SponsorProvider` interface is exactly the seam a
portal SDK plugs into. Requirements are mechanical: a single-origin build (done), no external scripts
they have not approved (done — the bundle is the only network dependency), a playable-in-iframe mode
(**`frame-ancestors 'none'` / `X-Frame-Options: DENY` must become an allow-list of portal origins**),
their SDK for ads, and — for Poki/CrazyGames — an editorial review. **This is the cheapest, highest-
leverage store.** Do it before either app store.

### 4.2 Google Play — a Trusted Web Activity
A TWA wraps the live URL in a Chrome-rendered activity; WebGL performance is the browser's. Needs:
- **A web app manifest. There is none** (`client/public/` has `sw.js` and assets only). `name`,
  `icons` (192/512 maskable), `start_url`, `display: fullscreen`, `orientation: any` (we play portrait
  — bar weakness #8), `theme_color`. One file, plus `<link rel="manifest">` in `index.html`.
- Digital Asset Links (`/.well-known/assetlinks.json`) on the **origin you ship** — a domain, not
  `up.railway.app` ideally.
- **Bubblewrap** or **PWABuilder** to generate the Android project; a Play Console account ($25 once);
  a signing key you keep forever.
- **Play Billing.** If the $4.99 ad-removal is sold *inside* the TWA it must go through Play Billing
  (the Digital Goods API works in TWAs) — that is a second `EntitlementProvider` binding alongside
  Paddle, and the 15/30% cut. Or keep the purchase web-only and let the TWA be ad-supported.
- Play's data-safety form, a privacy policy URL, an age rating (IARC questionnaire — it is a shooter),
  and a content rating that will land it at Teen.
- Lighthouse PWA-installable checks must pass; the service worker already exists and is correct.

### 4.3 Apple App Store — the hard one
There is no TWA on iOS. Two real paths:
- **"Add to Home Screen" PWA** — no store, no review, no cut, works today once the manifest exists.
  iOS Safari WebGL is fine; pointer-lock is absent (touch controls already exist); audio needs a
  gesture (already handled). Storage is evicted after 7 days of non-use unless installed — the
  `dc_dev` cookie in PLATFORM C4 is the mitigation.
- **A WKWebView wrapper** (Capacitor is the standard one). Apple reviews these under **Guideline 4.2
  (minimum functionality)** and **4.7 (HTML5 games / mini-apps)** — a thin wrapper around a URL gets
  rejected; a wrapper that embeds the bundle, handles offline, uses native IAP and Game Center has a
  real chance. **Guideline 3.1.1: every digital purchase must use Apple IAP** (15/30%) — the third
  `EntitlementProvider` binding. Rewarded-video ad networks on iOS need ATT consent. Apple Developer
  Program $99/year, a Mac for Xcode, an age rating of 12+ or 17+ for a shooter, a privacy nutrition
  label, and expect one rejection cycle.
- Performance: the ~120 draw-call budget holds on an A-series GPU; the 4× CPU throttle the bar was
  measured under is roughly an iPhone 11 — re-run `tools/capture-ours.mjs --mobile` on a real device
  before submitting, because the harness has never seen one.

### 4.4 Steam / desktop — optional
Electron or Tauri wrapper, Steamworks $100 per app, 30% cut, Steam Input for controllers. Common for
web games; not where this game's audience is.

### 4.5 What every store will ask for that does not exist yet
- A **privacy policy** and **terms of service** page (the sponsor/prize legal work in `SPONSORS.md` §5.3
  overlaps heavily).
- A **CMP** and an **age gate** (`docs/PLATFORM.md` §7 and `SPONSORS.md` — an unknown-age player gets
  contextual-only fills and no third-party tag, by default).
- App icons at every size, screenshots per device class, a short trailer (the capture tooling in
  `tools/reccanvas.mjs` can produce one).
- **A domain.**
- A support email and a crash/error sink — there is no error tracking anywhere.

---

## 5. Blocked on the user, not on engineering
ElevenLabs key · a domain · WorkOS / Paddle / PostHog accounts · AdSense/GAM + a games ad network
account · a CMP vendor · legal review before any real-money prize · Play Console ($25) / Apple
Developer ($99/yr) / Steamworks ($100) · a Mac with Xcode for the iOS wrapper · GTA mode has no
obtainable bar.

---

## 6. Tooling invariants — do not break
`playwright@1.62.1` is a required root devDependency — it is the measuring apparatus. `tools/`:
`capture-ref.mjs` (voxiom, headed only), `capture-doom.mjs` (no audio track — decode DMX lumps via
`wad2wav.mjs`), `capture-ours.mjs`, `reccanvas.mjs`, `strip.mjs`, `blind.mjs`, `gauntlet.js`,
`progress/build.mjs`. Deploy Vercel: `npx vercel --prod --yes`. Deploy Railway: **from a clean worktree
at HEAD** — `railway up` uploads the directory, not the commit — and `railway logs --build` is where
"Deploy failed" explains itself. `.vercelignore` must not ignore `shared/`. `buildCommand` is
`vite build` only on Vercel.
