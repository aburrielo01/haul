'use strict';
/** Pruebas de humo: cubren el ciclo completo de una lista y sus permisos. */

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra); }
}

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-haul-token': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

(async () => {
  console.log('\nHaul · pruebas de humo sobre', BASE, '\n');

  const health = await call('/api/health');
  check('salud del servidor', health.status === 200 && health.data.ok);

  const created = await call('/api/lists', {
    method: 'POST',
    body: { name: 'Test de verano', emoji: '👟', theme: 'cyan', visibility: 'private' },
  });
  check('crea una lista', created.status === 201 && created.data.list.slug, JSON.stringify(created.data));
  const slug = created.data.list?.slug;
  const owner = created.data.ownerToken;

  const priv = await call(`/api/lists/${slug}`);
  check('una lista privada no se puede leer sin token', priv.status === 403);

  const mine = await call(`/api/lists/${slug}`, { token: owner });
  check('el dueño sí puede leerla', mine.status === 200 && mine.data.list.role === 'owner');

  const item = await call(`/api/lists/${slug}/items`, {
    method: 'POST', token: owner,
    body: { title: 'Zapatillas', priceText: '89,95 €', priceValue: 89.95, currency: 'EUR', shop: 'Nike', url: 'https://example.com/x' },
  });
  check('añade un producto', item.status === 201 && item.data.item.id);
  const itemId = item.data.item?.id;

  const intruder = await call(`/api/lists/${slug}/items`, {
    method: 'POST', body: { title: 'Colado' },
  });
  check('un desconocido no puede añadir', intruder.status === 403);

  const bought = await call(`/api/lists/${slug}/items/${itemId}`, {
    method: 'PATCH', token: owner, body: { bought: true, priceText: '75,50 €' },
  });
  check('marca comprado y reformatea el precio',
    bought.status === 200 && bought.data.item.bought === true && bought.data.item.priceValue === 75.5,
    JSON.stringify(bought.data));

  const shared = await call(`/api/lists/${slug}`, {
    method: 'PATCH', token: owner, body: { visibility: 'public', allowContrib: true },
  });
  check('la hace pública y colaborativa',
    shared.status === 200 && shared.data.list.visibility === 'public' && shared.data.list.allowContrib);

  const guest = await call(`/api/lists/${slug}/items`, {
    method: 'POST', body: { title: 'Aportado por un amigo', addedBy: 'Marta' },
  });
  check('ahora un invitado sí puede aportar', guest.status === 201);

  const anon = await call(`/api/lists/${slug}`);
  check('cualquiera puede leerla', anon.status === 200 && anon.data.list.items.length === 2);
  check('el token de colaboración no se filtra', anon.data.list.collabToken === undefined);

  const page = await fetch(`${BASE}/l/${slug}`).then((r) => r.text());
  check('la página compartida trae su Open Graph', page.includes('og:title') && page.includes('Test de verano'));

  const badUrl = await call('/api/extract', { method: 'POST', body: { url: 'http://127.0.0.1:22/' } });
  check('bloquea URLs internas (SSRF)', badUrl.status >= 400);

  const gone = await call(`/api/lists/${slug}`, { method: 'DELETE', token: owner });
  check('borra la lista', gone.status === 200);
  const after = await call(`/api/lists/${slug}`);
  check('y deja de existir', after.status === 404);

  console.log(`\n${passed} correctas · ${failed} fallidas\n`);
  process.exit(failed ? 1 : 0);
})();
