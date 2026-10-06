import { LLMError, sleep } from '@agent-platform/core';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  factor: number;
  maxDelayMs: number;
  /** Adds up to 20% random jitter to each delay. */
  jitter: boolean;
  signal?: AbortSignal;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: LLMError }) => void;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 4,
  baseDelayMs: 500,
  factor: 2,
  maxDelayMs: 15_000,
  jitter: true,
};

/** Delay before retry number `attempt` (1-based): base * factor^(attempt-1), capped. */
export function backoffDelay(attempt: number, o: RetryOptions, random = Math.random): number {
  const raw = Math.min(o.maxDelayMs, o.baseDelayMs * o.factor ** (attempt - 1));
  return o.jitter ? Math.round(raw + raw * 0.2 * random()) : raw;
}

/**
 * Runs `fn`, retrying transient LLM errors with exponential backoff. Non-retryable
 * errors, and anything that is not an LLMError, are thrown immediately.
 */
export async function retryTransient<T>(
  fn: (attempt: number) => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const o: RetryOptions = { ...DEFAULT_RETRY, ...options };
  const wait = o.sleep ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!(err instanceof LLMError) || !err.retryable || attempt >= o.maxAttempts) throw err;
      const delayMs = Math.max(backoffDelay(attempt, o), err.retryAfterMs ?? 0);
      o.onRetry?.({ attempt, delayMs, error: err });
      await wait(delayMs, o.signal);
    }
  }
}
