'use strict';
/** Pruebas del parseador: precios en distintos formatos y lectura de fichas. */

const assert = require('assert');
const { parsePrice, isValidEan, cleanUrl, shopFromUrl } = require('../lib/extract');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (err) { console.log('  ✗', name, '→', err.message); process.exitCode = 1; }
}

console.log('\nHaul · parseo\n');

ok('precio europeo con coma decimal', () => {
  assert.strictEqual(parsePrice('59,95 €').value, 59.95);
  assert.strictEqual(parsePrice('59,95 €').currency, 'EUR');
});
ok('precio con separador de miles europeo', () => {
  assert.strictEqual(parsePrice('1.299,00 €').value, 1299);
});
ok('precio anglosajón', () => {
  assert.strictEqual(parsePrice('$1,234.56').value, 1234.56);
  assert.strictEqual(parsePrice('$1,234.56').currency, 'USD');
});
ok('miles sin decimales no se confunden', () => {
  assert.strictEqual(parsePrice('1,250 USD').value, 1250);
});
ok('número plano con moneda declarada', () => {
  assert.strictEqual(parsePrice('89.9', 'EUR').value, 89.9);
});
ok('texto sin cifras devuelve nulo', () => {
  assert.strictEqual(parsePrice('Consultar precio'), null);
  assert.strictEqual(parsePrice(''), null);
});
ok('valida el dígito de control del EAN', () => {
  assert.strictEqual(isValidEan('4006381333931'), true);
  assert.strictEqual(isValidEan('4006381333932'), false);
});
ok('limpia parámetros de seguimiento', () => {
  const out = cleanUrl('https://tienda.com/p/1?utm_source=tiktok&color=rojo&fbclid=abc#top');
  assert.strictEqual(out, 'https://tienda.com/p/1?color=rojo');
});
ok('deduce el nombre de la tienda', () => {
  assert.strictEqual(shopFromUrl('https://www.zara.com/es/x'), 'Zara');
});

console.log(`\n${passed} correctas\n`);
