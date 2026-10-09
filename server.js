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
const bench = require('./lib/bench');

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

// `unlocker` dice si el desbloqueador está configurado, sin revelar la clave
app.get('/api/health', async (_req, res) => res.json({
  ok: true,
  time: Date.now(),
  uptime: Math.round(process.uptime()),
  unlocker: extract.unlockerEnabled(),
}));

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
    // El detalle técnico se queda en los logs: al usuario nunca le sirve de nada
    // y una traza de error en pantalla da sensación de app rota.
    console.error('extract', url, err && err.message);
    const blocked = err && err.code === 'BLOCKED';
    res.status(blocked ? 422 : 502).json({
      ok: false,
      code: blocked ? 'BLOCKED' : 'EXTRACT_FAILED',
      message: blocked
        ? 'Esta tienda no deja que otras apps lean sus fichas.'
        : 'No hemos podido leer esta página.',
      // lo poco que se puede deducir del propio enlace, para no partir de cero
      fallback: (err && err.fallback) || {
        url: extract.cleanUrl(url),
        title: extract.titleFromSlug(url),
        shop: extract.shopFromUrl(url),
      },
    });
  }
});

/**
 * Diagnóstico de una URL: qué ve cada intento del lector. Protegido con
 * DIAG_TOKEN para que nadie gaste créditos del desbloqueador por deporte.
 *   /api/diagnose?url=https://...&key=TU_DIAG_TOKEN
 */
app.get('/api/diagnose', limitExtract, async (req, res) => {
  const token = process.env.DIAG_TOKEN || '';
  if (!token) return fail(res, 404, 'Diagnóstico desactivado');
  const key = String(req.get('x-diag-token') || req.query.key || '');
  if (key !== token) return fail(res, 403, 'Clave de diagnóstico incorrecta');
  const url = String(req.query.url || '').trim();
  if (!url) return fail(res, 400, 'Falta el parámetro url');
  try {
    res.json({ ok: true, ...(await extract.diagnose(url)) });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
});

/* ---------------------------------------------------------- banco de pruebas */

function diagAuth(req, res) {
  const token = process.env.DIAG_TOKEN || '';
  if (!token) { fail(res, 404, 'Diagnóstico desactivado'); return false; }
  const key = String(req.get('x-diag-token') || req.query.key || '');
  if (key !== token) { fail(res, 403, 'Clave de diagnóstico incorrecta'); return false; }
  return true;
}

// Lanza el banco: /api/bench/run?key=…[&shop=Zara][&limit=10][&ids=E001,E002]
app.get('/api/bench/run', async (req, res) => {
  if (!diagAuth(req, res)) return;
  const filter = {};
  if (req.query.shop) filter.shop = String(req.query.shop);
  if (req.query.limit) filter.limit = Math.max(1, Number(req.query.limit) || 0);
  if (req.query.ids) filter.ids = String(req.query.ids).split(',').map((x) => x.trim()).filter(Boolean);
  try {
    const out = await bench.run({ db, extract: extract.extractFromUrl, filter, fresh: req.query.fresh === '1' });
    res.json({ ok: true, ...out });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// Informe: /api/bench/report?key=…  (añade &html=1 para verlo en el navegador)
app.get('/api/bench/report', async (req, res) => {
  if (!diagAuth(req, res)) return;
  const state = await bench.report(db);
  if (!req.query.html) return res.json({ ok: true, ...state });
  res.type('html').send(renderBenchHtml(state));
});

function renderBenchHtml(state) {
  const s = state.summary || state.partial;
  const pct = (n) => `${n}%`;
  const rows = (state.rows || []).map((r) => {
    const g = r.grade;
    const cell = (v) => v ? '<td class="ok">✓</td>' : '<td class="ko">✗</td>';
    return `<tr>
      <td>${esc(r.id)}</td><td>${esc(r.shop)}</td>
      ${cell(g.title)}${cell(g.price)}${cell(g.image)}
      <td>${esc(g.mode || '')}</td>
      <td class="small">${esc(g.got ? g.got.title : (g.error || ''))}</td>
      <td class="small">${esc(g.got ? g.got.priceText : '')}${g.priceDiff ? ` <i>(±${g.priceDiff})</i>` : ''}</td>
      <td class="small">${esc(r.expected.title)} · ${esc(r.expected.price)}</td>
      <td class="small">${Math.round(r.ms / 100) / 10}s</td>
    </tr>`;
  }).join('');
  const shops = s ? s.byShop.map((x) => `<tr><td>${esc(x.shop)}</td><td>${x.ok}/${x.total}</td></tr>`).join('') : '';
  return `<!doctype html><meta charset="utf-8"><title>Banco de pruebas · Haul</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;margin:24px;color:#111113;background:#fbfbfd}
h1{font-size:28px;letter-spacing:-.03em;margin:0 0 4px}.sub{color:#6b6b78;margin-bottom:20px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:16px 0 24px}
.kpi{border:1px solid #e2e1e8;background:#fff;padding:12px}.kpi b{display:block;font-size:26px;letter-spacing:-.03em}.kpi span{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#8b8f9a}
table{border-collapse:collapse;width:100%;font-size:13px;background:#fff}th,td{border-bottom:1px solid #e2e1e8;padding:7px 9px;text-align:left;vertical-align:top}
th{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#8b8f9a}.ok{color:#1a8f3a;font-weight:700}.ko{color:#d6362a;font-weight:700}.small{font-size:12px;color:#4a4f5a;max-width:260px}
.two{display:grid;grid-template-columns:1fr 3fr;gap:24px;align-items:start}@media(max-width:800px){.two{grid-template-columns:1fr}}
</style>
<h1>Banco de pruebas</h1>
<div class="sub">Estado: <b>${esc(state.status)}</b> · ${state.done || 0}/${state.total || 0} enlaces${state.startedAt ? ' · ' + new Date(state.startedAt).toLocaleString('es-ES') : ''}</div>
${s ? `<div class="kpis">
  <div class="kpi"><b>${pct(s.pctOk)}</b><span>captura completa</span></div>
  <div class="kpi"><b>${pct(s.pctTitle)}</b><span>nombre</span></div>
  <div class="kpi"><b>${pct(s.pctPrice)}</b><span>precio</span></div>
  <div class="kpi"><b>${pct(s.pctImage)}</b><span>foto</span></div>
  <div class="kpi"><b>${s.failed}</b><span>errores</span></div>
</div>` : '<p>Todavía no hay resultados.</p>'}
<div class="two">
  <div><h3>Por tienda</h3><table><tr><th>tienda</th><th>ok</th></tr>${shops}</table></div>
  <div><h3>Detalle</h3><table><tr><th>id</th><th>tienda</th><th>nombre</th><th>precio</th><th>foto</th><th>vía</th><th>leído</th><th>precio leído</th><th>esperado</th><th>t</th></tr>${rows}</table></div>
</div>`;
}

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
 * Una página compartida se sirve con sus propias meta etiquetas, para que al
 * pegar el enlace en WhatsApp o Instagram salga una tarjeta con su foto.
 */
async function renderIndexWithMeta({ title, desc, image, url }) {
  const html = await fs.promises.readFile(INDEX_FILE, 'utf8');
  return html.replace('<!--META-->', [
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(desc)}">`,
    `<meta name="twitter:image" content="${esc(image)}">`,
  ].join('\n'));
}

/** Enlace de una pieza suelta: su propia tarjeta de previsualización. */
app.get('/l/:slug/p/:id', async (req, res, next) => {
  try {
    const list = await db.getListBySlug(req.params.slug);
    if (!list || list.visibility !== 'public') return next();
    const items = await db.listItems(list.id);
    const item = items.find((i) => i.id === req.params.id);
    if (!item) return next();
    const origin = `${req.protocol}://${req.get('host')}`;
    const desc = [item.price_text, item.shop].filter(Boolean).join(' · ')
      || `Guardado en ${list.name}`;
    const image = item.image
      ? (item.image.startsWith('data:') ? `${origin}/icons/og.png` : `${origin}/api/img?u=${encodeURIComponent(item.image)}`)
      : `${origin}/icons/og.png`;
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(await renderIndexWithMeta({
      title: `${item.title} · Haul`,
      desc,
      image,
      url: `${origin}/l/${list.slug}/p/${item.id}`,
    }));
  } catch (err) {
    next(err);
  }
});

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
    const image = cover && !cover.startsWith('data:')
      ? `${origin}/api/img?u=${encodeURIComponent(cover)}`
      : `${origin}/icons/og.png`;

    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(await renderIndexWithMeta({
      title, desc, image, url: `${origin}/l/${list.slug}`,
    }));
  } catch (err) {
    next(err);
  }
});

// El "compartir con Haul" lo atiende el service worker. Si todavía no está
// activo (primera visita), la petición llega aquí: abrimos la app sin más.
app.post('/share', (_req, res) => res.redirect(303, '/'));

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
