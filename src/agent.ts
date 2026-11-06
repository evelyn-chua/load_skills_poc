import { isStepCount, streamText, type LanguageModel, type ModelMessage, type StepResult, type ToolSet } from 'ai';
import type { AgentMessage, StoredMessage } from './threads';

/** Without a step budget the AI SDK runs one step, so the agent would never reply after a tool. */
const MAX_STEPS = 10;

export interface TurnInput {
  model: LanguageModel;
  tools: ToolSet;
  systemPrompt: string;
  history: StoredMessage[];
  /** Stores a reply or a tool row, as each step ends. */
  record: (message: AgentMessage) => void;
}

/**
 * One turn of the conversation, as Studio's chat runs it (lib/agent-chat-channel/core.ts): the
 * model answers the thread, calling tools as it goes, one Chat Completions call per step. Each step
 * that says something is its own reply ("Let me check that" before a tool call, then the answer),
 * and each step is stored as it ends.
 *
 * Returns the stream to pipe to a client, and `done`: the turn's replies once it has run to the
 * end, whether or not anyone reads the stream. `done` rejects with the error that stopped the turn.
 */
export function runTurn(input: TurnInput) {
  const replies: string[] = [];
  let failure: { error: unknown } | undefined;
  const result = streamText({
    model: input.model,
    instructions: input.systemPrompt,
    messages: toModelMessages(input.history),
    tools: input.tools,
    stopWhen: isStepCount(MAX_STEPS),
    onError: ({ error }) => {
      failure ??= { error };
    },
    onStepEnd: (step) => {
      if (step.text.trim()) {
        replies.push(step.text);
        input.record({ role: 'assistant', text: step.text });
      }
      for (const row of toolRows(step)) input.record(row);
    },
  });
  const done = (async () => {
    await result.consumeStream();
    try {
      await result.steps;
    } catch (error) {
      // A first step that fails rejects with a generic "no output"; the stream's own error says why.
      throw failure?.error ?? error;
    }
    // A later step that fails does not reject: the turn would read as answered by "Let me check".
    if (failure) throw failure.error;
    return replies;
  })();
  return { result, done };
}

/** One row per tool call in a step. A tool that threw keeps its message: an Error serializes to `{}`. */
function toolRows(step: StepResult<ToolSet>): AgentMessage[] {
  const rows = new Map<string, Extract<AgentMessage, { role: 'tool' }>>();
  for (const part of step.content) {
    if (part.type === 'tool-call') {
      rows.set(part.toolCallId, { role: 'tool', toolName: part.toolName, callId: part.toolCallId, input: part.input, output: null, isError: false });
    } else if (part.type === 'tool-result' || part.type === 'tool-error') {
      const isError = part.type === 'tool-error';
      const output = isError ? (part.error instanceof Error ? part.error.message : String(part.error)) : part.output;
      rows.set(part.toolCallId, { role: 'tool', toolName: part.toolName, callId: part.toolCallId, input: part.input, output, isError });
    }
  }
  return [...rows.values()];
}

/**
 * The thread as the model is shown it. A tool row becomes the two messages a live tool call
 * produces (an assistant `tool-call`, then its `tool-result`), never text: a model shown a tool's
 * JSON as its own words imitates it.
 */
function toModelMessages(history: StoredMessage[]): ModelMessage[] {
  return history.flatMap((message): ModelMessage[] => {
    if (message.role !== 'tool') return [{ role: message.role, content: message.text }];
    // Arguments that are not an object (an invalid call's raw text) are replayed as {}, which every provider accepts.
    const input = typeof message.input === 'object' && message.input !== null && !Array.isArray(message.input) ? message.input : {};
    const output = message.isError
      ? { type: 'error-text' as const, value: String(message.output) }
      : { type: 'json' as const, value: (message.output ?? null) as never };
    return [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: message.callId, toolName: message.toolName, input }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: message.callId, toolName: message.toolName, output }] },
    ];
  });
}
