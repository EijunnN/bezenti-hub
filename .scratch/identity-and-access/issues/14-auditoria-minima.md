# 14: Auditoría mínima

**What to build:** El Hub registra quién hizo qué en las acciones sensibles: Invitations (crear, aceptar, revocar), cambios de Role y expulsiones, borrados definitivos, quitar o deshabilitar Users, y los ganchos para revelar o editar secretos y registrar Environments (los usan otros specs). El Owner tiene una vista de la auditoría.

**Blocked by:** 09, 11, 12

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Registro append-only con User, Space, acción, objetivo y hora.
- [ ] Cada acción auditada de este spec genera su entrada (test de frontera).
- [ ] API de auditoría para que otros specs añadan acciones.
- [ ] Vista de auditoría solo para el Owner.
