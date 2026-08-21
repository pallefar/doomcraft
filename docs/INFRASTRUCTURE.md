# Doomcraft — infrastructure, cost and the platform layer

Requested: *support 1,000,000 concurrent players.*

This is a decision document. Where the research offered a choice, one option is picked here and the
rejected ones are named with what killed them. Every cost figure is labelled **[M] measured**,
**[V] vendor-published** or **[E] estimated**. A confident wrong number is worse than a stated range,
so the estimates say what they are and how much they move the answer.

Read alongside `docs/CONTRACT.md` (the frozen shared contract), `docs/SPONSORS.md` (§2.2's
content-addressed creative origin and §5.3's ad/privacy defaults, both assumed here),
`docs/ECONOMY.md` (the ledger and prize rules this document has to host) and
`tools/loadtest.mjs` (the harness every measured number came out of).

---

## 0. The three things to take away

1. **Today the game costs $0 to run at any player count, and that is not a joke.** No shipped client
   code path connects to a server. `client/src/game/game.ts:446` always calls `createLocalServer()`
   and hands `NetClient` the Web Worker transport. All four modes run the authoritative room in the
   browser. You can launch on static hosting and pay nothing until you decide to wire online mode.
2. **When you do wire it, the provider decision is worth more than every other engineering decision
   combined — and it is free to make correctly right now.** The identical bytes cost **$0/month** on
   unmetered bare metal and **$968,550/month** on raw EC2 at 1M CCU. That is a 19× difference on the
   whole bill and it is decided by which invoice you sign, not by how you write the code.
3. **Two bugs are half your bandwidth.** `server/src/net.ts:874` retransmits ~33 *stationary* pickups
   in full 20×/s forever, and the 2.98 MB join burst ships uncompressed. Fixing both is about a week
   and takes blended egress from **43.0 → 18.8 GB per CCU-month**. On bare metal that is ~107 fewer
   servers at 1M CCU; on a per-GB provider it would be $545,000/month.

---

## 1. The honest read on 1M CCU

### What the target actually means

1M concurrent would put Doomcraft in the top handful of games in the world. For scale: Among Us
peaked around 3.8M CCU, Fortnite around 10–15M, and a *successful* .io game peaks in the tens of
thousands. The realistic outcome distribution for any new browser game is overwhelmingly
"never exceeds 10k CCU".

So the target is not a provisioning instruction. It is an **architecture constraint**, and the right
reading of it is:

> **Build so it scales to 1M without a rewrite. Provision for what you actually have.**

The good news is that this codebase already earned the hard half of that. A match is independent
state, so rooms shard almost perfectly. There is no shared-world bottleneck anywhere except Builder's
persistent worlds and the account database, and both of those shard by key.

### The concurrency the architecture supports, stated precisely

| Stage | Ceiling | What it costs to get there |
|---|---|---|
| **Shipped today** | **32 players total** | — `server/src/index.ts:272` constructs exactly one `Room`. One process = one match. `MAX_PLAYERS = 32` (`shared/src/constants.ts:153`). And nothing connects to it anyway. |
| **`ModeRouter` mounted** | **~3,200 online players per box** [M] | ~1 day. `server/src/modes.ts:462` already implements the room table, `roomKeyFor()`, idle reaping and per-key overflow suffixes. It is referenced by nothing outside its own tests. Raise `DEFAULT_MAX_ROOMS` from 32. |
| **Director tier + drain-aware fleet** | **No ceiling from the game code** | The one genuinely new build. ~190 boxes at 1M CCU as-built, ~83 after the two egress fixes. |

**Nothing in `room.ts`, `sim.ts`, `net.ts` or `world.ts` has to change to reach 1M.** The scaling work
is entirely additive: a stateless director that owns the room registry and version routing, and a
change from one-room-per-process to rooms-per-process with a phase-staggered scheduler. That is the
single largest architectural asset this codebase has, and the current one-Room-per-process server
throws it away.

### The three bottlenecks that are *not* room-shaped

1. **Builder's persistent worlds.** Shard by world id; a world lives on exactly one host and never
   moves. `server/src/worlds.ts` is complete and tested but **mounted by nothing**.
2. **The account database.** One Postgres to 1M CCU at the measured access pattern (~333 profile
   reads/s, ~1,100 writes/s [E]). Do not shard prematurely.
3. **The matchmaker registry.** ~98,000 concurrent rooms × ~200 B = **20 MB** [E]. One Redis/Valkey
   per region. Never make the room table globally consistent.

---

## 2. Measured primitives

Everything here came from `/Users/karstenhaldan/youtube/doomcraft/tools/loadtest.mjs` (1,381 lines),
which imports the **real** `Room`, `NetHub`, `Simulation`, `ServerWorld` and the real `ws`
`WebSocketServer`, wired exactly as `server/src/index.ts` wires them — same `noServer` upgrade, same
`WsTransport`, `perMessageDeflate: false`, `maxPayload: 256 KB`. Synthetic clients speak the real
binary protocol from `shared/src/protocol.ts` and decode with the real `decodeSnapshot`. No mock, no
stub, no re-implemented codec.

**Test machine:** Apple M3 Pro (5P + 6E cores), 18 GB, macOS 27, Node v22.18.0, server run as
TypeScript through `tsx`. Server-grade x86 differs: expect 0.5–0.8× an M3 P-core on typical cloud
vCPUs. Memory and byte counts are architecture-independent.

### The table

| Primitive | Value | Units | Condition |
|---|---|---|---|
| **bytes/player/sec down** | **19,431** | B/s wire | deathmatch, 10 in room, moving+shooting |
| bytes/player/sec down | 24,447 / 32,759 | B/s wire | deathmatch, 25 / 50 in room |
| bytes/player/sec down p95 | 20,088 / 25,729 / 34,892 | B/s wire | 10 / 25 / 50, p95 of 1 s samples |
| bytes/player/sec down | 21,682 | B/s wire | Builder (sandbox), 25 in room |
| bytes/player/sec down | 24,603 / 34,251 | B/s wire | Horde, 25 in room, default / 64-monster budget |
| **bytes/player/sec down** | **0** | B/s | **Quest — runs entirely in the client's Web Worker** |
| **bytes/player/sec up** | **1,310** | B/s wire | flat, all modes, all room sizes |
| **join burst (one-off)** | **2.98** | MB/player | 169 chunks, RLE, uncompressed; identical at every room size |
| join burst, if gzipped | 0.78 | MB/player | `perMessageDeflate` is off today |
| **rooms/core** | **63–82** | rooms | deathmatch, 16 *connected* players/room, stable 20 Hz |
| **players/core** | **~1,060** | players | 0.00094 cores per connected player |
| bodies/core (bots, no socket) | ~8,200 | bodies | 0.00012 cores per simulated bot |
| **MB/room** | **11.5 RSS / 11.07 ArrayBuffer** | MB | **empty** room; 169 × 65,536 B, allocated eagerly |
| **MB/player** | **0.30 ArrayBuffer / ~0.58 RSS** | MB | per connected socket |
| base process RSS | ~100 | MB | Node + `tsx`; compiled `node server/dist/index.js` will be lower |
| CPU to build a room | 263–632 (warm ~265) | ms | `ServerWorld.generateAll()`, terrain v5 |
| CPU per joining player | 20–50 | ms | 169 × `encodeChunk` RLE, **re-run per client, never cached** |
| tick time, 16 / 25 / 50 players | 0.38–0.53 / 0.87 / 2.71 | ms mean/p50 | one room-step |
| tick gap (per-room, target 50) | 51.5 p50 / 54.5 p95 / 56.5–62.5 p99 | ms | 8–48 rooms × 16 players |
| **first-load** | **1.453** | MB on the wire | real Chromium, cold profile, 19 requests |
| first-load, if brotli | 0.398 | MB | same request set, brotli-11 |
| **warm-load** | **0.121** | MB on the wire | reload, same profile; no service worker exists |
| warm-load, if cache headers fixed | 0.008 | MB | `index.html` only |
| **Builder: bytes/delta on disk** | **2.00** | B | varint gap + block id |
| Builder: autosave CPU | 1.1 / 9.4 / **272** | ms per save, **synchronous** | 10k / 100k / 500k deltas |

### The marginal model — this is what every cost below is derived from

```
snapshot bytes  = 20 + 23.0 × entities + 17.5 × players_in_room
down B/s (wire) = 20 × snapshot + 26        ≈ 15,700 + 350 × players_in_room
up   B/s (wire) = 1,310                      (independent of everything)
```

Cross-checked, not curve-fitted: it reproduces the measured mean snapshot size at 1, 10, 25 and 50
players and at 27, 33, 34 and 55 entities, **within 1.5% everywhere**.

- **+1 player in a room costs +350 B/s downstream to *every* player in it** → a room's total
  downstream grows as **O(N²)**: 0.16 MB/s at 10, 0.61 MB/s at 25, 1.64 MB/s at 50.
- **+1 entity costs +460 B/s to every player** — more than a player, because entities are not
  delta-encoded.

### The four facts that dominate every number in this document

1. **Entities are not delta-encoded.** `server/src/net.ts:874` sets
   `s.entityMask[slot] = EF_SPAWN | EF_ALL` unconditionally, so all ~33 *stationary* pickups are
   retransmitted in full 20×/s forever. That is 15,200 of the 16,050 B/s a lone player receives
   (95%), and still 46% at 50 players. **Verified in the tree.**
2. **Every player is streamed the entire world.** All 169 chunks (2.98 MB) go to every joiner
   regardless of position, and `encodeChunk` re-runs the RLE per client rather than sending a cached
   blob. `perMessageDeflate` is explicitly `false`.
3. **The voxel store is 11.07 MB per room and is allocated eagerly.** Idle and lobby rooms cost
   exactly as much memory as full ones.
4. **The server sends no compression at all.** `serveStatic` (`server/src/index.ts:346`) streams raw
   bytes with `content-length`, **no `content-encoding`, no ETag, no Last-Modified** — verified by
   reading the function. So `/c/kenney-chars.png`, `/characters/cast.glb` and `/characters/cast.png`
   (114 KB, outside `/a/`, so `cache-control: no-cache` with no validator) return a **200, not a 304,
   on every single load, forever.**

### What could NOT be measured — flagged, not filled in

1. **Anything about online play as players will experience it,** because no shipped client connects.
   Real RTT, packet loss, mobile radio behaviour, reconnect storms, NAT churn and lag-compensation
   cost under real jitter are all unmeasured. **The loopback numbers are a floor, not an estimate.**
2. **Packets per second on real NICs.** ~81 pps/player → ~274k pps per box, ~48.6 Mpps at 1M CCU.
   Never measured. On cloud instances with pps-capped ENA/virtio this could bind *before* bandwidth
   and would invalidate the box-shape recommendation, not just the price. **Verify before committing
   to a SKU.**
3. **TLS.** Everything ran plaintext on loopback. I model +5%; the honest range is 5–15%. At 15%
   every egress figure here is ~10% low.
4. **Horde at a real wave peak.** The 64-monster row was forced with `--enemies 64`. Nobody verified
   that a late Horde wave actually reaches 64. `QUEST_MONSTER_CEILING` is 64 so it is a plausible
   ceiling — someone who knows `horde.ts`'s wave curve should confirm, because Horde is the most
   expensive mode per player in this model.
5. **The 50-player row is not reachable in shipped code** (`MAX_PLAYERS = 32`, and `Room` clamps).
6. **Builder's persistence numbers are of an unmounted module,** with no fsync, so save timings are
   to page cache. Read-side load at boot, concurrent-save contention and behaviour at
   `MAX_WORLD_DELTAS` (1,500,000 — a ~3 MB file taking well over a second to encode *synchronously*)
   are all unmeasured.
7. **The account DB.** `JsonFileStore` writes one JSON file per device with an 800 ms debounce. Not
   load-tested, because measuring a design nobody intends to keep is the wrong use of the time.
8. **Compiled-build baselines.** Everything ran through `tsx` (~100 MB base RSS). Per-room and
   per-player marginals are typed arrays and unaffected, but re-measure the fixed floor.
9. **Linux and x86.** All Apple Silicon on macOS. The memory-pressure failure mode is macOS-specific
   (compressed memory, not OOM), and 11 MB/room behaves differently under a cgroup limit.
10. **Client CPU/GPU at 50 remote players.** Note the perverse incentive: today the *player* pays the
    simulation cost. Wiring online mode moves that cost onto your invoice.

### What breaks first

**With real connected players: CPU, at ~1,000 players per core.** At that point memory is ~1.0 GB and
sockets ~1,000 — both comfortable. A **1 vCPU / 2 GB** box is roughly the right shape.

**With idle or bot-only rooms: memory, by a wide margin**, because of the eager voxel store. Pushing
one process to 256 rooms of 12 bots: the tick died at **40% of one core** with RSS (1,718 MB) sitting
*below* the ArrayBuffer allocation (2,838 MB) — macOS had paged out a gigabyte of voxel arrays nobody
was reading. On Linux with no swap this is the OOM killer at the same ~2.8 GB.

**The sleeper: the scheduler, if you write the obvious one.** Every `Room` owns a 50 ms accumulator.
Left alone they all empty on the same wake, so the process does 100% of its tick work in 10% of the
time. Unstaggered, 128 rooms had a batch p95 of **42.7 ms** against a 50 ms budget *while CPU sat at
0.26 cores*. Phase-staggering dropped it to 21.1 ms with no other change. Free to fix, expensive to
discover in production.

> **Alarm on the per-room gap between ticks, never on lost ticks.** `MAX_CATCHUP_TICKS = 8` lets a
> room absorb 400 ms of lateness with a zero tick deficit. The deficit metric read healthy through
> every stage the harness visibly broke. **Page at p99 gap > 65 ms.**

---

## 3. The cost table

### The derivation, so it can be audited

Per online player, from the marginal model above:

| Term | Value | Label |
|---|---|---|
| ws downstream, deathmatch @ 16 in room | 21,300 B/s | **[M]** (harness measured 21,140–21,227) |
| + IPv4/TCP headers, 20 pkt/s × 40 B | +800 B/s | **[E]** arithmetic, not packet-captured |
| + TLS record overhead | ×1.05 | **[E]** honest range 5–15% |
| + join burst 2.98 MB amortised over a 12-min match | +4,139 B/s | **[M]** burst, **[E]** match length |
| **= deathmatch, per online player** | **27,205 B/s = 218 kbps** | derived |

Per mode, using the **shipped** caps in `shared/src/modes.ts` (Quest 4, Horde 4, Builder 16,
Deathmatch 32 — read out of the tree, not assumed) and estimated average occupancy:

| Mode | cap | avg N [E] | entities [E] | as-built | after the two fixes | cut |
|---|---|---|---|---|---|---|
| Deathmatch | 32 | 16 | 33 | 27,205 B/s | 9,660 B/s | 64% |
| **Horde** | **4** | **3** | **55** | **32,226 B/s** | 18,231 B/s | 43% |
| Builder | 16 | 8 | 30 | 20,008 B/s | 7,118 B/s | 64% |
| **Quest** | 4 | — | — | **0 B/s** | **0 B/s** | — |

> **Horde is the most expensive mode per player, not Deathmatch.** A 4-player cap against a
> 64-monster budget means each player pays for ~55 non-delta-encoded entities with only two others to
> amortise the room against. It is also the worst for RAM: 11.07 MB ÷ 3 players. This surprised me
> and it is the single most actionable game-design cost lever in the document.

Blended at a **[E] mode mix of 40% Quest / 30% Deathmatch / 20% Horde / 10% Builder**:

- **as-built: 16,608 B/s per CCU = 43.0 GB per CCU-month sustained**
- **after the two fixes: 7,256 B/s per CCU = 18.8 GB per CCU-month sustained (−56%)**

Bills below use **[E] average CCU = 0.45 × peak CCU** over a global 24-hour cycle. **Fleet size is
sized on peak; per-GB bills are paid on the average.** All "CCU" figures are peak.

### Bandwidth is the whole provider decision — lead with it

Egress at 1M peak CCU is **19,371 TB/month (19.4 PB), 133 Gbps at peak** as-built. The same bytes:

| Provider | as-built | after the two fixes | Label |
|---|---|---|---|
| **Hetzner / OVH bare metal, unmetered 1 Gbit port** | **$0** | **$0** | **[V]** "unlimited traffic" on 1 Gbit dedicated — verified at docs.hetzner.com/robot/general/traffic |
| **AWS GameLift, gen-6+ instances** | **$0** | **$0** | **[V]** "Network bandwidth is free for all instance types generation 6 and later" — verified on the GameLift pricing page |
| Latitude.sh / Vultr / DigitalOcean ($0.01/GB) | $193,710 | $84,634 | **[V]** |
| AWS EC2 raw ($0.05/GB at the >150 TB tier) | **$968,550** | $423,170 | **[V]** |
| Azure raw ($0.05/GB at the >150 TB tier) | $968,550 | $423,170 | **[V]** |
| GCP Premium Tier ($0.08/GB at the >10 TB tier) | $1,549,680 | $677,072 | **[V]** |
| Edgegap ($0.10/GB) | $1,937,100 | $846,340 | **[V]** |

**The spread between the cheapest paid option and the most expensive is 10×, and between free and
Edgegap it is unbounded.** No caching strategy, no protocol optimisation and no CDN recovers this,
because it is uncacheable per-player realtime traffic.

### Why you buy ports, not cores

Measured 0.00094 cores/connected player ÷ 23,060 B/s steady = **236 Mbps of egress per core of
compute** [M-derived]. On one Hetzner AX42-class box (8c/16t Ryzen, 64 GB, 1 Gbit unmetered):

| Constraint | as-built | after fixes |
|---|---|---|
| CPU-bound at | 9,404 players | 9,404 players |
| **PORT-bound at** | **3,161 players** | **7,235 players** |
| RAM-bound at | 30,332 players | 30,332 players |

**Bandwidth binds ~3× before CPU.** Consequence: a 48-core AX162-R and an 8-core AX42-1 saturate the
same 1 Gbit port at the same player count, making the big box ~3.7× more expensive per player. Every
off-the-shelf orchestrator (Agones, Nomad, plain k8s) bin-packs on CPU/memory requests and **will
overfill these boxes by about 3×.** Express the port as the scheduling resource.

### The recommended stack, all-in

Bare metal + Cloudflare. Minimum 2 boxes per region for HA. **Excludes headcount.**

| Line | 1k CCU | 10k CCU | 100k CCU | 1M CCU |
|---|---|---|---|---|
| Game hosts (unmetered bare metal) **[V]** | $220 | $220 | $2,565 | $28,500 |
| **Game egress** **[V]** | **$0** | **$0** | **$0** | **$0** |
| CDN / client bundle (R2 + Workers) **[V]** | $0 | $5 | $250 | $2,500 |
| Database (Postgres + Valkey) **[V]** | $19 | $19 | $200 | $800 |
| Telemetry (ClickHouse, self-hosted) **[E]** | $0 | $0 | $200 | $1,100 |
| Auth (WorkOS AuthKit) **[V]** | $0 | $0 | $0 | $10,000 |
| Product analytics (PostHog, allowlisted + sampled) **[V]** | $0 | $170 | $1,500 | $7,500 |
| Errors (Sentry) **[V]** | $26 | $26 | $400 | $2,000 |
| Observability (Grafana) **[V]** | $0 | $0 | $300 | $900 |
| Feedback / Linear / Metabase / KYC / moderation APIs **[V]** | $75 | $100 | $350 | $1,500 |
| Domains, TLS, backups, misc **[E]** | $30 | $30 | $100 | $400 |
| **TOTAL** | **$370** | **$570** | **$5,865** | **$55,200** |
| **per CCU per month** | $0.370 | $0.057 | $0.059 | **$0.055** |
| *Same stack after the two egress fixes* | *$370* | *$570* | *$4,515* | ***$39,150*** |

### The same game on raw EC2, for contrast

| | 1k | 10k | 100k | 1M |
|---|---|---|---|---|
| **TOTAL** | $1,604 | $10,519 | $105,798 | **$1,057,950** |
| **multiple vs recommended** | 4.3× | 18.5× | 18.0× | **19.2×** |

At 100k CCU the gap is **$100,000/month — more than the engineering team.** This is the one place
where the conventional "just use the cloud, optimise later" advice is catastrophically wrong, because
the hyperscalers' egress line grows linearly with exactly the thing this game produces most of.

### Two observations the tables make that are easy to miss

**At 1k CCU everything is the HA floor, not the load.** $370/month buys 4 boxes for 1,000 players who
would fit on one. That floor — not the marginal cost — is what multi-region actually costs at launch,
and it is why you ship a **region picker** and 2 regions rather than geo-routing and 8.

**Once you host correctly, egress is $0 and SaaS becomes half the bill.** At 1M CCU the non-game-server
lines total $26,700 of $55,200. Auth ($10k) and product analytics ($7.5k) are each larger than the
CDN. "Egress is 98% of the decision" is true of *choosing a provider*; it is false of the resulting
invoice. Budget accordingly.

### Cost levers, ranked

| Lever | Saving at 1M CCU | Effort | Label |
|---|---|---|---|
| Delta-encode entities (`net.ts:874`) | ~107 boxes ≈ **$16,000/mo** | ~1–2 days | [M]-derived |
| `perMessageDeflate` + cache the per-room chunk blob | included above, **plus ~12 cores** of duplicated RLE | ~1 day | [M]-derived |
| Sample PostHog to a stable 10% cohort | ~$45,000/mo *if left uncapped* | config | [V] |
| Route first sessions into Quest (0 B/s) | up to ~$8,000/mo | product decision | [M] |
| Lazily allocate the voxel store | ~15% of host count, and removes the 256-room cliff | ~1 day | [M] |
| Brotli + fix `/c/` and `/characters/` cache headers | ~$400/mo, and a faster game | ~2 hours | [M] |

---

## 4. The recommendation

### Run it on rented bare metal with unmetered ports. Keep AWS GameLift as the escape hatch, not the launch pad.

**Now (0 CCU): spend $0–5/month.** Ship the client to Cloudflare Pages/R2. Nothing connects to a
server, so there is no server bill. Fix `serveStatic` first — brotli plus ETag/Last-Modified, and move
`/c/*` and `/characters/*` under `/a/`. That is 1.453 MB → 0.398 MB cold and 0.121 MB → 0.008 MB warm,
for about two hours of work.

**Launch → 10k CCU: ~$370–570/month.** Two regions: 2× Hetzner AX42-class in Falkenstein (EU), 2×
OVH or Latitude.sh in Ashburn (US-East). Cloudflare free in front of the bundle. One small allocator
VM per region. Postgres for accounts — retire `JsonFileStore`. **Region picker in the UI. No
geo-routing.** Mount `ModeRouter`; raise `DEFAULT_MAX_ROOMS`.

> **Hard constraint you must design around:** Hetzner sells *dedicated* servers only in Nuremberg,
> Falkenstein and Helsinki. Its US locations are cloud-only and include just 1–8 TB of traffic per
> instance versus 20–60 TB in the EU **[V]**. Hetzner is your EU region and **cannot be your global
> strategy.** OVH (~15 DCs, protocol-aware game DDoS included), Latitude.sh (20 TB/server + $0.01/GB)
> and Vultr (32 locations) fill the rest.

**10k → 100k CCU: ~$4,500–5,900/month.** Third then fifth region. **Do the two egress fixes here** —
everything downstream is priced off that number. Lift `ModeRouter` out of the game process into a
per-region allocator, keeping the room keying identical so Quest/Builder co-location by content still
works. Add the shared immutable voxel store per `(mode, seed)`. Phase-stagger the room accumulators.

**100k → 1M CCU: ~$39,000–55,000/month.** Eight regions. This is where the real decision lands.

### Migration triggers — each one specific

| Trigger | Action |
|---|---|
| **Sustained egress > 40 Gbps** (≈200k CCU as-built, ≈430k after the fixes) | Unmetered-1-Gbit hosting stops being credible. 200 servers running ports flat out 24/7 is not what "unlimited traffic" is sold for. **Start the committed-bandwidth conversation with OVH/Latitude a quarter earlier, at ~100k CCU.** |
| **Any single region past ~20 boxes** | You need a real allocator with health-checked placement, not a static room table. |
| **Any Builder world past 100k deltas** | Move Builder to its own fleet. `encodeWorld` is synchronous and rewrites the whole file: 9.4 ms at 100k deltas, **272 ms at 500k, every 15 s, blocking every other room in the process** [M]. Add the missing fsync while you are there. |
| **p99 per-room tick gap > 65 ms** | Add capacity. Do **not** alarm on lost ticks. |
| **pps headroom on the target NIC** | Verify **before** committing to a box shape (unmeasured, see §2). If it binds, batch 2–3 input commands per client frame. |

### At the top end, model GameLift honestly

**AWS made outbound bandwidth free on GameLift on 15 June 2026 for generation-6+ instances**, verified
this session on the GameLift pricing page **[V]**. The consequence is strange and worth stating: running
the identical binary on raw EC2 instead of GameLift costs roughly 20× more — same company, same
silicon, same datacentre, one line item.

At 1M CCU, my independent estimate is ~564 c6a.large at peak (2 vCPU @ $0.099/hr On-Demand **[V]**,
~1,064 players each at a **[E]** 0.5× cloud-vCPU derate), billed at ~55% of peak-hours with
drain-aware autoscaling ≈ **$22,400/month On-Demand**, or ~$6,800 on Spot **[V] $0.03/hr**.

So GameLift's game-server line is genuinely competitive with bare metal at the top end, and you also
get 20+ regions, stateful drain-aware autoscaling and Spot placement already built. **The argument
for it is headcount, not the invoice:** $30k of machines against 3–4 SREs at $60–80k/month fully
loaded. Bare metal wins on the invoice; GameLift may win on total cost of ownership above ~250k CCU.
**Model both with real salaries before committing.**

Two caveats I will not paper over: the GameLift instance premium over EC2 is unpriced (the live price
table did not render), and **40 PB/month is a number that gets a contract renegotiated** — the blog
states no cap and explicitly names tick rate and player count as irrelevant, but treat it as sound at
100k CCU and *verified with AWS in writing* before 1M.

### Rejected, and what killed each

| Rejected | Why |
|---|---|
| **Raw EC2 / GCE / Azure VMs** | $968k–1.55M/month of egress at 1M CCU for the identical simulation. The crossover never arrives. |
| **Edgegap** | $0.10/GB. The most expensive option measured, ~$1.94M/month at 1M CCU. |
| **Cloudflare Durable Objects for the room** | Egress genuinely free, but then you pay duration (128 MB × wall-clock, billed regardless of use, and a 20 Hz tick is never idle so hibernation buys nothing) plus WebSocket request billing (61 incoming msg/s ÷ the documented 20:1 ratio = 3.05 billable req/s). ~$1.86 per online-player-month **[V]** — 58× bare metal, to run a simulation you already have. **Cloudflare for everything except the game loop.** |
| **Colo + own IP transit** | The bytes cost ~$12k/month at commodity transit. Colo + hardware + cross-connects + IP space + 2 SREs is ~$83k. Worse than renting 190 boxes. The $12k figure is a yardstick for what the bytes are *worth*, not a plan. |
| **Hetzner Cloud (CCX)** | Hetzner raised cloud prices three times in 2026; CCX lines went up 113–169% **[V]**. Hetzner *dedicated* is competitive; Hetzner *cloud* no longer is. |
| **Hetzner as the global strategy** | Dedicated servers in 3 European cities only. |
| **A 48-core box** | Same 1 Gbit port, 3.7× the price per player. Buy ports, not cores. |

### DDoS

Cloudflare gives **unmetered** L3/4/7 mitigation on every plan including Free **[V]**; OVH and Hetzner
include anti-DDoS on bare metal **[V]**; AWS Shield Advanced is $3,000/month flat **[V]**. The practical
split: **Cloudflare in front of CDN + matchmaker + auth** (small, cacheable, most attack-attractive),
**game sockets direct to origin** behind OVH/Hetzner scrubbing, with per-room ephemeral hostnames so
the fleet cannot be enumerated.

> **One application-layer hole is worth more than any scrubbing contract.** The join path is an
> unauthenticated amplifier: a HELLO costs the server **20–50 ms of CPU** (169 × `encodeChunk`,
> re-run per client, never cached) and **2.98 MB of egress** [M]. Fifty HELLOs/second from one IP buys
> an attacker a full core and 150 MB/s of your bandwidth. **Rate-limit HELLO and cache the chunk
> blob** — the same fix as the egress work, which is why it earns its place twice.

---

## 5. The platform layer

**The governing decision: split the estate in two and never let them share infrastructure.** The
realtime tier is bare metal with unmetered ports. The platform tier is Cloudflare + managed SaaS.

> **One rejection up front:** research proposed Cloudflare for player-facing surfaces *and* Vercel +
> Next.js for the internal consoles. **Rejected — pick one.** Two frontend platforms means two bills,
> two deploy pipelines and two auth integrations for zero benefit at any tier in this document.
> Everything web goes on **Cloudflare Pages/Workers/R2.**

| # | System | Verdict | Buy | Build | 1k | 10k | 100k | 1M |
|---|---|---|---|---|---|---|---|---|
| 1 | Player profile | **BUILD** | R2 + Satori Worker for the share card | page, stats, friends, history | $0 | $0 | incl. CDN | incl. CDN |
| 2 | Feedback | **BUY board, BUILD capture** | Featurebase, Sentry, Linear | in-game F8 context bundle | $101 | $126 | $750 | $3,500 |
| 3 | Admin panel | **BUILD actions, BUY dashboards** | Grafana, Metabase OSS, WorkOS SSO | moderation, room control, flags | $0 | $0 | $300 | $900 |
| 4 | Advertiser console | **BUILD** | image re-encode, classifiers, KYC | console, catalogue, cascade | $0 | $0 | $200 | $1,500 |
| 5 | User management | **BUILD identity, BUY credential** | WorkOS AuthKit | anon device identity, merge, roles, GDPR jobs | $0 | $0 | $0 | $10,000 |
| 6 | Billing | **BUY 3 rails, BUILD the ledger** | Paddle, Stripe, Tremendous | double-entry ledger in integer micros | $0¹ | $0¹ | $0¹ | $0¹ |
| 7 | Analytics | **BUY funnels, BUILD firehose** | PostHog | ClickHouse schema + game metrics | $0 | $170 | $1,700 | $8,600 |
| 8 | Patch system | **BUILD, entirely** | GitHub Actions, R2 | all of it | $0 | $0 | $0 | $0 |

¹ Payment fees are a percentage of revenue, not a fixed cost. Excluded from every table here.

### 1. Player profile — BUILD

There is no product to buy; it is your own data rendered. Identity and entitlements from Postgres;
**match history from ClickHouse, not Postgres** — at 12M DAU × 8 matches that is 96M rows/day and it is
an analytical table. Friends and presence from Valkey sorted sets. Buy exactly one piece: the
server-rendered 1200×630 share card (Satori in a Worker, stored in R2 by content hash — the same
content-addressing discipline `docs/SPONSORS.md` §2.2 already mandates for creatives).

**A public profile is a harassment and doxxing surface.** Default it to handle-only: no country, no
last-seen, no session times. Match history public is opt-in. `deviceId` never appears. **Under-13 and
unknown-age accounts get no public profile and no search indexing at all** — a COPPA requirement, not
a nicety.

### 2. Feedback — BUY the board, BUILD the capture

Nothing off the shelf captures what a canvas game needs. The in-game capture (F8, long-press on
mobile) bundles: the WebGL framebuffer as JPEG, the **last 60 s of the input ring buffer**, room id,
tick, `PROTOCOL_VERSION`, `BUILD_ID`, content hash, GPU renderer string, and `game.medianMs` /
`game.onePctLowFps`. Those last two are the difference between "the game feels bad" and a reproducible
bug.

Routing: crashes → **Sentry**; feature requests and public roadmap → **Featurebase** ($75–129/mo,
unlimited users **[V]**; Canny wants $359/mo for the equivalent); internal triage → **Linear**. One
webhook chain: Featurebase status change → changelog → the in-game "What's new" card the patch system
needs anyway. **Rate-limit the capture endpoint and de-duplicate by stack hash** — a 1M-CCU game with
an open feedback key is a self-inflicted DDoS.

### 3. Admin panel — BUILD the actions, BUY the dashboards

Buy Grafana (live server/room status) and Metabase OSS (revenue and content reporting over
ClickHouse). Build everything that **mutates** state: ban/mute/shadowban/kick with an auto-attached
evidence bundle from the room's tick log, live room list with force-drain, content publishing, feature
flags, and the incident buttons.

**Explicitly reject Retool for the destructive actions.** The objection is not the $50–65/user/month
**[V]**; it is that a ban button and a fleet-drain button need to live in your own RBAC'd codebase with
an append-only audit log — the exact `AuditEntry` pattern `docs/SPONSORS.md` already defines. Under the
DSA you owe a **statement of reasons for every moderation action**, so the ban tool must *emit a
document*, not flip a boolean. That alone rules out a generic CRUD builder. Retool is fine as a
read-only ops view in month one.

### 4. Advertiser console — BUILD

`docs/SPONSORS.md` §2.3 already specified it, welded to your own `SurfaceId` catalogue, viewability
definitions, inventory forecast and three-stage moderation gate. No ad-tech SaaS sells that shape.

**Buy the four pieces you must not write:** image decode/re-encode (**never decode sponsor bytes in
your own process** — libvips/sharp in an isolated container with hard wall-clock, memory, dimension
and pixel-count caps, or Cloudflare Images; the re-encode is what kills polyglots); classifiers (Hive
or Rekognition for NSFW, Cloud Vision OCR for text-in-creative, **Google Safe Browsing free** for
`clickUrl`); sponsor KYC and sanctions screening (Stripe Identity or Persona — `Sponsor.verified` is a
legal control); and perceptual hashing against your own reject blocklist. **The "reject anything that
mimics the HUD" check stays human** — no classifier has it.

### 5. User management — BUILD the identity, BUY the credential

**Stated once: your Postgres owns the player. The IdP owns only a credential.** Get this backwards and
you are married to a vendor's per-MAU meter forever.

- **Anonymous play stays exactly as built.** `deviceId` → `StoredProfile`
  (`server/src/persistence.ts`), with `accountId`/`accountSecret` already in the schema.
  **Never put an anonymous player in an IdP.** They are ~90% of your users, any per-MAU meter would
  bankrupt you on people who never typed an email, and it is the COPPA-safe default.
- **Account upgrade → WorkOS AuthKit.** Free to 1M MAU, then $2,500/mo per additional million **[V]**.
  At 5M account-MAU: WorkOS **$10,000**, Supabase Auth **$16,100**, Clerk **$100,000** **[V]**. Same
  feature set. *Rejected: Clerk on price, Supabase Auth on price, self-hosted Better Auth on
  operational load at launch — but see the exit below.*
- **The merge is the part you build and the part that will bite.** Sign in → provider subject → *if
  that subject already has a player row, present a merge UI; never silently overwrite.* Silently
  binding a fresh device to an existing account is how games lose a player's entire progression.
- **Caveat:** Steam is OpenID 2.0 and most modern IdPs including WorkOS don't ship it. You will
  implement Steam yourself. Google/Apple/Discord are native.
- **Roles live in your Postgres, not the IdP.** You will change authorization far more often than
  authentication.
- **Sessions:** your own short-lived JWT + refresh in an httpOnly cookie, minted by your API after the
  IdP handshake. The game socket authenticates with a **separate short-lived ticket** — the WS upgrade
  is a different origin and must not carry a session cookie.
- **Safari ITP evicts script-written localStorage after 7 days of no interaction.** `docs/SPONSORS.md`
  §5.1 flags this for measurement; it is worse for identity — a returning player on day 8 has silently
  lost everything. Mitigate by minting the device id as a **server-set** httpOnly `Secure`
  `SameSite=Lax` cookie with a 400-day max-age from your own origin, mirrored to localStorage.
- **The exit is real, which is why buying is safe.** Because Postgres holds the canonical player row
  and WorkOS holds only `{provider, subject}`, swapping to self-hosted Better Auth is a credential
  re-link, not a migration. **Trigger: revisit if the WorkOS line crosses ~$25k/month.**

### 6. Billing — BUY three separate rails, BUILD the ledger

Three unrelated money flows. Forcing them through one provider yields neither VAT compliance nor
payout coverage.

- **The $4.99 ad-removal unlock → Paddle**, merchant of record, 5% + $0.50 **[V]**. Stripe's 2.9% + $0.30
  is nominally cheaper, but then *you* are the merchant of record and owe VAT/GST registration and
  filing in ~100 jurisdictions on a digital good sold to consumers including minors. On $4.99 Paddle
  keeps $0.75 (15.0%), Stripe ~$0.50 (10%) **plus your entire compliance function.** Put it behind the
  interface the code already has (`POST /api/entitlement`, currently a mock grant) and revisit past
  ~$1M/yr with a tax advisor in the room.
  **Non-negotiable: the entitlement is granted server-side from the provider webhook**, idempotent on
  the provider event id, reconciled daily — never from a client callback.
- **Sponsor prepay → Stripe** (Invoicing + Tax + Identity). B2B, VAT reverse charge, KYC.
  `Sponsor.balanceMicros` is a ledger row in *your* Postgres; Stripe only moves money. Prepay only, no
  credit, no receivables — as `docs/SPONSORS.md` v1 already decided.
- **Prize payouts → Tremendous** for the long tail (gift cards and donations free; PayPal/bank 4–6%
  **[V]**) and **Stripe Connect Express** ($2/mo per active account + 0.25% + $0.25/payout **[V]**) for the
  handful of recurring high-value winners needing a real bank transfer and a 1099/W-8. **Never build a
  payout rail.**
- **BUILD the ledger.** Double-entry, append-only, **integer micros** (never floats — `docs/SPONSORS.md`
  already mandates this). Every provider is a source of truth about *money moved*; only your ledger is
  the truth about *what was owed*. **The prize gates must be enforced at the ledger**, so a payout to
  an under-18-flagged account is refused by the money layer and not merely hidden in the UI.

### 7. Analytics — BUY the funnels, BUILD the firehose

Two products, deliberately not one, for the same reason `docs/ECONOMY.md` keeps two currencies.

- **Product analytics → PostHog Cloud.** Free to 1M events/mo **[V]**. Feed it a **hard allowlist of ~15
  lifecycle events per user per day** — never the gameplay firehose. Session replay at 0.1–1% and
  menus only. Above 100k CCU, sample to a **stable 10% hash cohort**; 1.2M DAU at 10% still gives
  ±0.3%.
- **Game telemetry → self-hosted ClickHouse.** At 1M CCU you emit ~87B rows/month. In PostHog that is
  **~$780,000/month**; in ClickHouse ~2.6 TB compressed on nine boxes, **~$1,100/month** **[E]**. That
  single ratio is the entire argument. One wide `match_event` table,
  `ORDER BY (day, mode, level_id, ts)`, raw TTL 90 days into materialized aggregates kept forever,
  cold parts to R2. *Do not build this before 100k CCU.*
- **Do not buy feature flags from PostHog at scale.** 1.08B evaluations/month is ~$10.8k for what is a
  signed JSON blob. Serve the flag document from Workers KV and let the **server** resolve it — the
  client must never decide, the same rule as the ad cascade. Send PostHog the *resolved assignment* as
  an event property and let it do the experiment analysis, which is what it is good at.
- **The game metrics that matter**, since "analytics" usually degenerates into DAU charts:
  - mode share by **minutes played**, not session count (Quest sessions are long and free; deathmatch
    sessions are short and expensive — and this is the input the whole cost model is most sensitive to)
  - level completion by skill × attempt number — **the churn point is where attempt 3 → 4 collapses**,
    invisible in a completion-rate average
  - per-weapon **damage-per-engagement and TTK p50/p90 by range bucket**. Kill share measures
    popularity; TTK measures balance. Balancing on kill share is how you nerf the fun weapon
  - horde wave-reached distribution, and **the wave where the monster budget crosses ~54 entities** —
    that is also the bandwidth cliff, at +460 B/s to every player per entity
  - within-room skill spread (the matchmaking quality metric)
  - first-session churn by elapsed second, bucketed at 10 s
  - **and the one nobody instruments: reconciliation correction magnitude p99 by region.** That is what
    "the netcode feels bad" actually is, it is what a patch silently regresses, and you already have
    every input needed to compute it server-side.
- **No MMP, no Snowflake/BigQuery.** Referral attribution is a server-side fact in your own ledger,
  and `docs/ECONOMY.md` pays on engagement, not signup — which is exactly what an MMP cannot see.

---

## 6. The patch and upgrade system — BUILD, entirely

Nothing on the market versions a custom binary protocol against live matches.

### What is there today, and what breaks

- `shared/src/protocol.ts:31` — `PROTOCOL_VERSION = 2`.
- `server/src/net.ts:401` — `if (this.hello.protocolVersion !== PROTOCOL_VERSION) { this.detach(conn, 1002, 'protocol version mismatch'); }`
  **Strict equality, hard disconnect. Under this rule every deploy is a fleet-wide simultaneous logout.**
- `shared/src/protocol.ts:486` — `out.avatar = r.remaining >= 4 ? r.u32() : 0`. Someone already solved
  backward compatibility correctly, once. **That is the pattern; codify it.**
- `SAVES_VERSION = 3` with a total `migrateSave` and an ordered `SAVE_MIGRATIONS` chain;
  `PERSIST_VERSION = 3` with `migrateProfile`. Both good — extend, don't reinvent.
- **No service worker exists.**
- The warning shot is already in the record: `TERRAIN_VERSION` went 4 → 5 while `server/src/world.ts`
  still asserted 4, and **the server stopped booting mid-run**. That code is still an equality assert
  today (`world.ts:72`, `EXPECTED_TERRAIN_VERSION = 5`). It happened during a load test rather than in
  production purely by luck.

### Rule 0 — three independent version axes, never one "game version"

| Axis | Owns | Bumped when | Gates a connection? |
|---|---|---|---|
| `PROTOCOL_VERSION` | wire format, quantisation, message ids, bitmask layout | an incompatible wire change **only** | **Yes** — against a *supported set*, not equality |
| `CONTENT_VERSION` | levels, terrain, weapon tables, mode constants | any balance or content change | **No** — must match *within a room*, never across the fleet |
| `BUILD_ID` | client bundle hash | every deploy | **Never** |

Their cadences differ by two orders of magnitude: `BUILD_ID` daily, `CONTENT_VERSION` weekly,
`PROTOCOL_VERSION` a few times a year. Conflating them is what makes deploys hurt.

### Protocol: from equality to a supported window

```
PROTOCOL_VERSION        = N      // what this build speaks
PROTOCOL_MIN_SUPPORTED  = N - 1  // what this build still accepts
```

**Size the window off measurement:** take p99 session length and p99 "days since last visit" from your
own telemetry, set the window at 3× the longer. For a browser game that is roughly two weeks. Publish
the number and hold to it.

Rules, enforced by CI and not by memory:

1. **Fields may only be appended**, guarded by `r.remaining >= k`, exactly as `decodeHello` already
   does for `avatar`.
2. **Never renumber a message id, reorder a bitmask bit, or change a quantisation constant** without a
   version bump. The protocol header already says quantisation is fixed for the life of
   `PROTOCOL_VERSION` — add a test that fails if the constants move without the version.
3. **Snapshot bitmasks grow only at the top bit.** A retired field's bit is burned, never reused.
4. **Golden vectors.** A checked-in binary corpus: every message type at every supported version,
   encoded and decoded. CI fails if any decoder's output changes for any existing vector. This is the
   only mechanism that actually stops silent protocol drift — code review does not, and a type system
   cannot see byte layout.
5. **Capability negotiation is the escape valve.** `HELLO` already carries `caps: u16` and the server
   already stores it (`net.ts`). Use it as a feature bitmask so new features reach new clients while
   old clients keep the old encoding **with no protocol bump at all.** A `PROTOCOL_VERSION` bump should
   be rare and deliberate.
6. **A version-matrix CI job**: for each (client vN, server vM) pair in the window, boot a real room,
   run the synthetic client from `tools/loadtest.mjs`, assert clean join / snapshot decode /
   disconnect. The harness already speaks the real protocol — reuse it.
7. **Shared version constants get a supported-set check, never an equality assert.** `world.ts:72`
   throwing on `TERRAIN_VERSION` is what stopped the server booting. Assert *membership in a set*, log
   loudly on the older member, and let the CI matrix catch real incompatibility.

When a client *is* too old, don't just close with 1002 — send a `S2C.UPDATE_REQUIRED` carrying the
minimum build and a reason, so the client can hard-reload its service worker and rejoin.

### Rooms are the deploy unit. Drain, never restart.

This needs one structural change first: **`server/src/index.ts:272` constructs exactly one `Room`.**
Split into two tiers:

- **Director** (stateless, small, behind Cloudflare): room registry, matchmaker, and **the version
  routing table**. Answers "where do I play?" with `{host, port, ticket, protocolVersion, contentHash}`.
- **Room hosts** (stateful, the bare-metal fleet): N rooms per process, one 5 ms scheduler with
  **phase-staggered accumulators**.

A deploy is then:

1. Publish the new client build to R2, immutable, content-addressed. **Never delete an old one** — the
   whole bundle is 0.496 MB brotli, so keeping every build you ever shipped costs nothing.
2. Start new-version room hosts alongside the old.
3. Mark old hosts `draining`. The director stops routing new rooms to them. **Existing matches are
   untouched.**
4. A draining host exits when its last room empties. Bound it: force-migrate at T+30 min, beyond p99
   match length for every mode.
5. Old hosts stay for the full protocol window so N−1 clients still have somewhere to play.

**Nobody is disconnected mid-match, ever, because nothing a player is inside is ever restarted.**

### Staged rollout and the gates

**internal (1 room) → 1% → 5% → 25% → 100%**, assigned by a stable hash of `playerId` so a player does
not flap between versions between matches.

| Gate | Threshold | Why this one |
|---|---|---|
| **per-room tick gap p99** | < 65 ms against a 50 ms target | The load test proved this is the right alarm. **Do not alarm on lost ticks** — `MAX_CATCHUP_TICKS = 8` lets a room be 400 ms late with a zero deficit, and the deficit metric read healthy through every visibly broken stage |
| `arrayBuffers` vs RSS divergence | RSS < arrayBuffers ⇒ page | The exact signature of the 256-room memory failure — the OS is paging out voxel arrays and every tick that touches one faults |
| close-code 1002 rate | ≈ 0 | Your protocol canary |
| reconciliation correction p99 | no regression | The netcode-feels-bad metric |
| crash-free sessions (Sentry release health) | > 99.5% | |
| join-to-first-snapshot p95 | no regression | Catches a chunk-streaming regression before it becomes a bandwidth bill |

**Rollback must be a routing change, not a redeploy**, so it completes in seconds.

### Client delivery: reload without the player noticing

**Ship a service worker — there is none today.** One rule governs it:

> **Never activate a new bundle while `game.playing === true`.**

It precaches the hashed `/a/*` bundle, serves stale-while-revalidate, downloads the new build in the
background when `index.html` points at one, and **swaps only at the next return-to-menu**, with a
"Restarting to update" beat under 300 ms warm. **`skipWaiting()` is banned**; the game controls
activation.

Prerequisites, all of which are current bugs: turn on brotli; move `/c/*` and `/characters/*` under
`/a/` (or emit ETag); keep `index.html` `no-store` (correct — the CSP nonce is per-response, and it is
what makes the pointer to a new build take effect instantly).

### Content and balance ship as data, per room

Levels already work this way — `docs/SPONSORS.md` S28 confirms a new `content/levels/*.json` appears in
mode select, `/api/levels` and as room key `quest:<id>:<skill>` **with no code change.** Extend that
seam to `shared/src/weapons.ts` and mode constants: a **signed, versioned content bundle** fetched by a
room at construction, not baked into the JS bundle.

**The content hash is per-room, not per-fleet.** The room stamps it into `WELCOME`; a client with a
different hash fetches the delta before spawning. That gives you the behaviour you want:

> A balance patch applies to every *new* room immediately, and **no in-flight match ever has its TTK
> changed underneath it.** Changing weapon damage mid-match is not a rollout strategy, it is a bug that
> looks like one.

### Saves and profiles — extend the chain, add one guard

Forward-only and additive; a new field needs a default an older reader ignores safely.
**Two-phase field removal**: release A stops writing it, release B (one full window later) removes it.

**Add a downgrade guard.** Today `migrateSave` clamps to `SAVES_VERSION`, so a v4 document opened by a
rolled-back v3 client is silently rewritten as v3 and the v4 fields are gone. **A rollback that
destroys player data is worse than the bug you rolled back from.** Fix: keep an `_unknown` bag of
unrecognised keys and write it back untouched.

Database migrations are **expand/contract only**: add nullable column → backfill in batches →
dual-write → read new → stop writing old → drop, one release apart. Never a blocking `ALTER` on the
player table at 1M CCU.

### Kill switches

Every new feature ships behind a flag in the edge-served, signed, versioned config document,
**defaulting off**, with a written blast radius. The flag is resolved **server-side** and the resolved
value is told to the client in `WELCOME` — the client never decides. The patch system itself gets a
flag: **"freeze all rollouts", one toggle, reachable from a phone.**

---

## 7. What is NOT covered by engineering

Everything above is software I can build. The following are not, and they are the actual critical path
to revenue.

### Needs your accounts, your identity and your money

| Thing | Why it needs you | Blocking what |
|---|---|---|
| **Hetzner / OVH / Latitude accounts** | Identity verification, a card, and for OVH's GAME range sometimes a sales conversation | Any online mode at all |
| **Cloudflare account** (Pages, R2, Workers, KV) | Domain ownership + payment method | CDN, matchmaker, flags, share cards |
| **A domain** and its DNS | Yours | TLS, CSP, cookie scoping, everything |
| **Paddle account** | Merchant application, business identity, tax details | The $4.99 ad-removal unlock. `POST /api/entitlement` is a mock grant today |
| **Stripe account** (Invoicing, Tax, Identity) | KYC on *you*, business entity, bank account | Sponsor prepay — no sponsor can pay you without it |
| **Tremendous account** | Funding source, business verification | Any prize payout |
| **An ad network**, if you want programmatic fill | Publisher application, site review, tax forms (W-8/W-9), and typically a live traffic threshold before approval | Ad revenue. **I can build the whole ad platform; I cannot get you an advertiser or a network approval.** `docs/ECONOMY.md` decision 3 already says this about sponsors and it is equally true here |
| **WorkOS / Sentry / PostHog / Featurebase accounts** | Cards, though all four start free | Auth, errors, analytics, feedback |
| **AWS account with GameLift access**, if you take that path | Account, billing, and a **written confirmation on the free-bandwidth commitment before 1M CCU** | The top-tier escape hatch |

> **The single most important item on this list is the ad network, and it is the one with the longest
> lead time.** Most networks want a live site with real traffic before they will approve a publisher.
> Start that application the week you launch, not the week you need revenue.

### Needs a lawyer, not an engineer

I can build every control below correctly. **None of them makes the underlying activity lawful in a
given market**, and three of them carry real regulatory exposure.

1. **Real-money prizes.** You chose all three competition shapes including real money.
   - **Skill-based is the default; a random draw is a lottery in several jurisdictions** and goes
     behind an explicit per-event flag with the warning at configuration time, not buried in terms.
   - Required: a jurisdiction allowlist, published per-region official rules, an age floor with
     verified guardian consent, and a tax-reporting field (US 1099-MISC at $600). **The software must
     refuse to open an event with any of these unset.**
   - **Minors generally cannot claim prizes without guardian consent** — enforced at the ledger.
   - `docs/ECONOMY.md` already declines paid loot boxes for the same family of reasons. Extend that
     caution rather than treating prizes as marketing. **The software can be correct and the promotion
     still unlawful.**
2. **COPPA (US, under 13) — the largest exposure.** The amended Rule took full effect **22 April 2026**.
   A free browser voxel shooter in the Minecraft idiom has a **child-heavy audience whatever the ToS
   says** — `docs/SPONSORS.md` §5.3 already reached this conclusion. Concretely: a **neutral age gate**
   (month/year picker, not "are you 16?"); `deviceId` disclosed in the notice as support-for-internal-
   operations and **never** sent to an ad network or third-party analytics SDK; and **a written data
   retention policy is now mandatory** with a stated deletion timeframe — indefinite retention is
   prohibited outright.
3. **GDPR / UK GDPR.** Lawful bases documented per purpose (write the legitimate-interest assessment
   for anti-cheat — it is the document a regulator asks for first); **Art. 8 digital consent is 16**,
   lowerable to 13 by member state, so take the stricter of COPPA and local law per user; **a DPIA is
   mandatory here, not discretionary** (you profile players, you serve advertising, your audience
   likely includes children — three Art. 35 triggers); a RoPA; a DPA with *every* processor; SCCs for
   transfers out of the EEA; an Art. 27 EU representative if you have no EU establishment; and a
   **72-hour breach runbook with a named decision-maker**.
4. **DSA (EU) — three build items, not policy items.** Ads must be identifiable and disclose who paid —
   the DOM slots carry a label but **in-world surfaces have no equivalent and `docs/SPONSORS.md` §5.3
   correctly calls that a real gap**; notice-and-action must produce a tracked case with an SLA; and a
   **statement of reasons for every moderation action** plus an internal complaint system.
5. **UK AADC / Online Safety Act.** Profiling children for advertising is effectively off-limits.
   **The specifically named dark pattern is a countdown interstitial with a low-contrast or delayed
   skip** — hence `docs/SPONSORS.md` S10's visible, high-contrast, keyboard-reachable skip from second
   one. Treat streak-loss pressure and artificial scarcity timers as in scope too.
6. **Trading is economic activity by minors.** Gate at 18 (or local majority) on top of
   `docs/ECONOMY.md`'s cooldowns. Titles and trophies stay untradable — already decided, and it is also
   the anti-laundering control.
7. **Company structure and insurance.** Once real money moves, you want an entity and a cyber/media-
   liability policy that covers **advertising injury** — you are publishing third-party creative.
   Cheaper than the first incident.

### Deletion and export — a job, not a button

| Store | Action |
|---|---|
| Postgres player row, save blob, entitlements | delete |
| Valkey session / presence / frequency caps | delete |
| **ClickHouse telemetry** | `ALTER TABLE … DELETE WHERE player_id = …` — **the one everyone forgets** |
| Ad impression rows keyed to `deviceId` | personal data. Raw ≤ 30 days, aggregate after; delete on request |
| Sentry / PostHog / WorkOS / Featurebase | provider delete APIs, all four |
| R2 share cards, uploads, exports | delete |
| **Builder world block-deltas** | **anonymise the actor, keep the blocks.** Deleting one player's edits from a shared persistent world destroys other people's work. Lawful and defensible **only if disclosed in the privacy policy** |
| Moderation records | **keep.** Legitimate interest — a ban that deletes itself is an exploit |
| Financial ledger | **keep, pseudonymised.** Statutory retention 7–10 years |

30-day soft delete, then hard. **Test the job quarterly against a real account** — an untested deletion
pipeline is an undeletable one.

### The two things that will actually go wrong

1. **`deviceId` leaking to a third party.** Highest-consequence, lowest-visibility failure in the whole
   design: one analytics SDK initialised with the wrong user id and you have shared a persistent
   identifier for a child with an ad network. Defend it with a **branded `DeviceId` type that the
   outbound `SponsorProvider` and analytics interfaces structurally cannot accept**, a CSP-layer egress
   allowlist, and a CI test that greps every provider call site. *A rule that lives only in a document
   will be broken by the third engineer who joins.*
2. **Age unknown treated as adult.** The default must be the **strictest** branch, and `unknown` must be
   its own state — never a falsy that collapses into "not a minor". `docs/SPONSORS.md`'s
   `ageBands: ('unknown' | 'u13' | '13_17' | '18plus')[]` already gets this right. Carry that exact enum
   into the profile record, the ad decision, the prize gate, the trade gate and the profile-visibility
   gate, and **never widen it to a boolean.**

---

## 8. Build order

### Phase 1 — the slice to build first

**Goal: the game is online, on two boxes, for under $400/month, with a deploy that drops nobody.**

Everything in Phase 1 is either a bug fix or already-written code that needs mounting. There is very
little new construction, which is why it is the right first slice.

| # | Task | Where | Why first |
|---|---|---|---|
| 1 | **Brotli + ETag/Last-Modified in `serveStatic`; move `/c/*` and `/characters/*` under `/a/`** | `server/src/index.ts:346` | 2 hours. 1.453 → 0.398 MB cold, 0.121 → 0.008 MB warm. Also a faster game. |
| 2 | **Delta-encode entities** | `server/src/net.ts:874` | The single largest cost lever in the document. Do it *before* the first byte is billed, not after. |
| 3 | **`perMessageDeflate: true` + cache the encoded chunk blob per `(seed, TERRAIN_VERSION)`** | `net.ts` / `world.ts` | 2.98 → 0.78 MB, and 20–50 ms of per-joiner CPU becomes a memcpy. Also closes the HELLO amplification hole. |
| 4 | **Rate-limit HELLO** | `net.ts:399` | With #3, this is the DDoS fix. |
| 5 | **Mount `ModeRouter`; N rooms per process; phase-stagger the accumulators** | `server/src/index.ts:272`, `server/src/modes.ts:462` | The code exists and is tested. This is what turns 32 players into ~3,200. |
| 6 | **Wire the WebSocket transport in the client behind a flag** | `client/src/game/game.ts:446` | `webSocketTransport()` already exists in `client/src/net/client.ts:120`. Keep `createLocalServer()` as the Quest/offline path — it is worth 0 B/s forever. |
| 7 | **`PROTOCOL_MIN_SUPPORTED` + golden vectors + the version-matrix CI job** | `shared/src/protocol.ts:31`, `server/src/net.ts:401` | Cheap now, impossible to retrofit once players are live. Reuse `tools/loadtest.mjs` as the synthetic client. |
| 8 | **Turn `world.ts:72`'s equality assert into a supported-set check** | `server/src/world.ts` | This exact line already took the server down once. |
| 9 | **Retire `JsonFileStore` for Postgres** behind the existing async interface | `server/src/persistence.ts` | The interface is already swappable — that was good design, use it. |
| 10 | **Two boxes, two regions, region picker in the UI** | ops | No geo-routing until you have more than three regions. |
| 11 | **Grafana + the per-room tick-gap alarm at p99 > 65 ms** | ops | Alarm on the right metric from day one. |

**Phase 1 explicitly does NOT include:** ClickHouse, a director tier, autoscaling, Builder persistence,
the advertiser console, the ledger, or anything at all sized for 1M CCU.

### The rest

| Phase | Range | The work | Cost |
|---|---|---|---|
| **0** | today, 0 CCU | Static hosting only. Task #1 above. All four modes already run in the browser. | **$0–5** |
| **1** | launch → 10k | The table above. | **$370–570** |
| **2** | 10k → 100k | Lift `ModeRouter` into a per-region allocator (the director tier). Shared immutable voxel store per `(mode, seed)` — removes the 256-room memory cliff. Third then fifth region. Service worker + staged rollout. ClickHouse. | **$4,500–5,900** |
| **3** | 100k → 250k | Builder onto its own fleet **before any world reaches 100k deltas** (`encodeWorld` is a synchronous 272 ms stall at 500k, every 15 s, blocking every other room). Add the missing fsync. Real allocator with health-checked placement. **Start the committed-bandwidth conversation.** | **$9,000–15,000** |
| **4** | 250k → 1M | 8 regions. Decide bare-metal-with-a-contract vs GameLift **on headcount, with real salaries modelled**. Self-host observability. | **$39,000–55,000** |

### Regional presence

Sub-80 ms RTT leaves a ~50–60 ms network budget once you subtract the tick (measured per-room gap 51.5
p50 / 62.5 p99, and a 20 Hz server adds up to 50 ms of buffering before lag compensation) — roughly
3,000–4,000 km of reach per region [E].

- **5 regions** (US-East, US-West, EU-Central, Singapore, São Paulo) cover ~85% of players under 80 ms.
- **8 regions** (add Tokyo, Sydney, EU-West) cover ~95%.
- **The cost of multi-region at launch is the HA floor, not the marginal** — 8 regions × 2 boxes is
  ~$1,730/month before a single player connects.
- **Quest is what lets you serve Jakarta and São Paulo at full quality years before you can justify a
  box there**, because it is 0 B/s and 0 ms of server RTT. That is a real product advantage, not just a
  cost saving.

### Three things about autoscaling a stateful fleet

- **Builder rooms never empty.** Persistent worlds break the drain model outright. Pin Builder to a
  small always-on fleet, or implement world handoff — `worlds.ts` already has the checkpoint primitive
  (`encodeWorld` → `writeFile` → `rename`), it just has no fsync and no migration path.
- **Scale-*up* is the harder direction.** Room construction is **263–632 ms of blocking CPU** [M]. A
  fresh node building 100 rooms on boot blocks for 26–63 s. **Pre-warm rooms behind the readiness
  check.**
- **Spot's 2-minute warning is shorter than a match.** Spot for lobby/Quest-adjacent work, on-demand for
  live matches — or accept ~1 lost match per interruption.
