# 09: Inventario de puertas y pase completo

**What to build:** Una revisión de inventario, como la del ticket 17 del spec 3, de todas las puertas por las que se puede llegar a un valor o a un nombre de secreto: WS, HttpApi, raw routes, MCP, executor wire, rutas de invitado, logs, spans OTLP, argumentos de proceso, archivos del Hub y backups. Cierra los huecos que encuentre, con la misma regla en cada puerta. Ver spec, «Puertas».

**Blocked by:** 01–08.

**Status:** done

- [x] `DoorRules.ts` y `RPC_SPACE_ACCESS` declaran todas las puertas de Vaults; el test de inventario falla si una nueva no declara su regla.
- [x] Ninguna puerta, salvo `vaults.reveal` y la backup de la clave, devuelve un valor. Test que llama a cada RPC, endpoint y herramienta con un Vault lleno y busca el valor en la respuesta.
- [x] Test de humo de fugas: el valor no aparece en logs, spans, `/proc/*/cmdline` del Hub ni de la máquina joined, ni en ningún archivo del Hub fuera del almacén cifrado, después de un turno, una terminal, un script, un traspaso y un `request_secret`.
- [x] Rutas de invitado y vistas de Thread de solo lectura muestran el historial enmascarado.
- [x] Red-first para cada hueco encontrado, con Owner, Admin, Member y Guest de dos Organizations.
- [x] Prueba real completa en WSL con Podman: el recorrido de la prueba real del spec, más mover el Project y rotar un valor del Main vault con un link activo.

**Hecho (2026-11-13):** el inventario ya estaba casi completo (DoorRules, RPC_SPACE_ACCESS, MaskedPaths); no apareció ningún hueco que arreglar. Se añade: en `DoorRules.test.ts`, quién lee un valor (revelar, entregar, enmascarar; también la credencial directa de una AI account, spec 4 ticket 07) y quién toca las tablas de Vaults; el barrido `vaults/VaultDoors.test.ts` (Owner, Admin, Member y Guest de Acme y Globex llaman cada puerta de Vaults, lecturas y escrituras: ningún valor ni nombre ajeno; una puerta nueva de Vaults o secretos sin llamada falla); la vista de invitado enmascarada; el humo de fugas (archivos del Hub con su almacén, filas, archivos de las máquinas, `/proc/*/cmdline`) tras turno, terminal, traspaso y `request_secret`; la guarda de `forCopy` por scope; Git (hook real) y change requests (servicio real) bajo los wrappers. El índice de la migración 116 se midió (≈2,5 µs por escritura de 2,6 KB) y se queda: una columna generada VIRTUAL cuesta lo mismo. Logs y spans de procesos reales: el pase real (log y trace del Hub, almacén, homes de Sandbox, argumentos en host y contenedores). Fuera del humo: el script de setup en la Hub machine (entorno de spawn, `terminal/Manager.test.ts`).
