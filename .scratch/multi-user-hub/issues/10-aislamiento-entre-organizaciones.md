# Aislamiento entre Organizaciones

Type: grilling
Label: wayfinder:grilling
Status: resolved
Blocked by: 05, 07
Map: ../map.md

## Question

¿Qué nivel de aislamiento exigimos entre Organizaciones que comparten un Environment, y con qué mecanismo lo conseguimos?

## Answer

Resuelto por grilling con el Owner (2026-11-04). ADRs: `docs/adr/0004-one-container-sandbox-per-space.md` (nueva) y `docs/adr/0002-central-hub.md` (corregida). Término nuevo en `GLOSSARY.md`: Sandbox.

1. Aislamiento completo entre Spaces (archivos, secretos, procesos, red); ninguno dentro de un Space.
2. El proceso del Hub nunca ejecuta agentes. Lo que no elige Environment corre en el Sandbox de su Space, en la máquina del Hub.
3. Mecanismo: un servidor T3 por Space, con su usuario del SO, dentro de un contenedor rootless de Podman. gVisor, opción futura.
4. Un Sandbox por Organization y por Personal space con permiso de creación; se crea al primer uso, se registra en el Hub como Environment y solo sirve a su Space.
5. Una única imagen base mantenida por el Owner.
6. Límites de CPU, memoria y disco por Sandbox, ajustables por Space, con valores por defecto.
7. Red: salida a internet; sin visibilidad de otros Sandboxes ni de puertos internos del Hub.
8. Previews servidos a través del Hub, autenticados, solo para Members del Space.
9. Se detiene tras 30 min sin actividad y arranca bajo demanda; volumen persistente; archivar la Organization lo detiene; borrarla definitivamente borra el volumen.

Corrige la decisión 3 de «Organizaciones y espacio personal»: un Thread sin Project corre en el Sandbox de su Space, no en el Hub. Pasa a «Vaults»: cómo proteger los secretos de un Space frente a su propio agente.
