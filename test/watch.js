'use strict';
/** Vigilancia de precios: cuándo un precio nuevo cuenta como cambio y como bajada. */

const assert = require('assert');
const { compare, checkItem } = require('../lib/watch');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ✓', name); })
    .catch((err) => { console.log('  ✗', name, '→', err.message); process.exitCode = 1; });
}

(async () => {
  console.log('\nHaul · vigilancia de precios\n');

  await ok('una bajada clara cuenta como bajada', () => {
    const r = compare(69.95, 59.95);
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.dropped, true);
    assert.strictEqual(r.pct, -14);
  });
  await ok('una subida cuenta como cambio, no como bajada', () => {
    const r = compare(50, 55);
    assert.strictEqual(r.changed, true);
    assert.strictEqual(r.dropped, false);
    assert.strictEqual(r.pct, 10);
  });
  await ok('céntimos de diferencia no son un cambio', () => {
    assert.strictEqual(compare(59.95, 59.90).changed, false);
    assert.strictEqual(compare(1200, 1206).changed, false); // menos del 1 %
  });
  await ok('una caída absurda se descarta entera', () => {
    const r = compare(120, 9.99);
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.dropped, false);
  });
  await ok('sin precio nuevo no hay nada que comparar', () => {
    assert.strictEqual(compare(59.95, null).valid, false);
    assert.strictEqual(compare(59.95, 0).valid, false);
  });
  await ok('sin precio anterior, el nuevo entra sin ser cambio', () => {
    const r = compare(null, 39);
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.changed, false);
  });

  // checkItem con una base de datos y un lector falsos: comprueba qué se guarda
  function fakeDb(item) {
    const calls = { patches: [], history: [], failed: 0 };
    return {
      calls,
      async touchChecked(_id, { failed }) { if (failed) calls.failed++; },
      async getItem() { return item; },
      async updateItem(_listId, _id, patch) { calls.patches.push(patch); return { ...item, ...patch }; },
      async addHistory(_item, value) { calls.history.push(value); },
    };
  }
  const base = { id: 'p1', list_id: 'l1', url: 'https://tienda.com/p/1', price_value: 80, currency: 'EUR', low_price: 80, base_price: 80 };

  await ok('una bajada guarda el precio anterior, el nuevo y avisa', async () => {
    const db = fakeDb(base);
    let notified = null;
    const r = await checkItem({ ...base, list_slug: 'mi-haul' }, {
      db,
      extract: async () => ({ priceValue: 64, priceText: '64 €', currency: 'EUR' }),
      notify: async (ev) => { notified = ev; },
    });
    assert.strictEqual(r.dropped, true);
    const p = db.calls.patches[0];
    assert.strictEqual(p.prevPrice, 80);
    assert.strictEqual(p.priceValue, 64);
    assert.strictEqual(p.lowPrice, 64);
    assert.strictEqual(db.calls.history[0], 64);
    await new Promise((res) => setTimeout(res, 5));
    assert.ok(notified && notified.from === 80 && notified.to === 64 && notified.list.slug === 'mi-haul');
  });
  await ok('si la tienda no da precio, solo se apunta el fallo', async () => {
    const db = fakeDb(base);
    const r = await checkItem(base, { db, extract: async () => { throw new Error('bloqueado'); } });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(db.calls.failed, 1);
    assert.strictEqual(db.calls.patches.length, 0);
  });
  await ok('el mismo precio solo refresca la fecha y el mínimo', async () => {
    const db = fakeDb(base);
    const r = await checkItem(base, { db, extract: async () => ({ priceValue: 80, priceText: '80 €', currency: 'EUR' }) });
    assert.strictEqual(r.changed, false);
    const p = db.calls.patches[0];
    assert.strictEqual(p.prevPrice, undefined);
    assert.strictEqual(p.lowPrice, 80);
    assert.ok(p.checkedAt > 0);
  });
  await ok('la vigilancia automática pide el modo barato', async () => {
    let opts = null;
    const db = fakeDb(base);
    await checkItem(base, { db, extract: async (_url, o) => { opts = o; return { priceValue: 80 }; } });
    assert.strictEqual(opts.cheap, true);
  });

  console.log(`\n${passed} correctas\n`);
})();
