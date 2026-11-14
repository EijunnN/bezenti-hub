# 15: Importar suscripciones de otro CLIProxyAPI

**What to build:** El Owner sustituye un servidor t3code antiguo cuyo CLIProxyAPI propio (8.0.3, sin gestionar) guarda sus sesiones de suscripción (Antigravity, Claude, Codex) como archivos JSON en su `auth-dir`. Quiere pasarlas al Hub sin volver a iniciar sesión. Settings → AI accounts → «Import from CLIProxyAPI» toma esos archivos y crea una AI account de suscripción por archivo, igual que la deja un sign-in (ticket 03). Ver `docs/internals/ai-gateway.md`, «Import from another CLIProxyAPI».

**Blocked by:** 03.

**Status:** done

- [x] Puerta: WS `aiAccounts.importCliproxy` (solo el Owner, `INSTALLATION_RPC_METHODS`, `settings:write`, `DoorRules.AI_ACCOUNT_SIGN_IN_RULES`), contenido Redacted, máx. 50 archivos de 64 KB; selector de archivos en Settings. Sin CLI (decidido con el lead).
- [x] Cada archivo `claude`, `codex` o `antigravity` con email y refresh token: token sellado en `AiAccountTokenStore` (nunca en log, respuesta, auditoría ni base de datos), cuenta «<Proveedor> (<email>)» desactivada con «Signed in as <email>», permitida solo al Personal space del Owner.
- [x] Lista de claves permitidas (las que escriben esos sign-ins); todo lo demás se descarta (`headers`, `prefix`, `disabled`, cualquier variante de base o proxy URL): un archivo importado no decide adónde va una petición ni su token. Una identidad sin id del proveedor coincide con cualquiera del mismo proveedor y email.
- [x] Idempotente: una identidad (proveedor, email, id de cuenta o proyecto) ya presente, firmada, importada o repetida en el mismo envío, se omite con motivo; tipos desconocidos y archivos inválidos también, con motivo, sin sellar nada.
- [x] Auditoría `ai_account.create {provider, type: subscription, via: "import"}`.
- [x] Sin llamada a la gateway: funciona con la gateway parada; el token llega a CLIProxyAPI al activar la cuenta.
- [x] Documentado: un refresh token vive en UN solo proxy; parar el CLIProxyAPI antiguo (o borrar sus copias) al importar. El formulario lo dice.
- [x] Pruebas: `apps/server/src/ai/AiAccounts.cliproxyImport.test.ts` (importa, omite, solo el Owner, turno por la gateway bajo el prefijo con el CLIProxyAPI falso), `DoorRules.test.ts`, `RpcAuthorization.test.ts`. Pase en vivo con el CLIProxyAPI 8.0.67 real y tokens falsos.

**Hecho:** puerta WS + selector en Settings; claves 8.0.3 comprobadas en las etiquetas JSON del binario 8.0.67 fijado. El turno de extremo a extremo con upstream falso se prueba con el CLIProxyAPI falso (con el real, un token OAuth va al host real del proveedor, y una importación no puede cambiarlo).
