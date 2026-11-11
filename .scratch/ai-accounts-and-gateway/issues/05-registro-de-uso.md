# 05: Registro de uso

**What to build:** La capa de gateway registra cada petición con tokens (entrada, salida, caché), User, Space, Thread, gateway key, AI account, proveedor, modelo, estado y duración (migración 114), con un resumen diario. El Owner lo ve en Settings → AI accounts → Usage; cada User, el de sus Threads. Es la fuente que el spec 6 mostrará. Ver spec, «Uso».

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] Migración 114: `ai_usage` (por petición) y `ai_usage_daily` (día, User, Space, AI account, modelo).
- [ ] Tokens leídos del `usage` final de cada forma, también en streaming; sin uso en la respuesta → petición contada con tokens desconocidos.
- [ ] Escritura fuera del camino de la respuesta (no retrasa el stream); un fallo al escribir se registra y no corta la petición.
- [ ] Retención: filas por petición 90 días (barrido diario), resúmenes siempre (pregunta abierta 4).
- [ ] `aiUsage.summary` (por día, User, Space, AI account, modelo): el Owner todo; un User solo lo suyo; Admin su Space (lo usará el spec 6).
- [ ] Red-first: un Member no ve el uso de otro Member ni de otro Space; un Admin no ve el de otra Organization; la fila no guarda prompts ni claves.
- [ ] Puertas: WS `aiUsage.summary` en `RPC_SPACE_ACCESS`. Sin HttpApi, raw routes ni MCP nuevas.
- [ ] Web/desktop: pestaña «Usage» en Settings → AI accounts (Owner) y uso del Thread en su panel.
- [ ] Tests con el CLIProxyAPI falso (uso en respuesta normal y en streaming de las tres formas).
- [ ] Prueba real: dos peticiones de dos Users en dos Spaces; Settings → Usage las muestra separadas por User, Space y cuenta.
