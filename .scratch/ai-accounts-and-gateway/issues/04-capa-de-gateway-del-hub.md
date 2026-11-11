# 04: Capa de gateway del Hub

**What to build:** Las rutas `/api/ai/{openai,anthropic,gemini}/…` del Hub, delante de CLIProxyAPI. Autentican una gateway key (migración 113), comprueban en cada petición con `AllowedAiAccounts` que la cuenta está permitida a ese User en ese Space, reescriben el modelo a `acct-<id>/<modelo>`, reenvían con la client key del Hub, hacen el failover dentro del mismo proveedor solo entre cuentas permitidas y publican la cuenta en uso. Ver spec, «Capa de gateway del Hub».

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] Migración 113: `ai_gateway_keys` (hash SHA-256, tipo `thread` | `user`, User, Space, Thread, nombre, último uso, revocada). Formato `t3gk_…`.
- [ ] Rutas raw con las formas OpenAI (chat, responses, models), Claude (messages, count_tokens, models) y Gemini (generateContent, streamGenerateContent, models); SSE de ida y vuelta sin acumular; límite de tamaño; timeouts largos.
- [ ] Autenticación solo por gateway key (`Authorization`, `x-api-key`, `x-goog-api-key`); nunca cookie de sesión ni credencial de Environment.
- [ ] Enrutado: cuenta del Thread (o, con clave de User, la de mayor prioridad permitida que sirva el modelo) → comprobar allowance y modelo → `acct-<id>/<modelo>`. Failover ante cuota o 429 a la siguiente cuenta permitida del mismo proveedor y modelo; nunca entre proveedores; sin ninguna, error en la forma del cliente.
- [ ] `/models` filtrado a lo permitido.
- [ ] Evento de Thread cuando la cuenta en uso cambia.
- [ ] Red-first: clave revocada o de otro Space → 401/403; un Member de Acme no consume una cuenta permitida solo a Globex ni pidiendo `acct-<id>/…` a mano (el Hub reescribe siempre el modelo); una cookie de sesión válida sin key → 401; quitar una allowance corta la siguiente petición; el failover no salta a una cuenta no permitida aunque tenga cuota.
- [ ] Puertas: `RAW_ROUTE_RULES` para `/api/ai/*`, `AMBIENT_COOKIE_RULES` refused. Sin WS ni MCP en este ticket. Logs y spans con método, ruta, cuenta, modelo, estado y tokens; nunca cabeceras de auth, cuerpos ni prompts (test de humo).
- [ ] Tests con el CLIProxyAPI falso (formas, streaming, 429, failover) y en el testkit.
- [ ] Prueba real: con `curl` y una key de prueba, una petición Claude y otra OpenAI pasan por el Hub a la cuenta `openai-compatible` del ticket 02; con la allowance quitada, la siguiente da 403.
