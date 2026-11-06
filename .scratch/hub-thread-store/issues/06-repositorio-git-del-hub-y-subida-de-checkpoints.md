# 06: Repositorio git del Hub y subida de checkpoints

**What to build:** El Hub guarda un repositorio git por Project. Al terminar cada turno, el Environment sube el checkpoint, que incluye los cambios sin commitear no ignorados. Los diffs de turno y de Thread se abren aunque la máquina esté apagada. Si la subida falla, el turno muestra «checkpoint not uploaded yet» hasta que se completa. El rollback descarga los refs que le falten. El remoto propio del usuario no se toca. Ver spec, «Repositorio git del Hub y checkpoints».

**Blocked by:** 04.

**Status:** done

- [ ] Un repositorio bare por Project en el state dir del Hub, servido por git smart HTTP con la Environment credential. El credential helper de `t3` la inyecta.
- [ ] Autorización por Project: solo los Environments que el dueño del Thread puede usar en ese Space. Un Environment no puede leer ni escribir el repositorio de un Project de otro Space. Test red-first.
- [ ] `checkpoint.capture` captura y después sube los refs del turno, con reintentos y backoff.
  - [ ] La proyección registra hasta qué ordinal está subido cada scope.
  - [ ] La UI muestra lo que aún no está subido.
- [ ] Las consultas de diff de turno y de Thread se resuelven en el Hub, contra su repositorio, y funcionan con el Environment offline.
- [ ] Restore y rollback hacen fetch del ref que falte y luego restauran en el Active environment.
- [ ] No se empuja nada a `origin` ni a ningún otro remoto del usuario.
- [ ] Quitar un Environment le corta el acceso a push y fetch al instante.
- [ ] Tests en el testkit «Hub con Environments», con repositorios git temporales.
