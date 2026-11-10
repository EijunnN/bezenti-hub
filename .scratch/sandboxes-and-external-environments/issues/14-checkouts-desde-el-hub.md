# 14: Checkouts de Project desde el repositorio del Hub

**What to build:** Hoy un Environment que no tiene el checkout de un Project lo clona desde el remoto propio del Project (`origin`). Dentro de un Sandbox eso falla con un `origin` que es una ruta local del Hub, y fallará con remotos privados que necesitan credenciales. El Hub pasa a ser la fuente del checkout inicial: mantiene en su repositorio del Project una copia de las ramas del Project (las que el Owner o los Members usan), y un Environment nuevo clona desde ahí con su Environment credential. El remoto propio sigue sin tocarse para checkpoints; los push a `origin` siguen siendo cosa del User. Ver spec 2 «Repositorio git del Hub y checkpoints» y spec 3 ticket 04 (riesgo detectado en la prueba real).

**Blocked by:** 04.

**Status:** done

- [x] El Hub refleja las ramas del Project en su repositorio (al añadir el Project y en cada fetch del Hub machine o del Environment que lo tenga), bajo un namespace propio, sin exponer refs de Threads ajenos.
- [x] Un Environment sin checkout lo crea desde el repositorio del Hub; `origin` del checkout sigue apuntando al remoto propio del Project.
- [x] Funciona con un `origin` que es ruta local y con un remoto privado (sin credenciales dentro del Sandbox).
- [x] Las reglas de refs por máquina del spec 2 se mantienen (una máquina no lee checkpoints de Threads ajenos). Red-first.
- [x] Tests en el testkit y con el runtime Podman.

**Hecho** (rama `impl/sbx-14`, revisado tras la primera revisión):

- **Copia del checkout del Hub:** `refs/t3/project/` en el repositorio del Project guarda las ramas (`heads/`), los refs de seguimiento de `origin` (`remotes/origin/`, sin `origin/HEAD`) y el commit de HEAD (`checkout/HEAD`) del `workspaceRoot` del Hub (`HubRepositories.mirrorCheckout`). Se copia con `+` y `--prune`: el checkout del Hub manda, así que un rebase o una rama borrada llegan al siguiente checkout nuevo.
- **Solo el Hub escribe ahí.** Las máquinas que la ruta git acepta para el Project leen `refs/t3/project/` y no escriben nada: `refPrefixesFor` no les da prefijo de escritura y la ruta rechaza el push antes de que git lo vea. `checkpoint.push` ya no publica `refs/heads/*`, así que las ramas propias de una máquina nunca llegan al Hub.
- **Cuándo se copia:** solo para un checkout nuevo. Su fetch manda la cabecera `X-T3-Checkout` (`http.extraHeader`). En ese anuncio de upload-pack la ruta copia antes, una copia a la vez por Project (los clones que piden a la vez comparten una), con un límite de un minuto. Un fallo se registra y no bloquea. Los fetch de checkpoints no mandan la cabecera ni esperan.
- **Raíz de confianza:** solo se copia desde una raíz que la regla de hoy acepta (`SpaceVisibility.trustedProjectRoot`, la misma regla de `directoryRoots` que usan las comprobaciones de carpetas). Desde otra raíz no se copia nada.
- **Clon (`HubRepository.cloneFromHub`):**
  - Las ramas pasan a ser las ramas locales, y `remotes/origin/*` pasa a `refs/remotes/origin/*`.
  - Checkout de la rama del Hub. Si el HEAD del Hub está suelto, ese commit en HEAD suelto. Solo si no se puede leer HEAD, `main` o `master`. Nunca la primera alfabéticamente.
  - `origin` es el remoto propio, con upstream `origin/<rama>` si el Hub tenía ese ref de seguimiento.
  - El clon se hace en una carpeta hermana. El rename se reintenta ante Busy/PermissionDenied, y la carpeta temporal se borra en todos los caminos.
  - Un fallo del Hub se reintenta 3 veces con backoff y luego el checkout falla. Nunca cae a `origin` por un error.
- **Respaldo a `origin`:** solo cuando `fromHub` no viene, es decir, cuando el Hub no tiene un checkout del Project con commits en una raíz de confianza.
- **`origin` y `cloneUrl`:** se quita la contraseña, un usuario que es en sí un token y los parámetros de query con nombre de credencial. El usuario y los demás parámetros se quedan. El token nunca sale del Hub.
  - Una máquina anterior ignora `fromHub` y clona ese mismo `cloneUrl` sin token. Un remoto privado que antes clonaba gracias a la URL del Hub ahora falla ahí hasta actualizarla.
- **Lecturas git en el Hub:** las dos (o tres) lecturas git de `checkoutFor` corren en paralelo.
- **Tests (red-first):** en `HubWithEnvironments.test.ts`, «checkouts from the Hub repository»:
  - HEAD, refs de seguimiento y upstream;
  - las ramas privadas de una máquina no llegan al Hub;
  - un fetch rutinario no copia nada;
  - un rebase y un borrado en el Hub llegan a un checkout nuevo;
  - ninguna máquina escribe en `refs/t3/project/` (Owner, Admin, Member, Guest, Sandbox), y el Sandbox de otro Space y un Space ajeno no leen;
  - una raíz sin confianza no copia nada y se clona `origin`;
  - un Hub roto falla sin caer a `origin`;
  - HEAD suelto;
  - Sandbox con `origin` = ruta del Hub;
  - Podman real.

  También `HubRepository.test.ts` (`remoteWithoutCredentials`). DoorRules actualizado.

- **Riesgos:**
  - Un Guest con máquina personal lee el código (spec 1: crea Threads).
  - Un rebase en el Hub cambia `main` para los checkouts nuevos. Es lo esperado: el Hub manda.
  - Para raíces sin confianza el Hub sigue leyendo su `origin` (comportamiento anterior).

**Revisión final:**

- **Project en una subcarpeta del repositorio** (`/repo/packages/web`): se copia desde la raíz del repositorio (`directoryRoots.projectRepository`, la misma regla del ticket 17: la raíz no contiene carpetas del Hub). En la máquina, el checkout por defecto es `<raíz>/<slug>/packages/web`, con el repositorio entero en `<slug>` (`WireCheckout.subfolder`).
- **Copia:**
  - tiene el tiempo de una transferencia (10 min);
  - `at` solo cuenta una copia que terminó bien;
  - la entrada del mapa se borra cuando nadie espera.
- **URL:** una URL que no se decodifica no conserva la información de usuario.
- **Decisión sobre agentes viejos:** `fromHub` y `subfolder` solo van a máquinas con contrato de executor 9 o superior (sube de 8 a 9). Las demás clonan `cloneUrl` como antes y nunca leen la copia sin la cabecera.
- **Reintentos:** solo fallos transitorios (red, 5xx, timeouts), dentro del `CLONE_TIMEOUT_MS`.
- **Upstreams:** se copia el upstream real de cada rama del Hub (`branch.<b>.remote/merge` con remote `origin`). Si la rama no tiene upstream, no se pone ninguno.
- **Rename:** antes de reintentar comprueba si el destino ya existe.
- **Lecturas git:** un solo helper (`gitRead`) que distingue «no hay» de un fallo real.
