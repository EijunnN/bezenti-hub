# 01: CLIProxyAPI gestionado por el Hub

**What to build:** El Hub descarga la release fijada de CLIProxyAPI para su plataforma, comprueba su hash fijado y el `checksums.txt` de la release, la arranca como proceso hijo en `127.0.0.1` con un `config.yaml` que escribe él mismo (management solo local, panel desactivado, una client key del Hub, sin estadísticas ni logs de peticiones), la reinicia si muere y la maneja por la Management API (`/v8/management`) desde un único cliente (`ai/CliproxyManagement.ts`). El `auth-dir` vive en memoria. Settings → AI gateway muestra su estado y deja al Owner actualizar y volver atrás. Ver spec, «CLIProxyAPI gestionado».

**Blocked by:** spec 5 · 01 (almacén cifrado).

**Status:** ready-for-agent

- [ ] Manifiesto en el repo con versión fijada y SHA-256 por plataforma (linux amd64/arm64, darwin amd64/arm64). Descarga a `<stateDir>/ai-gateway/bin/<versión>/`; nunca ejecuta un binario sin verificar. Red-first: un archivo con hash distinto, o ausente en `checksums.txt`, se rechaza y no se ejecuta.
- [ ] Proceso hijo con el usuario del Hub, `host: 127.0.0.1`, puerto libre; lanzado solo con `-config <ruta>` (ningún secreto en argv); reinicio con backoff; stdout/stderr filtrados antes de los logs del Hub.
- [ ] `config.yaml` 0600: `remote-management.allow-remote: false`, panel desactivado, `secret-key` y client key aleatorias guardadas en el almacén cifrado, estadísticas y logs de peticiones desactivados.
- [ ] `auth-dir` en `$XDG_RUNTIME_DIR` o `/dev/shm` (0700); si no hay tmpfs, `<stateDir>/ai-gateway/auth` y aviso en Settings.
- [ ] Red-first: la gateway no escucha fuera de loopback; la Management API sin la clave responde 401; un Sandbox (runtime Podman) no conecta al puerto de CLIProxyAPI.
- [ ] Settings → AI gateway (solo Owner): versión, estado, uptime, «Check for updates» (consulta GitHub solo al pulsar o abrir la sección), «Update to vX» (descarga, verifica, arranca en paralelo, prueba de salud y modelos, cambia) y «Roll back». Auditoría `ai_gateway.update`, `ai_gateway.rollback`.
- [ ] Puertas: WS `aiGateway.status`, `aiGateway.checkForUpdates`, `aiGateway.update`, `aiGateway.rollback` en `RPC_SPACE_ACCESS` (Installation, solo Owner). Ninguna HttpApi, raw route ni herramienta MCP. Logs, OTLP y argumentos de proceso sin claves (test de humo).
- [ ] Tests del gestor con un binario de test que hace de CLIProxyAPI (arranque, caída y reinicio, config escrita, update y rollback); un test de integración con la release real, que se salta sin red.
- [ ] Prueba real en WSL: el Hub dev descarga la versión fijada, Settings → AI gateway la muestra «Running», `ss -ltnp` solo la ve en 127.0.0.1, matar el proceso lo reinicia.
