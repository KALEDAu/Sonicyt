/* ========================================
   Sonicyt — Service Worker (PWA)
   Caché v4: interfaz Apple Music unificada
   ======================================== */

const CACHE_NAME = 'sonicyt-v4';
const CACHE_ANTERIOR = 'sonicyt-v3';
const CACHE_MIUSICA = 'mimusica-v1';

const STATIC_ASSETS = [
  './',
  './index.html',
  './css/style.css',
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
      return caches.delete(CACHE_MIUSICA);
    }).then(() => {
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
    event.respondWith(fetch(request));
  }
});
