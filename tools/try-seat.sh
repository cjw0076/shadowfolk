#!/usr/bin/env bash
# Usage: tools/try-seat.sh x y z yawDeg out.png  — sit the emulated headset somewhere, re-enter XR, dump the room fit, screenshot.
set -e
cd "$(dirname "$0")/.."
X=$1 Y=$2 Z=$3 YAW=$4 OUT=$5
cli() { npx @iwsdk/cli "$@" 2>&1; }
cli xr status | grep -q '"sessionActive": true' || cli xr enter | grep -q '"success": true'
cli xr set-transform --input-json "{\"device\":\"headset\",\"position\":{\"x\":$X,\"y\":$Y,\"z\":$Z},\"orientation\":{\"pitch\":-8,\"yaw\":$YAW,\"roll\":0}}" | grep -q '"ok": true'
sleep 0.5
cli browser run tools/browser/replace.mjs | grep -q '"ok": true'
sleep 1
for i in $(seq 1 40); do
  S=$(cli browser run tools/browser/room-state.mjs)
  echo "$S" | grep -q '"fitUntil": 0' && echo "$S" | grep -q '"settling": false' && break
  sleep 0.5
done
sleep 2
echo "$S" | python3 -c "
import json,sys; d=json.load(sys.stdin); r=d['data'].get('result',d['data']); r.pop('surfaces',None); r.pop('slots',None)
print(json.dumps(r))"
cli browser screenshot --output-file "$OUT" | grep -o '"screenshotPath": "[^"]*"'
