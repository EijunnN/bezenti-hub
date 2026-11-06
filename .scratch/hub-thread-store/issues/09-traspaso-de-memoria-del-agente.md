# 09: Traspaso de memoria del agente

**What to build:** Tras mover un Thread a otra máquina, el agente de destino sabe qué se hizo y qué falta. Recibe tres cosas:

- un resumen, que escribe el agente de origen si está encendido o el Hub si no;
- los mensajes recientes;
- una herramienta para buscar y leer el historial completo.

El User ve en el timeline qué se le contó. Si el Thread se queda en la misma máquina, se usa la reanudación nativa, como hoy. Ver spec, «Memoria del agente».

**Blocked by:** 08.

**Status:** done

- [ ] El paso `handoff` del move genera el resumen con el text generation del proveedor del Thread: en el origen si está online, si no en el Hub machine. Es una sola llamada al modelo.
- [ ] La nueva sesión nativa en el destino arranca con el resumen y los mensajes recientes, dentro de un presupuesto de tamaño.
- [ ] Hay una herramienta MCP `thread_history` para buscar y leer el historial del Thread, con los permisos del User. No da acceso a otros Threads. Test red-first.
- [ ] El traspaso queda como evento del Thread y se ve en el timeline.
- [ ] Si no hay move, o el Thread sigue en la misma máquina, se reanuda de forma nativa sin traspaso.
- [ ] Tests en el testkit, con un proveedor fake que muestra lo que recibió.
