# 10: Installation permissions y Personal spaces

**What to build:** El Owner concede o retira a cada User los Installation permissions `personalSpace.create` y `environments.registerOwn` (este último solo se guarda; lo consume el spec de Sandboxes). Sin `personalSpace.create`, el Personal space queda vacío y oculto. El Owner ve todos los Personal spaces. Desde un Personal space no se comparte nada.

**Blocked by:** 08

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Vista de Owner para conceder y retirar Installation permissions.
- [ ] Personal space oculto y sin creación para quien no tiene el permiso.
- [ ] El Owner ve los Personal spaces de todos; nadie más ve uno ajeno.
- [ ] Filas nuevas en la suite de `AccessPolicy` para estas reglas.
