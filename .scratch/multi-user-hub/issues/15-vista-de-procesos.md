# Vista de procesos

Type: grilling
Label: wayfinder:grilling
Status: resolved
Blocked by: 06, 08
Map: ../map.md

## Question

¿Qué muestra la vista de procesos (por Project o Thread, CPU, memoria, quién lo lanzó, desde cuándo) y quién puede ver o apagar qué?

## Answer

Resuelto por grilling con el Owner (2026-11-04).

1. Árbol: Environment → Space → Project → Thread → procesos.
2. Por proceso: tipo (agente, terminal, dev server, preview, git), comando, CPU, memoria, desde cuándo, User que lo lanzó, puertos. Por Sandbox: consumo frente a sus límites.
3. Los procesos no atribuibles a un Thread (app-server de Codex, Chrome de preview…) van a un grupo «Compartido» de su Space o Environment.
4. Ven: el Owner, todo (incluida la máquina del Hub fuera de los Sandboxes); cada User, los procesos de su Space; los External environments personales, solo quien los registró y el Owner, y solo procesos lanzados por t3code.
5. Apagan: cada User, los de sus Threads; un Admin, cualquiera de su Space; el Owner, cualquiera y Sandboxes enteros.
6. «Detener» (cierre ordenado) y, si no responde, «Forzar»; atajos para parar un Thread o un Project entero; dev servers y previews se pueden volver a arrancar.
7. Medición: en vivo mientras alguien mira; resumen por turno (pico de memoria, tiempo de CPU); gráficas por Sandbox y Environment, muestra cada 30 s, 7 días de historial.
8. Cada Thread muestra su AI account y los tokens consumidos según el AI gateway.
