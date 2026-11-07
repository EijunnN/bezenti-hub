# Spec: Sandboxes y External environments

Status: ready-for-agent
Map: ../multi-user-hub/map.md (spec 3 de 6)
Decisiones de origen: «Aislamiento entre Organizaciones», «Registrar Environments en el Hub», «Cierre del mapa» (`../multi-user-hub/issues/10`, `13`, `16`); investigación `../multi-user-hub/issues/05`
ADRs: 0002 (el Hub es la fuente de verdad), 0004 (un Sandbox rootless por Space), 0006 (el Hub guarda los Threads; los Environments ejecutan)
Vocabulario: `GLOSSARY.md` (raíz) por encima de `docs/internals/glossary.md`
Depende de: spec 1 «Identidad y acceso» y spec 2 «El Hub como store de Threads» (done)

## Problem Statement

Tras el spec 2, el trabajo que no elige otra máquina corre en el propio proceso del Hub, con el usuario del sistema del Owner. Todos los Spaces comparten así los mismos archivos, procesos, red y credenciales. El agente de una Organization puede leer los archivos de otra, ver sus procesos o conectarse a sus servidores de desarrollo. También puede leer los secretos y las sesiones del propio Hub. Además, solo el Owner puede unir máquinas, y todas en modo personal. Un Member no puede aportar su laptop, y una Organization no puede tener una VPS propia para todo su equipo. Por último, los Peer Links siguen siendo un segundo camino entre servidores, con su propia autenticación y fuera de las reglas del Hub.

## Solution

Cada Space tiene su **Sandbox**: un servidor T3 dentro de un contenedor rootless de Podman en la máquina del Hub, con su propio usuario, su volumen, sus límites de CPU, memoria y disco, y una red que sale a internet pero no ve otros Sandboxes ni los puertos internos del Hub. El Sandbox se crea la primera vez que hace falta, se para tras 30 minutos sin actividad y vuelve a arrancar solo cuando hay trabajo. El proceso del Hub deja de ejecutar agentes: lo que no elige otra máquina corre en el Sandbox de su Space. Los previews de un Sandbox se sirven a través del Hub, con sesión, y solo para los Members del Space.

Las máquinas externas tienen dos modos:

- **Personal:** como en el spec 2. Ahora también la puede unir un User que tenga el Installation permission «registrar mis propios Environments».
- **Dedicado a un Space:** lo une el Owner y lo usan todos los Members de ese Space. Ejecuta el trabajo dentro del mismo contenedor e imagen que un Sandbox.

El Owner puede instalar una máquina dedicada desde el Hub por SSH, sin entrar en ella. Los Peer Links desaparecen.

## User Stories

### Sandbox de cada Space

1. As a Member, I want a Thread I start without choosing a machine to run in my Space's Sandbox, so that my work never runs inside the Hub process.
2. As a Member, I want my Space's Sandbox to be created the first time it is needed, so that nobody has to set it up beforehand.
3. As a Member, I want to see «Starting the Sandbox…» on a Thread while its Sandbox boots, so that I understand the short wait.
4. As a Member, I want the Sandbox to appear in the Environment selector as «<Space name> Sandbox», so that I know where my work runs.
5. As a User with a Personal space, I want my Personal space to get its own Sandbox if I may create in it, so that my personal work is isolated from every Organization.
6. As a Member, I want my Space's files, Project checkouts, provider logins and caches to persist in the Sandbox's volume across restarts, so that a stopped Sandbox loses nothing.
7. As a Member, I want terminals, file tools, search and previews of a Sandbox Thread to act inside that Sandbox, so that everything sees the same files the agent sees.
8. As a Member, I want a Sandbox that has been idle for 30 minutes to stop by itself, so that idle Spaces don't consume the server.
9. As a Member, I want a stopped Sandbox to start again by itself when I send a message, open a terminal or browse files, so that I never have to start it by hand.
10. As a Member, I want a Thread whose Sandbox failed to start to show the reason and a «Try again» action, so that I'm never stuck.
11. As a Member, I want a Sandbox whose container crashed mid-turn to behave like an offline Environment from spec 2 (paused, then resumed or interrupted), so that crashes don't lose history.
12. As an Admin of an Organization, I want to log in to provider CLIs inside our Sandbox from a Sandbox terminal, so that our Space uses its own provider credentials until AI accounts arrive.

### Aislamiento

13. As a Member, I want my Sandbox to be unable to read another Space's files, so that our code stays private.
14. As a Member, I want my Sandbox to be unable to see another Space's processes, so that their commands and arguments stay private.
15. As a Member, I want my Sandbox to be unable to connect to another Sandbox or to the Hub's internal ports, so that nobody can reach our dev servers or the Hub's internals.
16. As a Member, I want my Sandbox to reach the internet, so that the agent can install packages and call APIs.
17. As the Owner, I want no Sandbox to see the Hub's database, secrets, sessions or the Owner's own home directory, so that a compromised agent can't take over the Installation.
18. As the Owner, I want a Sandbox's only way to the Hub to be its Environment connection and its Space's git repositories, so that the attack surface is small and known.
19. As the Owner, I want a Sandbox's credential to be valid only for its own Space, so that a stolen Sandbox credential can't touch other Spaces.
20. As the Owner, I want Sandboxes to run rootless, so that an escape from a container doesn't land as root on my server.

### Recursos y ciclo de vida

21. As the Owner, I want default CPU, memory and disk limits for every Sandbox, so that one Space can't starve the others.
22. As the Owner, I want to change a Space's Sandbox limits, so that a heavy Organization can get more.
23. As an Admin, I want to see my Space's Sandbox status, uptime, resource use and limits, so that I understand why it is slow or full.
24. As the Owner, I want to start, stop and restart any Sandbox from Settings, so that I can recover a misbehaving one.
25. As the Owner, I want a Sandbox that hits its disk limit to show a clear error on the Thread, so that a full disk is not a mystery.
26. As the Owner, I want archiving an Organization to stop its Sandbox, and restoring it to allow it to start again, so that archived Spaces use nothing.
27. As the Owner, I want deleting an Organization for good to delete its Sandbox and volume, so that nothing of it remains.
28. As the Owner, I want Sandbox creation, limit changes, start/stop by hand and deletion recorded in the audit log, so that I can trace what happened.

### Imagen base

29. As the Owner, I want one base image for all Sandboxes with node, git and the AI CLIs, so that every Space has the same toolchain.
30. As the Owner, I want to build or update the base image from the Hub (CLI and Settings), so that I can upgrade the toolchain without manual Podman commands.
31. As the Owner, I want each Sandbox to show which image version it runs, so that I know which ones are outdated.
32. As the Owner, I want idle Sandboxes to pick up a new image on their next start, and running ones to be updated only when I ask, so that upgrades never interrupt a turn.
33. As the Owner, I want image updates recorded in the audit log, so that toolchain changes are traceable.

### Previews

34. As a Member, I want a dev server started in my Sandbox to be reachable through the Hub at an authenticated URL, so that I can see my app without opening ports.
35. As a Member of another Space, I want to be refused when I open that preview URL, so that previews are private to their Space.
36. As a Member, I want previews to keep working through the Hub's public URL and proxy settings, so that previews work from anywhere I can reach the Hub.

### External environments: modos y permisos

37. As a User with «register my own Environments», I want to run `t3 join` on my laptop and have it approved by myself, so that I can work on my machine without asking the Owner.
38. As a User without that permission, I want `t3 join` approval to tell me I need it, so that I know whom to ask.
39. As the Owner, I want to grant and revoke «register my own Environments» per User, as in spec 1, so that I decide who adds machines.
40. As a User, I want my personal machine to be usable only by me, in any of my Spaces, so that nobody else runs work on my laptop.
41. As the Owner, I want to register a machine dedicated to one Space, so that a whole Organization can use a shared VPS.
42. As a Member, I want the Space's dedicated machines in my Environment selector, so that I can run heavy work there.
43. As a Member of another Space, I don't want to see or use that dedicated machine, so that it serves only its Space.
44. As the Owner, I want a dedicated machine to run work inside the Sandbox container and image, so that it isolates its Space from the machine's own users and files like a Sandbox does.
45. As the Owner, I want to change a machine between personal and dedicated, or to another Space, only after its Threads have moved away, so that no work is stranded.
46. As the Owner, I want to see every machine with its mode, owner or Space, status and running Threads, so that I can manage them all.
47. As a User, I want to see and remove my own personal machines in Settings, so that I manage them without the Owner.

### Instalar por SSH

48. As the Owner, I want to add a dedicated machine by giving the Hub its SSH host, user and key, so that I don't log in to it myself.
49. As the Owner, I want the Hub to install T3 and Podman prerequisites, register the machine and start it, showing each step, so that I know what was done.
50. As the Owner, I want the SSH key to be used only for the installation and not kept unless I ask, so that the Hub doesn't hold long-lived access to my servers.
51. As the Owner, I want a failed SSH installation to stop with the failing step and its output, and to leave no half-registered machine, so that I can fix and retry.
52. As the Owner, I want the SSH installation recorded in the audit log, without the key, so that machine additions stay traceable.

### Peer Links

53. As the Owner, I want Peer Links removed, with their screens, credentials and remote delegation, so that the Hub is the only way servers talk to each other.
54. As the Owner, I want existing Peer Link credentials revoked on upgrade, so that no old link keeps working.

### Cambios de Space y continuidad

55. As the Owner, I want moving a Project to another Space (spec 1) to require its Threads to be stopped and then to run them in the destination Space's Sandbox or machines, so that a Project never keeps running in the old Space's Sandbox.
56. As a Member, I want Threads whose Active environment is no longer usable by their Space (Sandbox deleted, machine rededicated) to become «needs an environment» and be movable, so that nothing is stranded.
57. As a User, I want to move a Thread between my Space's Sandbox, its dedicated machines and my personal machines with spec 2's move, so that continuity works across all kinds of Environments.

### Clientes

58. As a User on web or desktop, I want the Environment selector, the Thread header and the sidebar to show Sandboxes and dedicated machines with their status (running, stopped, starting, failed, online, offline), so that I always know where work runs.
59. As a User on mobile, I want the same Environment names and statuses, so that I see the same picture on my phone.
60. As the Owner on web, I want a «Sandboxes» section in Settings → Environments with status, resources, limits, image version and actions, so that I manage them in one place.

## Implementation Decisions

### Arquitectura

- **Sandbox runtime:** un servicio nuevo en el Hub. Crea, arranca, para, borra e inspecciona Sandboxes. Tiene dos implementaciones:
  - **Podman:** la de producción.
  - **Process:** para tests y desarrollo. Lanza un servidor T3 joined como proceso hijo, sin contenedor.

  Todo lo demás habla con la interfaz, nunca con Podman directamente.

- **Un Sandbox es un servidor T3 en modo joined**, el del spec 2, dentro del contenedor. Se registra en el Hub como un Environment de tipo `sandbox` ligado a un Space. Por eso la ejecución remota, los checkpoints, el repositorio del Hub, los movimientos, las desconexiones y los previews del spec 2 se aplican sin cambios.
- **Credencial:** el Hub la emite él mismo al crear el Sandbox, sin aprobación humana. Vale solo para ese Space y se guarda en el volumen del Sandbox. Borrar el Sandbox la revoca.
- **El Hub deja de ejecutar agentes.** El executor en proceso del Hub machine del spec 2 deja de ofrecerse como Environment:
  - La colocación por defecto pasa a ser el Sandbox del Space.
  - Un ajuste de desarrollo (desactivado por defecto) mantiene el executor en proceso para trabajar sin Podman. Los tests y el modo dev lo usan.
  - Los Threads cuyo Active environment es el Hub machine quedan en «needs an environment» y se pueden mover.
- **Colocación:** la elección explícita del User, luego el Environment preferido del Project, luego el Sandbox del Space. `previewThreadPlacement`, la regla compartida del spec 2, se amplía con los Sandboxes. Si el Sandbox está parado, cuenta como disponible y arranca bajo demanda.
- **Regla `environment.use` ampliada** (tabla probada en `AccessPolicy`):
  - Sandbox: los Users con derecho a trabajar en su Space.
  - Dedicado: lo mismo, para su Space.
  - Personal: solo su dueño, en cualquiera de sus Spaces.

### Contenedor, red y límites

- **Usuario:** un contenedor por Sandbox, rootless, con el usuario de servicio del Hub. Dentro corre con un usuario sin privilegios.
- **Volumen:** cada Sandbox tiene su volumen persistente, montado como home y workspace root del servidor joined. No se monta nada del Hub más allá de eso y del socket de conexión.
- **Red:**
  - Salida a internet por la red propia de cada contenedor (pasta o slirp4netns).
  - Sin acceso a la loopback del host ni a otros contenedores.
  - El Hub queda accesible solo por un socket UNIX montado en el contenedor. Por él pasan la conexión del Environment y el git smart HTTP del Hub.
  - El Hub no expone otros puertos a los contenedores.
- **Límites:** CPU, memoria, PIDs y disco por Sandbox. Hay valores por defecto de la Installation y un override por Space (tabla nueva `sandboxes` con Space, estado, versión de imagen, límites y fechas). El disco se limita con la cuota del volumen. Si el backend de almacenamiento no la soporta, se vigila y se para con un error claro.
- **Ciclo de vida:**
  - Se crea al primer uso.
  - Se para tras 30 minutos sin turnos, terminales ni previews activos.
  - Arranca bajo demanda: los effects y RPCs atados a la máquina esperan a que esté arrancado. Un fallo de arranque es un error tipado que se ve en el Thread.
  - Archivar una Organization lo para y bloquea el arranque.
  - Borrar la Organization para el Sandbox, borra el volumen y revoca la credencial, dentro del flujo de borrado del spec 1.
  - Cada transición queda auditada.
- **Provider logins:** cada Sandbox guarda las suyas en su volumen. Hasta el spec 4, los Admins de la Organization (o el dueño del Personal space) inician sesión desde una terminal del Sandbox. Los secretos del Hub nunca entran en un Sandbox.

### Imagen base

- **Definición:** un Containerfile en el repo, con node, git, las CLIs de IA soportadas y el servidor T3 de la versión del Hub.
- **Construcción:** el Hub la construye con Podman mediante `t3 sandbox image build` o desde Settings, y la etiqueta con la versión.
- **Versiones:** cada Sandbox registra su versión.
- **Actualización:** los Sandboxes parados usan la nueva al arrancar. Los que están en marcha se actualizan solo cuando lo pide el Owner, y nunca a mitad de un turno.

### Previews

- Una URL de preview autenticada en el Hub, por Sandbox y puerto, hace de proxy hacia el puerto del contenedor a través del canal del Environment. Es la misma capa de streams del spec 2 (ticket 05).
- El Hub comprueba la sesión y la pertenencia al Space en cada petición.
- Funciona igual con un External environment dedicado.

### External environments

- **Permiso:** `environments.registerOwn` (Installation permission del spec 1) pasa a tener efecto. Un User con ese permiso aprueba el alta de su propia máquina en modo personal, con factor fuerte. Sin el permiso, la aprobación se rechaza con un motivo claro.
- **Modo dedicado:**
  - Solo el Owner registra máquinas dedicadas. Al aprobarlas elige el Space, en la misma página de alta o con `t3 join --dedicated`.
  - La máquina corre el trabajo dentro de un contenedor con la imagen del Sandbox (Podman en esa máquina), con el mismo ciclo de vida y los mismos límites.
  - Requiere Podman rootless en la máquina, y `t3 join` comprueba que esté.
- **Modelo:** la tabla `environments` gana `mode` (`personal` | `dedicated` | `sandbox`), `spaceId` para los dedicados y los Sandboxes, y el tipo `sandbox`.
- **Cambiar de modo o de Space** exige que la máquina no tenga Threads activos. Si los tiene, se rechaza indicando cuáles hay que mover.
- **Gestión:**
  - Settings → Environments lista los Sandboxes, las máquinas dedicadas y las personales.
  - El Owner lo ve todo.
  - Cada User ve sus máquinas personales y los Sandboxes y máquinas dedicadas de sus Spaces, y quita las suyas.

### Instalación por SSH

- **Entrada:** el Owner da host, puerto, usuario y clave privada (o agente). El Hub abre la sesión SSH desde su proceso.
- **Pasos:**
  1. Comprueba el sistema operativo y Podman, e instala Podman si falta y hay sudo sin contraseña. Si no, se detiene con instrucciones.
  2. Instala la versión de T3 del Hub.
  3. Registra la máquina como dedicada con una concesión de un solo uso emitida por el Hub, sin aprobación aparte.
  4. Arranca su servicio de usuario.
- **Progreso:** cada paso se ve en la UI con su salida.
- **Clave:** se usa en memoria y no se guarda, salvo que el Owner marque «keep for updates». En ese caso va al secret store del Hub.
- **Fallos:** la concesión caduca y no queda ninguna máquina registrada a medias.
- **Auditoría:** se registra como `environment.register`, con modo `dedicated` y vía `ssh`, sin la clave.

### Peer Links

- Se quitan:
  - el servicio y las rutas de Peer Links;
  - `PeerForwarding` y `RemoteDelegation`;
  - las tablas y la UI;
  - el software id `t3code-peer-link` en el registro OAuth de MCP.
- Una migración revoca sus credenciales y borra sus filas.
- La delegación entre Threads de un mismo Hub sigue funcionando por el Orchestrator.

### Cambio de Space de un Project

- El flujo del spec 1 añade un paso: los Threads del Project se detienen. Después, cada Thread cuyo Active environment ya no sirve en el Space de destino (el Sandbox del origen o una máquina dedicada a él) pasa a «needs an environment». Al confirmar se ofrece moverlos al Sandbox del destino.

### Clientes

- Los nombres y estados de los Sandboxes y de las máquinas dedicadas llegan por la fuente compartida de Environments del Hub en client-runtime (spec 2). Web, desktop y móvil los muestran igual.
- Estados nuevos: `starting`, `stopped`, `failed`, además de online, reconnecting y offline.
- Settings → Environments gana:
  - la sección «Sandboxes»: estado, recursos, límites, imagen y acciones;
  - el diálogo «Add a machine over SSH»;
  - el modo de cada máquina.
- En móvil, la lista es de solo lectura para el Owner.

### Auditoría

- Acciones nuevas en la allow-list del spec 1:
  - `sandbox.create`, `sandbox.start`, `sandbox.stop`, `sandbox.delete`;
  - `sandbox.limits.change`;
  - `sandbox.image.update`;
  - `environment.mode.change`.
- `environment.register` registra el modo y la vía (join o ssh).

## Testing Decisions

- **Un test bueno** comprueba lo que ve un User, el Owner o un Environment a través de interfaces públicas: RPC del Hub, protocolo del Environment, git smart HTTP, URLs de preview. Red-first en reglas de seguridad y bugs.
- **Seam principal:** el testkit «Hub con Environments» del spec 2, con el **Sandbox runtime de tipo process**. Ahí se prueba:
  - la creación al primer uso;
  - el arranque bajo demanda y la parada por inactividad, con el reloj de tests;
  - la colocación por defecto en el Sandbox;
  - `environment.use` con Sandboxes, dedicadas y personales;
  - el alta con `registerOwn`;
  - los cambios de modo;
  - las credenciales de Sandbox limitadas a su Space, incluido el repositorio git del Hub;
  - el proxy de previews con la autorización por Space;
  - archivar y borrar una Organization;
  - el cambio de Space de un Project;
  - los Threads del Hub machine que pasan a «needs an environment».
- **Seam de aislamiento real:** un grupo pequeño de tests de integración con el runtime **Podman**. Solo se ejecuta si Podman rootless está disponible; en el WSL de desarrollo hay que instalarlo. Comprueba, con dos Sandboxes de dos Spaces:
  - un Sandbox no puede leer el volumen del otro;
  - no ve sus procesos;
  - no conecta a sus puertos ni a la loopback del Hub;
  - sí sale a internet;
  - el límite de memoria y el de PIDs se aplican;
  - un Sandbox se para y vuelve a arrancar conservando el volumen.
- **SSH:** contra un servidor SSH de test (un contenedor con sshd, o un fake del cliente SSH en tests unitarios) para los pasos, los fallos y que no queda nada a medias.
- **Peer Links:** el test de la migración comprueba que se revocan las credenciales y se borran las filas. La suite actual debe pasar tras quitar el código.
- **Prior art:** `HubWithEnvironments.test.ts` y `.disconnections.test.ts`, `AccessPolicy` (tabla), `AuditLog.test.ts`, los tests de migraciones y los tests del agente joined del spec 2.
- **Prueba real por ticket de interfaz:** en WSL con Podman. Un Hub dev con dos Organizations: cada una crea su Sandbox al primer Thread, el preview de una no se abre desde la otra, y el Sandbox se para y vuelve a arrancar.

## Out of Scope

- **AI accounts y AI gateway** (spec 4). Hasta entonces, cada Sandbox usa las provider logins de su volumen.
- **Vaults** (spec 5). Cómo llegan los secretos a un Sandbox, y cómo se protegen frente al agente de su propio Space, se decide allí.
- **Vista de procesos** (spec 6).
- **Runtimes más fuertes** (gVisor, microVMs), que quedan como opción futura del Sandbox runtime.
- **Imágenes de Sandbox personalizadas por Space** y **egress allowlist**, que son mejoras futuras según «Cierre del mapa».
- **La limpieza de `ScopedThreadRef`**, que es el ticket 14 del spec 2.

## Further Notes

- **Requisitos en la máquina del Hub:** Podman rootless (subuid/subgid y `systemd --user`). En el WSL de desarrollo falta Podman y hay que instalarlo con sudo antes de los tests de aislamiento y de las pruebas reales.
- **Riesgos:**
  - **Kernel compartido:** un escape del contenedor es posible ante bugs del kernel. Se acepta según el ADR 0004, con rootless como mitigación.
  - **Disco:** la cuota del volumen depende del backend de almacenamiento de Podman.
  - **Arranques:** el arranque en frío de un Sandbox añade latencia al primer mensaje tras la inactividad.
- **Orden sugerido para los tickets:**
  1. Sandbox runtime (process) y el Sandbox como Environment de un Space.
  2. Arranque bajo demanda y parada por inactividad.
  3. El Hub deja de ejecutar agentes y coloca por defecto en el Sandbox.
  4. Runtime Podman y tests de aislamiento.
  5. Límites y gestión en Settings.
  6. Imagen base.
  7. Previews por el Hub.
  8. `registerOwn` y modo personal para Users.
  9. Modo dedicado.
  10. Instalación por SSH.
  11. Quitar los Peer Links.
  12. Cambio de Space de un Project con Sandboxes.
  13. Clientes (web, desktop y móvil).
