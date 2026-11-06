import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { gate, scriptedModel, seenBy, type ScriptedStep } from './mock-model';

function setup(steps: Parameters<typeof scriptedModel>[0]) {
  const model = scriptedModel(steps);
  const app = createApp({ model, tools: {} });
  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const startThread = async () => {
    const res = await post('/threads', { system_prompt: 'You are a support agent.' });
    return ((await res.json()) as { thread_id: string }).thread_id;
  };
  const transcript = async (threadId: string) => (await (await app.request(`/threads/${threadId}`)).json()) as { messages: Array<{ role: string; text?: string }> };
  return { model, app, post, startThread, transcript };
}

describe('the chat API', () => {
  it('holds a conversation: each message is answered with the thread so far', async () => {
    const { model, post, startThread, transcript } = setup([{ text: 'Hi! How can I help?' }, { text: 'Sure, which order?' }]);
    const threadId = await startThread();

    const first = await post(`/threads/${threadId}/messages`, { text: 'hi' });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ replies: ['Hi! How can I help?'] });

    const second = await post(`/threads/${threadId}/messages`, { text: 'I need help with an order' });
    expect(await second.json()).toEqual({ replies: ['Sure, which order?'] });
    expect(seenBy(model, 1)).toEqual([
      'system: You are a support agent.',
      'user: hi',
      'assistant: Hi! How can I help?',
      'user: I need help with an order',
    ]);

    expect((await transcript(threadId)).messages).toEqual([
      { role: 'user', seq: 1, text: 'hi' },
      { role: 'assistant', text: 'Hi! How can I help?' },
      { role: 'user', seq: 2, text: 'I need help with an order' },
      { role: 'assistant', text: 'Sure, which order?' },
    ]);
  });

  it('answers messages sent while the agent is busy together, in one reply on the newest one’s request', async () => {
    const firstTurn = gate<ScriptedStep>();
    const { model, post, startThread, transcript } = setup([() => firstTurn.promise, { text: 'Cancelled orders 1234 and 5678.' }]);
    const threadId = await startThread();

    const hi = post(`/threads/${threadId}/messages`, { text: 'hi' });
    await vi.waitFor(() => expect(model.doStreamCalls).toHaveLength(1));
    const cancel = post(`/threads/${threadId}/messages`, { text: 'cancel order 1234' });
    const andThat = post(`/threads/${threadId}/messages`, { text: 'and 5678 too' });
    await vi.waitFor(async () => expect((await transcript(threadId)).messages).toHaveLength(3));
    firstTurn.resolve({ text: 'Hi! How can I help?' });

    expect(await (await hi).json()).toEqual({ replies: ['Hi! How can I help?'] });
    expect(await (await andThat).json()).toEqual({ replies: ['Cancelled orders 1234 and 5678.'] });
    expect(await (await cancel).json()).toEqual({ replies: [], answered_with_later_message: true });
    expect(model.doStreamCalls).toHaveLength(2);
    expect(seenBy(model, 1).slice(-3)).toEqual(['assistant: Hi! How can I help?', 'user: cancel order 1234', 'user: and 5678 too']);
  });

  it('reports a failed combined turn on every request it covered, and the next message still gets an answer', async () => {
    const firstTurn = gate<ScriptedStep>();
    const { post, startThread } = setup([() => firstTurn.promise, { error: new Error('Azure 503') }, { text: 'Back now. Order 1234 is cancelled.' }]);
    const threadId = await startThread();

    const hi = post(`/threads/${threadId}/messages`, { text: 'hi' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cancel = post(`/threads/${threadId}/messages`, { text: 'cancel order 1234' });
    const andThat = post(`/threads/${threadId}/messages`, { text: 'and 5678 too' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    firstTurn.resolve({ text: 'Hi!' });

    expect((await hi).status).toBe(200);
    expect((await andThat).status).toBe(500);
    expect((await cancel).status).toBe(500);
    expect(await (await post(`/threads/${threadId}/messages`, { text: 'hello?' })).json()).toEqual({ replies: ['Back now. Order 1234 is cancelled.'] });
  });

  it('streams the reply with ?stream=true, and stores it once the turn ends', async () => {
    const { post, startThread, transcript } = setup([{ text: 'Hi! How can I help?' }]);
    const threadId = await startThread();

    const res = await post(`/threads/${threadId}/messages?stream=true`, { text: 'hi' });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toContain('"delta":"Hi! How can I help?"');
    await vi.waitFor(async () => expect((await transcript(threadId)).messages.at(-1)).toEqual({ role: 'assistant', text: 'Hi! How can I help?' }));
  });

  it('rejects a bad request and an unknown thread', async () => {
    const { app, post, startThread } = setup([]);
    expect((await post('/threads', {})).status).toBe(400);
    expect((await post(`/threads/${await startThread()}/messages`, { text: '' })).status).toBe(400);
    expect((await post('/threads/nope/messages', { text: 'hi' })).status).toBe(404);
    expect((await app.request('/threads/nope')).status).toBe(404);
  });
});
