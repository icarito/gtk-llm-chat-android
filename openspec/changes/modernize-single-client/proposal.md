# Modernizar y dejar un solo cliente (Android + iOS)

## Por qué

Hoy hay tres clientes: gtk-llm-chat (GTK), gtk-llm-chat-android (Expo) y xat
(Godot). Se mantendrá uno solo. La UI de xat es poco usable y Prose no sirve en
móvil; este repo (Expo/RN) da componentes nativos y un mismo código para
Android, iOS y web. Está quieto desde el 26/07, en Expo SDK 52 con la
arquitectura vieja, con un chat hecho a mano (`app/xmpp-chat/[jid].tsx`, ~2.5k
líneas, sin markdown real) y un `XmppService.ts` monolítico (~2.9k líneas).

## Qué cambia

- **F0** Reactivar el repo: sacar secretos/logs de git, deshabilitar `build-android.yml`, alinear docs y openspec, crear este change.
- **F1** Expo SDK 54/55 + New Architecture, CNG con módulos locales (`xmpp-foreground`, `omemo-legacy`), `expo-audio`.
- **F2** Refactor del backend sin cambio de comportamiento: `connection.ts` (máquina de estados), `router.ts`, módulos por XEP, store por conversación.
- **F3** UI de chat sobre `@kesha-antonov/react-native-chat` 5.x con adaptador `toIMessage`; `[jid].tsx` < 600 líneas.
- **F4** Telemetría y PEP al nivel de xat: hooks `activity/approval/progress`, store `agentState`, tarjeta de aprobación, mind panel.
- **F5** Pulido JOE-82: navegación por pestañas, MUC (join, bookmarks, moderación), reacciones, replies, retracción, autocompletado.
- **F6** OMEMO 2 en TypeScript puro (X3DH, Double Ratchet, SCE) con UI de confianza.
- **F7** Push y notificaciones: Expo Push con JID en config, acciones que esperan a `ONLINE`.
- **F8** CI en GitHub Actions: `pr-checks` con prebuild smoke, `release.yml` (APK/AAB firmados + IPA a TestFlight).

## Impacto

- Dependencias: Expo SDK 54/55 con New Architecture, `@kesha-antonov/react-native-chat` 5.x (+ reanimated, gesture-handler, keyboard-controller, safe-area-context >= 5), `@noble/curves`, `@noble/hashes`, `@noble/ciphers`.
- Generación nativa (CNG): `android/` e `ios/` se generan con `expo prebuild`; los módulos nativos pasan a módulos locales de Expo con config plugins.
- CI con GitHub Actions sin EAS; push vía Expo Push (`mod_expo_push`).
- Acciones del usuario (fuera del alcance de los agentes): App ID `org.fuentelibre.gtk-llm-chat`, provisioning profile y registro en App Store Connect; copiar secrets desde `icarito/xat`; secret de google-services; clave APNs en Expo.

## Decisiones

- **Backend: refactorizar `@xmpp/client`, no reemplazar por libstrophe.** En iOS ninguna conexión (nativa o JS) sobrevive en segundo plano; todo depende del push del servidor (XEP-0357), que ya existe. libstrophe solo ayudaría en Android, donde el foreground service ya mantiene vivo el proceso JS, y obligaría a dos módulos nativos (Kotlin y Swift) y a perder la web. El problema real es la forma del código (monolito, tres capas de reconexión, copia del Map en cada cambio, regex sobre texto del gateway), y eso se resuelve partiendo en módulos (F2).
- OMEMO 2 se porta ahora a TS; OMEMO legacy queda solo para descifrar en Android hasta decidir su retiro.
- Fuera de alcance: bug de `mod_fcm_push` (`tag` debe ir en `android.notification`), retiro de clientes viejos, validación de web/escritorio.

## Supersede

Este change absorbe:

- `streaming-progress-ux`: streaming/progreso pasa a F3/F4.
- `client-lifecycle-profile`: las fases de arranque (TLS → SASL → roster → MAM, con Reintentar) pasan a F2; perfil/vCard a F5.
- `voice-rich-message-parity`: el markdown real pasa a F3.
- `approval-bypass-command-fix`: superado por el comando `elevated`.
