import { Hono } from 'hono';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { runTurn, toModelMessages } from './agent';
import type { AgentConfig } from './config';
import { createSkillAgent, END_CHAT, latestLoadedSkill } from './skills';
import type { PhoenixTracing } from './tracing';
import { addUserMessage, createThread, getThread, waitForTurn, type StoredMessage } from './threads';

const MessageBody = z.object({ text: z.string().min(1) });

export function createApp({ model, config, tracing }: { model: LanguageModel; config: AgentConfig; tracing?: PhoenixTracing | null }): Hono {
  const app = new Hono();
  const agent = createSkillAgent(config);

  /** Starts a conversation with the agent in `config/`. */
  app.post('/threads', (c) => c.json({ thread_id: createThread().id }, 201));

  /**
   * Sends a customer message and returns the agent's replies, one per step: JSON, or a streamed
   * AI SDK UI message stream with `?stream=true`. A message sent while the agent is still answering
   * waits, and is answered together with every other waiting message on the newest one's request;
   * the older requests get `{ replies: [], answered_with_later_message: true }` as JSON. Once the
   * agent has called end_chat, the thread takes no more messages (409).
   */
  app.post('/threads/:id/messages', async (c) => {
    const thread = getThread(c.req.param('id'));
    if (!thread) return c.json({ error: 'Thread not found' }, 404);
    if (thread.endedAt) return c.json({ error: 'This chat has ended.' }, 409);
    const body = MessageBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'text is required' }, 400);

    const slot = await waitForTurn(thread, addUserMessage(thread, body.data.text));
    if (slot.kind === 'answered_with_later_message') return c.json({ replies: [], answered_with_later_message: true });
    if (slot.kind === 'failed') return c.json({ error: 'The agent could not answer this message.' }, 500);

    const { turn } = slot;
    const { result, done } = runTurn({
      model,
      tools: agent.tools(thread),
      prepare: (messages) => agent.current(latestLoadedSkill(messages)),
      finalTools: [END_CHAT],
      history: turn.history,
      record: turn.record,
      // Each span names its conversation, so Phoenix groups a thread's turns into one session.
      telemetry: tracing?.telemetry(() => ({ 'gen_ai.conversation.id': thread.id, 'session.id': thread.id })),
    });
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
    const replies = await finished;
    return c.json({ replies, ended: thread.endedAt !== null });
  });

  /**
   * The thread as the agent stands now: the applied skill, the tools and system prompt the model will
   * see on its next step, and the whole transcript in the order the model sees it (customer messages,
   * replies, and every tool call with its arguments and output; messages no turn has read come last).
   */
  app.get('/threads/:id', (c) => {
    const thread = getThread(c.req.param('id'));
    if (!thread) return c.json({ error: 'Thread not found' }, 404);
    const skill = latestLoadedSkill(toModelMessages(thread.messages));
    const { instructions, activeTools } = agent.current(skill);
    return c.json({
      thread_id: thread.id,
      active_skill: skill,
      active_tools: activeTools,
      ended: thread.endedAt !== null,
      system_prompt: instructions,
      messages: [...thread.messages, ...thread.waiting].map(toJson),
    });
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
