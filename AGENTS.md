# AGENTS.md — gtk-llm-chat-android

Mobile companion for gtk-llm-chat. Android React Native app with embedded Python
backend (Chaquopy).

## Architecture

```
app/           → Expo Router (file-based routing)
  (tabs)/      → Bottom tab navigator (Chats, Settings)
  conversation/[cid].tsx → Chat screen with streaming
src/
  types/       → Domain types (Conversation, Message, ModelInfo, etc.)
  api/         → REST + WebSocket client for the Python backend
  hooks/       → useChatStream (WebSocket streaming hook)
  components/  → MessageBubble, ConversationCard, ModelSelector, MarkdownRenderer
  constants/   → Dark theme colors
python/
  server.py    → FastAPI server (HTTP + WebSocket)
  headless_llm_client.py → Adapted LLMClient (no GTK/GObject)
  android_keys.py → Read API keys from env vars
  vendored/    → Vendored pure-Python modules from gtk-llm-chat
```

## Stack

- Expo SDK 52 + Expo Router v4
- TypeScript strict mode
- Dark theme only (`#0A0E14` background)
- Python backend: FastAPI + uvicorn + llm

## Rules

- TypeScript strict mode is on. No `any`.
- All API calls go through `src/api/client.ts`.
- API keys stored in expo-secure-store, passed to Python via env vars.
- The WebSocket protocol follows the design in `specs/006-.../design.md`.
- Vendored Python files include a header pointing to the source gtk-llm-chat
  commit.

## References

- gtk-llm-chat docs: `../gtk-llm-chat/docs/architecture.md`
- gtk-llm-chat data model: `../gtk-llm-chat/docs/data-model.md`
- Spec (this project): `../gtk-llm-chat/specs/006-android-react-native-frontend/`
- Odisea_Dashboard template: `../Odisea_Dashboard/`
