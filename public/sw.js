/* Service worker de Haul: la app abre al instante y sigue navegable sin datos. */

const VERSION = 'haul-v4.0.0';
const SHARE_CACHE = 'haul-share';
const SHELL = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // sin pasar por la caché HTTP: una versión nueva tiene que traer el código nuevo
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // conserva el caché de imágenes de esta versión y lo que se acaba de compartir
      .then((keys) => Promise.all(
        keys.filter((k) => !k.startsWith(VERSION) && k !== SHARE_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  /**
   * "Compartir con Haul" desde otra app. Android manda aquí un POST con lo
   * que se comparte; puede ser una imagen (Zalando comparte el producto como
   * foto), un enlace o texto suelto. Se guarda y se redirige a la app, que lo
   * recoge al arrancar.
   */
  if (request.method === 'POST' && url.pathname === '/share') {
    event.respondWith((async () => {
      try {
        const form = await request.formData();
        const file = form.get('image') || form.get('file');
        const text = ['title', 'text', 'url'].map((k) => form.get(k)).filter(Boolean).join(' ');
        const cache = await caches.open(SHARE_CACHE);
        if (file && file.size) {
          await cache.put('/__shared-image', new Response(file, {
            headers: { 'content-type': file.type || 'image/jpeg' },
          }));
        }
        if (text) await cache.put('/__shared-text', new Response(text));
      } catch { /* si algo falla, al menos abrimos la app */ }
      return Response.redirect('/?compartido=1', 303);
    })());
    return;
  }

  if (request.method !== 'GET') return;
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

/* ------------------------------------------------ avisos de bajada (v4) */

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { title: 'Haul', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Haul', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'haul',
    renotify: !!data.tag,
    data: { url: data.url || '/' },
  }));
});

// Al tocar el aviso se abre la pieza: si Haul ya está abierta, en esa misma
// pestaña; si no, en una nueva.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => c.url.startsWith(self.location.origin));
      if (open) {
        open.postMessage({ type: 'open', url });
        return open.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
