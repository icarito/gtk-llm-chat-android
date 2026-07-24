#!/usr/bin/env bash
set -euo pipefail

if [ -z "${GOOGLE_SERVICES_JSON:-}" ]; then
  echo "GOOGLE_SERVICES_JSON not set, skipping google-services.json write"
  exit 0
fi

cp "$GOOGLE_SERVICES_JSON" android/app/google-services.json
