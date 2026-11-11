# 09: Inventario de puertas y pase completo

**What to build:** Una revisión de inventario, como la del ticket 17 del spec 3, de todas las puertas por las que se puede llegar a un valor o a un nombre de secreto: WS, HttpApi, raw routes, MCP, executor wire, rutas de invitado, logs, spans OTLP, argumentos de proceso, archivos del Hub y backups. Cierra los huecos que encuentre, con la misma regla en cada puerta. Ver spec, «Puertas».

**Blocked by:** 01–08.

**Status:** ready-for-agent

- [ ] `DoorRules.ts` y `RPC_SPACE_ACCESS` declaran todas las puertas de Vaults; el test de inventario falla si una nueva no declara su regla.
- [ ] Ninguna puerta, salvo `vaults.reveal` y la backup de la clave, devuelve un valor. Test que llama a cada RPC, endpoint y herramienta con un Vault lleno y busca el valor en la respuesta.
- [ ] Test de humo de fugas: el valor no aparece en logs, spans, `/proc/*/cmdline` del Hub ni de la máquina joined, ni en ningún archivo del Hub fuera del almacén cifrado, después de un turno, una terminal, un script, un traspaso y un `request_secret`.
- [ ] Rutas de invitado y vistas de Thread de solo lectura muestran el historial enmascarado.
- [ ] Red-first para cada hueco encontrado, con Owner, Admin, Member y Guest de dos Organizations.
- [ ] Prueba real completa en WSL con Podman: el recorrido de la prueba real del spec, más mover el Project y rotar un valor del Main vault con un link activo.
