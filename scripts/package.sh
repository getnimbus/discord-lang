#!/bin/sh
# Zip the extension for sharing: dist/discord-lang-<version>.zip
# Contains only what the browser loads (manifest, src/, icon PNGs).
set -e
cd "$(dirname "$0")/.."

version=$(node -p "require('./manifest.json').version")
out="dist/discord-lang-$version.zip"

mkdir -p dist
rm -f "$out"
zip -qr "$out" manifest.json src icons -x "icons/*.svg" -x "*.DS_Store"

echo "Built $out"
unzip -l "$out"
