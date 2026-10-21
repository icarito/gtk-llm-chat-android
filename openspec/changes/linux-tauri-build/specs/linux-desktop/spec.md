## ADDED Requirements

### Requirement: Open brain links in the system browser
The desktop client SHALL open HTTPS brain links from both the agent strip and mind panel in the system default browser without navigating the chat webview.

#### Scenario: Open the agent brain
- **WHEN** the user clicks either brain link in the Tauri client
- **THEN** the HTTPS URL is handed to the system browser and the chat remains open.

### Requirement: Linux development and standalone build
The project SHALL provide commands to launch the shared app in Tauri on Linux and produce an executable with embedded web assets.

#### Scenario: Desktop development
- **WHEN** the developer runs the Linux development command
- **THEN** Tauri opens the Expo web frontend with local development reload support.

#### Scenario: Standalone startup
- **WHEN** the developer builds and launches the Linux executable without Metro
- **THEN** the account form and shared navigation load from bundled assets.

### Requirement: Persistent shared history
The desktop client SHALL use persistent native SQLite with the same cache schema, migrations and correction semantics as Android.

#### Scenario: Restart after recording a message
- **WHEN** a desktop message is cached and the client restarts
- **THEN** history reads the message from the same desktop database.

### Requirement: Explicit platform limits
The desktop client SHALL avoid Android-only startup actions and SHALL preserve the upstream OMEMO 2 backend and controls. Legacy OMEMO remains limited to its supported platform.

#### Scenario: Desktop OMEMO 2 storage
- **WHEN** the user opens settings on Linux
- **THEN** the shared OMEMO 2 controls remain available.

### Requirement: Protected OMEMO 2 storage key
The desktop client SHALL store the OMEMO 2 database key in the OS Secret Service keyring and SHALL fail explicitly if that keyring is unavailable, without storing the key in web storage.

#### Scenario: Restart with an existing identity
- **WHEN** the desktop client restarts with a previously initialized OMEMO 2 store
- **THEN** it retrieves the same key from the keyring and decrypts the existing values.
