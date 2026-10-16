#!/usr/bin/env bash
# Film emulated XR in the managed browser: tools/xr-shot.sh outdir seconds warmup_s x y z yaw pitch storage_json [params]
set -e
cd "$(dirname "$0")/.."
OUT=$1 SECS=$2 WARM=$3 X=$4 Y=$5 Z=$6 YAW=$7 PITCH=$8 STORE=$9 PARAMS=${10:-capture=keepdom&demo&day=20378}
cli() { npx @iwsdk/cli "$@" 2>&1; }
cli xr exit >/dev/null || true
XR_W=1600 XR_H=900 XR_PARAMS="$PARAMS" XR_STORAGE="$STORE" cli browser run tools/browser/xr-capture-setup.mjs | grep -q '"capture": true'
cli xr enter | grep -q '"success": true'
cli xr set-transform --input-json "{\"device\":\"headset\",\"position\":{\"x\":$X,\"y\":$Y,\"z\":$Z},\"orientation\":{\"pitch\":$PITCH,\"yaw\":$YAW,\"roll\":0}}" | grep -q '"ok": true'
N=$(python3 -c "print(round($SECS*30))"); W=$(python3 -c "print(round($WARM*30))")
START=0
mkdir -p "$OUT/frames"
while [ $START -lt $N ]; do
  CH=$(( N - START < 90 ? N - START : 90 ))
  R=$(FILM_DIR=$(realpath "$OUT/frames") FILM_N=$CH FILM_START=$START FILM_WARM=$W cli browser run --timeout 110000 tools/browser/xr-film.mjs)
  DONE=$(echo "$R" | python3 -c "import json,sys; r=json.load(sys.stdin)['data']['result']; print(r.get('done', r.get('stoppedAt')))")
  START=$DONE; W=0
  echo "frames $START/$N"
done
ffmpeg -loglevel error -y -framerate 30 -i "$OUT/frames/f%05d.png" -c:v libx264 -pix_fmt yuv420p -crf 18 "$OUT/shot.mp4"
echo "done $OUT/shot.mp4"
