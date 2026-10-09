'use strict';
/**
 * Pruebas del desbloqueador contra un servidor falso que imita a Bright Data.
 * No gasta créditos ni necesita conexión.
 */

const http = require('http');
const assert = require('assert');

const ZARA_HTML = `<!doctype html><html><head>
<title>Chaqueta vaquera oversize - ZARA España</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product",
"name":"CHAQUETA VAQUERA OVERSIZE","image":["https://static.zara.net/photos/chaqueta.jpg"],
"brand":{"@type":"Brand","name":"ZARA"},
"offers":{"@type":"Offer","price":"39.95","priceCurrency":"EUR","availability":"https://schema.org/InStock"}}</script>
</head><body><h1>Chaqueta vaquera oversize</h1></body></html>`;

const WALL_HTML = '<html><head><title>Access Denied</title></head><body>Reference #18.abc</body></html>';

let received = [];
let mode = 'ok';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    received.push({ auth: req.headers.authorization, body: JSON.parse(body || '{}') });
    if (mode === 'error') { res.writeHead(502, { 'x-brd-error': 'fallo de prueba' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(mode === 'wall' ? WALL_HTML : ZARA_HTML);
  });
});

let passed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (err) { console.log('  ✗', name, '→', err.message); process.exitCode = 1; }
}

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address();
  process.env.BRIGHTDATA_API_KEY = 'clave-de-prueba';
  process.env.BRIGHTDATA_UNLOCKER_ZONE = 'haul_unlocker';
  process.env.BRIGHTDATA_ENDPOINT = `http://127.0.0.1:${port}/request`;
  process.env.UNLOCKER_DAILY_LIMIT = '3';
  const { viaUnlocker, unlockerEnabled } = require('../lib/extract');

  console.log('\nHaul · desbloqueador\n');
  const url = 'https://www.zara.com/es/es/chaqueta-vaquera-oversize-p05575046.html';

  await ok('se activa solo con clave y zona', () => {
    assert.strictEqual(unlockerEnabled(), true);
  });

  await ok('lee una ficha protegida y saca nombre, foto y precio', async () => {
    const r = await viaUnlocker(url);
    assert.ok(r, 'sin resultado');
    assert.strictEqual(r.parsed.title, 'CHAQUETA VAQUERA OVERSIZE');
    assert.strictEqual(r.parsed.image, 'https://static.zara.net/photos/chaqueta.jpg');
    assert.strictEqual(r.parsed.priceRaw, '39.95');
    assert.strictEqual(r.parsed.currency, 'EUR');
  });

  await ok('envía la clave, la zona y el país correctos', () => {
    const last = received[received.length - 1];
    assert.strictEqual(last.auth, 'Bearer clave-de-prueba');
    assert.strictEqual(last.body.zone, 'haul_unlocker');
    assert.strictEqual(last.body.url, url);
    assert.strictEqual(last.body.format, 'raw');
    assert.strictEqual(last.body.country, 'es');
  });

  await ok('si aun así devuelve un muro anti-bot, no lo da por bueno', async () => {
    mode = 'wall';
    assert.strictEqual(await viaUnlocker(url), null);
  });

  await ok('un error del servicio no rompe nada', async () => {
    mode = 'error';
    assert.strictEqual(await viaUnlocker(url), null);
  });

  await ok('respeta el tope diario para proteger la factura', async () => {
    mode = 'ok';
    const before = received.length;
    assert.strictEqual(await viaUnlocker(url), null, 'debería haberse cortado');
    assert.strictEqual(received.length, before, 'no debería haber llamado al servicio');
  });

  console.log(`\n${passed} correctas\n`);
  server.close();
});
