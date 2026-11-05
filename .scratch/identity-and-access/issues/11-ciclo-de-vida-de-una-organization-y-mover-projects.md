# 11: Ciclo de vida de una Organization y mover Projects

**What to build:** El Owner archiva una Organization (invisible para sus Members, nada corre), la restaura, y solo la borra definitivamente cuando ya está archivada. Un Project se mueve entre Spaces si quien lo mueve es Admin (o dueño del Personal space) en el origen y Admin en el destino; antes hay que detener sus Threads.

**Blocked by:** 08, 10

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Archivar, restaurar y borrar definitivamente una Organization, con el borrado solo desde archivada.
- [ ] Mover Project con comprobación de origen y destino en `AccessPolicy`.
- [ ] Mover rechaza un Project con Threads en curso y lo indica.
- [ ] Tests de frontera para archivar/restaurar y para mover.
