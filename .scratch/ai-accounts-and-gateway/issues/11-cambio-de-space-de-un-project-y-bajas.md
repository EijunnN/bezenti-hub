# 11: Cambio de Space de un Project y bajas

**What to build:** Mover un Project a otro Space (spec 3, ticket 12) avisa de qué AI accounts pierden sus Threads, revoca sus gateway keys y pasa cada Thread a la cuenta permitida de mayor prioridad del destino (o a «needs an AI account»). Quitar un User revoca sus claves; quitar una allowance corta la siguiente petición. Ver spec, «Cambio de Space de un Project y bajas».

**Blocked by:** 08, 10.

**Status:** done

- [x] `POST /api/projects/move-plan` añade `aiAccountsLost`, con `AllowedAiAccounts` del destino para cada creador de Thread.
- [x] En la misma transacción del move: gateway keys de los Threads revocadas; `aiAccountId` de cada Thread recalculado (o «needs an AI account»).
- [x] Quitar un User (spec 1): revoca todas sus gateway keys. Salir de un Space: revoca sus claves de User atadas a ese Space.
- [x] Red-first: tras mover de Acme a Globex, la key antigua del Thread da 401 y el siguiente turno usa una cuenta de Globex; un User quitado no consume con ninguna de sus claves; una petición en curso cuando se revoca la key termina, y la siguiente se rechaza.
- [x] Puertas: HttpApi `projects.movePlan` y el move (misma regla que hoy); raw routes `/api/ai/*` (revocación efectiva).
- [x] Web: el diálogo «Move to…» lista las AI accounts que se pierden; el Thread en «needs an AI account» ofrece el selector.
- [x] Tests en `HubWithEnvironments.projectMove.test.ts` y en el flujo de quitar un User.
- [x] Prueba real: mover un Project de Acme a Globex con un Thread usando una cuenta solo de Acme; el diálogo lo avisa y el siguiente turno usa la de Globex.

**Hecho** (impl/aig-11): `ai/AiAccountReach.ts` (`projectMoveLoss` → `aiAccountsLost`; `moveThread` revoca las keys del Thread y recalcula `aiAccountId` dentro de la transacción de `thread.space.move`), `ai/AiAccountReachLoss.ts` (quitar un User y borrar una Organization: keys y allowances en su misma transacción, auditadas), `orchestration-v2/AiSessionReach.ts` (cierra, no reinicia, los procesos de provider cuya cuenta ya no alcanza: tras mover, quitar, cambiar allowances o Memberships, y al reconectar una máquina), `AiGatewayKeys.revokeWithin`, migración 118, diálogo «AI accounts it loses». Docs: `docs/internals/ai-gateway.md`, «Moving a Project and removals». Tests: `HubWithEnvironments.projectMove.test.ts` (bloque spec 4 ticket 11), `HubWithEnvironments.aiRemovals.test.ts`, `118_AiAccountReachLoss.test.ts`.
