# 14: Checkouts de Project desde el repositorio del Hub

**What to build:** Hoy un Environment que no tiene el checkout de un Project lo clona desde el remoto propio del Project (`origin`). Dentro de un Sandbox eso falla con un `origin` que es una ruta local del Hub, y fallará con remotos privados que necesitan credenciales. El Hub pasa a ser la fuente del checkout inicial: mantiene en su repositorio del Project una copia de las ramas del Project (las que el Owner o los Members usan), y un Environment nuevo clona desde ahí con su Environment credential. El remoto propio sigue sin tocarse para checkpoints; los push a `origin` siguen siendo cosa del User. Ver spec 2 «Repositorio git del Hub y checkpoints» y spec 3 ticket 04 (riesgo detectado en la prueba real).

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] El Hub refleja las ramas del Project en su repositorio (al añadir el Project y en cada fetch del Hub machine o del Environment que lo tenga), bajo un namespace propio, sin exponer refs de Threads ajenos.
- [ ] Un Environment sin checkout lo crea desde el repositorio del Hub; `origin` del checkout sigue apuntando al remoto propio del Project.
- [ ] Funciona con un `origin` que es ruta local y con un remoto privado (sin credenciales dentro del Sandbox).
- [ ] Las reglas de refs por máquina del spec 2 se mantienen (una máquina no lee checkpoints de Threads ajenos). Red-first.
- [ ] Tests en el testkit y con el runtime Podman.
