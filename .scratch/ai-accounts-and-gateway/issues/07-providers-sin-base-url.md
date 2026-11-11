# 07: Providers sin base URL: credenciales directas

**What to build:** AI accounts de tipo `direct` para los providers que no pueden apuntar a la gateway: Antigravity (`agy`) solo con Gemini API key o Vertex, Cursor (`CURSOR_API_KEY`), Kiro (`KIRO_API_KEY`), Fx (`AI_GATEWAY_API_KEY`), Muse (`META_API_KEY`), Devin por ACP Registry (`DEVIN_TOKEN`), y Grok si su CLI no acepta base URL. La credencial llega por `secretEnv` (spec 5) solo al proceso del provider del Thread que la eligió, y se enmascara. Ver spec, tabla de «Agentes por la gateway».

**Blocked by:** 06, spec 5 · 05 (enmascarado).

**Status:** ready-for-agent

- [ ] Tipo `direct` con proveedor y variable de entorno; el formulario avisa «This credential will be visible to the agent» y solo acepta API keys o cuentas de servicio, nunca un login de suscripción.
- [ ] `AntigravityDriver` en turnos del Hub: solo métodos «Gemini API key» y «Vertex»; «Google account» y «Gemini Enterprise» deshabilitados con un motivo («Use the Owner's Google account through the AI gateway»). El login de Google (`AntigravityAuth`) no se ofrece en Environments del Hub.
- [ ] Grok: comprobar si `GROK_CLI_CHAT_PROXY_BASE_URL` sirve para el chat; si sí, pasa a la gateway (driver como en el ticket 06); si no, directa con `XAI_API_KEY`. Documentar el resultado en el spec.
- [ ] ACP Registry: solo agentes con credencial de API conocida (Devin); el resto no se ofrece en turnos del Hub.
- [ ] Entrega por `secretEnv` solo al proceso del provider (no a terminales ni scripts), y `SecretMasker` con el nombre de la variable; aparece en el panel «Secrets» del Thread como «AI account credential».
- [ ] Red-first: la credencial directa de Acme no llega a un turno de Globex ni a una terminal del mismo Thread; un `agy` con método «Google account» en un Environment del Hub no arranca; el valor impreso por el agente sale como `[CURSOR_API_KEY]` en el historial.
- [ ] Puertas: executor wire (`secretEnv` en `provider.openSession`), WS de AI accounts (sin campos nuevos que devuelvan valores), logs/OTLP/argv.
- [ ] Tests con los drivers de Antigravity y Cursor en el testkit (credencial en el entorno, enmascarado, métodos deshabilitados).
- [ ] Prueba real: un Thread de Acme con Cursor y una key de prueba (o un provider de test) recibe `CURSOR_API_KEY` y el historial la muestra enmascarada.
