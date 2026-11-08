'use strict';
/**
 * Claude en HAUL: lee capturas de pantalla y rescata fichas que la cascada
 * de lectura deja a medias (sin precio o sin nombre).
 *
 * Sin ANTHROPIC_API_KEY no hace nada: la app sigue como antes (OCR en el
 * móvil, fichas parciales). Con ella:
 *   - readShot(imagen)         → nombre, precio, tienda, color, talla…
 *   - rescueFromHtml(html,url) → los campos que faltan, a partir del texto visible
 *
 * Coste bajo control: modelo configurable (AI_MODEL, por defecto Claude Haiku
 * 5.5), tope de llamadas al día (AI_DAILY_LIMIT) y caché por huella de imagen
 * o por enlace, para no pagar dos veces lo mismo.
 */

const crypto = require('crypto');
const cheerio = require('cheerio');
const { z } = require('zod');

const MODEL = process.env.AI_MODEL || 'claude-haiku-5-5';
const DAILY_LIMIT = Math.max(0, Number(process.env.AI_DAILY_LIMIT || 300));
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 25000);
const MAX_TEXT = 12000;
const SHOT_CACHE_TTL = 1000 * 60 * 60 * 24 * 7;
const RESCUE_CACHE_TTL = 1000 * 60 * 60 * 24;

// Dólares por millón de tokens (entrada, salida); solo para estimar el gasto.
const PRICES = {
  'claude-haiku-5-5': [0.10, 0.50],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
};

const Fields = z.object({
  title: z.string().describe('Nombre del producto tal como lo vende la tienda, sin coletillas de la web ni de la marca'),
  price: z.number().nullable().describe('Precio que se paga ahora (el rebajado si hay rebaja), solo el número; null si no se ve'),
  currency: z.string().describe('Código ISO de la moneda, por ejemplo EUR; vacío si no se ve'),
  shop: z.string().describe('Tienda o app donde se vende (Zalando, Amazon, Zara…); vacío si no se sabe'),
  url: z.string().describe('Enlace del producto si aparece escrito; vacío si no'),
  color: z.string().describe('Color elegido o mostrado; vacío si no se ve'),
  size: z.string().describe('Talla o tamaño elegido; vacío si no se ve'),
  confidence: z.number().min(0).max(1).describe('Seguridad de 0 a 1 en que nombre y precio son correctos'),
});

const SYSTEM = [
  'Eres el lector de productos de HAUL, una app de listas de deseos en español.',
  'Sacas los datos de una ficha de producto tal como la vería una persona: el nombre comercial, el precio que se paga ahora, la tienda.',
  'No inventes: si un dato no está, déjalo vacío o null. Si hay precio tachado y precio rebajado, el precio es el rebajado.',
  'El nombre va sin coletillas como "| Zalando" o "- Comprar online".',
].join(' ');

/* ------------------------------------------------------------- cliente */

let client = null;
let db = null;
let disabledUntil = 0;

function enabled() {
  return !!process.env.ANTHROPIC_API_KEY && DAILY_LIMIT > 0 && Date.now() >= disabledUntil;
}

function getClient() {
  if (client) return client;
  const Anthropic = require('@anthropic-ai/sdk');
  client = new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 1 });
  return client;
}

/** Para pruebas: un cliente falso con messages.parse(). */
function _setClient(fake) { client = fake; }
/** La caché y el contador diario viven en la base de datos si se le pasa una. */
function attachDb(database) { db = database; }

/* ------------------------------------------------------------- contador */

const usage = { day: '', calls: 0, input: 0, output: 0, cached: 0, failed: 0 };

function today() { return new Date().toISOString().slice(0, 10); }

function rollDay() {
  const d = today();
  if (usage.day !== d) Object.assign(usage, { day: d, calls: 0, input: 0, output: 0, cached: 0, failed: 0 });
}

function costUsd() {
  const [pin, pout] = PRICES[MODEL] || [4, 20];
  return Math.round(((usage.input * pin + usage.output * pout) / 1e6) * 10000) / 10000;
}

function stats() {
  rollDay();
  return {
    enabled: enabled(),
    model: MODEL,
    dailyLimit: DAILY_LIMIT,
    today: { calls: usage.calls, cached: usage.cached, failed: usage.failed, inputTokens: usage.input, outputTokens: usage.output, usd: costUsd() },
  };
}

function overLimit() {
  rollDay();
  return usage.calls >= DAILY_LIMIT;
}

/* --------------------------------------------------------------- llamadas */

async function cacheGet(key) {
  if (!db) return null;
  return db.cacheGet(key).catch(() => null);
}
async function cacheSet(key, value, ttl) {
  if (!db) return;
  await db.cacheSet(key, value, ttl).catch(() => {});
}

/** Una llamada con salida estructurada; null si falla, se rechaza o se pasa del tope. */
async function ask(content, { cacheKey, ttl } = {}) {
  if (!enabled()) return null;
  if (cacheKey) {
    const hit = await cacheGet(cacheKey);
    if (hit) { rollDay(); usage.cached++; return hit; }
  }
  if (overLimit()) return null;
  const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
  let res;
  try {
    res = await getClient().messages.parse({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: 'user', content }],
      output_config: { format: zodOutputFormat(Fields), effort: 'low' },
    });
  } catch (err) {
    rollDay(); usage.failed++;
    const Anthropic = require('@anthropic-ai/sdk');
    if (err instanceof Anthropic.AuthenticationError) {
      console.error('ia: clave de Anthropic rechazada; desactivada una hora');
      disabledUntil = Date.now() + 1000 * 60 * 60;
    } else if (err instanceof Anthropic.RateLimitError) {
      console.error('ia: límite de peticiones de Anthropic; pausa de un minuto');
      disabledUntil = Date.now() + 1000 * 60;
    } else {
      console.error('ia:', err && err.message);
    }
    return null;
  }
  rollDay();
  usage.calls++;
  usage.input += (res.usage && res.usage.input_tokens) || 0;
  usage.output += (res.usage && res.usage.output_tokens) || 0;
  if (res.stop_reason === 'refusal' || !res.parsed_output) { usage.failed++; return null; }
  const out = clean(res.parsed_output);
  if (cacheKey) await cacheSet(cacheKey, out, ttl);
  return out;
}

function clean(f) {
  const s = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  const price = Number.isFinite(f.price) && f.price > 0 ? Math.round(f.price * 100) / 100 : null;
  return {
    title: s(f.title).slice(0, 160),
    price,
    currency: s(f.currency).toUpperCase().slice(0, 3),
    shop: s(f.shop).slice(0, 60),
    url: /^https?:\/\//i.test(s(f.url)) ? s(f.url) : '',
    color: s(f.color).slice(0, 40),
    size: s(f.size).slice(0, 20),
    confidence: Math.max(0, Math.min(1, Number(f.confidence) || 0)),
    model: MODEL,
  };
}

/**
 * Lee una captura de pantalla. `image` es un data URL (image/jpeg;base64,…)
 * o el base64 pelado con `mediaType`. `hint` es lo que ya sepamos (texto
 * compartido, tienda) para orientar la lectura.
 */
async function readShot(image, { mediaType = 'image/jpeg', hint = {} } = {}) {
  if (!enabled()) return null;
  let data = String(image || '');
  const m = data.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (m) { mediaType = m[1].toLowerCase(); data = m[2]; }
  if (!data || data.length > 1.5e6) return null;
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mediaType)) return null;
  const hash = crypto.createHash('sha1').update(data).digest('hex');
  const hints = [hint.shop && `Tienda probable: ${hint.shop}.`, hint.title && `Texto que acompañaba: «${String(hint.title).slice(0, 120)}».`].filter(Boolean).join(' ');
  return ask([
    { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
    { type: 'text', text: `Esta es una captura de pantalla de una ficha de producto hecha con el móvil. Saca nombre, precio actual, moneda, tienda, color y talla. ${hints}`.trim() },
  ], { cacheKey: 'ai:shot:' + hash, ttl: SHOT_CACHE_TTL });
}

/** Texto visible de una página, sin scripts ni estilos, acotado. */
function visibleText(html) {
  const $ = cheerio.load(String(html || ''));
  $('script, style, noscript, svg, template, iframe').remove();
  const title = $('title').first().text();
  const body = $('body').text().replace(/\s+/g, ' ').trim();
  return `${title}\n${body}`.slice(0, MAX_TEXT);
}

/**
 * Rescata los campos que la lectura normal no sacó, a partir del texto de
 * la página. Solo tiene sentido con una página real, no con un muro anti-bot.
 */
async function rescueFromHtml(html, url, { missing = ['title', 'price'] } = {}) {
  if (!enabled()) return null;
  const text = visibleText(html);
  if (text.length < 200) return null;
  const key = 'ai:rescue:' + crypto.createHash('sha1').update(String(url)).digest('hex');
  return ask([
    { type: 'text', text: `Texto visible de la ficha ${url}. Faltan: ${missing.join(', ')}. Saca nombre, precio actual, moneda y tienda.\n\n${text}` },
  ], { cacheKey: key, ttl: RESCUE_CACHE_TTL });
}

module.exports = { enabled, readShot, rescueFromHtml, visibleText, stats, attachDb, _setClient, MODEL, DAILY_LIMIT, Fields };
