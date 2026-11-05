# Inicio de sesión en el Hub

Type: grilling
Label: wayfinder:grilling
Status: resolved
Blocked by: 04, 07
Map: ../map.md

## Question

¿Cómo inicia sesión una persona en el Hub (contraseña o passkey local, GitHub OAuth, Clerk, enlace mágico…), cómo se le invita, y cómo se conectan los clientes existentes (web, desktop, móvil) con esa identidad?

## Answer

Resuelto por grilling con el Owner (2026-11-04). ADR: `docs/adr/0003-public-hub-with-local-accounts.md`. Término nuevo en `GLOSSARY.md`: User ("cuenta" queda reservada para cuentas de IA).

1. El Hub se publica en HTTPS con el dominio del Owner, alcanzable desde internet; solo entra quien tiene un User.
2. Cuentas locales del Hub: passkey como método principal, contraseña de respaldo. Sin Clerk, OAuth ni email (OAuth, posible extra futuro).
3. Las Invitations se entregan como enlace copiable; no hay servidor de correo.
4. Primer arranque: la URL de administrative bootstrap (un solo uso) crea la cuenta del Owner y deja de servir.
5. Inicio de sesión único en el Hub: los Environments confían en una prueba firmada por el Hub (patrón mint de T3 Connect) y nunca autentican Users. Protocolo exacto: fog «Protocolo Hub ↔ Environment».
6. Clientes (web, desktop, móvil): URL del Hub + passkey o contraseña. Sin códigos de pairing en el flujo normal; el QR es solo el atajo cross-device del navegador. Toda sesión pertenece a un User.
7. Cada User ve y revoca sus sesiones; el Owner, las de cualquiera. Duran 30 días renovables con el uso. Revocar o quitar al User cierra sus conexiones al momento.
8. Recuperación: Owner o Admin generan un enlace de restablecimiento de un solo uso para Members y Guests; el Owner tiene códigos de recuperación y, en último caso, un comando en la shell del Hub.
9. Owner y Admins: passkey, o contraseña + TOTP. Members y Guests: basta contraseña.
10. Agentes externos por MCP y tokens de la CLI `t3` actúan en nombre de un User, con sus permisos.

La idea de usar el Hub como pasarela de IA para CLIs locales pasó a «Cuentas de IA».
