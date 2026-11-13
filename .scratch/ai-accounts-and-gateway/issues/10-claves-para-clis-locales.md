# 10: Claves para CLIs locales

**What to build:** Cada User crea en Settings → AI accounts → «Local CLI keys» gateway keys de tipo `user`, atadas a uno de sus Spaces, con instrucciones copiables para Claude Code (`settings.json`) y Codex (`config.toml`) que apuntan a la URL pública del Hub. Las lista, las nombra y las revoca; el Owner ve y revoca todas. Su uso cuenta como el de los Threads. Ver spec, «CLIs locales».

**Blocked by:** 05.

**Status:** done

- [x] `aiGatewayKeys.create` (nombre, Space de los suyos; por defecto su Personal space), clave mostrada una sola vez; `aiGatewayKeys.list` (propias; Owner todas), `aiGatewayKeys.revoke`.
- [x] Instrucciones con la URL pública del Hub (`/api/ai/anthropic`, `/api/ai/openai/v1`) para Claude Code y Codex.
- [x] Con clave de User, la gateway elige la cuenta permitida de mayor prioridad que sirva el modelo pedido.
- [x] Revocación automática al quitar al User o si pierde el Space de la clave.
- [x] Auditoría `ai_gateway_key.create`, `ai_gateway_key.revoke`.
- [x] Red-first: un Member no lista ni revoca claves de otro; una clave atada a Acme no consume cuentas solo de Globex; tras salir de Acme, la clave da 403; la clave no se guarda en claro (solo su hash).
- [x] Puertas: WS `aiGatewayKeys.*` en `RPC_SPACE_ACCESS`; raw routes `/api/ai/*` (ticket 04). Sin MCP: ninguna herramienta crea ni lista claves.
- [x] Web/desktop: «Local CLI keys» con «Create key», «Copy setup» y «Revoke».
- [x] Prueba real: un Member crea una clave, configura Claude Code en su máquina WSL contra el Hub dev, hace una pregunta y Settings → Usage la muestra con su User y Space.

**Hecho** (2026-11-13): WS `aiGatewayKeys.list|create|revoke` (`AiGatewayKeys.*ForSession`: solo la sesión de la propia persona; nunca un agente, el shell del Hub ni una sesión limitada a un Space), Space por defecto el Personal, clave solo en la respuesta de `create` (Redacted) y SHA-256 en la base. Revocación al perder el Space (vigilancia de Memberships y `authorize`: 403 y `space-lost`) y al quitar al User (`user-inactive`), auditadas como `system`. Settings → AI accounts → «Local CLI keys» (todos los Users) con «Create key», «Copy setup» (Claude Code `settings.json` / Codex `config.toml`, `@t3tools/shared/aiGatewayLocalCli`) y «Revoke». Tests: `AiGatewayKeys.localCli.test.ts` (red-first), `DoorRules.test.ts`. Prueba real con Claude Code 2.1.319 en WSL contra el Hub dev: `makita-livepass-s4-10`.
