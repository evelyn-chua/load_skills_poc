import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

const BASETEN_BASE_URL = 'https://inference.baseten.co/v1';

/**
 * The chat model: a Baseten model on its OpenAI-compatible Chat Completions endpoint, as Studio's
 * chat calls it (getBasetenChatModel). BASETEN_REASONING_EFFORT, when set, goes in every request
 * body as `reasoning_effort`, the way Baseten reads it (Studio runs zai-org/GLM-5.3-Flash at
 * "low"). Only the answer is read; the model's reasoning text is not. Throws on boot when the
 * environment is missing a value.
 */
export function createChatModel(): LanguageModel {
  const reasoningEffort = process.env.BASETEN_REASONING_EFFORT?.trim();
  const baseten = createOpenAI({
    name: 'baseten',
    baseURL: BASETEN_BASE_URL,
    apiKey: requireEnv('BASETEN_API_KEY'),
    ...(reasoningEffort ? { fetch: withBody({ reasoning_effort: reasoningEffort }) } : {}),
  });
  return baseten.chat(requireEnv('BASETEN_MODEL'));
}

/** `fetch` with `extra` merged into every JSON request body. */
function withBody(extra: Record<string, unknown>): typeof fetch {
  return (input, init) => {
    if (typeof init?.body === 'string') init = { ...init, body: JSON.stringify({ ...JSON.parse(init.body), ...extra }) };
    return fetch(input, init);
  };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
