# 14: Quitar `environmentId` de `ScopedThreadRef`

**What to build:** Limpieza interna, sin cambio visible. Desde el ticket 07 los clientes solo tienen una conexión, la del Hub, y `ScopedThreadRef.environmentId` vale siempre el id de esa conexión. Se quita el campo y las rutas que lo llevan, para que el código deje de suponer varios servidores. Ver ticket 07 y 13.

**Blocked by:** 13.

**Status:** ready-for-agent

Tamaño medido al cerrar el 13 (referencias a `ScopedThreadRef`, `scopeThreadRef` y `scopedThreadKey`):

| Paquete        | Archivos fuente | Archivos de test | Referencias |
| -------------- | --------------- | ---------------- | ----------- |
| contracts      | 1               | 0                | 3           |
| shared         | 2               | 1                | 15          |
| client-runtime | 11              | 2                | 77          |
| mobile         | 53              | 0                | 187         |
| web            | 168             | 46               | 1217        |

- [ ] Expand–contract: se añade la forma nueva de la referencia junto a la vieja; se migra paquete por paquete (contracts/shared → client-runtime → mobile → web), con typecheck de web, desktop, mobile y client-runtime en verde en cada commit; al final se borra la forma vieja.
- [ ] Las rutas de móvil pasan de `threads/:environmentId?/:threadId?` a `threads/:threadId`, con redirección desde la forma vieja.
- [ ] Las cachés por Environment del cliente (`cache.saveShell(environmentId)` y similares) quedan indexadas por la conexión al Hub o sin clave de Environment.
- [ ] Prueba real en web: sidebar, rutas de Thread, redirecciones de enlaces viejos y mover un Thread siguen funcionando.
