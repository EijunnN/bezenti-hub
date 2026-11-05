# 15: Hub accesible desde internet

**What to build:** Cuando la Installation tiene Owner, el servidor acepta conexiones de cualquier origen, porque toda petición necesita una sesión de User. Se niega a emitir sesiones de navegador por HTTP sin cifrar salvo en loopback. Documentación de usuario para publicar el Hub en un dominio propio detrás de un reverse proxy con HTTPS.

**Blocked by:** 02

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Con Owner, se aceptan peers fuera de loopback, red privada o tailnet.
- [ ] Sesiones de navegador rechazadas por HTTP plano fuera de loopback.
- [ ] Guía en `docs/user/` para publicar el Hub con reverse proxy y HTTPS.
