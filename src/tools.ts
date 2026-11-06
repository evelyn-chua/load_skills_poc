import type { ToolSet } from 'ai';

/**
 * The tools the agent can call. The server runs them and feeds each result back to the model; a
 * tool that throws is answered to the model as an error, not a failed turn. Add one entry per tool:
 *
 *   import { tool } from 'ai';
 *   import { z } from 'zod';
 *
 *   lookup_order: tool({
 *     description: 'Looks up an order by its number.',
 *     inputSchema: z.object({ order_id: z.string() }),
 *     execute: async ({ order_id }) => fetchOrder(order_id),
 *   }),
 */
export const tools: ToolSet = {};
