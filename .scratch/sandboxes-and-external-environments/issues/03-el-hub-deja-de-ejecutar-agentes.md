# 03: El Hub deja de ejecutar agentes

**What to build:** Lo que no elige otra máquina corre en el Sandbox de su Space. El executor en proceso del Hub machine deja de ofrecerse, salvo un ajuste de desarrollo desactivado por defecto. Los Threads que estaban en el Hub machine pasan a «needs an environment» y se pueden mover. Ver spec, «Arquitectura».

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] Colocación: elección del User → Environment preferido del Project → Sandbox del Space; `previewThreadPlacement` compartida actualizada; un Sandbox parado cuenta como disponible.
- [ ] Ajuste de desarrollo (p. ej. `T3CODE_HUB_RUNS_AGENTS`) que mantiene el executor en proceso; producción no lo ofrece. El modo dev y los tests existentes siguen verdes.
- [ ] Threads con Active environment = Hub machine pasan a «needs an environment» al arrancar el Hub con el ajuste desactivado.
- [ ] Tests en el testkit; prueba real: un Thread nuevo sin elegir máquina corre en el Sandbox.
