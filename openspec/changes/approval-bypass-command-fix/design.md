## Context

El servidor (plugin `openclaw-xmpp`) registra `approval-bypass` como
comando ad-hoc XEP-0050 con dos parámetros declarados (`mode`, `minutes`),
resuelto por el flujo estándar de dos pasos: un IQ `execute` sin form
devuelve `status="executing"` con un XEP-0004 form (porque
`action.params.length > 0`), y un segundo IQ `action="complete"` con el
form lleno cierra el comando (`status="completed"`) devolviendo texto
libre como resultado — no hay campo estructurado, el cliente debe parsear
el texto si necesita datos (ej. minutos restantes).

El cliente ya tiene toda la maquinaria para este flujo
(`executeCommand(targetJid, node, form?)` en `XmppService.ts`), usada por
`runAdhocCommand` para el resto de comandos del menú de agente. El bug
original era que `setApprovalBypass` no usaba esa maquinaria: mandaba un
`<message type="chat">` con `/oc approval-bypass on|off` como body, que el
plugin del lado servidor interpreta como el *fallback textual* — y ese
fallback busca un nodo registrado llamado literalmente `approval-bypass`
en su dispatcher de acciones, que sí existe, así que en teoría debería
haber funcionado. La investigación previa (ver memoria de la sesión que
diagnosticó esto) determinó que el mismatch real históricamente fue de
nombre de nodo en una iteración anterior del servidor; para esta iteración
el nombre ya coincide, pero igual se corrige el mecanismo de invocación
para no depender del fallback textual (más frágil: cualquier drift futuro
de nombre entre servidor y cliente rompe en silencio hasta que alguien
prueba manualmente) y usar el camino XEP-0050 tipado que ya usa el resto
del cliente.

## Goals / Non-Goals

**Goals:**
- El switch de bypass invoca el comando real del servidor y confirma con
  el mensaje que el servidor realmente devuelve (no un texto fijo local).
- El switch aparece en el popover de la sticky card de una aprobación
  (pedido explícito del usuario), además del panel general existente.
- El estado del switch se mantiene veraz incluso después de que el bypass
  expire solo en el servidor (polling, no solo estado local optimista).

**Non-Goals:**
- No se cambia el servidor — ya está desplegado y verificado.
- No se implementa un mecanismo de push/notificación cuando el bypass
  expira; el polling mientras el popover está abierto es la única señal.
- No se persiste el estado de bypass entre reaperturas de la app — se
  vuelve a consultar `status` la próxima vez que se abra el popover.

## Decisions

**Polling de 15s solo mientras el popover está abierto, no en background.**
Evita tráfico XMPP constante para un caso de uso de minutos, no de horas.
Si el usuario cierra el popover, el switch general del panel de agente no
hace polling — solo refleja el último estado optimista local, consistente
con cómo se comportaba antes de este fix.

**Parseo de texto para minutos restantes, no un campo estructurado nuevo.**
Cambiar el protocolo del comando (agregar un campo de datos estructurado
en la respuesta) es trabajo del lado servidor fuera del alcance de este
repo. El regex (`/quedan\s+(\d+)([ms])/i`) es tolerante pero frágil ante
cambios de redacción del mensaje del servidor — aceptado como deuda menor,
documentado en el comentario del código.

## Risks / Trade-offs

- **[Riesgo] El regex de parseo de "status" se rompe si el servidor cambia
  la redacción del mensaje** → Mitigación: `getApprovalBypassStatus`
  degrada a `{active: true}` sin `remainingMinutes` si el regex no
  matchea, en vez de lanzar error — el switch sigue mostrando "activo" sin
  el contador, no se rompe la UI.
- **[Trade-off] Sin verificación en dispositivo real dentro de esta
  sesión** → hay un dispositivo Android conectado y `type-check` pasa
  limpio, pero ejercitar el flujo completo (generar una aprobación real,
  ver la sticky card, expandirla, tocar el switch) requiere una sesión de
  agente activa generando una card real — no se forzó ese escenario en
  esta pasada. Pendiente de que el usuario lo pruebe en uso normal.
