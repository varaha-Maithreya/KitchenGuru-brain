import { NextResponse } from 'next/server';
import { runTurn } from '@/lib/agent';
import { HttpError, readJson } from '@/lib/http';
import { customerTenant, requireInternal, staffTenantFromRequest } from '@/lib/tenant';

/**
 * Legacy concierge webhook, kept for existing callers. It is now a thin
 * adapter onto the same agent as /api/guru/chat and /api/guru/customer/chat,
 * so it gets the same tenant isolation and conversation memory:
 *   - mode "guru_console": staff tenant from kitchenasty's x-kg-* headers;
 *   - otherwise: customer tenant from { restaurant_id | locationId, contact }.
 * Internal token is required in both modes (previously the customer mode was
 * open to the internet through the reverse proxy).
 */
export async function POST(req: Request) {
  try {
    requireInternal(req);
    const body = await readJson<{
      message?: string;
      mode?: string;
      restaurant_id?: string;
      locationId?: string;
      conversationId?: string;
      contact?: { name?: string; phone?: string };
      order_details?: unknown;
    }>(req);

    const message =
      body.message ||
      (body.order_details ? `I'd like to order: ${JSON.stringify(body.order_details)}` : 'Hello, what is on the menu?');

    const result =
      body.mode === 'guru_console'
        ? await runTurn({ tenant: staffTenantFromRequest(req), channel: 'console', message, conversationId: body.conversationId })
        : await runTurn({
            tenant: customerTenant({
              locationId: body.locationId || body.restaurant_id,
              phone: body.contact?.phone,
              name: body.contact?.name,
            }),
            channel: 'whatsapp',
            message,
          });

    return NextResponse.json({
      status: 'success',
      reply: result.reply,
      conversationId: result.conversationId,
      stepsCount: result.toolCalls.length + 1,
    });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error('[Guru Brain] concierge failed:', err);
    return NextResponse.json(
      { status: 'error', message: err instanceof HttpError ? err.message : 'Internal AI Server Error' },
      { status },
    );
  }
}
