/**
 * The simulated customer: an LLM role-playing one scenario's persona, on any OpenAI-compatible
 * Chat Completions endpoint (Baseten, Ollama, vLLM, …). It knows only the scenario's private facts
 * and goals, never the agent's tools or the expected outcome.
 */

export interface Scenario {
  test_id: string;
  category: string;
  max_turns?: number;
  persona: { name: string; style: string };
  private_facts: Record<string, unknown>;
  goals: string[];
  end_condition: string;
  confirmation_policy: Record<string, boolean>;
  evaluation: import('./evaluate').Expectations;
}

export interface ChatLine {
  role: 'customer' | 'agent';
  text: string;
}

export interface CustomerLlm {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}

/** The customer writes this when they are done; whatever precedes it is still sent to the agent. */
const END = '[END]';

export function personaPrompt(scenario: Scenario): string {
  const facts = Object.entries(scenario.private_facts).map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`);
  const policy = Object.entries(scenario.confirmation_policy).map(([key, allowed]) => {
    const action = key.replace(/^allow_/, '').replaceAll('_', ' ');
    return allowed ? `- You MAY agree to: ${action}.` : `- You must NOT agree to: ${action}. Politely decline if it is offered.`;
  });
  return `You are role-playing a CUSTOMER chatting with the virtual support agent of Meridian Air, an airline. You are the customer, never the agent.

## Who you are
Name: ${scenario.persona.name}
Style: ${scenario.persona.style}

## What you know
Share a detail only when the agent asks for it or a goal says to. If the agent asks for something not listed here, say you don't have it to hand. Never invent booking details.
${facts.join('\n')}

## Your goals, in order
${scenario.goals.map((goal, i) => `${i + 1}. ${goal}`).join('\n')}
Work through the goals one at a time. Don't bring up a later goal before the earlier ones are done, unless a goal tells you to.

## What you may agree to
${policy.join('\n')}
Only say "yes" to a charge or an irreversible change once the agent has clearly stated what will happen and what it costs.

## When to stop
${scenario.end_condition}
When that has happened, write your last message (for example a thank-you and goodbye) and put ${END} at the very end of it.
Also end with ${END} if the agent says the chat is closed, or if it is clearly stuck: it has failed at the same thing three times.

## How to write
- Write like a real person typing in a chat window: one or two short sentences, plain text, no markdown, no lists.
- Write only your next message as the customer. No narration, no "Customer:" prefix, never speak for the agent.
- React to what the agent actually said. If it asks a question, answer it.`;
}

/** The customer's next message, given the chat so far (empty: the customer opens the chat). */
export async function nextCustomerMessage(llm: CustomerLlm, persona: string, chat: ChatLine[]): Promise<{ text: string; ended: boolean }> {
  // From the customer model's side the roles flip: its own lines are `assistant`, the agent's are `user`.
  const messages = [
    { role: 'system', content: persona },
    { role: 'user', content: '(The chat window has opened. Type your first message to the support agent.)' },
    ...chat.map((line) => ({ role: line.role === 'customer' ? 'assistant' : 'user', content: line.text })),
  ];
  for (let attempt = 1; ; attempt++) {
    const raw = await complete(llm, messages);
    const text = raw
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/^\s*customer\s*:\s*/i, '')
      .trim();
    const ended = text.includes(END);
    const message = text.replaceAll(END, '').trim();
    if (message || ended || attempt === 2) return { text: message, ended };
  }
}

async function complete(llm: CustomerLlm, messages: Array<{ role: string; content: string }>): Promise<string> {
  const res = await fetch(`${llm.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(llm.apiKey ? { authorization: `Bearer ${llm.apiKey}` } : {}) },
    body: JSON.stringify({ model: llm.model, messages, temperature: llm.temperature }),
  });
  if (!res.ok) throw new Error(`customer LLM: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  return body.choices?.[0]?.message?.content ?? '';
}
