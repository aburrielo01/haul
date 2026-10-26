'use strict';
/**
 * Extracción de producto a partir de una URL.
 *
 * Cascada de intentos, del más barato al más caro:
 *   1. API de Shopify (`<url>.js`), si la tienda lo es.
 *   2. `fetch` + parseo del HTML (JSON-LD, Open Graph, microdatos, DOM),
 *      y reintento con navegador móvil.
 *   3. Chromium/Playwright para tiendas que pintan el precio con JavaScript.
 *   4. Bright Data Web Unlocker (opcional, de pago) para tiendas con
 *      protección anti-bot empresarial. Inactivo si no hay credenciales.
 *
 * Si todo falla, se devuelve lo que se pueda deducir del propio enlace y la
 * app ofrece completar el producto con una captura.
 */

const dns = require('dns').promises;
const net = require('net');
const cheerio = require('cheerio');
const { applyAdapter, adapterFor, dedupe: dedupePrice } = require('./adapters');

const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT || 18000);
const FETCH_TIMEOUT = Number(process.env.FETCH_TIMEOUT || 8000);
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_|_branch|ref_?$|ref_src|igshid|si$|spm|share_|cm_|epik|ttclid|irclickid)/i;
const BOT_WALL = [
  'access denied', 'verify you are human', 'are you a human', 'captcha',
  'unusual traffic', 'security check', 'enable javascript and cookies',
  'request blocked', 'pardon our interruption', 'just a moment',
  'attention required', 'checking your browser', 'verificando que eres',
  'acceso denegado', 'reference #', 'incapsula',
  // bloqueos "suaves": la página carga pero sin producto
  'no hemos podido darte acceso', 'oops! something went wrong',
  'not authorized', 'bot detection', 'robot or human',
];

let browser = null;
// País para las tiendas que ponen el precio según dónde estés (Shopify Markets)
const SHOP_COUNTRY = (process.env.SHOP_COUNTRY || process.env.UNLOCKER_COUNTRY || 'es').toUpperCase();

/**
 * Rastro de cada lectura: qué intento se hizo, qué devolvió y cuánto tardó.
 * Viaja con la petición (AsyncLocalStorage), así que no hay que pasarlo de
 * función en función, y el banco de pruebas lo guarda junto a cada fallo.
 */
const { AsyncLocalStorage } = require('async_hooks');
const traceStore = new AsyncLocalStorage();
function note(step, info = {}) {
  const t = traceStore.getStore();
  if (t && t.length < 30) t.push({ step, ...info });
}

/* ------------------------------------------------------------ seguridad */

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return (
      p[0] === 10 || p[0] === 127 || p[0] === 0 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      p[0] >= 224
    );
  }
  const x = String(ip || '').toLowerCase();
  return x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80:');
}

/** Rechaza URLs que apunten a la red interna (protección SSRF). */
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('URL no válida'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Solo se admiten enlaces http o https');
  if (u.username || u.password) throw new Error('URL no permitida');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Host local no permitido');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('IP privada no permitida');
  } else {
    const rows = await dns.lookup(host, { all: true });
    if (!rows.length || rows.some((r) => isPrivateIp(r.address))) throw new Error('Host no permitido');
  }
  return u;
}

/** Quita parámetros de tracking para que los enlaces guardados sean limpios. */
function cleanUrl(raw) {
  try {
    const u = new URL(raw);
    // Amazon: el producto es el ASIN; todo lo demás es seguimiento
    if (/(^|\.)amazon\.[a-z.]+$/i.test(u.hostname)) {
      const asin = u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
      if (asin) return `${u.origin}/dp/${asin[1].toUpperCase()}`;
    }
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    u.hash = '';
    return u.toString();
  } catch { return raw; }
}

function shopFromUrl(raw) {
  try {
    const host = new URL(raw).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    const label = parts.length > 2 && parts[0] !== 'shop' ? parts[parts.length - 2] : parts[0];
    return label.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  } catch { return ''; }
}

/* --------------------------------------------------------------- precio */

const SYMBOLS = { '€': 'EUR', '$': 'USD', '£': 'GBP', '¥': 'JPY', '₺': 'TRY', 'zł': 'PLN', 'kr': 'SEK' };

/** "1.234,56 €" | "$1,234.56" | "59.95" → { value, currency, text } */
function parsePrice(input, currencyHint) {
  if (input === undefined || input === null) return null;
  // "5,91€5,91€": algunas tiendas repiten el precio visible y el oculto
  let raw = dedupePrice(String(input).replace(/ /g, ' ').trim());
  if (!raw) return null;
  // "€5.935,93€Paga 1,97€ hoy": varios importes pegados (Temu escribe el mismo
  // precio en dos formatos y añade el plazo). Vale el primer importe.
  // "€5.935,93€" es "€5.93" + "5,93€" pegados: mismo importe con punto y con coma
  raw = raw.replace(/([€$£])\s*(\d{1,4})\.(\d{2})\2,\3(?!\d)/, '$1$2.$3 $1');
  if ((raw.match(/[€$£]/g) || []).length >= 2) {
    const first = raw.split(/[€$£]/).map((x) => x.trim()).find((x) => /\d/.test(x));
    if (first) raw = first + (raw.includes('€') ? ' €' : raw.includes('£') ? ' £' : ' $');
  }

  let currency = String(currencyHint || '').toUpperCase().slice(0, 3);
  if (!currency) {
    for (const [sym, code] of Object.entries(SYMBOLS)) {
      if (raw.includes(sym)) { currency = code; break; }
    }
    const iso = raw.match(/\b(EUR|USD|GBP|CHF|MXN|ARS|COP|CLP|BRL|PLN|SEK|JPY)\b/i);
    if (iso) currency = iso[1].toUpperCase();
  }

  // primero cifras con separador de miles ("1.469,00"); si no, el número entero ("1469")
  const m = raw.match(/\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d{1,2})?(?!\d)|\d+(?:[.,]\d{1,2})?(?!\d)/);
  if (!m) return null;
  let num = m[0].replace(/\s/g, '');

  const lastComma = num.lastIndexOf(',');
  const lastDot = num.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // el separador decimal es el que aparece más a la derecha
    if (lastComma > lastDot) num = num.replace(/\./g, '').replace(',', '.');
    else num = num.replace(/,/g, '');
  } else if (lastComma > -1) {
    num = num.length - lastComma - 1 === 3 ? num.replace(/,/g, '') : num.replace(',', '.');
  } else if (lastDot > -1 && num.length - lastDot - 1 === 3) {
    num = num.replace(/\./g, '');
  }

  const value = Number.parseFloat(num);
  if (!Number.isFinite(value) || value <= 0 || value > 5_000_000) return null;
  return { value, currency, text: formatPrice(value, currency) };
}

function formatPrice(value, currency) {
  try {
    return new Intl.NumberFormat('es-ES', {
      style: currency ? 'currency' : 'decimal',
      currency: currency || undefined,
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value} ${currency}`.trim();
  }
}

/* ---------------------------------------------------------- parseo HTML */

/**
 * Aplana el JSON-LD recorriendo cualquier anidamiento: @graph, mainEntity,
 * ProductGroup → hasVariant, BuyAction → object… cada tienda lo envuelve a su
 * manera. Las ofertas no se recorren (no son productos) y hay un tope de nodos.
 */
function flattenJsonLd(node, out = [], depth = 0) {
  if (!node || depth > 6 || out.length > 400) return out;
  if (Array.isArray(node)) { node.forEach((n) => flattenJsonLd(n, out, depth)); return out; }
  if (typeof node === 'object') {
    out.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'offers' || key === 'review' || key === 'aggregateRating') continue;
      if (value && typeof value === 'object') flattenJsonLd(value, out, depth + 1);
    }
  }
  return out;
}

/** Tipos del nodo, normalizados: PcComponentes escribe "product" en minúscula. */
function typeOf(node) {
  const t = node && node['@type'];
  const list = Array.isArray(t) ? t.map(String) : t ? [String(t)] : [];
  return list.map((x) => x.replace(/^.*[/#]/, '')).map((x) => x.charAt(0).toUpperCase() + x.slice(1));
}

function firstImage(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return firstImage(value[0]);
  return value.url || value.contentUrl || value.src || '';
}

function parseHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const meta = (...sels) => {
    for (const sel of sels) {
      const v = $(sel).first().attr('content') || $(sel).first().attr('value') || $(sel).first().text();
      if (clean(v)) return clean(v);
    }
    return '';
  };

  // Con varias variantes (ProductGroup, o varias ofertas por talla) se prefiere
  // la que coincide con la URL; si no, la más barata disponible: en una lista de
  // deseos "desde X" es lo que uno espera ver.
  const priceOf = (o) => Number(String((o && (o.price || o.lowPrice || (o.priceSpecification && o.priceSpecification.price))) || '').replace(',', '.'));
  const inStock = (o) => !o || !o.availability || /instock|limitedavailability|preorder|onlineonly/i.test(String(o.availability));
  const pickOffer = (raw) => {
    if (!Array.isArray(raw)) return raw || {};
    const valid = raw.filter((o) => o && Number.isFinite(priceOf(o)) && priceOf(o) > 0);
    if (!valid.length) return raw[0] || {};
    const stock = valid.filter(inStock);
    return (stock.length ? stock : valid).sort((a, b) => priceOf(a) - priceOf(b))[0];
  };
  const urlKey = String(baseUrl || '').toLowerCase();

  let product = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (product) return;
    try {
      const nodes = flattenJsonLd(JSON.parse($(el).contents().text()));
      const products = nodes.filter((n) => typeOf(n).includes('Product'));
      if (!products.length) return;
      // la variante cuya URL o SKU aparece en el enlace; si no, la más barata con precio
      product = products.find((n) => n.url && urlKey.includes(String(n.url).toLowerCase().split('?')[0].slice(-40)))
        || products.find((n) => n.sku && urlKey.includes(String(n.sku).toLowerCase()))
        || products.filter((n) => Number.isFinite(priceOf(pickOffer(n.offers))) && priceOf(pickOffer(n.offers)) > 0)
          .sort((a, b) => priceOf(pickOffer(a.offers)) - priceOf(pickOffer(b.offers)))[0]
        || products[0];
    } catch { /* JSON-LD inválido: se ignora */ }
  });

  const offersRaw = product && product.offers;
  const offer = pickOffer(offersRaw);
  const brand = product && (typeof product.brand === 'string' ? product.brand : product.brand && product.brand.name);

  /**
   * Precio desde el DOM, cuando no hay datos estructurados.
   * Coger el primer elemento que diga "price" se equivoca a menudo: en la
   * misma página conviven el precio tachado, el de otros vendedores y el
   * precio por unidad. Así que se puntúan todos los candidatos y gana el que
   * más pinta tiene de ser el precio actual.
   */
  const PRICE_SELECTORS = [
    '[itemprop="price"]', '[data-testid*="price" i]', '[data-test*="price" i]',
    '[property="product:price:amount"]',
    '[class*="product-price" i]', '[class*="current-price" i]', '[class*="sale-price" i]',
    '[class*="price" i]', '[id*="price" i]',
  ];
  const STRUCK = 'del, s, strike, [class*="text-price" i], [class*="old" i], [class*="was-" i], [class*="list-price" i], [class*="strike" i], [class*="rrp" i], [class*="before" i], [class*="original" i], [class*="compare" i], [class*="crossed" i], [class*="line-through" i], [class*="previous" i]';
  const NOISE = /\b(env[íi]o|shipping|\/\s*(ud|unidad|kg|l|m|100\s?g)|al mes|\/mes|per month|cuota|plazos?)\b/i;

  let domPrice = '';
  let bestScore = -Infinity;
  let visiblePrice = '';          // el mejor candidato que de verdad se ve en pantalla
  let bestVisible = -Infinity;
  const seen = new Set();
  const struckValues = new Set();   // importes que aparecen tachados en la página
  const struckEls = [];             // y los elementos donde aparecen, para medir cercanía
  let visibleEl = null;
  const toNum = (t) => { const pp = parsePrice(t); return pp ? pp.value : null; };
  for (const sel of PRICE_SELECTORS) {
    $(sel).slice(0, 30).each((_, el) => {
      const node = $(el);
      const text = dedupePrice(clean(node.attr('content') || node.text()));
      if (!text || !/\d/.test(text) || text.length > 60) return;
      // el mismo elemento puede entrar por varios selectores; el mismo texto en
      // otro elemento sí interesa, porque puede llevar la clase que lo delata
      if (seen.has(el)) return;
      seen.add(el);

      let score = 0;
      if (node.is('[itemprop="price"]') || node.attr('content')) score += 3;
      // "now" suelto sí; "nowrap" no. "final" suelto o "finalPrice" sí; "finalize" no.
      if (/current|sale|offscreen|our-price|now(?![a-z])|final(?![a-z])|finalprice/i.test(node.attr('class') || '')) score += 2;
      if (node.closest(STRUCK).length) { score -= 6; const v = toNum(text); if (v) { struckValues.add(v); struckEls.push({ v, el }); } }
      if (NOISE.test(text)) score -= 5;
      if (!/[€$£]|eur|usd|gbp/i.test(text)) score -= 1;
      // los selectores más específicos de la lista valen más
      score += (PRICE_SELECTORS.length - PRICE_SELECTORS.indexOf(sel)) * 0.1;

      if (score > bestScore) { bestScore = score; domPrice = text; }
      if (!node.attr('content') && !node.is('meta') && score > bestVisible) { bestVisible = score; visiblePrice = text; visibleEl = el; }
    });
  }

  const abs = (u) => { try { return new URL(u, baseUrl).toString(); } catch { return u; } };

  const title =
    clean(product && product.name) ||
    meta('meta[property="og:title"]', 'meta[name="twitter:title"]') ||
    clean($('h1').first().text()) ||
    clean($('title').text());

  const image =
    firstImage(product && product.image) ||
    meta('meta[property="og:image:secure_url"]', 'meta[property="og:image"]', 'meta[name="twitter:image"]', 'meta[name="twitter:image:src"]') ||
    $('[itemprop="image"]').first().attr('src') ||
    $('link[rel="image_src"]').first().attr('href') ||
    '';

  // precios tachados sueltos (<del>, <s>, clases "old"…) que no cazó el selector
  $(STRUCK).slice(0, 20).each((_, el) => { const v = toNum(clean($(el).text())); if (v && String($(el).text()).length < 40) { struckValues.add(v); struckEls.push({ v, el }); } });

  let priceRaw =
    clean(offer.price || offer.lowPrice || (offer.priceSpecification && offer.priceSpecification.price)) ||
    meta('meta[property="product:price:amount"]', 'meta[property="og:price:amount"]') ||
    clean($('[itemprop="price"]').first().attr('content')) ||
    domPrice;

  // Si el precio "oficial" (JSON-LD, og:price) aparece tachado en la página, es el
  // precio antiguo: Mango y otras lo dejan ahí. Vale entonces el mejor del DOM si es más bajo.
  // Dos salvaguardas, por Primor: si el precio viene del JSON-LD de la ficha no se
  // toca (es lo más fiable que publica la tienda), y el precio visible tiene que
  // estar en el mismo bloque que el tachado, no en un carrusel de "también te gusta".
  const official = toNum(priceRaw);
  const shown = toNum(visiblePrice);
  const fromLd = !!clean(offer.price || offer.lowPrice || (offer.priceSpecification && offer.priceSpecification.price));
  const near = (a, b) => {
    let p = a;
    for (let i = 0; i < 5 && p; i++, p = p.parent) if ($.contains(p, b) || p === b) return true;
    return false;
  };
  const sameBlock = visibleEl && struckEls.some((x) => x.v === official && near(x.el, visibleEl));
  if (!fromLd && official && shown && shown < official && shown > official * 0.3 && sameBlock) priceRaw = visiblePrice;

  const currency =
    clean(offer.priceCurrency || (offer.priceSpecification && offer.priceSpecification.priceCurrency)) ||
    meta('meta[property="product:price:currency"]', 'meta[property="og:price:currency"]') ||
    clean($('[itemprop="priceCurrency"]').first().attr('content'));

  const availability = clean(offer.availability || '').split('/').pop();

  const parsed = {
    title: title.slice(0, 180),
    image: image ? abs(image) : '',
    priceRaw,
    currency,
    brand: clean(brand),
    availability,
    canonical: $('link[rel="canonical"]').first().attr('href') || '',
    siteName: meta('meta[property="og:site_name"]'),
    bodySample: clean($('body').text()).slice(0, 2500),
    hasProductLd: !!product,
  };

  // La tienda puede tener adaptador propio: lo que él lea manda.
  const adapted = applyAdapter(parsed, $, baseUrl);
  if (adapted.image) adapted.image = abs(adapted.image);
  if (adapted.title) adapted.title = clean(adapted.title).slice(0, 180);
  return adapted;
}

/**
 * ¿Es un muro y no una ficha? Las frases de muro ("captcha", "access denied")
 * también aparecen en fichas normales (Etsy las lleva en la página), así que si
 * la página trae datos de producto o un precio, es una ficha aunque las mencione.
 */
function isWall(parsed, extraTitle = '') {
  if (!parsed) return false;
  if (parsed.hasProductLd || parsed.priceRaw) return false;
  return looksBlocked(parsed.bodySample) || looksBlocked(parsed.title) || looksBlocked(extraTitle);
}

function looksBlocked(text) {
  const probe = String(text || '').toLowerCase();
  return BOT_WALL.some((x) => probe.includes(x));
}

/**
 * Nombre legible a partir de la propia URL.
 * Muchas tiendas ponen el producto en la ruta ("…/chaqueta-vaquera-oversize-p1234.html"),
 * así que aunque nos bloqueen el acceso podemos ofrecer algo mejor que "Producto".
 */
function titleFromSlug(raw) {
  try {
    const parts = new URL(raw).pathname.split('/').filter(Boolean);
    const skip = /^(es|en|fr|de|it|pt|us|uk|eu|[a-z]{2}-[a-z]{2}|p|product|products|producto|item|dp|shop|store|collections|c)$/i;
    const candidates = parts
      .map((p) => decodeURIComponent(p).replace(/\.(html?|php|aspx?)$/i, ''))
      .filter((p) => !skip.test(p) && /[a-záéíóúñ]/i.test(p) && p.length >= 5);
    if (!candidates.length) return '';
    const best = candidates.sort((a, b) =>
      (b.split('-').length - a.split('-').length) || (b.length - a.length))[0];
    const words = best
      .replace(/[_+]/g, '-')
      .split('-')
      // quita referencias tipo "p05575046" o "VN000D3HY28", pero nunca una
      // palabra normal por larga que sea ("zapatillas", "inalámbricos")
      .filter((w) => {
        if (!w) return false;
        if (/^\d+$/.test(w)) return false;
        if (/^[a-z]{1,3}\d{4,}$/i.test(w)) return false;
        return !(/\d/.test(w) && /[a-z]/i.test(w) && w.length >= 8);
      });
    if (!words.length) return '';
    const text = words.join(' ').trim();
    if (text.length < 4) return '';
    return text.charAt(0).toUpperCase() + text.slice(1);
  } catch { return ''; }
}

/**
 * Las tiendas cuelgan su nombre del título ("Cardigan - Hombre | MANGO España").
 * Se quitan los segmentos finales que son el nombre de la tienda o el dominio,
 * nunca los que forman parte del nombre del producto.
 */
function stripSiteSuffix(title, { siteName, brand, host } = {}) {
  let t = String(title || '').trim();
  const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(and|y|the)\b/g, '').replace(/[^a-z0-9]+/g, '');
  const hostParts = String(host || '').toLowerCase().split('.')
    .filter((w) => !/^(www\d*|shop|store|m|es|com|net|org|co|uk|eu|de|fr|it)$/.test(w));
  const hostWord = hostParts.sort((x, y) => y.length - x.length)[0] || '';
  // "pullandbear.com" debe casar con "Pull&Bear": el dominio pega las palabras
  const names = [siteName, brand, hostWord].map(norm).flatMap((x) => [x, x.replace(/and/g, '')])
    .filter((x) => x.length >= 2);
  for (let i = 0; i < 3; i++) {
    const m = t.match(/^(.*?)\s+[|\u2013\u2014-]\s+([^|\u2013\u2014-]+?)\s*$/);
    if (!m) break;
    const tail = norm(m[2]);
    const isSite = names.some((n) => tail.includes(n) || n.includes(tail));
    const isGeneric = /^(hombre|mujer|nin[oa]s?|kids|men|women|unisex|es|espana|online|tienda online|shop online|comprar|oficial|official)$/i
      .test(m[2].trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
    if (!isSite && !isGeneric) break;
    t = m[1].trim();
  }
  return t || String(title || '').trim();
}

function build(parsed, finalUrl, mode) {
  const price = parsePrice(parsed.priceRaw, parsed.currency);
  let host = '';
  try { host = new URL(finalUrl).hostname; } catch { /* sin host */ }
  const title = stripSiteSuffix(parsed.title, { siteName: parsed.siteName, brand: parsed.brand, host });
  return {
    ok: true,
    mode,
    url: cleanUrl(parsed.canonical && /^https?:/i.test(parsed.canonical) ? parsed.canonical : finalUrl),
    title: title || titleFromSlug(finalUrl) || 'Producto',
    image: parsed.image || '',
    priceText: price ? price.text : '',
    priceValue: price ? price.value : null,
    currency: price ? price.currency : '',
    shop: parsed.siteName || parsed.brand || shopFromUrl(finalUrl),
    availability: parsed.availability || '',
  };
}

function isComplete(parsed) {
  return !!(parsed.title && parsed.image && parsed.priceRaw);
}

/** Lo mínimo para que merezca la pena enseñar algo: nombre o foto. */
function isUseful(parsed) {
  return !!(parsed && (parsed.title || parsed.image));
}

/* --------------------------------------------------------------- fetch */

const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

function browserHeaders(mobile) {
  return {
    'user-agent': mobile ? UA_MOBILE : UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
    'upgrade-insecure-requests': '1',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    ...(mobile ? {} : {
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    }),
  };
}

async function viaFetch(url, { mobile = false, retry = true } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const adapter = adapterFor(url);
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { ...browserHeaders(mobile), ...(adapter && adapter.headers ? adapter.headers(url) : {}) },
    });
    const type = res.headers.get('content-type') || '';
    const step = mobile ? 'fetch-movil' : 'fetch';
    // 429 es "demasiado seguido" (Mango lo hace), no un muro: una pausa corta y
    // un segundo intento resuelven la ficha sin gastar desbloqueador ni Chromium.
    if (res.status === 429 && retry) {
      note(step, { status: 429, result: 'reintento' });
      clearTimeout(timer);
      await new Promise((r) => setTimeout(r, 1800));
      return viaFetch(url, { mobile, retry: false });
    }
    if (!type.includes('html')) { note(step, { status: res.status, result: 'no-html' }); return null; }
    const finalUrl = res.url || url;
    await assertPublicUrl(finalUrl);
    const html = (await res.text()).slice(0, 2_500_000);
    if (!res.ok && res.status !== 403) { note(step, { status: res.status, result: 'http' }); return null; }
    const parsed = parseHtml(html, finalUrl);
    // Si nos han enseñado un muro anti-bot no tiene sentido reintentar igual:
    // lo marcamos para que el orquestador salte directo al navegador.
    if (isWall(parsed)) {
      note(step, { status: res.status, result: 'muro', title: String(parsed.title || '').slice(0, 60) });
      return { blocked: true, html };
    }
    note(step, { status: res.status, result: isComplete(parsed) ? 'completo' : isUseful(parsed) ? 'parcial' : 'vacio', price: parsed.priceRaw || null });
    return { parsed, finalUrl, html };
  } catch (err) {
    note(mobile ? 'fetch-movil' : 'fetch', { result: 'error', error: String(err && (err.name === 'AbortError' ? 'timeout' : err.message)).slice(0, 80) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------- shopify */

/**
 * Atajo para tiendas Shopify, que es la mayoría de marcas pequeñas y medianas:
 * cualquier ficha responde en `<url>.js` con el producto en JSON. Sin scraping,
 * sin navegador y en menos de un segundo.
 */
async function viaShopify(rawUrl) {
  let base;
  try {
    const u = new URL(rawUrl);
    const m = u.pathname.match(/^(.*\/products\/[^/]+?)(?:\.js|\.json)?\/?$/);
    if (!m) return null;
    base = u.origin + m[1];
  } catch { return null; }

  // Shopify Markets fija el precio por país según la IP: el servidor está en
  // Alemania y veía el precio alemán (Scuffers: 69 en vez de 59). La cookie
  // "localization" pide el mercado de España, que es el de nuestros usuarios.
  const market = { cookie: `localization=${SHOP_COUNTRY}; cart_currency=EUR`, 'accept-language': 'es-ES,es;q=0.9' };
  const [product, cart] = await Promise.all([
    fetchJson(base + '.js', 6000, market),
    fetchJson(new URL(base).origin + '/cart.js', 4000, market),
  ]);
  note('shopify', { result: product ? 'ok' : 'no', price: product && product.price, currency: cart && cart.currency });
  if (!product || !product.title || product.price === undefined) return null;

  const cents = Number(product.price);
  const value = Number.isFinite(cents) ? cents / 100 : null;
  const currency = (cart && cart.currency) || '';
  const image = product.featured_image || (product.images && product.images[0]) || '';

  return {
    ok: true,
    mode: 'shopify',
    url: cleanUrl(base),
    title: String(product.title).slice(0, 180),
    image: image ? (image.startsWith('//') ? 'https:' + image : image) : '',
    priceText: value ? formatPrice(value, currency) : '',
    priceValue: value,
    currency,
    shop: product.vendor || shopFromUrl(base),
    availability: product.available ? 'InStock' : 'OutOfStock',
  };
}

/* ----------------------------------------------------------- playwright */

async function getBrowser() {
  const { chromium } = require('playwright');
  if (process.env.BROWSER_WS_ENDPOINT) return chromium.connectOverCDP(process.env.BROWSER_WS_ENDPOINT);
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    });
  }
  return browser;
}

async function acceptCookies(page) {
  const labels = ['Aceptar todas', 'Aceptar todo', 'Aceptar', 'Accept all', 'Accept', 'I agree', 'Agree', 'Godkänn', 'Alle akzeptieren'];
  for (const text of labels) {
    try {
      const btn = page.getByRole('button', { name: text, exact: true }).first();
      if (await btn.isVisible({ timeout: 220 })) { await btn.click({ timeout: 700 }); return; }
    } catch { /* el botón no existe en esta tienda */ }
  }
}

async function viaBrowser(url) {
  let context = null;
  let remote = false;
  let b = null;
  try {
    b = await getBrowser();
    remote = !!process.env.BROWSER_WS_ENDPOINT;
    context = await b.newContext({
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      viewport: { width: 1440, height: 1100 },
      userAgent: UA,
      serviceWorkers: 'block',
      deviceScaleFactor: 2,
      extraHTTPHeaders: { 'accept-language': 'es-ES,es;q=0.9,en;q=0.8' },
    });
    // Chromium anuncia que está automatizado; esto solo quita esa marca obvia,
    // no intenta saltarse ninguna verificación.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const adapter = adapterFor(url);
    if (adapter && adapter.cookies) await context.addCookies(adapter.cookies(url)).catch(() => {});
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    // sin imágenes ni fuentes ni estilos: solo queremos el HTML, y en el plan
    // pequeño de Render cada megabyte cuenta
    await page.route('**/*', (route) =>
      ['media', 'font', 'image', 'stylesheet'].includes(route.request().resourceType()) ? route.abort() : route.continue()
    );
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await acceptCookies(page);
    await page.waitForTimeout(1100);
    const finalUrl = page.url();
    await assertPublicUrl(finalUrl);
    const html = await page.content();
    const parsed = parseHtml(html, finalUrl);
    if (isWall(parsed, await page.title().catch(() => ''))) {
      note('chromium', { result: 'muro', title: String(parsed.title || '').slice(0, 60) });
      const err = new Error('La tienda ha mostrado una verificación anti-bot. Puedes añadir el producto a mano en un segundo.');
      err.code = 'BLOCKED';
      throw err;
    }
    note('chromium', { result: isComplete(parsed) ? 'completo' : isUseful(parsed) ? 'parcial' : 'vacio', price: parsed.priceRaw || null });
    return { parsed, finalUrl, html };
  } finally {
    if (context) await context.close().catch(() => {});
    if (remote && b) await b.close().catch(() => {});
  }
}

/* ------------------------------------------------------ desbloqueador */

/**
 * Bright Data Web Unlocker: un servicio de pago que lee la página desde IPs
 * residenciales y resuelve la protección anti-bot de tiendas como Zara, Vans
 * o NFL Shop. Solo se activa si hay credenciales, y solo cobra si acierta.
 *
 *   BRIGHTDATA_API_KEY        clave de la cuenta
 *   BRIGHTDATA_UNLOCKER_ZONE  nombre de la zona Web Unlocker
 *   UNLOCKER_COUNTRY          país desde el que se lee (por defecto "es")
 *   UNLOCKER_DAILY_LIMIT      tope diario de peticiones (por defecto 150)
 */
const UNLOCKER_KEY = process.env.BRIGHTDATA_API_KEY || '';
const UNLOCKER_ZONE = process.env.BRIGHTDATA_UNLOCKER_ZONE || '';
const UNLOCKER_COUNTRY = (process.env.UNLOCKER_COUNTRY || 'es').toLowerCase();
// Si la variable no es un número ("300 ", "sin límite"…) se vuelve al valor por
// defecto en vez de apagar el desbloqueador sin avisar.
const UNLOCKER_DAILY_LIMIT = Number.isFinite(Number(process.env.UNLOCKER_DAILY_LIMIT)) && Number(process.env.UNLOCKER_DAILY_LIMIT) > 0
  ? Number(process.env.UNLOCKER_DAILY_LIMIT) : 150;
// Las verificaciones duras (Sephora, Levi's) tardan más de 45 s en resolverse:
// cortar antes solo sirve para pagar el intento sin ver la página.
const UNLOCKER_TIMEOUT = Number(process.env.UNLOCKER_TIMEOUT || 80000);
// solo para pruebas: permite apuntar a un servidor falso
const UNLOCKER_ENDPOINT = process.env.BRIGHTDATA_ENDPOINT || 'https://api.brightdata.com/request';

// El tope protege la factura: con 150 aciertos al día nunca se pasa de las
// 5.000 peticiones gratuitas al mes, aunque alguien abuse de la app. Bright Data
// solo cobra los aciertos, así que solo se cuentan esos; los intentos fallidos
// tienen su propio tope (el triple) para que un bucle de errores no sea gratis.
const unlockerUsage = { day: '', ok: 0, tried: 0 };

function unlockerEnabled() {
  return !!(UNLOCKER_KEY && UNLOCKER_ZONE);
}

function unlockerBudgetLeft() {
  const today = new Date().toISOString().slice(0, 10);
  if (unlockerUsage.day !== today) { unlockerUsage.day = today; unlockerUsage.ok = 0; unlockerUsage.tried = 0; }
  const left = unlockerUsage.ok < UNLOCKER_DAILY_LIMIT && unlockerUsage.tried < UNLOCKER_DAILY_LIMIT * 3;
  if (!left && unlockerUsage.tried % 10 === 0) console.error('unlocker tope diario alcanzado', unlockerUsage);
  return left;
}

function unlockerStats() {
  unlockerBudgetLeft();
  return { ok: unlockerUsage.ok, tried: unlockerUsage.tried, limit: UNLOCKER_DAILY_LIMIT, timeoutMs: UNLOCKER_TIMEOUT };
}

/**
 * Páginas de error que el propio desbloqueador devuelve como si fueran la
 * tienda (su navegador no llegó: "This site can't be reached", "Proxy Error").
 * No son un muro ni una ficha: se descartan y se vuelve a intentar.
 */
const PROXY_ERROR_PAGE = [
  "this site can't be reached", 'this site can’t be reached', 'proxy error', 'bad gateway',
  'gateway time-out', 'gateway timeout', 'navigation failed', 'err_connection', 'err_timed_out',
  'err_name_not_resolved', 'service unavailable', 'the connection was reset',
];
function looksProxyError(html) {
  const head = String(html || '').slice(0, 4000).toLowerCase();
  const title = (head.match(/<title[^>]*>([^<]{0,200})/) || [])[1] || '';
  return PROXY_ERROR_PAGE.some((x) => title.includes(x)) || (head.length < 3000 && PROXY_ERROR_PAGE.some((x) => head.includes(x)));
}

/**
 * Hasta tres intentos: el muro también al desbloqueador suele ser cuestión de
 * IP, y un error de su proxy, cuestión de segundos. Si un intento se agotó por
 * tiempo, se para: repetir la espera solo duplica el coste. Los intentos
 * fallidos no se cobran.
 */
async function viaUnlocker(url) {
  const pauses = [0, 1500, 3500];
  for (const pause of pauses) {
    if (pause) await new Promise((r) => setTimeout(r, pause));
    const attempt = await unlockerOnce(url);
    if (attempt && attempt.parsed) return attempt;
    if (attempt && attempt.timeout) return null;
    if (attempt && attempt.stop) return null;
  }
  return null;
}

async function unlockerOnce(url) {
  if (!unlockerEnabled()) return null;
  if (!unlockerBudgetLeft()) { note('unlocker', { result: 'sin-cupo' }); return { stop: true }; }
  unlockerUsage.tried++;

  const adapter = adapterFor(url);
  const timeoutMs = (adapter && adapter.unlockerTimeout) || UNLOCKER_TIMEOUT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(UNLOCKER_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${UNLOCKER_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ zone: UNLOCKER_ZONE, url, format: 'raw', country: UNLOCKER_COUNTRY }),
    });
    if (!res.ok) {
      const why = res.headers.get('x-brd-error') || res.headers.get('x-luminati-error') || '';
      console.error('unlocker', res.status, why, url);
      note('unlocker', { status: res.status, result: 'rechazado', error: why.slice(0, 120) });
      return null;
    }
    const html = (await res.text()).slice(0, 2_500_000);
    // Si no llega HTML (cuerpo vacío o texto plano) no es la tienda: es un aviso
    // de Bright Data (dominio restringido, límite de la cuenta) o nada.
    if (!html.trim() || !/<[a-z!]/i.test(html.slice(0, 600))) {
      const brd = [...res.headers.entries()].filter(([k]) => /^x-(brd|luminati)/i.test(k)).map(([k, v]) => `${k}=${v}`).join(' ');
      note('unlocker', { status: res.status, result: html.trim() ? 'aviso' : 'vacio', bytes: html.length, error: (html.replace(/\s+/g, ' ').trim().slice(0, 140) + (brd ? ' | ' + brd : '')).slice(0, 220) });
      console.error('unlocker aviso', url, html.slice(0, 200), brd);
      // un dominio que Bright Data no permite (policy_…) no va a cambiar en el siguiente intento
      return /policy_\d+|requires special permission/i.test(brd) ? { stop: true } : null;
    }
    if (looksProxyError(html)) {
      note('unlocker', { status: res.status, result: 'error-proxy', bytes: html.length, title: ((html.match(/<title[^>]*>([^<]{0,80})/i) || [])[1] || '').trim() });
      return null;
    }
    const parsed = parseHtml(html, url);
    if (isWall(parsed)) {
      note('unlocker', { status: res.status, result: 'muro', title: String(parsed.title || '').slice(0, 60), bytes: html.length });
      return null;
    }
    unlockerUsage.ok++;
    note('unlocker', { status: res.status, result: isComplete(parsed) ? 'completo' : isUseful(parsed) ? 'parcial' : 'vacio', bytes: html.length, price: parsed.priceRaw || null });
    return { parsed, finalUrl: url, html };
  } catch (err) {
    const timeout = !!(err && err.name === 'AbortError');
    console.error('unlocker', timeout ? `sin respuesta en ${timeoutMs / 1000}s` : err && err.message, url);
    note('unlocker', { result: timeout ? 'timeout' : 'error', error: timeout ? '' : String(err && err.message).slice(0, 80) });
    return timeout ? { timeout: true } : null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- extrae */

/**
 * Lo que devolvemos cuando la tienda no nos deja pasar: no es gran cosa, pero
 * evita que el usuario empiece desde una pantalla en blanco.
 */
function fallbackFor(url) {
  return {
    url: cleanUrl(url),
    title: titleFromSlug(url),
    shop: shopFromUrl(url),
  };
}

// Chromium gasta mucha memoria (en el plan pequeño de Render tumba el proceso);
// con el desbloqueador activo se deja como último recurso. CHROMIUM_FIRST=1 lo
// devuelve a su sitio para quien tenga máquina de sobra.
const CHROMIUM_FIRST = process.env.CHROMIUM_FIRST === '1';

/**
 * Texto de una URL con cabeceras de navegador; para los adaptadores que llaman
 * a APIs. Si la API también bloquea al servidor, pasa por el desbloqueador.
 */
async function fetchText(url, headers = {}, { cheap = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { ...browserHeaders(false), accept: 'application/json,text/plain,*/*', ...headers } });
    if (res.ok) {
      const text = await res.text();
      if (text && !looksBlocked(text.slice(0, 600))) return text;
    }
  } catch { /* se intenta por el desbloqueador */ } finally {
    clearTimeout(timer);
  }
  // en modo barato (vigilancia de precios) nunca se paga por una lectura
  if (cheap || !unlockerEnabled() || !unlockerBudgetLeft()) return null;
  unlockerUsage.tried++;
  const c2 = new AbortController();
  const t2 = setTimeout(() => c2.abort(), UNLOCKER_TIMEOUT);
  try {
    const res = await fetch(UNLOCKER_ENDPOINT, {
      method: 'POST',
      signal: c2.signal,
      headers: { authorization: `Bearer ${UNLOCKER_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ zone: UNLOCKER_ZONE, url, format: 'raw', country: UNLOCKER_COUNTRY, headers }),
    });
    if (!res.ok) { console.error('unlocker api', res.status, res.headers.get('x-brd-error') || '', url); return null; }
    const text = await res.text();
    if (!text || looksBlocked(text.slice(0, 600))) return null;
    unlockerUsage.ok++;
    return text;
  } catch (err) {
    console.error('unlocker api', err && err.message, url);
    return null;
  } finally {
    clearTimeout(t2);
  }
}

/**
 * `cheap: true` es el modo de la vigilancia de precios: solo los intentos
 * gratuitos y ligeros (API de la tienda, Shopify, fetch). Ni desbloqueador,
 * que cobra por acierto, ni Chromium, que en el plan pequeño tumba el proceso.
 */
async function extractFromUrl(rawUrl, opts = {}) {
  const trail = [];
  const started = Date.now();
  return traceStore.run(trail, async () => {
    try {
      const out = await extractInner(rawUrl, opts);
      return { ...out, trail };
    } catch (err) {
      err.trail = trail;
      note('fin', { ms: Date.now() - started });
      throw err;
    }
  });
}

async function extractInner(rawUrl, { cheap = false } = {}) {
  const u = await assertPublicUrl(rawUrl);
  const url = cleanUrl(u.toString());
  const adapter = adapterFor(url);
  const fetchTextFor = (target, headers) => fetchText(target, headers, { cheap });

  // 0. algunas tiendas tienen una API pública que responde en JSON: sin HTML
  const api = adapter && adapter.resolve ? await adapter.resolve(url, { fetchText: fetchTextFor }).catch(() => null) : null;
  if (api && isComplete(api)) return build({ ...api }, url, 'api');
  // lo que devuelva la API completa a lo que saque cada intento
  const withApi = (r) => {
    if (!r || !r.parsed || !api) return r;
    for (const key of ['title', 'image', 'priceRaw', 'currency', 'brand', 'siteName']) {
      if (!r.parsed[key] && api[key]) r.parsed[key] = api[key];
    }
    return r;
  };

  // 1. Shopify responde en JSON: si la tienda lo es, aquí se acaba todo.
  //    Salvo una cosa: los descuentos automáticos solo se ven en la ficha HTML,
  //    así que se contrasta y, si la ficha enseña un precio más bajo, manda ella.
  const shopify = await viaShopify(url).catch(() => null);
  if (shopify && shopify.image && shopify.priceValue) {
    const page = await viaFetch(url).catch(() => null);
    const shown = page && page.parsed ? parsePrice(page.parsed.priceRaw, page.parsed.currency || shopify.currency) : null;
    if (shown && shown.value < shopify.priceValue && shown.value > shopify.priceValue * 0.4) {
      return { ...shopify, priceValue: shown.value, priceText: shown.text, mode: 'shopify+ficha' };
    }
    return shopify;
  }

  // 2. lectura rápida del HTML
  let fast = withApi(await viaFetch(url));
  let wall = !!(fast && fast.blocked);
  if (wall) fast = null;
  if (fast && isComplete(fast.parsed)) return build(fast.parsed, fast.finalUrl, 'fetch');

  // 3. algunas tiendas sirven una versión móvil más ligera y menos protegida
  if (!wall && (!fast || !isUseful(fast.parsed))) {
    const mobile = withApi(await viaFetch(url, { mobile: true }));
    if (mobile && mobile.blocked) wall = true;
    else if (mobile && isComplete(mobile.parsed)) return build(mobile.parsed, mobile.finalUrl, 'fetch-mobile');
    else if (mobile && !fast) fast = mobile;
  }

  // 4. desbloqueador: directo si hubo muro, y también antes que Chromium
  //    salvo que se pida lo contrario
  let unlocked = null;
  let triedUnlocker = false;
  if (!cheap && unlockerEnabled() && (wall || !CHROMIUM_FIRST)) {
    triedUnlocker = true;
    unlocked = withApi(await viaUnlocker(url));
    if (unlocked && isComplete(unlocked.parsed)) return build(unlocked.parsed, unlocked.finalUrl, 'unlocker');
  }

  // 5. abrir la página con Chromium: aunque el desbloqueador haya fallado, hay
  //    tiendas (Adidas, New Balance, Uniqlo) que a un navegador real sí le responden
  let deep = null;
  let deepError = null;
  if (!cheap && !unlocked) {
    try {
      deep = withApi(await viaBrowser(url));
    } catch (err) {
      deepError = err;
    }
    if (deep && isComplete(deep.parsed)) return build(deep.parsed, deep.finalUrl, 'browser');
  }

  // 6. el desbloqueador como último intento, si aún no se ha probado
  if (!cheap && !triedUnlocker && unlockerEnabled()) {
    unlocked = withApi(await viaUnlocker(url));
    if (unlocked && isComplete(unlocked.parsed)) return build(unlocked.parsed, unlocked.finalUrl, 'unlocker');
  }

  // 7. combina lo que haya sacado cada intento
  const sources = [unlocked, deep, fast].filter(Boolean);
  if (api && isUseful(api)) sources.push({ parsed: api, finalUrl: url });
  if (sources.length) {
    const merged = { ...sources[0].parsed };
    for (const extra of sources.slice(1)) {
      for (const key of ['title', 'image', 'priceRaw', 'currency', 'brand', 'siteName', 'canonical']) {
        if (!merged[key] && extra.parsed[key]) merged[key] = extra.parsed[key];
      }
    }
    if (shopify) {
      if (!merged.image && shopify.image) merged.image = shopify.image;
      if (!merged.priceRaw && shopify.priceValue) merged.priceRaw = String(shopify.priceValue);
      if (!merged.title && shopify.title) merged.title = shopify.title;
    }
    if (isUseful(merged)) return build(merged, sources[0].finalUrl, 'parcial');
  }
  if (shopify) return shopify;

  const blocked = wall || (deepError && deepError.code === 'BLOCKED');
  const err = new Error(blocked
    ? 'Esta tienda no deja que otras apps lean sus fichas.'
    : 'No hemos podido leer esta página.');
  err.code = blocked ? 'BLOCKED' : 'EXTRACT_FAILED';
  err.fallback = fallbackFor(url);
  throw err;
}


/* ------------------------------------------------------------ diagnóstico */

/**
 * Ejecuta todos los intentos sobre una URL y cuenta qué ha visto cada uno.
 * No devuelve HTML, solo lo que importa para entender por qué falla una
 * tienda. Pensado para pegarlo tal cual en una conversación de soporte.
 */
async function diagnose(rawUrl, { raw = '' } = {}) {
  const u = await assertPublicUrl(rawUrl);
  const url = cleanUrl(u.toString());

  // raw=fetch|movil|chromium|unlocker devuelve el HTML tal cual lo vio ese
  // intento, para construir adaptadores con la página real delante.
  if (raw) {
    let r = null;
    if (raw === 'unlocker') r = await viaUnlocker(url);
    else if (raw === 'chromium') r = await viaBrowser(url).catch(() => null);
    else r = await viaFetch(url, { mobile: raw === 'movil' });
    return { html: (r && r.html) || '' };
  }
  const report = {
    url,
    adapter: (adapterFor(url) || {}).name || null,
    unlocker: unlockerEnabled(),
    steps: [],
  };

  const describe = (step, r, started, extra = {}) => {
    const ms = Date.now() - started;
    if (!r) return report.steps.push({ step, result: 'nada', ms, ...extra });
    if (r.blocked) return report.steps.push({ step, result: 'muro anti-bot', ms, ...extra });
    const p = r.parsed;
    report.steps.push({
      step,
      result: isComplete(p) ? 'completo' : isUseful(p) ? 'parcial' : 'vacío',
      ms,
      title: p.title || null,
      priceRaw: p.priceRaw || null,
      currency: p.currency || null,
      image: p.image ? p.image.slice(0, 140) : null,
      jsonLd: !!p.hasProductLd,
      adapter: p.adapter || null,
      ...extra,
    });
  };

  let t = Date.now();
  const shop = await viaShopify(url).catch(() => null);
  report.steps.push({ step: 'shopify', result: shop ? 'completo' : 'no aplica', ms: Date.now() - t });

  t = Date.now();
  describe('fetch', await viaFetch(url), t);

  t = Date.now();
  describe('fetch-móvil', await viaFetch(url, { mobile: true }), t);

  t = Date.now();
  try {
    describe('chromium', await viaBrowser(url), t);
  } catch (err) {
    report.steps.push({ step: 'chromium', result: 'error', ms: Date.now() - t, error: String(err && err.message).slice(0, 160) });
  }

  if (unlockerEnabled()) {
    t = Date.now();
    describe('unlocker', await viaUnlocker(url), t);
  }

  return report;
}

/* ------------------------------------------------------- código de barras */

function isValidEan(code) {
  const digits = String(code).replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(digits.length)) return false;
  const nums = digits.split('').map(Number);
  const check = nums.pop();
  let sum = 0;
  nums.reverse().forEach((n, i) => { sum += n * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

async function fetchJson(url, timeout = 7000, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'Haul/2.0 (haul.app)', ...headers } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

/** Busca un EAN/UPC en bases de datos públicas y gratuitas. */
async function extractFromBarcode(code) {
  const ean = String(code || '').replace(/\D/g, '');
  if (!ean || ean.length < 8) throw new Error('Código de barras no válido');

  const off = await fetchJson(
    `https://world.openfoodfacts.org/api/v2/product/${ean}.json?fields=product_name,brands,image_front_url,quantity,generic_name`
  );
  if (off && off.status === 1 && off.product) {
    const p = off.product;
    const name = p.product_name || p.generic_name;
    if (name) {
      return {
        ok: true, mode: 'openfoodfacts', barcode: ean,
        title: [name, p.quantity].filter(Boolean).join(' · ').slice(0, 180),
        image: p.image_front_url || '', shop: p.brands ? String(p.brands).split(',')[0].trim() : '',
        priceText: '', priceValue: null, currency: '', url: '',
      };
    }
  }

  const upc = await fetchJson(`https://api.upcitemdb.com/prod/trial/lookup?upc=${ean}`);
  if (upc && Array.isArray(upc.items) && upc.items.length) {
    const it = upc.items[0];
    const price = Number(it.lowest_recorded_price) || null;
    return {
      ok: true, mode: 'upcitemdb', barcode: ean,
      title: String(it.title || 'Producto').slice(0, 180),
      image: (it.images && it.images[0]) || '',
      shop: it.brand || '',
      priceText: price ? formatPrice(price, 'USD') : '',
      priceValue: price, currency: price ? 'USD' : '',
      url: (it.offers && it.offers[0] && it.offers[0].link) || '',
    };
  }

  const err = new Error('No hemos encontrado ese código en las bases públicas');
  err.code = 'NOT_FOUND';
  err.barcode = ean;
  throw err;
}

async function close() {
  if (browser) await browser.close().catch(() => {});
  browser = null;
}

module.exports = { isWall, looksProxyError, unlockerStats, stripSiteSuffix,
  extractFromUrl, extractFromBarcode, assertPublicUrl, cleanUrl,
  parsePrice, formatPrice, shopFromUrl, titleFromSlug, isValidEan,
  unlockerEnabled, viaUnlocker, diagnose, parseHtml, close,
};
