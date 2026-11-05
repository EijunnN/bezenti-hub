# 08: Reglas de Role al escribir

**What to build:** Las escrituras respetan la tabla de Roles: solo el autor continúa un Thread; el Guest crea Threads pero no Projects; cada uno archiva lo suyo y el Admin también lo ajeno; el Admin para Threads ajenos en curso y borra definitivamente lo archivado; los guest links solo los crea un Admin dentro de una Organization. El servidor sella `actorUserId` en cada comando y en su receipt. La UI oculta lo que el Role no permite.

**Blocked by:** 07

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] `AccessPolicy` cubre todas las filas de la tabla de Roles de «Roles y permisos», guest links incluidos.
- [ ] Cada comando de Project y Thread consulta `AccessPolicy` antes de despachar; test de frontera de un Member que intenta continuar un Thread ajeno.
- [ ] `actorUserId` sellado por el servidor en comandos y receipts; el cliente no puede fijarlo.
- [ ] Los permission atoms del cliente usan el Role del Space actual; se extienden los tests de command permissions.
