# CI — build y publicación (Android / iOS)

`.github/workflows/release.yml` construye y publica **gtk-llm-chat-android**
sin EAS Build. El proyecto adopta **Continuous Native Generation (CNG)**:
`android/` e `ios/` no se versionan y se generan en cada corrida con
`npx expo prebuild`. No hay ningún paso de EAS.

Disparadores:

- **push de tags `v*`** → APK + AAB firmados, IPA y (si hay API key) subida a
  TestFlight. Los archivos se adjuntan al GitHub Release del tag.
- **`workflow_dispatch`** → igual, sobre la rama/ref elegida.

`build-android.yml` quedó deshabilitado; `release.yml` lo reemplaza.

## Qué hace cada job

### `android` (`ubuntu-latest`)

1. `actions/checkout` + Node 20 (cache npm) + JDK 17 (temurin).
2. `npm ci`.
3. Si existe `GOOGLE_SERVICES_JSON_B64`, escribe `google-services.json` **antes**
   del prebuild. `app.config.js` agrega `android.googleServicesFile` sólo si el
   archivo existe, así que el orden importa.
4. `npx expo prebuild -p android --no-install`.
5. Decodifica `ANDROID_KEYSTORE_B64` a `android/app/release.keystore` y falla con
   `::error::` si falta alguno de los tres secretos Android (no hay fallback a
   debug: el objetivo es un artefacto publicable).
6. `./gradlew assembleRelease bundleRelease` pasando la firma con las
   propiedades inyectadas de Gradle:

   ```
   -Pandroid.injected.signing.store.file=<keystore>
   -Pandroid.injected.signing.store.password=<ANDROID_KEYSTORE_PASS>
   -Pandroid.injected.signing.key.alias=<ANDROID_KEY_ALIAS>
   -Pandroid.injected.signing.key.password=<ANDROID_KEYSTORE_PASS>
   ```

7. Copia el `.apk` y el `.aab` a `dist/`, los sube como artefacto y, en tags
   `v*`, los adjunta al Release.

### `ios` (`macos-latest`)

Un primer paso (**Check iOS signing availability**) inspecciona los secretos y
publica `skip` / `testflight` como outputs. `secrets` no está disponible en un
`if`, así que **todos los pasos siguientes** llevan
`if: steps.gate.outputs.skip != 'true'`. Si faltan los secretos de firma el job
termina **en verde** con un `::warning::` claro; no falla.

Con secretos:

1. Node 20 + `npm ci`.
2. `npx expo prebuild -p ios --no-install` y `pod install` en `ios/`.
3. Importa `IOS_CERT_P12_B64` a un **keychain temporal** (`app-signing.keychain-db`
   en `$RUNNER_TEMP`), lo pone primero en la lista y como default.
4. Instala `IOS_PROVISION_B64` en `~/Library/MobileDevice/Provisioning Profiles`
   y lee del perfil, con `security cms -D` + `PlistBuddy`:
   `TeamIdentifier:0`, `Name` y `UUID`.
5. Genera `ExportOptions.plist` con `method=app-store`, `signingStyle=manual`,
   `teamID` y `provisioningProfiles` mapeando
   `org.fuentelibre.gtk-llm-chat` → nombre del perfil.
6. Detecta el workspace generado con `ls -d ios/*.xcworkspace` (el nombre sale
   del `name` de `app.json`) y el scheme con `xcodebuild -list -json` (fallback:
   nombre del workspace). Hace `xcodebuild archive` y `xcodebuild -exportArchive`.
7. Sube el IPA con `xcrun altool --upload-app` usando la API key: escribe
   `~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8` desde el secreto y la
   borra al salir del paso.
8. Sube el `.ipa` como artefacto y, en tags `v*`, lo adjunta al Release.

## Número de build (requisito en `app.config.js`)

El workflow exporta `BUILD_NUMBER=${{ github.run_number }}` a nivel de workflow.
**`app.config.js` debe leerlo** y mapearlo a:

```js
// app.config.js — NO lo edita el CI; es un requisito del proyecto.
const buildNumber = Number(process.env.BUILD_NUMBER || 0);

module.exports = () => ({
  ...appJson.expo,
  android: {
    ...appJson.expo.android,
    ...(buildNumber ? { versionCode: buildNumber } : {}),
  },
  ios: {
    ...appJson.expo.ios,
    ...(buildNumber ? { buildNumber: String(buildNumber) } : {}),
  },
});
```

Estado actual: `app.json` fija `android.versionCode = 2` y no hay
`ios.buildNumber`. Mientras `app.config.js` no lea `BUILD_NUMBER`, ambos quedan
fijos. Además, `github.run_number` es monotónico dentro del repo pero puede ser
menor que un `versionCode` ya publicado en Play (p. ej. 2): la primera release
real debe ajustar el offset o usar un `versionCode` ya mayor al publicado.

El workflow, por las dudas, también pasa `CURRENT_PROJECT_VERSION=$BUILD_NUMBER`
y `MARKETING_VERSION` (desde `app.json`) a `xcodebuild`, de modo que
`CFBundleVersion` queda con el número de corrida aunque el app config no lo
exponga.

## Secretos (Settings → Secrets and variables → Actions)

| Secreto | Obligatorio | Para | Contenido / cómo generarlo |
|---|---|---|---|
| `ANDROID_KEYSTORE_B64` | sí (Android) | Android | `.keystore`/`.jks` de release en base64 (`base64 -w0 release.keystore`). |
| `ANDROID_KEYSTORE_PASS` | sí (Android) | Android | Password del store **y** de la clave (el workflow usa el mismo valor para `store.password` y `key.password`). |
| `ANDROID_KEY_ALIAS` | sí (Android) | Android | Alias de la clave de release. |
| `GOOGLE_SERVICES_JSON_B64` | no | Android | `google-services.json` en base64. Sin él se omite Firebase/Google Services. |
| `IOS_CERT_P12_B64` | sí (iOS) | iOS | Certificado **Apple Distribution** exportado como `.p12` desde Llavero, en base64. |
| `IOS_CERT_PASSWORD` | sí (iOS) | iOS | Password elegido al exportar el `.p12`. |
| `IOS_PROVISION_B64` | sí (iOS) | iOS | Provisioning profile **App Store** del bundle `org.fuentelibre.gtk-llm-chat`, en base64. |
| `APP_STORE_CONNECT_KEY_ID` | no | TestFlight | Key ID de la API key de App Store Connect. |
| `APP_STORE_CONNECT_ISSUER_ID` | no | TestFlight | Issuer ID (UUID) de la misma pantalla. |
| `APP_STORE_CONNECT_API_KEY_P8` | no | TestFlight | Contenido **crudo** del `.p8` (incluye las líneas `BEGIN/END PRIVATE KEY`). Se descarga una sola vez. |

Generar la keystore y codificarla:

```sh
keytool -genkeypair -v -keystore release.keystore -alias gtk-llm-chat \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PASS" -keypass "$PASS"
base64 -w0 release.keystore > keystore.b64    # macOS: base64 -i release.keystore
```

Codificar el `.p12` y el perfil:

```sh
base64 -w0 cert.p12 > cert.b64
base64 -w0 gtk-llm-chat.mobileprovision > profile.b64
```

Sin los tres secretos `IOS_*` el job iOS se omite con aviso. Sin los tres
`APP_STORE_CONNECT_*` se exporta el IPA pero no se sube a TestFlight.

## Acciones manuales en Apple

1. **App ID.** [developer.apple.com](https://developer.apple.com) → Certificates,
   IDs & Profiles → Identifiers → **+** → App IDs → App. Bundle ID **exacto**:
   `org.fuentelibre.gtk-llm-chat` (Explícito). Habilitar las capabilities que use
   la app (p. ej. Push Notifications si se usa XEP-0357).
2. **Certificado de distribución.** En un Mac: Llavero → Asistente de
   certificados → solicitar un certificado (CSR) → en el portal crear un
   certificado **Apple Distribution** con esa CSR → descargarlo, importarlo al
   Llavero y exportarlo como `.p12` con password.
3. **Provisioning profile.** Profiles → **+** → Distribution → **App Store** →
   App ID `org.fuentelibre.gtk-llm-chat` → certificado Apple Distribution →
   descargar el `.mobileprovision`. El `Name` del perfil es el que termina en
   `provisioningProfiles` de `ExportOptions.plist`, así que conviene uno estable,
   p. ej. `gtk-llm-chat App Store CI`.
4. **App en App Store Connect.** [appstoreconnect.apple.com](https://appstoreconnect.apple.com)
   → My Apps → **+** → New App: plataforma iOS, nombre, idioma principal, SKU y
   bundle ID `org.fuentelibre.gtk-llm-chat`. Sin este registro `altool` rechaza
   la subida.
5. **API key (TestFlight).** App Store Connect → Users and Access →
   Integrations → App Store Connect API → Team Keys → generar una key con rol
   suficiente (App Manager). Anotar el **Key ID** y el **Issuer ID** y guardar el
   `.p8` (sólo se descarga una vez). En TestFlight, tras el procesamiento del
   build, completar el cuestionario de exportación (la app sólo usa TLS estándar)
   y asignar testers.

Android: si se publica en Play, subir el `.aab` con la misma keystore de
release. Perder la keystore impide actualizar la app.

## Cómo disparar un release

```sh
# Release por tag: construye y adjunta APK/AAB (+ IPA si hay secretos iOS)
git tag v0.2.0-rc1
git push origin v0.2.0-rc1

# Manual, sobre una rama (sin adjuntar a un Release, porque no hay tag)
gh workflow run release.yml --ref mi-rama
```

El `versionCode`/`CFBundleVersion` sale de `github.run_number`. El nombre de los
archivos usa el tag sin la `v` (o el número de corrida en `workflow_dispatch`).

## Notas

- **`testflight_promote.yml` no se incluye.** El de `xat` depende de
  `scripts/testflight_distribute.py` (≈514 líneas, 23 KB), que no existe en este
  repo y no es un script pequeño/genérico; copiarlo excede el alcance de este
  cambio. Mientras tanto, la promoción a testers externos (cuestionario de
  exportación + Beta App Review) se hace a mano en App Store Connect. Si se
  quiere automatizar, traer ese script en un cambio aparte y agregar el workflow
  con schedule + `workflow_dispatch`.
- El keychain y el `.p8` son temporales del runner; no quedan en el repo.
- No se usa EAS Build ni `eas.json`. Todo se genera con `expo prebuild` y las
  herramientas nativas (`gradlew`, `xcodebuild`, `altool`).
