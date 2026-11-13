# 05: Registro de uso

**What to build:** La capa de gateway registra cada petición con tokens (entrada, salida, caché), User, Space, Thread, gateway key, AI account, proveedor, modelo, estado y duración (migración 114), con un resumen diario. El Owner lo ve en Settings → AI accounts → Usage; cada User, el de sus Threads. Es la fuente que el spec 6 mostrará. Ver spec, «Uso».

**Blocked by:** 04.

**Status:** done

- [x] Migración 114: `ai_usage` (por petición) y `ai_usage_daily` (día, User, Space, AI account, modelo).
- [x] Tokens leídos del `usage` final de cada forma, también en streaming; sin uso en la respuesta → petición contada con tokens desconocidos.
- [x] Escritura fuera del camino de la respuesta (no retrasa el stream); un fallo al escribir se registra y no corta la petición.
- [x] Retención: filas por petición 90 días (barrido diario), resúmenes siempre (pregunta abierta 4).
- [x] `aiUsage.summary` (por día, User, Space, AI account, modelo): el Owner todo; un User solo lo suyo; Admin su Space (lo usará el spec 6).
- [x] Red-first: un Member no ve el uso de otro Member ni de otro Space; un Admin no ve el de otra Organization; la fila no guarda prompts ni claves.
- [x] Puertas: WS `aiUsage.summary` en `RPC_SPACE_ACCESS`. Sin HttpApi, raw routes ni MCP nuevas.
- [x] Web/desktop: pestaña «Usage» en Settings → AI accounts (Owner) y uso del Thread en su panel.
- [x] Tests con el CLIProxyAPI falso (uso en respuesta normal y en streaming de las tres formas).
- [x] Prueba real: dos peticiones de dos Users en dos Spaces; Settings → Usage las muestra separadas por User, Space y cuenta.

**Hecho** (rama `impl/aig-05`):

- Migración 114 (`ai_usage`, `ai_usage_daily`). `ai/AiUsage.ts` escucha `AiGatewayActivity.subscribeRequests` en un fiber aparte, escribe fila y resumen del día en una transacción y barre las filas de petición a los 90 días. Sin cupos.
- Una petición cuenta una vez (failover y stream abandonado incluidos); `count_tokens` no cuenta; sin `usage` o cortada: tokens desconocidos, no cero; error: contada como fallida.
- `aiUsage.summary` (WS, `RPC_SPACE_ACCESS`): Owner todo, Admin su Organization (`aiUsage.viewSpace`) más lo suyo, el resto lo suyo; los filtros solo recortan. Nombres de cuenta solo para el Owner y quien puede usarla.
- Web: pestaña «Usage» en Settings → AI accounts (Owner) y «AI gateway usage» en el panel del Thread.
- Tests: `AiUsage.test.ts` (12, con el CLIProxyAPI falso en las tres formas, streaming y no), `AccessPolicy.test.ts`, `DoorRules.test.ts`, `aiUsageView.test.ts`. Rojo: con la visibilidad sabotada fallan 4 tests y con `count_tokens` contado falla el conteo.
