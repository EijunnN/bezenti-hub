# 01: Prefactor: principal actual en cada petición

**What to build:** Prefactor sin cambio de comportamiento. Introducir un servicio de contexto `CurrentPrincipal` (sesión autenticada hoy; el User mañana) provisto una vez por conexión WebSocket y por petición en HTTP y MCP, y hacer que el middleware de autorización RPC reciba el principal en vez de solo los scopes. Los handlers que hoy leen la sesión por closure pasan a leerla del contexto. Ver spec «Identidad y acceso», sección Módulos.

**Blocked by:** None (can start immediately)

**Status:** done

Spec: ../spec.md

- [x] El principal está disponible en WS RPC (una vez por conexión) y en HTTP (por petición) con la misma forma: el servicio existente `EnvironmentAuthenticatedPrincipal`. MCP mantiene su `McpInvocationContext`; unificarlo con el principal del User pasa a «Agentes que actúan como el User» (13).
- [x] El middleware de autorización RPC recibe el principal; la tabla método→scope sigue igual.
- [x] Ningún handler de autorización lee la sesión por closure.
- [x] Todos los tests existentes de auth y RPC pasan sin cambios de expectativas.
