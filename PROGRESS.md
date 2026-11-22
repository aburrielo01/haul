# PROGRESS.md · HAUL

Última actualización: 22 de noviembre de 2026 (noche). En vivo: 4.1.5. En local,
probada y sin subir: 4.1.6 (el verificador no admite precios inventados).
= 4.1.3 + verificador de precio del banco + guía del iPhone del 15 nov.

## Hecho
- **v4.0** (24–26 oct): vigilancia de precios con avisos push opcionales,
  duplicados, ordenar arrastrando, portada para historias. Desplegado en Render.
- **Banco** (25–26 oct): hoja de verdad revisada, adaptadores Snipes / Temu /
  Zara Home, reintentos del desbloqueador. Render: 86 → 94 / 100. Objetivo ≥ 92 %.
- **Vivaticket** (31 oct): el lector entiende eventos (JSON-LD `Event`); las
  pantallas intermedias de Incapsula cuentan como muro. Sin comprobar en Render.
- **4.0.1** (31 oct – 2 nov): build de Render arreglada (`better-sqlite3` 12 +
  herramientas de compilación); Atajo de iPhone con nombre ASCII, ruta que
  acepta cualquier escritura, sin «Obtener URLs» ni conversión a URL; enlaces
  cortos de Amazon (`amzn.eu`) expandidos en el servidor; el nombre del texto
  compartido gana si la tienda solo devuelve el suyo.
- **4.1.0 · banco** (7 nov, desplegado): historial de las últimas 5 lecturas
  por enlace y de las últimas 10 pasadas completas; columna estable /
  inestable / falla en el informe y veredicto «consistente» con las 3 últimas
  pasadas; `concurrency=2`. Probado en local con dos pasadas reales.
- **4.1.0 · Claude** (7 nov, en local): `lib/ai.js` + `POST /api/shot` leen la
  captura en el servidor (Haiku 5.5, salida estructurada, tope diario, caché);
  Tesseract queda de plan B; rescate de fichas «parciales» con el texto de la
  página. Sin clave todo sigue como antes (comprobado: 404 AI_OFF → OCR).
  Cuatro capturas reales en `test/shots/` para la prueba con clave.
- **4.1.0 · AWIN** (7 nov, en local): `lib/awin.js` detrás de variables:
  enlaces de afiliado por lotes desde el vigilante (columna `affiliate_url`),
  precios desde el feed en streaming una vez al día por anunciante, respetando
  5 peticiones/minuto. La ficha abre la tienda por el enlace de afiliado.
- **4.1.0 · guía iPhone** (7 nov): el camino sin instalar nada (Copiar → Haul →
  Pegar) va primero; el Atajo queda como opción de dos toques.
- **4.1.3 · capturas y cola** (19 nov, en Render): la captura se lee a 1568 px
  y se guarda a 620; aviso «No lo veo claro» por debajo de 0,5 de confianza;
  color y talla como campos; hasta 10 capturas por tanda; Chromium de uno en
  uno con cola (`BROWSER_CONCURRENCY`). Se hizo fuera de esta carpeta y llegó
  como zip a Descargas.
- **4.1.4 · banco y fusión** (22 nov, en local): verificador de precio con
  Claude, segunda oportunidad a los tiempos agotados, anuncios vendidos fuera
  del cálculo, la comprobación de Amazon cuenta como muro. Fusionada con la
  4.1.3 y con la guía del iPhone del 15 nov, que no había llegado a GitHub.

## Pendiente
- **Banco en Render**: pasadas 1-5 = 79, 80, 88 (86 real), 88, 88 %. La 4.1.6
  quita los fallos del verificador que quedaban (precios inventados, ventana
  mal anclada); proyección de la pasada 4 con ella: 92 %. Falta: subir la 4.1.6
  cuando acabe la pasada 5 y lanzar tres pasadas seguidas. Por debajo quedan
  anti-bot (Shein, Primark, AliExpress, Temu) y Depop (KYC de Bright Data, lo
  tiene que hacer Alejandro).
- **Capturas (4.1.3)**: probar en el iPhone una captura con letra pequeña
  (precio tachado y rebajado). La 4.1.3 hablaba de una checklist para la beta
  (`claude/estado-beta.md` y un doc «Haul · checklist para la beta») que no
  está en este Mac.
- **Avisos push apagados en Render** (`/api/health` → `push: false`, 22 nov):
  faltan `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT` en el panel.
  El vigilante detecta bajadas, pero no llegan al móvil.
- **Clave de Anthropic**: válida y en `.env` (8 nov). Lectura real con Haiku
  5.5 de las 4 capturas: Nike y Zalando perfectas (nombre, precio, tienda,
  color), Amazon sin título porque la captura no lo enseña, Zalando con pop-up
  confianza 0,1 (honesto). 0,0014 $ las cuatro. En Render funciona: la Nike
  leída en producción en 7 s por 0,0003 $. El primer rechazo fue pasajero (mi
  imagen de prueba no era válida); el nuevo `lib/ai.js` enseña el motivo en el
  health si vuelve a pasar. Probado por Alejandro en el iPhone (8 nov):
  Añadir → Captura rellena la ficha.
- **AWIN**: pedir aprobación a las tiendas en el directorio (Zalando, ASOS,
  Etsy, Douglas, Decathlon, Leroy Merlin, MediaMarkt, Uniqlo como candidatas),
  crear el token en ui.awin.com/awin-api y rellenar `AWIN_PUBLISHER_ID`,
  `AWIN_TOKEN` y `AWIN_ADVERTISERS` en Render. Primera pasada real: comprobar
  en `/api/health` → `awin` enlaces y feed, y el tiempo del feed de Zalando.
- **Atajo de iPhone: funciona** (15 nov, 4.1.2). Causa: «Codificar URL» y
  «Obtener URLs» querían la entrada como texto. Probado en el motor de Atajos
  del Mac y confirmado por Alejandro en el iPhone desde Zalando, Amazon y
  Safari. Decisión de la tarea D: el Atajo se queda (dos toques, sin copiar ni
  pegar); el camino Copiar → Pegar sigue en la guía como alternativa.
- **Persistencia**: falta saber si lo que falla es el móvil (listas que
  desaparecen: claves del dispositivo) o el servidor.
- Comprobar Vivaticket en Render. Banco: Shein ×2, About You, AliExpress E059,
  Depop ×2 (Bright Data pide KYC).

## Decisiones
- Objetivo del banco en 92 %, no en 95: lo que queda son tiendas que bloquean
  o cuentas de terceros, no fallos de lectura. «Consistente» = las tres últimas
  pasadas completas en objetivo.
- Claude Haiku 5.5 para capturas y rescates (extracción, no razonamiento;
  ≈ 40 veces más barato que Opus 5.5), configurable con `AI_MODEL`.
- AWIN solo en segundo plano: nunca en una petición del usuario; el feed se
  lee en streaming y se descarta todo lo que no esté en HAUL.
- Nombres de fichero ASCII en `public/`; la ruta del Atajo acepta el nombre
  viejo con «ñ» para no romper enlaces guardados.
- `better-sqlite3` 12.x y `make`/`g++` en el Dockerfile: la imagen de
  Playwright ya trae Node 24 y la 11.x no tenía binario.
- El Atajo manda el texto entero codificado y Haul saca enlace y nombre; es
  más robusto que cualquier extracción dentro de Atajos.
- El diseño sigue siendo «scrapbook editorial»; el brandbook V2 (oscuro, lima)
  quedó superado.
- Una sola copia limpia para GitHub, `~/Desktop/haul-v4.0-para-github`, que se
  mantiene idéntica al proyecto; las copias de descomprimir se tiran (2 nov).
- Antes de empezar, `/api/health` contra `package.json`: si Render va por
  delante, el código nuevo está en otro sitio (22 nov: la 4.1.3 estaba en
  Descargas y otra sesión numeró su trabajo 4.1.3 sobre la 4.1.2). Dos
  sesiones no trabajan a la vez en esta carpeta.
