# Programmatic Tool Calls (PTC) — Design

> Status: **IMPLEMENTED (experimental), behind `ENABLE_RUN_CODE` (default off).**
> Living doc — edit/comment freely.
>
> Owner: Eshwar Sundar · Last updated: 2026-06-10

## Implementation status

Shipped behind `ENABLE_RUN_CODE=true` (off by default → deployed `run_tool`
behavior is untouched):

- **`run_code`** MCP tool, scoped to **BATCH jobs only**. When the flag is
  **on**, `run_code` is exposed **alongside** `run_tool` (not replacing it):
  `run_tool` handles single one-off calls, `run_code` handles batches — 2+ calls
  (chaining/fan-out) or a loop around a call. A single one-off call inside
  `run_code` is **rejected** (`[USE_RUN_TOOL]`) before executing; 0-call
  (pure-processing) and loop/fan-out cells are allowed. Gate on by default;
  disable with `GLEAN_PTC_BATCH_ONLY=false`. Flag **off** → nothing changes.
  (First-class tools like `search` run directly — no longer redirected into
  `run_code`; still usable as `PTC_<name>` inside a batch.)
- Execution in an **in-process `node:vm`** context (not a worker thread yet —
  see note below), one persistent context for the process lifetime.
- `PTC_<TOOL>` async bindings, `ToolResult` (`.text`/`.json()`/`.get()`),
  `inspect` (**shape-only**), `print`, `schemaOf`.
- **Verbatim result contract**: the cell's `return` value comes back as-is (no
  summarize/preview/truncation). If it (or stdout) exceeds
  `GLEAN_PTC_MAX_INLINE_CHARS` (default 5000) it's written to a file under a
  `glean-run-code-results/` dir and the model gets a `{__overflow, shape, path,
  bytes}` pointer to `Read` — never a silent truncation.
- **Bulk pre-scan approval** (one `elicitInput` for all `PTC_` calls the cell
  references) + **runtime allowlist backstop** (just-in-time approval for
  dynamically-invoked tools), gated by `ENABLE_HITL` like `run_tool`.
- Execution ledger, wall-clock timeout, call budget.
- **`ToolResult.json()` prefers MCP `structuredContent`** when the tool provides
  it, falling back to parsing `.text`. Some Glean tools (notably `search`) return
  a non-JSON human-readable text blob; for those, `learnShape`/`observed_schemas`
  record a `"non-JSON text (~N chars) — read .text and parse it"` note instead of
  silently learning nothing, so the model knows to use `.text` rather than
  discovering an empty `.json()`. (Server-side: if the Glean MCP `search` tool
  populated `structuredContent`, code mode would get structured results for free.)
- **Learned/observed output schemas** persisted under `.observed/<skill>/<TOOL>.schema.json`
  (a top-level dir, NOT inside each skill dir, so `find_skills`' rm-and-recreate
  doesn't wipe them), **seeded back into `find_skills` output** so the model
  knows result shapes before its first call. `shapeOf` **merges keys across the
  first N array elements** (optional `?` keys) so heterogeneous arrays aren't
  mischaracterized by element 0.
- **Head / first-class tools** (the post-auth allow-list: `search`,
  `read_document`, …) are usable in code mode too — but they are NOT discovered
  via `find_skills`. They stay on the **top-level tool surface** (so the model
  sees their schema). When code mode is on and the model calls one **directly**,
  the plugin returns a `[USE_RUN_CODE]` redirect telling it to call
  `PTC_<name>(args)` inside `run_code` instead (so it composes with other tools
  in one turn). For the binding itself, `run_code` materializes their schemas as
  `_core/tools/<name>.json` (tagged `direct: true`) so `discoverTools` binds
  them as `PTC_<name>`, and the bridge routes `direct` tools straight to the
  remote client (`callRemoteTool(client, name, args)`) instead of the `run_tool`
  gateway. On a bare-name overlap with a skill-internal tool (e.g. `search`),
  the head tool wins `PTC_search` (bound first).
- Shared `invokeTool` + `discoverTools` refactor (Phase 0).

**Deliberately deferred** (per "keep it simple for now"):
- **Worker-thread credential isolation.** Code currently runs in-process via
  `node:vm`, which is **not** a security boundary and shares the process with
  the OAuth tokens. Acceptable only because the feature is off by default and
  experimental. The §10 worker model is the intended hardening.
- **QuickJS-WASM engine swap.**
- **Session TTL/LRU/heap eviction.** Replaced by the simpler model in §8.

The rest of this doc describes the full design; sections that differ from the
current implementation are flagged inline.

---

## 1. One-paragraph summary

Today the host LLM orchestrates Glean tools by emitting **one `run_tool`
JSON blob per call** and waiting a full turn for each result. For multi-step
work (search → filter → act on each result) this is many turns, and every
intermediate payload is dumped back into the model's context. **Programmatic
Tool Calls (PTC)** add a new MCP tool, `run_code`, that lets the model write
**real JavaScript** in which each Glean tool is an in-scope async function
(`PTC_JIRA_SEARCH(...)`). The plugin executes that code in an isolated,
credential-less worker; intercepts each `PTC_` call; performs the real MCP
`run_tool` call in the trusted parent; and feeds the result back into the
running program. Loops, conditionals, filtering, and data-flow happen **in
code**, in one turn, with large payloads kept **out** of the model's context.

---

## 2. Key terms (read this first)

| Term | Meaning |
|---|---|
| **PTC** | Programmatic Tool Call — this feature. Also the prefix on every tool binding. |
| **`run_code`** | The new MCP tool. Input: a string of JS (a "cell"). Output: a compact result envelope (stdout + summarized value + ledger). |
| **Cell** | One `run_code` invocation's worth of code. Like a Jupyter cell — runs in a session and can use variables defined by earlier cells. |
| **`PTC_` binding** | An injected async function, one per discovered tool, named `PTC_<TOOL_NAME>` (e.g. `PTC_SLACK_POST_MESSAGE`). Calling it dispatches the real MCP tool. The `PTC_` prefix is **mandatory** and exists so call sites are trivially detectable by prefix match. |
| **Session** | Server-side state for one host conversation, keyed by session id. Holds the warm worker + its variables + approval grants. **In-memory only, evicted over time** (see §8). |
| **Worker** | A `worker_threads` thread that runs the untrusted model-authored code. Holds **no credentials**. Its only egress is the bridge. |
| **Bridge** | The message channel between worker (untrusted) and parent (trusted). The worker asks "run tool X with args Y"; the parent decides, executes, and returns the result. |
| **Parent** | The trusted plugin process. Holds OAuth tokens + the remote MCP client, enforces approval, applies limits. |
| **`ToolResult`** | The object a `PTC_` call resolves to: `{ isError, content, text, json(), get(path, fallback) }`. Accessors **degrade instead of throwing** so a wrong-shape guess doesn't crash the cell. |
| **`inspect(x)`** | Helper that returns/prints the **shape only** (runtime-derived structure) of a value — never the data. How the model learns an unknown shape for a *computed* value; for raw tool outputs, `observed_schemas` already does this automatically. |
| **`schemaOf("TOOL")`** | Returns the **learned/observed** schema for a tool, accumulated across past runs and persisted to disk under `.observed/`. |
| **overflow** | When a `return` value or stdout exceeds `GLEAN_PTC_MAX_INLINE_CHARS` (5000), it's written to a file and the model gets a `{__overflow, shape, path, bytes}` pointer instead of the data inline. (Replaces the earlier "summarize/preview/truncate" idea.) |
| **Bulk pre-scan approval** | Before a cell runs, the parent scans the code for `PTC_` calls and shows **one** approval card listing the tools that will run; the user approves once. (see §9) |
| **Runtime allowlist** | The set of tools approved for a cell/session. The bridge enforces it: any `PTC_` call **not** in the set pauses for just-in-time approval. This is the soundness backstop behind the static scan. |
| **Execution ledger** | Ordered record of every dispatched call, stamped `committed | failed | ambiguous`. Returned on every cell, especially on error, so the model knows exactly what ran. |
| **`invokeTool`** | The shared parent-side core (extracted from today's `handleRunTool`) that does discovery → HITL → file_args → `callRemoteTool`. Reused by both `run_tool` and PTC. |
| **`discoverTools`** | The shared tool-discovery helper (promoted from today's private `findToolJson`) that reads the cached `<skill>/tools/*.json` files. |

---

## 3. Goals & non-goals

**Goals**
- Let the model write ordinary async JS where tools are functions.
- Collapse N tool-call turns into a few code cells.
- Keep large tool outputs out of the model's context; return only shapes/summaries.
- Handle the fact that **tool outputs have no declared schema** — recover shapes at runtime.
- Approve side-effecting calls with **one upfront approval per cell** wherever possible.
- Isolate OAuth credentials from model-authored code.
- Reuse the existing `run_tool` bridge, auth, HITL, and file_args machinery.

**Non-goals (for now)**
- Transactional atomicity / automatic rollback across tool calls. (Independent
  downstream systems; no shared transaction. Recovery is a model follow-up.)
- Durable/long-lived variable storage. Session state is a **warm cache**, not a database (§8).
- A hard security boundary against a realm escape in Phase 1 (`node:vm` is not a
  realm boundary; mitigated by credential isolation + the optional QuickJS swap in §16).
- Python or other languages. JS only.

---

## 4. The `PTC_` naming convention

Every tool binding injected into the sandbox is named **`PTC_` + the tool name**:

```
JIRA_SEARCH            →  PTC_JIRA_SEARCH
SLACK_POST_MESSAGE     →  PTC_SLACK_POST_MESSAGE
JIRA_CREATE_ISSUE      →  PTC_JIRA_CREATE_ISSUE
```

Cross-skill name collisions are additionally namespaced: `PTC_skills.<skill>.<TOOL>`
(rare; only when the same tool stem exists in two skills).

Why the prefix:
1. **Trivial detection** — the pre-scan finds tool calls with a prefix match
   (`/\bPTC_[A-Z0-9_]+\s*\(/`) instead of needing a full JS parser to know which
   identifiers are tool bindings. This is what lets us drop the `acorn` dependency
   and stay zero-new-deps for the scan.
2. **Unambiguous in the approval card** — everything the user is approving is a `PTC_*`.
3. **Auditing** — log lines key off the prefix.

The `find_skills` output documents each available binding by its `PTC_` name
plus a JSDoc-style signature generated from the tool's `inputSchema`, so the
model knows the input contract before writing the cell.

> Note: the prefix is a UX/parsing aid, **not** a security mechanism. Soundness
> comes from the runtime allowlist (§9), not from string matching.

---

## 5. Architecture overview

```
┌─ Parent (trusted) ───────────────────────┐        ┌─ Worker (untrusted) ─────────────┐
│ • holds OAuth tokens + remoteClient        │  msg   │ • runs model-authored JS (node:vm)│
│ • discoverTools / invokeTool               │ bridge │ • PTC_* are async fns that         │
│ • PTC_ pre-scan + bulk approval (elicit)   │◄──────►│   postMessage → parent             │
│ • runtime allowlist enforcement            │        │ • holds variables across cells     │
│ • resource limits + terminate() kill       │        │ • NO tokens, NO network creds      │
│ • execution ledger + audit log             │        │ • only egress = the bridge         │
└────────────────────────────────────────────┘        └────────────────────────────────────┘
```

Per-cell flow:

1. `run_code` arrives in the parent with `{ code, session?, reset? }`.
2. Parent **pre-scans** `code` for `PTC_*(` call sites → candidate tool set.
3. Parent shows the **bulk approval card** via `elicitInput` (only for tools
   that need approval and aren't already session-granted). Decline → abort, nothing runs.
4. Parent gets/creates the **session worker** (restoring prior variables) and
   sends `{ code, approvedSet }`.
5. Worker compiles + runs the cell. Each `PTC_*` call posts
   `{ type:"invoke", server_id, tool, args }` to the parent and awaits.
6. Parent checks the **allowlist** (just-in-time prompt if missing), runs
   `invokeTool(...)`, records a **ledger** entry, returns the `ToolResult` data.
7. Cell finishes → worker posts `{ type:"done", value, stdout }`.
8. Parent **autoSummarizes** `value`, attaches the ledger + any newly observed
   schemas, and returns the **result envelope** to the model.

---

## 6. The developer-facing API (what the model writes)

```js
// Tools are async functions, server_id pre-bound. Top-level await is allowed.
const me   = await PTC_JIRA_GET_CURRENT_USER();
const bugs = await PTC_JIRA_SEARCH({
  jql: `assignee = '${me.json().accountId}' AND priority = P0 AND status != Done`,
});

// Forgiving accessors: a wrong path returns the fallback instead of throwing.
const prod = bugs.get("issues", [])
  .filter(i => i.get("fields.summary", "").toLowerCase().includes("prod"));

for (const issue of prod) {
  await PTC_SLACK_POST_MESSAGE({ channel: "#oncall", text: `P0: ${issue.get("key")}` });
}

return prod.length;   // small value → returned in full; the issue list never leaves the worker
```

Surface available in a cell:
- **`PTC_<TOOL>(args)`** → `Promise<ToolResult>`. `server_id` pre-bound.
- **`ToolResult`**: `.isError`, `.content`, `.text` (raw string), `.json()`
  (parsed; memoized; `undefined` on prose), `.get(path, fallback)` (never throws).
- **`inspect(x)`** — shape only (see §7). (`shape`/`preview` helpers were dropped.)
- **`schemaOf("TOOL")`** — learned schema across past runs.
- **`print(...)`** — append to the cell's `stdout`.
- Standard JS built-ins (JSON, Math, Array, etc.). **No** `require`/`import`,
  `fetch`, `process`, `fs` (§10).

---

## 7. Unknown output schemas — `inspect` and the probe→continue loop

There is **no `outputSchema`** anywhere in the tool JSON; results come back as
raw text (often JSON, sometimes prose). So the model cannot know result shapes
ahead of time. We resolve this by **recovering the shape at runtime** and
handing it back.

`inspect(x)` walks a **live value already in the worker** and returns a compact
**type-shape + small preview** — and *that summary* is what crosses back to the
model. The full payload stays in the worker.

**Probe cell:**
```js
const bugs = await PTC_JIRA_SEARCH({ jql: "assignee = currentUser() AND priority = P0" });
inspect(bugs);
```
**What the model receives** (hundreds of tokens, not the 37-issue payload):
```
bugs: ToolResult(isError=false)
  .json() => {
    total: number,
    issues: Array<{                         // length 37
      key: string,
      fields: { summary: string, priority: { name: string }, assignee: { accountId: string } | null }
    }>
  }
  .text (preview) => '{"total":37,"issues":[{"key":"PROD-1412",...'
```
**Continue cell** (the variable `bugs` is still alive — no re-fetch):
```js
return bugs.get("issues", [])
  .filter(i => i.get("fields.summary","").includes("prod"))
  .map(i => i.get("key"));
```

So, to answer the recurring question directly: **`inspect` gives the schema
back to the model so it can write the *next* cell.** Because this is a stateful
REPL, the model usually *continues* from a live variable rather than rewriting
the whole program. A full rewrite only happens when a cell **threw** — and even
then, anything that already ran (including committed writes) is preserved, so it
is not replayed.

Three related surfaces, kept distinct:
- **`inspect(x)`** — explicit, on-demand shape of a specific live value.
- **Cell `value`** — the same summarizer applied automatically to the cell's
  `return`/last expression, so a shape comes back even without `inspect`.
- **`schemaOf("TOOL")`** — accumulated/learned schema across runs, persisted to
  disk, labeled `observed-not-guaranteed` with a sample count. Over time, hot
  tools need no probe at all.

Hard rule: **raw payloads never auto-cross-back.** Only `inspect`/`value`
summaries (~2KB budget) and whatever small thing you explicitly `return`.

---

## 8. Session & variable lifetime — **do variables last forever? No.**

This section answers the open question directly.

### Mental model
Session variables are a **warm cache, not durable storage.** They exist to let
one cell build on the previous cell's work within the same conversation. They
are **re-derivable** by re-running cells. Never treat them as a place to persist
anything important.

### What persists, and where
- **Within a session:** variables (`const`/`let`/`var`, functions, fetched
  `ToolResult`s) defined by earlier cells remain available to later cells,
  because the **worker stays warm** between `run_code` calls and holds them in
  memory. This is what makes "fetch in cell 1, filter in cell 2 without
  re-fetching" work.
- **Across sessions:** nothing is shared. Different conversation → different session → fresh state.
- **The only disk-persisted state** is the *learned-schema cache*
  (`.observed/<skill>/<TOOL>.schema.json`) — not variables. Variables are
  **never** written to disk (they may hold sensitive fetched data).

### When variables are dropped (eviction) — *implemented model*

We kept this deliberately simple: there is **one** persistent `node:vm` context
for the whole plugin process. No TTL, no LRU, no heap eviction. Variables are
dropped only when:

1. **Process exit** — the plugin is a stdio server; when the host reaps it, the
   context and all variables vanish. Nothing survives a restart.
2. **Explicit reset** — `run_code({ reset: true })` recreates the context,
   clearing all variables and session approvals (the model's "start fresh" button).

That's it. The persistence rule the model must know (and which the tool
description states): **a bare assignment persists** (`bugs = await PTC_X()` →
lives on the context global across calls); **`var`, `let`, and `const` are ALL
temporary** (this call only). Note `var` does *not* persist — the cell runs
inside a wrapping async IIFE, so a `var` is function-local to it; only a
bare (keyword-less) assignment reaches the persistent global.

> Future hardening (§16) would move this into a worker thread with the TTL/LRU/
> heap caps originally proposed; not needed for the experimental flag.

### Session identity
Keyed by `resolveSessionId()` (today's logic: `GLEAN_SESSION_ID` env if the host
provides it, else a per-process fallback UUID).

> **Known caveat:** on hosts that do **not** set `GLEAN_SESSION_ID` (e.g. some
> Cursor configs), the per-process fallback UUID means two distinct
> conversations in the same process could share a session and therefore see each
> other's variables. Mitigations: (a) document loudly; (b) `reset:true` to
> isolate; (c) consider folding a host-conversation hint into the session key if
> one becomes available. Tracked as an open question (§17).

### What the model should assume
- "My variables are probably still here from the last cell **in this
  conversation** — but if a cell reports a fresh/empty session, I just re-run
  the setup cells." The result envelope includes a `session: { id, age, fresh }`
  hint so the model can tell.

---

## 9. Approval / HITL — bulk pre-scan via `PTC_`, with a runtime backstop

**Goal (per your decision):** before a cell runs, tell the user "this code will
call X, Y, Z" and get **one** approval, then run uninterrupted.

### How the call set is collected
The parent scans the cell's source for `PTC_*(` call sites (prefix match — no
parser needed). This yields the **set of tools the code references**. The
approval card:

```
This cell will call:
  Reads (auto):      PTC_JIRA_GET_CURRENT_USER, PTC_JIRA_SEARCH
  Writes (approve):  PTC_SLACK_POST_MESSAGE   — "Posts a message to a channel"
                     PTC_JIRA_CREATE_ISSUE    — "Creates a new Jira issue"
  ⚠ Some calls are inside loops — exact count depends on data fetched at runtime.
  [ Approve & run ]   [ Decline ]
```

A tool is **auto-runnable without prompting** only if
`requires_approval !== true` **AND** `annotations.readOnlyHint === true`. Absent
annotations ⇒ treat as needs-approval (fail safe).

### What static scan cannot know (and how we stay sound)
A prefix scan (or even a full parser) cannot determine:
1. **How many times** a call runs (loops) → card says "may run multiple times".
2. **Exact arguments** when computed from fetched data → show known arg keys, else "args computed at runtime".
3. **Dynamically/indirectly invoked** tools — e.g. `globalThis["PTC_"+x](...)` — invisible to the scan.

**Soundness backstop — the runtime allowlist:** the approved set becomes an
allowlist enforced by the **bridge**. Any `PTC_` dispatch at runtime that is
**not** in the allowlist **pauses for just-in-time approval** (fail-closed). So:
- Normal code → one upfront approval, runs uninterrupted. ✅
- Reflectively-built calls → caught at dispatch, cannot bypass approval. ✅

### Session-scoped grants
In a stateful REPL the model re-uses tools across cells. Approvals carry forward:
"approve `PTC_JIRA_SEARCH` for this session" → later cells don't re-prompt for
it. Each cell only needs approval for the **new** approval-requiring tools it introduces.
Grant scope options on the card: **approve once / approve for this session / decline**.

### Hosts without elicitation
If the host doesn't support `elicitInput`, write-capable cells run in
**plan-only** mode: read-only tools execute (real shapes), approval-requiring
tools are **not** executed — they're recorded into a plan the model surfaces to
the user, who then re-runs after out-of-band confirmation.

### Over-approval edge
The card can list a write that's behind a condition that turns out false. Safe
(nothing runs) but slightly conservative; the reverse (under-listing) is what the
runtime allowlist prevents.

---

## 10. Security model

**Trust:** code is authored by the host's own (user-supervised) LLM, but is
treated as untrusted for containment.

**Credential isolation (the spine):** OAuth tokens + the remote MCP client live
**only in the parent**. The worker has neither. The worker's only egress is the
bridge, which the parent gates by approval + allowlist. A realm escape inside
the worker therefore cannot read tokens or impersonate the user to Glean.

**`node:vm` caveat:** `node:vm` is a kill + credential boundary here, **not** a
realm boundary — sandboxed code could in principle reach the worker's own realm
globals. Acceptable because the worker holds nothing sensitive and is
terminable. Fully closed later by swapping the engine to QuickJS-WASM (§16),
which is an internal swap behind the same surface.

**Denylist inside the sandbox:** no `require`/`import`/`createRequire` (note the
bundle's own `createRequire` banner shim must not be exposed into the context),
no `process`, `env`, `fs`, `fetch`/network, no timers that outlive the cell.
Only `PTC_*` bindings + safe built-ins + helpers.

**Resource limits (env-overridable, mirroring `GLEAN_FILE_ARG_MAX_BYTES`):**
- `GLEAN_PTC_TIMEOUT_MS` — wall-clock per cell (default 60s) → `terminate()` on breach.
- `GLEAN_PTC_MAX_CALLS` — max tool calls per cell, split read/write (default 100 read / 25 write).
- `GLEAN_PTC_MAX_HEAP_MB` — worker heap cap (default 256).
- Output size cap (~1 MB) — truncate-with-marker, never crash.
- Side-effecting calls **serialized** (ledger order == commit order); bounded read parallelism (~4).

**Audit:** reuse `logLine()` (JSONL at `~/.glean/glean-server.log`, 0600).
Emit `ptc.start{runId, sessionId, stepsHash, mode}`, `ptc.approval{tool, verdict}`,
`ptc.call{server_id, tool, state, durationMs}`, `ptc.end{runId, ok, committedWrites, stoppedReason}`.
**Never** log raw args/results — keys + sizes/hashes only (as `callback_url` logs `codeLen`, not the code).

**Flag:** entire feature behind `ENABLE_RUN_CODE` (default **off**), like `ENABLE_HITL`.

---

## 11. Failure model & execution ledger

- **No transactional atomicity, no auto-rollback.** Each `PTC_` call is its own
  commit boundary against an independent downstream system.
- **Ledger:** every dispatched call is recorded **before** awaiting the remote,
  then stamped `committed | failed | ambiguous` (ambiguous = executed remotely
  but response lost = *maybe* committed).
- **On throw / limit-kill:** the cell returns `isError:true` + the **ordered
  ledger** + `error:{message, where}`. **Variables from before the throw are
  preserved** (REPL advantage) so the model fixes the failing line and continues
  — it must **not** assume the program completed.
- **Fail-fast:** on first failed/declined side-effecting call, stop dispatching
  further writes; keep completed read results.
- **Retries:** no auto-retry on ambiguous side-effecting calls (no idempotency
  convention). Read-only / `idempotentHint` tools may retry with bounded backoff.
- **Rollback** (if wanted) is the model's job in a follow-up turn, reading the
  ledger and issuing compensating calls with fresh approval.

---

## 12. Data structures (parent side, sketch)

```ts
interface Session {
  id: string;
  worker: Worker;                 // warm node:vm host; holds variables
  approvedTools: Set<string>;     // session-scoped grants
  createdAt: number; lastUsedAt: number;
}

type LedgerState = "planned" | "committed" | "failed" | "ambiguous";
interface LedgerEntry { server_id: string; tool: string; state: LedgerState; durationMs?: number; }

interface RunCodeResult {        // the envelope returned to the model
  ok: boolean;
  stdout: string;
  value: Summary;                // autoSummarized return value / last expr
  observed_schemas?: Record<string, Summary>;  // newly learned this cell
  ledger: LedgerEntry[];
  session: { id: string; ageMs: number; fresh: boolean };
  truncated: boolean;
  hints: string[];
  error?: { message: string; where?: string };
}
```

Bridge messages: `worker→parent { type:"invoke", server_id, tool, args }` and
`{ type:"done", value, stdout }`; `parent→worker { type:"result", data }`,
`{ type:"error", message }` (e.g. on decline).

---

## 13. Reuse of existing code

| New need | Reuse / extract from |
|---|---|
| Run a downstream tool (auth + HITL + file_args + call) | **Extract `invokeTool(...)`** from `handleRunTool` (`src/tools/run-tool.ts:124-203`); `resolveFileArgs`/`FileArgsError` already exported. |
| Discover tools + their `server_id`/`inputSchema` | **Promote `findToolJson`** (`src/tools/run-tool.ts:102-122`) → `src/skill-tools.ts: discoverTools()` with deterministic ordering + collision detection. |
| Setup-gate preamble (serverUrl/tokens/connect/close) | **Extract `withRemoteSession(label, fn)`** from the duplicated blocks in `src/index.ts` (find_skills `:495-558`, run_tool `:561-618`). |
| Tool registration + dispatch | Pattern at `src/index.ts:173-276` (static tools) + the `CallToolRequest` switch `:494`. |
| Remote call bottleneck | `callRemoteTool(...)` `src/remote-client.ts:191-201`. |
| Session id for gateway metadata | `resolveSessionId()` `src/session-id.ts:17`. |
| Audit logging | `logLine()` `src/index.ts:84-109`. |
| Stale-cache eviction pattern (for learned schemas) | `evictStaleSkills()` `src/skill-writer.ts:46`. |

---

## 14. Phased implementation plan

### Phase 0 — shared refactors (no behavior change)
- Extract `invokeTool(...)` from `handleRunTool`.
- Promote `findToolJson` → `discoverTools()` (sorted order + collision detection — also fixes today's silent first-match-wins).
- Extract `withRemoteSession(label, fn)`.
- **Acceptance:** existing `run_tool` / `find_skills` tests still pass; no new tool.

### Phase 1 — `run_code` skeleton: read-only + plan-only, behind `ENABLE_RUN_CODE=off`
- Worker host (`src/tools/run-code/worker.ts`) + parent driver + bridge.
- `node:vm` context; **stateful sessions** with variable persistence (incl. the
  top-level `const`/`let` persistence shim — see Risks); idle-TTL + LRU + heap eviction.
- `PTC_*` bindings generated from `discoverTools()`; `ToolResult`; `inspect`/`shape`/`preview`/`print`; autoSummarize; result envelope with `session` hint.
- **Side-effecting calls are stubbed + recorded** (exercise the full loop with zero write risk); read-only calls execute for real.
- Limits, `terminate()` kill, `logLine` audit.
- **Acceptance:** model can probe a real read tool, `inspect` it, write a 2nd cell using a live variable, and `return` a small value; a 1-read-tool cell behaves like `run_tool`.

### Phase 2 — enable writes + bulk approval
- `PTC_` pre-scan → bulk approval card → `elicitInput`; **runtime allowlist backstop**; session-scoped grants; fail-closed on elicitation error.
- Flip `run_tool` HITL to **fail-closed** (today's `run-tool.ts:172` fails *open*).
- Execution ledger + partial-failure contract (preserve vars on throw).
- Plan-only fallback for non-elicitation hosts.
- **Acceptance:** a read-then-write program runs with exactly one approval; a reflective write triggers a just-in-time prompt; a mid-program failure returns a correct ledger with vars intact.

### Phase 3 — learned schemas + hardening
- Observed-schema learner → `.observed/<skill>/<TOOL>.schema.json`, surfaced via `schemaOf()` and appended to `find_skills` output; generated JSDoc signatures in the API surface.
- Optional engine upgrade `node:vm` → QuickJS-WASM (defense-in-depth), gated on a zip-size spike build (§16).
- **Acceptance:** repeat calls to a hot tool need no probe; `schemaOf` returns a useful shape.

---

## 15. Configuration

*Implemented:*

| Env var | Default | Purpose |
|---|---|---|
| `ENABLE_RUN_CODE` | `false` | Master flag. On → `run_code` replaces `run_tool` in the tool list. |
| `ENABLE_HITL` | `false` | Gates approval prompts (shared with `run_tool`). |
| `GLEAN_PTC_TIMEOUT_MS` | `60000` | Wall-clock per cell. |
| `GLEAN_PTC_MAX_CALLS` | `200` | Max tool calls per cell. |
| `GLEAN_PTC_MAX_INLINE_CHARS` | `5000` | Above this, a `return` value / stdout overflows to a file and the model gets a `{shape, path}` pointer. |

*Deferred (worker model only):* `GLEAN_PTC_SESSION_TTL_MS`, `GLEAN_PTC_MAX_SESSIONS`, `GLEAN_PTC_MAX_HEAP_MB`.

### Result contract (current)

```jsonc
{
  "ok": true,
  "stdout": "...",                 // print() output; overflows to stdout_path past the cap
  "stdout_path": "/abs/....txt",   // present only on stdout overflow
  "value": <your return value VERBATIM>,   // OR { "__overflow": true, "shape", "path", "bytes", "note" }
  "observed_schemas": { "TOOL": "{ ...shape... }" },  // shape of each tool called this run (auto)
  "ledger": [ { "toolName", "serverId", "state": "committed|failed|ambiguous|declined", "durationMs" } ],
  "session": { "fresh": false, "calls": 1 },
  "overflow": false,
  "hints": [ ... ]
}
```

`inspect(x)` returns/prints the **shape only** (never values). `observed_schemas`
already covers raw tool outputs automatically; `inspect` is the manual version
for computed values or deeper drill-down.

---

## 16. Risks

- **`node:vm` is not a realm boundary.** Closed in practice by credential
  isolation; fully closed by the Phase-3 QuickJS-WASM swap (adds ~1 MB base64
  WASM to the single-file bundle; ASYNCIFY forbids `Promise.all` of tool calls;
  gate on a zip-size spike build because the validator's size ceiling is unverified).
- **Top-level `const`/`let` persistence across `vm` runs** needs a
  declaration-hoisting/rewrite shim (top-level `const x` in a `runInContext`
  script does not persist to the context global). Real correctness surface; must be tested.
- **Static scan blind spots** (loops/args/reflection) — mitigated by the runtime
  allowlist, but the card's counts are approximate; wording must say so.
- **Session bleed** on hosts without `GLEAN_SESSION_ID` (per-process fallback UUID).
- **No atomicity / rollback** — must be stated loudly in the `run_code` tool description.
- **Learned schemas are heuristic** — labeled `observed-not-guaranteed`, never
  used as validation, stored redacted/typed-only and local-only (PII).
- **Memory** — warm sessions keep fetched payloads resident; bounded by heap cap + LRU + TTL.

---

## 17. Open questions

1. **Session identity on hosts without `GLEAN_SESSION_ID`** — accept the
   per-process bleed (documented + `reset`), or invest in a better key?
2. **Phase-3 engine** — is the QuickJS-WASM bundle-size bet worth it, and does
   the plugin zip validator have a size ceiling? (Needs a spike to answer.)
3. **Approval granularity** — is per-session grant the right default, or should
   destructive tools always re-prompt even within a session?
4. **Defaults** — confirm the proposed caps (TTL 30 min, 8 sessions, 256 MB,
   60 s, 100 read / 25 write).
5. **Should `run_tool` stay** once `run_code` exists, or become a thin 1-call
   wrapper over the same `invokeTool`?
6. **Plan-only fallback** — how important are non-elicitation hosts in the target matrix?
```
