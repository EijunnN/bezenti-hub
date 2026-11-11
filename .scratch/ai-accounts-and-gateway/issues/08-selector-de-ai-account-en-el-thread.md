# 08: Selector de AI account en el Thread

**What to build:** Un Thread nuevo arranca con la AI account permitida de mayor prioridad compatible con su provider; el composer tiene un selector con las cuentas permitidas y sus modelos; el User puede cambiarla a mitad de Thread (traspaso de contexto del spec 2 si cambia de provider); el header muestra siempre la cuenta y el modelo en uso, también tras un failover. Ver spec, «Thread y selector».

**Blocked by:** 06, 07.

**Status:** ready-for-agent

- [ ] Defecto de un Thread nuevo con `AllowedAiAccounts` y la prioridad global; sin ninguna, el composer lo dice antes de enviar («No AI account is allowed for you in <Space>»).
- [ ] `modelSelection` con `aiAccountId`; el selector lista por provider instance las cuentas permitidas y sus modelos (gateway: catálogo del prefijo; directas: catálogo del provider). Modelos de otras familias traducidos por CLIProxyAPI se muestran con su familia.
- [ ] `thread.setAiAccount` (regla de `thread.continue`): mismo provider → cambia el enrutado desde la siguiente petición; otro provider → traspaso de contexto (spec 2, ticket 09).
- [ ] Header del Thread con cuenta y modelo en uso; actualizado por el evento de failover del ticket 04.
- [ ] Red-first: `thread.setAiAccount` con una cuenta no permitida se rechaza aunque el cliente la mande a mano; un Member no cambia la cuenta de un Thread ajeno; el defecto nunca es una cuenta no permitida.
- [ ] Puertas: WS `thread.setAiAccount` y el campo `aiAccountId` en los comandos que ya crean o continúan Threads (`RPC_SPACE_ACCESS` y `commandAccess`); herramientas MCP que crean Threads (`t3_thread_launch`) aplican el mismo defecto y la misma comprobación.
- [ ] Web/desktop: selector en el composer y cuenta en el header. Nombres accesibles entregados.
- [ ] Tests en el testkit (defecto, cambio, traspaso, failover visible) y de componentes.
- [ ] Prueba real: Member de Acme con dos cuentas permitidas; el Thread arranca con la de mayor prioridad, cambia a la otra a mitad y el header lo refleja.
