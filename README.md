# gtk-llm-chat-android

Mobile companion for [gtk-llm-chat](https://gtk-llm-chat.fuentelibre.org/), built
with Expo (React Native) and an embedded Python backend via Chaquopy.

Chat with LLMs from your Android phone using the same `logs.db` and LLM
configuration as your desktop app.

## Architecture

```
React Native (Expo) UI  ←→  Python FastAPI server (Chaquopy)
    WebSocket + REST           |
                               ├─ llm (Simon Willison)
                               └─ logs.db (shared with desktop)
```

## Development

```bash
npm install
npx expo start
```

The Python backend must be running separately during development:

```bash
cd python
pip install -r requirements.txt
python server.py    # starts on port 8765
```

## Building

```bash
npm run build:android   # EAS Build
```

Requires Chaquopy Gradle plugin configured in `android/build.gradle`.
See [docs/chaquopy-setup.md](docs/chaquopy-setup.md) for detailed setup.

## Syncing with Desktop

The mobile app reads/writes the same `logs.db` as the desktop app. Use
[Syncthing](https://syncthing.net/) or another file sync tool to share the
database between devices.

Set `LLM_USER_PATH` or use the in-app settings to configure a shared
directory.

## License

GPL-3.0-or-later
