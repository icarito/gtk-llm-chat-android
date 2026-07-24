#!/usr/bin/env bash
set -euo pipefail

if [ -z "${GOOGLE_SERVICES_JSON_BASE64:-}" ]; then
  echo "GOOGLE_SERVICES_JSON_BASE64 not set, skipping google-services.json write"
  exit 0
fi

echo "$GOOGLE_SERVICES_JSON_BASE64" | base64 -d > android/app/google-services.json
