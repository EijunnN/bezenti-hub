# Spec: AI accounts y AI gateway

Status: ready-for-agent
Map: ../multi-user-hub/map.md (spec 4 de 6; se construye después del spec 5)
Decisiones de origen: «Cuentas de IA», «Cierre del mapa» (`../multi-user-hub/issues/11`, `16`); investigación `../multi-user-hub/issues/01` (CLIProxyAPI y el gist de t3dotgg); decisiones del Owner del 2026-11-11 (abajo)
ADRs: 0002 (el Hub es la fuente de verdad), 0004 (un Sandbox por Space), 0005 (suscripciones compartidas por una AI gateway del Hub, riesgo de ToS aceptado), 0006 (el Hub guarda los Threads; los Environments ejecutan), 0007 (sin servicios de upstream)
Vocabulario: `GLOSSARY.md` (raíz) por encima de `docs/internals/glossary.md`: AI account, AI gateway
Depende de: specs 1, 2 y 3 (done) y spec 5 «Vaults» (almacén cifrado, entrega de variables y enmascarado)

## Decisiones del Owner (2026-11-11)

1. **CLIProxyAPI lo gestiona el Hub.** El Hub descarga una release fijada de CLIProxyAPI (binarios Go por plataforma, licencia MIT, con `checksums.txt` en cada release), la ejecuta como proceso hijo en loopback, escribe su configuración y la maneja por su Management API (`/v8/management`, protegida con una clave secreta). El Owner no toca nada fuera de Settings. Subir la versión fijada es una acción explícita del Owner.
2. **Los agentes que no aceptan una base URL propia solo usan modelos de la gateway, o una credencial de API revocable.** La cuenta de Google del Owner (Google AI Pro / Ultra) entra en CLIProxyAPI como cuenta OAuth «antigravity», y sus modelos (Gemini 3.x y, en los planes de pago, Claude Sonnet/Opus 5.5 por Antigravity) los usan los agentes que sí pasan por la gateway. El provider `agy` (Antigravity) solo se permite con una Gemini API key o una credencial de Vertex guardada como AI account; nunca con el token OAuth de Google del Owner, que no sale del Hub. Lo mismo para cualquier otro provider sin base URL.
3. **El uso se registra y se muestra, sin cupos:** tokens y peticiones por User, Space y AI account, visibles para el Owner. El spec 6 lo mostrará en la vista de procesos; este spec lo registra.

## Problem Statement

Hoy cada Environment usa las logins de provider que tenga: el Owner inicia sesión en Claude, Codex o Antigravity desde una terminal del Sandbox (spec 3) y esa sesión queda en el volumen, al alcance del agente de ese Space. Las API keys viven en las variables de entorno de cada provider instance (`settingsSecrets.ts`, `provider-env-*`) o en campos como `AntigravitySettings.apiKey`, y llegan a todos los Spaces que usan esa instance. No hay forma de decir «Acme puede usar la suscripción de Claude del Owner, Globex solo la API key de DeepSeek», ni de saber quién consume qué. Los CLIs locales del equipo no pueden usar las cuentas de la Installation. t3code solo lee el uso de un hub CLIProxyAPI externo (`apps/server/src/usage/cliproxyApi.ts`), pero no le enruta nada.

CLIProxyAPI (v8.0.67) resuelve la parte de los proveedores, pero:

- sus client keys (`access.api-keys`) son una lista plana, sin límite por clave de qué cuentas o modelos usa;
- quitó sus estadísticas de uso en v6.10 (solo queda una cola de vida corta);
- agrupa en pool todas las credenciales de un proveedor, sin saber de Users ni Spaces;
- publica varias releases al día.

Por eso no basta con ponerlo delante: las decisiones 2 y 8 de «Cuentas de IA» (un turno solo consume AI accounts permitidas a ese User en ese Space) no se pueden cumplir con CLIProxyAPI solo.

## Solution

- **AI accounts:** el Owner registra suscripciones (logins OAuth) y API keys en Settings → AI accounts, las ordena por prioridad y las permite a Spaces y Users. Las credenciales se guardan en el almacén cifrado del spec 5 y nunca salen del Hub, salvo las credenciales directas de la decisión 2.
- **CLIProxyAPI gestionado:** el Hub lo descarga, lo verifica, lo arranca en loopback y le escribe la configuración y las credenciales; el Owner solo ve su estado y lo actualiza desde Settings.
- **Capa de gateway del Hub:** delante de CLIProxyAPI, el Hub expone la AI gateway (`/api/ai/…`, formas OpenAI, Claude y Gemini). Autentica una **gateway key** por Thread o por User, decide qué AI accounts puede usar ese turno, fija la petición a una cuenta concreta (prefijo por cuenta en CLIProxyAPI), hace el failover dentro del mismo proveedor solo entre cuentas permitidas, y cuenta el uso.
- **Agentes:** cada turno recibe la URL de la gateway y la gateway key de su Thread. Claude Code, Codex, OpenCode y Pi apuntan a la gateway. Los providers sin base URL solo funcionan con una credencial directa revocable registrada como AI account, entregada como variable de entorno y enmascarada.
- **Thread:** arranca con la AI account permitida de mayor prioridad, muestra siempre la que está en uso y deja cambiarla a mitad de Thread (con traspaso de contexto si cambia de provider).
- **CLIs locales:** cada User crea en Settings su clave para apuntar Claude Code o Codex de su máquina a la URL del Hub.
- **Uso:** cada petición queda registrada con tokens, User, Space, Thread y AI account; el Owner lo ve en Settings.

## User Stories

### AI gateway gestionada

1. As the Owner, I want the Hub to download, verify and run a pinned CLIProxyAPI release by itself, so that I never install or configure it by hand.
2. As the Owner, I want CLIProxyAPI to listen only on the Hub's loopback, with its management API behind a key only the Hub knows, so that nobody, Sandboxes included, reaches it directly.
3. As the Owner, I want Settings → AI gateway to show its version, status, uptime and the newest release, so that I know it's healthy and current.
4. As the Owner, I want to update CLIProxyAPI to a newer release with one action, with the old version kept to roll back, so that upgrades are deliberate and reversible.
5. As the Owner, I want a crashed CLIProxyAPI to restart by itself and a failed start to show the reason in Settings, so that a gateway problem is never a mystery.
6. As the Owner, I want subscription tokens never stored in clear on the Hub's disk, so that the gateway is no weaker than the Vaults.

### AI accounts

7. As the Owner, I want to add an API-key AI account (Anthropic, OpenAI, Gemini, Vertex, xAI, Meta, or any OpenAI-compatible provider like DeepSeek or OpenRouter), so that the team can use it.
8. As the Owner, I want to add a subscription AI account (Claude, ChatGPT/Codex, Antigravity, Kimi, xAI, Devin, Meta) by signing in from Settings, even with the Hub on a VPS, so that I share my subscriptions with the team.
9. As the Owner, I want to see each AI account's status (working, needs sign-in again, quota exhausted, error) and its quota windows when the provider reports them, so that I know which ones work.
10. As the Owner, I want to order AI accounts by priority, so that new Threads and failovers use the right one first.
11. As the Owner, I want to allow each AI account to Spaces and to Users, so that I decide who can use what.
12. As the Owner, I want to rename, disable, replace the credential of, and delete an AI account, so that I can manage them over time.
13. As the Owner, I want a warning on Antigravity and on other subscriptions that sharing them may break the provider's terms, so that I accept the risk knowingly (ADR 0005).
14. As the Owner, I want AI account credentials never revealed by any screen, only replaced, so that they never leave the Hub.
15. As the Owner, I want every create, change, allowance, sign-in and delete recorded in the audit log, so that I can trace them.

### Agentes por la gateway

16. As a Member, I want my Thread's agent (Claude Code, Codex, OpenCode, Pi) to reach the AI accounts through the Hub without any login inside the Sandbox, so that real credentials never enter it.
17. As a Member, I want my turn to use only AI accounts allowed to me or to my Space, so that I never consume an account I'm not allowed.
18. As a Member, I want a quota-exhausted subscription to fail over to another allowed account of the same provider and model, and to see which one is now in use, so that my turn continues.
19. As a Member, I want a clear error when no allowed account of that provider has quota left, telling me to switch AI account, so that I'm not stuck.
20. As the Owner, I want each Thread's gateway key to stop working as soon as the Thread moves Space, its User is removed or its allowance is gone, so that a leaked key is short-lived.
21. As the Owner, I want agents on personal and dedicated machines to use the gateway too, so that AI accounts and their rules are the same everywhere.
22. As the Owner, I want ambient provider logins on a machine (a User's own `~/.claude`, a Sandbox volume login from spec 3) never used by Hub turns, so that every turn goes through AI accounts.

### Providers sin base URL

23. As the Owner, I want Antigravity (`agy`), Cursor and other providers that can't point at the gateway to be usable only with a revocable API credential registered as an AI account, so that no subscription login enters a Sandbox.
24. As the Owner, I want my Google account to be usable by the gateway's agents as an «antigravity» AI account and never handed to `agy`, so that the token stays in the Hub.
25. As a Member, I want such a direct credential masked as `[NAME]` in the history, like a Vault secret, so that it never shows.
26. As the Owner, I want the AI-account form to say when a credential will be visible to the agent, so that I know which ones enter Sandboxes.

### Thread y selector

27. As a Member, I want a new Thread to start with the highest-priority AI account allowed to me in that Space, so that I don't have to choose.
28. As a Member, I want an AI-account picker in the composer listing only allowed accounts and their models, so that I choose what I may use.
29. As a Member, I want to switch AI account mid-Thread, with a context handoff when the provider changes, so that I can continue on another account.
30. As a Member, I want the Thread header to always show the AI account and model in use, so that I know what I'm consuming.

### CLIs locales

31. As a User, I want to create a personal gateway key for one of my Spaces in Settings, with copyable setup for Claude Code (`settings.json`) and Codex (`config.toml`), so that my local CLI uses the Installation's AI accounts.
32. As a User, I want to list, name and revoke my keys, and see when each was last used, so that I control them.
33. As the Owner, I want local-CLI usage counted per User, Space and AI account like Thread usage, so that I see all consumption.

### Uso

34. As the Owner, I want tokens and requests recorded per User, Space, Thread and AI account, so that I know who uses what.
35. As the Owner, I want Settings → AI accounts → Usage with totals by day, User, Space and AI account, so that I can read it without the process view.
36. As a Member, I want to see my own Thread's token usage, so that I know what a Thread costs.

### Migración y cambios de Space

37. As the Owner, I want today's provider API keys and the Antigravity API key moved into AI accounts on upgrade, so that nothing is lost and no key stays in provider settings.
38. As the Owner, I want the provider settings form to refuse AI credentials in environment variables and point to AI accounts, so that keys don't go back there.
39. As the Owner, I want moving a Project to another Space to switch its Threads to the destination's allowed AI accounts and revoke the old gateway keys, so that the Project stops consuming the origin's accounts.

### Clientes

40. As the Owner on web or desktop, I want Settings → AI accounts and Settings → AI gateway, so that I manage everything there.
41. As a User on web, desktop or mobile, I want the AI-account picker and the account in use on every Thread, so that I see the same on any device.
42. As the Owner on mobile, I want to see AI accounts, their status and usage, so that I can check them on the go; signing in to a subscription stays on web or desktop.

## Implementation Decisions

### CLIProxyAPI gestionado

- **Release fijada:** el repo fija versión y SHA-256 de cada archivo por plataforma (`linux-amd64`, `linux-arm64`, `darwin-amd64`, `darwin-arm64`; Windows solo para desarrollo). El Hub descarga de las releases de GitHub del proyecto, comprueba el hash fijado y el `checksums.txt` de la release, y descomprime en `<stateDir>/ai-gateway/bin/<versión>/`. Nunca ejecuta un binario sin verificar.
- **Actualizar:** Settings → AI gateway muestra la versión fijada y la última release (consulta a GitHub solo cuando el Owner abre la sección o pulsa «Check for updates»; ADR 0007: ningún servicio de upstream por defecto). «Update to vX» descarga, verifica contra el `checksums.txt` de esa release, arranca la nueva en un puerto aparte, hace la prueba de salud y de modelos, cambia y conserva la anterior para «Roll back». Auditoría `ai_gateway.update`.
- **Proceso:** hijo del Hub, con el usuario del Hub, `host: 127.0.0.1`, puerto libre elegido por el Hub. Se reinicia con backoff si muere. Su stdout/stderr pasan por el filtro de secretos antes de los logs del Hub.
- **Configuración:** la escribe el Hub (`config.yaml`, 0600), nunca el Owner:
  - `remote-management.allow-remote: false`, panel de control desactivado, `secret-key` aleatoria guardada en el almacén cifrado (la Management API solo la usa el Hub);
  - una sola client key en `access.api-keys`, aleatoria, del Hub (la capa de gateway es el único cliente);
  - estadísticas internas y logs de peticiones desactivados (el uso lo cuenta el Hub; los logs de peticiones guardarían prompts);
  - cada AI account con un `prefix` propio (`acct-<id>`), para que el Hub pueda fijar una petición a una cuenta (`acct-<id>/<modelo>`);
  - prioridad y estrategia de pool de CLIProxyAPI, desactivadas en la práctica: el Hub siempre fija la cuenta.
- **Secretos en argumentos:** ninguno. La clave de gestión y la client key van en el archivo de configuración; el binario se lanza solo con `-config <ruta>`.
- **Credenciales OAuth en disco:** CLIProxyAPI guarda los tokens OAuth como JSON en su `auth-dir`. El Hub lo pone en un directorio 0700 en memoria (`$XDG_RUNTIME_DIR` o `/dev/shm`), escribe ahí los tokens desde el almacén cifrado al arrancar, y recoge los tokens que CLIProxyAPI refresca (Management API, al cambiar y cada pocos minutos) para volver a cifrarlos. Si no hay tmpfs, usa `<stateDir>/ai-gateway/auth` (0700) y Settings lo avisa.
- **Usuario de la Management API:** un cliente HTTP del Hub en `ai/CliproxyManagement.ts`; nada más habla con CLIProxyAPI. El lector de cuotas existente (`usage/cliproxyApi.ts`) se reutiliza contra la gateway gestionada para mostrar las ventanas de cuota de cada suscripción. Las `usageLimitSources` de tipo cliproxy que apunten a un hub externo siguen funcionando, sin cambios.

### AI accounts

- Migración **112** (`ai_accounts`):
  - `ai_accounts`: id, nombre, tipo (`subscription` | `api-key` | `direct`), proveedor (`claude`, `codex`, `antigravity`, `kimi`, `xai`, `devin`, `meta`, `gemini`, `vertex`, `openai-compatible`, `cursor`, `kiro`, `fx`, …), prioridad, estado, deshabilitada, fechas, creada por. Para `openai-compatible`: base URL y lista de modelos.
  - `ai_account_allowances`: cuenta y sujeto (`space` | `user`).
  - Columna `aiAccountId` en la elección de modelo del Thread (`modelSelection`), junto a `instanceId`.
- **Credenciales:** en el almacén cifrado del spec 5 (`ai-account-<id>`). Ninguna puerta las devuelve, ni al Owner: solo se sustituyen.
- **Tipos:**
  - **Suscripción (OAuth en CLIProxyAPI):** Claude, Codex (ChatGPT), Antigravity (Google AI Pro/Ultra), Kimi, xAI, Devin, Meta. Vertex por importación de cuenta de servicio.
  - **API key por la gateway:** Anthropic (`claude`), OpenAI (`codex`), Gemini, Vertex, xAI, Meta, y `openai-compatible` (DeepSeek, OpenRouter…). Nunca entran en un Sandbox.
  - **Directa:** credencial que se entrega al agente porque su provider no acepta base URL (ver tabla). Solo API keys o cuentas de servicio revocables; nunca un login de suscripción.
- **Inicio de sesión de suscripciones:** por la Management API (URL de autorización del proveedor). Como el Hub vive en un VPS, la redirección del proveedor a `localhost` falla en el navegador del Owner: el diálogo pide pegar la URL a la que llegó («Paste the address you landed on») y el Hub la entrega a CLIProxyAPI. El estado de cada cuenta se lee de la Management API (token caducado → «Sign in again»).
- **Antigravity:** al añadirla, el diálogo muestra el aviso de ToS del ADR 0005 y que CLIProxyAPI aplica opciones de ofuscación a Antigravity (endurecidas en v8.0.65), señal de que Google detecta este uso. El Hub deja esas opciones en el valor por defecto de la release fijada.
- **Quién hace qué:** solo el Owner crea, edita, ordena, permite y borra AI accounts (Installation RPCs). Admins, Members y Guests ven nombre, proveedor y estado de las AI accounts que pueden usar en sus Spaces, nunca las demás.

### Capa de gateway del Hub

- **Rutas** (raw routes del Hub, `RAW_ROUTE_RULES`), formas que CLIProxyAPI ya habla:
  - `/api/ai/openai/v1/chat/completions`, `/api/ai/openai/v1/responses`, `/api/ai/openai/v1/models`;
  - `/api/ai/anthropic/v1/messages`, `/api/ai/anthropic/v1/messages/count_tokens`, `/api/ai/anthropic/v1/models`;
  - `/api/ai/gemini/v1beta/models/{modelo}:generateContent` y `:streamGenerateContent`, `/api/ai/gemini/v1beta/models`.
  - Streaming SSE de ida y vuelta sin acumular; límite de tamaño de petición; timeouts largos.
- **Autenticación:** solo gateway key en `Authorization: Bearer`, `x-api-key` o `x-goog-api-key`, según la forma. Nunca cookie de sesión (`AMBIENT_COOKIE_RULES`: refused) ni credencial de Environment.
- **Gateway keys** (migración **113**, `ai_gateway_keys`): id, hash SHA-256 (nunca la clave), tipo (`thread` | `user`), User, Space, Thread (si es de Thread), nombre, creada, último uso, revocada. Formato `t3gk_<32 bytes base64url>`.
  - **De Thread:** la emite el Hub al abrir la sesión del provider; vale para (User que lanza el turno, Space del Thread, Thread). Se revoca al mover el Thread de Space, al quitar al User, al archivar o borrar el Thread, y se rota en cada apertura de sesión.
  - **De User:** para CLIs locales, ligada a un Space que el User elige (por defecto su Personal space). Se revoca a mano, al quitar al User o si pierde el Space.
- **Cuentas permitidas (una sola regla):** `AllowedAiAccounts.for(userId, spaceId)` = cuentas no deshabilitadas permitidas al Space ∪ permitidas al User, siempre que el User tenga derecho a trabajar en ese Space. La usan la gateway, el selector, el defecto de un Thread nuevo y el plan de mover Project. Se evalúa en cada petición, no al emitir la clave: quitar una allowance tiene efecto en la siguiente petición.
- **Enrutado:**
  1. El Hub lee el modelo pedido y la AI account elegida del Thread (o, en una clave de User, la de mayor prioridad permitida que sirva ese modelo).
  2. Comprueba que esa cuenta está en `AllowedAiAccounts` y que sirve el modelo (catálogo de `/v1/models` de su prefijo, en caché).
  3. Reescribe el modelo a `acct-<id>/<modelo>` y reenvía a CLIProxyAPI con la client key del Hub.
  4. Si CLIProxyAPI responde cuota agotada o límite de tasa de esa cuenta, prueba la siguiente cuenta permitida del **mismo proveedor** que sirva el mismo modelo, por prioridad global; nunca cambia de proveedor (decisión 7). Si no queda ninguna, error claro con la forma del cliente («No allowed AI account for <proveedor> has quota left; switch AI account»).
  5. Si la cuenta usada cambió, publica un evento de Thread para que el header muestre la cuenta en uso.
- **Por qué el pool lo hace el Hub:** el pool de CLIProxyAPI mezcla todas las credenciales de un proveedor y no se puede limitar por client key; con prefijos fijos y failover en el Hub se cumplen a la vez la prioridad global (decisión 5), el salto dentro del mismo proveedor (7) y que un turno solo consume cuentas permitidas (8).
- **Logs y trazas:** la capa registra método, ruta, cuenta, modelo, estado y tokens; nunca cabeceras de autenticación, cuerpos ni prompts. Los spans OTLP llevan los mismos atributos.

### Uso

- Migración **114** (`ai_usage`): una fila por petición (hora, User, Space, Thread o nulo, gateway key, AI account, proveedor, modelo, tokens de entrada, salida, caché de lectura y de escritura, estado, duración) y un resumen diario por (día, User, Space, AI account, modelo).
- Los tokens salen de la respuesta (campo `usage` final de cada forma, también en streaming). Si una respuesta no trae uso, cuenta la petición con tokens desconocidos.
- Las filas por petición se guardan 90 días; los resúmenes diarios, siempre (pregunta abierta 4).
- Las credenciales directas no pasan por la gateway: su uso no se cuenta aquí; el Thread muestra el uso que su provider ya informa (lectores de uso existentes).
- RPC de lectura para el Owner (`aiUsage.summary`) que el spec 6 reutilizará. Cada User ve el uso de sus propios Threads; Admins, el de su Space (para el spec 6).

### Agentes por la gateway

- **Executor contract 10 → 11:** `provider.openSession` lleva `aiGateway` (forma, base URL local, gateway key del Thread, AI account y modelo) y, para credenciales directas, entradas extra de `secretEnv` (spec 5). Un ejecutor < 11 recibe «<máquina> needs an update to use the Hub's AI accounts».
- **Relay local:** el agente joined abre un relay HTTP en `127.0.0.1` (puerto aleatorio por máquina) que reenvía `/api/ai/*` al Hub: en un Sandbox o máquina dedicada, por el socket UNIX del Hub (la única ruta al Hub, spec 3); en una máquina personal, por la URL del Hub. El relay no autentica ni guarda nada: la gateway key sigue siendo necesaria. En el Hub machine en proceso (desarrollo), el relay es la propia ruta local.
- **Variables por provider** (el driver las pone en el entorno del proceso; reservadas en la lista compartida del spec 5):

| Provider (driver)                  | Camino                                                                                                                                                                        | Cómo                                                                                                                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code (`claudeAgent`)        | Gateway                                                                                                                                                                       | `ANTHROPIC_BASE_URL` = relay `/api/ai/anthropic`, `ANTHROPIC_AUTH_TOKEN` = gateway key, `ANTHROPIC_MODEL` según el selector                                                                                                  |
| Codex (`codex`)                    | Gateway                                                                                                                                                                       | provider de modelo propio por `-c model_providers.t3=…` (`base_url` = relay `/api/ai/openai/v1`, `env_key` = `T3_AI_GATEWAY_KEY`, `wire_api = "responses"`)                                                                  |
| OpenCode (`opencode`)              | Gateway                                                                                                                                                                       | configuración de provider inyectada por el driver con `baseURL` del relay y la key                                                                                                                                           |
| Pi (`pi`)                          | Gateway                                                                                                                                                                       | provider propio en su configuración de modelos con `baseUrl` del relay                                                                                                                                                       |
| Grok (`grok`)                      | Directa con `XAI_API_KEY` (ticket 07: con una API key, Grok CLI 1.0.77 ignora `GROK_CLI_CHAT_PROXY_BASE_URL`; la gateway con `GROK_XAI_API_BASE_URL` queda para el ticket 14) |                                                                                                                                                                                                                              |
| Antigravity (`agy`, `antigravity`) | Directa                                                                                                                                                                       | solo métodos «Gemini API key» (`GEMINI_API_KEY`) y «Vertex» (clave express de Vertex AI, `GOOGLE_API_KEY`; una cuenta de servicio sería un archivo); «Google account» y «Gemini Enterprise» deshabilitados en turnos del Hub |
| Cursor (`cursor`)                  | Directa                                                                                                                                                                       | `CURSOR_API_KEY`                                                                                                                                                                                                             |
| Kiro (`kiro`)                      | Directa                                                                                                                                                                       | `KIRO_API_KEY`                                                                                                                                                                                                               |
| Fx (`fx`)                          | Directa                                                                                                                                                                       | `AI_GATEWAY_API_KEY` (Vercel AI Gateway)                                                                                                                                                                                     |
| Muse (`muse`)                      | Directa                                                                                                                                                                       | `META_API_KEY`                                                                                                                                                                                                               |
| ACP Registry (`acpRegistry`)       | Directa solo para agentes con una credencial de API conocida (Devin: `DEVIN_TOKEN`); el resto no se ofrece en turnos del Hub                                                  |                                                                                                                                                                                                                              |

- **Sin logins ambientales:** en turnos del Hub, cada driver arranca su CLI con un home de configuración propio del Thread (patrón de `CodexHomeLayout`/`ClaudeHome`), sin las credenciales del usuario del sistema ni las del volumen del Sandbox. Las logins de provider del spec 3 en los volúmenes de Sandbox dejan de usarse; el login de ChatGPT gestionado de Codex (`CodexChatGptAuth`, `CodexManagedTokenBroker`) y el login de Google de Antigravity (`AntigravityAuth`) no se ofrecen en Environments del Hub (la suscripción entra como AI account).
- **Credenciales directas:** se entregan por `secretEnv` (spec 5, ticket 04), solo al proceso del provider de un Thread cuya AI account elegida es esa, y el `SecretMasker` las enmascara como `[NOMBRE_DE_VARIABLE]`. Se cuentan en el panel «Secrets» del Thread como «AI account credential».

### Thread y selector

- Un Thread nuevo arranca con la AI account de mayor prioridad de `AllowedAiAccounts` compatible con el provider elegido; si no hay ninguna, el composer lo dice antes de enviar.
- El selector del composer muestra, por provider instance, las AI accounts permitidas y los modelos de cada una (de la gateway: el catálogo del prefijo; de las directas: el catálogo del provider). Los agentes por la gateway pueden usar modelos de otras familias si CLIProxyAPI los traduce (p. ej. Claude Code con Gemini 3 por la cuenta antigravity).
- Cambiar de AI account dentro del mismo provider cambia el enrutado desde la siguiente petición; cambiar de provider usa el traspaso de contexto del spec 2 (ticket 09).
- El header del Thread muestra la AI account y el modelo en uso, incluido tras un failover.

### CLIs locales

- Settings → AI accounts → «Local CLI keys»: crear (nombre, Space), ver una sola vez, revocar, último uso. Cada User solo ve las suyas; el Owner ve todas y puede revocarlas.
- Instrucciones copiables con la URL pública del Hub: Claude Code (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` en `settings.json`) y Codex (`model_providers` en `config.toml`). Sin modelo elegido, la gateway usa la cuenta permitida de mayor prioridad que sirva el modelo pedido.
- Auditoría `ai_gateway_key.create`, `ai_gateway_key.revoke`.

### Migración de lo que hay hoy

- Al arrancar la versión nueva, por cada provider instance:
  - Variables de entorno sensibles que son credenciales de IA conocidas (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `CURSOR_API_KEY`, `KIRO_API_KEY`, `META_API_KEY`, `AI_GATEWAY_API_KEY`, `DEVIN_TOKEN`) y el campo `AntigravitySettings.apiKey`: pasan a una AI account (tipo según la tabla), permitida solo al Personal space del Owner, y se borran de la instance.
  - Las demás variables sensibles se quedan en la instance (ya cifradas por el spec 5).
  - Referencias a un secret provider (1Password) en esos campos: se resuelven una vez y se guardan como AI account; si no se pueden resolver, se dejan y Settings avisa.
- El formulario de provider settings rechaza esas variables y enlaza a Settings → AI accounts.
- Auditoría `ai_account.create` con vía `migration`.

### Cambio de Space de un Project y bajas

- El plan de mover Project (spec 3, ticket 12) añade `aiAccountsLost`: AI accounts elegidas por sus Threads que el destino no permite.
- Al mover: se revocan las gateway keys de los Threads, y cada Thread cuya AI account no está permitida en el destino pasa a la de mayor prioridad permitida allí (o a «needs an AI account» si no hay).
- Quitar un User: se revocan sus gateway keys. Quitar una allowance: efecto en la siguiente petición.

### Puertas

| Puerta                           | Qué se declara                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS (`RPC_SPACE_ACCESS`)          | `aiAccounts.list` (filtrada por lo permitido), `aiAccounts.create/update/delete/allow/reorder`, `aiAccounts.login.start/complete` (Installation, solo Owner), `aiGateway.status/checkForUpdates/update/rollback` (solo Owner), `aiGatewayKeys.list/create/revoke` (propias; Owner todas), `aiUsage.summary`, `thread.setAiAccount` (regla de `thread.continue`) |
| HttpApi (`HTTP_ENDPOINT_RULES`)  | ninguna nueva, salvo gemelas de las RPC si existen                                                                                                                                                                                                                                                                                                              |
| Raw routes (`RAW_ROUTE_RULES`)   | `/api/ai/*`: solo gateway key válida, no revocada, con `AllowedAiAccounts` en cada petición                                                                                                                                                                                                                                                                     |
| Cookies (`AMBIENT_COOKIE_RULES`) | `/api/ai/*`: refused                                                                                                                                                                                                                                                                                                                                            |
| MCP (`MCP_TOOL_RULES`)           | ninguna herramienta nueva; ninguna existente devuelve credenciales ni gateway keys                                                                                                                                                                                                                                                                              |
| Executor wire                    | `aiGateway` solo en `provider.openSession` hacia la Active environment del Thread; omitido del registro de frames                                                                                                                                                                                                                                               |
| Socket del Sandbox               | el relay solo reenvía `/api/ai/*`                                                                                                                                                                                                                                                                                                                               |
| Logs, OTLP, argumentos           | sin credenciales, gateway keys, management key ni prompts; CLIProxyAPI arrancado solo con `-config`                                                                                                                                                                                                                                                             |
| CLIProxyAPI                      | solo loopback; Management API solo desde el Hub; nada de Sandboxes                                                                                                                                                                                                                                                                                              |

### Clientes

- **Web y desktop:** Settings → AI accounts (lista por prioridad con arrastrar, estado, cuotas, allowances, «Sign in again», «Replace credential», aviso de ToS, pestaña «Usage», «Local CLI keys»); Settings → AI gateway (versión, estado, «Check for updates», «Update», «Roll back», aviso si no hay tmpfs). Selector de AI account en el composer y la cuenta en uso en el header del Thread.
- **Móvil:** selector y header en el Thread; Settings con AI accounts (estado y uso, solo lectura) y «Local CLI keys» propias. Iniciar sesión en suscripciones y actualizar la gateway solo en web o desktop.

### Auditoría

- Nuevas en la allow-list: `ai_account.create`, `ai_account.update`, `ai_account.delete`, `ai_account.allow`, `ai_account.login`, `ai_gateway.update`, `ai_gateway.rollback`, `ai_gateway_key.create`, `ai_gateway_key.revoke`.
- Detalle permitido: id y nombre de la cuenta, proveedor, tipo, versión de la gateway. Nunca credenciales ni gateway keys.

## Testing Decisions

- **Un test bueno** comprueba lo que ve un User, el Owner, un agente o un CLI local por interfaces públicas: RPC WS, rutas `/api/ai/*`, el protocolo del Environment y el entorno real del proceso del provider. Red-first en toda regla de seguridad.
- **CLIProxyAPI falso:** un servidor HTTP de test que imita las formas que el Hub usa (Management API, `/v1/models`, chat, messages, generateContent, cuotas y 429) para los tests rápidos. El gestor del proceso se prueba con un binario de test que hace de CLIProxyAPI.
- **CLIProxyAPI real:** un grupo pequeño de tests de integración que descarga la versión fijada (solo si hay red; se saltan si no) y comprueba arranque en loopback, configuración, prefijos y una API key `openai-compatible` contra un servidor falso de proveedor.
- **Seam principal:** el testkit «Hub con Environments» con runtime process y el CLIProxyAPI falso: turnos de Claude y Codex con la gateway, cuentas permitidas por User y Space, failover dentro del mismo proveedor, error sin cuota, revocación de keys, uso registrado, credenciales directas enmascaradas, migración de claves de provider, mover un Project.
- **Inventario:** `DoorRules.test.ts` (rutas, cookies) y `RpcAuthorization.test.ts`.
- **Fugas:** test de humo que busca credenciales, management key y gateway keys en logs, spans, `/proc/*/cmdline` (Hub, CLIProxyAPI, máquina joined) y archivos del Hub fuera del almacén cifrado y del `auth-dir` en memoria.
- **Prior art:** `cliproxyApi.test.ts`, `UsageLimitSources.test.ts`, `ProviderInstanceRegistry*.test.ts`, `CodexDriver.test.ts`, `AntigravityDriver.test.ts`, `serverSettings.test.ts`, `HubWithEnvironments.*.test.ts`.
- **Prueba real por ticket de interfaz:** en WSL con Podman y el CLIProxyAPI real fijado. El Owner añade una API key `openai-compatible` (o una de prueba) y una suscripción si está disponible, la permite a Acme, un Member de Acme lanza un turno de Claude Code en el Sandbox que pasa por la gateway, Globex no la ve en el selector, y Settings → Usage muestra la petición.

## Out of Scope

- **Cuotas por User u Organization:** mejora futura (map). Aquí solo se registra y se muestra el uso.
- **Vista de procesos:** spec 6 (usa el uso que este spec registra).
- **Secretos usados sin que el agente los vea:** mejora futura; las credenciales directas sí entran en el Sandbox (ADR 0005, consecuencias).
- **Copiar la sesión nativa entre máquinas:** mejora futura; cambiar de provider usa el traspaso del spec 2.
- **Que CLIProxyAPI publique estadísticas propias o límites por client key:** no se depende de ello.

## Further Notes

- **Riesgo de ToS aceptado (ADR 0005):** compartir las suscripciones del Owner incumple los términos de Anthropic, OpenAI y Google; el VPS usa IPs de datacenter. Las opciones de ofuscación de Antigravity en CLIProxyAPI, endurecidas en v8.0.65, indican que Google detecta y puede suspender este uso. Las API keys y los planes por asiento son la alternativa conforme.
- **Releases muy frecuentes de CLIProxyAPI:** por eso la versión está fijada y el Owner actualiza a mano, con vuelta atrás.
- **Un solo punto de fallo:** si CLIProxyAPI cae, ningún agente por la gateway trabaja; el Hub lo reinicia y lo muestra.
- **Orden sugerido para los tickets:**
  1. CLIProxyAPI gestionado por el Hub.
  2. AI accounts de API key.
  3. AI accounts de suscripción.
  4. Capa de gateway: gateway keys, cuentas permitidas y enrutado.
  5. Registro de uso.
  6. Los agentes usan la gateway (contrato 11, relay).
  7. Providers sin base URL: credenciales directas.
  8. Selector de AI account en el Thread.
  9. Migración de las claves de provider de hoy.
  10. Claves para CLIs locales.
  11. Cambio de Space de un Project y bajas.
  12. Clientes: desktop y móvil.
  13. Inventario de puertas y pase completo.

- **Excepción conocida a «sin servicios de upstream» (ADR 0007, ticket 02):** CLIProxyAPI 8.0.67, aun con `-local-model`, consulta cada 3 h la última versión del cliente de Antigravity y la del Grok CLI en npm. La release fijada no tiene opción para apagarlo y un proxy limitado al proceso también llevaría el tráfico a los proveedores. Se acepta (no llevan credenciales, prompts ni cuentas; solo revelan la IP del Hub) y se revisa en cada subida de la versión fijada.
- **Riesgo aceptado, endurecimiento posterior (revisión del ticket 01):** CLIProxyAPI corre con el usuario del Hub y podría leer su `stateDir`. Se acepta solo porque el Hub ejecuta únicamente versiones fijadas en el repo con su SHA-256 y verificadas por él. Ticket posterior: ejecutar CLIProxyAPI en su propio contenedor rootless de Podman o con su propio uid.

## Preguntas abiertas (decididas)

El Owner aceptó todas las recomendaciones el 2026-11-11; cada «Recomendación» de abajo es la decisión.

1. **Grok, Fx, Muse y Kiro:** el código no deja claro si sus CLIs aceptan una base URL propia para el chat. Recomendación: tratarlos como «directa» (tabla) salvo Grok, que el ticket 07 prueba con `GROK_CLI_CHAT_PROXY_BASE_URL`; si funciona, pasa a la gateway. **Resultado (ticket 07, Grok CLI 1.0.77 contra un upstream falso):** `GROK_CLI_CHAT_PROXY_BASE_URL` solo enruta el chat en modo de token de sesión (`GROK_AUTH_PROVIDER_COMMAND`, que además pide `/v1/user`, `/v1/settings` y bundles); con `XAI_API_KEY` el CLI lo ignora y va a `api.x.ai`. Grok queda directa con `XAI_API_KEY`. `XAI_API_KEY` + `GROK_XAI_API_BASE_URL` sí llega a una base propia (`/v1/models`, `/v1/api-key`, `/v1/chat/completions`): ticket 14.
2. **¿A qué Space va el uso de una clave de CLI local?** Recomendación: cada clave se ata a un Space al crearla (por defecto el Personal space) y su uso cuenta en ese Space; un User con varios Spaces crea una clave por Space.
3. **Plataformas de CLIProxyAPI gestionado.** Recomendación: Linux amd64/arm64 y macOS en producción; Windows solo para desarrollo (el Hub de producción vive en un VPS Linux).
4. **Retención del uso.** Recomendación: filas por petición 90 días, resúmenes diarios siempre; el Owner puede borrar el detalle antes desde Settings.
5. **¿Un Thread de un Guest usa AI accounts?** La decisión 8 lo permite si están permitidas a ese User o a su Space. Recomendación: sí, con la misma regla; el Owner limita a los Guests no permitiéndoles cuentas a título de User y eligiendo bien las del Space.
