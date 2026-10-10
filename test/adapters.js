'use strict';
/** Adaptadores por tienda y elección del precio correcto entre varios candidatos. */

const assert = require('assert');
const { parseHtml, cleanUrl, parsePrice } = require('../lib/extract');
const { ADAPTERS } = require('../lib/adapters');

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

ok('Zalando: el título es el nombre, no la marca del primer span', () => {
  const html = `<html><body><h1><span class="brand">adidas Originals</span><span class="name">BARREL PNT D - Vaqueros boyfriend - worn blue denim</span></h1>
    <p class="price-wrapper"><span>84,95 €</span></p></body></html>`;
  const p = parseHtml(html, 'https://www.zalando.es/adidas-originals-barrel.html');
  assert.strictEqual(p.title, 'BARREL PNT D - Vaqueros boyfriend - worn blue denim');
  assert.strictEqual(p.brand, 'adidas Originals');
  assert.strictEqual(p.adapter, 'zalando');
});
ok('Douglas: ignora el nombre de variante del JSON-LD y usa el título real', () => {
  const html = `<html><head><meta property="og:title" content="Dior Homme Parfum | DOUGLAS">
    <script type="application/ld+json">{"@type":"Product","name":"50 ml","offers":{"@type":"Offer","price":"97","priceCurrency":"EUR"}}</script></head>
    <body><h1>Dior Homme Parfum</h1></body></html>`;
  const p = parseHtml(html, 'https://www.douglas.es/es/p/5011687008');
  assert.strictEqual(p.title, 'Dior Homme Parfum | DOUGLAS');
  assert.strictEqual(p.priceRaw, '97');
});
ok('precio sin separador de miles: 1469 es 1469, no 146', () => {
  assert.strictEqual(parsePrice('1469', 'EUR').value, 1469);
  assert.strictEqual(parsePrice('1539 €').value, 1539);
  assert.strictEqual(parsePrice('1379.00', 'EUR').value, 1379);
  assert.strictEqual(parsePrice('1.469 €').value, 1469);
  assert.strictEqual(parsePrice('5,91€5,91€').value, 5.91);
  assert.strictEqual(parsePrice('12,74€12,74€').value, 12.74);
});
(async () => {
  const depop = ADAPTERS.find((a) => a.name === 'depop');
  const asos = ADAPTERS.find((a) => a.name === 'asos');
  let calls = [];
  const fetchText = async (url) => {
    calls.push(url);
    if (url.includes('depop')) return JSON.stringify({ description: 'Carhartt Men\'s Tan and Brown Jacket\nGreat condition', price: { priceAmount: '108.89', currencyName: 'EUR' }, pictures: [[{ url: 'https://img/small.jpg', width: 150 }, { url: 'https://img/big.jpg', width: 640 }]], brandName: 'Carhartt' });
    if (url.includes('asos')) return JSON.stringify([{ productId: 12345, productPrice: { current: { value: 24.99, currency: 'EUR' } } }]);
    return null;
  };
  try {
    const d = await depop.resolve('https://www.depop.com/products/user-carhartt-jacket/', { fetchText });
    assert.strictEqual(d.title, 'Carhartt Men\'s Tan and Brown Jacket');
    assert.strictEqual(d.priceRaw, '108.89');
    assert.strictEqual(d.image, 'https://img/big.jpg');
    const a = await asos.resolve('https://www.asos.com/es/levis/vaqueros/prd/12345?x=1', { fetchText });
    assert.strictEqual(a.priceRaw, '24.99');
    assert.ok(calls[1].includes('productIds=12345'));
    passed++; console.log('  ✓ Depop y ASOS: precio y foto desde su API');
  } catch (err) { console.log('  ✗ Depop y ASOS: precio y foto desde su API →', err.message); process.exitCode = 1; }
  console.log(`\n${passed} correctas\n`);
})();
