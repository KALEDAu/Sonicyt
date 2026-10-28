/* ========================================
   Sonicyt — Service Worker (PWA)
   Limpieza forzada de caché al activar
   ======================================== */

// Nuevo nombre de caché: versión 2 (forza descarga de archivos nuevos)
const CACHE_NAME = 'sonicyt-v2';
const CACHE_ANTERIOR = 'mimusica-v1';

const STATIC_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
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
    // 1. Borrar caché anterior si existe
    caches.delete(CACHE_ANTERIOR).then(() => {
      // 2. Listar todos los caches y borrar los que no sean el actual
      return caches.keys().then((keys) => {
        return Promise.all(
          keys.filter((key) => key !== CACHE_NAME && key !== CACHE_ANTERIOR)
            .map((key) => caches.delete(key))
        );
      });
    }).then(() => {
      // 3. Reclamar control de la página inmediatamente
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Estrategia Cache First para assets estáticos del mismo origen
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
    // Peticiones externas (Invidious, imágenes, audio, proxy CORS): siempre red
    event.respondWith(fetch(request));
  }
});
