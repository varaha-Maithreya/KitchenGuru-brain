import { describe, it, expect } from 'vitest';
import { APICallError, RetryError } from 'ai';
import { backendSchema, explainLlmError, modelFromBackend } from './llm';

const apiError = (statusCode?: number) =>
  new APICallError({ message: 'secret upstream body', url: 'http://x', requestBodyValues: {}, statusCode });

describe('backendSchema', () => {
  it('needs a key for hosted providers, so the SDK never falls back to the platform key', () => {
    expect(backendSchema.safeParse({ provider: 'gemini', model: 'gemini-2.5-flash' }).success).toBe(false);
    expect(backendSchema.safeParse({ provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'sk-1' }).success).toBe(true);
  });

  it('needs an http(s) base URL, and no key, for OpenAI-compatible servers', () => {
    expect(backendSchema.safeParse({ provider: 'openai_compatible', model: 'llama3.1' }).success).toBe(false);
    expect(backendSchema.safeParse({ provider: 'openai_compatible', model: 'llama3.1', baseUrl: 'file:///etc/passwd' }).success).toBe(false);
    expect(backendSchema.safeParse({ provider: 'openai_compatible', model: 'llama3.1', baseUrl: 'http://host.docker.internal:11434/v1' }).success).toBe(true);
  });

  it('rejects unknown providers and blank models', () => {
    expect(backendSchema.safeParse({ provider: 'mystery', model: 'x', apiKey: 'k' }).success).toBe(false);
    expect(backendSchema.safeParse({ provider: 'openai', model: '  ', apiKey: 'k' }).success).toBe(false);
  });
});

describe('modelFromBackend', () => {
  it.each([
    [{ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'g' }, 'google'],
    [{ provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'o' }, 'openai'],
    [{ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'a' }, 'anthropic'],
    [{ provider: 'openai_compatible', model: 'qwen2.5:7b', baseUrl: 'http://localhost:11434/v1' }, 'openai.chat'],
  ] as const)('builds %o on the %s provider', (backend, provider) => {
    const model = modelFromBackend(backend);
    expect(typeof model === 'object' && model.modelId).toBe(backend.model);
    expect(typeof model === 'object' && model.provider).toMatch(new RegExp(`^${provider.replace('.', '\\.')}`));
  });
});

describe('explainLlmError', () => {
  it('maps provider status codes to something a person can act on', () => {
    expect(explainLlmError(apiError(401))).toMatch(/API key/);
    expect(explainLlmError(apiError(404))).toMatch(/model/);
    expect(explainLlmError(apiError(429))).toMatch(/rate-limiting|quota/);
    expect(explainLlmError(apiError(503))).toMatch(/503/);
    expect(explainLlmError(apiError())).toMatch(/Could not reach/);
  });

  it('unwraps retries and never echoes what the provider sent back', () => {
    const retried = new RetryError({ message: 'failed', reason: 'maxRetriesExceeded', errors: [apiError(401)] });
    expect(explainLlmError(retried)).toMatch(/API key/);
    expect(explainLlmError(apiError(400))).not.toMatch(/secret upstream body/);
  });

  it('recognises a server that is not listening', () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(explainLlmError(refused)).toMatch(/Could not reach/);
    expect(explainLlmError(new Error('boom'))).toBe('The model call failed.');
  });
});
