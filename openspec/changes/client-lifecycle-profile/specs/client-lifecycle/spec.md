## ADDED Requirements

### Requirement: Automatic initial connection

The Android client MUST begin or recover XMPP connection when secure account
loading settles, without requiring navigation or an AppState transition.

#### Scenario: Cold start with stored credentials

- **WHEN** the provider receives a stored account after launch
- **THEN** it begins connection once and reports each lifecycle phase

### Requirement: Interactive startup communication

The native splash MUST hand off to an interactive surface that names connection
and roster phases and offers recovery actions.

#### Scenario: Roster synchronization fails

- **WHEN** authentication succeeds but roster loading fails
- **THEN** the client explains the partial state and offers retry

### Requirement: Editable self profile

The Android client MUST expose the user's presence/status and supported vCard
fields through one profile screen.

#### Scenario: Profile write fails

- **WHEN** a presence or vCard update is rejected
- **THEN** the previous value is restored and the error is actionable

