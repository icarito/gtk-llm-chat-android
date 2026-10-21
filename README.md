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

## Linux (Tauri)

La misma interfaz y conexión XMPP de la versión 0.2.2 (Expo 57) pueden ejecutarse
en Linux con Tauri 2. Requiere Node 22.13 o posterior, npm, Rust/Cargo,
un compilador C, GTK 3, WebKitGTK 4.1 y las
dependencias de desarrollo de Tauri para tu distribución:
[prerrequisitos oficiales](https://v2.tauri.app/start/prerequisites/#linux).

```bash
npm install
make linux-dev     # ventana Tauri + Metro en localhost:8082, recarga en caliente
make linux-build   # exporta Expo web y compila el ejecutable con assets embebidos
make linux-run     # ejecuta el release; no necesita Metro
```

El ejecutable queda en `src-tauri/target/release/gtk-llm-chat-linux`.
El primer build descarga y compila las dependencias Rust. En Linux x86-64 se
usa `cc` como linker, sin depender del nombre del compilador de la distribución.

El historial usa SQLite nativo de Tauri con el mismo esquema y migraciones que
Android, en el directorio de configuración de la aplicación. Las credenciales
usan el fallback existente de AsyncStorage (almacenamiento local del webview,
sin integración con el llavero del sistema en este build de pruebas).

OMEMO 2 usa el núcleo TypeScript compartido. Su base SQLite permanece cifrada
y la clave se guarda en un llavero compatible con Secret Service (por ejemplo,
GNOME Keyring o KWallet), que debe estar disponible y desbloqueado. OMEMO
legacy conserva su backend exclusivo de Android. La interoperabilidad real
del cifrado desde Linux requiere validación con otra cuenta/dispositivo.
Push móvil, shortcuts y foreground service no se ejecutan en Linux;
voz y adjuntos requieren validación específica en WebKitGTK. Cerrar la ventana
termina el cliente; no hay servicio de escritorio en segundo plano.

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
