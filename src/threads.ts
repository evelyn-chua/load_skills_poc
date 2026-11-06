import { randomUUID } from 'node:crypto';
import type { ThreadState } from './skills';

export type UserMessage = { role: 'user'; seq: number; text: string };
export type StoredMessage =
  | UserMessage
  | { role: 'assistant'; text: string }
  | { role: 'tool'; toolName: string; callId: string; input: unknown; output: unknown; isError: boolean };

/** What a turn writes to its thread: a reply, or one tool execution. */
export type AgentMessage = Exclude<StoredMessage, { role: 'user' }>;

export interface Thread extends ThreadState {
  id: string;
  /** The conversation in the order the model sees it. */
  messages: StoredMessage[];
  /**
   * Customer messages no turn has read yet. A message that arrives while a turn is running is
   * written before that turn's reply, but the model must see the earlier exchange first and then
   * the message, or it reads the message as already answered. So it waits here, and the turn that
   * reads it moves it onto the end of `messages`.
   */
  waiting: UserMessage[];
  /** Customer messages stored so far: each takes the next number as its `seq`. */
  userSeq: number;
  /** The newest customer message a turn has read. */
  seenThroughSeq: number;
  /** The newest customer message a finished turn answered. */
  answeredThroughSeq: number;
  /** A turn is running on the thread. */
  busy: boolean;
  /** Requests waiting for the thread to change. */
  waiters: Array<() => void>;
}

/** In memory: every thread is gone when the server restarts. */
const threads = new Map<string, Thread>();

export function createThread(): { id: string } {
  const thread: Thread = {
    id: randomUUID(),
    endedAt: null,
    messages: [],
    waiting: [],
    userSeq: 0,
    seenThroughSeq: 0,
    answeredThroughSeq: 0,
    busy: false,
    waiters: [],
  };
  threads.set(thread.id, thread);
  return { id: thread.id };
}

export function getThread(threadId: string): Thread | undefined {
  return threads.get(threadId);
}

/** Stores a customer message and returns its `seq`. */
export function addUserMessage(thread: Thread, text: string): number {
  thread.userSeq += 1;
  thread.waiting.push({ role: 'user', seq: thread.userSeq, text });
  notify(thread);
  return thread.userSeq;
}

/** A turn this request holds the thread for. `end` must be called once it is over, answered or not. */
export interface HeldTurn {
  /** The thread as it stands: it ends at every customer message waiting for an answer. */
  history: StoredMessage[];
  record: (message: AgentMessage) => void;
  end: (answered: boolean) => void;
}

export type TurnSlot =
  | { kind: 'run'; turn: HeldTurn }
  | { kind: 'answered_with_later_message' }
  | { kind: 'failed' };

/**
 * One turn per thread at a time, as in Studio's web chat. Called right after the request stored
 * customer message `seq`:
 *  - `run`: the thread is free and `seq` is the newest message. This request runs one turn that
 *    answers every waiting message together.
 *  - `answered_with_later_message`: a turn run by a later message's request answered it.
 *  - `failed`: the turn that read it ended without answering it.
 * Messages that arrive while a turn runs wait, and the newest of them runs the next turn.
 */
export async function waitForTurn(thread: Thread, seq: number): Promise<TurnSlot> {
  for (;;) {
    if (thread.answeredThroughSeq >= seq) return { kind: 'answered_with_later_message' };
    if (!thread.busy && thread.seenThroughSeq >= seq) return { kind: 'failed' };
    if (!thread.busy && thread.userSeq === seq) return { kind: 'run', turn: beginTurn(thread) };
    await new Promise<void>((resolve) => thread.waiters.push(resolve));
  }
}

function beginTurn(thread: Thread): HeldTurn {
  thread.busy = true;
  thread.messages.push(...thread.waiting.splice(0));
  const seenThroughSeq = thread.userSeq;
  thread.seenThroughSeq = seenThroughSeq;
  return {
    history: [...thread.messages],
    record: (message) => thread.messages.push(message),
    end: (answered) => {
      if (answered) thread.answeredThroughSeq = seenThroughSeq;
      thread.busy = false;
      notify(thread);
    },
  };
}

function notify(thread: Thread): void {
  for (const wake of thread.waiters.splice(0)) wake();
}
