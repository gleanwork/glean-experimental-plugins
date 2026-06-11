# Glean Claude plugin

Glean's plugin for [Claude Code](https://code.claude.com/docs/en/overview)
and [Claude Cowork](https://claude.com/cowork). This repo is a single-plugin
marketplace.

Today it ships one plugin:

- **`glean`** — adds two static tools, `find_skills` and `run_tool`, that
  let the agent discover Glean-hosted skills for enterprise apps (Jira, Slack,
  Google Workspace, Salesforce, etc.) and invoke their downstream tools via
  Glean's MCP gateway. Once the user has authenticated, the plugin also
  surfaces a small allow-list of Glean's first-class tools — currently
  `search` and `read_document` — directly, with schemas pulled from the
  remote MCP server.

## Install

### Claude Code (terminal)

```
/plugin marketplace add askscio/glean-plugins-internal
/plugin install glean@glean-plugins-internal
```

### Claude Cowork (desktop)

1. Open the plugin picker.
2. Click **Add marketplace**, choose **GitHub**, and enter
   `askscio/glean-plugins-internal`.
3. Once the marketplace syncs, install the **glean** plugin from it.

## First run

The first tool call triggers OAuth sign-in to Glean via the `setup` tool.
The agent's skill walks the user through the sign-in URL and paste-back
flow. After sign-in, OAuth credentials are cached to `~/.glean/` and reused
across sessions — you won't be prompted again until the refresh token
expires.

## Updates

```
# Claude Code
/plugin marketplace update glean-plugins-internal

# Cowork: the plugin picker has a "Sync" / "Check for updates"
# button on the marketplace entry.
```

## Testing a specific branch or PR

You can point the marketplace at a specific git branch, tag, or commit:

```bash
# Install from a specific branch (e.g. a PR branch)
/plugin marketplace add askscio/glean-plugins-internal@branch-name
/plugin install glean@glean-plugins-internal

# Or update an existing marketplace to a different branch
/plugin marketplace remove glean-plugins-internal
/plugin marketplace add askscio/glean-plugins-internal@branch-name
```

You can also pin to a branch in `settings.json`:

```json
{
  "marketplaces": [
    {
      "name": "glean-plugins-internal",
      "source": "https://github.com/askscio/glean-plugins-internal",
      "sourceType": "git",
      "branch": "mohit-baseline-marketplace-layout"
    }
  ]
}
```

For local development, point the marketplace at your local checkout instead:

```bash
/plugin marketplace add /path/to/glean-plugins-internal
```

Then just `git checkout` whichever branch you want to test.

## Troubleshooting

- **Sign-in loop** — the cached OAuth provider state may be stale. Delete
  `~/.glean/mcp-credentials.json` and retry.
- **`GLEAN_MCP_SERVER_URL is required`** — the plugin's `.mcp.json` wasn't
  picked up by the host. Reinstall; if that fails, open an issue.

## Development

Prerequisites: Node 22+, npm.

```bash
npm install
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run build       # esbuild → plugins/glean/dist/index.js
```

Source is at the repo root (`src/`, `tests/`, `scripts/`). Packaged
runtime lives under `plugins/glean/`. See the Layout section below.

## Release process

1. Bump `version` in `plugins/glean/.claude-plugin/plugin.json`.
2. `npm test && npm run typecheck` — verify clean.
3. Commit, tag, and push:
   ```bash
   git tag v<version>
   git push && git push --tags
   ```
4. Draft a release on GitHub.

## Layout

```
.claude-plugin/
  marketplace.json        Top-level marketplace manifest for Claude Code
                          / Cowork. Points at ./plugins/glean as the
                          plugin source.
plugins/glean/
  .claude-plugin/
    plugin.json           Plugin manifest — name, version, description
  .mcp.json               MCP server invocation read by Claude Code /
                          Cowork. Source of truth.
  dist/index.js           Built server bundle (every dep inlined; produced
                          by `npm run build`; checked in)
  skills/glean_run/       Skill that tells the agent how to use the
                          tools. Uses the open SKILL.md standard.
  start.sh                Bash launcher that anchors PROJECT_DIR to the
                          host's spawn cwd, then execs node on the bundle
  package.json            Minimal "type": "module" manifest so Node
                          treats dist/index.js as ESM at runtime
src/                      TypeScript sources for the MCP server
tests/                    Vitest suite
scripts/                  build.mjs — esbuild bundler
package.json              Top-level dev config — deps, npm scripts
tsconfig.json             TypeScript config for the dev tree
```

## License

Apache 2.0. See [LICENSE](./LICENSE).
