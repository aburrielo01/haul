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

  // v4: el mismo enlace dos veces se avisa, y con force se guarda igualmente
  const dup = await call(`/api/lists/${slug}/items`, {
    method: 'POST', token: owner,
    body: { title: 'Zapatillas otra talla', url: 'https://example.com/x?size=42' },
  });
  check('avisa de que la pieza ya está en la lista', dup.status === 409 && dup.data.code === 'DUPLICATE' && dup.data.item.id === itemId, JSON.stringify(dup.data));
  const forced = await call(`/api/lists/${slug}/items`, {
    method: 'POST', token: owner,
    body: { title: 'Zapatillas otra talla', url: 'https://example.com/x?size=42', force: true, priceText: '79 €', priceValue: 79, currency: 'EUR' },
  });
  check('con force la guarda igualmente', forced.status === 201 && forced.data.item.id);
  const secondId = forced.data.item?.id;

  check('la pieza nace con precio de referencia', item.data.item.basePrice === 89.95 && item.data.item.lowPrice === 89.95 && item.data.item.checkedAt > 0);

  // v4: orden manual
  const order = await call(`/api/lists/${slug}/order`, { method: 'PUT', token: owner, body: { ids: [secondId, itemId] } });
  check('guarda el orden manual', order.status === 200 && order.data.items[0].id === secondId && order.data.items[1].id === itemId, JSON.stringify(order.data));
  const orderIntruder = await call(`/api/lists/${slug}/order`, { method: 'PUT', body: { ids: [itemId, secondId] } });
  check('un desconocido no puede ordenar', orderIntruder.status === 403);

  // v4: evolución y comprobación del precio
  const history = await call(`/api/lists/${slug}/items/${itemId}/history`, { token: owner });
  check('la evolución empieza con el precio de entrada', history.status === 200 && history.data.points.length === 1 && history.data.points[0].value === 89.95, JSON.stringify(history.data));
  const recheck = await call(`/api/lists/${slug}/items/${itemId}/check`, { method: 'POST', token: owner });
  check('comprobar el precio responde aunque la tienda no dé precio', recheck.status === 200 && recheck.data.found === false && recheck.data.item.checkedAt > 0, JSON.stringify(recheck.data));

  const bought = await call(`/api/lists/${slug}/items/${itemId}`, {
    method: 'PATCH', token: owner, body: { bought: true, priceText: '75,50 €' },
  });
  check('marca comprado y reformatea el precio',
    bought.status === 200 && bought.data.item.bought === true && bought.data.item.priceValue === 75.5,
    JSON.stringify(bought.data));
  check('un precio corregido a mano es la nueva referencia', bought.data.item.basePrice === 75.5 && bought.data.item.prevPrice === null && bought.data.item.lowPrice === 75.5);

  const pushCfg = await call('/api/push/config');
  check('la configuración de avisos responde', pushCfg.status === 200 && typeof pushCfg.data.enabled === 'boolean');
  if (pushCfg.data.enabled) {
    const badSub = await call('/api/push/subscribe', { method: 'POST', body: { subscription: { endpoint: 'nope' } } });
    check('rechaza una suscripción inválida', badSub.status === 400);
    const sub = await call('/api/push/subscribe', {
      method: 'POST',
      body: {
        subscription: { endpoint: 'https://push.example.com/fake-' + Date.now(), keys: { p256dh: 'x', auth: 'y' } },
        lists: [{ slug, token: owner }, { slug, token: 'mal' }],
      },
    });
    check('solo apunta las listas cuyo token es del dueño', sub.status === 200 && sub.data.lists === 1, JSON.stringify(sub.data));
  }

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
  check('cualquiera puede leerla', anon.status === 200 && anon.data.list.items.length === 3);
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
