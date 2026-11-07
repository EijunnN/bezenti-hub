# 08: Los Users unen sus propias máquinas

**What to build:** El Installation permission `environments.registerOwn` del spec 1 pasa a tener efecto: un User con él aprueba con factor fuerte el alta de su propia máquina en modo personal; sin él, la aprobación se rechaza diciendo que lo necesita. Cada User ve y quita sus máquinas personales en Settings. Ver spec, «External environments».

**Blocked by:** None (can start immediately).

**Status:** done

- [x] La página «Register this machine» acepta al User con `registerOwn` (y al Owner); mensaje claro sin el permiso. Red-first.
- [x] La máquina queda personal de ese User: solo él la usa, en cualquiera de sus Spaces.
- [x] Settings → Environments muestra a cada User sus máquinas personales, con renombrar y quitar; el Owner ve todas.
- [x] Revocar `registerOwn` no quita las máquinas ya unidas (documentado); quitar al User sí (spec 2).
- [x] Auditoría `environment.register` con el User aprobador.
- [x] Tests en el testkit; prueba real con un Member.
