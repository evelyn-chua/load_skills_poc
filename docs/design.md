# Chat Agent POC — Design

**Status:** POC · 2026-11-06 · Evelyn Chua

## Goal

Extract the core of Voice Agent Studio's chat agent into a minimal standalone service. A client
creates a thread with a system prompt, then holds a conversation with it over an HTTP API. The
server:

- stores the thread
- runs the agent's tools
- calls the LLM on the Chat Completions API (Baseten, `zai-org/GLM-5.3-Flash`)
- traces every turn to Phoenix (Arize)

Studio sources:

- the turn loop: `lib/agent-chat-channel/core.ts`, `runAgentChatTurn`
- one turn per thread: `thread-turns.ts`; spec `2026-10-28-chat-one-turn-per-thread-design.md`

## Scope

| In | Out (POC) |
|---|---|
| Thread stored on the server (in memory) | A database: threads are lost on restart |
| Server-run tools, one model call per step | `end_chat`, follow-ups, recovery, idle nudges |
| JSON or streamed replies, and a one-page chat UI | A CLI, a production UI |
| Several customer messages answered together | Quiet window, multi-server locking, push delivery |
| `GET /threads/:id` transcript | Other providers, token usage |

## Modules

```
src/
  main.ts      boots the server: model + tools + tracing → createApp → serve, plus the chat page at /
  app.ts       HTTP routes (Hono)
  threads.ts   in-memory threads, and one turn per thread at a time  ← thread-turns.ts
  agent.ts     one turn: streamText tool loop, per-step recording   ← core.ts
  model.ts     the Baseten model (OpenAI-compatible Chat Completions)
  tools.ts     the tools the agent can call: add yours here
  tracing.ts   Phoenix tracing                                     ← Studio's lib/chat-tracing/
public/
  index.html   the chat page: plain HTML + JS, reads the streamed replies; no build step
tests/         Vitest with the AI SDK's mock model: the real loop runs, no network
```

`agent.ts` knows nothing about HTTP or storage. It takes a model, tools, a system prompt and the
history, and reports each message through `record`.

## Model

`zai-org/GLM-5.3-Flash` on Baseten (Studio's default chat model), with `reasoning_effort: "low"` sent
in every request body, as Studio sends it.

- The model's reasoning text is not read; only its answer is.
- Configured by `BASETEN_API_KEY`, `BASETEN_MODEL` and `BASETEN_REASONING_EFFORT`.

## Tracing

Every turn is traced to Phoenix (Arize) over OTLP/HTTP, as Studio's chat is (`lib/chat-tracing/`).
The AI SDK's spans are turned into OpenInference spans by Arize's processor.

- **Configuration:** `OTLP_ENDPOINT`, `OTLP_AUTH_HEADER` and `OTLP_API_KEY` (Studio's variable
  names). The project is `load-skills-poc`, or `PHOENIX_PROJECT_NAME`.
- **Off by default:** tracing is off when the endpoint or key is unset.
- **What a trace contains:** one trace per turn: `invoke_agent chat-turn` → `step n` → the LLM call
  and each tool call.
- **Sessions:** every span carries `session.id`, the thread id, so Phoenix groups a conversation's
  turns into one session.
- **Content is recorded:** prompts, messages, and tool arguments and results.
- **Shutdown:** buffered spans are sent before the server exits (`SIGINT`/`SIGTERM`).

## API

```
POST /threads                { system_prompt }  → 201 { thread_id }
POST /threads/:id/messages   { text }           → 200 { replies: string[] }
                                                  200 { replies: [], answered_with_later_message: true }
POST /threads/:id/messages?stream=true          → AI SDK UI message stream (SSE)
GET  /threads/:id                               → { thread_id, system_prompt, messages }
```

Errors:

- `400`: a missing field.
- `404`: an unknown thread.
- `500`: the model call failed. The customer's message stays stored, and the next turn sees it.

## How a turn works

1. The model is called with the system prompt and the thread so far.
2. If it asks for a tool, the server runs it and calls the model again with the result. This
   repeats for up to 10 steps.
3. Each step that says something is its own reply: "Let me check that" before a tool call, then
   the answer.
4. Each reply and each tool execution is stored as its step ends. Tool rows are shown to the model
   on later turns as tool-call + tool-result pairs, never as text.

## Several messages before the agent answers

The agent answers one thing at a time, as Studio's web chat does:

- A message sent while the agent is free is answered at once.
- Messages sent while it is answering wait. When it finishes, **one turn answers all of them
  together**. The reply goes back on the newest message's request, and the older requests get
  `answered_with_later_message: true`.
- The model sees the earlier exchange, then the waiting messages. A waiting message is held aside
  until a turn reads it, so it never lands before the reply it was waiting behind.
- If that combined turn fails, every request it covered gets a `500`.

## Kept from Studio

- **One reply per step.**
- **Each step is stored as it ends**, not at turn end.
- **Tool results are replayed as tool-call/result pairs.**
- **A tool that throws is reported to the model as an error.** The turn doesn't fail.
- **A model call that fails after a step fails the turn.** The AI SDK would otherwise resolve
  quietly with just "Let me check", so the turn listens for the stream's error.
- **One turn per thread, with waiting messages answered together.**
