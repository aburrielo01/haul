/* ==========================================================================
   HAUL · app
   PWA sin cuentas: las listas viven en el servidor y el móvil guarda solo las
   llaves (tokens) de las listas que ha creado.
   ========================================================================== */

const STORE_KEY = 'haul.v2';
const EMOJIS = ['🛍️', '👟', '👗', '💄', '🎧', '🛋️', '🎮', '📚', '🍿', '🎁', '✨', '🏷️'];
const AVATARS = ['😎', '🦋', '👽', '🐰', '🔥', '🫧', '🍒', '⭐️', '🎀', '🧊'];
const THEMES = ['pink', 'lime', 'cyan', 'violet', 'sun', 'tangerine'];

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
  data: { profile: { name: '', avatar: '😎' }, lists: [], saved: [], seenWelcome: false },
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
  scanner: null,
  deferredInstall: null,
};

/* ------------------------------------------------------------- pantallas */

function goto(screen, { push = true } = {}) {
  session.screen = screen;
  $$('.screen').forEach((s) => s.classList.toggle('is-active', s.id === 'screen-' + screen));
  const showNav = ['home', 'profile', 'list'].includes(screen);
  $('#nav').classList.toggle('is-visible', showNav);
  $$('#nav button').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === screen));
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
  $('#homeGreeting').textContent = name ? `HOLA, ${name.toUpperCase()}` : 'TUS HAULS';

  $('#homeStats').innerHTML = `
    <div class="stat"><b>${lists.length}</b><span>listas</span></div>
    <div class="stat"><b>${items}</b><span>productos</span></div>
    <div class="stat"><b>${total ? money(total) : '—'}</b><span>deseado</span></div>`;

  $('#homeEmpty').classList.toggle('hidden', lists.length > 0);
  $('#listStack').innerHTML = lists.map(listCard).join('');

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

  const total = sumTotal(list.items);
  $('#listTotal').textContent = total.value ? money(total.value, total.currency) : '—';

  const isOwner = list.role === 'owner';
  $('#btnEditList').classList.toggle('hidden', !isOwner);
  const canAdd = isOwner || list.allowContrib;
  $('#listFab').classList.toggle('hidden', !canAdd);

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

  const visible = list.items.filter((it) =>
    session.filter === 'all' ? true : session.filter === 'bought' ? it.bought : !it.bought
  );
  $('#listEmpty').classList.toggle('hidden', visible.length > 0);
  $('#productGrid').innerHTML = visible.map(productCard).join('');
  $$('#listFilters .pill').forEach((p) => p.classList.toggle('is-active', p.dataset.filter === session.filter));
}

function productCard(p) {
  const src = p.image ? imgSrc(p.image) : '';
  const sourceLabel = { scan: 'escaneado', shot: 'captura', manual: 'a mano' }[p.source];
  return `
    <article class="product${p.bought ? ' is-bought' : ''}" data-open-item="${esc(p.id)}">
      ${src
        ? `<img class="product__img" src="${esc(src)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
        : `<div class="product__img" style="display:grid;place-items:center;font-size:34px">🏷️</div>`}
      ${sourceLabel ? `<span class="badge-src">${sourceLabel}</span>` : ''}
      <span class="product__tick">${p.bought ? '✓' : '♡'}</span>
      <div class="product__body">
        <div class="product__title">${esc(p.title)}</div>
        <div class="product__price">${esc(p.priceText || '—')}</div>
        <div class="product__shop">${esc(p.shop || 'sin tienda')}</div>
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
}

/* --------------------------------------------------------- abrir lista */

async function openList(slug, { push = true } = {}) {
  try {
    const { list } = await api(`/lists/${encodeURIComponent(slug)}`, { slug });
    session.list = list;
    session.filter = 'all';
    if (list.role === 'owner') store.syncList(list);
    renderList();
    goto('list', { push });
  } catch (err) {
    if (err.status === 403) toast('Esa lista es privada 🔒');
    else if (err.status === 404) { store.removeList(slug); toast('Esa lista ya no existe'); goto('home'); }
    else toast(err.message);
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
      setTimeout(() => openAdd(), 420);
    }
    closeSheets();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------ añadir producto */

function openAdd(prefillUrl) {
  if (!session.list) { toast('Abre o crea una lista primero'); return; }
  resetAdd();
  openSheet('sheet-add');
  if (prefillUrl) {
    setTab('link');
    $('#urlInput').value = prefillUrl;
    readUrl();
  } else {
    setTab('link');
    tryClipboard();
  }
}

function resetAdd() {
  session.pending = null;
  session.editingItem = null;
  $('#addPreview').classList.add('hidden');
  $('#addError').classList.add('hidden');
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

async function tryClipboard() {
  try {
    if (!navigator.clipboard?.readText) return;
    const text = (await navigator.clipboard.readText()).trim();
    if (/^https?:\/\/\S+$/i.test(text) && text.length < 900) {
      $('#urlInput').value = text;
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
  const url = $('#urlInput').value.trim();
  if (!/^https?:\/\//i.test(url)) { showAddError('Necesito un enlace completo que empiece por https://'); return; }
  setLoading(true);
  $('#addPreview').classList.add('hidden');
  try {
    const data = await api('/extract', { method: 'POST', body: { url } });
    showPreview({ ...data, source: 'url', url: data.url || url });
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
      title: fb.title || '',
      url: fb.url || url,
      image: '',
      priceText: '',
      shop: fb.shop || hostOf(url),
      source: 'url',
    });
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
    showAddError(err.message);
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
  openSheet('sheet-item');
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

async function openShare() {
  const list = session.list;
  if (!list) return;
  const url = `${location.origin}/l/${list.slug}`;
  $('#shareSummary').textContent = `${list.items.length} producto${list.items.length === 1 ? '' : 's'} · ${list.name}`;
  $('#shareLink').textContent = url;
  $('#sharePrivateNote').classList.toggle('hidden', list.visibility === 'public');
  const btn = $('#btnToggleContrib');
  btn.textContent = list.allowContrib ? '●' : '○';
  btn.classList.toggle('iconbtn--accent', !!list.allowContrib);
  btn.setAttribute('aria-pressed', String(!!list.allowContrib));
  btn.parentElement.parentElement.classList.toggle('hidden', list.role !== 'owner');
  openSheet('sheet-share');

  const box = $('#shareQr');
  box.innerHTML = '';
  try {
    await loadScript(CDN.qrcode);
    const canvas = document.createElement('canvas');
    await window.QRCode.toCanvas(canvas, url, { width: 320, margin: 1, color: { dark: '#0d0b14', light: '#ffffff' } });
    box.appendChild(canvas);
  } catch {
    box.innerHTML = '<span class="small faint">QR no disponible sin conexión</span>';
  }
}

async function copyLink() {
  const text = $('#shareLink').textContent;
  try { await navigator.clipboard.writeText(text); toast('Enlace copiado ✦'); }
  catch { toast('Mantén pulsado el enlace para copiarlo'); }
}

async function nativeShare() {
  const list = session.list;
  const url = `${location.origin}/l/${list.slug}`;
  const data = { title: `${list.emoji} ${list.name}`, text: 'Mira lo que quiero comprarme 👀', url };
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

/* -------------------------------------------------------------- eventos */

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action],[data-open-list],[data-open-item],[data-nav],[data-filter],[data-emoji],[data-theme-pick],[data-avatar],[data-tab],[data-visibility]');
  if (!el) return;

  if (el.dataset.openList) return openList(el.dataset.openList);
  if (el.dataset.openItem) return openItem(el.dataset.openItem);
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
    case 'share-list': openShare(); break;
    case 'save-list': saveSharedList(); break;
    case 'close-sheets': closeSheets(); break;
    case 'install': promptInstall(); break;
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
  } catch (err) { toast(err.message); }
});

$('#btnReadUrl').addEventListener('click', readUrl);
$('#urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') readUrl(); });
$('#btnPaste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    $('#urlInput').value = text.trim();
    if (/^https?:\/\//i.test(text.trim())) readUrl();
  } catch { toast('Pega el enlace en el campo'); }
});
$('#btnManual').addEventListener('click', () => {
  showPreview({ title: '', priceText: '', shop: '', image: '', url: $('#urlInput').value.trim(), source: 'manual' });
});
$('#btnSaveItem').addEventListener('click', saveItem);
$('#btnScanToggle').addEventListener('click', () => (session.scanner ? stopScanner() : startScanner()));
$('#shotInput').addEventListener('change', (e) => handleShot(e.target.files[0]));
$('#previewImg').addEventListener('click', () => $('#photoInput').click());
$('#photoInput').addEventListener('change', (e) => attachPhoto(e.target.files[0]));

['dragover', 'dragenter'].forEach((t) => $('#dropZone').addEventListener(t, (e) => {
  e.preventDefault(); $('#dropZone').classList.add('is-hot');
}));
['dragleave', 'drop'].forEach((t) => $('#dropZone').addEventListener(t, (e) => {
  e.preventDefault(); $('#dropZone').classList.remove('is-hot');
  if (t === 'drop') handleShot(e.dataTransfer?.files?.[0]);
}));

document.addEventListener('paste', (e) => {
  if (!$('#sheet-add').classList.contains('is-open')) return;
  const file = [...(e.clipboardData?.files || [])][0];
  if (file) { setTab('shot'); handleShot(file); }
});

$('#btnToggleBought').addEventListener('click', toggleBought);
$('#btnDeleteItem').addEventListener('click', deleteItem);
$('#btnEditItem').addEventListener('click', editItem);
$('#btnCopyLink').addEventListener('click', copyLink);
$('#btnNativeShare').addEventListener('click', nativeShare);
$('#btnToggleContrib').addEventListener('click', toggleContrib);

$('#profileName').addEventListener('input', (e) => {
  store.data.profile.name = e.target.value.slice(0, 24);
  store.save();
});
$('#profileName').addEventListener('blur', renderProfile);

window.addEventListener('popstate', () => route({ push: false }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  session.deferredInstall = e;
});
async function promptInstall() {
  if (!session.deferredInstall) {
    toast('En iPhone: Compartir → Añadir a pantalla de inicio');
    return;
  }
  session.deferredInstall.prompt();
  session.deferredInstall = null;
}

/* --------------------------------------------------------------- rutas */

async function route({ push = true } = {}) {
  const params = new URLSearchParams(location.search);

  // llegada desde "compartir con Haul" (share target del sistema)
  const shared = params.get('url') || params.get('text') || '';
  const sharedUrl = (shared.match(/https?:\/\/[^\s]+/) || [])[0];

  const match = location.pathname.match(/^\/l\/([\w-]+)/);
  if (match) {
    session.collabToken = params.get('t') || '';
    await openList(match[1], { push: false });
  } else if (store.data.lists.length || store.data.seenWelcome) {
    goto('home', { push });
  } else {
    goto('welcome', { push });
  }

  if (sharedUrl) {
    history.replaceState({}, '', location.pathname);
    if (!session.list) {
      if (store.data.lists.length) await openList(store.data.lists[0].slug, { push: false });
      else { openListForm('create'); toast('Crea una lista para guardar el enlace'); return; }
    }
    openAdd(sharedUrl);
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
  }
}

boot();
void sleep;
