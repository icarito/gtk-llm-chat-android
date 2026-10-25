## 1. Núcleo Jingle TS puro

- [ ] 1.1 Definir `src/xmpp/jingle/types.ts` (namespaces XEP-0166/0167/0176/0320/0353, roles, acciones, estados, tipos de contenido) — ya presente, revisar y completar
- [ ] 1.2 Implementar `src/xmpp/jingle/session.ts`: máquina de estados de sesión (initiator/responder; pending/active/ended) con validación de acciones y razones de terminación
- [ ] 1.3 Implementar `src/xmpp/jingle/message.ts`: parseo/generación XEP-0353 (propose, accept, reject, ringing, retract, proceed)
- [ ] 1.4 Implementar `src/xmpp/jingle/transport.ts`: mapeo SDP↔XEP-0176/0320 (candidatos, ice-ufrag/pwd, fingerprint DTLS-SRTP) con `@xmpp/xml` Element
- [ ] 1.5 Definir/interfaz `src/xmpp/jingle/rtcBridge.ts` (createOffer/createAnswer/setLocal/setRemote/addIceCandidate/close + eventos) — ya presente, ajustar si hace falta

## 2. Tests unitarios del núcleo

- [ ] 2.1 Tests de parseo y generación de stanzas XEP-0166 y XEP-0353 (Element ↔ objetos del núcleo)
- [ ] 2.2 Tests de transiciones de estado de sesión (initiate→accept, terminate, rechazo, timeouts)
- [ ] 2.3 Tests de mapeo de candidatos ICE y fingerprint DTLS-SRTP (SDP↔XEP-0176/0320, incl. trickle)

## 3. Adaptador react-native-webrtc

- [ ] 3.1 Instalar `react-native-webrtc` y declararlo en `package.json` expres permisos/plugin en `app.json` (CNG: RECORD_AUDIO, INTERNET, MODIFY_AUDIO_SETTINGS)
- [ ] 3.2 Implementar `src/xmpp/jingle/webrtcAdapter.ts` como `rtcBridge` (RTCPeerConnection, getUserMedia audio, DTLS-SRTP, ICE/trickle, eventos de candidato local y stream remoto)
- [ ] 3.3 Deshabilitar la llamada en web/Tauri con gracia (sin botón o aviso; sin importar el adaptador nativo)

## 4. Cableado XMPP

- [ ] 4.1 En `src/xmpp/router.ts` despachar inbound `<iq>` Jingle y `<message>` jingle-message ANTES de los filtros chat/groupchat
- [ ] 4.2 Implementar `src/xmpp/jingle/manager.ts`: orquesta sesiones (por peer/sid), obtiene credenciales TURN (XEP-0215 o config) y notifica a la UI
- [ ] 4.3 Outbound vía `client.iqCaller` / `client.send`; integrar con `XmppService` el ciclo de vida de sesión

## 5. UI de llamada

- [ ] 5.1 Botón de llamada en AgentBar y/o header del chat (sólo Android/iOS)
- [ ] 5.2 Modal de llamada entrante (XEP-0353 propose) con aceptar/rechazar y estado ringing
- [ ] 5.3 Pantalla en llamada: estado (conectando/activa), temporizador, mute y colgar (session-terminate)
- [ ] 5.4 Supresión de notificaciones del contacto durante llamada activa y restauración al colgar

## 6. Integración y verificación

- [ ] 6.1 Ejecutar type-check, lint y tests (`make check`)
- [ ] 6.2 Build web export y verificación de deshabilitado con gracia de la llamada
- [ ] 6.3 Validación cruzada contra Dino (audio 1:1) en hablar.fuentelibre.org
