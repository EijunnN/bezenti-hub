# 06: Imagen base

**What to build:** Una imagen base para todos los Sandboxes con node, git, las CLIs de IA soportadas y el servidor T3 de la versión del Hub. El Owner la construye o actualiza con `t3 sandbox image build` o desde Settings; cada Sandbox muestra su versión; los parados usan la nueva al arrancar y los que corren se actualizan solo cuando el Owner lo pide, nunca a mitad de un turno. Ver spec, «Imagen base».

**Blocked by:** 04.

**Status:** ready-for-agent

- [ ] Containerfile en el repo, construible en WSL con Podman 3.4.
- [ ] Comando y acción en Settings con progreso y error; versión registrada por Sandbox.
- [ ] Política de actualización (parados al arrancar; en marcha solo a petición y sin turno activo).
- [ ] Auditoría `sandbox.image.update`.
- [ ] Las provider logins de cada Sandbox viven en su volumen y sobreviven a cambios de imagen.
- [ ] Test de integración que construye la imagen y arranca un Sandbox con ella (se salta sin Podman).
