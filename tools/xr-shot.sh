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
T0=""
mkdir -p "$OUT/frames"
while [ $START -lt $N ]; do
  CH=$(( N - START ))
  R=$(FILM_DIR=$(realpath "$OUT/frames") FILM_N=$CH FILM_START=$START FILM_WARM=$W cli browser run --timeout 110000 tools/browser/xr-film.mjs)
  read -r DONE W T0NEW < <(echo "$R" | python3 -c "import json,sys; r=json.load(sys.stdin)['data']['result']; print(r['done'], r.get('warmLeft',0), r.get('t0',''))")
  [ -z "$T0" ] && [ -n "$T0NEW" ] && [ "$DONE" -eq 0 ] && T0=$T0NEW
  [ -z "$T0" ] && [ -n "$T0NEW" ] && T0=$T0NEW
  START=$DONE
  echo "frames $START/$N (warm left $W)"
done
XR_T0=$T0 XR_SECS=$SECS XR_WAV=$(realpath "$OUT")/audio.wav cli browser run tools/browser/xr-audio.mjs | grep -q '"ok": true'
ffmpeg -loglevel error -y -framerate 30 -i "$OUT/frames/f%05d.png" -i "$OUT/audio.wav" -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -pix_fmt yuv420p -crf 18 -c:a aac -b:a 160k -shortest "$OUT/shot.mp4"
echo "done $OUT/shot.mp4"
