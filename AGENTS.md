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
- **`selectable` en Text dentro de la FlatList de mensajes NO es confiable en
  Android.** Se probaron y descartaron, en orden: `onLongPress={() => {}}`
  vacío (bug de Fabric, no era la causa); sacar `nowTick` de las deps de
  `renderMessage`/extraData (necesario pero insuficiente — el remount de
  celdas por streaming no era la única causa); `GestureDetector` con
  `Gesture.Native()` y luego `.shouldActivateOnStart(true)` (el scroll de la
  FlatList seguía ganando la resolución de conflicto de todos modos). Cuatro
  intentos, cero resultado confirmado en dispositivo — la conclusión es que
  pelear por el mismo touch que la FlatList usa para scroll no es viable acá.

  **Solución adoptada y CONFIRMADA en dispositivo real**: un gesto DISTINTO.
  `MessageBubble` (app/xmpp-chat/[jid].tsx) envuelve cada burbuja con
  `Gesture.Pan()` + `activeOffsetX`/`failOffsetY` (mismo patrón que
  `stickyPanGesture`, ya probado ahí para la tarjeta de aprobaciones): un
  swipe lateral de más de `SWIPE_SELECT_THRESHOLD` px abre un Modal con el
  texto completo en un `TextInput` fuera de la FlatList, donde Android sí
  selecciona de forma confiable. Ojo con `editable={false}` en ese
  TextInput: deshabilita el focus del EditText nativo y con eso NO HAY
  selección tampoco — se usa `onChangeText={() => {}}` +
  `showSoftInputOnFocus={false}` en su lugar (de solo lectura para el
  usuario sin serlo para el componente nativo).

  **Efecto colateral que sí rompió algo real**: sacar `nowTick` de las deps
  de `renderMessage` dejó su closure con el `nowTick` CONGELADO del momento
  en que la función se creó — `isStreaming` (el borde/spinner de "burbuja en
  curso") se calculaba siempre contra ese valor viejo, así que una burbuja
  ya resuelta se quedaba pintada como "en curso" para siempre en vez de
  apagarse a los 6s. Fix: `nowTickRef` (useRef sincronizado con nowTick en
  cada render) leído dentro de `renderMessage` en vez del state directo —
  la ref sí se lee "en vivo" sin necesitar que React recree la función. Y
  como nada más le pedía a FlatList que repintara la celda cuando el
  streaming termina, `streamingActive` (booleano, cambia sólo 2 veces por
  turno) se agregó a `extraData` junto a `msgCount` — NO `nowTick` directo
  ahí, volvería a romper la selección.

- **Un `ScrollView horizontal` dentro de la FlatList de mensajes (inverted)
  rompe la altura de la celda en Android — no es `nestedScrollEnabled`, es
  el ScrollView en sí.** `MarkdownTableView` (app/xmpp-chat/[jid].tsx) lo
  usaba para el scroll horizontal de tablas anchas: la burbuja ocupaba casi
  toda la pantalla desde el primer render (no sólo al scrollear la lista).
  Primer intento — quitar sólo `nestedScrollEnabled` — CONFIRMADO SIN
  EFECTO en dispositivo real. La causa era el propio ScrollView. Reemplazado
  por `Gesture.Pan()` + `Animated.View` con `translateX` (mismo patrón que
  el swipe-para-seleccionar de MessageBubble): el ancho de la tabla se
  calcula de las columnas (determinístico, ver `TABLE_CELL_CHROME`), y el
  ancho del viewport se calcula de `useWindowDimensions` — NO con
  `onLayout` en el propio contenedor, porque su único hijo (la tabla, con
  `width` fijo) es lo que determina el tamaño natural del contenedor: medir
  el contenedor para decidir su propio ancho es circular. El gesto de la
  tabla se desactiva (`.enabled(maxScroll > 0)`) cuando la tabla cabe
  entera, para no competir con el gesto de MessageBubble que la envuelve.
  El bloque de código (ScrollView horizontal también, sin este problema)
  no tiene el mismo bug porque NO está dentro de una FlatList — vive
  directo en la burbuja, sin virtualización de lista de por medio.

- **`maxWidth` de la burbuja tiene que vivir en el hijo DIRECTO de
  `messageRow`, no más adentro.** `MessageBubble` (el GestureDetector +
  Animated.View del swipe-para-seleccionar, ver arriba) se intercala entre
  `messageRow` (flexDirection: row) y la burbuja. Si el `maxWidth: '82%'`
  vive en la burbuja (nieta de messageRow, hija de MessageBubble), se
  calcula contra el ancho ya encogido del wrapper — burbujas mucho más
  angostas que su techo real. Vive en `messageBubbleWrapper` (el
  Animated.View, hijo directo de messageRow) en su lugar; la burbuja usa
  `alignSelf: 'flex-start'` para encogerse a su contenido dentro de ese
  techo.

## Verificar

```
make check     # type-check + lint + tests
npm start      # Metro; con adb reverse tcp:8081 tcp:8081 por USB
make reinstall-release   # sólo si tocas código nativo, permisos o Firebase
```

## Flujo SDD

Los cambios nuevos nacen en `openspec/changes/`. Usa `opsx:explore` para
investigar, `opsx:propose` para crear el contrato, `opsx:apply` para ejecutar
`tasks.md`, y `opsx:archive` al terminar la verificación y el review. Una tarea
delegada no despliega ni hace push por cuenta propia.

## Referencias

- Cliente de escritorio: `../gtk-llm-chat/`
- Plugin XMPP de OpenClaw: `../openclaw-xmpp/` (consumido también como
  `../claudio-w/extensions/xmpp/`)
