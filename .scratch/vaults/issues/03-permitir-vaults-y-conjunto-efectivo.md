# 03: Permitir Vaults y conjunto efectivo

**What to build:** El Owner permite Vaults a Spaces y Users; el Owner y los Admins eligen los Vaults por defecto de un Space y los `add`/`remove` de cada Project. Un servicio único, `EffectiveVaults`, calcula qué variables recibe un turno, una terminal o un script de un Thread, con un orden fijo ante nombres repetidos. Ver spec, «Conjunto efectivo de un turno».

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] `vaults.allow` (solo Owner) a Space o User; el Main vault solo es defecto del Personal space del Owner y no se permite a nadie más.
- [ ] `vaults.spaceDefaults.set` y `vaults.projectChoices.set` (Owner y Admin de ese Space), limitados a Vaults permitidos al Space.
- [ ] `EffectiveVaults.forThread(threadId, actingUserId)`: defectos del Space + `add` − `remove` del Project, más Vaults del User; sin archivados ni links rotos; orden User → Project → Space y, dentro, el orden del Owner. Es el único sitio que hace este cálculo (los tickets 04–07 lo llaman).
- [ ] `vaults.threadEnvironment`: nombres efectivos de un Thread visible, con el Vault que gana cada nombre. Nunca valores.
- [ ] Red-first: un Vault permitido solo a Globex no aparece en un Thread de Acme; un Vault permitido a Ada no aparece en los turnos de Grace en el mismo Space; un Admin no puede añadir a un Project un Vault no permitido a su Space; quitar una allowance lo saca del cálculo siguiente.
- [ ] Puertas: WS RPCs nuevos en `RPC_SPACE_ACCESS`; ninguna HttpApi, raw route ni herramienta MCP.
- [ ] Auditoría `vault.allow`.
- [ ] Web/desktop: Space → «Default Vaults», Project → «Vaults», allowances en Settings → Vaults, panel «Secrets» del Thread con nombres y Vault ganador; aviso al permitir un Vault a un User sobre el Sandbox compartido.
- [ ] Tests en el testkit «Hub con Environments» y en `AccessPolicy`.
- [ ] Prueba real: Acme con dos Vaults por defecto que comparten un nombre; el panel «Secrets» del Thread muestra cuál gana; un Project quita uno y el panel cambia.
