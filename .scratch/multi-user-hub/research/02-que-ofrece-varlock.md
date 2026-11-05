# Qué ofrece varlock y cómo encaja con secret-provider-core

Fecha: 2026-11-04. Solo fuentes primarias. Abreviaturas:

- `[docs]/x.mdx:L` = `https://github.com/dmno-dev/varlock/blob/main/packages/varlock-website/src/content/docs/x.mdx` (fuente del sitio varlock.dev).
- `[repo]/x:L` = `https://github.com/dmno-dev/varlock/blob/main/x`.
- `[gh-api]` = metadatos de `gh api repos/dmno-dev/varlock` consultados hoy.
- Las rutas sin prefijo son de este repo.

## 1. Qué es

Es una herramienta de config, secretos y variables de entorno construida sobre la especificación @env-spec. Está escrita en TypeScript pero no depende de ningún lenguaje, y su caso de uso es la configuración que se lee al arrancar o compilar ([docs]/getting-started/introduction.mdx:8).

## 2. Esquema (@env-spec)

- Es un DSL que extiende `.env` con comentarios `@decorator`, estilo JSDoc, y con llamadas a funciones como valores ([docs]/env-spec/overview.mdx:7). Ejemplo: `# @required @sensitive @type=string(startsWith="sk_")` y después `STRIPE_SECRET_KEY=varlock(local:...)` (overview.mdx:13-18).
- El `.env.schema` se commitea y sustituye a `.env.example` (overview.mdx:28). @env-spec es un RFC del mismo autor y no un estándar externo (overview.mdx:51). El parser solo parsea, no carga nada (overview.mdx:43).
- `@sensitive`/`@defaultSensitive` marcan qué es secreto (`[docs]/guides/secrets.mdx:6`).

## 3. Plugins y backends

- Repositorio: hay 18 paquetes en `packages/plugins/` ([gh-api]). Entre ellos 1Password, AWS, Azure, Bitwarden, Doppler, Google SM, HashiCorp Vault, Infisical, KeePass, Kubernetes, pass y Proton Pass. Aparte están `keychain()` para macOS ([docs]/guides/secrets.mdx:73) y `exec()` como comodín para cualquier CLI (secrets.mdx:114-124).
- Un plugin añade decoradores, tipos y funciones resolutoras (`[docs]/guides/plugins.mdx:6`; API `plugin.registerResolverFunction`, `[repo]/packages/plugins/pass/src/plugin.ts:304,344`). Se carga con `@plugin(...)`. En un proyecto JS sale de `node_modules`. Con el binario standalone exige una versión fija, que descarga de npm, y pide confirmación si el plugin es de terceros (plugins.mdx:32,46,52-53).
- Admite varias instancias por plugin (`@initOp(id=dev…)`, `op(dev, op://…)`) (plugins.mdx:94-109). `@setValuesBulk` carga lotes, por ejemplo un entorno de 1Password o una ruta de Vault (secrets.mdx:126-156).
- 1Password: app de escritorio o service account; el SDK consume unos 400 MB de RSS (`[docs]/plugins/1password.mdx:15,84`).

## 4. Cómo llegan los valores a los procesos

- `varlock run -- <cmd>` lanza un hijo con las variables ya resueltas ([docs]/reference/cli/load-and-run.mdx:98-100). Por defecto inyecta además `__VARLOCK_ENV`, el grafo serializado _con los secretos_. Con `--inject vars` se omite, y es lo que la doc recomienda para shells y agentes (load-and-run.mdx:110,163-172). `varlock run` sigue vivo como proceso padre y reenvía las señales (load-and-run.mdx:175-187).
- `varlock load --format json|env|shell|json-full` imprime los valores resueltos. `--agent` los redacta (load-and-run.mdx:23,81-86).
- Node: `varlock/auto-load` llama al CLI con `execSync` y parchea `console` para redactar (`[docs]/integrations/javascript.mdx:16`; secrets.mdx:188-192). `varlock/auto-init` solo lee el blob (javascript.mdx:93-99). La API en proceso `load()` tiene `// TODO: add some options` y escribe en `process.env` ([repo]/packages/varlock/src/index.ts, función `load`). El camino documentado es pasar por el CLI.
- La redacción del stdout en `run` solo actúa si la salida va por pipe. En una TTY no hay redacción (secrets.mdx:175-179).
- **Proxy de credenciales**: `varlock proxy run -- claude`. El agente ve placeholders y el proxy pone el valor real en la conexión TLS verificada (`[docs]/guides/proxy.mdx:6,77-82`). Está en _preview_ con API inestable (proxy.mdx:58). Sus límites: mismo usuario del SO (no es frontera sin sandbox), solo HTTP/1.1, y en los hosts con regla no admite WebSockets ni gRPC (proxy.mdx:144,150). El sandbox integrado solo existe en macOS. Fuera de macOS hay que usar `--sandbox=docker` (`[docs]/guides/proxy/sandboxing.mdx:23-54`).

## 5. Cifrado

- Cifrado local con `varlock("local:…")`. La clave está ligada al dispositivo y los valores no están pensados para compartirse ni commitearse (`[docs]/guides/local-encryption.mdx:10`; secrets.mdx:62). El backend se elige automáticamente: Secure Enclave, TPM/Windows Hello o TPM2/Secret Service, y si no hay ninguno un fichero en `~/.varlock/` (local-encryption.mdx:86-93). En un servidor Linux o Windows con TPM descifra sin intervención humana. En macOS siempre pide presencia del usuario (local-encryption.mdx:111-120).
- Despliegues: el blob inyectado en el build se cifra con AES-256-GCM y la clave `_VARLOCK_ENV_KEY` llega en runtime (`[docs]/guides/encrypted-deployments.mdx:35-38`).
- Caché en disco cifrada en `~/.config/varlock/cache/`. Es **por usuario del SO y compartida entre proyectos**, y las claves de caché quedan en claro (`[docs]/guides/caching.mdx:63-68`).

## 6. Multi-entorno

`@currentEnv=$APP_ENV` elige qué ficheros entran. La precedencia, de menor a mayor, es `.env.schema` < `.env` < `.env.local` < `.env.[env]` < `.env.[env].local`, y por encima de todo el entorno del proceso (`[docs]/guides/environments.mdx:17,25-32`). Son entornos de despliegue (dev, staging, prod), no Environments de t3code.

## 7. Licencia y madurez

- Licencia MIT, de DMNO Inc. ([repo]/LICENSE; `[repo]/packages/varlock/package.json:9`). Requiere Node ≥ 22.3 o Bun ≥ 1.3.3 (package.json:66).
- Repo creado el 2025-04-11. Unas 4.9k estrellas, 53 contribuidores y 75 issues abiertas. La 1.0.0 salió el 2026-04-29 y la 1.24.0 el 2026-10-29. Lleva 78 releases del CLI, con un ritmo semanal ([gh-api]).
- Telemetría anónima activada por defecto, que se puede desactivar con `VARLOCK_TELEMETRY_DISABLED` (`[docs]/guides/telemetry.mdx:8,36,42`). Hay que desactivarla en un producto self-hosted.

## 8. Lo que t3code ya tiene

- Un driver es `{kind, definition, read(config, references) → (string|undefined)[]}`. Recibe `ChildProcessSpawner`, `FileSystem` y `SecureRandom` (`packages/secret-provider-core/src/server/driver.ts:11-27`). La definición declara `configSchema` e `isReference` (`packages/secret-provider-core/src/shared/definition.ts:5-13`).
- `SecretReference = {provider, reference}`, donde `reference` es una cadena de una línea de hasta 1024 caracteres (`packages/contracts/src/secretReference.ts:17-26`). Los proveedores se configuran en settings como `{kind, label, config: unknown}` (`packages/contracts/src/settings.ts:870-880`). El registro solo tiene 1Password (`packages/secret-provider-definitions/src/registry.ts:4-6`). Un test usa `openbao` como kind desconocido (`packages/contracts/src/settings.test.ts:159`).
- `SecretResolver` agrupa las lecturas por proveedor y las cachea durante toda la vida del servidor. Solo `invalidate` las renueva (`packages/secret-provider-core/src/server/SecretResolver.ts:1-3,119-125`).
- Inyección: las variables de una provider instance son `string | SecretReference` (`packages/contracts/src/providerInstance.ts:32-37`). El registro las resuelve antes de lanzar la CLI (`apps/server/src/provider/ProviderInstanceRegistry.ts:92-103`). Un terminal con `providerInstanceId` **omite** las referencias sin resolver (`packages/provider-core/src/server/instanceEnvironment.ts:19-20`; `apps/server/src/terminal/Manager.ts:1432-1450`), así que hoy los terminales no reciben esos secretos.

## 9. Opciones de encaje

**A. varlock como driver (`kind: "varlock"`).** `config = {path, env?}` y `reference` es el nombre de una clave del esquema (`STRIPE_KEY`). `read` ejecuta `varlock load --format json --path <dir> --filter <keys>` y devuelve los valores en orden.

- A favor: encaja tal cual en la firma de `driver.ts` y con los servicios que ya recibe. Da acceso de golpe a 18 backends más `exec()`, y la UI y el contrato no cambian.
- En contra: el esquema vive en ficheros y no en settings. Los plugins necesitan `node_modules` o descarga desde npm. Hay dos cachés, la de t3code y la de varlock, que es compartida por usuario. Hay que apagar la telemetría. `@sensitive` y los tipos solo se aprovechan como validación.

**B. Envolver los procesos con `varlock run --inject vars --`** (provider CLIs, terminales), usando un `.env.schema` por proyecto.

- A favor: cubre el hueco de "no hay env vars por proyecto" (baseline §3) y el de los terminales sin secretos.
- En contra: se salta `SecretResolver`. Añade un proceso padre residente a cada PTY y a cada agente, lo que afecta a la telemetría de procesos. Al ser una TTY no hay redacción. Y el valor real queda en el entorno del agente, que corre con el mismo usuario.

**C. Proxy de credenciales para los agentes.** Es la única opción en la que el agente no ve el secreto.

- En contra: está en preview, solo habla HTTP/1.1 sin WebSockets en los hosts con regla (hay que comprobarlo contra el transporte de cada provider), y solo es una frontera real con sandbox, que fuera de macOS significa docker. Por eso es mejor tratarla como capa opcional que como base.

**D. Sustituir secret-provider-core por varlock.**

- En contra: se pierde el driver nativo de Effect, la configuración desde settings y la UI, y el lote con `op inject` (`packages/secret-provider-onepassword/src/server/driver.ts:46-77`). Además varlock no tiene concepto de servidor, de usuario ni de tenant, y su cifrado está ligado al dispositivo. No resuelve un almacén central del Hub: el Hub seguiría necesitando un backend (Vault, OpenBao, Infisical…), del que varlock sería solo un cliente.

**E. Usar solo @env-spec como formato de esquema por proyecto** (`@sensitive`, tipos, `@required`), resolviendo con drivers propios.

- A favor: es poco acoplamiento.
- En contra: hay que reimplementar la resolución, porque el parser solo parsea.

Las opciones A y B son compatibles entre sí: el driver serviría para las referencias desde settings y el wrapper para los procesos. La decisión depende de dónde viva la verdad de los secretos en el Hub, que es otro ticket.
