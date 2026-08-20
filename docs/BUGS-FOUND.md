# Real bugs found while designing the sponsor system

Both verified by grep against the live source, both unrelated to advertising, both affecting every
player today. Cannot be fixed while the modes workflow holds `main.ts` — apply immediately after.

## 1. Backgrounding the tab for 15 s disconnects you from your match — HIGH

`client/src/main.ts:943` runs the network pump inside `requestAnimationFrame`. Browsers throttle
rAF to ~1 Hz in a background tab and stop it entirely in some conditions. The server
(`server/src/net.ts:340`) drops any client whose `lastRecvMs` exceeds
`CLIENT_TIMEOUT_MS = 15000` (`shared/src/constants.ts:146`). There is **no `setInterval` fallback
anywhere in the net path** — confirmed by grep.

So: alt-tab, take a call, or switch apps for fifteen seconds and you are kicked out of your game.
This is a bad bug on its own, and it is a hard blocker for any click-out ad flow.

**Fix:** drive the net pump from a `setInterval` (or a Worker timer, which browsers throttle less)
independent of rAF, and send a keepalive on `visibilitychange`.

## 2. No Content-Security-Policy anywhere — HIGH

`server/src/index.ts` sets no CSP header; grep finds no `Content-Security-Policy`, no helmet, no
`contentSecurityPolicy` in the whole server. Today that is ordinary hygiene debt. The moment we
serve third-party sponsor creative it becomes the control that stops a malicious or compromised
creative from executing in the game's origin.

**Fix:** a real CSP before any third-party content ships, with the creative sandbox as a separate
origin or a sandboxed iframe.
