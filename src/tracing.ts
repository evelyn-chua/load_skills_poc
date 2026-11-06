import { OpenTelemetry } from '@ai-sdk/otel';
import { OpenInferenceBatchSpanProcessor, isOpenInferenceSpan } from '@arizeai/openinference-vercel';
import { context, type Attributes } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import type { TelemetryOptions } from 'ai';

const SERVICE_NAME = 'load-skills-poc';

export interface PhoenixTracing {
  /** Where spans go: `{OTLP_ENDPOINT}/v1/traces`. */
  url: string;
  /** The Phoenix project the spans land in. */
  project: string;
  /** The `telemetry` option for one turn's `streamText`. `attributes` is read as each span starts. */
  telemetry: (attributes: () => Attributes) => TelemetryOptions;
  /** Sends the spans still buffered. Call before the process exits. */
  shutdown: () => Promise<void>;
}

/**
 * Chat traces to Phoenix (Arize) over OTLP/HTTP, as Studio sends them (lib/chat-tracing/): the AI
 * SDK's spans, turned into OpenInference spans by Arize's processor. Configured by Studio's
 * variable names, OTLP_ENDPOINT, OTLP_AUTH_HEADER and OTLP_API_KEY; PHOENIX_PROJECT_NAME picks the
 * project. Null, and every turn untraced, when the endpoint or key is unset.
 */
export function createPhoenixTracing(env: NodeJS.ProcessEnv = process.env): PhoenixTracing | null {
  const endpoint = env.OTLP_ENDPOINT?.trim();
  const apiKey = env.OTLP_API_KEY?.trim();
  if (!endpoint || !apiKey) return null;
  const url = `${endpoint.replace(/\/+$/, '')}/v1/traces`;
  const project = env.PHOENIX_PROJECT_NAME?.trim() || SERVICE_NAME;

  // Without a context manager no span has a parent, so a turn's steps and tool calls would each
  // land as a trace of their own instead of under the turn.
  const manager = new AsyncLocalStorageContextManager().enable();
  if (!context.setGlobalContextManager(manager)) manager.disable();

  const exporter = new OTLPTraceExporter({ url, headers: { [env.OTLP_AUTH_HEADER?.trim() || 'authorization']: apiKey } });
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': SERVICE_NAME, 'openinference.project.name': project }),
    spanProcessors: [new OpenInferenceBatchSpanProcessor({ exporter, spanFilter: isOpenInferenceSpan })],
  });
  const tracer = provider.getTracer(SERVICE_NAME);

  return {
    url,
    project,
    telemetry: (attributes) => ({
      functionId: 'chat-turn',
      recordInputs: true,
      recordOutputs: true,
      integrations: new OpenTelemetry({ tracer, agentSpanName: 'functionId', usage: true, enrichSpan: () => attributes() }),
    }),
    shutdown: () => provider.shutdown(),
  };
}
