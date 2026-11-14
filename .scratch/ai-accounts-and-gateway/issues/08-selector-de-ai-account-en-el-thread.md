# 08: Selector de AI account en el Thread

**What to build:** Un Thread nuevo arranca con la AI account permitida de mayor prioridad compatible con su provider; el composer tiene un selector con las cuentas permitidas y sus modelos; el User puede cambiarla a mitad de Thread (traspaso de contexto del spec 2 si cambia de provider); el header muestra siempre la cuenta y el modelo en uso, también tras un failover. Ver spec, «Thread y selector».

**Blocked by:** 06, 07.

**Status:** done

- [x] Defecto de un Thread nuevo con `AllowedAiAccounts` y la prioridad global; sin ninguna, el composer lo dice antes de enviar («No AI account is allowed for you in <Space>»).
- [x] `modelSelection` con `aiAccountId`; el selector lista por provider instance las cuentas permitidas y sus modelos (gateway: catálogo del prefijo; directas: catálogo del provider). Modelos de otras familias traducidos por CLIProxyAPI se muestran con su familia.
- [x] `thread.setAiAccount` (regla de `thread.continue`): mismo provider → cambia el enrutado desde la siguiente petición; otro provider → traspaso de contexto (spec 2, ticket 09).
- [x] Header del Thread con cuenta y modelo en uso; actualizado por el evento de failover del ticket 04.
- [x] Red-first: `thread.setAiAccount` con una cuenta no permitida se rechaza aunque el cliente la mande a mano; un Member no cambia la cuenta de un Thread ajeno; el defecto nunca es una cuenta no permitida.
- [x] Puertas: WS `thread.setAiAccount` y el campo `aiAccountId` en los comandos que ya crean o continúan Threads (`RPC_SPACE_ACCESS` y `commandAccess`); herramientas MCP que crean Threads (`t3_thread_launch`) aplican el mismo defecto y la misma comprobación.
- [x] Web/desktop: selector en el composer y cuenta en el header. Nombres accesibles entregados.
- [x] Tests en el testkit (defecto, cambio, traspaso, failover visible) y de componentes.
- [x] Prueba real: Member de Acme con dos cuentas permitidas; el Thread arranca con la de mayor prioridad, cambia a la otra a mitad y el header lo refleja.

**Hecho (2026-11-13):** `AiAccountChoice` (con `chooseAiAccount`, el mismo elector que el plan de sesión) decide la cuenta en `ThreadManagementService.dispatch` para todo transporte: por defecto la permitida de mayor prioridad que el driver acepta y sirve el modelo; una cuenta nombrada que el dueño del turno no puede usar en el Space del Thread se rechaza; sin nombrar, se conserva la del Thread. `thread.setAiAccount` (WS) es azúcar sobre `thread.model-selection.set` (mismo provider: la gateway enruta la siguiente petición) o `provider.switch` (traspaso). `aiAccounts.picker` da las cuentas permitidas del User en un Space con sus modelos. El header sigue a `subscribeAccountsInUse` (failover y cambio) y la proyección ya no lleva el nombre de la cuenta. Web: el selector de modelos usa las cuentas permitidas y no el login de la máquina; selector «AI account» en el composer. Tests: `HubWithEnvironments.aiAccountPicker.test.ts`, `DoorRules.test.ts`, `aiAccountPicker.test.ts`, `ComposerAiAccountSelect.browser.test.tsx`. Docs: `docs/internals/ai-gateway.md`, «The AI account of a Thread». Móvil: ticket 12.
