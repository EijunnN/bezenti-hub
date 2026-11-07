# 04: Runtime Podman y aislamiento real

**What to build:** Implementación Podman del Sandbox runtime: contenedor rootless por Sandbox, volumen persistente montado como home y workspace root, red propia con salida a internet y sin acceso a la loopback del host ni a otros contenedores, y el Hub alcanzable solo por un socket UNIX montado (conexión del Environment y git smart HTTP). Ver spec, «Contenedor, red y límites».

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] El Hub sirve la conexión de Environment y el git del Hub también por un socket UNIX que se monta en cada contenedor; ningún otro puerto del Hub es alcanzable desde un contenedor.
- [ ] Nada del Hub se monta salvo el volumen del Sandbox y el socket; dentro corre un usuario sin privilegios.
- [ ] Mientras no exista la imagen base (ticket 06), una imagen mínima de desarrollo construida en el test.
- [ ] Tests de integración con Podman (se saltan si Podman rootless no está): dos Sandboxes de dos Spaces no leen el volumen del otro, no ven sus procesos, no conectan a sus puertos ni a la loopback del Hub; sí salen a internet; parar y arrancar conserva el volumen. Red-first.
- [ ] Funciona con Podman 3.4 (Ubuntu 22.04, el WSL de desarrollo) y versiones nuevas; documentar requisitos (subuid/subgid, systemd --user, slirp4netns).
