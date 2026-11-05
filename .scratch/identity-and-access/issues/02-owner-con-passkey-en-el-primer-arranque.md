# 02: Owner con passkey en el primer arranque

**What to build:** En una Installation nueva, la URL de administrative bootstrap abre la pantalla «crear la cuenta del Owner»: nombre, passkey y códigos de recuperación. Al terminar, la URL deja de servir. El Owner puede cerrar sesión y volver a entrar con su passkey desde otro navegador. Nacen las tablas de Users y credenciales, y las sesiones llevan `userId` (columna en la fila y claim nuevo; `subject` no cambia).

**Blocked by:** 01

**Status:** done

Spec: ../spec.md

- [x] Con Installation nueva, la URL de bootstrap crea exactamente un Owner y después responde que ya no es válida.
- [x] El Owner registra una passkey y recibe códigos de recuperación (guardados con hash, de un solo uso).
- [x] Página de inicio de sesión web con passkey (WebAuthn); test en la frontera del servidor con un autenticador de prueba.
- [x] La sesión emitida lleva `userId`, leído de la fila al verificar.
- [x] Migraciones nuevas desde la 080, registradas y cubiertas por los tests de migraciones.

Notas: el inicio de sesión con código de recuperación también quedó hecho aquí (el test lo pedía); el ticket 03 solo debe añadir contraseña, TOTP y reset. Con un Owner existente, el enlace de bootstrap ya no crea cuentas y la web manda a `/sign-in`, pero el intercambio de token (`/oauth/token`, móvil/CLI) sigue emparejando sin `userId` hasta el ticket 04.
