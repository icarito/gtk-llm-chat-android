## ADDED Requirements

### Requirement: Real voice capture
The client SHALL request microphone permission and capture microphone input into a real audio file, and SHALL NOT simulate audio or generate transcription text.

#### Scenario: User completes a recording
- **WHEN** the user completes a hold-to-record or locked recording interaction
- **THEN** the client produces a playable audio attachment with measured duration and MIME type

#### Scenario: Recording is cancelled or denied
- **WHEN** the user slides to cancel or microphone access fails
- **THEN** the client sends no attachment or substitute text and reports failure when appropriate

### Requirement: Standard XMPP audio delivery
The client SHALL upload voice recordings through XEP-0363 and send the resulting URL as an XEP-0066 attachment for gateway-side transcription.

#### Scenario: Voice note sends successfully
- **WHEN** capture and upload complete
- **THEN** the outgoing stanza contains the uploaded audio URL as OOB data and history retains its audio metadata

#### Scenario: Upload fails
- **WHEN** upload cannot complete
- **THEN** the client preserves the local recording for retry or explicit discard and does not report delivery

### Requirement: Integrated voice playback
The client SHALL render sent and received audio attachments as voice-note controls supporting playback, pause, progress, duration, and retry.

#### Scenario: History contains an audio attachment
- **WHEN** a conversation restores a supported audio URL
- **THEN** the message appears as a playable voice note without mandatory predownload

#### Scenario: Peer sends a supported format
- **WHEN** an attachment uses M4A/AAC, Ogg/Opus, MP3, or WAV
- **THEN** the client recognizes it as audio and attempts integrated playback
