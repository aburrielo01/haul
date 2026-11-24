'use strict';
/**
 * Medición de la beta (4.1.8).
 *
 * La pregunta que responde: ¿cuántas personas han guardado al menos un producto
 * esta semana? Haul no tiene cuentas, así que «persona» es:
 *   - el código de su enlace de invitación (`/?i=k7qf3m`), si lo tiene; o
 *   - un identificador anónimo que su navegador genera la primera vez.
 * El servidor no guarda nombres ni IPs: quién es cada código lo apunta
 * Alejandro fuera de aquí.
 *
 * Semanas de lunes a domingo, en hora de Madrid. La semana 1 de la beta es la
 * primera semana completa tras el arranque (BETA_START); los días sueltos de
 * antes son la semana 0.
 */

const TZ = 'Europe/Madrid';
const DAY = 86_400_000;
const BETA_START = /^\d{4}-\d{2}-\d{2}$/.test(process.env.BETA_START || '') ? process.env.BETA_START : '2026-12-10';
const TARGET = 15; // personas activas en la semana 8

const dateParts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Lunes (YYYY-MM-DD) de la semana en la que cae ese instante, en hora de Madrid. */
function weekOf(ts) {
  const p = {};
  for (const part of dateParts.formatToParts(new Date(ts))) p[part.type] = Number(part.value);
  const utc = Date.UTC(p.year, p.month - 1, p.day);
  const sinceMonday = (new Date(utc).getUTCDay() + 6) % 7;
  return new Date(utc - sinceMonday * DAY).toISOString().slice(0, 10);
}

const addWeeks = (monday, n) => new Date(Date.parse(monday) + n * 7 * DAY).toISOString().slice(0, 10);

/** Semana de la beta: 1 = primera semana completa tras el arranque, 0 = días de arranque. */
function weekNumber(monday, start = BETA_START) {
  const startWeek = weekOf(Date.parse(start + 'T12:00:00Z'));
  const diff = Math.round((Date.parse(monday) - Date.parse(startWeek)) / (7 * DAY));
  return startWeek === start ? diff + 1 : diff;
}

/* ------------------------------------------------------------ identidad */

const cleanInvite = (v) => {
  const s = String(v || '').trim().toLowerCase();
  return /^[a-z0-9]{4,12}$/.test(s) ? s : '';
};
const cleanWho = (v) => {
  const s = String(v || '').trim();
  return /^[A-Za-z0-9-]{8,40}$/.test(s) ? s : '';
};

/** Quién hace la petición: `i:<código>` si trae una invitación que existe, si no `d:<dispositivo>`. */
async function identify(db, req) {
  const code = cleanInvite(req.get('x-haul-invite'));
  const invite = code ? await db.inviteGet(code) : null;
  if (invite) return { person: 'i:' + invite.code, invite };
  const who = cleanWho(req.get('x-haul-who'));
  return { person: who ? 'd:' + who : '', invite: null };
}

/** La app avisa de que alguien ha abierto su enlace: es el «tiene acceso». */
async function recordOpen(db, req) {
  const { invite } = await identify(db, req);
  if (!invite) return false;
  await db.inviteMark(invite.code, 'opened_at');
  return true;
}

async function recordSave(db, req, { shop = '', source = '' } = {}) {
  const { person, invite } = await identify(db, req);
  await db.betaEventAdd({ kind: 'save', person, shop, detail: source });
  if (invite) {
    await db.inviteMark(invite.code, 'opened_at'); // por si el aviso de apertura no llegó
    await db.inviteMark(invite.code, 'first_save_at');
  }
}

async function recordFail(db, req, { shop = '', code = '' } = {}) {
  const { person } = await identify(db, req);
  await db.betaEventAdd({ kind: 'fail', person, shop, detail: code });
}

/* -------------------------------------------------------------- resumen */

/**
 * Los números del domingo a partir de las filas crudas. Función pura: no toca
 * la base de datos ni el reloj, para poder probarla con fechas inventadas.
 */
function summarize({ invites = [], events = [], now = Date.now(), start = BETA_START }) {
  const thisWeek = weekOf(now);
  const testers = invites.filter((i) => !Number(i.test));
  const testPersons = new Set(invites.filter((i) => Number(i.test)).map((i) => 'i:' + i.code));
  const real = events.filter((e) => !testPersons.has(e.person));
  const saves = real.filter((e) => e.kind === 'save');

  // persona → semana → productos guardados
  const byPerson = new Map();
  for (const e of saves) {
    const week = weekOf(Number(e.at));
    const key = e.person || '';
    if (!byPerson.has(key)) byPerson.set(key, new Map());
    const weeks = byPerson.get(key);
    weeks.set(week, (weeks.get(week) || 0) + 1);
  }

  // columnas: desde la primera semana con algo (o el arranque) hasta esta, 10 como mucho
  const startWeek = weekOf(Date.parse(start + 'T12:00:00Z'));
  let first = thisWeek < startWeek ? thisWeek : startWeek;
  for (const weeks of byPerson.values()) for (const w of weeks.keys()) if (w < first) first = w;
  const weekList = [];
  for (let w = first; w <= thisWeek; w = addWeeks(w, 1)) weekList.push(w);
  const shown = weekList.slice(-10);

  const weeks = shown.map((week) => {
    let invited = 0; let others = 0; let products = 0; let unidentified = 0;
    for (const [person, perWeek] of byPerson) {
      const n = perWeek.get(week) || 0;
      if (!n) continue;
      products += n;
      if (!person) unidentified += n;
      else if (person.startsWith('i:')) invited++;
      else others++;
    }
    return { week, n: weekNumber(week, start), invited, others, active: invited + others, products, unidentified };
  });
  const current = weeks[weeks.length - 1];

  const rows = testers.map((inv) => {
    const perWeek = byPerson.get('i:' + inv.code) || new Map();
    let total = 0;
    for (const n of perWeek.values()) total += n;
    return {
      code: inv.code,
      openedAt: inv.opened_at ? Number(inv.opened_at) : null,
      firstSaveAt: inv.first_save_at ? Number(inv.first_save_at) : null,
      weeks: shown.map((w) => perWeek.get(w) || 0),
      total,
      activeThisWeek: (perWeek.get(thisWeek) || 0) > 0,
    };
  });

  // fallos de lectura de esta semana, por tienda
  const failsByShop = new Map();
  let failsThisWeek = 0;
  for (const e of real) {
    if (e.kind !== 'fail' || weekOf(Number(e.at)) !== thisWeek) continue;
    failsThisWeek++;
    const shop = e.shop || 'desconocida';
    if (!failsByShop.has(shop)) failsByShop.set(shop, { shop, n: 0, codes: {} });
    const f = failsByShop.get(shop);
    f.n++;
    f.codes[e.detail || 'EXTRACT_FAILED'] = (f.codes[e.detail || 'EXTRACT_FAILED'] || 0) + 1;
  }
  const topFails = [...failsByShop.values()].sort((a, b) => b.n - a.n || a.shop.localeCompare(b.shop)).slice(0, 3);

  return {
    now, start, target: TARGET,
    thisWeek, thisWeekNumber: weekNumber(thisWeek, start),
    invitesCreated: testers.length,
    withAccess: testers.filter((i) => i.opened_at).length,
    firstProduct: testers.filter((i) => i.first_save_at).length,
    activeThisWeek: current.active,
    activeInvited: current.invited,
    activeOthers: current.others,
    productsThisWeek: current.products,
    productsTotal: saves.length,
    weeks, rows, failsThisWeek, topFails,
    testCodes: invites.filter((i) => Number(i.test)).map((i) => i.code),
  };
}

async function report(db, now = Date.now()) {
  const [invites, events] = await Promise.all([db.invitesAll(), db.betaEventsSince(0)]);
  return summarize({ invites, events, now });
}

/* ----------------------------------------------------------------- HTML */

const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (m) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
));
const day = (ts) => (ts ? new Date(ts).toLocaleDateString('es-ES', { timeZone: TZ, day: 'numeric', month: 'short' }) : '—');
const weekLabel = (w) => `S${w.n}<br><small>${esc(w.week.slice(8))}/${esc(w.week.slice(5, 7))}</small>`;

/** Página privada sin diseño: la misma hoja de estilo sobria que el banco de pruebas. */
function renderHtml(s, { origin = '' } = {}) {
  const head = s.weeks.map((w) => `<th class="${w.week === s.thisWeek ? 'now' : ''}">${weekLabel(w)}</th>`).join('');
  const rows = s.rows.map((r) => `<tr>
    <td><code>${esc(r.code)}</code></td>
    <td class="small"><code>${esc(origin)}/?i=${esc(r.code)}</code></td>
    <td>${r.openedAt ? day(r.openedAt) : '<span class="ko">sin abrir</span>'}</td>
    <td>${r.firstSaveAt ? day(r.firstSaveAt) : '<span class="ko">—</span>'}</td>
    ${r.weeks.map((n) => `<td class="${n ? 'ok' : 'zero'}">${n || '·'}</td>`).join('')}
    <td>${r.total}</td>
  </tr>`).join('');
  const totals = (label, pick, cls = '') => `<tr class="${cls}"><td colspan="4">${label}</td>${s.weeks.map((w) => `<td>${pick(w) || '·'}</td>`).join('')}<td></td></tr>`;
  const fails = s.topFails.length
    ? `<ol>${s.topFails.map((f) => `<li><b>${esc(f.shop)}</b> · ${f.n} ${f.n === 1 ? 'vez' : 'veces'} <span class="small">(${Object.entries(f.codes).map(([k, v]) => `${esc(k)} ×${v}`).join(', ')})</span></li>`).join('')}</ol>`
    : '<p class="sub">Ninguna lectura fallida esta semana.</p>';
  return `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>Beta · Haul</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;margin:24px;color:#111113;background:#fbfbfd}
h1{font-size:28px;letter-spacing:-.03em;margin:0 0 4px}h3{margin:28px 0 8px}.sub{color:#6b6b78;margin:0 0 16px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0 8px}
.kpi{border:1px solid #e2e1e8;background:#fff;padding:12px}.kpi b{display:block;font-size:26px;letter-spacing:-.03em}.kpi span{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#8b8f9a}
table{border-collapse:collapse;width:100%;font-size:13px;background:#fff}th,td{border-bottom:1px solid #e2e1e8;padding:7px 9px;text-align:left;vertical-align:top}
th{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#8b8f9a}th small{font-weight:400}th.now{color:#111113}
.ok{color:#1a8f3a;font-weight:700}.ko{color:#d6362a}.zero{color:#c4c4cc}.small{font-size:12px;color:#4a4f5a}.sum td{font-weight:700;background:#f4f4f8}
code{font-family:ui-monospace,monospace;font-size:12px}.wrap{overflow-x:auto}
</style>
<h1>Beta · ${s.thisWeekNumber < 0 ? 'antes del arranque' : 'semana ' + s.thisWeekNumber}</h1>
<p class="sub">Semana del lunes ${esc(s.thisWeek)}, hora de Madrid. Arranque de la beta: ${esc(s.start)}. Objetivo: ${s.target} personas activas en la semana 8.</p>
<div class="kpis">
  <div class="kpi"><b>${s.withAccess}/${s.invitesCreated}</b><span>testers con acceso</span></div>
  <div class="kpi"><b>${s.firstProduct}</b><span>han guardado su primer producto</span></div>
  <div class="kpi"><b>${s.activeThisWeek}</b><span>personas activas esta semana</span></div>
  <div class="kpi"><b>${s.productsThisWeek}</b><span>productos guardados esta semana</span></div>
  <div class="kpi"><b>${s.productsTotal}</b><span>productos guardados en total</span></div>
</div>
<p class="sub">Activa = ha guardado al menos un producto esa semana. De las ${s.activeThisWeek} de esta semana, ${s.activeInvited} con invitación y ${s.activeOthers} sin ella.</p>
<h3>Por invitación</h3>
<div class="wrap"><table>
<tr><th>código</th><th>enlace</th><th>abierto</th><th>primer producto</th>${head}<th>total</th></tr>
${rows || `<tr><td colspan="${5 + s.weeks.length}">Todavía no hay invitaciones. Créalas con <code>/api/beta/invites/new?key=…&amp;n=15</code>.</td></tr>`}
${totals('Personas activas con invitación', (w) => w.invited, 'sum')}
${totals('Personas activas sin invitación (un dispositivo = una persona)', (w) => w.others)}
${totals('Total de personas activas', (w) => w.active, 'sum')}
${totals('Productos guardados', (w) => w.products)}
${totals('…de ellos, sin identificar (app sin actualizar)', (w) => w.unidentified)}
</table></div>
<h3>Lecturas fallidas esta semana: ${s.failsThisWeek}</h3>
${fails}
${s.testCodes.length ? `<p class="sub">Códigos de prueba, que no cuentan: ${s.testCodes.map((c) => `<code>${esc(origin)}/?i=${esc(c)}</code>`).join(' · ')}</p>` : ''}`;
}

module.exports = {
  BETA_START, TARGET,
  weekOf, weekNumber, cleanInvite, cleanWho,
  identify, recordOpen, recordSave, recordFail,
  summarize, report, renderHtml,
};
