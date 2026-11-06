# 02: `t3 join` y la vista Environments

**What to build:** El Owner ejecuta `t3 join <url del Hub>` en una máquina, confirma en el navegador del Hub tras un factor fuerte, y la máquina queda como un External environment personal:

- arranca en modo joined, que no sirve clientes ni sign-in;
- mantiene un WebSocket saliente hacia el Hub, con saludo y heartbeat.

En Settings → Environments, el Owner ve cada máquina y puede renombrarla o quitarla. Quitarla revoca la credencial al instante. Ver spec, «Protocolo Hub ↔ Environment» y «Unir y quitar Environments».

**Blocked by:** None (can start immediately).

**Status:** done

- [ ] Hay una tabla `environments` con el Hub machine sembrado como tipo `hub`. La credencial se guarda hasheada y nunca se muestra.
- [ ] Flujo de `t3 join`:
  - [ ] PKCE con loopback, como el AppSignIn del spec 1.
  - [ ] Página «Register this machine» con nombre editable, sistema operativo y hora.
  - [ ] Solo el Owner puede confirmar, con passkey o con contraseña + TOTP.
  - [ ] Se rechaza una URL que no es HTTPS, salvo localhost.
- [ ] El modo joined no sirve la UI ni el WebSocket de usuario. `t3 status` muestra el Hub y el estado de la conexión, y `t3 leave` da de baja la máquina.
- [ ] Saludo con versión del protocolo, sistema operativo, hostname, providers con su versión y capacidades, y recursos. Heartbeat cada 10 s; sin heartbeat en 30 s pasa a `reconnecting`, y al minuto a `offline`. Reconexión con backoff y jitter.
- [ ] Settings → Environments, solo para el Owner: lista con tipo, estado en vivo, last seen, providers, recursos y Threads en marcha; acciones de renombrar y quitar. Un Member no ve las máquinas personales del Owner.
- [ ] Quitar una máquina cierra su conexión y rechaza la credencial en el siguiente uso.
- [ ] Se auditan `environment.register`, `environment.rename` y `environment.remove`, con detalle en allow-list.
- [ ] Tests en la seam secundaria del flujo join (alta, revocación, URL no HTTPS) y de que una credencial revocada o de otro Hub se rechaza. Red-first.
- [ ] Se entregan los nombres accesibles para la prueba real.
