#!/bin/bash
# Rebuild dist/index.js and stage it on every commit.
set -e
cd "$(git rev-parse --show-toplevel)"

if [ ! -d node_modules ] || [ -L node_modules ]; then
  echo "pre-commit: node_modules missing or is a symlink; running npm ci" >&2
  npm ci --silent
fi

npm run build --silent
git add plugins/glean/dist/index.js packages/codex/dist/index.js
