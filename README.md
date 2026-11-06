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

## Test the skill loading with a simulated customer

An LLM plays the customer through test scenarios, over the HTTP API above, and each conversation is
checked against what the scenario expects.

```bash
pnpm dev                                                    # the agent, in another terminal
pnpm exec tsx --env-file=.env simulator/run.ts              # all 10 scenarios
pnpm exec tsx --env-file=.env simulator/run.ts --only TC06,TC09 --concurrency 3
```

### Scenarios

[`scenarios/all_scenarios.json`](scenarios/all_scenarios.json) holds 10 scenarios. Each gives the
customer a persona, private facts (booking K7XQ2M, Rivera), goals in order, an end condition and what
they may agree to, plus what the agent should do.

| Test | Category | The customer… |
|---|---|---|
| TC01 | one skill | asks if MR214 is delayed and its gate (`flight_status`) |
| TC02 | one skill | picks free window seat 23A (`seat_selection`) |
| TC03 | one skill | asks the checked-bag allowance, declines to buy (`baggage`) |
| TC04 | one skill | checks in themselves, boarding pass by email (`check_in`) |
| TC05 | one skill | asks if their refund was processed (`refunds_and_credits`) |
| TC06 | two skills | moves the outbound to 21 Nov, then picks seat 23A (`reschedule_flight` → `seat_selection`) |
| TC07 | two skills | buys an extra bag, then checks in (`baggage` → `check_in`) |
| TC08 | two skills | learns MR214 is delayed, then cancels the trip (`flight_status` → `cancel_booking`) |
| TC09 | switch back | status → alternative flights → status again, books nothing (`flight_status` → `reschedule_flight` → `flight_status`) |
| TC10 | switch back | bag allowance → reports a missing bag → extra-bag price (`baggage` → `lost_baggage` → `baggage`) |

Skills that read a booking also bring in `verify_identity`.

### Customer simulator

[`simulator/customer.ts`](simulator/customer.ts) prompts an open-source model with the scenario's
persona, facts, goals and end condition only: it never sees the agent's tools or the expected outcome.
[`simulator/run.ts`](simulator/run.ts) starts one thread per scenario and alternates customer and
agent messages. A chat ends when the agent calls `end_chat`, the customer writes `[END]`, or the
customer has sent `max_turns` messages.

The customer model is any OpenAI-compatible endpoint: `SIM_BASE_URL`, `SIM_MODEL`, `SIM_API_KEY`.
The default is `openai/gpt-oss-120b` on Baseten with `BASETEN_API_KEY`; for a local model with
Ollama, set `SIM_BASE_URL=http://localhost:11434/v1` and `SIM_MODEL` to the model's name.

### Evaluation

[`simulator/evaluate.ts`](simulator/evaluate.ts) checks each transcript against the scenario's
`evaluation` block. No LLM judge: every check reads the tool calls or the agent's replies.

- **skills loaded:** exactly the expected skills, dependencies included
- **no redundant reload:** no skill loaded while it is already the active one; switching back to a
  skill means loading it again, since only the last loaded skill is active
- **tools only from applied skill:** no skill tool called while its skill isn't active
- **required / forbidden tools:** a tool listed twice must be called twice (the switch-back scenarios)
- **tool arguments:** the expected arguments, in any order and case
- **end_chat:** the expected `reason` and `resolved`
- **facts told to customer:** each expected fact appears, as written, in one of the agent's replies

Each run is written to `results/<run>/`: one JSON per scenario (the chat, the full transcript with
tool calls, and the checks), `summary.json`, and `summary.csv` with one row per check.
[`simulator/to-csv.ts`](simulator/to-csv.ts) rebuilds the CSV from an older run's `summary.json`.
