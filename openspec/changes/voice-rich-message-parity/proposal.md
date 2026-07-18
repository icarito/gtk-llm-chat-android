## Why

The Android and desktop clients need the same rich-message behavior: real voice notes that remain audio attachments, readable Markdown tables, and reliable clipboard actions. The gateway already transcribes inbound audio, so client-side transcription or simulated recordings would duplicate responsibility and lose the original message.

## What Changes

- Record real voice notes, upload them through XEP-0363, and send the resulting URL as an XEP-0066 out-of-band attachment.
- Keep voice notes as first-class audio attachments in local and synchronized history, with duration, MIME type, delivery state, retry behavior, and integrated playback.
- Never synthesize recordings, invent transcription text, or replace the attachment with a client-generated transcript; the gateway receives the attachment URL and performs transcription.
- Render GitHub-style Markdown tables as structured, horizontally scrollable content instead of flattened text.
- Provide stable explicit copy actions for messages and code, plus an explicit paste action in the composer, without silently truncating pasted content.
- Preserve interoperability with the GTK client for common audio formats including M4A/AAC, Ogg/Opus, MP3, and WAV.

## Capabilities

### New Capabilities

- `voice-attachments`: Real audio capture, XMPP attachment delivery, durable history, error recovery, and in-message playback.
- `markdown-tables`: Structured and accessible rendering of Markdown tables within message bubbles.
- `clipboard-actions`: Reliable copy and paste affordances that survive frequent chat-list re-renders and report length constraints explicitly.

### Modified Capabilities

None.

## Impact

- Affects the Expo chat composer and message renderer, microphone permissions, media lifecycle, XMPP upload/OOB sending, and SQLite history metadata.
- Uses the supported Expo audio and clipboard APIs and retains the versioned native Android tree.
- Establishes a shared wire contract with `gtk-llm-chat`; no gateway transcription changes are required.
