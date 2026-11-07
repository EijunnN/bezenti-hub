# 11: Quitar los Peer Links

**What to build:** Desaparecen los Peer Links: servicio, rutas, reenvío, delegación remota, tablas, UI y el software id `t3code-peer-link` del registro OAuth de MCP. Una migración revoca sus credenciales y borra sus filas. La delegación entre Threads de un mismo Hub sigue funcionando. Ver spec, «Peer Links».

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Código y UI de Peer Links eliminados; knip limpio.
- [ ] Migración que revoca credenciales de Peer Links y borra sus filas, con test.
- [ ] Delegación local entre Threads (Orchestrator) intacta: sus tests pasan.
- [ ] Docs (`docs/internals/remote.md` y otras) actualizadas.
