# 17: Una autorización para todas las puertas del Hub

**What to build:** El ticket 16 creó una comprobación por operación (`authorizeRpcCall`: scopes y luego `RpcSpaceAccess`) que usan el WebSocket y algunas herramientas MCP. Una review de inventario (plan @f07893bdf6) recorrió todas las puertas del Hub: ~95 endpoints HttpApi y ~10 rutas propias (0 usan la comprobación común), 69 herramientas MCP (4 la usan, ~57 con controles propios, ~8 sin control de Space), ~30 caminos con Environment credential (bien en general) y los trabajos en segundo plano. Este ticket cierra los huecos de raíz: toda puerta decide con la misma regla que su RPC gemela, y las raíces de carpeta en las que se fían los controles dejan de ser lo que diga el cliente.

**Blocked by:** 16.

**Status:** done

Raíces de carpeta (lo más grave; los controles de carpeta se fían de ellas):

- [x] `ProjectService.ts:441`: `workspaceRoot` al crear/editar un Project (WS, `POST /api/projects/mutate`, MCP) acepta cualquier carpeta existente, incluso `/`. Esa raíz pasa a valer en `mayUseDirectory`/`mayReadDirectory` y abre lectura de la base del Hub, secretos y checkouts de otros Spaces, y git en repos ajenos. Para quien no es el Owner: solo carpetas nuevas dentro de la carpeta de Projects del Hub (las mismas reglas que el destino de un clon), nunca dentro de la raíz de otro Project; el Owner puede elegir cualquiera.
- [x] `Orchestrator.ts:3266`: `worktreePath` en `thread.metadata.update` (y `thread.create` en el Hub machine) no se valida y también cuenta como raíz. Solo rutas que el Hub creó para ese Thread o que están dentro de la raíz del Project.

Archivos servidos fuera de `RpcSpaceAccess`:

- [x] `ws.ts:3004` `assets.createUrl` → `GET /api/assets/*`: `media-file` con ruta absoluta y `draft-workspace-file` con cualquier `cwd` no comprueban carpeta; un Member descarga `state.sqlite`, secretos o claves SSH del Hub. Aplicar `localWorkspaceTargets` + `mayReadDirectory`. Actualizar `docs/internals/environment-auth.md` («The environment is the filesystem boundary» ya no vale en multi-user).
- [x] MCP `html_preview`/`html_render` (`HtmlRender.ts:158`): imágenes/SVG con ruta absoluta de cualquier parte del Hub.
- [x] `orchestration.getWorkflowScript` (`workflowScriptQuery.ts:5`): `scriptPath` no atado al Thread.

Rutas HTTP con control propio:

- [x] `/api/preview-stream/*` (`ServerBrowserStream.ts:73`): sin comprobación de Thread (ni `claimWork`); ids de pestaña predecibles. Un Member ve y maneja el Chromium de otro, con sus cookies. Misma regla que `preview.open`; ids aleatorios. Comprobar también si los perfiles/cookies de ServerBrowser se comparten entre Users (`ServerBrowser.ts:494, 1500-1570`).
- [x] `/api/device-hub/*` (`DeviceHubProxy.ts:225`): las rutas que no son `/helper/<id>/` no atan el dispositivo; se reenvían parámetros arbitrarios.
- [x] `pullRequests.*` y `POST /api/pull-requests/diff` (`PullRequestService.ts:973`): el `repository` pedido sustituye al del Project y se usa la credencial de source control del Hub; un Guest/Member hace merge o lee PRs de repos privados de otro Space. El repositorio debe ser el del Project; acciones que cambian algo requieren Role de trabajo.
- [x] `POST /api/observability/v1/traces` (`http.ts:342`): cualquier sesión escribe en el colector de trazas de la Installation. Solo Owner o la propia sesión del cliente, con límite.

Herramientas MCP (pasar todas por la comprobación común con el nombre de su RPC gemela, o por la misma regla de visibilidad):

- [x] `list_scheduled_tasks` (`OrchestratorMcpService.ts:1931`) sin filtrar, con `webhookUrl`.
- [x] `read_pull_request_guide`/`write_pull_request_guides`/`list_thread_pull_requests` (`pullRequests/handlers.ts:304`) sobre Projects ocultos.
- [x] `t3_thread_wait`/`t3_thread_interrupt` (`OrchestratorMcpService.ts:1196`): estado de Threads ocultos.
- [x] Credencial de agente sin `userId` (`ProviderSessionManager.ts:472`, `orElseSucceed(undefined)`): falla abierta y actúa como el Owner. Debe fallar cerrada.
- [x] Tokens MCP por Thread dentro de un Sandbox compartido (`McpSessionRegistry.ts:106`): limitar su alcance al Space del Thread en máquinas atadas a un Space.
- [x] Revisar que `commandAccess` cubre todo comando que despachan las herramientas MCP.

Environments y trabajos en segundo plano:

- [x] `/api/git` upload-pack (`gitRoute.ts:318`): con protocolo v2, `hideRefs` no limita qué objetos se piden. Forzar v0 o filtrar.
- [x] `environment.use` solo se comprueba al colocar (`EnvironmentRegistry.ts:1395`); al reanudar sin actor en una máquina personal cuyo dueño ya no está en el Space, debe dejar de ejecutarse allí.
- [x] Comprobar si quitar a un User revoca sus sesiones MCP OAuth (`EnvironmentAuth.ts:1767`).

Criterio de cierre:

- [x] Un test de inventario que enumera rutas HTTP y herramientas MCP (como el que ya obliga a que toda RPC tenga entrada en `RPC_SPACE_ACCESS`) y falla si una puerta nueva no declara su regla.
- [x] Red-first para cada hueco, con Owner, Admin, Member y Guest.

**Hecho:** raíces de carpeta desde los registros del Hub (`spaces/directoryRoots.ts`): `ProjectService.create/update` (todas las puertas) solo dejan a quien no es el Owner una carpeta nueva directamente en la carpeta de Projects sin Project que la contenga, o una que hizo el Hub (`workspaceRootFromHub`: Project con nombre, Scratch promovido), y nunca mover la raíz; el orquestador valida `worktreePath` en `thread.create`/`thread.metadata.update` del Hub machine (dentro del Project o worktree enlazado de su repositorio); `SpaceVisibility` ya no cuenta como raíz el `worktreePath` de Threads en otras máquinas. Puertas: `assets.createUrl` comprueba `mayReadDirectory` de host files, carpetas de borrador, favicon y medios de source control; `html_preview/render` solo incrustan imágenes legibles; `getWorkflowScript` solo scripts de los workflows del Thread; `/api/preview-stream` decide como `preview.list`/`preview.open` (`authorizeSessionAsRpc`, nuevo); `/api/device-hub` exige el dispositivo nombrado una sola vez y solo reenvía parámetros conocidos; Pull Requests solo al repositorio de un Project visible y los cambios requieren Role de trabajo (`workProject`); `/api/projects/mutate` y `/api/pull-requests/diff` usan la regla de su RPC; trazas solo del Owner, con límite de 4 MB. MCP: toda herramienta lleva el `RequestVisibility` de su llamante; `list_scheduled_tasks` filtra como el WS y el webhook solo al creador (`visibleScheduledTasks`); `t3_thread_wait/interrupt/send` y las herramientas de links de PR tratan un Thread oculto como inexistente; `t3_thread_launch` exige Project visible; credencial de agente sin Thread legible: ninguna (no la del Owner); en máquinas atadas a un Space la credencial solo ve ese Space (`spaceLimit`). `commandAccess`: todo comando sin entrada cae en `thread.continue` (solo el creador), así que todo lo que despacha MCP queda cubierto. Entornos: `/api/git` fuerza protocolo v0; una máquina personal no arranca trabajo si su dueño ya no está en el Space del Thread; quitar un User revoca sus sesiones MCP OAuth (ya era así; test añadido). Cierre: `auth/DoorRules.ts` + test (96 endpoints, 24 rutas, 69 herramientas). Pendiente: perfiles/cookies del navegador de previews se comparten entre Users (la puerta ya exige el Thread propio, pero `previewClearProfile` y los perfiles son de toda la Installation); ids de pestaña no aleatorios (irrelevante tras atarlos al Thread); filas antiguas con raíces malas se siguen fiando.

**Review (21 puntos):** raíces de carpeta con la regla de hoy en cada comprobación (`directoryRoots.isTrustedProjectRoot`/`projectWorktreeRoot` en `SpaceVisibility`): Projects de no-Owner fuera de la carpeta de Projects/Scratch, worktrees sin comprobar (Environment borrado, `thread.move` que conservó la ruta) y filas antiguas dejan de valer sin reescribirse; un Thread del Hub machine se comprueba también por su propia carpeta; worktrees enlazados solo dan la parte del Project (monorepos), nunca un repositorio que contiene las carpetas del Hub. `media-file` relativo con `..`/`~` se rechaza; iconos absolutos solo del Owner (escritura) y solo legibles (lectura); `html_render` lee por la ruta real; PRs solo por el Project nombrado; credencial limitada a un Space: lecturas con los derechos reales del User dentro y escrituras rechazadas fuera (`CommandActor.spaceLimit` en `authorizeItem`/`claimCreation`); `t3_thread_update` oculto = inexistente; claim de carpeta nueva bajo lock; cambio de raíz rechazado antes de mirar el disco; clonar como Project pide la regla de raíz; scripts de workflow de Threads descendientes visibles vía `ThreadManagementService.getWorkflowScript`; preview-stream falla cerrado; DoorRules carga las herramientas reales; OTLP por scope; un solo control en `list_thread_pull_requests`. Sin migración: la regla se aplica al leer.
