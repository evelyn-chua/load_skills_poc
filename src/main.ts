import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';
import { createChatModel } from './model';
import { tools } from './tools';
import { createPhoenixTracing } from './tracing';

const tracing = createPhoenixTracing();
console.log(tracing ? `tracing to Phoenix project "${tracing.project}" at ${tracing.url}` : 'tracing off: OTLP_ENDPOINT or OTLP_API_KEY is not set');

const app = createApp({ model: createChatModel(), tools, tracing });
// The POC's chat page (public/index.html), which talks to the API above.
app.get('/', serveStatic({ path: './public/index.html' }));

const port = Number(process.env.PORT) || 3000;
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`chat-agent listening on http://localhost:${port}`);
});

// Spans are sent in batches: send what is still buffered before the process exits (a restart in
// watch mode included), or the last turn's trace is lost.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close();
    void (tracing?.shutdown() ?? Promise.resolve()).finally(() => process.exit(0));
  });
}
