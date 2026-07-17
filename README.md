# gtk-llm-chat-android

Compañero móvil de [gtk-llm-chat](https://gtk-llm-chat.fuentelibre.org/): un
cliente XMPP para Android, hecho con Expo (React Native), para chatear desde el
teléfono con los agentes de OpenClaw.

## Arquitectura

```
React Native (Expo)  ──WebSocket──>  servidor XMPP  <──  agentes OpenClaw
       │                             (Prosody)
       ├─ historial local (expo-sqlite) + MAM (XEP-0313)
       ├─ notificaciones push (XEP-0357 → Expo Push)
       └─ servicio nativo en primer plano (mantiene viva la conexión)
```

La app habla XMPP directamente: no hay backend propio ni base de datos
compartida con el escritorio. El archivo de mensajes vive en el servidor y se
recupera por MAM, así que el escritorio y el móvil ven la misma conversación
sin sincronizar ficheros.

XEPs implementadas: 0030 (disco), 0045 (MUC), 0050 (comandos ad-hoc), 0066
(OOB), 0084 (avatares), 0115 (caps), 0163 (PEP), 0184 (recibos), 0203 (delay),
0280 (carbons), 0308 (correcciones), 0313 (MAM), 0357 (push), 0363 (subida de
archivos).

## Desarrollo

```bash
npm install
npm start                      # Metro
adb reverse tcp:8081 tcp:8081  # si el teléfono va por USB
```

Ese flujo necesita la app ya instalada (Expo Go no sirve: la app usa sockets
TCP/TLS que su runtime no incluye). Para instalarla:

```bash
make reinstall-release   # check + build + install por adb
```

Recompilar sólo hace falta al tocar código nativo, permisos o Firebase; los
cambios de TypeScript entran en caliente por Metro.

## Verificar

```bash
make check   # type-check + lint + tests
```

## Compilar

```bash
npm run build:android   # EAS Build
```

## Notas para quien toque el código

Ver [AGENTS.md](AGENTS.md): recoge las trampas que ya nos han costado tiempo
(el `ver` de las caps que hay que subir a mano, los eventos PEP que sólo llegan
al publicar, el recurso XMPP estable, y por qué `android/` se versiona).

## Licencia

GPL-3.0-or-later
