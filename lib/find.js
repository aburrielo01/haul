'use strict';
/**
 * Encontrar un producto por su nombre.
 *
 * En iPhone, las apps de las tiendas sueltan a terceros el texto del producto
 * pero no su enlace ("Artículos fantásticos en Zalando: Converse-CHUCK TAYLOR
 * ALL STAR…"). Con ese texto se reconoce la tienda, se busca en su buscador y
 * se elige la ficha que mejor coincide. El resto (foto, precio) lo lee el
 * lector normal a partir del enlace encontrado.
 *
 * Para añadir una tienda: una entrada más en STORES con cómo se reconoce en el
 * texto, cómo se busca y cómo se sacan los candidatos de la página de resultados.
 */

const cheerio = require('cheerio');

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/** Palabras comparables: sin tildes, en minúsculas, sin ruido ("-", "/", "&"). */
function tokens(text) {
  return clean(text)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1);
}

/* --------------------------------------------------------------- zalando */

const zalando = {
  name: 'zalando',
  label: 'Zalando',
  // "Artículos fantásticos en Zalando: Converse-CHUCK TAYLOR ALL STAR UNISEX - Zapatillas altas - black"
  // "Great items on Zalando: …" · "Tolle Artikel bei Zalando: …"
  detect: /\b(?:en|on|bei|sur|su|op)\s+zalando\s*:/i,
  searchUrl: (q) => `https://www.zalando.es/catalogo/?q=${encodeURIComponent(q)}`,
  candidates(html) {
    const $ = cheerio.load(html);
    const bySku = new Map();
    const order = [];
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const m = href.match(/^(?:https?:\/\/www\.zalando\.es)?\/([a-z0-9-]+-([a-z0-9]{6,})-([a-z0-9]{2,4}))\.html/i);
      if (!m) return;
      const sku = `${m[2]}-${m[3]}`.toUpperCase();
      if (bySku.has(sku)) return;
      // el slug lleva marca, modelo, tipo y color; el código de artículo al final no cuenta
      bySku.set(sku, { url: `https://www.zalando.es/${m[1]}.html`, sku, words: m[1].split('-').slice(0, -2).join(' '), group: '', image: '', price: null });
      order.push(sku);
    });
    // La página incrusta, por artículo, nombre exacto, público (KIDS/ALL/WOMEN/MEN), foto y precio.
    const info = /"sku":"([A-Z0-9]+-[A-Z0-9]+)","name":"([^"]*)","navigationTargetGroup":"([A-Z]+)"[^]{0,400}?"uri":"(https:[^"]+)"/g;
    let m;
    while ((m = info.exec(html))) {
      const c = bySku.get(m[1]);
      if (!c) continue;
      c.name = m[2];
      c.words = `${c.words} ${m[2]}`;
      c.group = m[3];
      c.image = m[4].replace(/\\u0026/g, '&').replace(/imwidth=\d+/, 'imwidth=400');
    }
    const price = /"sku":"([A-Z0-9]+-[A-Z0-9]+)","inWishlist":[^}]*?"displayPrice":\{"promotional":(?:null|\{"amount":(\d+)\}),"original":\{"amount":(\d+)\}/g;
    while ((m = price.exec(html))) {
      const c = bySku.get(m[1]);
      if (c && c.price == null) c.price = Number(m[2] || m[3]) / 100;
    }
    return order.map((sku) => bySku.get(sku));
  },
};

const STORES = [zalando];

/** Texto compartido → { store, query, title } o null si no es de una tienda conocida. */
function parseShareText(raw) {
  const text = clean(raw);
  if (!text || /https?:\/\//i.test(text)) return null;
  for (const store of STORES) {
    const m = text.match(store.detect);
    if (!m) continue;
    const title = clean(text.slice(m.index + m[0].length));
    if (title.length < 4) return null;
    // "Converse-CHUCK TAYLOR ALL STAR UNISEX - Zapatillas altas - black" → consulta plana
    const query = clean(title.replace(/\s*[-–|/]\s*/g, ' '));
    return { store, query, title };
  }
  return null;
}

/**
 * Cuánto del nombre buscado aparece en el candidato (0..1). Cada palabra de
 * más en el candidato ("black mono" frente a "black") resta un poco, para que
 * la ficha con el nombre exacto gane a sus variantes.
 */
function score(queryTokens, words) {
  const set = new Set(tokens(words));
  if (!queryTokens.length || !set.size) return 0;
  const q = new Set(queryTokens);
  let hits = 0;
  for (const t of q) if (set.has(t)) hits++;
  let extra = 0;
  for (const t of set) if (!q.has(t)) extra++;
  return hits / q.size - Math.min(0.05, extra * 0.01);
}

/**
 * Busca el producto del texto en su tienda y devuelve el mejor enlace.
 * `fetchText` es el lector de páginas del extractor (con desbloqueador).
 */
async function findByText(raw, { fetchText }) {
  const parsed = parseShareText(raw);
  if (!parsed) return null;
  const { store, query, title } = parsed;
  const html = await fetchText(store.searchUrl(query), { accept: 'text/html,*/*' });
  if (!html) return { store: store.label, query, title, url: '', reason: 'sin resultados' };
  const q = tokens(query);
  const kids = /\b(ni[ñn][oa]s?|kids?|infantil|junior|beb[eé]s?)\b/i.test(query);
  const ranked = store.candidates(html)
    // la ficha infantil solo si el texto habla de niños (Zalando repite nombres)
    .map((c, i) => ({ ...c, i, s: score(q, c.words) - ((c.group === 'KIDS') !== kids ? 0.1 : 0) }))
    .filter((c) => c.s >= 0.66) // menos de dos tercios del nombre es otro producto
    .sort((a, b) => (b.s - a.s) || (a.i - b.i)); // y a igual puntuación, la que la tienda pone antes
  if (!ranked.length) return { store: store.label, query, title, url: '', reason: 'sin candidatos' };
  const best = ranked[0];
  const pick = (c) => ({ url: c.url, image: c.image, price: c.price, group: c.group, name: c.name || '' });
  return {
    store: store.label,
    query,
    title,
    url: best.url,
    match: Math.round(best.s * 100),
    // otras fichas con el mismo nombre, por si la elegida no es la buena
    alternatives: ranked.slice(1, 5).filter((c) => c.s >= best.s - 0.12).map(pick),
  };
}

module.exports = { findByText, parseShareText, tokens, STORES };
