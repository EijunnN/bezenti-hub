# 02: AI accounts de API key

**What to build:** Modelo de AI accounts (migración 112), el registro de API keys por el Owner (Anthropic, OpenAI, Gemini, Vertex, xAI, Meta y `openai-compatible` con base URL y modelos), su prioridad y sus allowances a Spaces y Users. Las credenciales van al almacén cifrado y se sincronizan con la configuración de CLIProxyAPI, cada cuenta con su `prefix` `acct-<id>`. Ver spec, «AI accounts».

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] Migración 112: `ai_accounts` (tipo, proveedor, prioridad, estado, deshabilitada, base URL y modelos para `openai-compatible`), `ai_account_allowances`, columna `aiAccountId` en la elección de modelo del Thread.
- [ ] Credencial en el almacén cifrado (`ai-account-<id>`); ninguna puerta la devuelve, ni al Owner: solo «Replace credential».
- [ ] Sincronización con CLIProxyAPI por la Management API (o reescritura de config y recarga): cada cuenta con `prefix: acct-<id>`; deshabilitar o borrar la quita.
- [ ] Catálogo de modelos por cuenta (`/v1/models` del prefijo), en caché, para el selector y la gateway.
- [ ] `AllowedAiAccounts.for(userId, spaceId)`: Space ∪ User, sin deshabilitadas, solo si el User trabaja en ese Space. Único sitio que lo calcula.
- [ ] Red-first, con Owner, Admin, Member y Guest de dos Organizations: solo el Owner crea, edita, ordena, permite y borra; `aiAccounts.list` a un Member de Acme no incluye cuentas solo de Globex ni campos de credencial; una sesión con `spaceLimit` no ve cuentas de otro Space.
- [ ] Puertas: WS `aiAccounts.list`, `aiAccounts.create`, `aiAccounts.update`, `aiAccounts.delete`, `aiAccounts.allow`, `aiAccounts.reorder` en `RPC_SPACE_ACCESS`. Sin HttpApi, raw routes ni MCP. Credenciales fuera de logs, spans y argv (test de humo).
- [ ] Auditoría `ai_account.create`, `ai_account.update`, `ai_account.delete`, `ai_account.allow`, sin credenciales.
- [ ] Web/desktop: Settings → AI accounts (lista por prioridad, añadir API key, allowances, estado). Nombres accesibles entregados.
- [ ] Prueba real: el Owner añade una cuenta `openai-compatible` contra un servidor falso de proveedor, la permite a Acme; el `config.yaml` de CLIProxyAPI tiene el prefijo y no hay rastro de la clave fuera del almacén y el config 0600.
