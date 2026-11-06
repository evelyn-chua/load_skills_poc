import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;

/** What one model call answers: some text, some tool calls, or an error. */
export interface ScriptedStep {
  text?: string;
  toolCalls?: Array<{ toolName: string; input: Record<string, unknown> }>;
  error?: Error;
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/**
 * A model that answers its calls with the scripted steps, in order. A step given as a function is
 * awaited first, so a test can hold a call open until it decides the turn should go on.
 */
export function scriptedModel(steps: Array<ScriptedStep | (() => Promise<ScriptedStep>)>): MockLanguageModelV4 {
  let calls = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const next = steps[calls++];
      if (!next) throw new Error(`unexpected model call #${calls}`);
      const step = typeof next === 'function' ? await next() : next;
      if (step.error) throw step.error;
      return { stream: convertArrayToReadableStream(streamParts(step, calls)) };
    },
  });
}

function streamParts(step: ScriptedStep, call: number): StreamPart[] {
  const toolCalls = step.toolCalls ?? [];
  return [
    { type: 'stream-start', warnings: [] },
    ...(step.text
      ? ([
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: step.text },
          { type: 'text-end', id: 't' },
        ] satisfies StreamPart[])
      : []),
    ...toolCalls.map((c, i): StreamPart => ({ type: 'tool-call', toolCallId: `call_${call}_${i}`, toolName: c.toolName, input: JSON.stringify(c.input) })),
    { type: 'finish', finishReason: { unified: toolCalls.length ? 'tool-calls' : 'stop', raw: undefined }, usage },
  ];
}

/** What model call `i` was shown, one line per message part: "user: hi", "tool-result: lookup_order", … */
export function seenBy(model: MockLanguageModelV4, i: number): string[] {
  const prompt = model.doStreamCalls[i]?.prompt ?? [];
  return prompt.flatMap((message) => {
    if (message.role === 'system') return [`system: ${message.content}`];
    return message.content.map((part) => {
      if (part.type === 'text') return `${message.role}: ${part.text}`;
      if (part.type === 'tool-call') return `tool-call: ${part.toolName} ${JSON.stringify(part.input)}`;
      if (part.type === 'tool-result') return `tool-result: ${part.toolName} ${JSON.stringify(part.output)}`;
      return `${message.role}: <${part.type}>`;
    });
  });
}

/** The tools model call `i` was offered, by name. */
export function toolsOfferedTo(model: MockLanguageModelV4, i: number): string[] {
  return (model.doStreamCalls[i]?.tools ?? []).map((t) => t.name);
}

/** The system prompt model call `i` was given. */
export function systemPromptOf(model: MockLanguageModelV4, i: number): string {
  const system = model.doStreamCalls[i]?.prompt.find((message) => message.role === 'system');
  return system?.role === 'system' ? system.content : '';
}

/** A promise a test resolves when it chooses. */
export function gate<T = void>() {
  return Promise.withResolvers<T>();
}
