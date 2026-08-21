/*
 * DOOMCRAFT — service worker.
 *
 * ONE RULE, and it is enforced from both sides:
 *
 *   > This worker NEVER calls `skipWaiting()` on its own.
 *
 * It activates only when the page posts `DC_SKIP_WAITING`, and the page only
 * posts that when `game.playing === false`. A deploy must not swap the bundle
 * under a player mid-match. See `client/src/boot/updates.ts` for the page half
 * and `docs/PATCHING.md` for why. `client/src/boot/updates.test.ts` reads this
 * file and fails if an unconditional `skipWaiting()` ever appears in it.
 *
 * WHAT IS CACHED, AND THE ONE THING THAT MUST NOT BE
 *
 *   /a/*          hashed, immutable  -> cache-first, forever. Safe by
 *                 construction: the name changes when the bytes change.
 *   /c/*          hashed content     -> cache-first, same reasoning.
 *   /characters/* model assets       -> stale-while-revalidate; they are big,
 *                 rarely change, and a week-old rig is not a correctness bug.
 *   the document  -> NETWORK ONLY. Never cached, not even as a fallback.
 *
 * That last line is not caution, it is a hard requirement. `server/src/index.ts`
 * mints a fresh CSP nonce per response and stamps it into the HTML as it is
 * served, so the nonce in the markup and the nonce in the header are two halves
 * of one response. Serve a cached document against a fresh header and every
 * inline style and the boot script are blocked — the game boots to a blank
 * page with a wall of CSP violations. A cached HTML document is also how a
 * client gets pinned to an old bundle forever, because index.html is the
 * pointer to the hashed assets. So: never.
 *
 * There is no precache manifest. The worker learns the app by watching it load,
 * which means a first visit is not offline-capable and a returning visitor is.
 * The alternative — generating a manifest at build time — buys first-visit
 * offline in exchange for a build step that can ship a stale list, and offline
 * on a visit that by definition needed the network anyway.
 */

/* eslint-disable no-restricted-globals */

/**
 * Bump ONLY when the caching policy itself changes shape. It is not the build
 * id and it is not the content version: the asset URLs are already hashed, so
 * a new build needs no new cache. Bumping this throws away every asset every
 * player has, so it is a real cost and a deliberate act.
 */
const CACHE_VERSION = 'dc-v1';
const ASSET_CACHE = `${CACHE_VERSION}-assets`;

/** Same string as `SKIP_WAITING_MESSAGE` in client/src/boot/updates.ts. */
const SKIP_WAITING_MESSAGE = 'DC_SKIP_WAITING';

/** Paths whose contents are immutable because their names carry a hash. */
const IMMUTABLE_PREFIXES = ['/a/', '/c/'];
/** Paths worth caching but not immutable. */
const REVALIDATE_PREFIXES = ['/characters/'];

self.addEventListener('install', () => {
  /*
   * Deliberately empty, and deliberately WITHOUT `self.skipWaiting()`.
   *
   * This is the line that every service-worker tutorial tells you to add and
   * that this project must never have. With it, a deploy activates the instant
   * it installs — under whoever is playing at the time.
   */
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop caches from a previous policy version. Same-version caches stay:
    // every asset in them is content-hashed and still correct.
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith('dc-') && !n.startsWith(CACHE_VERSION)).map((n) => caches.delete(n)),
    );
    // Take over the pages that asked for this activation, so `controllerchange`
    // fires and the page can do its single reload.
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === SKIP_WAITING_MESSAGE) {
    /*
     * The ONLY skipWaiting in this file. It runs because the page — the only
     * thing that knows whether a match is in progress — said it was safe.
     */
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // Another origin, a WebSocket upgrade, or the API: none of ours to cache.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/rtc') return;

  // The document. Network only — see the header comment about the CSP nonce.
  // No cache read, no cache write, and no offline fallback: a stale shell that
  // points at deleted asset hashes is worse than an honest browser error page.
  if (req.mode === 'navigate' || req.destination === 'document') return;

  if (IMMUTABLE_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (REVALIDATE_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    event.respondWith(staleWhileRevalidate(req));
  }
});

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // Only a clean same-origin 200 is worth keeping. An opaque or partial
  // response cached here would be served forever under an immutable policy.
  if (res.ok && res.status === 200 && res.type === 'basic') {
    cache.put(request, res.clone()).catch(() => { /* quota; serve it anyway */ });
  }
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(request);
  const network = fetch(request).then((res) => {
    if (res.ok && res.status === 200 && res.type === 'basic') {
      cache.put(request, res.clone()).catch(() => { /* quota */ });
    }
    return res;
  }).catch(() => null);
  if (hit) return hit;
  const res = await network;
  if (res) return res;
  return new Response('', { status: 504, statusText: 'offline' });
}
