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

  console.log(`\n${passed} correctas\n`);
  process.exit(process.exitCode || 0);
})();
