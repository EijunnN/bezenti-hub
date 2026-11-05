# 09: Gestión de miembros

**What to build:** Un Admin invita como Member o Guest, cambia Roles y expulsa a Members y Guests de su Organization, pero no toca a otros Admins. Solo el Owner nombra y quita Admins. Cualquiera puede salir de una Organization y lo que creó se queda en ella. Quien pasa a Admin debe registrar passkey o TOTP en su siguiente inicio de sesión. El Owner o un Admin generan enlaces de reset de un solo uso para Members y Guests.

**Blocked by:** 06, 08

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Ajustes de Organization: Members, Roles e Invitations, con las reglas de Admin y Owner.
- [ ] Salir y expulsar conservan el contenido en la Organization.
- [ ] Ascender a Admin exige passkey o TOTP en el siguiente inicio de sesión.
- [ ] Enlaces de reset para Members y Guests, de un solo uso y con caducidad.
