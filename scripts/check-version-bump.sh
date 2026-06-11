#!/bin/bash
# CI check: verify the version was incremented when plugin files change.
# Compares the PR branch version against the base branch version.
# Rejects downgrades. Version source of truth: plugins/glean/.claude-plugin/plugin.json
set -euo pipefail

BASE_REF="${1:-origin/main}"

# Only trigger on files that affect the plugin runtime — not CI or tooling.
PLUGIN_PATHS="^(src/|plugins/glean/(dist/|skills/|start\.sh|\.mcp\.json|package\.json|\.claude-plugin/plugin\.json))"

if ! git diff --name-only "$BASE_REF"...HEAD | grep -qE "$PLUGIN_PATHS"; then
  echo "No plugin files changed — skipping version check."
  exit 0
fi

PLUGIN_MANIFEST="plugins/glean/.claude-plugin/plugin.json"
SEMVER_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

# Current version from the working tree.
PLUGIN_VERSION=$(node -p "require('./$PLUGIN_MANIFEST').version")
if ! [[ "$PLUGIN_VERSION" =~ $SEMVER_RE ]]; then
  echo "ERROR: Current version '$PLUGIN_VERSION' is not a valid semver triplet (x.y.z)."
  exit 1
fi

# Base version from the base ref. The manifest may not exist there yet — e.g. the
# plugin is being introduced for the first time, or the base branch predates it.
# There is then no prior version to bump from, so the check passes. Capturing the
# blob separately (instead of piping git into node) keeps `set -o pipefail` from
# turning a missing path into an opaque JSON parse error.
if ! BASE_PLUGIN_JSON=$(git show "$BASE_REF:$PLUGIN_MANIFEST" 2>/dev/null); then
  echo "Plugin manifest not present on $BASE_REF — new plugin, skipping version-bump check (current version: $PLUGIN_VERSION)."
  exit 0
fi

BASE_VERSION=$(node -p "JSON.parse(require('fs').readFileSync(0,'utf-8')).version" <<<"$BASE_PLUGIN_JSON")
if ! [[ "$BASE_VERSION" =~ $SEMVER_RE ]]; then
  echo "ERROR: Base version '$BASE_VERSION' is not a valid semver triplet (x.y.z)."
  exit 1
fi

if [ "$PLUGIN_VERSION" = "$BASE_VERSION" ]; then
  echo "ERROR: Plugin files changed but version was not bumped."
  echo "  Base version:    $BASE_VERSION"
  echo "  Current version: $PLUGIN_VERSION"
  echo ""
  echo "Bump the version in plugins/glean/.claude-plugin/plugin.json"
  exit 1
fi

# Reject downgrades: current version must be strictly greater than base.
if ! node -e "
  const a = '$BASE_VERSION'.split('.').map(Number);
  const b = '$PLUGIN_VERSION'.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (b[i] > a[i]) process.exit(0);
    if (b[i] < a[i]) process.exit(1);
  }
  process.exit(1);
"; then
  echo "ERROR: Version was downgraded."
  echo "  Base version:    $BASE_VERSION"
  echo "  Current version: $PLUGIN_VERSION"
  echo ""
  echo "The version must be higher than the base branch."
  exit 1
fi

echo "Version bump verified: $BASE_VERSION → $PLUGIN_VERSION"
