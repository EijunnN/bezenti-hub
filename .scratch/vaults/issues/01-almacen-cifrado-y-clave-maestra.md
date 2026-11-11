# 01: Almacén cifrado y clave maestra

**What to build:** `ServerSecretStore` (`apps/server/src/auth/ServerSecretStore.ts`) guarda hoy cada secreto en claro en `<stateDir>/secrets/<nombre>.bin`. Pasa a cifrar cada entrada con AES-256-GCM y una clave derivada de una clave maestra que vive en su propio archivo (`<stateDir>/master.key` o `T3CODE_MASTER_KEY_FILE`). La API pública no cambia, así que todo lo que ya la usa (firma de sesiones, perfiles de preview, `settingsSecrets`, `SecretRequests`, `ProviderCredentialStore`, la clave SSH «keep for updates») queda cifrado sin tocarlo. El Owner puede respaldar, importar y rotar la clave. Ver spec, «Almacén cifrado».

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Clave maestra de 32 bytes, creada en el primer arranque con permisos 0600; ruta configurable con `T3CODE_MASTER_KEY_FILE`.
- [ ] Cada entrada: cabecera de versión, nonce aleatorio, AES-256-GCM con subclave HKDF por uso y el nombre del secreto como dato autenticado.
- [ ] Al arrancar, los `.bin` en claro se cifran una vez (atómico, idempotente). Valor de prueba guardado para comprobar la clave.
- [ ] Red-first: con datos cifrados y la clave ausente o equivocada, el Hub no arranca y lo dice; nunca crea una clave nueva encima. Un archivo cifrado renombrado a otro nombre no abre. Tras escribir, ningún archivo de `secrets/` contiene el valor en claro.
- [ ] `t3 secrets key export`, `t3 secrets key import`, `t3 secrets key rotate` (vuelve a cifrar todo; conserva `master.key.previous`).
- [ ] HttpApi `vaults.masterKeyBackup`: solo Owner, con factor fuerte reciente; declarada en `HTTP_ENDPOINT_RULES`. Sin puerta WS ni MCP. Auditoría `secret.master_key.export` y `secret.master_key.rotate` (allow-list de `packages/contracts/src/audit.ts`).
- [ ] Settings muestra «Back up the master key» al Owner hasta la primera backup.
- [ ] Puertas que nombra este ticket: HttpApi (backup), CLI, logs y OTLP (la clave nunca aparece; test de humo que la busca en logs y spans), argumentos de proceso (la clave nunca va en argv).
- [ ] Tests de `ServerSecretStore` con archivos reales; `RetiredSecrets.test.ts` y los tests de quienes usan el almacén siguen pasando.
- [ ] Prueba real: Hub dev en WSL con secretos existentes en claro; tras arrancar, `grep` del valor en `secrets/` no encuentra nada, el Owner sigue con su sesión, la clave exportada e importada en otro `stateDir` abre los mismos secretos y con una clave distinta el Hub se niega a arrancar.
