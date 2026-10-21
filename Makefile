APK := android/app/build/outputs/apk/release/app-release.apk
PACKAGE := org.fuentelibre.gtk_llm_chat
GOOGLE_SERVICES := google-services.json

.PHONY: check prepare-fcm build-release install-release reinstall-release launch push-logs prosody-push-logs

.PHONY: linux-dev linux-build linux-run

linux-dev:
	npm run linux:dev

linux-build:
	npm run linux:build

linux-run:
	./src-tauri/target/release/gtk-llm-chat-linux

check:
	npm run type-check
	npm run lint
	npm test -- --runTestsByPath __tests__/mam-parse.test.ts __tests__/xmpp-actions.test.ts

# CNG: google-services.json vive en la raíz; app.config.js lo detecta y el
# prebuild lo copia a android/ y aplica el plugin de Gradle.
prepare-fcm:
	test -f $(GOOGLE_SERVICES)
	npx expo prebuild --clean --no-install -p android
	grep -q 'com.google.gms:google-services' android/build.gradle
	grep -q 'com.google.gms.google-services' android/app/build.gradle

build-release: prepare-fcm
	npm run android:standalone
	unzip -l $(APK) | rg 'assets/index.android.bundle|AndroidManifest.xml|classes.dex'

install-release:
	adb install -r $(APK)

reinstall-release: check build-release install-release

launch:
	adb shell monkey -p $(PACKAGE) 1

push-logs:
	adb logcat -d -t 5000 | grep -Ei 'xmpp-push|ExpoPushToken|getExpoPushToken|push-enable|ReactNativeJS|Notification|Firebase|FATAL EXCEPTION' | tail -200

prosody-push-logs:
	ssh nanoclaw@187.127.47.38 'sudo -n journalctl -u prosody --since "2 hours ago" --no-pager | grep -Ei "expo push|expo_push|Accepted Expo|Rejected Expo|Push notifications enabled|cloud_notify|push failed|error|warn" | tail -200'
