import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  resolveFileArgs,
  buildRemoteArgs,
  FileArgsError,
  handleRunTool,
  runToolAnnotations,
} from "../src/tools/run-tool.js";

describe("resolveFileArgs", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-args-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env.GLEAN_FILE_ARG_MAX_BYTES;
  });

  it("returns base args unchanged when file_args is undefined", async () => {
    const result = await resolveFileArgs(undefined, { a: 1 });
    expect(result).toEqual({ a: 1 });
  });

  it("returns base args unchanged when file_args is null", async () => {
    const result = await resolveFileArgs(null, { a: 1 });
    expect(result).toEqual({ a: 1 });
  });

  it("returns base args unchanged when file_args is empty", async () => {
    const result = await resolveFileArgs({}, { a: 1 });
    expect(result).toEqual({ a: 1 });
  });

  it("reads file content and merges into args", async () => {
    const file = path.join(tmpDir, "draft.md");
    await fs.writeFile(file, "# Hello world\n\nlong content");

    const result = await resolveFileArgs({ body: file }, { channel: "C1" });

    expect(result).toEqual({
      channel: "C1",
      body: "# Hello world\n\nlong content",
    });
  });

  it("supports multiple file_args entries", async () => {
    const a = path.join(tmpDir, "a.md");
    const b = path.join(tmpDir, "b.md");
    await fs.writeFile(a, "content A");
    await fs.writeFile(b, "content B");

    const result = await resolveFileArgs(
      { body: a, summary: b },
      { channel: "C1" },
    );

    expect(result).toEqual({
      channel: "C1",
      body: "content A",
      summary: "content B",
    });
  });

  it("throws when file_args is not an object", async () => {
    await expect(resolveFileArgs("nope", {})).rejects.toThrow(FileArgsError);
    await expect(resolveFileArgs("nope", {})).rejects.toThrow(
      /must be an object/,
    );
  });

  it("throws when file_args is an array", async () => {
    await expect(resolveFileArgs(["a", "b"], {})).rejects.toThrow(
      /must be an object/,
    );
  });

  it("throws when path is not a string", async () => {
    await expect(
      resolveFileArgs({ body: 42 }, {}),
    ).rejects.toThrow(/non-empty string/);
  });

  it("throws when path is empty string", async () => {
    await expect(
      resolveFileArgs({ body: "" }, {}),
    ).rejects.toThrow(/non-empty string/);
  });

  it("throws when path is not absolute", async () => {
    await expect(
      resolveFileArgs({ body: "draft.md" }, {}),
    ).rejects.toThrow(/absolute/);
  });

  it("throws when file does not exist", async () => {
    await expect(
      resolveFileArgs({ body: path.join(tmpDir, "nope.md") }, {}),
    ).rejects.toThrow(FileArgsError);
  });

  it("throws when path is a directory", async () => {
    await expect(
      resolveFileArgs({ body: tmpDir }, {}),
    ).rejects.toThrow(/regular file/);
  });

  it("throws when file exceeds size cap", async () => {
    process.env.GLEAN_FILE_ARG_MAX_BYTES = "10";
    const file = path.join(tmpDir, "big.md");
    await fs.writeFile(file, "this is more than 10 bytes");

    await expect(resolveFileArgs({ body: file }, {})).rejects.toThrow(
      /exceeds.*limit/,
    );
  });

  it("respects GLEAN_FILE_ARG_MAX_BYTES override", async () => {
    process.env.GLEAN_FILE_ARG_MAX_BYTES = "100";
    const file = path.join(tmpDir, "ok.md");
    await fs.writeFile(file, "small content");

    const result = await resolveFileArgs({ body: file }, {});
    expect(result.body).toBe("small content");
  });

  it("throws when file_args key conflicts with arguments key", async () => {
    const file = path.join(tmpDir, "draft.md");
    await fs.writeFile(file, "content");

    await expect(
      resolveFileArgs({ body: file }, { body: "existing" }),
    ).rejects.toThrow(/conflicts/);
  });
});

describe("buildRemoteArgs", () => {
  // Regression: a no-argument downstream call (e.g. slack_read_user_profile)
  // must forward `arguments: {}`, not omit the key. An absent field serializes
  // to null downstream, which strict MCP servers reject.
  it("always includes arguments, even when empty", () => {
    expect(buildRemoteArgs("srv", "tool", {})).toEqual({
      server_id: "srv",
      tool_name: "tool",
      arguments: {},
    });
  });

  it("forwards populated arguments unchanged", () => {
    expect(
      buildRemoteArgs("srv", "tool", { response_format: "detailed" }),
    ).toEqual({
      server_id: "srv",
      tool_name: "tool",
      arguments: { response_format: "detailed" },
    });
  });
});

function makeRemote() {
  return {
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    }),
    close: vi.fn(),
  } as any;
}

function makeServer(opts: {
  elicitation?: boolean;
  clientName?: string;
  elicit?: ReturnType<typeof vi.fn>;
}) {
  return {
    getClientCapabilities: vi
      .fn()
      .mockReturnValue(opts.elicitation ? { elicitation: {} } : {}),
    getClientVersion: vi
      .fn()
      .mockReturnValue({ name: opts.clientName ?? "claude-code", version: "1" }),
    elicitInput: opts.elicit ?? vi.fn().mockResolvedValue({ action: "accept" }),
  } as any;
}

async function writeToolJson(
  baseDir: string,
  toolName: string,
  meta: Record<string, unknown>,
) {
  const toolsDir = path.join(baseDir, "some-skill", "tools");
  await fs.mkdir(toolsDir, { recursive: true });
  await fs.writeFile(
    path.join(toolsDir, `${toolName}.json`),
    JSON.stringify(meta),
    "utf-8",
  );
}

describe("handleRunTool (HITL)", () => {
  let tmpDir: string;
  const baseArgs = {
    server_id: "composio/jira-pack",
    tool_name: "jirasearch",
    arguments: { project: "ABC", summary: "fix login" },
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-tool-hitl-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("does not elicit when the client lacks elicitation capability", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const server = makeServer({ elicitation: false });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(server.elicitInput).not.toHaveBeenCalled();
    expect(remote.callTool).toHaveBeenCalledTimes(1);
  });

  it("does not elicit when the tool does not require approval", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const server = makeServer({ elicitation: true });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: false });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(server.elicitInput).not.toHaveBeenCalled();
    expect(remote.callTool).toHaveBeenCalledTimes(1);
  });

  it("prompts with action name + arguments and forwards on accept", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "accept" });
    const server = makeServer({ elicitation: true, elicit });
    await writeToolJson(tmpDir, "jirasearch", {
      requires_approval: true,
      description: "Search Jira issues",
    });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    const [params, options] = elicit.mock.calls[0];
    expect(params.message).toContain("Action: jirasearch");
    expect(params.message).toContain('"project": "ABC"');
    expect(params.message).not.toContain("Server:");
    expect(params.message).not.toContain("Search Jira issues");
    expect(params.message).not.toContain("**");
    expect(options.timeout).toBe(300_000);
    expect(remote.callTool).toHaveBeenCalledTimes(1);
  });

  it("honors the HITL_TIMEOUT_MS override", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    vi.stubEnv("HITL_TIMEOUT_MS", "5000");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "accept" });
    const server = makeServer({ elicitation: true, elicit });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(elicit.mock.calls[0][1].timeout).toBe(5000);
  });

  it("falls back to the default timeout for invalid HITL_TIMEOUT_MS", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    for (const bad of ["0", "-1", "abc", ""]) {
      vi.stubEnv("HITL_TIMEOUT_MS", bad);
      const remote = makeRemote();
      const elicit = vi.fn().mockResolvedValue({ action: "accept" });
      const server = makeServer({ elicitation: true, elicit });

      await handleRunTool(remote, server, tmpDir, baseArgs);

      expect(elicit.mock.calls[0][1].timeout).toBe(300_000);
    }
  });

  it("does not execute when the user declines", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "decline" });
    const server = makeServer({ elicitation: true, elicit });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    const result = await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(remote.callTool).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain("declined");
  });

  it("fails closed and does NOT execute when elicitation times out", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const elicit = vi.fn().mockRejectedValue(new Error("Request timed out"));
    const server = makeServer({ elicitation: true, elicit });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    const result = await handleRunTool(remote, server, tmpDir, baseArgs);

    expect(remote.callTool).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not approved");
    expect(text).toContain("NOT executed");
  });

  it("gives Cursor a one-line prompt without an arguments block", async () => {
    vi.stubEnv("ENABLE_HITL", "true");
    const remote = makeRemote();
    const elicit = vi.fn().mockResolvedValue({ action: "accept" });
    const server = makeServer({
      elicitation: true,
      clientName: "cursor-vscode",
      elicit,
    });
    await writeToolJson(tmpDir, "jirasearch", { requires_approval: true });

    await handleRunTool(remote, server, tmpDir, baseArgs);

    const message = elicit.mock.calls[0][0].message as string;
    expect(message).toContain('accept to run "jirasearch"');
    expect(message).not.toContain("Arguments:");
    expect(remote.callTool).toHaveBeenCalledTimes(1);
  });
});

describe("runToolAnnotations", () => {
  it("marks run_tool read-only when HITL gates an elicitation-capable client", () => {
    expect(runToolAnnotations(true, true)).toEqual({ readOnlyHint: true });
  });

  it("leaves annotations unset when HITL is disabled", () => {
    expect(runToolAnnotations(false, true)).toBeUndefined();
  });

  it("leaves annotations unset when the client cannot elicit", () => {
    expect(runToolAnnotations(true, false)).toBeUndefined();
  });
});
