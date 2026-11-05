# 03: Contraseña, TOTP, códigos de recuperación y reset del Owner

**What to build:** Un User puede entrar con contraseña (argon2id) y, cuando su cuenta lo exige, con un segundo paso TOTP. El Owner puede entrar con un código de recuperación. Un comando de la CLI ejecutado en la shell del Hub emite un enlace de reset de un solo uso para el Owner.

**Blocked by:** 02

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Inicio de sesión con contraseña en web.
- [ ] Alta y verificación de TOTP; el Owner con contraseña debe completar TOTP.
- [ ] Un código de recuperación permite entrar una vez y queda consumido.
- [ ] El comando de reset del Owner emite un enlace de un solo uso que caduca; probado con `TestClock`.
- [ ] Tests en la frontera del servidor para cada camino.
