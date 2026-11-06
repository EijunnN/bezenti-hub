# 08: Mover un Thread

**What to build:** Desde el menú de un Thread que puede continuar, un User elige «Move to another Environment» y una máquina de destino.

- Si hay un turno en marcha, se le pregunta si esperar (por defecto) o parar.
- Si la máquina de origen está encendida, sube un checkpoint final con los cambios hechos a mano.
- La máquina de destino descarga el último checkpoint, recrea la rama o el worktree y ejecuta el setup script. El Thread sigue allí.

El progreso se ve en el Thread, y el timeline muestra «Moved from A to B». Si el origen está apagado, se usa el último checkpoint subido. Si algo falla, el Thread se queda en el origen. Ver spec, «Mover un Thread».

**Blocked by:** 06, 07.

**Status:** done

- [ ] Comando `thread.move { threadId, targetEnvironmentId, ifRunning }`.
  - [ ] Autorización: la de continuar el Thread, más destino online y que el User pueda usarlo.
  - [ ] Un Guest no ve la acción, y el Owner no puede mover el Thread de otro User. Tests red-first.
- [ ] Workflow persistido: `waiting-for-turn` → `final-checkpoint` → `fetching` → `preparing` → `switched`, con progreso visible.
  - [ ] Hay un hueco preparado para el `handoff`, que se rellena en el ticket 09.
  - [ ] Si falla antes de `switched`, el Thread queda en el origen con el paso que falló.
- [ ] Solo un move a la vez por Thread. Un segundo se rechaza con un error claro.
- [ ] Con el origen offline se usa el último checkpoint subido y se dice cuál es.
- [ ] Al hacer `switched` se retira la sesión de proveedor del origen, y sus eventos posteriores se rechazan.
- [ ] Entrada en el timeline con el actor, el origen, el destino y el checkpoint. Se audita `thread.move`.
- [ ] Diálogo en web y desktop: Environments con su estado, explicación de lo que va a pasar, opción esperar o parar, progreso y error.
- [ ] Tests en el testkit con dos Environments: archivos y rama llegan al destino; con el origen offline; un fallo deja el Thread en el origen; moves concurrentes. Se entregan los nombres accesibles.
