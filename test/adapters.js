'use strict';
/** Adaptadores por tienda y elección del precio correcto entre varios candidatos. */

const assert = require('assert');
const { parseHtml, cleanUrl } = require('../lib/extract');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (err) { console.log('  ✗', name, '→', err.message); process.exitCode = 1; }
}

// Ficha de libro de Amazon, con la estructura real de sus bloques: el precio
// tachado aparece ANTES que el actual, y el actual viene duplicado (oculto +
// visible partido en entero y decimales).
const AMAZON = `<!doctype html><html><head><title>Reality transurfing... : Zeland, Vadim: Amazon.es: Libros</title></head>
<body>
<div id="title_feature_div"><h1 id="title"><span id="productTitle" class="a-size-large">
   Reality transurfing: Las estrellas de la madrugada (PSICOLOGÍA)
</span></h1></div>
<div id="bylineInfo_feature_div"><div id="bylineInfo">de <a>Vadim Zeland</a> (Autor)</div></div>
<div id="imgTagWrapperId"><img id="landingImage"
  src="https://m.media-amazon.com/images/I/71abc._SY342_.jpg"
  data-old-hires="https://m.media-amazon.com/images/I/71abc._SL1500_.jpg"
  data-a-dynamic-image='{"https://m.media-amazon.com/images/I/71abc._SY425_.jpg":[425,281],"https://m.media-amazon.com/images/I/71abc._SY522_.jpg":[522,345]}'></div>
<div id="corePriceDisplay_desktop_feature_div">
  <span class="a-price a-text-price" data-a-strike="true"><span class="a-offscreen">19,90 €</span><span aria-hidden="true">19,90 €</span></span>
  <span class="a-price aok-align-center"><span class="a-offscreen">18,90 €</span><span aria-hidden="true"><span class="a-price-whole">18<span class="a-price-decimal">,</span></span><span class="a-price-fraction">90</span><span class="a-price-symbol">€</span></span></span>
</div>
<div id="tmmSwatches"><span class="slot-price"><span>Tapa blanda 18,90 €</span></span></div>
<div class="a-section"><span class="a-color-price">Precio por página 0,05 €</span></div>
</body></html>`;

console.log('\nHaul · adaptadores\n');

ok('Amazon: título limpio desde #productTitle', () => {
  const p = parseHtml(AMAZON, 'https://www.amazon.es/dp/849777728X');
  assert.strictEqual(p.title, 'Reality transurfing: Las estrellas de la madrugada (PSICOLOGÍA)');
  assert.strictEqual(p.adapter, 'amazon');
});
ok('Amazon: el precio actual, no el tachado ni el duplicado', () => {
  const p = parseHtml(AMAZON, 'https://www.amazon.es/dp/849777728X');
  assert.strictEqual(p.priceRaw, '18,90 €');
});
ok('Amazon: la foto en alta resolución', () => {
  const p = parseHtml(AMAZON, 'https://www.amazon.es/dp/849777728X');
  assert.strictEqual(p.image, 'https://m.media-amazon.com/images/I/71abc._SL1500_.jpg');
});
ok('Amazon: autor como marca y Amazon como tienda', () => {
  const p = parseHtml(AMAZON, 'https://www.amazon.es/dp/849777728X');
  assert.strictEqual(p.brand, 'Vadim Zeland');
  assert.strictEqual(p.siteName, 'Amazon');
});
ok('Amazon: la URL se reduce al ASIN', () => {
  assert.strictEqual(
    cleanUrl('https://www.amazon.es/Reality-transurfing-PSICOLOG%C3%8DA/dp/849777728X/ref=sr_1_3?crid=ZFB8&dib=eyJ2&keywords=x'),
    'https://www.amazon.es/dp/849777728X');
});

ok('tienda genérica: ignora el precio tachado aunque vaya primero', () => {
  const html = `<html><body><h1>Chaqueta</h1>
    <del class="old-price">89,00 €</del>
    <span class="price current">59,00 €</span></body></html>`;
  assert.strictEqual(parseHtml(html, 'https://tienda.com/p').priceRaw, '59,00 €');
});
ok('tienda genérica: ignora el precio por unidad', () => {
  const html = `<html><body><h1>Café</h1>
    <span class="price-per-unit">25,00 €/kg</span>
    <span class="product-price">12,50 €</span></body></html>`;
  assert.strictEqual(parseHtml(html, 'https://tienda.com/p').priceRaw, '12,50 €');
});
ok('tienda genérica: prefiere el precio declarado como dato', () => {
  const html = `<html><body><h1>Zapas</h1>
    <span class="price">desde 79 €</span>
    <meta itemprop="price" content="99.95"><meta itemprop="priceCurrency" content="EUR"></body></html>`;
  const p = parseHtml(html, 'https://tienda.com/p');
  assert.strictEqual(p.priceRaw, '99.95');
  assert.strictEqual(p.currency, 'EUR');
});

console.log(`\n${passed} correctas\n`);
