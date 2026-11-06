import { tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runTurn } from '../src/agent';
import type { AgentMessage, StoredMessage } from '../src/threads';
import { scriptedModel, seenBy } from './mock-model';

const lookupOrder = (execute: (args: { order_id: string }) => Promise<unknown>) => ({
  lookup_order: tool({ description: 'Looks up an order.', inputSchema: z.object({ order_id: z.string() }), execute }),
});

function turn(model: ReturnType<typeof scriptedModel>, opts: { tools?: ReturnType<typeof lookupOrder>; history?: StoredMessage[] } = {}) {
  const recorded: AgentMessage[] = [];
  const tools = opts.tools ?? {};
  const { done } = runTurn({
    model,
    tools,
    prepare: () => ({ instructions: 'You are a support agent.', activeTools: Object.keys(tools) }),
    history: opts.history ?? [{ role: 'user', seq: 1, text: 'hi' }],
    record: (message) => recorded.push(message),
  });
  return { done, recorded };
}

describe('runTurn', () => {
  it('answers with the system prompt and the history, as one reply', async () => {
    const model = scriptedModel([{ text: 'Hello! How can I help?' }]);
    const { done, recorded } = turn(model);

    expect(await done).toEqual(['Hello! How can I help?']);
    expect(recorded).toEqual([{ role: 'assistant', text: 'Hello! How can I help?' }]);
    expect(seenBy(model, 0)).toEqual(['system: You are a support agent.', 'user: hi']);
  });

  it('runs a tool on the server and replies after it: two replies, with the tool row between them', async () => {
    const model = scriptedModel([
      { text: 'Let me check that for you.', toolCalls: [{ toolName: 'lookup_order', input: { order_id: '1234' } }] },
      { text: 'Order 1234 has shipped.' },
    ]);
    const { done, recorded } = turn(model, { tools: lookupOrder(async ({ order_id }) => ({ order_id, status: 'shipped' })) });

    expect(await done).toEqual(['Let me check that for you.', 'Order 1234 has shipped.']);
    expect(recorded).toEqual([
      { role: 'assistant', text: 'Let me check that for you.' },
      { role: 'tool', toolName: 'lookup_order', callId: 'call_1_0', input: { order_id: '1234' }, output: { order_id: '1234', status: 'shipped' }, isError: false },
      { role: 'assistant', text: 'Order 1234 has shipped.' },
    ]);
    expect(seenBy(model, 1)).toContain('tool-result: lookup_order {"type":"json","value":{"order_id":"1234","status":"shipped"}}');
  });

  it('tells the model when a tool throws, and records the reason', async () => {
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'lookup_order', input: { order_id: '1234' } }] },
      { text: 'Sorry, I cannot look that up right now.' },
    ]);
    const { done, recorded } = turn(model, {
      tools: lookupOrder(async () => {
        throw new Error('CRM is down');
      }),
    });

    expect(await done).toEqual(['Sorry, I cannot look that up right now.']);
    expect(recorded[0]).toMatchObject({ role: 'tool', output: 'CRM is down', isError: true });
    expect(seenBy(model, 1).at(-1)).toMatch(/^tool-result: lookup_order \{"type":"error-text","value":".*CRM is down"\}$/);
  });

  it('fails the turn when a model call after the first fails, rather than passing "Let me check" off as the answer', async () => {
    const model = scriptedModel([
      { text: 'Let me check that for you.', toolCalls: [{ toolName: 'lookup_order', input: { order_id: '1234' } }] },
      { error: new Error('Azure 503') },
    ]);
    const { done } = turn(model, { tools: lookupOrder(async () => ({ status: 'shipped' })) });

    await expect(done).rejects.toThrow('Azure 503');
  });

  it('fails the turn with the model error when the first call fails', async () => {
    const { done } = turn(scriptedModel([{ error: new Error('Azure 401') }]));

    await expect(done).rejects.toThrow('Azure 401');
  });

  it('replays an earlier tool row as a tool call and its result, never as the agent’s own words', async () => {
    const model = scriptedModel([{ text: 'It is still on its way.' }]);
    const { done } = turn(model, {
      history: [
        { role: 'user', seq: 1, text: 'Where is order 1234?' },
        { role: 'tool', toolName: 'lookup_order', callId: 'c1', input: { order_id: '1234' }, output: { status: 'shipped' }, isError: false },
        { role: 'assistant', text: 'Order 1234 has shipped.' },
        { role: 'user', seq: 2, text: 'Still not here?' },
      ],
    });
    await done;

    expect(seenBy(model, 0)).toEqual([
      'system: You are a support agent.',
      'user: Where is order 1234?',
      'tool-call: lookup_order {"order_id":"1234"}',
      'tool-result: lookup_order {"type":"json","value":{"status":"shipped"}}',
      'assistant: Order 1234 has shipped.',
      'user: Still not here?',
    ]);
  });
});
