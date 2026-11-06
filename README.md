# chat-agent

A POC chat agent extracted from Voice Agent Studio. Create a thread with a system prompt, then hold
a conversation with it over HTTP or the built-in chat page. The server stores the thread, runs the
agent's tools, and calls OpenAI on the Chat Completions API. Design: [`docs/design.md`](docs/design.md).

## Run

```bash
pnpm install
cp .env.example .env    # fill in OPENAI_API_KEY (Studio's .env has one) and OPENAI_MODEL
pnpm dev                # chat page at http://localhost:3000
pnpm test
```

The chat page (`public/index.html`) takes a system prompt, starts a thread, and streams the
agent's replies, one bubble per step, with tool calls as grey lines. You can send several messages
before the agent replies.

## Talk to it

```bash
# start a conversation
curl -s -X POST localhost:3000/threads -H 'content-type: application/json' \
  -d '{"system_prompt":"You are a friendly support agent for Acme."}'
# → {"thread_id":"…"}

# send a message
curl -s -X POST localhost:3000/threads/$THREAD/messages -H 'content-type: application/json' \
  -d '{"text":"Hi, what can you help me with?"}'
# → {"replies":["Hi! I can help with …"]}

# the same, streamed
curl -N -X POST "localhost:3000/threads/$THREAD/messages?stream=true" -H 'content-type: application/json' \
  -d '{"text":"Tell me more"}'

# the transcript, tool calls included
curl -s localhost:3000/threads/$THREAD
```

## Add a tool

Add an entry to `src/tools.ts`. The server runs it whenever the model asks for it, and stores each
call in the thread.
