# 01 · Cómo plugar suscripciones y APIs (CLIProxyAPI + gist de t3dotgg)

Investigado el 2026-11-04. Fuentes primarias: el gist (raw, 242 líneas), el repo `router-for-me/CLIProxyAPI` (README, `config.example.yaml`, `cmd/server/main.go` en `main`, release `v8.0.55` publicada el 2026-11-04 según la API de GitHub), las páginas legales de Anthropic/OpenAI/DeepSeek y el código/docs de este repo. Esto son hechos, no una decisión.

## 1. Qué propone el gist

- Idea: iniciar sesión con todas las cuentas Claude y Codex en **una sola máquina doméstica siempre encendida** que ejecuta CLIProxyAPI, que "keeps the auth fresh and gives me one API endpoint". El resto de máquinas apuntan a ella por Tailscale ([gist:5](https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af)).
- Cubre **solo Claude y Codex** (y T3 Code como consumidor). No menciona Gemini ni APIs de pago (gist:1-5, 154-163).
- Config mínima (v8): bind `127.0.0.1:8317`, `management.secret-key`, `access.api-keys` (la clave que mandan los clientes), `routing.strategy: round-robin` + `session-affinity: true` (gist:119-137). Servicio systemd con linger o `brew services` (gist:143-152).
- Logins en el hub: `-codex-device-login`, `-codex-login`, `-claude-login`; el callback de Claude es el puerto 54545 y se resuelve con túnel SSH; `-no-browser` imprime la URL (gist:158-171).
- Exposición: `tailscale serve --bg --https=8317 http://127.0.0.1:8317` (gist:180).
- Clientes: Claude Code con `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` en `settings.json`; Codex con un `model_provider` custom (`wire_api = "responses"`, `experimental_bearer_token`, `supports_websockets = true`) (gist:187-210). Alternativa: segunda config con `CLAUDE_CONFIG_DIR` / `CODEX_HOME` (gist:214-219).
- Sobre T3 Code: los providers usan la config CLI de la máquina del Environment; Codex debe ir por **"Use existing CLI"** porque "Continue with ChatGPT won't go through the hub"; Claude puede ir como instancia separada con las variables del paso 6 marcadas sensibles; límites agregados en _Settings > Providers > Usage providers > Add hub_ (gist:55-58, 240).
- Mejoras que el autor tuvo que añadir: _soonest-reset-first_ routing es un **fork propio**, no upstream (gist:226); upstream solo tiene `priority` y `weight`.

## 2. Qué ofrece CLIProxyAPI

- Proxy en Go, MIT, que expone endpoints compatibles OpenAI (incl. Responses), Gemini (incl. Interactions), Claude y Codex/Grok para usar cuentas de CLI desde cualquier cliente/SDK ([README:7-9](https://github.com/router-for-me/CLIProxyAPI), "Overview" README:125-143).
- **Suscripciones (OAuth)**, flags reales en `cmd/server/main.go:138-148`: `-codex-login`, `-codex-device-login`, `-claude-login`, `-antigravity-login`, `-kimi-login`, `-kimi-ai-login`, `-xai-login`, `-devin-login`, `-meta-login`; más `-vertex-import` (service account JSON, :156) y `-siwc-bind` (:158). **No hay flag de login para Gemini CLI** en `main` aunque el README lo lista como canal (README:31); Gemini llega por Antigravity, Vertex, AI Studio o API key.
- **Modelos** listados en el README (2026-11): OpenAI GPT-6 (Astra/Sol/Terra/Luna) vía Codex OAuth; Claude Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5; Gemini 4 Argon / 3.8 Flash; Grok 4.7; Kimi K3.x; Meta Muse; Devin (README:19-43). El catálogo real lo decide cada cuenta.
- **APIs de pago**: bloques `api-keys.gemini`, `vertex`, `codex`, `claude`, `xai`, `meta` y `openai-compatibility` (cualquier base-url, p. ej. OpenRouter) con grupos, `weight`, `priority`, alias y `prefix` (`config.example.yaml:546-983`). El propio ejemplo usa `deepseek-v3.1` como modelo upstream de un pool de alias (`config.example.yaml:976-981`). Por tanto **DeepSeek entra como `openai-compatibility`**.
- Multi-cuenta: `routing.strategy` = `round-robin` | `weighted-round-robin` | `fill-first`; `session-affinity` está **desactivado por defecto** (`config.example.yaml:170, 182`).
- Credenciales OAuth en ficheros JSON bajo `oauth.auth-dir: ~/.cli-proxy-api` (`config.example.yaml:988`); deshabilitar una cuenta con `"disabled": true` (gist:233). Management API remota desactivada por defecto (`allow-remote: false`, `secret-key: ""`, `config.example.yaml:104,109`).
- **"Cloaking"**: por defecto CLIProxyAPI disfraza como Claude Code las peticiones de clientes que **no** son Claude Code ("the Claude Code CLI disguise and system prompt replacement", modo `auto`, `config.example.yaml:484-489`, 795-797). Relevante para riesgo de ToS (ver §4).
- El README no contiene ningún aviso de ToS propio; sí patrocinadores de "relay" de Claude/Codex a fracción del precio oficial (README:49-123).

## 3. Encaje con las provider instances de t3code

- Una instancia = una config + una cuenta; se enruta por instancia (`docs/internals/providers.md:8-10`). Los threads eligen instancia con `modelSelection.instanceId` (`packages/contracts/src/modelSelection.ts:9-13`).
- Cada instancia lleva `environment`: lista de variables `{name, value | SecretReference, sensitive}` (`packages/contracts/src/providerInstance.ts:32-79`). Así se inyectan `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` hoy para OpenRouter (`docs/user/providers-claude.md:104-118`) y otros routers locales (`providers-claude.md:131-137`).
- Mapeo directo con el hub CLIProxyAPI:
  - **Claude** → instancia Claude con su `CLAUDE_CONFIG_DIR` y env `ANTHROPIC_BASE_URL=<hub>`, `ANTHROPIC_AUTH_TOKEN=<access key>` (sensible / referencia 1Password). Las sesiones con caché en config dir previa deben hacer `/logout` (`providers-claude.md:116-118`).
  - **Codex** → instancia Codex con un `CODEX_HOME` cuyo `config.toml` tenga el `model_provider` del gist; no por el flujo "Connect with ChatGPT" (`docs/user/providers-codex.md:5-26`; gist:57). OpenAI documenta `requires_openai_auth` para proxies LLM ([learn.chatgpt.com/docs/auth](https://learn.chatgpt.com/docs/auth)).
  - **DeepSeek / OpenAI-compatibles** → o bien a través del hub (`openai-compatibility`), o directo: DeepSeek ofrece API compatible Anthropic en `https://api.deepseek.com/anthropic` ([api-docs.deepseek.com](https://api-docs.deepseek.com/guides/anthropic_api)), usable como instancia Claude más env vars; Pi también acepta la API key del proveedor por env (`docs/user/providers-pi.md:26-30`).
- t3code **ya integra CLIProxyAPI solo para uso/límites**: `apps/server/src/usage/cliproxyApi.ts:181-196` llama a `v0/management/{auth-files,api-call,reset-quota}` con la management key; la doc aclara que eso "supplies usage information; configure the provider separately to send agent requests through the hub" (`docs/user/usage.md:176-186`). Los límites de suscripción no se ven en una instancia Claude con `ANTHROPIC_AUTH_TOKEN` (`usage.md:173-174`).
- Implicación para el diseño: el aislamiento por instancia existe a nivel de _proceso CLI_, no de _usuario_: el proxy no sabe qué usuario de Makita hace la petición salvo que cada usuario/instancia tenga su propia `access.api-keys` (el baseline no tiene usuarios, `00-t3code-baseline.md` §1).

## 4. Riesgos

**Términos de servicio (Anthropic)**

- Consumer Terms (efectivas 2025-10-08): "You may not share your Account login information … with anyone else. You also may not make your Account available to anyone else", y prohíbe acceso "through automated or non-human means … except … via an Anthropic API Key" ([anthropic.com/legal/consumer-terms](https://www.anthropic.com/legal/consumer-terms), §2 y §3.7).
- Claude Code legal: OAuth "is intended exclusively for purchasers of … subscription plans … to support ordinary use of Claude Code and other native Anthropic applications"; "Anthropic does not permit third-party developers … to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users … may not collect, store, or intermediate Claude.ai credentials"; y para productos: "Each end user must authenticate with their own … credentials"; enforcement "without prior notice" ([code.claude.com/docs/en/legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance)).
- El gist lo reconoce: "This might be against the terms of service" y fija dos reglas: no servir tráfico de otras personas con tus subs, y usar la sub de Claude **solo en Claude Code** (gist:82-89). El cloaking de CLIProxyAPI existe precisamente para el caso que esa regla prohíbe.

**Términos de servicio (OpenAI)**

- La página de ToS de openai.com devolvió 403 al fetch; según fuentes secundarias los Terms of Use (2024-12-11) prohíben compartir credenciales o "make your account available to anyone else" — **pendiente de verificar en fuente primaria**. La doc de Codex sí dice tratar `auth.json` "like a password" y recomienda API keys para automatización ([learn.chatgpt.com/docs/auth](https://learn.chatgpt.com/docs/auth)).

**Operativos / estabilidad**

- El gist exige máquina **doméstica, no VPS ni VPN**: "Anthropic is aggressive about sign-ins from datacenter IPs" (gist:29, 43, 78). Choca con ADR-0002, que sitúa el Hub en "the Owner's VPS" (`docs/adr/0002-central-hub.md:3`).
- "Claude Code auth breaks every 2 to 3 days" → necesita un único sitio que refresque (gist:72). Codex puede dar `token_invalidated` (401) y requerir re-login (gist:234).
- Punto único de fallo: si el hub cae, todos los agentes paran (gist:68). Sin affinity se pierde caché de prompt por cuenta (gist:225; affinity off por defecto).
- CLIProxyAPI evoluciona rápido (v8, layout de config versionado, release el mismo día) y depende de imitar fingerprints de CLIs (`config.example.yaml:811-845`): cualquier cambio del proveedor puede romperlo.

## 5. Opciones (sin decidir)

| Opción                                                                                        | Pro                                                                  | Contra                                                                                          |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A. CLIProxyAPI como pasarela central, instancias t3code apuntando por env vars                | Una sola URL, pool, límites ya visibles en t3code                    | Compartir subs entre usuarios choca con ToS Anthropic; hub en VPS va contra el consejo del gist |
| B. Solo APIs de pago (Anthropic/OpenAI/DeepSeek keys) vía env vars o `openai-compatibility`   | Permitido por ToS para "own authorized users" (legal-and-compliance) | Coste por token                                                                                 |
| C. Suscripciones por usuario: cada usuario inicia sesión con su propia cuenta en su instancia | Alineado con "each end user must authenticate with their own"        | Más logins; Makita debe custodiar tokens por usuario                                            |
| D. Híbrido: subs solo del Owner para su propio uso, APIs para el resto                        | Reduce riesgo                                                        | Dos rutas que mantener                                                                          |
