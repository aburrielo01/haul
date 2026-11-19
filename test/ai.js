'use strict';
/**
 * Lector de capturas y rescate de fichas con Claude.
 *
 * Sin clave: se prueba la fontanería con un cliente falso (campos, caché,
 * tope diario, texto visible). Con ANTHROPIC_API_KEY en el entorno, además
 * se hace una lectura real de las capturas de test/shots/*.jpg|png si las hay.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.DATA_DIR = path.join(require('os').tmpdir(), 'haul-ai-test-' + Date.now());
require('../lib/env').load(); // la clave real, si está en .env
const REAL_KEY = process.env.ANTHROPIC_API_KEY || '';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test-falsa';
process.env.AI_DAILY_LIMIT = process.env.AI_DAILY_LIMIT || '20'; // las pruebas simuladas gastan unas 15; el resto queda para la lectura real

const db = require('../lib/db');
const ai = require('../lib/ai');

let passed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (err) { console.log('  ✗', name, '→', err.message); process.exitCode = 1; }
}

// Lado largo al que la app reduce la captura antes de mandarla a leer (public/app.js → READ_MAX).
const READ_MAX = 1568;

/** Ancho y alto de un JPEG o PNG leyendo solo la cabecera (sin dependencias). */
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function fakeClient(answer, { stop = 'end_turn' } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      parse: async (req) => {
        calls.push(req);
        return { parsed_output: typeof answer === 'function' ? answer(req) : answer, stop_reason: stop, usage: { input_tokens: 900, output_tokens: 80 } };
      },
    },
  };
}

(async () => {
  await db.init();
  ai.attachDb(db);
  console.log('\nHaul · lector con Claude\n');

  await ok('el texto visible deja fuera scripts y estilos y respeta el título', () => {
    const html = '<html><head><title>Zapatilla X · Tienda</title><style>.a{}</style></head><body><script>var a=1</script><h1>Zapatilla X</h1><p>89,95 €</p></body></html>';
    const t = ai.visibleText(html);
    assert.ok(t.startsWith('Zapatilla X · Tienda'));
    assert.ok(t.includes('89,95 €'));
    assert.ok(!t.includes('var a=1') && !t.includes('.a{}'));
  });

  await ok('una captura se lee con salida estructurada y se limpian los campos', async () => {
    const fake = fakeClient({ title: '  Reebok Club C 85  ', price: 74.949, currency: 'eur', shop: 'Zalando', url: 'no-es-url', color: 'off-white', size: '42', confidence: 0.93 });
    ai._setClient(fake);
    const got = await ai.readShot(PIXEL, { hint: { shop: 'Zalando' } });
    assert.strictEqual(got.title, 'Reebok Club C 85');
    assert.strictEqual(got.price, 74.95);
    assert.strictEqual(got.currency, 'EUR');
    assert.strictEqual(got.url, '', 'una url inválida se descarta');
    assert.strictEqual(got.model, ai.MODEL);
    const req = fake.calls[0];
    assert.strictEqual(req.model, ai.MODEL);
    assert.strictEqual(req.messages[0].content[0].type, 'image');
    assert.strictEqual(req.messages[0].content[0].source.media_type, 'image/png');
    assert.ok(req.messages[0].content[1].text.includes('Zalando'), 'la pista de tienda viaja en el prompt');
    assert.ok(req.output_config && req.output_config.format, 'pide salida estructurada');
  });

  await ok('la misma captura no se paga dos veces: sale de la caché', async () => {
    const fake = fakeClient({ title: 'Otra', price: 1, currency: 'EUR', shop: '', url: '', color: '', size: '', confidence: 1 });
    ai._setClient(fake);
    const got = await ai.readShot(PIXEL);
    assert.strictEqual(got.title, 'Reebok Club C 85', 'devuelve lo cacheado');
    assert.strictEqual(fake.calls.length, 0);
    assert.strictEqual(ai.stats().today.cached, 1);
  });

  await ok('el rescate pide solo lo que falta y no gasta en páginas vacías', async () => {
    const fake = fakeClient({ title: 'Sudadera básica', price: 19.99, currency: 'EUR', shop: 'Primark', url: '', color: '', size: '', confidence: 0.8 });
    ai._setClient(fake);
    const nada = await ai.rescueFromHtml('<html><body>hola</body></html>', 'https://x.test/p');
    assert.strictEqual(nada, null);
    assert.strictEqual(fake.calls.length, 0);
    const html = '<html><title>Primark</title><body>' + 'Sudadera básica de algodón, 19,99 €. '.repeat(20) + '</body></html>';
    const got = await ai.rescueFromHtml(html, 'https://x.test/p', { missing: ['price'] });
    assert.strictEqual(got.price, 19.99);
    assert.ok(fake.calls[0].messages[0].content[0].text.includes('Faltan: price'));
  });

  await ok('un rechazo o una respuesta sin datos devuelve null y cuenta como fallo', async () => {
    ai._setClient(fakeClient(null, { stop: 'refusal' }));
    const got = await ai.readShot(PIXEL.replace('AAAB', 'AAAC'));
    assert.strictEqual(got, null);
    assert.ok(ai.stats().today.failed >= 1);
  });

  await ok('con el tope diario cubierto no se llama más', async () => {
    const fake = fakeClient({ title: 'Z', price: 2, currency: 'EUR', shop: '', url: '', color: '', size: '', confidence: 1 });
    ai._setClient(fake);
    let i = 0;
    while (ai.stats().today.calls < ai.DAILY_LIMIT && i < ai.DAILY_LIMIT + 1) { await ai.readShot(PIXEL.replace('AAAB', 'AA' + String.fromCharCode(68 + i) + 'B')); i++; }
    const callsBefore = fake.calls.length;
    const got = await ai.readShot(PIXEL.replace('AAAB', 'AAZB'));
    assert.strictEqual(got, null, 'pasado el tope, null');
    assert.strictEqual(ai.stats().today.calls, ai.DAILY_LIMIT);
    assert.strictEqual(fake.calls.length, callsBefore, 'no llega a llamar a la API');
  });

  await ok('el gasto estimado del día sale en las estadísticas', () => {
    const s = ai.stats();
    assert.strictEqual(typeof s.today.usd, 'number');
    assert.ok(s.today.inputTokens > 0);
    assert.strictEqual(s.model, process.env.AI_MODEL || 'claude-haiku-5-5');
  });

  await ok('las capturas de prueba miden lo que manda el móvil y la prueba lee su tamaño', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const m = app.match(/const READ_MAX = (\d+);/);
    assert.ok(m, 'no encuentro READ_MAX en public/app.js');
    assert.strictEqual(Number(m[1]), READ_MAX, 'READ_MAX de la app y de la prueba no coinciden');
    const dir = path.join(__dirname, 'shots');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)) : [];
    for (const f of files) {
      const dim = imageSize(fs.readFileSync(path.join(dir, f)));
      assert.ok(dim && dim.width > 0 && dim.height > 0, `no leo el tamaño de ${f}`);
      assert.ok(Math.max(dim.width, dim.height) <= READ_MAX * 1.05, `${f} es mayor de lo que envía el móvil (${dim.width}×${dim.height})`);
    }
  });

  await ok('una captura a resolución de lectura cabe en el tope del lector', async () => {
    const fake = fakeClient({ title: 'X', price: 1, currency: 'EUR', shop: '', url: '', color: '', size: '', confidence: 0.9 });
    ai._setClient(fake);
    ai._reset(); // las pruebas anteriores agotaron el tope del día
    const before = fake.calls.length;
    assert.ok(await ai.readShot('data:image/jpeg;base64,' + 'B'.repeat(1_600_000)), 'rechazó 1,6 MB');
    assert.strictEqual(fake.calls.length, before + 1);
    assert.strictEqual(await ai.readShot('data:image/jpeg;base64,' + 'C'.repeat(3_000_000)), null, 'aceptó más de 2,9 MB');
  });

  // Lectura real, solo con clave de verdad y capturas en test/shots/
  const shotsDir = path.join(__dirname, 'shots');
  const shots = REAL_KEY && fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)) : [];
  if (shots.length) {
    ai._setClient(null); // cliente real: la clave sale del entorno (.env)
    ai._reset();          // las pruebas simuladas agotaron el tope del día
    for (const f of shots) {
      await ok(`lectura real de ${f}`, async () => {
        const buf = fs.readFileSync(path.join(shotsDir, f));
        // La app manda la captura a READ_MAX px de lado largo (public/app.js). Una
        // prueba con una imagen mayor mediría una calidad que producción no tiene.
        const dim = imageSize(buf);
        if (dim) {
          const long = Math.max(dim.width, dim.height);
          assert.ok(long <= READ_MAX * 1.05, `${f} mide ${dim.width}×${dim.height}: redúcela a ${READ_MAX} px de lado largo, que es lo que envía el móvil`);
          if (long < 900) console.log(`      · ${f} mide ${dim.width}×${dim.height}: más pequeña de lo que envía el móvil; la lectura real puede salir mejor que aquí`);
        }
        const type = /\.png$/i.test(f) ? 'image/png' : /\.webp$/i.test(f) ? 'image/webp' : 'image/jpeg';
        const t = Date.now();
        const got = await ai.readShot(buf.toString('base64'), { mediaType: type });
        const st = ai.stats();
        assert.ok(got, 'sin respuesta' + (st.lastError ? ` · ${st.lastError.type} ${st.lastError.status || ''} ${st.lastError.message}` : '') + (st.pausedUntil ? ' · en pausa' : ''));
        console.log(`      → «${got.title}» · ${got.price} ${got.currency} · ${got.shop} · ${got.color || '-'} / ${got.size || '-'} · confianza ${got.confidence} · ${Date.now() - t} ms`);
        // una captura puede no enseñar el nombre (Amazon con el precio abajo): vale con nombre o precio
        assert.ok(got.title || got.price, 'ni nombre ni precio');
      });
    }
    console.log('    gasto estimado de la tanda:', ai.stats().today.usd, 'USD');
  } else {
    console.log('  · lectura real omitida (sin ANTHROPIC_API_KEY o sin test/shots/)');
  }

  console.log(`\n${passed} correctas\n`);
  process.exit(process.exitCode || 0);
})();
