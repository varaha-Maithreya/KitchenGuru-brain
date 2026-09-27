import { runTurn } from '@/lib/agent';
import { ok, readJson, route } from '@/lib/http';
import { customerTenant, requireInternal } from '@/lib/tenant';

export interface CustomerChatBody {
  locationId?: string;
  locationName?: string;
  contact?: { phone?: string; name?: string };
  message?: string;
  /** Start over (e.g. the customer typed "restart"), abandoning the current session's conversation. */
  newConversation?: boolean;
}

/**
 * POST /api/guru/customer/chat — one WhatsApp customer turn.
 * Internal-only: the caller (kitchenasty's inbox glue) has already mapped
 * the incoming message to its Location and contact phone. The session key
 * is (location, phone), so the same number messaging two restaurants gets
 * two separate conversations, and each restaurant's conversation expires
 * after the customer-session TTL.
 */
export const POST = route(async (req: Request) => {
  requireInternal(req);
  const body = await readJson<CustomerChatBody>(req);
  const tenant = customerTenant({
    locationId: body.locationId,
    locationName: body.locationName,
    phone: body.contact?.phone,
    name: body.contact?.name,
  });
  const result = await runTurn({
    tenant,
    channel: 'whatsapp',
    message: String(body.message ?? ''),
    newConversation: !!body.newConversation,
  });
  return ok({ conversationId: result.conversationId, reply: result.reply, toolCalls: result.toolCalls });
});
