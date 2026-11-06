# 11: Ciclo de vida de una Organization y mover Projects

**What to build:** El Owner archiva una Organization (invisible para sus Members, nada corre), la restaura, y solo la borra definitivamente cuando ya está archivada. Un Project se mueve entre Spaces si quien lo mueve es Admin (o dueño del Personal space) en el origen y Admin en el destino; antes hay que detener sus Threads.

**Blocked by:** 08, 10

**Status:** done

Spec: ../spec.md

- [x] Archivar, restaurar y borrar definitivamente una Organization, con el borrado solo desde archivada.
- [x] Mover Project con comprobación de origen y destino en `AccessPolicy`.
- [x] Mover rechaza un Project con Threads en curso y lo indica.
- [x] Tests de frontera para archivar/restaurar y para mover.
