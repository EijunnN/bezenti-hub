# 06: El agente lista nombres y guarda secretos que faltan

**What to build:** Herramienta MCP `list_secret_names` para que el agente sepa qué variables tiene, una línea en sus instrucciones de desarrollador, y la tarjeta de `request_secret` (`secrets/SecretRequests.ts`) con «Also save to Vault» para el Owner y los Admins del Space. Ver spec, «El agente lista nombres» y «Guardar un secreto que falta».

**Blocked by:** 03, 05.

**Status:** done

- [x] `list_secret_names`: nombre, descripción y Vault de cada variable del conjunto efectivo del Thread que llama; nunca valores. `MCP_TOOL_RULES`: `OWN_THREAD`.
- [x] Instrucciones de desarrollador de los providers: «Secrets are environment variables; call list_secret_names and use $NAME; never print values».
- [x] Tarjeta de `request_secret`: si responde el Owner o un Admin del Space del Thread, «Also save to Vault» con los Vaults que puede editar y el nombre sugerido; la entrada se crea (auditoría `secret.edit`) y el turno recibe el valor como hoy.
- [x] Members y Guests responden como hoy, sin la opción.
- [x] Red-first: un Member no puede guardar en un Vault aunque mande el campo a mano; un Admin no puede guardar en un Vault de otra Organization ni en el Main vault; `list_secret_names` desde un Thread de Globex no lista nombres de Acme; una credencial MCP de otro Thread recibe la respuesta de Thread oculto.
- [x] Puertas: MCP (`list_secret_names`, `request_secret`), WS de la respuesta de la tarjeta (`RPC_SPACE_ACCESS`), HttpApi si la tarjeta tiene gemela HTTP. Declaradas en `DoorRules`.
- [x] Web/desktop: tarjeta con selector de Vault y nombre. Móvil: responde como hoy (guardar en Vault queda para el ticket 08).
- [x] Prueba real: el agente pide `STRIPE_KEY`; un Admin responde y lo guarda en «Acme secrets»; el siguiente Thread de Acme lo ve en `list_secret_names` y en el panel «Secrets».

**Hecho** (impl/vlt-06): `list_secret_names` (MCP, `OWN_THREAD`, visibility as `t3_thread_read`) answers `SecretDelivery.turnNames`: what the Thread's turns receive, names, descriptions and Vault, never values. Agents' shared instructions name it. `request_secret` takes `name`; the card's «Also save to Vault» lists `Vaults.saveTargets` (Vaults the answerer may `vault.edit`, not archived, reaching the Thread's Space) over WS `secrets.vaultTargets`, and `secrets.answerRequest` refuses any other Vault before storing anything, then saves through `Vaults.putEntry` (policy, `secretNameRisk`, audit `secret.edit`). Dangerous names are not saved from a card (Settings → Vaults). No migration. Tests: `vaults/SecretRequestVaults.test.ts`, `mcp/OrchestratorMcpService.test.ts` («list_secret_names»), `client-runtime/secretRequest.test.ts`. Docs: docs/internals/secrets.md.
