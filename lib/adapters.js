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
    return {
      title: pick($, ['h1 span[class]', 'h1']),
      priceRaw: pick($, ['[class*="price" i] span', 'p[class*="price" i]']),
      siteName: 'Zalando',
    };
  },
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

const ADAPTERS = [amazon, zalando, corteIngles];

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
