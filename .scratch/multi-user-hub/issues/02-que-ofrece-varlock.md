# Qué ofrece varlock

Type: research
Label: wayfinder:research
Status: resolved
Blocked by: —
Map: ../map.md

## Question

¿Qué ofrece varlock (https://github.com/dmno-dev/varlock): esquema de variables, plugins de secretos, cómo inyecta valores en procesos, cifrado, multi-entorno? ¿Cómo encajaría con la capa existente `packages/secret-provider-core` (drivers `{provider, reference}`, hoy solo 1Password) y con la inyección de variables de entorno en provider instances y terminales?

## Answer

- varlock (MIT, v1.24.0, 1.0 desde 2026-04) = esquema `.env.schema` @env-spec (`@sensitive`, tipos, `@required`) + 18 plugins de backend (1Password, Vault, Infisical, AWS…) + `exec()`.
- Inyección: CLI `varlock run --inject vars -- cmd` / `varlock load --format json`; lib Node vía `execSync` al CLI (la API en proceso no es estable). Proxy de credenciales (placeholders) en preview, HTTP/1.1, sin WebSockets.
- Cifrado: local ligado al dispositivo (Secure Enclave/TPM, fallback a fichero), no compartible; AES-256-GCM para blobs de deploy. Caché en disco compartida por usuario del SO entre proyectos.
- Multi-entorno = cascada de ficheros `.env.[env]` por `@currentEnv` (dev/staging/prod), no Environments de t3code. Sin concepto de usuario/tenant/servidor.
- Encaje: (A) driver `kind:"varlock"` que llama `varlock load --format json` (encaja con `driver.ts`); (B) wrapper `varlock run` para provider CLIs/terminales (secretos por proyecto; los terminales hoy omiten referencias); (C) proxy como capa opcional; (D) sustituir secret-provider-core: desaconsejable, no da almacén central para el Hub; (E) solo @env-spec como formato.
- A y B son compatibles; la decisión depende de dónde viva la verdad de los secretos en el Hub. Telemetría activa por defecto: hay que desactivarla.

Detalle y fuentes: [research/02-que-ofrece-varlock.md](../research/02-que-ofrece-varlock.md)
