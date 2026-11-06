# 10: Installation permissions y Personal spaces

**What to build:** El Owner concede o retira a cada User los Installation permissions `personalSpace.create` y `environments.registerOwn` (este último solo se guarda; lo consume el spec de Sandboxes). Sin `personalSpace.create`, el Personal space queda vacío y oculto. El Owner ve todos los Personal spaces. Desde un Personal space no se comparte nada.

**Blocked by:** 08

**Status:** done

Spec: ../spec.md

- [x] Vista de Owner para conceder y retirar Installation permissions.
- [x] Personal space oculto y sin creación para quien no tiene el permiso.
- [x] El Owner ve los Personal spaces de todos; nadie más ve uno ajeno.
- [x] Filas nuevas en la suite de `AccessPolicy` para estas reglas.
