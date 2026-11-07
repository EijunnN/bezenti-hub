# Spec: El Hub como store de Threads y movimiento entre Environments

Status: done (pendiente: ticket 14, limpieza interna)
Map: ../multi-user-hub/map.md (spec 2 de 6)
Decisiones de origen: «Registrar Environments en el Hub», «Mover un Project entre Environments», «Cierre del mapa» (`../multi-user-hub/issues/13`, `14`, `16`)
ADRs: 0002 (el Hub es la fuente de verdad), 0006 (el Hub guarda los Threads; los Environments solo ejecutan), 0007 (sin servicios upstream)
Vocabulario: `GLOSSARY.md` (raíz) por encima de `docs/internals/glossary.md`
Depende de: spec 1 «Identidad y acceso» (done)

## Problem Statement

Hoy cada servidor T3 guarda sus propios Threads: su historial, sus checkpoints y sus adjuntos viven en la máquina que los ejecuta. Si el Owner empieza un Thread en su laptop y cierra la tapa, nadie más lo ve, y él mismo no puede seguirlo desde su PC ni desde la VPS. Tampoco hay forma de llevar el trabajo de una máquina a otra. Los archivos del Project, los cambios sin commitear y lo que el agente sabe se quedan en la máquina de origen. El cliente conecta con cada máquina por separado y elige dónde correr un Thread según la carga, sin que el Hub sepa nada. La Installation del spec 1 ya sabe quién es cada User y qué puede ver, pero el trabajo sigue atado a un ordenador.

## Solution

El Hub pasa a ser el único lugar donde viven los Threads. Guarda su historial y decide cada paso, y los Environments solo ejecutan lo que necesita una máquina: el agente, los checkpoints, las terminales y los archivos. Cada Environment devuelve al Hub lo que ocurre. El Owner une una máquina (su PC, su laptop u otra VPS) con `t3 join <url del Hub>` o con un botón del desktop, una sola vez. La confirma en el Hub, sin códigos. La máquina siempre conecta hacia el Hub, así que no hay que abrir puertos. El propio Hub también es un Environment.

Cada Thread corre en un único Environment, su Active environment, y se ve igual desde cualquier cliente aunque esa máquina esté apagada. Moverlo es una acción del Thread:

- Al terminar cada turno, el Environment sube el checkpoint a un repositorio git que el Hub guarda por Project.
- Quien toma el relevo descarga el último.
- El agente de destino recibe un traspaso: un resumen, los mensajes recientes y una herramienta para consultar el historial completo.

Lo cambiado a mano que no se subió nunca se pisa: va a una rama aparte y se avisa. Si una máquina se desconecta con un turno en marcha, el Thread se pausa y se reanuda cuando vuelve.

## User Stories

### Unir máquinas al Hub

1. As the Owner, I want to run `t3 join <hub url>` on my PC once, so that it becomes an Environment of my Installation.
2. As the Owner, I want `t3 join` to open my browser at the Hub and ask me to confirm the machine by name, so that joining needs no pairing code.
3. As the Owner, I want the confirmation page to show the machine's name, operating system and the time of the request, so that I recognise what I am approving.
4. As the Owner, I want to be able to rename the machine on the confirmation page, so that it shows up as "Laptop" instead of a hostname.
5. As the Owner, I want the joined machine to connect out to the Hub, so that I don't open ports or configure my router.
6. As the Owner, I want a joined machine to reconnect by itself after a reboot or a network drop, so that I don't join it again.
7. As the Owner, I want a desktop-app setting "Use this computer as an Environment", so that I can join my laptop without a terminal.
8. As the Owner, I want `t3 join` to refuse a Hub URL that is not HTTPS (except localhost), so that the machine's credential never travels in clear text.
9. As the Owner, I want a machine joined to the Hub to stop serving its own Threads and sign-in screens, so that there is only one place where work lives.
10. As the Owner, I want `t3 status` on a joined machine to show which Hub it belongs to and whether it is connected, so that I can diagnose it from the shell.
11. As the Owner, I want `t3 leave` on a joined machine to unregister it, so that I can retire a machine cleanly.
12. As the Owner, I want the Hub machine itself to appear as an Environment, so that Threads can keep running on the VPS as they do today.
13. As the Owner, I want approving a machine to require my strong sign-in (passkey, or password + TOTP), so that a stolen browser session cannot add machines.
14. As the Owner, I want each join and removal to be recorded in the audit log, so that I know which machines got access and when.

### Ver y gestionar Environments

15. As the Owner, I want an "Environments" view in Settings listing every Environment with its name, kind, status, last seen time and running Threads, so that I see my machines at a glance.
16. As the Owner, I want each Environment's status to be online, offline or reconnecting, updated live, so that I know where I can run work right now.
17. As the Owner, I want to see each Environment's available providers and their versions, so that I know which agents it can run.
18. As the Owner, I want to see each Environment's CPU, memory and disk headroom, so that I can choose where to put heavy work.
19. As the Owner, I want to remove an Environment from the Hub, so that a lost or retired machine loses access at once.
20. As the Owner, I want removing an Environment to revoke its credential immediately, even while it is connected, so that it can't push, fetch or receive work afterwards.
21. As the Owner, I want the Threads of a removed Environment to keep all their history and become movable, so that removing a machine never loses work.
22. As the Owner, I want to rename an Environment later, so that names stay meaningful.
23. As a Member, I want to see the Environments I can use in this Space, but not the Owner's personal machines, so that I don't see machines that aren't mine.

### Dónde corre un Thread

24. As a User, I want every Thread to show its Active environment by name in its header and in the sidebar, so that I always know where it runs.
25. As a User, I want the composer of a new Thread to offer the Environments I can use, with the default selected, so that I choose where it starts.
26. As a User, I want a new Thread to start on the Project's preferred Environment when it has one, or on the Hub machine otherwise, so that I don't choose every time.
27. As the Owner, I want to set a preferred Environment on a Project, so that its new Threads start on my PC by default.
28. As a User, I want an Environment that is offline, or that lacks the selected provider, to show as unavailable with the reason, so that I don't start a Thread that can't run.
29. As a User, I want the client to connect only to the Hub, so that I sign in once and see all my Threads whichever machine runs them.
30. As a User, I want the Hub, not my browser, to decide where a new Thread runs, so that the choice is the same from web, desktop and mobile.

### El historial vive en el Hub

31. As a Member, I want to read an Organization's Threads even when the machine that ran them is off, so that the team's work is always visible.
32. As a User, I want messages, plans, tool calls, approvals and diffs to stream live from the Environment to every client watching the Thread, so that remote execution feels like local execution.
33. As a User, I want the turn diff and the full Thread diff to open even when the Environment is offline, so that I can review work at any time.
34. As a User, I want attachments I add to a Thread to be stored in the Hub and sent to the Environment that runs the turn, so that they survive a move.
35. As a User, I want command output to stream live while a turn runs, so that I can watch long commands.
36. As a User, I want approvals and questions from the agent to reach me through the Hub and my answer to reach the Environment, so that I can answer from any client, including mobile.
37. As a User, I want interrupt, steer and stop to work the same whether the Thread runs on the Hub machine or on my laptop, so that I have the same control everywhere.
38. As a User, I want terminals, file reads, file writes and file search in a Thread to act on its Active environment, so that the tools see the files the agent sees.
39. As a User, I want terminals and file tools to show "environment offline" when the Active environment is off, instead of failing silently, so that I understand why.
40. As a User, I want the Hub to refuse an event that arrives from an Environment that is not the Thread's Active environment, so that an old machine can't write into a Thread that moved.
41. As a User, I want no event to be lost or duplicated when the network drops in the middle of a turn, so that the history stays exact.
42. As a User, I want everything spec 1 enforces (Roles, Space visibility, frozen Spaces, Threads I can't continue) to apply unchanged to remote Threads, so that a remote machine is not a way around permissions.
43. As a User, I want the agent on a remote Environment to use its MCP tools with exactly my permissions, so that my agent can't do more than I can.

### Checkpoints y repositorio del Hub

44. As a User, I want each turn's checkpoint, including uncommitted, non-ignored changes, to be uploaded to the Hub when the turn ends, so that the latest state survives the machine going off.
45. As a User, I want rollback to a checkpoint to work on any Environment that holds the Thread, so that undo still works after a move.
46. As the Owner, I want the Hub to keep one git repository per Project for checkpoints and Thread branches, so that files can move between machines without a third-party service.
47. As the Owner, I want my own remote (GitHub, etc.) to stay separate and untouched by the Hub repository, so that checkpoints never leak into my real remote.
48. As the Owner, I want an Environment to read and write only the Hub repositories of Projects it may work on, so that a machine can't take another Space's code.
49. As a User, I want a failed checkpoint upload to retry by itself and to show "not uploaded yet" on the turn, so that I know a move would not include that turn.
50. As a User, I want a Thread without a Project to keep a scratch workspace that also moves, so that quick Threads aren't tied to one machine either.

### Mover un Thread

51. As a User, I want a "Move to another Environment" action on a Thread I can continue, so that I can keep working from another machine.
52. As a User, I want the move dialog to list the Environments I can use with their status and to explain what will happen, so that I choose with confidence.
53. As a User, I want moving a Thread with a running turn to ask whether to wait for the turn or stop it, with "wait" as the default, so that I don't lose work by accident.
54. As a User, I want the source Environment, when online, to upload a final checkpoint including my manual changes before the move completes, so that nothing I typed by hand is left behind.
55. As a User, I want the target Environment to fetch the latest checkpoint, recreate the Thread's branch or worktree and run the Project's setup script, so that the workspace is ready to continue.
56. As a User, I want ignored files (dependencies, builds) to be regenerated on the target by the setup script, so that moves stay small.
57. As a User, I want a move to work when the source Environment is offline, using the last uploaded checkpoint, so that a dead laptop doesn't block me.
58. As a User, I want a timeline entry "Moved from Laptop to VPS", with who moved it and which checkpoint it continues from, so that the history explains the move.
59. As a User, I want the move to show its progress (finishing the turn, uploading, fetching, preparing, ready) and a clear error if a step fails, so that I know what is going on.
60. As a User, I want a failed move to leave the Thread on its source Environment, so that a failure never leaves it nowhere.
61. As a User, I want, when a machine that was off comes back with unuploaded changes for a Thread that has moved, those changes to go to a separate branch and a notice in the Thread, so that nothing is overwritten or merged silently.
62. As a User, I want that notice to say which branch holds the recovered changes and on which Environment they were found, so that I can bring them back myself.
63. As a User, I want only one move of a Thread at a time, so that two clients can't race the same Thread to two machines.
64. As a Guest, I don't want to see the move action, so that read-only access stays read-only.
65. As the Owner, I want moving a Thread of another User to be refused just like continuing it, so that the rule from spec 1 holds.
66. As a User, I want each move to be recorded in the audit log, so that the Owner can trace where work ran.

### Memoria del agente

67. As a User, I want a Thread that stays on the same Environment to resume the agent's native session, so that nothing changes for normal use.
68. As a User, I want the agent on the target Environment to receive a handoff with a summary written by the source agent, so that it knows what was done and what is next.
69. As a User, I want the Hub to write that summary when the source Environment is offline, so that a move never starts with an empty memory.
70. As a User, I want the handoff to include a selection of the most recent messages within a size budget, so that the agent sees the immediate context word for word.
71. As a User, I want the agent to have a tool to search and read the Thread's full history, so that it can look up older decisions when it needs them.
72. As a User, I want the handoff summary to be visible in the timeline, so that I can check what the new agent was told.
73. As a User, I want a move to cost at most one extra model call (the summary), so that moving stays cheap.

### Desconexiones

74. As a User, I want a Thread whose Active environment disconnects during a turn to show "paused, environment offline", so that I know why nothing happens.
75. As a User, I want that Thread to resume by itself when the Environment returns, if the agent process survived, so that a short network drop costs nothing.
76. As a User, I want a turn whose agent process did not survive to be marked interrupted, with the option to continue on the same or another Environment, so that I'm never stuck.
77. As a User, I want messages I send to a paused Thread to queue until it resumes or I move it, so that I can keep typing.
78. As the Owner, I want an Environment that stays offline to keep its Threads visible and movable, so that I can bring the work elsewhere.

### Clientes

79. As a User on web or desktop, I want the Active environment, its status and the move action in the Thread header and menu, so that moving is one click away.
80. As a User on mobile, I want to see where each Thread runs, its offline state, and to move it, so that I can redirect work from my phone.
81. As the Owner on mobile, I want to see the Environments list with status, so that I can check my machines from my phone.
82. As a User, I want desktop to behave as a client of the Hub (and optionally as an Environment), so that the same app works on every machine.

## Implementation Decisions

### Arquitectura: el Hub decide y los Environments ejecutan

- Las decisiones las toma un único Orchestrator, en el Hub. En el Hub viven también:
  - el event sink, con eventos, proyecciones, receipts, auditoría y outbox en una sola transacción;
  - el effect outbox y el effect worker;
  - toda la autorización del spec 1.
- Los Environments no tienen Users, Spaces, Threads ni proyecciones propios.
- La persistencia de la orquestación no se divide: los eventos de un turno se ingieren en el Hub con los mismos guards de hoy (`writeIfRunCurrent` / `writeIfProviderThreadOwner`), aplicados ahora a lo que llega del Environment.
- La separación va donde el código ya necesita la máquina. El Hub tiene un **Environment executor** por Environment, con tres partes:
  - **Proveedor remoto:** un `ProviderAdapterV2` registrado por cada par (Environment, provider instance). Reenvía `openSession`, `startTurn`, `interrupt`, `steer`, `respond`, `rollback` y `detach` al Environment, y recibe de vuelta el stream de `ProviderAdapterV2Event`.
  - **Workspace remoto:** checkpoints (capture, restore, diff, push, fetch), preparación de worktrees y setup scripts, operaciones de archivos, búsqueda, exploración del sistema de archivos, terminales y previews.
  - **Recursos del host y capacidades de cada proveedor:** se publican en el saludo y en cada heartbeat.
- El ProviderSessionManager, el ProviderEventIngestor, el RunFinalizationService y el resto de servicios de orquestación siguen en el Hub sin cambios de interfaz. Solo cambia la implementación de adapter y de workspace que reciben.
- El Orchestrator no hace llamadas de red mientras decide. Las capacidades de los providers que hoy lee del adapter salen de una caché por Environment que se rellena con el saludo y los heartbeats.
- El Hub machine es un Environment más. Usa el mismo executor con transporte en proceso, de modo que solo hay un camino de código.
- El routing de los effects atados a un proceso (`PROCESS_BOUND_EFFECT_TYPES`, `checkpoint.capture`, `provider-thread.rollback`, `terminal.cleanup`, `preview.cleanup` y la preparación de launch) va siempre al Active environment del Thread.
  - Si ese Environment está offline, el effect espera, porque el lease no se reclama. No falla ni gasta intentos.
- Los effects puramente de estado (`thread-title.generate`, `delegated-tasks.stop`) se ejecutan en el Hub.
- Un servidor arranca en uno de dos modos:
  - **Hub:** el comportamiento de hoy, más los Environments.
  - **Joined:** agente ejecutor. No sirve clientes, ni sign-in, ni WebSocket de usuario. Solo expone `/health` en loopback y el CLI local.

### Protocolo Hub ↔ Environment

- **Conexión:**
  - El Environment abre un único WebSocket saliente hacia el Hub, en `/api/environment/connect`, autenticado con su Environment credential (un bearer con alcance `environment`).
  - Si la conexión se cae, reconecta con backoff exponencial y jitter.
  - Solo se acepta HTTPS, salvo para localhost, y se respetan `T3CODE_PUBLIC_URL` y `T3CODE_TRUSTED_PROXIES` del spec 1.
- **Saludo:** el Environment envía:
  - la versión del protocolo;
  - el sistema operativo y el hostname;
  - los provider instances disponibles, con versión y capacidades;
  - los recursos del host;
  - las sesiones de proveedor que sigue vivas: id, Thread y último sequence enviado.

  El Hub rechaza con un error claro una versión incompatible, una credencial revocada o una de otro Hub.

- **Peticiones Hub → Environment:** son RPC con `requestId`. Las que vienen de un effect llevan además una clave de idempotencia (`effectId:attempt`). El Environment recuerda las claves ya ejecutadas durante una ventana acotada y responde lo mismo a un reintento.
- **Eventos Environment → Hub:**
  - Llevan `(providerSessionId, seq)` monotónico. El Hub confirma (ack) en lotes y descarta duplicados por `(providerSessionId, seq)`.
  - El Environment guarda en un spool local acotado lo que el Hub aún no ha confirmado y lo reenvía al reconectar.
  - El `command_output.delta`, la salida de terminal y los frames de preview son solo en vivo: no van al spool ni se reenvían.
- **Liveness:** heartbeat cada 10 s. Si no llega ninguno en 30 s, el Environment pasa a offline: se marca `reconnecting` y, al minuto, `offline`. Un evento de un Environment que ya no es el Active environment del Thread, o de una sesión retirada, se rechaza y queda en el log de diagnóstico, nunca en la proyección.
- **Contrato compartido:** el formato del protocolo vive en contracts como un módulo propio y versionado. Lo comparten las dos mitades del server; la idea es que lo use también el ejecutor de Sandbox del spec 3.

### Unir y quitar Environments

- **Alta con `t3 join <url>`.** Reutiliza el patrón PKCE de AppSignIn del spec 1:
  1. El CLI abre un loopback y el navegador en la página «Register this machine» del Hub.
  2. El Owner confirma tras un factor fuerte.
  3. El Hub devuelve un código de un solo uso al loopback.
  4. El CLI lo canjea por la Environment credential.

  La credencial se guarda en el secret store del servidor joined y nunca se muestra. El botón «Use this computer as an Environment» del desktop lanza el mismo flujo.

- **Quién puede registrar en el spec 2:** solo el Owner. Todo Environment registrado es `personal`: solo lo usa su dueño, en cualquiera de sus Spaces.
  - Solo el Owner ve sus Environments personales; nadie más los ve ni los usa.
  - El Hub machine lo pueden usar todos los Members de cualquier Space, como hoy. En el spec 3, el Sandbox de cada Space ocupa su lugar.
  - El permiso `environments.registerOwn` y el modo `dedicated` llegan en el spec 3.
- **Modelo de datos (nueva tabla `environments`):**
  - id, nombre, tipo (`hub` | `external`), modo (`personal`), User dueño;
  - hash de la credencial y huella de su emisión;
  - fecha de alta y last seen;
  - último sistema operativo, hostname, recursos y providers conocidos;
  - estado de revocación.
- **Quitar un Environment:**
  - revoca la credencial y cierra el WebSocket al instante;
  - marca retiradas sus sesiones de proveedor;
  - sus Threads quedan sin Active environment, en estado «needs an environment», y se pueden mover.
- **Auditoría** (allow-list de detalle del spec 1):
  - `environment.register` se conecta ahora;
  - se añaden `environment.remove`, `environment.rename` y `thread.move`.

### Threads, Projects y workspaces

- **Campos nuevos:**
  - En el Thread: `activeEnvironmentId` (nullable solo para «needs an environment») y su estado de move.
  - En el Project: `preferredEnvironmentId`, nullable.
- **Rutas lógicas:** el Hub deja de guardar rutas absolutas como verdad.
  - Workspace de un Project: se identifica por el Project.
  - Cada Environment mantiene su propio mapa Project → checkout local. Por defecto, la ruta es `<workspace root del Environment>/<slug del Project>`. La primera vez se puede elegir un checkout que ya exista en la máquina.
  - El `cwd` de los scopes de checkpoint y el `worktreePath` del Thread se guardan relativos al checkout del Project. Cada Environment los resuelve contra su propia ruta.
- **Elección del Environment:**
  - La hace el Hub al crear el Thread. El orden es: la elección explícita del User, el preferido del Project, el Hub machine.
  - Se valida que el User pueda usar ese Environment, que esté online y que tenga el provider elegido.
  - Se elimina el load balancing del cliente.
- **Clientes:**
  - Conectan solo al Hub.
  - El modelo de una conexión por Environment de client-runtime se queda en una sola conexión, la del Hub.
  - `ScopedThreadRef` deja de llevar el Environment de conexión. El Active environment pasa a ser un campo del Thread que llega por el stream.
- **RPCs de workspace (archivos, búsqueda, terminales, previews, exploración):**
  - El Hub las autoriza con las reglas del spec 1 y las reenvía al Active environment del Thread.
  - Las consultas de diff de checkpoints se resuelven en el Hub, contra su repositorio, y funcionan con el Environment offline.
- **Adjuntos:** se guardan en el Hub. El Environment los pide, por hash, cuando un turno los necesita.

### Repositorio git del Hub y checkpoints

- **Repositorio por Project:**
  - El Hub mantiene un repositorio bare por Project en su state dir.
  - Lo sirve por git smart HTTP en `/api/git/<projectId>`. Las peticiones llevan la Environment credential, inyectada por un credential helper de `t3`.
  - Se autoriza por Project: solo se aceptan Environments que el dueño del Thread puede usar en el Space del Project.
  - Los Threads sin Project tienen un repositorio propio de su scratch workspace.
- **Refs del Hub:**
  - `refs/t3/orchestration-v2/checkpoints/...`: el mismo esquema de hoy;
  - `refs/t3/threads/<threadId>/head`: la rama de trabajo del Thread;
  - `refs/t3/recovered/<threadId>/<timestamp>`: cambios recuperados.

  El remoto propio del usuario no se toca: los checkpoints nunca se empujan a `origin`.

- **Captura y subida:** `checkpoint.capture` captura como hoy (incluye los cambios sin commitear no ignorados) y luego sube los refs del turno al Hub.
  - Si la subida falla, se reintenta por backoff.
  - El turno queda «checkpoint not uploaded yet» hasta que la subida se confirma, y esto se muestra en la UI.
  - La proyección registra hasta qué ordinal está subido cada scope.
- **Restore y rollback:** hacen fetch del ref si falta en local y luego restauran como hoy, en el mismo Environment donde corre la reversión nativa del proveedor.

### Mover un Thread

- **Comando:** `thread.move { threadId, targetEnvironmentId, ifRunning: "wait" | "stop" }`. Por defecto, `wait`.
  - La autorización es la de continuar el Thread (spec 1). Además, el destino tiene que estar online y el User tiene que poder usarlo.
  - Solo puede haber un move a la vez por Thread: un segundo se rechaza con un error claro.
- **Flujo:** es un workflow persistido con estos pasos y con progreso visible en el Thread:
  - `waiting-for-turn`;
  - `final-checkpoint` (solo con el origen online: captura y sube, incluidos los cambios a mano);
  - `fetching` (el destino descarga el checkpoint subido más reciente);
  - `preparing` (recrea la rama o worktree del Thread y ejecuta el setup script);
  - `handoff`;
  - `switched` (cambia `activeEnvironmentId` y retira la sesión de proveedor del origen).
- **Fallos:** si cualquier paso falla antes de `switched`, el Thread sigue en el origen con un mensaje que explica qué paso falló.
- **Origen offline:** se usa el último checkpoint subido y se avisa de cuál es.
- **Cuando vuelve una máquina que estaba offline:**
  - Su ejecutor compara el workspace local de cada Thread que ya no es suyo con lo último que subió.
  - Si hay cambios sin subir, los commitea en `refs/t3/recovered/<threadId>/<timestamp>`, los empuja al Hub y el Hub añade un aviso al Thread con la rama y la máquina.
  - El workspace local se deja tal cual: nunca se borra ni se hace merge.
- **Timeline:** entrada «Moved from A to B», con el actor, el checkpoint del que continúa y el resumen del traspaso.

### Memoria del agente (traspaso)

- **Mismo Environment:** reanudación nativa, como hoy (`nativeThreadRef` / `nativeConversationHeadRef`).
- **Otro Environment:** una sesión nativa nueva en el destino, que recibe un traspaso con tres partes:
  1. **Resumen:** lo escribe el proveedor del Thread en el origen si está online, o en el Hub machine si no. Usa el camino de text generation que ya existe y es una sola llamada al modelo.
  2. **Mensajes recientes:** los últimos, dentro de un presupuesto de tamaño.
  3. **Herramienta MCP `thread_history`:** buscar y leer el historial completo del Thread, con los permisos del User.
- El traspaso se guarda como evento del Thread y se muestra en el timeline.
- Copiar la sesión nativa entre máquinas queda fuera del alcance.

### Identidad del agente remoto

- El agente que corre en un Environment llama al MCP del Hub, en su URL pública, con la credencial por Thread que ya existe. Esa credencial lleva el `ownerUserId`, como hoy.
- El MCP local del Environment no se usa en modo joined.

### Superficies de cliente

- **Web y desktop:**
  - Settings → Environments: lista, estado en vivo, renombrar y quitar, solo el Owner.
  - Página «Register this machine».
  - Active environment en la cabecera del Thread y en el sidebar.
  - Selector de Environment en el composer de un Thread nuevo.
  - Diálogo «Move to another Environment».
  - Entradas de timeline para el move, el traspaso y los cambios recuperados.
  - Estados «paused, environment offline» y «needs an environment».
- **Desktop, además:** el ajuste «Use this computer as an Environment», que arranca un servidor en modo joined como proceso gestionado y lo para al desactivarlo.
- **Móvil:**
  - el Active environment y su estado en las listas y en el Thread;
  - la acción de mover;
  - la lista de Environments solo de lectura para el Owner.
- **Nombres accesibles:** se definen en cada ticket y se entregan al pasar la prueba real.

## Testing Decisions

- **Un test bueno** comprueba lo que ve un User o un Environment a través de las interfaces públicas (RPC del Hub, protocolo del Environment, git smart HTTP, el stream del Thread), no detalles internos. Red-first solo en las reglas de seguridad y en los bugs.
- **Seam principal, uno solo: el testkit «Hub con Environments».**
  - Levanta un Hub real (HTTP real, SQLite en memoria) y uno o dos Environments joined reales, conectados por el protocolo de verdad sobre localhost.
  - Cada Environment usa el adapter Replay o fake del proveedor y repositorios git temporales.
  - Permite apagar, reconectar y cortar la red de un Environment a mitad de un turno.

  Casi todo el spec se prueba aquí:
  - un turno en A se ve en el Hub con A apagado;
  - los diffs se resuelven con A offline;
  - mover de A a B lleva los archivos, la rama y el traspaso;
  - mover con el origen offline usa el último checkpoint;
  - los cambios a mano no subidos acaban en `recovered`;
  - un corte de red no pierde ni duplica eventos;
  - un evento de un Environment antiguo se rechaza;
  - quitar un Environment corta push, fetch y RPC;
  - un Environment no puede leer el repositorio de un Project de otro Space;
  - un Member no ve las máquinas personales del Owner;
  - un Guest no puede mover;
  - el Owner no puede mover el Thread de otro User.

- **Seam secundaria: el flujo de `t3 join`.** Va contra el Hub del testkit, con el navegador sustituido por una petición autenticada del Owner: alta, renombrado, revocación y rechazo de una URL que no es HTTPS.
- **Prior art:**
  - `PeerLinks.testkit.ts`, para servidores conectados en un test;
  - `AuditLog.test.ts` y los tests de spaces, para el HTTP real con SQLite en memoria;
  - los fixtures de Replay (`ClaudeReplayFixtures`), para turnos deterministas;
  - los tests de `GitVcsDriver` con repositorios temporales.
- **Prueba real por ticket de interfaz:** un Hub dev y un segundo servidor joined con otro `--home-dir` en la misma máquina WSL. Playwright conduce el registro, el turno, el apagado del segundo servidor y el move.
- Las comprobaciones se ejecutan en WSL. Antes de integrar se pasa `check:changed`; durante el trabajo, typecheck y los tests del área.

## Out of Scope

- Sandboxes rootless con Podman, Environments dedicados a un Space, instalación por SSH desde el Hub, el Installation permission `environments.registerOwn` en uso, y la imagen y el contenedor de los External environments dedicados: spec 3.
- AI accounts y AI gateway (spec 4) y Vaults (spec 5). En este spec, cada Environment usa las credenciales de proveedor que ya tenga en su máquina, y los secretos de un workspace no viajan con el move.
- Vista de procesos (spec 6).
- Copiar la sesión nativa de Claude o Codex entre máquinas, sincronizar archivos en vivo y hacer un merge automático de los cambios recuperados.
- Rediseñar los Peer Links y la delegación remota. Siguen como están y no sirven para unir Environments. Se decide qué hacer con ellos en el spec 3.
- Migrar datos de un t3code monousuario: se empieza de cero.

## Further Notes

- **Riesgos y mitigaciones:**
  1. **Commits y orden de los eventos a través de la red.** Se mitiga con la ingesta guardada de hoy, `seq` por sesión con ack, el spool y la deduplicación en el Hub.
  2. **Checkpoints atados a rutas locales.** Se mitiga con rutas lógicas relativas al checkout del Project y con el fetch bajo demanda.
  3. **Confianza en los Environments.** Se mitiga porque no hay identidad federada: el Environment no autoriza nada, el Hub autoriza todo y la credencial del Environment solo da acceso al protocolo y a los repositorios permitidos.
- **Orden sugerido para los tickets:**
  1. el protocolo y el executor del Hub machine en proceso, sin cambio visible;
  2. `t3 join` y la vista de Environments;
  3. ejecutar turnos en un External environment;
  4. el repositorio del Hub y la subida de checkpoints;
  5. los clientes con una sola conexión y el Active environment;
  6. el move;
  7. el traspaso;
  8. las desconexiones y los cambios recuperados;
  9. el desktop como Environment;
  10. el móvil.
- El Hub machine pasa por el mismo protocolo que cualquier máquina, en proceso. Si ese camino se rompe, se rompe todo, así que el primer ticket debe dejar la suite actual de orquestación en verde sin cambiar su comportamiento.
