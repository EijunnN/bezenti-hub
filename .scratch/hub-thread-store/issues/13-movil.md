# 13: Móvil

**What to build:** En la app móvil, cada Thread muestra en qué máquina corre y su estado (online, paused, offline o needs an environment), y se puede mover a otra máquina. El Owner ve la lista de Environments con su estado, solo para leer. Ver spec, «Superficies de cliente».

**Blocked by:** 08, 10.

**Status:** ready-for-agent

- [ ] El Active environment y su estado aparecen en las listas y en la pantalla del Thread, actualizados en vivo.
- [ ] Acción de mover con el mismo diálogo y las mismas reglas que en web: esperar o parar, progreso y error.
- [ ] Lista de Environments de solo lectura para el Owner.
- [ ] Typecheck y tests de mobile en verde.
- [ ] Móvil pasa a una sola conexión, la del Hub (heredado del ticket 07): hoy guarda varias conexiones, puede añadir varios Hubs o servidores sueltos (con pairing) e indexa Threads y rutas por `environmentId`. Quitar el pairing a servidores sueltos y el modelo multi-servidor.
- [ ] Quitar `environmentId` de `ScopedThreadRef` en client-runtime, web y móvil (expand–contract), ahora que solo hay una conexión; borrar las comprobaciones «desktop-local» y los flujos de pairing que quedaron en el onboarding web y en el handler de enlaces de desktop.
