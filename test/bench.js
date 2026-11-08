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

  console.log(`\n${passed} correctas\n`);
  process.exit(process.exitCode || 0);
})();
