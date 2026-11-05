# 04: Toda sesión pertenece a un User

**What to build:** Las sesiones duran 30 días y se renuevan con el uso. Cada User ve en «Tus sesiones» sus dispositivos, navegadores y agentes externos, y revoca los que quiera; el Owner puede revocar las de cualquiera. Revocar cierra el socket al momento. Los códigos de pairing salen del flujo normal: una vez existe un Owner, no se emiten sesiones sin `userId`.

**Blocked by:** 02

**Status:** done

Spec: ../spec.md

- [x] Expiración deslizante de 30 días, probada con `TestClock`.
- [x] «Tus sesiones» en ajustes lista y revoca las sesiones propias; el Owner revoca cualquiera.
- [x] Revocar una sesión cierra sus conexiones abiertas.
- [x] Con un Owner existente, ningún camino emite una sesión sin `userId`; la UI ya no ofrece pairing por código.

Notas de implementación:

- Los enlaces de pairing no desaparecen: llevan el User que los crea y el dispositivo entra como ese User. Lo que sale de la shell del Hub, el enlace de arranque, el desktop y los clientes MCP queda a nombre del Owner (los MCP eligen User en el 13). Un trigger en `auth_sessions` rechaza sesiones sin User cuando ya hay Owner.
- Sin Owner, una visita sin sesión sigue yendo a `/pair`; con Owner va a `/sign-in`. «Tus sesiones» es la sección de Settings → Access que antes se llamaba «Authorized clients».
