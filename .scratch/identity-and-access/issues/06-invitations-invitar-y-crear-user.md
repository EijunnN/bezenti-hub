# 06: Invitations: invitar y crear User

**What to build:** El Owner crea una Invitation a una Organization con su Role y copia el enlace. La persona lo abre, ve el aviso de que el Owner puede ver su Personal space, crea su User (passkey o contraseña) y entra como Member de esa Organization. Si ya tenía User, la Organization se añade al suyo. Las Invitations caducan a los 7 días, son de un solo uso y se pueden revocar antes de aceptarse.

**Blocked by:** 03, 05

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Crear, listar y revocar Invitations (Owner).
- [ ] Página de aceptación con el aviso de visibilidad del Personal space.
- [ ] Aceptar crea el User o enlaza uno existente; un User puede estar en varias Organizations.
- [ ] Caducidad, uso único y revocación probados en la frontera del servidor con `TestClock`.
