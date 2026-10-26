'use strict';
/**
 * Vigilancia de precios.
 *
 * Cada pocas horas vuelve a leer, solo con los intentos gratuitos, las piezas
 * que tienen enlace y no están compradas. Si el precio cambia lo apunta (y
 * guarda el anterior, el mínimo y un punto en la evolución); si baja, avisa a
 * los móviles suscritos a esa lista.
 *
 * Variables: WATCH=off la apaga · WATCH_EVERY_H (12) cada cuánto se revisa una
 * pieza · WATCH_TICK_MIN (10) cada cuánto despierta · WATCH_BATCH (20) piezas
 * por despertar · WATCH_PAUSE_MS (1500) pausa entre lecturas.
 */

const ENABLED = process.env.WATCH !== 'off';
const EVERY_H = Math.max(1, Number(process.env.WATCH_EVERY_H || 12));
const TICK_MIN = Math.max(1, Number(process.env.WATCH_TICK_MIN || 10));
const BATCH = Math.max(1, Number(process.env.WATCH_BATCH || 20));
const PAUSE_MS = Math.max(0, Number(process.env.WATCH_PAUSE_MS || 1500));
const SLOW_FACTOR = 6; // las piezas que fallan seguido se miran 6 veces menos

const state = {
  enabled: ENABLED,
  running: false,
  startedAt: 0,
  lastRun: 0,
  lastBatch: 0,
  checked: 0,
  changed: 0,
  drops: 0,
  failed: 0,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Compara el precio guardado con el recién leído. Es pura para poder probarla.
 *
 * - Diferencias de céntimos o por debajo del 1 % no cuentan: son redondeos.
 * - Una caída de más del 85 % casi nunca es real (otra variante, precio por
 *   unidad, lectura rota): se descarta entera para no dar falsas alegrías.
 */
function compare(oldValue, newValue) {
  if (!Number.isFinite(newValue) || newValue <= 0) return { valid: false, changed: false, dropped: false, pct: 0 };
  if (!Number.isFinite(oldValue) || oldValue <= 0) return { valid: true, changed: false, dropped: false, pct: 0 };
  const diff = newValue - oldValue;
  const changed = Math.abs(diff) >= 0.5 && Math.abs(diff) / oldValue >= 0.01;
  const suspicious = diff < 0 && newValue < oldValue * 0.15;
  if (suspicious) return { valid: false, changed: false, dropped: false, pct: 0 };
  const pct = Math.round((diff / oldValue) * 100);
  return { valid: true, changed, dropped: changed && diff < 0, pct };
}

/**
 * Vuelve a leer una pieza y guarda lo que salga. `cheap` manda en la vigilancia
 * automática; la comprobación manual del usuario puede usar todos los intentos,
 * igual que cuando añadió la pieza.
 */
async function checkItem(item, { db, extract, cheap = true, notify = null, formatPrice = null }) {
  let result = null;
  try {
    result = await extract(item.url, { cheap });
  } catch { result = null; }

  const value = result && Number.isFinite(result.priceValue) ? result.priceValue : null;
  const cmp = compare(Number(item.price_value), value);
  if (value === null || !cmp.valid) {
    await db.touchChecked(item.id, { failed: true });
    return { ok: false, changed: false, dropped: false, pct: 0, item: await db.getItem(item.list_id, item.id) };
  }

  const currency = (result && result.currency) || item.currency || '';
  const patch = { checkedAt: Date.now(), checkFails: 0 };
  const oldValue = Number.isFinite(Number(item.price_value)) ? Number(item.price_value) : null;
  if (cmp.changed) {
    patch.prevPrice = oldValue;
    patch.priceValue = value;
    patch.priceText = (result && result.priceText) || (formatPrice ? formatPrice(value, currency) : String(value));
    patch.currency = currency;
    patch.priceChangedAt = Date.now();
  } else if (oldValue === null) {
    // la pieza no tenía precio y ahora sí: entra como referencia, sin "cambio"
    patch.priceValue = value;
    patch.priceText = (result && result.priceText) || (formatPrice ? formatPrice(value, currency) : String(value));
    patch.currency = currency;
    patch.basePrice = value;
  }
  const low = Number(item.low_price);
  patch.lowPrice = Number.isFinite(low) && low > 0 ? Math.min(low, value) : value;
  if (!Number.isFinite(Number(item.base_price))) patch.basePrice = oldValue !== null ? oldValue : value;

  const updated = await db.updateItem(item.list_id, item.id, patch);
  await db.addHistory(item, value, currency, { force: cmp.changed }).catch(() => {});

  if (cmp.dropped && notify) {
    notify({ item: updated, from: oldValue, to: value, pct: cmp.pct, list: listOf(item) }).catch((err) => {
      console.error('watch notify', err && err.message);
    });
  }
  return { ok: true, changed: cmp.changed, dropped: cmp.dropped, pct: cmp.pct, item: updated };
}

function listOf(row) {
  return { slug: row.list_slug, name: row.list_name, emoji: row.list_emoji };
}

/** Una pasada: las piezas que tocan, de una en una y con pausa. */
async function tick({ db, extract, notify, formatPrice }) {
  if (!ENABLED || state.running) return { skipped: true };
  state.running = true;
  const summary = { checked: 0, changed: 0, drops: 0, failed: 0 };
  try {
    const items = await db.itemsToWatch({
      everyMs: EVERY_H * 3600 * 1000,
      slowMs: EVERY_H * SLOW_FACTOR * 3600 * 1000,
      limit: BATCH,
    });
    state.lastBatch = items.length;
    for (const item of items) {
      const r = await checkItem(item, { db, extract, notify, formatPrice, cheap: true });
      summary.checked++;
      if (!r.ok) summary.failed++;
      if (r.changed) summary.changed++;
      if (r.dropped) summary.drops++;
      if (PAUSE_MS) await sleep(PAUSE_MS);
    }
    state.checked += summary.checked;
    state.changed += summary.changed;
    state.drops += summary.drops;
    state.failed += summary.failed;
    state.lastRun = Date.now();
    if (summary.checked) console.log(`watch: ${summary.checked} piezas · ${summary.changed} cambios · ${summary.drops} bajadas · ${summary.failed} sin precio`);
  } catch (err) {
    console.error('watch tick', err && err.message);
  } finally {
    state.running = false;
  }
  return summary;
}

let timer = null;
function start(deps) {
  if (!ENABLED || timer) return false;
  state.startedAt = Date.now();
  // el primer despertar espera un minuto: que el servidor arranque tranquilo
  setTimeout(() => tick(deps), 60 * 1000).unref();
  timer = setInterval(() => tick(deps), TICK_MIN * 60 * 1000);
  timer.unref();
  return true;
}

function stats() {
  return {
    enabled: ENABLED,
    everyHours: EVERY_H,
    tickMinutes: TICK_MIN,
    batch: BATCH,
    running: state.running,
    lastRun: state.lastRun || null,
    lastBatch: state.lastBatch,
    checked: state.checked,
    changed: state.changed,
    drops: state.drops,
    failed: state.failed,
  };
}

module.exports = { start, tick, checkItem, compare, stats };
