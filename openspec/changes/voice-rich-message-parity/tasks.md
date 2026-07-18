## 1. Dependencies, Permissions, and Persistence

- [x] 1.1 Confirm and configure the Expo SDK 52-supported audio recording/playback API and microphone permission without regenerating the versioned Android tree
- [x] 1.2 Add `expo-clipboard` through the Expo-compatible installer and replace deprecated React Native clipboard usage
- [x] 1.3 Extend SQLite message attachment metadata for audio URL, MIME type, duration, local retry URI, and delivery state with a backward-compatible migration
- [x] 1.4 Add audio MIME/extension recognition for M4A/AAC, Ogg/Opus, MP3, and WAV with unit tests

## 2. Real Voice Capture and Sending

- [x] 2.1 Implement explicit idle, holding, locked, cancelling, captured, uploading, failed, and sent recording states
- [x] 2.2 Build hold-to-record, slide-to-cancel, lock, stop, retry, and discard composer interactions with permission and interruption feedback
- [x] 2.3 Record real M4A/AAC media, measure duration, upload through XEP-0363, and send the URL through XEP-0066 without client transcription or simulated fallback
- [x] 2.4 Preserve a failed local recording for retry, clean files after success/discard, and release recorder resources on backgrounding or unmount
- [x] 2.5 Add tests for permission denial, cancellation, interruption, successful OOB send, failed upload/retry, and prohibition on transcript substitution

## 3. Voice Playback

- [x] 3.1 Add a memoized audio bubble with play, pause, progress, duration, loading, failure, and retry states
- [x] 3.2 Restore audio bubbles from SQLite/MAM and isolate their state from presence and telemetry list re-renders
- [x] 3.3 Unload playback objects on completion, source change, and unmount and test supported peer formats

## 4. Markdown Tables

- [x] 4.1 Integrate `react-native-markdown-display` into the message body while retaining custom copyable fenced-code rendering
- [x] 4.2 Add styled table rules with a horizontal `ScrollView`, bounded cells, header distinction, and accessible text
- [x] 4.3 Add renderer tests for mixed prose/code/tables, malformed tables, wide tables, list re-renders, and XEP-0308 corrections

## 5. Clipboard and Paste

- [x] 5.1 Add stable long-press message actions with Copy confirmation and preserve dedicated code-block copying
- [x] 5.2 Add an explicit composer Paste action that inserts at the current selection/cursor
- [x] 5.3 Define and test over-limit paste behavior so complete content is accepted or explicitly rejected, never silently truncated
- [x] 5.4 Add accessibility labels and tests for copy, code-copy, paste, empty clipboard, and frequent list re-renders

## 6. Verification and Interoperability

- [x] 6.1 Run `make check` and the relevant Android build/reinstall verification for permission or native configuration changes
- [x] 6.2 Verify Android-to-GTK and GTK-to-Android playback for representative supported formats
- [x] 6.3 Verify an audio OOB message reaches the gateway as media for gateway-side transcription while the original attachment remains visible in history