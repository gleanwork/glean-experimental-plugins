import vm from "node:vm";
import fs from "node:fs/promises";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { callRemoteTool } from "../remote-client.js";
import {
  discoverTools,
  observedSchemaPath,
  writeCoreTools,
  type HeadTool,
  type ToolMeta,
} from "../skill-tools.js";
import { invokeTool, requestToolApproval } from "./run-tool.js";

// ---------------------------------------------------------------------------
// Limits (env-overridable, mirroring GLEAN_FILE_ARG_MAX_BYTES).
// ---------------------------------------------------------------------------
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const TIMEOUT_MS = () => envInt("GLEAN_PTC_TIMEOUT_MS", 60_000);
const MAX_CALLS = () => envInt("GLEAN_PTC_MAX_CALLS", 200);
// Above this many chars, a return value / stdout is written to a file and the
// model gets a {shape, path} pointer instead of the data inline.
const MAX_INLINE_CHARS = () => envInt("GLEAN_PTC_MAX_INLINE_CHARS", 5_000);

const SHAPE_MAX_DEPTH = 6;
const SHAPE_MAX_KEYS = 40;
const ARRAY_SAMPLE = 5; // how many array elements to merge when inferring shape

let resultFileCounter = 0;

// ---------------------------------------------------------------------------
// Per-process persistent session. Intentionally simple: ONE vm context that
// lives for the lifetime of the plugin process. Only a BARE assignment
// (no var/let/const) attaches to the context global and persists across
// run_code calls — var/let/const are all function-local to the wrapping async
// IIFE and do NOT persist. Persists until the process exits or
// run_code({reset:true}). No TTL / LRU / heap eviction — host owns lifecycle.
// ---------------------------------------------------------------------------
let ctx: vm.Context | undefined;
let ctxFresh = false;
const sessionApproved = new Set<string>();

interface LedgerEntry {
  toolName: string;
  serverId: string;
  state: "committed" | "failed" | "ambiguous" | "declined";
  durationMs?: number;
}

interface CallState {
  remoteClient: Client;
  mcpServer: Server;
  skillsBaseDir: string;
  toolsByName: Map<string, ToolMeta>;
  approved: Set<string>;
  learned: Map<string, { shape: string; samples: number }>;
  observedThisRun: Map<string, { skillName: string; shape: string }>;
  ledger: LedgerEntry[];
  stdout: string[];
  calls: number;
  deadline: number;
  aborted: boolean;
}

// The active call's state. Host functions injected into the vm read this; a
// module-level mutex guarantees only one run_code executes at a time, so a
// single slot is safe.
let current: CallState | undefined;

// Simple FIFO mutex so the shared context + `current` are never raced.
let lockTail: Promise<void> = Promise.resolve();
function acquireLock(): Promise<() => void> {
  let release!: () => void;
  const next = new Promise<void>((res) => (release = res));
  const prev = lockTail;
  lockTail = lockTail.then(() => next);
  return prev.then(() => release);
}

// ---------------------------------------------------------------------------
// Host-side value summarizer (runs in this realm over vm values; Array.isArray
// and Object.keys both work cross-realm in the same process).
// ---------------------------------------------------------------------------
function shapeOf(v: unknown, depth: number, seen: WeakSet<object>): string {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return "string";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "undefined") return "undefined";
  if (t === "bigint") return "bigint";
  if (t === "symbol") return "symbol";
  if (t === "function") return "function";
  const obj = v as object;
  if (seen.has(obj)) return "[circular]";
  seen.add(obj);
  if (Array.isArray(v)) {
    if (v.length === 0) return "Array<unknown>[0]";
    return `Array<${arrayElemShape(v, depth, seen)}>[${v.length}]`;
  }
  if (depth >= SHAPE_MAX_DEPTH) return "{…}";
  const keys = Object.keys(obj);
  const shown = keys.slice(0, SHAPE_MAX_KEYS);
  const parts = shown.map(
    (k) => `${k}: ${shapeOf((obj as Record<string, unknown>)[k], depth + 1, seen)}`,
  );
  const more = keys.length > shown.length ? ", …" : "";
  return `{ ${parts.join(", ")}${more} }`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Infer an array's element shape by MERGING the first ARRAY_SAMPLE elements,
// not just sampling element 0. For arrays of objects this unions keys across
// the sample and marks a key optional ("?") when it's absent from some
// elements — so e.g. calendar events show BOTH `start.date` (all-day) and
// `start.dateTime` (timed), instead of whichever the first row happened to be.
function arrayElemShape(
  arr: unknown[],
  depth: number,
  seen: WeakSet<object>,
): string {
  const sample = arr.slice(0, ARRAY_SAMPLE);
  const objs = sample.filter(isPlainObject);
  if (objs.length === sample.length && objs.length > 0) {
    if (depth + 1 >= SHAPE_MAX_DEPTH) return "{…}";
    const keyInfo = new Map<string, { shapes: Set<string>; count: number }>();
    for (const o of objs) {
      for (const k of Object.keys(o)) {
        const e = keyInfo.get(k) ?? { shapes: new Set<string>(), count: 0 };
        e.shapes.add(shapeOf(o[k], depth + 2, seen));
        e.count++;
        keyInfo.set(k, e);
      }
    }
    const keys = [...keyInfo.keys()].slice(0, SHAPE_MAX_KEYS);
    const parts = keys.map((k) => {
      const e = keyInfo.get(k)!;
      const optional = e.count < objs.length ? "?" : "";
      return `${k}${optional}: ${[...e.shapes].join(" | ")}`;
    });
    const more = keyInfo.size > keys.length ? ", …" : "";
    return `{ ${parts.join(", ")}${more} }`;
  }
  // Mixed or scalar elements: union of distinct element shapes.
  const uniq = [...new Set(sample.map((e) => shapeOf(e, depth + 1, seen)))];
  return uniq.join(" | ") || "unknown";
}

function shapeStr(v: unknown): string {
  return shapeOf(normalizeForSummary(v), 0, new WeakSet());
}

function serialize(v: unknown): string {
  try {
    const s = JSON.stringify(v, (_k, val) =>
      typeof val === "bigint" ? `${val}n` : val,
    );
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

function extractText(res: CallToolResult): string {
  if (!Array.isArray(res.content)) return "";
  return res.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
}

// If the model returns a ToolResult directly, operate on the underlying data
// (parsed JSON, else raw text) rather than the wrapper's internal fields.
function normalizeForSummary(v: unknown): unknown {
  if (
    v &&
    typeof v === "object" &&
    (v as { __isToolResult?: boolean }).__isToolResult
  ) {
    const tr = v as { text?: string; __structured?: unknown };
    if (tr.__structured !== undefined && tr.__structured !== null) {
      return tr.__structured;
    }
    try {
      if (tr.text) return JSON.parse(tr.text);
    } catch {
      /* not JSON */
    }
    return tr.text ?? null;
  }
  return v;
}

// Overflow valve: write a too-large value/stdout to a file the model can Read
// (with offset/limit/grep). Lives in a sibling of the skills cache so it's in
// the host's workspace for sandboxed hosts. Best-effort; throws are caught by
// the caller. Date.now() is fine here (plugin runtime, not a workflow script).
function resultsDir(skillsBaseDir: string): string {
  return path.resolve(skillsBaseDir, "..", "glean-run-code-results");
}

async function writeOverflowFile(
  skillsBaseDir: string,
  kind: string,
  ext: string,
  content: string,
): Promise<string> {
  const dir = resultsDir(skillsBaseDir);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${kind}-${Date.now()}-${resultFileCounter++}.${ext}`);
  await fs.writeFile(file, content, "utf-8");
  return file;
}

// ---------------------------------------------------------------------------
// vm preamble: ToolResult + helpers, defined once per fresh context.
// ---------------------------------------------------------------------------
const PREAMBLE = `
class ToolResult {
  constructor(raw) {
    this.__isToolResult = true;
    this.isError = !!(raw && raw.isError);
    this.content = (raw && raw.content) || [];
    this.text = (raw && typeof raw.text === "string") ? raw.text : "";
    this.__structured = raw ? raw.structured : undefined;
    this.__parsed = false;
    this.__json = undefined;
  }
  json() {
    // Prefer the tool's structuredContent; fall back to parsing .text as JSON
    // (undefined if it isn't JSON — use .text then).
    if (this.__structured !== undefined && this.__structured !== null) {
      return this.__structured;
    }
    if (!this.__parsed) {
      this.__parsed = true;
      try { this.__json = JSON.parse(this.text); } catch { this.__json = undefined; }
    }
    return this.__json;
  }
  get(p, fallback) {
    let cur = this.json();
    if (cur === undefined) return fallback;
    for (const part of String(p).split(".")) {
      if (cur == null) return fallback;
      cur = cur[part];
    }
    return cur === undefined ? fallback : cur;
  }
  // "json" if .json() yields data, "empty" if there's no text, else "text"
  // (the output is prose/non-JSON — work with .text). Branch on this instead
  // of if(r.json()), which is the truthiness trap.
  get format() {
    const j = this.json();
    if (j !== undefined && j !== null) return "json";
    return (this.text || "").length > 0 ? "text" : "empty";
  }
}
globalThis.ToolResult = ToolResult;
globalThis.__mkResult = (raw) => new ToolResult(raw);
function __norm(x) {
  if (x && x.__isToolResult) {
    const j = x.json();
    return j !== undefined ? j : x.text;
  }
  return x;
}
// inspect(x): return (and print) the STRUCTURE/shape of any value — never the
// data itself. For a ToolResult, say plainly whether it's JSON (and its shape)
// or non-JSON text, so the model isn't left guessing from a bare "string".
globalThis.inspect = (x) => {
  let out;
  if (x && x.__isToolResult) {
    const j = x.json();
    if (j !== undefined && j !== null) {
      out = __ptcShape(j);
    } else if ((x.text || "").length === 0) {
      out = "ToolResult: empty (isError=" + x.isError + ")";
    } else {
      out =
        "ToolResult: non-JSON text (~" + (x.text || "").length +
        " chars) — .json() is undefined; use .text and parse it";
    }
  } else {
    out = __ptcShape(x);
  }
  __ptcPrint(out);
  return out;
};
globalThis.print = (...a) => __ptcPrint(a.map(String).join(" "));
globalThis.schemaOf = (name) => __ptcSchemaOf(name);
`;

function ensureContext(reset: boolean): void {
  if (reset || !ctx) {
    ctx = vm.createContext({
      // Host bridges — stable closures reading module-level `current`.
      __ptcDispatch: ptcDispatch,
      __ptcShape: (v: unknown) => shapeStr(v),
      __ptcPrint: (s: string) => {
        if (current) current.stdout.push(s);
      },
      __ptcSchemaOf: (name: string) => {
        const hit = current?.learned.get(name);
        return hit ? JSON.stringify(hit) : null;
      },
    });
    vm.runInContext(PREAMBLE, ctx, { filename: "ptc-preamble.js" });
    sessionApproved.clear();
    ctxFresh = true;
  } else {
    ctxFresh = false;
  }
}

// The bridge each PTC_ binding calls. Enforces the runtime allowlist
// (just-in-time approval for any tool not bulk-approved), the call budget, and
// the wall-clock deadline; records every dispatch in the ledger; learns the
// output shape.
async function ptcDispatch(
  toolName: string,
  args: unknown,
): Promise<{ isError: boolean; content: unknown; text: string; structured?: unknown }> {
  const st = current;
  if (!st) throw new Error("PTC runtime is not active");
  if (st.aborted || Date.now() > st.deadline) {
    st.aborted = true;
    throw new Error("run_code wall-clock timeout exceeded");
  }
  const meta = st.toolsByName.get(toolName);
  if (!meta) {
    throw new Error(
      `Unknown tool PTC_${toolName} — not found in discovered skills. ` +
        `Call find_skills first, or check the name.`,
    );
  }
  if (st.calls >= MAX_CALLS()) {
    throw new Error(`run_code tool-call budget exceeded (${MAX_CALLS()} calls)`);
  }

  // Runtime allowlist backstop: anything not bulk-approved prompts now.
  if (meta.requiresApproval && !st.approved.has(toolName)) {
    const outcome = await requestToolApproval(
      st.mcpServer,
      st.skillsBaseDir,
      toolName,
      meta.serverId,
      {
        failClosed: true,
        message:
          `**${toolName}** (not pre-approved) is about to run.\n` +
          (meta.description ? `${meta.description}\n` : "") +
          `Server: ${meta.serverId}\n\nAccept to run it, or decline to stop.`,
      },
    );
    if (outcome.kind === "declined") {
      st.ledger.push({ toolName, serverId: meta.serverId, state: "declined" });
      throw new Error(`Approval declined for PTC_${toolName}.`);
    }
    st.approved.add(toolName);
    sessionApproved.add(toolName);
  }

  st.calls++;
  const startedAt = Date.now();
  const entry: LedgerEntry = {
    toolName,
    serverId: meta.serverId,
    state: "ambiguous",
  };
  st.ledger.push(entry);

  try {
    // Head/first-class tools dispatch directly by name; skill tools go through
    // the run_tool gateway (invokeTool handles file_args + server_id shaping).
    const res = meta.direct
      ? await callRemoteTool(
          st.remoteClient,
          toolName,
          (args ?? {}) as Record<string, unknown>,
        )
      : await invokeTool(st.remoteClient, {
          serverId: meta.serverId,
          toolName,
          arguments: args ?? {},
        });
    entry.state = res.isError ? "failed" : "committed";
    entry.durationMs = Date.now() - startedAt;
    const text = extractText(res);
    const structured = (res as { structuredContent?: unknown }).structuredContent;
    if (!res.isError) learnShape(st, meta, text, structured);
    return { isError: !!res.isError, content: res.content, text, structured };
  } catch (err) {
    // Left as "ambiguous": dispatched, outcome unknown (response lost).
    entry.durationMs = Date.now() - startedAt;
    throw err;
  }
}

function learnShape(
  st: CallState,
  meta: ToolMeta,
  text: string,
  structured: unknown,
): void {
  // Prefer the MCP structuredContent if the tool provides it; else try to parse
  // the text as JSON; else record that it's non-JSON text so the model knows to
  // use .text and parse it (instead of discovering an empty .json() the hard way).
  let data = structured;
  if (data === undefined || data === null) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  const shape =
    data !== undefined && data !== null
      ? shapeOf(data, 0, new WeakSet())
      : `non-JSON text (~${text.length} chars) — read .text and parse it; .json() is undefined`;
  st.observedThisRun.set(meta.toolName, { skillName: meta.skillName, shape });
}

async function loadLearned(
  skillsBaseDir: string,
  metas: ToolMeta[],
): Promise<Map<string, { shape: string; samples: number }>> {
  const out = new Map<string, { shape: string; samples: number }>();
  await Promise.all(
    metas.map(async (m) => {
      try {
        const p = observedSchemaPath(skillsBaseDir, m.skillName, m.toolName);
        const raw = JSON.parse(await fs.readFile(p, "utf-8")) as {
          shape?: string;
          samples?: number;
        };
        if (typeof raw.shape === "string") {
          out.set(m.toolName, {
            shape: raw.shape,
            samples: typeof raw.samples === "number" ? raw.samples : 1,
          });
        }
      } catch {
        /* none learned yet */
      }
    }),
  );
  return out;
}

async function persistLearned(
  skillsBaseDir: string,
  st: CallState,
): Promise<void> {
  await Promise.all(
    [...st.observedThisRun.entries()].map(async ([toolName, { skillName, shape }]) => {
      try {
        const file = observedSchemaPath(skillsBaseDir, skillName, toolName);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const prior = st.learned.get(toolName);
        const samples = (prior?.samples ?? 0) + 1;
        await fs.writeFile(
          file,
          JSON.stringify(
            { shape, samples, note: "observed-not-guaranteed", updatedAt: Date.now() },
            null,
            2,
          ),
          "utf-8",
        );
      } catch {
        /* best-effort */
      }
    }),
  );
}

// Static pre-scan: every tool call the model writes is `PTC_<NAME>(`.
function scanReferencedTools(code: string): string[] {
  const re = /\bPTC_([A-Za-z0-9_]+)\s*\(/g;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) found.add(m[1]);
  return [...found];
}

// Total `PTC_<NAME>(` call SITES (not distinct tools) — two calls to the same
// tool still count as two.
function countToolCallSites(code: string): number {
  const m = code.match(/\bPTC_[A-Za-z0-9_]+\s*\(/g);
  return m ? m.length : 0;
}

// A loop / fan-out construct turns a single call site into a runtime batch.
function hasLoopOrFanout(code: string): boolean {
  return /\b(for|while|do)\b|\.\s*(map|forEach|flatMap)\s*\(|Promise\s*\.\s*all/.test(
    code,
  );
}

// run_code is scoped to BATCH jobs: 2+ tool calls (chaining or fan-out), or a
// loop around a call. A single one-off call (one site, no loop) should use
// run_tool / the direct tool instead. Cells that call NO tool (pure processing
// of prior results) are allowed. Returns a redirect message when the code is a
// single one-off call, else null.
function batchOnlyRejection(code: string): string | null {
  if (process.env.GLEAN_PTC_BATCH_ONLY === "false") return null;
  const sites = countToolCallSites(code);
  if (sites === 1 && !hasLoopOrFanout(code)) {
    return (
      "[USE_RUN_TOOL]\n\n" +
      "run_code is for BATCH jobs — 2+ tool calls (chaining one tool's output " +
      "into the next, or fanning out), or a loop/Promise.all around a call. " +
      "This code makes a single one-off tool call. For that, call the tool " +
      "directly: a skill tool via the `run_tool` tool (server_id + tool_name + " +
      "arguments, from its find_skills JSON), or a first-class tool " +
      "(search, read_document) as the top-level tool. Re-issue with run_code " +
      "only when you genuinely need 2+ calls or a loop."
    );
  }
  return null;
}

function bindingsSource(toolNames: string[]): string {
  return toolNames
    .map(
      (n) =>
        `globalThis.PTC_${n} = async (args) => __mkResult(await __ptcDispatch(${JSON.stringify(n)}, args));`,
    )
    .join("\n");
}

interface OverflowPointer {
  __overflow: true;
  shape: string;
  bytes: number;
  path: string;
  note: string;
}

interface RunCodeEnvelope {
  ok: boolean;
  stdout: string;
  stdout_path?: string;
  // The cell's return value VERBATIM when small; an OverflowPointer when it
  // exceeded the inline cap (full data written to a file).
  value: unknown;
  ledger: LedgerEntry[];
  observed_schemas: Record<string, string>;
  session: { fresh: boolean; calls: number };
  overflow: boolean;
  hints: string[];
  error?: { message: string };
}

export async function handleRunCode(
  remoteClient: Client,
  mcpServer: Server,
  skillsBaseDir: string,
  args: Record<string, unknown>,
  headTools: HeadTool[] = [],
): Promise<CallToolResult> {
  const code = args.code;
  if (typeof code !== "string" || code.trim() === "") {
    return {
      content: [{ type: "text", text: "`code` must be a non-empty string." }],
      isError: true,
    };
  }

  // Batch-only gate: reject a single one-off tool call before doing any work
  // (no lock, no execution). Single calls belong in run_tool / direct tools.
  const rejection = batchOnlyRejection(code);
  if (rejection) {
    return { content: [{ type: "text", text: rejection }], isError: true };
  }

  const reset = args.reset === true;

  const release = await acquireLock();
  const hints: string[] = [];
  try {
    ensureContext(reset);
    if (reset) hints.push("Session was reset — all prior variables were cleared.");

    // Materialize head/first-class tools so discoverTools binds them too.
    await writeCoreTools(skillsBaseDir, headTools);

    const allTools = await discoverTools(skillsBaseDir);
    const toolsByName = new Map<string, ToolMeta>();
    const collisions: string[] = [];
    // Bind direct (head) tools FIRST so they own the bare PTC_<name>; the
    // search/read_document overlap with skill-internal tools is expected and
    // not flagged. Only flag genuine skill-vs-skill (different server) clashes.
    const ordered = [
      ...allTools.filter((t) => t.direct),
      ...allTools.filter((t) => !t.direct),
    ];
    for (const t of ordered) {
      const existing = toolsByName.get(t.toolName);
      if (existing) {
        if (
          !existing.direct &&
          !t.direct &&
          existing.serverId !== t.serverId &&
          !collisions.includes(t.toolName)
        ) {
          collisions.push(t.toolName);
        }
        continue; // deterministic first-wins
      }
      toolsByName.set(t.toolName, t);
    }
    if (collisions.length) {
      hints.push(
        `Tool name collision across skills (used first match): ${collisions.join(", ")}.`,
      );
    }

    const referenced = scanReferencedTools(code);
    const unknown = referenced.filter((n) => !toolsByName.has(n));
    if (unknown.length) {
      hints.push(
        `Referenced unknown tools (will throw if called): ${unknown.map((n) => "PTC_" + n).join(", ")}.`,
      );
    }

    // ---- Bulk pre-scan approval -------------------------------------------
    const hitl = process.env.ENABLE_HITL === "true";
    const canElicit = !!mcpServer.getClientCapabilities()?.elicitation;
    const approved = new Set<string>(sessionApproved);
    const needApproval = referenced
      .map((n) => toolsByName.get(n))
      .filter((m): m is ToolMeta => !!m && m.requiresApproval && !approved.has(m.toolName));

    if (needApproval.length && hitl && canElicit) {
      const list = needApproval
        .map((m) => `• PTC_${m.toolName} — ${m.description?.split("\n")[0] || m.serverId}`)
        .join("\n");
      const message =
        `This code will run the following approval-required tools:\n\n${list}\n\n` +
        `Some may run inside loops — exact counts depend on data fetched at runtime.\n` +
        `Accept to approve all of them for this session, or decline to run nothing.`;
      try {
        const result = await mcpServer.elicitInput({
          message,
          requestedSchema: { type: "object", properties: {} } as never,
        });
        if (result.action !== "accept") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ok: false,
                    error: { message: "Bulk approval declined; nothing ran." },
                    hints,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        for (const m of needApproval) {
          approved.add(m.toolName);
          sessionApproved.add(m.toolName);
        }
      } catch {
        // Elicitation channel broke — fail closed for code mode.
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error: {
                    message:
                      "Approval channel unavailable; refusing to run approval-required tools.",
                  },
                  hints,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    } else if (needApproval.length) {
      // No HITL configured (parity with run_tool): run without prompting.
      for (const m of needApproval) approved.add(m.toolName);
    }

    const learned = await loadLearned(skillsBaseDir, [...toolsByName.values()]);

    const state: CallState = {
      remoteClient,
      mcpServer,
      skillsBaseDir,
      toolsByName,
      approved,
      learned,
      observedThisRun: new Map(),
      ledger: [],
      stdout: [],
      calls: 0,
      deadline: Date.now() + TIMEOUT_MS(),
      aborted: false,
    };
    current = state;

    // Refresh bindings (tool set may have changed) + run the user cell wrapped
    // in an async IIFE so top-level await and `return` work. Non-strict so a
    // bare assignment (`x = ...`) attaches to the persistent context global.
    // Bind every known tool plus any referenced-but-unknown name, so an
    // unknown PTC_ call yields a clear "Unknown tool" error from the bridge
    // rather than a raw ReferenceError.
    const bindNames = [...new Set([...toolsByName.keys(), ...referenced])];
    const script =
      bindingsSource(bindNames) +
      "\n;__ptcCell = (function(){ return (async () => {\n" +
      code +
      "\n})(); })();\n";

    let value: unknown;
    let errorMessage: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      vm.runInContext(script, ctx as vm.Context, {
        filename: "ptc-cell.js",
        timeout: TIMEOUT_MS(),
      });
      const cellPromise = (ctx as unknown as Record<string, unknown>)
        .__ptcCell as Promise<unknown>;
      const timeoutPromise = new Promise<never>((_res, rej) => {
        timer = setTimeout(() => {
          state.aborted = true;
          rej(new Error("run_code wall-clock timeout exceeded"));
        }, TIMEOUT_MS());
      });
      value = await Promise.race([cellPromise, timeoutPromise]);
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      if (timer) clearTimeout(timer);
      state.aborted = true;
    }

    await persistLearned(skillsBaseDir, state);

    const cap = MAX_INLINE_CHARS();

    // ---- stdout: inline if small, else overflow to a file --------------------
    let stdout = state.stdout.join("\n");
    let stdoutPath: string | undefined;
    let stdoutOverflow = false;
    if (stdout.length > cap) {
      try {
        stdoutPath = await writeOverflowFile(skillsBaseDir, "stdout", "txt", stdout);
        stdout =
          stdout.slice(0, cap) +
          `\n…[stdout exceeded ${cap} chars — full output written to a file; see stdout_path]`;
      } catch {
        stdout = stdout.slice(0, cap) + "\n…[stdout truncated; could not write overflow file]";
      }
      stdoutOverflow = true;
    }

    const observed: Record<string, string> = {};
    for (const [name, { shape }] of state.observedThisRun) observed[name] = shape;

    // ---- value: VERBATIM if small, else write to a file + return a pointer ---
    let valueField: unknown;
    let valueOverflow = false;
    if (!errorMessage) {
      const norm = normalizeForSummary(value);
      const serialized = serialize(norm);
      if (serialized.length <= cap) {
        valueField = norm; // verbatim — no summarize, no truncation
      } else {
        const shape = shapeOf(norm, 0, new WeakSet());
        let p: string | undefined;
        try {
          p = await writeOverflowFile(skillsBaseDir, "value", "json", serialized);
        } catch {
          /* fall back to shape-only pointer below */
        }
        const pointer: OverflowPointer = {
          __overflow: true,
          shape,
          bytes: serialized.length,
          path: p ?? "(file write failed)",
          note:
            "Return value exceeded the inline cap and was written to this file. " +
            "Read it (offset/limit/grep) for specific fields — the data is also " +
            "still in your session variables. Do NOT re-run tools to regenerate it.",
        };
        valueField = pointer;
        valueOverflow = true;
      }
    }

    const overflow = stdoutOverflow || valueOverflow;

    if (errorMessage) {
      hints.push(
        "Cell threw — variables assigned before the throw are still available; " +
          "fix the failing line and continue. Committed writes were NOT rolled back (see ledger).",
      );
    }
    if (overflow) {
      hints.push(
        "Large output was written to a file (see value.path / stdout_path), NOT lost. " +
          "Read that file for specifics, or narrow what you return/print next time. " +
          "The full data is also still in your session variables — do NOT re-run tools.",
      );
    }
    if (ctxFresh) {
      hints.push(
        "Fresh session. To persist a variable across run_code calls use a BARE " +
          "assignment — no var/let/const (e.g. `bugs = await PTC_X()`); var/let/const " +
          "are all temporary. Persists until the process exits or you pass reset:true.",
      );
    }

    const envelope: RunCodeEnvelope = {
      ok: !errorMessage,
      stdout,
      ...(stdoutPath ? { stdout_path: stdoutPath } : {}),
      value: valueField,
      ledger: state.ledger,
      observed_schemas: observed,
      session: { fresh: ctxFresh, calls: state.calls },
      overflow,
      hints,
      ...(errorMessage ? { error: { message: errorMessage } } : {}),
    };

    return {
      content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
      ...(errorMessage ? { isError: true } : {}),
    };
  } finally {
    current = undefined;
    release();
  }
}
