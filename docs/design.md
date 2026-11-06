# Chat Agent POC — Design

**Status:** POC · 2026-11-06 · Evelyn Chua · context: ENG-684 (intent triage / complex agents)

## Goal

One agent that loads **skills** (procedures) as the conversation needs them. A skill is a set of
instructions plus the tools for one job. The agent starts with a base prompt and two common tools,
`load_skill` and `end_chat`.

When the agent loads a skill, the very next model call gets that skill's instructions and tools
**instead of** the previous skill's. The base prompt and the common tools always stay.

Underneath sits a minimal chat server, extracted from Voice Agent Studio's chat agent. It stores the
thread, runs tools on the server, calls Baseten on its OpenAI-compatible Chat Completions API, and
traces every turn to Phoenix.

## Config

The agent is defined entirely in `config/`, whose files are kept whole and unchanged:

| File | What it holds |
|---|---|
| `config/system_prompt.md` | The base prompt: persona, how skills work, the skill catalog, non-negotiables, tone. `{{current_date}}` is filled per step; `{{channel}}` is always "web chat". |
| `config/primary_tools.json` | The common tools, `load_skill` and `end_chat`: OpenAI function schemas, usage `instructions`, and example responses. |
| `config/skills.json` | Every skill: name, description, `depends_on`, `instructions`, and its tools (OpenAI function schemas with example responses). |

Skill tools are **mocks**: each returns its example `response` from `skills.json`. `load_skill` and
`end_chat` are implemented by the server.

## How a skill is applied

There is no stored "active skill". The history is the record: the active skill is the one named in
the latest successful `load_skill` result (`latestLoadedSkill`). The AI SDK's `prepareStep` runs
before every model call, reads it, and sets that call's system prompt and tools.

```
step N     model calls load_skill({ skill_name: "cancel_booking" })
           load_skill returns { success, already_loaded, dependencies_loaded: ["verify_identity"],
                                tools_added: [...], instructions: {...} }   ← the shape primary_tools.json gives
           (it changes nothing; the result goes into the history like any tool result)
step N+1   prepareStep: latestLoadedSkill(messages) → "cancel_booking"
             system prompt = base prompt
                           + "## Tool instructions"   (load_skill, end_chat)
                           + "## Active skill: cancel_booking"   (verify_identity, then cancel_booking)
             tools offered = load_skill, end_chat, get_booking, get_cancellation_quote, cancel_segments
```

- **Replace, not append.** Loading `seat_selection` after `cancel_booking` takes out
  `cancel_booking`'s instructions and tools. Shared dependencies stay: `get_booking` comes back with
  `seat_selection`, because both depend on `verify_identity`.
- **Takes effect on the next step, in the same turn.** All tools are registered once;
  `activeTools` picks which are offered.
- **Persists across turns** because the history does: the next message starts with the skill the
  history last loaded.
- **Cost.** Reading the history is an in-memory scan before each model call, so it adds no latency
  you'd notice. A switch changes the system prompt and tools, so that one call can't reuse the
  provider's prompt cache.
- **`end_chat` ends the turn** (the agent says its goodbye first, in the same step) and closes the
  thread. Later messages get `409`.

For ENG-684's switching strategies, the prompt for a step is a function of the `load_skill` results
in the history, so each strategy is one small function:

- **replace** (built): use the latest result
- **append:** use every result
- **summary:** the latest in full, earlier ones as their one-line `description`

## Model

`zai-org/GLM-5.3-Flash` on Baseten (Studio's default chat model), with `reasoning_effort: "low"` sent
in every request body, as Studio sends it.

- The model's reasoning text is not read; only its answer is.
- Configured by `BASETEN_API_KEY`, `BASETEN_MODEL` and `BASETEN_REASONING_EFFORT`.

## Tracing

Every turn is traced to Phoenix (Arize) over OTLP/HTTP, as Studio's chat is
(`lib/chat-tracing/`). The AI SDK's spans are turned into OpenInference spans by Arize's processor.

- **Configuration:** `OTLP_ENDPOINT`, `OTLP_AUTH_HEADER` and `OTLP_API_KEY` (Studio's variable
  names). The project is `load-skills-poc`, or `PHOENIX_PROJECT_NAME`.
- **Off by default:** tracing is off when the endpoint or key is unset.
- **What a trace contains:** one trace per turn: `invoke_agent chat-turn` → `step n` → the LLM call
  and each tool call.
- **Sessions:** every span carries `session.id`, the thread id, so Phoenix groups a conversation's
  turns into one session.
- **Content is recorded:** prompts, messages, and tool arguments and results.
- **Shutdown:** buffered spans are sent before the server exits (`SIGINT`/`SIGTERM`).

## Modules

```
config/        the agent: base prompt, common tools, skills (unchanged copies of the source files)
src/
  main.ts      boots the server: config + model + tracing → createApp → serve, plus the chat page at /
  app.ts       HTTP routes (Hono)
  config.ts    reads config/ and checks it: unique tool names, known dependencies
  skills.ts    the skill mechanism: latestLoadedSkill, loadSkill (load_skill's result), current
               (prompt + tools for a step), the tool set
  threads.ts   in-memory threads, and one turn per thread at a time
  agent.ts     one turn: streamText tool loop, re-prepared before every step  ← Studio's core.ts
  model.ts     the Baseten model (OpenAI-compatible Chat Completions)
  tracing.ts   Phoenix tracing                                                ← Studio's lib/chat-tracing/
public/
  index.html   the chat page, with the applied skill, tools offered and system prompt shown live
tests/         Vitest with the AI SDK's mock model: the real loop runs, no network
```

## API

```
POST /threads                                       → 201 { thread_id }
POST /threads/:id/messages   { text }  → 200 { replies: string[], ended }
                                         200 { replies: [], answered_with_later_message: true }
POST /threads/:id/messages?stream=true → AI SDK UI message stream (SSE)
GET  /threads/:id            → { thread_id, active_skill, active_tools, ended,
                                 system_prompt, messages }
```

Errors:

- `400`: a bad body.
- `404`: an unknown thread.
- `409`: the chat has ended.
- `500`: the model call failed. The customer's message stays stored, and the next turn sees it.

## Kept from Studio's chat agent

- **One reply per step.**
- **Each step is stored as it ends.**
- **Tool results are replayed as tool-call/result pairs.**
- **A tool that throws is reported to the model as an error.**
- **A model call that fails after a step fails the turn.**
- **One turn per thread.** Messages sent while the agent is answering are answered together, on the
  newest one's request. A waiting message is held aside until a turn reads it, so the model always
  sees the earlier exchange first.

## Open points

1. **The config still describes "append".** `system_prompt.md` says "Skills you've already loaded
   stay loaded, so don't load them again", and `load_skill`'s description says "Loading an
   already-loaded skill does nothing". Under replace, a skill that was swapped out is no longer
   loaded, so the agent has to load it again. The files are left unchanged; reword those two lines
   if replace is the strategy kept.
2. **Old instructions stay in the history.** `load_skill`'s result carries the skill's
   instructions, as `primary_tools.json` specifies. After a switch, the earlier skill's instructions
   are no longer in the system prompt, but they are still in the chat history as that earlier tool
   result. To evaluate a clean "replace", drop `instructions` from the result: the system prompt
   already carries them.
