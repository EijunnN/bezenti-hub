# 02: Owner con passkey en el primer arranque

**What to build:** En una Installation nueva, la URL de administrative bootstrap abre la pantalla «crear la cuenta del Owner»: nombre, passkey y códigos de recuperación. Al terminar, la URL deja de servir. El Owner puede cerrar sesión y volver a entrar con su passkey desde otro navegador. Nacen las tablas de Users y credenciales, y las sesiones llevan `userId` (columna en la fila y claim nuevo; `subject` no cambia).

**Blocked by:** 01

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Con Installation nueva, la URL de bootstrap crea exactamente un Owner y después responde que ya no es válida.
- [ ] El Owner registra una passkey y recibe códigos de recuperación (guardados con hash, de un solo uso).
- [ ] Página de inicio de sesión web con passkey (WebAuthn); test en la frontera del servidor con un autenticador de prueba.
- [ ] La sesión emitida lleva `userId`, leído de la fila al verificar.
- [ ] Migraciones nuevas desde la 080, registradas y cubiertas por los tests de migraciones.
