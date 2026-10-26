'use strict';
/**
 * Avisos push (Web Push) para las bajadas de precio.
 *
 * Se activa con un par de claves VAPID en el entorno:
 *   npx web-push generate-vapid-keys
 *   VAPID_PUBLIC_KEY=…  VAPID_PRIVATE_KEY=…  VAPID_SUBJECT=mailto:tu@correo
 * Sin claves no pasa nada: la app sigue enseñando las bajadas con un sticker
 * y el botón de avisos no aparece.
 */

const PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || '').trim();
const PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || '').trim();
const SUBJECT = String(process.env.VAPID_SUBJECT || 'mailto:haul@example.com').trim();

let webpush = null;
let ready = false;

function enabled() {
  return !!(PUBLIC_KEY && PRIVATE_KEY);
}

function setup() {
  if (!enabled()) return false;
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
    ready = true;
  } catch (err) {
    console.error('push: no se ha podido preparar web-push', err && err.message);
    ready = false;
  }
  return ready;
}

/**
 * Envía un aviso. Devuelve `gone: true` cuando la suscripción ya no existe
 * (404/410): el móvil la revocó y hay que borrarla.
 */
async function send(sub, payload) {
  if (!ready) return { ok: false, gone: false, error: 'push desactivado' };
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 60 * 60 * 24, urgency: 'normal' });
    return { ok: true, gone: false };
  } catch (err) {
    const status = err && err.statusCode;
    return { ok: false, gone: status === 404 || status === 410, error: String((err && err.body) || (err && err.message) || status).slice(0, 200) };
  }
}

/** Aviso de bajada a todos los móviles suscritos a la lista de la pieza. */
async function notifyDrop(db, { list, item, from, to, pct, formatPrice }) {
  if (!ready || !list || !list.slug) return 0;
  const subs = await db.pushSubsForSlug(list.slug);
  if (!subs.length) return 0;
  const money = (v) => (formatPrice ? formatPrice(v, item.currency) : `${v} ${item.currency || ''}`.trim());
  const payload = {
    title: `↓ ${item.title}`.slice(0, 80),
    body: `De ${money(from)} a ${money(to)} (${pct}%)${item.shop ? ' · ' + item.shop : ''}`,
    url: `/l/${list.slug}/p/${item.id}`,
    tag: `drop-${item.id}`,
  };
  let sent = 0;
  for (const s of subs) {
    if (!s.sub) { await db.pushSubDelete(s.endpoint).catch(() => {}); continue; }
    const r = await send(s.sub, payload);
    if (r.ok) sent++;
    else if (r.gone) await db.pushSubDelete(s.endpoint).catch(() => {});
    else console.error('push', r.error);
  }
  return sent;
}

module.exports = { enabled, setup, send, notifyDrop, publicKey: () => PUBLIC_KEY };
