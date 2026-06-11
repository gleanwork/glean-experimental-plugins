import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callRemoteTool } from "../remote-client.js";
import { writeSkillsToDisk, formatAvailableSkillsPrompt } from "../skill-writer.js";
import type { SkillsMap } from "../types.js";

export async function handleFindSkills(
  remoteClient: Client,
  skillsBaseDir: string,
  args: Record<string, unknown>,
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
  return formatAvailableSkillsPrompt(index);
}
