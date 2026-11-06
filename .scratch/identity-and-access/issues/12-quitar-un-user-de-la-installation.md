# 12: Quitar un User de la Installation

**What to build:** El Owner deshabilita o quita a un User. Sus sesiones se cierran, su Personal space queda congelado y pasa al Owner, que decide conservarlo, moverlo o borrarlo. Deshabilitar es reversible; quitar no.

**Blocked by:** 04, 10

**Status:** done

Spec: ../spec.md

- [x] Deshabilitar y rehabilitar un User; quitar un User.
- [x] Ambas acciones cierran sus sesiones al momento.
- [x] El Personal space del User quitado queda congelado y visible solo para el Owner, con acciones de conservar, mover o borrar.

Conservar es no hacer nada; borrar va por el borrado normal de Threads y Projects (la policy deja al Owner borrar en un Personal space congelado sin archivar). Mover queda pendiente: cuando exista el servicio de mover Projects entre Spaces (ticket 11), debe aceptar un Personal space congelado como origen solo para el Owner.
