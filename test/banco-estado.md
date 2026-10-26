# Banco de pruebas · estado (25 oct 2026, v4.0)

## Qué se ha hecho hoy

Se pasó el banco entero **en local** (Mac, IP residencial, Chromium instalado,
**sin desbloqueador**) y se revisaron a mano, en un navegador de verdad, las fichas
de los 47 enlaces que fallaban. Conclusiones:

1. **La hoja de verdad estaba desfasada, no el lector.** En 18 enlaces con nombre
   y foto correctos el precio leído era el que enseña la tienda hoy: Decathlon
   478 → 549, Fnac PS5 1938,83 → 2417,12, El Corte Inglés 210 → 147 (rebaja),
   Vans y Levi's (rebajas que terminaron), Snipes, Mango, Samsung, PcComponentes,
   Wallapop, Amazon, About You, Miravia, Shein, Etsy (cambio de divisa)… Todos
   actualizados en `bench-urls.json` con la fecha en `verified` y el precio
   anterior en `note`.
2. **Precios que bailan solos.** Etsy y Depop convierten divisa al vuelo y
   AliExpress enseña precios distintos según la sesión (oferta de bienvenida).
   Esas filas declaran `tolerance` (3 % y 15 %); el resto sigue al 1 %.
3. **Mejoras de lector** que salieron de la revisión:
   - Depop: el nombre sale del alt de la galería ("Carhartt Men's Tan and Brown
     Jacket") en vez de la descripción cortada del `<title>`.
   - `fetch` reintenta una vez tras un 429 (Mango) antes de ir al desbloqueador.
   - El informe HTML enseña cuántas filas de la hoja están comprobadas y desde
     cuándo, y qué hizo el desbloqueador en los fallos (si todos sus intentos
     salen rechazados o vacíos, lo que falla es la cuenta, no el lector).

## Números

| Dónde | Resultado | Qué falta |
|---|---|---|
| Local, sin desbloqueador | **66/100** | 29 muros anti-bot (Inditex ×10, H&M, Adidas, New Balance, Decathlon, Etsy, Zara Home, Maisons du Monde, Leroy Merlin, Fnac y, a ratos, Levi's E031), Shein ×2, Temu ×2, AliExpress E059 |
| Producción con desbloqueador **con saldo** (estimación) | **92–95/100** | Temu ×2 (ficha sin precio ni foto para bots), AliExpress E059 (a ratos sirve la página sin producto), Levi's E032 (captcha que Bright Data rechaza), y según el día About You (portada a visitas automáticas) y Depop (requiere KYC en Bright Data) |
| Producción con el desbloqueador **sin saldo** | ≈ 66/100 | los mismos muros que en local |

Los 29 muros locales son exactamente las tiendas que en producción pasan por el
desbloqueador: Akamai y similares bloquean tanto `fetch` como Chromium sin cabeza,
también desde una IP residencial. No hay atajo de código para ellas. Todo lo que
no es muro y tiene nombre y foto se lee bien: **el lector no falla en ninguna
ficha que consigue abrir.**

## Lo que decide el número en producción

**El saldo de Bright Data.** El 18 de octubre la cuenta tenía 0,01 $ y el
desbloqueador acertaba 5 de 25. Con la cuenta sin saldo, el banco en Render
quedará en torno al 67 %, haga lo que haga el lector. Antes de medir:

1. Recargar saldo en Bright Data (o activar el plan gratuito de 5.000 peticiones).
2. Completar el KYC de la cuenta si se quiere Depop (`policy_20050`).
3. `GET /api/health` debe decir `"unlocker": true`.
4. Lanzar `/api/bench/run?key=…&fresh=1` y leer `/api/bench/report?key=…&html=1`.
   La línea "Desbloqueador en los fallos" dice si acierta o si rechaza todo.

## Pendientes y causa

- **Temu ×2**: la ficha que ve un navegador automatizado no trae precio ni foto
  (los pinta tras una verificación). Solo un navegador remoto con sesión real.
- **Shein**: E015 lanza captcha incluso a un navegador normal; E016 va bien con
  desbloqueador. Inestable por naturaleza.
- **AliExpress E059**: a veces sirve la página sin producto; E060 tolera el 15 %.
- **Levi's E032**: Bright Data `reject_block` (captcha) → candidato a Scraping
  Browser. E031 pasa.
- **About You ×2**: en local pasan (Chromium). En producción, a ratos sirve la
  portada a visitas automáticas → feed de AWIN o navegador remoto.
- **Depop ×2**: el lector ya lee bien nombre y precio (Chromium); en producción
  depende del KYC de Bright Data. E069 está agotado desde octubre.
- **Zara ×2, Pull&Bear ×2, Lefties ×2**: no se pudo comprobar el precio a mano
  (la ficha lo pinta tarde); se dejan como estaban.

## Cómo mantener la hoja

Los precios cambian cada semana. Un fallo de **precio** con nombre y foto correctos
es casi siempre la hoja: abre la ficha, actualiza `price`, apunta el anterior en
`note` y pon la fecha en `verified`. Las filas sin `verified` (E001, E002, E005,
E006, E009, E010, E015, E059, E061, E062) son las que nadie ha vuelto a mirar.

Histórico: 62,6 % → 73 % → 81 % → 89 % (v3.10, 18 oct, en Render con
desbloqueador) → hoja refrescada y 66 % local sin desbloqueador (v4.0, 25 oct).
