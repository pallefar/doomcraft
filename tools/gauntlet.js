export const meta = {
  name: 'doomcraft-gauntlet',
  description: 'Per-piece builder/critic loop: build, capture, blind A/B against voxiom.io, repeat until the critic picks ours',
  phases: [
    { title: 'Build' },
    { title: 'Capture' },
    { title: 'Judge' },
  ],
}

// args: { pieces: [id,...], maxRounds: n }
const ROOT = '/Users/karstenhaldan/youtube/doomcraft'
const AB = '/private/tmp/claude-501/-Users-karstenhaldan-youtube/9e8c505b-feeb-47bd-af12-833ebb96376b/scratchpad/ab'
const MAX = (args && args.maxRounds) || 4

const ALL = {
  movement: {
    name: 'Movement',
    question: 'Which one would a Doom player rather run around in for ten minutes?',
    kind: 'motion',
    barShot: 'ref/voxiom/desktop-gameplay.webm',
    brief: `Doom pace. The bar runs at Minecraft speed (~4.3 m/s) with acceleration mush. Target ~9.5 m/s
      with near-instant acceleration, Quake air-strafing, automatic step-up over 1-block ledges, no fall
      damage, and a camera that sells the speed (bob tied to velocity, FOV punch on sprint, landing dip).
      Owned files: client/src/player/controller.ts, client/src/player/camera.ts.`,
  },
  gunfeel: {
    name: 'Gunfeel',
    question: 'Which shot feels like it hit something?',
    kind: 'motion',
    barShot: 'ref/voxiom/desktop-gameplay.webm',
    brief: `The most winnable piece in the project. Measured fact: across 1.2 s of continuous mouselook the
      bar's held item does not move one pixel — no sway, no bob, no kick, no muzzle flash, no shake, no
      hitmarker. Build all of it: spring-damper viewmodel kick per weapon, additive muzzle flash with a
      real point light, tracers, impact sparks that inherit the hit surface colour, trauma-based screen
      shake, a crosshair that blooms with spread, and a hitmarker with a distinct kill variant.
      Owned files: client/src/engine/viewmodel.ts, client/src/engine/fx.ts, client/src/game/weapons.ts.`,
  },
  enemies: {
    name: 'Enemies',
    question: 'Which one is a threat rather than a target?',
    kind: 'motion',
    barShot: 'ref/voxiom/desktop-gameplay.webm',
    brief: `The bar is PvP-only — it has no enemies at all, so any competent horde wins on presence alone.
      That makes the real risk shipping something that is merely present. Four Doom archetypes that read
      instantly at a glance and behave differently under pressure: a rusher that closes distance and
      commits, a hitscan trooper that strafes and uses cover, a slow tank that punishes greed, a flyer
      that forces you to look up. They must path over terrain that is being blown apart mid-chase.
      Owned files: server/src/bots.ts, plus enemy rendering in client/src/engine/.`,
  },
  terrain: {
    name: 'Terrain & destruction',
    question: 'Which is a fighting space, and which is scenery?',
    kind: 'still',
    barShot: 'ref/voxiom/desktop-08-combat.png',
    brief: `The bar's world is pretty and useless to fight in — an open beach with no cover, no sightline
      discipline, no verticality, flat lighting with no AO and no fog so the whole scene reads as one mass.
      Build arenas: cover at chest height, flanking routes, verticality you can rocket-jump, dark interiors
      against bright exteriors, lava that actually lights the room. Destruction must matter — a rocket
      should open a new sightline. Note the bar's blocks ARE textured; match that and then beat it with AO.
      Owned files: client/src/world/terrain.ts, client/src/world/destruction.ts,
      client/src/engine/material.ts, client/src/engine/mesher.ts (AO).`,
  },
  netcode: {
    name: 'Netcode',
    question: 'Which one still feels direct at 120 ms RTT and 3% loss?',
    kind: 'numbers',
    barShot: null,
    brief: `Judge by measurement under emulated latency, not by looks. Client prediction with server
      reconciliation, entity interpolation at a 100 ms render delay, lag-compensated hitscan, and a
      smoothed correction that never snaps the camera. Prove it: position drift between prediction and
      server sim, corrections per minute, and the visible camera error when a correction lands.
      Owned files: client/src/net/client.ts, server/src/net.ts, server/src/sim.ts.`,
  },
  mobile: {
    name: 'Mobile controls',
    question: 'Which can you actually aim and shoot with, one thumb per side?',
    kind: 'still',
    barShot: 'ref/voxiom/mobileland-08-combat.png',
    brief: `Four measured openings. The bar REFUSES to play in portrait ("Please rotate your screen") — we
      play in both. The bar has NO fire button: aiming and shooting are the same gesture, which is a
      genuine design failure. Its controls are near-invisible translucent glyphs on bright terrain, and it
      ships the desktop HUD unchanged to a 412 px-tall screen. Build: a real left stick with dead-zone and
      radius feedback, a dedicated fire pad with optional auto-fire, a modest aim-assist cone, high-contrast
      controls that survive a bright background, and a HUD re-laid-out for a short viewport.
      This piece also owns the hard number: 60 fps median / 55 fps 1% low at 412x915 under 4x CPU throttle.
      Owned files: client/src/player/touch.ts, client/src/hud/mobile.ts.`,
  },
  hud: {
    name: 'HUD',
    question: 'Which tells you your state in a single glance without cluttering the centre?',
    kind: 'still',
    barShot: 'ref/voxiom/desktop-08-combat.png',
    brief: `The bar's HUD is competent and you must not assume you beat it by default: corners only, clean
      centre, minimap, armour/health bars with numerals, a 5-slot hotbar with 3D voxel item thumbnails and
      a white selected outline, a chat/kill feed. Its one real weakness is the dead static crosshair. Beat
      it on damage legibility — directional damage indicators, a health bar that reads at a glance when you
      are about to die, ammo you never have to hunt for, and a crosshair that communicates spread and hits.
      Owned files: client/src/hud/hud.ts.`,
  },
  menus: {
    name: 'Menus & saves',
    question: 'Which gets you into a fight faster, and which loses your settings?',
    kind: 'still',
    barShot: 'ref/voxiom/desktop-00-menu.png',
    brief: `The bar's menu is strong — a live in-engine voxel scene behind the UI, a real tab bar
      (Game/Account/Leaderboard/Loadouts/Shop/Updates), a stat table, a region picker, three mode tiles.
      Match that production value, then beat it on the two things it fumbles: it takes ~25 s of matchmaking
      before you shoot, and its in-game pause menu is three bare buttons with no graphics settings. Build a
      full settings surface (sensitivity, FOV, render distance, quality preset, audio, full key rebinding,
      colourblind modes) that is reachable in-game, and persistence that survives a hard refresh.
      Owned files: client/src/ui/menu.ts, client/src/ui/settings.ts, client/src/save/*.ts.`,
  },
  ads: {
    name: 'Ads & purchase',
    question: 'Which monetises without making you resent it, and does the layout hold when the slot fills?',
    kind: 'still',
    barShot: 'ref/voxiom/desktop-00-menu.png',
    brief: `The bar reserves real slots — a 300x250 right rail and a 728x90 bottom banner — and the page does
      NOT reflow when they fill. Match that discipline exactly; a layout that jumps when an ad loads is an
      automatic loss. Then take the surface it leaves unused: an interstitial between matches with a visible
      countdown and a skip, and a rewarded video the player chooses. Plus the one-time purchase that removes
      all of it, with the entitlement stored server-side against the device/account and honoured instantly
      without a reload. Use a house/mock ad provider behind a provider interface — do not wire a real ad
      network account. The purchase flow is a real Stripe-shaped flow with a mock gateway in dev.
      Owned files: client/src/ads/*.ts, client/src/store/*.ts, server/src/entitlements.ts.`,
  },
  loadtime: {
    name: 'Load time',
    question: 'Which is shooting first? Numbers only.',
    kind: 'numbers',
    barShot: null,
    brief: `Two numbers to beat: 3.16 s to an interactive menu, and ~25 s from click to actually shooting
      (the bar spends most of that in matchmaking). We start instantly against bots in a local worker, so
      click-to-shooting should be under 2 s. Also beat 12.6 MB cold transfer. Code-split, defer the ad SDK,
      stream chunks by interest radius, and generate terrain in a worker so the main thread never blocks.
      Owned files: client/vite.config.ts, client/src/main.ts, client/index.html, and the boot path.`,
  },
}

const PIECE_IDS = (args && args.pieces) || Object.keys(ALL)

const COMMON = `
Project: **Doomcraft** — DOOM's combat and pace inside a destructible Minecraft-style voxel world,
in the browser, desktop and mobile, with in-game ads, a one-time ad-removal purchase, saves and settings.

PROJECT ROOT: ${ROOT} (use absolute paths)

Read ${ROOT}/ref/BAR.md before anything else. The bar is the live game voxiom.io and every number in
that file was measured, not guessed. Reference captures are in ${ROOT}/ref/voxiom/ — Read the PNGs as
images, they are the point.
`

function oursWonRaw(verdict, piece, swap) {
  const ours = piece.barShot ? (swap ? 'B' : 'A') : 'B'
  return verdict.winner === ours
}

async function runPiece(pieceId, idx) {
  const piece = ALL[pieceId]
  if (!piece) return null
  let gap = null
  let history = []

  for (let round = 1; round <= MAX; round++) {
    // ---- BUILD ----
    const build = await agent(`${COMMON}

You are the BUILDER for the piece: **${piece.name}**.
The question this piece is judged on: *${piece.question}*

${piece.brief}

${round === 1 ? 'This is round 1. Build it.' : `This is round ${round}. A harsh critic compared the last
round against the bar **blind** and OURS LOST. The single biggest gap it named:

    ${gap}

Fix that gap. Do not rewrite everything; do not chase other improvements. Land that one thing hard.
Previous rounds: ${history.join(' | ')}`}

Rules:
- Write real working code. \`npx tsc -b --pretty false\` and \`npx vitest run\` must both pass when you finish.
- Do not touch the capture scripts in tools/ or anything under ref/ — that is the measuring apparatus.
- Do not edit progress/state.json.
- Stay inside your owned files where the brief names them. If you must touch a shared file, keep the
  change minimal and say so.
- Never regress the performance contract: 60 fps median / 55 fps 1% low at 412x915 under 4x CPU throttle.

Return what you changed and, specifically, how you addressed the gap.`,
      { label: `build:${pieceId}:r${round}`, phase: 'Build',
        schema: { type: 'object', required: ['changed', 'addressedGap'], properties: {
          changed: { type: 'string' }, addressedGap: { type: 'string' } } } })

    if (!build) { history.push(`r${round}: builder died`); continue }

    // ---- CAPTURE (steward: knows the mapping, the critic never sees this agent) ----
    const swap = ((round + idx) % 2) === 1
    const abDir = `${AB}/${pieceId}-r${round}`
    const cap = await agent(`${COMMON}

You are the CAPTURE STEWARD for the piece **${piece.name}**. You do not judge anything. You produce
the evidence a blind critic will judge, and you must produce it honestly.

1. Boot our game (\`npm run dev\` from ${ROOT}, backgrounded) and run
   \`node tools/capture-ours.mjs\` (add \`--mobile\` for the mobile piece). Confirm the screenshots
   actually contain a rendered game — READ THE PNG YOURSELF. A black canvas or a stuck loading screen
   is a capture failure, not a result: debug it and repeat until you have real frames.
${piece.kind === 'motion' ? `2. Also record OUR motion at 60 fps using the same technique as the bar:
   \`tools/reccanvas.mjs\` (canvas.captureStream + MediaRecorder). Playwright's recordVideo does NOT
   capture a WebGL canvas — do not use it. Then build a contact sheet with
   \`node tools/strip.mjs <ourVideo> <out.png> 4 3 <start> <end>\` and the matching sheet from the
   bar's recording ${piece.barShot} over a comparable window and action.` :
piece.kind === 'numbers' ? `2. This piece is judged on numbers. Produce the measurements the critic needs and
   write them to a JSON file. Measure the same thing for the bar where the bar can be measured
   (ref/voxiom/*-metrics.json already holds its load and fps numbers).` :
`2. Pick OUR frame that corresponds to the bar's frame ${piece.barShot} — same viewport, same moment in
   the flow.`}
${piece.barShot ? `3. **Write the metrics into the blind directory under NEUTRAL names.** This is the step that
   makes the comparison honest and the last run failed entirely because it was missing: every critic
   had to open \`shots/ours-*-metrics.json\` to check the numbers, which told them which side was
   ours, and all seven verdicts were discarded as contaminated.
   After building the pair below, write two files — \`${abDir}/A-metrics.json\` and
   \`${abDir}/B-metrics.json\` — matching the SAME A/B assignment as the images. Each must contain
   only the comparable measurements (fpsMedian, fps1pctLow, medianMs, timeToInteractiveMs,
   transferBytes, viewport, cpuThrottle, headed) with **every filename, path and product name
   stripped**. Do not write a mapping, a note, or any other file into that directory.
   Where a number does not exist for the bar, write null — do not invent one, and do not omit the key.
   **Capture ours under the same conditions as the bar** (headed, and the same viewport and throttle),
   or the measurement half is void and you must say so in \`caveats\`.

4. Build the blind pair. Run EXACTLY:

     node ${ROOT}/tools/blind.mjs <OUR_IMAGE> <BAR_IMAGE> ${abDir} ${swap ? '1' : '0'} ${piece.kind === 'still' && /menu/.test(piece.barShot) ? 'menu' : 'game'}

   where BAR_IMAGE is ${piece.kind === 'motion' ? 'the contact sheet you made from ' + piece.barShot : ROOT + '/' + piece.barShot}.
   That writes ${abDir}/A.png and ${abDir}/B.png and nothing else. **Do not write the mapping anywhere.**
   Do not echo it. Do not leave notes in that directory. The critic must not be able to recover it.` : '3. No image pair for this piece — numbers only. Write the two neutral metrics files described above into ' + abDir + ' anyway.'}

Return the paths and an honest note on any way the capture is not apples-to-apples.`,
      { label: `capture:${pieceId}:r${round}`, phase: 'Capture',
        schema: { type: 'object', required: ['ok', 'whatIsInOurFrames', 'metrics', 'caveats'], properties: {
          ok: { type: 'boolean' },
          whatIsInOurFrames: { type: 'string', description: 'what you actually saw when you read our PNG' },
          metrics: { type: 'string', description: 'our fps median, 1% low, time to interactive; and the bar comparison' },
          caveats: { type: 'string', description: 'any way this comparison is not fair' },
        } } })

    if (!cap || !cap.ok) { history.push(`r${round}: capture failed`); gap = gap || 'Capture failed — the build may not run.'; continue }

    // ---- JUDGE (fresh context, blind) ----
    const verdict = await agent(`Read ${ROOT}/docs/CRITIC.md and follow it exactly. You are a harsh critic.

The piece under review: **${piece.name}**
The only question that matters: *${piece.question}*

${piece.barShot ? `Two images are waiting in **${abDir}**: \`A.png\` and \`B.png\`. One is ours, one is a
shipped commercial game. Which one is which is NOT recorded anywhere on disk — it is held in the
orchestrator's memory. Read both images. Do not go looking for the mapping: do not open ${ROOT}/ref/,
do not grep the repo, do not inspect the capture scripts. If you work it out anyway, say so in
\`contaminated\` and your verdict will be discarded.

Judge ONLY the question above. Ignore which looks more "finished" overall.` :
`This piece is judged on measurements, not images. Read the numbers the steward produced and
${ROOT}/ref/voxiom/desktop-metrics.json for the bar. Decide which is better on the question above.
Call ours "B" and the bar "A" for the purposes of your verdict.`}

The measurement half. **Read it from \`${abDir}/A-metrics.json\` and \`${abDir}/B-metrics.json\`** —
they use the same A/B labels as the images. Do NOT open anything under \`${ROOT}/shots\` or
\`${ROOT}/ref\`: those paths carry the product name and reading them is what contaminated every
verdict in the previous run. If a metrics file is missing or a value is null, report the measurement
as failed rather than going to look for it elsewhere.

The steward's own honesty note about this comparison:
${cap.caveats}

Return the fields CRITIC.md specifies, plus \`winnersWeakestPoint\`: the biggest remaining weakness in
whichever side WON. When the winner is a shipped commercial game that is interesting; when the winner
is the challenger, that sentence is the entire next round of work. One letter. No scores.`,
      { label: `judge:${pieceId}:r${round}`, phase: 'Judge', effort: 'xhigh',
        schema: { type: 'object', required: ['winner', 'whyOneLine', 'biggestGap', 'winnersWeakestPoint', 'wouldFlipIf', 'numbersChecked', 'contaminated'], properties: {
          winner: { type: 'string', enum: ['A', 'B', 'TIE'] },
          whyOneLine: { type: 'string' }, biggestGap: { type: 'string' },
          winnersWeakestPoint: { type: 'string', description: 'the biggest remaining weakness in the WINNER — this is what drives the next round when the winner is ours' },
          wouldFlipIf: { type: 'string' }, numbersChecked: { type: 'string' },
          contaminated: { type: 'boolean' },
        } } })

    if (!verdict) { history.push(`r${round}: critic died`); continue }

    const oursLetter = piece.barShot ? (swap ? 'B' : 'A') : 'B'
    const oursWon = verdict.winner === oursLetter
    history.push(`r${round}: ${oursWon ? 'WON' : verdict.winner === 'TIE' ? 'tied' : 'lost'} — ${verdict.whyOneLine}`)
    gap = oursWonRaw(verdict, piece, swap) ? (verdict.winnersWeakestPoint || verdict.biggestGap) : verdict.biggestGap

    log(`[${piece.name}] round ${round}: ${oursWon ? 'OURS WINS' : verdict.winner === 'TIE' ? 'tie (= a loss)' : 'ours loses'} — ${verdict.whyOneLine}`)

    if (oursWon && !verdict.contaminated) {
      return { pieceId, name: piece.name, rounds: round, verdict: 'won', gap: verdict.biggestGap,
        why: verdict.whyOneLine, metrics: cap.metrics, history }
    }
    if (verdict.contaminated) log(`[${piece.name}] round ${round}: critic was contaminated — verdict discarded, re-running`)
  }

  return { pieceId, name: ALL[pieceId].name, rounds: MAX, verdict: 'lost', gap,
    why: 'hit the round ceiling for this batch', metrics: '', history }
}

const results = await parallel(PIECE_IDS.map((id, i) => () => runPiece(id, i)))
return results.filter(Boolean)
