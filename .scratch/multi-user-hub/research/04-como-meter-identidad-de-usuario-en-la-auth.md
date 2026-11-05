# 04 · Cómo meter identidad de usuario en la auth

Hechos sacados del código (upstream a21d788752). Rutas relativas a la raíz del repo. Solo hechos y puntos de extensión, sin modelo de roles.

## 1. Ciclo de vida de una sesión

**Creación.** Siempre se parte de un _grant_ de emparejamiento (`BootstrapGrant`: `method`, `scopes`, `subject`, `label?`, `proofKeyThumbprint?`, `expiresAt`, `apps/server/src/auth/PairingGrantStore.ts:27-34`). Hay tres caminos:

- Cookie de navegador: `createBrowserSession` consume el grant y llama a `sessions.issue` copiando `grant.subject` y `grant.scopes` (`apps/server/src/auth/EnvironmentAuth.ts:881-897`).
- Bearer/DPoP: `exchangeBootstrapCredentialForAccessToken` hace la intersección entre los scopes pedidos y los del grant y emite la sesión (`EnvironmentAuth.ts:956-1016`).
- Emisión directa sin grant (CLI `t3 auth session issue`, MCP OAuth): `issueSession` / `issueMcpClientSession` (`EnvironmentAuth.ts:1085-1112`, `1323-1342`).

**Qué es `subject`.** Es una etiqueta de _cómo_ se emparejó el cliente, no de _quién_ es: `one-time-token`, `cli-issued-session`, `administrative-bootstrap`, `mcp-client`, `cloud-connect`, `reusable-dev-token-child` (`EnvironmentAuth.ts:53-54,77,951,1030,1414`; `apps/server/src/cloud/CloudLink.ts:1583`). Hay lógica de autorización que depende de esos literales:

- Una sesión `mcp-client` se rechaza fuera de `/mcp` (`EnvironmentAuth.ts:612-619`).
- La política gestionada revoca por subject (`EnvironmentAuth.ts:1413-1449`).
- Las peticiones `cloud-connect` se trazan aparte (`apps/server/src/auth/http.ts:255-257`).
- `listPairingLinks` oculta `administrative-bootstrap` (`EnvironmentAuth.ts:1065-1069`).

Por eso **meter un user id dentro de `subject` rompería estas comprobaciones**.

**Almacenamiento.** El token es `base64url(claims).firma`. Lo firma `server-signing-key` (`apps/server/src/auth/SessionStore.ts:427,683,742`). Los claims son `v`, `kind`, `sid`, `sub`, `scopes`, `method`, `jkt?` (huella DPoP), `rtc?` (techo de runtime-mode), `plk?` (peer link), `iat` y `exp` (`SessionStore.ts:431-444`, emisión en `655-667`). Además se guarda una fila en la tabla SQLite `auth_sessions` con `session_id`, `subject`, `scopes`, `method`, metadatos de cliente (label, ip, UA, device, os, browser) y las fechas issued/expires/last_connected/revoked (`apps/server/src/persistence/Migrations/031_AuthAuthorizationScopes.ts:32-48`; `apps/server/src/persistence/AuthSessions.ts:34-44`; registro en `SessionStore.ts:685-700`). La tabla nunca ha tenido usuario. Tuvo una columna `role`, pero se borró y se recreó la tabla al pasar a scopes (`Migrations/020_AuthAccessManagement.ts:27-35`, `031:4-9`).

**Resolución por petición.** `SessionStore.verify` comprueba la firma, el `exp` y que la fila exista y no esté revocada. Los **scopes los lee de la fila de BD, no del claim** (`SessionStore.ts:752-848`, en concreto `843`). `EnvironmentAuth.authenticateToken` lo reduce a `AuthenticatedSession { sessionId, subject, method, scopes, proofKeyThumbprint?, expiresAt? }` (`EnvironmentAuth.ts:88-95,723-749`). La credencial sale de la cookie, de `Authorization: Bearer|DPoP` o de la cookie dev (`EnvironmentAuth.ts:650-676,751-765`).

## 2. Cómo llega la sesión a cada handler

**WebSocket RPC (`/ws`).**

1. En el upgrade, `authenticateWebSocketUpgrade` valida un ticket WS de 5 minutos (claims `sid`, `aud`, `jkt`) o la cookie (`EnvironmentAuth.ts:1244-1296`; `SessionStore.ts:447-455`). La llamada está en `apps/server/src/ws.ts:3446`.
2. Los `session.scopes` de ese momento se pasan una vez a `RpcAuthorization.layer(scopes, onAuthorized)`. Es un middleware `RpcScopeAuthorization` que, antes de cada handler, comprueba el scope de una tabla estática método→scope (`ws.ts:3466`; `apps/server/src/auth/RpcAuthorization.ts:40-212,250-292`).
3. El `AuthenticatedSession` entero se pasa como **argumento de closure** a `layerWsRpc(currentSession, ...)` (`ws.ts:1346-1355,3489-3495`). No existe un servicio Effect tipo "principal actual" para RPC. Los handlers usan `currentSession.scopes` (`ws.ts:1505-1514`) y `currentSessionId` (por ejemplo, el estado de provider auth va indexado por sesión, `ws.ts:2582-2596`).
4. Revocar la sesión cierra el socket (`sessions.awaitInvalidation`, `ws.ts:3531-3545`; `SessionStore.ts:1042-1060`). Los scopes no se recalculan mientras el socket está vivo.

**HTTP API.** El middleware `EnvironmentAuthenticatedAuth` autentica y hace `provideService(EnvironmentAuthenticatedPrincipal, {...session, scopes: Set})` (`apps/server/src/auth/http.ts:228-258`). El shape de ese servicio es `EnvironmentSessionPrincipalShape` (`packages/contracts/src/environmentHttp.ts:376-388`). Los handlers leen el principal con `requireEnvironmentScope` (`http.ts:219-226`).

**MCP.** Tiene su propio contexto por petición, `McpInvocationContext` (`McpInvocationScope` con `client: { sessionId, label, access, linked? }`), y es un `Context.Service` (`apps/server/src/mcp/McpInvocationContext.ts:34-50,125-152`).

**Cliente.** `CLIENT_GUARDED_RPC_SCOPES` solo sirve para que la UI decida qué mostrar; el servidor autoriza siempre por su cuenta (`packages/contracts/src/clientRpcPermissions.ts:16-17`). `AuthClientSession` (la lista de Settings → Sharing & access) expone `subject`, `scopes`, `method` y `client`, pero ningún usuario (`packages/contracts/src/auth.ts:286-298`).

## 3. ¿Comandos y eventos llevan actor?

- **Comandos V2.** Solo `thread.create`, `message.dispatch`, `thread.fork`, `thread.merge_back` y `delegated_task.request` llevan `createdBy: "user"|"agent"|"system"` y `creationSource: "web"|"mobile"|"mcp"|"provider"|"server"` (`packages/contracts/src/orchestrationV2.ts:89-107`). Ese sello lo pone el servidor en `withCreationProvenance` (`apps/server/src/orchestration-v2/ThreadManagementService.ts:72-96`). El handler WS siempre estampa `createdBy: "user"` sin mirar la sesión (`ws.ts:2022-2027`). El resto de comandos solo llevan `commandId` (por ejemplo, `thread.stop`, `orchestrationV2.ts:2895-2905`).
- **Eventos V2.** `OrchestrationV2EventBase` = `id`, `threadId`, `runId?`, `nodeId?`, `driver?`, `providerInstanceId?`, `rawEventId?` y `occurredAt`, sin actor (`orchestrationV2.ts:1853-1862`). Las tablas `orchestration_v2_events` y `orchestration_v2_command_receipts` tampoco tienen columna de actor (`apps/server/src/persistence/Migrations/055_OrchestrationV2.ts:19-50`). Solo se puede llegar al comando que originó un evento por `command_id`.
- **Legado V1.** `orchestration_events.actor_kind` (`client`/`server`/`provider`) se deduce del prefijo de `commandId` (`Migrations/001_OrchestrationEvents.ts:19`; `apps/server/src/persistence/OrchestrationEventStore.ts:135,265-280`). Es un tipo de actor, no una identidad.
- **Precedente de identidad estampada.** `OrchestrationV2LinkOrigin { sessionId, label, access? }`: el servidor lo pone en `thread.create` para el trabajo que lanza un peer link vía MCP, y ningún cliente puede ponerlo por su cuenta (`orchestrationV2.ts:108-128`; `ThreadManagementService.ts:83-86`; `apps/server/src/mcp/toolkits/project/handlers.ts:247`). Después sirve para aislar ("fence") el trabajo por sesión (`apps/server/src/mcp/linkOrigin.ts:12-50`). Es lo más parecido a un "owner" que existe hoy.

## 4. Identidad Clerk en T3 Connect

- **Relay (Cloudflare Worker).** Verifica JWTs de Clerk con `@clerk/backend` `verifyToken` (secret key + audiencia) y también tokens OAuth del CLI (`infra/relay/src/http/Api.ts:1,1664-1700`). El `sub` de Clerk se convierte en `RelayClientPrincipal.userId` (`Api.ts:312-345`), o se intercambia por un token DPoP propio del relay que lleva `userId` (`Api.ts:1054-1081`). En Postgres, enlaces, allocations y dispositivos van por `user_id` (`infra/relay/src/persistence/schema.ts:65-109`).
- **Environment.** Guarda **un único** `CLOUD_LINKED_USER_ID` en su secret store al enlazarse (`CloudLink.ts:785`) y rechaza otra cuenta con `CloudLinkAccountMismatchError` (`CloudLink.ts:543-561`). En el _mint_, verifica la prueba firmada por el relay (`sub` igual al usuario enlazado, `cnf.jkt`, scope `environment:connect`, anti-replay) y crea un pairing link con `subject: "cloud-connect"`, `AuthStandardClientScopes`, TTL de 2 minutos y atado a la clave DPoP del cliente (`CloudLink.ts:1517-1587`).
- **Consecuencia.** El id de Clerk **no se copia a la sesión del environment**. Toda sesión Connect es igual a las demás: tiene todos los scopes estándar y `subject` `cloud-connect`. El modelo es "una cuenta cloud = el dueño de la máquina". Los docs lo dicen así: el relay es un broker de confianza y una relay token nunca es un login de environment (`docs/internals/t3-connect.md:44-65`; `docs/internals/environment-auth.md:3-5`).
- **¿Se puede reutilizar?** El patrón sí: un emisor externo (aquí, el Hub) firma una prueba con `sub`, el environment la verifica con una clave pública instalada (`CLOUD_MINT_PUBLIC_KEY`) y crea un grant one-time atado a DPoP. Eso ya está hecho y probado. Clerk en sí es SaaS, va ligado a la infraestructura de pingdotgg (relay, Cloudflare) y solo admite un usuario por environment. Para un Hub self-hosted habría que sustituir Clerk por el emisor del Hub, no reutilizarlo tal cual.

## 5. Puntos de extensión más limpios para un user id

1. **Grant → sesión.** Añadir un campo `userId` opcional a `BootstrapGrant` (`PairingGrantStore.ts:27-34`) y a la tabla `auth_pairing_links`, y copiarlo en `sessions.issue` en los tres caminos de creación (`EnvironmentAuth.ts:884,971,1085`). El mint de Connect (`CloudLink.ts:1581`) es justo donde un emisor externo ya conoce un `sub`.
2. **Claim y fila.** Un claim nuevo, con el mismo patrón que `rtc`/`plk` (`SessionStore.ts:438-441,662-664`), con `SessionClaims.v` (ya acepta `[1, 2]`) para versionar. Añadir también una columna en `auth_sessions`. Como `verify` ya da prioridad a la fila sobre el claim para los scopes (`SessionStore.ts:843`), leer el usuario desde la fila permitiría reasignarlo o revocarlo sin volver a emitir el token.
3. **Shape del principal.** Añadir el campo a `VerifiedSession` (`SessionStore.ts:51-63`), `AuthenticatedSession` (`EnvironmentAuth.ts:88-95`) y `EnvironmentSessionPrincipalShape` (`environmentHttp.ts:376-383`). HTTP lo recibiría solo por `provideService` (`http.ts:250`).
4. **RPC.** Hoy hay que ir handler a handler por el closure de `layerWsRpc`. Lo más limpio es crear un servicio de contexto "principal actual" para RPC, como `McpInvocationContext`/`EnvironmentAuthenticatedPrincipal`, provisto en `ws.ts:3489`. Para chequeos transversales, el middleware de `RpcAuthorization.layer` ya ve todas las llamadas y el `payload` decodificado (`RpcAuthorization.ts:276-292`). Hoy solo recibe `scopes`; habría que pasarle la sesión.
5. **Actor en comandos y eventos.** Extender `withCreationProvenance` (`ThreadManagementService.ts:77-96`) y el handler `dispatchCommand` (`ws.ts:1999-2029`) para que el servidor estampe la identidad, como ya hace con `linkOrigin`. Para auditoría de _todos_ los comandos, el sitio natural es `orchestration_v2_command_receipts` (una fila por comando, `055:42-50`), no `OrchestrationV2EventBase`. Los eventos llegan al comando por `command_id`.
6. **Dejar `subject` como está.** Sigue siendo el tipo de cliente o canal de emparejamiento, porque hay chequeos de seguridad que dependen de sus literales (sección 1).
