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
     created_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id, position)`,
  `CREATE TABLE IF NOT EXISTS cache (
     k          TEXT PRIMARY KEY,
     v          TEXT NOT NULL,
     expires_at INTEGER NOT NULL
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
     created_at  BIGINT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id, position)`,
  `CREATE TABLE IF NOT EXISTS cache (
     k          TEXT PRIMARY KEY,
     v          TEXT NOT NULL,
     expires_at BIGINT NOT NULL
   )`,
];

async function init() {
  if (USE_PG) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
      max: 5,
    });
    for (const stmt of DDL_PG) await pool.query(stmt);
    return { driver: 'postgres' };
  }

  const Database = require('better-sqlite3');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  sqlite = new Database(path.join(DATA_DIR, 'haul.db'));
  sqlite.pragma('journal_mode = WAL');
  for (const stmt of DDL_SQLITE) sqlite.prepare(stmt).run();
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
  };
  await run(
    `INSERT INTO items (id,list_id,title,url,image,price_text,price_value,currency,shop,note,source,bought,added_by,position,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      item.id, item.list_id, item.title, item.url, item.image, item.price_text,
      item.price_value, item.currency, item.shop, item.note, item.source,
      item.bought, item.added_by, item.position, item.created_at,
    ]
  );
  await run(`UPDATE lists SET updated_at = ? WHERE id = ?`, [now(), listId]);
  return item;
}

async function updateItem(listId, itemId, patch) {
  const map = {
    title: 'title', note: 'note', priceText: 'price_text',
    priceValue: 'price_value', shop: 'shop', image: 'image', bought: 'bought',
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
  await run(`UPDATE lists SET updated_at = ? WHERE id = ?`, [now(), listId]);
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
  listItems, addItem, updateItem, deleteItem,
  cacheGet, cacheSet,
};
