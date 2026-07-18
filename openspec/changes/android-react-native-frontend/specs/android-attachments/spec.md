## ADDED Requirements

### Requirement: Real attachment selection

The Android composer MUST select a local image or document and normalize its
URI, MIME type, display name and optional size for the existing XMPP media path.

#### Scenario: User selects an attachment

- **WHEN** the user chooses a supported local file
- **THEN** the composer shows a cancellable preview before sending

#### Scenario: User cancels selection

- **WHEN** the platform picker is dismissed or the preview is cancelled
- **THEN** no message is sent and the composer remains usable

### Requirement: Observable attachment delivery

The composer MUST expose upload progress and an actionable error without
creating a phantom successful message.

#### Scenario: Upload fails

- **WHEN** upload or XMPP media delivery fails
- **THEN** the attachment remains retryable and the failure is visible

