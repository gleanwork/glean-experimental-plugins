import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  writeSkillsToDisk,
  formatAvailableSkillsPrompt,
  evictStaleSkills,
} from "../src/skill-writer.js";
import type { SkillsMap, SkillIndex } from "../src/types.js";

describe("writeSkillsToDisk", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "skill-writer-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes all files from the flat map", async () => {
    const skills: SkillsMap = {
      "search-jira": {
        "SKILL.md":
          "---\nname: search-jira\ndescription: Search Jira issues\n---\n# Search Jira\nUse this skill to search Jira.",
        "tools/jirasearch.json": JSON.stringify({
          server_id: "composio/jira-pack",
          tool_name: "jirasearch",
          description: "Search Jira issues",
          input_schema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        }),
      },
    };

    const index = await writeSkillsToDisk(skills, tmpDir);

    expect(index).toHaveLength(1);
    expect(index[0].name).toBe("search-jira");
    expect(index[0].description).toBe("Search Jira issues");
    expect(index[0].files).toHaveLength(2);

    expect(
      await fs.readFile(
        path.join(tmpDir, "search-jira", "SKILL.md"),
        "utf-8",
      ),
    ).toContain("# Search Jira");

    const toolJson = JSON.parse(
      await fs.readFile(
        path.join(tmpDir, "search-jira", "tools", "jirasearch.json"),
        "utf-8",
      ),
    );
    expect(toolJson.server_id).toBe("composio/jira-pack");
    expect(toolJson.input_schema.properties.query.type).toBe("string");
  });

  it("creates nested directories from slash-separated paths", async () => {
    const skills: SkillsMap = {
      "code-review": {
        "SKILL.md":
          "---\nname: code-review\ndescription: Review code\n---\n# Code Review",
        "templates/review.md": "## Template\nReview checklist",
        "config.yaml": "threshold: 0.8",
      },
    };

    const index = await writeSkillsToDisk(skills, tmpDir);

    expect(index[0].files).toHaveLength(3);
    expect(
      await fs.readFile(
        path.join(tmpDir, "code-review", "templates", "review.md"),
        "utf-8",
      ),
    ).toBe("## Template\nReview checklist");
    expect(
      await fs.readFile(
        path.join(tmpDir, "code-review", "config.yaml"),
        "utf-8",
      ),
    ).toBe("threshold: 0.8");
  });

  it("parses frontmatter and falls back to directory key when missing", async () => {
    const skills: SkillsMap = {
      "gcal-event-creation": {
        "SKILL.md":
          "---\nname: gcal-event-creation\ndescription: Create Google Calendar events\nmetadata:\n  author: glean\n---\n# Calendar",
      },
      "no-frontmatter": {
        "SKILL.md": "# No frontmatter here",
      },
    };

    const index = await writeSkillsToDisk(skills, tmpDir);

    expect(index[0].name).toBe("gcal-event-creation");
    expect(index[0].description).toBe("Create Google Calendar events");

    expect(index[1].name).toBe("no-frontmatter");
    expect(index[1].description).toBe("");
  });

  it("parses YAML block scalar descriptions", async () => {
    const skills: SkillsMap = {
      "block-scalar": {
        "SKILL.md":
          "---\nname: block-scalar\ndescription: >\n  This is a long description\n  spanning multiple lines\n---\n# Content",
      },
    };

    const index = await writeSkillsToDisk(skills, tmpDir);

    expect(index[0].name).toBe("block-scalar");
    expect(index[0].description).toContain("This is a long description");
    expect(index[0].description).toContain("spanning multiple lines");
  });

  it("parses YAML literal block scalar descriptions", async () => {
    const skills: SkillsMap = {
      "literal-scalar": {
        "SKILL.md":
          "---\nname: literal-scalar\ndescription: |\n  Line one\n  Line two\n---\n# Content",
      },
    };

    const index = await writeSkillsToDisk(skills, tmpDir);

    expect(index[0].name).toBe("literal-scalar");
    expect(index[0].description).toContain("Line one");
    expect(index[0].description).toContain("Line two");
  });

  it("parses YAML with value on next line", async () => {
    const skills: SkillsMap = {
      "next-line": {
        "SKILL.md":
          "---\nname: next-line\ndescription:\n  The value on next line\n---\n# Content",
      },
    };

    const index = await writeSkillsToDisk(skills, tmpDir);

    expect(index[0].name).toBe("next-line");
    expect(index[0].description).toBe("The value on next line");
  });

  it("parses frontmatter with CRLF line endings", async () => {
    const skills: SkillsMap = {
      "crlf-skill": {
        "SKILL.md":
          "---\r\nname: crlf-skill\r\ndescription: CRLF description\r\n---\r\n# Content",
      },
    };

    const index = await writeSkillsToDisk(skills, tmpDir);

    expect(index[0].name).toBe("crlf-skill");
    expect(index[0].description).toBe("CRLF description");
  });

  it("prevents path traversal in skill names and file paths", async () => {
    const skills: SkillsMap = {
      "../../etc/malicious": {
        "SKILL.md": "pwned",
      },
      "safe-skill": {
        "SKILL.md": "---\nname: safe-skill\ndescription: Safe\n---\n# Safe",
        "../../etc/passwd": "malicious content",
        "legit.md": "safe content",
      },
    };

    const index = await writeSkillsToDisk(skills, tmpDir);

    expect(index).toHaveLength(1);
    expect(index[0].name).toBe("safe-skill");
    expect(index[0].files).toHaveLength(2);
    expect(
      await fs.readFile(
        path.join(tmpDir, "safe-skill", "legit.md"),
        "utf-8",
      ),
    ).toBe("safe content");
    await expect(
      fs.access(path.join(tmpDir, "..", "etc", "passwd")),
    ).rejects.toThrow();
  });
});

describe("evictStaleSkills", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "evict-stale-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("removes directories older than the cutoff and keeps fresh ones", async () => {
    const oldDir = path.join(tmpDir, "stale");
    const freshDir = path.join(tmpDir, "fresh");
    await fs.mkdir(oldDir);
    await fs.writeFile(path.join(oldDir, "SKILL.md"), "old");
    await fs.mkdir(freshDir);
    await fs.writeFile(path.join(freshDir, "SKILL.md"), "new");

    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await fs.utimes(oldDir, eightDaysAgo / 1000, eightDaysAgo / 1000);

    await evictStaleSkills(tmpDir, 7 * 24 * 60 * 60 * 1000);

    await expect(fs.access(oldDir)).rejects.toThrow();
    await expect(fs.access(freshDir)).resolves.toBeUndefined();
  });

  it("is a no-op when the base directory does not exist", async () => {
    const missing = path.join(tmpDir, "does-not-exist");
    await expect(
      evictStaleSkills(missing, 7 * 24 * 60 * 60 * 1000),
    ).resolves.toBeUndefined();
  });

  it("ignores non-directory entries", async () => {
    const filePath = path.join(tmpDir, "stray.txt");
    await fs.writeFile(filePath, "not a skill");
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await fs.utimes(filePath, eightDaysAgo / 1000, eightDaysAgo / 1000);

    await evictStaleSkills(tmpDir, 7 * 24 * 60 * 60 * 1000);

    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it("keeps a directory whose mtime is exactly at the cutoff (strict <)", async () => {
    const boundaryDir = path.join(tmpDir, "boundary");
    await fs.mkdir(boundaryDir);
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    // Truncate to whole seconds so utimes stores the mtime exactly — filesystems
    // that only support second granularity would otherwise truncate the value
    // below the cutoff and incorrectly evict the directory.
    const now = Math.floor(Date.now() / 1000) * 1000;
    const cutoffSec = (now - maxAgeMs) / 1000;
    await fs.utimes(boundaryDir, cutoffSec, cutoffSec);

    await evictStaleSkills(tmpDir, maxAgeMs, undefined, now);

    await expect(fs.access(boundaryDir)).resolves.toBeUndefined();
  });

  it("invokes the log callback for each evicted skill", async () => {
    const staleDir = path.join(tmpDir, "stale-logged");
    await fs.mkdir(staleDir);
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await fs.utimes(staleDir, eightDaysAgo / 1000, eightDaysAgo / 1000);

    const calls: { label: string; detail?: Record<string, unknown> }[] = [];
    await evictStaleSkills(
      tmpDir,
      7 * 24 * 60 * 60 * 1000,
      (label, detail) => {
        calls.push({ label, detail });
      },
    );

    expect(
      calls.some(
        (c) =>
          c.label === "evict-stale-skill" &&
          c.detail?.skill === "stale-logged",
      ),
    ).toBe(true);
  });
});

describe("formatAvailableSkillsPrompt", () => {
  it("formats skills with instructions and file references", () => {
    const index: SkillIndex[] = [
      {
        name: "search-jira",
        description: "Search Jira issues",
        skillDir: "/tmp/skills/search-jira",
        files: [
          "/tmp/skills/search-jira/SKILL.md",
          "/tmp/skills/search-jira/tools/jirasearch.json",
        ],
      },
      {
        name: "create-event",
        description: "Create calendar events",
        skillDir: "/tmp/skills/create-event",
        files: ["/tmp/skills/create-event/SKILL.md"],
      },
    ];

    const result = formatAvailableSkillsPrompt(index);

    expect(result).toContain("<available_skills>");
    expect(result).toContain("<instructions>");
    expect(result).toContain("Browse the skills below");
    expect(result).toContain('name="search-jira"');
    expect(result).toContain('description="Search Jira issues"');
    expect(result).toContain('path="/tmp/skills/search-jira/SKILL.md"');
    expect(result).not.toContain(
      'path="/tmp/skills/search-jira/tools/jirasearch.json"',
    );
    expect(result).toContain('name="create-event"');
    expect(result).toContain("</available_skills>");
  });

  it("escapes XML special characters", () => {
    const index: SkillIndex[] = [
      {
        name: "test",
        description: 'Has "quotes" & <angles>',
        skillDir: "/tmp/test",
        files: [],
      },
    ];

    const result = formatAvailableSkillsPrompt(index);

    expect(result).toContain("&amp;");
    expect(result).toContain("&lt;angles&gt;");
    expect(result).toContain("&quot;quotes&quot;");
  });
});
