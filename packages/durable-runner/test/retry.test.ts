import { LLMError } from '@agent-platform/core';
import { describe, expect, it } from 'vitest';
import { backoffDelay, DEFAULT_RETRY, retryTransient } from '../src/index.js';

describe('backoffDelay', () => {
  const o = { ...DEFAULT_RETRY, baseDelayMs: 100, factor: 2, maxDelayMs: 1000, jitter: false };
  it('grows exponentially and is capped', () => {
    expect([1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, o))).toEqual([
      100, 200, 400, 800, 1000, 1000,
    ]);
  });
  it('adds at most 20% jitter', () => {
    expect(backoffDelay(1, { ...o, jitter: true }, () => 1)).toBe(120);
    expect(backoffDelay(1, { ...o, jitter: true }, () => 0)).toBe(100);
  });
});

describe('retryTransient', () => {
  it('honours Retry-After when it exceeds the computed delay', async () => {
    const waited: number[] = [];
    let n = 0;
    const result = await retryTransient(
      async () => {
        n += 1;
        if (n === 1) throw new LLMError('rate_limit', 'x', { retryAfterMs: 5000 });
        return 'ok';
      },
      { baseDelayMs: 10, jitter: false, sleep: async (ms) => void waited.push(ms) },
    );
    expect(result).toBe('ok');
    expect(waited).toEqual([5000]);
  });

  it('does not retry errors that are not LLMErrors', async () => {
    let n = 0;
    await expect(
      retryTransient(async () => {
        n += 1;
        throw new TypeError('bug');
      }),
    ).rejects.toThrow('bug');
    expect(n).toBe(1);
  });
});
