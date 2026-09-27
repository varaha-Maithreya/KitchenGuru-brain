import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import { modelFor, scrubVendors } from '@/lib/llm';
import { isInternalCaller } from '@/lib/tenant';

/**
 * OpenAI-compatible chat endpoint for the Guru Brain.
 * Purpose: Captain (Chatwoot AI) supports a custom endpoint via
 * CAPTAIN_OPEN_AI_ENDPOINT + CAPTAIN_OPEN_AI_MODEL + CAPTAIN_OPEN_AI_API_KEY.
 * Point those at this route and EVERY Captain use case — copilot
 * threads, rewrite, summarize, reply/label suggestions, follow-ups,
 * auto-resolve, FAQ — runs on the Guru instead of a paid key.
 * No Chatwoot code changes, no fork.
 *
 * POST /api/v1/chat/completions  { model, messages, temperature?, max_tokens?, stream? }
 * GET  /api/v1/models            (discovery)
 */

const GURU_MODEL_ID = 'kitchenguru-concierge';

interface ChatMessage {
  role: string;
  content: unknown;
}

function toText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : ''))
      .join('\n');
  }
  return String(content ?? '');
}

export async function POST(req: Request) {
  if (!isInternalCaller(req)) {
    return NextResponse.json({ error: { message: 'Unauthorized', type: 'auth_error' } }, { status: 401 });
  }

  const body = await req.json();
  const { messages = [], temperature, max_tokens, stream } = body as {
    messages?: ChatMessage[];
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
  };

  const system = messages.filter((m) => m.role === 'system').map((m) => toText(m.content)).join('\n\n');
  const convo = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${toText(m.content)}`)
    .join('\n');

  // Stateless by design: Captain owns its own threads per inbox account and
  // sends the full history each call, so there is nothing to persist here.
  const model = modelFor('light');

  const result = await generateText({
    model,
    system: system || 'You are the KitchenGuru Autonomous Concierge. Answer concisely and helpfully.',
    prompt: convo || 'Hello',
    temperature: typeof temperature === 'number' ? temperature : undefined,
    maxOutputTokens: typeof max_tokens === 'number' ? max_tokens : undefined,
  });

  const payload = {
    id: `kg-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: GURU_MODEL_ID,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: scrubVendors(result.text) },
        finish_reason: 'stop',
      },
    ],
    usage: result.usage
      ? { prompt_tokens: result.usage.inputTokens ?? 0, completion_tokens: result.usage.outputTokens ?? 0, total_tokens: result.usage.totalTokens ?? 0 }
      : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };

  if (stream) {
    const sse =
      `data: ${JSON.stringify({ ...payload, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: scrubVendors(result.text) }, finish_reason: 'stop' }] })}\n\n` +
      `data: [DONE]\n\n`;
    return new NextResponse(sse, { headers: { 'Content-Type': 'text/event-stream' } });
  }

  return NextResponse.json(payload);
}
