import { LLMError } from '@agent-platform/core';
import { describe, expect, it } from 'vitest';
import {
  CostRouter,
  InMemoryCallTracker,
  InMemoryResponseCache,
  type CallTracker,
  type NewCallRecord,
} from '../src/index.js';
import { answer, failing, fakeProvider, policy, pricing, user } from './helpers.js';

function setup(
  over: { p?: ReturnType<typeof fakeProvider>; cache?: boolean; tracker?: CallTracker } = {},
) {
  const provider = over.p ?? fakeProvider();
  const tracker = new InMemoryCallTracker();
  const cache = new InMemoryResponseCache();
  const router = new CostRouter({
    providers: { p: provider, q: fakeProvider() },
    pricing,
    policy,
    ...(over.cache === false ? {} : { cache }),
    tracker: over.tracker ?? tracker,
  });
  return { router, provider, tracker, cache };
}

const triage = (text = 'short issue', hints = {}) => ({
  messages: user(text),
  hints: { taskType: 'triage', ...hints },
});

describe('CostRouter: routing and tracking', () => {
  it('sends the request to the model chosen by the policy and records cost and latency', async () => {
    const { router, provider, tracker } = setup();
    const res = await router.complete(triage());
    expect(provider.calls[0]?.model).toBe('small');
    expect(res.model).toBe('small');
    const [rec] = tracker.records;
    expect(rec).toMatchObject({
      model: 'small',
      rule: 'easy-triage',
      complexity: 'low',
      inputTokens: 1000,
      outputTokens: 100,
      cacheHit: false,
      status: 'ok',
      latencyMs: 250,
    });
    expect(rec?.costUsd).toBeCloseTo((1000 * 1 + 100 * 5) / 1e6);
  });

  it('routes long inputs to the default (larger) model', async () => {
    const { router, provider } = setup();
    await router.complete(triage('x'.repeat(300)));
    expect(provider.calls[0]?.model).toBe('big');
  });

  it('attaches task metadata to the record, and never forwards hints it does not own', async () => {
    const { router, tracker } = setup();
    await router.complete({ ...triage(), metadata: { taskId: 't-1', agentId: 'issue-triage' } });
    expect(tracker.records[0]).toMatchObject({ taskId: 't-1', agentId: 'issue-triage' });
  });

  it('records an unknown cost (null) rather than zero for an unpriced response model', async () => {
    const { router, tracker } = setup({
      p: fakeProvider(async () => answer('not-in-the-price-list')),
    });
    await router.complete(triage());
    expect(tracker.records[0]?.costUsd).toBeNull();
    expect((await tracker.summary()).byModel[0]?.unpricedCalls).toBe(1);
  });

  it('flags simulated measurements', async () => {
    const { router, tracker } = setup({
      p: fakeProvider(async (r) => answer(r.model!, { simulated: true })),
    });
    await router.complete(triage());
    expect(tracker.records[0]?.simulated).toBe(true);
    expect((await tracker.summary()).simulated).toBe(true);
  });

  it('fails with a clear error when no provider serves the model', async () => {
    const router = new CostRouter({ providers: {}, pricing, policy });
    await expect(router.complete(triage())).rejects.toMatchObject({ kind: 'invalid_request' });
  });

  it('a failing tracker never fails the model call', async () => {
    const tracker: CallTracker = {
      record: async (_c: NewCallRecord) => {
        throw new Error('db down');
      },
    };
    const { router } = setup({ tracker });
    await expect(router.complete(triage())).resolves.toMatchObject({ model: 'small' });
  });
});

describe('CostRouter: fallback', () => {
  it('falls back to the secondary model on an error, and records both attempts', async () => {
    const p = fakeProvider(async (req) => {
      if (req.model === 'small') throw new LLMError('server', 'boom');
      return answer(req.model!);
    });
    const { router, tracker } = setup({ p });
    const res = await router.complete(triage());
    expect(res.model).toBe('big');
    expect(tracker.records.map((r) => [r.model, r.status, r.fallbackFrom])).toEqual([
      ['small', 'error', undefined],
      ['big', 'ok', 'small'],
    ]);
    expect(tracker.records[0]?.error).toContain('server: boom');
  });

  it('falls back on a timeout', async () => {
    const p = fakeProvider(async (req) => {
      if (req.model === 'small') {
        // Never answers; only the router's timeout can end this call.
        await new Promise<never>((_, reject) =>
          req.signal?.addEventListener('abort', () => reject(new Error('aborted by signal'))),
        );
      }
      return answer(req.model!);
    });
    const { router, tracker } = setup({ p });
    const res = await router.complete(triage());
    expect(res.model).toBe('big');
    expect(tracker.records[0]?.error).toContain('timeout');
  });

  it('throws the last error when the fallback fails too', async () => {
    const { router, tracker } = setup({ p: fakeProvider(failing('overloaded')) });
    await expect(router.complete(triage())).rejects.toMatchObject({ kind: 'overloaded' });
    expect(tracker.records.map((r) => r.status)).toEqual(['error', 'error']);
  });

  it('does not use the fallback when the caller aborted', async () => {
    const controller = new AbortController();
    const p = fakeProvider(async () => {
      controller.abort();
      throw new LLMError('aborted', 'cancelled');
    });
    const { router } = setup({ p });
    await expect(router.complete({ ...triage(), signal: controller.signal })).rejects.toMatchObject(
      {
        kind: 'aborted',
      },
    );
    expect(p.calls).toHaveLength(1);
  });

  it('has nothing to fall back to when the rule defines no fallback', async () => {
    // Rule "other-types" routes to model `other` (provider q) and defines no fallback.
    const q = fakeProvider(failing('server'));
    const router = new CostRouter({ providers: { p: fakeProvider(), q }, pricing, policy });
    await expect(
      router.complete({ messages: user('x'), hints: { taskType: 'a' } }),
    ).rejects.toMatchObject({ kind: 'server' });
    expect(q.calls).toHaveLength(1);
  });
});

describe('CostRouter: exact-match cache', () => {
  it('serves a repeated request from the cache, with zero cost and the saving recorded', async () => {
    const { router, provider, tracker } = setup();
    const first = await router.complete(triage());
    const second = await router.complete(triage());
    expect(provider.calls).toHaveLength(1);
    expect(second.cached).toBe(true);
    expect(second.content).toBe(first.content);
    const hit = tracker.records[1];
    expect(hit).toMatchObject({ cacheHit: true, costUsd: 0 });
    expect(hit?.savedUsd).toBeCloseTo(tracker.records[0]?.costUsd ?? -1);
    expect((await tracker.summary()).totals.cacheHits).toBe(1);
  });

  it('treats a different request as a miss', async () => {
    const { router, provider } = setup();
    await router.complete(triage('first issue'));
    await router.complete(triage('second issue'));
    expect(provider.calls).toHaveLength(2);
  });

  it('can be bypassed per request, for reading and for writing', async () => {
    const { router, provider, cache } = setup();
    await router.complete(triage('same', { cache: false }));
    await router.complete(triage('same', { cache: false }));
    expect(provider.calls).toHaveLength(2);
    expect(cache.size).toBe(0);
  });

  it('expires entries after the TTL', async () => {
    let now = 0;
    const cache = new InMemoryResponseCache(() => now);
    const provider = fakeProvider();
    const router = new CostRouter({ providers: { p: provider }, pricing, policy, cache });
    await router.complete(triage());
    now = 59_000;
    await router.complete(triage());
    expect(provider.calls).toHaveLength(1);
    now = 61_000; // policy TTL is 60 s
    await router.complete(triage());
    expect(provider.calls).toHaveLength(2);
  });

  it('does not cache failures', async () => {
    let n = 0;
    const p = fakeProvider(async (req) => {
      n += 1;
      if (n <= 2) throw new LLMError('server', 'boom'); // both attempts of call 1
      return answer(req.model!);
    });
    const { router } = setup({ p });
    await expect(router.complete(triage())).rejects.toBeInstanceOf(LLMError);
    await expect(router.complete(triage())).resolves.toMatchObject({ content: expect.any(String) });
    expect(p.calls).toHaveLength(3);
  });

  it('keeps working when the cache itself is down', async () => {
    const provider = fakeProvider();
    const brokenCache = {
      get: async () => {
        throw new Error('redis down');
      },
      set: async () => {
        throw new Error('redis down');
      },
      close: async () => undefined,
    };
    const router = new CostRouter({
      providers: { p: provider },
      pricing,
      policy,
      cache: brokenCache,
    });
    await expect(router.complete(triage())).resolves.toMatchObject({ model: 'small' });
  });
});
