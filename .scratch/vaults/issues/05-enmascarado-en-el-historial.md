# 05: Enmascarado `[NOMBRE]` en el historial

**What to build:** Un servicio único, `SecretMasker`, sustituye cada valor del conjunto efectivo de un Thread (literal, URL-encoded y base64) por `[NOMBRE]` en todo lo que el Hub guarda o muestra: eventos del provider, salida de terminal, diffs, lecturas de archivos, resúmenes de traspaso, títulos, logs y spans. Ver spec, «Enmascarado».

**Blocked by:** 04.

**Status:** done

- [x] `SecretMasker` por Thread, alimentado por `EffectiveVaults`; conserva los valores anteriores de un secreto rotado durante la vida del Thread.
- [x] Se aplica en el Hub antes de proyectar o guardar los eventos que llegan del ejecutor (mensajes, razonamiento, llamadas y resultados de herramientas).
- [x] Salida de terminal: antes de guardarla y antes de enviarla a los clientes, también a mitad de un trozo (un valor partido entre dos frames sigue enmascarado).
- [x] Diffs de checkpoints, `files.read` mostrado al cliente, resúmenes de traspaso (spec 2, ticket 09) y títulos generados.
- [x] Filtro de logs y spans OTLP (`serverLogger.ts`, `observability/`) con los valores conocidos, en el Hub y en el agente joined.
- [x] Umbral de longitud mínima según la pregunta abierta 3 del spec.
- [x] Red-first: el agente hace `echo $NOMBRE`; el evento guardado, la proyección, la salida de terminal enviada al cliente y el diff de un archivo que lo contiene muestran `[NOMBRE]`; el valor no está en `state.sqlite` ni en logs.
- [x] Puertas que nombra este ticket: todas las que entregan historial al cliente (WS de orquestación, HttpApi de historial, rutas de invitado `guest/http.ts`, herramientas MCP que leen Threads como `t3_thread_wait`). Comprobar que todas leen ya del historial enmascarado y no de una copia sin pasar por el masker.
- [x] Tests en el testkit y tests unitarios del masker (codificaciones, trozos partidos, valores solapados, rotación).
- [x] Prueba real: Thread de Acme con un secreto; el agente lo imprime y lo escribe en un archivo; el chat, la terminal y el diff muestran `[NOMBRE]` en web; tras recargar sigue igual.

**Hecho** (rama `impl/vlt-05`, migración 116 `thread_secret_values`):

- Una regla, `@t3tools/shared/secretMasking` (literal, cadena JSON, URL-encoded, base64 en las tres alineaciones; valores de menos de 6 caracteres nunca; valores solapados en un solo `[NOMBRE]`), y un servicio, `vaults/SecretMasker.ts`: por Thread raíz, lo que recibieron sus procesos (`SecretDelivery.resolve` llama a `remember` antes de entregar; ids y nombres en `thread_secret_values`) más el conjunto efectivo de su dueño. Un Thread aún sin proyectar (su primer mensaje y su título) usa todos los valores de los Vaults. Un valor rotado o borrado sigue enmascarado: `Vaults` no borra un valor que un Thread vivo guarda; el arranque limpia los de Threads que ya no existen.
- Dónde: `EventSink` (todo método que escribe `events`, vía `maskingEventWrites`), `CommandOutputHub`, `ThreadWorkspace` (terminal: snapshots y frames, con un valor partido entre frames retenido y enmascarado entero; `files.read`; `search.contents` descarta coincidencias en líneas con un valor), `CheckpointDiffQuery`, `ThreadMoveService.storeHandoff`, diffs de review en `ws.ts`, logs (`serverLogger`), spans y archivo de trazas (`observability`), `events.log` del provider y el historial de terminal en disco, en el Hub y en el agente joined (`EnvironmentAgent` aprende los valores de `secretEnv`).
- Inventario: `vaults/MaskedPaths.ts` + `MaskedPaths.test.ts` (cada operación del executor wire y stream, cada escritor de tablas `orchestration_v2_*`, cada puerta de historial; falla si se añade uno sin línea o si una línea nombra un archivo que ya no enmascara). Puertas de historial (WS, HttpApi, `guest/http.ts`, MCP de Threads) leen del almacén enmascarado; ninguna lee un stream vivo del provider.
- Tests: `HubWithEnvironments.secretMasking.test.ts` (4, rojos sin el masker), `SecretMasker.test.ts` (5), `MaskedPaths.test.ts` (5), `secretMasking.test.ts` (8), 1 en `serverLogger.test.ts`. Docs: `docs/internals/secrets.md`, «Masking».
- Prueba real (`makita-livepass-s5-05`, Podman): todo PASS. Chat, título, terminal y diff muestran `[ACME_TOKEN]` en web y tras recargar; el archivo del Sandbox guarda el valor real; el valor no está en el log ni en ningún archivo del estado del Hub (`statev2.sqlite` incluido).
- Riesgos: el editor de archivos del cliente que muestra `[NOMBRE]` lo escribe de vuelta al guardar; el historial anterior a este ticket queda como estaba; previews proxied y mensajes de error de RPC no se enmascaran; las anotaciones de logs no se reescriben; el repo Git del Hub guarda los checkpoints tal cual (comprimidos).
