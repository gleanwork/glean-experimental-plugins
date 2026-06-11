#!/bin/bash
# Auto-bump patch version if plugin files are staged and version wasn't bumped.
# Uses the same path regex as scripts/check-version-bump.sh (CI check).
set -e
cd "$(git rev-parse --show-toplevel)"

PLUGIN_JSON="plugins/glean/.claude-plugin/plugin.json"
PLUGIN_PATHS="^(src/|plugins/glean/(dist/|skills/|start\.sh|\.mcp\.json|package\.json|\.claude-plugin/plugin\.json))"

if ! git diff --cached --name-only | grep -qE "$PLUGIN_PATHS"; then
  exit 0
fi

BASE_REF="origin/main"
BASE_VERSION=$(git show "$BASE_REF":"$PLUGIN_JSON" 2>/dev/null | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).version" 2>/dev/null) || exit 0
CURRENT_VERSION=$(node -p "require('./$PLUGIN_JSON').version")

# Skip if already ahead of base.
if node -e "
  const a = '$BASE_VERSION'.split('.').map(Number);
  const b = '$CURRENT_VERSION'.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) process.exit(0);
    if (b[i] < a[i]) process.exit(1);
  }
  process.exit(1);
" 2>/dev/null; then
  exit 0
fi

NEW_VERSION=$(node -e "
  const [major, minor, patch] = '$BASE_VERSION'.split('.').map(Number);
  console.log(major + '.' + minor + '.' + (patch + 1));
")

node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$PLUGIN_JSON', 'utf-8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('$PLUGIN_JSON', JSON.stringify(pkg, null, 2) + '\n');
"

git add "$PLUGIN_JSON"
echo "Auto-bumped plugin version: $BASE_VERSION → $NEW_VERSION"
