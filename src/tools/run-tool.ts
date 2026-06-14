import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { callRemoteTool } from "../remote-client.js";
import { findToolMeta } from "../skill-tools.js";

const HITL_ENABLED = process.env.ENABLE_HITL === "true";
const DEFAULT_FILE_ARG_MAX_BYTES = 1 * 1024 * 1024;

export class FileArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileArgsError";
  }
}

function fileArgsMaxBytes(): number {
  const raw = process.env.GLEAN_FILE_ARG_MAX_BYTES;
  if (!raw) return DEFAULT_FILE_ARG_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_FILE_ARG_MAX_BYTES;
}

/**
 * Reads each `file_args` entry from disk and merges its UTF-8 content into
 * `baseArgs` under the given key. Throws FileArgsError on any validation
 * failure so the caller can surface the message verbatim to the model.
 */
export async function resolveFileArgs(
  fileArgs: unknown,
  baseArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (fileArgs === undefined || fileArgs === null) return baseArgs;
  if (
    typeof fileArgs !== "object" ||
    Array.isArray(fileArgs)
  ) {
    throw new FileArgsError(
      "file_args must be an object mapping arg name to absolute file path",
    );
  }

  const entries = Object.entries(fileArgs as Record<string, unknown>);
  if (entries.length === 0) return baseArgs;

  const merged: Record<string, unknown> = { ...baseArgs };
  const maxBytes = fileArgsMaxBytes();

  for (const [argName, filePathRaw] of entries) {
    if (typeof filePathRaw !== "string" || filePathRaw === "") {
      throw new FileArgsError(
        `file_args.${argName} must be a non-empty string path`,
      );
    }
    if (!path.isAbsolute(filePathRaw)) {
      throw new FileArgsError(
        `file_args.${argName} must be an absolute path; got "${filePathRaw}"`,
      );
    }
    if (argName in baseArgs) {
      throw new FileArgsError(
        `file_args.${argName} conflicts with arguments.${argName}; remove one`,
      );
    }

    let stat;
    try {
      stat = await fs.stat(filePathRaw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new FileArgsError(
        `file_args.${argName}: cannot read "${filePathRaw}": ${msg}`,
      );
    }
    if (!stat.isFile()) {
      throw new FileArgsError(
        `file_args.${argName}: "${filePathRaw}" is not a regular file`,
      );
    }
    if (stat.size > maxBytes) {
      throw new FileArgsError(
        `file_args.${argName}: "${filePathRaw}" is ${stat.size} bytes, exceeds ${maxBytes} byte limit (set GLEAN_FILE_ARG_MAX_BYTES to override)`,
      );
    }

    merged[argName] = await fs.readFile(filePathRaw, "utf-8");
  }

  return merged;
}

export type ApprovalOutcome =
  | { kind: "approved" }
  | { kind: "declined"; action: string };

/**
 * Per-tool HITL gate, shared by run_tool and run_code's just-in-time path.
 *
 * Auto-approves unless ALL of: ENABLE_HITL is set, the client supports
 * elicitation, and the tool JSON marks `requires_approval`. On an elicitation
 * transport error the behavior depends on `failClosed`: run_tool keeps its
 * historical fail-OPEN behavior (executes anyway); run_code passes
 * failClosed=true so a broken approval channel never silently runs a write.
 */
export async function requestToolApproval(
  mcpServer: Server,
  skillsBaseDir: string,
  toolName: string,
  serverId: string,
  opts: { message?: string; failClosed?: boolean } = {},
): Promise<ApprovalOutcome> {
  if (!HITL_ENABLED || !mcpServer.getClientCapabilities()?.elicitation) {
    return { kind: "approved" };
  }
  const { meta } = await findToolMeta(skillsBaseDir, toolName);
  if (!meta?.requiresApproval) return { kind: "approved" };

  const message =
    opts.message ??
    [
      `**Action: ${toolName}**`,
      meta.description || "",
      `Server: ${serverId}`,
      "",
      "Accept to execute, or decline to cancel.",
    ]
      .filter(Boolean)
      .join("\n");

  try {
    const result = await mcpServer.elicitInput({
      message,
      requestedSchema: { type: "object", properties: {} } as never,
    });
    if (result.action !== "accept") {
      return { kind: "declined", action: result.action };
    }
    return { kind: "approved" };
  } catch {
    return opts.failClosed
      ? { kind: "declined", action: "elicitation-error" }
      : { kind: "approved" };
  }
}

/**
 * Pure dispatch core — no approval. Resolves file_args, shapes the remote
 * payload, and calls the gateway's `run_tool`. Shared by run_tool and every
 * run_code PTC_ binding so auth, file_args, and the wire shape live in one
 * place. Throws FileArgsError on bad file_args (caller surfaces it).
 */
export async function invokeTool(
  remoteClient: Client,
  params: {
    serverId: string;
    toolName: string;
    arguments?: unknown;
    fileArgs?: unknown;
  },
): Promise<CallToolResult> {
  const baseArgs =
    params.arguments != null && typeof params.arguments === "object"
      ? (params.arguments as Record<string, unknown>)
      : {};
  const resolvedArgs = await resolveFileArgs(params.fileArgs, baseArgs);

  return callRemoteTool(
    remoteClient,
    "run_tool",
    buildRemoteArgs(params.serverId, params.toolName, resolvedArgs),
  );
}

/**
 * Assemble the payload for the backend `run_tool` meta-tool. `arguments` is
 * ALWAYS included, even when empty: the downstream MCP `tools/call` validates
 * `params.arguments` as an object, and an absent field serializes to `null`,
 * which strict downstream servers reject ("Expected: object, given: null").
 * Sending an explicit `{}` for no-argument tools matches what the MCP SDK
 * does for direct tool calls.
 */
export function buildRemoteArgs(
  serverId: string,
  toolName: string,
  resolvedArgs: Record<string, unknown>,
): Record<string, unknown> {
  return {
    server_id: serverId,
    tool_name: toolName,
    arguments: resolvedArgs,
  };
}

export async function handleRunTool(
  remoteClient: Client,
  mcpServer: Server,
  skillsBaseDir: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const serverId = args.server_id;
  const toolName = args.tool_name;

  if (typeof serverId !== "string" || typeof toolName !== "string") {
    return {
      content: [
        { type: "text", text: "server_id and tool_name are required strings" },
      ],
      isError: true,
    };
  }

  const approval = await requestToolApproval(
    mcpServer,
    skillsBaseDir,
    toolName,
    serverId,
  );
  if (approval.kind === "declined") {
    return {
      content: [
        {
          type: "text",
          text: `Action ${toolName} was ${approval.action === "decline" ? "declined" : "cancelled"} by the user.`,
        },
      ],
    };
  }

  try {
    return await invokeTool(remoteClient, {
      serverId,
      toolName,
      arguments: args.arguments,
      fileArgs: args.file_args,
    });
  } catch (err) {
    if (err instanceof FileArgsError) {
      return {
        content: [{ type: "text", text: err.message }],
        isError: true,
      };
    }
    throw err;
  }
}
