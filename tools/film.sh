#!/usr/bin/env bash
# Usage: tools/film.sh outdir count interval  — screenshot the managed browser repeatedly, then tile a contact sheet.
set -e
cd "$(dirname "$0")/.."
OUT=$1 N=${2:-12} DT=${3:-2}
mkdir -p "$OUT"
for i in $(seq -w 1 "$N"); do
  npx @iwsdk/cli browser screenshot --output-file "$OUT/f$i.png" >/dev/null 2>&1
  npx @iwsdk/cli browser run tools/browser/phase.mjs 2>/dev/null | python3 -c "import json,sys; r=json.load(sys.stdin)['data']['result']; print('$i', r['phase'], r['phaseTime'], r['step'], r['score'])"
  sleep "$DT"
done
ffmpeg -loglevel error -y -pattern_type glob -i "$OUT/f*.png" -vf "scale=520:-1,tile=4x$(( (N+3)/4 ))" "$OUT/sheet.png"
echo "$OUT/sheet.png"
