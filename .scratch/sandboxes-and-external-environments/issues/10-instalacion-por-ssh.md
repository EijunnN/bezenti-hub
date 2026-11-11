# 10: Instalación por SSH

**What to build:** El Owner añade una máquina dedicada dando al Hub host, puerto, usuario y clave SSH. El Hub comprueba el sistema y Podman (lo instala si hay sudo sin contraseña), instala la versión de T3 del Hub, registra la máquina con una concesión de un solo uso y arranca su servicio, mostrando cada paso con su salida. Ver spec, «Instalación por SSH».

**Blocked by:** 09.

**Status:** done

- [x] Diálogo «Add a machine over SSH» con pasos y salida en vivo.
- [x] La clave se usa en memoria y no se guarda salvo «keep for updates» (secret store del Hub).
- [x] Un fallo detiene el proceso con el paso y su salida; la concesión caduca y no queda máquina a medias. Red-first.
- [x] Auditoría `environment.register` con modo `dedicated` y vía `ssh`, sin la clave.
- [x] Tests con un sshd de test en contenedor (o fake del cliente SSH) para pasos, fallos y limpieza.

## Hecho

- Servidor: `apps/server/src/environments/sshInstall/` (`SshInstall`, `SshClient` con ssh2 en el propio proceso, `sshInstallScripts`). Puertas solo HttpApi, todas del Owner (`authorizeDedicate`): `POST /api/environments/ssh/{start,confirm,cancel,status}` (el progreso es `status`, consultado cada segundo); la máquina canjea la concesión en `POST /api/environments/join/grant` (`t3 join --dedicated … --grant-on-stdin`). Sin puerta WS ni MCP (DoorRules lo comprueba). Migración 110 (`environment_ssh_hosts`).
- Web: Settings → Environments, «Add over SSH» (`SshInstallDialog`): formulario, huella de la clave del host para confirmar («Trust this key and install»), los cuatro pasos con su salida en vivo, «Cancel installation», «Try again».
- Clave del host TOFU: se confirma la huella, se guarda con la máquina y una clave distinta se rechaza antes de iniciar sesión; una máquina ya instalada también se rechaza («already installed as …»).
- Direcciones: nunca link-local, sin especificar, multicast, ni la propia máquina del Hub (loopback y sus interfaces; `T3CODE_SSH_INSTALL_ALLOW_HUB_HOST=1` solo para desarrollo y tests). Redes privadas y públicas sí.
- Concesión: 32 bytes, solo su SHA-256, 5 min, un uso, ligada a la ejecución y su Space; se revoca al fallar o cancelar. Un fallo o una cancelación quitan la máquina registrada (`environment.remove` vía `ssh`) y deshacen en la máquina solo lo que esa ejecución registró.
- La clave y la frase de paso viven en memoria hasta que acaba la ejecución; salida y errores pasan por un filtro; un test revisa spans, logs y todos los ficheros del Hub. «Keep the key for updates» la guarda en el secret store (`ssh-install-key-<id>`), que se borra al quitar la máquina.
- Revisión: cada paso corre en su propio grupo de procesos en la máquina (se detiene al cancelar o agotar el tiempo; otro paso espera), el paso 1 comprueba lingering, las direcciones se juzgan por sus bytes, se borra cualquier trozo de 12+ caracteres de un secreto, cancelar funciona en cualquier momento, cerrar el diálogo cancela, y un fallo dice qué quedó en la máquina.
- Tests: `HubWithEnvironments.sshInstall.test.ts` (16, sshd real de ssh2 en proceso), `sshInstallScripts.test.ts` (10, scripts con `sh`), `DoorRules.test.ts`. Prueba en vivo con contenedores sshd (Podman instalado con sudo, máquina sin Podman ni sudo, segunda instalación rechazada).
