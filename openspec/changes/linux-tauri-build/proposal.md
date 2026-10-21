## Why

Enable local Linux testing of the mobile client's shared UI and XMPP behavior without rebuilding Android.

## What Changes

- Package the existing Expo web UI in Tauri 2 with development and release commands.
- Adapt history storage and Android-only integrations for the Linux webview.
- Document desktop limitations and verification steps.

## Capabilities

### New Capabilities
- `linux-desktop`: Linux development, offline-packaged frontend, persistent chat cache and explicit native-feature limits.

### Modified Capabilities
None.

## Impact

Adds Rust/Tauri sources and npm dependencies; updates platform adapters and developer documentation on top of upstream 0.2.2. Android/iOS retain the upstream CNG workflow; the shared OMEMO 2 core is preserved.
