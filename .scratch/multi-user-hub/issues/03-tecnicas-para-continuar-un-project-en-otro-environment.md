# Técnicas para continuar un Project en otro Environment

Type: research
Label: wayfinder:research
Status: resolved
Blocked by: —
Map: ../map.md

## Question

¿Qué técnicas existen para continuar un Project en otro Environment sin que el agente pierda el hilo? Cubrir: (a) archivos: git (incluido empujar los checkpoints de t3code, que son refs git ocultas), mutagen, rsync, syncthing; (b) historial del Thread: cómo guarda t3code el estado de un Thread (eventos y proyecciones en SQLite, `apps/server/src/orchestration-v2`) y si se puede replicar o transferir a otro servidor. Incluir qué hace hoy t3code al arrastrar un Thread de otro Environment (snapshot de transcript) y los handoffs de contexto (`docs/user/portable-handoffs.md`).

## Answer

- Archivos: git de rama es la única capa compartida hoy. Los checkpoints son commits en `refs/t3/orchestration-v2/checkpoints/...` (incluyen archivos sin seguimiento no ignorados). Se pueden empujar con un refspec explícito o `--mirror`, pero en otro servidor no sirven sin sus filas de proyección.
- Mutagen recomienda excluir `.git`, y con ello los checkpoints. Syncthing resuelve conflictos por archivo (`.sync-conflict-*`) con ~10 s de latencia. rsync sirve para un traspaso en frío.
- Thread: las proyecciones de `statev2.sqlite` son la fuente de verdad. El log de eventos se poda tras ~1 día y no permite reconstruir un Thread. Ids basados en uuid, pero `projectId`, `worktreePath` y `providerInstanceId` son locales. Los adjuntos están en disco.
- Estado del provider: `resumeCursor` apunta a JSONL locales (`~/.claude/projects`, `$CODEX_HOME/sessions`). No hay evidencia de que la reanudación nativa funcione en otra máquina o cuenta.
- Opciones: snapshot + handoff portable (precedente: importador V1→V2), copia completa (filas + cursor + archivos nativos + refs), acceso remoto vía Peer Link, o un store central en el Hub (inferencia, no documentado).
- Hoy: arrastrar un Thread de otro Environment adjunta un `.jsonl` fijo de los turn items visibles (≤50 MiB). Los Peer Links leen y delegan en remoto. Los handoffs son selecciones de texto con presupuesto (16k). No existe RPC para mover Threads.

Detalle y fuentes: [research/03-tecnicas-para-continuar-un-project-en-otro-environment.md](../research/03-tecnicas-para-continuar-un-project-en-otro-environment.md)
