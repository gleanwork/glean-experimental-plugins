# Glean for Codex

Search and act across your company's apps — Jira, Slack, Salesforce, Google
Workspace, and more — without leaving Codex.

## Components

| Component | Path | Purpose |
|-----------|------|---------|
| MCP server | `.mcp.json` → `start.sh` | Stdio launcher for the Glean MCP bundle |
| Skill | `skills/glean_run/SKILL.md` | `glean_run` workflow |

## Install

### Local repo marketplace (development & current default)

This repo ships `.agents/plugins/marketplace.json` pointing at `./packages/codex`.

1. Open Codex with this repo as the workspace root.
2. Open the plugin directory — Codex desktop: **Plugins**, Codex CLI: `/plugins`.
3. Find **Glean for Codex (Local Repo)** and install `glean-codex`.
4. Restart Codex if the marketplace doesn't appear immediately.

Before the first install from a fresh checkout, run `npm run build` once so
`packages/codex/dist/index.js` exists.

### From a registry (when published)

Once Glean's plugin is on the Codex registry, install via Codex's plugin picker.

## First run

1. First Glean tool call returns `[SETUP_REQUIRED]` or `[AUTHENTICATION_REQUIRED]`.
2. The `glean_run` skill drives the `setup` flow.
3. Credentials cache to `$PLUGIN_DATA_DIR/mcp-credentials.json` (defaults to `~/.glean/mcp-credentials.json`).

## Day-to-day

Trigger the `glean_run` skill by name, or rely on Codex's skill auto-routing.
If the skill isn't picked up automatically, mention it explicitly in the prompt.

## Distribution

### Artifact shape

`bash scripts/pack-plugin.sh codex` produces `glean-codex-<version>.zip`:

```
.codex-plugin/plugin.json      manifest
.mcp.json                      MCP config
skills/glean_run/SKILL.md      host-neutral skill
dist/index.js                  materialized by npm run build
package.json                   ESM marker
start.sh                       Codex-specific launcher
```

### Path resolution

`.mcp.json` sets `cwd: "."` so Codex resolves `./start.sh` relative to the
installed plugin root (not the session cwd). The launcher then anchors to its
own directory via `dirname $0` and falls back to `~/.glean` for data storage.

### Versioning

`.codex-plugin/plugin.json:version` mirrors the Claude package version.

## Update

Run `npm run build` if the runtime changed, then reinstall from the repo
marketplace. Codex may cache a stale copy — reinstalling clears it.

## Uninstall

Remove via Codex's plugin loader. Optionally clear credentials:
`rm -rf ~/.glean/`.

## Troubleshooting

- **MCP server doesn't spawn** — verify Codex picked up `.mcp.json`. The
  `cwd: "."` field is required; without it Codex launches from the session cwd
  and `./start.sh` won't resolve.
- **Sign-in loop** — `rm ~/.glean/mcp-credentials.json`.
- **Skill not invoked** — mention `glean_run` explicitly in the prompt.

## Doc references

- Plugins: https://developers.openai.com/codex/plugins
- Skills: https://developers.openai.com/codex/skills
- MCP: https://developers.openai.com/codex/mcp
