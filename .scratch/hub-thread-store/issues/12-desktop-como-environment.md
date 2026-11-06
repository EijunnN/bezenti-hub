# 12: Desktop como Environment

**What to build:** En la app de desktop, el Owner activa «Use this computer as an Environment». La app hace el alta en el Hub con el mismo flujo que `t3 join` y arranca un servidor en modo joined, como proceso gestionado. Al desactivarlo, lo para. El desktop sigue siendo, a la vez, cliente del Hub. Ver spec, «Superficies de cliente».

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] El ajuste en desktop lanza el flujo de alta en el navegador del sistema, guarda la credencial con el secret store del servidor joined y arranca ese proceso.
- [ ] Muestra el estado de la conexión. Desactivarlo para el proceso. «Leave» lo da de baja en el Hub.
- [ ] El proceso joined sobrevive a cerrar la ventana según la preferencia del User y arranca con la app.
- [ ] Tests del gestor del proceso en desktop y prueba real del alta.
