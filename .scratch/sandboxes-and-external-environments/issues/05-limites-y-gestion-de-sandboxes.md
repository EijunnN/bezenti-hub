# 05: Límites y gestión de Sandboxes

**What to build:** Límites de CPU, memoria, PIDs y disco por Sandbox, con valores por defecto de la Installation y override por Space. El Owner ve y gestiona todos los Sandboxes en Settings → Environments → «Sandboxes»: estado, recursos, límites, imagen, arrancar, parar, reiniciar. Archivar una Organization para su Sandbox y bloquea el arranque; borrarla elimina Sandbox y volumen. Ver spec, «Contenedor, red y límites» y «Auditoría».

**Blocked by:** 02, 04.

**Status:** ready-for-agent

- [ ] Límites aplicados por Podman (cgroups v2 con delegación al usuario; si el bus de systemd del usuario no está disponible, error claro y documentación) y probados en integración (memoria y PIDs).
- [ ] Disco: cuota del volumen o vigilancia con parada y error claro en el Thread al llenarse.
- [ ] Ciclo con Organizations del spec 1: archivar para y bloquea; restaurar permite; borrar elimina Sandbox, volumen y credencial.
- [ ] Admins ven estado y uso de su Space; el Owner cambia límites y arranca/para/reinicia cualquiera.
- [ ] Auditoría: `sandbox.create`, `sandbox.start`, `sandbox.stop`, `sandbox.delete`, `sandbox.limits.change` (allow-list).
- [ ] Tests en el testkit + integración Podman; prueba real.
