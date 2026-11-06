# 03: Rutas lógicas por Environment

**What to build:** Prefactor. El Hub deja de tomar como verdad las rutas absolutas de una máquina. Cada Environment tiene su propio mapa de Project a checkout local:

- por defecto, `<workspace root>/<slug del Project>`;
- también puede elegirse un checkout que ya exista en la máquina.

El `cwd` de los scopes de checkpoint y el `worktreePath` del Thread se guardan relativos al checkout y se resuelven en el Environment que ejecuta. Para el User no cambia nada en el Hub machine. Ver spec, «Threads, Projects y workspaces».

**Blocked by:** 01.

**Status:** done

- [ ] Hay un mapa de Project a checkout por Environment, consultable por el executor. En el Hub machine conserva la ruta actual de cada Project.
- [ ] Los scopes de checkpoint y el worktree del Thread se guardan relativos al checkout. Una migración convierte las filas existentes.
- [ ] El RuntimePolicy resuelve el `cwd` a través del executor del Active environment.
- [ ] La suite actual de checkpointing, rollback, worktrees y launch pasa sin cambios de comportamiento.
- [ ] Un test muestra que el mismo Thread se resuelve a rutas distintas en dos executors con roots distintos.
