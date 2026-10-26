'use strict';
/**
 * Banco de pruebas en local, sin servidor: pasa las URLs de bench-urls.json por
 * el lector real y enseña, fila a fila, qué leyó y por qué falló.
 *
 *   node test/bench-local.js                       los 100
 *   node test/bench-local.js --ids E011,E033       solo esos
 *   node test/bench-local.js --shop Zara --out /tmp/zara.json
 *
 * Usa las mismas variables que el servidor (BRIGHTDATA_API_KEY, etc.). Sin
 * ellas, las tiendas con anti-bot salen como "muro": es lo esperado. Con
 * Chromium instalado (`npx playwright install chromium`) prueba también el
 * navegador. Guarda el detalle en JSON (por defecto, test/bench-local.json).
 */
const path = require('path');
const fs = require('fs');
const extract = require('../lib/extract');
const bench = require('../lib/bench');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const ids = opt('ids', '') ? opt('ids').split(',').map((x) => x.trim()) : null;
const shop = opt('shop', '');
const out = opt('out', path.join(__dirname, 'bench-local.json'));
const concurrency = Math.max(1, Number(opt('concurrency', 3)));
const TIMEOUT = Number(opt('timeout', 60000));

let items = bench.loadItems();
if (ids) items = items.filter((i) => ids.includes(i.id));
if (shop) items = items.filter((i) => i.shop.toLowerCase() === shop.toLowerCase());
if (!items.length) { console.error('Ningún enlace coincide con el filtro'); process.exit(1); }

const rows = [];
const queue = items.slice();
async function worker() {
  while (queue.length) {
    const item = queue.shift();
    const t = Date.now();
    let result = null;
    try {
      result = await Promise.race([
        extract.extractFromUrl(item.url),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`sin respuesta en ${TIMEOUT / 1000}s`)), TIMEOUT)),
      ]);
    } catch (err) {
      result = { ok: false, message: String(err && err.message).slice(0, 160), mode: 'error', trail: err && err.trail };
    }
    const g = bench.grade(item, result);
    rows.push({
      id: item.id, shop: item.shop, url: item.url,
      expected: { title: item.title, price: item.price, note: item.note, verified: item.verified || '', tolerance: item.tolerance || null },
      grade: g, ms: Date.now() - t,
      ...(g.ok ? {} : { trail: (result && result.trail) || [] }),
    });
    const got = g.got ? `${g.got.title.slice(0, 40)} · ${g.got.priceText || 'sin precio'}` : g.error;
    console.log(`${g.ok ? '✓' : '✗'} ${item.id} ${item.shop.padEnd(16)} ${String(g.mode || '').padEnd(13)} nombre:${g.title ? '✓' : '✗'} precio:${g.price ? '✓' : '✗'} foto:${g.image ? '✓' : '✗'} ${Math.round((Date.now() - t) / 100) / 10}s${g.ok ? '' : '  → ' + got}`);
  }
}

(async () => {
  console.log(`\nHaul · banco en local · ${items.length} enlaces · desbloqueador ${extract.unlockerEnabled() ? 'activo' : 'apagado'}\n`);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const summary = bench.summarize(rows);
  fs.writeFileSync(out, JSON.stringify({ at: Date.now(), summary, rows }, null, 1));
  console.log(`\n${summary.ok}/${summary.total} perfectos · nombre ${summary.pctTitle}% · precio ${summary.pctPrice}% · foto ${summary.pctImage}% · errores ${summary.failed}`);
  console.log('por modo:', Object.entries(summary.byMode).map(([k, v]) => `${k} ${v}`).join(' · '));
  const walls = rows.filter((r) => !r.grade.ok && (r.trail || []).some((t) => t.result === 'muro'));
  if (walls.length) console.log(`muros anti-bot (en producción van al desbloqueador): ${walls.map((r) => r.id).join(' ')}`);
  console.log(`detalle en ${out}\n`);
  await extract.close();
  process.exit(0);
})();
