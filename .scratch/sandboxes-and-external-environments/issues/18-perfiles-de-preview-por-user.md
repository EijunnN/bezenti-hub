# 18: Perfiles de preview por User

**What to build:** El navegador de previews del Hub (`apps/server/src/preview/ServerBrowser.ts`, `ServerBrowserContexts.ts`, `ServerBrowserStream`, `/api/preview-stream`, herramientas MCP `preview_*`) guarda sus perfiles de Chromium (cookies, `localStorage`, sesiones iniciadas) en `server-browser/profiles/<id de perfil>`, compartidos por todos los Users de la Installation. El ticket 17 ató las pestañas al Thread de quien llama, pero un preview de un User sigue viendo lo que otro User dejó en el mismo perfil: si A inicia sesión en su app en un preview, el preview de B del mismo origen entra como A. `preview.clearProfile` y los informes de perfiles (`preview.reportProfiles`) son de toda la Installation. Este ticket separa los perfiles por User y por Space, y hace que cada puerta use la misma regla, decidida en un solo sitio.

**Blocked by:** 17.

**Status:** pendiente

- [ ] Clave del perfil: (User, Space) del Thread de la pestaña (su dueño efectivo, como `claimWork`, y su Space), más el id de perfil elegido. Un User en el Space A no comparte cookies con su propio preview en el Space B. Si no se sabe de quién es (borrador sin fila), contexto efímero aislado, nunca uno persistente compartido.
- [ ] Un solo sitio decide la clave y lo usan todas las puertas que llegan al navegador del servidor: RPCs WS (`preview.open` y compañía vía `PreviewManager`), HttpApi, `/api/preview-stream`, herramientas MCP (`preview_open`, `preview_snapshot`…).
- [ ] `preview.clearProfile` solo borra los perfiles de quien llama (en todos sus Spaces); `preview.reportProfiles` solo informa el catálogo de su User, y las pestañas y herramientas usan el catálogo del dueño del Thread.
- [ ] El Owner puede borrar los de todos, como acción aparte y explícita (`preview.clearAllProfiles`, solo Owner), nunca por defecto.
- [ ] Carpetas en disco con nombres que no chocan ni se adivinan (HMAC con secreto de la Installation, por nivel User / Space / perfil).
- [ ] Quitar un User borra sus perfiles; salir de un Space borra los de ese Space (también al arrancar, por si el cambio llegó con el servidor parado).
- [ ] Tamaño acotado: caché de disco limitada, perfiles sin uso durante mucho tiempo borrados, y un tope por perfil.
- [ ] Datos compartidos antiguos (`server-browser/profiles/`): se borran al arrancar; documentado.
- [ ] Red-first con Owner, Admin, Member y Guest del mismo Space y de otro Space. Test clave: la cookie de A no aparece en el preview de B del mismo origen; borrar el perfil de A no toca el de B.
- [ ] Sin romper previews (07, 15), streams de preview ni herramientas MCP de preview.
- [ ] Pase en vivo: dos Users con el mismo app en el navegador del servidor; A pone una cookie, B no la tiene; borrar el perfil de A no afecta a B.
