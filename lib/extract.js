'use strict';
/**
 * Extracción de producto a partir de una URL.
 *
 * Estrategia en dos pasos para que la mayoría de tiendas respondan en <1s:
 *   1. `fetch` + parseo del HTML (JSON-LD, Open Graph, microdatos, DOM).
 *   2. Solo si faltan datos clave, se abre la página con Chromium/Playwright.
 *
 * Nunca se intenta saltar CAPTCHAs, logins ni controles anti-bot: si la tienda
 * los muestra, se devuelve un error claro y la app deja editar a mano.
 */

const dns = require('dns').promises;
const net = require('net');
const cheerio = require('cheerio');

const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT || 22000);
const FETCH_TIMEOUT = Number(process.env.FETCH_TIMEOUT || 9000);
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_|_branch|ref_?$|ref_src|igshid|si$|spm|share_|cm_|epik|ttclid|irclickid)/i;
const BOT_WALL = [
  'access denied', 'verify you are human', 'are you a human', 'captcha',
  'unusual traffic', 'security check', 'enable javascript and cookies',
  'request blocked', 'pardon our interruption',
];

let browser = null;

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
  const raw = String(input).replace(/ /g, ' ').trim();
  if (!raw) return null;

  let currency = String(currencyHint || '').toUpperCase().slice(0, 3);
  if (!currency) {
    for (const [sym, code] of Object.entries(SYMBOLS)) {
      if (raw.includes(sym)) { currency = code; break; }
    }
    const iso = raw.match(/\b(EUR|USD|GBP|CHF|MXN|ARS|COP|CLP|BRL|PLN|SEK|JPY)\b/i);
    if (iso) currency = iso[1].toUpperCase();
  }

  const m = raw.match(/\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/);
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

function flattenJsonLd(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) { node.forEach((n) => flattenJsonLd(n, out)); return out; }
  if (typeof node === 'object') {
    out.push(node);
    if (node['@graph']) flattenJsonLd(node['@graph'], out);
    if (node.mainEntity) flattenJsonLd(node.mainEntity, out);
    if (node.itemListElement) flattenJsonLd(node.itemListElement, out);
  }
  return out;
}

function typeOf(node) {
  const t = node && node['@type'];
  return Array.isArray(t) ? t.map(String) : t ? [String(t)] : [];
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

  let product = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (product) return;
    try {
      const nodes = flattenJsonLd(JSON.parse($(el).contents().text()));
      product = nodes.find((n) => typeOf(n).includes('Product')) || null;
    } catch { /* JSON-LD inválido: se ignora */ }
  });

  const offersRaw = product && product.offers;
  const offer = Array.isArray(offersRaw) ? offersRaw[0] || {} : offersRaw || {};
  const brand = product && (typeof product.brand === 'string' ? product.brand : product.brand && product.brand.name);

  // Precio desde el DOM como último recurso
  let domPrice = '';
  const priceSelectors = [
    '[itemprop="price"]', '[data-testid*="price" i]', '[data-test*="price" i]',
    '[class*="product-price" i]', '[class*="current-price" i]', '[class*="sale-price" i]',
    '[id*="price" i]', '[class*="price" i]',
  ];
  for (const sel of priceSelectors) {
    $(sel).slice(0, 10).each((_, el) => {
      if (domPrice) return;
      const t = clean($(el).attr('content') || $(el).text());
      if (t && /\d/.test(t) && t.length < 60) domPrice = t;
    });
    if (domPrice) break;
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

  const priceRaw =
    clean(offer.price || offer.lowPrice || (offer.priceSpecification && offer.priceSpecification.price)) ||
    meta('meta[property="product:price:amount"]', 'meta[property="og:price:amount"]') ||
    clean($('[itemprop="price"]').first().attr('content')) ||
    domPrice;

  const currency =
    clean(offer.priceCurrency || (offer.priceSpecification && offer.priceSpecification.priceCurrency)) ||
    meta('meta[property="product:price:currency"]', 'meta[property="og:price:currency"]') ||
    clean($('[itemprop="priceCurrency"]').first().attr('content'));

  const availability = clean(offer.availability || '').split('/').pop();

  return {
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
}

function looksBlocked(text) {
  const probe = String(text || '').toLowerCase();
  return BOT_WALL.some((x) => probe.includes(x));
}

function build(parsed, finalUrl, mode) {
  const price = parsePrice(parsed.priceRaw, parsed.currency);
  return {
    ok: true,
    mode,
    url: cleanUrl(parsed.canonical && /^https?:/i.test(parsed.canonical) ? parsed.canonical : finalUrl),
    title: parsed.title || 'Producto',
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

/* --------------------------------------------------------------- fetch */

async function viaFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
        'cache-control': 'no-cache',
      },
    });
    const type = res.headers.get('content-type') || '';
    if (!type.includes('html')) return null;
    const finalUrl = res.url || url;
    await assertPublicUrl(finalUrl);
    const html = (await res.text()).slice(0, 2_500_000);
    if (!res.ok && res.status !== 403) return null;
    const parsed = parseHtml(html, finalUrl);
    if (looksBlocked(parsed.bodySample) || looksBlocked(parsed.title)) return null;
    return { parsed, finalUrl };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
    });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    await page.route('**/*', (route) =>
      ['media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()
    );
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await acceptCookies(page);
    await page.waitForTimeout(1100);
    const finalUrl = page.url();
    await assertPublicUrl(finalUrl);
    const html = await page.content();
    const parsed = parseHtml(html, finalUrl);
    if (looksBlocked(parsed.bodySample) || looksBlocked(await page.title().catch(() => ''))) {
      const err = new Error('La tienda ha mostrado una verificación anti-bot. Puedes añadir el producto a mano en un segundo.');
      err.code = 'BLOCKED';
      throw err;
    }
    return { parsed, finalUrl };
  } finally {
    if (context) await context.close().catch(() => {});
    if (remote && b) await b.close().catch(() => {});
  }
}

/* ---------------------------------------------------------------- extrae */

async function extractFromUrl(rawUrl) {
  const u = await assertPublicUrl(rawUrl);
  const url = cleanUrl(u.toString());

  const fast = await viaFetch(url);
  if (fast && isComplete(fast.parsed)) return build(fast.parsed, fast.finalUrl, 'fetch');

  let deep = null;
  try {
    deep = await viaBrowser(url);
  } catch (err) {
    if (fast && fast.parsed.title) return build(fast.parsed, fast.finalUrl, 'fetch-partial');
    throw err;
  }

  if (deep && (isComplete(deep.parsed) || !fast)) return build(deep.parsed, deep.finalUrl, 'browser');
  if (fast) {
    // combina lo mejor de cada intento
    const merged = { ...fast.parsed };
    for (const key of ['title', 'image', 'priceRaw', 'currency', 'brand', 'siteName', 'canonical']) {
      if (!merged[key] && deep.parsed[key]) merged[key] = deep.parsed[key];
    }
    return build(merged, deep.finalUrl, 'merged');
  }
  throw new Error('No se ha podido leer esta página');
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

async function fetchJson(url, timeout = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'Haul/2.0 (haul.app)' } });
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

module.exports = {
  extractFromUrl, extractFromBarcode, assertPublicUrl, cleanUrl,
  parsePrice, formatPrice, shopFromUrl, isValidEan, close,
};
