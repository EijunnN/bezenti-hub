# 05: Organizations, Personal space y selector de Space

**What to build:** El Owner crea Organizations y cambia de Space con un selector en web. Cada Project y Thread nuevo queda sellado con su `spaceId` y su `ownerUserId`; un Thread sin Project pertenece al Space actual. Nace el módulo puro `AccessPolicy` (`decide(principal, action, resource)`) con su suite de tabla, empezando por las acciones de ver, crear Thread, crear Project y crear Organization.

**Blocked by:** 02

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Tablas de Spaces y Memberships; cada User tiene un Personal space implícito.
- [ ] Solo el Owner crea Organizations (Deny para cualquier otro en `AccessPolicy`).
- [ ] Selector de Space en web; crear Project o Thread lo asigna al Space actual con su autor.
- [ ] Suite de tabla de `AccessPolicy` con las primeras filas; cada regla nueva será una fila.
