# 05: Enmascarado `[NOMBRE]` en el historial

**What to build:** Un servicio único, `SecretMasker`, sustituye cada valor del conjunto efectivo de un Thread (literal, URL-encoded y base64) por `[NOMBRE]` en todo lo que el Hub guarda o muestra: eventos del provider, salida de terminal, diffs, lecturas de archivos, resúmenes de traspaso, títulos, logs y spans. Ver spec, «Enmascarado».

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] `SecretMasker` por Thread, alimentado por `EffectiveVaults`; conserva los valores anteriores de un secreto rotado durante la vida del Thread.
- [ ] Se aplica en el Hub antes de proyectar o guardar los eventos que llegan del ejecutor (mensajes, razonamiento, llamadas y resultados de herramientas).
- [ ] Salida de terminal: antes de guardarla y antes de enviarla a los clientes, también a mitad de un trozo (un valor partido entre dos frames sigue enmascarado).
- [ ] Diffs de checkpoints, `files.read` mostrado al cliente, resúmenes de traspaso (spec 2, ticket 09) y títulos generados.
- [ ] Filtro de logs y spans OTLP (`serverLogger.ts`, `observability/`) con los valores conocidos, en el Hub y en el agente joined.
- [ ] Umbral de longitud mínima según la pregunta abierta 3 del spec.
- [ ] Red-first: el agente hace `echo $NOMBRE`; el evento guardado, la proyección, la salida de terminal enviada al cliente y el diff de un archivo que lo contiene muestran `[NOMBRE]`; el valor no está en `state.sqlite` ni en logs.
- [ ] Puertas que nombra este ticket: todas las que entregan historial al cliente (WS de orquestación, HttpApi de historial, rutas de invitado `guest/http.ts`, herramientas MCP que leen Threads como `t3_thread_wait`). Comprobar que todas leen ya del historial enmascarado y no de una copia sin pasar por el masker.
- [ ] Tests en el testkit y tests unitarios del masker (codificaciones, trozos partidos, valores solapados, rotación).
- [ ] Prueba real: Thread de Acme con un secreto; el agente lo imprime y lo escribe en un archivo; el chat, la terminal y el diff muestran `[NOMBRE]` en web; tras recargar sigue igual.
