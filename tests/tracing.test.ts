import { describe, expect, it } from 'vitest';
import { createPhoenixTracing } from '../src/tracing';

describe('createPhoenixTracing', () => {
  it('is off unless both the endpoint and the key are set', () => {
    expect(createPhoenixTracing({})).toBeNull();
    expect(createPhoenixTracing({ OTLP_ENDPOINT: 'https://phoenix.example' })).toBeNull();
    expect(createPhoenixTracing({ OTLP_API_KEY: 'Bearer k' })).toBeNull();
  });

  it('sends to {endpoint}/v1/traces, in the configured project, and traces each turn', async () => {
    const tracing = createPhoenixTracing({ OTLP_ENDPOINT: 'https://phoenix.example/', OTLP_API_KEY: 'Bearer k', PHOENIX_PROJECT_NAME: 'eval' })!;
    expect(tracing.url).toBe('https://phoenix.example/v1/traces');
    expect(tracing.project).toBe('eval');
    expect(tracing.telemetry(() => ({ 'session.id': 't1' }))).toMatchObject({ functionId: 'chat-turn', recordInputs: true, recordOutputs: true });
    await tracing.shutdown();
  });
});
