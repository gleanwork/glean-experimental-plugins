import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  REMOTE_TOOLS_ALLOWLIST,
  augmentSchemaForLocal,
  dispatchRemoteTool,
  fetchAllowedRemoteTools,
  type DispatchContext,
} from "../src/tools/remote-passthrough.js";

vi.mock("../src/remote-client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/remote-client.js")>(
    "../src/remote-client.js",
  );
  return {
    ...actual,
    createRemoteClient: vi.fn(),
    callRemoteTool: vi.fn(),
  };
});

const remoteClientModule = await import("../src/remote-client.js");
const { createRemoteClient, callRemoteTool, AuthRequiredError } =
  remoteClientModule;

const mockedCreate = vi.mocked(createRemoteClient);
const mockedCall = vi.mocked(callRemoteTool);

function makeCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    serverUrl: "https://example/mcp",
    remoteClientOpts: {},
    authRedirectText:
      "[SETUP_REQUIRED]\n\nAuthentication is required. Call the `setup` tool " +
      "(no arguments) to sign in to Glean, then retry this tool.",
    logLine: vi.fn(),
    ...overrides,
  };
}

describe("REMOTE_TOOLS_ALLOWLIST", () => {
  it("contains exactly search and read_document (chat is excluded while broken)", () => {
    expect([...REMOTE_TOOLS_ALLOWLIST].sort()).toEqual([
      "read_document",
      "search",
    ]);
  });
});

describe("augmentSchemaForLocal", () => {
  it("preserves the remote schema as-is and does not splice plugin-only keys", () => {
    const result = augmentSchemaForLocal({
      type: "object",
      properties: { messages: { type: "array" } },
      required: ["messages"],
    });

    expect(result.properties).toMatchObject({
      messages: { type: "array" },
    });
    expect(result.properties).not.toHaveProperty("callback_url");
    expect(result.required).toEqual(["messages"]);
  });

  it("handles a schema with no properties or required", () => {
    const result = augmentSchemaForLocal({ type: "object" });

    expect(result.type).toBe("object");
    expect(result.properties).toEqual({});
    expect(result.required).toEqual([]);
  });

  it("handles non-object schema input by returning a fresh object schema", () => {
    const result = augmentSchemaForLocal(undefined);

    expect(result.type).toBe("object");
    expect(result.properties).toEqual({});
    expect(result.required).toEqual([]);
  });

  it("does not mutate the input schema", () => {
    const input = {
      type: "object",
      properties: { foo: { type: "string" } },
      required: ["foo"],
    };
    const before = JSON.stringify(input);
    augmentSchemaForLocal(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("fetchAllowedRemoteTools", () => {
  function clientWithPages(pages: Array<{ tools: any[]; nextCursor?: string }>) {
    const calls: Array<{ cursor?: string }> = [];
    const listTools = vi.fn(async (params?: { cursor?: string }) => {
      calls.push({ cursor: params?.cursor });
      return pages.shift() ?? { tools: [] };
    });
    return { listTools, calls } as any;
  }

  it("filters to allow-listed tools and augments their schemas", async () => {
    const client = clientWithPages([
      {
        tools: [
          { name: "chat", description: "Chat (excluded)", inputSchema: { type: "object", properties: {}, required: [] } },
          { name: "weird_unknown", description: "x", inputSchema: { type: "object" } },
          { name: "search", description: "Search", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
        ],
      },
    ]);

    const tools = await fetchAllowedRemoteTools(client);

    expect(tools.map((t) => t.name).sort()).toEqual(["search"]);
    const search = tools.find((t) => t.name === "search")!;
    expect(search.description).toBe("Search");
    expect(search.inputSchema.properties).toMatchObject({
      q: { type: "string" },
    });
    expect(search.inputSchema.properties).not.toHaveProperty("callback_url");
    expect(search.inputSchema.required).toEqual(["q"]);
  });

  it("walks nextCursor pagination to exhaustion", async () => {
    const client = clientWithPages([
      {
        tools: [
          { name: "search", description: "Search", inputSchema: { type: "object" } },
        ],
        nextCursor: "page2",
      },
      {
        tools: [
          { name: "read_document", description: "Read", inputSchema: { type: "object" } },
        ],
      },
    ]);

    const tools = await fetchAllowedRemoteTools(client);

    expect(tools.map((t) => t.name).sort()).toEqual(["read_document", "search"]);
    expect(client.listTools).toHaveBeenCalledTimes(2);
    expect(client.calls[0].cursor).toBeUndefined();
    expect(client.calls[1].cursor).toBe("page2");
  });

  it("returns empty array when no allow-listed tools exist", async () => {
    const client = clientWithPages([
      { tools: [{ name: "irrelevant", description: "", inputSchema: { type: "object" } }] },
    ]);

    const tools = await fetchAllowedRemoteTools(client);
    expect(tools).toEqual([]);
  });
});

describe("dispatchRemoteTool", () => {
  beforeEach(() => {
    mockedCreate.mockReset();
    mockedCall.mockReset();
  });

  function makeRemote(): any {
    return { close: vi.fn().mockResolvedValue(undefined) };
  }

  it("returns the unwrapped CallToolResult from the remote", async () => {
    const remote = makeRemote();
    mockedCreate.mockResolvedValue(remote);
    mockedCall.mockResolvedValue({
      content: [{ type: "text", text: "remote response" }],
    });

    const ctx = makeCtx();
    const result = await dispatchRemoteTool(
      "search",
      { q: "hello" },
      ctx,
    );

    expect(result).toEqual({
      content: [{ type: "text", text: "remote response" }],
    });
  });

  it("returns setup-redirect envelope on AuthRequiredError", async () => {
    mockedCreate.mockRejectedValue(new AuthRequiredError("https://signin.example/auth"));

    const ctx = makeCtx();
    const result = await dispatchRemoteTool("chat", {}, ctx);

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as any).text).toContain("[SETUP_REQUIRED]");
    expect((result.content[0] as any).text).toContain("setup");
  });

  it("returns isError envelope on other createRemoteClient failures", async () => {
    mockedCreate.mockRejectedValue(new Error("ECONNREFUSED"));

    const ctx = makeCtx();
    const result = await dispatchRemoteTool("chat", {}, ctx);

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("ECONNREFUSED");
    expect(ctx.logLine).toHaveBeenCalledWith(
      "connect.backend-error",
      expect.objectContaining({ label: "chat" }),
    );
  });

  it("closes the remote client when callRemoteTool throws", async () => {
    const remote = makeRemote();
    mockedCreate.mockResolvedValue(remote);
    mockedCall.mockRejectedValue(new Error("boom"));

    const ctx = makeCtx();
    const result = await dispatchRemoteTool(
      "chat",
      {},
      ctx,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as any).text).toContain("boom");
    expect(remote.close).toHaveBeenCalled();
    expect(ctx.logLine).toHaveBeenCalledWith(
      "dispatch.execution-failed",
      expect.objectContaining({ label: "chat", msg: "boom" }),
    );
  });
});
