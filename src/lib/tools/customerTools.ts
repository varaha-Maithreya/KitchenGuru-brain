import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { isError } from '../commerce/types';
import { kitchenClient } from '../kitchen';
import { getCommerceBackend } from '../commerce/registry';
import type { TenantContext } from '../tenant';

/**
 * The customer-facing concierge's toolset (WhatsApp). Bound to one
 * restaurant AND one customer: order lookups only ever return orders placed
 * with this customer's own phone number at this restaurant, and placed
 * orders always go to this restaurant under this customer's phone —
 * neither comes from model input.
 */
export function customerTools(tenant: TenantContext): ToolSet {
  // Menu, orders and payment go through the commerce contract, so the same bot
  // works against whichever system COMMERCE_BACKEND points at. Escalations
  // are KitchenGuru staff alerts and stay on the kitchen client.
  const commerce = getCommerceBackend(tenant);
  const k = kitchenClient(tenant);
  const customerName = tenant.principal.name;
  const customerPhone = tenant.principal.id;

  return {
    checkMenu: tool({
      description: "Search this business's catalogue for what can be ordered right now, with prices and ids. Always call before confirming any item or price.",
      inputSchema: z.object({
        query: z.string().optional().describe('Item name or keyword, e.g. "biryani"; omit to browse'),
      }),
      execute: async ({ query }) => {
        const items = await commerce.searchCatalog(query);
        return isError(items) ? items : { items };
      },
    }),

    placeOrder: tool({
      description: 'Send a confirmed order. Only after the customer has explicitly confirmed the items, quantities and pickup/delivery. Use real item ids from checkMenu. If the result has payment.url, the order is NOT paid yet: give the customer that exact link and tell them to pay there to confirm it. Never say an order is paid or confirmed until payment.status is PAID or the customer has been told so by the system.',
      inputSchema: z.object({
        items: z.array(z.object({
          itemId: z.string().min(1).describe('The id from checkMenu'),
          quantity: z.number().int().min(1).max(50),
          comment: z.string().optional(),
        })).min(1),
        orderType: z.enum(['PICKUP', 'DELIVERY']).default('PICKUP'),
        comment: z.string().optional().describe('Special instructions for the kitchen'),
      }),
      execute: async (input) =>
        commerce.placeOrder({
          lines: input.items.map((i) => ({ itemId: i.itemId, quantity: i.quantity, note: i.comment })),
          fulfilment: input.orderType,
          note: input.comment,
          customer: { name: customerName, phone: customerPhone },
        }),
    }),

    myOrderStatus: tool({
      description: "This customer's own recent orders and their live status. Use for \"where is my order\". An order with payment.url is still unpaid: offer that link again.",
      inputSchema: z.object({}),
      execute: async () => {
        const orders = await commerce.listMyOrders();
        return isError(orders) ? orders : { orders };
      },
    }),

    escalateToHuman: tool({
      description: 'Hand the conversation to restaurant staff: the customer is upset, asks for a human, or needs something you cannot do (refunds, complaints about a delivered order).',
      inputSchema: z.object({
        reason: z.string().describe('One line: why a human is needed'),
        summary: z.string().describe('What the customer wants, so staff do not need to re-ask'),
      }),
      execute: async (input) => k.post('/escalations', { ...input, customerName: tenant.principal.name }),
    }),
  };
}
