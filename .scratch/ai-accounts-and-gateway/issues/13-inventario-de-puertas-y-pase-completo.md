# 13: Inventario de puertas y pase completo

**What to build:** Una revisión de inventario, como la del ticket 17 del spec 3, de todas las puertas que llegan a una credencial de AI account, a una gateway key, a la Management API de CLIProxyAPI o a la propia gateway: WS, HttpApi, raw routes, cookies, MCP, executor wire, relay y socket del Sandbox, rutas de invitado, logs, spans OTLP, argumentos de proceso y archivos del Hub. Cierra los huecos con la misma regla en cada puerta. Ver spec, «Puertas».

**Blocked by:** 01–12.

**Status:** ready-for-agent

- [ ] `DoorRules.ts` (`RAW_ROUTE_RULES`, `AMBIENT_COOKIE_RULES`, `MCP_TOOL_RULES`, `HTTP_ENDPOINT_RULES`) y `RPC_SPACE_ACCESS` declaran todas las puertas de este spec; el test de inventario falla si falta una.
- [ ] Ninguna puerta devuelve una credencial de AI account, la management key, la client key del Hub ni una gateway key ya creada. Test que llama a cada RPC, endpoint y herramienta y busca esos valores en la respuesta.
- [ ] CLIProxyAPI: solo loopback; inalcanzable desde un Sandbox (Podman) y desde una máquina joined; la Management API rechaza sin clave.
- [ ] Test de humo de fugas: credenciales, keys y prompts no aparecen en logs, spans, `/proc/*/cmdline` (Hub, CLIProxyAPI, máquina joined) ni en archivos del Hub fuera del almacén cifrado y del `auth-dir` en memoria.
- [ ] `AllowedAiAccounts` es la única regla en gateway, selector, defecto, MCP `t3_thread_launch` y plan de mover; test que lo comprueba con Owner, Admin, Member y Guest de dos Organizations.
- [ ] Red-first para cada hueco encontrado.
- [ ] Prueba real completa en WSL con Podman y el CLIProxyAPI fijado: el recorrido de la prueba real del spec, más un CLI local, un failover entre dos cuentas del mismo proveedor (cuenta falsa con 429) y mover el Project.
