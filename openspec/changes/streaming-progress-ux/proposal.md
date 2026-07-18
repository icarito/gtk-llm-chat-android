# Spec 011-A: Streaming, progress and approval UX (Android parity)

Android twin of gtk-llm-chat's `streaming-progress-ux` (spec 011): bring the
XMPP chat screen to the same live feel the GTK client and Telegram already
have, against the OpenClaw gateway on `hablar.fuentelibre.org`.

## Gap analysis (2026-07-18)

Already at parity before this change: XEP-0308 corrections parsing, approval
buttons + expiry + resolution clearing, agent status via PEP telemetry
(presence/tool), XEP-0084 avatars in roster, attachment picker (XEP-0363).

Missing, delivered by this change:

1. **In-memory correction application** — corrections only reached SQLite, so
   the gateway's streaming bubble (single XEP-0308 bubble that grows) never
   updated on screen until a history reload. Now the visible bubble updates
   live, tagged with `correctedAtMs`.
2. **Streaming affordance** — while a bubble keeps receiving corrections
   (6s window) it renders "in progress" (accent border + small spinner);
   final style when corrections stop.
3. **Chat states (XEP-0085)** — incoming `composing` renders "escribiendo…"
   (15s safety timeout); outgoing `composing`/`paused` emitted from the input
   (throttled 8s), `<active/>` attached to sent messages. Caps bumped to
   `v4-telemetry-avatar-chatstates` (manual `ver` trap).
4. **Avatar in chat header** — XEP-0084 cached avatar next to the contact
   name (fallback icon otherwise).
5. **Delivery states** — own messages track `pending → sent / failed`
   (socket accept / send error) with ✓/… glyphs and tap-to-retry.

## Bugfix folded in

Returning from an Android notification could enter a reconnect loop: the
screen's auto-connect effect re-fired `connect()` on every state flap with no
backoff, racing the AppState `reconnectIfNeeded` — each raw `connect()` tore
down the other's client mid-handshake and wiped the in-memory messages.
Fixed with an in-flight guard in `XmppService.connect()` (concurrent callers
coalesce) and a one-attempt-per-drop gate in the screen effect (service
backoff owns retries).
