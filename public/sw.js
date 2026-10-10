/* Service worker de Haul: la app abre al instante y sigue navegable sin datos. */

const VERSION = 'haul-v3.4.0';
const SHARE_CACHE = 'haul-share';
const SHELL = ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
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
