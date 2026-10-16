#!/usr/bin/env bash
# Build, check, publish to GitHub Pages, and wait until the live page serves this build.
# Needs a vite preview on 127.0.0.1:4173 serving dist (for the runtime fault check).
set -euo pipefail
cd "$(dirname "$0")/.."
npx tsc --noEmit
npx vite build --logLevel error
test -f dist/.nojekyll
PASSES=$(timeout 300 node tools/check-runtime-browser.mjs 'https://127.0.0.1:4173/?demo' 2>&1 | grep -c PASS || true)
[ "$PASSES" -ge 7 ] || { echo "runtime checks: $PASSES/7"; exit 1; }
git push -q origin main
npx -y gh-pages@6 -d dist --dotfiles -r git@github.com-cjw0076:cjw0076/shadowfolk.git
WANT=$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' dist/index.html | head -1)
for i in $(seq 1 60); do
  GOT=$(curl -s "https://cjw0076.github.io/shadowfolk/?v=$RANDOM" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js' | head -1 || true)
  [ "$GOT" = "$WANT" ] && { echo "LIVE $WANT ($(git rev-parse --short HEAD))"; exit 0; }
  sleep 10
done
echo "published, but the CDN still serves $GOT (want $WANT)"; exit 2
