const CACHE = 'wende-directory-v7';
const assets = ['/offline.html', '/style.css', '/offline.js', '/icons.svg', '/manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(async cache => {
    await cache.addAll(assets);
    const response = await fetch('/api/hymns');
    if (!response.ok) throw new Error('Unable to save the hymn directory');
    await cache.put('/api/hymns', response);
    await self.skipWaiting();
  }));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('wende-directory-') && key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname === '/api/hymns') {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put('/api/hymns', response.clone());
        }
        return response;
      } catch (error) {
        const cached = await caches.match('/api/hymns');
        if (cached) return cached;
        throw error;
      }
    })());
  } else if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
  } else if (assets.includes(url.pathname)) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
  }
});
