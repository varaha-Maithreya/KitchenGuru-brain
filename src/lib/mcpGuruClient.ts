import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { config } from './config';

/**
 * Bot Studio's AI is a customer bot, not Guru — it has no owner tools of
 * its own (see bot-studio-interpret/route.ts's header comment). When it
 * needs real business knowledge to answer a customer's tangential
 * question honestly (today's bestsellers, current kitchen load), it asks
 * Guru for it over MCP rather than re-implementing Guru's data access —
 * this is the one, narrow, read-only bridge between the two. Every call is
 * pinned to the location of the flow being run.
 */

const SELF_URL = process.env.SELF_URL || `http://localhost:${process.env.PORT || 3000}`;

let cachedClient: Client | null = null;

async function getClient(): Promise<Client> {
  if (cachedClient) return cachedClient;
  const client = new Client({ name: 'bot-studio', version: '1.0.0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${SELF_URL}/api/mcp`), {
      requestInit: { headers: config.internalToken ? { 'x-kg-internal-token': config.internalToken } : {} },
    }),
  );
  cachedClient = client;
  return client;
}

async function callGuruTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  let result;
  try {
    result = await (await getClient()).callTool({ name, arguments: args });
  } catch (err) {
    cachedClient = null; // reconnect next time (brain restarted, session expired)
    throw err;
  }
  const content = result.content as { type: string; text?: string }[] | undefined;
  const text = content?.find((c) => c.type === 'text')?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const guruMcpTools = {
  menuInsights: (locationId: string, dietary?: string) =>
    callGuruTool('menu_insights', dietary ? { locationId, dietary } : { locationId }),
  fulfillmentSnapshot: (locationId: string) => callGuruTool('fulfillment_snapshot', { locationId }),
};
