'use strict';
/**
 * Adaptadores por tienda.
 *
 * El lector genérico (JSON-LD, Open Graph, microdatos) resuelve la mayoría de
 * tiendas. Las grandes no publican esos datos y hay que ir a por sus propias
 * etiquetas. Cada adaptador recibe el documento ya cargado y devuelve solo los
 * campos que sabe leer mejor que el genérico; lo demás se respeta.
 *
 * Para añadir una tienda: una entrada más en ADAPTERS con su `match` y su
 * `read($, url)`.
 */

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

/** "18,90 €18,90 €" → "18,90 €" (Amazon repite el precio visible y el oculto) */
function dedupe(text) {
  const t = clean(text);
  if (!t) return '';
  const half = t.length / 2;
  if (t.length % 2 === 0 && t.slice(0, half) === t.slice(half)) return t.slice(0, half);
  return t;
}

/** Primer valor no vacío de una lista de selectores. */
function pick($, selectors, attr) {
  for (const sel of selectors) {
    const el = $(sel).first();
    if (!el.length) continue;
    const value = attr ? el.attr(attr) : el.text();
    if (clean(value)) return clean(value);
  }
  return '';
}

/* ---------------------------------------------------------------- amazon */

const amazon = {
  name: 'amazon',
  match: /(^|\.)amazon\.[a-z.]+$/i,
  read($) {
    const title = pick($, ['#productTitle', '#title', 'h1#title span']);

    // El precio actual vive en el bloque de compra. Fuera de ahí aparecen el
    // precio tachado, el de otros vendedores y el precio por unidad.
    const price = dedupe(pick($, [
      '#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen',
      '#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen',
      '#apex_desktop .a-price:not(.a-text-price) .a-offscreen',
      '#price_inside_buybox',
      '#newBuyBoxPrice',
      '#priceblock_ourprice',
      '#priceblock_dealprice',
      '#tmmSwatches .a-button-selected .slot-price span',
      '.a-price:not(.a-text-price) .a-offscreen',
    ]));

    // La foto buena está en data-old-hires; si no, en el mapa de resoluciones.
    let image = $('#landingImage').attr('data-old-hires')
      || $('#imgBlkFront').attr('data-old-hires')
      || '';
    if (!image) {
      const dynamic = $('#landingImage').attr('data-a-dynamic-image')
        || $('#imgBlkFront').attr('data-a-dynamic-image');
      if (dynamic) {
        try {
          const urls = Object.keys(JSON.parse(dynamic));
          if (urls.length) image = urls[urls.length - 1];
        } catch { /* atributo ilegible */ }
      }
    }
    if (!image) image = $('#landingImage').attr('src') || $('#imgBlkFront').attr('src') || '';

    const brand = clean($('#bylineInfo').first().text())
      .replace(/^(Visita la tienda de|Marca:|de |by )/i, '')
      .replace(/\s*\(Autor\)$/i, '');

    return { title, priceRaw: price, image, brand, siteName: 'Amazon' };
  },
};

/* --------------------------------------------------------------- zalando */

const zalando = {
  name: 'zalando',
  match: /(^|\.)zalando\.[a-z.]+$/i,
  read($) {
    // El h1 lleva dos spans: marca y nombre. El nombre es el título; la marca, la marca.
    const spans = $('h1 span').toArray().map((el) => clean($(el).text())).filter(Boolean);
    const brand = spans.length >= 2 ? spans[0] : '';
    const title = spans.length >= 2 ? spans.slice(1).join(' ') : pick($, ['h1']);
    return {
      title,
      brand,
      priceRaw: pick($, ['[class*="price" i] span', 'p[class*="price" i]']),
      siteName: 'Zalando',
    };
  },
};

/* --------------------------------------------------------------- douglas */

const douglas = {
  name: 'douglas',
  match: /(^|\.)douglas\.[a-z.]+$/i,
  read($) {
    // Su JSON-LD describe la variante ("50 ml"); el nombre real va en og:title y en el h1.
    const og = pick($, ['meta[property="og:title"]'], 'content');
    const h1 = pick($, ['h1']);
    return { title: (og && !/^\d+\s?(ml|g|kg|uds?)$/i.test(og) ? og : '') || h1, siteName: 'Douglas' };
  },
};

/* ------------------------------------------------------------ aliexpress */

// El servidor vive en Alemania y AliExpress responde en alemán y con otros
// precios. Estas cookies fijan tienda España, euros y castellano.
const ALI_COOKIE = 'aep_usuc_f=site=esp&c_tp=EUR&region=ES&b_locale=es_ES; intl_locale=es_ES; xman_us_f=x_locale=es_ES&x_l=0&regionGS=ES';
const aliexpress = {
  name: 'aliexpress',
  match: /(^|\.)aliexpress\.[a-z.]+$/i,
  headers: () => ({ cookie: ALI_COOKIE, 'accept-language': 'es-ES,es;q=0.9' }),
  cookies: (url) => {
    const domain = '.' + new URL(url).hostname.split('.').slice(-2).join('.');
    return ALI_COOKIE.split('; ').map((pair) => {
      const i = pair.indexOf('=');
      return { name: pair.slice(0, i), value: pair.slice(i + 1), domain, path: '/' };
    });
  },
  read($) {
    return { siteName: 'AliExpress' };
  },
};

/* ----------------------------------------------------------------- depop */

// Depop no deja leer el HTML, pero su API pública responde en JSON.
const depop = {
  name: 'depop',
  match: /(^|\.)depop\.com$/i,
  async resolve(url, { fetchText }) {
    const m = new URL(url).pathname.match(/\/products\/([^/]+)/);
    if (!m) return null;
    const text = await fetchText(`https://webapi.depop.com/api/v2/product/${m[1]}/`, { accept: 'application/json', 'accept-language': 'es-ES' });
    if (!text) return null;
    const data = JSON.parse(text);
    const pic = data.pictures && data.pictures[0];
    const image = pic ? (pic.find ? (pic.find((p) => p.width >= 640) || pic[pic.length - 1] || {}).url : (pic.url || '')) : '';
    const price = data.price || {};
    return {
      title: clean(String(data.title || data.description || '').split('\n')[0]).slice(0, 120),
      priceRaw: clean(price.priceAmount || price.amount || ''),
      currency: clean(price.currencyName || price.currency || ''),
      image: image || '',
      brand: clean(data.brandName || (data.brand && data.brand.name) || ''),
      siteName: 'Depop',
    };
  },
  read() { return { siteName: 'Depop' }; },
};

/* ------------------------------------------------------------------ asos */

// ASOS pinta el precio desde una API aparte; la ficha HTML trae nombre y foto.
const asos = {
  name: 'asos',
  match: /(^|\.)asos\.com$/i,
  async resolve(url, { fetchText }) {
    const m = new URL(url).pathname.match(/\/prd\/(\d+)/) || new URL(url).pathname.match(/\/(\d{6,})(?:\/|$)/);
    if (!m) return null;
    const text = await fetchText(
      `https://www.asos.com/api/product/catalogue/v4/stockprice?productIds=${m[1]}&store=ES&currency=EUR&keyStoreDataversion=ornjxx3-9&lang=es-ES`,
      { accept: 'application/json', referer: url }
    );
    if (!text) return null;
    const list = JSON.parse(text);
    const item = Array.isArray(list) ? list[0] : list;
    const price = item && item.productPrice && item.productPrice.current;
    if (!price) return null;
    return { priceRaw: String(price.value), currency: price.currency || 'EUR', siteName: 'ASOS' };
  },
  read() { return { siteName: 'ASOS' }; },
};

/* ----------------------------------------------------------- el corte inglés */

const corteIngles = {
  name: 'elcorteingles',
  match: /(^|\.)elcorteingles\.es$/i,
  read($) {
    return {
      title: pick($, ['h1.product-title', 'h1']),
      priceRaw: pick($, ['.price-amount', '[class*="current-price" i]', '[itemprop="price"]']),
      siteName: 'El Corte Inglés',
    };
  },
};

const ADAPTERS = [amazon, zalando, corteIngles, douglas, aliexpress, depop, asos];

/** Devuelve el adaptador de una URL, si lo hay. */
function adapterFor(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
  return ADAPTERS.find((a) => a.match.test(host)) || null;
}

/**
 * Pasa el documento por el adaptador de su tienda y queda lo mejor de cada uno:
 * lo que el adaptador sepa leer manda, el resto se conserva.
 */
function applyAdapter(parsed, $, url) {
  const adapter = adapterFor(url);
  if (!adapter) return parsed;
  let found = {};
  try { found = adapter.read($, url) || {}; } catch { return parsed; }
  const out = { ...parsed };
  for (const [key, value] of Object.entries(found)) {
    if (value) out[key] = value;
  }
  out.adapter = adapter.name;
  return out;
}

module.exports = { adapterFor, applyAdapter, dedupe, ADAPTERS };
