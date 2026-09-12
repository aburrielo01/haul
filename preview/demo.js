/* Preview navegable de Haul: la interfaz real con datos de ejemplo y sin servidor. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const buzz = (ms = 12) => { try { navigator.vibrate?.(ms); } catch {} };
const uid = () => Math.random().toString(36).slice(2, 9);
const money = (v, c = 'EUR') => Number.isFinite(v)
  ? new Intl.NumberFormat('es-ES', { style: 'currency', currency: c, minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }).format(v)
  : '';

const art = (a, b, emoji) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="420"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="420" height="420" fill="url(#g)"/><text x="50%" y="59%" font-size="190" text-anchor="middle">${emoji}</text></svg>`);

/* --------------------------------------------------------- datos demo */

const item = (title, price, shop, image, source = 'url', bought = false) => ({
  id: uid(), title, priceText: money(price), priceValue: price, currency: 'EUR',
  shop, image, source, bought, url: 'https://ejemplo.com/producto', note: '',
});

const state = {
  profile: { name: 'Ale', avatar: '🦋' },
  lists: [
    {
      slug: 'outfits-de-verano', name: 'Outfits de verano', emoji: '👗', theme: 'pink',
      visibility: 'public', allowContrib: true, role: 'owner', items: [
        item('Chaqueta vaquera oversize lavada a la piedra', 89.95, 'Zara', art('#ff2e93', '#7b4dff', '🧥')),
        item('Zapatillas retro running en malla', 119, 'Nike', art('#00e0ff', '#c6ff3d', '👟')),
        item('Gafas de sol ovaladas montura fina', 34.99, 'Bershka', art('#ffd400', '#ff6b2c', '🕶️')),
        item('Bolso baguette de piel sintética', 59.9, 'Mango', art('#c6ff3d', '#00e0ff', '👜')),
        item('Camiseta cropped de canalé', 15.95, 'Pull&Bear', art('#7b4dff', '#ff2e93', '👕')),
        item('Sandalias de tiras con plataforma', 45.99, 'Stradivarius', art('#ff6b2c', '#ffd400', '👡'), 'shot', true),
      ],
    },
    {
      slug: 'setup-del-cuarto', name: 'Setup del cuarto', emoji: '🛋️', theme: 'cyan',
      visibility: 'private', allowContrib: false, role: 'owner', items: [
        item('Lámpara de arco con base de mármol', 129, 'Ikea', art('#ffd400', '#ff2e93', '💡'), 'scan'),
        item('Alfombra tejida a mano 160×230', 89, 'Maisons du Monde', art('#c6ff3d', '#7b4dff', '🧶')),
        item('Auriculares con cancelación de ruido', 199, 'Sony', art('#0d0b14', '#7b4dff', '🎧')),
      ],
    },
    {
      slug: 'regalos-navidad', name: 'Regalos de navidad', emoji: '🎁', theme: 'lime',
      visibility: 'public', allowContrib: true, role: 'owner', items: [
        item('Cámara instantánea con flash', 79.99, 'Fujifilm', art('#00e0ff', '#ffd400', '📸')),
        item('Perfume floral 50 ml', 64.5, 'Sephora', art('#ff2e93', '#ffd400', '🧴')),
      ],
    },
  ],
  saved: [],
};

/* catálogo falso para que "leer producto" enseñe cómo funciona de verdad */
const DEMO_CATALOG = [
  { match: /zara/i, title: 'Vestido midi satinado con abertura', price: 49.95, shop: 'Zara', image: art('#ff2e93', '#ffd400', '👗') },
  { match: /nike|adidas|sneak/i, title: 'Zapatillas de running con cámara de aire', price: 139.99, shop: 'Nike', image: art('#00e0ff', '#c6ff3d', '👟') },
  { match: /apple|iphone|airpods/i, title: 'Auriculares inalámbricos con estuche', price: 279, shop: 'Apple', image: art('#0d0b14', '#00e0ff', '🎧') },
  { match: /ikea|muebl/i, title: 'Estantería modular de roble', price: 99, shop: 'Ikea', image: art('#ffd400', '#ff6b2c', '🪵') },
  { match: /sephora|perfum|makeup/i, title: 'Sérum iluminador con vitamina C', price: 38.9, shop: 'Sephora', image: art('#ff2e93', '#7b4dff', '🧴') },
];

let session = { screen: 'welcome', list: null, filter: 'all', item: null, pending: null, editing: null, mode: 'create' };

/* ------------------------------------------------------------ pantallas */

function goto(screen) {
  session.screen = screen;
  $$('.screen').forEach((s) => s.classList.toggle('is-active', s.id === 'screen-' + screen));
  const nav = ['home', 'profile', 'list'].includes(screen);
  $('#nav').classList.toggle('is-visible', nav);
  $$('#nav button').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === screen));
  $('.screen.is-active')?.scrollTo({ top: 0 });
  if (screen === 'home') renderHome();
  if (screen === 'profile') renderProfile();
}

function openSheet(id) { $('#scrim').classList.add('is-open'); $('#' + id).classList.add('is-open'); buzz(); }
function closeSheets() { $('#scrim').classList.remove('is-open'); $$('.sheet').forEach((s) => s.classList.remove('is-open')); }

let toastTimer;
function toast(text, action) {
  clearTimeout(toastTimer);
  $('#toastText').textContent = text;
  const btn = $('#toastAction');
  btn.classList.toggle('hidden', !action);
  if (action) { btn.textContent = action.label; btn.onclick = () => { $('#toast').classList.remove('is-open'); action.run(); }; }
  $('#toast').classList.add('is-open');
  toastTimer = setTimeout(() => $('#toast').classList.remove('is-open'), action ? 5200 : 2600);
}

const sumTotal = (items) => items.reduce((n, i) => n + (!i.bought && Number.isFinite(i.priceValue) ? i.priceValue : 0), 0);

/* --------------------------------------------------------------- home */

function renderHome() {
  const lists = state.lists;
  const count = lists.reduce((n, l) => n + l.items.length, 0);
  const total = lists.reduce((n, l) => n + sumTotal(l.items), 0);
  $('#homeGreeting').textContent = state.profile.name ? `HOLA, ${state.profile.name.toUpperCase()}` : 'TUS HAULS';
  $('#homeStats').innerHTML = `
    <div class="stat"><b>${lists.length}</b><span>listas</span></div>
    <div class="stat"><b>${count}</b><span>productos</span></div>
    <div class="stat"><b>${money(total)}</b><span>deseado</span></div>`;
  $('#homeEmpty').classList.toggle('hidden', lists.length > 0);
  $('#listStack').innerHTML = lists.map(listCard).join('');
}

function listCard(l) {
  const covers = l.items.slice(0, 4).map((i) => i.image).filter(Boolean);
  const cover = covers.length >= 2
    ? covers.map((c) => `<img src="${esc(c)}" alt="">`).join('')
    : covers.length === 1 ? `<img src="${esc(covers[0])}" alt="">` : `<span>${esc(l.emoji)}</span>`;
  const total = sumTotal(l.items);
  return `<button class="listcard${covers.length >= 2 ? '' : ''}" data-open-list="${l.slug}" data-theme="${l.theme}">
    <span class="listcard__cover${covers.length < 2 ? ' listcard__cover--solo' : ''}">${cover}</span>
    <span class="grow">
      <span class="title" style="display:block">${esc(l.emoji)} ${esc(l.name)}</span>
      <span class="kicker muted" style="display:block;margin-top:5px">${l.items.length} ítem${l.items.length === 1 ? '' : 's'} · ${total ? money(total) : (l.visibility === 'public' ? 'con enlace' : 'solo yo')}</span>
    </span>
    <span class="faint" style="font-size:22px">›</span>
  </button>`;
}

/* --------------------------------------------------------------- lista */

function openList(slug) {
  session.list = state.lists.find((l) => l.slug === slug);
  session.filter = 'all';
  renderList();
  goto('list');
}

function renderList() {
  const l = session.list;
  if (!l) return;
  $('#screen-list').dataset.theme = l.theme;
  $('#listEmoji').textContent = l.emoji;
  $('#listName').textContent = l.name;
  $('#listVisibility').textContent = l.visibility === 'public' ? '🌍 con enlace' : '🔒 solo yo';
  $('#listCount').textContent = l.items.length;
  const total = sumTotal(l.items);
  $('#listTotal').textContent = total ? money(total) : '—';
  $('#listBanner').innerHTML = '';
  const visible = l.items.filter((i) => session.filter === 'all' ? true : session.filter === 'bought' ? i.bought : !i.bought);
  $('#listEmpty').classList.toggle('hidden', visible.length > 0);
  $('#productGrid').innerHTML = visible.map(productCard).join('');
  $$('#listFilters .pill').forEach((p) => p.classList.toggle('is-active', p.dataset.filter === session.filter));
}

function productCard(p) {
  const label = { scan: 'escaneado', shot: 'captura', manual: 'a mano' }[p.source];
  return `<article class="product${p.bought ? ' is-bought' : ''}" data-open-item="${p.id}">
    ${p.image ? `<img class="product__img" src="${esc(p.image)}" alt="" loading="lazy">`
      : '<div class="product__img" style="display:grid;place-items:center;font-size:34px">🏷️</div>'}
    ${label ? `<span class="badge-src">${label}</span>` : ''}
    <span class="product__tick">${p.bought ? '✓' : '♡'}</span>
    <div class="product__body">
      <div class="product__title">${esc(p.title)}</div>
      <div class="product__price">${esc(p.priceText || '—')}</div>
      <div class="product__shop">${esc(p.shop || 'sin tienda')}</div>
    </div>
  </article>`;
}

function renderProfile() {
  const p = state.profile;
  $('#profileAvatar').textContent = p.avatar;
  $('#profileTitle').textContent = p.name ? `Hola, ${p.name}` : 'Tu perfil';
  $('#profileName').value = p.name;
  $('#avatarPicker').innerHTML = ['😎', '🦋', '👽', '🐰', '🔥', '🫧', '🍒', '⭐️', '🎀', '🧊']
    .map((a) => `<button data-avatar="${a}" class="${a === p.avatar ? 'is-active' : ''}">${a}</button>`).join('');
  const count = state.lists.reduce((n, l) => n + l.items.length, 0);
  const bought = state.lists.reduce((n, l) => n + l.items.filter((i) => i.bought).length, 0);
  $('#profileStats').innerHTML = `
    <div class="stat"><b>${state.lists.length}</b><span>listas</span></div>
    <div class="stat"><b>${count}</b><span>guardados</span></div>
    <div class="stat"><b>${bought}</b><span>comprados</span></div>`;
}

/* ------------------------------------------------------ crear / editar */

const EMOJIS = ['🛍️', '👟', '👗', '💄', '🎧', '🛋️', '🎮', '📚', '🍿', '🎁', '✨', '🏷️'];
const THEMES = ['pink', 'lime', 'cyan', 'violet', 'sun', 'tangerine'];

function openListForm(mode) {
  session.mode = mode;
  const l = mode === 'edit' ? session.list : null;
  $('#listFormTitle').textContent = mode === 'edit' ? 'Editar lista' : 'Nueva lista';
  $('#btnSaveList').textContent = mode === 'edit' ? 'Guardar cambios' : 'Crear lista';
  $('#btnDeleteList').classList.toggle('hidden', mode !== 'edit');
  $('#formListName').value = l?.name || '';
  const emoji = l?.emoji || EMOJIS[0];
  const theme = l?.theme || 'pink';
  $('#emojiPicker').innerHTML = EMOJIS.map((e) => `<button data-emoji="${e}" class="${e === emoji ? 'is-active' : ''}">${e}</button>`).join('');
  $('#themePicker').innerHTML = THEMES.map((t) => `<button class="swatch ${t === theme ? 'is-active' : ''}" data-theme-pick="${t}" data-theme="${t}" style="background:var(--accent)"></button>`).join('');
  $$('#visibilitySeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.visibility === (l?.visibility || 'private')));
  openSheet('sheet-list-form');
}

function submitListForm() {
  const data = {
    name: $('#formListName').value.trim() || 'Mi haul',
    emoji: $('#emojiPicker .is-active')?.dataset.emoji || EMOJIS[0],
    theme: $('#themePicker .is-active')?.dataset.themePick || 'pink',
    visibility: $('#visibilitySeg .is-active')?.dataset.visibility || 'private',
  };
  if (session.mode === 'edit') {
    Object.assign(session.list, data);
    renderList();
    toast('Lista actualizada ✦');
  } else {
    const list = { ...data, slug: 'lista-' + uid(), allowContrib: false, role: 'owner', items: [] };
    state.lists.unshift(list);
    session.list = list;
    renderList();
    goto('list');
    toast('Lista creada ✦');
  }
  closeSheets();
}

/* ------------------------------------------------------------- añadir */

function openAdd() {
  if (!session.list) return toast('Abre una lista primero');
  session.pending = null;
  session.editing = null;
  $('#addPreview').classList.add('hidden');
  $('#addError').classList.add('hidden');
  $('#addLoader').classList.add('hidden');
  $('#urlInput').value = '';
  $('#addTitle').textContent = 'Añadir';
  $('#btnSaveItem').textContent = 'Guardar en la lista';
  setTab('link');
  openSheet('sheet-add');
}

function setTab(tab) {
  $$('#addTabs button').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
  ['link', 'scan', 'shot'].forEach((t) => $('#tab-' + t).classList.toggle('hidden', t !== tab));
}

function setLoading(on, text) {
  $('#addLoaderText').textContent = text || 'Leyendo la tienda…';
  $('#addLoader').classList.toggle('hidden', !on);
  if (on) $('#addError').classList.add('hidden');
}

function showPreview(d) {
  session.pending = d;
  $('#previewImg').src = d.image || art('#eee7fb', '#f6f1ff', '🏷️');
  $('#previewTitle').value = d.title || '';
  $('#previewPrice').value = d.priceText || '';
  $('#previewShop').value = d.shop || '';
  $('#previewNote').value = d.note || '';
  $('#addPreview').classList.remove('hidden');
  $('#addPreview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  buzz(18);
}

async function readUrl() {
  const url = $('#urlInput').value.trim();
  if (!/^https?:\/\//i.test(url)) {
    $('#addError').innerHTML = 'Necesito un enlace completo que empiece por https://';
    $('#addError').classList.remove('hidden');
    return;
  }
  setLoading(true);
  await new Promise((r) => setTimeout(r, 900));
  setLoading(false);
  const hit = DEMO_CATALOG.find((c) => c.match.test(url)) || DEMO_CATALOG[0];
  showPreview({ ...hit, priceText: money(hit.price), priceValue: hit.price, currency: 'EUR', url, source: 'url' });
  toast('Producto leído ✦');
}

async function fakeScan() {
  setLoading(true, 'Buscando el código…');
  await new Promise((r) => setTimeout(r, 1100));
  setLoading(false);
  buzz([18, 40, 18]);
  showPreview({
    title: 'Crema hidratante facial 50 ml', priceText: money(24.9), priceValue: 24.9,
    currency: 'EUR', shop: 'CeraVe', image: art('#00e0ff', '#c6ff3d', '🧴'),
    source: 'scan', note: 'EAN 3337875597180',
  });
  toast('Código encontrado ✦');
}

function downscale(file, max = 620) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.75));
      };
      img.onerror = reject; img.src = fr.result;
    };
    fr.onerror = reject; fr.readAsDataURL(file);
  });
}

async function handleShot(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const bar = $('#shotProgress');
  bar.classList.remove('hidden');
  bar.querySelector('span').style.width = '40%';
  setLoading(true, 'Leyendo la captura…');
  const dataUrl = await downscale(file).catch(() => '');
  bar.querySelector('span').style.width = '100%';
  await new Promise((r) => setTimeout(r, 700));
  bar.classList.add('hidden');
  setLoading(false);
  showPreview({ title: '', priceText: '', shop: '', image: dataUrl, source: 'shot' });
  toast('En la app real también saca el texto y el precio');
}

function saveItem() {
  const l = session.list;
  const price = parseFloat(String($('#previewPrice').value).replace(/[^\d,.-]/g, '').replace(',', '.'));
  const data = {
    title: $('#previewTitle').value.trim() || 'Producto',
    priceText: Number.isFinite(price) ? money(price) : $('#previewPrice').value.trim(),
    priceValue: Number.isFinite(price) ? price : null,
    currency: 'EUR',
    shop: $('#previewShop').value.trim(),
    note: $('#previewNote').value.trim(),
    image: session.pending?.image || '',
    url: session.pending?.url || '',
    source: session.pending?.source || 'manual',
    bought: false,
  };
  if (session.editing) {
    Object.assign(l.items.find((i) => i.id === session.editing), data);
    toast('Producto actualizado');
  } else {
    l.items.unshift({ id: uid(), ...data });
    toast('Guardado ✦');
  }
  closeSheets();
  renderList();
}

/* ----------------------------------------------------- detalle producto */

function openItem(id) {
  const it = session.list.items.find((i) => i.id === id);
  if (!it) return;
  session.item = it;
  $('#itemImg').src = it.image || art('#eee7fb', '#f6f1ff', '🏷️');
  $('#itemTitle').textContent = it.title;
  $('#itemPrice').textContent = it.priceText || 'sin precio';
  $('#itemShop').textContent = it.shop || 'sin tienda';
  $('#itemNote').textContent = it.note || '';
  $('#itemNote').classList.toggle('hidden', !it.note);
  $('#itemLink').href = it.url || '#';
  $('#btnToggleBought').textContent = it.bought ? '↺ Aún no' : '✓ Comprado';
  openSheet('sheet-item');
}

function toggleBought() {
  session.item.bought = !session.item.bought;
  closeSheets(); renderList();
  toast(session.item.bought ? '¡Comprado! ✓' : 'De vuelta a la lista');
}

function deleteItem() {
  const l = session.list;
  const it = session.item;
  const idx = l.items.indexOf(it);
  l.items.splice(idx, 1);
  closeSheets(); renderList();
  toast('Producto eliminado', { label: 'Deshacer', run: () => { l.items.splice(idx, 0, it); renderList(); } });
}

function editItem() {
  const it = session.item;
  closeSheets();
  setTimeout(() => {
    openAdd();
    session.editing = it.id;
    $('#addTitle').textContent = 'Editar producto';
    $('#btnSaveItem').textContent = 'Guardar cambios';
    showPreview(it);
  }, 240);
}

/* ---------------------------------------------------------- compartir */

function openShare() {
  const l = session.list;
  const url = `https://haul.app/l/${l.slug}`;
  $('#shareSummary').textContent = `${l.items.length} producto${l.items.length === 1 ? '' : 's'} · ${l.name}`;
  $('#shareLink').textContent = url;
  $('#sharePrivateNote').classList.toggle('hidden', l.visibility === 'public');
  const btn = $('#btnToggleContrib');
  btn.textContent = l.allowContrib ? '●' : '○';
  btn.classList.toggle('iconbtn--accent', !!l.allowContrib);
  openSheet('sheet-share');
  const box = $('#shareQr');
  box.innerHTML = '';
  try {
    new window.QRCode(box, { text: url, width: 300, height: 300, colorDark: '#0d0b14', colorLight: '#ffffff' });
  } catch { box.innerHTML = '<span class="small faint">QR no disponible</span>'; }
}

/* ------------------------------------------------------------ eventos */

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action],[data-open-list],[data-open-item],[data-nav],[data-filter],[data-emoji],[data-theme-pick],[data-avatar],[data-tab],[data-visibility]');
  if (!el) return;
  if (el.dataset.openList) return openList(el.dataset.openList);
  if (el.dataset.openItem) return openItem(el.dataset.openItem);
  if (el.dataset.filter) { session.filter = el.dataset.filter; return renderList(); }
  if (el.dataset.tab) return setTab(el.dataset.tab);
  if (el.dataset.emoji) { $$('#emojiPicker button').forEach((b) => b.classList.remove('is-active')); return el.classList.add('is-active'); }
  if (el.dataset.themePick) { $$('#themePicker button').forEach((b) => b.classList.remove('is-active')); return el.classList.add('is-active'); }
  if (el.dataset.visibility) { $$('#visibilitySeg button').forEach((b) => b.classList.remove('is-active')); return el.classList.add('is-active'); }
  if (el.dataset.avatar) { state.profile.avatar = el.dataset.avatar; renderProfile(); return buzz(); }
  if (el.dataset.nav) {
    if (el.dataset.nav === 'add') return session.list ? openAdd() : openList(state.lists[0].slug);
    return goto(el.dataset.nav);
  }
  switch (el.dataset.action) {
    case 'start': case 'goto-home': goto('home'); break;
    case 'goto-profile': goto('profile'); break;
    case 'new-list': openListForm('create'); break;
    case 'edit-list': openListForm('edit'); break;
    case 'add-item': openAdd(); break;
    case 'share-list': openShare(); break;
    case 'close-sheets': closeSheets(); break;
    case 'install': toast('En la app real se instala en la pantalla de inicio'); break;
  }
});

$('#btnSaveList').addEventListener('click', submitListForm);
$('#btnDeleteList').addEventListener('click', () => {
  state.lists = state.lists.filter((l) => l !== session.list);
  closeSheets(); goto('home'); toast('Lista eliminada');
});
$('#btnReadUrl').addEventListener('click', readUrl);
$('#urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') readUrl(); });
$('#btnPaste').addEventListener('click', () => {
  $('#urlInput').value = 'https://www.zara.com/es/vestido-midi-satinado';
  toast('Enlace de ejemplo pegado');
});
$('#btnManual').addEventListener('click', () => showPreview({ title: '', priceText: '', shop: '', image: '', source: 'manual' }));
$('#btnSaveItem').addEventListener('click', saveItem);
$('#btnScanToggle').addEventListener('click', fakeScan);
$('#shotInput').addEventListener('change', (e) => handleShot(e.target.files[0]));
$('#btnToggleBought').addEventListener('click', toggleBought);
$('#btnDeleteItem').addEventListener('click', deleteItem);
$('#btnEditItem').addEventListener('click', editItem);
$('#btnCopyLink').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#shareLink').textContent); toast('Enlace copiado ✦'); }
  catch { toast('Copia el enlace a mano'); }
});
$('#btnNativeShare').addEventListener('click', async () => {
  const l = session.list;
  const data = { title: `${l.emoji} ${l.name}`, text: 'Mira lo que quiero comprarme 👀', url: `https://haul.app/l/${l.slug}` };
  if (navigator.share) { try { await navigator.share(data); } catch {} } else toast('Aquí se abriría el menú de compartir del móvil');
});
$('#btnToggleContrib').addEventListener('click', () => {
  session.list.allowContrib = !session.list.allowContrib;
  session.list.visibility = 'public';
  renderList(); openShare();
  toast(session.list.allowContrib ? 'Ahora pueden añadir productos' : 'Solo tú puedes añadir');
});
$('#profileName').addEventListener('input', (e) => { state.profile.name = e.target.value.slice(0, 24); });
$('#profileName').addEventListener('blur', renderProfile);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });
document.addEventListener('paste', (e) => {
  if (!$('#sheet-add').classList.contains('is-open')) return;
  const f = [...(e.clipboardData?.files || [])][0];
  if (f) { setTab('shot'); handleShot(f); }
});

/* ------------------------------------------------------------ arranque */

$('#marqueeTrack').innerHTML = new Array(2).fill(
  '<span>haul ✦ guarda ✦ organiza ✦ comparte ✦ escanea ✦ todo lo que quieres ✦</span>').join('');
$('#homeStats').insertAdjacentHTML('afterend',
  '<div class="banner" style="margin-top:14px"><span style="font-size:19px">✦</span><span class="grow">Vista previa navegable · los productos son de ejemplo</span></div>');
$('#scanIntro').insertAdjacentHTML('beforeend',
  '<p class="small faint" style="margin-top:10px">En esta vista previa el botón simula una lectura; en la app abre la cámara de verdad.</p>');
renderProfile();
renderHome();
goto('welcome');
