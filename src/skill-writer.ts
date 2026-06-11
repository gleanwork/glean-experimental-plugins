import fs from "node:fs/promises";
import path from "node:path";
import yaml from "yaml";
import type { SkillsMap, SkillIndex } from "./types.js";

function isInsideDir(filePath: string, dir: string): boolean {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(path.resolve(dir) + path.sep);
}

/**
 * Parses YAML frontmatter from a SKILL.md string, returning key-value pairs
 * for top-level scalar fields (name, description, etc.).
 */
function parseFrontmatter(content: string): Record<string, string> {
  // Extract the YAML block between --- delimiters, allowing CRLF line endings.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }
  const result: Record<string, string> = {};
  try {
    const parsed = yaml.parse(match[1]);
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          result[key] = value;
        }
      }
    }
  } catch {
    return {};
  }
  return result;
}

type LogFn = (label: string, detail?: Record<string, unknown>) => void;

/**
 * Remove cached skill subdirectories whose mtime is older than `maxAgeMs`.
 * `writeSkillsToDisk` rm-then-mkdir's a skill dir on every refetch, so dir
 * mtime is a reliable last-refresh signal. Safe to evict aggressively —
 * find_skills re-fetches on demand if the agent references a skill whose
 * files were removed.
 */
export async function evictStaleSkills(
  baseDir: string,
  maxAgeMs: number,
  log?: LogFn,
  now: number = Date.now(),
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = now - maxAgeMs;
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const skillDir = path.resolve(baseDir, entry.name);
      if (!isInsideDir(skillDir, baseDir)) return;
      try {
        const stat = await fs.stat(skillDir);
        if (stat.mtimeMs < cutoff) {
          await fs.rm(skillDir, { recursive: true, force: true });
          log?.("evict-stale-skill", { skill: entry.name });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log?.("evict-stale-skill.failed", { skill: entry.name, msg });
      }
    }),
  );
}

export async function writeSkillsToDisk(
  skills: SkillsMap,
  baseDir: string,
): Promise<SkillIndex[]> {
  const index: SkillIndex[] = [];

  for (const [skillName, fileMap] of Object.entries(skills)) {
    const skillDir = path.resolve(baseDir, skillName);
    if (!isInsideDir(skillDir, baseDir)) {
      continue;
    }

    // Delete and re-create so re-fetched skills never serve stale files.
    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.mkdir(skillDir, { recursive: true });

    const writtenFiles: string[] = [];

    for (const [filePath, content] of Object.entries(fileMap)) {
      const fullPath = path.resolve(skillDir, filePath);
      if (!isInsideDir(fullPath, skillDir)) {
        continue;
      }
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      const text =
        typeof content === "string" ? content : JSON.stringify(content);
      await fs.writeFile(fullPath, text, "utf-8");
      writtenFiles.push(fullPath);
    }

    const rawSkillMd = fileMap["SKILL.md"] ?? "";
    const skillMdContent = typeof rawSkillMd === "string" ? rawSkillMd : "";
    const frontmatter = parseFrontmatter(skillMdContent);

    index.push({
      name: frontmatter.name ?? skillName,
      description: frontmatter.description ?? "",
      skillDir,
      files: writtenFiles,
    });
  }

  return index;
}

export function formatAvailableSkillsPrompt(index: SkillIndex[]): string {
  if (index.length === 0) {
    return "<available_skills />";
  }

  const skillEntries = index.map((entry) => {
    const skillMd = entry.files.find((f) => f.endsWith("/SKILL.md"));
    const fileLines = skillMd
      ? `\n      <file path="${escapeXml(skillMd)}" />\n    `
      : "";

    return [
      `  <skill name="${escapeXml(entry.name)}" description="${escapeXml(entry.description)}">`,
      `    <files>${fileLines}</files>`,
      `  </skill>`,
    ].join("\n");
  });

  const instructions = [
    "<instructions>",
    "To use a skill: (1) Browse the skills below and select the one most relevant " +
      "to the user's request. (2) Read its SKILL.md for instructions. " +
      "(3) Read each tool's JSON file (e.g. tools/TOOL_NAME.json) to get the exact " +
      "server_id, name, and inputSchema with exact parameter names and types. " +
      "(4) Call run_tool with the server_id, tool_name (from the name field), " +
      "and arguments matching the inputSchema. " +
      "Do NOT guess parameter names — always read the tool JSON file first.",
    "</instructions>",
  ].join("\n");

  return [
    "<available_skills>",
    instructions,
    ...skillEntries,
    "</available_skills>",
  ].join("\n");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
