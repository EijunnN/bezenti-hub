# 07: Providers sin base URL: credenciales directas

**What to build:** AI accounts de tipo `direct` para los providers que no pueden apuntar a la gateway: Antigravity (`agy`) solo con Gemini API key o Vertex, Cursor (`CURSOR_API_KEY`), Kiro (`KIRO_API_KEY`), Fx (`AI_GATEWAY_API_KEY`), Muse (`META_API_KEY`), Devin por ACP Registry (`DEVIN_TOKEN`), y Grok si su CLI no acepta base URL. La credencial llega por `secretEnv` (spec 5) solo al proceso del provider del Thread que la eligió, y se enmascara. Ver spec, tabla de «Agentes por la gateway».

**Blocked by:** 06, spec 5 · 05 (enmascarado).

**Status:** done

- [x] Tipo `direct` con proveedor y variable de entorno; el formulario avisa «This credential will be visible to the agent» y solo acepta API keys o cuentas de servicio, nunca un login de suscripción.
- [x] `AntigravityDriver` en turnos del Hub: solo métodos «Gemini API key» y «Vertex»; «Google account» y «Gemini Enterprise» deshabilitados con un motivo («Use the Owner's Google account through the AI gateway»). El login de Google (`AntigravityAuth`) no se ofrece en Environments del Hub.
- [x] Grok: comprobar si `GROK_CLI_CHAT_PROXY_BASE_URL` sirve para el chat; si sí, pasa a la gateway (driver como en el ticket 06); si no, directa con `XAI_API_KEY`. Documentar el resultado en el spec.
- [x] ACP Registry: solo agentes con credencial de API conocida (Devin); el resto no se ofrece en turnos del Hub.
- [x] Entrega por `secretEnv` solo al proceso del provider (no a terminales ni scripts), y `SecretMasker` con el nombre de la variable; aparece en el panel «Secrets» del Thread como «AI account credential».
- [x] Red-first: la credencial directa de Acme no llega a un turno de Globex ni a una terminal del mismo Thread; un `agy` con método «Google account» en un Environment del Hub no arranca; el valor impreso por el agente sale como `[CURSOR_API_KEY]` en el historial.
- [x] Puertas: executor wire (`secretEnv` en `provider.openSession`), WS de AI accounts (sin campos nuevos que devuelvan valores), logs/OTLP/argv.
- [x] Tests con los drivers de Antigravity y Cursor en el testkit (credencial en el entorno, enmascarado, métodos deshabilitados).
- [x] Prueba real: un Thread de Acme con Cursor y una key de prueba (o un provider de test) recibe `CURSOR_API_KEY` y el historial la muestra enmascarada.

**Hecho (2026-11-13):** una sola regla, `AiGatewaySessions.plan` → `direct` (tabla `AI_DIRECT_DRIVERS`), con la misma condición que la gateway; la credencial se lee al arrancar el proceso, se enmascara antes (`ai-account:<id>` en `thread_secret_values`, que `SecretMasker` lee del almacén de AI accounts) y viaja como una variable más de `secretEnv` con `aiCredential` (contrato 13; las máquinas anteriores se rechazan). En la máquina, `applySecretEnv` quita las credenciales de IA ambientales y `openSessionWithSecrets` solo acepta lo que el adapter declara (`acceptsAiCredential`; ACP Registry solo Devin). Cursor usa la key de la sesión en el SDK (también el envoltorio del driver, que antes la sustituía por el login de la máquina: lo encontró la prueba real); Antigravity firma con ella en un perfil propio y no arranca con «Google account»/«Gemini Enterprise». Grok queda directa (con `XAI_API_KEY` el CLI 1.0.77 ignora `GROK_CLI_CHAT_PROXY_BASE_URL`); la vía `GROK_XAI_API_BASE_URL` es el ticket 14. Vertex: solo clave express (una cuenta de servicio sería un archivo). Tests: `HubWithEnvironments.aiDirect.test.ts`, `AntigravityDriver.test.ts`, Cursor `adapter.test.ts` y `driver.test.ts`, `DoorRules.test.ts`. Docs: `docs/internals/ai-gateway.md` «Direct credentials», `secrets.md`. Sin migración (118 sin usar). El selector (ticket 08) todavía no lista Cursor sin login de máquina: la prueba real abrió el turno por WS.
