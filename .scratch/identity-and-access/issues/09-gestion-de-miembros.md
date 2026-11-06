# 09: Gestión de miembros

**What to build:** Un Admin invita como Member o Guest, cambia Roles y expulsa a Members y Guests de su Organization, pero no toca a otros Admins. Solo el Owner nombra y quita Admins. Cualquiera puede salir de una Organization y lo que creó se queda en ella. Quien pasa a Admin debe registrar passkey o TOTP en su siguiente inicio de sesión. El Owner o un Admin generan enlaces de reset de un solo uso para Members y Guests.

**Blocked by:** 06, 08

**Status:** done

Spec: ../spec.md

- [x] Ajustes de Organization: Members, Roles e Invitations, con las reglas de Admin y Owner.
- [x] Salir y expulsar conservan el contenido en la Organization.
- [x] Ascender a Admin exige passkey o TOTP en el siguiente inicio de sesión.
- [x] Enlaces de reset para Members y Guests, de un solo uso y con caducidad.
- [x] Un Member o Guest recién invitado no ve el asistente de bienvenida del Owner («Connect your computers», «Add a computer»): su primera pantalla es su Organization. (Visto en la prueba real del ticket 07.)
