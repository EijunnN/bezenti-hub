# Cómo meter identidad de usuario en la auth

Type: research
Label: wayfinder:research
Status: resolved
Blocked by: —
Map: ../map.md

## Question

¿Cómo se podría introducir identidad de usuario en la auth de t3code? Hoy las sesiones solo llevan un `subject` libre y scopes (`apps/server/src/auth/EnvironmentAuth.ts`, `RpcAuthorization.ts`, `packages/contracts/src/auth.ts`). ¿Por dónde fluye la sesión en cada RPC, qué haría falta para asociarla a un usuario, y cómo maneja T3 Connect la identidad Clerk? Solo hechos y puntos de extensión, sin diseñar el modelo de roles.

## Answer

- Una sesión nace de un grant (`subject` + `scopes`). Es un token HMAC con claims `sid`/`sub`/`scopes`/`method`/`jkt`/`rtc`/`plk` más una fila en `auth_sessions`. `verify` lee los scopes de la fila. No hay usuario en ningún sitio.
- `subject` indica el canal de emparejamiento (`mcp-client`, `cloud-connect`, `one-time-token`…), no una persona. Hay chequeos de seguridad que dependen de esos literales, así que el user id tiene que ir en un campo nuevo, no en `subject`.
- WS: la sesión se resuelve una vez en el upgrade. Los scopes van al middleware `RpcScopeAuthorization` y el `AuthenticatedSession` llega a los handlers por el closure de `layerWsRpc`. HTTP usa el servicio `EnvironmentAuthenticatedPrincipal`; MCP usa `McpInvocationContext`.
- Actor: solo los comandos de creación llevan `createdBy` (`user`/`agent`/`system`) y `creationSource`. Los eventos y receipts V2 no llevan actor. `linkOrigin { sessionId }` es el precedente de identidad que estampa el servidor.
- Clerk vive solo en el relay. El environment guarda un único `CLOUD_LINKED_USER_ID` y emite sesiones `cloud-connect` con todos los scopes, sin el id. Lo reutilizable es el patrón (prueba firmada con `sub`, luego grant one-time atado a DPoP), no Clerk.
- Puntos de extensión: `BootstrapGrant` y los tres caminos de `sessions.issue`, un claim más columna nueva, los shapes del principal, un servicio de principal para RPC en `ws.ts`, y `withCreationProvenance` y `command_receipts` para el actor.
- Detalle con path:line: [research/04](../research/04-como-meter-identidad-de-usuario-en-la-auth.md)
