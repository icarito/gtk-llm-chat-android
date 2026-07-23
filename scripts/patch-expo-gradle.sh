#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
NM="$PROJECT_DIR/node_modules"

find "$NM" -path "*/expo*/expo-modules-core/android/build.gradle" -type f | while read -r f; do
  if grep -q 'appProject?.hermesEnabled' "$f"; then
    sed -i 's/appProject?\.hermesEnabled?\.toBoolean() || appProject?\.ext?\.react?\.enableHermes?\.toBoolean()/(rootProject.ext.has("hermesEnabled") ? rootProject.ext.hermesEnabled : true)/' "$f"
  fi
done

find "$NM" -name "ExpoModulesCorePlugin.gradle" -path "*/expo-modules-core/*" -type f | while read -r f; do
  if grep -qF "components.findByName('release')" "$f"; then
    sed -i "s/from components\.findByName('release')/from components.findByName('release') ?: return/" "$f"
  fi
done
