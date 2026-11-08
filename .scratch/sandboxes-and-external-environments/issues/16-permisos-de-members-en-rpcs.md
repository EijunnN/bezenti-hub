# 16: Permisos de los Members en las RPCs de la Installation

**What to build:** Toda sesión de navegador, también la de un Member, recibe el conjunto completo de scopes estándar (`AuthStandardClientScopes` en `EnvironmentAuth.ts`: `settings:write`, `diagnostics:read`, `providers:manage`, `environment:maintain`, `terminal:operate`…), y ninguna RPC de la Installation comprueba que quien llama sea el Owner. Las entradas `unscoped` de `RpcSpaceAccess.ts` (INSTALLATION, PROVIDERS, DEVICES) se justifican con «lo protegen los scopes», que no protege nada para un Member. Encontrado en la última review del 03/09 (commit `3e17e2057c`); existía antes.

**Blocked by:** 03, 09.

**Status:** done

- [x] Un tipo de acceso «solo Owner» (`installation`: rechaza si `!principal.isOwner`) para: `serverGetProcessDiagnostics`, `serverSignalProcess` (un Member puede ver y matar procesos de agentes de otros Spaces), `serverGetTraceDiagnostics`, `serverPrepareTriage` (trazas con rutas e ids de Threads de todos los Spaces), `serverUpdateSettings`, `serverUpdateProvider`, `providerAuth*`, `deviceConfigure`, `deviceAction`. Revisar una a una el resto de entradas `unscoped` y dejar `unscoped` solo lo realmente por sesión (keybindings, probe, config, lifecycle). Decidir si los scopes de un Member deben reducirse en el propio login.
- [x] `sourceControlCloneRepository` y `projectCloneStart`: `destinationPath` debe estar dentro de una carpeta donde el User puede trabajar (o limitarse a la carpeta gestionada de Projects).
- [x] `agentSessionsScan`: filtrar candidatos cuyo `path`/`projectId` el User no puede leer.
- [x] `subscribeProjectClones`: solo los clones que inició el User o de Spaces que ve; nunca enviar `remoteUrl` con credenciales.
- [x] `attachmentsDelete`: registrar quién subió el adjunto pendiente y comprobarlo.
- [x] Tests red-first en `RpcAuthorization.test.ts` / testkit con un Member; comprobar que Settings sigue funcionando para el Owner y que la UI oculta o explica lo que un Member ya no puede hacer.

**Hecho:** acceso `installation` en `RpcSpaceAccess` (lista `INSTALLATION_RPC_METHODS` en contracts; también keybindings, que son un fichero de toda la Installation, y el sign-in de source control del Hub). Decisión sobre scopes: sí se reducen, pero no solo en el login: toda sesión de un User que no es el Owner se lee sin `AuthInstallationScopes` (`heldByUser`, también sesiones antiguas, tokens y tickets); el login de un Member ya la emite sin ellos y su pairing link/aprobación MCP no los pide. Así la UI, que oculta por scopes, cuadra; el rechazo de verdad es el de la RPC. Docs: `docs/internals/environment-auth.md` «The Installation as a whole is the Owner's». Tras la review: las herramientas MCP pasan por `authorizeRpcCall` (`mcp/rpcAccess.ts`) y `t3_project_clone` comprueba la carpeta destino. Lo que queda de otras puertas (HTTP, resto de MCP) está en el ticket 17. Pendiente fuera de alcance: los settings guardados una vez para todo el Hub (favoritos de modelos, acciones de Project) quedan del Owner hasta que sean por User.
