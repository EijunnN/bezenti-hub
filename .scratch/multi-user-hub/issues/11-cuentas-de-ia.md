# Cuentas de IA

Type: grilling
Label: wayfinder:grilling
Status: resolved
Blocked by: 01, 08
Map: ../map.md

## Question

¿De quién son las cuentas de IA (del Owner, de una Organización, de un usuario), cómo se comparten, cómo elige un Thread su cuenta y modelo, se puede cambiar a mitad de Thread, y cómo conviven suscripciones de CLI y claves de API?

Incluye: ¿el Hub actúa también como **pasarela de IA**, de modo que una CLI local (Claude Code, Codex) configurada con la base URL del Hub en su `settings.json`/`config.toml` use las cuentas de IA de la Installation? (Surgió en «Inicio de sesión en el Hub».)

## Answer

Resuelto por grilling con el Owner (2026-11-04). ADR: `docs/adr/0005-shared-subscriptions-through-hub-ai-gateway.md`. Términos nuevos en `GLOSSARY.md`: AI account, AI gateway. Contexto aclarado: la Installation es el Owner y su equipo; no hay clientes ni venta.

1. Solo el Owner registra AI accounts (suscripciones y API keys). No existen cuentas personales de los Users.
2. El Owner permite cada AI account a Spaces y/o a Users concretos; en un Thread se puede usar la unión de lo permitido al Space y al User.
3. Compartir las suscripciones del Owner con el equipo: permitido, con el riesgo de suspensión por ToS aceptado (ADR 0005). Planes por asiento o API keys quedan como alternativa conforme.
4. El Hub ejecuta CLIProxyAPI como AI gateway: las credenciales reales nunca entran en un Sandbox; cada Thread recibe una clave de la gateway limitada a sus AI accounts permitidas; CLIs locales del equipo pueden apuntar a la URL del Hub con su propia clave.
5. Prioridad única y global (la de CLIProxyAPI); suscripciones del mismo proveedor forman pool. Un Thread nuevo arranca con la AI account permitida de mayor prioridad.
6. El User puede cambiar a cualquier AI account permitida, también a mitad de Thread; entre proveedores hay traspaso de contexto (portable handoff).
7. Sin cupo: CLIProxyAPI salta solo dentro del mismo modelo/proveedor; entre proveedores cambia el User. El Thread muestra siempre la AI account en uso.
8. Un turno solo consume AI accounts permitidas a ese User en ese Space.

Para el spec: qué hacer con providers sin base URL propia (Cursor, Antigravity…), y cómo el Hub limita las credenciales de cada clave de la gateway.
