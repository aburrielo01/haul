# Haul

**Todo lo que quieres, en un sitio.** Guarda productos desde cualquier tienda pegando
un enlace, escaneando un código de barras o subiendo una captura. Organízalos en
listas y compártelas con un enlace que funciona en cualquier móvil, sin cuentas.

---

## Qué hace

| Entrada | Cómo funciona |
|---|---|
| **Enlace** | El servidor lee la ficha del producto (JSON-LD, Open Graph, microdatos). Si la tienda pinta el precio con JavaScript, reabre la página con Chromium. |
| **Código de barras / QR** | La cámara decodifica EAN, UPC y QR en el propio móvil. Un EAN se busca en Open Food Facts y UPCitemdb; un QR con URL pasa por el lector de enlaces. |
| **Captura** | Busca primero un código dentro de la imagen, luego hace OCR para sacar título, precio y cualquier URL. La propia captura queda como foto del producto. |

Además: listas con color e icono propios, marcar productos como comprados, total
acumulado, enlace público con tarjeta de previsualización para WhatsApp e Instagram,
listas colaborativas, instalación como app (PWA) y compartir desde otras apps
directamente a Haul.

## Cómo está montado

```
server.js              API REST, páginas y estáticos
lib/db.js              datos (SQLite o Postgres, misma API)
lib/extract.js         extracción de producto, precios, códigos de barras
public/index.html      todas las pantallas de la app
public/styles.css      sistema visual
public/app.js          lógica de la interfaz
public/sw.js           service worker (abre sin conexión)
test/smoke.js          ciclo completo de una lista vía API
test/parse.js          precios, EAN y limpieza de URLs
```

**Sin cuentas.** Al crear una lista el servidor devuelve un `ownerToken` que se guarda
solo en el móvil. Ese token es lo que permite editarla. El enlace público no lo lleva,
así que compartir una lista nunca da permisos de edición.

## Ponerlo en marcha

```bash
npm install
npx playwright install chromium   # solo en local; la imagen Docker ya lo trae
npm start                          # http://localhost:3000
npm test                           # pruebas de humo (con el servidor arrancado)
node test/parse.js                 # pruebas del parseador
```

## Desplegar en Render

1. Sube el repositorio a GitHub.
2. En Render, *New → Blueprint* y apunta a `render.yaml`. Usa el runtime **Docker**:
   la imagen ya trae Chromium y sus dependencias.
3. Elige dónde viven los datos:
   - **Disco persistente** (plan de pago): deja `DATA_DIR=/data` y SQLite se encarga.
   - **Postgres** (hay plan gratuito): crea la base de datos, descomenta el bloque
     `databases:` de `render.yaml` y la variable `DATABASE_URL`. El código detecta
     Postgres solo.

> Sin disco ni Postgres la app funciona, pero las listas se borran en cada despliegue.

### Variables de entorno

| Variable | Para qué | Por defecto |
|---|---|---|
| `PORT` | Puerto HTTP | `3000` |
| `DATA_DIR` | Carpeta de la base SQLite | `./data` |
| `DATABASE_URL` | Si existe, usa Postgres en vez de SQLite | — |
| `NAV_TIMEOUT` | Espera máxima de Chromium (ms) | `22000` |
| `FETCH_TIMEOUT` | Espera máxima de la lectura rápida (ms) | `9000` |
| `BROWSER_WS_ENDPOINT` | Chromium remoto (CDP) si el hosting no puede ejecutarlo | — |

## Decisiones que conviene conocer

- **Dos pasos al leer una tienda.** Primero un `fetch` normal, que resuelve la mayoría
  en menos de un segundo; Chromium solo entra cuando faltan datos. El resultado se
  cachea seis horas.
- **Nunca se saltan CAPTCHAs.** Si una tienda muestra un muro anti-bot, la app lo dice
  y deja rellenar el producto a mano con la vista previa ya abierta.
- **Proxy de imágenes.** Las fotos pasan por `/api/img` porque muchas tiendas bloquean
  el hotlinking; de paso no se filtra el `Referer` del usuario.
- **Protección SSRF.** Toda URL se valida contra IPs privadas y hosts locales antes de
  abrirla, también después de los redirects.
- **Límite de peticiones** por IP en los endpoints caros (20/min) y de escritura (90/min).

## Lo siguiente

- Alertas de bajada de precio (ya se guarda `price_value`, falta un cron y avisos push).
- Detección de duplicados al añadir el mismo producto dos veces.
- Reordenar productos arrastrando (el campo `position` ya existe).
- Portada generada de cada lista para compartir en historias.
