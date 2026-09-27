import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { dbHealthy } from '@/lib/db';
import { llmConfigured } from '@/lib/llm';

/** GET /api/guru/health — liveness plus what's configured, for ops and kitchenasty's status badge. */
export async function GET() {
  const db = await dbHealthy();
  const llm = llmConfigured();
  return NextResponse.json(
    { ok: db && llm, db, llm, model: config.model, internalAuth: !!config.internalToken },
    { status: db && llm ? 200 : 503 },
  );
}
