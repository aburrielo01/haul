# PROGRESS.md · HAUL

Última actualización: 15 de noviembre de 2026. En vivo: 4.1.1. En local,
probada y sin subir: 4.1.2 (Atajo corregido y probado en el Mac).

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

## Pendiente
- **Banco en Render**: pasada 1 (8 nov) = 79 %; analizada fallo a fallo
  (`test/banco-estado.md`): 10 precios cambiados por Black Friday (lector
  correcto, hoja actualizada), 3 fichas retiradas (sustituidas; el lector
  devuelve `GONE`), 8 de terceros. Con eso la pasada 1 habría dado 92 %.
  Falta: subir la 4.1.1 y lanzar las pasadas 2, 3 y 4 el mismo día, con un
  solo lector. El token está en `.env` (comprobado).
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
- **Atajo de iPhone**: causa encontrada y corregida el 15 nov («Codificar URL»
  y «Obtener URLs» quieren la entrada como texto). Probado en el motor de
  Atajos del Mac con Zalando, Amazon y un enlace suelto. Falta: subir la 4.1.2,
  reinstalar el Atajo en el iPhone y probar desde las apps y desde Safari.
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
