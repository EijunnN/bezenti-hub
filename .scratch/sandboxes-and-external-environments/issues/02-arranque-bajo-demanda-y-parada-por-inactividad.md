# 02: Arranque bajo demanda y parada por inactividad

**What to build:** Un Sandbox parado arranca solo cuando hay trabajo (mensaje, terminal, archivos, preview) y se para tras 30 minutos sin turnos, terminales ni previews activos. El Thread muestra «Starting the Sandbox…» mientras arranca, y si falla, el motivo y «Try again». Ver spec, «Contenedor, red y límites → Ciclo de vida».

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] Estados `starting`, `stopped`, `failed` del Sandbox, en vivo en la fuente compartida de Environments del Hub.
- [ ] Los effects y RPC atados a la máquina esperan a que el Sandbox arranque (sin gastar intentos); un fallo de arranque es un error tipado visible en el Thread con «Try again».
- [ ] Parada por inactividad configurable (30 min por defecto), probada con el reloj de tests.
- [ ] Un Sandbox que muere a mitad de un turno se comporta como un Environment offline del spec 2 (paused, luego reanudado o interrumpido).
- [ ] Tests en el testkit; prueba real.
