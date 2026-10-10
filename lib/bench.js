'use strict';
/**
 * Banco de pruebas del lector de enlaces.
 *
 * Pasa cada URL de `test/bench-urls.json` por el lector real y compara lo que
 * sale con la "hoja de verdad" (nombre y precio apuntados a mano). Corre en
 * segundo plano, guarda el estado en la base de datos y se consulta por HTTP,
 * así una ejecución larga sobrevive a cualquier tiempo de espera.
 */

const fs = require('fs');
const path = require('path');

const STATE_KEY = 'bench:latest';
const STATE_TTL = 1000 * 60 * 60 * 24 * 30;

/* ---------------------------------------------------------- comparación */

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(['de', 'la', 'el', 'los', 'las', 'con', 'en', 'y', 'para', 'por', 'un', 'una', 'the', 'of', 'and', 'for', 'with']);

function tokens(text) {
  return normalize(text).split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * ¿El nombre leído se corresponde con el esperado?
 * Las tiendas añaden coletillas ("- Hombre | Zara España"), así que vale con
 * que la mayoría de las palabras del nombre esperado estén en el leído.
 */
function titleMatches(expected, got) {
  const a = normalize(expected);
  const b = normalize(got);
  if (!a || !b) return { ok: false, score: 0 };
  if (a === b || b.includes(a) || a.includes(b)) return { ok: true, score: 1 };
  const ta = tokens(expected);
  const tb = new Set(tokens(got));
  if (!ta.length) return { ok: false, score: 0 };
  const hits = ta.filter((t) => tb.has(t)).length;
  const score = hits / ta.length;
  return { ok: score >= 0.6, score: Math.round(score * 100) / 100 };
}

/** El precio puede moverse un poco (rebajas, redondeos); el 1% es tolerancia, no acierto. */
function priceMatches(expected, got) {
  if (expected === null || expected === undefined) return { ok: got === null || got === undefined, diff: null };
  if (!Number.isFinite(got)) return { ok: false, diff: null };
  const diff = Math.abs(got - expected);
  return { ok: diff <= Math.max(0.05, expected * 0.01), diff: Math.round(diff * 100) / 100 };
}

function grade(item, result) {
  if (!result || !result.ok) {
    return { ok: false, title: false, price: false, image: false, mode: result && result.mode, error: result && result.message };
  }
  const t = titleMatches(item.title, result.title);
  const p = priceMatches(item.price, result.priceValue);
  const image = !!result.image;
  return {
    ok: t.ok && p.ok && image,
    title: t.ok, titleScore: t.score,
    price: p.ok, priceDiff: p.diff,
    image,
    mode: result.mode,
    got: { title: result.title, priceText: result.priceText, priceValue: result.priceValue, image: result.image ? result.image.slice(0, 120) : '' },
  };
}

/* ------------------------------------------------------------- ejecución */

function loadItems() {
  const file = path.join(__dirname, '..', 'test', 'bench-urls.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function summarize(rows) {
  const total = rows.length;
  const byShop = {};
  let ok = 0, title = 0, price = 0, image = 0, failed = 0;
  const byMode = {};
  for (const r of rows) {
    const g = r.grade;
    if (g.ok) ok++;
    if (g.title) title++;
    if (g.price) price++;
    if (g.image) image++;
    if (g.error) failed++;
    byMode[g.mode || 'error'] = (byMode[g.mode || 'error'] || 0) + 1;
    const s = byShop[r.shop] || (byShop[r.shop] = { total: 0, ok: 0 });
    s.total++; if (g.ok) s.ok++;
  }
  const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  return {
    total, ok, pctOk: pct(ok),
    title, pctTitle: pct(title),
    price, pctPrice: pct(price),
    image, pctImage: pct(image),
    failed, byMode,
    byShop: Object.entries(byShop).map(([shop, s]) => ({ shop, ...s })).sort((a, b) => (a.ok / a.total) - (b.ok / b.total)),
  };
}

let running = false;

/**
 * Lanza el banco. `extract(url)` es el lector real (inyectable para pruebas).
 * `filter` acepta { shop, limit, ids }.
 */
async function run({ db, extract, filter = {}, concurrency = 1, fresh = false }) {
  if (running) return { started: false, reason: 'ya hay una ejecución en marcha' };
  running = true;

  let items = loadItems();
  if (filter.shop) items = items.filter((i) => normalize(i.shop) === normalize(filter.shop));
  if (filter.ids) items = items.filter((i) => filter.ids.includes(i.id));
  if (filter.limit) items = items.slice(0, filter.limit);

  // Si el servidor se reinició a mitad (despliegue, memoria), se retoma por donde iba
  // en vez de volver a pagar los enlaces ya leídos. Con fresh=1 se empieza de cero.
  // Con filtro (shop, ids, limit) se vuelven a leer esos enlaces y se sustituyen
  // sus filas, conservando el resto del informe anterior.
  const filtered = !!(filter.shop || filter.ids || filter.limit);
  const saved = fresh ? null : await db.cacheGet(STATE_KEY).catch(() => null);
  const previous = saved && Array.isArray(saved.rows) && saved.rows.length ? saved : null;
  const selectedIds = new Set(items.map((i) => i.id));
  const resuming = !!(previous && previous.status !== 'done');
  let keptRows = [];
  if (resuming) keptRows = previous.rows;                                           // continuar: se conserva todo
  else if (previous && filtered) keptRows = previous.rows.filter((r) => !selectedIds.has(r.id)); // releer solo lo pedido
  const doneIds = new Set(keptRows.map((r) => r.id));
  const resumed = resuming ? items.filter((i) => doneIds.has(i.id)).length : 0;
  items = items.filter((i) => !doneIds.has(i.id));

  const state = {
    status: 'running',
    startedAt: resuming ? previous.startedAt : Date.now(),
    resumedAt: resuming ? Date.now() : null,
    finishedAt: null,
    total: items.length + keptRows.length, done: keptRows.length,
    rows: keptRows,
    summary: null,
  };
  const save = () => db.cacheSet(STATE_KEY, state, STATE_TTL).catch(() => {});
  await save();

  const queue = items.slice();
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      const started = Date.now();
      let result = null;
      try {
        result = await extract(item.url);
      } catch (err) {
        result = { ok: false, message: String(err && err.message).slice(0, 160), mode: 'error' };
      }
      state.rows.push({
        id: item.id, shop: item.shop, url: item.url,
        expected: { title: item.title, price: item.price, note: item.note },
        grade: grade(item, result),
        ms: Date.now() - started,
      });
      state.done++;
      await save();
    }
  };

  (async () => {
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
      state.rows.sort((a, b) => a.id.localeCompare(b.id));
      state.summary = summarize(state.rows);
      state.status = 'done';
    } catch (err) {
      state.status = 'error';
      state.error = String(err && err.message);
    } finally {
      state.finishedAt = Date.now();
      running = false;
      await save();
    }
  })();

  return { started: true, total: state.total, resumed };
}

async function report(db) {
  const state = await db.cacheGet(STATE_KEY);
  if (!state) return { status: 'never' };
  // "running" guardado pero sin proceso vivo = el servidor se reinició a mitad
  if (state.status === 'running' && !running) {
    state.status = 'interrupted';
    state.hint = 'El servidor se reinició durante la ejecución. Vuelve a lanzar /api/bench/run y continuará por donde iba.';
  }
  if (state.status !== 'done' && state.rows.length) state.partial = summarize(state.rows);
  return state;
}

function isRunning() { return running; }

module.exports = { run, report, isRunning, titleMatches, priceMatches, grade, summarize, loadItems };
