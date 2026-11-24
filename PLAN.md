# PLAN.md · HAUL · 24 de noviembre de 2026

Tarea vigente (CLAUDE.md): **beta en manos de 15 testers el 10 de diciembre de
2026.** Terminada cuando 15 personas tienen acceso y han guardado su primer
producto. El plan anterior (7 nov: banco, AWIN, Claude, Atajo) está en
`.backups/2026-11-24-before-4-1-8/PLAN.md`; AWIN queda fuera de alcance hasta
el veredicto.

## Medir personas activas por semana (aprobado el 24 nov)

Haul no tiene cuentas. Cada tester recibe un enlace de invitación propio
(`/?i=código`); quién es cada código lo apunta Alejandro en sus notas, el
servidor solo ve el código. Quien llega sin invitación cuenta con un
identificador anónimo de su navegador.

| # | Paso | Estado |
|---|---|---|
| 1 | La app guarda el código y un identificador anónimo y los manda al guardar | Hecho y probado en local (4.1.8) |
| 2 | El servidor apunta cada guardado y la primera apertura de cada invitación | Hecho; `node test/beta.js`, 40 pruebas |
| 3 | Panel privado: `/api/beta/report?key=…&html=1` | Hecho; visto en el navegador |
| 4 | El código sobrevive al «Añadir a pantalla de inicio» del iPhone | Construido; **falta la prueba en el iPhone** |
| 5 | Lecturas fallidas por tienda, para los tres fallos del domingo | Hecho |
| 6 | Subir la 4.1.8, comprobar `/api/health` y un guardado real en Render | **Pendiente (subida de Alejandro)** |

## Lo que queda hasta el 10 de diciembre, en orden

1. **Alejandro sube la 4.1.8** desde `~/Desktop/haul-v4.0-para-github`.
   Comprobación: `/api/health` dice 4.1.8.
2. **Código de prueba propio**: `/api/beta/invites/new?key=…&test=1`. Alejandro
   abre ese enlace en su iPhone (Safari), instala el icono desde ahí, guarda
   un producto desde el icono y mira el panel. Si el guardado no sale bajo su
   código, el paso 4 falla: plan B, pedir a los testers que usen «Tengo un
   código» al instalar el icono.
3. **15 invitaciones**: `/api/beta/invites/new?key=…&n=15`. Alejandro apunta
   código → persona en sus notas.
4. **Los tres primeros enlaces, el mismo día** en que el paso 2 sale bien. Al
   invitar: decir que la beta registra si se guardan productos, sin nombres.
5. **Los doce restantes** antes del 10 de diciembre. La tarea se cierra cuando
   el panel dice 15 con acceso y 15 con primer producto.

## Decisiones

- Semana de lunes a domingo, hora de Madrid. Semana 1 = 14–20 dic; semana 8
  (la del veredicto) = 1–7 feb de 2027.
- El uso de Alejandro no cuenta: va con un código de prueba.
- Si un tester reenvía su enlace, los dos cuentan como una persona.
- Sin nombres ni IPs en el servidor.

## Fuera de alcance hasta el veredicto (CLAUDE.md)

Afiliación (AWIN incluido), anti-bot de Zara / Amazon / Temu / AliExpress,
cambios de estética, app nativa, precios por región.
