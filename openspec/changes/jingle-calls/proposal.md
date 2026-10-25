## Why

The Android client needs to interoperate 1:1 audio calls with Dino and other XMPP/Jingle clients. The server (hablar.fuentelibre.org) already runs coturn (STUN/TURN with shared secret) and Prosody turn_external (XEP-0215), so no server-side work is required: the whole feature is client-side signaling, media, and UI.

## What Changes

- Jingle signaling for 1:1 sessions: XEP-0166 (session management), XEP-0353 (in-band jingle-message initiation), XEP-0167 (RTP audio, Opus), XEP-0176 (ICE-UDP transport), and XEP-0320 (DTLS-SRTP).
- Media via `react-native-webrtc` (RTCPeerConnection, microphone capture, ICE/trickle, DTLS-SRTP).
- Call UI: a call button on the agent bar/chat header, an incoming-call modal (XEP-0353 propose), and an in-call screen with timer, mute, and hang-up.
- Phase 1 is audio 1:1 only; video and MUC calls are explicitly out of scope.

## Capabilities

### New Capabilities

- `audio-calls`: Initiate and receive 1:1 audio calls compatible with Dino, with signaling, media negotiation, and in-call controls.

### Modified Capabilities

None.

## Impact

- New dependency `react-native-webrtc`: a native module, so under the versioned Android tree flow it is declared in `package.json` and its permissions are wired through `app.json`/plugin (CNG), not hand-edited native projects.
- Stanza routing: `src/xmpp/router.ts` dispatches inbound `<iq>` (Jingle) and `<message>` (jingle-message) before the chat/groupchat filters; `src/xmpp/XmppService.ts` gains call session lifecycle awareness.
- Chat UI: AgentBar/header call button and call screens; call ability is disabled gracefully on web/Tauri.
- No server changes; TURN credentials come from XEP-0215 external service discovery or configuration.
