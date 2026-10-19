# Banco de pruebas · estado (18 oct 2026)

**89/100 perfectos** (v3.10). Evolución: 62,6% → 73% → 81% → 89%.

Pendientes y causa (según el rastro):
- Etsy (2): el desbloqueador sí devuelve la ficha; Haul la descartaba como muro porque el texto menciona "captcha". Corregido en v3.11 (isWall).
- ASOS E054: cogía el precio de un producto de "combínalo con". Corregido en v3.11.
- Depop (2): Bright Data policy_20050 "target site requires special permission" → requiere KYC de Bright Data.
- Levi's E032: Bright Data reject_block (captcha) → candidato a Scraping Browser.
- About You (2): sirve la portada a cualquier visita automática, sin el producto → feed de AWIN o navegador remoto.
- Temu (2): precio bien o casi; sin foto ni título fiable; precios cambian a diario.
- Shein E016: inestable (a veces versión inglesa, a veces timeout).

Bright Data (respuesta de soporte, ticket #748684): cuenta sin KYC; saldo 0,01 $. Desde el 18 oct el desbloqueador casi no acierta (5 de 25), compatible con saldo agotado. Revisar facturación antes de la siguiente ronda.
