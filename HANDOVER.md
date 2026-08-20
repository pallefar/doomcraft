# Doomcraft — handover, 2026-08-20 ~19:50

Paused mid-build. Resume at 22:00. This file plus `ref/BAR.md`, `docs/MODES.md`, `docs/CRITIC.md`
and `docs/CONTRACT.md` is everything you need.

## Where to start when you come back

```bash
cd /Users/karstenhaldan/youtube/doomcraft
npx tsc -b --pretty false && npx vitest run          # confirm the repo is still green
npm run dev                                          # boots on :5173
node tools/capture-ours.mjs                          # screenshots + metrics into shots/
```

Then re-run the mode workflow, which was **still in flight when we stopped**:

```
Workflow({ scriptPath: "/Users/karstenhaldan/.claude/projects/-Users-karstenhaldan-youtube-doomcraft/9e8c505b-feeb-47bd-af12-833ebb96376b/workflows/scripts/doomcraft-modes-wf_edf6177f-b5b.js" })
```

`resumeFromRunId` is same-session only, so a fresh session must re-run it from the script path.
The framework phase already completed and its files are on disk, so the re-run will redo work that
is partly done — read `docs/MODES-API.md` and `shared/src/{modes,level}.ts` first and consider
trimming the framework phase out of the script before re-running.

## State: what is DONE and verified

**Spine — complete, running, verified by eye (not by agent self-report).**
25,330 lines, 31 files. `tsc -b` clean, tests 18/18 + 19/19 + 29/29. 312 ms to interactive, zero
console errors. On screen: voxel arenas, 7 Doom weapons, dynamic crosshair that blooms with spread,
7-pellet shotgun sparks, rocket craters cut into terrain, killfeed, minimap, in-engine menu, full
settings panel, three reserved ad slots. **Mobile portrait plays** with a big FIRE pad and labelled
JUMP/CRCH/RUN/RLD/BLD buttons — the bar refuses portrait entirely.

**Three bars captured and on disk** — `ref/voxiom/`, `ref/doom/`, and Minecraft Classic verified
reachable (`ref/mcclassic/` still to be filled by the Builder agent).

**Mode framework — complete.** `shared/src/modes.ts`, `shared/src/level.ts` (the expandable level
format), `server/src/{modes,levels}.ts`, `client/src/modes/registry.ts`, three Quest levels in
`content/levels/`. API documented in `docs/MODES-API.md`.

**Four mode builders — IN FLIGHT, incomplete.** Only `client/src/modes/builder/undo.ts` and
`client/src/modes/deathmatch/killfeed.ts` had landed. Quest, Horde, most of Builder and most of
Deathmatch are unwritten. The repo still typechecks, so nothing is broken — it is just unfinished.

## The one honest negative

**Performance is a TIE with the bar, not a win, and a tie is a loss by our own rule.** Headed at
915×412 under verified 4× CPU throttle: ours 60.2 median / 53.8 1% low, voxiom 60.2 / 53.8 —
identical, because both are vsync-locked. Both collapse together at 20×. The 120 fps figure that
appears in some captures is a **headless artifact**; headless Chrome is uncapped while the bar must
be captured headed (Cloudflare). **Always compare headed-to-headed.**

Three things I would fail our own build on today, before any critic runs:
1. **Our blocks are flat-coloured; the bar's are textured.** Straight loss on art.
2. Viewmodels read as coloured boxes, not weapons.
3. Scenes are murky — large dead grey walls, weak mid-ground contrast.

## Next actions, in order

1. Finish the four modes (re-run the workflow above).
2. Run the gauntlet: `tools/gauntlet.js` is written and ready — builder → capture steward → blind
   critic per piece, looping while ours loses. Launch it via `Workflow({scriptPath: ".../tools/gauntlet.js", args: {pieces: [...], maxRounds: 4}})`.
   The batch cap is an orchestration checkpoint, **not** the exit condition; the exit is winning.
3. Fix the three art losses above — they are the likeliest first critic verdicts.

## Queued by the user, NOT started

### Advertiser self-serve ad layer
"add the ad in game layer where advertisers can buy ads in the game". The interesting, genuinely
novel part is **in-world ad surfaces** — billboards as voxel geometry inside the arenas — on top of
the DOM slots that already exist. Building it means an ad server: inventory, slot targeting,
impression and click tracking, and a buyer console.

Two things to settle before writing code, because they change the design:
- **Advertiser-uploaded creative is untrusted third-party content.** It needs moderation, size and
  format limits, and sandboxing. Do not render arbitrary uploaded HTML/JS into the game page.
- **Real money needs explicit setup.** Build against a mock gateway behind a provider interface;
  wiring a live payment processor or a real ad network is a decision for the user, not a default.

### GTA mode
"look at old GTA games and make quests". **The bar is unresolved and this is the blocker.** Every
other mode has a fetchable opponent; this one does not yet.
- archive.org has no browser-playable GTA 1/2 emulator item (the identifiers that look right are
  download-only uploads of commercial games).
- playclassic.games has a GTA page but it produced **no canvas** when driven — it did not run.
- The legitimate path: **GTA 1 and GTA 2 were officially released as freeware by Rockstar**, so a
  clean DOSBox/browser build of those is obtainable in principle. Find one that actually runs before
  promising the mode, or pick a different bar. Do not fake this comparison.

What GTA mode would actually need on top of the existing spine: vehicles and vehicle physics, a city
generator (grid streets, blocks, interiors), pedestrian and traffic AI, a wanted/heat system, and a
mission scripting layer. The mission layer can reuse the Quest trigger system rather than duplicating it.

### ElevenLabs voices
**Blocker: no API key is configured.** Ask for one before starting.
Design notes that matter for a browser game: generate voice lines **offline as build-time assets**,
never at runtime — runtime API calls cost money per play and add latency. Budget the payload: we are
at 3.3 MB cold and voice lines can dwarf that, so stream them lazily per level rather than bundling.

## Tooling invariants — do not break

`playwright@1.62.1` must stay a root devDependency; it is the measuring apparatus, not test
scaffolding. See `TOOLING.md`. Capture scripts: `capture-ref.mjs` (voxiom), `capture-doom.mjs`
(DOOM 1993), `capture-ours.mjs` (us), `reccanvas.mjs` (60 fps canvas recording — Playwright's own
`recordVideo` cannot see a WebGL canvas), `strip.mjs` (contact sheets), `blind.mjs` (blind A/B pairs).

## Live progress page

https://claude.ai/code/artifact/7fc179b3-ad71-4681-ad40-38f20e75f672
Regenerate with `node progress/build.mjs` (reads `progress/state.json`), then republish **the same
file path** to keep the URL.
