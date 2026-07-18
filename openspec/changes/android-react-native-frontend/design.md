# Design

Use Expo's supported document/image selection surface and return a normalized
attachment (`uri`, MIME type, display name, optional size) to the existing chat
composer. The XMPP service remains the sole connection owner. Native Android
changes are allowed only when the Expo API cannot satisfy a verified platform
requirement; `android/` is versioned and must be reviewed as source code.

