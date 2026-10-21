## 1. Desktop shell

- [x] 1.1 Add Tauri sources, dependencies and development/release commands.
- [x] 1.2 Export the existing Expo web frontend successfully.

## 2. Platform integration

- [x] 2.1 Bridge desktop history to native SQLite without changing history semantics.
- [x] 2.2 Skip mobile startup actions and preserve upstream OMEMO 2 controls.
- [x] 2.3 Support web avatar rendering without the Android filesystem.
- [x] 2.4 Bridge the OMEMO 2 SQLite store and protect its key in the desktop keyring.
- [x] 2.5 Open both agent brain links in the system browser and verify the native handoff.

## 3. Verification

- [x] 3.1 Run project checks and focused OMEMO/history regression tests.
- [x] 3.2 Build and launch the 0.2.2 Linux executable; capture the UI and verify history and encrypted-store persistence.
- [x] 3.3 Document commands, prerequisites, platform limitations and results.
- [ ] 3.4 User confirms desktop screenshot and real-account chat behavior.

Upstream synchronization: main fast-forwarded from 60fc756 to 3ea7959
(66 commits, app version 0.2.2). Local Tauri work was saved in
`tauri-linux-before-sync-0.2.2` stash and reapplied; upstream service modularity,
CNG and OMEMO 2 supersede assumptions from the initial desktop prototype.
Focused history/OMEMO 2 store/roundtrip tests pass (13 tests).
`make check` passes on the merged code (21 tests plus type-check and lint).
The 0.2.2 release builds successfully. Native WebKitGTK verifies styled login
with all four tabs, modernized chat mounting offline, shared settings,
history deduplication/corrections across restart, and OMEMO 2 encrypted storage
and key recovery across restart using an isolated D-Bus/Secret Service keyring.
Captures: `/tmp/gtk-chat-linux-native.png`, `/tmp/gtk-chat-linux-settings.png`,
`/tmp/gtk-chat-linux-chat.png`.
Real-account login/chat, attachments and voice remain unverified.

Brain links: type-check, lint and 10 targeted link/panel tests pass. The release
was rebuilt with Tauri Opener. Native WebKitGTK clicks on the strip icon and
mind-panel link both reached an isolated xdg-open probe with the complete
HTTPS URL (query/fragment preserved); the chat webview stayed on its route.
The user's actual browser association still requires their confirmation.
