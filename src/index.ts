import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import fs from "node:fs";
import { homedir } from "node:os";
import {
  AuthRequiredError,
  createRemoteClient,
  type RemoteClientOptions,
} from "./remote-client.js";
import { GleanOAuthClientProvider } from "./auth-provider.js";
import { handleFindSkills } from "./tools/find-skills.js";
import { handleRunTool } from "./tools/run-tool.js";
import { handleRunCode } from "./tools/run-code.js";
import { evictStaleSkills } from "./skill-writer.js";
import {
  loadServerUrl,
  saveServerUrl,
  clearServerUrl,
} from "./url-config-store.js";
import { clearCredentials } from "./token-store.js";
import { deletePending } from "./pending-auth-store.js";
import {
  loadRemoteTools,
  saveRemoteTools,
  clearRemoteTools,
} from "./remote-tools-cache-store.js";
import {
  REMOTE_TOOLS_ALLOWLIST,
  dispatchRemoteTool,
  fetchAllowedRemoteTools,
  type DispatchContext,
} from "./tools/remote-passthrough.js";
import { CALLBACK_URL_DESCRIPTION } from "./tools/descriptions.js";
import { resolveSessionId } from "./session-id.js";

function readEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = process.env[key];
    if (v === undefined || v === "") continue;
    if (v.startsWith("${")) continue;
    return v;
  }
  return undefined;
}

function resolveServerUrl(): string | undefined {
  const fromEnv = readEnv("GLEAN_MCP_SERVER_URL");
  if (fromEnv) return fromEnv;
  return loadServerUrl();
}

function normalizeServerUrl(raw: string): string {
  const parsed = new URL(raw);
  return `${parsed.origin}/mcp/gateway/proxy`;
}

const SETUP_REQUIRED_TEXT =
  `[SETUP_REQUIRED]\n\n` +
  `To connect this plugin to your Glean instance:\n` +
  `1. Visit https://app.glean.com/admin/about-glean (log in if needed)\n` +
  `2. Copy the **Server instance (QE)** URL shown on that page (e.g. https://acme-be.glean.com/)\n` +
  `3. Paste it here\n\n` +
  `Then call this tool again with the server_url parameter set to the URL you copied.`;

const SETUP_NEEDED_ERROR =
  "Glean is not configured yet. Call the `setup` tool first to provide " +
  "your Glean Server URL before using find_skills or run_tool.";

// Returned by every non-setup tool when auth is missing or expired. The
// agent should respond by calling `setup` (which drives the OAuth flow
// and accepts the paste-back callback_url), then retry the original
// tool call. Centralising auth in `setup` is what lets us drop
// callback_url from every other tool's schema.
const AUTH_REDIRECT_TO_SETUP_TEXT =
  "[SETUP_REQUIRED]\n\nAuthentication is required. Call the `setup` tool " +
  "(no arguments) to sign in to Glean, then retry this tool.";

function resolveLogPath(): string {
  const base = process.env.PLUGIN_DATA_DIR || path.join(homedir(), ".glean");
  return path.join(base, "glean-server.log");
}

const LOG_PATH = resolveLogPath();
try {
  const logDir = path.dirname(LOG_PATH);
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(logDir, 0o700);
} catch {
  /* ignore */
}

function logLine(label: string, detail?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const suffix = detail ? ` ${JSON.stringify(detail)}` : "";
  const line = `${ts} ${label}${suffix}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line, { mode: 0o600 });
    fs.chmodSync(LOG_PATH, 0o600);
  } catch {
    /* ignore */
  }
  console.error(line.trimEnd());
}

function resolveSkillsBaseDir(): string {
  if (process.env.SKILLS_BASE_DIR) {
    return process.env.SKILLS_BASE_DIR;
  }
  return path.join("/tmp", "glean-skills-cache");
}

function extractAuthCode(pasted: string): string | null {
  const trimmed = pasted.trim();
  if (!trimmed) return null;
  try {
    const urlLike = trimmed.startsWith("?")
      ? `http://localhost${trimmed}`
      : trimmed;
    const url = new URL(urlLike);
    return url.searchParams.get("code");
  } catch {
    return null;
  }
}

const hostedCallbackUrl = "https://dev.glean.com/mcp/auth/callback";

// Experimental "code mode". When ON, the model is given `run_code` INSTEAD of
// `run_tool`: it writes JavaScript that calls each downstream tool as an async
// `PTC_<TOOL>()` function, and the plugin executes that code in a persistent
// sandbox. Default OFF so deployed behavior (run_tool) is untouched.
const RUN_CODE_ENABLED = process.env.ENABLE_RUN_CODE === "true";

const server = new Server(
  { name: "glean", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
);

let oauthProvider: GleanOAuthClientProvider | undefined;

// Cache of the last successful remote tools/list fetch. Persists for the
// lifetime of the process — and across restarts via the on-disk
// remote-tools-cache-store keyed by server URL — so a transient
// auth/network blip or a fresh process spawn doesn't make `chat` /
// `search` / `read_document` disappear from the surface. Cleared on
// `setup({reset})` and on `setup({server_url})` switching instances.
// Empty until `setup` (or any prior process for this URL) has driven a
// successful tool fetch.
let cachedRemoteTools: Tool[] = loadRemoteTools(resolveServerUrl() ?? "");

function getOAuthProvider(): GleanOAuthClientProvider {
  if (!oauthProvider) {
    oauthProvider = new GleanOAuthClientProvider(hostedCallbackUrl);
    // Wire onTokensChanged on every fresh provider instance — after a
    // setup({reset}) we recreate the provider, and the new one needs the
    // same tools/list_changed signal so the host re-fetches the dynamic
    // surface as soon as auth flips.
    oauthProvider.onTokensChanged = () => {
      server.sendToolListChanged().catch(() => {
        // Transport not connected yet, or notification serialization
        // failed — the agent still sees the right tools on its next
        // list_tools call.
      });
    };
  }
  return oauthProvider;
}

function getRemoteClientOpts(): RemoteClientOptions {
  return { authProvider: getOAuthProvider() };
}

const FIND_SKILLS_TOOL: Tool = {
  name: "find_skills",
  annotations: { readOnlyHint: true },
  description:
    "Discover available Glean skills and their resolved tool dependencies. " +
    "Call this tool FIRST whenever the user's request cannot be fulfilled by your " +
    "current tools — especially for tasks involving enterprise apps (Jira, Slack, " +
    "Google Workspace, Salesforce, etc.) or any action you don't already have a " +
    "tool for. Before calling, break the user's request into specific, actionable " +
    "sub-tasks and pass each as a separate entry in the 'queries' array. " +
    "Discovered skills are written to local files and an XML skill " +
    "index with usage instructions is returned. " +
    "If a previously-cached skill file referenced from memory or instructions " +
    "is missing on disk, call find_skills again to re-fetch it before failing.",
  inputSchema: {
    type: "object" as const,
    properties: {
      queries: {
        type: "array",
        items: { type: "string" },
        description:
          "Atomic sub-task descriptions broken down from the user's request. " +
          "Each query should describe one specific action (e.g., 'search emails', " +
          "'create calendar event').",
      },
    },
    required: ["queries"],
  },
};

const RUN_TOOL_TOOL: Tool = {
  name: "run_tool",
  description:
    "Execute a tool on a downstream MCP server. Before calling this tool, " +
    "you MUST read the tool's JSON file from the find_skills output to get " +
    "the exact server_id, tool_name, and input_schema. Pass arguments that match " +
    "the input_schema exactly — do not guess parameter names.",
  inputSchema: {
    type: "object" as const,
    properties: {
      server_id: {
        type: "string",
        description: "The ID of the downstream MCP server.",
      },
      tool_name: {
        type: "string",
        description: "The name of the tool to invoke.",
      },
      arguments: {
        type: "object",
        description: "Optional arguments to pass to the downstream tool.",
      },
      file_args: {
        type: "object",
        description:
          "Optional map from argument name to absolute local file path. " +
          "The plugin reads each file and substitutes its UTF-8 contents " +
          "into the corresponding key in `arguments` before calling the " +
          "remote tool. Use this for long-form drafted content (Slack " +
          "message bodies, Confluence pages, doc contents, etc.) so the " +
          "draft doesn't have to be passed as a huge inline string. " +
          "Paths must be absolute. Each file must be ≤ 1 MB (override " +
          "via GLEAN_FILE_ARG_MAX_BYTES). A key in `file_args` must not " +
          "also appear in `arguments`.",
        additionalProperties: { type: "string" },
      },
    },
    required: ["server_id", "tool_name"],
  },
};

const RUN_CODE_TOOL: Tool = {
  name: "run_code",
  description:
    "Execute JavaScript that orchestrates downstream Glean tools as ordinary " +
    "async functions, FOR BATCH JOBS ONLY — i.e. when you need 2+ tool calls: " +
    "chaining one tool's output into the next, fanning out, or looping a call " +
    "over many inputs. For a SINGLE one-off call, use `run_tool` (or the " +
    "first-class tool directly) instead — a single-call run_code is rejected. " +
    "Each discovered tool is available as `PTC_<TOOL_NAME>` " +
    "(e.g. `await PTC_JIRA_SEARCH({ jql })`); the server_id is bound for you. " +
    "Do multi-step work (loops, conditionals, filtering, passing " +
    "one tool's output into the next) in a single call instead of many " +
    "separate tool-call turns. First use find_skills, then read each tool's JSON " +
    "for its inputSchema (argument names) — the binding name is `PTC_` + the " +
    "tool's `name`. Glean's first-class tools (e.g. `PTC_search`, " +
    "`PTC_read_document`) are also available the same way once authenticated.\n\n" +
    "Each PTC_ call resolves to a ToolResult: `.text` (raw string), `.json()` " +
    "(parsed, or undefined if the output isn't JSON — so don't write " +
    "`if (r.json())`; branch on `.format` instead), `.format` " +
    "('json' | 'text' | 'empty'), `.get('a.b.c', fallback)` (safe nested " +
    "access — never throws), `.isError`, `.content`.\n\n" +
    "OUTPUT SHAPES ARE NOT KNOWN AHEAD OF TIME. `observed_schemas` in the result " +
    "already gives the shape of every tool you called this run. To inspect the " +
    "structure of any other value, call `inspect(value)` — it returns/prints the " +
    "SHAPE only (never the data; the data stays in the runtime). Use `print(...)` " +
    "for output and `schemaOf('TOOL')` for a shape learned in past runs.\n\n" +
    "WHAT COMES BACK: `return <value>` sends that value back VERBATIM (no " +
    "truncation). If it exceeds ~5000 chars it is written to a file and you get " +
    "`{ shape, path }` instead — Read that file (offset/limit/grep) for specifics; " +
    "do NOT re-run a tool to regenerate data. So return/print ONLY what you need; " +
    "the full data always stays in your in-memory variables to compute over.\n\n" +
    "STATEFUL SESSION: this is a REPL. To persist a variable across run_code " +
    "calls, use a BARE assignment — no var/let/const (e.g. " +
    "`bugs = await PTC_JIRA_SEARCH(...)`). `var`, `let`, and `const` are ALL " +
    "temporary (this call only — `var` does NOT persist). The session and its " +
    "persisted variables last until the plugin process shuts down, or until you " +
    "call run_code with reset:true. It is NOT durable storage — re-run setup " +
    "cells if a result reports session.fresh=true. Top-level `await` is supported.\n\n" +
    "BE EFFICIENT — avoid round-trips: do the whole task in ONE call when you " +
    "can — fetch, then filter/format the result and `print()` or `return` ONLY " +
    "the final answer. Output written to a file (overflow) is NOT lost — the full " +
    "result also stays in the runtime, so NEVER re-run a tool just to 'get the " +
    "full data'; read the fields you need from the value you already have. Prefer " +
    "`print()` formatted lines or `return` a small aggregate (a count, a few " +
    "fields) over returning a whole result or large array.\n\n" +
    "Some tools require approval before they run; you may be prompted once for " +
    "all approval-required tools the code references. Tool calls are recorded " +
    "in a ledger returned with the result; on error, already-executed writes " +
    "are NOT rolled back — read the ledger.",
  inputSchema: {
    type: "object" as const,
    properties: {
      code: {
        type: "string",
        description:
          "JavaScript to execute. Tools are async `PTC_<TOOL_NAME>(args)` " +
          "functions. Use `return` to send a value back.",
      },
      reset: {
        type: "boolean",
        description:
          "If true, clear all persisted session variables and start a fresh " +
          "runtime before executing this code.",
      },
    },
    required: ["code"],
  },
};

const SETUP_TOOL: Tool = {
  name: "setup",
  annotations: { readOnlyHint: true },
  description:
    "Check or configure the Glean connection. Setup completes in three " +
    "stages: (1) save the Server URL, (2) authenticate, (3) fetch the " +
    "remote tool catalog. Call with no arguments to advance through the " +
    "next missing stage. Call with server_url to (re)configure. Call with " +
    "callback_url to finish authentication after a sign-in paste. Call " +
    "with reset=true to clear all configuration.",
  inputSchema: {
    type: "object" as const,
    properties: {
      server_url: {
        type: "string",
        description:
          "Glean Server Instance (QE) URL (e.g. https://acme-be.glean.com).",
      },
      callback_url: {
        type: "string",
        description: CALLBACK_URL_DESCRIPTION,
      },
      reset: {
        type: "boolean",
        description: "Clear cached URL, credentials, and remote tool cache.",
      },
    },
    required: [],
  },
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Code mode ADDS run_code alongside run_tool (it no longer replaces it):
  // run_tool handles single one-off calls, run_code is scoped to batches
  // (2+ calls / chaining / fan-out). When the flag is off the surface is
  // identical to what's deployed today.
  const tools: Tool[] = RUN_CODE_ENABLED
    ? [FIND_SKILLS_TOOL, RUN_TOOL_TOOL, RUN_CODE_TOOL, SETUP_TOOL]
    : [FIND_SKILLS_TOOL, RUN_TOOL_TOOL, SETUP_TOOL];

  // Pre-auth gate: tokens() is sync. When unauthenticated (or unconfigured)
  // skip the remote round-trip — but keep surfacing whatever we successfully
  // fetched earlier in this process so a token expiry doesn't make the
  // dynamic surface vanish. Calls to non-setup tools route through
  // [SETUP_REQUIRED] / setup when URL or tokens are missing; only setup
  // emits [AUTHENTICATION_REQUIRED] during the sign-in step.
  const serverUrl = resolveServerUrl();
  if (!serverUrl) {
    return { tools: [...tools, ...cachedRemoteTools] };
  }
  const provider = getOAuthProvider();
  if (!provider.tokens()) {
    return { tools: [...tools, ...cachedRemoteTools] };
  }

  let remoteClient;
  try {
    remoteClient = await createRemoteClient(
      serverUrl,
      getRemoteClientOpts(),
      `tools-list-${process.pid}`,
    );
  } catch (err) {
    // Auth expired mid-session, network blip, schema parse error — serve
    // static + last-known dynamic tools. Agent isn't blocked.
    const msg = err instanceof Error ? err.message : String(err);
    logLine("connect.backend-error", { label: "tools/list", msg });
    return { tools: [...tools, ...cachedRemoteTools] };
  }

  try {
    const remoteTools = await fetchAllowedRemoteTools(remoteClient);
    cachedRemoteTools = remoteTools;
    saveRemoteTools(serverUrl, remoteTools);
    tools.push(...remoteTools);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLine("tools-list.fetch-failed", { label: "tools/list", msg });
    tools.push(...cachedRemoteTools);
  } finally {
    await remoteClient.close();
  }

  return { tools };
});

function applyPastedCallbackUrl(
  args: Record<string, unknown>,
  label: string,
): { kind: "proceed" } | { kind: "failed"; text: string; isError?: boolean } {
  const raw = args.callback_url;
  if (raw === undefined || raw === null || raw === "") {
    return { kind: "proceed" };
  }
  if (typeof raw !== "string") {
    return {
      kind: "failed",
      text: "callback_url must be a string.",
      isError: true,
    };
  }
  const authProvider = getOAuthProvider();
  if (!authProvider.authorizationUrl || !authProvider.codeVerifier()) {
    logLine("callback_url.no-pending-auth", { label });
    return {
      kind: "failed",
      text:
        "No pending authentication flow found. The callback_url parameter " +
        "is only valid after a prior call returned [AUTHENTICATION_REQUIRED]. " +
        "Please initiate the tool call without callback_url first.",
      isError: true,
    };
  }
  const code = extractAuthCode(raw);
  if (!code) {
    logLine("callback_url.bad-paste", { label, pastedLen: raw.length });
    return {
      kind: "failed",
      text:
        "Could not find a `code` parameter in the pasted callback_url. " +
        "Make sure you used the \"Copy URL\" button on the Glean sign-in " +
        "success page (the copied URL contains `?code=...`), then paste " +
        "that full URL into chat and retry.",
      isError: true,
    };
  }
  authProvider.setPendingAuthCode(code);
  logLine("callback_url.code-accepted", { label, codeLen: code.length });
  return { kind: "proceed" };
}

function authRequiredText(authUrl: string): string {
  return (
    `[AUTHENTICATION_REQUIRED]\n\nThe user must sign in to Glean. ` +
    `Render this link as markdown: [Connect to Glean](<${authUrl}>)\n\n` +
    `After signing in, the browser lands on a Glean callback page with ` +
    `a "Copy URL" button. The user should click Copy URL, paste the URL ` +
    `into chat, and the original request should be retried with that ` +
    `URL passed as the callback_url argument — the server will extract ` +
    `the code and finish sign-in.\n\n` +
    `Share the sign-in link with the user, then stop and wait for them ` +
    `to paste the callback URL before retrying.`
  );
}

/**
 * Drive the setup flow forward until either complete (URL ✓ + tokens ✓ +
 * dynamic tools fetched ✓) or blocked on a user action (paste server URL,
 * paste callback URL). Used both by `setup()` with no args and as the
 * tail of `setup({server_url})` / `setup({callback_url})`.
 */
async function advanceSetup(): Promise<CallToolResult> {
  const serverUrl = resolveServerUrl();
  if (!serverUrl) {
    return { content: [{ type: "text", text: SETUP_REQUIRED_TEXT }] };
  }

  // Stage 2 (auth) and stage 3 (tool fetch) both require opening a remote
  // client. The same call drives whichever is missing: connect triggers
  // OAuth if tokens are absent (or finalizes a paste-back code), and
  // fetchAllowedRemoteTools populates the cache on success.
  let remoteClient;
  try {
    remoteClient = await createRemoteClient(
      serverUrl,
      getRemoteClientOpts(),
      `setup-${process.pid}`,
    );
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return {
        content: [{ type: "text", text: authRequiredText(err.authUrl) }],
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logLine("connect.backend-error", { label: "setup", msg });
    return {
      content: [
        { type: "text", text: `Failed to connect to Glean backend: ${msg}` },
      ],
      isError: true,
    };
  }

  try {
    const remoteTools = await fetchAllowedRemoteTools(remoteClient);
    cachedRemoteTools = remoteTools;
    saveRemoteTools(serverUrl, remoteTools);
    const toolNames = remoteTools.map((t) => t.name).join(", ") || "(none)";
    return {
      content: [
        {
          type: "text",
          text:
            `Glean setup is complete.\n` +
            `Server URL: ${serverUrl}\n` +
            `Authenticated: yes\n` +
            `Remote tools: ${toolNames}\n\n` +
            `You can now use find_skills, run_tool, and any of the listed ` +
            `remote tools.`,
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLine("setup.fetch-tools-failed", { msg });
    return {
      content: [
        {
          type: "text",
          text:
            `Authenticated, but failed to fetch the remote tool catalog: ${msg}.\n` +
            `Server URL: ${serverUrl}\n\n` +
            `Try calling setup again to retry, or setup({reset:true}) to ` +
            `start over.`,
        },
      ],
      isError: true,
    };
  } finally {
    await remoteClient.close();
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  // Allow-listed remote tools (chat/search/read_document) — only valid once
  // setup has provided a server URL. Auth is handled by dispatchRemoteTool
  // via the standard [AUTHENTICATION_REQUIRED] flow.
  if (REMOTE_TOOLS_ALLOWLIST.has(name)) {
    // First-class tools run directly. A single call belongs here, not in
    // run_code (which is scoped to batches); they remain usable as PTC_<name>
    // inside run_code when the model is batching/composing.
    const serverUrl = resolveServerUrl();
    if (!serverUrl) {
      return {
        content: [{ type: "text", text: SETUP_NEEDED_ERROR }],
        isError: true,
      };
    }
    // Pre-check tokens so an unauth'd call doesn't reach
    // dispatchRemoteTool → createRemoteClient → SDK 401 →
    // redirectToAuthorization (which opens the browser). Only `setup`
    // is allowed to drive the OAuth flow.
    if (!getOAuthProvider().tokens()) {
      return {
        content: [{ type: "text", text: AUTH_REDIRECT_TO_SETUP_TEXT }],
      };
    }
    const dispatchCtx: DispatchContext = {
      serverUrl,
      remoteClientOpts: getRemoteClientOpts(),
      authRedirectText: AUTH_REDIRECT_TO_SETUP_TEXT,
      logLine,
    };
    return await dispatchRemoteTool(name, args, dispatchCtx);
  }

  switch (name) {
    case "find_skills": {
      const serverUrl = resolveServerUrl();
      if (!serverUrl) {
        return {
          content: [{ type: "text", text: SETUP_NEEDED_ERROR }],
          isError: true,
        };
      }

      // Pre-check tokens before connecting so an unauth'd call doesn't
      // trip the SDK's 401 → redirectToAuthorization path (which opens a
      // browser tab). Only `setup` should ever drive OAuth.
      if (!getOAuthProvider().tokens()) {
        return {
          content: [{ type: "text", text: AUTH_REDIRECT_TO_SETUP_TEXT }],
        };
      }

      const sessionId = resolveSessionId();

      const skillsBaseDir = resolveSkillsBaseDir();

      let remoteClient;
      try {
        remoteClient = await createRemoteClient(
          serverUrl,
          getRemoteClientOpts(),
          sessionId,
        );
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return {
            content: [{ type: "text", text: AUTH_REDIRECT_TO_SETUP_TEXT }],
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        logLine("connect.backend-error", { label: "find_skills", msg });
        return {
          content: [
            {
              type: "text",
              text: `Failed to connect to Glean backend: ${msg}`,
            },
          ],
          isError: true,
        };
      }
      try {
        const text = await handleFindSkills(
          remoteClient,
          skillsBaseDir,
          args,
          { codeMode: RUN_CODE_ENABLED },
        );
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`find_skills: execution failed: ${msg}`);
        return {
          content: [{ type: "text", text: `find_skills failed: ${msg}` }],
          isError: true,
        };
      } finally {
        await remoteClient.close();
      }
    }

    case "run_tool": {
      const serverUrl = resolveServerUrl();
      if (!serverUrl) {
        return {
          content: [{ type: "text", text: SETUP_NEEDED_ERROR }],
          isError: true,
        };
      }

      // Pre-check tokens before connecting so an unauth'd call doesn't
      // trip the SDK's 401 → redirectToAuthorization path (which opens a
      // browser tab). Only `setup` should ever drive OAuth.
      if (!getOAuthProvider().tokens()) {
        return {
          content: [{ type: "text", text: AUTH_REDIRECT_TO_SETUP_TEXT }],
        };
      }

      const sessionId = resolveSessionId();

      let remoteClient;
      try {
        remoteClient = await createRemoteClient(
          serverUrl,
          getRemoteClientOpts(),
          sessionId,
        );
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return {
            content: [{ type: "text", text: AUTH_REDIRECT_TO_SETUP_TEXT }],
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        logLine("connect.backend-error", { label: "run_tool", msg });
        return {
          content: [
            {
              type: "text",
              text: `Failed to connect to Glean backend: ${msg}`,
            },
          ],
          isError: true,
        };
      }
      try {
        const skillsBaseDir = resolveSkillsBaseDir();
        return await handleRunTool(remoteClient, server, skillsBaseDir, args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`run_tool: execution failed: ${msg}`);
        return {
          content: [{ type: "text", text: `run_tool failed: ${msg}` }],
          isError: true,
        };
      } finally {
        await remoteClient.close();
      }
    }

    case "run_code": {
      if (!RUN_CODE_ENABLED) {
        return {
          content: [{ type: "text", text: "run_code is not enabled." }],
          isError: true,
        };
      }

      const serverUrl = resolveServerUrl();
      if (!serverUrl) {
        return {
          content: [{ type: "text", text: SETUP_NEEDED_ERROR }],
          isError: true,
        };
      }
      if (!getOAuthProvider().tokens()) {
        return {
          content: [{ type: "text", text: AUTH_REDIRECT_TO_SETUP_TEXT }],
        };
      }

      const sessionId = resolveSessionId();

      let remoteClient;
      try {
        remoteClient = await createRemoteClient(
          serverUrl,
          getRemoteClientOpts(),
          sessionId,
        );
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          return {
            content: [{ type: "text", text: AUTH_REDIRECT_TO_SETUP_TEXT }],
          };
        }
        const msg = err instanceof Error ? err.message : String(err);
        logLine("connect.backend-error", { label: "run_code", msg });
        return {
          content: [
            { type: "text", text: `Failed to connect to Glean backend: ${msg}` },
          ],
          isError: true,
        };
      }
      try {
        const skillsBaseDir = resolveSkillsBaseDir();
        return await handleRunCode(
          remoteClient,
          server,
          skillsBaseDir,
          args,
          cachedRemoteTools,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`run_code: execution failed: ${msg}`);
        return {
          content: [{ type: "text", text: `run_code failed: ${msg}` }],
          isError: true,
        };
      } finally {
        await remoteClient.close();
      }
    }

    case "setup": {
      if (args.reset === true) {
        clearServerUrl();
        clearCredentials();
        deletePending();
        clearRemoteTools();
        oauthProvider = undefined;
        cachedRemoteTools = [];
        logLine("setup.reset");
        // Fire-and-forget — tools list is shorter without the dynamic
        // surface; the host should re-fetch on its next idle cycle.
        server.sendToolListChanged().catch(() => {
          /* transport may not be connected yet; harmless */
        });
        return {
          content: [
            {
              type: "text",
              text:
                "Glean configuration has been reset. Call setup again with " +
                "server_url to reconfigure.",
            },
          ],
        };
      }

      const rawUrl =
        typeof args.server_url === "string" ? args.server_url.trim() : "";

      if (rawUrl) {
        let normalized: string;
        try {
          normalized = normalizeServerUrl(rawUrl);
        } catch {
          return {
            content: [
              {
                type: "text",
                text:
                  `Invalid URL: "${rawUrl}". Please provide the Server instance (QE) URL ` +
                  `from https://app.glean.com/admin/about-glean ` +
                  `(e.g. https://acme-be.glean.com).`,
              },
            ],
            isError: true,
          };
        }

        try {
          saveServerUrl(normalized);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              { type: "text", text: `Failed to save configuration: ${msg}` },
            ],
            isError: true,
          };
        }

        // New instance — clear stale auth state. The on-disk remote-tool
        // cache for the previous URL is left intact (so switching back is
        // instant); we just rehydrate from whatever cache exists for the
        // newly configured URL — empty for a first-time server.
        clearCredentials();
        deletePending();
        oauthProvider = undefined;
        cachedRemoteTools = loadRemoteTools(normalized);
        logLine("setup.configured", { serverUrl: normalized });
        // Fall through to advanceSetup, which will now find URL ✓ and try
        // to drive auth + tool fetch in the same call.
      }

      const callbackApplied = applyPastedCallbackUrl(args, "setup");
      if (callbackApplied.kind === "failed") {
        return {
          content: [{ type: "text", text: callbackApplied.text }],
          ...(callbackApplied.isError ? { isError: true } : {}),
        };
      }

      return await advanceSetup();
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

async function main() {
  // Run once per session at MCP server startup.
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  try {
    await evictStaleSkills(resolveSkillsBaseDir(), ONE_WEEK_MS, logLine);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logLine("evict-stale-skills.failed", { msg });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
