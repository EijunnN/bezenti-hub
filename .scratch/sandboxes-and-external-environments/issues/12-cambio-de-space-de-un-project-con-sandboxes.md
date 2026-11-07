# 12: Cambio de Space de un Project con Sandboxes

**What to build:** Mover un Project a otro Space (spec 1) detiene sus Threads; los que quedan en una máquina que ya no sirve en el destino (Sandbox del origen, dedicada al origen) pasan a «needs an environment», y al confirmar se ofrece moverlos al Sandbox del destino. Ver spec, «Cambio de Space de un Project».

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] El flujo de mover Project del spec 1 añade el paso de detener Threads y avisa de cuáles cambian de Environment.
- [ ] Threads afectados en «needs an environment»; acción para moverlos todos al Sandbox del destino con el move del spec 2.
- [ ] El repo git del Hub y las credenciales de Sandbox siguen la regla por Space (el Sandbox del origen pierde el acceso). Red-first.
- [ ] Tests en el testkit; prueba real.
