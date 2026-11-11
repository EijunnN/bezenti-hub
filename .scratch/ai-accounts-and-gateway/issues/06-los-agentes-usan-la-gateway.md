# 06: Los agentes usan la gateway

**What to build:** Cada turno de Claude Code, Codex, OpenCode y Pi en un Environment del Hub habla con la AI gateway: el Hub emite la gateway key del Thread al abrir la sesión, el executor contract sube de 10 a 11 con el campo `aiGateway`, el agente joined abre un relay en `127.0.0.1` que reenvía `/api/ai/*` al Hub (por el socket UNIX en Sandboxes y dedicadas, por la URL del Hub en máquinas personales), y cada driver pone sus variables. Los drivers arrancan con un home de configuración propio del Thread, sin logins ambientales. Ver spec, «Agentes por la gateway».

**Blocked by:** 04, spec 5 · 04 (contrato 10 y `secretEnv`).

**Status:** ready-for-agent

- [ ] `ENVIRONMENT_EXECUTOR_CONTRACT_VERSION` 10 → 11; `aiGateway` (forma, gateway key, AI account, modelo) en `provider.openSession`; ejecutor < 11 → «<máquina> needs an update to use the Hub's AI accounts». Campo omitido del registro de frames.
- [ ] Gateway key de Thread emitida al abrir la sesión, para (User que lanza el turno, Space, Thread); rotada en cada apertura; revocada al archivar o borrar el Thread.
- [ ] Relay en `EnvironmentAgent`: loopback, puerto aleatorio, solo `/api/ai/*`, sin guardar ni autenticar; por el socket UNIX del Hub en Sandboxes y dedicadas, por la URL del Hub en personales; ruta local en el Hub machine en proceso (desarrollo).
- [ ] Drivers: Claude (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, modelo), Codex (`-c model_providers.t3=…`, `env_key = T3_AI_GATEWAY_KEY`, `wire_api = "responses"`), OpenCode (provider inyectado con `baseURL`), Pi (provider propio con `baseUrl`). Las variables son reservadas (lista compartida del spec 5).
- [ ] Home de configuración por Thread en turnos del Hub (patrón `ClaudeHome`/`CodexHomeLayout`): sin `~/.claude`, `~/.codex/auth.json` ni logins del volumen del Sandbox. Logins de provider del spec 3 en volúmenes de Sandbox dejan de usarse (documentado en `docs/internals/sandboxes.md`).
- [ ] Red-first: con una login de Claude en el volumen del Sandbox y sin AI account permitida, el turno falla con «no AI account» y no usa la login; la key de un Thread de Acme no sirve desde un Thread de Globex; la key no aparece en `/proc/<pid>/cmdline`, logs ni spans; un ejecutor con contrato 10 recibe el error.
- [ ] Puertas: executor wire (`provider.openSession`), socket del Sandbox (el relay solo `/api/ai/*`), logs/OTLP/argv. Sin WS, HttpApi ni MCP nuevas.
- [ ] Tests en el testkit con runtime process y el CLIProxyAPI falso: turnos de Claude y Codex (Replay) que pasan por la gateway y dejan uso.
- [ ] Prueba real con Podman: un Member de Acme lanza un turno de Claude Code en el Sandbox contra la cuenta de prueba; Settings → Usage muestra la petición con su User, Space y Thread.
