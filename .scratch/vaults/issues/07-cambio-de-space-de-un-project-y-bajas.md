# 07: Cambio de Space de un Project y bajas

**What to build:** Mover un Project a otro Space (spec 3, ticket 12) avisa de qué Vaults pierde y después usa solo los del destino. Quitar una allowance, quitar un User o borrar una Organization deja de entregar sus secretos en el siguiente turno, terminal o script. Ver spec, «Cambio de Space de un Project» y «Bajas».

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] `POST /api/projects/move-plan` añade `vaultsLost` (Vaults que el Project recibe por el origen y que el destino no tiene), calculado con `EffectiveVaults`.
- [ ] Al mover, se borran las `project_vault_choices` que nombran Vaults no permitidos al destino, en la misma transacción que el cambio de Space.
- [ ] Quitar un User (spec 1) borra sus allowances de User; borrar una Organization borra sus Vaults y valores (dentro del flujo de borrado del spec 1).
- [ ] Red-first: tras mover un Project de Acme a Globex, un turno nuevo no recibe los Vaults de Acme, y `list_secret_names` y `vaults.threadEnvironment` tampoco los listan; tras quitar una allowance, la siguiente terminal no la recibe; tras borrar una Organization no queda ninguna fila ni valor suyo.
- [ ] Puertas: HttpApi `projects.movePlan` (misma regla que hoy), WS de allowances. Sin puertas nuevas.
- [ ] Web: el diálogo «Move to…» lista los Vaults que se pierden antes de «Stop Threads and move».
- [ ] Tests en `HubWithEnvironments.projectMove.test.ts` y en el flujo de borrado de Organization.
- [ ] Prueba real: mover un Project con un Vault de Acme a Globex; el diálogo lo avisa; un turno en el destino hace `printenv` y no lo tiene.
