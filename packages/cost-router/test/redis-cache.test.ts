import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { CostRouter, RedisResponseCache } from '../src/index.js';
import { fakeProvider, policy, pricing, user } from './helpers.js';

const redisUrl = process.env.REDIS_URL;

describe.skipIf(!redisUrl)('RedisResponseCache', () => {
  const cache = new RedisResponseCache(redisUrl!, `test:${randomUUID()}:`);
  afterAll(async () => {
    await cache.close();
  });

  it('round-trips an entry and honours the TTL', async () => {
    const entry = {
      response: {
        content: 'hi',
        toolCalls: [],
        model: 'm',
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end' as const,
        latencyMs: 1,
        simulated: false,
      },
      costUsd: 0.5,
    };
    await cache.set('k', entry, 1);
    expect(await cache.get('k')).toEqual(entry);
    expect(await cache.get('absent')).toBeUndefined();
    await new Promise((r) => setTimeout(r, 1300));
    expect(await cache.get('k')).toBeUndefined();
  });

  it('serves a repeated request through the router without calling the model again', async () => {
    const provider = fakeProvider();
    const router = new CostRouter({ providers: { p: provider }, pricing, policy, cache });
    const req = { messages: user(`unique ${randomUUID()}`), hints: { taskType: 'triage' } };
    await router.complete(req);
    const again = await router.complete(req);
    expect(again.cached).toBe(true);
    expect(provider.calls).toHaveLength(1);
  });
});
