import { query, transaction } from '../db';
import { config } from '../config';
import type { TenantContext } from '../tenant';

/**
 * Conversation repository. Every function takes the TenantContext and
 * every statement filters on (location_id, principal_type, principal_id) —
 * there is deliberately no "get by id" that skips the owner check. A
 * conversation that exists but belongs to someone else is indistinguishable
 * from one that doesn't exist.
 */

export type Channel = 'console' | 'whatsapp';

export interface Conversation {
  id: string;
  channel: Channel;
  title: string | null;
  summary: string | null;
  summarizedThrough: number;
  status: 'active' | 'archived';
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ToolCallRecord {
  tool: string;
  input: unknown;
  ok: boolean;
}

export interface StoredMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: ToolCallRecord[];
  createdAt: string;
}

interface ConversationRow {
  id: string;
  channel: Channel;
  title: string | null;
  summary: string | null;
  summarized_through: string;
  status: 'active' | 'archived';
  message_count: number;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tool_calls: ToolCallRecord[];
  created_at: Date;
}

const COLUMNS = 'id, channel, title, summary, summarized_through, status, message_count, created_at, updated_at';
const OWNER = 'location_id = $1 AND principal_type = $2 AND principal_id = $3';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const owner = (t: TenantContext) => [t.locationId, t.principal.type, t.principal.id];

const toConversation = (r: ConversationRow): Conversation => ({
  id: r.id,
  channel: r.channel,
  title: r.title,
  summary: r.summary,
  summarizedThrough: Number(r.summarized_through),
  status: r.status,
  messageCount: r.message_count,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const toMessage = (r: MessageRow): StoredMessage => ({
  id: Number(r.id),
  role: r.role,
  content: r.content,
  toolCalls: r.tool_calls ?? [],
  createdAt: r.created_at.toISOString(),
});

export async function listConversations(
  t: TenantContext,
  opts: { channel?: Channel; status?: 'active' | 'archived'; limit?: number } = {},
): Promise<Conversation[]> {
  const params: unknown[] = owner(t);
  let where = OWNER;
  if (opts.channel) {
    params.push(opts.channel);
    where += ` AND channel = $${params.length}`;
  }
  if (opts.status) {
    params.push(opts.status);
    where += ` AND status = $${params.length}`;
  }
  params.push(Math.min(100, Math.max(1, opts.limit ?? 30)));
  const rows = await query<ConversationRow>(
    `SELECT ${COLUMNS} FROM guru_conversations WHERE ${where} ORDER BY updated_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(toConversation);
}

export async function getConversation(t: TenantContext, id: string): Promise<Conversation | null> {
  if (!uuidPattern.test(id)) return null;
  const rows = await query<ConversationRow>(
    `SELECT ${COLUMNS} FROM guru_conversations WHERE ${OWNER} AND id = $4`,
    [...owner(t), id],
  );
  return rows[0] ? toConversation(rows[0]) : null;
}

export async function createConversation(t: TenantContext, channel: Channel, title?: string): Promise<Conversation> {
  const rows = await query<ConversationRow>(
    `INSERT INTO guru_conversations (location_id, principal_type, principal_id, channel, title)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
    [...owner(t), channel, title?.slice(0, 120) || null],
  );
  return toConversation(rows[0]);
}

export async function updateConversation(
  t: TenantContext,
  id: string,
  patch: { title?: string; status?: 'active' | 'archived' },
): Promise<Conversation | null> {
  if (!uuidPattern.test(id)) return null;
  const rows = await query<ConversationRow>(
    `UPDATE guru_conversations
        SET title = COALESCE($5, title), status = COALESCE($6, status), updated_at = now()
      WHERE ${OWNER} AND id = $4
      RETURNING ${COLUMNS}`,
    [...owner(t), id, patch.title?.slice(0, 120) ?? null, patch.status ?? null],
  );
  return rows[0] ? toConversation(rows[0]) : null;
}

export async function deleteConversation(t: TenantContext, id: string): Promise<boolean> {
  if (!uuidPattern.test(id)) return false;
  const rows = await query<{ id: string }>(
    `DELETE FROM guru_conversations WHERE ${OWNER} AND id = $4 RETURNING id`,
    [...owner(t), id],
  );
  return rows.length > 0;
}

export async function listMessages(
  t: TenantContext,
  conversationId: string,
  opts: { limit?: number; beforeId?: number } = {},
): Promise<StoredMessage[]> {
  // Join through the conversation so the owner check can't be skipped.
  const rows = await query<MessageRow>(
    `SELECT m.id, m.role, m.content, m.tool_calls, m.created_at
       FROM guru_messages m
       JOIN guru_conversations c ON c.id = m.conversation_id
      WHERE c.location_id = $1 AND c.principal_type = $2 AND c.principal_id = $3
        AND c.id = $4 AND ($5::bigint IS NULL OR m.id < $5)
      ORDER BY m.id DESC LIMIT $6`,
    [...owner(t), conversationId, opts.beforeId ?? null, Math.min(200, Math.max(1, opts.limit ?? 100))],
  );
  return rows.reverse().map(toMessage);
}

/**
 * One turn at a time per conversation. Two tabs sending at once would
 * otherwise interleave history and double-run tools. The lock expires by
 * itself so a crashed turn can't wedge the conversation.
 */
export async function acquireTurn(t: TenantContext, id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE guru_conversations
        SET busy_until = now() + make_interval(secs => $5)
      WHERE ${OWNER} AND id = $4 AND (busy_until IS NULL OR busy_until < now())
      RETURNING id`,
    [...owner(t), id, config.turnLockSeconds],
  );
  return rows.length > 0;
}

export async function releaseTurn(t: TenantContext, id: string): Promise<void> {
  await query(`UPDATE guru_conversations SET busy_until = NULL WHERE ${OWNER} AND id = $4`, [...owner(t), id]);
}

export async function appendMessages(
  t: TenantContext,
  id: string,
  messages: { role: 'user' | 'assistant'; content: string; toolCalls?: ToolCallRecord[]; usage?: unknown }[],
): Promise<void> {
  await transaction(async (client) => {
    for (const m of messages) {
      await client.query(
        `INSERT INTO guru_messages (conversation_id, location_id, role, content, tool_calls, usage)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, t.locationId, m.role, m.content, JSON.stringify(m.toolCalls ?? []), m.usage ? JSON.stringify(m.usage) : null],
      );
    }
    const firstUser = messages.find((m) => m.role === 'user')?.content;
    await client.query(
      `UPDATE guru_conversations
          SET message_count = message_count + $5,
              title = COALESCE(title, $6),
              updated_at = now()
        WHERE ${OWNER} AND id = $4`,
      [...owner(t), id, messages.length, firstUser ? firstUser.replace(/\s+/g, ' ').slice(0, 80) : null],
    );
  });
}

/** What the model sees as memory: the rolling summary plus the recent unsummarised tail. */
export async function loadModelContext(
  t: TenantContext,
  conv: Conversation,
): Promise<{ summary: string | null; recent: StoredMessage[]; unsummarizedCount: number }> {
  const rows = await query<MessageRow & { total: string }>(
    `SELECT id, role, content, tool_calls, created_at, count(*) OVER () AS total
       FROM guru_messages
      WHERE conversation_id = $1 AND location_id = $2 AND id > $3
      ORDER BY id DESC LIMIT $4`,
    [conv.id, t.locationId, conv.summarizedThrough, config.historyWindow],
  );
  return {
    summary: conv.summary,
    recent: rows.reverse().map(toMessage),
    unsummarizedCount: rows[0] ? Number(rows[0].total) : 0,
  };
}

/** Messages that are about to fall out of the replay window and should be folded into the summary. */
export async function messagesToSummarize(t: TenantContext, conv: Conversation, keep: number): Promise<StoredMessage[]> {
  const rows = await query<MessageRow>(
    `SELECT id, role, content, tool_calls, created_at FROM (
        SELECT id, role, content, tool_calls, created_at, row_number() OVER (ORDER BY id DESC) AS rn
          FROM guru_messages
         WHERE conversation_id = $1 AND location_id = $2 AND id > $3
     ) x WHERE rn > $4 ORDER BY id ASC`,
    [conv.id, t.locationId, conv.summarizedThrough, keep],
  );
  return rows.map(toMessage);
}

export async function saveSummary(t: TenantContext, id: string, summary: string, throughId: number): Promise<void> {
  await query(
    `UPDATE guru_conversations SET summary = $5, summarized_through = GREATEST(summarized_through, $6)
      WHERE ${OWNER} AND id = $4`,
    [...owner(t), id, summary, throughId],
  );
}
