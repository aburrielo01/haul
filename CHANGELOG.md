# Cambios

## 4.0.0 · 24 de octubre de 2026

La primera versión que hace algo por ti después de guardar: vigila el precio de
cada pieza y te lo cuenta. Las cuatro cosas que el README de la 3.x dejaba como
"lo siguiente", hechas.

### Vigilancia de precios y avisos

- El servidor vuelve a leer cada pieza con enlace (y sin comprar) cada 12 horas,
  solo con los intentos gratuitos: nunca gasta créditos del desbloqueador ni
  abre Chromium. Si una tienda falla cuatro veces seguidas, se la mira seis
  veces menos.
- Cada pieza guarda el precio con el que entró, el anterior, el mínimo visto y
  una evolución de hasta 60 puntos. Un cambio de céntimos o de menos del 1 % no
  cuenta; una caída de más del 85 % se descarta como lectura rota.
- En la lista, una pieza que ha bajado lleva un sticker **↓ 14%** y el filtro
  **↓ Bajadas** las junta. En el inicio aparece un aviso con cuántas han bajado.
- En la ficha: ahora / antes / mínimo, una línea con la evolución, cuándo se
  comprobó y un botón **Comprobar ahora** (este sí usa todos los intentos, como
  al añadir la pieza).
- Avisos push opcionales (`VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY`): desde el
  perfil se activan en el móvil, y al tocar el aviso se abre la pieza. Sin claves
  la app funciona igual, solo con los stickers.
- Un precio corregido a mano pasa a ser la nueva referencia.

### Duplicados

- Al leer una ficha que ya está en la lista (mismo enlace, o la misma ficha con
  otra talla o color en los parámetros), la app lo dice antes de guardar, enseña
  la pieza que ya tienes y deja elegir: verla o guardar igualmente. El servidor
  lo vigila también (`409 DUPLICATE`), por si la lista cambió desde otro móvil.

### Ordenar arrastrando

- Con el ratón se arrastra; con el dedo, manteniendo pulsado. Al soltar, el
  orden se guarda (`PUT /api/lists/:slug/order`). Además, un botón cambia entre
  tu orden, precio ↓, precio ↑ y recientes.

### Portada para historias

- En Compartir, una imagen 9:16 dibujada en el móvil con el mismo lenguaje de
  la app: nombre de la lista, hasta tres piezas como recortes con su precio,
  total, bajadas y un QR que abre el enlace. Se comparte directamente a
  Instagram o WhatsApp, o se guarda como imagen.

### Banco de pruebas

- Hoja de verdad revisada ficha a ficha el 25 de octubre: 18 precios habían
  cambiado desde que se escribió (Decathlon 478 → 549, Fnac 1938,83 → 2417,12,
  rebajas que terminaron en Vans y Levi's…). Cada fila lleva ahora `verified`
  (fecha de la última comprobación) y, las de precio volátil, `tolerance`.
- Depop: el nombre sale del alt de la galería, no de la descripción cortada.
- Adaptadores nuevos: Snipes (precio rebajado del bloque de compra; su JSON-LD
  trae el normal), Temu (nombre, foto y precio desde `window.rawData`, que el
  desbloqueador sí ve) y Zara Home (nombre del h1; su JSON-LD a veces describe
  la categoría).
- El desbloqueador reconoce sus propias páginas de error ("This site can't be
  reached", "Proxy Error") y vuelve a intentar hasta tres veces; un dominio que
  Bright Data no permite (`policy_…`) no se reintenta. Shein tiene 150 s de
  margen en vez de 80.
- `fetch` reintenta una vez tras un 429 antes de gastar desbloqueador o Chromium.
- El informe cuenta qué hizo el desbloqueador en los fallos y avisa cuando no
  acierta ninguno (cuenta sin saldo o sin verificar). Estado y pendientes en
  `test/banco-estado.md`.

### Por dentro

- `lib/watch.js` (vigilancia) y `lib/push.js` (avisos), columnas nuevas en
  `items` (`base_price`, `prev_price`, `low_price`, `price_changed_at`,
  `checked_at`, `check_fails`) con migración automática en SQLite y Postgres, y
  tablas `price_history` y `push_subs`.
- `extractFromUrl(url, { cheap: true })` para lecturas sin coste.
- `/api/health` cuenta cómo va la vigilancia y si los avisos están activos.
- Pruebas nuevas: `node test/watch.js` y más casos en `npm test`.
- Dependencia nueva: `web-push`.

## 3.x · septiembre–octubre de 2026

Rediseño "scrapbook editorial", adaptadores por tienda, desbloqueador opcional
para tiendas con anti-bot, banco de 100 enlaces, compartir *con* Haul desde el
menú del móvil (Android) y Atajo para iPhone.
