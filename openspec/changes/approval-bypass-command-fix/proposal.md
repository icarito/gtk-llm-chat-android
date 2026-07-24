## Why

El cliente ya tenía un switch de "bypass approvals" en el panel de agente,
pero `XmppService.setApprovalBypass` mandaba `/oc approval-bypass on|off`
como mensaje de chat plano en vez de ejecutar el comando ad-hoc XEP-0050
real que el servidor (`openclaw-xmpp`, ver change
`xmpp-approval-bypass-and-fallback-cleanup`) registra bajo ese mismo nombre
de nodo. El servidor rechazaba el mensaje con "Command not found" — el
switch existía pero no hacía nada. Además, el usuario pidió específicamente
que el switch aparezca al expandir la sticky card de una aprobación (el
popover), no solo en el panel general de controles del agente.

## What Changes

- `XmppService.setApprovalBypass` ahora ejecuta el comando ad-hoc real vía
  `executeCommand` (mismo camino que el resto de comandos nativos del
  cliente), con un `DataForm` de dos campos (`mode`, `minutes`), en vez de
  mandar texto plano.
- Nueva función `XmppService.getApprovalBypassStatus` que consulta
  `mode=status` y parsea la respuesta de texto del servidor para saber si
  hay un bypass activo y cuántos minutos quedan.
- El popover de la sticky card de aprobación (`showPendingPopover`) ahora
  incluye el switch de bypass cuando la card visible es una aprobación,
  con polling de `status` cada 15s mientras el popover está abierto, para
  reflejar la auto-reversión que ocurre del lado servidor sin aviso push.
- El switch ya existente en el panel general de agente se mantiene (acceso
  rápido preventivo, sin depender de que haya una card visible).
- Default de minutos corregido de 15 a 10, para coincidir con el default
  real del servidor.

## Capabilities

### New Capabilities
- `xmpp-approval-bypass-control`: switch de bypass temporal de
  aprobaciones, contextual a la sticky card de una aprobación pendiente,
  con reflejo veraz de estado vía polling del servidor.

### Modified Capabilities
(ninguna)

## Impact

- `src/xmpp/XmppService.ts`: `setApprovalBypass` reescrito,
  `getApprovalBypassStatus` nuevo.
- `src/xmpp/XmppContext.tsx`: expone `getApprovalBypassStatus`.
- `app/xmpp-chat/[jid].tsx`: switch agregado al popover de aprobación,
  polling de status, `handleToggleBypass` actualizado.
- Depende del servidor (`openclaw-xmpp`) ya desplegado con el comando
  `approval-bypass` real — verificado end-to-end en producción
  (`claudio-w`) antes de este change.
