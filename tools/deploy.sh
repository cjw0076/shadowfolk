#!/usr/bin/env bash
# Build, check, publish to GitHub Pages, and wait until the live page serves this build.
# Needs a vite preview on 127.0.0.1:4173 serving dist (for the runtime fault check).
set -euo pipefail
cd "$(dirname "$0")/.."
npx tsc --noEmit
npx vite build --logLevel error
test -f dist/.nojekyll
# Runtime fault checks run on the built preview with the classic night flow; the journey handoff gate
# runs on the dev server (same source; it needs the dev-only window.__theater hook).
PASSES=$(timeout 300 node tools/check-runtime-browser.mjs 'https://127.0.0.1:4173/?demo&noJourney' 2>&1 | grep -c PASS || true)
[ "$PASSES" -ge 10 ] || { echo "runtime checks: $PASSES/10"; exit 1; }
HANDOFF=$(XR_BASE=https://127.0.0.1:8081/ timeout 300 node tools/check-journey-handoff.mjs 2>&1 | grep -c '^PASS' || true)
[ "$HANDOFF" -ge 3 ] || { echo "journey handoff checks: $HANDOFF/3"; exit 1; }
# Smoke film with the real audio class and no user gesture: any page/console error fails the deploy.
SMOKE=$(mktemp -d)
timeout 600 node tools/record/record.mjs tools/record/shots/smoke.json "$SMOKE" >/dev/null
SMOKE_ERRORS=$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))))" "$SMOKE/errors.json")
[ "$SMOKE_ERRORS" = "0" ] || { echo "smoke film errors: $SMOKE_ERRORS ($SMOKE/errors.json)"; exit 1; }
git push -q origin main
npx -y gh-pages@6 -d dist --dotfiles -r git@github.com-cjw0076:cjw0076/shadowfolk.git
WANT=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' dist/index.html | head -1)
for i in $(seq 1 60); do
  GOT=$(curl -s "https://cjw0076.github.io/shadowfolk/?v=$RANDOM" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1 || true)
  [ "$GOT" = "$WANT" ] && { echo "LIVE $WANT ($(git rev-parse --short HEAD))"; exit 0; }
  sleep 10
done
echo "published, but the CDN still serves $GOT (want $WANT)"; exit 2
