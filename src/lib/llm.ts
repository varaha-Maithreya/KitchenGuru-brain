import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, RetryError, type LanguageModel } from 'ai';
import { z } from 'zod';
import { config } from './config';

/**
 * Model routing for every Guru surface. 'agent' work (tool use, owner
 * analysis, customer ordering) always runs on the hosted model; 'light'
 * work (summaries, titles, Captain rewrites) may run locally when
 * ENABLE_LOCAL_LLM is set.
 */

const google = createGoogleGenerativeAI({ apiKey: config.geminiApiKey });
const local = createOpenAI({ baseURL: config.customLlmBaseUrl, apiKey: config.customLlmApiKey });

export type Workload = 'agent' | 'light';

export function modelFor(workload: Workload): LanguageModel {
  if (workload === 'light' && config.enableLocalLlm) return local(config.localModel);
  return google(config.model);
}

export const llmConfigured = (): boolean => !!config.geminiApiKey;

/**
 * A model the caller chose instead of Guru's own: Bot Studio lets each inbox
 * account bring its own provider and key. BotChat stores the key; it only
 * passes through here for the one call and is never logged or kept.
 *
 * Every hosted provider needs its key spelled out — the SDKs would otherwise
 * quietly fall back to the platform's key from the environment.
 */
export const backendSchema = z
  .object({
    provider: z.enum(['gemini', 'openai', 'anthropic', 'openai_compatible']),
    model: z.string().trim().min(1).max(200),
    apiKey: z.string().max(1000).optional(),
    baseUrl: z.string().regex(/^https?:\/\/\S+$/i, 'baseUrl must be an http(s) URL').max(500).optional(),
  })
  .refine((b) => (b.provider === 'openai_compatible' ? !!b.baseUrl : !!b.apiKey), {
    message: 'openai_compatible needs a baseUrl; every other provider needs an apiKey',
  });

export type Backend = z.infer<typeof backendSchema>;

export function modelFromBackend(backend: Backend): LanguageModel {
  switch (backend.provider) {
    case 'gemini':
      return createGoogleGenerativeAI({ apiKey: backend.apiKey })(backend.model);
    case 'openai':
      return createOpenAI({ apiKey: backend.apiKey })(backend.model);
    case 'anthropic':
      return createAnthropic({ apiKey: backend.apiKey })(backend.model);
    case 'openai_compatible':
      // Chat Completions rather than the Responses API: it is what Ollama,
      // LM Studio, vLLM, OpenRouter and Groq all speak. Local servers usually
      // want no key, but the SDK insists on one.
      return createOpenAI({ baseURL: backend.baseUrl, apiKey: backend.apiKey || 'not-needed' }).chat(backend.model);
  }
}

/**
 * A failed model call, explained to the person configuring it. Provider
 * response bodies are deliberately left out: the base URL is user-supplied, so
 * echoing what came back would let anyone read internal services through us.
 */
export function explainLlmError(err: unknown): string {
  const cause = RetryError.isInstance(err) ? err.lastError : err;
  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode;
    if (status === 401 || status === 403) return 'The provider rejected the API key.';
    if (status === 404) return 'The provider does not know this model (or the base URL is wrong).';
    if (status === 429) return 'The provider is rate-limiting this key, or its quota is used up.';
    if (status && status >= 500) return `The provider had an internal error (${status}). Try again shortly.`;
    if (status) return `The provider refused the request (${status}). Check the model name and API key.`;
    return 'Could not reach the provider. Check the base URL and that the server is running.';
  }
  const code = (cause as { cause?: { code?: string } })?.cause?.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ETIMEDOUT') {
    return 'Could not reach the provider. Check the base URL and that the server is running.';
  }
  return 'The model call failed.';
}

/** Vendor names never reach a user, whatever the model produced. */
export function scrubVendors(text: string): string {
  return text.replace(/typebot/gi, 'Bot Studio').replace(/chatwoot/gi, 'Live Inbox');
}
