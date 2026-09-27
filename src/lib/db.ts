import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { config } from './config';
import { HttpError } from './http';

/**
 * Guru's own store: conversations, their messages, and the per-channel
 * sessions that point at the "current" conversation. It lives in its own
 * database (guru_brain) so kitchenasty's Prisma migrations never see it.
 * The schema is created idempotently on first use — no separate migrate step.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS guru_conversations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        text        NOT NULL,
  principal_type     text        NOT NULL CHECK (principal_type IN ('staff', 'customer')),
  principal_id       text        NOT NULL,
  channel            text        NOT NULL,
  title              text,
  summary            text,
  summarized_through bigint      NOT NULL DEFAULT 0,
  status             text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  message_count      integer     NOT NULL DEFAULT 0,
  busy_until         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guru_conversations_owner_idx
  ON guru_conversations (location_id, principal_type, principal_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS guru_messages (
  id              bigserial   PRIMARY KEY,
  conversation_id uuid        NOT NULL REFERENCES guru_conversations(id) ON DELETE CASCADE,
  location_id     text        NOT NULL,
  role            text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content         text        NOT NULL,
  tool_calls      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  usage           jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guru_messages_conversation_idx ON guru_messages (conversation_id, id);

CREATE TABLE IF NOT EXISTS guru_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id     text        NOT NULL,
  principal_type  text        NOT NULL,
  principal_id    text        NOT NULL,
  channel         text        NOT NULL,
  conversation_id uuid        REFERENCES guru_conversations(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_active_at  timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS guru_sessions_principal_uq
  ON guru_sessions (location_id, principal_type, principal_id, channel);
`;

const globalForDb = globalThis as unknown as { guruPool?: Pool; guruSchema?: Promise<void> };

function pool(): Pool {
  if (!config.databaseUrl) throw new HttpError(503, 'Guru conversation store is not configured (GURU_DATABASE_URL)');
  if (!globalForDb.guruPool) {
    globalForDb.guruPool = new Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30_000 });
    globalForDb.guruPool.on('error', (err) => console.error('[Guru Brain] pg pool error:', err.message));
  }
  return globalForDb.guruPool;
}

async function ensureSchema(): Promise<void> {
  if (!globalForDb.guruSchema) {
    globalForDb.guruSchema = pool()
      .query(SCHEMA)
      .then(() => undefined)
      .catch((err) => {
        globalForDb.guruSchema = undefined; // retry on the next request
        throw err;
      });
  }
  return globalForDb.guruSchema;
}

export async function query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  await ensureSchema();
  const res = await pool().query<T>(text, params);
  return res.rows;
}

export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensureSchema();
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
