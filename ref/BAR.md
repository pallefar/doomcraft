# THE BAR — voxiom.io (captured live 2026-08-20)

Every critic judges against **this**, not against a description of it. The raw frames are in
`ref/voxiom/`. Look at them. Do not review from memory.

## How to re-capture the bar yourself

```
cd /Users/karstenhaldan/youtube/doomcraft
node tools/capture-ref.mjs                       # desktop 1440x900
node tools/capture-ref.mjs --mobile              # Pixel 7 portrait 412x915
node tools/capture-ref.mjs --mobile --landscape  # 915x412
```

**Audio: the capture files have none.** `canvas.captureStream()` is video-only, so
`ref/doom/doom-gameplay.webm` and `ref/voxiom/desktop-gameplay.webm` contain a single VP9 video
stream and no audio track. To compare against DOOM's actual sounds, decode the DMX lumps from the
shareware `DOOM1.WAD` (md5 `f0cefca49926d00903cf57551d901abe`) — 55 lumps at 11025 Hz, 8-bit
unsigned. `tools/wad2wav.mjs` does this.

**Motion.** Playwright's own `recordVideo` does not capture an accelerated WebGL canvas — it writes
a ~2 KB file with nothing in it. Use `tools/reccanvas.mjs` instead, which runs
`canvas.captureStream(60)` + `MediaRecorder` inside the page and pulls the blob out as base64. That
yields true 60 fps (`ref/voxiom/desktop-gameplay.webm`, 416 frames). It records the **canvas only**
— but "voxiom's HUD is DOM, so it does not appear" is **only partly true, corrected 2026-09-05**:
the **minimap and the crosshair are rendered INTO the canvas** and do appear in both recordings.
Ammo, health, hotbar and chat are DOM and do not. Do not tell a critic the canvas has no HUD. Turn a recording into something
reviewable with `node tools/strip.mjs <video> <out.png> 4 3 <startSec> <endSec>`.

Headed Chrome + persistent profile is **required** — voxiom.io sits behind Cloudflare and
headless gets a "Just a moment..." interstitial.

**Two traps corrected 2026-09-05.** "Pointer lock ignores synthetic mouse" is **FALSE** for this
site: a page-side probe counted 322 *trusted* `mousemove` events carrying 7343 px of `movementX`,
and the camera panned 12-24 px/frame. The real trap is that **`keyboard.press('2')` does not switch
hotbar slots** — the keydown arrives trusted, but the engine polls key STATE per frame and a
press goes down-and-up inside one frame, so the first gunfight capture photographed a shovel five
times. Hold the key ~220 ms, or send one mouse-wheel tick. `Escape` does not release pointer lock
here, so there is no DOM fallback. Also: extracting frames with ffmpeg WITHOUT an explicit `fps=`
resamples these MediaRecorder webms to 25 fps (their `avg_frame_rate` is `0/0`), silently dropping
~55% of frames — which is enough to conclude there is no muzzle flash at all. `strip.mjs` sets
`fps=` and is safe. The script already handles the two stacked
consent CMPs (Quantcast + Google Funding Choices) and clicks the **Battle Royale** tile
(clicking the text "Play" hits a heading, not a button).

## Measured facts about the bar

| Metric | voxiom.io |
|---|---|
| Time to title | 122 ms |
| Time to menu interactive | **3.16 s** |
| Menu → in-game (terrain loaded, HUD up) | ~15–25 s (incl. matchmaking wait) |
| Frame time median | 16.6 ms (**60.2 fps**, vsync-capped) |
| Frame time p99 | 17.6 ms (**56.8 fps 1% low**) — essentially zero hitching |
| Total transfer, menu | ~322 KB warm / ~12.6 MB cold (ads dominate cold) |
| Scripts loaded | 88 (5 are the game; the rest are ads/analytics) |

## What the menu looks like (`ref/voxiom/desktop-00-menu.png`)

Full-bleed in-engine voxel scene as the background — beach, sea, grass cliffs, trees — with the
UI floating on top. Not a static JPEG: it is the renderer running.

- Wordmark "VOXIOM" huge, centred, light grey with a soft bevel; subtitle "Open Alpha Testing - Pre-Season".
- Horizontal black tab bar: Game / Account / Leaderboard / Loadouts / Shop / Updates, gear icon far right.
- Left card: class ("1 Soldier", XP bar 0/127), mode chips, then a stat table — Games Played, Games Won,
  Win %, Kills, Deaths, KDR, Captures, Score — greyed with a padlock and "Login to unlock!".
- Centre card: Region dropdown ("Europe (Amsterdam)"), then "Play" heading over three mode tiles —
  **Capture The Gems** (with a red "Most Popular" ribbon), **Battle Royale**, **Survival** (wide, orange).
- Right column: a 300×250 display ad, and under it "Join our community" with Discord/Reddit/Twitch/Twitter.
- Bottom: a 728×90 banner ad. Top-left: a partner cross-promo tile (CubeRealm.io). Footer: Terms / Privacy / Cookies.
- **The ads are part of the layout, not overlaid on it.** They sit in reserved slots and the page does not
  reflow when they fill. This is the ad-integration bar to beat.

## What in-game looks like (`ref/voxiom/desktop-08-combat.png`)

- **Art**: blocks **are textured**, not flat-coloured — close up (`ref/voxiom/desktop-gameplay.webm`)
  stone shows a clear running-bond brick pattern, grass a fine speckle, sand a dither. At distance the
  textures wash out to flat colour, which is what the beach frame shows. Build with real textures.
  Grass = saturated green top, brown dirt sides. Water = flat mid-blue plane, slightly darker than sky,
  no reflection, no transparency. Sky = flat light blue, **no gradient, no fog** at mid range.
  Simple directional light — top faces bright, side faces stepped darker. No shadows. No AO.
- **HUD** — **"corners only" is STALE, corrected 2026-09-05.** Re-captured live in
  Capture The Gems with a rifle, the bar also has a **TOP-CENTRE** element: a
  three-cell score/timer strip ("9 | 07:33 | 12") with two lines of mode rules
  under it. That matters directly to the gauntlet's HUD question, which is
  "without cluttering the centre" — the bar now clutters it too. Also **the
  minimap caption is "Press `M` for full map", not `Tab`** (the old string is
  still hard-coded as an in-game detector in `tools/capture-ref-gunfight.mjs`,
  which logged INGAME false for twelve polls while the player was demonstrably
  in the world). And the ammo readout is WEAPON-DEPENDENT: no line on the
  shovel or the block slots, `Ammo: 30 / 150` on the rifle, `Ammo: 12 / 96` on
  the pistol — so a HUD comparison against the old shovel frame understates the
  bar. The rest of the corner description below still holds:
  - Top-left: round-cornered minimap (~200 px) with terrain colours + a white circled arrow for the player;
    caption "Press `Tab` for full map".
  - Top-left under it: three dark pill chips — players alive (person icon, "2"), kills (skull, "0"), timer (clock, "00:00").
  - Centre: a thin white **plus** crosshair, ~14 px, no dot, no dynamic spread.
  - Bottom-left: chat/kill feed on a translucent dark panel, orange join/leave lines, cyan tips,
    "Press enter to chat!". Under it grey key hints "`Shift` to sprint  `C` to crouch".
  - Bottom-left: two stacked bars — armour (shield icon, "0 / 100", grey fill) and health (cross icon,
    "100 / 100", green fill). Rectangular, thin white outline, numeric label inside.
  - Bottom-right: 5-slot hotbar, dark translucent squares, index digit below each, **white outline on the
    selected slot**, item icons rendered as small 3D voxel thumbnails (shovel, dirt block ×99, three block
    types), stack count bottom-right of the slot. Caption "Press `X` to open inventory".
- **Status text**: centre-screen "Waiting for players...(2/50)", "Loading Terrain (100.00%)...",
  "Click anywhere to respawn!", "Killed by Unknown".

## Where the bar is weak — this is where we win

Judged honestly from the captures, voxiom is **not** Doom. These are the openings:

1. **No pace.** Movement is Minecraft-speed. Doom's whole feel is ~2× that, with no acceleration ramp.
2. **~~No gunfeel.~~ CORRECTED 2026-09-05 — this was measured on a SHOVEL, and it is wrong for
   firearms.** The original claim: "across 1.2 s of continuous mouselook the held shovel does not
   move one pixel... no muzzle flash, no screen shake, no hit spark. The viewmodel is a static
   billboard. This is the single most winnable piece." The shovel half is true. The generalisation
   to a gun was never tested, and this project built a whole piece on it.

   Re-captured with a rifle (`ref/voxiom/desktop-gunfight.webm` and
   `desktop-gunfight-wall.webm`, Capture The Gems, which hands you an assault rifle at spawn — no
   looting needed). What voxiom's rifle actually has, counted frame by frame:
   **muzzle flash** (3 of 12 tiles; a flash lasts ~50-65 ms of a ~165-190 ms shot cycle, so it
   cannot appear in every sampled frame), **ejected shell casings** (8 of 12),
   **world-anchored impact decals** (9 of 12 in the wall clip), **per-shot recoil** and a
   **reload animation** in which the weapon leaves the screen entirely.

   What is still true, and is now the actual opening:
   - **No sway and no mouselook lag.** With the camera panning ~18 px/frame the front sight moves
     1 px in x and 2 px in y over 17 frames. Independently spot-checked: on still-camera pairs the
     viewmodel's best alignment is dx=dy=0 with a residual of 0.66 against a 1-px-move equivalent
     of 2.10, so the instrument could have seen a single pixel and did not.
   - **No walk bob.** Walking without firing gives 2 px x and 8 px y of slow monotonic drift over
     24 frames — drift, not oscillation.
   - While FIRING the sight oscillates ~±5 px on the shot cadence and climbs 8-9 px across a burst.

   So the piece is not "they have nothing". It is: **they have a competent gun and no sway, no bob,
   and nothing at the point of impact beyond a flat decal.** Re-run any of this with
   `node tools/viewmodel-motion.mjs <video> --from <s> --to <s>`, which prints the box's alignment
   AND what a one-pixel move would score, because the first number means nothing without the second.
3. **~~Dead crosshair.~~ ALSO A SHOVEL MEASUREMENT.** The shovel's plus is 23 px in all 416
   frames — genuinely dead. The **rifle** crosshair measures 95-99 px at rest and 149-156 px while
   firing, a +57% bloom, and every transition lines up with a declared fire window to within a
   frame. What remains true: **no hitmarker.**
4. **Flat lighting.** No AO, no fog, no contrast — the beach reads as one mass. Doom's readability comes from
   dark rooms and bright enemies.
5. **Cold open is slow.** ~25 s from click to shooting, most of it matchmaking. A bot-filled instant start beats it.
6. **Ads are menu-only in these captures** — the interstitial/rewarded surface is unexploited.
7. **No enemies in the sandbox.** It is PvP-only; there is no single-player Doom-like horde to fall into.

## The measurable half — with the bar measured under the SAME throttle

The bar's 60.2 / 56.8 numbers above are **unthrottled**, which is not a fair comparison to a phone.
So the bar was re-run at 915×412 with `Emulation.setCPUThrottlingRate: 4` (throttle verified genuine —
an 8M-iteration spin loop costs 5.7 ms at 1×, 11.1 at 2×, 22.4 at 4×, 33.8 at 6×, i.e. linear):

| | unthrottled | **4× CPU throttle** |
|---|---|---|
| FPS median | 60.2 | **60.2** |
| FPS 1% low | 56.8 | **53.8** |

So the bar holds its median under throttle but its 1% low drops below 55 — it hitches on a slow CPU.

**Two different lines, and do not confuse them:**
- **Beating the bar** = 1% low above **53.8** at 915×412 under 4× throttle.
- **Meeting our spec** = 60 median / **55** 1% low, which is deliberately *harder than the bar*.

A piece may win its A/B and still miss the spec. Report both. A piece that drops below 53.8 has lost
outright, whatever it looks like.

---

# Mobile (captured 2026-08-20)

## Portrait, 412×915 — `ref/voxiom/mobile-08-combat.png`

**The bar does not play in portrait.** It renders the world, then throws a full-screen
"Please rotate your screen" overlay with a rotate-device glyph and blocks input. This is
weakness **#8** and the largest single opening on mobile: half of all phone sessions are
one-handed portrait, and the bar simply refuses them.

## Landscape, 915×412 — `ref/voxiom/mobileland-08-combat.png`

It works, and it is thin:

- **Left**: one translucent virtual joystick, very low contrast — it nearly disappears against
  grass. No visible dead-zone or radius feedback.
- **Right**: a vertical stack of four small circular glyph buttons — sprint (runner), dig (shovel),
  jump (up arrow), crouch (down arrow). ~40 px, translucent, thumb-reachable but easy to mis-hit.
- **No dedicated fire button.** Shooting is a tap on the right half, which is the same gesture as
  looking — so aiming and firing fight each other. There is no auto-fire and no visible aim assist.
- **Top-right**: a pause glyph. **Bottom-centre**: 6-slot hotbar, last slot is a "…" overflow.
- Top-left minimap, chat and the three pill chips are unchanged from desktop — not re-laid-out for
  the short viewport, so they eat the top-left quarter of a 412 px-tall screen.
- Pause menu is three plain buttons: **Resume / Settings / Leave**. No graphics settings surfaced here.

## Mobile metrics

| Metric | Portrait | Landscape |
|---|---|---|
| Time to title | 571 ms | ~200 ms |
| Time to menu interactive | 4.02 s | 3.17 s |
| FPS median | 60.2 | 60.2 |
| FPS 1% low | 56.5 | 56.8 |

Note these were captured on a desktop-class GPU with a phone-sized viewport, so **60 fps here is the
easy case**. Our own capture applies 4× CPU throttling on top, which the bar's numbers above do not
include — when we compare, we throttle both or neither.

## Added openings

8. **Portrait is refused outright.** We play in portrait and in landscape.
9. **No fire button.** Aim and shoot are the same gesture. A dedicated fire pad plus optional
   auto-fire and a modest aim-assist cone is a decisive mobile win.
10. **Controls are nearly invisible.** Low-contrast translucent glyphs on bright terrain.
11. **Desktop HUD shipped to a 412 px-tall screen** without re-layout.
