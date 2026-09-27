/**
 * Guru Brain runtime configuration — read once, in one place, so every
 * route and tool agrees on where kitchenguru lives, which model runs and
 * how long sessions last.
 */

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  /** kitchenguru-server — the system of record for every tool call. */
  kitchenBaseUrl: process.env.DASHBOARD_URL || process.env.KITCHENASTY_URL || 'http://localhost:3000',
  /** Shared secret between kitchenguru and the brain. Empty = dev mode (open). */
  internalToken: process.env.GURU_INTERNAL_TOKEN || '',
  /** Guru's own conversation store (separate database from kitchenguru's). */
  databaseUrl: process.env.GURU_DATABASE_URL || '',

  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || '',
  model: process.env.GURU_MODEL || 'gemini-3.6-flash',
  localModel: process.env.GURU_LOCAL_MODEL || 'qwen2.5:7b',
  enableLocalLlm: process.env.ENABLE_LOCAL_LLM === 'true',
  customLlmBaseUrl: process.env.CUSTOM_LLM_BASE_URL || 'http://localhost:11434/v1',
  customLlmApiKey: process.env.CUSTOM_LLM_API_KEY || 'custom',

  /** Idle time after which a channel session starts a fresh conversation. */
  staffSessionTtlMinutes: num(process.env.GURU_STAFF_SESSION_TTL_MINUTES, 12 * 60),
  customerSessionTtlMinutes: num(process.env.GURU_CUSTOMER_SESSION_TTL_MINUTES, 24 * 60),

  /** Most recent messages replayed verbatim to the model each turn. */
  historyWindow: num(process.env.GURU_HISTORY_WINDOW, 20),
  /** Once a conversation has this many unsummarised messages, fold the oldest into its summary. */
  summarizeAfter: num(process.env.GURU_SUMMARIZE_AFTER, 40),
  /** A turn holds its conversation's lock at most this long (guards against a crashed turn). */
  turnLockSeconds: num(process.env.GURU_TURN_LOCK_SECONDS, 120),
  /** Per-call timeout for tool requests into kitchenguru. */
  toolTimeoutMs: num(process.env.GURU_TOOL_TIMEOUT_MS, 15_000),
  maxMessageChars: num(process.env.GURU_MAX_MESSAGE_CHARS, 8_000),
};
