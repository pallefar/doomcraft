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
**Rooms are the deploy unit** — `POST /api/admin/drain` stops a host creating new rooms while every
match already on it runs to completion, and `/health` turns 503 so the load balancer stops sending
players by itself. Rollback is a routing change.

The static client's half now ships too: **`dist/sw.js`** (from `client/public/sw.js`), whose one
rule is that it **never activates while `game.playing === true`**. `skipWaiting()` is banned inside
the worker; the page posts `DC_SKIP_WAITING` at the next return-to-menu.

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
