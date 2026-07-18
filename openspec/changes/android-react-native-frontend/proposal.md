# Android React Native frontend

## Origin and current scope

This change supersedes gtk-llm-chat spec 006. The implemented product differs
from its early Chaquopy design: it is now a native Android companion that talks
directly to OpenClaw agents over XMPP, using Expo/React Native and no embedded
Python backend.

The application scaffold, routing, strict TypeScript setup, dark UI, persistent
XMPP service, roster, direct chat, history, notifications, telemetry, avatars,
XEP-0050 forms and the versioned foreground service are implemented.

## Remaining outcome

Users MUST be able to choose a real local attachment from Android, preview or
cancel it, send it through the existing XMPP upload/media path, and see a clear
failure state. Permission denial and cancellation MUST leave the composer
usable and MUST NOT send a phantom message.

## Non-goals

- Reintroducing the original Chaquopy/LLM backend design.
- iOS support.
- Reworking desktop attachment UI.

