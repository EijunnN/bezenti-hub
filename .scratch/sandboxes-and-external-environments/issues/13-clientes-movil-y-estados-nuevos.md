# 13: Clientes: móvil y estados nuevos

**What to build:** El móvil muestra Sandboxes y máquinas dedicadas con sus nombres y los estados nuevos (starting, stopped, failed), y el Owner ve la lista de Sandboxes y máquinas en solo lectura. Web y desktop ya los muestran por los tickets anteriores; aquí se revisa que todas las superficies coinciden. Ver spec, «Clientes».

**Blocked by:** 05, 09.

**Status:** ready-for-agent

- [ ] Fuente compartida de Environments en client-runtime con los estados y modos nuevos; web, desktop y móvil la usan.
- [ ] Móvil: nombres y estados en listas y Thread; lista de solo lectura para el Owner con modo, Space y estado.
- [ ] Typecheck y tests de mobile y client-runtime en verde; prueba real en web de las mismas pantallas.
