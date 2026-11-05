# Cierre del mapa

Type: grilling
Label: wayfinder:grilling
Status: resolved
Blocked by: 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15
Map: ../map.md

## Question

¿Qué hacemos con cada patch de «Not yet specified» para que no quede nada por decidir antes de `/to-spec`?

## Answer

Resuelto por grilling con el Owner (2026-11-04).

1. Pasan al spec como detalle de implementación: el formato y las garantías de entrega del protocolo Hub ↔ Environment (su forma ya está decidida en «Registrar Environments en el Hub» y «Mover un Project entre Environments»), y las superficies de cliente (web, desktop, móvil: selector de Space, Invitations, selector de AI account), dentro del spec de cada área.
2. Mover un Project de Space con Threads en curso: primero se detienen sus Threads; en el destino deja de usar los Vaults y AI accounts del Space de origen y usa los del destino; antes de confirmar se avisa de qué Vaults pierde.
3. Fuera del alcance (mejoras futuras, cada una con su propio mapa): secretos usados sin verlos (proxy), `.env.schema` por Project, copia de la sesión nativa entre máquinas, imágenes de Sandbox personalizadas, egress allowlist, cuotas de IA por User u Organization.
4. Se empieza de cero: no hay migración de datos de un t3code monousuario. Auditoría mínima dentro del alcance: Invitations, cambios de Role, revelado y edición de secretos, borrados definitivos y registro de Environments; va en el spec de identidad y permisos.
