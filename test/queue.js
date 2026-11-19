'use strict';
/**
 * Cola del navegador (4.1.3): Chromium de uno en uno. Con dos páginas a la vez
 * la instancia de Render se reinició; estas pruebas comprueban el turno, el
 * tope de la cola y la espera máxima sin abrir ningún navegador.
 */
const assert = require('assert');
process.env.BROWSER_CONCURRENCY = '1';
process.env.BROWSER_QUEUE_MAX = '2';
process.env.BROWSER_WAIT_MS = '1000'; // el mínimo que admite el lector
const extract = require('../lib/extract');
const { acquire, release } = extract._browserQueue;

let passed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (err) { console.log('  ✗', name, '→', err.message); process.exitCode = 1; }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\nHaul · cola del navegador\n');

  await ok('el primero entra sin esperar y el segundo espera su turno', async () => {
    await acquire();
    let second = false;
    const p = acquire().then(() => { second = true; });
    await tick();
    assert.strictEqual(second, false, 'el segundo entró con el navegador ocupado');
    assert.deepStrictEqual([extract.browserStats().busy, extract.browserStats().waiting], [1, 1]);
    release();
    await p;
    assert.strictEqual(second, true);
    assert.strictEqual(extract.browserStats().busy, 1, 'el hueco no pasó al siguiente');
    release();
    assert.strictEqual(extract.browserStats().busy, 0);
  });

  await ok('nunca hay más páginas abiertas que huecos', async () => {
    let open = 0;
    let max = 0;
    const job = async () => {
      await acquire();
      open++; max = Math.max(max, open);
      await tick(8);
      open--;
      release();
    };
    await Promise.all([job(), job(), job()]);
    assert.strictEqual(max, 1);
    assert.strictEqual(extract.browserStats().busy, 0);
  });

  await ok('con la cola llena, la lectura sigue sin navegador en vez de amontonarse', async () => {
    await acquire();
    const a = acquire();
    const b = acquire();
    await assert.rejects(acquire(), (err) => err.code === 'BROWSER_BUSY' && err.why === 'cola llena');
    release(); await a;
    release(); await b;
    release();
    assert.strictEqual(extract.browserStats().busy, 0);
  });

  await ok('quien espera demasiado sale de la cola y no se queda con el hueco', async () => {
    await acquire();
    await assert.rejects(acquire(), (err) => err.code === 'BROWSER_BUSY' && err.why === 'espera agotada');
    assert.strictEqual(extract.browserStats().waiting, 0);
    release();
    assert.strictEqual(extract.browserStats().busy, 0);
    await acquire(); // el hueco sigue libre para el siguiente
    release();
  });

  console.log(`\n${passed} correctas\n`);
  await extract.close().catch(() => {});
  process.exit(process.exitCode || 0);
})();
