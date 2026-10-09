'use strict';
/** Pruebas del parseador: precios en distintos formatos y lectura de fichas. */

const assert = require('assert');
const { parsePrice, isValidEan, cleanUrl, shopFromUrl, titleFromSlug, stripSiteSuffix } = require('../lib/extract');

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
ok('quita el nombre de la tienda del final del título, no el del producto', () => {
  assert.strictEqual(stripSiteSuffix('Chaqueta efecto ante bolsillos - Hombre | MANGO España (Península y Baleares)', { siteName: 'MANGO', host: 'shop.mango.com' }), 'Chaqueta efecto ante bolsillos');
  assert.strictEqual(stripSiteSuffix('Cárdigan cruzado - Marrón oscuro - MUJER | H&M ES', { host: 'www2.hm.com' }), 'Cárdigan cruzado - Marrón oscuro');
  assert.strictEqual(stripSiteSuffix('Jersey tacto suave - Hombre | Pull&Bear España', { host: 'www.pullandbear.com' }), 'Jersey tacto suave');
  assert.strictEqual(stripSiteSuffix('Levi\'s 501 - Original Fit', { host: 'www.levi.com' }), 'Levi\'s 501 - Original Fit');
  assert.strictEqual(stripSiteSuffix('Air Max 90', { host: 'www.nike.com' }), 'Air Max 90');
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

/* Cuando la tienda nos bloquea, el nombre sale del propio enlace. */
ok('saca el nombre del enlace de Zara', () => {
  assert.strictEqual(
    titleFromSlug('https://www.zara.com/es/es/chaqueta-vaquera-oversize-p05575046.html'),
    'Chaqueta vaquera oversize');
});
ok('saca el nombre del enlace de Vans', () => {
  assert.strictEqual(
    titleFromSlug('https://www.vans.com/es-es/p/zapatillas-old-skool-VN000D3HY28'),
    'Zapatillas old skool');
});
ok('saca el nombre de una ficha de NFL Shop', () => {
  assert.strictEqual(
    titleFromSlug('https://europe.nflshop.com/en/kansas-city-chiefs-nike-game-jersey/p-8420953'),
    'Kansas city chiefs nike game jersey');
});
ok('respeta las mayúsculas de un modelo', () => {
  assert.strictEqual(
    titleFromSlug('https://www.amazon.es/Sony-WH-1000XM5-Auriculares-Inalambricos/dp/B09XS7JWHH'),
    'Sony WH 1000XM5 Auriculares Inalambricos');
});
ok('no inventa nombre cuando el enlace no dice nada', () => {
  assert.strictEqual(titleFromSlug('https://tienda.com/p/98765'), '');
});

console.log(`\n${passed} correctas\n`);
