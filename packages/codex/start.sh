#!/bin/bash
# Invoked by Codex to launch the Glean MCP server. Codex installs local
# plugins into a cached copy, so this launcher anchors all paths to the plugin
# directory rather than the current working directory.
set -e
PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"

# Prefer Codex's managed writable plugin directory when available. Keep the
# env names aligned with the Node bundle, which reads PLUGIN_DATA_DIR.
if [ -n "${PLUGIN_DATA_DIR:-}" ]; then
  DATA_DIR="$PLUGIN_DATA_DIR"
elif [ -n "${PLUGIN_DATA:-}" ]; then
  DATA_DIR="$PLUGIN_DATA"
else
  DATA_DIR="${HOME:-/tmp}/.glean"
fi

export PLUGIN_DATA_DIR="$DATA_DIR"
export SKILLS_BASE_DIR="${SKILLS_BASE_DIR:-$DATA_DIR/glean-skills-cache}"

# Resolve the chat session id host-side (see plugins/glean/start.sh). Codex
# exposes the conversation id as CODEX_THREAD_ID; export it as the normalized
# GLEAN_SESSION_ID that the Node bundle reads.
if [ -n "${CODEX_THREAD_ID:-}" ]; then
  export GLEAN_SESSION_ID="$CODEX_THREAD_ID"
fi

exec node "$PLUGIN_DIR/dist/index.js"
