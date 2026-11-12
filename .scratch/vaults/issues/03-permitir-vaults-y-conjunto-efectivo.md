# 03: Permitir Vaults y conjunto efectivo

**What to build:** El Owner permite Vaults a Spaces y Users; el Owner y los Admins eligen los Vaults por defecto de un Space y los `add`/`remove` de cada Project. Un servicio único, `EffectiveVaults`, calcula qué variables recibe un turno, una terminal o un script de un Thread, con un orden fijo ante nombres repetidos. Ver spec, «Conjunto efectivo de un turno».

**Blocked by:** 02.

**Status:** done

- [x] `vaults.allow` (solo Owner) a Space o User; el Main vault solo es defecto del Personal space del Owner y no se permite a nadie más.
- [x] `vaults.spaceDefaults.set` y `vaults.projectChoices.set` (Owner y Admin de ese Space), limitados a Vaults permitidos al Space.
- [x] `EffectiveVaults.forThread(threadId, actingUserId)`: defectos del Space + `add` − `remove` del Project, más Vaults del User; sin archivados ni links rotos; orden User → Project → Space y, dentro, el orden del Owner. Es el único sitio que hace este cálculo (los tickets 04–07 lo llaman).
- [x] `vaults.threadEnvironment`: nombres efectivos de un Thread visible, con el Vault que gana cada nombre. Nunca valores.
- [x] Red-first: un Vault permitido solo a Globex no aparece en un Thread de Acme; un Vault permitido a Ada no aparece en los turnos de Grace en el mismo Space; un Admin no puede añadir a un Project un Vault no permitido a su Space; quitar una allowance lo saca del cálculo siguiente.
- [x] Puertas: WS RPCs nuevos en `RPC_SPACE_ACCESS`; ninguna HttpApi, raw route ni herramienta MCP.
- [x] Auditoría `vault.allow`.
- [x] Web/desktop: Space → «Default Vaults», Project → «Vaults», allowances en Settings → Vaults, panel «Secrets» del Thread con nombres y Vault ganador; aviso al permitir un Vault a un User sobre el Sandbox compartido.
- [x] Tests en el testkit «Hub con Environments» y en `AccessPolicy`.
- [x] Prueba real: Acme con dos Vaults por defecto que comparten un nombre; el panel «Secrets» del Thread muestra cuál gana; un Project quita uno y el panel cambia.

**Hecho** (rama `impl/vlt-03`, sin migración: las tablas de la 111 bastan):

- Una sola regla de alcance, `vaults/VaultReach.ts`: el Main vault solo llega al Personal space del Owner (defecto fijo, «Always»); el Vault de una Organization llega a ella sin allowance y a nada más (permitirlo a otro Space o a un User: `not-allowed`); los demás Vaults del Owner llegan a los Spaces y Users permitidos. Las filas de allowance del Main vault o de un Vault de Organization se ignoran al leer.
- `vaults.allow` (Owner, `vault.manage`, auditado `vault.allow` con `subjectKind`, `subjectId`, `subjectName`, `allowed`). Quitarla a un Space borra también su defecto y las elecciones de sus Projects. `VaultSummary.allowances` solo para el Owner.
- `AccessPolicy`: `VaultResource` lleva `allowedSpaces`/`allowedUsers`; quien trabaja en un Space permitido (o es el User permitido) ve los nombres; un Admin edita un Vault del Owner solo si llega únicamente a Organizations que él administra (ni Users ni Personal spaces). Acción nueva `vault.choose` sobre el Space: el Owner en cualquiera (Personal spaces incluidos), un Admin en su Organization abierta.
- `vaults.choices` (lectura), `vaults.spaceDefaults.set` (lista ordenada) y `vaults.projectChoices.set` (`add` | `remove` | `inherit`): solo Vaults permitidos al Space, auditados `vault.choose` por Vault cambiado. El Project scratch (Threads sin Project) no admite elecciones.
- `EffectiveVaults.forThread({ threadId, actingUserId })` (`vaults/EffectiveVaults.ts`), único cálculo: Space del Thread (`SpaceDirectory.placementOf`); el User tiene que trabajar en ese Space (si no, `forbidden`); defectos + `add` − `remove` limitados a lo permitido al Space; más los Vaults del User; sin archivados, links rotos ni nombres `invalid`/`gateway`. Precedencia User → Project → defectos (dentro: orden de Settings; defectos en el orden fijado), perdedores en `shadowed`. Devuelve ids de valor (el de un link es el del original), nunca valores; sin caché.
- `vaults.threadEnvironment` (WS, Thread visible): el conjunto del que llama, sin ids de valor ni de entrada.
- Puertas: 5 WS RPCs en `RPC_SPACE_ACCESS` (`allow` y `spaceDefaults.set`: VAULTS; `choices` y `projectChoices.set`: `project`; `threadEnvironment`: `thread`), lecturas con `access:read`/`orchestration:read`, escrituras en `CLIENT_GUARDED_RPC_SCOPES`. Sin HttpApi, raw route ni MCP. `DoorRules.test.ts`: 14 RPCs `vaults.*`, ninguna respuesta con `value` ni `valueId`, y solo `server.ts` y `ws.ts` llegan a `EffectiveVaults` (ws sin `forThread`).
- Web: Settings → Vaults con «Allowed to» por Vault del Owner («Allow <Vault> to», «Allow <Vault>», «Take back <Vault> from <nombre>», aviso del Sandbox compartido con «I understand other agents in a shared Sandbox can read it») y «Default Vaults» («Space for default Vaults», «Default: <Vault>», «Move <Vault> up»); Project → «Vaults» («<Vault> in this Project»); cabecera del Thread: botón «Secrets» con la lista «Secrets this Thread receives» (Vault ganador y «Wins over …»).
- Tests: `vaults/EffectiveVaults.test.ts` (7, sobre `UserAuth.testkit`: los servicios reales del Hub; el testkit «Hub con Environments» no aporta nada hasta la entrega del ticket 04) y filas nuevas de `AccessPolicy.test.ts`. Rojo comprobado por mutación: quitar el límite a lo permitido, el filtro por User, la comprobación de Membership, el filtro `gateway` o el de archivados hace fallar los tests.
- Prueba real (`makita-livepass-s5-03`): todo PASS, ningún valor en páginas, auditoría ni log.
- Docs: `docs/internals/secrets.md` («Allowing Vaults», «The effective set»).
- Riesgos: el orden «del Owner» dentro de los Vaults del User y de los `add` es el de Settings (Main, `position`, nombre) y aún no hay control para cambiar `position`; las allowances de un User quitado o de una Organization borrada quedan en la tabla (inertes: `forThread` rechaza a quien no trabaja en el Space; limpieza en el ticket 07); el Owner ve en «Secrets» lo que recibirían sus turnos aunque no pueda continuar el Thread de otro.
