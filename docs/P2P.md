# Doomcraft — peer-to-peer multiplayer, the trust boundary, and what it actually saves

Requested: *"use P2P multiplayer to cut server cost."*

This is a decision document. The instinct is right for one mode and dangerous for the other three,
and the line between them is drawn with measurements rather than opinion. Every figure is labelled
**[M] measured**, **[V] vendor-published**, **[E] estimated** or **[C] code-verified**.

Read alongside `docs/INFRASTRUCTURE.md` (the measured cost model every number here is derived from),
`docs/ECONOMY.md` (the rewards, drops and prizes that must never ride on a peer) and
`shared/src/trust.ts` (the table in §6, as code — that file, not this document, is what the game
reads).

---

## 0. The five things to take away

1. **P2P cannot save you bandwidth, because your bandwidth is already free.** On the recommended
   stack — unmetered bare metal — game egress is **$0/month at every player count**
   (`INFRASTRUCTURE.md` §3). A byte costs **$0.00147/GB**. P2P is a bandwidth optimisation aimed at
   a line item that is already zero.

2. **It offloads the resource you have spare.** `INFRASTRUCTURE.md` measures 0.00094 cores/player
   against a port that binds **~3× sooner**: one AX42-class box is port-bound at 3,161 players and
   CPU-bound at 9,404. You buy ports and get cores thrown in. P2P gives you back cores.

3. **Best case, everything stacked, at 1M CCU: +$8,144/month — 14.8% of a $55,200 bill.** At 100k
   CCU it is **−$968**. At 1k CCU it is **−$617**. It is negative below 1M CCU for a structural
   reason: a TURN fleet has the same per-region HA floor the game fleet has, and it buys you nothing
   else.

4. **One 1–2 day fix is worth about twice the entire P2P programme.** `server/src/net.ts:874`
   unconditionally sets `s.entityMask[slot] = EF_SPAWN | EF_ALL`, retransmitting ~33 *stationary*
   pickups in full 20×/s forever [C]. Fixing that, plus gzipping and caching the per-room chunk blob,
   is **~$16,000/month at 1M CCU** with zero anti-cheat cost, zero host-migration risk and zero
   support load. And the two are **not additive** — the fix eats P2P's prize, taking it from +$5,263
   to **+$1,878/month**.

5. **The one build worth doing is online co-op Quest, and it pays out nothing.** It is the only place
   P2P avoids a cost rather than removing one, because online co-op Quest does not exist yet.
   Everything that touches the economy — ranked play, tradable drops, competition results,
   sponsor-funded prizes — stays on hardware we control, permanently, and `shared/src/trust.ts`
   plus `server/src/entitlementGuard.ts` make that structural rather than remembered.

---

## 1. What P2P actually saves, and what it does not

### The honest line, so nobody re-derives this later

> **Egress is already $0 on the recommended stack.** Not "cheap" — zero. Unmetered 1 Gbit ports on
> bare metal, `INFRASTRUCTURE.md` §3, every CCU tier. Anyone who proposes P2P as a *bandwidth*
> saving in future is working from the raw-EC2 mental model, where egress would be $968,550/month at
> 1M CCU. That is a real number and it is why the provider decision matters more than every other
> engineering decision combined — but it is a decision that has already been made, and making it
> correctly is what removed the bandwidth argument for P2P.

What P2P actually removes is a **game host**: a slice of a box, sold to you as a whole port whose
bytes you were not paying for. So the saving is the *box*, and the box is priced by the port.

| P2P saves | P2P does not save |
|---|---|
| Game-host boxes for the modes it covers | Egress — already $0 [M] |
| CPU, which binds ~3× after the port [M] | The HA floor: 2 boxes/region whatever the load |
| Cost of a feature not yet built (online co-op Quest) | The fallback fleet — an all-mobile lobby has no eligible host, so capacity stays provisioned |
| | Signalling, STUN, TURN, and their own HA floors |
| | Support load for NAT failures you cannot fix for the user |

### Per-player server cost, recommended stack ($1.714 × 10⁻⁶ per B/s-month)

| Mode | as-built B/s [M] | $/player-month | after the two egress fixes | $/player-month |
|---|---|---|---|---|
| **Quest** (single-player) | **0** | **$0** | 0 | **$0** |
| Deathmatch | 27,205 | $0.0466 | 9,660 | $0.0166 |
| **Horde** | **32,226** | **$0.0552** | 18,231 | $0.0313 |
| Builder | 20,008 | $0.0343 | 7,118 | $0.0122 |

Horde is **38.8% of blended game egress on 20% of players** — a 4-player cap against 55 entities
means each player pays for ~55 non-delta-encoded entities with only two others to amortise against.
That is why it looks like the P2P prize, and §3 is why it is not.

### The addressable set is one mode, plus one that does not exist

| Mode | Cap | P2P applicable? | Why |
|---|---|---|---|
| **Quest** (single-player) | 4 | **N/A** | Already runs entirely in the client's Web Worker. **0 B/s, $0 today.** Nothing to save. |
| **Quest co-op, online** | 4 | **Yes** | Does not exist yet — this is cost *avoided*, not reduced |
| **Horde** | 4 | **Yes**, if you strip rewards | Casual co-op, no PvP integrity requirement |
| **Builder** | 16 | **No** | Needs an authoritative persistent world (`worlds.ts`, `MAX_WORLD_DELTAS`, autosave). A peer cannot own a world other players return to. |
| **Deathmatch** | 32 | **No** | Ranked, tradable drops, competition results. `ECONOMY.md` decision 1. |

### Net saving, Horde P2P, self-hosted TURN, by CCU

| CCU | Game-host line | Horde slice | Gross saved @ f=22% | TURN + signalling | **NET** | % of bill |
|---|---|---|---|---|---|---|
| **1,000** | $220 | $85 | $63 | $680 (4 relay boxes, HA floor) | **−$617** | −167% of the $370 bill |
| **100,000** | $2,565 | $995 | $732 | $1,700 (10 boxes, HA floor) | **−$968** | −16.5% of the $5,865 bill |
| **1,000,000** | $28,500 | $11,060 | $8,133 | $2,870 (17 boxes) | **+$5,263** | +9.5% of the $55,200 bill |

Sensitivity at 1M CCU: f=10% → +$7,010; f=22% → +$5,263; f=30% → +$3,299; **f=50% → −$1,462**.

**At 100k CCU the TURN HA floor alone ($1,500) exceeds the entire gross saving ($732).** This is the
same point `INFRASTRUCTURE.md` already makes about the game fleet — "at 1k CCU everything is the HA
floor, not the load" — applied to a second fleet that does no simulation at all.

### Online co-op Quest — cost avoided, if you build it

| CCU | Server-hosted would cost | P2P avoids, net of relay |
|---|---|---|
| 1,000 | $150/mo (1 box) | **−$40** |
| 100,000 | $600/mo (4 boxes) | **+$291** |
| 1,000,000 | $5,550/mo (37 boxes) | **+$2,731** |

### The comparison that settles it

> Best case, everything stacked, at 1M CCU:
> gross Horde saving **$8,133** + gross Quest co-op avoidance **$4,081** − TURN and signalling
> **$4,070** = **+$8,144/month, 14.8% of the $55,200 bill.**
>
> `net.ts:874` + gzip the chunk blob, **1–2 days**: **~$16,000/month.**
>
> **The one-line fix is ~2× the whole P2P programme, and it is not additive with it.** Ship the
> egress work first and Horde falls to 18,231 B/s, so P2P's net at 1M CCU drops from +$5,263 to
> **+$1,878/month on a $39,150 bill — 4.8%.**

And 1M CCU is the only tier where any of this is positive — a tier `INFRASTRUCTURE.md` itself calls
"overwhelmingly unlikely… the realistic outcome distribution is *never exceeds 10k CCU*." **At 10k
CCU the P2P saving is $0, because the bill is an HA floor.**

---

## 2. Mesh feasibility — measured, not guessed

### The architecture genuinely does favour this [C]

Confirmed by reading the tree before designing anything:

- `client/src/net/localServer.ts` runs the whole authoritative stack (`room.ts`, `sim.ts`,
  `world.ts`, `net.ts`) inside a module Web Worker behind a small server-side transport interface.
- `client/src/net/client.ts:109` takes any `ClientTransport` — four members, a `WebSocket` and a
  `Worker` both fit.
- `server/src/room.ts:974` — `join(transport)` — and `net.ts`'s `connections[]` array mean `Room`
  has **always** been multi-connection. The local server historically attached exactly one.

So a host-authoritative peer is not a rewrite: it is the existing worker server with its socket
replaced by a WebRTC DataChannel. That is an accident of good architecture and it is worth a lot.

Two caveats found in the same read, and the second is the real work:

- **The delta encoder is written against a reliable, ordered transport.** `net.ts:876` sets
  `conn.knownEntity[e] = 1` **at send time, never on an ack**, and a chunk is marked
  `conn.chunkSent[slot] = 1` the instant it is written. Recovery is only
  `FULL_SNAPSHOT_INTERVAL_MS = 3000` (`net.ts:117`). On an *unreliable* DataChannel a single lost
  snapshot leaves a client wrong for up to **3 seconds**, and a lost chunk is a permanently missing
  piece of world.
- Therefore either you use **reliable-ordered SCTP** — head-of-line blocking, i.e. **no latency win
  over the WebSocket you already have**, which deletes the usual second argument for WebRTC — or you
  add snapshot repair to `net.ts`, the one file that must never fork between the server and the peer
  build. The cheapest correct form is to let a peer's next snapshot be forced baseline-free rather
  than to teach the encoder acks; `net.ts` already decides "full or delta" from public connection
  state, so repair is a reset, not a redesign.

### Model used [M]

`INFRASTRUCTURE.md` §2, reproduces the harness within 1.5%:

```
snapshot bytes = 20 + 23.0·E + 17.5·N      sent at SNAPSHOT_HZ = 20
input          = 16 payload bytes          sent at INPUT_SEND_HZ = 60
```

WebRTC per-packet framing = **93 B** [E, arithmetic from RFCs]: IPv4 20 + UDP 8 + DTLS 1.2 AES-GCM
record 37 + SCTP common 12 + SCTP DATA chunk 16.

### Host-authoritative star, deathmatch-shaped room (E = 33)

| N | host upstream | host pps up | guest upstream | guest pps |
|---|---|---|---|---|
| 4 | 56,520 B/s = **0.45 Mbps** | 60 | 6,540 B/s = 0.05 Mbps | 60 |
| 8 | 141,680 B/s = **1.13 Mbps** | 140 | same | 60 |
| 16 | 345,600 B/s = **2.76 Mbps** | 300 | same | 60 |
| 32 | 887,840 B/s = **7.10 Mbps** | 620 | same | 60 |
| 50 | 1,712,060 B/s = **13.70 Mbps** | 980 | same | 60 |

Horde (E=55, cap 4): host up **0.70 Mbps**. Builder (E=30, cap 16): host up **2.60 Mbps**.

**Surprise worth flagging:** guest upstream *rises* from the measured 1,310 B/s on WebSocket to
**6,540 B/s on WebRTC — 5.0×** — because the input packet is 16 bytes and the framing is 93. At
60 Hz the headers outweigh the payload 5.8:1. This also worsens the "pps on real NICs" item
`INFRASTRUCTURE.md` §2 already flags as unmeasured.

### Full mesh (distributed authority)

| N | per-peer up @20 Hz | @60 Hz | up pps @20/@60 | PeerConnections/browser | links | P(≥1 relayed), p=0.22 |
|---|---|---|---|---|---|---|
| 4 | 0.15 Mbps | 0.46 | 60 / 180 | 3 | 6 | 77% |
| 8 | 0.25 Mbps | 0.76 | 140 / 420 | 7 | 28 | 99.9% |
| 16 | 0.43 Mbps | 1.28 | 300 / 900 | 15 | 120 | ~100% |
| 32 | 0.76 Mbps | 2.29 | 620 / 1,860 | 31 | 496 | ~100% |
| 50 | 1.14 Mbps | 3.43 | 980 / 2,940 | 49 | 1,225 | ~100% |

**Bandwidth is not what kills the mesh.** What kills it, in order:

1. **No authority model this codebase can support.** Distributed authority makes every peer
   authoritative over its own hitbox — precisely what `net.ts:449` (dt clamped to
   `MAX_INPUT_DT_MS = 50`), `net.ts:605` (the `INPUT_TIME_SCALE` time bank), `net.ts:490`
   (`OUT_OF_REACH` edit rejection) and `sim.ts:1037` (lag-comp rewind) exist to prevent [C].
2. **Deterministic lockstep — the one cheat-resistant mesh — is blocked in the tree.**
   `sim.ts:274-275` calls `Math.sin`/`Math.cos` inside `moveStep`, the core per-tick movement path,
   and `terrain.ts` uses them in world *generation* [C]. ECMAScript leaves these
   implementation-approximated; V8, SpiderMonkey and JSC do not agree bit-for-bit. Two browsers can
   diverge on the first tick of movement, and a Safari peer can generate different terrain from the
   same seed. Lockstep needs a fixed-point rewrite of the math layer first.
3. **Connection and packet load.** 49 simultaneous `RTCPeerConnection`s per browser at N=50, 1,225
   ICE+DTLS negotiations per room, 2,940 pps upstream at the game's real 60 Hz.

### Real consumer upstream [V]

| Link | Upload |
|---|---|
| Global median **fixed** broadband | **51.49 Mbps** (Ookla via DataReportal, Nov 2024) |
| US median fixed | ~**56 Mbps** (Ookla, 2026) |
| Global median **mobile** | **11.71 Mbps** (Ookla via DataReportal, Nov 2024) |
| Mobile 4G / 5G, Opensignal Australia | **8.8 / 15.6 Mbps** (May 2026) |
| Best mobile operator in the world, Upload Speed Experience | **14 Mbps** (T-Mobile, Opensignal 2026) |
| US cable (Xfinity / Spectrum) residential tiers | **5–35 Mbps**, most plans 10–35 |
| FCC broadband benchmark | 100/**20** Mbps; 93.9% of Americans have access (June 2025) |

### Largest match each topology can actually sustain

Budget = 50% of the uplink (bufferbloat headroom on a realtime stream).

| Host's connection | Star, bandwidth-only | Star, honest ceiling |
|---|---|---|
| Fibre 50+ Mbps up | N ≤ 64 | **32 (the shipped `MAX_PLAYERS`)** — CPU and cheat bind first |
| Cable top tier, 35 Mbps | N ≤ 58 | **~24** |
| Cable typical, 20 Mbps | N ≤ 40 | **~16** |
| Cable entry, 5 Mbps | N ≤ 14 | **~8** |
| Mobile median, 11.71 Mbps | N ≤ 27 | **never host** (§7) |

**And the join burst hits the host, not you.** `net.ts` streams all 169 chunks (**2.98 MB** [M]) to
every joiner, re-running `encodeChunk` per client:

- N=4 star: host uploads **8.94 MB** = **6.1 s of a mobile uplink**, 3.6 s of a 20 Mbps cable
  uplink, entirely blocking (1.6 s / 0.9 s if you gzip it first).
- N=16 star: **44.7 MB** = **30.5 s on mobile**, 17.9 s on cable (8.0 s / 4.7 s gzipped).

Plus 20–50 ms of CPU per joiner measured on an M3 Pro — likely 100–250 ms on a mid-range phone,
×(N−1).

> **Verdict: full mesh — no size is shippable.** Practical ceiling on connections and pps alone is
> ~8, and the authority problem makes it 0 for a shooter. **Host-authoritative star — 4 comfortably,
> 8 safely, 16 on a good fixed line, 32 only on fibre and only where a cheating host does not
> matter.** `PEER_MAX_PLAYERS` in `shared/src/trust.ts` is 4.

---

## 3. TURN fallback rate — the number that decides it

### Published real-world figures [V]

| Source | Relay rate |
|---|---|
| callstats.io, billions of session minutes (via webrtcHacks) | **22% of conferences needed a TURN relay**; 9% needed TCP |
| Chrome UMA, consumer open-internet traffic | direct succeeds 75–80% → **20–25% relayed** |
| ICE-candidate analysis, general | ~**30%** |
| bloggeek.me (Tsahi Levent-Levi) | "anything between **0 and 50 percent**, depending on your user base" |
| Corporate / institutional networks | **60–70%** |
| Observed spread across deployments | 4% → 30% |

**Mobile is the bad case, and mobile is your case.** Carrier-grade NAT behaves like a symmetric NAT
and often blocks inbound UDP; cellular users are a common reason connections end up relayed. A game
that ships portrait phones should plan on the **25–30%** end, not 8%. And relay is **2× by
construction**: your relay ingests the stream and re-emits it.

### The marginal price of a byte, derived from `INFRASTRUCTURE.md` §3

$28,500/mo ÷ 190 boxes = $150/box; 133 Gbps peak ÷ 190 boxes = 0.70 Gbps usable per 1 Gbit port; at
the doc's 0.45 average/peak convention that is 102,060 GB/box-month.

> **$0.00147 per GB.** That is what a byte costs you. Everything below is measured against it.

| TURN option | $/GB | vs the bare-metal byte |
|---|---|---|
| Self-hosted coturn on the same unmetered bare metal | $0.00147 | **1×** |
| Cloudflare Realtime TURN [V] | $0.05 | **34×** |
| Twilio Network Traversal Service, US/DE [V] | $0.40 | **272×** |
| Twilio NTS, Singapore/India/Japan [V] | $0.60 | 408× |
| Twilio NTS, Australia/Brazil [V] | $0.80 | **544×** |

### Break-even fallback rate f — the rate above which P2P stops saving

A relayed guest costs your relay the host→guest snapshot **plus** the guest→host inputs; a
server-hosted player costs your game box the snapshot only. A relayed Horde player therefore
consumes **1.203×** the egress of simply hosting them (Deathmatch: 1.240×).

| Mode / TURN price | f at break-even | Real-world f |
|---|---|---|
| Horde / **self-hosted coturn** | **83.1%** | 20–30% |
| Deathmatch / self-hosted coturn | 80.6% | 20–30% |
| Builder / self-hosted coturn | 75.4% | 20–30% |
| Horde / **Cloudflare TURN $0.05/GB** | **2.4%** | 20–30% |
| Deathmatch / Cloudflare TURN | 2.4% | 20–30% |
| Horde / **Twilio $0.40/GB** | **0.3%** | 20–30% |

**Two clean conclusions.**

1. **Any managed TURN provider is disqualifying, immediately and by two orders of magnitude.** At
   Cloudflare's $0.05/GB a relayed Horde player costs **$2.26/player-month** against **$0.055** to
   just host them — 41×. On Twilio it is **$18.09** against $0.055 — 328×. Real relay rates are 8–12×
   past Cloudflare's break-even and 70–100× past Twilio's. No traffic shaping recovers this.
2. **Self-hosted coturn on your own unmetered bare metal is the only price that works** — break-even
   at 75–83% relay, comfortably above the 20–30% to expect. But note *why*: because the byte is
   already free. The relay saving is not "P2P is cheap", it is "your hosting is already free, so the
   relay is also free." And the relay box does **no simulation** — on a fleet where bandwidth binds
   ~3× before CPU, a relayed player consumes the same port capacity as a hosted player while wasting
   the CPU you paid for alongside it.

> **Answer to the question as asked:** with self-hosted TURN, P2P stops saving money above a **~83%**
> fallback rate. With any managed TURN provider it stops saving above **~2.4%** — which is below
> every published figure in the industry.

---

## 4. What it costs

### Infrastructure you must add and keep

| Item | Cost | Note |
|---|---|---|
| **Signalling** (offer/answer/ICE, room codes) | ~$20/VM, 2 per region HA = $320/mo at 8 regions | Small, and you need matchmaking anyway |
| **STUN** | ~$0 | Run it on the signalling box; never depend on Google's public STUN in production |
| **TURN — self-hosted coturn** | **$1,500–3,770/mo** at 100k–1M CCU, **HA floor of 2 boxes per region regardless of load** | The only affordable option |
| **TURN abuse surface** | engineering | TURN is an open relay and a reflector. Needs ephemeral HMAC credentials, per-user quotas and its own DDoS posture. `INFRASTRUCTURE.md` already warns that an unauthenticated amplifier is worth more to an attacker than any scrubbing contract |
| **Fallback game fleet you can never retire** | full HA floor | All-mobile lobbies have no eligible host |

### Engineering, concretely

1. **WebRTC transport on both sides** — small; the interfaces are already 4–8 members.
2. **Multi-connection local server** — `Room` is already multi-connection; the local server attached
   exactly one. Small.
3. **`net.ts` unreliable-transport repair.** The blocker, and the one place a bug becomes a cheat.
   Must not fork between the server and the peer build.
4. **Host election and eligibility probing** — uplink, device class, battery, tab visibility, and a
   hard "never a phone" rule.
5. **Host migration** (§7).
6. **Two anti-cheat regimes** and the product surgery to keep them apart (§6).
7. **Support and telemetry for connection failures** — a class of ticket you do not have today,
   because today nothing connects to anything.

### Support burden

At f=22% per link, **P(at least one guest in a 4-player room is relayed) = 52.5%**; at N=8, 82%; at
N=16, 97.6%. The *majority* of P2P rooms touch TURN, and "it worked for my friend but not for me"
becomes a standing support category. Diagnosing NAT failures across arbitrary consumer routers, CGNs
and corporate firewalls is not something you can fix for the user.

### The anti-cheat hole — non-negotiable

A host-authoritative peer runs `sim.ts` in readable JavaScript on hardware the player controls. Every
guard in the tree — `MAX_INPUT_DT_MS = 50` (`net.ts:449`), the `INPUT_TIME_SCALE` time bank
(`net.ts:605`), `OUT_OF_REACH` reach checks (`net.ts:490`), lag-compensated hitscan with
`LAG_COMP_MAX_MS` rewind (`sim.ts:1037`) — protects the room **from its clients**. None of it
protects anyone from the room's **owner**.

A host can fabricate kills, wave counts, drops, match duration and match results at will, and
`ECONOMY.md`'s XP, Scrap, drops, share cards ("generated server-side from match data so it cannot be
faked") and competition results all key off exactly those.

> **Therefore: any match that goes P2P awards nothing.** No XP, no Scrap, no drops, no leaderboard,
> no share card, no challenge progress. `ECONOMY.md` explicitly lists "horde waves survived" as an XP
> source — so making Horde P2P means **removing progression from Horde**. That is a product cost the
> $5,263/month does not cover, and it is the second reason (after the arithmetic) that Horde stays on
> our servers.

---

## 5. The recommended split

| Mode | Topology | Why |
|---|---|---|
| **Quest, single-player** | **Client Web Worker — unchanged** | Already 0 B/s and $0. Do not touch it. `INFRASTRUCTURE.md` values routing first sessions here at up to $8,000/mo |
| **Quest co-op, online** | **Host-authoritative peer, ≤4** — the *only* build worth doing | Cost **avoided**, not reduced. Unranked, no drops, no XP. Friends-only invite links, no matchmaking. Server fallback when no peer is eligible to host |
| **Horde** | **Server-authoritative** | Only $5,263/mo at 1M CCU to move it, $0 or negative below that, and it costs Horde its entire progression loop. Revisit only above 500k CCU *and* after the egress fixes ship |
| **Builder** | **Server-authoritative, always** | Persistent world with authoritative state. `worlds.ts` shards by world id; a world lives on exactly one host. A peer cannot own something other players come back to |
| **Deathmatch** | **Server-authoritative, always** | Ranked, tradable drops, competition and sponsor-funded prizes. `ECONOMY.md` decision 1. A host peer also gets a free 0 ms latency advantage — unacceptable in a competitive mode before you even reach the cheating |
| **Full mesh** | **Never, at any size** | No authority model this codebase supports, and lockstep is blocked by `Math.sin`/`Math.cos` in `sim.ts:274-275` and `terrain.ts` |

### Blended cost model, recommended

| Line | 1k CCU | 100k CCU | 1M CCU |
|---|---|---|---|
| Baseline total (`INFRASTRUCTURE.md`) | $370 | $5,865 | $55,200 |
| **After the two egress fixes (do these first)** | **$370** | **$4,515** | **$39,150** |
| …minus P2P co-op Quest, if built (net of TURN) | −$0 | −$291 | −$2,731 |
| **All-in** | **$370** | **~$4,224** | **~$36,400** |

The P2P line is **0% of the bill at 1k, 6% at 100k, 7% at 1M** — and it exists only because online
co-op Quest does not exist yet, so P2P avoids a cost you have not yet incurred rather than removing
one you have.

---

## 6. The trust table

The split above is a recommendation. **This table is enforcement.** It lives in
`shared/src/trust.ts`, it is the only thing in the codebase that decides whether a match counts, and
it validates itself at module load — a bad edit throws on the first import in every build and every
test rather than on the first payout.

### Two independent reasons a match grants nothing

1. **Untrusted simulation.** A peer or a local Worker computed the result. There is no way to tell a
   real match from a fabricated one.
2. **Uncontrolled participation.** An invite-only lobby lets four friends stand still and farm each
   other. The simulation can be perfectly honest and the result still be worthless.

A row must clear **both** before it may grant anything. That is why every solo and private row grants
nothing *even when we host it ourselves*.

### The table

| Mode | Match type | Topology (permitted) | Grants | Durable writes | Cap |
|---|---|---|---|---|---|
| Quest | Solo | **Client-local** | — | local record | 1 |
| Quest | Private (co-op) | **Peer-hosted** | — | local record | 4 |
| Quest | Public | Server | XP, Scrap, drops, challenges, stats, share card, trade unlocks | account record | 4 |
| Quest | Competition | Server | everything except ranked rating | account record | 4 |
| Builder | Solo | **Client-local** | — | local record | 1 |
| Builder | Private | Server | — | **persistent world**, account record | 16 |
| Builder | Public | Server | XP, challenges, stats, trade unlocks | **persistent world**, account record | 16 |
| Horde | Solo | **Client-local** | — | local record | 1 |
| Horde | Private (co-op) | **Peer-hosted** | — | local record | 4 |
| Horde | Public | Server | XP, Scrap, drops, challenges, stats, share card, leaderboard, trade unlocks | account record | 4 |
| Horde | Competition | Server | everything except ranked rating | account record | 4 |
| Deathmatch | Solo | **Client-local** | — | local record | 1 |
| Deathmatch | Private | Server | — | — | 32 |
| Deathmatch | Public | Server | XP, Scrap, drops, challenges, stats, share card, trade unlocks | account record | 32 |
| Deathmatch | Ranked | Server | + **ranked rating**, leaderboard | account record | 32 |
| Deathmatch | Competition | Server | + **competition standing, sponsor prizes** | account record | 32 |

A pair with no row is **not offered**, and lookup fails closed to a deny-everything policy.

### Four properties worth understanding before editing it

**`topology` is a ceiling, not a description.** It is the *weakest* trust a row may run at. A
peer-hostable row may also be run on our own servers — for reliability, or because no peer was
eligible — and doing so changes **nothing** about what it grants. Rewards are a property of the row,
not of the run. Turning rewards on therefore requires editing `trust.ts`, and the validator will
refuse the edit unless the topology moves too.

**Deathmatch cannot be peer-hosted at all, and that is an invariant rather than a comment.** The
validator rejects any free-for-all mode on a peer topology, because the host plays at 0 ms against
everybody else. That is unacceptable even in a match where nothing is at stake.

**Builder's persistent world is a `write`, not a `grant`.** A private Builder world saves normally
while paying no XP or drops — the two are separate masks, so "invite-only creative with infinite
blocks is a reward farm" and "a world must live on a host that is still there tomorrow" are separate
rules that cannot accidentally cancel each other out.

**No mode literal appears in the enforcement or the display.** `server/src/entitlementGuard.ts` and
`client/src/ui/matchType.ts` contain zero `ModeId` references, and `shared/src/trust.test.ts` scans
the whole tree to keep it that way — including a check that nothing anywhere pairs a mode literal
with a reward or ranked verdict on the same line. The policy cannot leak back out of the table one
convenient `if` at a time.

### Enforcement — the server decides, from how the session was created

`server/src/entitlementGuard.ts` keeps a ledger of every session **this process created**. A
submission is checked in this order, and the order is the specification:

```
unknown session id      -> reject   fail closed; never default-accept
session already closed  -> reject   a late result is a replay
submitted by the client -> reject   ECONOMY.md decision 1, regardless of session
untrusted topology      -> reject   peer / local — the headline rule
device was not in it    -> reject   a host settling for the other three players
already submitted       -> reject   one payout per player per session
reward not in `grants`  -> strip    a Public match asking for ranked rating
over the per-match cap  -> clamp    defence in depth behind the room's own tally
```

The guard reads **its own ledger entry**, never the submission's `claimedMatchType` or
`claimedTopology`. Those fields exist so a lying client has somewhere to lie and so the lie can be
*recorded*. A peer-hosted session is rejected whole — not stripped to a "safe" subset — because there
is no such thing as a partly trustworthy result from a room whose owner could edit the sim.

**A related hole this closes.** `POST /api/profile` currently merges the client's whole `progress`
object into the stored profile after a range check, which means a client can post itself XP up to
the validator's ceiling without playing a match. `guardProfileWrite()` splits the profile into
client-owned fields (settings, bindings, loadout, name, skin) and server-owned fields (xp, level,
kills, wins, stats, entitlements, drops, rating) and drops the latter. The client never grants —
including through the back door.

### The player must never find out afterwards

`client/src/ui/matchType.ts` renders the same table at the three moments that matter: the picker
(each match type labelled with who hosts it and what it pays), one line under the play button, and a
compact chip that stays in the HUD for the whole match. An unranked match is amber and says *why* —
"one of the players is hosting this match, so we cannot verify the result" — because "unranked"
without a reason reads as an arbitrary punishment and gets argued with.

The wording lives in the trust table itself (`playerNote` on every row), so changing a policy and
changing what the player is told are the same edit.

---

## 7. Host migration — what happens when the host closes their laptop

Concretely, in order:

1. **No FIN arrives.** A closed lid suspends the process; the socket is not closed, it just stops. To
   every guest this is indistinguishable from packet loss.
2. **Detection is by timeout only.** The existing floor is `CLIENT_TIMEOUT_MS = 15000`
   (`constants.ts:145`, used at `net.ts:345`) [C]. Without a new, faster peer-liveness probe the
   match hangs for **15 seconds** before anyone concludes the host is gone. Even with an aggressive
   probe you cannot go much below **~2 s** without false-positiving on a mobile radio handover.
3. **Elect a new host** — needs an agreed deterministic ordering, and the new host must be eligible
   (not a phone, adequate uplink).
4. **Rebuild state on the new host.** Either it has been shadowing the sim all along — double the CPU
   on every peer, and it re-opens the `Math.sin`/`Math.cos` cross-engine divergence — or it must be
   re-seeded: **2.98 MB** of world on the wire = **2.0 s on mobile / 1.2 s on cable** (0.5 s / 0.3 s
   gzipped), plus live entity, projectile, score and player state.
5. **Re-ICE every surviving guest to the new host** — fresh ICE gathering plus a DTLS handshake per
   guest, **0.5–2 s each**, longer through TURN, and each one re-rolls the ~22% relay dice.
6. **Some guests cannot reconnect at all.** NAT reachability is pairwise. A guest who could reach the
   old host may have no direct path to the new one, and now needs TURN it was not using a moment ago.

> **Realistic total: 5–20 seconds of frozen, then partly broken, match.** In Horde that means a wave
> in progress is lost. **And the migration itself is a cheat vector — a losing host can force one.**

**A second, quieter version of the same failure: the host alt-tabs.** The room runs in a dedicated
Worker and the project's own keepalive worker documents that worker timers escape Chrome's intensive
throttling, so a backgrounded *desktop* host keeps ticking — genuinely good news, and another
accident of good architecture. But **iOS Safari suspends background JS in seconds**, and Chrome
freezes hidden tabs after five minutes.

> **A phone must never be elected host, at any N.** Not bandwidth — availability. Any phone call,
> notification or app switch ends the match for everyone in it. Because you support portrait phones,
> this removes a large share of the player base from the eligible-host pool, and an all-mobile lobby
> has **no** host — it must fall back to a real server. **You can never decommission the server
> fleet, only run it at lower utilisation.** `PEER_HOST_REQUIREMENTS.allowMobileHost` in `trust.ts`
> is `false`, and `describeHostEligibility()` gives the player a reason they will accept.

---

## 8. The hard rules, if the co-op Quest peer gets built

1. **Self-hosted coturn on your own unmetered bare metal. Never a managed TURN provider** —
   Cloudflare is 34× and Twilio 272–544× the bare-metal byte, break-even at a 2.4% / 0.3% fallback
   rate against a 20–30% reality.
2. **Never elect a phone as host.** iOS suspends background JS in seconds.
3. **A P2P room awards nothing** — no XP, no Scrap, no drops, no leaderboard, no share card. Enforced
   server-side by `entitlementGuard.ts` refusing results from a session the server did not simulate,
   not by the client agreeing to behave.
4. **`net.ts` must not fork.** One `net.ts` for the server and the peer, or you are maintaining two
   anti-cheat implementations and shipping bugs to whichever one is not under test.
5. **Fix the entity delta first** (`net.ts:874`). It is worth more than the entire P2P programme and
   costs 1–2 days.
6. **The player is told before they play, not after.** Every peer-hosted match is visibly labelled
   unranked, with the reason, at pick time and for the whole match.

---

## 9. Build order

1. **`net.ts:874` entity delta + gzip and cache the per-room chunk blob.** 1–2 days, ~$16,000/mo at
   1M CCU, no risk. Nothing else on this list competes with it.
2. **Ship the trust boundary before the transport.** `shared/src/trust.ts`,
   `server/src/entitlementGuard.ts` and `client/src/ui/matchType.ts` are cheap, and they mean the
   first peer-hosted match cannot pay out by accident. They are also useful on their own: rule 3 in
   §6 closes a live `POST /api/profile` hole that exists today with no peer anywhere near it.
3. **Online co-op Quest on a host-authoritative peer, ≤4, invite links only.** The one build the
   arithmetic supports.
4. **Revisit Horde only above 500k CCU**, and only once (1) has shipped, at which point the
   remaining prize is +$1,878/month and should be weighed against deleting Horde's progression loop.
5. **Full mesh: never.**

---

## Sources

- [webrtcHacks — The Big Churn (callstats.io: 22% of conferences need TURN)](https://webrtchacks.com/usage-stats/)
- [bloggeek.me — TURN server in WebRTC: when you need it and what it costs](https://bloggeek.me/webrtcglossary/turn/)
- [Twilio — Network Traversal Service Pricing](https://www.twilio.com/en-us/stun-turn/pricing)
- [Cloudflare — Realtime TURN Service pricing](https://developers.cloudflare.com/realtime/turn/)
- [RFC 8831 — WebRTC Data Channels (SCTP framing)](https://www.rfc-editor.org/rfc/rfc8831.pdf)
- [WebRTC for the Curious — Data Communication](https://webrtcforthecurious.com/docs/07-data-communication/)
- [DataReportal / Ookla — Digital 2025: global median fixed upload 51.49 Mbps, mobile 11.71 Mbps](https://datareportal.com/reports/digital-2025-sub-section-accelerated-access)
- [Opensignal — Australia Mobile Network Experience, May 2026](https://insights.opensignal.com/reports/2026/05/australia/mobile-network-experience)
- [Opensignal — Global Mobile Network Experience Awards 2026](https://insights.opensignal.com/2026/02/11/global-awards-2026/dt)
- [ConnectCalifornia — Spectrum / Xfinity 2026 pricing incl. upload tiers](https://www.connectcalifornia.com/internet-service/spectrum-pricing)
- [Benton Institute — How the FCC Got to 100/20](https://www.benton.org/blog/how-fcc-got-10020)
- [TelecomLead — FCC Broadband Report 2026](https://telecomlead.com/broadband/fcc-broadband-report-2026-97-of-americans-access-100-20-mbps-as-rural-internet-and-5g-coverage-expand-127308)
- [IEEE ComSoc — Ookla U.S. Speedtest Connectivity Report H1 2026](https://techblog.comsoc.org/2026/07/23/highlights-from-ooklas-u-s-speedtest-connectivity-report-mobile-fixed-networks/)

**In-repo:** `docs/INFRASTRUCTURE.md` §2 (every measured primitive), §3 (the cost derivation);
`docs/ECONOMY.md` (decision 1, the rewards this document protects); `shared/src/trust.ts` (the table
in §6, executable); `shared/src/trust.test.ts` and `server/src/entitlementGuard.test.ts` (the
enforcement, proved).
