# 10: Instalación por SSH

**What to build:** El Owner añade una máquina dedicada dando al Hub host, puerto, usuario y clave SSH. El Hub comprueba el sistema y Podman (lo instala si hay sudo sin contraseña), instala la versión de T3 del Hub, registra la máquina con una concesión de un solo uso y arranca su servicio, mostrando cada paso con su salida. Ver spec, «Instalación por SSH».

**Blocked by:** 09.

**Status:** ready-for-agent

- [ ] Diálogo «Add a machine over SSH» con pasos y salida en vivo.
- [ ] La clave se usa en memoria y no se guarda salvo «keep for updates» (secret store del Hub).
- [ ] Un fallo detiene el proceso con el paso y su salida; la concesión caduca y no queda máquina a medias. Red-first.
- [ ] Auditoría `environment.register` con modo `dedicated` y vía `ssh`, sin la clave.
- [ ] Tests con un sshd de test en contenedor (o fake del cliente SSH) para pasos, fallos y limpieza.
