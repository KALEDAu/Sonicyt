/* ========================================
   Sonicyt — Service Worker (PWA)
   Caché v7-hls: audio completo SoundCloud (HLS) + Audius
   ======================================== */

const CACHE_NAME = 'sonicyt-v7-hls';
const CACHE_ANTERIOR = 'sonicyt-v7-soundcloud';

const STATIC_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './extensions/itunes-bridge.js',
  './extensions/youtube-bridge.js',
  './manifest.json',
  './sw.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.delete(CACHE_ANTERIOR).then(() => {
      return caches.keys().then((keys) => {
        return Promise.all(
          keys.filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        );
      });
    }).then(() => {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Cascarón y extensiones (mismo origen): cache-first
  if (url.origin === location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        });
      })
    );
  } else {
    // APIs externas (iTunes, Invidious, audio): siempre red, sin caché
    event.respondWith(fetch(request));
  }
});
