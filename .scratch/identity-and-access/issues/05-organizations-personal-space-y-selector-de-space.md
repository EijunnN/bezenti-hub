# 05: Organizations, Personal space y selector de Space

**What to build:** El Owner crea Organizations y cambia de Space con un selector en web. Cada Project y Thread nuevo queda sellado con su `spaceId` y su `ownerUserId`; un Thread sin Project pertenece al Space actual. Nace el módulo puro `AccessPolicy` (`decide(principal, action, resource)`) con su suite de tabla, empezando por las acciones de ver, crear Thread, crear Project y crear Organization.

**Blocked by:** 02

**Status:** done

Spec: ../spec.md

- [x] Tablas de Spaces y Memberships; cada User tiene un Personal space implícito.
- [x] Solo el Owner crea Organizations (Deny para cualquier otro en `AccessPolicy`).
- [x] Selector de Space en web; crear Project o Thread lo asigna al Space actual con su autor.
- [x] Suite de tabla de `AccessPolicy` con las primeras filas; cada regla nueva será una fila.

Notas de implementación:

- Personal space: se crea perezosamente en el primer uso (`personal:<userId>`), no con el User.
- Filas previas a Spaces: `space_id`/`owner_user_id` quedan `NULL` y cuentan como Personal space del Owner (la migración 084 no puede rellenarlas: el Owner puede no existir aún).
- Crear en un Personal space exige `personalSpace.create`; hasta el ticket 10 solo el Owner puede.
- Selector de Space en móvil: ticket 16.
