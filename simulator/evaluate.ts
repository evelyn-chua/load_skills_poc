/**
 * Deterministic checks of a finished conversation against a scenario's `evaluation` block, read off
 * the agent's transcript (GET /threads/:id). No LLM judge: every check is a lookup in the tool rows
 * or the agent's text.
 */

export interface Expectations {
  expected_skills?: string[];
  required_tools?: string[];
  forbidden_tools?: string[];
  expected_tool_arguments?: Record<string, Record<string, unknown>>;
  expected_end_chat?: { reason: string; resolved: boolean };
  expected_facts_in_final_response?: string[];
  notes?: string;
}

export interface ToolRow {
  role: 'tool';
  tool_name: string;
  call_id: string;
  arguments: unknown;
  output: unknown;
  is_error: boolean;
}

export interface Transcript {
  thread_id: string;
  messages: Array<{ role: 'user' | 'assistant'; text: string } | ToolRow>;
}

/** docs/skills.json, as far as the checks need it. */
export type SkillCatalog = Array<{ name: string; depends_on: string[]; tools: Array<{ function: { name: string } }> }>;

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/** Always callable: they are the agent's primary tools, not a skill's. */
const PRIMARY_TOOLS = new Set(['load_skill', 'end_chat']);

export function evaluate(expect: Expectations, transcript: Transcript, catalog: SkillCatalog): Check[] {
  const calls = transcript.messages.filter((m): m is ToolRow => m.role === 'tool');
  const succeeded = calls.filter((c) => !c.is_error);
  const loads = succeeded.filter((c) => c.tool_name === 'load_skill' && record(c.output).success === true).map((c) => String(record(c.arguments).skill_name));
  const checks: Check[] = [];

  // Skills, dependencies included: the ones the agent asked for, plus what they depend on.
  const loaded = new Set<string>();
  for (const name of loads) addWithDependencies(loaded, name, catalog);
  if (expect.expected_skills) {
    const missing = expect.expected_skills.filter((s) => !loaded.has(s));
    const extra = [...loaded].filter((s) => !expect.expected_skills!.includes(s));
    checks.push({
      name: 'skills loaded',
      pass: missing.length === 0 && extra.length === 0,
      detail: `loaded [${[...loaded].join(', ')}]` + (missing.length ? `; missing [${missing.join(', ')}]` : '') + (extra.length ? `; unexpected [${extra.join(', ')}]` : ''),
    });
  }

  // Only the last loaded skill is applied (src/skills.ts): switching back to a skill means loading it
  // again, but loading the skill that is already applied is wasted.
  const redundant = loads.filter((s, i) => i > 0 && loads[i - 1] === s);
  checks.push({ name: 'no redundant reload', pass: redundant.length === 0, detail: `load order [${loads.join(' → ')}]` + (redundant.length ? `; reloaded while applied [${redundant.join(', ')}]` : '') });

  // A skill's tool may only be called while that skill (or one depending on it) is the applied one.
  const toolSkill = new Map(catalog.flatMap((s) => s.tools.map((t) => [t.function.name, s.name] as const)));
  let applied = new Set<string>();
  const outOfSkill: string[] = [];
  for (const call of calls) {
    if (call.tool_name === 'load_skill') {
      if (record(call.output).success === true) {
        applied = new Set();
        addWithDependencies(applied, String(record(call.arguments).skill_name), catalog);
      }
    } else if (!PRIMARY_TOOLS.has(call.tool_name) && !applied.has(toolSkill.get(call.tool_name) ?? '')) {
      outOfSkill.push(call.tool_name);
    }
  }
  checks.push({ name: 'tools only from applied skill', pass: outOfSkill.length === 0, detail: outOfSkill.length ? `called outside its skill: [${outOfSkill.join(', ')}]` : 'ok' });

  if (expect.required_tools) {
    // A tool listed twice must be called twice (A → B → A scenarios).
    const missing: string[] = [];
    const want = countBy(expect.required_tools);
    const got = countBy(succeeded.map((c) => c.tool_name));
    for (const [tool, n] of want) if ((got.get(tool) ?? 0) < n) missing.push(n > 1 ? `${tool} ×${n} (got ${got.get(tool) ?? 0})` : tool);
    checks.push({ name: 'required tools called', pass: missing.length === 0, detail: missing.length ? `missing [${missing.join(', ')}]` : 'ok' });
  }

  if (expect.forbidden_tools) {
    const used = [...new Set(calls.map((c) => c.tool_name).filter((t) => expect.forbidden_tools!.includes(t)))];
    checks.push({ name: 'no forbidden tools', pass: used.length === 0, detail: used.length ? `called [${used.join(', ')}]` : 'ok' });
  }

  for (const [tool, want] of Object.entries(expect.expected_tool_arguments ?? {})) {
    const tried = succeeded.filter((c) => c.tool_name === tool);
    const pass = tried.some((c) => Object.entries(want).every(([key, value]) => sameValue(value, record(c.arguments)[key])));
    checks.push({
      name: `${tool} arguments`,
      pass,
      detail: pass ? 'ok' : tried.length ? `expected ${JSON.stringify(want)}, got ${tried.map((c) => JSON.stringify(c.arguments)).join(' | ')}` : 'never called',
    });
  }

  if (expect.expected_end_chat) {
    const end = calls.filter((c) => c.tool_name === 'end_chat').at(-1);
    const args = end ? record(end.arguments) : {};
    const pass = !!end && args.reason === expect.expected_end_chat.reason && args.resolved === expect.expected_end_chat.resolved;
    checks.push({
      name: 'end_chat',
      pass,
      detail: end ? `reason=${String(args.reason)} resolved=${String(args.resolved)}${end.is_error ? ' (tool errored)' : ''}` : 'end_chat never called',
    });
  }

  if (expect.expected_facts_in_final_response) {
    // Facts can be told across several replies (e.g. a rebooking reference, then a seat confirmation).
    const said = transcript.messages.flatMap((m) => (m.role === 'assistant' ? [m.text.toLowerCase()] : [])).join('\n');
    const missing = expect.expected_facts_in_final_response.filter((f) => !said.includes(f.toLowerCase()));
    checks.push({ name: 'facts told to customer', pass: missing.length === 0, detail: missing.length ? `never said [${missing.join(', ')}]` : 'ok' });
  }

  return checks;
}

function addWithDependencies(skills: Set<string>, name: string, catalog: SkillCatalog): void {
  if (skills.has(name)) return;
  skills.add(name);
  for (const dep of catalog.find((s) => s.name === name)?.depends_on ?? []) addWithDependencies(skills, dep, catalog);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function countBy(items: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

/** Strings match case-insensitively; lists of plain values match in any order. */
function sameValue(want: unknown, got: unknown): boolean {
  if (typeof want === 'string' && typeof got === 'string') return want.trim().toLowerCase() === got.trim().toLowerCase();
  if (Array.isArray(want) && Array.isArray(got)) {
    if (want.length !== got.length) return false;
    const key = (v: unknown) => JSON.stringify(typeof v === 'string' ? v.toLowerCase() : v);
    return [...want].map(key).sort().join() === [...got].map(key).sort().join();
  }
  return JSON.stringify(want) === JSON.stringify(got);
}
