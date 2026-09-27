import { query } from '../db';
import { config } from '../config';
import type { TenantContext } from '../tenant';
import type { Channel } from './conversations';

/**
 * A session is one principal's live presence on one channel at one
 * location — e.g. "owner U at location L in the console" or "customer
 * +91… at location L on WhatsApp". It points at that principal's current
 * conversation and slides its expiry forward on every turn. Once idle past
 * the TTL, the next message starts a fresh conversation (the old one stays
 * in history), which is what keeps a WhatsApp customer who returns next
 * week from inheriting last week's half-finished order.
 */

export interface Session {
  id: string;
  conversationId: string | null;
  expired: boolean;
}

const ttlMinutes = (t: TenantContext) =>
  t.principal.type === 'customer' ? config.customerSessionTtlMinutes : config.staffSessionTtlMinutes;

export async function resolveSession(t: TenantContext, channel: Channel): Promise<Session> {
  const rows = await query<{ id: string; conversation_id: string | null; expired: boolean }>(
    `INSERT INTO guru_sessions (location_id, principal_type, principal_id, channel, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))
     ON CONFLICT (location_id, principal_type, principal_id, channel)
     DO UPDATE SET last_active_at = now()
     RETURNING id, conversation_id, (expires_at < now()) AS expired`,
    [t.locationId, t.principal.type, t.principal.id, channel, ttlMinutes(t)],
  );
  const row = rows[0];
  return { id: row.id, conversationId: row.expired ? null : row.conversation_id, expired: row.expired };
}

/** Point the session at a conversation and push its expiry out by a full TTL. */
export async function bindSession(t: TenantContext, channel: Channel, conversationId: string | null): Promise<void> {
  await query(
    `UPDATE guru_sessions
        SET conversation_id = $5, last_active_at = now(), expires_at = now() + make_interval(mins => $6)
      WHERE location_id = $1 AND principal_type = $2 AND principal_id = $3 AND channel = $4`,
    [t.locationId, t.principal.type, t.principal.id, channel, conversationId, ttlMinutes(t)],
  );
}

/** Explicitly end a session (e.g. "new chat", logout, or a completed customer order). */
export async function endSession(t: TenantContext, channel: Channel): Promise<void> {
  await bindSession(t, channel, null);
}
