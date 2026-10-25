## Context

The client is an Expo/React Native XMPP app (XmppService keeps a single connection; components subscribe, they never own it). The server already provides coturn (STUN/TURN with secret) and XEP-0215 via Prosody turn_external. Dino supports XEP-0166/0167/0176/0320/0353, and the same XEPs are already stubbed in `src/xmpp/jingle/` (`types.ts`, `rtcBridge.ts`), so the remaining work is the state machine, stanza codec, transport mapping, and the WebRTC adapter.

## Goals / Non-Goals

**Goals:**

- 1:1 audio calls interoperable with Dino: XEP-0353 propose/accept/reject, XEP-0166 session-initiate/session-accept/transport-info/session-terminate.
- Media over ICE-UDP (trickle) with DTLS-SRTP, Opus audio.
- Clear UI states (ringing, connecting, active, ended/error) with mute, timer, and hang-up.
- Pure-TS signaling core that is unit-testable without a device.

**Non-Goals:**

- Video calls and MUC calls (later phases).
- Server changes: coturn and turn_external already exist.
- Regenerating native projects by hand; native pieces go through CNG (`package.json` + `app.json`/plugin).

## Decisions

1. **Pure TS core in `src/xmpp/jingle/`.** `types.ts` (already present) defines XMPP namespaces and session types; `rtcBridge.ts` (already present) is the media engine interface. New files:
   - `session.ts`: Jingle session state machine (initiator/responder, pending/active/ended) with action validation and reason handling.
   - `message.ts`: XEP-0353 jingle-message parse/generation (propose, accept, reject, ringing, retract, proceed).
   - `transport.ts`: SDP↔XEP-0176/0320 mapping (candidates, ice-ufrag/pwd, DTLS-SRTP fingerprint), building `@xmpp/xml` `Element`s and parsing inbound ones.
   - `manager.ts`: orchestrates sessions, owns the RtcBridge wiring, and notifies the UI.
2. **`rtcBridge.ts` is implemented by `src/xmpp/jingle/webrtcAdapter.ts`** using `react-native-webrtc`: RTCPeerConnection, `getUserMedia` audio, local candidate events → XEP-0176 transport-info, remote candidates → `addIceCandidate`, and DTLS-SRTP over ICE.
3. **Routing.** `src/xmpp/router.ts` dispatches inbound `<iq type="set">` with `<jingle>` and `<message>` with `<jingle-message>` (XEP-0353) *before* the chat/groupchat filters; outbound stanzas go through `client.iqCaller` / `client.send`. `manager.ts` is registered with the service and resolves sessions by (peer, sid).
4. **UI.** Call button on the agent bar (AgentBar) and/or chat header; incoming XEP-0353 propose shows a modal (accept/decline, with ringing); in-call screen shows timer, mute, and hang-up (session-terminate). On web/Tauri the action is disabled gracefully (no button or a notice).
5. **TURN credentials** are fetched via XEP-0215 external service discovery (`urn:xmpp:extdisco:2`, `stun`/`turn` services) or fall back to configuration.

## Risks / Trade-offs

- [Native module adds build/permission surface on Android] → Declare `react-native-webrtc` in `package.json` and permissions (RECORD_AUDIO, INTERNET, MODIFY_AUDIO_SETTINGS) via `app.json`/plugin; verify with a CNG prebuild (no hand-edited native tree).
- [Interop details with Dino (fingerprint setup, trickle timing, reason codes) can differ] → Validate against Dino on the real server; keep media/state errors mapped to XEP-0166 reasons (e.g. `connectivity-error`).
- [Call state vs. app lifecycle / multi-device pushes] → The active call suppresses notifications for that contact and restores them on hang-up; terminate session on connectivity loss so it never hangs.
- [Web/Tauri lack react-native-webrtc parity] → Gate the adapter import; UI hides/disables call affordances outside Android/iOS.

## Migration Plan

Add `react-native-webrtc` via the Expo-compatible installer and update `app.json` permissions/plugin; introduce the jingle module behind the router dispatch; ship UI behind the `audio-calls` capability. No server migration. Rollback removes the dependency, the dispatch, and the UI affordances without touching history.

## Open Questions

- Confirm Dino's exact DTLS `setup` role expectations and whether `proceed` is used for call pickup vs. direct `accept`.
- Decide whether TURN discovery is required or configuration fallback is acceptable for phase 1.
