import { generateText, isStepCount, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { config } from './config';
import { HttpError } from './http';
import { modelFor, scrubVendors } from './llm';
import { customerSystemPrompt, ownerSystemPrompt, SUMMARY_INSTRUCTIONS, withMemory } from './prompts';
import {
  acquireTurn,
  appendMessages,
  createConversation,
  deleteConversation,
  getConversation,
  loadModelContext,
  messagesToSummarize,
  releaseTurn,
  saveSummary,
  type Channel,
  type Conversation,
  type ToolCallRecord,
} from './store/conversations';
import { bindSession, resolveSession } from './store/sessions';
import type { TenantContext } from './tenant';
import { customerTools } from './tools/customerTools';
import { ownerTools } from './tools/ownerTools';

export interface TurnInput {
  tenant: TenantContext;
  channel: Channel;
  message: string;
  /** Continue a specific conversation (console). Omit to use the session's current one. */
  conversationId?: string;
  /** Force a brand-new conversation even if the session has a current one. */
  newConversation?: boolean;
  /** Override the routed model (tests, evaluations). */
  model?: LanguageModel;
}

export interface TurnResult {
  conversationId: string;
  title: string | null;
  reply: string;
  toolCalls: ToolCallRecord[];
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * One conversational turn, end to end:
 *   resolve conversation (explicit id → owner-checked; else the channel
 *   session's current one; else new) → take the per-conversation turn lock →
 *   replay summary + recent history → run the tool loop with tenant-bound
 *   tools → persist the exchange → re-point the session → release the lock.
 */
export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const { tenant, channel } = input;
  const message = input.message.trim();
  if (!message) throw new HttpError(400, 'message is required');
  if (message.length > config.maxMessageChars) throw new HttpError(413, 'message is too long');

  const { conv, created } = await resolveConversation(input);
  if (!(await acquireTurn(tenant, conv.id))) {
    throw new HttpError(409, 'Guru is still answering the previous message in this conversation');
  }

  let completed = false;
  try {
    const memory = await loadModelContext(tenant, conv);
    const isStaff = tenant.principal.type === 'staff';
    const tools: ToolSet = isStaff ? ownerTools(tenant) : customerTools(tenant);
    const system = withMemory(isStaff ? ownerSystemPrompt(tenant) : customerSystemPrompt(tenant), memory.summary);

    const messages: ModelMessage[] = [
      ...memory.recent.map((m): ModelMessage => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    const result = await generateText({
      model: input.model ?? modelFor('agent'),
      system,
      messages,
      tools,
      stopWhen: isStepCount(isStaff ? 10 : 6),
    }).catch((err) => {
      throw llmError(err);
    });

    const toolCalls = collectToolCalls(result.steps);
    const reply =
      scrubVendors(result.text || '').trim() ||
      (isStaff
        ? "I gathered the data but couldn't finish the answer — please ask again."
        : 'Sorry, I missed that — could you say it again?');
    const usage = {
      inputTokens: result.totalUsage?.inputTokens ?? 0,
      outputTokens: result.totalUsage?.outputTokens ?? 0,
    };

    await appendMessages(tenant, conv.id, [
      { role: 'user', content: message },
      { role: 'assistant', content: reply, toolCalls, usage },
    ]);
    await bindSession(tenant, channel, conv.id);
    completed = true;

    // Memory compaction runs after the reply is ready; it only appends to the
    // summary (monotonic summarized_through), so it is safe off the hot path.
    if (memory.unsummarizedCount + 2 > config.summarizeAfter) {
      void compactConversation(tenant, conv.id).catch((err) =>
        console.error('[Guru Brain] summary compaction failed:', err instanceof Error ? err.message : err),
      );
    }

    return { conversationId: conv.id, title: conv.title ?? message.slice(0, 80), reply, toolCalls, usage };
  } finally {
    await releaseTurn(tenant, conv.id).catch(() => undefined);
    // Don't leave an empty conversation behind when its very first turn failed.
    if (created && !completed) await deleteConversation(tenant, conv.id).catch(() => undefined);
  }
}

/** Turns provider failures into answers the UI can show instead of a bare 500. */
function llmError(err: unknown): Error {
  const e = err as { statusCode?: number; lastError?: { statusCode?: number } };
  const status = e?.statusCode ?? e?.lastError?.statusCode;
  console.error('[Guru Brain] model call failed:', err instanceof Error ? err.message.split('\n')[0] : err);
  if (status === 429) return new HttpError(503, "Guru's AI capacity is used up for the moment — please try again in a little while.");
  return new HttpError(502, "Guru's AI service didn't respond properly — please try again.");
}

async function resolveConversation(input: TurnInput): Promise<{ conv: Conversation; created: boolean }> {
  const { tenant, channel } = input;
  if (input.conversationId) {
    const conv = await getConversation(tenant, input.conversationId);
    if (!conv) throw new HttpError(404, 'Conversation not found');
    if (conv.channel !== channel) throw new HttpError(400, 'Conversation belongs to a different channel');
    return { conv, created: false };
  }
  if (!input.newConversation) {
    const session = await resolveSession(tenant, channel);
    if (session.conversationId) {
      const current = await getConversation(tenant, session.conversationId);
      if (current && current.status === 'active') return { conv: current, created: false };
    }
  } else {
    await resolveSession(tenant, channel); // make sure the session row exists for bindSession
  }
  return { conv: await createConversation(tenant, channel), created: true };
}

type Steps = Awaited<ReturnType<typeof generateText>>['steps'];

function collectToolCalls(steps: Steps): ToolCallRecord[] {
  const records: ToolCallRecord[] = [];
  for (const step of steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      const result = step.toolResults?.find((r) => r.toolCallId === call.toolCallId);
      const output = result?.output as { error?: unknown } | undefined;
      records.push({
        tool: call.toolName,
        input: call.input,
        ok: !!result && !(output && typeof output === 'object' && 'error' in output),
      });
    }
  }
  return records;
}

/** Fold messages that have scrolled out of the replay window into the conversation summary. */
async function compactConversation(tenant: TenantContext, conversationId: string): Promise<void> {
  const conv = await getConversation(tenant, conversationId);
  if (!conv) return;
  const older = await messagesToSummarize(tenant, conv, config.historyWindow);
  if (!older.length) return;

  const transcript = older.map((m) => `${m.role === 'user' ? 'User' : 'Guru'}: ${m.content}`).join('\n');
  const { text } = await generateText({
    model: modelFor('light'),
    system: SUMMARY_INSTRUCTIONS,
    prompt: `PREVIOUS SUMMARY:\n${conv.summary || '(none)'}\n\nNEW TRANSCRIPT:\n${transcript}`,
  });
  if (text.trim()) await saveSummary(tenant, conv.id, text.trim(), older[older.length - 1].id);
}
