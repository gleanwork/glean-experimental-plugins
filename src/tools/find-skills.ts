import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callRemoteTool } from "../remote-client.js";
import { writeSkillsToDisk, formatAvailableSkillsPrompt } from "../skill-writer.js";
import { loadObservedSchemas } from "../skill-tools.js";
import type { SkillsMap } from "../types.js";

export async function handleFindSkills(
  remoteClient: Client,
  skillsBaseDir: string,
  args: Record<string, unknown>,
  opts: { codeMode?: boolean } = {},
): Promise<string> {
  const toolArgs: Record<string, unknown> = {};
  if (Array.isArray(args.queries)) {
    toolArgs.queries = args.queries;
  } else if (typeof args.query === "string") {
    toolArgs.queries = [args.query];
  }

  const result = await callRemoteTool(remoteClient, "find_skills", toolArgs);

  const textContent = result.content.find((c) => c.type === "text");
  if (!textContent || textContent.type !== "text") {
    return "<available_skills />";
  }

  if (result.isError) {
    throw new Error(textContent.text || "find_skills failed");
  }

  const parsed = JSON.parse(textContent.text) as { skills?: SkillsMap };
  if (!parsed.skills || typeof parsed.skills !== "object") {
    console.error(
      `find_skills: unexpected response shape, keys: ${Object.keys(parsed).join(", ")}`,
    );
    return "<available_skills />";
  }
  const index = await writeSkillsToDisk(parsed.skills, skillsBaseDir);
  // In code mode, seed the prompt with output shapes learned from past
  // run_code calls so the model can write a correct first call without probing.
  // (Head/first-class tools are NOT listed here — they live on the top-level
  // tool surface; calling one directly redirects the model into run_code.)
  const observed = opts.codeMode
    ? await loadObservedSchemas(skillsBaseDir)
    : undefined;
  return formatAvailableSkillsPrompt(index, { codeMode: opts.codeMode, observed });
}
