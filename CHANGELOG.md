# Cambios

## 4.1.8 · 24 de noviembre de 2026

### La beta se puede medir: quién guarda algo cada semana

El umbral de la beta es «15 personas activas por semana» y Haul no tiene
cuentas: el servidor no distinguía a una persona de otra. Ahora sí, sin pedir
registro ni guardar nombres.

- **Enlace de invitación por tester** (`/?i=k7qf3m`). Al abrirlo, la app
  recuerda el código y lo manda con cada petición; el código desaparece de la
  barra de direcciones. La primera invitación manda: abrir después el enlace
  de otra persona no cambia quién eres. Un código inventado se olvida.
- **Quien llega sin invitación** cuenta con un identificador anónimo que
  genera su navegador (un dispositivo = una persona).
- **Panel privado** con la clave de diagnóstico:
  `/api/beta/report?key=…&html=1`. Testers con acceso, con primer producto,
  personas activas y productos guardados esta semana, una fila por código con
  sus semanas, y las tres tiendas con más lecturas fallidas. Sin `&html=1`
  responde en JSON.
- **Crear invitaciones**: `/api/beta/invites/new?key=…&n=15`; con `&test=1`,
  un código propio que no cuenta en ningún número.
- **Semanas de lunes a domingo, hora de Madrid.** La semana 1 es la primera
  completa tras el arranque (14–20 dic); la 8, la del 1 al 7 de febrero.
  `BETA_START` cambia el día de arranque.
- **iPhone**: el icono de la pantalla de inicio no comparte datos con Safari.
  Con invitación, el manifiesto se pide como `/manifest.webmanifest?i=código`
  y el icono abre `/?i=código`; además se deja una cookie con el código. Y
  «Pasar mis listas» lleva también la identidad de la beta. Pendiente de
  probar en un iPhone de verdad.
- Tablas nuevas `invites` y `beta_events` (SQLite y Postgres). No se guardan
  nombres, IPs ni qué producto es: solo código o identificador, tienda, y
  fecha. Si apuntar falla, el producto se guarda igual.
- Pruebas: `node test/beta.js` (23 de cuentas y semanas; con `BASE=` local,
  17 más del camino completo).

## 4.1.7 · 23 de noviembre de 2026

### Pasar tus listas de Safari al icono (y de un móvil a otro)

En iPhone, Safari y el icono de la pantalla de inicio guardan los datos por
separado. HAUL no tiene cuentas: las llaves de las listas viven en el
navegador, así que quien empezaba en Safari y luego abría el icono se
encontraba Haul vacío (le pasó a Alejandro el 23 nov). Las listas nunca se
perdieron: estaban en el servidor, sin llave a mano.

- **Perfil → Tus listas en otro sitio**: «Pasar mis listas» crea un código
  corto (`ABCD-EF23`, sin 0/O ni 1/I/L) con botón de copiar; «Tengo un código»
  lo canjea y trae las listas propias con su llave, las guardadas de otros y
  el perfil. Vale 15 minutos y una sola vez; solo lleva llaves que de verdad
  abren esas listas; acepta minúsculas y espacios; ocho intentos por minuto.
- La bienvenida (Haul vacío) ofrece recuperarlas con un código.
- Haul pide al navegador que no borre sus datos por falta de uso (Safari borra
  los de las webs que no visitas en una semana; los del icono, no).
- `POST /api/transfer` y `POST /api/transfer/claim`. Pruebas: 8 nuevas en el
  smoke (llave falsa, código inventado o mal escrito, un solo uso, la llave
  recuperada abre la lista como propietario).

## 4.1.6 · 22 de noviembre de 2026

### El verificador, sin inventos

La pasada 4 (88 %, ya con los frenos de la 4.1.5) dejó tres filas que el
verificador debía haber confirmado y no confirmó:

- **Pompeii**: Claude contestó 153 € y 95 € en páginas que decían 125,00 € y
  79,00 €. Ninguna de esas cifras estaba en el texto: se las inventó. Ahora el
  precio del verificador **tiene que estar escrito en la página** (1.655,00,
  1655,00, 98,99, 98.99…); si no, no cuenta y el informe lo anota.
- **Amazon**: el precio estaba en el texto, pero a 14.000 caracteres; la
  ventana se anclaba en la primera vez que salía el nombre (menús, migas). Ahora
  se ancla en la primera aparición del nombre con un precio en los 1.500
  caracteres siguientes, sin contar el título de la pestaña, y es de 16.000.
- El texto visible separa los bloques («Plus 2» + «169,99 €» ya no es
  «Plus 2169,99 €») sin partir los precios que van en varias etiquetas.

Probado en real con las páginas guardadas: Pompeii 125 y 79, Amazon 1.655,
confirmados; Samsung, sin precio en el texto (lo pinta con JavaScript), no se
confirma, como debe ser.

### Hoja

- E092 Samsung: 1.143 € comprobado a mano en el navegador (Black Friday).
- E016 Shein: el enlace no llevaba número de producto y Shein lo resolvía a
  otra camiseta; sustituido por una ficha con número (`-p-564226151`).

## 4.1.5 · 22 de noviembre de 2026

### El verificador del banco, con dos frenos

La pasada 3 (88 %) enseñó dos confirmaciones falsas en Shein: el verificador
leía bien la página, pero la página no era la del producto (E016: «Zorclune
Camiseta…» llevaba a «INCRYTM Camiseta…», otra marca) o el salto de precio no
era creíble (E015: de 15,49 € a 55,88 €). Ahora, antes de consultar a Claude:

- **Misma ficha**: la primera palabra del nombre esperado (en moda, la marca)
  tiene que estar en lo leído. Si no, «revisar a mano» y no se gasta llamada.
- **Cambio verosímil**: el precio nuevo entre 0,4 y 1,8 veces el de la hoja;
  una rebaja de Black Friday cabe, un precio que se triplica no.
- Si las dos cifras coinciden basta una confianza de 0,4 (antes 0,6): son dos
  métodos independientes diciendo lo mismo (Game E090 se quedaba fuera).
- Las tiendas Shopify (Pompeii) llevan la ficha leída: el verificador no
  podía comprobarlas.

Pasada 3 recalculada con estas reglas: 86/100.

## 4.1.4 · 22 de noviembre de 2026

### Junta las dos ramas

- Lleva dentro la **4.1.3 del 19 nov** (capturas a más resolución, aviso de
  lectura dudosa, color y talla, varias capturas, Chromium de uno en uno), que
  ya estaba en Render pero no en la carpeta del Mac. Este trabajo del banco se
  hizo sobre la 4.1.2 y se llamaba 4.1.3; se fusionó con la base 4.1.2 de
  `haul-v4.0-para-github 4` sin conflictos.
- Recupera la **guía del iPhone del 15 nov** (el Atajo primero, Copiar → Pegar
  como alternativa), que no había llegado a GitHub: Render seguía enseñando la
  guía anterior, la que decía «No uses Obtener URLs de la entrada».

### Banco: medir al lector, no al mercado

- **Verificador de precio con Claude.** Cuando nombre y foto aciertan pero el
  precio no cuadra con la hoja, Claude lee el texto visible de la misma página
  (sin el JSON-LD que usa el lector y sin saber qué precio leyó este) y dice
  qué precio enseña. Si coincide con el del lector, la fila cuenta como
  acierto y el informe propone el precio nuevo para la hoja (`✓ IA`); si no,
  es fallo. El texto se recorta alrededor del nombre del producto, porque en
  muchas tiendas los menús ocupan los primeros miles de caracteres. Probado en
  real: Snipes, Sprinter y Zalando confirmados; en Sprinter, la primera versión
  tomó el «precio de los últimos 30 días» y se corrigió en las instrucciones.
- **Segunda oportunidad a los tiempos agotados**, solo en el banco y al final
  de la pasada. El informe da las dos cifras: a la primera y con reintento.
- **Anuncios de segunda mano** (`ephemeral` en la hoja: Wallapop, Vinted,
  Depop, la pieza única de Etsy): si el lector los da por vendidos (`GONE`), no
  cuentan en el porcentaje y el informe pide sustituirlos.
- Wallapop E068: el casco sustituto también se vendió en una semana; ahora es
  un soporte GoPro de un vendedor que fabrica.

### Lector

- La comprobación de Amazon («Haz clic en el botón de abajo para seguir
  comprando») cuenta como muro: antes se guardaba una pieza «Amazon.es» sin
  precio; ahora pasa al desbloqueador. Hoy la sirve tanto al Mac como a Render.
- Las instrucciones de la IA excluyen los precios de referencia («últimos 30
  días», «precio original», PVPR) en capturas, rescates y verificación.
- El resultado del lector lleva el HTML leído como propiedad no enumerable:
  lo usa el banco y nunca viaja al móvil, a la caché ni a un JSON.

## 4.1.3 · 19 de noviembre de 2026

### Capturas: se leen mejor y dicen cuándo no se fían

- **La captura se lee a más resolución.** El móvil reducía la imagen a 620 px
  de lado largo (286 × 620 en un iPhone) y esa misma era la que leía Claude: la
  letra pequeña de la ficha llegaba borrosa. Ahora se mandan dos tamaños: la
  de 620 px se sigue guardando como foto y otra de 1568 px va a leerse (también
  para el código de barras y el OCR de respaldo). `/api/shot` admite hasta
  3 MB de cuerpo; el resto de rutas sigue en 1 MB. Cuesta unos 1.300 tokens
  más por captura (céntimos de céntimo con Haiku).
- **Lectura dudosa.** El servidor ya devolvía `confidence` y la app no la
  usaba. Por debajo de 0,5 la hoja avisa «No lo veo claro» y pide revisar
  nombre y precio, en vez de «Captura leída ✦».
- **Color y talla como campos propios** (`items.color`, `items.size`): se
  guardan al añadir por captura y se pueden corregir por `PATCH`. La nota los
  sigue enseñando para poder editarlos a mano. Las bases que ya existen
  reciben las dos columnas al arrancar.
- **Varias capturas a la vez** (hasta 10): se leen de una en una; al guardar
  una, la hoja sigue abierta con la siguiente («Captura 2 de 3») y se puede
  saltar la que no interese.
- **La prueba mide lo que manda el móvil.** `test/ai.js` comprueba que las
  capturas de `test/shots/` no son mayores que lo que envía la app y que el
  tope del lector admite ese tamaño.

### Chromium de uno en uno

- Las lecturas que necesitan navegador hacen cola (`BROWSER_CONCURRENCY`, 1 por
  defecto). Con dos páginas a la vez la instancia de Render se reinició en el
  banco del 8 nov; con varios testers añadiendo enlaces difíciles a la vez
  habría pasado lo mismo. Si la cola está llena (`BROWSER_QUEUE_MAX`, 8) o la
  espera pasa de `BROWSER_WAIT_MS` (40 s), esa lectura sigue sin navegador con
  lo que haya sacado el resto de la cascada.
- `/api/health` → `browser`: huecos, ocupados, en espera, servidas, las que se
  quedaron fuera y la espera más larga.
- Pruebas: `npm run test:queue` (turno, tope y espera, sin abrir navegador) y
  `test/smoke.js` con los campos nuevos y el límite de `/api/shot`.

## 4.1.2 · 15 de noviembre de 2026

### El Atajo de iPhone, por fin con el enlace

- Causa encontrada probando el Atajo en el motor de Atajos del Mac
  (`shortcuts run` con el texto real que comparte Zalando): «Codificar URL» y
  «Obtener URLs de la entrada» solo leen su entrada si va escrita como texto
  (`WFTextTokenString`); como variable suelta devuelven vacío. Por eso Haul
  recibía `#add=` a secas y avisaba «ha llegado sin enlace». «Obtener texto» y
  «Base64» son al revés. Nueve variantes medidas; anotado en el generador.
- El Atajo lleva ahora las dos formas de «Obtener URLs» (texto y variable)
  para cubrir las apps y las páginas de Safari. Probado en el Mac con el texto
  de Zalando, el de Amazon y un enlace suelto: Haul recibe título y enlace, y
  la ficha se lee (Zalando: «CLUB C 85 UNISEX - Zapatillas - off-white»,
  74,95 €).
- El service worker ya no guarda en caché `/atajo/`: el móvil instalaba la
  versión del Atajo que descargó la primera vez aunque el servidor tuviera
  otra.
- La guía del iPhone pone el Atajo primero (confirmado por Alejandro desde
  Zalando, Amazon y Safari) y deja Copiar → Pegar como alternativa sin
  instalar nada. Quien lo instalara antes del 15 nov debe reinstalarlo.
- `scripts/pasada-banco.sh`: lanza una pasada del banco en Render y la vigila
  (lee el token del `.env`, un solo lector).

## 4.1.1 · 15 de noviembre de 2026

### Banco: la hoja al día y las fichas retiradas

- Primera pasada completa en Render con la 4.1.0 (8 nov): 79 %. De los 21
  fallos, 10 eran precios que habían cambiado (Black Friday): verificados uno
  a uno en un navegador real, **el lector leyó en todos el precio correcto del
  día**. La hoja se actualiza con ellos (`verified: 2026-11-08`) y las filas
  volátiles llevan tolerancia: Miravia 30 % (ofertas flash), Fnac 25 % (lo
  vende un tercero del marketplace que rota).
- 3 enlaces muertos sustituidos: JD Sports (ficha retirada, 404), Foot Locker
  («Product not found» para proxies y navegador) y Wallapop (anuncio vendido).
- El lector reconoce una **ficha retirada** (`gone`): título de plantilla sin
  rellenar como «(:title)», «Sin resultados», «Este producto ya no está
  disponible», o el estado con `"statusCode":404` y «Product not found». Solo
  cuenta si no hay producto ni precio; un agotado no lo es. Sale con el error
  `GONE` y el mensaje «Este producto ya no está en la tienda», sin gastar
  desbloqueador ni IA, y la hoja de añadir explica qué ha pasado en vez de
  guardar una pieza llamada «(:title)».
- No lanzar el banco con dos lectores en Render: la instancia se reinicia.

## 4.1.0 · en curso (7 de noviembre de 2026)

### Banco de pruebas: consistencia, no una foto

- El banco guarda historial: las últimas cinco lecturas de cada enlace y las
  últimas diez pasadas completas (`bench:history`). El informe lleva una
  columna **hist.** con las marcas (✓✗✓…) y una etiqueta por enlace: estable,
  inestable, falla o sin datos; y una línea que responde a la pregunta de
  verdad: ¿las tres últimas pasadas completas están en objetivo?
- `/api/bench/run` admite `concurrency=2` (tope) para acortar las pasadas.
- `npm run test:bench` → `node test/bench.js` (historial incluido).

### Claude lee las capturas y rescata fichas

- `lib/ai.js`, con el SDK oficial de Anthropic: `POST /api/shot` recibe la
  captura reducida que ya hacía el móvil y devuelve nombre, precio actual,
  moneda, tienda, color y talla con salida estructurada (JSON validado). El
  OCR del móvil (Tesseract) queda como plan B si no hay clave o la lectura
  falla. Sin `ANTHROPIC_API_KEY` todo sigue exactamente como antes.
- Rescate de fichas: cuando la cascada de lectura acaba sin nombre o sin
  precio pero hay una página real (no un muro), se pide a Claude lo que falta
  a partir del texto visible; la ficha sale como `parcial+ia`. No se usa en
  el modo barato del vigilante.
- `/api/health` → `ai` dice si hay clave, si está en pausa (clave rechazada:
  15 minutos; límite de peticiones: 1 minuto) y el último error con su
  motivo, para no tener que ir a los logs.
- Coste bajo control: modelo por variable (`AI_MODEL`, por defecto
  `claude-haiku-5-5`), tope diario (`AI_DAILY_LIMIT`, 300), caché por huella
  de imagen (7 días) y por enlace (1 día), y gasto estimado del día en
  `/api/health` → `ai`.
- Pruebas: `node test/ai.js` (con cliente simulado; con clave y capturas en
  `test/shots/`, también lectura real). Dependencias nuevas:
  `@anthropic-ai/sdk` y `zod`.

### AWIN, en segundo plano y por tienda

- `lib/awin.js`, detrás de `AWIN_PUBLISHER_ID`, `AWIN_TOKEN` y
  `AWIN_ADVERTISERS` (dominio=idAnunciante:idioma, uno por tienda aprobada).
  Sin ellas no hace nada.
- Enlaces de afiliado: el vigilante pide por lotes de 100 el enlace de
  seguimiento de cada pieza de una tienda AWIN y lo guarda en la pieza
  (`affiliate_url`); la ficha abre la tienda por ese enlace. Si el anunciante
  no permite deep links, se anota y no se insiste en un mes.
- Precios desde el feed: una vez al día, por anunciante con piezas, se lee su
  feed JSON Lines *en streaming* y solo se guardan las filas cuyo enlace está
  en HAUL; esas piezas se actualizan por el mismo camino que el vigilante
  (comparación, historial, avisos de bajada), con `mode: 'awin'`. Sin stock,
  el precio no se toca. Respeta el límite de 5 peticiones por minuto.
- `/api/health` → `awin` con enlaces generados o denegados y la última pasada
  de feeds. Pruebas: `node test/awin.js` (API simulada).

### `.env` en local

- El servidor y las pruebas leen un `.env` en la raíz si existe (`lib/env.js`,
  sin dependencias; no pisa variables ya definidas). `.env.example` trae todas
  las variables comentadas. `.env` está en `.gitignore`.

### Guía del iPhone

- El camino sin instalar nada (Compartir → Copiar, abrir Haul → Añadir →
  Pegar) aparece el primero; el Atajo queda como opción de dos toques.

## 4.0.1 · 31 de octubre de 2026

Dos arreglos del despliegue de la 4.0.

- La build de Render caía en `npm install`: la imagen de Playwright pasó a
  Node 24 y `better-sqlite3` 11 no traía binario para él, así que intentaba
  compilar en una imagen sin `make`. `better-sqlite3` sube a 12.x (sí lo trae)
  y el Dockerfile instala `python3 make g++` por si vuelve a faltar.
- El botón "Instalar" del Atajo descargaba la página en vez del Atajo: al
  subir el fichero a GitHub desde el Mac, la «ñ» del nombre llegó a Linux en
  forma descompuesta y la ruta ya no lo encontraba. El fichero pasa a
  `public/atajo/anadir-a-haul.shortcut` y el servidor acepta cualquier
  escritura del nombre; se descarga igualmente como «Añadir a Haul».
- Si el Atajo abre Haul sin enlace (hay apps que no se lo pasan), se abre la
  hoja de añadir con **Pegar** y un aviso que dice qué copiar, en vez de un
  aviso que pedía reinstalar el Atajo.
- El Atajo ya no depende de *Obtener URLs de la entrada*: con lo que entregan
  las apps de Amazon y Zalando (un texto con el enlace dentro y una URL) esa
  acción devuelve vacío. Ahora recoge el texto, lo codifica y lo manda entero;
  Haul saca el enlace y aprovecha el nombre. Tampoco convierte la entrada a URL:
  con un texto que no es enlace, Atajos falla ("no ha podido convertir Texto en
  URL") y se para. La receta a mano de la guía cambia igual.
- Los enlaces cortos que comparten las apps (`amzn.eu/d/…`, `a.co`, AliExpress,
  OneLink…) se expanden en el servidor antes de elegir adaptador: hasta ahora un
  enlace de la app de Amazon se leía sin el adaptador de Amazon.
- El nombre que viene en el texto compartido gana cuando la tienda solo
  devuelve el suyo ("Amazon.es") o nada. Y los dos puntos de un título ("El
  Hombre Iluminado: Una novela del Cosmere") ya no se confunden con el patrón
  "… en Zalando: Nombre": solo se recorta cuando delante hay un "en Tienda".
- `public/atajo/diagnostico.shortcut` (`scripts/make-diagnostico.py`): Atajo
  que, al compartir desde cualquier app, enseña y copia qué recibe (tipo,
  texto, enlaces). Sirve para saber qué entrega cada app al menú Compartir.

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

### Atajo de iPhone y entradas

- El Atajo "Añadir a Haul" viene hecho y firmado (`public/atajo/`): se instala
  con un toque desde el perfil. Extrae el enlace de lo que compartes antes de
  abrir Haul; el Atajo antiguo mandaba el título de la página ("ZARA España") y
  la pieza nacía sin ficha. Si llega un título sin enlace, Haul lo explica y
  ofrece el Atajo nuevo en vez de guardar el nombre de la tienda.
- El lector entiende eventos (JSON-LD `Event`): nombre, cartel y fecha con
  recinto en la nota. Vivaticket no publica el precio en la ficha; se deja a
  mano. Las pantallas intermedias de Incapsula y similares cuentan como muro.

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
