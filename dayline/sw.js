// Dayline service worker: makes the app installable and lets it open offline.
// Network first, so a new version is picked up as soon as it is online; cached copy when offline.
// Speech models are cached separately by the speech library and are not handled here.
const CACHE = 'dayline-shell-v1';
const SHELL = ['./', 'index.html', 'app.js', 'capture.js', 'store.js', 'ai.js', 'manifest.webmanifest', 'icon-192.png', 'vendor/anthropic-sdk.mjs'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.includes('/dayline/')) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || caches.match('index.html')))
  );
});
