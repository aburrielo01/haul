'use strict';
/**
 * Medición de la beta (4.1.8).
 *
 *   node test/beta.js                                   → solo las cuentas (sin servidor)
 *   BASE=http://127.0.0.1:3400 node test/beta.js        → además, el camino completo por HTTP
 *
 * La parte HTTP crea invitaciones de prueba, así que solo corre contra un
 * servidor local. La clave es la de diagnóstico (DIAG_KEY, por defecto la de
 * la configuración local `haul-v4`).
 */

const beta = require('../lib/beta');

const BASE = process.env.BASE || '';
const KEY = process.env.DIAG_KEY || 'local-dev';
let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra); }
}

/* ------------------------------------------------------------- cuentas */

function unit() {
  console.log('\nHaul · beta · semanas y cuentas\n');

  // 10 dic 2026 es jueves; las semanas van de lunes a domingo en hora de Madrid
  check('domingo 13 dic a las 23:30 de Madrid sigue en la semana del 7', beta.weekOf(Date.parse('2026-12-13T22:30:00Z')) === '2026-12-07');
  check('lunes 14 dic a las 00:30 de Madrid ya es la semana del 14', beta.weekOf(Date.parse('2026-12-13T23:30:00Z')) === '2026-12-14');
  check('con el horario de verano el corte sigue a medianoche de Madrid', beta.weekOf(Date.parse('2027-03-28T22:30:00Z')) === '2027-03-29');
  check('los días de arranque (10-13 dic) son la semana 0', beta.weekNumber('2026-12-07', '2026-12-10') === 0);
  check('la semana 1 es la primera completa (14-20 dic)', beta.weekNumber('2026-12-14', '2026-12-10') === 1);
  check('la semana 8 es la del 1 al 7 de febrero', beta.weekNumber('2027-02-01', '2026-12-10') === 8);
  check('si la beta arranca en lunes, esa es la semana 1', beta.weekNumber('2026-12-14', '2026-12-14') === 1);

  check('acepta un código de invitación y lo pasa a minúsculas', beta.cleanInvite(' K7QF3M ') === 'k7qf3m');
  check('rechaza códigos con símbolos o demasiado largos', beta.cleanInvite('k7<script>') === '' && beta.cleanInvite('a'.repeat(13)) === '');
  check('rechaza identificadores de dispositivo raros', beta.cleanWho('x y z') === '' && beta.cleanWho('3f1c2a9e-aaaa-bbbb-cccc-1234567890ab') !== '');

  // Tres personas con invitación, una sin ella y el código de prueba, en dos semanas
  const w1 = Date.parse('2026-12-16T10:00:00Z'); // semana 1
  const w2 = Date.parse('2026-12-23T10:00:00Z'); // semana 2
  const invites = [
    { code: 'aaaaaa', test: 0, created_at: 1, opened_at: w1, first_save_at: w1 },
    { code: 'bbbbbb', test: 0, created_at: 2, opened_at: w1, first_save_at: w1 },
    { code: 'cccccc', test: 0, created_at: 3, opened_at: null, first_save_at: null },
    { code: 'tttttt', test: 1, created_at: 4, opened_at: w1, first_save_at: w1 },
  ];
  const ev = (kind, person, at, shop = '', detail = '') => ({ kind, person, at, shop, detail });
  const events = [
    ev('save', 'i:aaaaaa', w1), ev('save', 'i:aaaaaa', w1 + 1000), ev('save', 'i:bbbbbb', w1),
    ev('fail', 'i:bbbbbb', w1, 'Zara', 'BLOCKED'),
    ev('save', 'i:aaaaaa', w2), ev('save', 'd:device-0001', w2), ev('save', '', w2),
    ev('save', 'i:tttttt', w2), ev('save', 'i:tttttt', w2 + 5),
    ev('fail', 'i:aaaaaa', w2, 'Zara', 'BLOCKED'), ev('fail', 'd:device-0001', w2, 'Zara', 'EXTRACT_FAILED'),
    ev('fail', 'i:aaaaaa', w2, 'Shein', 'BLOCKED'), ev('fail', 'i:tttttt', w2, 'Temu', 'BLOCKED'),
  ];
  const s = beta.summarize({ invites, events, now: w2 + 3600_000, start: '2026-12-10' });

  check('estamos en la semana 2', s.thisWeek === '2026-12-21' && s.thisWeekNumber === 2, JSON.stringify([s.thisWeek, s.thisWeekNumber]));
  check('3 invitaciones (la de prueba no cuenta), 2 con acceso, 2 con primer producto', s.invitesCreated === 3 && s.withAccess === 2 && s.firstProduct === 2, JSON.stringify(s));
  check('esta semana: 2 personas activas (1 con invitación, 1 sin ella)', s.activeThisWeek === 2 && s.activeInvited === 1 && s.activeOthers === 1, JSON.stringify(s.weeks));
  check('esta semana: 3 productos (los de prueba no cuentan)', s.productsThisWeek === 3 && s.productsTotal === 6, `${s.productsThisWeek}/${s.productsTotal}`);
  const week1 = s.weeks.find((w) => w.n === 1);
  check('la semana 1 tuvo 2 personas activas y 3 productos', week1 && week1.active === 2 && week1.products === 3, JSON.stringify(week1));
  check('la semana 0 sale, vacía', s.weeks[0].n === 0 && s.weeks[0].active === 0, JSON.stringify(s.weeks[0]));
  const a = s.rows.find((r) => r.code === 'aaaaaa');
  const b = s.rows.find((r) => r.code === 'bbbbbb');
  const c = s.rows.find((r) => r.code === 'cccccc');
  check('«aaaaaa» guardó 2 y 1, y está activa', a.weeks.join(',') === '0,2,1' && a.total === 3 && a.activeThisWeek, JSON.stringify(a));
  check('«bbbbbb» fue activa la semana 1 y esta no', b.weeks.join(',') === '0,1,0' && !b.activeThisWeek, JSON.stringify(b));
  check('«cccccc» no ha abierto su enlace', c.openedAt === null && c.total === 0);
  check('el guardado sin identificar se cuenta como producto, no como persona', s.weeks[2].unidentified === 1);
  check('fallos de esta semana: Zara ×2 primero, Shein ×1; el de prueba no cuenta',
    s.failsThisWeek === 3 && s.topFails[0].shop === 'Zara' && s.topFails[0].n === 2 && s.topFails[1].shop === 'Shein' && s.topFails.length === 2, JSON.stringify(s.topFails));
  check('el código de prueba sale aparte', s.testCodes.join() === 'tttttt');

  const html = beta.renderHtml(s, { origin: 'https://haul.example' });
  check('la página enseña los enlaces de invitación y los números', html.includes('https://haul.example/?i=cccccc') && html.includes('sin abrir') && html.includes('Beta · semana 2'));
}

/* ----------------------------------------------------------------- HTTP */

async function call(path, { method = 'GET', body, token, who, invite } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-haul-token': token } : {}),
      ...(who ? { 'x-haul-who': who } : {}),
      ...(invite ? { 'x-haul-invite': invite } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function http() {
  console.log('\nHaul · beta · camino completo sobre', BASE, '\n');
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
    console.log('  (se salta: crea invitaciones de prueba y solo corre contra un servidor local)');
    return;
  }
  const q = `key=${encodeURIComponent(KEY)}`;

  const noKey = await call('/api/beta/report');
  check('sin clave no se ven los números', noKey.status === 403 || noKey.status === 404, 'status ' + noKey.status);

  const made = await call(`/api/beta/invites/new?${q}&n=2`);
  check('crea dos invitaciones con su enlace', made.status === 200 && made.data.created.length === 2 && /\/\?i=[a-z0-9]{6}$/.test(made.data.created[0].link), JSON.stringify(made.data));
  const [A, B] = made.data.created.map((x) => x.code);
  const madeTest = await call(`/api/beta/invites/new?${q}&test=1`);
  const T = madeTest.data.created[0].code;
  check('crea un código de prueba', madeTest.data.created[0].test === true);

  const before = (await call(`/api/beta/report?${q}`)).data;

  const open = await call('/api/beta/open', { method: 'POST', body: {}, invite: A, who: 'test-device-a-0001' });
  check('abrir el enlace cuenta como «tiene acceso»', open.status === 200 && open.data.valid === true);
  const bogus = await call('/api/beta/open', { method: 'POST', body: {}, invite: 'zzzz99' });
  check('un código inventado no vale', bogus.status === 200 && bogus.data.valid === false);

  const created = await call('/api/lists', { method: 'POST', body: { name: 'Beta test', visibility: 'private' } });
  const slug = created.data.list.slug;
  const owner = created.data.ownerToken;
  const save = (title, id) => call(`/api/lists/${slug}/items`, { method: 'POST', token: owner, body: { title, shop: 'Nike', source: 'manual' }, ...id });

  const stamp = Date.now().toString(36);
  const s1 = await save('De la invitada', { invite: A, who: 'test-device-a-0001' });
  const s2 = await save('Otra vez la invitada, desde otro dispositivo', { invite: A, who: 'test-device-a-0002' });
  const s3 = await save('De alguien sin invitación', { who: 'test-device-x-' + stamp });
  const s4 = await save('Del código de prueba', { invite: T });
  const s5 = await save('De una app sin actualizar', {});
  check('guardar sigue funcionando en los cinco casos', [s1, s2, s3, s4, s5].every((r) => r.status === 201));

  const after = (await call(`/api/beta/report?${q}`)).data;
  check('2 personas activas más (la invitada cuenta una vez con dos dispositivos)', after.activeThisWeek - before.activeThisWeek === 2,
    `${before.activeThisWeek} → ${after.activeThisWeek}`);
  check('4 productos más esta semana (el de prueba no cuenta)', after.productsThisWeek - before.productsThisWeek === 4,
    `${before.productsThisWeek} → ${after.productsThisWeek}`);
  const rowA = after.rows.find((r) => r.code === A);
  const rowB = after.rows.find((r) => r.code === B);
  check('la invitada sale con acceso, primer producto y 2 guardados', rowA && rowA.openedAt && rowA.firstSaveAt && rowA.total === 2 && rowA.activeThisWeek, JSON.stringify(rowA));
  check('la otra invitación sigue sin abrir', rowB && rowB.openedAt === null && rowB.total === 0, JSON.stringify(rowB));
  check('con acceso +1 y con primer producto +1', after.withAccess - before.withAccess === 1 && after.firstProduct - before.firstProduct === 1);
  check('el código de prueba sale aparte', after.testCodes.includes(T) && !after.rows.some((r) => r.code === T));

  const failRead = await call('/api/extract', { method: 'POST', body: { url: 'https://tienda-que-no-existe.invalid/producto/123' }, invite: A });
  const afterFail = (await call(`/api/beta/report?${q}`)).data;
  check('una lectura fallida queda apuntada', failRead.status >= 400 && afterFail.failsThisWeek - after.failsThisWeek === 1,
    `status ${failRead.status}, ${after.failsThisWeek} → ${afterFail.failsThisWeek}`);

  const page = await fetch(`${BASE}/api/beta/report?${q}&html=1`).then((r) => r.text());
  check('la página enseña el enlace de la invitada', page.includes(`/?i=${A}`) && page.includes('testers con acceso'));

  const manifest = await fetch(`${BASE}/manifest.webmanifest?i=${A}`).then((r) => r.json());
  check('el manifiesto con invitación abre el icono en /?i=código', manifest.start_url === `/?i=${A}` && manifest.name.includes('Haul'), JSON.stringify(manifest.start_url));
  const plain = await fetch(`${BASE}/manifest.webmanifest`).then((r) => r.json());
  const weird = await fetch(`${BASE}/manifest.webmanifest?i=${encodeURIComponent('"><x>')}`).then((r) => r.json());
  check('sin invitación (o con una rara) el manifiesto no cambia', plain.start_url === '/' && weird.start_url === '/');

  const out = await call('/api/transfer', { method: 'POST', body: { lists: [{ slug, token: owner }], beta: { who: 'test-device-a-0001', invite: A.toUpperCase() } } });
  const claim = await call('/api/transfer/claim', { method: 'POST', body: { code: out.data.code } });
  check('al pasar las listas viaja también la identidad de la beta', claim.status === 200 && claim.data.beta && claim.data.beta.invite === A && claim.data.beta.who === 'test-device-a-0001', JSON.stringify(claim.data && claim.data.beta));

  await call(`/api/lists/${slug}`, { method: 'DELETE', token: owner });
}

(async () => {
  unit();
  if (BASE) await http();
  console.log(`\n${passed} correctas · ${failed} fallidas\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
