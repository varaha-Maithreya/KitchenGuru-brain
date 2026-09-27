import { timingSafeEqual } from 'node:crypto';
import { config } from './config';
import { HttpError } from './http';

/**
 * Tenant isolation model
 * ----------------------
 * The brain never decides who a caller is. kitchenasty authenticates the
 * human (JWT → user record → their Location) and forwards that identity on
 * a server-to-server call carrying the internal token. Everything below
 * this file receives a TenantContext and is bound to it:
 *
 *   - every conversation/session row is keyed by (location_id, principal)
 *     and every read/write filters on both, so one owner can never load
 *     another owner's chat, even at the same restaurant;
 *   - every tool is constructed as a closure over the tenant, and every
 *     tool call into kitchenasty carries x-kg-location-id, so the model
 *     has no parameter it could use to reach another restaurant's data.
 */

export type StaffRole = 'SUPER_ADMIN' | 'OWNER' | 'MANAGER' | 'STAFF';

export type Principal =
  | { type: 'staff'; id: string; role: StaffRole; name?: string }
  | { type: 'customer'; id: string; name?: string };

export interface TenantContext {
  locationId: string;
  locationName?: string;
  principal: Principal;
}

const STAFF_ROLES: StaffRole[] = ['SUPER_ADMIN', 'OWNER', 'MANAGER', 'STAFF'];

/** Roles allowed to change data (menu availability, flows, drafts), not just read it. */
export function canWrite(tenant: TenantContext): boolean {
  return tenant.principal.type === 'staff' && tenant.principal.role !== 'STAFF';
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** True when the request carries the shared internal token (or none is configured — dev only). */
export function isInternalCaller(req: Request): boolean {
  if (!config.internalToken) return process.env.NODE_ENV !== 'production';
  const header = req.headers.get('x-kg-internal-token') || '';
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return safeEqual(header, config.internalToken) || safeEqual(bearer, config.internalToken);
}

export function requireInternal(req: Request): void {
  if (!isInternalCaller(req)) throw new HttpError(401, 'Unauthorized');
}

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;

function header(req: Request, name: string): string | undefined {
  const v = req.headers.get(name);
  return v ? decodeURIComponent(v).trim() || undefined : undefined;
}

/**
 * The staff tenant kitchenasty resolved for this request. Rejects anything
 * incomplete rather than defaulting — a missing location must never widen
 * into "all locations".
 */
export function staffTenantFromRequest(req: Request): TenantContext {
  requireInternal(req);
  const locationId = header(req, 'x-kg-location-id');
  const userId = header(req, 'x-kg-user-id');
  const role = header(req, 'x-kg-user-role') as StaffRole | undefined;
  if (!locationId || !idPattern.test(locationId)) throw new HttpError(400, 'x-kg-location-id is required');
  if (!userId || !idPattern.test(userId)) throw new HttpError(400, 'x-kg-user-id is required');
  if (!role || !STAFF_ROLES.includes(role)) throw new HttpError(400, 'x-kg-user-role is invalid');
  return {
    locationId,
    locationName: header(req, 'x-kg-location-name'),
    principal: { type: 'staff', id: userId, role, name: header(req, 'x-kg-user-name') },
  };
}

/** A customer tenant (WhatsApp contact at one location), from a trusted internal caller. */
export function customerTenant(input: { locationId?: string; locationName?: string; phone?: string; name?: string }): TenantContext {
  if (!input.locationId || !idPattern.test(input.locationId)) throw new HttpError(400, 'locationId is required');
  const phone = (input.phone || '').replace(/[^\d+]/g, '');
  if (phone.length < 6) throw new HttpError(400, 'contact.phone is required');
  return {
    locationId: input.locationId,
    locationName: input.locationName,
    principal: { type: 'customer', id: phone, name: input.name },
  };
}
