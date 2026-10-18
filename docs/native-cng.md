# Native code y CNG (Continuous Native Generation)

`android/` e `ios/` NO se versionan: `npx expo prebuild --clean` los regenera.
Toda personalización nativa vive en `app.json`/`app.config.js`, config plugins
(`plugins/`) o módulos Expo locales (`modules/`).

## Inventario del `android/` anterior (SDK 52) y dónde vive ahora

| Personalización | Ahora |
| --- | --- |
| Permisos `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC`, `WAKE_LOCK`, `POST_NOTIFICATIONS` | `modules/xmpp-foreground/android/src/main/AndroidManifest.xml` (se fusiona) |
| `<service .XmppForegroundService foregroundServiceType=dataSync>` | ídem |
| `XmppForegroundService.java` + `XmppServiceModule.kt` + `XmppServicePackage.kt` | `modules/xmpp-foreground` (módulo Expo, Kotlin; stub no-op en iOS) |
| `XmppOmemoModule.kt` + dependencia `signal-protocol-android:2.8.1` | `modules/omemo-legacy` (sólo Android; en iOS JS cae a modo mock) |
| `packages.add(XmppServicePackage())` en MainApplication | Eliminado: autolinking de módulos Expo |
| MainActivity | Sin cambios reales (sólo código generado por expo-splash-screen) |
| `windowSoftInputMode=adjustResize` | `android.softwareKeyboardLayoutMode: "resize"` |
| Permisos `ACCESS_NETWORK_STATE`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `VIBRATE` | `android.permissions` en `app.json` |
| `res/xml/network_security_config.xml` (cleartext hablar.fuentelibre.org + Metro) | `plugins/withNetworkSecurityConfig.js` |
| Plugin `com.google.gms.google-services` + classpath | `googleServicesFile` en `app.config.js` si existe `./google-services.json` |
| Fondo/imagen del splash, `colors.xml` | plugin `expo-splash-screen` en `app.json` |
| minSdk 29 | `expo-build-properties` (compile/target SDK ahora los define el SDK de Expo) |
| Esquema `org.fuentelibre.gtk_llm_chat` en el intent-filter | `scheme` (array) en `app.json` |
| `newArchEnabled` | `app.json` (`true`; en SDK 57 la New Architecture es la única) |
| Iconos (`mipmap-*`) | `assets/` + `app.json` (ya era así) |
| `src/debug/AndroidManifest.xml` (cleartext, SYSTEM_ALERT_WINDOW) | Lo genera el template de prebuild |
| `lint { disable ... }`, `extraMavenRepos`, `enableJetifier` | Descartados (sin efecto necesario) |

iOS: `ios.infoPlist` lleva el permiso de micrófono y `UIBackgroundModes: ["remote-notification"]`.

## Flujo

```
npx expo prebuild --clean --no-install -p android   # regenera android/
cd android && ./gradlew assembleDebug
```

- Cambios en `modules/**` o `plugins/**` requieren volver a correr prebuild.
- Firebase: copia `google-services.json` a la raíz del repo ANTES del prebuild
  (`make prepare-fcm`; en EAS lo hace `eas-hooks/write-google-services.sh`).
- JS de los módulos nativos: `requireOptionalNativeModule('XmppServiceModule' | 'XmppOmemoModule')`
  (`src/xmpp/ForegroundService.ts`, `src/xmpp/xep-0384.ts`); devuelve `null` si no existe.
