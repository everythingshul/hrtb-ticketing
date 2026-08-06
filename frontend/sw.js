// Mamudem - Service Worker
// Strategy: Network-first for HTML/API, cache-first for static assets
// This means: the app always tries to load fresh content from server first.
// If offline, falls back to cache. App updates automatically when server changes.

const CACHE = 'eshul-v1';
const STATIC = [
  '/css/style.css',
  '/js/app.js',
  '/logo.png',
  '/favicon.ico',
];

// Install: cache static assets
self.addEventListener('install', e => {
  self.skipWaiting(); // activate immediately
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC).catch(() => {}))
  );
});

// Activate: clear old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: network-first for HTML and API, cache-first for static
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always go to network for API calls - never cache
  if (url.pathname.startsWith('/api/')) return;

  // Network-first for HTML pages (ensures updates are picked up)
  if (e.request.headers.get('accept')?.includes('text/html') || url.pathname.endsWith('.html') || url.pathname === '/') {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          // Cache the fresh response
          const clone = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return r;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for CSS, JS, images (with network fallback)
  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(r => {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return r;
      });
      return cached || network;
    })
  );
});
