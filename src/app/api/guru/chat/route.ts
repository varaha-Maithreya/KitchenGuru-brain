import { runTurn } from '@/lib/agent';
import { ok, readJson, route } from '@/lib/http';
import { staffTenantFromRequest } from '@/lib/tenant';

/**
 * POST /api/guru/chat — one owner/staff console turn.
 * Tenant (location + user) comes from kitchenasty's headers, never the body.
 * Body: { message, conversationId?, newConversation? }
 */
export const POST = route(async (req: Request) => {
  const tenant = staffTenantFromRequest(req);
  const body = await readJson<{ message?: string; conversationId?: string; newConversation?: boolean }>(req);
  const result = await runTurn({
    tenant,
    channel: 'console',
    message: String(body.message ?? ''),
    conversationId: body.conversationId || undefined,
    newConversation: !!body.newConversation,
  });
  return ok(result);
});
