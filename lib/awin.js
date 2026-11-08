'use strict';
/**
 * AWIN en HAUL, con el mínimo peso para la app.
 *
 * Dos cosas, las dos en segundo plano (las lanza el vigilante, nunca una
 * petición del usuario):
 *
 *   1. Enlaces de afiliado. Para cada pieza de una tienda AWIN se pide el
 *      enlace de seguimiento por lotes de hasta 100 (link builder) y se guarda
 *      en la pieza. La app lo usa al abrir la tienda. Si el anunciante no
 *      permite deep links (`deeplinkNotPermitted`), se anota y no se insiste
 *      en un mes.
 *   2. Precios desde el feed. Una vez al día, por cada anunciante del que haya
 *      piezas, se descarga su feed (JSON Lines) *en streaming* y solo se
 *      guardan las filas cuyo enlace está en HAUL. Esas piezas pasan por la
 *      misma comparación y los mismos avisos que el vigilante, sin scraping,
 *      sin desbloqueador y sin Chromium.
 *
 * Sin AWIN_PUBLISHER_ID, AWIN_TOKEN y AWIN_ADVERTISERS no hace nada.
 *   AWIN_ADVERTISERS = "zalando.es=12345:es_ES,asos.com=678:es_ES"
 *                      dominio=idAnunciante:idioma del feed (uno por tienda aprobada)
 *
 * API (documentación de AWIN, noviembre de 2026):
 *   POST {API}/publishers/{pub}/linkbuilder/generate-batch
 *        { requests: [{ advertiserId, destinationUrl, parameters: { clickref } }] }
 *     → { responses: [{ status, body: { url }, request }] }
 *   GET  {API}/publishers/{pub}/awinfeeds/download/{adv}-retail-{locale}.jsonl
 *     → una línea JSON por producto: id, title, price "79.95 EUR", sale_price,
 *       link, image_link, availability, brand… Máximo 5 peticiones por minuto
 *       y nunca dos a la vez al mismo feed.
 */

const PUBLISHER_ID = String(process.env.AWIN_PUBLISHER_ID || '').trim();
const TOKEN = String(process.env.AWIN_TOKEN || '').trim();
const API = (process.env.AWIN_API || 'https://api.awin.com').replace(/\/$/, '');
const CLICKREF = process.env.AWIN_CLICKREF || 'haul';
const LINK_BATCH = 100;
const LINK_SCAN = 500;
const RETRY_DENIED_MS = 1000 * 60 * 60 * 24 * 30;
const FEED_EVERY_MS = Math.max(1, Number(process.env.AWIN_FEED_EVERY_H || 24)) * 3600 * 1000;
const FEED_PAUSE_MS = Number(process.env.AWIN_FEED_PAUSE_MS || 12000); // 5 peticiones/minuto
const FEED_TIMEOUT_MS = Number(process.env.AWIN_FEED_TIMEOUT_MS || 10 * 60 * 1000);
const FEED_MAX_LINES = Number(process.env.AWIN_FEED_MAX_LINES || 3_000_000);

function parseAdvertisers(text) {
  return String(text || '').split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [host, rest] = entry.split('=');
    const [id, locale] = String(rest || '').split(':');
    if (!host || !/^\d+$/.test(String(id || '').trim())) return null;
    return { host: host.trim().toLowerCase().replace(/^www\./, ''), id: Number(id), locale: (locale || 'es_ES').trim() };
  }).filter(Boolean);
}

const ADVERTISERS = parseAdvertisers(process.env.AWIN_ADVERTISERS);

let fetchImpl = (...args) => fetch(...args);
/** Para pruebas: sustituir fetch. */
function _setFetch(fn) { fetchImpl = fn; }

const state = {
  running: false,
  links: { generated: 0, denied: 0, failed: 0, lastRun: null, lastBatch: 0 },
  feeds: { lastRun: null, matched: 0, updated: 0, lines: 0, ms: 0, errors: 0, advertisers: 0 },
};

function enabled() {
  return !!(PUBLISHER_ID && TOKEN && ADVERTISERS.length);
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/** El anunciante AWIN de un enlace, si la tienda está en AWIN_ADVERTISERS. */
function advertiserFor(url) {
  const host = hostOf(url);
  if (!host) return null;
  return ADVERTISERS.find((a) => host === a.host || host.endsWith('.' + a.host)) || null;
}

/** Dos enlaces al mismo producto, aunque lleven parámetros distintos, deben coincidir. */
function normalizeLink(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${path || '/'}`;
  } catch { return ''; }
}

function headers(extra = {}) {
  return { authorization: `Bearer ${TOKEN}`, accept: 'application/json', ...extra };
}

/* ------------------------------------------------------- enlaces afiliado */

/**
 * Pide a AWIN los enlaces de seguimiento de hasta 100 piezas. Devuelve un
 * mapa id de pieza → { url } | { denied: true } | { error }.
 */
async function generateLinks(items) {
  const out = new Map();
  const requests = items.map((it) => ({
    advertiserId: advertiserFor(it.url).id,
    destinationUrl: it.url,
    parameters: { clickref: CLICKREF },
  }));
  let data;
  try {
    const res = await fetchImpl(`${API}/publishers/${PUBLISHER_ID}/linkbuilder/generate-batch`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ requests }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    for (const it of items) out.set(it.id, { error: String(err && err.message) });
    return out;
  }
  const responses = Array.isArray(data && data.responses) ? data.responses : [];
  items.forEach((it, i) => {
    const r = responses[i] || {};
    const url = r.body && typeof r.body.url === 'string' ? r.body.url : '';
    if (Number(r.status) === 200 && /^https?:\/\//i.test(url)) out.set(it.id, { url });
    else if (Number(r.status) === 400 && JSON.stringify(r.body || '').includes('deeplinkNotPermitted')) out.set(it.id, { denied: true });
    else out.set(it.id, { error: `status ${r.status || '?'}` });
  });
  return out;
}

/** Una pasada de enlaces: las piezas de tiendas AWIN que aún no tienen el suyo. */
async function tickLinks({ db }) {
  const candidates = (await db.itemsNeedingAffiliate({ limit: LINK_SCAN, retryBefore: Date.now() - RETRY_DENIED_MS }))
    .filter((it) => advertiserFor(it.url))
    .slice(0, LINK_BATCH);
  state.links.lastBatch = candidates.length;
  state.links.lastRun = Date.now();
  if (!candidates.length) return { generated: 0, denied: 0, failed: 0 };
  const results = await generateLinks(candidates);
  const summary = { generated: 0, denied: 0, failed: 0 };
  for (const it of candidates) {
    const r = results.get(it.id) || { error: 'sin respuesta' };
    if (r.url) { await db.setAffiliate(it.id, r.url, Date.now()); summary.generated++; }
    else if (r.denied) { await db.setAffiliate(it.id, '', Date.now()); summary.denied++; }
    else summary.failed++; // se vuelve a intentar en la siguiente pasada
  }
  state.links.generated += summary.generated;
  state.links.denied += summary.denied;
  state.links.failed += summary.failed;
  if (summary.generated || summary.denied) console.log(`awin: ${summary.generated} enlaces · ${summary.denied} no permitidos · ${summary.failed} fallos`);
  return summary;
}

/* ------------------------------------------------------- precios del feed */

/** "79.95 EUR" → { value: 79.95, currency: 'EUR' } */
function parseFeedPrice(text) {
  const m = String(text || '').trim().match(/^(\d+(?:[.,]\d+)?)\s*([A-Z]{3})?$/);
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? { value, currency: (m[2] || '').toUpperCase() } : null;
}

/** Lo que el vigilante espera de un lector, pero sacado de una fila del feed. */
function resultFromRow(row, formatPrice) {
  const price = parseFeedPrice(row.sale_price) || parseFeedPrice(row.price);
  if (!price) return null;
  const availability = String(row.availability || '').toLowerCase();
  if (/out_ou?f?_stock|out_of_stock/.test(availability)) return { ok: false, outOfStock: true };
  return {
    ok: true,
    mode: 'awin',
    title: String(row.title || '').trim(),
    image: String(row.image_link || '').trim(),
    priceValue: price.value,
    priceText: formatPrice ? formatPrice(price.value, price.currency || 'EUR') : `${price.value} ${price.currency}`,
    currency: price.currency || 'EUR',
  };
}

/**
 * Descarga el feed de un anunciante en streaming y devuelve las filas cuyo
 * enlace está en `wanted` (clave normalizada → true). Se queda solo con esas:
 * un feed de cientos de miles de productos no pasa por memoria.
 */
async function streamFeed(advertiser, wanted) {
  const url = `${API}/publishers/${PUBLISHER_ID}/awinfeeds/download/${advertiser.id}-retail-${advertiser.locale}.jsonl`;
  const found = new Map();
  let lines = 0;
  const res = await fetchImpl(url, { headers: headers({ accept: 'application/x-ndjson, application/json' }), signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`feed ${advertiser.host}: HTTP ${res.status}`);
  const decoder = new TextDecoder();
  let rest = '';
  const take = (line) => {
    const text = line.trim();
    if (!text) return;
    lines++;
    let row;
    try { row = JSON.parse(text); } catch { return; }
    if (row && row.error && !row.title) throw new Error(`feed ${advertiser.host}: ${row.message || row.error}`);
    const key = normalizeLink(row && row.link);
    if (key && wanted.has(key) && !found.has(key)) found.set(key, row);
  };
  for await (const chunk of res.body) {
    rest += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = rest.indexOf('\n')) >= 0) {
      take(rest.slice(0, at));
      rest = rest.slice(at + 1);
      if (found.size >= wanted.size || lines >= FEED_MAX_LINES) { try { await res.body.cancel(); } catch { /* ya cerrado */ } return { found, lines }; }
    }
  }
  take(rest);
  return { found, lines };
}

/** Una pasada de feeds: todos los anunciantes de los que haya piezas sin comprar. */
async function refreshFeeds({ db, checkItem, notify = null, formatPrice = null }) {
  const started = Date.now();
  const summary = { advertisers: 0, matched: 0, updated: 0, lines: 0, errors: 0 };
  const items = (await db.itemsWithLinks({ limit: 5000 })).filter((it) => advertiserFor(it.url));
  const byAdvertiser = new Map();
  for (const it of items) {
    const a = advertiserFor(it.url);
    const bucket = byAdvertiser.get(a.id) || (byAdvertiser.set(a.id, { advertiser: a, wanted: new Map() }), byAdvertiser.get(a.id));
    const key = normalizeLink(it.url);
    if (key) (bucket.wanted.get(key) || bucket.wanted.set(key, []).get(key)).push(it);
  }
  let first = true;
  for (const { advertiser, wanted } of byAdvertiser.values()) {
    if (!first && FEED_PAUSE_MS) await new Promise((r) => setTimeout(r, FEED_PAUSE_MS));
    first = false;
    summary.advertisers++;
    let feed;
    try { feed = await streamFeed(advertiser, wanted); }
    catch (err) { summary.errors++; console.error('awin feed', err && err.message); continue; }
    summary.lines += feed.lines;
    for (const [key, row] of feed.found) {
      const result = resultFromRow(row, formatPrice);
      for (const item of wanted.get(key) || []) {
        summary.matched++;
        if (!result || !result.ok) { await db.touchChecked(item.id, { failed: false }).catch(() => {}); continue; }
        const r = await checkItem(item, { db, extract: async () => result, cheap: true, notify, formatPrice });
        if (r && r.ok) summary.updated++;
      }
    }
  }
  Object.assign(state.feeds, { lastRun: Date.now(), ms: Date.now() - started, ...summary });
  if (summary.advertisers) console.log(`awin feeds: ${summary.advertisers} anunciantes · ${summary.matched} piezas en feed · ${summary.updated} precios · ${summary.lines} líneas · ${Math.round(summary.ms || (Date.now() - started)) / 1000}s`);
  return summary;
}

/** Lo que llama el vigilante en cada despertar. */
async function tick(deps) {
  if (!enabled() || state.running) return { skipped: true };
  state.running = true;
  const out = {};
  try {
    out.links = await tickLinks(deps);
    if (!state.feeds.lastRun || Date.now() - state.feeds.lastRun >= FEED_EVERY_MS) out.feeds = await refreshFeeds(deps);
  } catch (err) {
    console.error('awin tick', err && err.message);
  } finally {
    state.running = false;
  }
  return out;
}

function stats() {
  return {
    enabled: enabled(),
    configured: { publisher: !!PUBLISHER_ID, token: !!TOKEN, advertisers: ADVERTISERS.map((a) => a.host) },
    links: { ...state.links },
    feeds: { ...state.feeds, everyHours: FEED_EVERY_MS / 3600000 },
  };
}

module.exports = {
  enabled, tick, tickLinks, refreshFeeds, generateLinks, streamFeed, resultFromRow, parseFeedPrice,
  advertiserFor, normalizeLink, parseAdvertisers, stats, _setFetch, ADVERTISERS,
};
