'use strict';
/**
 * Golden set de Haul · hipótesis H1 (extracción)
 *
 * Pasa una lista de URLs por el extractor del servidor desplegado y calcula
 * qué porcentaje sale con nombre, foto y precio correctos.
 *
 * Se lanza contra producción a propósito: las tiendas bloquean las IPs de
 * centros de datos, así que probar desde casa daría resultados optimistas.
 *
 *   node test/golden.js
 *   HAUL_URL=http://localhost:3000 node test/golden.js
 *
 * Entrada: test/golden.csv, con cabecera. Columnas que usa:
 *   tienda · caso · esperado · precio_web · url   (id y referencia son informativas)
 *
 *   esperado = producto | rechazo | limite
 *     producto → ficha real: debe sacar nombre, foto y el precio correcto
 *     rechazo  → no es un producto (listado, portada, anuncio borrado):
 *                acierta si Haul NO devuelve precio. No cuenta para el 80 %.
 *     limite   → caso raro: se enseña lo que devuelve, no puntúa
 *
 * Sin precio_web la fila queda "provisional": Haul sacó los tres datos, pero
 * nadie ha comprobado que el precio sea el bueno.
 *
 * Acepta ; o , como separador y campos entre comillas (lo que exporta Excel).
 * Salida: test/golden-resultados.csv (separado por ; para Excel en español).
 */

const fs = require('fs');
const path = require('path');

const BASE = (process.env.HAUL_URL || 'https://haul-o6sv.onrender.com').replace(/\/+$/, '');
const INPUT = process.argv[2] || path.join(__dirname, 'golden.csv');
const OUTPUT = path.join(path.dirname(INPUT), 'golden-resultados.csv');

const PAUSE_MS = 3200;        // el servidor admite 20 extracciones por minuto e IP
const TIMEOUT_MS = 120_000;   // la cascada completa (fetch → Chromium → desbloqueador) es larga
const SLOW_S = 10;            // más lento que esto cuenta como fallo aunque acierte
const KEY_STORES = ['Zara', 'Shein', 'Bershka']; // deben acertar 2 de 3 sí o sí

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

/* --------------------------------------------------------------- entrada */

/** CSV con comillas; el separador (; o ,) se deduce de la cabecera. */
function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => firstLine.split(ch).length - 1;
  const delim = count(';') >= count(',') ? ';' : ',';

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row);
      row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const COLUMNS = {
  id: ['id'],
  tienda: ['tienda'],
  caso: ['caso', 'tipo'],
  esperado: ['esperado'],
  precioWeb: ['precio_web', 'precio web'],
  url: ['url'],
  referencia: ['referencia', 'referencia / producto'],
};

function readRows(file) {
  let text = fs.readFileSync(file, 'utf8');
  // un CSV guardado por Excel en formato Windows no es UTF-8
  if (text.includes('\uFFFD')) text = fs.readFileSync(file, 'latin1');
  const [head = [], ...lines] = parseCsv(text.replace(/^\uFEFF/, ''));

  const names = head.map((h) => h.trim().toLowerCase());
  const idx = {};
  for (const [key, aliases] of Object.entries(COLUMNS)) idx[key] = names.findIndex((h) => aliases.includes(h));
  if (idx.url < 0) throw new Error('golden.csv no tiene una columna "url"');
  const get = (line, key) => (idx[key] >= 0 ? String(line[idx[key]] || '').trim() : '');

  return lines.map((line, n) => {
    const esperado = get(line, 'esperado').toLowerCase().replace('í', 'i');
    return {
      id: get(line, 'id') || String(n + 1),
      tienda: get(line, 'tienda'),
      caso: get(line, 'caso'),
      esperado: ['rechazo', 'limite'].includes(esperado) ? esperado : 'producto',
      precioWeb: get(line, 'precioWeb'),
      referencia: get(line, 'referencia'),
      url: get(line, 'url'),
    };
  });
}

/** "29,95 €" · "1.299,00" · "29.95" → número */
function toNumber(text) {
  let t = String(text || '').replace(/[^\d.,]/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/\.\d{3}$/.test(t)) t = t.replace(/\./g, '');
  const v = Number.parseFloat(t);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/* ------------------------------------------------------------ extracción */

async function extract(url) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(BASE + '/api/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 429 && attempt === 1) {
        process.stdout.write('(límite de peticiones, espero un minuto) ');
        await sleep(61_000);
        continue;
      }
      if (!res.ok || data.ok === false) data.code = data.code || `HTTP_${res.status}`;
      return { data, seconds: (Date.now() - started) / 1000 };
    } catch (err) {
      const code = err.name === 'AbortError' ? 'TIMEOUT' : 'RED';
      return { data: { ok: false, code }, seconds: (Date.now() - started) / 1000 };
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ------------------------------------------------------------ evaluación */

/** resultado: bien | mal | provisional (productos) · bien | mal (rechazos) · info (límites) */
function evaluate(row, { data, seconds }) {
  const ok = data.ok !== false && !!data.title;
  const valor = Number.isFinite(data.priceValue) ? data.priceValue : null;
  const base = { ...row, ok, valor, seconds, data };

  // una página que no es un producto no debería acabar guardada con precio
  if (row.esperado === 'rechazo') return { ...base, resultado: valor === null ? 'bien' : 'mal' };
  if (row.esperado === 'limite') return { ...base, resultado: 'info' };

  const esperado = toNumber(row.precioWeb);
  const nombre = ok && String(data.title).trim().toLowerCase() !== 'producto';
  const foto = ok && !!data.image;
  let precio;
  if (valor === null) precio = false;
  else if (esperado === null) precio = null; // sin referencia: nadie lo ha comprobado
  else precio = Math.abs(valor - esperado) <= Math.max(0.05, esperado * 0.01);
  // lo que viene de la caché no dice nada del tiempo real
  const lento = !data.cached && seconds > SLOW_S;

  let resultado;
  if (!nombre || !foto || lento || valor === null || precio === false) resultado = 'mal';
  else resultado = precio === true ? 'bien' : 'provisional';
  return { ...base, nombre, foto, precio, lento, resultado };
}

function reason(r) {
  if (r.esperado === 'rechazo') {
    return r.resultado === 'bien'
      ? `no guarda precio${r.ok ? '' : ` (${r.data.code})`}`
      : `se inventa un producto a ${r.data.priceText || r.valor}`;
  }
  if (r.esperado === 'limite') return r.ok ? `devuelve ${r.data.priceText || 'sin precio'}` : r.data.code;
  if (!r.ok) return r.data.code || 'error';
  const out = [r.data.mode];
  if (!r.nombre) out.push('sin nombre');
  if (!r.foto) out.push('sin foto');
  if (r.valor === null) out.push('sin precio');
  else if (r.precio === false) out.push(`precio ${r.data.priceText} ≠ ${r.precioWeb}`);
  else if (r.precio === null) out.push(`precio ${r.data.priceText} sin comprobar`);
  if (r.lento) out.push('lento');
  if (r.data.cached) out.push('caché');
  return out.filter(Boolean).join(', ');
}

const MARK = { bien: '✓', mal: '✗', provisional: '~', info: '·' };

/* ---------------------------------------------------------------- salida */

const cell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const yesNo = (b) => (b === undefined ? '' : b === null ? 'revisar' : b ? 'sí' : 'no');

function writeCsv(results) {
  const head = [
    'id', 'tienda', 'caso', 'esperado', 'resultado', 'estado', 'modo', 'segundos', 'cache',
    'nombre', 'foto', 'precio_haul', 'precio_web', 'tienda_haul',
    'nombre_ok', 'foto_ok', 'precio_ok', 'url',
  ];
  const lines = results.map((r) => [
    r.id, r.tienda, r.caso, r.esperado, r.resultado,
    r.ok ? 'ok' : r.data.code || 'error', r.data.mode || '',
    r.seconds.toFixed(1).replace('.', ','), r.data.cached ? 'sí' : '',
    r.data.title || '', r.data.image || '', r.data.priceText || '', r.precioWeb, r.data.shop || '',
    yesNo(r.nombre), yesNo(r.foto), yesNo(r.precio), r.url,
  ].map(cell).join(';'));
  // el BOM hace que Excel lea bien las tildes
  fs.writeFileSync(OUTPUT, '\uFEFF' + [head.join(';'), ...lines].join('\r\n'));
}

function summary(results, health) {
  const prod = results.filter((r) => r.esperado === 'producto');
  const rech = results.filter((r) => r.esperado === 'rechazo');
  const lim = results.filter((r) => r.esperado === 'limite');
  const n = (list, res) => list.filter((r) => r.resultado === res).length;

  const bien = n(prod, 'bien');
  const prov = n(prod, 'provisional');
  const p = pct(bien + prov, prod.length);

  const stores = new Map();
  for (const r of prod) {
    const key = r.tienda || '—';
    const s = stores.get(key) || { total: 0, ok: 0, prov: 0 };
    s.total++;
    if (r.resultado !== 'mal') s.ok++;
    if (r.resultado === 'provisional') s.prov++;
    stores.set(key, s);
  }
  const find = (name) => [...stores].find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  const keyFails = KEY_STORES.filter((name) => (find(name)?.ok || 0) < 2);

  let verdict = p >= 80 ? 'VERDE' : p >= 65 ? 'ÁMBAR' : 'ROJO';
  if (keyFails.length) verdict = 'ROJO';

  const count = (fn) => prod.filter(fn).length;
  const width = Math.max(8, ...[...stores.keys()].map((k) => k.length)) + 2;

  console.log('\n────────────────────────────────────────────');
  console.log('H1 · Extracción — golden set');
  console.log(`Servidor ${BASE} · desbloqueador ${health.unlocker ? 'activo' : 'inactivo'}`);

  console.log(`\nFichas de producto con nombre, foto y precio: ${bien + prov} de ${prod.length} (${p} %)`);
  console.log(`  precio comprobado: ${bien} · precio sin comprobar: ${prov}`);
  console.log(`  bloqueadas por la tienda: ${count((r) => r.data.code === 'BLOCKED')}` +
    ` · otros errores: ${count((r) => !r.ok && r.data.code !== 'BLOCKED')}` +
    ` · lentas (>${SLOW_S} s): ${count((r) => r.lento)}` +
    ` · desde caché: ${count((r) => r.data.cached)}`);

  console.log('\nPor tienda (con los tres datos / fichas):');
  for (const [name, s] of stores) {
    const key = KEY_STORES.some((k) => k.toLowerCase() === name.toLowerCase());
    const flag = key ? (s.ok >= 2 ? '  clave ✓' : '  clave ✗') : '';
    const note = s.prov ? `  (${s.prov} sin comprobar)` : '';
    console.log(`  ${name.padEnd(width)}${s.ok}/${s.total}${flag}${note}`);
  }

  if (rech.length) {
    console.log(`\nControles negativos (no deben guardar precio): ${n(rech, 'bien')} de ${rech.length} bien`);
    for (const r of rech.filter((x) => x.resultado === 'mal')) {
      console.log(`  ✗ #${r.id} ${r.tienda} · ${r.referencia || r.caso}: ${reason(r)}`);
    }
  }
  if (lim.length) {
    console.log('\nCasos límite (no puntúan):');
    for (const r of lim) console.log(`  · #${r.id} ${r.tienda} · ${r.referencia || r.caso}: ${reason(r)}`);
  }

  console.log(`\nTiendas clave (${KEY_STORES.join(', ')} ≥ 2 de 3): ` +
    (keyFails.length ? `no se cumple en ${keyFails.join(', ')}` : 'se cumple'));
  console.log(`Veredicto H1: ${verdict}` +
    (keyFails.length && p >= 65 ? ' (por las tiendas clave, aunque la media dé más)' : ''));
  if (prov) {
    console.log(`  PROVISIONAL: faltan ${prov} precios por comprobar; al comprobarlos el porcentaje solo puede bajar.`);
  }
  console.log(`\nDetalle en ${path.relative(process.cwd(), OUTPUT) || OUTPUT}`);
  console.log('Falta revisar a mano las fotos: el script sabe si hay imagen, no si es el producto.');
}

/* -------------------------------------------------------------- arranque */

async function main() {
  if (!fs.existsSync(INPUT)) {
    console.error(`No encuentro ${INPUT}`);
    process.exit(1);
  }
  const all = readRows(INPUT);
  const rows = all.filter((r) => /^https?:\/\//i.test(r.url));
  if (!rows.length) {
    console.error('golden.csv aún no tiene ninguna URL');
    process.exit(1);
  }

  const health = await fetch(BASE + '/api/health').then((r) => r.json()).catch(() => null);
  if (!health || !health.ok) {
    console.error(`El servidor no responde en ${BASE}`);
    process.exit(1);
  }

  console.log(`Golden set · ${rows.length} URLs contra ${BASE}` +
    (all.length > rows.length ? ` (${all.length - rows.length} filas sin URL se saltan)` : ''));
  console.log(health.unlocker
    ? 'Desbloqueador activo: esta pasada gasta parte del tope diario.\n'
    : 'Desbloqueador inactivo.\n');

  const results = [];
  for (const [i, row] of rows.entries()) {
    process.stdout.write(`[${String(i + 1).padStart(2)}/${rows.length}] #${row.id} ${row.tienda} · ${row.caso} … `);
    const r = evaluate(row, await extract(row.url));
    results.push(r);
    console.log(`${MARK[r.resultado]} ${r.seconds.toFixed(1)} s (${reason(r)})`);
    writeCsv(results); // se guarda sobre la marcha por si cortas a mitad
    if (i < rows.length - 1) await sleep(Math.max(0, PAUSE_MS - r.seconds * 1000));
  }
  summary(results, health);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
