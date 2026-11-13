# 10: Trabajos en segundo plano al cerrar una terminal

**What to build:** Cuando el Hub cierra una shell por vieja (mover un Project, quitar un User, `terminal.reconcile`, o la admisión que rechaza un snapshot viejo), la máquina termina también lo que arrancó la sesión de esa shell: los trabajos en segundo plano (`npm run dev &`, `sleep 4207 &`) que bash pone cada uno en su grupo de procesos y que el cierre del PTY no alcanza, y que seguían vivos con los secretos del Space anterior. Seguimiento del ticket 07 (riesgo aceptado A2 en `docs/internals/secrets.md`).

**Blocked by:** 07.

**Status:** done

- [x] La sesión se identifica por su id de sesión (SID = pid de la shell, líder de sesión por el PTY), no recorriendo un árbol de padres. Lo que llamó `setsid` o se demonizó (otro SID) queda fuera: riesgo aceptado, documentado.
- [x] Se señalan GRUPOS de procesos de esa sesión (SIGHUP, SIGTERM, SIGKILL con una espera corta), nunca pids sueltos de una foto vieja; justo antes de cada señal se vuelve a leer `/proc` y solo se señala un grupo que sigue en esa sesión.
- [x] Nunca nada fuera de esa sesión, nunca de otro uid, nunca la sesión del propio proceso.
- [x] `/proc/<pid>/stat` se lee tras el ÚLTIMO `)` (el comm puede tener espacios, paréntesis o saltos de línea).
- [x] macOS/Windows: no se distinguen sesiones; se queda el comportamiento de hoy (solo cierra la shell y su PTY), documentado.
- [x] Solo para cierres por vieja; el cierre normal del usuario sigue igual (lo comprobado: hoy manda SIGTERM al pid de la shell; bash sale sin colgar sus trabajos y el cuelgue del PTY solo llega al grupo en primer plano).
- [x] Red-first: un trabajo en segundo plano de una shell cerrada por vieja desaparece; un proceso `setsid` y uno de otra sesión siguen vivos; un comm con `)` y `\n` se lee bien; tras un movimiento en el testkit las shells viejas piden terminar su sesión y la reabierta en Globex no.
- [x] Prueba real (Podman Sandbox): `sleep 4207 &` con ACME_TOKEN desaparece tras mover el Project.

**Hecho** (rama `impl/fu-bg`, sin migración):

- `terminal/SessionProcesses.ts`: `parseProcStat`, `sessionGroups` (grupos con un miembro vivo en la sesión y del mismo uid), `endSessionWith` (HUP → espera → TERM → espera → KILL, releyendo antes de cada señal y parando cuando no queda nada), `endSession` (Linux con `/proc`; en otra plataforma no hace nada; protege la sesión y el grupo del propio proceso).
- `TerminalManager`: opción `endSessionProcesses` (por defecto nada, para PTYs falsos; `make` pasa `SessionProcesses.endSession`); `closeSession(…, endSession)` lo lanza junto a la escalada de la shell. `reconcile` y `close({ endSession: true })` lo usan.
- Contrato: `TerminalCloseInput.endSession` opcional (una máquina anterior lo ignora: sigue el comportamiento de antes). `ThreadWorkspace` lo pone en el cierre de una shell vieja, local o remota.
- Tests: `SessionProcesses.test.ts`, `Manager.endSession.test.ts` (bash y PTY reales), `HubWithEnvironments.projectMove.test.ts` (testkit: `PtySpawn.sessionEnded`).
