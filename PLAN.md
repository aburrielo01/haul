# PLAN.md · HAUL · 7 de noviembre de 2026

Estado al cierre del día: A2, C1–C3, B2–B3 y D4 hechos y probados en local;
A1/A3/A4 esperan el `.env` con DIAG_TOKEN; C5 y B4 esperan clave y cuenta;
D1–D3 esperan tu prueba en el iPhone. Detalle en PROGRESS.md.

Cuatro frentes. Orden propuesto: A (arranca y espera) → D (análisis corto) →
C (construir) → B (diseño hoy, construir cuando haya cuenta). Cada paso dice
cómo se comprueba. Nada se toca sin luz verde.

## Antes de empezar (lo haces tú, 2 minutos)
- Crear `.env` en la raíz con `DIAG_TOKEN=…` (el del panel de Render). Yo no
  escribo claves: los comandos las leen del `.env`. `.env` se añade a
  `.gitignore` y nunca va a la carpeta limpia.
- Clave de Anthropic: en este Mac no hay ninguna (comprobado el 7 nov). Se
  crea en la Console (platform.claude.com → API keys, con facturación
  activa), se pone en `.env` como `ANTHROPIC_API_KEY=…` para probar en local y
  en el panel de Render para producción. Hasta entonces, C se construye y se
  prueba con la clave en local cuando la tengas.
- AWIN: cuenta de publisher sin tiendas aprobadas (7 nov). B se construye
  detrás de variables (`AWIN_PUBLISHER_ID`, `AWIN_TOKEN`) y se activa tienda a
  tienda según lleguen las aprobaciones.

## A · Banco al 92 % de forma consistente
Hoy el banco guarda solo la última pasada; «consistente» exige varias.
1. **Pasada 1 en Render** (`/api/bench/run?fresh=1`, enlaces nuevos). Medir
   cuánto tarda y cuánto desbloqueador gasta (`/api/health` → `unlockerUsage`;
   tope 300/día). Comprobación: informe con % y lista de fallos.
2. **Historial de pasadas** en `lib/bench.js`: guardar las últimas 5 pasadas
   por enlace (`bench:history`) y, en el informe, una columna «estable /
   inestable» (acierta en todas / falla a ratos). Comprobación: `npm test`
   más una pasada local con `--limit 5` que escriba el historial.
3. **Pasadas 2 y 3** a horas distintas. Comprobación: tres pasadas ≥ 92 % y
   la lista de enlaces inestables.
4. **Arreglar los inestables** que dependan de código (reintentos, tiempos,
   adaptador). Los que dependan de terceros (Depop KYC, Shein) se documentan.
5. Actualizar `test/banco-estado.md` y el CHANGELOG. Subir y repetir pasada.

## B · AWIN con el mínimo peso para la app
Lo que da AWIN (documentación leída hoy):
- **Link builder** (`POST /publishers/{id}/linkbuilder/generate`, por lotes de
  100): convierte el enlace de una pieza en enlace de afiliado. Ingreso por
  compra, cero lectura de tiendas. AWIN avisa de que no es para usarlo «en
  vivo» desde el navegador: se hace en el servidor, en segundo plano.
- **Feeds de producto** (JSON Lines por anunciante e idioma, solo con
  partnership aprobada): nombre, precio, foto, stock. El feed de Zalando o
  ASOS tiene cientos de miles de filas: descargarlo entero cada día sí
  sobrecarga.
Diseño eficiente, en este orden:
1. **Pedir aprobación** (lo haces tú, en el directorio de anunciantes de
   AWIN) a las tiendas de HAUL que trabajen con AWIN en España. Empezar por
   5; candidatas a comprobar en el directorio: Zalando, ASOS, Etsy, Douglas,
   Decathlon, Leroy Merlin, MediaMarkt, Uniqlo. Sin aprobación no hay feed ni
   enlaces: el código queda listo y se activa por tienda.
2. **Enlaces de afiliado en segundo plano**: al guardar una pieza de una
   tienda AWIN, el vigilante (que ya corre cada 12 h) pide el enlace por
   lotes y lo guarda en la pieza. La app enseña el enlace de afiliado al
   abrir la tienda. Comprobación: pieza de Zalando → enlace `awin1.com` en
   la ficha; sin cuenta, todo sigue igual.
3. **Precios desde el feed, no desde la tienda**: una vez al día, por cada
   anunciante del que haya piezas, descargar el feed *en streaming* y
   quedarse solo con las filas cuya URL o referencia esté en HAUL (un
   conjunto en memoria). Sustituye la lectura por scraping en el vigilante
   para esas tiendas: menos desbloqueador, menos Chromium. Comprobación:
   `WATCH` lee de feed las piezas de esas tiendas y marca `mode: 'awin'`.
4. Medir: tiempo y memoria por feed, llamadas ahorradas al desbloqueador.

## C · API de Claude: capturas y datos como puntal
Hoy la captura pasa por Tesseract en el móvil: lenta, floja con precios y
nombres. El lector de fichas, cuando una tienda bloquea, se queda en
«parcial».
1. **`lib/ai.js`** con el SDK oficial (`@anthropic-ai/sdk`): una función
   `readShot(imagen)` que devuelve `{title, price, currency, shop, url,
   color, size, confidence}` con salida estructurada (JSON validado). Sin
   clave en el entorno, la app sigue como hoy. Tope diario configurable
   (`AI_DAILY_LIMIT`) y caché por huella de imagen. Comprobación:
   `node test/ai.js` con 3 capturas reales (Zalando, Amazon, Vinted).
2. **`POST /api/shot`**: el móvil manda la captura ya reducida (como hoy) y
   el servidor responde con los campos. ZXing (códigos) se queda delante;
   Tesseract pasa a ser el plan B si no hay clave o se agota el tope.
   Comprobación: hoja Captura → ficha con nombre, precio y tienda en < 5 s.
3. **Rescate de fichas «parciales»**: cuando la cascada acaba sin precio o
   sin nombre pero hay HTML (o captura de Chromium), pedir a Claude los
   campos a partir del texto visible. Comprobación: los enlaces del banco
   que hoy quedan en «parcial» por lectura (no por muro) suben.
4. **Modelo** (decidido el 7 nov, a petición tuya por calidad-coste):
   Claude Haiku 5.5 (`claude-haiku-5-5`) para leer capturas y rescatar
   fichas: es extracción de campos, no razonamiento, y cuesta ≈ 0,0003 € por
   captura frente a ≈ 0,01 € de Opus 5.5. Configurable con `AI_MODEL`; si en
   la prueba con capturas reales falla nombres o precios, se sube a Opus 5.5
   cambiando la variable.
5. Medir coste real en `/api/health` (capturas/día, tokens, euros estimados).

## D · ¿Merece la pena el Atajo de iPhone?
Hecho hoy: iOS sigue sin «Web Share Target» (bug de WebKit abierto desde
2019; nota de diciembre de 2025 lo confirma). Una web no puede aparecer en
el menú Compartir del iPhone; solo un Atajo o una app nativa.
1. **Prueba real con el Atajo actual** (sin conversión): Amazon, Zalando,
   Vinted, Zara y Safari. Anotar: funciona / qué llega / cuántos toques.
2. **Compararlo con el camino sin Atajo**: Compartir → Copiar enlace → abrir
   Haul (lee el portapapeles sola). Son dos toques más, pero no hay nada que
   instalar ni que se rompa.
3. **Decidir** con criterios: acierta en las 5 apps, se instala en < 1 min,
   no necesita mantenimiento. Opciones: (1) Atajo como extra y portapapeles
   como camino principal en la guía; (2) solo portapapeles, retirar el
   Atajo; (3) app nativa con extensión de Compartir (Capacitor, App Store,
   99 €/año y revisión de Apple) cuando HAUL tenga tracción.
   Recomendación provisional: (1), por coste cero y sin dependencias.
4. Dejar la guía del perfil acorde con la decisión.

## Lo que no entra hoy
- Persistencia de listas (pendiente de saber si falla móvil o servidor).
- Vivaticket en Render (se comprueba de paso con la pasada del banco).
