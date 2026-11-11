# 02: Vaults, secretos y permisos de edición

**What to build:** Tablas de Vaults (migración 111), el Main vault del Owner, Vaults de Organizations, entradas propias, copias y Secret links al Main vault, y quién puede crear, editar, ver nombres y revelar. Los valores van cifrados en la base con la clave maestra del ticket 01. Settings → Vaults en web y desktop. Ver spec, «Modelo» y «Quién hace qué».

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] Migración 111: `vaults`, `vault_entries` (`own` | `copy` | `link`), `vault_allowances`, `space_default_vaults`, `project_vault_choices`, valor de prueba. El Main vault se crea con el Owner y no se borra.
- [ ] Nombres válidos (`^[A-Z_][A-Z0-9_]{0,127}$`), únicos por Vault; lista de reservados compartida en contracts (incluye las variables de la AI gateway del spec 4). Valores hasta 64 KiB.
- [ ] Secret link solo a una entrada `own`/`copy` del Main vault; rotar el original cambia los links; borrar el original lista los links que se rompen y estos quedan «broken».
- [ ] Tabla en `AccessPolicy`: Owner todo; Admin añade, sustituye y borra entradas de Vaults permitidos a su Organization sin leer valores; Members y Guests solo nombres; nadie salvo el Owner toca el Main vault.
- [ ] Red-first, con Owner, Admin, Member y Guest de dos Organizations: un Admin no edita el Main vault ni un Vault de otra Organization; ningún RPC devuelve un valor salvo `vaults.reveal`; una sesión con `spaceLimit` no ve Vaults de otro Space.
- [ ] `vaults.reveal` (HttpApi, solo Owner, factor fuerte en los últimos 5 min); auditoría `secret.reveal` sin valor.
- [ ] WS RPCs en `RPC_SPACE_ACCESS`: `vaults.list`, `vaults.create`, `vaults.update`, `vaults.delete`, `vaults.entries.list`, `vaults.entries.put`, `vaults.entries.delete`, `vaults.entries.link`, `vaults.entries.copy`. HttpApi `vaults.reveal` en `HTTP_ENDPOINT_RULES`. Sin herramientas MCP en este ticket.
- [ ] Auditoría `vault.create`, `vault.update`, `vault.delete`, `secret.edit`.
- [ ] Web/desktop: Settings → Vaults (Owner: todo, «Reveal»; Admin: sus Vaults con «Replace value» y «Delete»; Member/Guest: nombres). Nombres accesibles entregados para la prueba real.
- [ ] Prueba real: el Owner crea «Acme secrets» con una entrada propia y un link a `GITHUB_TOKEN` del Main vault; rota el original y el link cambia; un Admin de Acme sustituye un valor y no ve «Reveal»; un Member solo ve nombres.
