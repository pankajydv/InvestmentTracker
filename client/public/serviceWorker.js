/**
 * Service Worker for Investment Tracker PWA
 *
 * Strategy (conservative, correctness-first):
 *  - Non-GET requests: never touched (mutations always hit the network).
 *  - API GETs: network-first with a bounded cache fallback (offline only). The
 *    app already has a version-gated in-app cache for speed, so the SW does not
 *    serve stale API data while online.
 *  - Navigations/HTML: network-first so new deploys load immediately; cache
 *    fallback only when offline.
 *  - Hashed static assets: cache-first (immutable), runtime-filled.
 *  - Cache names are versioned; activate purges any other cache so deploys are
 *    self-cleaning. Bump SW_VERSION on release to force a clean slate.
 */

// Stamped at build time (see client/scripts/stamp-sw.mjs) with a per-deploy id so
// each release gets fresh cache names and the activate handler purges old caches.
const SW_VERSION = '__SW_VERSION__';
const STATIC_CACHE = `investtrack-static-${SW_VERSION}`;
const API_CACHE = `investtrack-api-${SW_VERSION}`;
const API_CACHE_MAX_ENTRIES = 40;
const PRECACHE_URLS = ['/', '/index.html', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name !== STATIC_CACHE && name !== API_CACHE)
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

async function trimCache(cacheName, maxEntries) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length <= maxEntries) return;
    for (let i = 0; i < keys.length - maxEntries; i += 1) {
      await cache.delete(keys[i]);
    }
  } catch (_e) {
    // best effort
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never cache or interfere with mutations.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cache validation must always reach the server. Falling back to an old
  // version response could incorrectly mark stale local dashboard data valid.
  if (url.pathname === '/api/dashboard/version') {
    event.respondWith(fetch(request));
    return;
  }

  // API GET: network-first, bounded cache fallback for offline.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(API_CACHE)
            .then((cache) => cache.put(request, clone))
            .then(() => trimCache(API_CACHE, API_CACHE_MAX_ENTRIES))
            .catch(() => {});
        }
        return response;
      } catch (_e) {
        const cached = await caches.match(request);
        if (cached) return cached;
        return new Response(JSON.stringify({ error: 'Offline' }), {
          status: 503,
          statusText: 'Service Unavailable',
          headers: new Headers({ 'Content-Type': 'application/json' }),
        });
      }
    })());
    return;
  }

  // Navigations/HTML: network-first so new deploys load; cache fallback offline.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (_e) {
        const cache = await caches.open(STATIC_CACHE);
        return (await cache.match(request)) || (await cache.match('/index.html')) || Response.error();
      }
    })());
    return;
  }

  // Static assets: cache-first (hashed/immutable), runtime-filled.
  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response && response.status === 200 && (response.type === 'basic' || response.type === 'default')) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch (_e) {
      return Response.error();
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
