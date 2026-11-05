# 03 — Técnicas para continuar un Project en otro Environment

Ticket: `../issues/03-tecnicas-para-continuar-un-project-en-otro-environment.md`. Hechos y opciones; sin decisión.

## (a) Archivos

### Git (incluidos los checkpoints)

- **Qué es un checkpoint.** Un commit sin rama bajo `refs/t3/orchestration-v2/checkpoints/<base64url(sha256(scopeId)[:32])>/ordinal/<n>` (`apps/server/src/orchestration-v2/CheckpointService.ts:26`, `:148-158`). Se captura con un índice temporal (`GIT_INDEX_FILE`, `apps/server/src/vcs/GitVcsDriver.ts:900-920`) y `git add -A`, así que incluye archivos sin seguimiento que no estén ignorados (`GitVcsDriver.ts:1163-1180`). Después se ejecuta `commit-tree` con `HEAD` como padre y `update-ref` (`GitVcsDriver.ts:1258-1290`). La rama del usuario no recibe commits (`docs/internals/overview.md:88-91`).
- **Empujarlos se puede, pero hay que pedirlo.** `--all` y `--branches` solo empujan `refs/heads/`, y `push.default` no toca refs propias. Solo `--mirror` o un refspec explícito como `refs/t3/*:refs/t3/*` las empujan (https://git-scm.com/docs/git-push, secciones "--all", "--mirror", "<refspec>"). El refspec de fetch por defecto es `+refs/heads/*:refs/remotes/origin/*`. El otro lado necesita una línea `fetch =` adicional o un fetch explícito (https://git-scm.com/book/en/v2/Git-Internals-The-Refspec). Se puede fijar en `remote.<name>.push` / `fetch`.
- **Encaje y límites:**
  - El nombre de la ref sale del `scopeId`, un id de la proyección. Sin las filas `orchestration_v2_projection_checkpoints` / `_checkpoint_scopes` del Thread, la ref en el otro servidor es un commit huérfano y la UI no puede usarla para diff/restore (`apps/server/src/persistence/Migrations/055_OrchestrationV2.ts:246-277`).
  - El árbol puede contener trabajo en curso sin seguimiento. Empujarlo a un forge compartido lo publica.
  - Cada turno crea una ref, así que el volumen de refs y objetos crece con el Thread.
  - Un restore también tiene que coordinarse con la conversación del provider (`overview.md:89-91`).
- **Patrón más simple:** la rama de trabajo como capa compartida (commit + push y pull en el destino). Así trabaja hoy t3code: "Files are never copied; git is the only shared layer" (`research/00-t3code-baseline.md:46`). Lo que no esté committeado no viaja.

### Sincronización de archivos

| Herramienta   | Modelo                                                                                                                                                                                                                      | Conflictos                                                                                          | `.git`                                                                                                                                                                                                                                                                                                             | Encaje                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Mutagen**   | Continua, por ciclos disparados por cambios en el FS ("effective real-time"). Modos `two-way-safe` (por defecto), `two-way-resolved`, `one-way-safe` y `one-way-replica` (https://mutagen.io/documentation/synchronization) | En los modos `*-safe` se guardan en la sesión y se resuelven a mano                                 | Recomienda **no** sincronizar VCS (`ignore: vcs: true`). El índice guarda inodos y mtimes, el GC reempaqueta objetos, git no espera escrituras concurrentes y los hooks son un vector de RCE. Tener un `.git` por lado "is very clunky" (https://mutagen.io/documentation/synchronization/version-control-systems) | Bueno para un worktree "en vivo" entre dos máquinas con un solo dueño de `.git`. Choca con los checkpoints, que viven en `.git` |
| **Syncthing** | P2P continuo. Watcher que agrupa cambios cada 10 s (borrados +1 min) y escaneo completo cada hora. Bloques de 128 KiB a 16 MiB con hash SHA-256 (https://docs.syncthing.net/users/syncing.html)                             | Renombra la versión más antigua a `*.sync-conflict-<fecha>-<hora>-<id>` y la replica a todos (ídem) | Sin guía oficial en la FAQ (https://docs.syncthing.net/users/faq.html). Por la latencia y los conflictos por archivo es arriesgado con `.git`                                                                                                                                                                      | Sirve para carpetas tipo scratch. Arriesgado si dos agentes escriben a la vez                                                   |
| **rsync**     | Ejecución puntual con transferencia delta. `--delete` y `--checksum` para fiabilidad, `--filter`/`--exclude`/`-C` para filtrar (https://download.samba.org/pub/rsync/rsync.1)                                               | No tiene: el último en copiar gana                                                                  | Puede copiar `.git` entero (con sus refs `refs/t3/*`) si el origen está quieto                                                                                                                                                                                                                                     | Encaja con un "traspaso" explícito: parar el Thread, copiar y continuar. No sirve para trabajo concurrente                      |

**Cómo encaja con los checkpoints:**

- Solo git (push/fetch de la rama y de `refs/t3/*`) mueve los checkpoints de forma coherente.
- Mutagen y Syncthing, configurados como recomiendan (sin `.git`), mueven el árbol de trabajo pero no los checkpoints.
- rsync del `.git` completo los mueve, pero solo como copia en frío.

## (b) Qué es un Thread y si se puede exportar

### Estado en `statev2.sqlite` (servidor)

- **Log de eventos.** `orchestration_v2_events` contiene `sequence`, `event_id`, `command_id`, `thread_id`, `run_id`, `node_id`, `provider`, `event_type` y `payload_json` (`055_OrchestrationV2.ts:19-31`). Junto a él están `orchestration_v2_command_receipts` (`:41-49`) y el outbox de efectos (`Migrations/OrchestrationV2/Foundation.ts:102`).
- **El log no es la fuente de verdad.** "projections are the source of truth" (`overview.md:47`). `ProjectionMaintenance` borra los eventos de más de ~1 día, "so projections cannot be rebuilt from the log" (`overview.md:61-64`). Exportar solo el log **no** reconstruye un Thread antiguo.
- **Proyecciones por Thread** (`055_OrchestrationV2.ts:54-300`):
  - `projection_threads`: `project_id`, `title`, `default_provider`, `active_provider_thread_id`, más `payload_json`.
  - Ejecución: `runs`, `run_attempts`, `nodes`, `provider_sessions`, `provider_threads`, `provider_turns`, `runtime_requests`.
  - Contenido: `messages`, `plans`, `turn_items`.
  - `checkpoint_scopes` y `checkpoints`.
  - Traspasos de contexto: `context_handoffs` y `context_transfers`.
  - Fuera de ese rango: `subagents` (`Migrations/OrchestrationV2/Subagents.ts:8`), `provider_session_bindings` (`ProviderSessionBindings.ts:8`) y `turn_item_positions` (`Foundation.ts:123`).
- **Ids.**
  - En su mayoría son `prefijo-...-uuidv4` (`packages/provider-core/src/server/IdAllocator.ts:233-243`) o derivados deterministas de otros ids, como `run-thread-<threadId>-ordinal-<n>` (`IdAllocator.ts:269`). Es poco probable que colisionen entre servidores.
  - Los Threads importados de sesiones nativas derivan el id de `providerInstanceId` + el id nativo (`IdAllocator.ts:195-212`), y `providerInstanceId` es configuración local del Environment.
  - El Thread guarda `projectId`, `providerInstanceId`, `branch`, `worktreePath` y `activeProviderThreadId` (`packages/contracts/src/orchestrationV2.ts:446-458`). `projectId` y `worktreePath` son locales del Environment (`docs/internals/remote.md:13-15`).
- **Adjuntos.** Son archivos en `<stateDir>/attachments` (`apps/server/src/config.ts:149`), fuera de SQLite.

### Estado del provider (en la máquina)

- `provider_session_runtime.resumeCursor` es un JSON opaco por adapter (`apps/server/src/persistence/ProviderSessionRuntime.ts:29-39`). Para Claude es `{ resume: <sessionId> }`. Para Codex y Pi es el id nativo o la ruta del archivo (`apps/server/src/project/AgentSessionImporter.ts:272-288`).
- Ese cursor apunta a archivos locales:
  - Claude: JSONL en `$CLAUDE_CONFIG_DIR|~/.claude/projects/<dir>/` (`apps/server/src/project/AgentSessionScanner.ts:1143-1164`; `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:1093`).
  - Codex: `rollout-*.jsonl` en `$CODEX_HOME/sessions/AAAA/MM/DD/` (`AgentSessionScanner.ts:1196-1230`).
  - Pi: sus archivos de sesión (`docs/internals/providers.md:32-34`).
- Las carpetas de Claude dependen de la ruta (cwd). Ni t3code ni este informe verifican que copiar esos archivos a otra máquina, con otra cuenta o en otra ruta, permita reanudar la sesión de forma nativa. Es una incógnita.

### Opciones para transferir un Thread

1. **Snapshot de proyecciones + handoff portable (con precedente).** El importador V1→V2 crea primero eventos "shell" del Thread y luego importa el transcript de usuario y asistente bajo demanda (`docs/internals/legacy-orchestration-migration.md:3-8`). No traduce identidad de sesión, checkpoints, tool calls ni aprobaciones (`:22-24`). Al continuar, abre una sesión nueva del provider con un handoff de texto (`:28-31`).
   - Ventaja: no depende de archivos nativos ni de la cuenta.
   - Coste: el agente pierde el razonamiento, el estado de las tools y lo que quede fuera del presupuesto.
2. **Copia completa de filas + `resumeCursor` + archivos nativos + refs de checkpoint.** Es la máxima fidelidad, pero exige:
   - el mismo provider/cuenta;
   - reescribir `projectId`, `worktreePath` y `providerInstanceId`;
   - copiar adjuntos;
   - respetar los esquemas de eventos retenidos (`overview.md:75-77`).
     No existe RPC para esto: "Existing threads stay where they started" (`docs/user/remote-access.md:166`).
3. **No mover el Thread: acceso remoto.** Un Peer Link permite a los agentes leer threads y lanzar trabajo en otro Environment (`remote.md:72-77`, `:127-134`). El Thread sigue viviendo en su Environment de origen. Choca con la regla del fork de que un Project se pueda continuar desde varios Environments (GLOSSARY.md / ADRs).
4. **Un store central de Threads (Hub).** Los Environments solo ejecutan y el Hub guarda las proyecciones. Rompe el supuesto actual de que "the environment owns ... durable state" (`remote.md:3-5`). Esta opción no la documenta ninguna fuente; es una inferencia, no un hecho.

## (c) Qué hacen hoy las funciones entre Environments

- **Arrastrar un Thread de otro Environment** (no enlazado) al composer:
  - El cliente pide `GET /api/orchestration/threads/:threadId/transcript` al origen (`packages/contracts/src/environmentHttp.ts:701-704`).
  - El servidor devuelve `threadId`, `title`, `updatedAt` y los `visibleTurnItems` de la proyección. Falla si supera el límite de adjuntos (`apps/server/src/orchestration-v2/ThreadManagementService.ts:674-698`), que es de 50 MiB (`packages/contracts/src/chatAttachment.ts:17`).
  - El cliente lo convierte en un archivo `.jsonl` (cabecera + una fila por item) adjunto al mensaje del destino (`apps/web/src/lib/threadContextAttachment.ts:6-23`).
  - Es una foto fija: no copia mensajes posteriores ni el contenido de los adjuntos (`docs/user/composer.md:313-319`).
  - Es contexto para un Thread **nuevo o existente del destino**, no una migración.
- **Threads de una máquina enlazada** (Peer Link, beta): siguen siendo referencias que el agente lee **en esa máquina** (`composer.md:313-314`). `delegate_task` puede crear un Thread hijo en el Environment enlazado y seguirlo hasta que termina (`remote.md:127-134`).
- **Handoffs de contexto portables:** se usan al cambiar de provider, en reinicios portables y en forks que el provider no puede hacer de forma nativa (`docs/user/portable-handoffs.md:3-4`; `apps/server/src/orchestration-v2/CommandPolicy.ts:380-395`).
  - Es una selección con presupuesto (16k tokens por defecto, `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP`), no un resumen escrito por un agente (`portable-handoffs.md:17-18`, `:31-35`).
  - No copia el razonamiento, el estado de las tools ni los adjuntos (`:11-13`).
  - Incluye referencias al historial omitido, que el agente puede leer con una tool (`:15-17`).
  - Internamente cubre mensajes, comandos, archivos cambiados y checkpoints (solo el número de archivos) con un truncado por item (`docs/internals/context-handoffs.md:51-62`).
- **Importar sesiones nativas** (welcome): convierte JSONL de Claude, Codex y Pi de los últimos 30 días en Threads. Guarda el primer prompt y los mensajes más recientes, hasta 200, sin tools (`docs/user/welcome-wizard.md:76-92`). Siembra el `resumeCursor` para reanudar de forma nativa en **la misma máquina** (`AgentSessionImporter.ts:284-288`).
- **Borradores:** solo los borradores no enviados cambian de máquina (`research/00-t3code-baseline.md:44`).

## Trade-offs en una línea

- Git de rama: robusto y auditable, pero solo mueve lo committeado.
- Git + `refs/t3/*`: añade los checkpoints, pero no sirven sin las filas de proyección y pueden publicar trabajo en curso.
- Mutagen: un worktree en vivo, pero hay que excluir `.git` (y con ello los checkpoints).
- Syncthing: conflictos por archivo y latencia de ~10 s.
- rsync: fiel en frío, sin concurrencia.
- Thread por handoff: portable entre cuentas y máquinas, pero con pérdida.
- Thread por copia completa: alta fidelidad, pero acoplado a provider/cuenta/rutas y al esquema de eventos.
- Peer Link: sin copia, pero el Thread queda atado a su Environment.
