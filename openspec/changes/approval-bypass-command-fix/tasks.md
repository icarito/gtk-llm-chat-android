## 1. Servidor (verificación de prerequisito)

- [x] 1.1 Confirmado: el gateway de producción (`claudio-w`) ya tiene el
      comando `approval-bypass` desplegado y verificado end-to-end (ver
      change `xmpp-approval-bypass-and-fallback-cleanup` en el repo
      `openclaw-xmpp`). No requiere trabajo adicional en este repo.

## 2. Cliente — invocación real del comando

- [x] 2.1 `XmppService.setApprovalBypass` reescrito para usar
      `executeCommand` con `DataForm` (`mode`, `minutes`) en vez de mensaje
      de texto plano.
- [x] 2.2 Default de minutos corregido de 15 a 10 (coincide con el default
      real del servidor).
- [x] 2.3 `XmppService.getApprovalBypassStatus` nuevo: consulta
      `mode=status`, parsea "activo, quedan Xm/Xs" del texto de respuesta.
- [x] 2.4 `XmppContext.tsx` expone `getApprovalBypassStatus` junto a
      `setApprovalBypass`.

## 3. Cliente — UI en el popover de la sticky card

- [x] 3.1 Switch de bypass agregado dentro de
      `Modal visible={showPendingPopover}`, condicionado a
      `visiblePendingIsApproval`.
- [x] 3.2 Estilo `popoverBypassRow` agregado, reusando
      `bypassButton`/`bypassButtonActive`/`bypassButtonText` ya existentes.
- [x] 3.3 `handleToggleBypass` actualizado: usa el texto de confirmación
      real del servidor en vez de un mensaje fijo, y setea
      `bypassRemainingMinutes` optimistamente al activar.
- [x] 3.4 Polling de `status` cada 15s mientras el popover de una
      aprobación está abierto (`useEffect` condicionado a
      `showPendingPopover && visiblePendingIsApproval && state==='online'`),
      limpiado al cerrar el popover o desconectar.
- [x] 3.5 El switch del panel general de agente se mantiene sin cambios de
      ubicación (acceso preventivo, sin depender de una card visible).

## 4. Verificación

- [x] 4.1 `npm run type-check` (`tsc --noEmit`): sin errores.
- [ ] 4.2 Verificación en dispositivo real: hay un dispositivo Android
      conectado (`adb devices`) con la app ya instalada, pero ejercitar el
      flujo completo requiere una sesión de agente generando una card de
      aprobación real — no se forzó ese escenario en esta pasada. Pendiente
      de que el usuario lo pruebe en uso normal (activar bypass desde el
      popover de una aprobación real, confirmar que el servidor deja de
      pedir aprobación durante la ventana, confirmar que el switch se apaga
      solo al expirar).
