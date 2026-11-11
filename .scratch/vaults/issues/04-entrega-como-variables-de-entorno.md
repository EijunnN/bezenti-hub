# 04: Entrega como variables de entorno

**What to build:** Los secretos del conjunto efectivo llegan como variables de entorno al proceso del provider, a las terminales y a los scripts de setup del Thread, en su Sandbox, en una máquina dedicada o personal, y en el Hub machine en proceso de desarrollo. Sube el executor contract de 9 a 10 con un campo `secretEnv`. Ver spec, «Entrega como variables de entorno».

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] `ENVIRONMENT_EXECUTOR_CONTRACT_VERSION` 9 → 10 (`packages/contracts/src/environmentExecutor.ts`). `secretEnv` en `provider.openSession`, `provider.startTurn` (cuando cambia el conjunto), `terminal.open` y `launch.runSetupScript`.
- [ ] El Hub llama a `EffectiveVaults` en cada una de esas peticiones; nada se cachea entre turnos.
- [ ] En `EnvironmentAgent` el valor va solo al entorno del proceso hijo; nunca a argumentos, archivos, logs del agente, spans ni al registro de frames del wire (campo marcado sensible).
- [ ] Si el conjunto cambia con una sesión viva, el siguiente turno reabre la sesión del provider; las terminales abiertas conservan el suyo y el cliente muestra «Secrets changed: reopen to update».
- [ ] Ejecutor con contrato < 10 y conjunto no vacío: error tipado «<máquina> needs an update to receive this Thread's secrets». Con conjunto vacío sigue funcionando. Red-first.
- [ ] Red-first: un turno en el Sandbox de Globex no recibe variables de Acme; `secretEnv` nunca va a una máquina que no es la Active environment del Thread; el valor no aparece en `/proc/<pid>/cmdline` del provider, en logs ni en spans (test de humo).
- [ ] Puertas que nombra este ticket: executor wire (cuatro operaciones), logs y OTLP del Hub y del agente joined, argumentos de proceso. Sin puertas WS, HttpApi ni MCP nuevas.
- [ ] Tests en el testkit «Hub con Environments» (runtime process): entorno real del proceso del provider, de una terminal y de un script; máquina con contrato 9.
- [ ] Prueba real con Podman: el agente de un Thread de Acme hace `printenv NOMBRE` en el Sandbox y lo obtiene; una terminal del mismo Thread también; el Sandbox de Globex no.
