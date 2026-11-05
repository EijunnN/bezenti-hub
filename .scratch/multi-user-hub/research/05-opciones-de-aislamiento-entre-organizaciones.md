# 05 · Opciones de aislamiento entre Organizaciones en una misma máquina

Hechos y trade-offs. No incluye una decisión. Rutas relativas a la raíz del repo.

## Punto de partida en t3code

- Todos los procesos de agente pasan por un único punto: `AgentScope.wrap`. Lo usan las terminales (`apps/server/src/terminal/Manager.ts:2366`), Claude (`apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:1204`), Codex (`.../CodexAdapterV2.ts:1459`) y el navegador de preview (`apps/server/src/preview/ServerBrowser.ts:499`). En Linux, `wrap` reescribe el comando como `systemd-run --user --scope --slice=… -- cmd` (`packages/shared/src/AgentScope.ts:93-120`). Solo sirve para recursos: CPU/IO weight, TasksMax y límites de memoria (`apps/server/src/process/agentScope.ts:21-47`). Ya pasa `Delegate=yes`, cuyo comentario dice que es para que "rootless containers (Podman, kind)" gestionen sus cgroups (`agentScope.ts:91-93`).
- El slice de agentes se nombra con un hash del `stateDir` (`agentScope.ts:29-32`). Así, varios servidores T3 conviven en una misma máquina y usuario sin pisarse.
- La PTY se lanza con `node-pty` pasando solo `cwd`, `env`, `cols` y `rows` (`apps/server/src/terminal/NodePtyAdapter.ts:255-261`). `node-pty` también acepta `uid` y `gid`, con la advertencia de que pueden filtrarse descriptores con privilegios (`node_modules/.pnpm/node-pty@1.2.0-beta.15_*/node_modules/node-pty/typings/node-pty.d.ts:80-85`).
- El HOME de las CLIs es configurable por instancia. Claude usa `CLAUDE_CONFIG_DIR` y no `HOME`, porque cambiar HOME oculta el Keychain (`apps/server/src/provider/Drivers/ClaudeHome.ts:33-46`). Codex usa `CODEX_HOME` con shadow home (`docs/user/providers-codex.md:36-77`). La terminal expande ambas variables (`Manager.ts:1368`, `1449-1457`).
- Los secretos del servidor están en `<stateDir>/secrets` (`apps/server/src/config.ts:171`), con carpeta 0700 y ficheros 0600 (`apps/server/src/auth/ServerSecretStore.ts:161,203-205`). Un agente con el mismo UID que el servidor puede leerlos.
- El servicio en segundo plano es una unidad de systemd de usuario (`systemctl --user`, `apps/server/src/cloud/bootService.ts:96-110,223-228`) y necesita linger (`bootService.ts:477`).
- `docs/internals/devcontainer.md` describe solo el entorno de desarrollo para mantenedores (`:5-14`). No es una función de producto para ejecutar agentes en contenedores.
- La Managed Policy "no es un sandbox". Las CLIs leen su propia config, como `~/.claude` (`docs/user/managed-policy.md:210,286-290`).

## Opciones

### A. Usuarios del SO distintos dentro de un solo servidor T3

- **Mecanismo.** El servidor lanza cada agente o PTY con el UID de su Organización. Para eso necesita root o CAP_SETUID, o bien un helper con privilegios (sudo, o `systemd-run` contra el manager del sistema). El camino actual (`systemd-run --user`) no puede cambiar de usuario. systemd.exec dice que `User=`/`Group=` "are not supported for services running in per-user instances" (https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html). Además, las unidades scope solo admiten ajustes de kill y de resource-control, no de exec (https://www.freedesktop.org/software/systemd/man/latest/systemd.scope.html).
- **Ficheros.** Permisos POSIX. Los HOME tienen que ser 0700/0750. Ubuntu usa 0750 por defecto desde 21.04 (https://discourse.ubuntu.com/t/private-home-directories-for-ubuntu-21-04-onwards/19533). `/tmp` es compartido, salvo que se use `PrivateTmp`.
- **Secretos.** Quedan protegidos si el servidor y su `stateDir` pertenecen a otro UID. Pero el servidor pasa los secretos a los hijos por `env`, así que hay que filtrarlos por Organización.
- **Procesos.** Sin `hidepid=2`, cualquier usuario ve los `/proc/<pid>` de los demás, incluido `cmdline`. Con `hidepid=2` "become invisible" (https://man7.org/linux/man-pages/man5/proc.5.html).
- **Red.** Ninguna separación. Hay un loopback compartido, así que los dev servers y previews de una Organización son accesibles desde otra.
- **Coste y compatibilidad.** El servidor necesita privilegios, lo que aumenta el impacto si lo comprometen. Las CLIs funcionan de forma nativa, porque cada usuario tiene su propio `~/.claude` y `~/.codex`. Hay que retocar `wrap` y la PTY, y también la ruta de usuario de systemd (cgroups y linger por usuario).

### B. Un servidor T3 por Organización (cada uno con su usuario del SO)

- **Mecanismo.** Un usuario Linux por Organización, cada uno con su propio `t3 service install` y `T3CODE_HOME`. Encaja con el modelo existente: Environment = un proceso servidor con su estado (`docs/internals/remote.md:3-30`). Encaja también con la ADR 0002, donde los Environments se registran en el Hub (`docs/adr/0002-central-hub.md`).
- **Aislamiento.** El mismo que en A para ficheros, procesos y red. Es más fuerte en secretos: cada servidor solo tiene los de su Organización, y no hace falta root.
- **Coste.** N procesos Node, N puertos, N actualizaciones y N registros en el Hub, con linger por usuario. Casi no requiere código: slices separados por hash de `stateDir` (`agentScope.ts:29-32`) y servicio por usuario (`bootService.ts`).
- **Compatibilidad.** Total: las PTY y los subprocesos no cambian.
- **Límite.** Dentro de una Organización sigue sin haber aislamiento. Un agente con acceso total lee los secretos de su propio servidor (`ServerSecretStore.ts`).

### C. Contenedores rootless (Docker / Podman)

- **Mecanismo.** Usa namespaces (mount, pid, net, user) y cgroups. Lo más simple es meter todo el servidor T3 de una Organización en un contenedor, que es B dentro de un contenedor. La alternativa es contener solo los agentes, reescribiendo `AgentScope.wrap` como `podman run/exec`. Esa reescritura afecta a todos los spawns a la vez.
- **Ficheros y secretos.** El contenedor solo ve lo que se monta en él.
- **Procesos.** Hay un PID namespace propio.
- **Red.** Hay un netns propio. Con Podman rootless, el modo por defecto es pasta y `--network=none` no da interfaces (https://docs.podman.io/en/latest/markdown/podman-run.1.html).
- **Kernel.** El kernel es compartido, así que el riesgo de escape depende de los fallos del kernel.
- **Docker.** El modo rootless ejecuta "the Docker daemon and containers inside a user namespace". Necesita `newuidmap`/`newgidmap` y 65.536 subuids (https://docs.docker.com/engine/security/rootless/). `userns-remap` mapea UIDs, pero "the Docker daemon still runs as root" y no es compatible con compartir el netns o PID del host (https://docs.docker.com/engine/security/userns-remap/). Un daemon rootful hace que pertenecer al grupo `docker` equivalga a tener root (https://docs.docker.com/engine/security/#docker-daemon-attack-surface).
- **Podman.** `--userns=keep-id` mapea el UID:GID del usuario igual dentro y fuera del contenedor, lo que facilita los bind mounts de HOME y del workspace (podman-run, misma URL).
- **CLIs.** Anthropic documenta el patrón: volumen en `~/.claude` con `CLAUDE_CONFIG_DIR` apuntando a él. También advierte que, con `--dangerously-skip-permissions`, un repo malicioso puede exfiltrar todo lo accesible dentro del contenedor, credenciales incluidas (https://code.claude.com/docs/en/devcontainer). Esto aísla Organizaciones entre sí, pero no protege los secretos frente al propio agente.
- **Coste.** Hay que mantener imágenes con toolchains, volúmenes, puertos y actualizaciones de imagen. La spec de devcontainers (https://containers.dev/implementors/json_reference/) permite describirlo de forma declarativa, pero t3code no la usa en runtime.

### D. gVisor (runsc) como runtime de C

- **Mecanismo.** Es "an application kernel" en userspace que "does not pass system calls through to the host kernel". El acceso a ficheros pasa por el proceso Gofer. Es compatible con OCI y funciona con Docker y Podman (https://gvisor.dev/docs/).
- **Aislamiento.** Mucho más fuerte frente a fallos del kernel del host. No necesita KVM.
- **Coste.** Más overhead por syscall, cosa que notan git, npm y las compilaciones. Además, "does not presently implement every system call, /proc file, or /sys file" (misma URL). Las PTY y los subprocesos normales funcionan, pero conviene validar node-pty y las CLIs.

### E. MicroVMs (Firecracker, Kata)

- **Mecanismo.** Cada Organización tiene su propio kernel invitado. Firecracker "requires read/write access to `/dev/kvm`". Su guía de AWS usa solo instancias `.metal` porque "EC2 only supports KVM on .metal" (https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md). Kata hace de runtime OCI sobre QEMU, Cloud Hypervisor, Firecracker y otros (https://github.com/kata-containers/kata-containers/blob/main/docs/hypervisors.md).
- **Aislamiento.** El más fuerte de la lista para ficheros, procesos, red y kernel.
- **Coste en un VPS.** Hace falta virtualización anidada o un servidor dedicado, y muchos VPS no la ofrecen. A eso se suma gestionar imágenes de rootfs, kernel, red tap y disco por VM. Las CLIs y las PTY funcionan igual que en una máquina normal, con el servidor T3 dentro de la VM o un agente remoto conectado.

### F. Sandbox ligero por proceso (systemd exec, bubblewrap, sandbox de cada CLI)

- **systemd exec.** `ProtectHome=` deja `/home`, `/root` y `/run/user` "inaccessible and empty" (systemd.exec). En el manager de usuario, las opciones de namespacing de ficheros solo funcionan con `PrivateUsers=true` y user namespaces sin privilegios (systemd.exec). Además no aplican a scopes, que es lo que t3code usa hoy. Habría que pasar a servicios transitorios (`systemd-run --user` sin `--scope`), lo que cambia cómo se capturan stdio y PTY.
- **Sandbox de cada CLI.** Claude Code usa bubblewrap más un proxy de red, pero las lecturas están permitidas en casi todo el disco por defecto: "This default still allows reading credential files". Hooks, MCP locales y LSP corren "with your full access" (https://code.claude.com/docs/en/sandboxing).
- **Conclusión.** Este nivel solo vale como defensa en profundidad, no como frontera entre Organizaciones. Además depende de cada proveedor, y hay más de diez drivers (`apps/server/src/provider/builtInDrivers.ts`).

## Comparativa

| Opción                             | Ficheros/secretos                           | Procesos        | Red            | Kernel            | Coste en 1 VPS                   | CLIs (HOME)                                | PTY/subprocesos                      | Hooks existentes                                   |
| ---------------------------------- | ------------------------------------------- | --------------- | -------------- | ----------------- | -------------------------------- | ------------------------------------------ | ------------------------------------ | -------------------------------------------------- |
| A. Usuarios SO, 1 servidor         | DAC; el servidor gestiona secretos de todos | con `hidepid=2` | compartida     | compartido        | medio; servidor privilegiado     | nativo                                     | cambiar uid en `wrap`/PTY            | `wrap` como único punto de spawn                   |
| B. 1 servidor por Org + usuario SO | DAC; secretos separados                     | con `hidepid=2` | compartida     | compartido        | bajo-medio; N procesos/puertos   | nativo                                     | sin cambios                          | `T3CODE_HOME`, slice por hash, servicio de usuario |
| C. Contenedor rootless             | solo lo montado                             | PID ns          | netns          | compartido        | medio; imágenes y volúmenes      | volumen + `CLAUDE_CONFIG_DIR`/`CODEX_HOME` | sin cambios si el servidor va dentro | `Delegate=yes`; env por instancia                  |
| D. C + gVisor                      | igual que C                                 | igual que C     | igual que C    | kernel de usuario | medio-alto; overhead de syscalls | igual que C                                | validar node-pty                     | igual que C                                        |
| E. MicroVM                         | máximo                                      | máximo          | máximo         | propio            | alto; necesita KVM               | normal dentro de la VM                     | normal dentro de la VM               | ninguno                                            |
| F. Sandbox por proceso             | parcial; lectura amplia                     | parcial         | netns opcional | compartido        | bajo                             | depende del proveedor                      | depende del proveedor                | ninguno común                                      |

## Observaciones transversales

- Las opciones se pueden combinar: B dentro de C (un usuario y un contenedor por Organización), o C con `runsc` (D).
- Ninguna opción protege los secretos de una Organización frente a su propio agente si están en su entorno o en su HOME. Eso depende de cómo inyecte el Hub las credenciales.
- Con B, o con C con el servidor dentro, cada Organización es para el Hub uno o más Environments. Con A, o con C solo para los agentes, es una partición dentro de un Environment.
