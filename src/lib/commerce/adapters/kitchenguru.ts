import { kitchenClient, type KitchenClient } from '../../kitchen';
import type { TenantContext } from '../../tenant';
import { isError, type CatalogItem, type CommerceBackend, type OrderSummary, type PaymentRequest, type PlacedOrder } from '../types';

/** KitchenGuru's shapes, as returned by kitchenasty's /api/guru/tools surface. */
interface KgPayment { status: 'PENDING' | 'PAID'; url: string }
interface KgMenuItem { id: string; name: string; description?: string | null; price: number; category?: string; allergens?: string[]; available?: boolean }
interface KgPlaced { orderNumber: string; total: number; status: string; payment?: KgPayment | null }
interface KgOrder {
  orderNumber: string; status: string; orderType?: 'PICKUP' | 'DELIVERY'; total: number; createdAt?: string;
  items?: { name: string; quantity: number }[]; payment?: KgPayment | null;
}

const payment = (p?: KgPayment | null): PaymentRequest | null => (p?.url ? { url: p.url, status: p.status } : null);

export function kitchenGuruBackend(tenant: TenantContext, client: KitchenClient = kitchenClient(tenant)): CommerceBackend {
  return {
    id: 'kitchenguru',

    async searchCatalog(query) {
      const r = await client.get<{ items: KgMenuItem[] }>('/menu', { search: query, availableOnly: true, customer: true });
      if (isError(r)) return r;
      return r.items.map((i): CatalogItem => ({
        id: i.id, name: i.name, price: i.price, description: i.description, category: i.category, allergens: i.allergens, available: i.available !== false,
      }));
    },

    async placeOrder(input) {
      const r = await client.post<KgPlaced>('/orders', {
        items: input.lines.map((l) => ({ menuItemId: l.itemId, quantity: l.quantity, comment: l.note })),
        orderType: input.fulfilment,
        comment: input.note,
        customerName: input.customer.name,
      });
      if (isError(r)) return r;
      return { reference: r.orderNumber, total: r.total, status: r.status, payment: payment(r.payment) } satisfies PlacedOrder;
    },

    async listMyOrders() {
      const r = await client.get<{ orders: KgOrder[] }>('/orders/mine');
      if (isError(r)) return r;
      return r.orders.map((o): OrderSummary => ({
        reference: o.orderNumber, status: o.status, total: o.total, fulfilment: o.orderType, placedAt: o.createdAt, items: o.items, payment: payment(o.payment),
      }));
    },
  };
}
