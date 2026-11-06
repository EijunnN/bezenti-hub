# 05: Archivos, terminales y previews remotos

**What to build:** En un Thread que corre en otra máquina, las herramientas del cliente actúan sobre esa máquina: leer, escribir y buscar archivos, explorar el sistema de archivos, abrir terminales con entrada y salida en vivo, y abrir previews. Si la máquina está apagada, el cliente muestra «environment offline» en lugar de fallar sin decir nada. Ver spec, «Threads, Projects y workspaces».

**Blocked by:** 04.

**Status:** done

- [ ] Las RPC de archivos, búsqueda, exploración, terminal y preview se autorizan en el Hub con las reglas del spec 1 y se reenvían al Active environment del Thread.
- [ ] La entrada y salida de las terminales y los frames de preview van en vivo por el protocolo, sin spool.
- [ ] Con el Environment offline, cada superficie muestra «environment offline» y las escrituras no se encolan.
- [ ] Un User sin permiso no puede usar el reenvío para llegar a otra máquina ni a otro Project. Test red-first.
- [ ] Tests en el testkit «Hub con Environments». Se entregan los nombres accesibles.
