# Deploying Doomcraft

## What ships today, and why it is enough

**The whole game runs client-side.** `client/src/game/game.ts:446` calls `createLocalServer()`
unconditionally, and that worker runs the full authoritative room and simulation. So all four modes —
Quest, Builder, Horde and Deathmatch against bots — are **completely playable from static hosting
with no server at all, at $0**.

Production bundle: **1.9 MB**, time-to-interactive ~305 ms (voxiom.io: 12.6 MB, 3,161 ms).

Online multiplayer is the upgrade that follows, and it is the first real test of the patch system.

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

## What is NOT deployed by this

- **Online multiplayer.** No client connects to a server yet.
- **Persistence beyond the device.** Saves are local; there is no account backend deployed.
- **Ads, billing, sponsors, economy.** Specced, not built.

## Next: the upgrade path

Per `docs/INFRASTRUCTURE.md`, patching uses three independent version axes — `PROTOCOL_VERSION`
(gates a supported window), `CONTENT_VERSION` (matches per-room), `BUILD_ID` (never gates) — with
**rooms as the deploy unit** so an in-progress match is never dropped. The static client needs the
matching half of that: a service worker whose one rule is **never activate while
`game.playing === true`**, so a deploy cannot swap the bundle under a player mid-match.
