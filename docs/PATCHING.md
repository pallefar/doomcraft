# Doomcraft — patching and upgrades

How a change reaches players without dropping any of them.

This is the delivery mechanism for everything that comes after launch. The economy
(`docs/ECONOMY.md`) and the sponsor platform (`docs/SPONSORS.md`) are both meant to ship *through*
this system — merged dark, exercised in production, switched on by a flag — so it is built first and
it is exercised continuously rather than at the moment it is needed.

Design source: `docs/INFRASTRUCTURE.md` §6. This document is the operational half: what to type,
what happens, and what to check.

---

## 0. The one-paragraph version

There are **three version numbers, not one**. `PROTOCOL_VERSION` gates a connection against a
**window** of supported versions, `CONTENT_VERSION` must match **within a room** and is pinned when
that room is built, and `BUILD_ID` gates **nothing** and exists for bug reports. **Rooms are the
deploy unit**: a deploy starts new hosts, marks the old ones draining, and every match already
running finishes where it is. On the client a service worker holds the new bundle until the player
is out of a match. Nothing a player is inside is ever restarted, so nobody is dropped.

---

## 1. The three axes

| Axis | Lives in | Owns | Cadence | Gates a connection? |
|---|---|---|---|---|
| `PROTOCOL_VERSION` | `shared/src/protocol.ts` | wire layout, quantisation, message ids, bitmask bits | a few times a year | **Yes** — against a *window* |
| `CONTENT_VERSION` | `shared/src/version.ts` | levels, weapon tables, mode constants | weekly | **No** — matches *per room* |
| `BUILD_ID` | `shared/src/version.ts` | the bundle hash | every deploy | **Never** |

Their cadences differ by two orders of magnitude. Conflating them is what makes deploys hurt: bump a
"game version" for a typo fix and you have just logged out the fleet.

### `PROTOCOL_VERSION` — a window, not an equality test

```ts
PROTOCOL_VERSION       = 3   // what this build speaks
PROTOCOL_MIN_SUPPORTED = 2   // the oldest it still serves
PROTOCOL_WINDOW_DAYS   = 14  // the promise made to an un-updated tab
```

`server/src/net.ts` used to compare `hello.protocolVersion !== PROTOCOL_VERSION` and close the
socket. Under that rule the first byte of every deploy is a fleet-wide simultaneous logout: the
moment the new binary answers, every connected client is one version behind *by definition*. It now
calls `checkProtocol()` (`shared/src/version.ts`), which is the single place the rule is written.

**The window is a real promise, not a formality.** `PROTOCOL_MIN_SUPPORTED = 2` is honest because
v2 → v3 hid entirely behind the `CAP_INFLATE` capability bit: a v2 client never sets it, so the
server never sends the compressed chunk form, and the two genuinely interoperate.
`server/src/patch.test.ts` proves it by running a real v2 handshake against a real `Room` and
asserting the client gets a playable session, not merely a `WELCOME`.

v1 is deliberately **outside** the window: a v1 decoder cannot skip the `PF_AVATAR` field bit, so it
would mis-parse every spawn record. A window has to be allowed to refuse.

`PROTOCOL_WINDOW_DAYS = 14` is a **placeholder** and is marked as one in the code. Size it properly
the moment there is telemetry: take p99 session length and p99 days-since-last-visit, set the window
at 3× the longer, publish the number, and hold to it.

### `CONTENT_VERSION` — pinned per room

A room stamps the content version and hash it was **constructed** with into `S2C.SESSION_CONFIG`,
and never re-reads them. So:

> A balance patch applies to every **new** room immediately, and **no in-flight match ever has its
> time-to-kill changed underneath it.** Changing weapon damage mid-match is not a rollout strategy,
> it is a bug that looks like one.

The client is *told* the room's content and adopts it (`NetClient.contentVersion`). A client that
disagrees is the one that is wrong, and it stays wrong for the life of that match rather than having
the tables swapped mid-fight.

`packSetHash(installedPacks, CONTENT_VERSION)` (which replaced `contentHashFor(levelHashes)`)
folds in the levels the host actually loaded via the levels pack, so two hosts on the same
`CONTENT_VERSION` with different files on disk — a real operational mistake — produce different
hashes and are visible in `/api/version`.

That last clause was **false from the day it was written until PACKS Phase 0**: `versionDocument()`
called a bare `contentHashFor()` with no level hashes, so every host in the fleet published the same
per-BUILD constant while the correctly folded value went to PLAYERS on `SESSION_CONFIG` and nowhere
else. `versionDocument(contentHash, extra)` now takes the host's real hash as a **required**
parameter — a default is what let it be dropped silently — and `server/src/deploy.test.ts` boots two
processes over level directories differing in one byte and demands two different
`/api/version` `content.hash` values.

### `BUILD_ID` — telemetry only

Stamped by `client/vite.config.ts` (`define: __DC_BUILD_ID__`, from `DOOMCRAFT_BUILD_ID` or
Vercel's `VERCEL_GIT_COMMIT_SHA`) and by `DOOMCRAFT_BUILD_ID` on the server. It appears in
`S2C.SESSION_CONFIG` and in `/api/version`.

If you ever find yourself writing `if (buildId === …)`, you wanted one of the other two axes.

---

## 2. Shipping a change

### 2.1 An ordinary change — no protocol, no content

The common case: a bug fix, a UI change, a new mode surface.

```bash
npx tsc -b --pretty false && npx vitest run     # must be clean and green
DOOMCRAFT_BUILD_ID=$(git rev-parse --short=12 HEAD) npm run build
npx vercel --prod            # static client
# and/or roll the room hosts (§3)
```

Nothing gates. Connected players finish their matches on the old bundle; the new one lands at their
next return-to-menu (§4).

### 2.2 A content or balance change

Content identity is per-pack since `docs/PACKS.md` phase 1: core (mode constants + terrain),
weapons, characters — each with its own declared version and fingerprint on `BUILTIN_PACKS` in
`shared/src/packs.ts`, plus the levels pack folded at boot from what is installed.

1. Edit the tables (`shared/src/weapons.ts`, mode constants, `content/levels/*.json`).
2. `npm run release:verify` — the gate refuses, and prints **which pack** moved and the
   field-level input diff (a levels edit refuses nothing: level files are data, their identity
   rides the levels pack automatically).
3. Bump `CONTENT_VERSION` in `shared/src/version.ts` and, for a build pack, bump that pack's
   `*_PACK_VERSION` and paste its new fingerprint in `shared/src/packs.ts`, **in the same
   commit**. The alarm's contents — the diff — are now the thing you read; the ratchet exists so
   this cannot be forgotten and is not a formality to be silenced.
4. Deploy as §2.1. New rooms get the new balance; live ones finish on the old.

### 2.3 A protocol change

**First: does it need one?** Most changes do not, and a bump is the expensive one because it strands
tabs. Four ways to change the wire without bumping:

1. **Append a trailing field**, guarded by `r.remaining >= k`. `decodeHello` has done this since the
   avatar landed and now does it twice — see the `contentVersion` field.
2. **Append a message id.** An unknown id is ignored (`client.ts` has always had `default: break`,
   and `net.ts` counts it as one violation rather than a disconnect). `S2C.UPDATE_REQUIRED` and
   `S2C.SESSION_CONFIG` were both added this way, at protocol 3, with no bump.
3. **Use a capability bit.** `HELLO` carries `caps: u16`; the server already stores it. A new feature
   reaches new clients while old ones keep the old encoding. This is how `CHUNK_Z` shipped.
4. **Grow a snapshot bitmask at the top bit.** A retired field's bit is **burned, never reused**.

If it genuinely is a layout change:

1. Make the change. `npx vitest run shared/src/version.test.ts` — the **protocol ratchet** fails.
2. Bump `PROTOCOL_VERSION`. Decide `PROTOCOL_MIN_SUPPORTED` **deliberately**: hold it if the old
   version still works (as v2 does), raise it only if it genuinely cannot.
3. Update `docs/CONTRACT.md` §5 in the same change, and the golden vectors in
   `shared/src/version.test.ts` if an existing message's bytes moved.
4. Deploy the SERVER first, and keep the old hosts up for the full window. A server that speaks
   `N` and accepts `N−1` can serve everybody; a client on `N` talking to a host on `N−1` is refused
   with `PROTOCOL_TOO_NEW` and told to find another host.

### 2.4 A schema change to saves

`shared/src/saves.ts` is already an ordered migration chain and `migrateSave` is total.

- Add a `SaveMigration` to `SAVE_MIGRATIONS`, bump `SAVES_VERSION`, add any new top-level key to
  `KNOWN_SAVE_KEYS` **in the same change** (a test fails otherwise).
- **Forward-only and additive.** A new field needs a default an older reader ignores safely.
- **Two-phase field removal**: release A stops writing it, release B — one full window later —
  removes it.
- Multi-version jumps are the normal case for a returning player, and
  `shared/src/saves.test.ts` proves v2 → v4 and v1 → v4 both arrive intact, through the real
  storage path.

---

## 3. What happens to a player mid-match

**Nothing.** That is the design, and it holds because nothing a player is inside is ever restarted.

### The two drains, which are not the same thing

| | Deploy drain | Shutdown drain |
|---|---|---|
| Trigger | `POST /api/admin/drain` | `SIGTERM` / `SIGINT` |
| Budget | `DOOMCRAFT_FORCE_MIGRATE_MS`, default 30 min | `DOOMCRAFT_DRAIN_MS`, default 25 s |
| Refuses | **a new room, and a new player into an existing one** | the WebSocket upgrade outright |
| Live matches | run to completion | get the 25 s the orchestrator allows |
| Owned by | `HostLifecycle` (`server/src/deploy.ts`) | `shutdown()` in `server/src/index.ts` |

A deploy uses the **first**, waits for the host to report `drained`, and only then sends `SIGTERM`.
That ordering is what makes a rollout free of dropped players. Sending `SIGTERM` first collapses the
budget from thirty minutes to twenty-five seconds and turns a graceful rollout into a short outage.

**The deploy drain has two gates, and it needs both.** `lifecycle.guardCreate` wraps the room factory,
which is the one place a room can come into existence, so no new room is built. `lifecycle.admitting`
is passed to every `Room` as `RoomOptions.admitting`, so `net.ts` turns a new HELLO away with
`UpdateReason.HOST_DRAINING` — a 4004 close and "your next match starts on the new one", not a dead
socket.

Gating creation alone reads like the kinder design, and it does not converge. Every existing room
stays open, so `route` keeps handing arrivals into the busy `deathmatch` key, the humans count never
reaches zero, and the host sits in `draining` until `DOOMCRAFT_FORCE_MIGRATE_MS` — a deadline whose
entire cost is `forcedPlayers`, the number this system exists to keep at zero. It is worth naming
what the second gate costs, because it is a real player: your friend is nine minutes into a match
here, you click their invite, and you get the new host instead of their match. A rollout that never
finishes costs more, and it charges it to everybody still inside when the deadline fires.

**The directory honours the same state.** `/api/rooms` answers `draining: true` with an empty list and
`/api/quickplay` answers 503 with no ticket while either drain is running (`notAdmitting()` in
`server/src/index.ts`). Those endpoints used to report the SHUTDOWN flag only, so a deploy-draining
host answered 503 on `/health` while still listing its rooms and still minting tickets pointing at
itself. `server/src/online.test.ts` pins both halves over a real socket.

### The deploy procedure

```bash
# 1. new hosts up, on the new build, alongside the old.
# 2. take the old ones out of rotation. Nobody is dropped.
curl -XPOST -H "Authorization: Bearer $DOOMCRAFT_ADMIN_TOKEN" https://old-host/api/admin/drain

# 3. watch. `deploy.state` goes admitting -> draining -> drained.
watch -n30 'curl -s https://old-host/health | jq .deploy'

# 4. when it says drained, and only then:
kill -TERM $(pidof node)
```

`/health` answers **503** while either drain is running, so a load balancer stops sending new
players by itself. Point *readiness* at `/health`; point *liveness* at nothing, and let the drain
deadline do the killing — a liveness probe that does not tolerate the drain window will kill the
process in the middle of exactly the thing this system exists to protect.

### The bound, and the number that judges it

`forcedPlayers` in `/health`'s `deploy` block is **how many players this deploy actually
interrupted**. It should be zero. If it is not, the drain budget is shorter than a real match, and
that is a configuration bug, not an acceptable cost. The deadline exists so that one AFK player in a
Builder world cannot pin an old binary online forever — "we cannot finish the rollout because of one
idle player" is how a fleet ends up running six versions at once.

### What a refused client is told

Every refusal is sent **twice, in two forms**, because the client that needs the message most is by
definition the one too old to decode it:

- `S2C.UPDATE_REQUIRED` — structured: reason code, the server's protocol and minimum, its content
  version, and a diagnostic string.
- A **WebSocket close code** in the 4000–4999 private range, which every client can read.

| Reason | Close | What the client does |
|---|---|---|
| `PROTOCOL_TOO_OLD` | 4001 | Stop reconnecting; require an update; swap at the next safe moment |
| `PROTOCOL_TOO_NEW` | 4002 | Stop reconnecting; ask the director for another host. **Never** nag the player to update — they already have |
| `CONTENT_UNAVAILABLE` | 4003 | Fetch content, then rejoin |
| `HOST_DRAINING` | 4004 | Ask the director for another host. Not an error |
| `BUILD_REVOKED` | 4005 | Forced update |

`NetClient` stops auto-reconnecting on any of these. Retrying a refusal is a hot loop against a
server that has already said no.

---

## 4. The client: never swap under a player

> **The service worker never activates while `game.playing === true`.**

`self.skipWaiting()` — the line every service-worker tutorial tells you to add — is **banned** in
`client/public/sw.js`. The worker installs, sits in `waiting` indefinitely, and activates only when
the page posts `DC_SKIP_WAITING`, which the page only does when the player is out of a match.
`client/src/boot/updates.test.ts` reads `sw.js` off disk and fails if an unconditional
`skipWaiting()` ever appears in it.

The policy lives in `client/src/boot/updates.ts` (`UpdateController`) and is mounted at the bottom of
`client/src/main.ts`. It hooks nothing in the shell: `#ui[data-screen]` is already the shell's
published state, so a `MutationObserver` on that attribute tells the controller when the player left
a match, and no call site has to remember to say so.

Four cases it has to get right, each with a test:

1. **An update lands mid-match** → held. Swapped at return-to-menu, in a "Restarting to update" beat
   that is fast because every hashed asset the next build shares is already cached.
2. **Two updates land during one match** → the browser discards the first waiting worker when the
   second installs. The controller therefore stores **no worker reference**, only "something is
   pending", and re-reads `registration.waiting` at the instant it swaps. Exactly one swap, to the
   newest build.
3. **First ever visit** → a worker with no controller activates immediately and `controllerchange`
   fires with nobody having asked. No reload: reloading there would flash every first visit.
4. **A protocol-breaking release** → `UpdateReason.PROTOCOL_TOO_OLD` makes the update mandatory. It
   is still not applied during a match. A player mid-match on a build the server will not talk to is
   playing single player, and taking that away to fix a connection they are not using is strictly
   worse than waiting.

### What the worker caches, and the one thing it must not

| Path | Policy |
|---|---|
| `/a/*`, `/c/*` | cache-first, forever — the names carry a hash |
| `/characters/*` | stale-while-revalidate |
| the document | **network only, never cached, no offline fallback** |
| `/api/*`, `/ws`, `/rtc` | untouched |

The document rule is a hard requirement, not caution. `server/src/index.ts` mints a fresh CSP nonce
per response and stamps it into the HTML as it is served, so the nonce in the markup and the nonce in
the header are two halves of **one** response. A cached document against a fresh header blocks every
inline style and the boot script — the game boots to a blank page. It is also how a client gets
pinned to an old bundle forever, because `index.html` is the pointer to the hashed assets.

There is no precache manifest, so a first visit is not offline-capable and a returning visitor is.
That is the trade: a build-time manifest buys first-visit offline in exchange for a build step that
can ship a stale list, on a visit that needed the network anyway.

---

## 5. Landing a feature dark

This is the point of building the patch system before the economy and the sponsor work.

1. **Add the flag** to `shared/src/flags.ts`: append the key to `FLAG_ORDER` (**append only** — a
   retired flag's bit is burned, never reused, or an old client reads the new flag as the old
   feature) and add a `FlagDef` with `kind: 'feature'`, `defaultOn: false`, and a **written blast
   radius**. `shared/src/flags.test.ts` fails without the last two. A flag whose blast radius is not
   written down is a flag nobody dares flip, which is the same as not having one.
2. **Merge the half-built feature behind it.** It ships with every deploy and does nothing.
3. **Exercise it internally**: `force: true` for your own device, or run a host with
   `DOOMCRAFT_FLAGS` set.
4. **Stage it**: `rolloutBp` 100 → 500 → 2500 → 10000. Buckets are stable per player and per flag —
   a player does not gain and lose a feature between matches, and raising the rollout only ever
   *adds* players (asserted in the tests), so nobody has the feature taken away mid-stage.
5. **Kill it** with `force: false`, which beats a rollout that already reached everybody.

```bash
# READ the document first. There is now a GET; there did not used to be, and a
# GET fell through to the SPA fallback and answered 200 with the game's HTML.
curl -H "Authorization: Bearer $DOOMCRAFT_ADMIN_TOKEN" https://host/api/admin/flags

# REVIEW the write before firing it: the resulting document, a diff, the
# blast radius verbatim, and how long the console will make you wait.
curl -XPOST -H "Authorization: Bearer $DOOMCRAFT_ADMIN_TOKEN" \
  -d '{"expectRevision":8,"rules":{"economy_scrap":{"rolloutBp":2500}}}' \
  https://host/api/admin/flags/plan

# turn one on for everybody
curl -XPOST -H "Authorization: Bearer $DOOMCRAFT_ADMIN_TOKEN" \
  -d '{"revision":8,"actor":"you","reason":"scrap held clean for a week at 25%",
       "rules":{"economy_scrap":{"force":true}}}' \
  https://host/api/admin/flags

# FREEZE ALL ROLLOUTS — the one toggle, reachable from a phone
curl -XPOST -H "Authorization: Bearer $DOOMCRAFT_ADMIN_TOKEN" \
  -d '{"revision":9,"frozen":true,"actor":"you","reason":"error rate spiked at 21:40"}' \
  https://host/api/admin/flags

# ...and the same thing safely from a script that read the document first:
# refused with 409 if anybody else edited it in between.
curl -XPOST -H "Authorization: Bearer $DOOMCRAFT_ADMIN_TOKEN" \
  -d '{"expectRevision":8,"frozen":true,"actor":"you","reason":"error rate spiked at 21:40"}' \
  https://host/api/admin/flags
```

**`actor` and `reason` are REQUIRED on every mutating admin route**, including
`POST /api/admin/drain`, and a request without them is a `400` that changes nothing and writes no
audit row. `reason` must be at least 10 characters; `actor` at least 2. Neither is authentication —
one shared bearer admits the request and `actor` is a label, so the row reads the day there are two
operators. Every accepted write appends one line to `<DOOMCRAFT_DATA>/audit/<date>.ndjson` carrying
the document **before and after**, which is what makes an undo a paste rather than an archaeology
project. `GET /api/admin/audit?since=&limit=` reads them back.

**A `rolloutBp` that is not one of `0 / 100 / 500 / 2500 / 10000` is refused with a `400`** unless
the body also carries `"allowCustomRollout": true`. The ladder is the review — a rollout you cannot
type freehand is a rollout you cannot fat-finger from 500 to 5000 — and it is enforced at the route
rather than in the console, because a guard that lives in a panel is a guard `curl` skips by accident.

**`POST /api/admin/flags` is a MERGE, and that is a correction, not a preference.** It used to be a
full replace (`parseFlagConfig` starts from `createFlagConfig()`, whose `rules` are `{}`), which
means the freeze command printed above — the one this runbook tells you to paste at 3 a.m. — **deleted
every force and every `rolloutBp` on the host**. The single most destructive request in the API was
the documented emergency procedure, and the test that covered freeze re-sent the whole rules block,
so the shape prescribed here was never once exercised. `shared/src/flags.ts:nextFlagDocument` is now
the whole rule set, and it is pure:

| In the body | Effect |
|---|---|
| absent | **unchanged** — `frozen`, `revision` and every rule you did not name keep their values |
| `rules: { key: { force } }` | merged field by field; that flag's `rolloutBp` is left alone |
| `rules: { key: null }` | **deletes** the rule, so the flag falls back to its registry default. The only delete there is — deletion by omission is the bug above |
| `expectRevision: n` | compare-and-swap: `409` and **no change at all** unless the live document is at revision `n` |
| `revision: n` | sets it. Omit it and an accepted write is `revision + 1`, so the CAS token cannot stand still while the document moves |

**Freeze** has defined semantics, because a panic button with vague ones is not a panic button: it
resolves every **partial** rollout to its default (off for a feature) and leaves **finished** ones
alone. That is what you want at 3 a.m. — stop all the experiments without also switching off a
feature that has been fully live for a month and that half the product now depends on. To turn a
finished feature off you use its `force: false`, deliberately, one flag at a time. An explicit
operator `force` is never overridden by the freeze.

### Why flags are not a per-player signed JSON blob

`docs/INFRASTRUCTURE.md` prices that at roughly **$10,800/month** at the target concurrency and
rejects it. Flags reach a player by two routes, neither of which is a per-player fetch on a timer:

1. **In-band.** The room resolves this player's flags **once**, server-side, and stamps them into
   `S2C.SESSION_CONFIG` — 4 bytes on a packet that was already being sent. At 1M CCU that is 4 MB
   total, once, not a request rate. This is the authoritative path.
2. **Once per boot**, for the menu: one `GET /api/flags`, a few hundred bytes, strong ETag,
   cacheable at the edge. One request per session.

The **document** an operator edits is polled by the server fleet — hundreds of boxes, not a million
browsers. That is the entire cost difference.

Flags are resolved **server-side and transmitted**. The client never decides. That is what makes a
flag a kill switch rather than a suggestion. A player who is already connected keeps the flags they
were resolved with for the life of that session, deliberately: a feature appearing or vanishing under
a player mid-match is the thing flags exist to prevent.

---

## 6. Rolling back

**A rollback is a routing change, not a redeploy**, so it completes in seconds.

1. Point the director back at the previous version's hosts. They are still up — the deploy never
   deleted them, and every client bundle you have ever shipped is still on the CDN, immutable and
   content-addressed. The whole bundle is under half a megabyte brotli; keeping all of them costs
   nothing.
2. Drain the new hosts exactly as in §3. The rollback drops nobody either.

**Three things a rollback must not break:**

- **Saves.** `migrateSave` clamps every document down to `SAVES_VERSION`, so a v5 save read by a
  rolled-back v4 client would be rewritten as v4 and the v5 fields would be gone from the player's
  own machine. `SaveFile._unknown` is the guard: unrecognised top-level keys are carried through
  untouched and written back out at the top level, byte for byte. **A rollback that destroys player
  data is worse than the bug you rolled back from**, and a rollback is exactly the moment nobody is
  watching for it. Tested in `shared/src/saves.test.ts`, including three old builds opening the
  document in a row.
- **Protocol.** A rolled-back host may be *older* than a client that already updated. That client is
  refused with `PROTOCOL_TOO_NEW`, not told to update, and asks the director for another host.
- **Database migrations.** Expand/contract only: add a nullable column → backfill in batches →
  dual-write → read new → stop writing old → drop, one release apart. Never a blocking `ALTER` on
  the player table at scale.

---

## 7. The ratchets

Two checked-in numbers in `shared/src/version.test.ts` fail when a constant moves that should not
have moved. They do not prove the code is right; they prove a change was **noticed**.
`docs/INFRASTRUCTURE.md` is explicit that this is the only mechanism that stops silent protocol
drift — code review does not catch a reordered bitmask bit, and a type system cannot see byte layout.

| Ratchet | Covers | On failure |
|---|---|---|
| `protocolFingerprint()` | quantisation scales, shipped message ids, `PF_ALL`/`EF_ALL`/`RF_ALL`, `CAP_INFLATE` | Was the change additive? Put it back at the end. Was it a real layout change? §2.3 |
| `weaponsFingerprint()` | every weapon's damage/pellets/rpm/mag/splash/spread | §2.2 |
| `coreFingerprint()` | tick, match length, score limit, movement speeds, `TERRAIN_VERSION` | §2.2 |
| `charactersFingerprint` (client test + gate) | the `CharacterLook` table — tints, heights, parts, stretch | §2.2 |
| `npm run release:verify` | all of the above plus installed levels, canonical encoding, campaign refs, `FLAG_ORDER`, schema bumps | docs/PACKS.md §4 |

The fix is **never** "update the number until it passes". It is "decide which axis you just moved,
move it, and update the number in the same commit".

Alongside them: **golden wire vectors** — checked-in bytes for `HELLO`, `WELCOME`,
`UPDATE_REQUIRED` and `SESSION_CONFIG` at the shipping version. An additive change leaves them
alone, which is exactly the line this whole design draws.

Still to build, and named here so it is not forgotten: a **version-matrix CI job** that boots a real
room for each (client vN, server vM) pair in the window and runs the synthetic client from
`tools/loadtest.mjs` through join, snapshot decode and disconnect. `patch.test.ts` covers the
handshake for every version in the window; the matrix job would cover a full session.

---

## 8. Configuration

| Variable | Default | What it does |
|---|---|---|
| `DOOMCRAFT_BUILD_ID` | `dev` | Axis 3. Also read by `client/vite.config.ts` at build time |
| `DOOMCRAFT_FLAGS` | `{}` | The flag document at boot, as JSON |
| `DOOMCRAFT_ADMIN_TOKEN` | *(unset)* | Bearer token for `/api/admin/*`. **Unset means the routes answer 404** — an unconfigured deployment has no admin surface at all |
| `DOOMCRAFT_FORCE_MIGRATE_MS` | 1,800,000 | The deploy drain's hard stop |
| `DOOMCRAFT_DRAIN_MS` | 25,000 | The shutdown drain's budget. Must be shorter than the orchestrator's kill grace |
| `DOOMCRAFT_MAX_ROOMS` | 32 | Rooms per process |
| `DOOMCRAFT_ROOM_IDLE_MS` | 120,000 | How long an empty room lingers |

### Endpoints

| Endpoint | For |
|---|---|
| `GET /health` | Readiness. 503 while either drain is running. Carries `deploy` and `version` |
| `GET /api/version` | All three axes plus `protocol.fingerprint`. Compare it **between hosts** — two hosts claiming the same protocol version but hashing differently is a mixed fleet, and that is the failure nobody thinks to look for |
| `GET /api/flags` | The menu's copy, ETagged |
| `POST /api/admin/drain` | Begin the deploy drain. Requires `actor` + `reason` |
| `GET /api/admin/flags` | **Read** the document, plus per-flag reach and which client `Feature` each one drives |
| `POST /api/admin/flags/plan` | Review a write: the resulting document, a diff, warnings, and the confirm delay. Writes nothing |
| `POST /api/admin/flags` | **Merge** a patch into the document. Requires `actor` + `reason`; `409` on a stale `expectRevision` |
| `GET /api/admin/status` | The operator's fleet view: the public status plus the signalling counters, the per-connection rollup, and both store statuses |
| `GET /api/admin/audit` | The admin action log, newest first |
| `GET /api/admin/player?key=` | One player, by exact device id, redacted, with the journal reconciliation |
| `GET /admin` | The console itself. **404 when `DOOMCRAFT_ADMIN_TOKEN` is unset** |

---

## 9. The tests that hold this up

```bash
npx vitest run shared/src/version.test.ts        # window, ratchets, golden vectors
npx vitest run shared/src/flags.test.ts          # defaults off, stable buckets, freeze
npx vitest run shared/src/saves.test.ts          # two-version jump, downgrade guard
npx vitest run server/src/patch.test.ts          # real Room, real bytes, real refusals
npx vitest run server/src/drain.test.ts          # real ModeRouter, drain semantics
npx vitest run client/src/boot/updates.test.ts   # never activate while playing
```

The four the design turns on:

- **a client one protocol version behind still connects, and is refused with a reason outside the
  window** — `patch.test.ts`, driving a real `Room` with hand-built v1/v2/v3 HELLO bytes, because a
  test that used `encodeHello` could only ever send the current version, which is the case that was
  never broken.
- **a draining host finishes its matches and accepts no new ones** — `drain.test.ts`, against the
  real `ModeRouter`, asserting both halves against the same object: nothing new is created, and
  nothing already running is touched.
- **the service worker does not activate during play**, including a player who stays in one match
  across two deploys — `updates.test.ts`.
- **a two-version save migration works** — `saves.test.ts`, v2 → v4 through the real storage path,
  plus v1 → v4 and the rollback guard.
