'use strict';
/** Banco de pruebas: comparación con la hoja de verdad y ejecución con un lector simulado. */
const assert = require('assert');
const path = require('path');
process.env.DATA_DIR = path.join(require('os').tmpdir(), 'haul-bench-test-' + Date.now());
const db = require('../lib/db');
const bench = require('../lib/bench');

let passed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (err) { console.log('  ✗', name, '→', err.message); process.exitCode = 1; }
}

(async () => {
  await db.init();
  console.log('\nHaul · banco de pruebas\n');

  await ok('el nombre leído con coletillas de la tienda cuenta como acierto', () => {
    assert.strictEqual(bench.titleMatches('Jersey tacto suave', 'Jersey tacto suave - Hombre | Pull&Bear España').ok, true);
    assert.strictEqual(bench.titleMatches('SUDADERA CREWNECK RELAXED FIT', 'Sudadera crewneck relaxed fit').ok, true);
  });
  await ok('un nombre distinto no cuela', () => {
    assert.strictEqual(bench.titleMatches('Jersey tacto suave', 'Pantalón cargo baggy').ok, false);
  });
  await ok('el precio tolera redondeos pero no rebajas', () => {
    assert.strictEqual(bench.priceMatches(35.99, 35.99).ok, true);
    assert.strictEqual(bench.priceMatches(129, 129.0).ok, true);
    assert.strictEqual(bench.priceMatches(35.99, 29.99).ok, false);
  });
  await ok('una fila con divisa convertida puede declarar su tolerancia', () => {
    assert.strictEqual(bench.priceMatches(487.16, 493.02).ok, false, 'el 1 % no basta');
    assert.strictEqual(bench.priceMatches(487.16, 493.02, 0.03).ok, true, 'con el 3 % sí');
    const g = bench.grade({ title: 'Óleo', price: 487.16, tolerance: 0.03 }, { ok: true, title: 'Óleo', priceValue: 493.02, image: 'x' });
    assert.strictEqual(g.ok, true);
  });

  await ok('una ejecución completa guarda estado y resume por tienda', async () => {
    const items = bench.loadItems();
    const fake = async (url) => {
      const it = items.find((i) => i.url === url);
      if (it.shop === 'Temu') throw new Error('bloqueado');
      return { ok: true, mode: 'fetch', title: it.title + ' | Tienda', priceValue: it.shop === 'Zara' ? it.price + 10 : it.price, priceText: '', image: it.shop === 'Nike' ? '' : 'https://x/img.jpg' };
    };
    const started = await bench.run({ db, extract: fake, filter: { ids: ['E001', 'E005', 'E021', 'E061'] } });
    assert.strictEqual(started.started, true);
    let state;
    for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 50)); state = await bench.report(db); if (state.status === 'done') break; }
    assert.strictEqual(state.status, 'done');
    assert.strictEqual(state.summary.total, 4);
    const byId = Object.fromEntries(state.rows.map((r) => [r.id, r.grade]));
    assert.strictEqual(byId.E005.ok, true, 'Pull&Bear completo');
    assert.strictEqual(byId.E001.price, false, 'Zara con precio distinto');
    assert.strictEqual(byId.E021.image, false, 'Nike sin foto');
    assert.ok(byId.E061.error, 'Temu con error');
    assert.strictEqual(state.summary.ok, 1);
    assert.strictEqual(state.summary.failed, 1);
  });

  await ok('si el servidor se reinició a mitad, la siguiente ejecución continúa por donde iba', async () => {
    // simula un estado "running" huérfano con dos de cuatro enlaces ya leídos
    const prev = await bench.report(db);
    const partial = { ...prev, status: 'running', finishedAt: null, summary: null, rows: prev.rows.filter((r) => ['E001', 'E005'].includes(r.id)), done: 2 };
    await db.cacheSet('bench:latest', partial, 1000 * 60);
    const seen = (await bench.report(db));
    assert.strictEqual(seen.status, 'interrupted');
    const calls = [];
    const fake = async (url) => { calls.push(url); return { ok: true, mode: 'fetch', title: 'x', priceValue: 1, image: 'https://x/i.jpg' }; };
    const started = await bench.run({ db, extract: fake, filter: { ids: ['E001', 'E005', 'E021', 'E061'] } });
    assert.strictEqual(started.resumed, 2);
    let state;
    for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 50)); state = await bench.report(db); if (state.status === 'done') break; }
    assert.strictEqual(state.status, 'done');
    assert.strictEqual(calls.length, 2, 'solo lee los dos que faltaban');
    assert.strictEqual(state.rows.length, 4);
    assert.strictEqual(state.rows.find((r) => r.id === 'E001').grade.price, false, 'conserva el resultado anterior de E001');
  });

  await ok('los fallos guardan el rastro de intentos; los aciertos no', async () => {
    const fake = async (url) => {
      if (url.includes('zara')) { const e = new Error('bloqueado'); e.trail = [{ step: 'unlocker', result: 'rechazado', status: 403 }]; throw e; }
      const it = bench.loadItems().find((i) => i.url === url);
      return { ok: true, mode: 'fetch', title: it.title, priceValue: it.price, image: 'https://x/i.jpg', trail: [{ step: 'fetch', result: 'completo' }] };
    };
    await bench.run({ db, extract: fake, filter: { ids: ['E001', 'E005'] }, fresh: true });
    let state;
    for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 50)); state = await bench.report(db); if (state.status === 'done') break; }
    const zara = state.rows.find((r) => r.id === 'E001');
    assert.deepStrictEqual(zara.trail, [{ step: 'unlocker', result: 'rechazado', status: 403 }]);
    assert.strictEqual(state.rows.find((r) => r.id === 'E005').trail, undefined);
  });

  await ok('el historial guarda las últimas lecturas de cada enlace y etiqueta estable / inestable / falla', async () => {
    const items = bench.loadItems();
    let flip = false;
    const fake = async (url) => {
      const it = items.find((i) => i.url === url);
      if (it.id === 'E001') throw new Error('bloqueado');                       // falla siempre
      if (it.id === 'E021') return { ok: true, mode: 'fetch', title: it.title, priceValue: it.price, image: flip ? '' : 'https://x/i.jpg' }; // baila
      return { ok: true, mode: 'fetch', title: it.title, priceValue: it.price, image: 'https://x/i.jpg' };
    };
    await db.cacheSet('bench:history', { runs: [], byId: {} }, 1000 * 60); // las pruebas anteriores ya leyeron E005
    // tres pasadas filtradas sobre los mismos tres enlaces
    for (let i = 0; i < 3; i++) {
      flip = i === 1;
      const started = await bench.run({ db, extract: fake, filter: { ids: ['E001', 'E005', 'E021'] }, fresh: true });
      assert.strictEqual(started.started, true);
      await started.finished;
    }
    const state = await bench.report(db);
    const byId = Object.fromEntries(state.rows.map((r) => [r.id, r.history]));
    assert.strictEqual(byId.E005.label, 'estable');
    assert.strictEqual(byId.E005.marks, '✓✓✓');
    assert.strictEqual(byId.E001.label, 'falla');
    assert.strictEqual(byId.E021.label, 'inestable');
    assert.strictEqual(byId.E021.marks, '✓✗✓');
    assert.deepStrictEqual(state.consistency.unstable, ['E021']);
    assert.deepStrictEqual(state.consistency.failing, ['E001']);
    assert.strictEqual(state.consistency.counts.estable, 1);
    const history = await bench.loadHistory(db);
    assert.strictEqual(history.runs.length, 0, 'las pasadas filtradas no cuentan como pasada completa');
  });

  await ok('el historial se queda con las últimas cinco lecturas por enlace', async () => {
    const items = bench.loadItems();
    const fake = async (url) => { const it = items.find((i) => i.url === url); return { ok: true, mode: 'fetch', title: it.title, priceValue: it.price, image: 'https://x/i.jpg' }; };
    for (let i = 0; i < 4; i++) await (await bench.run({ db, extract: fake, filter: { ids: ['E005'] }, fresh: true })).finished;
    const history = await bench.loadHistory(db);
    assert.strictEqual(history.byId.E005.length, bench.HISTORY_PER_ID);
  });

  await ok('tres pasadas completas en objetivo = consistente; una por debajo, no', async () => {
    const items = bench.loadItems();
    let failCount = 0;
    const fake = async (url) => {
      const it = items.find((i) => i.url === url);
      const idx = items.indexOf(it);
      if (idx < failCount) throw new Error('bloqueado');
      return { ok: true, mode: 'fetch', title: it.title, priceValue: it.price, image: 'https://x/i.jpg' };
    };
    await db.cacheSet('bench:history', { runs: [], byId: {} }, 1000 * 60);
    for (const f of [0, 3, 5]) { failCount = f; await (await bench.run({ db, extract: fake, fresh: true, concurrency: 2 })).finished; }
    let state = await bench.report(db);
    assert.strictEqual(state.consistency.runs.length, 3);
    assert.strictEqual(state.consistency.enough, true);
    assert.strictEqual(state.consistency.consistent, true, '100, 97 y 95 % están en objetivo');
    assert.strictEqual(state.consistency.minPct, 95);
    failCount = 12;
    await (await bench.run({ db, extract: fake, fresh: true })).finished;
    state = await bench.report(db);
    assert.strictEqual(state.consistency.consistent, false, 'con una al 88 % ya no');
    assert.strictEqual(state.consistency.runs.length, 3, 'solo mira las tres últimas');
    const history = await bench.loadHistory(db);
    assert.strictEqual(history.runs.length, 4);
  });

  // ---- verificación, reintento y anuncios vendidos (4.1.4)
  const withHtml = (o, html) => { Object.defineProperty(o, '_html', { value: html, enumerable: false }); return o; };

  await ok('precio distinto pero confirmado por el verificador: acierto con aviso de hoja vieja', async () => {
    const items = bench.loadItems();
    const it = items.find((i) => i.id === 'E005');
    const seen = [];
    const verifier = async (args) => { seen.push(args); return { price: it.price + 3, confidence: 0.9 }; };
    const fake = async (url) => withHtml({ ok: true, mode: 'fetch', title: it.title, priceValue: it.price + 3, image: 'https://x/i.jpg', url }, '<html><body>página</body></html>');
    await db.cacheSet('bench:history', { runs: [], byId: {} }, 1000 * 60);
    await (await bench.run({ db, extract: fake, filter: { ids: ['E005'] }, fresh: true, verifier })).finished;
    const state = await bench.report(db);
    const g = state.rows[0].grade;
    assert.strictEqual(g.ok, true);
    assert.strictEqual(g.verify.result, 'coincide');
    assert.deepStrictEqual(g.sheetStale, { sheet: it.price, page: it.price + 3 });
    assert.strictEqual(state.summary.sheetStale.length, 1);
    assert.strictEqual(seen.length, 1);
    assert.ok(!('price' in seen[0]) && !('sheet' in seen[0]), 'el verificador no recibe precios');
  });

  await ok('si el verificador ve otro precio, es fallo del lector', async () => {
    const it = bench.loadItems().find((i) => i.id === 'E005');
    const verifier = async () => ({ price: it.price + 20, confidence: 0.9 });
    const fake = async (url) => withHtml({ ok: true, mode: 'fetch', title: it.title, priceValue: it.price + 3, image: 'https://x/i.jpg', url }, '<p>x</p>');
    await (await bench.run({ db, extract: fake, filter: { ids: ['E005'] }, fresh: true, verifier })).finished;
    const g = (await bench.report(db)).rows[0].grade;
    assert.strictEqual(g.ok, false);
    assert.strictEqual(g.verify.result, 'no-coincide');
  });

  await ok('el verificador no se usa si falla el nombre o la foto, ni sin página', async () => {
    let calls = 0;
    const verifier = async () => { calls++; return { price: 1, confidence: 1 }; };
    const it = bench.loadItems().find((i) => i.id === 'E005');
    const g1 = await bench.verifyRow(it, withHtml({ priceValue: 1 }, '<p>x</p>'), { ok: false, title: false, image: true, price: false }, verifier);
    const g2 = await bench.verifyRow(it, { priceValue: 1 }, { ok: false, title: true, image: true, price: false }, verifier);
    assert.strictEqual(calls, 0);
    assert.strictEqual(g1.ok, false); assert.strictEqual(g2.ok, false);
  });

  await ok('no rescata otra ficha de nombre parecido (Shein: Zorclune → INCRYTM), ni la consulta', async () => {
    let calls = 0;
    const verifier = async () => { calls++; return { price: 52, confidence: 0.9 }; };
    const it = { title: 'Zorclune Camiseta de manga larga cuello redondo para hombre', price: 49.99 };
    const read = withHtml({ title: 'INCRYTM Camiseta de manga larga cuello redondo para hombre, bloque de color', priceValue: 52 }, '<p>x</p>');
    const g = await bench.verifyRow(it, read, { ok: false, title: true, image: true, price: false }, verifier);
    assert.strictEqual(g.ok, false);
    assert.strictEqual(g.verify.why, 'otro-producto');
    assert.strictEqual(calls, 0, 'no se gasta una llamada');
  });

  await ok('un precio que se triplica no se da por bueno sin mirarlo a mano', async () => {
    const verifier = async () => ({ price: 55.88, confidence: 0.9 });
    const it = { title: 'Radiana Blusa casual versátil', price: 15.49 };
    const read = withHtml({ title: 'Radiana Blusa casual versátil y sexy', priceValue: 55.88 }, '<p>x</p>');
    const g = await bench.verifyRow(it, read, { ok: false, title: true, image: true, price: false }, verifier);
    assert.strictEqual(g.ok, false);
    assert.strictEqual(g.verify.why, 'cambio-grande');
  });

  await ok('si las dos cifras coinciden basta una confianza de 0,4; si no coinciden, nada', async () => {
    const it = { title: 'Hellraiser Revival Day One Edition PS5', price: 39.99 };
    const read = withHtml({ title: 'Hellraiser Revival Day One Edition PS5', priceValue: 29.99 }, '<p>x</p>');
    const base = { ok: false, title: true, image: true, price: false };
    const g1 = await bench.verifyRow(it, read, base, async () => ({ price: 29.99, confidence: 0.45 }));
    assert.strictEqual(g1.ok, true);
    const g2 = await bench.verifyRow(it, read, base, async () => ({ price: 29.99, confidence: 0.3 }));
    assert.strictEqual(g2.ok, false);
    assert.strictEqual(g2.verify.result, 'poca-confianza');
  });

  await ok('un tiempo agotado tiene una segunda oportunidad al final; el informe guarda la cifra a la primera', async () => {
    const items = bench.loadItems();
    const tries = {};
    const fake = async (url) => {
      const it = items.find((i) => i.url === url);
      tries[it.id] = (tries[it.id] || 0) + 1;
      if (it.id === 'E021' && tries[it.id] === 1) { const e = new Error('No hemos podido leer esta página.'); e.trail = [{ step: 'unlocker', result: 'timeout' }]; throw e; }
      if (it.id === 'E001') { const e = new Error('Esta tienda no deja'); e.code = 'BLOCKED'; e.trail = [{ step: 'fetch', result: 'muro' }]; throw e; }
      return { ok: true, mode: 'fetch', title: it.title, priceValue: it.price, image: 'https://x/i.jpg' };
    };
    await (await bench.run({ db, extract: fake, filter: { ids: ['E001', 'E005', 'E021'] }, fresh: true })).finished;
    const state = await bench.report(db);
    const byId = Object.fromEntries(state.rows.map((r) => [r.id, r]));
    assert.strictEqual(tries.E021, 2, 'el tiempo agotado se reintenta');
    assert.strictEqual(tries.E001, 1, 'un muro no se reintenta');
    assert.strictEqual(byId.E021.grade.ok, true);
    assert.strictEqual(byId.E021.retried, true);
    assert.deepStrictEqual(byId.E021.firstTry, { ok: false, mode: 'error' });
    assert.strictEqual(state.summary.ok, 2);
    assert.strictEqual(state.summary.firstTry.ok, 1);
    assert.strictEqual(state.summary.recoveredByRetry, 1);
  });

  await ok('un anuncio de segunda mano vendido no cuenta en el porcentaje y se pide sustituirlo', async () => {
    const items = bench.loadItems();
    const fake = async (url) => {
      const it = items.find((i) => i.url === url);
      if (it.id === 'E068') { const e = new Error('Este producto ya no está en la tienda.'); e.code = 'GONE'; e.trail = [{ step: 'retirada' }]; throw e; }
      return { ok: true, mode: 'fetch', title: it.title, priceValue: it.price, image: 'https://x/i.jpg' };
    };
    await db.cacheSet('bench:history', { runs: [], byId: {} }, 1000 * 60);
    await (await bench.run({ db, extract: fake, filter: { ids: ['E005', 'E067', 'E068'] }, fresh: true })).finished;
    const state = await bench.report(db);
    assert.strictEqual(state.summary.total, 2, 'E068 fuera del total');
    assert.strictEqual(state.summary.ok, 2);
    assert.strictEqual(state.summary.pctOk, 100);
    assert.deepStrictEqual(state.summary.excluded, [{ id: 'E068', shop: 'Wallapop', why: 'vendido' }]);
    const history = await bench.loadHistory(db);
    assert.ok(!history.byId.E068, 'tampoco entra en el historial');
  });

  await ok('una tienda normal retirada (no de segunda mano) sí cuenta como fallo', async () => {
    const items = bench.loadItems();
    const fake = async (url) => { const e = new Error('Este producto ya no está en la tienda.'); e.code = 'GONE'; throw e; };
    await (await bench.run({ db, extract: fake, filter: { ids: ['E005'] }, fresh: true })).finished;
    const state = await bench.report(db);
    assert.strictEqual(state.summary.total, 1);
    assert.strictEqual(state.summary.ok, 0);
  });

  console.log(`\n${passed} correctas\n`);
  process.exit(process.exitCode || 0);
})();
