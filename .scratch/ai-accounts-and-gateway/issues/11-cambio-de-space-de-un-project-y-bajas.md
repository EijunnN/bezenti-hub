# 11: Cambio de Space de un Project y bajas

**What to build:** Mover un Project a otro Space (spec 3, ticket 12) avisa de qué AI accounts pierden sus Threads, revoca sus gateway keys y pasa cada Thread a la cuenta permitida de mayor prioridad del destino (o a «needs an AI account»). Quitar un User revoca sus claves; quitar una allowance corta la siguiente petición. Ver spec, «Cambio de Space de un Project y bajas».

**Blocked by:** 08, 10.

**Status:** ready-for-agent

- [ ] `POST /api/projects/move-plan` añade `aiAccountsLost`, con `AllowedAiAccounts` del destino para cada creador de Thread.
- [ ] En la misma transacción del move: gateway keys de los Threads revocadas; `aiAccountId` de cada Thread recalculado (o «needs an AI account»).
- [ ] Quitar un User (spec 1): revoca todas sus gateway keys. Salir de un Space: revoca sus claves de User atadas a ese Space.
- [ ] Red-first: tras mover de Acme a Globex, la key antigua del Thread da 401 y el siguiente turno usa una cuenta de Globex; un User quitado no consume con ninguna de sus claves; una petición en curso cuando se revoca la key termina, y la siguiente se rechaza.
- [ ] Puertas: HttpApi `projects.movePlan` y el move (misma regla que hoy); raw routes `/api/ai/*` (revocación efectiva).
- [ ] Web: el diálogo «Move to…» lista las AI accounts que se pierden; el Thread en «needs an AI account» ofrece el selector.
- [ ] Tests en `HubWithEnvironments.projectMove.test.ts` y en el flujo de quitar un User.
- [ ] Prueba real: mover un Project de Acme a Globex con un Thread usando una cuenta solo de Acme; el diálogo lo avisa y el siguiente turno usa la de Globex.
