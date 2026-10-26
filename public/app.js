/* ==========================================================================
   HAUL · app
   PWA sin cuentas: las listas viven en el servidor y el móvil guarda solo las
   llaves (tokens) de las listas que ha creado.
   ========================================================================== */

const STORE_KEY = 'haul.v2';
const EMOJIS = ['✶', '👟', '👗', '💄', '🎧', '🛋️', '🎮', '📚', '🍿', '🎁', '✣', '▣'];
const AVATARS = ['😎', '🦋', '👽', '🐰', '🔥', '🫧', '🍒', '⭐️', '🎀', '🧊'];
const THEMES = ['sky', 'lime', 'lavender', 'coral', 'sun', 'ink'];
// órdenes de la lista; el manual es el que se arrastra
const SORTS = [
  ['manual', 'tu orden'],
  ['price-desc', 'precio ↓'],
  ['price-asc', 'precio ↑'],
  ['recent', 'recientes'],
];

const CDN = {
  zxing: 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js',
  tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  qrcode: 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js',
};

/* --------------------------------------------------------------- helpers */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
));
const buzz = (ms = 12) => { try { navigator.vibrate?.(ms); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function money(value, currency = 'EUR') {
  if (!Number.isFinite(value)) return '';
  try {
    return new Intl.NumberFormat('es-ES', {
      style: 'currency', currency: currency || 'EUR',
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2,
    }).format(value);
  } catch { return `${value} ${currency}`; }
}

/** Las tiendas bloquean el hotlinking, así que las fotos pasan por el proxy. */
function imgSrc(url) {
  if (!url) return '';
  if (url.startsWith('data:') || url.startsWith('/')) return url;
  return '/api/img?u=' + encodeURIComponent(url);
}

/* ------------------------------------------------------ precios (v4) */

/** Bajada vigente de una pieza: su último cambio de precio fue hacia abajo. */
function dropOf(p) {
  if (!p || p.bought || p.prevPrice === null || p.prevPrice === undefined) return null;
  const now = Number(p.priceValue);
  const before = Number(p.prevPrice);
  if (!Number.isFinite(now) || !Number.isFinite(before) || before <= 0 || before <= now) return null;
  return { from: before, to: now, pct: Math.max(1, Math.round(((before - now) / before) * 100)) };
}

/** Subida vigente: se enseña discreta, sin sticker. */
function riseOf(p) {
  if (!p || p.bought || p.prevPrice === null || p.prevPrice === undefined) return null;
  const now = Number(p.priceValue);
  const before = Number(p.prevPrice);
  if (!Number.isFinite(now) || !Number.isFinite(before) || before <= 0 || before >= now) return null;
  return { from: before, to: now, pct: Math.max(1, Math.round(((now - before) / before) * 100)) };
}

function countDrops(items) {
  return (items || []).filter((i) => dropOf(i)).length;
}

function timeAgo(ts) {
  const d = Date.now() - Number(ts);
  if (!Number.isFinite(d) || d < 90 * 1000) return 'ahora mismo';
  const m = Math.round(d / 60000);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `hace ${h} h`;
  const days = Math.round(h / 24);
  if (days < 30) return `hace ${days} días`;
  const months = Math.round(days / 30);
  return `hace ${months} mes${months === 1 ? '' : 'es'}`;
}

const scriptCache = new Map();
function loadScript(src) {
  if (scriptCache.has(src)) return scriptCache.get(src);
  const p = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = resolve;
    el.onerror = () => reject(new Error('No se ha podido cargar un recurso'));
    document.head.appendChild(el);
  });
  scriptCache.set(src, p);
  return p;
}

/* ------------------------------------------------------------ almacén */

const store = {
  data: { profile: { name: '', avatar: '😎' }, lists: [], saved: [], seenWelcome: false, hints: {}, push: { endpoint: '' } },
  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (raw && typeof raw === 'object') this.data = { ...this.data, ...raw };
    } catch {}
    return this.data;
  },
  save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.data)); } catch {}
  },
  addList(list, ownerToken) {
    this.data.lists = this.data.lists.filter((l) => l.slug !== list.slug);
    this.data.lists.unshift({
      slug: list.slug, name: list.name, emoji: list.emoji, theme: list.theme,
      visibility: list.visibility, count: list.items?.length || 0, ownerToken,
      covers: (list.items || []).slice(0, 4).map((i) => i.image).filter(Boolean),
      total: sumTotal(list.items || []).value,
      drops: countDrops(list.items || []),
    });
    this.save();
  },
  syncList(list) {
    const entry = this.data.lists.find((l) => l.slug === list.slug);
    if (!entry) return;
    Object.assign(entry, {
      name: list.name, emoji: list.emoji, theme: list.theme, visibility: list.visibility,
      count: list.items.length, covers: list.items.slice(0, 4).map((i) => i.image).filter(Boolean),
      total: sumTotal(list.items).value,
      drops: countDrops(list.items),
    });
    this.save();
  },
  removeList(slug) {
    this.data.lists = this.data.lists.filter((l) => l.slug !== slug);
    this.data.saved = this.data.saved.filter((s) => s.slug !== slug);
    this.save();
  },
  tokenFor(slug) {
    return this.data.lists.find((l) => l.slug === slug)?.ownerToken || '';
  },
};

function sumTotal(items) {
  let value = 0;
  let currency = 'EUR';
  for (const it of items) {
    if (!it.bought && Number.isFinite(it.priceValue)) {
      value += it.priceValue;
      if (it.currency) currency = it.currency;
    }
  }
  return { value, currency };
}

/* ----------------------------------------------------------------- api */

async function api(path, { method = 'GET', body, slug } = {}) {
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  const token = slug ? store.tokenFor(slug) || session.collabToken : '';
  if (token) headers['x-haul-token'] = token;

  const res = await fetch('/api' + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok || data.ok === false) {
    const err = new Error(data.message || 'Algo ha fallado. Inténtalo otra vez.');
    err.code = data.code;
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* --------------------------------------------------------------- estado */

const session = {
  screen: 'welcome',
  list: null,       // lista abierta (objeto completo del servidor)
  filter: 'all',
  item: null,       // producto abierto
  pending: null,    // producto en vista previa, sin guardar
  editingItem: null,
  listFormMode: 'create',
  collabToken: '',  // token recibido por enlace de colaboración
  sharingItem: null,// producto concreto que se está compartiendo
  scanner: null,
  deferredInstall: null,
  sort: 'manual',   // orden de la lista abierta (solo en el móvil)
  forceDup: false,  // el usuario ha dicho "guardar igualmente" una pieza repetida
  dupItem: null,
  pushConfig: null, // { enabled, key } del servidor
};

/* ------------------------------------------------------------- pantallas */

function goto(screen, { push = true } = {}) {
  session.screen = screen;
  $$('.screen').forEach((s) => s.classList.toggle('is-active', s.id === 'screen-' + screen));
  const showNav = ['home', 'profile', 'list'].includes(screen);
  $('#nav').classList.toggle('is-visible', showNav);
  $$('#nav button').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === screen));
  // el botón flotante vive fuera de las pantallas para no desplazarse con el scroll
  $('#listFab').classList.toggle('is-visible', screen === 'list');
  $('.screen.is-active')?.scrollTo({ top: 0 });

  if (push) {
    const url = screen === 'list' && session.list ? `/l/${session.list.slug}` : '/';
    if (location.pathname !== url) history.pushState({ screen }, '', url);
  }
  if (screen === 'home') renderHome();
  if (screen === 'profile') renderProfile();
}

/* ---------------------------------------------------------------- sheets */

function openSheet(id) {
  $('#scrim').classList.add('is-open');
  $('#' + id).classList.add('is-open');
  buzz();
}
function closeSheets() {
  $('#scrim').classList.remove('is-open');
  $$('.sheet').forEach((s) => s.classList.remove('is-open'));
  stopScanner();
}

let toastTimer;
function toast(text, action) {
  clearTimeout(toastTimer);
  $('#toastText').textContent = text;
  const btn = $('#toastAction');
  btn.classList.toggle('hidden', !action);
  btn.onclick = null;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { $('#toast').classList.remove('is-open'); action.run(); };
  }
  $('#toast').classList.add('is-open');
  toastTimer = setTimeout(() => $('#toast').classList.remove('is-open'), action ? 6000 : 2800);
}

/* ------------------------------------------------------------- render */

function renderHome() {
  const lists = store.data.lists;
  const items = lists.reduce((n, l) => n + (l.count || 0), 0);
  const total = lists.reduce((n, l) => n + (l.total || 0), 0);

  const name = store.data.profile.name;
  $('#homeGreeting').textContent = name ? `de ${name}` : 'archivo';

  $('#homeStats').innerHTML = `
    <div class="stat"><b>${lists.length}</b><span>listas</span></div>
    <div class="stat"><b>${items}</b><span>productos</span></div>
    <div class="stat"><b>${total ? money(total) : '—'}</b><span>deseado</span></div>`;

  $('#homeEmpty').classList.toggle('hidden', lists.length > 0);
  $('#listStack').innerHTML = lists.map(listCard).join('');

  // bajadas de precio pendientes de ver, sumadas en todas las listas
  const drops = lists.reduce((n, l) => n + (l.drops || 0), 0);
  const withDrops = lists.filter((l) => l.drops);
  $('#homeDrops').innerHTML = drops ? `
    <button class="dropsbanner" data-open-drops="${esc(withDrops[0].slug)}">
      <b>↓ ${drops}</b>
      <span class="grow">${drops === 1 ? 'Una pieza ha bajado de precio' : `${drops} piezas han bajado de precio`}
        ${withDrops.length > 1 ? 'en varias listas' : `en ${esc(withDrops[0].name)}`}</span>
      <span>→</span>
    </button>` : '';

  const saved = store.data.saved || [];
  $('#savedSection').classList.toggle('hidden', !saved.length);
  $('#savedStack').innerHTML = saved.map(listCard).join('');
}

function listCard(l) {
  const covers = (l.covers || []).filter(Boolean);
  const cover = covers.length >= 2
    ? covers.slice(0, 4).map((c) => `<img src="${esc(imgSrc(c))}" alt="" loading="lazy">`).join('')
    : covers.length === 1
      ? `<img src="${esc(imgSrc(covers[0]))}" alt="" loading="lazy">`
      : `<span>${esc(l.emoji || '🛍️')}</span>`;
  const solo = covers.length < 2 ? ' listcard__cover--solo' : '';
  return `
    <button class="listcard" data-open-list="${esc(l.slug)}" data-theme="${esc(l.theme || 'pink')}">
      <span class="listcard__cover${solo}">${cover}</span>
      <span class="grow">
        <span class="title" style="display:block">${esc(l.emoji || '')} ${esc(l.name)}</span>
        <span class="kicker muted" style="display:block;margin-top:5px">
          ${l.count || 0} ítem${l.count === 1 ? '' : 's'} · ${l.total ? money(l.total) : (l.visibility === 'public' ? 'con enlace' : 'solo yo')}
        </span>
      </span>
      <span class="faint" style="font-size:22px">›</span>
    </button>`;
}

function renderList() {
  const list = session.list;
  if (!list) return;
  $('#screen-list').dataset.theme = list.theme || 'pink';
  $('#listEmoji').textContent = list.emoji || '🛍️';
  $('#listName').textContent = list.name;
  $('#listVisibility').textContent = list.visibility === 'public' ? '🌍 con enlace' : '🔒 solo yo';
  $('#listCount').textContent = list.items.length;
  $('#listRef').textContent = 'ref · ' + list.slug.slice(-5).toUpperCase();

  const total = sumTotal(list.items);
  $('#listTotal').textContent = total.value ? money(total.value, total.currency) : '—';

  const isOwner = list.role === 'owner';
  $('#btnEditList').classList.toggle('hidden', !isOwner);
  const canAdd = isOwner || list.allowContrib;
  $('#listFab').classList.toggle('hidden', !canAdd);
  $('#heroAdd').classList.toggle('hidden', !canAdd);

  // aviso cuando la lista es de otra persona
  const banner = $('#listBanner');
  if (!isOwner) {
    const saved = (store.data.saved || []).some((s) => s.slug === list.slug);
    banner.innerHTML = `
      <div class="banner" style="margin-top:16px">
        <span style="font-size:20px">👀</span>
        <span class="grow">Lista compartida${list.ownerName ? ` de <b>${esc(list.ownerName)}</b>` : ''}</span>
        ${saved ? '<span class="chip chip--lime">guardada</span>' : '<button class="btn btn--sm" data-action="save-list">Guardar</button>'}
      </div>`;
  } else banner.innerHTML = '';

  // filtros: el de bajadas enseña cuántas hay; el orden se cambia con el último botón
  const drops = countDrops(list.items);
  const pillDrops = $('#pillDrops');
  pillDrops.textContent = drops ? `↓ Bajadas · ${drops}` : '↓ Bajadas';
  pillDrops.classList.toggle('is-empty', !drops);
  const sortBtn = $('#btnSort');
  sortBtn.textContent = '⇅ ' + (SORTS.find(([k]) => k === session.sort) || SORTS[0])[1];
  sortBtn.classList.toggle('is-sorted', session.sort !== 'manual');

  const visible = sortItems(list.items.filter((it) =>
    session.filter === 'all' ? true
      : session.filter === 'bought' ? it.bought
        : session.filter === 'drops' ? !!dropOf(it)
          : !it.bought
  ));
  const empty = $('#listEmpty');
  empty.classList.toggle('hidden', visible.length > 0);
  if (!visible.length) {
    const copy = {
      all: ['✚', 'Lista vacía', 'Añade lo primero: un enlace, un escaneo o una captura.', true],
      pending: ['✓', 'Todo comprado', 'No queda nada por comprar en esta lista.', false],
      bought: ['♡', 'Nada comprado aún', 'Cuando compres una pieza, márcala en su ficha y aparecerá aquí.', false],
      drops: ['↓', 'Ninguna bajada todavía', 'Haul mira el precio de tus piezas cada pocas horas. Cuando alguno baje, aparecerá aquí con su sticker.', false],
    }[session.filter] || ['✚', 'Lista vacía', 'Añade lo primero.', true];
    $('.empty__emoji', empty).textContent = copy[0];
    $('.title', empty).textContent = copy[1];
    $('.lead', empty).textContent = copy[2];
    $('[data-action="add-item"]', empty).classList.toggle('hidden', !(copy[3] && canAdd));
  }
  const grid = $('#productGrid');
  grid.innerHTML = visible.map(productCard).join('')
    + (visible.length && canAdd && session.filter !== 'drops'
      ? `<button class="addcard" data-action="add-item"><b>¿Otra pieza?</b><span>pega enlace o captura</span></button>`
      : '');
  grid.classList.toggle('can-sort', canReorder());
  $$('#listFilters .pill[data-filter]').forEach((p) => p.classList.toggle('is-active', p.dataset.filter === session.filter));
  maybeHintReorder();
}

function sortItems(items) {
  const arr = [...items];
  const price = (i) => (Number.isFinite(i.priceValue) ? i.priceValue : null);
  switch (session.sort) {
    case 'price-desc': return arr.sort((a, b) => (price(b) ?? -1) - (price(a) ?? -1));
    case 'price-asc': return arr.sort((a, b) => (price(a) ?? Infinity) - (price(b) ?? Infinity));
    case 'recent': return arr.sort((a, b) => b.createdAt - a.createdAt);
    default: return arr;
  }
}

function cycleSort() {
  const i = SORTS.findIndex(([k]) => k === session.sort);
  session.sort = SORTS[(i + 1) % SORTS.length][0];
  buzz();
  renderList();
}

/** La primera vez que hay algo que ordenar, se cuenta cómo. */
function maybeHintReorder() {
  if (!canReorder() || store.data.hints?.reorder) return;
  store.data.hints = { ...(store.data.hints || {}), reorder: true };
  store.save();
  setTimeout(() => toast('Mantén pulsada una pieza para cambiarla de sitio'), 900);
}

function productCard(p) {
  const src = p.image ? imgSrc(p.image) : '';
  const sourceLabel = { scan: 'escaneado', shot: 'captura', manual: 'a mano' }[p.source];
  const drop = dropOf(p);
  const rise = riseOf(p);
  const go = p.bought ? 'comprado'
    : drop ? `<span class="down">antes ${esc(money(drop.from, p.currency))}</span>`
      : rise ? `<span class="up">↑ ${rise.pct}%</span>`
        : 'ver →';
  return `
    <article class="product${p.bought ? ' is-bought' : ''}" data-open-item="${esc(p.id)}">
      <div class="product__canvas">
        ${src
          ? `<img class="product__img" src="${esc(src)}" alt="" loading="lazy" draggable="false" onerror="this.style.visibility='hidden'">`
          : `<div class="product__img product__img--empty">🏷️</div>`}
        <span class="product__shop">${esc(p.shop || (sourceLabel ? sourceLabel : 'sin tienda'))}</span>
        <span class="product__tick">${p.bought ? '✓' : '♡'}</span>
        <span class="product__price">${esc(p.priceText || '—')}</span>
        ${drop ? `<span class="product__drop">↓ ${drop.pct}%</span>` : ''}
      </div>
      <div class="product__body">
        <div class="product__title">${esc(p.title)}</div>
        <div class="product__meta">
          <span>${p.note ? esc(p.note) : (sourceLabel || 'enlace')}</span>
          <span class="product__go">${go}</span>
        </div>
      </div>
    </article>`;
}

function renderProfile() {
  const p = store.data.profile;
  $('#profileAvatar').textContent = p.avatar;
  $('#profileTitle').textContent = p.name ? `Hola, ${p.name}` : 'Tu perfil';
  $('#profileName').value = p.name;
  $('#avatarPicker').innerHTML = AVATARS
    .map((a) => `<button data-avatar="${a}" class="${a === p.avatar ? 'is-active' : ''}">${a}</button>`).join('');

  const lists = store.data.lists;
  const items = lists.reduce((n, l) => n + (l.count || 0), 0);
  const bought = 0;
  $('#profileStats').innerHTML = `
    <div class="stat"><b>${lists.length}</b><span>listas</span></div>
    <div class="stat"><b>${items}</b><span>guardados</span></div>
    <div class="stat"><b>${(store.data.saved || []).length}</b><span>de otros</span></div>`;
  void bought;
  renderPushRow();
}

/* --------------------------------------------------------- abrir lista */

/** Pantalla de aviso cuando un enlace no se puede abrir. */
function showGate({ emoji, title, text, action }) {
  $('#gateEmoji').textContent = emoji;
  $('#gateTitle').textContent = title;
  $('#gateText').textContent = text;
  const btn = $('#gateAction');
  btn.classList.toggle('hidden', !action);
  if (action) { btn.textContent = action.label; btn.onclick = action.run; }
  goto('gate', { push: false });
}

async function openList(slug, { push = true, attempt = 0, filter = 'all' } = {}) {
  try {
    const { list } = await api(`/lists/${encodeURIComponent(slug)}`, { slug });
    session.list = list;
    session.filter = filter;
    session.sort = 'manual';
    if (list.role === 'owner') store.syncList(list);
    renderList();
    goto('list', { push });
  } catch (err) {
    // Una lista privada daba antes un aviso que se perdía: quien abría el
    // enlace se quedaba en la pantalla de inicio sin saber por qué.
    if (err.status === 403) {
      return showGate({
        emoji: '🔒',
        title: 'Esta lista es privada',
        text: 'Quien la creó tiene que abrir Compartir y activar el enlace. Avísale y vuelve a intentarlo.',
        action: { label: 'Reintentar', run: () => openList(slug, { push: false, filter }) },
      });
    }
    if (err.status === 404) {
      store.removeList(slug);
      return showGate({
        emoji: '🫥',
        title: 'Esta lista ya no existe',
        text: 'El enlace es correcto, pero la lista se ha borrado.',
        action: { label: 'Ir a mis hauls', run: () => goto('home') },
      });
    }
    // Fallo de red: en el plan gratuito el servidor se duerme y tarda
    // alrededor de un minuto en despertar en la primera visita.
    if (attempt < 2) {
      showGate({ emoji: '😴', title: 'Despertando el servidor', text: 'La primera visita del día tarda un poco. Seguimos intentándolo…' });
      await sleep(3500 * (attempt + 1));
      return openList(slug, { push, attempt: attempt + 1, filter });
    }
    showGate({
      emoji: '📡',
      title: 'No hemos podido conectar',
      text: 'Comprueba tu conexión y vuelve a intentarlo.',
      action: { label: 'Reintentar', run: () => openList(slug, { push: false, filter }) },
    });
  }
}

async function refreshList() {
  if (!session.list) return;
  const { list } = await api(`/lists/${encodeURIComponent(session.list.slug)}`, { slug: session.list.slug });
  session.list = list;
  if (list.role === 'owner') store.syncList(list);
  renderList();
}

/* ------------------------------------------------- formulario de lista */

function openListForm(mode) {
  session.listFormMode = mode;
  const list = mode === 'edit' ? session.list : null;
  $('#listFormTitle').textContent = mode === 'edit' ? 'Editar lista' : 'Nueva lista';
  $('#btnSaveList').textContent = mode === 'edit' ? 'Guardar cambios' : 'Crear lista';
  $('#btnDeleteList').classList.toggle('hidden', mode !== 'edit');
  $('#formListName').value = list?.name || '';

  const emoji = list?.emoji || EMOJIS[0];
  const theme = list?.theme || 'pink';
  $('#emojiPicker').innerHTML = EMOJIS
    .map((e) => `<button data-emoji="${e}" class="${e === emoji ? 'is-active' : ''}">${e}</button>`).join('');
  $('#themePicker').innerHTML = THEMES
    .map((t) => `<button class="swatch ${t === theme ? 'is-active' : ''}" data-theme-pick="${t}" data-theme="${t}" style="background:var(--accent)"></button>`).join('');
  $$('#visibilitySeg button').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.visibility === (list?.visibility || 'private')));

  openSheet('sheet-list-form');
  setTimeout(() => $('#formListName').focus(), 320);
}

function readListForm() {
  return {
    name: $('#formListName').value.trim() || 'Mi haul',
    emoji: $('#emojiPicker .is-active')?.dataset.emoji || EMOJIS[0],
    theme: $('#themePicker .is-active')?.dataset.themePick || 'pink',
    visibility: $('#visibilitySeg .is-active')?.dataset.visibility || 'private',
  };
}

async function submitListForm() {
  const payload = readListForm();
  const btn = $('#btnSaveList');
  btn.disabled = true;
  try {
    if (session.listFormMode === 'edit') {
      const slug = session.list.slug;
      const { list } = await api(`/lists/${slug}`, { method: 'PATCH', body: payload, slug });
      session.list = list;
      store.syncList(list);
      renderList();
      toast('Lista actualizada ✦');
    } else {
      const res = await api('/lists', { method: 'POST', body: { ...payload, ownerName: store.data.profile.name } });
      store.addList(res.list, res.ownerToken);
      session.list = res.list;
      renderList();
      goto('list');
      toast('Lista creada ✦');
      syncPushLists(); // si hay avisos activados, la lista nueva entra en ellos
      // si se venía de "compartir" sin listas, lo compartido entra ahora
      const shared = session.pendingShare;
      session.pendingShare = null;
      setTimeout(() => shareIntoList(shared), 420);
    }
    closeSheets();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------ añadir producto */

/**
 * Las apps no comparten un enlace a secas: Zalando manda "Artículos fantásticos
 * en Zalando: Converse-CHUCK TAYLOR… https://www.zalando.es/…", Amazon y SHEIN
 * algo parecido. De ese texto sale el enlace y, de regalo, un nombre de reserva
 * por si la tienda no deja leer su ficha.
 */
function isSelfUrl(url) {
  try { return new URL(url).hostname === location.hostname; } catch { return false; }
}
function safeDecode(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

/** "Artículos fantásticos en Zalando: adidas SAMBA - Zapatillas" → nombre y tienda, sin enlace. */
function guessFromShareText(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text || /https?:\/\//i.test(text) || text.length > 200) return { title: '', shop: '' };
  const m = text.match(/\b(?:en|on|at|de|from)\s+([A-ZÁÉÍÓÚÑ][\w&'.-]*(?:\s[A-ZÁÉÍÓÚÑ][\w&'.-]*)?)\s*:\s*(.{4,})$/);
  if (m) return { title: m[2].trim(), shop: m[1].trim() };
  const i = text.lastIndexOf(':');
  const title = (i >= 0 ? text.slice(i + 1) : text).trim();
  return { title: title.length >= 4 ? title : '', shop: '' };
}

function parseShared(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  const m = text.match(/https?:\/\/[^\s"'<>]+/i);
  if (!m) return { url: '', title: '' };
  let url = m[0].replace(/[).,;!?»”]+$/, '');
  // Al pegar en un campo de una línea se pierden los saltos de línea y el
  // texto que iba debajo queda pegado al enlace: ".htmlArtículos fantásticos…"
  url = url.replace(/(\.html?|\.php|\.aspx?)(?=[^/?#&=.\w]|[A-ZÁÉÍÓÚÑ]).*$/, '$1');
  // La propia dirección de Haul no es un producto. Si lleva un enlace detrás
  // de #add= (lo que abre el Atajo de iPhone), se lee ese; si no, no hay nada.
  if (isSelfUrl(url)) {
    const inner = url.split('#add=')[1] || '';
    return inner ? parseShared(safeDecode(inner)) : { url: '', title: '' };
  }
  let before = text.slice(0, m.index).trim();
  // "… en Zalando: Nombre" / "Check out … on Amazon: Nombre" → lo que va tras los dos puntos
  if (before.includes(':')) before = before.slice(before.lastIndexOf(':') + 1).trim();
  before = before.replace(/^[«"“']|[»"”'\-–—|:]+$/g, '').trim();
  const title = before.length >= 4 && before.length <= 160 && !/^https?:/i.test(before) ? before : '';
  return { url, title };
}

function openAdd(prefillUrl, { photo = null } = {}) {
  if (!session.list) { toast('Abre o crea una lista primero'); return; }
  resetAdd();
  session.sharedPhoto = photo && photo.type && photo.type.startsWith('image/') ? photo : null;
  openSheet('sheet-add');
  if (prefillUrl) {
    setTab('link');
    const shared = parseShared(prefillUrl);
    session.hint = shared.title ? { title: shared.title } : null;
    $('#urlInput').value = shared.url || prefillUrl;
    readUrl();
  } else {
    setTab('link');
    tryClipboard();
  }
}

function resetAdd() {
  session.pending = null;
  session.hint = null;
  session.sharedPhoto = null;
  session.editingItem = null;
  session.forceDup = false;
  session.dupItem = null;
  $('#addPreview').classList.add('hidden');
  $('#addError').classList.add('hidden');
  $('#addDup').classList.add('hidden');
  $('#addLoader').classList.add('hidden');
  $('#shotProgress').classList.add('hidden');
  $('#urlInput').value = '';
  $('#btnSaveItem').textContent = 'Guardar en la lista';
  $('#addTitle').textContent = 'Añadir';
}

function setTab(tab) {
  $$('#addTabs button').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
  for (const t of ['link', 'scan', 'shot']) $('#tab-' + t).classList.toggle('hidden', t !== tab);
  if (tab !== 'scan') stopScanner();
}

/**
 * Lee el portapapeles entero. En iPhone, al copiar desde la app de una tienda,
 * el enlace viaja como un elemento aparte del texto (y a veces con la foto del
 * producto): readText() solo devuelve el texto, sin el enlace.
 */
async function readClipboard() {
  const out = { text: '', file: null };
  try {
    if (navigator.clipboard?.read) {
      const parts = [];
      for (const item of await navigator.clipboard.read()) {
        for (const type of item.types) {
          if (type === 'text/plain' || type === 'text/uri-list') {
            parts.push(await (await item.getType(type)).text());
          } else if (type.startsWith('image/') && !out.file) {
            out.file = new File([await item.getType(type)], 'pegado.png', { type });
          }
        }
      }
      out.text = parts.join(' ');
    }
  } catch { /* sin permiso o sin soporte: probamos solo texto */ }
  if (!out.text && navigator.clipboard?.readText) {
    try { out.text = await navigator.clipboard.readText(); } catch { /* el usuario pega a mano */ }
  }
  out.text = out.text.replace(/\s+/g, ' ').trim();
  return out;
}

async function tryClipboard() {
  try {
    const { text, file } = await readClipboard();
    const shared = parseShared(text);
    if (shared.url && text.length < 1500) {
      $('#urlInput').value = shared.url;
      session.hint = shared.title ? { title: shared.title } : null;
      if (file && !session.sharedPhoto) session.sharedPhoto = file;
      toast('Enlace pegado del portapapeles');
    }
  } catch { /* sin permiso: el usuario pega a mano */ }
}

function showAddError(message, { offerShot = true, hint = '' } = {}) {
  const box = $('#addError');
  box.innerHTML =
    `<b>${esc(message)}</b>` +
    (hint ? `<div class="small" style="margin-top:6px">${esc(hint)}</div>` : '') +
    (offerShot
      ? `<button class="btn btn--sm" style="margin-top:12px" data-goto-shot>📸 Hacer una captura</button>`
      : '');
  box.classList.remove('hidden');
  box.querySelector('[data-goto-shot]')?.addEventListener('click', () => {
    setTab('shot');
    $('#shotInput').click();
  });
}

/** Mientras se lee una tienda lenta, contar qué está pasando. */
let loaderTimers = [];
function setLoading(on, text = 'Leyendo la tienda…') {
  loaderTimers.forEach(clearTimeout);
  loaderTimers = [];
  $('#addLoaderText').textContent = text;
  $('#addLoader').classList.toggle('hidden', !on);
  if (!on) return;
  $('#addError').classList.add('hidden');
  if (text !== 'Leyendo la tienda…') return;
  loaderTimers.push(
    setTimeout(() => { $('#addLoaderText').textContent = 'Abriendo la ficha del producto…'; }, 4000),
    setTimeout(() => { $('#addLoaderText').textContent = 'Esta tienda va lenta, aguanta…'; }, 11000)
  );
}

async function readUrl() {
  // si se ha pegado el texto entero de "compartir", se queda solo el enlace
  const typed = $('#urlInput').value.trim();
  const shared = parseShared(typed);
  if (shared.url && shared.url !== typed) {
    $('#urlInput').value = shared.url;
    if (shared.title) session.hint = { title: shared.title };
  }
  const url = shared.url || typed;
  if (!/^https?:\/\//i.test(url) || isSelfUrl(url)) {
    const guess = guessFromShareText(typed);
    if (guess.title) {
      // Llegó el texto de la tienda pero sin el enlace (pasa al copiar desde
      // algunas apps en iPhone): queda el nombre y se pide el enlace.
      showAddError('El texto copiado no traía el enlace del producto', {
        hint: 'Te dejo el nombre. Para que lea foto y precio, en la ficha de la tienda toca compartir y elige "Copiar enlace", o pégalo aquí desde el navegador.',
      });
      showPreview({ title: guess.title, shop: guess.shop, url: '', image: '', priceText: '', source: 'manual' });
      if (session.sharedPhoto) attachPhoto(session.sharedPhoto);
      return;
    }
    showAddError('Pega el enlace del producto (o el texto que comparte la app de la tienda)');
    return;
  }
  setLoading(true);
  $('#addPreview').classList.add('hidden');
  try {
    const data = await api('/extract', { method: 'POST', body: { url } });
    showPreview({ ...data, source: 'url', url: data.url || url });
    if (!data.image && session.sharedPhoto) attachPhoto(session.sharedPhoto);
  } catch (err) {
    // Aunque la tienda nos cierre la puerta, del propio enlace se saca
    // el nombre y la tienda: así el formulario no empieza vacío.
    const fb = (err.data && err.data.fallback) || {};
    const blocked = err.code === 'BLOCKED';
    showAddError(
      blocked ? `${fb.shop || 'Esta tienda'} no deja que otras apps lean sus fichas` : err.message,
      { hint: 'Haz una captura de la ficha y la usamos como foto del producto. El precio lo lee sola.' }
    );
    showPreview({
      // el nombre que venía en el texto compartido es mejor que el sacado de la URL
      title: (session.hint && session.hint.title) || fb.title || '',
      url: fb.url || url,
      image: '',
      priceText: '',
      shop: fb.shop || hostOf(url),
      source: 'url',
    });
    if (session.sharedPhoto) attachPhoto(session.sharedPhoto);
  } finally {
    setLoading(false);
  }
}

function hostOf(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
    return h.charAt(0).toUpperCase() + h.slice(1);
  } catch { return ''; }
}

function showPreview(data) {
  session.pending = data;
  const img = $('#previewImg');
  img.src = data.image ? imgSrc(data.image) : placeholderImg();
  img.classList.toggle('preview__img--empty', !data.image);
  img.onerror = function () { this.src = placeholderImg(); this.classList.add('preview__img--empty'); };
  $('#previewTitle').value = data.title || '';
  $('#previewPrice').value = data.priceText || '';
  $('#previewShop').value = data.shop || '';
  $('#previewNote').value = data.note || '';
  $('#addPreview').classList.remove('hidden');
  $('#addPreview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  buzz(18);
  checkDuplicate(data);
}

/* ---------------------------------------------------------- duplicados */

/** El mismo enlace, o la misma ficha con otros parámetros (talla, color…). */
function sameProduct(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const stem = (u) => u.origin + u.pathname.replace(/\/+$/, '');
    // sin ruta (tienda.com/?pid=…) el producto va en la query: solo vale el enlace exacto
    return ua.pathname.split('/').filter(Boolean).length >= 1 && stem(ua) === stem(ub);
  } catch { return false; }
}

function checkDuplicate(data) {
  session.forceDup = false;
  session.dupItem = null;
  $('#addDup').classList.add('hidden');
  if (!session.list || session.editingItem || !data || !data.url) return;
  const dup = session.list.items.find((i) => sameProduct(i.url, data.url));
  if (dup) showDuplicate(dup);
}

function showDuplicate(dup) {
  session.dupItem = dup;
  const box = $('#addDup');
  box.innerHTML = `
    <b>Ya tienes esta pieza en la lista</b>
    <div class="dup__row">
      ${dup.image
        ? `<img class="dup__img" src="${esc(imgSrc(dup.image))}" alt="">`
        : '<span class="dup__img" style="display:grid;place-items:center">🏷️</span>'}
      <span class="grow small"><b>${esc(dup.title)}</b><br>
        <span class="muted">${dup.priceText ? esc(dup.priceText) + ' · ' : ''}añadida ${timeAgo(dup.createdAt)}${dup.bought ? ' · comprada' : ''}</span></span>
    </div>
    <div class="dup__actions">
      <button class="btn btn--sm" data-dup="open">Ver la que tienes</button>
      <button class="btn btn--sm btn--ghost" data-dup="force">Guardar igualmente</button>
    </div>`;
  box.classList.remove('hidden');
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  buzz([10, 30, 10]);
}

function placeholderImg() {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="780" height="300"><rect width="100%" height="100%" fill="#f1ecfb"/><text x="50%" y="56%" font-family="monospace" font-size="30" text-anchor="middle" fill="#6f6889">＋ toca para añadir foto</text></svg>`
  );
}

/** Cambia solo la foto del producto, sin tocar lo que ya se haya escrito. */
async function attachPhoto(file) {
  if (!file || !file.type.startsWith('image/')) return;
  try {
    const shot = await downscale(file);
    session.pending = { ...(session.pending || {}), image: shot.dataUrl };
    const img = $('#previewImg');
    img.src = shot.dataUrl;
    img.classList.remove('preview__img--empty');
    buzz(14);
  } catch {
    toast('No hemos podido leer esa imagen');
  }
}

async function saveItem() {
  const list = session.list;
  if (!list) return;
  const body = {
    title: $('#previewTitle').value.trim() || 'Producto',
    priceText: $('#previewPrice').value.trim(),
    shop: $('#previewShop').value.trim(),
    note: $('#previewNote').value.trim(),
    url: session.pending?.url || '',
    image: session.pending?.image || '',
    priceValue: session.pending?.priceValue,
    currency: session.pending?.currency,
    source: session.pending?.source || 'manual',
    addedBy: store.data.profile.name,
    force: session.forceDup,
  };
  const btn = $('#btnSaveItem');
  btn.disabled = true;
  try {
    if (session.editingItem) {
      await api(`/lists/${list.slug}/items/${session.editingItem}`, { method: 'PATCH', body, slug: list.slug });
      toast('Producto actualizado');
    } else {
      await api(`/lists/${list.slug}/items`, { method: 'POST', body, slug: list.slug });
      toast('Guardado ✦');
    }
    closeSheets();
    await refreshList();
  } catch (err) {
    // el servidor también vigila los repetidos (por si la lista cambió desde otro móvil)
    if (err.code === 'DUPLICATE' && err.data && err.data.item) showDuplicate(err.data.item);
    else showAddError(err.message, { offerShot: false });
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------- escáner */

async function startScanner() {
  try {
    await loadScript(CDN.zxing);
    const reader = new window.ZXing.BrowserMultiFormatReader();
    session.scanner = reader;
    $('#scannerBox').classList.remove('hidden');
    $('#scanIntro').classList.add('hidden');
    $('#btnScanToggle').textContent = 'Apagar cámara';

    await reader.decodeFromConstraints(
      { video: { facingMode: { ideal: 'environment' } } },
      $('#scannerVideo'),
      (result) => { if (result) onCodeDetected(result.getText()); }
    );
  } catch (err) {
    stopScanner();
    showAddError('No hemos podido abrir la cámara. Revisa los permisos del navegador.');
  }
}

function stopScanner() {
  if (session.scanner) {
    try { session.scanner.reset(); } catch {}
    session.scanner = null;
  }
  const box = $('#scannerBox');
  if (box) box.classList.add('hidden');
  const intro = $('#scanIntro');
  if (intro) intro.classList.remove('hidden');
  const btn = $('#btnScanToggle');
  if (btn) btn.textContent = 'Encender cámara';
}

let lastCode = '';
async function onCodeDetected(text) {
  if (!text || text === lastCode) return;
  lastCode = text;
  setTimeout(() => { lastCode = ''; }, 3000);
  buzz([18, 40, 18]);
  stopScanner();

  // un QR puede llevar directamente a la ficha del producto
  if (/^https?:\/\//i.test(text)) {
    setTab('link');
    $('#urlInput').value = text;
    toast('QR leído · buscando producto');
    return readUrl();
  }

  setLoading(true, 'Buscando el código…');
  try {
    const data = await api('/barcode/' + encodeURIComponent(text.replace(/\D/g, '')));
    showPreview({ ...data, source: 'scan' });
    toast('Producto encontrado ✦');
  } catch (err) {
    showAddError(`${err.message}. Código ${esc(text)}.`);
    showPreview({ title: '', shop: '', image: '', priceText: '', note: 'EAN ' + text, source: 'scan' });
  } finally {
    setLoading(false);
  }
}

/* ------------------------------------------------------------- captura */

/** Reduce la imagen para que quepa holgada en la base de datos. */
function downscale(file, max = 620, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', quality), width: canvas.width, height: canvas.height });
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function guessFromText(text) {
  const lines = String(text || '')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 2);

  const urlMatch = text.match(/https?:\/\/[^\s"'<>]+/i);
  const priceMatch = text.match(/(?:€|EUR|\$|USD|£)\s?\d{1,4}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d{1,4}(?:[.,]\d{3})*(?:[.,]\d{1,2})?\s?(?:€|EUR|\$|USD|£)/i);

  // el título suele ser la línea larga con más letras y sin precio
  const title = lines
    .filter((l) => l.length >= 6 && l.length <= 90 && /[a-záéíóúñ]/i.test(l) && !/€|\$|£/.test(l))
    .sort((a, b) => b.length - a.length)[0] || '';

  return { url: urlMatch ? urlMatch[0] : '', priceText: priceMatch ? priceMatch[0].trim() : '', title };
}

async function handleShot(file) {
  if (!file || !file.type.startsWith('image/')) return;
  // Si ya había una vista previa abierta (por ejemplo con el nombre sacado del
  // enlace), lo escrito manda sobre lo que adivine el OCR.
  const keep = $('#addPreview').classList.contains('hidden') ? {} : {
    title: $('#previewTitle').value.trim(),
    shop: $('#previewShop').value.trim(),
    price: $('#previewPrice').value.trim(),
    url: session.pending?.url || '',
  };
  const bar = $('#shotProgress');
  const fill = bar.querySelector('span');
  bar.classList.remove('hidden');
  fill.style.width = '10%';
  setLoading(true, 'Leyendo la captura…');
  $('#addPreview').classList.add('hidden');

  let shot;
  try { shot = await downscale(file); } catch { setLoading(false); bar.classList.add('hidden'); return showAddError('No hemos podido leer esa imagen'); }
  fill.style.width = '30%';

  // 1) ¿hay un QR o un código de barras en la imagen?
  try {
    await loadScript(CDN.zxing);
    const reader = new window.ZXing.BrowserMultiFormatReader();
    const result = await reader.decodeFromImageUrl(shot.dataUrl).catch(() => null);
    if (result) {
      bar.classList.add('hidden');
      setLoading(false);
      return onCodeDetected(result.getText());
    }
  } catch { /* seguimos con el OCR */ }
  fill.style.width = '45%';

  // 2) OCR para sacar texto, precio y posible enlace
  let guess = { url: '', priceText: '', title: '' };
  try {
    setLoading(true, 'Reconociendo el texto…');
    await loadScript(CDN.tesseract);
    const { data } = await window.Tesseract.recognize(shot.dataUrl, 'spa+eng', {
      logger: (m) => { if (m.status === 'recognizing text') fill.style.width = `${45 + m.progress * 45}%`; },
    });
    guess = guessFromText(data.text || '');
  } catch { /* sin OCR: la captura sigue valiendo como foto */ }
  fill.style.width = '95%';

  // 3) si el texto contenía una URL, la tienda manda
  if (guess.url) {
    try {
      setLoading(true, 'Abriendo la tienda del enlace…');
      const data = await api('/extract', { method: 'POST', body: { url: guess.url } });
      bar.classList.add('hidden');
      setLoading(false);
      return showPreview({ ...data, source: 'shot' });
    } catch { /* seguimos con lo que sacó el OCR */ }
  }

  bar.classList.add('hidden');
  setLoading(false);
  showPreview({
    title: keep.title || guess.title,
    priceText: keep.price || guess.priceText,
    shop: keep.shop || '',
    image: shot.dataUrl,
    url: keep.url || guess.url,
    source: 'shot',
  });
  toast(guess.title || guess.priceText ? 'Datos leídos de la captura' : 'Revisa los datos y guarda');
}

/* ------------------------------------------------------ detalle producto */

function openItem(id) {
  const item = session.list?.items.find((i) => i.id === id);
  if (!item) return;
  session.item = item;
  $('#itemImg').src = item.image ? imgSrc(item.image) : placeholderImg();
  $('#itemImg').onerror = function () { this.src = placeholderImg(); };
  $('#itemTitle').textContent = item.title;
  $('#itemPrice').textContent = item.priceText || 'sin precio';
  $('#itemShop').textContent = item.shop || 'sin tienda';
  $('#itemNote').textContent = item.note || '';
  $('#itemNote').classList.toggle('hidden', !item.note);
  const link = $('#itemLink');
  link.href = item.url || '#';
  link.classList.toggle('hidden', !item.url);
  $('#btnToggleBought').textContent = item.bought ? '↺ Aún no' : '✓ Comprado';
  const isOwner = session.list.role === 'owner';
  $('#btnDeleteItem').classList.toggle('hidden', !isOwner);
  $('#btnEditItem').classList.toggle('hidden', !isOwner);
  $('#btnToggleBought').classList.toggle('hidden', !isOwner);
  renderPriceBox(item);
  openSheet('sheet-item');
}

/* ------------------------------------------------- precio en la ficha */

function renderPriceBox(item) {
  const box = $('#itemPriceBox');
  const hasUrl = /^https?:\/\//i.test(item.url || '');
  const hasPrice = Number.isFinite(item.priceValue);
  const isOwner = session.list.role === 'owner';
  const show = hasUrl && (hasPrice || isOwner);
  box.classList.toggle('hidden', !show);
  const dropChip = $('#itemDrop');
  dropChip.classList.add('hidden');
  if (!show) return;

  const cur = item.currency || 'EUR';
  const drop = dropOf(item);
  if (drop) { dropChip.textContent = `↓ ${drop.pct}%`; dropChip.classList.remove('hidden'); }

  $('#ppNow').textContent = hasPrice ? money(item.priceValue, cur) : '—';

  const before = $('#ppBefore');
  before.className = '';
  if (Number.isFinite(item.prevPrice)) {
    before.textContent = money(item.prevPrice, cur);
    before.classList.add('is-old');
  } else if (Number.isFinite(item.basePrice) && hasPrice && Math.abs(item.basePrice - item.priceValue) > 0.004) {
    before.textContent = money(item.basePrice, cur);
    before.classList.add('is-old');
  } else {
    before.textContent = hasPrice ? 'igual' : '—';
  }

  const low = $('#ppLow');
  low.className = '';
  if (Number.isFinite(item.lowPrice)) {
    low.textContent = money(item.lowPrice, cur);
    if (hasPrice && item.lowPrice >= item.priceValue - 0.004) low.classList.add('is-low');
  } else low.textContent = '—';

  $('#ppChecked').textContent = item.checkedAt ? `Comprobado ${timeAgo(item.checkedAt)}` : 'Sin comprobar todavía';
  const btn = $('#btnRecheck');
  btn.classList.toggle('hidden', !isOwner);
  btn.disabled = false;
  btn.textContent = 'Comprobar ahora';

  drawSpark([]);
  loadHistory(item);
}

async function loadHistory(item) {
  try {
    const { points } = await api(`/lists/${session.list.slug}/items/${item.id}/history`, { slug: session.list.slug });
    if (session.item && session.item.id === item.id) drawSpark(points || []);
  } catch { drawSpark([]); }
}

/** Evolución del precio: línea a saltos, porque los precios cambian a saltos. */
function drawSpark(points) {
  const canvas = $('#itemSpark');
  canvas.classList.toggle('hidden', points.length < 2);
  if (points.length < 2) return;
  const cw = canvas.clientWidth || 320;
  canvas.width = cw * 2;
  canvas.height = 92;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || Math.max(1, max * 0.1);
  const pad = 12;
  const x = (i) => pad + (i / (points.length - 1)) * (W - pad * 2);
  const y = (v) => H - pad - ((v - min) / span) * (H - pad * 2);

  ctx.clearRect(0, 0, W, H);
  ctx.beginPath();
  ctx.moveTo(x(0), H);
  points.forEach((p, i) => { if (i) ctx.lineTo(x(i), y(points[i - 1].value)); ctx.lineTo(x(i), y(p.value)); });
  ctx.lineTo(x(points.length - 1), H);
  ctx.closePath();
  ctx.fillStyle = 'rgba(98, 250, 60, .28)';
  ctx.fill();

  ctx.beginPath();
  points.forEach((p, i) => {
    if (i === 0) ctx.moveTo(x(i), y(p.value));
    else { ctx.lineTo(x(i), y(points[i - 1].value)); ctx.lineTo(x(i), y(p.value)); }
  });
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#111113';
  ctx.stroke();

  const lx = x(points.length - 1);
  const ly = y(vals[vals.length - 1]);
  ctx.beginPath();
  ctx.arc(lx, ly, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#62fa3c';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.stroke();
}

async function recheckItem() {
  const item = session.item;
  const list = session.list;
  if (!item || !list) return;
  const btn = $('#btnRecheck');
  btn.disabled = true;
  btn.textContent = 'Leyendo la tienda…';
  try {
    const r = await api(`/lists/${list.slug}/items/${item.id}/check`, { method: 'POST', slug: list.slug });
    const idx = list.items.findIndex((i) => i.id === item.id);
    if (idx >= 0) list.items[idx] = r.item;
    session.item = r.item;
    if (list.role === 'owner') store.syncList(list);
    renderList();
    renderPriceBox(r.item);
    $('#itemPrice').textContent = r.item.priceText || 'sin precio';
    if (!r.found) toast('No hemos podido leer el precio ahora mismo');
    else if (r.dropped) toast(`¡Ha bajado un ${Math.abs(r.pct)}%! ✦`);
    else if (r.changed) toast(`Ha subido un ${Math.abs(r.pct)}%`);
    else toast('Sigue al mismo precio');
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
    btn.textContent = 'Comprobar ahora';
  }
}

async function toggleBought() {
  const item = session.item;
  if (!item) return;
  try {
    await api(`/lists/${session.list.slug}/items/${item.id}`, {
      method: 'PATCH', body: { bought: !item.bought }, slug: session.list.slug,
    });
    closeSheets();
    await refreshList();
    toast(item.bought ? 'De vuelta a la lista' : '¡Comprado! ✓');
  } catch (err) { toast(err.message); }
}

async function deleteItem() {
  const item = session.item;
  if (!item) return;
  const slug = session.list.slug;
  try {
    await api(`/lists/${slug}/items/${item.id}`, { method: 'DELETE', slug });
    closeSheets();
    await refreshList();
    toast('Producto eliminado', {
      label: 'Deshacer',
      run: async () => {
        await api(`/lists/${slug}/items`, {
          method: 'POST', slug,
          body: {
            title: item.title, url: item.url, image: item.image, priceText: item.priceText,
            priceValue: item.priceValue, currency: item.currency, shop: item.shop,
            note: item.note, source: item.source,
          },
        });
        await refreshList();
      },
    });
  } catch (err) { toast(err.message); }
}

function editItem() {
  const item = session.item;
  closeSheets();
  setTimeout(() => {
    resetAdd();
    openSheet('sheet-add');
    setTab('link');
    session.editingItem = item.id;
    $('#addTitle').textContent = 'Editar producto';
    $('#btnSaveItem').textContent = 'Guardar cambios';
    showPreview(item);
  }, 260);
}

/* ------------------------------------------------------------ compartir */

/**
 * Compartir la lista entera o un solo producto. El enlace de producto abre
 * directamente su tarjeta, sin que el otro tenga que buscarlo en la lista.
 */
async function openShare({ item = null } = {}) {
  const list = session.list;
  if (!list) return;
  session.sharingItem = item;

  const url = item
    ? `${location.origin}/l/${list.slug}/p/${item.id}`
    : `${location.origin}/l/${list.slug}`;

  $('#shareTitle').textContent = item ? 'Compartir pieza' : 'Compartir';
  $('#shareSummary').textContent = item
    ? `${item.title}${item.priceText ? ' · ' + item.priceText : ''}`
    : `${list.items.length} producto${list.items.length === 1 ? '' : 's'} · ${list.name}`;
  $('#shareLink').textContent = url;
  $('#sharePrivateNote').classList.toggle('hidden', list.visibility === 'public');
  $('#shareContribBox').classList.toggle('hidden', list.role !== 'owner' || !!item);
  refreshShareSheet();
  openSheet('sheet-share');
  prepareCover(); // la portada se dibuja mientras tanto

  const box = $('#shareQr');
  box.innerHTML = '';
  try {
    await loadScript(CDN.qrcode);
    const canvas = document.createElement('canvas');
    await window.QRCode.toCanvas(canvas, url, { width: 320, margin: 1, color: { dark: '#111113', light: '#ffffff' } });
    box.appendChild(canvas);
  } catch {
    box.innerHTML = '<span class="small faint">QR no disponible sin conexión</span>';
  }
}

function refreshShareSheet() {
  const list = session.list;
  if (!list) return;
  $('#sharePrivateNote').classList.toggle('hidden', list.visibility === 'public');
  const btn = $('#btnToggleContrib');
  btn.textContent = list.allowContrib ? '●' : '○';
  btn.classList.toggle('iconbtn--accent', !!list.allowContrib);
}

/**
 * Compartir implica poder ver. Si la lista sigue siendo privada, al copiar o
 * enviar el enlace se activa sola: antes el enlace llegaba roto y quien lo
 * abría no entendía por qué. No se espera a que termine para no perder el
 * gesto del usuario, que en iOS es lo que permite abrir el menú de compartir.
 */
function publishIfNeeded() {
  const list = session.list;
  if (!list || list.role !== 'owner' || list.visibility === 'public') return;
  api(`/lists/${list.slug}`, { method: 'PATCH', slug: list.slug, body: { visibility: 'public' } })
    .then((res) => {
      session.list = res.list;
      store.syncList(res.list);
      renderList();
      refreshShareSheet();
      toast('Enlace activado: ya pueden verla ✦');
    })
    .catch((err) => toast(err.message));
}

async function copyLink() {
  publishIfNeeded();
  const text = $('#shareLink').textContent;
  try { await navigator.clipboard.writeText(text); toast('Enlace copiado ✦'); }
  catch { toast('Mantén pulsado el enlace para copiarlo'); }
}

async function nativeShare() {
  const list = session.list;
  publishIfNeeded();
  const item = session.sharingItem;
  const url = $('#shareLink').textContent;
  const data = item
    ? { title: item.title, text: `${item.title}${item.priceText ? ' · ' + item.priceText : ''}`, url }
    : { title: `${list.emoji} ${list.name}`, text: 'Mira lo que quiero comprarme 👀', url };
  if (navigator.share) { try { await navigator.share(data); } catch {} }
  else copyLink();
}

async function toggleContrib() {
  const list = session.list;
  try {
    const res = await api(`/lists/${list.slug}`, {
      method: 'PATCH', slug: list.slug,
      body: { allowContrib: !list.allowContrib, visibility: 'public' },
    });
    session.list = res.list;
    renderList();
    openShare();
    toast(res.list.allowContrib ? 'Ahora pueden añadir productos' : 'Solo tú puedes añadir');
  } catch (err) { toast(err.message); }
}

/* ------------------------------------------------ portada para historias */

/**
 * Una imagen 9:16 con la lista, en el mismo lenguaje que la app: papel con
 * retícula, recortes con sombra dura, precio como pegatina y un QR que abre
 * el enlace. Se dibuja en el móvil, sin pasar por el servidor.
 */
const coverCache = { key: '', blob: null, url: '' };

function coverKey(list) {
  return [list.slug, list.updatedAt, list.items.length, list.visibility, list.name, list.emoji].join(':');
}

async function prepareCover() {
  const list = session.list;
  const box = $('#shareCoverBox');
  if (!list || session.sharingItem) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const img = $('#shareCoverImg');
  const skel = $('#shareCoverSkel');
  const key = coverKey(list);
  if (coverCache.key === key && coverCache.url) {
    img.src = coverCache.url;
    img.classList.remove('hidden');
    skel.classList.add('hidden');
    return;
  }
  img.classList.add('hidden');
  skel.classList.remove('hidden');
  try {
    const blob = await renderCover(list);
    if (coverCache.url) URL.revokeObjectURL(coverCache.url);
    coverCache.key = key;
    coverCache.blob = blob;
    coverCache.url = URL.createObjectURL(blob);
    if (!session.list || session.list.slug !== list.slug) return;
    img.src = coverCache.url;
    img.classList.remove('hidden');
    skel.classList.add('hidden');
  } catch {
    skel.innerHTML = '<span class="small faint">No se ha podido dibujar la portada</span>';
  }
}

function loadImage(src) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = src;
  });
}

async function renderCover(list) {
  const W = 1080;
  const H = 1920;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const INK = '#111113';
  const PAPER = '#fbfbfd';
  const LIME = '#62fa3c';
  const SKY = '#5d9bff';
  const FAINT = '#8b8f9a';
  const WASH = '#f3f1f7';
  const GROTESK = '"Space Grotesk", system-ui, -apple-system, sans-serif';
  const SERIF = '"Playfair Display", Georgia, serif';
  const MONO = '"Space Mono", ui-monospace, monospace';
  try {
    await Promise.all([
      document.fonts.load(`700 100px ${GROTESK}`),
      document.fonts.load(`italic 400 60px ${SERIF}`),
      document.fonts.load(`700 26px ${MONO}`),
    ]);
  } catch { /* con las de reserva también vale */ }

  const items = list.items || [];
  const total = sumTotal(items);
  const drops = countDrops(items);
  const url = `${location.origin}/l/${list.slug}`;

  // papel, bruma de color y retícula
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
  const glow = (x, y, r, color) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  };
  glow(900, 320, 560, 'rgba(200,179,249,.6)');
  glow(120, 820, 480, 'rgba(93,155,255,.34)');
  glow(940, 1540, 540, 'rgba(98,250,60,.28)');
  ctx.strokeStyle = 'rgba(93,155,255,.15)';
  ctx.lineWidth = 2;
  for (let x = 0; x <= W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  const setFont = (weight, size, family, style = '') => { ctx.font = `${style} ${weight} ${size}px ${family}`.trim(); };
  const spacing = (px) => { if ('letterSpacing' in ctx) ctx.letterSpacing = px + 'px'; };
  const box = (x, y, w, h, fill, { dx = 8, dy = 8, border = 3, shadow = INK } = {}) => {
    if (dx || dy) { ctx.fillStyle = shadow; ctx.fillRect(x + dx, y + dy, w, h); }
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    ctx.lineWidth = border;
    ctx.strokeStyle = INK;
    ctx.strokeRect(x, y, w, h);
  };
  const tag = (text, x, y, { fill = '#fff', color = INK, size = 22, pad = 14, border = INK, align = 'left' } = {}) => {
    setFont(700, size, MONO);
    spacing(2);
    const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
    const h = Math.round(size * 1.9);
    const left = align === 'right' ? x - w : x;
    ctx.fillStyle = fill;
    ctx.fillRect(left, y, w, h);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = border;
    ctx.strokeRect(left, y, w, h);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + pad, y + h / 2 + 1);
    spacing(0);
    ctx.textBaseline = 'alphabetic';
    return { w, h, left };
  };
  const wrap = (text, maxW, maxLines) => {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width <= maxW || !line) line = t;
      else { lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      lines.length = maxLines;
      lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
    }
    return lines;
  };
  const rotated = (cx, cy, deg, draw) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((deg * Math.PI) / 180);
    draw();
    ctx.restore();
  };

  /* cabecera: marca y etiqueta de registro */
  setFont(700, 64, GROTESK);
  spacing(-3);
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  ctx.fillText('HAUL', 96, 322);
  const brandW = ctx.measureText('HAUL').width;
  spacing(0);
  ctx.fillStyle = SKY;
  setFont(700, 40, GROTESK);
  ctx.fillText('●', 96 + brandW + 2, 322);
  tag('archivo / ' + new Date().getFullYear(), W - 96, 272, { fill: 'rgba(215,227,255,.92)', color: '#005cbb', border: SKY, align: 'right' });

  /* titular */
  setFont(700, 24, MONO);
  spacing(3);
  ctx.fillStyle = FAINT;
  const kicker = `${items.length} ${items.length === 1 ? 'pieza' : 'piezas'}${total.value ? ' · ' + money(total.value, total.currency) : ''}${list.ownerName ? ' · de ' + list.ownerName : ''}`.toUpperCase();
  ctx.fillText(kicker, 96, 430);
  spacing(0);

  const name = list.name || 'Mi haul';
  let size = 124;
  setFont(700, size, GROTESK);
  spacing(-5);
  while (ctx.measureText(name).width > 760 && size > 88) { size -= 6; setFont(700, size, GROTESK); }
  let lines = [name];
  if (ctx.measureText(name).width > 760) { size = 88; setFont(700, size, GROTESK); lines = wrap(name, 760, 2); }
  ctx.fillStyle = INK;
  let ty = 460 + size;
  for (const l of lines) { ctx.fillText(l, 96, ty); ty += size * 0.98; }
  spacing(0);
  setFont(400, 58, SERIF, 'italic');
  ctx.fillText('todo lo que quiero, en un sitio.', 96, ty + 16);
  const titleBottom = ty + 40;

  // el emoji de la lista, como pegatina redonda
  rotated(W - 96 - 70, 520, 7, () => {
    ctx.fillStyle = INK;
    ctx.beginPath(); ctx.arc(8, 8, 70, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(0, 0, 70, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = INK; ctx.stroke();
    setFont(400, 74, 'system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = INK;
    ctx.fillText(list.emoji || '✶', 0, 6);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  });

  /* collage de piezas */
  const y0 = Math.max(titleBottom + 40, 740);
  const candidates = items.filter((i) => i.image).slice(0, 6);
  const loaded = (await Promise.all(candidates.map(async (i) => ({ item: i, img: await loadImage(imgSrc(i.image)) }))))
    .filter((x) => x.img).slice(0, 3);
  const noPicture = items.filter((i) => !i.image).slice(0, 3);

  const card = (entry, x, y, s, deg) => {
    rotated(x + s / 2, y + s / 2, deg, () => {
      const left = -s / 2;
      const top = -s / 2;
      box(left, top, s, s, '#fff', { dx: 10, dy: 10 });
      // mesa de trabajo detrás del recorte
      ctx.fillStyle = WASH;
      ctx.fillRect(left + 14, top + 14, s - 28, s - 28);
      ctx.strokeStyle = 'rgba(93,155,255,.18)';
      ctx.lineWidth = 1.5;
      for (let gx = left + 14; gx <= left + s - 14; gx += 30) { ctx.beginPath(); ctx.moveTo(gx, top + 14); ctx.lineTo(gx, top + s - 14); ctx.stroke(); }
      for (let gy = top + 14; gy <= top + s - 14; gy += 30) { ctx.beginPath(); ctx.moveTo(left + 14, gy); ctx.lineTo(left + s - 14, gy); ctx.stroke(); }
      if (entry.img) {
        const im = entry.img;
        const inner = s - 60;
        const k = Math.min(inner / im.naturalWidth, inner / im.naturalHeight);
        const w = im.naturalWidth * k;
        const h = im.naturalHeight * k;
        ctx.save();
        ctx.shadowColor = 'rgba(17,17,19,.18)';
        ctx.shadowBlur = 18;
        ctx.shadowOffsetY = 10;
        ctx.drawImage(im, -w / 2, -h / 2, w, h);
        ctx.restore();
      } else {
        setFont(600, Math.round(s * 0.085), GROTESK);
        ctx.fillStyle = INK;
        const ls = wrap(entry.item.title, s - 70, 4);
        let yy = -((ls.length - 1) * s * 0.1) / 2;
        for (const l of ls) { ctx.textAlign = 'center'; ctx.fillText(l, 0, yy); yy += s * 0.1; }
        ctx.textAlign = 'left';
      }
      if (entry.item.shop) tag(entry.item.shop.toUpperCase().slice(0, 22), left + 16, top + 16, { size: Math.max(16, Math.round(s * 0.034)), pad: 10 });
      if (entry.item.priceText) {
        const ps = Math.max(26, Math.round(s * 0.062));
        setFont(700, ps, GROTESK);
        spacing(-1);
        const pw = Math.ceil(ctx.measureText(entry.item.priceText).width) + 28;
        const ph = Math.round(ps * 1.55);
        const px = left + 16;
        const py = top + s - 16 - ph;
        ctx.fillStyle = LIME;
        ctx.fillRect(px + 6, py + 6, pw, ph);
        ctx.fillStyle = INK;
        ctx.fillRect(px, py, pw, ph);
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        ctx.fillText(entry.item.priceText, px + 14, py + ph / 2 + 1);
        ctx.textBaseline = 'alphabetic';
        spacing(0);
      }
      const d = dropOf(entry.item);
      if (d) {
        rotated(s / 2 - 70, s / 2 - 36, -8, () => tag(`↓ ${d.pct}%`, -50, -24, { fill: LIME, size: 24, pad: 12 }));
      }
    });
  };

  const entries = loaded.length ? loaded : noPicture.map((item) => ({ item, img: null }));
  if (!entries.length) {
    rotated(W / 2, y0 + 300, -2, () => {
      box(-330, -300, 660, 600, '#fff', { dx: 12, dy: 12 });
      setFont(400, 200, 'system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif');
      ctx.textAlign = 'center';
      ctx.fillStyle = INK;
      ctx.fillText(list.emoji || '✶', 0, 40);
      setFont(400, 40, SERIF, 'italic');
      ctx.fillText('empieza con algo que no quieras perder.', 0, 200);
      ctx.textAlign = 'left';
    });
  } else if (entries.length === 1) {
    card(entries[0], 190, y0, 640, -2);
  } else if (entries.length === 2) {
    card(entries[0], 96, y0, 560, -2.5);
    card(entries[1], 664, y0 + 300, 320, 4);
  } else {
    // una grande a la izquierda y dos pequeñas en columna, sin pisarse
    card(entries[0], 96, y0, 560, -2.5);
    card(entries[1], 664, y0 - 10, 320, 4);
    card(entries[2], 664, y0 + 350, 320, -3);
  }
  if (items.length > entries.length && entries.length) {
    rotated(240, y0 + 640, -4, () => tag(`+${items.length - entries.length} más`, -60, -26, { fill: LIME, size: 26, pad: 16 }));
  }

  /* resumen y QR (por encima de la franja que Instagram tapa con la respuesta) */
  const sy = 1500;
  box(96, sy, 640, 160, '#fff', { dx: 8, dy: 8, border: 3 });
  const cells = [
    [String(items.length), items.length === 1 ? 'pieza' : 'piezas'],
    [total.value ? money(total.value, total.currency) : '—', 'total'],
    drops ? [`↓ ${drops}`, drops === 1 ? 'bajada' : 'bajadas'] : [String(new Set(items.map((i) => i.shop).filter(Boolean)).size || 0), 'tiendas'],
  ];
  cells.forEach(([value, label], i) => {
    const cx = 96 + (640 / 3) * i + 640 / 6;
    if (i) { ctx.strokeStyle = '#e2e1e8'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(96 + (640 / 3) * i, sy + 18); ctx.lineTo(96 + (640 / 3) * i, sy + 142); ctx.stroke(); }
    ctx.textAlign = 'center';
    ctx.fillStyle = INK;
    let vs = 40;
    setFont(700, vs, GROTESK);
    spacing(-1.5);
    while (ctx.measureText(value).width > 190 && vs > 24) { vs -= 2; setFont(700, vs, GROTESK); }
    ctx.fillText(value, cx, sy + 84);
    spacing(2);
    setFont(700, 18, MONO);
    ctx.fillStyle = FAINT;
    ctx.fillText(label.toUpperCase(), cx, sy + 126);
    spacing(0);
    ctx.textAlign = 'left';
  });

  box(776, sy - 30, 208, 208, '#fff', { dx: 8, dy: 8 });
  try {
    await loadScript(CDN.qrcode);
    const q = document.createElement('canvas');
    await window.QRCode.toCanvas(q, url, { width: 344, margin: 0, color: { dark: INK, light: '#ffffff' } });
    ctx.drawImage(q, 796, sy - 10, 168, 168);
  } catch {
    // sin el generador (sin conexión): el enlace escrito debajo sigue valiendo
    setFont(700, 20, MONO);
    ctx.fillStyle = FAINT;
    ctx.textAlign = 'center';
    ctx.fillText('haul', 880, sy + 84);
    ctx.textAlign = 'left';
  }
  tag('escanéame', 984, sy - 76, { size: 18, pad: 10, align: 'right' });

  setFont(700, 22, MONO);
  spacing(1);
  ctx.fillStyle = FAINT;
  ctx.textAlign = 'center';
  ctx.fillText(url.replace(/^https?:\/\//, ''), W / 2, 1724);
  spacing(0);

  // cinta final, como la de la portada de la app
  ctx.fillStyle = LIME;
  ctx.fillRect(0, 1788, W, 56);
  ctx.fillStyle = INK;
  ctx.fillRect(0, 1786, W, 3);
  ctx.fillRect(0, 1842, W, 3);
  setFont(700, 22, MONO);
  spacing(4);
  ctx.fillStyle = INK;
  ctx.fillText('HAUL ✦ GUARDA ✦ ORGANIZA ✦ COMPARTE ✦ VIGILA ✦ TODO LO QUE QUIERES ✦', W / 2, 1824);
  spacing(0);
  ctx.textAlign = 'left';

  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se ha podido crear la imagen'))), 'image/png');
  });
}

async function shareCover() {
  const list = session.list;
  if (!list) return;
  publishIfNeeded(); // la portada lleva el enlace y el QR: tiene que poder abrirse
  try {
    const blob = coverCache.key === coverKey(list) && coverCache.blob ? coverCache.blob : await renderCover(list);
    const file = new File([blob], `haul-${list.slug}.png`, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: `${list.emoji} ${list.name}` });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    downloadBlob(blob, `haul-${list.slug}.png`);
    toast('Imagen guardada: súbela a tu historia ✦');
  } catch (err) {
    toast(err.message || 'No se ha podido crear la portada');
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
}

async function downloadCover() {
  const list = session.list;
  if (!list) return;
  try {
    const blob = coverCache.key === coverKey(list) && coverCache.blob ? coverCache.blob : await renderCover(list);
    downloadBlob(blob, `haul-${list.slug}.png`);
    toast('Imagen guardada ✦');
  } catch (err) { toast(err.message); }
}

function saveSharedList() {
  const list = session.list;
  store.data.saved = (store.data.saved || []).filter((s) => s.slug !== list.slug);
  store.data.saved.unshift({
    slug: list.slug, name: list.name, emoji: list.emoji, theme: list.theme,
    visibility: list.visibility, count: list.items.length,
    covers: list.items.slice(0, 4).map((i) => i.image).filter(Boolean),
    total: sumTotal(list.items).value,
  });
  store.save();
  renderList();
  toast('Guardada en tus hauls ✦');
}

/* ------------------------------------------------- captura desde el inicio */

/** Deja lista una lista donde guardar antes de abrir el formulario. */
async function ensureTargetList() {
  if (session.list && session.list.role === 'owner') return session.list;
  if (store.data.lists.length) {
    await openList(store.data.lists[0].slug, { push: false });
    return session.list;
  }
  openListForm('create');
  toast('Crea una lista y guardo lo que has pegado');
  return null;
}

async function quickSave({ photo = null } = {}) {
  const url = $('#homeUrlInput').value.trim();
  if (!url) { $('#homeUrlInput').focus(); return; }
  if (!(await ensureTargetList())) return;
  $('#homeUrlInput').value = '';
  openAdd(url, { photo });
}

async function quickShot() {
  if (!(await ensureTargetList())) return;
  openAdd();
  setTab('shot');
  $('#shotInput').click();
}

/* ------------------------------------------------- ordenar arrastrando */

/**
 * Con el ratón se arrastra directamente; con el dedo, tras mantener pulsado
 * (si el dedo se mueve antes, es scroll y se deja en paz). Mientras se
 * arrastra, una copia sigue al puntero y la tarjeta original se va colocando
 * en su sitio nuevo; al soltar, el orden se guarda en el servidor.
 */
const drag = { el: null, ghost: null, timer: null, active: false, armed: false, startX: 0, startY: 0, offX: 0, offY: 0, dropped: 0 };

function canReorder() {
  const list = session.list;
  return !!list && list.role === 'owner' && session.filter === 'all' && session.sort === 'manual' && list.items.length > 1;
}

function dragDown(e) {
  if (!canReorder() || drag.el) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const card = e.target.closest('.product[data-open-item]');
  if (!card) return;
  drag.el = card;
  drag.startX = e.clientX;
  drag.startY = e.clientY;
  drag.active = false;
  drag.armed = e.pointerType === 'mouse';
  if (!drag.armed) drag.timer = setTimeout(() => liftCard(drag.startX, drag.startY), 330);
  document.addEventListener('pointermove', dragMove, { passive: false });
  document.addEventListener('pointerup', dragUp);
  document.addEventListener('pointercancel', dragUp);
}

function liftCard(x, y) {
  const el = drag.el;
  if (!el) return;
  drag.timer = null;
  drag.active = true;
  const r = el.getBoundingClientRect();
  drag.offX = x - r.left;
  drag.offY = y - r.top;
  const ghost = el.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.style.width = r.width + 'px';
  ghost.style.height = r.height + 'px';
  ghost.style.left = r.left + 'px';
  ghost.style.top = r.top + 'px';
  document.body.appendChild(ghost);
  drag.ghost = ghost;
  el.classList.add('is-lifted');
  buzz(18);
}

function dragMove(e) {
  if (!drag.el) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 8) {
      if (drag.timer) return dragEnd(false); // el dedo se movió antes de tiempo: era scroll
      if (drag.armed) liftCard(e.clientX, e.clientY);
    }
    return;
  }
  e.preventDefault();
  drag.ghost.style.left = (e.clientX - drag.offX) + 'px';
  drag.ghost.style.top = (e.clientY - drag.offY) + 'px';
  const over = document.elementsFromPoint(e.clientX, e.clientY)
    .find((n) => n !== drag.el && n.classList && n.classList.contains('product') && n.dataset.openItem && !n.classList.contains('drag-ghost'));
  if (!over) return;
  const grid = drag.el.parentNode;
  const cards = [...grid.querySelectorAll('.product[data-open-item]')];
  const from = cards.indexOf(drag.el);
  const to = cards.indexOf(over);
  if (from < 0 || to < 0 || from === to) return;
  grid.insertBefore(drag.el, from < to ? over.nextSibling : over);
  buzz(6);
}

function dragUp() {
  if (!drag.el) return;
  dragEnd(drag.active);
}

function dragEnd(commit) {
  if (drag.timer) { clearTimeout(drag.timer); drag.timer = null; }
  document.removeEventListener('pointermove', dragMove);
  document.removeEventListener('pointerup', dragUp);
  document.removeEventListener('pointercancel', dragUp);
  const wasActive = drag.active;
  if (drag.ghost) drag.ghost.remove();
  if (drag.el) drag.el.classList.remove('is-lifted');
  drag.el = null;
  drag.ghost = null;
  drag.active = false;
  drag.armed = false;
  if (wasActive) {
    drag.dropped = Date.now(); // el clic de soltar no debe abrir la ficha
    if (commit) persistOrder();
  }
}

async function persistOrder() {
  const list = session.list;
  if (!list) return;
  const ids = [...$('#productGrid').querySelectorAll('.product[data-open-item]')].map((n) => n.dataset.openItem);
  if (ids.join() === list.items.map((i) => i.id).join()) return;
  const byId = new Map(list.items.map((i) => [i.id, i]));
  list.items = ids.map((id) => byId.get(id)).filter(Boolean).concat(list.items.filter((i) => !ids.includes(i.id)));
  renderList();
  try {
    await api(`/lists/${list.slug}/order`, { method: 'PUT', slug: list.slug, body: { ids } });
    toast('Orden guardado ✦');
  } catch (err) {
    toast(err.message);
    refreshList();
  }
}

function initReorder() {
  const grid = $('#productGrid');
  grid.addEventListener('pointerdown', dragDown);
  // mientras se arrastra con el dedo, la página no debe hacer scroll
  grid.addEventListener('touchmove', (e) => { if (drag.active) e.preventDefault(); }, { passive: false });
  grid.addEventListener('contextmenu', (e) => { if (canReorder()) e.preventDefault(); });
  grid.addEventListener('dragstart', (e) => e.preventDefault());
}

/* ------------------------------------------------------- avisos push */

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function pushOn() {
  return !!(store.data.push && store.data.push.endpoint) && typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

async function loadPushConfig() {
  if (session.pushConfig) return session.pushConfig;
  try { session.pushConfig = await api('/push/config'); }
  catch { session.pushConfig = { enabled: false, key: '' }; }
  return session.pushConfig;
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function renderPushRow() {
  const block = $('#pushBlock');
  if (!block) return;
  const cfg = await loadPushConfig();
  const state = $('#pushState');
  const btn = $('#btnPush');
  const test = $('#btnPushTest');
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  $('#pushCopy').classList.toggle('hidden', !cfg.enabled);
  test.classList.add('hidden');
  if (!cfg.enabled) {
    btn.classList.add('hidden');
    state.textContent = 'Las bajadas se ven en la app, con su sticker.';
    return;
  }
  if (!pushSupported()) {
    btn.classList.add('hidden');
    state.textContent = ios && !standalone
      ? 'En iPhone, añade Haul a la pantalla de inicio para poder recibir avisos.'
      : 'Este navegador no admite avisos.';
    return;
  }
  btn.classList.remove('hidden');
  const on = pushOn();
  btn.textContent = on ? 'Desactivar' : 'Activar avisos';
  state.textContent = on ? 'Activados en este dispositivo' : (Notification.permission === 'denied' ? 'Bloqueados en los ajustes del navegador' : 'Desactivados');
  btn.disabled = Notification.permission === 'denied';
  test.classList.toggle('hidden', !on);
}

function ownedLists() {
  return store.data.lists.filter((l) => l.ownerToken).map((l) => ({ slug: l.slug, token: l.ownerToken }));
}

async function enablePush() {
  const cfg = await loadPushConfig();
  if (!cfg.enabled || !pushSupported()) return;
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { renderPushRow(); return toast('Sin permiso no podemos avisarte'); }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(cfg.key) });
    await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), lists: ownedLists() } });
    store.data.push = { endpoint: sub.endpoint };
    store.save();
    renderPushRow();
    toast('Te avisaremos cuando baje un precio ✦');
  } catch (err) {
    toast(err.message || 'No se han podido activar los avisos');
  }
}

async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api('/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
  } catch { /* sin suscripción que quitar */ }
  store.data.push = { endpoint: '' };
  store.save();
  renderPushRow();
  toast('Avisos desactivados');
}

/** Tras crear o borrar una lista, el servidor tiene que saber cuáles vigilar para este móvil. */
async function syncPushLists() {
  if (!pushOn() || !pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), lists: ownedLists() } });
  } catch { /* se reintenta en el siguiente cambio */ }
}

async function testPush() {
  try {
    await api('/push/test', { method: 'POST', body: { endpoint: store.data.push.endpoint } });
    toast('Aviso enviado: debería llegar en unos segundos');
  } catch (err) { toast(err.message); }
}

/* -------------------------------------------------------------- eventos */

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action],[data-open-list],[data-open-item],[data-open-drops],[data-dup],[data-nav],[data-filter],[data-emoji],[data-theme-pick],[data-avatar],[data-tab],[data-visibility]');
  if (!el) return;

  if (el.dataset.openList) return openList(el.dataset.openList);
  if (el.dataset.openDrops) return openList(el.dataset.openDrops, { filter: 'drops' });
  if (el.dataset.openItem) {
    if (Date.now() - drag.dropped < 450) return; // acaba de soltar una pieza arrastrada
    return openItem(el.dataset.openItem);
  }
  if (el.dataset.dup) {
    const dup = session.dupItem;
    if (el.dataset.dup === 'open' && dup) {
      closeSheets();
      setTimeout(() => openItem(dup.id), 260);
    } else {
      session.forceDup = true;
      $('#addDup').classList.add('hidden');
      toast('Vale, se guardará como una pieza más');
    }
    return;
  }
  if (el.dataset.filter) { session.filter = el.dataset.filter; return renderList(); }
  if (el.dataset.tab) return setTab(el.dataset.tab);

  if (el.dataset.emoji) {
    $$('#emojiPicker button').forEach((b) => b.classList.remove('is-active'));
    el.classList.add('is-active'); return;
  }
  if (el.dataset.themePick) {
    $$('#themePicker button').forEach((b) => b.classList.remove('is-active'));
    el.classList.add('is-active'); return;
  }
  if (el.dataset.visibility) {
    $$('#visibilitySeg button').forEach((b) => b.classList.remove('is-active'));
    el.classList.add('is-active'); return;
  }
  if (el.dataset.avatar) {
    store.data.profile.avatar = el.dataset.avatar;
    store.save(); renderProfile(); buzz(); return;
  }
  if (el.dataset.nav) {
    const nav = el.dataset.nav;
    if (nav === 'add') return session.list ? openAdd() : (store.data.lists.length ? openList(store.data.lists[0].slug) : openListForm('create'));
    return goto(nav);
  }

  switch (el.dataset.action) {
    case 'start': store.data.seenWelcome = true; store.save(); goto('home'); openListForm('create'); break;
    case 'goto-home': goto('home'); break;
    case 'goto-profile': goto('profile'); break;
    case 'new-list': openListForm('create'); break;
    case 'edit-list': openListForm('edit'); break;
    case 'add-item': openAdd(); break;
    case 'share-list': openShare({ item: null }); break;
    case 'save-list': saveSharedList(); break;
    case 'close-sheets': closeSheets(); break;
    case 'install': promptInstall(); break;
    case 'mobile-help': openMobileHelp(); break;
  }
});

$('#btnSaveList').addEventListener('click', submitListForm);
$('#btnDeleteList').addEventListener('click', async () => {
  if (!confirm('¿Seguro que quieres eliminar esta lista y todos sus productos?')) return;
  const slug = session.list.slug;
  try {
    await api(`/lists/${slug}`, { method: 'DELETE', slug });
    store.removeList(slug);
    closeSheets();
    goto('home');
    toast('Lista eliminada');
    syncPushLists();
  } catch (err) { toast(err.message); }
});

$('#btnSort').addEventListener('click', cycleSort);
$('#btnRecheck').addEventListener('click', recheckItem);
$('#btnShareCover').addEventListener('click', shareCover);
$('#btnDownloadCover').addEventListener('click', downloadCover);
$('#btnPush').addEventListener('click', () => (pushOn() ? disablePush() : enablePush()));
$('#btnPushTest').addEventListener('click', testPush);
initReorder();

$('#btnHomeSave').addEventListener('click', () => quickSave());
$('#homeUrlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') quickSave(); });
$('#btnHomeShot').addEventListener('click', quickShot);
$('#btnHomePaste').addEventListener('click', async () => {
  try {
    const { text, file } = await readClipboard();
    if (!parseShared(text).url) return toast(text ? 'Lo copiado no trae ningún enlace' : 'No hay nada copiado');
    $('#homeUrlInput').value = text;
    quickSave({ photo: file });
  } catch { toast('Pega el enlace en el campo'); }
});

$('#btnReadUrl').addEventListener('click', readUrl);
$('#mobileTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-mtab]'); if (b) setMobileTab(b.dataset.mtab); });
$('#btnCopyHaulAddr').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(ADD_ADDRESS); toast('Dirección copiada ✦ pégala en el paso 5'); }
  catch { toast(ADD_ADDRESS); }
});
$('#urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') readUrl(); });
$('#btnPaste').addEventListener('click', async () => {
  try {
    const { text, file } = await readClipboard();
    if (!text) return toast('No hay nada copiado');
    $('#urlInput').value = text;
    session.sharedPhoto = file;
    readUrl();
  } catch { toast('Pega el enlace en el campo'); }
});
$('#btnManual').addEventListener('click', () => {
  showPreview({ title: '', priceText: '', shop: '', image: '', url: $('#urlInput').value.trim(), source: 'manual' });
});
$('#btnSaveItem').addEventListener('click', saveItem);
$('#btnScanToggle').addEventListener('click', () => (session.scanner ? stopScanner() : startScanner()));
$('#shotInput').addEventListener('change', (e) => handleShot(e.target.files[0]));
// Zalando y otras apps comparten el producto como imagen, no como enlace.
// En iPhone no se puede recibir ese "compartir" directamente, así que el
// camino corto es copiar la imagen y pegarla aquí.
$('#btnPasteImage').addEventListener('click', async () => {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      return handleShot(new File([blob], 'pegado.png', { type }));
    }
    toast('No hay ninguna imagen copiada');
  } catch {
    toast('Tu navegador no deja pegar aquí: usa “Elegir imagen”');
  }
});
$('#previewImg').addEventListener('click', () => $('#photoInput').click());
$('#photoInput').addEventListener('change', (e) => attachPhoto(e.target.files[0]));

['dragover', 'dragenter'].forEach((t) => $('#dropZone').addEventListener(t, (e) => {
  e.preventDefault(); $('#dropZone').classList.add('is-hot');
}));
['dragleave', 'drop'].forEach((t) => $('#dropZone').addEventListener(t, (e) => {
  e.preventDefault(); $('#dropZone').classList.remove('is-hot');
  if (t === 'drop') handleShot(e.dataTransfer?.files?.[0]);
}));

// Al copiar desde la app de una tienda (Zalando, por ejemplo) el portapapeles
// del móvil trae el texto con el enlace y, a la vez, la foto del producto. El
// enlace manda: la foto queda solo de respaldo. Se lee el texto del evento
// porque el campo, al pegar, pierde los saltos de línea.
document.addEventListener('paste', (e) => {
  const cd = e.clipboardData;
  if (!cd) return;
  const text = [cd.getData('text/plain'), cd.getData('text/uri-list')].filter(Boolean).join(' ');
  const file = [...(cd.files || [])].find((f) => f.type && f.type.startsWith('image/')) || null;
  const shared = parseShared(text);
  const addOpen = $('#sheet-add').classList.contains('is-open');
  const flat = text.replace(/\s+/g, ' ').trim();

  if (shared.url && e.target === $('#homeUrlInput')) {
    e.preventDefault();
    $('#homeUrlInput').value = flat;
    quickSave({ photo: file });
    return;
  }
  if (shared.url && addOpen) {
    e.preventDefault();
    setTab('link');
    session.sharedPhoto = file;
    $('#urlInput').value = flat;
    readUrl();
    return;
  }
  if (addOpen && !shared.url && guessFromShareText(text).title) {
    // texto de tienda sin enlace (y quizá su foto): se queda el nombre y se pide el enlace
    e.preventDefault();
    setTab('link');
    session.sharedPhoto = file;
    $('#urlInput').value = flat;
    readUrl();
    return;
  }
  if (file && addOpen) { setTab('shot'); handleShot(file); }
});

$('#btnToggleBought').addEventListener('click', toggleBought);
$('#btnDeleteItem').addEventListener('click', deleteItem);
$('#btnEditItem').addEventListener('click', editItem);
$('#btnShareItem').addEventListener('click', () => {
  const item = session.item;
  closeSheets();
  setTimeout(() => openShare({ item }), 240);
});
$('#btnCopyLink').addEventListener('click', copyLink);
$('#btnNativeShare').addEventListener('click', nativeShare);
$('#btnToggleContrib').addEventListener('click', toggleContrib);

$('#profileName').addEventListener('input', (e) => {
  store.data.profile.name = e.target.value.slice(0, 24);
  store.save();
});
$('#profileName').addEventListener('blur', renderProfile);

window.addEventListener('popstate', () => route({ push: false }));
// Si Haul ya estaba abierta, el Atajo solo cambia la almohadilla: no recarga.
window.addEventListener('hashchange', () => { if (/^#add=/.test(location.hash)) route({ push: false }); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  session.deferredInstall = e;
});
/** Guía para poner Haul en el menú Compartir del móvil; abre la pestaña del sistema que toque. */
function openMobileHelp() {
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  setMobileTab(ios ? 'ios' : 'android');
  openSheet('sheet-mobile');
}
function setMobileTab(tab) {
  $$('#mobileTabs button').forEach((b) => b.classList.toggle('is-active', b.dataset.mtab === tab));
  $('#mtab-ios').classList.toggle('hidden', tab !== 'ios');
  $('#mtab-android').classList.toggle('hidden', tab !== 'android');
}
/** Dirección que el Atajo de iPhone abre con el enlace del producto detrás. */
const ADD_ADDRESS = `${location.origin}/#add=`;

async function promptInstall() {
  if (!session.deferredInstall) {
    toast('En iPhone: Compartir → Añadir a pantalla de inicio');
    return;
  }
  session.deferredInstall.prompt();
  session.deferredInstall = null;
}

/* --------------------------------------------------------------- rutas */

/** Recoge lo que el service worker guardó al compartir desde otra app. */
async function consumeShared() {
  const out = { file: null, text: '' };
  try {
    const cache = await caches.open('haul-share');
    const image = await cache.match('/__shared-image');
    const text = await cache.match('/__shared-text');
    if (image) {
      const type = image.headers.get('content-type') || 'image/jpeg';
      out.file = new File([await image.blob()], 'compartido.jpg', { type });
    }
    if (text) out.text = await text.text();
    await cache.delete('/__shared-image');
    await cache.delete('/__shared-text');
  } catch { /* sin service worker no hay nada que recoger */ }
  return out;
}

async function route({ push = true } = {}) {
  const params = new URLSearchParams(location.search);

  // llegada desde "compartir con Haul": puede traer enlace, texto o imagen
  let incoming = params.has('compartido')
    ? await consumeShared()
    : { file: null, text: params.get('url') || params.get('text') || '' };
  // El Atajo de iPhone abre /#add=<enlace>: va tras la almohadilla para que
  // los parámetros del enlace de la tienda (?size=35&color=…) lleguen enteros.
  if (!incoming.text && /^#add=?/.test(location.hash)) {
    const text = safeDecode(location.hash.replace(/^#add=?/, ''));
    incoming = { file: null, text };
    if (!text.trim()) {
      history.replaceState({}, '', '/');
      toast('El Atajo ha llegado vacío: revisa el paso 5 (el chip "Entrada de atajo" tras la dirección)');
    }
  }
  // Lo que manda el Atajo se enseña aunque no traiga enlace: así se ve qué llegó.
  const fromShortcut = /^#add=?/.test(location.hash) && !!incoming.text.trim();
  const sharedUrl = ((incoming.text || '').match(/https?:\/\/[^\s]+/) || [])[0];

  const match = location.pathname.match(/^\/l\/([\w-]+)(?:\/p\/([\w-]+))?/);
  if (match) {
    session.collabToken = params.get('t') || '';
    await openList(match[1], { push: false });
    // enlace de una pieza suelta: se abre su tarjeta directamente
    if (match[2] && session.list) setTimeout(() => openItem(match[2]), 320);
  } else if (store.data.lists.length || store.data.seenWelcome) {
    goto('home', { push });
  } else {
    goto('welcome', { push });
  }

  if (sharedUrl || incoming.file || fromShortcut) {
    history.replaceState({}, '', '/');
    if (!session.list) {
      if (store.data.lists.length) await openList(store.data.lists[0].slug, { push: false });
      else {
        session.pendingShare = incoming;
        openListForm('create');
        toast('Crea una lista y te guardo lo que acabas de compartir');
        return;
      }
    }
    shareIntoList(incoming);
  }
}

/**
 * Mete en la lista abierta lo que llegó al compartir. Con enlace manda el
 * enlace: algunas apps (Zalando) mandan además una foto del producto, que
 * queda solo como respaldo si la ficha no trae. Sin enlace, la imagen es una
 * captura y se lee como tal.
 */
function shareIntoList(incoming) {
  const text = (incoming && incoming.text) || '';
  const file = (incoming && incoming.file) || null;
  if (/https?:\/\//i.test(text)) {
    openAdd(text, { photo: file });
  } else if (file) {
    openAdd('');
    setTab('shot');
    handleShot(file);
  } else if (text.trim()) {
    openAdd(text); // texto de tienda sin enlace: queda el nombre y se explica
  } else {
    openAdd();
  }
}

/* -------------------------------------------------------------- arranque */

function boot() {
  store.load();
  $('#marqueeTrack').innerHTML = new Array(2).fill(
    '<span>haul ✦ guarda ✦ organiza ✦ comparte ✦ escanea ✦ todo lo que quieres ✦</span>'
  ).join('');
  renderProfile();
  renderHome();
  route({ push: false });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    // al tocar un aviso de bajada con Haul ya abierta, el service worker pide abrir la pieza
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open' && e.data.url) {
        try { history.pushState({}, '', new URL(e.data.url).pathname); } catch { return; }
        closeSheets();
        route({ push: false });
      }
    });
    // Al activarse una versión nueva, la página se recarga una vez para no
    // seguir con el código antiguo hasta la siguiente visita.
    const hadController = !!navigator.serviceWorker.controller; // en la primera visita no hay nada que renovar
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      if (!$$('.sheet.is-open').length) location.reload();
    });
  }
}

boot();
void sleep;
