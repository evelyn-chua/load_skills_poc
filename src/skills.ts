import { jsonSchema, tool, type ModelMessage, type ToolSet } from 'ai';
import type { AgentConfig, SkillConfig, ToolConfig } from './config';

export const LOAD_SKILL = 'load_skill';
export const END_CHAT = 'end_chat';

/** The base prompt's {{channel}}: this POC is web chat only. */
const CHANNEL = 'web chat';

/** What the agent's tools change on a thread. */
export interface ThreadState {
  endedAt: Date | null;
}

/** What the model sees on a step: the system prompt and the tools it may call. */
export interface AppliedSkill {
  instructions: string;
  activeTools: string[];
}

/**
 * The skill the conversation last loaded: the latest successful `load_skill` result in `messages`.
 * The history is the only record of which skill is applied, so it carries across turns with it.
 */
export function latestLoadedSkill(messages: ModelMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'tool') continue;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const part = message.content[j]!;
      if (part.type !== 'tool-result' || part.toolName !== LOAD_SKILL || part.output.type !== 'json') continue;
      const result = part.output.value as { success?: unknown; skill_name?: unknown } | null;
      if (result?.success === true && typeof result.skill_name === 'string') return result.skill_name;
    }
  }
  return null;
}

/**
 * The single agent from `config/`. It always has the base prompt and the common tools
 * (`load_skill`, `end_chat`). Each step, the skill the conversation last loaded is applied on top:
 * its instructions and tools, with its dependencies' (e.g. verify_identity) ahead of it. Loading
 * another skill replaces it from the next step on.
 */
export function createSkillAgent(config: AgentConfig) {
  const skillsByName = new Map(config.skills.map((skill) => [skill.name, skill]));

  /** The skill with its dependencies, dependencies first. config.ts checks every dependency exists. */
  function withDependencies(name: string): SkillConfig[] {
    const skill = skillsByName.get(name);
    if (!skill) return [];
    return [...skill.depends_on.map((dep) => skillsByName.get(dep)!), skill];
  }

  /**
   * `load_skill`'s result, shaped as `config/primary_tools.json` describes. It changes nothing:
   * the next step reads it from the history (`latestLoadedSkill`) and applies the skill.
   */
  function loadSkill(name: string, loaded: string | null) {
    const skills = withDependencies(name);
    if (skills.length === 0) return { success: false, skill_name: name, error: `Unknown skill: ${name}` };
    return {
      success: true,
      skill_name: name,
      already_loaded: loaded === name,
      dependencies_loaded: skills.slice(0, -1).map((skill) => skill.name),
      tools_added: skills.flatMap((skill) => skill.tools.map((t) => t.function.name)),
      instructions: Object.fromEntries(skills.map((skill) => [skill.name, skill.instructions])),
    };
  }

  /** The system prompt and tool names for a step, with `skill` (and its dependencies) applied. */
  function current(skill: string | null): AppliedSkill {
    const skills = skill ? withDependencies(skill) : [];
    return {
      instructions: composePrompt(config, skills),
      activeTools: [...config.commonTools, ...skills.flatMap((s) => s.tools)].map((t) => t.function.name),
    };
  }

  /**
   * Every tool the agent could ever call; `current().activeTools` picks which the model is offered on
   * a step. Skill tools are mocks that return their example response from `config/skills.json`.
   */
  function tools(thread: ThreadState): ToolSet {
    const set: ToolSet = {};
    for (const definition of [...config.commonTools, ...config.skills.flatMap((skill) => skill.tools)]) {
      set[definition.function.name] = configTool(definition, () => definition.response);
    }
    set[LOAD_SKILL] = configTool(commonTool(LOAD_SKILL), (input, { messages }) => loadSkill(String(input.skill_name), latestLoadedSkill(messages)));
    set[END_CHAT] = configTool(commonTool(END_CHAT), () => {
      thread.endedAt = new Date();
      return commonTool(END_CHAT).response;
    });
    return set;
  }

  function commonTool(name: string): ToolConfig {
    const found = config.commonTools.find((t) => t.function.name === name);
    if (!found) throw new Error(`config/primary_tools.json has no ${name} tool`);
    return found;
  }

  return { loadSkill, current, tools };
}

function configTool(definition: ToolConfig, execute: (input: Record<string, unknown>, options: { messages: ModelMessage[] }) => unknown) {
  return tool({
    description: definition.function.description,
    inputSchema: jsonSchema<Record<string, unknown>>(definition.function.parameters),
    execute: async (input, options) => execute(input, options),
  });
}

/**
 * The system prompt for a step: the base prompt (its placeholders filled), how to use the common
 * tools, then the applied skill's instructions, dependencies first. Only the last section changes
 * when another skill is loaded.
 */
function composePrompt(config: AgentConfig, skills: SkillConfig[]): string {
  const now = new Date();
  const vars: Record<string, string> = {
    current_date: `${now.toLocaleDateString('en-US', { weekday: 'long' })}, ${now.toLocaleDateString('en-CA')}`,
    channel: CHANNEL,
  };
  const base = config.systemPrompt.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => vars[name] ?? match).trim();
  const toolInstructions = config.commonTools
    .filter((t) => t.instructions)
    .map((t) => `### ${t.function.name}\n${t.instructions}`)
    .join('\n\n');
  const sections = [base, `## Tool instructions\n\n${toolInstructions}`];
  if (skills.length > 0) {
    const active = skills.at(-1)!.name;
    sections.push(`## Active skill: ${active}\n\n${skills.map((skill) => `### ${skill.name}\n${skill.instructions}`).join('\n\n')}`);
  }
  return sections.join('\n\n---\n\n');
}
