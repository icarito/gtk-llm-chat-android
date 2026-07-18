## Context

The Android client already has generic XEP-0363/XEP-0066 uploads and `expo-av`, but messages are rendered primarily as plain React Native text. Clipboard access uses the deprecated React Native API, and native text selection is unreliable because presence and telemetry frequently re-render the list. Voice messages must remain attachments because the gateway already downloads and transcribes their OOB URL.

## Goals / Non-Goals

**Goals:**

- Record and play real voice notes with Telegram-style hold, cancel, and lock affordances.
- Share the same XMPP audio contract and history semantics as GTK.
- Add table rendering and deterministic copy/paste actions.

**Non-Goals:**

- On-device or client-side transcription, fake recordings, or invented transcript messages.
- Gateway changes or a custom voice-message stanza.
- Regenerating the versioned Android native project wholesale.

## Decisions

1. **Use XEP-0363 plus XEP-0066.** Recording produces an audio file, the existing uploader returns a URL, and the sent stanza exposes it as OOB media for the gateway. SQLite stores URL, MIME type, duration, local retry URI, and delivery state.
2. **Use the supported Expo recording/playback API available to SDK 52.** Record M4A/AAC on Android for dependable native encoder support and accept M4A/AAC, Ogg/Opus, MP3, and WAV for playback. Audio objects are unloaded when bubbles unmount or playback changes.
3. **Model recording explicitly.** Idle, holding, locked, cancelling, captured, uploading, failed, and sent states prevent gesture races. Permission or recorder failure is visible and never falls back to simulated media.
4. **Use `react-native-markdown-display` for Markdown structure with custom table rules.** Tables live in a horizontal `ScrollView`; existing code-block copy behavior is retained through custom render rules.
5. **Use `expo-clipboard` and explicit actions.** Long-press opens stable message actions including Copy; code keeps a dedicated Copy control; the composer exposes Paste. Content over the composer limit is never silently truncated—it is accepted if the limit is raised or rejected with an explicit warning.

## Risks / Trade-offs

- [Android permission and audio-focus behavior differs by OS version] → Test denial, interruption, backgrounding, and resume paths on supported API levels.
- [Frequent list updates can reset player or selection state] → Key media state by message ID and isolate memoized rich-message components from telemetry updates.
- [Remote URL or upload expires/fails] → Preserve retry state and show a recoverable error without blocking history.
- [Markdown render changes could regress code blocks] → Add renderer tests for mixed prose, code, and tables before replacing the current splitter.

## Migration Plan

Add nullable SQLite attachment columns or a versioned metadata payload with migration defaults, introduce clipboard and microphone configuration, then enable rich rendering. Old messages continue as text/generic attachments. Rollback degrades voice notes to ordinary OOB links without changing the gateway.

## Open Questions

- During implementation, confirm whether the SDK 52-compatible audio API remains `expo-av` or warrants a scoped migration; do not change SDK or native project structure solely for this feature.
