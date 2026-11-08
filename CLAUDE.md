# CLAUDE.md · HAUL

HAUL es una PWA de listas de deseos en español, sin cuentas: pegas un enlace de
tienda y saca nombre, precio y foto. Producto propio, distinto de Alfred.
En vivo: https://haul-o6sv.onrender.com (`/api/health` dice la versión).

## Cómo se trabaja aquí
- `npm run dev` arranca en local (puerto 3000; la config `haul-v4` de la app usa 3400).
- Antes de dar algo por terminado: `node test/adapters.js`, `node test/watch.js`
  y `BASE=http://127.0.0.1:3400 node test/smoke.js` con el servidor levantado.
- Para probar en el navegador usa `http://127.0.0.1:3400`, no `localhost`: el
  service worker cachea `app.js` y te enseña la versión anterior.
- Versión: `package.json` y `VERSION` en `public/sw.js` suben juntas; cada cambio
  va al `CHANGELOG.md`. Al cerrar una tarea, actualiza `PROGRESS.md`.

## Lo que no se toca
- El diseño «scrapbook editorial» (papel claro, rejilla, stickers lima, Space
  Grotesk / Playfair / Space Mono). No se restyla con el sistema de Alfred.
- Nombres de fichero dentro de `public/` solo con letras ASCII: la «ñ» de
  «Añadir a Haul.shortcut» llegó a Linux en otra forma Unicode y la ruta falló.
- El Atajo de iPhone no usa «Obtener URLs de la entrada» (devuelve vacío con lo
  que mandan Amazon y Zalando) ni convierte la entrada a URL (Atajos se para).
  Se regenera con `scripts/make-shortcut.py` y se firma con
  `shortcuts sign --mode anyone` en el Mac. `scripts/make-diagnostico.py` enseña
  qué entrega una app al menú Compartir.

## Cómo se despliega
- No hay git en el Mac. Alejandro sube los ficheros por la web de GitHub (menos
  de 100 por subida) desde `~/Desktop/haul-v4.0-para-github`, copia limpia sin
  `node_modules` ni `data`. Render redespliega solo (Docker, imagen de Playwright;
  el Dockerfile instala `make`/`g++` porque `better-sqlite3` puede compilarse).
- Comprobar que entró: `/api/health` responde con la versión nueva.

## Banco de pruebas y secretos
- 100 enlaces en `test/bench-urls.json`; objetivo ≥ 92 %; estado y causas en
  `test/banco-estado.md`. Se lanza en Render con `/api/bench/run?key=DIAG_TOKEN`.
- `DIAG_TOKEN`, claves VAPID y de Bright Data viven en el panel de Render o en
  `.env`. Nunca en el repo, en el chat ni en estos archivos.
