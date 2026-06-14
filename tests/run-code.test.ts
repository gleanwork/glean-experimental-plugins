import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { handleRunCode } from "../src/tools/run-code.js";
import { loadObservedSchemas } from "../src/skill-tools.js";
import { formatAvailableSkillsPrompt } from "../src/skill-writer.js";

type Responder = (toolName: string, args: unknown) => unknown;

function makeClient(responder: Responder): Client {
  return {
    async callTool(req: { name: string; arguments: Record<string, unknown> }) {
      // run_tool (gateway) carries the real tool under arguments.tool_name;
      // a direct/head tool is called by its own name with raw args.
      const isGateway = req.name === "run_tool";
      const toolName = isGateway ? (req.arguments.tool_name as string) : req.name;
      const inner = isGateway ? req.arguments.arguments : req.arguments;
      return { content: [{ type: "text", text: JSON.stringify(responder(toolName, inner)) }] };
    },
  } as unknown as Client;
}

function makeServer(elicitation: boolean): Server {
  return {
    getClientCapabilities: () => (elicitation ? { elicitation: {} } : {}),
    async elicitInput() {
      return { action: "accept" };
    },
  } as unknown as Server;
}

function parseEnvelope(result: { content: { type: string; text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

describe("handleRunCode", () => {
  let dir: string;

  beforeEach(async () => {
    // These mechanics tests use single-call cells; turn the batch-only gate
    // off so they aren't rejected. The dedicated gate suite re-enables it.
    process.env.GLEAN_PTC_BATCH_ONLY = "false";
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "run-code-test-"));
    const toolsDir = path.join(dir, "demo", "tools");
    await fs.mkdir(toolsDir, { recursive: true });
    await fs.writeFile(
      path.join(toolsDir, "DEMO_SEARCH.json"),
      JSON.stringify({
        server_id: "srv-1",
        requires_approval: false,
        description: "Search demo items",
        inputSchema: { type: "object", properties: {} },
      }),
    );
  });

  afterEach(async () => {
    delete process.env.GLEAN_PTC_BATCH_ONLY;
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(path.resolve(dir, "..", "glean-run-code-results"), {
      recursive: true,
      force: true,
    });
  });

  it("returns the value VERBATIM, records the ledger, learns the shape", async () => {
    const client = makeClient(() => ({
      items: [{ id: 1, name: "alpha" }, { id: 2, name: "beta" }],
      total: 2,
    }));
    const result = await handleRunCode(client, makeServer(false), dir, {
      reset: true,
      code: `const r = await PTC_DEMO_SEARCH({ q: "x" }); return r.get("total");`,
    });
    const env = parseEnvelope(result as never);
    expect(env.ok).toBe(true);
    expect(env.value).toBe(2); // verbatim, not {shape, preview}
    expect(env.overflow).toBe(false);
    expect(env.ledger[0]).toMatchObject({ toolName: "DEMO_SEARCH", state: "committed" });
    expect(env.observed_schemas.DEMO_SEARCH).toContain("items: Array<");
  });

  it("returns a ToolResult's underlying data verbatim (unwrapped)", async () => {
    const client = makeClient(() => ({ items: [{ id: 1, name: "alpha" }], total: 1 }));
    const result = await handleRunCode(client, makeServer(false), dir, {
      reset: true,
      code: `return await PTC_DEMO_SEARCH({});`,
    });
    const env = parseEnvelope(result as never);
    expect(env.ok).toBe(true);
    expect(env.value.total).toBe(1);
    expect(env.value.items[0].name).toBe("alpha");
    expect("__isToolResult" in env.value).toBe(false);
  });

  it("inspect() returns SHAPE only — no sample values", async () => {
    const client = makeClient(() => ({ items: [{ id: 1, name: "alpha" }], total: 1 }));
    const result = await handleRunCode(client, makeServer(false), dir, {
      reset: true,
      code: `const r = await PTC_DEMO_SEARCH({}); inspect(r);`,
    });
    const env = parseEnvelope(result as never);
    expect(env.stdout).toContain("items: Array<");
    expect(env.stdout).toContain("id: number");
    expect(env.stdout).not.toContain("alpha"); // no values, shape only
  });

  it("prefers structuredContent for .json() and learns its shape", async () => {
    const client = {
      async callTool() {
        return {
          content: [{ type: "text", text: "human-readable, not JSON" }],
          structuredContent: { hits: 5, items: [{ id: 1 }] },
        };
      },
    } as unknown as Client;
    const result = await handleRunCode(client, makeServer(false), dir, {
      reset: true,
      code: `const r = await PTC_DEMO_SEARCH({}); return r.get("hits");`,
    });
    const env = parseEnvelope(result as never);
    expect(env.value).toBe(5); // from structuredContent, not the text
    expect(env.observed_schemas.DEMO_SEARCH).toContain("hits: number");
  });

  it("inspect() and .format report non-JSON text clearly (not just undefined)", async () => {
    const client = {
      async callTool() {
        return { content: [{ type: "text", text: "cursor: abc\ndocuments[2]:" }] };
      },
    } as unknown as Client;
    const result = await handleRunCode(client, makeServer(false), dir, {
      reset: true,
      code: `const r = await PTC_DEMO_SEARCH({}); print("format:", r.format); inspect(r);`,
    });
    const env = parseEnvelope(result as never);
    expect(env.stdout).toContain("format: text");
    expect(env.stdout).toContain("non-JSON text");
  });

  it(".format is 'json' for JSON output and 'empty' for blank output", async () => {
    const jsonClient = {
      async callTool() {
        return { content: [{ type: "text", text: '{"ok":true}' }] };
      },
    } as unknown as Client;
    const r1 = await handleRunCode(jsonClient, makeServer(false), dir, {
      reset: true,
      code: `const r = await PTC_DEMO_SEARCH({}); return r.format;`,
    });
    expect(parseEnvelope(r1 as never).value).toBe("json");

    const emptyClient = {
      async callTool() {
        return { content: [{ type: "text", text: "" }] };
      },
    } as unknown as Client;
    const r2 = await handleRunCode(emptyClient, makeServer(false), dir, {
      reset: true,
      code: `const r = await PTC_DEMO_SEARCH({}); return r.format;`,
    });
    expect(parseEnvelope(r2 as never).value).toBe("empty");
  });

  it("records a non-JSON note in observed_schemas for text-only output", async () => {
    const client = {
      async callTool() {
        return {
          content: [{ type: "text", text: "cursor: abc\ndocuments[2]:\n  - title: X" }],
        };
      },
    } as unknown as Client;
    const result = await handleRunCode(client, makeServer(false), dir, {
      reset: true,
      code: `const r = await PTC_DEMO_SEARCH({}); print(r.json() === undefined ? "no-json" : "json"); return (r.text || "").length;`,
    });
    const env = parseEnvelope(result as never);
    expect(env.stdout).toContain("no-json");
    expect(env.observed_schemas.DEMO_SEARCH).toMatch(/non-JSON text/);
  });

  it("merges shapes across heterogeneous array elements (optional keys)", async () => {
    const client = makeClient(() => ({ rows: [{ a: 1, b: 2 }, { a: 3 }] }));
    const result = await handleRunCode(client, makeServer(false), dir, {
      reset: true,
      code: `const r = await PTC_DEMO_SEARCH({}); return r.get("rows", []).length;`,
    });
    const env = parseEnvelope(result as never);
    expect(env.value).toBe(2);
    // `b` present in only one of two rows → marked optional.
    expect(env.observed_schemas.DEMO_SEARCH).toContain("b?: number");
  });

  it("overflows a large return value to a file and points to it", async () => {
    const client = makeClient(() => ({ blob: "x".repeat(6000) }));
    const result = await handleRunCode(client, makeServer(false), dir, {
      reset: true,
      code: `return await PTC_DEMO_SEARCH({});`,
    });
    const env = parseEnvelope(result as never);
    expect(env.overflow).toBe(true);
    expect(env.value.__overflow).toBe(true);
    expect(env.value.shape).toContain("blob: string");
    expect(typeof env.value.path).toBe("string");
    // The file actually exists and holds the full data.
    const onDisk = await fs.readFile(env.value.path, "utf-8");
    expect(onDisk.length).toBeGreaterThan(6000);
    expect(env.hints.join(" ")).toMatch(/file|re-run/i);
  });

  it("persists bare-assigned variables across calls; reset clears them", async () => {
    const client = makeClient(() => ({ items: [{ id: 1, name: "alpha" }], total: 1 }));
    const server = makeServer(false);

    const first = await handleRunCode(client, server, dir, {
      reset: true,
      code: `saved = await PTC_DEMO_SEARCH({}); return saved.get("total");`,
    });
    expect(parseEnvelope(first as never).value).toBe(1);

    const second = await handleRunCode(client, server, dir, {
      code: `return saved.get("items.0.name");`,
    });
    const env2 = parseEnvelope(second as never);
    expect(env2.value).toBe("alpha");
    expect(env2.session.fresh).toBe(false);

    const third = await handleRunCode(client, server, dir, {
      reset: true,
      code: `return saved.get("total");`,
    });
    const env3 = parseEnvelope(third as never);
    expect(env3.ok).toBe(false);
    expect(env3.error.message).toMatch(/saved is not defined/);
  });

  it("hints + clear error when an unknown PTC_ tool is referenced", async () => {
    const client = makeClient(() => ({ ok: true }));
    const result = await handleRunCode(client, makeServer(false), dir, {
      reset: true,
      code: `return await PTC_DOES_NOT_EXIST({});`,
    });
    const env = parseEnvelope(result as never);
    expect(env.hints.join(" ")).toContain("PTC_DOES_NOT_EXIST");
    expect(env.ok).toBe(false);
    expect(env.error.message).toMatch(/Unknown tool PTC_DOES_NOT_EXIST/);
  });

  it("get() returns the fallback instead of throwing on a wrong path", async () => {
    const client = makeClient(() => ({ total: 5 }));
    const result = await handleRunCode(client, makeServer(false), dir, {
      reset: true,
      code: `const r = await PTC_DEMO_SEARCH({}); return r.get("nope.deep.path", "FALLBACK");`,
    });
    const env = parseEnvelope(result as never);
    expect(env.ok).toBe(true);
    expect(env.value).toBe("FALLBACK");
  });

  it("binds head/core tools and dispatches them DIRECTLY (not via run_tool)", async () => {
    const dispatchedNames: string[] = [];
    const client = {
      async callTool(req: { name: string; arguments: Record<string, unknown> }) {
        dispatchedNames.push(req.name);
        return { content: [{ type: "text", text: JSON.stringify({ hits: 3 }) }] };
      },
    } as unknown as Client;
    const headTools = [
      {
        name: "search",
        description: "Glean search",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ];

    const result = await handleRunCode(
      client,
      makeServer(false),
      dir,
      { reset: true, code: `const r = await PTC_search({ query: "x" }); return r.get("hits");` },
      headTools,
    );
    const env = parseEnvelope(result as never);
    expect(env.ok).toBe(true);
    expect(env.value).toBe(3);
    // Dispatched directly by name, NOT wrapped in run_tool.
    expect(dispatchedNames).toContain("search");
    expect(dispatchedNames).not.toContain("run_tool");
    // And the schema file was materialized for the model to read.
    const onDisk = await fs.readFile(
      path.join(dir, "_core", "tools", "search.json"),
      "utf-8",
    );
    expect(JSON.parse(onDisk).direct).toBe(true);
  });

  it("seeds learned schemas into find_skills output after a run", async () => {
    const client = makeClient(() => ({ items: [{ id: 1, name: "a" }], total: 1 }));
    await handleRunCode(client, makeServer(false), dir, {
      reset: true,
      code: `const r = await PTC_DEMO_SEARCH({}); return r.get("total");`,
    });

    const observed = await loadObservedSchemas(dir);
    expect(observed.get("demo")?.get("DEMO_SEARCH")).toContain("items: Array<");

    const prompt = formatAvailableSkillsPrompt(
      [
        {
          name: "demo",
          description: "d",
          skillDir: path.join(dir, "demo"),
          files: [path.join(dir, "demo", "SKILL.md")],
        },
      ],
      { codeMode: true, observed },
    );
    expect(prompt).toContain("observed_output_schemas");
    expect(prompt).toContain("DEMO_SEARCH");
  });

  describe("batch-only gate (GLEAN_PTC_BATCH_ONLY)", () => {
    beforeEach(() => {
      process.env.GLEAN_PTC_BATCH_ONLY = "true"; // parent afterEach clears it
    });

    it("rejects a single one-off tool call (points to run_tool)", async () => {
      let dispatched = false;
      const client = {
        async callTool() {
          dispatched = true;
          return { content: [{ type: "text", text: "{}" }] };
        },
      } as unknown as Client;
      const result = await handleRunCode(client, makeServer(false), dir, {
        reset: true,
        code: `const r = await PTC_DEMO_SEARCH({ q: "x" }); return r.json();`,
      });
      const out = (result as { content: { text: string }[]; isError?: boolean });
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toContain("[USE_RUN_TOOL]");
      expect(dispatched).toBe(false); // never executed
    });

    it("allows 2+ tool calls (a batch)", async () => {
      const client = makeClient(() => ({ ok: true }));
      const result = await handleRunCode(client, makeServer(false), dir, {
        reset: true,
        code: `const a = await PTC_DEMO_SEARCH({}); const b = await PTC_DEMO_SEARCH({}); return [a.format, b.format];`,
      });
      const env = parseEnvelope(result as never);
      expect(env.ok).toBe(true);
      expect(env.ledger.length).toBe(2);
    });

    it("allows a single call inside a loop (runtime fan-out)", async () => {
      const client = makeClient(() => ({ ok: true }));
      const result = await handleRunCode(client, makeServer(false), dir, {
        reset: true,
        code: `const out = []; for (const x of [1, 2, 3]) { const r = await PTC_DEMO_SEARCH({ x }); out.push(r.format); } return out.length;`,
      });
      const env = parseEnvelope(result as never);
      expect(env.ok).toBe(true);
      expect(env.value).toBe(3);
    });

    it("allows a 0-call processing cell", async () => {
      const client = makeClient(() => ({ ok: true }));
      const result = await handleRunCode(client, makeServer(false), dir, {
        reset: true,
        code: `return 1 + 1;`,
      });
      const env = parseEnvelope(result as never);
      expect(env.ok).toBe(true);
      expect(env.value).toBe(2);
    });
  });

  describe("bulk approval (ENABLE_HITL)", () => {
    let prevHitl: string | undefined;

    beforeEach(async () => {
      prevHitl = process.env.ENABLE_HITL;
      process.env.ENABLE_HITL = "true";
      await fs.writeFile(
        path.join(dir, "demo", "tools", "DEMO_WRITE.json"),
        JSON.stringify({
          server_id: "srv-1",
          requires_approval: true,
          description: "Writes something",
        }),
      );
    });

    afterEach(() => {
      if (prevHitl === undefined) delete process.env.ENABLE_HITL;
      else process.env.ENABLE_HITL = prevHitl;
    });

    it("declining bulk approval runs nothing", async () => {
      let dispatched = false;
      const client = makeClient(() => {
        dispatched = true;
        return { ok: true };
      });
      const server = {
        getClientCapabilities: () => ({ elicitation: {} }),
        async elicitInput() {
          return { action: "decline" };
        },
      } as unknown as Server;

      const result = await handleRunCode(client, server, dir, {
        reset: true,
        code: `return await PTC_DEMO_WRITE({});`,
      });
      const env = parseEnvelope(result as never);
      expect(env.ok).toBe(false);
      expect(env.error.message).toMatch(/declined/i);
      expect(dispatched).toBe(false);
    });

    it("accepting bulk approval runs the approval-required tool", async () => {
      const client = makeClient(() => ({ ok: true }));
      const result = await handleRunCode(client, makeServer(true), dir, {
        reset: true,
        code: `const r = await PTC_DEMO_WRITE({}); return r.get("ok");`,
      });
      const env = parseEnvelope(result as never);
      expect(env.ok).toBe(true);
      expect(env.value).toBe(true);
      expect(env.ledger[0]).toMatchObject({ toolName: "DEMO_WRITE", state: "committed" });
    });
  });
});
