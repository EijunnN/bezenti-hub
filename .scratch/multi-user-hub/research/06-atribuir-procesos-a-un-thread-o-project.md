# 06 — Atribuir procesos a un Thread o Project

Ticket: `../issues/06-atribuir-procesos-a-un-thread-o-project.md`. Fuente primaria: este repo. Hechos y opciones, sin decisión.

## 1. Cómo descubre procesos el monitor hoy

- El monitor nativo en Rust (`native/resource-monitor/src/main.rs`) recorre **toda** la tabla de procesos del SO en cada muestra (`refresh_processes_specifics(ProcessesToUpdate::All, …)`, main.rs:416-420) y de ahí saca `(pid, ppid, startTime)` (main.rs:423-432).
- Las raíces son `rootPid` (el servidor) más los `externalProcesses` (main.rs:448-452; contrato `ResourceMonitorConfigureCommand` / `SetExternalProcesses`, `packages/contracts/src/resourceTelemetry.ts:90-105`). Hoy el único proceso externo que se registra es el PID de Electron (`apps/server/src/resourceTelemetry/ResourceTelemetry.ts:158-165`).
- `select_tracked_pids` hace un BFS de descendientes desde las raíces y descarta hijos con `startTime` anterior al del padre, para no seguir PIDs reciclados (main.rs:605-643). En Linux/macOS los detalles caros (cmdline, memoria) solo se piden para los PIDs seleccionados (`TWO_STAGE_PROCESS_REFRESH`, main.rs:24, 454-470).
- El contrato ya tiene identidad estable `pid + startTimeMs` (resourceTelemetry.ts:49-53) y cada muestra incluye `ppid` (resourceTelemetry.ts:72-88). La identidad incluye el start time porque el SO recicla PIDs (`docs/internals/resource-telemetry.md:38-41`).
- La categoría se asigna en `Model.ts`: `server`, `resource-monitor`, `electron-*` o `server-child` (`apps/server/src/resourceTelemetry/Model.ts:503-515`). **`provider-root` y `terminal-root` están en el contrato (resourceTelemetry.ts:29-30) pero ningún código del servidor las asigna**; solo se leen en filtros (`apps/server/src/diagnostics/ProcessDiagnostics.ts:51-54`, `ProcessResourceMonitor.ts:22-29`, web `ResourceTelemetryDiagnostics.tsx:110-112`).
- Diagnóstico de procesos (`ServerProcessDiagnosticsEntry`, `packages/contracts/src/server.ts:431-443`) expone pid, ppid, cpu, rss, command, depth, childPids: un árbol, sin `threadId`/`projectId`.

Conclusión: el monitor **ya** es "raíces + árbol de descendientes". Añadir raíces por thread es extender un mecanismo existente, no inventarlo.

## 2. Por qué los grupos de métricas excluyen threads

`docs/internals/resource-telemetry.md:15-19`: los grupos de la exportación OTLP son "un conjunto fijo nombrado por los hijos directos del servidor, nunca IDs de proceso ni threads, para que el número de series quede acotado mientras los agentes van y vienen". Repetido en `ProcessGroupMetrics.ts:27-28`; los grupos salen de regex sobre el nombre del hijo directo (`codex`, `claude`, `terminal`, `browser`…, ProcessGroupMetrics.ts:29-55, 63-93).

El motivo es **cardinalidad de series en OTLP**, no imposibilidad técnica. Una vista en la app por thread (no exportada como series) no choca con esa regla; exportar `threadId` como atributo de métrica sí la rompería.

## 3. Sitios de spawn y si conocen threadId/projectId

| Proceso                             | Dónde                                                                                     | ¿threadId en el spawn?                                                  | Notas                                                                                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude CLI                          | `orchestration-v2/Adapters/ClaudeAdapterV2.ts:1190-1210`                                  | Sí (`input.threadId`)                                                   | Scope systemd **propio** del thread; inyecta `T3CODE_THREAD_ID` en el env. Si el entry es un script (.js) no se envuelve (1200-1203).                                              |
| Codex app-server                    | `CodexAdapterV2.ts:1450-1476`                                                             | Sí, pero `shared: true`                                                 | "Un app-server sirve muchos threads": el id va en la config de shell por thread, no en el env del proceso (CodexAdapterV2.ts:1407-1409). La raíz **no** es atribuible a un thread. |
| ACP (Cursor, OpenCode, Kiro, Grok…) | `packages/provider-acp/src/server/AcpSessionRuntime.ts:1417-1427`, `adapter.ts:6772-6791` | Sí, vía `AgentScopeThreadId` (puede ser `null`)                         | Algunos van por `linuxCgroupLease` en vez de scope (AcpSessionRuntime.ts:1419).                                                                                                    |
| Sesiones multi-thread               | `ProviderSessionManager.ts:2374-2380`                                                     | —                                                                       | `supportsMultipleProviderThreads` + `attachedThreadIds`: una sesión puede servir a varios threads.                                                                                 |
| Terminales (PTY)                    | `terminal/Manager.ts:2366-2381`                                                           | Sí: sesión indexada por `(threadId, terminalId)` (Manager.ts:1294-1295) | Scope **sin** threadId y `survivesRestart: true`.                                                                                                                                  |
| Navegador de preview (Chrome)       | `preview/ServerBrowser.ts:499`                                                            | No                                                                      | Un Chrome compartido; las pestañas sí se indexan por `threadId+tabId` (ServerBrowser.ts:363).                                                                                      |
| Dev servers lanzados por el agente  | heredan env del agente                                                                    | Sí, vía `T3CODE_THREAD_ID`                                              | Ver §4.                                                                                                                                                                            |
| git / checkpoints                   | `vcs/VcsProcess.ts:199-210`                                                               | No                                                                      | Procesos cortos; el contexto de thread existe en el llamador (effect worker), no en el spawner.                                                                                    |

`projectId` nunca se pasa al spawn, pero se deriva: cada thread tiene `projectId` (`packages/contracts/src/orchestrationV2.ts:444-447`, `2072-2075`). Atribuir a thread ⇒ atribuir a project es una búsqueda.

## 4. Mecanismos de atribución que ya existen

1. **systemd scopes por thread (solo Linux).** `apps/server/src/process/agentScope.ts`: cada agente se lanza en `t3code-<name>-<uuid>.scope` (agentScope.ts:386-421) y se guarda `scopeByThread` (agentScope.ts:219, máx. 500 threads, :98). `forceStopThread` mata el scope entero por `cgroup.kill` (agentScope.ts:344-376; llamado en `ThreadManagementService.ts:1144-1145`). Los scopes compartidos nunca se matan por thread (agentScope.ts:347; `packages/shared/src/AgentScope.ts:26-31`). En no-Linux `AgentScope` es no-op (agentScope.ts:102; `AgentScope.ts:46-54`). El cgroup ya lee `memory.events`/`cgroup.events` (agentScope.ts:221-241); leer `memory.current`/`cpu.stat` del mismo cgroup daría CPU/memoria exactas por thread sin recorrer árboles.
2. **Variable `T3CODE_THREAD_ID`.** "Los agentes se lanzan con ella y todo job que inician la hereda, así un servidor sigue atribuido aunque la shell que lo lanzó salga" (`preview/PortScanner.ts:66-70`). PortScanner la lee de `/proc/<pid>/environ` en Linux o `ps -E` en macOS, una vez por PID y cacheada (PortScanner.ts:359-385, 484-525). No funciona en Windows (PortScanner.ts:796-799: `hostPlatform !== "win32"`).
3. **Raíz PTY + recorrido de descendientes.** El Terminal Manager hace polling cada 1 s (Manager.ts:100) de la tabla de procesos, recorre descendientes del PID de la shell (Manager.ts:740-771) y registra esos PIDs con `(threadId, terminalId)` en PortDiscovery (Manager.ts:2696-2700; PortScanner.ts:955-973). La tabla puede venir del propio monitor nativo (`processTable`, Manager.ts:1478-1496), que solo pide pid/ppid/nombre sin cmdline ni memoria (main.rs:378-385; test main.rs:1035).

## 5. Opciones (sin decidir)

- **A. Raíces por thread + árbol.** Registrar `(pid,startTime) → threadId` en cada spawn atribuible y etiquetar descendientes con el BFS que ya existe (main.rs:605-643, o en TS sobre `ppid`). Funciona en todos los SO. Falla con: raíces compartidas (Codex app-server, sesiones multi-thread), procesos que se re-parentan a init (daemonizados, `setsid` + exit del padre: el propio AgentScope existe para reapear "setsid descendants outside its process group", `AgentScope.ts:20-23`), y Chrome compartido.
- **B. Leer `T3CODE_THREAD_ID` del entorno.** Cubre hijos de Codex compartido (lo inyecta por shell config) y procesos huérfanos. Coste: leer `environ` por PID (solo una vez, cacheable como hace PortScanner). Sin Windows; en macOS requiere `ps -E`.
- **C. cgroups (Linux+systemd).** Exacto y barato, y ya es la base de `forceStopThread`. Limitado a scopes propios: terminales no se asocian a thread y scopes `shared` no sirven.
- **D. Híbrido:** C cuando hay scope propio, A para terminales (raíz PTY conocida por thread), B para hijos de raíces compartidas; el resto queda como "compartido/sin atribuir".

Para un despliegue self-hosted (presumiblemente Linux con systemd) C+B cubriría la mayoría; Windows/macOS dependerían de A.

## 6. Restricciones de rendimiento documentadas

- El muestreo solo corre con suscriptores de diagnóstico en vivo; sin ellos, intervalo 0 y el servidor ocioso "nunca recorre la tabla de procesos" (`resource-telemetry.md:11-14`). La excepción OTLP es una muestra por minuto (`:14-17`; ProcessGroupMetrics.ts:12, 95-99).
- Historial acotado por edad, nº de snapshots, filas y bytes (`resource-telemetry.md:23-25`; main.rs:16-19: 3600 snapshots, 20 000 entradas, 64 MiB).
- Enumeración de tasks Linux desactivada por coste (`resource-telemetry.md:25-27`; main.rs:561-576).
- Sin base de datos de telemetría ni sondas de shell periódicas (`resource-telemetry.md:20-21`).
- AGENTS.md: rendimiento innegociable y cuidado con enviar demasiados datos por WebSocket.

Implicación: una vista "por thread" debería calcularse sobre la misma muestra (sin un segundo recorrido) y solo mientras alguien mira; añadir `threadId` por fila es barato, exportarlo a OTLP no.
