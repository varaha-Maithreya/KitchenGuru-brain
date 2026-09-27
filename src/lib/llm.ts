import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
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

/** Vendor names never reach a user, whatever the model produced. */
export function scrubVendors(text: string): string {
  return text.replace(/typebot/gi, 'Bot Studio').replace(/chatwoot/gi, 'Live Inbox');
}
