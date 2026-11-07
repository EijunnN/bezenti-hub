# 05: Límites y gestión de Sandboxes

**What to build:** Límites de CPU, memoria, PIDs y disco por Sandbox, con valores por defecto de la Installation y override por Space. El Owner ve y gestiona todos los Sandboxes en Settings → Environments → «Sandboxes»: estado, recursos, límites, imagen, arrancar, parar, reiniciar. Archivar una Organization para su Sandbox y bloquea el arranque; borrarla elimina Sandbox y volumen. Ver spec, «Contenedor, red y límites» y «Auditoría».

**Blocked by:** 02, 04.

**Status:** done

- [x] Límites aplicados por Podman (cgroups v2 con delegación al usuario; si el bus de systemd del usuario no está disponible, error claro y documentación) y probados en integración (memoria y PIDs).
- [x] Disco: cuota del volumen o vigilancia con parada y error claro en el Thread al llenarse.
- [x] Ciclo con Organizations del spec 1: archivar para y bloquea; restaurar permite; borrar elimina Sandbox, volumen y credencial.
- [x] Admins ven estado y uso de su Space; el Owner cambia límites y arranca/para/reinicia cualquiera.
- [x] Auditoría: `sandbox.create`, `sandbox.start`, `sandbox.stop`, `sandbox.delete`, `sandbox.limits.change` (allow-list).
- [x] Tests en el testkit + integración Podman; prueba real.

**Notes (done):** CPU, memory and PIDs go to Podman only where it enforces them (cgroups v2, systemd cgroup manager, controllers delegated); the dev WSL has no systemd user bus from `wsl -e`, so there Podman uses cgroupfs, nothing is enforced, Settings and the log say «Limits not enforced on this host», and the enforcement integration test skips with that reason. Disk is the Hub's `du` check. Defaults in `sandbox_limit_defaults` (migration 104). See docs/internals/sandboxes.md#limits.
