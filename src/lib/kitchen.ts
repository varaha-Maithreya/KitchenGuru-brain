import { config } from './config';
import type { TenantContext } from './tenant';

/**
 * The only way tools reach restaurant data: kitchenasty's
 * /api/guru/tools/* surface, which re-checks the internal token and scopes
 * every query to the x-kg-location-id header. The location comes from the
 * TenantContext this client was built with — never from model input.
 *
 * Failures come back as { error } for the model to relay honestly. There
 * is intentionally no demo/fallback data: an owner acting on invented
 * numbers is worse than being told the kitchen system is unreachable.
 */

export type ToolResult<T = unknown> = T | { error: string };

export interface KitchenClient {
  get<T = unknown>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<ToolResult<T>>;
  post<T = unknown>(path: string, body: unknown): Promise<ToolResult<T>>;
  patch<T = unknown>(path: string, body: unknown): Promise<ToolResult<T>>;
}

export function kitchenClient(tenant: TenantContext): KitchenClient {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-kg-location-id': tenant.locationId,
    'x-kg-principal-type': tenant.principal.type,
    'x-kg-principal-id': encodeURIComponent(tenant.principal.id),
    ...(tenant.principal.type === 'staff' ? { 'x-kg-user-role': tenant.principal.role } : {}),
    ...(config.internalToken ? { 'x-kg-internal-token': config.internalToken } : {}),
  };

  async function call<T>(method: string, path: string, body?: unknown, params?: Record<string, string | number | boolean | undefined>): Promise<ToolResult<T>> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== '') qs.set(k, String(v));
    const url = `${config.kitchenBaseUrl}/api/guru/tools${path}${qs.size ? `?${qs}` : ''}`;
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(config.toolTimeoutMs),
      });
      const json = (await res.json().catch(() => null)) as { success?: boolean; data?: T; error?: string } | null;
      if (!res.ok || !json?.success) return { error: json?.error || `Kitchen system responded ${res.status}` };
      return json.data as T;
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      return { error: timedOut ? 'Kitchen system timed out' : 'Kitchen system is unreachable' };
    }
  }

  return {
    get: (path, params) => call('GET', path, undefined, params),
    post: (path, body) => call('POST', path, body),
    patch: (path, body) => call('PATCH', path, body),
  };
}
