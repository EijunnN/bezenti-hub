# 04: Un turno corre en tu PC

**What to build:** El Owner crea un Thread, elige su PC (un External environment unido) en el composer, y el turno corre allí:

- el agente, los checkpoints y el workspace están en la PC;
- mensajes, tool calls, aprobaciones y diffs aparecen en vivo en el Hub y en cualquier cliente;
- la cabecera y el sidebar muestran en qué Environment corre.

El Hub elige el Environment, no el cliente. Ver spec, «Arquitectura», «Protocolo» y «Threads, Projects y workspaces».

**Blocked by:** 01, 02, 03.

**Status:** ready-for-agent

- [ ] El Thread tiene `activeEnvironmentId`. Al crearlo, el Hub elige en este orden: la elección del User, el preferido del Project, el Hub machine.
- [ ] El Hub valida que el User pueda usar ese Environment, que esté online y que tenga el provider. Si no, el error dice el motivo.
- [ ] Se elimina el load balancing del cliente.
- [ ] El executor remoto lleva por el WebSocket del ticket 02 las peticiones del proveedor y del workspace del ticket 01.
  - [ ] Las peticiones que vienen de un effect llevan una clave de idempotencia, y un reintento devuelve la misma respuesta.
- [ ] Los eventos del Environment llegan con `(providerSessionId, seq)`.
  - [ ] El Hub los confirma en lotes y descarta duplicados.
  - [ ] La salida de comandos es solo en vivo.
  - [ ] Se rechaza y se registra un evento de un Environment que no es el Active environment o de una sesión retirada.
- [ ] Los effects atados a un proceso esperan, sin gastar intentos, mientras el Active environment está offline.
- [ ] El agente remoto usa el MCP del Hub en su URL pública con la credencial por Thread, con los permisos de su User.
- [ ] Los adjuntos se guardan en el Hub y el Environment los pide por hash.
- [ ] Composer con selector de Environment (los no disponibles muestran el motivo) y Active environment en la cabecera y el sidebar.
- [ ] Se crea el testkit «Hub con Environments»: Hub real y un Environment joined real por localhost, con el adapter Replay y repositorios temporales. Tests en esa seam:
  - [ ] un turno en el Environment se ve en el Hub;
  - [ ] interrupt, steer y aprobaciones funcionan;
  - [ ] los duplicados se descartan;
  - [ ] el evento de un Environment antiguo se rechaza;
  - [ ] las reglas del spec 1 siguen aplicándose.
- [ ] Se entregan los nombres accesibles para la prueba real, con dos servidores en WSL.
