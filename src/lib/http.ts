import { NextResponse } from 'next/server';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Wraps a route handler so thrown HttpErrors become JSON responses and anything else a logged 500. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof HttpError) {
        return NextResponse.json({ success: false, error: err.message }, { status: err.status });
      }
      console.error('[Guru Brain] unhandled error:', err);
      return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
    }
  };
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export const ok = <T>(data: T, status = 200) => NextResponse.json({ success: true, data }, { status });
