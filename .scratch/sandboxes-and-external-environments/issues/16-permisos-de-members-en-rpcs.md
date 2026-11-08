# 16: Permisos de los Members en las RPCs de la Installation

**What to build:** Toda sesión de navegador, también la de un Member, recibe el conjunto completo de scopes estándar (`AuthStandardClientScopes` en `EnvironmentAuth.ts`: `settings:write`, `diagnostics:read`, `providers:manage`, `environment:maintain`, `terminal:operate`…), y ninguna RPC de la Installation comprueba que quien llama sea el Owner. Las entradas `unscoped` de `RpcSpaceAccess.ts` (INSTALLATION, PROVIDERS, DEVICES) se justifican con «lo protegen los scopes», que no protege nada para un Member. Encontrado en la última review del 03/09 (commit `3e17e2057c`); existía antes.

**Blocked by:** 03, 09.

**Status:** ready-for-agent

- [ ] Un tipo de acceso «solo Owner» (`installation`: rechaza si `!principal.isOwner`) para: `serverGetProcessDiagnostics`, `serverSignalProcess` (un Member puede ver y matar procesos de agentes de otros Spaces), `serverGetTraceDiagnostics`, `serverPrepareTriage` (trazas con rutas e ids de Threads de todos los Spaces), `serverUpdateSettings`, `serverUpdateProvider`, `providerAuth*`, `deviceConfigure`, `deviceAction`. Revisar una a una el resto de entradas `unscoped` y dejar `unscoped` solo lo realmente por sesión (keybindings, probe, config, lifecycle). Decidir si los scopes de un Member deben reducirse en el propio login.
- [ ] `sourceControlCloneRepository` y `projectCloneStart`: `destinationPath` debe estar dentro de una carpeta donde el User puede trabajar (o limitarse a la carpeta gestionada de Projects).
- [ ] `agentSessionsScan`: filtrar candidatos cuyo `path`/`projectId` el User no puede leer.
- [ ] `subscribeProjectClones`: solo los clones que inició el User o de Spaces que ve; nunca enviar `remoteUrl` con credenciales.
- [ ] `attachmentsDelete`: registrar quién subió el adjunto pendiente y comprobarlo.
- [ ] Tests red-first en `RpcAuthorization.test.ts` / testkit con un Member; comprobar que Settings sigue funcionando para el Owner y que la UI oculta o explica lo que un Member ya no puede hacer.
