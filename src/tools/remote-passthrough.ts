import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  AuthRequiredError,
  callRemoteTool,
  createRemoteClient,
  type RemoteClientOptions,
} from "../remote-client.js";

// `chat` is intentionally excluded for now: the upstream Glean MCP backend
// keeps returning "Error running chat tool: response contains message of
// type ERROR" with no structured detail, so surfacing it would expose a
// broken first-class tool. Re-add once the backend is healthy.
export const REMOTE_TOOLS_ALLOWLIST: ReadonlySet<string> = new Set([
  "search",
  "read_document",
]);

type ToolInputSchema = Tool["inputSchema"];

/**
 * Normalize the remote tool's input schema into the shape MCP expects for
 * a registered tool (object root with `properties`/`required`). Promoted
 * tools forward whatever the agent supplies straight through; no
 * plugin-only keys are spliced in.
 */
export function augmentSchemaForLocal(schema: unknown): ToolInputSchema {
  const base =
    schema && typeof schema === "object" && !Array.isArray(schema)
      ? structuredClone(schema as Record<string, unknown>)
      : {};

  const properties = (base.properties as Record<string, unknown>) ?? {};
  const required = Array.isArray(base.required)
    ? (base.required as string[])
    : [];

  return {
    ...base,
    type: "object",
    properties,
    required,
  } as ToolInputSchema;
}

/**
 * List tools on the remote MCP server, filter to the allow-list, and return
 * each surviving tool with its input schema augmented for local exposure.
 *
 * Walks pagination cursors to exhaustion in case the remote ever paginates.
 */
export async function fetchAllowedRemoteTools(
  remoteClient: Client,
): Promise<Tool[]> {
  const collected: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await remoteClient.listTools(
      cursor ? { cursor } : undefined,
    );
    for (const tool of page.tools) {
      if (!REMOTE_TOOLS_ALLOWLIST.has(tool.name)) continue;
      collected.push({
        ...tool,
        inputSchema: augmentSchemaForLocal(tool.inputSchema),
      } as Tool);
    }
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
  } while (cursor);
  return collected;
}

export interface DispatchContext {
  serverUrl: string;
  remoteClientOpts: RemoteClientOptions;
  authRedirectText: string;
  logLine: (label: string, detail?: Record<string, unknown>) => void;
}

/**
 * Dispatch a call to an allow-listed remote MCP tool. Opens a remote
 * client, calls through, and returns the unwrapped CallToolResult. When
 * auth is missing we return a "call setup first" envelope rather than
 * driving OAuth here — that's the setup tool's job.
 */
export async function dispatchRemoteTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<CallToolResult> {
  let remoteClient: Client;
  try {
    remoteClient = await createRemoteClient(
      ctx.serverUrl,
      ctx.remoteClientOpts,
    );
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return {
        content: [{ type: "text", text: ctx.authRedirectText }],
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    ctx.logLine("connect.backend-error", { label: toolName, msg });
    return {
      content: [
        { type: "text", text: `Failed to connect to Glean backend: ${msg}` },
      ],
      isError: true,
    };
  }

  try {
    const result = await callRemoteTool(remoteClient, toolName, args);
    if (result.isError) {
      ctx.logLine("dispatch.remote-isError", {
        label: toolName,
        rawResult: JSON.stringify(result).slice(0, 8000),
      });
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const detail: Record<string, unknown> = { label: toolName, msg };
    if (err && typeof err === "object") {
      const anyErr = err as Record<string, unknown>;
      if (anyErr.code !== undefined) detail.code = anyErr.code;
      if (anyErr.data !== undefined) detail.data = anyErr.data;
      if (err instanceof Error && err.cause !== undefined) {
        detail.cause =
          err.cause instanceof Error ? err.cause.message : err.cause;
      }
    }
    ctx.logLine("dispatch.execution-failed", detail);
    return {
      content: [{ type: "text", text: `${toolName} failed: ${msg}` }],
      isError: true,
    };
  } finally {
    await remoteClient.close();
  }
}
