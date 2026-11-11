# 03: AI accounts de suscripción

**What to build:** El Owner añade suscripciones (Claude, Codex/ChatGPT, Antigravity, Kimi, xAI, Devin, Meta) iniciando sesión desde Settings por la Management API de CLIProxyAPI, y cuentas de servicio de Vertex por importación. Como el Hub vive en un VPS, el diálogo pide pegar la URL a la que llega el navegador tras el login. Los tokens que CLIProxyAPI refresca vuelven cifrados al almacén. Cada cuenta muestra su estado y sus cuotas. Ver spec, «AI accounts» e «Inicio de sesión de suscripciones».

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] `aiAccounts.login.start` (URL de autorización del proveedor vía Management API) y `aiAccounts.login.complete` (URL pegada, entregada a CLIProxyAPI). Solo Owner. El estado del login caduca a los 10 minutos.
- [ ] Al completar: el token se lee de CLIProxyAPI, se guarda cifrado y se le asigna `prefix: acct-<id>`. Al arrancar el Hub, los tokens se escriben desde el almacén al `auth-dir` en memoria; los refrescos se recogen y se vuelven a cifrar.
- [ ] Importación de cuenta de servicio de Vertex (JSON), cifrada.
- [ ] Estado por cuenta (working, needs sign-in again, quota exhausted, error) y ventanas de cuota con el lector existente `usage/cliproxyApi.ts` apuntado a la gateway gestionada.
- [ ] Aviso de ToS (ADR 0005) en todas las suscripciones y, en Antigravity, la nota de ofuscación de CLIProxyAPI (endurecida en v8.0.65).
- [ ] Red-first: `login.complete` con un estado de otro login o caducado se rechaza; un no-Owner no puede iniciar ni completar; tras reiniciar el Hub sin tmpfs persistido, la cuenta sigue funcionando desde el almacén; ningún token queda en claro en disco persistente (salvo el aviso sin tmpfs).
- [ ] Puertas: WS `aiAccounts.login.start`, `aiAccounts.login.complete` en `RPC_SPACE_ACCESS` (Installation, solo Owner). Sin raw route de callback en el Hub (se pega la URL). Tokens fuera de logs, spans y argv.
- [ ] Auditoría `ai_account.login`.
- [ ] Web/desktop: «Add subscription» con proveedor, «Open sign-in», «Paste the address you landed on», «Sign in again».
- [ ] Tests con el CLIProxyAPI falso (Management API de login, refresco, cuotas).
- [ ] Prueba real: si hay una suscripción de prueba disponible, el Owner añade Codex desde un navegador que no es el del VPS; si no, el flujo completo contra el CLIProxyAPI falso y capturas.
