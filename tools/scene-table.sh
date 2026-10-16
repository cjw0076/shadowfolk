#!/usr/bin/env bash
# Fresh player, emulated XR, seated at the living-room table; optional film: tools/scene-table.sh [dir n dtms]
set -e
cd "$(dirname "$0")/.."
cli() { npx @iwsdk/cli "$@" 2>&1; }
cli browser run tools/browser/reset-demo.mjs | grep -q '"ok": true'
cli xr enter | grep -q '"success": true'
cli xr set-transform --input-json '{"device":"headset","position":{"x":-0.9,"y":1.25,"z":-1.19},"orientation":{"pitch":-10,"yaw":90,"roll":0}}' | grep -q '"ok": true'
cli browser run tools/browser/replace.mjs | grep -q '"ok": true'
if [ -n "$1" ]; then
  FILM_DIR=$(realpath -m "$1") FILM_N=${2:-20} FILM_DT=${3:-1000} cli browser run tools/browser/film.mjs --timeout 600000 | python3 -c "
import json,sys; d=json.load(sys.stdin)
for r in d['data']['result']: print(r)"
fi
