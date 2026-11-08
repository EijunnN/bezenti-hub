# 17: Una autorización para todas las puertas del Hub

**What to build:** El ticket 16 creó una comprobación por operación (`authorizeRpcCall`: scopes y luego `RpcSpaceAccess`) que usan el WebSocket y algunas herramientas MCP. Una review de inventario (plan @f07893bdf6) recorrió todas las puertas del Hub: ~95 endpoints HttpApi y ~10 rutas propias (0 usan la comprobación común), 69 herramientas MCP (4 la usan, ~57 con controles propios, ~8 sin control de Space), ~30 caminos con Environment credential (bien en general) y los trabajos en segundo plano. Este ticket cierra los huecos de raíz: toda puerta decide con la misma regla que su RPC gemela, y las raíces de carpeta en las que se fían los controles dejan de ser lo que diga el cliente.

**Blocked by:** 16.

**Status:** ready-for-agent

Raíces de carpeta (lo más grave; los controles de carpeta se fían de ellas):

- [ ] `ProjectService.ts:441`: `workspaceRoot` al crear/editar un Project (WS, `POST /api/projects/mutate`, MCP) acepta cualquier carpeta existente, incluso `/`. Esa raíz pasa a valer en `mayUseDirectory`/`mayReadDirectory` y abre lectura de la base del Hub, secretos y checkouts de otros Spaces, y git en repos ajenos. Para quien no es el Owner: solo carpetas nuevas dentro de la carpeta de Projects del Hub (las mismas reglas que el destino de un clon), nunca dentro de la raíz de otro Project; el Owner puede elegir cualquiera.
- [ ] `Orchestrator.ts:3266`: `worktreePath` en `thread.metadata.update` (y `thread.create` en el Hub machine) no se valida y también cuenta como raíz. Solo rutas que el Hub creó para ese Thread o que están dentro de la raíz del Project.

Archivos servidos fuera de `RpcSpaceAccess`:

- [ ] `ws.ts:3004` `assets.createUrl` → `GET /api/assets/*`: `media-file` con ruta absoluta y `draft-workspace-file` con cualquier `cwd` no comprueban carpeta; un Member descarga `state.sqlite`, secretos o claves SSH del Hub. Aplicar `localWorkspaceTargets` + `mayReadDirectory`. Actualizar `docs/internals/environment-auth.md` («The environment is the filesystem boundary» ya no vale en multi-user).
- [ ] MCP `html_preview`/`html_render` (`HtmlRender.ts:158`): imágenes/SVG con ruta absoluta de cualquier parte del Hub.
- [ ] `orchestration.getWorkflowScript` (`workflowScriptQuery.ts:5`): `scriptPath` no atado al Thread.

Rutas HTTP con control propio:

- [ ] `/api/preview-stream/*` (`ServerBrowserStream.ts:73`): sin comprobación de Thread (ni `claimWork`); ids de pestaña predecibles. Un Member ve y maneja el Chromium de otro, con sus cookies. Misma regla que `preview.open`; ids aleatorios. Comprobar también si los perfiles/cookies de ServerBrowser se comparten entre Users (`ServerBrowser.ts:494, 1500-1570`).
- [ ] `/api/device-hub/*` (`DeviceHubProxy.ts:225`): las rutas que no son `/helper/<id>/` no atan el dispositivo; se reenvían parámetros arbitrarios.
- [ ] `pullRequests.*` y `POST /api/pull-requests/diff` (`PullRequestService.ts:973`): el `repository` pedido sustituye al del Project y se usa la credencial de source control del Hub; un Guest/Member hace merge o lee PRs de repos privados de otro Space. El repositorio debe ser el del Project; acciones que cambian algo requieren Role de trabajo.
- [ ] `POST /api/observability/v1/traces` (`http.ts:342`): cualquier sesión escribe en el colector de trazas de la Installation. Solo Owner o la propia sesión del cliente, con límite.

Herramientas MCP (pasar todas por la comprobación común con el nombre de su RPC gemela, o por la misma regla de visibilidad):

- [ ] `list_scheduled_tasks` (`OrchestratorMcpService.ts:1931`) sin filtrar, con `webhookUrl`.
- [ ] `read_pull_request_guide`/`write_pull_request_guides`/`list_thread_pull_requests` (`pullRequests/handlers.ts:304`) sobre Projects ocultos.
- [ ] `t3_thread_wait`/`t3_thread_interrupt` (`OrchestratorMcpService.ts:1196`): estado de Threads ocultos.
- [ ] Credencial de agente sin `userId` (`ProviderSessionManager.ts:472`, `orElseSucceed(undefined)`): falla abierta y actúa como el Owner. Debe fallar cerrada.
- [ ] Tokens MCP por Thread dentro de un Sandbox compartido (`McpSessionRegistry.ts:106`): limitar su alcance al Space del Thread en máquinas atadas a un Space.
- [ ] Revisar que `commandAccess` cubre todo comando que despachan las herramientas MCP.

Environments y trabajos en segundo plano:

- [ ] `/api/git` upload-pack (`gitRoute.ts:318`): con protocolo v2, `hideRefs` no limita qué objetos se piden. Forzar v0 o filtrar.
- [ ] `environment.use` solo se comprueba al colocar (`EnvironmentRegistry.ts:1395`); al reanudar sin actor en una máquina personal cuyo dueño ya no está en el Space, debe dejar de ejecutarse allí.
- [ ] Comprobar si quitar a un User revoca sus sesiones MCP OAuth (`EnvironmentAuth.ts:1767`).

Criterio de cierre:

- [ ] Un test de inventario que enumera rutas HTTP y herramientas MCP (como el que ya obliga a que toda RPC tenga entrada en `RPC_SPACE_ACCESS`) y falla si una puerta nueva no declara su regla.
- [ ] Red-first para cada hueco, con Owner, Admin, Member y Guest.
