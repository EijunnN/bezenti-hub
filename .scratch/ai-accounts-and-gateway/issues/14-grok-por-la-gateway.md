# 14: Grok por la gateway con GROK_XAI_API_BASE_URL

**What to build:** Que los turnos del Hub de Grok (`grok`) pasen por la AI gateway en vez de recibir una credencial directa `XAI_API_KEY`. El ticket 07 comprobó (Grok CLI 1.0.77, servidor falso) que `GROK_CLI_CHAT_PROXY_BASE_URL` solo enruta el chat en modo de token de sesión (`GROK_AUTH_PROVIDER_COMMAND`, que además llama a `/v1/user`, `/v1/settings`, `/v1/bundle/archive` y `/v1/subagents/bundle`) y que con `XAI_API_KEY` el CLI lo ignora y va a `api.x.ai`. En cambio `XAI_API_KEY=<gateway key>` con `GROK_XAI_API_BASE_URL=<relay>/api/ai/openai/v1` sí llega a una base propia: `GET /v1/models`, `GET /v1/api-key` y `POST /v1/chat/completions` (streaming). Ver `docs/internals/ai-gateway.md`, «Direct credentials».

**Blocked by:** 07.

**Status:** ready-for-agent

- [ ] Volver a probar con la versión del Grok CLI de ese momento: qué pide a la base (`/v1/models`, `/v1/api-key`, chat, ¿responses?) y qué hace si `/v1/api-key` responde 404 o una forma mínima.
- [ ] La capa de gateway responde lo que el CLI necesita sin llegar a CLIProxyAPI cuando no es una petición de modelo (`/v1/api-key` con datos de la gateway key, nunca de una cuenta), y enruta el chat a una AI account permitida de proveedor `xai` (o de otro proveedor si CLIProxyAPI lo traduce).
- [ ] `grok` sale de `AI_DIRECT_DRIVERS` y entra en `AI_GATEWAY_DRIVERS`; el driver pone `XAI_API_KEY` (la gateway key), `GROK_XAI_API_BASE_URL` (relay) y un `GROK_HOME` propio del Thread; las variables van a la lista reservada del spec 5 y a `AI_GATEWAY_ENV_NAMES`.
- [ ] Las AI accounts directas de `xai` existentes siguen funcionando hasta que el Owner las cambie, o se migran (decidir y documentar).
- [ ] Red-first en el testkit: un turno de Grok en un Sandbox usa la gateway key del Thread y nunca una credencial de xAI; uso registrado; Globex no la usa.
- [ ] Prueba real con el Grok CLI instalado y el CLIProxyAPI real (o un upstream falso de xAI).
