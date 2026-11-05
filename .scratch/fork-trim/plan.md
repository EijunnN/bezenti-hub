# Recorte del fork

Status: ready-for-agent
Decisión del Owner (2026-11-05): se mantienen todos los providers de t3code y las tres apps (web, desktop, móvil). Se quita lo que envía datos a pingdotgg, lo que actualiza desde upstream y lo que sustituye el Hub. ADR: `docs/adr/0007-no-upstream-services.md`.

Orden:

1. «Sin telemetría hacia pingdotgg» y «Sin auto-actualización desde upstream» (antes de desplegar nada, antes del ticket 04 de identidad).
2. «Quitar T3 Connect, infra/relay y apps/marketing» y «Enlaces al dominio propio» (antes del spec 2, Hub).
3. Managed policy: más adelante, cuando se decida.

## Not yet specified

- Notificaciones push móviles y actualizaciones remotas de Live Activity: desaparecen con el relay de T3 Connect hasta que exista una vía de push autoalojada.
