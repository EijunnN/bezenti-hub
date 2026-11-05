# Cómo plugar suscripciones y APIs

Type: research
Label: wayfinder:research
Status: resolved
Blocked by: —
Map: ../map.md

## Question

¿Qué ofrecen CLIProxyAPI y el gist de t3dotgg (https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af) para usar suscripciones (Claude, Codex, Gemini…) y APIs (DeepSeek, OpenAI-compatibles) desde un mismo sitio? ¿Qué proveedores y modelos cubren, cómo se autentican las cuentas, y cómo encajarían con las provider instances de t3code (variables de entorno por instancia, `modelSelection.instanceId`)? ¿Riesgos (términos de servicio, estabilidad)?

## Answer

- CLIProxyAPI (Go, MIT, v8.0.55) es un proxy que convierte logins OAuth de suscripción (Claude, Codex, Antigravity/Gemini, xAI, Kimi, Meta, Devin) y API keys (Anthropic, OpenAI/Codex, Gemini/Vertex, xAI y cualquier `openai-compatibility` como DeepSeek u OpenRouter) en un único endpoint compatible OpenAI/Claude/Gemini, con pool de cuentas (round-robin, weighted, fill-first; session affinity desactivada por defecto).
- El gist de t3dotgg lo usa solo para Claude y Codex: un hub doméstico siempre encendido detrás de Tailscale; los clientes ponen `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` (Claude) o un `model_provider` custom en `config.toml` (Codex).
- En t3code encaja sin cambios de código: es una instancia por cuenta o ruta, con env vars propias (sensibles o con referencia a 1Password), seleccionada con `modelSelection.instanceId`. Codex va por "Use existing CLI". t3code ya lee el uso y los límites del hub (`apps/server/src/usage/cliproxyApi.ts`), pero no le enruta las peticiones.
- Riesgo principal: los términos de Anthropic prohíben compartir la cuenta o hacerla "available to anyone else" y enrutar credenciales de suscripción "on behalf of their users". El propio gist prohíbe servir tráfico ajeno y usar la suscripción de Claude fuera de Claude Code. CLIProxyAPI, por defecto, disfraza como Claude Code a los clientes que no lo son.
- Choque con ADR-0002: el gist desaconseja los VPS y las IP de datacenter, y el Hub vive en un VPS. Además, el login de Claude caduca cada 2-3 días y el hub es un punto único de fallo.
- Opciones: (A) un hub CLIProxyAPI compartido, (B) solo APIs de pago, (C) una suscripción propia por usuario, (D) un híbrido con las suscripciones del Owner para él y APIs para el resto.

Research: [../research/01-como-plugar-suscripciones-y-apis.md](../research/01-como-plugar-suscripciones-y-apis.md)
