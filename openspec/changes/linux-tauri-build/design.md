## Context

Version 0.2.2 uses Expo SDK 57, a modular XMPP singleton and pure TypeScript OMEMO 2. These screens and services remain shared with Android/iOS.

## Goals / Non-Goals

**Goals:** Linux development with hot reload; a standalone executable embedding exported assets; persistent history using the same SQL and migrations.

**Non-Goals:** Porting the Android legacy OMEMO Java backend, mobile push delivery, launcher shortcuts or Android foreground service to desktop.

## Decisions

- Use Tauri 2 and the existing Metro web export, avoiding a second UI.
- A platform-resolved database adapter uses Tauri SQL on web and Expo SQLite on Android. Native SQL avoids WebKit SharedArrayBuffer/OPFS restrictions. History schema and migration ownership stay in XmppHistory.
- Android notification startup is skipped on web. Preserve the upstream OMEMO 2 UI and pure cryptographic core.
- OMEMO 2 uses the same database adapter; its storage key goes through narrowly scoped Rust commands to a Secret Service keyring, preserving the mobile encrypted-at-rest contract. Keyring failure must never trigger plaintext key storage or key replacement.
- Desktop account storage uses the existing AsyncStorage fallback, which is local webview storage and not an OS keyring. Document this testing-build limitation.
- Keep Rust build artifacts out of git; commit dependency lockfiles.

## Risks / Trade-offs

- Legacy OMEMO remains Android-only; the shared OMEMO 2 backend requires an unlocked desktop keyring and native-webview verification.
- Web attachment and media behavior differs from Android → document unverified capabilities and test core login/chat first.
- Linux system library requirements → document Rust/WebKitGTK prerequisites and executable location.
