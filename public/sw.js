const CACHE_NAME = 'vcm-cache-v10';
const urlsToCache = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names => 
      Promise.all(names.map(name => name !== CACHE_NAME ? caches.delete(name) : null))
    )
  );
  return self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (!event.request.url.startsWith(self.location.origin) ||
      event.request.url.includes('/api/') ||
      event.request.url.includes('livekit.cloud')) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then(r => r || caches.match('/')))
  );
});
