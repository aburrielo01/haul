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

Desde la **4.0**, Haul también trabaja después de guardar:

| | |
|---|---|
| **Vigila el precio** | Vuelve a leer cada pieza cada 12 h con los intentos gratuitos. Si baja, sticker ↓ en la lista, filtro *Bajadas*, aviso en el inicio y, si quieres, notificación en el móvil. En la ficha: ahora / antes / mínimo, evolución y *Comprobar ahora*. |
| **Avisa de repetidos** | Si pegas un enlace que ya está en la lista (aunque cambie la talla o el color en la URL), lo dice antes de guardar. |
| **Se ordena arrastrando** | Mantén pulsada una pieza y muévela; el orden se guarda. También por precio o fecha. |
| **Portada para historias** | Una imagen 9:16 con la lista, sus piezas y un QR, lista para Instagram o WhatsApp. |

El detalle está en [CHANGELOG.md](CHANGELOG.md).

## Cómo está montado

```
server.js              API REST, páginas y estáticos
lib/db.js              datos (SQLite o Postgres, misma API)
lib/extract.js         extracción de producto, precios, códigos de barras
lib/adapters.js        adaptadores por tienda (Amazon, Zalando, El Corte Inglés…)
lib/watch.js           vigilancia de precios: relee las piezas y detecta bajadas
lib/push.js            avisos push (Web Push con claves VAPID)
public/index.html      todas las pantallas de la app
public/styles.css      sistema visual
public/app.js          lógica de la interfaz (incluye la portada para historias)
public/sw.js           service worker (abre sin conexión, recibe los avisos)
test/smoke.js          ciclo completo de una lista vía API
test/parse.js          precios, EAN, nombres desde la URL
test/watch.js          cuándo un precio nuevo cuenta como cambio o bajada
test/unlocker.js       desbloqueador, contra un servidor falso
test/adapters.js       adaptadores y elección del precio correcto
lib/bench.js           banco de pruebas: lee test/bench-urls.json y compara con la hoja de verdad
test/bench-urls.json   los 100 enlaces del banco con nombre y precio esperados
```

**Sin cuentas.** Al crear una lista el servidor devuelve un `ownerToken` que se guarda
solo en el móvil. Ese token es lo que permite editarla. El enlace público no lo lleva,
así que compartir una lista nunca da permisos de edición.

**Compartir implica poder ver.** Las listas nacen privadas, pero al copiar o enviar el
enlace se activan solas como públicas. Antes el enlace llegaba y la otra persona se
quedaba en la pantalla de inicio sin entender nada; ahora, si una lista sigue siendo
privada, quien la abre ve una pantalla que lo explica y un botón para reintentar.

**Compartir *con* Haul.** El service worker atiende el `share_target`: desde otra app
se puede mandar a Haul un enlace, texto o una imagen —Zalando comparte sus productos
como foto— y la app abre el formulario con eso ya cargado. En Android funciona el
compartir del sistema; en iPhone, que todavía no lo admite, está el botón
*Pegar imagen copiada* dentro de la pestaña Captura.

**El Atajo de iPhone.** `public/atajo/Añadir a Haul.shortcut` es un Atajo firmado
(se instala con un toque desde Perfil → *Haul en el menú Compartir*) con tres
acciones: *Obtener URLs de la entrada* → *Texto* `https://…/#add=<URLs>` → *Abrir
URL*. La primera acción es la que importa: una página de Safari o el texto de una
app se convierten en su enlace; sin ella, iOS manda el título de la página y Haul
recibe "ZARA España" en vez de la ficha. Si cambias de dominio, regenera el fichero:

```bash
python3 scripts/make-shortcut.py https://tu-dominio.com atajo.shortcut
shortcuts sign --mode anyone --input atajo.shortcut --output "public/atajo/Añadir a Haul.shortcut"   # en un Mac
```

## Ponerlo en marcha

```bash
npm install
npx playwright install chromium   # solo en local; la imagen Docker ya lo trae
npm start                          # http://localhost:3000
npm test                           # pruebas de humo (con el servidor arrancado)
node test/parse.js                 # pruebas del parseador
node test/watch.js                 # vigilancia de precios
node test/unlocker.js              # desbloqueador, contra un servidor falso
node test/bench-local.js           # el banco de 100 enlaces desde tu máquina (--ids E011,E033 · --shop Zara)
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
| `UNLOCKER_DAILY_LIMIT` | Tope diario de aciertos de pago (los fallos no cuentan) | `150` |
| `UNLOCKER_TIMEOUT` | Espera máxima al desbloqueador (ms); las verificaciones duras pasan de 45 s | `80000` |
| `DIAG_TOKEN` | Activa `/api/diagnose` (ver abajo) | — |
| `SHOP_COUNTRY` | País para tiendas con precio por país (Shopify Markets) | `ES` |
| `CHROMIUM_FIRST` | `1` para probar Chromium antes que el desbloqueador (gasta más memoria) | — |
| `WATCH` | `off` apaga la vigilancia de precios | activa |
| `WATCH_EVERY_H` | Cada cuántas horas se vuelve a leer una pieza | `12` |
| `WATCH_TICK_MIN` | Cada cuántos minutos despierta el vigilante | `10` |
| `WATCH_BATCH` | Piezas por despertar (de una en una, con pausa) | `20` |
| `WATCH_PAUSE_MS` | Pausa entre dos lecturas (ms) | `1500` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Activan los avisos push (ver abajo) | — |
| `VAPID_SUBJECT` | Contacto que viaja con cada aviso (`mailto:` o URL) | — |

## Vigilancia de precios y avisos

El vigilante (`lib/watch.js`) despierta cada 10 minutos y relee hasta 20 piezas
que lleven más de 12 horas sin comprobar, de una en una y con pausa, para no
molestar a ninguna tienda. **Solo usa los intentos gratuitos** (API de la tienda,
Shopify, `fetch`): ni desbloqueador, que cobra por acierto, ni Chromium. Si una
pieza falla cuatro veces seguidas, se la revisa seis veces menos. Con unas
decenas de listas activas, el coste es cero.

Un precio nuevo cuenta como cambio si difiere al menos 0,50 y un 1 %; una caída
de más del 85 % se descarta como lectura rota (otra variante, precio por unidad).
Cada cambio guarda el precio anterior y un punto en `price_history`; el botón
*Comprobar ahora* de la ficha hace una lectura completa a petición del usuario.

Los **avisos push** son opcionales. Para activarlos:

```bash
npx web-push generate-vapid-keys
```

y en Render → *Environment*: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y
`VAPID_SUBJECT=mailto:tu@correo`. Al redesplegar, en el perfil aparece *Activar
avisos*. Cada móvil manda su suscripción junto con los tokens de dueño de sus
listas, y el servidor solo apunta las que demuestra que son suyas; una
suscripción que el móvil revoca se borra sola al primer envío fallido. En iPhone
los avisos solo llegan con Haul instalada en la pantalla de inicio (iOS 16.4+).

`/api/health` devuelve `watch` (piezas comprobadas, cambios, bajadas, último
despertar) y `push` (si hay claves).

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

## Cuando una tienda falla: diagnóstico

Con `DIAG_TOKEN` definido en Render, esta URL cuenta qué ha visto cada intento del
lector sobre una ficha, con tiempos y sin volcar HTML:

```
https://TU-APP.onrender.com/api/diagnose?url=https://tienda.com/producto&key=TU_DIAG_TOKEN
```

Pégalo tal cual en una conversación de soporte. Ahorra media hora de adivinar.

Con `&raw=fetch` (o `movil`, `chromium`, `unlocker`) devuelve el HTML tal cual lo
vio ese intento: es la materia prima para escribir el adaptador de una tienda.

## Banco de pruebas

Mide qué porcentaje de los enlaces de `test/bench-urls.json` se leen bien (nombre,
precio y foto). El objetivo es **el 92 %** (`TARGET_PCT` en `lib/bench.js`; el
informe lo marca con ✓ o ✗). Corre en segundo plano en el servidor y guarda el
estado en la base de datos. Con `DIAG_TOKEN` definido:

```
/api/bench/run?key=TU_DIAG_TOKEN            lanza los 100 (acepta &shop=Zara, &limit=10, &ids=E001,E002)
                                             si el servidor se reinició a mitad, continúa por donde iba; &fresh=1 empieza de cero
/api/bench/report?key=TU_DIAG_TOKEN&html=1  informe en el navegador; sin html=1 devuelve JSON
```

Cada fallo guarda su **rastro**: qué intento se hizo (fetch, desbloqueador, Chromium),
qué devolvió (código HTTP, muro, motivo de rechazo de Bright Data) y cuánto tardó.
En el informe HTML aparece debajo de cada fila en rojo.

Para releer solo algunos enlaces sin perder el resto del informe:
`/api/bench/run?key=…&ids=E011,E033`.

Para añadir enlaces, filas nuevas en el JSON (id, shop, url, title, price, currency).
Dos campos opcionales: `verified` (fecha en que alguien comprobó el precio a mano;
el informe dice cuántas filas lo tienen y desde cuándo) y `tolerance` (fracción,
para tiendas cuyo precio baila solo: Etsy y Depop convierten divisa, AliExpress
cambia según la sesión). Los precios caducan: un fallo de precio con nombre y foto
correctos suele ser la hoja, no el lector. El estado y lo que falta, con causa,
está en `test/banco-estado.md`.

El número en producción depende del **saldo de Bright Data**: unas 30 tiendas del
banco (Inditex, H&M, Adidas, New Balance, Decathlon, Etsy, Zara Home, Maisons du
Monde, Leroy Merlin, Fnac, Shein) solo se leen con el desbloqueador. Con saldo,
92–95 %; sin saldo, en torno al 67 %, haga lo que haga el lector.

## Adaptadores por tienda

Las grandes tiendas no publican datos estructurados y hay que ir a por sus propias
etiquetas. `lib/adapters.js` tiene uno por tienda; cada uno lee solo lo que sabe
leer mejor que el genérico. Para añadir una tienda, una entrada más con su `match`
y su `read`. Amazon, por ejemplo: título en `#productTitle`, precio actual dentro
del bloque de compra (nunca el tachado ni el precio por unidad) y foto en
`data-old-hires`.

## Decisiones que conviene conocer

- **Del intento más barato al más caro.** API propia de la tienda (Depop, ASOS),
  Shopify y la lectura normal resuelven la mayoría en menos de un segundo. Con el
  desbloqueador activo, Chromium queda como último recurso: en el plan pequeño de
  Render gasta tanta memoria que tumba el proceso. Si la tienda ya ha enseñado un
  muro anti-bot, Chromium ni se intenta. El resultado se cachea seis horas.
- **Los errores técnicos se quedan en los logs.** Al usuario solo le llega un mensaje
  claro y el formulario medio relleno.
- **Proxy de imágenes.** Las fotos pasan por `/api/img` porque muchas tiendas bloquean
  el hotlinking; de paso no se filtra el `Referer` del usuario.
- **Protección SSRF.** Toda URL se valida contra IPs privadas y hosts locales antes de
  abrirla, también después de los redirects.
- **Límite de peticiones** por IP en los endpoints caros (20/min) y de escritura (90/min).

- **Las comprobaciones automáticas nunca cuestan dinero.** La vigilancia pasa
  `cheap: true` al extractor y se queda sin precio antes que pagar una lectura.
  Un enlace que solo se lee con el desbloqueador (Zara, Vans…) se comprueba de
  verdad solo cuando el usuario toca *Comprobar ahora*.

## Lo siguiente

- Aviso de "vuelve a estar disponible" (el extractor ya devuelve `availability`).
- Buscar entre todas las listas.
- Portada también en 1:1 y 4:5 para publicaciones, no solo historias.
- Mover una pieza a otra lista.
