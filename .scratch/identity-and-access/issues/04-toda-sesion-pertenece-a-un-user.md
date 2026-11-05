# 04: Toda sesión pertenece a un User

**What to build:** Las sesiones duran 30 días y se renuevan con el uso. Cada User ve en «Tus sesiones» sus dispositivos, navegadores y agentes externos, y revoca los que quiera; el Owner puede revocar las de cualquiera. Revocar cierra el socket al momento. Los códigos de pairing salen del flujo normal: una vez existe un Owner, no se emiten sesiones sin `userId`.

**Blocked by:** 02

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Expiración deslizante de 30 días, probada con `TestClock`.
- [ ] «Tus sesiones» en ajustes lista y revoca las sesiones propias; el Owner revoca cualquiera.
- [ ] Revocar una sesión cierra sus conexiones abiertas.
- [ ] Con un Owner existente, ningún camino emite una sesión sin `userId`; la UI ya no ofrece pairing por código.
