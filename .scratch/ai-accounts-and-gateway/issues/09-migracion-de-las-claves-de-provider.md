# 09: Migración de las claves de provider de hoy

**What to build:** Al arrancar la versión nueva, las credenciales de IA que hoy viven en las provider instances (`settingsSecrets.ts`: variables de entorno sensibles `provider-env-*` y campos secretos como `AntigravitySettings.apiKey`) pasan a AI accounts permitidas solo al Personal space del Owner y se borran de la instance. El formulario de provider settings deja de aceptarlas. Ver spec, «Migración de lo que hay hoy».

**Blocked by:** 07.

**Status:** ready-for-agent

- [ ] Paso de arranque idempotente: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `CURSOR_API_KEY`, `KIRO_API_KEY`, `META_API_KEY`, `AI_GATEWAY_API_KEY`, `DEVIN_TOKEN` y `AntigravitySettings.apiKey` → AI account (tipo según la tabla del spec); el resto de variables sensibles se queda en la instance.
- [ ] Referencias de secret provider (1Password) se resuelven una vez; si no se puede, se dejan y Settings avisa.
- [ ] Formulario y RPC de settings rechazan esas variables y campos con un enlace a Settings → AI accounts (validación en el servidor, no solo en el cliente).
- [ ] Auditoría `ai_account.create` con vía `migration`.
- [ ] Red-first: tras migrar, ningún archivo de `secrets/` ni ajuste guarda la clave fuera de `ai-account-<id>`; `server.updateSettings` con `OPENAI_API_KEY` en una instance se rechaza; correr la migración dos veces no duplica cuentas.
- [ ] Puertas: WS de settings (`server.updateSettings` y `server.getSettings`), HttpApi gemela si existe; ninguna devuelve la clave migrada.
- [ ] Tests en `serverSettings.test.ts` y en un test de arranque con un estado de antes.
- [ ] Prueba real: un Hub dev con una instance de Claude con `ANTHROPIC_API_KEY`; tras actualizar, aparece la AI account «Claude (migrated)», la instance ya no la tiene y un turno del Owner funciona por la gateway.
