import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadAgentConfig } from '../src/config';
import { createSkillAgent, latestLoadedSkill } from '../src/skills';
import { scriptedModel, systemPromptOf, toolsOfferedTo } from './mock-model';

const config = loadAgentConfig();
const agent = createSkillAgent(config);
const skillOf = (name: string) => config.skills.find((skill) => skill.name === name)!;

/** A `load_skill` call and its result, as they sit in the history. */
function loaded(skillName: string, result: unknown = agent.loadSkill(skillName, null)): ModelMessage[] {
  const callId = `call_${skillName}`;
  return [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: callId, toolName: 'load_skill', input: { skill_name: skillName } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: callId, toolName: 'load_skill', output: { type: 'json', value: result as never } }] },
  ];
}

describe('latestLoadedSkill', () => {
  it('is the skill of the latest successful load_skill result in the history', () => {
    expect(latestLoadedSkill([{ role: 'user', content: 'hi' }])).toBeNull();
    expect(latestLoadedSkill([...loaded('cancel_booking'), { role: 'user', content: 'actually…' }, ...loaded('seat_selection')])).toBe('seat_selection');
  });

  it('skips a load that failed', () => {
    expect(latestLoadedSkill([...loaded('cancel_booking'), ...loaded('nope', agent.loadSkill('nope', null))])).toBe('cancel_booking');
  });
});

describe('the skill applied to a step', () => {
  it('is none at first: the base prompt and only the common tools', () => {
    const { instructions, activeTools } = agent.current(null);
    expect(activeTools).toEqual(['load_skill', 'end_chat']);
    expect(instructions).toContain('You are **Mia**');
    expect(instructions).toContain('The customer is on web chat');
    expect(instructions).toContain(config.commonTools[0]!.instructions);
    expect(instructions).not.toContain('{{');
    expect(instructions).not.toContain('## Active skill');
  });

  it('brings in the skill and its dependencies: their instructions join the prompt and their tools are offered', () => {
    const { instructions, activeTools } = agent.current('cancel_booking');
    expect(activeTools).toEqual(['load_skill', 'end_chat', 'get_booking', 'get_cancellation_quote', 'cancel_segments']);
    expect(instructions).toContain('You are **Mia**');
    expect(instructions).toContain('## Active skill: cancel_booking');
    expect(instructions).toContain(skillOf('verify_identity').instructions);
    expect(instructions).toContain(skillOf('cancel_booking').instructions);
  });

  it('replaces the previous skill: its instructions and tools go, shared dependencies stay', () => {
    const { instructions, activeTools } = agent.current(latestLoadedSkill([...loaded('cancel_booking'), ...loaded('seat_selection')]));
    expect(activeTools).toEqual(['load_skill', 'end_chat', 'get_booking', 'get_seat_map', 'assign_seat']);
    expect(instructions).toContain(skillOf('seat_selection').instructions);
    expect(instructions).not.toContain(skillOf('cancel_booking').instructions);
  });
});

describe('load_skill', () => {
  it('returns the result config/primary_tools.json describes', () => {
    expect(agent.loadSkill('cancel_booking', null)).toEqual({
      success: true,
      skill_name: 'cancel_booking',
      already_loaded: false,
      dependencies_loaded: ['verify_identity'],
      tools_added: ['get_booking', 'get_cancellation_quote', 'cancel_segments'],
      instructions: { verify_identity: skillOf('verify_identity').instructions, cancel_booking: skillOf('cancel_booking').instructions },
    });
  });

  it('says so when the skill is already applied, and refuses an unknown one', () => {
    expect(agent.loadSkill('flight_status', 'flight_status')).toMatchObject({ success: true, already_loaded: true });
    expect(agent.loadSkill('nope', 'flight_status')).toEqual({ success: false, skill_name: 'nope', error: 'Unknown skill: nope' });
  });
});

describe('a conversation that loads skills', () => {
  function setup(steps: Parameters<typeof scriptedModel>[0]) {
    const model = scriptedModel(steps);
    const app = createApp({ model, config });
    const post = (path: string, body: unknown) =>
      app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { model, app, post };
  }

  it('applies a skill from the very next step, and keeps it for the next turn until another replaces it', async () => {
    const { model, app, post } = setup([
      { text: 'Let me pull that up.', toolCalls: [{ toolName: 'load_skill', input: { skill_name: 'cancel_booking', reason: 'Wants to cancel' } }] },
      { toolCalls: [{ toolName: 'get_booking', input: { booking_reference: 'K7XQ2M', last_name: 'Rivera' } }] },
      { text: 'Thanks, Jordan. I can see your JFK to LHR trip on 20 Nov.' },
      { toolCalls: [{ toolName: 'load_skill', input: { skill_name: 'seat_selection', reason: 'Wants a window seat' } }] },
      { text: 'Seat 23A is free. Shall I take it?' },
    ]);
    const { thread_id } = (await (await post('/threads', {})).json()) as { thread_id: string };

    const first = await post(`/threads/${thread_id}/messages`, { text: 'I want to cancel my trip. K7XQ2M, Rivera.' });
    expect(await first.json()).toEqual({ replies: ['Let me pull that up.', 'Thanks, Jordan. I can see your JFK to LHR trip on 20 Nov.'], ended: false });
    expect(toolsOfferedTo(model, 0)).toEqual(['load_skill', 'end_chat']);
    expect(systemPromptOf(model, 0)).not.toContain('## Active skill');
    expect(toolsOfferedTo(model, 1)).toEqual(['load_skill', 'end_chat', 'get_booking', 'get_cancellation_quote', 'cancel_segments']);
    expect(systemPromptOf(model, 1)).toContain(skillOf('cancel_booking').instructions);

    const transcript = (await (await app.request(`/threads/${thread_id}`)).json()) as {
      active_skill: string;
      messages: Array<{ tool_name?: string; output?: unknown }>;
    };
    expect(transcript.active_skill).toBe('cancel_booking');
    expect(transcript.messages.find((m) => m.tool_name === 'get_booking')?.output).toEqual(skillOf('verify_identity').tools[0]!.response);

    await post(`/threads/${thread_id}/messages`, { text: 'Actually, can I pick a window seat instead?' });
    expect(toolsOfferedTo(model, 3)).toEqual(['load_skill', 'end_chat', 'get_booking', 'get_cancellation_quote', 'cancel_segments']);
    expect(toolsOfferedTo(model, 4)).toEqual(['load_skill', 'end_chat', 'get_booking', 'get_seat_map', 'assign_seat']);
    expect(systemPromptOf(model, 4)).not.toContain(skillOf('cancel_booking').instructions);
  });

  it('ends the turn when end_chat is called, and takes no more messages', async () => {
    const { model, post } = setup([
      { text: 'Glad I could help. Goodbye!', toolCalls: [{ toolName: 'end_chat', input: { reason: 'RESOLVED', resolved: true, summary: 'Customer said goodbye.' } }] },
      { text: 'This step must never run.' },
    ]);
    const { thread_id } = (await (await post('/threads', {})).json()) as { thread_id: string };

    const res = await post(`/threads/${thread_id}/messages`, { text: 'That is all, thanks!' });
    expect(await res.json()).toEqual({ replies: ['Glad I could help. Goodbye!'], ended: true });
    expect(model.doStreamCalls).toHaveLength(1);
    expect((await post(`/threads/${thread_id}/messages`, { text: 'one more thing' })).status).toBe(409);
  });
});
