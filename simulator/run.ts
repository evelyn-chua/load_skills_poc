import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { nextCustomerMessage, personaPrompt, type ChatLine, type CustomerLlm, type Scenario } from './customer';
import { evaluate, type Check, type SkillCatalog, type Transcript } from './evaluate';
import { summaryCsv } from './to-csv';

/**
 * Runs the test scenarios against the chat agent's HTTP API, with an LLM playing the customer:
 *
 *   pnpm simulate                       # every scenario
 *   pnpm simulate --only TC01,TC09      # some of them (test id prefixes)
 *   pnpm simulate --concurrency 3
 *
 * Each scenario gets its own thread, with the agent in config/. The customer speaks first; the chat ends when the agent calls
 * end_chat, the customer writes [END], or the customer has sent `max_turns` messages. Every
 * transcript and its checks are written to results/<run>/, with summary.json and summary.csv.
 */
const { values: args } = parseArgs({
  options: {
    scenarios: { type: 'string', default: 'scenarios/all_scenarios.json' },
    skills: { type: 'string', default: 'config/skills.json' },
    only: { type: 'string' },
    concurrency: { type: 'string', default: '1' },
    out: { type: 'string', default: 'results' },
  },
});

const AGENT_URL = (process.env.AGENT_URL ?? `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

const suite = JSON.parse(await readFile(args.scenarios, 'utf8')) as { suite_name: string; default_max_turns: number; default_simulator_temperature?: number; scenarios: Scenario[] };
const catalog = JSON.parse(await readFile(args.skills, 'utf8')) as SkillCatalog;

const llm: CustomerLlm = {
  baseUrl: process.env.SIM_BASE_URL ?? 'https://inference.baseten.co/v1',
  apiKey: process.env.SIM_API_KEY ?? process.env.BASETEN_API_KEY ?? '',
  model: process.env.SIM_MODEL ?? 'openai/gpt-oss-120b',
  temperature: Number(process.env.SIM_TEMPERATURE ?? suite.default_simulator_temperature ?? 0.5),
};

const wanted = args.only?.split(',').map((id) => id.trim()).filter(Boolean);
const scenarios = suite.scenarios.filter((s) => !wanted || wanted.some((id) => s.test_id.startsWith(id)));
if (!scenarios.length) throw new Error(`no scenario matches --only ${args.only}`);

const runDir = path.join(args.out, new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(runDir, { recursive: true });
console.log(`${scenarios.length} scenario(s) · agent ${AGENT_URL} · customer ${llm.model} @ ${llm.baseUrl} · results in ${runDir}\n`);

interface Result {
  test_id: string;
  category: string;
  thread_id: string;
  ended_by: 'agent_end_chat' | 'customer' | 'max_turns' | 'error';
  error?: string;
  customer_turns: number;
  checks: Check[];
  chat: ChatLine[];
  transcript: Transcript | null;
}

async function runScenario(scenario: Scenario): Promise<Result> {
  const log = (line: string) => console.log(`[${scenario.test_id.slice(0, 4)}] ${line}`);
  const maxTurns = scenario.max_turns ?? suite.default_max_turns;
  const persona = personaPrompt(scenario);
  const chat: ChatLine[] = [];
  let transcript: Transcript | null = null;
  let endedBy: Result['ended_by'] = 'max_turns';
  let error: string | undefined;
  let turns = 0;
  const { thread_id } = await api<{ thread_id: string }>('POST', '/threads', {});

  try {
    while (turns < maxTurns) {
      const customer = await nextCustomerMessage(llm, persona, chat);
      if (customer.text) {
        turns += 1;
        chat.push({ role: 'customer', text: customer.text });
        log(`customer: ${customer.text}`);
        const seen = transcript?.messages.length ?? 0;
        const { replies, ended } = await api<{ replies: string[]; ended?: boolean }>('POST', `/threads/${thread_id}/messages`, { text: customer.text });
        transcript = await api<Transcript>('GET', `/threads/${thread_id}`);
        for (const row of transcript.messages.slice(seen)) {
          if (row.role === 'tool') log(`  ⚙ ${row.tool_name}(${JSON.stringify(row.arguments)})${row.is_error ? ` ✗ ${String(row.output)}` : ''}`);
        }
        const reply = replies.join('\n\n') || '(no reply)';
        chat.push({ role: 'agent', text: reply });
        log(`agent: ${reply.replaceAll('\n', '\n         ')}`);
        if (ended || transcript.messages.some((m) => m.role === 'tool' && m.tool_name === 'end_chat')) {
          endedBy = 'agent_end_chat';
          break;
        }
      }
      if (customer.ended) {
        endedBy = 'customer';
        break;
      }
    }
  } catch (e) {
    endedBy = 'error';
    error = e instanceof Error ? e.message : String(e);
    log(`error: ${error}`);
  }

  transcript = await api<Transcript>('GET', `/threads/${thread_id}`).catch(() => transcript);
  const checks = transcript ? evaluate(scenario.evaluation, transcript, catalog) : [];
  const result: Result = { test_id: scenario.test_id, category: scenario.category, thread_id, ended_by: endedBy, error, customer_turns: turns, checks, chat, transcript };
  await writeFile(path.join(runDir, `${scenario.test_id}.json`), JSON.stringify(result, null, 2));
  log(`done: ended by ${endedBy} after ${turns} customer message(s); ${checks.filter((c) => c.pass).length}/${checks.length} checks passed\n`);
  return result;
}

async function api<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const res = await fetch(AGENT_URL + route, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`agent ${method} ${route}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

// A small worker pool: `concurrency` scenarios at a time, results in scenario order.
const results: Result[] = new Array(scenarios.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.max(1, Number(args.concurrency) || 1) }, async () => {
    while (next < scenarios.length) {
      const i = next++;
      results[i] = await runScenario(scenarios[i]!);
    }
  }),
);

console.log('=== Summary ===');
for (const r of results) {
  const failed = r.checks.filter((c) => !c.pass);
  const verdict = r.ended_by === 'error' || failed.length ? 'FAIL' : 'PASS';
  console.log(`${verdict}  ${r.test_id.padEnd(42)} ${r.category.padEnd(18)} ${r.checks.length - failed.length}/${r.checks.length} checks · ended by ${r.ended_by} · ${r.customer_turns} turns`);
  if (r.error) console.log(`        error: ${r.error}`);
  for (const c of failed) console.log(`        ✗ ${c.name}: ${c.detail}`);
}
const summary = results.map(({ chat, transcript, ...rest }) => rest);
await writeFile(path.join(runDir, 'summary.json'), JSON.stringify({ suite: suite.suite_name, agent_url: AGENT_URL, customer_model: llm.model, results: summary }, null, 2));
await writeFile(path.join(runDir, 'summary.csv'), summaryCsv(summary));
