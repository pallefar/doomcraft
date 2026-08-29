# Doomcraft — content packs and the release console

Requested, verbatim, 2026-08-22:

> *"once the admin panel has been created, ensure that the upgrade framework is wired on, so that any updates we develop are reviewed and then pushed via the admin panel. I think to make this safe, we can expand the upgrade framework to full patch, character addition, weapons, maps, levels, quests and expansion packs, this way, not all upgrades hit the entire game"*

This is a decision document. Every axis the request names is enumerated below and marked **SHIP**, **LATER** or **REJECTED**, and the rejected ones say what killed them. Where there was a choice, one option is picked here and the alternatives are in §10 "Considered and rejected".

Read alongside `docs/PATCHING.md` (the three version axes, the drains, the service worker — this document extends it and does not replace it), `docs/DEPLOY.md` (the two topologies, and the `PERSIST_VERSION` rollback rule), `docs/SPONSORS.md` §2.2 (the review pipeline this borrows from and the two-thirds of it that does not transfer) and `docs/INFRASTRUCTURE.md` §5.3 (the audit-log requirement).

---

## 0. Ground truth before anything else

Everything in §0 was re-read against the working tree at `cfda9e4` plus the economy workflow's 19 dirty files. Anchors are working-tree line numbers.

### 0.1 What already exists

| Thing | Where | State |
|---|---|---|
| Content pinned per room, `readonly`, never re-read | `server/src/room.ts:277-278`, set at `:355-356` | **built, tested** (`server/src/patch.test.ts:229-243`) |
| `contentHashFor(levelHashes)` folding every installed level's own hash | `shared/src/version.ts:356`, fed at `server/src/index.ts:497-503` | built, and **plumbed into `/api/version` in Phase 0** — `versionDocument(contentHash, extra)` (§0.2.1) |
| The room factory — the one place a room comes into existence | `server/src/index.ts:534-588`, inside `lifecycle.guardCreate` | built. **This is the hook everything below uses** |
| `LevelLibrary`: directory scan, compile, validate, refuse, serve | `server/src/levels.ts:114-455` | built, tested, **mounted in the dispatcher in Phase 0** (§0.2.3) |
| `validateLevel` — a real lock-and-key reachability solve | `shared/src/level.ts:1777` | built. The strongest gate already in the tree |
| `formatValidation(id, r)` — a reason string an author can read | `shared/src/level.ts:1923` | built |
| `FlagService`, rollout buckets, freeze | `server/src/deploy.ts:310-378`, `shared/src/flags.ts` | built. In-memory only; **merge + `expectRevision` CAS added in Phase 0** (§0.2.4), still not durable |
| `flags.registry()` — *"for an admin panel that has to render the switches"* | `server/src/deploy.ts:356-378` | built. Its only caller is the POST response |
| `HostLifecycle` — deploy drain, forward-only | `server/src/deploy.ts:137-295` | built, tested |
| Three token-gated admin endpoints | `server/src/index.ts:901, 908, 924` | built. **Nothing in `client/` calls any of them** |
| `ModeContextMessage.contentHash` — the room's stamped level bytes, on the wire | `shared/src/modes.ts:1038`, set at `server/src/room.ts:897` | built, was **thrown away as a boolean**; compared properly in Phase 0 (§3 "Why no per-pack manifest" — the §0.2.5 this row used to point at is the admin-auth item, not this one) |
| `content/levels/*.json` ×6, `content/episodes.json` | `content/` | data files. `episodes.json` is read by the client only |
| An admin panel | — | **does not exist** |
| Any CI | — | **does not exist.** No `.github/`, `Dockerfile` runs no tests |

### 0.2 Five prerequisites that are bugs, not features

These block the work and each is cheap. They are Phase 0 in §11. None of them needs a pack abstraction.

> **STATUS: all five are closed.** Items 2 and 5 in the security commit that followed this document;
> items 1, 3 and 4 in the Phase 0 commit, together with the client-side comparison in §11's item 5.
> The five paragraphs below are left exactly as written, as the record of what was found — the line
> anchors in them are from `cfda9e4` and have moved. Re-locate by content, never by number.

1. **`/api/version` cannot tell two hosts apart.** `versionDocument()` at `server/src/deploy.ts:412` calls a bare `contentHashFor()` — **no level hashes**. `docs/PATCHING.md:76-78` says the fold exists precisely so *"two hosts on the same `CONTENT_VERSION` with different files on disk … produce different hashes and are visible in `/api/version`"*. They are not. The correct value is computed once at `server/src/index.ts:497-503` and rides `SESSION_CONFIG`; it never reaches the document. `server/src/deploy.test.ts:96` asserts only `doc.content.version`, so nothing fails. **The fleet-agreement number this whole design leans on is currently a constant.**

2. **`/api/status` leaks every private join code.** `server/src/index.ts:930-945` is unauthenticated, defaults to `access-control-allow-origin: *`, and returns `router.status()` (`server/src/modes.ts:608-618`) including each slot's `key`. A private room's key is `${roomKey}${PRIVATE_KEY_MARK}${code}` (`server/src/directory.ts:257`, `PRIVATE_KEY_MARK = '~'` at `:47`). `/api/rooms` filters these (`directory.ts:202`); `/api/status` does not. Fix this before pointing anybody at an operator surface.

3. **`GET /api/levels` does not exist.** `LevelLibrary.handle()` (`server/src/levels.ts:377`) is a complete, tested HTTP surface. `grep '\.handle(' server/src/index.ts` returns nothing; the route table is 16 `path === '…'` branches at `server/src/index.ts:832-1103`. Meanwhile `client/src/modes/quest/quest.ts:244` and `:308` fetch `/api/levels` and `/api/levels/<id>/data` whenever a server is configured, and get the SPA `index.html` back. This is the sixth "written, tested, imported by nothing" in this repo.

4. **The documented freeze command destroys the flag document.** `docs/PATCHING.md:318-319` prescribes `-d '{"revision":9,"frozen":true}'`. `POST /api/admin/flags` is a **full replace**: `parseFlagConfig` (`shared/src/flags.ts:223-240`) starts from `createFlagConfig()` and defaults `rules` to `{}`, and `FlagService.load` (`server/src/deploy.ts:315-321`) assigns wholesale. That body deletes every `force` and every `rolloutBp` on the host. `server/src/deploy.test.ts:217-249` "covers" freeze but re-sends the full rules block, so **the shape the doc prescribes is never exercised**. Fix: merge semantics plus an `expectRevision` compare-and-swap. `revision` is currently clamped and never compared (`flags.ts:197` says so outright).

5. **`adminAuthorised` is weaker than it reads.** `server/src/index.ts:627-637`: the XOR loop is constant-time only for equal-length inputs and `:633` returns early on length, so **token length is an oracle**; `'Bearer '` is stripped case-sensitively (RFC 7235 says the scheme is case-insensitive); there is **no rate limit and no log of a failed attempt anywhere**. `randomBytes` is already imported at `server/src/index.ts:34`, so `timingSafeEqual` is one import away. Also: the docstring's claim at `:624-625` that an unset token means *"an unconfigured deployment does not advertise an admin surface at all"* is false — the dispatcher answers unhandled POSTs with `405 text/plain` and unhandled GETs with the SPA `index.html`, so the three admin paths are trivially enumerable either way. The 404 buys nothing against an attacker and costs an operator the ability to tell a wrong token from an unset env var.

### 0.3 The delivery constraint, stated honestly — this decides the whole design

> **Content reaches a browser only from the origin that served the document.**

Not a preference. Three independent mechanisms, each sufficient:

- `vercel.json` ships `connect-src 'self' ws: wss:`. `ws:`/`wss:` are **scheme**-sources, so the game socket reaches any host — that is how online play works — but a cross-origin `fetch()` is blocked.
- The Node origin is stricter: `server/src/index.ts:320` emits a bare `connect-src 'self'`, with the comment that `'self'` also covers `ws://` and `wss://` **back to this exact origin**.
- Cross-origin would additionally need CORS: `server/src/index.ts:812` answers preflight with `access-control-allow-headers: content-type`, so no `Authorization` header survives, and `corsOrigin` returns `'*'` when `DOOMCRAFT_ORIGINS` is unset, which cannot be combined with credentials.

`client/src/modes/quest/quest.ts:162` resolves its API base through `resolveServerUrl()` (`client/src/net/serverConfig.ts:115`). That returns:

| Topology | Base | Level fetch |
|---|---|---|
| Vercel static, no server | `''` | **skipped** — falls to the bundled glob at `quest.ts:132` |
| Vercel static + `VITE_DOOMCRAFT_SERVER=https://rooms.x` | absolute, cross-origin | **CSP-blocked, today, mounted or not** |
| **Node origin serves the document** (`<meta name="doomcraft-server" content="self">`, `serverConfig.ts:18-23`) | the document origin | **same-origin, allowed, cache headers ours to set** |

`docs/DEPLOY.md` already names the third row as a supported topology — *"serve both from the Node origin and configure nothing"* — and already says the game must move there the moment third-party content ships.

Three consequences, and they are the spine of §11:

1. **A data pack push that reaches a player requires the Node origin to serve the document.** On `doomcraft.vercel.app` a content change is a bundle redeploy, today and after this work. Saying otherwise would be shipping a console that pushes into a void, which is this project's signature failure and would be its seventh instance.
2. **Nothing here is useless before that host exists.** The gate, the fingerprints, the pack identity and the diff all run offline and all refuse offline. That is Phase 1, and it is the phase with the best cost-to-value ratio in the document.
3. **`client/src/net/localServer.ts:303` — the authoritative room for the live product — constructs a `Room` with no `contentVersion` and no `contentHash`**, relying on the defaults at `server/src/room.ts:355-356`. Those defaults are load-bearing. Deleting `CONTENT_VERSION` breaks the shipped game. See D2.

### 0.4 Five rules the rest of this document derives from

**Rule A — a pack is data, never code.** Both deployments ship `script-src 'self'` with no `'unsafe-eval'`. A pack cannot carry JS without a CSP hole, and a pack DSL is a new interpreter with a new attack surface and no test corpus. Anything that needs logic is a build change wearing a pack's version number, and the console must say so.

**Rule B — the author is the operator, and always will be under this design.** Every trust decision below assumes it. Opening pack authorship to strangers reactivates all of `docs/SPONSORS.md` §2.2 stage 1 — NSFW/violence classifiers, OCR, perceptual hashing, decompression-bomb sandboxing, polyglot defence, `clickUrl` screening — and is a different project. §10.

**Rule C — a gate that cannot refuse is worse than no gate**, because it manufactures confidence. Anything whose only enforcement is "the reviewer looks carefully" is the same attention that wrote the change, applied twice, at the moment the author most wants to ship. Every check in §4 names the input that makes it fail.

**Rule D — the room is the unit of content, and it always was.** `server/src/room.ts:277-278` is `readonly` and `server/src/patch.test.ts:229-243` pins it. Every mechanism below extends that pin; none replaces it. **Nothing in this document may ever be resolved per player.**

**Rule E — refusing a release is always safer than refusing a player.** A host that cannot satisfy a release keeps serving the previous one and says so. It does not `exit(1)`, and it does not close a socket. §8.6.

---

## 1. The axes — what a pack is, and what each of the seven things the request names becomes

The request names seven things. They are not seven of the same thing, and a design that pretends otherwise ships a button that lies.

| # | Requested | Becomes | Class | Verdict |
|---|---|---|---|---|
| 1 | **full patch** | a **release** — one document naming one exact version of every pack | — | **SHIP** |
| 2 | **levels** | `PackKind.LEVELS` — `content/levels/*.{json,dcl}` | **data** | **SHIP** |
| 3 | **expansion packs** | `PackKind.CAMPAIGN` (`content/episodes.json`) + the levels pack it names, published as **one release**. The release *is* the expansion unit | **data** | **SHIP** |
| 4 | **weapons** | `PackKind.WEAPONS` — `shared/src/weapons.ts` | **build** | **SHIP** (identity, version, fingerprint, diff, rollback target — delivery stays a deploy) |
| 5 | **characters** | `PackKind.CHARACTERS` — the `CharacterLook` table + `cast.glb`/`cast.png` | **build** | **LATER** (§11 phase 6) |
| 6 | **quests** | `PackKind.QUESTS` — the daily/weekly challenge board: `shared/src/challenges.ts` + `content/quests.json` | **data** | **SHIP** — was **LATER** with nothing to extract until Studio S4 built the engine; §1.3 |
| 7 | **maps** | folded into `PackKind.CORE` via `TERRAIN_VERSION` | **build** | **REJECTED as a pack** — see §1.4 |
| + | *(implied by the economy)* | `PackKind.ITEMS`, **reserved number, no producer** | — | **LATER**, with the ownership rule written down now (§7) |

### 1.1 The class split — the one distinction that stops the console lying

**`data`** = files the server loads at runtime. The server can change it without a new client; rollback is a document flip.
**`build`** = compiled into the bundle. A "push" is a deploy. The pack contributes **identity, version, fingerprint, field-level diff and a rollback target** — not independent delivery.

The console renders `cls` on every row, and a `build` pack's Rollback button is replaced by the literal string `rollback requires redeploying build <id>`. That is the honest yes-with-an-asterisk to *"not all upgrades hit the entire game"*: a levels release does not move `weaponsFingerprint()`, does not bump anything weapons-shaped, does not force a service-worker swap, and does not touch a live match. It hits `levels`, and the review artifact says so in one line.

Why `weapons` is not `data`, with the numbers: `WEAPON_COUNT = 7` (`shared/src/weapons.ts:31`) sizes 11 typed arrays at module load; `ALL_WEAPON_MASK = (1 << WEAPON_COUNT) - 1` (`:467`) rides in the ownership bitmask; `WEAPONS` is imported by `server/src/room.ts:32`, `deathmatch.ts`, `horde.ts`, `persistence.ts` and `client/src/modes/deathmatch/deathmatch.ts`; and the client **predicts** damage and spread from its own compiled copy. Making that per-session means all of it becomes dynamic and the predictor becomes data-driven. That is a real project and it is not this one.

### 1.2 Why the expansion pack is a release and not a pack kind

The obvious shape of "expansion pack" is *a level plus a cosmetic item plus maybe a weapon*. Any scheme that makes an expansion a single pack with a single delivery axis has to either forbid that shape or lie about when it lands: a level lands on the next **room**, an item lands on the next **profile write**, a weapon lands on the next **page load**. Those are three different clocks.

So the expansion pack is a **release**: an immutable document naming one version of each pack, with one note, one gate report, one audit line, and one rollback target. The console shows one row per pack inside it with its own class and its own arrival clock. Nothing is forbidden and nothing is misrepresented.

### 1.3 Quests — reserved, and deliberately empty

There is no quest system. `ModeId.QUEST = 0` is the *campaign mode*. Per-level objectives — `exit`, `doors` with `KeyColor`, `switches`, `secrets`, `EX_ENDS_EPISODE` — are fields **inside the level file**, decoded by `client/src/modes/quest/levelRuntime.ts`. They already ship inside `PackKind.LEVELS` and already move its fingerprint.

The nearest hook is `challengeIds` (`server/src/entitlementGuard.ts:267`, clamped at `:511`), which has a transport slot and **zero producers** — its only other occurrence in the tree is the test literal `'daily.kill-40'`. `PackKind.QUESTS = 5` is reserved as a number in the enum with no `PackDef`, no gate check and no test. A green check on a pack kind with no content is exactly the green test that cannot fail.

### 1.4 Maps — REJECTED as a pack, with the number that killed it

"Map" is three things:

| | What | Versioned by | Verdict |
|---|---|---|---|
| Quest map | `content/levels/*.json` | the levels pack | it **is** `PackKind.LEVELS` |
| DM/Horde/Builder arena | **procedural** — `shared/src/terrain.ts`, 2,003 lines, deterministic in `seed` | `TERRAIN_VERSION = 5` (`terrain.ts:80`) + a hard `throw` at `server/src/world.ts:72-76` | **REJECTED** |
| Builder persistent world | `<id>.dcw`, seed + block-delta log | `WORLD_FORMAT_VERSION = 1` | user data, not content |

The arena is not data. The browser Worker and the Node server produce the same world *only because they execute the identical module*. Shipping it as a pack means either code-in-a-pack (Rule A) or baked voxels at ~11 MB per 169-chunk arena. Note also that `.dcw` steals **bit 7** of the block byte (`server/src/worlds.ts:611`), so a block palette past 127 corrupts every saved Builder world — the file says so itself.

**The whole intervention is one line:** `TERRAIN_VERSION` joins `core`'s fingerprint inputs, so a generator change becomes *visible* in the diff. Today it is in no fingerprint at all.

---

## 2. The data model

New file, `shared/src/packs.ts`. Real TypeScript, not a sketch.

```ts
/**
 * DOOMCRAFT — content packs.
 *
 * A pack is DATA, never code (docs/PACKS.md Rule A: both deployments ship
 * `script-src 'self'`, so a pack that carried logic would need a CSP hole).
 *
 * This file replaces nothing. `CONTENT_VERSION` (shared/src/version.ts:81)
 * STAYS, because three things read it before any release document exists:
 * the client's HELLO (client/src/net/client.ts:1251), a refusal sent before a
 * room is chosen (server/src/net.ts:587), and the Room defaults that
 * client/src/net/localServer.ts:303 relies on. See D2.
 */

/**
 * APPEND ONLY. A retired kind's number is burned — the same rule as a
 * FLAG_ORDER bit (shared/src/flags.ts:70-77) and for the same reason: the
 * number is the canonical fold order for packSetHash(), so reusing one
 * silently re-means every hash any host has ever reported.
 */
export enum PackKind {
  CORE = 0,
  WEAPONS = 1,
  LEVELS = 2,
  CAMPAIGN = 3,
  CHARACTERS = 4,
  /** RESERVED. No producer, no PackDef, no gate check. Do not add one to make a test pass. */
  QUESTS = 5,
  /** RESERVED. See §7 — the ownership rule is written down before the producer exists. */
  ITEMS = 6,
}

/** 'build' = compiled into the bundle. 'data' = files the server loads at runtime. */
export type PackClass = 'build' | 'data';

export interface PackDef {
  readonly kind: PackKind;
  /** Stable lowercase slug. Appears in every URL, hash input and audit line. */
  readonly key: string;
  readonly cls: PackClass;
  /** One line, rendered verbatim by the console. Same discipline as FlagDef.blastRadius. */
  readonly blastRadius: string;
}

export const PACKS: Readonly<Partial<Record<PackKind, PackDef>>> = Object.freeze({
  [PackKind.CORE]: {
    kind: PackKind.CORE, key: 'core', cls: 'build',
    blastRadius: 'Every match in the fleet. Tick rate, match length, score limit, gravity, move '
      + 'speed and the terrain generator — the client predicts all of them, so a change here is a '
      + 'client change too and it lands on the next page load, not the next room.',
  },
  [PackKind.WEAPONS]: {
    kind: PackKind.WEAPONS, key: 'weapons', cls: 'build',
    blastRadius: 'Time-to-kill in every NEW room. Rooms already running keep the table they were '
      + 'built with, so no in-flight match changes underneath a player.',
  },
  [PackKind.LEVELS]: {
    kind: PackKind.LEVELS, key: 'levels', cls: 'data',
    blastRadius: 'Quest only. A refused level is not offered at all; Deathmatch, Horde and '
      + 'Builder never read this pack.',
  },
  [PackKind.CAMPAIGN]: {
    kind: PackKind.CAMPAIGN, key: 'campaign', cls: 'data',
    blastRadius: 'The ORDER levels are played in and which episode they belong to. Cannot make a '
      + 'level unplayable, only unreachable from the campaign.',
  },
  [PackKind.CHARACTERS]: {
    kind: PackKind.CHARACTERS, key: 'characters', cls: 'build',
    blastRadius: 'How enemies look. Cosmetic and client-side: the server sends an EntityType byte '
      + 'and never reads this pack.',
  },
});

/** One pack at one version. This is what a release names. */
export interface PackVersion {
  readonly kind: PackKind;
  readonly key: string;
  /** Independent per kind. `weapons@4` and `levels@7` are unrelated numbers. u16. */
  readonly version: number;
  /** FNV-1a over `inputs`. The per-pack ratchet. */
  readonly fingerprint: number;
  /**
   * The EXACT strings the fingerprint was computed from, in canonical order.
   *
   * This is what makes a release REVIEWABLE instead of a hash the author is
   * told to paste in. The console diffs these line for line and renders
   * `- shotgun:8/9/2/90/…` / `+ shotgun:9/9/2/84/…` with no bespoke differ,
   * and the gate recomputes them from the running process.
   *
   * docs/PATCHING.md §2.2 currently instructs the human to silence the alarm.
   * This makes the alarm's CONTENTS the thing they read.
   */
  readonly inputs: readonly string[];
  /** sha256 hex of the canonical encoded bytes. Data packs only; '' for build packs. */
  readonly digest: string;
  /** 'levels@7'. The console never renders a bare number. */
  readonly label: string;
}

export const MAX_PACK_INPUTS = 512;
export const MAX_PACK_INPUT_BYTES = 160;
/** SessionConfigMessage.contentVersion is a u16 (shared/src/protocol.ts:852). */
export const MAX_ORDINAL = 0xffff;

/**
 * The room's content identity, replacing contentHashFor()'s job at the two
 * places a room is built. Stays u32/FNV because that is the width of the wire
 * field; `digest` is the review-grade identity and lives in the release
 * document and in /api/version, never on the wire.
 *
 * ORDER: the fold is sensitive to `kind`, and the function sorts by `kind`
 * internally, so the INPUT ARRAY's order does not matter and the RESULT
 * changes if any pack's kind, version or fingerprint changes. Both halves are
 * asserted in §11 phase 1's test.
 */
export function packSetHash(packs: readonly PackVersion[], ordinal: number): number {
  let h = Math.imul(ordinal >>> 0, 0x9e3779b1) >>> 0;
  for (const p of [...packs].sort((a, b) => a.kind - b.kind)) {
    h = Math.imul(h ^ (p.kind >>> 0), 0x01000193) >>> 0;
    h = Math.imul(h ^ (p.version >>> 0), 0x01000193) >>> 0;
    h = Math.imul(h ^ (p.fingerprint >>> 0), 0x01000193) >>> 0;
  }
  return h >>> 0;
}
```

### The release document

```ts
export type ReleaseState =
  | 'draft'        // assembled from what is installed; nothing has been checked
  | 'review'       // the gate has run; `gate` holds the verdict and the diff
  | 'staged'       // approved; being served to some fraction of NEW ROOMS
  | 'live'         // the terminal operator decision. Every new room, and freeze-proof
  | 'rolled_back'  // was live, is not any more; kept in `history` forever
  | 'superseded';

export interface GateCheck {
  /** Stable id: 'packs.declared', 'levels.validate'. The console groups on it. */
  readonly id: string;
  readonly ok: boolean;
  /** Why, in one line. Rendered verbatim. Empty when ok. */
  readonly detail: string;
}

export interface PackDiff {
  readonly key: string;
  readonly from: string;              // 'weapons@3', or '' when the pack is new
  readonly to: string;                // 'weapons@4'
  /** Line diff of PackVersion.inputs, prefixed '+ ' / '- ', capped. */
  readonly changes: readonly string[];
}

export interface GateReport {
  readonly ok: boolean;
  readonly ranMs: number;
  /** Failures first. An EMPTY list is a FAILURE, never a pass (§4, check `gate.nonempty`). */
  readonly checks: readonly GateCheck[];
  readonly diff: readonly PackDiff[];
  /** True when PERSIST_VERSION or SAVES_VERSION moved. Disables rollback forever. */
  readonly schemaTouching: boolean;
}

export interface Release {
  /** Server-assigned, strictly increasing. The CAS token for every mutation. */
  readonly revision: number;
  readonly state: ReleaseState;
  /** The wire's u16 `contentVersion`. Strictly increasing across live releases. */
  readonly ordinal: number;
  readonly packs: readonly PackVersion[];
  /** Fraction of NEW ROOMS built from this release, 0..10000. */
  readonly rolloutBp: number;
  /** The revision a room falls back to when this one is not selected. */
  readonly baseRevision: number;
  readonly gate: GateReport | null;
  readonly createdMs: number;
  readonly publishedMs: number;
  /** The operator's one line. <= 200 chars. REQUIRED to leave 'review'. */
  readonly note: string;
}

export interface ReleaseDoc {
  /**
   * Newest last, capped at MAX_RELEASE_HISTORY. The cap NEVER evicts
   * `liveRevision`, `pendingRevision`, or any `baseRevision` reachable from
   * either — see D6. An unreachable-live document is the one input that could
   * take room creation down fleet-wide.
   */
  readonly history: readonly Release[];
  readonly liveRevision: number;
  /** The revision being staged, or 0. At most ONE at a time, deliberately. */
  readonly pendingRevision: number;
  /** Same word as FlagConfig.frozen, DIFFERENT terminal state — see D5. */
  readonly frozen: boolean;
  /** Bumped on every accepted mutation. The CAS token. */
  readonly revision: number;
}

export const MAX_RELEASE_HISTORY = 32;
```

### Resolution — the only function a room calls

```ts
/**
 * Which release THIS room is built from. Called exactly ONCE per room, inside
 * the factory (server/src/index.ts:534), and the answer is pinned into the
 * readonly fields at server/src/room.ts:355-356.
 *
 * `fallback` is BUILTIN_RELEASE — the release this binary itself declares. It
 * is a parameter and not an import so that this function is TOTAL: it can
 * never return null and can never throw. A throw here propagates out of
 * `lifecycle.guardCreate` (server/src/deploy.ts:216-221) through
 * `ModeRouter.route` and becomes a 503 on EVERY upgrade — one bad document
 * would stop room creation fleet-wide, on a host whose console is served by
 * the same process.
 */
export function resolveRelease(
  doc: ReleaseDoc, roomInstanceId: string, fallback: Release,
): Release {
  const live = releaseAt(doc, doc.liveRevision) ?? fallback;
  if (doc.pendingRevision === 0) return live;
  const pending = releaseAt(doc, doc.pendingRevision);
  if (pending === null || pending.state !== 'staged') return live;
  /*
   * FREEZE BEATS EVERY STAGED RELEASE, INCLUDING ONE AT 10000.
   *
   * This is a DELIBERATE divergence from resolveFlag (shared/src/flags.ts:291-303),
   * where `bp >= 10000` short-circuits before the freeze check. There, 10000 IS
   * the terminal operator decision. Here it is not: `staged` at 10000 is still
   * a release awaiting `promote`, and a human may be asleep between the two.
   * Copying the flag ordering would give a panic button that cannot stop the
   * release that most needs stopping. The terminal state here is `live`, and a
   * live release is what the freeze falls back TO.
   */
  if (doc.frozen) return live;
  if (pending.rolloutBp <= 0) return live;
  if (pending.rolloutBp >= 10000) return pending;
  return packBucket(roomInstanceId) < pending.rolloutBp ? pending : live;
}

/**
 * A room's stable bucket, 0..9999.
 *
 * NOT flagBucket (shared/src/flags.ts:274) and NOT hostBucket (:286). Both are
 * keyed on a PLAYER. A player-keyed pack rollout puts two players in one room
 * on two different weapon tables — exactly the desync the per-room pin exists
 * to prevent, and `ModeRouter.route` (server/src/modes.ts:551-564) routes both
 * players into the same slot by design.
 *
 * `roomInstanceId` MUST be minted in the factory. It must NOT be derived from:
 *
 *   - the room KEY — `roomKeyFor` yields roughly four bases plus `#n` suffixes
 *     under MAX_ROOMS = 32, so a 1% rollout over ~36 fixed strings selects the
 *     same zero rooms forever, deterministically, across every restart;
 *   - `options.seed` — it is CLIENT-SUPPLIED. `msg.seed` (server/src/modes.ts:160)
 *     -> `req.seed` -> `plan.seed` (:359) -> `roomOptionsFor` (:389). A player
 *     could grind seeds until they landed in the canary. And for a normal
 *     client `plan.seed === 0`, so `options.seed` is `undefined` at the factory
 *     and the randomisation at server/src/room.ts:333 happens AFTERWARDS —
 *     the value would be constant anyway.
 */
export function packBucket(roomInstanceId: string): number {
  return fingerprint(`pack ${roomInstanceId}`) % 10000;
}
```

The factory mints it, one line, next to the `isInvite` computation at `server/src/index.ts:551`:

```ts
const roomInstanceId = randomBytes(8).toString('hex');   // randomBytes: index.ts:34
const release = releases.resolveFor(roomInstanceId);
const room = new Room({
  ...options,
  contentVersion: release.ordinal,
  contentHash: packSetHash(release.packs, release.ordinal),
  packs: release.packs,
  levels: inventory.viewFor(release),   // version-bound, see D7
  /* … everything else unchanged … */
});
```

---

## 3. The wire — no change, and the deferred change priced exactly

`S2C.SESSION_CONFIG` (`shared/src/protocol.ts:820/844/858`) stays **byte-identical**. The golden vector at `shared/src/version.test.ts:241` — `0b03020100efbeadde0102000006616263313233` — stays green, and Phase 1's test asserts it as an explicit *no-wire-change* assertion rather than leaving it as ambient coverage.

What the two existing fields now mean:

| Field | Today | After |
|---|---|---|
| `contentVersion` u16 | `CONTENT_VERSION = 1` | the **release ordinal** — a counter, with no meaning beyond ordering |
| `contentHash` u32 | `contentFingerprint() ^ CONTENT_VERSION`, level-folded at `index.ts:497` | `packSetHash(release.packs, release.ordinal)` |

Reinterpreting them is free because **neither is read for a decision anywhere**. `conn.clientContentVersion` (`server/src/net.ts:616`) is written and never read again in the tree. `NetClient.contentVersion` (`client/src/net/client.ts:908`) is adopted at `:1529` and has no consumer. That is a defect elsewhere; here it is what makes the reinterpretation safe.

### Why no per-pack manifest on the wire

The only reason a client needs the pack *list* is to fetch a pack it does not have. Exactly one pack kind is fetchable (`levels`), and the client already fetches it **per level, by id**, and the room already puts the bytes' hash on `S2C_MODE.CONTEXT` (`shared/src/modes.ts:1038`, set from `stampedLevelHash` at `server/src/room.ts:897`). That field is already the client↔room content-agreement channel. It is currently thrown away:

```ts
// client/src/modes/quest/quest.ts:1144 — today
if (!this.placed) this.roomOwnsLevel = context.contentHash !== 0;
```

A `u32` hash tested against zero. A host running an edited `e1m1-hangar.json` and a client on the bundled copy both believe they agree; `levelRuntime.ts` then re-asserts the client's own chunk arrays one per frame and the two worlds silently diverge. **One comparison closes it, on an existing field, with no wire change**, and it is the cheapest integrity gate in the tree. Phase 0.

### If it later has to change, here is the bill

Append after `buildId`: `u8 packCount`, then `packCount × (u8 kind, u16 version)` = **1 + 3n bytes**, 15 bytes for five packs, once per join on an already-open socket.

- `PROTOCOL_VERSION` does **not** move. `protocolFingerprint()` (`shared/src/version.ts:307-322`) lists frozen ids **by name** and does not fold `SESSION_CONFIG`'s layout. `S2C.MATCH_AWARD = 12` just proved this in the working tree. Ids **13, 14, 15** are free; `isModeMessage` hard-codes 16–18 (`shared/src/modes.ts:595`).
- **The trap is the decoder.** `decodeSessionConfig` (`shared/src/protocol.ts:858-867`) reads **every field unconditionally** — no `r.remaining >=` guard anywhere, unlike `decodeHello` (`:574`). That is safe only because the message shipped whole at protocol 3. A new client reading an old host's 20-byte message would run off the end.
- **And the existing golden vector cannot catch a missing guard**, because an additive change leaves it passing *by design*. So the change costs: the guard, a **second** golden vector for the extended message, a truncated-buffer decode test, and keeping the old vector as the assertion that the change was additive. Neither vector alone is a test.

Deferred, deliberately. Nothing in phases 0–6 needs it.

### The fourth axis nobody ratchets

`MODE_PROTOCOL_VERSION = 1` (`shared/src/modes.ts:592`) is written at `:669` and **discarded on read** at `:682` (`r.u8(); // reserved`). It is in no fingerprint. So `S2C_MODE.CONTEXT` — the message that carries level identity and the `contentHash` this design starts comparing — is covered by **no ratchet at all**. Phase 4 adds `modeFingerprint()` alongside `protocolFingerprint()`. Named here so it is not forgotten.

---

## 4. The gate — what "reviewed" has to mean when reviewer and author are the same person

The operator is one person. Anything whose only enforcement is careful reading is theatre (Rule C). So the gate is made of things that can say **no** without the author's cooperation, and the human's remaining job is to read the diff the machine produced and choose the rollout stage — the one judgement a machine cannot make and the author cannot fake.

`runGate(inventory, draft, base) => GateReport` runs **in the process that would serve the release, against the bytes on that host's disk and the fingerprints compiled into that host's binary.**

| id | Refuses when | Input that makes it fail | Anchor |
|---|---|---|---|
| `gate.nonempty` | `checks.length === 0` | delete every other check | — |
| `packs.declared` | a `build` pack's declared fingerprint ≠ the one **this binary** computes now | edit one bit of a declared fingerprint; deploy a release authored against a different build | `shared/src/version.ts:331`, split |
| `packs.installed` | a `data` pack version named by the release is absent, or its recomputed sha256 differs from the declared one | edit a level file under an already-published version | `server/src/levels.ts:217-249` |
| `packs.unique` | two packs in the release provide the same content id | add `e1m1-hangar` to a second levels pack | `CONTENT_ID_PATTERN`, `shared/src/modes.ts:648` |
| `levels.validate` | any level has `validation.ok === false`, **or emits `W_REACH_SKIPPED`** | ship a level with an unreachable exit, or one too large for the solve | `shared/src/level.ts:1777`, `:1899` |
| `levels.canonical` | re-encoding the parsed level is not byte-identical to the stored bytes | hand-edit a `.dcl` | `server/src/levels.ts:217-247` |
| `campaign.refs` | `episodes.json` names a level id not in the declared levels pack, or two campaigns declare the same episode id | rename a level and forget the manifest | the gap: **0 refs to `episodes.json` in `server/src`** |
| `protocol.stable` | `protocolFingerprint()` ≠ the value the base release recorded | move a quantisation scale in a "content" release | `shared/src/version.ts:307` |
| `flags.order` | the `FLAG_ORDER` prefix differs from the base release's | **insert** a flag rather than append one | `shared/src/flags.ts:79-90` |
| `ordinal.monotonic` | `ordinal <= live.ordinal` or `> 65535` | reuse an ordinal; overflow the `u16` | `shared/src/protocol.ts:852` |
| `saves.schema` | `PERSIST_VERSION` or `SAVES_VERSION` moved → sets `schemaTouching: true` | any profile-shape change | `server/src/persistence.ts:39` |

**`levels.validate` is deliberately stricter than the loader.** `W_REACH_SKIPPED` (`shared/src/level.ts:1899`) is a *warning*: a level too large for the reachability solve loads and serves with its exit unverified. For a **publish**, "the solve did not run" is a refusal, not a note. The loader is unchanged — the level still loads in the editor path — and that asymmetry is what makes this a check that can fail rather than a restatement of one that already passed.

**`packs.declared` is the keystone, and its limit is stated honestly.** For `data` packs it is a genuine pre-publish refusal: push a release declaring `levels@7 / sha256 abc…` to a host whose disk holds different bytes and the host **refuses the release** and keeps serving the previous one. For `build` packs it can only refuse *a release authored against a different binary than the one deployed* — by the time a weapons fingerprint can be checked on a host, the weapons change is already in that host's binary. That is not nothing (it is the mixed-fleet detector `/api/version` was supposed to be and is not, §0.2.1) but it is **not** a balance review. §8.5.

**The reviewable artifact is the diff, not the hash.** Because `PackVersion.inputs` stores the fingerprint's own input strings, `PackDiff.changes` is a line diff with no bespoke differ. That is the entire delta from today, where `docs/PATCHING.md:111-113` tells the human to paste the new number in.

**What the gate deliberately does not contain**, so it is not re-proposed: NSFW/violence classifiers, OCR text filtering, perceptual hashing against a reject blocklist, decompression-bomb sandboxing, polyglot defence, `clickUrl` screening, KYC. Those defend against a stranger who paid you (`docs/SPONSORS.md` §2.2). Nobody uploads here but the author (Rule B). What *does* transfer from §2.2, unmodified: **content addressing as identity**, **immutability — a re-cut pack is a new version, never an in-place edit**, and **canonical re-encode**, which `parseLevelJson → compileLevel → encodeLevel` already gives for free (`server/src/levels.ts:217-247`): the bytes we serve are already bytes *we* produced.

---

## 5. The release state machine

```
        POST /api/admin/release              (assemble a draft from the inventory)
   ┌───────────────────────────────────────────► draft
   │                                               │ POST …/gate
   │                                               ▼
   │                                            review ──── gate.ok === false ──┐
   │                                               │                            │
   │             POST …/approve  (needs gate.ok && note.length > 0)              │
   │                                               ▼                            │
   │                                            staged ◄── POST …/stage {bp} ────┘
   │                                          bp 0 → 10000 (ladder: LATER, §5.2)
   │                                               │ POST …/promote  (bp must be 10000)
   │                                               ▼
   │    previous live ─────────► superseded      live
   │                                               │ POST …/rollback {ifRevision}
   └───────────────────────────────────────────────┘
                                             rolled_back
```

Rules the **server** enforces, not the panel:

- **One `pendingRevision` at a time.** Two concurrent stagings give three possible pack sets across live rooms with no way to name what a bug report was running.
- `approve` is refused unless `gate.ok === true` **and** `note.length > 0`. A release with no sentence saying why is not a release.
- **Every mutation carries `ifRevision`.** Mismatch → `409` with the current document in the body. `FlagService` has no equivalent and two tabs racing is silently last-writer-wins today.
- **`rollback` is refused** when `gate.schemaTouching` (see `docs/DEPLOY.md`: a v4→v3 host has no `_unknown` bag and every Scrap balance it rewrites is gone for good), or when any `build` pack in the target does not match this binary, or when a `data` pack version in the target is no longer installed. The panel then renders the exact redeploy instruction instead of a button.
- **A drain is never part of a release.** `HostLifecycle.beginDrain()` (`server/src/deploy.ts:196-208`) early-returns unless `state === ADMITTING` and **no method anywhere sets it back**. One call permanently removes the host from rotation; the only recovery is the restart the drain exists to schedule. Drain stays on its own screen behind type-to-confirm, and the panel never drains a rollback target.
- Every accepted transition appends **one** audit line to `$DOOMCRAFT_DATA/release.jsonl`: `ms, revision, ordinal, state from→to, pack diff summary, gate verdict, rolloutBp, note`. With one operator the "who" is always the same, so the value is entirely the *when* and the *before → after* — it is what makes "what changed between Tuesday and the bug report" answerable at 3 a.m. `docs/INFRASTRUCTURE.md` §5.3 requires it and nothing exists.

### 5.1 Durability and CAS — the three things `FlagService` deliberately lacks

`FlagService` is *"deliberately dumb: no fetching, no polling, no timers"* (`server/src/deploy.ts:305-309`) and it is right to be, for what it does. A release document is not that. `ReleaseService` gets:

1. **Durability** — `JsonFileStore`'s atomic temp-then-rename under `dataRoot` (`server/src/index.ts:90`). A push that does not survive a restart is not a release.
2. **Compare-and-swap** on `revision`, with 409.
3. **The append-only audit line.**

`FlagService` itself is **left alone** (§10). The console's flag screen uses `registry()` as-is and always sends the **full** document, which neutralises the destructive-freeze shape in §0.2.4 from the client side while Phase 0 fixes it on the server side.

### 5.2 Rollout — SHIP the resolution, LATER the ladder

`resolveRelease` implements the full basis-point ladder because it costs nothing and because getting the bucketing right is only cheap *before* something depends on it. **The console exposes two buttons in v1: stage at 0, and stage at 10000.** The intermediate rungs are rendered disabled with the reason written on the row.

The reason is arithmetic, not caution. `ModeRouter.route` (`server/src/modes.ts:551-564`) reuses an existing room for a key until `humanCount >= maxPlayers`; `sweep()` only reaps rooms empty for `ROOM_IDLE_MS`; `PREWARM` builds the deathmatch room at boot (`server/src/index.ts:619`). With any steady population there is roughly **one long-lived room per key per host**. A release staged at 1% therefore reaches **zero rooms for hours**, and the only lever that would exercise it is a drain — which is a one-way door. Combined with there being exactly one host, a 100 → 500 → 2500 ladder is decorative, and a decorative rollout percentage is worse than none because it is believed.

The denominator on the console is therefore **rooms created since staging, new vs old** — never a player percentage. A staged release with zero rooms created reads **"not yet exercised"**, never "rolled out".

Reused from `shared/src/flags.ts` verbatim: the basis-point scale, `fingerprint()` as the bucket hash, and freeze's *"stop the experiments, leave the finished thing alone"* intent. Not reused: `flagBucket` and `hostBucket` (both player-keyed — §2's comment), `hostBucketFor` (`server/src/deploy.ts:351`, still uncalled, because staged *host* rollout needs a director and there is neither), and the freeze **ordering** (D5). The two documents stay separate: different bucketing identity, different freeze fallback, different lifetime. One document with two resolution rules is a bug factory.

---

## 6. The console

### Where it runs — and where it cannot

**Served by the Node process, same-origin, at `/admin`, gated by the same `adminAuthorised`.** Not on Vercel. §0.3's three blocks each independently prevent a Vercel-hosted console from calling a room host, and same-origin buys, free: `connect-src 'self'` coverage under both policies, the per-response nonce CSP (`server/src/index.ts:303-333` — `script-src 'self' 'nonce-…'`, `script-src-attr 'none'`, `object-src 'none'`, `frame-ancestors 'self'`, `form-action 'none'`), and no CORS. `serveStatic` already stamps the nonce onto any `.html` it serves (`stampNonce`, `server/src/index.ts:419`), so inline script and style work.

One hand-written HTML file, no framework, no build step. The token is typed into a password field per session and held **in memory only**, never `localStorage`.

**Note the coupling nobody should discover later:** `staticRoot` defaults to `dist` (`server/src/index.ts:89`), which is `vercel.json`'s `outputDirectory`. If the panel file lands in `dist/`, it also publishes to `doomcraft.vercel.app`. Harmless — every route it calls is token-gated and answers 404/401 there — but it is stated so nobody is surprised. Put it under `DOOMCRAFT_STATIC` or a route the dispatcher owns.

### Three screens in v1. That is not a compromise, it is the count that has content.

| # | Screen | Shows | The refusal it renders |
|---|---|---|---|
| 1 | **Inventory** | what is installed on **this** host, per kind, per version: `levels@6 — 6 levels, 6 playable`; `levels@7 — 6 levels, 5 playable; e1m4 REFUSED: E_MISSING_KEY`, straight from `LevelLibrary.problems` and `formatValidation` (`shared/src/level.ts:1923`) | a version with any refused member cannot enter a draft |
| 2 | **Review** | one draft: the per-pack diff (`from → to`, line-level for build packs), the gate checklist with failures first and each `detail` verbatim, `schemaTouching`, and the note field | **Approve is disabled by the SERVER**, not by CSS, while `gate.ok === false` or `note` is empty |
| 3 | **History** | the audit tail, newest first, `before → after` | each row's Rollback is enabled only under §5's rules, and otherwise **replaced by the reason it is not** |

Two more screens exist because they are nearly free, and both are honest about being thin:

- **Drain** — `lifecycle.report()` (`server/src/deploy.ts:281-294`), behind **type-to-confirm**, with the one-way-door text on the button.
- **Flags** — `flags.registry()` (`server/src/deploy.ts:356`) is already labelled *"for an admin panel that has to render the switches"*. Always POSTs the full document. And it renders, per flag, its **client consumer count**, generated by a grep in the test suite. Today that column reads: `client_update_prompt` **2** (`client/src/main.ts:2055`, `:2069`), `economy_scrap` **4** (`client/src/hud/hud.ts:637` via `economySurfacesOn`, called from `client/src/game/game.ts:1897`, `client/src/modes/quest/quest.ts:983`, `client/src/modes/deathmatch/deathmatch.ts:692`), and **0** for the other eight. Twenty lines, and it is what stops a console pushing carefully into a void.

**Fleet and Rollout are LATER.** There is one host. A fleet table with one row and a rollout denominator over rooms in a single process is a UI for infrastructure that does not exist. They are Phase 5, gated on a second host.

### Auth hardening ships with the console, not after it

`timingSafeEqual` (or `constantTimeEquals`, `server/src/persistence.ts:952`); case-insensitive `bearer`; a per-IP attempt limit; an `auth.denied` audit line on every failure; and `401` with `WWW-Authenticate` instead of the 404 pretence, so an operator can tell a wrong token from an unset env var. Half a day, and §0.2.5 says why each one.

---

## 7. Items and ownership — reserved, with the rule written down now

`PackKind.ITEMS = 6` has no producer, no `PackDef` and no gate check. But the rule it will need is recorded **now**, because it is free today and expensive in six months.

Verified, not assumed: `GrantedRewards.drops` is computed at `server/src/entitlementGuard.ts:507`, gated by `REWARD_ITEM_DROP` and clamped by `MAX_DROPS_PER_MATCH = 4` (`:90`) — and `MatchResult` has no drops field and `StoredProfile` (`server/src/persistence.ts:106-137`) has no inventory. **Item drops are granted and discarded. There is nothing to migrate.**

The rule, as a constraint on future economy work:

> **Item state is DERIVED from the live release on read. It is never stamped into a profile.**
>
> An `ItemRef` names `(packKey, packVersionMajor, localId)` — never an index, because a pack rewrite renumbers indices and a save does not. `itemStateFor(item, release)` returns `ACTIVE` when the granting pack is in the live release at that major, `DORMANT` when it is not (kept, shown greyed, not equippable, not tradable), and `REVOKED` only when an operator explicitly took it back with a logged reason.
>
> A rollback therefore recomputes ownership for every player at once and **writes nothing**. Republish the newer release and every dormant item is active again, with zero profile writes. **A rollback that writes to every profile is a rollback that cannot itself be rolled back**, and `docs/PATCHING.md:365-367` already says a rollback that destroys player data is worse than the bug it rolled back from.
>
> An item enters trade escrow only if it is `ACTIVE`, checked at **offer and again at confirm**. The confirm re-check already has to exist as the defence against the swap-at-the-last-instant scam; this is one more clause in it, and it is also what stops "roll a pack back, launder its items forward".

**And the hazard that is easy to miss, named so it cannot be:** the *forward* publish is the destructive direction. Removing one id from a pack forces a major bump, and every item a player owns from the previous major goes dormant at the next read — silently, with no profile write to notice and no counter. When `PackKind.ITEMS` gets a producer, its release must carry an `items.dormanted` count in the gate report and the Review screen must render it. Free to state now; a support incident to discover later.

---

## 8. The failure scenarios, each designed for or explicitly accepted

Every one of these came out of an adversarial pass over an earlier draft. None is quietly dropped.

**8.1 The rollout bucket is a constant in production, and client-controllable when it is not.** *Designed for.* `packBucket` takes a `roomInstanceId` minted with `randomBytes(8)` in the factory. Deriving it from `options.seed` would make it client-supplied (`server/src/modes.ts:160 → :359 → :389`) and, for a normal client where `plan.seed === 0`, constant — because `options.seed` is `undefined` at the factory and the randomisation at `server/src/room.ts:333` happens afterwards. Deriving it from the room key would give ~36 distinct strings under `MAX_ROOMS = 32`. The test in Phase 5 asserts the bucket varies for two rooms **under the same key**, and asserts the factory's own call site — not a synthetic id list, which is a test that cannot fail on the real caller.

**8.2 Freeze cannot stop a release at 100%.** *Designed for.* D5: `frozen` is checked **before** the `bp >= 10000` shortcut, so freeze covers everything in state `staged`. The terminal, freeze-proof state is `live`, which is a separate deliberate operator click. Documented as a divergence from `resolveFlag` at the divergence, in the code.

**8.3 A capped `history` can evict the live release and take room creation down fleet-wide.** *Designed for.* `resolveRelease` is total and takes `fallback: Release` as a parameter — `BUILTIN_RELEASE`, the release the binary declares. It cannot return null and cannot throw. Separately, the history cap never evicts `liveRevision`, `pendingRevision`, or any `baseRevision` reachable from either. A throw inside `lifecycle.guardCreate` (`server/src/deploy.ts:216-221`) becomes a 503 on every upgrade, on a host whose console is served by the same process.

**8.4 Deleting `CONTENT_VERSION` orphans the wire fields that carry it.** *Designed for — D2, the constant is not deleted.* Three sites have no release document to read from: `C2S.HELLO.contentVersion` is written by the **client bundle** (`client/src/net/client.ts:1251`); `S2C.UPDATE_REQUIRED.contentVersion` is sent at refusal time **before a room is chosen** (`server/src/net.ts:581`, `:587`); and `client/src/net/localServer.ts:303` builds a `Room` with neither field set. Deleting it would also break nine tests (`shared/src/version.test.ts:146, 299, 321, 327`; `server/src/patch.test.ts:78, 234, 235, 239, 251`). The constant stays as the compiled-in default and as the ordinal a host with no release document reports.

**8.5 `packs.declared` cannot gate a balance change.** *Accepted, explicitly.* For `build` packs the fingerprint is compiled in, so by the time the gate can check it the change is already in the binary that serves. What it *does* refuse is a release authored against a different build than the one deployed — the mixed-fleet detector `/api/version` was supposed to be. The review of a balance change is the **field-level diff** in `PackDiff.changes`, read by a human, and it is strictly better than today's "paste the new fingerprint in". Do not let the console imply more.

**8.6 A host cannot satisfy a release it is told to serve.** *Designed for — Rule E.* A `data` pack version missing or hash-mismatched, or a `build` pack fingerprint that does not match this binary (the normal mid-deploy state, because rooms outlive a deploy by design), makes the host **refuse the release**, keep serving the previous one, and report `unsatisfied: ['levels@7']` in `/api/version` and on the Inventory screen. Explicitly **not** `process.exit(1)`: the console that would fix it is served by the same process, an orchestrator would crash-loop it, `HostLifecycle` cannot drain a process that never boots, and the recovery would be SSH. The integrity property survives — the host never serves bytes it did not verify — while the remediation surface stays reachable.

**8.7 A client fetches a pack from a host on a different origin.** *Accepted, with the topology stated.* §0.3. A cross-origin level fetch is CSP-blocked today, mounted or not. Pack delivery to a browser requires the Node origin to serve the document. On Vercel-static, a content change remains a bundle redeploy — which is what happens today, so nothing regresses; it simply does not improve until the host exists. Phases 4 and 5 are marked accordingly.

**8.8 `localServer.ts` — the live product — is outside the mechanism.** *Partly designed for, partly accepted.* Designed for: the `Room` defaults it relies on are preserved (8.4), so it keeps working unchanged, and Phase 1's fingerprint split gives the shipped bundle correct per-pack **identity**. Accepted: the in-browser room has no release document, no rollout and no push. It runs one release — the one baked into the bundle it came from — and the console cannot reach it. That is not a gap the console can close; it is what "static hosting with no server" means (`client/src/net/serverConfig.ts:4-10`).

**8.9 A room's level resolver is consulted again mid-life.** *Designed for.* `RoomOptions.levels` is re-read at `server/src/room.ts:477` and `:550` when the campaign advances, so handing a room the mutable `LevelLibrary` would let a `reload()` change what an in-flight Quest room resolves for its *next* level. `inventory.viewFor(release)` returns a **frozen, version-bound `ContentResolver`**. `server/src/levels.ts:186`'s claim that reload is *"safe to call while rooms are running; they keep their copy"* is true only for the level already stamped.

**8.10 An id namespace that two packs can collide in.** *Designed out.* No namespace prefix. `sanitiseContentId` (`shared/src/modes.ts:654-656`) strips everything outside `[a-z0-9_-]`, so `:` and `/` are unavailable and `_`/`-` are ambiguous with ids that already contain them. Instead: **global id uniqueness, enforced by the `packs.unique` gate check.** Namespacing only earns its complexity when strangers author packs, which is REJECTED (Rule B).

**8.11 An expansion pack that spans arrival clocks.** *Designed out* — §1.2. The expansion is a release, not a pack kind, so there is no axis rule to violate.

**8.12 The boot-time hash check does not stop the author re-cutting a pack.** *Accepted, stated.* Re-running the build on modified sources produces a new, self-consistent digest and passes every check. The approve-then-swap defence is `packs.installed` **plus** immutable per-version directories **plus** a human choosing not to re-approve — which is the same single-operator trust this design accepts everywhere else (Rule B). What the check genuinely stops is a byte edit between approval and serve, and a second host with different files. That is worth having; it is not "provable review-to-serve integrity" and must not be sold as such.

**8.13 Two operators, two tabs, one document.** *Designed for* — CAS on every mutation, 409 with the current document. There is one operator today; two tabs are common.

**8.14 Nothing enforces any ratchet.** *Accepted for now, mitigated where it matters.* There is no CI: no `.github/`, no workflow, `Dockerfile` runs no tests, so today every ratchet in this repo fires only when a human types `npx vitest run`. This document does not fix that in general — but `packs.declared`, `packs.installed` and `levels.validate` run **inside the publish path**, so the three checks that matter most stop depending on anyone remembering. A real CI workflow is Phase 3's last task, and it is one file.

---

## 9. What this does NOT do

- **It does not make the live site push-able.** `doomcraft.vercel.app` is `"framework": null`, no `functions`, no `api/`, no middleware. Until the `Dockerfile` runs somewhere with TLS and serves the document, every content change on the live site is a redeploy, exactly as today. The console is a tool for a host that does not yet exist, and phases 2–5 are marked.
- **It does not change one byte on the wire.** §3 prices the change that would; nothing here needs it.
- **It does not deliver `weapons`, `core` or `characters` independently.** Those are `build` class. They get versions, fingerprints, diffs and rollback targets; they do not get a push button, and the console says the words.
- **It does not build a quest system.** `PackKind.QUESTS` is a reserved number with no producer, no def and no test. §1.3.
- **It does not make maps data.** §1.4.
- **It does not upload packs through the panel.** Bytes arrive with the deploy or on a volume; the console decides *which installed version is live, and when*. An upload path means a moderation pipeline, and two thirds of `docs/SPONSORS.md` §2.2 defends against a stranger who paid you.
- **It does not build items, trading or ownership.** §7 writes the rule down and reserves the number. That is all.
- **It does not resurrect the dead letters.** `CONTENT_UNAVAILABLE`/4003 and `BUILD_REVOKED`/4005 are documented in `docs/PATCHING.md:234-236` as live refusals and are emitted by **no server code path**. `CONTENT_MIN_SUPPORTED` (`shared/src/version.ts:90`) gates no routing decision. `PROTOCOL_WINDOW_DAYS` derives no deadline. `hostBucketFor` (`server/src/deploy.ts:351`) has no caller. All five stay dead, and this document **marks** them rather than pretending otherwise. `CONTENT_UNAVAILABLE` in particular only becomes reachable once a client can be told which pack to fetch — i.e. with the deferred wire change, or not at all.
- **It does not add two-person approval, a reviewer role, a `reviewedBy` field, or an approval queue.** There is one person, and a second signature from the same account is a lie in the audit log.
- **It does not gate on `fps1pctLow`.** When characters become measurable (Phase 6), the budget check reads `game.stats().drawCalls` / `charDraws` / `medianMs` (`client/src/main.ts:1943`) against the ~120 draw-call budget. Never `fps1pctLow`: `HANDOVER.md` §0.3 records it saturated at 53.5–53.8 in every configuration ever tried — headless to 20× throttle, 20 to 132 draw calls. It is Chrome's rAF jitter floor. A gate built on it **cannot fail**, which is worse than no gate.
- **It does not enable third-party pack authorship, ever, under this design.** Rule B.

---

## 10. Considered and rejected

| Option | Verdict | What killed it |
|---|---|---|
| Delete `CONTENT_VERSION`; the release document is the only content identity | **REJECTED** | Three sites read it with no room and no document in scope, and `localServer.ts:303` — the live product's authoritative room — depends on the defaults it feeds. 8.4 |
| A per-pack manifest appended to `S2C.SESSION_CONFIG` | **LATER** | Nothing needs it until a client fetches a pack it does not have. It costs a `r.remaining` guard the decoder does not currently have anywhere, a second golden vector, and a truncated-buffer test. §3 |
| Content-addressed pack URLs under `/c/packs/<digest>.dcp`, cache-first-forever | **REJECTED for v1, revisit at Phase 4** | `/c/` is `client/public/c/` copied verbatim into `dist/` (`client/vite.config.ts`), so a pack there ships **in the bundle** — a git commit and a full redeploy, which is the thing it was supposed to avoid. On the Node origin it is a route with its own cache header and needs no `/c/` at all. The immutable-name idea is kept; the prefix is not |
| Boot-fatal digest verification (`process.exit(1)` on mismatch) | **REJECTED** | Crash-loops a host whose console is the remediation surface. Replaced by refuse-the-release, which keeps the integrity property and keeps the host up. 8.6 |
| Per-player or per-host rollout buckets (`flagBucket`, `hostBucket`, `hostBucketFor`) | **REJECTED** | Both are keyed on a player. `ModeRouter.route` puts two players in one room, and a room has one pack set. A player-keyed pack rollout either does nothing or splits a room. Rule D |
| A semver range language for pack dependencies (`^`, `~`, a solver) | **REJECTED** | Five packs, one author, one release naming one version of each. A solver introduces the possibility of two runs disagreeing, which is the failure the whole design exists to remove |
| A `<pack>__<local>` id namespace | **REJECTED** | `sanitiseContentId` permits `_` freely and `CONTENT_ID_PATTERN` allows both separators, so `levels__e1` is a legal *pack* id and the first-separator split silently mis-parses every item it owns. Global uniqueness by gate check instead. 8.10 |
| A pack DSL for quests (declarative predicates over sim events) | **REJECTED** | A new interpreter with no test corpus, for a feature with no producer, against Rule A |
| A separate CDN origin for packs | **REJECTED** | It exists in `docs/SPONSORS.md` §2.2 so the game document never hosts a **sponsor** byte. A first-party level must come from the game's own origin — the CSP allows exactly `'self'`, and splitting costs the nonce and buys nothing |
| Retrofitting `FlagService` with persistence and CAS | **REJECTED for now** | It works for what it does. Phase 0 fixes the two real bugs (merge semantics, `expectRevision`) and the console always sends the full document. The release document gets its own store because it has different requirements |
| Merging the release document into the flag document | **REJECTED** | Different bucketing identity, different freeze fallback, different lifetime. §5.2 |
| The full `100 → 500 → 2500 → 10000` ladder in the console v1 | **LATER** | One host, and one long-lived room per key means a 1% stage reaches zero rooms for hours. A rollout percentage that is believed and untrue is worse than none. §5.2 |
| Fleet and Rollout screens in v1 | **LATER** | One host. §6 |
| A pack upload path in the console | **REJECTED** | Moderation pipeline, Rule B. §9 |

---

## 11. Build order

Each phase is independently shippable and ends in an honest state. Each names **the test that proves it** and **the import trace that proves it is live** — because in this repo five features have been written, tested, and imported by nothing, and "it compiles and tests pass" is not evidence.

**Node tier**: `doomcraft.vercel.app` is static with no server behind it. Phases marked ⚑ do not reach a player until the `Dockerfile` runs somewhere with TLS, `DOOMCRAFT_ADMIN_TOKEN` set, `DOOMCRAFT_ORIGINS` set, and `DOOMCRAFT_DATA` on a volume that survives a restart. They are still buildable, testable and mergeable before that.

---

### Phase 0 — the five bugs. **DONE. 3 days. No node tier needed to merge; two of the five only matter once one exists.**

Not pack work. The pack work is a lie without them.

Items 2 (`/api/status` join codes) and 5's auth half shipped in the security commit; items 1, 3, 4
and the client comparison shipped in the Phase 0 commit. Two things below were found to be
understated while doing them, and both are recorded in that commit's tests: `/api/status` leaked the
private code through **`name` as well as `key`** (the router builds rooms with `name: key`), and
`GET /api/scoreboard` with no parameters was a second door onto the same leak.

1. Fold the level hashes into `versionDocument()` — plumb `server/src/index.ts:497-503` into `server/src/deploy.ts:412`.
2. Strip `key` from `/api/status`'s room rows (`server/src/index.ts:930-945`).
3. Mount `LevelLibrary.handle()` in the dispatcher next to `/api/flags` (`server/src/index.ts:868`).
4. `POST /api/admin/flags`: merge semantics + `expectRevision` + 409.
5. `client/src/modes/quest/quest.ts:1144` — compare `context.contentHash` against `hashLevelBytes(encodeLevel(this.level))` instead of testing it against zero; refuse the blit on mismatch.

**Honest end state:** no packs exist. `/api/version` can distinguish two hosts. The level API answers. The client notices when the room's level bytes are not its own. The documented freeze command stops deleting the document.

**Test that proves it:** two `LevelLibrary` instances over directories differing in **one byte** produce different `/api/version` `content.hash` (`server/src/deploy.test.ts` — today `:96` asserts only `doc.content.version`, which is exactly why the missing fold survived). Plus: `/api/status` output contains no `~`; `GET /api/levels` returns `application/json`, not `text/html`; a POST of `{"revision":9,"frozen":true}` leaves every rule intact; and a room stamped with level bytes X against a client holding bytes Y raises a content mismatch — a test that today passes trivially in both directions, which is why it is worth writing.

**Import trace:** `server/src/index.ts` (process entry) → `deploy.ts:versionDocument` → the folded hashes. And `client/src/main.ts` → `client/src/modes/quest/quest.ts:onModeContext` → the comparison. Both on the boot path; item 5 ships to Vercel and reaches every current player.

---

### Phase 1 — pack identity, offline. **1 week. No node tier. This is the best value in the document.**

> **STATUS: DONE**, commit `895442c`. Suite 67 files / 1989 tests; every §4 check proven to
> refuse by feeding it the input its own row names. Four deliberate deviations, each an
> extension rather than a cut: (1) the `CharacterLook` table moved to `shared/src/characters.ts`
> (client registry re-exports) because phase 2's `runGate` must recompute the characters
> fingerprint in the serving process, and a client-only table would have made `packs.declared`
> a check the server cannot run; (2) the gate logic lives in `server/src/gate.ts` with
> `tools/release-verify.mjs` as a thin CLI face, so phase 2 wires the same checks instead of
> rewriting them; (3) `flags.order` and `saves.schema` compare against checked-in baselines
> (`BUILTIN_FLAG_ORDER` in packs.ts, `DECLARED_PERSIST/SAVES_VERSION` in gate.ts) since no base
> release document exists yet to record them; (4) the CI file — phase 3's last task — landed
> now, because a gate nothing runs is 8.14's own definition of theatre. `resolveRelease`,
> `packBucket` and the release document types shipped too (pure, tested, unconsumed until
> phase 2 — named here so the wiring auditor knows it is deliberate).
>
> The adversarial audit that followed red-proved all seven new guards and found two real
> bugs in the gate-vs-loader seam, both fixed with regression tests: the gate hashed level
> bytes BEFORE sanitising `meta.id` while the loader re-encodes after (a mixed-case id split
> the reviewed identity from the served one), and `scanLevelDir` missed the loader's
> `MAX_LEVEL_FILE_BYTES` cap (the gate certified a level the host would refuse). Also fixed:
> `packs.declared` now REFUSES unknown/duplicate/data kinds in a declared list instead of
> silently skipping them (the phase-2 runGate seam), the declared input strings are
> checked-in literals so a firing ratchet prints a real line diff, id sorts are code-unit
> (bare `localeCompare` made the fleet-agreement fingerprint locale-dependent), and
> `campaign.refs` refuses a non-canonical manifest id the client would match raw and drop.
> **Phase 2 pre-commitments the audit filed:** enforce `MAX_PACK_INPUTS` /
> `MAX_PACK_INPUT_BYTES` / `MAX_ORDINAL` (declared, enforced nowhere) plus
> `ordinal.monotonic` in `ReleaseService`; make `gate.nonempty` load-bearing once the check
> list is dynamic; store author-time inputs in the release document so data packs diff too.
> Known and accepted: the in-browser room reports `BUILTIN_CONTENT_HASH` (no levels fold)
> while a server room folds its levels pack — nothing compares the two, but a future
> client-side comparison would trip on it. And `release:verify` refuses to run against a
> tree whose `@doomcraft/shared` resolves outside the repo — run from a worktree without
> its own `npm install`, Node's resolver otherwise walks up into the MAIN checkout and the
> gate silently verifies a different tree than the one being edited.

`shared/src/packs.ts`. Split `contentFingerprint()` (`shared/src/version.ts:331`) into `coreFingerprintInputs()` / `weaponsFingerprintInputs()` / `charactersFingerprintInputs()`, keeping every input string byte-identical so the split is mechanical, and adding `terrain=${TERRAIN_VERSION}` to `core`. `CONTENT_FINGERPRINT` (`:102`) becomes `CORE_FINGERPRINT` + `WEAPONS_FINGERPRINT` + `CHARACTERS_FINGERPRINT`. `BUILTIN_PACKS` and `BUILTIN_RELEASE`. `packSetHash` replaces `contentHashFor` at its four call sites. `CONTENT_VERSION` **stays**.

Then `tools/release-verify.mjs`, wired to `npm run release:verify`, running `packs.declared`, `packs.installed`, `packs.unique`, `levels.validate` (with `W_REACH_SKIPPED` fatal), `levels.canonical`, `campaign.refs`, `protocol.stable`, `flags.order`, `gate.nonempty`, and printing the `PackDiff`.

**Honest end state:** nothing is pushed anywhere. The bundle's content identity is per-pack. `npm run release:verify` exits non-zero on a broken level, a moved fingerprint, a `FLAG_ORDER` insert, or an episode manifest that names a level that is not there — **the first thing in this repo that can refuse a change without a human choosing to be refused.**

**Test that proves it:** change one weapon field → `weaponsFingerprint()` moves and `coreFingerprint()`, `charactersFingerprint()` and the levels hash **do not**. Edit one level file → the levels hash moves and `weaponsFingerprint()` does not. That inverse is the user's literal ask, and today it trips **no ratchet at all** (`shared/src/version.ts:98-100` puts levels outside `contentFingerprint()` deliberately). Plus: `packSetHash` is insensitive to input array order and sensitive to any pack's kind/version/fingerprint; `levels.validate` fails on a level emitting `W_REACH_SKIPPED` **while the same level still loads into the library**, proving the gate is strictly stricter than the loader rather than a restatement of it; and `SESSION_CONFIG` still encodes to `0b03020100efbeadde0102000006616263313233` (`shared/src/version.test.ts:241`) — the explicit no-wire-change assertion.

**Import trace:** `package.json` `scripts.release:verify` → `tools/release-verify.mjs` → `shared/src/packs.ts` + `server/src/levels.ts`. Live because it exits non-zero and blocks a commit. Separately, `shared/src/version.ts` is imported by `server/src/room.ts:61` and `client/src/net/client.ts:121`, both on the boot path, so the split fingerprints ship in the live bundle from this commit.

---

### Phase 2 ⚑ — the server reads a release. **1.5 weeks.**

> **STATUS: DONE**, second session commit. `server/src/packs.ts`: `PackInventory` (versioned
> dirs under `DOOMCRAFT_PACKS/<key>/<version>/`, `content/` fallback as version 1, at most two
> loaded levels versions, frozen version-bound views per 8.9) and `ReleaseService` (durable
> tmp+rename document, CAS with 409-carrying-document, `release.jsonl` line per transition,
> the full §5 state machine with every server-enforced rule). The factory mints
> `randomBytes(8)` instance ids and resolves per room; `/api/version` reports the live pack
> set, the pending release, and `unsatisfied` (Rule E visible from outside). Eight admin
> routes under `/api/admin/release*`, each audited, proven over HTTP against the real
> binary. Deviations, honest: `runGate` recomputes the levels digest from a FRESH disk scan
> (a cached record would hold the pre-edit truth 8.12 exists to catch); the §4 `packs.unique`
> / `levels.*` checks run against the release's own version directory; the D6 history cap
> trims the rollback CHAIN from its deepest ancestor and re-bases the horizon onto revision
> 0 — the first implementation kept every previous live forever, dead-ended at 32 and
> evicted the just-created draft (caught by the 36-promote test); `stage` refuses the
> decorative intermediate rungs without `allowCustomRollout`, same rule as the flags route.
> `MAX_PACK_INPUTS`/`MAX_PACK_INPUT_BYTES`/`MAX_ORDINAL` are now enforced in the gate and
> the service (`ordinal.monotonic` included) — the phase-1 audit's pre-commitment, closed.

`server/src/packs.ts`: `PackInventory` (scans `DOOMCRAFT_PACKS/<key>/<version>/`, falling back to `content/` as version 1 so an unconfigured deploy behaves exactly as today; holds **two** installed versions — live and previous, which is the rollback requirement and half the code of four); `ReleaseService` (durable via `JsonFileStore`, CAS on `revision`, `release.jsonl` audit); `runGate`. Version-keyed `LevelLibrary` with `viewFor(release)` (8.9). Per-room resolution in the factory (`server/src/index.ts:551`) with the `randomBytes` instance id. Per-pack `/api/version` including `unsatisfied`. The seven admin routes. `adminAuthorised` hardened.

**Honest end state:** a host resolves a release per room, pins it, reports it, refuses one it cannot satisfy, and survives a restart. There is no UI; every mutation is `curl`. **No player sees anything different.**

**Test that proves it:** build a room from release A; publish B at `bp = 10000`; the existing room still reports A's ordinal and hash on `SESSION_CONFIG` and a **new** room reports B's — extending `server/src/patch.test.ts:229-243`. Plus: two concurrent `stage` calls with the same `ifRevision` → the second gets 409 and the document is **unchanged**; write the document, construct a fresh `ReleaseService` on the same directory, get an identical document; `approve` refused when `gate.ok === false` and when `note` is empty; a host handed a release naming an uninstalled `levels@7` keeps serving the previous release and reports `unsatisfied` (8.6); `reload()` mid-match does not change what an in-flight Quest room resolves for its next campaign level (8.9); and `resolveRelease` returns `BUILTIN_RELEASE` rather than throwing when `liveRevision` is unreachable (8.3).

**Import trace:** `server/src/index.ts:534` `lifecycle.guardCreate(create)` → `releases.resolveFor(roomInstanceId)` → `new Room({ contentVersion, contentHash, packs, levels: inventory.viewFor(release) })` → `server/src/room.ts:355-356` → `server/src/net.ts:657` `encodeSessionConfig` → the socket. Every online room, every join.

---

### Phase 3 ⚑ — the console. **1.5 weeks. This is ask (1), delivered.**

> **STATUS: DONE** (screens; the CI file landed back in phase 1). Three screens in the
> EXISTING operator console — this document predates it, so nothing was rebuilt: Inventory
> (per-pack, per-version, refused members with `formatValidation` verbatim), Review (the
> state machine's buttons with the decorative rungs rendered disabled and the reason on
> them; the draft's pack table with per-class arrival/rollback strings; the gate checklist
> failures-first; the diff), History (rollback only on the row the server would accept it
> for). Approve is enforced by the SERVER — the panel's disable is a courtesy. Mutations go
> through the console's existing type-the-subject-back confirm with actor + reason.
> Verified by driving the real machine over HTTP on a booted host and screenshotting all
> three screens with the staged release on them. Not done from §6: the flags screen's
> client-consumer-count column (needs a generated grep artifact; filed under LATER).

`/admin` served same-origin, three screens (Inventory, Review, History) plus Drain and Flags. In-memory token. And one `.github/workflows/ci.yml` running `npx tsc -b` + `npx vitest run` + `npm run release:verify` — one file, and the repo has none.

**Honest end state:** an operator opens a page, sees what is installed, sees the field-level diff of what a draft would change, sees a gate verdict they cannot override, writes one sentence, and clicks Approve → Promote. Levels and campaign push for real on that host. Weapons, characters and core show their diff and their version, and their Rollback is the string `rollback requires redeploying build <id>`. Fleet and Rollout are not there, and the page says why.

**Test that proves it:** wrong token, wrong-length token, lowercase `bearer`, missing header, unset env → each returns 401 with `WWW-Authenticate` and increments the failure counter and writes an `auth.denied` line. Plus: `approve` returns 409 when `gate.ok === false` **regardless of what the panel sent** — the disable is server-side; a `GateReport` with `checks.length === 0` is not approvable; and the flag-consumer column matches a grep of `client/src`, so a flag that gates nothing is provably labelled `0`.

**Import trace:** browser → `GET /admin` (`serveStatic`, nonce-stamped) → `fetch('/api/admin/release')` same-origin → `adminAuthorised` → `ReleaseService` → `release.jsonl`. And the CI file → `npm run release:verify` → Phase 1's gate, on every push.

---

### Phase 4 ⚑ — the client fetches a data pack. **1.5 weeks. Needs the Node origin serving the DOCUMENT, not just the rooms.**

Levels served per version from the Node origin under a dispatcher route with its own immutable cache header. `client/src/modes/quest/quest.ts` prefers the room's declared level version. `modeFingerprint()` added as a ratchet over `S2C_MODE.CONTEXT` (§3). Levels leave the lazy chunks — a measured **−194,226 B raw / −42,937 B gz**, because `client/src/net/localServer.ts` is both a module and a worker entry and rollup currently emits every level **twice** (verified in `dist/a/`: twelve level chunks, two per level, differing only in `const n=` vs `var n=`).

**Honest end state:** on a Node-origin deployment, a levels release reaches a player **with no client redeploy**. On Vercel-static, unchanged: a content change is still a bundle redeploy, and the console cannot reach the in-browser room (8.8). The bundle is 43 KB smaller everywhere.

**Test that proves it:** a client fetching `levels@7` from a room pinned to `levels@6` gets `levels@6`, and its `ModeContext.contentHash` comparison passes; flip one byte on the served level and the same comparison **fails and refuses the blit**. Plus: a golden vector and a `modeFingerprint()` ratchet for `S2C_MODE.CONTEXT`, which today is covered by no ratchet at all.

**Import trace:** `client/src/main.ts` → `quest.ts:307` `fetch(apiUrl(base, '/api/levels/<id>/data'))` → the dispatcher route → `PackInventory.viewFor(release)` → `LevelLibrary.handle()`. Same-origin, so `connect-src 'self'` covers it.

---

### Phase 5 ⚑⚑ — rollout and rollback. **1 week. Needs a SECOND host to mean anything.**

The bp ladder in the console, the Fleet screen polling every configured host's `/api/version` for `content.hash` agreement, previous-release retention, one-click rollback under §5's refusal rules.

**Honest end state:** a canary push and a one-click revert, with a denominator that is rooms and not players. Until there are two hosts and enough traffic to create rooms, the Fleet screen has one row and the ladder rungs stay disabled with the reason on them.

**Test that proves it:** two rooms **under the same key** with different instance ids land on opposite sides of `bp = 5000` — the regression test for 8.1, asserted through the real factory and not a synthetic id list. Plus: freeze collapses a partial rollout **and a staged release at `bp = 10000`** to `liveRevision`, and leaves a `live` release alone (8.2); a data-only release rolls back and new rooms get the previous pack set with no restart; a release whose build packs do not match this binary refuses rollback and returns the redeploy string; `schemaTouching` disables rollback permanently.

**Import trace:** `server/src/index.ts:551` → `releases.resolveFor(roomInstanceId)` → `resolveRelease` → `packBucket`. Already live from Phase 2; this phase adds the UI and the second branch.

---

### Phase 6 ⚑ — characters as a measured pack. **2 weeks. LATER, and honestly optional.**

`PackKind.CHARACTERS` gains a budget check: boot the build, spawn worst-case population, read `game.stats().drawCalls` / `charDraws` / `medianMs` (`client/src/main.ts:1943`) against the ~120 budget, refuse a regression against the last approved characters pack. Two mechanical preconditions with no judgement: the GLB must have **no `skins` array** (`client/src/characters/loader.ts:36-38` — a GPU-skinned cast cannot use `instanceMatrix` this way) and its parts must map onto `PART_COUNT`. A cast the packer cannot merge silently reverts one draw call at any population (`enemyRenderer.ts:325`) to N per character, and blows the budget at eight visible enemies.

Note the cost this phase actually carries: it is Playwright against WebGL, with all five documented traps (headed-only for the CMP path, `recordVideo` cannot see WebGL, pointer-lock ignores synthetic mouse). It is not a `tools/*.mjs`. Defer it until a second character pack exists that someone wants.

---

## Honest cost

| Phase | Weeks | Node tier | What it buys |
|---|---|---|---|
| 0 | 0.6 | no (2 of 5 only matter with one) | five real bugs, one of them a live join-code leak |
| 1 | 1.0 | **no** | per-pack identity, and a gate that can refuse |
| 2 | 1.5 | ⚑ | a host that resolves, pins, reports and refuses a release |
| 3 | 1.5 | ⚑ | **the console — ask (1), delivered**, plus the CI that does not exist |
| 4 | 1.5 | ⚑ | a level push with no client redeploy; −43 KB gz |
| 5 | 1.0 | ⚑⚑ | canary + one-click revert |
| **0–3** | **≈4.6** | | **both asks, on a Node host** |
| 6 | 2.0 | ⚑ | characters as a measured pack |

Phases 2–5 are **dead weight until the `Dockerfile` runs somewhere with TLS.** That is the honest headline: `docs/DEPLOY.md` lists deploying it as "the remaining step", and it has been the remaining step for a while. Phases 0 and 1 — **1.6 weeks, no infrastructure, no wire change, no protocol risk** — deliver the five bug fixes, per-pack content identity in the shipped bundle, and the first mechanism in this repo that can refuse a change without a human choosing to be refused.

Ship those two first. Sell the console as week four's work, and ship the refusal in week one.