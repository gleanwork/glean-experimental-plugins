import fs from "node:fs/promises";
import path from "node:path";

/**
 * Metadata for a single downstream tool, read from a cached
 * <skillsBaseDir>/<skill>/tools/<TOOL>.json file. The find_skills flow writes
 * these files; both run_tool (for HITL lookup) and run_code (for binding
 * generation) read them through here.
 */
export interface ToolMeta {
  /** Tool name == the JSON filename stem (e.g. "JIRA_CREATE_ISSUE"). */
  toolName: string;
  /** Owning skill directory name. */
  skillName: string;
  /** Downstream MCP server id this tool dispatches to ("" for direct tools). */
  serverId: string;
  requiresApproval: boolean;
  /**
   * "Head"/first-class remote tools (search, read_document, …) are called
   * directly on the remote client by name, NOT via the run_tool gateway. The
   * run_code bridge checks this flag to pick the dispatch path.
   */
  direct: boolean;
  description: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

interface RawToolJson {
  server_id?: string;
  requires_approval?: boolean;
  direct?: boolean;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

/** Minimal shape of a head/first-class remote tool (from tools/list). */
export interface HeadTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

// Head tools are written under this synthetic skill dir so discoverTools binds
// them uniformly. The leading "_" keeps it out of the way alphabetically and
// out of the find_skills response skill set (writeSkillsToDisk never rm's it).
export const CORE_SKILL = "_core";

/**
 * Discover every cached tool across all skills, in deterministic order
 * (skills sorted, then tools sorted). Deterministic ordering matters because
 * run_tool's old findToolJson relied on undefined readdir order, which made
 * cross-skill tool-name collisions resolve to an arbitrary server_id. Callers
 * that need a single tool by name should use findToolMeta, which surfaces
 * collisions instead of silently picking the first match.
 */
export async function discoverTools(skillsBaseDir: string): Promise<ToolMeta[]> {
  let skillDirs;
  try {
    skillDirs = await fs.readdir(skillsBaseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: ToolMeta[] = [];
  const sortedSkills = skillDirs
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const skillName of sortedSkills) {
    const toolsDir = path.join(skillsBaseDir, skillName, "tools");
    let toolFiles;
    try {
      toolFiles = await fs.readdir(toolsDir);
    } catch {
      continue;
    }
    for (const file of toolFiles.filter((f) => f.endsWith(".json")).sort()) {
      const toolName = file.slice(0, -".json".length);
      try {
        const raw = JSON.parse(
          await fs.readFile(path.join(toolsDir, file), "utf-8"),
        ) as RawToolJson;
        const direct = raw.direct === true;
        // Gateway tools need a server_id; direct (head) tools don't.
        if (typeof raw.server_id !== "string" && !direct) continue;
        out.push({
          toolName,
          skillName,
          serverId: typeof raw.server_id === "string" ? raw.server_id : "",
          requiresApproval: raw.requires_approval === true,
          direct,
          description: typeof raw.description === "string" ? raw.description : "",
          inputSchema: raw.inputSchema,
          annotations:
            raw.annotations && typeof raw.annotations === "object"
              ? (raw.annotations as Record<string, unknown>)
              : undefined,
        });
      } catch {
        continue;
      }
    }
  }
  return out;
}

/**
 * Find a single tool by name. Returns the first match in deterministic order.
 * If the same tool name exists under multiple skills with different server
 * ids, `ambiguous` lists the candidate server ids so the caller can warn.
 */
export async function findToolMeta(
  skillsBaseDir: string,
  toolName: string,
): Promise<{ meta: ToolMeta | null; ambiguous: string[] }> {
  const all = await discoverTools(skillsBaseDir);
  const matches = all.filter((t) => t.toolName === toolName);
  if (matches.length === 0) return { meta: null, ambiguous: [] };
  const serverIds = [...new Set(matches.map((m) => m.serverId))];
  return {
    meta: matches[0],
    ambiguous: serverIds.length > 1 ? serverIds : [],
  };
}

// run_code's learned output schemas live under a top-level `.observed/` dir
// (NOT inside each per-skill dir), because writeSkillsToDisk rm-and-recreates
// a skill dir on every refetch — which would otherwise wipe what we learned.
// `.observed/<skill>/<TOOL>.schema.json`.
const OBSERVED_DIR = ".observed";

export function observedSchemaPath(
  skillsBaseDir: string,
  skillName: string,
  toolName: string,
): string {
  return path.join(skillsBaseDir, OBSERVED_DIR, skillName, `${toolName}.schema.json`);
}

export function coreToolSchemaPath(
  skillsBaseDir: string,
  toolName: string,
): string {
  return path.join(skillsBaseDir, CORE_SKILL, "tools", `${toolName}.json`);
}

/**
 * Materialize the head/first-class remote tools as `_core/tools/<name>.json`
 * files (tagged direct:true) so discoverTools binds them and the model can read
 * their inputSchema like any other tool. rm-and-recreates so a tool dropped
 * from the allow-list disappears. No-op (and leaves any prior _core intact)
 * when the head-tool list is empty, so a transient empty cache doesn't wipe it.
 */
export async function writeCoreTools(
  skillsBaseDir: string,
  headTools: HeadTool[],
): Promise<void> {
  if (!headTools.length) return;
  const coreDir = path.join(skillsBaseDir, CORE_SKILL);
  const toolsDir = path.join(coreDir, "tools");
  try {
    await fs.rm(coreDir, { recursive: true, force: true });
    await fs.mkdir(toolsDir, { recursive: true });
    await Promise.all(
      headTools.map((t) =>
        fs.writeFile(
          path.join(toolsDir, `${t.name}.json`),
          JSON.stringify(
            {
              name: t.name,
              direct: true,
              requires_approval: false,
              description: t.description ?? "",
              inputSchema: t.inputSchema ?? { type: "object", properties: {} },
            },
            null,
            2,
          ),
          "utf-8",
        ),
      ),
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Load all learned output schemas: skillName -> (toolName -> shape string).
 * Used to seed find_skills output so the model knows result shapes before its
 * first call. Best-effort; missing/corrupt files are skipped.
 */
export async function loadObservedSchemas(
  skillsBaseDir: string,
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  const root = path.join(skillsBaseDir, OBSERVED_DIR);
  let skillDirs;
  try {
    skillDirs = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of skillDirs) {
    if (!d.isDirectory()) continue;
    let files;
    try {
      files = await fs.readdir(path.join(root, d.name));
    } catch {
      continue;
    }
    const byTool = new Map<string, string>();
    for (const f of files) {
      if (!f.endsWith(".schema.json")) continue;
      try {
        const raw = JSON.parse(
          await fs.readFile(path.join(root, d.name, f), "utf-8"),
        ) as { shape?: string };
        if (typeof raw.shape === "string") {
          byTool.set(f.slice(0, -".schema.json".length), raw.shape);
        }
      } catch {
        continue;
      }
    }
    if (byTool.size) out.set(d.name, byTool);
  }
  return out;
}
