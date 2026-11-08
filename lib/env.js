'use strict';
/**
 * Carga el `.env` de la raíz del proyecto, si existe, en process.env.
 *
 * Formato: una variable por línea, `CLAVE=valor`, líneas con `#` son
 * comentarios. No pisa variables que ya vengan definidas (en Render las pone
 * el panel, y ahí no hay `.env`). Sin dependencias: diez líneas bastan.
 */
const fs = require('fs');
const path = require('path');

function load(file = path.join(__dirname, '..', '.env')) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

module.exports = { load };
