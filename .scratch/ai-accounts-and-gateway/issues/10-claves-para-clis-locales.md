# 10: Claves para CLIs locales

**What to build:** Cada User crea en Settings → AI accounts → «Local CLI keys» gateway keys de tipo `user`, atadas a uno de sus Spaces, con instrucciones copiables para Claude Code (`settings.json`) y Codex (`config.toml`) que apuntan a la URL pública del Hub. Las lista, las nombra y las revoca; el Owner ve y revoca todas. Su uso cuenta como el de los Threads. Ver spec, «CLIs locales».

**Blocked by:** 05.

**Status:** ready-for-agent

- [ ] `aiGatewayKeys.create` (nombre, Space de los suyos; por defecto su Personal space), clave mostrada una sola vez; `aiGatewayKeys.list` (propias; Owner todas), `aiGatewayKeys.revoke`.
- [ ] Instrucciones con la URL pública del Hub (`/api/ai/anthropic`, `/api/ai/openai/v1`) para Claude Code y Codex.
- [ ] Con clave de User, la gateway elige la cuenta permitida de mayor prioridad que sirva el modelo pedido.
- [ ] Revocación automática al quitar al User o si pierde el Space de la clave.
- [ ] Auditoría `ai_gateway_key.create`, `ai_gateway_key.revoke`.
- [ ] Red-first: un Member no lista ni revoca claves de otro; una clave atada a Acme no consume cuentas solo de Globex; tras salir de Acme, la clave da 403; la clave no se guarda en claro (solo su hash).
- [ ] Puertas: WS `aiGatewayKeys.*` en `RPC_SPACE_ACCESS`; raw routes `/api/ai/*` (ticket 04). Sin MCP: ninguna herramienta crea ni lista claves.
- [ ] Web/desktop: «Local CLI keys» con «Create key», «Copy setup» y «Revoke».
- [ ] Prueba real: un Member crea una clave, configura Claude Code en su máquina WSL contra el Hub dev, hace una pregunta y Settings → Usage la muestra con su User y Space.
