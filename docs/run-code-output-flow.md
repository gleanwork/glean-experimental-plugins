# run_code — how a tool's output flows to the model

> A focused explainer of where a tool call's raw output goes inside `run_code`:
> into the VM, into `observed_schemas`, into the returned `value`, or into a
> file. Companion to the full design in
> [programmatic-tool-calls.md](./programmatic-tool-calls.md).

## TL;DR

When your code calls `await PTC_search(...)`, the **raw output does not go to
one place — it splits three ways**:

1. The **full payload** is wrapped in a `ToolResult` (`r`) and **stays in VM
   memory**. It never crosses back to you on its own.
2. Its **shape** (not its data) is recorded automatically in
   `observed_schemas[tool]`.
3. Only **what you `return`** becomes `value`, and only **what you `print()`**
   becomes `stdout` — and each of those, *if larger than 5000 chars*, is written
   to a **file** and replaced with a `{shape, path}` pointer.

A file is an **overflow valve**, not the normal destination for tool output.

---

## Sequence

```mermaid
sequenceDiagram
    participant M as Model (LLM)
    participant H as run_code handler (parent)
    participant V as VM sandbox
    participant B as __ptcDispatch (parent bridge)
    participant R as Glean remote

    M->>H: run_code({ code })
    H->>H: discoverTools → inject PTC_* bindings
    H->>V: run wrapped code
    V->>B: await PTC_search(args)
    B->>R: callRemoteTool (direct) / invokeTool (gateway)
    R-->>B: CallToolResult { content[].text, structuredContent? }   ⟵ RAW
    B->>B: text = join(content.text); structured = structuredContent
    B->>H: learnShape(structured ?? parse(text)) ⟶ observed_schemas[tool] = SHAPE
    B-->>V: { isError, content, text, structured }
    V->>V: r = new ToolResult(raw)
    Note over V: FULL raw lives in r, in VM memory.<br/>r.json() = structured ?? JSON.parse(text) ?? undefined<br/>r.get(path, fallback), r.text
    V-->>H: cell returns <value>   (and/or print() ⟶ stdout)
    H->>H: normalizeForSummary(value) → serialize
    alt serialized ≤ 5000 chars
        H->>H: value = verbatim
    else > 5000 chars
        H->>H: write file ⟶ value = { __overflow, shape, path, bytes }
    end
    H-->>M: envelope { ok, value, stdout, observed_schemas, ledger }
```

---

## The three sinks for raw output

| Sink | Gets | When | Crosses back to the model? |
|---|---|---|---|
| **`r` — `ToolResult` in the VM** | the **full** raw output: `.text`, `.structuredContent`, `.json()`, `.get(path, fallback)`, `.content`, `.isError` | every call | **No.** Stays in VM memory for your code to compute over. |
| **`observed_schemas[tool]`** | just the **shape** of the raw output | every *successful* call, automatically | **Yes** — shape only, cheap. |
| **`value`** | **only what you `return`** | at cell end | Yes — **verbatim if ≤ 5000 chars, else a `{__overflow, shape, path, bytes}` file pointer**. |
| **`stdout`** | **only what you `print(...)`** | at cell end | Yes — inline if ≤ 5000 chars, else truncated head + `stdout_path` file. |

Key consequences:

- **Raw output never auto-becomes `value`.** `value` is *your chosen return*.
  `return r` (a 98KB blob) → that's >5000 → goes to a **file**. `return
  r.get("documents", []).length` → you get `5` inline.
- **A file appears only on overflow** of `value` or `stdout`. It is not where
  tool output "normally" lands.
- **`observed_schemas` is independent of what you return** — it's computed from
  the raw output at dispatch time, for every tool you call.

---

## `r.json()` — what you actually get back

```
r.json()  =  structuredContent           (if the tool provided it)
          ⟶  JSON.parse(r.text)           (else, if the text is valid JSON)
          ⟶  undefined                    (else — the output is prose/non-JSON; use r.text)
```

- `r.get("a.b.c", fallback)` walks `r.json()` by dotted path and returns
  `fallback` instead of throwing on a wrong path.
- **Don't write `if (r.json())`** — `json()` returns `undefined` for non-JSON,
  but a marker string would be truthy and mislead you. Branch on **`r.format`**
  instead: `"json"` | `"text"` | `"empty"`.
- **`inspect(r)`** says it plainly: the shape if it's JSON, else
  `"ToolResult: non-JSON text (~N chars) — .json() is undefined; use .text…"`.
  And `observed_schemas[tool]` carries the same non-JSON note — so you learn the
  output isn't JSON immediately, not by discovering an empty `.json()`.

> Why `.json()` still returns `undefined` (not a "not JSON" value): code does
> `if (r.json())`, `r.json().field`, `JSON.stringify(r.json())`. A non-`undefined`
> sentinel would make `if (r.json())` truthy and silently break those. So the
> "it's not JSON" signal lives in `.format` / `inspect` / `observed_schemas`,
> never in `.json()`'s return.

---

## Worked examples

### 1. Small return — verbatim
```js
const r = await PTC_JIRA_SEARCH({ jql: "assignee = currentUser() AND priority = P0" });
return r.get("issues", []).length;
```
Envelope:
```jsonc
{ "ok": true,
  "value": 7,                                  // verbatim, inline
  "observed_schemas": { "JIRA_SEARCH": "{ issues: Array<{ key: string, ... }>, total: number }" },
  "ledger": [ { "toolName": "JIRA_SEARCH", "state": "committed" } ],
  "overflow": false }
```

### 2. Big return — overflows to a file
```js
const r = await PTC_JIRA_SEARCH({ jql: "..." });
return r.json();                               // the whole result object
```
Envelope:
```jsonc
{ "ok": true,
  "value": {
    "__overflow": true,
    "shape": "{ issues: Array<{ key, fields:{...} }>[120], total: number }",
    "bytes": 84213,
    "path": ".../glean-run-code-results/value-...json",
    "note": "Return value exceeded the inline cap and was written to this file..."
  },
  "overflow": true }
```
→ `Read` the `path` (with offset/limit/grep) — **do not re-run the tool**; the
data is also still in `r` in your session.

### 3. Non-JSON tool (today's `search`) — the regex trap
```js
const r = await PTC_search({ query: "intern onboarding" });
r.json();        // undefined — search returns YAML-ish text, not JSON
return r.text;   // 98KB → overflows to a file
```
Envelope:
```jsonc
{ "observed_schemas": { "search": "non-JSON text (~98000 chars) — read .text and parse it" },
  "value": { "__overflow": true, "path": "...", ... },
  "overflow": true }
```
This is the painful case: the model ends up hand-parsing text. The durable fix
is for the `search` tool to emit `structuredContent` (then `r.json()` works and
`observed_schemas` shows a real shape).

---

## Where the data physically lives

- **VM memory** (`r`, and any variable you bare-assign): persists across
  `run_code` calls for the lifetime of the plugin process; cleared on
  `reset: true` or process exit. The full tool payloads live here.
- **`<skillsBaseDir>/../glean-run-code-results/`**: overflow files for oversized
  `value` / `stdout`. JSON for values, `.txt` for stdout.
- **`<skillsBaseDir>/.observed/<skill>/<TOOL>.schema.json`**: learned output
  shapes, persisted across runs and seeded back into `find_skills`.
- **The model's context**: only the envelope (`value` summary-or-pointer,
  `stdout`, `observed_schemas`, `ledger`, `hints`) — never the raw payloads
  unless you explicitly `return`/`print` them.

---

## Code map (for the curious)

- Bridge + dispatch + `learnShape`: `src/tools/run-code.ts` → `ptcDispatch`,
  `learnShape`.
- `ToolResult` (`.json()` prefers `structuredContent`): `src/tools/run-code.ts`
  → `PREAMBLE`.
- Envelope assembly (verbatim vs file overflow): `src/tools/run-code.ts` →
  `handleRunCode` (the `value` / `stdout` overflow block, `writeOverflowFile`).
- Shape inference (incl. heterogeneous-array merge): `src/tools/run-code.ts` →
  `shapeOf`, `arrayElemShape`.
- Learned-schema persistence + seeding: `src/skill-tools.ts`
  (`observedSchemaPath`, `loadObservedSchemas`), surfaced via
  `src/tools/find-skills.ts`.
