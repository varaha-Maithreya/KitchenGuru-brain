/**
 * The commerce contract — the ONLY thing the customer-facing bot knows about
 * whatever system takes the order and the money (KitchenGuru today, some other
 * product tomorrow). The bot's tools speak these types; each backend is an
 * adapter that translates them. See docs/COMMERCE_CONTRACT.md.
 *
 * Failures are returned, not thrown, as `{ error }` — the same convention the
 * tools already use so the model can relay them honestly.
 */

export type Result<T> = T | { error: string };

export const isError = <T>(r: Result<T>): r is { error: string } =>
  !!r && typeof r === 'object' && 'error' in (r as object) && typeof (r as { error: unknown }).error === 'string';

export interface CatalogItem {
  id: string;
  name: string;
  price: number;
  description?: string | null;
  category?: string | null;
  allergens?: string[];
  /** Orderable right now (in stock, enabled). Backends should not list what cannot be ordered. */
  available: boolean;
}

export interface OrderLine {
  itemId: string;
  quantity: number;
  note?: string;
}

export type Fulfilment = 'PICKUP' | 'DELIVERY';

export interface PlaceOrderInput {
  lines: OrderLine[];
  fulfilment: Fulfilment;
  note?: string;
  customer: { name?: string; phone: string };
}

/** How the customer pays for an order. `url` is a link the customer opens; the backend owns the payment methods behind it. */
export interface PaymentRequest {
  url: string;
  status: 'PENDING' | 'PAID';
  expiresAt?: string;
}

export interface PlacedOrder {
  /** Human-facing order reference the customer can quote. */
  reference: string;
  total: number;
  status: string;
  /** Null when nothing is owed (already paid, pay-on-delivery, free). */
  payment: PaymentRequest | null;
}

export interface OrderSummary {
  reference: string;
  status: string;
  total: number;
  fulfilment?: Fulfilment;
  placedAt?: string;
  items?: { name: string; quantity: number }[];
  /** Present while the order still awaits payment, so the link can be re-sent. */
  payment: PaymentRequest | null;
}

export interface CommerceBackend {
  /** Registry id, e.g. "kitchenguru". */
  readonly id: string;
  /** Orderable items matching `query` (all when omitted). */
  searchCatalog(query?: string): Promise<Result<CatalogItem[]>>;
  /** Places the order and, when money is owed, returns how to pay for it. */
  placeOrder(input: PlaceOrderInput): Promise<Result<PlacedOrder>>;
  /** The calling customer's recent orders (never anyone else's). */
  listMyOrders(): Promise<Result<OrderSummary[]>>;
}
