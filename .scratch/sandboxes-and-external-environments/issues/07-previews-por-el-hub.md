# 07: Previews por el Hub

**What to build:** Un servidor de desarrollo arrancado en un Sandbox se abre por una URL de preview autenticada en el Hub, solo para Members de su Space, también a través de la URL pública del Hub. Ver spec, «Previews».

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] Proxy HTTP (y WebSocket si el dev server lo usa) desde el Hub al puerto del Sandbox por el canal del Environment (capa de streams del spec 2).
- [ ] Cada petición comprueba sesión y pertenencia al Space. Red-first: un Member de otro Space recibe un rechazo.
- [ ] Respeta `T3CODE_PUBLIC_URL` / `T3CODE_TRUSTED_PROXIES`.
- [ ] Funciona igual con External environments (dedicados del ticket 09 cuando existan).
- [ ] Tests en el testkit; prueba real abriendo un dev server del Sandbox.
