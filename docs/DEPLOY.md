# Deploying Doomcraft

## What ships today, and why it is enough

**The static build still runs the whole game client-side, and that is the default.** Boot brings up
the authoritative room in a Web Worker in the tab, so all four modes — Quest, Builder, Horde and
Deathmatch against bots — are **completely playable from static hosting with no server at all, at
$0**. Measured on the shipped bundle against a dumb file server with no game server anywhere: boots
in 476 ms, all four modes playable, zero off-origin requests.

Production bundle: **1.9 MB**, time-to-interactive ~305 ms (voxiom.io: 12.6 MB, 3,161 ms).

**Online multiplayer is now wired, and it is opt-in per deployment.** `game.ts` no longer calls
`createLocalServer()` unconditionally: `GameSession` (`client/src/net/session.ts`) picks the Worker
room or a WebSocket per mode, and a build with no server configured never looks for one. The two
deployments are the *same bundle* — see `docs/ONLINE.md` §3 for how the server tells the page it
exists. There are now two ways to ship:

| | Static (Vercel) | Node origin (`Dockerfile`) |
|---|---|---|
| Cost | $0 | a box |
| Modes | all four, offline, against bots | all four, plus Deathmatch against people |
| Rooms per process | n/a | up to `DOOMCRAFT_MAX_ROOMS` (`ModeRouter`), was 1 |
| CSP | `style-src-elem 'unsafe-inline'` | nonce-based (see below) |

They compose: serve the client from the static host and point it at a room fleet with
`VITE_DOOMCRAFT_SERVER`, or serve both from the Node origin and configure nothing.

## Static deploy (current)

```bash
npx vercel            # preview
npx vercel --prod     # production
```

`vercel.json` sets the build, the immutable cache headers for hashed assets in `/a/` and `/c/`, and
the security headers.

## The CSP difference, stated rather than hidden

The Node server (`server/src/index.ts`) serves a **nonce-based** CSP: `style-src-elem` is nonce-only,
so a `<style>` element injected by a compromised script cannot execute. A static host cannot do that —
there is no per-response server pass to mint a nonce — so `vercel.json` uses
`style-src-elem 'self' 'unsafe-inline'` instead.

**This is weaker, and here is exactly how much.** The relaxation lets injected `<style>` elements
apply. It does **not** relax `script-src`, which has no `'unsafe-inline'` and no `'unsafe-eval'`, so
it does not let injected script run. The realistic attack it re-opens is CSS-based exfiltration and
UI spoofing, not code execution.

That trade is acceptable **only while there is no third-party content on the page**. The moment a
real ad tag ships (see `docs/SPONSORS.md` — the owner has chosen to run programmatic networks), the
static host is no longer adequate and the game must be served from the Node origin with its nonce
CSP, or the ad frame must be isolated to a separate origin. Do not let this drift.

## Deploying the rooms — `docs/ONLINE.md`

```bash
docker build -t doomcraft .
docker run -p 8080:8080 -v doomcraft-data:/data \
  -e DOOMCRAFT_ORIGINS=https://doomcraft.example doomcraft
```

`docs/ONLINE.md` is the full contract: every environment variable, the directory/matchmaking API, the
room-key scheme, the graceful drain, and what is verified by which test. The short version: `/health`
is the readiness probe (200, or 503 while draining — never point *liveness* at it), `DOOMCRAFT_DATA`
must be a volume or every restart is a fresh profile table, and `DOOMCRAFT_DRAIN_MS` must be shorter
than the orchestrator's kill grace period.

## What is NOT deployed by this

- **Online multiplayer, on the static host.** The wiring ships in the bundle, but
  `doomcraft.vercel.app` has no server behind it and `VITE_DOOMCRAFT_SERVER` is empty, so it stays
  offline-only by construction. Deploying the `Dockerfile` somewhere is the remaining step.
- **Persistent Builder worlds.** `server/src/worlds.ts` is still mounted by nothing: a
  `builder:<world>` room routes and simulates correctly, but the world is generated rather than
  loaded and nothing is saved.
- **Persistence beyond the device.** Profiles now have a real home (`DOOMCRAFT_DATA`) when the Node
  server runs; on the static host saves are still local and there is no account backend.
- **Ads, billing, sponsors, economy.** Specced, not built.

## The upgrade path — built, see `docs/PATCHING.md`

Patching uses **three independent version axes**: `PROTOCOL_VERSION` gates a connection against a
supported **window** (`checkProtocol` in `shared/src/version.ts`; strict equality made every deploy a
fleet-wide logout), `CONTENT_VERSION` is **pinned per room** at construction so no in-flight match
has its balance changed underneath it, and `BUILD_ID` gates nothing and exists for bug reports.
**Rooms are the deploy unit** — `POST /api/admin/drain` stops a host taking on anything new (a new
room, and a new player into a room it already has) while every match already on it runs to
completion, so the host empties on the match clock instead of on the 30-minute deadline. `/health`
turns 503, and `/api/rooms` and `/api/quickplay` report the same drain and hand out nothing, so
neither the load balancer nor the matchmaker keeps sending players at a host that is leaving.
Rollback is a routing change.

The static client's half now ships too: **`dist/sw.js`** (from `client/public/sw.js`), whose one
rule is that it **never activates while the player is in a match**. `skipWaiting()` is banned inside
the worker; the page posts `DC_SKIP_WAITING` at the next return-to-menu. The page's predicate is
`game.playing || screen === 'paused'`, because `openPause()` calls `leavePlay()` and the match behind
the pause menu is still running. Who presses the button is the `client_update_prompt` flag, shipped
**on**: on, the menu draws the "Update ready" card and the player chooses; off, `UpdateController`
applies the waiting build itself at the next safe moment. Either way the update lands — the flag
decides whether the player is asked, never whether they are updated.

Two things about the static host in particular:

- **`/sw.js` must not be cached long.** `vercel.json` sets `max-age=0, must-revalidate` on it, and
  the page registers with `updateViaCache: 'none'`. A stale `sw.js` pins a fleet to an old delivery
  policy for up to 24 hours, and it is the one file where that is fatal.
- **The worker never caches the document.** On the Node origin the CSP nonce is minted per response
  and stamped into the HTML as it is served; a cached document against a fresh header blocks every
  inline style and the boot script. `client/src/boot/updates.test.ts` asserts the worker returns
  before ever calling `respondWith` for a navigation.

Feature flags are resolved server-side and delivered in-band on `S2C.SESSION_CONFIG`, plus one
cacheable `GET /api/flags` per boot for the menu. Everything the economy and sponsor work needs to
land dark is already here; see `docs/PATCHING.md` §5.

## Rolling a room host BACK past a profile schema bump

`PERSIST_VERSION` (`server/src/persistence.ts`) is now **4** — the bump that added the `economy`
section where Scrap lives. A profile is not patched on load; `migrateProfile` rebuilds it from a
whitelist literal and stamps the current version on it, which means a rollback is the one moment a
schema bump can destroy player data.

From v4 forward this is handled: `StoredProfile._unknown` carries every top-level key this build
does not recognise and `serialiseProfile` puts it back at the top level on the way to disk, so a v5
profile opened by a v4 host comes back out with its v5 fields intact. `shared/src/saves.ts` has done
the same for the browser's local save since it shipped; profiles had nothing until now.

**And that sentence was true only of TOP-LEVEL keys until the Phase 0 commit**, which is worth
stating because the gap was in the likeliest place: `collectUnknownProfileKeys` walked
`Object.entries(raw)` and stopped, so a v5 field added *inside* `economy` — the natural home for a
second currency or a season — was annihilated by a v4 rollback, silently, with no counter and no log
line. The guard now runs one level down as well, over the sections named in
`GUARDED_PROFILE_SECTIONS` (`progress`, `settings`, `loadout`, `entitlements`, `stats`, `economy`),
with three properties worth knowing:

- The known sub-keys are **derived** from the section this build just rebuilt, not listed a second
  time, so the guard cannot rot when a field is added to `StoredEconomy`.
- `bindings` is deliberately **not** guarded: its keys are the data (`action -> key code`), so
  "unknown key" has no meaning there and a guard would write every custom binding twice.
- The bags live under a single top-level `_nested` key on disk, which a build with only the flat
  guard carries through as an ordinary unknown — so rolling back *past* this change is lossless too.

The limit, stated rather than discovered later: this protects a **newer** profile read by an older
build. A forward MIGRATION step that rewrites a section wholesale (the v3 -> v4 economy step does)
still drops sub-keys it does not name, because it runs first and rewrites the input. That direction
is a migration an author is looking at, not a silent rollback.

**The one case that is NOT covered is v4 → v3**, because a v3 binary has no bag to put anything in.
A v3 host that reads a v4 profile writes it back as v3 and every Scrap balance on it is gone for
good. So:

- Rolling the room fleet back to a pre-v4 build is a **data-destroying** operation, not a routing
  change. Take the profile store out of the path first (or accept the loss deliberately).
- The rule generalises: a rollback across a `PERSIST_VERSION` boundary is safe **downward from any
  version that has the `_unknown` guard**, and unsafe from v4 to anything older.
