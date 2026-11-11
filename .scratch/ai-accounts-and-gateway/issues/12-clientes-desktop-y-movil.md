# 12: Clientes: desktop y móvil

**What to build:** Desktop iguala a la web (Settings → AI accounts, Settings → AI gateway, selector y header del Thread, «Local CLI keys»). Móvil muestra el selector y la cuenta en uso en cada Thread, las AI accounts con su estado y uso en solo lectura y las «Local CLI keys» propias; iniciar sesión en suscripciones y actualizar la gateway quedan para web y desktop. Ver spec, «Clientes».

**Blocked by:** 08, 10.

**Status:** ready-for-agent

- [ ] Datos de AI accounts, cuenta en uso y uso del Thread por la fuente compartida de client-runtime.
- [ ] Desktop: todo lo de web, incluido el login de suscripciones con la URL pegada.
- [ ] Móvil: selector en el composer, cuenta y modelo en el header, Settings → AI accounts (estado, cuotas, uso; solo lectura), «Local CLI keys» propias (crear, copiar, revocar).
- [ ] Red-first: el cliente móvil no llama a `aiAccounts.login.*` ni a `aiGateway.update`; los controles del Owner no aparecen a un Member y el servidor los rechaza igual.
- [ ] Puertas: ninguna nueva.
- [ ] Tests de componentes en móvil (no hay Expo web) y de client-runtime.
- [ ] Prueba real: desktop contra el Hub dev (selector, header, Settings); móvil en dispositivo si está disponible (este spec toca móvil: preparar las instrucciones de build para el Owner), si no, tests de componentes.
