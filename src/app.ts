import { Hono } from 'hono';
import type { LanguageModel, ToolSet } from 'ai';
import { z } from 'zod';
import { runTurn } from './agent';
import { addUserMessage, createThread, getThread, waitForTurn, type StoredMessage } from './threads';

const CreateThreadBody = z.object({ system_prompt: z.string().min(1) });
const MessageBody = z.object({ text: z.string().min(1) });

export function createApp({ model, tools }: { model: LanguageModel; tools: ToolSet }): Hono {
  const app = new Hono();

  app.post('/threads', async (c) => {
    const body = CreateThreadBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'system_prompt is required' }, 400);
    return c.json({ thread_id: createThread(body.data.system_prompt).id }, 201);
  });

  /**
   * Sends a customer message and returns the agent's replies, one per step: JSON, or a streamed
   * AI SDK UI message stream with `?stream=true`. A message sent while the agent is still answering
   * waits, and is answered together with every other waiting message on the newest one's request;
   * the older requests get `{ replies: [], answered_with_later_message: true }` as JSON.
   */
  app.post('/threads/:id/messages', async (c) => {
    const thread = getThread(c.req.param('id'));
    if (!thread) return c.json({ error: 'Thread not found' }, 404);
    const body = MessageBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'text is required' }, 400);

    const slot = await waitForTurn(thread, addUserMessage(thread, body.data.text));
    if (slot.kind === 'answered_with_later_message') return c.json({ replies: [], answered_with_later_message: true });
    if (slot.kind === 'failed') return c.json({ error: 'The agent could not answer this message.' }, 500);

    const { turn } = slot;
    const { result, done } = runTurn({ model, tools, systemPrompt: turn.systemPrompt, history: turn.history, record: turn.record });
    const finished = done.then(
      (replies) => {
        turn.end(true);
        return replies;
      },
      (error: unknown) => {
        turn.end(false);
        throw error;
      },
    );
    if (c.req.query('stream') === 'true') {
      finished.catch((error: unknown) => console.error('[chat-agent] streamed turn failed', error));
      return result.toUIMessageStreamResponse();
    }
    return c.json({ replies: await finished });
  });

  /**
   * The whole transcript, in the order the model sees it: customer messages, replies, and every
   * tool call with its arguments and output. Messages no turn has read yet come last.
   */
  app.get('/threads/:id', (c) => {
    const thread = getThread(c.req.param('id'));
    if (!thread) return c.json({ error: 'Thread not found' }, 404);
    return c.json({ thread_id: thread.id, system_prompt: thread.systemPrompt, messages: [...thread.messages, ...thread.waiting].map(toJson) });
  });

  app.onError((error, c) => {
    console.error('[chat-agent] request failed', error);
    return c.json({ error: 'The agent could not answer this message.' }, 500);
  });

  return app;
}

function toJson(message: StoredMessage) {
  if (message.role !== 'tool') return message;
  return { role: 'tool', tool_name: message.toolName, call_id: message.callId, arguments: message.input, output: message.output, is_error: message.isError };
}
