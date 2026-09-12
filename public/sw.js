/* Service worker de Haul: la app abre al instante y sigue navegable sin datos. */

const VERSION = 'haul-v2.0.0';
const SHELL = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // La API siempre va a la red: los datos deben estar frescos.
  if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/img')) return;

  // Imágenes de producto: primero caché, es lo que más pesa.
  if (url.pathname.startsWith('/api/img')) {
    event.respondWith(
      caches.open(VERSION + '-img').then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      }).catch(() => fetch(request))
    );
    return;
  }

  // Navegación: red primero, con la app cacheada como red de seguridad.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/').then((r) => r || Response.error()))
    );
    return;
  }

  // Estáticos: caché primero y refresco en segundo plano.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request).then((res) => {
        if (res.ok) caches.open(VERSION).then((c) => c.put(request, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || network;
    })
  );
});
