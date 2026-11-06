# chat-agent

A POC of a single chat agent that loads **skills** as it needs them (ENG-684). The agent starts
with a base prompt and two tools, `load_skill` and `end_chat`. Loading a skill replaces the active
skill's instructions and tools with the new one's, from the next model call on.

The agent is defined in `config/`:

- `system_prompt.md`: the base prompt
- `primary_tools.json`: the common tools
- `skills.json`: the skills and their mock tools

Underneath is a minimal chat server extracted from Voice Agent Studio. It stores the thread, runs
tools on the server, calls Baseten (`zai-org/GLM-5.3-Flash`), and traces every turn to Phoenix.
Design: [`docs/design.md`](docs/design.md).

## Run

```bash
pnpm install
cp .env.example .env    # fill in BASETEN_API_KEY (Studio's .env has one); OTLP_* to trace to Phoenix
pnpm dev                # chat page at http://localhost:3000
pnpm test
```

The chat page shows the conversation, each tool call, and live, on the left: the applied skill, the
tools the model is offered, and the system prompt it sees next. Skill tools return mock data from
`config/skills.json`: use booking **K7XQ2M**, last name **Rivera**.

With `OTLP_ENDPOINT` and `OTLP_API_KEY` set, each turn appears in Phoenix under the project
`load-skills-poc`, and a conversation's turns are grouped into one session.

## Talk to it over HTTP

```bash
THREAD=$(curl -s -X POST localhost:3000/threads -H 'content-type: application/json' -d '{}' | jq -r .thread_id)

curl -s -X POST localhost:3000/threads/$THREAD/messages -H 'content-type: application/json' \
  -d '{"text":"I need to cancel my trip. K7XQ2M, Rivera."}'
# → {"replies":["Let me pull that up.", "Thanks, Jordan. …"],"ended":false}

curl -s localhost:3000/threads/$THREAD | jq '{active_skill, active_tools}'
# → {"active_skill":"cancel_booking","active_tools":["load_skill","end_chat","get_booking",…]}
```

Add `?stream=true` to a message request to stream the reply.
