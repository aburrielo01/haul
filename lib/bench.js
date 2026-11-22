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
// Historial: las últimas lecturas de cada enlace y las últimas pasadas completas.
// Es lo que permite decir "estable" o "inestable" en vez de mirar una sola foto.
const HISTORY_KEY = 'bench:history';
const HISTORY_TTL = 1000 * 60 * 60 * 24 * 90;
const HISTORY_PER_ID = 5;
const HISTORY_RUNS = 10;
const CONSISTENCY_RUNS = 3;
// Objetivo acordado: al menos el 92 % de los enlaces con nombre, precio y foto.
const TARGET_PCT = 92;

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

/**
 * El precio puede moverse un poco (rebajas, redondeos); el 1% es tolerancia, no
 * acierto. Las tiendas que convierten divisa al vuelo (Etsy, Depop) bailan con
 * el cambio: esas filas declaran su propia `tolerance` en la hoja.
 */
function priceMatches(expected, got, tolerance = 0.01) {
  if (expected === null || expected === undefined) return { ok: got === null || got === undefined, diff: null };
  if (!Number.isFinite(got)) return { ok: false, diff: null };
  const diff = Math.abs(got - expected);
  const pct = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 0.01;
  return { ok: diff <= Math.max(0.05, expected * pct), diff: Math.round(diff * 100) / 100 };
}

function grade(item, result) {
  if (!result || !result.ok) {
    return { ok: false, title: false, price: false, image: false, mode: result && result.mode, error: result && result.message };
  }
  const t = titleMatches(item.title, result.title);
  const p = priceMatches(item.price, result.priceValue, item.tolerance);
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

/* ------------------------------------------------- verificación con IA */

/**
 * Nombre y foto bien, precio distinto de la hoja: ¿ha cambiado el precio o se
 * ha equivocado el lector? Claude lee el texto visible de la misma página sin
 * saber qué precio sacó el lector. Si coinciden, la hoja estaba desfasada y la
 * fila cuenta como acierto (`sheetStale` lleva el valor nuevo para la hoja).
 */
// Un cambio de precio fuera de este margen no se da por bueno sin mirarlo a
// mano: una rebaja de Black Friday cabe (-56 % en Game); un precio que se
// triplica (Shein, 22 nov) suele ser otra ficha, otra región u otra variante.
const VERIFY_MIN_RATIO = 0.4;
const VERIFY_MAX_RATIO = 1.8;

/** La primera palabra con contenido del nombre: en moda suele ser la marca (Zorclune, INCRYTM). */
function leadToken(text) {
  return tokens(text)[0] || '';
}

/**
 * ¿Es la misma ficha? El nombre de la nota ya pide el 60 % de las palabras,
 * pero dos camisetas de marcas distintas de Shein comparten casi todas
 * («Camiseta de manga larga cuello redondo para hombre»). Para rescatar una
 * fila hace falta además que la primera palabra del nombre esperado esté.
 */
function sameProduct(expectedTitle, readTitle) {
  const lead = leadToken(expectedTitle);
  return !!lead && new Set(tokens(readTitle)).has(lead);
}

async function verifyRow(item, result, g, verifier) {
  if (!verifier || g.ok || !g.title || !g.image || g.price) return g;
  if (!result || !Number.isFinite(result.priceValue) || !result._html) return g;
  // antes de gastar: si no es la misma ficha o el salto es inverosímil, a mano
  if (!sameProduct(item.title, result.title)) {
    return { ...g, verify: { result: 'revisar-a-mano', why: 'otro-producto', read: String(result.title || '').slice(0, 80) } };
  }
  const ratio = item.price ? result.priceValue / item.price : 1;
  if (ratio < VERIFY_MIN_RATIO || ratio > VERIFY_MAX_RATIO) {
    return { ...g, verify: { result: 'revisar-a-mano', why: 'cambio-grande', ratio: Math.round(ratio * 100) / 100 } };
  }
  let v = null;
  try { v = await verifier({ html: result._html, url: result.url || item.url, title: result.title || item.title }); } catch { v = null; }
  if (!v || !Number.isFinite(v.price)) {
    return { ...g, verify: { result: v ? 'sin-precio' : 'sin-respuesta', price: null, ...(v && v.invented ? { why: 'no-esta-en-el-texto', invented: v.invented } : {}) } };
  }
  const agree = Math.abs(v.price - result.priceValue) <= Math.max(0.05, result.priceValue * 0.01);
  const conf = Number(v.confidence) || 0;
  // dos métodos independientes que dan la misma cifra valen aunque Claude dude un poco
  const enough = agree ? conf >= 0.4 : conf >= 0.6;
  const verify = { result: !enough ? 'poca-confianza' : agree ? 'coincide' : 'no-coincide', price: v.price, confidence: conf };
  if (!agree || !enough) return { ...g, verify };
  return { ...g, ok: true, price: true, verify, sheetStale: { sheet: item.price, page: result.priceValue } };
}

/** ¿Falló porque alguien (desbloqueador, navegador) no respondió a tiempo? */
function hadTimeout(row) {
  return (row.trail || []).some((t) => t && (t.result === 'timeout' || t.error === 'timeout'));
}

function summarize(allRows) {
  // Un anuncio de segunda mano vendido (el lector lo reconoce: GONE) no cuenta:
  // el lector ha hecho lo correcto y lo que toca es sustituir el enlace.
  const rows = allRows.filter((r) => !r.excluded);
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
  // qué hizo el desbloqueador en los fallos: si todos sus intentos salen
  // rechazados o vacíos, lo que falla es la cuenta (saldo, KYC), no el lector
  const unlocker = { tried: 0, ok: 0, rejected: 0, wall: 0, empty: 0, timeout: 0, noBudget: 0 };
  for (const r of rows) {
    for (const t of r.trail || []) {
      if (t.step !== 'unlocker') continue;
      unlocker.tried++;
      if (t.result === 'completo' || t.result === 'parcial') unlocker.ok++;
      else if (t.result === 'rechazado') unlocker.rejected++;
      else if (t.result === 'muro') unlocker.wall++;
      else if (t.result === 'timeout') unlocker.timeout++;
      else if (t.result === 'sin-cupo') unlocker.noBudget++;
      else unlocker.empty++;
    }
  }
  // antigüedad de la hoja de verdad: cuántas filas se comprobaron a mano y cuándo
  const dates = rows.map((r) => r.expected && r.expected.verified).filter(Boolean).sort();
  const truth = { verified: dates.length, oldest: dates[0] || null, newest: dates[dates.length - 1] || null };
  const firstTryOk = rows.filter((r) => (r.firstTry ? r.firstTry.ok : r.grade.ok)).length;
  const retried = rows.filter((r) => r.retried);
  return {
    total, ok, pctOk: pct(ok),
    // a la primera, sin la segunda oportunidad de los tiempos agotados
    firstTry: { ok: firstTryOk, pct: pct(firstTryOk) },
    retried: retried.length, recoveredByRetry: retried.filter((r) => r.grade.ok).length,
    // precios que el verificador confirma: el lector leyó bien y la hoja está vieja
    sheetStale: rows.filter((r) => r.grade.sheetStale).map((r) => ({ id: r.id, shop: r.shop, sheet: r.grade.sheetStale.sheet, page: r.grade.sheetStale.page })),
    excluded: allRows.filter((r) => r.excluded).map((r) => ({ id: r.id, shop: r.shop, why: r.excluded })),
    title, pctTitle: pct(title),
    price, pctPrice: pct(price),
    image, pctImage: pct(image),
    failed, byMode, unlocker, truth,
    target: TARGET_PCT, onTarget: pct(ok) >= TARGET_PCT,
    byShop: Object.entries(byShop).map(([shop, s]) => ({ shop, ...s })).sort((a, b) => (a.ok / a.total) - (b.ok / b.total)),
  };
}

/* -------------------------------------------------------------- historial */

async function loadHistory(db) {
  const h = await db.cacheGet(HISTORY_KEY).catch(() => null);
  return h && h.byId ? h : { runs: [], byId: {} };
}

/**
 * Apunta en el historial lo leído en esta pasada: por enlace, las últimas
 * HISTORY_PER_ID lecturas; y, si la pasada fue completa, su porcentaje.
 */
async function recordRun(db, state, gradedIds, filtered) {
  const h = await loadHistory(db);
  const at = state.finishedAt || Date.now();
  for (const r of state.rows) {
    if (!gradedIds.has(r.id) || r.excluded) continue;
    const g = r.grade || {};
    const list = h.byId[r.id] || (h.byId[r.id] = []);
    list.push({ at, ok: !!g.ok, title: !!g.title, price: !!g.price, image: !!g.image, mode: g.mode || null });
    if (list.length > HISTORY_PER_ID) list.splice(0, list.length - HISTORY_PER_ID);
  }
  if (!filtered && state.summary) {
    const s = state.summary;
    h.runs.push({ startedAt: state.startedAt, finishedAt: at, total: s.total, ok: s.ok, pctOk: s.pctOk, onTarget: s.onTarget });
    if (h.runs.length > HISTORY_RUNS) h.runs.splice(0, h.runs.length - HISTORY_RUNS);
  }
  await db.cacheSet(HISTORY_KEY, h, HISTORY_TTL).catch(() => {});
  return h;
}

/** Con menos de dos lecturas no se puede hablar de estabilidad. */
function stabilityOf(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const n = list.length;
  const okCount = list.filter((e) => e.ok).length;
  const marks = list.map((e) => (e.ok ? '✓' : '✗')).join('');
  if (n < 2) return { label: 'sin-datos', okCount, n, marks };
  const label = okCount === n ? 'estable' : okCount === 0 ? 'falla' : 'inestable';
  return { label, okCount, n, marks };
}

/**
 * Lo que de verdad responde a "¿está al 92 % de forma consistente?": las
 * últimas pasadas completas y, enlace a enlace, cuáles bailan.
 */
function consistencyOf(history, rows) {
  const runs = (history.runs || []).slice(-CONSISTENCY_RUNS);
  const counts = { estable: 0, inestable: 0, falla: 0, 'sin-datos': 0 };
  const unstable = [];
  const failing = [];
  for (const r of rows || []) {
    const st = stabilityOf(history.byId[r.id]);
    counts[st.label]++;
    if (st.label === 'inestable') unstable.push(r.id);
    if (st.label === 'falla') failing.push(r.id);
  }
  const pcts = runs.map((x) => x.pctOk);
  return {
    runs,
    enough: runs.length >= CONSISTENCY_RUNS,
    consistent: runs.length >= CONSISTENCY_RUNS && runs.every((x) => x.onTarget),
    minPct: pcts.length ? Math.min(...pcts) : null,
    maxPct: pcts.length ? Math.max(...pcts) : null,
    counts, unstable, failing,
  };
}

let running = false;

/**
 * Lanza el banco. `extract(url)` es el lector real (inyectable para pruebas).
 * `filter` acepta { shop, limit, ids }.
 */
async function run({ db, extract, filter = {}, concurrency = 1, fresh = false, verifier = null, retryTimeouts = true }) {
  if (running) return { started: false, reason: 'ya hay una ejecución en marcha' };
  running = true;
  // Más de dos lectores a la vez en Render es jugársela con Chromium y memoria.
  concurrency = Math.max(1, Math.min(2, Number(concurrency) || 1));

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

  // Una lectura completa: lector, nota y, si hace falta, verificación del precio.
  const readOne = async (item) => {
    const started = Date.now();
    let result = null;
    try {
      result = await extract(item.url);
    } catch (err) {
      result = { ok: false, code: err && err.code, message: String(err && err.message).slice(0, 160), mode: 'error', trail: err && err.trail };
    }
    const g = await verifyRow(item, result, grade(item, result), verifier);
    return {
      id: item.id, shop: item.shop, url: item.url,
      expected: { title: item.title, price: item.price, note: item.note, verified: item.verified || '', tolerance: item.tolerance || null },
      grade: g,
      ms: Date.now() - started,
      // un anuncio de segunda mano vendido: el lector acierta al decirlo, la hoja toca cambiarla
      ...(item.ephemeral && result && result.code === 'GONE' ? { excluded: 'vendido' } : {}),
      // el rastro solo se guarda en los fallos: es lo que hace falta para arreglarlos
      ...(g.ok ? {} : { trail: (result && result.trail) || [] }),
    };
  };

  const queue = items.slice();
  const worker = async () => {
    while (queue.length) {
      state.rows.push(await readOne(queue.shift()));
      state.done++;
      await save();
    }
  };

  // Segunda oportunidad, al final y de uno en uno, a lo que falló porque el
  // desbloqueador o el navegador no respondieron a tiempo. El informe guarda
  // también la cifra a la primera.
  const retryTimedOut = async () => {
    if (!retryTimeouts) return;
    const byId = new Map(loadItems().map((i) => [i.id, i]));
    for (const row of state.rows) {
      if (row.grade.ok || row.excluded || row.retried || !hadTimeout(row) || !byId.has(row.id)) continue;
      state.retrying = row.id;
      const again = await readOne(byId.get(row.id));
      Object.assign(row, again, { firstTry: { ok: false, mode: row.grade.mode || null }, retried: true });
      if (row.grade.ok) delete row.trail;
      await save();
    }
    state.retrying = null;
  };

  // Qué enlaces cuentan como "leídos en esta pasada" para el historial: con
  // filtro, los pedidos; sin filtro, todos (incluidos los retomados tras un
  // reinicio, que son de esta misma pasada).
  const gradedIds = filtered ? selectedIds : null;

  const finished = (async () => {
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
      await retryTimedOut();
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
    if (state.status === 'done') {
      await recordRun(db, state, gradedIds || new Set(state.rows.map((r) => r.id)), filtered).catch(() => {});
    }
  })();

  return { started: true, total: state.total, resumed, concurrency, finished };
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
  const history = await loadHistory(db);
  for (const r of state.rows || []) r.history = stabilityOf(history.byId[r.id]);
  state.consistency = consistencyOf(history, state.rows);
  return state;
}

function isRunning() { return running; }

module.exports = { run, report, isRunning, titleMatches, priceMatches, grade, summarize, loadItems, TARGET_PCT, verifyRow, hadTimeout, sameProduct,
  loadHistory, recordRun, stabilityOf, consistencyOf, HISTORY_PER_ID, CONSISTENCY_RUNS };
