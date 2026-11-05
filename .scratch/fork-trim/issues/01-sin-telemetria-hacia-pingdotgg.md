# 01: Sin telemetría hacia pingdotgg

**What to build:** Ningún componente (servidor, web, desktop, móvil) envía eventos de producto a `ingest.t3.codes`/PostHog ni trazas a Axiom. Se elimina el envío, no solo se apaga por defecto. La exportación OTLP que el propio Owner configure hacia su colector sigue funcionando. La documentación de usuario dice que no sale nada.

**Blocked by:** None (can start immediately)

**Status:** done

Plan: ../plan.md

- [x] No queda ningún destino de telemetría propiedad de pingdotgg en el código.
- [x] El OTLP configurable por el Owner sigue funcionando.
- [x] Test en la capa más baja que pruebe que no se envían eventos de producto.
- [x] `docs/user/telemetry.md` reescrito.
