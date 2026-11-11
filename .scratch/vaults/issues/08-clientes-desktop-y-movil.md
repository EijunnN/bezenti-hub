# 08: Clientes: desktop y móvil

**What to build:** Desktop muestra lo mismo que la web (Settings → Vaults, panel «Secrets», tarjeta de `request_secret`), incluida la descarga de la backup de la clave maestra. Móvil muestra Vaults y nombres, deja al Owner y a los Admins añadir o sustituir un valor, y responde `request_secret` con «Also save to Vault»; nunca revela. Ver spec, «Clientes».

**Blocked by:** 03, 06.

**Status:** ready-for-agent

- [ ] Lectura de Vaults y nombres efectivos por la fuente compartida de client-runtime, para web, desktop y móvil.
- [ ] Desktop: «Reveal» y «Download master key backup» con el factor fuerte (passkey o TOTP) como en web.
- [ ] Móvil: Settings → Vaults (lista, nombres, «Replace value» para Owner y Admin), panel «Secrets» del Thread, tarjeta de `request_secret` con «Also save to Vault». Sin «Reveal» ni backup.
- [ ] Red-first: el cliente móvil no tiene ninguna llamada a `vaults.reveal`; un Member en móvil no ve los controles de edición y el servidor los rechaza igual si se llaman.
- [ ] Puertas: ninguna nueva (usa las de los tickets 02–06).
- [ ] Tests de componentes en móvil (no hay Expo web) y tests de client-runtime.
- [ ] Prueba real: desktop contra el Hub dev (Owner revela un valor con passkey); móvil en dispositivo si está disponible, si no, tests de componentes y capturas de desktop.
