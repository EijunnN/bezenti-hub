# 08: Clientes: desktop y móvil

**What to build:** Desktop muestra lo mismo que la web (Settings → Vaults, panel «Secrets», tarjeta de `request_secret`), incluida la descarga de la backup de la clave maestra. Móvil muestra Vaults y nombres, deja al Owner y a los Admins añadir o sustituir un valor, y responde `request_secret` con «Also save to Vault»; nunca revela. Ver spec, «Clientes».

**Blocked by:** 03, 06.

**Status:** done

**Hecho** (impl/vlt-08): estado compartido en `client-runtime/vaults.ts` (acciones por `canEdit`/`canReveal` + grant, `reveal` nunca en móvil, carga de Vaults, líneas del panel Secrets, mensajes de fallo seguros); web lo usa. Desktop es el mismo bundle web (Reveal y backup de la clave maestra con factor fuerte, probados en el pase real con el Hub dev). Móvil: Settings → Vaults (lista, nombres, «Add secret» / «Replace value» solo Owner y Admin con el grant), panel «Secrets» del Thread y «Also save to Vault» en la tarjeta; sin Reveal ni backup (`noReveal.test.ts`, rojo comprobado con una llamada añadida a propósito). Sin migración ni puertas nuevas. Tests: `client-runtime/vaults.test.ts`, `mobile/features/vaults/{noReveal.test.ts,VaultsList.test.tsx}`, `mobile/features/threads/SecretRequestCard.test.tsx`. Docs: docs/internals/secrets.md.

- [x] Lectura de Vaults y nombres efectivos por la fuente compartida de client-runtime, para web, desktop y móvil.
- [x] Desktop: «Reveal» y «Download master key backup» con el factor fuerte (passkey o TOTP) como en web.
- [x] Móvil: Settings → Vaults (lista, nombres, «Replace value» para Owner y Admin), panel «Secrets» del Thread, tarjeta de `request_secret` con «Also save to Vault». Sin «Reveal» ni backup.
- [x] Red-first: el cliente móvil no tiene ninguna llamada a `vaults.reveal`; un Member en móvil no ve los controles de edición y el servidor los rechaza igual si se llaman.
- [x] Puertas: ninguna nueva (usa las de los tickets 02–06).
- [x] Tests de componentes en móvil (no hay Expo web) y tests de client-runtime.
- [x] Prueba real: desktop contra el Hub dev (Owner revela un valor con passkey); móvil en dispositivo si está disponible, si no, tests de componentes y capturas de desktop.
