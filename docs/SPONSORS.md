# Doomcraft — sponsors, placement, measurement and interaction

Requested: *"find out different ways to add in sponsors and how to show, how much they are seen and
are clicked, give different options when clicked as well."*

This is a decision document. Every surface below is enumerated, but each one is marked **SHIP**,
**LATER** or **REJECTED**, and the rejected ones say what killed them. Where the research offered a
choice, one option is picked here and the alternatives are in §7 "Considered and rejected".

Read alongside `docs/ECONOMY.md` (progression, items, competitions — the layer sponsors plug into),
`docs/MODES.md` (the five modes), `docs/CONTRACT.md` §6 (the DOM contract that owns the ad slots) and
`ref/BAR.md` (voxiom.io measured — the ad model we are beating).

---

## 0. Ground truth before anything else

### 0.1 What already exists in this repo

| Thing | Where | State |
|---|---|---|
| Three reserved DOM ad slots, `contain: strict`, zero CLS on fill | `client/index.html` (`#ads > .ad-slot`), sizes mirrored in `AD_SLOT_SIZES` `shared/src/constants.ts:403` | **built and working** |
| Slot toggling via `#ads[data-mode]` = `menu` / `game` / `off` | `client/src/main.ts:644` | built |
| House creative ("Remove ads") | `.dc-ad-house`, `fillAdSlots()` `client/src/main.ts:816` | built |
| Ad-free unlock, `$4.99`, `IAP_PRODUCT_REMOVE_ADS` | `constants.ts:413`, `progress.adsRemoved`, `POST /api/entitlement` | built, server-granted |
| `#ad-overlay` (z 40, fullscreen) | `client/index.html` | **element exists, nothing ever opens it** |
| `AD_INTERSTITIAL_MIN_INTERVAL_MS` 180 000, `AD_INTERSTITIAL_AFTER_DEATHS` 3, `AD_INTERSTITIAL_MAX_SECONDS` 15, `AD_REWARD_ARMOR` 50, `AD_OVERLAY_ID` | `constants.ts:408-412` | **declared, read by nothing** |
| `BTN_USE` (1 << 6) already on the wire | `shared/src/protocol.ts` | built — the in-world interaction needs no new keybind |
| `OverlayPass { render(renderer, dt) }` after the main scene render | `client/src/engine/renderer.ts:31,313` | built — this is where a GPU measurement pass would hook |
| `yaw` (uint16) + `pitch` (int16) in every `C2S.INPUT` at `TICK_HZ = 20` | `protocol.ts` | built — **this is what makes server-side viewability possible** |

### 0.2 Four prerequisites that are bugs, not features

These block sponsor work and each is cheap. They are Phase 0 in §6.

1. **No Content-Security-Policy exists.** `server/src/index.ts` sets no `Content-Security-Policy`, no
   `X-Frame-Options`, no `frame-ancestors`. Nothing third-party may load before this lands.
   `frame-ancestors` matters on its own: an aggregator portal can iframe the game and stack its own
   ads over ours — that is ad fraud, a viewability corruption, and a brand-safety failure against our
   own direct sponsors, simultaneously.
2. **The net pump lives inside `requestAnimationFrame`.** `game.tick(now)` runs only from `frame()`
   (`client/src/main.ts:943-945`) and there is no independent interval anywhere in `client/src/net/`.
   Background tabs throttle rAF to ~1 Hz or halt it, so input sends and `C2S.PING` stop.
   `CLIENT_TIMEOUT_MS = 15000` — **a player who clicks a sponsor link mid-match is disconnected in
   15 seconds.** Move the socket pump and ping to a `setInterval(250)` independent of rAF. This is a
   hard dependency for any click-out action, not an optimisation: without it, click-through
   attribution is measuring players we just kicked.
3. **`AD_REWARD_ARMOR = 50` is declared generically.** Granting armour for watching an ad inside a
   `SYS_PVP_DAMAGE` room is pay-with-attention-to-win. Fix it while it is still free: the constant is
   read by nothing today.
4. **There is no per-voxel protected bit.** `BF_BREAKABLE` is a per-`BlockId` flag. A sponsor logo
   stamped as blocks in a destructible mode will be vandalised into something indefensible — this is
   not hypothetical, it is what happens. See S14.

### 0.3 The frame budget, stated honestly

The contract is 60 fps median / 53.8+ fps 1% low at 915×412 under 4× CPU throttle. It is tempting to
read that as "16.6 ms to spend". **That reading is wrong and it would let us ship something that
breaks the contract.** From `shots/*-metrics.json` on disk (Apple M3 Pro, ANGLE/Metal):

| run | viewport | throttle | headed | draws | tris | page median | page p99 | **engine main-thread work** |
|---|---|---|---|---|---|---|---|---|
| `desktop-prod` | 1440×900 | 1× | no | 116 | 198 k | 8.3 ms | 10.2 ms | **0.40 ms** median |
| `mobileland` | 915×412 | 4× | no | 13 | 20 k | 8.3 ms | 10.2 ms | ~0.0 ms |
| **`mobileland-headed`** | **915×412** | **4×** | **yes** | **186** | **249 k** | **16.6 ms** | **18.6 ms** | **0.90 ms median / 1.80 ms 1% low** |
| `t6` | 915×412 | 6× | yes | 177 | 268 k | 16.6 ms | 18.6 ms | 1.70 ms |
| `t10` | 915×412 | 10× | yes | 134 | 228 k | 16.6 ms | 18.6 ms | 3.00 ms |
| `t20` | 915×412 | 20× | yes | 140 | 231 k | 16.6 ms | **50.2 ms** | 7.90 ms |

Three facts fall out of that table and all three change the design:

- **The headless runs are capped at 120 Hz and the headed runs at 60 Hz.** 8.3 ms and 16.6 ms are
  display refresh intervals, not work. Neither median measures headroom.
- **The real number is the engine's own instrumented main-thread work: 0.90 ms median, 1.80 ms 1% low,
  at 4× throttle, at 186 draw calls.** It scales linearly with throttle (0.4 @1×, 0.9 @4×, 1.7 @6×,
  3.0 @10×, 7.9 @20×), which means the frame is CPU-bound, not GPU-bound.
- **The p99 of 18.6 ms is a missed vsync, not a busy frame.** At 4×, 6× and 10× the p99 is identical
  at 18.6 ms — it is a scheduling/GC/upload spike crossing a frame boundary about once per hundred
  frames. That is the number the 53.8 fps 1% low is made of, and it is already at the bar's line.

**Therefore the budget rule for everything in this document is:**

> Every sponsor mechanism is budgeted as a fraction of **0.90 ms**, the engine's own per-frame work at
> 4× throttle — not as a fraction of 16.6 ms. A 0.19 ms spike is **21% of the engine's work** and it
> lands on the tail, which is exactly where the contract is already tight.

Hard limits, enforced in review:

- **≤ 0.02 ms** (≈2% of engine work) main-thread CPU per frame at 4× throttle for anything that runs
  during play, across *all* sponsor mechanisms combined.
- **Zero** added draw calls during play in Phase 1 and 2. In Phase 3, ≤ 2 total, and each one must be
  A/B'd for p99 before it ships (§3.6).
- **Zero** per-frame allocation, zero `innerHTML` writes during play, zero `getBoundingClientRect()`
  in any measurement path (it forces synchronous layout).
- Every ad *decision* and *fetch* happens on a screen transition or in `requestIdleCallback`, never
  inside the frame loop. `fillAdSlots()` already does this from `onReady()`. Keep that discipline.

### 0.4 Two hard rules the rest of the document derives from

**Rule A — we author the shape, the sponsor buys the surface.** Any in-world object that exists
*because* someone paid changes the arena's cover map and its sightlines. That is a competitive-
integrity bug wearing an advertiser's logo. The structure is level geometry, authored by us, present
identically whether or not it is sold. Only the *face* is sponsored, and only the face swaps.

**Rule B — the ad-free purchase swaps faces, never shapes.** Deleting an object per-client desyncs an
authoritative sim: different collision, different sightlines, a demonstrable competitive difference
between a paying and a non-paying player in the same room. Ad-free therefore hides *decals* and
neutralises *textures*; it never removes geometry, and it never removes a placement's collision.

---

## 1. The placement menu

Intrusiveness: **1** = the player never notices it is not ours → **5** = it blocks or degrades play.
Cost is at 915×412, 4× CPU throttle, measured against the 0.90 ms engine budget in §0.3.

### 1a. Menu and shell surfaces — DOM, inside `#ads` and `#ui`

| # | Surface | Exactly where | Intr. | Sponsor value | Our cost | Ad-free behaviour | Phase |
|---|---|---|---|---|---|---|---|
| **S1** | **The three reserved slots** | `#ad-slot-top` 728×90 / 320×50 · `#ad-slot-side` 300×250 (hidden <900 px) · `#ad-slot-bottom` 728×90 / 320×100 | 2 | High. The bar's entire model. Standard IAB sizes are programmatic-eligible day one, and menu dwell is long (mode select + loadout). | **0.000 ms in game** — `display:none` under `#ads[data-mode="game"]`. House creative = 0 KB. A programmatic tag is capped at 900 KB / 600 ms *after* interactive. The bar pays 12.6 MB and 88 scripts for this. | `data-mode="off"` → slots vanish, no reflow (already `position:absolute`). No `/api/ads/decide` call, no tag, no bytes. | **SHIP** |
| **S2** | Branded menu background | Full-bleed layer between `#game` (z 0) and `#hud` (z 10); one static WebP | 3 | High — 100% share of voice for the whole menu dwell. The premium takeover. | **Negative** — it occludes the canvas, so we skip the menu scene render entirely and *gain* ~4 ms. 120–180 KB WebP, lazy, after interactive. | Reverts to the live in-engine scene. One boolean. | LATER |
| **S3** | **Sponsored mode-tile badge** | The existing `.dcm-ribbon` / `.dcm-badge` on a real mode tile in `client/src/ui/modeSelect.ts` | **2** | **Very high** — highest-intent pixel on the page, sitting exactly where the click is already going. voxiom's own "Most Popular" ribbon is the visual precedent. Lives in `#ui`, so ad blockers do not touch it. | ~0. One DOM node in a grid that already builds four. Reflow contained, off-frame. | Badge removed via CSS-var swap. Never a re-layout during play. | **SHIP** |
| **S3b** | Sponsored *fifth* mode tile (a fake mode) | grid `repeat(4,1fr)` → `repeat(5,1fr)` while live | **4** | High | ~0 | Grid returns to 4 | **REJECTED** — a tile that looks like a mode but is an ad is a dark pattern, and it is the single most complained-about pattern in browser games. Use S3. |
| **S4** | **Boot / loading line** | The existing `.boot-tip` line in `#boot`, painted before any script | **1** | Guaranteed 100% viewability — but our boot is ~366 ms and `tPlayable` is 498 ms headless. There is barely time to read it. Worth real money only on slow connections. | **Text only, 0 bytes.** No image: `TIME_TO_INTERACTIVE_BUDGET_MS = 3000` against a 202 KB prod page, and an ad that costs 400 ms of TTI has cost more than it earned. | Reverts to the gameplay tip. | **SHIP** (text-only) |
| **S5** | Region / queue screen | — | — | ~0 for us | — | — | **REJECTED** — our whole pitch against the bar is *no 25 s matchmaking wait* (BAR.md weakness #5). Do not build a queue in order to sell an ad against it. |
| **S6** | Partner cross-promo tile | Top-left ~180×60, mirroring the bar's CubeRealm.io tile | 1 | Traffic barter, not cash. Cheap reciprocal reach. | ~0, one `<img>` | Removed | LATER |
| **S7** | Pause-panel footer lockup | Bottom of `#ui[data-screen="paused"]` | 1 | Low CPM, but it is an **in-match** DOM surface the bar never monetises | 0 — panel is built on open | Line removed | LATER |
| **S8** | Store-tab sponsor shelf | Store tab (`docs/ECONOMY.md`), one branded row of Scrap-priced cosmetics | 2 | High — commerce intent, and it hands the sponsor an *owned* item rather than an impression | 0 | **Shelf stays.** These are cosmetics, not ads. Disclosed as sponsored. | LATER |
| **S9** | Competitions-tab event card | Competitions tab | 2 | High — the entry point to S32/S34 | 0 | Stays; it is content | LATER |
| **S39** | Community rail tile | Under `#ad-slot-side`, where the bar puts "Join our community" | 1 | Low cash, good for a games-adjacent partner | 0 | Removed | LATER |

### 1b. Between-match surfaces — `#ad-overlay`, z 40, exists and is unwired

| # | Surface | Where | Intr. | Sponsor value | Our cost | Ad-free behaviour | Phase |
|---|---|---|---|---|---|---|---|
| **S10** | **Interstitial with countdown + skip** | `#ad-overlay[data-open="1"]`. **Between matches only**, gated by the three constants already declared: ≥180 s apart, after ≥3 deaths, ≤15 s | 4 | **Highest eCPM on the list** — interstitials run several multiples of display | **Negative frame cost:** while open we call the existing `game.leavePlay()` and stop rendering, and set `renderScale 0.5`. 300–800 KB. **Skip must be visible, high-contrast and keyboard-reachable from second one** (§5.3 — UK AADC cites exactly the delayed-skip pattern). | Never shown. `progress.adsRemoved` short-circuits before the decision call. | **PHASE 2** |
| **S11** | **Rewarded, opt-in** | Same overlay, player-initiated from the death or intermission screen | **1** — they chose it | Very high, and the least-resented ad format in games | Same as S10 | **Do not simply remove it.** If ad-free removes the reward, the $4.99 purchase makes you strictly worse off — the worst possible shape for a monetisation design. Grant the reward directly, labelled "included with your purchase". | **PHASE 2** |
| **S12** | **Intermission / results card** | `QuestIntermission` and the deathmatch `Scoreboard` — a 728×90 in the results panel | 2 | Good: long dwell, high attention, the player is idle by definition | ~0 — the panel is already constructed on open | Card removed, panel reflows once, off-frame | **SHIP** |
| **S13** | Death / respawn band | `RESPAWN_DELAY_MS = 1400` | **5** | — | — | — | **REJECTED** — monetising 1.4 s of death is hostile, and it is *during* play. |

### 1c. In-world 3D surfaces — governed by Rule A and Rule B (§0.4)

| # | Surface | What it actually is | Intr. | Sponsor value | Our cost | Ad-free behaviour | Phase |
|---|---|---|---|---|---|---|---|
| **S18** | **Stadium hoarding ring** ⭐ | 12–24 flat panels around a deathmatch/horde arena perimeter as **one `InstancedMesh`**, per-instance UV offsets into a single 1024×128 atlas strip | 2 | **Best value-per-cost in-world surface.** It is the literal real-world sports-hoarding analogue: sponsors already buy this and already know what it is worth. Always in frame in an arena, flat against the wall, changes no sightline, offers no cover. | **1 draw call for the entire ring.** ~30 KB WebP atlas. Must pass the p99 A/B gate in §3.6 before shipping. | Instance UVs point at a neutral house strip. One buffer write. Geometry and collision unchanged. | **PHASE 3** |
| **S15** | **Textured decal quad** ⭐ | A co-planar unlit quad +0.01 m off an existing wall face, own tiny material carrying the same fog term so it does not float out of the fog. 256×128 or 512×256. | 2 | The correct primitive for **all** bespoke paid in-world inventory — full colour, arbitrary art | **+1 draw call**, 131 KB VRAM, ~12 KB WebP, one-time ~0.2 ms upload. No collision, no sim state, no protocol change. | `mesh.visible = false`. Zero sim impact, zero desync. | **PHASE 3** |
| **S16** | Freestanding billboard structure | Authored as a `LevelBrush` in the level JSON; its panel face is an S15 decal | 2 | Medium | S15's +1 draw call; the brush already rides the chunk mesh | Face swaps to neutral. The structure, and therefore all collision and cover, is unchanged (Rule B). | PHASE 3 |
| **S17** | Hanging arena banner | A cutout quad. The cutout material is already `DoubleSide`, so both faces are still 1 draw call | 2 | Medium; reads well in a Horde arena | +1 draw call | Face swap | PHASE 3 |
| **S19** | Sponsored prop / vending machine | Authored geometry + S15 face + an interact via `LevelSwitch` / `PickupKind` | 3 | **Very high** — an interaction, not an impression, and measurable as engagement | +1–2 draw calls | Face and dispensed cosmetic go neutral; prop and collision stay | LATER |
| **S22** | Spawn-floor spray | S15 quad laid flat on the floor, using the existing spray system in ECONOMY.md | 2 | Medium | +1 draw call | Face swap | LATER |
| **S14** | Voxel mosaic mural | The creative quantized to the 25-entry `BLOCK_FACE_COLOR` palette and stamped as real blocks, ~1 block/px | 2–3 | Good — reads as native art, not as an ad | **0 draw calls, 0 shader change, 0 texture bytes** — it rides the chunk mesh. One re-mesh of 1–2 chunks at stamp time, covered by `MESH_UPLOAD_BUDGET_MS = 3.0`. | **This is the one that cannot degrade** — it is world state, identical for every client in the room. | **HOUSE / COMMUNITY / EVENT ART ONLY — never billed**, until *both* (a) the palette-index change below and (b) server-side protected regions ship. |
| **S20** | Distant sign / blimp | — | — | — | — | — | **REJECTED on measurement.** Two things kill it: fog closes at `renderDistance × 32 × 0.98` = **125 m at rd=4 (mobile) / 188 m at rd=6**, and the IIG 1.5%-screen floor (§3.3) means even a 24×12 m surface stops qualifying past **46 m**. A distant sign is unmeasurable inventory. Use S18. |
| **S21** | Sponsored `BlockId` | A 26th entry in `shared/src/blocks.ts` | 2 | Only for a permanent partnership | — | — | **REJECTED for campaigns.** Block ids live in the chunk RLE and the `.dcl` level format. That is a shared-contract and save-compatibility event for a 30-day flight. |
| **S23** | Sky tint / ember colour | A uniform write in `skybox.ts` | 1 | Negligible | ~0 | — | **REJECTED in combat modes.** `DOOM_SKY_EMBER` is what distant silhouettes read against (`material.ts`; MODES.md §1 "enemies are brighter than their background, always"). Selling the ember band sells readability. |

> **Why S14 is not sellable yet, precisely.** Two independent blockers.
> **(1) Ad-free cannot remove it.** A mosaic is blocks — world state, shared by every client. Selling
> in-world dressing that the "remove ads" purchase does not remove is a chargeback and consumer-
> protection problem, not an awkward FAQ entry. There *is* a clean fix: **vertex byte 11 is dead
> padding** (`mesher.ts:30`, "255 · padding"), the one free normalized channel in the 12-byte format.
> Put a palette index there, read it as `int(aColor.a * 255.0 + 0.5)` against a
> `uniform vec3 uSponsorPalette[16]`, and in-world sponsor colour becomes swappable per client with
> **one indexed vertex-shader read and one 48-float uniform** — no re-mesh, no extra bytes, no extra
> draw call. Cheap. But it is a change to the vertex-format contract and it is not Phase 1 work.
> **(2) It will be vandalised.** `BF_BREAKABLE` is per-`BlockId`; there is no per-voxel protected bit.
> In Builder or Horde, a player will shoot a sponsor's wordmark into a swastika. Protecting it needs a
> server-side protected-region list checked in the block-edit path (`server/src/room.ts`, next to the
> `MAX_EDITS_PER_SECOND` gate). Until both exist, mosaics are house art and are never billed.

### 1d. Gameplay-integrated

| # | Surface | What it is | Intr. | Sponsor value | Our cost | Ad-free behaviour | Phase |
|---|---|---|---|---|---|---|---|
| **S24** | **Sponsored weapon skin** ⭐ | ECONOMY.md already specifies skins as "palette swaps + emissive masks so they cost nothing at runtime". A sponsor skin is a **≤16-entry palette JSON + a 1-bit emissive mask**. No geometry, no new texture, no new material. | **1** — the player equips it by choice | High, and it is *owned* media the player elects to carry into every match | **Literally zero.** 0 draw calls, 0 triangles, 0 bytes beyond the palette. A sponsor asking for custom geometry is refused: a separate material is +1 draw call. | **Not an ad — an earned/awarded item. It stays.** | **PHASE 2** |
| **S25** | Sponsored item drop | Server-granted per ECONOMY.md decision 1 | 2 | High | 0 client cost | Kept — earned | LATER |
| **S26** | Branded health / armour pickup | Reskin of `PickupKind.HEALTH` variant 2 / `ARMOR`. Colour swap ± an S15 face. **Identical values.** | 3 | Medium-high, unusually memorable | 0–1 draw calls | Reverts to the stock pickup | LATER |
| **S27** | Sponsored horde wave | A DOM title card between waves. **Identical composition, rewards and difficulty.** | 2 | Good — the build-phase gap is dead air already | 0 (DOM, between waves, renderer idle) | Card removed; the wave is unchanged either way | LATER |
| **S28** | **Sponsored Quest level / episode** ⭐ | One `content/levels/*.json` + an `content/episodes.json` entry. `LevelLibrary.load()` picks it up at boot; it appears in mode select, in `/api/levels`, and as room key `quest:<id>:<skill>` — **with no code change at all.** | 2 (you chose to play it) | **The highest-value item in this document.** An entire authored level as branded content. Also the heaviest disclosure obligation. | **0 runtime cost.** Same loader, same validator, same reachability gate. | **It is content, not an ad. Ad-free does not remove it — and the purchase screen must say so** (§5.5). | PHASE 5 |
| **S29** | Branded vehicle (planned GTA mode) | Not built. When it is: authored geometry + S15/S24 rules | 2 | High | S15/S24 | Face / palette swap | LATER |
| **S30** | Sponsored killfeed or announcer line | — | **5** | — | — | — | **REJECTED.** It sits inside the combat read. Never. |
| **S31** | Sponsor emblem / spray as an earned cosmetic | Profile emblem or wall spray from ECONOMY.md's curated set | 1 | Genuine brand affinity, effectively free inventory | 0 | Kept — earned | LATER |

### 1e. Event surfaces — all of these are data, all cost 0 frames

| # | Surface | Intr. | Value | Notes | Phase |
|---|---|---|---|---|---|
| **S32** | Sponsored tournament — bracket, leaderboard, server-determined winners, prize claim. Console already scoped in ECONOMY.md | 2 | **Very high — this is the deal a real sponsor signs, not a CPM buy** | 0 frames. Heaviest legal load (§5.3 item 7) | PHASE 5 |
| **S33** | Branded seasonal ladder | 2 | High — a full season of presence | 0 | PHASE 5 |
| **S34** | Sponsored prize (cash, hardware, codes) | 1 | The reason players enter | 0 runtime; **heaviest legal load of all** (§5.3 item 7) | PHASE 5 |
| **S35** | Sponsored daily / weekly challenge | 2 | Medium-high, recurring | 0. Must respect ECONOMY.md's anti-farm caps | LATER |

### 1f. Social and off-page

| # | Surface | Where | Intr. | Value | Cost | Ad-free behaviour | Phase |
|---|---|---|---|---|---|---|---|
| **S36** | **Share-card sponsor lockup** | Server-rendered 1200×630 PNG from match data (ECONOMY.md). Sponsor occupies **≤12%**, always the bottom strip, never over the gameplay frame | 1 | High — off-platform reach, and the one surface an ad-free player still carries outward | **0 client frames** — server CPU only | **Remove the third-party lockup from an ad-free player's card.** That player is doing us a favour; do not make them a billboard. Keep a small house wordmark. | PHASE 4 |
| **S37** | Join-code / referral landing page | A normal web page, a different document entirely | 1 | Highest-freedom inventory we own — full IAB stack, zero engine constraints | **0 frames, ever** | n/a — not the game | LATER |
| **S38** | Clip / replay watermark | No clip system exists | — | — | — | — | NOTED FOR LATER |

### 1g. The Phase-One set, and why exactly these

**SHIP: S1, S3 (badge), S4 (text), S12 — plus the whole measurement and event pipeline behind them,
plus the CSP.**

Chosen because all four are *already-existing DOM* on screens where the renderer is idle or stopped,
so the combined in-game frame cost is **0.000 ms** and there is nothing to A/B. They cover the two
things the user asked about that we can actually be rigorous on today — how much a sponsor is seen,
and how often they are clicked — with a measurement story a sponsor can audit line by line. They also
prove the whole stack (decide → fill → measure → validate → report → settle) on the cheapest possible
surface before any of it touches a frame.

Deliberately *not* in Phase 1: everything in-world. Not because it is unaffordable, but because it
needs Rule A enforced in the level validator, a p99 A/B gate, and server-side viewability — and
because the IIG 1.5% screen floor (§3.3) means the placements have to be authored at 16×8 m minimum
or the inventory is a rounding error. That is level-design work, not ad-platform work.

---

## 2. How a sponsor is added

### 2.1 Data model

New file `shared/src/sponsor.ts`, versioned the way `shared/src/level.ts` versions itself.
**Money is integer micros everywhere. Never a float.**

```ts
export const SPONSOR_SCHEMA_VERSION = 1;

/** Every sellable surface from §1. The console renders its catalogue off this enum. */
export enum SurfaceId {
  MENU_TOP = 0, MENU_SIDE = 1, MENU_BOTTOM = 2,        // S1
  MENU_BACKGROUND = 3, MODE_TILE = 4, BOOT_LINE = 5,   // S2, S3, S4
  PAUSE_LOCKUP = 6, STORE_SHELF = 7, EVENT_CARD = 8, COMMUNITY_TILE = 9,
  INTERSTITIAL = 10, REWARDED = 11, INTERMISSION_CARD = 12,
  WORLD_DECAL = 21, WORLD_BANNER = 22, ARENA_HOARDING = 23,
  WORLD_PROP = 24, FLOOR_SPRAY = 25,
  WEAPON_SKIN = 30, ITEM_DROP = 31, PICKUP_SKIN = 32,
  HORDE_WAVE = 33, QUEST_LEVEL = 34, VEHICLE = 35,
  TOURNAMENT = 40, LADDER = 41, PRIZE = 42, CHALLENGE = 43,
  SHARE_CARD = 50, LANDING_PAGE = 51,
}
// NOTE: no WORLD_MOSAIC. S14 is house art and is deliberately not a billable SurfaceId.

export interface Sponsor {
  id: string;                       // 'spn_' + 12 hex
  legalName: string; displayName: string;
  countryCode: string;              // ISO-3166-1 alpha-2 — drives which ad rules apply
  contactEmail: string;
  verified: boolean;                // business verification passed
  status: 'pending' | 'approved' | 'suspended';
  balanceMicros: number;            // PREPAID ONLY in v1. No invoicing, no credit.
}

export type CampaignStatus =
  | 'draft' | 'in_review' | 'rejected' | 'scheduled'
  | 'live' | 'paused' | 'exhausted' | 'ended';

export interface Campaign {
  schema: number; id: string; sponsorId: string; name: string;
  status: CampaignStatus;
  startMs: number; endMs: number;            // UTC ms, start inclusive, end exclusive
  budgetMicros: number; dailyCapMicros: number;
  pacing: 'even' | 'asap';
  pricing: { model: 'cpm' | 'cpd' | 'flat'; bidMicros: number };
  targeting: Targeting;
  caps: FrequencyCap;
  placements: PlacementBinding[];
  disclosure: 'ad' | 'sponsored' | 'paid_partnership';
  categories: AdCategory[];                  // declared by sponsor, VERIFIED in review
  reviewedBy: string; reviewedMs: number; rejectReason: string;
  audit: AuditEntry[];                       // append-only: every status change, budget edit, creative swap
}

export interface Targeting {
  modes: ModeId[];            // [] = all
  regions: string[];          // ISO-3166-1 alpha-2, [] = all. Resolved from request IP AT THE EDGE.
  excludeRegions: string[];   // always beats `regions`
  platforms: ('desktop' | 'mobile')[];
  minAccountLevel: number;    // 0 = any
  ageBands: ('unknown' | 'u13' | '13_17' | '18plus')[];  // LEGAL GATE, not an optimisation lever
  levelIds: string[];
  weekdayMaskUtc: number;     // bit 0 = Sunday
  hourMaskUtc: number;        // 24 bits
}

export interface FrequencyCap {
  perSessionImpressions: number;
  perDayImpressions: number;
  minSecondsBetween: number;
  perDayInterstitials: number;   // PLATFORM ceiling, default 4, applied over any campaign's own number
}

export interface PlacementBinding {
  surface: SurfaceId;
  creativeIds: string[];      // rotation set; server picks round-robin per session
  weight: number;             // 1..100 relative share within the surface
  floorMicrosCpm: number;     // what a programmatic bid must beat to take this slot
}

export type CreativeKind =
  | 'display'    // S1, S12 — a static image at an exact IAB size
  | 'image'      // S2, S3, S8 — a shell image at a declared size
  | 'text'       // S4, S6, S7 — a string, no art at all
  | 'decal'      // S15/S17/S18/S22 — becomes a GPU texture
  | 'palette'    // S24/S26 — <=16 packed 0xRRGGBB, no art can be smuggled through this kind
  | 'video';     // S11 only

export interface Creative {
  id: string; sponsorId: string; kind: CreativeKind;
  status: 'uploaded' | 'scanning' | 'in_review' | 'approved' | 'rejected';
  sha256: string;             // CONTENT ADDRESS. Served path is /cdn/crv/<sha256>.<ext> and nothing else.
  mime: string; bytes: number; width: number; height: number;
  altText: string;            // REQUIRED — accessibility, and a moderation signal
  clickUrl: string;           // https only, allowlisted host, no redirectors
  rejectReason: string;
  derived: DerivedAsset[];
}

/** What the server hands the client. The client NEVER chooses a fill. */
export interface AdFill {
  surface: SurfaceId;
  source: 'direct' | 'programmatic' | 'house';
  creativeId: string; sha256: string; assetUrl: string; clickUrl: string;
  altText: string;
  label: string;              // "Ad" | "Sponsored" | "Paid partnership" — driven by Campaign.disclosure
  modeId: number;             // MODE_TILE only: the tile the badge sits on, from targeting.modes[0]
                              // (for that surface the list NAMES the tile — the decide comes from the
                              // menu, so filtering on "the mode being played" would be meaningless).
                              // -1 everywhere else.
  nonce: string; expiresMs: number;   // single-use, server-issued
}
```

**Delivery is server-authoritative**, which mirrors ECONOMY.md decision 1 ("the server grants every
reward, the client never does"). Two new routes alongside the existing `/api/entitlement` and
`/api/profile` handlers in `server/src/index.ts`:

- `POST /api/ads/decide` — `{ deviceId, surfaces: SurfaceId[], mode, platform, sessionId }` → `AdFill[]`.
  Region comes from the request IP at the edge, **never** from a client-supplied field.
- `POST /api/ads/event` — `{ nonce, type, ms }`. The nonce is single-use and expires; a forged or
  replayed event is dropped and rate-limited the way `MAX_EDITS_PER_SECOND` rate-limits block edits.

**In-world surfaces (Phase 3) are decided once, server-side, at room creation** and shipped in the
room payload — never per client. Two players in the same room must see the same world, or the world
is not authoritative. Frequency counters live on the existing profile record
(`server/src/persistence.ts`), keyed by `deviceId`, next to `entitlements`, behind a `PERSIST_VERSION`
bump and a 3→4 migration (the file already has a 2→3 migration to copy).

### 2.2 Asset pipeline and the moderation gate

Everything is uploaded to a **separate origin** (`cdn.doomcraft.…`), stored by content hash, and served
with `Cross-Origin-Resource-Policy: cross-origin` and `X-Content-Type-Options: nosniff`. **The game
document never hosts a sponsor byte.**

| Kind | Accepted in | Limits | Derived output |
|---|---|---|---|
| `display` | PNG / JPEG / WebP, **static only** | Exact slot size (728×90, 300×250, 320×50, 320×100); ≤150 KB; sRGB | Re-encoded WebP + PNG fallback, metadata stripped |
| `image` | PNG / WebP | ≤400 KB; declared size exactly | WebP at 1× and 2× |
| `decal` | PNG at ≥2× target | → 256×128 or 512×256, power-of-two, mipmapped, premultiplied | WebP + a `THREE.Texture` descriptor (`LinearMipmapLinear`, `ClampToEdge`, `anisotropy: 1`) |
| `palette` | JSON | ≤16 entries of packed `0xRRGGBB` + a 1-bit emissive mask | Validated array. **No art can be smuggled through this kind at all** |
| `video` | MP4/H.264 + WebM/VP9 | ≤15 s, ≤2.5 MB, ≤30 fps | Both containers + a poster frame. Starts **muted**; unmute requires a gesture |

**SVG is refused outright, in every kind.** It is a script container. So is HTML. So is sponsor-supplied
video before Phase 2.

**Three moderation stages, and stage 3 is the one everyone forgets:**

*Stage 1 — automated, on upload.* Sniff the real MIME from magic bytes, never the extension. Decode in
a sandboxed subprocess with hard wall-clock, memory, dimension and pixel-count caps (decompression
bombs). **Strip all metadata** — EXIF/ICC/XMP carry both payloads and PII. **Re-encode to a canonical
form**: this is what kills polyglot files, not a scanner. The bytes we serve are bytes *we* produced.
Perceptual-hash against a blocklist of previously-rejected art. OCR the creative and run the extracted
text through the same filter as `MAX_CHAT_LENGTH` chat. NSFW/violence classifier. Validate `clickUrl`:
HTTPS, resolves, allowlisted host, not an open redirector, not on a malware feed. Reject any animated
creative that violates WCAG 2.3.1 (no more than three flashes per second) — that is a photosensitive-
epilepsy trigger, not a style note.

*Stage 2 — human.* The approver sees the creative **rendered on every surface it is bound to**: the DOM
slot at both breakpoints, and (Phase 3) an in-game first-person screenshot at the exact placement.
Approve or reject with a reason string that goes back to the console.

Plus one check that is specific to this game and that a generic ad platform would not have: **reject
any creative that mimics the HUD.** A fake crosshair, a fake "YOU DIED", a fake killfeed line, a fake
hit marker, fake system chrome, a fake close button, "your device is infected". That is not bad taste,
it is an attack on the readability contract MODES.md §1 is built on.

*Stage 3 — runtime.* The approved `sha256` is **the only thing servable**. A re-upload is a new
`Creative` in `in_review`. There is no in-place edit and no mutable URL. This is the specific defence
against approve-then-swap, which is how hostile creatives actually get onto ad platforms.

**Never inject sponsor markup.** Display creatives render as `<img>` with `element.src` assigned —
never `innerHTML` with sponsor-supplied HTML. (The current house ad uses `innerHTML`, which is fine
only because we wrote that string.) Text fields render via `textContent` with length caps.
Programmatic, if it is ever enabled, goes in
`<iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" src="https://ads.doomcraft…">`
with **`allow-same-origin` deliberately omitted**, so the frame gets an opaque origin and cannot reach
`localStorage`, our `deviceId`, or `document.cookie`. Plus the CSP that does not exist today:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  img-src 'self' https://cdn.doomcraft.example data:;
  frame-src https://ads.doomcraft.example;
  connect-src 'self' wss://…;
  frame-ancestors 'self';
  base-uri 'none';
  object-src 'none'
```

### 2.3 Self-serve console flow

A separate application on a separate origin (`sponsor.doomcraft.…`). It must never share an origin
with the game document.

1. **Sign up** → email verify → business verification (legal name, country, tax id where required) →
   `status: 'pending'`. No inventory is bookable until approved.
2. **Create campaign** — name, flight dates, total budget, pacing, declared categories.
3. **Pick surfaces** from a catalogue rendered straight off `SurfaceId`, each with a live preview, a
   minimum spend and a 30-day inventory forecast. In-world surfaces show the in-game first-person
   screenshot, not a mockup — and they show the **qualifying-distance table** from §3.3, because a
   sponsor buying a 4×2 m poster needs to know it only counts inside 7.7 m.
4. **Upload creatives per surface.** The pipeline returns the derived preview immediately.
5. **Targeting, caps, disclosure.** The console *forces* a disclosure choice and shows the exact label
   string that will appear on the surface. Age-band and region gates are presented as legal
   constraints, not as optimisation levers.
6. **Prepay** through the payment-provider interface (mock/house by default — see §5.2), then
   **Submit for review**.
7. **Review queue** → approve / reject with reason → `scheduled` → `live` at `startMs`. Then the live
   dashboard from §3.5.

### 2.4 Direct-sold vs programmatic vs house — one cascade

Evaluated **server-side, once per screen entry**. Not per frame. Not on a timer.

1. **Direct-sold guaranteed** — a booked flight with a delivery commitment. Wins whenever it is
   eligible, under-delivering against its pacing curve, and inside its caps.
2. **Direct-sold non-guaranteed** — competes on effective CPM against everything below.
3. **Programmatic network** — offered the slot only if its **measured rolling 7-day eCPM** (not its
   promised rate card) clears `PlacementBinding.floorMicrosCpm`. Eligible for **the three DOM display
   slots and the rewarded video only**. Never in-world, never gameplay-integrated, never a Quest level.
4. **House** — the existing `.dc-ad-house` "Remove ads" card. This is the guaranteed floor: the slot is
   never empty, and a house impression that converts a retained player to the $4.99
   `IAP_PRODUCT_REMOVE_ADS` is worth vastly more than a $0.30 programmatic eCPM. **That is exactly what
   makes the price floor credible** — we can always decline a bad price and still fill.

Coexistence rules:

- One decision per slot per **screen entry**, cached for that menu visit. **No timed refresh while a
  player reads the menu** — timed refresh is a large part of what makes the bar's cold load 12.6 MB
  across 88 scripts. Refresh only on a real transition (match end → menu).
- **The programmatic tag is instantiated only if it wins.** If direct or house takes the slot, the
  network's script is never fetched. This is how the load budget holds at ≤900 KB / ≤600 ms after
  interactive.
- One slot, one creative. No stacking, no companion units, no expandables.
- Ad-free short-circuits the entire cascade **before any decision call is made**: `progress.adsRemoved`
  → no `/api/ads/decide`, no tag, no bytes. The purchase buys *silence on the network*, not
  `display:none`.

---

## 3. Measurement

### 3.1 The commitment, in one paragraph a sponsor can audit

> Doomcraft counts a **viewable impression** for a 2D slot when at least 50% of the creative's pixels
> are inside a focused, visible browser viewport for at least one continuous second after render, per
> the MRC Viewable Ad Impression Measurement Guidelines. For a 3D in-world surface we count a viewable
> impression when, for five consecutive 200 ms observations, at least 50% of the creative is
> unobstructed, the visible portion covers at least 1.5% of the screen, and the surface is within 55°
> of facing the camera on both of its own axes — per the IAB/MRC Intrinsic In-Game Advertising
> Measurement Guidelines 2.0 (August 2022), §§3.2–3.2.6. Every count is derived **server-side from
> authoritative simulation state**. Client telemetry is admitted only where it can *subtract*; it can
> never create or increase a count. Anything we cannot measure is reported as **Viewable Status
> Undetermined** and is **never billed**.

### 3.2 2D: the three DOM slots

**Technique: event-driven `IntersectionObserver`, not a 100 ms timer.** MRC grants an explicit
exemption from the polling requirement to measurers who "monitor browser state changes … if these
monitored state changes account for changes in scroll position, browser size/dimensions, and tab
focus". `IntersectionObserver` covers scroll and size; `visibilitychange` plus `focus`/`blur` cover tab
focus. We satisfy the exemption exactly, and we disclose that we use it. Chosen over polling because a
`setInterval(100)` on the menu is a wakeup we do not need, and a timer that keeps ticking while a gate
is false is precisely how dishonest viewability numbers get made.

```ts
const OPTS: IntersectionObserverInit = {
  root: null, rootMargin: '0px',
  threshold: [0, 0.25, 0.5, 0.75, 1],   // 0.5 is the decision boundary; the rest give
};                                       // us the coverage distribution for the report
const V2 = 'isVisible' in IntersectionObserverEntry.prototype;   // Chromium only
const io = new IntersectionObserver(onEntries,
  V2 ? { ...OPTS, trackVisibility: true, delay: 100 } : OPTS);
```

- `intersectionRatio` is intersection area ÷ target bounding-box area. For an untransformed rectangular
  slot that *is* "fraction of the ad's pixels in the viewable space" — the MRC quantity, no conversion.
- **None of our four sizes reaches MRC's 242 500 px large-format threshold** (728×90 = 65 520;
  300×250 = 75 000; 320×50 = 16 000; 320×100 = 32 000), so all four use 50%. There is no large-format
  discount available to us.
- **IO v1 cannot see occlusion.** It reports ratio 1.0 for a slot buried under a modal. IO v2's
  `entry.isVisible` does account for occlusion and visual effects, and its `delay` must be ≥100 when
  `trackVisibility` is true — which lands exactly on the MRC display cadence. On Firefox and Safari
  (no v2), we substitute a **self-occlusion model from our own layer state** — `#ads` is z 20 and the
  only things that can cover it are `#ui` (z 30) and `#ad-overlay` (z 40), both of which we own and
  whose state we already know. Disclosed as a model, not a measurement. Anything outside our layer
  stack (an OS window over the browser, an extension overlay) is undetectable in every browser; that
  is the web analogue of IIG §3.2.7 "TV/input source off" and is disclosed as a limitation.
- **Never call `getBoundingClientRect()` in the measurement path.** Every rect is already on the entry.
  `contain: strict` on the slots means the intersection computation cannot cascade into a layout of the
  game UI.

**Gate set — all must be true for a tick to be positive:**

```ts
const gateOpen = () =>
     document.visibilityState === 'visible'
  && document.hasFocus()
  && !document.prerendering            // IIG 3.1.5.1: pre-render must not count
  && adsRoot.dataset.mode === 'menu'
  && overlay.dataset.open !== '1'
  && creativeLoaded[slotId] === true
  && idle.msSinceInput < AD_MENU_IDLE_MS;
```

That last gate is ours, not MRC's. MRC's display standard has no inactivity rule but IIG §3.1.5.3 does,
and a menu left open on a second monitor for 40 minutes is exactly the abuse case. `AD_MENU_IDLE_MS =
60_000`, reset by `pointermove`/`keydown`/`pointerdown`/`wheel` with `{passive:true, capture:true}`. It
is a stricter rule that only ever reduces counts, and we disclose it.

**Timer discipline — the part that makes the claim honest.** Two independent accumulators per slot,
both driven from monotonic `performance.now()` deltas, never from a count of timer fires:

1. **The pixel test precedes the clock.** The run start is set only when `ratio >= 0.5` AND
   (v2 ? `isVisible` : modelled-clear) AND `gateOpen()`. MRC's explicit ordering requirement.
2. **"Continuous" means continuous.** Any transition to not-qualified resets the run. No grace period,
   no debounce, no "it was probably still visible". A slot that flickers 0.4 s on / 0.1 s off / 0.4 s
   on accumulates **zero** viewable impressions and 0.8 s of exposure.
3. **One second, counted once per slot per session.** Later runs emit `replay`, reported separately.
4. **Exposure time is separate and non-consecutive**, and accrues even before qualification
   (IIG §3.2.10.2). It must not share state with the run timer.
5. **Do not drive the clock from `requestAnimationFrame`.** rAF stops in hidden tabs, which happens to
   be numerically right but leaves you unable to log the transition. Drive from IO callbacks and gate
   events; add a 250 ms `setTimeout` watchdog only to close a run that ends with no event.
6. **A slot whose creative failed to load is not an impression.** For house creative we observe our own
   element directly. For a third-party iframe we can observe only the container; IIG §3.2.8 permits
   that but requires evidence of no material difference, so we run a periodic sampled comparison and
   disclose the container-measurement basis.

**The fourth bucket nobody reports: Blocked.** `id="ad-slot-top"` and `class="ad-slot"` match the exact
cosmetic-filter shapes EasyList uses (`##.ad-slot`, `##[id^="ad-slot"]`). Because the slots are reserved
with `contain: strict`, a blocker hiding them causes **no layout damage at all** — which is good — but
it means our impression denominator silently under-reports.

**Decision: keep the ids, detect blocking, and report it.** One rAF after fill (menu only, never in the
frame loop), check `slot.offsetParent === null || getComputedStyle(slot).display === 'none' ||
slot.clientHeight === 0` and emit a `blocked` event. Never billed, always shown on the dashboard.
Renaming the slots to `#panel-a` would be filter evasion for genuine ad inventory: adversarial, it
breaks CONTRACT.md §6's "change both or neither", and it earns a filter-list entry within a week.
The principled split instead: **genuine ad-network inventory stays in `#ads` with honest names and gets
blocked; first-party sponsor content (S3 mode badge, S12 intermission card, S28 sponsored level) lives
in `#ui` and is not blocked, because it is content, not ad-network inventory.**

**Cost: 0.000 ms in game.** Under `#ads[data-mode="game"]` the slots are `display:none` and the observer
is disconnected. Three targets, callbacks at most every 100 ms, menu only.

### 3.3 3D: what the standard actually demands

IIG 2.0 sets four conjunctive gates. All four are implemented exactly:

| § | Gate | Number |
|---|---|---|
| 3.2 | Pixel | ≥ **50%** of the intended creative visible from the player's perspective |
| 3.2 | Time | ≥ **1 continuous second** (2 s for video/dynamic, §3.2.1) |
| 3.2.2 | Minimum size | ≥ **1.5% of screen coverage**, computed on the **visible portion** — an ad that is 2% of screen but 50% obstructed represents 1% and does **not** qualify |
| 3.2.3 | Angle | ≤ **55° on any one coordinate, absolute**, measured from the centre of the on-screen portion, 0° = facing the screen |
| 3.2.4 | Occlusion | Occluded impressions must be **segregated in reporting**; <50% visible is not viewable. **Includes UI occlusion** |
| 3.2.5 | Impaired visibility | Low light, opacity, contrast, **moving particles**; an ad seen backwards or in a reflection is **not** viewable |
| 3.2.6 | Polling | **200 ms**, equating to **five consecutive positive observations** for display |
| 3.2.10 | Dedupe | One viewable impression per user session; later exposures are **Replays**, reported separately. **Viewable can never exceed Rendered** |

**The 1.5% floor is savage at Doomcraft's FOV, and nobody will tell you this until you have built it.**
`FOV_DEFAULT = 90` and three.js `PerspectiveCamera.fov` is **vertical**. At 915×412, 1.5% of the screen
is 5 655 px. Maximum distance at which a face-on surface still clears the floor:

| Surface | 915×412 @ fov 90 / 98 (sprint) / 110 (max) | 16:9 @ fov 90 / 98 / 110 |
|---|---|---|
| 4 × 2 m | **7.7** / 6.7 / 5.4 m | 8.7 / 7.5 / 6.1 m |
| 8 × 4 m | 15.5 / 13.5 / 10.9 m | 17.3 / 15.1 / 12.1 m |
| 16 × 8 m | **31.0** / 26.9 / 21.7 m | 34.6 / 30.1 / 24.3 m |
| 24 × 12 m | 46.5 / 40.4 / 32.6 m | 52.0 / 45.2 / 36.4 m |

At the 55° angle limit, foreshortening (cos 55° = 0.574) shrinks those by a further ×0.757.

Three consequences, all load-bearing:
- **Author in-world placements at 16×8 m minimum**, or the inventory is a rounding error.
- **Every occlusion ray can be hard-capped at 40 m.** Nothing further can qualify.
- **Fog is not the binding constraint** (125 m at rd=4, 188 m at rd=6). The coverage floor is, at
  roughly a quarter of that distance. This is what kills S20.

### 3.4 The chosen 3D technique — and why the expensive one is rejected

Four options were priced. Client-side measurements are from a Playwright/ANGLE-Metal harness at
915×412 with COOP/COEP set so `performance.now()` resolves to 5 µs, CPU throttle verified genuine by an
8M-iteration spin loop (6.6–9.0 ms at 1×, 27.2–30.2 ms at 4×).

| Option | Cost at 4× throttle | Verdict |
|---|---|---|
| (a) Every-frame CPU voxel raycast, stock `VoxelWorld.raycast` | 2 479 ns/ray × 36 rays × 4 placements = **1.45 ms/frame** | Reject. **161% of the entire engine's per-frame work.** |
| (a′) Optimised probe (hoisted chunk `Uint8Array`, `rec.maxY` early-skip) | 1 029 ns/ray → 0.59 ms/frame | Reject as the primary — still 66% of engine work, and it gives a *worse* answer than the GPU. **Keep as the server's verifier.** |
| (b) WebGL2 `ANY_SAMPLES_PASSED` occlusion queries at 5 Hz, 4×4 inset proxies, ≤6 placements | Issue 0.076–0.184 ms CPU; poll 0.015 ms; GPU 0.126–0.319 ms; **worst frame 0.19 ms CPU** | **Rejected for Phase 3 v1** — see below |
| (c) ID-buffer + `readPixels` | **1.41 ms synchronous stall**, 12×/s | Reject outright. Keep the async PBO variant **offline** as the calibration ground truth. |
| **(d) Server-side reconstruction from `C2S.INPUT`** | **0.000 ms client frame cost.** 0.0371 ms per placement-check on one Node core | **CHOSEN** |

**Why (b) is rejected even though it "fits".** Against the naive reading of the budget, 0.19 ms in
1 frame of 12 is 1.1% of 16.6 ms and looks free. Against the honest budget in §0.3 it is **21% of the
engine's 0.90 ms of per-frame work**, and it is a *spike*, landing on the tail where the 18.6 ms p99
already lives. 18.6 + 0.19 = 18.79 ms = 53.2 fps 1% low, which is **below the 53.8 line** — a contract
failure. It is only a 1-in-12 chance of coinciding, but "usually fine" is not a performance contract.
An adaptive-tick guard (defer the tick if the previous frame exceeded 14 ms, max 3 deferrals) does
remove the interaction, and that is a real mitigation — but it is five lines of complexity buying us a
measurement the server can already produce for free.

**Why (d) is right, and not merely cheaper.** `C2S.INPUT` already carries `yaw` (uint16, 0.0055°
resolution) and `pitch` (int16) at `TICK_HZ = 20`, and the server owns the authoritative `VoxelWorld`
and every entity position. **The server can reconstruct the exact camera basis for every 50 ms tick and
recompute the full IIG gate set from data it already receives.** That gives three things at once:

1. **Zero client frame cost.** Not "small". Zero. The client contributes three booleans.
2. **Better occlusion than the GPU path for entities**, because the server knows every entity's
   authoritative position and can ray-capsule test them, while the client's depth buffer only knows what
   it happened to draw.
3. **Anti-fraud by construction, not by policy.** The billing input is computed from state the client
   cannot forge. A modified client gains nothing by lying, which is what makes divergence a *reliable
   detector* rather than an arms race.

**Implementation:**
- Tier A, per tick, per registered placement (cap `AD_PLACEMENTS_MAX = 32`): backface
  (`dot(normal, camPos − center) > 0`, else an ad "shown backwards" per §3.2.5); frustum against the six
  planes; per-axis angle `θx = atan2(dot(toCam, right), dot(toCam, normal))`, `θy` likewise, reject if
  either exceeds 55°; **clipped-polygon screen area** — project the four corners to NDC,
  Sutherland–Hodgman clip against the four viewport edges and the near plane, shoelace the resulting
  ≤8-gon, divide by 4. **Never the AABB**: the AABB of a rotated quad overstates area by up to 2×, and
  that is the difference between a metric and a sales figure. Reject below 1.5%.
- Tier B, same tick: 36 stratified rays (6×6) against the authoritative voxel world, capped at 40 m,
  plus explicit ray-capsule tests against nearby entities. `visibleFraction = passed / 36`.
- FOV is reconstructed conservatively as `min(clientBaseFov + FOV_SPRINT_BONUS, FOV_MAX)` — the **widest**
  plausible FOV, hence the **smallest** coverage. Biases against us. Camera punch is client-only,
  transient and bounded; ignoring it is conservative in the same direction.
- Five consecutive positive 200 ms ticks → one viewable impression, deduped per session.

**Why 36 rays.** Worst-case pure-Bernoulli false-pass probability for a *full* one-second qualification
at true coverage p, threshold ⌈n/2⌉:

| n | p=0.40 | p=0.45 | p=0.50 | p=0.55 | p=0.70 |
|---|---|---|---|---|---|
| 9 | 0.0013 | 0.0078 | 0.0312 | 0.0927 | 0.594 |
| 16 | 0.0018 | 0.0160 | 0.0766 | 0.228 | 0.878 |
| **36** | 0.0001 | **0.0039** | 0.0581 | 0.289 | **0.982** |
| 64 | 0.0000 | 0.0009 | 0.0502 | 0.380 | 0.999 |

n=9 rejects 41% of genuinely-viewable p=0.70 exposures — unusable. **n=36 is the knee**: 0.4% false-pass
at p=0.45, 98.2% true-pass at p=0.70. Real occlusion is spatially coherent blobs rather than Bernoulli
noise, so stratification makes this strictly better, but 36 is defensible on the worst-case model alone.

**Server budget:** 0.0371 ms per placement-check. At 100 concurrent players × 2 visible placements ×
5 Hz = 1 000 checks/s = **37 ms/s = 3.7% of one core**. At the full 20 Hz tick rate, 14.8%. The server
can therefore verify *every* impression at the standard's own polling rate.

**What the server cannot see, and how we handle it.** Three things: the **viewmodel** (client-only
geometry), **alpha-blended FX that write no depth** (muzzle flash, explosion sprites, blood), and
**HUD occlusion** (which IIG §3.2.4 explicitly requires). The client supplies all three as a single
bitfield on `C2S.AD_TELEMETRY` at 5 Hz — HUD occlusion is a screen-space rect test against known static
HUD rectangles (~0.001 ms, off-frame), and the FX flag is set by the effects system it already owns.
**Every client bit is AND-ed into the gate, so it can only ever turn a positive tick negative.** That is
what makes client input safe to trust here.

**Two small protocol additions:** extend `C2S.HELLO` (or add `C2S.VIEWPORT`) with drawing-buffer
width/height, `devicePixelRatio` and base FOV setting, server-clamped to `[FOV_MIN, FOV_MAX]`; and add
`C2S.AD_TELEMETRY` for the subtract-only bits. Both slot in after the existing `C2S.PING = 6`.

**The GPU-query path is not dead — it is Phase 3.5.** It is the only client-side method that measures
occlusion by everything that writes depth, including the viewmodel. It ships only when it passes the
gate in §3.6, and it upgrades accuracy; it never becomes the billing input.

### 3.5 The metric set

**Mandated by MRC/IIG. Presented together, always.**

| # | Metric | As we implement it |
|---|---|---|
| 1 | **Total (rendered) impressions** | Tier A passed at least once for that placement in that session, and the creative had begun to render |
| 2 | **Viewable impressions** | The full gate set in §3.1. One per placement per session |
| 3 | **Non-viewable** | Measured, failed |
| 4 | **Viewable status undetermined** | Measurement unavailable. **Never billed** |
| 4b | **Blocked** (ours, 2D only) | Slot reserved, fill attempted, element hidden by a client-side filter. Never billed |
| 5 | **Measured Rate** = (2+3)/1 | Target >95%. MRC: "measurers should strive to have the highest possible Measured Rates" |
| 6 | **Viewable Rate** = 2/(2+3) | |
| 7 | **Impression Distribution** | Each bucket as % of Total. **MRC explicitly forbids** quoting the viewable share of *Total* as the Viewable Rate — the dashboard renders all three side by side so the conflation is impossible |
| 8 | **Occluded vs non-occluded split** | Required by IIG §3.2.4. Two counts plus the `visibleFraction` distribution for the occluded set |
| 9 | **Replays** | Re-qualification later in the same session. Reportable but **never folded into (2)** |

**Exposure time (IIG §3.2.10.2):** Total Exposure Time (includes time *before* qualification, accrued
non-consecutively at 200 ms granularity — always larger than 1 s × impressions); Median Viewable Time;
Mean Viewable Time, reported alongside the median rather than instead of it; and **Sustained Views
(4 s)** as a disclosed custom metric. Four seconds is Bidstack's public bar, and IIG permits a stricter
custom threshold only *in addition to* standard reporting, never in place of it.

**Quality of exposure — the reason an in-world surface should out-price a banner:** screen coverage p50
and p90 of `rawCoverage × visibleFraction` (percentiles, not a mean — a mean hides the long tail of
1.6%-of-screen glances that technically qualify); view angle bucketed 0–15/15–30/30–45/45–55°; distance
distribution in metres; skew ratio (projected vs authored aspect, p50/p90).

**Audience:** unique players reached — distinct `accountId`, and for signed-out play a server-issued
session id, **labelled session-uniques, not person-uniques**; frequency, as a mean *and* a distribution
(1× / 2–3× / 4–10× / 11+), because a mean frequency of 3.0 built from one player seeing it 300 times is
a different product from 100 players seeing it 3 times; reach by mode × device, with mobile portrait
broken out — it is our differentiator against the bar (BAR.md weakness #8) and it is a genuinely
different viewing geometry, roughly 2.2× more permissive against the 1.5% floor.

**Interaction:** clicks, on the DOM slots only, per IAB Click Measurement Guidelines. And
**"Sponsor Interactions"** for in-world — named event counts only (collected a sponsored pickup, entered
a sponsored competition, claimed an award). **Never called "clicks", never rolled into a CTR with a
mixed denominator.** Nobody clicks a hoarding, and reporting 0.00% CTR on a billboard makes a good buy
look like a bad one.

**The caveat block, printed verbatim on the dashboard, not buried in a methodology PDF:**

1. These are **opportunity-to-see** numbers. Nothing here measures attention, memory, recall or intent.
   There is no eye tracking. A viewable impression means the pixels met a size, angle, occlusion and
   duration bar on a focused, active screen. It does **not** mean anyone looked.
2. **Do not compare our viewable rate to a display benchmark without reading the definition.** In-game
   viewability runs high across the industry (Anzu publishes ~99% against an ~87% display benchmark)
   because qualifying volume is defined by geometry, not scroll position. A high rate here is a
   statement about placement authoring, not about attention.
3. Coverage is a **deliberately conservative sampled estimate**. Bias and error distribution are
   published in the calibration report and revalidated at least annually.
4. **Alpha-blended effects that write no depth are not detected geometrically.** The client raises a
   suppression flag and those ticks are dropped into Non-Viewable, never Viewable.
5. We **cannot** detect a monitor that is off, a browser window covered by another application, or a
   player who looked away. IIG §3.2.7 treats the console analogue as a known, disclosable limitation.
   Our mitigations — tab visibility, window focus, input liveness — all only reduce counts.
6. **Undetermined is not viewable and is not billed.**
7. **The 1.5% floor is doing more work than you think.** A 4×2 m surface only qualifies inside ~7.7 m.
   Small placements show large gaps between Total and Viewable. That gap is real, not a failure.

**Offline calibration harness** (required by IIG §3.2.2's "empirical support" clause, and the only
reason option (c) still exists): a Playwright job replays recorded gameplay traces and computes ground
truth via the async ID-buffer path (96×44 `R32UI`, exact per-pixel counts) alongside the server's
36-ray estimate. It publishes bias, p5/p50/p95 error and the disagreement rate at the 50% decision
boundary, per placement class and device tier. Re-run annually and on any renderer change. It stays
offline because its ground-truth step is a 1.41–2.58 ms synchronous stall.

### 3.6 The performance gate that governs all of this

Ship a kill-switch wired into the existing bench harness. A/B the p99 frame time at 915×412 under 4×
CPU throttle, measurement on vs off, using `game.medianMs` and `game.onePctLowFps` (the engine's own
instrumentation, which is what produced the 0.90 / 1.80 ms figures in §0.3), not the vsync-capped page
frame time.

- **Regression budget: +0.05 ms on the engine's median, +0.15 ms on its 1% low.**
- Exceeded → measurement drops to Tier A only and every impression that session is reported
  **Undetermined**.
- The same gate governs every added draw call in Phase 3. **A metric that costs frames is a metric we
  do not collect.**

### 3.7 Client → server validation pipeline, and anti-fraud

**The one-line principle: the client does not report impressions. The server derives them.**

1. **Placement registry, build time.** Placements live in the level file. Creative is bound to a
   placement by a **server-side campaign record**, never by anything the client sends. Coverage is
   computed from the **placement geometry**, not the creative bitmap, and creative aspect must match
   `authoredAspect` within 2% or we letterbox — so a sponsor cannot supply an oversized or partly
   transparent asset to inflate their own numbers.
2. **Client telemetry** — a small fixed record per placement per 200 ms tick carrying only the
   subtract-only gates plus an idempotency key `(matchId, tickSeq, placementId)`. Batched into one
   message per second (~180 B/s at 5 Hz × 6 placements). A retried packet cannot double-count.
3. **Server recomputation** — the billing input, per §3.4.
4. **Tick → impression state machine**, server-side, per `(sessionId, placementId)`: a run counter,
   5 consecutive positives emits `viewable_impression`, any negative resets to zero, `exposureMs`
   accrues regardless. Dedupe to one per pair; later runs emit `replay` gated by
   `AD_IMPRESSION_COOLOFF_MS = 30_000` (IIG §3.1.5.4 Cool Off Period).
5. **Append-only event log**, immutable, with full context. **Billing is a batch job over the log, never
   a live counter** — so any dispute can be replayed byte for byte. Raw retention 90 days (30 days for
   any row keyed to `deviceId`, per §5.5), aggregates indefinite.
6. **IVT filtration** before aggregation, emitting three streams: valid, GIVT, SIVT-suspect. **Nothing
   is deleted.** MRC requires IVT rates to be reportable and requires an explicit *Unknown* bucket
   folded into neither.
7. **Aggregation** into per-campaign / per-placement / per-day rollups. Percentiles from t-digest;
   uniques exact under ~10⁶, HyperLogLog above with the error bound printed next to the figure.
8. **Dashboard**, read-only, served from rollups. **Sponsors get no player-level data**: placement-level
   aggregates only, with any cell of fewer than 50 unique players suppressed, so the dashboard cannot be
   turned into a profiling tool.

**GIVT — deterministic, filtered.** `navigator.webdriver`; absent `WEBGL_debug_renderer_info`;
SwiftShader/llvmpipe renderer strings; zero-entropy fingerprint. IIG §3.3.1.2 directs robot and spider
filtration specifically at **browser-based games** — that is us, not an exempt native title. Coverage
>1.0 or =0; a 0×0 or 1×1 creative (IIG §3.2.8 puts these squarely in GIVT); telemetry for a
`placementId` not in the loaded level, or a match the session never joined; wrong `PROTOCOL_VERSION`;
malformed packets. `document.prerendering` true → no impression, ever (IIG §3.1.5.1).
**Datacenter/VPN traffic is flagged but NOT auto-filtered** — IIG §3.3.1.1 is explicit that in games it
"may represent legitimate traffic that should not be filtered as IVT". Route to **Unknown** unless a
second signal corroborates.

**SIVT — behavioural, server-side, using the input stream we already receive.**
- **Look-bot detection.** A bot farming a billboard produces a low-entropy yaw/pitch trace. Over a 10 s
  window: Shannon entropy of quantised yaw deltas, autocorrelation peak of the yaw signal, and the
  fraction of ticks with `|Δyaw| + |Δpitch| == 0`. A human at Doom pace essentially never holds a fixed
  heading for 5 s with a billboard centred. Thresholds fit from labelled real sessions, revalidated
  quarterly.
- **Camera camping.** Reject any qualifying run where camera translation over the window is <0.1 m in a
  combat mode with no weapon/jump/move input. Recorded as **inactive exposure and excluded outright** —
  IIG §3.1.5.3 is specific that over-threshold inactivity must be "excluded altogether", **not** removed
  as IVT, because burying it in the IVT rate misstates both numbers.
- **Impossible-exposure invariants**, checked at aggregation; a violation voids the session's ad events
  and raises an alert: `sum(exposureMs)` for one placement ≤ session wall clock; `viewableImpressions
  (session, placement) ≤ 1`; `viewableImpressions ≤ renderedImpressions` per campaign (MRC: "a maximum
  of a one-to-one correspondence"); position at tick T reachable from T−1 given `SPEED_SPRINT × TICK_DT`
  (reusing the sim's existing movement validation); `θ ≤ 55°`, `visibleFraction ∈ [0,1]`,
  `coverage ∈ [0.015, 1]`.
- **Client/server divergence.** A session whose client systematically over-reports (mean divergence
  >+0.15 over 100 ticks) is running modified code: drop to server-only measurement and flag the account.
  Because the server's number is *already* the billing input, divergence costs the attacker nothing and
  gains them nothing — which is exactly what makes it a reliable detector.
- **Rate limits.** ≤6 measured placements/tick, ≤5 telemetry messages/s, ≤1 viewable impression per
  placement per session. Per IP /24, an impression-velocity cap with the excess routed to **Unknown**
  rather than rejected, since shared NAT and mobile CGNAT are normal.

**Reconciliation.** The billing job recomputes from the immutable log daily and diffs against previously
published figures. Drift above 0.1% halts publication and pages a human. Restatements are published as
restatements. **A viewability number that silently changes after a sponsor has read it is worth less
than no number at all.**

**Shared with the economy layer, not duplicated.** ECONOMY.md already specifies self-referral detection,
device and network heuristics, per-account reward caps and an outlier review queue for referrals. Those
are the same signals and must be **one shared service**: an account farming referrals and an account
farming impressions are usually the same account.

---

## 4. Interaction — what happens when a sponsor surface is used

### 4.1 The intent ladder, and the one rule everything derives from

| Tier | What it does | Reversible? | Costs the round? |
|---|---|---|---|
| **T0** Ambient | impression only, no interactive target | n/a | no |
| **T1** In-page | detail card, save-for-later, copy code, dismiss | yes | pointer-lock release only, and only if opened mid-match |
| **T2** Consequential | open site, mailing opt-in, share sheet, claim, deep-link join | no | yes — backgrounds or replaces the game |

> **T2 is unreachable while `game.playing === true` and pointer lock is held. A T2 intent expressed
> during play is converted into a saved intent (A3) and executed at the next safe boundary.**

"Save for later" is not a feature bolted beside the click model. **It *is* the mid-match click model.**

The browser fact that forces this: while `document.pointerLockElement === canvas` there is no cursor and
every click lands on the lock target. **There is no such thing as "clicking the banner mid-match."** The
only in-match entry points that physically exist are (a) hold-`Use` on an in-world surface, (b) the
death/respawn card, (c) the pause panel.

### 4.2 The click-action menu

| # | Action | What it does | Pays? | Where it is allowed |
|---|---|---|---|---|
| **A1** | **OPEN_SITE** | Leaves to the sponsor's page via our redirector | billable click | menu, intermission, pause (+confirm), death (+confirm), boot with ≥6 s left. **Never during locked play** |
| **A2** | **DETAIL_CARD** | The offer without leaving. **The default action everywhere** — anything not explicitly A1 resolves here first | no | everywhere except locked play; in-world via hold-`Use` |
| **A3** | **SAVE_FOR_LATER** | **The keystone.** Hold `Use` 350 ms → a 1.2 s HUD toast, "Saved. You'll see it after the match." | no | everywhere, **including locked play** |
| **A4** | **REWARDED_ENGAGE** | Engage → Scrap. **The only action that pays**, so it gets the hardest verification (§4.5) | Scrap | intermission, death (after 3 deaths), menu, boot with ≥12 s left |
| **A5** | **CLAIM_ITEM** | Sponsor-awarded skin / item / trophy | an item | menu and intermission only |
| **A6** | **DEEP_LINK** | **The best click in the system: it doesn't leave the game, it starts a match.** | no | menu, intermission; in-match → A3 |
| **A7** | **COPY_CODE** | Promo code to clipboard. **The most valuable action in the design** — the code *is* the attribution token | no | everywhere. Uniquely safe mid-match |
| **A8** | **MAILING_LIST_OPTIN** | Consent capture | no | menu/intermission, **age-gated — probably do not ship** (§5.3 item 8) |
| **A9** | **SHARE** | Sponsored share card through the existing ECONOMY.md card system | no (the *referred player* pays) | menu and intermission only |
| **A10** | **DISMISS / WHY_THIS / REPORT** | × suppresses that campaign 24 h; report queues re-moderation and auto-pulls at a threshold | no | **every sponsor surface, always** |
| **A11** | **MUTE_SPONSORS** | Per-campaign and global opt-out in Settings, distinct from the $4.99 unlock | no | Settings |

**A3 in detail, because it is the one that makes the whole model work.** Hold `Use` for 350 ms with the
crosshair on an in-world sponsor surface, or on the death-screen card. A *tap* of `Use` does nothing, so
a player mashing Use on doors and switches (`SYS_LEVEL_SCRIPT`) can never save by accident. The hold
renders as a radial fill on the existing dynamic crosshair, which already has a spread-fraction driver.
**No new keybind** — `BTN_USE` (1 << 6) is already on the wire; adding an `InputAction` for an ad would
be a gameplay change made for an advertiser, which is backwards. No lock loss, no pause, no navigation,
no network stall. **Zero cost to the round.** That is the entire point. Redemption is a "Saved (n)"
strip on the intermission screen, which is where A1 finally becomes available at zero cost to anything.

Storage extends `StoredProfile` (`server/src/persistence.ts:64`) with
`savedOffers: Array<{ offerId, campaignId, savedMs, ctx, matchId, tick, seen, actedMs }>`, cap 20, FIFO,
TTL = campaign end or 30 days. Bump `PERSIST_VERSION` 3→4 with a migration.

**A1 in detail, because it is the one with the browser traps.** From the pause panel (the worst case):
lock is already released; render a leave-confirm stating the *true* consequence read from the mode's
system mask — `SYS_PVP_DAMAGE` → "The server keeps simulating you. You'll be standing still and
shootable."; `SYS_WAVE_DIRECTOR` → "The wave doesn't wait."; Quest solo → "Your run pauses." Buttons in
this order with this default focus: **[Save to my profile]** ← autofocused, then [Open now], then
[Cancel]. "Open now" is a literal `<a href="/r/<clickId>" target="_blank" rel="noopener noreferrer">`
rendered *before* the click, with `clickId` minted at card-open time — **not** `window.open()` in a
callback and **not** after an `await`, because any async step burns transient user activation and the
popup blocker eats it. On backgrounding: `AudioContext.suspend()`, `renderScale = 0.5`, mesh upload
budget 3.0 → 0 ms. On return, **do not re-lock programmatically** — Chrome enforces a ~1 s lock-out after
a user-initiated Escape exit, so the request silently rejects; show the pause panel and let Resume do
it, and suppress the unlocked-look-mode fallback for 1500 ms so its 400 ms timer does not fire during
the lock-out and strand the player in unlocked look for the rest of the session.

**And A1 does not work at all until prerequisite §0.2(2) is fixed.** With the net pump inside rAF, a
background tab stops pinging and `CLIENT_TIMEOUT_MS = 15000` drops the player.

**A2 renders content as data, never markup:** `{ headline ≤64, body ≤240, imageAssetId, ctaLabel ≤24,
ctaUrl, promoCode?, offerId }`, via `textContent` and one `<img decoding="async" fetchpriority="low">`
from our own content-addressed origin. `role="dialog" aria-modal="true"`, focus-trapped, Escape closes.
**Escape conflict:** the global keydown handler treats Escape as pause, so the overlay handler must
`stopPropagation()` or one keypress closes the card *and* opens the pause menu. **Frame cost is
negative** — opening the overlay sets `renderScale 0.5` and mesh uploads to 0, so fps goes *up*.

**A7 is the sleeper.** `navigator.clipboard.writeText(code)` needs a secure context and transient
activation, and in Safari must be issued **synchronously inside the gesture** — so fetch the code with
the card payload at open time and hold it in memory; **never `await` a fetch inside the click handler**.
Fallback chain: a pre-selected readonly `<input>` + `execCommand('copy')`, then plain display with
"long-press to copy". Clipboard writes do not steal focus and do not release pointer lock, so it is the
one T1 action that is genuinely safe mid-match — but the code is useless mid-match, so the mid-match
behaviour is still hold-`Use` → **copies AND saves**.

### 4.3 Context × action matrix

Wire this as **one shared predicate**, `canPerform(action, ctx, inputKind, mode)` in `shared/src/`, so
client and server evaluate the same table and the server refuses anything the table forbids. A client
that posts `open_site` with `ctx:'play'` is not a bug report, it is a fraud signal.

| | boot / loading | menu | intermission | pause | death window | **live play, locked** | in-world surface |
|---|---|---|---|---|---|---|---|
| Impression | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ (world only) | ✔ |
| A2 detail card | ✔ (≥6 s left) | ✔ | ✔ | ✔ | ✔ | ✖ | via hold-`Use` |
| A3 save for later | ✔ | ✔ | ✔ | ✔ | ✔ | **✔ hold-`Use`** | **✔ hold-`Use`** |
| A7 copy code | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ (with save) | ✔ |
| A1 open site | ✖ | ✔ | ✔ | ✔ + confirm | ✔ + confirm | ✖ → A3 | ✖ → A3 |
| A4 rewarded | ✔ (≥12 s left) | ✔ | ✔ | ✖ | ✔ (after 3 deaths) | ✖ | ✖ |
| A5 claim item | ✖ | ✔ | ✔ | ✖ | ✖ | ✖ | ✖ |
| A6 deep link | ✖ | ✔ | ✔ | ✖ | ✖ | ✖ → A3 | ✖ → A3 |
| A8 mailing opt-in | ✖ | ✔ (age-gated) | ✔ (age-gated) | ✖ | ✖ | ✖ | ✖ |
| A9 share | ✖ | ✔ | ✔ | ✖ | ✖ | ✖ | ✖ |
| A10 dismiss / report | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |

Context notes:
- **Boot/loading.** T2 forbidden outright — navigating away kills the load. The surface renders only
  when `estimatedRemainingMs ≥ 6000` and **disarms 1200 ms before completion**, so a tap aimed at the
  "Play" button that is about to appear can never land on a sponsor button that just appeared under the
  thumb. A sponsor asset must never be on the critical path to interactive
  (`TIME_TO_INTERACTIVE_BUDGET_MS = 3000`); load it `fetchpriority="low"` after `onReady()`, and if it
  has not arrived, show nothing.
- **Intermission is the payoff surface for the entire design** — everything deferred lands here. But
  there is a real collision to design around: **`DM_INTERMISSION_MS = 8000`** (`server/src/deathmatch.ts:80`)
  and the next round auto-starts. Eight seconds is not enough room for a scoreboard, a saved-offers
  strip, a share card and a rewarded prompt. **Decision: in Deathmatch the between-round intermission
  carries at most the S12 results card and a `Saved (n)` count badge; the interactive saved-offers strip,
  A4, A5 and A9 surface on the *session-end return to menu*, not between rounds.** Quest and Horde
  intermissions are player-dismissed and can carry the full set. A sponsor surface **must never delay or
  extend an intermission to fit an ad** — that is stealing gameplay time to sell inventory. If a player
  takes a T2 action, hold their room slot rather than dropping them into the next round mid-tab-out.
- **In-world during play.** Interaction is `Use`, **never `Fire`** — binding a sponsor to `BTN_FIRE`
  would train players to shoot ads and make every ad an accidental click. Gate: ≤3.5 m,
  `dot(view, faceNormal) < −0.6`, player alive, `heldMs ≥ 350`. The prompt check piggybacks on the
  raycast Builder already runs for the block-highlight wireframe: **one integer compare on the hit
  block, <0.01 ms/frame.**

### 4.4 Mobile mis-tap protection

The worst outcome on mobile is a fat-finger navigation out of the game. Three layers.

**Geometry — hard exclusion zones.** No sponsor target may exist inside `.dc-look` (right 58%), inside
`.dc-stick`, within 44 px of `.dc-fire` / `.dc-jump` / `.dc-crouch` / `.dc-sprint` / `.dc-reload` /
`.dc-build`, inside the hotbar strip, or within 12 px of any screen edge (edge swipes and system gesture
bars). At 915×412 that leaves the top-centre band and the card overlay — which is exactly the two places
sponsor UI is allowed.

**Activation — first tap never navigates.** Every touch interaction resolves to T1. Navigation requires a
*second, distinct* tap on a ≥48×48 CSS-px target inside a modal that has already taken over the surface.
**This single rule eliminates the entire class of mis-tap navigations.**

**Gesture qualification** — all must hold or the touch is discarded silently:
- `pointerdown` and `pointerup` on the same element, movement <10 px between them.
- Gesture duration in **[40 ms, 700 ms]** — faster is synthetic, slower is a drag or a rest.
- `event.width`/`event.height` ≥ 6 CSS px. A 1×1 or 0-size contact is synthetic.
- **No other pointer currently down.** A thumb on the stick means the other thumb is playing, not shopping.
- The element has been visible, hit-testable and **geometrically stable for ≥500 ms** — a settle timer
  re-armed on any creative swap, orientation change, HUD relayout or `#ads[data-mode]` transition.
- `pointercancel` aborts unconditionally.
- `touch-action: manipulation` on sponsor targets — kills double-tap-zoom, keeps scrolling. Never
  `touch-action: none` on something that is not a control.
- An 8 px dead margin inside every slot; taps in the outer ring are discarded, not counted.

**Portrait: no in-play sponsor surface at all.** A 412-wide portrait viewport has almost no safe room
during play. Menu and intermission only; the side slot is already hidden below 900 px. (BAR.md weakness
#8 is that voxiom refuses portrait outright and we do not — that advantage is not worth spending on an
ad slot.)

**In-app webviews** (Discord, Instagram, TikTok): `window.open` may be swallowed, `navigator.share({files})`
is unreliable, storage is often ephemeral. Detect and degrade — prefer A3/A7 over A1/A9 — and tag the
session as a distinct **low-confidence cohort** in reporting rather than blending it.

### 4.5 Server-side verification for anything that pays

**The structural rule: the client never asserts a click.** A click *happens* when the server's redirector
is fetched.

```
GET /r/<clickId>
clickId = base64url(HMAC-SHA256(secret, {impressionId, placementId, creativeId,
                                         campaignId, deviceHash, sessionId, ts, nonce}))
```

Single-use, 120 s TTL, minted server-side at card-open. A second fetch still 302s the human, but the
event is **not counted** and the session is scored. A client POST claiming a click is a UX hint, never a
billable fact. This one decision removes most of the attack surface, because a farm now has to make a
real HTTP request through our infrastructure to fake anything.

**Gate 1 — impression must precede click.** No `impressionId` on record → invalid, unconditionally. And
an impression only exists if the server's own derivation (§3.4) qualified it.

**Gate 2 — accidental clicks.** Prevention first, and most of it already exists: reserved
`contain: strict` slots make layout shift under a moving finger impossible, which is the #1 industry
cause. Then detection: dwell since first viewable <300 ms → **invalid**; 300 ms–1 s → **suspect**
(reported, not billed); tab returns focus within 2 s of an `open_site` → suspect; a click within 120 ms
of a `Fire`/`Jump` input → discarded as a mis-hit. **Publish `accidentalRate` on every campaign
dashboard.** It is the single most credibility-building metric available and almost nobody publishes it.

**Gate 3 — click farms.** This is where an authoritative-sim game has an advantage no ordinary publisher
has, and it should be the headline of the anti-fraud story. **A billable click requires a real player:**
≥10 minutes of *server-recorded* playtime (`stats.secondsPlayed`, written by the sim), ≥1 completed
match, and a non-degenerate input trace. The sim already receives every `InputCommand`; an account whose
stream has zero look deltas, or a look-delta distribution with no human jitter, is a bot. **A farm has to
actually play Doomcraft to earn the right to click, and at that point it is cheaper to buy the ad.**
Plus: per-/24 and per-ASN click and device velocity with quarantine; datacenter/VPN ASNs excluded from
*billable* inventory while still being served; and a **honeypot** — a zero-opacity, off-viewport,
`aria-hidden`, tab-excluded decoy that no human and no screen reader can reach. Any interaction with it
bot-classifies the session, **voids all its events retroactively**, and keeps serving it normally so the
farm never learns what tripped it.

**Gate 4 — repeat-click inflation.**

| Scope | Rule |
|---|---|
| `(deviceId, creativeId)` | 1 billable click / 24 h, hard |
| `(deviceId, campaignId)` | 1st billable; 2nd–3rd reported only; 4th+ dropped and the device scored |
| `sessionId` | ≤3 billable clicks total across all campaigns |
| `(deviceId, offerId)` save | idempotent — the 200th save returns the first `savedMs` |
| `(deviceId, awardId)` claim | unique; a repeat returns the original grant, HTTP 200, no second item |
| Promo code | 1 per account, ever |

**Gate 5 — the rewarded handshake (A4), the only thing that pays out.** The client never says "I watched
it":

1. `POST /api/sponsor/reward/start` → `{rewardId, minMs, serverStartMs}`. The server records the open.
2. Heartbeats every 2 s. The server requires `seq` strictly increasing, arrival spacing in
   **[1.6 s, 3.5 s]** (clock-skew tolerant; defeats a client that fakes elapsed time in one shot), and
   `visible && focused` on **≥80%** of beats.
3. `POST .../claim` → the server checks `Date.now() − serverStartMs ≥ minMs` **against its own clock**,
   heartbeat count ≥ `floor(minMs/2000)`, and the caps below.
4. The grant lands via `store.update(deviceId, …)` — the same **per-device-locked** read-modify-write
   that grants entitlements, which serialises concurrent tabs for free.

**Caps, implementing ECONOMY.md's "per-match and per-day caps, diminishing returns":** 4 grants/day/
account, ≥180 s apart, diminishing **40 / 30 / 20 / 10** Scrap, **zero** for accounts with <30 min of
server-recorded lifetime playtime, and **zero while `SYS_PVP_DAMAGE`** (§4.6). Out-of-match rewards pay
**Scrap, never XP** — XP is "how far have I come" and an ad must not move it.

**Gate 6 — settlement, not real time.** Nothing bills on the spot. Events settle after **72 hours**,
during which retroactive voiding runs. The dashboard shows `provisional` and `settled` side by side; the
invoice uses `settled`. Publishing a number you later claw back is how you lose a sponsor permanently.

### 4.6 Gameplay-fairness rules — these are bugs, not policy

1. **No new collision volumes, ever.** Rule A (§0.4). Enforce it in `compileLevel()`: a sponsor-bound
   object must contribute **zero** new collision volume relative to the unsponsored level, its anchor
   block must be solid and already exist (reject an anchor on air), and decals must sit ≤0.05 m off an
   existing face.
2. **No sightline placement.** Reject faces inside corridors flagged as sightlines, within N metres of a
   spawn point, on any face reachable as a step or ledge, or on a door/switch face (which would collide
   with the `Use` affordance the level script already owns).
3. **Runtime fairness detector, from the same telemetry.** Alert on any placement whose p95 `rawCoverage`
   exceeds 0.25 (it fills a quarter of the screen — it is in the way), or whose shadow volume shows a
   materially longer median time-to-first-damage than baseline (players are using it as cover).
   **Sell no placement that trips either.**
4. **Emissive cap.** MODES.md §1: "enemies are brighter than their background, always" — that contrast
   *is* the design. A sponsor face must never out-contrast a monster. Sponsor emissive = 0 in dark PvE
   spaces, clamped to `AMBIENT_LIGHT` elsewhere; cap any in-world creative in a combat space at roughly
   Y ≤ 0.45 luminance in the graded output. `BF_EMISSIVE` sponsor blocks are banned in Quest entirely.
5. **Destructible like anything else** in `SYS_TERRAIN_DAMAGE` modes. An invulnerable billboard in a
   destructible world is both a gameplay bug and a cover advantage. Once destroyed, impressions stop —
   which is correct.
6. **Rewarded grants must never buy a PvP advantage.** Hard gate: armour, health, ammo and weapons are
   refused when the room's system mask has `SYS_PVP_DAMAGE`. Scrap and cosmetics only.
7. **Branded pickups have identical values.** A branded medikit that heals more is a rules change bought
   with money. Colour and face only.
8. **Sponsored horde waves are reskins.** Identical composition, rewards and difficulty. A sponsored wave
   that is easier or pays better distorts the run's difficulty curve and drives through ECONOMY.md's
   anti-farm caps.
9. **Sponsored drops are sidegrades**, per ECONOMY.md. A sponsored drop that is stronger is pay-to-win
   laundered through an advertiser.
10. **Sponsor-minted tradable items are currency injection.** Cap the mint per campaign, record it in the
    existing trade audit log, and apply an extended **14-day** untradable cooldown so a burst of throwaway
    accounts cannot launder a limited award into the market.

---

## 5. What this does NOT do

### 5.1 What the numbers cannot prove

- **Whether a human looked at the pixels.** Viewability is geometry × time. It is not attention. There is
  no eye tracking anywhere in this design, and any "attention" number would be fabricated.
- **View-through conversion, absent a promo code or a holdout.** Without a third-party tracker and
  without third-party cookies, we **cannot** observe a conversion on the sponsor's site by a user who
  never clicked. Full stop. Safari and Firefox block third-party cookies outright, Chrome's are unusable
  for this, and we are explicitly not injecting third-party pixels — BAR.md measured voxiom loading **88
  scripts of which 5 are the game**, ~12.6 MB cold. Every third-party tag is simultaneously a privacy
  liability and a frame-time liability. Any publisher quoting a clean view-through number in this
  environment is either using a tracker or making it up.
- **Cross-device.** Phone impression → laptop purchase is invisible without a promo code or a linked
  account.
- **Anything on the sponsor's site without their postback.** Zero visibility. Do not offer a "site
  visits" metric we cannot back — that is the exact lie that ends sponsorships.
- **True unique reach.** We can count `deviceId`s. We cannot count people. And **Safari ITP evicts
  script-written localStorage after 7 days of no interaction**, so a player returning on day 8 is a
  brand-new device to us; in-app webviews are often ephemeral within a single session.
- **Blocked inventory.** We can detect that a slot was hidden; we cannot know what share of the audience
  runs a blocker in aggregate. Reported as a bucket, never estimated away.

**What we *can* prove, and should lead the pitch with, in descending order of reliability:**
1. **In-game conversions.** If the sponsor's goal is *"players did a thing inside Doomcraft"* — joined the
   branded tournament, cleared the sponsored Quest level, equipped the awarded skin — the conversion is
   recorded by the authoritative sim and is **100% measurable with zero tracking and zero privacy cost**.
   This is the structural advantage a game has over a website: **we own the conversion surface.** Steer
   every sponsor toward goals of this shape. A join counts only after ≥90 s in-room **and** ≥1 scored
   action, both recorded by the sim, so join-and-quit farming does not inflate it.
2. **Per-player promo codes.** A code issued server-side to one device hash and redeemed at the sponsor's
   checkout maps 1:1 back to one of our players. Cookieless, ITP-proof, cross-device, works in in-app
   webviews. This is a **deterministic view-through channel** and most publishers cannot offer one.
3. **Clicks, settled**, from the server redirect log.
4. **Saved offers and save→click rate** — a funnel we own end to end, not available to a banner publisher
   at all.
5. **Modelled lift**, via a ghost-ad / PSA holdout: 5–10% of eligible sessions, stably hashed, get house
   creative instead. It requires the sponsor's cooperation, it yields a **confidence interval rather than
   a number**, and it needs real volume before the interval is narrower than the effect. Say all three
   out loud when proposing it.

**Attribution windows: 7-day click / 1-day view**, as a per-campaign field. The industry default of
30-day post-click is wrong for a browser game — the consideration cycle is minutes, and a 30-day window
mostly steals credit from the sponsor's other channels, which is how a publisher gets caught in an audit.

**Double-counting is the classic failure.** If the sponsor runs other paid channels, our click id has to
be reconciled against their last-touch model. **Agree the model in the insertion order before launch**,
or both sides claim the same purchase and the relationship ends in a spreadsheet argument.

### 5.2 What needs a real provider the user has not set up

Everything below is designed against an interface with a house/mock default. **None of it works with a
real counterparty until the user does explicit setup, and none of it should be switched on silently.**

```ts
interface SponsorProvider {
  readonly id: string;
  fetchPlacements(ctx: PlacementContext): Promise<Placement[]>;   // CONTEXTUAL signals only
  recordImpression(ev: ImpressionEvent): Promise<void>;
  mintClick(ev: ClickIntent): Promise<{ clickId: string; href: string }>;
  startReward(r: RewardStart): Promise<RewardTicket>;
  claimReward(r: RewardClaim): Promise<RewardResult>;
  verifyPostback(raw: Buffer, sig: string): Promise<PostbackEvent | null>;
}
```

Default binding is `HouseSponsorProvider`: reads `content/sponsors/*.json` (the same content-as-data
pattern as `content/levels/`), mints clicks with a local HMAC key, grants from the local store, **zero
outbound network**. Nothing under `client/src/game/**` or `client/src/engine/**` ever imports a provider.

| Needs setup | What is missing | What we ship instead |
|---|---|---|
| **An ad network** (AdInPlay, Google Ad Manager, …) | A signed publisher agreement, a tag, and an account. This is a business relationship, not code | House creative in every slot. The cascade already treats house as the guaranteed floor |
| **A payment processor** for sponsor prepay | A merchant account, KYC and sanctions screening on `Sponsor`, plus money-handling obligations | Mock provider; `balanceMicros` is a number in a JSON file |
| **A payment processor** for the $4.99 unlock | SCA/PSD2 in the EU, VAT/sales tax | The existing `POST /api/entitlement` mock grant |
| **A CDN origin** for creative | A second domain and TLS | Local static serving in dev; the content-addressed path shape is already correct |
| **A CMP** for EU/UK consent | A vendor. The bar runs *two* stacked (Quantcast + Google Funding Choices) | Contextual-only, no personalisation, no consent needed — which is also the correct default (§5.3 item 1) |
| **Conversion postbacks** | The sponsor's engineers wiring the webhook | The endpoint and the Stripe-style HMAC signature scheme exist; the `unmatched` rate is reported honestly |
| **An actual sponsor** | ECONOMY.md decision 3 says it plainly and it is repeated here: **I can build the whole platform. I cannot get you a sponsor.** Everything here is real, working software; whether a company signs is a business conversation outside this repo, and the system is built so that when one does, it is configuration rather than engineering | — |

### 5.3 What needs legal review before it earns a cent

Ordered by exposure. **None of these is a "check with a lawyer later" item; each one changes what gets
built.**

**1. Children's advertising is the biggest exposure here, by a distance.** A free browser voxel shooter
in the Minecraft idiom has a child-heavy audience whatever the ToS says. If any part of the service is
"directed to children" under **COPPA**, behavioural advertising and persistent identifiers collected for
ad purposes are off the table. **We already store a persistent `deviceId`** for entitlements
(`server/src/persistence.ts`). **That identifier must never reach an ad network.**

> **Decision, and it is the default rather than a setting: unknown-age and under-13 users get
> contextual-only, house-or-direct-sold fills, with no third-party tag loaded at all.** That is exactly
> why the cascade must be able to fill from house at any moment.

**2. GDPR / ePrivacy (EU/UK).** Personalised ads need consent; consent needs a CMP. Non-consent must
serve **non-personalised**, not nothing. The ePrivacy storage rule applies to anything the tag writes,
independently of GDPR.

**3. UK Age Appropriate Design Code and the Online Safety Act.** Profiling children for advertising is
effectively off-limits, and nudge patterns are explicitly in scope. **A countdown interstitial with a
low-contrast or delayed skip control is the cited pattern.** Hence the S10 requirement: skip visible,
high-contrast and keyboard-reachable from second one.

**4. DSA (EU).** Ads must be clearly identifiable, must disclose who paid, and must not be targeted using
profiling on minors' data. The DOM slots already carry a label
(`.ad-slot::after { content: attr(data-label) }`). **In-world surfaces have no equivalent and that is a
real gap.** Practical answer: a "Sponsors" line on the level's loading card **and** on the intermission
screen, plus the sponsor's name in the level's detail row in mode select. **A 9 px grey "presented by"
is not a disclosure.**

**5. Sponsored-content disclosure (FTC endorsement guides, ASA).** A sponsored Quest level (S28), a
sponsored tournament (S32) and a sponsored mode badge (S3) are **branded content, not display ads**. They
need clear, up-front, unavoidable disclosure at the point of choice — on the tile, on the loading card,
and at intermission — with the `Campaign.disclosure` field driving the label string, **never left to the
sponsor's copywriting**.

**6. Category restrictions, and a shooter attracts exactly the wrong ones.** Gambling, crypto, alcohol,
vape, weapons, dating, pharma, political. Given a likely-minor audience the default is a **category
blocklist that is on by default**, not a per-campaign allowlist. Gambling to under-18s is prohibited
everywhere; alcohol advertising is banned outright in several markets; **political advertising carries
its own registration and disclosure regimes and should simply be refused in v1.**

**7. Prizes are promotions, and promotions are regulated per country.** Skill-based tournaments are
broadly fine; a **random draw is a lottery** in several jurisdictions. US tax reporting thresholds apply
to prize value. **Minors generally cannot claim prizes without guardian consent.** Publish per-region
official rules, refuse claims from accounts flagged under-18 absent verified guardian consent, and
geo-exclude where a format is not lawful. ECONOMY.md already declines paid loot boxes for the same family
of reasons — extend that caution rather than treating prizes as a marketing detail.

**8. Mailing-list consent (A8) — and the age finding probably kills it.** Requirements are not optional:
an unticked checkbox, explicit affirmative action, **separate** from any other agreement, granular per
purpose. No pre-tick, no bundling, no "by continuing you agree". **Never bundled with a reward** —
conditioning Scrap on consent makes it non-freely-given under GDPR Art. 4(11)/7(4); if an interaction
pays, it must pay identically to a player who declines. Store the consent record including a **hash of
the exact wording** (that is how you satisfy Art. 7(1) demonstrability a year later). Withdrawal must be
as easy as granting, propagated to the sponsor within 72 h, or the deal does not happen. Double opt-in is
mandatory, and is also the only defence against a player entering an enemy's address. The email is typed
into **our** form — a sponsor iframe collecting it is a credential-harvesting surface. The sponsor
receives `{email, consentTimestamp, consentTextHash, campaignId}` and nothing else: never `deviceId`,
never stats, never IP.

> **But: GDPR Art. 8 sets digital consent at 16 (member states may lower to 13); COPPA is under-13 with
> verifiable parental consent. Render the opt-in only for accounts that have asserted age ≥16 through a
> *neutral* gate — a month/year picker, not an "are you 16?" checkbox, which invites lying. Unknown age
> → the control is not rendered at all. If reliable age assurance is not in place, do not ship A8. The
> revenue is small and the exposure is not.**

**9. Impression logs keyed to `deviceId` are personal data.** Keep raw per-device rows for ≤30 days,
aggregate after that, and wire deletion into the existing profile record so a deletion request actually
reaches the ad tables.

**10. Accessibility, with a safety edge.** `altText` is mandatory on every creative. The interstitial must
be keyboard-dismissible and screen-reader-announced. Reject any animated creative violating WCAG 2.3.1
(no more than three flashes per second) — photosensitive epilepsy, not a style note. And a control a
keyboard user cannot reach is also a control **we cannot prove a human used**, so accessibility here is
simultaneously an anti-fraud measure.

**11. Refund and consumer-fairness exposure on the ad-free purchase.** See §5.5.

### 5.4 What is deliberately not built

- **No fingerprinting, no probabilistic device graph, no third-party pixel in the game page.** Ever.
- **No behavioural or personalised targeting for minors.** Which is why `SponsorProvider.fetchPlacements`
  takes a `PlacementContext`, not a user profile.
- **No sponsor-supplied HTML, CSS, JavaScript or SVG**, in any surface, in any phase.
- **No paid voxel mosaics** until §1c's two blockers are cleared.
- **No queue screen built in order to sell an ad against it.**
- **No timed slot refresh.**
- **No in-play sponsor surface in mobile portrait.**

### 5.5 What "remove ads" buys, stated exactly

This string, or something very like it, must appear **on the purchase screen itself** — not in a FAQ.
"Remove ads" that leaves a sponsor's logo on the arena wall is what produces chargebacks and store
complaints, and it is trivially avoided by saying so up front.

> **Removes:** the three menu ad slots, the between-match interstitial, the rewarded-video prompt, the
> results-screen card, the loading-screen sponsor line, sponsor artwork on in-world surfaces, and the
> sponsor lockup on your shared match cards. No ad network is contacted and no ad bytes are downloaded.
> **You still get the rewarded bonus** — it is included with your purchase, no video required.
>
> **Does not remove:** sponsored Quest levels and sponsored tournaments you choose to enter, sponsor-
> awarded items you already own, and the "Sponsored" labels that tell you which is which. Those are
> content and disclosures, not advertising.

Note the structural constraint behind the first list: **ad-free swaps in-world faces, it does not delete
in-world geometry** (Rule B). A non-paying and a paying player in the same room see the same walls, the
same cover and the same sightlines. Only the artwork differs.

---

## 6. Build order

Each phase is independently shippable and each ends in a state that is honest to a sponsor.

### Phase 0 — the safety floor (nothing third-party may land before this)
1. **CSP** on the game document, with `frame-ancestors 'self'`, plus `X-Content-Type-Options: nosniff`.
2. **Move the socket pump and `C2S.PING` out of `requestAnimationFrame`** into a `setInterval(250)`.
   Without this every click-out is a disconnect inside `CLIENT_TIMEOUT_MS = 15000`.
3. **Gate `AD_REWARD_ARMOR` behind `!SYS_PVP_DAMAGE`** while it is still read by nothing.
4. `content/sponsors/*.json` + the `SponsorProvider` interface + `HouseSponsorProvider`.
5. `shared/src/sponsor.ts` with `SPONSOR_SCHEMA_VERSION = 1`.

*Small. Load-bearing. None of it is visible to a player.*

### Phase 1 — the slice worth shipping first: house sponsors, menu-only, fully measured
6. `POST /api/ads/decide` and `POST /api/ads/event`, server-authoritative, nonce-gated.
7. **2D viewability** (§3.2): IntersectionObserver, the gate set, the two accumulators, the Blocked
   probe, the MRC three-bucket / three-rate reporting. New constants:
   `AD_VIEWABLE_PIXEL_FRACTION = 0.50`, `AD_VIEWABLE_MS_DISPLAY = 1_000`,
   `AD_VIEWABLE_MS_VIDEO = 2_000`, `AD_MENU_IDLE_MS = 60_000`, `AD_IMPRESSION_COOLOFF_MS = 30_000`.
8. `/r/<clickId>` redirector, HMAC-signed, single-use, 120 s TTL; the append-only event log; 72-hour
   settlement; gates 1–4 of §4.5.
9. Surfaces **S1**, **S3** (badge), **S4** (text), **S12**. Actions **A2**, **A7**, **A10**, **A11**.
10. A minimal internal dashboard rendering the full metric set from §3.5 including the caveat block.

**Why this is the right first slice:** combined in-game frame cost **0.000 ms**, zero third-party bytes,
zero legal exposure beyond disclosure labels, and it proves the entire pipeline — decide → fill →
measure → validate → settle → report — on surfaces where a mistake costs nothing. It also directly
answers the two questions asked: how much a sponsor is seen, and how often they are clicked.

### Phase 2 — between-match, and the keystone interaction
11. Wire `#ad-overlay`: **S10** interstitial (skip visible and keyboard-reachable from second one) and
    **S11** rewarded, using the three constants that already exist. Stop the renderer while open.
12. **A3 SAVE_FOR_LATER**, `StoredProfile.savedOffers`, `PERSIST_VERSION` 3→4 + migration, the
    intermission "Saved (n)" strip. **Build this before A1's mid-match path — A1 mid-match is just a
    deferred A3.**
13. **A4** rewarded handshake (§4.5 gate 5) with the diminishing-Scrap caps and the PvP refusal.
14. **A1 OPEN_SITE** with the leave-confirm and the pointer-lock sequence.
15. `canPerform(action, ctx, inputKind, mode)` in `shared/src/`, evaluated by client *and* server.
16. Mobile mis-tap protection (§4.4) in full.
17. **S24** sponsored weapon skin as a palette + emissive-mask entry.

### Phase 3 — in-world, and server-side 3D viewability
18. Level-format `Placement` (`collides: false` by default) + the `compileLevel()` fairness validator
    (Rule A, §4.6 items 1–2).
19. **Server-side IIG measurement** (§3.4): Tier A + the 36-ray probe, `C2S.VIEWPORT`,
    `C2S.AD_TELEMETRY`, the tick→impression state machine, the SIVT detectors.
20. **S18 hoarding ring** (1 draw call) and **S15 decal quad**, each through the §3.6 A/B gate before it
    ships. `AD_PLACEMENTS_MAX = 32`.
21. In-world disclosure: the "Sponsors" line on the loading card and at intermission (§5.3 item 4).
22. The offline calibration harness.

*Phase 3.5, optional accuracy upgrade only:* client-side WebGL2 occlusion queries with the adaptive-tick
guard, to catch viewmodel and entity occlusion the server cannot see. Ships only if it passes §3.6. It
never becomes the billing input.

### Phase 4 — the console, and the money
23. Sponsor console on its own origin; the asset pipeline and the three-stage moderation gate (§2.2).
24. Prepay behind the payment-provider interface; the full decision cascade (§2.4) with programmatic
    behind a measured-eCPM floor and instantiated only if it wins.
25. Conversion postbacks in both directions, HMAC-signed, idempotent, `unmatched` rate published.
26. **S36** share-card lockup; **A9**; **A6** deep links; **S2**, **S6**, **S7**, **S39**.

### Phase 5 — sponsored content (legal-gated)
27. **S28** sponsored Quest level / episode — zero code, one JSON file, heaviest disclosure obligation.
28. **S32/S33/S34** sponsored tournament, ladder and prize pool, on ECONOMY.md's competitions layer.
29. **S8**, **S9**, **S19**, **S25**, **S26**, **S27**, **S31**, **S35**.
30. **A5 CLAIM_ITEM** with the per-award lock and the 14-day untradable cooldown.
31. **A8** mailing-list opt-in — **only if** neutral age assurance exists. Otherwise it does not ship.

---

## 7. Considered and rejected

| Option | Rejected because |
|---|---|
| **Wall murals painted into the block texture atlas** | There is no block texture atlas. `client/src/engine/material.ts` is a `RawShaderMaterial` with vertex colours only — no sampler, no UV attribute. Adding UVs is +4 bytes on a 12-byte vertex (+33% on every chunk upload in the world), a sampler, and a re-mesh of all 169 chunks. Use S15 decals or S18 instancing instead. |
| **Client-side GPU occlusion queries as the Phase-3 measurement** | 0.19 ms worst-frame CPU = **21% of the engine's 0.90 ms per-frame work**, landing on the tail where the 18.6 ms p99 already sits: 18.79 ms = 53.2 fps 1% low, **below the 53.8 contract line**. The server can produce a better answer for 0.000 ms of client frame time. Kept as an optional accuracy upgrade behind an A/B gate. |
| **Every-frame CPU raycast occlusion** | 1.45 ms/frame with the stock `VoxelWorld.raycast`, 0.59 ms with an optimised probe. 161% and 66% of the engine's per-frame work respectively — for a *worse* answer than the GPU (misses entities, viewmodel, particles). Kept as the server's verifier at 36 rays. |
| **Synchronous `readPixels` from an ID buffer** | 1.41 ms median synchronous stall at 4× throttle, twelve times a second. Disqualified outright. Retained offline as the calibration ground truth. |
| **100 ms polling for 2D viewability** | MRC grants an explicit exemption to event-driven measurement that covers scroll, size and tab focus. IntersectionObserver + `visibilitychange` + focus does exactly that, with no timer. |
| **AABB screen-coverage for 3D** | Overstates a rotated quad's area by up to 2×, always in the seller's favour. Clipped-polygon shoelace instead. |
| **Naive 4×4 occlusion-query subdivision** | `ANY_SAMPLES_PASSED` returns true if one pixel of a cell is visible, so a 10%-visible cell scores 100% — bias in the seller's favour. Centre-inset proxies (25% of cell area) make the estimator a conservative lower bound. |
| **`ANY_SAMPLES_PASSED_CONSERVATIVE`** | The spec permits it to return true when zero samples passed. A false positive in a billing input is not acceptable, and the exact variant measured cheaper *and* lower-latency anyway. |
| **A fifth "sponsored mode" tile (S3b)** | A tile that looks like a mode but is an ad is a dark pattern and the most-complained-about pattern in browser games. Use the ribbon/badge on a real mode. |
| **Death/respawn-band ads (S13)** | Monetising 1.4 s of death is hostile and it is *during* play. |
| **Distant sign / blimp (S20)** | Unmeasurable. The IIG 1.5% floor stops a 24×12 m surface qualifying past 46 m — and fog closes at 125 m on mobile anyway. |
| **Sponsored `BlockId` (S21)** | Block ids live in the chunk RLE and the `.dcl` level format. A shared-contract and save-compat event for a 30-day flight. |
| **Sky tint / ember colour (S23)** | The ember band is what distant silhouettes read against. Selling it sells readability. |
| **Sponsored killfeed / announcer line (S30)** | Inside the combat read. |
| **Paid voxel mosaics (S14)** | Ad-free cannot remove world state, and `BF_BREAKABLE` is per-BlockId so a logo will be vandalised. House art only until the byte-11 palette index and server-side protected regions both ship. |
| **Renaming the ad slots to evade blockers** | Filter evasion for genuine ad inventory: adversarial, breaks CONTRACT.md §6's "change both or neither", and earns a filter-list entry within a week. Detect and report a Blocked bucket instead; keep *first-party* sponsor content in `#ui` where it belongs. |
| **A queue / matchmaking screen to sell against** | BAR.md weakness #5 is the bar's 25 s wait. Do not build our own in order to monetise it. |
| **30-day post-click attribution window** | Wrong for a browser game whose consideration cycle is minutes; it mostly steals credit from the sponsor's other channels, which is how a publisher gets caught in an audit. 7-day click / 1-day view. |
| **Billing off our own reward events** | `visibilityState` and focus are client claims and a headless farm can lie about both. That is exactly why the payout is small, capped, decaying and gated on real server-recorded playtime — and why the sponsor is never billed off them. |

---

# DECISIONS — answered by the user 2026-08-20

These override the recommendations above. Where the doc recommended the cheaper path and the user
chose the fuller one, the concern was raised, heard, and the user's call stands.

## Ad supply: BOTH — programmatic fill now, direct-sold as it arrives

*"both, adsense or other ad networks till we get sponsors which are direct sold"*

Programmatic is the **fill floor**; direct-sold sponsors **pre-empt** it. One slot, a waterfall:
direct-sold campaign → house ("Remove ads" / cross-promo) → programmatic. Never a blank slot.

**Network reality, and it changes what to sign up for.** AdSense serves ads on web *pages*. It covers
our three DOM slots around the canvas and nothing else — in-game surfaces, between-match
interstitials and rewarded video are not AdSense inventory. Those need a games network. The bar uses
**AdInPlay** (`api.adinplay.com/libs/aiptag/pub/VXM/voxiom.io/tag.min.js`, seen in our own capture of
voxiom.io). So the realistic supply stack is:

| Surface | Supply |
|---|---|
| Three DOM slots (menu/loading/intermission) | AdSense or Google Ad Manager |
| In-game, interstitial, rewarded | A games network (AdInPlay, or equivalent) |
| Any surface | Direct-sold sponsor, pre-empting the above |

Both sit behind the single `SponsorProvider` interface with the house provider as the default, so the
build is not blocked on either account existing.

**What choosing programmatic now commits us to** — this is the cost the direct-sold-only option
avoided, and it must be scheduled, not discovered:
- A **consent management platform** and a real consent stack. The bar runs two stacked CMPs
  (Quantcast + Google Funding Choices) and they measurably damage its UX — our capture harness had to
  defeat both, and a real user has to click through them before playing. Do better: one CMP, resolved
  before the menu is interactive, and never blocking the Play button.
- **Cold-load discipline.** voxiom pays 12.6 MB cold with 88 scripts, of which only 5 are the game.
  We are at 3.3 MB. Third-party tags must be **lazy-loaded after first interactivity** and must never
  sit on the critical path — our sub-3.16 s time-to-interactive advantage is a real competitive edge
  and an ad tag is the single most likely thing to destroy it.
- **The CSP in `docs/BUGS-FOUND.md` §2 becomes a blocker, not hygiene.** Third-party tags execute in
  our origin unless properly sandboxed.
- **Unknown-age users get contextual-only fills, no third-party tag.** This stays the default
  regardless, per COPPA / GDPR Art. 8 / UK AADC.

## Prizes: ALL THREE shapes supported

*"all 3"* — in-game prizes, real money/hardware, and skill-based-with-real-prizes.

The platform supports all three. The exposure was stated and the user's decision stands. How it is
built to keep the risk contained:

- **Default is skill-based.** A tournament is skill-determined unless explicitly configured otherwise.
- **Random draw is behind an explicit per-event flag**, because the random element is the specific
  thing that makes a prize promotion a lottery in several jurisdictions — not the prize value.
  The console surfaces that warning at the point of configuration, not in a terms document.
- **Real-money and hardware prizes require an event to carry**: a jurisdiction allowlist, an age
  floor with guardian consent for minors, a tax-reporting field for jurisdictions with thresholds,
  and published official rules. The system refuses to open such an event with those unset.
- In-game prizes (skins, trophies, Scrap) carry none of that and remain the fast path.

**Still true and not a matter of configuration: real-money prizes need legal review before a real
event runs.** The software can be correct and the promotion still be unlawful in a given market.
