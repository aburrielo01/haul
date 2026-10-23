'use strict';
/** Búsqueda de un producto por el texto que comparten las apps de las tiendas. */
const assert = require('assert');
const { findByText, parseShareText } = require('../lib/find');

let n = 0;
function ok(name, fn) { return Promise.resolve().then(fn).then(() => { n++; console.log('  ✓', name); }, (e) => { console.log('  ✗', name, e.message); process.exitCode = 1; }); }

const results = `<html><body>
<a href="/converse-chuck-taylor-all-star-unisex-zapatillas-altas-black-co413c01c-q11.html">x</a>
<a href="https://www.zalando.es/converse-all-star-hi-altas-co415a03c-802.html">y</a>
<a href="/adidas-originals-samba-og-unisex-zapatillas-white-ad115o0qb-a11.html">z</a>
<a href="/mujer/">cat</a>
</body></html>`;
const fetchText = async () => results;

(async () => {
  console.log('\nHaul · búsqueda por nombre\n');
  await ok('reconoce el texto de Zalando y saca la consulta', () => {
    const p = parseShareText('Artículos fantásticos en Zalando: Converse-CHUCK TAYLOR ALL STAR UNISEX - Zapatillas altas - black');
    assert.strictEqual(p.store.name, 'zalando');
    assert.strictEqual(p.query, 'Converse CHUCK TAYLOR ALL STAR UNISEX Zapatillas altas black');
  });
  await ok('un texto con enlace o de otra tienda no se busca', () => {
    assert.strictEqual(parseShareText('Mira https://www.zara.com/x.html'), null);
    assert.strictEqual(parseShareText('Mira esto en Zara: camisa'), null);
  });
  await ok('elige la ficha que mejor coincide con el nombre', async () => {
    const r = await findByText('Artículos fantásticos en Zalando: Converse-CHUCK TAYLOR ALL STAR UNISEX - Zapatillas altas - black', { fetchText });
    assert.strictEqual(r.url, 'https://www.zalando.es/converse-chuck-taylor-all-star-unisex-zapatillas-altas-black-co413c01c-q11.html');
    assert.strictEqual(r.match, 100);
  });
  await ok('acepta tildes y mayúsculas distintas', async () => {
    const r = await findByText('Great items on Zalando: adidas Originals-SAMBA OG UNISEX - Zapatillas - White', { fetchText });
    assert.ok(/samba-og/.test(r.url), r.url);
  });
  await ok('no inventa cuando nada se parece', async () => {
    const r = await findByText('Artículos fantásticos en Zalando: Nike-AIR FORCE 1 - Zapatillas - white', { fetchText });
    assert.strictEqual(r.url, '');
  });
  await ok('sin resultados devuelve vacío, no error', async () => {
    const r = await findByText('Artículos fantásticos en Zalando: Converse-CHUCK TAYLOR', { fetchText: async () => null });
    assert.strictEqual(r.url, '');
  });
  console.log(`\n${n} correctas\n`);
})();
