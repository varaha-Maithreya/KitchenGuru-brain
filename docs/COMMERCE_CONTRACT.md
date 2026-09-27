# Commerce contract

The customer-facing bot (WhatsApp concierge) never talks to a specific product.
It talks to a **commerce backend** through a small contract, so the business
system behind it (KitchenGuru today, anything else tomorrow) can be swapped
without touching the bot.

```
customer on WhatsApp -> BotChat -> bot (tools) -> CommerceBackend -> your system
                                                     |- kitchenguru  (built in)
                                                     |- http         (any system that speaks the HTTP contract)
                                                     `- your adapter (registerCommerceBackend)
```

Code: `src/lib/commerce/` (`types.ts` is the contract). Choose the backend with
`COMMERCE_BACKEND` (default `kitchenguru`).

## What the bot can do

| Operation | Purpose |
|---|---|
| `searchCatalog(query?)` | Orderable items, with ids and prices |
| `placeOrder(input)` | Create the order; **return how to pay** |
| `listMyOrders()` | The calling customer's recent orders |

`placeOrder` returns `payment: { url, status }` whenever money is owed. The bot
sends that link in the chat itself, so nobody has to send it by hand. When the
customer pays, the backend confirms the order on its side and may message the
customer back (KitchenGuru does this through BotChat).

## Option A: the HTTP contract (no code)

Set:

```
COMMERCE_BACKEND=http
COMMERCE_HTTP_BASE_URL=https://your-system.example/api/commerce
COMMERCE_HTTP_TOKEN=<shared secret>
```

Every request carries `Authorization: Bearer <token>`, `x-tenant-id` (the
business the chat belongs to) and `x-customer-phone` (URL-encoded, who is asking).
Responses are `{ "data": ... }`; failures are a non-2xx status with `{ "error": "message" }`.
Scope everything to `x-tenant-id`, and only ever show a customer their own orders.

**`GET /catalog?q=<text>`** returns `{ data: CatalogItem[] }`

```json
{ "id": "sku-1", "name": "Chicken biryani", "price": 240, "description": "...",
  "category": "Mains", "allergens": [], "available": true }
```

**`POST /orders`** body:

```json
{ "lines": [{ "itemId": "sku-1", "quantity": 2, "note": "no onion" }],
  "fulfilment": "PICKUP", "note": "optional",
  "customer": { "name": "Asha", "phone": "919999900001" } }
```

returns `{ data: PlacedOrder }`:

```json
{ "reference": "ORD-1001", "total": 480, "status": "PENDING",
  "payment": { "url": "https://pay.example/ORD-1001", "status": "PENDING", "expiresAt": "2026-09-27T10:00:00Z" } }
```

`payment` is `null` when nothing is owed. Reject unknown or unavailable item ids with an `error`.

**`GET /orders/mine`** returns `{ data: OrderSummary[] }` (newest first, at most a few):

```json
{ "reference": "ORD-1001", "status": "PENDING", "total": 480, "fulfilment": "PICKUP",
  "placedAt": "2026-09-26T10:00:00Z", "items": [{ "name": "Chicken biryani", "quantity": 2 }],
  "payment": { "url": "https://pay.example/ORD-1001", "status": "PENDING" } }
```

Include `payment` while the order is unpaid so the bot can re-offer the link.

## Option B: an in-process adapter

```ts
import { registerCommerceBackend } from '@/lib/commerce/registry';
import type { CommerceBackend } from '@/lib/commerce/types';

registerCommerceBackend('financeguru', (tenant): CommerceBackend => ({
  id: 'financeguru',
  searchCatalog: async (q) => { /* call your system */ },
  placeOrder: async (input) => { /* create order, return { reference, total, status, payment } */ },
  listMyOrders: async () => { /* ... */ },
}));
```

then `COMMERCE_BACKEND=financeguru`. Return `{ error: "..." }` instead of throwing.
A backend that is misconfigured or unknown answers every call with an error, so the bot
tells the customer the order system is unavailable rather than inventing an order.

## Payment confirmation

Paying is the backend's business (PhonePe, UPI, cards...). The contract only carries the link.
To tell the customer "payment received" in the same chat, the backend sends a message through
BotChat's API when its payment webhook fires. KitchenGuru does this in
`lib/whatsappOrderEvents.ts`.

## KitchenGuru specifics

Orders placed by the bot are marked `externalRef.source = "whatsapp-concierge"` (they stay on
the normal `direct` channel, so kitchen display, invoices and status messages work as usual).
The pay link is `${STOREFRONT_URL}/pay/<orderId>`, the storefront page where the customer picks
whichever gateway the restaurant enabled (PhonePe, UPI, Razorpay, ...).
