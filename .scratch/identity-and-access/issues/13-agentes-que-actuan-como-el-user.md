# 13: Agentes que actúan como el User

**What to build:** Las herramientas MCP de T3 Code que llama un agente se ejecutan con el principal del User que lanzó el turno, así que solo alcanzan sus Spaces. Los agentes externos que se autorizan por MCP OAuth y los tokens de la CLI `t3` quedan ligados a un User y actúan con sus permisos.

**Blocked by:** 04, 07

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] El contexto de invocación MCP expone el principal del User (heredado de «Prefactor: principal actual en cada petición», que lo dejó solo en WS y HTTP).
- [ ] Una llamada de herramienta de un agente no puede leer Projects o Threads fuera de los Spaces del User que lanzó el turno (test de frontera).
- [ ] La autorización MCP OAuth pide y registra el User.
- [ ] Los tokens emitidos por la CLI llevan `userId`.
