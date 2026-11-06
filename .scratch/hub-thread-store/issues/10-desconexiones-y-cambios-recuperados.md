# 10: Desconexiones y cambios recuperados

**What to build:** Si la máquina de un Thread se desconecta a mitad de un turno, el Thread se muestra «paused, environment offline» y se reanuda solo cuando la máquina vuelve.

- Si el proceso del agente murió, el turno queda interrumpido y se puede continuar allí o en otra máquina.
- Los mensajes que se envían mientras tanto quedan en cola.

Cuando vuelve una máquina que tenía cambios sin subir de un Thread que ya se movió, esos cambios van a una rama aparte y el Thread recibe un aviso. Si se quita una máquina, sus Threads quedan en «needs an environment» y se pueden mover. Ver spec, «Protocolo», «Mover un Thread» y «Desconexiones».

**Blocked by:** 08.

**Status:** ready-for-agent

- [ ] El Environment guarda en un spool local acotado los eventos que el Hub aún no confirmó y los reenvía al reconectar. No se pierde ni se duplica nada al cortar la red a mitad de un turno.
- [ ] Al reconectar, el saludo lista las sesiones vivas.
  - [ ] Las que sobrevivieron siguen.
  - [ ] Las demás marcan el turno como interrumpido, con la opción de continuar.
- [ ] Hay estados visibles «paused, environment offline» y «needs an environment». Los mensajes enviados a un Thread pausado se encolan.
- [ ] Al volver, el executor compara el workspace local de cada Thread que ya no es suyo con lo que subió.
  - [ ] Si hay diferencias, las commitea en `refs/t3/recovered/<threadId>/<timestamp>`, las empuja al Hub, y el Thread recibe un aviso con la rama y la máquina.
  - [ ] El workspace local no se borra y no se hace merge.
- [ ] Quitar un Environment deja sus Threads en «needs an environment» sin perder su historial.
- [ ] Tests en el testkit: corte de red a mitad de un turno, máquina que vuelve con el proceso vivo y con el proceso muerto, cambios recuperados y Environment quitado. Se entregan los nombres accesibles.
