---
name: glean_run
description: Discover and run Glean skills for enterprise app tasks
---

# Glean Run

Discover and use Glean skills to help with enterprise app tasks (Jira, Slack,
Google Workspace, Salesforce, etc.) or actions you don't already have a tool for.
Where possible, aim to complete the user's request end-to-end rather than just
listing available skills.

## Authentication

Authentication is handled exclusively by the `setup` tool. If any other tool
returns a response containing `[SETUP_REQUIRED]` or `[AUTHENTICATION_REQUIRED]`,
the user needs to (re-)authenticate via `setup`.

When this happens:
1. Call `setup` (no arguments). It will return either a confirmation that
   setup is already complete, or instructions including a sign-in URL.
2. If a sign-in URL is returned, share it with the user. **Stop and wait.**
   Do not retry the original tool call, do not try alternative approaches,
   and do not proceed with other steps.
3. After signing in, the browser lands on a Glean callback page with a
   "Copy URL" button. Ask the user to click that button and paste the
   URL into chat.
4. Call `setup` again with `callback_url` set to the pasted URL. The
   pasted URL will look like
   `http://127.0.0.1:29107/callback?code=...&state=...`. Example:

   ```
   setup({
     callback_url: "http://127.0.0.1:29107/callback?code=...&state=..."
   })
   ```

5. Once `setup` confirms auth is complete, retry the original tool call.

Do not pass `callback_url` to any tool other than `setup` — only `setup`
accepts it. Do not treat `[SETUP_REQUIRED]` or `[AUTHENTICATION_REQUIRED]`
as an error or attempt to work around it any other way.

## Step 0: Verify Setup

Call `setup` (with no arguments) to confirm the Glean connection is
configured.

- If it returns `[SETUP_REQUIRED]`, relay the instructions to the user and
  wait for them to paste their Server URL. Then call `setup` again with
  `server_url` set to what they pasted.
- Once `setup` confirms configuration is complete, proceed to Step 1.

## Step 1: Plan tool usage

A small set of popular tools is directly available, and no discovery is
needed to use them. Discover is complementary and recommended if the
direct tools cannot satisfy the user request end to end.

### Calling `find_skills`

If no arguments were provided and the task can't be inferred from conversation
context, ask the user what they'd like to do before proceeding.

Call `find_skills` with the task descriptions.

**The first entry in `queries` MUST be the user's prompt verbatim** (the raw,
unmodified task description as the user phrased it). This ensures end-to-end
skills that match on the overall intent are discovered before you fragment
the request into pieces that only match low-level capability skills. After
the verbatim prompt, you may append additional atomic sub-tasks broken down
from the request.

```
find_skills({
  queries: [
    "<user's prompt verbatim>",
    "<atomic sub-task 1>",
    "<atomic sub-task 2>"
  ]
})
```

The response is an XML index of discovered skills with file paths.

You can call `find_skills` multiple times — e.g. to discover skills for
individual sub-tasks as you work through a broad request.

## Step 2: Read Skill Instructions

Browse the returned skills and select the one most relevant to the user's
request. Read its `SKILL.md` file for detailed instructions. Skills typically
contain guidance on how to use their tools, but the tools can also be called
as independent units.

## Step 3: Read Tool Schemas

Read each tool's JSON file (e.g. `tools/TOOL_NAME.json`) to get the exact
`server_id`, `name`, and `inputSchema` with parameter names and types.

**Never guess parameter names** - always read the tool JSON file first.

## Step 4: Execute Tools

Call `run_tool` with the `server_id`, `tool_name` (from the `name` field in the
JSON), and `arguments` matching the `inputSchema` exactly.

```
run_tool({
  server_id: "composio/jira-pack",
  tool_name: "jirasearch",
  arguments: { query: "project = PROJ AND status = Open" }
})
```

### Long-form arguments via `file_args`

For long-form content — drafted Slack messages, Confluence pages, doc
bodies, etc. — write the draft to a local file first, then reference it
via `file_args` instead of passing it as a huge inline string. The plugin
reads each file and substitutes its UTF-8 contents into the named key in
`arguments` before calling the remote tool.

```
run_tool({
  server_id: "...",
  tool_name: "slack_post_message",
  arguments: { channel: "C123" },
  file_args: { text: "/tmp/glean-drafts/announce.md" }
})
```

Constraints:
- Paths must be absolute.
- A key in `file_args` must not also appear in `arguments`.
- Each file must be ≤ 1 MB (override via `GLEAN_FILE_ARG_MAX_BYTES`).

## Rules

- Always read tool JSON files before calling `run_tool` - never guess parameters
- On `find_skills`, the first `queries` entry must always be the user's
  prompt verbatim; only append atomic sub-task decompositions after it
- If discovery returns no relevant skills, tell the user what was searched
