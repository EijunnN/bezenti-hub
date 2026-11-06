# 01: El Hub machine pasa por el Environment executor

**What to build:** Prefactor. Todo lo que hoy necesita la máquina queda detrás de un Environment executor por Environment:

- el proveedor: `openSession`, `startTurn`, `interrupt`, `steer`, `respond`, `rollback`, `detach` y el stream de eventos;
- el workspace: checkpoints (capture, restore, diff), preparación de worktrees y setup scripts, archivos, búsqueda, exploración, terminales y previews;
- los recursos del host y las capacidades de los providers.

El Hub machine usa ese executor con un transporte en proceso. Para el User no cambia nada. El Orchestrator deja de leer capacidades del adapter mientras decide y pasa a leerlas de una caché por Environment. Ver spec, «Arquitectura».

**Blocked by:** None (can start immediately).

**Status:** done

- [ ] Existe un registro de Environment executors con una entrada para el Hub machine, y el ProviderAdapterRegistry, los checkpoints, el RuntimePolicy y las RPC de workspace pasan por él.
- [ ] Los effects atados a un proceso se enrutan por el Active environment del Thread. En este ticket siempre es el Hub machine.
- [ ] El Orchestrator no hace llamadas de red ni del adapter mientras decide. Las capacidades salen de una caché por Environment.
- [ ] La suite actual de orchestration-v2, checkpointing, terminal y ws pasa sin cambios de comportamiento.
- [ ] El contrato del executor está tipado en contracts como un módulo versionado, para que los tickets 02 y 04 lo lleven por la red.
