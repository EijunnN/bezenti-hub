# 07: Cada User solo ve sus Spaces

**What to build:** Un User solo recibe los Projects y Threads de los Spaces que puede ver. El snapshot del shell, sus deltas en vivo, todas las RPC de lectura de Projects y Threads, y los endpoints HTTP equivalentes pasan por un único helper de visibilidad.

**Blocked by:** 06

**Status:** done

Spec: ../spec.md

- [x] Un único helper de visibilidad usado por el shell (snapshot y deltas) y por todas las lecturas RPC y HTTP de Projects y Threads.
- [x] Test de frontera: dos Users en Organizations distintas no ven el trabajo del otro, ni en snapshot ni en vivo.
- [x] Extender los tests de autorización RPC para que toda RPC con alcance de Space esté cubierta por el helper.
- [x] El Owner sigue viéndolo todo.
