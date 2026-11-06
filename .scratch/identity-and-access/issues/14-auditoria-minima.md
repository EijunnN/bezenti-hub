# 14: Auditoría mínima

**What to build:** El Hub registra quién hizo qué en las acciones sensibles: Invitations (crear, aceptar, revocar), cambios de Role y expulsiones, borrados definitivos, quitar o deshabilitar Users, y los ganchos para revelar o editar secretos y registrar Environments (los usan otros specs). El Owner tiene una vista de la auditoría.

**Blocked by:** 09, 11, 12

**Status:** done

Spec: ../spec.md

- [x] Registro append-only con User, Space, acción, objetivo y hora.
- [x] Cada acción auditada de este spec genera su entrada (test de frontera).
- [x] API de auditoría para que otros specs añadan acciones.
- [x] Vista de auditoría solo para el Owner.

Retención: se guarda todo, sin poda. Las acciones `secret.reveal`, `secret.edit` y `environment.register` existen en `AuditAction` y se registran con `AuditLog.record` desde los specs 3 y 5.
