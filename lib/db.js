'use strict';
/**
 * Capa de datos de Haul.
 *
 * Usa Postgres cuando existe DATABASE_URL (producción en Render) y SQLite en
 * cualquier otro caso (desarrollo local o despliegue con disco persistente).
 * La API pública es asíncrona en ambos casos, así que el resto del servidor no
 * sabe qué motor hay debajo.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const USE_PG = !!process.env.DATABASE_URL;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

let pool = null;
let sqlite = null;

/* ------------------------------------------------------------------ util */

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'; // sin caracteres ambiguos

function token(len = 24) {
  return crypto.randomBytes(len).toString('base64url');
}

function shortId(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function slugify(name) {
  const base = String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  return (base || 'haul') + '-' + shortId(5);
}

function now() {
  return Date.now();
}

/** Convierte placeholders `?` a `$1, $2…` para Postgres. */
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/* -------------------------------------------------------------- drivers */

async function run(sql, params = []) {
  if (USE_PG) {
    await pool.query(toPg(sql), params);
    return;
  }
  sqlite.prepare(sql).run(params);
}

async function all(sql, params = []) {
  if (USE_PG) {
    const res = await pool.query(toPg(sql), params);
    return res.rows;
  }
  return sqlite.prepare(sql).all(params);
}

async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

/* ---------------------------------------------------------------- setup */

const DDL_SQLITE = [
  `CREATE TABLE IF NOT EXISTS lists (
     id            TEXT PRIMARY KEY,
     slug          TEXT UNIQUE NOT NULL,
     name          TEXT NOT NULL,
     emoji         TEXT NOT NULL DEFAULT '🛍️',
     theme         TEXT NOT NULL DEFAULT 'pink',
     visibility    TEXT NOT NULL DEFAULT 'private',
     allow_contrib INTEGER NOT NULL DEFAULT 0,
     owner_token   TEXT NOT NULL,
     collab_token  TEXT NOT NULL,
     owner_name    TEXT NOT NULL DEFAULT '',
     views         INTEGER NOT NULL DEFAULT 0,
     created_at    INTEGER NOT NULL,
     updated_at    INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS items (
     id          TEXT PRIMARY KEY,
     list_id     TEXT NOT NULL,
     title       TEXT NOT NULL,
     url         TEXT NOT NULL DEFAULT '',
     image       TEXT NOT NULL DEFAULT '',
     price_text  TEXT NOT NULL DEFAULT '',
     price_value REAL,
     currency    TEXT NOT NULL DEFAULT '',
     shop        TEXT NOT NULL DEFAULT '',
     note        TEXT NOT NULL DEFAULT '',
     source      TEXT NOT NULL DEFAULT 'url',
     bought      INTEGER NOT NULL DEFAULT 0,
     added_by    TEXT NOT NULL DEFAULT '',
     position    INTEGER NOT NULL DEFAULT 0,
     created_at  INTEGER NOT NULL,
     base_price       REAL,
     prev_price       REAL,
     low_price        REAL,
     price_changed_at INTEGER,
     checked_at       INTEGER,
     check_fails      INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id, position)`,
  `CREATE TABLE IF NOT EXISTS cache (
     k          TEXT PRIMARY KEY,
     v          TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   )`,
  // v4: cada lectura de precio deja un punto; con eso se dibuja la evolución
  `CREATE TABLE IF NOT EXISTS price_history (
     id       TEXT PRIMARY KEY,
     item_id  TEXT NOT NULL,
     list_id  TEXT NOT NULL,
     value    REAL NOT NULL,
     currency TEXT NOT NULL DEFAULT '',
     at       INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_history_item ON price_history(item_id, at)`,
  // v4: suscripciones push; `slugs` guarda en JSON las listas de ese móvil
  `CREATE TABLE IF NOT EXISTS push_subs (
     id         TEXT PRIMARY KEY,
     endpoint   TEXT UNIQUE NOT NULL,
     sub        TEXT NOT NULL,
     slugs      TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
];

const DDL_PG = [
  `CREATE TABLE IF NOT EXISTS lists (
     id            TEXT PRIMARY KEY,
     slug          TEXT UNIQUE NOT NULL,
     name          TEXT NOT NULL,
     emoji         TEXT NOT NULL DEFAULT '🛍️',
     theme         TEXT NOT NULL DEFAULT 'pink',
     visibility    TEXT NOT NULL DEFAULT 'private',
     allow_contrib INTEGER NOT NULL DEFAULT 0,
     owner_token   TEXT NOT NULL,
     collab_token  TEXT NOT NULL,
     owner_name    TEXT NOT NULL DEFAULT '',
     views         INTEGER NOT NULL DEFAULT 0,
     created_at    BIGINT NOT NULL,
     updated_at    BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS items (
     id          TEXT PRIMARY KEY,
     list_id     TEXT NOT NULL,
     title       TEXT NOT NULL,
     url         TEXT NOT NULL DEFAULT '',
     image       TEXT NOT NULL DEFAULT '',
     price_text  TEXT NOT NULL DEFAULT '',
     price_value DOUBLE PRECISION,
     currency    TEXT NOT NULL DEFAULT '',
     shop        TEXT NOT NULL DEFAULT '',
     note        TEXT NOT NULL DEFAULT '',
     source      TEXT NOT NULL DEFAULT 'url',
     bought      INTEGER NOT NULL DEFAULT 0,
     added_by    TEXT NOT NULL DEFAULT '',
     position    INTEGER NOT NULL DEFAULT 0,
     created_at  BIGINT NOT NULL,
     base_price       DOUBLE PRECISION,
     prev_price       DOUBLE PRECISION,
     low_price        DOUBLE PRECISION,
     price_changed_at BIGINT,
     checked_at       BIGINT,
     check_fails      INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id, position)`,
  `CREATE TABLE IF NOT EXISTS cache (
     k          TEXT PRIMARY KEY,
     v          TEXT NOT NULL,
     expires_at BIGINT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS price_history (
     id       TEXT PRIMARY KEY,
     item_id  TEXT NOT NULL,
     list_id  TEXT NOT NULL,
     value    DOUBLE PRECISION NOT NULL,
     currency TEXT NOT NULL DEFAULT '',
     at       BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_history_item ON price_history(item_id, at)`,
  `CREATE TABLE IF NOT EXISTS push_subs (
     id         TEXT PRIMARY KEY,
     endpoint   TEXT UNIQUE NOT NULL,
     sub        TEXT NOT NULL,
     slugs      TEXT NOT NULL DEFAULT '[]',
     created_at BIGINT NOT NULL,
     updated_at BIGINT NOT NULL
   )`,
];

/**
 * Columnas que llegaron en v4 a bases que ya existían. `CREATE TABLE IF NOT
 * EXISTS` no toca una tabla que ya está, así que se añaden a mano.
 */
const ITEM_COLUMNS_V4 = [
  ['base_price', 'REAL', 'DOUBLE PRECISION'],
  ['prev_price', 'REAL', 'DOUBLE PRECISION'],
  ['low_price', 'REAL', 'DOUBLE PRECISION'],
  ['price_changed_at', 'INTEGER', 'BIGINT'],
  ['checked_at', 'INTEGER', 'BIGINT'],
  ['check_fails', 'INTEGER NOT NULL DEFAULT 0', 'INTEGER NOT NULL DEFAULT 0'],
];

async function migrate() {
  if (USE_PG) {
    for (const [col, , type] of ITEM_COLUMNS_V4) {
      await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    }
  } else {
    const have = new Set(sqlite.prepare(`PRAGMA table_info(items)`).all().map((c) => c.name));
    for (const [col, type] of ITEM_COLUMNS_V4) {
      if (!have.has(col)) sqlite.prepare(`ALTER TABLE items ADD COLUMN ${col} ${type}`).run();
    }
  }
  // el precio con el que se guardó cada pieza es la referencia de "desde que lo tienes"
  await run(`UPDATE items SET base_price = price_value WHERE base_price IS NULL AND price_value IS NOT NULL`);
  await run(`UPDATE items SET low_price = price_value WHERE low_price IS NULL AND price_value IS NOT NULL`);
}

async function init() {
  if (USE_PG) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
      max: 5,
    });
    for (const stmt of DDL_PG) await pool.query(stmt);
    await migrate();
    return { driver: 'postgres' };
  }

  const Database = require('better-sqlite3');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  sqlite = new Database(path.join(DATA_DIR, 'haul.db'));
  sqlite.pragma('journal_mode = WAL');
  for (const stmt of DDL_SQLITE) sqlite.prepare(stmt).run();
  await migrate();
  return { driver: 'sqlite', file: path.join(DATA_DIR, 'haul.db') };
}

/* ---------------------------------------------------------------- lists */

async function createList({ name, emoji, theme, visibility, ownerName }) {
  const id = shortId(12);
  const row = {
    id,
    slug: slugify(name),
    name: String(name || 'Mi haul').slice(0, 60),
    emoji: emoji || '🛍️',
    theme: theme || 'pink',
    visibility: visibility === 'public' ? 'public' : 'private',
    allow_contrib: 0,
    owner_token: token(24),
    collab_token: token(18),
    owner_name: String(ownerName || '').slice(0, 40),
    views: 0,
    created_at: now(),
    updated_at: now(),
  };
  await run(
    `INSERT INTO lists (id,slug,name,emoji,theme,visibility,allow_contrib,owner_token,collab_token,owner_name,views,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      row.id, row.slug, row.name, row.emoji, row.theme, row.visibility,
      row.allow_contrib, row.owner_token, row.collab_token, row.owner_name,
      row.views, row.created_at, row.updated_at,
    ]
  );
  return row;
}

async function getListBySlug(slug) {
  return get(`SELECT * FROM lists WHERE slug = ?`, [String(slug || '')]);
}

async function updateList(slug, patch) {
  const fields = [];
  const params = [];
  const allowed = ['name', 'emoji', 'theme', 'visibility', 'allow_contrib', 'owner_name'];
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    fields.push(`${key} = ?`);
    params.push(patch[key]);
  }
  if (!fields.length) return getListBySlug(slug);
  fields.push('updated_at = ?');
  params.push(now(), slug);
  await run(`UPDATE lists SET ${fields.join(', ')} WHERE slug = ?`, params);
  return getListBySlug(slug);
}

async function deleteList(slug) {
  const list = await getListBySlug(slug);
  if (!list) return false;
  await run(`DELETE FROM items WHERE list_id = ?`, [list.id]);
  await run(`DELETE FROM lists WHERE id = ?`, [list.id]);
  return true;
}

async function bumpViews(slug) {
  await run(`UPDATE lists SET views = views + 1 WHERE slug = ?`, [slug]);
}

/* ---------------------------------------------------------------- items */

async function listItems(listId) {
  return all(
    `SELECT * FROM items WHERE list_id = ? ORDER BY position ASC, created_at DESC`,
    [listId]
  );
}

async function addItem(listId, data) {
  const min = await get(`SELECT MIN(position) AS p FROM items WHERE list_id = ?`, [listId]);
  const position = (min && min.p !== null && min.p !== undefined ? Number(min.p) : 0) - 1;
  const item = {
    id: shortId(10),
    list_id: listId,
    title: String(data.title || 'Producto').slice(0, 180),
    url: String(data.url || '').slice(0, 900),
    // puede ser una URL o una captura en base64, por eso el límite alto
    image: String(data.image || '').slice(0, 400_000),
    price_text: String(data.priceText || '').slice(0, 40),
    price_value: Number.isFinite(data.priceValue) ? data.priceValue : null,
    currency: String(data.currency || '').slice(0, 6),
    shop: String(data.shop || '').slice(0, 60),
    note: String(data.note || '').slice(0, 280),
    source: ['url', 'scan', 'shot', 'manual'].includes(data.source) ? data.source : 'url',
    bought: 0,
    added_by: String(data.addedBy || '').slice(0, 40),
    position,
    created_at: now(),
    // vigilancia de precios: la referencia es el precio con el que entra, y la
    // ficha se acaba de leer, así que la primera comprobación puede esperar
    base_price: Number.isFinite(data.priceValue) ? data.priceValue : null,
    prev_price: null,
    low_price: Number.isFinite(data.priceValue) ? data.priceValue : null,
    price_changed_at: null,
    checked_at: now(),
    check_fails: 0,
  };
  await run(
    `INSERT INTO items (id,list_id,title,url,image,price_text,price_value,currency,shop,note,source,bought,added_by,position,created_at,
                        base_price,prev_price,low_price,price_changed_at,checked_at,check_fails)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      item.id, item.list_id, item.title, item.url, item.image, item.price_text,
      item.price_value, item.currency, item.shop, item.note, item.source,
      item.bought, item.added_by, item.position, item.created_at,
      item.base_price, item.prev_price, item.low_price, item.price_changed_at, item.checked_at, item.check_fails,
    ]
  );
  if (item.price_value !== null) await addHistory(item, item.price_value, item.currency, { force: true });
  await run(`UPDATE lists SET updated_at = ? WHERE id = ?`, [now(), listId]);
  return item;
}

async function getItem(listId, itemId) {
  return get(`SELECT * FROM items WHERE id = ? AND list_id = ?`, [itemId, listId]);
}

/**
 * ¿Ya está este enlace en la lista? Primero el enlace exacto; si no, la misma
 * ficha con otros parámetros (talla, color…), que para el usuario es el mismo
 * producto dos veces.
 */
async function findItemByUrl(listId, url) {
  const clean = String(url || '').trim();
  if (!clean) return null;
  let stem = '';
  try {
    const u = new URL(clean);
    // sin ruta (tienda.com/?pid=…) el producto va en la query: solo vale el enlace exacto
    if (u.pathname.split('/').filter(Boolean).length >= 1) {
      stem = u.origin + u.pathname.replace(/\/+$/, '');
    }
  } catch { /* no es una URL: solo igualdad exacta */ }
  if (!stem) return get(`SELECT * FROM items WHERE list_id = ? AND url = ? ORDER BY created_at ASC`, [listId, clean]);
  return get(
    `SELECT * FROM items WHERE list_id = ? AND (url = ? OR url = ? OR url = ? OR url LIKE ?) ORDER BY created_at ASC`,
    [listId, clean, stem, stem + '/', stem + '?%']
  );
}

/** Orden manual: la posición de cada pieza pasa a ser su índice en `ids`. */
async function reorderItems(listId, ids) {
  const clean = [...new Set(ids.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 500);
  if (!clean.length) return;
  if (USE_PG) {
    for (let i = 0; i < clean.length; i++) {
      await pool.query(`UPDATE items SET position = $1 WHERE id = $2 AND list_id = $3`, [i, clean[i], listId]);
    }
  } else {
    const stmt = sqlite.prepare(`UPDATE items SET position = ? WHERE id = ? AND list_id = ?`);
    sqlite.transaction(() => { clean.forEach((id, i) => stmt.run([i, id, listId])); })();
  }
  await run(`UPDATE lists SET updated_at = ? WHERE id = ?`, [now(), listId]);
}

async function updateItem(listId, itemId, patch) {
  const map = {
    title: 'title', note: 'note', priceText: 'price_text',
    priceValue: 'price_value', shop: 'shop', image: 'image', bought: 'bought',
    currency: 'currency', basePrice: 'base_price', prevPrice: 'prev_price',
    lowPrice: 'low_price', priceChangedAt: 'price_changed_at',
    checkedAt: 'checked_at', checkFails: 'check_fails',
  };
  const fields = [];
  const params = [];
  for (const [key, col] of Object.entries(map)) {
    if (patch[key] === undefined) continue;
    fields.push(`${col} = ?`);
    params.push(patch[key]);
  }
  if (!fields.length) return null;
  params.push(itemId, listId);
  await run(`UPDATE items SET ${fields.join(', ')} WHERE id = ? AND list_id = ?`, params);
  await run(`UPDATE lists SET updated_at = ? WHERE id = ?`, [now(), listId]);
  return get(`SELECT * FROM items WHERE id = ? AND list_id = ?`, [itemId, listId]);
}

async function deleteItem(listId, itemId) {
  await run(`DELETE FROM items WHERE id = ? AND list_id = ?`, [itemId, listId]);
  await run(`DELETE FROM price_history WHERE item_id = ?`, [itemId]).catch(() => {});
  await run(`UPDATE lists SET updated_at = ? WHERE id = ?`, [now(), listId]);
}

/* ------------------------------------------------- vigilancia de precios */

/**
 * Piezas que toca volver a mirar: con enlace, sin comprar y sin comprobar
 * desde hace `everyMs`. Las que llevan varias lecturas fallidas seguidas se
 * revisan con mucha menos frecuencia (`slowMs`) para no insistir en balde.
 */
async function itemsToWatch({ everyMs, slowMs, limit = 20 }) {
  const t = now();
  return all(
    `SELECT i.*, l.slug AS list_slug, l.name AS list_name, l.emoji AS list_emoji
       FROM items i JOIN lists l ON l.id = i.list_id
      WHERE i.url LIKE 'http%' AND i.bought = 0
        AND (i.checked_at IS NULL
             OR (i.check_fails < 4 AND i.checked_at < ?)
             OR i.checked_at < ?)
      ORDER BY COALESCE(i.checked_at, 0) ASC
      LIMIT ?`,
    [t - everyMs, t - slowMs, limit]
  );
}

/** Lectura fallida o sin precio: solo se apunta la fecha y el fallo. */
async function touchChecked(itemId, { failed = false } = {}) {
  await run(
    failed
      ? `UPDATE items SET checked_at = ?, check_fails = check_fails + 1 WHERE id = ?`
      : `UPDATE items SET checked_at = ?, check_fails = 0 WHERE id = ?`,
    [now(), itemId]
  );
}

/**
 * Punto de la evolución del precio. Para que la serie no crezca sin fin, un
 * precio igual al último punto de hace menos de 20 h no se repite, y por
 * pieza se guardan como mucho 60 puntos.
 */
async function addHistory(item, value, currency, { force = false } = {}) {
  if (!Number.isFinite(value)) return;
  if (!force) {
    const last = await get(`SELECT value, at FROM price_history WHERE item_id = ? ORDER BY at DESC LIMIT 1`, [item.id]);
    if (last && Math.abs(Number(last.value) - value) < 0.005 && now() - Number(last.at) < 20 * 3600 * 1000) return;
  }
  await run(
    `INSERT INTO price_history (id,item_id,list_id,value,currency,at) VALUES (?,?,?,?,?,?)`,
    [shortId(12), item.id, item.list_id, value, String(currency || ''), now()]
  );
  const extra = await all(
    `SELECT id FROM price_history WHERE item_id = ? ORDER BY at DESC LIMIT 1000 OFFSET 60`, [item.id]
  );
  for (const row of extra) await run(`DELETE FROM price_history WHERE id = ?`, [row.id]);
}

async function listHistory(itemId, limit = 60) {
  const rows = await all(
    `SELECT value, currency, at FROM price_history WHERE item_id = ? ORDER BY at DESC LIMIT ?`, [itemId, limit]
  );
  return rows.reverse().map((r) => ({ value: Number(r.value), currency: r.currency, at: Number(r.at) }));
}

/* ----------------------------------------------------------- avisos push */

async function pushSubUpsert({ endpoint, sub, slugs }) {
  const existing = await get(`SELECT id, slugs FROM push_subs WHERE endpoint = ?`, [endpoint]);
  const json = JSON.stringify([...new Set(slugs)].slice(0, 200));
  if (existing) {
    await run(`UPDATE push_subs SET sub = ?, slugs = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(sub), json, now(), existing.id]);
    return existing.id;
  }
  const id = shortId(12);
  await run(
    `INSERT INTO push_subs (id,endpoint,sub,slugs,created_at,updated_at) VALUES (?,?,?,?,?,?)`,
    [id, endpoint, JSON.stringify(sub), json, now(), now()]
  );
  return id;
}

async function pushSubDelete(endpoint) {
  await run(`DELETE FROM push_subs WHERE endpoint = ?`, [endpoint]);
}

async function pushSubByEndpoint(endpoint) {
  const row = await get(`SELECT * FROM push_subs WHERE endpoint = ?`, [endpoint]);
  return row ? parseSub(row) : null;
}

async function pushSubsForSlug(slug) {
  // `slugs` es un array JSON: buscar la cadena entrecomillada vale en ambos motores
  const rows = await all(`SELECT * FROM push_subs WHERE slugs LIKE ?`, ['%"' + slug + '"%']);
  return rows.map(parseSub);
}

function parseSub(row) {
  let sub = null;
  let slugs = [];
  try { sub = JSON.parse(row.sub); } catch { /* corrupto: se borrará al fallar */ }
  try { slugs = JSON.parse(row.slugs) || []; } catch { slugs = []; }
  return { id: row.id, endpoint: row.endpoint, sub, slugs, createdAt: Number(row.created_at) };
}

async function pushSubsCount() {
  const row = await get(`SELECT COUNT(*) AS n FROM push_subs`);
  return Number(row && row.n) || 0;
}

/* ---------------------------------------------------------------- cache */

async function cacheGet(key) {
  const row = await get(`SELECT v, expires_at FROM cache WHERE k = ?`, [key]);
  if (!row) return null;
  if (Number(row.expires_at) < now()) {
    await run(`DELETE FROM cache WHERE k = ?`, [key]).catch(() => {});
    return null;
  }
  try { return JSON.parse(row.v); } catch { return null; }
}

async function cacheSet(key, value, ttlMs) {
  const payload = JSON.stringify(value);
  const expires = now() + ttlMs;
  if (USE_PG) {
    await pool.query(
      `INSERT INTO cache (k,v,expires_at) VALUES ($1,$2,$3)
       ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, expires_at = EXCLUDED.expires_at`,
      [key, payload, expires]
    );
  } else {
    sqlite
      .prepare(`INSERT INTO cache (k,v,expires_at) VALUES (?,?,?)
                ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at`)
      .run([key, payload, expires]);
  }
}

module.exports = {
  init, token, shortId,
  createList, getListBySlug, updateList, deleteList, bumpViews,
  listItems, getItem, addItem, updateItem, deleteItem, findItemByUrl, reorderItems,
  itemsToWatch, touchChecked, addHistory, listHistory,
  pushSubUpsert, pushSubDelete, pushSubByEndpoint, pushSubsForSlug, pushSubsCount,
  cacheGet, cacheSet,
};
