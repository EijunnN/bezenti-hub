# 07: Previews por el Hub

**What to build:** Un servidor de desarrollo arrancado en un Sandbox se abre por una URL de preview autenticada en el Hub, solo para Members de su Space, también a través de la URL pública del Hub. Ver spec, «Previews».

**Blocked by:** 01.

**Status:** done

- [x] Proxy HTTP (y WebSocket si el dev server lo usa) desde el Hub al puerto del Sandbox por el canal del Environment (capa de streams del spec 2).
- [x] Cada petición comprueba sesión y pertenencia al Space. Red-first: un Member de otro Space recibe un rechazo.
- [x] Respeta `T3CODE_PUBLIC_URL` / `T3CODE_TRUSTED_PROXIES`.
- [x] Funciona igual con External environments (dedicados del ticket 09 cuando existan).
- [x] Tests en el testkit; prueba real abriendo un dev server del Sandbox.

Notas: la URL es `/preview/<token>/` en el origen del Hub, servida con `Content-Security-Policy: sandbox` (origen opaco); la regla de quién la abre es la de las demás RPC de preview (`work`: el User del Thread). Ver `docs/internals/sandboxes.md#previews-through-the-hub`.
