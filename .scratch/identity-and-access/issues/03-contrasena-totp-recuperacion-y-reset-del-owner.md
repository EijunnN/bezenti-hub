# 03: Contraseña, TOTP, códigos de recuperación y reset del Owner

**What to build:** Un User puede entrar con contraseña (argon2id) y, cuando su cuenta lo exige, con un segundo paso TOTP. El Owner puede entrar con un código de recuperación. Un comando de la CLI ejecutado en la shell del Hub emite un enlace de reset de un solo uso para el Owner.

**Blocked by:** 02

**Status:** done

Spec: ../spec.md

- [x] Inicio de sesión con contraseña en web.
- [x] Alta y verificación de TOTP; el Owner con contraseña debe completar TOTP.
- [x] Un código de recuperación permite entrar una vez y queda consumido. (Hecho en 02; su test sigue en `UserDirectory.test.ts`.)
- [x] El comando de reset del Owner emite un enlace de un solo uso que caduca; probado con `TestClock`.
- [x] Tests en la frontera del servidor para cada camino.

Notas:

- La regla «contraseña solo con TOTP» es `passwordRequiresTotp(user)` en `UserDirectory.ts`; hoy cubre al Owner y la 09 debe extenderla a los Admins.
- Comando: `t3 auth owner-reset [--base-url <url del Hub>] [--json]`; enlace `/reset#token=…`, válido 1 hora.
- Intentos fallidos de contraseña, TOTP y step-up cuentan por cuenta y por IP (en memoria; un reinicio los olvida).
- Cambiar o quitar contraseña/TOTP exige step-up (passkey o contraseña+código) y cierra las demás sesiones; el reset del Owner borra los passkeys antiguos y cierra todas sus sesiones.
