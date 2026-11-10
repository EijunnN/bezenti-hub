# 14: Checkouts de Project desde el repositorio del Hub

**What to build:** Hoy un Environment que no tiene el checkout de un Project lo clona desde el remoto propio del Project (`origin`). Dentro de un Sandbox eso falla con un `origin` que es una ruta local del Hub, y fallará con remotos privados que necesitan credenciales. El Hub pasa a ser la fuente del checkout inicial: mantiene en su repositorio del Project una copia de las ramas del Project (las que el Owner o los Members usan), y un Environment nuevo clona desde ahí con su Environment credential. El remoto propio sigue sin tocarse para checkpoints; los push a `origin` siguen siendo cosa del User. Ver spec 2 «Repositorio git del Hub y checkpoints» y spec 3 ticket 04 (riesgo detectado en la prueba real).

**Blocked by:** 04.

**Status:** done

- [x] El Hub refleja las ramas del Project en su repositorio (al añadir el Project y en cada fetch del Hub machine o del Environment que lo tenga), bajo un namespace propio, sin exponer refs de Threads ajenos.
- [x] Un Environment sin checkout lo crea desde el repositorio del Hub; `origin` del checkout sigue apuntando al remoto propio del Project.
- [x] Funciona con un `origin` que es ruta local y con un remoto privado (sin credenciales dentro del Sandbox).
- [x] Las reglas de refs por máquina del spec 2 se mantienen (una máquina no lee checkpoints de Threads ajenos). Red-first.
- [x] Tests en el testkit y con el runtime Podman.

**Hecho** (rama `impl/sbx-14`):

- **Namespace:** el repositorio del Hub de cada Project guarda sus ramas en `refs/t3/project/heads/<rama>` (`HubRepository.PROJECT_BRANCHES_PREFIX`). Los refs de Threads siguen como estaban.
- **Cómo llegan las ramas:**
  - Desde el checkout del Hub: cada fetch de `/api/git/<projectId>` (el anuncio de upload-pack) trae antes las ramas del `workspaceRoot` del Project (`HubRepositories.mirrorBranches`). Así cubre «al añadir el Project» y «cada fetch»: el primer clon de cualquier máquina ya las ve, entre por la puerta que entre. El checkout del Hub solo se lee.
  - Desde las máquinas: cada `checkpoint.push` de un checkout de Project ofrece `refs/heads/*` (`makeCheckoutTransfers.push`). Es la misma ruta para el Hub machine y para las máquinas unidas.
  - Solo fast-forward en ambos sentidos (sin `+`): una rama se crea o avanza y nunca se reescribe. Nadie borra.
- **Clon:** `provider.openSession` y `move.fetch` llevan `WireCheckout.fromHub` (`projectId` y la rama en la que está el checkout del Hub). La máquina (`HubRepository.cloneFromHub`) hace `git init` en una carpeta hermana, fetch `+refs/t3/project/heads/*:refs/heads/*` con su Environment credential, checkout de esa rama (si no, `main`, `master` o la primera) y `origin` = el remoto propio. Después renombra la carpeta a su sitio. Ni la URL ni la credencial del Hub quedan en el config del checkout.
- **`origin`:** es el `origin` del checkout del Hub sin contraseña, token ni query (`remoteWithoutCredentials`). Los push a `origin` siguen siendo cosa del User, con sus propias credenciales. Las ramas nuevas no tienen upstream hasta que el User haga fetch de `origin`.
- **Respaldo:** si el Hub no tiene ninguna rama del Project (su checkout aún no tiene commits), se clona `origin` como antes. Una máquina anterior ignora `fromHub` y hace lo mismo. No hace falta subir la versión del contrato (8): el campo es opcional.
- **Reglas de la ruta git** (`refPrefixesFor`):
  - Cualquier máquina que la ruta ya acepta para el Project lee y escribe `refs/t3/project/heads/`. Son las máquinas cuyo dueño puede iniciar Threads en su Space (Owner, Admin, Member y también Guest, que según el spec 1 crea Threads y las corre en su máquina personal) y el Sandbox o las máquinas dedicadas del Space.
  - El repositorio propio de un Thread sin Project no tiene ese namespace.
  - Los checkpoints y los refs de Threads ajenos siguen ocultos (v0, `hideRefs`).
  - `DoorRules` actualizado.
- **Tests:** en `HubWithEnvironments.test.ts`, «checkouts from the Hub repository»:
  - remoto privado con token en un Laptop;
  - Sandbox con `origin` = ruta del Hub;
  - roles y Spaces (Owner, Admin, Member, Guest, Sandbox de otro Space, Member y Guest en un Space ajeno, Guest que deja el Space);
  - respaldo a `origin`;
  - Podman real con `origin` = ruta del Hub.

  También `HubRepository.test.ts` (`remoteWithoutCredentials`).

- **Riesgos:**
  - Una rama reescrita (rebase o force) no llega a checkouts nuevos.
  - Una rama borrada en el checkout del Hub sigue en el Hub.
  - Una máquina del Project puede adelantar `main` del Hub para los clones siguientes, con la misma confianza que tiene para empujar al `origin`.
  - Como en los refs de Thread, una máquina que conoce el SHA de un objeto ajeno podría crear una rama que apunte a él sin enviarlo (git no lo comprueba). Requiere conocer el SHA.
