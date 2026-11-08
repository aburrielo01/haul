'use strict';
/**
 * AWIN: enlaces de afiliado por lotes y precios desde el feed, con la API
 * simulada (fetch falso) y la base de datos real en un directorio temporal.
 */
const assert = require('assert');
const path = require('path');
process.env.DATA_DIR = path.join(require('os').tmpdir(), 'haul-awin-test-' + Date.now());
process.env.AWIN_PUBLISHER_ID = '12345';
process.env.AWIN_TOKEN = 'token-de-prueba';
process.env.AWIN_ADVERTISERS = 'zalando.es=111:es_ES, asos.com=222:es_ES';
process.env.AWIN_FEED_PAUSE_MS = '0';
process.env.WATCH = 'off';

const db = require('../lib/db');
const awin = require('../lib/awin');
const { checkItem } = require('../lib/watch');

let passed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (err) { console.log('  ✗', name, '→', err.message); process.exitCode = 1; }
}

const formatPrice = (v, c) => `${v.toFixed(2).replace('.', ',')} ${c === 'EUR' ? '€' : c}`;

(async () => {
  await db.init();
  console.log('\nHaul · AWIN\n');

  await ok('la lista de anunciantes se lee de la variable y casa por dominio', () => {
    assert.deepStrictEqual(awin.parseAdvertisers('zalando.es=111:es_ES, asos.com=222'), [
      { host: 'zalando.es', id: 111, locale: 'es_ES' }, { host: 'asos.com', id: 222, locale: 'es_ES' },
    ]);
    assert.strictEqual(awin.advertiserFor('https://www.zalando.es/reebok-re015o0hk-a12.html').id, 111);
    assert.strictEqual(awin.advertiserFor('https://m.asos.com/es/prd/1').id, 222);
    assert.strictEqual(awin.advertiserFor('https://www.zara.com/es/p1.html'), null);
    assert.strictEqual(awin.enabled(), true);
  });

  await ok('dos enlaces al mismo producto coinciden aunque cambien parámetros o mayúsculas', () => {
    assert.strictEqual(awin.normalizeLink('https://www.zalando.es/Reebok-RE015O0HK-A12.html?size=42&utm=x#top'), 'zalando.es/reebok-re015o0hk-a12.html');
    assert.strictEqual(awin.normalizeLink('http://zalando.es/reebok-re015o0hk-a12.html/'), 'zalando.es/reebok-re015o0hk-a12.html');
  });

  await ok('el precio del feed se entiende y el rebajado manda; sin stock no hay precio', () => {
    assert.deepStrictEqual(awin.parseFeedPrice('79.95 EUR'), { value: 79.95, currency: 'EUR' });
    assert.strictEqual(awin.parseFeedPrice('gratis'), null);
    const r = awin.resultFromRow({ title: 'Club C 85', price: '99.95 EUR', sale_price: '79.95 EUR', image_link: 'https://x/i.jpg', availability: 'in_stock' }, formatPrice);
    assert.strictEqual(r.priceValue, 79.95);
    assert.strictEqual(r.priceText, '79,95 €');
    assert.strictEqual(r.mode, 'awin');
    assert.strictEqual(awin.resultFromRow({ price: '10.00 EUR', availability: 'out_of_stock' }).ok, false);
    assert.strictEqual(awin.resultFromRow({ price: '10.00 EUR', availability: 'out_ouf_stock' }).ok, false); // tal cual lo escribe AWIN
  });

  // piezas reales en la base temporal
  const list = await db.createList({ name: 'Prueba AWIN', emoji: '✦', theme: '', visibility: 'private', ownerName: '' });
  const zal = await db.addItem(list.id, { title: 'Reebok Club C 85', url: 'https://www.zalando.es/reebok-classic-club-c-85-re015o0hk-a12.html?size=42', priceValue: 99.95, priceText: '99,95 €', currency: 'EUR', shop: 'Zalando', source: 'url' });
  const asos = await db.addItem(list.id, { title: 'Camiseta', url: 'https://www.asos.com/es/prd/2', priceValue: 20, priceText: '20,00 €', currency: 'EUR', shop: 'ASOS', source: 'url' });
  const zara = await db.addItem(list.id, { title: 'Pantalón', url: 'https://www.zara.com/es/p1.html', priceValue: 30, priceText: '30,00 €', currency: 'EUR', shop: 'Zara', source: 'url' });

  await ok('los enlaces de afiliado se piden por lotes y se guardan; el denegado se anota', async () => {
    const seen = [];
    awin._setFetch(async (url, opts) => {
      seen.push({ url, body: JSON.parse(opts.body) });
      assert.strictEqual(opts.headers.authorization, 'Bearer token-de-prueba');
      const responses = JSON.parse(opts.body).requests.map((r) => (r.advertiserId === 111
        ? { status: 200, body: { url: 'https://www.awin1.com/cread.php?awinmid=111&ued=' + encodeURIComponent(r.destinationUrl) }, request: r }
        : { status: 400, body: { destinationUrl: 'deeplinkNotPermitted' }, request: r }));
      return new Response(JSON.stringify({ responses }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const out = await awin.tickLinks({ db });
    assert.deepStrictEqual(out, { generated: 1, denied: 1, failed: 0 });
    assert.strictEqual(seen.length, 1, 'una sola petición por lote');
    assert.ok(seen[0].url.endsWith('/publishers/12345/linkbuilder/generate-batch'));
    assert.strictEqual(seen[0].body.requests.length, 2, 'Zara no está en AWIN: no se pide');
    const z = await db.getItem(list.id, zal.id);
    assert.ok(z.affiliate_url.startsWith('https://www.awin1.com/'));
    const a = await db.getItem(list.id, asos.id);
    assert.strictEqual(a.affiliate_url, '');
    assert.ok(a.affiliate_at > 0, 'denegado: anotado para no insistir');
    const r = await db.getItem(list.id, zara.id);
    assert.strictEqual(r.affiliate_at, null);
    // la siguiente pasada no vuelve a pedir nada
    const again = await awin.tickLinks({ db });
    assert.deepStrictEqual(again, { generated: 0, denied: 0, failed: 0 });
    assert.strictEqual(seen.length, 1);
  });

  await ok('el feed se lee en streaming y solo se queda con las piezas de HAUL', async () => {
    const lines = [
      { id: '1', title: 'Otra cosa', price: '10.00 EUR', link: 'https://www.zalando.es/otra-cosa.html' },
      { id: '2', title: 'Reebok Classic CLUB C 85', price: '99.95 EUR', sale_price: '79.95 EUR', link: 'https://www.zalando.es/reebok-classic-club-c-85-re015o0hk-a12.html?wmc=feed', image_link: 'https://img/x.jpg', availability: 'in_stock' },
      { id: '3', title: 'Más', price: '5.00 EUR', link: 'https://www.zalando.es/mas.html' },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n';
    awin._setFetch(async (url) => {
      assert.ok(url.endsWith('/publishers/12345/awinfeeds/download/111-retail-es_ES.jsonl'), url);
      return new Response(lines, { status: 200 });
    });
    const wanted = new Map([[awin.normalizeLink(zal.url), [zal]]]);
    const { found, lines: n } = await awin.streamFeed({ id: 111, locale: 'es_ES', host: 'zalando.es' }, wanted);
    assert.strictEqual(found.size, 1);
    assert.strictEqual([...found.values()][0].id, '2');
    assert.ok(n >= 2 && n <= 3, 'para en cuanto tiene todo lo que busca');
  });

  await ok('con el feed, la pieza cambia de precio por el mismo camino que el vigilante (y avisa la bajada)', async () => {
    const feedLine = JSON.stringify({ id: '2', title: 'Reebok Classic CLUB C 85', price: '99.95 EUR', sale_price: '79.95 EUR', link: 'https://www.zalando.es/reebok-classic-club-c-85-re015o0hk-a12.html', availability: 'in_stock' }) + '\n';
    const asosLine = JSON.stringify({ id: '9', title: 'Camiseta', price: '20.00 EUR', link: 'https://www.asos.com/es/prd/2', availability: 'out_of_stock' }) + '\n';
    const fetched = [];
    awin._setFetch(async (url) => { fetched.push(url); return new Response(url.includes('/111-') ? feedLine : asosLine, { status: 200 }); });
    const notified = [];
    const out = await awin.refreshFeeds({ db, checkItem, notify: async (ev) => { notified.push(ev); }, formatPrice });
    assert.strictEqual(out.advertisers, 2);
    assert.strictEqual(out.matched, 2);
    assert.strictEqual(out.updated, 1, 'ASOS sin stock no cuenta como precio');
    const z = await db.getItem(list.id, zal.id);
    assert.strictEqual(Number(z.price_value), 79.95);
    assert.strictEqual(Number(z.prev_price), 99.95);
    assert.strictEqual(z.price_text, '79,95 €');
    assert.strictEqual(notified.length, 1);
    assert.strictEqual(notified[0].pct, -20);
    const a = await db.getItem(list.id, asos.id);
    assert.strictEqual(Number(a.price_value), 20, 'sin stock: el precio no se toca');
    assert.ok(a.checked_at > 0, 'pero cuenta como comprobada');
    assert.strictEqual(fetched.length, 2);
  });

  await ok('un feed que acaba en error no tumba la pasada', async () => {
    awin._setFetch(async () => new Response('{"error":500,"message":"Internal server error"}\n', { status: 200 }));
    const out = await awin.refreshFeeds({ db, checkItem, formatPrice });
    assert.strictEqual(out.errors, 2);
    assert.strictEqual(out.updated, 0);
  });

  await ok('las estadísticas cuentan lo hecho', () => {
    const s = awin.stats();
    assert.strictEqual(s.enabled, true);
    assert.deepStrictEqual(s.configured.advertisers, ['zalando.es', 'asos.com']);
    assert.strictEqual(s.links.generated, 1);
    assert.strictEqual(s.links.denied, 1);
    assert.ok(s.feeds.lastRun > 0);
  });

  console.log(`\n${passed} correctas\n`);
  process.exit(process.exitCode || 0);
})();
