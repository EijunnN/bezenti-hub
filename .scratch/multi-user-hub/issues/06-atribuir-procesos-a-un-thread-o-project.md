# Atribuir procesos a un Thread o Project

Type: research
Label: wayfinder:research
Status: resolved
Blocked by: —
Map: ../map.md

## Question

¿Se pueden atribuir los procesos a un Thread o Project? Hoy la telemetría (`packages/contracts/src/resourceTelemetry.ts`, monitor nativo en Rust, `docs/internals/resource-telemetry.md`) agrupa por categoría sin `threadId`/`projectId`. Averiguar dónde se lanzan los procesos (provider subprocesses, terminales, previews), si se pueden etiquetar en el momento del spawn y heredar a los hijos, y el coste de rendimiento.

## Answer

Sí, es factible y gran parte de la base ya existe:

- El monitor Rust ya funciona como "raíces + BFS de descendientes" con identidad `pid+startTime`; hoy las raíces son solo el servidor y Electron. Las categorías `provider-root`/`terminal-root` existen en el contrato pero nadie las asigna.
- Los adapters de Claude, Codex y ACP, y las terminales, conocen `threadId` en el momento del spawn. `projectId` se saca del thread. Chrome de preview y git no lo conocen.
- Hay tres mecanismos de atribución ya en uso: systemd scopes por thread (solo Linux; los usa `forceStopThread` con `cgroup.kill`), la variable `T3CODE_THREAD_ID` que heredan los jobs del agente (la usa PortScanner), y el recorrido raíz PTY → descendientes por `(threadId, terminalId)` cada 1 s.
- Lo que no se puede atribuir: el Codex app-server y las sesiones multi-thread son compartidos, y Chrome también.
- Los grupos OTLP excluyen threads para acotar la cardinalidad de series. Esa regla no impide una vista por thread dentro de la app.
- Coste: solo muestrear con suscriptores en vivo y reutilizar la misma muestra, sin un segundo recorrido de la tabla de procesos.

Detalle y citas: [research/06-atribuir-procesos-a-un-thread-o-project.md](../research/06-atribuir-procesos-a-un-thread-o-project.md)
