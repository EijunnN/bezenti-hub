# 06: El agente lista nombres y guarda secretos que faltan

**What to build:** Herramienta MCP `list_secret_names` para que el agente sepa qué variables tiene, una línea en sus instrucciones de desarrollador, y la tarjeta de `request_secret` (`secrets/SecretRequests.ts`) con «Also save to Vault» para el Owner y los Admins del Space. Ver spec, «El agente lista nombres» y «Guardar un secreto que falta».

**Blocked by:** 03, 05.

**Status:** ready-for-agent

- [ ] `list_secret_names`: nombre, descripción y Vault de cada variable del conjunto efectivo del Thread que llama; nunca valores. `MCP_TOOL_RULES`: `OWN_THREAD`.
- [ ] Instrucciones de desarrollador de los providers: «Secrets are environment variables; call list_secret_names and use $NAME; never print values».
- [ ] Tarjeta de `request_secret`: si responde el Owner o un Admin del Space del Thread, «Also save to Vault» con los Vaults que puede editar y el nombre sugerido; la entrada se crea (auditoría `secret.edit`) y el turno recibe el valor como hoy.
- [ ] Members y Guests responden como hoy, sin la opción.
- [ ] Red-first: un Member no puede guardar en un Vault aunque mande el campo a mano; un Admin no puede guardar en un Vault de otra Organization ni en el Main vault; `list_secret_names` desde un Thread de Globex no lista nombres de Acme; una credencial MCP de otro Thread recibe la respuesta de Thread oculto.
- [ ] Puertas: MCP (`list_secret_names`, `request_secret`), WS de la respuesta de la tarjeta (`RPC_SPACE_ACCESS`), HttpApi si la tarjeta tiene gemela HTTP. Declaradas en `DoorRules`.
- [ ] Web/desktop: tarjeta con selector de Vault y nombre. Móvil: responde como hoy (guardar en Vault queda para el ticket 08).
- [ ] Prueba real: el agente pide `STRIPE_KEY`; un Admin responde y lo guarda en «Acme secrets»; el siguiente Thread de Acme lo ve en `list_secret_names` y en el panel «Secrets».
