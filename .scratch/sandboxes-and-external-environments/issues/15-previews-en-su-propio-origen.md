# 15: Previews en su propio origen

**What to build:** Hoy un preview se sirve en `/preview/<token>/` del propio Hub, dentro de un origen aislado (CSP `sandbox`, origen `null`) para que la página no pueda usar la sesión del Hub. Eso rompe las apps que hacen `fetch()` o cargan módulos ES con cookies: los servidores de desarrollo modernos (Vite y similares) no funcionan. Los previews pasan a servirse en un origen propio, separado del Hub (por ejemplo `<id>.preview.<dominio del Hub>`, un subdominio por preview), donde la página puede usar sus cookies y `localStorage` sin tocar las del Hub. Ver ticket 07 («Limitation») y `docs/internals/sandboxes.md#previews-through-the-hub`.

**Blocked by:** 07.

**Status:** ready-for-agent

- [ ] Ajuste de la Installation para el dominio de previews (p. ej. `T3CODE_PREVIEW_ORIGIN` con comodín), documentado con DNS wildcard y certificado; sin él, se mantiene el modo actual con su aviso.
- [ ] Un subdominio por preview (no compartido entre Users ni Spaces), con la misma autorización por petición del ticket 07 y una cookie propia del origen del preview.
- [ ] La cookie de sesión del Hub nunca llega al origen del preview; red-first.
- [ ] Un servidor Vite con HMR funciona en el preview.
- [ ] Prueba real con un proyecto Vite en un Sandbox.
