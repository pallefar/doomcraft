# Doomcraft — accounts, the admin console, and the player profile

Requested 2026-08-22: *"please work on admin panel, auth and profile now in a separate workflow, to ensure we get that added and then wire all flags, user management, analytics in to it"*

Three surfaces and three wirings. This document decides all six, and it decides them against what is actually in the tree today rather than against what `docs/INFRASTRUCTURE.md` §5 assumed was there.

The platform picks are not re-opened. WorkOS AuthKit for the credential, Paddle as merchant of record, PostHog for funnels and self-hosted ClickHouse for the firehose — all decided at `docs/INFRASTRUCTURE.md:498-589`, all still right. **This document is about how they wire in, and about what ships in the months before any of them has an account behind it.**

Verified at HEAD **`41d4a94`**, working tree clean. Every anchor below was read at that commit; the hashes are in §14.

---

## 0. Ground truth before anything else

### 0.1 What exists, and the six things that are not what they look like

| Looks like | Actually is | Anchor |
|---|---|---|
| An admin panel | Three token-gated POST/GET routes with **zero callers anywhere in `client/`**. There is no UI. | `server/src/index.ts:901, 908, 924` |
| The "Admin" block in Settings | A localStorage product gate whose own header says **"THIS IS A PRODUCT GATE, NOT A SECURITY BOUNDARY … anyone with devtools can flip it"** | `shared/src/features.ts:7-11`, toggled `client/src/main.ts:1118-1140` |
| An account system | `accountId` is a **client-supplied free string** and `POST /api/account/link` hands the caller a durable credential on **any** device id it names, unauthenticated | `server/src/index.ts:1090-1101` |
| A server profile | **Write-only.** `grep -rn "/api/" client/src` returns 20 lines and **none of them is `/api/profile`**. `StoredStats`, `StoredEconomy` and `entitlements` accumulate and have never been read back into any UI. | `client/src/main.ts:1620`, `client/src/net/matchmaker.ts:153/205/214/234`, `client/src/modes/quest/quest.ts:244/308` |
| A flag control plane | **8 of the 10 flags have zero readers.** Only `economy_scrap` (3) and `client_update_prompt` (2) are consumed. `online_play` has none — the shipped online gate is the localStorage `Feature.ONLINE_MULTIPLAYER`. | `shared/src/flags.ts:79-90` vs `client/src/hud/hud.ts:636`, `server/src/room.ts:1507`, `client/src/main.ts:2055` |
| A local profile with XP in it | `SaveFile.profile.{xp, level, secondsPlayed, adsRemoved}` are **never written by anything**. `grep -rn "save\.profile" client/src` shows only `avatar`, `skin` and `lastMode` are live. They read 0 forever. | `shared/src/saves.ts:314-322`, `client/src/main.ts:427/476/1219/1831` |

Two more that matter to the wiring:

- **`applyServerFlags` (`shared/src/features.ts:54`) has zero callers repo-wide** — step 3 of its own documented resolution order never executes. And it could not work if it were called: it takes a record keyed by `Feature` ids (`onlineMultiplayer`, `economy`), while the only producer of a flags record in the tree is `FlagService.resolveFor()` (`server/src/deploy.ts:342`), keyed by `FLAG_ORDER` names (`online_play`, `economy_scrap`). **The two namespaces have never met.** The missing piece is a mapping, not a call site. §5.5.
- **`guardProfileWrite` returns `violation: true` (`server/src/entitlementGuard.ts:656`) and the field has zero readers in the whole tree.** `index.ts:1063` reads `filtered.rejectedFields` and never `filtered.violation`. `EntitlementGuard.submit` counts violations from `reviewSubmission` (`entitlementGuard.ts:707`); nothing feeds it a profile-write verdict. So the detector for *"post your XP straight to /api/profile"* — one of the four attacks `entitlementGuard.ts:20` says the file exists to stop — is wired to nothing.

**And the node server tier is not deployed anywhere.** `vercel.json` is `buildCommand: "npx vite build --config client/vite.config.ts"`, `outputDirectory: "dist"`, `framework: null` — no `functions`, no `rewrites`, no `api/`. Everything server-side in this document runs on nobody's machine until a box exists. Every phase in §12 states that explicitly.

### 0.2 Five decisions made up front, because they change the architecture

**1. The player row is the root. `deviceId` becomes a hint.**
`deviceId → StoredProfile` is 1:1 by construction — one file per device (`server/src/persistence.ts:743-746`) with `accountId` as a *column* on it (`:109`). A human has N devices; a family PC has N humans. A column can express neither. `docs/INFRASTRUCTURE.md:508` calls the merge *"the part you build and the part that will bite"*; today the schema cannot represent it at all. Everything in §2 and §3 follows from moving the root.

**2. The reward journal lands before the merge, and it lands now.**
`applyMatchResult` (`persistence.ts:574`) is a running-total mutator with **no journal**. Three economy commits landed in the last 48 hours (`56c71cb`, `cfda9e4`, `41d4a94`). A merge without a ledger is guesswork — you cannot re-point history you did not record, you cannot undo a merge you cannot replay, and **a journal cannot be backfilled from balances**. This is the only item in Phase C where delay has a compounding cost. §4.

**3. The admin console is a privileged surface, served by the game server, never in the game bundle.**
Stated once, unambiguously, because the rest of §5 depends on it: it is a TypeScript module inside `server/src/`, bundled into `server/dist/server.mjs` by esbuild, served at `GET /admin` by the Node origin, and it **does not exist as a route when `DOOMCRAFT_ADMIN_TOKEN` is unset**. It never enters `dist/`, never reaches a player, never widens the game's CSP. §5.1.

**4. There is no honest client-only authentication, and no interface trick removes that.**
`docs/SPONSORS.md:1152-1176`'s provider pattern is the right shape and it does transfer — but with one difference that must be said out loud: **`HouseSponsorProvider` fakes ad inventory, which is harmless. A house auth provider fakes identity, which is not.** So the house default is a *real* credential (a server-minted recovery code, §2.4), it is labelled `authenticates: false` in its own interface, and the account screen prints a different sentence for each value. What ships without a deployed host is the interface, the screens, and the closure of three live takeovers. What does not ship is a player on device B seeing device A's progress.

**5. Aggregate counters that carry no player identifier are outside the consent question by construction.**
That is why they are the only analytics that can ship before an age gate exists, and it is why the first new event in §7 is `match_end` with no player id in it. This is a default, not a setting — the exact analogue of `docs/SPONSORS.md:1194-1197`'s ad rule.

### 0.3 The dependency graph, honestly

```
                          ┌─ C1 profile overlay (client only) ──────► LIVE SITE, this week
                          │
C0 close the holes ───────┼─ C2 reward journal ──┬─ C5 the merge
(server only, no vendor)  │                      │
                          └─ C3 admin console ───┴─ C6 user management
                                    │
                          C4 accounts + socket ticket
                                    │
                          C7 analytics (house sink)
                                    │
                          C8 WorkOS · Paddle · PostHog ◄── the ONLY phase blocked on the user
```

C0–C7 need **no third-party account**. C3–C7 need a deployed Node tier to be *useful*; all of them are buildable and testable today against `npm run dev:server` and the child-process boot harness at `server/src/deploy.test.ts:29-80`. C1 needs neither and ships to `doomcraft.vercel.app` with `npx vercel --prod`.

---

## 1. The three surfaces, and where each one runs

| Surface | Origin | Bundle | Privilege | CSP |
|---|---|---|---|---|
| **Profile** | the game origin, whichever it is | `dist/` — in the player's bundle | none; renders the player's own data | unchanged |
| **Account flow** | the game origin | `dist/` — in the player's bundle | none; a code field and a redirect | unchanged; AuthKit is a top-level navigation and this policy has no `navigate-to` |
| **Admin console** | **the Node origin only, at `/admin`** | `server/dist/server.mjs` — never in `dist/` | **privileged: flags, drain, moderation, currency, refunds** | its own page, nonce-stamped by `stampNonce` (`server/src/index.ts:419`); the game's CSP never moves |

### 1.1 Origin decisions

| Option | Verdict | What decided it |
|---|---|---|
| Admin UI inside the game bundle | **REJECTED** | Four separate kills. (a) It would put the shared bearer into the document that also runs the ad slots, the service worker and — once `ads_programmatic` (bit 8) is on — third-party script; `docs/DEPLOY.md:50-54` says the static CSP is acceptable *"only while there is no third-party content on the page"*. (b) Any gate on `isEnabled(Feature.X)` is openable by typing `?ff_x=on` (`shared/src/features.ts:60-65`). (c) `client/src/main.ts:2112` observes `data-screen` and `client/src/boot/updates.ts:227` calls `location.reload()` when not playing — **an ops console that can push a release must not be served by the release system it pushes.** (d) Dead weight for 100% of players against a 1.9 MB / ~305 ms TTI budget. |
| A second Cloudflare Pages project at `admin.<domain>` | **LATER** | Correct destination once there is a domain, a Cloudflare account and a WorkOS tenant — three user items. It also inherits the CORS problem today: the preflight advertises `access-control-allow-headers: content-type` only (`index.ts:812`), so a browser on another origin **cannot send `Authorization`**. Revisit at C8. |
| A separate frontend *platform* (Vercel + Next.js for consoles) | **REJECTED** | `docs/INFRASTRUCTURE.md:426-429` already rejected exactly this: *"Two frontend platforms means two bills, two deploy pipelines and two auth integrations for zero benefit at any tier."* |
| A hand-written `server/admin/index.html` on disk | **REJECTED** | The `Dockerfile` copies exactly three things out of the build stage — `server/dist/server.mjs`, `dist`, `content`. A file at `server/admin/` is **not in the image**, so the console would work on the developer's laptop and 404 on every deployed host. That is precisely the failure mode this workflow exists to prevent. (`repoRoot` itself is fine: `resolve('/app/server/dist/server.mjs','..','..','..')` is `/app`, verified.) |
| **The console as a TS module, HTML as a template literal, bundled by esbuild** | **SHIP** | It ships with the image with **no `Dockerfile` change and no `.vercelignore` change**, and it cannot be missing in production. `tsc -b` sees the file. `stampNonce` (`index.ts:419-427`) rewrites `<script` → `<script nonce="…"` on the way out, so the inline script runs under the Node origin's `script-src 'self' 'nonce-…'` (`index.ts:307`) with **zero CSP change**. Same-origin, so no preflight and no `Authorization` problem. |
| Profile as a fifth `data-screen` value | **REJECTED** | `main.ts:2112` `attributeFilter:['data-screen']` → `controller.pump()` → `updates.ts:227` `applyNow()` → `location.reload()` whenever `isPlaying()` is false, and `isPlaying` is `game.playing \|\| screen === 'paused'` (`main.ts:2049`). A `'profile'` screen answers false to both, so a player **typing a recovery code would be reloaded out from under**. `setScreen` also drives `#ads[data-mode]` (`main.ts:1335`), so a new value silently inherits the 728×90 / 300×250 gutters. |
| **Profile as a full-screen overlay, direct child of `#ui`** | **SHIP** | Copies `.dca` at `client/src/ui/avatarEditor.ts:116-138` exactly. Fires neither trap. `#ui > *{pointer-events:auto}` (`client/index.html:66`) gives it interactivity **only at one level deep** — mount deeper and it is inert. Obeys `docs/CONTRACT.md:1039` §6: `#ui` is z30, and it never touches `#hud` (z10), `#ads` (z20) or `#ad-overlay` (z40). |

---

## 2. Identity — the data model

### 2.1 Nine defects in what exists, ranked

| # | Defect | Anchor | Severity |
|---|---|---|---|
| 1 | `randomToken()` uses **`Math.random()`** — V8's xorshift128+, one 128-bit process-wide state, recoverable from a handful of outputs. The **same** PRNG seeds every room (`room.ts:333`) and that seed is broadcast in `S2C.WELCOME`; `POST /api/rooms/private` (`index.ts:1000`) is unauthenticated and unrate-limited. **Mint rooms → harvest raw PRNG output → predict the next account secret.** `server/src/signal.ts:163-167` already writes the correct rule down — for a *40-bit room code*. | `persistence.ts:943-949` | **Critical** |
| 2 | `POST /api/account/link` takes `{deviceId, accountId}` unauthenticated and returns `publicProfile(victim)` **plus** a durable secret. Permanent read handle on anyone's profile. | `index.ts:1090-1101` | **Critical** |
| 3 | Same route, other direction: `accountIndex.set(accountId, deviceId)` is unconditional, so re-pointing a victim's `accountId` at my device makes their own `(accountId, secret)` 404 **forever**, invisibly — their profile file still says the right thing. | `persistence.ts:852` | **Critical** |
| 4 | `POST /api/entitlement` grants the $4.99 product to any device id, from any origin, with an unverified `receipt` string. Its own comment admits it (`:1082`). This is the **one** identity route the live client calls. | `index.ts:1076-1088`, `main.ts:1617-1638` | **Critical** |
| 5 | The secret is stored **in clear** and compared against the clear value. Disk access, or one `GET /api/profile` bug, is every credential. | `persistence.ts:109, 864-871` | High |
| 6 | `resolveAccount` returns a **profile blob, not a session**. There is no session concept anywhere in the tree; nothing binds "this browser proved it" to "this socket". | `index.ts:1103-1112` | High |
| 7 | The WS upgrade takes identity from `?device=` in the URL, syntax-checked only. With the day caps live (`DAY_XP_CAP`, `DAY_SCRAP_CAP`, `DR_LADDER`), an attacker can **burn a victim's entire day of earning capacity** for free. | `index.ts:1282-1284` | High |
| 8 | `GET /api/profile` calls `store.ensure` — **a GET writes a file to disk.** `curl "…/api/profile?device=$(openssl rand -hex 6)"` in a loop is unauthenticated unbounded disk growth at ~900 B a request, and nothing sweeps `<dataRoot>/profiles/`. Also: `corsOrigin` returns `'*'` when `DOOMCRAFT_ORIGINS` is unset (`index.ts:175-182`) and `originAllowed` (`:166`) is consulted at **exactly one place — line 1228, the WebSocket upgrade.** No HTTP route checks origin. | `index.ts:1019-1024` | High |
| 9 | `publicProfile` strips **only** `accountSecret`, so it leaks `entitlements.receipt` and `accountId` to an unauthenticated caller. `docs/INFRASTRUCTURE.md:452` requires *"`deviceId` never appears"* on a profile surface. | `persistence.ts:962-965` | High |

`constantTimeEquals` (`persistence.ts:952-959`) is sound and used at both call sites. Keep it.

### 2.2 The target model

`shared/src/identity.ts` is a **new file in `shared/`, which is a contract change** (`docs/CONTRACT.md:1087` rule 1) — the contract owner writes it.

```ts
/* shared/src/identity.ts — NEW. The identity vocabulary, in one place. */

/**
 * Branded on purpose — and the brand is NOT the firewall.
 *
 * A brand stops `string -> DeviceId`; it does not stop `DeviceId -> string`,
 * so any `props: Record<string, string>` would happily swallow one. The
 * structural defence against docs/INFRASTRUCTURE.md:858-863 ("one analytics SDK
 * initialised with the wrong user id and you have shared a persistent
 * identifier for a child with an ad network") is the CLOSED event union in §7.1.
 * The brand's job is to make the CI scan mechanical instead of a matter of taste.
 */
export type DeviceId = string & { readonly __dc_device: unique symbol };

/** ALWAYS `<namespace>:<opaque>`. Minted server-side. NEVER read from a body. */
export type AccountId = string & { readonly __dc_account: unique symbol };

/**
 * The key a profile file is stored under and a payout is banked to. Today it is
 * a device id string; after §2.3 it is the account's `primaryDeviceId`.
 * Distinct type so no code can key a write on "the device that connected".
 */
export type ProfileKey = string & { readonly __dc_profile: unique symbol };

export const ACCOUNT_NAMESPACES = Object.freeze(['house', 'workos', 'steam'] as const);

/**
 * Four states, and `unknown` is one of them.
 * docs/INFRASTRUCTURE.md:869-873: never widen this to a boolean. A boolean makes
 * "we have not asked" indistinguishable from "adult", which is the exact failure
 * that section is written about.
 */
export type AgeBand = 'unknown' | 'u13' | '13_17' | '18plus';

export type ModerationState = 'clear' | 'muted' | 'shadowbanned' | 'banned';
```

### 2.3 The account graph, and the one rule that kills split-brain

`accountId` comes **off** the profile and into its own record. The physical store stays `JsonFileStore` — Postgres is `docs/INFRASTRUCTURE.md` Phase 1 item 9 and is **LATER** (§10), because the thing it buys is enumeration and there are zero players to enumerate.

```ts
/* server/src/accounts.ts — NEW. Mirrors PersistenceStore (persistence.ts:182-194)
 * deliberately: docs/INFRASTRUCTURE.md:434 calls that interface out as
 * "already swappable — that was good design, use it." */

export const ACCOUNT_VERSION = 1;

export interface AccountRecord {
  version: number;
  accountId: AccountId;
  /** CredentialProvider.id that minted it. Decides the namespace. */
  provider: string;
  /** sha-256 hex of the recovery secret. `null` for redirect providers. */
  secretHash: string | null;

  /**
   * THE STORAGE KEY, AND THE WHOLE ANSWER TO SPLIT-BRAIN.
   *
   * The account's profile of record is the profile file of this device. It is
   * set once, at claim, and is NEVER reassigned by a later attach or by a
   * merge — a merge moves state INTO it, it does not move the key.
   *
   * Every read and every write of a profile goes through `resolveProfileKey`
   * below. Nothing else in the server may key a profile operation on "the
   * device that happens to be connected", because a player signed in on device
   * B would then watch a number on screen that their file does not contain.
   */
  primaryDeviceId: ProfileKey;

  /** Every device that has proven this credential. Append-only, capped at 8. */
  devices: DeviceId[];

  ageBand: AgeBand;
  moderation: ModerationState;
  moderationReason: string;
  moderationUntilMs: number;

  /** Non-trivial absorbs, for the merge budget (§3.5). */
  mergesLifetime: number;
  mergesWindowStartMs: number;
  mergesInWindow: number;

  createdMs: number;
  lastSeenMs: number;
  /** Same downgrade guard as StoredProfile._unknown (persistence.ts:122-138). */
  _unknown?: Record<string, unknown>;
}

/** A 30-day API session. The clear token is returned once and forgotten. */
export interface SessionRecord {
  readonly tokenHash: string;
  readonly accountId: AccountId;
  readonly deviceId: DeviceId;
  readonly issuedMs: number;
  readonly expiresMs: number;
}

/**
 * A SINGLE-USE, 120-second ticket for the WebSocket upgrade.
 *
 * docs/INFRASTRUCTURE.md:521-523: the upgrade is a different origin and must not
 * carry a session cookie. This REPLACES `?device=` at index.ts:1282 — it does
 * not sit beside it, or defect #7 stays open.
 */
export interface SocketTicket {
  readonly ticketHash: string;
  readonly profileKey: ProfileKey;
  readonly accountId: AccountId | null;
  readonly ageBand: AgeBand;
  readonly moderation: ModerationState;
  readonly expiresMs: number;
}

export interface AccountStore {
  get(id: AccountId): Promise<AccountRecord | null>;

  /**
   * THE ONE RESOLVER. `deviceId` -> the profile file to read and write.
   * Returns the device's own id when it belongs to no account.
   */
  resolveProfileKey(deviceId: DeviceId): Promise<ProfileKey>;
  accountForDevice(deviceId: DeviceId): Promise<AccountRecord | null>;

  /** Mints the id AND the secret. The caller supplies neither. */
  claim(provider: string, deviceId: DeviceId, nowMs: number)
    : Promise<{ record: AccountRecord; secret: string }>;

  /** Constant-time. Null on ANY mismatch — never "no such account" vs "bad secret". */
  verify(id: AccountId, secret: string): Promise<AccountRecord | null>;

  attach(id: AccountId, deviceId: DeviceId, nowMs: number): Promise<AttachOutcome>;

  moderate(id: AccountId, state: ModerationState, reason: string, untilMs: number,
           actor: string): Promise<void>;

  openSession(id: AccountId, deviceId: DeviceId, nowMs: number)
    : Promise<{ token: string; refresh: string; expiresMs: number }>;
  resolveSession(token: string, nowMs: number): Promise<SessionRecord | null>;
  revokeAll(id: AccountId): Promise<void>;

  mintTicket(s: SessionRecord, nowMs: number): Promise<string>;
  /** Single-use: the second redemption of the same ticket returns null. */
  redeemTicket(ticket: string, nowMs: number): Promise<SocketTicket | null>;

  /**
   * EVERY identity mutation runs inside this. One global mutex, not a per-key
   * lock.
   *
   * `persistence.ts`'s `withLock` (`:684`, `:924`) serialises per key, and an
   * attach touches a device record AND an account record — two keys, two lock
   * domains, no ordering. Taking both in a fixed order deadlocks the moment two
   * operations pick different pairs. Identity mutations are rare (roughly one
   * per player per lifetime), so a single serialising mutex costs nothing and
   * removes the entire question. It becomes a SERIALIZABLE transaction the day
   * Postgres lands, with no call-site change.
   */
  withGraphLock<T>(fn: () => Promise<T>): Promise<T>;

  flush(): Promise<void>;
  close(): Promise<void>;
}

export type AttachOutcome =
  | { kind: 'ok' }
  | { kind: 'already' }                                   // idempotent re-attach
  | { kind: 'merge_offered'; plan: MergePlan }            // §3
  | { kind: 'shared_machine' }                            // row 4
  | { kind: 'too_many_devices' }
  | { kind: 'budget_exhausted'; nextAllowedMs: number };
```

Two implementations, exactly as `MemoryStore` (`persistence.ts:625`) / `JsonFileStore` (`:710`): `MemoryAccountStore` and `JsonFileAccountStore` at `<dataRoot>/accounts/<2-hex>/<id>.json` plus one device index file. **`<dataRoot>/accounts.json` (`persistence.ts:748-766`) is deleted in the same change** — it is the index whose unconditional `set()` is defect #3.

**Two consequences of `resolveProfileKey` worth naming, both improvements:**
- The entitlement ledger's participant and settled sets (`entitlementGuard.ts:157-219`, used at `room.ts:1418`, `:1523`) key on the profile key, not the connection's device. The rule is *one payout per person per round*, and a person with two devices in one room must not be paid twice.
- `stableIdFor(conn)` (`deploy.ts:383`) prefers `accountId` when present. Flag buckets become stable per **person**, which is what a rollout means.

### 2.4 `CredentialProvider`, and the house default

```ts
/* server/src/credentials.ts — NEW. The docs/SPONSORS.md:1152 shape, applied. */

export interface LinkChallenge {
  readonly kind: 'code' | 'redirect';
  /** kind==='code' only, returned exactly once, never persisted in clear. */
  readonly code?: string;
  /** kind==='redirect' only: the AuthKit authorize URL. */
  readonly url?: string;
  readonly state: string;         // opaque, single-use, server-held
  readonly expiresMs: number;
}

export interface CredentialProvider {
  readonly id: string;

  /**
   * THE HONESTY FLAG, and the one place this pattern differs from
   * SponsorProvider.
   *
   * `false` means "this provider proves possession of a secret, not the
   * identity of a human". HouseSponsorProvider fakes ad inventory, which is
   * harmless; a house auth provider fakes identity, which is not. The account
   * panel prints a different sentence for each value, the audit log records it
   * per action, and a `false` provider's accounts are never eligible for an
   * operator role, a prize payout, or a trade.
   */
  readonly authenticates: boolean;

  begin(deviceId: DeviceId, nowMs: number): Promise<LinkChallenge>;
  /** `proof` is the typed code, or the OAuth authorization code. */
  complete(state: string, proof: string, nowMs: number)
    : Promise<{ accountId: AccountId; label: string; ageBand: AgeBand } | null>;
  revoke(accountId: AccountId): Promise<void>;
}
```

**`HouseCredentialProvider` — SHIP.** `authenticates: false`, `id: 'house'`. Mints `accountId = 'house:' + 24 hex` and a 20-character Crockford-base32 secret, both from `globalThis.crypto.getRandomValues`; stores only `sha256(secret)`. The player sees `HOUSE-XXXX-XXXX-XXXX-XXXX`.

> The `node:crypto` objection does not apply. `persistence.ts:12-13` avoids `node:crypto` because *"this module is safe to import (as types) from browser code"*. `globalThis.crypto.getRandomValues` and `globalThis.crypto.subtle.digest` exist in Node ≥19 (this repo runs 22) **and** in every browser. Zero imports, no platform branch. `randomToken()`'s replacement is six lines.

**What the recovery code protects against**
- Losing a device, clearing localStorage, or Safari ITP evicting script-written localStorage after 7 idle days — `docs/INFRASTRUCTURE.md:524-527`, *"a returning player on day 8 has silently lost everything"*. This is the actual player-facing problem and the code solves it.
- Server-side compromise of the credential file: only hashes are stored.
- All four critical defects in §2.1, which die with the routes.

**What it does NOT protect against, and each has a real cost**
- **Anyone who sees the code owns the account, permanently.** No second factor, no email reset, and **no way to prove which of two claimants is the owner**. The support answer is "I cannot help you." That is the price of having no vendor.
- **Screenshots.** This game ships share cards (flag bit 4) and streamers. The code must never appear on any screen a player is likely to capture, must never be exposed on `window.__DC__` (which `tools/capture-ours.mjs` reads), and the panel defaults to masked with hold-to-reveal.
- **Phishing.** Nothing stops a page that asks for "your Doomcraft code".
- **Age.** `ageBand` stays `'unknown'`, so under the amended COPPA Rule (in force since 22 Apr 2026, `docs/INFRASTRUCTURE.md:810-813`) every account is treated as a possible child. That is a hard ceiling on §7, not a gap here.

**One-line version for the user:** *this is "write this code down or lose your progress", it is materially better than the three unauthenticated takeovers that ship today, and it is not a login.*

### 2.5 Routes: three deleted, seven added

```
DELETE  POST /api/account/link          index.ts:1090-1101   the takeover primitive
DELETE  POST /api/account/resolve       index.ts:1103-1112   bearer secret -> profile blob, no session
CHANGE  POST /api/entitlement           index.ts:1076-1088   404 unless a charging provider is bound

POST /api/account/begin      {}                        -> { challenge }        [device cookie identifies]
POST /api/account/complete   { state, proof }          -> { session }          + Set-Cookie: dc_rt
POST /api/account/attach     { code }   Bearer session -> AttachOutcome
POST /api/account/merge      { plan }   Bearer session -> { mergeEventId }     §3
POST /api/session/refresh    Cookie: dc_rt             -> { session }
POST /api/session/ticket     Bearer session            -> { ticket }           the WS credential
POST /api/account/forget     Bearer session            -> 204                  revokeAll
```

`GET /api/profile` and `POST /api/profile` keep working for the anonymous device — that is ~90% of players and `docs/INFRASTRUCTURE.md:506` is explicit anonymous play stays as built — but with three changes: `Bearer <session>` wins over `?device=` when present; the response is `publicProfile` **minus `receipt`, `accountId` and `accountSecret`**; and **`GET` no longer creates**, closing defect #8.

### 2.6 Where WorkOS slots in

`WorkOsCredentialProvider implements CredentialProvider`, `authenticates: true`, `id: 'workos'`. It is a second file.

| Changes | Does not change |
|---|---|
| `begin()` returns `{kind:'redirect', url}` | `AccountRecord`, `AccountStore`, sessions, tickets, the admit path |
| `complete()` exchanges the code with WorkOS | `POST /api/account/complete`'s response shape |
| `accountId` becomes `workos:<subject>`; `secretHash` is `null` | The namespace rule — server-minted, never from a body |
| The panel renders a provider button, not a code field | §3 in its entirety |
| `ageBand` can move off `'unknown'` once an age gate ships beside it | Anything under `client/src/game/**` or `client/src/engine/**`, which imports no provider, ever |
| **CSP: nothing.** AuthKit is a top-level redirect; there is no `navigate-to` directive in either policy. | |

**The one thing that must be true now for that to be cheap later:** `accountId` must already be server-minted and namespaced **before** WorkOS lands. If `POST /api/account/link` survives to that day, an attacker links `workos:google|107691…` to their own device *before* the real owner ever signs in, and the owner's first sign-in lands on the attacker's profile. **Deleting that route is not cleanup; it is the precondition for the vendor.** That is why it is C0 and not C8.

---

## 3. THE MERGE — specified to implementation

This is the section naive designs skip, and it touches currency that landed 48 hours ago. Everything here is a rule, not a principle.

### 3.1 Vocabulary

```
P_c        = the player bound to credential C, or ∅ if the subject is new
P_d        = the home player of device D, or ∅ if the device has no account
claimed(P) = P has at least one credential bound to it
countable(P) = P has state a human would be upset to lose:
               progress.xp > 0 || progress.gamesPlayed > 0
            || economy.lifetimeScrap > 0 || stats.matches > 0
            || entitlements.adsRemoved
trivial(P) = !countable(P)
```

`countable` is the only predicate that decides whether a human is asked a question. It deliberately does **not** include preferences: nobody has ever grieved a keybinding.

### 3.2 The decision table — nine rows, no other outcomes

```
signIn(credential C, device D):

 1. P_c=∅  P_d=∅                                 -> MINT.  bind C, D.home=P, D.claimed=true
 2. P_c=∅  P_d≠∅  ¬claimed(P_d)  trivial(P_d)    -> CLAIM SILENTLY. bind C -> P_d, D.claimed=true
 3. P_c=∅  P_d≠∅  ¬claimed(P_d)  countable(P_d)  -> ASK ONCE. §3.2.1
 4. P_c=∅  P_d≠∅   claimed(P_d)                  -> MINT P3, bind C -> P3, session=P3.
                                                    D.home UNCHANGED.   SHARED MACHINE
 5. P_c≠∅  P_d=∅                                 -> session=P_c. D.home=P_c, D.claimed=true. NEW DEVICE
 6. P_c≠∅  P_d=P_c                               -> no-op.            IDEMPOTENT
 7. P_c≠∅  P_d≠∅  P_d≠P_c  ¬claimed  trivial     -> ABSORB SILENTLY (nothing to lose)
 8. P_c≠∅  P_d≠∅  P_d≠P_c  ¬claimed  countable   -> OFFER MERGE (P_d into P_c). Decline -> row 5
 9. P_c≠∅  P_d≠∅  P_d≠P_c   claimed              -> session=P_c ONLY. NEVER auto-merge two claimed
```

**Row 3 is the row that ruins games, and it is why "one click, no prompt" is wrong here.**
Brother plays 40 h on the family PC. He has never signed in, so `claimed(P_d)` is **false** — the device is unclaimed, which is exactly the state a naive design treats as free to claim. Sister sits down and signs in with her Google. Under a silent claim, her subject is now bound to his player row and she can take it anywhere.

There is nothing in the data that distinguishes "my device, just signing in" from "I am a guest on this machine". But the **cost is asymmetric**: claiming wrongly loses 40 hours; not claiming costs a fresh start that can be reversed later. So row 3 shows what is at stake and takes one answer:

> **Keep this device's progress?**
> Level 14 · 4,200 XP · 380 Scrap · 62 matches · first played 3 Aug
> `[ Keep it ]` `[ Start fresh ]`

That is one click either way — not a modal wall, not a diff, not a confirmation — and it makes the sister's answer obvious because she has never seen those numbers. Choosing **Start fresh** mints a third player, leaves `D.home` pointing at the brother and leaves `D.claimed` **false**, so he can still claim it. **Row 2 covers the overwhelming majority of real sign-ins and has no prompt at all**, because there is nothing to lose.

Row 4: once a device is claimed, `home` is frozen forever and only the *session* changes. Sign out and the browser falls back to `home`. That is what a family expects and it costs one boolean.

Row 9 is the legal one: automatically merging two *claimed* players is an account-takeover primitive. It is a support action requiring both credentials proven, and it writes a `merge_event` with two actor ids.

### 3.3 Field-class rules — the artefact

The merge is **not** "pick one" (destroys progress) and **not** "add everything" (mints currency and defeats the day caps). It is class-by-class. `A` is the survivor, `B` the absorbed.

| Class | Fields | Rule |
|---|---|---|
| **SUM** | `stats.{matches,wins,kills,deaths,damageDealt,blocksPlaced,blocksBroken,secondsPlayed}`, `stats.weaponKills[i]` elementwise, `progress.{kills,deaths,wins,gamesPlayed,blocksPlaced,blocksBroken,secondsPlayed}` | `a + b`, clamped to `Number.MAX_SAFE_INTEGER`. Counts of things that really happened, on two devices, by one human. |
| **MAX** | `progress.bestKillstreak`, `stats.bestStreak`, `stats.lastSeenMs` | A record is a max, not a total. |
| **XP** | `progress.xp` | `SUM`, then `progress.level = levelForXp(progress.xp)` (`shared/src/constants.ts:608`). Summing *levels* double-counts the curve; `levelForXp` is the only function permitted to set `level`. |
| **LEDGER** | `economy.scrap`, `economy.lifetimeScrap` | **NEVER ASSIGNED BY THE MERGE.** See §3.3.1. |
| **DAY** | `economy.{day,dayXp,dayScrap,dayMatches}` | **Roll both buckets to `now` first, then MAX.** See §3.3.2. |
| **ENTITLEMENT** | `entitlements.*` | `adsRemoved = a \|\| b`; `purchasedMs = min` of those actually granted; **both receipts kept** as separate `entitlement` rows. Two purchases by one human is one entitlement **and** a duplicate-refund case support must be able to see. A dropped receipt is a dropped reconciliation row. |
| **PREFERENCE** | `settings` (all 31), `bindings`, `loadout`, `progress.{name,skin,lastSeed}` | **Take A's, wholesale. Never field-merge.** A half-merged control scheme is worse than either one. The player chose a survivor; honour it. |
| **BAG** | `_unknown` (`persistence.ts:139`) | **Union; A wins on key collision; B's bag is retained on B's tombstone.** Both `_unknown` fields exist *specifically* so a rollback does not destroy data. A merge that rebuilds from a whitelist and drops `_unknown` re-creates the exact bug they were written to prevent. |
| **DROP** | `version`, `deviceId`, `createdMs`, `updatedMs`, `accountId`, `accountSecret` | Recomputed or owned by the store. `createdMs = min(a, b)` — "Marine since" should be the earlier date. |
| **NOT MERGED** | Quest slots, Builder worlds, Horde runs, Deathmatch per-weapon kills, `avatar` — the whole `SaveFile` (`shared/src/saves.ts:225-248`) | **The server has never stored any of it.** `StoredProfile` holds the *legacy flat* `SaveProgress`. Say so in the merge UI verbatim: *"Campaign progress, Builder worlds and Horde records stay on the device they were made on."* The server cannot merge what it does not have. |
| **REFUSED** | any open trade escrow (future) | **The whole merge is refused outright if either side has one.** A merge mid-escrow is how items get duplicated. |

#### 3.3.1 Money — stated once, unambiguously

> **`economy.scrap` and `economy.lifetimeScrap` are never assigned by the merge.** The merge writes two journal entries — `merge.debit` against B for its entire balance, `merge.credit` to A for the same amount — and then recomputes both balances from the journal. There is no field-level sum for money anywhere in this design. Anyone who writes `a.economy.scrap = a.economy.scrap + b.economy.scrap` has written the bug this rule exists to prevent, and the invariant test in §4.4 catches it.

`lifetimeScrap` follows the same path: it is `Σ` of positive `scrap` deltas over the journal, not a field to add. `MAX_SCRAP_BALANCE = 1e9` (`persistence.ts:42`) clamps the *balance*; a clamped merge leaves the surplus visible in the journal instead of silently vanishing.

#### 3.3.2 Day buckets — the rule, as code

```ts
// rollDayBucket (persistence.ts:528-541) zeroes any bucket that is not today.
// Call it on BOTH first and the two are same-day by construction; after that,
// max is correct and is the only safe operator.
rollDayBucket(a.economy, nowMs);
rollDayBucket(b.economy, nowMs);
a.economy.day        = utcDay(nowMs);
a.economy.dayXp      = Math.max(a.economy.dayXp,      b.economy.dayXp);
a.economy.dayScrap   = Math.max(a.economy.dayScrap,   b.economy.dayScrap);
a.economy.dayMatches = Math.max(a.economy.dayMatches, b.economy.dayMatches);
```

Three wrong answers, and why each is wrong:
- **Sum** exceeds `DAY_XP_CAP` / `DAY_SCRAP_CAP`, which `migrateProfile` then silently clamps (`persistence.ts:393-394`) while leaving `dayMatches` — the `DR_LADDER` index (`:557`) — inflated. The player is throttled to 15% for a day they did not play.
- **Min** hands the merged player a fresh day, which is exactly what a farmer merging a new device every morning wants.
- **Max without rolling first** copies a stale bucket forward. A device last played on 20 Aug at the cap, merged into one played today, produces `{day: today, dayScrap: 800}` — `rollDayBucket` sees today's date and does not reset, and the player is capped out from a bucket two days old.

Rolling first is not a workaround; it is calling the function that already normalises the thing being compared.

### 3.4 Concurrency and the transaction boundary

- **Every step runs inside `AccountStore.withGraphLock`.** One mutex, not two lock domains. §2.3 states the reason.
- **The `merge_event` is written FIRST, in `pending`, with the journal entry ids minted up front.** ULIDs are minted by the caller, not the store, so the event can name the entries it is about to write before it writes them.
- **Every step is idempotent on `(kind, sourceId)`.** On boot, any `merge_event` still in `pending` is replayed forward. That is the *only* reason the ledger's unique key exists on a merge as well as on a payout, and it is the whole crash story.
- **The profile writes go through `store.update(A.primaryDeviceId, …)`** — one key, so `withLock` (`persistence.ts:924`) serialises them against any concurrent match payout. B's profile is written under its own key in the same graph-lock window and marked `merged`.

### 3.5 Farming, and the two defences

Lifetime counters and Scrap sum, so a farmer runs N throwaway devices, caps each at `DAY_SCRAP_CAP = 800`/day, and merges them. Name it, defend it, don't discover it.

1. **A merge budget on non-trivial absorbs only.** Default ≤2 per rolling 30 days, ≤5 lifetime, both flag-configurable. Row 7 (trivial source — "I just opened the game on my phone") is free and unlimited, which is ~95% of real merges.
2. **Every merge is a journal event with an actor.** A farm shows up as a pattern in the audit stream rather than as an unexplained balance, and the Money screen (§5.4) graphs `merge.credit` volume per day.

**REJECTED: a merge-headroom cap** (clamping merged Scrap to the receiver's own 30-day earning headroom, with a `pending_merge_credit` table for the surplus). The budget already caps a farm at 5 × 800 × 30 = 120,000 Scrap over a lifetime against `MAX_SCRAP_BALANCE = 1e9`, so the headroom cap never binds on an honest player. It buys a second table, a support release flow and a UI string to defend a hole that is already closed. Rejected on complexity.

### 3.6 Reversibility

```ts
export interface MergeEvent {
  readonly id: string;              // ULID
  readonly ms: number;
  readonly intoAccountId: AccountId;
  readonly fromAccountId: AccountId;
  readonly actor: string;           // 'player' | `admin:${who}`
  readonly reason: string;
  readonly state: 'pending' | 'applied' | 'undone';
  /** Every field this moved, before and after. Capped at 8 KB. */
  readonly fieldDiff: string;
  /** Minted before any write. See §3.4. */
  readonly ledgerEntryIds: readonly string[];
  readonly undoneAtMs: number;
}
```

B is **archived, not deleted**: `AccountRecord.moderation` untouched, a new `status: 'merged_into'`, profile file retained 90 days. **Undo** reverses the two ledger entries with a matching pair, restores B's archived profile document, recomputes both balances from the journal, and writes a second `MergeEvent`. Self-service for 30 days, surfaced in the account panel as *"Undo the merge from 12 Aug"*.

This is only possible because the journal exists. `linkAccount` today overwrites `accountId`/`accountSecret` in place with no history and no audit row (`persistence.ts:846-862`), so a wrong link is unrecoverable — and `docs/INFRASTRUCTURE.md:508-510` requires *"present a merge UI; never silently overwrite"*, of which the storage layer cannot currently support even the undo half.

### 3.7 Worked example

A (`house:9f2…`, primary `dev-aaa`): level 14, 4,200 XP, 380 Scrap, 1,240 lifetime Scrap, 62 matches, best streak 7, today `{day:'2026-08-22', dayXp:900, dayScrap:120, dayMatches:2}`, `adsRemoved: true`, settings dark + 60 FOV.
B (`dev-bbb`, unclaimed): level 6, 900 XP, 40 Scrap, 210 lifetime, 11 matches, best streak 11, last played 20 Aug at the cap `{day:'2026-08-20', dayXp:6000, dayScrap:800, dayMatches:12}`, `adsRemoved: false`, settings bright + 90 FOV.

Row 8. Player accepts.

```
progress.xp        4200 + 900 = 5100        level = levelForXp(5100)
progress.gamesPlayed  62 + 11 = 73
bestKillstreak      max(7, 11) = 11
stats.*             summed elementwise, weaponKills[i] elementwise
economy.scrap       NOT ASSIGNED.  merge.debit -40 on B (balanceAfter 0)
                                   merge.credit +40 on A (balanceAfter 420)
economy.lifetimeScrap   recomputed from the journal = 1450
economy.day         rollDayBucket(A) -> unchanged (today)
                    rollDayBucket(B) -> {day:'2026-08-22', 0, 0, 0}   <-- the fix
                    then max         -> {day:'2026-08-22', 900, 120, 2}
entitlements        adsRemoved true; A's purchasedMs kept; B has no receipt
settings/bindings   A's, wholesale.  Bright + 90 FOV is discarded.
createdMs           min(A, B)
_unknown            union, A wins on collision; B's bag stays on B's tombstone
B                   status 'merged_into', profile archived 90 days
A.mergesInWindow    += 1
```

Note what did **not** happen: B's stale cap did not throttle A for the rest of the day, and no Scrap was created.

### 3.8 The implementation, complete

```ts
/* server/src/merge.ts — NEW. Pure planning, impure application, split so the
 * rules are testable under vitest's node environment. */

export interface MergePlan {
  readonly intoAccountId: AccountId;
  readonly fromAccountId: AccountId;
  readonly scrapMoved: number;
  readonly xpMoved: number;
  readonly matchesMoved: number;
  /** Rendered verbatim in the confirm dialog. One line per class. */
  readonly summary: readonly string[];
  /** Always present when the client save is non-empty on either side. */
  readonly notMerged: readonly string[];
}

/** PURE. No I/O, no clock beyond `nowMs`. This is what the tests bite on. */
export function planMerge(a: StoredProfile, b: StoredProfile, nowMs: number): MergePlan;

/** PURE. Mutates `a` in place, returns the ledger deltas the caller must write. */
export function applyMergeFields(
  a: StoredProfile, b: StoredProfile, nowMs: number,
): { scrapDelta: number } {
  const pa = a.progress, pb = b.progress;
  const sa = a.stats,    sb = b.stats;

  // SUM
  for (const k of ['kills','deaths','wins','gamesPlayed','blocksPlaced',
                   'blocksBroken','secondsPlayed'] as const) {
    pa[k] = clampSafe(pa[k] + pb[k]);
  }
  for (const k of ['matches','wins','kills','deaths','damageDealt','blocksPlaced',
                   'blocksBroken','secondsPlayed'] as const) {
    sa[k] = clampSafe(sa[k] + sb[k]);
  }
  for (let i = 0; i < sa.weaponKills.length; i++) {
    sa.weaponKills[i] = clampSafe(sa.weaponKills[i] + (sb.weaponKills[i] ?? 0));
  }

  // XP, then and only then the level
  pa.xp = clampSafe(pa.xp + pb.xp);
  pa.level = levelForXp(pa.xp);

  // MAX
  pa.bestKillstreak = Math.max(pa.bestKillstreak, pb.bestKillstreak);
  sa.bestStreak     = Math.max(sa.bestStreak,     sb.bestStreak);
  sa.lastSeenMs     = Math.max(sa.lastSeenMs,     sb.lastSeenMs);
  sa.favouriteWeapon = sa.weaponKills.indexOf(Math.max(...sa.weaponKills));

  // DAY — roll BOTH first (§3.3.2), then max. Never sum, never min.
  rollDayBucket(a.economy, nowMs);
  rollDayBucket(b.economy, nowMs);
  a.economy.day        = utcDay(nowMs);
  a.economy.dayXp      = Math.max(a.economy.dayXp,      b.economy.dayXp);
  a.economy.dayScrap   = Math.max(a.economy.dayScrap,   b.economy.dayScrap);
  a.economy.dayMatches = Math.max(a.economy.dayMatches, b.economy.dayMatches);

  // ENTITLEMENT
  if (b.entitlements.adsRemoved && !a.entitlements.adsRemoved) {
    a.entitlements.adsRemoved  = true;
    a.entitlements.product     = b.entitlements.product;
    a.entitlements.purchasedMs = b.entitlements.purchasedMs;
  } else if (a.entitlements.adsRemoved && b.entitlements.adsRemoved) {
    a.entitlements.purchasedMs = Math.min(a.entitlements.purchasedMs,
                                          b.entitlements.purchasedMs);
  }
  a.progress.adsRemoved = a.entitlements.adsRemoved;

  // DROP / PREFERENCE: A's settings, bindings and loadout are already in place
  // and are not touched. This is deliberate: see §3.3.
  a.createdMs = Math.min(a.createdMs, b.createdMs);

  // BAG
  if (b._unknown !== undefined) a._unknown = { ...b._unknown, ...(a._unknown ?? {}) };

  // MONEY: never assigned here. The caller writes the journal.
  return { scrapDelta: b.economy.scrap };
}
```

```
mergeAccounts(intoId, fromId, actor, reason, nowMs):           // server/src/merge.ts
  accounts.withGraphLock(async () => {
    A = accounts.get(intoId);  B = accounts.get(fromId)
    refuse if A.moderation !== 'clear' or B.moderation !== 'clear'
    refuse if budgetExhausted(A, nowMs) and B is countable
    refuse if either has an open trade escrow                    // future, stated now

    ids   = [ulid(), ulid()]                                     // minted BEFORE any write
    event = mergeEvents.write({ id: ulid(), state: 'pending',
                                intoAccountId, fromAccountId, actor, reason,
                                ledgerEntryIds: ids, fieldDiff: '' })

    pb = store.load(B.primaryDeviceId)
    journal.append({ id: ids[0], kind: 'merge.debit',  sourceId: event.id,
                     playerId: B.primaryDeviceId, currency: 'scrap',
                     delta: -pb.economy.scrap, balanceAfter: 0, actor, reason })

    store.update(A.primaryDeviceId, (pa) => {
      const { scrapDelta } = applyMergeFields(pa, pb, nowMs)
      pa.economy.scrap         = Math.min(pa.economy.scrap + scrapDelta, MAX_SCRAP_BALANCE)
      pa.economy.lifetimeScrap = Math.min(pa.economy.lifetimeScrap + scrapDelta,
                                          MAX_SCRAP_BALANCE)
      journal.append({ id: ids[1], kind: 'merge.credit', sourceId: event.id,
                       playerId: A.primaryDeviceId, currency: 'scrap',
                       delta: scrapDelta, balanceAfter: pa.economy.scrap, actor, reason })
    })

    store.update(B.primaryDeviceId, (p) => { p.economy.scrap = 0 })
    A.devices.push(...B.devices);  deviceIndex.repoint(B.devices -> intoId)
    B.status = 'merged_into'
    if (countable(pb)) { A.mergesLifetime += 1; A.mergesInWindow += 1 }
    mergeEvents.finish(event.id, 'applied', diffOf(before, after))
  })
```

Both journal appends are idempotent on `(kind, sourceId)`, and `sourceId` is the merge event id — so a crash anywhere in the block is repaired by replaying the same call.

---

## 4. The reward journal

### 4.1 Why now

> **BUILT.** `server/src/journal.ts`, wired into `Room.persistMember` and read by `GET /api/admin/journal`. §4.2's key was wrong in two ways and §4.4's test was not sufficient on its own; both are corrected in place below.

`applyMatchResult` (`persistence.ts:574`) is the single writer of `progress.xp` and `economy.scrap`, it runs under the per-device lock, and it **discarded the match**. There was no per-match record anywhere that survived a process: `SessionLedger` is an in-memory `Map` swept at 6 h holding only `{sessionId, trust, participants, settled}` (`entitlementGuard.ts:157-219`), and `Room.scoreboard()` (`room.ts:1560`) dies with the round. `docs/ECONOMY.md` asks for *"full audit log of every transfer, so a disputed or exploited trade can be traced and reversed"*; it was not built.

Without it: no merge, no undo, no refund, no clawback, no admin currency adjust anyone can audit, no dispute resolution, and no way to answer "where did my Scrap go".

### 4.2 The idempotency key, and a bug in the obvious choice

> **BUILT, AND THIS SECTION WAS WRONG IN TWO PLACES.** What shipped is described in the block below; the original text is kept because its reasoning is right as far as it goes and the corrections only make sense against it. Full write-up: `docs/BUGS-FOUND.md` §6.

`sessionId` is `` `${this.name}#${this.round}` `` (`room.ts:1155`) and `this.name` defaults to `'doomcraft'` (`room.ts:332`). **`deathmatch-1#3` is not globally unique and is not even unique across a restart of one host.** So:

```ts
/** server/src/index.ts, beside `bootMs` (:434). Also served on /api/version. */
const HOST_ID = randomBytes(6).toString('hex');
```

and the payout's `sourceId` is `` `${HOST_ID}:${sessionId}` ``. Putting `HOST_ID` in `/api/version` is not incidental: it is the field the fleet console needs to tell two hosts apart anyway (§5.4).

**CORRECTION 1 — the key is a TRIPLE, `(kind, sourceId, playerId)`.** A `sessionId` names a ROUND, and a round pays every player in the room. Under `(kind, sourceId)` the first player paid claims the key and the other thirty-one are refused as duplicates — and since the claim must gate the *mutation* as well as the row, they are not paid at all. The same key also collides between the XP row and the Scrap row of one payout, which would have dropped exactly half of everybody's money; that half is handled by `append` taking the whole movement GROUP and claiming one key for it.

**CORRECTION 2 — `HOST_ID` is necessary and not sufficient.** `ModeRouter` reaps an empty room and builds another under the same key, and the new room's rounds start at 1 again. `"deathmatch#1"` therefore names two different matches on one host on one day, and the second is refused as a replay of the first. `Room` now mints a `roomInstanceId` at construction and the payout's `sourceId` is `` `${HOST_ID}:${roomInstanceId}:${sessionId}` ``.

`HOST_ID` itself lives in `server/src/deploy.ts` beside `BUILD_ID`, not in `index.ts`, and it is inside `versionDocument` rather than passed to it — for the same reason `contentHash` became a required parameter: a value a caller can forget to publish is a value that quietly stops being published.

### 4.3 The model

```ts
/* server/src/journal.ts — NEW */

export type LedgerCurrency = 'xp' | 'scrap';
export type LedgerKind =
  | 'match.payout' | 'merge.debit' | 'merge.credit'
  | 'admin.adjust' | 'purchase.grant' | 'purchase.refund' | 'spend';

export interface LedgerEntry {
  readonly id: string;             // ULID, monotonic, minted by the caller
  readonly ms: number;
  readonly playerId: ProfileKey;   // the SURVIVING account's primaryDeviceId
  readonly currency: LedgerCurrency;
  readonly kind: LedgerKind;
  /** Unique WITH `kind`. `${HOST_ID}:${sessionId}` for a payout, the merge
   *  event id for a merge, the provider event id for a purchase. */
  readonly sourceId: string;
  /**
   * INTEGER UNITS, not micros. XP and Scrap are already integers everywhere —
   * `applyMatchResult` rounds both (persistence.ts:583-585) and `MAX_SCRAP_BALANCE`
   * is an integer. Micros would invent precision this economy does not have and
   * would make every comparison a place a float could creep in.
   */
  readonly delta: number;
  readonly balanceAfter: number;
  readonly actor: string;          // 'system:room' | 'system:merge' | `admin:${who}`
  readonly reason: string;
}

export interface Journal {
  /** Idempotent on (kind, sourceId). Returns false when it was a duplicate. */
  append(e: LedgerEntry): Promise<boolean>;
  /** Newest first, for the console and for a DSAR export. */
  read(playerId: ProfileKey, sinceMs: number, limit: number): Promise<LedgerEntry[]>;
  /** Sum of deltas. The balance is a projection of this, never the other way. */
  balance(playerId: ProfileKey, currency: LedgerCurrency): Promise<number>;
  /** Erasure only. See §4.5. */
  forget(playerId: ProfileKey): Promise<number>;
}
```

**As built** — four differences, each of which is a §4.2 or §4.5 correction reaching the signature:

```ts
export interface Journal {
  /** Has this exact movement group already been recorded? Async because the
   *  dedup set is seeded from disk: a synchronous `has` answers "no" for the
   *  whole of boot, which is the window a retry lives in. */
  has(kind: LedgerKind, sourceId: string, playerId: string): Promise<boolean>;
  /** ONE movement group — every row sharing (kind, sourceId, playerId).
   *  Returns rows written; 0 means it was a duplicate. */
  append(entries: readonly LedgerEntry[]): Promise<number>;
  read(playerId: string, sinceMs: number, limit: number): Promise<LedgerEntry[]>;
  /** Both currencies in ONE scan, plus `fromDay` — see §4.5's bound. */
  balances(playerId: string): Promise<JournalSums>;
  forget(playerId: string): Promise<number>;
  sweep(): Promise<number>;
  status(): JournalStatus;
  close(): Promise<void>;
}
```

**Storage — SHIPPED:** NDJSON at `<dataRoot>/journal/<YYYY-MM-DD>.ndjson`, appended inside the same `store.update` callback so it is under the per-device lock, plus an in-memory `Set` of the idempotency key seeded on boot from today's and yesterday's files.

Three things about it are not in the sketch above and are worth knowing before reading the file:

- **`PersistenceStore.update`'s callback is now `void | Promise<void>`**, and the lock is held for the whole of it. That is what "inside the callback" costs and it is the point: the row reaches the disk before `save()` even marks the profile dirty, and the profile write is debounced 800 ms — so on a crash the **journal leads the balance**, which is the recoverable direction. A row with no balance can be re-applied; a balance with no row cannot be explained.
- **`delta` is the observed movement, `balanceAfter - balanceBefore`**, not the amount the room asked for and not the amount the player was told. The three differ whenever the day cap, the ladder or `MAX_SCRAP_BALANCE` bites. Only this one makes `Σ delta == balance` true by construction; recording `MatchResult.xp` instead is red by 2.2x on the §4.4 test.
- **The key is length-prefixed, not NUL-joined.** A room key contains `~`, `:` and `#`, so no printable delimiter is safe — and a literal NUL in a source file makes `grep` skip the whole file with no match and no warning, which `shared/src/flags.ts` already cost this project once.

**Honest caveat, stated in the code:** the dedup set is per-process and covers 48 hours. That is exactly the window a retry lives in, and cross-host duplicate payouts are impossible today because only one host holds a given room. When Postgres lands, `UNIQUE (kind, source_id, player_id)` replaces the set with no call-site change.

**REJECTED: Postgres now.** `docs/INFRASTRUCTURE.md:432` Phase 1 item 9 is right and stays LATER. What Postgres buys is enumeration and cross-host uniqueness; there are zero players to enumerate and one host. Adding a driver to a runtime whose only dependency is `ws` (`Dockerfile:57-60`), plus a migration tool, plus a second `PersistenceStore`, is the largest work item on any list in this document and it is not on the critical path for a game with no users.

### 4.4 The invariant, and the test that can fail

```
for every playerId: Σ journal.delta(currency) == profile balance(currency)
```

`server/src/journal.test.ts` runs 10,000 synthesised matches across 200 devices through the real `applyMatchResult` under the real per-device lock — each round seating one to four players who **share a `sourceId`**, four UTC midnights passing underneath, the ladder firing on over 20,000 payouts and the day cap on over 5,000 — then reads the sums back off the NDJSON through the same `parseEntry` a reader uses and asserts the equality for every player and both currencies.

**BUILT AS SPECIFIED EXCEPT FOR TWO THINGS, and both are corrections.**

*No merges.* The specified test includes "two merges"; `merge.debit` / `merge.credit` have no producer until C5, so a merge in this test would be the test asserting against its own fixture.

*The invariant alone is not enough, and that matters.* A player whose payout is **refused** has no rows *and* no balance, so `Σ delta == balance` still holds for them: the invariant is blind to a refused payout and catches only a misrecorded one. That blindness is exactly the shape of the §4.2 key bug. So the test also counts: `expect(j.status().appended).toBe(payouts * 2)`, which is what reports `expected 20000 to be 50000` under the document's original key.

Red is proven by surgical hunk reverts rather than by stashing the file (a stash is an import error, not a failing assertion): recording the asked-for amount instead of the observed movement gives `xp diverged for device-inv00000: expected 52808 to be 24000`.

### 4.5 Retention, and the deletion conflict resolved at the point it is created

`playerId` is pseudonymous personal data, so an append-only file is a file that cannot honour an erasure request. `docs/INFRASTRUCTURE.md:850` requires the financial trail be **kept, pseudonymised, 7–10 years** while everything else is deleted — and today `entitlements.receipt` lives inside the same JSON blob as the whole profile, which makes "delete the profile" and "retain the financial record" **mutually unsatisfiable**.

So the journal is split at write time, not at delete time:

- `journal/<date>.ndjson` — `match.payout`, `merge.*`, `admin.adjust`, `spend`. Retention `DOOMCRAFT_JOURNAL_DAYS`, default 400. `forget(playerId)` rewrites each file through a temp and an atomic rename. It is the one rewrite path and it exists for exactly one caller.
- `financial/<date>.ndjson` — `purchase.grant`, `purchase.refund`, and the receipt. Retention `DOOMCRAFT_FINANCIAL_DAYS`, default 3650. Pseudonymised on erasure — the `playerId` becomes `deleted:<8 hex>` — rather than removed.

**Both directories are created at boot even though `financial` has no producer yet** (`POST /api/entitlement` 404s until a charging provider is bound). The split is made at write time because it cannot be made at delete time, and the receipt still has to move out of `StoredProfile` before the first real payment.

**What happens AT the bound, stated because a retention policy nobody has read the end of is a data-loss policy.** The oldest day file is deleted whole, and with it the ability to reconstruct a balance from before that day. `balances()` therefore returns `fromDay`, and `GET /api/admin/journal` puts it beside the two numbers, so a truncated sum is never shown to an operator as if it were a balance. The stored balance remains the number a player spends against; the journal is the audit trail, not the wallet.

**The receipt moves out of `StoredProfile` in the same change** (`PERSIST_VERSION` bump, §5.6). It must move **before** the first real payment, not after.

---

## 5. The admin console

### 5.1 Exactly where it runs, and what makes it privileged

**It runs on the Node origin, at `GET /admin`, from a TypeScript module bundled into `server/dist/server.mjs`.** It is never in `dist/`, never on `doomcraft.vercel.app`, never in a player's browser.

```ts
// server/src/index.ts, immediately before the SPA fallback in serveStatic,
// beside the two existing admin switches at :901 / :908.
if (path === '/admin' && (req.method === 'GET' || req.method === 'HEAD')) {
  /*
   * No token configured means no console, matching adminAuthorised's 404
   * philosophy at :627-631 — an unconfigured deployment does not advertise an
   * admin surface at all. Handled HERE rather than by serveStatic, because the
   * SPA fallback (:748-756) would otherwise hand out the game's index.html
   * with a 200 for this path.
   *
   * This route is NOT itself token-gated: the page is a shell that asks for the
   * token and ships no data. Every /api/admin/* call it makes IS gated.
   */
  if (ADMIN_TOKEN.length === 0) { sendJson(res, 404, { error: 'not found' }, cors); return true; }
  const body = Buffer.from(stampNonce(ADMIN_CONSOLE_HTML, nonce), 'utf8');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
  });
  res.end(body);
  return true;
}
```

**Why it is privileged, in one sentence:** it can drain a host, flip a kill switch for every connected player, ban an account, adjust a currency balance and issue a refund — five verbs with no undo except the audit row, on a page whose one credential is a shared string in an environment variable.

Three properties that follow, and are non-negotiable:

1. **The page carries no state and no secret.** The token is typed in, held in `sessionStorage` (dies with the tab, unlike localStorage), never in the URL, never in a query string.
2. **It uses `fetch`, never a `<form>`.** The Node CSP is `form-action 'none'` (`index.ts:329`).
3. **All decisions live in typed, tested modules; the HTML string is markup and event wiring only.** `nextFlagDocument()` goes in `shared/src/flags.ts` with tests (§5.5); the redaction and the status shaping go in `server/src/admin/model.ts` with tests. The HTML string is outside `vitest` and effectively outside `tsc`, so **nothing that can be wrong may live in it.** That is the mitigation for the one real cost of this choice, and it is stated as a rule because it will otherwise erode.

The console **cannot** `import { FLAG_ORDER }` — and that is the correct outcome. `FlagService.registry()` (`server/src/deploy.ts:356-370`) already returns `{key, bit, kind, what, blastRadius, defaultOn, force, rolloutBp}` read from `FLAG_ORDER` at runtime. A console that renders the registry can never offer a flag the server does not have, and `FLAG_ORDER` is append-only and moves.

### 5.2 Authentication, and four fixes to the bearer

`adminAuthorised` (`index.ts:627-637`) is one shared string, constant-time-compared, **404 not 401 when unset** — that last part is right and stays. Four things are wrong:

| Fix | Why |
|---|---|
| **Hash both sides before comparing.** `sha256(supplied)` vs `sha256(ADMIN_TOKEN)`, constant-time over two fixed-length hex strings. | `:632` `if (supplied.length !== ADMIN_TOKEN.length) return false` **leaks the exact token length in one request.** Three lines removes the oracle entirely. |
| **Refuse a weak token at boot.** `DOOMCRAFT_ADMIN_TOKEN` shorter than 32 characters leaves the admin surface disabled and prints one line to stdout. | `DOOMCRAFT_ADMIN_TOKEN=admin` is accepted today. This is a refusal, not a crash, matching the existing "no token, no surface" philosophy. |
| **Require `Bearer `.** | `:631` accepts a bare header value. |
| **Rate-limit it.** | See §5.3. |

**`actor` is a required body field on every mutating admin route, minimum 2 characters, and it is NOT authentication.** Say that in the code and in the UI. It is a label so the audit log reads, and it is what makes the row useful the day there are two operators. When WorkOS lands, `actor` comes from the session and the body field is refused.

**REJECTED: `DOOMCRAFT_ADMIN_TOKENS=alice:tok1,bob:tok2`.** One operator today. N tokens multiplies the guessable surface, forces the compare to run per token, and buys a per-person attribution that a required `actor` field already provides. Revisit at C8 with real SSO.

### 5.3 Rate limiting — new, because there is none

`grep -n "429\|rateLimit"` over `server/src/index.ts` finds nothing. The only rate limiting in the server is `SignalHub`'s, on the `/rtc` signalling socket (`signal.ts:74-79, 568, 577-589`). So the admin bearer is brute-forceable at line rate, and `POST /api/rooms/private` and both profile routes are unbounded.

```ts
/* server/src/limits.ts — NEW. A keyed token bucket, ~50 lines, no dependencies. */
export interface Limiter {
  /** False means refuse. Callers send 429 with `retry-after`. */
  take(key: string, cost?: number): boolean;
  sweep(nowMs: number): void;
}
export function createLimiter(perMinute: number, burst: number): Limiter;
```

Applied at: `/api/admin/*` (10/min), `POST /api/profile` (30/min), `GET /api/profile` (60/min), `POST /api/rooms/private` (10/min), `POST /api/account/*` (10/min). Swept on the existing 60 s timer beside `signalHub.sweep()` (`index.ts:1198`).

**The key is `clientAddress(req)` (`index.ts:1202-1212`), and it is already correct** — it reads `x-forwarded-for` **only** when `DOOMCRAFT_TRUST_PROXY === '1'` and otherwise uses the socket address. An unconditional XFF read is a rate limiter an attacker turns off with a header; this one already refuses to be. Behind Cloudflare, set `DOOMCRAFT_TRUST_PROXY=1` and note that the header must then be `cf-connecting-ip` or the leftmost XFF entry, which is what `:1208` takes.

### 5.4 The screens

**Screen 1 — Fleet & Flags.** The only screen whose inputs are already 100% serialised as JSON; every alternative has to invent a data source before it can render a pixel.

| Region | Data | Source |
|---|---|---|
| Header | origin · `HOST_ID` · `build.id` · `protocol.version` + **`fingerprint`** · `content.version` + `hash` · `uptimeMs` · drain state · `msUntilDeadline` | `GET /api/version` (`index.ts:856`), `/health` (`:832`) |
| **Fingerprint mismatch banner** | two hosts claiming the same `protocol.version` with different `fingerprint` | comparison across hosts — the mixed-fleet failure nobody thinks to look for (`docs/PATCHING.md` §8) |
| Left | rooms sorted by humans: key · mode · state · humans/players/bots · monsters · wave/round · `timeLeftMs` · `ageMs` · `chunks` · `worldReady`; totals from `fleet`; **`forcedRooms`/`forcedPlayers`** — the number the whole drain design exists to keep at zero | `/api/status` (`index.ts:930-946`) → `router.status()`, `Room.status()` (`room.ts:1576-1596`), `lifecycle.report()` (`deploy.ts:281`) |
| Right | one row per registry entry: `key`, `bit`, `kind`, `defaultOn`, force tri-state, `rolloutBp`, and **`blastRadius` rendered inline and verbatim**; `revision`; a FROZEN banner | new `GET /api/admin/flags` → `flags.registry()` |
| Writes | **FREEZE ALL ROLLOUTS** · per-flag force/defer · rollout stepper snapped to the `docs/PATCHING.md` §5 ladder (0 → 100 → 500 → 2500 → 10000) · **DRAIN THIS HOST** | `POST /api/admin/flags`, `/api/admin/drain` |

`blastRadius` is rendered inline, never behind a hover. It is `> 40` characters *enforced by `shared/src/flags.test.ts:57-58`* precisely so a human dares flip the switch; hiding it defeats the entire registry.

**Three warnings the screen prints in its own UI, all verified:**
- **Drain is a one-way door.** `HostLifecycle` has `beginDrain()` and `finish()` and **no path back to `ADMITTING`** (`deploy.ts:170, 202-203`). Undoing it costs a process restart. It also does not stop the process — `/health` goes 503 while HTTP keeps serving.
- **Every flag write hits one process.** `const flags = new FlagService(); flags.loadJson(process.env.DOOMCRAFT_FLAGS)` (`index.ts:488-490`); `deploy.ts:322-330` is *"deliberately dumb: no fetching, no polling, no timers."* One POST changes one host and reverts on restart. The header names the host.
- **The POST is a REPLACE, not a PATCH.** `FlagService.load` (`deploy.ts:314-320`): *"Replace the document. Total."* An omitted rule reverts to `defaultOn`, so the UI resends the whole document every time — which is what `nextFlagDocument()` is for.

**Screen 2 — Refusals.** `guard.status()` (`entitlementGuard.ts:735-748`: `sessions/accepted/rejected/violations/codes`) plus `guard.recent(64)`, the 256-entry ring at `AUDIT_RING_SIZE` (`:98`). **`deviceId` redacted to 8 characters by default**, revealed only by a click that writes an audit row. A ring full of `NOT_A_PARTICIPANT` next to a rising `accepted` is somebody probing; `violations` climbing is the number worth an alert.

**Screen 3 — Player.** One profile key in, one profile out, plus the journal and the actions. **Deliberately not a list**: `JsonFileStore`'s `FsLike` **declares `readdir` (`persistence.ts:702`) and never calls it**; the store is structurally incapable of enumeration and Postgres is LATER.

**Screen 4 — Money.** Journal totals per day, `merge.credit` volume, `admin.adjust` volume, `purchase.*` reconciliation. This is the screen that catches a farm and a webhook that has been silently dropped for six hours.

**Screen 5 — Releases.** `/api/version` across hosts, plus the v4→v3 warning from `docs/DEPLOY.md:120-137` — *"Rolling the room fleet back to a pre-v4 build is a data-destroying operation, not a routing change"* — surfaced where someone about to roll back will read it, because it directly contradicts `docs/INFRASTRUCTURE.md:592`.

### 5.5 Flags, wired in

Rendering the registry is the easy half. **The console is an interface to nothing unless the two dead wires are fixed in the same change.**

**(a) The two flag namespaces have never met.** `applyServerFlags` (`features.ts:54`) takes a record keyed by `Feature` ids; `FlagService.resolveFor()` produces one keyed by `FLAG_ORDER` names. The missing piece is the map:

```ts
/* shared/src/features.ts — NEW export. The only bridge between the two
 * namespaces, so the mapping is a decision somebody made rather than a
 * coincidence of two strings matching. */
export const SERVER_FLAG_FOR: Readonly<Record<Feature, string | null>> = Object.freeze({
  [Feature.ONLINE_MULTIPLAYER]: 'online_play',
  [Feature.SHARED_WORLDS]:      null,   // no server flag yet; the console prints
                                        // "no server flag" rather than a value
  [Feature.ECONOMY]:            'economy_scrap',
});
```
A test asserts every `Feature` appears as a key, so adding a `Feature` without deciding forces the decision.

**(b) A product gate is not a kill switch, and conflating them is the bug.** `features.ts:13-17`'s resolution order is `?ff_x` → localStorage → server → defaults. **localStorage beats the server**, so for every player who has ever touched the Settings toggle, `applyServerFlags` is unreachable. Wiring the call is still right for the untouched majority — but it is not, and must never be advertised as, a kill switch. The rule, stated once:

> **A product gate decides whether a player is *shown* something and may be overridden by that player. A kill switch decides whether the server *does* something and may not. Any surface that costs money or grants value requires BOTH.**

That is exactly what `economySurfacesOn` (`client/src/hud/hud.ts:636`) already does — `product && flagOn(flagBits, 'economy_scrap')` — with its own explanation at `:194-205`. It is the pattern; the console renders both values side by side per flag and marks any row where a client-side override could mask the server's answer.

**(c) `online_play` gets its reader.** `client/src/net/session.ts`'s decision to look for a remote server requires `onlineAvailable() && flagOn(bits, 'online_play')`. Bootstrap problem: there is no `flagBits` before connecting, so the boot path needs `GET /api/flags` — which also has zero client callers — translated through `SERVER_FLAG_FOR` into `applyServerFlags`. One fetch per boot, strong ETag, already implemented server-side at `index.ts:868-890`.

**(d) Fix the anonymous flag bucket.** `index.ts:869-870` uses the literal string `'anonymous'` for every device-less HTTP caller. That is precisely the *"turn a 1% rollout into an all-or-nothing coin flip on the whole anonymous population"* failure `deploy.ts:377-383` says it is avoiding on the socket path. **A rollout that cannot identify the player must not gamble — it returns `defaultFlagBits()`** (`shared/src/flags.ts:334`). One branch.

**Server additions for the flag console:**

| Addition | Why it is not optional |
|---|---|
| `GET /api/admin/flags` | There is no GET. Today a GET falls through `handleApi` to `serveStatic`'s SPA fallback (`index.ts:748-756`) and returns **the game's `index.html` with 200**. The document is readable only as a side effect of writing it. |
| `409` when `revision <= current` | `revision` is self-declared and **never checked** — `shared/src/flags.ts:198-199` says so in the source: *"Only used for logging and ETags."* Two operators posting concurrently silently last-write-wins. The field already exists; only the comparison is missing. |
| `POST /api/admin/flags/plan` → `{ document, diff[], warnings[] }` | The POST is a replace. `/plan` returns the exact full document to submit plus a human-readable diff, so the destructive action is reviewable before it fires and the risky logic is `nextFlagDocument()` — a **pure function in `shared/src/flags.ts` with tests** — instead of untested JS in an HTML string. |
| `reason` (≥10 chars) + `actor` on every mutation | §5.7. |

### 5.6 User management, wired in

Every operation, what exists, and what it needs. The whole surface today is `PersistenceStore` (`persistence.ts:182-194`) — nine methods, **every one keyed by device, with no list, no search, no delete and no merge**.

| Capability | Exists | Needs | Verdict |
|---|---|---|---|
| **Ban / mute / shadowban** | **Nothing.** No field on `StoredProfile`, no enum, no route. The only "ban" in the tree is IP-scoped and minutes-long, for room-code brute force (`signal.ts:74-76, 577-589`) — not player-scoped, not operator-controlled, not exposed. | `StoredModeration` + `ageBand` in **one** `PERSIST_VERSION` 4→5 bump. Enforced at `index.ts:1282`, the one place a socket adopts an identity: `banned` refuses the upgrade, `muted` drops chat, `shadowbanned` admits normally and sets the trust path so `guard.submit` strips every reward. | **SHIP (C6)** |
| **Kick one live player** | `Room` has no `kick()`; `signal.ts:592` is the signalling hub only. Today the only way to remove one player is `POST /api/admin/drain`, which closes **every room on the host**. | `Room.kick(profileKey, reason)` + one route. | **SHIP (C6)** |
| **Reset progress** | `store.update` works; nothing calls it for this. | One route, a `scope` parameter, an audit row. | SHIP (C6) |
| **Grant / revoke entitlement** | The only one end-to-end — **and unauthenticated** (`index.ts:1076-1088`). | Behind `EntitlementProvider`; the public route 404s unless a charging provider is bound. | **SHIP (C6)** |
| **Adjust currency** | No store method. `economy` has exactly two documented writers (`persistence.ts:89-93`). A raw `update()` would bypass `meterReward`'s day caps and land **unrecorded**. | `journal.append({kind:'admin.adjust', actor, reason})` + a per-day operator cap. | **SHIP (C6)** |
| **Refund / clawback** | **Unauditable by construction** — only a balance and `lifetimeScrap`. | The journal (C2) + the `entitlement` split (§4.5). | SHIP (C6) |
| **DSAR export** | `publicProfile` (`persistence.ts:962`) strips only `accountSecret`. It is a **debug view, not an export** — it leaks `receipt` and `accountId` to an *unauthenticated* caller and omits the entire `SaveFile`, which is where the player's actual play history lives. Neither half is right for Art. 15/20. | A real exporter over profile + journal + the client's own `SaveFile` (posted by the client, since the server has never held it). | **LATER (§9)** |
| **Erasure** | **Nothing.** `FsLike` has no `unlink` (`persistence.ts:698-703`). | A **job**, not a button. Seven stores; see §9. | **LATER (§9)** |
| **List / search** | **Impossible.** `readdir` declared and never called. | Postgres. | **LATER** |

**The 4→5 schema bump, done once:**

```ts
export const PERSIST_VERSION = 5;

export interface StoredModeration {
  state: ModerationState;      // 'clear' | 'muted' | 'shadowbanned' | 'banned'
  reason: string;              // the DSA statement of reasons, verbatim
  untilMs: number;             // 0 = indefinite
  byActor: string;
  atMs: number;
}
// on StoredProfile, plus: receipt MOVES OUT to the entitlement store (§4.5).
  moderation: StoredModeration;
  ageBand: AgeBand;            // 'unknown' by default. NEVER widened to a boolean.
```

**Five coordinated edits or the fields are destroyed on the next read**, per the header's own warning at `persistence.ts:30-38`: the constant; a step appended to `MIGRATIONS` (`:266`); **the block in the `out` literal inside `migrateProfile` (`:313-340`)** — the one people forget, because `migrateProfile` rebuilds from a whitelist and a migration step naming a key the literal does not is a no-op with a version bump on it; `createProfile()` (`:228`); and `KNOWN_PROFILE_KEYS` (`:146-150`) or the field round-trips through `_unknown` and is written twice.

**And `docs/DEPLOY.md:120-137` applies: rolling back across this boundary is a routing change only because v4 has the `_unknown` guard.** v5 → v4 is safe. v4 → v3 is still data-destroying.

**Two structural gaps closed in the same change:**

1. **`economy` is not in `SERVER_OWNED_PROFILE_FIELDS`** (`shared/src/trust.ts:818-823`). So `economy.lifetimeScrap`, `economy.dayXp`, `economy.dayScrap` and `economy.dayMatches` all pass `guardProfileWrite` (`entitlementGuard.ts:626-658`) — `economy.scrap` is caught only incidentally, because the bare name `scrap` happens to be on the list. The only thing saving the balance is that the handler copies back exactly four fields (`index.ts:1053-1056`). **One future `p.economy = incoming.economy` hands the client its own day-cap buckets, and no type and no test would object.** Add `economy`, `accountId`, `accountSecret`, `moderation`, `ageBand`.
2. **The nested strip matches by bare name anywhere**, so a keybinding called `xp` (`bindings.xp`) is reported as rejected and sets `violation: true`. **Exempt `bindings` from the nested pass** — it is a `Record<string,string>` of user-chosen keycodes, not profile fields. One named exemption, with the reason in the comment. Then feed the verdict to the guard at `index.ts:1071` so `guard.status().violations` finally moves for the attack `entitlementGuard.ts:20` says it exists to catch.

### 5.7 The audit log, and where it lives

```ts
/* server/src/adminAudit.ts — NEW. Same shape as AuditEntry (entitlementGuard.ts:664-674). */
export interface AdminAction {
  readonly id: string;          // ULID, monotonic
  readonly ms: number;
  readonly actor: string;       // from the required body field; a WorkOS subject later
  readonly verb: string;        // 'flags.set' | 'drain' | 'player.ban' | 'currency.adjust' | …
  readonly subject: string;     // flag key | host id | redactProfileKey(k) — NEVER a full device id
  readonly reason: string;      // REQUIRED, >= 10 chars, no default, not prefillable
  readonly before: string;      // JSON, capped at 2 KB  -> this is what makes undo one click
  readonly after: string;
  readonly outcome: 'applied' | 'refused' | 'rolled_back';
  readonly requestId: string;
}
/** Never more than 8 chars. Used by EVERY admin serialiser, including the
 *  existing guard.recent(64) at index.ts:927. */
export function redactProfileKey(k: string): string;
```

**`reason` is a required parameter, not a policy.** `docs/INFRASTRUCTURE.md:481-486`: under the DSA you owe a statement of reasons for every moderation action, *"so the ban tool must emit a document, not flip a boolean."* Making it a 400-on-absence is how that becomes structural.

**Storage — and the conflict named at creation, not after.** NDJSON at `<dataRoot>/audit/<YYYY-MM-DD>.ndjson`, append-only. `subject` carries a redacted 8-character key, which is 32 bits — effectively unique across any realistic player base, therefore **pseudonymous personal data, not anonymised**. An append-only file cannot honour an erasure request, and `docs/INFRASTRUCTURE.md:851` says **moderation records are kept** (*"a ban that deletes itself is an exploit"*). So:

- Rows whose `verb` starts with `player.` are **moderation records**: retained, exempt from erasure, and disclosed as such in the privacy policy.
- Every other row is retained `DOOMCRAFT_AUDIT_DAYS`, default 400, and is reachable by the same `forget()` rewrite path as the journal.

That split is the whole reason the redaction is at 8 characters and the reason `subject` is a profile key rather than a device id.

### 5.8 Two-phase confirm, when the reviewer is the author

The honest answer first: **a one-person team cannot have four-eyes review, and pretending otherwise is theatre.** What substitutes, ranked by value:

1. **Time, not a second pair of eyes.** Two-phase with a mandatory delay: 60 s for a flag at ≤500 bp, 10 min for a permanent ban, 24 h for a currency adjustment above `10 × DAY_SCRAP_CAP`. Confirm must come from a **different tab session**. Most bad admin actions are 3 a.m. mistakes, and a colleague at 3 a.m. would not have caught them either.
2. **Type the subject back.** The dialog requires typing the flag key or the profile key. Not a checkbox — the control that makes `rm -rf` survivable.
3. **Quote `blastRadius` verbatim inside the dialog.** §5.4.
4. **The ladder is the review.** 0 / 100 / 500 / 2500 / 10000 are the **only five buttons**; "custom" demands its own reason string. A rollout you cannot type freehand is a rollout you cannot fat-finger from 500 to 5000.
5. **Undo is the real reviewer.** Every action stores `before`, so every one has a one-click revert that itself writes a row.
6. **The flag document is a deploy artefact.** Keep it in git at `ops/flags.json`, POST it from a script, and the review is a diff with the blast radii in it. For a solo operator that is a 20-second self-diff, and it is exactly the review that catches "I meant 500".

### 5.9 Server routes added, in full

```
GET  /admin                        the console shell (404 without a token)
GET  /api/admin/whoami          -> { host, hostId, buildId, capabilities }
GET  /api/admin/flags           -> { revision, frozen, registry, host }
POST /api/admin/flags/plan      { edits[], reason } -> { document, diff[], warnings[] } | 409
POST /api/admin/flags           { document, reason, actor }      exists at :908; +reason +actor +409
POST /api/admin/drain           { reason, actor }                exists at :901; +reason +actor
GET  /api/admin/audit?since=    -> AdminAction[]
GET  /api/admin/metrics?days=   -> the house-sink rollup (§7.2)
GET  /api/admin/player?key=     -> redacted profile + journal page
POST /api/admin/player/moderate { key, state, reason, untilMs, actor }
POST /api/admin/player/reset    { key, scope, reason, actor }
POST /api/admin/player/kick     { key, reason, actor }
POST /api/admin/currency        { key, currency, delta, reason, actor }
POST /api/admin/entitlement     { key, product, grant|revoke, reason, actor }
```

Plus one existing route to decide: **`GET /api/status` is not admin-gated** (`index.ts:930-946`) and returns fleet state, room keys, room **seeds** and guard internals to anyone with curl. **Recommendation: `/health` stays public and minimal; `/api/status` moves behind the gate.** A room seed is a matchmaking-abuse surface.

---

## 6. The profile screen

### 6.1 Structure

`client/src/ui/profile.ts` — a full-screen overlay, direct child of `#ui`, `z-index: 5`, `display:none` / `.is-open{display:grid}`, copying `client/src/ui/avatarEditor.ts:116-138` exactly. Mutually exclusive with the locker by two lines, the same discipline `setScreen` already applies at `main.ts:1333`.

Split along the only testable line — `vitest.config.ts` sets `environment: 'node'` with no jsdom, which is why `client/src/ui/` holds four files and **zero tests**:

```ts
/* client/src/ui/profileModel.ts — NEW. PURE. No DOM. Testable under node. */

export interface StatTile  { readonly label: string; readonly value: string; readonly hint: string }
export interface ProfileRow { readonly left: string; readonly right: string; readonly dim: boolean }
export interface ProfilePanel {
  readonly title: string;
  readonly rows: readonly ProfileRow[];
  /** '' when the panel is complete; otherwise why it is thin. Never omitted. */
  readonly caveat: string;
}

export interface AccountView {
  readonly linked: boolean;
  readonly namespace: string;        // 'house' | 'workos' | ''
  /** VERBATIM from CredentialProvider.authenticates (§2.4). Drives the sentence. */
  readonly authenticates: boolean;
  /** "Not backed up — this device only." / "Linked. Anyone with the code has it." */
  readonly sentence: string;
  readonly deviceCount: number;
}

export type ProfileSource = 'device' | 'server' | 'both';

export interface ProfileView {
  readonly name: string;
  readonly avatarPacked: number;
  readonly since: string;
  readonly level: number;
  readonly xpIntoLevel: number;
  readonly xpForLevel: number;
  readonly tiles: readonly StatTile[];
  readonly panels: readonly ProfilePanel[];
  readonly account: AccountView;
  readonly source: ProfileSource;
  /** The provenance line under the header. NEVER empty. */
  readonly sourceNote: string;
  readonly economyVisible: boolean;
}

export interface ProfileInputs {
  readonly save: SaveFile;                        // shared/src/saves.ts:225 — client/src/main.ts:413
  readonly progress: SaveProgress;                // the legacy flat save — client/src/main.ts:378
  readonly remote: PublicProfile | null;          // GET /api/profile, or null offline
  readonly liveBalance: { xp: number; scrap: number } | null;  // NetClient.balanceXp/Scrap
  /** isEnabled(Feature.ECONOMY) — a localStorage PREFERENCE, nothing more. */
  readonly economyProduct: boolean;
  /** NetClient.flagBits — what the SERVER resolved. The kill switch. */
  readonly flagBits: number;
  readonly account: AccountView;
  readonly nowMs: number;
}

export function buildProfileView(i: ProfileInputs): ProfileView;
```

### 6.2 What it renders, and from where

| Panel | Source | Needs a server? |
|---|---|---|
| Header: name, avatar, "Marine since …" | `save.profile.{name, avatar, createdMs}` (`saves.ts:50-75`) | No |
| Four tiles: kills · deaths · matches · level | `progress.{kills,deaths,gamesPlayed,level}` — the same four the menu already prints at `main.ts:713-718` | No |
| Level bar | `progress.{xp,level}` + `xpForLevel`/`levelForXp` (`shared/src/constants.ts:602-611`) | No |
| **Quest** — 6 slots, per-level bests | `save.quest` → `QuestSlot` (`saves.ts:108`) + `QuestLevelRecord` (`:76`) | No |
| **Builder** — worlds, sizes, last played | `save.builder` → `BuilderWorld` (`:130`) | No |
| **Horde** — per-map best wave | `save.horde` → `HordeMapRecord` (`:155`) | No |
| **Deathmatch** — per-weapon kills | `save.deathmatch` (`:172`) | No |
| **Lifetime (authoritative)** — matches, wins, K/D, damage, blocks, `weaponKills[]`, `favouriteWeapon` | `StoredStats` (`persistence.ts:70-84`) via `GET /api/profile`. The weapon histogram is the one genuinely interesting panel already in storage. | **Yes** |
| **Scrap** — balance, lifetime, today's headroom vs `DAY_XP_CAP`/`DAY_SCRAP_CAP`/`DR_LADDER` | `StoredEconomy`; live values from `NetClient.balanceXp`/`balanceScrap` (`client/src/net/client.ts:929-930`, set at `:1583-1584`) | **Yes** |
| **Account** | §2 | **Yes** |

**Two rules the model must obey:**

1. **`sourceNote` is never empty.** `"Not backed up — this device only"` / `"Server profile · last seen 4 h ago"` / `"Both. Where they disagree, the server is right."` The local half's line is also the most effective and most honest conversion prompt in the product.
2. **Do NOT read `save.profile.{xp, level, secondsPlayed, adsRemoved}`.** `grep -rn "save\.profile" client/src` shows only `avatar`, `skin` and `lastMode` are ever written (`main.ts:427/476/1219/1831`, `client/src/characters/avatar.ts:318-324`). The other four are set to 0/1/false by `createSaveFile` (`saves.ts:319-322`) and **never touched again**. Rendering them would put a permanent zero on the screen. The live counters are in `progress`. Name it as the bug it is (§13) rather than paper over it.

`economyVisible` is `economySurfacesOn(economyProduct, flagBits)` **imported from `client/src/hud/hud.ts:636`** — not restated. That function's comment at `:194-205` is the specification, and a second copy is how the two drift.

### 6.3 The four traps

1. **`shared/src/trust.test.ts:402` scans every `.ts` under `shared/src`, `client/src` and `server/src`** and fails the build on any line pairing `/\bModeId\.[A-Z_]+/` with `/rank|reward|grant|scrap|\bxp\b|entitle|payout|prize|leaderboard|drop/i`. **A per-mode profile panel that writes `ModeId.DEATHMATCH` next to `xp` fails the suite.** Rule for both new files: never write a `ModeId.` literal; iterate `MODE_KEYS` by index and take any per-mode reward statement from `trustPolicyFor(modeId, matchType)`.
2. **`#ui button{font:inherit}` (`main.ts:150`, specificity 1,0,1) beats every class rule.** `avatarEditor.ts:288-300` restates its seven button fonts at `#ui .dca-*` specificity. `modeSelect.ts` never did, which is why the shipped PLAY button renders at 14 px system-ui instead of the 19 px Arial Black its rule asks for — `letter-spacing` and `text-transform` survive, which is why it looks *nearly* right. Restate at `#ui .dcp-*`.
3. **Do not add a fourth `.dc-*` block to `SHELL_CSS`.** `.dc-note` is already declared twice with different meanings (`main.ts:183` menu hints, `:229` settings note); equal specificity, later wins, so the menu's hint line renders with the settings panel's metrics. New prefix `.dcp-`, own `<style id="dc-profile-css">`, refcounted `ensureStyle`/`releaseStyle` copied verbatim from `avatarEditor.ts:301-315`.
4. **Consume `--safe-t/-b/-l/-r`** (`client/index.html:41-42`). Free reuse with zero new CSS: `SHELL_CSS` is global and never removed, so `.dc-panel` (`main.ts:205`), `.dc-set` (`:211`), `.dc-sec` (`:234`), `.dc-actions` (`:236`), `.dc-ghost` (`:173`) and `.dc-primary` (`:239`) all work inside the overlay. The account panel is a `.dc-panel > .dc-set` and looks native on day one.

### 6.4 The import trace

| Step | Existing anchor | Profile equivalent |
|---|---|---|
| import | `main.ts:87` `import { …createAvatarEditor… } from '@/ui/avatarEditor'` | `import { createProfileScreen, type ProfileScreen } from '@/ui/profile'` |
| handle | `main.ts:444` `let avatarEditor: AvatarEditor \| null = null` | `let profileScreen: ProfileScreen \| null = null` |
| **menu button** | `main.ts:726` `lockerBtn`, appended into `menuRow` (`:725`) before Settings (`:731`) | one more `button('Profile', 'dc-ghost', () => openProfile())` into the same `.dc-row`. **It is already a three-button launcher; a fourth is a 3-line diff and no layout rework.** |
| construction | `main.ts:763` `createAvatarEditor({ root: uiRoot, … })` | `createProfileScreen({ root: uiRoot, … })` — `root` must be `uiRoot` itself |
| open | `main.ts:778-780` | `openProfile()`, which first calls `avatarEditor?.close()` |
| screen machine | `main.ts:1333` `if (s !== 'menu') avatarEditor?.close()` | add `profileScreen?.close()` on the same line |
| **Escape** | `main.ts:1525` locker takes priority over `openPause()` | same priority — **forgetting this is how a modal becomes unclosable under pointer lock** |
| Enter/Space swallow | `main.ts:1533` | same guard, or typing a recovery code with a space starts a match |
| canvas click swallow | `main.ts:1585` | same guard |
| automation | `main.ts:1825-1827` `openLocker/closeLocker/lockerOpen` | `openProfile/closeProfile/profileOpen`. **Never the recovery code** — `__DC__` is read by `tools/capture-ours.mjs` and lands in screenshots. |

**Free reuse:** `client/src/ui/matchType.ts` is 566 lines of built, styled `MatchTypeBadge` / `MatchTypeNotice` / `MatchTypePicker`, **imported by nothing**, and asserted to exist by `shared/src/trust.test.ts:72-77`. A profile panel that says what a mode's matches are worth should render `MatchTypeNotice` (`:361`) rather than reinventing it — that gives an orphaned feature a live import path for free, and it is the only correct way to state a per-mode reward without tripping trap 1.

---

## 7. Analytics

### 7.1 The event model — a closed union, which is the actual firewall

```ts
/* shared/src/analytics.ts — NEW */

/**
 * A CLOSED discriminated union with no free-form property map.
 *
 * This, not the brand on `DeviceId`, is the firewall. A branded type is still
 * assignable to `string`, so a `props: Record<string, string>` would happily
 * swallow one. A closed union gives a device id NOWHERE TO GO. Adding a field
 * is a one-file diff a CI scan watches — docs/INFRASTRUCTURE.md:899: "a rule
 * that lives only in a document will be broken by the third engineer who joins."
 */
export type AnalyticsEvent =
  | {
      readonly kind: 'match_end';
      readonly modeKey: string;      // MODE_KEYS[i] — a slug, NEVER a ModeId literal
      readonly matchType: string;
      readonly seconds: number;
      readonly humans: number;
      readonly bots: number;
      /** Reached its own end condition, vs everyone left. THE question. */
      readonly completed: boolean;
      /** MatchAwardMessage.code — the guard's RejectCode. Free, and it turns
       *  "why did this match pay nothing" into a chart. */
      readonly rejectCode: number;
      readonly buildId: string;
      readonly contentHash: number;
    }
  | {
      readonly kind: 'host_rollup';
      readonly rooms: number; readonly humans: number; readonly connections: number;
      readonly accepted: number; readonly rejected: number; readonly violations: number;
      readonly bytesSent: number; readonly joinsRefused: number;
    };

export interface AnalyticsSink {
  readonly id: string;
  /** MUST be false for any sink allowed to run before a consent + age gate. */
  readonly carriesPlayerId: boolean;
  record(ev: AnalyticsEvent): void;
  flush(): Promise<void>;
  /** The deletion hook, AT the interface. */
  forget(id: string): Promise<void>;
}
```

Note what is **not** in `match_end`: no `deviceId`, no `accountId`, no `sessionId`, no names, no per-player scores. That is the design constraint that lets it ship before an age gate, not an oversight.

### 7.2 The house sink — SHIP, and it is already half-written

`LocalAnalyticsSink` (`carriesPlayerId: false`): appends NDJSON to `<dataRoot>/metrics/<YYYY-MM-DD>.ndjson`, one `host_rollup` per minute and one `match_end` per match. **Zero outbound network.** Files older than `DOOMCRAFT_METRICS_DAYS` (default 30) are deleted on the same timer. Because no line carries a player identifier, the file is outside the DSAR and erasure question entirely.

**`/api/status` is already this sink's output.** Two more inputs are computed every second and served nowhere — roughly four lines each:

- **`SignalHub.stats()`** (`server/src/signal.ts:636-653`): `rooms`, `connections`, `guestsConnected`, `roomsCreated`, `joinsAccepted`, `joinsRefused`, `bannedAddresses`, `messagesDropped`. **Nothing in `index.ts` calls it** — the only callers in the tree are `signal.test.ts`.
- **`ConnectionStats`** (`server/src/net.ts:289-299`), per connection: `droppedInputs`, `rejectedEdits`, `appliedInputs`, `bytesSent`, `bytesReceived`, `snapshotsSent`, `chunksSent`, `violations`. Maintained live, never aggregated, never served. Aggregating to `{p50, p99, total}` per host gives bandwidth-per-player **and** the reconciliation-correction signal `docs/INFRASTRUCTURE.md:573-585` names as the metric nobody instruments — from data already in memory.

**The caveat the Metrics screen prints:** everything above `metrics/` is in-memory and per-process, reset on restart. The NDJSON rollup is what turns "now" into "the last 30 days" and is what makes the console worth opening twice.

### 7.3 The consent gate — a default, not a setting

| `ageBand` | Behaviour |
|---|---|
| `unknown` / `u13` | **No third-party tag loads at all. No event leaves the origin.** House sink only. |
| `13_17` | First-party only. No session replay. No ad-network tag. |
| `18plus` **and** CMP consent | PostHog loads — **lazily, after first interactivity, never on the critical path.** |

Prerequisites, all seven, before any per-player event may be sent:
1. A CMP resolved before the menu is interactive and **never blocking Play** (`docs/SPONSORS.md:1422-1426`).
2. A **neutral month/year age gate**, never *"are you 16?"* (`docs/INFRASTRUCTURE.md:807-809`).
3. `ageBand` in the profile with `unknown` as its own state (`:869-873`). §5.6 adds the field; the gate that populates it is not built.
4. `deviceId` never the analytics id (`:858-863`). §7.1 is the enforcement.
5. A written retention policy with a stated deletion timeframe — indefinite retention prohibited outright since 22 Apr 2026 (`:810-813`).
6. Deletion reaching the analytics store, not just the profile (`:840-851`).
7. A CSP change. `vercel.json` is `script-src 'self'; connect-src 'self' ws: wss:` and the Node origin is `script-src 'self' 'nonce-…'; connect-src 'self'` (`index.ts:307, 318`). **The PostHog snippet cannot load and no event can leave either origin today.**

### 7.4 The transport problem for client events, named

Three of the obvious first events — `session_start`, `first_frame {ttiMs}`, `mode_selected` — are **browser facts**. Getting one to a first-party sink requires an HTTP POST carrying an IP from a player whose `ageBand` is `unknown`, which is the exact case the gate exists to prevent. So:

> **Client-originated analytics are LATER, and they are gated on the age gate, not on the sink.** Everything shipping in C7 is emitted **server-side**, from `server/src/room.ts` beside `tellPlayerWhatLanded` (`:1503-1513`), and from the `/api/status` rollup timer. That is not a limitation to work around; it is what makes C7 shippable without a CMP.

---

## 8. Cost

| Line | today | 1k CCU | 100k CCU |
|---|---|---|---|
| Room fleet (**prerequisite, not Phase C**) | $0 static | $55 one Hetzner AX42-class box … $220 for 4 across 2 regions [E, derived from `docs/INFRASTRUCTURE.md:283, 343`] | $2,565 |
| Game egress | $0 | **$0** unmetered 1 Gbit [V `:250`] | **$0** |
| Postgres + Valkey (LATER) | $0 | $19 | $200 |
| **WorkOS AuthKit** | $0 | **$0** | **~$1,250** — free to 1M account-MAU, then $2,500/mo per additional million [V `:507`]; ~90% of players never sign in [`:506`], so 100k CCU is the first tier where the meter is non-zero |
| **Paddle** | $0 | fee-only | fee-only. $4.99 at 5% + $0.50 → Paddle keeps **$0.75 (15.0%)**. Stripe keeps ~$0.50 (10%) *"plus your entire compliance function"* — VAT/GST registration and filing in ~100 jurisdictions [`:531-539`] |
| **PostHog**, allowlisted + 10% cohort above 100k | $0 | $0 | $1,500 |
| ClickHouse (**not before 100k CCU** [`:566`]) | $0 | $0 | $200 |
| Sentry | $0 | $26 | $400 |
| Admin origin | **$0 — it is a route on a box you already pay for** | $0 | $0 |
| Domain + TLS | $0 | ~$1.25 | ~$1.25 |
| **Phase C marginal (excl. fleet)** | **$0** | **~$46** | **~$3,350** |

**Two observations that shape the budget:**
- **Phase C is the half of the bill that grows with people, not with bytes.** At 1M CCU auth ($10,000) and product analytics ($7,500) are each larger than the CDN (`docs/INFRASTRUCTURE.md:316-320`). *"Egress is 98% of the decision"* is true of **choosing a provider** and false of the resulting invoice.
- **The WorkOS-vs-Clerk pick is the single largest line-item decision in this document**: $10,000 vs $100,000 at 5M account-MAU, same feature set (`:507-509`). It is already made; do not re-open it.

**Correction to every "as-built" number in `docs/INFRASTRUCTURE.md` §3:** the two egress bugs it leads with are **fixed** (`462c8dc`, "Bandwidth: 43.0 → 13.9 GB per player-month, measured"). Always read the "after the two fixes" column and adjust down.

---

## 9. What this does NOT do

| Not built | Cost, stated honestly |
|---|---|
| **Postgres** | No user list, no search, no leaderboard, no "players active today". `JsonFileStore`'s `FsLike` declares `readdir` (`persistence.ts:702`) and never calls it. User lookup is by profile key only. |
| **Email, password or OAuth in the house provider** | Account recovery is a code the player must not lose. A stolen code is permanent, unrecoverable theft with no support path. §2.4. |
| **Match history** | Still no per-match record with SCORES in it. `SessionLedger` is an in-memory `Map` swept at 6 h holding no scores and no timestamps (`entitlementGuard.ts:157-219`, `:96`); `Room.scoreboard()` (`room.ts:1560`) dies with the round. The journal (§4) is built and records *money*, not *matches* — two rows per player per round, saying what the balance did and nothing about who won. |
| **Leaderboards** | `REWARD_LEADERBOARD` (`shared/src/trust.ts:250`) is a permission bit with **no store, no writer and no reader**. "Top 10 this week" is not answerable. |
| **Friends, presence, social graph** | Zero occurrences outside prose. |
| **Items, titles, trophies, rating** | The *names* are reserved in `SERVER_OWNED_PROFILE_FIELDS` (`trust.ts:821-822`); none of the five exists in `StoredProfile`. |
| **Merging the client save** | Quest slots, Builder worlds, Horde runs and `avatar` live only in `doomcraft:saves` (`shared/src/saves.ts`). The server has never stored any of it and cannot merge it. Said in the merge UI verbatim. |
| **A DSAR export** | No code path. `publicProfile` is a debug view (§5.6). |
| **An erasure job** | `PersistenceStore` has no delete; `FsLike` has no `unlink`. A real one must touch **seven** places: the profile file **and the in-memory cache, `dirty` and `locks` maps under the per-device lock** — or the 800 ms debounced flush (`persistence.ts:875-908`) rewrites the file you just deleted; `<dataRoot>/accounts.json` (`:760`, which serialises the whole map, so a partial delete is a silent no-op); the guard's 256-entry ring (`entitlementGuard.ts:685`, `private readonly`, no removal API); `SessionLedger`'s participant and settled Sets; `SignalHub.addresses` (IP records, already self-expiring at 60 s); and Builder world `members[]`/`actors[]` — **anonymise the actor, keep the blocks** (`docs/INFRASTRUCTURE.md:848`), lawful only if disclosed. Plus the journal's two files (§4.5). |
| **An age gate** | `ageBand` exists as a field and stays `'unknown'`. Consequence: **no third-party tag may ever load and no per-player event may be emitted.** That is the correct default and a hard ceiling on §7. |
| **RBAC** | One token, one operator, everything permitted. `capabilities` is on the whoami response and is not enforced per route. |
| **Fleet fan-out** | One console session talks to one host. The flag document is per-process and reverts to `DOOMCRAFT_FLAGS` on restart. The header names the host; it must never imply a fleet. |
| **Feedback / Featurebase** | Named in HANDOVER Phase C, deferred: a $75–129/mo vendor account, and this design buys nothing. |
| **ClickHouse** | `docs/INFRASTRUCTURE.md:566`: *"Do not build this before 100k CCU."* On-plan, not a shortcut. |

---

## 10. What needs a provider the user has not set up

Following `docs/SPONSORS.md:1152-1181`'s pattern exactly: each is behind an interface with a **house default that is real software, not a stub**, and switching is configuration rather than engineering.

| Interface | House default | Real provider | Blocked on | What the default cannot do |
|---|---|---|---|---|
| `CredentialProvider` | `HouseCredentialProvider`, `authenticates: **false**` | **WorkOS AuthKit** | a WorkOS tenant + a domain | Prove a human. Recover a lost code. Populate `ageBand`. A `false` provider's accounts are never eligible for an operator role, a prize payout or a trade — enforced, not documented. |
| `EntitlementProvider` | `HouseEntitlementProvider`, `charges: **false**` — grants **only** from `POST /api/admin/entitlement`, audited, with a reason. **Refuses to construct when `NODE_ENV=production` and no provider key is set** — a mock that silently works in production is how you ship free money. | **Paddle**, merchant of record | a Paddle merchant account (business identity, tax details — longest lead time on this list after an ad network) | Take money. The "Remove ads — $4.99" button says **"Not yet on sale"** until a charging provider is bound. That breaks the one server call the live client makes (`main.ts:1617-1638`) — correctly, because that button currently promises a purchase nobody can pay for while the route grants it to anyone for free. |
| `AnalyticsSink` | `LocalAnalyticsSink`, `carriesPlayerId: **false**` | **PostHog** (funnels), **ClickHouse** (firehose, not before 100k CCU) | a PostHog account + a CSP change + an age gate + a CMP | Retention, cohorts, funnels, TTK distributions, wave histograms. You learn *what happened on a host*, not *what a player did over three weeks*. |
| — | — | **Hetzner / OVH** | an account (identity verification + a card) **and a domain** | Everything server-side. This is the item that gates C3–C7 from being useful, and it is not engineering. |

**The Paddle webhook, since it is the one with a wrong default that costs money:** read the **raw body before any JSON parse** (Paddle signs bytes); verify the HMAC in constant time and reject if `|now − ts| > 5 min`; `INSERT INTO provider_event … ON CONFLICT DO NOTHING` and **return 200 immediately if it was a duplicate** — idempotency lives in the store, not in application logic; resolve `custom_data.playerId` (**never match on email**); one transaction writing the entitlement row **and** a `purchase.grant` journal entry keyed `sourceId = provider event id`; **200 for every event understood, including duplicates, 500 only for "could not write"** — a 4xx makes Paddle stop retrying, which is the opposite of what you want; and a daily reconciliation that diffs Paddle's transactions against the entitlement store and alarms on either-side-only rows. Refunds are an **event**, not a button: support calls Paddle's API and waits for the webhook, never writing the entitlement directly.

**CSP note that saves a day of work:** Paddle's overlay checkout **cannot load** on either policy — `script-src 'self'` blocks `cdn.paddle.com`, there is no `frame-src` beyond `'none'` (`index.ts:322`), and `form-action 'none'` blocks any form post. **Take Paddle's hosted checkout via a top-level redirect.** It needs no CSP change at all. Do not widen the game's CSP for a payment flow.

---

## 11. Considered and rejected

| Option | Killed by |
|---|---|
| Adopt `accountId`/`accountSecret` as the auth model | Four critical defects, of which #3 is a permanent denial that leaves no trace in the profile file, and #1 is an end-to-end secret-prediction chain through an unauthenticated room-creation endpoint. §2.1. |
| Keep `POST /api/account/link` deprecated instead of deleted | A deprecated takeover primitive is a takeover primitive, and it is also the **pre-registration attack** against a `workos:` subject that does not exist yet. §2.6. |
| A `LocalCredentialProvider` that stores a "session" in localStorage and calls it sign-in | Theatre. `docs/SPONSORS.md`'s house pattern licenses faking *inventory*, not *identity*. §0.2 decision 4. |
| Currency in micros | XP and Scrap are integers everywhere already (`persistence.ts:583-585`); micros invent precision this economy does not have and add a place a float can creep in. §4.3. |
| The merge-headroom cap | The merge budget already caps a farm at 5 absorbs lifetime. The cap never binds on an honest player and buys a table, a support flow and a UI string. §3.5. |
| Postgres before the console | What it buys is enumeration, and there are zero players to enumerate. It is the largest work item in this document and it is not on the critical path. §4.3. |
| Admin UI in the game bundle | Four independent kills. §1.1. |
| A second frontend platform for the console | `docs/INFRASTRUCTURE.md:426-429`, already rejected for exactly this surface. §1.1. |
| `server/admin/index.html` on disk | Not in the Docker image. Works on the laptop, 404s in production. §1.1. |
| Multi-token `DOOMCRAFT_ADMIN_TOKENS` | Multiplies the guessable surface for an attribution a required `actor` field already gives. §5.2. |
| Profile as a fifth `data-screen` | Would hard-reload a player mid-recovery-code. §1.1. |
| Retool for the destructive actions | `docs/INFRASTRUCTURE.md:481-486`: a ban must emit a **document**, not flip a boolean. Fine as a read-only ops view. |
| Workers KV for the flag document | `shared/src/flags.ts:14-31` already overrode this: in-band on `S2C.SESSION_CONFIG` plus one ETag'd `GET /api/flags`. The principle survives; the implementation pick does not. §13. |
| Client-originated analytics in C7 | No lawful transport before an age gate. §7.4. |
| A test that asserts a screen "renders" | There is no DOM in this test environment, and **a green test that cannot fail is worse than no test** (`docs/BUGS-FOUND.md` §3). |

---

## 12. Build order

Each phase states: what ships · the test that proves it and how it is proven red · the import trace that proves it is live · whether it needs the Node tier deployed · whether it is blocked on a third-party account.

Route tests use the existing child-process harness at `server/src/deploy.test.ts:29-80` (`boot()` with `DOOMCRAFT_ADMIN_TOKEN`, a temp `DOOMCRAFT_DATA`, poll `/health`) — the only honest way to test an HTTP surface here. Red is proven by `git stash push <file>` and re-running, per `docs/BUGS-FOUND.md` §3.

---

### Phase C0 — Close the identity holes
**Ships (server only, no UI):** CSPRNG `randomToken`; hash `accountSecret`; **delete** `POST /api/account/link` and `/api/account/resolve`; `POST /api/entitlement` 404s unless a charging provider is bound; `GET /api/profile` becomes non-creating; `publicProfile` drops `receipt` and `accountId`; add `economy`, `accountId`, `accountSecret` to `SERVER_OWNED_PROFILE_FIELDS`; exempt `bindings` from the nested strip; **feed `guardProfileWrite`'s `violation` to the guard**; `server/src/limits.ts` + rate limits on `/api/admin/*`, both profile routes, `POST /api/rooms/private`; hash-compare + 32-char minimum on the admin token.
**Tests:** (1) `server/src/persistence.ts` contains no `Math.random` — a source scan in the `trust.test.ts:355` style; red today at `:943-949`. (2) Open 200 private rooms, harvest the `S2C.WELCOME` seeds, predict the next `randomToken()` — passes with `Math.random()` in place. (3) `POST /api/account/link` → 404; today it returns 200 with a secret. (4) `POST /api/profile` with `economy.dayScrap: 0` is rejected **and** increments `guard.status().violations`; a binding named `xp` does **not**; both red today. (5) `publicProfile` output contains no `accountSecret`, `receipt` or `accountId`. (6) The 201st admin request in a minute is 429.
**Import trace:** `limits.ts` → `index.ts` `handleApi` at the top of each named route; `adminIdentity` replaces `adminAuthorised` at all three existing call sites (`:902`, `:909`, `:925`).
**Node tier:** runs on `npm run dev:server`; **matters only when deployed**. **Third-party account: none.**

### Phase C1 — The profile overlay, device source, live
**Ships (client only, to `doomcraft.vercel.app`):** `client/src/ui/profileModel.ts` + `client/src/ui/profile.ts`; the ten `main.ts` touch points in §6.4; `MatchTypeNotice` gets its first live import; **`client/src/ui/wiring.test.ts` lands in the same commit.**
**Tests:** (1) `profileModel.test.ts` — on a fresh `createSaveFile()` no rendered string contains `NaN`, `Infinity` or `undefined`; 6 quest slots produce 6 rows; `economyVisible === false` when `economySurfacesOn(false, bits)`; **`buildProfileView` never reads `save.profile.xp`** (asserted by feeding a fixture with `xp: 999` and requiring it does not appear). (2) **The wiring ratchet** — it scans every file under `client/src/ui/` for *any* import of it from a shell file, **not for a `create*` export**, because `matchType.ts` exports zero `create*` functions and would otherwise pass silently while being 100% unwired; `KNOWN_UNWIRED = ['worldBrowser.ts']` is named explicitly and adding a name requires a deliberate edit. Red today for `matchType.ts`. (3) `openProfile()` is reachable from `window.__DC__`, mounts a direct child of `#ui`, and **does not change `uiRoot.dataset.screen`** — the anti-reload assertion; red if it is made a screen value.
**Import trace:** `main.ts:87` import → `:444` handle → `:726` button in `menuRow` → `:763` construction → `:1333` `setScreen` → `:1525` Escape → `:1825` `__DC__`. **Enforced by test (2).**
**Node tier: no.** **Third-party account: none.** *This is the only phase a player sees this week.*

### Phase C2 — The reward journal — **DONE**
**Shipped:** `server/src/journal.ts`, `HOST_ID` in `deploy.ts` beside `BUILD_ID` and inside `versionDocument` (not `index.ts`, and not a parameter — see §4.2), `Room.instanceId`, one entry per currency per `applyMatchResult` written from inside the per-device lock, the two-file split of §4.5, the retention sweep, and `GET /api/admin/journal` as the read path the console will render.
**Tests:** the §4.4 invariant across 10,000 matches / 200 devices / 25,000 payouts / four day rollovers; "a replayed `(kind, sourceId, playerId)` writes no second row **and moves no balance**"; a torn tail; a restart; retention; erasure; three room-level tests on a real `Room`; five live-binary tests. Red by surgical hunk revert, not by stashing the file.
**Import trace:** `journal.ts` → `new JsonJournal(dataRoot)` in `index.ts` beside `store` → passed to every `Room` in the router's `create` callback → `has()`/`append()` called from inside the `store.update` callback in `Room.persistMember` → read by `GET /api/admin/journal`.
**Node tier: yes** to matter; buildable and testable without. **Third-party account: none.**

### Phase C3 — The admin console, read + flags + drain
**Ships:** `server/src/admin/console.ts` (HTML as a template literal), the `/admin` route, `GET /api/admin/flags`, `/flags/plan` + 409, `reason` + `actor` on every mutation, `server/src/adminAudit.ts`, Screens 1 and 2, `SignalHub.stats()` and aggregated `ConnectionStats` added to `/api/status`, `/api/status` moved behind the gate. **Plus the four flag wirings of §5.5** — `SERVER_FLAG_FOR`, the `applyServerFlags` call from `onSessionConfig` (`client/src/net/client.ts:1568`), `online_play`'s reader in `session.ts`, and `defaultFlagBits()` for the anonymous HTTP bucket.
**Tests:** (1) `GET /api/admin/flags` without a token → 404 **and `content-type: application/json`, not `text/html`** — today it falls through the SPA fallback and returns the game HTML with 200. (2) `POST /api/admin/flags` with `revision <= current` → 409; red today. (3) Every mutating route with `reason` under 10 chars → 400 **and writes no audit row**. (4) Every `/api/admin/*` response body matched against `/[A-Za-z0-9_-]{12,64}/` contains no full device id; red today at `index.ts:927`. (5) `nextFlagDocument` in `shared/src/flags.test.ts` — an omitted rule survives at its current value; a non-monotonic revision throws; freeze leaves `force` alone; the stepper snaps to the ladder. (6) `GET /admin` with no token → 404 with a JSON content-type. (7) Every `Feature` appears in `SERVER_FLAG_FOR`.
**Import trace:** `ADMIN_CONSOLE_HTML` → the `/admin` branch in `handleApi`, placed before `serveStatic`; `AdminAudit` → constructed in `index.ts` beside `guard` (`:433-444`) → written by every mutating route → read by `GET /api/admin/audit`; `nextFlagDocument` → `POST /api/admin/flags/plan` → the console renders its diff and posts its `document` verbatim; `SERVER_FLAG_FOR` → `applyServerFlags` → `isEnabled` (`features.ts:73`), its **first live path**.
**Node tier: yes** to be reachable; buildable, testable and demoable on `localhost:8080`. **Third-party account: none.**

### Phase C4 — Accounts, the socket ticket, the death of `?device=`
**Ships:** `shared/src/identity.ts`; `server/src/credentials.ts` + `HouseCredentialProvider`; `server/src/accounts.ts` + both stores + `withGraphLock`; the seven routes of §2.5; `resolveProfileKey` threaded through the admit path and the entitlement ledger; the `dc_dev` httpOnly 400-day cookie (the Safari ITP fix — today a returning player on day 8 has silently lost everything); `?ticket=` replacing `?device=` at `index.ts:1282`; the account panel inside the profile overlay.
**Tests:** (1) Ticket single-use — a second `redeemTicket` of the same string returns null; an expired one returns null. (2) A ticket for player X **cannot** bank a payout to player Y. (3) Rows 1–9 of §3.2 as nine cases, each asserting the resulting `(session, D.home, D.claimed)` triple. (4) **Row 4, the shared machine:** a second credential signs in on a claimed device; after sign-out, the first player's `progress.xp` and `economy.scrap` are byte-identical. (5) **Row 3, the family PC:** an unclaimed *countable* device returns `ASK`, not `CLAIM` — red under any silent-claim implementation, and unlike a test written against an already-signed-in first player, this one can reach the failure. (6) `?device=` on the upgrade URL is refused.
**Import trace:** one `CredentialProvider` binding chosen in `index.ts` beside `store` (`:433`); `AccountStore` read by the upgrade handler at `:1282` and by every `/api/account/*`; `SocketTicket` minted by `POST /api/session/ticket`, carried by `client/src/net/serverConfig.ts:175` `gameSocketUrl` as `?t=`, redeemed at `:1282`. **Nothing under `client/src/game/**` or `client/src/engine/**` imports a provider, ever.**
**Node tier: yes** — the screen ships in the "device only" state without it, the flow needs a host. **Third-party account: none** (WorkOS is C8).

### Phase C5 — The merge
**Ships:** `server/src/merge.ts` (`planMerge`, `applyMergeFields`, `mergeAccounts`), `MergeEvent` + the pending-replay on boot, the merge budget, the undo route, the merge UI in the account panel.
**Tests:** (1) **Day buckets:** merging a device last played two days ago at the cap into one played today yields `dayScrap === today's own value`, not 800 — red under a plain `max`. (2) Merging two devices that each earned `DAY_SCRAP_CAP` **today** yields `DAY_SCRAP_CAP`, not `2×`. (3) XP sums and `level === levelForXp(xp)`. (4) `economy.scrap` after a merge equals `Σ journal.delta` for the survivor — red if anyone writes a field-level sum. (5) `_unknown` from both sides survives, survivor wins on collision. (6) Undo restores both profiles and both balances byte-for-byte. (7) A crash injected between the `merge_event` write and each subsequent step, replayed on boot, produces the identical final state.
**Import trace:** `planMerge` → `POST /api/account/attach` returns `{kind:'merge_offered', plan}`; `mergeAccounts` → `POST /api/account/merge`; both under `withGraphLock`; the ledger writes go through `journal.append` from C2.
**Node tier: yes.** **Third-party account: none.**

### Phase C6 — User management in the console
**Ships:** `PERSIST_VERSION` 4→5 (`moderation` + `ageBand`, receipt moves out) as one bump with all five coordinated edits; enforcement at the admit path; `Room.kick()`; the seven `/api/admin/player*` and `/api/admin/currency` and `/api/admin/entitlement` routes; Screens 3 and 4; `EntitlementProvider` + `HouseEntitlementProvider`; two-phase confirm with delay.
**Tests:** (1) Round-trip a v5 profile through a v4-shaped read — `moderation` and `ageBand` land in `_unknown` and come back unchanged; **this is the test that catches the forgotten `out` literal**. (2) A `banned` account is refused at the upgrade; a `shadowbanned` one is admitted and every reward is stripped. (3) `admin.adjust` writes a journal entry with a non-empty `actor` and `reason`, and the invariant of §4.4 still holds. (4) `HouseEntitlementProvider` **throws on construction** when `NODE_ENV=production` and no provider key is set. (5) A confirm submitted from the same session inside the delay window is refused.
**Import trace:** `AccountStore.moderate` → `POST /api/admin/player/moderate` → read at `index.ts:1282`; `EntitlementProvider` → the only path into `store.grantEntitlement` (`persistence.ts:842`).
**Node tier: yes.** **Third-party account: none.**

### Phase C7 — Analytics, house
**Ships:** `shared/src/analytics.ts`; `server/src/analyticsLocal.ts` + the retention timer; `match_end` emitted from `room.ts`; `host_rollup` from the `/api/status` timer; the Metrics screen; `GET /api/admin/metrics`.
**Tests:** (1) A source scan: no `sink.record(` call site under `client/src/game/**` or `client/src/engine/**`, and `AnalyticsEvent` declares no `Record<string, …>` member — red the moment a props map is added. (2) Type-level: `record({kind:'match_end', deviceId})` must not compile. (3) A 30-day rollup over synthesised NDJSON produces the expected `completed` rate per mode. (4) Files older than `DOOMCRAFT_METRICS_DAYS` are gone after one sweep.
**Import trace:** `AnalyticsSink` → constructed once in `index.ts` → `record()` called from `server/src/room.ts` beside `tellPlayerWhatLanded` (`:1503-1513`) and from the rollup timer → read by `GET /api/admin/metrics`.
**Node tier: yes.** **Third-party account: none.**

### Phase C8 — The vendors
**Ships:** `WorkOsCredentialProvider`; `PaddleEntitlementProvider` + the webhook + daily reconciliation; `PostHogSink`; the CMP; the neutral age gate populating `ageBand`; the CSP widening or the same-origin reverse proxy; and — once there is a domain — the console's move to `admin.<domain>` as a second Cloudflare Pages *project* (not a second platform).
**Tests:** deliver the same Paddle event twice → exactly one entitlement row and one journal entry; a tampered body → 4xx and **no** rows; `PostHogSink` refuses to construct while `ageBand === 'unknown'`.
**Import trace:** each is a second binding of an interface that already has a live default and a live call site from C4/C6/C7. **No call site moves.**
**Node tier: yes.** **Third-party account: WorkOS · Paddle · PostHog · Cloudflare · a domain. THIS IS THE ONLY PHASE BLOCKED ON THE USER.**

---

**Running in parallel, and blocking C3–C7 from being *useful* rather than from being *built*:** deploy the existing `Dockerfile`. `docker build -t doomcraft . && docker run -p 8080:8080 -v doomcraft-data:/data -e DOOMCRAFT_ORIGINS=… -e DOOMCRAFT_ADMIN_TOKEN=… doomcraft`. The image is finished — PID-1 node so SIGTERM reaches the drain, `/health` 200/503, a named volume at `/data` or every restart is a fresh device table. `<meta name="doomcraft-server" content="self">` (`server/src/index.ts` `SERVER_META`, read at `client/src/net/serverConfig.ts:17-22`) makes the **identical bundle** turn online with zero configuration, and same-origin makes `connect-src 'self'` **correct rather than a bug**. Blocked on: a Hetzner/OVH account and a domain — `docs/INFRASTRUCTURE.md:780-782`. Both are user items, not engineering. ~$55/month, egress $0.

---

## 13. Corrections to the other docs, for whoever reads them next

Ordered by how badly each would mislead.

1. **`docs/INFRASTRUCTURE.md` §3's "as-built" egress and cost numbers are stale by −68%.** Both bugs it leads with were fixed at `462c8dc` — delta encoding at `server/src/net.ts:1214-1227` (`EF_SPAWN|EF_ALL` only on `!known`) and cached per-room chunk deflate (`compressedChunk()` at `:1037`, `chunkZCache` at `:467`). Read the "after the two fixes" column, then adjust down.
2. **`docs/DEPLOY.md:42-46` claims the static CSP *"does not let injected script run"*. It is wrong.** `script-src-elem 'self' 'unsafe-inline'` overrides `script-src` for elements, and `client/index.html:181` is a bare inline `<script>` that proves it executes. This matters the moment a session token is on that page.
3. **`docs/INFRASTRUCTURE.md:568` says serve the flag document from Workers KV.** `shared/src/flags.ts:14-31` deliberately overrode it: in-band on `S2C.SESSION_CONFIG` (*"4 bytes on a packet that was already being sent"*) plus one ETag'd `GET /api/flags` per boot. The **principle** — the server resolves, the client never decides — survives; the **implementation pick** does not. An admin console targets `POST /api/admin/flags` → `FlagService.load()`, not KV.
4. **`docs/INFRASTRUCTURE.md:57` says "32 players total — one `Room`".** `ModeRouter` is mounted (`server/src/index.ts:519`, `DOOMCRAFT_MAX_ROOMS` default 32). `:640-644` in the same file already says so; §1's table row and Phase 1 item 5 are dead.
5. **`docs/INFRASTRUCTURE.md:502` and `:611` describe `PERSIST_VERSION = 3`.** It is **4** (`persistence.ts:39`), and the `_unknown` guard `:615-619` asks for is built. `docs/DEPLOY.md:120-137` adds the exception the doc lacks and which contradicts `:592`: **v4 → v3 is data-destroying, not a routing change.**
6. **`docs/INFRASTRUCTURE.md:597` says there is no service worker.** `client/public/sw.js` is 6,044 bytes with `skipWaiting()` banned and a `DC_SKIP_WAITING` handshake.
7. **`docs/INFRASTRUCTURE.md:426-429` rejects a second frontend platform, and the game is live on Vercel.** Serving the console from the Node origin makes the question moot for this surface; the rejection stands for C8's `admin.<domain>` (same Cloudflare account, a second *project*).
8. **`HANDOVER.md:142-143` says `tsc -b` fails on Vercel *"because the root tsconfig references `server/`"*. Not reproducible** — `npx tsc -b --pretty false` exits 0 at HEAD, and `.vercelignore` does not exclude `server/`. The load-bearing fact is unchanged and **worse** than the stated one: the production deploy gate is bundling only, vite does not typecheck, and **there is no `.github/` directory at all**, so `tsc` and `vitest` run nowhere in CI. A Phase C panel typed against server types can be red locally and green on `doomcraft.vercel.app`.
9. **New, and it belongs in `docs/BUGS-FOUND.md`: `SaveFile.profile.{xp, level, secondsPlayed, adsRemoved}` are dead fields.** Set by `createSaveFile` (`shared/src/saves.ts:319-322`) and never written again — `grep -rn "save\.profile" client/src` shows only `avatar`, `skin` and `lastMode` are live. Any UI rendering them shows a permanent zero. Fix is one line in the two places that already write `progress`, or delete the fields at the next `SAVES_VERSION` bump.
10. **New: `sessionId` is not unique.** `` `${room.name}#${round}` `` (`room.ts:1155`) with `name` defaulting to `'doomcraft'` (`:332`) repeats across a restart. Anything using it as an idempotency key needs `HOST_ID` in front of it. §4.2. **And that is not enough** — it also repeats when the router reaps a room and rebuilds it under the same key, whose rounds start at 1 again, so a `roomInstanceId` is needed as well. Both are now in `Room.payoutSourceId()`; the ledger's own `sessionId` is unchanged.

**Phase 1 items from `docs/INFRASTRUCTURE.md` §8 that are genuinely still open, and are the real prerequisites:** #1 brotli/ETag in `serveStatic` — `index.ts:739-784` still emits `content-length` + `cache-control` only, no `content-encoding`, no `etag`, no `last-modified`, and `/c/*` and `/characters/*` get `no-cache` **with no validator**; note the asymmetry, `vercel.json` fixes this for the static host and the Node origin does not. #4 rate-limit HELLO — still absent, and now partly addressed by C0's limiter but not on the socket path. #8 `server/src/world.ts:72`'s equality assert — the line that already took the server down once. #9 retire `JsonFileStore` — LATER by decision, §4.3.

---

## 14. Verification state

Read at HEAD **`41d4a94`** ("Show what the server granted: XP/Scrap on the HUD and the end-of-match panels, dark by default"). `git status --porcelain` was **empty** at both the start and the end of this pass.

```
server/src/index.ts             9488df8576af4e1b2bd07c3493429d04
server/src/persistence.ts       f91eb7f6809b447d6eb17810dd0b6778
server/src/room.ts              3eeeb61d77f85bc70a7b03a4c27bcd9c
server/src/net.ts               8af549d31b44440a4b8dbcdaec910156
server/src/deploy.ts            e6487e9a38a15c47fd30357adc952709
server/src/entitlementGuard.ts  27eae3940e0427d9a4e297ef20dedf99
shared/src/flags.ts             692e2f07be3bb79c189a568aae1abd85
shared/src/trust.ts             1ab6e49a20664f8ea56eb477980e7efb
shared/src/features.ts          efae32e3a56867dad127d16d1c612055
shared/src/saves.ts             cc7ca30ac2839103e9ac9996d2acc923
client/src/main.ts              b379b4c744a8fa8de9d59f15cf007aad
client/src/hud/hud.ts           d8d1fb7b7a084122bfb72ee2dc80aaf2
```

**Two things observed mid-pass and resolved, worth recording:** a concurrent audit harness (`tools/__audit-live.mjs`, untracked) briefly held `server/src/room.ts:340` at `this.sessionOrigin = SessionOrigin.SERVER_MATCHMAKER; void options.sessionOrigin;` and `server/src/net.ts` and `server/src/entitlementGuard.ts` dirty. All three were reverted before this document was finished and every hash above is the committed value. **Nothing half-written was found in anything this design depends on.**

**One claim I could not verify and am recording as unverified:** the derived per-box Hetzner price of ~$55/month comes from `docs/INFRASTRUCTURE.md:283` ($220 for four boxes across two regions at 1k CCU) divided by four **[E]**; the document gives no per-box figure.