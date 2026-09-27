import { ok, readJson, route } from '@/lib/http';
import { createConversation, listConversations } from '@/lib/store/conversations';
import { bindSession, resolveSession } from '@/lib/store/sessions';
import { staffTenantFromRequest } from '@/lib/tenant';

/** GET /api/guru/conversations?status=active|archived&limit= — the caller's own console conversations at their location. */
export const GET = route(async (req: Request) => {
  const tenant = staffTenantFromRequest(req);
  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const [conversations, session] = await Promise.all([
    listConversations(tenant, {
      channel: 'console',
      status: status === 'archived' ? 'archived' : status === 'all' ? undefined : 'active',
      limit: Number(url.searchParams.get('limit')) || 30,
    }),
    resolveSession(tenant, 'console'),
  ]);
  return ok({ conversations, currentConversationId: session.conversationId });
});

/** POST /api/guru/conversations { title? } — start a new chat and make it the session's current one. */
export const POST = route(async (req: Request) => {
  const tenant = staffTenantFromRequest(req);
  const body = await readJson<{ title?: string }>(req).catch(() => ({} as { title?: string }));
  const conversation = await createConversation(tenant, 'console', body.title);
  await resolveSession(tenant, 'console');
  await bindSession(tenant, 'console', conversation.id);
  return ok({ conversation }, 201);
});
