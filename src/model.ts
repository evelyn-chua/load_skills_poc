import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

/**
 * The chat model: OpenAI, called on the Chat Completions API (`/v1/chat/completions`), with the
 * same OPENAI_API_KEY Studio's post-call steps use. Throws on boot when the environment is missing a value.
 */
export function createChatModel(): LanguageModel {
  const openai = createOpenAI({ apiKey: requireEnv('OPENAI_API_KEY') });
  return openai.chat(requireEnv('OPENAI_MODEL'));
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
