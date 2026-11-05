# Opciones de aislamiento entre Organizaciones

Type: research
Label: wayfinder:research
Status: resolved
Blocked by: —
Map: ../map.md

## Question

¿Qué opciones hay para que agentes de distintas Organizaciones no puedan leerse los archivos ni los secretos en una misma máquina? Comparar: contenedores (Docker/Podman), usuarios del SO distintos, un servidor T3 por Organización, VMs ligeras (Firecracker, etc.). Para cada una: nivel de aislamiento, coste operativo, compatibilidad con las CLIs de IA (que necesitan su HOME y config) y con cómo t3code lanza procesos (PTY, provider subprocesses).

## Answer

- Todos los procesos de agente y de terminal pasan por un único punto, `AgentScope.wrap`. En Linux usa `systemd-run --user --scope`, que solo controla recursos: no cambia de UID ni aplica sandboxing. Ya pasa `Delegate=yes`, pensado para Podman rootless.
- **Usuarios del SO, un solo servidor.** Los permisos aíslan ficheros. Los procesos solo se ocultan con `hidepid=2`. La red no se aísla. El servidor necesitaría root o CAP_SETUID, porque el manager de usuario de systemd no permite `User=`.
- **Un servidor T3 por Organización, cada uno con su usuario.** Mismo aislamiento, pero con los secretos separados y sin root. Casi no requiere código (`T3CODE_HOME`, slice por hash de `stateDir`, servicio de usuario). A cambio hay que operar N procesos, N puertos y N Environments.
- **Contenedores rootless (Podman/Docker).** Suman namespaces de PID y de red y montajes explícitos, pero el kernel es compartido. Las CLIs funcionan con un volumen y `CLAUDE_CONFIG_DIR`/`CODEX_HOME`. Hay que mantener imágenes.
- **gVisor.** Interpone un kernel en espacio de usuario y no necesita KVM, a costa de overhead en las syscalls y de algunas incompatibilidades.
- **Firecracker/Kata.** Dan el aislamiento más fuerte, pero necesitan `/dev/kvm`, y muchos VPS no lo ofrecen.
- **Sandbox de cada CLI (bubblewrap, etc.).** No sirve como frontera entre Organizaciones: por defecto permite leer las credenciales, y hooks y MCP corren sin restricciones.
- Ninguna opción protege los secretos de una Organización frente a su propio agente.
- Detalle y fuentes: [research/05-opciones-de-aislamiento-entre-organizaciones.md](../research/05-opciones-de-aislamiento-entre-organizaciones.md)
