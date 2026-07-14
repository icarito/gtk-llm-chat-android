# Propuesta: Features faltantes para gtk-llm-chat-android

## Objetivo
Alcanzar paridad con la versión GTK desktop y superarla como mensajero Android nativo.

---

## Fase 1: Messenger Android completo (prioridad crítica)

### 1.1 Foreground Service + Background XMPP
**Problema:** Android mata la app en background, cerrando la conexión XMPP.
**Solución:** Servicio foreground con notificación persistente "Conectado a XMPP".
- `XmppForegroundService.java` nativo
- `POST_NOTIFICATIONS` + `FOREGROUND_SERVICE` permissions en AndroidManifest
- Notificación: "gtk-llm-chat | Conectado como sebastian@..."
- La conexión XMPP vive en el servicio, no en la Activity
**Esfuerzo:** 3h

### 1.2 Notificaciones push en mensajes entrantes
**Problema:** Si la app está en background o el teléfono bloqueado, no te enterás de mensajes nuevos.
**Solución:** `expo-notifications` con canal "Mensajes XMPP".
- Al recibir `<message>`, si la app no está en foreground → notificación local
- Título: nombre del contacto, cuerpo: preview del mensaje
- Tap en notificación → abre el chat con ese contacto
- Agrupar por contacto (no una notificación por mensaje)
**Esfuerzo:** 2h

### 1.3 Mensajes de audio (XEP-XXXX + OOB)
**Problema:** No hay soporte para enviar/recibir notas de voz.
**Solución:** Grabar audio con `expo-av`, subir vía XEP-0363 (HTTP Upload), enviar URL vía XEP-0066 OOB.
- Botón de micrófono en la barra de input
- Grabar mientras se mantiene presionado (estilo WhatsApp)
- Reproducir audio recibido inline con `expo-av`
- Formato: AAC/M4A, ~32kbps mono
**Esfuerzo:** 5h

---

## Fase 2: Paridad con GTK (prioridad alta)

### 2.1 Agent delegation (NanoClaw via XEP-0050)
**Problema:** No podés ejecutar comandos ad-hoc en agentes NanoClaw desde la app Android.
**Solución:** Detectar agentes por caps y renderizar UI de comandos.
- Parsear `caps` en presencia → si es NanoClaw, mostrar badge "🤖"
- Al tocar un agente, mostrar lista de comandos disponibles (disco#items)
- UI de formulario XEP-0004 para comandos con parámetros
- Ejecutar comando y mostrar resultado
**Esfuerzo:** 4h

### 2.2 MUC / Groupchat completo
**Problema:** Solo parsea mensajes de grupo entrantes, no podés unirte/crear salas.
**Solución:** UI para rooms + join/leave.
- Lista de rooms (bookmarks o discover vía disco#items en MUC service)
- Join/leave room
- Lista de participantes con presencia en la room
- Enviar mensajes a la room
**Esfuerzo:** 4h

### 2.3 Settings screen
**Problema:** No hay forma de configurar modelo, temperatura, system prompt.
**Solución:** Tab "Ajustes" con:
- Selección de modelo LLM (igual que en GTK)
- Temperatura slider
- System prompt textarea
- API keys (DeepSeek, OpenAI, etc.) vía expo-secure-store
- Tema (dark always por ahora)
**Esfuerzo:** 3h

---

## Fase 3: Diferenciación (prioridad media)

### 3.1 Multiple accounts
**Problema:** Solo una cuenta XMPP a la vez.
**Solución:** Lista de cuentas, switch entre ellas.
- `useXmppAccounts` hook con array de configs
- Cada cuenta se conecta independientemente
- Tab de cuentas para cambiar
**Esfuerzo:** 4h

### 3.2 Contact search
**Problema:** Lista plana de contactos sin búsqueda.
**Solución:** SearchBar en el roster que filtra por JID o nombre.
**Esfuerzo:** 1h

### 3.3 Markdown rendering en mensajes
**Problema:** Los mensajes se muestran como texto plano.
**Solución:** `MarkdownRenderer` (ya existe en el proyecto para LLM) aplicado a mensajes XMPP.
- **bold**, *italic*, `code`, ```code blocks```, [links](url)
**Esfuerzo:** 1h

---

## Resumen de esfuerzo

| Fase | Features | Horas est. |
|---|---|---|
| 1. Messenger | Foreground service, notificaciones, audio | 10h |
| 2. Paridad GTK | Agents, MUC, Settings | 11h |
| 3. Diferenciación | Multi-account, search, markdown | 6h |
| **Total** | | **27h** |

---

## Recomendación de orden
1. **Foreground service + notificaciones** (sin esto no es un messenger real)
2. **Mensajes de audio** (diferenciador clave vs otros clientes XMPP)
3. **Agent delegation** (el core del ecosistema NanoClaw)
4. **MUC + Settings + Search**
5. **Multi-account**
