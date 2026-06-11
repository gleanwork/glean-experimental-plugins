#!/bin/bash
# Produce a .plugin bundle for testing. The output is named
# glean-<version>.plugin, consumable by Cowork's local upload.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$ROOT/plugins/glean"

VERSION="$(node -p "require('$PLUGIN_DIR/.claude-plugin/plugin.json').version")"
OUT="$ROOT/glean-${VERSION}.plugin"

cd "$ROOT"

rm -rf "$PLUGIN_DIR/dist"
npm run build --silent

rm -f glean-*.plugin

cd "$PLUGIN_DIR"
zip -r "$OUT" \
  .claude-plugin \
  .mcp.json \
  dist \
  skills \
  start.sh \
  package.json \
  >/dev/null

echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
