# 02: Vaults, secretos y permisos de edición

**What to build:** Tablas de Vaults (migración 111), el Main vault del Owner, Vaults de Organizations, entradas propias, copias y Secret links al Main vault, y quién puede crear, editar, ver nombres y revelar. Los valores van cifrados en la base con la clave maestra del ticket 01. Settings → Vaults en web y desktop. Ver spec, «Modelo» y «Quién hace qué».

**Blocked by:** 01.

**Status:** done

- [x] Migración 111: `vaults`, `vault_entries` (`own` | `copy` | `link`), `vault_allowances`, `space_default_vaults`, `project_vault_choices`, valor de prueba. El Main vault se crea con el Owner y no se borra.
- [x] Nombres válidos (`^[A-Z_][A-Z0-9_]{0,127}$`), únicos por Vault; lista de reservados compartida en contracts (incluye las variables de la AI gateway del spec 4). Valores hasta 64 KiB.
- [x] Secret link solo a una entrada `own`/`copy` del Main vault; rotar el original cambia los links; borrar el original lista los links que se rompen y estos quedan «broken».
- [x] Tabla en `AccessPolicy`: Owner todo; Admin añade, sustituye y borra entradas de Vaults permitidos a su Organization sin leer valores; Members y Guests solo nombres; nadie salvo el Owner toca el Main vault.
- [x] Red-first, con Owner, Admin, Member y Guest de dos Organizations: un Admin no edita el Main vault ni un Vault de otra Organization; ningún RPC devuelve un valor salvo `vaults.reveal`; una sesión con `spaceLimit` no ve Vaults de otro Space.
- [x] `vaults.reveal` (HttpApi, solo Owner, factor fuerte en los últimos 5 min); auditoría `secret.reveal` sin valor.
- [x] WS RPCs en `RPC_SPACE_ACCESS`: `vaults.list`, `vaults.create`, `vaults.update`, `vaults.delete`, `vaults.entries.list`, `vaults.entries.put`, `vaults.entries.delete`, `vaults.entries.link`, `vaults.entries.copy`. HttpApi `vaults.reveal` en `HTTP_ENDPOINT_RULES`. Sin herramientas MCP en este ticket.
- [x] Auditoría `vault.create`, `vault.update`, `vault.delete`, `secret.edit`.
- [x] Web/desktop: Settings → Vaults (Owner: todo, «Reveal»; Admin: sus Vaults con «Replace value» y «Delete»; Member/Guest: nombres). Nombres accesibles entregados para la prueba real.
- [x] Prueba real: el Owner crea «Acme secrets» con una entrada propia y un link a `GITHUB_TOKEN` del Main vault; rota el original y el link cambia; un Admin de Acme sustituye un valor y no ve «Reveal»; un Member solo ve nombres.

**Hecho** (rama `impl/vlt-02`):

- Valores: nunca en la base. Cada entrada `own`/`copy` es una entrada del almacén del ticket 01, `vault-value-<id>.sealed`, con su propio uso (`vault-value`, elegido por el nombre en `SecretCipher.entryPurpose`): el arranque las autentica, `t3 secrets key rotate` las vuelve a cifrar e `import` rechaza una clave que no las abre. Un archivo de otro secreto o de otra entrada movido a ese nombre no abre.
- Migración 111: `vaults`, `vault_entries` (`own` | `copy` | `link`, `linked_entry_id` se queda al borrar el original: el link queda «broken»), `vault_allowances`, `space_default_vaults`, `project_vault_choices` (sin uso hasta el ticket 03) y `vault_key_check`. El Main vault (`vault-main`) se crea al arrancar el Hub, no se borra, no se renombra ni archiva.
- Comprobación de la clave en la base (`vaults/VaultKeyCheck.ts`): texto conocido sellado; se escribe en el primer arranque, se vuelve a sellar al rotar (lo hace el propio `rotate`, y si falla el siguiente arranque mientras exista `master.key.previous`); una clave que no lo abre impide arrancar con mensaje.
- Sin valores huérfanos: el valor se escribe antes que su fila y se borra después; el arranque borra los `vault-value-*` sin fila. Renombrar no toca el valor (va por id).
- Permisos: `AccessPolicy` `vault.view|edit|manage|reveal` sobre `VaultResource`, decididos por `SpaceDirectory.authorizeResource` (que también aplica `spaceLimit`). Un Vault que no se ve responde como inexistente. Links y copias solo desde el Main vault y solo si se puede editar el Main vault (el Owner).
- Nombres: `secretNameProblem` en contracts (patrón, reservados `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PWD`, `NODE_OPTIONS`, `BASH_ENV`, `ENV`, `IFS`, `PROMPT_COMMAND`, `LD_*`, `DYLD_*`, `T3_*`, `T3CODE_*` y la lista de la AI gateway `AI_GATEWAY_ENV_NAMES`, sin exportar hasta que el spec 4 la use). Se rechazan, no avisan. Valores: UTF-8 sin NUL, 64 KiB; < 6 caracteres: aviso `short-value` y `unmasked`.
- Puertas: WS `vaults.list|create|update|delete|entries.list|entries.put|entries.delete|entries.link|entries.copy` (lectura `access:read`, escritura `access:write`, regla `VAULTS` en `RPC_SPACE_ACCESS`); HttpApi `vaults.reveal` (Owner, `authorizeReveal` antes del factor fuerte en la petición, auditado antes de devolver). Sin MCP ni CLI de revelar; `DoorRules.test.ts` comprueba que solo `vaults/http.ts` llama a `reveal` y que ninguna respuesta WS de Vaults tiene un campo `value`. El valor entra como `RedactedFromValue`.
- Auditoría: `vault.create|update|delete`, `secret.edit` (`op`: add, replace, rename, describe, link, copy, delete con `brokenLinks`), `secret.reveal`; nombres y tipos, nunca valores.
- Web: Settings → Vaults (`/settings/vaults`). Nombres accesibles: «Vault name», «Organization», «Create Vault», lista «Secrets in <Vault>», formulario «Add a secret to <Vault>» con «Variable name», «Value», «Add secret»; grupo «From the Main vault into <Vault>» con «Main vault secret», «Name here», «Add Secret link», «Add copy»; por secreto «Replace value of <NAME>», «New value of <NAME>», «Save value», «Delete <NAME>», «Reveal <NAME>», «Confirm and reveal <NAME>», «Value of <NAME>», «Hide»; «Delete Vault <Vault>».
- Prueba real (`makita-livepass-s5-02`): todo PASS; los cuatro valores no están en ningún archivo de la base (incluido el WAL), del home del Hub ni del log.
- Riesgos: borrar una Organization no borra aún sus Vaults (ticket 07; quedan solo para el Owner); un Admin de una Organization edita los Vaults de esa Organization (los permitidos por allowance llegan con el ticket 03); revelar no pide «factor en los últimos 5 min» sino el factor en la propia petición, como la copia de la clave.
