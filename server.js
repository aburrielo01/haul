'use strict';
/**
 * Haul — servidor
 *
 * API REST + servidor de la PWA. Las listas viven en la base de datos, así que
 * un enlace compartido funciona en cualquier dispositivo y sin cuenta.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('./lib/db');
const extract = require('./lib/extract');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' })); // las capturas viajan en base64

/* ------------------------------------------------------------ seguridad */

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(), microphone=()');
  next();
});

/** Limitador de peticiones en memoria (ventana deslizante por IP). */
function rateLimit({ windowMs, max, key = 'default' }) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => t > cutoff);
      if (kept.length) hits.set(k, kept); else hits.delete(k);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const id = key + ':' + (req.ip || 'anon');
    const nowTs = Date.now();
    const arr = (hits.get(id) || []).filter((t) => t > nowTs - windowMs);
    if (arr.length >= max) {
      res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
      return res.status(429).json({ ok: false, message: 'Demasiadas peticiones seguidas. Espera unos segundos.' });
    }
    arr.push(nowTs);
    hits.set(id, arr);
    next();
  };
}

const limitExtract = rateLimit({ windowMs: 60_000, max: 20, key: 'extract' });
const limitWrite = rateLimit({ windowMs: 60_000, max: 90, key: 'write' });

/* -------------------------------------------------------------- helpers */

const fail = (res, code, message) => res.status(code).json({ ok: false, message });

function publicList(list, items, role) {
  return {
    slug: list.slug,
    name: list.name,
    emoji: list.emoji,
    theme: list.theme,
    visibility: list.visibility,
    allowContrib: !!Number(list.allow_contrib),
    ownerName: list.owner_name,
    views: Number(list.views || 0),
    createdAt: Number(list.created_at),
    updatedAt: Number(list.updated_at),
    role,
    items: (items || []).map(publicItem),
  };
}

function publicItem(it) {
  return {
    id: it.id,
    title: it.title,
    url: it.url,
    image: it.image,
    priceText: it.price_text,
    priceValue: it.price_value === null || it.price_value === undefined ? null : Number(it.price_value),
    currency: it.currency,
    shop: it.shop,
    note: it.note,
    source: it.source,
    bought: !!Number(it.bought),
    addedBy: it.added_by,
    createdAt: Number(it.created_at),
  };
}

function tokenOf(req) {
  return String(req.get('x-haul-token') || req.query.t || '').trim();
}

/** owner → control total · collab → puede añadir · viewer → solo lectura */
function roleFor(list, token) {
  if (token && token === list.owner_token) return 'owner';
  if (token && token === list.collab_token) return 'collab';
  return 'viewer';
}

async function loadList(req, res) {
  const list = await db.getListBySlug(req.params.slug);
  if (!list) { fail(res, 404, 'Esa lista no existe o se ha borrado'); return null; }
  return list;
}

/* ----------------------------------------------------------------- API */

app.get('/api/health', async (_req, res) => res.json({ ok: true, time: Date.now() }));

// Crear lista
app.post('/api/lists', limitWrite, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return fail(res, 400, 'Ponle un nombre a la lista');
    const list = await db.createList({
      name,
      emoji: String(req.body?.emoji || '🛍️').slice(0, 8),
      theme: String(req.body?.theme || 'pink').slice(0, 16),
      visibility: req.body?.visibility === 'public' ? 'public' : 'private',
      ownerName: String(req.body?.ownerName || '').trim(),
    });
    res.status(201).json({
      ok: true,
      ownerToken: list.owner_token,
      collabToken: list.collab_token,
      list: publicList(list, [], 'owner'),
    });
  } catch (err) {
    console.error('createList', err);
    fail(res, 500, 'No se ha podido crear la lista');
  }
});

// Leer lista
app.get('/api/lists/:slug', async (req, res) => {
  try {
    const list = await loadList(req, res);
    if (!list) return;
    const role = roleFor(list, tokenOf(req));
    if (role === 'viewer' && list.visibility !== 'public') {
      return fail(res, 403, 'Esta lista es privada');
    }
    if (role === 'viewer') db.bumpViews(list.slug).catch(() => {});
    const items = await db.listItems(list.id);
    const payload = publicList(list, items, role);
    if (role === 'owner') payload.collabToken = list.collab_token;
    res.json({ ok: true, list: payload });
  } catch (err) {
    console.error('getList', err);
    fail(res, 500, 'No se ha podido cargar la lista');
  }
});

// Editar lista
app.patch('/api/lists/:slug', limitWrite, async (req, res) => {
  try {
    const list = await loadList(req, res);
    if (!list) return;
    if (roleFor(list, tokenOf(req)) !== 'owner') return fail(res, 403, 'Solo quien creó la lista puede editarla');
    const patch = {};
    if (req.body.name !== undefined) patch.name = String(req.body.name).trim().slice(0, 60) || list.name;
    if (req.body.emoji !== undefined) patch.emoji = String(req.body.emoji).slice(0, 8);
    if (req.body.theme !== undefined) patch.theme = String(req.body.theme).slice(0, 16);
    if (req.body.visibility !== undefined) patch.visibility = req.body.visibility === 'public' ? 'public' : 'private';
    if (req.body.allowContrib !== undefined) patch.allow_contrib = req.body.allowContrib ? 1 : 0;
    if (req.body.ownerName !== undefined) patch.owner_name = String(req.body.ownerName).slice(0, 40);
    const updated = await db.updateList(list.slug, patch);
    const items = await db.listItems(list.id);
    const payload = publicList(updated, items, 'owner');
    payload.collabToken = list.collab_token;
    res.json({ ok: true, list: payload });
  } catch (err) {
    console.error('patchList', err);
    fail(res, 500, 'No se ha podido guardar el cambio');
  }
});

// Borrar lista
app.delete('/api/lists/:slug', limitWrite, async (req, res) => {
  try {
    const list = await loadList(req, res);
    if (!list) return;
    if (roleFor(list, tokenOf(req)) !== 'owner') return fail(res, 403, 'Solo quien creó la lista puede borrarla');
    await db.deleteList(list.slug);
    res.json({ ok: true });
  } catch (err) {
    console.error('deleteList', err);
    fail(res, 500, 'No se ha podido borrar la lista');
  }
});

// Añadir producto
app.post('/api/lists/:slug/items', limitWrite, async (req, res) => {
  try {
    const list = await loadList(req, res);
    if (!list) return;
    const role = roleFor(list, tokenOf(req));
    const canContribute =
      role === 'owner' ||
      (role === 'collab' && Number(list.allow_contrib) === 1) ||
      (role === 'viewer' && list.visibility === 'public' && Number(list.allow_contrib) === 1);
    if (!canContribute) return fail(res, 403, 'Esta lista no admite aportaciones');

    const body = req.body || {};
    if (!String(body.title || '').trim()) return fail(res, 400, 'El producto necesita un nombre');
    const item = await db.addItem(list.id, {
      title: body.title,
      url: body.url ? extract.cleanUrl(String(body.url)) : '',
      image: body.image,
      priceText: body.priceText,
      priceValue: Number(body.priceValue),
      currency: body.currency,
      shop: body.shop,
      note: body.note,
      source: body.source,
      addedBy: role === 'owner' ? '' : String(body.addedBy || '').trim(),
    });
    res.status(201).json({ ok: true, item: publicItem(item) });
  } catch (err) {
    console.error('addItem', err);
    fail(res, 500, 'No se ha podido guardar el producto');
  }
});

// Editar producto
app.patch('/api/lists/:slug/items/:id', limitWrite, async (req, res) => {
  try {
    const list = await loadList(req, res);
    if (!list) return;
    if (roleFor(list, tokenOf(req)) !== 'owner') return fail(res, 403, 'Solo quien creó la lista puede editar sus productos');
    const patch = {};
    const b = req.body || {};
    if (b.title !== undefined) patch.title = String(b.title).slice(0, 180);
    if (b.note !== undefined) patch.note = String(b.note).slice(0, 280);
    if (b.shop !== undefined) patch.shop = String(b.shop).slice(0, 60);
    if (b.image !== undefined) patch.image = String(b.image).slice(0, 400_000);
    if (b.bought !== undefined) patch.bought = b.bought ? 1 : 0;
    if (b.priceText !== undefined) {
      const parsed = extract.parsePrice(b.priceText);
      patch.priceText = parsed ? parsed.text : String(b.priceText).slice(0, 40);
      patch.priceValue = parsed ? parsed.value : null;
    }
    const item = await db.updateItem(list.id, req.params.id, patch);
    if (!item) return fail(res, 404, 'Producto no encontrado');
    res.json({ ok: true, item: publicItem(item) });
  } catch (err) {
    console.error('patchItem', err);
    fail(res, 500, 'No se ha podido guardar el cambio');
  }
});

// Borrar producto
app.delete('/api/lists/:slug/items/:id', limitWrite, async (req, res) => {
  try {
    const list = await loadList(req, res);
    if (!list) return;
    if (roleFor(list, tokenOf(req)) !== 'owner') return fail(res, 403, 'Solo quien creó la lista puede borrar productos');
    await db.deleteItem(list.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('deleteItem', err);
    fail(res, 500, 'No se ha podido borrar el producto');
  }
});

// Extraer producto desde una URL
app.post('/api/extract', limitExtract, async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url) return fail(res, 400, 'Falta el enlace');
  try {
    const key = 'url:' + extract.cleanUrl(url);
    const cached = await db.cacheGet(key);
    if (cached) return res.json({ ...cached, cached: true });
    const data = await extract.extractFromUrl(url);
    await db.cacheSet(key, data, 1000 * 60 * 60 * 6).catch(() => {});
    res.json(data);
  } catch (err) {
    const blocked = err.code === 'BLOCKED';
    console.error('extract', url, err.message);
    res.status(blocked ? 422 : 502).json({
      ok: false,
      code: err.code || 'EXTRACT_FAILED',
      message: err.message || 'No hemos podido leer esa tienda. Añádelo a mano y listo.',
    });
  }
});

// Buscar por código de barras / QR
app.get('/api/barcode/:code', limitExtract, async (req, res) => {
  const code = String(req.params.code || '');
  try {
    const key = 'ean:' + code;
    const cached = await db.cacheGet(key);
    if (cached) return res.json({ ...cached, cached: true });
    const data = await extract.extractFromBarcode(code);
    await db.cacheSet(key, data, 1000 * 60 * 60 * 24 * 14).catch(() => {});
    res.json(data);
  } catch (err) {
    res.status(err.code === 'NOT_FOUND' ? 404 : 502).json({
      ok: false,
      code: err.code || 'BARCODE_FAILED',
      barcode: err.barcode || code.replace(/\D/g, ''),
      message: err.message || 'No hemos encontrado ese código',
    });
  }
});

/**
 * Proxy de imágenes: muchas tiendas bloquean el hotlinking desde otro dominio.
 * Pasarlas por aquí hace que las fotos se vean siempre y evita fugas de Referer.
 */
app.get('/api/img', async (req, res) => {
  const raw = String(req.query.u || '');
  try {
    await extract.assertPublicUrl(raw);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    const upstream = await fetch(raw, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0', accept: 'image/*,*/*;q=0.8', referer: new URL(raw).origin + '/' },
    }).finally(() => clearTimeout(timer));
    const type = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !type.startsWith('image/')) return res.status(404).end();
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > 6_000_000) return res.status(413).end();
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.end(buf);
  } catch {
    res.status(400).end();
  }
});

/* ----------------------------------------------------- páginas y estáticos */

app.use(express.static(PUBLIC_DIR, {
  maxAge: '7d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

const esc = (s) => String(s || '').replace(/[&<>"']/g, (m) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
));

/**
 * La página de una lista compartida se sirve con sus propias meta etiquetas,
 * para que al pegar el enlace en WhatsApp o Instagram salga una tarjeta bonita.
 */
app.get('/l/:slug', async (req, res, next) => {
  try {
    const list = await db.getListBySlug(req.params.slug);
    if (!list || list.visibility !== 'public') return next();
    const items = await db.listItems(list.id);
    const count = items.length;
    const cover = items.find((i) => i.image)?.image || '';
    const origin = `${req.protocol}://${req.get('host')}`;
    const title = `${list.emoji} ${list.name} · Haul`;
    const desc = count
      ? `${count} producto${count === 1 ? '' : 's'} guardado${count === 1 ? '' : 's'}${list.owner_name ? ` por ${list.owner_name}` : ''}.`
      : 'Una lista recién creada en Haul.';
    const image = cover ? `${origin}/api/img?u=${encodeURIComponent(cover)}` : `${origin}/icons/og.png`;

    let html = await fs.promises.readFile(INDEX_FILE, 'utf8');
    html = html.replace(
      '<!--META-->',
      [
        `<meta property="og:type" content="website">`,
        `<meta property="og:title" content="${esc(title)}">`,
        `<meta property="og:description" content="${esc(desc)}">`,
        `<meta property="og:image" content="${esc(image)}">`,
        `<meta property="og:url" content="${esc(origin)}/l/${esc(list.slug)}">`,
        `<meta name="twitter:card" content="summary_large_image">`,
        `<meta name="twitter:title" content="${esc(title)}">`,
        `<meta name="twitter:description" content="${esc(desc)}">`,
        `<meta name="twitter:image" content="${esc(image)}">`,
      ].join('\n')
    );
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  } catch (err) {
    next(err);
  }
});

app.get('*', (_req, res) => res.sendFile(INDEX_FILE));

/* -------------------------------------------------------------- arranque */

db.init()
  .then((info) => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Haul escuchando en http://0.0.0.0:${PORT} · base de datos: ${info.driver}`);
    });
  })
  .catch((err) => {
    console.error('No se ha podido iniciar la base de datos', err);
    process.exit(1);
  });

async function shutdown() {
  await extract.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
