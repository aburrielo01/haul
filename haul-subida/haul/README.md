# Haul

**Todo lo que quieres, en un sitio.** Guarda productos desde cualquier tienda pegando
un enlace, escaneando un código de barras o subiendo una captura. Organízalos en
listas y compártelas con un enlace que funciona en cualquier móvil, sin cuentas.

---

## Qué hace

| Entrada | Cómo funciona |
|---|---|
| **Enlace** | Intentos en cascada: API de Shopify si la tienda lo es, lectura del HTML (JSON-LD, Open Graph, microdatos), reintento con navegador móvil, Chromium y, para tiendas con anti-bot, Bright Data Web Unlocker (opcional). |
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
test/parse.js          precios, EAN, nombres desde la URL
test/unlocker.js       desbloqueador, contra un servidor falso
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
node test/unlocker.js              # desbloqueador, contra un servidor falso
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
| `NAV_TIMEOUT` | Espera máxima de Chromium (ms) | `18000` |
| `FETCH_TIMEOUT` | Espera máxima de la lectura rápida (ms) | `8000` |
| `BROWSER_WS_ENDPOINT` | Chromium remoto (CDP) si el hosting no puede ejecutarlo | — |
| `BRIGHTDATA_API_KEY` | Clave de Bright Data para tiendas con anti-bot | — |
| `BRIGHTDATA_UNLOCKER_ZONE` | Nombre de la zona Web Unlocker | — |
| `UNLOCKER_COUNTRY` | País desde el que se leen las tiendas | `es` |
| `UNLOCKER_DAILY_LIMIT` | Tope diario de peticiones de pago | `150` |

## Tiendas con protección anti-bot

La mayoría de tiendas funcionan con los intentos gratuitos. Las grandes cadenas
—Zara, Vans, Fanatics/NFL Shop, Shein— usan protección anti-bot empresarial
(Akamai y similares) que bloquea cualquier petición desde un servidor en la nube.

Para esas, Haul puede usar **Bright Data Web Unlocker**, que lee la página desde
IPs residenciales. Está desactivado por defecto y se enciende con dos variables:

1. Crea una cuenta en [brightdata.com](https://brightdata.com) (el plan gratuito
   incluye 5.000 peticiones al mes, sin tarjeta).
2. En el panel: *Proxies & Scraping → Add → Web Unlocker API*. Ponle de nombre
   `haul_unlocker`.
3. Copia tu API key en *Account settings → API keys*.
4. En Render → tu servicio → *Environment*, añade `BRIGHTDATA_API_KEY` y
   `BRIGHTDATA_UNLOCKER_ZONE=haul_unlocker`. Render redespliega solo.
5. Comprueba que está activo abriendo `/api/health`: debe decir `"unlocker": true`.

Solo se usa cuando fallan los intentos gratuitos, solo cobra si acierta
(1,5 $ cada 1.000 después de las gratuitas) y lleva un tope diario
(`UNLOCKER_DAILY_LIMIT`, 150 por defecto) para que la factura nunca se dispare.

A tener en cuenta: leer estas webs saltando su protección va contra sus
condiciones de uso. Es práctica habitual en apps de listas de deseos y
comparadores, pero es una decisión de negocio, no técnica.

Si no se activa, fallar sigue costando diez segundos: el nombre y la tienda
salen del propio enlace y la app ofrece completar el producto con una captura.

## Decisiones que conviene conocer

- **Del intento más barato al más caro.** Shopify y la lectura normal resuelven la
  mayoría en menos de un segundo; Chromium y el desbloqueador solo entran cuando
  faltan datos. Si la tienda ya ha enseñado un muro anti-bot, se salta Chromium y se
  va directo al desbloqueador. El resultado se cachea seis horas.
- **Los errores técnicos se quedan en los logs.** Al usuario solo le llega un mensaje
  claro y el formulario medio relleno.
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
