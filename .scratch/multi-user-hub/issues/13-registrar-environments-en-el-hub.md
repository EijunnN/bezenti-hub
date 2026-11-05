# Registrar Environments en el Hub

Type: grilling
Label: wayfinder:grilling
Status: resolved
Blocked by: 08, 10
Map: ../map.md

## Question

¿Cómo se une un Environment al Hub (SSH gestionado, token de alta…), quién puede añadir uno (¿un usuario su propia laptop? ¿la VPS de un cliente?), y qué Organizaciones o usuarios pueden usar cada Environment?

## Answer

Resuelto por grilling con el Owner (2026-11-04). Término nuevo en `GLOSSARY.md`: External environment.

1. Dos tipos de Environment: Sandboxes (gestionados por el Hub en su máquina, uno por Space) y External environments (cualquier otra máquina con un servidor T3 registrado en el Hub).
2. Registra máquinas el Owner siempre; un User solo con el Installation permission «registrar mis propios Environments».
3. Dos modos: personal (solo trabaja en él quien lo registró, en cualquiera de sus Spaces) o dedicado a un Space (lo usan todos sus Members).
4. Alta: en PC o laptop, `t3 join <url del Hub>` una sola vez, confirmado en el Hub sin códigos; en otra VPS, opcionalmente instalación por SSH desde el Hub. Siempre con conexión saliente de la máquina hacia el Hub (sin abrir puertos).
5. IA y secretos llegan del Hub: AI accounts por el AI gateway y Vaults al arrancar; no hay credenciales que copiar en cada máquina.
6. Los External environments personales corren en nativo; los dedicados a un Space usan el contenedor e imagen del Sandbox.
7. El Hub muestra el estado de cada Environment. Si uno se desconecta con un Thread en marcha, el Thread se pausa y se reanuda al volver. Lo quita el Owner o quien lo registró, y se revocan sus credenciales.
8. Un Thread arranca por defecto en el Sandbox de su Space; cada Project puede tener un Environment preferido; el selector muestra los Environments que el User puede usar en ese Space.
