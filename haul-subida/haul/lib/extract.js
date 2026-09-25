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

function build(parsed, finalUrl, mode) {
  const price = parsePrice(parsed.priceRaw, parsed.currency);
  return {
    ok: true,
    mode,
    url: cleanUrl(parsed.canonical && /^https?:/i.test(parsed.canonical) ? parsed.canonical : finalUrl),
    title: parsed.title || titleFromSlug(finalUrl) || 'Producto',
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

async function viaFetch(url, { mobile = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: browserHeaders(mobile),
    });
    const type = res.headers.get('content-type') || '';
    if (!type.includes('html')) return null;
    const finalUrl = res.url || url;
    await assertPublicUrl(finalUrl);
    const html = (await res.text()).slice(0, 2_500_000);
    if (!res.ok && res.status !== 403) return null;
    const parsed = parseHtml(html, finalUrl);
    // Si nos han enseñado un muro anti-bot no tiene sentido reintentar igual:
    // lo marcamos para que el orquestador salte directo al navegador.
    if (looksBlocked(parsed.bodySample) || looksBlocked(parsed.title)) return { blocked: true };
    return { parsed, finalUrl };
  } catch {
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

  const [product, cart] = await Promise.all([
    fetchJson(base + '.js', 6000),
    fetchJson(new URL(base).origin + '/cart.js', 4000),
  ]);
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
const UNLOCKER_DAILY_LIMIT = Number(process.env.UNLOCKER_DAILY_LIMIT || 150);
const UNLOCKER_TIMEOUT = Number(process.env.UNLOCKER_TIMEOUT || 45000);
// solo para pruebas: permite apuntar a un servidor falso
const UNLOCKER_ENDPOINT = process.env.BRIGHTDATA_ENDPOINT || 'https://api.brightdata.com/request';

// El tope protege la factura: con 150 al día nunca se pasa de las 5.000
// peticiones gratuitas al mes, aunque alguien abuse de la app.
const unlockerUsage = { day: '', count: 0 };

function unlockerEnabled() {
  return !!(UNLOCKER_KEY && UNLOCKER_ZONE);
}

function unlockerBudgetLeft() {
  const today = new Date().toISOString().slice(0, 10);
  if (unlockerUsage.day !== today) { unlockerUsage.day = today; unlockerUsage.count = 0; }
  return unlockerUsage.count < UNLOCKER_DAILY_LIMIT;
}

async function viaUnlocker(url) {
  if (!unlockerEnabled() || !unlockerBudgetLeft()) return null;
  unlockerUsage.count++;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UNLOCKER_TIMEOUT);
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
      console.error('unlocker', res.status, res.headers.get('x-brd-error') || '');
      return null;
    }
    const html = (await res.text()).slice(0, 2_500_000);
    const parsed = parseHtml(html, url);
    if (looksBlocked(parsed.bodySample) || looksBlocked(parsed.title)) return null;
    return { parsed, finalUrl: url };
  } catch (err) {
    console.error('unlocker', err && err.message);
    return null;
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

async function extractFromUrl(rawUrl) {
  const u = await assertPublicUrl(rawUrl);
  const url = cleanUrl(u.toString());

  // 1. Shopify responde en JSON: si la tienda lo es, aquí se acaba todo
  const shopify = await viaShopify(url).catch(() => null);
  if (shopify && shopify.image && shopify.priceValue) return shopify;

  // 2. lectura rápida del HTML
  let fast = await viaFetch(url);
  let wall = !!(fast && fast.blocked);
  if (wall) fast = null;
  if (fast && isComplete(fast.parsed)) return build(fast.parsed, fast.finalUrl, 'fetch');

  // 3. algunas tiendas sirven una versión móvil más ligera y menos protegida
  if (!wall && (!fast || !isUseful(fast.parsed))) {
    const mobile = await viaFetch(url, { mobile: true });
    if (mobile && mobile.blocked) wall = true;
    else if (mobile && isComplete(mobile.parsed)) return build(mobile.parsed, mobile.finalUrl, 'fetch-mobile');
    else if (mobile && !fast) fast = mobile;
  }

  // 4. si la tienda ya nos ha enseñado un muro anti-bot, Chromium desde el
  //    servidor chocará con lo mismo: directos al desbloqueador, si lo hay
  let unlocked = null;
  let triedUnlocker = false;
  if (wall && unlockerEnabled()) {
    triedUnlocker = true;
    unlocked = await viaUnlocker(url);
    if (unlocked && isComplete(unlocked.parsed)) return build(unlocked.parsed, unlocked.finalUrl, 'unlocker');
  }

  // 5. abrir la página con Chromium
  let deep = null;
  let deepError = null;
  if (!unlocked) {
    try {
      deep = await viaBrowser(url);
    } catch (err) {
      deepError = err;
    }
    if (deep && isComplete(deep.parsed)) return build(deep.parsed, deep.finalUrl, 'browser');
  }

  // 6. el desbloqueador como último intento, si aún no se ha probado
  if (!triedUnlocker && unlockerEnabled()) {
    unlocked = await viaUnlocker(url);
    if (unlocked && isComplete(unlocked.parsed)) return build(unlocked.parsed, unlocked.finalUrl, 'unlocker');
  }

  // 7. combina lo que haya sacado cada intento
  const sources = [unlocked, deep, fast].filter(Boolean);
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
  parsePrice, formatPrice, shopFromUrl, titleFromSlug, isValidEan,
  unlockerEnabled, viaUnlocker, close,
};
