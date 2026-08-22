# Online multiplayer — how it is wired, and how to run it

Two things were built, tested, and connected to nothing:

- `client/src/game/game.ts:446` called `createLocalServer()` **unconditionally**, so every mode ran
  the authoritative room in a Web Worker in the tab and the entire server tier — `room.ts`, `sim.ts`,
  `net.ts`, `world.ts`, `bots.ts`, `worlds.ts` — had no shipped client that talked to it.
- `ModeRouter` (`server/src/modes.ts`) was referenced by nothing outside the file it lives in — not
  even by a test — while `server/src/index.ts` constructed exactly one `Room` and therefore capped
  the whole process at 32 players.

Both are now wired. This document is the contract for operating the result.

---

## 1. The shape of it

```
                     ┌─────────────────────────────────────────────┐
   browser           │  server/src/index.ts                        │
  ┌────────────┐     │                                             │
  │ NetClient  │     │  GET /health          200 / 503 (draining)  │
  │            │     │  GET /api/rooms       the room list         │
  │ createTran-│     │  GET /api/quickplay   "where do I play?"    │
  │ sport() ───┼──┐  │  POST /api/rooms/private  a join code       │
  └────────────┘  │  │                                             │
        ▲         │  │  WS  /ws?mode=&level=&world=&skill=&code=   │
        │         └──┼──────► ModeRouter.route() ──► Room #1..#N    │
  ┌─────┴──────┐     │                              (lockMode)      │
  │GameSession │     └─────────────────────────────────────────────┘
  │            │
  │  local ────┼──► createLocalServer()  ── the same Room, in a Worker
  └────────────┘
```

**One seam, two implementations.** `NetClient` takes a `ClientTransport`
(`client/src/net/transport.ts`). A WebSocket is one; the Worker running the whole authoritative stack
is another. `GameSession` (`client/src/net/session.ts`) decides which, and hands `NetClient` a
*factory* rather than a transport — `NetClient` calls it on the first connect and on every reconnect,
which is what lets a client move between the two without a second copy of the client.

**Routing happens at upgrade time, from the URL — not from `C2S_MODE.SELECT`.** The server has to
pick a room before it attaches the socket to one. A client that attached first and selected afterwards
would either reconfigure a stranger's match or have to be migrated between rooms mid-session. So the
mode travels in the query string, and rooms created by the router are constructed with
`RoomOptions.lockMode`, which makes them answer a `SELECT` with their real context and change nothing.
Without that lock, one joiner sending `SELECT quest` re-plans the Deathmatch everybody else is in —
and even a *matching* `SELECT` would discard the operator's `DOOMCRAFT_BOTS` and honour the client's
`MSF_NO_BOTS` flag, letting one player empty a public arena. `server/src/online.test.ts` pins both.

---

## 2. Which modes go where

| Mode | Where it runs | Why |
|---|---|---|
| Quest | Worker, always | Single-player campaign. No opponents, so a server adds latency and cost and nothing else. Works on a plane. |
| Builder, device-local world | Worker | Same. |
| Builder, named world | Server | The world is shared; that is the whole feature. |
| Horde | Worker, for now | Co-op, but there is no matchmaking UI for it yet, so a player sent to a server would sit alone in a room that costs a core. Add it to `ONLINE_MODES` the day the room list can show "2/4 on wave 7". |
| Deathmatch | Server, when one is reachable | Being online is the point. |
| Anything with a join code | Server | A code names a room on a server. |

The policy is one exported set, `ONLINE_MODES` in `client/src/net/session.ts`. Nothing else encodes it.

---

## 3. Offline is the default, and it is load-bearing

`https://doomcraft.vercel.app` is static hosting with no server behind it. The client resolves a
server URL from exactly five sources, in order (`client/src/net/serverConfig.ts`):

1. `?server=wss://host` — one match. `?server=off` clears a sticky override.
2. `localStorage['doomcraft:server']` — sticky, written by the query param.
3. `<meta name="doomcraft-server" content="self">` — **stamped into the document by
   `server/src/index.ts` as it serves it.** This is why the Docker image needs no client
   configuration at all: the host that answered the request is the host with the rooms, and it says
   so. A static host never stamps it, so the *identical bundle* stays offline there.
4. `VITE_DOOMCRAFT_SERVER` — baked at build time, for a static deploy whose rooms are on another
   origin.
5. `vite dev` only: same-origin, because `client/vite.config.ts` already proxies `/ws` to
   `localhost:8080`.

**All five absent is a first-class answer, not a failure.** Verified end to end: the built bundle on
a dumb file server with no game server anywhere boots in 476 ms, plays all four modes, and makes zero
off-origin requests.

Three separate things then guarantee a configured-but-broken server never becomes a spinner:

- **The probe.** `GameSession.start` asks `/health` behind an `AbortController` with a 1.5 s deadline
  before it ever opens a socket. DNS failure, TLS failure, connection refused, a 500, a slow box and
  a host that is draining all resolve to the same answer — `null` — and all produce a local session.
  The answer is cached for 15 s and warmed during boot, so clicking Play does not pay a round trip.
- **The WELCOME deadline.** A server that *accepts* the socket and then says nothing is worse than
  one that refuses it. `REMOTE_CONNECT_DEADLINE_MS` (6 s) gives a remote session one chance to
  produce a WELCOME; missing it brings the Worker room up instead.
- **The close.** A remote session that closes for good — refused, `1013 server full`, protocol
  mismatch — falls back rather than leaving the player on a dead menu.

The fallback happens **once per match entry**, so a flapping server cannot loop the player between
two worlds. Killing the server mid-match puts both browsers back in a live local room in a few
seconds, `status=playing`, with terrain.

> **Interaction with the deploy drain** (`docs/PATCHING.md`): `/health` reports `ok:false` for the
> shutdown drain *and* for the deploy drain, and `probeServer` refuses both — as do `/api/rooms`
> (`draining:true`, empty list) and `/api/quickplay` (`503`, no ticket). A draining host admits nobody
> new into any room, including the ones it is already running, so the client refusing it up front and
> the host refusing it at HELLO now agree: this client plays locally. On a fleet the load balancer
> routes them to a fresh host and nobody notices; on a single box it means the drain window is
> offline-only. A client that ignores all three and connects anyway is closed with `4004` and
> `HOST_DRAINING` — "your next match starts on the new one" — rather than being seated in a match on a
> host that is leaving.

---

## 4. Environment

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket port. |
| `HOST` | `0.0.0.0` | Bind address. |
| `DOOMCRAFT_DATA` | `<repo>/server/.data` | `JsonFileStore` root: profiles, XP, entitlements. **Mount a volume here** or every restart is a fresh device table. |
| `DOOMCRAFT_STATIC` | `<repo>/dist` | Built client. Point it at an empty directory to run rooms only. |
| `DOOMCRAFT_LEVELS` | `<repo>/content/levels` | The authored campaign. A `?level=` naming something not installed resolves onto one that is. |
| `DOOMCRAFT_ORIGINS` | *(unset — any)* | Comma-separated `https://host[:port]` allowlist for the `/ws` upgrade and the JSON API. **Set it** the moment the client is served from a different origin than the rooms. A request with no `Origin` header is always allowed: that is a load test or a health probe, and a browser cannot forge one. |
| `DOOMCRAFT_MAX_ROOMS` | `32` | Rooms per process. 32 rooms x 32 players is far past what one box wants; size it from `docs/INFRASTRUCTURE.md`, not from here. |
| `DOOMCRAFT_ROOM_IDLE_MS` | `120000` | How long an empty room lingers before the sweeper stops and forgets it. |
| `DOOMCRAFT_DRAIN_MS` | `25000` | How long SIGTERM waits for live matches. **Must be shorter than the orchestrator's kill grace period** (30 s on both Compose and Kubernetes) or the process is SIGKILLed mid-drain and the drain is a comment rather than a behaviour. |
| `DOOMCRAFT_PREWARM` | `1` | Build the default room at boot so the first player never waits for terrain. `0` to disable. |
| `DOOMCRAFT_MODE` | `deathmatch` | Mode a socket with no `?mode=` gets. Keeps a bare `/ws` — which is what `tools/loadtest.mjs` opens — working. |
| `DOOMCRAFT_SEED`, `DOOMCRAFT_BOTS` | *(mode defaults)* | Router-wide plan overrides. A locked room keeps them; a client cannot override them. |
| `DOOMCRAFT_JOURNAL_DAYS` | `400` | Retention for the reward journal at `<DOOMCRAFT_DATA>/journal/<date>.ndjson`. At the bound the oldest day file is deleted whole, and a balance can no longer be reconstructed from before that day — `GET /api/admin/journal` reports `fromDay` so a truncated sum is never read as a balance. |
| `DOOMCRAFT_FINANCIAL_DAYS` | `3650` | Retention for `<DOOMCRAFT_DATA>/financial/<date>.ndjson`, which holds purchases and refunds. Longer because it is a statutory record, and erasure pseudonymises these rows instead of deleting them. No producer writes here yet — `POST /api/entitlement` 404s until a charging provider is bound. |
| `DOOMCRAFT_TRUST_PROXY` | `0` | Read the client address from `x-forwarded-for`. **Only behind a proxy you control.** |
| `DOOMCRAFT_SPONSOR_ORIGIN`, `DOOMCRAFT_CSP_REPORT_URI`, `DOOMCRAFT_CSP_REPORT_ONLY` | — | Pre-existing CSP knobs, see the header of `server/src/index.ts`. |

Client build-time: `VITE_DOOMCRAFT_SERVER` (empty by default — an empty build is offline-capable).

---

## 5. The directory API

Stateless except for a bounded in-memory table of join codes (at most 512, swept on a timer). It is
**never on the path between clicking Play and shooting** — a client can open `/ws?mode=deathmatch`
directly and the router creates or reuses a room that is *already ticking with bots in it*. The bar
(`ref/BAR.md` weakness #5) takes ~25 s from click to shooting because it queues you into a lobby. We
never queue anybody.

| Endpoint | Answer |
|---|---|
| `GET /health` | `200 {ok, draining:false, fleet:{rooms,humans,players,connections}}`, or **`503`** with `draining:true`. Point **readiness** here. Do **not** point liveness here: a draining host is unhealthy on purpose. |
| `GET /api/rooms[?mode=]` | Public rooms, busiest first. Full rooms are listed with `open:false` rather than hidden. Private rooms are never listed. While **either** drain is running: `{draining:true, rooms:[]}` — nothing here is joinable, so nothing is advertised. |
| `GET /api/quickplay?mode=…[&code=…]` | `{ws, key, humans, fresh}` — the socket URL and how many people are already in it, so the UI can say "3 playing" instead of "searching…". An unknown code is a `404`, never a quiet fall-through to a public room. While either drain is running: **`503`** `{draining:true, ticket:null}`, because a ticket pointing at a host that is leaving is matchmaking undoing the drain. |
| `POST /api/rooms/private` | `{code, ticket}`. **Nothing is constructed here**: a room is 169 chunks and a 20 Hz timer, and a player who copies a code and never uses it must not cost a core. The router builds it on the first socket that arrives with the code. `503` while draining: the code would name a room this host will never build. |
| `GET /api/scoreboard?room=<key>` | That room's scoreboard; without `room`, the busiest one. |
| `GET /api/status` | Every room, plus the directory's own counters. Private join codes are cut out of both `key` and `name`. |
| `GET /api/admin/journal?player=<deviceId>[&since=&limit=]` | **Admin bearer required** (404 without one). A page of that player's reward-journal rows, newest first, plus the RECONCILIATION: the stored balance beside the sum of every delta the journal holds, per currency. A divergence between those two numbers is the only evidence that a payout moved a balance without being recorded, and it is invisible from either number alone. The device id goes in and never comes back out — every `playerId` in the response is an 8-character redaction. |

Room keys are `deathmatch`, `horde`, `quest:<level>:<skill>`, `builder:<world>` — which is also how
two people who picked the same thing end up in the same session — with `#2`, `#3`… as instances fill,
and `~<code>` for a private room. A private key contains a character no public request can produce.

**The join-code table is per-process.** With more than one box it moves into the director tier in
`docs/INFRASTRUCTURE.md` §"Rooms are the deploy unit"; nothing else in `server/src/directory.ts`
changes when it does.

---

## 6. Deploying

```bash
docker build -t doomcraft .
docker run -p 8080:8080 -v doomcraft-data:/data \
  -e DOOMCRAFT_ORIGINS=https://doomcraft.example doomcraft
```

Three stages: dependencies, build (client bundle **and** server bundle from the same tree, so the two
cannot come from different commits), and a runtime whose only npm dependency is `ws`. **191 MB**, and
verified rather than asserted: it builds, boots with the default room pre-warmed and six bots already
fighting in it, serves the client with the `doomcraft-server` meta stamped, passes its own
`HEALTHCHECK`, and exits 0 on `docker stop` after printing `drain complete: every match finished, no
player was dropped`.

The server is bundled with esbuild rather than shipped as `tsc` output, because `tsc` leaves
`@doomcraft/shared` as a bare specifier that the workspace resolves to a `.ts` file Node cannot
execute — running the compiled output would need `tsx` in the runtime image or a second exports map
for dev and test to keep in step. One 0.5 MB ESM file avoids both. `npm run build:server` is the same
command outside Docker.

PID 1 is `node`, not a shell, so `SIGTERM` reaches the drain handler directly.

> Building this image is also what surfaced that **`package-lock.json` contained no entries for the
> three workspaces at all**, so `npm ci` failed everywhere — in the image and in any CI that used it.
> Fixed with `npm install --package-lock-only`: 32 added lines, three workspace links, not one
> dependency version changed.

### The drain

`docs/INFRASTRUCTURE.md` asks for four things. All four, in single-process form:

1. **Stop admitting new players.** `draining` gates the `/ws` upgrade; a late joiner gets `503`. The
   DEPLOY drain (`POST /api/admin/drain`, `docs/PATCHING.md`) is gentler and just as total: the
   upgrade succeeds, and the HELLO is answered with `UpdateReason.HOST_DRAINING` and a `4004` close,
   including for a room that is already running here. Both are what make the drain converge — a host
   that keeps admitting arrivals never empties.
2. **Tell the load balancer.** `/health` flips to `503` — and the HTTP listener deliberately **stays
   up for the whole drain** so it can. Closing it, which is the obvious thing to write, makes the
   probe fail to *connect* rather than answer, and some balancers read that as "retry later". The
   integration test caught exactly this.
3. **Leave live matches alone.** Rooms keep ticking. Nothing is stopped, nobody is moved.
4. **Exit when the last room empties**, bounded by `DOOMCRAFT_DRAIN_MS`. Stragglers past the deadline
   are closed with `1001 going away` — the code a client reads as "reconnect", which with the router
   lands them in a fresh room on the new host.

What is **not** here: migrating a live match to another host. That needs the director tier and a
state handoff the protocol does not have. The bound above is the honest substitute.

---

## 7. What is verified, and how

- `server/src/directory.test.ts` — 24 tests over `ModeRouter` (which had none at all) and the
  directory: same key means the same room, different level/skill/world means different rooms, the
  spill to `#2`, the idle reaper, private keys no public request can produce, code TTL.
- `server/src/online.test.ts` — 8 tests that spawn the **real server binary** and speak the **real
  binary protocol** over **real WebSockets**: two sockets in one room seeing each other's players, a
  second mode in a second room, a join code honoured and an invented one refused, the `lockMode`
  authority hole, quickplay, the origin allowlist, and both halves of the drain.
- `client/src/net/session.test.ts` — 30 tests, all of the negative space: no server, slow server, dead
  server, draining server, a server that dies mid-match, and a probe that resolves after the player
  changed their mind.
- `tools/online-verify.mjs` — **two real Chromium browsers**, driven through the shipped bundle and
  the real menu, plus the offline half. Not in vitest: it needs a build and a browser. Run it as a
  release gate; it exits non-zero on the first failed assertion.

  ```
  npx vite build --config client/vite.config.ts
  node tools/online-verify.mjs            # both halves
  node tools/online-verify.mjs offline    # the static bundle, no server anywhere
  ```

  It asserts, in browsers: the static document advertises no server and the Node one does; boot is
  always the Worker room; all four modes are playable offline with **zero off-origin requests**; both
  browsers enter Deathmatch and land in one room the server reports as `humans: 2`; each sees the
  other's body; a real `w` keypress in one moves the body the other renders; and `SIGKILL`ing the
  server puts both back in a **playable** local room with terrain rather than on a spinner.

---

## 8. Known gaps

- **Mode switching online is a reconnect.** Two rooms are two simulations with two worlds and two
  player ids; moving between them drops the world and re-streams it (~0.8 MB compressed). An in-place
  handover would be a wire change, not wiring — see `docs/CONTRACT.md` §15.
- **Horde and Quest never go online**, by the policy above, even between friends with a code. The
  code path works; the mode policy refuses it. One line in `ONLINE_MODES` when the UI is ready.
- **Builder's persistent worlds are not mounted.** `server/src/worlds.ts` is still unwired: a
  `builder:<world>` room routes correctly and is authoritative, but the world is generated, not
  loaded, and nothing is saved. That is the sixth thing in this repo that compiles and is connected
  to nothing.
- **The join-code table does not survive a restart or a second box.** §5.
- **`ModeRouter.route` is not rate-limited.** Room creation is gated only by `DOOMCRAFT_MAX_ROOMS`, so
  a script can churn through the cap by asking for distinct Builder worlds. Behind a WAF today; it
  wants a per-address budget before it is exposed.
