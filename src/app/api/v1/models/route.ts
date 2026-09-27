import { NextResponse } from 'next/server';

/** OpenAI-compatible model discovery for Captain-style clients. */
export async function GET() {
  return NextResponse.json({
    object: 'list',
    data: [{ id: 'kitchenguru-concierge', object: 'model', owned_by: 'kitchenguru' }],
  });
}
