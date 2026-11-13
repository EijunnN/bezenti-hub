# 07: Cambio de Space de un Project y bajas

**What to build:** Mover un Project a otro Space (spec 3, ticket 12) avisa de qué Vaults pierde y después usa solo los del destino. Quitar una allowance, quitar un User o borrar una Organization deja de entregar sus secretos en el siguiente turno, terminal o script. Ver spec, «Cambio de Space de un Project» y «Bajas».

**Blocked by:** 04.

**Status:** done

- [x] `POST /api/projects/move-plan` añade `vaultsLost` (Vaults que el Project recibe por el origen y que el destino no tiene), calculado con `EffectiveVaults`.
- [x] Al mover, se borran las `project_vault_choices` que nombran Vaults no permitidos al destino, en la misma transacción que el cambio de Space.
- [x] Quitar un User (spec 1) borra sus allowances de User; borrar una Organization borra sus Vaults y valores (dentro del flujo de borrado del spec 1).
- [x] Red-first: tras mover un Project de Acme a Globex, un turno nuevo no recibe los Vaults de Acme, y `list_secret_names` y `vaults.threadEnvironment` tampoco los listan; tras quitar una allowance, la siguiente terminal no la recibe; tras borrar una Organization no queda ninguna fila ni valor suyo.
- [x] Puertas: HttpApi `projects.movePlan` (misma regla que hoy), WS de allowances. Sin puertas nuevas.
- [x] Web: el diálogo «Move to…» lista los Vaults que se pierden antes de «Stop Threads and move».
- [x] Tests en `HubWithEnvironments.projectMove.test.ts` y en el flujo de borrado de Organization.
- [x] Prueba real: mover un Project con un Vault de Acme a Globex; el diálogo lo avisa; un turno en el destino hace `printenv` y no lo tiene.

**Hecho** (rama `impl/vlt-07`, migración 115 `VaultReachLoss`):

- Una regla para las bajas: `vaults/VaultReachLoss.ts`. La entrega ya se recalcula en cada turno, terminal y script (`EffectiveVaults`/`VaultReach`), y los procesos vivos siguen la regla de huella del ticket 04 (la sesión del provider se reabre en el siguiente turno; la terminal abierta dice «Secrets changed»). `VaultReachLoss` borra las filas que nombran un alcance perdido: mover un Project (`keepProjectChoicesReaching`, dentro del commit del movimiento con el nuevo `EventSink.commitProjectCommand` `alsoCommit`), quitar una allowance de un Space o de un User (`Vaults.allow` pasa por aquí), quitar un User (`InstallationUserService`, auditado `vault.allow` false), borrar una Organization (`OrganizationLifecycle.delete`: sus Vaults, entradas, valores, allowances, defectos y elecciones; auditado `vault.delete`) y borrar un Vault. Tabla completa en `docs/internals/secrets.md`, «Losing reach».
- `EffectiveVaults.projectMove` (misma parte de Space que `forThread`, extraída a `spaceSide`) da `vaultsLost` (solo nombres) y el borrado de elecciones. `ProjectService` es el único llamador nuevo; DoorRules comprueba que no llama a `forThread`.
- Contrato: `ProjectMovePlan.vaultsLost` (por defecto `[]` al decodificar si viene de un Hub anterior). Web: sección «Vaults it loses».
- Testkit: Vaults/EffectiveVaults/SecretDelivery van bajo los Projects en `UserAuth.testkit.ts`, como en el servidor.
- `list_secret_names` aún no existe (ticket 06); lo comprobado es `vaults.threadEnvironment` y `forThread`, de donde saldrá.
- Prueba real (`makita-livepass-s5-07`, Podman): todo PASS.
- Revisión 1: mover un Project y quitar un User cierran las terminales de sus Threads con lo que arrancaron (`terminal.close` `endProcesses`; el diálogo lo avisa); tras quitar una allowance sigue la marca «Secrets changed» del ticket 04. Permitir un Vault a un Space borra defectos y elecciones viejos suyos allí; la migración 115 limpia los que dejaron Hubs anteriores. `create`, `putEntry`, `linkEntry`/`copyEntry`, `allow`, `setSpaceDefaults` y `setProjectChoice` vuelven a comprobar dentro de su transacción. `ProjectService` exige `EffectiveVaults`. Auditadas las elecciones que borra un movimiento y las allowances que pierde una Organization borrada; borrar un Project borra sus elecciones; quitar un User borra también lo permitido a su Personal space.
- Prueba real r2 (`makita-livepass-s5-07`, `run2.sh`/`live2.mjs`, Podman): el diálogo avisa que las terminales se cierran; tras mover, la shell y el `sleep 4207 &` que arrancó en el Sandbox de Acme ya no existen y ningún proceso tiene ACME_TOKEN. La imagen del Sandbox no trae `ps`: en Linux la tabla de procesos cae a `/proc`.
- Revisión 2: sin matar árboles de procesos (fuera `endProcesses`, `ps` y `/proc`). El Hub registra cada terminal con el Space en que se abrió y quién la abrió (`terminal_openings`, `environment/TerminalOpenings.ts`); rechaza escribir, redimensionar, limpiar u observar una cuyo Thread dejó ese Space o cuyo autor fue quitado, y la cierra (ahora si su máquina está conectada; si no, al conectarse). Abrirla de nuevo cierra la vieja y arranca otra. Quitar un User cierra las terminales que abrió, no las de sus Threads. Las elecciones borradas al mover se auditan en el Space de origen; `setProjectChoice` mira `deleted_at`; quitar un User borra también las elecciones de Projects de su Personal space (y la migración 115 limpia lo mismo).
- Prueba real r3 (`run3.sh`/`live3.mjs`): el diálogo dice «Open terminals of its Threads close»; tras mover, la shell del Sandbox de Acme ya no existe; el `sleep 4207 &` que arrancó sigue vivo con ACME_TOKEN (trabajo en segundo plano fuera del cierre: riesgo aceptado, A2).
