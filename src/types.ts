/**
 * Wire format from find_skills: a flat map of slash-separated file paths to
 * file contents (e.g. {"SKILL.md": "...", "tools/FOO.json": "..."}).
 */
export type SkillDirectoryMap = Record<string, string>;

/**
 * Wire format from find_skills: a map of skill names to their file maps.
 */
export type SkillsMap = Record<string, SkillDirectoryMap>;

export interface SkillIndex {
  name: string;
  description: string;
  skillDir: string;
  files: string[];
}
