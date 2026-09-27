import type { TenantContext } from '../../tenant';
import type { CatalogItem, CommerceBackend, OrderSummary, PlacedOrder, Result } from '../types';

export interface HttpBackendOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Generic adapter for any backend that implements the HTTP form of the
 * commerce contract (docs/COMMERCE_CONTRACT.md) — so pointing the bot at a
 * different product needs no code here, only that product exposing:
 *
 *   GET  {base}/catalog?q=          -> { data: CatalogItem[] }
 *   POST {base}/orders              -> { data: PlacedOrder }      (body: PlaceOrderInput)
 *   GET  {base}/orders/mine         -> { data: OrderSummary[] }
 *
 * Every request carries `Authorization: Bearer <token>`, `x-tenant-id` (the
 * business the conversation belongs to) and `x-customer-phone` (who is
 * asking). Errors are `{ error: string }` with a non-2xx status.
 */
export function httpContractBackend(tenant: TenantContext, opts: HttpBackendOptions): CommerceBackend {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-tenant-id': tenant.locationId,
    'x-customer-phone': encodeURIComponent(tenant.principal.id),
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
  };

  async function call<T>(method: string, path: string, body?: unknown): Promise<Result<T>> {
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      const json = (await res.json().catch(() => null)) as { data?: T; error?: string } | null;
      if (!res.ok || json?.data === undefined) return { error: json?.error || `Order system responded ${res.status}` };
      return json.data;
    } catch (err) {
      return { error: err instanceof Error && err.name === 'TimeoutError' ? 'Order system timed out' : 'Order system is unreachable' };
    }
  }

  return {
    id: 'http',
    searchCatalog: (query) => call<CatalogItem[]>('GET', `/catalog${query ? `?q=${encodeURIComponent(query)}` : ''}`),
    placeOrder: (input) => call<PlacedOrder>('POST', '/orders', input),
    listMyOrders: () => call<OrderSummary[]>('GET', '/orders/mine'),
  };
}
