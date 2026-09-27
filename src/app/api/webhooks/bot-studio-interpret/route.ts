import { NextResponse } from 'next/server';
import { generateObject, generateText, tool, isStepCount } from 'ai';
import { z } from 'zod';
import { guruMcpTools } from '@/lib/mcpGuruClient';
import { kitchenClient } from '@/lib/kitchen';
import { backendSchema, explainLlmError, llmConfigured, modelFor, modelFromBackend } from '@/lib/llm';
import { isInternalCaller } from '@/lib/tenant';

/**
 * Bot Studio's own AI fallback — deliberately NOT the Guru persona.
 * Guru is the owner-facing manager (see guru.routes.ts / this file's
 * sibling /concierge in guru_console mode); this endpoint only ever
 * assists Bot Studio's deterministic customer flow at the two points it
 * can't handle on its own: a button-press that didn't match any option,
 * and turning a free-text order into structured menu items. It has no
 * owner tools, no analytics, no memory of its own — it answers one
 * request and returns, exactly like a plain interpreter function would.
 * The one exception: for a tangential customer question (the 'choice'
 * purpose), it can ask Guru for real business knowledge over MCP
 * (see lib/mcpGuruClient.ts) instead of guessing — that's the only
 * knowledge it borrows from Guru, never the other way around.
 *
 * Every lookup is pinned to the `locationId` of the flow being run, so a
 * customer of one restaurant is only ever matched against that
 * restaurant's menu. Without a locationId (older callers) there is no menu
 * to match against and no MCP lookup: the flow falls back to its
 * deterministic behaviour.
 *
 * The model is Guru's own unless the request carries an `llm` backend (the
 * inbox account's own provider, model and key, set in Bot Studio). The
 * 'ping' purpose makes one tiny call so the editor can test a backend
 * before saving it.
 */

type MenuEntry = { id: string; name: string; price: number };

async function locationMenu(locationId: string): Promise<MenuEntry[]> {
  const k = kitchenClient({ locationId, principal: { type: 'customer', id: 'bot-studio' } });
  const res = await k.get<{ items: MenuEntry[] }>('/menu', { availableOnly: true, customer: true, limit: 100 });
  return 'error' in res ? [] : res.items;
}

const choiceSchema = z.object({
  matchedOptionId: z.string().nullable().describe('The id of the option the customer most likely meant, or null if their message is unrelated to the question'),
  reply: z.string().nullable().describe('If matchedOptionId is null: a short, direct answer to whatever the customer actually asked, so the flow can show it before re-asking the original question'),
});

const captureSchema = z.object({
  items: z.array(z.object({
    menuItemId: z.string().describe('Must be one of the real menu item ids given in context — never invent an id'),
    name: z.string(),
    quantity: z.number().int().min(1),
  })),
  reply: z.string().nullable().describe('Set only when items could not be confidently determined — a short clarifying question to ask the customer instead'),
});

/// Cheap config check for Bot Studio's status indicator — no Gemini call,
/// just "is a key actually set." A real generateObject call would burn
/// API quota just to render a badge.
export async function GET() {
  return NextResponse.json({ configured: llmConfigured() });
}

export async function POST(req: Request) {
  if (!isInternalCaller(req)) return NextResponse.json({ handled: false }, { status: 401 });
  try {
    const body = await req.json();
    const { purpose, prompt, options, text, variables, locationId, llm } = body as {
      purpose: 'choice' | 'capture' | 'ping';
      prompt?: string;
      options?: { id: string; label: string }[];
      text: string;
      variables?: Record<string, string>;
      locationId?: string;
      llm?: unknown;
    };

    const backend = llm ? backendSchema.safeParse(llm) : null;
    if (backend && !backend.success) {
      const error = backend.error.issues[0]?.message || 'Invalid AI backend';
      return purpose === 'ping'
        ? NextResponse.json({ ok: false, error })
        : NextResponse.json({ handled: false }, { status: 400 });
    }
    const model = backend ? modelFromBackend(backend.data) : modelFor('agent');

    if (purpose === 'ping') {
      if (!backend && !llmConfigured()) {
        return NextResponse.json({ ok: false, error: 'Guru Brain has no Gemini API key configured.' });
      }
      const started = Date.now();
      try {
        await generateText({ model, prompt: 'Reply with the single word: ready', maxOutputTokens: 64, maxRetries: 0 });
        return NextResponse.json({ ok: true, latencyMs: Date.now() - started });
      } catch (err) {
        console.warn('[Bot Studio Interpret] backend test failed:', err instanceof Error ? err.message.split('\n')[0] : err);
        return NextResponse.json({ ok: false, error: explainLlmError(err) });
      }
    }

    if (!text || !purpose) {
      return NextResponse.json({ handled: false }, { status: 400 });
    }

    if (purpose === 'choice') {
      let finalAnswer: z.infer<typeof choiceSchema> | null = null;

      await generateText({
        model,
        system: "The bot running the conversation asked the customer a button-choice question and their reply didn't match any button. Decide whether they meant one of the buttons, or asked something else entirely. If answering honestly needs real data (today's bestsellers, dietary/allergen info, current kitchen load), call the menu_insights or fulfillment_snapshot tool first — never guess at facts you can look up. When you've decided, call respond exactly once with your conclusion, then stop.",
        prompt: `The bot asked: "${prompt || ''}"\nAvailable options: ${(options || []).map((o) => `[${o.id}] ${o.label}`).join(', ')}\nThe customer replied: "${text}"`,
        stopWhen: isStepCount(4),
        tools: {
          ...(locationId ? { menu_insights: tool({
            description: "Real bestsellers and dietary/allergen info for the restaurant's actual menu, from Guru (via MCP) — not a guess.",
            inputSchema: z.object({ dietary: z.string().optional().describe('e.g. "vegan", "gluten-free"') }),
            execute: async ({ dietary }: { dietary?: string }) => guruMcpTools.menuInsights(locationId, dietary),
          }),
          fulfillment_snapshot: tool({
            description: 'Current kitchen load, busy mode and typical wait, from Guru (via MCP) — use for "how long will it take" questions.',
            inputSchema: z.object({}),
            execute: async () => guruMcpTools.fulfillmentSnapshot(locationId),
          }) } : {}),
          respond: tool({
            description: 'Submit your final decision about the customer reply. Call this exactly once, as your last step.',
            inputSchema: choiceSchema,
            execute: async (args: z.infer<typeof choiceSchema>) => {
              finalAnswer = args;
              return 'recorded';
            },
          }),
        },
      });

      if (!finalAnswer) return NextResponse.json({ handled: false });
      const answer: z.infer<typeof choiceSchema> = finalAnswer;
      return NextResponse.json({ handled: true, matchedOptionId: answer.matchedOptionId || undefined, reply: answer.reply || undefined });
    }

    // purpose === 'capture'
    if (!locationId) return NextResponse.json({ handled: false });
    const menu = await locationMenu(locationId);
    if (!menu.length) return NextResponse.json({ handled: false });
    const menuList = menu.map((m) => `[${m.id}] ${m.name} — ${m.price}`).join('\n');

    const { object } = await generateObject({
      model,
      schema: captureSchema,
      prompt: `Menu (id — name — price):\n${menuList}\n\nCurrent order context: ${JSON.stringify(variables || {})}\nThe customer said: "${text}"\n\nExtract the items and quantities they want, matched to REAL menu ids above only (never invent an id or guess one that isn't listed). If you can't confidently match at least one real item, return an empty items array and a short reply asking them to clarify (e.g. name the dish differently, or say it's not on the menu).`,
    });

    if (!object.items.length) {
      return NextResponse.json({ handled: false, reply: object.reply || "I couldn't find that on our menu — could you tell me the dish name again?" });
    }

    const known = new Set(menu.map((m) => m.id));
    object.items = object.items.filter((i) => known.has(i.menuItemId));
    if (!object.items.length) {
      return NextResponse.json({ handled: false, reply: "I couldn't find that on our menu — could you tell me the dish name again?" });
    }

    const value = JSON.stringify(object.items.map((i) => ({ menuItemId: i.menuItemId, name: i.name, quantity: i.quantity })));
    return NextResponse.json({ handled: true, value });
  } catch (error: any) {
    console.error('[Bot Studio Interpret] failed:', error);
    return NextResponse.json({ handled: false }, { status: 500 });
  }
}
