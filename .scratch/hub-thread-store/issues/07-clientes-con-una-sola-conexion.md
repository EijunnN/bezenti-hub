# 07: Clientes con una sola conexión

**What to build:** La web y el desktop se conectan solo al Hub y ven todos sus Threads, corran en la máquina que corran. El Active environment de cada Thread llega por el stream, como un campo más, y deja de ser una conexión. El Owner puede fijar el Environment preferido de un Project. Ver spec, «Threads, Projects y workspaces» y «Superficies de cliente».

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] Client-runtime usa una sola conexión, la del Hub. `ScopedThreadRef` deja de depender del Environment de conexión y el Active environment pasa a ser un campo del Thread.
- [ ] El sidebar, la cabecera y las listas muestran el nombre y el estado del Active environment, actualizados en vivo.
- [ ] Hay un ajuste de Environment preferido en la configuración del Project, y se respeta al crear Threads.
- [ ] Se quitan el código y la UI de conexión múltiple que ya no se usan. Knip queda limpio.
- [ ] Typecheck de web, desktop, client-runtime y mobile en verde. Tests de client-runtime y prueba real del sidebar con dos Environments.
