# 01: El Sandbox de un Space

**What to build:** El primer Thread que necesita el Sandbox de un Space lo crea con el Sandbox runtime de tipo process: un servidor T3 joined como proceso hijo, con su propio home y workspace root. Queda registrado como Environment de tipo `sandbox` ligado a ese Space y aparece en el selector como «<Space> Sandbox». Ver spec, «Arquitectura».

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Interfaz `SandboxRuntime` (create, start, stop, delete, inspect) con implementación process; nada fuera de ella habla con procesos o contenedores.
- [ ] Tabla `sandboxes` (Space, estado, versión de imagen, límites, fechas) y Environment de tipo `sandbox` con `spaceId`.
- [ ] El Hub emite la credencial del Sandbox sin aprobación humana, válida solo para su Space: protocolo del Environment y repositorios git del Hub de los Projects de ese Space. Red-first: no alcanza un Project ni un Thread de otro Space.
- [ ] `environment.use` (tabla en AccessPolicy): un Sandbox lo usan los Users con derecho a trabajar en su Space; Guests no.
- [ ] Un User puede elegir «<Space> Sandbox» en el composer y un turno corre allí (Replay), con checkpoints subidos al Hub.
- [ ] Tests en el testkit «Hub con Environments» con el runtime process. Nombres accesibles entregados.
