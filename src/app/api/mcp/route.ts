import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import { kitchenClient } from '@/lib/kitchen';
import { isInternalCaller, type TenantContext } from '@/lib/tenant';

/**
 * Guru's MCP server — the ONE place Guru exposes knowledge to other
 * agents, specifically Bot Studio's customer-facing AI (see
 * /api/webhooks/bot-studio-interpret, which connects to this as an MCP
 * client). Deliberately narrow: read-only, aggregate, customer-safe facts
 * for ONE restaurant — never order history, revenue or anyone's personal
 * data. Internal token required (this path is reachable through the
 * reverse proxy). locationId is supplied by the calling code from the flow
 * it's running, never chosen by a model.
 */

const locationId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe('The restaurant (Location) the running flow belongs to');

const botTenant = (id: string): TenantContext => ({
  locationId: id,
  principal: { type: 'customer', id: 'bot-studio' },
});

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      'menu_insights',
      {
        title: 'Menu insights',
        description: "This restaurant's bestselling dishes and currently-orderable items (optionally filtered by a dietary hint) — answer \"what's popular\" / \"what's vegan\" with real data instead of guessing.",
        inputSchema: z.object({
          locationId,
          dietary: z.string().optional().describe('Filter hint, e.g. "vegan", "gluten-free" — matched loosely against item names/descriptions'),
        }),
      },
      async ({ locationId, dietary }) => {
        const k = kitchenClient(botTenant(locationId));
        const [topSellers, menu] = await Promise.all([
          k.get('/bestsellers'),
          k.get('/menu', { search: dietary, availableOnly: true, customer: true }),
        ]);
        return text({ topSellers, matchingItems: menu });
      },
    );

    server.registerTool(
      'fulfillment_snapshot',
      {
        title: 'Fulfillment snapshot',
        description: 'Current kitchen load, busy mode and typical prep/lead times for this restaurant — answer "how long will my order take" honestly instead of assuming.',
        inputSchema: z.object({ locationId }),
      },
      async ({ locationId }) => text(await kitchenClient(botTenant(locationId)).get('/wait-estimate')),
    );
  },
  { serverInfo: { name: 'kitchenguru-guru', version: '2.0.0' } },
);

async function guarded(req: Request): Promise<Response> {
  if (!isInternalCaller(req)) return new Response('Unauthorized', { status: 401 });
  return handler(req);
}

export { guarded as GET, guarded as POST };
