# Mover un Project entre Environments

Type: grilling
Label: wayfinder:grilling
Status: resolved
Blocked by: 03, 13
Map: ../map.md

## Question

Cuando un Project se continúa en otro Environment, ¿qué viaja (archivos, historial de Threads, checkpoints), cuándo se sincroniza, qué pasa si dos Environments trabajan a la vez en el mismo Project y cómo se resuelven los conflictos?

## Answer

Resuelto por grilling con el Owner (2026-11-04). ADR: `docs/adr/0006-hub-stores-threads-environments-execute.md`. Término nuevo en `GLOSSARY.md`: Active environment.

1. Un Thread está activo en un único Environment a la vez (su Active environment); moverlo cambia ese Environment. Un Project puede tener varios Threads en varios Environments, cada uno en su rama o worktree, unidos después con merge back.
2. El historial de los Threads vive en el Hub; los Environments solo ejecutan y transmiten eventos, mensajes y checkpoints. El equipo ve los Threads aunque su máquina esté apagada.
3. Los archivos viajan por un repositorio git del Hub por Project: tras cada turno se sube el checkpoint (incluye cambios sin commitear no ignorados); quien toma el relevo descarga el último. Lo ignorado se regenera; los secretos vienen de los Vaults; el remoto propio (GitHub) sigue aparte.
4. Memoria del agente: en el mismo Environment, reanudación nativa; en otro, traspaso reforzado = resumen redactado por el agente de origen (o por el Hub si el origen está apagado) + selección de mensajes recientes + herramienta para consultar el historial completo. Una llamada extra al modelo por cambio.
5. Mover a mitad de un turno: se pregunta si esperar o parar; por defecto, esperar.
6. Cambios a mano no subidos: si el origen está encendido, checkpoint final al salir; si estaba apagado y al volver tiene cambios no subidos, van a una rama aparte y se avisa. Nunca se pisan ni se mezclan en silencio.
7. Los Threads sin Project también se pueden mover con el mismo mecanismo.

Futuro: copiar la sesión nativa de Claude/Codex entre máquinas (posible prototype).
