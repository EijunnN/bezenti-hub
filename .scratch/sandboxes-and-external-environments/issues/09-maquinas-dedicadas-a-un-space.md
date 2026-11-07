# 09: Máquinas dedicadas a un Space

**What to build:** El Owner registra una máquina dedicada a un Space; todos sus Members la ven y la usan, y la máquina ejecuta el trabajo dentro de un contenedor con la imagen del Sandbox (Podman en esa máquina). Cambiar el modo o el Space exige que no tenga Threads activos. Ver spec, «External environments».

**Blocked by:** 04, 08.

**Status:** ready-for-agent

- [ ] `environments` gana `mode` (`personal` | `dedicated` | `sandbox`) y `spaceId` para dedicados.
- [ ] Alta dedicada: elección del Space en la página de alta o `t3 join --dedicated`; solo el Owner. `t3 join` comprueba Podman rootless en la máquina.
- [ ] El servidor joined dedicado ejecuta el trabajo dentro del contenedor del Sandbox con los mismos límites y ciclo de vida.
- [ ] `environment.use`: Members con derecho a trabajar en ese Space; Members de otro Space ni la ven. Red-first.
- [ ] Cambio de modo o de Space rechazado con la lista de Threads a mover; auditoría `environment.mode.change`.
- [ ] Tests en el testkit (runtime process en la máquina) y una prueba real.
