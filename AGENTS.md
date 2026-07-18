# AGENTS.md — gtk-llm-chat-android

Cliente XMPP para Android, compañero móvil de gtk-llm-chat. Habla directamente
con el servidor XMPP (hablar.fuentelibre.org) para chatear con los agentes de
OpenClaw; no hay backend propio.

## Arquitectura

```
app/                       → Expo Router (rutas por fichero)
  (tabs)/xmpp.tsx          → Roster: contactos, presencia, avatares
  xmpp-chat/[jid].tsx      → Pantalla de chat
  _layout.tsx              → Layout raíz: fuentes, notificaciones, ruteo de push
src/
  xmpp/
    XmppService.ts         → Conexión única, viva todo el ciclo de la app.
                             Los componentes se suscriben; nunca son dueños de
                             la conexión.
    XmppContext.tsx        → Puente React del servicio
    XmppHistory.ts         → Caché local (expo-sqlite) + MAM
    notifications.ts       → Notificaciones locales + push XEP-0357
    shortcuts.ts           → Shortcuts de launcher por contacto (expo-quick-actions)
    presence.ts            → Color/etiqueta de presencia y nombre legible
    ForegroundService.ts   → Puente al servicio nativo
    xep-0004.ts            → Formularios de datos
    xep-0050.ts            → Comandos ad-hoc
    xep-0308.ts            → Corrección de mensajes
  constants/               → Tema oscuro
android/
  app/src/main/java/…      → Módulo nativo: foreground service del XMPP.
                             SE VERSIONA (ver más abajo).
```

## Stack

- Expo SDK 52 + Expo Router v4
- TypeScript en modo estricto (`any` prohibido)
- Tema oscuro (`#0A0E14`)
- `@xmpp/client` sobre WebSocket

## Trampas que ya nos han mordido

- **`android/` se versiona.** Este proyecto tiene código nativo propio, así que
  no se regenera entero desde `app.json`. El `.gitignore` sólo excluye lo que
  produce el build.
- **Los iconos salen de `app.json`**, no de editar `android/app/src/main/res/`
  a mano: un `prebuild` regenera ese directorio. El arte de `assets/` ya lleva
  su margen (Android sólo garantiza el 66% central del adaptive icon).
- **El `ver` de las caps XEP-0115 no es un SHA-1 real** (no hay SHA-1 en el
  bundle de RN): es un identificador opaco. Si cambias `CAPS_FEATURES`, **súbelo
  a mano** o el servidor, que cachea por `node#ver`, no volverá a preguntar y
  los features nuevos no se anunciarán. Falla en silencio.
- **Los eventos PEP sólo llegan cuando el contacto publica.** Telemetría y
  avatares necesitan además un *fetch* inicial (`fetchAgentTelemetry`,
  `fetchAvatar`), o un contacto que publicó antes de que nos conectáramos no se
  vería nunca.
- **El recurso XMPP lleva un sufijo estable por dispositivo**
  (`deviceResource.ts`). Con un sufijo aleatorio por arranque el servidor no
  reconoce la sesión anterior y la deja viva: llegamos a acumular 317 sesiones
  zombi, cada una recibiendo carbons y disparando push.
- **No leas la global `xmppClient` después de un `await`.** El auto-retry la
  pone a `null` al caer la conexión; captura la referencia antes.
- **Android 12+ prohíbe arrancar un foreground service desde background.** Sólo
  se inicia con la app en primer plano; si no, cada intento es denegado y
  alimenta un bucle.
- **La moduleResolution "node" del tsconfig base no lee `exports` de
  package.json.** Paquetes que sólo publican tipos por `exports` (p.ej.
  expo-quick-actions) necesitan un shim en `src/types/<paquete>.d.ts`; Metro
  sí los resuelve en runtime.
- **La selección de texto en burbujas se desmonta con cada re-render** de la
  FlatList (presencia/telemetría llegan todo el tiempo). El copiado confiable
  es el long-press de la burbuja (Clipboard + toast); `selectable` queda como
  extra para cuando sobrevive.

## Verificar

```
make check     # type-check + lint + tests
npm start      # Metro; con adb reverse tcp:8081 tcp:8081 por USB
make reinstall-release   # sólo si tocas código nativo, permisos o Firebase
```

## Referencias

- Cliente de escritorio: `../gtk-llm-chat/`
- Plugin XMPP de OpenClaw: `../claudio-w/extensions/xmpp/`
