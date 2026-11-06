import { readFileSync } from 'node:fs';
import type { JSONSchema7 } from 'ai';

/** A tool as `config/` defines it: an OpenAI function tool, plus its example `response`. */
export interface ToolConfig {
  type: 'function';
  function: { name: string; description: string; parameters: JSONSchema7 };
  /** How to use the tool. Only the common tools carry these; a skill's instructions cover its own tools. */
  instructions?: string;
  /** The tool's example response. Skill tools return it as their result: they are mocks. */
  response: unknown;
}

export interface SkillConfig {
  name: string;
  description: string;
  depends_on: string[];
  instructions: string;
  tools: ToolConfig[];
}

export interface AgentConfig {
  /** The base prompt (`config/system_prompt.md`), with `{{placeholders}}` still in it. */
  systemPrompt: string;
  /** The tools every turn has: `load_skill` and `end_chat`. */
  commonTools: ToolConfig[];
  skills: SkillConfig[];
}

const CONFIG_DIR = new URL('../config/', import.meta.url);

/** Reads `config/`, and checks that tool names are unique and every dependency is a skill. */
export function loadAgentConfig(): AgentConfig {
  const read = (file: string) => readFileSync(new URL(file, CONFIG_DIR), 'utf-8');
  const config: AgentConfig = {
    systemPrompt: read('system_prompt.md'),
    commonTools: JSON.parse(read('primary_tools.json')),
    skills: JSON.parse(read('skills.json')),
  };
  const toolNames = [...config.commonTools, ...config.skills.flatMap((skill) => skill.tools)].map((tool) => tool.function.name);
  const duplicate = toolNames.find((name, i) => toolNames.indexOf(name) !== i);
  if (duplicate) throw new Error(`config: tool ${duplicate} is defined twice`);
  const skillNames = new Set(config.skills.map((skill) => skill.name));
  for (const skill of config.skills) {
    const missing = skill.depends_on.find((dep) => !skillNames.has(dep));
    if (missing) throw new Error(`config: skill ${skill.name} depends on unknown skill ${missing}`);
  }
  return config;
}
