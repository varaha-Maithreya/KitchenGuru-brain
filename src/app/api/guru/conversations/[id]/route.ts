import { HttpError, ok, readJson, route } from '@/lib/http';
import { deleteConversation, getConversation, listMessages, updateConversation } from '@/lib/store/conversations';
import { staffTenantFromRequest } from '@/lib/tenant';

type Ctx = { params: Promise<{ id: string }> };

/** GET — one of the caller's conversations with its messages (?beforeId= pages backwards). */
export const GET = route(async (req: Request, { params }: Ctx) => {
  const tenant = staffTenantFromRequest(req);
  const { id } = await params;
  const conversation = await getConversation(tenant, id);
  if (!conversation) throw new HttpError(404, 'Conversation not found');
  const beforeId = Number(new URL(req.url).searchParams.get('beforeId')) || undefined;
  const messages = await listMessages(tenant, id, { beforeId, limit: 100 });
  return ok({ conversation, messages });
});

/** PATCH { title?, status? } — rename or archive/unarchive. */
export const PATCH = route(async (req: Request, { params }: Ctx) => {
  const tenant = staffTenantFromRequest(req);
  const { id } = await params;
  const body = await readJson<{ title?: string; status?: string }>(req);
  if (body.status !== undefined && body.status !== 'active' && body.status !== 'archived') {
    throw new HttpError(400, 'status must be active or archived');
  }
  const conversation = await updateConversation(tenant, id, {
    title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : undefined,
    status: body.status as 'active' | 'archived' | undefined,
  });
  if (!conversation) throw new HttpError(404, 'Conversation not found');
  return ok({ conversation });
});

export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const tenant = staffTenantFromRequest(req);
  const { id } = await params;
  if (!(await deleteConversation(tenant, id))) throw new HttpError(404, 'Conversation not found');
  return ok({ deleted: true });
});
