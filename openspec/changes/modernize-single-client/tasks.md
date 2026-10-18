# Tasks

## F0 — Reactivar el repo
- [ ] Sacar `firebase-debug.log` y `google-services.json` de git y agregarlos a `.gitignore` (CI inyecta google-services desde un secret).
- [x] Deshabilitar `.github/workflows/build-android.yml` (solo `workflow_dispatch`).
- [ ] Actualizar `docs/xmpp-client-behavior.md` (bypass = comando `elevated`).
- [ ] Marcar `approval-bypass-command-fix` como reemplazado y corregir `voice-rich-message-parity` (markdown).
- [x] Crear el change `modernize-single-client`.

## F1 — Expo SDK 54/55 + New Architecture
- [ ] Migrar a CNG: `modules/xmpp-foreground` y `modules/omemo-legacy` como módulos locales con config plugins.
- [ ] Activar `newArchEnabled`.
- [ ] Reemplazar `expo-av` por `expo-audio` (`voiceRecorder.ts`, `AudioBubble`).
- [ ] Instalar reanimated, gesture-handler, keyboard-controller, safe-area-context >= 5; `adjustResize` en Android.
- [ ] Verificar `tsc`, jest, lint y build debug en Android e iOS (simulador) en CI.

## F2 — Refactor del backend
- [ ] `src/xmpp/connection.ts`: máquina de estados `DISCONNECTED/CONNECTING/SYNCING/ONLINE/RECONNECTING/AUTH_FAILED`, un solo backoff, XEP-0198 y watchdog de ping.
- [ ] Borrar las capas de reconexión redundantes.
- [ ] `src/xmpp/router.ts` y módulos: `mam`, `pep`, `commands`, `push`, `muc`, `upload`, `corrections`, `omemo/`.
- [ ] Store por conversación con `useSyncExternalStore`; `XmppContext.tsx` como envoltura delgada.
- [ ] Fases de arranque observables (TLS → SASL → roster → MAM) con Reintentar.
- [ ] Mantener tests existentes y agregar tests de la máquina de estados.

## F3 — UI de chat con `@kesha-antonov/react-native-chat`
- [ ] Adaptador `src/chat/toIMessage.ts` (envío con reintento, cifrado, `correctedAtMs`, adjuntos, audio, nick en grupos).
- [ ] Markdown, bloques de código con copiar y tablas (`markdownTables.ts`).
- [ ] `renderCustomView` para burbuja de tool y tarjeta de aprobación.
- [ ] Adjuntar, enviar/micrófono con mantener para grabar, barras de contexto/sync/desconexión.
- [ ] Indicador de escribiendo, historial anterior, nombres de usuario.
- [ ] `[jid].tsx` < 600 líneas; borrar `mergeMessages` y heurísticas sobrantes.

## F4 — Telemetría y PEP como xat
- [ ] `parseTelemetry` con payload completo (activity, availability, costos, session, scope).
- [ ] Nodos `urn:openclaw:hooks:{activity,approval,progress}:0` con `+notify` en caps.
- [ ] Store `agentState` por JID bare con `pendingApprovals(now)`.
- [ ] Tarjeta de aprobación (quick responses, cuenta regresiva, sello, hook adelantado).
- [ ] Mind panel (contexto, tokens, costo honesto, timeline de hooks, chips, doble toque).
- [ ] Indicador "pensando · tool" atado a `hooks:progress`.
- [ ] Revisión del verifier contra `xat/docs/reference/openclaw-xmpp.md`.

## F5 — Pulido JOE-82 y features de xat
- [ ] Pestañas Inicio·Flota·Salas·Yo, filtros del roster, tarjeta de agente compacta.
- [ ] Header con identidad/estado, búsqueda y chip de cifrado.
- [ ] Textos honestos ("mensaje cifrado", invitaciones humanizadas).
- [ ] MUC: join/autojoin con bookmarks, invitaciones, participantes Agentes/Personas, moderación básica.
- [ ] Reacciones (XEP-0444), replies (XEP-0461), retracción (XEP-0424).
- [ ] Autocompletado de `/` y `@`.

## F6 — OMEMO 2 en TypeScript
- [ ] Primitivas sobre `@noble/curves`, `@noble/hashes`, `@noble/ciphers` (incl. XEdDSA).
- [ ] X3DH, Double Ratchet y SCE (XEP-0420).
- [ ] Tests de interoperabilidad con vectores de twomemo/doubleratchet.
- [ ] Intercambio cifrado en ambas direcciones con xat contra Prosody real.
- [ ] UI de confianza: fingerprints, candado por burbuja, verificación de dispositivos.
- [ ] Auditoría del verifier; decidir retiro de `omemo-legacy`.

## F7 — Push y notificaciones
- [ ] Sacar el JID de push hardcodeado de `XmppService.ts` y dejarlo en config.
- [ ] iOS: `getExpoPushTokenAsync({projectId})`.
- [ ] Acciones con `opensAppToForeground: true`, encoladas hasta `ONLINE`.
- [ ] Foreground service de Android como ajuste opcional.

## F8 — CI: APK e IPA
- [ ] `pr-checks.yml`: agregar `expo prebuild` sin firma como smoke test.
- [ ] `release.yml` Android: prebuild → `assembleRelease bundleRelease`, firma por secrets, subir APK/AAB.
- [ ] `release.yml` iOS: prebuild → pod install → archive/export → `altool --upload-app`, IPA al release.
- [ ] Probar con tag `v0.2.0-rc1` (APK firmado + build en TestFlight).
