import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';
import { createChatModel } from './model';
import { tools } from './tools';

const app = createApp({ model: createChatModel(), tools });
// The POC's chat page (public/index.html), which talks to the API above.
app.get('/', serveStatic({ path: './public/index.html' }));

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port }, () => {
  console.log(`chat-agent listening on http://localhost:${port}`);
});
