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
    const seen = new Set();
    const out = [];
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href') || '';
      const m = href.match(/^(?:https?:\/\/www\.zalando\.es)?\/([a-z0-9-]+-[a-z0-9]{6,}-[a-z0-9]{2,4})\.html/i);
      if (!m) return;
      const url = `https://www.zalando.es/${m[1]}.html`;
      if (seen.has(url)) return;
      seen.add(url);
      // el slug lleva marca, modelo, tipo y color; el código de artículo al final no cuenta
      const words = m[1].split('-').slice(0, -2).join(' ');
      out.push({ url, words });
    });
    return out;
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

/** Cuánto del nombre buscado aparece en el candidato (0..1), con bonus por orden. */
function score(queryTokens, words) {
  const set = new Set(tokens(words));
  if (!queryTokens.length || !set.size) return 0;
  let hits = 0;
  for (const t of queryTokens) if (set.has(t)) hits++;
  return hits / queryTokens.length;
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
  let best = null;
  for (const [i, c] of store.candidates(html).entries()) {
    const s = score(q, c.words) - i * 0.005; // a igual coincidencia, el que la tienda pone antes
    if (!best || s > best.s) best = { ...c, s };
  }
  // Menos de dos tercios del nombre es otro producto; mejor no inventar.
  if (!best || best.s < 0.66) return { store: store.label, query, title, url: '', reason: best ? `mejor candidato ${Math.round(best.s * 100)}%` : 'sin candidatos' };
  return { store: store.label, query, title, url: best.url, match: Math.round(best.s * 100) };
}

module.exports = { findByText, parseShareText, tokens, STORES };
