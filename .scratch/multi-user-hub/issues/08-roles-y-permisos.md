# Roles y permisos

Type: grilling
Label: wayfinder:grilling
Status: resolved
Blocked by: 07
Map: ../map.md

## Question

¿Qué roles existen (Owner, admin, miembro, invitado…) y qué puede hacer cada uno sobre Organizaciones, Projects y Threads, sobre todo con lo de otros (ver, continuar, borrar)? ¿Los permisos se dan por rol, por recurso o ambos?

## Answer

Resuelto por grilling con el Owner (2026-11-04). Términos en `GLOSSARY.md`: Role, Installation permission.

1. Dos niveles: un Role fijo por Organization (Admin, Member, Guest; uno por persona y Organization; sin roles a medida ni permisos por recurso) e Installation permissions sueltos que el Owner da a cada usuario (p. ej. crear en su Personal space).
2. Un agente actúa con los permisos de quien lanzó el turno, nunca con más. Lo que haga desde la shell lo cubre «Aislamiento entre Organizaciones».
3. Matriz dentro de una Organization:

| Acción                                   | Admin | Member |    Guest     |
| ---------------------------------------- | :---: | :----: | :----------: |
| Ver todos los Projects y Threads         |  sí   |   sí   |      sí      |
| Crear Threads y continuar los suyos      |  sí   |   sí   |      sí      |
| Continuar Threads de otros               |  no   |   no   |      no      |
| Crear Projects                           |  sí   |   sí   |      no      |
| Archivar lo suyo                         |  sí   |   sí   | solo Threads |
| Archivar lo de otros                     |  sí   |   no   |      no      |
| Parar un Thread ajeno en curso           |  sí   |   no   |      no      |
| Borrar definitivamente lo archivado      |  sí   |   no   |      no      |
| Invitar como Member o Guest              |  sí   |   no   |      no      |
| Cambiar Role o expulsar (salvo a Admins) |  sí   |   no   |      no      |

4. Nadie continúa un Thread ajeno, ni un Admin: se abre un Thread nuevo en el mismo Project.
5. Solo el Owner nombra Admins; un Admin no puede tocar a otro Admin.
6. Mover un Project entre Spaces exige ser Admin (o dueño del Personal space) en el origen y Admin en el destino; el Owner siempre puede.
7. Guest links solo en Organizations y solo los crean Admins; nunca desde un Personal space.
8. El Owner ve los Personal spaces de todos, y se dice explícitamente a los usuarios (Invitation e interfaz).

El uso de vaults, cuentas de IA y Environments por Role se decide en sus tickets.
