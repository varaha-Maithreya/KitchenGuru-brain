import type { TenantContext } from '../tenant';
import { httpContractBackend } from './adapters/httpContract';
import { kitchenGuruBackend } from './adapters/kitchenguru';
import type { CommerceBackend } from './types';

export type BackendFactory = (tenant: TenantContext) => CommerceBackend;

const factories = new Map<string, BackendFactory>();

/** Adds (or replaces) a backend. Call at startup to plug in an in-process adapter. */
export function registerCommerceBackend(id: string, factory: BackendFactory): void {
  factories.set(id, factory);
}

registerCommerceBackend('kitchenguru', (t) => kitchenGuruBackend(t));
registerCommerceBackend('http', (t) => {
  const baseUrl = process.env.COMMERCE_HTTP_BASE_URL;
  if (!baseUrl) return unavailable('http', 'COMMERCE_HTTP_BASE_URL is not set');
  return httpContractBackend(t, { baseUrl, token: process.env.COMMERCE_HTTP_TOKEN });
});

/** A backend that cannot work reports why on every call, so the model tells the customer honestly instead of inventing an order. */
function unavailable(id: string, why: string): CommerceBackend {
  const fail = async () => ({ error: `The order system is not available (${why})` });
  return { id, searchCatalog: fail, placeOrder: fail, listMyOrders: fail };
}

/**
 * The backend for this conversation. Selected by COMMERCE_BACKEND (default
 * "kitchenguru"); swapping products is a config change, not a code change.
 */
export function getCommerceBackend(tenant: TenantContext, id: string = process.env.COMMERCE_BACKEND || 'kitchenguru'): CommerceBackend {
  const factory = factories.get(id);
  return factory ? factory(tenant) : unavailable(id, `no backend registered as "${id}"`);
}
